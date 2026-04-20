/**
 * UserAuth - 前端用户认证管理模块
 * 管理用户登录、登出、Token刷新等功能
 */

import { apiClient } from './ApiClient.js'

export class UserAuth {
    constructor() {
        this.currentUser = null
        this.token = null
        this.listeners = {}
        this.init()
    }

    // ====== Initialization ======

    init() {
        // 从localStorage加载用户信息
        this.loadFromStorage()

        // 监听存储变化 (多标签页同步)
        window.addEventListener('storage', (e) => {
            if (e.key === 'auth_token' || e.key === 'current_user') {
                this.loadFromStorage()
                this.emit('auth-changed')
            }
        })

        // 定期检查Token是否过期
        this.startTokenCheckInterval()
    }

    // ====== Authentication ======

    async login(username, password) {
        try {
            const response = await apiClient.login(username, password)

            this.currentUser = response.user
            this.token = response.token

            // 保存到localStorage
            this.saveToStorage()

            // 触发登录事件
            this.emit('login', this.currentUser)

            return {
                success: true,
                user: this.currentUser
            }
        } catch (error) {
            this.emit('login-error', error.message)
            throw error
        }
    }

    async register(username, email, password, fullName) {
        try {
            const response = await apiClient.request(
                'POST',
                '/auth/register',
                { username, email, password, fullName }
            )

            this.emit('register-success', response)

            return {
                success: true,
                message: response.message
            }
        } catch (error) {
            this.emit('register-error', error.message)
            throw error
        }
    }

    async logout() {
        try {
            // 通知后端
            await apiClient.logout()

            // 清除本地数据
            this.clearAuth()

            this.emit('logout')
        } catch (error) {
            // 即使请求失败也清除本地数据
            this.clearAuth()
            this.emit('logout')
        }
    }

    // ====== Token Management ======

    async refreshToken() {
        try {
            const response = await apiClient.refreshToken()
            this.token = response.token
            this.saveToStorage()
            this.emit('token-refreshed')
            return this.token
        } catch (error) {
            // Token无效，触发重新登录
            this.clearAuth()
            this.emit('token-expired')
            throw error
        }
    }

    isTokenExpired() {
        if (!this.token) {
            return true
        }

        try {
            const payload = JSON.parse(atob(this.token.split('.')[1]))
            const expirationTime = payload.exp * 1000 // Convert to milliseconds
            const currentTime = Date.now()

            // 如果Token在5分钟内过期，视为即将过期
            return currentTime > expirationTime - (5 * 60 * 1000)
        } catch {
            return true
        }
    }

    // ====== User Profile ======

    async loadProfile() {
        try {
            const response = await apiClient.request(
                'GET',
                '/user/profile'
            )

            this.currentUser = response.data
            this.saveToStorage()
            this.emit('profile-loaded', this.currentUser)

            return this.currentUser
        } catch (error) {
            console.error('❌ 加载用户资料失败:', error)
            throw error
        }
    }

    async updateProfile(fullName, email) {
        try {
            const response = await apiClient.request(
                'PUT',
                '/user/profile',
                { fullName, email }
            )

            this.currentUser = response.data
            this.saveToStorage()
            this.emit('profile-updated', this.currentUser)

            return this.currentUser
        } catch (error) {
            this.emit('update-error', error.message)
            throw error
        }
    }

    async changePassword(oldPassword, newPassword) {
        try {
            const response = await apiClient.request(
                'POST',
                '/user/change-password',
                { oldPassword, newPassword }
            )

            this.emit('password-changed')
            return response
        } catch (error) {
            this.emit('password-change-error', error.message)
            throw error
        }
    }

    // ====== Permissions & Roles ======

    hasRole(role) {
        if (!this.currentUser) {
            return false
        }

        if (Array.isArray(role)) {
            return role.includes(this.currentUser.role)
        }

        return this.currentUser.role === role
    }

    hasPermission(permission) {
        if (!this.currentUser) {
            return false
        }

        const rolePermissions = {
            'admin': ['all'],
            'manager': ['view_records', 'create_records', 'edit_records', 'delete_records', 'manage_users'],
            'user': ['view_own_records', 'create_records', 'edit_own_records']
        }

        const permissions = rolePermissions[this.currentUser.role] || []
        return permissions.includes('all') || permissions.includes(permission)
    }

