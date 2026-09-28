// P3-W5-RECORD-T01 · AUD-002（RC-01）幂等作用域矩阵 —— **必须用隔离测试库**
//
// 验证（RC-01「server idempotency」契约）：
//   ① 认证/授权先于幂等命中（撤回权限后，同 key 请求必须被拒，不得命中旧缓存）；
//   ② 身份键绑定 tenant + subject + resource + method + operationId ⇒ 不同学校/不同账号同 key 同 body 不互相命中；
//   ③ 合法同主体重试仍去重（命中缓存，不二次写库）；
//   ④ 同键异载荷 = 明确 409 冲突（不是"另一条新请求"）；
//   ⑤ 既有确定性 recordCode 查重路径不得跨租户返回他人记录（A/B 校同 body → 各自独立行）。
//
// 启用：TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE（缺 → fail-closed，不 skip）
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { require, loadIsolation, assertIsolated as gateAssert, cleanupScoped } from '../_isolation.mjs'

const isoInfo = loadIsolation()
const enabled = isoInfo.ok

if (!enabled) {
  test('AUD-002 幂等作用域：[T02C] 未配置显式 TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE → 拒绝（fail-closed）', () => {
    assert.fail(`[T02C-ISOLATION-REFUSED] code=${isoInfo.code || 'UNKNOWN'} reason=${isoInfo.reason || 'n/a'}`)
  })
}

