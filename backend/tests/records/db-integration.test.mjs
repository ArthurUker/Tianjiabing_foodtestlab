// 数据库级集成回归（**必须使用隔离测试库**，禁止指向生产）
//
// 启用方式（未设置则整体跳过）：
//   REVIEW_TEST_DATABASE_URL='postgresql://USER:PASS@127.0.0.1:5432/foodsentinel_review_test' \
//     node --test tests/records/db-integration.test.mjs
// 库名必须包含 "reviewtest"（防止误连生产）；租户 schema 由 `prisma db push` 预建（见测试说明）。
//
// 覆盖审阅要求的完整回归链路 1~10（真实 DB：JSON 写入/读取、唯一约束、版本冲突、租户隔离）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { require, isConfigured, assertIsolationConfig, assertIsolated, cleanupScoped } from '../_isolation.mjs'

const URL = process.env.REVIEW_TEST_DATABASE_URL || ''
const TEST_SCHEMA = 'school_reviewtest'   // 固定：不再允许 REVIEW_TEST_SCHEMA 任意指定（F8）
const enabled = isConfigured()

if (!enabled) {
  test('DB 集成测试（未设置 REVIEW_TEST_DATABASE_URL，跳过）', { skip: 'SKIP: TEST_DATABASE_URL not configured' }, () => {})
}

