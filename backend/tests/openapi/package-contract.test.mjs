// 接入包 / 合成样例「生成器契约测试」（2026-09-16 依据外部评审新增）
//
// 目的：把评审提出的自动检查固化，防止"手改下载文件"式修复：
//   ① 场景名与输出结论必须一致（fail 场景必须真的推导出 fail）；
//   ② 样例字段必须全部在字段字典（含白名单）内，且不出现 emitted:false 字段；
//   ③ 含复检的场景，updated_at 必须 ≥ 复检时间（与"复检会刷新更新时间"的承诺一致）；
//   ④ 单位/缩放与语义必须在字典里写明（TPM 数值口径、colorLevel 是等级而非颜色、病原体 riskLevel/positiveDetails 边界）；
//   ⑤ 自动生成的接入包必须包含关键声明（授权快照、以 /profile 为准、next_cursor 语义、413 处理、整体替换、错误码动作列）。
//
// 运行：cd /opt/foodsentinel/backend && node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  listFieldDescriptors,
  allowedResultKeys,
  buildSyntheticSamples,
} from '../../lib/openApiFieldSchema.js'
import { buildOpenRecord } from '../../lib/openApiScope.js'
import { createAdminOpenApiRoutes } from '../../routes/adminOpenApiRoutes.js'

