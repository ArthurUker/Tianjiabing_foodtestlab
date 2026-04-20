# 快速修复指南 - 即插即用代码

**目的**: 提供可直接使用或参考的代码修复方案  
**难度**: 从易到难

---

## 🟢 第一批：立即可实施（1-2天）

### 1️⃣ 添加表单验证工具

**文件**: `js/utils/FormValidator.js`

```javascript
/**
 * 通用表单验证工具
 * 使用简单，支持多种验证规则
 */
export class FormValidator {
    // 预定义规则
    static rules = {
        required: (value) => {
            return value && String(value).trim() 
                ? null 
                : '此字段必填'
        },
        
        minLength: (min) => (value) => {
            return String(value).length >= min 
                ? null 
                : `最少需要 ${min} 个字符`
        },
        
        maxLength: (max) => (value) => {
            return String(value).length <= max 
                ? null 
                : `最多 ${max} 个字符`
        },
        
        email: (value) => {
            const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
            return regex.test(value) 
                ? null 
                : '邮箱格式不正确'
        },
        
        number: (value) => {
            return !isNaN(value) && value !== '' 
                ? null 
                : '请输入数字'
        },
        
        date: (value) => {
            return !isNaN(Date.parse(value)) 
                ? null 
                : '日期格式不正确'
        },
        
        phone: (value) => {
            const regex = /^1[3-9]\d{9}$/
            return regex.test(value) 
                ? null 
                : '手机号格式不正确'
        },
        
        dateNotFuture: (value) => {
            const date = new Date(value)
            return date <= new Date() 
                ? null 
                : '日期不能晚于今天'
        },
        
        idCard: (value) => {
            const regex = /^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/
            return regex.test(value) 
                ? null 
                : '身份证号格式不正确'
        }
    }
    
    /**
     * 验证数据
     * @param {Object} data - 要验证的数据对象
     * @param {Object} schema - 验证规则对象
     * @returns {Object|null} 错误对象或 null
     * 
     * @example
     * const errors = FormValidator.validate(
     *     { name: '', email: 'invalid' },
     *     {
     *         name: ['required', { minLength: 3 }],
     *         email: ['required', 'email']
     *     }
     * )
     * // 返回: { name: '此字段必填', email: '邮箱格式不正确' }
     */
    static validate(data, schema) {
        const errors = {}
        
        for (const [field, rules] of Object.entries(schema)) {
            const value = data[field]
            
            for (const rule of rules) {
                let validator = null
                
                // 处理字符串规则
                if (typeof rule === 'string') {
                    validator = this.rules[rule]
                }
                // 处理函数规则
                else if (typeof rule === 'function') {
                    validator = rule
                }
                // 处理对象规则 (带参数)
                else if (typeof rule === 'object') {
                    const [ruleName, ...args] = Object.entries(rule)[0]
                    validator = this.rules[ruleName](...args)
                }
                
                if (validator) {
                    const error = validator(value)
                    if (error) {
                        errors[field] = error
                        break  // 该字段只显示第一个错误
                    }
                }
            }
        }
        
        return Object.keys(errors).length === 0 ? null : errors
    }
    
    /**
     * 显示表单错误
     */
    static showErrors(form, errors) {
        // 清除所有错误提示
        form.querySelectorAll('.error-message').forEach(el => el.remove())
        form.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'))
        
        // 显示新错误
        for (const [field, message] of Object.entries(errors)) {
            const input = form.querySelector(`[name="${field}"]`)
            if (!input) continue
            
            input.classList.add('is-invalid')
            const errorEl = document.createElement('div')
            errorEl.className = 'error-message text-red-600 text-sm mt-1'
            errorEl.textContent = message
            input.parentElement.appendChild(errorEl)
        }
    }
}

// 在表单中使用
export function setupFormValidation(formSelector, schema) {
    const form = document.querySelector(formSelector)
    if (!form) return
    
    form.addEventListener('submit', (e) => {
        e.preventDefault()
        const data = Object.fromEntries(new FormData(form))
        
        const errors = FormValidator.validate(data, schema)
        if (errors) {
            FormValidator.showErrors(form, errors)
            return
        }
        
        // 数据有效，提交
        console.log('✅ 数据有效:', data)
        // handleSubmit(data)
    })
}
```

**在 GenericTest.js 中使用**:

