/**
 * User Authentication Routes (Prisma-based)
 * 用户注册、登录、个人资料、密码管理等API端点
 */

import express from 'express'
import { createAuthMiddleware, revokeToken, revokeAllUserTokens, isTokenRevoked, getRevocationInfo, getTokenRevocationReason } from '../middleware/authMiddleware.js'
import { rateLimit } from '../middleware/validationMiddleware.js'
import { isValidSchoolCode } from '../lib/tenantProvisioner.js'

export function createUserRoutes(userManager) {
    const router = express.Router()

    // ====== Authentication Middleware（统一从 authMiddleware.js 导入）======
    const { authenticateUser, authorizeRoles } = createAuthMiddleware(userManager)

    // 开发/测试环境放宽登录限流（避免反复调试被 429 锁死）；生产环境保持严格。
    // 显式设置的环境变量始终优先，可覆盖此默认值。
    const isProduction = process.env.NODE_ENV === 'production'

    // P2-01: 登录接口专项限流（生产每 IP 每 15 分钟 10 次；开发/测试放宽）
    const loginRateLimit = rateLimit(
        Number(process.env.LOGIN_RATE_LIMIT_MAX || (isProduction ? 10 : 1000)),
        Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)
    )

    // DS3-M1: 平台超管登录限流（生产每 IP 每 15 分钟 5 次；开发/测试放宽）
    const superAdminLoginRateLimit = rateLimit(
        Number(process.env.SUPER_ADMIN_LOGIN_RATE_LIMIT_MAX || (isProduction ? 5 : 1000)),
        Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)
    )

    // 登录失败错误的统一出口：账号锁定（DS3-M2）返回 423 + 明确但不泄露细节的提示，
    // 其余一律 401 通用文案（不区分用户不存在/密码错误/已禁用，防枚举与状态探测）
    function respondLoginError(res, error) {
        if (error && error.code === 'ACCOUNT_LOCKED') {
            return res.status(423).json({ error: '❌ 登录失败次数过多，该账号已被临时锁定，请稍后再试' })
        }
        return res.status(401).json({ error: `登录失败` })
    }

    // 验证令牌为未认证接口，单独限流避免被枚举攻击
    const verifyTokenRateLimit = rateLimit(30, 60 * 1000)

    // ====== Public Routes ======

    // 用户注册（需 admin 权限）
    router.post('/register', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { username, phone, password, fullName } = req.body

            if (!username || !password || !fullName) {
                return res.status(400).json({ error: '❌ 缺少必要字段' })
            }

            const result = await userManager.forTenant(req.user.schoolCode).registerUser(username, phone, password, fullName)
            res.status(201).json(result)
        } catch (error) {
            // P14: 仅透出业务校验错误(validation 标记),其余(数据库/系统层)统一返回"注册失败"
            if (error.validation) {
                return res.status(error.status || 400).json({ error: error.message })
            }
            console.error('❌ [user] 注册失败:', error)
            res.status(error.status || 400).json({ error: '注册失败' })
        }
    })

    // 用户登录（P2-01: 增加专项限流）
    // schoolCode 来自请求体：登录前尚不知学校，需先据此定位 schoolCode 对应的 schema（schoolCode 即 schema 名，如 school-a）的 User 表
    router.post('/login', loginRateLimit, async (req, res) => {
        try {
            const { username, password, schoolCode } = req.body

            if (!username || !password) {
                return res.status(400).json({ error: '❌ 用户名或密码缺失' })
            }

            // NB-04: 登录前校验 schoolCode，防止非法 code 意外命中 public schema 超管账号
            if (!isValidSchoolCode(schoolCode)) {
                return res.status(400).json({ error: '❌ 非法学校代码' })
            }

            // P0-1C: 读取设备指纹，写入 refresh token 实现同设备绑定
            const deviceId = (req.headers['x-device-id'] || '').trim().slice(0, 128) || null
            const result = await userManager.forTenant(schoolCode).loginUser(username, password, deviceId)
            res.json(result)
        } catch (error) {
            respondLoginError(res, error)
        }
    })

    // 平台超管专用登录（与普通用户登录完全分离，无需 schoolCode）
    // 平台超管账号（role=admin 且 school_code 为空）落在 public schema，
    // 普通租户用户无法以此入口登录，天然隔离。
    // DS3-M1: 补挂专项限流（此前该入口完全无限流，可被无限暴力破解）
    router.post('/super-admin/login', superAdminLoginRateLimit, async (req, res) => {
        try {
            const { username, password } = req.body

            if (!username || !password) {
                return res.status(400).json({ error: '❌ 用户名或密码缺失' })
            }

            // forTenant(null) 返回使用全局 prisma（public schema）的实例，直接查询平台超管账号
            // P0-1C: 超管登录同样绑定设备指纹
            const deviceId = (req.headers['x-device-id'] || '').trim().slice(0, 128) || null
            const result = await userManager.forTenant(null).loginUser(username, password, deviceId)

            // 二次校验：必须是平台超管（role=admin 且无 schoolCode）；
            // 普通租户用户/operator/viewer 即使密码正确也一律拒绝，强制走普通登录入口
            if (result.user.role !== 'admin' || result.user.schoolCode) {
                return res.status(403).json({ error: '❌ 该账号不是平台超级管理员，请从普通登录入口登录' })
            }

            res.json(result)
        } catch (error) {
            respondLoginError(res, error)
        }
    })

    // 验证Token有效性（未认证接口，单独限流防枚举）
    router.post('/verify-token', verifyTokenRateLimit, (req, res) => {
        const authHeader = req.headers.authorization
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ valid: false, error: '❌ 缺少令牌' })
        }

        const token = authHeader.substring(7)
        const verification = userManager.verifyToken(token)

        if (!verification.valid) {
            return res.status(401).json({
                valid: false,
                error: '❌ 令牌无效或已过期',
                details: verification.error
            })
        }

        const u = verification.user
        res.json({
            valid: true,
            // 仅返回最小必要字段，避免泄漏完整 payload
            user: {
                userId: u.userId,
                username: u.username,
                role: u.role,
                schoolCode: u.schoolCode || null,
            }
        })
    })

    // 登出（JWT 无状态，服务端无需作废；返回 200 供前端统一清理本地态）
    router.post('/logout', authenticateUser, (req, res) => {
        res.json({ success: true, message: '已登出' })
    })

    // 刷新访问令牌（DS3-H1 重构，破坏性变更）：
    //   - 仅接受 X-Refresh-Token 中的合法 refresh token，已移除 access-token fallback
    //     （旧行为允许任意有效 access token 无限自我续期，事实上永不过期）；
    //   - 一次性轮转：旧 refresh token 用后立即写入吊销表，签发新的 access+refresh 对；
    //   - 重放检测：同一 refresh token 二次使用 → 判定疑似泄露，吊销该用户全部会话（H2）；
    //   - DS3-H2: 以 DB 权威 school_code 交叉校验 token 中的 schoolCode，防租户绑定漂移。
    router.post('/refresh-token', async (req, res) => {
        try {
            const refreshTokenHeader = req.headers['x-refresh-token']
            if (!refreshTokenHeader) {
                return res.status(401).json({ error: '❌ 缺少 Refresh Token，请重新登录' })
            }

            // 1. 验签（独立密钥 + HS256 白名单 + type:'refresh' + jti/userId 强制）
            let decoded
            try {
                decoded = userManager.verifyRefreshToken(refreshTokenHeader)
            } catch (e) {
                return res.status(401).json({ error: '❌ Refresh token 无效或已过期' })
            }

            const userId = decoded.userId
            const schoolCode = decoded.schoolCode || null // 平台超管为 null（public schema），合法
            const rootPrisma = userManager.rootPrisma

            // P0-1C 设备绑定校验：refresh token 携带 deviceId claim（记住我场景）时，
            // 必须与请求 X-Device-Id 一致；不一致 → 疑似跨设备窃取，拒绝轮转并要求重新登录。
            // 老 token 无该 claim → 跳过校验（向后兼容）。
            if (decoded.deviceId) {
                const reqDevice = (req.headers['x-device-id'] || '').trim().slice(0, 128)
                if (!reqDevice || reqDevice !== decoded.deviceId) {
                    await userManager.logSecurityEvent('REFRESH_DEVICE_MISMATCH', {
                        userId, schoolCode, jti: decoded.jti, ip: req.ip
                    })
                    return res.status(401).json({
                        error: '❌ 会话设备不匹配，已拒绝刷新，请重新登录',
                        code: 'REFRESH_DEVICE_MISMATCH'
                    })
                }
            }

            // 2. 一次性轮转 + 重放检测（原子操作）：
            //    将旧 refresh jti 写入吊销表；若 INSERT 冲突（该 jti 已存在）说明此
            //    refresh token 已被使用过 → 判定为重放/疑似泄露，吊销该用户全部会话。
            const freshlyRotated = await revokeToken(rootPrisma, {
                jti: decoded.jti,
                userId,
                schoolCode,
                tokenType: 'refresh',
                reason: 'rotated',
                expiresAt: new Date((decoded.exp || Math.floor(Date.now() / 1000)) * 1000)
            })
            if (!freshlyRotated) {
                // 第六轮（多标签页并发刷新防误吊销）：区分两种「同一 refresh token 被二次使用」——
                //   a) 并发轮转竞争（benign）：两个标签页/请求几乎同时用同一 token 刷新，
                //      输家在赢家写入吊销记录后的极短时间内到达。特征：已有记录
                //      reason='rotated' 且 revoked_at 距今 ≤ REFRESH_REPLAY_GRACE_MS（默认 30s）。
                //      处置：仅拒绝本次请求（401 + code REFRESH_CONCURRENT），不吊销全部会话，
                //      前端收到该 code 后改为采用其他标签页已写入共享存储的新 token。
                //   b) 宽限期外的再次使用（真重放/疑似泄露）：维持原有核弹语义——吊销全部会话。
                // 安全代价（明确接受并记录）：若攻击者先窃取并轮转了 token，受害者恰在 30s 宽限
                // 内使用旧 token，将不会触发全量吊销（盗用检测延迟）。事件仍以
                // SECURITY:REFRESH_CONCURRENT_ROTATION 落库，供告警通道审计。
                const graceMs = Number(process.env.REFRESH_REPLAY_GRACE_MS || 30_000)
                let benignConcurrent = false
                try {
                    const prior = await getRevocationInfo(rootPrisma, decoded.jti)
                    benignConcurrent = !!prior &&
                        prior.reason === 'rotated' &&
                        (Date.now() - new Date(prior.revoked_at).getTime()) <= graceMs
                } catch { /* 查询失败按真重放处理（fail-closed，维持核弹语义） */ }

                if (benignConcurrent) {
                    await userManager.logSecurityEvent('REFRESH_CONCURRENT_ROTATION', {
                        userId, schoolCode, jti: decoded.jti, ip: req.ip
                    })
                    return res.status(401).json({
                        error: '❌ 刷新令牌已在其他窗口轮转，请使用最新会话',
                        code: 'REFRESH_CONCURRENT'
                    })
                }

                await revokeAllUserTokens(rootPrisma, { userId, schoolCode, reason: 'refresh_replay' })
                // 预留审计接口（窗口 2）：安全事件统一以 SECURITY:* 前缀落 SystemLog
                await userManager.logSecurityEvent('REFRESH_TOKEN_REPLAY', {
                    userId, schoolCode, jti: decoded.jti, ip: req.ip
                })
                return res.status(401).json({ error: '❌ 会话安全异常，已强制下线，请重新登录' })
            }

            // 3. 该用户是否已被全量吊销（user_all 记录晚于本 token 签发时间）
            if (await isTokenRevoked(rootPrisma, { jti: null, userId, iat: decoded.iat })) {
                // REVOKED-REASON: 附带吊销原因（如 role_change_db_trigger / user_disable / refresh_replay），
                // 前端据此提示「权限已被超级管理员更改」等，避免强制登出时用户一头雾水。
                let revokeReason = null
                try {
                    revokeReason = await getTokenRevocationReason(rootPrisma, { jti: null, userId, iat: decoded.iat })
                } catch { /* 查询失败仅丢失提示信息，不影响吊销判定本身 */ }
                return res.status(401).json({ error: '❌ 会话已被吊销，请重新登录', code: 'REVOKED', reason: revokeReason })
            }

            // 4. DS3-H2: userId ↔ schema 绑定校验——以 DB 中查得的权威 school_code 为准
            const profileResult = await userManager.forTenant(schoolCode).getUserProfile(userId).catch(() => null)
            const dbUser = profileResult?.data

            if (!dbUser || dbUser.status !== 'active') {
                return res.status(401).json({ error: '❌ 用户状态无效，无法刷新令牌' })
            }
            if ((dbUser.school_code ?? null) !== schoolCode) {
                const err = new Error('refresh token 租户绑定不一致')
                err.code = 'TENANT_SCHEMA_MISMATCH'
                await userManager.logSecurityEvent('TENANT_SCHEMA_MISMATCH', {
                    userId,
                    tokenSchoolCode: schoolCode,
                    dbSchoolCode: dbUser.school_code ?? null,
                    ip: req.ip
                })
                return res.status(401).json({ error: '❌ 令牌租户信息异常，请重新登录' })
            }

            // 5. 签发新的 access + refresh 双令牌（轮转完成）
            // P0-1C: 轮转时继承原 refresh token 的 deviceId 绑定（保持一致设备指纹）
            const pair = userManager.buildTokenPair({
                id: dbUser.id,
                username: dbUser.username,
                email: dbUser.email,
                role: dbUser.role,
                school_code: dbUser.school_code
            }, decoded.deviceId || null)

            res.json({
                success: true,
                token: pair.token,
                expiresIn: pair.expiresIn,
                refreshToken: pair.refreshToken,
                refreshExpiresIn: pair.refreshExpiresIn
            })
        } catch (error) {
            console.error('❌ 令牌刷新异常:', error.message)
            res.status(401).json({ error: `令牌刷新失败` })
        }
    })

    // ====== Protected Routes ======

    // 获取当前用户信息
    router.get('/me', authenticateUser, async (req, res) => {
        try {
            const result = await userManager.forTenant(req.user.schoolCode).getUserProfile(req.user.userId)
            if (result?.success && result.data) {
                result.data.schoolCode = req.user.schoolCode || null
            }
            res.json(result)
        } catch (error) {
            console.error('❌ [user] 获取用户信息失败:', error)
            res.status(400).json({ error: `获取用户信息失败` })
        }
    })

    // 更新个人资料
    router.put('/me', authenticateUser, async (req, res) => {
        try {
            const { full_name, email } = req.body
            const result = await userManager.forTenant(req.user.schoolCode).updateUserProfile(req.user.userId, {
                full_name,
                email
            })
            res.json(result)
        } catch (error) {
            console.error('❌ [user] 更新个人资料失败:', error)
            res.status(400).json({ error: `更新失败` })
        }
    })

    // 修改密码
    // ===== 平台超管账号管理（仅平台超级管理员可操作）=====
