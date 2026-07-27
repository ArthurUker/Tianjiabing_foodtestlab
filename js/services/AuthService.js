/**
 * AuthService - 用户认证服务
 * 处理登录、登出、Token 管理、权限验证等
 */

import { auditService } from './AuditService.js';
import { maskSensitive } from '../utils/fieldMasking.js';
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

        // DS-17: 内存态 token 作为第一优先读取源（XSS 需精确命中该实例才能读到）。
        // sessionStorage 为第二优先（页面关闭即清）；localStorage 仅作兼容层保留——
        // Storage.js / BackupRestore.js / AuditService.js / Router.js（storage 事件跨标签登出）
        // 等现有使用方直接读 localStorage['auth_token']，本窗口不允许改动它们，故不能移除。
        this._memToken = null;
        this._memRefreshToken = null;

        // 初始化时检查是否已登录
        this.init();
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
                console.warn('⚠️ Token 已过期，清除本地存储');
                this.clearAuth();
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
     * @returns {Promise<{success: boolean, user?: object, token?: string, message?: string}>}
     */
    async login(username, password, schoolCode = null) {
        try {
            // 输入验证
            if (!username || !password) {
                throw new Error('用户名和密码不能为空');
            }

            // 调用后端登录 API（schoolCode 一并上报，供后端路由到对应 schema）
            const response = await fetch(`${this.apiBaseUrl}/api/user/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password, schoolCode })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || data.error || '登录失败');
            }

            if (data.success && data.token) {
                // 🎯 在登录前清除所有访客信息（切换身份）
                console.log('🔧 清除访客信息，准备以管理员身份登录...');
                localStorage.removeItem('current_guest');
                localStorage.removeItem('guest_token');
                localStorage.removeItem('is_quick_access');
                sessionStorage.removeItem('current_guest');
                sessionStorage.removeItem('guest_token');
                
                // 保存 Token 和用户信息
                this.saveToken(data.token, data.expiresIn);
                this.saveUser(data.user);
                
                // 如果返回了 refresh token，也保存
                if (data.refreshToken) {
                    this.saveRefreshToken(data.refreshToken);
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
     * @returns {Promise<{success: boolean, user?: object, message?: string}>}
     */
    async loginSuperAdmin(username, password) {
        try {
            if (!username || !password) {
                throw new Error('用户名和密码不能为空');
            }

            const response = await fetch(`${this.apiBaseUrl}/api/user/super-admin/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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

                this.saveToken(data.token, data.expiresIn);
                this.saveUser(data.user);

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
            const { username, phone, password, fullName } = userData;

            if (!username || !password) {
                throw new Error('用户名和密码是必填项');
            }

            // TD-Username-Rule-Inconsistent: 与后端 UserManager / validationMiddleware 对齐，提前给出反馈
            if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
                throw new Error('用户名需为 3-50 位字母、数字或下划线');
            }

            const response = await fetch(`${this.apiBaseUrl}/api/user/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getToken()}`
                },
                body: JSON.stringify({ username, phone, password, fullName })
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
     * @returns {Promise<{success: boolean, token?: string}>}
     */
    async refreshToken() {
        try {
            const refreshToken = this.getRefreshToken();
            const accessToken = this.getToken();

            if (!refreshToken && !accessToken) {
                throw new Error('没有可用的令牌，请重新登录');
            }

            // TD-RefreshToken: 优先使用 refresh token；缺省时回退到访问令牌（兼容旧后端）
            const headers = { 'Content-Type': 'application/json' };
            if (refreshToken) headers['X-Refresh-Token'] = refreshToken;
            if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

            const response = await fetch(`${this.apiBaseUrl}/api/user/refresh-token`, {
                method: 'POST',
                headers
            });

            const data = await response.json().catch(() => ({}));

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
        const fromLocal = localStorage.getItem(this.tokenKey);

        // 兼容层副本不存在（未登录，或其它标签页已登出并清除）→ 同步失效内存/session 副本，
        // 保证 Router.js / SessionManager.js 的跨标签登出逻辑（storage 事件 + getToken() 判空）依旧生效
        if (!fromLocal) {
            this._memToken = null;
            try { sessionStorage.removeItem(this.tokenKey); } catch (e) { /* 存储不可用时忽略 */ }
            return null;
        }

        // 优先返回内存/sessionStorage 中的可信副本（localStorage 被篡改时不采信其值）
        if (isPlausibleJwt(this._memToken)) return this._memToken;

        const fromSession = sessionStorage.getItem(this.tokenKey);
        if (isPlausibleJwt(fromSession)) {
            this._memToken = fromSession;
            return fromSession;
        }

        if (isPlausibleJwt(fromLocal)) {
            // 兼容路径：login.html 登录后跳转、或其它标签页写入 → 回填内存/sessionStorage
            this._memToken = fromLocal;
            try { sessionStorage.setItem(this.tokenKey, fromLocal); } catch (e) { /* 存储不可用时忽略 */ }
            return fromLocal;
        }

        // 存在但形态非法（被篡改/脏数据）：清除，避免带着坏令牌请求后端
        console.warn('⚠️ 检测到非法格式的 auth_token，已清除');
        localStorage.removeItem(this.tokenKey);
        return null;
    }

    /**
     * 获取当前用户信息
     * @returns {object|null}
     */
    getUser() {
        const userStr = localStorage.getItem(this.userKey);
        if (!userStr) return null;
        try {
            return JSON.parse(userStr);
        } catch (e) {
            console.error('❌ current_user 解析失败，清除损坏数据:', e.message);
            localStorage.removeItem(this.userKey);
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
        const expiry = localStorage.getItem(this.tokenExpiryKey);
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
     */
    saveToken(token, expiresIn) {
        const safeExpiresIn = Number.isFinite(Number(expiresIn)) ? Number(expiresIn) : 3600;

        // DS-17: 内存 + sessionStorage 为主存储；localStorage 保留为兼容层
        // （Storage.js/BackupRestore.js/AuditService.js 直接读、Router/SessionManager 依赖其 storage 事件做跨标签登出）
        this._memToken = token;
        try { sessionStorage.setItem(this.tokenKey, token); } catch (e) { /* 存储不可用时忽略 */ }
        localStorage.setItem(this.tokenKey, token);

        // 计算过期时间 (当前时间 + 过期时间)
        const expiryTime = Date.now() + (safeExpiresIn * 1000);
        localStorage.setItem(this.tokenExpiryKey, expiryTime.toString());
    }

    /**
     * 保存用户信息
     * @param {object} user - 用户对象
     */
    saveUser(user) {
        localStorage.setItem(this.userKey, JSON.stringify(user));
    }

    /**
     * 保存刷新 Token
     * DS-17: refresh token 敏感性更高——仅存内存 + sessionStorage，不落 localStorage
     * （无跨文件使用方直接读 localStorage['refresh_token']，可安全收紧）。
     * @param {string} refreshToken
     */
    saveRefreshToken(refreshToken) {
        this._memRefreshToken = refreshToken;
        try { sessionStorage.setItem(this.refreshTokenKey, refreshToken); } catch (e) { /* 存储不可用时忽略 */ }
        // 清理历史遗留的 localStorage 副本（旧版本写入的）
        localStorage.removeItem(this.refreshTokenKey);
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
        sessionStorage.removeItem(this.tokenKey);
        sessionStorage.removeItem(this.refreshTokenKey);
        localStorage.removeItem(this.tokenKey);
        localStorage.removeItem(this.userKey);
        localStorage.removeItem(this.tokenExpiryKey);
        localStorage.removeItem(this.refreshTokenKey);
        // 同时清除访客态，避免登出后 guest_token 残留导致越权（TD-Logout-Token）
        localStorage.removeItem('guest_token');
        localStorage.removeItem('current_guest');
        localStorage.removeItem('is_quick_access');
        sessionStorage.removeItem('guest_token');
        sessionStorage.removeItem('current_guest');
        sessionStorage.removeItem('is_quick_access');
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

// 导出单例
export const authService = new AuthService(getApiBaseUrl());
