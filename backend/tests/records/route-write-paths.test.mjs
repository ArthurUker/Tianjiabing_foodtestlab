// 路由级回归（**无数据库**）：直接调用真实 handler、桩掉 req.db，捕获写库实参。
//
// 覆盖 2026-09-16 审阅发现的问题：H1（sync update 丢值）、H2（空对象写出空记录）、
// H3（legacy PUT 未收口/无版本）、M5（status 无白名单、record_code 冲突回显他人记录）。
// 该手法（审阅报告附录 A）验证的是**真实路由代码路径**，不依赖 HTTP/DB；DB 行为另由
// `db-integration.test.mjs`（隔离库）覆盖。
//
// 运行：cd /opt/foodsentinel/backend && node --test tests/records/
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSyncRoutes } from '../../routes/syncRoutes.js'
import { createRecordRoutes } from '../../routes/recordRoutes.js'
import { listFieldDescriptors, extractCustomFieldMeta, allowedResultKeys } from '../../lib/openApiFieldSchema.js'

const noop = (req, res, next) => next()
const PRISMA_STUB = { $executeRawUnsafe: async () => 1, $queryRawUnsafe: async () => [] }

/** 取出某路由的最终 handler（跳过中间件层）。 */
function handlerOf(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle
    }
  }
  throw new Error(`路由未找到：${method.toUpperCase()} ${path}`)
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
    send(b) { this.body = b; return this },
    setHeader(k, v) { this.headers[k] = v },
  }
}

/**
 * 调用 handler，捕获 req.db 的写库实参。
 * @param {Function} handler
 * @param {object} body
 * @param {{existing?: object|null, role?: string, userId?: string}} [opts]
 */
async function invoke(handler, body, opts = {}) {
  const captured = { create: [], update: [], delete: [] }
  const existing = opts.existing === undefined ? null : opts.existing
  const db = {
    testRecord: {
      findUnique: async () => existing,
      create: async ({ data }) => { captured.create.push(data); return { id: 'rec-new', ...data } },
      // 模拟 Prisma：返回「既有行 + 本次更新字段」的合并结果（供响应中的 version 断言）
      update: async ({ where, data }) => {
        captured.update.push({ where, data })
        return { ...(existing || {}), id: where.id || 'rec-1', ...data }
      },
      delete: async ({ where }) => { captured.delete.push(where); return { id: where.id } },
    },
    auditLog: { create: async () => ({}) },
  }
  const req = {
    body,
    db,
    params: opts.params || {},
    query: opts.query || {},
    user: { role: opts.role || 'manager', userId: opts.userId || 'u_me' },
    userId: opts.userId || 'u_me',
    ip: '127.0.0.1',
    get: () => 'test.local',
  }
  const res = makeRes()
  await handler(req, res)
  return { res, captured }
}

const syncRouter = createSyncRoutes(PRISMA_STUB, PRISMA_STUB)
const recordRouter = createRecordRoutes({
  authenticateUser: noop,
  requireEditorOrAbove: noop,
  requireGuestReadOnly: noop,
  idempotencyMiddleware: noop,
})

const SYNC_ADD = handlerOf(syncRouter, 'post', '/records')
const SYNC_BATCH = handlerOf(syncRouter, 'post', '/batch')
const REC_CREATE = handlerOf(recordRouter, 'post', '/api/records/:tableName')
const REC_PUT = handlerOf(recordRouter, 'put', '/api/records/:tableName/:id')
const REC_BULK = handlerOf(recordRouter, 'post', '/api/records/:tableName/bulk-upsert')
const LEGACY_CREATE = handlerOf(recordRouter, 'post', '/api/test-records')
const LEGACY_PUT = handlerOf(recordRouter, 'put', '/api/test-records/:id')

const CTX = { testDate: '2026-03-01', canteen: '第一食堂', inspector: '张三' }
const FLAT = { ...CTX, tpmValue: '0.06' }

/* ───────────────── sync add ───────────────── */

