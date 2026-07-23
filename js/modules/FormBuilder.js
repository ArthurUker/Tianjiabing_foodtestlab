/**
 * FormBuilder - 通用表单生成器
 * 根据配置动态生成表单，减少代码重复
 */

export class FormBuilder {
    constructor(formId, fields = {}, options = {}) {
        this.formId = formId
        this.fields = fields
        this.options = {
            layout: 'vertical', // vertical | horizontal | grid
            submitText: '提交',
            resetText: '重置',
            cssClass: '',
            ...options
        }
        this.validators = {}
        this.data = {}
    }

    // ====== Field Definition ======

    /**
     * 定义表单字段
     */
    defineField(name, config) {
        this.fields[name] = {
            type: 'text',
            label: name,
            required: false,
            placeholder: '',
            value: '',
            disabled: false,
            hidden: false,
            attributes: {},
            ...config
        }
        return this
    }

    /**
     * 定义多个字段
     */
    defineFields(fieldsConfig) {
        for (const [name, config] of Object.entries(fieldsConfig)) {
            this.defineField(name, config)
        }
        return this
    }

    /**
     * 应用学校个性化配置（SchoolCustomization）到已定义字段，实现按校差异化。
     * @param {Object} customization - 来自 /api/schools/:schoolCode/config 的 customization 对象
     *        （field_labels / hidden_fields / field_rules 为字符串 JSON 时自动解析）
     * 消费维度：
     *   - field_labels:  { 字段名: "中文标签" }                         → 覆盖 label
     *   - hidden_fields: [ "字段名", ... ]                             → 设为 hidden（不渲染）
     *   - field_rules:   { 字段名: { required, maxLength, minLength } } → 覆盖必填/校验
     * 用法：业务模块在 defineFields(...) 之后调用
     *       form.applySchoolCustomization(getSchoolCustomization(extractSchoolCode()))
     */
    applySchoolCustomization(customization) {
        if (!customization) return this
        const parse = (v) => {
            if (typeof v === 'string') {
                try { return JSON.parse(v) } catch { return null }
            }
            return v || null
        }
        const labels = parse(customization.field_labels)
        const hidden = parse(customization.hidden_fields) || []
        const rules = parse(customization.field_rules) || {}
        for (const [name, def] of Object.entries(this.fields)) {
            if (labels && labels[name]) def.label = labels[name]
            if (Array.isArray(hidden) && hidden.includes(name)) def.hidden = true
            const r = rules[name]
            if (r && r.required) def.required = true
            if (r && typeof r.maxLength === 'number') def.maxLength = r.maxLength
            if (r && typeof r.minLength === 'number') def.minLength = r.minLength
        }
        return this
    }

    /**
     * 添加验证规则
     */
    addValidator(fieldName, validator) {
        if (!this.validators[fieldName]) {
            this.validators[fieldName] = []
        }
        this.validators[fieldName].push(validator)
        return this
    }

    // ====== Form Generation ======

    /**
     * 生成表单HTML
     */
    render() {
        const form = document.createElement('form')
        form.id = this.formId
        form.className = `form form-${this.options.layout} ${this.options.cssClass}`

        // 生成表单字段
        for (const [fieldName, fieldConfig] of Object.entries(this.fields)) {
            if (fieldConfig.hidden) {
                continue
            }

            const fieldGroup = this.createFieldGroup(fieldName, fieldConfig)
            form.appendChild(fieldGroup)
        }

        // 添加操作按钮
        const buttonGroup = this.createButtonGroup()
        form.appendChild(buttonGroup)

        return form
    }

    /**
     * 创建单个字段组
     */
    createFieldGroup(fieldName, fieldConfig) {
        const group = document.createElement('div')
        group.className = 'form-group'
        group.setAttribute('data-field', fieldName)

        // 标签
        const label = document.createElement('label')
        label.htmlFor = fieldName
        label.textContent = fieldConfig.label
        if (fieldConfig.required) {
            label.innerHTML += ' <span class="required">*</span>'
        }
        group.appendChild(label)

        // 输入字段
        let input
        switch (fieldConfig.type) {
            case 'textarea':
                input = this.createTextarea(fieldName, fieldConfig)
                break
            case 'select':
                input = this.createSelect(fieldName, fieldConfig)
                break
            case 'radio':
                input = this.createRadio(fieldName, fieldConfig)
                break
            case 'checkbox':
                input = this.createCheckbox(fieldName, fieldConfig)
                break
            case 'date':
            case 'time':
            case 'datetime-local':
                input = this.createDateTimeInput(fieldName, fieldConfig)
                break
            case 'number':
            case 'email':
            case 'password':
            case 'tel':
            case 'url':
                input = this.createSpecialInput(fieldName, fieldConfig)
                break
            default:
                input = this.createTextInput(fieldName, fieldConfig)
        }

        group.appendChild(input)

        // 帮助文本和错误提示
        if (fieldConfig.help) {
            const help = document.createElement('small')
            help.className = 'form-help'
            help.textContent = fieldConfig.help
            group.appendChild(help)
        }

        const error = document.createElement('div')
        error.className = 'form-error'
        error.style.display = 'none'
        group.appendChild(error)

        return group
    }

