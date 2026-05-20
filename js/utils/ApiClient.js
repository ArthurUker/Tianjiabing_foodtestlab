/**
 * APIClient - 前端API客户端
 * 所有数据操作通过此客户端与后端API通信
 * Supabase密钥完全隐藏在后端
 */

export class APIClient {
    constructor(baseURL = '/api') {
        this.baseURL = baseURL
        this.token = this.loadToken()
        this.requestInterceptors = []
        this.responseInterceptors = []
    }

    // ====== Authentication ======

    async login(username, password) {
        try {
            const response = await this.request('POST', '/auth/login', {
                username,
                password
            })

            // 保存Token到LocalStorage
            this.setToken(response.token)
            this.token = response.token

            // 触发登录成功事件
            this.emit('login-success', response.user)

            return response
        } catch (error) {
            this.emit('login-error', error.message)
            throw error
        }
    }

    async logout() {
        try {
            await this.request('POST', '/auth/logout')
            this.clearToken()
            this.token = null
            this.emit('logout-success')
        } catch (error) {
            console.error('登出失败:', error)
        }
    }

    async refreshToken() {
        try {
            const response = await this.request('POST', '/auth/refresh')
            this.setToken(response.token)
            this.token = response.token
            return response.token
        } catch (error) {
            this.clearToken()
            this.token = null
            throw error
        }
    }

    isAuthenticated() {
        return this.token !== null
    }

    // ====== CRUD Operations ======

    async getRecords(type, { limit = 100, offset = 0 } = {}) {
        return this.request('GET', `/records/${type}?limit=${limit}&offset=${offset}`)
    }

    async getRecord(type, id) {
        return this.request('GET', `/records/${type}/${id}`)
    }

    async createRecord(type, data) {
        return this.request('POST', `/records/${type}`, data)
    }

    async updateRecord(type, id, data) {
        return this.request('PUT', `/records/${type}/${id}`, data)
    }

    async deleteRecord(type, id) {
        return this.request('DELETE', `/records/${type}/${id}`)
    }

    async getStatistics(type) {
        return this.request('GET', `/statistics/${type}`)
    }

    // ====== HTTP Request ======

    async request(method, url, data = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        }

        // 添加认证Token
        if (this.token) {
            options.headers['Authorization'] = `Bearer ${this.token}`
        }

        // 添加请求体
        if (data) {
            options.body = JSON.stringify(data)
        }

        try {
            // 请求拦截器
            for (const interceptor of this.requestInterceptors) {
                await interceptor(options)
            }

            const fullURL = this.baseURL + url
            const response = await fetch(fullURL, options)

            let responseData
            try {
                responseData = await response.json()
            } catch {
                responseData = await response.text()
            }

            // 响应拦截器
            for (const interceptor of this.responseInterceptors) {
                responseData = await interceptor(responseData)
            }

            if (!response.ok) {
                const error = new Error(responseData.error || '请求失败')
                error.status = response.status
                error.data = responseData
                throw error
            }

            return responseData.data || responseData
        } catch (error) {
            console.error(`❌ API Error [${method} ${url}]:`, error)
            this.emit('api-error', { method, url, error: error.message })
            throw error
        }
    }

    // ====== Token Management ======

    loadToken() {
        try {
            const token = localStorage.getItem('auth_token')
            if (token && !this.isTokenExpired(token)) {
                return token
            }
            localStorage.removeItem('auth_token')
            return null
        } catch {
            return null
        }
    }

    setToken(token) {
        localStorage.setItem('auth_token', token)
    }

    clearToken() {
        localStorage.removeItem('auth_token')
        localStorage.removeItem('current_user')
    }

    isTokenExpired(token) {
        try {
            const payload = JSON.parse(atob(token.split('.')[1]))
            return payload.exp * 1000 < Date.now()
        } catch {
            return true
        }
    }

    // ====== Event System ======

    on(event, callback) {
        if (!this.listeners) this.listeners = {}
        if (!this.listeners[event]) this.listeners[event] = []
        this.listeners[event].push(callback)
    }

    emit(event, data) {
        if (!this.listeners || !this.listeners[event]) return
        this.listeners[event].forEach(callback => callback(data))
    }

    // ====== Interceptors ======

    addRequestInterceptor(interceptor) {
        this.requestInterceptors.push(interceptor)
    }

    addResponseInterceptor(interceptor) {
        this.responseInterceptors.push(interceptor)
    }
}

// ====== Singleton Instance ======

export const apiClient = new APIClient(
    import.meta.env.VITE_API_URL || '/api'
)

// ====== Usage Examples ======

/*

// 登录
const response = await apiClient.login('admin', 'admin123')
console.log('当前用户:', response.user)

// 获取所有餐具检测记录
const records = await apiClient.getRecords('tableware_tests', { limit: 50 })
console.log('餐具检测记录:', records.data)

// 创建新记录
const newRecord = await apiClient.createRecord('tableware_tests', {
    sampleId: 'S001',
    testDate: '2026-04-20',
    location: '一食堂',
    result: 'Pass'
})

// 更新记录
await apiClient.updateRecord('tableware_tests', 1, {
    result: 'Fail',
    notes: '发现细菌'
})

// 删除记录
await apiClient.deleteRecord('tableware_tests', 1)

// 获取统计数据
const stats = await apiClient.getStatistics('tableware_tests')
console.log('统计数据:', stats)

*/
