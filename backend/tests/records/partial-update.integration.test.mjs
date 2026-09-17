// 局部更新不丢数据 + 版本并发 · 数据库级集成回归（隔离库；未设环境变量则跳过）
//
// 锁定的不变量（2026-09-17 P0-1 / P1-3）：
//   ① 只提交上下文字段（`result_data: { canteen: 'B' }`）**不得清空**已有检测结果
//      —— 旧实现在 strip 控制键后剩 `{}`，仍被判为"显式提交"写回，直接把结果清空。
//   ② 局部更新不得丢兄弟字段：只改 `tpmValue` 时 `oil/atp` 等必须保留（merge 语义）；
//      `/api/records` PUT 是**整对象替换**契约（保留差异，可显式 `result_data_mode:'merge'` 切换）。
//   ③ `{}` / `undefined` / `null` 与"未提交"必须区分且语义明确（不改动 vs 400）。
//   ④ 所有写入口的 version 语义明确：带 expected_version → 原子 CAS（冲突 409）；
//      不带 → 明确 LWW，但 version **原子递增**（不再出现"改了但版本不变"）。
//
// 启用：
//   REVIEW_TEST_DATABASE_URL='postgresql://USER:PASS@127.0.0.1:5432/foodsentinel_review_test' \
//     node --test tests/records/partial-update.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  require, isConfigured, assertIsolationConfig, assertIsolated as sharedAssertIsolated,
} from '../_isolation.mjs'

const TEST_SCHEMA = 'school_reviewtest'
const enabled = isConfigured()

if (!enabled) {
  test('局部更新集成测试（未设置 REVIEW_TEST_DATABASE_URL，跳过）', { skip: 'SKIP: TEST_DATABASE_URL not configured' }, () => {})
}

