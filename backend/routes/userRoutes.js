/**
 * User Authentication Routes (Prisma-based)
 * 用户注册、登录、个人资料、密码管理等API端点
 */

import express from 'express'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'
import { rateLimit } from '../middleware/validationMiddleware.js'
import jwt from 'jsonwebtoken'

export function createUserRoutes(userManager) {
    const router = express.Router()

    // ====== Authentication Middleware（统一从 authMiddleware.js 导入）======
    const { authenticateUser, authorizeRoles } = createAuthMiddleware(userManager)

    // P2-01: 登录接口专项限流（每 IP 每 15 分钟最多 10 次尝试），防止暴力破解
    const loginRateLimit = rateLimit(
        Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
        Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)
    )

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
            // 唯一约束冲突（P2002）返回 409，其余沿用 400
            res.status(error.status || 400).json({ error: `❌ 注册失败: ${error.message}` })
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

            const result = await userManager.forTenant(schoolCode).loginUser(username, password)
            res.json(result)
        } catch (error) {
            res.status(401).json({ error: `❌ 登录失败: ${error.message}` })
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

    // 刷新访问令牌（TD-RefreshToken: 优先使用 X-Refresh-Token header，兼容 access token fallback）
    router.post('/refresh-token', async (req, res) => {
        try {
            const jwtSecret = process.env.JWT_SECRET
            if (!jwtSecret) {
                return res.status(500).json({ error: '❌ 服务器未配置 JWT_SECRET' })
            }

            let userId, schoolCode

            // 优先使用 X-Refresh-Token header
            const refreshToken = req.headers['x-refresh-token']
            if (refreshToken) {
                try {
                    // DS-02: refresh token 使用独立密钥（无 JWT_REFRESH_SECRET 时派生，保证与 access 密钥不同）
                    // DS-01: 显式限定算法白名单，防 'none'/RS256 混淆绕过
                    const refreshSecret = process.env.JWT_REFRESH_SECRET || `${jwtSecret}:refresh`
                    const decoded = jwt.verify(refreshToken, refreshSecret, { algorithms: ['HS256'] })
                    // DS-02: 令牌类型隔离——access token 不得当 refresh token 用
                    if (decoded.type !== 'refresh') {
                        return res.status(401).json({ error: '❌ Refresh token 类型无效' })
                    }
                    userId = decoded.userId
                    schoolCode = decoded.schoolCode
                } catch (e) {
                    return res.status(401).json({ error: '❌ Refresh token 无效或已过期' })
                }
            } else {
                // Fallback: 使用 access token（向后兼容）
                const authHeader = req.headers.authorization
                if (!authHeader || !authHeader.startsWith('Bearer ')) {
                    return res.status(401).json({ error: '❌ 缺少授权令牌' })
                }
                try {
                    // DS-01: 显式限定算法白名单
                    const decoded = jwt.verify(authHeader.substring(7), jwtSecret, { algorithms: ['HS256'] })
                    // DS-02: refresh token 不得当 access token 用（类型隔离双向生效）
                    if (decoded.type === 'refresh') {
                        return res.status(401).json({ error: '❌ 令牌类型无效' })
                    }
                    userId = decoded.userId
                    schoolCode = decoded.schoolCode
                } catch (e) {
                    return res.status(401).json({ error: '❌ 访问令牌无效或已过期' })
                }
            }

            if (!userId || !schoolCode) {
                return res.status(401).json({ error: '❌ 令牌载荷缺失' })
            }

            const profileResult = await userManager.forTenant(schoolCode).getUserProfile(userId)
            const dbUser = profileResult?.data

            if (!dbUser || dbUser.status !== 'active') {
                return res.status(401).json({ error: '❌ 用户状态无效，无法刷新令牌' })
            }

            const { token, expiresIn } = userManager.buildAccessToken({
                id: dbUser.id,
                username: dbUser.username,
                email: dbUser.email,
                role: dbUser.role,
                school_code: dbUser.school_code
            })

            res.json({
                success: true,
                token,
                expiresIn
            })
        } catch (error) {
            res.status(401).json({ error: `❌ 令牌刷新失败: ${error.message}` })
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
            res.status(400).json({ error: `❌ 获取用户信息失败: ${error.message}` })
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
            res.status(400).json({ error: `❌ 更新失败: ${error.message}` })
        }
    })

    // 修改密码
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
            res.status(400).json({ error: `❌ 修改密码失败: ${error.message}` })
        }
    })

    // ====== Admin Routes ======

    // 获取所有用户列表
    router.get('/list', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { limit = 100, offset = 0 } = req.query
            const result = await userManager.forTenant(req.user.schoolCode).getUserList(parseInt(limit), parseInt(offset))
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 获取用户列表失败: ${error.message}` })
        }
    })

    // 禁用用户
    router.post('/:userId/disable', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const result = await userManager.forTenant(req.user.schoolCode).disableUser(req.params.userId)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 禁用用户失败: ${error.message}` })
        }
    })

    // 启用用户
    router.post('/:userId/enable', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const result = await userManager.forTenant(req.user.schoolCode).enableUser(req.params.userId)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 启用用户失败: ${error.message}` })
        }
    })

    // 修改用户角色
    router.post('/:userId/role', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { newRole } = req.body

            if (!newRole) {
                return res.status(400).json({ error: '❌ 缺少角色信息' })
            }

            const result = await userManager.forTenant(req.user.schoolCode).changeUserRole(req.params.userId, newRole)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 修改角色失败: ${error.message}` })
        }
    })

    // 重置用户密码（管理员操作）
    router.post('/:userId/reset-password', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { newPassword } = req.body

            if (!userManager.isStrongPassword(newPassword)) {
                return res.status(400).json({ error: '❌ 新密码至少8个字符，且必须包含字母和数字' })
            }

            const result = await userManager.forTenant(req.user.schoolCode).resetPassword(req.params.userId, newPassword)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 重置密码失败: ${error.message}` })
        }
    })

    // 兼容前端历史路径: /reset-password/:userId
    router.post('/reset-password/:userId', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            const { newPassword } = req.body

            if (!userManager.isStrongPassword(newPassword)) {
                return res.status(400).json({ error: '❌ 新密码至少8个字符，且必须包含字母和数字' })
            }

            const result = await userManager.forTenant(req.user.schoolCode).resetPassword(req.params.userId, newPassword)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 重置密码失败: ${error.message}` })
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

            const result = await userManager.forTenant(req.user.schoolCode).adminUpdateUser(req.params.userId, normalizedUpdates)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 更新用户失败: ${error.message}` })
        }
    })

    // 删除用户
    router.delete('/:userId', authenticateUser, authorizeRoles('admin', 'manager'), async (req, res) => {
        try {
            // P1-17: 防止管理员删除自身账号
            if (req.user && req.user.userId === req.params.userId) {
                return res.status(400).json({ error: '❌ 不能删除自己的账号' })
            }

            // P1-17: 防止删除最后一个 admin 导致系统锁死
            const targetUser = await userManager.forTenant(req.user.schoolCode).prisma.user.findUnique({ where: { id: req.params.userId } })
            if (targetUser && targetUser.role === 'admin') {
                const adminCount = await userManager.forTenant(req.user.schoolCode).prisma.user.count({ where: { role: 'admin', status: 'active' } })
                if (adminCount <= 1) {
                    return res.status(400).json({ error: '❌ 无法删除最后一个管理员账号，系统将无法管理' })
                }
            }

            const result = await userManager.forTenant(req.user.schoolCode).deleteUser(req.params.userId)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 删除用户失败: ${error.message}` })
        }
    })

    return router
}

export default createUserRoutes