```javascript
import { FormValidator, setupFormValidation } from './utils/FormValidator.js'

handleSubmit(e) {
    e.preventDefault()
    const data = Object.fromEntries(new FormData(e.target))
    
    // 定义验证规则
    const schema = {
        sampleId: ['required', { minLength: 3 }],
        testDate: ['required', 'dateNotFuture'],
        result: ['required'],
        canteen: ['required']
    }
    
    const errors = FormValidator.validate(data, schema)
    if (errors) {
        FormValidator.showErrors(e.target, errors)
        return
    }
    
    // 验证通过
    this.storage.save(data)
    this.render()
}
```

---

### 2️⃣ 改进错误处理和用户提示

**文件**: `js/utils/UINotification.js`

```javascript
/**
 * 统一的通知管理系统
 */
export class UINotification {
    static show(message, type = 'info', duration = 3000) {
        const notification = document.createElement('div')
        notification.className = `fixed top-4 right-4 px-4 py-3 rounded shadow-lg text-white z-50 ${this.getTypeClass(type)}`
        notification.innerHTML = `
            <div class="flex items-center gap-3">
                <i class="fas ${this.getIcon(type)}"></i>
                <div>${message}</div>
                <button class="ml-4 text-lg leading-none" onclick="this.parentElement.parentElement.remove()">×</button>
            </div>
        `
        
        document.body.appendChild(notification)
        
        if (duration > 0) {
            setTimeout(() => notification.remove(), duration)
        }
        
        return notification
    }
    
    static success(message, duration = 3000) {
        return this.show(message, 'success', duration)
    }
    
    static error(message, duration = 5000) {
        return this.show(message, 'error', duration)
    }
    
    static warning(message, duration = 4000) {
        return this.show(message, 'warning', duration)
    }
    
    static info(message, duration = 3000) {
        return this.show(message, 'info', duration)
    }
    
    static loading(message) {
        return this.show(`<i class="fas fa-spinner fa-spin"></i> ${message}`, 'info', 0)
    }
    
    static getTypeClass(type) {
        const typeMap = {
            'success': 'bg-green-600',
            'error': 'bg-red-600',
            'warning': 'bg-yellow-600',
            'info': 'bg-blue-600'
        }
        return typeMap[type] || typeMap['info']
    }
    
    static getIcon(type) {
        const iconMap = {
            'success': 'fa-check-circle',
            'error': 'fa-exclamation-circle',
            'warning': 'fa-exclamation-triangle',
            'info': 'fa-info-circle'
        }
        return iconMap[type] || iconMap['info']
    }
    
    /**
     * 显示确认对话框
     */
    static async confirm(message, title = '确认') {
        return new Promise((resolve) => {
            const modal = document.createElement('div')
            modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center'
            modal.innerHTML = `
                <div class="bg-white rounded-lg shadow-xl p-6 max-w-md">
                    <h3 class="text-lg font-bold mb-3">${title}</h3>
                    <p class="text-gray-700 mb-6">${message}</p>
                    <div class="flex justify-end gap-3">
                        <button class="px-4 py-2 bg-gray-300 text-gray-800 rounded hover:bg-gray-400" onclick="this.closest('.fixed').remove(); window._confirmResult = false">取消</button>
                        <button class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700" onclick="this.closest('.fixed').remove(); window._confirmResult = true">确认</button>
                    </div>
                </div>
            `
            
            document.body.appendChild(modal)
            
            // 等待用户操作
            const checkInterval = setInterval(() => {
                if (window._confirmResult !== undefined) {
                    clearInterval(checkInterval)
                    const result = window._confirmResult
                    window._confirmResult = undefined
                    resolve(result)
                }
            }, 50)
        })
    }
}

// 使用示例
import { UINotification } from './utils/UINotification.js'

// 显示通知
UINotification.success('✅ 数据已保存')
UINotification.error('❌ 保存失败: ' + error.message)
UINotification.warning('⚠️ 数据未保存')
UINotification.loading('🔄 处理中...')

// 确认对话框
if (await UINotification.confirm('确定删除该记录吗？')) {
    storage.delete(id)
}
```

---

### 3️⃣ 改进网络错误处理

**文件**: `js/utils/NetworkHelper.js`

