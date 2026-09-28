// P3-W4-T01（AUD-021）· 临时记录同步状态机时序矩阵（jsdom + 合成 fetch / 内存服务端）
//
// 判别证据组②：离线建→改→删→重连、create 在途编辑/删除、失败重试、删除不复活、旧队列结构一次性迁移。
// 断言口径：每条时序的"最终状态 = 用户最后一次操作"，且不存在静默丢弃或幽灵行。
//
// 运行：node --test backend/tests/sync/w4-sync-state-machine.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    installJsdom, setSchool, login, resetBrowserState, jsonResponse,
    sleep, waitUntil, waitUploadIdle, W4_CONST,
} from './w4-jsdom-harness.mjs'

installJsdom()
const { StorageService } = await import('../../../frontend/js/core/Storage.js')
const { SYNC_STATES } = await import('../../../frontend/js/core/SyncStateMachine.js')

const CONFIG = W4_CONST.STORAGE_CONFIG
const CTX = W4_CONST.OIL_CTX

/** 合成服务端：内存行 + 请求日志（POST 可被测试挂起以制造"在途"窗口）。 */
function makeBackend() {
    const log = []
    const rows = new Map()
    let seq = 0
    const handler = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase()
        const body = opts.body ? JSON.parse(opts.body) : null
        log.push({ method, url, body })
        // 非记录接口（如审计双写 POST /api/audit-logs）不参与记录行状态
        if (!url.includes('/api/records/')) return jsonResponse(200, { success: true })
        if (method === 'GET') {
            const single = /\/api\/records\/leanMeat\/[^/?]+$/.test(url)
            if (single) {
                const id = url.split('/').pop()
                return rows.has(id) ? jsonResponse(200, { success: true, data: rows.get(id) }) : jsonResponse(404, { error: '记录不存在' })
            }
            return jsonResponse(200, { success: true, data: [...rows.values()] })
        }
        if (method === 'POST') {
            seq += 1
            const id = `rec-${seq}`
            const row = { id, version: 1, updated_at: new Date(1700000000000 + seq * 1000).toISOString(), ...stripProtocol(body) }
            rows.set(id, row)
            return jsonResponse(200, { success: true, data: row })
        }
        if (method === 'PUT') {
            const id = url.split('/').pop()
            const cur = rows.get(id)
            if (!cur) return jsonResponse(404, { error: '记录不存在' })
            const row = { ...cur, ...stripProtocol(body), version: cur.version + 1, updated_at: new Date(1700000000000 + (++seq) * 1000).toISOString() }
            rows.set(id, row)
            return jsonResponse(200, { success: true, data: row, version: row.version })
        }
        if (method === 'DELETE') {
            rows.delete(url.split('/').pop())
            return jsonResponse(200, { success: true })
        }
        return jsonResponse(200, { success: true })
    }
    return { log, rows, handler }
}

function stripProtocol(body) {
    const out = { ...(body || {}) }
    for (const k of ['version', 'base_version', 'base_updated_at', 'idempotencyKey', 'result_data_mode', 'status']) delete out[k]
    return out
}

const rowOf = (storage, id) => storage._getLocalCacheData().find((r) => String(r.id) === String(id))
const queueEmpty = (storage) => storage._getPendingRequests().length === 0

test.beforeEach(() => resetBrowserState())

test('② 时序 A：离线新建 → 两次编辑 → 联网（编辑必须到达服务端并与本地一致）', async () => {
    setSchool('school-a')
    localStorage.setItem('current_user__school-a', JSON.stringify({ id: 'user-a1' }))
    const backend = makeBackend()
    globalThis.fetch = backend.handler

    const storage = new StorageService('leanMeat', CONFIG)
    const created = storage.save({ ...CTX, result: '不合格' })
    assert.equal(rowOf(storage, created.id)._syncState, SYNC_STATES.TEMP_CREATED)

    storage.update(created.id, { ...rowOf(storage, created.id), result: '合格' })
    storage.update(created.id, { ...rowOf(storage, created.id), remark: '第二次编辑' })
    assert.equal(backend.log.filter((l) => l.method === 'POST').length, 0, '离线期间不得发请求')

    // 联网（签发 token）→ 队列出发
    login('school-a', { id: 'user-a1' })
    await storage._processQueuedRequests()
    assert.equal(await waitUntil(() => queueEmpty(storage), { timeout: 6000 }), true, '队列必须收敛')

    const post = backend.log.find((l) => l.method === 'POST' && l.url.includes('/api/records/'))
    assert.ok(post, '必须发出 create')
    assert.equal(post.body.result, '合格', 'create 出站载荷必须包含最后一次编辑')
    assert.equal(post.body.remark, '第二次编辑')
    const serverRow = backend.rows.get('rec-1')
    assert.ok(serverRow, 'create 必须落到服务端')
    assert.equal(serverRow.result, '合格')
    assert.equal(serverRow.remark, '第二次编辑')

    const local = storage._getLocalCacheData()
    assert.equal(local.length, 1, 'temp 行必须且只能替换为一条 server 行')
    assert.equal(local[0].id, serverRow.id)
    assert.equal(local[0].result, '合格')
    assert.equal(local[0]._syncState, SYNC_STATES.SYNCED)
})

