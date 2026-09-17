// /v1/stats 日期口径 · 数据库级集成回归（必须使用隔离测试库；未设环境变量则整体跳过）
//
// 历史：2026-09-16 线上故障 —— `/stats` 带 start/end 必 500，根因是 `text >= date` 无隐式转换。
// 2026-09-17 P0/P1 修复后锁定以下**不变量**（全部在隔离库用真实 SQL 验证）：
//   ① 日期参数不再 500；非法 → 400；start>end → 400；交集空 → 200 且 0 条。
//   ② 统计只在「授权可见全集」内进行：授权业务日期范围外的记录**不出现在任何字段中**
//      （含数量也不可推断 —— 授权外数量侧信道，P1-1）。
//   ③ 桶互斥且数学自洽：universe_total = scope_total + request_out_of_range_total + excluded_total（P1-2）。
//   ④ 无任何日期范围时，日期缺失/非法/日历不存在的记录**不得**进入 scope_total（防 `inRangeSql || TRUE` 回归）。
//   ⑤ 日历脏值（2026-02-30 / 2026-13-01 / 2026-00-10）不得被判为有效，也不得触发 500。
//   ⑥ oil 判定走显式枚举（未识别等级不得默认合格），与 lib/openApiScope.deriveConclusion 一致。
//
// 启用：
//   REVIEW_TEST_DATABASE_URL='postgresql://USER:PASS@127.0.0.1:5432/foodsentinel_review_test' \
//     node --test tests/openapi/stats-date.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  require, isConfigured, assertIsolationConfig, assertIsolated as sharedAssertIsolated,
} from '../_isolation.mjs'

const URL_ = process.env.REVIEW_TEST_DATABASE_URL || ''
const TENANT_CODE = 'reviewtest'
const TENANT_SCHEMA = `school_${TENANT_CODE}`
const enabled = isConfigured()

if (!enabled) {
  test('/v1/stats 日期口径（未设置 REVIEW_TEST_DATABASE_URL，跳过）', { skip: 'SKIP: TEST_DATABASE_URL not configured' }, () => {})
}

