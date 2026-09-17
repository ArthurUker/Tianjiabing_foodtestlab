// contract.test.mjs — 开放接口契约的自动化测试（纯函数层，无需数据库）
//
// 运行：cd backend && node --test tests/openapi/
// 说明：本文件覆盖「字段字典 / 合成样例 / 结论口径 / 字段投影 / 游标 / 指纹与摘要」六类纯逻辑；
//      涉及 SQL 时间比较与分页正确性的部分见 db-readonly-checks.mjs（需真实库，只读）。
//      注意：仓库未安装 jest（根目录无 node_modules），故使用 Node 内置 test runner，零依赖。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPEN_API_CONTRACT_VERSION,
  listFieldDescriptors,
  buildSyntheticSamples,
  allowedResultKeys,
} from '../../lib/openApiFieldSchema.js'

import {
  deriveConclusion,
  projectResultData,
  buildOpenRecord,
  encodeCursor,
  decodeCursor,
  computeFiltersFingerprint,
  computeProjectionFingerprint,
  computeManifestDigest,
  resolveGrantTypes,
} from '../../lib/openApiScope.js'

const GRANT = {
  visible_types: ['tableware', 'pesticide', 'oil', 'leanMeat'],
  include_pathogen: false,
  include_inspector: false,
  include_attachments: false,
  start_date: null,
  end_date: null,
  scope_version: 3,
}
const CTX = { schoolCode: 'test', schoolName: '测试学校' }

/* ───────────── 1. 字段字典 ───────────── */

test('字段字典：包含公共字段与类型字段，且 inspector 标注为条件字段', () => {
  const fields = listFieldDescriptors('tableware')
  const paths = fields.map((f) => f.path)
  for (const p of ['record_code', 'school_code', 'test_date', 'conclusion', 'updated_at', 'result']) {
    assert.ok(paths.includes(p), `缺少公共字段 ${p}`)
  }
  const inspector = fields.find((f) => f.path === 'inspector')
  assert.ok(inspector, '缺少 inspector 条目（回归：曾被漏掉）')
  assert.equal(inspector.conditional, true)
  assert.equal(inspector.conditional_on, 'include_inspector')
  assert.ok(paths.includes('result.recheckRecords'), '缺少复检路径')
  assert.ok(paths.includes('result.rluValue'), '缺少餐具 RLU 字段')
  assert.equal(fields.find((f) => f.path === 'result.rluValue').type, 'string', 'RLU 实测为字符串类型')
})

test('字段字典：上下文同义副本标注正确（result.canteen/testDate 历史副本、result.inspector 恒不下发）', () => {
  const fields = listFieldDescriptors('tableware')
  const canteen = fields.find((f) => f.path === 'result.canteen')
  const testDate = fields.find((f) => f.path === 'result.testDate')
  const redundantInspector = fields.find((f) => f.path === 'result.inspector')
  assert.ok(canteen && testDate && redundantInspector, '缺少上下文同义副本条目')
  assert.ok(String(canteen.description).includes('以顶层为准'), 'canteen 副本必须写明以顶层为准')
  assert.ok(String(canteen.description).includes('历史'), 'canteen 副本必须标注仅历史数据')
  assert.ok(String(testDate.description).includes('以顶层为准'), 'testDate 副本必须写明以顶层为准')
  assert.equal(redundantInspector.emitted, false, 'result.inspector 恒不下发，必须标注 emitted=false')
  assert.equal(redundantInspector.conditional, undefined,
    'result.inspector 不得标为条件字段：它任何时候都不下发，与顶层 inspector（受 include_inspector 控制）语义不同')
  assert.ok(String(redundantInspector.description).includes('不会出现'), 'result.inspector 说明必须写明不会出现在响应中')
})

test('字段字典：每种开放类型都能给出字段清单；复检结构按**写入路径**登记（F7 修正旧断言）', () => {
  for (const t of ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen']) {
    assert.ok(listFieldDescriptors(t).length > 10, `${t} 字段过少`)
  }
  // ⚠️ 2026-09-17 审阅 F7：旧断言要求"果蔬不得有 result.recheckRecords"，依据是"实测样本里没有"。
  // 但写入路径（frontend/js/modules/GenericTest.js:549-550）对油/果蔬/肉蛋**都会写** record.recheckRecords
  // —— 数据观察不能证明字段不存在；白名单按旧字典剔除该键，会造成"复检证据丢失、结论却来自复检"的自相矛盾。
  for (const t of ['tableware', 'pesticide', 'oil', 'leanMeat']) {
    assert.ok(listFieldDescriptors(t).some((f) => f.path === 'result.recheckRecords'),
      `${t} 必须登记 result.recheckRecords（GenericTest/餐具写入路径均支持）`)
  }
  assert.ok(listFieldDescriptors('pathogen').some((f) => f.path === 'result.recheckReports'), '病原体应有复检报告字段')
})

