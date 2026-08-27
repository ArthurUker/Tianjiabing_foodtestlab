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
import { disconnectAllTenantClients } from './lib/tenantClient.js'
import { syncAllTenantSchemas } from './lib/tenantSync.js'
import { startSecurityEventAlerting } from './lib/securityAlerts.js'
// 窗口3（资源访问控制与外围加固）：CORS 通配符检测
import { corsConfigHasWildcard } from './lib/securityGuards.js'

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
const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is not set. Server startup aborted.')
  process.exit(1)
}

// P0-12 (子问题3): 拒绝已知弱/默认占位密钥，防止误用 .env.example 默认值启动并签发 JWT
const KNOWN_WEAK_SECRETS = [
  'your-super-secret-jwt-key-change-this-in-production',
  'your-secret-key-change-in-production',
  'local-dev-jwt-secret',
  'food-lab-secret-key',
  'please_change_this_secret'
]
if (KNOWN_WEAK_SECRETS.includes(JWT_SECRET)) {
  console.error('[FATAL] JWT_SECRET is a known weak/default value. Server startup aborted. Please generate a strong random secret.')
  process.exit(1)
}
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
app.use(express.json({ limit: process.env.BODY_LIMIT || '8mb' }))

// P1 维护模式写阻断：READONLY_MODE=true 时所有写请求返回 503（配合 Caddy 网关层双保险，
// 用于影子恢复 SWITCHING 窗口避免业务写入落到错误目标；审计写入豁免见 auditLog 内部直连）
import { createReadOnlyGuard } from './middleware/readOnlyMiddleware.js'
app.use(createReadOnlyGuard())

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
    app.use(express.static(path.join(__dirname, '../')))
}

// Health Check (P2-06: 合并重复定义，两个路由共用同一处理器)
function healthCheck(req, res) {
    res.json({ status: 'ok', timestamp: new Date() })
}
app.get('/health', healthCheck)
app.get('/api/health', healthCheck)

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

// 启动自愈：服务起来后，后台把全部租户（含控制台 UI 新建、不在 SCHOOL_CODES 的）schema
// 与当前 schema.prisma 对齐，并回填 SchoolCustomization 的历史 NULL。
// 这样无论「改 schema 后重部署」还是「手动 git pull 后重启」漏跑 db:sync，都能在下次重启自愈，
// 不再依赖人工记忆「逐租户 db push」。非阻塞：服务已就绪即开始，失败仅告警不影响启动。
// 可用 AUTO_SYNC_TENANTS=false 关闭（改由手动 npm run db:sync）。
function selfHealTenantSchemas() {
    if (process.env.AUTO_SYNC_TENANTS === 'false') {
        console.log('ℹ️  AUTO_SYNC_TENANTS=false，跳过启动自愈（请记得手动 npm run db:sync）')
        return
    }
    console.log('🔧 启动自愈：对齐全部租户 schema 与 schema.prisma（后台执行，不阻塞服务）...')
    syncAllTenantSchemas(prisma, {
        adminPassword: process.env.SEED_ADMIN_PASSWORD || '',
        skipGenerate: true, // 运行时客户端已生成，无需再 generate
        log: (m) => console.log(`[self-heal] ${m}`)
    })
        .then(() => console.log('✅ 租户 schema 自愈完成'))
        .catch((e) => console.error('⚠️  租户 schema 自愈失败（不影响服务运行，可手动 npm run db:sync）:', e.message))
}

const server = app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`🚀 Food Safety Testing Lab API Server Started`)
    console.log(`${'='.repeat(60)}`)
    console.log(`📍 Server running on: http://localhost:${PORT}`)
    console.log(`📍 API Endpoints: http://localhost:${PORT}/api`)
    console.log(`🔐 JWT Secret configured: ${JWT_SECRET ? '✅' : '❌ MISSING'}`)
    console.log(`🗄️  Database: PostgreSQL (Prisma, Schema-per-tenant)`)
    console.log(`📦 CORS Origins: ${allowedOrigins.join(', ')}`)
    console.log(`📦 CORS Hostnames: ${allowedHostnames.length ? allowedHostnames.join(', ') : '(none)'}`)
    console.log(`${'='.repeat(60)}\n`)

    // 服务就绪后再后台自愈，避免拖慢首请求响应
    selfHealTenantSchemas()

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
