/**
 * 第六轮·检查项 1 · 多标签页并发刷新与误吊销（方案 A：双实例模拟双标签页）
 *
 * 模拟方法论（为什么这样模拟）：
 *   jsdom 是单一 JS 上下文，无法创建真正的两个浏览器标签页。但"标签页"对本问题
 *   的本质影响只有两点：① 各自独立的 JS 内存（模块/实例状态不共享）；② 共享同源
 *   localStorage。因此用【同一测试内的两个独立 AuthService 实例】精确对应 ①
 *   （每个真实标签页里 authService 单例的全部可变状态都在实例字段上，无模块级
 *   可变共享态——已核实），用 jsdom 全局 localStorage 对应 ②。
 *   已知保真度损失（明确声明）：
 *   - jsdom 的 sessionStorage 也是全局共享的，而真实浏览器中 sessionStorage 每
 *     标签页独立。对「复制标签页」场景（Chrome/Edge/Safari 复制标签页会复制
 *     sessionStorage）这反而是**精确模拟**；对「新开标签页」场景需在测试内手动
 *     清掉 sessionStorage 中的 refresh token 来模拟"B 标签页没有它"。
 *   - jsdom 不派发同文档 storage 事件 → 本套测试覆盖的是"事件丢失"的最坏情形，
 *     真实浏览器中 storage 事件只会让同步更快，不会更差。
 *   - jsdom 无 navigator.locks → 走 localStorage 回退锁路径。Web Locks 路径由
 *     浏览器保证原子性（规范行为），无法也无需在 jsdom 中验证。
 *
 * 后端契约（与 refreshConcurrencyBackend.test.js 实测一致）：
 *   - refresh token 一次性轮转；同一 token 二次使用：
 *     · 30s 宽限内（reason=rotated）→ 401 {code:'REFRESH_CONCURRENT'}，不吊销全会话；
 *     · 宽限外 → 判定重放，吊销全部会话。
 */

import { AuthService } from '../frontend/js/services/AuthService.js';

const OLD_JWT = 'oldA.oldB.oldC';
const RT1 = 'rt1a.rt1b.rt1c';

function jsonResponse(status, body = {}) {
    return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/**
 * 模拟后端 /refresh-token 的一次性轮转 + 30s 宽限语义：
 *   - 当前有效 refresh token 首次使用 → 200 新 token 对；
 *   - 已被使用过的 token 再次使用（宽限内）→ 401 {code:'REFRESH_CONCURRENT'}。
 */
function createRotatingBackend() {
    const state = { current: RT1, seq: 1, used: new Set() };
    const fetchMock = jest.fn(async (url, init) => {
        const rt = init && init.headers && init.headers['X-Refresh-Token'];
        if (state.used.has(rt)) {
            return jsonResponse(401, { error: 'concurrent rotation', code: 'REFRESH_CONCURRENT' });
        }
        if (rt !== state.current) return jsonResponse(401, { error: 'invalid refresh token' });
        state.used.add(rt);
        state.seq += 1;
        state.current = `rt${state.seq}a.rt${state.seq}b.rt${state.seq}c`;
        return jsonResponse(200, {
            token: `tok${state.seq}a.tok${state.seq}b.tok${state.seq}c`,
            expiresIn: 1800,
            refreshToken: state.current,
        });
    });
    fetchMock._state = state;
    return fetchMock;
}

// H1-ext / #6：登录/刷新成功后 AuthService 会 fire-and-forget 调用 /api/user/me 同步角色，
// 该额外请求不计入"刷新单飞"断言。这里只统计 /refresh-token 网络请求次数，精确保留
// single-flight（防并发重放误吊销）验证意图。
function countRefreshTokenCalls(fetchMock) {
    return fetchMock.mock.calls.filter(([url]) => String(url).includes('/refresh-token')).length;
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    jest.restoreAllMocks();
});

