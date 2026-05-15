/**
 * Audit Logs Routes
 * 审计日志 API 路由 - 记录和查询用户操作
 */

import express from 'express'
import jwt from 'jsonwebtoken'

export function createAuditRoutes(supabase, jwtSecret) {
    const router = express.Router()

    // ====== Authentication Middleware ======
    function authenticateUser(req, res, next) {
        const authHeader = req.headers.authorization
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: '❌ 缺少授权令牌' })
        }

        const token = authHeader.substring(7)
        try {
            const decoded = jwt.verify(token, jwtSecret)
            req.user = decoded
            next()
        } catch (error) {
            return res.status(401).json({ error: '❌ 令牌无效或已过期' })
        }
    }

    function authorizeAdmin(req, res, next) {
        if (req.user.role !== 'admin' && req.user.role !== 'manager') {
            return res.status(403).json({ error: '❌ 权限不足' })
        }
        next()
    }

    // ====== Public Routes ======

    /**
     * 记录操作日志
     * POST /api/audit-logs
     * 
     * Body:
     * {
     *   "user_id": "user123",
     *   "action": "create|update|delete|login|logout|export",
     *   "table_name": "tableware|pathogen|pesticide|oil|leanMeat|users",
     *   "record_id": 123,
     *   "details": "操作详情描述"
     * }
     */
    router.post('/', authenticateUser, async (req, res) => {
        try {
            const { action, table_name, record_id, details } = req.body
            const user_id = req.user.id || req.user.username

            // 字段验证
            if (!action || !table_name) {
                return res.status(400).json({ 
                    error: '❌ 缺少必要字段: action 和 table_name' 
                })
            }

            // 允许的操作类型
            const allowedActions = ['create', 'update', 'delete', 'login', 'logout', 'export', 'import']
            if (!allowedActions.includes(action)) {
                return res.status(400).json({ 
                    error: `❌ 不支持的操作类型: ${action}` 
                })
            }

            // 插入到数据库
            const { data, error } = await supabase
                .from('audit_logs')
                .insert([
                    {
                        user_id,
                        action,
                        table_name,
                        record_id: record_id || null,
                        details: details || null,
                        created_at: new Date().toISOString()
                    }
                ])
                .select()

            if (error) {
                console.error('❌ 审计日志插入失败:', error)
                return res.status(500).json({ 
                    error: `❌ 记录日志失败: ${error.message}` 
                })
            }

            res.status(201).json({
                success: true,
                message: '✅ 操作已记录',
                data: data[0]
            })
        } catch (error) {
            console.error('❌ 记录审计日志错误:', error)
            res.status(500).json({ 
                error: `❌ 服务器错误: ${error.message}` 
            })
        }
    })

    /**
     * 获取审计日志列表
     * GET /api/audit-logs?limit=50&offset=0&user_id=xxx&action=xxx&table_name=xxx
     * 
     * 仅管理员可访问
     */
    router.get('/', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { limit = 50, offset = 0, user_id, action, table_name, start_date, end_date } = req.query

            let query = supabase
                .from('audit_logs')
                .select('*', { count: 'exact' })
                .order('created_at', { ascending: false })

            // 应用过滤条件
            if (user_id) {
                query = query.eq('user_id', user_id)
            }
            if (action) {
                query = query.eq('action', action)
            }
            if (table_name) {
                query = query.eq('table_name', table_name)
            }

            // 时间范围过滤
            if (start_date) {
                query = query.gte('created_at', start_date)
            }
            if (end_date) {
                query = query.lte('created_at', end_date)
            }

            // 分页
            const limitNum = Math.min(parseInt(limit) || 50, 500) // 最多500条
            const offsetNum = parseInt(offset) || 0
            query = query.range(offsetNum, offsetNum + limitNum - 1)

            const { data, error, count } = await query

            if (error) {
                console.error('❌ 查询审计日志失败:', error)
                return res.status(500).json({ 
                    error: `❌ 查询失败: ${error.message}` 
                })
            }

            res.json({
                success: true,
                data,
                total: count || 0,
                limit: limitNum,
                offset: offsetNum
            })
        } catch (error) {
            console.error('❌ 查询审计日志错误:', error)
            res.status(500).json({ 
                error: `❌ 服务器错误: ${error.message}` 
            })
        }
    })

    /**
     * 获取指定日期的审计日志统计
     * GET /api/audit-logs/stats/:date
     * 
     * date 格式: YYYY-MM-DD
     */
    router.get('/stats/:date', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { date } = req.params

            // 验证日期格式
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return res.status(400).json({ 
                    error: '❌ 日期格式错误，应为 YYYY-MM-DD' 
                })
            }

            const startOfDay = `${date}T00:00:00Z`
            const endOfDay = `${date}T23:59:59Z`

            const { data, error } = await supabase
                .from('audit_logs')
                .select('*')
                .gte('created_at', startOfDay)
                .lte('created_at', endOfDay)

            if (error) {
                console.error('❌ 查询统计失败:', error)
                return res.status(500).json({ 
                    error: `❌ 查询失败: ${error.message}` 
                })
            }

            // 计算统计数据
            const stats = {
                total: data.length,
                by_user: {},
                by_action: {},
                by_table: {}
            }

            data.forEach(log => {
                // 按用户统计
                stats.by_user[log.user_id] = (stats.by_user[log.user_id] || 0) + 1
                // 按操作类型统计
                stats.by_action[log.action] = (stats.by_action[log.action] || 0) + 1
                // 按表名统计
                stats.by_table[log.table_name] = (stats.by_table[log.table_name] || 0) + 1
            })

            res.json({
                success: true,
                date,
                stats
            })
        } catch (error) {
            console.error('❌ 统计审计日志错误:', error)
            res.status(500).json({ 
                error: `❌ 服务器错误: ${error.message}` 
            })
        }
    })

    /**
     * 导出审计日志 (CSV)
     * GET /api/audit-logs/export?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
     * 
     * 仅管理员可访问
     */
    router.get('/export', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { start_date, end_date } = req.query

            let query = supabase
                .from('audit_logs')
                .select('*')
                .order('created_at', { ascending: false })

            if (start_date) {
                query = query.gte('created_at', start_date)
            }
            if (end_date) {
                query = query.lte('created_at', end_date)
            }

            const { data, error } = await query

            if (error) {
                console.error('❌ 导出失败:', error)
                return res.status(500).json({ 
                    error: `❌ 导出失败: ${error.message}` 
                })
            }

            // 转换为 CSV 格式
            const headers = ['ID', '用户', '操作', '表名', '记录ID', '详情', '时间']
            const rows = data.map(log => [
                log.id,
                log.user_id,
                log.action,
                log.table_name,
                log.record_id || '',
                log.details || '',
                new Date(log.created_at).toLocaleString('zh-CN')
            ])

            const csv = [
                headers.join(','),
                ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
            ].join('\n')

            res.setHeader('Content-Type', 'text/csv; charset=utf-8')
            res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${new Date().toISOString().split('T')[0]}.csv"`)
            res.send(csv)
        } catch (error) {
            console.error('❌ 导出错误:', error)
            res.status(500).json({ 
                error: `❌ 服务器错误: ${error.message}` 
            })
        }
    })

    /**
     * 清除旧审计日志 (仅保留90天内的数据)
     * POST /api/audit-logs/cleanup
     * 
     * 仅管理员可访问
     */
    router.post('/cleanup', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const cutoffDate = new Date()
            cutoffDate.setDate(cutoffDate.getDate() - 90)
            const cutoffISO = cutoffDate.toISOString()

            const { data, error } = await supabase
                .from('audit_logs')
                .delete()
                .lt('created_at', cutoffISO)

            if (error) {
                console.error('❌ 清理失败:', error)
                return res.status(500).json({ 
                    error: `❌ 清理失败: ${error.message}` 
                })
            }

            res.json({
                success: true,
                message: `✅ 已清理超过90天的日志`,
                cutoff_date: cutoffISO
            })
        } catch (error) {
            console.error('❌ 清理审计日志错误:', error)
            res.status(500).json({ 
                error: `❌ 服务器错误: ${error.message}` 
            })
        }
    })

    return router
}
