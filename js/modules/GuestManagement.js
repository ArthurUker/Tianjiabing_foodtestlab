/**
 * GuestManagement - 访客管理模块
 * 处理访客的创建、管理、权限分配
 * 访客是临时用户，拥有受限权限，自动过期
 */

import { authService } from '../services/AuthService.js';
import { permissionService } from '../services/PermissionService.js';
import { UINotification } from '../utils/UINotification.js';
import { router } from '../core/Router.js';

export class GuestManagement {
    constructor() {
        this.moduleName = '访客管理';
        this.guests = [];
        this.currentPage = 1;
        this.pageSize = 15;
        this.totalGuests = 0;
        this.editingGuest = null;
    }

    /**
     * 初始化模块
     */
    init() {
        console.log('🔧 ' + this.moduleName + ' 初始化中...');
        
        // 检查权限
        if (!router.isAdmin()) {
            console.warn('⚠️ 用户无权访问访客管理模块');
            return false;
        }

        this.renderUI();
        this.bindEvents();
        this.loadGuests();

        console.log('✅ ' + this.moduleName + ' 初始化完成');
        return true;
    }

    /**
     * 渲染访客管理 UI
     */
    renderUI() {
        const content = document.getElementById('guest-management');
        
        if (!content) {
            console.warn('⚠️ 找不到 id="guest-management" 的容器');
            return;
        }

        content.innerHTML = `
            <div class="space-y-6">
                <!-- 标题 -->
                <div class="flex justify-between items-center">
                    <h2 class="text-2xl font-bold text-gray-800 flex items-center">
                        <i class="fas fa-user-friends text-blue-600 mr-3"></i>访客管理
                    </h2>
                    <button id="btnCreateGuest" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center">
                        <i class="fas fa-user-plus mr-2"></i>创建访客账号
                    </button>
                </div>

                <!-- 过滤与搜索 -->
                <div class="bg-white rounded-lg shadow-md p-4 space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <!-- 搜索框 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">搜索</label>
                            <input 
                                type="text" 
                                id="guestSearchInput"
                                placeholder="按用户名/邮箱搜索..."
                                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                        </div>

                        <!-- 状态过滤 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">状态</label>
                            <select id="guestStatusFilter" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <option value="">所有状态</option>
                                <option value="active">活跃</option>
                                <option value="expired">已过期</option>
                                <option value="disabled">已禁用</option>
                            </select>
                        </div>

                        <!-- 有效期过滤 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">有效期范围</label>
                            <select id="guestExpiryFilter" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <option value="">所有</option>
                                <option value="today">今天</option>
                                <option value="week">本周</option>
                                <option value="month">本月</option>
                                <option value="expired">已过期</option>
                            </select>
                        </div>

                        <!-- 权限过滤 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">权限等级</label>
                            <select id="guestPermissionFilter" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <option value="">所有</option>
                                <option value="viewer">只读</option>
                                <option value="operator">操作</option>
                                <option value="custom">自定义</option>
                            </select>
                        </div>
                    </div>

                    <div class="flex gap-2">
                        <button id="btnSearchGuests" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
                            <i class="fas fa-search mr-2"></i>搜索
                        </button>
                        <button id="btnClearGuestFilters" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition">
                            <i class="fas fa-times mr-2"></i>清除
                        </button>
                    </div>
                </div>

                <!-- 访客列表 -->
                <div class="bg-white rounded-lg shadow-md overflow-hidden">
                    <table class="w-full">
                        <thead class="bg-gray-100 border-b">
                            <tr>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">用户名</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">邮箱</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">权限等级</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">创建时间</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">过期时间</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">状态</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">操作</th>
                            </tr>
                        </thead>
                        <tbody id="guestTable" class="divide-y">
                            <!-- 访客行将插入这里 -->
                        </tbody>
                    </table>
                </div>

                <!-- 分页 -->
                <div class="flex justify-between items-center">
                    <div class="text-sm text-gray-600">
                        共 <span id="guestTotalCount">0</span> 个访客，第 <span id="guestCurrentPage">1</span> 页
                    </div>
                    <div class="space-x-2">
                        <button id="btnGuestPrevPage" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition">
                            <i class="fas fa-chevron-left mr-2"></i>上一页
                        </button>
                        <button id="btnGuestNextPage" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition">
                            下一页<i class="fas fa-chevron-right ml-2"></i>
                        </button>
                    </div>
                </div>
            </div>

            <!-- 创建/编辑访客模态框 -->
            <div id="guestFormModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
                <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-96 overflow-y-auto">
                    <h3 class="text-xl font-bold mb-4" id="guestFormTitle">创建访客账号</h3>
                    <form id="guestForm" class="space-y-4">
                        <!-- 用户名 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">用户名</label>
                            <input 
                                type="text" 
                                id="guestUsername"
                                placeholder="输入访客用户名..."
                                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                required
                            >
                        </div>

                        <!-- 邮箱 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
                            <input 
                                type="email" 
                                id="guestEmail"
                                placeholder="输入邮箱地址..."
                                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                required
                            >
                        </div>

                        <!-- 密码 -->
                        <div id="guestPasswordDiv">
                            <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
                            <input 
                                type="password" 
                                id="guestPassword"
                                placeholder="输入密码 (至少 8 字符)..."
                                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                minlength="8"
                                required
                            >
                            <p class="text-xs text-gray-500 mt-1">至少 8 个字符，建议包含大小写字母、数字和特殊字符</p>
                        </div>

                        <!-- 有效期天数 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">有效期 (天)</label>
                            <select id="guestDays" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" required>
                                <option value="">选择有效期...</option>
                                <option value="1">1 天</option>
                                <option value="3">3 天</option>
                                <option value="7">1 周</option>
                                <option value="14">2 周</option>
                                <option value="30">1 个月</option>
                                <option value="90">3 个月</option>
                            </select>
                        </div>

                        <!-- 权限等级 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">权限等级</label>
                            <select id="guestPermLevel" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" required>
                                <option value="viewer">只读 (仅查看记录)</option>
                                <option value="operator">操作 (可查看和创建)</option>
                                <option value="custom">自定义 (勾选具体权限)</option>
                            </select>
                        </div>

                        <!-- 自定义权限 (条件显示) -->
                        <div id="customPermissionsDiv" class="hidden">
                            <label class="block text-sm font-medium text-gray-700 mb-2">选择权限</label>
                            <div class="space-y-2 bg-gray-50 p-3 rounded-lg max-h-40 overflow-y-auto">
                                <label class="flex items-center">
                                    <input type="checkbox" value="records:read" class="custom-permission mr-2">
                                    <span>查看检测记录</span>
                                </label>
                                <label class="flex items-center">
                                    <input type="checkbox" value="records:create" class="custom-permission mr-2">
                                    <span>创建检测记录</span>
                                </label>
                                <label class="flex items-center">
                                    <input type="checkbox" value="export:pdf" class="custom-permission mr-2">
                                    <span>导出 PDF</span>
                                </label>
                                <label class="flex items-center">
                                    <input type="checkbox" value="export:excel" class="custom-permission mr-2">
                                    <span>导出 Excel</span>
                                </label>
                            </div>
                        </div>

                        <!-- 备注 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">备注</label>
                            <textarea 
                                id="guestRemark"
                                placeholder="输入备注 (可选)..."
                                rows="3"
                                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                            ></textarea>
                        </div>
                    </form>

                    <div class="flex justify-end gap-2 mt-6">
                        <button id="btnCloseGuestForm" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400">取消</button>
                        <button id="btnSubmitGuestForm" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">保存</button>
                    </div>
                </div>
            </div>

            <!-- 访客详情模态框 -->
            <div id="guestDetailModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
                <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-96 overflow-y-auto">
                    <h3 class="text-xl font-bold mb-4">访客详情</h3>
                    <div class="space-y-4" id="guestDetailContent">
                        <!-- 详情内容将插入这里 -->
                    </div>
                    <button id="btnCloseDetail" class="mt-6 px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400">关闭</button>
                </div>
            </div>
        `;
    }

