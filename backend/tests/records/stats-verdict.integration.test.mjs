// 统计口径集成回归：餐具「顶层 result 为空 → 回退点位结论」+ 肉蛋品种细分（**必须用隔离测试库**）
//
// 背景（2026-09-24 线上合格率缺陷）：洗涤剂残留记录只写 atpPoints[].res，不写记录级 result，
// 旧统计把它算作"非合格"（既进分母）→ school_zhsy 餐具 5/9=56%，实际应为 9/9=100%。
//
// 启用方式（未设置则整体跳过）：
//   REVIEW_TEST_DATABASE_URL='postgresql://USER:PASS@127.0.0.1:5432/foodsentinel_review_test' \
//     node --test tests/records/stats-verdict.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { require, isConfigured, assertIsolationConfig, assertIsolated, cleanupScoped, parseDbUrl } from '../_isolation.mjs'

const URL_ = process.env.REVIEW_TEST_DATABASE_URL || ''
const TEST_SCHEMA = 'school_reviewtest'
const enabled = isConfigured()

if (!enabled) {
  test('统计口径集成（未设置 REVIEW_TEST_DATABASE_URL，跳过）', { skip: 'SKIP: TEST_DATABASE_URL not configured' }, () => {})
}

if (enabled) {
  const iso = assertIsolationConfig({ schema: TEST_SCHEMA })
  process.env.DATABASE_URL = URL_   // 保险：任何内部 createTenantClient 都不得落到生产

  const { PrismaClient } = require('@prisma/client')
  const { createRecordRoutes } = await import('../../routes/recordRoutes.js')

  const tenantUrl = `${URL_}${URL_.includes('?') ? '&' : '?'}schema=${TEST_SCHEMA}`
  const db = new PrismaClient({ datasources: { db: { url: tenantUrl } } })

  const noop = (req, res, next) => next()
  const router = createRecordRoutes({ authenticateUser: noop, requireEditorOrAbove: noop, requireGuestReadOnly: noop, idempotencyMiddleware: noop })
  let STATS = null
  for (const l of router.stack) {
    if (l.route && l.route.path === '/api/test-records/stats' && l.route.methods.get) STATS = l.route.stack[l.route.stack.length - 1].handle
  }
  const USER_ID = 'u-stats-verdict'
  let CREATE = null
  for (const l of router.stack) {
    if (l.route && l.route.path === '/api/records/:tableName' && l.route.methods.post) CREATE = l.route.stack[l.route.stack.length - 1].handle
  }
  const createdIds = []   // 创建路径的 record_code 由内容哈希生成，清理按 id 精确删除
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
  const callCreate = async (body, params = {}) => {
    const req = { db, body, params, query: {}, user: { role: 'manager', userId: USER_ID }, userId: USER_ID, ip: '127.0.0.1', get: () => 'test.local' }
    const res = makeRes()
    await CREATE(req, res)
    if (res.body?.data?.id) createdIds.push(res.body.data.id)
    return res
  }

  const DAY = '2026-09-22'
  const FIXTURES = [
    // 餐具 5 种形态（覆盖本次修复的核心分支）
    { code: 'RC-verdict-t1', type: 'tableware', rd: { result: '合格 (<200)', rluValue: '10' } },
    { code: 'RC-verdict-t2', type: 'tableware', rd: { result: '不合格 (>500)', rluValue: '614' } },
    { code: 'RC-verdict-t3', type: 'tableware', rd: { result: '', rluValue: '0.05', atpPoints: [{ loc: '不锈钢餐具', rlu: '0.05', res: '合格 (≤0.1 mg/L)', testType: 'detergent' }] } },
    { code: 'RC-verdict-t4', type: 'tableware', rd: { result: '', atpPoints: [{ loc: '餐具表面', rlu: '10', res: '合格 (<200)', testType: 'atp' }, { loc: '不锈钢餐具', rlu: '0.4', res: '不合格 (>0.1 mg/L)', testType: 'detergent' }] } },
    { code: 'RC-verdict-t5', type: 'tableware', rd: { result: '', atpPoints: [] } },
    // 肉蛋 3 种品种（含"鱼、虾"这种此前归不进任何卡片的写法）
    { code: 'RC-verdict-m1', type: 'leanMeat', rd: { meatType: '鱼、虾', result: '合格' } },
    { code: 'RC-verdict-m2', type: 'leanMeat', rd: { meatType: '禽蛋', result: '合格' } },
    { code: 'RC-verdict-m3', type: 'leanMeat', rd: { meatType: '其它未分类', result: '合格' } },
  ]

  test.before(async () => {
    await assertIsolated(db, parseDbUrl(URL_).db, '统计口径集成租户客户端')
    await db.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, username: 'stats-verdict', password_hash: 'x', role: 'manager', full_name: '统计口径回归' },
    })
    await db.testRecord.deleteMany({ where: { record_code: { startsWith: 'RC-verdict-' } } })
    for (const f of FIXTURES) {
      await db.testRecord.create({
        data: {
          record_code: f.code, test_type: f.type, test_name: f.type,
          sample_info: { testDate: DAY, canteen: '回归食堂', inspector: '测试员' },
          result_data: f.rd, status: 'completed', version: 1, created_by: USER_ID,
        },
      })
    }
  })

  test.after(async () => {
    if (createdIds.length) await db.testRecord.deleteMany({ where: { id: { in: createdIds } } })
    await cleanupScoped(db, { record_code: { startsWith: 'RC-verdict-' } }, 'after')
    await db.$disconnect()
  })

  test('餐具：顶层 result 为空时按点位结论计入合格（修复 56% → 100% 的核心）', async () => {
    const res = await callStats({ start: '2026-09-01', end: '2026-09-30' })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const t = res.body.data.byType.tableware
    assert.equal(t.count, 5, '5 条餐具 fixture 都应在分母（含无结论那一条）')
    assert.equal(t.passCount, 2, '合格 = 顶层合格 + 点位全合格；点位含不合格/无点位均不计合格')
    assert.equal(t.passRate, 40)
  })

  test('餐具：任一点位不合格 → 记录不合格（最差点胜出）', async () => {
    const res = await callStats({ start: DAY, end: DAY })
    // 当天 5 条餐具：t1（顶层合格）与 t3（点位全合格）计合格 = 2；
    // t4 虽有一个"合格"点位，但另一个点位"不合格" → **不得**计合格（最差点胜出）。
    assert.equal(res.body.data.byType.tableware.count, 5)
    assert.equal(res.body.data.byType.tableware.passCount, 2, 't4（多点位含不合格）与 t5（无结论）都不计合格')
  })

  test('肉蛋：服务端给出品种细分，`鱼、虾` 归入鱼肉，未分类落「其它」兜底卡', async () => {
    const res = await callStats({ start: '2026-09-01', end: '2026-09-30' })
    const byMeat = res.body.data.byMeatType
    assert.ok(byMeat, '应返回 byMeatType（仅 leanMeat 可见时）')
    assert.deepEqual(Object.keys(byMeat).sort(), ['禽蛋', '禽肉', '牛肉', '猪肉', '羊肉', '鱼肉', '其它'].sort(), '键恒定为 7 个卡片键（含「其它」兜底卡）')
    assert.equal(byMeat['鱼肉'].count, 1, '“鱼、虾”必须归入鱼肉（此前不落入任何卡片）')
    assert.equal(byMeat['鱼肉'].passRate, 100)
    assert.equal(byMeat['禽蛋'].count, 1)
    assert.equal(byMeat['猪肉'].count, 0)
    assert.equal(byMeat['猪肉'].passRate, null, '无数据 → null（前端显示“无”）')
    // 方案 A：未归类记录落「其它」兜底卡 ⇒ 各卡合计恒等于肉蛋类型总数（不再有数据"消失"）
    assert.equal(res.body.data.byType.leanMeat.count, 3)
    assert.equal(byMeat['其它'].count, 1, '未分类品种应落「其它」')
    assert.equal(byMeat['其它'].passRate, 100)
    const sum = Object.values(byMeat).reduce((a, s) => a + s.count, 0)
    assert.equal(sum, 3, '7 张卡合计 = 肉蛋类型总数（兜底卡保证不丢数据）')
  })

  test('写入侧自洽：提交"洗涤剂残留"点位（记录级 result 为空）时，服务端按点位聚合补写 result', async () => {
    // 用独立日期，避免影响上面按 9 月窗口断言的用例（各用例互不干扰）
    const WRITE_DAY = '2026-08-05'
    const created = await callCreate({
      test_type: 'tableware', test_name: '餐具洁净度检测',
      testDate: WRITE_DAY, canteen: '写入自洽回归食堂', inspector: '测试员',   // 该入口要求三键在顶层（validateRecordPayload）
      sample_info: { testDate: WRITE_DAY, canteen: '写入自洽回归食堂', inspector: '测试员' },
      result_data: { result: '', rluValue: '0.05', atpPoints: [{ loc: '不锈钢餐具', rlu: '0.05', res: '合格 (≤0.1 mg/L)', testType: 'detergent' }] },
    }, { tableName: 'tableware' })
    assert.equal(created.statusCode, 200, JSON.stringify(created.body))
    const row = await db.testRecord.findUnique({ where: { id: created.body.data.id } })
    assert.equal(row.test_type, 'tableware')
    assert.equal(String(row.result_data.result || ''), '合格 (≤0.1 mg/L)', '记录级 result 应由点位结论聚合补写（新数据自洽）')
    assert.equal(row.result_data.atpPoints.length, 1, '点位明细保持原样，不被改写')

    // 不覆盖已有文本：显式提交非空 result 时以提交值为准
    const explicit = await callCreate({
      test_type: 'tableware', test_name: '餐具洁净度检测',
      testDate: WRITE_DAY, canteen: '写入自洽回归食堂2', inspector: '测试员',
      sample_info: { testDate: WRITE_DAY, canteen: '写入自洽回归食堂2', inspector: '测试员' },
      result_data: { result: '不合格 (>500)', rluValue: '614', atpPoints: [{ loc: '餐盘表面', rlu: '10', res: '合格 (<200)', testType: 'atp' }] },
    }, { tableName: 'tableware' })
    const row2 = await db.testRecord.findUnique({ where: { id: explicit.body.data.id } })
    assert.equal(String(row2.result_data.result || ''), '不合格 (>500)', '已有文本不得被点位聚合覆盖')

    // 未提交点位（例如只补一个 remark）→ 不因无关编辑补写结果
    const noPoints = await callCreate({
      test_type: 'tableware', test_name: '餐具洁净度检测',
      testDate: WRITE_DAY, canteen: '写入自洽回归食堂3', inspector: '测试员',
      sample_info: { testDate: WRITE_DAY, canteen: '写入自洽回归食堂3', inspector: '测试员' },
      result_data: { remark: '仅补备注' },
    }, { tableName: 'tableware' })
    const row3 = await db.testRecord.findUnique({ where: { id: noPoints.body.data.id } })
    assert.equal(String(row3.result_data.result || ''), '', '未提交点位不得擅自补写 result')
  })

  test('总合格率：分母含全部在范围内记录，分子只含合格（口径未扩大）', async () => {
    const res = await callStats({ start: '2026-09-01', end: '2026-09-30' })
    const d = res.body.data
    assert.equal(d.total, 8, '5 条餐具 + 3 条肉蛋，无论是否可判定都在分母')
    assert.equal(d.passCount, 5, '餐具 2（t1/t3）+ 肉蛋 3；t2/t4/t5 不计合格')
    assert.equal(d.passRate, Math.round((5 / 8) * 1000) / 10)
  })
}
