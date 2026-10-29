import { StorageService } from '../frontend/js/core/Storage.js';

function jsonResponse(status, body) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
    };
}

describe('StorageService.fetchPage 服务端分页', () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        delete global.fetch;
        localStorage.setItem('auth_token', 'header.payload.signature');
    });

    test('按 limit/offset/食堂/排序请求，并返回服务端真实总数', async () => {
        let requestedUrl = '';
        global.fetch = jest.fn(async (url) => {
            requestedUrl = String(url);
            return jsonResponse(200, {
                success: true,
                data: [
                    { id: 'r1', sampleId: 'S-1', canteen: '一食堂', testDate: '2026-10-28' },
                    { id: 'r2', sampleId: 'S-2', canteen: '一食堂', testDate: '2026-10-27' },
                ],
                total: 5829,
                limit: 2,
                offset: 20,
                hasMore: true,
                pagination: 'offset',
            });
        });
        const storage = new StorageService('pathogen', { apiBaseUrl: '/api/records' });

        const page = await storage.fetchPage({ limit: 2, offset: 20, canteen: '一食堂', sort: 'asc' });

        const url = new URL(requestedUrl, 'http://localhost');
        expect(url.pathname).toBe('/api/records/pathogen');
        expect(url.searchParams.get('limit')).toBe('2');
        expect(url.searchParams.get('offset')).toBe('20');
        expect(url.searchParams.get('canteen')).toBe('一食堂');
        expect(url.searchParams.get('sort')).toBe('asc');
        expect(page.total).toBe(5829);
        expect(page.hasMore).toBe(true);
        expect(page.records.map(record => record.id)).toEqual(['r1', 'r2']);
        expect(page.records[0]._status).toBe('synced');
    });

    test('未登录时不发请求并显式报错', async () => {
        localStorage.clear();
        global.fetch = jest.fn();
        const storage = new StorageService('pathogen', { apiBaseUrl: '/api/records' });

        await expect(storage.fetchPage({ limit: 10 })).rejects.toThrow('未登录');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('getCached 只读本地缓存，不触发同步请求', () => {
        global.fetch = jest.fn();
        const storage = new StorageService('pathogen', { apiBaseUrl: '/api/records' });
        localStorage.setItem(storage.localCacheKey, JSON.stringify({ data: [{ id: 'cached-1' }] }));

        expect(storage.getCached().map(record => record.id)).toEqual(['cached-1']);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
