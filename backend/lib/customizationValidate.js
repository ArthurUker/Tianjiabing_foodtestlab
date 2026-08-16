// ===== 学校定制配置服务器端校验（从 server.js 抽取，P1-5 拆路由 Step 1）=====
import { sanitizeObjectKeys, jsonDepthOf, DANGEROUS_KEYS } from './sanitize.js'
import { isSafeLogoUrl } from './securityGuards.js'
import {
    TABLE_MANAGED_FIELDS,
} from './fieldOptionService.js'

// 防御性归一化：级联字段（testType/location 等）的选项由 FieldOption 表唯一管理，
// 返回给客户端前剔除 field_options 中的表管理字段键与历史 cascade 简化版残留，
// 避免录入端 fields.js 用文本数组覆盖 value/label 分离的下拉。
function sanitizeFieldOptionsForClient(fo) {
    // 兼容历史 JSON 字符串存储（text 列时期 / double-encode 脏数据）：parse → 清理 → stringify。
    // 迁移 Model API 后正常数据已是对象，此分支仅在历史脏数据时命中，加日志观测，延后清理。
    if (typeof fo === 'string') {
        try {
            console.warn('[customization] sanitizeFieldOptionsForClient 命中字符串兼容分支（历史脏数据），观测中')
            const parsed = JSON.parse(fo)
            return JSON.stringify(sanitizeFieldOptionsForClient(parsed))
        } catch (_) { return fo }
    }
    if (!fo || typeof fo !== 'object' || Array.isArray(fo)) return fo
    const out = { ...fo }
    delete out.cascade
    for (const fields of Object.values(TABLE_MANAGED_FIELDS)) {
        for (const f of fields) delete out[f]
    }
    return out
}

// ====== RK8/RK10/RK12: 学校定制配置服务器端校验 ======
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
const CUSTOM_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const TYPE_CODE_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
// 菜单项 code：camelCase（与 js/modules/registry.js 的 MENU_ITEMS 注册表对齐）
const MENU_CODE_RE = /^[a-z][a-zA-Z0-9]{0,63}$/
const CUSTOM_FIELD_TYPES = new Set(['text', 'number', 'date', 'select', 'textarea', 'checkbox'])
const MAX_JSON_FIELD_BYTES = 200 * 1024 // 单字段序列化后上限 200KB

// DS-09 核查结论（Logo SSRF）：后端从不抓取/下载 logoUrl —— 全仓无 fetch(logoUrl)/https.get(logoUrl)
// 等出站请求；logo_url 仅作为字符串校验后存库，由前端 <img src> 渲染。SSRF 风险 N/A。
// DS3-M4/DS3-M5: isSafeLogoUrl 已迁移至 lib/securityGuards.js（便于单测），并在原有
// MIME 前缀校验基础上追加 base64 魔数比对（PNG/JPEG/GIF/WebP），SVG 仍显式禁止（DS-12）；
// http(s) 外链支持可选 LOGO_ALLOWED_HOSTS 域名白名单（未配置时保持放行，已知限制：
// 外链 <img> 可被用作访客 IP 探测/追踪探针，见 securityGuards.js 内注释）。

// 校验单个 JSON 定制字段的通用约束（可解析性 / 体积 / 深度），返回错误信息或 null
function checkJsonField(name, value, expect /* 'object' | 'array' */) {
    if (value === undefined || value === null) return null
    let parsed = value
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value) } catch { return `${name} 不是合法 JSON` }
    }
    const serialized = JSON.stringify(parsed)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_FIELD_BYTES) return `${name} 超过 200KB 上限`
    if (jsonDepthOf(parsed) > 6) return `${name} 嵌套深度超过 6 层`
    if (expect === 'object' && (Array.isArray(parsed) || typeof parsed !== 'object')) return `${name} 必须是 JSON 对象`
    if (expect === 'array' && !Array.isArray(parsed)) return `${name} 必须是 JSON 数组`
    return parsed
}

