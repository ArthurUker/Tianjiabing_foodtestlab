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
import jwt from 'jsonwebtoken'
import UserManager from './modules/UserManager.js'
import { createUserRoutes } from './routes/userRoutes.js'
import { createAuditRoutes } from './routes/auditRoutes.js'
import { createValidationMiddleware, rateLimit, sanitizeText } from './middleware/validationMiddleware.js'
import idempotencyMiddleware from './middleware/idempotencyMiddleware.js'
import { createAuthMiddleware } from './middleware/authMiddleware.js'
import { createTenantMiddleware } from './middleware/tenantMiddleware.js'
import { createSyncRoutes } from './routes/syncRoutes.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3002
const serveStatic = process.env.SERVE_STATIC === 'true'
const allowCorsWildcard = process.env.CORS_ORIGIN === '*'
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
const { authenticateUser: _authUser, authorizeAdmin: _authAdmin, authorizeRoles } = createAuthMiddleware(userManager)

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

function safeParseJson(value, fallback) {
    if (!value) return fallback
    try {
        return JSON.parse(value)
    } catch {
        return fallback
    }
}

function buildRecordPayload(record) {
    const sampleInfo = safeParseJson(record.sample_info, {})
    const resultData = safeParseJson(record.result_data, {})

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
    const baseData = { ...payload }
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
async function writeRecordAuditLog(db, userId, action, resourceType, resourceId, details, ip) {
    try {
        await db.auditLog.create({
            data: {
                user_id: userId,
                action,
                resource_type: resourceType || null,
                resource_id: resourceId || null,
                details: details ? JSON.stringify(details) : null,
                ip_address: ip || null
            }
        })
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

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (curl, Postman, server-side)
        if (!origin) return callback(null, true)

        // Allow wildcard via env
        if (allowCorsWildcard) return callback(null, true)

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
app.use(express.json({ limit: '10mb' }))

// Idempotency middleware for records API (helps avoid duplicate writes on retry)
app.use('/api/records', idempotencyMiddleware)

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
            `SELECT "visible_types","field_labels","hidden_fields","theme_config","updated_at" FROM public."SchoolCustomization" WHERE "school_code" = $1 LIMIT 1`,
            code
        )
        const school = schoolRows?.[0] || null
        const customization = customRows?.[0] || null
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

// ====== User Authentication Routes ======
const userRoutes = createUserRoutes(userManager)
app.use('/api/user', userRoutes)

// ====== Guest Routes ======
// POST /api/guest/quick-access — P0-07 修复：无需凭证，签发只读限权 JWT（2h）
app.post('/api/guest/quick-access', async (req, res) => {
    try {
        const payload = {
            guestId: 0,
            username: '快速访问用户',
            guest_type: 'viewer',
            has_export_permission: false,
            is_quick_access: true,
            iat: Math.floor(Date.now() / 1000)
        }
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' })
        return res.json({
            success: true,
            token,
            guest: {
                id: 0,
                username: '快速访问用户',
                guest_type: 'viewer',
                has_export_permission: false,
                is_quick_access: true,
                status: 'active'
            }
        })
    } catch (err) {
        console.error('快速访问接口错误:', err)
        return res.status(500).json({ error: '快速访问失败' })
    }
})

// ====== Audit Logs Routes ======
const auditRoutes = createAuditRoutes(userManager)
app.use('/api/audit-logs', auditRoutes)

// ====== Sync Routes ======
const syncRoutes = createSyncRoutes(userManager)
app.use('/api/sync', syncRoutes)

// ====== Test Records API ======

// 创建测试记录
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
                sample_info: JSON.stringify(sample_info || {}),
                result_data: JSON.stringify(result_data || {}),
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
            } catch (_) { /* fallthrough */ }
        }
        // P1-15: P2003 外键约束失败（created_by 用户不存在）：返回 422 而非 500
        if (error.code === 'P2003' || (error.message && error.message.includes('Foreign key constraint'))) {
            console.error('❌ Foreign key constraint failed:', error.message, '\nuserId:', req.userId)
            return res.status(422).json({
                error: '关联用户不存在，请重新登录',
                details: error.message,
                code: 'INVALID_USER'
            })
        }
        console.error('❌ Error creating test record:', error)
        res.status(500).json({
            error: '创建失败',
            details: error.message
        })
    }
})

// 获取所有测试记录
app.get('/api/test-records', authenticateUser, async (req, res) => {
    try {
        const { limit = 100, offset = 0, test_type, status } = req.query

        const where = {}
        if (test_type) where.test_type = test_type
        if (status) where.status = status

        const records = await req.db.testRecord.findMany({
            where,
            skip: parseInt(offset),
            take: parseInt(limit),
            orderBy: { created_at: 'desc' }
        })

        const total = await req.db.testRecord.count({ where })

        res.json({
            success: true,
            data: records,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        })
    } catch (error) {
        console.error('❌ Error fetching test records:', error)
        res.status(500).json({
            error: '获取失败',
            details: error.message
        })
    }
})

// ====== Legacy Frontend Compatibility: /api/records/:tableName ======

app.get('/api/records/:tableName', authenticateUser, async (req, res) => {
    try {
        const testType = normalizeRecordType(req.params.tableName)
        if (!testType) {
            return res.status(400).json({ error: `未知记录类型: ${req.params.tableName}` })
        }

        const { limit = 100, offset = 0, status } = req.query
        const where = { test_type: testType }
        if (status) where.status = status

        const records = await req.db.testRecord.findMany({
            where,
            skip: parseInt(offset),
            take: parseInt(limit),
            orderBy: { created_at: 'desc' }
        })

        const total = await req.db.testRecord.count({ where })

        res.json({
            success: true,
            data: records.map(buildRecordPayload),
            total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        })
    } catch (error) {
        console.error('❌ Error fetching legacy records:', error)
        res.status(500).json({
            error: '获取失败',
            details: error.message
        })
    }
})

