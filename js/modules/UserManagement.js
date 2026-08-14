/**
 * UserManagement - 用户管理模块
 * 提供用户 CRUD 操作、权限管理、用户列表展示
 */

import { authService } from '../services/AuthService.js';
import { UINotification } from '../utils/UINotification.js';
import { router } from '../core/Router.js';
import { auditService } from '../services/AuditService.js';
import { escapeHtml } from '../utils/schoolCustomization/shared.js';

export class UserManagement {
    constructor() {
        this.moduleName = '用户管理';
        this.users = [];
        this.allUsers = [];   // P13: 前端内存过滤的全量数据源
        this.currentPage = 1;
        this.pageSize = 10;
        this.totalUsers = 0;
        // TD-EventLeak-Phase2: 用于绑定事件时 abort 清理，避免重复 init 时监听器堆积
        this._abortCtrl = null;
    }

    /**
     * 角色权限等级（数值越高权限越大），用于 TD-Role-Guard 自我降级拦截
     */
    _roleRank(role) {
        const rank = { admin: 5, manager: 4, operator: 3, viewer: 2, guest: 1 };
        return rank[role] || 0;
    }

    /**
     * 初始化模块
     */
    init() {
        console.log('🔧 ' + this.moduleName + ' 初始化中...');

        // TD-EventLeak-Phase2: 重置控制器，abort 掉上一次 init 绑定的监听器
        this._abortCtrl?.abort();
        this._abortCtrl = new AbortController();

        this.renderUI();
        this.bindEvents(this._abortCtrl.signal);
        this.loadUsers();

        console.log('✅ ' + this.moduleName + ' 初始化完成');
        return true;
    }

