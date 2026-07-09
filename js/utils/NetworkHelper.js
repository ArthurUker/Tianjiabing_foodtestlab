/**
 * 网络请求辅助工具
 * 集成超时控制、自动重试、错误处理等功能
 * 
 * @example
 * const data = await NetworkHelper.fetchWithRetry('/api/records', {
 *     retries: 3,
 *     onRetry: (attempt) => console.log(`正在重试... (${attempt}/3)`)
 * })
 */
export class NetworkHelper {
    /**
     * 带超时和重试的 fetch
     * @param {string} url - 请求地址
     * @param {Object} options - 配置选项
     * @param {number} options.timeout - 请求超时时间(ms)，默认 10000
     * @param {number} options.retries - 重试次数，默认 3
     * @param {number} options.retryDelay - 重试延迟(ms)，默认 1000
     * @param {Function} options.onRetry - 重试回调函数
     * @returns {Promise<Object>} 请求响应的 JSON 数据
     */
    static async fetchWithRetry(url, options = {}) {
        const {
            timeout = 10000,
            retries = 3,
            retryDelay = 1000,
            onRetry = null,
            ...fetchOptions
        } = options
        
        let lastError = null
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`📤 请求 [${fetchOptions.method || 'GET'} ${url}] (尝试 ${attempt}/${retries})`)
                
                const response = await this.fetchWithTimeout(url, {
                    ...fetchOptions,
                    timeout
                })
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
                }
                
                const data = await response.json()
                console.log(`✅ 成功: ${url}`)
                return data
                
            } catch (error) {
                lastError = error
                console.warn(`⚠️ 第 ${attempt} 次失败: ${error.message}`)
                
                // 调用重试回调
                if (onRetry) {
                    try {
                        onRetry(attempt, error)
                    } catch (callbackError) {
                        console.warn('重试回调错误:', callbackError)
                    }
                }
                
                // 不是最后一次尝试则等待后重试
                if (attempt < retries) {
                    const delay = retryDelay * attempt
                    console.log(`⏳ ${delay}ms 后重试...`)
                    await new Promise(r => setTimeout(r, delay))
                }
            }
        }
        
        const errorMsg = `请求失败 (${retries}次尝试): ${lastError?.message || '未知错误'}`
        throw new Error(errorMsg)
    }
    
    /**
     * fetch 带超时
     * @param {string} url - 请求地址
     * @param {Object} options - fetch 选项
     * @returns {Promise<Response>}
     */
    static fetchWithTimeout(url, options = {}) {
        const timeout = options.timeout || 10000
        const { timeout: _, ...fetchOptions } = options
        
        return Promise.race([
            fetch(url, fetchOptions),
            new Promise((_, reject) =>
                setTimeout(() => {
                    reject(new Error(`请求超时 (${timeout}ms)`))
                }, timeout)
            )
        ])
    }
    
    /**
     * 检查网络连接状态
     * @param {string} url - 检查用的 URL，默认 Google favicon
     * @returns {Promise<boolean>} 是否连接成功
     */
    static async checkConnection(url = '') {
        // P2-09: 移除硬编码 Google URL（内网/国内不可达），默认探测当前站点健康检查端点
        const checkUrl = url || (typeof window !== 'undefined'
            ? `${window.location.origin}/api/health`
            : '/api/health')
        try {
            const response = await this.fetchWithTimeout(checkUrl, { timeout: 5000 })
            return response.ok
        } catch (error) {
            console.warn('网络连接检查失败:', error.message)
            return false
        }
    }
    
    /**
     * 监听网络状态变化
     * @param {Function} onOnline - 网络连接时的回调
     * @param {Function} onOffline - 网络断开时的回调
     */
    static watchNetworkStatus(onOnline = null, onOffline = null) {
        window.addEventListener('online', () => {
            console.log('🌐 网络已连接')
            if (onOnline) onOnline()
        })
        
        window.addEventListener('offline', () => {
            console.log('📡 网络已断开')
            if (onOffline) onOffline()
        })
        
        // 初始状态检查
        console.log(`🌐 初始网络状态: ${navigator.onLine ? '在线' : '离线'}`)
    }
    
    /**
     * POST 请求快捷方法
     */
    static async post(url, data, options = {}) {
        const { headers: extraHeaders, ...restOptions } = options
        return this.fetchWithRetry(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(extraHeaders || {})
            },
            body: JSON.stringify(data),
            ...restOptions
        })
    }
    
    /**
     * GET 请求快捷方法
     */
    static async get(url, options = {}) {
        return this.fetchWithRetry(url, {
            method: 'GET',
            ...options
        })
    }
    
    /**
     * PUT 请求快捷方法
     */
    static async put(url, data, options = {}) {
        const { headers: extraHeaders, ...restOptions } = options
        return this.fetchWithRetry(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                ...(extraHeaders || {})
            },
            body: JSON.stringify(data),
            ...restOptions
        })
    }
    
    /**
     * DELETE 请求快捷方法
     */
    static async delete(url, options = {}) {
        return this.fetchWithRetry(url, {
            method: 'DELETE',
            ...options
        })
    }
    
    /**
     * 批量请求（并行）
     * @param {Array} requests - 请求数组，每个包含 { method, url, data }
     * @returns {Promise<Array>} 所有请求的结果
     */
    static async batchRequests(requests) {
        return Promise.all(
            requests.map(req => {
                const { method, url, data, ...options } = req
                
                switch (method?.toUpperCase()) {
                    case 'POST':
                        return this.post(url, data, options)
                    case 'PUT':
                        return this.put(url, data, options)
                    case 'DELETE':
                        return this.delete(url, options)
                    default:
                        return this.get(url, options)
                }
            })
        )
    }
}

// 初始化网络状态监听
if (typeof window !== 'undefined') {
    // 在页面加载时自动监听网络状态
    // 如果需要自定义回调，调用 watchNetworkStatus(onOnline, onOffline)
}
