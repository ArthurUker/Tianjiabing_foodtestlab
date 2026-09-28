// P1-09: 存在 3 套审计日志机制并存，见 TD-P2-13
//   ① 后端 DB（UserManager.logLogin/logFailedLogin）— 仅登录日志，缺 ip_address
//   ② 后端 DB API（POST /api/audit-logs ← 前端 AuditLogService）— 通用操作，字段完整
//   ③ 前端 localStorage（AuditLogger.logOperation ← Storage.js）— 本地离线日志
// 无同表重复写入；字段不一致待统一审计接口设计（TD-P2-13）

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath, URL } from 'url'
import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'
import UserManager from './modules/UserManager.js'
import { createUserRoutes } from './routes/userRoutes.js'
import { createAuditRoutes } from './routes/auditRoutes.js'
import { createSessionRoutes } from './routes/sessionRoutes.js'
import { createGuestRoutes } from './routes/guestRoutes.js'
import { createFeedbackRoutes } from './routes/feedbackRoutes.js'
import { rateLimit } from './middleware/validationMiddleware.js'
import idempotencyMiddleware from './middleware/idempotencyMiddleware.js'
import { createAuthMiddleware } from './middleware/authMiddleware.js'
import { createTenantMiddleware } from './middleware/tenantMiddleware.js'
import { createSyncRoutes } from './routes/syncRoutes.js'
import { createAdminBackupRoutes } from './routes/adminBackupRoutes.js'
import { createAdminDiskRoutes } from './routes/adminDiskRoutes.js'
import { createSchoolBackupRoutes } from './routes/schoolBackupRoutes.js'
import { createTestResultRoutes } from './routes/testResultRoutes.js'
import { createRecognitionRoutes } from './routes/recognitionRoutes.js'
import { createSchoolRoutes, ensureRecycleBinInfra } from './routes/schoolRoutes.js'
import { createRecordRoutes } from './routes/recordRoutes.js'
import frequencyRoutes from './routes/frequencyRoutes.js'
import { createOpenApiRoutes } from './routes/openApiRoutes.js'
import { createAdminOpenApiRoutes } from './routes/adminOpenApiRoutes.js'
import { disconnectAllTenantClients } from './lib/tenantClient.js'
import { syncAllTenantSchemas } from './lib/tenantSync.js'
import { redactSecrets } from './lib/tenantProvisioner.js'
import { startSecurityEventAlerting } from './lib/securityAlerts.js'
// 窗口3（资源访问控制与外围加固）：CORS 通配符检测
import { corsConfigHasWildcard } from './lib/securityGuards.js'
// P3-W0-T01 / RC-10 (AUD-044)：统一 JWT 配置校验（与 deploy 薄 CLI 共用单一规则）
import { validateJwtConfig } from './lib/jwtSecretConfig.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3002
const serveStatic = process.env.SERVE_STATIC === 'true'

// 首轮 M5: 本服务 CORS 恒开 credentials:true，「Allow-Origin: *」+「Allow-Credentials: true」
// 是无效且危险的组合。不能依赖浏览器拒绝该组合 —— 服务端启动期强制校验，
// 与 JWT_SECRET 缺失时的强制中止模式保持一致。CORS_ORIGIN 必须是显式域名白名单。
if (corsConfigHasWildcard(process.env.CORS_ORIGIN)) {
    console.error('[FATAL] CORS_ORIGIN must not contain wildcard "*" (credentials:true is always enabled). Configure an explicit origin whitelist, e.g. CORS_ORIGIN=https://your.domain. Server startup aborted.')
    process.exit(1)
}
// DS-FIX: 多租户路径重写白名单 — 排除静态资源目录，避免 /css/xxx、/js/xxx 被误判为 /<schoolCode>/<resource>
// 学校代码经 schemaNameOf() 归一为 school_<code> 或 school-<code>，以及用户自定义的纯字母数字短横线。
// 这里列出项目内已知的静态目录名（含 vite 构建产物、测试配置等），防止与 schoolCode 冲突。
const RESERVED_STATIC_DIRS = new Set([
    'css', 'js', 'images', 'img', 'assets', 'static', 'media', 'fonts',
    'dist', 'public', 'uploads', 'locales', 'icons', 'favicon.ico',
    'node_modules', 'cypress', 'tests', 'docs', 'scripts', 'deploy',
    'backend', 'coverage', 'logs', '.well-known',
    // 服务器真实环境验证发现：裸路径 /health 被误判为学校代码改写成 / 导致 404，
    // 保留 health/api 防止健康检查端点与 API 前缀被多租户路径改写中间件劫持
    'health', 'api',
])
// P3-W0-T01 / RC-10 (AUD-044)：统一 JWT access/refresh 配置门禁。
// 单一规则来自 backend/lib/jwtSecretConfig.js（与 deploy 调用的薄 CLI 共用）；
// 在监听、数据库与后台工作启动前执行，所有 NODE_ENV 一致生效，无 test/dev/跳过开关。
// 失败仅输出字段名与安全原因，不输出任何密钥内容。
const jwtConfigResult = validateJwtConfig({
  accessSecret: process.env.JWT_SECRET,
  refreshSecret: process.env.JWT_REFRESH_SECRET,
})
if (!jwtConfigResult.ok) {
  for (const e of jwtConfigResult.errors) {
    console.error(`[FATAL] ${e.field}: ${e.reason} (code=${e.code}). Server startup aborted. Generate a strong random secret (e.g. openssl rand -hex 32) and retry.`)
  }
  process.exit(1)
}
const JWT_SECRET = jwtConfigResult.accessSecret
const JWT_REFRESH_SOURCE = jwtConfigResult.refreshSource
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 1000)
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || (60 * 1000))

