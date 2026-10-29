import { StorageService } from '../frontend/js/core/Storage.js';

function quotaError() {
    const error = new Error('quota exceeded');
    error.name = 'QuotaExceededError';
    return error;
}

function makeStorage(config = {}) {
    return new StorageService('pathogen', {
        apiBaseUrl: '/api/records',
        cacheWriteBudgetBytes: 1200,
        cacheEmergencyBudgetBytes: 400,
        queueBatchDelayMs: 50,
        ...config,
    });
}

describe('StorageService localStorage 配额降级', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        delete global.fetch;
    });

    test('完整缓存超配额时只持久化最近子集，本次会话仍返回完整数据且不抛异常', () => {
        const storage = makeStorage();
        const rows = Array.from({ length: 30 }, (_, index) => ({
            id: `rec-${index}`,
            payload: 'x'.repeat(300),
            _status: 'synced',
        }));
        const originalSet = Storage.prototype.setItem;
        const setSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
            if (key === storage.localCacheKey && String(value).length > 5000) throw quotaError();
            return originalSet.call(this, key, value);
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => storage._updateLocalCache(rows, { forceServer: true })).not.toThrow();

        const persisted = JSON.parse(localStorage.getItem(storage.localCacheKey)).data;
        expect(persisted.length).toBeGreaterThan(0);
        expect(persisted.length).toBeLessThan(rows.length);
        expect(storage._getLocalCacheData()).toHaveLength(rows.length);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('配额不足');

        setSpy.mockRestore();
    });

    test('清理可重建缓存时保留 pending 队列与当前缓存，避免丢失待上传任务', () => {
        const storage = makeStorage();
        const otherCache = 'cache_v2__other__abc__pathogen';
        const otherQueue = 'pending_v2__other__abc__pathogen';
        const quarantine = 'legacy_quarantine_v1__cache_old';
        localStorage.setItem(otherCache, 'cached');
        localStorage.setItem(otherQueue, 'queued');
        localStorage.setItem(quarantine, 'legacy');

        const result = storage._evictReclaimableCacheKeys();

        expect(result.removed).toBe(2);
        expect(localStorage.getItem(otherCache)).toBeNull();
        expect(localStorage.getItem(quarantine)).toBeNull();
        expect(localStorage.getItem(otherQueue)).toBe('queued');
        expect(localStorage.getItem(storage.localCacheKey)).not.toBeNull();
    });

    test('队列写入配额失败时保留内存队列，当前会话仍可继续上传', () => {
        const storage = makeStorage();
        const items = [{ id: 'req-1', type: 'create', recordId: 'temp-1', data: { result: '合格' } }];
        const originalSet = Storage.prototype.setItem;
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
            if (key === storage.pendingRequestsKey) throw quotaError();
            return originalSet.call(this, key, value);
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => storage._setPendingRequests(items)).not.toThrow();
        expect(storage._getPendingRequests()).toEqual(items);
        expect(warn.mock.calls.some(([message]) => String(message).includes('待上传队列暂存'))).toBe(true);
    });

    test('存储已满时构造函数本身也不抛出配额异常', () => {
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw quotaError();
        });
        jest.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => makeStorage()).not.toThrow();
    });
});