test('字段字典：学校自定义字段以 school_custom 来源追加，且不重复已有路径', () => {
  const fields = listFieldDescriptors('pesticide', {
    customFieldNames: ['myField', 'result'],
    fieldLabels: { myField: '我的自定义字段' },
  })
  const custom = fields.filter((f) => f.source === 'school_custom')
  assert.equal(custom.length, 1, '应只追加未重复的自定义字段')
  assert.equal(custom[0].path, 'result.myField')
  assert.equal(custom[0].label, '我的自定义字段')
  assert.equal(custom[0].type, 'unknown', '无法确定类型时必须标注 unknown 而非编造')
})

/* ───────────── 2. 合成样例 ───────────── */

test('合成样例：形态与真实响应一致、带 SAMPLE 前缀、且不含被撤回字段', () => {
  const samples = buildSyntheticSamples('tableware')
  assert.ok(samples.length >= 3)
  const item = buildOpenRecord(samples.find((s) => s.scenario === 'recheck_passed').record, GRANT, CTX)
  assert.ok(item.record_code.startsWith('SAMPLE-'))
  assert.equal('inspector' in item, false, '关闭检测人后样例不得含姓名')
  assert.ok(!JSON.stringify(item).includes('示例姓名'), '样例中不得残留姓名（含嵌套）')
  assert.ok(Array.isArray(item.result.recheckRecords), '复检样例应保留复检明细')
  assert.equal('canteen' in item.result, false, '样例 result 不应再带上下文同义副本（须与新记录形态一致）')
  assert.equal('testDate' in item.result, false)
  assert.equal(item.canteen, '示例食堂', '顶层 canteen 仍应由 sample_info 展开')
  assert.equal(item.final_conclusion, 'pass')
  assert.equal(item.final_conclusion_basis, 'recheck')
})

test('合成样例：合格/不合格/复检场景齐备，且不适用的类型不产出复检样例', () => {
  const tw = buildSyntheticSamples('tableware').map((s) => s.scenario)
  assert.deepEqual(tw.sort(), ['fail', 'pass', 'recheck_passed', 'sparse'])
  const pest = buildSyntheticSamples('pesticide').map((s) => s.scenario)
  assert.ok(!pest.some((s) => s.includes('recheck')), '果蔬未使用复检结构，不得编造')
  const pa = buildSyntheticSamples('pathogen').map((s) => s.scenario)
  assert.ok(pa.includes('recheck_passed'))
  assert.deepEqual(buildSyntheticSamples('unknownType'), [])
})

test('合成样例：开启检测人时使用明显的虚构姓名', () => {
  const grant = { ...GRANT, include_inspector: true }
  const samples = buildSyntheticSamples('oil')
  const item = buildOpenRecord(samples[0].record, grant, CTX)
  assert.ok(item.inspector && item.inspector.includes('示例'), '应为明显虚构姓名')
})

/* ───────────── 3. 结论口径 ───────────── */

test('结论口径：初检/最终与 basis 区分正确', () => {
  assert.deepEqual(deriveConclusion('tableware', { result: '合格 (<200)' }), {
    initial: 'pass', final: 'pass', text: '合格 (<200)', isPositive: null, basis: 'initial',
  })
  const recheck = deriveConclusion('tableware', {
    result: '不合格 (>500)', finalStatus: '整改后复检合格', recheckRecords: [{ isPassed: true }],
  })
  assert.equal(recheck.initial, 'fail')
  assert.equal(recheck.final, 'pass')
  assert.equal(recheck.basis, 'recheck')
  const byFlag = deriveConclusion('tableware', { result: '合格', recheckRecords: [{ isPassed: false }] })
  assert.equal(byFlag.final, 'fail')
  assert.equal(byFlag.basis, 'recheck')
})