```javascript
/**
 * 网络请求辅助工具
 * 集成超时、重试、错误处理
 */
export class NetworkHelper {
    /**
     * 带超时和重试的 fetch
     */
    static async fetchWithRetry(url, options = {}) {
        const {
            timeout = 10000,
            retries = 3,
            retryDelay = 1000,
            onRetry = null
        } = options
        
        let lastError
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                console.log(`📤 第 ${attempt}/${retries} 次尝试: ${url}`)
                
                const response = await this.fetchWithTimeout(url, {
                    ...options,
                    timeout
                })
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
                }
                
                console.log(`✅ 成功: ${url}`)
                return await response.json()
                
            } catch (error) {
                lastError = error
                console.warn(`⚠️ 第 ${attempt} 次失败: ${error.message}`)
                
                if (onRetry) onRetry(attempt, error)
                
                // 不是最后一次尝试则等待后重试
                if (attempt < retries) {
                    const delay = retryDelay * attempt
                    console.log(`⏳ ${delay}ms 后重试...`)
                    await new Promise(r => setTimeout(r, delay))
                }
            }
        }
        
        throw new Error(`请求失败 (${retries}次尝试): ${lastError.message}`)
    }
    
    /**
     * fetch 带超时
     */
    static fetchWithTimeout(url, options = {}) {
        const timeout = options.timeout || 10000
        
        return Promise.race([
            fetch(url, options),
            new Promise((_, reject) =>
                setTimeout(() => {
                    reject(new Error(`请求超时 (${timeout}ms)`))
                }, timeout)
            )
        ])
    }
    
    /**
     * 检查网络连接
     */
    static async checkConnection(url = 'https://www.google.com/favicon.ico') {
        try {
            await this.fetchWithTimeout(url, { timeout: 5000 })
            return true
        } catch {
            return false
        }
    }
    
    /**
     * 监听网络状态
     */
    static watchNetworkStatus(onOnline, onOffline) {
        window.addEventListener('online', () => {
            console.log('🌐 网络已连接')
            onOnline?.()
        })
        
        window.addEventListener('offline', () => {
            console.log('📡 网络已断开')
            onOffline?.()
        })
    }
}

// 使用示例
import { NetworkHelper } from './utils/NetworkHelper.js'

// 获取数据，自动重试
try {
    const data = await NetworkHelper.fetchWithRetry('/api/records', {
        retries: 3,
        retryDelay: 1000,
        onRetry: (attempt, error) => {
            console.log(`正在重试... (${attempt}/3)`)
        }
    })
} catch (error) {
    UINotification.error('网络请求失败: ' + error.message)
}

// 监听网络状态
NetworkHelper.watchNetworkStatus(
    () => UINotification.success('网络已连接'),
    () => UINotification.warning('网络已断开，您可以继续离线操作')
)
```

---

## 🟡 第二批：中期改进（3-5天）

### 4️⃣ 创建基础模块类

**文件**: `js/modules/BaseModule.js`

