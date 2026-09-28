// P3-W4-T01（AUD-022）· 409 并发协议客户端语义（jsdom + 合成 CAS 服务端）
//
// 判别证据组③：两客户端并发（A 改 X、B 改 Y 均保留；同改 X → 一方 409+冲突信息，无静默覆盖）；
//   证据组④（客户端侧）：stale 全量重放被禁止 —— 客户端只在"字段级三路合并无冲突"时自动重基，
//   且必须携带 base_version/base_updated_at 显式声明；同字段冲突一律进入显式 CONFLICT 态。
//
// 运行：node --test backend/tests/sync/w4-conflict-merge.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    installJsdom, setSchool, login, resetBrowserState, jsonResponse,
    waitUntil, W4_CONST,
} from './w4-jsdom-harness.mjs'

installJsdom()
const { StorageService } = await import('../../../frontend/js/core/Storage.js')
const { SYNC_STATES } = await import('../../../frontend/js/core/SyncStateMachine.js')

const CONFIG = W4_CONST.STORAGE_CONFIG
const CTX = W4_CONST.OIL_CTX
const BASE_UPDATED_AT = '2026-09-01T00:00:00.000Z'

/** 合成 CAS 服务端：行为对齐 P3-W4-T01 扩展后的 PUT /api/records/:tableName/:id。 */
function makeCasServer(initialRow) {
    const state = { row: { ...initialRow }, writes: [], putAttempts: [], conflicts: 0 }
    const handler = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase()
        const body = opts.body ? JSON.parse(opts.body) : null
        // 非记录接口（如审计双写 POST /api/audit-logs）不参与记录行状态
        if (!url.includes('/api/records/')) return jsonResponse(200, { success: true })
        const isSingle = /\/api\/records\/leanMeat\/[^/?]+$/.test(url)
        if (method === 'GET') {
            return jsonResponse(200, { success: true, data: isSingle ? state.row : [state.row] })
        }
        if (method === 'PUT') {
            state.putAttempts.push(body)
            const declared = body && body.base_version !== undefined ? Number(body.base_version)
                : (body && body.version !== undefined ? Number(body.version) : undefined)
            if (declared !== undefined && declared !== state.row.version) {
                state.conflicts += 1
                return jsonResponse(409, {
                    error: '版本冲突，请基于最新数据合并后重试',
                    code: 'VERSION_CONFLICT',
                    serverVersion: state.row.version,
                    clientVersion: body && body.version !== undefined ? body.version : null,
                    staleReplay: true,
                    conflict: {
                        reason: body && body.base_version !== undefined ? 'stale_base_version' : 'version_mismatch',
                        recordId: state.row.id,
                        server: { version: state.row.version, updatedAt: state.row.updated_at },
                        retryable: false,
                    },
                    latest: { ...state.row },
                })
            }
            state.writes.push(body)
            state.row = {
                ...state.row,
                ...stripProtocol(body),
                version: state.row.version + 1,
                updated_at: new Date(Date.parse(state.row.updated_at) + 60000).toISOString(),
            }
            return jsonResponse(200, { success: true, data: state.row, version: state.row.version })
        }
        return jsonResponse(200, { success: true, data: [] })
    }
    return { state, handler }
}

function stripProtocol(body) {
    const out = { ...(body || {}) }
    for (const k of ['version', 'base_version', 'base_updated_at', 'idempotencyKey', 'result_data_mode']) delete out[k]
    return out
}

const rowOf = (storage, id) => storage._getLocalCacheData().find((r) => String(r.id) === String(id))
const baseRow = (id) => ({ id, version: 1, updated_at: BASE_UPDATED_AT, ...CTX, result: '合格', remark: '原始值' })

test.beforeEach(() => resetBrowserState())

