/**
 * schoolCustomization/cache.js（RK51 拆分）
 * 学校个性化配置的本地缓存层：localStorage 读写、TTL 过期（RK15）、
 * in-flight 去重（CR-02）、登出清缓存（RK14/RK26/RK27）、跨标签页同步（CR-06）。
 * 数据来源：GET /api/schools/:schoolCode/config。
 */

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
        // RK15: 同步写入时间戳，使 ensureSchoolInfo 能在 TTL 过期后重新拉取（避免永久陈旧）
        localStorage.setItem(TS_KEY_PREFIX + schoolCode, String(Date.now()))
    } catch (e) { /* 存储不可用时忽略 */ }
}

// 读取当前校 customization（供业务模块消费）
export function getSchoolCustomization(schoolCode) {
    if (!schoolCode) return {}
    try {
        const customization = JSON.parse(localStorage.getItem(KEY_PREFIX + schoolCode) || '{}') || {}
        // Q4: 内层 JSON 字符串字段(旧缓存/后端字符串序列化)兜底还原为对象,避免业务代码拿不到属性
        for (const key of ['custom_fields', 'field_labels', 'hidden_fields', 'field_order', 'test_types', 'theme_config', 'field_rules']) {
            if (typeof customization[key] === 'string') {
                try { customization[key] = JSON.parse(customization[key]) } catch (_) { customization[key] = {} }
            }
        }
        return customization
    } catch (e) {
        return {}
    }
}

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
    if (data.name || data.logoUrl || data.themeColor || data.updatedAt) {
        setSchoolInfo(schoolCode, {
            name: data.name || '',
            shortName: data.shortName || '',
            logoUrl: data.logoUrl || '',
            themeColor: data.themeColor || '',
            updatedAt: data.updatedAt || null,
            // SchoolCustomization.updated_at：systemTitle/校徽排版等落在定制表，
            // 仅比较 School.updated_at 会漏掉"只改系统标题"的版本变化，故一并记录。
            customizationUpdatedAt: (data.customization && data.customization.updated_at) || null,
        })
    }
    return customization
}

/**
 * 兜底：若 localStorage 无该校 customization（用户直接打开 index.html，未经 login.html 写入缓存），
 * 则调用公开端点拉取并缓存，保证按校差异化始终生效。
 * @param {string} schoolCode
 * @returns {Promise<Object>} customization（可能为 {}）
 */
