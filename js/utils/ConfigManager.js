/**
 * ConfigManager - 统一的配置管理系统
 * 支持多环境、默认配置、覆盖等功能
 */

export class ConfigManager {
    constructor(environment = 'development') {
        this.environment = environment || process.env.NODE_ENV || 'development'
        this.config = {}
        this.defaults = {}
        this.overrides = {}
        this.initialized = false
    }

    /**
        refreshUrl: '/api/auth/refresh',
     */
    registerDefaults(defaults) {
        this.defaults = {
            ...this.defaults,
    // 数据源占位：迁移到腾讯云后，前端只应通过后端 API 访问数据
    dataSource: {
        baseUrl: '/api',
        mode: 'backend-proxy'
    },

    /**
     * 设置环境特定配置
     */
    setEnvironmentConfig(configs) {
        for (const [env, config] of Object.entries(configs)) {
            if (!this.config[env]) {
                this.config[env] = {}
            }
            this.config[env] = {
                ...this.config[env],
                ...config
            }
        }
        return this
    }

    /**
     * 设置覆盖配置
     */
    setOverrides(overrides) {
        this.overrides = {
            ...this.overrides,
            ...overrides
        }
        return this
    }

    /**
     * 初始化配置
     */
    initialize() {
        // 合并配置优先级: 默认 < 环境特定 < 覆盖
        const environmentConfig = this.config[this.environment] || {}
        this.mergedConfig = {
            ...this.defaults,
            ...environmentConfig,
            ...this.overrides
        }
        this.initialized = true
        console.log(`✅ 配置初始化完成 (环境: ${this.environment})`)
        return this
    }

    /**
     * 获取配置值
     */
    get(key, defaultValue = undefined) {
        if (!this.initialized) {
            console.warn(`⚠️ 配置未初始化，请先调用initialize()`)
            return defaultValue
        }

        // 支持点号路径 (如: 'api.baseUrl')
        if (key.includes('.')) {
            return this.getNestedValue(this.mergedConfig, key, defaultValue)
        }

        return this.mergedConfig[key] !== undefined ? this.mergedConfig[key] : defaultValue
    }

    /**
     * 获取嵌套配置值
     */
    getNestedValue(obj, path, defaultValue) {
        const keys = path.split('.')
        let value = obj

        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key]
            } else {
                return defaultValue
            }
        }

        return value
    }

    /**
     * 设置配置值
     */
    set(key, value) {
        if (!this.initialized) {
            this.initialize()
        }

        if (key.includes('.')) {
            this.setNestedValue(this.mergedConfig, key, value)
        } else {
            this.mergedConfig[key] = value
        }

        return this
    }

    /**
     * 设置嵌套配置值
     */
    setNestedValue(obj, path, value) {
        const keys = path.split('.')
        const lastKey = keys.pop()

        let current = obj
        for (const key of keys) {
            if (!(key in current) || typeof current[key] !== 'object') {
                current[key] = {}
            }
            current = current[key]
        }

        current[lastKey] = value
    }

    /**
     * 检查配置是否存在
     */
    has(key) {
        if (!this.initialized) {
            return false
        }
        return this.get(key) !== undefined
    }

    /**
     * 获取所有配置
     */
    getAll() {
        if (!this.initialized) {
            this.initialize()
        }
        return { ...this.mergedConfig }
    }

    /**
     * 打印配置（用于调试）
     */
    debug() {
        if (!this.initialized) {
            this.initialize()
        }

        console.log('📋 配置信息:')
        console.log(`环境: ${this.environment}`)
        console.log('配置:', JSON.stringify(this.mergedConfig, null, 2))
    }

    /**
     * 验证必需配置
     */
    validate(requiredKeys) {
        if (!this.initialized) {
            this.initialize()
        }

        const missing = []
        for (const key of requiredKeys) {
            if (!this.has(key)) {
                missing.push(key)
            }
        }

        if (missing.length > 0) {
            console.error('❌ 缺少必需配置项:', missing)
            throw new Error(`缺少必需配置: ${missing.join(', ')}`)
        }

        console.log('✅ 所有必需配置已设置')
        return true
    }
}

/**
 * 全局配置管理器实例
 */
let configInstance = null

export function getConfigManager() {
    if (!configInstance) {
        const env = typeof process !== 'undefined' ? process.env.NODE_ENV : 'development'
        configInstance = new ConfigManager(env)
    }
    return configInstance
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG = {
    // 环境
    environment: 'development',
    debug: true,
    logLevel: 'info', // info, warn, error

    // API
    api: {
        baseUrl: 'http://localhost:3000',
        timeout: 30000,
        retryAttempts: 3,
        retryDelay: 1000
    },

    // 认证
    auth: {
        tokenKey: 'auth_token',
        refreshUrl: '/api/auth/refresh',
        tokenRefreshInterval: 10 * 60 * 1000 // 10分钟
    },

    // 缓存
    cache: {
        enabled: true,
        maxSize: 100,
        defaultTTL: 60 * 60 * 1000, // 1小时
        enableLocalStorage: true,
        namespace: 'app'
    },

    // 数据源占位：迁移到腾讯云后，前端只应通过后端 API 访问数据
    dataSource: {
        baseUrl: '/api',
        mode: 'backend-proxy'
    },

    // UI
    ui: {
        pageSize: 20,
        animationDuration: 300,
        theme: 'light' // light, dark
    },

    // 功能开关
    features: {
        enableCache: true,
        enableValidation: true,
        enableAuditLog: true,
        enableOfflineMode: false
    }
}

/**
 * 环境特定配置
 */
export const ENVIRONMENT_CONFIG = {
    development: {
        debug: true,
        logLevel: 'debug',
        api: {
            baseUrl: 'http://localhost:3000',
            timeout: 60000
        },
        features: {
            enableOfflineMode: true
        }
    },

    staging: {
        debug: false,
        logLevel: 'info',
        api: {
            baseUrl: '/api',
            timeout: 30000
        }
    },

    production: {
        debug: false,
        logLevel: 'warn',
        api: {
            baseUrl: '/api',
            timeout: 20000
        },
        cache: {
            defaultTTL: 2 * 60 * 60 * 1000 // 2小时
        }
    }
}

/**
 * 使用示例
 */
export function setupConfig(environment = 'development') {
    const config = getConfigManager()

    // 注册默认配置
    config.registerDefaults(DEFAULT_CONFIG)

    // 设置环境特定配置
    config.setEnvironmentConfig(ENVIRONMENT_CONFIG)

    // 初始化
    config.initialize()

    // 验证必需配置
    config.validate([
        'api.baseUrl',
        'auth.tokenKey',
        'cache.namespace'
    ])

    return config
}

export default ConfigManager

/**
 * 使用示例
 */

/*

import { setupConfig, getConfigManager } from './config.js'

// 初始化配置
setupConfig(process.env.NODE_ENV || 'development')

const config = getConfigManager()

// 获取配置值
const apiUrl = config.get('api.baseUrl')        // http://localhost:3000 或生产同源代理
const cacheEnabled = config.get('cache.enabled') // true
const pageSize = config.get('ui.pageSize')       // 20

// 设置配置值
config.set('ui.theme', 'dark')

// 检查配置
if (config.has('features.enableCache')) {
    console.log('缓存功能已启用')
}

// 获取所有配置
const allConfig = config.getAll()

// 调试输出
config.debug()

// 初始化API客户端
const apiClient = new ApiClient(config.get('api.baseUrl'))

// 初始化缓存管理器
const cache = new CacheManager(config.get('cache'))

// 初始化认证系统
const auth = new UserAuth(config.get('auth'))

*/
