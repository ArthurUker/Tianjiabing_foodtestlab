/**
 * schoolCustomization/fields.js（RK51 拆分）
 * 字段维度的定制应用：标签/显隐/必填规则、下拉选项覆盖、字段顺序重排、
 * 层级A 自定义字段的注入（inject）/收集（collect）/合格判定（qualify，RK21）。
 */

import { extractSchoolCode } from '../schoolCode.js'
import { getSchoolCustomization } from './cache.js'
import { parseJSONField, escapeHtml, FORM_MODULE_MAP, TEST_FORM_IDS, parseTopOrThemeObject } from './shared.js'

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

/**
 * 读取下拉选项覆盖（field_options）。SchoolCustomization 可能以两种形态携带：
 *   - 顶层字段 field_options: { 字段名: [选项...] }
 *   - 嵌套在 theme_config.field_options（与 admin 控制台保存结构一致）
 * 两者都支持，优先取非空者。
 * @param {Object} customization
 * @returns {Object} { 字段名: [选项...] }
 */
function parseFieldOptions(customization) {
    return parseTopOrThemeObject(customization, 'field_options')
}

/**
 * 读取字段顺序覆盖（field_order）。兼容顶层字段与 theme_config.field_order 两种形态。
 * @param {Object} customization
 * @returns {Object} { moduleCode: [字段名, ...] }
 */
function parseFieldOrder(customization) {
    return parseTopOrThemeObject(customization, 'field_order')
}

/**
 * 判断一个父容器是否可安全重排：至少 2 个子元素，且每个子元素恰好含 1 个具名字段。
 * 这样能重排 pesticide/oil 的 <div> 单元格与 tableware 的直接 input，
 * 又能跳过含说明文字/按钮等异构子元素的容器（如 ATP 点位），避免破坏布局。
 */
function isReorderableParent(parent) {
    const kids = Array.from(parent.children)
    if (kids.length < 2) return false
    return kids.every(k => {
        const named = k.matches('input[name],select[name],textarea[name]')
            ? [k]
            : Array.from(k.querySelectorAll('input[name],select[name],textarea[name]'))
        return named.length === 1
    })
}

/**
 * 按 field_order 在各自父网格内稳定重排表单单元格（不跨网格移动）。
 * @param {HTMLFormElement} formEl
 * @param {string[]} orderedNames
 */