if (enabled) {
  // 配置级门禁（F8）：解析连接串后校验**库名**（不是整串匹配）+ 专用测试 schema
  const iso = assertIsolationConfig({ schema: TENANT_SCHEMA })
  const DB_NAME = iso.db

  // ⚠️ 安全要点：`lib/tenantClient.js` 的 baseDatabaseUrl() 读的是 **process.env.DATABASE_URL**
  // （不是传入的 prisma 实例）——测试进程若带着生产 DATABASE_URL，路由内的 createTenantClient
  // 会连到生产库。这里必须先把它指向隔离库，再创建任何客户端。
  process.env.DATABASE_URL = URL_

  const { PrismaClient } = require('@prisma/client')
  const { createOpenApiRoutes } = await import('../../routes/openApiRoutes.js')
  const { buildOpenRecord } = await import('../../lib/openApiScope.js')

  const prisma = new PrismaClient({ datasources: { db: { url: URL_ } } })
  const tenant = new PrismaClient({ datasources: { db: { url: `${URL_}${URL_.includes('?') ? '&' : '?'}schema=${TENANT_SCHEMA}` } } })

  /** 运行时安全断言（F8）：真实库名必须等于配置解析出的隔离库；租户客户端还需确认 current_schema。 */
  async function assertIsolated(client, label, expectSchema) {
    const { schema } = await sharedAssertIsolated(client, iso.db, label)
    if (expectSchema) assert.equal(schema, expectSchema, `安全校验失败：${label} 的 current_schema 不是 ${expectSchema}`)
  }

  const CLIENT_ID = 'stats-test-client'
  // 固定数据集：6 条有效日期（含 oil 四种等级形态）+ 5 条日期脏数据
  const FIXTURES = [
    { code: 'RC-stats-1', type: 'oil', day: '2026-01-15', result: { colorLevel: '合格', tpmValue: '0.06' } },              // 已知合格 → pass
    { code: 'RC-stats-2', type: 'oil', day: '2026-01-31', result: { colorLevel: '不合格', tpmValue: '0.31' } },             // 已知不合格 → 不计入 pass
    { code: 'RC-stats-3', type: 'oil', day: '2026-02-01', result: { colorLevel: '警戒', tpmValue: '0.20' } },               // 授权范围外（授权 1 月时）
    { code: 'RC-stats-4', type: 'oil', day: '2026-01-25', result: { colorLevel: '深绿色', result: '合格' } },               // 未识别等级 → 回退 result 文本
    { code: 'RC-stats-5', type: 'tableware', day: '2026-01-20', result: { result: '合格 (<200)' } },
    { code: 'RC-stats-6', type: 'pathogen', day: '2026-01-10', result: { riskLevel: '无风险' } },
    { code: 'RC-stats-7', type: 'tableware', day: '2026-1-5', result: { result: '合格 (<200)' } },                          // 格式非法
    { code: 'RC-stats-8', type: 'tableware', day: '2026-02-30', result: { result: '合格 (<200)' } },                        // 日历不存在
    { code: 'RC-stats-9', type: 'tableware', day: '2026-13-01', result: { result: '合格 (<200)' } },                        // 月份非法
    { code: 'RC-stats-10', type: 'tableware', day: '2026-00-10', result: { result: '合格 (<200)' } },                       // 月份 00
    { code: 'RC-stats-11', type: 'tableware', day: null, result: { result: '不合格 (>500)' } },                             // 日期缺失
  ]
  const VALID_TOTAL = 6
  const INVALID_TOTAL = 5
  const TOTAL_ROWS = VALID_TOTAL + INVALID_TOTAL

  const res0 = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
    setHeader() {},
  })

  function handlerOf(router, path) {
    for (const layer of router.stack) {
      if (layer.route && layer.route.path === path && layer.route.methods.get) {
        return layer.route.stack[layer.route.stack.length - 1].handle
      }
    }
    throw new Error(`未找到路由 ${path}`)
  }

  async function callGet(path, query) {
    const router = createOpenApiRoutes({ prisma })
    const res = res0()
    await handlerOf(router, path)({ openApi: { client: { id: CLIENT_ID }, credential: {} }, query }, res)
    return res
  }
  const callStats = (query) => callGet('/v1/stats', query)

  async function setGrant({ start = null, end = null } = {}) {
    await prisma.openApiGrant.updateMany({
      where: { client_id: CLIENT_ID },
      data: {
        start_date: start ? new Date(`${start}T00:00:00Z`) : null,
        end_date: end ? new Date(`${end}T00:00:00Z`) : null,
      },
    })
  }

  test.before(async () => {
    await assertIsolated(prisma, 'public 客户端')
    await assertIsolated(tenant, '租户客户端', TENANT_SCHEMA)
    await prisma.school.upsert({
      where: { code: TENANT_CODE },
      update: { status: 'active' },
      create: { code: TENANT_CODE, name: '回归测试学校', status: 'active' },
    })
    await prisma.openApiClient.upsert({
      where: { id: CLIENT_ID },
      update: {},
      create: { id: CLIENT_ID, name: 'stats 回归测试', status: 'active', ip_whitelist: [], rate_limit_per_min: 600 },
    })
    const existing = await prisma.openApiGrant.findFirst({ where: { client_id: CLIENT_ID, school_code: TENANT_CODE } })
    if (!existing) {
      await prisma.openApiGrant.create({
        data: {
          client_id: CLIENT_ID, school_code: TENANT_CODE, status: 'active',
          visible_types: ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'],
          include_pathogen: true, include_inspector: false, scope_version: 1,
        },
      })
    }
    await tenant.user.upsert({
      where: { id: 'u-stats-test' },
      update: {},
      create: { id: 'u-stats-test', username: 'stats-test', password_hash: 'x', role: 'manager', full_name: '统计回归' },
    })
    await tenant.testRecord.deleteMany({ where: { record_code: { startsWith: 'RC-stats-' } } })
    for (const f of FIXTURES) {
      const sample = f.day === null
        ? { canteen: '回归食堂', inspector: '测试员' }
        : { testDate: f.day, canteen: '回归食堂', inspector: '测试员' }
      await tenant.testRecord.create({
        data: {
          record_code: f.code, test_type: f.type, test_name: f.type,
          sample_info: sample, result_data: f.result, status: 'completed', version: 1,
          created_by: 'u-stats-test',
        },
      })
    }
  })

  test.after(async () => {
    await tenant.testRecord.deleteMany({ where: { record_code: { startsWith: 'RC-stats-' } } })
    await setGrant({})
    await prisma.$disconnect()
  })

  /* ───────── ① 复现修复点：带日期不再 500 ───────── */

  test('start+end（远期空结果）返回 200 且为 0 条，不再 500', async () => {
    const r = await callStats({ school_code: TENANT_CODE, start: '2099-01-01', end: '2099-01-02' })
    assert.equal(r.statusCode, 200, `期望 200，实际 ${r.statusCode}（旧实现此处 500: operator does not exist: text >= date）`)
    assert.equal(r.body.data.total, 0)
    assert.equal(r.body.data.pass_rate, null, '分母为 0 时必须返回 null，不得返回 0')
    assert.equal(r.body.data.request_out_of_range_total, VALID_TOTAL, '有效日期记录全部落在请求范围外')
    assert.equal(r.body.data.universe_total, TOTAL_ROWS, '全集 = scope + 请求范围外 + 排除')
  })

  test('仅 start / 仅 end / 同一天（闭区间）均可正常返回', async () => {
    const a = await callStats({ school_code: TENANT_CODE, start: '2026-01-16' })
    assert.equal(a.statusCode, 200)
    assert.equal(a.body.data.scope_total, 4, '01-20 / 01-25 / 01-31 / 02-01')

    const b = await callStats({ school_code: TENANT_CODE, end: '2026-01-15' })
    assert.equal(b.statusCode, 200)
    assert.equal(b.body.data.scope_total, 2, '01-10 / 01-15')

    const c = await callStats({ school_code: TENANT_CODE, start: '2026-01-31', end: '2026-01-31' })
    assert.equal(c.body.data.scope_total, 1, '上边界当天必须计入（闭区间）')
    assert.equal(c.body.data.pass_count, 0, 'colorLevel=不合格 不计入 pass')
  })

  test('非法日期 → 400（可解释），不再是 500；start>end → 400', async () => {
    for (const [q, code] of [
      [{ start: 'abc' }, 'INVALID_START'],
      [{ start: '2026-02-30' }, 'INVALID_START'],
      [{ end: '2026-13-01' }, 'INVALID_END'],
      [{ start: '2026/01/15' }, 'INVALID_START'],
    ]) {
      const r = await callStats({ school_code: TENANT_CODE, ...q })
      assert.equal(r.statusCode, 400, `${JSON.stringify(q)} 应 400`)
      assert.equal(r.body.code, code)
    }
    const bad = await callStats({ school_code: TENANT_CODE, start: '2026-02-01', end: '2026-01-01' })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.body.code, 'INVALID_RANGE')
  })

  /* ───────── ③④⑤ 集合互斥 / 无范围不得双计 / 日历脏值 ───────── */

  test('无任何日期参数：scope_total 只含日期合法的记录（防 inRangeSql||TRUE 双计回归）', async () => {
    const r = await callStats({ school_code: TENANT_CODE })
    const d = r.body.data
    assert.equal(d.scope_total, VALID_TOTAL, `scope_total 必须是 ${VALID_TOTAL}（6 条有效日期），而不是全部 ${TOTAL_ROWS} 行`)
    assert.equal(d.request_out_of_range_total, 0, '未限定请求范围 → 不存在"请求范围外"')
    assert.equal(d.excluded_total, INVALID_TOTAL, '日期缺失/格式非法/日历不存在 = 5')
    assert.equal(d.universe_total, TOTAL_ROWS, '恒等式：6 + 0 + 5 = 11')
    assert.equal(d.included_total, d.scope_total)
    assert.equal(d.pass_rate_detail.denominator, d.scope_total)
    // 桶互斥：excluded 的记录不得出现在 scope_total 里
    assert.equal(d.scope_total + d.request_out_of_range_total + d.excluded_total, d.universe_total)
  })

  test('日历脏值（2026-02-30/13-01/00-10）不被判为有效，且不触发 500', async () => {
    const r = await callStats({ school_code: TENANT_CODE })
    assert.equal(r.statusCode, 200)
    const d = r.body.data
    assert.equal(d.excluded_total, INVALID_TOTAL)
    assert.equal(d.excluded[0].count, INVALID_TOTAL)
    assert.match(d.excluded[0].label, /日历不存在|格式非法/)
    // 逐条确认：这 4 条脏日期既不在 scope_total，也不在 request_out_of_range_total
    assert.ok(d.scope_total === VALID_TOTAL && d.request_out_of_range_total === 0)
  })

  test('投影侧：日历脏值的 test_date 必须为 null（不得当作正常日期下发）', async () => {
    const rows = await tenant.$queryRawUnsafe(
      `SELECT "sample_info" FROM "${TENANT_SCHEMA}"."TestRecord" WHERE "record_code" IN ('RC-stats-8','RC-stats-9','RC-stats-7')`,
    )
    const grant = { visible_types: ['tableware'], include_inspector: false, scope_version: 1 }
    for (const row of rows) {
      const out = buildOpenRecord({ id: 'x', record_code: 'x', test_type: 'tableware', sample_info: row.sample_info, result_data: {}, status: 'completed', version: 1 }, grant, { schoolCode: TENANT_CODE })
      assert.equal(out.test_date, null, '日历不存在/格式非法的 testDate 不得作为 test_date 下发')
    }
  })

  test('oil 判定走显式枚举：已知等级按裁定，未识别等级回退 result 文本（不得默认合格）', async () => {
    const r = await callStats({ school_code: TENANT_CODE, start: '2026-01-15', end: '2026-01-31' })
    assert.equal(r.statusCode, 200)
    const oil = r.body.data.by_type.find((t) => t.test_type === 'oil')
    assert.ok(oil, '应包含 oil 分型')
    assert.equal(oil.scope_total, 3, '01-15 合格 / 01-25 深绿色+result合格 / 01-31 不合格')
    assert.equal(oil.pass_count, 2, '合格 + （未识别等级回退 result=合格）→ 2 条；不合格不计入')
  })

  /* ───────── ② 授权边界：授权范围外的记录数量不可推断（P1-1） ───────── */

  test('Test F：授权日期范围外的记录数量变化，不得影响任何返回值', async () => {
    await setGrant({ start: '2026-01-01', end: '2026-01-31' })
    try {
      const baseline = await callStats({ school_code: TENANT_CODE })
      assert.equal(baseline.statusCode, 200)
      const b = baseline.body.data
      assert.equal(b.universe_total, 5, '授权 1 月内有效日期记录 = 5（02-01 在授权外）')
      assert.equal(b.scope_total, 5)
      assert.equal(b.request_out_of_range_total, 0)
      assert.equal(b.excluded_total, 0, '授权带日期范围时，无法归属的脏日期不计入任何字段')

      // 注入 999 条授权范围外（2025-06）的记录
      const tpl = FIXTURES[0]
      const vals = []
      for (let i = 0; i < 999; i++) {
        vals.push(`('out-${i}','RC-stats-out-${i}','oil','oil','{"testDate":"2025-06-01","canteen":"范围外","inspector":"测试员"}'::jsonb,'{"colorLevel":"合格"}'::jsonb,'completed',1,'u-stats-test',now(),now())`)
      }
      await tenant.$executeRawUnsafe(
        `INSERT INTO "${TENANT_SCHEMA}"."TestRecord" ("id","record_code","test_type","test_name","sample_info","result_data","status","version","created_by","created_at","updated_at") VALUES ${vals.join(',')}`,
      )
      const after = await callStats({ school_code: TENANT_CODE })
      const a = after.body.data
      for (const k of ['universe_total', 'scope_total', 'included_total', 'request_out_of_range_total', 'excluded_total', 'total', 'pass_count', 'pass_rate']) {
        assert.equal(a[k], b[k], `授权外记录不得影响 ${k}（该字段会形成授权外数量侧信道）`)
      }
      assert.deepEqual(a.by_type, b.by_type, 'by_type 也不得受影响')
      assert.equal(a.range.grant.start, '2026-01-01')

      await tenant.testRecord.deleteMany({ where: { record_code: { startsWith: 'RC-stats-out-' } } })
      const restored = await callStats({ school_code: TENANT_CODE })
      assert.equal(restored.body.data.universe_total, 5)
    } finally {
      await setGrant({})
    }
  })

  test('授权范围 ∩ 请求范围：请求不得越权扩大；交集空 → 200 且 0 条', async () => {
    await setGrant({ start: '2026-01-01', end: '2026-01-31' })
    try {
      const narrowed = await callStats({ school_code: TENANT_CODE, start: '2026-01-16', end: '2026-02-28' })
      assert.equal(narrowed.statusCode, 200)
      assert.equal(narrowed.body.data.range.effective.start, '2026-01-16', '取较晚者')
      assert.equal(narrowed.body.data.range.effective.end, '2026-01-31', '不得越过授权上界')
      assert.equal(narrowed.body.data.scope_total, 3, '01-20 / 01-25 / 01-31')
      assert.equal(narrowed.body.data.request_out_of_range_total, 2, '01-10 / 01-15 在授权内但超出请求')
      assert.equal(narrowed.body.data.universe_total, 5)
      assert.equal(narrowed.body.data.range.authorization_boundary !== undefined, true, '必须显式声明授权边界语义')

      const empty = await callStats({ school_code: TENANT_CODE, start: '2026-03-01', end: '2026-03-31' })
      assert.equal(empty.statusCode, 200, '交集为空是合法请求')
      assert.equal(empty.body.data.scope_total, 0)
      assert.equal(empty.body.data.pass_rate, null)
      assert.equal(empty.body.data.range.empty, true)
      assert.equal(empty.body.data.request_out_of_range_total, 5, '授权内记录都超出请求范围（仍是授权内数据，可返回）')
      assert.equal(empty.body.data.universe_total, 5)
    } finally {
      await setGrant({})
    }
  })

  test('Test G：桶互斥与 by_type 汇总一致（含授权范围场景）', async () => {
    await setGrant({ start: '2026-01-01', end: '2026-01-31' })
    try {
      const r = await callStats({ school_code: TENANT_CODE, start: '2026-01-16', end: '2026-01-20' })
      const d = r.body.data
      assert.equal(d.universe_total, d.scope_total + d.request_out_of_range_total + d.excluded_total)
      const sum = (k) => d.by_type.reduce((s, t) => s + t[k], 0)
      for (const k of ['scope_total', 'included_total', 'universe_total', 'excluded_total', 'request_out_of_range_total', 'pass_count']) {
        assert.equal(sum(k), d[k], `by_type 汇总 ${k} 必须等于顶层 ${k}`)
      }
      // 每个分型的桶也必须互斥
      for (const t of d.by_type) {
        assert.equal(t.universe_total, t.scope_total + t.request_out_of_range_total + t.excluded_total, `${t.test_type} 桶不自洽`)
      }
    } finally {
      await setGrant({})
    }
  })

  /* ───────── 其他 ───────── */

  test('接受 ISO8601 日期时间（取日期部分）', async () => {
    const r = await callStats({ school_code: TENANT_CODE, start: '2026-01-15T10:00:00+08:00', end: '2026-01-20T23:59:59+08:00' })
    assert.equal(r.statusCode, 200)
    assert.equal(r.body.data.scope_total, 2, '2026-01-15 与 2026-01-20')
  })

  test('时区无关：业务日期按文本比较，会话时区改变不改变结果', async () => {
    const sql = `SELECT count(*)::int AS n FROM "${TENANT_SCHEMA}"."TestRecord"
                 WHERE substring(COALESCE("sample_info"->>'testDate','') from 1 for 10) >= '2026-01-16'
                   AND substring(COALESCE("sample_info"->>'testDate','') from 1 for 10) <= '2026-01-20'
                   AND substring(COALESCE("sample_info"->>'testDate','') from 1 for 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`
    const utc = await tenant.$transaction([tenant.$executeRawUnsafe(`SET TIME ZONE 'UTC'`), tenant.$queryRawUnsafe(sql)])
    const sh = await tenant.$transaction([tenant.$executeRawUnsafe(`SET TIME ZONE 'Asia/Shanghai'`), tenant.$queryRawUnsafe(sql)])
    assert.equal(Number(utc[1][0].n), Number(sh[1][0].n))
    assert.equal(Number(utc[1][0].n), 1)
  })

  test('同源缺陷已修：授权带日期范围时 /test-records 与 /sync/manifest 不再 500 且只返回授权范围内记录', async () => {
    await setGrant({ start: '2026-01-01', end: '2026-01-31' })
    try {
      const q = { school_code: TENANT_CODE, limit: '10' }
      const records = await callGet('/v1/test-records', q)
      assert.equal(records.statusCode, 200)
      assert.equal(records.body.data.count, 5, '授权 1 月内 5 条有效日期记录（02-01 与脏日期除外）')
      const manifest = await callGet('/v1/sync/manifest', { school_code: TENANT_CODE, detail: '1' })
      assert.equal(manifest.statusCode, 200)
      assert.equal(manifest.body.data.total, 5)
    } finally {
      await setGrant({})
    }
  })
}
