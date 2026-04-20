/**
 * CacheManager - 统一的缓存管理系统
 * 支持内存缓存、localStorage缓存、自动过期等功能
 */

export class CacheManager {
    constructor(options = {}) {
        this.options = {
            maxSize: options.maxSize || 100, // 最多缓存项数
            defaultTTL: options.defaultTTL || 60 * 60 * 1000, // 默认过期时间 (1小时)
            enableLocalStorage: options.enableLocalStorage !== false,
            namespace: options.namespace || 'cache',
            ...options
        }

        this.memoryCache = new Map()
        this.cacheStats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0
        }

        this.startCleanupTimer()
    }

    // ====== Memory Cache ======

    /**
     * 生成缓存键
     */
    generateKey(key) {
        return `${this.options.namespace}:${key}`
    }

    /**
     * 获取缓存（内存 + localStorage）
     */
    get(key) {
        const cacheKey = this.generateKey(key)

        // 1. 尝试从内存获取
        const memoryData = this.memoryCache.get(cacheKey)
        if (memoryData) {
            // 检查是否过期
            if (this.isExpired(memoryData)) {
                this.delete(key)
                this.cacheStats.misses++
                return null
            }

            this.cacheStats.hits++
            memoryData.accessCount = (memoryData.accessCount || 0) + 1
            memoryData.lastAccess = Date.now()
            return memoryData.value
        }

        // 2. 尝试从localStorage获取
        if (this.options.enableLocalStorage) {
            const localData = this.getFromLocalStorage(cacheKey)
            if (localData) {
                // 检查是否过期
                if (this.isExpired(localData)) {
                    this.deleteFromLocalStorage(cacheKey)
                    this.cacheStats.misses++
                    return null
                }

                // 恢复到内存
                this.memoryCache.set(cacheKey, localData)
                this.cacheStats.hits++
                localData.accessCount = (localData.accessCount || 0) + 1
                localData.lastAccess = Date.now()
                return localData.value
            }
        }

        this.cacheStats.misses++
        return null
    }

    /**
     * 设置缓存
     */
    set(key, value, ttl = this.options.defaultTTL) {
        const cacheKey = this.generateKey(key)

        // 检查是否超过缓存大小限制
        if (this.memoryCache.size >= this.options.maxSize) {
            this.evictLRU() // 清除最少使用的项
        }

        const cacheData = {
            value,
            ttl,
            createdAt: Date.now(),
            expiresAt: Date.now() + ttl,
            accessCount: 0,
            lastAccess: Date.now(),
            size: this.estimateSize(value)
        }

        // 保存到内存
        this.memoryCache.set(cacheKey, cacheData)

        // 保存到localStorage
        if (this.options.enableLocalStorage) {
            this.setToLocalStorage(cacheKey, cacheData)
        }

        this.cacheStats.sets++
        return this
    }

    /**
     * 删除缓存
     */
    delete(key) {
        const cacheKey = this.generateKey(key)

        this.memoryCache.delete(cacheKey)

        if (this.options.enableLocalStorage) {
            this.deleteFromLocalStorage(cacheKey)
        }

        this.cacheStats.deletes++
        return this
    }

    /**
     * 清空所有缓存
     */
    clear() {
        this.memoryCache.clear()

        if (this.options.enableLocalStorage) {
            this.clearLocalStorage()
        }

        this.cacheStats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0
        }

        return this
    }

    /**
     * 检查缓存是否存在
     */
    has(key) {
        const cacheKey = this.generateKey(key)
        const data = this.memoryCache.get(cacheKey)
        
        if (!data) {
            return false
        }

        // 检查是否过期
        if (this.isExpired(data)) {
            this.delete(key)
            return false
        }

        return true
    }

    // ====== Cache Utilities ======

    /**
     * 检查是否过期
     */
    isExpired(cacheData) {
        return Date.now() > cacheData.expiresAt
    }

    /**
     * 估计数据大小（字节）
     */
    estimateSize(value) {
        const json = JSON.stringify(value)
        return json.length * 2 // 粗略估计，每个字符约2字节
    }

    /**
     * 清除最少使用的缓存项
     */
    evictLRU() {
        // 找到访问次数最少且最久未使用的项
        let minItem = null
        let minScore = Infinity

        for (const [key, data] of this.memoryCache.entries()) {
            const score = (data.accessCount + 1) * (Date.now() - data.lastAccess)
            if (score < minScore) {
                minScore = score
                minItem = key
            }
        }

        if (minItem) {
            const key = minItem.replace(this.options.namespace + ':', '')
            this.delete(key)
        }
    }

    /**
     * 获取缓存统计信息
     */
    getStats() {
        const total = this.cacheStats.hits + this.cacheStats.misses
        const hitRate = total > 0 ? ((this.cacheStats.hits / total) * 100).toFixed(2) : 0

        return {
            ...this.cacheStats,
            total,
            hitRate: `${hitRate}%`,
            size: this.memoryCache.size,
            maxSize: this.options.maxSize
        }
    }

    /**
     * 重置统计信息
     */
    resetStats() {
        this.cacheStats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0
        }
        return this
    }

    // ====== LocalStorage Integration ======

    /**
     * 从localStorage获取
     */
    getFromLocalStorage(key) {
        try {
            const data = localStorage.getItem(key)
            return data ? JSON.parse(data) : null
        } catch (error) {
            console.warn(`⚠️ LocalStorage读取失败 [${key}]:`, error)
            return null
        }
    }

    /**
     * 保存到localStorage
     */
    setToLocalStorage(key, data) {
        try {
            // 检查localStorage是否满
            const serialized = JSON.stringify(data)
            if (serialized.length > 1024 * 1024) { // 超过1MB不保存
                console.warn(`⚠️ 数据过大，跳过localStorage保存: ${key}`)
                return
            }

            localStorage.setItem(key, serialized)
        } catch (error) {
            if (error.name === 'QuotaExceededError') {
                console.warn(`⚠️ LocalStorage已满，清理过期数据...`)
                this.clearExpiredFromLocalStorage()
            } else {
                console.warn(`⚠️ LocalStorage保存失败 [${key}]:`, error)
            }
        }
    }

    /**
     * 从localStorage删除
     */
    deleteFromLocalStorage(key) {
        try {
            localStorage.removeItem(key)
        } catch (error) {
            console.warn(`⚠️ LocalStorage删除失败 [${key}]:`, error)
        }
    }

    /**
     * 清空LocalStorage中该命名空间的数据
     */
    clearLocalStorage() {
        try {
            const prefix = this.options.namespace + ':'
            const keys = []

            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i)
                if (key && key.startsWith(prefix)) {
                    keys.push(key)
                }
            }

            keys.forEach(key => localStorage.removeItem(key))
        } catch (error) {
            console.warn(`⚠️ LocalStorage清空失败:`, error)
        }
    }

    /**
     * 清除LocalStorage中的过期数据
     */
    clearExpiredFromLocalStorage() {
        try {
            const prefix = this.options.namespace + ':'
            const keys = []

            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i)
                if (key && key.startsWith(prefix)) {
                    keys.push(key)
                }
            }

            let cleared = 0
            keys.forEach(key => {
                const data = this.getFromLocalStorage(key)
                if (data && this.isExpired(data)) {
                    localStorage.removeItem(key)
                    cleared++
                }
            })

            if (cleared > 0) {
                console.log(`✅ 清除${cleared}个过期缓存项`)
            }
        } catch (error) {
            console.warn(`⚠️ 清除过期缓存失败:`, error)
        }
    }

    // ====== Batch Operations ======

    /**
     * 批量获取
     */
    mget(keys) {
        const results = {}
        for (const key of keys) {
            results[key] = this.get(key)
        }
        return results
    }

    /**
     * 批量设置
     */
    mset(data, ttl = this.options.defaultTTL) {
        for (const [key, value] of Object.entries(data)) {
            this.set(key, value, ttl)
        }
        return this
    }

    /**
     * 批量删除
     */
    mdel(keys) {
        for (const key of keys) {
            this.delete(key)
        }
        return this
    }

    // ====== Invalidation ======

    /**
     * 清除匹配模式的缓存
     */
    invalidatePattern(pattern) {
        const regex = new RegExp(pattern)
        const keys = []

        for (const key of this.memoryCache.keys()) {
            if (regex.test(key)) {
                keys.push(key)
            }
        }

        keys.forEach(key => {
            this.memoryCache.delete(key)
            if (this.options.enableLocalStorage) {
                this.deleteFromLocalStorage(key)
            }
        })

        return keys.length
    }

    /**
     * 清除命名空间前缀的缓存
     */
    invalidatePrefix(prefix) {
        return this.invalidatePattern(`^${this.options.namespace}:${prefix}`)
    }

    // ====== Cleanup ======

    /**
     * 定时清理过期缓存
     */
    startCleanupTimer() {
        this.cleanupInterval = setInterval(() => {
            this.cleanup()
        }, 5 * 60 * 1000) // 每5分钟清理一次
    }

    /**
     * 停止清理定时器
     */
    stopCleanupTimer() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
        }
    }

    /**
     * 执行清理
     */
    cleanup() {
        const keys = []

        for (const [key, data] of this.memoryCache.entries()) {
            if (this.isExpired(data)) {
                keys.push(key)
            }
        }

        keys.forEach(key => {
            const originalKey = key.replace(this.options.namespace + ':', '')
            this.delete(originalKey)
        })

        // 清理localStorage中的过期数据
        if (this.options.enableLocalStorage) {
            this.clearExpiredFromLocalStorage()
        }

        if (keys.length > 0) {
            console.log(`✅ 缓存清理: 删除${keys.length}个过期项`)
        }
    }

    /**
     * 销毁缓存管理器
     */
    destroy() {
        this.stopCleanupTimer()
        this.clear()
    }
}