// RK8/RK10/RK11/RK12/DS-12: 定制配置载荷校验。返回 { valid, errors, normalized }
function validateCustomizationPayload(body) {
    const errors = []
    const b = sanitizeObjectKeys(body || {})

    const spec = {
        visible_types: 'array',
        field_labels: 'object',
        hidden_fields: 'array',
        theme_config: 'object',
        field_rules: 'object',
        field_options: 'object',
        field_order: 'object',
        custom_fields: 'object',
        test_types: 'array',
        visible_menu_items: 'array',
        field_types: 'object'
    }
    const normalized = {}
    for (const [key, expect] of Object.entries(spec)) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) continue
        if (b[key] === null) { normalized[key] = null; continue } // BS-03: 显式 null = 清空
        const result = checkJsonField(key, b[key], expect)
        if (typeof result === 'string') { errors.push(result); continue }
        normalized[key] = result
    }

    // guest_enabled：布尔开关（非 JSON 列，单独校验；仅允许显式 boolean，不接受 null 清空）
    if (Object.prototype.hasOwnProperty.call(b, 'guest_enabled')) {
        if (typeof b.guest_enabled !== 'boolean') {
            errors.push('guest_enabled 必须为布尔值')
        } else {
            normalized.guest_enabled = b.guest_enabled
        }
    }

    // theme_config 内颜色值校验
    if (normalized.theme_config && typeof normalized.theme_config === 'object') {
        for (const [k, v] of Object.entries(normalized.theme_config)) {
            // 自定义系统标题（DS-TITLE）：独立强校验，不再依赖"未知 key 透传"
            if (k === 'systemTitle') {
                if (typeof v !== 'string') {
                    errors.push('theme_config.systemTitle 必须为字符串')
                    continue
                }
                const t = v.trim()
                if (t === '') {
                    // 空值（含纯空格）视为"未设置"，回落默认标题，不存储脏值
                    delete normalized.theme_config.systemTitle
                    continue
                }
                if (Array.from(t).length > 50) {
                    errors.push('theme_config.systemTitle 长度不能超过 50 个字符')
                    continue
                }
                if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(t)) {
                    errors.push('theme_config.systemTitle 不能包含控制字符或换行')
                    continue
                }
                normalized.theme_config.systemTitle = t  // 规整为 trim 后的字符串
                continue
            }
            if (/color/i.test(k) && typeof v === 'string' && v && !HEX_COLOR_RE.test(v)) {
                errors.push(`theme_config.${k} 必须为 #RRGGBB 格式`)
            }
            if (/logo/i.test(k) && typeof v === 'string' && v && !isSafeLogoUrl(v)) {
                errors.push(`theme_config.${k} 必须为 http(s) 或 data:image/(png|jpeg|gif|webp) URL（禁止 SVG）`)
            }
        }
        // 登录页样式（theme_config.login）独立校验：背景色/图片 URL 安全、卡片尺寸合理
        const ls = normalized.theme_config.login
        if (ls && typeof ls === 'object') {
            if (ls.background && typeof ls.background === 'object') {
                const bg = ls.background
                if (bg.color && typeof bg.color === 'string' && bg.color && !HEX_COLOR_RE.test(bg.color)) {
                    errors.push('theme_config.login.background.color 必须为 #RRGGBB 格式')
                }
                if (bg.imageUrl && typeof bg.imageUrl === 'string' && bg.imageUrl && !isSafeLogoUrl(bg.imageUrl)) {
                    errors.push('theme_config.login.background.imageUrl 必须为 http(s) 或 data:image/(png|jpeg|gif|webp) URL（禁止 SVG）')
                }
                if (bg.opacity !== undefined && (typeof bg.opacity !== 'number' || bg.opacity < 0 || bg.opacity > 1)) {
                    errors.push('theme_config.login.background.opacity 必须为 0~1 之间的数字')
                }
                if (bg.type !== undefined && !['aurora', 'solid', 'image', 'default'].includes(bg.type)) {
                    errors.push('theme_config.login.background.type 必须为 aurora/solid/image/default 之一')
                }
            }
            if (ls.card && typeof ls.card === 'object') {
                const card = ls.card
                if (card.width !== undefined && (typeof card.width !== 'number' || card.width < 280 || card.width > 720)) {
                    errors.push('theme_config.login.card.width 必须为 280~720 之间的数字（px）')
                }
                if (card.radius !== undefined && (typeof card.radius !== 'number' || card.radius < 0 || card.radius > 48)) {
                    errors.push('theme_config.login.card.radius 必须为 0~48 之间的数字（px）')
                }
                if (card.align !== undefined && !['left', 'center', 'right'].includes(card.align)) {
                    errors.push('theme_config.login.card.align 必须为 left/center/right 之一')
                }
            }
            if (ls.branding && typeof ls.branding === 'object') {
                const bd = ls.branding
                if (bd.title !== undefined && typeof bd.title !== 'string') errors.push('theme_config.login.branding.title 必须为字符串')
                if (bd.subtitle !== undefined && typeof bd.subtitle !== 'string') errors.push('theme_config.login.branding.subtitle 必须为字符串')
                if (bd.showLogo !== undefined && typeof bd.showLogo !== 'boolean') errors.push('theme_config.login.branding.showLogo 必须为布尔值')
                if (bd.logoUrl !== undefined && typeof bd.logoUrl !== 'string') errors.push('theme_config.login.branding.logoUrl 必须为字符串')
                if (bd.logoUrl && typeof bd.logoUrl === 'string' && !isSafeLogoUrl(bd.logoUrl)) {
                    errors.push('theme_config.login.branding.logoUrl 必须为 http(s) 或 data:image/(png|jpeg|gif|webp) URL（禁止 SVG）')
                }
            }
        }
    }

    // visible_types / test_types 元素合法性
    if (Array.isArray(normalized.visible_types)) {
        for (const t of normalized.visible_types) {
            if (typeof t !== 'string' || !TYPE_CODE_RE.test(t)) errors.push(`visible_types 含非法类型码: ${JSON.stringify(t)}`)
        }
    }
    // visible_menu_items 元素合法性（camelCase code，与 registry.js MENU_ITEMS 对齐）
    if (Array.isArray(normalized.visible_menu_items)) {
        for (const c of normalized.visible_menu_items) {
            if (typeof c !== 'string' || !MENU_CODE_RE.test(c)) errors.push(`visible_menu_items 含非法菜单码: ${JSON.stringify(c)}`)
        }
    }
    if (Array.isArray(normalized.test_types)) {
        const seen = new Set()
        for (const t of normalized.test_types) {
            if (!t || typeof t !== 'object' || typeof t.code !== 'string' || !TYPE_CODE_RE.test(t.code)) {
                errors.push('test_types 每项必须含合法 code（字母开头，字母/数字/_/-）')
                continue
            }
            if (seen.has(t.code)) errors.push(`test_types 类型码重复: ${t.code}`)
            seen.add(t.code)
            if (t.name !== undefined && (typeof t.name !== 'string' || t.name.length > 100)) errors.push(`test_types.${t.code}.name 需为 ≤100 字符的字符串`)
            if (t.fields !== undefined && !Array.isArray(t.fields)) errors.push(`test_types.${t.code}.fields 必须是数组`)
            if (Array.isArray(t.fields)) validateCustomFieldList(t.fields, `test_types.${t.code}.fields`, errors)
        }
    }

    // custom_fields: { 模块code: [字段定义...] }
    if (normalized.custom_fields && typeof normalized.custom_fields === 'object') {
        for (const [moduleCode, list] of Object.entries(normalized.custom_fields)) {
            if (!TYPE_CODE_RE.test(moduleCode)) { errors.push(`custom_fields 模块码非法: ${moduleCode}`); continue }
            if (!Array.isArray(list)) { errors.push(`custom_fields.${moduleCode} 必须是数组`); continue }
            validateCustomFieldList(list, `custom_fields.${moduleCode}`, errors)
        }
    }

    return { valid: errors.length === 0, errors, normalized }
}

