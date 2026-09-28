// P3-W4-T01（AUD-022）· 服务端 409 冲突协议定点回归（真实路由 handler，req.db 桩；无数据库、无 HTTP 端口）
//
// 判别证据组③（服务端侧）：409 响应体扩展冲突信息（latest / conflict / staleReplay）+ 既有字段保持；
// 判别证据组④（服务端侧）：stale 全量重放被识别并拒绝（含"冲突栅栏期内只换 version 的重放"）；
// 判别证据组⑤：旧客户端兼容负例 —— 忽略新字段（只 bump version）不会误成功，而是明确失败。
//
// 运行：node --test backend/tests/sync/w4-409-conflict-response.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRecordRoutes } from '../../routes/recordRoutes.js'

const noop = (req, res, next) => next()
const router = createRecordRoutes({
    authenticateUser: noop,
    requireEditorOrAbove: noop,
    requireGuestReadOnly: noop,
    idempotencyMiddleware: noop,
})

function handlerOf(r, method, path) {
    for (const layer of r.stack) {
        if (layer.route && layer.route.path === path && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle
        }
    }
    throw new Error(`路由未找到：${method.toUpperCase()} ${path}`)
}
const REC_PUT = handlerOf(router, 'put', '/api/records/:tableName/:id')

const CTX = { testDate: '2026-03-01', canteen: '第一食堂', inspector: '张三' }
const BASE_UPDATED_AT = '2026-09-01T00:00:00.000Z'

function makeRes() {
    return {
        statusCode: 200,
        body: null,
        status(c) { this.statusCode = c; return this },
        json(b) { this.body = b; return this },
        send(b) { this.body = b; return this },
        setHeader() {},
    }
}

function makeExisting(over = {}) {
    return {
        id: over.id || 'rec-w4-1',
        test_type: 'oil',
        created_by: 'u_me',
        status: 'completed',
        version: 2,
        updated_at: BASE_UPDATED_AT,
        sample_info: { ...CTX },
        result_data: { tpmValue: '0.30' },
        ...over,
    }
}

function makeDb(existing, { updateFails = false } = {}) {
    const captured = { update: [], reads: 0 }
    const db = {
        testRecord: {
            findUnique: async ({ where }) => { captured.reads += 1; captured.lastWhere = where; return existing },
            update: async ({ where, data }) => {
                captured.update.push({ where, data })
                if (updateFails) {
                    const e = new Error('Record to update not found')
                    e.code = 'P2025'
                    throw e
                }
                return { ...(existing || {}), id: where.id, ...data }
            },
            create: async ({ data }) => ({ id: 'rec-new', ...data }),
            delete: async () => ({}),
        },
        auditLog: { create: async () => ({}) },
    }
    return { db, captured }
}

async function invoke({ id, body, existing, updateFails = false }) {
    const { db, captured } = makeDb(existing, { updateFails })
    const req = {
        body,
        db,
        params: { tableName: 'oil', id },
        query: {},
        user: { role: 'manager', userId: 'u_me' },
        userId: 'u_me',
        ip: '127.0.0.1',
        get: () => 'test.local',
    }
    const res = makeRes()
    await REC_PUT(req, res)
    return { res, captured }
}

const fullPayload = (over = {}) => ({ ...CTX, result_data: { tpmValue: '0.30' }, ...over })

test('③ 409 扩展：version 不匹配 → 既有字段保持 + conflict/latest/staleReplay（且不写库）', async () => {
    const existing = makeExisting({ id: 'w4-a', version: 5 })
    const { res, captured } = await invoke({ id: 'w4-a', body: fullPayload({ version: 3, result_data: { tpmValue: '0.30' } }), existing })

    assert.equal(res.statusCode, 409)
    assert.equal(res.body.code, 'VERSION_CONFLICT')
    // 既有字段（向后兼容）
    assert.equal(res.body.serverVersion, 5)
    assert.equal(res.body.clientVersion, 3)
    assert.equal(typeof res.body.error, 'string')
    // 新增字段（冲突信息）
    assert.equal(res.body.staleReplay, true)
    assert.equal(res.body.conflict.reason, 'version_mismatch')
    assert.equal(res.body.conflict.recordId, 'w4-a')
    assert.equal(res.body.conflict.server.version, 5)
    assert.equal(res.body.conflict.server.updatedAt, BASE_UPDATED_AT)
    assert.equal(res.body.conflict.retryable, false)
    assert.equal(res.body.latest.id, 'w4-a')
    assert.equal(res.body.latest.version, 5)
    assert.equal(res.body.latest.tpmValue, '0.30', 'latest 必须携带字段级当前值（合并基线）')
    assert.equal(captured.update.length, 0, '冲突响应不得产生任何写库')
})