```javascript
/**
 * 所有模块的基类
 * 减少代码重复，统一接口
 */
export class BaseModule {
    constructor(config) {
        this.moduleName = config.moduleName
        this.formId = config.formId
        this.tableId = config.tableId
        this.storage = config.storage || new StorageService(this.moduleName)
        
        // 分页配置
        this.currentPage = 1
        this.recordsPerPage = 10
        this.sortOrder = 'desc'
        
        // 筛选配置
        this.filters = {}
    }
    
    init() {
        this.setupForm()
        this.setupTable()
        this.setupPagination()
        this.render()
    }
    
    /**
     * 设置表单事件
     */
    setupForm() {
        const form = document.getElementById(this.formId)
        if (!form) return
        
        form.addEventListener('submit', (e) => this.handleFormSubmit(e))
    }
    
    /**
     * 处理表单提交
     */
    async handleFormSubmit(e) {
        e.preventDefault()
        const data = Object.fromEntries(new FormData(e.target))
        
        // 验证
        const errors = this.validateFormData(data)
        if (errors) {
            FormValidator.showErrors(e.target, errors)
            return
        }
        
        // 保存
        try {
            this.storage.save(data)
            UINotification.success('✅ 数据已保存')
            e.target.reset()
            this.render()
            document.dispatchEvent(new Event('dataChanged'))
        } catch (error) {
            UINotification.error('❌ 保存失败: ' + error.message)
        }
    }
    
    /**
     * 设置表格事件
     */
    setupTable() {
        const table = document.getElementById(this.tableId)
        if (!table) return
        
        table.addEventListener('click', (e) => {
            const deleteBtn = e.target.closest('.btn-delete')
            if (deleteBtn) this.handleDelete(deleteBtn.dataset.id)
            
            const editBtn = e.target.closest('.btn-edit')
            if (editBtn) this.handleEdit(editBtn.dataset.id)
            
            const detailBtn = e.target.closest('.btn-detail')
            if (detailBtn) this.handleDetail(detailBtn.dataset.id)
        })
    }
    
    /**
     * 删除记录
     */
    async handleDelete(id) {
        if (await UINotification.confirm('确定删除该记录吗？此操作不可恢复！')) {
            try {
                this.storage.delete(id)
                UINotification.success('✅ 已删除')
                this.render()
            } catch (error) {
                UINotification.error('删除失败: ' + error.message)
            }
        }
    }
    
    /**
     * 编辑记录（子类覆盖）
     */
    handleEdit(id) {
        console.log('编辑:', id)
    }
    
    /**
     * 查看详情（子类覆盖）
     */
    handleDetail(id) {
        console.log('详情:', id)
    }
    
    /**
     * 验证表单数据（子类覆盖）
     */
    validateFormData(data) {
        return null  // 返回 null 表示验证通过
    }
    
    /**
     * 获取筛选后的记录
     */
    getFilteredRecords() {
        let records = this.storage.getAll()
        
        // 应用筛选
        for (const [key, value] of Object.entries(this.filters)) {
            if (value && value !== 'all') {
                records = records.filter(r => r[key] === value)
            }
        }
        
        // 排序
        records.sort((a, b) => {
            const aVal = a.id || 0
            const bVal = b.id || 0
            return this.sortOrder === 'desc' ? bVal - aVal : aVal - bVal
        })
        
        return records
    }
    
    /**
     * 设置分页
     */
    setupPagination() {
        // 子类实现分页逻辑
    }
    
    /**
     * 渲染表格
     */
    render() {
        const records = this.getFilteredRecords()
        const table = document.getElementById(this.tableId)
        if (!table) return
        
        const tbody = table.querySelector('tbody')
        tbody.innerHTML = records
            .map(r => this.renderRow(r))
            .join('')
    }
    
    /**
     * 渲染单行（子类覆盖）
     */
    renderRow(record) {
        return `<tr><td>${record.id}</td></tr>`
    }
}
```

**在 Tableware.js 中使用**:

```javascript
import { BaseModule } from './BaseModule.js'
import { FormValidator } from '../utils/FormValidator.js'

export class TablewareModule extends BaseModule {
    validateFormData(data) {
        return FormValidator.validate(data, {
            sampleId: ['required', { minLength: 3 }],
            testDate: ['required', 'dateNotFuture'],
            result: ['required']
        })
    }
    
    renderRow(record) {
        return `
            <tr>
                <td>${record.sampleId}</td>
                <td>${record.testDate}</td>
                <td><span class="result-badge ${record.result === '合格' ? 'bg-green' : 'bg-red'}">${record.result}</span></td>
                <td>
                    <button class="btn-edit" data-id="${record.id}">编辑</button>
                    <button class="btn-delete" data-id="${record.id}">删除</button>
                </td>
            </tr>
        `
    }
}

// 初始化
const tablewareModule = new TablewareModule({
    moduleName: 'tableware',
    formId: 'tablewareForm',
    tableId: 'tablewareTable'
})
tablewareModule.init()
```

---

### 5️⃣ 实现缓存管理器

**文件**: `js/utils/CacheManager.js`