// Initialize Prisma Client
const prisma = new PrismaClient()

// Initialize UserManager with Prisma
const userManager = new UserManager(prisma, JWT_SECRET)

// Initialize unified auth middleware
const { authenticateUser: _authUser, authorizeAdmin: _authAdmin, authorizeRoles, requireEditorOrAbove, requireGuestReadOnly, clearGuestVisibleTypesCache } = createAuthMiddleware(userManager, prisma)

function parseAllowedOrigins() {
    if (!process.env.CORS_ORIGIN) {
        // P1-13: 移除硬编码生产 IP，生产环境必须通过 CORS_ORIGIN 环境变量配置
        return [
            'http://localhost:3000',
            'http://localhost:3002',
            'http://localhost:8082',
            'http://localhost:5173',
            'http://127.0.0.1:5500',
            'http://127.0.0.1:3000',
            'http://127.0.0.1:8082'
        ]
    }

    return process.env.CORS_ORIGIN
        .split(',')
        .map(o => o.trim())
        .filter(Boolean)
}

function parseAllowedHostnames() {
    // Accept a comma-separated list of hostnames or hostname:port values from env.
    // Example: CORS_HOSTNAMES=159.75.106.179,127.0.0.1:3002
    const raw = process.env.CORS_HOSTNAMES || process.env.CORS_ADDITIONAL_HOSTS || ''
    return raw
        .split(',')
        .map(h => h.trim())
        .filter(Boolean)
}

// Middleware: Authenticate User（统一从 authMiddleware.js 导入，兼容 req.userId / req.userRole）
// 认证成功后注入请求级租户客户端 req.db（方案②：按 schoolCode 路由 schema）
const attachTenant = createTenantMiddleware(prisma)
export function authenticateUser(req, res, next) {
    _authUser(req, res, () => {
        // 向后兼容：同时挂载 req.userId 和 req.userRole
        if (req.user) {
            req.userId = req.user.userId
            req.userRole = req.user.role
        }
        attachTenant(req, res, next)
    })
}

// Security Middleware
app.use(rateLimit(RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS))

const allowedOrigins = parseAllowedOrigins()
const allowedHostnames = parseAllowedHostnames()

// TST-3: 反向代理后正确获取客户端真实 IP（rateLimit/审计日志依赖）
app.set('trust proxy', 1)

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (curl, Postman, server-side)
        if (!origin) return callback(null, true)

        // 首轮 M5: 不再支持通配符放行（含 '*' 的 CORS_ORIGIN 已在启动期被拒绝），
        // 仅允许显式白名单精确匹配；未匹配来源走下方 Error 分支，不返回任何 Allow-* 头。

        // Exact origin match (scheme + host + port)
        if (allowedOrigins.includes(origin)) return callback(null, true)

        // Allow if origin's hostname (or hostname:port) is included in allowedHostnames
        try {
            const u = new URL(origin)
            const hostWithPort = u.hostname + (u.port ? `:${u.port}` : '')
            if (allowedHostnames.includes(u.hostname) || allowedHostnames.includes(hostWithPort)) {
                return callback(null, true)
            }
        } catch (e) {
            // Ignore parse errors and fall through to rejection
        }

        // Do not throw an Error here (it becomes a 500). Return false so CORS header is not set
        // and log the denied origin for diagnosis.
        console.warn(`CORS denied origin: ${origin}`)
        return callback(null, false)
    },
    credentials: true
}))
// TestResult 证据图片上传：base64 JSON 体积约为原图 1.33 倍，需在全局 8mb 限制前放行更大 body
// （路径级中间件先于全局挂载执行，命中后 req.body 已就绪，全局 express.json 会跳过二次解析）
app.use('/api/test-results/upload', express.json({ limit: process.env.BODY_LIMIT_UPLOAD || '30mb' }))
// 问题反馈截图随反馈 JSON 一并提交（≤3 张、单张 5MB，base64 后约 20MB），同理在全局限制前放行
app.use('/api/feedback', express.json({ limit: process.env.BODY_LIMIT_FEEDBACK || '25mb' }))
app.use(express.json({ limit: process.env.BODY_LIMIT || '8mb' }))

