// P3-W5-T01 · 油脂结论口径的「SQL ⟷ JS 等价」与两个统计出口的端到端回归（**必须用隔离测试库**）
//
// 目的（AUD-025）：内部统计 / 访客统计原先用 `colorLevel NOT LIKE '%不合格%'` 判合格 ——
// 任何未识别的非空等级（"深绿色"/"foo"）都会被计成合格（fail-open）。本套件在真实 PostgreSQL 上验证：
//   ① oilVerdictSql() 生成的表达式与 lib/conclusionVerdict.oilVerdict() 对同一组输入**逐例同结论**；
//   ② 员工端 GET /api/test-records/stats 的 passCount 与新口径一致；
//   ③ 访客端 GET /api/guest/stats 的 passCount 与新口径一致（同一 SQL 等价物）。
//
// 启用方式（未设置则整体拒绝，fail-closed，不 skip）：
//   TEST_DATABASE_URL='postgresql://<provisioner 派生 role>:x@127.0.0.1:<port>/<derived db>' \
//   TEST_DB_CONTEXT_FILE=<provisioner 输出> \
//     node --test backend/tests/verdict/oil-verdict-stats.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { require, loadIsolation, assertIsolated as gateAssert, cleanupScoped } from '../_isolation.mjs'

const isoInfo = loadIsolation()
const TENANT = isoInfo.ok ? isoInfo.tenant('a') : null
const enabled = isoInfo.ok

if (!enabled) {
  test('油脂口径 SQL 等价：[T02C] 未配置显式 TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE → 拒绝（fail-closed，不再 skip）', () => {
    assert.fail(`[T02C-ISOLATION-REFUSED] code=${isoInfo.code || 'UNKNOWN'} reason=${isoInfo.reason || 'n/a'}；本套件只认显式 TEST_* 配置（不回落 DATABASE_URL / 业务 dotenv）`)
  })
}

