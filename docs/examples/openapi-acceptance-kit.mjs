#!/usr/bin/env node
// openapi-acceptance-kit.mjs — 开放接口「对接方自检 / 验收」工具（零依赖，只读）
//
// 用途：以**第三方视角**（只用一把 API Key）把接口从连通性到对账跑一遍，
//       输出一份可交付的验收清单。既供对接方自检，也供平台方在开通新学校时复核。
//
// 运行：
//   OPENAPI_KEY=oap_xxx node docs/examples/openapi-acceptance-kit.mjs \
//     --base-url=https://<域名>/api/open/v1 --school=<学校代码> [--expect-inspector=false] [--limit=200]
//
// 只读保证：本脚本只发 GET；不创建/修改任何数据；不打印密钥明文。
//
// 检查项分两层：
//   A. 契约层（可由脚本证明）：鉴权边界、错误码、分页完整性、字典↔样例↔真实响应字段一致性、
//      **字典「必现(required=true)」字段是否真的出现在样例里（C6 类缺陷）**、统计恒等式
//   B. 语义层（需人工确认）：结论口径、TPM 单位、复检语义、撤回策略 —— 脚本只给出证据位置，不做业务判定

import process from 'node:process'

const args = process.argv.slice(2)
const val = (k, d = null) => { const a = args.find((x) => x.startsWith(`${k}=`)); return a ? a.slice(k.length + 1) : d }
// base-url 归一：既接受 `https://<域名>/api/open`，也接受 `https://<域名>/api/open/v1`
// （否则会拼成 /api/open/v1/v1/ping → 认证/路由均不匹配，表现为"密钥无效"的假故障 —— 2026-09-23 实测踩过）
let BASE = (val('--base-url') || '').replace(/\/$/, '')
BASE = BASE.replace(/\/v1$/, '')
const KEY = process.env.OPENAPI_KEY || ''
const SCHOOL = val('--school') || ''
const LIMIT = Number(val('--limit', '200')) || 200
const expectInspector = val('--expect-inspector', null)   // 'true' | 'false' | null(不检查)

if (!BASE || !KEY || !SCHOOL) {
  console.error('用法：OPENAPI_KEY=oap_xxx node openapi-acceptance-kit.mjs --base-url=https://<域名>/api/open/v1 --school=<学校代码>')
  process.exit(2)
}

let pass = 0, fail = 0, warn = 0
const lines = []
const ok = (n, d = '') => { pass++; lines.push(`✅ ${n}${d ? ' — ' + d : ''}`) }
const ng = (n, d = '') => { fail++; lines.push(`❌ ${n}${d ? ' — ' + d : ''}`) }
const wn = (n, d = '') => { warn++; lines.push(`⚠️  ${n}${d ? ' — ' + d : ''}`) }
const check = (n, cond, d = '') => (cond ? ok(n, d) : ng(n, d))

async function get(path, { key = KEY } = {}) {
  const res = await fetch(BASE + path, key ? { headers: { 'X-API-Key': key } } : {})
  let body = null
  try { body = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, code: body?.code, data: body?.data, raw: body }
}

console.log(`=== 开放接口验收自检 ===\nbase=${BASE}\nschool=${SCHOOL}\n时间=${new Date().toISOString()}\n`)

/* ── 1. 连通与鉴权边界 ── */
const ping = await get('/v1/ping')
check('连通性：GET /ping → 200', ping.status === 200, `status=${ping.status}`)
if (ping.data?.client_name) lines.push(`     对接方名称：${ping.data.client_name}`)
check('服务器时间可读（对账时钟）', Boolean(ping.data?.server_time), ping.data?.server_time || '缺 server_time')
const noKey = await get('/v1/ping', { key: null })
check('鉴权：无密钥 → 401 MISSING_KEY', noKey.status === 401 && noKey.code === 'MISSING_KEY', `${noKey.status}/${noKey.code}`)
const badKey = await get('/v1/ping', { key: 'oap_invalid_key_for_selftest' })
check('鉴权：错误密钥 → 401 INVALID_KEY', badKey.status === 401 && badKey.code === 'INVALID_KEY', `${badKey.status}/${badKey.code}`)

