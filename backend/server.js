import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath, URL } from 'url'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import UserManager from './modules/UserManager.js'
import { createUserRoutes } from './routes/userRoutes.js'
import { createAuditRoutes } from './routes/auditRoutes.js'
import { createValidationMiddleware, rateLimit, sanitizeText } from './middleware/validationMiddleware.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3001
const serveStatic = process.env.SERVE_STATIC === 'true'
const allowCorsWildcard = process.env.CORS_ORIGIN === '*'
const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-jwt-secret'

// Initialize Prisma Client
const prisma = new PrismaClient()

// Initialize UserManager with Prisma
const userManager = new UserManager(prisma, JWT_SECRET)

function parseAllowedOrigins() {
    if (!process.env.CORS_ORIGIN) {
        return [
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:8081',
            'http://localhost:5173',
            'http://127.0.0.1:5500'
        ]
    }

    return process.env.CORS_ORIGIN
        .split(',')
        .map(o => o.trim())
        .filter(Boolean)
}

function parseAllowedHostnames() {
    // Accept a comma-separated list of hostnames or hostname:port values from env.
    // Example: CORS_HOSTNAMES=159.75.106.179,127.0.0.1:3001
    const raw = process.env.CORS_HOSTNAMES || process.env.CORS_ADDITIONAL_HOSTS || ''
    return raw
        .split(',')
        .map(h => h.trim())
        .filter(Boolean)
}

// Middleware: Authenticate User
export function authenticateUser(req, res, next) {
    const authHeader = req.headers['authorization']
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' })
    }

    const token = authHeader.split(' ')[1]
    const verification = userManager.verifyToken(token)

    if (!verification.valid) {
        return res.status(401).json({ error: 'Invalid token', details: verification.error })
    }

    req.userId = verification.user.userId
    req.userRole = verification.user.role
    next()
}

// Security Middleware
app.use(rateLimit(100, 15 * 60 * 1000)) // 15分钟内最多100个请求

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

        return callback(new Error(`CORS: origin ${origin} not allowed`))
    },
    credentials: true
}))
app.use(express.json({ limit: '10mb' }))

// Optional static hosting for local convenience.
// Production Tencent Cloud deployment should use Nginx/COS for static files.
if (serveStatic) {
    app.use(express.static(path.join(__dirname, '../')))
}

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: '✅ API Server is running', timestamp: new Date() })
})

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date() })
})

// ====== User Authentication Routes ======
const userRoutes = createUserRoutes(userManager)
app.use('/api/user', userRoutes)

// ====== Audit Logs Routes ======
const auditRoutes = createAuditRoutes(prisma, JWT_SECRET)
app.use('/api/audit-logs', auditRoutes)

// ====== Test Records API ======

// 创建测试记录
app.post('/api/test-records', authenticateUser, async (req, res) => {
    try {
        const { test_type, test_name, sample_info, result_data } = req.body

        const record = await prisma.testRecord.create({
            data: {
                record_code: `REC-${Date.now()}`,
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

        const records = await prisma.testRecord.findMany({
            where,
            skip: parseInt(offset),
            take: parseInt(limit),
            orderBy: { created_at: 'desc' }
        })

        const total = await prisma.testRecord.count({ where })

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

// 获取单个测试记录
app.get('/api/test-records/:id', authenticateUser, async (req, res) => {
    try {
        const { id } = req.params

        const record = await prisma.testRecord.findUnique({
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
app.put('/api/test-records/:id', authenticateUser, async (req, res) => {
    try {
        const { id } = req.params
        const { test_name, status, result_data } = req.body

        const updateData = {}
        if (test_name) updateData.test_name = test_name
        if (status) updateData.status = status
        if (result_data) updateData.result_data = JSON.stringify(result_data)

        const record = await prisma.testRecord.update({
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
app.delete('/api/test-records/:id', authenticateUser, async (req, res) => {
    try {
        const { id } = req.params

        await prisma.testRecord.delete({
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
    console.log(`🗄️  Database: SQLite (Prisma)`)
    console.log(`📦 CORS Origins: ${allowCorsWildcard ? 'Allow All' : allowedOrigins.join(', ')}`)
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