describe('检查项1 · 场景A：复制标签页（两标签页持同一 refresh token）并发刷新', () => {
    test('跨标签锁串行化：只发一次网络刷新，双方均成功且收敛到同一新 token，无人被登出', async () => {
        // 标签页 A：登录后持有临期 access token（60s < 5min 缓冲 → isTokenExpired=true）+ RT1
        const tabA = new AuthService('');
        tabA.saveToken(OLD_JWT, 60);
        tabA.saveRefreshToken(RT1);
        // 标签页 B：复制标签页 —— sessionStorage（含 RT1 与其保存时间戳）被浏览器一并复制。
        // jsdom 的共享 sessionStorage 恰好精确模拟这一点；B 的实例内存独立。
        const tabB = new AuthService('');

        const fetchMock = createRotatingBackend();
        window.fetch = fetchMock;

        // 两标签页"几乎同时"判定需要刷新（定时器/401 拦截器同拍触发）
        const [ra, rb] = await Promise.all([tabA.refreshToken(), tabB.refreshToken()]);

        expect(ra.success).toBe(true);
        expect(rb.success).toBe(true);
        // 核心断言 1：全程只发出一次 /refresh-token（锁 + 锁内双重检查生效）
        // 注：/api/user/me 角色同步请求不计入（见 countRefreshTokenCalls）
        expect(countRefreshTokenCalls(fetchMock)).toBe(1);
        // 核心断言 2：双方收敛到同一份新 token（输家采用共享副本而非自己刷新）
        expect(tabA.getToken()).toBe(tabB.getToken());
        expect(tabA.getToken()).toMatch(/^tok2/);
        // 核心断言 3：没有任何一方被 clearAuth（共享登录态完好）
        expect(localStorage.getItem('auth_token')).toMatch(/^tok2/);
    });

    test('输家的陈旧 refresh token 被主动丢弃（轮转信标），后续不会发出注定触发重放判定的请求', async () => {
        const tabA = new AuthService('');
        tabA.saveToken(OLD_JWT, 60);
        tabA.saveRefreshToken(RT1);
        const tabB = new AuthService('');

        const fetchMock = createRotatingBackend();
        window.fetch = fetchMock;

        await Promise.all([tabA.refreshToken(), tabB.refreshToken()]);
        // 输家（采用共享副本的一方）内存中的 RT1 已被丢弃——它再也不会拿 RT1 去刷新。
        // （赢家内存中是新 RT2；两者恰有一方 _memRefreshToken 为 null 或为新值，绝无 RT1 残留）
        expect(tabA._memRefreshToken).not.toBe(RT1);
        expect(tabB._memRefreshToken).not.toBe(RT1);
    });
});

describe('检查项1 · 场景B：普通新开标签页（B 无 refresh token，sessionStorage 独立为空）', () => {
    test('B 等待 A 刷新后采用共享新 token：一次网络请求，双方成功', async () => {
        const tabA = new AuthService('');
        tabA.saveToken(OLD_JWT, 60);
        tabA.saveRefreshToken(RT1); // A 内存持有 RT1
        const tabB = new AuthService('');
        // 模拟真实浏览器中 B 标签页的 sessionStorage 为空（新开标签页不复制 sessionStorage）
        sessionStorage.removeItem(tabB.refreshTokenKey);
        sessionStorage.removeItem(tabB.refreshSavedAtKey);
        tabB._memRefreshToken = null;
        tabB._refreshTokenSavedAt = 0;

        const fetchMock = createRotatingBackend();
        window.fetch = fetchMock;

        const [ra, rb] = await Promise.all([tabA.refreshToken(), tabB.refreshToken()]);
        expect(ra.success).toBe(true);
        expect(rb.success).toBe(true);
        expect(countRefreshTokenCalls(fetchMock)).toBe(1);
        expect(tabB.getToken()).toMatch(/^tok2/);
    });

    test('B 单独存在（无人能刷新）：优雅失败，不发请求、不核爆共享登录态（修复前会连累其他标签页）', async () => {
        const tabB = new AuthService('');
        tabB.saveToken(OLD_JWT, 60); // 只有临期 access token，无 refresh token
        sessionStorage.removeItem(tabB.refreshTokenKey);
        sessionStorage.removeItem(tabB.refreshSavedAtKey);
        tabB._memRefreshToken = null;

        const fetchMock = createRotatingBackend();
        window.fetch = fetchMock;

        const r = await tabB.refreshToken();
        expect(r.success).toBe(false);
        expect(countRefreshTokenCalls(fetchMock)).toBe(0);
        // 关键：失败不触发 clearAuth —— localStorage 中的共享 token 原样保留，
        // 持有 refresh token 的其他标签页仍可正常续期整个会话。
        expect(localStorage.getItem('auth_token')).toBe(OLD_JWT);
    });
});

