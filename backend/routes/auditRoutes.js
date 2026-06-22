/**
 * Audit Logs Routes (Prisma-based)
 * 审计日志 API 路由 - 记录和查询用户操作
 */

import express from 'express'
import jwt from 'jsonwebtoken'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'

export function createAuditRoutes(prisma, userManager) {
    const router = express.Router()

    // ====== Authentication Middleware（统一从 authMiddleware.js 导入）======
    const { authenticateUser, authorizeAdmin } = createAuthMiddleware(userManager)

    // ====== Public Routes ======

    /**
     * 记录操作日志
     * POST /api/audit-logs
     * 
     * Body:
     * {
     *   "action": "create|update|delete|login|logout|export",
     *   "resource_type": "test_record|user|backup|etc",
     *   "resource_id": "record-id",
     *   "details": "操作详情描述"
     * }
     */
    router.post('/', authenticateUser, async (req, res) => {
        try {
            const { action, resource_type, resource_id, details } = req.body

            if (!action) {
                return res.status(400).json({ error: '❌ 缺少操作类型' })
            }

            const log = await prisma.auditLog.create({
                data: {
                    user_id: req.user.userId,
                    action,
                    resource_type: resource_type || null,
                    resource_id: resource_id || null,
                    details: details ? JSON.stringify(details) : null,
                    ip_address: req.ip || null
                }
            })

            res.status(201).json({
                success: true,
                data: log,
                message: '日志已记录'
            })
        } catch (error) {
            console.error('❌ Error creating audit log:', error)
            res.status(400).json({ error: `❌ 记录失败: ${error.message}` })
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

            const logs = await prisma.auditLog.findMany({
                where,
                skip: parseInt(offset),
                take: parseInt(limit),
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

            const total = await prisma.auditLog.count({ where })

            res.json({
                success: true,
                data: logs,
                total,
                limit: parseInt(limit),
                offset: parseInt(offset)
            })
        } catch (error) {
            console.error('❌ Error fetching audit logs:', error)
            res.status(400).json({ error: `❌ 查询失败: ${error.message}` })
        }
    })

    /**
     * 获取单条日志详情
     * GET /api/audit-logs/:logId
     */
    router.get('/:logId', authenticateUser, async (req, res) => {
        try {
            const log = await prisma.auditLog.findUnique({
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
            res.status(400).json({ error: `❌ 查询失败: ${error.message}` })
        }
    })

    /**
     * 获取统计数据
     * GET /api/audit-logs/stats/summary
     * （仅管理员可访问）
     */
    router.get('/stats/summary', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const actions = await prisma.auditLog.groupBy({
                by: ['action'],
                _count: {
                    id: true
                },
                orderBy: {
                    _count: {
                        id: 'desc'
                    }
                }
            })

            const userActions = await prisma.auditLog.groupBy({
                by: ['user_id'],
                _count: {
                    id: true
                },
                orderBy: {
                    _count: {
                        id: 'desc'
                    }
                },
                take: 10
            })

            const totalLogs = await prisma.auditLog.count()

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
            res.status(400).json({ error: `❌ 统计失败: ${error.message}` })
        }
    })

    /**
     * 删除旧日志（仅管理员可操作）
     * DELETE /api/audit-logs/cleanup?days=30
     */
    router.delete('/cleanup', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { days = 30 } = req.query
            const cutoffDate = new Date()
            cutoffDate.setDate(cutoffDate.getDate() - parseInt(days))

            const result = await prisma.auditLog.deleteMany({
                where: {
                    created_at: {
                        lt: cutoffDate
                    }
                }
            })

            res.json({
                success: true,
                message: `已删除 ${result.count} 条${days}天前的日志`
            })
        } catch (error) {
            console.error('❌ Error cleaning up logs:', error)
            res.status(400).json({ error: `❌ 清理失败: ${error.message}` })
        }
    })

    return router
}

export default createAuditRoutes
