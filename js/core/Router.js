/**
 * Router - 路由与权限守卫管理器
 * 处理页面导航、登录状态检查、权限验证
 */

import { authService } from '../services/AuthService.js';
import { permissionService } from '../services/PermissionService.js';
import { GuestAuthService } from '../services/GuestAuthService.js';

export class Router {
    constructor() {
        this.currentPage = null;
        this.isInitialized = false;
        
        // 🎯 暴露自己到全局作用域（用于调试和事件处理）
        window.router = this;
        console.log('✅ Router 已暴露到 window.router');
    }

    /**
     * 初始化路由
     */
    async init() {
        // 注意: 移除了 isInitialized 检查,以便每次都重新检查身份验证
        // 如果需要缓存,会在第一次完全初始化后设置标志
        
        const shouldFullyInit = !this.isInitialized;
        
        console.log('🔧 Router 初始化中... (完全初始化:', shouldFullyInit, ')');

        // 检查用户或访客是否已登录
        const guestAuthService = new GuestAuthService();
        const isUserAuthenticated = authService.isAuthenticated();
        const isGuestAuthenticated = guestAuthService.isLoggedIn();
        const isAuthenticated = isUserAuthenticated || isGuestAuthenticated;
        
        // 🔍 调试日志
        console.log('🔍 Auth Check:');
        console.log('  - isUserAuthenticated:', isUserAuthenticated);
        console.log('  - isGuestAuthenticated:', isGuestAuthenticated);
        console.log('  - guestAuthService.getToken():', guestAuthService.getToken());
        console.log('  - guestAuthService.getCurrentGuest():', guestAuthService.getCurrentGuest());
        console.log('  - Final isAuthenticated:', isAuthenticated);
        
        const currentUrl = window.location.pathname;

        // 如果用户未登录且不在快速访问模式，重定向到登录页
        if (!isAuthenticated && !this.isLoginPage(currentUrl)) {
            console.log('⚠️ 用户未登录，重定向到登录页...');
            window.location.href = './login.html';
            return;
        }

        // 如果用户已登录，但在登录页，重定向到首页
        if (isAuthenticated && this.isLoginPage(currentUrl)) {
            console.log('✅ 用户已登录，重定向到首页...');
            window.location.href = './index.html';
            return;
        }

        // 仅在第一次完全初始化时设置事件监听器
        if (shouldFullyInit) {
            // 监听存储变化（用于跨标签页登出同步）
            window.addEventListener('storage', (e) => {
                if (e.key === 'auth_token' && !authService.getToken()) {
                    console.log('🔔 用户在其他标签页登出，本页面也进行登出');
                    this.handleLogout();
                }
                if (e.key === 'guest_token' && !guestAuthService.getToken()) {
                    console.log('🔔 访客在其他标签页登出，本页面也进行登出');
                    this.handleLogout();
                }
            });

            console.log('✅ Router 完全初始化完成');
            this.isInitialized = true;
        } else {
            console.log('✅ Router 身份验证检查完成');
        }
    }

    /**
     * 检查是否为登录页
     * @param {string} url - URL 路径
     * @returns {boolean}
     */
    isLoginPage(url) {
        return url.includes('login.html') || url === '/login';
    }

    /**
     * 检查是否为访客登录
     * @returns {boolean}
     */
    isGuest() {
        const guestAuthService = new GuestAuthService();
        return guestAuthService.isLoggedIn();
    }

    /**
     * 检查用户权限 (管理员权限)
     * @returns {boolean}
     */
    isAdmin() {
        return permissionService.hasRole('admin');
    }

    /**
     * 检查用户权限 (指定权限)
     * @param {string} permission - 权限名称
     * @returns {boolean}
     */
    hasPermission(permission) {
        return permissionService.hasPermission(permission);
    }

    /**
     * 检查用户是否有任意一个权限 (OR 逻辑)
     * @param {array} permissions - 权限数组
     * @returns {boolean}
     */
    hasAnyPermission(permissions) {
        return permissionService.hasAnyPermission(permissions);
    }

    /**
     * 检查用户是否有所有权限 (AND 逻辑)
     * @param {array} permissions - 权限数组
     * @returns {boolean}
     */
    hasAllPermissions(permissions) {
        return permissionService.hasAllPermissions(permissions);
    }

