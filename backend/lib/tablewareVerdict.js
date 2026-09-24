// tablewareVerdict.js — 餐具洁净度「记录级结论」的**单一判定规则**（2026-09-24 修复）
//
// 背景（线上真实缺陷）：洗涤剂残留（`testType='detergent'`）点位保存时**不写记录级 `result`**，
// 结论只落在 `atpPoints[].res`（如「合格 (≤0.1 mg/L)」）。而统计/列表分别只看顶层 `result` 与点位，
// 于是同一批数据出现两种结论：列表每行显示"合格"，看板却把 4 条洗涤剂残留记为不合格 →
// 餐具合格率 5/9 = 56%（实际应为 9/9 = 100%）。生产实测：school_zhsy 4 条、school_test 3 条属该形态。
//
// 本文件把规则收敛成**一处**：顶层有文本优先，为空才回退点位；点位口径 = 「最差点胜出」。
//   顶层 result 非空 → 含「合格」且不含「不合格」= 合格（既有口径，未变）
//   顶层为空 + 有点位 → 任一点含「不合格」= 不合格；所有点含「合格」= 合格；其余（含"警戒"/无结论）= 非合格(unknown)
//   顶层为空 + 无点位 → unknown（**不判合格**，也不会被当成"新的不合格"）
//
// ⚠️ 只做**结论聚合**（把已有结论读出来），不按阈值重新判定、不改写历史数据、不动任何阈值。
// 消费方：routes/recordRoutes.js（员工端统计）、routes/openApiRoutes.js（对外统计）、
//         lib/openApiScope.js（对外明细结论）、前端 Dashboard.isQualified（同一规则的手写副本，改动需同步）。

/** 记录级结论（用于统计与对外明细）。level ∈ pass | fail | warn | unknown。 */
export function tablewareVerdict(resultData) {
  const data = resultData && typeof resultData === 'object' ? resultData : {}
  const top = String(data.result ?? '').trim()
  if (top) {
    if (top.includes('不合格')) return { level: 'fail', text: top }
    if (top.includes('合格')) return { level: 'pass', text: top }
    if (top.includes('警戒')) return { level: 'warn', text: top }
    return { level: 'unknown', text: top }
  }
  const points = Array.isArray(data.atpPoints) ? data.atpPoints : []
  const resList = points.map((p) => String(p?.res ?? '').trim()).filter(Boolean)
  if (!resList.length) return { level: 'unknown', text: '' }
  const failed = resList.find((r) => r.includes('不合格'))
  if (failed) return { level: 'fail', text: failed }
  if (resList.every((r) => r.includes('合格'))) return { level: 'pass', text: resList[0] }
  const warn = resList.find((r) => r.includes('警戒'))
  if (warn) return { level: 'warn', text: warn }
  return { level: 'unknown', text: resList[0] }
}

/** 统计用：记录级结论是否为「合格」。 */
export function isTablewarePass(resultData) {
  return tablewareVerdict(resultData).level === 'pass'
}

/**
 * 写入侧自洽（2026-09-24 二阶段）：本次提交了点位、但记录级 `result` 为空时，
 * 按点位结论聚合**补写** `result`（最差点胜出）—— 让库内数据与看板/列表/对外接口同一口径，
 * 不再依赖读取侧兜底（读取侧兜底仍然保留，用于兜住历史数据）。
 *
 * 三条边界（避免"顺手改数据"）：
 *   ① 已有非空 `result` → **一律不动**（不覆盖录入/复检写入的文本）；
 *   ② 本次提交里没有点位（例如只改了食堂）→ **不补写**，不因一次无关编辑改动结果字段；
 *   ③ 点位无法得出结论（unknown）→ 不补写（保持空，读取侧按 unknown 处理）。
 *
 * @param {object} resultData 已归一（剔控制字段）的最终结果对象
 * @param {object|null} submitted 本次提交的结果对象（用于判断"是否提交了点位"）
 */
export function fillTablewareAggregate(resultData, submitted) {
  const rd = resultData && typeof resultData === 'object' ? resultData : null
  if (!rd) return resultData
  if (String(rd.result ?? '').trim()) return resultData
  const submittedPoints = Array.isArray(submitted?.atpPoints) ? submitted.atpPoints : null
  if (!submittedPoints || !submittedPoints.length) return resultData
  const v = tablewareVerdict(rd)
  if (v.level === 'unknown' || !v.text) return resultData
  return { ...rd, result: v.text }
}

/**
 * 统计用 SQL：餐具是否合格（与 `isTablewarePass` 同规则）。
 *
 * ⚠️ 片段内直接引用列名 `"result_data"`，只能用在 `TestRecord` 的查询里；
 * 目的是让 recordRoutes 与 openApiRoutes 两处 SQL **逐字同源**（此前两处各写一份，容易改一处漏一处）。
 */
export const TABLEWARE_PASS_SQL = `(CASE
  WHEN COALESCE("result_data"->>'result','') <> ''
    THEN (COALESCE("result_data"->>'result','') LIKE '%合格%' AND COALESCE("result_data"->>'result','') NOT LIKE '%不合格%')
  WHEN jsonb_typeof("result_data"->'atpPoints') = 'array' AND jsonb_array_length("result_data"->'atpPoints') > 0
    THEN NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements("result_data"->'atpPoints') e
       WHERE COALESCE(e->>'res','') NOT LIKE '%合格%' OR COALESCE(e->>'res','') LIKE '%不合格%'
    )
  ELSE FALSE
END)`