    isAdmin() {
        return this.hasRole('admin')
    }

    isManager() {
        return this.hasRole('manager')
    }

    isUser() {
        return this.hasRole('user')
    }

    // ====== Storage Management ======

    saveToStorage() {
        try {
            localStorage.setItem('auth_token', this.token || '')
            localStorage.setItem('current_user', JSON.stringify(this.currentUser || {}))
            localStorage.setItem('auth_timestamp', Date.now().toString())
        } catch (error) {
            console.error('❌ 保存认证信息失败:', error)
        }
    }

    loadFromStorage() {
        try {
            this.token = localStorage.getItem('auth_token') || null
            const userStr = localStorage.getItem('current_user') || '{}'
            this.currentUser = JSON.parse(userStr)

            // 如果无有效用户对象，清除Token
            if (!this.currentUser || !this.currentUser.userId) {
                this.token = null
                this.currentUser = null
            }
        } catch (error) {
            console.error('❌ 加载认证信息失败:', error)
            this.clearAuth()
        }
    }

    clearAuth() {
        this.token = null
        this.currentUser = null

        try {
            localStorage.removeItem('auth_token')
            localStorage.removeItem('current_user')
            localStorage.removeItem('auth_timestamp')
        } catch (error) {
            console.error('❌ 清除认证信息失败:', error)
        }
    }

    // ====== Status Checks ======

    isAuthenticated() {
        return this.token !== null && this.currentUser !== null
    }

    isLoggedOut() {
        return !this.isAuthenticated()
    }

    getAuthHeader() {
        return this.token ? { 'Authorization': `Bearer ${this.token}` } : {}
    }

    // ====== Events ======

    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = []
        }
        this.listeners[event].push(callback)

        // 返回unsubscribe函数
        return () => {
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback)
        }
    }

    emit(event, data) {
        if (!this.listeners[event]) {
            return
        }

        this.listeners[event].forEach(callback => {
            try {
                callback(data)
            } catch (error) {
                console.error(`❌ Event listener error (${event}):`, error)
            }
        })
    }

    // ====== Token Refresh ======

    startTokenCheckInterval() {
        // 每10分钟检查一次Token
        setInterval(async () => {
            if (!this.isAuthenticated()) {
                return
            }

            if (this.isTokenExpired()) {
                try {
                    await this.refreshToken()
                    console.log('✅ Token已自动刷新')
                } catch (error) {
                    console.error('❌ Token刷新失败:', error)
                    // 要求用户重新登录
                    this.emit('require-relogin')
                }
            }
        }, 10 * 60 * 1000)
    }

    // ====== Utility Functions ======

    getUserInfo() {
        return {
            userId: this.currentUser?.userId,
            username: this.currentUser?.username,
            email: this.currentUser?.email,
            fullName: this.currentUser?.fullName,
            role: this.currentUser?.role
        }
    }

    getDisplayName() {
        return this.currentUser?.fullName || this.currentUser?.username || '用户'
    }

    logEvent(action, details = {}) {
        console.log(`📝 [${new Date().toISOString()}] ${action}`, details)
    }
}

// ====== Singleton Instance ======
export const userAuth = new UserAuth()

// ====== Auto-redirect on logout ======
userAuth.on('require-relogin', () => {
    // 重定向到登录页面
    window.location.href = 'login.html'
})

// ====== Usage Examples ======

/*

import { userAuth } from './utils/UserAuth.js'

// 登录
await userAuth.login('admin', 'admin123')
console.log('当前用户:', userAuth.getUserInfo())

// 检查权限
if (userAuth.hasPermission('create_records')) {
    console.log('✅ 用户可以创建记录')
}

// 检查角色
if (userAuth.isAdmin()) {
    console.log('✅ 用户是管理员')
}

// 监听事件
userAuth.on('login', (user) => {
    console.log('✅ 用户已登录:', user.fullName)
})

userAuth.on('logout', () => {
    console.log('✅ 用户已登出')
})

// 加载用户资料
const profile = await userAuth.loadProfile()

// 更新用户资料
await userAuth.updateProfile('New Name', 'new@email.com')

// 修改密码
await userAuth.changePassword('oldPassword', 'newPassword')

// 登出
await userAuth.logout()

*/