function reorderFormCells(formEl, orderedNames) {
    if (!formEl || !Array.isArray(orderedNames) || !orderedNames.length) return
    const pos = new Map(orderedNames.map((n, i) => [n, i]))
    const parents = new Set()
    formEl.querySelectorAll('input[name],select[name],textarea[name]').forEach(f => {
        const cell = findFieldCell(f)
        if (cell && cell.parentElement) parents.add(cell.parentElement)
    })
    parents.forEach(parent => {
        if (!isReorderableParent(parent)) return
        const keyed = Array.from(parent.children).map((k, i) => {
            const f = k.matches('input[name],select[name],textarea[name]') ? k : k.querySelector('input[name],select[name],textarea[name]')
            const name = f ? f.name : null
            const p = (name != null && pos.has(name)) ? pos.get(name) : Infinity
            return { k, p, i }
        })
        keyed.sort((a, b) => (a.p !== b.p ? a.p - b.p : a.i - b.i))
        keyed.forEach(x => parent.appendChild(x.k))
    })
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
 * 把学校个性化配置应用到「静态 DOM 表单」（业务模块用 index.html 内联表单）。
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
    // 🆕 下拉选项覆盖（图形化编辑保存的选项列表）
    const fieldOptions = parseFieldOptions(customization)
    const fieldTypes = parseTopOrThemeObject(customization, 'field_types') || {}

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

        // 4) 下拉选项覆盖（select 专用）：用校定制的选项列表替换默认项，尽量保留当前选中值
        // 支持 chips object 格式 [{value, subOptions?}]：取 .value 作为 option value/text
        // CR-03/BS-05: 当前值不在新选项中时，追加一个 disabled 的"历史值"option，
        // 避免用户已选值/历史记录值被静默丢弃
        // FIX-11: 用 hasOwnProperty 区分「未配置」与「显式清空（[]）」。空数组也应覆盖默认项，
        // 否则删光选项后录入端仍回退硬编码默认列表 → "删不掉"。
        if (field.tagName === 'SELECT' && Object.prototype.hasOwnProperty.call(fieldOptions, name) && Array.isArray(fieldOptions[name])) {
            const opts = fieldOptions[name]
            const current = field.value
            const optValues = opts.map(o => (typeof o === 'string' ? o : (o && o.value != null ? String(o.value) : ''))).filter(Boolean)
            if (optValues.length) {
                field.innerHTML = optValues.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')
                if (optValues.includes(current)) {
                    field.value = current
                } else if (current) {
                    const legacy = document.createElement('option')
                    legacy.value = current
                    legacy.textContent = `${current}（历史值）`
                    legacy.disabled = true
                    field.appendChild(legacy)
                    field.value = current
                }
            } else {
                field.innerHTML = '<option value="">请选择</option>'
                field.value = ''
            }
        }
    })

    // 4.5) 字段类型转换（field_types）：将内置字段按校定制类型重建 DOM 元素
    //      仅当 fieldTypes[name] 与当前元素实际类型不同时才执行重建
    Object.entries(fieldTypes).forEach(([name, targetType]) => {
        if (!targetType || targetType === 'text') return // text 为默认，跳过
        const el = formEl.querySelector(`[name="${name}"]`)
        if (!el) return
        const currentTag = el.tagName.toLowerCase()
        const currentType = el.type || 'text'
        // 判断是否需要转换
        const needsRecreate = (
            (targetType === 'select' && currentTag !== 'select') ||
            (targetType === 'textarea' && currentTag !== 'textarea') ||
            (targetType === 'checkbox' && currentType !== 'checkbox') ||
            ((targetType === 'number' || targetType === 'date') && currentType !== targetType && currentTag !== 'select')
        )
        if (!needsRecreate) return

        const cell = findFieldCell(el)
        const value = el.value
        const classes = el.className
        const required = el.hasAttribute('required')
        const placeholder = el.getAttribute('placeholder') || ''
        const nameAttr = el.getAttribute('name')

        let replacement
        if (targetType === 'select') {
            replacement = document.createElement('select')
            replacement.className = classes
            replacement.name = nameAttr
            if (required) replacement.setAttribute('required', '')
            const opts = (fieldOptions && fieldOptions[name]) || []
            // preserve current value if not in options
            if (value && !opts.includes(value)) {
                opts.unshift(value)
            }
            opts.forEach(o => {
                const opt = document.createElement('option')
                opt.value = String(o)
                opt.textContent = String(o)
                replacement.appendChild(opt)
            })
            if (value) replacement.value = value
        } else if (targetType === 'textarea') {
            replacement = document.createElement('textarea')
            replacement.className = classes
            replacement.name = nameAttr
            replacement.rows = 2
            if (required) replacement.setAttribute('required', '')
            if (placeholder) replacement.setAttribute('placeholder', placeholder)
            replacement.textContent = value
        } else if (targetType === 'checkbox') {
            replacement = document.createElement('input')
            replacement.type = 'checkbox'
            replacement.className = 'h-4 w-4 mt-2'
            replacement.name = nameAttr
            if (value === 'true' || value === 'on') replacement.checked = true
        } else {
            // number / date
            replacement = document.createElement('input')
            replacement.type = targetType
            replacement.className = classes
            replacement.name = nameAttr
            if (required) replacement.setAttribute('required', '')
            if (placeholder) replacement.setAttribute('placeholder', placeholder)
            replacement.value = value
        }
        replacement.setAttribute('data-custom-field-type', targetType)
        if (el.id) replacement.id = el.id
        if (cell) {
            el.replaceWith(replacement)
        }
    })

    // 5) 层级A：注入学校自定义字段（在重排前注入，使其也能参与 field_order）
    injectCustomFields(formEl, customization)

    // 6) 字段顺序（拖拽排序）：在各自网格内安全重排
    const moduleCode = FORM_MODULE_MAP[formEl.id]
    const order = moduleCode ? parseFieldOrder(customization)[moduleCode] : null
    if (Array.isArray(order) && order.length) reorderFormCells(formEl, order)
}

