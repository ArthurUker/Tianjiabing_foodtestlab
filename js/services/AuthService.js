/**
 * AuthService - 用户认证服务
 * 处理登录、登出、Token 管理、权限验证等
 */

import { auditService } from './AuditService.js';
import { maskSensitive } from '../utils/fieldMasking.js';
// TD-TenantIsolation：引入租户标识，用于认证态 key 的命名空间隔离
import { extractSchoolCode } from '../utils/schoolCode.js';
// REG-02/NB-05: 导入 permissionService 以便 clearAuth 清除权限缓存
import { permissionService } from './PermissionService.js';

// DS-17: JWT 形态校验（三段 base64url）。读取处统一校验，
// 拒绝被篡改/注入的非 JWT 值，降低脏数据与 token 固定风险。
function isPlausibleJwt(token) {
    return typeof token === 'string'
        && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export class AuthService {
    constructor(apiBaseUrl = '') {
        this.apiBaseUrl = apiBaseUrl || '';
        this.tokenKey = 'auth_token';
        this.userKey = 'current_user';
        this.tokenExpiryKey = 'token_expiry';
        this.refreshTokenKey = 'refresh_token';
        // —— 第六轮（多标签页并发刷新防误吊销）新增共享协调键（均落 localStorage，同源共享）——
        this.tokenUpdatedAtKey = 'auth_token_updated_at';     // 共享 access token 最近一次写入时间
        this.refreshRotatedAtKey = 'auth_refresh_rotated_at'; // 任一标签页最近一次成功轮转 refresh 的时间（信标）
        this.refreshLockKey = 'auth_refresh_lock';            // 跨标签页刷新锁（Web Locks 不可用时的回退）
        this.refreshSavedAtKey = 'refresh_token_saved_at';    // 本标签页 refresh token 的保存时间（sessionStorage，随复制标签页一起被复制）

        // TD-TenantIsolation：租户命名空间隔离，根治「同一浏览器不同窗口开不同学校时
        // token 串租户」。浏览器 localStorage/sessionStorage 按「同源」共享、不按租户隔离，
        // 原先所有租户共用裸 key（auth_token / current_user），窗口 A（学校 A）登录后写入的
        // token 会被窗口 B（学校 B）以同一裸 key 读出 → 用错租户的 token 验证。
        // 解决方案：把认证态 key 加上 schoolCode 命名空间前缀（auth_token__<schoolCode>），
        // 不同学校的 key 互不可见，自然隔离。无 schoolCode（dev/test 共享 schema）时退化为
        // 裸 key，保持旧行为。
        this._ns = extractSchoolCode() || '';

        // DS-17: 内存态 token 作为第一优先读取源（XSS 需精确命中该实例才能读到）。
        // sessionStorage 为第二优先（页面关闭即清）；localStorage 仅作兼容层保留——
        // Storage.js / BackupRestore.js / AuditService.js / Router.js（storage 事件跨标签登出）
        // 等现有使用方直接读 localStorage['auth_token']，本窗口不允许改动它们，故不能移除。
        this._memToken = null;
        this._memRefreshToken = null;

        // REG-2: 刷新单飞（single-flight）——并发 401/定时器同时触发刷新时只发一次
        // /refresh-token 请求。后端 refresh token 为一次性轮转 + 重放检测（二次使用
        // 同一 refresh token 会吊销该用户全部会话），并发刷新会被误判为重放，必须串行化。
        // ⚠️ 单飞只覆盖【同一标签页】：每个标签页是独立 JS 运行时，_refreshPromise
        // 不跨标签共享。跨标签页串行化由 _refreshWithCrossTabLock（Web Locks / localStorage 锁）
        // + 共享 token 采用（_adoptSharedToken）+ 轮转信标（refreshRotatedAtKey）三层实现。
        this._refreshPromise = null;

        // 第六轮：跨标签页协调所需的实例态
        this._tabId = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        this._memTokenUpdatedAt = 0;      // 本实例内存 token 对应的共享写入时间戳
        this._refreshTokenSavedAt = this._loadRefreshSavedAt(); // 本标签页 refresh token 的保存时间

        this._installCrossTabTokenSync();

        // 初始化时检查是否已登录
        this.init();
    }

    /**
     * 返回带租户命名空间的存储 key。
     * @param {string} base 裸 key（如 'auth_token'）
     * @returns {string} 命名空间化 key（如 'auth_token__demo'），无租户时原样返回
     */
    _nsKey(base) {
        return this._ns ? `${base}__${this._ns}` : base;
    }

    /**
     * P0-1C 设备指纹：生成/读取本设备的持久化标识（UA 特征 + 随机 ID），
     * 用于「记住我」refresh token 的同设备绑定——被 XSS 窃取的 refresh token
     * 在【其他设备/浏览器】上无法兑换新 access token（缓解 DS-17 风险）。
     * 存储：cookie（7 天，与 refresh TTL 对齐）+ localStorage 兜底。
     * @returns {string} deviceId（形如 dev_<12位随机>）
     */
    _getOrCreateDeviceId() {
        try {
            const cookieKey = 'foodtestlab_dev_id';
            const match = document.cookie.split('; ').find((c) => c.startsWith(cookieKey + '='));
            if (match) return decodeURIComponent(match.split('=').slice(1).join('='));
        } catch (e) { /* cookie 不可用则走 localStorage */ }
        try {
            const lsKey = this._nsKey('device_id');
            const cached = localStorage.getItem(lsKey);
            if (cached) return cached;
        } catch (e) { /* 忽略 */ }
        const deviceId = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        try {
            const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent.slice(0, 80) : 'unknown';
            const uaHash = ua.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
            // 以 UA 哈希作为设备特征码的一部分，同一浏览器不同用户仍共享同一 cookie ID
            document.cookie = `foodtestlab_dev_id=${encodeURIComponent(deviceId + '_' + Math.abs(uaHash))}; path=/; max-age=${7 * 24 * 3600}; SameSite=Lax`;
        } catch (e) { /* 忽略 */ }
        try {
            localStorage.setItem(this._nsKey('device_id'), deviceId);
        } catch (e) { /* 忽略 */ }
        return deviceId;
    }

    /**
     * P0-1C：登录/刷新请求统一附加设备指纹头，后端据此校验「记住我」refresh 的同设备绑定。
     * @returns {string|null} 无 DOM（非浏览器环境/测试）时返回 null，不附加
     */
    _getDeviceHeader() {
        try {
            if (typeof document === 'undefined') return null;
            return this._getOrCreateDeviceId();
        } catch (e) {
            return null;
        }
    }

    /**
     * 第六轮：监听同源其他标签页写入的新 access token（storage 事件仅在"其他"
     * 标签页触发，本标签页自身写入不触发），即时更新内存副本。
     * 兜底：即使事件丢失（后台节流等），getToken()/_adoptSharedToken() 的
     * 时间戳比对也会在下次读取时完成同步。
     */
    _installCrossTabTokenSync() {
        // 不再自动从其他标签页采纳 token（避免跨标签页认证污染）。
        // sessionStorage 已确保每个标签页拥有独立认证态。
        // localStorage 保留仅用于兼容旧模块，不作为跨标签同步依据。
    }

    _loadRefreshSavedAt() {
        try {
            const v = Number(sessionStorage.getItem(this.refreshSavedAtKey));
            return Number.isFinite(v) && v > 0 ? v : 0;
        } catch (e) { return 0; }
    }

    /**
     * 第六轮：采用其他标签页轮转后写入共享存储（localStorage）的新 access token。
     * 仅当共享副本的写入时间戳【严格新于】本实例内存副本时才采信
     * （保持 DS-17 的"不盲信 localStorage"口径：旧值/被回滚的值不覆盖内存态）。
     * @returns {string|null} 采用成功返回新 token，否则 null
     */
    _adoptSharedToken() {
        try {
            const shared = localStorage.getItem(this._nsKey(this.tokenKey));
            if (!isPlausibleJwt(shared)) return null;
            // 与本地持有的是同一份 → 没有"别人刷出的新 token"可采用。
            // ⚠️ 不能返回该 token：401 触发的刷新走到这里时，服务端已拒绝这份 token，
            // 若把它当"已被其他标签页刷新"返回成功，会短路掉真正必需的网络刷新。
            if (shared === this._memToken) return null;
            const updatedAt = Number(localStorage.getItem(this._nsKey(this.tokenUpdatedAtKey))) || 0;
            if (updatedAt <= this._memTokenUpdatedAt) return null;
            this._memToken = shared;
            this._memTokenUpdatedAt = updatedAt;
            try { sessionStorage.setItem(this._nsKey(this.tokenKey), shared); } catch (e) { /* 存储不可用时忽略 */ }
            return shared;
        } catch (e) {
            return null;
        }
    }

    /**
     * 第六轮：丢弃本标签页持有的 refresh token（已被其他标签页轮转，再用必触发重放判定）。
     * 只清本标签页私有副本（内存 + sessionStorage），不动共享的 access token。
     */
    _discardRefreshToken() {
        this._memRefreshToken = null;
        this._refreshTokenSavedAt = 0;
        try {
            sessionStorage.removeItem(this.refreshTokenKey);
            sessionStorage.removeItem(this.refreshSavedAtKey);
        } catch (e) { /* 存储不可用时忽略 */ }
    }

    /**
     * 初始化 - 检查已保存的 Token 和用户信息
     */
    init() {
        const token = this.getToken();
        const user = this.getUser();
        
        if (token && user) {
            // 检查 Token 是否过期
            if (this.isTokenExpired()) {
                // REG-2: access TTL 缩短为 30m 后，「临期」是常态而非异常。
                // 有 refresh token 时先尝试静默续期，不再直接清除登录态（否则连
                // refresh token 一起被 clearAuth 清掉，用户被迫重新登录）。
                if (this.getRefreshToken()) {
                    console.log('🔄 Token 临期，尝试静默续期...');
                    this.refreshToken().catch(() => { /* 失败由调用方/Router 统一处理 */ });
                } else {
                    console.warn('⚠️ Token 已过期且无刷新令牌，清除本地存储');
                    this.clearAuth();
                }
            } else {
                // DS-16: 日志不输出完整用户名（PII 脱敏）
                console.log('✅ 用户已登录:', maskSensitive(user.username, 'name'));
            }
        }
    }

    /**
     * 登录 API 调用
     * @param {string} username - 用户名
     * @param {string} password - 密码
     * @param {string} [schoolCode] - 所属学校代码（方案A：来自 URL 路径前缀；schoolCode 即 schema 名，用于在登录前定位该校 schema）
     * @param {boolean} [rememberMe] - 记住我：true 持久化到 localStorage（关浏览器重开保持登录）；false 仅 sessionStorage（关闭即登出）
     * @returns {Promise<{success: boolean, user?: object, token?: string, message?: string}>}
     */
    async login(username, password, schoolCode = null, rememberMe = true) {
        try {
            // 输入验证
            if (!username || !password) {
                throw new Error('用户名和密码不能为空');
            }

            // 调用后端登录 API（schoolCode 一并上报，供后端路由到对应 schema）
            // P0-1C: 附加设备指纹头，后端写入 refresh token payload 完成同设备绑定
            const deviceHeader = this._getDeviceHeader();
            const response = await fetch(`${this.apiBaseUrl}/api/user/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(deviceHeader ? { 'X-Device-Id': deviceHeader } : {})
                },
                body: JSON.stringify({ username, password, schoolCode })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || data.error || '登录失败');
            }

            if (data.success && data.token) {
                // 🎯 在登录前清除所有访客信息（切换身份）
                // TD-TenantIsolation：按当前学校命名空间清除（与 GuestAuthService._nsKey 一致），避免残留访客令牌被早期拦截误领养
                console.log('🔧 清除访客信息，准备以管理员身份登录...');
                localStorage.removeItem(this._nsKey('current_guest'));
                localStorage.removeItem(this._nsKey('guest_token'));
                localStorage.removeItem(this._nsKey('is_quick_access'));
                sessionStorage.removeItem(this._nsKey('current_guest'));
                sessionStorage.removeItem(this._nsKey('guest_token'));
                
                // 保存 Token 和用户信息（P0-1: rememberMe 决定持久化层级）
                this.saveToken(data.token, data.expiresIn, rememberMe);
                this.saveUser(data.user, rememberMe);
                
                // 如果返回了 refresh token，也保存（rememberMe=true 时持久化以支持跨浏览器会话续期）
                if (data.refreshToken) {
                    this.saveRefreshToken(data.refreshToken, rememberMe);
                }

                // DS-16 & M3: 日志不输出完整用户名（PII 脱敏），审计日志同样脱敏
                console.log('✅ 登录成功:', maskSensitive(data.user.username, 'name'));
                auditService.log('login', 'auth', null, `用户 ${maskSensitive(data.user.username, 'name')} 登录系统`);
                return { success: true, user: data.user };
            } else {
                throw new Error(data.message || '登录失败');
            }
        } catch (error) {
            console.error('❌ 登录错误:', error.message);
            return { 
                success: false, 
                message: error.message 
            };
        }
    }

    /**
     * 平台超管登录（独立入口，区别于普通用户登录）
     * @param {string} username - 平台超管用户名
     * @param {string} password - 密码
     * @param {boolean} [rememberMe] - 记住我：true 持久化；false 仅会话级
     * @returns {Promise<{success: boolean, user?: object, message?: string}>}
     */
    async loginSuperAdmin(username, password, rememberMe = true) {
        try {
            if (!username || !password) {
                throw new Error('用户名和密码不能为空');
            }

            // P0-1C: 超管登录同样附加设备指纹
            const deviceHeader = this._getDeviceHeader();
            const response = await fetch(`${this.apiBaseUrl}/api/user/super-admin/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(deviceHeader ? { 'X-Device-Id': deviceHeader } : {})
                },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || data.message || '登录失败');
            }

            if (data.success && data.token) {
                // 切换身份前清除所有访客信息
                localStorage.removeItem('current_guest');
                localStorage.removeItem('guest_token');
                localStorage.removeItem('is_quick_access');
                sessionStorage.removeItem('current_guest');
                sessionStorage.removeItem('guest_token');

                this.saveToken(data.token, data.expiresIn, rememberMe);
                this.saveUser(data.user, rememberMe);
                if (data.refreshToken) this.saveRefreshToken(data.refreshToken, rememberMe);

                console.log('✅ 平台超管登录成功:', maskSensitive(data.user.username, 'name'));
                auditService.log('login', 'auth', null, `平台超管 ${maskSensitive(data.user.username, 'name')} 登录系统`);
                return { success: true, user: data.user };
            } else {
                throw new Error(data.message || '登录失败');
            }
        } catch (error) {
            console.error('❌ 平台超管登录错误:', error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * 登出
     */
    async logout() {
        try {
            const token = this.getToken();
            
            // 调用后端登出 API (可选，主要用于服务器端清理)
            if (token) {
                await fetch(`${this.apiBaseUrl}/api/user/logout`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }).catch(err => {
                    // 即使 API 调用失败也要清除本地认证信息
                    console.warn('⚠️ 登出 API 调用失败:', err.message);
                });
            }

            // 清除本地认证信息
            this.clearAuth();
            auditService.log('logout', 'auth', null, '用户登出系统');
            console.log('✅ 已登出');
            return { success: true };
        } catch (error) {
            console.error('❌ 登出错误:', error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * 注册新用户 (管理员功能)
     * @param {object} userData - 用户数据 {username, phone, password, fullName}
     * @returns {Promise<{success: boolean, message: string, user?: object}>}
     */
    async registerUser(userData) {
        try {
            const { username, phone, password, fullName, role } = userData;

            if (!username || !password) {
                throw new Error('用户名和密码是必填项');
            }

            // TD-Username-Rule-Inconsistent: 与后端 UserManager / validationMiddleware 对齐，提前给出反馈
            if (!/^[a-zA-Z0-9_]{3,50}$/.test(username)) {
                throw new Error('用户名需为 3-50 位字母、数字或下划线');
            }

            // P14: 前端密码强度预校验(与后端 isStrongPassword 一致,减少无效请求)
            if (!/^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(password)) {
                throw new Error('密码至少 8 个字符，且必须包含字母和数字');
            }

            const response = await fetch(`${this.apiBaseUrl}/api/user/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getToken()}`
                },
                body: JSON.stringify({ username, phone, password, fullName, role })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || data.message || '注册失败');
            }

            // DS-16: 日志不输出完整用户名（PII 脱敏）
            console.log('✅ 用户注册成功:', maskSensitive(username, 'name'));
            return { success: true, user: data.user };
        } catch (error) {
            console.error('❌ 注册错误:', error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * Token 刷新 (自动续期)
     * REG-2: 单飞包装——并发调用共享同一请求，防止一次性轮转的 refresh token
     * 被并发二次使用而触发后端重放检测（全会话吊销）。
     * @returns {Promise<{success: boolean, token?: string}>}
     */
    async refreshToken() {
        if (this._refreshPromise) return this._refreshPromise;
        this._refreshPromise = this._refreshWithCrossTabLock().finally(() => {
            this._refreshPromise = null;
        });
        return this._refreshPromise;
    }

    /**
     * 第六轮：跨标签页刷新协调（三层防线）。
     *
     * 层 1 —— 跨标签互斥锁：优先 Web Locks API（navigator.locks.request：浏览器
     *   锁管理器级原子互斥，同源全标签页串行，无竞争窗口）；不支持时回退
     *   localStorage 自旋锁（写入 tabId+时间戳 → 等待一拍 → 复读校验；
     *   check-then-set 非原子，存在毫秒级竞争窗口——见层 3 兜底）。
     * 层 2 —— 锁内双重检查（double-checked）：拿到锁后先看其他标签页是否已把
     *   新 token 写进共享存储（_adoptSharedToken + isTokenExpired 复查 +
     *   轮转信标比对）。是 → 直接采用，不发网络请求，本标签页手中已被轮转的
     *   旧 refresh token 同时丢弃（再用必触发后端重放判定）。
     * 层 3 —— 后端宽限协同：即使层 1/2 全部失守（localStorage 锁的毫秒级竞争
     *   窗口被命中），后端对「30s 宽限期内的并发轮转竞争」不再核爆全会话，仅
     *   拒绝输家（401 + code REFRESH_CONCURRENT）；本方法收到该 code 后采用
     *   共享新 token 返回成功。→ 灾难性结果（全端登出）被完全消除。
     */
    async _refreshWithCrossTabLock() {
        const hasWebLocks = typeof navigator !== 'undefined'
            && navigator.locks
            && typeof navigator.locks.request === 'function';

        if (hasWebLocks) {
            // Web Locks：原子互斥，锁随标签页崩溃自动释放，无需 TTL
            return navigator.locks.request('foodtestlab_token_refresh', () => this._refreshLocked());
        }
        // 回退：localStorage 自旋锁（jsdom/旧浏览器）
        const acquired = await this._acquireStorageLock();
        try {
            return await this._refreshLocked();
        } finally {
            if (acquired) this._releaseStorageLock();
        }
    }

    /**
     * localStorage 回退锁：写入 { id, ts } → 等待 20ms → 复读确认仍是自己。
     * 已有未超时的他人锁 → 轮询等待其释放（最长 ~6s，覆盖一次慢刷新），
     * 等待期间若共享存储已出现新 token 则直接放弃拿锁（走锁内双重检查采用）。
     * 锁 TTL 10s：持锁标签页崩溃/被杀后其余标签页可抢占，不会永久死锁。
     * 注意：该锁的 check-then-set 非原子，理论上存在毫秒级双持有窗口——
     * 这是「大幅降低概率」而非「100% 消除」；100% 消除由 Web Locks（支持的浏览器）
     * 与后端 REFRESH_CONCURRENT 宽限（所有环境）共同保证。
     */
    async _acquireStorageLock() {
        const LOCK_TTL = 10_000;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const deadline = Date.now() + 6_000;
        try {
            for (;;) {
                let cur = null;
                try { cur = JSON.parse(localStorage.getItem(this._nsKey(this.refreshLockKey)) || 'null'); } catch (e) { cur = null; }
                const now = Date.now();
                if (!cur || !cur.ts || (now - cur.ts) > LOCK_TTL) {
                    localStorage.setItem(this._nsKey(this.refreshLockKey), JSON.stringify({ id: this._tabId, ts: now }));
                    await sleep(20); // 等一拍再复读，缩小 check-then-set 竞争窗口
                    let after = null;
                    try { after = JSON.parse(localStorage.getItem(this._nsKey(this.refreshLockKey)) || 'null'); } catch (e) { after = null; }
                    if (after && after.id === this._tabId) return true;
                    // 被并发覆盖 → 对方持锁，继续等待
                }
                if (Date.now() > deadline) return false; // 超时放弃等锁：让层 2/层 3 兜底
                if (this._adoptSharedToken() && !this.isTokenExpired()) return false; // 别人已刷好，无需拿锁
                await sleep(100);
            }
        } catch (e) {
            return false; // 存储不可用：退化为无锁（层 3 后端宽限兜底）
        }
    }

    _releaseStorageLock() {
        try {
            const cur = JSON.parse(localStorage.getItem(this._nsKey(this.refreshLockKey)) || 'null');
            if (cur && cur.id === this._tabId) localStorage.removeItem(this._nsKey(this.refreshLockKey));
        } catch (e) { /* 忽略 */ }
    }

    /**
     * 持锁状态下的刷新主体：先双重检查（他人已刷好则采用），再决定是否真正发起网络刷新。
     */
    async _refreshLocked() {
        // —— 锁内双重检查 ——
        const adopted = this._adoptSharedToken();
        if (adopted && !this.isTokenExpired()) {
            // 其他标签页已完成轮转：若本标签页 refresh token 早于最近一次轮转信标，
            // 它已在服务端被标记 rotated，再使用必触发重放判定 → 主动丢弃。
            const rotatedAt = Number(localStorage.getItem(this._nsKey(this.refreshRotatedAtKey))) || 0;
            if (this._refreshTokenSavedAt && rotatedAt > this._refreshTokenSavedAt) {
                this._discardRefreshToken();
            }
            console.log('✅ Token 已由其他标签页刷新，直接采用共享副本');
            return { success: true, token: adopted, adopted: true };
        }
        return this._doRefreshToken();
    }

    async _doRefreshToken() {
        try {
            // 第六轮：若本标签页 refresh token 已确认被其他标签页轮转（信标晚于保存时间），
            // 发出去必被判定二次使用——直接丢弃并尝试采用共享 token，不发注定失败的请求。
            const rotatedAt = Number(localStorage.getItem(this._nsKey(this.refreshRotatedAtKey))) || 0;
            if (this._refreshTokenSavedAt && rotatedAt > this._refreshTokenSavedAt) {
                this._discardRefreshToken();
                const shared = this._adoptSharedToken();
                if (shared && !this.isTokenExpired()) {
                    return { success: true, token: shared, adopted: true };
                }
            }

            const refreshToken = this.getRefreshToken();

            // DS3-H1: 后端已移除 access-token fallback（旧 fallback 允许 access token
            // 无限自续期）；无 refresh token 时刷新必然 401。
            // 第六轮：失败前最后尝试采用共享 token（新开标签页无 sessionStorage refresh token，
            // 但其他标签页可能持续续期——不能因本标签页无 refresh 能力就宣告会话失效）。
            if (!refreshToken) {
                const shared = this._adoptSharedToken();
                if (shared && !this.isTokenExpired()) {
                    return { success: true, token: shared, adopted: true };
                }
                throw new Error('没有可用的刷新令牌，请重新登录');
            }

            // P0-1C: 刷新时附加设备指纹，后端比对 refresh token payload 中的绑定设备
            const deviceHeader = this._getDeviceHeader();
            const headers = {
                'Content-Type': 'application/json',
                'X-Refresh-Token': refreshToken,
                ...(deviceHeader ? { 'X-Device-Id': deviceHeader } : {})
            };

            const response = await fetch(`${this.apiBaseUrl}/api/user/refresh-token`, {
                method: 'POST',
                headers
            });

            const data = await response.json().catch(() => ({}));

            // 第六轮（层 3）：并发轮转竞争输家——本标签页的 refresh token 刚被其他
            // 标签页/请求用掉（后端 30s 宽限内不核爆）。丢弃已废 token，采用共享新 token。
            if (response.status === 401 && data && data.code === 'REFRESH_CONCURRENT') {
                console.warn('⚠️ 刷新竞争：token 已在其他窗口轮转，采用共享副本');
                this._discardRefreshToken();
                const shared = this._adoptSharedToken();
                if (shared && !this.isTokenExpired()) {
                    return { success: true, token: shared, adopted: true };
                }
                // 共享副本尚未写入（赢家还没落库到 localStorage）：短暂等待一次再取
                await new Promise(r => setTimeout(r, 300));
                const retryShared = this._adoptSharedToken();
                if (retryShared && !this.isTokenExpired()) {
                    return { success: true, token: retryShared, adopted: true };
                }
                throw new Error('Token 已在其他窗口刷新，请稍后重试');
            }

            // 凭证失效（401/403）：必须重新登录，清理本地态
            if (response.status === 401 || response.status === 403) {
                this.clearAuth();
                throw new Error('登录已失效，请重新登录');
            }

            // 服务器错误（5xx 等）：保留本地认证态，避免误踢下线
            if (!response.ok) {
                throw new Error(data.error || 'Token 刷新失败，请稍后重试');
            }

            // 更新 Token（新后端可能一并下发 refresh token）
            if (data.token) {
                this.saveToken(data.token, data.expiresIn);
            }
            if (data.refreshToken) {
                this.saveRefreshToken(data.refreshToken);
                // 第六轮：写轮转信标——通知（并留证给）其他标签页：旧 refresh token 已作废。
                // 持有更早 refresh token 的标签页据此主动丢弃，不再发出注定触发重放判定的请求。
                try { localStorage.setItem(this._nsKey(this.refreshRotatedAtKey), String(Date.now())); } catch (e) { /* 忽略 */ }
            }

            console.log('✅ Token 已刷新');
            return { success: true, token: data.token };
        } catch (error) {
            console.error('❌ Token 刷新错误:', error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取当前 Token
     * DS-17: 读取优先级 内存 → sessionStorage → localStorage（兼容层/跨标签同步），
     * 每层读取均做 JWT 形态校验；命中低优先级源时回填高优先级源。
     * @returns {string|null}
     */
    getToken() {
        // 优先返回内存态（本实例已缓存的 token）
        if (isPlausibleJwt(this._memToken)) return this._memToken;

        // 主存储：sessionStorage（标签页独立，不受其他标签页登录/登出影响）
        // TD-TenantIsolation：所有读取均走 _nsKey(...) 命名空间 key，因此即使 localStorage
        // 是同源共享，本窗口（学校 B）也只命中 auth_token__schoolB，绝不会读到窗口 A（学校 A）
        // 的 token。下面 localStorage 回退分支已是「本租户命名空间内」的兼容读取，安全。
        const nsTokenKey = this._nsKey(this.tokenKey);
        const fromSession = sessionStorage.getItem(nsTokenKey);
        if (isPlausibleJwt(fromSession)) {
            this._memToken = fromSession;
            return fromSession;
        }

        const fromLocal = localStorage.getItem(nsTokenKey);
        if (isPlausibleJwt(fromLocal)) {
            this._memToken = fromLocal;
            try { sessionStorage.setItem(nsTokenKey, fromLocal); } catch (e) { /* 忽略 */ }
            return fromLocal;
        }

        // 两层均无有效 token：清除残留内存态
        this._memToken = null;
        return null;
    }

    /**
     * 获取当前用户信息
     * @returns {object|null}
     */
    getUser() {
        // TD-TenantIsolation：统一走 _nsKey 命名空间 key
        const nsUserKey = this._nsKey(this.userKey);
        let userStr = sessionStorage.getItem(nsUserKey);
        if (!userStr) userStr = localStorage.getItem(nsUserKey);
        if (!userStr) return null;
        try {
            return JSON.parse(userStr);
        } catch (e) {
            console.error('❌ current_user 解析失败，清除损坏数据:', e.message);
            sessionStorage.removeItem(nsUserKey);
            localStorage.removeItem(nsUserKey);
            return null;
        }
    }

    /**
     * 检查用户是否已登录
     * @returns {boolean}
     */
    isAuthenticated() {
        const token = this.getToken();
        return token && !this.isTokenExpired();
    }

    /**
     * 检查 Token 是否过期
     * @returns {boolean}
     */
    isTokenExpired() {
        // TD-TenantIsolation：统一走 _nsKey 命名空间 key
        const nsExpiryKey = this._nsKey(this.tokenExpiryKey);
        let expiry = sessionStorage.getItem(nsExpiryKey);
        if (!expiry) expiry = localStorage.getItem(nsExpiryKey);
        if (!expiry) return true;

        const expiryTime = parseInt(expiry, 10);
        // TD-TokenExpiry-NaN: 过期时间损坏/非数字时按已过期处理并清理本地态
        if (isNaN(expiryTime)) {
            console.warn('⚠️ Token 过期时间无效，按已过期处理');
            this.clearAuth();
            return true;
        }

        const currentTime = Date.now();

        // Token 在 5 分钟内过期时自动刷新
        return currentTime >= (expiryTime - 5 * 60 * 1000);
    }

    /**
     * 保存 Token
     * @param {string} token - JWT Token
     * @param {number} expiresIn - 过期时间 (秒)
     * @param {boolean} [rememberMe] - P0-1: true=持久化(localStorage,关浏览器重开保持登录);
     *                                 false=仅会话级(sessionStorage,关闭即登出)
     */
    saveToken(token, expiresIn, rememberMe = true) {
        const safeExpiresIn = Number.isFinite(Number(expiresIn)) ? Number(expiresIn) : 3600;

        // TD-TenantIsolation：token 双写内存 + sessionStorage + localStorage，但三处均使用
        // 带 schoolCode 命名空间的 key（auth_token__<schoolCode>）。不同学校的 key 互不可见，
        // 窗口 B（学校 B）读取时只会命中 auth_token__schoolB，绝不会拿到窗口 A（学校 A）的
        // auth_token__schoolA，从根上消除「同一浏览器不同窗口串租户 token」。
        // 注意：保留 localStorage 双写是为兼容 Storage.js/AuditService.js 等直接读
        // localStorage['auth_token'] 的旧模块（见下方 _nsKey 命名空间化同样作用于它们）。
        this._memToken = token;
        const nsTokenKey = this._nsKey(this.tokenKey);
        try { sessionStorage.setItem(nsTokenKey, token); } catch (e) { /* 存储不可用时忽略 */ }
        if (rememberMe) {
            try { localStorage.setItem(nsTokenKey, token); } catch (e) { /* 存储不可用时忽略 */ }
        } else {
            // P0-1: 不记住我 → 移除可能残留的 localStorage 副本，确保会话级语义
            try { localStorage.removeItem(nsTokenKey); } catch (e) { /* 忽略 */ }
        }

        // 第六轮：记录写入时间戳（带命名空间，避免跨租户刷新信标误触发）
        this._memTokenUpdatedAt = Date.now();
        if (rememberMe) {
            try { localStorage.setItem(this._nsKey(this.tokenUpdatedAtKey), String(this._memTokenUpdatedAt)); } catch (e) { /* 忽略 */ }
        } else {
            try { localStorage.removeItem(this._nsKey(this.tokenUpdatedAtKey)); } catch (e) { /* 忽略 */ }
        }

        // 计算过期时间 (当前时间 + 过期时间)，双写（带命名空间）
        const expiryTime = Date.now() + (safeExpiresIn * 1000);
        const expiryStr = expiryTime.toString();
        const nsExpiryKey = this._nsKey(this.tokenExpiryKey);
        try { sessionStorage.setItem(nsExpiryKey, expiryStr); } catch (e) { /* 忽略 */ }
        if (rememberMe) {
            try { localStorage.setItem(nsExpiryKey, expiryStr); } catch (e) { /* 忽略 */ }
        } else {
            try { localStorage.removeItem(nsExpiryKey); } catch (e) { /* 忽略 */ }
        }
    }

    /**
     * 保存用户信息
     * @param {object} user - 用户对象
     * @param {boolean} [rememberMe] - P0-1: 同 saveToken，控制是否持久化到 localStorage
     */
    saveUser(user, rememberMe = true) {
        // TD-TenantIsolation：用户信息同样带命名空间双写，避免窗口 B 读到窗口 A 的用户。
        const nsUserKey = this._nsKey(this.userKey);
        try { sessionStorage.setItem(nsUserKey, JSON.stringify(user)); } catch (e) { /* 存储不可用时忽略 */ }
        if (rememberMe) {
            try { localStorage.setItem(nsUserKey, JSON.stringify(user)); } catch (e) { /* 存储不可用时忽略 */ }
        } else {
            try { localStorage.removeItem(nsUserKey); } catch (e) { /* 忽略 */ }
        }
    }

    /**
     * 保存刷新 Token
     * DS-17: refresh token 敏感性更高——默认仅存内存 + sessionStorage，不落 localStorage
     * （无跨文件使用方直接读 localStorage['refresh_token']，可安全收紧）。
     * P0-1 决策：当用户显式勾选「记住我」时，将 refresh token 持久化到 localStorage——
     * 否则 access token（TTL 30 分钟）过期后无 refresh 可续期，「记住我」语义在关浏览器
     * 重开后 30 分钟内即失效。这是对 DS-17 的有条件放宽，仅限用户显式授权长期登录。
     * @param {string} refreshToken
     * @param {boolean} [rememberMe] - 记住我开关：true 持久化；false 仅会话级
     */
    saveRefreshToken(refreshToken, rememberMe = true) {
        this._memRefreshToken = refreshToken;
        // 第六轮：记录保存时间（sessionStorage，随「复制标签页」一起被复制），
        // 与共享轮转信标（refreshRotatedAtKey）比对即可识别"我手里的 refresh token
        // 已被其他标签页轮转作废"，避免发出触发重放判定的请求。
        this._refreshTokenSavedAt = Date.now();
        try {
            sessionStorage.setItem(this.refreshTokenKey, refreshToken);
            sessionStorage.setItem(this.refreshSavedAtKey, String(this._refreshTokenSavedAt));
        } catch (e) { /* 存储不可用时忽略 */ }
        if (rememberMe) {
            // P0-1: 记住我 → 持久化 refresh token（长期会话续期能力）
            try { localStorage.setItem(this.refreshTokenKey, refreshToken); } catch (e) { /* 存储不可用时忽略 */ }
        } else {
            // 不记住我 → 清理 localStorage 副本（含历史遗留）
            try { localStorage.removeItem(this.refreshTokenKey); } catch (e) { /* 忽略 */ }
        }
    }

    /**
     * 获取刷新 Token
     * @returns {string|null}
     */
    getRefreshToken() {
        if (isPlausibleJwt(this._memRefreshToken)) return this._memRefreshToken;
        const fromSession = sessionStorage.getItem(this.refreshTokenKey);
        if (isPlausibleJwt(fromSession)) {
            this._memRefreshToken = fromSession;
            return fromSession;
        }
        // 兼容旧版本残留在 localStorage 的 refresh token（读到后迁移并删除源）
        const legacy = localStorage.getItem(this.refreshTokenKey);
        if (isPlausibleJwt(legacy)) {
            this.saveRefreshToken(legacy);
            return legacy;
        }
        return null;
    }

    /**
     * 清除所有认证信息
     */
    clearAuth() {
        // DS-17: 同步清除内存态与 sessionStorage 副本
        this._memToken = null;
        this._memRefreshToken = null;
        // TD-TenantIsolation：userKey/tokenExpiryKey 均带命名空间清除
        sessionStorage.removeItem(this._nsKey(this.tokenKey));
        sessionStorage.removeItem(this._nsKey(this.userKey));
        sessionStorage.removeItem(this._nsKey(this.tokenExpiryKey));
        sessionStorage.removeItem(this.refreshTokenKey);
        localStorage.removeItem(this._nsKey(this.tokenKey));
        localStorage.removeItem(this._nsKey(this.userKey));
        localStorage.removeItem(this._nsKey(this.tokenExpiryKey));
        localStorage.removeItem(this.refreshTokenKey);
        // 第六轮：清除跨标签协调键（信标/时间戳/锁），带命名空间隔离防止跨租户误触发
        this._memTokenUpdatedAt = 0;
        this._refreshTokenSavedAt = 0;
        try {
            sessionStorage.removeItem(this.refreshSavedAtKey);
            localStorage.removeItem(this._nsKey(this.tokenUpdatedAtKey));
            localStorage.removeItem(this._nsKey(this.refreshRotatedAtKey));
            localStorage.removeItem(this._nsKey(this.refreshLockKey));
        } catch (e) { /* 忽略 */ }
        // 同时清除访客态，避免登出后 guest_token 残留导致越权（TD-Logout-Token）
        // TD-TenantIsolation：访客态 key 同样按命名空间清除（与 GuestAuthService._nsKey 一致）
        localStorage.removeItem(this._nsKey('guest_token'));
        localStorage.removeItem(this._nsKey('current_guest'));
        localStorage.removeItem(this._nsKey('is_quick_access'));
        sessionStorage.removeItem(this._nsKey('guest_token'));
        sessionStorage.removeItem(this._nsKey('current_guest'));
        sessionStorage.removeItem(this._nsKey('is_quick_access'));
        // RK14/RK26: 清除学校定制缓存，防止上一账号/学校的配置泄漏到下次会话
        try {
            const staleKeys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (k.startsWith('school_customization_') || k.startsWith('school_info_'))) staleKeys.push(k);
            }
            staleKeys.forEach(k => localStorage.removeItem(k));
        } catch (e) { /* 存储不可用时忽略 */ }
        // NB-05: 清除权限缓存，防止登出后切换身份时命中旧权限
        try { permissionService.clearCache?.() } catch (e) { /* 静默降级 */ }
    }

    /**
     * 添加请求 Token Header
     * @param {object} headers - 请求 headers
     * @returns {object} 更新后的 headers
     */
    addAuthHeader(headers = {}) {
        const token = this.getToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    }

    /**
     * 验证 Token 有效性 (调用后端)
     * @returns {Promise<{valid: boolean, user?: object}>}
     */
    async verifyToken() {
        try {
            const token = this.getToken();
            if (!token) {
                return { valid: false };
            }

            const response = await fetch(`${this.apiBaseUrl}/api/user/verify-token`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();
            return { valid: response.ok, user: data.user };
        } catch (error) {
            console.error('❌ Token 验证错误:', error.message);
            return { valid: false };
        }
    }

    /**
     * 修改密码
     * @param {string} oldPassword - 旧密码
     * @param {string} newPassword - 新密码
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async changePassword(oldPassword, newPassword) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/api/user/change-password`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getToken()}`
                },
                body: JSON.stringify({ oldPassword, newPassword })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || '密码修改失败');
            }

            console.log('✅ 密码已修改');
            return { success: true };
        } catch (error) {
            console.error('❌ 密码修改错误:', error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取用户列表 (管理员)
     * @param {number} page - 页码
     * @param {number} limit - 每页数量
     * @returns {Promise<{success: boolean, users?: array, total?: number}>}
     */
    async listUsers(page = 1, limit = 10) {
        try {
            const response = await fetch(
                `${this.apiBaseUrl}/api/user/list?page=${page}&limit=${limit}`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.getToken()}`
                    }
                }
            );

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || '获取用户列表失败');
            }

            // 转换 API 返回的数据格式
            const users = (data.data || []).map(user => ({
                id: user.id,
                username: user.username,
                phone: user.phone || '',
                fullName: user.full_name,
                role: user.role,
                is_active: user.status === 'active',
                status: user.status,
                created_at: user.created_at,
                last_login: user.last_login
            }));

            return { success: true, users: users, total: data.total };
        } catch (error) {
            console.error('❌ 获取用户列表错误:', error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * 删除用户 (管理员)
     * @param {string} userId - 用户 ID
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async deleteUser(userId) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/api/user/${userId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.getToken()}`
                }
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || '删除用户失败');
            }

            console.log('✅ 用户已删除:', userId);
            return { success: true };
        } catch (error) {
            console.error('❌ 删除用户错误:', error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * 更新用户信息 (管理员)
     * @param {string} userId - 用户 ID
     * @param {object} userData - {email, fullName, role}
     * @returns {Promise<{success: boolean, message: string}>}
     */
    async updateUser(userId, userData) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/api/user/${userId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getToken()}`
                },
                body: JSON.stringify(userData)
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || data.message || '更新用户失败');
            }

            console.log('✅ 用户信息已更新:', userId);
            return { success: true };
        } catch (error) {
            console.error('❌ 更新用户错误:', error.message);
            return { success: false, message: error.message };
        }
    }

    async adminResetPassword(userId, newPassword) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/api/user/reset-password/${userId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getToken()}`
                },
                body: JSON.stringify({ newPassword })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || data.message || '重置密码失败');
            }

            console.log('✅ 用户密码已重置:', userId);
            return { success: true };
        } catch (error) {
            console.error('❌ 密码重置错误:', error.message);
            return { success: false, message: error.message };
        }
    }
}

// 自动检测 API 基础 URL
// 注意：本系统开发态由后端 SERVE_STATIC=true 同源托管前端与 API，
// 因此不再写死端口，统一走同源（返回空串 → fetch(`${apiBaseUrl}/api/...`)
// 解析为相对路径 /api/...，自动命中当前页面所在端口的后端）。
// 如需跨域/特殊环境，可通过 window.__API_BASE_URL 覆盖。
export function getApiBaseUrl() {
    if (typeof window !== 'undefined' && window.__API_BASE_URL) {
        return window.__API_BASE_URL;
    }
    return '';
}

// ============================================================================
// REG-2: 全局 401 自动刷新重试拦截器
//
// 背景：access TTL 缩短为 30m 后，Router 的 60s 定时器（临期 5min 主动续期）覆盖
// 常规场景，但存在盲区：页面休眠唤醒、标签页后台被节流、请求恰在过期瞬间发出等。
// 本拦截器兜底：同源 /api/ 请求收到 401 时，用 refresh token 静默换新并重放一次。
//
// 安全护栏（防死循环/请求风暴）：
//   1) 每个请求最多重试一次（重放请求不再进入刷新分支——刷新失败即透传 401）；
//   2) 认证类端点（login/refresh-token/verify-token/logout/guest）不拦截；
//   3) 仅当原请求携带 Authorization 头、body 可安全重放（无 body 或字符串）时重试；
//   4) 刷新走单飞 refreshToken()，并发 401 只触发一次 /refresh-token；
//   5) 无 refresh token 或刷新失败：透传原 401，由 Router/调用方走统一登出。
// ============================================================================
const AUTH_ENDPOINT_RE = /\/api\/(user\/(login|super-admin\/login|refresh-token|verify-token|logout)|guest\/)/;

export function installAuthRefreshFetchInterceptor(service) {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function' || window.__authRefreshFetchInstalled) return;
    window.__authRefreshFetchInstalled = true;

    const rawFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const response = await rawFetch(input, init);
        try {
            if (response.status !== 401) return response;

            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const path = url.replace(/^https?:\/\/[^/]+/, '');
            const isApi = path.startsWith('/api/');
            if (!isApi || AUTH_ENDPOINT_RE.test(path)) return response;

            // 仅重放"带 Authorization 且 body 可安全重放"的请求（Request 对象/流式 body 不处理）
            const headers = new Headers((init && init.headers) || {});
            const bodyRetryable = !init || init.body === undefined || typeof init.body === 'string';
            if (!headers.has('Authorization') || !bodyRetryable || typeof input !== 'string') return response;

            if (!service.getRefreshToken()) return response;

            const refreshed = await service.refreshToken();
            if (!refreshed.success || !refreshed.token) return response;

            headers.set('Authorization', `Bearer ${refreshed.token}`);
            console.log('🔄 401 → Token 已静默刷新，重放原请求:', path);
            return rawFetch(input, { ...(init || {}), headers });
        } catch (e) {
            return response;
        }
    };
}

// 导出单例
export const authService = new AuthService(getApiBaseUrl());

// 安装全局 401 刷新重试拦截器（幂等；jsdom/SSR 环境自动跳过）
installAuthRefreshFetchInterceptor(authService);
