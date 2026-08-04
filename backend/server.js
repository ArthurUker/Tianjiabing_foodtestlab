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
import { writeTenantAuditLog, writeAdminOpsLog } from './lib/auditLog.js'
import { createGuestRoutes, createGuestExportRequestRoutes } from './routes/guestRoutes.js'
import { createValidationMiddleware, rateLimit, sanitizeText } from './middleware/validationMiddleware.js'
import idempotencyMiddleware from './middleware/idempotencyMiddleware.js'
import { createAuthMiddleware } from './middleware/authMiddleware.js'
import { createTenantMiddleware } from './middleware/tenantMiddleware.js'
import { createSyncRoutes } from './routes/syncRoutes.js'
import { provisionSchool, isValidSchoolCode } from './lib/tenantProvisioner.js'
import { disconnectAllTenantClients, createTenantClient, schemaNameOf } from './lib/tenantClient.js'
import { syncAllTenantSchemas } from './lib/tenantSync.js'
import { startSecurityEventAlerting } from './lib/securityAlerts.js'
import {
    listFieldOptions, buildFieldCascade, ensureFieldOptionSeeds,
    replaceFieldOptions, createFieldOption, updateFieldOption, deleteFieldOption,
    TABLE_MANAGED_FIELDS,
} from './lib/fieldOptionService.js'

// 防御性归一化：级联字段（testType/location 等）的选项由 FieldOption 表唯一管理，
// 返回给客户端前剔除 field_options 中的表管理字段键与历史 cascade 简化版残留，
// 避免录入端 fields.js 用文本数组覆盖 value/label 分离的下拉。
function sanitizeFieldOptionsForClient(fo) {
    // 兼容 JSON 字符串存储（列类型为 text）：parse → 清理 → stringify
    if (typeof fo === 'string') {
        try {
            const parsed = JSON.parse(fo)
            return JSON.stringify(sanitizeFieldOptionsForClient(parsed))
        } catch (_) { return fo }
    }
    if (!fo || typeof fo !== 'object' || Array.isArray(fo)) return fo
    const out = { ...fo }
    delete out.cascade
    for (const fields of Object.values(TABLE_MANAGED_FIELDS)) {
        for (const f of fields) delete out[f]
    }
    return out
}
// 窗口3（资源访问控制与外围加固）：归属校验 / guest 脱敏 / Logo 魔数校验 / CORS 通配符检测
import { canModifyRecord, maskGuestSensitiveFields, isSafeLogoUrl, corsConfigHasWildcard } from './lib/securityGuards.js'
import bcryptjs from 'bcryptjs'

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
const { authenticateUser: _authUser, authorizeAdmin: _authAdmin, authorizeRoles, requireGuestReadOnly, clearGuestVisibleTypesCache } = createAuthMiddleware(userManager, prisma)

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

const RECORD_ROUTE_TYPES = new Set([
    'tableware',
    'pathogen',
    'leanMeat',
    'oil',
    'pesticide'
])

const TEST_TYPE_LABELS = {
    tableware: '餐具洁净度检测',
    pathogen: '病原体检测',
    leanMeat: '肉、蛋农残检测',
    oil: '食用油品质检测',
    pesticide: '果蔬农残检测'
}

function normalizeRecordType(tableName) {
    return RECORD_ROUTE_TYPES.has(tableName) ? tableName : null
}

// NB-02: 统一错误响应辅助函数，生产环境不泄露内部细节
const clientErr = (msg) => ({ error: msg })

function safeParseJson(value, fallback) {
    if (!value) return fallback
    try {
        return JSON.parse(value)
    } catch {
        return fallback
    }
}

// D-06: 递归剔除原型链污染键（__proto__ / constructor / prototype），深度上限 10。
// 所有解析用户提交 JSON（result_data / sample_info / 定制配置）的入口都必须过此函数。
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function sanitizeObjectKeys(value, depth = 0) {
    if (depth > 10 || value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(item => sanitizeObjectKeys(item, depth + 1))
    const clean = {}
    for (const key of Object.keys(value)) {
        if (DANGEROUS_KEYS.has(key)) continue
        clean[key] = sanitizeObjectKeys(value[key], depth + 1)
    }
    return clean
}

// ====== RK8/RK10/RK12: 学校定制配置服务器端校验 ======
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
const CUSTOM_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const TYPE_CODE_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
// 菜单项 code：camelCase（与 js/modules/registry.js 的 MENU_ITEMS 注册表对齐）
const MENU_CODE_RE = /^[a-z][a-zA-Z0-9]{0,63}$/
const CUSTOM_FIELD_TYPES = new Set(['text', 'number', 'date', 'select', 'textarea', 'checkbox'])
const MAX_JSON_FIELD_BYTES = 200 * 1024 // 单字段序列化后上限 200KB

// DS-09 核查结论（Logo SSRF）：后端从不抓取/下载 logoUrl —— 全仓无 fetch(logoUrl)/https.get(logoUrl)
// 等出站请求；logo_url 仅作为字符串校验后存库，由前端 <img src> 渲染。SSRF 风险 N/A。
// DS3-M4/DS3-M5: isSafeLogoUrl 已迁移至 lib/securityGuards.js（便于单测），并在原有
// MIME 前缀校验基础上追加 base64 魔数比对（PNG/JPEG/GIF/WebP），SVG 仍显式禁止（DS-12）；
// http(s) 外链支持可选 LOGO_ALLOWED_HOSTS 域名白名单（未配置时保持放行，已知限制：
// 外链 <img> 可被用作访客 IP 探测/追踪探针，见 securityGuards.js 内注释）。

function jsonDepthOf(value, depth = 0) {
    if (depth > 8) return depth
    if (value === null || typeof value !== 'object') return depth
    let max = depth
    const items = Array.isArray(value) ? value : Object.values(value)
    for (const item of items) {
        const d = jsonDepthOf(item, depth + 1)
        if (d > max) max = d
    }
    return max
}

// 校验单个 JSON 定制字段的通用约束（可解析性 / 体积 / 深度），返回错误信息或 null
function checkJsonField(name, value, expect /* 'object' | 'array' */) {
    if (value === undefined || value === null) return null
    let parsed = value
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value) } catch { return `${name} 不是合法 JSON` }
    }
    const serialized = JSON.stringify(parsed)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_FIELD_BYTES) return `${name} 超过 200KB 上限`
    if (jsonDepthOf(parsed) > 6) return `${name} 嵌套深度超过 6 层`
    if (expect === 'object' && (Array.isArray(parsed) || typeof parsed !== 'object')) return `${name} 必须是 JSON 对象`
    if (expect === 'array' && !Array.isArray(parsed)) return `${name} 必须是 JSON 数组`
    return parsed
}

