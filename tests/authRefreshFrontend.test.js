/**
 * REG-2 · 前端 30m access token 自适应刷新回归测试（jsdom）
 *
 * 覆盖：
 *   1. refreshToken 单飞（single-flight）：并发调用只发一次 /refresh-token
 *      （后端 refresh 一次性轮转 + 重放检测，并发二次使用会被误判重放 → 全会话吊销）；
 *   2. 无 refresh token 时快速失败、不发请求（后端已移除 access-token fallback）；
 *   3. 401 拦截器：业务请求 401 → 静默刷新 → 用新 token 重放原请求；
 *   4. 拦截器护栏：刷新失败时透传原 401（不重试、不死循环）；auth 端点不拦截。
 */

// jsdom 环境可能无 Headers 实现，提供最小 polyfill（拦截器依赖 has/set）
if (typeof global.Headers === 'undefined') {
    global.Headers = class Headers {
        constructor(init = {}) {
            this._map = new Map();
            if (init instanceof Headers) {
                init._map.forEach((v, k) => this._map.set(k, v));
            } else if (init && typeof init === 'object') {
                for (const [k, v] of Object.entries(init)) this._map.set(k.toLowerCase(), String(v));
            }
        }
        has(k) { return this._map.has(String(k).toLowerCase()); }
        get(k) { return this._map.get(String(k).toLowerCase()) ?? null; }
        set(k, v) { this._map.set(String(k).toLowerCase(), String(v)); }
        forEach(cb) { this._map.forEach((v, k) => cb(v, k)); }
    };
}

import { AuthService, installAuthRefreshFetchInterceptor } from '../frontend/js/services/AuthService.js';

const FAKE_JWT = 'aaaa.bbbb.cccc';
const NEW_JWT = 'dddd.eeee.ffff';
const NEW_REFRESH = 'gggg.hhhh.iiii';

function jsonResponse(status, body = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
    };
}

function freshService() {
    localStorage.clear();
    sessionStorage.clear();
    const svc = new AuthService('');
    return svc;
}

beforeEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    delete window.__authRefreshFetchInstalled;
});