/**
 * 单例缓存管理器
 */
let cacheInstance = null

export function getCacheManager(options = {}) {
    if (!cacheInstance) {
        cacheInstance = new CacheManager(options)
    }
    return cacheInstance
}

/**
 * API缓存装饰器
 */
export function withCache(fn, ttl = 60 * 60 * 1000) {
    const cache = getCacheManager()

    return async function (...args) {
        // 生成缓存键
        const cacheKey = `${fn.name}:${JSON.stringify(args)}`

        // 尝试从缓存获取
        const cached = cache.get(cacheKey)
        if (cached !== null) {
            console.log(`✅ 缓存命中: ${cacheKey}`)
            return cached
        }

        // 执行函数
        try {
            const result = await fn.apply(this, args)
            // 缓存结果
            cache.set(cacheKey, result, ttl)
            return result
        } catch (error) {
            console.error(`❌ 缓存函数执行失败:`, error)
            throw error
        }
    }
}

/**
 * 缓存数据选项装饰器（用于对象方法）
 */
export function CacheableMethod(ttl = 60 * 60 * 1000) {
    return function (target, propertyKey, descriptor) {
        const originalMethod = descriptor.value
        const cache = getCacheManager()

        descriptor.value = async function (...args) {
            const cacheKey = `${target.constructor.name}:${propertyKey}:${JSON.stringify(args)}`

            // 尝试从缓存获取
            const cached = cache.get(cacheKey)
            if (cached !== null) {
                console.log(`✅ 缓存命中: ${cacheKey}`)
                return cached
            }

            // 执行原始方法
            const result = await originalMethod.apply(this, args)

            // 缓存结果
            cache.set(cacheKey, result, ttl)

            return result
        }

        return descriptor
    }
}

