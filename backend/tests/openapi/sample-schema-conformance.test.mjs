// 合成样例 ⇄ 字段字典 **逐字段一致性** 回归（2026-09-23 对外验收 C6 修复后新增）
//
// 背景：验收发现字典声明 `result.sampleId/sampleType/sampleInfo` 必现（required=true），
// 但三个病原体样例全部缺失这三个键 —— 字典与样例自相矛盾，对接方按字典建严格模型后
// 连官方样例都通不过。根因是**把数据观察（66/66 实测存在）写成了必现契约**。
//
// 本文件把「样例必须自证字典」做成机器断言，覆盖：
//   ① required=true（服务端投影保证）的字段必须出现；
//   ② 投影输出 ⊆ 字典（顶层键 + result.* 键都要有登记）；
//   ③ emitted=false 的字段不得出现；条件字段随开关出现/消失；
//   ④ enum 取值 ⊆ 声明枚举；⑤ 类型匹配；⑥ nullable=false 不得为 null；
//   ⑦ 样例原始数据里**未登记**的键不得泄漏进响应（防止样例带会被静默丢弃的键）；
//   ⑧ 不能把数据观察写成必现：`result.*` 的 required 必须恒为 false，观察写进 observed_present；
//   ⑨ TPM 单位未核实标记必须保留（不得被"顺手"改成已核实）。
//
// 运行：cd /opt/foodsentinel/backend && node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import { listFieldDescriptors, allowedResultKeys, buildSyntheticSamples } from '../../lib/openApiFieldSchema.js'
import { buildOpenRecord } from '../../lib/openApiScope.js'

const ALL_TYPES = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen']
const GRANT = (includeInspector) => ({
  visible_types: [...ALL_TYPES],
  include_pathogen: true,
  include_inspector: includeInspector,
})
const CTX = { schoolCode: 'test', schoolName: '测试学校' }

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 按字典 `type` 校验实际值；unknown 不校验（平台不保证类型）。 */
function assertTypeMatches(descriptor, value, label) {
  const t = descriptor.type
  if (t === 'unknown') return
  if (t === 'string') return assert.equal(typeof value, 'string', `${label} 应为 string，实际 ${typeof value}`)
  if (t === 'number') return assert.equal(typeof value, 'number', `${label} 应为 number，实际 ${typeof value}`)
  if (t === 'integer') return assert.ok(Number.isInteger(value), `${label} 应为 integer，实际 ${JSON.stringify(value)}`)
  if (t === 'boolean') return assert.equal(typeof value, 'boolean', `${label} 应为 boolean，实际 ${typeof value}`)
  if (t === 'date') return assert.match(String(value), /^\d{4}-\d{2}-\d{2}$/, `${label} 应为 YYYY-MM-DD`)
  if (t === 'datetime') return assert.ok(!Number.isNaN(Date.parse(String(value))), `${label} 应为可解析的 ISO8601 时间`)
  if (t === 'enum') {
    assert.equal(typeof value, 'string', `${label}（enum）应为字符串`)
    assert.ok(Array.isArray(descriptor.enum) && descriptor.enum.includes(value), `${label} 取值 ${JSON.stringify(value)} 不在声明枚举 ${JSON.stringify(descriptor.enum)} 内`)
    return
  }
  if (t === 'array<object>' || t === 'array') {
    assert.ok(Array.isArray(value), `${label} 应为数组`)
    if (t === 'array<object>') {
      for (const [i, el] of value.entries()) assert.ok(isPlainObject(el), `${label}[${i}] 应为对象`)
    }
    return
  }
  if (t === 'object') return assert.ok(isPlainObject(value), `${label} 应为对象`)
  assert.fail(`${label} 出现未识别的字典类型 ${t}`)
}

/** 取出投影后响应中的某个字典路径（仅支持顶层与 result.<key> 两级，与字典书写一致）。 */
function valueAtPath(item, path) {
  if (path.startsWith('result.')) return item?.result?.[path.slice('result.'.length)]
  return item?.[path]
}
const hasPath = (item, path) => valueAtPath(item, path) !== undefined