test('③ 两客户端并发（不同字段）：A 改 remark、B 改 inspector —— 两者都必须保留', async () => {
    const server = makeCasServer(baseRow('rec1'))
    globalThis.fetch = server.handler

    // 客户端 A（school-a / user-a1）：从 v1 基线改 remark → 成功（v2）
    setSchool('school-a')
    login('school-a', { id: 'user-a1' })
    const a = new StorageService('leanMeat', CONFIG)
    a._applyServerRecord({ ...server.state.row })
    a.update('rec1', { ...rowOf(a, 'rec1'), remark: 'A 的新内容' })
    assert.equal(await waitUntil(() => server.state.writes.length === 1, { timeout: 6000 }), true, 'A 的写入必须成功')
    assert.equal(server.state.row.remark, 'A 的新内容')
    assert.equal(server.state.row.version, 2)

    // 客户端 B（同校另一账号 user-b1）：仍以 v1 为基线改 inspector（不同字段）
    login('school-a', { id: 'user-b1' })
    const b = new StorageService('leanMeat', CONFIG)
    b._applyServerRecord(baseRow('rec1'))          // B 本地看到的仍是 v1
    b.update('rec1', { ...rowOf(b, 'rec1'), inspector: '乙' })
    assert.equal(
        await waitUntil(() => rowOf(b, 'rec1')._syncState === SYNC_STATES.SYNCED, { timeout: 8000 }),
        true,
        `B 必须能收敛：${JSON.stringify({ row: rowOf(b, 'rec1'), queue: b._getPendingRequests() })}`,
    )

    // 双方修改都必须保留，且 B 的第二次写入带显式重基声明（不是"只换 version 的整量重放"）
    assert.equal(server.state.row.remark, 'A 的新内容', 'A 的字段不得被覆盖')
    assert.equal(server.state.row.inspector, '乙', 'B 的字段必须保留')
    assert.equal(server.state.row.version, 3)
    const rebaseWrite = server.state.writes[1]
    assert.equal(Number(rebaseWrite.base_version), 2, '重基写必须声明 base_version=服务端最新')
    assert.equal(
        rebaseWrite.base_updated_at,
        new Date(Date.parse(BASE_UPDATED_AT) + 60000).toISOString(),
        '重基写必须声明 base_updated_at=v2 的服务端时间（显式基线，而非伪造最新）',
    )
    assert.equal(Number(rebaseWrite.version), 2, 'CAS version 必须同步为服务端最新（否则永久 409）')
    assert.equal(rowOf(b, 'rec1')._syncState, SYNC_STATES.SYNCED)
})

test('③ 两客户端并发（同字段）：同改 result → 显式 CONFLICT 态，服务端内容不被覆盖', async () => {
    const server = makeCasServer(baseRow('rec2'))
    globalThis.fetch = server.handler

    // A：result '合格' → '不合格'（服务端 v2）
    setSchool('school-a')
    login('school-a', { id: 'user-a1' })
    const a = new StorageService('leanMeat', CONFIG)
    a._applyServerRecord({ ...server.state.row })
    a.update('rec2', { ...rowOf(a, 'rec2'), result: '不合格' })
    assert.equal(await waitUntil(() => server.state.writes.length === 1, { timeout: 6000 }), true)

    // B 从 v1 基线改同一字段为第三个值 → 无法自动合并
    login('school-a', { id: 'user-b1' })
    const b = new StorageService('leanMeat', CONFIG)
    b._applyServerRecord(baseRow('rec2'))
    const conflictEvents = []
    b.on('sync', (e) => conflictEvents.push(e))
    b.update('rec2', { ...rowOf(b, 'rec2'), result: '待复检' })

    assert.equal(
        await waitUntil(() => rowOf(b, 'rec2')._syncState === SYNC_STATES.CONFLICT, { timeout: 8000 }),
        true,
        `同字段冲突必须进入显式 CONFLICT 态：${JSON.stringify({ row: rowOf(b, 'rec2'), queue: b._getPendingRequests() })}`,
    )

    // 服务端只被 A 写过（B 绝不落库覆盖）
    assert.equal(server.state.writes.length, 1, 'B 不得发生写（禁止自动全量重放）')
    assert.equal(server.state.row.result, '不合格', 'A 的值必须保留')
    assert.equal(server.state.row.version, 2, '冲突不得推进版本')

    const row = rowOf(b, 'rec2')
    assert.equal(row._syncState, SYNC_STATES.CONFLICT)
    assert.equal(row._conflict.reason, 'field_conflict')
    assert.deepEqual(row._conflict.fields, ['result'], '冲突字段必须显式列出（供用户裁决）')
    assert.equal(row._conflict.server.result, '不合格')
    assert.equal(row._conflict.local.result, '待复检')
    assert.equal(row.result, '待复检', '本地编辑必须保留（不静默丢弃）')

    // 队列项进入 CONFLICT 且标记为不可自动重试
    const stuck = b._getPendingRequests().filter((r) => r._failed === true)
    assert.equal(stuck.length >= 1, true)
    assert.equal(stuck[0].state, SYNC_STATES.CONFLICT)
    assert.equal(stuck[0].nextAttemptAt, null)

    // 冲突态必须有可观测事件（供 UI 提示用户裁决）
    assert.equal(conflictEvents.some((e) => e.type === 'conflict'), true, '必须发出 conflict 事件')

    // 旧客户端负例（客户端侧）：不得出现"payload 与旧值相同、只把 version 换成最新"的重放
    const staleReplays = server.state.putAttempts.filter((p) => p
        && p.base_version === undefined
        && p.version === 2
        && p.result === '合格')
    assert.equal(staleReplays.length, 0, '禁止 stale 整量重放（只换 version）')
})