describe('检查项1 · 场景C：层3 兜底——锁完全失效（微秒级双穿）时依赖后端宽限 + 采用恢复', () => {
    test('双方绕过锁直发（_doRefreshToken）：输家收到 REFRESH_CONCURRENT 后采用共享 token，最终双双成功', async () => {
        const tabA = new AuthService('');
        tabA.saveToken(OLD_JWT, 60);
        tabA.saveRefreshToken(RT1);
        const tabB = new AuthService('');
        // B 也持有 RT1（复制标签页），且刻意抹掉保存时间戳，使轮转信标预检失效——
        // 强制 B 把 RT1 发出去，命中后端二次使用判定（模拟锁被微秒级双穿的最坏情形）
        tabB._memRefreshToken = RT1;
        tabB._refreshTokenSavedAt = 0;

        const fetchMock = createRotatingBackend();
        window.fetch = fetchMock;

        const ra = await tabA._doRefreshToken(); // A 先完成轮转
        const rb = await tabB._doRefreshToken(); // B 拿旧 RT1 直发 → 401 REFRESH_CONCURRENT

        expect(ra.success).toBe(true);
        expect(rb.success).toBe(true);          // 输家未被登出：采用了 A 写入共享存储的新 token
        expect(rb.adopted).toBe(true);
        expect(countRefreshTokenCalls(fetchMock)).toBe(2);
        expect(tabB._memRefreshToken).toBeNull(); // 废 token 已丢弃
        expect(localStorage.getItem('auth_token')).toMatch(/^tok2/); // 会话完好
    });

    test('轮转信标预检：确认他人已轮转后零请求直接采用（连 401 都不会发生）', async () => {
        const tabA = new AuthService('');
        tabA.saveToken(OLD_JWT, 60);
        tabA.saveRefreshToken(RT1);
        const tabB = new AuthService('');
        // B 持有"保存于信标之前"的 RT1（复制标签页的真实语义：savedAt 随 sessionStorage 复制）。
        // 测试内 setup 与轮转发生在同一毫秒，会使 rotatedAt > savedAt 的严格比较边界失效；
        // 真实场景两者相隔分钟级——回拨 10s 还原真实时序。
        tabB._refreshTokenSavedAt = Date.now() - 10_000;

        const fetchMock = createRotatingBackend();
        window.fetch = fetchMock;

        await tabA._doRefreshToken(); // A 轮转成功，写入信标
        expect(countRefreshTokenCalls(fetchMock)).toBe(1);

        const rb = await tabB._doRefreshToken(); // B 预检发现信标晚于自己的 savedAt
        expect(rb.success).toBe(true);
        expect(rb.adopted).toBe(true);
        expect(countRefreshTokenCalls(fetchMock)).toBe(1); // B 一个字节都没发
    });
});

describe('检查项1 · 回退锁健壮性', () => {
    test('持锁标签页崩溃（锁未释放）：TTL 超时后其他标签页可抢占，不会永久死锁', async () => {
        const tab = new AuthService('');
        tab.saveToken(OLD_JWT, 60);
        tab.saveRefreshToken(RT1);
        // 伪造一个 11 秒前的死锁（> LOCK_TTL 10s）
        localStorage.setItem(tab.refreshLockKey, JSON.stringify({ id: 'dead_tab', ts: Date.now() - 11_000 }));

        const fetchMock = createRotatingBackend();
        window.fetch = fetchMock;

        const r = await tab.refreshToken();
        expect(r.success).toBe(true);
        expect(countRefreshTokenCalls(fetchMock)).toBe(1);
    });

    test('_adoptSharedToken 不采信与本地相同的副本（401 触发的真实刷新不被短路）', () => {
        const tab = new AuthService('');
        tab.saveToken(OLD_JWT, 1800);
        // 共享副本与本地内存是同一份（服务端刚拒绝过它）→ 不得当作"别人刷出的新 token"
        expect(tab._adoptSharedToken()).toBeNull();
    });
});
