// /v1/stats 日期口径 · 数据库级集成回归（必须使用隔离测试库；未设环境变量则整体跳过）
//
// 复现并锁定 2026-09-16 线上故障：`/stats` 带 start/end 时 500。
// 根因（已用 psql 复现）：业务日期是**文本**（sample_info->>'testDate' 前 10 位），
// 而旧实现写成 `substring(...) >= $N::date`；PostgreSQL 无 text→date 隐式转换 →
// `ERROR: operator does not exist: text >= date`。
// 同一根因还潜伏在 dateClause()（/test-records、/sync/manifest 在授权带日期范围时同样 500）。
//
// 启用：
//   REVIEW_TEST_DATABASE_URL='postgresql://…/foodsentinel_review_test' \
//     node --test tests/openapi/stats-date.integration.test.mjs
// 隔离库需已 push schema：public（系统表）+ school_reviewtest（租户表）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire('/opt/foodsentinel/backend/package.json')

const URL_ = process.env.REVIEW_TEST_DATABASE_URL || ''
const TENANT_CODE = process.env.REVIEW_TEST_SCHOOL_CODE || 'reviewtest'
const TENANT_SCHEMA = `school_${TENANT_CODE}`
const DB_NAME = URL_.split('?')[0].split('/').pop()
const enabled = Boolean(URL_)

if (!enabled) {
  test('/v1/stats 日期口径（未设置 REVIEW_TEST_DATABASE_URL，跳过）', { skip: '需要隔离测试库' }, () => {})
}

