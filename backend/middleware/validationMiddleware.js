/**
 * Validation Middleware - 后端输入验证中间件
 * 提供请求数据验证、XSS防护、SQL注入防护
 */

// ====== XSS Prevention ======

export function escapeHtml(text) {
    if (typeof text !== 'string') {
        return text
    }

    const escapeMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '/': '&#x2F;'
    }

    return text.replace(/[&<>"'\/]/g, (char) => escapeMap[char])
}

export function sanitizeHtml(text) {
    if (typeof text !== 'string') {
        return text
    }

    let sanitized = text
        // NB-28: 简化为无嵌套量词的正则，避免灾难性回溯（ReDoS）
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
        .replace(/on\w+\s*=\s*[^\s>]*/gi, '')

    return sanitized
}

export function sanitizeText(text) {
    if (typeof text !== 'string') {
        return text
    }

    return escapeHtml(sanitizeHtml(text))
}

// ====== SQL Injection Prevention ======
// ⚠️ 单一事实源锚点：本函数为 SQL 注入校验的权威实现，与前端 js/utils/FormValidator.js:104 (sqlInjection 规则) 同步维护，
//    任一侧改动须同步另一侧（P2-8 收敛）。

export function detectSqlInjection(value) {
    if (typeof value !== 'string') {
        return false
    }

    const sqlInjectionPatterns = [
        /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|FROM|WHERE|SCRIPT|JAVASCRIPT)\b)/gi,
        /(OR|AND)\s+(\d+|'[^']*')\s*=/gi,
        /UNION\s+SELECT/gi,
        /OR\s*1\s*=\s*1/gi,
        /'\s*OR\s*'1'='1/gi,
        /"\s*OR\s*"1"="1/gi,
        /--\s*$/gi,
        /\/\*.*\*\//gi
    ]

    for (const pattern of sqlInjectionPatterns) {
        if (pattern.test(value)) {
            return true
        }
    }

    return false
}

// ====== Data Sanitization ======

export function sanitizeData(data) {
    if (typeof data === 'string') {
        return sanitizeText(data)
    }

    if (typeof data === 'object' && data !== null) {
        if (Array.isArray(data)) {
            return data.map(item => sanitizeData(item))
        }

        const sanitized = {}
        for (const [key, value] of Object.entries(data)) {
            sanitized[sanitizeText(key)] = sanitizeData(value)
        }
        return sanitized
    }

    return data
}

// ====== Validation Middleware ======

/**
 * 中间件：验证请求体
 * 检查必填字段、数据类型、XSS、SQL注入
 */
export function validateRequestBody(requiredFields = []) {
    return (req, res, next) => {
        try {
            // 1. 检查是否有请求体
            if (!req.body || Object.keys(req.body).length === 0) {
                if (requiredFields.length > 0) {
                    return res.status(400).json({
                        error: '❌ 请求体不能为空',
                        required: requiredFields
                    })
                }
                return next()
            }

            // 2. 检查必填字段
            const missingFields = []
            for (const field of requiredFields) {
                if (!req.body[field]) {
                    missingFields.push(field)
                }
            }

            if (missingFields.length > 0) {
                return res.status(400).json({
                    error: '❌ 缺少必填字段',
                    missing: missingFields
                })
            }

            // 3. 检查SQL注入和XSS
            const validation = validateData(req.body, requiredFields)
            if (!validation.valid) {
                return res.status(400).json({
                    error: '❌ 数据验证失败',
                    issues: validation.issues
                })
            }

            // 4. 清理数据
            req.sanitizedBody = sanitizeData(req.body)

            next()
        } catch (error) {
            console.error('❌ 请求验证失败:', error)
            res.status(500).json({ error: '❌ 服务器验证错误' })
        }
    }
}

/**
 * 验证数据对象
 */
export function validateData(data, fieldsToCheck = []) {
    const issues = []
    const allowedFields = fieldsToCheck.length > 0 ? fieldsToCheck : Object.keys(data)

    for (const field of allowedFields) {
        const value = data[field]

        // 跳过空值（假设已通过必填检查）
        if (!value && typeof value !== 'number' && typeof value !== 'boolean') {
            continue
        }

        // 检查XSS
        if (typeof value === 'string') {
            if (detectXss(value)) {
                issues.push({
                    field,
                    type: 'XSS',
                    message: `字段"${field}"包含可能的XSS攻击代码`
                })
            }
        }

        // 检查SQL注入
        if (typeof value === 'string') {
            if (detectSqlInjection(value)) {
                issues.push({
                    field,
                    type: 'SQL_INJECTION',
                    message: `字段"${field}"包含可能的SQL注入代码`
                })
            }
        }
    }

    return {
        valid: issues.length === 0,
        issues
    }
}

/**
 * 检测XSS攻击
 * ⚠️ 单一事实源锚点：与前端 js/utils/FormValidator.js:86 (xss 规则) 同步维护，任一侧改动须同步另一侧（P2-8 收敛）。
 */