app.post('/api/records/:tableName', authenticateUser, requireEditorOrAbove, async (req, res) => {
    try {
        const testType = normalizeRecordType(req.params.tableName)
        if (!testType) {
            return res.status(400).json({ error: `未知记录类型: ${req.params.tableName}` })
        }

        console.log(`[POST /api/records/${req.params.tableName}] userId=${req.userId} body=`, JSON.stringify(req.body || {}).slice(0, 200))

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
                details: error.message,
                code: 'INVALID_USER'
            })
        }
        console.error('❌ Error creating legacy record:', error.message, '\nCode:', error.code, '\nStack:', error.stack)
        res.status(500).json({
            error: '创建失败',
            details: error.message,
            code: error.code || undefined
        })
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
                failed.push({
                    record_code: recordCode,
                    message: error.message
                })
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
            error: '批量导入失败',
            details: error.message
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

        const record = await req.db.testRecord.update({
            where: { id: req.params.id },
            data: {
                ...writeData,
                version: (existing.version || 0) + 1
            }
        })

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
            error: '更新失败',
            details: error.message
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
            error: '删除失败',
            details: error.message
        })
    }
})

app.get('/api/records/:tableName/:id', authenticateUser, async (req, res) => {
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

        res.json({
            success: true,
            data: buildRecordPayload(existing)
        })
    } catch (error) {
        console.error('❌ Error getting legacy record by id:', error)
        res.status(500).json({
            error: '获取记录失败',
            details: error.message
        })
    }
})

// 获取单个测试记录
app.get('/api/test-records/:id', authenticateUser, async (req, res) => {
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

        res.json({
            success: true,
            data: record
        })
    } catch (error) {
        console.error('❌ Error fetching test record:', error)
        res.status(500).json({
            error: '获取失败',
            details: error.message
        })
    }
})

// 更新测试记录
app.put('/api/test-records/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
    try {
        const { id } = req.params
        const { test_name, status, result_data } = req.body

        const updateData = {}
        if (test_name) updateData.test_name = test_name
        if (status) updateData.status = status
        if (result_data) updateData.result_data = JSON.stringify(result_data)

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
        res.status(500).json({
            error: '更新失败',
            details: error.message
        })
    }
})

// 删除测试记录
app.delete('/api/test-records/:id', authenticateUser, requireEditorOrAbove, async (req, res) => {
    try {
        const { id } = req.params

        await req.db.testRecord.delete({
            where: { id }
        })

        res.json({
            success: true,
            message: '删除成功'
        })
    } catch (error) {
        console.error('❌ Error deleting test record:', error)
        res.status(500).json({
            error: '删除失败',
            details: error.message
        })
    }
})

// ====== User Management (Admin Only) ======

// 获取所有用户
app.get('/api/users', authenticateUser, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ error: 'Only admins can access this' })
        }

        const users = await userManager.getUserList(100, 0)
        res.json(users)
    } catch (error) {
        console.error('❌ Error fetching users:', error)
        res.status(500).json({
            error: '获取失败',
            details: error.message
        })
    }
})

// 禁用用户
app.post('/api/users/:userId/disable', authenticateUser, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ error: 'Only admins can access this' })
        }

        const result = await userManager.disableUser(req.params.userId)
        res.json(result)
    } catch (error) {
        console.error('❌ Error disabling user:', error)
        res.status(500).json({
            error: '禁用失败',
            details: error.message
        })
    }
})

// 启用用户
app.post('/api/users/:userId/enable', authenticateUser, async (req, res) => {
    try {
        if (req.userRole !== 'admin') {
            return res.status(403).json({ error: 'Only admins can access this' })
        }

        const result = await userManager.enableUser(req.params.userId)
        res.json(result)
    } catch (error) {
        console.error('❌ Error enabling user:', error)
        res.status(500).json({
            error: '启用失败',
            details: error.message
        })
    }
})

// ====== Error Handling ======

app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err)
    res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
    })
})

// ====== Start Server ======

const server = app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`🚀 Food Safety Testing Lab API Server Started`)
    console.log(`${'='.repeat(60)}`)
    console.log(`📍 Server running on: http://localhost:${PORT}`)
    console.log(`📍 API Endpoints: http://localhost:${PORT}/api`)
    console.log(`🔐 JWT Secret configured: ${JWT_SECRET ? '✅' : '❌ MISSING'}`)
    console.log(`🗄️  Database: PostgreSQL (Prisma, Schema-per-tenant)`)
    console.log(`📦 CORS Origins: ${allowCorsWildcard ? 'Allow All' : allowedOrigins.join(', ')}`)
    console.log(`📦 CORS Hostnames: ${allowedHostnames.length ? allowedHostnames.join(', ') : '(none)'}`)
    console.log(`${'='.repeat(60)}\n`)
})

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('📌 SIGTERM signal received: closing HTTP server')
    server.close(async () => {
        await prisma.$disconnect()
        process.exit(0)
    })
})

process.on('SIGINT', async () => {
    console.log('📌 SIGINT signal received: closing HTTP server')
    server.close(async () => {
        await prisma.$disconnect()
        process.exit(0)
    })
})

export { app, prisma, userManager }