    /**
     * 创建文本输入
     */
    createTextInput(fieldName, config) {
        const input = document.createElement('input')
        input.type = config.type || 'text'
        input.id = fieldName
        input.name = fieldName
        input.value = config.value
        input.placeholder = config.placeholder
        input.disabled = config.disabled
        input.required = config.required
        input.className = 'form-control'

        if (config.minLength) input.minLength = config.minLength
        if (config.maxLength) input.maxLength = config.maxLength
        if (config.pattern) input.pattern = config.pattern

        // 添加自定义属性
        for (const [attrName, attrValue] of Object.entries(config.attributes)) {
            input.setAttribute(attrName, attrValue)
        }

        return input
    }

    /**
     * 创建特殊输入字段（email, password等）
     */
    createSpecialInput(fieldName, config) {
        const input = document.createElement('input')
        input.type = config.type
        input.id = fieldName
        input.name = fieldName
        input.value = config.value
        input.placeholder = config.placeholder
        input.disabled = config.disabled
        input.required = config.required
        input.className = 'form-control'

        if (config.minLength) input.minLength = config.minLength
        if (config.maxLength) input.maxLength = config.maxLength

        return input
    }

    /**
     * 创建日期/时间输入
     */
    createDateTimeInput(fieldName, config) {
        const input = document.createElement('input')
        input.type = config.type
        input.id = fieldName
        input.name = fieldName
        input.value = config.value
        input.disabled = config.disabled
        input.required = config.required
        input.className = 'form-control'

        if (config.min) input.min = config.min
        if (config.max) input.max = config.max

        return input
    }

    /**
     * 创建文本区
     */
    createTextarea(fieldName, config) {
        const textarea = document.createElement('textarea')
        textarea.id = fieldName
        textarea.name = fieldName
        textarea.value = config.value
        textarea.placeholder = config.placeholder
        textarea.disabled = config.disabled
        textarea.required = config.required
        textarea.className = 'form-control'

        if (config.rows) textarea.rows = config.rows
        if (config.cols) textarea.cols = config.cols
        if (config.minLength) textarea.minLength = config.minLength
        if (config.maxLength) textarea.maxLength = config.maxLength

        return textarea
    }

    /**
     * 创建选择框
     */
    createSelect(fieldName, config) {
        const select = document.createElement('select')
        select.id = fieldName
        select.name = fieldName
        select.disabled = config.disabled
        select.required = config.required
        select.className = 'form-control'

        // 添加空选项
        if (!config.required) {
            const emptyOption = document.createElement('option')
            emptyOption.value = ''
            emptyOption.textContent = '-- 请选择 --'
            select.appendChild(emptyOption)
        }

        // 添加选项
        if (config.options) {
            for (const option of config.options) {
                const optElement = document.createElement('option')
                optElement.value = option.value
                optElement.textContent = option.label
                if (option.value === config.value) {
                    optElement.selected = true
                }
                select.appendChild(optElement)
            }
        }

        return select
    }

    /**
     * 创建单选框组
     */
    createRadio(fieldName, config) {
        const container = document.createElement('div')
        container.className = 'form-radio-group'

        if (config.options) {
            for (const option of config.options) {
                const label = document.createElement('label')
                label.className = 'form-check'

                const input = document.createElement('input')
                input.type = 'radio'
                input.name = fieldName
                input.value = option.value
                input.disabled = config.disabled
                if (option.value === config.value) {
                    input.checked = true
                }

                label.appendChild(input)
                label.appendChild(document.createTextNode(` ${option.label}`))
                container.appendChild(label)
            }
        }

        return container
    }