test('④ 冲突栅栏：刚下发 409 后，"只把 version 换成最新"的整量重放被识别拒绝（不写库）', async () => {
    const id = 'w4-b'
    const existing = makeExisting({ id, version: 2 })

    // 第一次：陈旧 version → 409（建立冲突栅栏）
    const first = await invoke({ id, body: fullPayload({ version: 1, remark: '旧内容' }), existing })
    assert.equal(first.res.statusCode, 409)
    assert.equal(first.res.body.conflict.reason, 'version_mismatch')

    // 旧客户端行为（AUD-022 原缺陷路径）：只把 version 换成服务端最新，payload 仍是旧的
    const replay = await invoke({ id, body: fullPayload({ version: 2, remark: '旧内容' }), existing })
    assert.equal(replay.res.statusCode, 409, 'stale 整量重放必须被拒绝')
    assert.equal(replay.res.body.staleReplay, true)
    assert.equal(replay.res.body.conflict.reason, 'stale_replay_after_conflict')
    assert.equal(replay.captured.update.length, 0, '重放不得写库（旧客户端 = 明确失败，而非误成功）')

    // 携带显式重基声明（与当前状态一致）→ 放行
    const rebase = await invoke({
        id,
        body: fullPayload({ version: 2, base_version: 2, base_updated_at: BASE_UPDATED_AT, remark: '合并后的内容' }),
        existing,
    })
    assert.equal(rebase.res.statusCode, 200)
    assert.equal(rebase.captured.update.length, 1)
    assert.deepEqual(rebase.captured.update[0].where, { id, version: 2 })
})

test('④ 显式基线陈旧（无栅栏，跨进程同语义）：base_version 与当前不一致 → 409 + latest', async () => {
    const existing = makeExisting({ id: 'w4-c', version: 7 })
    const { res, captured } = await invoke({
        id: 'w4-c',
        body: fullPayload({ version: 7, base_version: 4, base_updated_at: BASE_UPDATED_AT, remark: '基于旧基线的合并结果' }),
        existing,
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.body.staleReplay, true)
    assert.equal(res.body.conflict.reason, 'stale_base_version')
    assert.equal(res.body.serverVersion, 7)
    assert.equal(res.body.latest.version, 7)
    assert.equal(captured.update.length, 0, '陈旧基线不得写库')
})

test('④ base_updated_at 不一致同样被识别（时间基线路径）；一致则放行', async () => {
    const existing = makeExisting({ id: 'w4-d', version: 3 })
    const stale = await invoke({
        id: 'w4-d',
        body: fullPayload({ version: 3, base_version: 3, base_updated_at: '2026-01-01T00:00:00.000Z' }),
        existing,
    })
    assert.equal(stale.res.statusCode, 409)
    assert.equal(stale.res.body.conflict.reason, 'stale_base_updated_at')

    const ok = await invoke({
        id: 'w4-d',
        body: fullPayload({ version: 3, base_version: 3, base_updated_at: BASE_UPDATED_AT }),
        existing,
    })
    assert.equal(ok.res.statusCode, 200, JSON.stringify(ok.res.body))
})

test('⑤ 旧客户端兼容：无冲突历史的常规 version 写入仍 200（非冲突路径不收紧）', async () => {
    const existing = makeExisting({ id: 'w4-e', version: 4 })
    const { res, captured } = await invoke({ id: 'w4-e', body: fullPayload({ version: 4, remark: '常规更新' }), existing })
    assert.equal(res.statusCode, 200)
    assert.equal(captured.update.length, 1)
    assert.deepEqual(captured.update[0].where, { id: 'w4-e', version: 4 })
})

test('⑤ 基线声明非法 → 400（明确错误，不落库）', async () => {
    const existing = makeExisting({ id: 'w4-f', version: 2 })
    const { res, captured } = await invoke({ id: 'w4-f', body: fullPayload({ version: 2, base_version: 'abc' }), existing })
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.code, 'INVALID_BASE_DECLARATION')
    assert.equal(captured.update.length, 0)
})

test('④ 原子 CAS 失败（P2025）→ 409 携带回读 latest（serverVersion 不再只是 "stale" 字面量）', async () => {
    const existing = makeExisting({ id: 'w4-g', version: 2 })
    const { res, captured } = await invoke({ id: 'w4-g', body: fullPayload({ version: 2 }), existing, updateFails: true })
    assert.equal(res.statusCode, 409)
    assert.equal(res.body.code, 'VERSION_CONFLICT')
    assert.equal(res.body.conflict.reason, 'atomic_cas_lost')
    assert.equal(res.body.staleReplay, true)
    assert.equal(res.body.serverVersion, 2)
    assert.equal(res.body.latest.id, 'w4-g')
    assert.equal(captured.update.length, 1, 'CAS 尝试过（由桩抛 P2025），但不得有第二次写入')
})

test('④ 重放被拒后（栅栏期）即便不带 version 的写入也必须带显式重基（防止盲写绕过）', async () => {
    const id = 'w4-h'
    const existing = makeExisting({ id, version: 2 })
    const first = await invoke({ id, body: fullPayload({ version: 1 }), existing })
    assert.equal(first.res.statusCode, 409)

    const blind = await invoke({ id, body: fullPayload(), existing })
    assert.equal(blind.res.statusCode, 409, '栅栏期内无显式基线的写入必须被拒绝')
    assert.equal(blind.res.body.conflict.reason, 'stale_replay_after_conflict')
    assert.equal(blind.captured.update.length, 0)
})
