/**
 * 访客认证服务
 * 处理访客登录、注册、权限检查等
 */

import { extractSchoolCode } from '../utils/schoolCode.js'

// DS-17: JWT 形态校验（三段 base64url），读取处统一校验
function isPlausibleJwt(token) {
    return typeof token === 'string'
        && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

export class GuestAuthService {
    constructor(apiBaseUrl = '') {
        // 默认走同源 API，适配腾讯云 Nginx 反向代理。
        this.apiBaseUrl = apiBaseUrl || '';
        // DS-17: 内存态 token 作为第一优先读取源；sessionStorage 第二；
        // localStorage 仅作兼容层保留（PermissionService/Storage.js/BackupRestore.js/
        // ExportService.js/Router.js 等现有使用方直接读 localStorage['guest_token']）。
        this._memToken = null;
    }

    /**
     * TD-TenantIsolation：访客态 key 同样按 schoolCode 命名空间隔离，避免同一浏览器
     * 不同学校窗口的 guest_token / current_guest 互相串读（与 AuthService._nsKey 一致）。
     */
    _nsKey(base) {
        const code = extractSchoolCode() || '';
        return code ? `${base}__${code}` : base;
    }

    /**
     * DS-17: 统一保存访客会话（内存 + sessionStorage 为主，localStorage 兼容层）
     * @param {string} token
     * @param {object} guest
     */
    _storeGuestSession(token, guest) {
        this._memToken = token;
        const nsGuest = this._nsKey('guest_token');
        const nsCurrent = this._nsKey('current_guest');
        try { sessionStorage.setItem(nsGuest, token); } catch (e) { /* 存储不可用时忽略 */ }
        localStorage.setItem(nsGuest, token);
        localStorage.setItem(nsCurrent, JSON.stringify(guest));
    }

    /**
     * 访客自助注册
     * @param {string} username - 访客用户名
     * @param {string} email - 访客邮箱
     * @param {string} password - 访客密码
     * @param {string} full_name - 访客真实姓名
     * @param {string} guest_type - 访客类型: 'readonly' 或 'export_applicant'
     * @returns {Promise<{success: boolean, token?: string, guest?: object, error?: string}>}
     */
    async register(username, email, password, full_name, guest_type = 'readonly', schoolCode = null) {
        try {
            const resolvedSchool = schoolCode || extractSchoolCode()
            const response = await fetch(`${this.apiBaseUrl}/api/guest/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    email,
                    password,
                    full_name,
                    guest_type,
                    valid_days: 30,
                    schoolCode: resolvedSchool
                })
            });

            const data = await response.json();

            if (!response.ok) {
                return { success: false, error: data.error };
            }

            // 保存 token 和访客信息（DS-17：内存+sessionStorage 优先）
            if (data.token) {
                this._storeGuestSession(data.token, data.guest);
            }

            return { success: true, token: data.token, guest: data.guest };
        } catch (error) {
            // L4: 仅打错误摘要，不输出可能含 PII 的完整 error 对象
            console.error('访客注册错误:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * 访客登录
     * @param {string} username - 访客用户名
     * @param {string} password - 访客密码
     * @returns {Promise<{success: boolean, token?: string, guest?: object, error?: string}>}
     */
    async login(username, password, schoolCode = null) {
        try {
            const resolvedSchool = schoolCode || extractSchoolCode()
            const response = await fetch(`${this.apiBaseUrl}/api/guest/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, schoolCode: resolvedSchool })
            });

            const data = await response.json();

            if (!response.ok) {
                return { success: false, error: data.error };
            }

            // 保存 token 和访客信息（DS-17：内存+sessionStorage 优先）
            if (data.token) {
                this._storeGuestSession(data.token, data.guest);
            }

            return { success: true, token: data.token, guest: data.guest };
        } catch (error) {
            // L4: 仅打错误摘要
            console.error('访客登录错误:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * 验证访客 Token
     * @returns {Promise<{valid: boolean, guestId?: number, guest_type?: string}>}
     */
    async verifyToken() {
        try {
            const token = this.getToken();
            if (!token) {
                return { valid: false };
            }

            const response = await fetch(`${this.apiBaseUrl}/api/guest/verify-token`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();
            return data;
        } catch (error) {
            // L4: 仅打错误摘要
            console.error('Token 验证错误:', error.message);
            return { valid: false };
        }
    }

    /**
     * 获取当前访客信息
     * @returns {object|null}
     */
    getCurrentGuest() {
        const guest = localStorage.getItem(this._nsKey('current_guest'));
        if (!guest) return null;
        try {
            return JSON.parse(guest);
        } catch (e) {
            console.error('❌ current_guest 解析失败，清除损坏数据:', e.message);
            localStorage.removeItem(this._nsKey('current_guest'));
            return null;
        }
    }

    /**
     * 获取访客 Token
     * DS-17: 读取优先级 内存 → sessionStorage → localStorage（兼容层），逐层做 JWT 形态校验
     * @returns {string|null}
     */
    getToken() {
        const nsGuest = this._nsKey('guest_token');
        const fromLocal = localStorage.getItem(nsGuest);

        // 兼容层副本不存在（未登录/已在其它标签页登出）→ 同步失效内存/session 副本
        if (!fromLocal) {
            this._memToken = null;
            try { sessionStorage.removeItem(nsGuest); } catch (e) { /* 存储不可用时忽略 */ }
            return null;
        }

        if (isPlausibleJwt(this._memToken)) return this._memToken;

        const fromSession = sessionStorage.getItem(nsGuest);
        if (isPlausibleJwt(fromSession)) {
            this._memToken = fromSession;
            return fromSession;
        }

        if (isPlausibleJwt(fromLocal)) {
            // 兼容路径：login.html 注册/登录后跳转 → 回填内存/sessionStorage
            this._memToken = fromLocal;
            try { sessionStorage.setItem(nsGuest, fromLocal); } catch (e) { /* 存储不可用时忽略 */ }
            return fromLocal;
        }

        // 存在但形态非法（被篡改/脏数据）：清除
        console.warn('⚠️ 检测到非法格式的 guest_token，已清除');
        localStorage.removeItem(nsGuest);
        return null;
    }

    /**
     * 访客登出
     */
    logout() {
        this._memToken = null;
        const nsGuest = this._nsKey('guest_token');
        const nsCurrent = this._nsKey('current_guest');
        sessionStorage.removeItem(nsGuest);
        sessionStorage.removeItem(nsCurrent);
        localStorage.removeItem(nsGuest);
        localStorage.removeItem(nsCurrent);
    }

    /**
     * 检查是否已登录为访客
     * @returns {boolean}
     */
    isLoggedIn() {
        return !!this.getToken();
    }

    /**
     * 获取访客类型
     * @returns {string|null}
     */
    getGuestType() {
        const guest = this.getCurrentGuest();
        return guest ? guest.guest_type : null;
    }

    /**
     * 是否有导出权限
     * @returns {boolean}
     */
    hasExportPermission() {
        const guest = this.getCurrentGuest();
        return guest ? guest.has_export_permission : false;
    }

    /**
     * 快速访问模式 - 调用后端接口获取真实 JWT（P0-07 修复）
     * @returns {Promise<boolean>}
     */
    async quickAccessAsViewer(schoolCode = null) {
        try {
            // RK23: 后端现要求 body 携带 schoolCode（否则 400），确保租户隔离
            const resolvedSchool = schoolCode || extractSchoolCode()
            if (!resolvedSchool) {
                console.error('❌ 快速访问失败：无法从 URL 解析学校代码（需通过学校专属入口访问）')
                return false
            }
            const response = await fetch(`${this.apiBaseUrl}/api/guest/quick-access`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ schoolCode: resolvedSchool })
            })
            if (!response.ok) return false
            const data = await response.json()
            if (data.token) {
                this._storeGuestSession(data.token, data.guest)
                console.log('✅ 快速访问模式已激活（后端签发 JWT）')
                return true
            }
            return false
        } catch (error) {
            console.error('❌ 快速访问网络错误:', error)
            return false
        }
    }

    /**
     * 检查是否为快速访问模式
     * @returns {boolean}
     */
    isQuickAccessMode() {
        const guest = this.getCurrentGuest();
        return guest ? guest.is_quick_access === true : false;
    }

    /**
     * 提交导出申请
     * @param {string} request_type - 申请类型
     * @param {string} request_reason - 申请原因
     * @param {object} request_data - 申请数据
     * @returns {Promise<{success: boolean, request?: object, error?: string}>}
     */
    async submitExportRequest(request_type, request_reason, request_data = {}) {
        try {
            const token = this.getToken();
            if (!token) {
                return { success: false, error: '未登录' };
            }

            const response = await fetch(`${this.apiBaseUrl}/api/guest-export-request/submit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    request_type,
                    request_reason,
                    request_data
                })
            });

            const data = await response.json();

            if (!response.ok) {
                return { success: false, error: data.error };
            }

            return { success: true, request: data.request };
        } catch (error) {
            console.error('提交导出申请错误:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 提交「查看病原体数据」申请（pathogen_access）。
     * 注意：仅申请只读的病原体查看权限，审批通过绝不开放导出。
     * @param {string} request_reason - 申请原因
     * @returns {Promise<{success: boolean, request?: object, error?: string}>}
     */
    async submitPathogenRequest(request_reason) {
        return this.submitExportRequest('pathogen_access', request_reason, {});
    }

    /**
     * 获取访客的申请记录
     * @returns {Promise<{success: boolean, requests?: array, error?: string}>}
     */
    async getMyRequests() {
        try {
            const token = this.getToken();
            if (!token) {
                return { success: false, error: '未登录' };
            }

            const response = await fetch(`${this.apiBaseUrl}/api/guest-export-request/my-requests`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();

            if (!response.ok) {
                return { success: false, error: data.error };
            }

            return { success: true, requests: data.requests };
        } catch (error) {
            console.error('获取申请记录错误:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 检查导出权限状态
     * @returns {Promise<{has_export_permission: boolean, valid_until?: string}>}
     */
    async checkExportPermission() {
        try {
            const token = this.getToken();
            if (!token) {
                return { has_export_permission: false };
            }

            const response = await fetch(`${this.apiBaseUrl}/api/guest-export-request/check-permission`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();
            return data;
        } catch (error) {
            console.error('检查权限错误:', error);
            return { has_export_permission: false };
        }
    }
}

export default new GuestAuthService();
