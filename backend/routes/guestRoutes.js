/**
 * Guest Routes（访客自助服务，TD-Guest 收口）
 *
 * 端点：
 *   POST /api/guest/register              访客自注册（按 schoolCode 落到对应租户 schema）
 *   POST /api/guest/login                 访客登录（签发 guest 作用域 JWT）
 *   POST /api/guest/verify-token          校验访客令牌
 *   POST /api/guest/quick-access          P0-07 快速访问：无需凭证，签发只读限权 JWT（2h）
 *   POST /api/guest-export-request/submit           提交导出申请
 *   GET  /api/guest-export-request/my-requests      查看我的申请
 *   GET  /api/guest-export-request/check-permission 查看导出权限状态
 *   GET  /api/guest-export-request/admin/pending     管理端：待审批列表（admin/manager）
 *   POST /api/guest-export-request/admin/:id/approve 管理端：批准（置 has_export_permission=true）
 *   POST /api/guest-export-request/admin/:id/reject  管理端：驳回
 *
 * 租户隔离：register/login 按请求体 schoolCode 用 createTenantClient 落到对应 schema；
 * 其余需鉴权的端点从 JWT（req.user.schoolCode）取租户，与全局认证一致。
 * guest 令牌字段：{ role:'guest', schoolCode, guestId, guest_type, has_export_permission }。
 */

import express from 'express'
import bcryptjs from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createTenantClient } from '../lib/tenantClient.js'
import { isValidSchoolCode } from '../lib/tenantProvisioner.js'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'
import { writeTenantAuditLog } from '../lib/auditLog.js'

function serializeGuest(g) {
    return {
        id: g.id,
        username: g.username,
        email: g.email,
        full_name: g.full_name,
        guest_type: g.guest_type,
        has_export_permission: g.has_export_permission,
        status: g.status,
        valid_until: g.valid_until
    }
}

function makeGuestToken(guest, schoolCode, jwtSecret) {
    return jwt.sign(
        {
            userId: guest.id,
            username: guest.username,
            role: 'guest',
            schoolCode,
            guestId: guest.id,
            guest_type: guest.guest_type,
            has_export_permission: guest.has_export_permission,
            is_quick_access: false,
            iat: Math.floor(Date.now() / 1000)
        },
        jwtSecret,
        { expiresIn: '7d' }
    )
}

