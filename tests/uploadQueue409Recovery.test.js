/**
 * AdaptiveUploadQueue 409 语义回归（jsdom）—— P3-CONS-T01 按总控裁决更新（P3-PARALLEL-R1_REVIEW.md 收口清单 #3）
 *
 * 来源映射（注释溯源，场景保留、断言反转为新语义）：
 *   · 本文件原为「缺陷B（U1）probe」：验证 409 重试后 _isProcessing 复位、队列不死锁 ——
 *     该死锁修复的**正式 regression 已由 P3-W4-T01 套件承接**（backend/tests/sync/w4-sync-state-machine.test.mjs
 *     与 w4-conflict-merge.test.mjs 的队列继续调度断言）。
 *   · P3-W4-T01（AUD-022）新语义：409 一律**不自动重放** —— 队列立即 reject（把 conflict/latest 原样上抛，
 *     由 Storage 的同步状态机做字段级三路合并或显式 CONFLICT 态），`_fetchLatest()`（409 后 GET 单条再重试）
 *     已整体移除；serverVersion 仅作为冲突信息解析透传，不再触发重试。
 *   · 因此原「serverVersion 优先重试 4 次 PUT / 无 serverVersion 回退 GET」的断言反转为：
 *     每个 enqueue 恰好 1 次 PUT、0 次 GET；_isProcessing 复位与不死锁语义保留不变。
 */

import { AdaptiveUploadQueue } from '../frontend/js/core/AdaptiveUploadQueue.js';

function jsonResponse(status, body = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        headers: { get: () => null },
    };
}

describe('AdaptiveUploadQueue · 409 不自动重放（P3-W4-T01 新语义；死锁修复不回退）', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
    });

    test('409 携带 serverVersion：立即 reject（不重试、不发 GET），_isProcessing 复位且队列继续调度', async () => {
        // mock fetch：PUT 恒 409（响应体带 serverVersion/latest —— 新协议的冲突信息）；GET 恒 500
        const fetchMock = jest.fn(async (url, opts = {}) => {
            const method = (opts.method || 'GET').toUpperCase();
            if (method === 'PUT') {
                return jsonResponse(409, { error: '版本冲突', code: 'VERSION_CONFLICT', serverVersion: 2, clientVersion: 1, latest: { id: 'rec1', version: 2 } });
            }
            // GET（旧 _fetchLatest 路径已移除）→ 500；若仍被调用即违反新语义
            return jsonResponse(500, {});
        });
        global.fetch = fetchMock;

        const queue = new AdaptiveUploadQueue({
            initialInterval: 10,   // 加速测试
            minInterval: 5,
            maxInterval: 100,
            maxConcurrent: 1,
            getHeaders: () => ({ 'Content-Type': 'application/json' }),
            getBaseUrl: () => '/api/records',
        });

        // 第一次 enqueue：PUT 409 → 立即 reject（冲突信息原样上抛，无重放）
        await expect(
            queue.enqueue('leanMeat', 'rec1', { version: 1, result: '合格' }, { method: 'PUT' })
        ).rejects.toMatchObject({ status: 409 });

        // 断言：reject 后 _isProcessing 复位（缺陷B修复不回退）
        expect(queue._isProcessing).toBe(false);

        // 断言：新的 enqueue 能被调度处理（不死锁），同样立即 reject
        const enqueue2 = queue.enqueue('leanMeat', 'rec2', { version: 1, result: '合格' }, { method: 'PUT' });
        await expect(enqueue2).rejects.toMatchObject({ status: 409 });

        // P3-W4-T01 新语义：409 不自动重放 → 每个 enqueue 恰好 1 次 PUT、0 次 GET
        // （serverVersion/latest 只是上抛的冲突信息，不再触发重试；旧断言为 8 次 PUT）
        const putCalls = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET') === 'PUT');
        const getCalls = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET') === 'GET');
        expect(putCalls.length).toBe(2); // rec1 1次 + rec2 1次
        expect(getCalls.length).toBe(0); // _fetchLatest 已移除，409 路径不发 GET
        expect(queue._isProcessing).toBe(false);
    });

    test('409 无 serverVersion：同样立即 reject（无 GET 回退），_isProcessing 复位（不死锁）', async () => {
        // mock fetch：PUT 恒 409（响应体不带 serverVersion —— 旧服务端兼容形态）；GET 单条恒 500
        const fetchMock = jest.fn(async (url, opts = {}) => {
            const method = (opts.method || 'GET').toUpperCase();
            if (method === 'PUT') {
                return jsonResponse(409, { error: '版本冲突' });
            }
            return jsonResponse(500, {});
        });
        global.fetch = fetchMock;

        const queue = new AdaptiveUploadQueue({
            initialInterval: 10,
            minInterval: 5,
            maxInterval: 100,
            maxConcurrent: 1,
            getHeaders: () => ({ 'Content-Type': 'application/json' }),
            getBaseUrl: () => '/api/records',
        });

        await expect(
            queue.enqueue('leanMeat', 'rec1', { version: 1, result: '合格' }, { method: 'PUT' })
        ).rejects.toMatchObject({ status: 409 });

        expect(queue._isProcessing).toBe(false);

        const enqueue2 = queue.enqueue('leanMeat', 'rec2', { version: 1, result: '合格' }, { method: 'PUT' });
        await expect(enqueue2).rejects.toMatchObject({ status: 409 });

        // P3-W4-T01 新语义：无 serverVersion 也不得回退 GET 拉取后重试（旧断言 2 PUT + 2 GET）
        // → 每个 enqueue 1 次 PUT、0 次 GET；冲突处置统一上抛给 Storage 状态机
        const putCalls = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET') === 'PUT');
        const getCalls = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET') === 'GET');
        expect(putCalls.length).toBe(2); // rec1 1次 + rec2 1次
        expect(getCalls.length).toBe(0); // 不再回退 GET（原断言为 2）
        expect(queue._isProcessing).toBe(false);
    });
});
