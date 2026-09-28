/**
 * P3-W5-T01 · 结论判定矩阵 × 四出口同源回归（AUD-025 / RC-09a）—— 纯单元，不需要数据库
 *
 * 覆盖任务包验收 ①：
 *   判定矩阵（合法三值 / 未知非空 / 空值回退 / result 冲突）× 四出口（内部统计 / 访客统计 / OpenAPI / 前端）
 *   同一输入必须得到同一结论；未识别非空 colorLevel **一律 unknown/不计合格**。
 * 覆盖任务包验收 ④（写入侧）：
 *   未知 colorLevel 经写入校验被拒（不再静默放行）；合法值与空值放行；非 oil 类型不受影响。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  oilVerdict, normalizeConclusion, oilVerdictSql, textToConclusion,
  OIL_COLOR_PASS, OIL_COLOR_FAIL, findInvalidColorLevels,
} from '../../lib/conclusionVerdict.js'
import { deriveConclusion } from '../../lib/openApiScope.js'
import { validateRecordPayload, getLatestRecheckPassed } from '../../lib/recordNormalize.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(here, '..', '..')
const repoRoot = path.resolve(backendDir, '..')
const readSrc = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8')

/* ───────────── ① 判定矩阵（后端唯一事实源） ───────────── */

const MATRIX = [
  // [colorLevel, result, 期望 level, 说明]
  ['合格', '', 'pass', '合法值：合格计入合格'],
  ['警戒', '', 'pass', '合法值：警戒计入合格（既有裁定，保留）'],
  ['不合格', '', 'fail', '合法值：不合格'],
  ['深绿色', '', 'unknown', '未知非空值 → unknown'],
  ['foo', '', 'unknown', '脏值 → unknown'],
  ['foo', '不合格', 'unknown', '⚠ AUD-025 原缺陷：未知值 + result 不合格 曾被判合格（NOT LIKE 分支）'],
  ['深绿色', '合格', 'unknown', '未知非空值不回退 result（否则仍为 fail-open）'],
  ['', '合格', 'pass', '空等级才回退 result 规则'],
  ['', '不合格', 'fail', '空等级回退 result：不合格'],
  ['', '', 'unknown', '两者都空 → unknown'],
  ['   ', '合格', 'pass', '空白串按空值处理（trim 后回退 result）'],
  [null, '合格', 'pass', 'null 按空值处理'],
  ['合格', '不合格', 'pass', 'result 冲突：等级优先（警戒/合格口径不变）'],
  ['不合格', '合格', 'fail', 'result 冲突：等级优先'],
]

test('判定矩阵：oil 等级规则逐条成立', () => {
  for (const [colorLevel, result, expected, why] of MATRIX) {
    const payload = {}
    if (colorLevel !== null) payload.colorLevel = colorLevel
    if (result !== '') payload.result = result
    assert.equal(oilVerdict(payload).level, expected, `${why}（colorLevel=${JSON.stringify(colorLevel)}, result=${JSON.stringify(result)}）`)
  }
})

test('判定矩阵：未知等级时 text 保留原值（可诊断，不静默丢数据）', () => {
  const v = oilVerdict({ colorLevel: '深绿色', result: '合格' })
  assert.equal(v.text, '深绿色')
  assert.equal(v.basis, 'colorLevel')
})

/* ───────────── ② 四出口同源（同一输入 → 同一结论） ───────────── */

const SAMPLE_INPUTS = MATRIX.map(([colorLevel, result]) => {
  const payload = {}
  if (colorLevel !== null) payload.colorLevel = colorLevel
  if (result !== '') payload.result = result
  return payload
})

test('出口③ OpenAPI：deriveConclusion 与唯一事实源同结论', () => {
  for (const input of SAMPLE_INPUTS) {
    const viaScope = deriveConclusion('oil', input)
    const viaSource = normalizeConclusion('oil', input)
    assert.deepEqual(viaScope, viaSource, `OpenAPI 出口与事实源分叉：${JSON.stringify(input)}`)
  }
})

test('出口④ 前端看板：frontend/js/core/conclusionVerdict.js 与后端同结论', async () => {
  const front = await import(path.join(repoRoot, 'frontend/js/core/conclusionVerdict.js'))
  for (const input of SAMPLE_INPUTS) {
    const back = normalizeConclusion('oil', input)
    const frontV = front.normalizeConclusion('oil', input)
    assert.equal(frontV.level, back.initial, `前端出口与后端分叉：${JSON.stringify(input)}`)
    assert.equal(front.isOilPass(input), back.initial === 'pass', `前端合格判定与后端分叉：${JSON.stringify(input)}`)
  }
  // 前端与后端枚举必须一致（防止两侧各自新增等级）
  assert.deepEqual([...front.OIL_COLOR_PASS].sort(), [...OIL_COLOR_PASS].sort())
  assert.deepEqual([...front.OIL_COLOR_FAIL].sort(), [...OIL_COLOR_FAIL].sort())
})