// P1 维护模式写阻断：READONLY_MODE=true 时所有写请求返回 503（配合 Caddy 网关层双保险，
// 用于影子恢复 SWITCHING 窗口避免业务写入落到错误目标；审计写入豁免见 auditLog 内部直连）
import { createReadOnlyGuard } from './middleware/readOnlyMiddleware.js'
app.use(createReadOnlyGuard())

// P3-W1-T01（承接 W3-T01 挂起项）：**per-school 写屏障**挂载。
//   · W3 交付的 tenantWriteBarrier.createWriteBarrierMiddleware()：恢复窗口内按学校精确拒绝写
//     （503 + code TENANT_WRITE_BARRIER + Retry-After），全局 READONLY_MODE 仍为兜底（同一中间件内联判定）；
//   · 挂载失败**不得破坏启动**：捕获异常并高声告警（常规请求不受影响；恢复窗口仍由 READONLY_MODE 兜底）。
import { createWriteBarrierMiddleware } from './lib/tenantWriteBarrier.js'
try {
    app.use(createWriteBarrierMiddleware())
    console.log('✅ 写屏障中间件已挂载（per-school 精确屏障 + READONLY_MODE 兜底）')
} catch (e) {
    console.error('⚠️ 写屏障中间件挂载失败（不阻断启动；READONLY_MODE 兜底仍生效）:', e?.message || e)
}

// DS-10: 应用层安全响应头兜底（反向代理 deploy/ 亦应设置）
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // 同源管理后台需将前台页面嵌入预览 iframe，故对非 API 静态资源允许同源框嵌套；
    // API 路由保持禁止框嵌套（再叠加下方 CSP frame-ancestors 'none' 双重防护）。
    res.setHeader('X-Frame-Options', _req.path.startsWith('/api/') ? 'DENY' : 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-XSS-Protection', '1; mode=block')
    // NB-34: 仅在生产域名部署下设置 HSTS（HTTP 部署下无意义）
    if (process.env.DOMAIN) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    if (_req.path.startsWith('/api/')) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    }
    next()
})

// Favicon (inline SVG) so the browser's default /favicon.ico request won't 404.
app.get('/favicon.ico', (_req, res) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2563eb"/><path d="M9 21V11h4.2c3 0 4.8 1.6 4.8 5s-1.8 5-4.8 5H9zm2.4-2.2h1.6c1.6 0 2.4-.8 2.4-2.8s-.8-2.8-2.4-2.8H11.4v5.6z" fill="#fff"/></svg>`
    res.setHeader('Content-Type', 'image/svg+xml')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.send(svg)
})

// 多租户路径重写：/<schoolCode>/<resource> → /<resource>
// 本地开发 / 路径式部署下，静态文件统一在根目录，前端 extractSchoolCode() 自动提取路径中的 schoolCode。
// query 参数 ?school= 作为兜底入口，不受此重写影响。
app.use((req, _res, next) => {
    // 仅匹配静态资源路径，跳过 API，也不干涉根路径请求（/favicon.ico 等）
    if (req.path.startsWith('/api/')) return next()
    // /<schoolCode>  →  /（主页）
    const bare = req.path.match(/^\/([a-z0-9-]{1,40})$/)
    if (bare && !RESERVED_STATIC_DIRS.has(bare[1])) { req.url = '/'; return next() }
    // /<schoolCode>/<resource>  →  /<resource>
    const m = req.path.match(/^\/([a-z0-9-]{1,40})\/(?!api\/)(.+)$/)
    // 排除已知静态资源目录，避免把 /css/xxx、/js/xxx 误判成 /<schoolCode>/<resource>
    // schoolCode 经 schemaNameOf() 归一为 school_<code> 或以 school- 前缀开头（不会出现 css/js/images 等保留名）
    if (m && !RESERVED_STATIC_DIRS.has(m[1])) req.url = '/' + m[2]
    next()
})

// Optional static hosting for local convenience.
// Production Tencent Cloud deployment should use Nginx/COS for static files.
if (serveStatic) {
    // 前端源码已迁入 frontend/，仓库根目录不再直接是站点根。
    // 托管构建产物 dist/（其内布局与线上 Caddy 直供的目录一致），
    // 同时避免把 backend/ 源码与 .env 等静态暴露出去。
    app.use(express.static(path.join(__dirname, '../dist')))
}