/* ───────────── ①②③④⑤⑥：样例 ⇄ 字典 全量一致性 ───────────── */

test('样例一致性：required=true（服务端保证）的字段必须出现，且逐字段类型/enum/nullable 与字典一致', () => {
  for (const includeInspector of [true, false]) {
    for (const type of ALL_TYPES) {
      const descriptors = listFieldDescriptors(type)
      const allowed = allowedResultKeys(type)
      for (const { scenario, record } of buildSyntheticSamples(type)) {
        const item = buildOpenRecord(record, GRANT(includeInspector), { ...CTX, allowedResultKeys: allowed })
        const label = `${type}/${scenario}${includeInspector ? '' : '(不含检测人)'}`
        for (const d of descriptors) {
          if (d.emitted === false) continue
          if (d.conditional_on === 'include_inspector' && !includeInspector) {
            assert.equal(hasPath(item, d.path), false, `${label}：未开启 include_inspector，${d.path} 不得出现`)
            continue
          }
          if (d.required) {
            assert.ok(hasPath(item, d.path), `${label}：required=true 的 ${d.path} 在样例中缺失（字典与样例必须一致）`)
          }
          if (!hasPath(item, d.path)) continue
          const v = valueAtPath(item, d.path)
          if (d.nullable === false) assert.notEqual(v, null, `${label}：nullable=false 的 ${d.path} 不得为 null`)
          if (v === null) continue   // null 是合法取值（nullable=true）时不做类型校验
          assertTypeMatches(d, v, `${label} → ${d.path}`)
        }
      }
    }
  }
})

test('样例一致性：投影输出 ⊆ 字典（顶层键与 result.* 键都必须有登记）', () => {
  for (const type of ALL_TYPES) {
    const paths = new Set(listFieldDescriptors(type).map((d) => d.path))
    const allowed = allowedResultKeys(type)
    for (const { scenario, record } of buildSyntheticSamples(type)) {
      const item = buildOpenRecord(record, GRANT(true), { ...CTX, allowedResultKeys: allowed })
      for (const k of Object.keys(item)) {
        assert.ok(paths.has(k), `${type}/${scenario}：顶层字段 ${k} 未在字典登记`)
      }
      for (const k of Object.keys(item.result || {})) {
        assert.ok(paths.has(`result.${k}`), `${type}/${scenario}：result.${k} 未在字典登记`)
      }
    }
  }
})

test('样例一致性：emitted=false 的字段绝不下发（result.inspector / 内部字段）', () => {
  for (const type of ALL_TYPES) {
    const notEmitted = listFieldDescriptors(type).filter((d) => d.emitted === false).map((d) => d.path)
    assert.ok(notEmitted.length > 0, `${type} 应至少登记一个不下发字段（result.inspector）`)
    const allowed = allowedResultKeys(type)
    for (const { scenario, record } of buildSyntheticSamples(type)) {
      const item = buildOpenRecord(record, GRANT(true), { ...CTX, allowedResultKeys: allowed })
      for (const p of notEmitted) {
        assert.equal(hasPath(item, p), false, `${type}/${scenario}：不下发字段 ${p} 出现在响应中`)
      }
      // 内部键（黑名单）同样不得泄漏
      for (const k of ['modificationLogs', 'recheckInspector', 'user']) {
        assert.equal(k in (item.result || {}), false, `${type}/${scenario}：内部键 result.${k} 不得下发`)
      }
    }
  }
})

test('样例一致性：样例原始数据中未登记的键不得泄漏进响应（防止样例带会被静默丢弃的键）', () => {
  for (const type of ALL_TYPES) {
    const allowed = allowedResultKeys(type)
    for (const { scenario, record } of buildSyntheticSamples(type)) {
      const item = buildOpenRecord(record, GRANT(true), { ...CTX, allowedResultKeys: allowed })
      const unregistered = Object.keys(record.result_data || {}).filter((k) => !allowed.has(k))
      for (const k of unregistered) {
        assert.equal(k in (item.result || {}), false, `${type}/${scenario}：未登记键 result.${k} 不应出现在响应中（样例应删掉或登记它）`)
      }
    }
  }
})