test('出口①② 统计 SQL：两处路由都消费同一 SQL 等价物，且旧 fail-open 片段已消失', () => {
  const recordRoutes = readSrc('backend/routes/recordRoutes.js')
  const guestRoutes = readSrc('backend/routes/guestRoutes.js')
  for (const [name, src] of [['recordRoutes', recordRoutes], ['guestRoutes', guestRoutes]]) {
    assert.ok(src.includes("import { oilVerdictSql } from '../lib/conclusionVerdict.js'"), `${name} 未从唯一事实源导入 SQL 等价物`)
    assert.ok(src.includes('${oilVerdictSql()}'), `${name} 未使用共享 SQL 等价物`)
    assert.ok(!/colorLevel'\)\s*NOT LIKE '%不合格%'/.test(src), `${name} 仍残留 NOT LIKE '%不合格%' 的 fail-open 油judge分支`)
    assert.ok(!/colorLevel'\)\s*<>\s*''/.test(src), `${name} 仍残留"非空即判定"的旧分支`)
  }
})

test('SQL 等价物：由同一枚举常量生成，且语义与 JS 规则一致（静态形状）', () => {
  const sql = oilVerdictSql()
  for (const v of OIL_COLOR_PASS) assert.ok(sql.includes(`'${v}'`), `SQL 未包含合法合格枚举 ${v}`)
  assert.ok(sql.includes(`IN ('合格', '警戒')`), '合法合格类必须是显式枚举，不得用 NOT LIKE 反向推断')
  assert.ok(sql.includes("<> ''"), '必须有"非空但不在枚举内 → 不计合格"的分支')
  const colorPart = sql.slice(0, sql.indexOf('ELSE'))
  assert.ok(!/LIKE/.test(colorPart), '等级分支不得使用 LIKE（只有空值回退分支才允许 result 文本 LIKE）')
  assert.ok(sql.slice(sql.indexOf('ELSE')).includes("LIKE '%合格%'"), '空值分支应回退 result 文本规则')
  assert.ok(!/colorLevel'\)\s*NOT LIKE/.test(sql), '不得残留 fail-open 的 NOT LIKE 等级分支')
})

/* ───────────── ③ 写入侧（验收 ④ 的一半：不再静默放行） ───────────── */

test('写入校验：未知非空 colorLevel 被拒；合法值/空值/非 oil 类型放行', () => {
  const base = { testDate: '2026-01-01', canteen: '一食堂', inspector: '张三' }
  for (const bad of ['foo', '深绿色', '合格x', '未知等级', '100']) {
    const res = validateRecordPayload('oil', { ...base, colorLevel: bad })
    assert.equal(res.valid, false, `未识别等级应被拒：${bad}`)
    assert.match(res.errors.join(' '), /colorLevel/)
  }
  assert.equal(validateRecordPayload('oil', { ...base, colorLevel: '合格 ' }).valid, true, '两侧空白按合法值（读侧 trim 后枚举命中）')
  assert.equal(validateRecordPayload('oil', { ...base, colorLevel: ' 不合格 ' }).valid, true)
  assert.equal(validateRecordPayload('oil', { ...base, colorLevel: '合格' }).valid, true)
  assert.equal(validateRecordPayload('oil', { ...base, colorLevel: '警戒' }).valid, true)
  assert.equal(validateRecordPayload('oil', { ...base, colorLevel: '不合格' }).valid, true)
  assert.equal(validateRecordPayload('oil', { ...base, colorLevel: '' }).valid, true, '空值=未提交，放行并由读侧回退 result')
  assert.equal(validateRecordPayload('oil', { ...base }).valid, true, '未提交 colorLevel 放行')
  // 嵌套位置（result_data）同样校验
  assert.equal(validateRecordPayload('oil', { ...base, result_data: { colorLevel: 'foo' } }).valid, false)
  // 非 oil 类型不受影响
  assert.equal(validateRecordPayload('pesticide', { ...base, colorLevel: 'foo' }).valid, true)
  assert.equal(validateRecordPayload('tableware', { ...base, colorLevel: '深绿色' }).valid, true)
  // 溯源：非法值清单可直接调用（供其它写入口复用）
  assert.deepEqual(findInvalidColorLevels('oil', { payload: { colorLevel: 'foo' } }), ['foo'])
  assert.deepEqual(findInvalidColorLevels('oil', { payload: { colorLevel: '  ' } }), [])
})

test('导出面：getLatestRecheckPassed 仍按原签名可用（迁移到事实源后兼容）', () => {
  assert.equal(getLatestRecheckPassed({ recheckRecords: [{ isPassed: true }] }), true)
  assert.equal(getLatestRecheckPassed({ recheckReports: [{ isPassed: false }] }), false)
  assert.equal(getLatestRecheckPassed({}), null)
})

/* ───────────── ④ 与既有 P1 修复的边界（不回归其它类型） ───────────── */

test('非 oil 类型结论不回归：pathogen / tableware / 通用 result 规则保持既有语义', () => {
  assert.equal(normalizeConclusion('pathogen', { riskLevel: '无风险' }).initial, 'pass')
  assert.equal(normalizeConclusion('pathogen', { riskLevel: '低风险' }).initial, 'fail')
  assert.equal(normalizeConclusion('pathogen', {}).initial, 'unknown')
  assert.equal(normalizeConclusion('tableware', { result: '合格 (<200)' }).initial, 'pass')
  assert.equal(normalizeConclusion('tableware', { result: '警戒' }).final, 'warning')
  // 餐具：顶层 result 为空 → 回退点位结论（既有规则，不得变化）
  assert.equal(normalizeConclusion('tableware', { result: '', atpPoints: [{ res: '不合格 (0.9)' }] }).initial, 'fail')
  assert.equal(normalizeConclusion('tableware', { result: '', atpPoints: [{ res: '合格' }] }).initial, 'pass')
  assert.equal(normalizeConclusion('pesticide', { result: '合格' }).initial, 'pass')
  assert.equal(normalizeConclusion('pesticide', { result: '检测异常' }).initial, 'unknown')
  assert.equal(textToConclusion('复检未通过'), 'fail')
})
