// 记录写入/读取归一 · 纯函数回归（2026-09-16 审阅修复 H1/H2/H3/M1/M5 后重写）
//
// 锁定口径（与 docs/OPEN_API_INTEGRATION.md、README §4.3 同步）：
//   · 上下文三键 testDate/canteen/inspector：权威位置 = sample_info；result_data 内的同名键 = 历史副本。
//   · 请求内优先级：顶层 > sample_info > result_data；本次请求提交的值优先于数据库旧值。
//   · null / 空字符串 / 缺键 = "未提交"（三键不允许清空）；局部更新保留旧值，整对象替换由校验拒绝。
//   · result_data 落库前剔除控制字段（status/created_by/version/id/... 与三键副本）。
//   · 读取：sample_info 有值（含空串）即用权威值，仅缺失时回退旧副本（显式清空不得让副本复活）。
//
// 运行：cd /opt/foodsentinel/backend && node --test tests/records/
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRecordWriteData,
  buildRecordPayload,
  buildDeterministicRecordCode,
  normalizeWriteJson,
  resolveContextValues,
  resolveWritableStatus,
  stripControlKeys,
  CONTEXT_FIELDS,
} from '../../lib/recordNormalize.js'

const CTX = { testDate: '2026-03-01', canteen: '第一食堂', inspector: '张三' }
const FLAT = { ...CTX, result: '合格', rluValue: '120', remarks: '原样保留' }

/* ───────────── 1. 常量与优先级 ───────────── */

test('上下文三键常量未漂移（字典/投影/白名单依赖它）', () => {
  assert.deepEqual(CONTEXT_FIELDS, ['testDate', 'canteen', 'inspector'])
})

test('resolveContextValues：请求内优先级 顶层 > sample_info > result_data', () => {
  const r = resolveContextValues({
    payload: { canteen: '顶层食堂' },
    sampleInfo: { canteen: 'SI 食堂', testDate: '2026-01-01' },
    resultData: { canteen: 'RD 食堂', testDate: '2026-02-02', inspector: '王五' },
  })
  assert.equal(r.values.canteen, '顶层食堂', '顶层优先')
  assert.equal(r.values.testDate, '2026-01-01', '顶层缺失 → sample_info')
  assert.equal(r.values.inspector, '王五', '前两处缺失 → result_data')
})

test('resolveContextValues：null / 空串 / 缺键一律视为未提交（三键不允许清空）', () => {
  const r = resolveContextValues({
    payload: { canteen: '   ', testDate: null, inspector: undefined },
    sampleInfo: { canteen: '', inspector: null },
    resultData: {},
  })
  assert.deepEqual(r.values, {})
  assert.deepEqual(r.missing, ['testDate', 'canteen', 'inspector'])
})

/* ───────────── 2. 写入归一 ───────────── */

test('create：扁平载荷 → result_data 无副本、无控制字段；三键只落 sample_info', () => {
  const out = normalizeWriteJson({ payload: { ...FLAT, status: 'completed', version: 3, record_code: 'RC-x', created_by: 'u1' }, existingSampleInfo: null, mode: 'create' })
  assert.equal(out.ok, true)
  assert.deepEqual(out.sampleInfo, CTX)
  for (const k of [...CONTEXT_FIELDS, 'status', 'version', 'record_code', 'created_by', 'sample_info', 'result_data', 'id']) {
    assert.equal(k in out.resultData, false, `result_data 不应含 ${k}`)
  }
  assert.equal(out.resultData.result, '合格')
  assert.equal(out.sourceKind, 'flat')
})

test('create：显式 result_data（含三键）优先于扁平字段，且副本被剥离', () => {
  const out = normalizeWriteJson({
    payload: { ...FLAT, canteen: '不应生效' },
    resultData: { tpmValue: '0.06', canteen: 'RD 食堂', testDate: '2026-02-02', inspector: '王五' },
    sampleInfo: {},
    existingSampleInfo: null,
    mode: 'create',
  })
  assert.equal(out.ok, true)
  // 顶层 > sample_info(空) > result_data：顶层 canteen 生效
  assert.equal(out.sampleInfo.canteen, '不应生效')
  assert.equal(out.sampleInfo.testDate, '2026-03-01', '顶层仍是第一优先级来源')
  assert.equal(out.sampleInfo.inspector, '张三', '顶层（扁平载荷）仍优先于 result_data 内的副本')
  assert.equal(out.resultData.tpmValue, '0.06')
  assert.equal('canteen' in out.resultData, false)
  assert.equal(out.sourceKind, 'nested')
})

