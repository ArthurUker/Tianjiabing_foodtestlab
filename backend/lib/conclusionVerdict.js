// conclusionVerdict.js — 领域结论（合格 / 不合格 / 未知）的**唯一事实源**（RC-09a / AUD-025）
//
// 口径定稿（来源：phase2/FINAL_ARCHITECTURE_DECISIONS.md RC-09a + P3-W5-T01 设计口径）：
//   · 油脂（oil）按「品质等级」colorLevel 判定：
//       - 合法非空枚举仅 `合格 / 警戒 / 不合格`（业务方既有裁定，保留）；
//       - `合格`、`警戒` → pass（警戒计入合格）；
//       - `不合格`     → fail；
//       - **未知非空值 → unknown（不计入合格）**：不再回退 result —— 否则
//         `colorLevel='foo' + result='合格'` 仍会被计为合格，仍属 fail-open；
//       - 空值（''/null/缺失）→ **明确回退** result 文本规则。
//   · 病原体（pathogen）：riskLevel 非空 → 无风险=pass，其余=fail；空 → unknown（既有）。
//   · 餐具（tableware）：顶层 result 非空 → result 文本规则；为空 → tablewareVerdict 回退（既有，语义不得变化）。
//   · 其它类型：result 文本规则。
//   · 复检：有复检时初检=unknown（无独立初检快照不可逆推），最终取复检结论并标出冲突（既有语义）。
//
// 消费方（四个出口**必须同源**）：
//   ① 员工端内部统计  backend/routes/recordRoutes.js  → oilVerdictSql()
//   ② 访客端统计      backend/routes/guestRoutes.js   → oilVerdictSql()
//   ③ 对外明细/枚举   backend/lib/openApiScope.js     → normalizeConclusion()
//   ④ 前端看板        frontend/js/core/conclusionVerdict.js（同一规则的前端副本，改动必须两边同步）
//
// ⚠️ 本文件只做**结论归一**（把已保存的结论读出来 / 校验枚举），不按阈值重新判定、不改写历史数据。
import { tablewareVerdict } from './tablewareVerdict.js'

export const PASS = 'pass'
export const FAIL = 'fail'
export const WARN = 'warning'
export const UNKNOWN = 'unknown'

/** 食用油 colorLevel 权威枚举：仅「不合格」判不合格（业务裁定）；未识别值不得默认合格。 */
export const OIL_COLOR_PASS = new Set(['合格', '警戒'])
export const OIL_COLOR_FAIL = new Set(['不合格'])

/** colorLevel 的全部合法非空取值（写入侧校验用）。 */
export const OIL_COLOR_ALLOWED = new Set([...OIL_COLOR_PASS, ...OIL_COLOR_FAIL])

/** 判定文本 → 结论域（与既有派生语义一致）。 */
export function textToConclusion(text) {
    const s = String(text ?? '').trim()
    if (!s) return UNKNOWN
    if (s === '复检通过') return PASS
    if (s === '复检未通过') return FAIL
    if (s.includes('不合格')) return FAIL
    if (s.includes('警戒')) return WARN
    if (s.includes('合格')) return PASS
    return UNKNOWN
}

/**
 * 食用油单条记录的**等级判定**（colorLevel 维度的唯一实现；SQL 等价物见 oilVerdictSql）。
 * @returns {{level:'pass'|'fail'|'unknown', text:string, basis:'colorLevel'|'result'|'none'}}
 *   basis='colorLevel' → 由等级得出结论（含未知等级 → unknown，text=未识别原值）；
 *   basis='result'     → colorLevel 为空，按 result 文本规则；
 *   basis='none'       → colorLevel 与 result 都为空。
 */
export function oilVerdict(resultData) {
    const data = resultData && typeof resultData === 'object' ? resultData : {}
    const color = String(data.colorLevel ?? '').trim()
    if (color) {
        if (OIL_COLOR_PASS.has(color)) return { level: PASS, text: color, basis: 'colorLevel' }
        if (OIL_COLOR_FAIL.has(color)) return { level: FAIL, text: color, basis: 'colorLevel' }
        // 未知非空值：unknown，不回退 result（AUD-025 修复点；原实现等价于"非不合格即合格"或"回退 result"）
        return { level: UNKNOWN, text: color, basis: 'colorLevel' }
    }
    const text = String(data.result ?? '').trim()
    return { level: textToConclusion(text), text, basis: text ? 'result' : 'none' }
}