    /**
     * 绑定事件
     */
    bindEvents() {
        // 创建访客
        document.getElementById('btnCreateGuest').addEventListener('click', () => this.showCreateForm());

        // 搜索
        document.getElementById('btnSearchGuests').addEventListener('click', () => this.loadGuests());

        // 清除筛选
        document.getElementById('btnClearGuestFilters').addEventListener('click', () => this.clearFilters());

        // 分页
        document.getElementById('btnGuestPrevPage').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.loadGuests();
            }
        });

        document.getElementById('btnGuestNextPage').addEventListener('click', () => {
            if (this.currentPage * this.pageSize < this.totalGuests) {
                this.currentPage++;
                this.loadGuests();
            }
        });

        // 表单
        document.getElementById('btnCloseGuestForm').addEventListener('click', () => {
            document.getElementById('guestFormModal').classList.add('hidden');
        });

        document.getElementById('btnSubmitGuestForm').addEventListener('click', () => this.handleFormSubmit());

        // 权限等级变更
        document.getElementById('guestPermLevel').addEventListener('change', (e) => {
            const customDiv = document.getElementById('customPermissionsDiv');
            if (e.target.value === 'custom') {
                customDiv.classList.remove('hidden');
            } else {
                customDiv.classList.add('hidden');
            }
        });

        // 关闭详情
        document.getElementById('btnCloseDetail').addEventListener('click', () => {
            document.getElementById('guestDetailModal').classList.add('hidden');
        });
    }

    /**
     * 加载访客列表
     */
    async loadGuests() {
        try {
            UINotification.loading('正在加载访客列表...');

            // 模拟访客数据 (实际应从后端 API 获取)
            // TODO: 调用 GET /api/guest/list API
            const mockGuests = this.generateMockGuests();

            this.guests = mockGuests;
            this.totalGuests = mockGuests.length;
            this.renderGuestTable();

            UINotification.success('访客列表已加载 (' + mockGuests.length + ' 个)');
        } catch (error) {
            console.error('❌ 加载访客列表错误:', error);
            UINotification.error('加载访客列表时出错');
        }
    }

    /**
     * 生成模拟访客数据
     */
    generateMockGuests() {
        const guests = [];
        const now = new Date();

        const guestNames = ['guest_001', 'guest_002', 'guest_003', 'visitor_a', 'visitor_b'];
        const statuses = ['active', 'expired', 'disabled'];
        const perms = ['viewer', 'operator', 'custom'];

        for (let i = 0; i < 15; i++) {
            const createdDate = new Date(now.getTime() - Math.random() * 30 * 24 * 60 * 60 * 1000);
            const expiryDate = new Date(createdDate.getTime() + (Math.random() > 0.5 ? 30 : 90) * 24 * 60 * 60 * 1000);

            guests.push({
                id: 2000 + i,
                username: guestNames[Math.floor(Math.random() * guestNames.length)] + '_' + i,
                email: `guest${i}@example.com`,
                permLevel: perms[Math.floor(Math.random() * perms.length)],
                createdAt: createdDate.toISOString().slice(0, 10),
                expiryAt: expiryDate.toISOString().slice(0, 10),
                status: expiryDate < now ? 'expired' : statuses[Math.floor(Math.random() * (statuses.length - 1))],
                permissions: ['records:read', 'export:pdf'],
                remark: '临时访客账号'
            });
        }

        return guests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    /**
     * 渲染访客表格
     */
    renderGuestTable() {
        const tableBody = document.getElementById('guestTable');
        tableBody.innerHTML = '';

        const startIdx = (this.currentPage - 1) * this.pageSize;
        const endIdx = startIdx + this.pageSize;
        const pageData = this.guests.slice(startIdx, endIdx);

        pageData.forEach(guest => {
            const row = document.createElement('tr');
            row.className = 'hover:bg-gray-50 transition';

            const statusColor = {
                'active': 'bg-green-100 text-green-800',
                'expired': 'bg-red-100 text-red-800',
                'disabled': 'bg-gray-100 text-gray-800'
            }[guest.status];

            const statusLabel = {
                'active': '活跃',
                'expired': '已过期',
                'disabled': '已禁用'
            }[guest.status];

            row.innerHTML = `
                <td class="px-6 py-4 text-sm font-medium text-gray-800">${guest.username}</td>
                <td class="px-6 py-4 text-sm text-gray-600">${guest.email}</td>
                <td class="px-6 py-4 text-sm">
                    <span class="px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-800">
                        ${guest.permLevel === 'viewer' ? '只读' : guest.permLevel === 'operator' ? '操作' : '自定义'}
                    </span>
                </td>
                <td class="px-6 py-4 text-sm text-gray-600">${guest.createdAt}</td>
                <td class="px-6 py-4 text-sm text-gray-600">${guest.expiryAt}</td>
                <td class="px-6 py-4">
                    <span class="px-3 py-1 rounded-full text-sm font-medium ${statusColor}">
                        ${statusLabel}
                    </span>
                </td>
                <td class="px-6 py-4 text-sm space-x-2">
                    <button class="px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-xs" onclick="window.guestMgmt.showDetail(${JSON.stringify(guest)})">
                        <i class="fas fa-eye mr-1"></i>详情
                    </button>
                    <button class="px-2 py-1 bg-yellow-500 text-white rounded hover:bg-yellow-600 text-xs" onclick="window.guestMgmt.showEditForm(${JSON.stringify(guest)})">
                        <i class="fas fa-edit mr-1"></i>编辑
                    </button>
                    <button class="px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-xs" onclick="window.guestMgmt.deleteGuest(${guest.id})">
                        <i class="fas fa-trash mr-1"></i>删除
                    </button>
                </td>
            `;
            tableBody.appendChild(row);
        });

        document.getElementById('guestTotalCount').textContent = this.totalGuests;
        document.getElementById('guestCurrentPage').textContent = this.currentPage;
    }

    /**
     * 显示创建表单
     */
    showCreateForm() {
        this.editingGuest = null;
        document.getElementById('guestFormTitle').textContent = '创建访客账号';
        document.getElementById('guestForm').reset();
        document.getElementById('guestPasswordDiv').classList.remove('hidden');
        document.getElementById('customPermissionsDiv').classList.add('hidden');
        document.getElementById('guestFormModal').classList.remove('hidden');
    }

    /**
     * 显示编辑表单
     */
    showEditForm(guest) {
        this.editingGuest = guest;
        document.getElementById('guestFormTitle').textContent = '编辑访客账号';
        document.getElementById('guestUsername').value = guest.username;
        document.getElementById('guestEmail').value = guest.email;
        document.getElementById('guestPasswordDiv').classList.add('hidden');
        document.getElementById('guestDays').value = Math.ceil((new Date(guest.expiryAt) - new Date()) / (24 * 60 * 60 * 1000));
        document.getElementById('guestPermLevel').value = guest.permLevel;
        document.getElementById('guestRemark').value = guest.remark || '';
        
        document.getElementById('guestFormModal').classList.remove('hidden');
    }

    /**
     * 提交表单
     */
    async handleFormSubmit() {
        try {
            const username = document.getElementById('guestUsername').value.trim();
            const email = document.getElementById('guestEmail').value.trim();
            const days = document.getElementById('guestDays').value;
            const permLevel = document.getElementById('guestPermLevel').value;

            if (!username || !email || !days) {
                UINotification.error('请填写必填项');
                return;
            }

            if (!this.editingGuest) {
                const password = document.getElementById('guestPassword').value;
                if (!password || password.length < 8) {
                    UINotification.error('密码至少需要 8 个字符');
                    return;
                }
            }

            UINotification.loading('正在保存...');

            // TODO: 调用后端 API
            // const result = this.editingGuest 
            //     ? await authService.updateGuest(...)
            //     : await authService.createGuest(...);

            document.getElementById('guestFormModal').classList.add('hidden');
            UINotification.success(this.editingGuest ? '访客已更新' : '访客已创建');
            this.loadGuests();
        } catch (error) {
            console.error('❌ 保存访客错误:', error);
            UINotification.error('保存访客时出错');
        }
    }

    /**
     * 显示详情
     */
    showDetail(guest) {
        const content = document.getElementById('guestDetailContent');
        content.innerHTML = `
            <div class="space-y-3">
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <span class="text-sm text-gray-500">用户名</span>
                        <p class="font-medium">${guest.username}</p>
                    </div>
                    <div>
                        <span class="text-sm text-gray-500">邮箱</span>
                        <p class="font-medium">${guest.email}</p>
                    </div>
                    <div>
                        <span class="text-sm text-gray-500">权限等级</span>
                        <p class="font-medium">${guest.permLevel}</p>
                    </div>
                    <div>
                        <span class="text-sm text-gray-500">状态</span>
                        <p class="font-medium">${guest.status}</p>
                    </div>
                    <div>
                        <span class="text-sm text-gray-500">创建时间</span>
                        <p class="font-medium">${guest.createdAt}</p>
                    </div>
                    <div>
                        <span class="text-sm text-gray-500">过期时间</span>
                        <p class="font-medium">${guest.expiryAt}</p>
                    </div>
                </div>
                <hr>
                <div>
                    <span class="text-sm text-gray-500">权限清单</span>
                    <div class="mt-2 space-y-1">
                        ${(guest.permissions || []).map(p => `<p class="text-sm">• ${permissionService.getPermissionLabel(p)}</p>`).join('')}
                    </div>
                </div>
                <div>
                    <span class="text-sm text-gray-500">备注</span>
                    <p class="text-sm mt-1">${guest.remark || 'N/A'}</p>
                </div>
            </div>
        `;
        document.getElementById('guestDetailModal').classList.remove('hidden');
    }

    /**
     * 删除访客
     */
    async deleteGuest(guestId) {
        if (!confirm('确定要删除这个访客账号吗？')) {
            return;
        }

        try {
            UINotification.loading('正在删除...');
            // TODO: 调用 DELETE /api/guest/:id API
            UINotification.success('访客已删除');
            this.loadGuests();
        } catch (error) {
            console.error('❌ 删除访客错误:', error);
            UINotification.error('删除访客时出错');
        }
    }

    /**
     * 清除筛选
     */
    clearFilters() {
        document.getElementById('guestSearchInput').value = '';
        document.getElementById('guestStatusFilter').value = '';
        document.getElementById('guestExpiryFilter').value = '';
        document.getElementById('guestPermissionFilter').value = '';
        this.currentPage = 1;
        this.loadGuests();
    }
}

// 导出并初始化
export function initGuestManagement() {
    const guestMgmt = new GuestManagement();
    window.guestMgmt = guestMgmt;
    guestMgmt.init();
    return guestMgmt;
}
