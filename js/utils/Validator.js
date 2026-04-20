/**
 * Validator - 统一的输入验证器
 * 提供表单验证、XSS防护、SQL注入防护等功能
 */

export class Validator {
    constructor() {
        this.errors = {}
        this.warnings = []
    }

    // ====== Clear Errors ======

    clearErrors() {
        this.errors = {}
        this.warnings = []
    }

    addError(field, message) {
        if (!this.errors[field]) {
            this.errors[field] = []
        }
        this.errors[field].push(message)
    }

    addWarning(message) {
        this.warnings.push(message)
    }

    hasErrors() {
        return Object.keys(this.errors).length > 0
    }

    getErrors() {
        return this.errors
    }

    // ====== Common Validators ======

    validateRequired(value, fieldName) {
        if (!value || (typeof value === 'string' && value.trim() === '')) {
            this.addError(fieldName, `${fieldName}是必填项`)
            return false
        }
        return true
    }

    validateMinLength(value, min, fieldName) {
        if (!value) return true
        if (value.length < min) {
            this.addError(fieldName, `${fieldName}至少需要${min}个字符`)
            return false
        }
        return true
    }

    validateMaxLength(value, max, fieldName) {
        if (!value) return true
        if (value.length > max) {
            this.addError(fieldName, `${fieldName}不能超过${max}个字符`)
            return false
        }
        return true
    }

    validateEmail(email, fieldName = '邮箱') {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        if (!emailRegex.test(email)) {
            this.addError(fieldName, `${fieldName}格式无效`)
            return false
        }
        return true
    }

    validateUsername(username, fieldName = '用户名') {
        // 用户名只能包含字母、数字、下划线
        const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/
        if (!usernameRegex.test(username)) {
            this.addError(fieldName, `${fieldName}只能包含字母、数字和下划线，长度3-50个字符`)
            return false
        }
        return true
    }

    validatePassword(password, fieldName = '密码') {
        if (password.length < 6) {
            this.addError(fieldName, `${fieldName}至少需要6个字符`)
            return false
        }

        // 强密码检查（建议但非必需）
        if (!this.isStrongPassword(password)) {
            this.addWarning(`${fieldName}较弱：建议包含大小写字母和数字`)
        }

        return true
    }

