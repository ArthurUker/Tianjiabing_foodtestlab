/**
 * schoolCustomization/branding.js（RK51 拆分）
 * 品牌与标题维度：学校名/校徽/主题色应用（RK9 白名单）、
 * 看板卡片与各模块小标题覆盖（section_titles）。
 */

import { ensureSchoolInfo, ensureSchoolConfig } from './cache.js'
import { parseTopOrThemeObject, parseJSONField } from './shared.js'

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
export async function applySchoolBranding(schoolCode, force = false) {
    if (!schoolCode) return
    const info = await ensureSchoolInfo(schoolCode, force)
    if (!info) return

    // 1. 系统标题
    // 允许通过定制 theme_config.systemTitle 完全自定义顶部标题；
    // 未设置（或为空）时回退到默认 "<学校名称>食品安全检验管理系统"。
    let titleText = info.name ? `${info.name}食品安全检验管理系统` : ''
    try {
        const cfg = await ensureSchoolConfig(schoolCode, force)
        const tc = parseJSONField(cfg && cfg.theme_config) || {}
        const customTitle = tc.systemTitle
        if (typeof customTitle === 'string' && customTitle.trim()) titleText = customTitle.trim()
    } catch (_) { /* 定制缺失不影响降级渲染 */ }
    if (titleText) {
        const titleEl = document.getElementById('systemTitle')
        if (titleEl) titleEl.textContent = titleText
        document.title = titleText
    }

    // 2. 校徽 Logo
    // RK9: 不用 innerHTML 拼接服务端数据；URL 白名单校验（禁止 javascript:/data:image/svg+xml 等）
    const logoWrap = document.getElementById('systemLogo')
    if (!logoWrap) return

    // 读取排版参数（theme_config.logo_style）。存在则按「背景水印层」或「裁切后徽章」渲染。
    let logoStyle = null
    try {
        const cfg = await ensureSchoolConfig(schoolCode)
        const tc = parseJSONField(cfg && cfg.theme_config) || {}
        logoStyle = isValidLogoStyle(tc.logo_style)
    } catch (_) { /* 配置缺失不影响降级渲染 */ }

    // —— 背景水印模式：把校徽作为顶部导航底层（像背景），可定位/缩放/调透明度 ——
    removeBrandBgLayer(logoWrap)
    if (logoStyle && logoStyle.display === 'background' && logoStyle.croppedUrl && isSafeLogoUrl(logoStyle.croppedUrl)) {
        if (applyBackgroundBadge(logoWrap, logoStyle)) {
            logoWrap.style.display = 'none'   // 背景模式下隐藏左侧小徽章，避免重复
            return
        }
        // 应用失败（无 nav 容器等）则回落到普通徽章逻辑
    }
    logoWrap.style.display = ''

    // 3. 普通徽章（默认 / 排版未设置时）：优先用裁切后图，否则原图
    const src = (logoStyle && logoStyle.croppedUrl && isSafeLogoUrl(logoStyle.croppedUrl))
        ? logoStyle.croppedUrl
        : info.logoUrl
    const badgeSize = logoStyle ? logoStyle.badgeSize : 48

    // 重置容器为统一徽章样式（替换默认 FontAwesome 图标的扁平外观）
    // DS-BRAND-CIRCLE：圆形徽章（编辑器可选手动选择）用 rounded-full
    const isCircle = !!(logoStyle && logoStyle.shape === 'circle')
    logoWrap.className = [
        'flex', 'items-center', 'justify-center',
        'shrink-0',
        isCircle ? 'rounded-full' : 'rounded-2xl',
        'bg-white/95', 'backdrop-blur',
        'ring-1', 'ring-white/40',
        'shadow-md', 'shadow-black/10',
        'overflow-hidden',
        'transition-all', 'duration-200',
    ].join(' ')
    // 尺寸按排版（默认 48×48 = w-12 h-12）
    logoWrap.style.width = badgeSize + 'px'
    logoWrap.style.height = badgeSize + 'px'
    logoWrap.textContent = ''

    if (src && isSafeLogoUrl(src)) {
        const img = document.createElement('img')
        img.src = src
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

// 校验并规整 logo_style（防御性：服务端数据异常也不应破坏页面）
function isValidLogoStyle(s) {
    if (!s || typeof s !== 'object') return null
    const display = s.display === 'background' ? 'background' : 'badge'
    const crop = (s.crop && typeof s.crop === 'object')
        ? {
            x: clampNum(s.crop.x, 0, 100, 0), y: clampNum(s.crop.y, 0, 100, 0),
            w: clampNum(s.crop.w, 1, 100, 100), h: clampNum(s.crop.h, 1, 100, 100),
        }
        : null
    return {
        display,
        croppedUrl: typeof s.croppedUrl === 'string' ? s.croppedUrl : null,
        crop,
        posX: clampNum(s.posX, 0, 100, 50),
        posY: clampNum(s.posY, 0, 100, 50),
        scale: clampNum(s.scale, 0.1, 5, 1.6),
        opacity: clampNum(s.opacity, 0, 1, 0.16),
        aspectLock: !!s.aspectLock,
        badgeSize: Math.round(clampNum(s.badgeSize, 24, 120, 48)),
    }
}

function clampNum(v, min, max, d) {
    const n = typeof v === 'number' && isFinite(v) ? v : d
    return Math.max(min, Math.min(max, n))
}

// 移除上一次注入的背景水印层（重复应用 / 切回徽章时清理）
function removeBrandBgLayer(logoWrap) {
    const nav = logoWrap.closest('nav')
    if (!nav) return
    const old = nav.querySelector('.brand-bg-layer')
    if (old) old.remove()
}

// 把校徽作为导航底层水印层注入。成功返回 true。
// DS-BRAND-02：水印必须位于文字「下方」（z-index 更低），且几何上不压住校名文字。
// 注意：编辑器为所见即所得，此处严格使用编辑器设定的 posX/posY，不做自动位移
// （早期版本会把 22%~78% 的位置弹开到 12/88，导致"摆中间却跳走"，已废弃）。
function applyBackgroundBadge(logoWrap, style) {
    const nav = logoWrap.closest('nav')
    if (!nav) return false
    // 仅当 nav 尚未定位时才设为 relative，避免覆盖 HTML 上的 sticky 吸顶
    if (getComputedStyle(nav).position === 'static') nav.style.position = 'relative'

    const px = (typeof style.posX === 'number') ? style.posX : 50
    const py = (typeof style.posY === 'number') ? style.posY : 50

    const layer = document.createElement('div')
    layer.className = 'brand-bg-layer'
    layer.style.cssText = [
        'position:absolute', 'inset:0', 'z-index:0', 'pointer-events:none',
        'background-repeat:no-repeat',
        `background-image:url("${style.croppedUrl}")`,
        `background-size:auto ${style.scale * 100}%`,
        `background-position:${px}% ${py}%`,
        `opacity:${style.opacity}`,
    ].join(';') + ';'
    nav.appendChild(layer)

    // 2. 内容容器（含校名/按钮）明确置顶：relative + z-index:2，确保恒在水印之上。
    const container = nav.querySelector(':scope > div')
    if (container) { container.style.position = 'relative'; container.style.zIndex = '2' }

    // 3. 校名文字加投影，提升在水印之上的可读性（即便水印较醒目也不糊字）。
    nav.querySelectorAll('#systemTitle').forEach((t) => {
        t.style.textShadow = '0 1px 4px rgba(0,0,0,0.45)'
    })
    return true
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
