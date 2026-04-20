/**
 * User Authentication Routes
 * 用户注册、登录、个人资料、密码管理等API端点
 */

import express from 'express'
import UserManager from '../modules/UserManager.js'
import jwt from 'jsonwebtoken'

export function createUserRoutes(supabase, jwtSecret) {
    const router = express.Router()
    const userManager = new UserManager(supabase, jwtSecret)

    // ====== Authentication Middleware ======

    function authenticateUser(req, res, next) {
        const authHeader = req.headers.authorization
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: '❌ 缺少授权令牌' })
        }

        const token = authHeader.substring(7)
        try {
            const decoded = jwt.verify(token, jwtSecret)
            req.user = decoded
            next()
        } catch (error) {
            return res.status(401).json({ error: '❌ 令牌无效或已过期' })
        }
    }

    function authorizeAdmin(req, res, next) {
        if (req.user.role !== 'admin' && req.user.role !== 'manager') {
            return res.status(403).json({ error: '❌ 权限不足' })
        }
        next()
    }

    // ====== Public Routes ======

    // 用户注册
    router.post('/register', async (req, res) => {
        try {
            const { username, email, password, fullName } = req.body

            if (!username || !email || !password || !fullName) {
                return res.status(400).json({ error: '❌ 缺少必要字段' })
            }

            const result = await userManager.registerUser(username, email, password, fullName)
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
        const result = userManager.verifyToken(token)

        if (result.valid) {
            res.json({
                valid: true,
                user: result.user
            })
        } else {
            res.status(401).json({
                valid: false,
                error: result.error
            })
        }
    })

    // ====== Protected Routes ======

    // 获取当前用户信息
    router.get('/profile', authenticateUser, async (req, res) => {
        try {
            const result = await userManager.getUserProfile(req.user.userId)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 获取失败: ${error.message}` })
        }
    })

    // 更新用户信息
    router.put('/profile', authenticateUser, async (req, res) => {
        try {
            const { fullName, email } = req.body

            const result = await userManager.updateUserProfile(req.user.userId, {
                full_name: fullName,
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
                return res.status(400).json({ error: '❌ 缺少必要字段' })
            }

            const result = await userManager.changePassword(
                req.user.userId,
                oldPassword,
                newPassword
            )
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 修改失败: ${error.message}` })
        }
    })

    // 刷新Token
    router.post('/refresh-token', authenticateUser, (req, res) => {
        const newToken = jwt.sign(
            {
                userId: req.user.userId,
                username: req.user.username,
                email: req.user.email,
                role: req.user.role
            },
            jwtSecret,
            { expiresIn: '7d' }
        )

        res.json({
            success: true,
            token: newToken
        })
    })

    // ====== Admin Routes ======

    // 获取用户列表 (仅管理员)
    router.get('/list', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 100
            const offset = parseInt(req.query.offset) || 0

            const result = await userManager.getUserList(limit, offset)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 获取失败: ${error.message}` })
        }
    })

    // 禁用用户 (仅管理员)
    router.post('/disable/:userId', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { userId } = req.params

            // 防止禁用自己
            if (parseInt(userId) === req.user.userId) {
                return res.status(400).json({ error: '❌ 无法禁用自己' })
            }

            const result = await userManager.disableUser(parseInt(userId))
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 操作失败: ${error.message}` })
        }
    })

    // 启用用户 (仅管理员)
    router.post('/enable/:userId', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { userId } = req.params
            const result = await userManager.enableUser(parseInt(userId))
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 操作失败: ${error.message}` })
        }
    })

    // 更改用户角色 (仅管理员)
    router.post('/change-role/:userId', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { userId } = req.params
            const { role } = req.body

            if (!role) {
                return res.status(400).json({ error: '❌ 角色未指定' })
            }

            const result = await userManager.changeUserRole(parseInt(userId), role)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 操作失败: ${error.message}` })
        }
    })

    // 重置用户密码 (仅管理员)
    router.post('/reset-password/:userId', authenticateUser, authorizeAdmin, async (req, res) => {
        try {
            const { userId } = req.params
            const { newPassword } = req.body

            if (!newPassword) {
                return res.status(400).json({ error: '❌ 新密码未指定' })
            }

            const result = await userManager.resetPassword(parseInt(userId), newPassword)
            res.json(result)
        } catch (error) {
            res.status(400).json({ error: `❌ 操作失败: ${error.message}` })
        }
    })

    return router
}

export default createUserRoutes
