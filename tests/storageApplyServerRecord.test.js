/**
 * 缺陷X（U2/U3）· _applyServerRecord 接入 _handleUpdate 后的端到端回归测试（jsdom）
 *
 * U3：单次 update 成功后，本地缓存 _status 变为 'synced'、version 与服务端一致
 *     （修复前：_status 永久 'updating'、version 永久落后）
 * U2：409 + GET 拉取成功 → 重试自愈后，本地缓存 version 与服务端对齐
 */

import { StorageService } from '../js/core/Storage.js';

function jsonResponse(status, body = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        headers: { get: () => null },
    };
}

/** 预置一条 synced 本地记录 + auth token，返回 storage 实例与 fetch mock */
function setupStorage(serverState) {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('cache_leanMeat', JSON.stringify({
        data: [{ id: 'rec1', version: 1, result: '不合格', _status: 'synced', testDate: '2026-08-07', canteen: '一食堂', inspector: '测试员' }]
    }));
    // jsdom 下 pathname='/' → extractSchoolCode() 返回空 → 使用无前缀 key
    localStorage.setItem('auth_token', 'mock-token');
    localStorage.setItem('auth_token__tjb', 'mock-token');
    localStorage.setItem('pending_leanMeat', '[]');
    localStorage.setItem('fingerprint_index_leanMeat', '[]');

    const fetchMock = jest.fn(async (url, opts = {}) => {
        const method = (opts.method || 'GET').toUpperCase();
        let body = null;
        try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = null; }

        if (method === 'PUT' && /\/api\/records\/leanMeat\/rec1$/.test(url)) {
            if (body?.version === serverState.version) {
                serverState.version += 1;
                if (body.result) serverState.result = body.result;
                return jsonResponse(200, { success: true, data: { id: 'rec1', version: serverState.version, result: serverState.result }, message: '更新成功' });
            }
            return jsonResponse(409, { error: '版本冲突', serverVersion: serverState.version, clientVersion: body?.version });
        }
        if (method === 'GET' && /\/api\/records\/leanMeat\/rec1$/.test(url)) {
            return jsonResponse(200, { data: { id: 'rec1', version: serverState.version, result: serverState.result } });
        }
        if (method === 'GET' && /\/api\/records\/leanMeat$/.test(url)) {
            return jsonResponse(200, { data: [{ id: 'rec1', version: serverState.version, result: serverState.result }] });
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
    return { storage, fetchMock };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitQueueIdle(storage, timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const pending = JSON.parse(localStorage.getItem('pending_leanMeat') || '[]');
        const upload = storage._uploadQueue;
        if (storage._isProcessingQueue === false && pending.length === 0 && upload._isProcessing === false && upload._inFlight === 0 && upload._queueList.length === 0) {
            await sleep(0); await sleep(0);
            return true;
        }
        await sleep(50);
    }
    return false;
}

describe('缺陷X · _applyServerRecord 端到端', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        delete global.fetch;
    });

    test('U3 · 单次 update 成功后本地 _status=synced 且 version 与服务端一致', async () => {
        const serverState = { version: 1, result: '不合格' };
        const { storage } = setupStorage(serverState);

        const cached = JSON.parse(localStorage.getItem('cache_leanMeat')).data[0];
        storage.update('rec1', { ...cached, result: '合格', recheckRecords: [{ isPassed: true, description: '复检' }] });
        const idle = await waitQueueIdle(storage);
        expect(idle).toBe(true);

        const final = JSON.parse(localStorage.getItem('cache_leanMeat')).data[0];
        // 修复目标：_status 落为 synced、version 与服务端一致（2）、result 保持合格
        expect(final._status).toBe('synced');
        expect(final.version).toBe(serverState.version); // 2
        expect(final.result).toBe('合格');
    });

    test('U2 · 409 后 GET 拉取成功 → 重试自愈，本地 version 与服务端对齐', async () => {
        // 模拟本地缓存 version 落后（旧 1，服务端 2）→ 首次 PUT 409 → GET 拉到 2 → 重试成功
        const serverState = { version: 2, result: '不合格' };
        const { storage } = setupStorage(serverState);

        const cached = JSON.parse(localStorage.getItem('cache_leanMeat')).data[0];
        storage.update('rec1', { ...cached, result: '合格' });
        const idle = await waitQueueIdle(storage);
        expect(idle).toBe(true);

        const final = JSON.parse(localStorage.getItem('cache_leanMeat')).data[0];
        expect(final._status).toBe('synced');
        // 服务端从 2 更新到 3，本地应与其对齐
        expect(final.version).toBe(serverState.version); // 3
        expect(final.result).toBe('合格');
    });
});