test('④ stale 重放被识别拒绝后（服务端 409 staleReplay），客户端改为显式重基而非重放 stale 载荷', async () => {
    // 服务端只接受"显式重基"的写入：任何 base_version 缺失/陈旧 → 409 staleReplay
    const state = { row: baseRow('rec3'), attempts: [] }
    // 服务端已前进到 v6 且另一字段（canteen）被他人改动；客户端本地基线仍是 v5
    state.row.version = 6
    state.row.canteen = '二食堂'
    state.row.updated_at = new Date(Date.parse(BASE_UPDATED_AT) + 60000).toISOString()
    globalThis.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase()
        if (method === 'PUT') {
            const body = JSON.parse(opts.body || '{}')
            state.attempts.push(body)
            if (Number(body.base_version) !== state.row.version) {
                return jsonResponse(409, {
                    error: '版本冲突，请基于最新数据合并后重试', code: 'VERSION_CONFLICT',
                    serverVersion: state.row.version, clientVersion: body.version ?? null, staleReplay: true,
                    conflict: { reason: body.base_version === undefined ? 'stale_replay_after_conflict' : 'stale_base_version', retryable: false },
                    latest: { ...state.row },
                })
            }
            state.row = { ...state.row, ...stripProtocol(body), version: state.row.version + 1, updated_at: new Date(Date.parse(state.row.updated_at) + 60000).toISOString() }
            return jsonResponse(200, { success: true, data: state.row })
        }
        return jsonResponse(200, { success: true, data: [state.row] })
    }

    setSchool('school-a')
    login('school-a', { id: 'user-a1' })
    const storage = new StorageService('leanMeat', CONFIG)
    // 本地基线 = v5（canteen 一食堂）；服务端已到 v6（canteen 二食堂 属他人改动）
    storage._applyServerRecord({ ...baseRow('rec3'), version: 5 })
    storage.update('rec3', { ...rowOf(storage, 'rec3'), remark: '本地改动' })

    assert.equal(await waitUntil(() => rowOf(storage, 'rec3')._syncState === SYNC_STATES.SYNCED, { timeout: 8000 }), true)
    // 第一次尝试（base_version=5）被识别为 stale；重基后（base_version=6）成功
    assert.equal(state.attempts.length >= 2, true)
    assert.equal(state.attempts.every((a) => a.base_version !== undefined), true, '每次写入都必须显式声明基线')
    assert.equal(state.attempts[0].base_version, 5)
    assert.equal(state.attempts[1].base_version, 6)
    // 字段级合并：他人改动的 canteen 保留，本地改动 remark 落库
    assert.equal(state.row.canteen, '二食堂', '服务端字段不得被回退')
    assert.equal(state.row.remark, '本地改动')
})

test('④ 拿不到服务端基线时不得盲目重放：进入 CONFLICT 态并保留本地编辑', async () => {
    globalThis.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase()
        if (method === 'PUT') {
            return jsonResponse(409, { error: '版本冲突', code: 'VERSION_CONFLICT', serverVersion: 9, clientVersion: 1 })
        }
        return jsonResponse(500, { error: '拉取失败' })   // GET 单条失败 → 无 latest
    }

    setSchool('school-a')
    login('school-a', { id: 'user-a1' })
    const storage = new StorageService('leanMeat', CONFIG)
    storage._applyServerRecord(baseRow('rec4'))
    storage.update('rec4', { ...rowOf(storage, 'rec4'), remark: '本地改动' })

    assert.equal(await waitUntil(() => rowOf(storage, 'rec4')._syncState === SYNC_STATES.CONFLICT, { timeout: 8000 }), true)
    assert.equal(rowOf(storage, 'rec4').remark, '本地改动')
    assert.equal(rowOf(storage, 'rec4')._conflict.reason, 'unresolved_server_baseline')
})
