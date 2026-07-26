/**
 * schoolCustomization/shared.js（RK51 拆分）
 * 子模块共享的纯工具函数与常量，无 DOM / 网络 / 存储副作用。
 * 仅供 schoolCustomization 子模块内部使用，不对外导出到聚合入口。
 */

// 解析 customization 里的字符串 JSON 字段（DB 里存的是 text）
export function parseJSONField(v) {
    if (v == null) return null
    if (typeof v === 'string') {
        try { return JSON.parse(v) } catch { return null }
    }
    return v
}

export function escapeHtml(s) {
    if (s == null) return ''
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// 表单 id → 模块 code（用于查 field_order / custom_fields）
export const FORM_MODULE_MAP = {
    tablewareTestForm: 'tableware',
    pesticideTestForm: 'pesticide',
    oilTestForm: 'oil',
    leanMeatTestForm: 'leanMeat',
}

// 已知静态录入表单 id（存在才应用）
export const TEST_FORM_IDS = ['tablewareTestForm', 'pesticideTestForm', 'oilTestForm', 'leanMeatTestForm']

/**
 * 通用「顶层字段优先，回退 theme_config.<key>」解析器。
 * SchoolCustomization 的若干配置（field_options/field_order/section_titles）
 * 既可能存于顶层列，也可能嵌套在 theme_config（与 admin 控制台保存结构一致）。
 * @param {Object} customization
 * @param {string} key 配置键名
 * @returns {Object} 解析后的对象（异常/缺失时为 {}）
 */
export function parseTopOrThemeObject(customization, key) {
    if (!customization) return {}
    const top = parseJSONField(customization[key])
    const nested = parseJSONField(customization.theme_config)
    const fromTheme = nested && !Array.isArray(nested) ? nested[key] : null
    return (top && typeof top === 'object') ? top
        : (fromTheme && typeof fromTheme === 'object') ? fromTheme
        : {}
}
