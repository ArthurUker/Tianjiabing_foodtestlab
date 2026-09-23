// 开放接口「输出字段策略」回归（2026-09-16 审阅 M2 修复后新增）
//
// 口径：对外下发的 result.* 采用**两层策略** ——
//   ① 顶层白名单：只放行字段字典登记过的键（含学校自定义字段）；
//   ② 容器内递归黑名单：剔除内部字段与 PII（人名类键正则兜底）。
// 要求：字典 / 样例 / 真实响应 / 预览 / 接入包**同源**（同一 descriptors + 同一 buildOpenRecord）。
//
// 运行：cd /opt/foodsentinel/backend && node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  listFieldDescriptors,
  allowedResultKeys,
  buildAllowedResultKeyMap,
  buildSyntheticSamples,
  extractCustomFieldMeta,
} from '../../lib/openApiFieldSchema.js'
import { projectResultData, buildOpenRecord } from '../../lib/openApiScope.js'

const GRANT_NO_INSPECTOR = { visible_types: ['tableware', 'oil', 'leanMeat', 'pesticide', 'pathogen'], include_pathogen: true, include_inspector: false }
const CTX = { schoolCode: 'test', schoolName: '测试学校' }

/* ───────────── 1. 白名单行为 ───────────── */

test('投影：未传 allowedKeys 时保持旧行为（仅黑名单）', () => {
  const out = projectResultData({ tpmValue: '0.06', undeclaredKey: 'x', modificationLogs: [{ user: 'a' }], inspector: '张三' })
  assert.equal(out.undeclaredKey, 'x', '无白名单时不丢键（兼容内部调用）')
  assert.equal('modificationLogs' in out, false)
  assert.equal('inspector' in out, false)
})

test('投影：传入 allowedKeys 时未登记键被丢弃，已登记键保留', () => {
  const allowed = new Set(['tpmValue', 'remark'])
  const dropped = [];
  const out = projectResultData(
    { tpmValue: '0.06', remark: '', undeclaredKey: 'x', sampleInfo: '一号样品' },
    { allowedKeys: allowed, onDropped: (k) => dropped.push(k) },
  )
  assert.deepEqual(Object.keys(out).sort(), ['remark', 'tpmValue'])
  assert.deepEqual(dropped.sort(), ['sampleInfo', 'undeclaredKey'])
})

test('投影：容器内部仍走递归黑名单（白名单只作用于顶层）', () => {
  const allowed = new Set(['recheckRecords'])
  const out = projectResultData({
    recheckRecords: [{ id: 1, isPassed: true, user: '王五', points: [{ loc: 'A', rlu: '96' }] }],
  }, { allowedKeys: allowed })
  assert.equal(out.recheckRecords.length, 1)
  assert.equal('user' in out.recheckRecords[0], false, '复检人姓名必须剔除')
  assert.deepEqual(out.recheckRecords[0].points, [{ loc: 'A', rlu: '96' }])
})

test('自定义身份字段及数组内复检人不下发，普通业务字段保留', () => {
  const ctx = { customFieldNames: ['contactPhone', 'staffIdentity', 'batchMark', 'field1'], fieldLabels: { field1: '联系电话' } }
  const allowed = allowedResultKeys('tableware', ctx)
  assert.equal(allowed.has('contactPhone'), false)
  assert.equal(allowed.has('staffIdentity'), false)
  assert.equal(allowed.has('field1'), false, '敏感中文标签不能通过中性键名绕过')
  assert.equal(allowed.has('batchMark'), true)
  const out = projectResultData({
    contactPhone: '13800000000', batchMark: '批次 A',
    recheckRecords: [{ isPassed: true, recheckInspector: '张三', points: [{ loc: '餐盘', rlu: '10' }] }],
  }, { allowedKeys: allowed, onDropped: () => {} })
  assert.equal(out.contactPhone, undefined)
  assert.equal(out.batchMark, '批次 A')
  assert.equal(out.recheckRecords[0].recheckInspector, undefined)
  assert.deepEqual(out.recheckRecords[0].points, [{ loc: '餐盘', rlu: '10' }])
})

/* ───────────── 2. 字典补齐（此前漏登记的实测字段） ───────────── */

test('字典：oil.result 已登记（/stats 口径会回退读它）', () => {
  const oil = listFieldDescriptors('oil').map((f) => f.path)
  assert.ok(oil.includes('result.result'), '油记录的 result 文本必须登记')
  assert.equal(allowedResultKeys('oil').has('result'), true, '登记后必须进入白名单，否则会被误删')
})

test('字典：病原体的 sampleId / sampleType / sampleInfo 已登记，且 sampleInfo 标为字符串', () => {
  const fields = listFieldDescriptors('pathogen')
  for (const p of ['result.sampleId', 'result.sampleType', 'result.sampleInfo']) {
    const f = fields.find((x) => x.path === p)
    assert.ok(f, `缺少 ${p}`)
    assert.equal(f.type, 'string')
    assert.ok(allowedResultKeys('pathogen').has(p.slice('result.'.length)))
  }
})