// RK8/RK10/RK11/RK12/DS-12: 定制配置载荷校验。返回 { valid, errors, normalized }
function validateCustomizationPayload(body) {
    const errors = []
    const b = sanitizeObjectKeys(body || {})

    const spec = {
        visible_types: 'array',
        field_labels: 'object',
        hidden_fields: 'array',
        theme_config: 'object',
        field_rules: 'object',
        field_options: 'object',
        field_order: 'object',
        custom_fields: 'object',
        test_types: 'array',
        visible_menu_items: 'array',
        field_types: 'object'
    }
    const normalized = {}
    for (const [key, expect] of Object.entries(spec)) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) continue
        if (b[key] === null) { normalized[key] = null; continue } // BS-03: 显式 null = 清空
        const result = checkJsonField(key, b[key], expect)
        if (typeof result === 'string') { errors.push(result); continue }
        normalized[key] = result
    }

    // theme_config 内颜色值校验
    if (normalized.theme_config && typeof normalized.theme_config === 'object') {
        for (const [k, v] of Object.entries(normalized.theme_config)) {
            // 自定义系统标题（DS-TITLE）：独立强校验，不再依赖"未知 key 透传"
            if (k === 'systemTitle') {
                if (typeof v !== 'string') {
                    errors.push('theme_config.systemTitle 必须为字符串')
                    continue
                }
                const t = v.trim()
                if (t === '') {
                    // 空值（含纯空格）视为"未设置"，回落默认标题，不存储脏值
                    delete normalized.theme_config.systemTitle
                    continue
                }
                if (Array.from(t).length > 50) {
                    errors.push('theme_config.systemTitle 长度不能超过 50 个字符')
                    continue
                }
                if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(t)) {
                    errors.push('theme_config.systemTitle 不能包含控制字符或换行')
                    continue
                }
                normalized.theme_config.systemTitle = t  // 规整为 trim 后的字符串
                continue
            }
            if (/color/i.test(k) && typeof v === 'string' && v && !HEX_COLOR_RE.test(v)) {
                errors.push(`theme_config.${k} 必须为 #RRGGBB 格式`)
            }
            if (/logo/i.test(k) && typeof v === 'string' && v && !isSafeLogoUrl(v)) {
                errors.push(`theme_config.${k} 必须为 http(s) 或 data:image/(png|jpeg|gif|webp) URL（禁止 SVG）`)
            }
        }
        // 登录页样式（theme_config.login）独立校验：背景色/图片 URL 安全、卡片尺寸合理
        const ls = normalized.theme_config.login
        if (ls && typeof ls === 'object') {
            if (ls.background && typeof ls.background === 'object') {
                const bg = ls.background
                if (bg.color && typeof bg.color === 'string' && bg.color && !HEX_COLOR_RE.test(bg.color)) {
                    errors.push('theme_config.login.background.color 必须为 #RRGGBB 格式')
                }
                if (bg.imageUrl && typeof bg.imageUrl === 'string' && bg.imageUrl && !isSafeLogoUrl(bg.imageUrl)) {
                    errors.push('theme_config.login.background.imageUrl 必须为 http(s) 或 data:image/(png|jpeg|gif|webp) URL（禁止 SVG）')
                }
                if (bg.opacity !== undefined && (typeof bg.opacity !== 'number' || bg.opacity < 0 || bg.opacity > 1)) {
                    errors.push('theme_config.login.background.opacity 必须为 0~1 之间的数字')
                }
                if (bg.type !== undefined && !['aurora', 'solid', 'image', 'default'].includes(bg.type)) {
                    errors.push('theme_config.login.background.type 必须为 aurora/solid/image/default 之一')
                }
            }
            if (ls.card && typeof ls.card === 'object') {
                const card = ls.card
                if (card.width !== undefined && (typeof card.width !== 'number' || card.width < 280 || card.width > 720)) {
                    errors.push('theme_config.login.card.width 必须为 280~720 之间的数字（px）')
                }
                if (card.radius !== undefined && (typeof card.radius !== 'number' || card.radius < 0 || card.radius > 48)) {
                    errors.push('theme_config.login.card.radius 必须为 0~48 之间的数字（px）')
                }
                if (card.align !== undefined && !['left', 'center', 'right'].includes(card.align)) {
                    errors.push('theme_config.login.card.align 必须为 left/center/right 之一')
                }
            }
            if (ls.branding && typeof ls.branding === 'object') {
                const bd = ls.branding
                if (bd.title !== undefined && typeof bd.title !== 'string') errors.push('theme_config.login.branding.title 必须为字符串')
                if (bd.subtitle !== undefined && typeof bd.subtitle !== 'string') errors.push('theme_config.login.branding.subtitle 必须为字符串')
                if (bd.showLogo !== undefined && typeof bd.showLogo !== 'boolean') errors.push('theme_config.login.branding.showLogo 必须为布尔值')
                if (bd.logoUrl !== undefined && typeof bd.logoUrl !== 'string') errors.push('theme_config.login.branding.logoUrl 必须为字符串')
                if (bd.logoUrl && typeof bd.logoUrl === 'string' && !isSafeLogoUrl(bd.logoUrl)) {
                    errors.push('theme_config.login.branding.logoUrl 必须为 http(s) 或 data:image/(png|jpeg|gif|webp) URL（禁止 SVG）')
                }
            }
        }
    }

    // visible_types / test_types 元素合法性
    if (Array.isArray(normalized.visible_types)) {
        for (const t of normalized.visible_types) {
            if (typeof t !== 'string' || !TYPE_CODE_RE.test(t)) errors.push(`visible_types 含非法类型码: ${JSON.stringify(t)}`)
        }
    }
    // visible_menu_items 元素合法性（camelCase code，与 registry.js MENU_ITEMS 对齐）
    if (Array.isArray(normalized.visible_menu_items)) {
        for (const c of normalized.visible_menu_items) {
            if (typeof c !== 'string' || !MENU_CODE_RE.test(c)) errors.push(`visible_menu_items 含非法菜单码: ${JSON.stringify(c)}`)
        }
    }
    if (Array.isArray(normalized.test_types)) {
        const seen = new Set()
        for (const t of normalized.test_types) {
            if (!t || typeof t !== 'object' || typeof t.code !== 'string' || !TYPE_CODE_RE.test(t.code)) {
                errors.push('test_types 每项必须含合法 code（字母开头，字母/数字/_/-）')
                continue
            }
            if (seen.has(t.code)) errors.push(`test_types 类型码重复: ${t.code}`)
            seen.add(t.code)
            if (t.name !== undefined && (typeof t.name !== 'string' || t.name.length > 100)) errors.push(`test_types.${t.code}.name 需为 ≤100 字符的字符串`)
            if (t.fields !== undefined && !Array.isArray(t.fields)) errors.push(`test_types.${t.code}.fields 必须是数组`)
            if (Array.isArray(t.fields)) validateCustomFieldList(t.fields, `test_types.${t.code}.fields`, errors)
        }
    }

    // custom_fields: { 模块code: [字段定义...] }
    if (normalized.custom_fields && typeof normalized.custom_fields === 'object') {
        for (const [moduleCode, list] of Object.entries(normalized.custom_fields)) {
            if (!TYPE_CODE_RE.test(moduleCode)) { errors.push(`custom_fields 模块码非法: ${moduleCode}`); continue }
            if (!Array.isArray(list)) { errors.push(`custom_fields.${moduleCode} 必须是数组`); continue }
            validateCustomFieldList(list, `custom_fields.${moduleCode}`, errors)
        }
    }

    return { valid: errors.length === 0, errors, normalized }
}

// RK11: 自定义字段定义列表校验（name 白名单 / type 白名单 / 同域 name 唯一）
function validateCustomFieldList(list, ctx, errors) {
    const names = new Set()
    for (const f of list) {
        if (!f || typeof f !== 'object') { errors.push(`${ctx} 含非法字段定义`); continue }
        if (typeof f.name !== 'string' || !CUSTOM_FIELD_NAME_RE.test(f.name) || DANGEROUS_KEYS.has(f.name)) {
            errors.push(`${ctx} 字段名非法: ${JSON.stringify(f.name)}（须字母开头，≤64 位字母/数字/_）`)
            continue
        }
        if (names.has(f.name)) errors.push(`${ctx} 字段名重复: ${f.name}`)
        names.add(f.name)
        if (f.label !== undefined && (typeof f.label !== 'string' || f.label.length > 100)) errors.push(`${ctx}.${f.name}.label 需为 ≤100 字符字符串`)
        if (f.type !== undefined && !CUSTOM_FIELD_TYPES.has(f.type)) errors.push(`${ctx}.${f.name}.type 非法（允许: ${[...CUSTOM_FIELD_TYPES].join('/')}）`)
        if (f.options !== undefined && !Array.isArray(f.options)) errors.push(`${ctx}.${f.name}.options 必须是数组`)
    }
}

function buildRecordPayload(record) {
    // D-06: 展开前净化，防止 __proto__ 等键随响应传播到前端造成原型链污染
    const sampleInfo = sanitizeObjectKeys(safeParseJson(record.sample_info, {}))
    const resultData = sanitizeObjectKeys(safeParseJson(record.result_data, {}))

    return {
        id: record.id,
        record_code: record.record_code,
        test_type: record.test_type,
        test_name: record.test_name,
        status: record.status,
        version: record.version || 0,
        created_at: record.created_at,
        updated_at: record.updated_at,
        ...sampleInfo,
        ...resultData
    }
}

function buildRecordWriteData(tableName, payload) {
    // D-06: 写库前净化用户可控 JSON 键
    const baseData = sanitizeObjectKeys({ ...payload })
    delete baseData.id
    delete baseData._status

    const testDate = baseData.testDate || null
    const canteen = baseData.canteen || null
    const inspector = baseData.inspector || null

    return {
        test_type: tableName,
        test_name: TEST_TYPE_LABELS[tableName] || tableName,
        sample_info: JSON.stringify({
            testDate,
            canteen,
            inspector
        }),
        result_data: JSON.stringify(baseData),
        status: baseData.status || 'completed'
    }
}

// P2-07: 记录字段 Schema 验证 — 校验 testDate/canteen/inspector 必填且为非空字符串
function validateRecordPayload(tableName, payload) {
    const errors = []
    const requiredFields = ['testDate', 'canteen', 'inspector']
    for (const field of requiredFields) {
        const val = payload[field]
        if (val === undefined || val === null || String(val).trim() === '') {
            errors.push(`字段 "${field}" 不能为空`)
        }
    }
    if (!RECORD_ROUTE_TYPES.has(tableName)) {
        errors.push(`未知的记录类型: ${tableName}`)
    }
    return { valid: errors.length === 0, errors }
}

// P2-02: 审计日志写入辅助函数 — 记录 CRUD 操作到数据库（db 为请求级租户客户端）
// 委派给统一审计门面（TD-P2-13），保持原 7 参签名以最小改动调用方。
async function writeRecordAuditLog(db, userId, action, resourceType, resourceId, details, ip) {
    try {
        await writeTenantAuditLog(db, { actorId: userId, action, resourceType, resourceId, details, ip })
    } catch (e) {
        console.error('❌ 审计日志写入失败:', e.message)
    }
}

function normalizeForHash(value) {
    if (Array.isArray(value)) {
        const normalizedItems = value.map(item => normalizeForHash(item))
        // Use order-insensitive array normalization so semantically identical
        // payloads with different item order still map to the same record code.
        return normalizedItems.sort((a, b) => {
            const left = JSON.stringify(a)
            const right = JSON.stringify(b)
            return left.localeCompare(right)
        })
    }

    if (value && typeof value === 'object') {
        const sorted = {}
        Object.keys(value).sort().forEach(key => {
            sorted[key] = normalizeForHash(value[key])
        })
        return sorted
    }

    return value
}

function stripVolatileFields(value) {
    const volatileKeys = new Set([
        'id',
        '_status',
        'status',
        'record_code',
        'created_at',
        'updated_at',
        'createdAt',
        'updatedAt',
        'sync_time',
        'last_sync_at',
        'modificationLogs',
        'recheckRecords',
        'recheckReports',
        'importTime',
        'importUser',
        'lastModified'
    ])

    if (Array.isArray(value)) {
        return value.map(item => stripVolatileFields(item))
    }

    if (value && typeof value === 'object') {
        const clean = {}
        Object.keys(value).forEach(key => {
            if (volatileKeys.has(key)) return
            clean[key] = stripVolatileFields(value[key])
        })
        return clean
    }

    return value
}

function buildRecordHash(tableName, payload) {
    const sanitized = stripVolatileFields(payload || {})
    const normalized = normalizeForHash(sanitized)
    const raw = `${tableName}::${JSON.stringify(normalized)}`
    return crypto.createHash('sha256').update(raw).digest('hex')
}