const GRANT = { visible_types: ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'], include_pathogen: true, include_inspector: false }
const CTX = { schoolCode: 'demo', schoolName: '示例学校' }

const projected = (type, scenario, grant = GRANT) => {
  const s = buildSyntheticSamples(type).find((x) => x.scenario === scenario)
  assert.ok(s, `缺少样例 ${type}/${scenario}`)
  return buildOpenRecord(s.record, grant, { ...CTX, allowedResultKeys: allowedResultKeys(type) })
}

/* ───────────── ① 场景 ↔ 结论一致 ───────────── */

test('样例：pass 场景初始与最终结论均为 pass', () => {
  for (const t of ['tableware', 'oil', 'pathogen']) {
    const it = projected(t, 'pass')
    assert.equal(it.initial_conclusion, 'pass', `${t}/pass`)
    assert.equal(it.final_conclusion, 'pass', `${t}/pass`)
    assert.equal(it.final_conclusion_basis, 'initial')
  }
})

test('样例：fail 场景必须真的推导出 fail（评审发现：食用油 fail 样例曾输出 pass）', () => {
  for (const t of ['tableware', 'oil']) {
    const it = projected(t, 'fail')
    assert.equal(it.initial_conclusion, 'fail', `${t}/fail 的 initial_conclusion 必须为 fail`)
    assert.equal(it.final_conclusion, 'fail', `${t}/fail 的 final_conclusion 必须为 fail`)
  }
})

test('样例：recheck_passed 场景 initial=fail、final=pass、basis=recheck', () => {
  for (const t of ['tableware', 'pathogen']) {
    const it = projected(t, 'recheck_passed')
    assert.equal(it.initial_conclusion, 'fail', `${t}/recheck_passed 初检应为不合格`)
    assert.equal(it.final_conclusion, 'pass', `${t}/recheck_passed 最终应为合格`)
    assert.equal(it.final_conclusion_basis, 'recheck')
  }
})

test('样例：病原体 positive 场景 is_positive=true，pass 场景为 false', () => {
  assert.equal(projected('pathogen', 'positive').is_positive, true)
  assert.equal(projected('pathogen', 'pass').is_positive, false)
})

/* ───────────── ② 样例字段 ⊆ 字典；不下发字段不出现 ───────────── */

test('样例：result 内每个键都在字段字典/白名单内，且不含 emitted:false 字段', () => {
  for (const t of ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen']) {
    const allowed = allowedResultKeys(t)
    for (const s of buildSyntheticSamples(t)) {
      const it = buildOpenRecord(s.record, GRANT, { ...CTX, allowedResultKeys: allowed })
      for (const k of Object.keys(it.result)) {
        assert.ok(allowed.has(k), `${t}/${s.scenario} 下发了未登记字段 result.${k}`)
      }
      assert.equal(JSON.stringify(it.result).includes('"inspector"'), false, `${t}/${s.scenario} 不得出现 result.inspector`)
    }
  }
})

test('样例：字典字段表内没有 emitted:false 的字段被样例实际下发', () => {
  const notEmitted = listFieldDescriptors('pathogen').filter((f) => f.emitted === false).map((f) => f.path)
  assert.ok(notEmitted.includes('result.inspector'), '基线：result.inspector 应标注 emitted:false')
  const it = projected('pathogen', 'positive')
  for (const p of notEmitted) assert.equal(p in it.result, false)
})

/* ───────────── ③ 复检时间与 updated_at 自洽 ───────────── */

test('样例：含复检场景的 updated_at 必须不早于复检时间（评审发现的时间不自洽）', () => {
  for (const [t, path] of [['tableware', 'recheckRecords'], ['pathogen', 'recheckReports']]) {
    const s = buildSyntheticSamples(t).find((x) => x.scenario === 'recheck_passed')
    const it = buildOpenRecord(s.record, GRANT, { ...CTX, allowedResultKeys: allowedResultKeys(t) })
    const recheck = (it.result[path] || [])[0]
    assert.ok(recheck?.time, `${t} 复检样例应含复检时间`)
    const recheckMs = new Date(String(recheck.time).replace(' ', 'T') + '+08:00').getTime()
    const updatedMs = new Date(it.updated_at).getTime()
    assert.ok(Number.isFinite(recheckMs) && Number.isFinite(updatedMs), '时间应可解析')
    assert.ok(updatedMs >= recheckMs, `${t} updated_at(${it.updated_at}) 必须不早于复检时间(${recheck.time})`)
  }
})

/* ───────────── ④ 单位/语义已写明 ───────────── */

test('字典：TPM 写明数值口径与缩放（不得含糊），colorLevel 不得称为颜色', () => {
  const oil = listFieldDescriptors('oil')
  const tpm = oil.find((f) => f.path === 'result.tpmValue')
  assert.match(String(tpm.unit), /g\/100g/)
  assert.match(tpm.description, /0\.06/, '必须给出示例值口径')
  assert.match(tpm.description, /勿|不要/, '必须明确"不要再 ×100"')
  assert.match(tpm.description, /0\.13|0\.25/, '必须写明判定阈值')

  const color = oil.find((f) => f.path === 'result.colorLevel')
  assert.equal(color.label.includes('颜色'), false, 'colorLevel 实为综合品质等级，标签不得写"颜色"')
  assert.deepEqual(color.enum, ['合格', '警戒', '不合格'])
})

test('字典：病原体 riskLevel 枚举完整、positiveDetails 声明为检出权威依据、finalStatus 标明病原体不产出', () => {
  const p = listFieldDescriptors('pathogen')
  assert.deepEqual(p.find((f) => f.path === 'result.riskLevel').enum, ['无风险', '低风险', '极低风险'])
  assert.match(p.find((f) => f.path === 'result.positiveDetails').description, /权威依据|非空/)
  const tablewareFinal = listFieldDescriptors('tableware').find((f) => f.path === 'result.finalStatus')
  assert.match(tablewareFinal.description, /病原体/, '应说明病原体不产出 finalStatus')
})

/* ───────────── ⑤ 接入包文本关键声明 ───────────── */

const makeRes = () => ({
  statusCode: 200, md: null, headers: {},
  status(c) { this.statusCode = c; return this },
  json(b) { this.md = b; return this },
  send(b) { this.md = b; return this },
  setHeader(k, v) { this.headers[k] = v },
})

async function renderPackage() {
  const prismaStub = {
    openApiClient: {
      findUnique: async () => ({
        id: 'client-demo-1', name: '示例对接方',
        grants: [
          { id: 'g1', client_id: 'client-demo-1', school_code: 'demo', status: 'active', scope_version: 1, visible_types: ['tableware', 'oil', 'pathogen'], include_pathogen: true, include_inspector: false, start_date: null, end_date: null },
          { id: 'g2', client_id: 'client-demo-1', school_code: 'other', status: 'disabled', scope_version: 2, visible_types: ['oil'], include_pathogen: false, include_inspector: false, start_date: null, end_date: null },
        ],
      }),
    },
    school: { findMany: async () => [{ code: 'demo', name: '示例学校' }] },
    schoolCustomization: { findMany: async () => [{ school_code: 'demo', custom_fields: {}, field_labels: {} }] },
  }
  const router = createAdminOpenApiRoutes({ prisma: prismaStub, authenticateUser: (r, s, n) => n(), requirePlatformSuperAdmin: (r, s, n) => n() })
  let handler = null
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === '/clients/:id/package' && layer.route.methods.get) {
      handler = layer.route.stack[layer.route.stack.length - 1].handle
    }
  }
  assert.ok(handler, '接入包路由未找到')
  const res = makeRes()
  await handler({ params: { id: 'client-demo-1' }, get: () => 'foodsentinel.digifluidic.com' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(typeof res.md, 'string')
  return res.md
}

test('接入包：含快照声明、认证说明、快速开始与错误码动作列', async () => {
  const md = await renderPackage()
  for (const kw of [
    '授权快照',                 // 生成时快照声明
    '`GET /profile` 为准',      // 实际权限以 profile 为准
    '同一个密钥',               // 认证措辞（避免误读为"两种密钥"）
    '快速开始',                 // 可直接运行的请求示例
    '你方应做什么',             // 错误码动作列
  ]) {
    assert.ok(md.includes(kw), `接入包应包含「${kw}」`)
  }
  assert.equal(md.includes('## 0. 快速开始（可直接复制运行）'), true)
  assert.equal(md.includes('| HTTP | code | 含义 | 你方应做什么 |'), true)
})

test('接入包：含同步顺序、next_cursor 语义、413 处理与整体替换规则', async () => {
  const md = await renderPackage()
  for (const kw of ['不得当作空清单', 'next_cursor', '整体覆盖', '重试必须有上限', '当前有效范围内已不可见']) {
    assert.ok(md.includes(kw), `接入包应包含「${kw}」`)
  }
  // 删除/撤回判定必须排在 digest 二读之后（评审：顺序不能颠倒）
  const idxDigestSecondRead = md.indexOf('再取一次')
  const idxInvisible = md.indexOf('当前有效范围内已不可见')
  assert.ok(idxDigestSecondRead > 0 && idxInvisible > idxDigestSecondRead, '撤回/删除判定应出现在 digest 二读之后')
})

test('接入包：字段字典公共字段只列一次（不再按类型重复 5 遍），并给出专属字段分节', async () => {
  const md = await renderPackage()
  assert.ok(md.includes('公共字段只列一次'), '必须有"公共字段只列一次"的说明')
  // 公共字段行（顶层 test_type）只应出现一次
  const occurrences = md.split('\n').filter((l) => l.startsWith('| `test_type` |')).length
  assert.equal(occurrences, 1, `公共字段 test_type 应只出现一次，实际 ${occurrences}`)
  assert.ok(md.includes('· 专属字段'), '每类型应有专属字段分节')
  // 字段表总行数应显著小于"公共字段 × 类型数"的全量重复写法
  const rows = md.split('\n').filter((l) => /^\| `[a-z_]/i.test(l)).length
  assert.ok(rows < 90, `字段表行数应精简（当前 ${rows}）`)
})

test('接入包：字段表可见枚举取值、数组子结构与"不下发"标记', async () => {
  const md = await renderPackage()
  assert.ok(md.includes('取值：pass / fail / warning / unknown'), '枚举取值必须列出（不止写 enum）')
  assert.ok(md.includes('取值：initial / recheck'), 'final_conclusion_basis 枚举可见')
  assert.ok(md.includes('元素：'), '数组元素子结构必须列出（item_fields）')
  const inspectorRow = md.split('\n').find((l) => l.startsWith('| `result.inspector` |'))
  assert.ok(inspectorRow, 'result.inspector 应出现在字典表中（说明其不下发）')
  assert.ok(inspectorRow.includes('**否**'), 'result.inspector 的「下发」列必须为否')
  assert.ok(md.includes('**必现**只是**当前数据分布观察**'), '必须说明 required 是数据观察而非输出保证')
})

test('接入包：TPM 单位核实状态必须可见（平台标注 / 设备单位未核实）', async () => {
  const md = await renderPackage()
  const row = md.split('\n').find((l) => l.startsWith('| `result.tpmValue` |'))
  assert.ok(row, '接入包应包含 result.tpmValue 行')
  assert.ok(row.includes('未核实'), `单位列必须标注未核实：${row}`)
  assert.ok(/平台标注|platform_label/.test(md), '读表须知必须说明"单位仅为平台标注"')
  assert.ok(md.includes('请勿自行换算'), '必须禁止读者自行换算')
  assert.ok(!/0\.06`.{0,20}表示 0\.06 g\/100g，等价/.test(md), '不得再出现"等价于 %"式的断言表述')
})

test('接入包：参数行为与 profile 字段说明与实现一致', async () => {
  const md = await renderPackage()
  assert.ok(md.includes('`limit` 默认 **100**、上限 **200**'), 'limit 行为必须写明')
  assert.ok(md.includes('INVALID_START') && md.includes('INVALID_RANGE'), '日期参数错误码必须写明')
  assert.ok(md.includes('两端含当天'), '日期边界语义必须写明（闭区间）')
  assert.ok(md.includes('**不含** projection_fingerprint'), '必须纠正 profile 含 projection_fingerprint 的错误说法')
})

test('接入包：合成样例段落中，fail 场景的结论与场景名一致', async () => {
  const md = await renderPackage()
  const blocks = md.split('### ')
  for (const b of blocks) {
    const head = b.split('\n')[0]
    if (!/\/ (fail|pass|recheck_passed|positive)$/.test(head.trim())) continue
    const scenario = head.trim().split('/').pop()
    const finalMatch = b.match(/"final_conclusion": "([a-z]+)"/)
    assert.ok(finalMatch, `${head} 应包含 final_conclusion`)
    if (scenario === 'fail') assert.equal(finalMatch[1], 'fail', `${head} 结论必须为 fail`)
    if (scenario === 'pass') assert.equal(finalMatch[1], 'pass', `${head} 结论必须为 pass`)
    if (scenario === 'recheck_passed') assert.equal(finalMatch[1], 'pass', `${head} 复检后应合格`)
  }
})
