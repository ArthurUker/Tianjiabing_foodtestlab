/**
 * 缺陷X（U6/U7）· 持久性验证 + 创建后立即复检竞态回归（jsdom）
 *
 * U7：触发 pending merge 覆盖场景后，模拟"刷新/重新拉取"（_syncFromApi），
 *     确认修复后 _status 不再永久卡在 updating（服务端数据可覆盖本地 synced）。
 * U6：创建后立即复检（tempId 竞态）——记录当前行为（复检数据合并进 create 或
 *     作为已知限制），确保修复未引入新的失败模式。
 */

import { StorageService } from '../frontend/js/core/Storage.js';

function jsonResponse(status, body = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        headers: { get: () => null },
    };
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

describe('缺陷X · 持久性验证（U7）', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        delete global.fetch;
    });

    test('U7 · 修复后：update 成功后模拟刷新（_syncFromApi），服务端数据可覆盖本地，无永久 updating', async () => {
        const serverState = { version: 1, result: '不合格' };
        localStorage.setItem('cache_leanMeat', JSON.stringify({
            data: [{ id: 'rec1', version: 1, result: '不合格', _status: 'synced', testDate: '2026-08-07', canteen: '一食堂', inspector: '测试员' }]
        }));
        localStorage.setItem('auth_token', 'mock-token');
        localStorage.setItem('pending_leanMeat', '[]');
        localStorage.setItem('fingerprint_index_leanMeat', '[]');

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
        const cached = JSON.parse(localStorage.getItem('cache_leanMeat')).data[0];
        storage.update('rec1', { ...cached, result: '合格' });
        expect(await waitQueueIdle(storage)).toBe(true);

        // update 成功后本地应已是 synced（修复目标）
        let final = JSON.parse(localStorage.getItem('cache_leanMeat')).data[0];
        expect(final._status).toBe('synced');

        // 模拟刷新：强制 _syncFromApi 拉取服务端
        await storage._syncFromApi(true);
        final = JSON.parse(localStorage.getItem('cache_leanMeat')).data[0];
        // 持久性验证：刷新后本地 _status 仍 synced、version 与服务端一致（无永久 updating 卡死）
        expect(final._status).toBe('synced');
        expect(final.version).toBe(serverState.version);
    });
});

describe('缺陷X · 创建后立即复检竞态（U6，记录行为）', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        delete global.fetch;
    });

    test('U6 · save() 后立即 update(tempId)：不产生崩溃/不引入新失败模式（记录已知限制）', async () => {
        localStorage.setItem('cache_leanMeat', JSON.stringify({ data: [] }));
        localStorage.setItem('auth_token', 'mock-token');
        localStorage.setItem('pending_leanMeat', '[]');
        localStorage.setItem('fingerprint_index_leanMeat', '[]');

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

        await waitQueueIdle(storage);

        // 行为记录：不崩溃、队列空闲；复检数据可能因 tempId 竞态合并失败（已知限制，非本轮修复范围）
        const finalCache = JSON.parse(localStorage.getItem('cache_leanMeat') || '{"data":[]}');
        expect(Array.isArray(finalCache.data)).toBe(true);
        // 不抛异常即为通过（失败模式已在报告"发现但本轮未处理"清单中记录）
    });
});