if (enabled) {
  process.env.DATABASE_URL = isoInfo.url
  const { PrismaClient } = require('@prisma/client')
  const { createRecordRoutes } = await import('../../routes/recordRoutes.js')
  const idempotencyMiddleware = (await import('../../middleware/idempotencyMiddleware.js')).default
  const { tenantScopeOf, subjectScopeOf, idempotencyScopeOf, __idempotencyInternals } = await import('../../middleware/idempotencyMiddleware.js')

  const TENANT_A = isoInfo.tenant('a')
  const TENANT_B = isoInfo.tenant('b')
  const dbA = new PrismaClient({ datasources: { db: { url: TENANT_A.urlWithSchema } } })
  const dbB = new PrismaClient({ datasources: { db: { url: TENANT_B.urlWithSchema } } })

  const CODE_PREFIX = 'RC-aud002-'
  const users = {
    'A-editor-1': { userId: 'u-a1', role: 'editor', schoolCode: TENANT_A.tenantCode },
    'A-editor-2': { userId: 'u-a2', role: 'editor', schoolCode: TENANT_A.tenantCode },
    'B-editor-1': { userId: 'u-b1', role: 'editor', schoolCode: TENANT_B.tenantCode },
    'A-guest': { userId: 'u-a3', role: 'guest', schoolCode: TENANT_A.tenantCode },
  }

  function makeApp() {
    const authenticateUser = (req, res, next) => {
      const u = users[req.headers['x-test-user']]
      if (!u) return res.status(401).json({ error: 'unauthorized' })
      req.user = { ...u }
      req.userId = u.userId
      req.db = u.schoolCode === TENANT_A.tenantCode ? dbA : dbB
      // express 5：req.ip 是只读 getter，测试桩不再赋值（审计日志 ip 记为 undefined，不影响本套件断言）
      next()
    }
    const requireEditorOrAbove = (req, res, next) => {
      if (!['editor', 'operator', 'manager', 'super_admin'].includes(req.user?.role)) {
        return res.status(403).json({ error: 'forbidden' })
      }
      next()
    }
    const requireGuestReadOnly = (req, res, next) => next()
    const router = createRecordRoutes({ authenticateUser, requireEditorOrAbove, requireGuestReadOnly, idempotencyMiddleware })
    const app = express()
    app.use(express.json())
    app.use(router)
    return app
  }
  const app = makeApp()
  const createdIds = []

  const body = (canteen, batch) => ({
    testDate: '2026-09-25', canteen, inspector: '测试员', vegetableType: '青菜', batchNo: batch, result: '合格',
  })
  const recordIds = (resp) => {
    const id = resp && resp.body && resp.body.data && resp.body.data.id
    if (id) createdIds.push(id)
    return id
  }
  const post = async (userKey, key, payload, path = '/api/records/pesticide') => {
    const resp = await request(app).post(path).set('x-test-user', userKey).set('Idempotency-Key', key).send(payload)
    recordIds(resp)
    return resp
  }

  test.before(async () => {
    await gateAssert(dbA, TENANT_A.schema, 'tenant A')
    await gateAssert(dbB, TENANT_B.schema, 'tenant B')
    // created_by 为 Restrict 外键：测试桩主体必须在各自租户 User 表存在
    for (const [client, ids] of [[dbA, ['u-a1', 'u-a2', 'u-a3']], [dbB, ['u-b1']]]) {
      for (const id of ids) {
        await client.user.upsert({ where: { id }, update: {}, create: { id, username: id, password_hash: 'x', role: 'editor', full_name: 'aud002', school_code: null } })
      }
    }
    __idempotencyInternals.clear()
  })
  test.after(async () => {
    // 只清理本套件创建的行：canteen 一律带 `RC-aud002-` 标记（精确，不误伤 fixture/其它套件）
    const where = { sample_info: { path: ['canteen'], string_contains: 'RC-aud002-' } }
    await cleanupScoped(dbA, where, 'aud002 A')
    await cleanupScoped(dbB, where, 'aud002 B')
    await dbA.$disconnect()
    await dbB.$disconnect()
  })

  test('作用域推导：tenant/subject/resource 来自认证上下文（不用请求体声明）', () => {
    const req = {
      method: 'POST',
      baseUrl: '/api/records',
      route: { path: '/:tableName' },
      path: '/api/records/pesticide',
      headers: { 'idempotency-key': 'k1' },
      user: { userId: 'u-x', role: 'editor', schoolCode: 'school-a' },
    }
    assert.equal(tenantScopeOf(req), 'school:school-a')
    assert.equal(subjectScopeOf(req), 'user:u-x')
    const scope = idempotencyScopeOf(req)
    // R1：resource = `METHOD <模板>#<规范化具体资源>[#参数]` —— 模板保留可读性，具体资源进入身份
    assert.ok(scope.resource.startsWith('POST /api/records/:tableName#'), `resource 形状: ${scope.resource}`)
    assert.ok(scope.resource.includes('/api/records/pesticide'), 'resource 必须含规范化实参路径（R1）')
    // 身份键不含 payload；换主体/换资源/换 key 都得到不同身份
    const other = { ...req, user: { ...req.user, userId: 'u-y' } }
    assert.notEqual(idempotencyScopeOf(other).identity, scope.identity)
    const otherRes = { ...req, route: { path: '/:tableName/bulk-upsert' } }
    assert.notEqual(idempotencyScopeOf(otherRes).identity, scope.identity)
  })

  // R1（R3 复审反例 2）：同用户同 key/body 对两个**不同具体记录**的 PUT 必须分别执行、返回各自 id；
  // 同目标重试仍去重；同目标异载荷仍 409。判别不只看哈希：断言两个 handler 都实际落库（各自 id/字段可核）。
  test('同 key/body 对两个不同具体记录：各自执行并返回各自 id（旧实现误命中第一条）', async () => {
    const key = `idem-${randomUUID()}`
    const createdA = []
    const mk = async (batch) => {
      const r = await post('A-editor-1', `aud002-cr-create-${batch}`, body(`具体资源食堂-${CODE_PREFIX}`, batch))
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const id = r.body?.data?.id
      assert.ok(id, '需要创建成功并拿到 id')
      createdA.push(id)
      return id
    }
    const id1 = await mk('BATCH-CR1')
    const id2 = await mk('BATCH-CR2')
    assert.notEqual(id1, id2)

    const put = (id, payload) => request(app).put(`/api/records/pesticide/${id}`).set('x-test-user', 'A-editor-1').set('Idempotency-Key', key).send(payload)
    const p1 = { ...body(`具体资源食堂-${CODE_PREFIX}`, 'BATCH-CR1'), inspector: '甲' }
    const p2 = { ...body(`具体资源食堂-${CODE_PREFIX}`, 'BATCH-CR2'), inspector: '乙' }

    const r1 = await put(id1, p1)
    const r2 = await put(id2, p2)
    assert.equal(r1.status, 200, `r1: ${JSON.stringify(r1.body)}`)
    assert.equal(r2.status, 200, `r2: ${JSON.stringify(r2.body)}`)
    assert.equal(r1.body?.data?.id, id1)
    assert.equal(r2.body?.data?.id, id2, '第二条必须返回**自己**的 id（旧实现会返回第一条的 id）')
    assert.notDeepEqual(r2.body, r1.body, '两条不同记录的响应不得是同一缓存对象')

    // 同目标重试（同 key 同 body 同路径）→ 仍去重：命中缓存，响应逐字一致
    const r1again = await put(id1, p1)
    assert.equal(r1again.status, 200)
    assert.deepEqual(r1again.body, r1.body, '同目标重试必须命中缓存')

    // 同目标异载荷 → 409（契约不变）
    const conflict = await put(id1, { ...p1, inspector: '丙' })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSE_DIFFERENT_PAYLOAD')
  })

  test('A/B 校同 key 同 body：不跨租户命中，且各自落各自 schema（recordCode 查重不返回他人记录）', async () => {
    const key = `idem-${randomUUID()}`
    const payload = body(`跨校食堂-${CODE_PREFIX}`, 'BATCH-X1')
    const rA = await post('A-editor-1', key, payload)
    const rB = await post('B-editor-1', key, payload)
    assert.equal(rA.status, 200, `A 校写入失败: ${JSON.stringify(rA.body)}`)
    assert.equal(rB.status, 200, `B 校写入失败: ${JSON.stringify(rB.body)}`)
    // B 校得到的必须是**自己**的记录（B 校此前无该记录 → 非 deduplicated；若命中 A 的缓存/记录会是 deduplicated 或返回 A 校行）
    assert.notEqual(rB.body.deduplicated, true, 'B 校不得命中 A 校的既有记录（跨租户复用）')
    // 业务字段经 normalizeWriteJson 落 result_data（上下文三键才落 sample_info）
    const rowsA = await dbA.testRecord.findMany({ where: { result_data: { path: ['batchNo'], equals: 'BATCH-X1' } } })
    const rowsB = await dbB.testRecord.findMany({ where: { result_data: { path: ['batchNo'], equals: 'BATCH-X1' } } })
    assert.equal(rowsA.length, 1, 'A 校恰好 1 行')
    assert.equal(rowsB.length, 1, 'B 校恰好 1 行（独立 schema 行，不共享 record_code 行）')
    assert.notEqual(rowsA[0].id, rowsB[0].id)
  })

  test('同租户不同主体同 key 同 body：不共享缓存（第二次进入 handler → deduplicated）', async () => {
    const key = `idem-${randomUUID()}`
    const payload = body(`同校食堂-${CODE_PREFIX}`, 'BATCH-X2')
    const r1 = await post('A-editor-1', key, payload)
    const r2 = await post('A-editor-2', key, payload)
    assert.equal(r1.status, 200)
    assert.equal(r2.status, 200)
    // 命中缓存会逐字返回 r1 的响应（无 deduplicated 标记）；进入 handler 才会带 deduplicated:true
    assert.equal(r2.body.deduplicated, true, '不同主体不得互相命中幂等缓存')
  })

  test('同主体同 key 同 body：合法重试命中缓存（不二次写库）', async () => {
    const key = `idem-${randomUUID()}`
    const payload = body(`重试食堂-${CODE_PREFIX}`, 'BATCH-X3')
    const r1 = await post('A-editor-1', key, payload)
    const r2 = await post('A-editor-1', key, payload)
    assert.equal(r1.status, 200)
    assert.equal(r2.status, 200)
    assert.deepEqual(r2.body, r1.body, '同主体重试必须命中同一缓存结果')
    const rows = await dbA.testRecord.count({ where: { result_data: { path: ['batchNo'], equals: 'BATCH-X3' } } })
    assert.equal(rows, 1)
  })

  test('同键异载荷：明确 409 冲突（不当新请求执行）', async () => {
    const key = `idem-${randomUUID()}`
    const r1 = await post('A-editor-1', key, body(`冲突食堂-${CODE_PREFIX}`, 'BATCH-X4'))
    assert.equal(r1.status, 200)
    const r2 = await post('A-editor-1', key, body(`冲突食堂-${CODE_PREFIX}`, 'BATCH-X4-CHANGED'))
    assert.equal(r2.status, 409)
    assert.equal(r2.body.code, 'IDEMPOTENCY_KEY_REUSE_DIFFERENT_PAYLOAD')
    const changed = await dbA.testRecord.count({ where: { result_data: { path: ['batchNo'], equals: 'BATCH-X4-CHANGED' } } })
    assert.equal(changed, 0, '冲突载荷不得落库')
  })

  test('权限撤回后：同 key 请求被拒（不得命中旧缓存）', async () => {
    const key = `idem-${randomUUID()}`
    const payload = body(`撤权食堂-${CODE_PREFIX}`, 'BATCH-X5')
    const r1 = await post('A-editor-1', key, payload)
    assert.equal(r1.status, 200)
    // 撤回：该账号变为 guest（requireEditorOrAbove 拒绝）
    users['A-editor-1'].role = 'guest'
    const r2 = await post('A-editor-1', key, payload)
    assert.equal(r2.status, 403, '权限撤回后必须 403 —— 命中不得绕过当前授权')
    users['A-editor-1'].role = 'editor'
  })

  test('无 Idempotency-Key：不受中间件影响（两次都进入 handler）', async () => {
    const p1 = body(`无键食堂-${CODE_PREFIX}`, 'BATCH-X6')
    const r1 = await request(app).post('/api/records/pesticide').set('x-test-user', 'A-editor-1').send(p1)
    const r2 = await request(app).post('/api/records/pesticide').set('x-test-user', 'A-editor-1').send(body(`无键食堂-${CODE_PREFIX}`, 'BATCH-X6-B'))
    assert.equal(r1.status, 200)
    assert.equal(r2.status, 200)
    assert.notEqual(r2.body.deduplicated, true)
  })

  test('legacy POST /api/test-records：同样按作用域隔离（A/B 校同 key 同 body 不跨命中）', async () => {
    const key = `idem-${randomUUID()}`
    const payload = {
      test_type: 'pesticide', test_name: '果蔬检测',
      sample_info: { testDate: '2026-09-25', canteen: `legacy食堂-${CODE_PREFIX}`, inspector: '测试员' },
      result_data: { vegetableType: '白菜', batchNo: 'LEGACY-X1', result: '合格' },
    }
    const rA = await post('A-editor-1', key, payload, '/api/test-records')
    const rB = await post('B-editor-1', key, payload, '/api/test-records')
    assert.equal(rA.status, 200, JSON.stringify(rA.body))
    assert.equal(rB.status, 200, JSON.stringify(rB.body))
    assert.notEqual(rB.body.deduplicated, true, 'B 校不得因同 body 命中 A 校记录')
  })

  test('bulk-upsert 与 PUT 也在鉴权之后挂载（同主体重试命中缓存）', async () => {
    const keyBulk = 'aud002-bulk-1'
    const bulkPayload = { records: [{ testDate: '2026-09-25', canteen: `批量食堂-${CODE_PREFIX}`, inspector: '测试员', vegetableType: '菠菜', batchNo: 'BULK-X1', result: '合格' }] }
    const b1 = await request(app).post('/api/records/pesticide/bulk-upsert').set('x-test-user', 'A-editor-1').set('Idempotency-Key', keyBulk).send(bulkPayload)
    const b2 = await request(app).post('/api/records/pesticide/bulk-upsert').set('x-test-user', 'A-editor-1').set('Idempotency-Key', keyBulk).send(bulkPayload)
    assert.equal(b1.status, 200, JSON.stringify(b1.body))
    assert.deepEqual(b2.body, b1.body, 'bulk-upsert 同主体重试应命中缓存')
  })
}