/* ───────────── 3. 真实响应 ⊆ 字典（同源不变式） ───────────── */

test('不变式：合成样例经投影后，result 的每个键都在白名单内', () => {
  for (const t of ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen']) {
    const allowed = allowedResultKeys(t)
    for (const s of buildSyntheticSamples(t)) {
      const item = buildOpenRecord(s.record, GRANT_NO_INSPECTOR, { ...CTX, allowedResultKeys: allowed })
      for (const k of Object.keys(item.result)) {
        assert.ok(allowed.has(k), `${t}/${s.scenario} 下发了未登记字段 result.${k}`)
      }
    }
  }
})

test('白名单：未登记字段不下发（含历史脏键），已登记字段照常下发', () => {
  const record = {
    id: 'r1', record_code: 'RC-1', test_type: 'oil', test_name: '食用油品质检测', status: 'completed',
    sample_info: { testDate: '2026-03-01', canteen: '一食堂', inspector: '张三' },
    result_data: { tpmValue: '0.06', result: '合格', legacyUndeclared: { secret: 1 }, modificationLogs: [{ user: '甲' }] },
    created_at: new Date('2026-03-01T00:00:00Z'), updated_at: new Date('2026-03-02T00:00:00Z'), data_version: 1,
  }
  const allowed = allowedResultKeys('oil')
  const item = buildOpenRecord(record, GRANT_NO_INSPECTOR, { ...CTX, allowedResultKeys: allowed })
  assert.equal(item.result.tpmValue, '0.06')
  assert.equal(item.result.result, '合格')
  assert.equal('legacyUndeclared' in item.result, false)
  assert.equal('modificationLogs' in item.result, false)
})

test('姓名开关：关闭时顶层与嵌套/字符串路径均不出现检测人', () => {
  const record = {
    id: 'r1', record_code: 'RC-1', test_type: 'tableware', test_name: '餐具洁净度检测', status: 'completed',
    sample_info: { testDate: '2026-03-01', canteen: '一食堂', inspector: '张三' },
    result_data: {
      rluValue: '120', result: '合格 (<200)', remark: '张三 复核',
      atpPoints: [{ loc: '餐具表面', rlu: '120', res: '合格', inspector: '张三' }],
      recheckRecords: [{ id: 1, isPassed: true, user: '张三' }],
    },
    created_at: new Date('2026-03-01T00:00:00Z'), updated_at: new Date('2026-03-02T00:00:00Z'), data_version: 1,
  }
  const itemOff = buildOpenRecord(record, GRANT_NO_INSPECTOR, { ...CTX, allowedResultKeys: allowedResultKeys('tableware') })
  assert.equal('inspector' in itemOff, false)
  assert.equal(JSON.stringify(itemOff).includes('"inspector"'), false, '任意层级不得出现 inspector 键')
  assert.equal(JSON.stringify(itemOff).includes('"user"'), false, '复检人键不得出现')
  // 自由文本内的姓名（remark）属边界：平台不承诺脱敏，但字段字典须明示
  assert.ok(itemOff.result.remark.includes('张三'), '自由文本字段原样下发（契约边界，见字典说明）')

  const itemOn = buildOpenRecord(record, { ...GRANT_NO_INSPECTOR, include_inspector: true }, { ...CTX, allowedResultKeys: allowedResultKeys('tableware') })
  assert.equal(itemOn.inspector, '张三', '开启后顶层下发')
  assert.equal('inspector' in itemOn.result, false, '嵌套副本仍不下发')
  assert.equal(JSON.stringify(itemOn.result).includes('张三'), true)
})

/* ───────────── 4. 与自定义字段同源 ───────────── */

test('白名单与字典同源：学校自定义字段进入白名单并可下发', () => {
  const cust = { custom_fields: { oil: [{ name: 'customOilField', label: '自定义油品字段' }] }, field_labels: {} }
  const meta = extractCustomFieldMeta(cust, 'oil')
  const map = buildAllowedResultKeyMap(['oil'], () => meta)
  assert.equal(map.get('oil').has('customOilField'), true)

  const record = {
    id: 'r1', record_code: 'RC-1', test_type: 'oil', test_name: '食用油品质检测', status: 'completed',
    sample_info: { testDate: '2026-03-01', canteen: '一食堂', inspector: '张三' },
    result_data: { tpmValue: '0.06', customOilField: '自定义值', undeclared: '应被丢弃' },
    created_at: new Date('2026-03-01T00:00:00Z'), updated_at: new Date('2026-03-02T00:00:00Z'), data_version: 1,
  }
  const item = buildOpenRecord(record, GRANT_NO_INSPECTOR, { ...CTX, allowedResultKeys: map.get('oil') })
  assert.equal(item.result.customOilField, '自定义值')
  assert.equal('undeclared' in item.result, false)
})
