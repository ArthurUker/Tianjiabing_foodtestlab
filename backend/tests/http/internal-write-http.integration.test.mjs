// 内部写入接口 · **真实登录 + HTTP 链路**集成回归（2026-09-17 复核轮补齐）
//
// 审阅意见：新增的 8 项 HTTP 测试验证的是**只读开放接口**，未覆盖曾发生数据丢失的写入链路
// （/api/records、/api/sync）。真实 JWT **不构成阻塞**：隔离库里建测试用户 → 走真实 `POST /api/user/login`
// → 拿真令牌 → 调用真实路由与真实中间件。
//
// 装配（与生产 server.js 的差异，不得称为完全等价）：
//   · 真实：express + express.json + UserManager(prisma, JWT_SECRET) + createAuthMiddleware +
//     createUserRoutes + createRecordRoutes + createSyncRoutes（路由内部的 apiKey/鉴权/租户客户端全为真实实现）。
//   · 不加载：server.js 的静态资源、上传、定时任务、钉钉等外部副作用；服务仅监听 127.0.0.1 随机端口。
//
// 隔离：tests/_isolation.mjs 门禁（连库前解析并校验库名/schema，写前断言 current_database/current_schema，
//      统一重定向 process.env.DATABASE_URL 使路由内 createTenantClient 指向隔离库）。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { require, isConfigured, assertIsolationConfig, assertIsolated, cleanupScoped } from '../_isolation.mjs'

const TEST_SCHEMA = 'school_reviewtest'
const SCHOOL = 'reviewtest'
const PASSWORD = 'Review-Test-Passw0rd!'
const EDITOR = 'http-editor'
const VIEWER = 'http-viewer'
const enabled = isConfigured()

if (!enabled) {
  test('内部写入 HTTP 链路（未设置 REVIEW_TEST_DATABASE_URL，跳过）', { skip: 'SKIP: TEST_DATABASE_URL not configured' }, () => {})
}