describe('REG-2 · refreshToken 单飞（防并发重放误吊销）', () => {
    test('并发两次 refreshToken 只发一次 /refresh-token 请求', async () => {
        const svc = freshService();
        svc.saveRefreshToken(FAKE_JWT);

        let resolveFetch;
        const fetchMock = jest.fn(() => new Promise((r) => { resolveFetch = r; }));
        window.fetch = fetchMock;

        const p1 = svc.refreshToken();
        const p2 = svc.refreshToken();
        // 第六轮：refreshToken 现经跨标签页锁（localStorage 回退锁含 ~20ms 确认等待），
        // fetch 不再同步发出——轮询等待首个请求出现后再断言单飞
        await new Promise((resolve) => {
            const poll = () => (fetchMock.mock.calls.length > 0 ? resolve() : setTimeout(poll, 10));
            poll();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][1].headers['X-Refresh-Token']).toBe(FAKE_JWT);

        resolveFetch(jsonResponse(200, { token: NEW_JWT, expiresIn: 1800, refreshToken: NEW_REFRESH }));
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.success).toBe(true);
        expect(r2.success).toBe(true);
        // 单飞释放后可再次刷新（非永久锁）
        expect(svc._refreshPromise).toBeNull();
    });

    test('无 refresh token → 快速失败且不发请求（fallback 已移除）', async () => {
        const svc = freshService();
        const fetchMock = jest.fn();
        window.fetch = fetchMock;

        const result = await svc.refreshToken();
        expect(result.success).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('刷新成功 → 新 access/refresh token 均落地', async () => {
        const svc = freshService();
        svc.saveRefreshToken(FAKE_JWT);
        window.fetch = jest.fn(async () =>
            jsonResponse(200, { token: NEW_JWT, expiresIn: 1800, refreshToken: NEW_REFRESH }));

        const result = await svc.refreshToken();
        expect(result.success).toBe(true);
        expect(svc.getToken()).toBe(NEW_JWT);
        expect(svc.getRefreshToken()).toBe(NEW_REFRESH);
    });

    test('刷新返回 401（refresh 失效/被吊销）→ 清理本地态，返回失败', async () => {
        const svc = freshService();
        svc.saveToken(FAKE_JWT, 1800);
        svc.saveRefreshToken(FAKE_JWT);
        window.fetch = jest.fn(async () => jsonResponse(401, { error: 'revoked' }));

        const result = await svc.refreshToken();
        expect(result.success).toBe(false);
        expect(svc.getToken()).toBeNull();
        expect(svc.getRefreshToken()).toBeNull();
    });
});

describe('REG-2 · 全局 401 拦截器（静默刷新 + 一次重放）', () => {
    test('业务请求 401 → 刷新成功 → 用新 token 重放原请求', async () => {
        const svc = freshService();
        svc.saveToken(FAKE_JWT, 1800);
        svc.saveRefreshToken(FAKE_JWT);

        const rawFetch = jest.fn()
            // 1) 原请求 → 401
            .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
            // 2) /refresh-token → 200
            .mockResolvedValueOnce(jsonResponse(200, { token: NEW_JWT, expiresIn: 1800, refreshToken: NEW_REFRESH }))
            // 3) 重放原请求 → 200
            .mockResolvedValueOnce(jsonResponse(200, { data: [] }));
        window.fetch = rawFetch;
        installAuthRefreshFetchInterceptor(svc);

        const resp = await window.fetch('/api/test-records', {
            headers: { Authorization: `Bearer ${FAKE_JWT}` },
        });

        expect(resp.status).toBe(200);
        expect(rawFetch).toHaveBeenCalledTimes(3);
        // 第 3 次调用（重放）必须携带新 token
        const retryHeaders = rawFetch.mock.calls[2][1].headers;
        expect(retryHeaders.get('Authorization')).toBe(`Bearer ${NEW_JWT}`);
    });

    test('刷新失败 → 透传原 401，不无限重试', async () => {
        const svc = freshService();
        svc.saveToken(FAKE_JWT, 1800);
        svc.saveRefreshToken(FAKE_JWT);

        const rawFetch = jest.fn()
            .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))   // 原请求
            .mockResolvedValueOnce(jsonResponse(401, { error: 'revoked' }));  // refresh 也 401
        window.fetch = rawFetch;
        installAuthRefreshFetchInterceptor(svc);

        const resp = await window.fetch('/api/test-records', {
            headers: { Authorization: `Bearer ${FAKE_JWT}` },
        });

        expect(resp.status).toBe(401);
        expect(rawFetch).toHaveBeenCalledTimes(2); // 无第三次（不重放、不循环）
    });

    test('auth 端点（refresh-token/login）401 不拦截（防递归）', async () => {
        const svc = freshService();
        svc.saveRefreshToken(FAKE_JWT);

        const rawFetch = jest.fn().mockResolvedValue(jsonResponse(401, { error: 'bad' }));
        window.fetch = rawFetch;
        installAuthRefreshFetchInterceptor(svc);

        const resp = await window.fetch('/api/user/refresh-token', {
            method: 'POST',
            headers: { Authorization: `Bearer ${FAKE_JWT}`, 'X-Refresh-Token': FAKE_JWT },
        });
        expect(resp.status).toBe(401);
        expect(rawFetch).toHaveBeenCalledTimes(1);
    });

    test('无 Authorization 头的请求不重放（如登录页公开请求）', async () => {
        const svc = freshService();
        svc.saveRefreshToken(FAKE_JWT);

        const rawFetch = jest.fn().mockResolvedValue(jsonResponse(401, { error: 'no auth' }));
        window.fetch = rawFetch;
        installAuthRefreshFetchInterceptor(svc);

        const resp = await window.fetch('/api/schools/config');
        expect(resp.status).toBe(401);
        expect(rawFetch).toHaveBeenCalledTimes(1);
    });
});
