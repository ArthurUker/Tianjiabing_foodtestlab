// 餐具「记录级结论」与肉蛋品种归类回归（2026-09-24 线上合格率修复）
//
// 背景：洗涤剂残留（testType='detergent'）保存时不写记录级 `result`，结论只在 `atpPoints[].res`；
// 统计与明细只看顶层 `result` → 同一批数据出现两种结论（列表显示合格、看板算不合格）。
// 生产实测 school_zhsy 餐具 5/9=56%（实际 9/9=100%）；school_test 3 条同形态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { tablewareVerdict, isTablewarePass, TABLEWARE_PASS_SQL } from '../../lib/tablewareVerdict.js'
import { MEAT_CARD_KEYS, normalizeMeatKey } from '../../lib/leanMeatCategory.js'
import { deriveConclusion } from '../../lib/openApiScope.js'

test('餐具判定：顶层 result 有文本时沿用既有口径（含合格且不含不合格才合格）', () => {
  assert.equal(tablewareVerdict({ result: '合格 (<200)' }).level, 'pass')
  assert.equal(tablewareVerdict({ result: '不合格 (>500)' }).level, 'fail')
  assert.equal(tablewareVerdict({ result: '警戒 (200-500)' }).level, 'warn')
  assert.equal(tablewareVerdict({ result: '待复核' }).level, 'unknown')
  // "不合格" 优先于 "合格"（文本里同时出现时以不合格为准）
  assert.equal(tablewareVerdict({ result: '合格但抽检不合格' }).level, 'fail')
})

test('餐具判定：顶层 result 为空时回退点位结论（本次修复的核心）', () => {
  assert.equal(tablewareVerdict({ result: '', atpPoints: [{ res: '合格 (≤0.1 mg/L)' }] }).level, 'pass')
  assert.equal(tablewareVerdict({ atpPoints: [{ res: '合格 (<200)' }, { res: '合格 (≤0.1 mg/L)' }] }).level, 'pass')
  assert.equal(tablewareVerdict({ atpPoints: [{ res: '合格 (<200)' }, { res: '不合格 (>0.1 mg/L)' }] }).level, 'fail', '任一点不合格 → 记录不合格')
  assert.equal(tablewareVerdict({ atpPoints: [{ res: '合格 (<200)' }, { res: '警戒 (200-500)' }] }).level, 'warn', '混合警戒 → 非合格但保留警戒语义')
  assert.equal(tablewareVerdict({ atpPoints: [{ res: '' }] }).level, 'unknown', '点位无结论 → 不判合格')
  assert.equal(tablewareVerdict({}).level, 'unknown', '无 result 也无点位 → unknown（不会被当成"新的不合格"）')
  assert.equal(tablewareVerdict({ atpPoints: 'not-an-array' }).level, 'unknown', '脏数据不抛错')
})

test('餐具判定：isTablewarePass 与统计口径一致（仅 pass 计合格）', () => {
  assert.equal(isTablewarePass({ atpPoints: [{ res: '合格 (≤0.1 mg/L)' }] }), true)
  assert.equal(isTablewarePass({ atpPoints: [{ res: '警戒 (200-500)' }] }), false)
  assert.equal(isTablewarePass({ result: '不合格 (>0.1 mg/L)' }), false)
  assert.equal(isTablewarePass({}), false)
})

test('对外明细：餐具 result 为空时结论取点位（此前恒为 unknown）', () => {
  const before = deriveConclusion('tableware', { result: '', atpPoints: [{ res: '合格 (≤0.1 mg/L)' }] })
  assert.equal(before.initial, 'pass')
  const fail = deriveConclusion('tableware', { atpPoints: [{ res: '不合格 (>0.1 mg/L)' }] })
  assert.equal(fail.initial, 'fail')
  // 顶层有文本时行为不变（含复检文本的既有解析不受影响）
  assert.equal(deriveConclusion('tableware', { result: '合格 (<200)' }).initial, 'pass')
  assert.equal(deriveConclusion('tableware', { result: '合格 (<200)', finalStatus: '整改后复检合格', recheckRecords: [{ isPassed: true }] }).initial, 'unknown', '有复检 → 初检仍为 unknown（语义未变）')
})

test('统计 SQL 片段与 JS 规则同源（顶层优先 + 点位回退 + 无结论为否）', () => {
  assert.match(TABLEWARE_PASS_SQL, /"result_data"->>'result'/)
  assert.match(TABLEWARE_PASS_SQL, /atpPoints/)
  assert.match(TABLEWARE_PASS_SQL, /jsonb_array_elements/)
  assert.match(TABLEWARE_PASS_SQL, /NOT LIKE '%不合格%'/)
  assert.match(TABLEWARE_PASS_SQL, /ELSE FALSE/)
})

test('肉蛋品种归类：鱼、虾 归入鱼肉；禽蛋不被"禽"抢走；未知返回 null', () => {
  assert.deepEqual(MEAT_CARD_KEYS, ['猪肉', '羊肉', '牛肉', '禽肉', '鱼肉', '禽蛋'])
  assert.equal(normalizeMeatKey('猪肉'), '猪肉')
  assert.equal(normalizeMeatKey('牛肉'), '牛肉')
  assert.equal(normalizeMeatKey('羊肉'), '羊肉')
  assert.equal(normalizeMeatKey('禽肉'), '禽肉')
  assert.equal(normalizeMeatKey('鸡肉'), '禽肉', '同义写法归入禽肉')
  assert.equal(normalizeMeatKey('禽蛋'), '禽蛋', '必须先判"蛋"')
  assert.equal(normalizeMeatKey('鸡蛋'), '禽蛋')
  assert.equal(normalizeMeatKey('鱼肉'), '鱼肉')
  assert.equal(normalizeMeatKey('鱼、虾'), '鱼肉', '本次修复：此前不落入任何卡片')
  assert.equal(normalizeMeatKey('虾'), '鱼肉')
  assert.equal(normalizeMeatKey(''), null)
  assert.equal(normalizeMeatKey(null), null)
  assert.equal(normalizeMeatKey('其它'), null, '无法归类的不硬塞卡片')
})