export function createGuestRoutes(userManager, prisma, jwtSecret) {
    const router = express.Router()
    const { authenticateUser } = createAuthMiddleware(userManager, prisma)

    // 访客自注册
    router.post('/register', async (req, res) => {
        try {
            const {
                username,
                email,
                password,
                full_name,
                guest_type = 'viewer',
                valid_days = 30,
                schoolCode
            } = req.body

            if (!username || !password || !schoolCode) {
                return res.status(400).json({ error: '❌ 缺少必要字段（username / password / schoolCode）' })
            }
            if (!isValidSchoolCode(schoolCode)) {
                return res.status(400).json({ error: '❌ 非法学校代码' })
            }

            const db = createTenantClient(prisma, schoolCode)
            const exists = await db.guest.findUnique({ where: { username } })
            if (exists) {
                return res.status(409).json({ error: '❌ 用户名已存在' })
            }

            const passwordHash = await bcryptjs.hash(password, 10)
            const validUntil = new Date(Date.now() + Number(valid_days) * 24 * 3600 * 1000)

            const guest = await db.guest.create({
                data: {
                    username,
                    email: email || null,
                    password_hash: passwordHash,
                    full_name: full_name || null,
                    guest_type,
                    valid_until: validUntil,
                    status: 'active',
                    created_by: null
                }
            })

            const token = makeGuestToken(guest, schoolCode, jwtSecret)
            return res.status(201).json({ success: true, token, guest: serializeGuest(guest) })
        } catch (error) {
            return res.status(400).json({ error: `❌ 注册失败: ${error.message}` })
        }
    })

    // 访客登录
    router.post('/login', async (req, res) => {
        try {
            const { username, password, schoolCode } = req.body

            if (!username || !password || !schoolCode) {
                return res.status(400).json({ error: '❌ 缺少必要字段（username / password / schoolCode）' })
            }
            if (!isValidSchoolCode(schoolCode)) {
                return res.status(400).json({ error: '❌ 非法学校代码' })
            }

            const db = createTenantClient(prisma, schoolCode)
            const guest = await db.guest.findUnique({ where: { username } })
            if (!guest || guest.status !== 'active') {
                return res.status(401).json({ error: '❌ 访客不存在或已禁用' })
            }

            const ok = await bcryptjs.compare(password, guest.password_hash)
            if (!ok) {
                return res.status(401).json({ error: '❌ 密码错误' })
            }

            const token = makeGuestToken(guest, schoolCode, jwtSecret)
            return res.json({ success: true, token, guest: serializeGuest(guest) })
        } catch (error) {
            return res.status(400).json({ error: `❌ 登录失败: ${error.message}` })
        }
    })

    // 校验访客令牌
    router.post('/verify-token', authenticateUser, (req, res) => {
        const u = req.user
        if (u.role !== 'guest') {
            return res.status(403).json({ valid: false, error: '❌ 非访客令牌' })
        }
        return res.json({
            valid: true,
            guest: {
                id: u.guestId,
                username: u.username,
                guest_type: u.guest_type,
                has_export_permission: u.has_export_permission
            }
        })
    })

    // P0-07：快速访问 —— 无需凭证，签发只读限权 JWT（2h）。
    // 原内联在 server.js，现收口到 guestRoutes 保持结构统一。
    router.post('/quick-access', async (req, res) => {
        try {
            const payload = {
                guestId: 0,
                username: '快速访问用户',
                guest_type: 'viewer',
                has_export_permission: false,
                is_quick_access: true,
                iat: Math.floor(Date.now() / 1000)
            }
            const token = jwt.sign(payload, jwtSecret, { expiresIn: '2h' })
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

    return router
}

export function createGuestExportRequestRoutes(userManager, prisma, jwtSecret) {
    const router = express.Router()
    const { authenticateUser, authorizeRoles } = createAuthMiddleware(userManager, prisma)

    const requireGuest = (req, res, next) => {
        if (!req.user || req.user.role !== 'guest') {
            return res.status(403).json({ error: '❌ 仅访客可操作' })
        }
        next()
    }

    // 提交导出申请
    router.post('/submit', authenticateUser, requireGuest, async (req, res) => {
        try {
            const { request_type, request_reason, request_data } = req.body
            if (!request_type) {
                return res.status(400).json({ error: '❌ 缺少申请类型' })
            }

            const db = createTenantClient(prisma, req.user.schoolCode)
            const created = await db.guestExportRequest.create({
                data: {
                    guest_id: req.user.guestId,
                    request_type,
                    request_reason: request_reason || null,
                    request_data: request_data ? JSON.stringify(request_data) : null,
                    status: 'pending'
                }
            })

            return res.status(201).json({ success: true, request: created })
        } catch (error) {
            return res.status(400).json({ error: `❌ 提交失败: ${error.message}` })
        }
    })

    // 我的申请列表
    router.get('/my-requests', authenticateUser, requireGuest, async (req, res) => {
        try {
            const db = createTenantClient(prisma, req.user.schoolCode)
            const list = await db.guestExportRequest.findMany({
                where: { guest_id: req.user.guestId },
                orderBy: { created_at: 'desc' }
            })
            return res.json({ success: true, requests: list })
        } catch (error) {
            return res.status(400).json({ error: `❌ 查询失败: ${error.message}` })
        }
    })

    // 导出权限状态
    router.get('/check-permission', authenticateUser, requireGuest, async (req, res) => {
        try {
            const db = createTenantClient(prisma, req.user.schoolCode)
            const guest = await db.guest.findUnique({ where: { id: req.user.guestId } })
            return res.json({
                has_export_permission: guest?.has_export_permission || false,
                valid_until: guest?.valid_until || null
            })
        } catch (error) {
            return res.status(400).json({ error: `❌ 查询失败: ${error.message}` })
        }
    })

    // ========== 管理端审批（仅 admin / manager，TD-Export-Approval） ==========
    // 待审批列表（当前租户 schema 内 status=pending）
    router.get('/admin/pending', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const requests = await req.db.guestExportRequest.findMany({
                where: { status: 'pending' },
                orderBy: { created_at: 'desc' },
            })
            res.json({ success: true, data: requests })
        } catch (error) {
            console.error('❌ Error listing pending export requests:', error)
            res.status(400).json({ error: `❌ 获取待审批列表失败: ${error.message}` })
        }
    })

    // 审批通过：置 guest.has_export_permission=true，记录审批人与时间 + 审计
    router.post('/admin/:requestId/approve', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { requestId } = req.params
            const request = await req.db.guestExportRequest.findUnique({ where: { id: requestId } })
            if (!request || request.status !== 'pending') {
                return res.status(404).json({ error: '❌ 申请不存在或已处理' })
            }

            await req.db.$transaction(async (tx) => {
                await tx.guestExportRequest.update({
                    where: { id: requestId },
                    data: { status: 'approved', reviewed_by: req.user.userId, reviewed_at: new Date() },
                })
                await tx.guest.update({
                    where: { id: request.guest_id },
                    data: { has_export_permission: true },
                })
            })

            await writeTenantAuditLog(req.db, {
                actorId: req.user.userId,
                action: 'guest_export_approve',
                resourceType: 'guest_export_request',
                resourceId: requestId,
                details: { guest_id: request.guest_id },
                ip: req.ip || null,
            })

            res.json({ success: true, message: '✅ 已批准导出申请' })
        } catch (error) {
            console.error('❌ Error approving export request:', error)
            res.status(400).json({ error: `❌ 审批失败: ${error.message}` })
        }
    })

    // 审批驳回：记录审批人与时间 + 审计（不开放导出权限）
    router.post('/admin/:requestId/reject', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { requestId } = req.params
            const request = await req.db.guestExportRequest.findUnique({ where: { id: requestId } })
            if (!request || request.status !== 'pending') {
                return res.status(404).json({ error: '❌ 申请不存在或已处理' })
            }

            await req.db.guestExportRequest.update({
                where: { id: requestId },
                data: { status: 'rejected', reviewed_by: req.user.userId, reviewed_at: new Date() },
            })

            await writeTenantAuditLog(req.db, {
                actorId: req.user.userId,
                action: 'guest_export_reject',
                resourceType: 'guest_export_request',
                resourceId: requestId,
                details: { guest_id: request.guest_id },
                ip: req.ip || null,
            })

            res.json({ success: true, message: '✅ 已驳回导出申请' })
        } catch (error) {
            console.error('❌ Error rejecting export request:', error)
            res.status(400).json({ error: `❌ 驳回失败: ${error.message}` })
        }
    })

    return router
}

export default { createGuestRoutes, createGuestExportRequestRoutes }
