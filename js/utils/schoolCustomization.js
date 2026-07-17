/**
 * schoolCustomization.js
 * 跨页面存取当前学校的个性化配置（SchoolCustomization），并把它合并到表单字段定义。
 * 数据来源：登录页 / 主应用调用 GET /api/schools/:schoolCode/config 后写入 localStorage。
 *
 * 该模块让"统一代码 + 按校个性化"落地：学校名、界面主题、字段标签/显隐/必填规则
 * 全部来自 public 系统表，业务代码不出现任何学校专有命名。
 */

const KEY_PREFIX = 'school_customization_'

// 写入当前校 customization（由登录页或主应用调用）
export function setSchoolCustomization(schoolCode, customization) {
    if (!schoolCode) return
    try {
        localStorage.setItem(KEY_PREFIX + schoolCode, JSON.stringify(customization || {}))
    } catch (e) { /* 存储不可用时忽略 */ }
}

// 读取当前校 customization（供业务模块消费）
export function getSchoolCustomization(schoolCode) {
    if (!schoolCode) return {}
    try {
        return JSON.parse(localStorage.getItem(KEY_PREFIX + schoolCode) || '{}') || {}
    } catch (e) {
        return {}
    }
}

// 把 customization 应用到字段定义对象（{ [字段名]: { label, required, hidden, ... } }）
export function applyCustomizationToFields(fields, customization = {}) {
    const parse = (v) => {
        if (typeof v === 'string') {
            try { return JSON.parse(v) } catch { return null }
        }
        return v || null
    }
    const labels = parse(customization.field_labels)
    const hidden = parse(customization.hidden_fields) || []
    const rules = parse(customization.field_rules) || {}
    for (const [name, def] of Object.entries(fields)) {
        if (labels && labels[name]) def.label = labels[name]
        if (Array.isArray(hidden) && hidden.includes(name)) def.hidden = true
        const r = rules[name]
        if (r && r.required) def.required = true
        if (r && typeof r.maxLength === 'number') def.maxLength = r.maxLength
        if (r && typeof r.minLength === 'number') def.minLength = r.minLength
    }
    return fields
}

// 解析 customization 里的字符串 JSON 字段（DB 里存的是 text）
function parseJSONField(v) {
    if (v == null) return null
    if (typeof v === 'string') {
        try { return JSON.parse(v) } catch { return null }
    }
    return v
}

/**
 * 找到字段对应的"单元格"容器（用于整体隐藏）。
 * - pesticide/oil/leanMeat：字段外面包了一层 <div> 且含 <label> → 返回该 div。
 * - tableware：字段是 .grid 的直接子元素（无包裹 div）→ 仅返回字段本身。
 */
function findFieldCell(field) {
    const parent = field.parentElement
    if (parent && parent.classList && parent.classList.contains('grid')) return field
    let el = parent
    while (el && el.tagName === 'DIV') {
        if (el.querySelector(':scope > label')) return el
        if (el.parentElement && el.parentElement.classList.contains('grid')) return el
        el = el.parentElement
    }
    return field
}

function relabel(label, text, required) {
    if (!label) return
    label.textContent = text
    const marker = document.createElement('span')
    marker.className = 'text-red-500'
    marker.textContent = ' *'
    if (required) label.appendChild(marker)
}

/**
 * 把学校个性化配置应用到「静态 DOM 表单」（业务模块用 index.html 内联表单，非 FormBuilder）。
 * 消费维度：
 *   - field_labels:  { 字段名: "中文标签" }        → 更新 <label> 文本（保留/补 required 星标）
 *   - hidden_fields: [ "字段名", ... ]             → 隐藏整个单元格
 *   - field_rules:   { 字段名: { required, maxLength, minLength } } → 改必填属性 + 长度校验
 * @param {HTMLFormElement} formEl
 * @param {Object} customization
 */
export function applySchoolCustomizationToForm(formEl, customization) {
    if (!formEl || !customization) return
    const labels = parseJSONField(customization.field_labels) || {}
    const hidden = parseJSONField(customization.hidden_fields) || []
    const rules = parseJSONField(customization.field_rules) || {}

    const fields = formEl.querySelectorAll('input, select, textarea')
    fields.forEach((field) => {
        const name = field.name
        if (!name) return

        // 1) 隐藏字段（优先级最高，隐藏后不再应用其它规则）
        if (Array.isArray(hidden) && hidden.includes(name)) {
            const cell = findFieldCell(field)
            cell.style.display = 'none'
            return
        }

        // 2) 标签覆盖
        const cell = findFieldCell(field)
        const label = cell.querySelector && cell.querySelector('label')
        const rule = rules[name] || {}
        if (labels[name] && label) {
            relabel(label, labels[name], !!rule.required || field.hasAttribute('required'))
        }

        // 3) 字段规则（必填 / 长度）
        if (rule.required === true) {
            field.setAttribute('required', '')
            if (label) {
                const m = label.querySelector('span.text-red-500')
                if (!m) {
                    const star = document.createElement('span')
                    star.className = 'text-red-500'
                    star.textContent = ' *'
                    label.appendChild(star)
                }
            }
        } else if (rule.required === false) {
            field.removeAttribute('required')
            if (label) {
                const m = label.querySelector('span.text-red-500')
                if (m) m.remove()
            }
        }
        if (typeof rule.maxLength === 'number') field.setAttribute('maxlength', String(rule.maxLength))
        if (typeof rule.minLength === 'number') field.setAttribute('minlength', String(rule.minLength))
    })
}

// 已知静态录入表单 id（存在才应用）
const TEST_FORM_IDS = ['tablewareTestForm', 'pesticideTestForm', 'oilTestForm', 'leanMeatTestForm', 'pathogenTestForm']

export function applyCustomizationToAllForms(customization) {
    if (!customization) return
    TEST_FORM_IDS.forEach((id) => {
        const form = document.getElementById(id)
        if (form) applySchoolCustomizationToForm(form, customization)
    })
}

/**
 * 兜底：若 localStorage 无该校 customization（用户直接打开 index.html，未经 login.html 写入缓存），
 * 则调用公开端点拉取并缓存，保证按校差异化始终生效。
 * @param {string} schoolCode
 * @returns {Promise<Object>} customization（可能为 {}）
 */
export async function ensureSchoolConfig(schoolCode) {
    if (!schoolCode) return {}
    const cached = getSchoolCustomization(schoolCode)
    if (cached && Object.keys(cached).length) return cached
    try {
        const resp = await fetch(`/api/schools/${encodeURIComponent(schoolCode)}/config`)
        if (!resp.ok) return {}
        const json = await resp.json()
        const customization = (json && json.data && json.data.customization) || {}
        setSchoolCustomization(schoolCode, customization)
        return customization
    } catch (e) {
        console.warn('⚠️ 拉取学校个性化配置失败:', e)
        return {}
    }
}

export default {
    setSchoolCustomization,
    getSchoolCustomization,
    applyCustomizationToFields,
    applySchoolCustomizationToForm,
    applyCustomizationToAllForms,
    ensureSchoolConfig,
}