function requirePlatformSuperAdmin(req, res, next) {
    const role = req.user?.role
    const schoolCode = req.user?.schoolCode || null
    if (role !== 'admin' || schoolCode) {
        return res.status(403).json({ error: '❌ 仅平台超级管理员可执行该操作' })
    }
    next()
}

// 列出平台超管
router.get('/super-admin', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const admins = await userManager.forTenant(null).listPlatformSuperAdmins()
        res.json({ admins })
    } catch (error) {
        console.error('❌ 获取超管列表失败:', error)
        res.status(500).json({ error: '获取超管列表失败: ' + error.message })
    }
})

// 新增平台超管
router.post('/super-admin', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { username, fullName, email, password } = req.body || {}
        if (!username || !fullName || !password) {
            return res.status(400).json({ error: '用户名、姓名和密码均为必填' })
        }
        const result = await userManager.forTenant(null).createPlatformSuperAdmin({ username, fullName, email, password })
        res.status(201).json(result)
    } catch (error) {
        console.error('❌ 创建超管失败:', error)
        res.status(400).json({ error: '创建超管失败: ' + error.message })
    }
})

// 删除平台超管
router.delete('/super-admin/:id', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const id = req.params.id
        if (!id) return res.status(400).json({ error: '无效的账号 ID' })
        await userManager.forTenant(null).deletePlatformSuperAdmin(id, req.user.userId)
        res.json({ success: true, message: '已删除' })
    } catch (error) {
        console.error('❌ 删除超管失败:', error)
        res.status(error.status || 400).json({ error: '删除超管失败: ' + error.message })
    }
})

