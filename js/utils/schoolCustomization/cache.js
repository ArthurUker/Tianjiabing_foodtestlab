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

/**
 * 兜底：若 localStorage 无该校 customization（用户直接打开 index.html，未经 login.html 写入缓存），
 * 则调用公开端点拉取并缓存，保证按校差异化始终生效。
 * @param {string} schoolCode
 * @returns {Promise<Object>} customization（可能为 {}）
 */
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