// Health Check (P2-06: 合并重复定义，两个路由共用同一处理器)
// P3-W2-T02-R1（RC-04）：liveness 保持 200，但**显式携带 readiness 摘要**——
// 结构/迁移未就绪时不得对外声称"健康"（readiness 端点 /readyz 同步返回 503）。
function healthCheck(req, res) {
    const r = app.locals.tenantReadiness || null
    res.json({
        status: 'ok',
        ready: r ? r.ok === true : null,
        tenantSchema: r ? {
            mode: r.mode, status: r.status, certification: r.certification || null,
            blockedSchools: r.blockedSchools || [], globalBlockers: (r.globalBlockers || []).map((g) => g.code),
        } : null,
        timestamp: new Date(),
    })
}
app.get('/health', healthCheck)
app.get('/api/health', healthCheck)

// Readiness：租户结构/迁移就绪才是 200（RC-04：部署 migration 成功后才开放 readiness）。
function readinessCheck(req, res) {
    const r = app.locals.tenantReadiness || { ok: false, status: 'UNKNOWN', blockedSchools: [] }
    res.status(r.ok ? 200 : 503).json({
        status: r.ok ? 'ready' : 'not-ready',
        tenantSchema: {
            mode: r.mode || 'unknown',
            status: r.status || 'UNKNOWN',
            certification: r.certification || null,
            blockedSchools: r.blockedSchools || [],
            globalBlockers: (r.globalBlockers || []).map((g) => g.code),
            publicExtraTables: r.publicExtraTables || [],
            checkedAt: r.checkedAt || null,
            detail: r.detail || null,
        },
        timestamp: new Date(),
    })
}
app.get('/readyz', readinessCheck)
app.get('/api/readyz', readinessCheck)