    isStrongPassword(password) {
        const hasUpperCase = /[A-Z]/.test(password)
        const hasLowerCase = /[a-z]/.test(password)
        const hasNumbers = /\d/.test(password)
        const hasSpecialChar = /[!@#$%^&*]/.test(password)

        return (hasUpperCase || hasLowerCase) && hasNumbers
    }

    validatePhoneNumber(phone, fieldName = '电话号码') {
        const phoneRegex = /^1[3-9]\d{9}$/
        if (!phoneRegex.test(phone.replace(/\s/g, ''))) {
            this.addError(fieldName, `${fieldName}格式无效`)
            return false
        }
        return true
    }

    validateDate(date, fieldName = '日期') {
        try {
            const dateObj = new Date(date)
            if (isNaN(dateObj.getTime())) {
                this.addError(fieldName, `${fieldName}格式无效`)
                return false
            }
            return true
        } catch {
            this.addError(fieldName, `${fieldName}格式无效`)
            return false
        }
    }

    validateNumber(value, fieldName = '数字') {
        if (isNaN(value) || value === '' || value === null) {
            this.addError(fieldName, `${fieldName}必须是有效的数字`)
            return false
        }
        return true
    }

    validateRange(value, min, max, fieldName = '数值') {
        const num = parseFloat(value)
        if (num < min || num > max) {
            this.addError(fieldName, `${fieldName}必须在${min}到${max}之间`)
            return false
        }
        return true
    }

    // ====== XSS Prevention ======

    /**
     * 转义HTML特殊字符，防止XSS攻击
     */
    escapeHtml(text) {
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

    /**
     * 移除危险的HTML标签
     */
    sanitizeHtml(text) {
        if (typeof text !== 'string') {
            return text
        }

        // 移除script、style等危险标签
        let sanitized = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        sanitized = sanitized.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
        sanitized = sanitized.replace(/on\w+\s*=\s*[^\s>]*/gi, '')

        return sanitized
    }

    /**
     * 验证并清理文本（移除XSS威胁）
     */
    sanitizeText(text, fieldName = '') {
        if (typeof text !== 'string') {
            return text
        }

        // 移除危险内容
        let sanitized = this.sanitizeHtml(text)
        // 转义HTML
        sanitized = this.escapeHtml(sanitized)

        return sanitized
    }

    // ====== SQL Injection Prevention ======

    /**
     * 检测可能的SQL注入攻击
     */
    detectSqlInjection(value) {
        if (typeof value !== 'string') {
            return false
        }

        // 常见的SQL注入模式
        const sqlInjectionPatterns = [
            /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|FROM|WHERE)\b)/gi,
            /(-{2}|\/\*|\*\/|;|'|")/g,
            /(OR|AND)\s*(\d+|'[^']*')s*=/gi,
            /UNION\s+SELECT/gi,
            /OR\s*1\s*=\s*1/gi,
            /'\s*OR\s*'1'='1/gi
        ]

        for (const pattern of sqlInjectionPatterns) {
            if (pattern.test(value)) {
                return true
            }
        }

        return false
    }

    validateSafeSql(value, fieldName = '') {
        if (this.detectSqlInjection(value)) {
            this.addError(fieldName || 'input', `输入包含非法字符或SQL关键字`)
            return false
        }
        return true
    }

    // ====== Data Type Validators ======

    validateString(value, minLength = 1, maxLength = 255, fieldName = '字符串') {
        this.validateRequired(value, fieldName)
        this.validateMinLength(value, minLength, fieldName)
        this.validateMaxLength(value, maxLength, fieldName)
        return !this.hasErrors()
    }

    validateInteger(value, fieldName = '整数') {
        const intRegex = /^-?\d+$/
        if (!intRegex.test(String(value))) {
            this.addError(fieldName, `${fieldName}必须是整数`)
            return false
        }
        return true
    }

    validateFloat(value, fieldName = '浮点数') {
        if (isNaN(value) || value === '') {
            this.addError(fieldName, `${fieldName}必须是有效的数字`)
            return false
        }
        return true
    }

    validateUrl(url, fieldName = 'URL') {
        try {
            new URL(url)
            return true
        } catch {
            this.addError(fieldName, `${fieldName}格式无效`)
            return false
        }
    }

    // ====== Array Validators ======

    validateArray(value, minItems = 0, maxItems = Infinity, fieldName = '数组') {
        if (!Array.isArray(value)) {
            this.addError(fieldName, `${fieldName}必须是数组`)
            return false
        }

        if (value.length < minItems) {
            this.addError(fieldName, `${fieldName}至少需要${minItems}项`)
            return false
        }

        if (value.length > maxItems) {
            this.addError(fieldName, `${fieldName}不能超过${maxItems}项`)
            return false
        }

        return true
    }

    // ====== Object Validators ======

    validateObject(value, fieldName = '对象') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            this.addError(fieldName, `${fieldName}必须是对象`)
            return false
        }
        return true
    }

    validateRequiredFields(obj, requiredFields, fieldName = '表单') {
        for (const field of requiredFields) {
            if (!obj[field] || (typeof obj[field] === 'string' && obj[field].trim() === '')) {
                this.addError(field, `${field}是必填项`)
            }
        }

        if (this.hasErrors()) {
            return false
        }

        return true
    }

    // ====== Data Sanitization ======

    /**
     * 清理用户输入数据
     */
    sanitizeData(data) {
        if (typeof data === 'string') {
            return this.sanitizeText(data)
        }

        if (typeof data === 'object' && data !== null) {
            if (Array.isArray(data)) {
                return data.map(item => this.sanitizeData(item))
            }

            const sanitized = {}
            for (const [key, value] of Object.entries(data)) {
                sanitized[this.sanitizeText(key)] = this.sanitizeData(value)
            }
            return sanitized
        }

        return data
    }

    // ====== Batch Validation ======

    /**
     * 验证整个表单对象
     */
    validateForm(formData, validationRules) {
        this.clearErrors()

        for (const [field, rules] of Object.entries(validationRules)) {
            const value = formData[field]

            for (const rule of rules) {
                if (!this.executeRule(value, rule, field)) {
                    break // 遇到第一个错误就停止该字段的验证
                }
            }
        }

        return !this.hasErrors()
    }

    executeRule(value, rule, fieldName) {
        const { type, required, minLength, maxLength, pattern, custom, message } = rule

        if (required && !value) {
            this.addError(fieldName, message || `${fieldName}是必填项`)
            return false
        }

        if (!value) {
            return true // 非必填且为空，通过验证
        }

        switch (type) {
            case 'email':
                return this.validateEmail(value, fieldName)

            case 'username':
                return this.validateUsername(value, fieldName)

            case 'password':
                return this.validatePassword(value, fieldName)

            case 'string':
                if (minLength && !this.validateMinLength(value, minLength, fieldName)) return false
                if (maxLength && !this.validateMaxLength(value, maxLength, fieldName)) return false
                return true

            case 'number':
                return this.validateNumber(value, fieldName)

            case 'integer':
                return this.validateInteger(value, fieldName)

            case 'url':
                return this.validateUrl(value, fieldName)

            case 'date':
                return this.validateDate(value, fieldName)

            case 'phone':
                return this.validatePhoneNumber(value, fieldName)

            default:
                if (pattern && !pattern.test(String(value))) {
                    this.addError(fieldName, message || `${fieldName}格式无效`)
                    return false
                }

                if (custom && typeof custom === 'function') {
                    const customResult = custom(value)
                    if (customResult !== true) {
                        this.addError(fieldName, customResult || `${fieldName}验证失败`)
                        return false
                    }
                }

                return true
        }
    }

    // ====== Error Display ======

    getErrorMessage() {
        const messages = []

        for (const [field, errors] of Object.entries(this.errors)) {
            messages.push(`${field}: ${errors.join('; ')}`)
        }

        return messages.join('\n')
    }

    getErrorHtml() {
        if (!this.hasErrors()) {
            return ''
        }

        let html = '<div class="validation-errors">'

        for (const [field, errors] of Object.entries(this.errors)) {
            html += `<div class="error-item">`
            html += `<strong>${field}:</strong> `
            html += errors.join('; ')
            html += `</div>`
        }

        html += '</div>'

        return html
    }
}

// ====== Singleton Instance ======
export const validator = new Validator()

// ====== Usage Example ======

/*

import { Validator } from './Validator.js'

const validator = new Validator()

// 验证表单
const formData = {
    username: 'admin',
    email: 'admin@example.com',
    password: 'Password123!',
    age: 30
}

const rules = {
    username: [
        { type: 'string', required: true, minLength: 3, maxLength: 50 }
    ],
    email: [
        { type: 'email', required: true }
    ],
    password: [
        { type: 'password', required: true }
    ],
    age: [
        { type: 'integer', required: true }
    ]
}

if (validator.validateForm(formData, rules)) {
    console.log('✅ 表单验证成功')
} else {
    console.error('❌ 验证失败:', validator.getErrors())
}

// 清理数据
const cleanData = validator.sanitizeData(formData)

// XSS防护
const userInput = '<script>alert("XSS")</script>'
const safe = validator.escapeHtml(userInput)

// SQL注入检测
const sqlInput = "'; DROP TABLE users; --"
if (validator.detectSqlInjection(sqlInput)) {
    console.log('❌ 检测到SQL注入企图')
}

*/
