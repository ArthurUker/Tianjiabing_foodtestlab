/**
 * PermissionService - 权限管理服务
 * 处理细粒度权限检查、角色权限映射、权限缓存
 */

import { authService } from './AuthService.js';

export class PermissionService {
    constructor() {
        this.permissionCache = new Map();
        this.rolePermissionMap = this.initRolePermissions();
        // P1-10: 权限缓存 TTL（5 分钟），防止权限变更后缓存永不失效
        this.PERMISSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * 初始化角色权限映射表
     * @returns {object} 角色与权限的映射
     */
    initRolePermissions() {
        return {
            'admin': [
                // 所有权限
                'records:read', 'records:create', 'records:update', 'records:delete',
                'export:pdf', 'export:excel',
                'backup:view', 'backup:create', 'backup:restore',
                'users:read', 'users:create', 'users:update', 'users:delete',
                'audit:view', 'audit:export',
                'settings:view', 'settings:update',
                // 模块权限
                'module:tableware', 'module:pesticide', 'module:oil', 'module:leanMeat', 'module:pathogen'
            ],
            'manager': [
                // 主管权限
                'records:read', 'records:create', 'records:update',
                'export:pdf', 'export:excel',
                'backup:view',
                'users:read',
                'audit:view',
                // 模块权限
                'module:tableware', 'module:pesticide', 'module:oil', 'module:leanMeat', 'module:pathogen'
            ],
            'operator': [
                // 操作人员权限
                'records:read', 'records:create', 'records:update',
                'export:pdf',
                // 模块权限
                'module:tableware', 'module:pesticide', 'module:oil', 'module:leanMeat', 'module:pathogen'
            ],
            'viewer': [
                // 查看者权限 (只读)
                'records:read',
                'export:pdf',
                // 模块权限
                'module:tableware', 'module:pesticide', 'module:oil', 'module:leanMeat', 'module:pathogen'
            ],
            'guest': [
                // 访客权限 (最小权限)
                'records:read',
                // 模块权限 - 访客只能看基础模块，不能看病原体检测
                'module:tableware', 'module:pesticide', 'module:oil', 'module:leanMeat'
                // ❌ 注意：故意不添加 'module:pathogen'，这样访客就看不到病原体检测模块
            ]
        };
    }

    /**
     * 获取当前用户的所有权限
     * @returns {array} 权限列表
     */
    getCurrentUserPermissions() {
        const user = authService.getUser();
        
        // 如果是访客用户，返回访客的权限列表
        if (!user) {
            // 动态导入 GuestAuthService（避免循环依赖）
            import('./GuestAuthService.js').then(module => {
                const guestAuthService = module.default || new module.GuestAuthService();
                const isGuest = guestAuthService.isLoggedIn();
                if (isGuest) {
                    return this.rolePermissionMap['guest'] || [];
                }
            }).catch(() => {
                // 如果导入失败，返回空数组
                return [];
            });
            
            // 同步返回访客权限（简化版本）
            // 检查 localStorage 中是否有访客令牌
            if (typeof localStorage !== 'undefined' && localStorage.getItem('guest_token')) {
                console.log('✅ 识别为访客用户，返回访客权限');
                return this.rolePermissionMap['guest'] || [];
            }
            
            return [];
        }

        // 检查缓存（P1-10: 增加 TTL 过期检查，过期则清除并回源）
        if (this.permissionCache.has(user.id)) {
            const cached = this.permissionCache.get(user.id);
            if (cached && (Date.now() - cached.cachedAt) < this.PERMISSION_CACHE_TTL) {
                return cached.permissions;
            }
            this.permissionCache.delete(user.id); // 过期则清除
        }

        // 获取用户权限
        const permissions = this.rolePermissionMap[user.role] || [];

        // 如果用户有自定义权限，合并处理
        if (user.permissions && Array.isArray(user.permissions)) {
            const combinedPermissions = [...new Set([...permissions, ...user.permissions])];
            // P1-10: 缓存写入时记录时间戳
            this.permissionCache.set(user.id, { permissions: combinedPermissions, cachedAt: Date.now() });
            return combinedPermissions;
        }

        // 缓存权限（P1-10: 记录时间戳）
        this.permissionCache.set(user.id, { permissions: permissions, cachedAt: Date.now() });
        return permissions;
    }

    /**
     * 检查用户是否有指定权限
     * @param {string} permission - 权限代码 (如 'records:read')
     * @returns {boolean}
     */
    hasPermission(permission) {
        const permissions = this.getCurrentUserPermissions();
        return permissions.includes(permission);
    }

    /**
     * 检查用户是否有任意一个权限 (OR 逻辑)
     * @param {array} permissions - 权限数组
     * @returns {boolean}
     */
    hasAnyPermission(permissions) {
        const userPermissions = this.getCurrentUserPermissions();
        return permissions.some(p => userPermissions.includes(p));
    }

    /**
     * 检查用户是否有所有权限 (AND 逻辑)
     * @param {array} permissions - 权限数组
     * @returns {boolean}
     */
    hasAllPermissions(permissions) {
        const userPermissions = this.getCurrentUserPermissions();
        return permissions.every(p => userPermissions.includes(p));
    }

    /**
     * 检查用户角色
     * @param {string|array} role - 角色代码或数组
     * @returns {boolean}
     */
    hasRole(role) {
        const user = authService.getUser();
        if (!user) return false;

        if (Array.isArray(role)) {
            return role.includes(user.role);
        }
        return user.role === role;
    }

    /**
     * 获取权限标签 (用于 UI 显示)
     * @param {string} permission - 权限代码
     * @returns {string}
     */
    getPermissionLabel(permission) {
        const labels = {
            'records:read': '查看检测记录',
            'records:create': '创建检测记录',
            'records:update': '编辑检测记录',
            'records:delete': '删除检测记录',
            'export:pdf': '导出 PDF',
            'export:excel': '导出 Excel',
            'backup:view': '查看备份',
            'backup:create': '创建备份',
            'backup:restore': '恢复备份',
            'users:read': '查看用户',
            'users:create': '创建用户',
            'users:update': '编辑用户',
            'users:delete': '删除用户',
            'audit:view': '查看审计日志',
            'audit:export': '导出审计日志',
            'settings:view': '查看系统设置',
            'settings:update': '修改系统设置'
        };
        return labels[permission] || permission;
    }

    /**
     * 清除权限缓存 (用户信息变更后调用)
     */
    clearCache() {
        this.permissionCache.clear();
        console.log('✅ 权限缓存已清空');
    }

    /**
     * 获取用户角色的所有权限
     * @param {string} role - 角色代码
     * @returns {array}
     */
    getRolePermissions(role) {
        return this.rolePermissionMap[role] || [];
    }

    /**
     * 获取所有角色列表
     * @returns {array}
     */
    getAllRoles() {
        return Object.keys(this.rolePermissionMap);
    }

    /**
     * 判断权限是否为"删除"操作 (需要额外确认)
     * @param {string} permission - 权限代码
     * @returns {boolean}
     */
    isDangerousOperation(permission) {
        return ['records:delete', 'users:delete', 'backup:restore'].includes(permission);
    }

    /**
     * 根据权限获取需要确认的操作描述
     * @param {string} permission - 权限代码
     * @returns {string}
     */
    getConfirmationMessage(permission) {
        const messages = {
            'records:delete': '确定要删除这条记录吗？该操作不可撤销。',
            'users:delete': '确定要删除这个用户吗？该操作不可撤销，用户相关数据也会被清除。',
            'backup:restore': '确定要恢复此备份吗？这将覆盖所有当前数据。'
        };
        return messages[permission] || '确定要执行此操作吗？';
    }

    /**
     * 检查操作是否安全 (如需要额外确认则返回 false)
     * @param {string} permission - 权限代码
     * @param {boolean} confirmed - 用户是否已确认
     * @returns {boolean}
     */
    isSafeOperation(permission, confirmed = false) {
        if (this.isDangerousOperation(permission)) {
            return confirmed;
        }
        return true;
    }
}

// 导出单例
export const permissionService = new PermissionService();
