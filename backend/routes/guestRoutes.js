/**
 * Guest Routes（访客只读访问，TD-Guest 收口）
 *
 * 端点：
 *   POST /api/guest/register              已关闭（访客自助注册不开放）
 *   POST /api/guest/verify-token          校验访客令牌
 *   POST /api/guest/quick-access          P0-07 快速访问：无需凭证，签发只读限权 JWT（2h）
 *   GET  /api/guest/stats                 BS-09 访客看板汇总统计（仅聚合，不返回记录明细）
 *
 * 权限模型（写死，不开放申请/审批）：
 *   - 访客仅 readonly，默认无导出权限，默认不可查看病原体数据；
 *   - 不提供自助注册、数据导出申请、病原体查看申请及任何审批入口。
 *
 * 租户隔离：quick-access 按请求体 schoolCode 用 createTenantClient 落到对应 schema；
 * 其余需鉴权的端点从 JWT（req.user.schoolCode）取租户，与全局认证一致。
 * guest 令牌字段：{ role:'guest', schoolCode, guestId, guest_type, has_export_permission, can_view_pathogen }。
 */

import express from 'express'
import jwt from 'jsonwebtoken'
import { createTenantClient } from '../lib/tenantClient.js'
import { isValidSchoolCode } from '../lib/tenantProvisioner.js'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'
import { rateLimit } from '../middleware/validationMiddleware.js'

// TD-GuestGate: quick-access 无凭证签发只读 JWT，需额外限流防批量枚举学校代码拉取数据
const quickAccessLimiter = rateLimit(30, 60 * 1000)     // 每分钟30次

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

const GUEST_JWT_MAX_AGE = 2 * 60 * 60 * 1000 // 2h

export function createGuestRoutes(userManager, prisma, jwtSecret) {
    const router = express.Router()
    const { authenticateUser, requireGuestReadOnly } = createAuthMiddleware(userManager, prisma)

    // 局部 requireGuest：仅允许 guest 角色访问（createAuthMiddleware 未导出该中间件）
    const requireGuest = (req, res, next) => {
        if (req.user && req.user.role === 'guest') return next()
        return res.status(403).json({ error: '❌ 仅访客可访问该接口' })
    }

    // 访客自助注册已关闭：本系统仅由管理端或快速访问创建访客会话，不开放任何注册申请。
    router.post('/register', (req, res) => {
        return res.status(403).json({ error: '访客自助注册已关闭，如需长期访问请联系管理员申请 viewer 账号。' })
    })

    // 校验访客令牌
    router.post('/verify-token', authenticateUser, requireGuest, (req, res) => {
        return res.json({
            valid: true,
            guestId: req.user.guestId,
            guest_type: req.user.guest_type,
            has_export_permission: req.user.has_export_permission,
            can_view_pathogen: req.user.can_view_pathogen,
            schoolCode: req.user.schoolCode
        })
    })

    // P0-07: 快速访问入口，无凭证签发只读 JWT（2h 有效）
    router.post('/quick-access', quickAccessLimiter, async (req, res) => {
        try {
            const { schoolCode } = req.body

            if (!schoolCode || !isValidSchoolCode(schoolCode)) {
                return res.status(400).json({ error: '缺少或无效的学校代码' })
            }

            const db = createTenantClient(prisma, schoolCode)
            const school = await db.school.findUnique({ where: { code: schoolCode } })
            if (!school) {
                return res.status(404).json({ error: '学校不存在' })
            }

            if (!school.guest_enabled) {
                return res.status(403).json({ error: '该校未开放访客访问' })
            }

            const visibleTypes = Array.isArray(school.visible_types) ? school.visible_types : []
            const validUntil = new Date(Date.now() + GUEST_JWT_MAX_AGE)

            const guestRecord = await db.guest.upsert({
                where: { username: `quick_${schoolCode}` },
                update: {
                    guest_type: 'readonly',
                    has_export_permission: false,
                    can_view_pathogen: false,
                    request_pathogen_view: false,
                    valid_until: validUntil,
                    status: 'active'
                },
                create: {
                    username: `quick_${schoolCode}`,
                    email: null,
                    password_hash: 'quick_access_no_password',
                    full_name: '快速访客',
                    guest_type: 'readonly',
                    has_export_permission: false,
                    can_view_pathogen: false,
                    request_pathogen_view: false,
                    valid_until: validUntil,
                    status: 'active'
                }
            })

            const tokenPayload = {
                userId: guestRecord.id,
                guestId: guestRecord.id,
                role: 'guest',
                guest_type: 'readonly',
                has_export_permission: false,
                can_view_pathogen: false,
                schoolCode: schoolCode,
                iat: Math.floor(Date.now() / 1000)
            }

            const token = jwt.sign(tokenPayload, jwtSecret, { expiresIn: '2h' })

            return res.json({
                success: true,
                token,
                guest: {
                    ...serializeGuest(guestRecord),
                    guest_type: 'readonly',
                    has_export_permission: false,
                    can_view_pathogen: false,
                    visibleTypes,
                    is_quick_access: true,
                    school_code: schoolCode,
                    school_name: school.name
                },
                expiresIn: GUEST_JWT_MAX_AGE
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

export default { createGuestRoutes }