export async function ensureSchoolConfig(schoolCode, force = false) {
    if (!schoolCode) return {}
    const cached = getSchoolCustomization(schoolCode)
    // RK15: 缓存命中且未过期（5 分钟 TTL）才直接返回；过期则重新拉取（拉取失败时降级用旧缓存）
    // force=true（管理控制台保存后等变更事件触发）绕过缓存，直接从服务端取最新，保证师生端立即可见。
    if (!force && cached && Object.keys(cached).length && isCacheFresh(schoolCode)) return cached
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
export async function ensureSchoolInfo(schoolCode, force = false) {
    if (!schoolCode) return null
    const cached = getSchoolInfo(schoolCode)
    // RK15: 与 ensureSchoolConfig 一致——缓存命中且未过期（5 分钟 TTL）才直接返回；
    // 否则重新拉取服务端最新外观（校徽/校名/主题色），保证管理控制台修改后师生端可见。
    // force=true 绕过缓存，用于管理控制台保存后派发的变更事件，确保师生端标签页立即可见最新值。
    if (!force && cached && cached.name && isCacheFresh(schoolCode)) return cached
    try {
        const resp = await fetch(`/api/schools/${encodeURIComponent(schoolCode)}/config`)
        if (!resp.ok) return (force ? (cached || null) : null)
        const json = await resp.json()
        const data = (json && json.data) || {}
        const info = {
            name: data.name || '',
            shortName: data.shortName || '',
            logoUrl: data.logoUrl || '',
            themeColor: data.themeColor || '',
            updatedAt: data.updatedAt || null,
            customizationUpdatedAt: (data.customization && data.customization.updated_at) || null,
        }
        setSchoolInfo(schoolCode, info)
        return info
    } catch (e) {
        return (force ? (cached || null) : null)
    }
}

/**
 * 版本校验：用服务端 School.updated_at 与本地缓存时间戳比较，若服务端更新则刷新缓存。
 * 用于页面重新可见（visibilitychange）/ 冷重开仍在 TTL 内等场景，弥补 storage 事件
 * 仅在「编辑时标签页已打开」才触发的局限，保证师生端始终展示管理控制台保存后的最新外观。
 * @returns {Promise<boolean>} 是否发生了更新（调用方可据此决定是否重应用品牌）
 */
export async function revalidateSchoolInfo(schoolCode) {
    if (!schoolCode) return false
    try {
        const resp = await fetch(`/api/schools/${encodeURIComponent(schoolCode)}/config`)
        if (!resp.ok) return false
        const json = await resp.json()
        const data = (json && json.data) || {}
        const cached = getSchoolInfo(schoolCode)
        // 取 School 与 SchoolCustomization 两者 updated_at 的较大值：任一处（校名/校徽 或 系统标题/校徽排版）
        // 被管理控制台保存后，版本号都会前进，确保师生端标签页重新可见时一定重拉最新外观。
        const serverSchoolTs = data.updatedAt ? new Date(data.updatedAt).getTime() : 0
        const serverCustTs = (data.customization && data.customization.updated_at) ? new Date(data.customization.updated_at).getTime() : 0
        const serverTs = Math.max(serverSchoolTs, serverCustTs)
        const cachedSchoolTs = (cached && cached.updatedAt) ? new Date(cached.updatedAt).getTime() : 0
        const cachedCustTs = (cached && cached.customizationUpdatedAt) ? new Date(cached.customizationUpdatedAt).getTime() : 0
        const cachedTs = Math.max(cachedSchoolTs, cachedCustTs)
        if (serverTs && serverTs > cachedTs) {
            setSchoolInfo(schoolCode, {
                name: data.name || '',
                shortName: data.shortName || '',
                logoUrl: data.logoUrl || '',
                themeColor: data.themeColor || '',
                updatedAt: data.updatedAt || null,
                customizationUpdatedAt: (data.customization && data.customization.updated_at) || null,
            })
            return true
        }
        return false
    } catch (e) {
        return false
    }
}

/**
 * CR-06：跨标签页配置同步。
 * 同一 origin 下其它标签页改写该校 localStorage 缓存时会触发 storage 事件，
 * 本函数订阅该事件并回调最新 customization，使多标签页保持一致的模块可见性与定制。
 * 返回取消订阅函数。
 */
export function onSchoolConfigChanged(schoolCode, cb) {
    if (!schoolCode || typeof cb !== 'function') return () => {}
    const handler = (e) => {
        if (e.key !== KEY_PREFIX + schoolCode) return
        try {
            cb(getSchoolCustomization(schoolCode) || {})
        } catch (err) {
            console.error('❌ 跨标签页配置同步回调失败:', err)
        }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
}

/**
 * CR-06 / RK-品牌：学校外观信息（校徽 Logo / 校名 / 主题色）变更订阅。
 * 与 onSchoolConfigChanged 对称，但监听 `school_info_` 缓存键（基本信息维度）。
 * 兼容两种触发源：
 *   - 跨标签页：其它标签页（如管理控制台）改写 localStorage 后浏览器派发的 `storage` 事件；
 *   - 同标签页：管理控制台保存后派发的 `school:info-changed` CustomEvent（detail.schoolCode）。
 * 返回取消订阅函数。
 */
export function onSchoolInfoChanged(schoolCode, cb) {
    if (!schoolCode || typeof cb !== 'function') return () => {}
    const handler = (e) => {
        if (e.key !== INFO_KEY_PREFIX + schoolCode) return
        try {
            cb(getSchoolInfo(schoolCode) || {})
        } catch (err) {
            console.error('❌ 跨标签页学校外观同步回调失败:', err)
        }
    }
    const localHandler = (e) => {
        if (e.detail && e.detail.schoolCode === schoolCode) {
            try { cb(getSchoolInfo(schoolCode) || {}) } catch (err) { /* ignore */ }
        }
    }
    window.addEventListener('storage', handler)
    window.addEventListener('school:info-changed', localHandler)
    return () => {
        window.removeEventListener('storage', handler)
        window.removeEventListener('school:info-changed', localHandler)
    }
}

/**
 * 同标签页通知：管理控制台保存学校基本信息后调用，触发本标签页（如预览 iframe 宿主页）
 * 监听的 `school:info-changed` 事件，立即重应用品牌。跨标签页由 setSchoolInfo 写入
 * localStorage 自动派发 `storage` 事件覆盖。
 */
export function notifySchoolInfoChanged(schoolCode) {
    if (!schoolCode) return
    try {
        window.dispatchEvent(new CustomEvent('school:info-changed', { detail: { schoolCode } }))
    } catch (e) { /* ignore */ }
}