test('create：result_data 为 null / {} / 数组 / 字符串 的处理各不相同', () => {
  const nullCase = normalizeWriteJson({ payload: FLAT, resultData: null, existingSampleInfo: null, mode: 'create' })
  assert.equal(nullCase.ok, true, 'null = 未提供 → 回退扁平载荷')
  assert.equal(nullCase.resultData.result, '合格')
  assert.equal('result_data' in nullCase.resultData, false, '字面键不得写入结果对象（审阅 L2）')

  const emptyCase = normalizeWriteJson({ payload: FLAT, resultData: {}, existingSampleInfo: null, mode: 'create' })
  assert.equal(emptyCase.ok, true, '空对象 = 未提供 → 回退扁平载荷（审阅 H2：不得写出空记录）')
  assert.equal(emptyCase.resultData.result, '合格')

  const arrCase = normalizeWriteJson({ payload: FLAT, resultData: [], existingSampleInfo: null, mode: 'create' })
  assert.equal(arrCase.ok, false)
  assert.equal(arrCase.code, 'INVALID_RESULT_DATA')

  const strCase = normalizeWriteJson({ payload: FLAT, resultData: 'oops', existingSampleInfo: null, mode: 'create' })
  assert.equal(strCase.ok, false)
  assert.equal(strCase.code, 'INVALID_RESULT_DATA')
})