if (enabled) {
  const iso = assertIsolationConfig({ schema: TEST_SCHEMA })
  // ⚠️ 必须在导入 UserManager / authMiddleware **之前**设置：测试自有的 JWT 密钥 + test 模式
  process.env.NODE_ENV = 'test'
  process.env.JWT_SECRET = process.env.JWT_SECRET || `test-only-${crypto.randomBytes(16).toString('hex')}`

  const { PrismaClient } = require('@prisma/client')
  const express = require('express')
  const bcrypt = require('bcryptjs')
  const { default: UserManager } = await import('../../modules/UserManager.js')
  const { createUserRoutes } = await import('../../routes/userRoutes.js')
  const { createAuthMiddleware } = await import('../../middleware/authMiddleware.js')
  const { createTenantMiddleware } = await import('../../middleware/tenantMiddleware.js')
  const { createRecordRoutes } = await import('../../routes/recordRoutes.js')
  const { createSyncRoutes } = await import('../../routes/syncRoutes.js')

  const prisma = new PrismaClient({ datasources: { db: { url: iso.url } } })
  const tenant = new PrismaClient({ datasources: { db: { url: `${iso.url}${iso.url.includes('?') ? '&' : '?'}schema=${TEST_SCHEMA}` } } })

  let server
  let base
  let editorToken = null
  let viewerToken = null
  let editorUserId = null      // 认证身份（用于断言 created_by）
  let ctxId = null             // 用例间传递的记录 id（创建响应回传的真实 id）

  async function http(path, { method = 'GET', body, token } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    let json = null
    try { json = await res.json() } catch { /* 非 JSON */ }
    return { status: res.status, body: json }
  }
  const login = async (username, password = PASSWORD, schoolCode = SCHOOL) =>
    http('/api/user/login', { method: 'POST', body: { username, password, schoolCode } })

  test.before(async () => {
    await assertIsolated(prisma, iso.db, 'public 客户端')
    await assertIsolated(tenant, iso.db, '租户客户端')
    const [sc] = await tenant.$queryRawUnsafe('SELECT current_schema() AS s')
    assert.equal(sc.s, TEST_SCHEMA)

    const hash = await bcrypt.hash(PASSWORD, 10)
    for (const [username, role] of [[EDITOR, 'manager'], [VIEWER, 'viewer']]) {
      const existing = await tenant.user.findUnique({ where: { username } })
      if (existing) await tenant.user.delete({ where: { username } })
      await tenant.user.create({
        data: { username, password_hash: hash, role, full_name: username, school_code: SCHOOL, status: 'active' },
      })
    }
    editorUserId = (await tenant.user.findUnique({ where: { username: EDITOR } })).id
    // 清理按 created_by（本套件的用户）+ 记录码前缀双条件：POST /api/records 的记录码是**内容哈希**，
    // 只用前缀会漏删（此前导致与其它 HTTP 文件并发时互相污染计数）。
    await cleanupScoped(tenant, { created_by: editorUserId }, 'before')
    await cleanupScoped(tenant, { record_code: { startsWith: 'RC-ihttp-' } }, 'before')

    const userManager = new UserManager(prisma, process.env.JWT_SECRET)
    const auth = createAuthMiddleware(userManager, prisma)
    // ⚠️ 必须复刻 server.js:131-141 的包装：认证成功后补 `req.userId` / `req.userRole` 并挂载
    //    `attachTenant`（注入 req.db）。漏掉它会让依赖 `req.userId` 的路由（recordRoutes 的创建/更新分支）
    //    在 Prisma 层报 `Argument 'created_user' is missing` → 500。此前 5 项写入场景受阻即此原因（**测试装配缺陷**，非产品缺陷）。
    const attachTenant = createTenantMiddleware(prisma)
    const authenticateUser = (req, res, next) => {
      auth.authenticateUser(req, res, () => {
        if (req.user) {
          req.userId = req.user.userId
          req.userRole = req.user.role
        }
        attachTenant(req, res, next)
      })
    }
    const app = express()
    app.use(express.json())
    app.use('/api/user', createUserRoutes(userManager))
    // ⚠️ recordRoutes 内部路径自带 `/api/records/...`（见 routes/recordRoutes.js 的 router.post('/api/records/:tableName')），
    //    因此必须挂在**根**上（与 server.js 一致），不能挂 '/api/records'（会变成 /api/records/api/records/... → 404）。
    app.use(createRecordRoutes({
      authenticateUser,
      requireEditorOrAbove: auth.requireEditorOrAbove,
      requireGuestReadOnly: auth.requireGuestReadOnly,
      idempotencyMiddleware: (req, res, next) => next(),
    }))
    app.use('/api/sync', createSyncRoutes(userManager, prisma))
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    base = `http://127.0.0.1:${server.address().port}`

    const e = await login(EDITOR)
    assert.equal(e.status, 200, `编辑者登录失败：${JSON.stringify(e.body)}`)
    editorToken = e.body.token || e.body.accessToken
    assert.ok(editorToken, `登录响应缺少 token：${JSON.stringify(Object.keys(e.body || {}))}`)
    const v = await login(VIEWER)
    assert.equal(v.status, 200, `只读用户登录失败：${JSON.stringify(v.body)}`)
    viewerToken = v.body.token || v.body.accessToken
  })

  test.after(async () => {
    if (server) await new Promise((r) => server.close(r))
    if (editorUserId) await cleanupScoped(tenant, { created_by: editorUserId }, 'after')
    await cleanupScoped(tenant, { record_code: { startsWith: 'RC-ihttp-' } }, 'after')
    await tenant.user.deleteMany({ where: { username: { in: [EDITOR, VIEWER] } } })
    await prisma.$disconnect()
    await tenant.$disconnect()
  })

  /* ── 1. 真实登录与鉴权边界 ── */
  test('HTTP：真实登录（正确/错误口令）+ 无令牌写入 401 + 只读角色写入 403 + 跨学校登录被拒', async () => {
    const bad = await login(EDITOR, 'wrong-password')
    assert.equal(bad.status, 401, `错误口令应 401，实际 ${bad.status}`)

    // 跨校登录：**根因已查明**（2026-09-17 复核对二轮）——
    // ① 隔离库不存在 `school_tjb` schema → tenant 客户端查询报 P2021 → 500（**测试环境产物**，非产品缺陷）；
    // ② 生产路径的"学校不匹配"分支确实返回 **401 USER_NOT_FOUND**（见 modules/UserManager.js 的 mismatch 分支）。
    // 因此这里改为**精确构造不匹配场景**：在 school_reviewtest 里放一个 school_code 字段与所属 schema 不一致的用户，
    // 走真实登录接口，断言 401 与响应结构（不泄露账号是否存在：与"用户不存在"返回同码同文案）。
    await tenant.user.deleteMany({ where: { username: 'http-crossuser' } })
    await tenant.user.create({
      data: {
        username: 'http-crossuser', password_hash: await bcrypt.hash(PASSWORD, 10), role: 'manager',
        full_name: 'cross', school_code: 'reviewalt', status: 'active',   // 字段与 schema 不一致
      },
    })
    const cross = await login('http-crossuser', PASSWORD, SCHOOL)
    assert.equal(cross.status, 401, `学校不匹配必须 401，实际 ${cross.status}`)
    assert.ok(!cross.body?.token && !cross.body?.accessToken, '不得下发令牌')
    await tenant.user.deleteMany({ where: { username: 'http-crossuser' } })

    // 不存在的账号：**同码同文案**（防枚举）——与"学校不匹配"逐字段一致
    const ghost = await login('no-such-user-xyz', PASSWORD, SCHOOL)
    assert.equal(ghost.status, 401, `不存在的账号应 401，实际 ${ghost.status}`)
    // 防枚举断言：两种失败的**响应体逐字节相同**（含 code 与文案），不给攻击者任何区分信号
    const j = (b) => JSON.stringify(b)
    assert.ok(j(cross).includes('用户名或密码错误'), `不匹配文案异常：${j(cross)}`)
    assert.ok(j(ghost).includes('用户名或密码错误'), `不存在文案异常：${j(ghost)}`)
    assert.equal(j(cross), j(ghost), '「学校不匹配」与「账号不存在」必须返回完全相同的响应体')

    const noToken = await http('/api/records/oil', { method: 'POST', body: { testDate: '2026-04-01', canteen: 'X', inspector: 'Y', result: '合格' } })
    assert.equal(noToken.status, 401, '无令牌写入必须 401')

    const viewerWrite = await http('/api/records/oil', {
      method: 'POST', token: viewerToken,
      body: { testDate: '2026-04-01', canteen: 'X', inspector: 'Y', result: '合格' },
    })
    assert.equal(viewerWrite.status, 403, `viewer 写入必须 403，实际 ${viewerWrite.status}`)
  })

  /* ── 2. 只改上下文：结果与复检数组必须保留（真实 HTTP） ── */
  test('HTTP：只改食堂 → 原检测结果与复检数组保留（P0-1 的真实链路验证）', async () => {
    const created = await http('/api/records/oil', {
      method: 'POST', token: editorToken,
      body: {
        testDate: '2026-04-01', canteen: 'A 食堂', inspector: '测试员',
        client_code: 'RC-ihttp-1', record_code: 'RC-ihttp-1',
        result_data: {
          tpmValue: '0.30', colorLevel: '合格', oil: { result: '合格' },
          recheckRecords: [{ id: 1, time: '2026-04-02 10:00', user: '复检人示例', isPassed: true }],
        },
      },
    })
    assert.equal(created.status, 200, `创建失败：${JSON.stringify(created.body)}`)
    // 创建成功必须同时断言：记录存在 + 创建者正确（不能只断言"记录数"）
    const createdDoc = created.body?.data
    assert.ok(createdDoc?.id, `响应应回传记录体：${JSON.stringify(created.body)}`)
    const row = await tenant.testRecord.findUnique({ where: { id: createdDoc.id } })
    assert.ok(row, '记录应已落库')
    assert.equal(row.created_by, editorUserId, 'created_by 必须是认证身份（req.userId → createAuthMiddleware 的 req.user.userId）')
    ctxId = row.id
    assert.equal(String(row.record_code).startsWith('RC-'), true, `record_code 应为 RC-* 形态：${row.record_code}`)

    const updated = await http('/api/sync/records', {
      method: 'POST', token: editorToken,
      body: { action: 'update', store: 'oil', data: { id: row.id, result_data: { canteen: 'B 食堂' } } },
    })
    assert.equal(updated.status, 200, `更新失败：${JSON.stringify(updated.body)}`)
    const after = await tenant.testRecord.findUnique({ where: { id: row.id } })
    const rd = typeof after.result_data === 'string' ? JSON.parse(after.result_data) : after.result_data
    const si = typeof after.sample_info === 'string' ? JSON.parse(after.sample_info) : after.sample_info
    assert.equal(si.canteen, 'B 食堂', '上下文键必须写回 sample_info')
    assert.equal(rd.tpmValue, '0.30', '原测量值必须保留')
    assert.deepEqual(rd.oil, { result: '合格' }, '兄弟字段必须保留')
    assert.ok(Array.isArray(rd.recheckRecords) && rd.recheckRecords.length === 1, '复检数组必须保留')
  })

  /* ── 3. 扁平更新必须真正落库 ── */
  test('HTTP：扁平业务字段更新（data:{id,result}）必须真正保存，不得"成功但无变更"', async () => {
    assert.ok(ctxId, '前置记录存在')
    const res = await http('/api/sync/records', {
      method: 'POST', token: editorToken,
      body: { action: 'update', store: 'oil', data: { id: ctxId, result: '不合格 (>0.25)' } },
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const after = await tenant.testRecord.findUnique({ where: { id: ctxId } })
    const rd = typeof after.result_data === 'string' ? JSON.parse(after.result_data) : after.result_data
    assert.equal(rd.result, '不合格 (>0.25)', '扁平业务字段必须落库')
    assert.equal(rd.tpmValue, '0.30', '扁平更新不得丢兄弟字段')
  })

  /* ── 4. 版本并发：同一版本两次更新只有一个成功 ── */
  test('HTTP：同一 expected_version 的两次更新，仅一次成功（另一次 409）', async () => {
    const row = await tenant.testRecord.findUnique({ where: { id: ctxId } })
    const v0 = row.version
    const first = await http('/api/sync/records', {
      method: 'POST', token: editorToken,
      body: { action: 'update', store: 'oil', data: { id: row.id, expected_version: v0, result_data: { tpmValue: '0.11' } } },
    })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const second = await http('/api/sync/records', {
      method: 'POST', token: editorToken,
      body: { action: 'update', store: 'oil', data: { id: row.id, expected_version: v0, result_data: { tpmValue: '0.99' } } },
    })
    assert.equal(second.status, 409, '陈旧版本必须 409')
    assert.equal(second.body.code, 'VERSION_CONFLICT')
    const after = await tenant.testRecord.findUnique({ where: { id: row.id } })
    const rd = typeof after.result_data === 'string' ? JSON.parse(after.result_data) : after.result_data
    assert.equal(rd.tpmValue, '0.11', '冲突请求不得写入')
    assert.equal(after.version, v0 + 1)
  })

  /* ── 5. 批量部分失败 + 重试幂等 ── */
  test('HTTP：批量部分失败（逐项可对应）与重试幂等（不重复创建）', async () => {
    assert.ok(ctxId, '前置记录存在')
    const batch = await http('/api/sync/batch', {
      method: 'POST', token: editorToken,
      body: {
        operations: [
          { action: 'update', store: 'oil', syncId: 'ok-1', data: { id: ctxId, result_data: { tpmValue: '0.12' } } },
          { action: 'update', store: 'oil', syncId: 'bad-1', data: { id: 'nonexistent-id-000', result_data: { tpmValue: '0.5' } } },
        ],
      },
    })
    assert.equal(batch.status, 200, JSON.stringify(batch.body))
    assert.equal(batch.body.failed, 1, '应有一项失败')
    assert.equal(batch.body.succeeded, 1, '应有一项成功')
    assert.equal(batch.body.results[0].syncId, 'ok-1')
    assert.equal(batch.body.errors[0].syncId, 'bad-1', '失败项必须能与原项对应')

    // 重试成功项：同一 payload 再发一次不得重复创建（按 created_by 计数，覆盖哈希记录码）
    const before = await tenant.testRecord.count({ where: { created_by: editorUserId } })
    const retry = await http('/api/sync/batch', {
      method: 'POST', token: editorToken,
      body: { operations: [{ action: 'update', store: 'oil', syncId: 'ok-1', data: { id: ctxId, result_data: { tpmValue: '0.12' } } }] },
    })
    assert.equal(retry.status, 200)
    assert.equal(retry.body.failed, 0, JSON.stringify(retry.body.errors))
    const after = await tenant.testRecord.count({ where: { created_by: editorUserId } })
    assert.equal(after, before, '重试不得产生新记录')
  })

  /* ── 6. 幂等创建：同一 record_code 重放不重复建 ── */
  test('HTTP：带 record_code 的重复创建按幂等处理（不重复建记录）', async () => {
    const body = {
      action: 'add', store: 'oil',
      data: { testDate: '2026-04-03', canteen: 'C 食堂', inspector: '测试员', record_code: 'RC-ihttp-2', result_data: { tpmValue: '0.09' } },
    }
    const first = await http('/api/sync/records', { method: 'POST', token: editorToken, body })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const second = await http('/api/sync/records', { method: 'POST', token: editorToken, body })
    assert.equal(second.status, 200)
    const rows = await tenant.testRecord.findMany({ where: { record_code: 'RC-ihttp-2' } })
    assert.equal(rows.length, 1, '同一 record_code 必须只有一条（幂等）')
  })
}