test('sync add：纯平铺载荷 → 三键落 sample_info，result_data 无副本', async () => {
  const { res, captured } = await invoke(SYNC_ADD, { action: 'add', store: 'oil', data: FLAT })
  assert.equal(res.statusCode, 200)
  const d = captured.create[0]
  assert.deepEqual(d.sample_info, CTX)
  assert.deepEqual(d.result_data, { tpmValue: '0.06' })
  assert.equal(d.status, 'completed')
})

test('sync add：result_data 里带三键 + 空 sample_info → 回填（不丢值）', async () => {
  const { captured } = await invoke(SYNC_ADD, {
    action: 'add', store: 'oil',
    data: { result_data: { ...CTX, tpmValue: '0.06' }, sample_info: {} },
  })
  const d = captured.create[0]
  assert.deepEqual(d.sample_info, CTX)
  assert.equal('canteen' in d.result_data, false)
})

test('sync add：result_data 为 {} 且业务字段在顶层 → 用扁平载荷（审阅 H2：原实现写出空记录）', async () => {
  const { res, captured } = await invoke(SYNC_ADD, { action: 'add', store: 'oil', data: { ...FLAT, result_data: {} } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(captured.create[0].result_data, { tpmValue: '0.06' })
  assert.deepEqual(captured.create[0].sample_info, CTX)
})

test('sync add：result_data 为 null → 不写入字面键（审阅 L2）', async () => {
  const { captured } = await invoke(SYNC_ADD, { action: 'add', store: 'oil', data: { ...FLAT, result_data: null } })
  assert.equal('result_data' in captured.create[0].result_data, false)
  assert.equal(captured.create[0].result_data.tpmValue, '0.06')
})

test('sync add：result_data 为字符串/数组 → 400（不静默转空对象）', async () => {
  const a = await invoke(SYNC_ADD, { action: 'add', store: 'oil', data: { ...FLAT, result_data: 'oops' } })
  assert.equal(a.res.statusCode, 400)
  assert.equal(a.res.body.code, 'INVALID_RESULT_DATA')
  const b = await invoke(SYNC_ADD, { action: 'add', store: 'oil', data: { ...FLAT, result_data: [] } })
  assert.equal(b.res.statusCode, 400)
})

test('sync add：缺三键 → 400 MISSING_CONTEXT_FIELDS', async () => {
  const { res, captured } = await invoke(SYNC_ADD, { action: 'add', store: 'oil', data: { tpmValue: '0.06' } })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'MISSING_CONTEXT_FIELDS')
  assert.equal(captured.create.length, 0)
})

test('sync add：控制字段不落 result_data（审阅 A7）', async () => {
  const { captured } = await invoke(SYNC_ADD, {
    action: 'add', store: 'oil',
    data: { ...FLAT, status: 'completed', version: 7, id: 'other', created_by: 'u_other', record_code: 'RC-custom' },
  })
  const d = captured.create[0]
  for (const k of ['status', 'version', 'id', 'created_by', 'record_code', 'test_type']) {
    assert.equal(k in d.result_data, false, `result_data 不应含 ${k}`)
  }
  assert.equal(d.record_code, 'RC-custom', 'record_code 仍按契约由客户端指定')
  assert.equal(d.created_by, 'u_me', 'created_by 恒取认证上下文')
})

test('sync add：status 白名单 —— editor 不可归档，manager 可以（审阅 M5）', async () => {
  const asEditor = await invoke(SYNC_ADD, { action: 'add', store: 'oil', data: { ...FLAT, status: 'archived' } }, { role: 'operator' })
  assert.equal(asEditor.res.statusCode, 400)
  assert.equal(asEditor.res.body.code, 'STATUS_NOT_ALLOWED')
  assert.equal(asEditor.captured.create.length, 0)

  const asManager = await invoke(SYNC_ADD, { action: 'add', store: 'oil', data: { ...FLAT, status: 'archived' } }, { role: 'manager' })
  assert.equal(asManager.res.statusCode, 200)
  assert.equal(asManager.captured.create[0].status, 'archived')

  const garbage = await invoke(SYNC_ADD, { action: 'add', store: 'oil', data: { ...FLAT, status: 'whatever' } }, { role: 'admin' })
  assert.equal(garbage.res.statusCode, 400)
})

/* ───────────────── sync update ───────────────── */

test('sync update：只提交 result_data 里的食堂 → 合并写回 sample_info（审阅 H1 修复点）', async () => {
  const existing = { id: 'rec-1', created_by: 'u_me', status: 'completed', sample_info: { testDate: '2026-03-01', canteen: '旧食堂', inspector: '张三' } }
  const { res, captured } = await invoke(SYNC_ADD, {
    action: 'update',
    store: 'oil',
    data: { id: 'rec-1', result_data: { canteen: '新食堂', tpmValue: '0.9' } },
  }, { existing })
  assert.equal(res.statusCode, 200)
  const d = captured.update[0].data
  assert.equal(d.sample_info.canteen, '新食堂', '请求里的新值必须落 sample_info')
  assert.equal(d.sample_info.inspector, '张三', '未提交字段保留旧值')
  assert.deepEqual(d.result_data, { tpmValue: '0.9' })
})

test('sync update：result_data 未提交 → 不改动 JSON 字段；只改状态不碰检测内容', async () => {
  const existing = { id: 'rec-1', created_by: 'u_me', status: 'completed', sample_info: CTX }
  const { captured } = await invoke(SYNC_ADD, { action: 'update', store: 'oil', data: { id: 'rec-1', status: 'failed', test_name: '改名' } }, { existing })
  const d = captured.update[0].data
  assert.equal('result_data' in d, false)
  assert.equal('sample_info' in d, false)
  assert.equal(d.status, 'failed')
  assert.equal(d.test_name, '改名')
})

test('sync update：result_data 为 {} → 不改动（不得清空已有结果）', async () => {
  const existing = { id: 'rec-1', created_by: 'u_me', status: 'completed', sample_info: CTX }
  const { captured } = await invoke(SYNC_ADD, { action: 'update', store: 'oil', data: { id: 'rec-1', result_data: {} } }, { existing })
  assert.equal('result_data' in captured.update[0].data, false)
})

test('sync update：无权限修改他人记录 → 403，且不写库', async () => {
  const existing = { id: 'rec-1', created_by: 'u_other', status: 'completed', sample_info: CTX }
  const { res, captured } = await invoke(SYNC_ADD, { action: 'update', store: 'oil', data: { id: 'rec-1', result_data: { tpmValue: '1' } } }, { existing, role: 'operator' })
  assert.equal(res.statusCode, 403)
  assert.equal(captured.update.length, 0)
})

test('sync add：record_code 冲突不视为合法幂等重试（审阅 M5）', async () => {
  // 桩：create 抛 P2002，回查命中"他人记录"
  const otherOwned = { id: 'rec-x', record_code: 'RC-dup', created_by: 'u_other', status: 'completed' }
  const ownRecord = { id: 'rec-y', record_code: 'RC-dup', created_by: 'u_me', status: 'completed' }
  const mk = (existing) => {
    const db = {
      testRecord: {
        findUnique: async () => existing,
        create: async () => { const e = new Error('unique'); e.code = 'P2002'; throw e },
        update: async () => ({}), delete: async () => ({}),
      },
      auditLog: { create: async () => ({}) },
    }
    return { db, req: { body: { action: 'add', store: 'oil', data: { ...FLAT, record_code: 'RC-dup' } }, db, params: {}, query: {}, user: { role: 'operator', userId: 'u_me' }, userId: 'u_me', ip: '127.0.0.1', get: () => 'x' }, res: makeRes() }
  }
  const a = mk(otherOwned)
  await SYNC_ADD(a.req, a.res)
  assert.equal(a.res.statusCode, 409)
  assert.equal(a.res.body.code, 'RECORD_CODE_CONFLICT')
  assert.equal(a.res.body.data, undefined, '不得回显他人记录')

  const b = mk(ownRecord)
  await SYNC_ADD(b.req, b.res)
  assert.equal(b.res.statusCode, 200)
  assert.equal(b.res.body.idempotent, true, '自己的记录 → 合法幂等重试')
})

/* ───────────────── sync batch ───────────────── */

test('sync batch：逐条归一，失败项带 code 且不中断整批', async () => {
  const { res, captured } = await invoke(SYNC_BATCH, {
    operations: [
      { syncId: 's1', action: 'add', store: 'oil', data: FLAT },
      { syncId: 's2', action: 'add', store: 'oil', data: { tpmValue: '0.1' } },          // 缺三键
      { syncId: 's3', action: 'add', store: 'oil', data: { ...FLAT, result_data: 'x' } }, // 非法结构
    ],
  })
  assert.equal(res.body.succeeded, 1)
  assert.equal(res.body.failed, 2)
  assert.equal(res.body.results[0].syncId, 's1')
  assert.deepEqual(res.body.errors.map((e) => e.syncId).sort(), ['s2', 's3'])
  assert.ok(res.body.errors.every((e) => typeof e.code === 'string' && e.code))
  assert.equal(captured.create.length, 1)
})

/* ───────────────── /api/records（整对象替换） ───────────────── */

test('records create：扁平载荷 → 校验通过并归一；局部载荷 → 400', async () => {
  const ok = await invoke(REC_CREATE, FLAT, { params: { tableName: 'oil' } })
  assert.equal(ok.res.statusCode, 200)
  assert.deepEqual(ok.captured.create[0].sample_info, CTX)
  assert.deepEqual(ok.captured.create[0].result_data, { tpmValue: '0.06' })

  const partial = await invoke(REC_CREATE, { testDate: '2026-03-01', canteen: '第一食堂' }, { params: { tableName: 'oil' } })
  assert.equal(partial.res.statusCode, 400, '整对象替换入口不接受局部载荷')
})

test('records create：result_data 为 {} 且业务字段在顶层 → 用扁平载荷', async () => {
  const { res, captured } = await invoke(REC_CREATE, { ...FLAT, result_data: {} }, { params: { tableName: 'oil' } })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(captured.create[0].result_data, { tpmValue: '0.06' })
})

test('records PUT：状态白名单 + 版本条件随客户端 version 传递', async () => {
  const existing = { id: 'rec-1', test_type: 'oil', created_by: 'u_me', status: 'completed', version: 3, sample_info: CTX, result_data: { tpmValue: '0.06' } }
  const archivedByEditor = await invoke(REC_PUT, { ...FLAT, status: 'archived', version: 3 }, { params: { tableName: 'oil', id: 'rec-1' }, existing, role: 'operator' })
  assert.equal(archivedByEditor.res.statusCode, 400)
  assert.equal(archivedByEditor.res.body.code, 'STATUS_NOT_ALLOWED')

  const ok = await invoke(REC_PUT, { ...FLAT, version: 3 }, { params: { tableName: 'oil', id: 'rec-1' }, existing })
  assert.equal(ok.res.statusCode, 200)
  assert.deepEqual(ok.captured.update[0].where, { id: 'rec-1', version: 3 })
  assert.equal(ok.captured.update[0].data.version, 4)
})

test('records bulk-upsert：坏条目进 failed[] 且带 code，其余条目照常写入', async () => {
  const { res, captured } = await invoke(REC_BULK, {
    records: [FLAT, { tpmValue: '0.2' }, { ...FLAT, result_data: 'x' }],
  }, { params: { tableName: 'oil' } })
  assert.equal(res.body.data.created, 1)
  assert.equal(res.body.data.failed, 2)
  assert.ok(res.body.data.failedRecords.every((f) => typeof f.code === 'string'))
  assert.equal(captured.create.length, 1)
})

/* ───────────────── legacy 端点 ───────────────── */

test('legacy POST /api/test-records：归一 + 拒绝空结果；status 固定 pending', async () => {
  const ok = await invoke(LEGACY_CREATE, { test_type: 'oil', test_name: '油价', sample_info: CTX, result_data: { tpmValue: '0.06' } })
  assert.equal(ok.res.statusCode, 200)
  assert.deepEqual(ok.captured.create[0].sample_info, CTX)
  assert.deepEqual(ok.captured.create[0].result_data, { tpmValue: '0.06' })
  assert.equal(ok.captured.create[0].status, 'pending')

  const empty = await invoke(LEGACY_CREATE, { test_type: 'oil', test_name: '油价', sample_info: CTX, result_data: {} })
  assert.equal(empty.res.statusCode, 400)
})

test('legacy PUT /api/test-records/:id：result_data 内的三键合并写回 + 剥离副本（审阅 H3）', async () => {
  const existing = { id: 'rec-1', created_by: 'u_me', status: 'completed', version: 2, sample_info: { testDate: '2026-03-01', canteen: '旧食堂', inspector: '张三' } }
  const { res, captured } = await invoke(LEGACY_PUT, { result_data: { canteen: '新食堂', tpmValue: '0.9' }, version: 2 }, { params: { id: 'rec-1' }, existing })
  assert.equal(res.statusCode, 200)
  const { where, data } = captured.update[0]
  assert.deepEqual(where, { id: 'rec-1', version: 2 }, '携带 version → 原子条件更新')
  assert.equal(data.sample_info.canteen, '新食堂')
  assert.deepEqual(data.result_data, { tpmValue: '0.9' })
  assert.equal('canteen' in data.result_data, false)
})

test('legacy PUT /api/test-records/:id：不携带 version → 仍更新但响应回传 version（不伪造）', async () => {
  const existing = { id: 'rec-1', created_by: 'u_me', status: 'completed', version: 5, sample_info: CTX }
  const { res, captured } = await invoke(LEGACY_PUT, { status: 'failed' }, { params: { id: 'rec-1' }, existing })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(captured.update[0].where, { id: 'rec-1' })
  assert.equal(res.body.version !== undefined, true, '响应须回传服务端版本')
})

test('legacy PUT /api/test-records/:id：P2025（版本冲突）→ 409', async () => {
  const existing = { id: 'rec-1', created_by: 'u_me', status: 'completed', version: 2, sample_info: CTX }
  const db = {
    testRecord: {
      findUnique: async () => existing,
      update: async () => { const e = new Error('not found'); e.code = 'P2025'; throw e },
      create: async () => ({}), delete: async () => ({}),
    },
    auditLog: { create: async () => ({}) },
  }
  const req = { body: { result_data: { tpmValue: '1' }, version: 1 }, db, params: { id: 'rec-1' }, query: {}, user: { role: 'manager', userId: 'u_me' }, userId: 'u_me', ip: '127.0.0.1', get: () => 'x' }
  const res = makeRes()
  await LEGACY_PUT(req, res)
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'VERSION_CONFLICT')
})

/* ───────────────── 字典与白名单同源（M2 回归） ───────────────── */

test('字典：extractCustomFieldMeta 返回值可直接喂给 listFieldDescriptors（审阅发现键名不匹配导致自定义字段失效）', () => {
  const cust = {
    custom_fields: { oil: [{ name: 'myField', label: '我的自定义字段' }] },
    field_labels: {},
  }
  const meta = extractCustomFieldMeta(cust, 'oil')
  const fields = listFieldDescriptors('oil', meta)
  const custom = fields.filter((f) => f.source === 'school_custom')
  assert.equal(custom.length, 1, '学校自定义字段必须出现在字典里')
  assert.equal(custom[0].path, 'result.myField')
  assert.equal(allowedResultKeys('oil', meta).has('myField'), true, '自定义字段必须进入下发白名单，否则会被误删')
  assert.equal(allowedResultKeys('oil', meta).has('notDeclared'), false)
})
