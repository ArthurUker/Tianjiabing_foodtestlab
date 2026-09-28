/**
 * StorageService._updateLocalCache forceServer 参数回归（jsdom）
 * —— P3-CONS-T01 按总控裁决更新（P3-PARALLEL-R1_REVIEW.md 收口清单 #3 / W4 未决 #1）
 *
 * 来源映射：本文件原为「缺陷X（U4）probe」。U4a/U4b/U4c 三个场景与断言语义**全部保留**
 * （pending-merge 离线保护 / forceServer 直写 / 新增路径）；唯一变化是键来源：
 * 旧全局键 `cache_<table>` → P3-W4-T01（AUD-001）作用域键 `cache_v2__<tenant>__<subjectHash>__<res>`
 * （经 StorageService#getStorageKeys() 同源的 SyncScope.resolveSyncScope()+buildScopedKeys() 派生；
 * 旧键已零双读，种子必须写入新键）。409 的新语义回归见 tests/storageApplyServerRecord.test.js
 * 与 backend/tests/sync/w4-*（w4-conflict-merge / w4-409-conflict-response）。
 */

import { StorageService } from '../frontend/js/core/Storage.js';
import { resolveSyncScope, buildScopedKeys } from '../frontend/js/core/SyncScope.js';

/** 当前测试作用域下的存储键（与 StorageService 构造内部同一派生源：SyncScope.buildScopedKeys）。 */
function scopedKeys() {
    return buildScopedKeys('leanMeat', resolveSyncScope());
}

function freshStorage() {
    localStorage.clear();
    sessionStorage.clear();
    return new StorageService('leanMeat', {
        apiBaseUrl: '/api/records',
        queueBatchDelayMs: 50,
        queueBatchSize: 5,
        minRetryDelayMs: 10,
        maxRetryDelayMs: 100,
    });
}

describe('StorageService._updateLocalCache forceServer 参数（键为 cache_v2 作用域键）', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
    });

    test('U4a · 默认（无 forceServer）：本地 dirty 记录保留，不被服务端数据覆盖（离线保护不回归）', () => {
        const KEYS = scopedKeys();
        const storage = freshStorage();

        // 预置本地 dirty 记录（updating，含未上传的 result=合格）
        localStorage.setItem(KEYS.cacheKey, JSON.stringify({
            data: [{ id: 'rec1', version: 1, result: '合格', _status: 'updating' }]
        }));

        // 模拟服务端拉取到旧数据（result=不合格, version=2）
        const incoming = [{ id: 'rec1', version: 2, result: '不合格', _status: 'synced' }];
        storage._updateLocalCache(incoming); // 默认路径

        const cached = JSON.parse(localStorage.getItem(KEYS.cacheKey)).data;
        // 离线保护语义：本地 updating 记录保留（result 仍为'合格'，version 仍为 1）
        expect(cached[0].result).toBe('合格');
        expect(cached[0].version).toBe(1);
        expect(cached[0]._status).toBe('updating');
    });

    test('U4b · forceServer=true：跳过 pending merge，直接写入服务端数据', () => {
        const KEYS = scopedKeys();
        const storage = freshStorage();

        // 预置本地 dirty 记录（updating）
        localStorage.setItem(KEYS.cacheKey, JSON.stringify({
            data: [{ id: 'rec1', version: 1, result: '合格', _status: 'updating' }]
        }));

        // 服务端成功响应（result=合格, version=3）
        const incoming = [{ id: 'rec1', version: 3, result: '合格', _status: 'synced' }];
        storage._updateLocalCache(incoming, { forceServer: true });

        const cached = JSON.parse(localStorage.getItem(KEYS.cacheKey)).data;
        // forceServer：服务端数据直接生效
        expect(cached[0].result).toBe('合格');
        expect(cached[0].version).toBe(3);
        expect(cached[0]._status).toBe('synced');
    });

    test('U4c · forceServer=true 对无本地记录的情况（新增）', () => {
        const KEYS = scopedKeys();
        const storage = freshStorage();
        localStorage.setItem(KEYS.cacheKey, JSON.stringify({ data: [] }));

        storage._updateLocalCache([{ id: 'rec9', version: 1, result: '合格', _status: 'synced' }], { forceServer: true });
        const cached = JSON.parse(localStorage.getItem(KEYS.cacheKey)).data;
        expect(cached.length).toBe(1);
        expect(cached[0].id).toBe('rec9');
    });
});
