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
 *
 * 校徽呈现设计（DS-BRAND-01）：
 * - 48×48 圆形/圆角徽章容器：白底 + ring + 阴影，与顶部彩色导航条形成对比
 * - 加载成功：图片以 object-contain 完整展示，保持原比例
 * - 加载失败：onerror 优雅降级为「校名首字 + 渐变色块」首字徽章
 * - 无 logoUrl：直接渲染首字徽章（不显示缺失图标）
 * - 首字徽章颜色按校名 hash 从 5 种渐变里挑一种，避免全校同一个颜色
 * - 整个容器是 layout-shrink-safe：长学校名截断时徽章不被压扁
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

    // 2. 校徽 Logo
    // RK9: 不用 innerHTML 拼接服务端数据；URL 白名单校验（禁止 javascript:/data:image/svg+xml 等）
    const logoWrap = document.getElementById('systemLogo')
    if (!logoWrap) return

    // 重置容器为统一徽章样式（替换默认 FontAwesome 图标的扁平外观）
    logoWrap.className = [
        'flex', 'items-center', 'justify-center',
        'w-12', 'h-12', 'shrink-0',
        'rounded-2xl',
        'bg-white/95', 'backdrop-blur',
        'ring-1', 'ring-white/40',
        'shadow-md', 'shadow-black/10',
        'overflow-hidden',
        'transition-all', 'duration-200',
    ].join(' ')
    logoWrap.textContent = ''

    if (info.logoUrl && isSafeLogoUrl(info.logoUrl)) {
        const img = document.createElement('img')
        img.src = info.logoUrl
        img.alt = info.name || '校徽'
        img.title = info.name || '校徽'
        img.loading = 'lazy'
        img.decoding = 'async'
        // p-1 给图片留内边距，避免小尺寸校徽贴边（透明背景 PNG 视觉上更透气）
        img.className = 'w-full h-full p-1 object-contain transition-opacity duration-200 opacity-0'
        // 图片加载完成后淡入（避免白底闪烁）
        img.addEventListener('load', () => { img.classList.remove('opacity-0') }, { once: true })
        // 加载失败 → 降级为首字徽章
        img.addEventListener('error', () => renderSchoolInitialBadge(logoWrap, info.name), { once: true })
        logoWrap.appendChild(img)
        // 兜底：若 3 秒后仍未触发 load/error（极少见但 CDN 卡死时可能），主动降级
        setTimeout(() => {
            if (!img.complete || img.naturalWidth === 0) {
                renderSchoolInitialBadge(logoWrap, info.name)
            }
        }, 3000)
    } else {
        // 无 logoUrl：直接显示首字徽章
        renderSchoolInitialBadge(logoWrap, info.name)
    }
}

// DS-BRAND-01: 首字徽章 fallback。颜色按校名首字 hash 从 5 种渐变里挑一种。
function renderSchoolInitialBadge(wrap, schoolName) {
    // 取第一个可见字符（兼容中英文混合校名）
    const trimmed = (schoolName || '').trim()
    const initial = trimmed ? Array.from(trimmed)[0] : '校'
    // 用 charCodeAt 不适用中文；改用字符串 hashCode
    let hash = 0
    for (let i = 0; i < trimmed.length; i++) {
        hash = (hash * 31 + trimmed.charCodeAt(i)) | 0
    }
    const palette = [
        'from-blue-500 to-indigo-600',
        'from-emerald-500 to-teal-600',
        'from-orange-500 to-rose-600',
        'from-purple-500 to-fuchsia-600',
        'from-amber-500 to-orange-600',
        'from-sky-500 to-cyan-600',
        'from-rose-500 to-pink-600',
    ]
    const idx = Math.abs(hash) % palette.length
    wrap.textContent = ''
    const badge = document.createElement('div')
    badge.className = [
        'w-full', 'h-full',
        'flex', 'items-center', 'justify-center',
        'bg-gradient-to-br', palette[idx],
        'text-white', 'font-bold',
        // 中文用 text-xl、英文用 text-2xl，通过 :lang 难做，统一 text-xl 视觉平衡
        'text-xl',
        'select-none',
    ].join(' ')
    badge.textContent = initial
    badge.title = schoolName || '校徽'
    wrap.appendChild(badge)
}