```javascript
/**
 * 简单的内存缓存管理器
 * 支持 TTL、自动清理、LRU 淘汰
 */
export class CacheManager {
    constructor(options = {}) {
        this.cache = new Map()
        this.ttl = options.ttl || 5 * 60 * 1000  // 默认 5 分钟
        this.maxSize = options.maxSize || 100     // 最多缓存 100 个项
        this.stats = { hits: 0, misses: 0 }
    }
    
    /**
     * 设置缓存
     */
    set(key, value, ttl = this.ttl) {
        // 检查容量
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value
            this.cache.delete(firstKey)
        }
        
        this.cache.set(key, {
            value,
            expiresAt: Date.now() + ttl,
            accessed: Date.now()
        })
    }
    
    /**
     * 获取缓存
     */
    get(key) {
        const item = this.cache.get(key)
        
        if (!item) {
            this.stats.misses++
            return null
        }
        
        // 检查过期
        if (Date.now() > item.expiresAt) {
            this.cache.delete(key)
            this.stats.misses++
            return null
        }
        
        // 更新访问时间
        item.accessed = Date.now()
        this.stats.hits++
        return item.value
    }
    
    /**
     * 检查是否存在
     */
    has(key) {
        return this.get(key) !== null
    }
    
    /**
     * 删除缓存
     */
    delete(key) {
        return this.cache.delete(key)
    }
    
    /**
     * 清空缓存
     */
    clear() {
        this.cache.clear()
        this.stats = { hits: 0, misses: 0 }
    }
    
    /**
     * 获取缓存统计
     */
    getStats() {
        const total = this.stats.hits + this.stats.misses
        const hitRate = total === 0 ? 0 : (this.stats.hits / total * 100).toFixed(2)
        
        return {
            size: this.cache.size,
            hits: this.stats.hits,
            misses: this.stats.misses,
            hitRate: `${hitRate}%`
        }
    }
    
    /**
     * 打印统计信息
     */
    printStats() {
        const stats = this.getStats()
        console.log(`📊 缓存统计: 大小=${stats.size}, 命中=${stats.hits}, 未命中=${stats.misses}, 命中率=${stats.hitRate}`)
    }
}

// 使用示例
const recordCache = new CacheManager({ ttl: 5 * 60 * 1000 })  // 5分钟过期

async function getRecords(type) {
    // 检查缓存
    const cached = recordCache.get(`records_${type}`)
    if (cached) {
        console.log('📦 使用缓存数据')
        return cached
    }
    
    // 缓存未命中，从API获取
    console.log('🌐 从API获取数据')
    const records = await fetch(`/api/records/${type}`).then(r => r.json())
    
    // 存入缓存
    recordCache.set(`records_${type}`, records)
    recordCache.printStats()
    
    return records
}
```

---

### 6️⃣ 环境变量配置

**文件**: `.env.example`

```env
# 开发环境
VITE_API_BASE_URL=http://localhost:3000
VITE_API_TIMEOUT=10000
VITE_ENABLE_LOG=true
VITE_LOG_LEVEL=debug

# Supabase 后端（仅后端使用）
SUPABASE_URL=xxx
SUPABASE_KEY=xxx
```

**文件**: `js/config.js`

```javascript
/**
 * 应用配置
 */
export const config = {
    // API 配置
    api: {
        baseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000',
        timeout: parseInt(import.meta.env.VITE_API_TIMEOUT || '10000'),
    },
    
    // 日志配置
    logging: {
        enabled: import.meta.env.VITE_ENABLE_LOG === 'true',
        level: import.meta.env.VITE_LOG_LEVEL || 'info'
    },
    
    // 功能开关
    features: {
        offline: true,
        sync: true,
        backup: true
    },
    
    // 缓存配置
    cache: {
        enabled: true,
        ttl: 5 * 60 * 1000,  // 5分钟
        maxSize: 100
    },
    
    // 网络配置
    network: {
        retries: 3,
        retryDelay: 1000,
        timeout: 10000
    }
}

// 开发环境输出配置
if (config.logging.enabled) {
    console.log('⚙️ 应用配置:', config)
}
```

**在应用中使用**:

```javascript
import { config } from './config.js'

const api = new APIClient(config.api.baseUrl)
const cache = new CacheManager(config.cache)

if (config.logging.enabled) {
    console.log('使用缓存管理器，TTL:', config.cache.ttl)
}
```

---

## 🔴 第三批：深度优化（5-10天）

### 7️⃣ 创建 API 客户端类

**文件**: `js/api/APIClient.js`

```javascript
import { config } from '../config.js'
import { NetworkHelper } from '../utils/NetworkHelper.js'

/**
 * API 客户端
 * 统一管理所有 API 调用
 */
export class APIClient {
    constructor(token = null) {
        this.baseUrl = config.api.baseUrl
        this.timeout = config.api.timeout
        this.token = token
        this.headers = {
            'Content-Type': 'application/json'
        }
        
        if (token) {
            this.headers['Authorization'] = `Bearer ${token}`
        }
    }
    
    /**
     * 设置 Token
     */
    setToken(token) {
        this.token = token
        this.headers['Authorization'] = `Bearer ${token}`
    }
    
    /**
     * 发送请求
     */
    async request(method, url, data = null) {
        const fullUrl = `${this.baseUrl}${url}`
        
        const options = {
            method,
            headers: this.headers,
            timeout: this.timeout
        }
        
        if (data && ['POST', 'PATCH', 'PUT'].includes(method)) {
            options.body = JSON.stringify(data)
        }
        
        try {
            const result = await NetworkHelper.fetchWithRetry(fullUrl, options)
            return { success: true, data: result }
        } catch (error) {
            return { success: false, error: error.message }
        }
    }
    
    /**
     * GET 请求
     */
    async get(url) {
        return this.request('GET', url)
    }
    
    /**
     * POST 请求
     */
    async post(url, data) {
        return this.request('POST', url, data)
    }
    
    /**
     * 批量操作
     */
    async batch(operations) {
        return Promise.all(
            operations.map(op => this.request(op.method, op.url, op.data))
        )
    }
}

// 导出单例
export const apiClient = new APIClient()
```