test('② 时序 B：create 在途编辑 → 转为针对新 id 的 update（不丢、最终一致）', async () => {
    setSchool('school-a')
    login('school-a', { id: 'user-a1' })
    const backend = makeBackend()
    let releasePost = null
    globalThis.fetch = (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase()
        if (method === 'POST' && url.includes('/api/records/')) {
            return new Promise((resolve) => {
                releasePost = () => {
                    const row = { id: 'rec-new', version: 1, updated_at: '2026-09-01T00:00:00.000Z', ...CTX, result: '不合格' }
                    backend.rows.set('rec-new', row)
                    resolve(jsonResponse(200, { success: true, data: row }))
                }
            })
        }
        return backend.handler(url, opts)
    }

    const storage = new StorageService('leanMeat', CONFIG)
    const created = storage.save({ ...CTX, result: '不合格' })
    const processing = storage._processQueuedRequests()
    assert.equal(await waitUntil(() => typeof releasePost === 'function', { timeout: 3000 }), true, 'POST 必须已进入在途')

    // 在途期间编辑：原实现会在 create 出队后静默丢弃
    assert.equal(storage.update(created.id, { ...rowOf(storage, created.id), result: '合格' }), true)
    assert.equal(rowOf(storage, created.id)._syncState, SYNC_STATES.EDITING_PENDING)

    releasePost()
    await processing.catch(() => {})
    await waitUploadIdle(storage)
    assert.equal(await waitUntil(() => queueEmpty(storage) && rowOf(storage, 'rec-new'), { timeout: 6000 }), true)
    assert.equal(await waitUntil(() => rowOf(storage, 'rec-new')._syncState === SYNC_STATES.SYNCED, { timeout: 6000 }), true)

    const put = backend.log.find((l) => l.method === 'PUT')
    assert.ok(put, '在途编辑必须转为 update 请求（否则即静默丢失）')
    assert.equal(put.body.result, '合格')
    assert.equal(put.body.base_version, 1, '更新必须显式声明重基基线（AUD-022）')
    assert.equal(put.body.base_updated_at, '2026-09-01T00:00:00.000Z')

    const local = rowOf(storage, 'rec-new')
    assert.equal(local.result, '合格', '本地最终值 = 用户最后一次编辑')
    assert.equal(local._syncState, SYNC_STATES.SYNCED)
})

test('② 时序 C：create 在途删除 → 创建成功后立即删除服务器行（不留幽灵行）', async () => {
    setSchool('school-a')
    login('school-a', { id: 'user-a1' })
    const backend = makeBackend()
    let releasePost = null
    globalThis.fetch = (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase()
        if (method === 'POST' && url.includes('/api/records/')) {
            return new Promise((resolve) => {
                releasePost = () => {
                    const row = { id: 'rec-new', version: 1, updated_at: '2026-09-01T00:00:00.000Z', ...CTX, result: '合格' }
                    backend.rows.set('rec-new', row)
                    resolve(jsonResponse(200, { success: true, data: row }))
                }
            })
        }
        return backend.handler(url, opts)
    }

    const storage = new StorageService('leanMeat', CONFIG)
    const created = storage.save({ ...CTX, result: '合格' })
    const processing = storage._processQueuedRequests()
    assert.equal(await waitUntil(() => typeof releasePost === 'function', { timeout: 3000 }), true)

    assert.equal(storage.delete(created.id), true)
    releasePost()
    await processing.catch(() => {})
    assert.equal(await waitUntil(() => backend.log.some((l) => l.method === 'DELETE'), { timeout: 6000 }), true, '创建成功后必须删除服务器行')

    const del = backend.log.find((l) => l.method === 'DELETE')
    assert.match(del.url, /\/api\/records\/leanMeat\/rec-new$/)
    assert.equal(backend.rows.has('rec-new'), false)
    assert.equal(storage._getLocalCacheData().length, 0, '本地不得留有幽灵行')
    assert.equal(queueEmpty(storage), true)
})

