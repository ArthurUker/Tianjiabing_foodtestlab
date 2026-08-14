/**
 * Audit Logs Routes (Prisma-based)
 * 审计日志 API 路由 - 记录和查询用户操作
 */

import express from 'express'
import jwt from 'jsonwebtoken'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'
import { writeTenantAuditLog } from '../lib/auditLog.js'

/**
 * CSV 字段安全转义（TD-CSV-Export）
 * - 统一用双引号包裹；字段内双引号翻倍转义（RFC 4180）。
 * - 以 = + - @ 开头的字段前置单引号，防护 Excel/WPS 公式注入
 *   （如 `=cmd|...` / `=HYPERLINK(...)` 被执行）。
 */
function csvField(val) {
    const s = val == null ? '' : String(val)
    const guarded = /^=|\+|-|@/.test(s) ? `'${s}` : s
    return `"${guarded.replace(/"/g, '""')}"`
}

/**
 * 生产环境错误响应脱敏（TD-P2-13 收尾 / TD-Error-Leak 同构）
 * 生产环境不向客户端返回 error.message（可能含 SQL/表名/栈信息），仅返回通用文案。
 */
function clientErr(error, baseMsg) {
    return process.env.NODE_ENV === 'production'
        ? baseMsg
        : `${baseMsg}: ${error && error.message ? error.message : error}`
}