// ====== 租户就绪能力闸门（P3-W2-T02-R1 / RC-04）======
// 启动只做检测（永不写结构）；检测未通过（漂移 / 检查失败 / 迁移 pending|failed / 超时）时：
//   · readiness 端点返回 503；同时**阻断受影响学校的能力**（503 TENANT_SCHEMA_NOT_READY）；
//   · 只阻断"能确定学校上下文"的租户请求（路径前缀 / 登录体 schoolCode / Bearer 载荷 schoolCode）；
//     平台级路径与健康/就绪端点不受影响；判定不出学校上下文的请求交由认证层裁决（避免误伤）。
//   · mode=off（AUTO_SYNC_TENANTS=false）= 不跑检测 → 迁移**未证实** → 同样 fail-closed 阻断租户入口
//     （R6 ①：不存在任何"凭环境变量放行"的通道；受保护 harness 必须改用已迁移实例 + 默认 check）。
// 豁免清单（逐项列明；除此之外的入口在就绪未证实/存在阻断时必须拒绝）：
//   · /health、/api/health      —— liveness（携带 ready 摘要，不声称就绪）
//   · /readyz、/api/readyz      —— readiness 本身（用于诊断）
//   · /api/admin/**             —— 平台超管的诊断/修复入口（暂停/恢复学校、备份、db 运维视图）
//   · /api/user/super-admin/**  —— 平台超管登录（无学校归属）
//   · 静态资源（在闸门之前注册，不经此处）
const TENANT_PLATFORM_PATH_RE = /^\/(api\/admin\/|api\/user\/super-admin\/|api\/health|api\/readyz|health|readyz)/
const RESERVED_SCHOOL_PREFIX = new Set(['api', 'health', 'readyz', 'css', 'js', 'images', 'img', 'assets', 'static', 'dist', 'uploads', 'favicon.ico'])
function tenantSchoolHint(req) {
    const url = String(req.originalUrl || req.url || '')
    const m = url.match(/^\/([a-z0-9-]{1,40})\//)
    if (m && !RESERVED_SCHOOL_PREFIX.has(m[1])) return m[1]
    const body = req.body
    if (body && typeof body === 'object' && typeof body.schoolCode === 'string' && body.schoolCode) return body.schoolCode
    const auth = String(req.headers?.authorization || '')
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (token && token.split('.').length === 3) {
        try {
            const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
            if (typeof payload.schoolCode === 'string' && payload.schoolCode) return payload.schoolCode
        } catch { /* 载荷不可解析：不据此放行也不据此阻断 */ }
    }
    return null
}
function tenantReadinessGate(req, res, next) {
    try {
        const r = app.locals.tenantReadiness
        if (!r) return next()                                   // 检测尚未完成的窗口（首轮在 listen 前完成，正常不可达）
        if (r.ok === true) return next()                        // 已证实就绪：全部放行
        const url = String(req.originalUrl || req.url || '')
        if (TENANT_PLATFORM_PATH_RE.test(url)) return next()     // 显式豁免清单（见上）
        // R6 ①：**不存在**凭环境变量放行租户流量的路径（原 TENANT_READINESS_ATTESTED 已删除）。
        // 未证实就绪（off / 分类失败 / public 额外对象 / 迁移层问题）时，唯一放行通道 = 检测通过。
        // ① 全局阻断（public 迁移 failed/pending/checksum/未知条目/台账缺失/检查超时/分类失败/public 额外对象）：
        //    **所有**未豁免的租户入口拒绝（与学校归属无关，修复前不得穿透）
        const globalBlockers = Array.isArray(r.globalBlockers) ? r.globalBlockers : []
        if (globalBlockers.some((g) => g.trafficBlocking !== false)) {
            return res.status(503).json({
                error: '❌ 平台迁移未证实完成（public migration pending/failed/checksum/超时），已按 RC-04 阻断租户入口；请人工核实后运行 npm run db:sync 或按 runbook 处置',
                code: 'TENANT_MIGRATION_NOT_READY',
                checkStatus: r.status,
                globalBlockers: globalBlockers.map((g) => g.code),
                checkedAt: r.checkedAt || null,
            })
        }
        // ② 按学校阻断：可归属 → 命中 blockedSchools 才拒绝；**归属无法确认 → 拒绝（fail-closed）**
        const hint = tenantSchoolHint(req)
        if (!hint) {
            return res.status(503).json({
                error: '❌ 无法确认该租户请求的学校归属（且平台迁移/结构未全部就绪），已 fail-closed 拒绝',
                code: 'TENANT_NOT_ATTRIBUTED',
                checkStatus: r.status,
                checkedAt: r.checkedAt || null,
            })
        }
        if (Array.isArray(r.blockedSchools) && r.blockedSchools.includes(hint)) {
            return res.status(503).json({
                error: '❌ 该校迁移/结构未就绪（RC-04：台账缺失/失败、结构漂移或额外对象），已阻断该校能力；请运行 npm run db:sync（逐租户版本化）或按 runbook 处置后重试',
                code: 'TENANT_SCHEMA_NOT_READY',
                schoolCode: hint,
                checkStatus: r.status,
                checkedAt: r.checkedAt || null,
            })
        }
        return next()
    } catch (e) {
        // 闸门自身异常不得放行：fail-closed（保守拒绝，可重试）
        return res.status(503).json({ error: '租户就绪闸门异常，已 fail-closed 拒绝', code: 'TENANT_GATE_ERROR' })
    }
}
app.use(tenantReadinessGate)

// ====== School Management (超管：动态新增/列出学校，方案② 运行时建 schema) ======
// 仅 role=admin 且不属于任何具体学校（school_code 为空 = 平台超管，落在 public schema）可操作，
// 防止某校 admin 越权创建其它学校。系统表位于 public，直连全局 prisma。
// 供 schoolRoutes 与 adminBackupRoutes 共用（P1-5 拆路由：从原 server.js 内联提升为共享守卫）。
function requirePlatformSuperAdmin(req, res, next) {
    const role = req.user?.role ?? req.userRole
    const schoolCode = req.user?.schoolCode || null
    if (role !== 'admin' || schoolCode) {
        return res.status(403).json({ error: '❌ 仅平台超级管理员（public/无学校归属的 admin）可管理学校' })
    }
    next()
}

// ====== School Management / School Config / Recycle-bin / Field-options / School Users ======
const schoolRoutes = createSchoolRoutes({ prisma, authenticateUser, clearGuestVisibleTypesCache, rateLimit, requirePlatformSuperAdmin })
app.use('/', schoolRoutes)

// ====== User Authentication Routes ======
const userRoutes = createUserRoutes(userManager)
app.use('/api/user', userRoutes)

// H1-ext / #6: 当前用户信息（权威角色）。前端登录后/定时调用以同步最新角色，
// 避免后端角色变更（经 H1-ext 覆盖 / role-audit-trigger 即时生效）而前端按钮仍按旧 token 角色渲染。
app.get('/api/user/me', authenticateUser, (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' })
  res.json({ success: true, user: {
    id: req.user.userId,
    username: req.user.username,
    role: req.user.role,
    schoolCode: req.user.schoolCode,
    status: req.user.status,
  } })
})

// ====== Audit Logs Routes ======
const auditRoutes = createAuditRoutes(userManager, prisma)
app.use('/api/audit-logs', auditRoutes)

// ====== Session Routes（TD-Session）======
const sessionRoutes = createSessionRoutes(userManager, prisma)
app.use('/api/session', sessionRoutes)

// ====== Guest Routes（TD-Guest 收口）======
const guestRoutes = createGuestRoutes(userManager, prisma, JWT_SECRET)
app.use('/api/guest', guestRoutes)

// ====== Feedback Routes（问题反馈：manager/operator/viewer/guest 全角色可提交，
// 落 public.SystemLog 留档 + 推送钉钉群机器人 DINGTALK_WEBHOOK_URL）======
const feedbackRoutes = createFeedbackRoutes({ prisma, authenticateUser })
app.use('/api/feedback', feedbackRoutes)

// ====== Sync Routes ======
const syncRoutes = createSyncRoutes(userManager, prisma)
app.use('/api/sync', syncRoutes)

// ====== Backup Management Routes（P1：运维备份控制台，仅平台超管）======
const adminBackupRoutes = createAdminBackupRoutes({ prisma, authenticateUser, requirePlatformSuperAdmin })
app.use('/api/admin/backups', adminBackupRoutes)

// ====== Disk Management Routes（2026-08-27 容量策略：90% 水位告警 + 超管人工清理，仅平台超管）======
const adminDiskRoutes = createAdminDiskRoutes({ prisma, authenticateUser, requirePlatformSuperAdmin })
app.use('/api/admin/disk', adminDiskRoutes)

// ====== School Backup Routes（TD-School-Backup-Sync：学校侧备份运维，强制本校隔离）======
// 入口 /api/school/backups；与超管能力一致（list/run/download/verify/restore），
// 但强制以 token 中 req.user.schoolCode 为作用域，禁止跨校读取/恢复。
const schoolBackupRoutes = createSchoolBackupRoutes({ prisma, authenticateUser })
app.use('/api/school/backups', schoolBackupRoutes)

// ====== Open API（第三方数据开放，2026-09-15 朴食对接）======
// ⚠️ 挂载顺序硬约束：必须位于下方 `app.use('/api', recognitionRoutes)` 之前 ——
// recognitionRoutes 挂载在 /api 根路径且带 router.use(authenticateUser)，
// 会把 /api/open/* 一律拦成「缺少授权令牌」401（2026-09-15 实测踩坑）。
// ① /api/admin/open-api —— 超管配置：对接方 / 凭证 / 学校授权（requirePlatformSuperAdmin）
// ② /api/open/v1       —— 对外只读接口：API Key 认证（非 JWT，独立于 authenticateUser），
//    按 grant 的 school_code 校验并创建租户客户端取数；无任何写入路径。
const adminOpenApiRoutes = createAdminOpenApiRoutes({ prisma, authenticateUser, requirePlatformSuperAdmin })
app.use('/api/admin/open-api', adminOpenApiRoutes)
const openApiRoutes = createOpenApiRoutes({ prisma })
app.use('/api/open', openApiRoutes)

// ====== Test Result Routes（临时测试工具：测试结果上报，任意登录用户）======
const testResultRoutes = createTestResultRoutes(userManager, prisma)
app.use('/api/test-results', testResultRoutes)

// ====== Detergent Colorimetry Recognition（后端 opencv 方案，单 Worker 排队）======
const recognitionRoutes = createRecognitionRoutes(userManager, prisma)
app.use('/api', recognitionRoutes)

// N1/N2/N3: 检测频率阈值 / 检测日历 / 检测月报
// 需 authenticateUser 注入 req.db/req.user(与 /api/test-records 等一致)
app.use('/api/frequency', authenticateUser, frequencyRoutes)

// ====== Test Records API（/api/test-records + /api/records，P1-5 拆路由迁至 recordRoutes）======
const recordRoutes = createRecordRoutes({ authenticateUser, requireEditorOrAbove, requireGuestReadOnly, idempotencyMiddleware })
app.use('/', recordRoutes)

// ====== User Management（统一由 userRoutes 承载，见上方 /api/user）======
// TD-Users-Dup 已解决：原内联的 /api/users（GET 列表 / POST disable|enable）
// 与 /api/user（userRoutes）功能重复，且内联版本调用 userManager 时**未带租户
// schoolCode**，会落到默认 schema 而非当前登录学校（隔离缺陷）。现统一删除内联
// 实现，全部走 /api/user（已含 authorizeRoles('admin') + 请求级 req.db 租户隔离）。

// ====== Error Handling ======

app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err)
    res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
    })
})