/* ── 2. 授权范围 ── */
const profile = await get('/v1/profile')
check('GET /profile → 200', profile.status === 200, `status=${profile.status}`)
const grants = profile.data?.grants || []
const mine = grants.find((g) => g.school_code === SCHOOL)
check(`/profile 中存在学校 ${SCHOOL} 的授权`, Boolean(mine), `已授权学校：${grants.map((g) => g.school_code).join(',') || '（无）'}`)
if (mine) {
  lines.push(`     授权：类型=${(mine.visible_types || []).join('/')}｜检测人姓名=${mine.include_inspector ? '下发' : '不下发'}｜病原体=${mine.include_pathogen ? '开放' : '不开放'}｜日期范围=${mine.start_date || '不限'}~${mine.end_date || '不限'}｜scope_version=${mine.scope_version}`)
}
const schools = await get('/v1/schools')
// 注意：该端点返回的字段是 `school_code`（不是 code），2026-09-23 实测踩过
check('GET /schools → 200 且包含该校', schools.status === 200 && (schools.data?.schools || []).some((s) => s.school_code === SCHOOL), `status=${schools.status} schools=${JSON.stringify((schools.data?.schools || []).map((s) => s.school_code))}`)

/* ── 3. 字典 ↔ 样例 ↔ 真实响应 的字段一致性 ── */
const types = (mine?.visible_types || []).length ? mine.visible_types : ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen']
const samples = await get(`/v1/samples?school_code=${SCHOOL}`)
check('GET /samples → 200', samples.status === 200, `status=${samples.status}`)
const sampleList = samples.data?.samples || []
check('样例均标记 synthetic 且记录码带 SAMPLE- 前缀',
  sampleList.length > 0 && sampleList.every((s) => s.synthetic === true && String(s.item?.record_code || '').startsWith('SAMPLE-')),
  `样例数=${sampleList.length}`)
const failSample = sampleList.find((s) => s.scenario === 'fail')
check('样例：fail 场景确实输出 fail（构造-投影-判定 一致）',
  Boolean(failSample) && failSample.item.final_conclusion === 'fail',
  failSample ? `final_conclusion=${failSample.item.final_conclusion}` : '无 fail 场景')

const dictPaths = new Set()
const dictNotes = []
const dictByType = new Map()       // 类型 → 该类型的字段描述符（供"必现 ↔ 样例"一致性检查）
let sawEmittedFalse = false
for (const t of types) {
  const dict = await get(`/v1/dict?school_code=${SCHOOL}&test_type=${t}`)
  const raw = dict.data?.field_schema?.[t]
  const fields = Array.isArray(raw) ? raw : (raw?.fields || [])
  if (!fields.length) { wn(`字典：类型 ${t} 无字段定义`, '请核对 visible_types 与字段契约'); continue }
  dictByType.set(t, fields)
  for (const f of fields) {
    if (f.emitted !== false) dictPaths.add(f.path)
    if (f.emitted === false) sawEmittedFalse = true
  }
  if (dict.data?.field_schema_notes) dictNotes.push(...dict.data.field_schema_notes)
}
check('字典：字段路径非空（可用于写映射）', dictPaths.size > 0, `已登记字段=${dictPaths.size}`)
check('字典：声明了「不下发」语义（有 emitted:false 的登记，或有字段说明）',
  sawEmittedFalse || dictNotes.length > 0, `emitted:false 条目=${sawEmittedFalse ? '有' : '无'}`)
/* ── 3b. 字典「必现」↔ 样例 一致性（C6 类缺陷：字典声明必现、样例/响应里却没有）──
 * 依据：2026-09-23 对外验收 C6 —— 字典把 result.sampleId/sampleType/sampleInfo 标为必现，
 *       但三个病原体样例全缺这三个键；对接方按字典建严格模型后，连官方样例都通不过。
 * 本检查同时守住两条不变量：① required=true 的字段必须真的出现；② result.* 不得声明 required=true。 */