/** 单引号 SQL 字面量（值仅来自本文件常量集合，仍拒绝引号注入）。 */
function sqlLiteral(value) {
    const s = String(value)
    if (s.includes("'")) throw new Error(`colorVerdict: 非法枚举字面量 ${s}`)
    return `'${s}'`
}

/**
 * `oilVerdict()` 的 **SQL 等价物**（同一枚举常量生成，避免 JS/SQL 两套口径漂移）：
 *   合格/警戒 → TRUE；其余非空（含 不合格、未知值）→ FALSE；空 → result 文本规则。
 * 统计出口只关心"是否计为合格"，故 fail 与 unknown 同为 FALSE（区分只影响对外/前端枚举）。
 * @param {string} resultDataColumn 结果列表达式，默认 `"result_data"`（jsonb）；可带单层别名（如 `v.rd`）
 */
export function oilVerdictSql(resultDataColumn = '"result_data"') {
    const col = String(resultDataColumn)
    const IDENT = '(?:"[A-Za-z_][A-Za-z0-9_]*"|[a-z_][A-Za-z0-9_]*)'
    if (!new RegExp(`^${IDENT}(?:\\.${IDENT})?$`).test(col)) throw new Error(`colorVerdict: 非法列表达式 ${col}`)
    // btrim 与 JS 侧 String().trim() 对齐（否则仅两侧空白差异的等级会出现 JS/SQL 判定分叉）
    const color = `btrim(COALESCE(${col}->>'colorLevel',''))`
    const result = `COALESCE(${col}->>'result','')`
    const passList = [...OIL_COLOR_PASS].map(sqlLiteral).join(', ')
    return `(CASE
                WHEN ${color} IN (${passList}) THEN TRUE
                WHEN ${color} <> '' THEN FALSE
                ELSE (${result} LIKE '%合格%' AND ${result} NOT LIKE '%不合格%')
            END)`
}

/** 是否合法 colorLevel（空值视为"未提交"，合法）。 */
export function isAllowedColorLevel(value) {
    const s = String(value ?? '').trim()
    return s === '' || OIL_COLOR_ALLOWED.has(s)
}

/**
 * 写入侧校验：从提交载荷中收集非法 colorLevel（仅 oil 类型；空值合法）。
 * 覆盖位置：payload 顶层、sample_info、result_data 顶层（与写入归一的三处取值来源一致）。
 * @returns {string[]} 非法值清单（去重，保持原始文本）
 */
export function findInvalidColorLevels(testType, sources = {}) {
    if (testType !== 'oil') return []
    const bad = []
    for (const src of [sources.payload, sources.sampleInfo, sources.resultData]) {
        if (!src || typeof src !== 'object' || Array.isArray(src)) continue
        if (!Object.prototype.hasOwnProperty.call(src, 'colorLevel')) continue
        const raw = src.colorLevel
        if (raw === undefined || raw === null) continue
        const s = String(raw).trim()
        if (s === '' || OIL_COLOR_ALLOWED.has(s)) continue
        if (!bad.includes(s)) bad.push(s)
    }
    return bad
}

// TD-Recheck-Sync: 提取记录「最新一次复检是否通过」的结论（通用，与学校租户无关）。
// 兼容三种检测模块的复检数据结构：
//   - GenericTest（果蔬/油/肉蛋）: recheckRecords[0].isPassed
//   - Tableware（餐具）           : recheckRecords[0].isPassed（顶层，points 为点位明细）
//   - Pathogen（病原体）          : recheckReports[0].isPassed
// 无法判定（无复检 / 结构未知 / isPassed 非布尔）时返回 null，调用方据此跳过自愈。
// （自 recordNormalize.js 迁入本文件：结论相关辅助与判定同源；recordNormalize 仍按原签名再导出。）
export function getLatestRecheckPassed(resultData) {
    const recs = Array.isArray(resultData?.recheckRecords) ? resultData.recheckRecords : []
    if (recs.length > 0) {
        const latest = recs[0]
        if (latest && typeof latest.isPassed === 'boolean') return latest.isPassed
    }
    const reports = Array.isArray(resultData?.recheckReports) ? resultData.recheckReports : []
    if (reports.length > 0) {
        const latest = reports[0]
        if (latest && typeof latest.isPassed === 'boolean') return latest.isPassed
    }
    return null
}