/**
 * 层级A：解析某模块的自定义字段定义列表。
 * custom_fields 形态：{ 模块code: [{name,label,type,options,required,statRole,qualifiedValues}] }
 */
export function resolveCustomFields(customization, moduleCode) {
    if (!customization || !moduleCode) return []
    // 顶层 custom_fields 列优先；回退 theme_config.custom_fields 嵌套（兼容旧数据）
    let parsed = parseJSONField(customization.custom_fields)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        const theme = parseJSONField(customization.theme_config)
        parsed = theme && typeof theme === 'object' ? theme.custom_fields : null
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return []
    const list = parsed[moduleCode]
    return Array.isArray(list) ? list : []
}

const CUSTOM_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/

/**
 * RK21：自定义字段合格判定。
 * 规则：模块下 statRole==='result' 且配置了 qualifiedValues 的自定义字段参与合格率统计——
 *   - 记录中该字段有值且值不在 qualifiedValues 内 → 记录判为不合格（返回 false）
 *   - 该字段缺失/为空（如配置生效前的历史记录，BS-05 回填保护）→ 跳过该字段，不影响判定
 *   - 无参与统计的自定义字段 / 无 schoolCode / 解析异常 → 返回 true（不改变原有判定）
 * 调用方将本函数结果与模块原有合格判定做 AND。
 */
export function isRecordQualifiedByCustomFields(moduleCode, record) {
    try {
        const code = extractSchoolCode()
        if (!code || !record) return true
        const customization = getSchoolCustomization(code)
        const defs = resolveCustomFields(customization, moduleCode)
        const judges = defs.filter(d =>
            d && d.statRole === 'result' && Array.isArray(d.qualifiedValues) && d.qualifiedValues.length
        )
        if (!judges.length) return true
        return judges.every(d => {
            const v = record[d.name]
            if (v === undefined || v === null || v === '') return true // 历史记录缺失该字段：不参与判定
            return d.qualifiedValues.map(String).includes(String(v))
        })
    } catch (e) {
        return true
    }
}

/**
 * 层级A：把学校自定义字段注入录入表单（整单级，插入表单第一个 .grid 基础信息区，
 * 该区不会被 GenericTest.updateFormStructure 提升为可复制点位容器）。
 * 每个输入带 data-custom-field="<name>"，提交收集统一据此读取。
 * 幂等：已注入的字段不重复注入。
 */
export function injectCustomFields(formEl, customization) {
    if (!formEl) return
    const moduleCode = FORM_MODULE_MAP[formEl.id]
    if (!moduleCode) return
    const defs = resolveCustomFields(customization, moduleCode)
    if (!defs.length) return
    const grid = formEl.querySelector('.grid')
    if (!grid) return

    // 必填可来自字段定义本身或 field_rules（管理端两处均可配置）
    const rulesMap = parseJSONField(customization.field_rules) || {}

    defs.forEach((def) => {
        if (!def || typeof def.name !== 'string' || !CUSTOM_FIELD_NAME_RE.test(def.name)) return
        if (formEl.querySelector(`[data-custom-field-wrap="${def.name}"]`)) return // 幂等
        const isRequired = !!(def.required || (rulesMap[def.name] && rulesMap[def.name].required))

        const wrap = document.createElement('div')
        wrap.setAttribute('data-custom-field-wrap', def.name)

        const label = document.createElement('label')
        label.className = 'block text-sm font-medium text-gray-700 mb-1'
        label.textContent = def.label || def.name
        if (isRequired) {
            const star = document.createElement('span')
            star.className = 'text-red-500'
            star.textContent = ' *'
            label.appendChild(star)
        }
        wrap.appendChild(label)

        let input
        const type = def.type || 'text'
        if (type === 'select') {
            input = document.createElement('select')
            input.className = 'w-full border border-gray-300 p-2 rounded-md shadow-sm'
            if (!isRequired) {
                const ph = document.createElement('option')
                ph.value = ''
                ph.textContent = '请选择'
                input.appendChild(ph)
            }
            const opts = Array.isArray(def.options) ? def.options : []
            opts.forEach((o) => {
                const op = document.createElement('option')
                op.value = String(o)
                op.textContent = String(o)
                input.appendChild(op)
            })
        } else if (type === 'textarea') {
            input = document.createElement('textarea')
            input.className = 'w-full border border-gray-300 p-2 rounded-md shadow-sm'
            input.rows = 2
        } else if (type === 'checkbox') {
            input = document.createElement('input')
            input.type = 'checkbox'
            input.className = 'h-4 w-4 mt-2'
        } else {
            input = document.createElement('input')
            input.type = (type === 'number' || type === 'date') ? type : 'text'
            input.className = 'w-full border border-gray-300 p-2 rounded-md shadow-sm'
        }
        input.name = def.name
        input.setAttribute('data-custom-field', def.name)
        if (isRequired && type !== 'checkbox') input.setAttribute('required', '')
        wrap.appendChild(input)
        grid.appendChild(wrap)
    })
}