test('create：无业务字段（只有三键）→ 明确 400，不静默写空记录', () => {
  const out = normalizeWriteJson({ payload: { ...CTX }, existingSampleInfo: null, mode: 'create' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'EMPTY_RESULT_DATA')
})

test('create：缺上下文三键 → 明确 400', () => {
  const out = normalizeWriteJson({ payload: { result: '合格' }, existingSampleInfo: null, mode: 'create' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'MISSING_CONTEXT_FIELDS')
  assert.match(out.message, /testDate/)
})

test('update：只提交 result_data（内含食堂变更）→ 合并写回 sample_info（审阅 H1 修复点）', () => {
  const out = normalizeWriteJson({
    payload: { id: 'r1', result_data: { canteen: 'RD 新食堂', tpmValue: '0.9' } },
    resultData: { canteen: 'RD 新食堂', tpmValue: '0.9' },
    sampleInfo: undefined,
    existingSampleInfo: { testDate: '2026-03-01', canteen: '旧食堂', inspector: '张三' },
    mode: 'update',
  })
  assert.equal(out.ok, true)
  assert.equal(out.sampleInfo.canteen, 'RD 新食堂', '请求提交的新值必须生效（不得因旧值存在而被忽略）')
  assert.equal(out.sampleInfo.inspector, '张三', '未提交的字段保留旧值')
  assert.equal(out.resultData.tpmValue, '0.9')
  assert.equal('canteen' in out.resultData, false)
})

test('update：result_data 未提交或为 {} → 返回 undefined（不改动，不得清空已有结果）', () => {
  const base = { testDate: '2026-03-01', canteen: '旧食堂', inspector: '张三', location: '一楼' }
  const absent = normalizeWriteJson({ payload: { id: 'r1', status: 'completed' }, existingSampleInfo: base, mode: 'update' })
  assert.equal(absent.ok, true)
  assert.equal(absent.resultData, undefined)
  assert.equal(absent.provided.length, 0)

  const empty = normalizeWriteJson({ payload: { id: 'r1', result_data: {} }, resultData: {}, existingSampleInfo: base, mode: 'update' })
  assert.equal(empty.ok, true)
  assert.equal(empty.resultData, undefined)
  assert.equal(empty.sourceKind, 'empty-object-noop')
})

test('update：sample_info 只在本次提交了三键时才写（保留 location 等其它子键）', () => {
  const base = { testDate: '2026-03-01', canteen: '旧食堂', inspector: '张三', location: '一楼' }
  const withCtx = normalizeWriteJson({ payload: { canteen: '新食堂' }, existingSampleInfo: base, mode: 'update' })
  assert.equal(withCtx.provided.length, 1)
  assert.deepEqual(withCtx.sampleInfo, { testDate: '2026-03-01', canteen: '新食堂', inspector: '张三', location: '一楼' })
})

test('stripControlKeys：只剔顶层控制键，不动业务字段', () => {
  const out = stripControlKeys({ status: 'archived', created_by: 'u1', id: 'x', tpmValue: '0.06', nested: { status: 'keep' } })
  assert.deepEqual(Object.keys(out).sort(), ['nested', 'tpmValue'])
  assert.equal(out.nested.status, 'keep', '嵌套结构内的同名字段属业务数据，保留')
})

/* ───────────── 3. 整对象替换入口 ───────────── */

test('buildRecordWriteData：返回 {ok,data}，三键只落 sample_info，管理字段不入 result_data', () => {
  const built = buildRecordWriteData('tableware', FLAT)
  assert.equal(built.ok, true)
  assert.deepEqual(built.data.sample_info, CTX)
  for (const k of ['version', 'record_code', 'test_type', 'test_name', 'created_at', 'updated_at', 'completed_at', '_status', 'id']) {
    assert.equal(k in built.data.result_data, false, `result_data 不应含管理字段 ${k}`)
  }
  assert.equal(built.data.result_data.rluValue, '120')
  assert.equal(built.data.test_name, '餐具洁净度检测')
})

test('buildRecordWriteData：非法载荷 → ok:false（调用方必须返回 400）', () => {
  const missing = buildRecordWriteData('oil', { result: '合格' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'MISSING_CONTEXT_FIELDS')
  const bad = buildRecordWriteData('oil', { ...CTX, result_data: 'oops' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'INVALID_RESULT_DATA')
})

/* ───────────── 4. 读取优先级（M1） ───────────── */

test('buildRecordPayload：权威值优先，副本仅在权威缺失时回退，空串不得让副本复活', () => {
  const row = (sample_info, result_data) => ({
    id: 'r1', record_code: 'RC-1', test_type: 'oil', test_name: '食用油品质检测', status: 'completed',
    version: 2, created_at: new Date('2026-03-01T00:00:00Z'), updated_at: new Date('2026-03-02T00:00:00Z'),
    sample_info, result_data,
  })

  const authoritative = buildRecordPayload(row(
    { testDate: '2026-04-01', canteen: '新食堂(SI)', inspector: '李四' },
    { testDate: '2026-03-01', canteen: '旧食堂(RD)', inspector: '张三', tpmValue: '0.9' },
  ))
  assert.equal(authoritative.canteen, '新食堂(SI)', '权威位置有值 → 用权威值')
  assert.equal(authoritative.testDate, '2026-04-01')
  assert.equal(authoritative.inspector, '李四')

  const fallback = buildRecordPayload(row(
    { tpmValue: '0.9' },
    { canteen: '旧食堂(RD)', testDate: '2026-03-01', inspector: '张三' },
  ))
  assert.equal(fallback.canteen, '旧食堂(RD)', '权威位置缺失 → 回退历史副本（老记录兼容）')
  assert.equal(fallback.testDate, '2026-03-01')

  const cleared = buildRecordPayload(row(
    { testDate: '2026-03-01', canteen: '', inspector: null },
    { canteen: '旧食堂(RD)', inspector: '张三' },
  ))
  assert.equal(cleared.canteen, '', '权威位置为空串 = 显式清空 → 不得复活旧副本')
  assert.equal(cleared.inspector, '张三', 'null = 缺失 → 回退副本（与空串语义不同）')

  const both = buildRecordPayload(row({ testDate: '2026-03-01', canteen: 'SI', inspector: '甲' }, { canteen: 'RD', tpmValue: '0.06' }))
  assert.equal(both.canteen, 'SI')
  assert.equal(both.tpmValue, '0.06', '副本被覆盖不影响其它业务字段')
})

/* ───────────── 5. 状态白名单（M5） ───────────── */

test('resolveWritableStatus：editor 不可归档；manager 可；已归档记录允许保持', () => {
  assert.deepEqual(resolveWritableStatus({ requested: undefined, role: 'editor' }), { ok: true, status: undefined })
  assert.equal(resolveWritableStatus({ requested: 'completed', role: 'editor' }).status, 'completed')
  assert.equal(resolveWritableStatus({ requested: 'archived', role: 'editor' }).ok, false)
  assert.equal(resolveWritableStatus({ requested: 'archived', role: 'editor', currentStatus: 'archived' }).status, 'archived')
  assert.equal(resolveWritableStatus({ requested: 'archived', role: 'manager' }).status, 'archived')
  assert.equal(resolveWritableStatus({ requested: 'garbage', role: 'admin' }).ok, false)
})

/* ───────────── 6. 幂等键稳定性 ───────────── */

test('幂等键不受归一影响：record_code 由入参 payload 计算', () => {
  const c1 = buildDeterministicRecordCode('tableware', FLAT)
  const c2 = buildDeterministicRecordCode('tableware', { ...FLAT })
  assert.equal(c1, c2)
  assert.match(c1, /^RC-tableware-[0-9a-f]{64}$/)
})
