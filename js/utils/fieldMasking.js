/**
 * fieldMasking.js（BS-12 / DS-16）
 * 敏感字段脱敏工具：
 *   - maskSensitive(value, type)：按类型脱敏（phone/name/idcard/email/token）
 *   - detectSensitiveType(nameOrLabel)：按字段名/标签启发式判断敏感类型
 *   - markSensitiveFields(defs)：给自定义字段定义列表打 sensitiveType 标记
 *   - getSensitiveMarkedCustomFields(moduleCode)：读取当前校某模块自定义字段并标记敏感类型
 *     （这是 schoolCustomization.injectCustomFields 之外的独立"标记入口"，不改动其主体）
 *   - maskToken(token)：token 只保留前 6 位，用于日志输出（DS-16）
 *
 * 设计原则：纯函数、无 DOM 依赖（getSensitiveMarkedCustomFields 除外，仅读 localStorage 配置），
 * 便于在导出报表、详情展示、日志打印等任意位置复用。
 */

import { extractSchoolCode } from './schoolCode.js'
import { getSchoolCustomization, resolveCustomFields } from './schoolCustomization.js'

// 启发式关键词 → 敏感类型（按优先级排列，先命中先用）
const SENSITIVE_PATTERNS = [
    { type: 'phone', re: /手机|电话|联系方式|联系号码|phone|mobile|tel/i },
    { type: 'idcard', re: /身份证|证件号|idcard|id_card|identity/i },
    { type: 'email', re: /邮箱|电子邮件|email|e-mail/i },
    // "姓名"类：排除 username/用户名（登录名非 PII 主体，且需要可追溯）
    { type: 'name', re: /姓名|名字|真实姓名|fullname|full_name|realname|real_name|student.?name|(^|[^a-z])name([^a-z]|$)/i },
]

/**
 * 按字段名/标签启发式判断敏感类型。
 * @param {string} nameOrLabel 字段名或中文标签
 * @returns {'phone'|'idcard'|'email'|'name'|null}
 */
export function detectSensitiveType(nameOrLabel) {
    if (typeof nameOrLabel !== 'string' || !nameOrLabel) return null
    // 显式排除登录用户名类字段
    if (/username|用户名|账号|帐号/i.test(nameOrLabel)) return null
    for (const { type, re } of SENSITIVE_PATTERNS) {
        if (re.test(nameOrLabel)) return type
    }
    return null
}

/** 手机号脱敏：138****8000；非标准位数保留前 3 后 4（长度不足时全遮） */
function maskPhone(s) {
    const digits = s.replace(/\D/g, '')
    if (digits.length === 11) return digits.slice(0, 3) + '****' + digits.slice(7)
    if (s.length >= 8) return s.slice(0, 3) + '****' + s.slice(-4)
    if (s.length > 2) return s[0] + '*'.repeat(s.length - 2) + s.slice(-1)
    return '*'.repeat(s.length || 1)
}

/** 姓名脱敏：两字 → 张*；三字及以上 → 张*明（保留首尾） */
function maskName(s) {
    const chars = Array.from(s)
    if (chars.length <= 1) return '*'
    if (chars.length === 2) return chars[0] + '*'
    return chars[0] + '*'.repeat(chars.length - 2) + chars[chars.length - 1]
}

/** 身份证/证件号脱敏：保留前 4 后 4 */
function maskIdCard(s) {
    if (s.length <= 8) return '*'.repeat(s.length)
    return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4)
}

/** 邮箱脱敏：本地部分保留首字符 */
function maskEmail(s) {
    const at = s.indexOf('@')
    if (at <= 0) return maskGeneric(s)
    const local = s.slice(0, at)
    const masked = local[0] + '*'.repeat(Math.max(1, local.length - 1))
    return masked + s.slice(at)
}

/** 通用脱敏：保留首尾各 1 字符 */
function maskGeneric(s) {
    if (s.length <= 2) return '*'.repeat(s.length || 1)
    return s[0] + '*'.repeat(s.length - 2) + s.slice(-1)
}

/**
 * 按类型脱敏（BS-12 主入口）。
 * @param {*} value 原始值（非字符串会先 String()；null/undefined/'' 原样返回）
 * @param {'phone'|'name'|'idcard'|'email'|'token'|string} [type] 缺省时走通用脱敏
 * @returns {string|*}
 */
export function maskSensitive(value, type) {
    if (value === null || value === undefined || value === '') return value
    const s = String(value)
    switch (type) {
        case 'phone': return maskPhone(s)
        case 'name': return maskName(s)
        case 'idcard': return maskIdCard(s)
        case 'email': return maskEmail(s)
        case 'token': return maskToken(s)
        default: return maskGeneric(s)
    }
}

/**
 * token 脱敏（DS-16 日志用）：只显示前 6 位 + …，绝不输出完整令牌。
 * @param {string} token
 * @returns {string}
 */
export function maskToken(token) {
    if (typeof token !== 'string' || !token) return '(空)'
    return token.slice(0, 6) + '…'
}

/**
 * 给自定义字段定义列表打敏感标记：
 * def.sensitive === true / def.sensitiveType 显式声明优先，否则按 label/name 启发式。
 * 返回新数组，不修改入参（schoolCustomization 主体零侵入）。
 * @param {Array<Object>} defs [{name,label,type,...}]
 * @returns {Array<Object>} 带 sensitiveType（可能为 null）的副本
 */
export function markSensitiveFields(defs) {
    if (!Array.isArray(defs)) return []
    return defs.map((d) => {
        if (!d || typeof d !== 'object') return d
        const explicit = d.sensitiveType || (d.sensitive === true ? 'name' : null)
        const detected = detectSensitiveType(d.label) || detectSensitiveType(d.name)
        return { ...d, sensitiveType: explicit || detected || null }
    })
}

/**
 * 读取当前校某模块的自定义字段定义并标记敏感类型。
 * 供 ExportService 等展示/导出场景调用（BS-12）。
 * @param {string} moduleCode tableware/pesticide/oil/leanMeat/pathogen
 * @returns {Array<Object>} 标记后的字段定义（无配置/异常时返回 []）
 */
export function getSensitiveMarkedCustomFields(moduleCode) {
    try {
        const code = extractSchoolCode()
        if (!code || !moduleCode) return []
        const customization = getSchoolCustomization(code)
        return markSensitiveFields(resolveCustomFields(customization, moduleCode))
    } catch (e) {
        return []
    }
}

export default {
    maskSensitive,
    maskToken,
    detectSensitiveType,
    markSensitiveFields,
    getSensitiveMarkedCustomFields,
}
