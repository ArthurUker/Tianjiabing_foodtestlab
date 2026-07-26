/**
 * schoolCustomization.js
 * 跨页面存取当前学校的个性化配置（SchoolCustomization），并把它合并到表单字段定义。
 * 数据来源：登录页 / 主应用调用 GET /api/schools/:schoolCode/config 后写入 localStorage。
 *
 * 该模块让"统一代码 + 按校个性化"落地：学校名、界面主题、字段标签/显隐/必填规则
 * 全部来自 public 系统表，业务代码不出现任何学校专有命名。
 */

import { extractSchoolCode } from './schoolCode.js'

const KEY_PREFIX = 'school_customization_'
const INFO_KEY_PREFIX = 'school_info_'   // 学校外观信息（name/logoUrl/themeColor）独立缓存
const TS_KEY_PREFIX = 'school_customization_ts_' // RK15: 缓存写入时间戳
const CACHE_TTL_MS = 5 * 60 * 1000               // RK15: 缓存 TTL 5 分钟

// 写入当前校 customization（由登录页或主应用调用）
export function setSchoolCustomization(schoolCode, customization) {
    if (!schoolCode) return
    try {
        localStorage.setItem(KEY_PREFIX + schoolCode, JSON.stringify(customization || {}))
        localStorage.setItem(TS_KEY_PREFIX + schoolCode, String(Date.now()))
    } catch (e) { /* 存储不可用时忽略 */ }
}

/**
 * RK14/RK26/RK27: 清除所有学校定制相关缓存（登出/会话过期时调用），
 * 防止上一账号/上一学校的定制配置泄漏到下一次会话。
 */
export function clearSchoolConfigCache() {
    try {
        const keys = []
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)
            if (k && (k.startsWith(KEY_PREFIX) || k.startsWith(INFO_KEY_PREFIX))) keys.push(k)
        }
        keys.forEach(k => localStorage.removeItem(k))
    } catch (e) { /* 存储不可用时忽略 */ }
}

// 读取当前校外观信息（name/shortName/logoUrl/themeColor）
export function getSchoolInfo(schoolCode) {
    if (!schoolCode) return null
    try {
        return JSON.parse(localStorage.getItem(INFO_KEY_PREFIX + schoolCode) || 'null')
    } catch (e) {
        return null
    }
}