// ====== Start Server ======

// ====== 启动租户结构/迁移检测（P3-W2-T02-R1，RC-04）======
// 原则（冻结裁决）：**启动只做 drift detection，任何 AUTO_SYNC_TENANTS 取值都不写结构**；
//   部署 migration 成功后才开放 readiness；未知漂移 / 单租户失败 / failed migration 阻断对应能力。
// 取值兼容（文档化）：
//   · 未设置（默认）→ check：只读检测 + readiness 闸门（受影响学校能力 503）；
//   · 'true'（历史值）→ **仍为 check**（不再 apply；启动日志打印兼容提示，杜绝"重启即对齐"）；
//   · 'false' → off：跳过检测（运维显式自担；readiness = NOT_VERIFIED **且租户入口 503**，不是"放行"）。
// 显式升级入口（唯一会写结构的路径）：`npm run db:sync`（非破坏性；0/1/2 退出码）。
const TENANT_SYNC_MODE = process.env.AUTO_SYNC_TENANTS === 'false' ? 'off' : 'check'
const TENANT_SYNC_LEGACY_TRUE = process.env.AUTO_SYNC_TENANTS === 'true'
const TENANT_READINESS_TIMEOUT_MS = Number(process.env.TENANT_READINESS_TIMEOUT_MS || 15000)
const TENANT_READINESS_RECHECK_MS = Number(process.env.TENANT_READINESS_RECHECK_MS || 60000)