/* ───────────── ⑧：不得把数据观察写成必现 ───────────── */

test('出现性语义：result.* 的 required 恒为 false；观察到"全部出现"只能记 observed_present', () => {
  for (const type of ALL_TYPES) {
    for (const d of listFieldDescriptors(type)) {
      if (!d.path.startsWith('result.')) continue
      assert.equal(d.required, false, `${type}：${d.path} 来自保存数据，不得声明 required=true（服务端不保证出现）`)
    }
  }
  // 观察信息本身不能被丢掉（容错解析时仍有用），且必须是"观察"口径的措辞
  const pathogen = listFieldDescriptors('pathogen')
  for (const p of ['result.sampleId', 'result.sampleType', 'result.sampleInfo']) {
    const d = pathogen.find((x) => x.path === p)
    assert.ok(d, `字典缺少 ${p}`)
    assert.equal(d.required, false, `${p} 不得再声明必现`)
    assert.ok(d.observed_present, `${p} 应保留 observed_present（数据观察）`)
    assert.match(d.observed_present, /数据观察/, `${p} 的 observed_present 必须明示"数据观察"`)
  }
})

test('C6 专项：病原体三个样例都给出样品标识，且不再出现会被丢弃的未登记 result.result', () => {
  const samples = buildSyntheticSamples('pathogen')
  assert.equal(samples.length, 3, '应覆盖 pass / positive / recheck_passed')
  for (const { scenario, record } of samples) {
    for (const k of ['sampleId', 'sampleType', 'sampleInfo']) {
      const v = record.result_data?.[k]
      assert.ok(typeof v === 'string' && v.length > 0, `${scenario}：result.${k} 应有虚构示例值`)
      assert.match(v, /示例|SAMPLE/i, `${scenario}：result.${k} 必须带示例标识，避免被当成真实样品`)
    }
    assert.equal('result' in (record.result_data || {}), false, `${scenario}：病原体 result.result 未登记（会被白名单丢弃），样例不得包含`)
  }
})

test('样例标识：所有样例 record_code 以 SAMPLE- 开头且 synthetic 语义可辨识', () => {
  for (const type of ALL_TYPES) {
    for (const { record } of buildSyntheticSamples(type)) {
      assert.ok(String(record.record_code).startsWith('SAMPLE-'), `${type}：样例 record_code 必须以 SAMPLE- 开头`)
      assert.ok(String(record.id).startsWith('sample-'), `${type}：样例内部 id 应可辨识为样例`)
    }
  }
})

/* ───────────── ⑩：阶段语义必须写明（防"同一时点自相矛盾"误读） ───────────── */

test('阶段语义：is_positive 必须写明"初检证据"，并解释与复检结论并存不矛盾', () => {
  const d = listFieldDescriptors('pathogen').find((x) => x.path === 'is_positive')
  assert.ok(d, '字典缺少 is_positive')
  assert.match(d.description, /初检/, '必须写明它反映初检证据')
  assert.match(d.description, /复检结论/, '必须写明它不是复检结论')
  assert.match(d.description, /不矛盾/, '必须解释"初检阳性 + 复检通过"并存不矛盾')
  assert.match(d.description, /positiveDetails/, '必须给出判定依据')
})

/* ───────────── ⑨：TPM 单位未核实标记不得被"顺手"改为已核实 ───────────── */

test('TPM：unit_verified=false / unit_source=platform_label 必须保留，且单位文案含"未经…核实"', () => {
  const tpm = listFieldDescriptors('oil').find((d) => d.path === 'result.tpmValue')
  assert.ok(tpm, '字典缺少 result.tpmValue')
  assert.equal(tpm.unit_source, 'platform_label')
  assert.equal(tpm.unit_verified, false, '未经设备协议核实前不得改为 true')
  assert.match(String(tpm.description), /未经.{0,20}核实/, '说明里必须保留"未经…核实"提示')
})
