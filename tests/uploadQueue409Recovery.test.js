/**
 * 缺陷B（U1）· AdaptiveUploadQueue 409 恢复回归测试（jsdom）
 *
 * 覆盖：
 *   1. 409 响应携带 serverVersion 时：优先使用 serverVersion 重试（不依赖 GET），
 *      即使 GET 恒失败也能自愈（不再需要 GET 端点可用）。
 *   2. 409 无 serverVersion 且 _fetchLatest(GET 单条) 恒失败时：
 *      内层 3 次尝试耗尽 → reject 传播给 enqueue 调用方（Storage 层可收到 error）
 *   3. reject 之后 _isProcessing 必须复位为 false（否则后续 enqueue 被拦截 → 队列死锁）
 *   4. 死锁修复后：紧接的新 enqueue 能正常进入处理流程（_isProcessing 恢复工作）
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

describe('缺陷B · AdaptiveUploadQueue 409 恢复', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
    });

    test('409 携带 serverVersion：优先用它重试，GET 恒失败也能耗尽重试并复位 _isProcessing', async () => {
        // mock fetch：PUT 恒 409（响应体带 serverVersion）；GET 恒 500（_fetchLatest 失败）
        const fetchMock = jest.fn(async (url, opts = {}) => {
            const method = (opts.method || 'GET').toUpperCase();
            if (method === 'PUT') {
                return jsonResponse(409, { error: '版本冲突', serverVersion: 2, clientVersion: 1 });
            }
            // GET（_fetchLatest 内部拉取单条）→ 500，不应被依赖
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

        // 第一次 enqueue：PUT 恒 409 → 用 serverVersion 重试 3 次后 reject
        await expect(
            queue.enqueue('leanMeat', 'rec1', { version: 1, result: '合格' }, { method: 'PUT' })
        ).rejects.toMatchObject({ status: 409 });

        // 断言：reject 后 _isProcessing 复位（修复前会永久卡 true）
        expect(queue._isProcessing).toBe(false);

        // 断言：新的 enqueue 能被调度处理（修复前因 _isProcessing=true 永不 _scheduleNext → 死锁）
        const enqueue2 = queue.enqueue('leanMeat', 'rec2', { version: 1, result: '合格' }, { method: 'PUT' });
        // 修复后：第二个请求会进入处理并因 409 最终 reject；若死锁则 enqueue2 永远 pending
        await expect(enqueue2).rejects.toMatchObject({ status: 409 });

        // 每个 enqueue 最多 4 次 PUT 尝试（attempt 0→3），两个 enqueue 共 8 次 PUT、0 次 GET
        // （serverVersion 优先，重试不依赖 GET 端点）
        const putCalls = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET') === 'PUT');
        const getCalls = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET') === 'GET');
        expect(putCalls.length).toBe(8); // rec1 4次 + rec2 4次
        expect(getCalls.length).toBe(0); // serverVersion 优先，不再发 GET
        expect(queue._isProcessing).toBe(false);
    });

    test('409 无 serverVersion + GET 失败：重试耗尽后 reject 且 _isProcessing 复位（不死锁）', async () => {
        // mock fetch：PUT 恒 409（响应体不带 serverVersion）；GET 单条恒 500
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

        // 无 serverVersion → 409 时回退 _fetchLatest；GET 失败抛错 → catch 分支直接 reject，
        // 不重试（每次 enqueue = 1 次 PUT + 1 次 GET），两个 enqueue 共 2 次 PUT、2 次 GET
        const putCalls = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET') === 'PUT');
        const getCalls = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET') === 'GET');
        expect(putCalls.length).toBe(2); // rec1 1次 + rec2 1次
        expect(getCalls.length).toBe(2); // 每次 409 尝试一次 GET（均失败）
        expect(queue._isProcessing).toBe(false);
    });
});
