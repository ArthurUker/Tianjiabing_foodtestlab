/**
 * StorageService 端到端回归（jsdom）—— P3-CONS-T01 按总控裁决更新（P3-PARALLEL-R1_REVIEW.md 收口清单 #3）
 *
 * 来源映射（注释溯源，场景保留、断言反转为新语义）：
 *   · 本文件原为「缺陷X（U2/U3）probe」：U3（单次 update 成功 → 本地 synced/version 对齐）语义不变，
 *     正式 regression 同时由 P3-W4-T01 套件承接（backend/tests/sync/w4-sync-state-machine.test.mjs）。
 *   · U2 原断言「409 后 GET 拉取 → 重试自愈（自动重放）」编码的正是 AUD-022 已实证的 stale 全量重放
 *     缺陷路径。P3-W4-T01 新语义：队列层 409 立即 reject（_fetchLatest 移除）；Storage 的同步状态机做
 *     **字段级三路合并**——无冲突才自动重基一次，且必须携带 base_version/base_updated_at 显式声明；
 *     同字段冲突进入显式 CONFLICT 态。本用例保留「本地 version 落后 + 服务端已前进」场景，
 *     断言反转为：收敛经由 409 → GET 拉基线 → 无冲突合并 → 显式重基写（非只换 version 的重放）。
 *   · 键来源：旧 `cache_<table>`/`pending_<table>` 直读 → P3-W4-T01（AUD-001）作用域键
 *     `cache_v2__<tenant>__<subjectHash>__<res>`（经 StorageService#getStorageKeys() 同源的
 *     SyncScope.resolveSyncScope()+buildScopedKeys() 派生；旧键零双读，故种子必须写入新键）。
 */

import { StorageService } from '../frontend/js/core/Storage.js';
import { resolveSyncScope, buildScopedKeys } from '../frontend/js/core/SyncScope.js';

function jsonResponse(status, body = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        headers: { get: () => null },
    };
}

const BASE_UPDATED_AT = '2026-09-01T00:00:00.000Z';

/** 当前测试作用域下的存储键（与 StorageService 构造内部同一派生源：SyncScope.buildScopedKeys）。 */
function scopedKeys() {
    return buildScopedKeys('leanMeat', resolveSyncScope());
}

/** 预置一条 synced 本地记录 + auth token，返回 storage 实例与 fetch mock */
function setupStorage(serverState) {
    localStorage.clear();
    sessionStorage.clear();
    const KEYS = scopedKeys();
    localStorage.setItem(KEYS.cacheKey, JSON.stringify({
        data: [{ id: 'rec1', version: 1, result: '不合格', _status: 'synced', testDate: '2026-08-07', canteen: '一食堂', inspector: '测试员' }]
    }));
    // jsdom 下 pathname='/' → extractSchoolCode() 返回空 → 无租户命名空间（mock-token 非 JWT → 匿名主体，稳定）
    localStorage.setItem('auth_token', 'mock-token');
    // 队列键不预置：由 StorageService 初始化为版本化快照（{_schemaVersion, items:[]}）
    localStorage.setItem(KEYS.fingerprintKey, '[]');

    const fetchMock = jest.fn(async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        let body = null;
        try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = null; }

        if (method === 'PUT' && /\/api\/records\/leanMeat\/rec1$/.test(url)) {
            if (body?.version === serverState.version) {
                serverState.version += 1;
                if (body.result) serverState.result = body.result;
                serverState.updated_at = new Date(Date.parse(serverState.updated_at) + 60000).toISOString();
                return jsonResponse(200, { success: true, data: { id: 'rec1', version: serverState.version, result: serverState.result, updated_at: serverState.updated_at }, message: '更新成功' });
            }
            // 旧服务端兼容形态：409 只带 serverVersion/clientVersion（无 latest/conflict 扩展字段）
            return jsonResponse(409, { error: '版本冲突', serverVersion: serverState.version, clientVersion: body?.version });
        }
        if (method === 'GET' && /\/api\/records\/leanMeat\/rec1$/.test(url)) {
            serverState.getCalls = (serverState.getCalls || 0) + 1;
            return jsonResponse(200, { data: { id: 'rec1', version: serverState.version, result: serverState.result, updated_at: serverState.updated_at } });
        }
        if (method === 'GET' && /\/api\/records\/leanMeat$/.test(url)) {
            return jsonResponse(200, { data: [{ id: 'rec1', version: serverState.version, result: serverState.result, updated_at: serverState.updated_at }] });
        }
        return jsonResponse(200, { success: true });
    });
    global.fetch = fetchMock;

    const storage = new StorageService('leanMeat', {
        apiBaseUrl: '/api/records',
        queueBatchDelayMs: 50,
        queueBatchSize: 5,
        minRetryDelayMs: 10,
        maxRetryDelayMs: 100,
    });
    return { storage, fetchMock, KEYS };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 队列键在 P3-W4-T01 后为版本化快照对象 {schemaVersion, items[]}（旧格式为数组）；两种形态都兼容读取。 */
