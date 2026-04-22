/**
 * 访客认证服务
 * 处理访客登录、注册、权限检查等
 */

const RAILWAY_API_URL = 'https://tianjiabingfoodtestlab-production.up.railway.app';

export class GuestAuthService {
    constructor(apiBaseUrl = '') {
        // 优先使用传入的 baseUrl，否则根据环境动态设置
        if (apiBaseUrl) {
            this.apiBaseUrl = apiBaseUrl;
        } else {
            // 本地开发环境：http://localhost:3000
            // 生产环境：使用 Railway 后端地址
            const isDevelopment = window.location.hostname === 'localhost' || 
                                  window.location.hostname === '127.0.0.1';
            if (isDevelopment) {
                this.apiBaseUrl = 'http://localhost:3000';
            } else {
                this.apiBaseUrl = RAILWAY_API_URL;
            }
        }
    }

    /**
     * 访客自助注册
     * @param {string} username - 访客用户名
     * @param {string} email - 访客邮箱
     * @param {string} password - 访客密码
     * @param {string} full_name - 访客真实姓名
     * @param {string} guest_type - 访客类型: 'viewer' 或 'export_applicant'
     * @returns {Promise<{success: boolean, token?: string, guest?: object, error?: string}>}
     */
    async register(username, email, password, full_name, guest_type = 'viewer') {
        try {
            const response = await fetch(`${this.apiBaseUrl}/api/guest/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    email,
                    password,
                    full_name,
                    guest_type,
                    valid_days: 30
                })
            });

            const data = await response.json();

            if (!response.ok) {
                return { success: false, error: data.error };
            }

            // 保存 token 和访客信息到 localStorage
            if (data.token) {
                localStorage.setItem('guest_token', data.token);
                localStorage.setItem('current_guest', JSON.stringify(data.guest));
            }

            return { success: true, token: data.token, guest: data.guest };
        } catch (error) {
            console.error('访客注册错误:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 访客登录
     * @param {string} username - 访客用户名
     * @param {string} password - 访客密码
     * @returns {Promise<{success: boolean, token?: string, guest?: object, error?: string}>}
     */
    async login(username, password) {
        try {
            const response = await fetch(`${this.apiBaseUrl}/api/guest/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (!response.ok) {
                return { success: false, error: data.error };
            }

            // 保存 token 和访客信息到 localStorage
            if (data.token) {
                localStorage.setItem('guest_token', data.token);
                localStorage.setItem('current_guest', JSON.stringify(data.guest));
            }

            return { success: true, token: data.token, guest: data.guest };
        } catch (error) {
            console.error('访客登录错误:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 验证访客 Token
     * @returns {Promise<{valid: boolean, guestId?: number, guest_type?: string}>}
     */
    async verifyToken() {
        try {
            const token = localStorage.getItem('guest_token');
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
            console.error('Token 验证错误:', error);
            return { valid: false };
        }
    }

    /**
     * 获取当前访客信息
     * @returns {object|null}
     */
    getCurrentGuest() {
        const guest = localStorage.getItem('current_guest');
        return guest ? JSON.parse(guest) : null;
    }

    /**
     * 获取访客 Token
     * @returns {string|null}
     */
    getToken() {
        return localStorage.getItem('guest_token');
    }

    /**
     * 访客登出
     */
    logout() {
        localStorage.removeItem('guest_token');
        localStorage.removeItem('current_guest');
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
     * 快速访问模式 - 无需登录直接进入只读数据查看
     * 创建一个临时的访客 session
     * @returns {boolean}
     */
    quickAccessAsViewer() {
        // 生成临时访客信息
        const tempGuest = {
            id: 'temp-' + Date.now(),
            username: '临时查看用户',
            email: 'temp@viewer.local',
            guest_type: 'viewer',
            has_export_permission: false,
            status: 'active',
            is_quick_access: true  // 标记为快速访问
        };

        // 生成简单的临时令牌（不使用 btoa）
        const tempToken = 'temp-token-' + Date.now() + '-' + Math.random().toString(36).substring(2, 11);

        // 保存到 localStorage
        localStorage.setItem('guest_token', tempToken);
        localStorage.setItem('current_guest', JSON.stringify(tempGuest));

        console.log('✅ 快速访问模式已激活 - 进入只读数据查看');
        console.log('Token:', tempToken);
        console.log('Guest:', JSON.stringify(tempGuest));
        return true;
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