if (enabled) {
  // 配置级门禁（F8）：解析连接串校验库名 + 专用测试 schema（在创建客户端之前）
  const iso = assertIsolationConfig({ schema: TEST_SCHEMA })

  const { PrismaClient } = require('@prisma/client')
  const { createSyncRoutes } = await import('../../routes/syncRoutes.js')
  const { createRecordRoutes } = await import('../../routes/recordRoutes.js')

  const tenantUrl = `${iso.url}${iso.url.includes('?') ? '&' : '?'}schema=${TEST_SCHEMA}`
  const db = new PrismaClient({ datasources: { db: { url: tenantUrl } } })
  const publicDb = new PrismaClient({ datasources: { db: { url: iso.url } } })
  const USER_ID = 'u-partial-test'

  async function assertIsolated() {
    const { schema } = await sharedAssertIsolated(db, iso.db, '租户客户端')
    assert.equal(schema, TEST_SCHEMA, `安全校验：租户客户端 current_schema 必须是 ${TEST_SCHEMA}`)
    await sharedAssertIsolated(publicDb, iso.db, 'public 客户端')
  }

  const noop = (req, res, next) => next()
  const PRISMA_STUB = { $executeRawUnsafe: async () => 1, $queryRawUnsafe: async () => [] }
  const syncRouter = createSyncRoutes(PRISMA_STUB, PRISMA_STUB)
  const recordRouter = createRecordRoutes({ authenticateUser: noop, requireEditorOrAbove: noop, requireGuestReadOnly: noop, idempotencyMiddleware: noop })
  const handlerOf = (router, method, path) => {
    for (const l of router.stack) if (l.route && l.route.path === path && l.route.methods[method]) return l.route.stack[l.route.stack.length - 1].handle
    throw new Error(`路由未找到 ${method} ${path}`)
  }
  const SYNC = handlerOf(syncRouter, 'post', '/records')
  const SYNC_BATCH = handlerOf(syncRouter, 'post', '/batch')
  const LEGACY_PUT = handlerOf(recordRouter, 'put', '/api/test-records/:id')
  const REC_PUT = handlerOf(recordRouter, 'put', '/api/records/:tableName/:id')
  const BULK = handlerOf(recordRouter, 'post', '/api/records/:tableName/bulk-upsert')

  const makeRes = () => ({
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this },
    send(b) { this.body = b; return this }, setHeader() {},
  })
  const call = async (handler, body, opts = {}) => {
    const req = {
      body, db, params: opts.params || {}, query: opts.query || {},
      user: { role: opts.role || 'manager', userId: opts.userId || USER_ID },
      userId: opts.userId || USER_ID, ip: '127.0.0.1',
    }
    const res = makeRes()
    await handler(req, res)
    return res
  }

  /** 造一条初始记录：result_data 内有 oil/atp/tpmValue 业务字段 + 历史副本 canteen/testDate/inspector。 */
  async function seed(code) {
    await call(SYNC, {
      action: 'add', store: 'oil',
      data: {
        record_code: code, testDate: '2026-05-01', canteen: 'A 食堂', inspector: '测试员',
        result_data: { tpmValue: '0.30', oil: { result: '合格' }, atp: { value: 20 }, canteen: 'A 食堂' },
      },
    })
    const row = await db.testRecord.findUnique({ where: { record_code: code } })
    assert.ok(row, 'seed 失败：记录未创建')
    return row
  }
  const getByCode = (code) => db.testRecord.findUnique({ where: { record_code: code } })
  const rd = (row) => (typeof row.result_data === 'string' ? JSON.parse(row.result_data) : row.result_data) || {}
  const si = (row) => (typeof row.sample_info === 'string' ? JSON.parse(row.sample_info) : row.sample_info) || {}

  test.before(async () => {
    await assertIsolated()
    await db.user.upsert({
      where: { id: USER_ID }, update: {},
      create: { id: USER_ID, username: 'partial-test', password_hash: 'x', role: 'manager', full_name: '局部更新回归' },
    })
    // ⚠️ 按 created_by 清理（而非仅前缀）：bulk-upsert 用例的记录码是**内容哈希**（RC-oil-<hash>），
    //    前缀匹配会漏掉它们 → 残留记录会污染其它套件（stats 的基数）的断言。
    await db.testRecord.deleteMany({ where: { created_by: USER_ID } })
    await db.testRecord.deleteMany({ where: { record_code: { startsWith: 'RC-partial-' } } })
  })

  test.after(async () => {
    await db.testRecord.deleteMany({ where: { created_by: USER_ID } })
    await db.testRecord.deleteMany({ where: { record_code: { startsWith: 'RC-partial-' } } })
    await db.$disconnect()
    await publicDb.$disconnect()
  })

  /* ───────────── Test A：context-only 不得清空结果（三条写入路径） ───────────── */

  test('Test A-1（App 同步路径 /api/sync/records）：只提交 result_data.canteen → 食堂更新且结果保留', async () => {
    const code = 'RC-partial-a1'
    const before = await seed(code)
    const res = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, result_data: { canteen: 'B 食堂' } } })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const after = await getByCode(code)
    assert.equal(si(after).canteen, 'B 食堂', '上下文键必须合并写回 sample_info（原实现静默丢弃）')
    assert.equal(rd(after).canteen, undefined, 'result_data 内不得留上下文副本')
    assert.deepEqual(
      { tpm: rd(after).tpmValue, oil: rd(after).oil, atp: rd(after).atp },
      { tpm: '0.30', oil: { result: '合格' }, atp: { value: 20 } },
      '只提交上下文键时，原检测结果必须完整保留（旧实现在此把 result_data 清成 {}）',
    )
    assert.ok(Object.keys(rd(after)).length > 0, 'result_data 不得变成 {}')
  })

  test('Test A-2（legacy 局部编辑 PUT /api/test-records/:id）：同上', async () => {
    const code = 'RC-partial-a2'
    const before = await seed(code)
    const res = await call(LEGACY_PUT, { result_data: { canteen: 'C 食堂' } }, { params: { id: before.id } })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const after = await getByCode(code)
    assert.equal(si(after).canteen, 'C 食堂')
    assert.deepEqual(rd(after).oil, { result: '合格' }, '兄弟字段必须保留')
    assert.equal(rd(after).tpmValue, '0.30')
  })

  test('Test A-3（PUT /api/records/:tableName/:id，整对象替换契约）：只带上下文也不得清空结果', async () => {
    const code = 'RC-partial-a3'
    const before = await seed(code)
    // 该端点契约要求三键齐全（validateRecordPayload），此处模拟"客户端只改了食堂"的完整提交
    const res = await call(REC_PUT, {
      testDate: '2026-05-01', canteen: 'D 食堂', inspector: '测试员',
      result_data: { canteen: 'D 食堂' },
    }, { params: { tableName: 'oil', id: before.id } })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const after = await getByCode(code)
    assert.equal(buildSample(after), 'D 食堂')
    assert.equal(rd(after).tpmValue, '0.30', '仅上下文提交时不得清空 result_data（P0-1）')
  })
  function buildSample(row) { return si(row).canteen }

  /* ───────────── Test B：局部业务字段更新保留兄弟字段 ───────────── */

  test('Test B-1（局部更新路径默认 merge）：只改 tpmValue → oil/atp 保留', async () => {
    const code = 'RC-partial-b1'
    const before = await seed(code)
    const res = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, result_data: { tpmValue: '0.20' } } })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const after = await getByCode(code)
    assert.equal(rd(after).tpmValue, '0.20')
    assert.deepEqual(rd(after).oil, { result: '合格' }, '未提交的 oil 必须保留（原实现在此丢字段）')
    assert.deepEqual(rd(after).atp, { value: 20 }, '未提交的 atp 必须保留')
  })

  test('Test B-2（PUT /api/records 默认 replace 契约）：可显式 result_data_mode=merge 保留兄弟字段', async () => {
    const code = 'RC-partial-b2'
    const before = await seed(code)
    const replaced = await call(REC_PUT, {
      testDate: '2026-05-01', canteen: 'A 食堂', inspector: '测试员',
      result_data: { tpmValue: '0.10' },
    }, { params: { tableName: 'oil', id: before.id } })
    assert.equal(replaced.statusCode, 200)
    const afterReplace = await getByCode(code)
    assert.equal(rd(afterReplace).oil, undefined, '该端点契约是整对象替换（文档化差异，非缺陷）')

    const merged = await call(REC_PUT, {
      testDate: '2026-05-01', canteen: 'A 食堂', inspector: '测试员',
      result_data: { atp: { value: 99 } }, result_data_mode: 'merge',
    }, { params: { tableName: 'oil', id: before.id } })
    assert.equal(merged.statusCode, 200)
    const afterMerge = await getByCode(code)
    assert.equal(rd(afterMerge).atp.value, 99)
    assert.equal(rd(afterMerge).tpmValue, '0.10', 'merge 模式必须保留未提交键')
  })

  /* ───────────── Test C：空对象 / undefined / null 语义 ───────────── */

  test('Test C：result_data = {} / 未提交 / null 均不改动；非法类型 400', async () => {
    const code = 'RC-partial-c1'
    const before = await seed(code)
    const empty = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, result_data: {}, status: 'failed' } })
    assert.equal(empty.statusCode, 200, JSON.stringify(empty.body))
    let row = await getByCode(code)
    assert.equal(rd(row).tpmValue, '0.30', '{} = 不改动 result_data')
    assert.equal(row.status, 'failed', '其它字段照常更新')

    const omitted = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, status: 'completed' } })
    assert.equal(omitted.statusCode, 200)
    row = await getByCode(code)
    assert.equal(rd(row).tpmValue, '0.30', '未提交 result_data = 不改动')

    const nulled = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, result_data: null } })
    assert.equal(nulled.statusCode, 200, 'null 视为"未提交"（不改动），不报错也不清空')
    row = await getByCode(code)
    assert.equal(rd(row).tpmValue, '0.30')

    const invalid = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, result_data: 'oops' } })
    assert.equal(invalid.statusCode, 400, '字符串/数组等非法结构必须 400')
    assert.equal(invalid.body.code, 'INVALID_RESULT_DATA')
    row = await getByCode(code)
    assert.equal(rd(row).tpmValue, '0.30', '非法请求不得改动数据')

    // 显式 null 键 = 删除该键（唯一的清空手段）
    const del = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, result_data: { atp: null } } })
    assert.equal(del.statusCode, 200)
    row = await getByCode(code)
    assert.equal(rd(row).atp, undefined, '显式 null 表示删除该键')
    assert.equal(rd(row).tpmValue, '0.30', '删除单键不得影响其它键')
  })

  /* ───────────── Test J/K：version 并发语义 ───────────── */

  test('Test J：App 同步更新携带 expected_version → 原子 CAS，陈旧版本 409 且数据不变', async () => {
    const code = 'RC-partial-j1'
    const row0 = await seed(code)
    const v0 = row0.version
    const ok = await call(SYNC, { action: 'update', store: 'oil', data: { id: row0.id, expected_version: v0, result_data: { tpmValue: '0.11' } } })
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
    const row1 = await getByCode(code)
    assert.equal(row1.version, v0 + 1, '版本必须原子递增')
    assert.equal(rd(row1).tpmValue, '0.11')

    // 第二个客户端拿旧版本再提交 → 409，且不得覆盖
    const stale = await call(SYNC, { action: 'update', store: 'oil', data: { id: row0.id, expected_version: v0, result_data: { tpmValue: '0.99' } } })
    assert.equal(stale.statusCode, 409, '陈旧 expected_version 必须 409')
    assert.equal(stale.body.code, 'VERSION_CONFLICT')
    const row2 = await getByCode(code)
    assert.equal(rd(row2).tpmValue, '0.11', '冲突请求不得写入')
    assert.equal(row2.version, v0 + 1, '冲突不得推进版本')

    const bad = await call(SYNC, { action: 'update', store: 'oil', data: { id: row0.id, expected_version: 'abc', result_data: { tpmValue: '0.12' } } })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.body.code, 'INVALID_EXPECTED_VERSION')
  })

  test('Test K：未携带 version → 明确 LWW（不阻塞离线队列），但版本必须递增且可被其它入口感知', async () => {
    const code = 'RC-partial-k1'
    const row0 = await seed(code)
    const res = await call(SYNC, { action: 'update', store: 'oil', data: { id: row0.id, result_data: { tpmValue: '0.15' } } })
    assert.equal(res.statusCode, 200)
    const row1 = await getByCode(code)
    assert.equal(row1.version, row0.version + 1, 'LWW 也必须推进 version（旧实现：改了但版本不变）')
    assert.equal(rd(row1).tpmValue, '0.15')
  })

  test('Test K-2：批量同步与单条语义一致（version 递增 + 局部 merge）', async () => {
    const code = 'RC-partial-k2'
    const row0 = await seed(code)
    const res = await call(SYNC_BATCH, {
      operations: [{ action: 'update', store: 'oil', syncId: 's1', data: { id: row0.id, result_data: { tpmValue: '0.18' } } }],
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.failed, 0, JSON.stringify(res.body.errors))
    const row1 = await getByCode(code)
    assert.equal(rd(row1).tpmValue, '0.18')
    assert.deepEqual(rd(row1).oil, { result: '合格' }, '批量路径同样不得丢兄弟字段')
    assert.equal(row1.version, row0.version + 1)

    // 陈旧版本走批量 → 归入 errors（不覆盖）
    const stale = await call(SYNC_BATCH, {
      operations: [{ action: 'update', store: 'oil', syncId: 's2', data: { id: row0.id, expected_version: row0.version, result_data: { tpmValue: '0.98' } } }],
    })
    assert.equal(stale.body.failed, 1)
    assert.match(String(stale.body.errors[0].error), /版本冲突/)
    assert.equal(rd(await getByCode(code)).tpmValue, '0.18')
  })

  test('Test J-2（F2 验收）：legacy PUT 两个写者从同一旧版本出发，最多一个成功，且成功者必须推进版本', async () => {
    const code = 'RC-partial-j2'
    const row0 = await seed(code)
    const v0 = row0.version

    const first = await call(LEGACY_PUT, { version: v0, result_data: { tpmValue: '0.21' } }, { params: { id: row0.id } })
    assert.equal(first.statusCode, 200, JSON.stringify(first.body))
    const row1 = await getByCode(code)
    assert.equal(row1.version, v0 + 1, '成功的更新必须递增 version（旧实现两次都返回 200 且版本不变）')

    // 第二个写者仍拿 v0 → 必须冲突，且不得覆盖
    const second = await call(LEGACY_PUT, { version: v0, result_data: { tpmValue: '0.77' } }, { params: { id: row0.id } })
    assert.equal(second.statusCode, 409, '陈旧版本必须 409')
    assert.equal(second.body.code, 'VERSION_CONFLICT')
    const row2 = await getByCode(code)
    assert.equal(rd(row2).tpmValue, '0.21', '冲突请求不得写入')
    assert.equal(row2.version, v0 + 1, '冲突不得推进版本')
  })

  test('Test M（F1 反例）：扁平业务字段更新必须生效，不得"成功但什么都没改"', async () => {
    const code = 'RC-partial-m1'
    const before = await seed(code)
    // 旧 sync 路径是 `result_data || data`，因此 `data: { id, result: '不合格' }` 这类扁平形态原本能生效；
    // 上一轮只认 result_data 后，它会**返回 200 但静默不改**（审阅 F1 的第二个反例）。
    const res = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, result: '不合格' } })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const after = await getByCode(code)
    assert.equal(rd(after).result, '不合格', '扁平业务字段必须落库（否则是假成功）')
    assert.deepEqual(rd(after).oil, { result: '合格' }, '扁平更新同样不得丢兄弟字段')
    assert.equal(rd(after).tpmValue, '0.30')

    // 仅上下文/控制字段的扁平载荷 → 上下文写回 sample_info，结果体不动
    const ctxOnly = await call(SYNC, { action: 'update', store: 'oil', data: { id: before.id, canteen: 'H 食堂' } })
    assert.equal(ctxOnly.statusCode, 200, JSON.stringify(ctxOnly.body))
    const after2 = await getByCode(code)
    assert.equal(si(after2).canteen, 'H 食堂')
    assert.equal(rd(after2).result, '不合格', '仅上下文时结果不得被清空或改写')
    assert.equal(rd(after2).tpmValue, '0.30')
  })

  test('bulk-upsert：命中已有记录（内容哈希）时不清空结果；仅上下文的载荷被拒且不产生空记录', async () => {
    const { buildDeterministicRecordCode } = await import('../../lib/recordNormalize.js')
    const payload = {
      testDate: '2026-05-02', canteen: 'F 食堂', inspector: '测试员',
      result_data: { tpmValue: '0.30', oil: { result: '合格' }, atp: { value: 20 }, canteen: 'F 食堂' },
    }
    const code = buildDeterministicRecordCode('oil', payload)
    await call(SYNC, { action: 'add', store: 'oil', data: { record_code: code, ...payload } })
    const row0 = await getByCode(code)
    assert.ok(row0, '前置：记录应按内容哈希创建（record_code 由入参 payload 计算）')

    // ① 同内容 upsert → 命中已有记录（update 分支），结果不得被清空
    const same = await call(BULK, { records: [payload] }, { params: { tableName: 'oil' } })
    assert.equal(same.statusCode, 200, JSON.stringify(same.body))
    assert.equal(same.body.data.failed, 0, JSON.stringify(same.body.data.failedRecords))
    assert.equal(same.body.data.updated, 1, '同内容应命中已有记录走 update 分支')
    const afterSame = await getByCode(code)
    assert.deepEqual(rd(afterSame).atp, { value: 20 }, 'update 分支不得丢兄弟字段')
    assert.equal(afterSame.version, row0.version + 1, 'version 必须原子递增')

    // ② 仅上下文/控制字段的**新**载荷 → 400 EMPTY_RESULT_DATA（拒绝），且不得产生空结果记录
    const ctxOnly = { testDate: '2026-05-03', canteen: 'G 食堂', inspector: '测试员', result_data: { canteen: 'G 食堂' } }
    const ctxCode = buildDeterministicRecordCode('oil', ctxOnly)
    const res2 = await call(BULK, { records: [ctxOnly] }, { params: { tableName: 'oil' } })
    assert.equal(res2.statusCode, 200)
    assert.equal(res2.body.data.failed, 1, '仅上下文的新记录必须被拒（否则会写入空结果）')
    assert.equal(res2.body.data.failedRecords[0].code, 'EMPTY_RESULT_DATA')
    assert.equal(await getByCode(ctxCode), null, '被拒的载荷不得落库')

    // ③ expected_updated_at 为原子 CAS：过期值 → 冲突且不写入
    //   用一个明确陈旧的时刻（而非刚读到的 row0.updated_at，避免毫秒级同值造成假通过）
    const staleTs = '2000-01-01T00:00:00.000Z'
    const stale = await call(BULK, { records: [{ ...payload, expected_updated_at: staleTs }] }, { params: { tableName: 'oil' } })
    assert.equal(stale.statusCode, 200)
    assert.equal(stale.body.data.failed, 1, '过期的 expected_updated_at 必须冲突')
    assert.match(String(stale.body.data.failedRecords[0].reason), /乐观锁冲突/)
    assert.equal(rd(await getByCode(code)).tpmValue, '0.30', '冲突请求不得写入')

    // ④ 正确的 expected_updated_at → 成功
    const freshTs = new Date((await getByCode(code)).updated_at).toISOString()
    const ok = await call(BULK, { records: [{ ...payload, expected_updated_at: freshTs }] }, { params: { tableName: 'oil' } })
    assert.equal(ok.body.data.failed, 0, JSON.stringify(ok.body.data.failedRecords))
    assert.equal(ok.body.data.updated, 1)
  })
}
