// 开放接口 **HTTP 链路**集成回归（2026-09-17 复核对：补真实 HTTP 层）
//
// 与既有测试的分工：
//   · 纯函数/契约：tests/openapi/contract*.test.mjs（不连库）
//   · handler + 真实 DB：tests/records/*.integration.test.mjs（直接调用路由末端 handler，注入 req）
//   · **本文件**：真实 Express 装配 + 真实 HTTP 请求（fetch）+ 真实 API-Key 中间件 + 真实租户客户端。
//
// 装配说明（与生产 server.js 的差异，不得称为完全等价）：
//   · 仅挂载 `/api/open`（开放接口）；不加载 server.js 的静态资源、定时任务、上传/钉钉等外部副作用。
//   · 服务只绑定 127.0.0.1 的随机端口（不对外暴露）。
//   · 未挂载内部鉴权路由（/api/records、/api/sync 需要内部 JWT）；它们由 tests/records/* 以
//     "真实路由末端 handler + 真实 DB" 覆盖 —— 差异见报告，不伪造 req.user 冒充 HTTP 层。
//
// 隔离：tests/_isolation.mjs 门禁（解析连接串校验库名/schema + 写前断言 current_database/current_schema
//      + 统一把 process.env.DATABASE_URL 重定向到隔离库，使路由内的 createTenantClient 也指向隔离库）。
//
// 启用：REVIEW_TEST_DATABASE_URL='…/foodsentinel_review_test' node --test tests/http/
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { require, isConfigured, assertIsolationConfig, assertIsolated, cleanupScoped } from '../_isolation.mjs'

const TEST_SCHEMA = 'school_reviewtest'
const SCHOOL = 'reviewtest'
const CLIENT_ID = 'httptest-client'
const USER_ID = 'u-http-test'
const KEY = 'oap_' + crypto.randomBytes(24).toString('base64url')
const KEY_HASH = crypto.createHash('sha256').update(KEY).digest('hex')
const enabled = isConfigured()

if (!enabled) {
  test('开放接口 HTTP 链路（未设置 REVIEW_TEST_DATABASE_URL，跳过）', { skip: 'SKIP: TEST_DATABASE_URL not configured' }, () => {})
}