export default CacheManager

/**
 * 使用示例
 */

/*

import { CacheManager, getCacheManager, withCache } from './CacheManager.js'

// 创建缓存管理器
const cache = new CacheManager({
    maxSize: 100,
    defaultTTL: 60 * 60 * 1000, // 1小时
    enableLocalStorage: true,
    namespace: 'app'
})

// 基本使用
cache.set('user:1', { id: 1, name: 'Admin' }, 30 * 60 * 1000) // 30分钟
const user = cache.get('user:1')
console.log(user) // { id: 1, name: 'Admin' }

// 检查是否存在
if (cache.has('user:1')) {
    console.log('缓存存在')
}

// 删除缓存
cache.delete('user:1')

// 批量操作
cache.mset({
    'data:1': { value: 1 },
    'data:2': { value: 2 },
    'data:3': { value: 3 }
})

const results = cache.mget(['data:1', 'data:2', 'data:3'])

// 清除模式匹配的缓存
cache.invalidatePrefix('user:') // 清除所有user:前缀的缓存

// 获取统计信息
const stats = cache.getStats()
console.log(stats)
// {
//   hits: 5,
//   misses: 2,
//   sets: 10,
//   deletes: 3,
//   total: 7,
//   hitRate: "71.43%",
//   size: 7,
//   maxSize: 100
// }

// 使用装饰器
const getCachedData = withCache(async (id) => {
    const response = await fetch(`/api/data/${id}`)
    return response.json()
}, 30 * 60 * 1000)

const data = await getCachedData(1) // 第一次调用，从API获取
const cachedData = await getCachedData(1) // 第二次调用，从缓存获取

// 清空所有缓存
cache.clear()

// 销毁管理器
cache.destroy()

*/