// 写入当前校外观信息（由登录页或主应用调用）
export function setSchoolInfo(schoolCode, info) {
    if (!schoolCode) return
    try {
        localStorage.setItem(INFO_KEY_PREFIX + schoolCode, JSON.stringify(info || {}))
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

function escapeHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// RK9/DS-12: Logo URL 白名单——仅 http(s) 与位图 data URI（明确排除 SVG，可携带脚本）
function isSafeLogoUrl(url) {
    if (typeof url !== 'string') return false
    return /^https?:\/\//i.test(url) || /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(url)
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
    if (!customization) return {}
    const top = parseJSONField(customization.field_options)
    const nested = parseJSONField(customization.theme_config)
    const fromTheme = nested && !Array.isArray(nested) ? nested.field_options : null
    return (top && typeof top === 'object') ? top
        : (fromTheme && typeof fromTheme === 'object') ? fromTheme
        : {}
}

// 表单 id → 模块 code（用于查 field_order）
const FORM_MODULE_MAP = {
    tablewareTestForm: 'tableware',
    pesticideTestForm: 'pesticide',
    oilTestForm: 'oil',
    leanMeatTestForm: 'leanMeat',
}

/**
 * 读取字段顺序覆盖（field_order）。兼容顶层字段与 theme_config.field_order 两种形态。
 * @param {Object} customization
 * @returns {Object} { moduleCode: [字段名, ...] }
 */
function parseFieldOrder(customization) {
    if (!customization) return {}
    const top = parseJSONField(customization.field_order)
    const nested = parseJSONField(customization.theme_config)
    const fromTheme = nested && !Array.isArray(nested) ? nested.field_order : null
    return (top && typeof top === 'object') ? top
        : (fromTheme && typeof fromTheme === 'object') ? fromTheme
        : {}
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
    // 🆕 下拉选项覆盖（图形化编辑保存的选项列表）
    const fieldOptions = parseFieldOptions(customization)

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
        // CR-03/BS-05: 当前值不在新选项中时，追加一个 disabled 的"历史值"option，
        // 避免用户已选值/历史记录值被静默丢弃
        if (field.tagName === 'SELECT' && Array.isArray(fieldOptions[name]) && fieldOptions[name].length) {
            const opts = fieldOptions[name]
            const current = field.value
            field.innerHTML = opts.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')
            if (opts.includes(current)) {
                field.value = current
            } else if (current) {
                const legacy = document.createElement('option')
                legacy.value = current
                legacy.textContent = `${current}（历史值）`
                legacy.disabled = true
                field.appendChild(legacy)
                field.value = current
            }
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

// 已知静态录入表单 id（存在才应用）
const TEST_FORM_IDS = ['tablewareTestForm', 'pesticideTestForm', 'oilTestForm', 'leanMeatTestForm']

export function applyCustomizationToAllForms(customization) {
    if (!customization) return
    TEST_FORM_IDS.forEach((id) => {
        const form = document.getElementById(id)
        if (form) applySchoolCustomizationToForm(form, customization)
    })
}

/**
 * 读取小标题覆盖（section_titles）。兼容顶层字段与 theme_config.section_titles 两种形态。
 * @param {Object} customization
 * @returns {Object} { titleKey: "自定义标题" }
 */
function parseSectionTitles(customization) {
    if (!customization) return {}
    const top = parseJSONField(customization.section_titles)
    const nested = parseJSONField(customization.theme_config)
    const fromTheme = nested && !Array.isArray(nested) ? nested.section_titles : null
    return (top && typeof top === 'object') ? top
        : (fromTheme && typeof fromTheme === 'object') ? fromTheme
        : {}
}

// 所有可定制的小标题 key（看板卡片 + 各模块小标题）
const TITLE_KEYS = [
    'dash_tableware', 'dash_pesticide', 'dash_oil', 'dash_pathogen', 'dash_leanMeat',
    'dash_tableware_overview', 'dash_pesticide_overview', 'dash_oil_overview', 'dash_pathogen_overview',
    'dash_lean_pork_overview', 'dash_lean_mutton_overview', 'dash_lean_beef_overview',
    'dash_lean_poultry_overview', 'dash_lean_fish_overview', 'dash_lean_egg_overview',
    'section_tableware', 'section_pesticide', 'section_oil', 'section_leanMeat', 'section_pathogen',
]

/**
 * 把学校个性化配置中的小标题覆盖（看板卡片标题 / 各检测模块小标题）应用到当前页面 DOM。
 * 由 main.js 在初始化时与 applyCustomizationToAllForms 一起调用。
 * @param {Object} customization
 */
export function applySchoolCustomizationToTitles(customization) {
    if (!customization) return
    const sectionTitles = parseSectionTitles(customization)
    if (!sectionTitles || !Object.keys(sectionTitles).length) return
    TITLE_KEYS.forEach((key) => {
        const el = document.querySelector(`[data-title-key="${key}"]`)
        if (el && sectionTitles[key]) el.textContent = sectionTitles[key]
    })
}

/**
 * 兜底：若 localStorage 无该校 customization（用户直接打开 index.html，未经 login.html 写入缓存），
 * 则调用公开端点拉取并缓存，保证按校差异化始终生效。
 * @param {string} schoolCode
 * @returns {Promise<Object>} customization（可能为 {}）
 */
// CR-02: 同 schoolCode 并发调用共享同一 fetch Promise（in-flight 去重）
const inflightConfigFetches = new Map()

function isCacheFresh(schoolCode) {
    try {
        const ts = Number(localStorage.getItem(TS_KEY_PREFIX + schoolCode) || 0)
        return ts > 0 && (Date.now() - ts) < CACHE_TTL_MS
    } catch (e) {
        return false
    }
}

async function fetchSchoolConfig(schoolCode) {
    const resp = await fetch(`/api/schools/${encodeURIComponent(schoolCode)}/config`)
    if (!resp.ok) return null
    const json = await resp.json()
    const data = (json && json.data) || {}
    const customization = data.customization || {}
    setSchoolCustomization(schoolCode, customization)
    if (data.name || data.logoUrl || data.themeColor) {
        setSchoolInfo(schoolCode, {
            name: data.name || '',
            shortName: data.shortName || '',
            logoUrl: data.logoUrl || '',
            themeColor: data.themeColor || '',
        })
    }
    return customization
}

export async function ensureSchoolConfig(schoolCode) {
    if (!schoolCode) return {}
    const cached = getSchoolCustomization(schoolCode)
    // RK15: 缓存命中且未过期（5 分钟 TTL）才直接返回；过期则重新拉取（拉取失败时降级用旧缓存）
    if (cached && Object.keys(cached).length && isCacheFresh(schoolCode)) return cached
    // CR-02: in-flight 去重
    if (inflightConfigFetches.has(schoolCode)) {
        try { return (await inflightConfigFetches.get(schoolCode)) ?? cached ?? {} } catch { return cached || {} }
    }
    const p = fetchSchoolConfig(schoolCode)
    inflightConfigFetches.set(schoolCode, p)
    try {
        const fresh = await p
        return fresh ?? cached ?? {}
    } catch (e) {
        console.warn('⚠️ 拉取学校个性化配置失败:', e)
        return cached || {}
    } finally {
        inflightConfigFetches.delete(schoolCode)
    }
}

/**
 * 兜底拉取学校外观信息（与 ensureSchoolConfig 互补，供主页顶部标题/Logo 使用）。
 * @param {string} schoolCode
 * @returns {Promise<Object|null>} { name, shortName, logoUrl, themeColor } 或 null
 */
export async function ensureSchoolInfo(schoolCode) {
    if (!schoolCode) return null
    const cached = getSchoolInfo(schoolCode)
    if (cached && cached.name) return cached
    try {
        const resp = await fetch(`/api/schools/${encodeURIComponent(schoolCode)}/config`)
        if (!resp.ok) return null
        const json = await resp.json()
        const data = (json && json.data) || {}
        const info = {
            name: data.name || '',
            shortName: data.shortName || '',
            logoUrl: data.logoUrl || '',
            themeColor: data.themeColor || '',
        }
        setSchoolInfo(schoolCode, info)
        return info
    } catch (e) {
        return null
    }
}

/**
 * 把学校外观信息应用到主页顶部：系统标题、Logo、document.title、主题色。
 * 由 main.js 在初始化时调用，实现"品牌中立化 —— 按校动态显示"。
 * @param {string} schoolCode
 */
export async function applySchoolBranding(schoolCode) {
    if (!schoolCode) return
    const info = await ensureSchoolInfo(schoolCode)
    if (!info) return

    // 1. 系统标题
    if (info.name) {
        const titleEl = document.getElementById('systemTitle')
        if (titleEl) titleEl.textContent = `${info.name}食品安全检验管理系统`
        document.title = `${info.name} - 食品安全检验管理系统`
    }

    // 2. 校徽 Logo（替换默认 FontAwesome 图标）
    // RK9: 不用 innerHTML 拼接服务端数据；URL 白名单校验（禁止 javascript:/data:image/svg+xml 等）
    if (info.logoUrl && isSafeLogoUrl(info.logoUrl)) {
        const logoWrap = document.getElementById('systemLogo')
        if (logoWrap) {
            const img = document.createElement('img')
            img.src = info.logoUrl
            img.alt = info.name || '校徽'
            img.className = 'w-8 h-8 object-contain'
            logoWrap.textContent = ''
            logoWrap.appendChild(img)
        }
    }
}

export default {
    setSchoolCustomization,
    getSchoolCustomization,
    clearSchoolConfigCache,
    resolveCustomFields,
    injectCustomFields,
    collectCustomFieldValues,
    isRecordQualifiedByCustomFields,
    setSchoolInfo,
    getSchoolInfo,
    ensureSchoolInfo,
    applySchoolBranding,
    applyCustomizationToFields,
    applySchoolCustomizationToForm,
    applyCustomizationToAllForms,
    applySchoolCustomizationToTitles,
    ensureSchoolConfig,
}
