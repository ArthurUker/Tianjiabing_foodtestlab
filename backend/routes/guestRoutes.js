/**
 * Guest Routes（访客自助服务，TD-Guest 收口）
 *
 * 端点：
 *   POST /api/guest/register              访客自注册（按 schoolCode 落到对应租户 schema）
 *   POST /api/guest/login                 访客登录（签发 guest 作用域 JWT）
 *   POST /api/guest/verify-token          校验访客令牌
 *   POST /api/guest-export-request/submit           提交导出申请
 *   GET  /api/guest-export-request/my-requests      查看我的申请
 *   GET  /api/guest-export-request/check-permission 查看导出权限状态
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

    return router
}

export function createGuestExportRequestRoutes(userManager, prisma, jwtSecret) {
    const router = express.Router()
    const { authenticateUser } = createAuthMiddleware(userManager, prisma)

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

    return router
}

export default { createGuestRoutes, createGuestExportRequestRoutes }
