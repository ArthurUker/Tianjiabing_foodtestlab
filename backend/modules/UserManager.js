/**
 * UserManager - 用户管理模块 (Prisma + PostgreSQL, Schema-per-tenant)
 * 处理用户注册、登录、密码管理等业务逻辑
 */

import bcryptjs from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createTenantClient } from '../lib/tenantClient.js'

export class UserManager {
    constructor(prismaClient, jwtSecret) {
        this.prisma = prismaClient
        this.jwtSecret = jwtSecret
        this.schoolCode = null // 由 forTenant() 注入，用于写入 school_code
    }

    /**
     * 返回一个绑定到指定学校 schema 的 UserManager 副本（方案②）。
     * 副本的 this.prisma 为请求级租户客户端，所有查询落在 schoolCode 对应的 schema（schoolCode 即 schema 名，如 school-a）。
     * 不传 schoolCode 时返回自身（dev/test 共享 schema）。
     */
    forTenant(schoolCode) {
        if (!schoolCode) return this
        const tenantClient = createTenantClient(this.prisma, schoolCode)
        const clone = Object.create(UserManager.prototype)
        Object.assign(clone, this, {
            prisma: tenantClient,
            schoolCode
        })
        return clone
    }

    // ====== User Registration ======

    isStrongPassword(password) {
        if (!password) {
            return false
        }
        return /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(password)
    }

    buildAccessToken(user) {
        return jwt.sign(
            {
                userId: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                schoolCode: user.school_code || this.schoolCode || null
            },
            this.jwtSecret,
            { expiresIn: '7d' }
        )
    }

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
            const newUser = await this.prisma.user.create({
                data: {
                    username,
                    email: null,
                    phone: phone || null,
                    password_hash: passwordHash,
                    full_name: fullName,
                    role: 'user',
                    status: 'active',
                    school_code: this.schoolCode || null
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
                // P2-03: 用户不存在时也记录失败登录（写入 SystemLog，因 AuditLog 需有效 user_id 外键）
                await this.logFailedLogin(null, username)
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
            const token = this.buildAccessToken(user)

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
            if (!this.isStrongPassword(newPassword)) {
                throw new Error('新密码至少8个字符，且必须包含字母和数字')
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
            if (!this.isStrongPassword(newPassword)) {
                throw new Error('密码至少8个字符，且必须包含字母和数字')
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
                    school_code: true,
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
            // P1-08: 删除前检查是否存在关联 TestRecord
            const recordCount = await this.prisma.testRecord.count({
              where: { created_by: userId }
            });
            if (recordCount > 0) {
              throw new Error(`无法删除用户：该用户存在 ${recordCount} 条检测记录，请先转移或归档记录后再删除`);
            }

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
            const allowedUpdates = ['username', 'full_name', 'email', 'phone', 'role', 'status']
            const filteredUpdates = {}

            for (const key of allowedUpdates) {
                if (key in updates && updates[key] !== undefined) {
                    filteredUpdates[key] = updates[key]
                }
            }

            if (Object.keys(filteredUpdates).length === 0) {
                throw new Error('未提供可更新字段')
            }

            if (filteredUpdates.username) {
                if (filteredUpdates.username.length < 3) {
                    throw new Error('用户名至少3个字符')
                }

                const existingUser = await this.prisma.user.findUnique({
                    where: { username: filteredUpdates.username }
                })

                if (existingUser && existingUser.id !== userId) {
                    throw new Error('用户名已存在')
                }
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

        if (!this.isStrongPassword(password)) {
            errors.push('密码至少8个字符，且必须包含字母和数字')
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
            // P2-03: userId 为 null 时（用户不存在），AuditLog 需有效 user_id 外键无法写入，改记 SystemLog
            if (!userId) {
                await this.prisma.systemLog.create({
                    data: {
                        level: 'warn',
                        message: `登录失败（用户不存在）: ${username}`,
                        context: JSON.stringify({ username, timestamp: new Date().toISOString() })
                    }
                })
                return
            }
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
