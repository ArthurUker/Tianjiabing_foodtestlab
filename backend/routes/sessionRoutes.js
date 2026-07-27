/**
 * Session Routes（TD-Session）
 * 后端会话同步端点：前端 SessionManager 在登录/登出/强制登出时调用，
 * 把内存会话落库到当前租户 schema 的 Session 表，实现跨设备会话可见与管控。
 *
 * 路由（均经 authenticateUser，写入落 req.db 即该校 schema）：
 *   POST   /api/session             注册/心跳当前会话（upsert by sessionId）
 *   GET    /api/session             列出当前用户活跃会话
 *   DELETE /api/session/:id         注销指定会话（本人或管理员）
 *   DELETE /api/session/others      注销除 currentSessionId 外的所有会话
 *   POST   /api/session/event       记录会话事件埋点（前端 recordSessionEvent 调用）
 */

import express from 'express'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'
import { writeTenantAuditLog } from '../lib/auditLog.js'

export function createSessionRoutes(userManager, prisma) {
    const router = express.Router()
    const { authenticateUser } = createAuthMiddleware(userManager, prisma)

    // 注册 / 心跳当前会话（前端登录时调用，之后每分钟心跳刷新 last_seen_at）
    router.post('/', authenticateUser, async (req, res) => {
        try {
            const { sessionId, deviceType, browser, userAgent } = req.body
            if (!sessionId) {
                return res.status(400).json({ error: '❌ 缺少 sessionId' })
            }

            const session = await req.db.session.upsert({
                where: { id: sessionId },
                create: {
                    id: sessionId,
                    user_id: req.user.userId,
                    session_token: sessionId,
                    device_type: deviceType || null,
                    browser: browser || null,
                    user_agent: userAgent || null,
                    ip_address: req.ip || null,
                },
                update: {
                    last_seen_at: new Date(),
                    status: 'active',
                },
            })

            res.status(201).json({ success: true, data: session })
        } catch (error) {
            console.error('❌ Error registering session:', error)
            res.status(400).json({ error: `注册会话失败` })
        }
    })

    // 列出当前用户活跃会话
    router.get('/', authenticateUser, async (req, res) => {
        try {
            const sessions = await req.db.session.findMany({
                where: { user_id: req.user.userId, status: 'active' },
                orderBy: { login_at: 'desc' },
            })
            res.json({ success: true, data: sessions })
        } catch (error) {
            console.error('❌ Error listing sessions:', error)
            res.status(400).json({ error: `获取会话列表失败` })
        }
    })

    // 注销指定会话（本人或管理员可操作）
    router.delete('/:id', authenticateUser, async (req, res) => {
        try {
            const where =
                req.user.role === 'admin'
                    ? { id: req.params.id }
                    : { id: req.params.id, user_id: req.user.userId }

            const result = await req.db.session.updateMany({
                where,
                data: { status: 'revoked' },
            })

            if (result.count === 0) {
                return res.status(404).json({ error: '❌ 会话不存在或无权限' })
            }
            res.json({ success: true, revoked: result.count })
        } catch (error) {
            console.error('❌ Error revoking session:', error)
            res.status(400).json({ error: `注销会话失败` })
        }
    })

    // 注销除 currentSessionId 外的所有会话（「登出其它设备」）
    router.delete('/others', authenticateUser, async (req, res) => {
        try {
            const { currentSessionId } = req.body
            if (!currentSessionId) {
                return res.status(400).json({ error: '❌ 缺少 currentSessionId' })
            }

            const result = await req.db.session.updateMany({
                where: {
                    user_id: req.user.userId,
                    status: 'active',
                    NOT: { session_token: currentSessionId },
                },
                data: { status: 'revoked' },
            })

            res.json({ success: true, revoked: result.count })
        } catch (error) {
            console.error('❌ Error revoking other sessions:', error)
            res.status(400).json({ error: `注销其它会话失败` })
        }
    })

    // 记录会话事件埋点（前端 SessionManager.recordSessionEvent 调用）
    router.post('/event', authenticateUser, async (req, res) => {
        try {
            const { sessionId, eventType, details } = req.body
            if (!eventType) {
                return res.status(400).json({ error: '❌ 缺少 eventType' })
            }

            await writeTenantAuditLog(req.db, {
                actorId: req.user.userId,
                action: 'session_event',
                resourceType: 'session',
                resourceId: sessionId || req.user.userId,
                details: { eventType, details: details || {} },
                ip: req.ip || null,
            })

            res.json({ success: true })
        } catch (error) {
            console.error('❌ Error recording session event:', error)
            res.status(400).json({ error: `记录会话事件失败` })
        }
    })

    return router
}

export default createSessionRoutes
