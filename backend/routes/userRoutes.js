/**
 * User Authentication Routes (Prisma-based)
 * 用户注册、登录、个人资料、密码管理等API端点
 */

import express from 'express'
import jwt from 'jsonwebtoken'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'

export function createUserRoutes(userManager) {
    const router = express.Router()

    // ====== Authentication Middleware（统一从 authMiddleware.js 导入）======
    const { authenticateUser, authorizeAdmin } = createAuthMiddleware(userManager)

    // ====== Public Routes ======

    // 用户注册（需 admin 权限）
    router.post('/register', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { username, phone, password, fullName } = req.body

            if (!username || !password || !fullName) {
                return res.status(400).json({ error: '❌ 缺少必要字段' })
            }

            const result = await userManager.registerUser(username, phone, password, fullName)
            res.status(201).json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 注册失败: ${error.message}` })
        }
    })

    // 用户登录
    router.post('/login', async (req, res) => {
        try {
            const { username, password } = req.body

            if (!username || !password) {
                return res.status(400).json({ error: '❌ 用户名或密码缺失' })
            }

            const result = await userManager.loginUser(username, password)
            res.json(result)
        } catch (error) {
            res.status(401).json({ error: `❌ 登录失败: ${error.message}` })
        }
    })

    // 验证Token有效性
    router.post('/verify-token', (req, res) => {
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

        res.json({
            valid: true,
            user: verification.user
        })
    })

    // ====== Protected Routes ======

    // 获取当前用户信息
    router.get('/me', authenticateUser, async (req, res) => {
        try {
            const result = await userManager.getUserProfile(req.user.userId)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 获取用户信息失败: ${error.message}` })
        }
    })

    // 更新个人资料
    router.put('/me', authenticateUser, async (req, res) => {
        try {
            const { full_name, email } = req.body
            const result = await userManager.updateUserProfile(req.user.userId, {
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

            if (newPassword.length < 6) {
                return res.status(400).json({ error: '❌ 新密码至少6个字符' })
            }

            const result = await userManager.changePassword(
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
    router.get('/list', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { limit = 100, offset = 0 } = req.query
            const result = await userManager.getUserList(parseInt(limit), parseInt(offset))
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 获取用户列表失败: ${error.message}` })
        }
    })

    // 禁用用户
    router.post('/:userId/disable', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const result = await userManager.disableUser(req.params.userId)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 禁用用户失败: ${error.message}` })
        }
    })

    // 启用用户
    router.post('/:userId/enable', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const result = await userManager.enableUser(req.params.userId)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 启用用户失败: ${error.message}` })
        }
    })

    // 修改用户角色
    router.post('/:userId/role', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { newRole } = req.body

            if (!newRole) {
                return res.status(400).json({ error: '❌ 缺少角色信息' })
            }

            const result = await userManager.changeUserRole(req.params.userId, newRole)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 修改角色失败: ${error.message}` })
        }
    })

    // 重置用户密码（管理员操作）
    router.post('/:userId/reset-password', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { newPassword } = req.body

            if (!newPassword || newPassword.length < 6) {
                return res.status(400).json({ error: '❌ 新密码至少6个字符' })
            }

            const result = await userManager.resetPassword(req.params.userId, newPassword)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 重置密码失败: ${error.message}` })
        }
    })

    // 兼容前端历史路径: /reset-password/:userId
    router.post('/reset-password/:userId', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { newPassword } = req.body

            if (!newPassword || newPassword.length < 6) {
                return res.status(400).json({ error: '❌ 新密码至少6个字符' })
            }

            const result = await userManager.resetPassword(req.params.userId, newPassword)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 重置密码失败: ${error.message}` })
        }
    })

    // 管理员更新指定用户信息
    router.put('/:userId', authenticateUser, authorizeAdmin, async (req, res) => {
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

            const result = await userManager.adminUpdateUser(req.params.userId, normalizedUpdates)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 更新用户失败: ${error.message}` })
        }
    })

    // 删除用户
    router.delete('/:userId', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const result = await userManager.deleteUser(req.params.userId)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 删除用户失败: ${error.message}` })
        }
    })

    return router
}

export default createUserRoutes
