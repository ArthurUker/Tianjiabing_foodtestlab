/**
 * 导出申请审批模块
 * 管理员用于审批访客的导出权限申请
 */

import { authService } from '../services/AuthService.js';
import { UINotification } from '../utils/UINotification.js';
import { router } from '../core/Router.js';

export class ExportApproval {
    constructor() {
        this.moduleName = '导出申请审批';
        this.requests = [];
        this.currentPage = 1;
        this.pageSize = 10;
        this.totalRequests = 0;
        this.filter = 'pending'; // pending, approved, rejected, all
    }

    /**
     * 初始化模块
     */
    init() {
        console.log('🔧 ' + this.moduleName + ' 初始化中...');

        // 检查权限
        if (!router.isAdmin()) {
            console.warn('⚠️ 用户无权访问导出申请审批模块');
            return false;
        }

        this.renderUI();
        this.bindEvents();
        this.loadRequests();

        console.log('✅ ' + this.moduleName + ' 初始化完成');
        return true;
    }

    /**
     * 渲染 UI
     */
    renderUI() {
        const content = document.getElementById('export-approval');
        
        if (!content) {
            console.warn('⚠️ 找不到 id="export-approval" 的容器');
            return;
        }

        content.innerHTML = `
            <div class="space-y-6">
                <!-- 标题 -->
                <div class="flex justify-between items-center">
                    <h2 class="text-2xl font-bold text-gray-800 flex items-center">
                        <i class="fas fa-file-check text-blue-600 mr-3"></i>导出申请审批
                    </h2>
                </div>

                <!-- 过滤器 -->
                <div class="bg-white rounded-lg shadow-md p-4">
                    <div class="flex gap-2">
                        <button class="filter-btn px-4 py-2 rounded-lg text-sm font-medium transition" data-filter="pending">
                            <i class="fas fa-clock mr-1"></i>待审批
                        </button>
                        <button class="filter-btn px-4 py-2 rounded-lg text-sm font-medium transition" data-filter="approved">
                            <i class="fas fa-check mr-1"></i>已批准
                        </button>
                        <button class="filter-btn px-4 py-2 rounded-lg text-sm font-medium transition" data-filter="rejected">
                            <i class="fas fa-times mr-1"></i>已拒绝
                        </button>
                        <button class="filter-btn px-4 py-2 rounded-lg text-sm font-medium transition" data-filter="all">
                            <i class="fas fa-list mr-1"></i>全部
                        </button>
                    </div>
                </div>

                <!-- 申请列表 -->
                <div class="bg-white rounded-lg shadow-md overflow-hidden">
                    <table class="w-full">
                        <thead class="bg-gray-100 border-b">
                            <tr>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">访客名称</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">申请类型</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">申请原因</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">申请时间</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">状态</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">操作</th>
                            </tr>
                        </thead>
                        <tbody id="requestsTable" class="divide-y">
                            <!-- 请求行将插入这里 -->
                        </tbody>
                    </table>
                </div>

                <!-- 分页 -->
                <div class="flex justify-between items-center">
                    <div class="text-sm text-gray-600">
                        共 <span id="totalCount">0</span> 个申请，第 <span id="currentPage">1</span> 页
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

            <!-- 审批对话框 -->
            <div id="approvalModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
                <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
                    <h3 class="text-xl font-bold mb-4" id="modalTitle">审批导出申请</h3>
                    <div id="modalContent" class="space-y-4">
                        <!-- 动态内容 -->
                    </div>
                    <div class="flex justify-end gap-2 pt-4 border-t">
                        <button id="btnCancel" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400">取消</button>
                        <button id="btnReject" class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700">拒绝</button>
                        <button id="btnApprove" class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">批准</button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * 加载申请列表
     */
    async loadRequests() {
        UINotification.loading('正在加载申请...');

        try {
            const response = await fetch(
                `/api/guest-export-request/list?status=${this.filter}&page=${this.currentPage}&limit=${this.pageSize}`,
                {
                    headers: {
                        'Authorization': `Bearer ${authService.getToken()}`
                    }
                }
            );

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || '加载失败');
            }

            this.requests = data.data || [];
            this.totalRequests = data.total || 0;
            this.renderRequests();
            UINotification.success('申请列表已加载');
        } catch (error) {
            console.error('加载申请列表错误:', error);
            UINotification.error('加载失败: ' + error.message);
        }
    }

    /**
     * 渲染申请表格
     */
    renderRequests() {
        const tableBody = document.getElementById('requestsTable');
        tableBody.innerHTML = '';

        if (this.requests.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="6" class="px-6 py-4 text-center text-gray-500">暂无申请</td></tr>';
            return;
        }

        this.requests.forEach(req => {
            const statusMap = {
                'pending': { label: '待审批', color: 'bg-yellow-100 text-yellow-800' },
                'approved': { label: '已批准', color: 'bg-green-100 text-green-800' },
                'rejected': { label: '已拒绝', color: 'bg-red-100 text-red-800' }
            };

            const status = statusMap[req.status] || { label: req.status, color: 'bg-gray-100 text-gray-800' };

            const row = document.createElement('tr');
            row.className = 'hover:bg-gray-50 transition';
            row.innerHTML = `
                <td class="px-6 py-4">
                    <div class="font-medium text-gray-800">${req.guests.full_name || req.guests.username}</div>
                    <div class="text-sm text-gray-500">${req.guests.email}</div>
                </td>
                <td class="px-6 py-4 text-sm text-gray-600">${req.request_type}</td>
                <td class="px-6 py-4 text-sm text-gray-600">${req.request_reason}</td>
                <td class="px-6 py-4 text-sm text-gray-600">${new Date(req.requested_at).toLocaleString()}</td>
                <td class="px-6 py-4">
                    <span class="px-3 py-1 rounded-full text-sm font-medium ${status.color}">
                        ${status.label}
                    </span>
                </td>
                <td class="px-6 py-4 space-x-2">
                    <button class="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm" 
                        onclick="window.exportApproval.showDetails(${req.id})">
                        <i class="fas fa-eye mr-1"></i>详情
                    </button>
                    ${req.status === 'pending' ? `
                    <button class="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
                        onclick="window.exportApproval.showApprovalModal(${req.id}, 'approve')">
                        <i class="fas fa-check mr-1"></i>批准
                    </button>
                    <button class="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm"
                        onclick="window.exportApproval.showApprovalModal(${req.id}, 'reject')">
                        <i class="fas fa-times mr-1"></i>拒绝
                    </button>
                    ` : ''}
                </td>
            `;
            tableBody.appendChild(row);
        });

        document.getElementById('totalCount').textContent = this.totalRequests;
        document.getElementById('currentPage').textContent = this.currentPage;
    }

    /**
     * 显示审批对话框
     */
    showApprovalModal(requestId, action) {
        const req = this.requests.find(r => r.id === requestId);
        if (!req) return;

        const modal = document.getElementById('approvalModal');
        const modalTitle = document.getElementById('modalTitle');
        const modalContent = document.getElementById('modalContent');

        modalTitle.textContent = action === 'approve' ? '批准导出申请' : '拒绝导出申请';

        modalContent.innerHTML = `
            <div class="space-y-3">
                <div>
                    <label class="block text-sm font-medium text-gray-700">访客名称</label>
                    <p class="text-gray-600">${req.guests.full_name || req.guests.username}</p>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">申请原因</label>
                    <p class="text-gray-600">${req.request_reason}</p>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">审批意见</label>
                    <textarea id="approvalComment" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" 
                        rows="3" placeholder="请输入审批意见"></textarea>
                </div>
                ${action === 'approve' ? `
                <div>
                    <label class="block text-sm font-medium text-gray-700">权限有效期(天)</label>
                    <input type="number" id="permissionDays" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" 
                        value="30" min="1" max="365">
                </div>
                ` : ''}
            </div>
        `;

        // 绑定按钮事件
        const btnCancel = document.getElementById('btnCancel');
        const btnApprove = document.getElementById('btnApprove');
        const btnReject = document.getElementById('btnReject');

        btnCancel.onclick = () => {
            modal.classList.add('hidden');
        };

        if (action === 'approve') {
            btnReject.classList.add('hidden');
            btnApprove.textContent = '批准';
            btnApprove.onclick = () => {
                this.approveRequest(requestId);
                modal.classList.add('hidden');
            };
        } else {
            btnApprove.classList.add('hidden');
            btnReject.textContent = '拒绝';
            btnReject.onclick = () => {
                this.rejectRequest(requestId);
                modal.classList.add('hidden');
            };
        }

        modal.classList.remove('hidden');
    }

    /**
     * 批准申请
     */
    async approveRequest(requestId) {
        const comment = document.getElementById('approvalComment').value;
        const days = parseInt(document.getElementById('permissionDays').value) || 30;

        UINotification.loading('正在批准...');

        try {
            const response = await fetch(
                `/api/guest-export-request/${requestId}/approve`,
                {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authService.getToken()}`
                    },
                    body: JSON.stringify({
                        approval_comment: comment,
                        permission_days: days
                    })
                }
            );

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error);
            }

            UINotification.success('申请已批准');
            await this.loadRequests();
        } catch (error) {
            UINotification.error('批准失败: ' + error.message);
        }
    }

    /**
     * 拒绝申请
     */
    async rejectRequest(requestId) {
        const comment = document.getElementById('approvalComment').value;

        UINotification.loading('正在拒绝...');

        try {
            const response = await fetch(
                `/api/guest-export-request/${requestId}/reject`,
                {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authService.getToken()}`
                    },
                    body: JSON.stringify({
                        approval_comment: comment
                    })
                }
            );

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error);
            }

            UINotification.success('申请已拒绝');
            await this.loadRequests();
        } catch (error) {
            UINotification.error('拒绝失败: ' + error.message);
        }
    }

    /**
     * 绑定事件
     */
    bindEvents() {
        // 过滤按钮
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.filter-btn').forEach(b => {
                    b.classList.remove('bg-blue-600', 'text-white');
                    b.classList.add('bg-gray-200', 'text-gray-700');
                });
                e.target.classList.remove('bg-gray-200', 'text-gray-700');
                e.target.classList.add('bg-blue-600', 'text-white');

                this.filter = e.target.dataset.filter === 'all' ? '' : e.target.dataset.filter;
                this.currentPage = 1;
                this.loadRequests();
            });
        });

        // 分页按钮
        document.getElementById('btnPrevPage').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.loadRequests();
            }
        });

        document.getElementById('btnNextPage').addEventListener('click', () => {
            const maxPage = Math.ceil(this.totalRequests / this.pageSize);
            if (this.currentPage < maxPage) {
                this.currentPage++;
                this.loadRequests();
            }
        });

        // 设置默认过滤器样式
        document.querySelector('[data-filter="pending"]').classList.add('bg-blue-600', 'text-white');
    }

    /**
     * 显示详情
     */
    showDetails(requestId) {
        const req = this.requests.find(r => r.id === requestId);
        if (!req) return;

        console.log('申请详情:', req);
        UINotification.info(`申请: ${req.request_type} - 状态: ${req.status}`);
    }
}

export const exportApproval = new ExportApproval();
