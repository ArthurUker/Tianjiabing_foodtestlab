// ===== 通用清洗 / 工具函数（从 server.js 抽取，P1-5 拆路由 Step 1）=====
// 供 customizationValidate / recordNormalize 及各处路由复用。纯函数，无副作用。

// D-06: 递归剔除原型链污染键（__proto__ / constructor / prototype），深度上限 10。
// 所有解析用户提交 JSON（result_data / sample_info / 定制配置）的入口都必须过此函数。
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function sanitizeObjectKeys(value, depth = 0) {
    if (depth > 10 || value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(item => sanitizeObjectKeys(item, depth + 1))
    const clean = {}
    for (const key of Object.keys(value)) {
        if (DANGEROUS_KEYS.has(key)) continue
        clean[key] = sanitizeObjectKeys(value[key], depth + 1)
    }
    return clean
}

function safeParseJson(value, fallback) {
    if (!value) return fallback
    // P1-4: 兼容 Prisma Json 字段（model 读取返回对象，无需再 parse），
    // 同时保留对字符串（raw SQL $queryRawUnsafe 对 jsonb/text 列返回字符串）的 parse。
    if (typeof value === 'object') return value
    try {
        return JSON.parse(value)
    } catch {
        return fallback
    }
}

// NB-02: 统一错误响应辅助函数，生产环境不泄露内部细节
const clientErr = (msg) => ({ error: msg })

function jsonDepthOf(value, depth = 0) {
    if (depth > 8) return depth
    if (value === null || typeof value !== 'object') return depth
    let max = depth
    const items = Array.isArray(value) ? value : Object.values(value)
    for (const item of items) {
        const d = jsonDepthOf(item, depth + 1)
        if (d > max) max = d
    }
    return max
}

export {
    DANGEROUS_KEYS,
    sanitizeObjectKeys,
    safeParseJson,
    clientErr,
    jsonDepthOf,
}
