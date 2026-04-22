/**
 * UserManager - 用户管理模块
 * 处理用户注册、登录、密码管理等业务逻辑
 */

import bcryptjs from 'bcryptjs'
import jwt from 'jsonwebtoken'

export class UserManager {
    constructor(supabaseClient, jwtSecret) {
        this.supabase = supabaseClient
        this.jwtSecret = jwtSecret
    }

    // ====== User Registration ======

    async registerUser(username, phone, password, fullName) {
        try {
            // 1. 验证输入
            this.validateUserInput({ username, phone, password, fullName })

            // 2. 检查用户是否已存在
            const { data: existingUser } = await this.supabase
                .from('users')
                .select('id')
                .eq('username', username)
                .single()

            if (existingUser) {
                throw new Error('用户名已存在')
            }

            // 3. 检查手机号是否已使用
            if (phone) {
                const { data: existingPhone } = await this.supabase
                    .from('users')
                    .select('id')
                    .eq('phone', phone)
                    .single()

                if (existingPhone) {
                    throw new Error('手机号已被使用')
                }
            }

            // 4. 加密密码
            const passwordHash = await bcryptjs.hash(password, 10)

            // 5. 创建用户（email 自动生成）
            const autoEmail = `${username}@foodlab.local`
            const { data: newUser, error } = await this.supabase
                .from('users')
                .insert([{
                    username,
                    email: autoEmail,
                    phone: phone || null,
                    password_hash: passwordHash,
                    full_name: fullName,
                    role: 'user',
                    status: 'active',
                    created_at: new Date().toISOString()
                }])
                .select('id, username, phone, full_name, role')

            if (error) {
                throw new Error(`创建用户失败: ${error.message}`)
            }

            console.log(`✅ 用户注册成功: ${username}`)

            return {
                success: true,
                user: newUser[0],
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
            const { data: user, error } = await this.supabase
                .from('users')
                .select('*')
                .eq('username', username)
                .single()

            if (error || !user) {
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
                await this.logFailedLogin(user.id)
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

            console.log(`✅ 用户登录成功: ${username}`)

            return {
                success: true,
                token,
                expiresIn: 7 * 24 * 3600, // 7 天（秒），与 JWT expiresIn: '7d' 保持一致
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
            const { data: user, error } = await this.supabase
                .from('users')
                .select('password_hash')
                .eq('id', userId)
                .single()

            if (error || !user) {
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
            const { error: updateError } = await this.supabase
                .from('users')
                .update({
                    password_hash: newPasswordHash,
                    updated_at: new Date().toISOString()
                })
                .eq('id', userId)

            if (updateError) {
                throw new Error(`更新密码失败: ${updateError.message}`)
            }

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
            const { error } = await this.supabase
                .from('users')
                .update({
                    password_hash: passwordHash,
                    updated_at: new Date().toISOString()
                })
                .eq('id', userId)

            if (error) {
                throw new Error(`重置密码失败: ${error.message}`)
            }

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
            const { data: user, error } = await this.supabase
                .from('users')
                .select('id, username, email, full_name, role, status, created_at, last_login')
                .eq('id', userId)
                .single()

            if (error || !user) {
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

            filteredUpdates.updated_at = new Date().toISOString()

            const { data: updatedUser, error } = await this.supabase
                .from('users')
                .update(filteredUpdates)
                .eq('id', userId)
                .select('id, username, email, full_name, role, status')

            if (error) {
                throw new Error(`更新用户信息失败: ${error.message}`)
            }

            console.log(`✅ 用户 ${userId} 信息已更新`)

            return {
                success: true,
                data: updatedUser[0]
            }
        } catch (error) {
            console.error(`❌ 更新用户信息失败: ${error.message}`)
            throw error
        }
    }

    // ====== User List ======

    async getUserList(limit = 100, offset = 0) {
        try {
            const { data: users, error, count } = await this.supabase
                .from('users')
                .select('id, username, phone, full_name, role, status, created_at, last_login', { count: 'exact' })
                .range(offset, offset + limit - 1)
                .order('created_at', { ascending: false })

            if (error) {
                throw new Error(`获取用户列表失败: ${error.message}`)
            }

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
            const { error } = await this.supabase
                .from('users')
                .update({ status: 'disabled' })
                .eq('id', userId)

            if (error) {
                throw new Error(`禁用用户失败: ${error.message}`)
            }

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
            const { error } = await this.supabase
                .from('users')
                .update({ status: 'active' })
                .eq('id', userId)

            if (error) {
                throw new Error(`启用用户失败: ${error.message}`)
            }

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
            const validRoles = ['user', 'admin', 'manager']
            if (!validRoles.includes(newRole)) {
                throw new Error(`无效的角色: ${newRole}`)
            }

            const { error } = await this.supabase
                .from('users')
                .update({ role: newRole })
                .eq('id', userId)

            if (error) {
                throw new Error(`更改角色失败: ${error.message}`)
            }

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
            const { error } = await this.supabase
                .from('users')
                .delete()
                .eq('id', userId)

            if (error) {
                throw new Error(`删除用户失败: ${error.message}`)
            }

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

    async updateUserByAdmin(userId, { username, phone, fullName, role }) {
        try {
            const updateData = {}

            if (username !== undefined && username !== null && username !== '') {
                if (username.length < 3) {
                    throw new Error('用户名至少3个字符')
                }
                if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) {
                    throw new Error('用户名只能包含字母、数字、下划线或中文')
                }
                // 检查用户名是否已被其他用户使用
                const { data: existing } = await this.supabase
                    .from('users')
                    .select('id')
                    .eq('username', username)
                    .neq('id', userId)
                    .maybeSingle()
                if (existing) {
                    throw new Error(`用户名 "${username}" 已被其他用户使用`)
                }
                updateData.username = username
            }

            if (phone !== undefined) {
                if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
                    throw new Error('手机号格式无效（请输入11位手机号）')
                }
                updateData.phone = phone || null
            }

            if (fullName !== undefined) {
                updateData.full_name = fullName
            }

            const validRoles = ['user', 'admin', 'manager', 'operator', 'viewer']
            if (role) {
                if (!validRoles.includes(role)) {
                    throw new Error(`无效的角色: ${role}`)
                }
                updateData.role = role
            }

            if (Object.keys(updateData).length === 0) {
                throw new Error('没有可更新的字段')
            }

            const { error } = await this.supabase
                .from('users')
                .update(updateData)
                .eq('id', userId)

            if (error) {
                throw new Error(`更新用户失败: ${error.message}`)
            }

            console.log(`✅ 用户 ${userId} 信息已更新`)

            return {
                success: true,
                message: '用户信息已更新'
            }
        } catch (error) {
            console.error(`❌ 更新用户失败: ${error.message}`)
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
            await this.supabase
                .from('users')
                .update({ last_login: new Date().toISOString() })
                .eq('id', userId)
        } catch (error) {
            console.error(`❌ 更新最后登录时间失败: ${error.message}`)
        }
    }

    async logFailedLogin(userId) {
        try {
            await this.supabase
                .from('login_logs')
                .insert([{
                    user_id: userId,
                    status: 'failed',
                    created_at: new Date().toISOString()
                }])
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