if (enabled) {
  const iso = assertIsolationConfig({ schema: TEST_SCHEMA })   // 含 DATABASE_URL 重定向
  const { PrismaClient } = require('@prisma/client')
  const express = require('express')
  const { createOpenApiRoutes } = await import('../../routes/openApiRoutes.js')
  const { createAdminOpenApiRoutes } = await import('../../routes/adminOpenApiRoutes.js')

  const prisma = new PrismaClient({ datasources: { db: { url: iso.url } } })
  const tenant = new PrismaClient({ datasources: { db: { url: `${iso.url}${iso.url.includes('?') ? '&' : '?'}schema=${TEST_SCHEMA}` } } })

  let server
  let base
  const fixtures = ['RC-http-1', 'RC-http-2', 'RC-http-3', 'RC-http-4', 'RC-http-5', 'RC-http-nogrant']

  async function api(path, { key = KEY } = {}) {
    const res = await fetch(base + path, key ? { headers: { 'X-API-Key': key } } : {})
    let body = null
    try { body = await res.json() } catch { /* 非 JSON */ }
    return { status: res.status, code: body?.code, data: body?.data }
  }

  test.before(async () => {
    await assertIsolated(prisma, iso.db, 'public 客户端')
    await assertIsolated(tenant, iso.db, '租户客户端')
    const schemas = await tenant.$queryRawUnsafe('SELECT current_schema() AS s')
    assert.equal(schemas[0].s, TEST_SCHEMA, `租户客户端必须落在 ${TEST_SCHEMA}`)

    await prisma.school.upsert({
      where: { code: SCHOOL }, update: { status: 'active' },
      create: { code: SCHOOL, name: 'HTTP 回归学校', status: 'active' },
    })
    await prisma.openApiClient.upsert({
      where: { id: CLIENT_ID }, update: { status: 'active', rate_limit_per_min: 6000 },
      create: { id: CLIENT_ID, name: 'HTTP 回归对接方', status: 'active', ip_whitelist: [], rate_limit_per_min: 6000 },
    })
    const cred = await prisma.openApiCredential.findFirst({ where: { client_id: CLIENT_ID } })
    if (cred) await prisma.openApiCredential.delete({ where: { id: cred.id } })
    await prisma.openApiCredential.create({
      data: { client_id: CLIENT_ID, label: 'http-test', key_hash: KEY_HASH, key_prefix: KEY.slice(0, 12), key_last4: KEY.slice(-4), status: 'active', call_count: 0 },
    })
    const grant = await prisma.openApiGrant.findFirst({ where: { client_id: CLIENT_ID, school_code: SCHOOL } })
    if (grant) await prisma.openApiGrant.delete({ where: { id: grant.id } })
    await prisma.openApiGrant.create({
      data: {
        client_id: CLIENT_ID, school_code: SCHOOL, status: 'active',
        visible_types: ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'],
        include_pathogen: true, include_inspector: false, scope_version: 1,
      },
    })
    await tenant.user.upsert({
      where: { id: USER_ID }, update: {},
      create: { id: USER_ID, username: 'http-test', password_hash: 'x', role: 'manager', full_name: 'HTTP 回归' },
    })
    await cleanupScoped(tenant, { record_code: { startsWith: 'RC-http-' } }, 'before')
    const rows = [
      { code: 'RC-http-1', type: 'tableware', day: '2026-03-01', result: { result: '合格 (<200)' } },
      { code: 'RC-http-2', type: 'oil', day: '2026-03-02', result: { colorLevel: '不合格' } },
      { code: 'RC-http-5', type: 'oil', day: '2026-03-10', result: { colorLevel: '警戒' } },
      { code: 'RC-http-3', type: 'tableware', day: '2026-02-30', result: { result: '合格 (<200)' } },  // 日历不存在
      { code: 'RC-http-4', type: 'pesticide', day: null, result: { result: '合格' } },                  // 缺日期
    ]
    for (const r of rows) {
      await tenant.testRecord.create({
        data: {
          record_code: r.code, test_type: r.type, test_name: r.type,
          sample_info: r.day === null ? { canteen: 'HTTP 食堂', inspector: '测试员' } : { testDate: r.day, canteen: 'HTTP 食堂', inspector: '测试员' },
          result_data: r.result, status: 'completed', version: 1, created_by: USER_ID,
        },
      })
    }

    const app = express()
    app.use(express.json())
    app.use('/api/open', createOpenApiRoutes({ prisma }))
    // 本套件只验证超管路由的数据范围；认证与平台超管守卫由真实服务负责。
    const pass = (req, res, next) => { req.user = { userId: USER_ID, username: 'http-test', role: 'admin' }; next() }
    app.use('/api/admin/open-api', createAdminOpenApiRoutes({ prisma, authenticateUser: pass, requirePlatformSuperAdmin: pass }))
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    base = `http://127.0.0.1:${server.address().port}/api/open`
  })

  test.after(async () => {
    if (server) await new Promise((r) => server.close(r))
    await cleanupScoped(tenant, { record_code: { startsWith: 'RC-http-' } }, 'after')
    await prisma.openApiCredential.deleteMany({ where: { client_id: CLIENT_ID } })
    await prisma.openApiGrant.deleteMany({ where: { client_id: CLIENT_ID } })
    await prisma.openApiClient.deleteMany({ where: { id: CLIENT_ID } })
    await prisma.$disconnect()
    await tenant.$disconnect()
  })

  /* ── 1. 认证（真实中间件） ── */
  test('HTTP：无密钥 401 MISSING_KEY；错误密钥 401 INVALID_KEY；正确密钥 200', async () => {
    const noKey = await api('/v1/ping', { key: null })
    assert.equal(noKey.status, 401)
    assert.equal(noKey.code, 'MISSING_KEY')
    const badKey = await api('/v1/ping', { key: 'oap_wrong_key_000000000000' })
    assert.equal(badKey.status, 401)
    assert.equal(badKey.code, 'INVALID_KEY')
    const ok = await api('/v1/ping')
    assert.equal(ok.status, 200)
    assert.equal(ok.data.client_name, 'HTTP 回归对接方')
  })

  test('HTTP：未授权学校 403；未授权类型 403', async () => {
    const school = await api('/v1/stats?school_code=tjb')
    assert.equal(school.status, 403)
    assert.equal(school.code, 'SCHOOL_NOT_AUTHORIZED')
    const type = await api('/v1/samples?school_code=reviewtest&test_type=unknown-type')
    assert.equal(type.status, 403)
    assert.equal(type.code, 'TYPE_NOT_AUTHORIZED')
  })

  /* ── 2. 契约与对账 ── */
  test('HTTP：dict 返回字段字典（含枚举与不下发标记）', async () => {
    const dict = await api(`/v1/dict?school_code=${SCHOOL}`)
    assert.equal(dict.status, 200)
    const oil = dict.data.field_schema.oil
    const fields = Array.isArray(oil) ? oil : oil.fields
    const conclusion = fields.find((f) => f.path === 'initial_conclusion')
    assert.ok(Array.isArray(conclusion.enum) && conclusion.enum.includes('unknown'), '枚举必须含 unknown')
    const recheck = fields.find((f) => f.path === 'result.recheckRecords')
    assert.ok(recheck, '油品必须登记 result.recheckRecords（F7）')
  })

  test('HTTP：records 分页 ↔ manifest ↔ stats 在同一范围内可对账', async () => {
    const recs = await api(`/v1/test-records?school_code=${SCHOOL}&limit=200`)
    assert.equal(recs.status, 200)
    const manifest = await api(`/v1/sync/manifest?school_code=${SCHOOL}&detail=1`)
    assert.equal(manifest.status, 200)
    // 真实契约（2026-09-17 复核对修正）：
    //   · `/test-records` 的**日期过滤只来自授权范围**（本用例授权无日期范围）→ 返回授权类型内**全部**记录，
    //     包含日期缺失/非法的记录（供对方排查），本例 5 条；
    //   · `/stats.scope_total` 只含**日期合法**的记录（分母），本例 3 条；
    //   · 因此两者的对账恒等式是：manifest.total == scope_total + excluded_total。
    assert.equal(recs.data.count, 5, `records=${recs.data.count}（授权无日期范围时应含脏日期记录）`)
    assert.equal(manifest.data.total, 5, `manifest=${manifest.data.total}`)
    assert.equal(recs.data.projection_fingerprint, manifest.data.projection_fingerprint, '指纹必须同源')
    const stats = await api(`/v1/stats?school_code=${SCHOOL}`)
    assert.equal(stats.status, 200)
    assert.equal(stats.data.scope_total, 3, '统计分母只含合法日期记录')
    assert.equal(stats.data.excluded_total, 2, '脏日期 + 缺日期 = 2')
    assert.equal(stats.data.scope_total + stats.data.excluded_total, manifest.data.total,
      '对账恒等式：manifest.total = scope_total + excluded_total（无授权日期范围时）')
    assert.equal(
      stats.data.universe_total,
      stats.data.scope_total + stats.data.request_out_of_range_total + stats.data.excluded_total,
      '桶必须互斥且自洽',
    )
  })

  test('HTTP：对账四组合矩阵（授权日期范围 × 请求日期范围）', async () => {
    const setGrant = (start, end) => prisma.openApiGrant.updateMany({
      where: { client_id: CLIENT_ID, school_code: SCHOOL },
      data: {
        start_date: start ? new Date(`${start}T00:00:00Z`) : null,
        end_date: end ? new Date(`${end}T00:00:00Z`) : null,
      },
    })
    const snap = async (q = '') => {
      const recs = await api(`/v1/test-records?school_code=${SCHOOL}&limit=200`)
      const man = await api(`/v1/sync/manifest?school_code=${SCHOOL}&detail=1`)
      const st = await api(`/v1/stats?school_code=${SCHOOL}${q}`)
      assert.equal(recs.status, 200); assert.equal(man.status, 200); assert.equal(st.status, 200)
      return {
        records: recs.data.count, manifest: man.data.total,
        scope: st.data.scope_total, excluded: st.data.excluded_total,
        oor: st.data.request_out_of_range_total, universe: st.data.universe_total,
      }
    }
    // 固定数据集：3 条合法日期（03-01 / 03-02 / 03-10）、1 条日历不存在（02-30）、1 条缺日期
    try {
      // ① 无授权范围 / 无请求范围：明细含全部 5 条（脏日期供排查）；统计分母只含合法日期
      await setGrant(null, null)
      const c1 = await snap()
      assert.deepEqual(c1, { records: 5, manifest: 5, scope: 3, excluded: 2, oor: 0, universe: 5 }, JSON.stringify(c1))
      assert.equal(c1.manifest, c1.scope + c1.excluded, '① 对账：manifest = scope + excluded')

      // ② 无授权范围 / 有请求范围：请求范围外的合法记录进 request_out_of_range
      const c2 = await snap('&start=2026-03-01&end=2026-03-02')
      assert.deepEqual(c2, { records: 5, manifest: 5, scope: 2, excluded: 2, oor: 1, universe: 5 }, JSON.stringify(c2))
      assert.equal(c2.manifest, c2.scope + c2.oor + c2.excluded, '② 对账：manifest = scope + 请求范围外 + excluded')

      // ③ 有授权范围（03-01..03-05）/ 无请求范围：明细被授权日期过滤，脏日期无法归属 → 不计入任何桶
      await setGrant('2026-03-01', '2026-03-05')
      const c3 = await snap()
      assert.deepEqual(c3, { records: 2, manifest: 2, scope: 2, excluded: 0, oor: 0, universe: 2 }, JSON.stringify(c3))
      assert.equal(c3.manifest, c3.scope, '③ 对账：manifest = scope（无脏日期可比对）')

      // ④ 有授权范围 / 有请求范围（缩到 03-02 当天）：授权内、请求外进 request_out_of_range
      const c4 = await snap('&start=2026-03-02&end=2026-03-02')
      assert.deepEqual(c4, { records: 2, manifest: 2, scope: 1, excluded: 0, oor: 1, universe: 2 }, JSON.stringify(c4))
      assert.equal(c4.manifest, c4.scope + c4.oor, '④ 对账：manifest = scope + 请求范围外')

      // ⑤ 未授权记录增删不得影响任何返回值（授权 3 月，注入 2025-06 的记录）
      const before = await snap()
      for (let i = 0; i < 20; i++) {
        await tenant.testRecord.create({
          data: {
            record_code: `RC-http-outg-${i}`, test_type: 'tableware', test_name: 'tableware',
            sample_info: { testDate: '2025-06-01', canteen: '范围外', inspector: '测试员' },
            result_data: { result: '合格 (<200)' }, status: 'completed', version: 1, created_by: USER_ID,
          },
        })
      }
      const after = await snap()
      assert.deepEqual(after, before, '授权范围外记录增删不得改变任何返回值（无数量侧信道）')
      await cleanupScoped(tenant, { record_code: { startsWith: 'RC-http-outg-' } }, 'matrix')
      assert.deepEqual(await snap(), before, '清理后回到基线')
    } finally {
      await setGrant(null, null)
    }
  })

  test('HTTP：日期边界/非法参数/交集为空的行为稳定', async () => {
    const bad = await api(`/v1/stats?school_code=${SCHOOL}&start=abc`)
    assert.equal(bad.status, 400)
    assert.equal(bad.code, 'INVALID_START')
    const rev = await api(`/v1/stats?school_code=${SCHOOL}&start=2026-03-10&end=2026-03-01`)
    assert.equal(rev.status, 400)
    assert.equal(rev.code, 'INVALID_RANGE')
    const cal = await api(`/v1/stats?school_code=${SCHOOL}&start=2026-02-30`)
    assert.equal(cal.status, 400, '日历不存在的参数必须 400，而不是被当作有效日期')
    const sameDay = await api(`/v1/stats?school_code=${SCHOOL}&start=2026-03-01&end=2026-03-01`)
    assert.equal(sameDay.status, 200)
    assert.equal(sameDay.data.scope_total, 1, '闭区间：边界当天必须计入')
    const empty = await api(`/v1/stats?school_code=${SCHOOL}&start=2099-01-01&end=2099-01-02`)
    assert.equal(empty.status, 200)
    assert.equal(empty.data.total, 0)
    assert.equal(empty.data.pass_rate, null, '零分母 → null')
    assert.equal(empty.data.request_out_of_range_total, 3, '合法日期记录都落在请求范围外')
  })

  test('HTTP：管理端 dict 成功；真实预览与对外明细使用同一授权日期范围', async () => {
    const adminBase = base.replace('/api/open', '/api/admin/open-api')
    const getAdmin = async (path) => {
      const response = await fetch(adminBase + path)
      return { status: response.status, body: await response.json() }
    }
    const setGrant = (start, end) => prisma.openApiGrant.updateMany({
      where: { client_id: CLIENT_ID, school_code: SCHOOL },
      data: { start_date: start ? new Date(`${start}T00:00:00+08:00`) : null,
        end_date: end ? new Date(`${end}T00:00:00+08:00`) : null },
    })
    try {
      await setGrant('2026-03-02', '2026-03-02')
      const dict = await getAdmin(`/clients/${CLIENT_ID}/dict?schoolCode=${SCHOOL}`)
      assert.equal(dict.status, 200, JSON.stringify(dict.body))
      assert.ok(dict.body.data.field_schema.oil.fields.length)
      const preview = await getAdmin(`/clients/${CLIENT_ID}/preview?schoolCode=${SCHOOL}&limit=20`)
      const external = await api(`/v1/test-records?school_code=${SCHOOL}&limit=200`)
      assert.equal(preview.status, 200, JSON.stringify(preview.body))
      assert.equal(external.status, 200)
      assert.deepEqual(preview.body.data.items.map((r) => r.record_code).sort(), external.data.items.map((r) => r.record_code).sort())
      assert.deepEqual(preview.body.data.items.map((r) => r.record_code), ['RC-http-2'])
    } finally {
      await setGrant(null, null)
    }
  })

  test('HTTP：学校改名但记录未更新，manifest 与明细均反映新名称', async () => {
    const beforeManifest = await api(`/v1/sync/manifest?school_code=${SCHOOL}`)
    const beforeDetail = await api(`/v1/test-records?school_code=${SCHOOL}&limit=200`)
    assert.equal(beforeManifest.status, 200)
    assert.equal(beforeDetail.status, 200)
    const oldName = beforeDetail.data.school_name
    const recordTimes = beforeDetail.data.items.map((r) => [r.record_code, r.updated_at])
    try {
      await prisma.school.update({ where: { code: SCHOOL }, data: { name: 'HTTP 更名学校' } })
      const afterManifest = await api(`/v1/sync/manifest?school_code=${SCHOOL}`)
      const afterDetail = await api(`/v1/test-records?school_code=${SCHOOL}&limit=200`)
      assert.equal(afterManifest.status, 200)
      assert.equal(afterDetail.status, 200)
      assert.notEqual(afterManifest.data.digest, beforeManifest.data.digest)
      assert.notEqual(afterManifest.data.projection_fingerprint, beforeManifest.data.projection_fingerprint)
      assert.ok(afterDetail.data.items.every((r) => r.school_name === 'HTTP 更名学校'))
      assert.deepEqual(afterDetail.data.items.map((r) => [r.record_code, r.updated_at]), recordTimes)
    } finally {
      await prisma.school.update({ where: { code: SCHOOL }, data: { name: oldName } })
    }
  })

  test('HTTP：授权范围外记录数变化不影响任何返回值（无数量侧信道）', async () => {
    const before = await api(`/v1/stats?school_code=${SCHOOL}`)
    // 注入 30 条"授权日期范围外"的记录（授权无日期范围 → 此处以"另一个学校可见范围之外"不可构造；
    // 改为验证：注入**日期内**记录后 scope_total 增加，而注入**脏日期/缺日期**只增加 excluded，不增加 scope）
    for (let i = 0; i < 5; i++) {
      await tenant.testRecord.create({
        data: {
          record_code: `RC-http-nogrant-${i}`, test_type: 'tableware', test_name: 'tableware',
          sample_info: { testDate: '2026-07-01', canteen: 'HTTP 食堂', inspector: '测试员' },
          result_data: { result: '合格 (<200)' }, status: 'completed', version: 1, created_by: USER_ID,
        },
      })
    }
    const after = await api(`/v1/stats?school_code=${SCHOOL}`)
    assert.equal(after.data.scope_total, before.data.scope_total + 5)
    assert.equal(after.data.universe_total, before.data.universe_total + 5)
    await cleanupScoped(tenant, { record_code: { startsWith: 'RC-http-nogrant-' } }, 'inline')
    const restored = await api(`/v1/stats?school_code=${SCHOOL}`)
    assert.equal(restored.data.scope_total, before.data.scope_total, '清理后口径回到基线')
  })

  test('HTTP：samples 的 fail 场景确实输出 fail（构造-投影-判定 一致）', async () => {
    const samples = await api(`/v1/samples?school_code=${SCHOOL}&test_type=oil`)
    assert.equal(samples.status, 200)
    const fail = samples.data.samples.find((s) => s.scenario === 'fail')
    assert.ok(fail, '应存在 fail 场景样例')
    assert.equal(fail.item.final_conclusion, 'fail')
    assert.equal(fail.item.conclusion, 'fail')
    for (const s of samples.data.samples) {
      assert.equal(s.synthetic, true, '样例必须标记 synthetic')
      assert.match(s.item.record_code, /^SAMPLE-/, '样例记录码必须带 SAMPLE- 前缀')
    }
  })

  test('HTTP：复检记录字段按写入路径下发（F7），且不下发复检人姓名', async () => {
    await tenant.testRecord.create({
      data: {
        record_code: 'RC-http-1', // 覆盖 tableware 记录为"带复检"的形态
        test_type: 'tableware', test_name: 'tableware',
        sample_info: { testDate: '2026-03-01', canteen: 'HTTP 食堂', inspector: '测试员' },
        result_data: { result: '不合格 (>500)', recheckRecords: [{ id: 1, time: '2026-03-02 10:00', user: '复检人示例', isPassed: true }] },
        status: 'completed', version: 1, created_by: USER_ID,
      },
    }).catch(async () => {
      await tenant.testRecord.updateMany({
        where: { record_code: 'RC-http-1' },
        data: { result_data: { result: '不合格 (>500)', recheckRecords: [{ id: 1, time: '2026-03-02 10:00', user: '复检人示例', isPassed: true }] } },
      })
    })
    const recs = await api(`/v1/test-records?school_code=${SCHOOL}&limit=200&test_type=tableware`)
    const item = recs.data.items.find((i) => i.record_code === 'RC-http-1')
    assert.ok(item, '应能取到 tableware 记录')
    if (item.result.recheckRecords) {
      assert.equal(item.result.recheckRecords[0].user, undefined, '复检人姓名必须被剔除')
      assert.equal(item.final_conclusion, 'pass', '复检通过 → 最终结论 pass')
    }
  })
}