test('结论口径：食用油 colorLevel 走显式枚举（未识别值不得默认合格）；病原体阳性判定；无判定文本为 unknown 而非 fail', () => {
  // 业务裁定（Dashboard.isOilQualified 同款）：仅「不合格」判不合格；**已知**合格类 {合格, 警戒} 判合格。
  assert.equal(deriveConclusion('oil', { colorLevel: '合格' }).initial, 'pass')
  assert.equal(deriveConclusion('oil', { colorLevel: '警戒' }).initial, 'pass', '警戒属已知等级，按裁定仍算合格')
  assert.equal(deriveConclusion('oil', { colorLevel: '不合格' }).initial, 'fail')
  // ⚠️ 2026-09-17 P1 修复：原实现是 fail-open（任何非空 colorLevel 都判 pass）。
  // 现改为显式枚举：未识别等级 → 回退 result 文本；两者都无可判文本 → unknown。
  assert.equal(deriveConclusion('oil', { colorLevel: '深绿色' }).initial, 'unknown', '未识别等级不得默认合格')
  assert.equal(deriveConclusion('oil', { colorLevel: 'foo' }).initial, 'unknown', '脏值不得默认合格')
  assert.equal(deriveConclusion('oil', { colorLevel: '深绿色', result: '合格' }).initial, 'pass', '未识别等级回退 result 文本')
  assert.equal(deriveConclusion('oil', { colorLevel: 'foo', result: '不合格 (>0.25)' }).initial, 'fail')
  assert.equal(deriveConclusion('oil', { colorLevel: '' }).initial, 'unknown', '空字符串 = 未提交等级')
  assert.equal(deriveConclusion('oil', { colorLevel: null }).initial, 'unknown', 'null 不得默认合格')
  assert.equal(deriveConclusion('oil', { result: '合格' }).initial, 'pass', 'colorLevel 缺失时回退 result')
  assert.equal(deriveConclusion('oil', {}).initial, 'unknown', '两者都缺失才是 unknown')
  const p = deriveConclusion('pathogen', { riskLevel: '高风险' })
  assert.equal(p.initial, 'fail')
  assert.equal(p.isPositive, true)
  assert.equal(deriveConclusion('pathogen', { riskLevel: '无风险' }).isPositive, false)
  assert.equal(deriveConclusion('leanMeat', {}).final, 'unknown')
  assert.equal(deriveConclusion('tableware', { result: '警戒' }).final, 'warning')
})

/* ───────────── 4. 字段投影 ───────────── */

test('字段投影：递归剔除内部字段与 PII，保留业务字段', () => {
  const out = projectResultData({
    result: '合格',
    inspector: '张三',
    modificationLogs: [{ user: '张三', action: 'x' }],
    recheckRecords: [{ isPassed: true, user: '李四', points: [{ loc: 'A', rlu: '10' }] }],
    nested: { userName: '王五', sampleNo: 'S-1' },
    traceabilityRecords: [{ a: 1 }],
  })
  assert.equal('inspector' in out, false)
  assert.equal('modificationLogs' in out, false)
  assert.equal('traceabilityRecords' in out, false)
  assert.equal('user' in out.recheckRecords[0], false)
  assert.equal(out.recheckRecords[0].points.length, 1)
  assert.equal('userName' in out.nested, false)
  assert.equal(out.nested.sampleNo, 'S-1')
})

/* ───────────── 5. 游标与指纹 ───────────── */

test('游标：v2 往返携带筛选与投影指纹；旧版游标被判为非当前版本', () => {
  const c = encodeCursor({
    schoolCode: 'tjb', scopeVersion: 3, filtersFingerprint: 'F1', projectionFingerprint: 'P1',
    updatedAt: '2026-01-02T03:04:05.006Z', id: 'rec-1',
  })
  const d = decodeCursor(c)
  assert.equal(d._current, true)
  assert.equal(d.s, 'tjb')
  assert.equal(d.g, 3)
  assert.equal(d.f, 'F1')
  assert.equal(d.p, 'P1')
  assert.equal(d.i, 'rec-1')
  const legacy = Buffer.from(JSON.stringify({ v: 1, s: 'tjb', u: '2026-01-02T03:04:05.006Z', i: 'rec-1' })).toString('base64url')
  assert.equal(decodeCursor(legacy)._current, false, '旧协议游标必须被判为非当前，要求重新对账')
  assert.equal(decodeCursor('not-a-cursor'), null)
  assert.equal(decodeCursor(Buffer.from('{"v":2}').toString('base64url')), null)
})

test('筛选指纹：与类型顺序无关，但随类型/学校/时间条件变化', () => {
  const a = computeFiltersFingerprint({ schoolCode: 'tjb', types: ['oil', 'tableware'] })
  const b = computeFiltersFingerprint({ schoolCode: 'tjb', types: ['tableware', 'oil'] })
  const c = computeFiltersFingerprint({ schoolCode: 'tjb', types: ['tableware'] })
  const d = computeFiltersFingerprint({ schoolCode: 'zhyz', types: ['tableware', 'oil'] })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.notEqual(a, d)
})

test('投影指纹：随类型白名单与检测人/病原体开关变化', () => {
  const base = computeProjectionFingerprint(GRANT)
  assert.equal(base, computeProjectionFingerprint({ ...GRANT }))
  assert.notEqual(base, computeProjectionFingerprint({ ...GRANT, include_inspector: true }))
  assert.notEqual(base, computeProjectionFingerprint({ ...GRANT, include_pathogen: true }))
  assert.notEqual(base, computeProjectionFingerprint({ ...GRANT, visible_types: ['tableware'] }))
})