function buildDeterministicRecordCode(tableName, payload) {
    const hash = buildRecordHash(tableName, payload)
    return `RC-${tableName}-${hash}`
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

// Middleware: Require Editor or Above（P0-09）
function requireEditorOrAbove(req, res, next) {
    const role = req.user?.role ?? req.userRole
    if (!role || role === 'guest' || role === 'viewer') {
        return res.status(403).json({
            error: '❌ 访客无写入权限，请以正式账号登录后操作'
        })
    }
    next()
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
app.use(express.json({ limit: process.env.BODY_LIMIT || '8mb' }))

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

// Idempotency middleware for records API (helps avoid duplicate writes on retry)
app.use('/api/records', idempotencyMiddleware)

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

// ====== School Config（外观 / 字段个性化，直连 public 系统表，不受 search_path 影响）======
app.get('/api/school/config', authenticateUser, async (req, res) => {
    try {
        const code = req.user?.schoolCode || ''
        // 系统表位于 public，使用显式 schema 前缀，确保不依赖 search_path
        const schoolRows = await prisma.$queryRawUnsafe(
            `SELECT "code","name","short_name","theme_color","logo_url","status" FROM public."School" WHERE "code" = $1 LIMIT 1`,
            code
        )
        const customRows = await prisma.$queryRawUnsafe(
            `SELECT "visible_types","visible_menu_items","canteens","field_labels","hidden_fields","theme_config","field_rules","field_options","field_order","custom_fields","test_types","field_types","updated_at" FROM public."SchoolCustomization" WHERE "school_code" = $1 LIMIT 1`,
            code
        )
        const school = schoolRows?.[0] || null
        const customization = customRows?.[0] || null
        // 字段级联配置（FieldOption 表）：合并进 customization 返回（录入端经缓存统一消费）；
        // 租户表未 provision / code 为空时优雅降级为空对象
        if (customization && code) {
            try {
                customization.field_cascade = await buildFieldCascade(createTenantClient(prisma, code))
                customization.field_options = sanitizeFieldOptionsForClient(customization.field_options)
            } catch (_) { /* 表尚未创建时忽略 */ }
        }
        res.json({
            success: true,
            data: {
                schoolCode: code,
                school,
                customization
            }
        })
    } catch (error) {
        // 表尚未创建（如未执行迁移）时优雅降级，返回空配置而非 500
        res.json({
            success: true,
            data: { schoolCode: req.user?.schoolCode || '', school: null, customization: null },
            note: 'school tables not provisioned yet'
        })
    }
})

// ====== School 个性化配置（登录前公开查询，方案A 访问层）======
// 在用户登录前即可按 schoolCode 返回 Logo / 主题色 / 字段定制，实现登录页个性化。
// schoolCode 来自 URL 路径前缀（前端 extractSchoolCode），系统表位于 public。
// DS-04: 公开端点加限速（同 IP 每分钟 ≤ 60 次），防枚举/刷接口
// RK22 说明：返回字段均为前端渲染/录入校验所需（schoolCustomization.js 消费
// visible_types/field_labels/hidden_fields/theme_config/field_rules；Wave2 起消费
// field_options/field_order/custom_fields/test_types），无可剔除的内部字段。
app.get('/api/schools/:schoolCode/config', rateLimit(60, 60 * 1000), async (req, res) => {
    try {
        const code = req.params.schoolCode
        if (!isValidSchoolCode(code)) {
            return res.status(400).json({ error: '非法学校代码' })
        }
        const schoolRows = await prisma.$queryRawUnsafe(
            `SELECT "code","name","short_name","theme_color","logo_url","status" FROM public."School" WHERE "code" = $1 LIMIT 1`,
            code
        )
        const customRows = await prisma.$queryRawUnsafe(
            `SELECT "visible_types","visible_menu_items","canteens","field_labels","hidden_fields","theme_config","field_rules","field_options","field_order","custom_fields","test_types","field_types","updated_at" FROM public."SchoolCustomization" WHERE "school_code" = $1 LIMIT 1`,
            code
        )
        const school = schoolRows?.[0] || null
        if (!school || school.status !== 'active') {
            return res.status(404).json({ error: '学校不存在或未激活' })
        }
        const customization = customRows?.[0] || null
        // 字段级联配置（FieldOption 表）：合并进 customization，供录入端下拉联动消费
        if (customization) {
            try {
                customization.field_cascade = await buildFieldCascade(createTenantClient(prisma, code))
                customization.field_options = sanitizeFieldOptionsForClient(customization.field_options)
            } catch (_) { /* 租户表未 provision 时忽略 */ }
        }
        res.json({
            success: true,
            data: {
                schoolCode: code,
                name: school.name,
                shortName: school.short_name,
                themeColor: school.theme_color,
                logoUrl: school.logo_url,
                updatedAt: school.updated_at || null,
                customization
            }
        })
    } catch (error) {
        res.status(500).json({ error: '查询学校配置失败' })
    }
})

// ====== School Management (超管：动态新增/列出学校，方案② 运行时建 schema) ======
// 仅 role=admin 且不属于任何具体学校（school_code 为空 = 平台超管，落在 public schema）可操作，
// 防止某校 admin 越权创建其它学校。系统表位于 public，直连全局 prisma。
function requirePlatformSuperAdmin(req, res, next) {
    const role = req.user?.role ?? req.userRole
    const schoolCode = req.user?.schoolCode || null
    if (role !== 'admin' || schoolCode) {
        return res.status(403).json({ error: '❌ 仅平台超级管理员（public/无学校归属的 admin）可管理学校' })
    }
    next()
}

// 列出所有学校
app.get('/api/admin/schools', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const rows = await prisma.$queryRawUnsafe(
            `SELECT "code","name","short_name","theme_color","logo_url","status","created_at"
             FROM public."School" ORDER BY "created_at" DESC`
        )
        res.json({ success: true, data: rows })
    } catch (error) {
        console.error('❌ Error listing schools:', error)
        res.status(500).json({ error: '获取学校列表失败' })
    }
})

// 动态新增学校（建 schema + 推表 + 系统记录 + 租户首个 manager 账号）
app.post('/api/admin/schools', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code, name, adminUsername, adminPassword } = req.body || {}
        if (!isValidSchoolCode(code)) {
            return res.status(400).json({ error: '❌ 非法学校代码（仅允许小写字母、数字、连字符，长度 1~40）' })
        }
        // 初始 manager 用户名：可选，默认 'manager'；提供时必须符合用户名规则
        if (adminUsername != null && adminUsername !== '' && !/^[a-zA-Z0-9_]{3,50}$/.test(String(adminUsername))) {
            return res.status(400).json({ error: '❌ 初始管理员用户名需为 3~50 位字母、数字或下划线' })
        }
        if (!adminPassword || String(adminPassword).length < 8) {
            return res.status(400).json({ error: '❌ 必须提供该校 manager 初始密码（至少 8 位）' })
        }

        const result = await provisionSchool({
            prisma,
            code,
            name,
            adminUsername: adminUsername || 'manager',
            adminPassword,
            log: (m) => console.log(`[provision:${code}] ${m}`)
        })

        // 字段选项种子（FieldOption 表）：新学校开通即带系统默认选项与级联
        try {
            await ensureFieldOptionSeeds(prisma, code, (m) => console.log(`[provision:${code}] ${m}`))
        } catch (e) {
            console.warn(`⚠️ 字段选项种子失败 ${code}:`, e.message)
        }

        res.json({
            success: true,
            message: `学校 ${code} 初始化完成`,
            data: result
        })
    } catch (error) {
        console.error('❌ Error provisioning school:', error)
        // P2: 学校代码已存在(provisionSchool 抛 status=409)返回 409,其余 500
        res.status(error.status || 500).json({ error: error.status === 409 ? error.message : '学校初始化失败' })
    }
})