/**
 * 层级A：收集表单中所有自定义字段的当前值（checkbox → boolean）。
 * 供各模块 handleSubmit 在组装 result_data 时合并。
 */
export function collectCustomFieldValues(formEl, customization) {
    const values = {}
    if (!formEl) return values
    // RK38: hidden_fields 中的自定义字段【不收集/不提交】，与"隐藏=停用"语义一致
    let hidden = []
    if (customization && customization.hidden_fields) {
        try {
            const parsed = typeof customization.hidden_fields === 'string'
                ? JSON.parse(customization.hidden_fields)
                : customization.hidden_fields
            if (Array.isArray(parsed)) hidden = parsed
        } catch { /* ignore */ }
    }
    formEl.querySelectorAll('[data-custom-field]').forEach((input) => {
        const name = input.getAttribute('data-custom-field')
        if (!name) return
        if (hidden.includes(name)) return
        values[name] = input.type === 'checkbox' ? input.checked : input.value
    })
    return values
}

export function applyCustomizationToAllForms(customization) {
    if (!customization) return
    TEST_FORM_IDS.forEach((id) => {
        const form = document.getElementById(id)
        if (form) applySchoolCustomizationToForm(form, customization)
    })
}

/**
 * TD-CanteenFromConfig: 读取学校管理控制台配置的食堂列表。
 * 数据源（按优先级，与 admin-schools.html 基本信息保存路径一致）：
 *   1) field_options.canteen  — 后端保存时同步写入，最权威
 *   2) canteens（顶层 JSON 列）— 兼容老缓存/历史定制
 *   3) 内置兜底 ['一食堂', '二食堂', '三食堂']
 * 说明：与 Pathogen.js 内置的 getSchoolCanteens 同源实现抽到此处，供 Dashboard
 * 数据看板、Pathogen 录入/补录、ExportService 导出筛选等统一调用，避免出现
 * 「管理端加了两个食堂，看板下拉只显示一个」之类的「配置不同步」故障。
 *
 * @param {string} [schoolCode] 不传则用 extractSchoolCode() 自动取当前校
 * @param {string[]} [fallback] 自定义兜底（默认一/二/三食堂）
 * @returns {string[]} 学校食堂名数组（保证非空）
 */
export function getSchoolCanteens(schoolCode, fallback) {
    try {
        const code = schoolCode || (typeof extractSchoolCode === 'function' ? extractSchoolCode() : null)
        const cfg = code ? getSchoolCustomization(code) : {}
        if (cfg && typeof cfg === 'object') {
            // 1) field_options.canteen（最权威，后端每次保存都同步）
            try {
                const fo = typeof cfg.field_options === 'string' ? JSON.parse(cfg.field_options) : cfg.field_options
                if (fo && Array.isArray(fo.canteen) && fo.canteen.length) {
                    return fo.canteen.map(c => String(c).trim()).filter(Boolean)
                }
            } catch (_) { /* 容错：JSON 解析失败时回退下一来源 */ }
            // 2) 顶层 canteens JSON 列（兼容历史定制）
            try {
                const cts = typeof cfg.canteens === 'string' ? JSON.parse(cfg.canteens) : cfg.canteens
                if (Array.isArray(cts) && cts.length) {
                    return cts.map(c => String(c).trim()).filter(Boolean)
                }
            } catch (_) { /* 容错 */ }
        }
    } catch (_) { /* 读取失败时回退兜底 */ }
    return (Array.isArray(fallback) && fallback.length) ? fallback.slice() : ['一食堂', '二食堂', '三食堂']
}
