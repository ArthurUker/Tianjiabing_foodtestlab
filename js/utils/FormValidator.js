/**
 * 通用表单验证工具
 * 提供预定义的验证规则和灵活的扩展机制
 * 
 * @example
 * const errors = FormValidator.validate(
 *     { name: '', email: 'invalid' },
 *     {
 *         name: ['required', { minLength: 3 }],
 *         email: ['required', 'email']
 *     }
 * )
 * if (errors) FormValidator.showErrors(form, errors)
 */
export class FormValidator {
    // 预定义验证规则库
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
        },
        
        url: (value) => {
            try {
                new URL(value)
                return null
            } catch {
                return 'URL 格式不正确'
            }
        },
        
        // P2-20: XSS 防护规则，与后端 validationMiddleware.detectXss 保持一致
        xss: (value) => {
            if (typeof value !== 'string') return null
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
            return xssPatterns.some(p => p.test(value))
                ? '输入包含不安全的内容'
                : null
        },
        
        // P2-20: SQL 注入防护规则，与后端 validationMiddleware.detectSqlInjection 保持一致
        sqlInjection: (value) => {
            if (typeof value !== 'string') return null
            const sqlPatterns = [
                /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION)\b)/gi,
                /UNION\s+SELECT/gi,
                /OR\s*1\s*=\s*1/gi,
                /'\s*OR\s*'1'='1/gi,
                /--\s*$/gi
            ]
            return sqlPatterns.some(p => p.test(value))
                ? '输入包含可疑的 SQL 代码'
                : null
        }
    }
    
    /**
     * 验证数据
     * @param {Object} data - 要验证的数据对象
     * @param {Object} schema - 验证规则对象，格式: { 字段名: [规则1, 规则2, ...] }
     * @returns {Object|null} 错误对象或 null（验证通过）
     * 
     * 规则格式:
     * - 字符串: 预定义规则名称，如 'required', 'email'
     * - 函数: 自定义验证函数
     * - 对象: 带参数的规则，如 { minLength: 3 }
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
                    if (!validator) {
                        console.warn(`⚠️ 未知验证规则: ${rule}`)
                        continue
                    }
                }
                // 处理函数规则
                else if (typeof rule === 'function') {
                    validator = rule
                }
                // 处理对象规则 (带参数)
                else if (typeof rule === 'object') {
                    const [ruleName, ...args] = Object.entries(rule)[0]
                    if (!this.rules[ruleName]) {
                        console.warn(`⚠️ 未知验证规则: ${ruleName}`)
                        continue
                    }
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
     * 显示表单错误提示
     * @param {HTMLFormElement} form - 表单元素
     * @param {Object} errors - 错误对象
     */
    static showErrors(form, errors) {
        // 清除所有现存错误提示
        form.querySelectorAll('.form-error-message').forEach(el => el.remove())
        form.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'))
        
        // 显示新错误
        for (const [field, message] of Object.entries(errors)) {
            const input = form.querySelector(`[name="${field}"]`)
            if (!input) continue
            
            // 添加错误样式
            input.classList.add('is-invalid', 'border-red-500')
            
            // 创建错误提示元素
            const errorEl = document.createElement('div')
            errorEl.className = 'form-error-message text-red-600 text-sm mt-1'
            errorEl.textContent = `❌ ${message}`
            
            // 插入到输入框下方
            if (input.parentElement) {
                input.parentElement.appendChild(errorEl)
            }
        }
    }
    
    /**
     * 清除表单错误提示
     * @param {HTMLFormElement} form - 表单元素
     */
    static clearErrors(form) {
        form.querySelectorAll('.form-error-message').forEach(el => el.remove())
        form.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid', 'border-red-500'))
    }
    
    /**
     * 添加自定义验证规则
     * @param {string} ruleName - 规则名称
     * @param {Function} validator - 验证函数
     */
    static addRule(ruleName, validator) {
        this.rules[ruleName] = validator
    }
    
    /**
     * 验证单个字段
     * @param {string} field - 字段名
     * @param {any} value - 字段值
     * @param {Array} rules - 规则数组
     * @returns {string|null} 第一个错误信息或 null
     */
    static validateField(field, value, rules) {
        const errors = this.validate({ [field]: value }, { [field]: rules })
        return errors ? errors[field] : null
    }
}