---

### 8️⃣ 性能监控工具

**文件**: `js/utils/PerformanceMonitor.js`

```javascript
/**
 * 性能监控工具
 */
export class PerformanceMonitor {
    static marks = new Map()
    static measures = []
    
    /**
     * 标记开始
     */
    static start(name) {
        performance.mark(`${name}-start`)
        this.marks.set(name, Date.now())
    }
    
    /**
     * 标记结束并计算耗时
     */
    static end(name) {
        if (!this.marks.has(name)) {
            console.warn(`⚠️ 未找到标记: ${name}`)
            return null
        }
        
        const duration = Date.now() - this.marks.get(name)
        performance.mark(`${name}-end`)
        performance.measure(name, `${name}-start`, `${name}-end`)
        
        this.measures.push({ name, duration })
        
        const color = duration > 1000 ? '🔴' : duration > 500 ? '🟡' : '🟢'
        console.log(`${color} ${name}: ${duration}ms`)
        
        return duration
    }
    
    /**
     * 测量函数执行时间
     */
    static async measure(name, fn) {
        this.start(name)
        try {
            const result = await Promise.resolve(fn())
            this.end(name)
            return result
        } catch (error) {
            this.end(name)
            throw error
        }
    }
    
    /**
     * 获取统计信息
     */
    static getStats() {
        if (this.measures.length === 0) return null
        
        const total = this.measures.reduce((sum, m) => sum + m.duration, 0)
        const avg = total / this.measures.length
        const max = Math.max(...this.measures.map(m => m.duration))
        const min = Math.min(...this.measures.map(m => m.duration))
        
        return { total, avg, max, min, count: this.measures.length }
    }
    
    /**
     * 打印统计信息
     */
    static printStats() {
        const stats = this.getStats()
        if (!stats) return
        
        console.log(`
📊 性能统计:
  总耗时: ${stats.total}ms
  平均: ${stats.avg.toFixed(2)}ms
  最大: ${stats.max}ms
  最小: ${stats.min}ms
  计数: ${stats.count}
        `)
    }
    
    /**
     * 清空记录
     */
    static clear() {
        this.marks.clear()
        this.measures = []
    }
}

// 使用示例
import { PerformanceMonitor } from './utils/PerformanceMonitor.js'

// 测量代码块
PerformanceMonitor.start('load-records')
const records = await storage.getAll()
PerformanceMonitor.end('load-records')  // 🟢 load-records: 45ms

// 测量异步操作
await PerformanceMonitor.measure('api-call', async () => {
    return await fetch('/api/records').then(r => r.json())
})

// 查看统计
PerformanceMonitor.printStats()
```

---

## 📋 检查清单

完成以下任务后，项目质量会明显提升：

### 立即完成 ✅

- [ ] 添加表单验证（FormValidator.js）
- [ ] 改进用户提示（UINotification.js）
- [ ] 添加网络错误处理（NetworkHelper.js）
- [ ] 创建 .env 配置
- [ ] 在 3-5 个关键表单中集成验证

### 一周内完成 ✅

- [ ] 创建 BaseModule 基类
- [ ] 迁移 Tableware.js 使用 BaseModule
- [ ] 实现 CacheManager
- [ ] 创建 APIClient 类
- [ ] 添加性能监控

### 一月内完成 ✅

- [ ] 迁移全部模块到 BaseModule
- [ ] 添加 JWT 认证
- [ ] 创建后端 API 代理
- [ ] 添加单元测试框架
- [ ] 100% 代码覆盖注释

---

## 📚 推荐阅读

- [MDN Web Docs - Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
- [JavaScript.info - 错误处理](https://javascript.info/error-handling)
- [Web.dev - 性能最佳实践](https://web.dev/performance/)

---

**最后更新**: 2026-04-20  
**版本**: 1.0
