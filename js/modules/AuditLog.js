/**
 * AuditLog - 操作审计日志模块（从数据库查询版）
 * 从后端 API 获取审计日志，支持筛选、分页、导出等功能
 */

import { UINotification } from '../utils/UINotification.js';
import { auditLogService } from '../services/AuditLogService.js';

class AuditLog {
    constructor() {
        this.moduleName = '审计日志';
        this.logs = [];           // 所有日志条目
        this.currentPage = 1;
        this.pageSize = 15;
        this.totalCount = 0;
        this.filterDate = '';     // 筛选特定日期，空=全部
        this.filterUser = '';     // 筛选特定用户名
        this.filterAction = '';   // 筛选操作类型
        this.isLoading = false;
    }

    init() {
        console.log('🔧 ' + this.moduleName + ' 初始化中...');
        this.renderUI();
        this.bindEvents();
        this.loadLogs();
        console.log('✅ ' + this.moduleName + ' 初始化完成');
        return true;
    }

    renderUI() {
        const content = document.getElementById('audit-log');
        if (!content) {
            console.warn('⚠️ 找不到 id="audit-log" 的容器');
            return;
        }

        content.innerHTML = `
            <div class="space-y-6">
                <!-- 标题 -->
                <div class="flex justify-between items-center">
                    <h2 class="text-2xl font-bold text-gray-800 flex items-center">
                        <i class="fas fa-history text-blue-600 mr-3"></i>操作审计日志
                    </h2>
                    <div class="flex gap-2">
                        <button id="btnExportLogs" class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition flex items-center">
                            <i class="fas fa-download mr-2"></i>导出日志
                        </button>
                        <button id="btnRefreshLogs" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition flex items-center">
                            <i class="fas fa-sync mr-2"></i>刷新
                        </button>
                    </div>
                </div>

                <!-- 筛选条件 -->
                <div class="bg-white rounded-lg shadow-md p-4">
                    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">用户</label>
                            <input type="text" id="userFilter" placeholder="输入用户名..."
                                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">操作类型</label>
                            <select id="actionFilter" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <option value="">全部</option>
                                <option value="create">新增</option>
                                <option value="update">修改</option>
                                <option value="delete">删除</option>
                                <option value="login">登录</option>
                                <option value="logout">登出</option>
                                <option value="export">导出</option>
                                <option value="import">导入</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">日期范围</label>
                            <input type="date" id="dateFilter"
                                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div class="flex items-end gap-2">
                            <button id="btnFilterLogs" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition w-full">
                                <i class="fas fa-search mr-2"></i>筛选
                            </button>
                            <button id="btnClearFilters" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition">
                                <i class="fas fa-times mr-2"></i>重置
                            </button>
                        </div>
                    </div>
                </div>

                <!-- 统计信息 -->
                <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <p class="text-sm text-gray-600">
                        共 <span id="totalCount" class="font-bold text-blue-600">0</span> 条记录
                        <span id="loadingStatus" class="ml-4 text-blue-600"></span>
                    </p>
                </div>

                <!-- 日志列表 -->
                <div class="bg-white rounded-lg shadow-md overflow-hidden">
                    <table class="w-full">
                        <thead class="bg-gray-100 border-b">
                            <tr>
                                <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">时间</th>
                                <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">用户</th>
                                <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">操作</th>
                                <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">表</th>
                                <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">详情</th>
                            </tr>
                        </thead>
                        <tbody id="logTable" class="divide-y"></tbody>
                    </table>
                    <div id="emptyTip" class="hidden text-center py-12 text-gray-400">
                        <i class="fas fa-inbox text-4xl mb-3 block"></i>
                        <p>暂无操作记录</p>
                    </div>
                </div>

                <!-- 分页 -->
                <div class="flex justify-between items-center">
                    <div class="text-sm text-gray-600">
                        第 <span id="currentPageNum">1</span> 页（每页 <span id="pageSize">15</span> 条）
                    </div>
                    <div class="space-x-2">
                        <button id="btnPrevPage" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition">
                            <i class="fas fa-chevron-left mr-1"></i>上一页
                        </button>
                        <button id="btnNextPage" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition">
                            下一页<i class="fas fa-chevron-right ml-1"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    bindEvents() {
        // 筛选
        document.getElementById('btnFilterLogs')?.addEventListener('click', () => {
            this.filterUser = (document.getElementById('userFilter')?.value || '').trim();
            this.filterAction = document.getElementById('actionFilter')?.value || '';
            this.filterDate = document.getElementById('dateFilter')?.value || '';
            this.currentPage = 1;
            this.loadLogs();
        });

        // 重置筛选
        document.getElementById('btnClearFilters')?.addEventListener('click', () => {
            document.getElementById('userFilter').value = '';
            document.getElementById('actionFilter').value = '';
            document.getElementById('dateFilter').value = '';
            this.filterUser = '';
            this.filterAction = '';
            this.filterDate = '';
            this.currentPage = 1;
            this.loadLogs();
        });

        // 刷新
        document.getElementById('btnRefreshLogs')?.addEventListener('click', () => {
            this.currentPage = 1;
            this.loadLogs();
        });

        // 导出
        document.getElementById('btnExportLogs')?.addEventListener('click', () => {
            const start_date = document.getElementById('dateFilter')?.value;
            auditLogService.exportLogs(start_date);
        });

        // 分页
        document.getElementById('btnPrevPage')?.addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.renderTable();
            }
        });

        document.getElementById('btnNextPage')?.addEventListener('click', () => {
            const maxPage = Math.ceil(this.totalCount / this.pageSize);
            if (this.currentPage < maxPage) {
                this.currentPage++;
                this.renderTable();
            }
        });
    }

    /**
     * 从后端加载日志
     */
    async loadLogs() {
        if (this.isLoading) return;

        this.isLoading = true;
        this.updateLoadingStatus('加载中...');

        try {
            const offset = (this.currentPage - 1) * this.pageSize;

            // 构建筛选条件
            const filters = {};
            if (this.filterUser) filters.user_id = this.filterUser;
            if (this.filterAction) filters.action = this.filterAction;
            if (this.filterDate) {
                // 如果是日期，则查询该日期范围内的记录
                const startDate = `${this.filterDate}T00:00:00Z`;
                const endDate = `${this.filterDate}T23:59:59Z`;
                filters.start_date = startDate;
                filters.end_date = endDate;
            }

            // 调用 API
            const result = await auditLogService.getLogs(this.pageSize, offset, filters);

            if (result.success) {
                this.logs = result.data || [];
                this.totalCount = result.total || 0;
                this.renderTable();
                this.updateLoadingStatus('');
                console.log(`✅ 已加载 ${this.logs.length} 条记录，总共 ${this.totalCount} 条`);
            } else {
                UINotification.error(`❌ ${result.message || '加载失败'}`);
                this.logs = [];
                this.renderTable();
                this.updateLoadingStatus('');
            }
        } catch (error) {
            console.error('❌ 加载日志异常:', error);
            UINotification.error('❌ 加载日志异常');
            this.logs = [];
            this.renderTable();
            this.updateLoadingStatus('');
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * 渲染日志表格
     */
    renderTable() {
        const tbody = document.getElementById('logTable');
        const emptyTip = document.getElementById('emptyTip');

        if (!tbody) return;

        if (this.logs.length === 0) {
            tbody.innerHTML = '';
            emptyTip?.classList.remove('hidden');
            document.getElementById('totalCount').textContent = this.totalCount;
            document.getElementById('currentPageNum').textContent = this.currentPage;
            return;
        }

        emptyTip?.classList.add('hidden');

        tbody.innerHTML = this.logs.map(log => {
            const timeStr = new Date(log.created_at).toLocaleString('zh-CN', { hour12: false });
            const actionLabel = this.getActionLabel(log.action);
            const actionColor = this.getActionColor(log.action);

            return `
                <tr class="hover:bg-blue-50 transition">
                    <td class="px-4 py-3 text-sm whitespace-nowrap text-gray-600">${timeStr}</td>
                    <td class="px-4 py-3 text-sm font-medium">
                        <div class="flex items-center gap-2">
                            <div class="w-6 h-6 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                                <i class="fas fa-user text-blue-600 text-xs"></i>
                            </div>
                            <span class="text-gray-800">${this.escapeHtml(log.user_id)}</span>
                        </div>
                    </td>
                    <td class="px-4 py-3">
                        <span class="px-2 py-1 rounded-full text-xs font-medium ${actionColor}">
                            ${actionLabel}
                        </span>
                    </td>
                    <td class="px-4 py-3 text-sm text-gray-600">${this.escapeHtml(log.table_name)}</td>
                    <td class="px-4 py-3 text-sm text-gray-600 truncate" title="${log.details || ''}">
                        ${log.details ? this.escapeHtml(log.details) : '-'}
                    </td>
                </tr>
            `;
        }).join('');

        document.getElementById('totalCount').textContent = this.totalCount;
        document.getElementById('currentPageNum').textContent = this.currentPage;
    }

    /**
     * 获取操作类型标签
     */
    getActionLabel(action) {
        const labels = {
            'create': '新增',
            'update': '修改',
            'delete': '删除',
            'login': '登录',
            'logout': '登出',
            'export': '导出',
            'import': '导入'
        };
        return labels[action] || action;
    }

    /**
     * 获取操作类型颜色
     */
    getActionColor(action) {
        const colors = {
            'create': 'bg-green-100 text-green-700',
            'update': 'bg-yellow-100 text-yellow-700',
            'delete': 'bg-red-100 text-red-700',
            'login': 'bg-blue-100 text-blue-700',
            'logout': 'bg-gray-100 text-gray-700',
            'export': 'bg-purple-100 text-purple-700',
            'import': 'bg-indigo-100 text-indigo-700'
        };
        return colors[action] || 'bg-gray-100 text-gray-700';
    }

    /**
     * HTML转义
     */
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * 更新加载状态
     */
    updateLoadingStatus(status) {
        const el = document.getElementById('loadingStatus');
        if (el) {
            el.textContent = status;
        }
    }

    /**
     * 全局导出函数（暴露给外部）
     */
    jumpToDate(date) {
        document.getElementById('dateFilter').value = date;
        this.filterDate = date;
        this.currentPage = 1;
        this.loadLogs();
    }
}

export function initAuditLog() {
    window.auditLog = new AuditLog();
    return window.auditLog.init();
}