    /**
     * 显示或隐藏元素（基于权限）
     * @param {string} selector - CSS 选择器
     * @param {boolean} show - 是否显示
     */
    toggleElementByPermission(selector, hasPermission) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
            if (hasPermission) {
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
            }
        });
    }

    /**
     * 禁用元素（基于权限）
     * @param {string} selector - CSS 选择器
     * @param {boolean} disable - 是否禁用
     */
    disableElementsByPermission(selector, disable) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
            if (disable) {
                el.disabled = true;
                el.classList.add('opacity-50', 'cursor-not-allowed');
                el.title = '您没有权限执行此操作';
            } else {
                el.disabled = false;
                el.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        });
    }

    /**
     * 更新导航菜单（基于权限）
     */
    updateNavigationByPermission() {
        const user = authService.getUser();
        const guestAuthService = new GuestAuthService();
        const isGuest = guestAuthService.isLoggedIn();
        
        if (!user && !isGuest) return;

        // 管理员菜单项
        if (!user || user.role !== 'admin') {
            // 隐藏管理员才能访问的菜单项
            this.toggleElementByPermission('[data-admin-only]', false);
        } else {
            // 管理员显示所有菜单项
            this.toggleElementByPermission('[data-admin-only]', true);
        }

        // 访客菜单项
        if (isGuest) {
            // 显示访客菜单
            document.querySelectorAll('.guest-menu-section').forEach(el => {
                el.classList.remove('hidden');
            });
        } else {
            // 隐藏访客菜单
            document.querySelectorAll('.guest-menu-section').forEach(el => {
                el.classList.add('hidden');
            });
        }

        // 根据角色显示不同的菜单
        const navItems = document.querySelectorAll('.nav-btn');
        navItems.forEach(item => {
            const requiredRole = item.getAttribute('data-required-role');
            if (requiredRole && user?.role !== requiredRole) {
                item.classList.add('hidden');
            }
        });

        // 🔒 基于权限隐藏特定模块（访客权限控制）
        // 如果是访客，隐藏病原体检测模块
        if (isGuest) {
            console.log('🔒 访客权限检查：隐藏病原体检测模块...');
            
            // 隐藏病原体检测导航按钮
            const pathogenBtn = document.querySelector('[data-target="pathogen-test"]');
            if (pathogenBtn) {
                pathogenBtn.classList.add('hidden');
                console.log('✅ 已隐藏病原体检测导航按钮');
            }
            
            // 隐藏病原体检测内容区域
            const pathogenSection = document.getElementById('pathogen-test');
            if (pathogenSection) {
                pathogenSection.classList.add('hidden');
                console.log('✅ 已隐藏病原体检测内容区域');
            }
        }
    }

    /**
     * 处理登出
     */
    async handleLogout() {
        console.log('🔴 ===== 登出流程开始 =====');
        
        try {
            // 获取全局的 guestAuthService 实例（main.js 中定义）
            const guestAuthService = window.guestAuthService || new GuestAuthService();
            
            console.log('  1️⃣ 检查用户身份类型...');
            const isGuest = guestAuthService.isLoggedIn();
            const isAdmin = this.isAdmin();
            console.log(`  身份: 访客=${isGuest}, 管理员=${isAdmin}`);
            
            // 清除所有认证相关数据
            console.log('  2️⃣ 清除认证信息...');
            
            // 清除访客认证（如果是访客）
            if (isGuest) {
                console.log('  📍 清除访客认证...');
                guestAuthService.logout();
            }
            
            // 清除用户认证（所有角色均需清除）
            console.log('  📍 清除用户认证...');
            authService.clearAuth();
            
            // 清除所有本地存储数据
            console.log('  3️⃣ 清除本地存储...');
            const clearKeys = ['auth_token', 'current_user', 'token_expiry', 'refresh_token', 'guest_token', 'current_guest', 'is_quick_access', 'cache_tableware', 'cache_pesticide', 'cache_oil', 'cache_lean', 'cache_pathogen'];
            clearKeys.forEach(key => {
                localStorage.removeItem(key);
                sessionStorage.removeItem(key);
            });
            console.log(`  已清除 ${clearKeys.length} 个存储项`);
            
            console.log('  4️⃣ 正在跳转到登录页面...');
            
            // 延迟一会儿再跳转，确保清除操作完成
            setTimeout(() => {
                console.log('  ✅ 重定向到 login.html');
                window.location.href = './login.html';
            }, 300);
        } catch (error) {
            console.error('❌ 登出过程中出错:', error);
            // 即使出错也跳转到登录页面
            console.log('⚠️ 强制重定向到 login.html');
            window.location.href = './login.html';
        }
    }

    /**
     * 设置登出按钮事件
     */
    setupLogoutButton() {
        console.log('🔧 setupLogoutButton() 被调用');
        
        // 找到所有的登出按钮（可能有多个）
        const logoutBtns = document.querySelectorAll('#btnLogout');
        console.log(`  找到 ${logoutBtns.length} 个登出按钮`);
        
        logoutBtns.forEach((btn, index) => {
            console.log(`  绑定按钮 ${index}: 可见=${btn.offsetParent !== null}, 禁用=${btn.disabled}`);
            btn.addEventListener('click', (e) => {
                console.log('🔴 登出按钮被点击！');
                e.preventDefault();
                e.stopPropagation();
                console.log('  调用 handleLogout()...');
                this.handleLogout();
            });
        });
        
        // 也可以通过菜单项登出
        const logoutMenuItems = document.querySelectorAll('[data-logout]');
        console.log(`  找到 ${logoutMenuItems.length} 个登出菜单项`);
        
        logoutMenuItems.forEach((item, index) => {
            console.log(`  绑定菜单项 ${index}`);
            item.addEventListener('click', (e) => {
                console.log('🔴 登出菜单项被点击！');
                e.preventDefault();
                e.stopPropagation();
                this.handleLogout();
            });
        });
        
        console.log(`✅ setupLogoutButton() 完成 - 已绑定 ${logoutBtns.length + logoutMenuItems.length} 个登出元素`);
    }

    /**
     * 更新用户信息显示
     */
    updateUserDisplay() {
        const user = authService.getUser();
        const guestAuthService = new GuestAuthService();
        const guest = guestAuthService.getCurrentGuest();
        
        if (!user && !guest) return;

        // 确定显示的是用户还是访客信息
        const displayName = user?.username || guest?.username || '用户';
        const displayRole = user?.role ? this.getRoleLabel(user.role) : (guest ? '访客 (' + (guest.guest_type === 'viewer' ? '只读' : '申请导出') + ')' : '');

        // 更新导航栏中的用户名
        const userNameElements = document.querySelectorAll('[data-user-name]');
        userNameElements.forEach(el => {
            el.textContent = displayName;
        });

        // 更新用户角色标签
        const roleElements = document.querySelectorAll('[data-user-role]');
        roleElements.forEach(el => {
            el.textContent = displayRole;
        });

        // 更新用户邮箱
        const emailElements = document.querySelectorAll('[data-user-email]');
        emailElements.forEach(el => {
            el.textContent = user?.email || guest?.email || 'N/A';
        });
    }

    /**
     * 获取角色显示标签
     * @param {string} role - 角色代码
     * @returns {string}
     */
    getRoleLabel(role) {
        const roleMap = {
            'admin': '管理员',
            'manager': '主管',
            'operator': '操作人员',
            'viewer': '查看者',
            'guest': '访客'
        };
        return roleMap[role] || role;
    }

    /**
     * 验证 Token 并自动刷新
     */
    async validateAndRefreshToken() {
        if (!authService.isAuthenticated()) {
            console.warn('⚠️ Token 无效或过期');
            this.handleLogout();
            return false;
        }

        // 如果 Token 快要过期，自动刷新
        if (authService.isTokenExpired()) {
            console.log('🔄 Token 即将过期，自动刷新...');
            const result = await authService.refreshToken();
            if (!result.success) {
                this.handleLogout();
                return false;
            }
        }

        return true;
    }

    /**
     * 设置定期检查 Token 有效性
     * @param {number} intervalMs - 检查间隔（毫秒）
     */
    startTokenValidationTimer(intervalMs = 60000) {
        console.log('⏱️  启动 Token 定期验证 (间隔: ' + intervalMs / 1000 + '秒)');
        
        setInterval(async () => {
            await this.validateAndRefreshToken();
        }, intervalMs);
    }

    /**
     * 处理用户空闲超时（30分钟）
     */
    setupIdleTimeout(timeoutMs = 30 * 60 * 1000) {
        let idleTimer;

        const resetIdleTimer = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                console.warn('⚠️ 用户已空闲30分钟，自动登出');
                alert('由于长时间未操作，系统已自动登出，请重新登录。');
                this.handleLogout();
            }, timeoutMs);
        };

        // 监听用户活动
        const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'click'];
        events.forEach(event => {
            document.addEventListener(event, resetIdleTimer, true);
        });

        // 初始启动计时器
        resetIdleTimer();

        console.log('⏰ 用户空闲超时检查已启用 (30分钟)');
    }

    /**
     * 初始化所有路由相关功能
     */
    setupAll() {
        // 🎯 暴露自己到全局作用域
        window.router = this;
        console.log('✅ setupAll() - window.router 已暴露');
        
        // 设置登出按钮
        this.setupLogoutButton();

        // 更新用户信息显示
        this.updateUserDisplay();

        // 根据权限更新导航
        this.updateNavigationByPermission();

        // 启动 Token 验证定时器
        this.startTokenValidationTimer(60000); // 每60秒检查一次

        // 设置用户空闲超时
        this.setupIdleTimeout(30 * 60 * 1000); // 30分钟

        // 监听权限变化，清除缓存
        window.addEventListener('permissionChanged', () => {
            permissionService.clearCache();
            this.updateNavigationByPermission();
        });

        console.log('✅ 路由与权限检查已就位');
    }
}

// 导出单例
export const router = new Router();

// 🎯 立即暴露到全局作用域
if (typeof window !== 'undefined') {
    window.router = router;
    console.log('✅ Router.js - window.router 已立即暴露');
}