function readQueueItems(keys) {
    const parsed = JSON.parse(localStorage.getItem(keys.queueKey) || 'null');
    if (Array.isArray(parsed)) return parsed;
    return parsed && Array.isArray(parsed.items) ? parsed.items : [];
}

async function waitQueueIdle(storage, keys, timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const pending = readQueueItems(keys);
        const upload = storage._uploadQueue;
        if (storage._isProcessingQueue === false && pending.length === 0 && upload._isProcessing === false && upload._inFlight === 0 && upload._queueList.length === 0) {
            await sleep(0); await sleep(0);
            return true;
        }
        await sleep(50);
    }
    return false;
}

describe('StorageService 端到端（P3-W4-T01 新语义；键为 cache_v2 作用域键）', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        delete global.fetch;
    });

    test('U3 · 单次 update 成功后本地 _status=synced 且 version 与服务端一致（语义不变，键迁移）', async () => {
        const serverState = { version: 1, result: '不合格', updated_at: BASE_UPDATED_AT };
        const { storage, KEYS } = setupStorage(serverState);
        // 键作用域断言（AUD-001 收口）：实例键必须是 cache_v2__ 作用域键，且与测试种子同源
        expect(storage.getStorageKeys().cacheKey).toBe(KEYS.cacheKey);
        expect(storage.getStorageKeys().cacheKey).toMatch(/^cache_v2__/);

        const cached = JSON.parse(localStorage.getItem(KEYS.cacheKey)).data[0];
        storage.update('rec1', { ...cached, result: '合格', recheckRecords: [{ isPassed: true, description: '复检' }] });
        const idle = await waitQueueIdle(storage, KEYS);
        expect(idle).toBe(true);

        const final = JSON.parse(localStorage.getItem(KEYS.cacheKey)).data[0];
        // 修复目标：_status 落为 synced、version 与服务端一致（2）、result 保持合格
        expect(final._status).toBe('synced');
        expect(final.version).toBe(serverState.version); // 2
        expect(final.result).toBe('合格');
    });

    test('U2 · 409 后经字段级三路合并显式重基收敛（不再自动重放 stale 载荷）', async () => {
        // 场景保留：本地缓存 version 落后（旧 1，服务端 2）→ 首次 PUT 409
        const serverState = { version: 2, result: '不合格', updated_at: BASE_UPDATED_AT };
        const { storage, fetchMock, KEYS } = setupStorage(serverState);

        const cached = JSON.parse(localStorage.getItem(KEYS.cacheKey)).data[0];
        storage.update('rec1', { ...cached, result: '合格' });
        const idle = await waitQueueIdle(storage, KEYS);
        expect(idle).toBe(true);

        const final = JSON.parse(localStorage.getItem(KEYS.cacheKey)).data[0];
        expect(final._status).toBe('synced');
        // 服务端从 2 更新到 3，本地应与其对齐
        expect(final.version).toBe(serverState.version); // 3
        expect(final.result).toBe('合格');

        // ── 新语义断言（替代旧「换 version 重放」断言）──
        const puts = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET').toUpperCase() === 'PUT');
        expect(puts.length).toBe(2, '409 一次 + 显式重基一次（不自动重放、不退避重试）');
        const bodies = puts.map(([, opts]) => JSON.parse(opts.body));
        // 第一次：CAS version=本地基线 1 → 409
        expect(bodies[0].version).toBe(1);
        // 第二次：显式重基 —— version 与 base_version 都声明为服务端最新（2），并带 base_updated_at；
        // 与"只把 version 换成最新的整量重放"的区别在于显式基线声明（AUD-022 协议）
        expect(bodies[1].version).toBe(2);
        expect(bodies[1].base_version).toBe(2);
        expect(bodies[1].base_updated_at).toBe(BASE_UPDATED_AT);
        expect(bodies[1].result).toBe('合格', '合并结果保留本地编辑');
        // 旧服务端 409 无 latest → 回退 GET 单条拉取基线（恰好一次）
        const gets = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET').toUpperCase() === 'GET' && /\/rec1$/.test(url));
        expect(gets.length).toBe(1);
        expect(serverState.getCalls).toBe(1);
    });
});