    /**
     * 渲染用户管理 UI
     */
    renderUI() {
        const content = document.getElementById('user-management');
        
        if (!content) {
            console.warn('⚠️ 找不到 id="user-management" 的容器');
            return;
        }

        content.innerHTML = `
            <div class="space-y-6">
                <!-- 标题 -->
                <div class="flex justify-between items-center">
                    <h2 class="text-2xl font-bold text-gray-800 flex items-center">
                        <i class="fas fa-users text-blue-600 mr-3"></i>用户管理
                    </h2>
                    <button id="btnCreateUser" class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition flex items-center">
                        <i class="fas fa-plus mr-2"></i>创建用户
                    </button>
                </div>

                <!-- 搜索与过滤 -->
                <div class="bg-white rounded-lg shadow-md p-4 flex gap-4">
                    <div class="flex-1">
                        <input 
                            type="text" 
                            id="searchInput"
                            placeholder="搜索用户名或手机号..."
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        >
                    </div>
                    <select id="roleFilter" class="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="">所有角色</option>
                        <option value="manager">主管</option>
                        <option value="operator">操作人员</option>
                        <option value="viewer">查看者</option>
                    </select>
                    <button id="btnSearch" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
                        <i class="fas fa-search mr-2"></i>搜索
                    </button>
                </div>

                <!-- 用户列表 -->
                <div class="bg-white rounded-lg shadow-md overflow-hidden">
                    <table class="w-full">
                        <thead class="bg-gray-100 border-b">
                            <tr>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">用户名</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">手机号</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">角色</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">创建时间</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">状态</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">操作</th>
                            </tr>
                        </thead>
                        <tbody id="userTable" class="divide-y">
                            <!-- 用户行将插入这里 -->
                        </tbody>
                    </table>
                </div>

                <!-- 分页 -->
                <div class="flex justify-between items-center">
                    <div class="text-sm text-gray-600">
                        共 <span id="totalCount">0</span> 个用户，第 <span id="currentPage">1</span> 页
                    </div>
                    <div class="space-x-2">
                        <button id="btnPrevPage" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition">
                            <i class="fas fa-chevron-left mr-2"></i>上一页
                        </button>
                        <button id="btnNextPage" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition">
                            下一页<i class="fas fa-chevron-right ml-2"></i>
                        </button>
                    </div>
                </div>
            </div>

            <!-- 创建/编辑用户模态框 -->
            <div id="userModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
                <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
                    <h3 class="text-xl font-bold mb-4" id="modalTitle">创建新用户</h3>
                    <form id="userForm" class="space-y-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">用户名</label>
                            <input type="text" id="formUsername" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">手机号</label>
                            <input type="tel" id="formPhone" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="请输入手机号（选填）">
                        </div>
                        <div id="passwordDiv">
                            <label class="block text-sm font-medium text-gray-700 mb-1" id="passwordLabel">密码</label>
                            <input type="password" id="formPassword" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">角色</label>
                            <select id="formRole" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <option value="operator">操作人员</option>
                                <option value="viewer">查看者</option>
                                <option value="manager">主管</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">真实姓名</label>
                            <input type="text" id="formFullName" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div class="flex gap-2 justify-end pt-4">
                            <button type="button" id="btnCancelUserModal" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400">取消</button>
                            <button type="submit" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">保存</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
    }

    /**
     * 绑定事件
     */
    bindEvents(signal) {
        // 创建用户按钮
        document.getElementById('btnCreateUser').addEventListener('click', () => this.showCreateModal(), { signal });

        // 搜索 (P13: 前端内存过滤,读取搜索词与角色后 applyFilter)
        document.getElementById('btnSearch').addEventListener('click', () => this.applyFilter(), { signal });

        // 分页
        document.getElementById('btnPrevPage').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.applyFilter();
            }
        }, { signal });

        document.getElementById('btnNextPage').addEventListener('click', () => {
            if (this.currentPage * this.pageSize < this.totalUsers) {
                this.currentPage++;
                this.applyFilter();
            }
        }, { signal });

        // 模态框事件
        document.getElementById('btnCancelUserModal').addEventListener('click', () => this.closeModal(), { signal });
        document.getElementById('userForm').addEventListener('submit', (e) => this.handleFormSubmit(e), { signal });
    }

    /**
     * 加载用户列表
     */
    async loadUsers() {
        try {
            UINotification.loading('正在加载用户列表...');

            // P13: 前端内存过滤——一次拉取全量用户,后续按搜索词/角色在前端过滤
            const result = await authService.listUsers(1, 100000);

            if (result.success) {
                this.allUsers = result.users || [];
                this.totalUsers = this.allUsers.length;
                this.applyFilter();
                UINotification.success('用户列表已加载');
            } else {
                UINotification.error('加载用户列表失败: ' + (result.message || '未知错误'));
            }
        } catch (error) {
            console.error('❌ 加载用户列表错误:', error);
            UINotification.error('加载用户列表时出错');
        }
    }

    /**
     * P13: 前端内存过滤——按搜索词(用户名/手机号)与角色筛选,再渲染
     */
    applyFilter() {
        const keyword = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
        const role = document.getElementById('roleFilter')?.value || '';

        let filtered = this.allUsers || [];
        if (keyword) {
            filtered = filtered.filter(u =>
                (u.username || '').toLowerCase().includes(keyword) ||
                (u.phone || '').includes(keyword)
            );
        }
        if (role) {
            filtered = filtered.filter(u => u.role === role);
        }

        this.users = filtered;
        this.totalUsers = filtered.length;
        this.renderUserTable();
    }

    /**
     * 渲染用户表格
     */
    renderUserTable() {
        const tableBody = document.getElementById('userTable');
        tableBody.innerHTML = '';

        this.users.forEach(user => {
            const row = document.createElement('tr');
            row.className = 'hover:bg-gray-50 transition';
            row.innerHTML = `
                <td class="px-6 py-4">
                    <div class="flex items-center">
                        <div class="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center mr-3">
                            <i class="fas fa-user text-blue-600 text-sm"></i>
                        </div>
                        <span class="font-medium text-gray-800">${escapeHtml(user.username)}</span>
                    </div>
                </td>
                <td class="px-6 py-4 text-gray-600">${escapeHtml(user.phone) || '未填写'}</td>
                <td class="px-6 py-4">
                    <span class="px-3 py-1 rounded-full text-sm font-medium ${this.getRoleColor(user.role)}">
                        ${router.getRoleLabel(user.role)}
                    </span>
                </td>
                <td class="px-6 py-4 text-gray-600">${new Date(user.created_at).toLocaleDateString()}</td>
                <td class="px-6 py-4">
                    <span class="px-3 py-1 rounded-full text-sm font-medium ${user.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                        ${user.is_active ? '正常' : '已禁用'}
                    </span>
                </td>
                <td class="px-6 py-4 space-x-2">
                    <button class="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm btn-edit-user" data-user-id="${user.id}">
                        <i class="fas fa-edit mr-1"></i>编辑
                    </button>
                    <button class="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm btn-delete-user" data-user-id="${user.id}">
                        <i class="fas fa-trash mr-1"></i>删除
                    </button>
                </td>
            `;
            tableBody.appendChild(row);
        });

        document.getElementById('totalCount').textContent = this.totalUsers;
        document.getElementById('currentPage').textContent = this.currentPage;

        // 绑定编辑按钮（事件委托，避免 JSON 在 onclick HTML 属性中的引号冲突）
        tableBody.querySelectorAll('.btn-edit-user').forEach(btn => {
            const userId = btn.dataset.userId;
            const user = this.users.find(u => String(u.id) === String(userId));
            if (user) {
                btn.addEventListener('click', () => this.showEditModal(user));
            }
        });

        // 绑定删除按钮（事件委托，替代内联 onclick，不再依赖全局 window.userMgmt）
        tableBody.querySelectorAll('.btn-delete-user').forEach(btn => {
            const userId = btn.dataset.userId;
            btn.addEventListener('click', () => this.deleteUser(userId));
        });
    }

    /**
     * 获取角色颜色
     */
    getRoleColor(role) {
        const colorMap = {
            'admin': 'bg-red-100 text-red-800',
            'manager': 'bg-purple-100 text-purple-800',
            'operator': 'bg-blue-100 text-blue-800',
                'viewer': 'bg-gray-100 text-gray-800'
            };
        return colorMap[role] || 'bg-gray-100 text-gray-800';
    }

    /**
     * 显示创建用户模态框
     */
    showCreateModal() {
        const form = document.getElementById('userForm');
        form.reset();
        document.getElementById('modalTitle').textContent = '创建新用户';
        document.getElementById('passwordLabel').textContent = '密码';
        document.getElementById('passwordDiv').classList.remove('hidden');
        document.getElementById('formPassword').required = true;
        this.currentEditId = null;
        document.getElementById('userModal').classList.remove('hidden');
    }

    /**
     * 显示编辑用户模态框
     */
    showEditModal(user) {
        document.getElementById('modalTitle').textContent = '编辑用户: ' + user.username;
        document.getElementById('formUsername').value = user.username;
        document.getElementById('formPhone').value = user.phone || '';
        document.getElementById('formRole').value = user.role;
        document.getElementById('formFullName').value = user.fullName || user.full_name || '';
        document.getElementById('passwordLabel').textContent = '新密码（留空则不修改）';
        document.getElementById('passwordDiv').classList.remove('hidden');
        document.getElementById('formPassword').required = false;
        document.getElementById('formPassword').value = '';
        this.currentEditId = user.id;
        document.getElementById('userModal').classList.remove('hidden');
    }

    /**
     * 关闭模态框
     */
    closeModal() {
        document.getElementById('userModal').classList.add('hidden');
    }

    /**
     * 处理表单提交
     */
    async handleFormSubmit(e) {
        e.preventDefault();

        const username = document.getElementById('formUsername').value;
        const phone = document.getElementById('formPhone').value.trim();
        const password = document.getElementById('formPassword').value;
        const role = document.getElementById('formRole').value;
        const fullName = document.getElementById('formFullName').value;

        try {
            if (this.currentEditId) {
                // TD-Role-Guard: 禁止当前登录用户修改自己的角色（含降级），避免锁死管理员权限
                const currentUser = authService.getUser();
                if (currentUser && String(currentUser.id) === String(this.currentEditId) && role !== currentUser.role) {
                    UINotification.error('❌ 不能修改当前登录账号的角色');
                    return;
                }

                // 编辑用户
                UINotification.loading('正在保存用户信息...');
                const result = await authService.updateUser(this.currentEditId, { username, phone, fullName, role });
                if (!result.success) {
                    UINotification.error('更新用户失败: ' + result.message);
                    return;
                }
                // 如果填写了新密码，则同步重置密码
                if (password) {
                    const pwResult = await authService.adminResetPassword(this.currentEditId, password);
                    if (!pwResult.success) {
                        UINotification.error('用户信息已保存，但密码重置失败: ' + pwResult.message);
                        this.closeModal();
                        this.loadUsers();
                        return;
                    }
                }
                UINotification.success('用户信息已更新');
                auditService.log('update', 'users', null, `修改用户 ${username || this.currentEditId}`);
                this.closeModal();
                this.loadUsers();
            } else {
                // 创建新用户
                UINotification.loading('正在创建用户...');
                const result = await authService.registerUser({ username, phone, password, fullName, role });
                if (result.success) {
                    UINotification.success('用户已创建');
                    auditService.log('create', 'users', null, `新增用户 ${username}`);
                    this.closeModal();
                    this.loadUsers();
                } else {
                    UINotification.error('创建用户失败: ' + result.message);
                }
            }
        } catch (error) {
            console.error('❌ 表单提交错误:', error);
            UINotification.error('保存用户时出错');
        }
    }

    /**
     * 删除用户
     */
    async deleteUser(userId) {
        // TD-Role-Guard: 禁止删除当前登录的账号
        const currentUser = authService.getUser();
        if (currentUser && String(currentUser.id) === String(userId)) {
            UINotification.error('❌ 不能删除当前登录的账号');
            return;
        }

        // TD-Role-Guard: 禁止删除最后一个管理员账号（前端尽职防御，权威校验在后端）
        const user = this.users?.find(u => String(u.id) === String(userId)) || {}
        if (user.role === 'admin') {
            const adminCount = this.users.filter(u => u.role === 'admin' && u.is_active !== false).length;
            if (adminCount <= 1) {
                UINotification.error('❌ 不能删除最后一个管理员账号');
                return;
            }
        }

        // P1-17: 升级为两步确认，显示用户名，防止误删
        // P1-2: 原生 confirm → UINotification.confirm（iframe 预览下可用）
        const displayName = user.username || user.name || userId
        const firstConfirm = await UINotification.confirm(`⚠️ 即将删除用户「${displayName}」\n\n此操作不可撤销，确定要继续吗？`, '删除确认')
        if (!firstConfirm) return
        const secondConfirm = await UINotification.confirm(`请再次确认：\n\n确定要永久删除用户「${displayName}」吗？`, '再次确认')
        if (!secondConfirm) return

        try {
            UINotification.loading('正在删除用户...');
            const result = await authService.deleteUser(userId);
            if (result.success) {
                UINotification.success('用户已删除');
                auditService.log('delete', 'users', null, `删除用户 ID: ${userId}`);
                this.loadUsers();
            } else {
                UINotification.error('删除用户失败: ' + result.message);
            }
        } catch (error) {
            console.error('❌ 删除用户错误:', error);
            UINotification.error('删除用户时出错');
        }
    }
}

// 导出并初始化
export function initUserManagement() {
    const userMgmt = new UserManagement();
    userMgmt.init();
    return userMgmt;
}