if (enabled) {
  process.env.DATABASE_URL = isoInfo.url   // 保险：任何内部 createTenantClient 都不得落到生产

  const { PrismaClient } = require('@prisma/client')
  const { createRecordRoutes } = await import('../../routes/recordRoutes.js')
  const { createGuestRoutes } = await import('../../routes/guestRoutes.js')
  const { oilVerdictSql, oilVerdict } = await import('../../lib/conclusionVerdict.js')

  const tenantUrl = TENANT.urlWithSchema
  const db = new PrismaClient({ datasources: { db: { url: tenantUrl } } })

  const noop = (req, res, next) => next()
  const recordRouter = createRecordRoutes({ authenticateUser: noop, requireEditorOrAbove: noop, requireGuestReadOnly: noop, idempotencyMiddleware: noop })
  let STATS = null
  let CREATE = null
  for (const l of recordRouter.stack) {
    if (l.route && l.route.path === '/api/test-records/stats' && l.route.methods.get) STATS = l.route.stack[l.route.stack.length - 1].handle
    if (l.route && l.route.path === '/api/records/:tableName' && l.route.methods.post) CREATE = l.route.stack[l.route.stack.length - 1].handle
  }
  // 访客统计：直接取 /stats 末位 handler（认证中间件在本套件用合成 req 代替）
  const guestRouter = createGuestRoutes({}, db, 'w5-test-secret')
  let GUEST_STATS = null
  for (const l of guestRouter.stack) {
    if (l.route && l.route.path === '/stats' && l.route.methods.get) GUEST_STATS = l.route.stack[l.route.stack.length - 1].handle
  }

  const USER_ID = 'u-w5-oil'
  const DAY = '2026-09-25'
  const CODE_PREFIX = 'RC-w5oil-'

  const makeRes = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this },
    send(b) { this.body = b; return this }, setHeader() {},
  })

  const callStats = async (query = {}) => {
    const req = { db, query, user: { role: 'manager', userId: USER_ID }, userId: USER_ID, ip: '127.0.0.1', get: () => 'test.local' }
    const res = makeRes()
    await STATS(req, res)
    return res
  }

  /** 访客统计的 db 替身：groupBy 用真实计数（口径无关），合格判定走真实 $queryRawUnsafe。 */
  const guestDb = {
    testRecord: {
      groupBy: async ({ where }) => {
        const rows = await db.$queryRawUnsafe(
          `SELECT "test_type", COUNT(*)::int AS "c" FROM "TestRecord" WHERE "test_type" = ANY($1::text[]) GROUP BY "test_type"`,
          where.test_type.in,
        )
        return rows.map((r) => ({ test_type: r.test_type, _count: { _all: r.c } }))
      },
    },
    $queryRawUnsafe: (...args) => db.$queryRawUnsafe(...args),
  }
  const callGuestStats = async () => {
    const req = { db: guestDb, user: { role: 'guest' }, guestVisibleTypes: ['oil'], ip: '127.0.0.1', get: () => 'test.local' }
    const res = makeRes()
    await GUEST_STATS(req, res)
    return res
  }

  // 7 条形态：合法三名 + 未识别（含"未知值 + result=合格"关键回归）+ 空值回退
  const FIXTURES = [
    { code: `${CODE_PREFIX}1`, rd: { colorLevel: '合格' }, expectPass: true },              // 合法合格
    { code: `${CODE_PREFIX}2`, rd: { colorLevel: '警戒' }, expectPass: true },              // 警戒计入合格
    { code: `${CODE_PREFIX}3`, rd: { colorLevel: '不合格' }, expectPass: false },           // 合法不合格
    { code: `${CODE_PREFIX}4`, rd: { colorLevel: '深绿色' }, expectPass: false },           // 未识别 → 不计合格
    { code: `${CODE_PREFIX}5`, rd: { colorLevel: 'foo', result: '合格' }, expectPass: false }, // ⚠ AUD-025 原缺陷：旧 SQL 会判合格
    { code: `${CODE_PREFIX}6`, rd: { colorLevel: '', result: '合格' }, expectPass: true },  // 空值回退 result
    { code: `${CODE_PREFIX}7`, rd: { colorLevel: '', result: '不合格' }, expectPass: false }, // 空值回退 result
  ]
  const EXPECT_PASS = FIXTURES.filter((f) => f.expectPass).length   // = 3

  test.before(async () => {
    await gateAssert(db, TENANT.schema, '租户客户端')
    await db.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, username: 'w5-oil', password_hash: 'x', role: 'manager', full_name: '油脂口径回归' },
    })
    await db.testRecord.deleteMany({ where: { record_code: { startsWith: CODE_PREFIX } } })
    await db.testRecord.deleteMany({ where: { sample_info: { path: ['canteen'], equals: WRITE_CANTEEN } } })   // 上次运行残留（写入侧用例）
    for (const f of FIXTURES) {
      await db.testRecord.create({
        data: {
          record_code: f.code, test_type: 'oil', test_name: '食用油品质检测',
          sample_info: { testDate: DAY, canteen: 'W5 回归食堂', inspector: '测试员' },
          result_data: f.rd, status: 'completed', version: 1, created_by: USER_ID,
        },
      })
    }
  })

  test.after(async () => {
    await cleanupScoped(db, { record_code: { startsWith: CODE_PREFIX } }, 'w5-oil-records')
    await db.$disconnect()
  })

  /* ───────── ① SQL 等价物 × JS 规则（逐例） ───────── */

  test('oilVerdictSql() 与 JS oilVerdict() 对完整判定矩阵逐例同结论', async () => {
    const payloads = [
      { colorLevel: '合格' }, { colorLevel: '警戒' }, { colorLevel: '不合格' },
      { colorLevel: '深绿色' }, { colorLevel: 'foo' }, { colorLevel: 'foo', result: '不合格' },
      { colorLevel: '深绿色', result: '合格' }, { colorLevel: '' , result: '合格' }, { colorLevel: '', result: '不合格' },
      { colorLevel: '' }, { colorLevel: '合格 ' }, { colorLevel: '不合格', result: '合格' },
    ]
    const params = []
    const values = payloads.map((p, i) => {
      params.push(JSON.stringify(p))
      return `(${i + 1}, $${i + 1}::jsonb)`
    })
    const rows = await db.$queryRawUnsafe(
      `SELECT v.id, ${oilVerdictSql('v.rd')} AS pass FROM (VALUES ${values.join(', ')}) AS v(id, rd) ORDER BY v.id`,
      ...params,
    )
    assert.equal(rows.length, payloads.length)
    for (let i = 0; i < payloads.length; i++) {
      const sqlPass = rows[i].pass === true
      const jsPass = oilVerdict(payloads[i]).level === 'pass'
      assert.equal(sqlPass, jsPass, `SQL/JS 分叉 @${JSON.stringify(payloads[i])}（sql=${rows[i].pass}, js=${oilVerdict(payloads[i]).level}）`)
    }
  })

  /* ───────── ② 员工端内部统计出口 ───────── */

  test('内部统计：未知 / 未识别等级不计合格（AUD-025 回归反转）', async () => {
    const res = await callStats({ start: DAY, end: DAY, canteen: 'W5 回归食堂' })
    assert.equal(res.statusCode, 200)
    const oil = res.body.data.byType.oil
    assert.ok(oil, '应包含 oil 分型')
    assert.equal(oil.count, FIXTURES.length, `分母 = 全部 ${FIXTURES.length} 条（unknown 不隐式丢弃）`)
    assert.equal(oil.passCount, EXPECT_PASS, `合格数应为 ${EXPECT_PASS}（合格/警戒/空值回退合格；未识别一律不计）`)
    assert.equal(oil.passRate, Math.round((EXPECT_PASS / FIXTURES.length) * 1000) / 10)
    // 反向断言：AUD-025 原缺陷（foo + result=不合格 被计合格）不得回归
    assert.notEqual(oil.passCount, 5, '旧 fail-open 口径会得到 5（含 foo/深绿色）')
  })

  /* ───────── ③ 访客统计出口（同一 SQL 等价物） ───────── */

  test('访客统计：与内部统计同口径（同一 SQL 等价物）', async () => {
    const res = await callGuestStats()
    assert.equal(res.statusCode, 200)
    const oil = res.body.data.byType.oil
    assert.ok(oil, '应包含 oil 分型')
    assert.equal(oil.count, FIXTURES.length)
    assert.equal(oil.passCount, EXPECT_PASS, '访客统计与员工端必须一致')
  })

  /* ───────── ④ 写入侧（验收 ④）：API 写入被拒 + 库内遗留未知值的统计正例 ───────── */

  const WRITE_CANTEEN = 'W5 写入校验食堂'
  const callCreate = async (body) => {
    const req = {
      db, body, params: { tableName: 'oil' }, query: {},
      user: { role: 'manager', userId: USER_ID }, userId: USER_ID, ip: '127.0.0.1', get: () => 'test.local',
    }
    const res = makeRes()
    await CREATE(req, res)
    return res
  }

  test('写入侧：未识别 colorLevel 经 API 被拒（400），合法/空值写入成功；遗留未知值统计不计合格', async () => {
    await db.testRecord.deleteMany({ where: { sample_info: { path: ['canteen'], equals: WRITE_CANTEEN } } })

    const bad = await callCreate({ testDate: DAY, canteen: WRITE_CANTEEN, inspector: '测试员', colorLevel: '深绿色' })
    assert.equal(bad.statusCode, 400, '未知等级必须被拒（不再静默放行）')
    assert.ok(JSON.stringify(bad.body).includes('colorLevel'), `错误须指向 colorLevel：${JSON.stringify(bad.body)}`)

    const good = await callCreate({ testDate: DAY, canteen: WRITE_CANTEEN, inspector: '测试员', colorLevel: '警戒', tpmValue: '0.20' })
    assert.equal(good.statusCode, 200, `合法值写入应成功：${JSON.stringify(good.body?.error || '')}`)

    const empty = await callCreate({ testDate: DAY, canteen: WRITE_CANTEEN, inspector: '测试员', colorLevel: '', result: '合格' })
    assert.equal(empty.statusCode, 200, '空等级 + result 文本应写入成功（读侧回退 result）')

    const rows = await db.$queryRawUnsafe(
      `SELECT ${oilVerdictSql('"result_data"')} AS pass FROM "TestRecord" WHERE "sample_info"->>'canteen' = $1`,
      WRITE_CANTEEN,
    )
    assert.equal(rows.length, 2, '被拒的未知值不得落库')
    assert.equal(rows.filter((r) => r.pass === true).length, 2, '警戒 + 空值回退合格 都应计合格')

    const rejected = await db.testRecord.count({ where: { sample_info: { path: ['canteen'], equals: WRITE_CANTEEN } } })
    assert.equal(rejected, 2)

    await db.testRecord.deleteMany({ where: { sample_info: { path: ['canteen'], equals: WRITE_CANTEEN } } })
  })
}