// 更新学校基本信息（name/short_name/theme_color/logo_url）
app.put('/api/admin/schools/:code', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code } = req.params
        const { name, shortName, themeColor, logoUrl, logoStyle, systemTitle, canteens } = req.body || {}
        // RK8/DS-12: 主题色/Logo 服务器端校验
        if (themeColor != null && !HEX_COLOR_RE.test(themeColor)) {
            return res.status(400).json({ error: '主题色必须为 #RRGGBB 格式' })
        }
        if (logoUrl != null && logoUrl !== '' && !isSafeLogoUrl(logoUrl)) {
            return res.status(400).json({ error: 'Logo 必须为 http(s) 或 data:image/(png|jpeg|gif|webp) URL（禁止 SVG）' })
        }
        if (name != null && (typeof name !== 'string' || name.length > 100)) {
            return res.status(400).json({ error: '学校名称需为 ≤100 字符的字符串' })
        }
        if (shortName != null && (typeof shortName !== 'string' || shortName.length > 50)) {
            return res.status(400).json({ error: '学校简称需为 ≤50 字符的字符串' })
        }
        const exists = await prisma.$queryRawUnsafe(
            `SELECT 1 FROM public."School" WHERE "code" = $1`, code
        )
        if (!exists.length) return res.status(404).json({ error: '学校不存在' })
        const updated = await prisma.$queryRawUnsafe(
            `UPDATE public."School"
             SET "name" = COALESCE($2, "name"),
                 "short_name" = COALESCE($3, "short_name"),
                 "theme_color" = COALESCE($4, "theme_color"),
                 "logo_url" = COALESCE($5, "logo_url"),
                 "updated_at" = now()
             WHERE "code" = $1
             RETURNING "code","name","short_name","theme_color","logo_url","status"`,
            code, name ?? null, shortName ?? null, themeColor ?? null, logoUrl ?? null
        )
        // 校徽排版（logoStyle）与顶部状态栏标题（systemTitle）随基本信息一并保存：
        // 合并写入 SchoolCustomization.theme_config（logo_style / systemTitle），不影响其它定制。
        if (logoStyle !== undefined || systemTitle !== undefined) {
            if (logoStyle !== undefined && logoStyle !== null) {
                if (typeof logoStyle !== 'object' || Array.isArray(logoStyle)) {
                    return res.status(400).json({ error: 'logoStyle 必须为对象或 null' })
                }
                if (logoStyle.croppedUrl && !isSafeLogoUrl(logoStyle.croppedUrl)) {
                    return res.status(400).json({ error: 'logoStyle.croppedUrl 必须为 http(s) 或 data:image/(png|jpeg|gif|webp) URL（禁止 SVG）' })
                }
            }
            // 系统标题（顶部状态栏显示内容）基础校验：字符串、≤50 字符、禁止控制字符/换行
            if (systemTitle !== undefined && systemTitle !== null && typeof systemTitle !== 'string') {
                return res.status(400).json({ error: 'systemTitle 必须为字符串' })
            }
            await prisma.$queryRawUnsafe(
                `INSERT INTO public."SchoolCustomization" ("id","school_code","updated_at")
                 VALUES ($1,$2,now()) ON CONFLICT ("school_code") DO NOTHING`,
                crypto.randomUUID(), code
            )
            const tcRows = await prisma.$queryRawUnsafe(
                `SELECT "theme_config" FROM public."SchoolCustomization" WHERE "school_code" = $1 LIMIT 1`, code
            )
            let tc = {}
            try { tc = JSON.parse(tcRows?.[0]?.theme_config || '{}') } catch (_) {}
            if (logoStyle !== undefined) {
                if (logoStyle === null) delete tc.logo_style
                else tc.logo_style = logoStyle
            }
            if (systemTitle !== undefined) {
                const t = (typeof systemTitle === 'string') ? systemTitle.trim() : ''
                if (t === '') delete tc.systemTitle
                else if (t.length <= 50 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(t)) tc.systemTitle = t
            }
            await prisma.$queryRawUnsafe(
                `UPDATE public."SchoolCustomization" SET "theme_config" = $1, "updated_at" = now() WHERE "school_code" = $2`,
                JSON.stringify(tc), code
            )
        }
        // 学校食堂信息：写入 SchoolCustomization.canteens，并同步 field_options.canteen，
        // 使录入表单（tableware/pesticide/oil/leanMeat）的食堂下拉自动应用
        if (canteens !== undefined) {
            if (canteens !== null && (!Array.isArray(canteens) || canteens.some(c => typeof c !== 'string' || c.trim().length === 0))) {
                return res.status(400).json({ error: 'canteens 必须为非空字符串数组' })
            }
            const safeCanteens = Array.isArray(canteens) ? canteens.map(c => c.trim()).filter(Boolean) : []
            if (safeCanteens.length > 50) return res.status(400).json({ error: '食堂数量过多（≤50）' })
            await prisma.$queryRawUnsafe(
                `INSERT INTO public."SchoolCustomization" ("id","school_code","updated_at")
                 VALUES ($1,$2,now()) ON CONFLICT ("school_code") DO NOTHING`,
                crypto.randomUUID(), code
            )
            await prisma.$queryRawUnsafe(
                `UPDATE public."SchoolCustomization" SET "canteens" = $1, "updated_at" = now() WHERE "school_code" = $2`,
                JSON.stringify(safeCanteens), code
            )
            // 同步 field_options.canteen（让录入表单下拉自动应用）
            const foRows = await prisma.$queryRawUnsafe(
                `SELECT "field_options" FROM public."SchoolCustomization" WHERE "school_code" = $1 LIMIT 1`, code
            )
            let fo = {}
            try { fo = JSON.parse(foRows?.[0]?.field_options || '{}') } catch (_) { fo = {} }
            if (!fo || typeof fo !== 'object' || Array.isArray(fo)) fo = {}
            if (safeCanteens.length) fo.canteen = safeCanteens
            else delete fo.canteen
            await prisma.$queryRawUnsafe(
                `UPDATE public."SchoolCustomization" SET "field_options" = $1, "updated_at" = now() WHERE "school_code" = $2`,
                JSON.stringify(fo), code
            )
        }
        res.json({ success: true, data: updated[0] })
    } catch (error) {
        console.error('❌ Error updating school:', error)
        res.status(500).json({ error: '更新学校信息失败' })
    }
})

// 启用/停用学校
app.patch('/api/admin/schools/:code/status', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code } = req.params
        const { status } = req.body || {}
        if (!['active', 'disabled'].includes(status)) {
            return res.status(400).json({ error: '状态值无效（仅允许 active/disabled）' })
        }
        const updated = await prisma.$queryRawUnsafe(
            `UPDATE public."School" SET "status" = $2, "updated_at" = now()
             WHERE "code" = $1 RETURNING "code","name","status"`,
            code, status
        )
        if (!updated.length) return res.status(404).json({ error: '学校不存在' })
        res.json({ success: true, data: updated[0] })
    } catch (error) {
        res.status(500).json({ error: '更新学校状态失败' })
    }
})

// P1: 逻辑删除学校(软删除——仅置 disabled,不做物理删除,数据安全)
app.delete('/api/admin/schools/:code', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code } = req.params
        if (!isValidSchoolCode(code)) return res.status(400).json({ error: '非法学校代码' })
        const updated = await prisma.$queryRawUnsafe(
            `UPDATE public."School" SET "status" = 'disabled', "updated_at" = now()
             WHERE "code" = $1 AND "status" <> 'disabled'
             RETURNING "code","name","status"`,
            code
        )
        if (!updated.length) return res.status(404).json({ error: '学校不存在或已停用' })
        res.json({ success: true, message: `学校 ${code} 已停用（逻辑删除，数据保留）`, data: updated[0] })
    } catch (error) {
        console.error('❌ Error deleting school:', error)
        res.status(500).json({ error: '删除学校失败' })
    }
})

// 定制配置的全部 JSON 列（与 schema.prisma SchoolCustomization 对齐）
const CUSTOMIZATION_COLUMNS = [
    'visible_types', 'visible_menu_items', 'canteens', 'field_labels', 'hidden_fields', 'theme_config', 'field_rules',
    'field_options', 'field_order', 'custom_fields', 'test_types', 'field_types'
]

// 获取学校定制配置
app.get('/api/admin/schools/:code/customization', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code } = req.params
        const rows = await prisma.$queryRawUnsafe(
            `SELECT ${CUSTOMIZATION_COLUMNS.map(c => `"${c}"`).join(',')},"updated_at"
             FROM public."SchoolCustomization" WHERE "school_code" = $1 LIMIT 1`, code
        )
        // 级联配置（FieldOption 表）：合并进 data 一并返回，管理端级联编辑器据此渲染
        const data = rows[0] || null
        if (data) {
            try {
                data.field_cascade = await buildFieldCascade(createTenantClient(prisma, code))
                data.field_options = sanitizeFieldOptionsForClient(data.field_options)
            } catch (_) { /* 租户表未 provision 时忽略 */ }
        }
        res.json({ success: true, data })
    } catch (error) {
        res.status(500).json({ error: '获取定制配置失败' })
    }
})

// 更新学校定制配置
// 语义（BS-03）：body 中未出现的字段保持不变；显式传 null 的字段清空为 NULL；其余整体覆盖。
// 并发（BS-06）：body 可带 expected_updated_at（乐观锁），与 DB 当前 updated_at 不一致时返回 409。
app.put('/api/admin/schools/:code/customization', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code } = req.params
        const body = req.body || {}

        // RK8/RK10/RK11/RK12/DS-12/D-06: 服务器端校验 + 净化
        const { valid, errors, normalized } = validateCustomizationPayload(body)
        if (!valid) {
            return res.status(400).json({ error: '定制配置校验失败', details: errors })
        }

        // 确保 SchoolCustomization 记录存在
        await prisma.$queryRawUnsafe(
            `INSERT INTO public."SchoolCustomization" ("id","school_code","updated_at")
             VALUES ($1,$2,now()) ON CONFLICT ("school_code") DO NOTHING`,
            crypto.randomUUID(), code
        )

        // BS-06: 乐观锁（向后兼容——不传 expected_updated_at 时保持旧行为）
        if (Object.prototype.hasOwnProperty.call(body, 'expected_updated_at') && body.expected_updated_at) {
            const cur = await prisma.$queryRawUnsafe(
                `SELECT "updated_at" FROM public."SchoolCustomization" WHERE "school_code" = $1 LIMIT 1`, code
            )
            const currentUpdatedAt = cur?.[0]?.updated_at ? new Date(cur[0].updated_at).toISOString() : null
            const expected = new Date(body.expected_updated_at).toISOString()
            if (currentUpdatedAt && expected !== currentUpdatedAt) {
                return res.status(409).json({
                    error: 'conflict',
                    message: '定制配置已被其他人修改，请刷新后重试',
                    current_updated_at: currentUpdatedAt
                })
            }
        }

        // 动态拼 SET 子句：仅更新 body 中出现的字段（列名来自固定白名单，无注入面）
        const sets = []
        const params = [code]
        for (const col of CUSTOMIZATION_COLUMNS) {
            if (!Object.prototype.hasOwnProperty.call(normalized, col)) continue
            params.push(normalized[col] === null ? null : JSON.stringify(normalized[col]))
            sets.push(`"${col}" = $${params.length}`)
        }
        if (sets.length === 0) {
            return res.status(400).json({ error: '未提供任何可更新的定制字段' })
        }
        await prisma.$queryRawUnsafe(
            `UPDATE public."SchoolCustomization" SET ${sets.join(', ')}, "updated_at" = now()
             WHERE "school_code" = $1`,
            ...params
        )

        // BS-11: 审计（失败不阻断主流程）。
        // 第七轮收尾（事项一）：原为绕过门面的 SystemLog 裸写——context 用非 canonical 键
        // （actor 而非 actor_id），且 message 无 '[admin-audit]' 前缀，导致该记录无法被
        // 统一审计 UNION 查询（见 lib/auditLog.js 文件头）检索到。现改走统一门面
        // writeAdminOpsLog（平台超管对学校资源的管理操作，与删除租户用户同一入口）。
        try {
            await writeAdminOpsLog(prisma, {
                action: 'update_customization',
                level: 'info',
                actor: {
                    userId: req.user?.userId ?? null,
                    username: req.user?.username ?? null,
                    role: req.user?.role ?? null,
                    schoolCode: req.user?.schoolCode ?? null,
                    ip: req.ip ?? null
                },
                targetId: code,            // 受影响对象为学校定制配置（以学校 code 标识）
                targetSchoolCode: code,
                details: { changedFields: Object.keys(normalized) }
            })
        } catch (auditErr) {
            console.error('⚠️ customization audit log failed:', auditErr.message)
        }

        // REG-01/NB-18: 清除访客 visible_types 缓存，使新配置立即对访客生效
        try { clearGuestVisibleTypesCache(code) } catch (e) { console.warn('⚠️ clearGuestVisibleTypesCache failed:', e.message) }

        const after = await prisma.$queryRawUnsafe(
            `SELECT "updated_at" FROM public."SchoolCustomization" WHERE "school_code" = $1 LIMIT 1`, code
        )
        res.json({ success: true, message: '定制配置已更新', updated_at: after?.[0]?.updated_at ?? null })
    } catch (error) {
        console.error('❌ Error updating customization:', error)
        res.status(500).json({ error: '更新定制配置失败' })
    }
})

