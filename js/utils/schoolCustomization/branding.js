/**
 * schoolCustomization/branding.js（RK51 拆分）
 * 品牌与标题维度：学校名/校徽/主题色应用（RK9 白名单）、
 * 看板卡片与各模块小标题覆盖（section_titles）。
 */

import { ensureSchoolInfo } from './cache.js'
import { parseTopOrThemeObject } from './shared.js'

// RK9/DS-12: Logo URL 白名单——仅 http(s) 与位图 data URI（明确排除 SVG，可携带脚本）
function isSafeLogoUrl(url) {
    if (typeof url !== 'string') return false
    return /^https?:\/\//i.test(url) || /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(url)
}

/**
 * 读取小标题覆盖（section_titles）。兼容顶层字段与 theme_config.section_titles 两种形态。
 * @param {Object} customization
 * @returns {Object} { titleKey: "自定义标题" }
 */
function parseSectionTitles(customization) {
    return parseTopOrThemeObject(customization, 'section_titles')
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
