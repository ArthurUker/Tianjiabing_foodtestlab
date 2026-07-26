/**
 * schoolCustomization/visible.js（RK51 拆分）
 * RK3：检测模块可见性（visible_types）——解析该校实际可见模块列表，
 * 并应用到主应用导航按钮与内容区块。
 */

import { getAllModules, getDefaultVisibleTypes, isValidModuleCode } from '../../modules/registry.js'
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
        if (section) section.classList.toggle('hidden', !show)
    })
}
