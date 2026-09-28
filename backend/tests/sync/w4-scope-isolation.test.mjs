// P3-W4-T01（AUD-001）· 缓存/队列作用域隔离定点回归（jsdom + 合成 fetch）
//
// 判别证据组①：跨租户/跨主体缓存命中矩阵（A/B 校 × 账号）—— 任意跨主体组合命中恒为 0；
// 旧键一次性隔离封存（不双读）；A 校离线任务在 B 校不显示、不上传；作用域守卫零请求。
//
// 运行：node --test backend/tests/sync/w4-scope-isolation.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { installJsdom, setSchool, login, resetBrowserState, jsonResponse, sleep, W4_CONST } from './w4-jsdom-harness.mjs'

installJsdom()
const { StorageService } = await import('../../../frontend/js/core/Storage.js')

const CONFIG = W4_CONST.STORAGE_CONFIG

test.beforeEach(() => {
    resetBrowserState()
    globalThis.fetch = async () => jsonResponse(200, { success: true, data: [] })
})

test('① 矩阵：A/B 校 × 不同账号 —— 跨主体缓存命中恒为 0，同主体可自读', () => {
    const identities = [
        { tenant: 'school-a', subject: { id: 'user-a1', username: 'alpha' } },
        { tenant: 'school-a', subject: { id: 'user-a2', username: 'beta' } },
        { tenant: 'school-b', subject: { id: 'user-a1', username: 'alpha' } },   // 同 id 跨校（不可信复用）
    ]
    const written = []
    for (const idn of identities) {
        setSchool(idn.tenant)
        login(idn.tenant, idn.subject)
        const storage = new StorageService('leanMeat', CONFIG)
        const localId = `rec-${idn.tenant}-${idn.subject.id}`
        storage._addToLocalCache({ id: localId, result: '合格', testDate: '2026-09-01', _status: 'synced' })
        written.push({ ...idn, localId, keys: storage.getStorageKeys(), scope: storage.getSyncScope() })
    }

    // 键必须三方互不相同（tenant + subject + resource）
    assert.equal(new Set(written.map((w) => w.keys.cacheKey)).size, 3)
    assert.equal(new Set(written.map((w) => w.keys.queueKey)).size, 3)
    assert.equal(new Set(written.map((w) => w.scope.scopeId)).size, 3)

    // 逐个主体重开（正序 + 逆序）：只可见自己那一条；跨主体命中 = 0
    for (const order of [written, [...written].reverse()]) {
        for (const w of order) {
            setSchool(w.tenant)
            login(w.tenant, w.subject)
            const storage = new StorageService('leanMeat', CONFIG)
            const rows = storage._getLocalCacheData()
            const mine = rows.filter((r) => r.id === w.localId)
            const foreign = rows.filter((r) => r.id !== w.localId)
            assert.equal(mine.length, 1, `${w.scope.scopeId} 必须能看到自己的记录`)
            assert.equal(foreign.length, 0, `${w.scope.scopeId} 跨主体命中必须为 0，实际 ${JSON.stringify(foreign.map((f) => f.id))}`)
        }
    }
})

test('① 旧键一次性隔离封存：不再被读取（不双读），原始数据封存留证', () => {
    setSchool('school-a')
    login('school-a', { id: 'user-a1' })
    const legacyKeys = ['cache_leanMeat', 'pending_leanMeat', 'fingerprint_index_leanMeat']
    localStorage.setItem('cache_leanMeat', JSON.stringify({ data: [{ id: 'legacy-1', result: '旧数据' }] }))
    localStorage.setItem('pending_leanMeat', JSON.stringify([{ id: 'legacy-task', type: 'create', data: { result: '旧任务' } }]))
    localStorage.setItem('fingerprint_index_leanMeat', JSON.stringify([]))
    localStorage.setItem('app_sync_backoff_until', String(Date.now() + 60000))

    const storage = new StorageService('leanMeat', CONFIG)

    for (const key of [...legacyKeys, 'app_sync_backoff_until']) {
        assert.equal(localStorage.getItem(key), null, `旧键 ${key} 必须移出使用面`)
    }
    assert.equal(JSON.parse(localStorage.getItem('legacy_quarantine_v1__cache_leanMeat')).data[0].id, 'legacy-1')
    assert.equal(JSON.parse(localStorage.getItem('legacy_quarantine_v1__pending_leanMeat'))[0].id, 'legacy-task')

    const record = JSON.parse(localStorage.getItem('sync_scope_migration_v2'))
    assert.equal(record.schemaVersion, 2)
    assert.equal(record.policy, 'one-time-quarantine-no-dual-read')
    assert.deepEqual(
        record.discardedLegacyKeys.map((k) => k.key).sort(),
        ['app_sync_backoff_until', 'cache_leanMeat', 'fingerprint_index_leanMeat', 'pending_leanMeat'],
    )

    // 不双读：新作用域下缓存/队列为空，旧退避值不继承
    assert.deepEqual(storage._getLocalCacheData(), [])
    assert.deepEqual(storage._getPendingRequests(), [])
    assert.equal(storage._getGlobalBackoffUntil(), 0)
})