/**
 * 由记录数据推导初检/最终结论（**唯一实现**；openApiScope.deriveConclusion 直接委派）。
 * - 无复检：按当前保存的 result/colorLevel/riskLevel 推导；
 * - 有复检：初检快照通常已被 Web 覆盖，初检标 unknown；最终优先取最新结构化 isPassed，
 *   缺失时回退可识别的 finalStatus，并标出冲突；
 * - is_positive：病原体优先按保存的 positiveDetails 判断检出。
 */
export function normalizeConclusion(testType, resultData) {
    const data = resultData && typeof resultData === 'object' ? resultData : {}
    let initial = UNKNOWN
    let text = ''

    if (testType === 'pathogen') {
        const risk = String(data.riskLevel ?? '').trim()
        initial = risk ? (risk === '无风险' ? PASS : FAIL) : UNKNOWN
        text = risk
    } else if (testType === 'oil') {
        const v = oilVerdict(data)
        initial = v.level
        text = v.text
    } else if (testType === 'tableware' && !String(data.result ?? '').trim()) {
        // 餐具：顶层 `result` 为空时回退点位结论（洗涤剂残留记录只写 `atpPoints[].res`，此前被判 unknown）。
        // 规则与统计 SQL 逐字同源：lib/tablewareVerdict.js；顶层有文本时仍走下面的既有逻辑，行为不变。
        const v = tablewareVerdict(data)
        text = v.text
        initial = v.level === 'pass' ? PASS : (v.level === 'fail' ? FAIL : (v.level === 'warn' ? WARN : UNKNOWN))
    } else {
        text = String(data.result ?? '').trim()
        initial = textToConclusion(text)
    }

    const finalStatus = String(data.finalStatus ?? '').trim()
    const recheckPassed = getLatestRecheckPassed(data)
    const hasRecheck = finalStatus !== ''
        || (Array.isArray(data.recheckRecords) && data.recheckRecords.length > 0)
        || (Array.isArray(data.recheckReports) && data.recheckReports.length > 0)
    let final = initial
    let basis = 'initial'
    const statusConclusion = textToConclusion(finalStatus)
    const conflict = hasRecheck && typeof recheckPassed === 'boolean'
        && statusConclusion !== UNKNOWN && statusConclusion !== (recheckPassed ? PASS : FAIL)
    if (hasRecheck) {
        // 现有 Web 写入会覆盖 result/riskLevel。没有单独保存的初检快照时不可逆推。
        initial = UNKNOWN
        final = typeof recheckPassed === 'boolean' ? (recheckPassed ? PASS : FAIL) : statusConclusion
        text = finalStatus || (typeof recheckPassed === 'boolean' ? (recheckPassed ? '复检通过' : '复检不通过') : '')
        basis = 'recheck'
    }

    const isPositive = testType === 'pathogen'
        ? (Array.isArray(data.positiveDetails)
            ? data.positiveDetails.length > 0
            : (String(data.riskLevel ?? '').trim() ? String(data.riskLevel).trim() !== '无风险' : null))
        : null

    return { initial, final, text: text || null, isPositive, basis, conflict }
}

export default {
    PASS,
    FAIL,
    WARN,
    UNKNOWN,
    OIL_COLOR_PASS,
    OIL_COLOR_FAIL,
    OIL_COLOR_ALLOWED,
    textToConclusion,
    oilVerdict,
    oilVerdictSql,
    isAllowedColorLevel,
    findInvalidColorLevels,
    getLatestRecheckPassed,
    normalizeConclusion,
}
