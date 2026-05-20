import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import jwt from 'jsonwebtoken'
import { createUserRoutes } from './routes/userRoutes.js'
import { createAuditRoutes } from './routes/auditRoutes.js'
import { createValidationMiddleware, rateLimit, sanitizeText } from './middleware/validationMiddleware.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000
const serveStatic = process.env.SERVE_STATIC === 'true'
const allowCorsWildcard = process.env.CORS_ORIGIN === '*'

function parseAllowedOrigins() {
    if (!process.env.CORS_ORIGIN) {
        return [
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:5173',
            'http://127.0.0.1:5500'
        ]
    }

    return process.env.CORS_ORIGIN
        .split(',')
        .map(o => o.trim())
        .filter(Boolean)
}

// Supabase Client (Backend Only - Keys Protected)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
)

// Security Middleware
app.use(rateLimit(100, 15 * 60 * 1000)) // 15分钟内最多100个请求

const allowedOrigins = parseAllowedOrigins()

app.use(cors({
    origin: (origin, callback) => {
        // 允许无 origin 的请求（如 curl、Postman）
        if (!origin) return callback(null, true);
        if (allowCorsWildcard || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error(`CORS: origin ${origin} not allowed`));
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
const userRoutes = createUserRoutes(supabase, process.env.JWT_SECRET)
app.use('/api/user', userRoutes)

// ====== Audit Logs Routes ======
const auditRoutes = createAuditRoutes(supabase, process.env.JWT_SECRET)
app.use('/api/audit-logs', auditRoutes)

// ====== API Routes ======

// 1. 获取所有检测记录
app.get('/api/records/:type', authenticateUser, async (req, res) => {
    try {
        const { type } = req.params
        const { limit = 100, offset = 0 } = req.query
        
        const { data, error, count } = await supabase
            .from(type)
            .select('*', { count: 'exact' })
            .range(offset, offset + limit - 1)
            .order('id', { ascending: false })
        
        if (error) {
            console.error('❌ Database error:', error)
            return res.status(400).json({ error: error.message })
        }
        
        res.json({
            success: true,
            data,
            total: count,
            limit,
            offset
        })
    } catch (error) {
        console.error('❌ Server error:', error)
        res.status(500).json({ error: error.message })
    }
})

// 2. 获取单条记录
app.get('/api/records/:type/:id', authenticateUser, async (req, res) => {
    try {
        const { type, id } = req.params
        
        const { data, error } = await supabase
            .from(type)
            .select('*')
            .eq('id', id)
            .single()
        
        if (error) {
            return res.status(404).json({ error: '记录不存在' })
        }
        
        res.json({ success: true, data })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// 3. 创建新记录
app.post('/api/records/:type', authenticateUser, async (req, res) => {
    try {
        const { type } = req.params
        const payload = {
            ...req.body,
            created_by: req.user.userId,
            created_at: new Date().toISOString()
        }
        
        // 输入验证
        const validation = validateInput(payload)
        if (validation.errors) {
            return res.status(400).json({ error: '数据验证失败', errors: validation.errors })
        }
        
        const { data, error } = await supabase
            .from(type)
            .insert([payload])
            .select()
        
        if (error) {
            console.error('❌ Insert error:', error)
            return res.status(400).json({ error: error.message })
        }
        
        // 记录操作日志
        logOperation(req.user.userId, 'CREATE', type, data[0].id)
        
        res.status(201).json({
            success: true,
            message: '✅ 记录已创建',
            data: data[0]
        })
    } catch (error) {
        console.error('❌ Server error:', error)
        res.status(500).json({ error: error.message })
    }
})

// 4. 更新记录
app.put('/api/records/:type/:id', authenticateUser, async (req, res) => {
    try {
        const { type, id } = req.params
        const payload = {
            ...req.body,
            updated_by: req.user.userId,
            updated_at: new Date().toISOString()
        }
        
        // 验证权限（用户只能编辑自己创建的记录）
        const existing = await supabase
            .from(type)
            .select('created_by')
            .eq('id', id)
            .single()
        
        if (existing.data?.created_by !== req.user.userId && req.user.role !== 'admin') {
            return res.status(403).json({ error: '无权编辑此记录' })
        }
        
        const { data, error } = await supabase
            .from(type)
            .update(payload)
            .eq('id', id)
            .select()
        
        if (error) {
            return res.status(400).json({ error: error.message })
        }
        
        logOperation(req.user.userId, 'UPDATE', type, id)
        
        res.json({
            success: true,
            message: '✅ 记录已更新',
            data: data[0]
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// 5. 删除记录
app.delete('/api/records/:type/:id', authenticateUser, async (req, res) => {
    try {
        const { type, id } = req.params
        
        // 验证权限
        const existing = await supabase
            .from(type)
            .select('created_by')
            .eq('id', id)
            .single()
        
        if (existing.data?.created_by !== req.user.userId && req.user.role !== 'admin') {
            return res.status(403).json({ error: '无权删除此记录' })
        }
        
        const { error } = await supabase
            .from(type)
            .delete()
            .eq('id', id)
        
        if (error) {
            return res.status(400).json({ error: error.message })
        }
        
        logOperation(req.user.userId, 'DELETE', type, id)
        
        res.json({
            success: true,
            message: '✅ 记录已删除'
        })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// 6. 统计数据接口
app.get('/api/statistics/:type', authenticateUser, async (req, res) => {
    try {
        const { type } = req.params
        
        const { data, error } = await supabase
            .from(type)
            .select('*')
        
        if (error) {
            return res.status(400).json({ error: error.message })
        }
        
        const stats = {
            total: data.length,
            today: data.filter(r => isToday(r.created_at)).length,
            thisWeek: data.filter(r => isThisWeek(r.created_at)).length,
            thisMonth: data.filter(r => isThisMonth(r.created_at)).length
        }
        
        res.json({ success: true, data: stats })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// ====== Authentication ======

// 用户登录 (模拟 - 实际应验证数据库)
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body
        
        // 模拟用户验证 (实际应查询数据库并验证密码哈希)
        if (username === 'admin' && password === 'admin123') {
            const token = jwt.sign(
                {
                    userId: 1,
                    username: 'admin',
                    role: 'admin'
                },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRE }
            )
            
            res.json({
                success: true,
                token,
                user: {
                    id: 1,
                    username: 'admin',
                    role: 'admin'
                }
            })
        } else {
            res.status(401).json({ error: '❌ 用户名或密码错误' })
        }
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// 登出
app.post('/api/auth/logout', authenticateUser, (req, res) => {
    res.json({ success: true, message: '✅ 已登出' })
})

// 刷新Token
app.post('/api/auth/refresh', authenticateUser, (req, res) => {
    const newToken = jwt.sign(
        {
            userId: req.user.userId,
            username: req.user.username,
            role: req.user.role
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE }
    )
    
    res.json({ success: true, token: newToken })
})

// ====== Middleware ======

// 身份认证中间件
function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '❌ 缺少授权令牌' })
    }
    
    const token = authHeader.substring(7)
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        req.user = decoded
        next()
    } catch (error) {
        return res.status(401).json({ error: '❌ 令牌无效或已过期' })
    }
}

// ====== Utilities ======

function validateInput(data) {
    const errors = {}
    
    // 样本ID验证
    if (!data.sampleId || data.sampleId.trim() === '') {
        errors.sampleId = '样本ID必填'
    }
    
    // 检测日期验证
    if (!data.testDate) {
        errors.testDate = '检测日期必填'
    }
    
    return {
        valid: Object.keys(errors).length === 0,
        errors: Object.keys(errors).length > 0 ? errors : null
    }
}

function logOperation(userId, operation, table, recordId) {
    const timestamp = new Date().toISOString()
    console.log(`📝 [${timestamp}] User ${userId} - ${operation} ${table}:${recordId}`)
    // 实际应存储到审计日志表
}

function isToday(dateString) {
    const date = new Date(dateString)
    const today = new Date()
    return date.toDateString() === today.toDateString()
}

function isThisWeek(dateString) {
    const date = new Date(dateString)
    const today = new Date()
    const firstDay = new Date(today.setDate(today.getDate() - today.getDay()))
    return date >= firstDay
}

function isThisMonth(dateString) {
    const date = new Date(dateString)
    const today = new Date()
    return date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear()
}

// ====== Error Handling ======

app.use((req, res) => {
    res.status(404).json({ error: '❌ 接口不存在' })
})

app.use((err, req, res, next) => {
    console.error('❌ Error:', err)
    res.status(500).json({ error: '❌ 服务器错误' })
})

// ====== Start Server ======

app.listen(PORT, async () => {
    console.log(`
╔════════════════════════════════════════╗
║  🍽️  Food Safety Testing API Server   ║
║  ✅ Running on port ${PORT}              ║
║  🔒 All Supabase keys are protected    ║
║  📝 Environment: ${process.env.NODE_ENV}            ║
╚════════════════════════════════════════╝
    `)
    
})

export default app