test('授权范围解析：病原体需显式开启；默认四类；自定义类型不开放', () => {
  assert.deepEqual(resolveGrantTypes({ include_pathogen: false }), ['tableware', 'pesticide', 'oil', 'leanMeat'])
  assert.deepEqual(resolveGrantTypes({ visible_types: ['tableware', 'pathogen'], include_pathogen: false }), ['tableware'])
  assert.deepEqual(resolveGrantTypes({ visible_types: ['tableware', 'pathogen'], include_pathogen: true }), ['tableware', 'pathogen'])
  assert.deepEqual(resolveGrantTypes({ visible_types: ['myCustom'] }), [])
})

/* ───────────── 6. 清单摘要 ───────────── */

test('清单摘要：记录/授权版本/投影策略任一变化都会改变 digest，且同输入稳定', () => {
  const rows = [{ record_code: 'RC-1', updated_at: new Date('2026-01-01T00:00:00Z') }]
  const meta = { scopeVersion: 1, projectionFingerprint: 'P1' }
  const base = computeManifestDigest(rows, meta)
  assert.equal(base, computeManifestDigest(rows, meta), '同输入必须稳定')
  assert.notEqual(base, computeManifestDigest([...rows, { record_code: 'RC-2', updated_at: new Date('2026-01-01T00:00:00Z') }], meta))
  assert.notEqual(base, computeManifestDigest([{ record_code: 'RC-1', updated_at: new Date('2026-01-02T00:00:00Z') }], meta))
  assert.notEqual(base, computeManifestDigest(rows, { ...meta, scopeVersion: 2 }))
  assert.notEqual(base, computeManifestDigest(rows, { ...meta, projectionFingerprint: 'P2' }), '关闭检测人姓名也必须改变 digest')
})

test('契约版本常量存在且稳定', () => {
  assert.equal(OPEN_API_CONTRACT_VERSION, 'v1')
})

/* ───────────── 审阅 F6/F7 回归（2026-09-17）───────────── */

test('F7：复检结构对 GenericTest 三类型（油/果蔬/肉蛋）同样登记并下发，且不下发复检人姓名', () => {
  // 依据写入路径（frontend/js/modules/GenericTest.js:549-550 会写 record.recheckRecords），
  // 而非"当前数据里观察到什么"。旧字典只给餐具登记 → 白名单剔除 → 复检证据丢失但结论仍来自复检（自相矛盾）。
  for (const t of ['oil', 'pesticide', 'leanMeat']) {
    const fields = listFieldDescriptors(t)
    const f = fields.find((x) => x.path === 'result.recheckRecords')
    assert.ok(f, `${t} 必须登记 result.recheckRecords`)
    assert.ok(String(f.description).includes('user'), '必须说明 user 不下发')
    assert.ok(allowedResultKeys(t).has('recheckRecords'), `${t} 的白名单必须允许 recheckRecords`)
  }
  const grant = { visible_types: ['oil'], include_inspector: true, scope_version: 1 }
  const out = buildOpenRecord({
    id: 'x', record_code: 'x', test_type: 'oil', status: 'completed', version: 1,
    sample_info: { testDate: '2026-01-15', canteen: '示例食堂', inspector: '示例姓名' },
    result_data: {
      colorLevel: '不合格',
      recheckRecords: [{ id: 1, time: '2026-01-15 15:30', user: '复检人示例', isPassed: true, points: [{ loc: 'A', rlu: '10', res: '合格' }] }],
    },
  }, grant, CTX)
  assert.ok(Array.isArray(out.result.recheckRecords), '复检证据必须下发（曾因白名单遗漏被剔除）')
  assert.equal(out.result.recheckRecords[0].user, undefined, '复检人姓名必须被 PII 剔除')
  assert.equal(out.result.recheckRecords[0].isPassed, true)
})

test('F6：学校配置指纹参与 projection_fingerprint，并传导到 manifest digest（仅策略变化也必须可感知）', () => {
  const a = computeProjectionFingerprint(GRANT)
  const b = computeProjectionFingerprint(GRANT, 'school-config-A')
  const c = computeProjectionFingerprint(GRANT, 'school-config-B')
  assert.notEqual(a, b, '学校自定义字段指纹必须影响 projection_fingerprint')
  assert.notEqual(b, c, '不同配置必须得到不同指纹')
  assert.equal(b, computeProjectionFingerprint(GRANT, 'school-config-A'), '同一配置必须稳定（否则同步震荡）')
  const rows = [{ record_code: 'RC-x', updated_at: '2026-01-15T00:00:00+08:00' }]
  assert.notEqual(
    computeManifestDigest(rows, { scopeVersion: 1, projectionFingerprint: b }),
    computeManifestDigest(rows, { scopeVersion: 1, projectionFingerprint: c }),
    '记录行不变、仅投影变化 → digest 必须变化',
  )
})
