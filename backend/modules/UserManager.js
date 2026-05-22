/**
 * UserManager - 用户管理模块 (Prisma + SQLite)
 * 处理用户注册、登录、密码管理等业务逻辑
 */

import bcryptjs from 'bcryptjs'
import jwt from 'jsonwebtoken'

export class UserManager {
    constructor(prismaClient, jwtSecret) {
        this.prisma = prismaClient
        this.jwtSecret = jwtSecret
    }

    // ====== User Registration ======

    async registerUser(username, phone, password, fullName) {
        try {
            // 1. 验证输入
            this.validateUserInput({ username, phone, password, fullName })

            // 2. 检查用户是否已存在
            const existingUser = await this.prisma.user.findUnique({
                where: { username }
            })

            if (existingUser) {
                throw new Error('用户名已存在')
            }

            // 3. 检查手机号是否已使用
            if (phone) {
                const existingPhone = await this.prisma.user.findFirst({
                    where: { phone }
                })
                if (existingPhone) {
                    throw new Error('手机号已被使用')
                }
            }

            // 4. 加密密码
            const passwordHash = await bcryptjs.hash(password, 10)

            // 5. 创建用户
            const autoEmail = `${username}@foodlab.local`
            const newUser = await this.prisma.user.create({
                data: {
                    username,
                    email: autoEmail,
                    phone: phone || null,
                    password_hash: passwordHash,
                    full_name: fullName,
                    role: 'user',
                    status: 'active'
                }
            })

            console.log(`✅ 用户注册成功: ${username}`)

            return {
                success: true,
                user: {
                    id: newUser.id,
                    username: newUser.username,
                    phone: newUser.phone,
                    full_name: newUser.full_name,
                    role: newUser.role
                },
                message: '注册成功'
            }
        } catch (error) {
            console.error(`❌ 用户注册失败: ${error.message}`)
            throw error
        }
    }

    // ====== User Login ======

