/**
 * AuthService - 用户认证服务
 * 处理登录、登出、Token 管理、权限验证等
 */

export class AuthService {
    constructor(apiBaseUrl = '') {
        this.apiBaseUrl = apiBaseUrl || '';
        this.tokenKey = 'auth_token';
        this.userKey = 'current_user';
        this.tokenExpiryKey = 'token_expiry';
        this.refreshTokenKey = 'refresh_token';
        
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
                console.log('✅ 用户已登录:', user.username);
            }
        }
    }

    /**
     * 登录 API 调用
     * @param {string} username - 用户名
     * @param {string} password - 密码
     * @returns {Promise<{success: boolean, user?: object, token?: string, message?: string}>}
     */
    async login(username, password) {
        try {
            // 输入验证
            if (!username || !password) {
                throw new Error('用户名和密码不能为空');
            }

            // 调用后端登录 API
            const response = await fetch(`${this.apiBaseUrl}/api/user/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || data.error || '登录失败');
            }

            if (data.success && data.token) {
                // 保存 Token 和用户信息
                this.saveToken(data.token, data.expiresIn);
                this.saveUser(data.user);
                
                // 如果返回了 refresh token，也保存
                if (data.refreshToken) {
                    this.saveRefreshToken(data.refreshToken);
                }

                console.log('✅ 登录成功:', data.user.username);
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
            console.log('✅ 已登出');
            return { success: true };
        } catch (error) {
            console.error('❌ 登出错误:', error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * 注册新用户 (管理员功能)
     * @param {object} userData - 用户数据 {username, email, password, fullName}
     * @returns {Promise<{success: boolean, message: string, user?: object}>}
     */
    async registerUser(userData) {
        try {
            const { username, email, password, fullName } = userData;

            if (!username || !email || !password) {
                throw new Error('用户名、邮箱和密码是必填项');
            }

            const response = await fetch(`${this.apiBaseUrl}/api/user/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getToken()}`
                },
                body: JSON.stringify({ username, email, password, fullName })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || '注册失败');
            }

            console.log('✅ 用户注册成功:', username);
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
            
            if (!refreshToken) {
                throw new Error('没有可用的刷新 Token');
            }

            const response = await fetch(`${this.apiBaseUrl}/api/auth/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ refreshToken })
            });

            const data = await response.json();

            if (!response.ok) {
                // 刷新失败，清除认证
                this.clearAuth();
                throw new Error('Token 刷新失败，请重新登录');
            }

            // 更新 Token
            this.saveToken(data.token, data.expiresIn);
            console.log('✅ Token 已刷新');
            return { success: true, token: data.token };
        } catch (error) {
            console.error('❌ Token 刷新错误:', error.message);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取当前 Token
     * @returns {string|null}
     */
    getToken() {
        return localStorage.getItem(this.tokenKey);
    }

    /**
     * 获取当前用户信息
     * @returns {object|null}
     */
    getUser() {
        const userStr = localStorage.getItem(this.userKey);
        return userStr ? JSON.parse(userStr) : null;
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
        const currentTime = Date.now();
        
        // Token 在 5 分钟内过期时自动刷新
        return currentTime >= (expiryTime - 5 * 60 * 1000);
    }

    /**
     * 保存 Token
     * @param {string} token - JWT Token
     * @param {number} expiresIn - 过期时间 (秒)
     */
    saveToken(token, expiresIn = 3600) {
        localStorage.setItem(this.tokenKey, token);
        
        // 计算过期时间 (当前时间 + 过期时间)
        const expiryTime = Date.now() + (expiresIn * 1000);
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
     * @param {string} refreshToken
     */
    saveRefreshToken(refreshToken) {
        localStorage.setItem(this.refreshTokenKey, refreshToken);
    }

    /**
     * 获取刷新 Token
     * @returns {string|null}
     */
    getRefreshToken() {
        return localStorage.getItem(this.refreshTokenKey);
    }

    /**
     * 清除所有认证信息
     */
    clearAuth() {
        localStorage.removeItem(this.tokenKey);
        localStorage.removeItem(this.userKey);
        localStorage.removeItem(this.tokenExpiryKey);
        localStorage.removeItem(this.refreshTokenKey);
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
                method: 'GET',
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
            const response = await fetch(`${this.apiBaseUrl}/api/user/password`, {
                method: 'PUT',
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

            return { success: true, users: data.users, total: data.total };
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
}

// 导出单例
export const authService = new AuthService();