// ====== 字段选项（FieldOption 表）：动态表单级联配置，平台超管专属 ======
// 数据落在租户 schema（school_<code>）的 FieldOption 表，经 createTenantClient 路由。
// 历史检测记录存文本快照，故选项增删不影响历史展示；删除保护仅约束"有子选项的父选项"。
function assertFieldOptionCode(req, res) {
    const { code } = req.params
    if (!isValidSchoolCode(code)) {
        res.status(400).json({ error: '非法学校代码' })
        return null
    }
    return code
}
function recordFieldOptionAudit(req, code, action, details) {
    try {
        return writeAdminOpsLog(prisma, {
            action,
            level: 'info',
            actor: {
                userId: req.user?.userId ?? null,
                username: req.user?.username ?? null,
                role: req.user?.role ?? null,
                schoolCode: req.user?.schoolCode ?? null,
                ip: req.ip ?? null
            },
            targetId: code,
            targetSchoolCode: code,
            details
        })
    } catch (e) {
        console.error('⚠️ field-options audit log failed:', e.message)
        return Promise.resolve()
    }
}

// 1) 列出选项树（?module=&field= 可过滤；不传则返回全部级联字段）
app.get('/api/admin/schools/:code/field-options', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    const code = assertFieldOptionCode(req, res)
    if (!code) return
    try {
        const db = createTenantClient(prisma, code)
        const module = req.query.module || undefined
        const field = req.query.field || undefined
        const data = await listFieldOptions(db, { module, field })
        res.json({ success: true, data })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

// 2) 创建单条选项
app.post('/api/admin/schools/:code/field-options', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    const code = assertFieldOptionCode(req, res)
    if (!code) return
    try {
        const db = createTenantClient(prisma, code)
        const row = await createFieldOption(db, req.body || {})
        await recordFieldOptionAudit(req, code, 'create_field_option', {
            moduleCode: row.module_code, fieldCode: row.field_code, value: row.value, optionId: row.id
        })
        res.json({ success: true, data: row })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

// 3) 整树替换某 (module, field) 的选项（管理端"保存级联"调用）
app.put('/api/admin/schools/:code/field-options', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    const code = assertFieldOptionCode(req, res)
    if (!code) return
    try {
        const db = createTenantClient(prisma, code)
        const { module_code, field_code } = req.body || {}
        const result = await replaceFieldOptions(db, req.body || {})
        await recordFieldOptionAudit(req, code, 'replace_field_options', {
            moduleCode: module_code, fieldCode: field_code, created: result.created
        })
        res.json({ success: true, ...result })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

// 4) 更新单条选项
app.patch('/api/admin/schools/:code/field-options/:id', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    const code = assertFieldOptionCode(req, res)
    if (!code) return
    try {
        const db = createTenantClient(prisma, code)
        const row = await updateFieldOption(db, req.params.id, req.body || {})
        await recordFieldOptionAudit(req, code, 'update_field_option', {
            optionId: row.id, moduleCode: row.module_code, fieldCode: row.field_code, value: row.value
        })
        res.json({ success: true, data: row })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

// 5) 删除单条选项（有子选项时 400 拒绝——删除保护）
app.delete('/api/admin/schools/:code/field-options/:id', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    const code = assertFieldOptionCode(req, res)
    if (!code) return
    try {
        const db = createTenantClient(prisma, code)
        await deleteFieldOption(db, req.params.id)
        await recordFieldOptionAudit(req, code, 'delete_field_option', { optionId: req.params.id })
        res.json({ success: true })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

// 列出该校用户（跨 schema 查询）
app.get('/api/admin/schools/:code/users', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code } = req.params
        const schema = schemaNameOf(code)
        if (!schema) return res.status(400).json({ error: '无效的学校代码' })
        const tenantPrisma = createTenantClient(prisma, code)
        const users = await tenantPrisma.$queryRawUnsafe(
            `SELECT "id","username","role","status","created_at","last_login"
             FROM "${schema}"."User" ORDER BY "created_at" DESC`
        )
        res.json({ success: true, data: users })
    } catch (error) {
        const msg = error.message || String(error)
        // 学校尚未初始化（schema / User 表不存在）时返回空列表，而不是 500
        const missingTable =
            error.code === '42P01' ||
            error.code === 'P2021' ||
            /does not exist/i.test(msg)
        if (missingTable) {
            console.warn(`⚠️ 学校 ${code} 尚未初始化（缺 User 表），返回空列表`)
            return res.json({
                success: true,
                data: [],
                warning: `学校「${code}」尚未初始化，请点击「重新初始化」或检查 provision`
            })
        }
        console.error('❌ Error listing school users:', error)
        res.status(500).json({ error: '获取用户列表失败' })
    }
})

// 重新初始化某学校（幂等：补全 schema / 表结构 / 首个 manager）
app.post('/api/admin/schools/:code/reprovision', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code } = req.params
        if (!isValidSchoolCode(code)) return res.status(400).json({ error: '非法学校代码' })
        const schema = schemaNameOf(code)
        if (!schema) return res.status(400).json({ error: '无效的学校代码' })
        const adminPassword = req.body?.adminPassword || process.env.SEED_ADMIN_PASSWORD
        if (!adminPassword || String(adminPassword).length < 8) {
            return res.status(400).json({ error: '⚠️ 必须提供 adminPassword（至少 8 位）' })
        }
        const result = await provisionSchool({
            prisma,
            code,
            name: req.body?.name,
            adminPassword,
            allowExisting: true   // P2: reprovision 显式重建,允许 schema 已存在
        })
        // 字段选项种子（幂等：已有顶级选项的字段不会被覆盖）
        try {
            await ensureFieldOptionSeeds(prisma, code, () => {})
        } catch (e) {
            console.warn(`⚠️ 字段选项种子失败 ${code}:`, e.message)
        }
        res.json({ success: true, message: `学校「${code}」已重新初始化`, result })
    } catch (error) {
        console.error('❌ Error reprovisioning school:', error)
        res.status(500).json({ error: '重新初始化失败' })
    }
})

// 重置该校用户密码
app.post('/api/admin/schools/:code/users/:userId/reset-password', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code, userId } = req.params
        const { newPassword } = req.body || {}
        if (!newPassword || String(newPassword).length < 8) {
            return res.status(400).json({ error: '新密码至少 8 位' })
        }
        const schema = schemaNameOf(code)
        if (!schema) return res.status(400).json({ error: '无效的学校代码' })
        const hash = await bcryptjs.hash(newPassword, 10)
        const tenantPrisma = createTenantClient(prisma, code)
        const result = await tenantPrisma.$executeRawUnsafe(
            `UPDATE "${schema}"."User" SET "password_hash" = $2, "must_change_password" = true WHERE "id" = $1`,
            userId, hash
        )
        if (!result) return res.status(404).json({ error: '用户不存在' })
        res.json({ success: true, message: '密码已重置' })
    } catch (error) {
        console.error('❌ Error resetting password:', error)
        res.status(500).json({ error: '重置密码失败' })
    }
})

// 启用/停用该校用户
app.patch('/api/admin/schools/:code/users/:userId/status', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code, userId } = req.params
        const { status: newStatus } = req.body
        const schema = schemaNameOf(code)
        if (!schema) return res.status(400).json({ error: '无效的学校代码' })
        if (!['active', 'disabled'].includes(newStatus)) {
            return res.status(400).json({ error: '状态值无效（仅允许 active/disabled）' })
        }
        const tenantPrisma = createTenantClient(prisma, code)
        const result = await tenantPrisma.$executeRawUnsafe(
            `UPDATE "${schema}"."User" SET "status" = $2 WHERE "id" = $1`,
            userId, newStatus
        )
        if (!result) return res.status(404).json({ error: '用户不存在' })
        res.json({ success: true, message: `用户已${newStatus === 'active' ? '启用' : '停用'}` })
    } catch (error) {
        console.error('❌ Error updating user status:', error)
        res.status(500).json({ error: '更新用户状态失败' })
    }
})