app.locals.tenantReadiness = {
    ok: false, mode: TENANT_SYNC_MODE, status: 'PENDING', certification: 'pending',
    globalBlockers: [], blockedSchools: [], publicExtraTables: [], checkedAt: null,
    detail: '首轮只读证明未完成（listen 前完成；正常不可达）',
}

/** 只读证明（首轮在 listen 前完成；之后周期复检以便修复后自动放开）。 */
async function refreshTenantReadiness() {
    if (TENANT_SYNC_MODE === 'off') {
        // RC-04（R5 ①/R6 ①）：`false` = 不跑检测 → **迁移未证实** → readiness 非 200 **且租户业务 fail-closed**。
        // 没有例外通道：本函数与闸门均不读取任何"声明式"环境变量来放行（原 attestation 通道已删除）。
        app.locals.tenantReadiness = {
            ok: false, mode: 'off', status: 'NOT_VERIFIED', certification: 'not-verified',
            globalBlockers: [{
                code: 'NOT_VERIFIED', trafficBlocking: true,
                detail: 'AUTO_SYNC_TENANTS=false：迁移未验证（未运行检测）→ 按 RC-04 阻断租户能力；'
                    + '受控测试请在**已迁移实例**上使用默认 check（AUTO_SYNC_TENANTS 不设为 false）',
            }],
            blockedSchools: [], publicExtraTables: [], checkedAt: new Date().toISOString(),
            detail: 'AUTO_SYNC_TENANTS=false：跳过检测 → readiness NOT_VERIFIED 且租户入口 503（fail-closed；无放行通道）',
        }
        console.warn('⚠️  AUTO_SYNC_TENANTS=false：跳过启动迁移/结构检测 → readiness=NOT_VERIFIED（/api/readyz 503）' +
            '**且租户入口 503**（RC-04 fail-closed，无 attestation 放行通道）；不会写结构。' +
            '受保护 harness 请在已迁移实例上改用默认 check。')
        return app.locals.tenantReadiness
    }
    let result = null
    let failure = null
    try {
        result = await Promise.race([
            syncAllTenantSchemas(prisma, { mode: 'check', skipGenerate: true, log: (m) => console.log(`[tenant-check] ${m}`) }),
            new Promise((_, reject) => {
                const t = setTimeout(() => reject(new Error(`检测超时（${TENANT_READINESS_TIMEOUT_MS}ms）`)), TENANT_READINESS_TIMEOUT_MS)
                if (typeof t.unref === 'function') t.unref()
            }),
        ])
    } catch (e) {
        failure = e
        result = {
            ok: false, status: 'CANNOT_CHECK', blockedSchools: [],
            globalBlockers: [{ code: 'CANNOT_CHECK', trafficBlocking: true, detail: redactSecrets(e.message) }],
        }
    }
    const ok = !!(result && result.ok === true && result.status === 'OK')
    const readiness = {
        ok,
        mode: 'check',
        status: result?.status || 'CANNOT_CHECK',
        certification: ok ? 'verified' : 'not-verified',
        globalBlockers: Array.isArray(result?.globalBlockers) ? result.globalBlockers : [],
        blockedSchools: Array.isArray(result?.blockedSchools) ? result.blockedSchools : [],
        publicExtraTables: result?.publicExtraObjects?.extraTables || [],
        checkedAt: new Date().toISOString(),
        detail: ok ? null : (failure?.message || `TENANT_SCHEMA_CHECK=${result?.status || 'unknown'}`),
    }
    app.locals.tenantReadiness = readiness
    if (ok) {
        console.log(`✅ 迁移/结构证明通过：TENANT_SCHEMA_CHECK=OK（schools=${result.checked ?? '-'}；active+disabled 全覆盖；checksum 逐条一致）`)
    } else {
        console.error(
            `⛔ 迁移/结构证明未通过：TENANT_SCHEMA_CHECK=${readiness.status}` +
            `${readiness.globalBlockers.length ? ` globalBlockers=[${readiness.globalBlockers.map((g) => g.code).join(',')}]` : ''}` +
            `${readiness.blockedSchools.length ? ` blockedSchools=[${readiness.blockedSchools.join(',')}]` : ''}` +
            `${readiness.publicExtraTables.length ? ` publicExtra=[${readiness.publicExtraTables.slice(0, 5).join(',')}]` : ''}` +
            ` —— 租户入口按 RC-04 受限（全局中断 503 TENANT_MIGRATION_NOT_READY / 单校 503 TENANT_SCHEMA_NOT_READY / 无法归属 503 TENANT_NOT_ATTRIBUTED）；` +
            `启动不写结构；请运行 npm run db:sync（逐租户版本化回放）或按 runbook 处置，复检每 ${Math.round(TENANT_READINESS_RECHECK_MS / 1000)}s`
        )
    }
    return readiness
}

