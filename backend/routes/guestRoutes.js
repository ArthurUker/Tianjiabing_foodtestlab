/**
 * Guest Routes（访客自助服务，TD-Guest 收口）
 *
 * 端点：
 *   POST /api/guest/register              访客自注册（按 schoolCode 落到对应租户 schema）
 *   POST /api/guest/login                 访客登录（签发 guest 作用域 JWT）
 *   POST /api/guest/verify-token          校验访客令牌
 *   POST /api/guest/quick-access          P0-07 快速访问：无需凭证，签发只读限权 JWT（2h）
 *   GET  /api/guest/stats                 BS-09 访客看板汇总统计（仅聚合，不返回记录明细）
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
import { rateLimit } from '../middleware/validationMiddleware.js'
import { writeTenantAuditLog } from '../lib/auditLog.js'

// NB-12: 访客公开端点限流
const guestRegisterLimiter = rateLimit(10, 60 * 1000)   // 每分钟10次
const guestLoginLimiter = rateLimit(20, 60 * 1000)      // 每分钟20次

// NB-06: 访客类型白名单
const VALID_GUEST_TYPES = new Set(['viewer', 'export_applicant'])

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
        // ENV-JWT-Expire: 访客令牌有效期跟随全局 JWT_EXPIRE 环境变量
        { expiresIn: process.env.JWT_EXPIRE || '7d' }
    )
}

export function createGuestRoutes(userManager, prisma, jwtSecret) {
    const router = express.Router()
    const { authenticateUser, requireGuestReadOnly } = createAuthMiddleware(userManager, prisma)

    const requireGuest = (req, res, next) => {
        if (!req.user || req.user.role !== 'guest') {
            return res.status(403).json({ error: '❌ 仅访客可访问' })
        }
        next()
    }

    // 访客自注册（NB-12: 加注册限流）
    router.post('/register', guestRegisterLimiter, async (req, res) => {
        let db = null  // H5: 提升到 try 外，避免 catch 块 ReferenceError
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

            // NB-06: 密码强度校验
            if (String(password).length < 8) {
                return res.status(400).json({ error: '❌ 密码至少8位' })
            }
            // NB-06: 用户名格式校验（3-32位字母/数字/下划线）
            if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
                return res.status(400).json({ error: '❌ 用户名格式非法（需3-32位字母、数字或下划线）' })
            }
            // NB-06: 访客类型白名单校验
            if (!VALID_GUEST_TYPES.has(guest_type || 'viewer')) {
                return res.status(400).json({ error: '❌ 非法的访客类型' })
            }

            db = createTenantClient(prisma, schoolCode)
            const exists = await db.guest.findUnique({ where: { username } })
            if (exists) {
                return res.status(409).json({ error: '❌ 用户名已存在' })
            }

            const passwordHash = await bcryptjs.hash(password, 10)
            // H6: valid_days 上限 365 天，防止令牌近乎永久有效
            const cappedDays = Math.min(Number(valid_days) || 30, 365)
            const validUntil = new Date(Date.now() + cappedDays * 24 * 3600 * 1000)

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
            // H5: 防御性处理——db 在 try 块中赋值，P2002 重复键冲突需要回查，
            // 若 db 在赋值前已抛异常（如 createTenantClient 失败），则 db 为 null。
            if (error.code === 'P2002' && db) {
                const existing = await db.guest.findUnique({ where: { username: req.body?.username } })
                if (existing) {
                    const token = makeGuestToken(existing, schoolCode, jwtSecret)
                    return res.status(200).json({ success: true, token, guest: serializeGuest(existing), idempotent: true })
                }
            }
            return res.status(400).json({ error: `注册失败` })
        }
    })

    // 访客登录（NB-12: 加登录限流）
    router.post('/login', guestLoginLimiter, async (req, res) => {
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
                // NB-12: 用户不存在时执行假 bcryptjs.compare 拉平时序，防止时序攻击推断用户存在性
                await bcryptjs.compare(password, '$2a$10$00000000000000000000000000000000000000000000000')
                return res.status(401).json({ error: '❌ 访客不存在或已禁用' })
            }

            const ok = await bcryptjs.compare(password, guest.password_hash)
            if (!ok) {
                return res.status(401).json({ error: '❌ 密码错误' })
            }

            const token = makeGuestToken(guest, schoolCode, jwtSecret)
            return res.json({ success: true, token, guest: serializeGuest(guest) })
        } catch (error) {
            return res.status(400).json({ error: `登录失败` })
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
            // RK23: 快速访问令牌必须携带 schoolCode，否则 tenantMiddleware 回退 public schema，
            // 造成跨租户数据泄漏。无法确定学校时拒绝签发。
            const { schoolCode } = req.body || {}
            if (!schoolCode || !isValidSchoolCode(schoolCode)) {
                return res.status(400).json({ error: '❌ 缺少或非法学校代码（schoolCode）' })
            }
            const payload = {
                guestId: 0,
                userId: 'quick-access',
                username: '快速访问用户',
                role: 'guest',
                schoolCode,
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

    // BS-09: 访客看板汇总统计 —— 只返回聚合结果（总数 / 各可见模块计数 / 合格率），不含任何记录明细。
    // 口径与员工端一致：按该校 visible_types 白名单聚合、强制排除 pathogen（requireGuestReadOnly 注入）。
    // 合格率规则（后端复刻员工端简单口径）：tableware/pesticide/leanMeat/oil 看
    // result_data.result 含"合格"且不含"不合格"；pathogen 不纳入统计。
    const PASS_RULE_TYPES = new Set(['tableware', 'pesticide', 'leanMeat', 'oil'])
    const STATS_TYPE_LABELS = {
        tableware: '餐具洁净度检测',
        pesticide: '果蔬农残检测',
        oil: '食用油品质检测',
        leanMeat: '肉、蛋农残检测'
    }

    router.get('/stats', authenticateUser, requireGuest, requireGuestReadOnly, async (req, res) => {
        try {
            const allowed = req.guestVisibleTypes || []
            if (!allowed.length) {
                return res.json({ success: true, data: { total: 0, byType: {}, visibleTypes: [] } })
            }

            // 各可见模块计数（groupBy 聚合，不取明细）
            const grouped = await req.db.testRecord.groupBy({
                by: ['test_type'],
                _count: { _all: true },
                where: { test_type: { in: allowed } }
            })

            const byType = {}
            let total = 0
            for (const t of allowed) {
                byType[t] = { label: STATS_TYPE_LABELS[t] || t, count: 0, passCount: null, passRate: null }
            }
            for (const g of grouped) {
                if (!byType[g.test_type]) continue
                byType[g.test_type].count = g._count._all
                total += g._count._all
            }

            // 合格率：DB 侧 JSON 聚合（M1：避免 findMany 全量加载 result_data 到 Node.js 内存）
            const ruleTypes = allowed.filter(t => PASS_RULE_TYPES.has(t))
            if (ruleTypes.length) {
                const passRows = await req.db.$queryRawUnsafe(
                    `SELECT "test_type", COUNT(*)::int AS "total",
                     COUNT(*) FILTER (
                       WHERE ("result_data"::jsonb ->> 'result') LIKE '%' || '合格' || '%'
                       AND ("result_data"::jsonb ->> 'result') NOT LIKE '%' || '不合格' || '%'
                     )::int AS "pass"
                     FROM "TestRecord"
                     WHERE "test_type" = ANY($1::text[])
                     GROUP BY "test_type"`,
                    ruleTypes
                )
                for (const row of passRows) {
                    if (!byType[row.test_type]) continue
                    byType[row.test_type].passCount = row.pass
                    byType[row.test_type].passRate = row.total ? Math.round((row.pass / row.total) * 1000) / 10 : null
                }
            }

            return res.json({
                success: true,
                data: {
                    total,
                    byType,
                    visibleTypes: allowed,
                    generatedAt: new Date().toISOString()
                }
            })
        } catch (error) {
            console.error('❌ Error building guest stats:', error)
            return res.status(500).json({ error: '获取访客统计失败' })
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
            return res.status(400).json({ error: `提交失败` })
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
            return res.status(400).json({ error: `查询失败` })
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
            return res.status(400).json({ error: `查询失败` })
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
            res.status(400).json({ error: `获取待审批列表失败` })
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
            res.status(400).json({ error: `审批失败` })
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
            res.status(400).json({ error: `驳回失败` })
        }
    })

    return router
}

export default { createGuestRoutes, createGuestExportRequestRoutes }
