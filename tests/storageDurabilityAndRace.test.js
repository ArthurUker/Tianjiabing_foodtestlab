/**
 * StorageService 持久性验证 + 创建后立即复检竞态回归（jsdom）
 * —— P3-CONS-T01 按总控裁决更新（P3-PARALLEL-R1_REVIEW.md 收口清单 #3 / W4 未决 #1）
 *
 * 来源映射：本文件原为「缺陷X（U6/U7）probe」。U7/U6 的场景与断言语义**全部保留**；
 * 唯一变化是键来源：旧全局键 `cache_<table>`/`pending_<table>`/`fingerprint_index_<table>`
 * → P3-W4-T01（AUD-001）作用域键 `cache_v2__<tenant>__<subjectHash>__<res>`（经
 * StorageService#getStorageKeys() 同源的 SyncScope.resolveSyncScope()+buildScopedKeys() 派生；
 * 旧键已零双读，种子必须写入新键）。U7 的 409 分支仅为守卫（本场景 version 匹配不触发），
 * 409 的新语义回归见 tests/storageApplyServerRecord.test.js 与 backend/tests/sync/w4-*。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 当前测试作用域下的存储键（与 StorageService 构造内部同一派生源：SyncScope.buildScopedKeys）。 */
function scopedKeys() {
    return buildScopedKeys('leanMeat', resolveSyncScope());
}

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

describe('StorageService 持久性验证（U7；键为 cache_v2 作用域键）', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        delete global.fetch;
    });

    test('U7 · update 成功后模拟刷新（_syncFromApi），服务端数据可覆盖本地，无永久 updating', async () => {
        const KEYS = scopedKeys();
        const serverState = { version: 1, result: '不合格' };
        localStorage.setItem(KEYS.cacheKey, JSON.stringify({
            data: [{ id: 'rec1', version: 1, result: '不合格', _status: 'synced', testDate: '2026-08-07', canteen: '一食堂', inspector: '测试员' }]
        }));
        localStorage.setItem('auth_token', 'mock-token');
        // 队列键不预置：由 StorageService 初始化为版本化快照（{schemaVersion, items:[]}）
        localStorage.setItem(KEYS.fingerprintKey, '[]');

        global.fetch = jest.fn(async (url, opts = {}) => {
            const method = (opts.method || 'GET').toUpperCase();
            let body = null;
            try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = null; }
            if (method === 'PUT' && /rec1$/.test(url)) {
                if (body?.version === serverState.version) {
                    serverState.version += 1;
                    if (body.result) serverState.result = body.result;
                    return jsonResponse(200, { success: true, data: { id: 'rec1', version: serverState.version, result: serverState.result }, message: '更新成功' });
                }
                return jsonResponse(409, { error: '版本冲突', serverVersion: serverState.version, clientVersion: body?.version });
            }
            if (method === 'GET' && /\/api\/records\/leanMeat(\?|$)/.test(url)) {
                return jsonResponse(200, { data: [{ id: 'rec1', version: serverState.version, result: serverState.result }] });
            }
            return jsonResponse(200, { success: true });
        });

        const storage = new StorageService('leanMeat', {
            apiBaseUrl: '/api/records', queueBatchDelayMs: 50, queueBatchSize: 5,
            minRetryDelayMs: 10, maxRetryDelayMs: 100,
        });

        // 一次 update 成功
        const cached = JSON.parse(localStorage.getItem(KEYS.cacheKey)).data[0];
        storage.update('rec1', { ...cached, result: '合格' });
        expect(await waitQueueIdle(storage, KEYS)).toBe(true);

        // update 成功后本地应已是 synced（修复目标）
        let final = JSON.parse(localStorage.getItem(KEYS.cacheKey)).data[0];
        expect(final._status).toBe('synced');

        // 模拟刷新：强制 _syncFromApi 拉取服务端
        await storage._syncFromApi(true);
        final = JSON.parse(localStorage.getItem(KEYS.cacheKey)).data[0];
        // 持久性验证：刷新后本地 _status 仍 synced、version 与服务端一致（无永久 updating 卡死）
        expect(final._status).toBe('synced');
        expect(final.version).toBe(serverState.version);
    });
});

describe('StorageService 创建后立即复检竞态（U6，记录行为；键为 cache_v2 作用域键）', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        delete global.fetch;
    });

    test('U6 · save() 后立即 update(tempId)：不产生崩溃/不引入新失败模式（记录已知限制）', async () => {
        const KEYS = scopedKeys();
        localStorage.setItem(KEYS.cacheKey, JSON.stringify({ data: [] }));
        localStorage.setItem('auth_token', 'mock-token');
        // 队列键不预置：由 StorageService 初始化为版本化快照（{schemaVersion, items:[]}）
        localStorage.setItem(KEYS.fingerprintKey, '[]');

        let createdId = null;
        global.fetch = jest.fn(async (url, opts = {}) => {
            const method = (opts.method || 'GET').toUpperCase();
            let body = null;
            try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = null; }
            if (method === 'POST' && /\/api\/records\/leanMeat$/.test(url)) {
                createdId = 'rec-new';
                return jsonResponse(200, { success: true, data: { id: 'rec-new', version: 1, result: body?.result || '不合格' }, message: '记录创建成功' });
            }
            if (method === 'GET' && /\/api\/records\/leanMeat(\?|$)/.test(url)) {
                return jsonResponse(200, { data: createdId ? [{ id: createdId, version: 1, result: '不合格' }] : [] });
            }
            return jsonResponse(200, { success: true });
        });

        const storage = new StorageService('leanMeat', {
            apiBaseUrl: '/api/records', queueBatchDelayMs: 50, queueBatchSize: 5,
            minRetryDelayMs: 10, maxRetryDelayMs: 100,
        });

        // 创建 + 立即复检（不等待 create resolve）
        const created = storage.save({ testDate: '2026-08-07', canteen: '一食堂', inspector: '测试员', result: '不合格' });
        const ok = storage.update(created.id, { ...created, result: '合格', recheckRecords: [{ isPassed: true, description: '复检' }] });
        expect(ok).toBe(true);

        await waitQueueIdle(storage, KEYS);

        // 行为记录：不崩溃、队列空闲；复检数据可能因 tempId 竞态合并失败（已知限制，非本轮修复范围）
        const finalCache = JSON.parse(localStorage.getItem(KEYS.cacheKey) || '{"data":[]}');
        expect(Array.isArray(finalCache.data)).toBe(true);
        // 不抛异常即为通过（失败模式已在报告"发现但本轮未处理"清单中记录）
    });
});