const sampleByType = new Map()
for (const s of sampleList) {
  if (!sampleByType.has(s.test_type)) sampleByType.set(s.test_type, [])
  sampleByType.get(s.test_type).push(s)
}
const valueAtPath = (item, path) => (path.startsWith('result.') ? item?.result?.[path.slice('result.'.length)] : item?.[path])
const requiredMissing = []
const badRequiredOnResult = []
for (const [t, fields] of dictByType) {
  for (const f of fields) {
    if (f.path.startsWith('result.') && f.required === true) badRequiredOnResult.push(`${t}:${f.path}`)
    if (!f.required || f.emitted === false || f.conditional_on) continue
    for (const s of (sampleByType.get(t) || [])) {
      if (valueAtPath(s.item, f.path) === undefined) requiredMissing.push(`${t}/${s.scenario}:${f.path}`)
    }
  }
}
check('字典「必现(required=true)」字段在合成样例中确实存在（C6 类缺陷）',
  requiredMissing.length === 0,
  requiredMissing.length ? `缺 ${requiredMissing.length} 处：${requiredMissing.slice(0, 6).join(', ')}` : `已核 ${dictByType.size} 个类型`)
check('字典：result.* 不得声明 required=true（来自保存数据，非输出保证）',
  badRequiredOnResult.length === 0, badRequiredOnResult.slice(0, 6).join(', ') || '0 处违反')

const emittedFalse = (await get(`/v1/dict?school_code=${SCHOOL}&test_type=oil`)).data?.field_schema?.oil
const oilFields = Array.isArray(emittedFalse) ? emittedFalse : (emittedFalse?.fields || [])
if (oilFields.length) {
  const tpm = oilFields.find((f) => f.path === 'result.tpmValue')
  if (tpm) check('字典：单位核实状态可见（TPM 标注未核实）', tpm.unit_verified === false || /未核实|平台标注/.test(String(tpm.unit)), JSON.stringify({ unit: tpm.unit, unit_verified: tpm.unit_verified }))
}

/* ── 4. 清单、分页完整性与统计对账 ── */
const manLight = await get(`/v1/sync/manifest?school_code=${SCHOOL}`)
check('GET /sync/manifest → 200 且含 digest', manLight.status === 200 && Boolean(manLight.data?.digest), `status=${manLight.status}`)
const man = await get(`/v1/sync/manifest?school_code=${SCHOOL}&detail=1`)
check('manifest detail=1 → 200 且 complete=true', man.status === 200 && man.data?.complete === true, `complete=${man.data?.complete}`)
const items = man.data?.items || []
check('清单项含 record_code 与 updated_at', items.length === 0 || items.every((i) => i.record_code && i.updated_at), `条数=${items.length}`)