    async loginUser(username, password) {
        try {
            // 1. 查找用户
            const user = await this.prisma.user.findUnique({
                where: { username }
            })

            if (!user) {
                throw new Error('用户不存在或密码错误')
            }

            // 2. 检查用户状态
            if (user.status !== 'active') {
                throw new Error('该用户已被禁用')
            }

            // 3. 验证密码
            const passwordMatch = await bcryptjs.compare(password, user.password_hash)

            if (!passwordMatch) {
                // 记录失败登录
                await this.logFailedLogin(user.id, username)
                throw new Error('用户不存在或密码错误')
            }

            // 4. 生成JWT Token
            const token = jwt.sign(
                {
                    userId: user.id,
                    username: user.username,
                    email: user.email,
                    role: user.role
                },
                this.jwtSecret,
                { expiresIn: '7d' }
            )

            // 5. 更新最后登录时间
            await this.updateLastLogin(user.id)

            // 6. 记录登录日志
            await this.logLogin(user.id, username)

            console.log(`✅ 用户登录成功: ${username}`)

            return {
                success: true,
                token,
                expiresIn: 7 * 24 * 3600, // 7 天（秒）
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    fullName: user.full_name,
                    role: user.role
                }
            }
        } catch (error) {
            console.error(`❌ 用户登录失败: ${error.message}`)
            throw error
        }
    }

    // ====== Password Management ======

    async changePassword(userId, oldPassword, newPassword) {
        try {
            // 1. 获取用户
            const user = await this.prisma.user.findUnique({
                where: { id: userId }
            })

            if (!user) {
                throw new Error('用户不存在')
            }

            // 2. 验证旧密码
            const passwordMatch = await bcryptjs.compare(oldPassword, user.password_hash)

            if (!passwordMatch) {
                throw new Error('旧密码错误')
            }

            // 3. 验证新密码
            if (newPassword.length < 6) {
                throw new Error('新密码至少6个字符')
            }

            // 4. 加密新密码
            const newPasswordHash = await bcryptjs.hash(newPassword, 10)

            // 5. 更新密码
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    password_hash: newPasswordHash,
                    updated_at: new Date()
                }
            })

            console.log(`✅ 用户 ${userId} 密码已更新`)

            return {
                success: true,
                message: '密码已更新'
            }
        } catch (error) {
            console.error(`❌ 密码更新失败: ${error.message}`)
            throw error
        }
    }

    async resetPassword(userId, newPassword) {
        try {
            // 验证新密码
            if (newPassword.length < 6) {
                throw new Error('密码至少6个字符')
            }

            // 加密新密码
            const passwordHash = await bcryptjs.hash(newPassword, 10)

            // 更新密码
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    password_hash: passwordHash,
                    updated_at: new Date()
                }
            })

            console.log(`✅ 用户 ${userId} 密码已重置`)

            return {
                success: true,
                message: '密码已重置'
            }
        } catch (error) {
            console.error(`❌ 密码重置失败: ${error.message}`)
            throw error
        }
    }

    // ====== User Profile ======

    async getUserProfile(userId) {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    username: true,
                    email: true,
                    full_name: true,
                    role: true,
                    status: true,
                    created_at: true,
                    last_login: true
                }
            })

            if (!user) {
                throw new Error('用户不存在')
            }

            return {
                success: true,
                data: user
            }
        } catch (error) {
            console.error(`❌ 获取用户信息失败: ${error.message}`)
            throw error
        }
    }

    async updateUserProfile(userId, updates) {
        try {
            // 允许更新的字段
            const allowedUpdates = ['full_name', 'email']
            const filteredUpdates = {}

            for (const key of allowedUpdates) {
                if (key in updates) {
                    filteredUpdates[key] = updates[key]
                }
            }

            filteredUpdates.updated_at = new Date()

            const updatedUser = await this.prisma.user.update({
                where: { id: userId },
                data: filteredUpdates,
                select: {
                    id: true,
                    username: true,
                    email: true,
                    full_name: true,
                    role: true,
                    status: true
                }
            })

            console.log(`✅ 用户 ${userId} 信息已更新`)

            return {
                success: true,
                data: updatedUser
            }
        } catch (error) {
            console.error(`❌ 更新用户信息失败: ${error.message}`)
            throw error
        }
    }

    // ====== User List ======

    async getUserList(limit = 100, offset = 0) {
        try {
            const users = await this.prisma.user.findMany({
                skip: offset,
                take: limit,
                select: {
                    id: true,
                    username: true,
                    phone: true,
                    full_name: true,
                    role: true,
                    status: true,
                    created_at: true,
                    last_login: true
                },
                orderBy: { created_at: 'desc' }
            })

            const count = await this.prisma.user.count()

            return {
                success: true,
                data: users,
                total: count,
                limit,
                offset
            }
        } catch (error) {
            console.error(`❌ 获取用户列表失败: ${error.message}`)
            throw error
        }
    }

    // ====== User Management (Admin) ======

    async disableUser(userId) {
        try {
            await this.prisma.user.update({
                where: { id: userId },
                data: { status: 'disabled' }
            })

            console.log(`✅ 用户 ${userId} 已禁用`)

            return {
                success: true,
                message: '用户已禁用'
            }
        } catch (error) {
            console.error(`❌ 禁用用户失败: ${error.message}`)
            throw error
        }
    }

    async enableUser(userId) {
        try {
            await this.prisma.user.update({
                where: { id: userId },
                data: { status: 'active' }
            })

            console.log(`✅ 用户 ${userId} 已启用`)

            return {
                success: true,
                message: '用户已启用'
            }
        } catch (error) {
            console.error(`❌ 启用用户失败: ${error.message}`)
            throw error
        }
    }

    async changeUserRole(userId, newRole) {
        try {
            const validRoles = ['user', 'admin', 'manager', 'operator', 'viewer']
            if (!validRoles.includes(newRole)) {
                throw new Error(`无效的角色: ${newRole}`)
            }

            await this.prisma.user.update({
                where: { id: userId },
                data: { role: newRole }
            })

            console.log(`✅ 用户 ${userId} 角色已更改为 ${newRole}`)

            return {
                success: true,
                message: `角色已更改为 ${newRole}`
            }
        } catch (error) {
            console.error(`❌ 更改角色失败: ${error.message}`)
            throw error
        }
    }

    async deleteUser(userId) {
        try {
            await this.prisma.user.delete({
                where: { id: userId }
            })

            console.log(`✅ 用户 ${userId} 已删除`)

            return {
                success: true,
                message: '用户已删除'
            }
        } catch (error) {
            console.error(`❌ 删除用户失败: ${error.message}`)
            throw error
        }
    }

    async adminUpdateUser(userId, updates) {
        try {
            const allowedUpdates = ['full_name', 'email', 'phone', 'role', 'status']
            const filteredUpdates = {}

            for (const key of allowedUpdates) {
                if (key in updates && updates[key] !== undefined) {
                    filteredUpdates[key] = updates[key]
                }
            }

            if (Object.keys(filteredUpdates).length === 0) {
                throw new Error('未提供可更新字段')
            }

            if (filteredUpdates.role) {
                const validRoles = ['user', 'admin', 'manager', 'operator', 'viewer']
                if (!validRoles.includes(filteredUpdates.role)) {
                    throw new Error(`无效的角色: ${filteredUpdates.role}`)
                }
            }

            if (filteredUpdates.status) {
                const validStatus = ['active', 'disabled']
                if (!validStatus.includes(filteredUpdates.status)) {
                    throw new Error(`无效的状态: ${filteredUpdates.status}`)
                }
            }

            filteredUpdates.updated_at = new Date()

            const updatedUser = await this.prisma.user.update({
                where: { id: userId },
                data: filteredUpdates,
                select: {
                    id: true,
                    username: true,
                    phone: true,
                    email: true,
                    full_name: true,
                    role: true,
                    status: true,
                    created_at: true,
                    last_login: true
                }
            })

            console.log(`✅ 管理员已更新用户 ${userId}`)

            return {
                success: true,
                data: updatedUser,
                message: '用户信息已更新'
            }
        } catch (error) {
            console.error(`❌ 管理员更新用户失败: ${error.message}`)
            throw error
        }
    }

    // ====== Helper Methods ======

    validateUserInput({ username, phone, password, fullName }) {
        const errors = []

        if (!username || username.length < 3) {
            errors.push('用户名至少3个字符')
        }

        if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
            errors.push('手机号格式无效（请输入11位手机号）')
        }

        if (!password || password.length < 6) {
            errors.push('密码至少6个字符')
        }

        if (!fullName || fullName.trim() === '') {
            errors.push('姓名必填')
        }

        if (errors.length > 0) {
            throw new Error(errors.join('; '))
        }
    }

    isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        return emailRegex.test(email)
    }

    async updateLastLogin(userId) {
        try {
            await this.prisma.user.update({
                where: { id: userId },
                data: { last_login: new Date() }
            })
        } catch (error) {
            console.error(`❌ 更新最后登录时间失败: ${error.message}`)
        }
    }

    async logLogin(userId, username) {
        try {
            await this.prisma.auditLog.create({
                data: {
                    user_id: userId,
                    action: 'login',
                    details: JSON.stringify({ username, timestamp: new Date().toISOString() })
                }
            })
        } catch (error) {
            console.error(`❌ 记录登录日志失败: ${error.message}`)
        }
    }

    async logFailedLogin(userId, username) {
        try {
            await this.prisma.auditLog.create({
                data: {
                    user_id: userId,
                    action: 'login_failed',
                    details: JSON.stringify({ username, timestamp: new Date().toISOString() })
                }
            })
        } catch (error) {
            console.error(`❌ 记录失败登录失败: ${error.message}`)
        }
    }

    verifyToken(token) {
        try {
            const decoded = jwt.verify(token, this.jwtSecret)
            return {
                valid: true,
                user: decoded
            }
        } catch (error) {
            return {
                valid: false,
                error: error.message
            }
        }
    }
}

export default UserManager
