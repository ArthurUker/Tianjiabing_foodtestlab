/**
 * 缺陷X（U4）· StorageService._updateLocalCache forceServer 参数回归测试（jsdom）
 *
 * 覆盖：
 *   1. 默认（forceServer 缺省/false）：pending merge 行为不变——本地 dirty 记录
 *      覆盖 incoming 服务端数据（离线保护语义保留，Q2 修复不回归）
 *   2. forceServer=true：跳过 pending merge，直接写入 incoming（服务端成功响应
 *      不再被本地旧 dirty 记录覆盖）
 */

import { StorageService } from '../frontend/js/core/Storage.js';

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

describe('缺陷X · _updateLocalCache forceServer 参数', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        localStorage.clear();
        sessionStorage.clear();
    });

    test('U4a · 默认（无 forceServer）：本地 dirty 记录保留，不被服务端数据覆盖（离线保护不回归）', () => {
        const storage = freshStorage();

        // 预置本地 dirty 记录（updating，含未上传的 result=合格）
        localStorage.setItem('cache_leanMeat', JSON.stringify({
            data: [{ id: 'rec1', version: 1, result: '合格', _status: 'updating' }]
        }));

        // 模拟服务端拉取到旧数据（result=不合格, version=2）
        const incoming = [{ id: 'rec1', version: 2, result: '不合格', _status: 'synced' }];
        storage._updateLocalCache(incoming); // 默认路径

        const cached = JSON.parse(localStorage.getItem('cache_leanMeat')).data;
        // 离线保护语义：本地 updating 记录保留（result 仍为'合格'，version 仍为 1）
        expect(cached[0].result).toBe('合格');
        expect(cached[0].version).toBe(1);
        expect(cached[0]._status).toBe('updating');
    });

    test('U4b · forceServer=true：跳过 pending merge，直接写入服务端数据', () => {
        const storage = freshStorage();

        // 预置本地 dirty 记录（updating）
        localStorage.setItem('cache_leanMeat', JSON.stringify({
            data: [{ id: 'rec1', version: 1, result: '合格', _status: 'updating' }]
        }));

        // 服务端成功响应（result=合格, version=3）
        const incoming = [{ id: 'rec1', version: 3, result: '合格', _status: 'synced' }];
        storage._updateLocalCache(incoming, { forceServer: true });

        const cached = JSON.parse(localStorage.getItem('cache_leanMeat')).data;
        // forceServer：服务端数据直接生效
        expect(cached[0].result).toBe('合格');
        expect(cached[0].version).toBe(3);
        expect(cached[0]._status).toBe('synced');
    });

    test('U4c · forceServer=true 对无本地记录的情况（新增）', () => {
        const storage = freshStorage();
        localStorage.setItem('cache_leanMeat', JSON.stringify({ data: [] }));

        storage._updateLocalCache([{ id: 'rec9', version: 1, result: '合格', _status: 'synced' }], { forceServer: true });
        const cached = JSON.parse(localStorage.getItem('cache_leanMeat')).data;
        expect(cached.length).toBe(1);
        expect(cached[0].id).toBe('rec9');
    });
});