let cursor = null, pages = 0
const seen = new Map()
do {
  const q = `/v1/test-records?school_code=${SCHOOL}&limit=${LIMIT}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
  const page = await get(q)
  if (page.status !== 200) { ng(`分页第 ${pages + 1} 页失败`, `status=${page.status} code=${page.code}`); break }
  pages++
  for (const it of page.data.items || []) seen.set(it.record_code, it.updated_at)
  cursor = page.data.has_more ? page.data.next_cursor : null
  if (pages > 200) { ng('分页超过 200 页，疑似游标未推进', ''); break }
} while (cursor)
check('分页取全且无重复', pages > 0 && seen.size === items.length, `拉取=${seen.size} 清单=${items.length} 页数=${pages}`)
const tsMismatch = items.filter((i) => seen.get(i.record_code) !== i.updated_at)
check('清单与明细逐条对齐（record_code 全覆盖 + updated_at 一致）',
  items.length === 0 || tsMismatch.length === 0,
  tsMismatch.length ? `不一致 ${tsMismatch.length} 条（例：${tsMismatch[0].record_code}）` : `逐条一致 ${items.length} 条`)

const stats = await get(`/v1/stats?school_code=${SCHOOL}`)
check('GET /stats → 200', stats.status === 200, `status=${stats.status}`)
const d = stats.data || {}
const identity = d.universe_total === d.scope_total + d.request_out_of_range_total + d.excluded_total
check('统计三桶恒等式自洽', identity, `universe=${d.universe_total} scope=${d.scope_total} 请求范围外=${d.request_out_of_range_total} 排除=${d.excluded_total}`)
if (d.scope_total === 0) {
  warn++; lines.push(`⚠️  统计分母为 0：该校当前范围内无记录或全部被排除（pass_rate=null 属预期）excluded=${d.excluded_total}`)
} 
lines.push(`     口径：pass_count=${d.pass_count} / scope_total=${d.scope_total}｜pass_rate=${d.pass_rate}｜metric_basis=${d.metric_basis || '（未声明）'}`)
if (d.metric_basis_note) lines.push(`     注：${String(d.metric_basis_note).slice(0, 120)}…`)

/* ── 5. 异常与边界（可解释的 4xx） ── */
const badSchool = await get(`/v1/stats?school_code=__not_authorized__`)
check('未授权学校 → 403/400', [403, 400].includes(badSchool.status), `status=${badSchool.status} code=${badSchool.code}`)
const badType = await get(`/v1/samples?school_code=${SCHOOL}&test_type=__no_such_type__`)
check('未授权类型 → 403 TYPE_NOT_AUTHORIZED', badType.status === 403 && badType.code === 'TYPE_NOT_AUTHORIZED', `${badType.status}/${badType.code}`)
const badCursor = await get(`/v1/test-records?school_code=${SCHOOL}&cursor=not-a-valid-cursor`)
check('非法游标 → 400 INVALID_CURSOR', badCursor.status === 400 && badCursor.code === 'INVALID_CURSOR', `${badCursor.status}/${badCursor.code}`)
const badDate = await get(`/v1/stats?school_code=${SCHOOL}&start=2026-02-30`)
check('日历不存在的日期 → 400 INVALID_START', badDate.status === 400 && badDate.code === 'INVALID_START', `${badDate.status}/${badDate.code}`)
const revRange = await get(`/v1/stats?school_code=${SCHOOL}&start=2026-03-10&end=2026-03-01`)
check('start>end → 400 INVALID_RANGE', revRange.status === 400 && revRange.code === 'INVALID_RANGE', `${revRange.status}/${revRange.code}`)
const emptyRange = await get(`/v1/stats?school_code=${SCHOOL}&start=2099-01-01&end=2099-01-02`)
check('远期范围（无数据）→ 200 且 0 条、pass_rate=null', emptyRange.status === 200 && emptyRange.data?.total === 0 && emptyRange.data?.pass_rate === null, `status=${emptyRange.status} total=${emptyRange.data?.total}`)

/* ── 6. 字段撤回验证（可选） ── */
if (expectInspector === 'false') {
  const page = await get(`/v1/test-records?school_code=${SCHOOL}&limit=20`)
  const leaked = (page.data?.items || []).filter((i) => i.inspector !== undefined).length
  check('授权未开启检测人姓名 → 响应中不得出现 inspector', leaked === 0, `命中 ${leaked} 条`)
  const nested = (page.data?.items || []).some((i) => JSON.stringify(i.result?.recheckRecords || []).includes('复检人'))
  if (nested) wn('复检记录中疑似含人名文本', '请人工核对 result.recheckRecords[].user 是否已剔除')
} else if (expectInspector === 'true') {
  const page = await get(`/v1/test-records?school_code=${SCHOOL}&limit=20`)
  lines.push(`ℹ️  已开启检测人姓名：抽查 ${(page.data?.items || []).length} 条中 inspector 出现 ${(page.data?.items || []).filter((i) => i.inspector !== undefined).length} 条（空值属正常）`)
}

/* ── 汇总 ── */
console.log(lines.join('\n'))
console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${warn} 提示`)
console.log(fail === 0
  ? '契约层自检通过。语义层（结论口径/TPM 单位/复检规则/撤回策略）请按 ONBOARDING_TEST_GUIDE 的人工核对表确认。'
  : '存在失败项：请对照错误码表处理后重跑；仍失败请携带上面的 base/school/时间 与 digest 联系平台方。')
process.exit(fail === 0 ? 0 : 1)