test('② 时序 D：离线新建 → 删除 → 联网（不上传、无幽灵行、墓碑阻止复活）', async () => {
    setSchool('school-a')
    localStorage.setItem('current_user__school-a', JSON.stringify({ id: 'user-a1' }))
    const backend = makeBackend()
    globalThis.fetch = backend.handler

    const storage = new StorageService('leanMeat', CONFIG)
    const created = storage.save({ ...CTX, result: '合格' })
    assert.equal(storage.delete(created.id), true)

    login('school-a', { id: 'user-a1' })
    await storage._processQueuedRequests()
    await waitUploadIdle(storage)

    assert.equal(backend.log.filter((l) => l.method !== 'GET').length, 0, '删除后的离线新建不得上传')
    assert.equal(storage._getLocalCacheData().length, 0)
    assert.equal(queueEmpty(storage), true)
    assert.equal(storage._isTombstoned(created.id), true)

    // 即使服务端/缓存层"给出"该 id（异常场景），也不得复活
    storage._updateLocalCache([{ id: created.id, result: '合格', _status: 'synced' }], { forceServer: true })
    assert.equal(storage._getLocalCacheData().length, 0, '墓碑必须阻止复活')
})

test('② 时序 E：在线删除 → 全量同步返回该行也不复活；删除任务成功收敛', async () => {
    setSchool('school-a')
    login('school-a', { id: 'user-a1' })
    const backend = makeBackend()
    backend.rows.set('rec-1', { id: 'rec-1', version: 3, updated_at: '2026-09-01T00:00:00.000Z', ...CTX, result: '合格' })
    globalThis.fetch = backend.handler

    const storage = new StorageService('leanMeat', CONFIG)
    storage._applyServerRecord({ ...backend.rows.get('rec-1') })
    assert.equal(storage._getLocalCacheData().length, 1)

    assert.equal(storage.delete('rec-1'), true)
    await storage._processQueuedRequests()
    assert.equal(await waitUntil(() => queueEmpty(storage), { timeout: 6000 }), true)
    assert.equal(backend.rows.has('rec-1'), false, '删除必须落到服务端')

    // 全量同步（服务端若仍返回该行）不得复活
    backend.rows.set('rec-1', { id: 'rec-1', version: 3, updated_at: '2026-09-01T00:00:00.000Z', ...CTX })
    await storage._syncFromApi(true)
    assert.equal(storage._getLocalCacheData().some((r) => String(r.id) === 'rec-1'), false, '墓碑必须阻止同步复活')
})

test('② 时序 F：失败重试 → FAILED（显式态），再编辑后恢复 SYNCED', async () => {
    setSchool('school-a')
    login('school-a', { id: 'user-a1' })
    let putCount = 0
    globalThis.fetch = async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase()
        if (method === 'PUT') {
            putCount += 1
            // 403 = 明确的客户端拒绝：不进入队列层/存储层的重试链，直接进入 FAILED 显式态
            if (putCount === 1) return jsonResponse(403, { error: '无权修改' })
            return jsonResponse(200, { success: true, data: { id: 'rec-1', version: 2, updated_at: new Date(Date.now()).toISOString(), ...CTX, result: '合格', remark: '再试' } })
        }
        return jsonResponse(200, { success: true, data: [{ id: 'rec-1', version: 1, updated_at: '2026-09-01T00:00:00.000Z', ...CTX, result: '不合格' }] })
    }

    const storage = new StorageService('leanMeat', CONFIG)
    storage._applyServerRecord({ id: 'rec-1', version: 1, updated_at: '2026-09-01T00:00:00.000Z', ...CTX, result: '不合格' })
    storage.update('rec-1', { ...rowOf(storage, 'rec-1'), result: '合格' })

    assert.equal(await waitUntil(() => rowOf(storage, 'rec-1')._syncState === SYNC_STATES.FAILED, { timeout: 8000 }), true, '明确失败必须进入显式 FAILED 态')
    assert.equal(storage._getPendingRequests().some((r) => r._failed === true), true)
    assert.equal(putCount, 1, '403 属明确客户端拒绝：不得进入自动重试链')

    storage.update('rec-1', { ...rowOf(storage, 'rec-1'), remark: '再试' })
    assert.equal(await waitUntil(() => rowOf(storage, 'rec-1')._syncState === SYNC_STATES.SYNCED, { timeout: 6000 }), true, '再编辑后必须能恢复')
    assert.equal(rowOf(storage, 'rec-1').remark, '再试')
})

test('② 旧队列结构（裸数组）一次性版本化迁移：不静默双读，记录迁移事件', () => {
    setSchool('school-b')
    login('school-b', { id: 'user-b1' })
    globalThis.fetch = async () => jsonResponse(200, { success: true, data: [] })
    const probe = new StorageService('leanMeat', CONFIG)
    const queueKey = probe.getStorageKeys().queueKey

    localStorage.setItem(queueKey, JSON.stringify([{ id: 'legacy-task', type: 'create', data: { result: '旧任务' } }]))
    const storage = new StorageService('leanMeat', CONFIG)
    assert.deepEqual(storage._getPendingRequests(), [], '旧结构不得被静默按新语义读取')
    assert.equal(localStorage.getItem(queueKey).includes('legacy-task'), false, '旧任务必须移出使用面')

    const migration = JSON.parse(localStorage.getItem('sync_queue_migration_v2'))
    assert.equal(migration.some((m) => m.reason === 'legacy_array_schema' && m.items === 1), true)
})
