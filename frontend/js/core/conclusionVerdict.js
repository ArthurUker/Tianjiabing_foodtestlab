/**
 * conclusionVerdict.js — 前端「结论归一」的共享实现（P3-W5-T01，AUD-025 / RC-09a）
 *
 * ⚠️ 与后端唯一事实源 `backend/lib/conclusionVerdict.js` 是**同一口径的前端副本**：
 *   两边任一改动必须同步（后端另有 SQL 等价物 `oilVerdictSql()`，由同一枚举常量生成）。
 *
 * 食用油（oil）口径：
 *   · colorLevel ∈ {合格, 警戒} → pass（警戒计入合格，既有业务裁定）；
 *   · colorLevel = 不合格       → fail；
 *   · colorLevel 为**未识别的非空值** → unknown（**不计入合格**，不回退 result）；
 *   · colorLevel 空（''/null/缺失）→ 回退 result 文本规则。
 * 其它类型：按 result 文本映射（pass/fail/warning/unknown），与既有前端判定一致。
 */

export const LEVEL = { PASS: 'pass', FAIL: 'fail', WARN: 'warning', UNKNOWN: 'unknown' }

export const OIL_COLOR_PASS = new Set(['合格', '警戒'])
export const OIL_COLOR_FAIL = new Set(['不合格'])
export const OIL_COLOR_ALLOWED = new Set([...OIL_COLOR_PASS, ...OIL_COLOR_FAIL])

/** 判定文本 → 结论域（与后端 textToConclusion 逐字一致）。 */
export function textToConclusion(text) {
    const s = String(text ?? '').trim()
    if (!s) return LEVEL.UNKNOWN
    if (s === '复检通过') return LEVEL.PASS
    if (s === '复检未通过') return LEVEL.FAIL
    if (s.includes('不合格')) return LEVEL.FAIL
    if (s.includes('警戒')) return LEVEL.WARN
    if (s.includes('合格')) return LEVEL.PASS
    return LEVEL.UNKNOWN
}

/**
 * 食用油单条记录判定（前端唯一实现）。
 * @returns {{level:'pass'|'fail'|'unknown', text:string, basis:'colorLevel'|'result'|'none'}}
 */
export function oilVerdict(record) {
    const r = record && typeof record === 'object' ? record : {}
    const color = String(r.colorLevel ?? '').trim()
    if (color) {
        if (OIL_COLOR_PASS.has(color)) return { level: LEVEL.PASS, text: color, basis: 'colorLevel' }
        if (OIL_COLOR_FAIL.has(color)) return { level: LEVEL.FAIL, text: color, basis: 'colorLevel' }
        // 未识别等级：unknown（旧实现 `!color.includes('不合格')` 会把它当成合格 → fail-open）
        return { level: LEVEL.UNKNOWN, text: color, basis: 'colorLevel' }
    }
    const result = String(r.result ?? '').trim()
    return { level: textToConclusion(result), text: result, basis: result ? 'result' : 'none' }
}

/** 结论归一（前端出口统一入口；oil 走等级规则，其余走 result 文本规则）。 */
export function normalizeConclusion(testType, record) {
    if (testType === 'oil') return oilVerdict(record)
    const result = String((record && record.result) ?? '').trim()
    return { level: textToConclusion(result), text: result, basis: result ? 'result' : 'none' }
}

/** 是否计为合格（仅 pass；未知/警戒/不合格均不计）。 */
export function isOilPass(record) {
    return oilVerdict(record).level === LEVEL.PASS
}

export function oilLevelOf(record) {
    return oilVerdict(record).level
}

/** 是否合法 colorLevel（空值视为"未提交"，合法）。 */
export function isAllowedColorLevel(value) {
    const s = String(value ?? '').trim()
    return s === '' || OIL_COLOR_ALLOWED.has(s)
}

export default {
    LEVEL,
    OIL_COLOR_PASS,
    OIL_COLOR_FAIL,
    OIL_COLOR_ALLOWED,
    textToConclusion,
    oilVerdict,
    normalizeConclusion,
    isOilPass,
    oilLevelOf,
    isAllowedColorLevel,
}