// 学校用户可设置的角色（不含平台超管 admin）
const SCHOOL_USER_ROLES = ['manager', 'operator', 'viewer']
const isSchoolUserRole = (r) => SCHOOL_USER_ROLES.includes(r)
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/
const PHONE_RE = /^[0-9+\-\s]{5,20}$/

// 新增用户（平台超管为学校创建用户）
app.post('/api/admin/schools/:code/users', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code } = req.params
        const { username, full_name, phone, role, password } = req.body || {}
        const schema = schemaNameOf(code)
        if (!schema) return res.status(400).json({ error: '无效的学校代码' })
        if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: '用户名需为 3-32 位字母、数字或下划线' })
        if (!isSchoolUserRole(role)) return res.status(400).json({ error: '用户类别无效（不能为平台管理员 admin）' })
        if (!password || String(password).length < 8) return res.status(400).json({ error: '初始密码至少 8 位' })
        if (phone && !PHONE_RE.test(phone)) return res.status(400).json({ error: '手机号格式不正确' })
        const tenantPrisma = createTenantClient(prisma, code)
        const exist = await tenantPrisma.$queryRawUnsafe(
            `SELECT "id" FROM "${schema}"."User" WHERE "username" = $1`, username
        )
        if (exist.length) return res.status(409).json({ error: '用户名已存在' })
        const hash = await bcryptjs.hash(String(password), 10)
        const id = crypto.randomUUID()
        await tenantPrisma.$executeRawUnsafe(
            `INSERT INTO "${schema}"."User" ("id","username","password_hash","role","full_name","phone","status","school_code","created_at","updated_at")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
            id, username, hash, role, full_name || null, phone || null, 'active', code
        )
        res.status(201).json({
            success: true,
            message: '用户创建成功',
            user: { id, username, role, full_name: full_name || null, phone: phone || null, status: 'active' }
        })
    } catch (error) {
        console.error('❌ Error creating user:', error)
        res.status(500).json({ error: '创建用户失败' })
    }
})

// 更新用户（姓名 / 手机号 / 类别 / 状态 / 可选重置密码）
app.put('/api/admin/schools/:code/users/:userId', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code, userId } = req.params
        const { full_name, phone, role, status, password } = req.body || {}
        const schema = schemaNameOf(code)
        if (!schema) return res.status(400).json({ error: '无效的学校代码' })
        const tenantPrisma = createTenantClient(prisma, code)
        const cur = await tenantPrisma.$queryRawUnsafe(
            `SELECT "id","role","status" FROM "${schema}"."User" WHERE "id" = $1`, userId
        )
        if (!cur.length) return res.status(404).json({ error: '用户不存在' })
        const current = cur[0]
        if (role !== undefined) {
            if (role === 'admin') return res.status(400).json({ error: '不能将学校用户设置为平台管理员' })
            if (!isSchoolUserRole(role)) return res.status(400).json({ error: '用户类别无效' })
        }
        if (phone !== undefined && phone && !PHONE_RE.test(phone)) return res.status(400).json({ error: '手机号格式不正确' })
        if (status !== undefined && !['active', 'disabled'].includes(status)) {
            return res.status(400).json({ error: '状态值无效（仅允许 active/disabled）' })
        }
        // 防止学校失去唯一可管理人员（仅剩一名在职主管时，禁止停用或降级）
        const becomingNonManager = (role !== undefined && role !== 'manager')
        const willDisable = (status === 'disabled')
        if ((becomingNonManager || willDisable) && current.role === 'manager' && current.status === 'active') {
            const cnt = await tenantPrisma.$queryRawUnsafe(
                `SELECT COUNT(*)::int AS c FROM "${schema}"."User" WHERE "role"='manager' AND "status"='active'`
            )
            if (Number(cnt[0].c) <= 1) return res.status(409).json({ error: '该校仅剩一名在职主管，无法停用或更改其类别' })
        }
        const sets = []
        const params = [userId]
        let i = 2
        if (full_name !== undefined) { sets.push(`"full_name"=$${i++}`); params.push(full_name || null) }
        if (phone !== undefined) { sets.push(`"phone"=$${i++}`); params.push(phone || null) }
        if (role !== undefined) { sets.push(`"role"=$${i++}`); params.push(role) }
        if (status !== undefined) { sets.push(`"status"=$${i++}`); params.push(status) }
        if (password) {
            if (String(password).length < 8) return res.status(400).json({ error: '密码至少 8 位' })
            const hash = await bcryptjs.hash(String(password), 10)
            sets.push(`"password_hash"=$${i++}`); params.push(hash)
        }
        if (!sets.length) return res.status(400).json({ error: '没有需要更新的字段' })
        sets.push(`"updated_at"=NOW()`)
        await tenantPrisma.$executeRawUnsafe(
            `UPDATE "${schema}"."User" SET ${sets.join(',')} WHERE "id" = $1`, ...params
        )
        res.json({ success: true, message: '用户更新成功' })
    } catch (error) {
        console.error('❌ Error updating user:', error)
        res.status(500).json({ error: '更新用户失败' })
    }
})

// 删除用户
app.delete('/api/admin/schools/:code/users/:userId', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { code, userId } = req.params
        const schema = schemaNameOf(code)
        if (!schema) return res.status(400).json({ error: '无效的学校代码' })
        const tenantPrisma = createTenantClient(prisma, code)
        const cur = await tenantPrisma.$queryRawUnsafe(
            `SELECT "id","username","role","status" FROM "${schema}"."User" WHERE "id" = $1`, userId
        )
        if (!cur.length) return res.status(404).json({ error: '用户不存在' })
        const current = cur[0]
        if (current.role === 'manager' && current.status === 'active') {
            const cnt = await tenantPrisma.$queryRawUnsafe(
                `SELECT COUNT(*)::int AS c FROM "${schema}"."User" WHERE "role"='manager' AND "status"='active'`
            )
            if (Number(cnt[0].c) <= 1) return res.status(409).json({ error: '该校仅剩一名在职主管，无法删除' })
        }
        await tenantPrisma.$executeRawUnsafe(`DELETE FROM "${schema}"."User" WHERE "id" = $1`, userId)
        // REG-4: 平台超管删除租户用户必须留痕。操作者无租户归属（school_code 为空），
        // 不能写租户 AuditLog（user_id 外键），统一经 writeAdminOpsLog 落 public.SystemLog。
        // 审计写入失败不回滚删除（与 logAdminAction 口径一致），但留服务端错误日志。
        try {
            await writeAdminOpsLog(prisma, {
                action: 'admin_delete_school_user',
                actor: {
                    userId: req.user?.userId ?? null,
                    username: req.user?.username ?? null,
                    role: req.user?.role ?? null,
                    schoolCode: req.user?.schoolCode ?? null,
                    ip: req.ip ?? null
                },
                targetId: userId,
                targetSchoolCode: code,
                details: {
                    targetUsername: current.username ?? null,
                    targetRole: current.role ?? null,
                    targetStatus: current.status ?? null
                }
            })
        } catch (auditError) {
            console.error(`❌ 审计写入失败 (admin_delete_school_user target=${userId}): ${auditError.message}`)
        }
        res.json({ success: true, message: '用户已删除' })
    } catch (error) {
        console.error('❌ Error deleting user:', error)
        res.status(500).json({ error: '删除用户失败' })
    }
})

// ====== User Authentication Routes ======
const userRoutes = createUserRoutes(userManager)
app.use('/api/user', userRoutes)

// ====== Audit Logs Routes ======
const auditRoutes = createAuditRoutes(userManager, prisma)
app.use('/api/audit-logs', auditRoutes)

// ====== Session Routes（TD-Session）======
const sessionRoutes = createSessionRoutes(userManager, prisma)
app.use('/api/session', sessionRoutes)

// ====== Guest Routes（TD-Guest 收口）======
const guestRoutes = createGuestRoutes(userManager, prisma, JWT_SECRET)
app.use('/api/guest', guestRoutes)
const guestExportRequestRoutes = createGuestExportRequestRoutes(userManager, prisma, JWT_SECRET)
app.use('/api/guest-export-request', guestExportRequestRoutes)

// ====== Sync Routes ======
const syncRoutes = createSyncRoutes(userManager, prisma)
app.use('/api/sync', syncRoutes)

// ====== Test Records API ======

// 创建测试记录
// CR-11: 写接口幂等中间件覆盖（与 /api/records 一致，避免重试导致重复写入）
app.use('/api/test-records', idempotencyMiddleware)

app.post('/api/test-records', authenticateUser, requireEditorOrAbove, async (req, res) => {
    try {
        const { test_type, test_name, sample_info, result_data } = req.body

        const recordCode = buildDeterministicRecordCode(test_type || 'generic', req.body)

        // P1-15: 前置幂等检查，重复提交返回已有记录（与 /api/records/:tableName 一致）
        const existing = await req.db.testRecord.findUnique({
            where: { record_code: recordCode }
        })

        if (existing) {
            return res.json({
                success: true,
                deduplicated: true,
                data: existing,
                message: '记录已存在，已按幂等策略返回现有数据'
            })
        }

        const record = await req.db.testRecord.create({
            data: {
                record_code: recordCode,
                test_type: test_type || 'generic',
                test_name,
                sample_info: JSON.stringify(sanitizeObjectKeys(sample_info || {})),
                result_data: JSON.stringify(sanitizeObjectKeys(result_data || {})),
                created_by: req.userId,
                status: 'pending'
            }
        })

        res.json({
            success: true,
            data: record,
            message: '测试记录创建成功'
        })
    } catch (error) {
        // P1-15: P2002 唯一约束冲突（并发重复写入）：按幂等策略返回已有记录
        if (error.code === 'P2002' || (error.message && error.message.includes('Unique constraint'))) {
            try {
                const existing = await req.db.testRecord.findUnique({
                    where: { record_code: buildDeterministicRecordCode(req.body?.test_type || 'generic', req.body || {}) }
                })
                if (existing) {
                    return res.json({ success: true, deduplicated: true, data: existing, message: '记录已存在（并发写入），已按幂等策略返回现有数据' })
                }
            } catch (fallbackErr) { console.warn('[warn] POST /api/test-records 幂等降级回查失败:', fallbackErr.message); }
        }
        // P1-15: P2003 外键约束失败（created_by 用户不存在）：返回 422 而非 500
        if (error.code === 'P2003' || (error.message && error.message.includes('Foreign key constraint'))) {
            console.error('❌ Foreign key constraint failed:', error.message, '\nuserId:', req.userId)
            return res.status(422).json({
                error: '关联用户不存在，请重新登录',
                code: 'INVALID_USER'
            })
        }
        console.error('❌ Error creating test record:', error)
        res.status(500).json({ error: '创建失败' })
    }
})

// 获取所有测试记录
// 越权修复：guest 令牌原可读取所有模块记录（含 pathogen）。现经 requireGuestReadOnly
// 注入 req.guestVisibleTypes（该校 visible_types ∩ 非 pathogen），在查询层强制过滤。
app.get('/api/test-records', authenticateUser, requireGuestReadOnly, async (req, res) => {
    try {
        const { limit = 100, offset = 0, test_type, status } = req.query

        const where = {}
        if (test_type) where.test_type = test_type
        if (status) where.status = status

        if (req.user?.role === 'guest') {
            const allowed = req.guestVisibleTypes || []
            if (test_type) {
                if (!allowed.includes(test_type)) {
                    return res.status(403).json({ error: '❌ 访客无权访问该检测模块' })
                }
            } else {
                where.test_type = { in: allowed }
            }
        }

        const safeLimit = Math.min(parseInt(limit) || 100, 500)
        const safeOffset = Math.max(0, parseInt(offset) || 0)

        const records = await req.db.testRecord.findMany({
            where,
            skip: safeOffset,
            take: safeLimit,
            orderBy: { created_at: 'desc' }
        })

        const total = await req.db.testRecord.count({ where })

        // DS3-M6: guest 可见全校汇总数据（统计看板需要），但 PII 字段做部分掩码
        const payloads = records.map(buildRecordPayload)
        res.json({
            success: true,
            data: req.user?.role === 'guest' ? payloads.map(p => maskGuestSensitiveFields(p)) : payloads,
            total,
            limit: safeLimit,
            offset: safeOffset
        })
    } catch (error) {
        console.error('❌ Error fetching test records:', error)
        res.status(500).json({
            error: '获取失败'
        })
    }
})

// ====== Legacy Frontend Compatibility: /api/records/:tableName ======

// 越权修复：guest 只能读取该校 visible_types 白名单模块（强制排除 pathogen），见 requireGuestReadOnly
app.get('/api/records/:tableName', authenticateUser, requireGuestReadOnly, async (req, res) => {
    try {
        const testType = normalizeRecordType(req.params.tableName)
        if (!testType) {
            return res.status(400).json({ error: `未知记录类型: ${req.params.tableName}` })
        }

        const { limit = 100, offset = 0, status } = req.query
        const safeLimit = Math.min(parseInt(limit) || 100, 500)
        const safeOffset = Math.max(0, parseInt(offset) || 0)
        const where = { test_type: testType }
        if (status) where.status = status

        const records = await req.db.testRecord.findMany({
            where,
            skip: safeOffset,
            take: safeLimit,
            orderBy: { created_at: 'desc' }
        })

        const total = await req.db.testRecord.count({ where })

        // DS3-M6: guest 读取记录列表时对 PII 字段脱敏（检测结果类字段保持可见）
        const payloads = records.map(buildRecordPayload)
        res.json({
            success: true,
            data: req.user?.role === 'guest' ? payloads.map(p => maskGuestSensitiveFields(p)) : payloads,
            total,
            limit: safeLimit,
            offset: safeOffset
        })
    } catch (error) {
        console.error('❌ Error fetching legacy records:', error)
        res.status(500).json({ error: '获取失败' })
    }
})

app.post('/api/records/:tableName', authenticateUser, requireEditorOrAbove, async (req, res) => {
    try {
        const testType = normalizeRecordType(req.params.tableName)
        if (!testType) {
            return res.status(400).json({ error: `未知记录类型: ${req.params.tableName}` })
        }

        console.log(`[POST /api/records/${req.params.tableName}] userId=${req.userId} (请求体不写入日志)`)

        const payload = req.body || {}

        // P2-07: 写入前进行字段 Schema 验证
        const validation = validateRecordPayload(testType, payload)
        if (!validation.valid) {
            return res.status(400).json({ error: '❌ 字段验证失败', details: validation.errors })
        }

        const writeData = buildRecordWriteData(testType, payload)
        const recordCode = buildDeterministicRecordCode(testType, payload)

        const existing = await req.db.testRecord.findUnique({
            where: { record_code: recordCode }
        })

        if (existing) {
            return res.json({
                success: true,
                deduplicated: true,
                data: buildRecordPayload(existing),
                message: '记录已存在，已按幂等策略返回现有数据'
            })
        }

        const record = await req.db.testRecord.create({
            data: {
                record_code: recordCode,
                created_by: req.userId,
                version: 1,
                ...writeData
            }
        })

        // P2-02: 记录创建操作写入审计日志
        await writeRecordAuditLog(req.db, req.userId, 'create', 'test_record', record.id, {
            test_type: testType,
            record_code: recordCode
        }, req.ip)

        res.json({
            success: true,
            data: buildRecordPayload(record),
            message: '记录创建成功'
        })
    } catch (error) {
        // P2002: 唯一约束冲突（并发重复写入）：按幂等策略返回已有记录
        if (error.code === 'P2002' || (error.message && error.message.includes('Unique constraint'))) {
            try {
                const existing = await req.db.testRecord.findUnique({ where: { record_code: buildDeterministicRecordCode(normalizeRecordType(req.params.tableName), req.body || {}) } })
                if (existing) {
                    return res.json({ success: true, deduplicated: true, data: buildRecordPayload(existing), message: '记录已存在（并发写入），已按幂等策略返回现有数据' })
                }
            } catch (_) { /* fallthrough */ }
        }
        // P2003: 外键约束失败（如 created_by 对应的用户不存在）：返回 422 而非 500
        if (error.code === 'P2003' || (error.message && error.message.includes('Foreign key constraint'))) {
            console.error('❌ Foreign key constraint failed:', error.message, '\nuserId:', req.userId)
            return res.status(422).json({
                error: '关联用户不存在，请重新登录',
                code: 'INVALID_USER'
            })
        }
        console.error('❌ Error creating legacy record:', error)
        res.status(500).json({ error: '创建失败', code: error.code || undefined })
    }
})

app.post('/api/records/:tableName/bulk-upsert', authenticateUser, requireEditorOrAbove, async (req, res) => {
    try {
        const testType = normalizeRecordType(req.params.tableName)
        if (!testType) {
            return res.status(404).json({ error: '记录类型不存在' })
        }

        const records = Array.isArray(req.body?.records) ? req.body.records : []
        if (records.length === 0) {
            return res.status(400).json({ error: 'records 不能为空' })
        }
        if (records.length > 2000) {
            return res.status(400).json({ error: '单次导入记录数不能超过 2000 条' })
        }

        const uniqueByCode = new Map()
        records.forEach(item => {
            const code = buildDeterministicRecordCode(testType, item || {})
            if (!uniqueByCode.has(code)) {
                uniqueByCode.set(code, item || {})
            }
        })

        let created = 0
        let updated = 0
        const failed = []

        for (const [recordCode, payload] of uniqueByCode.entries()) {
            try {
                const writeData = buildRecordWriteData(testType, payload)
                const existing = await req.db.testRecord.findUnique({
                    where: { record_code: recordCode }
                })

                if (existing) {
                    // DS3-C1（方案甲）: 批量导入命中已有记录时同样执行归属校验，
                    // operator 不得借 bulk-upsert 覆盖他人创建的记录（跳过该条，不中断批次）
                    if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
                        failed.push({
                            record_code: recordCode,
                            reason: '无权覆盖他人创建的记录（仅创建者本人或主管可修改）',
                            skipped: true
                        })
                        continue
                    }
                    // NB-25: bulk-upsert 默认"最后写入胜出"；客户端可传 expected_updated_at
                    // 做可选乐观锁校验（冲突时跳过该条而非中断整个批次）。
                    if (payload?.expected_updated_at) {
                        const expected = String(payload.expected_updated_at).trim()
                        const current = existing.updated_at instanceof Date
                            ? existing.updated_at.toISOString()
                            : String(existing.updated_at || '')
                        if (expected && current && expected !== current) {
                            failed.push({
                                record_code: recordCode,
                                reason: '乐观锁冲突：该记录已被其他人修改',
                                skipped: true
                            })
                            continue
                        }
                    }
                    await req.db.testRecord.update({
                        where: { id: existing.id },
                        data: {
                            ...writeData,
                            version: (existing.version || 0) + 1,
                        }
                    })
                    updated++
                } else {
                    await req.db.testRecord.create({
                        data: {
                            record_code: recordCode,
                            created_by: req.userId,
                            version: 1,
                            ...writeData
                        }
                    })
                    created++
                }
            } catch (error) {
                if (error.code !== 'P2002') {
                    failed.push({
                        record_code: recordCode,
                        reason: '写入失败',
                        code: error.code || undefined
                    })
                }
            }
        }

        // P2-02: 批量导入操作写入审计日志（补充：单条 CRUD 已覆盖，此处覆盖批量导入路径）
        if (created > 0 || updated > 0) {
            await writeRecordAuditLog(req.db, req.userId, 'import', 'test_record', null, {
                test_type: testType,
                total: records.length,
                unique: uniqueByCode.size,
                created,
                updated,
                failed: failed.length
            }, req.ip)
        }

        return res.json({
            success: true,
            message: '批量导入完成',
            data: {
                received: records.length,
                unique: uniqueByCode.size,
                created,
                updated,
                failed: failed.length,
                failedRecords: failed
            }
        })
    } catch (error) {
        console.error('❌ Error bulk upsert legacy records:', error)
        res.status(500).json({
            error: '批量导入失败'
        })
    }
})

app.put('/api/records/:tableName/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
    try {
        const testType = normalizeRecordType(req.params.tableName)
        if (!testType) {
            return res.status(404).json({ error: '记录类型不存在' })
        }

        const existing = await req.db.testRecord.findUnique({
            where: { id: req.params.id }
        })

        if (!existing || existing.test_type !== testType) {
            return res.status(404).json({ error: '记录不存在' })
        }

        // DS3-C1（方案甲）: operator 仅能修改自己创建的记录（created_by 匹配）；
        // manager/admin 保留全校监督权限；存量 created_by 为空的记录仅主管可改。
        if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
            return res.status(403).json({ error: '❌ 仅记录创建者本人或主管（manager）可修改该记录' })
        }

        // P2-07: 更新前进行字段 Schema 验证
        const updateValidation = validateRecordPayload(testType, req.body || {})
        if (!updateValidation.valid) {
            return res.status(400).json({ error: '❌ 字段验证失败', details: updateValidation.errors })
        }

        const writeData = buildRecordWriteData(testType, req.body || {})

        // 版本号乐观锁（如果客户端传了 version 字段）
        if (req.body && typeof req.body.version !== 'undefined' && req.body.version !== existing.version) {
            return res.status(409).json({
                error: '版本冲突，请获取最新数据后重试',
                serverVersion: existing.version,
                clientVersion: req.body.version
            })
        }

        // TD-OptimisticLock-Atomic: where 带上 version 做原子条件更新，
        // 防止两个并发 PUT 都通过上方应用层 version 比较后各自 +1 造成一次更新静默丢失。
        let record
        try {
            record = await req.db.testRecord.update({
                where: { id: req.params.id, version: existing.version },
                data: {
                    ...writeData,
                    version: (existing.version || 0) + 1
                }
            })
        } catch (e) {
            if (e?.code === 'P2025') {
                return res.status(409).json({ error: '版本冲突，请获取最新数据后重试', serverVersion: 'stale' })
            }
            throw e
        }

        // P2-02: 记录更新操作写入审计日志
        await writeRecordAuditLog(req.db, req.userId, 'update', 'test_record', record.id, {
            test_type: testType,
            version: (existing.version || 0) + 1
        }, req.ip)

        res.json({
            success: true,
            data: buildRecordPayload(record),
            message: '更新成功'
        })
    } catch (error) {
        console.error('❌ Error updating legacy record:', error)
        res.status(500).json({
            error: '更新失败'
        })
    }
})

app.delete('/api/records/:tableName/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
    try {
        const testType = normalizeRecordType(req.params.tableName)
        if (!testType) {
            return res.status(404).json({ error: '记录类型不存在' })
        }

        const existing = await req.db.testRecord.findUnique({
            where: { id: req.params.id }
        })

        if (!existing || existing.test_type !== testType) {
            return res.status(404).json({ error: '记录不存在' })
        }

        // DS3-C1（方案甲）: operator 仅能删除自己创建的记录；manager/admin 保留监督权限
        if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
            return res.status(403).json({ error: '❌ 仅记录创建者本人或主管（manager）可删除该记录' })
        }

        await req.db.testRecord.delete({
            where: { id: req.params.id }
        })

        // P2-02: 记录删除操作写入审计日志
        await writeRecordAuditLog(req.db, req.userId, 'delete', 'test_record', req.params.id, {
            test_type: testType,
            record_code: existing.record_code
        }, req.ip)

        res.json({
            success: true,
            message: '删除成功'
        })
    } catch (error) {
        console.error('❌ Error deleting legacy record:', error)
        res.status(500).json({
            error: '删除失败'
        })
    }
})

// 越权修复：详情端点与列表同口径，guest 仅可读白名单模块（排除 pathogen）
app.get('/api/records/:tableName/:id', authenticateUser, requireGuestReadOnly, async (req, res) => {
    try {
        const testType = normalizeRecordType(req.params.tableName)
        if (!testType) {
            return res.status(404).json({ error: '记录类型不存在' })
        }

        const existing = await req.db.testRecord.findUnique({
            where: { id: req.params.id }
        })

        if (!existing || existing.test_type !== testType) {
            return res.status(404).json({ error: '记录不存在' })
        }

        // DS3-M6: guest 读取详情时对 PII 字段脱敏
        const payload = buildRecordPayload(existing)
        res.json({
            success: true,
            data: req.user?.role === 'guest' ? maskGuestSensitiveFields(payload) : payload
        })
    } catch (error) {
        console.error('❌ Error getting legacy record by id:', error)
        res.status(500).json({
            error: '获取记录失败'
        })
    }
})

// 获取单个测试记录
// 越权修复：无 :tableName 参数，取回后按 req.guestVisibleTypes 校验 test_type
app.get('/api/test-records/:id', authenticateUser, requireGuestReadOnly, async (req, res) => {
    try {
        const { id } = req.params

        const record = await req.db.testRecord.findUnique({
            where: { id },
            include: {
                test_items: true,
                attachments: true,
                created_user: {
                    select: {
                        id: true,
                        username: true,
                        full_name: true
                    }
                }
            }
        })

        if (!record) {
            return res.status(404).json({ error: '记录不存在' })
        }

        if (req.user?.role === 'guest' && !(req.guestVisibleTypes || []).includes(record.test_type)) {
            return res.status(403).json({ error: '❌ 访客无权访问该检测模块' })
        }

        // DS3-M6: guest 读取详情时脱敏 —— sample_info/result_data 内嵌 PII、
        // created_user（username/full_name）、created_by 均做部分掩码，保持响应结构不变
        if (req.user?.role === 'guest') {
            const masked = maskGuestSensitiveFields({
                ...record,
                sample_info: sanitizeObjectKeys(safeParseJson(record.sample_info, {})),
                result_data: sanitizeObjectKeys(safeParseJson(record.result_data, {}))
            })
            masked.sample_info = JSON.stringify(masked.sample_info)
            masked.result_data = JSON.stringify(masked.result_data)
            return res.json({ success: true, data: masked })
        }

        res.json({
            success: true,
            data: record
        })
    } catch (error) {
        console.error('❌ Error fetching test record:', error)
        res.status(500).json({
            error: '获取失败'
        })
    }
})

// 更新测试记录
// NB-13: result_data 需经过 sanitizeObjectKeys 净化；status 白名单校验
const VALID_TEST_RECORD_STATUSES = new Set(['pending', 'completed', 'failed', 'archived'])

app.put('/api/test-records/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
    try {
        const { id } = req.params
        const { test_name, status, result_data } = req.body

        // DS3-C1（方案甲）: 与 /api/records/:tableName/:id 同口径的归属校验
        const existing = await req.db.testRecord.findUnique({ where: { id } })
        if (!existing) {
            return res.status(404).json({ error: '记录不存在' })
        }
        if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
            return res.status(403).json({ error: '❌ 仅记录创建者本人或主管（manager）可修改该记录' })
        }

        const updateData = {}
        if (test_name) updateData.test_name = test_name
        if (status) {
            if (!VALID_TEST_RECORD_STATUSES.has(status)) {
                return res.status(400).json({
                    error: `状态值无效（仅允许: ${[...VALID_TEST_RECORD_STATUSES].join('/')}）`
                })
            }
            updateData.status = status
        }
        if (result_data) {
            updateData.result_data = JSON.stringify(sanitizeObjectKeys(result_data))
        }

        const record = await req.db.testRecord.update({
            where: { id },
            data: updateData
        })

        res.json({
            success: true,
            data: record,
            message: '更新成功'
        })
    } catch (error) {
        console.error('❌ Error updating test record:', error)
        res.status(500).json({ error: '更新失败' })
    }
})

// 删除测试记录
app.delete('/api/test-records/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
    try {
        const { id } = req.params

        // DS3-C1（方案甲）: 归属校验（先查记录，顺带把原 P2025→500 修正为 404）
        const existing = await req.db.testRecord.findUnique({ where: { id } })
        if (!existing) {
            return res.status(404).json({ error: '记录不存在' })
        }
        if (!canModifyRecord({ role: req.user?.role, userId: req.userId }, existing)) {
            return res.status(403).json({ error: '❌ 仅记录创建者本人或主管（manager）可删除该记录' })
        }

        await req.db.testRecord.delete({
            where: { id }
        })

        // DS3-C1 交付要求: 删除操作必须产生审计记录（与 /api/records DELETE 同一调用约定）
        await writeRecordAuditLog(req.db, req.userId, 'delete', 'test_record', id, {
            test_type: existing.test_type,
            record_code: existing.record_code
        }, req.ip)

        res.json({
            success: true,
            message: '删除成功'
        })
    } catch (error) {
        console.error('❌ Error deleting test record:', error)
        res.status(500).json({
            error: '删除失败'
        })
    }
})

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
