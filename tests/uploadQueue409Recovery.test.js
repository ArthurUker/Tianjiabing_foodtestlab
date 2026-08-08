/**
 * 缺陷B（U1）· AdaptiveUploadQueue 409+GET失败场景下的死锁回归测试（jsdom）
 *
 * 覆盖：
 *   1. PUT 恒 409 且 _fetchLatest(GET 单条) 恒失败时：
 *      内层 3 次尝试耗尽 → reject 传播给 enqueue 调用方（Storage 层可收到 error）
 *   2. reject 之后 _isProcessing 必须复位为 false（否则后续 enqueue 被拦截 → 队列死锁）
 *   3. 死锁修复后：紧接的新 enqueue 能正常进入处理流程（_isProcessing 恢复工作）
 */

import { AdaptiveUploadQueue } from '../js/core/AdaptiveUploadQueue.js';

function jsonResponse(status, body = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        headers: { get: () => null },
    };
}

describe('缺陷B · AdaptiveUploadQueue 409 死锁回归', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
    });

    test('409 + GET失败：重试耗尽后 reject 且 _isProcessing 复位（不死锁）', async () => {
        // mock fetch：PUT 恒 409；GET 单条恒 500（_fetchLatest 失败）
        const fetchMock = jest.fn(async (url, opts = {}) => {
            const method = (opts.method || 'GET').toUpperCase();
            if (method === 'PUT') {
                return jsonResponse(409, { error: '版本冲突', serverVersion: 2, clientVersion: 1 });
            }
            // GET（_fetchLatest 内部拉取单条）→ 500
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

        // 第一次 enqueue：PUT 恒 409 且 GET 失败 → 内层 3 次尝试耗尽后 reject
        await expect(
            queue.enqueue('leanMeat', 'rec1', { version: 1, result: '合格' }, { method: 'PUT' })
        ).rejects.toMatchObject({ status: 409 });

        // 断言：reject 后 _isProcessing 复位（修复前会永久卡 true）
        expect(queue._isProcessing).toBe(false);

        // 断言：新的 enqueue 能被调度处理（修复前因 _isProcessing=true 永不 _scheduleNext → 死锁）
        const enqueue2 = queue.enqueue('leanMeat', 'rec2', { version: 1, result: '合格' }, { method: 'PUT' });
        // 修复后：第二个请求会进入处理并因 409 最终 reject；若死锁则 enqueue2 永远 pending
        await expect(enqueue2).rejects.toMatchObject({ status: 409 });

        // 两个不同 id 请求均被发出（说明队列在第一次 reject 后仍可处理新请求）
        // 注意：_fetchLatest 失败路径是"直接 reject 不重试"，故每次 enqueue = 1 PUT + 1 GET
        const putCalls = fetchMock.mock.calls.filter(([url, opts]) => (opts?.method || 'GET') === 'PUT');
        expect(putCalls.length).toBe(2); // rec1 1次 + rec2 1次
        expect(queue._isProcessing).toBe(false);
    });
});
