/**
 * schoolCustomization/visible.js（RK51 拆分）
 * RK3：检测模块可见性（visible_types）——解析该校实际可见模块列表，
 * 并应用到主应用导航按钮与内容区块。
 */

import { getAllModules, getDefaultVisibleTypes, isValidModuleCode, MENU_ITEMS, getDefaultVisibleMenuItems, isValidMenuItemCode } from '../../modules/registry.js'
import { parseJSONField } from './shared.js'

/**
 * RK3：解析该校实际可见的检测模块列表。
 * 优先读 customization.visible_types（数组）；兼容写在 theme_config.visible_types 的写法；
 * 缺省或非法时回退到注册中心默认可见集（全部已登记模块）。
 * 仅返回注册中心中存在的合法模块 code，过滤掉脏数据。
 */
export function getVisibleTypes(customization) {
    if (!customization) return getDefaultVisibleTypes()

    let parsed = parseJSONField(customization.visible_types)
    if (!Array.isArray(parsed) || parsed.length === 0) {
        const theme = parseJSONField(customization.theme_config)
        if (theme && typeof theme === 'object') {
            parsed = theme.visible_types
        }
    }
    if (Array.isArray(parsed) && parsed.length > 0) {
        const filtered = parsed.filter((c) => isValidModuleCode(c))
        if (filtered.length > 0) return filtered
    }
    return getDefaultVisibleTypes()
}

/**
 * RK3：把 visible_types 应用到主应用——隐藏/显示对应导航按钮与内容区块。
 * 仅作用于检测模块（5 个），不影响管理类菜单（其可见性由 Router 权限逻辑控制）。
 * 所有模块按钮与内容区为静态存在，配置加载后再调用本函数即可，无需重建导航。
 */
export function applyVisibleTypesToNav(customization) {
    const visible = getVisibleTypes(customization)
    getAllModules().forEach((m) => {
        const btn = document.querySelector(`[data-target="${m.navTarget}"]`)
        const section = document.getElementById(m.navTarget)
        const show = visible.includes(m.code)
        if (btn) btn.classList.toggle('hidden', !show)
        if (section) {
            // 导航按钮：.hidden 表示「该校不提供此模块入口」，由 visible_types 控制。
            // 内容区块：.hidden 表示「当前未激活」，其互斥显示权交给左侧菜单点击
            // （见 UIHelper.setupNavigation），此处【切勿】对可见模块强制移除 .hidden，
            // 否则所有可见模块会同时展开，页面可被整体滑动穿透（首尾模块一划到底）。
            // 因此：不可见模块 → 强制隐藏内容区；可见模块 → 内容区显示态保持不变。
            if (!show) section.classList.add('hidden')
        }
    })
}


/**
 * 菜单项可见性（visible_menu_items）：解析该校实际可见菜单项列表。
 * 优先读 customization.visible_menu_items（数组）；缺省或非法时回退到注册中心默认可见集。
 * 仅返回注册中心中存在的合法 code，过滤掉脏数据。
 */
export function getVisibleMenuItems(customization) {
    if (!customization) return getDefaultVisibleMenuItems()

    const parsed = parseJSONField(customization.visible_menu_items)
    if (Array.isArray(parsed) && parsed.length > 0) {
        const filtered = parsed.filter((c) => isValidMenuItemCode(c))
        if (filtered.length > 0) return filtered
    }
    return getDefaultVisibleMenuItems()
}

/**
 * 把 visible_menu_items 应用到主应用导航——隐藏/显示对应菜单按钮。
 * 设计要点：
 *   1. canHide=false 项（如退出登录）强制始终显示，绕过定制数据兜底保护。
 *   2. 分组标题联动：所有 category='admin' 项都被隐藏时，'管理' 分组标题也隐藏（避免空白）。
 *   3. 不修改内容区块（content section）的显隐——可见模块互斥切换由左侧菜单点击逻辑负责。
 */
export function applyVisibleMenuItemsToNav(customization) {
    const visible = new Set(getVisibleMenuItems(customization))
    // 退出登录强制始终显示（防 customization 脏数据导致按钮丢失）
    visible.add('logout')

    MENU_ITEMS.forEach((m) => {
        const el = document.querySelector(m.domSelector)
        if (!el) return
        const show = visible.has(m.code)
        if (m.canHide) {
            el.classList.toggle('hidden', !show)
        } else {
            // 不可隐藏项（如退出登录）：强制移除 .hidden
            el.classList.remove('hidden')
        }
    })

    // '管理' 分组标题联动：所有 admin 类项都被隐藏时也隐藏，避免空标签栏
    const adminHeader = document.querySelector('[data-section-title="admin"]')
    if (adminHeader) {
        const anyAdminVisible = MENU_ITEMS
            .filter((m) => m.category === 'admin')
            .some((m) => visible.has(m.code))
        adminHeader.classList.toggle('hidden', !anyAdminVisible)
    }
}
