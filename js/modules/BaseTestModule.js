/**
 * BaseTestModule - 所有测试模块的基类
 * 提供统一的数据操作、事件系统、UI管理等功能
 */

import { getCacheManager } from '../utils/CacheManager.js'

export class BaseTestModule {
    constructor(moduleName, apiClient, userAuth, cacheOptions = {}) {
        this.moduleName = moduleName
        this.apiClient = apiClient
        this.userAuth = userAuth
        this.listeners = {}
        this.data = []
        this.isLoading = false
        this.currentPage = 1
        this.pageSize = 20
        this.filter = {}
        this.sortBy = 'created_at'
        this.sortOrder = 'desc'

        // 缓存配置
        this.cacheManager = getCacheManager()
        this.cacheEnabled = cacheOptions.enabled !== false
        this.cacheTTL = cacheOptions.ttl || 30 * 60 * 1000 // 默认30分钟
    }

    // ====== Event System ======

    /**
     * 监听事件
     */
    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = []
        }
        this.listeners[event].push(callback)
        return this // 支持链式调用
    }

    /**
     * 取消监听事件
     */
    off(event, callback) {
        if (!this.listeners[event]) {
            return this
        }
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback)
        return this
    }

    /**
     * 触发事件
     */
    emit(event, data) {
        if (!this.listeners[event]) {
            return
        }
        this.listeners[event].forEach(callback => {
            try {
                callback(data)
            } catch (error) {
                console.error(`❌ 事件回调错误 [${this.moduleName}:${event}]:`, error)
            }
        })
    }

    /**
     * 一次性监听
     */
    once(event, callback) {
        const wrapper = (data) => {
            callback(data)
            this.off(event, wrapper)
        }
        return this.on(event, wrapper)
    }

    // ====== Data Loading ======

    /**
     * 加载所有数据
     */
    async loadData(options = {}) {
        try {
            this.isLoading = true
            this.emit('loading', { isLoading: true })

            const {
                page = this.currentPage,
                pageSize = this.pageSize,
                filter = this.filter,
                sortBy = this.sortBy,
                sortOrder = this.sortOrder,
                skipCache = false
            } = options

            // 构建查询参数
            const params = new URLSearchParams()
            params.append('page', page)
            params.append('pageSize', pageSize)
            params.append('sortBy', sortBy)
            params.append('sortOrder', sortOrder)

            // 添加过滤条件
            for (const [key, value] of Object.entries(filter)) {
                if (value !== null && value !== undefined && value !== '') {
                    params.append(filter, value)
                }
            }

            const queryString = params.toString()
            const cacheKey = `${this.moduleName}:list:${queryString}`

            // 尝试从缓存获取
            if (this.cacheEnabled && !skipCache) {
                const cached = this.cacheManager.get(cacheKey)
                if (cached) {
                    this.data = cached.data || []
                    this.currentPage = page
                    this.pageSize = pageSize
                    this.filter = filter
                    this.sortBy = sortBy
                    this.sortOrder = sortOrder

                    this.emit('data-loaded', {
                        count: this.data.length,
                        total: cached.total,
                        page: page,
                        fromCache: true
                    })

                    this.isLoading = false
                    this.emit('loading', { isLoading: false })
                    return { success: true, ...cached, fromCache: true }
                }
            }

            // 调用API
            const response = await this.apiClient.get(
                `/records/${this.moduleName}?${queryString}`,
                this.userAuth.getToken()
            )

            if (response.success) {
                this.data = response.data || []
                this.currentPage = page
                this.pageSize = pageSize
                this.filter = filter
                this.sortBy = sortBy
                this.sortOrder = sortOrder

                // 缓存结果
                if (this.cacheEnabled) {
                    this.cacheManager.set(cacheKey, {
                        data: response.data,
                        total: response.total
                    }, this.cacheTTL)
                }

                this.emit('data-loaded', {
                    count: this.data.length,
                    total: response.total,
                    page: page,
                    fromCache: false
                })
            } else {
                this.emit('error', { message: response.error || '❌ 加载数据失败' })
            }

            return response
        } catch (error) {
            console.error(`❌ 加载${this.moduleName}数据失败:`, error)
            this.emit('error', { message: error.message })
            return { success: false, error: error.message }
        } finally {
            this.isLoading = false
            this.emit('loading', { isLoading: false })
        }
    }

    /**
     * 获取单条数据
     */
    async getDataById(id) {
        try {
            const response = await this.apiClient.get(
                `/records/${this.moduleName}/${id}`,
                this.userAuth.getToken()
            )

            if (response.success) {
                this.emit('data-fetched', { id, data: response.data })
            } else {
                this.emit('error', { message: response.error })
            }

            return response
        } catch (error) {
            console.error(`❌ 获取数据失败:`, error)
            this.emit('error', { message: error.message })
            return { success: false, error: error.message }
        }
    }

    // ====== Data Manipulation ======

    /**
     * 添加新记录
     */
    async addData(formData) {
        try {
            this.emit('saving', { isSaving: true })

            const response = await this.apiClient.post(
                `/records/${this.moduleName}`,
                formData,
                this.userAuth.getToken()
            )

            if (response.success) {
                this.data.unshift(response.data)
                // 失效缓存
                if (this.cacheEnabled) {
                    this.cacheManager.invalidatePrefix(`${this.moduleName}:list:`)
                }
                this.emit('data-added', response.data)
                this.emit('success', { message: '✅ 数据添加成功' })
            } else {
                this.emit('error', { message: response.error })
            }

            return response
        } catch (error) {
            console.error(`❌ 添加数据失败:`, error)
            this.emit('error', { message: error.message })
            return { success: false, error: error.message }
        } finally {
            this.emit('saving', { isSaving: false })
        }
    }

    /**
     * 更新记录
     */
    async updateData(id, formData) {
        try {
            this.emit('saving', { isSaving: true })

            const response = await this.apiClient.put(
                `/records/${this.moduleName}/${id}`,
                formData,
                this.userAuth.getToken()
            )

            if (response.success) {
                // 更新本地数据
                const index = this.data.findIndex(item => item.id === id)
                if (index !== -1) {
                    this.data[index] = response.data
                }
                // 失效缓存
                if (this.cacheEnabled) {
                    this.cacheManager.invalidatePrefix(`${this.moduleName}:`)
                }
                this.emit('data-updated', response.data)
                this.emit('success', { message: '✅ 数据更新成功' })
            } else {
                this.emit('error', { message: response.error })
            }

            return response
        } catch (error) {
            console.error(`❌ 更新数据失败:`, error)
            this.emit('error', { message: error.message })
            return { success: false, error: error.message }
        } finally {
            this.emit('saving', { isSaving: false })
        }
    }

    /**
     * 删除记录
     */
    async deleteData(id) {
        try {
            this.emit('deleting', { isDeleting: true })

            const response = await this.apiClient.delete(
                `/records/${this.moduleName}/${id}`,
                this.userAuth.getToken()
            )

            if (response.success) {
                // 从本地数据删除
                this.data = this.data.filter(item => item.id !== id)
                // 失效缓存
                if (this.cacheEnabled) {
                    this.cacheManager.invalidatePrefix(`${this.moduleName}:`)
                }
                this.emit('data-deleted', { id })
                this.emit('success', { message: '✅ 数据删除成功' })
            } else {
                this.emit('error', { message: response.error })
            }

            return response
        } catch (error) {
            console.error(`❌ 删除数据失败:`, error)
            this.emit('error', { message: error.message })
            return { success: false, error: error.message }
        } finally {
            this.emit('deleting', { isDeleting: false })
        }
    }

    // ====== Batch Operations ======

    /**
     * 批量删除
     */
    async deleteMultiple(ids) {
        try {
            this.emit('deleting', { isDeleting: true })

            const response = await this.apiClient.post(
                `/records/${this.moduleName}/batch-delete`,
                { ids },
                this.userAuth.getToken()
            )

            if (response.success) {
                this.data = this.data.filter(item => !ids.includes(item.id))
                this.emit('data-deleted', { count: ids.length })
                this.emit('success', { message: `✅ 批量删除${ids.length}条数据成功` })
            } else {
                this.emit('error', { message: response.error })
            }

            return response
        } catch (error) {
            console.error(`❌ 批量删除失败:`, error)
            this.emit('error', { message: error.message })
            return { success: false, error: error.message }
        } finally {
            this.emit('deleting', { isDeleting: false })
        }
    }

    // ====== Filtering & Sorting ======

    /**
     * 设置过滤条件
     */
    setFilter(filter) {
        this.filter = filter
        this.currentPage = 1 // 重置到第一页
        return this
    }

    /**
     * 设置排序
     */
    setSort(sortBy, sortOrder = 'asc') {
        this.sortBy = sortBy
        this.sortOrder = sortOrder
        return this
    }

    /**
     * 搜索数据
     */
    async search(keyword) {
        try {
            const params = new URLSearchParams()
            params.append('search', keyword)
            params.append('page', 1)
            params.append('pageSize', this.pageSize)

            const response = await this.apiClient.get(
                `/records/${this.moduleName}/search?${params.toString()}`,
                this.userAuth.getToken()
            )

            if (response.success) {
                this.data = response.data || []
                this.currentPage = 1
                this.emit('search-results', { keyword, count: this.data.length })
            } else {
                this.emit('error', { message: response.error })
            }

            return response
        } catch (error) {
            console.error(`❌ 搜索失败:`, error)
            this.emit('error', { message: error.message })
            return { success: false, error: error.message }
        }
    }

    // ====== Pagination ======

    /**
     * 前往指定页
     */
    async goToPage(page) {
        if (page < 1) page = 1
        return this.loadData({ page })
    }

    /**
     * 下一页
     */
    async nextPage() {
        return this.goToPage(this.currentPage + 1)
    }

    /**
     * 上一页
     */
    async previousPage() {
        if (this.currentPage > 1) {
            return this.goToPage(this.currentPage - 1)
        }
    }

    // ====== Statistics ======

    /**
     * 获取统计数据
     */
    async getStatistics() {
        try {
            const response = await this.apiClient.get(
                `/statistics/${this.moduleName}`,
                this.userAuth.getToken()
            )

            if (response.success) {
                this.emit('statistics', response.data)
            } else {
                this.emit('error', { message: response.error })
            }

            return response
        } catch (error) {
            console.error(`❌ 获取统计失败:`, error)
            this.emit('error', { message: error.message })
            return { success: false, error: error.message }
        }
    }

    // ====== Export ======

    /**
     * 导出数据为CSV
     */
    exportAsCSV(filename = `${this.moduleName}-export.csv`) {
        try {
            if (this.data.length === 0) {
                console.warn('⚠️ 没有数据可导出')
                return false
            }

            // 获取所有键
            const keys = Object.keys(this.data[0])

            // 生成CSV内容
            let csv = keys.join(',') + '\n'
            this.data.forEach(item => {
                const values = keys.map(key => {
                    const value = item[key]
                    // 处理包含逗号或引号的值
                    if (value === null || value === undefined) {
                        return ''
                    }
                    const stringValue = String(value)
                    if (stringValue.includes(',') || stringValue.includes('"')) {
                        return `"${stringValue.replace(/"/g, '""')}"`
                    }
                    return stringValue
                })
                csv += values.join(',') + '\n'
            })

            // 下载CSV文件
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
            const link = document.createElement('a')
            const url = URL.createObjectURL(blob)
            link.setAttribute('href', url)
            link.setAttribute('download', filename)
            link.style.visibility = 'hidden'
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)

            this.emit('exported', { format: 'csv', count: this.data.length })
            return true
        } catch (error) {
            console.error(`❌ 导出CSV失败:`, error)
            this.emit('error', { message: '❌ 导出失败: ' + error.message })
            return false
        }
    }

    /**
     * 导出数据为JSON
     */
    exportAsJSON(filename = `${this.moduleName}-export.json`) {
        try {
            if (this.data.length === 0) {
                console.warn('⚠️ 没有数据可导出')
                return false
            }

            const json = JSON.stringify(this.data, null, 2)
            const blob = new Blob([json], { type: 'application/json;charset=utf-8;' })
            const link = document.createElement('a')
            const url = URL.createObjectURL(blob)
            link.setAttribute('href', url)
            link.setAttribute('download', filename)
            link.style.visibility = 'hidden'
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)

            this.emit('exported', { format: 'json', count: this.data.length })
            return true
        } catch (error) {
            console.error(`❌ 导出JSON失败:`, error)
            this.emit('error', { message: '❌ 导出失败: ' + error.message })
            return false
        }
    }

    // ====== Utility Methods ======

    /**
     * 获取所有数据
     */
    getData() {
        return this.data
    }

    /**
     * 获取单条数据
     */
    getItemById(id) {
        return this.data.find(item => item.id === id)
    }

    /**
     * 清空所有数据
     */
    clearData() {
        this.data = []
        this.currentPage = 1
        this.emit('data-cleared')
    }

    /**
     * 获取加载状态
     */
    getLoadingState() {
        return this.isLoading
    }

    /**
     * 获取当前分页信息
     */
    getPaginationInfo() {
        return {
            currentPage: this.currentPage,
            pageSize: this.pageSize,
            totalItems: this.data.length
        }
    }

    // ====== IndexedDB Support ======

    /**
     * 初始化IndexedDB存储
     */
    async initIndexedDB(db) {
        try {
            if (!db) {
                console.warn('⚠️ IndexedDB管理器未初始化')
                return false
            }

            this.db = db
            this.dbStoreName = this.moduleName.toLowerCase()

            // 从IndexedDB加载数据到内存
            const cachedData = await this.db.getAll(this.dbStoreName)
            if (cachedData && cachedData.length > 0) {
                this.data = cachedData
                console.log(`✓ 从IndexedDB加载 ${cachedData.length} 条数据到 ${this.moduleName}`)
                this.emit('data-loaded', { source: 'indexeddb', count: cachedData.length })
            }

            return true
        } catch (error) {
            console.error(`❌ IndexedDB初始化失败:`, error)
            return false
        }
    }

    /**
     * 保存数据到IndexedDB
     */
    async saveToIndexedDB(item) {
        if (!this.db || !this.dbStoreName) return false

        try {
            await this.db.update(this.dbStoreName, {
                ...item,
                _savedAt: Date.now()
            })
            return true
        } catch (error) {
            console.error('❌ 保存到IndexedDB失败:', error)
            return false
        }
    }

    /**
     * 从IndexedDB查询数据
     */
    async queryIndexedDB(predicate) {
        if (!this.db || !this.dbStoreName) return []

        try {
            return await this.db.query(this.dbStoreName, predicate)
        } catch (error) {
            console.error('❌ IndexedDB查询失败:', error)
            return []
        }
    }

    /**
     * 销毁模块（清理资源）
     */
    destroy() {
        this.listeners = {}
        this.data = []
        this.isLoading = false
        this.emit('destroyed')
    }
}

/**
 * 使用示例
 */
export class GenericTestModule extends BaseTestModule {
    constructor(apiClient, userAuth) {
        super('generic_test', apiClient, userAuth)
    }

    // 可以覆盖或扩展基类方法
    async loadData(options = {}) {
        // 调用父类方法
        return super.loadData(options)
    }
}

export class PathogenTestModule extends BaseTestModule {
    constructor(apiClient, userAuth) {
        super('pathogen_test', apiClient, userAuth)
    }
}

export class TablewearTestModule extends BaseTestModule {
    constructor(apiClient, userAuth) {
        super('tableware_test', apiClient, userAuth)
    }
}

/**
 * 工厂函数：创建指定类型的模块
 */
export function createTestModule(moduleName, apiClient, userAuth) {
    const moduleMap = {
        'generic': GenericTestModule,
        'pathogen': PathogenTestModule,
        'tableware': TablewearTestModule
    }

    const ModuleClass = moduleMap[moduleName]
    if (!ModuleClass) {
        throw new Error(`❌ 未知的模块类型: ${moduleName}`)
    }

    return new ModuleClass(apiClient, userAuth)
}

export default BaseTestModule