if (TENANT_SYNC_LEGACY_TRUE) {
    console.warn('⚠️  AUTO_SYNC_TENANTS=true 的旧语义（启动时执行结构对齐）已按 RC-04 废止：本次仅做只读检测，不会写结构；请改用 npm run db:sync')
}

// 首轮检测在监听之前完成（无"监听后才异步告警"的窗口）；失败/超时只影响 readiness 与学校能力，不阻断启动。
await refreshTenantReadiness()

const server = app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`🚀 Food Safety Testing Lab API Server Started`)
    console.log(`${'='.repeat(60)}`)
    console.log(`📍 Server running on: http://localhost:${PORT}`)
    console.log(`📍 API Endpoints: http://localhost:${PORT}/api`)
    console.log(`🔐 JWT secrets: access configured ✅; refresh = ${JWT_REFRESH_SOURCE}`)
    console.log(`🗄️  Database: PostgreSQL (Prisma, Schema-per-tenant)`)
    console.log(`🧩 Tenant schema mode: ${TENANT_SYNC_MODE}${TENANT_SYNC_MODE === 'check' ? '（只读证明；启动永不写结构）' : '（跳过检测）'}`)
    const r = app.locals.tenantReadiness
    console.log(`🩺 Tenant readiness: ${r.ok ? 'READY(verified)' : `NOT-READY(${r.status}; certification=${r.certification || 'n/a'}${r.globalBlockers.length ? `; global=${r.globalBlockers.map((g) => g.code).join(',')}` : ''}${r.blockedSchools.length ? `; blocked=${r.blockedSchools.join(',')}` : ''})`}`)
    console.log(`📦 CORS Origins: ${allowedOrigins.join(', ')}`)
    console.log(`📦 CORS Hostnames: ${allowedHostnames.length ? allowedHostnames.join(', ') : '(none)'}`)
    console.log(`${'='.repeat(60)}\n`)

    // 周期复检（只读）：修复（db:sync / migration）后无需重启即可自动放开对应学校；
    // 启动侧永不写结构（RC-04）。
    if (TENANT_SYNC_MODE === 'check' && Number.isFinite(TENANT_READINESS_RECHECK_MS) && TENANT_READINESS_RECHECK_MS > 0) {
        const timer = setInterval(() => { refreshTenantReadiness().catch(() => {}) }, TENANT_READINESS_RECHECK_MS)
        if (typeof timer.unref === 'function') timer.unref()
    }

    // 运行时 DDL 附加系统表：recycle_bin（学校回收站）。幂等建表（与 revoked_tokens 同模式）。
    // 旧版本遗漏建表代码，导致生产库缺表 → /api/admin/recycle-bin 查询 500。
    // 单进程 memoized，失败仅告警不影响启动，下次请求时由路由内 ensureRecycleBinInfra 重试。
    ensureRecycleBinInfra(prisma)
        .then(() => console.log('✅ 系统表 recycle_bin 已就绪'))
        .catch((e) => console.error('⚠️  系统表 recycle_bin 建表失败（不影响服务运行，路由将在首次访问时重试）:', e.message))

    // 第六轮·检查项2：SECURITY:* 安全事件告警扫描（REVOCATION_WRITE_FAILED /
    // REFRESH_TOKEN_REPLAY / REFRESH_CONCURRENT_ROTATION / TENANT_SCHEMA_MISMATCH），
    // 消除"事件落库但无人读取"的静默风险。默认每 5min 扫一次 SystemLog，
    // 有新增即 console.error 汇总 + 可选企业微信 webhook（SECURITY_ALERT_WEBHOOK_URL）。
    startSecurityEventAlerting(prisma)
})

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('📌 SIGTERM signal received: closing HTTP server')
    // TST-6: 10秒超时兜底，避免长连接导致进程挂起被 systemd SIGKILL
    const forceExit = setTimeout(() => {
        console.error('⚠️ Graceful shutdown 超时，强制退出')
        process.exit(1)
    }, 10000)
    forceExit.unref()
    server.close(async () => {
        await disconnectAllTenantClients()
        await prisma.$disconnect()
        clearTimeout(forceExit)
        process.exit(0)
    })
})

process.on('SIGINT', async () => {
    console.log('📌 SIGINT signal received: closing HTTP server')
    const forceExit = setTimeout(() => {
        console.error('⚠️ Graceful shutdown 超时，强制退出')
        process.exit(1)
    }, 10000)
    forceExit.unref()
    server.close(async () => {
        await disconnectAllTenantClients()
        await prisma.$disconnect()
        clearTimeout(forceExit)
        process.exit(0)
    })
})

export { app, prisma, userManager }