test('① A 校离线任务在 B 校不显示、不上传；切回 A 校任务仍完整（键隔离 + 归属快照）', async () => {
    // A 校：未登录（无 token）→ 任务只能留在本地队列
    setSchool('school-a')
    localStorage.setItem('current_user__school-a', JSON.stringify({ id: 'user-a1' }))
    const a = new StorageService('leanMeat', CONFIG)
    const created = a.save({ ...W4_CONST.OIL_CTX, result: '合格' })
    const aKeys = a.getStorageKeys()
    const aQueue = JSON.parse(localStorage.getItem(aKeys.queueKey))
    assert.equal(aQueue.items.length, 1)
    assert.equal(aQueue.items[0].scope, a.getSyncScope().scopeId, '任务必须保存创建时的归属快照')
    assert.equal(aQueue.items[0].data.inspector, '甲')

    // 切到 B 校并登录：不得看到 A 的缓存、不得上传任何请求
    setSchool('school-b')
    login('school-b', { id: 'user-b1' })
    let requests = 0
    globalThis.fetch = async () => { requests++; return jsonResponse(200, { success: true, data: [] }) }
    const b = new StorageService('leanMeat', CONFIG)
    await sleep(80)   // 等构造后的队列 tick
    assert.equal(b._getLocalCacheData().length, 0)
    assert.equal(b._getPendingRequests().length, 0)
    assert.equal(requests, 0, 'B 校不得以自身凭据上传 A 校数据')

    // A 的任务仍在 A 的作用域键下且未被改写（数据未丢、未跨主体发送）
    const after = JSON.parse(localStorage.getItem(aKeys.queueKey))
    assert.equal(after.items.length, 1)
    assert.equal(after.items[0].tempId, created.id)
})

test('① 归属守卫（纵深防御）：队列里不属于当前主体的任务被隔离，零请求 + 违规登记', async () => {
    setSchool('school-b')
    login('school-b', { id: 'user-b1' })
    let requests = 0
    globalThis.fetch = async () => { requests++; return jsonResponse(200, { success: true, data: [] }) }
    const storage = new StorageService('leanMeat', CONFIG)

    // 人为注入一条"归属 A 校"的任务到 B 校的队列键（模拟被搬移/篡改的持久化数据）
    localStorage.setItem(storage.getStorageKeys().queueKey, JSON.stringify({
        schemaVersion: 2,
        items: [{
            id: 'sync_foreign', type: 'create', state: 'TEMP_CREATED', tempId: 'temp_foreign',
            data: { ...W4_CONST.OIL_CTX, result: '合格' },
            scope: 'school-a::deadbeef', timestamp: Date.now(), retryCount: 0,
        }],
    }))

    await storage._processQueuedRequests()
    assert.equal(requests, 0, '跨主体任务不得发出任何请求')
    assert.equal(storage._getPendingRequests().length, 0, '被隔离的任务必须移出队列')

    const violations = JSON.parse(localStorage.getItem('sync_scope_violations_v2'))
    assert.equal(violations.length, 1)
    assert.equal(violations[0].reason, 'scope_mismatch')
    assert.equal(violations[0].taskScope, 'school-a::deadbeef')
    assert.equal(violations[0].requestId, 'sync_foreign')
})