// 编辑平台超管（仅允许修改 full_name / email；详见 UserManager.updatePlatformSuperAdmin 字段白名单）
router.put('/super-admin/:id', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const id = req.params.id
        if (!id) return res.status(400).json({ error: '无效的账号 ID' })
        const actor = {
            userId: req.user?.userId || null,
            username: req.user?.username || null,
            role: req.user?.role || null,
            schoolCode: req.user?.schoolCode || null,
            ip: req.ip || null
        }
        const { fullName, full_name, email } = req.body || {}
        const updates = {}
        // 同时支持 camelCase / snake_case 入参，与全站 REST 风格保持一致
        if (typeof fullName === 'string' || typeof full_name === 'string') {
            updates.full_name = (fullName ?? full_name)
        }
        if (typeof email === 'string' || email === null) {
            updates.email = email === null ? null : email
        }
        const result = await userManager.forTenant(null).updatePlatformSuperAdmin(id, updates, actor)
        res.json(result)
    } catch (error) {
        console.error('❌ 编辑超管失败:', error)
        const status = error.status || (error.message && /不存在|缺失/.test(error.message) ? 400 : 400)
        res.status(status).json({ error: '编辑超管失败: ' + error.message })
    }
})

// 重置平台超管密码（管理员强制重置，无需旧密码；被重置账号所有会话立即吊销）
router.post('/super-admin/:id/reset-password', authenticateUser, requirePlatformSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params
        const { newPassword } = req.body || {}
        if (!userManager.isStrongPassword(newPassword)) {
            return res.status(400).json({ error: '❌ 新密码至少8个字符，且必须包含字母和数字' })
        }
        const actor = {
            userId: req.user?.userId || null,
            username: req.user?.username || null,
            role: req.user?.role || null,
            schoolCode: req.user?.schoolCode || null,
            ip: req.ip || null
        }
        const result = await userManager.forTenant(null).resetPassword(id, newPassword, actor)
        res.json(result)
    } catch (error) {
        console.error('❌ 重置超管密码失败:', error)
        res.status(error.status || 400).json({ error: '重置超管密码失败: ' + error.message })
    }
})

