/**
 * Guest Routes（访客自助服务，TD-Guest 收口）
 *
 * 端点：
 *   POST /api/guest/register              访客自注册（仅 readonly；可登记「查看病原体」意向，需审批）
 *   POST /api/guest/login                 访客登录（签发 guest 作用域 JWT）
 *   POST /api/guest/verify-token          校验访客令牌
 *   POST /api/guest/quick-access          P0-07 快速访问：无需凭证，签发只读限权 JWT（2h）
 *   GET  /api/guest/stats                 BS-09 访客看板汇总统计（仅聚合，不返回记录明细）
 *   POST /api/guest-export-request/submit           提交申请（request_type: pathogen_access 查看病原体 / export 导出）
 *   GET  /api/guest-export-request/my-requests      查看我的申请
 *   GET  /api/guest-export-request/check-permission 查看我的权限状态（can_view_pathogen / has_export_permission）
 *   GET  /api/guest-export-request/admin/pending     管理端：待审批列表（admin/manager）
 *   POST /api/guest-export-request/admin/:id/approve 管理端：批准（pathogen_access→置 can_view_pathogen=true，export→置 has_export_permission）
 *   POST /api/guest-export-request/admin/:id/reject  管理端：驳回
 *
 * 权限模型（本系统访客唯二可申请的权限）：
 *   - 查看病原体数据（can_view_pathogen）：默认关闭，经 pathogen_access 申请、manager 审批后开启；
 *     即便开启也仍属只读，且【绝不】开放导出权限。
 *   - 数据导出（has_export_permission）：默认关闭，经 export 申请、manager 审批后开启。
 *   二者相互独立，pathogen_access 审批通过不会授予导出权限。
 *
 * 租户隔离：register/login 按请求体 schoolCode 用 createTenantClient 落到对应 schema；
 * 其余需鉴权的端点从 JWT（req.user.schoolCode）取租户，与全局认证一致。
 * guest 令牌字段：{ role:'guest', schoolCode, guestId, guest_type, has_export_permission, can_view_pathogen }。
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
// TD-GuestGate: quick-access 无凭证签发只读 JWT，需额外限流防批量枚举学校代码拉取数据
const quickAccessLimiter = rateLimit(30, 60 * 1000)     // 每分钟30次

// NB-06: 访客类型白名单（自注册仅允许 readonly；export_applicant 为历史别名，保留兼容但不对外开放自注册）
const VALID_GUEST_TYPES = new Set(['readonly', 'export_applicant'])

// 申请类型白名单：pathogen_access = 申请查看病原体数据（只读，不授导出）；export = 申请数据导出
const VALID_REQUEST_TYPES = new Set(['pathogen_access', 'export'])

function serializeGuest(g) {
    return {
        id: g.id,
        username: g.username,
        email: g.email,
        full_name: g.full_name,
        guest_type: g.guest_type,
        has_export_permission: g.has_export_permission,
        can_view_pathogen: g.can_view_pathogen || false,
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
            can_view_pathogen: guest.can_view_pathogen || false,
            is_quick_access: false,
            iat: Math.floor(Date.now() / 1000)
        },
        jwtSecret,
        // ENV-JWT-Expire: 访客令牌有效期跟随全局 JWT_EXPIRE 环境变量
        { expiresIn: process.env.JWT_EXPIRE || '7d' }
    )
}

// TD-GuestGate: 访客功能开关后端强制校验（首轮阻断项 #2+#3 修复）。
// 此前 guest_enabled 仅在前端登录页控制访客 Tab 显隐，后端 register/login/quick-access
// 三个端点均不校验，导致超管关闭访客入口后仍可直连 API 自注册/快速访问。
// 提取为单一工厂函数，供三端点复用同一实现，避免分散复制（架构一致性）。
function makeGuestEnabledGuard(prisma) {
    return async (req, res, next) => {
        const schoolCode = req.body?.schoolCode || req.query?.schoolCode
        if (!schoolCode) {
            return res.status(400).json({ error: '❌ 缺少学校代码（schoolCode）' })
        }
        try {
            const row = await prisma.schoolCustomization.findUnique({
                where: { school_code: schoolCode },
                select: { guest_enabled: true }
            })
            // fail-closed：记录不存在 或 guest_enabled 非 true 一律视为关闭，拒绝放行
            const enabled = row?.guest_enabled === true
            if (!enabled) {
                return res.status(403).json({ error: '❌ 该校未开放访客入口，请联系管理员' })
            }
            next()
        } catch (err) {
            // fail-closed：开关校验不可用时拒绝签发，而非静默放行
            console.error('[guest] 校验 guest_enabled 失败:', err)
            return res.status(503).json({ error: '访客服务暂不可用，请稍后重试' })
        }
    }
}

export function createGuestRoutes(userManager, prisma, jwtSecret) {
    const router = express.Router()
    const { authenticateUser, requireGuestReadOnly } = createAuthMiddleware(userManager, prisma)
    // TD-GuestGate: 供三端点复用的开关校验中间件
    const checkGuestEnabled = makeGuestEnabledGuard(prisma)

    const requireGuest = (req, res, next) => {
        if (!req.user || req.user.role !== 'guest') {
            return res.status(403).json({ error: '❌ 仅访客可访问' })
        }
        next()
    }

    // 访客自注册（NB-12: 加注册限流；TD-GuestGate: 强制校验 guest_enabled 开关）
    // 权限模型：自注册访客一律为 readonly，且不携带任何导出权限；
    // 若勾选「希望查看病原体数据」仅登记意向（request_pathogen_view），真实权限 can_view_pathogen
    // 默认关闭，须由学校 manager 经 pathogen_access 申请审批后才会置 true（且仍只读、绝不授导出）。
    router.post('/register', guestRegisterLimiter, checkGuestEnabled, async (req, res) => {
        let db = null  // H5: 提升到 try 外，避免 catch 块 ReferenceError
        try {
            const {
                username,
                email,
                password,
                full_name,
                // 自注册强制 readonly：即便前端误传 export_applicant 也一律降级为 readonly，
                // 防止绕过「注册不授导出」的安全约束。
                guest_type = 'readonly',
                request_pathogen_view = false,
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

            // 自注册只接受 readonly（export_applicant 不允许自助注册）
            const effectiveGuestType = (guest_type === 'export_applicant') ? 'readonly' : 'readonly'

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
                    // 注册只读类型，绝不开放导出
                    guest_type: effectiveGuestType,
                    // 安全硬约束：自注册访客永远没有导出权限
                    has_export_permission: false,
                    // 病原体查看权限默认关闭，仅当登记意向时记录，后续须经审批才置 true
                    can_view_pathogen: false,
                    // 登记意向：true 仅表示「希望申请」，不表示已获权限
                    request_pathogen_view: !!request_pathogen_view,
                    valid_until: validUntil,
                    status: 'active',
                    created_by: null
                }
            })

            const token = makeGuestToken(guest, schoolCode, jwtSecret)
            return res.status(201).json({
                success: true,
                token,
                guest: serializeGuest(guest),
                // 向前端明确：是否登记了病原体查看意向，便于前端引导走审批流程
                requestPathogenView: !!request_pathogen_view
            })
        } catch (error) {
            // H5: 防御性处理——db 在 try 块中赋值，P2002 重复键冲突需要回查，
            // 若 db 在赋值前已抛异常（如 createTenantClient 失败），则 db 为 null。
            if (error.code === 'P2002' && db) {
                const existing = await db.guest.findUnique({ where: { username: req.body?.username } })
                if (existing) {
                    // schoolCode 在 try 块内 const 解构，catch 块不可见，改从 req.body 读取避免 ReferenceError
                    const token = makeGuestToken(existing, req.body?.schoolCode, jwtSecret)
                    return res.status(200).json({ success: true, token, guest: serializeGuest(existing), idempotent: true })
                }
            }
            return res.status(400).json({ error: `注册失败` })
        }
    })

    // 访客登录（NB-12: 加登录限流；TD-GuestGate: 强制校验 guest_enabled 开关）
    router.post('/login', guestLoginLimiter, checkGuestEnabled, async (req, res) => {
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
    // TD-GuestGate: 增加限流 + 强制校验 guest_enabled 开关（原无任何凭证与限流，可直接枚举学校代码）。
    router.post('/quick-access', quickAccessLimiter, checkGuestEnabled, async (req, res) => {
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
                guest_type: 'readonly',
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
                    guest_type: 'readonly',
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

    // 提交申请（request_type: pathogen_access=查看病原体 / export=数据导出）
    router.post('/submit', authenticateUser, requireGuest, async (req, res) => {
        try {
            const { request_type, request_reason, request_data } = req.body
            if (!request_type) {
                return res.status(400).json({ error: '❌ 缺少申请类型' })
            }
            // NB: 申请类型白名单校验，防止注入未知类型
            if (!VALID_REQUEST_TYPES.has(request_type)) {
                return res.status(400).json({ error: '❌ 非法的申请类型' })
            }

            const db = createTenantClient(prisma, req.user.schoolCode)
            const created = await db.guestExportRequest.create({
                data: {
                    guest_id: req.user.guestId,
                    request_type,
                    request_reason: request_reason || null,
                    request_data: request_data || null,
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

    // 权限状态（同时返回病原体查看权限与导出权限，二者独立）
    router.get('/check-permission', authenticateUser, requireGuest, async (req, res) => {
        try {
            const db = createTenantClient(prisma, req.user.schoolCode)
            const guest = await db.guest.findUnique({ where: { id: req.user.guestId } })
            return res.json({
                has_export_permission: guest?.has_export_permission || false,
                can_view_pathogen: guest?.can_view_pathogen || false,
                request_pathogen_view: guest?.request_pathogen_view || false,
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

    // 审批通过：按 request_type 授予对应权限（pathogen_access→can_view_pathogen；export→has_export_permission）
    // 安全约束：pathogen_access 审批通过【绝不】开放导出权限；二者相互独立。
    router.post('/admin/:requestId/approve', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { requestId } = req.params
            const request = await req.db.guestExportRequest.findUnique({ where: { id: requestId } })
            if (!request || request.status !== 'pending') {
                return res.status(404).json({ error: '❌ 申请不存在或已处理' })
            }

            // 依据申请类型决定授予的字段（最小权限原则）
            const isPathogen = request.request_type === 'pathogen_access'
            const permissionPatch = isPathogen
                ? { can_view_pathogen: true }                 // 查看病原体：仅开病原体只读，不碰导出
                : { has_export_permission: true }             // 导出：仅开导出

            await req.db.$transaction(async (tx) => {
                await tx.guestExportRequest.update({
                    where: { id: requestId },
                    data: { status: 'approved', reviewed_by: req.user.userId, reviewed_at: new Date() },
                })
                await tx.guest.update({
                    where: { id: request.guest_id },
                    data: permissionPatch,
                })
            })

            await writeTenantAuditLog(req.db, {
                actorId: req.user.userId,
                action: isPathogen ? 'guest_pathogen_approve' : 'guest_export_approve',
                resourceType: 'guest_export_request',
                resourceId: requestId,
                details: { guest_id: request.guest_id, request_type: request.request_type },
                ip: req.ip || null,
            })

            res.json({
                success: true,
                message: isPathogen ? '✅ 已批准病原体查看申请（只读，不含导出权限）' : '✅ 已批准导出申请'
            })
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
                details: { guest_id: request.guest_id, request_type: request.request_type },
                ip: req.ip || null,
            })

            res.json({ success: true, message: '✅ 已驳回申请' })
        } catch (error) {
            console.error('❌ Error rejecting export request:', error)
            res.status(400).json({ error: `驳回失败` })
        }
    })

    return router
}

export default { createGuestRoutes, createGuestExportRequestRoutes }