export function createAuditRoutes(userManager, prisma) {
    const router = express.Router()

    // ====== Authentication Middleware（统一从 authMiddleware.js 导入）======
    const { authenticateUser, authorizeAdmin } = createAuthMiddleware(userManager, prisma)

    // ====== Public Routes ======

    /**
     * 记录操作日志（H3 收敛后）
     * POST /api/audit-logs
     *
     * 【窗口2 · H3 安全收敛】本端点仅保留给前端"主动上报"类事件（如导出/打印），
     * 关键安全事件（登录、角色变更、禁用/删除、密码重置等）已全部改为服务端
     * 内部强制写入（writeTenantAuditLog / UserManager.logAdminAction），
     * 不再信任客户端上报。限制：
     *   1. 禁止 guest / viewer 调用（403）；
     *   2. action 仅允许预定义白名单（CLIENT_AUDIT_ACTIONS），
     *      服务端保留动作（login/login_failed/role_change/...）不可由客户端写入；
     *   3. details 限长 2000 字符，并统一打上 source:'client' 标记，
     *      与服务端生成的审计记录明确区分，防止伪造混淆。
     *
     * Body:
     * {
     *   "action": "create|update|delete|export|import|print|logout",
     *   "resource_type": "test_record|user|backup|etc",
     *   "resource_id": "record-id",
     *   "details": "操作详情描述"
     * }
     */
    const CLIENT_AUDIT_ACTIONS = ['create', 'update', 'delete', 'export', 'import', 'print', 'logout']
    const CLIENT_AUDIT_FORBIDDEN_ROLES = ['guest', 'viewer']

    router.post('/', authenticateUser, async (req, res) => {
        try {
            // H3-2: 禁止 guest / viewer 写审计
            if (CLIENT_AUDIT_FORBIDDEN_ROLES.includes(req.user.role)) {
                return res.status(403).json({ error: '❌ 当前角色无权写入审计日志' })
            }

            const { action, resource_type, resource_id, details } = req.body

            if (!action) {
                return res.status(400).json({ error: '❌ 缺少操作类型' })
            }

            // H3-2: action 白名单，杜绝伪造服务端保留事件（login/role_change/...）
            if (!CLIENT_AUDIT_ACTIONS.includes(action)) {
                return res.status(400).json({ error: `❌ 不支持的操作类型（仅允许: ${CLIENT_AUDIT_ACTIONS.join('/')}）` })
            }

            // H3-3: details 限长并标记来源为客户端上报
            const rawDetails = typeof details === 'string' ? details : (details == null ? '' : JSON.stringify(details))
            const safeDetails = {
                source: 'client',
                text: rawDetails.slice(0, 2000)
            }

            const log = await writeTenantAuditLog(req.db, {
                actorId: req.user.userId,
                action,
                resourceType: typeof resource_type === 'string' ? resource_type.slice(0, 100) : null,
                resourceId: typeof resource_id === 'string' ? resource_id.slice(0, 100) : null,
                details: safeDetails,
                ip: req.ip || null,
            })

            res.status(201).json({
                success: true,
                data: log,
                message: '日志已记录'
            })
        } catch (error) {
            console.error('❌ Error creating audit log:', error)
            res.status(400).json({ error: clientErr(error, '❌ 记录失败') })
        }
    })

    /**
     * 查询审计日志
     * GET /api/audit-logs?userId=xxx&action=login&limit=100&offset=0
     */
    router.get('/', authenticateUser, async (req, res) => {
        try {
            const { userId, action, limit = 100, offset = 0 } = req.query

            // 普通用户只能查看自己的日志，管理员可以查看所有
            let where = {}

            if (req.user.role !== 'admin' && req.user.role !== 'manager') {
                where.user_id = req.user.userId
            } else {
                if (userId) where.user_id = userId
            }

            if (action) where.action = action

            const logs = await req.db.auditLog.findMany({
                where,
                skip: Math.max(0, parseInt(offset) || 0),
                take: Math.min(parseInt(limit) || 100, 500),
                include: {
                    user: {
                        select: {
                            id: true,
                            username: true,
                            full_name: true
                        }
                    }
                },
                orderBy: { created_at: 'desc' }
            })

            const total = await req.db.auditLog.count({ where })

            res.json({
                success: true,
                data: logs,
                total,
                limit: Math.min(parseInt(limit) || 100, 500),
                offset: Math.max(0, parseInt(offset) || 0)
            })
        } catch (error) {
            console.error('❌ Error fetching audit logs:', error)
            res.status(400).json({ error: clientErr(error, '❌ 查询失败') })
        }
    })

    /**
     * 获取统计数据
     * GET /api/audit-logs/stats/summary
     * （仅管理员可访问）
     * P1-27: 静态路由前移至 /:logId 之前，遵循 Express 最佳实践
     */
    router.get('/stats/summary', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            // P2-25: 支持 date 查询参数按指定日期过滤（格式 YYYY-MM-DD）
            const { date } = req.query
            let where = {}
            if (date) {
                // 以 Asia/Shanghai 日历日为准，避免 UTC 解析导致日期边界错位（TD-Timezone-Chaos）
                const start = new Date(date + 'T00:00:00+08:00')
                const end = new Date(date + 'T23:59:59.999+08:00')
                if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
                    where.created_at = { gte: start, lte: end }
                }
            }

            const actions = await req.db.auditLog.groupBy({
                by: ['action'],
                _count: {
                    id: true
                },
                orderBy: {
                    _count: {
                        id: 'desc'
                    }
                },
                where
            })

            const userActions = await req.db.auditLog.groupBy({
                by: ['user_id'],
                _count: {
                    id: true
                },
                orderBy: {
                    _count: {
                        id: 'desc'
                    }
                },
                take: 10,
                where
            })

            const totalLogs = await req.db.auditLog.count({ where })

            res.json({
                success: true,
                data: {
                    totalLogs,
                    actionStats: actions,
                    topUsers: userActions
                }
            })
        } catch (error) {
            console.error('❌ Error fetching audit stats:', error)
            res.status(400).json({ error: clientErr(error, '❌ 统计失败') })
        }
    })

    /**
     * 导出审计日志 (CSV)
     * GET /api/audit-logs/export?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
     * （仅管理员可访问）
     * P1-27: 新增导出路由，对齐前端 AuditLogService.exportLogs() 调用
     */
    router.get('/export', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { start_date, end_date } = req.query

            let where = {}
            if (start_date || end_date) {
                where.created_at = {}
                // 以 Asia/Shanghai 日历日为准，避免 UTC 解析导致日期边界错位（TD-Timezone-Chaos）
                if (start_date) where.created_at.gte = new Date(start_date + 'T00:00:00+08:00')
                if (end_date) {
                    const endOfDay = new Date(end_date + 'T00:00:00+08:00')
                    endOfDay.setDate(endOfDay.getDate() + 1)
                    where.created_at.lt = endOfDay
                }
            }

            const logs = await req.db.auditLog.findMany({
                where,
                include: {
                    user: {
                        select: { username: true, full_name: true }
                    }
                },
                orderBy: { created_at: 'desc' },
                take: 10000
            })

            const header = '时间,用户,操作类型,资源类型,资源ID,详情,IP地址\n'
            const rows = logs.map(log => {
                const time = new Date(log.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
                const user = log.user ? `${log.user.username}(${log.user.full_name || ''})` : (log.user_id || '')
                // P1-4: details 列升级为 Json（jsonb），model 读取返回对象；CSV 导出需序列化为字符串
                const details = log.details == null ? '' : (typeof log.details === 'string' ? log.details : JSON.stringify(log.details))
                const ip = log.ip_address || ''
                return [
                    csvField(time),
                    csvField(user),
                    csvField(log.action),
                    csvField(log.resource_type || ''),
                    csvField(log.resource_id || ''),
                    csvField(details),
                    csvField(ip),
                ].join(',')
            }).join('\n')

            const csv = '\uFEFF' + header + rows

            res.setHeader('Content-Type', 'text/csv; charset=utf-8')
            res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${new Date().toISOString().split('T')[0]}.csv"`)
            res.send(csv)
        } catch (error) {
            console.error('❌ Error exporting audit logs:', error)
            res.status(400).json({ error: clientErr(error, '❌ 导出失败') })
        }
    })

    /**
     * 删除旧日志端点（DELETE /api/audit-logs/cleanup）已移除。
     * 依据 docs/PROJECT_CONVENTIONS.md 规则一（审计日志永久保留、禁止删除），
     * 任何形式的审计批量删除均不允许；如需「清理」只能走「追加说明」方式。
     * 故该端点不再提供，避免触碰红线。
     */

    /**
     * 获取单条日志详情
     * GET /api/audit-logs/:logId
     * P1-27: 动态参数路由移至所有静态路由之后，遵循 Express 最佳实践
     */
    router.get('/:logId', authenticateUser, async (req, res) => {
        try {
            const log = await req.db.auditLog.findUnique({
                where: { id: req.params.logId },
                include: {
                    user: {
                        select: {
                            id: true,
                            username: true,
                            full_name: true,
                            role: true
                        }
                    }
                }
            })

            if (!log) {
                return res.status(404).json({ error: '❌ 日志不存在' })
            }

            // 检查权限：仅能查看自己的日志或（管理员可查看所有）
            if (req.user.role !== 'admin' && req.user.role !== 'manager' && log.user_id !== req.user.userId) {
                return res.status(403).json({ error: '❌ 权限不足' })
            }

            res.json({
                success: true,
                data: log
            })
        } catch (error) {
            console.error('❌ Error fetching audit log:', error)
            res.status(400).json({ error: clientErr(error, '❌ 查询失败') })
        }
    })

    return router
}

export default createAuditRoutes