router.post('/change-password', authenticateUser, async (req, res) => {
        try {
            const { oldPassword, newPassword } = req.body

            if (!oldPassword || !newPassword) {
                return res.status(400).json({ error: '❌ 缺少密码信息' })
            }

            if (!userManager.isStrongPassword(newPassword)) {
                return res.status(400).json({ error: '❌ 新密码至少8个字符，且必须包含字母和数字' })
            }

            const result = await userManager.forTenant(req.user.schoolCode).changePassword(
                req.user.userId,
                oldPassword,
                newPassword
            )
            res.json(result)
        } catch (error) {
            console.error('❌ [user] 修改密码失败:', error)
            res.status(400).json({ error: `修改密码失败` })
        }
    })

    // ====== Admin Routes ======

    // 窗口2（H4/P0）：高危管理操作需把操作者身份与来源 IP 传给 UserManager，
    // 用于服务端强制审计与提权拦截（不依赖前端上报）。
    const actorOf = (req) => ({
        userId: req.user?.userId || null,
        username: req.user?.username || null,
        role: req.user?.role || null,
        schoolCode: req.user?.schoolCode || null,
        ip: req.ip || null
    })

    // 获取所有用户列表
    router.get('/list', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { limit = 100, offset = 0 } = req.query
            const result = await userManager.forTenant(req.user.schoolCode).getUserList(Math.min(parseInt(limit) || 100, 500), Math.max(0, parseInt(offset) || 0))
            res.json(result)
        } catch (error) {
            console.error('❌ [user] 获取用户列表失败:', error)
            res.status(400).json({ error: `获取用户列表失败` })
        }
    })

    // 禁用用户
    router.post('/:userId/disable', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const result = await userManager.forTenant(req.user.schoolCode).disableUser(req.params.userId, actorOf(req))
            res.json(result)
        } catch (error) {
            res.status(error.status || 400).json({ error: error.status ? error.message : `禁用用户失败` })
        }
    })

    // 启用用户
    router.post('/:userId/enable', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const result = await userManager.forTenant(req.user.schoolCode).enableUser(req.params.userId, actorOf(req))
            res.json(result)
        } catch (error) {
            res.status(error.status || 400).json({ error: error.status ? error.message : `启用用户失败` })
        }
    })

    // 修改用户角色
    router.post('/:userId/role', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { newRole } = req.body

            if (!newRole) {
                return res.status(400).json({ error: '❌ 缺少角色信息' })
            }

            const result = await userManager.forTenant(req.user.schoolCode).changeUserRole(req.params.userId, newRole, actorOf(req))
            res.json(result)
        } catch (error) {
            res.status(error.status || 400).json({ error: error.status ? error.message : `修改角色失败` })
        }
    })

    // 重置用户密码（管理员操作）
    router.post('/:userId/reset-password', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { newPassword } = req.body

            if (!userManager.isStrongPassword(newPassword)) {
                return res.status(400).json({ error: '❌ 新密码至少8个字符，且必须包含字母和数字' })
            }

            const result = await userManager.forTenant(req.user.schoolCode).resetPassword(req.params.userId, newPassword, actorOf(req))
            res.json(result)
        } catch (error) {
            res.status(error.status || 400).json({ error: error.status ? error.message : `重置密码失败` })
        }
    })

    // 兼容前端历史路径: /reset-password/:userId
    router.post('/reset-password/:userId', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { newPassword } = req.body

            if (!userManager.isStrongPassword(newPassword)) {
                return res.status(400).json({ error: '❌ 新密码至少8个字符，且必须包含字母和数字' })
            }

            const result = await userManager.forTenant(req.user.schoolCode).resetPassword(req.params.userId, newPassword, actorOf(req))
            res.json(result)
        } catch (error) {
            res.status(error.status || 400).json({ error: error.status ? error.message : `重置密码失败` })
        }
    })

    // 管理员更新指定用户信息
    router.put('/:userId', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const payload = req.body || {}
            const normalizedUpdates = {
                username: payload.username,
                full_name: payload.full_name ?? payload.fullName,
                email: payload.email,
                phone: payload.phone,
                role: payload.role,
                status: payload.status ?? (payload.is_active === true ? 'active' : payload.is_active === false ? 'disabled' : undefined)
            }

            const result = await userManager.forTenant(req.user.schoolCode).adminUpdateUser(req.params.userId, normalizedUpdates, actorOf(req))
            res.json(result)
        } catch (error) {
            res.status(error.status || 400).json({ error: error.status ? error.message : `更新用户失败` })
        }
    })

    // 删除用户
    router.delete('/:userId', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            // P1-17: 防止管理员删除自身账号
            if (req.user && req.user.userId === req.params.userId) {
                return res.status(400).json({ error: '❌ 不能删除自己的账号' })
            }

            // P1-17: 防止删除最后一个 manager 导致该校无可用管理员
            // （租户内不存在 admin 角色——admin 仅在 public 平台层；
            //  原检查 role==='admin' 为死代码，改为 manager 与 deleteUser 内部 assertNotLastActiveManager 一致）
            const targetUser = await userManager.forTenant(req.user.schoolCode).prisma.user.findUnique({ where: { id: req.params.userId } })
            if (targetUser && targetUser.role === 'manager' && targetUser.status === 'active') {
                const managerCount = await userManager.forTenant(req.user.schoolCode).prisma.user.count({ where: { role: 'manager', status: 'active' } })
                if (managerCount <= 1) {
                    return res.status(400).json({ error: '❌ 无法删除最后一个管理员账号，系统将无法管理' })
                }
            }

            const result = await userManager.forTenant(req.user.schoolCode).deleteUser(req.params.userId, actorOf(req))
            res.json(result)
        } catch (error) {
            res.status(error.status || 400).json({ error: error.status ? error.message : `删除用户失败` })
        }
    })

    return router
}

export default createUserRoutes