if (enabled) {
  // 配置级门禁：解析连接串 + 校验库名/schema（在创建任何客户端之前）
  const iso = assertIsolationConfig({ schema: TEST_SCHEMA })

  const { PrismaClient } = require('@prisma/client')
  const { buildRecordPayload, buildDeterministicRecordCode } = await import('../../lib/recordNormalize.js')
  const { buildOpenRecord } = await import('../../lib/openApiScope.js')
  const { allowedResultKeys, buildSyntheticSamples } = await import('../../lib/openApiFieldSchema.js')
  const { createSyncRoutes } = await import('../../routes/syncRoutes.js')
  const { createRecordRoutes } = await import('../../routes/recordRoutes.js')

  const tenantUrl = `${URL}${URL.includes('?') ? '&' : '?'}schema=${TEST_SCHEMA}`
  const db = new PrismaClient({ datasources: { db: { url: tenantUrl } } })
  const publicDb = new PrismaClient({ datasources: { db: { url: URL } } })

  const noop = (req, res, next) => next()
  const PRISMA_STUB = { $executeRawUnsafe: async () => 1, $queryRawUnsafe: async () => [] }
  const syncRouter = createSyncRoutes(PRISMA_STUB, PRISMA_STUB)
  const recordRouter = createRecordRoutes({ authenticateUser: noop, requireEditorOrAbove: noop, requireGuestReadOnly: noop, idempotencyMiddleware: noop })
  const handlerOf = (router, method, path) => {
    for (const l of router.stack) if (l.route && l.route.path === path && l.route.methods[method]) return l.route.stack[l.route.stack.length - 1].handle
    throw new Error(`路由未找到 ${method} ${path}`)
  }
  const SYNC = handlerOf(syncRouter, 'post', '/records')
  const REC_CREATE = handlerOf(recordRouter, 'post', '/api/records/:tableName')

  const makeRes = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this },
    send(b) { this.body = b; return this }, setHeader() {},
  })
  const call = async (handler, body, opts = {}) => {
    const req = {
      body, db, params: opts.params || {}, query: opts.query || {},
      user: { role: opts.role || 'manager', userId: opts.userId || USER_ID }, userId: opts.userId || USER_ID,
      ip: '127.0.0.1', get: () => 'test.local',
    }
    const res = makeRes()
    await handler(req, res)
    return res
  }

  const USER_ID = 'u-review-owner'
  const OTHER_ID = 'u-review-other'
  const CTX = { testDate: '2026-03-01', canteen: '第一食堂', inspector: '张三' }
  const GRANT = { visible_types: ['tableName' === 'x' ? 'oil' : 'oil'], include_pathogen: true, include_inspector: false }

  test.before(async () => {
    // 运行时双确认：真实库名必须等于配置中的隔离库（写操作之前）
    await assertIsolated(db, iso.db, '租户客户端')
    await assertIsolated(publicDb, iso.db, 'public 客户端')
    for (const [id, name] of [[USER_ID, 'review-owner'], [OTHER_ID, 'review-other']]) {
      await db.user.upsert({ where: { id }, update: {}, create: { id, username: name, password_hash: 'x', role: 'manager', full_name: name } })
    }
    // 范围清理：只删本套件两个测试用户创建的记录（旧实现是无条件 deleteMany({})，F8）
    await cleanupScoped(db, { created_by: { in: [USER_ID, OTHER_ID] } }, 'before')
  })

  test.after(async () => {
    await cleanupScoped(db, { created_by: { in: [USER_ID, OTHER_ID] } }, 'after')
    await db.$disconnect()
    await publicDb.$disconnect()
  })

  /* ─── 链路 1：旧平铺载荷创建 → 读 → 只改一个值 → 再读 ─── */
  test('链路1/2：旧平铺载荷创建 → 读 → 只提交 result_data 内的食堂变更 → 保留（H1）', async () => {
    const created = await call(REC_CREATE, { ...CTX, tpmValue: '0.06' }, { params: { tableName: 'oil' } })
    assert.equal(created.statusCode, 200)
    const row = await db.testRecord.findFirst({ where: { test_type: 'oil' } })
    assert.ok(row, '记录已写入')
    assert.deepEqual(row.sample_info, CTX)
    assert.deepEqual(row.result_data, { tpmValue: '0.06' })

    const read1 = buildRecordPayload(row)
    assert.equal(read1.canteen, '第一食堂')
    assert.equal(read1.inspector, '张三')

    const updated = await call(SYNC, { action: 'update', store: 'oil', data: { id: row.id, result_data: { canteen: '第二食堂', tpmValue: '0.9' } } }, { userId: USER_ID })
    assert.equal(updated.statusCode, 200)
    const after = await db.testRecord.findUnique({ where: { id: row.id } })
    assert.equal(after.sample_info.canteen, '第二食堂', '请求里的新食堂必须落库')
    assert.equal(after.sample_info.inspector, '张三')
    assert.deepEqual(after.result_data, { tpmValue: '0.9' })
    assert.equal(buildRecordPayload(after).canteen, '第二食堂')
  })

  /* ─── 链路 3：显式清空不得让旧副本复活 ─── */
  test('链路3：显式清空 sample_info.canteen → buildRecordPayload 不复活 result_data 里的旧副本', async () => {
    const row = await db.testRecord.findFirst({ where: { test_type: 'oil' } })
    await db.testRecord.update({ where: { id: row.id }, data: { sample_info: { ...row.sample_info, canteen: '' }, result_data: { ...row.result_data, canteen: '历史旧食堂' } } })
    const after = await db.testRecord.findUnique({ where: { id: row.id } })
    assert.equal(buildRecordPayload(after).canteen, '', '权威位置空串 = 显式清空')
    const open = buildOpenRecord(after, GRANT, { schoolCode: 'reviewtest', allowedResultKeys: allowedResultKeys('oil') })
    assert.equal(open.canteen, '')
  })

  /* ─── 链路 4：历史冲突记录在不同读入口一致 ─── */
  test('链路4：sample_info 与 result_data 副本冲突时，内部读与开放接口取值一致（M1）', async () => {
    const row = await db.testRecord.findFirst({ where: { test_type: 'oil' } })
    await db.testRecord.update({
      where: { id: row.id },
      data: { sample_info: { ...row.sample_info, canteen: '权威食堂', testDate: '2026-04-01' }, result_data: { ...row.result_data, canteen: '副本食堂', testDate: '2026-03-01' } },
    })
    const after = await db.testRecord.findUnique({ where: { id: row.id } })
    const flat = buildRecordPayload(after)
    const open = buildOpenRecord(after, GRANT, { schoolCode: 'reviewtest', allowedResultKeys: allowedResultKeys('oil') })
    assert.equal(flat.canteen, '权威食堂')
    assert.equal(open.canteen, '权威食堂')
    assert.equal(flat.testDate, '2026-04-01')
    assert.equal(open.test_date, '2026-04-01')
  })

  /* ─── 链路 5：空对象 / 非法结构不破坏已有记录 ─── */
  test('链路5：非法/空载荷被拒，且已有记录内容不变（H2）', async () => {
    const before = await db.testRecord.findFirst({ where: { test_type: 'oil' } })
    const bad1 = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, result_data: 'oops' } }, { userId: USER_ID })
    assert.equal(bad1.statusCode, 400)
    const bad2 = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, result_data: {} } }, { userId: USER_ID })
    assert.equal(bad2.statusCode, 200, '空对象 = 不改动（幂等）')
    const after = await db.testRecord.findUnique({ where: { id: before.id } })
    assert.deepEqual(after.result_data, before.result_data, '非法/空载荷不得改动结果数据')
  })

  /* ─── 链路 6：重试不新增重复记录 ─── */
  test('链路6：同一载荷重试不新增记录（record_code 唯一约束 + 幂等）', async () => {
    const payload = { ...CTX, testDate: '2026-05-05', result: '合格', rluValue: '120' }
    const first = await call(REC_CREATE, payload, { params: { tableName: 'tableware' } })
    const second = await call(REC_CREATE, payload, { params: { tableName: 'tableware' } })
    assert.equal(first.statusCode, 200)
    assert.equal(second.body.deduplicated, true)
    const code = buildDeterministicRecordCode('tableware', payload)
    assert.equal(await db.testRecord.count({ where: { record_code: code } }), 1)
  })

  /* ─── 链路 7：无权限的冲突记录不回显（M5） ─── */
  test('链路7：他人 record_code 冲突 → 409 且不回显记录体', async () => {
    const owned = await db.testRecord.findFirst({ where: { created_by: USER_ID } })
    const res = await call(SYNC, { action: 'add', store: 'oil', data: { ...CTX, record_code: owned.record_code, tpmValue: '1' } }, { userId: OTHER_ID, role: 'operator' })
    assert.equal(res.statusCode, 409)
    assert.equal(res.body.code, 'RECORD_CODE_CONFLICT')
    assert.equal(res.body.data, undefined)
  })

  /* ─── 链路 8/9：字段白名单 + 字典/样例一致 ─── */
  test('链路8/9：输出只用白名单字段；字典、样例与真实输出同源', async () => {
    const rows = await db.testRecord.findMany()
    for (const row of rows) {
      const allowed = allowedResultKeys(row.test_type)
      const item = buildOpenRecord(row, GRANT, { schoolCode: 'reviewtest', allowedResultKeys: allowed })
      for (const k of Object.keys(item.result)) assert.ok(allowed.has(k), `下发了未登记字段 ${row.test_type}/result.${k}`)
      assert.equal('inspector' in item, false)
      assert.equal(JSON.stringify(item).includes('"inspector"'), false)
    }
    for (const s of buildSyntheticSamples('oil')) {
      const item = buildOpenRecord(s.record, GRANT, { schoolCode: 'reviewtest', allowedResultKeys: allowedResultKeys('oil') })
      for (const k of Object.keys(item.result)) assert.ok(allowedResultKeys('oil').has(k))
    }
  })

  /* ─── 链路 10：完整替换可清除撤回字段 ─── */
  test('链路10：授权从"下发姓名"改为"不下发"后，客户端按完整对象替换即可清除字段', async () => {
    const row = await db.testRecord.findFirst({ where: { test_type: 'tableware' } })
    const on = buildOpenRecord(row, { ...GRANT, include_inspector: true }, { schoolCode: 'reviewtest', allowedResultKeys: allowedResultKeys('tableware') })
    assert.equal(on.inspector, '张三')
    const off = buildOpenRecord(row, GRANT, { schoolCode: 'reviewtest', allowedResultKeys: allowedResultKeys('tableware') })
    // 客户端本地 = 完整替换（不是字段 merge）
    const local = JSON.parse(JSON.stringify(on))
    for (const k of Object.keys(local)) if (!(k in off)) delete local[k]
    assert.equal('inspector' in local, false)
  })

  /* ─── 版本冲突与租户隔离 ─── */
  test('版本冲突：where {id, version} 不匹配 → P2025（路由映射为 409）', async () => {
    const row = await db.testRecord.findFirst({ where: { test_type: 'oil' } })
    await assert.rejects(
      () => db.testRecord.update({ where: { id: row.id, version: row.version + 99 }, data: { status: 'completed' } }),
      (e) => e.code === 'P2025',
    )
  })

  test('租户隔离：租户 schema 有数据、public 无同名表或为空', async () => {
    assert.ok(await db.testRecord.count() > 0, '租户 schema 应有数据')
    let publicCount = 0
    try {
      publicCount = await publicDb.testRecord.count()
    } catch (e) {
      // 隔离库只在 school_reviewtest 建了租户表 → public 下无同名表，属更强的隔离证据
      assert.match(String(e.message), /does not exist|P2021/)
    }
    assert.equal(publicCount, 0, 'public 不应出现租户数据')
  })
}