// RK11: 自定义字段定义列表校验（name 白名单 / type 白名单 / 同域 name 唯一）
function validateCustomFieldList(list, ctx, errors) {
    const names = new Set()
    for (const f of list) {
        if (!f || typeof f !== 'object') { errors.push(`${ctx} 含非法字段定义`); continue }
        if (typeof f.name !== 'string' || !CUSTOM_FIELD_NAME_RE.test(f.name) || DANGEROUS_KEYS.has(f.name)) {
            errors.push(`${ctx} 字段名非法: ${JSON.stringify(f.name)}（须字母开头，≤64 位字母/数字/_）`)
            continue
        }
        if (names.has(f.name)) errors.push(`${ctx} 字段名重复: ${f.name}`)
        names.add(f.name)
        if (f.label !== undefined && (typeof f.label !== 'string' || f.label.length > 100)) errors.push(`${ctx}.${f.name}.label 需为 ≤100 字符字符串`)
        if (f.type !== undefined && !CUSTOM_FIELD_TYPES.has(f.type)) errors.push(`${ctx}.${f.name}.type 非法（允许: ${[...CUSTOM_FIELD_TYPES].join('/')}）`)
        if (f.options !== undefined && !Array.isArray(f.options)) errors.push(`${ctx}.${f.name}.options 必须是数组`)
    }
}

export {
    sanitizeFieldOptionsForClient,
    HEX_COLOR_RE,
    CUSTOM_FIELD_NAME_RE,
    TYPE_CODE_RE,
    MENU_CODE_RE,
    CUSTOM_FIELD_TYPES,
    MAX_JSON_FIELD_BYTES,
    checkJsonField,
    validateCustomizationPayload,
    validateCustomFieldList,
}
