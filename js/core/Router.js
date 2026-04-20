/**
 * Router - 路由与权限守卫管理器
 * 处理页面导航、登录状态检查、权限验证
 */

import { authService } from '../services/AuthService.js';
import { permissionService } from '../services/PermissionService.js';

export class Router {
    constructor() {
        this.currentPage = null;
        this.isInitialized = false;
    }

    /**
     * 初始化路由
     */
    async init() {
        if (this.isInitialized) return;
        
        console.log('🔧 Router 初始化中...');

        // 检查用户是否已登录
        const isAuthenticated = authService.isAuthenticated();
        const currentUrl = window.location.pathname;

        // 如果用户未登录，重定向到登录页
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

        // 监听存储变化（用于跨标签页登出同步）
        window.addEventListener('storage', (e) => {
            if (e.key === 'auth_token' && !authService.getToken()) {
                console.log('🔔 用户在其他标签页登出，本页面也进行登出');
                this.handleLogout();
            }
        });

        console.log('✅ Router 初始化完成');
        this.isInitialized = true;
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
        
        if (!user) return;

        // 管理员菜单项
        if (user.role !== 'admin') {
            // 隐藏管理员才能访问的菜单项
            this.toggleElementByPermission('[data-admin-only]', false);
        }

        // 根据角色显示不同的菜单
        const navItems = document.querySelectorAll('.nav-btn');
        navItems.forEach(item => {
            const requiredRole = item.getAttribute('data-required-role');
            if (requiredRole && user.role !== requiredRole) {
                item.classList.add('hidden');
            }
        });
    }

    /**
     * 处理登出
     */
    async handleLogout() {
        await authService.logout();
        window.location.href = './login.html';
    }

    /**
     * 设置登出按钮事件
     */
    setupLogoutButton() {
        const logoutBtn = document.getElementById('btnLogout');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => this.handleLogout());
        }

        // 也可以通过菜单项登出
        const logoutMenuItems = document.querySelectorAll('[data-logout]');
        logoutMenuItems.forEach(item => {
            item.addEventListener('click', () => this.handleLogout());
        });
    }

    /**
     * 更新用户信息显示
     */
    updateUserDisplay() {
        const user = authService.getUser();
        
        if (!user) return;

        // 更新导航栏中的用户名
        const userNameElements = document.querySelectorAll('[data-user-name]');
        userNameElements.forEach(el => {
            el.textContent = user.username;
        });

        // 更新用户角色标签
        const roleElements = document.querySelectorAll('[data-user-role]');
        roleElements.forEach(el => {
            el.textContent = this.getRoleLabel(user.role);
        });

        // 更新用户邮箱
        const emailElements = document.querySelectorAll('[data-user-email]');
        emailElements.forEach(el => {
            el.textContent = user.email || 'N/A';
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