export function detectXss(value) {
    if (typeof value !== 'string') {
        return false
    }

    const xssPatterns = [
        /<script\b/gi,
        /javascript:/gi,
        /on\w+\s*=/gi,
        /<iframe/gi,
        /<embed/gi,
        /<object/gi,
        /eval\(/gi,
        /expression\(/gi
    ]

    for (const pattern of xssPatterns) {
        if (pattern.test(value)) {
            return true
        }
    }

    return false
}

// ====== Field Validators ======

export const fieldValidators = {
    email: (value) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        return emailRegex.test(value)
    },

    username: (value) => {
        const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/
        return usernameRegex.test(value)
    },

    password: (value) => {
        return value && value.length >= 6
    },

    phone: (value) => {
        const phoneRegex = /^1[3-9]\d{9}$/
        return phoneRegex.test(value.replace(/\s/g, ''))
    },

    url: (value) => {
        try {
            new URL(value)
            return true
        } catch {
            return false
        }
    },

    integer: (value) => {
        return /^-?\d+$/.test(String(value))
    },

    number: (value) => {
        return !isNaN(value) && value !== '' && value !== null
    },

    date: (value) => {
        const dateObj = new Date(value)
        return !isNaN(dateObj.getTime())
    },

    // P1-23: 与前端 FormValidator.dateNotFuture 对齐，确保后端校验为前端超集
    dateNotFuture: (value) => {
        const dateObj = new Date(value)
        if (isNaN(dateObj.getTime())) {
            return false
        }
        return dateObj <= new Date()
    },

    // P1-23: 与前端 FormValidator.idCard 对齐，确保后端校验为前端超集
    idCard: (value) => {
        const idCardRegex = /^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/
        return idCardRegex.test(value)
    }
}

/**
 * 中间件：验证特定字段格式
 */
export function validateField(fieldName, validationType) {
    return (req, res, next) => {
        const value = req.body[fieldName]

        if (!value) {
            return next() // 跳过空值
        }

        const validator = fieldValidators[validationType]
        if (!validator) {
            return res.status(500).json({
                error: `❌ 未知的验证类型: ${validationType}`
            })
        }

        if (!validator(value)) {
            return res.status(400).json({
                error: `❌ 字段"${fieldName}"格式无效 (期望: ${validationType})`
            })
        }

        next()
    }
}

/**
 * 中间件：限制请求体大小
 */
export function limitRequestSize(maxSizeMB = 10) {
    return (req, res, next) => {
        const maxBytes = maxSizeMB * 1024 * 1024

        let size = 0
        req.on('data', (chunk) => {
            size += chunk.length
            if (size > maxBytes) {
                req.connection.destroy()
                return res.status(413).json({
                    error: `❌ 请求体过大 (最大: ${maxSizeMB}MB)`
                })
            }
        })

        next()
    }
}

/**
 * 中间件：验证查询参数
 */
export function validateQueryParams(allowedParams = []) {
    return (req, res, next) => {
        const queryParams = req.query

        // 检查是否有非法参数
        for (const param of Object.keys(queryParams)) {
            if (!allowedParams.includes(param)) {
                console.warn(`⚠️ 非法查询参数: ${param}`)
                // 可选：拒绝非法参数
                // return res.status(400).json({ error: '❌ 非法查询参数' })
            }
        }

        // 清理查询参数
        req.cleanQuery = {}
        for (const param of allowedParams) {
            if (queryParams[param]) {
                req.cleanQuery[param] = sanitizeText(queryParams[param])
            }
        }

        next()
    }
}

/**
 * 中间件：速率限制（防止暴力攻击）
 */
export function rateLimit(maxRequests = 100, windowMs = 15 * 60 * 1000) {
    const requestMap = new Map()

    return (req, res, next) => {
        const key = req.ip || req.connection.remoteAddress
        const now = Date.now()

        // 移除超出时间窗口的请求（filter 返回新数组，必须在 push 后写回 requestMap，
        // 否则每次请求都从空数组重新计数，限流形同虚设）
        const validRequests = (requestMap.get(key) || []).filter(timestamp => now - timestamp < windowMs)

        if (validRequests.length >= maxRequests) {
            // 达到上限：写回当前窗口后拒绝
            requestMap.set(key, validRequests)
            return res.status(429).json({
                error: '❌ 请求过于频繁，请稍后再试'
            })
        }

        validRequests.push(now)
        requestMap.set(key, validRequests)
        next()
    }
}

// ====== Express Integration ======

/**
 * 创建完整的验证中间件堆栈
 */
export function createValidationMiddleware(config = {}) {
    const {
        maxRequestSize = 10,
        maxRequests = 100,
        requestWindowMs = 15 * 60 * 1000,
        requiredFields = [],
        allowedQueryParams = []
    } = config

    return [
        limitRequestSize(maxRequestSize),
        rateLimit(maxRequests, requestWindowMs),
        validateQueryParams(allowedQueryParams),
        validateRequestBody(requiredFields)
    ]
}

export default {
    escapeHtml,
    sanitizeHtml,
    sanitizeText,
    sanitizeData,
    detectSqlInjection,
    detectXss,
    validateRequestBody,
    validateData,
    validateField,
    limitRequestSize,
    validateQueryParams,
    rateLimit,
    createValidationMiddleware,
    fieldValidators
}