if (enabled) {
  if (!/review[_-]?test/i.test(URL_)) throw new Error('REVIEW_TEST_DATABASE_URL 必须指向隔离测试库（库名含 review_test）')

  // ⚠️ 安全要点：`lib/tenantClient.js` 的 baseDatabaseUrl() 读的是 **process.env.DATABASE_URL**
  // （不是传入的 prisma 实例）——测试进程若带着生产 DATABASE_URL，路由内的 createTenantClient
  // 会连到生产库。这里必须先把它指向隔离库，再创建任何客户端。
  process.env.DATABASE_URL = URL_

  const { PrismaClient } = require('@prisma/client')
  const { createOpenApiRoutes } = await import('../../routes/openApiRoutes.js')

  const prisma = new PrismaClient({ datasources: { db: { url: URL_ } } })
  // 租户客户端显式带上 schema 参数（不依赖 createTenantClient 的 env 派生）
  const tenant = new PrismaClient({ datasources: { db: { url: `${URL_}${URL_.includes('?') ? '&' : '?'}schema=${TENANT_SCHEMA}` } } })

  /** 运行时安全断言：任何写操作前确认连的是隔离库。 */
  async function assertIsolated(client, label) {
    const rows = await client.$queryRawUnsafe('SELECT current_database() AS db')
    assert.equal(rows[0].db, DB_NAME, `安全校验失败：${label} 连到的不是隔离库 ${DB_NAME}`)
  }

  const CLIENT_ID = 'stats-test-client'
  const DAY = (d) => `${d}`
  // 登记码 → 业务日期（含边界、越界、非法、缺失四类）
  const FIXTURES = [
    { code: 'RC-stats-1', type: 'oil', day: DAY('2026-01-15'), result: { colorLevel: '合格' } },            // 范围内·合格
    { code: 'RC-stats-2', type: 'oil', day: DAY('2026-01-31'), result: { colorLevel: '不合格' } },           // 授权上边界·不合格
    { code: 'RC-stats-3', type: 'oil', day: DAY('2026-02-01'), result: { colorLevel: '合格' } },            // 授权范围外
    { code: 'RC-stats-4', type: 'tableware', day: DAY('2026-01-20'), result: { result: '合格 (<200)' } },   // 范围内·合格
    { code: 'RC-stats-5', type: 'pathogen', day: DAY('2026-01-10'), result: { riskLevel: '无风险' } },      // 范围内·合格
    { code: 'RC-stats-6', type: 'tableware', day: '2026-1-5', result: { result: '合格 (<200)' } },          // 日期格式非法 → excluded
    { code: 'RC-stats-7', type: 'tableware', day: null, result: { result: '不合格 (>500)' } },              // 日期缺失 → excluded
  ]

  const res0 = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
    setHeader() {},
  })

  /** 以真实 handler 调 /v1/stats（绕过 API Key 中间件：直接注入 req.openApi）。 */
  async function callStats(query) {
    const router = createOpenApiRoutes({ prisma })
    let handler = null
    for (const layer of router.stack) {
      if (layer.route && layer.route.path === '/v1/stats' && layer.route.methods.get) {
        handler = layer.route.stack[layer.route.stack.length - 1].handle
      }
    }
    assert.ok(handler, '未找到 /v1/stats 路由')
    const res = res0()
    await handler({ openApi: { client: { id: CLIENT_ID }, credential: {} }, query }, res)
    return res
  }

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
    await assertIsolated(tenant, '租户客户端')
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
      const sample = f.day === null ? { canteen: '回归食堂', inspector: '测试员' } : { testDate: f.day, canteen: '回归食堂', inspector: '测试员' }
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
    await prisma.$disconnect()
  })

  /* ───────── 核心：带日期参数不再 500 ───────── */

  test('复现修复点：start+end（含远期空结果）返回 200 且为 0 条，不再 500', async () => {
    const r = await callStats({ school_code: TENANT_CODE, start: '2099-01-01', end: '2099-01-02' })
    assert.equal(r.statusCode, 200, `期望 200，实际 ${r.statusCode}（旧实现此处 500: operator does not exist: text >= date）`)
    assert.equal(r.body.code, 0)
    assert.equal(r.body.data.total, 0)
    assert.equal(r.body.data.pass_count, 0)
    assert.equal(r.body.data.pass_rate, null, '分母为 0 时必须返回 null，不得返回 0')
    assert.equal(r.body.data.pass_rate_detail.value, null)
    // by_type 仍按类型逐行返回（0 条也返回，便于对方核对），但每行必须是 0 且合格率为 null
    for (const t of r.body.data.by_type) {
      assert.equal(t.scope_total, 0)
      assert.equal(t.pass_count, 0)
      assert.equal(t.pass_rate, null)
    }
    assert.equal(r.body.data.out_of_range_total, 5, '有效日期记录全部落在请求范围外')
  })

  test('宽范围（2000→2100）返回 200 且覆盖全部有效日期记录', async () => {
    const r = await callStats({ school_code: TENANT_CODE, start: '2000-01-01', end: '2100-01-01' })
    assert.equal(r.statusCode, 200)
    assert.equal(r.body.data.scope_total, 5, '5 条有效日期记录（2 条非法/缺失不计）')
    assert.equal(r.body.data.excluded_total, 2)
    assert.equal(r.body.data.out_of_range_total, 0)
  })

  test('仅 start / 仅 end 均可正常返回（旧实现两者都 500）', async () => {
    const a = await callStats({ school_code: TENANT_CODE, start: '2026-01-16' })
    assert.equal(a.statusCode, 200)
    assert.equal(a.body.data.scope_total, 3, '2026-01-20、2026-01-31、2026-02-01（此时无授权范围限制）')

    const b = await callStats({ school_code: TENANT_CODE, end: '2026-01-15' })
    assert.equal(b.statusCode, 200)
    assert.equal(b.body.data.scope_total, 2, '2026-01-10 与 2026-01-15')
  })

  test('同一天（start=end）与边界记录计入（闭区间）', async () => {
    const r = await callStats({ school_code: TENANT_CODE, start: '2026-01-31', end: '2026-01-31' })
    assert.equal(r.statusCode, 200)
    assert.equal(r.body.data.scope_total, 1, '上边界当天必须计入')
    assert.equal(r.body.data.pass_count, 0, '该记录 colorLevel=不合格')
  })

  test('非法日期 → 400（可解释），不再是 500', async () => {
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
  })

  test('start > end → 400 INVALID_RANGE', async () => {
    const r = await callStats({ school_code: TENANT_CODE, start: '2026-02-01', end: '2026-01-01' })
    assert.equal(r.statusCode, 400)
    assert.equal(r.body.code, 'INVALID_RANGE')
  })

  test('接受 ISO8601 日期时间（取日期部分）', async () => {
    const r = await callStats({ school_code: TENANT_CODE, start: '2026-01-15T10:00:00+08:00', end: '2026-01-20T23:59:59+08:00' })
    assert.equal(r.statusCode, 200)
    assert.equal(r.body.data.scope_total, 2, '2026-01-15 与 2026-01-20')
  })

  /* ───────── 授权范围 ∩ 请求范围 ───────── */

  test('授权自带日期范围时，/stats 不再 500，且与请求范围求交', async () => {
    await setGrant({ start: '2026-01-01', end: '2026-01-31' })
    try {
      const all = await callStats({ school_code: TENANT_CODE })            // 仅授权范围
      assert.equal(all.statusCode, 200, '授权带日期范围时旧实现必 500')
      assert.equal(all.body.data.scope_total, 4, '授权范围内 4 条（01-10/15/20/31）')
      assert.equal(all.body.data.out_of_range_total, 1, '02-01 越界 → out_of_range_total')
      assert.equal(all.body.data.excluded_total, 2)
      assert.equal(all.body.data.range.grant.start, '2026-01-01')

      const narrowed = await callStats({ school_code: TENANT_CODE, start: '2026-01-16', end: '2026-02-28' })
      assert.equal(narrowed.statusCode, 200)
      assert.equal(narrowed.body.data.range.effective.start, '2026-01-16', '请求起点晚于授权起点 → 取较晚者')
      assert.equal(narrowed.body.data.range.effective.end, '2026-01-31', '请求终点晚于授权终点 → 取较早者（不得覆盖授权）')
      assert.equal(narrowed.body.data.scope_total, 2)

      const empty = await callStats({ school_code: TENANT_CODE, start: '2026-03-01', end: '2026-03-31' })
      assert.equal(empty.statusCode, 200, '交集为空是合法请求，返回 0 条而非报错')
      assert.equal(empty.body.data.scope_total, 0)
      assert.equal(empty.body.data.pass_rate, null)
      assert.equal(empty.body.data.range.empty, true)
      assert.ok(empty.body.data.range.empty_reason)
    } finally {
      await setGrant({})
    }
  })

  /* ───────── 口径自洽 ───────── */

  test('口径恒等式：scope_total + out_of_range_total + excluded_total = 授权类型内全部记录', async () => {
    const r = await callStats({ school_code: TENANT_CODE, start: '2026-01-16', end: '2026-01-20' })
    assert.equal(r.statusCode, 200)
    const d = r.body.data
    assert.equal(d.scope_total + d.out_of_range_total + d.excluded_total, 7, '固定数据集共 7 条')
    assert.equal(d.included_total, d.scope_total)
    assert.equal(d.pass_rate_detail.numerator, d.pass_count)
    assert.equal(d.pass_rate_detail.denominator, d.scope_total)
    const sum = (k) => d.by_type.reduce((s, t) => s + t[k], 0)
    assert.equal(sum('scope_total'), d.scope_total)
    assert.equal(sum('pass_count'), d.pass_count)
    assert.equal(sum('excluded_total'), d.excluded_total)
    assert.equal(sum('out_of_range_total'), d.out_of_range_total)
  })

  test('日期缺失/格式非法的记录进 excluded（不静默丢弃），且不计入分母', async () => {
    const r = await callStats({ school_code: TENANT_CODE })
    const d = r.body.data
    assert.equal(d.excluded_total, 2)
    assert.equal(d.excluded.length, 1)
    assert.equal(d.excluded[0].reason, 'missing_or_invalid_test_date')
    assert.equal(d.excluded[0].count, 2)
  })

  test('时区无关：业务日期按文本比较，会话时区改变不改变结果', async () => {
    const sql = `SELECT count(*)::int AS n FROM "${TENANT_SCHEMA}"."TestRecord"
                 WHERE substring("sample_info"->>'testDate' from 1 for 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                   AND substring("sample_info"->>'testDate' from 1 for 10) >= '2026-01-16'
                   AND substring("sample_info"->>'testDate' from 1 for 10) <= '2026-01-20'`
    const utc = await tenant.$transaction([tenant.$executeRawUnsafe(`SET TIME ZONE 'UTC'`), tenant.$queryRawUnsafe(sql)])
    const sh = await tenant.$transaction([tenant.$executeRawUnsafe(`SET TIME ZONE 'Asia/Shanghai'`), tenant.$queryRawUnsafe(sql)])
    assert.equal(Number(utc[1][0].n), Number(sh[1][0].n), 'UTC 与 Asia/Shanghai 下计数必须一致')
    assert.equal(Number(utc[1][0].n), 1)
  })

  /* ───────── 同源缺陷：授权带日期范围时 /test-records 与 /sync/manifest ───────── */

  test('同源缺陷已修：授权带日期范围时 /test-records 与 /sync/manifest 不再 500', async () => {
    await setGrant({ start: '2026-01-01', end: '2026-01-31' })
    try {
      const router = createOpenApiRoutes({ prisma })
      const handlerOf = (path) => {
        for (const layer of router.stack) {
          if (layer.route && layer.route.path === path && layer.route.methods.get) {
            return layer.route.stack[layer.route.stack.length - 1].handle
          }
        }
        throw new Error(`未找到 ${path}`)
      }
      for (const [path, query] of [['/v1/test-records', { school_code: TENANT_CODE, limit: '10' }], ['/v1/sync/manifest', { school_code: TENANT_CODE, detail: '1' }]]) {
        const res = res0()
        await handlerOf(path)({ openApi: { client: { id: CLIENT_ID }, credential: {} }, query }, res)
        assert.equal(res.statusCode, 200, `${path} 在授权带日期范围时应 200`)
        const n = path === '/v1/test-records' ? res.body.data.count : res.body.data.total
        assert.equal(n, 4, `${path} 应只返回授权日期范围内的 4 条`)
      }
    } finally {
      await setGrant({})
    }
  })
}