    /**
     * 创建复选框组
     */
    createCheckbox(fieldName, config) {
        const container = document.createElement('div')
        container.className = 'form-checkbox-group'

        if (config.options) {
            for (const option of config.options) {
                const label = document.createElement('label')
                label.className = 'form-check'

                const input = document.createElement('input')
                input.type = 'checkbox'
                input.name = fieldName
                input.value = option.value
                input.disabled = config.disabled

                label.appendChild(input)
                label.appendChild(document.createTextNode(` ${option.label}`))
                container.appendChild(label)
            }
        }

        return container
    }

    /**
     * 创建按钮组
     */
    createButtonGroup() {
        const group = document.createElement('div')
        group.className = 'form-button-group'

        const submitBtn = document.createElement('button')
        submitBtn.type = 'submit'
        submitBtn.className = 'btn btn-primary'
        submitBtn.textContent = this.options.submitText
        group.appendChild(submitBtn)

        const resetBtn = document.createElement('button')
        resetBtn.type = 'reset'
        resetBtn.className = 'btn btn-secondary'
        resetBtn.textContent = this.options.resetText
        group.appendChild(resetBtn)

        return group
    }

    // ====== Form Interaction ======

    /**
     * 获取表单数据
     */
    getFormData() {
        const form = document.getElementById(this.formId)
        if (!form) {
            console.error(`❌ 找不到表单: ${this.formId}`)
            return {}
        }

        const formData = new FormData(form)
        const data = {}

        for (const [key, value] of formData.entries()) {
            data[key] = value
        }

        return data
    }

    /**
     * 设置表单数据
     */
    setFormData(data) {
        const form = document.getElementById(this.formId)
        if (!form) {
            console.error(`❌ 找不到表单: ${this.formId}`)
            return this
        }

        for (const [fieldName, value] of Object.entries(data)) {
            const field = form.elements[fieldName]
            if (field) {
                if (field.type === 'checkbox') {
                    field.checked = value === true || value === 'on'
                } else if (field.type === 'radio') {
                    const radioField = form.querySelector(`input[name="${fieldName}"][value="${value}"]`)
                    if (radioField) {
                        radioField.checked = true
                    }
                } else {
                    field.value = value
                }
            }
        }

        return this
    }

    /**
     * 验证表单
     */
    validateForm() {
        const form = document.getElementById(this.formId)
        if (!form) {
            console.error(`❌ 找不到表单: ${this.formId}`)
            return false
        }

        let isValid = true
        const errors = {}

        // HTML5 自动验证
        if (!form.checkValidity()) {
            isValid = false
        }

        // 自定义验证规则
        for (const [fieldName, validators] of Object.entries(this.validators)) {
            const field = form.elements[fieldName]
            if (!field) continue

            const value = field.value
            const fieldErrors = []

            for (const validator of validators) {
                const result = validator(value)
                if (result !== true) {
                    isValid = false
                    fieldErrors.push(result)
                }
            }

            if (fieldErrors.length > 0) {
                errors[fieldName] = fieldErrors
            }
        }

        // 显示错误消息
        this.showErrors(errors)

        return isValid
    }

    /**
     * 显示错误消息
     */
    showErrors(errors) {
        const form = document.getElementById(this.formId)
        if (!form) return

        // 清空所有错误
        form.querySelectorAll('.form-error').forEach(el => {
            el.style.display = 'none'
            el.innerHTML = ''
        })

        // 显示新错误
        for (const [fieldName, messages] of Object.entries(errors)) {
            const group = form.querySelector(`[data-field="${fieldName}"]`)
            if (group) {
                const errorEl = group.querySelector('.form-error')
                if (errorEl) {
                    errorEl.innerHTML = messages.join('<br>')
                    errorEl.style.display = 'block'
                }
            }
        }
    }

    /**
     * 清空表单
     */
    clearForm() {
        const form = document.getElementById(this.formId)
        if (form) {
            form.reset()
            this.showErrors({})
        }
        return this
    }

    /**
     * 禁用表单
     */
    disableForm(disabled = true) {
        const form = document.getElementById(this.formId)
        if (form) {
            form.querySelectorAll('input, textarea, select, button').forEach(el => {
                if (!el.classList.contains('no-disable')) {
                    el.disabled = disabled
                }
            })
        }
        return this
    }

    /**
     * 绑定提交事件
     */
    onSubmit(callback) {
        const form = document.getElementById(this.formId)
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault()
                if (this.validateForm()) {
                    callback(this.getFormData())
                }
            })
        }
        return this
    }
}

export default FormBuilder
