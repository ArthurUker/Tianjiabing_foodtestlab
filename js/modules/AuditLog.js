/**
 * AuditLog - 操作审计日志模块（从数据库查询版）
 * 从后端 API 获取审计日志，支持筛选、分页、导出等功能
 */

import { UINotification } from '../utils/UINotification.js';
import { auditService } from '../services/AuditService.js';

class AuditLog {
    constructor() {
        this.moduleName = '审计日志';
        this.logs = [];           // 所有日志条目
        this.currentPage = 1;
        this.pageSize = 15;
        this.totalCount = 0;
        this.filterDate = '';     // 筛选特定日期，空=全部
        this.filterUser = '';     // 筛选特定用户名（或已删除用户的 user_id）
        this.filterAction = '';   // 筛选操作类型
        this.userOptions = [];    // 用户下拉框选项 { value, type: 'username'|'user_id', label }
        this.isLoading = false;
    }

    init() {
        console.log('🔧 ' + this.moduleName + ' 初始化中...');
        this.renderUI();
        this.bindEvents();
        this.loadUsers();
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
                            <select id="userFilter" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <option value="">全部用户</option>
                            </select>
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

                <!-- 详情弹窗（点击行的"详情"或操作按钮时显示完整日志 JSON） -->
                <div id="auditDetailModal" class="hidden fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
                    <div class="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
                        <div class="flex justify-between items-center px-5 py-3 border-b">
                            <h3 class="text-lg font-semibold text-gray-800 flex items-center">
                                <i class="fas fa-file-alt text-blue-600 mr-2"></i>审计日志详情
                            </h3>
                            <button id="auditDetailClose" class="text-gray-400 hover:text-gray-600 transition" aria-label="关闭">
                                <i class="fas fa-times text-xl"></i>
                            </button>
                        </div>
                        <div class="px-5 py-4 overflow-y-auto flex-1">
                            <pre id="auditDetailContent" class="text-sm text-gray-800 bg-gray-50 rounded p-4 whitespace-pre-wrap break-words font-mono"></pre>
                        </div>
                        <div class="px-5 py-3 border-t text-right">
                            <button id="auditDetailCopy" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition">
                                <i class="fas fa-copy mr-1"></i>复制 JSON
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

        // 详情弹窗：关闭（点遮罩 / 点 X / 按 ESC 都生效）
        document.getElementById('auditDetailClose')?.addEventListener('click', () => this.closeDetail());
        document.getElementById('auditDetailModal')?.addEventListener('click', (e) => {
            if (e.target.id === 'auditDetailModal') this.closeDetail();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeDetail();
        });
        // 复制 JSON
        document.getElementById('auditDetailCopy')?.addEventListener('click', () => {
            const txt = document.getElementById('auditDetailContent')?.textContent || '';
            if (!txt) return;
            navigator.clipboard.writeText(txt).then(
                () => UINotification.success('已复制到剪贴板'),
                () => UINotification.error('复制失败，请手动选择')
            );
        });

        // 表格事件委派：点击行或"详情"按钮均打开弹窗（仅绑定一次）
        document.getElementById('logTable')?.addEventListener('click', (e) => {
            const tr = e.target.closest('tr[data-log-id]');
            if (!tr) return;
            const log = this.logs.find(l => l.id === tr.dataset.logId);
            if (!log) return;
            // 若点在"详情"按钮上，明确阻止冒泡无关（事实上直接打开弹窗即可）
            this.openDetail(log);
        });

        // 导出
        document.getElementById('btnExportLogs')?.addEventListener('click', () => {
            const start_date = document.getElementById('dateFilter')?.value;
            auditService.exportLogs(start_date);
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
     * 加载可筛选的用户列表（下拉框）
     */
    async loadUsers() {
        const result = await auditService.getUsers();
        if (!result.success || !result.data) return;

        this.userOptions = [];
        for (const u of result.data.users || []) {
            this.userOptions.push({
                value: u.username,
                type: 'username',
                label: u.full_name ? `${u.username}（${u.full_name}）` : u.username,
            });
        }
        // 审计中出现过但已被删除的用户（用 id 前缀展示，保证历史记录仍可筛选）
        for (const id of result.data.deletedIds || []) {
            this.userOptions.push({
                value: id,
                type: 'user_id',
                label: `${id.slice(0, 8)}…（已删除）`,
            });
        }

        const sel = document.getElementById('userFilter');
        if (!sel) return;
        sel.innerHTML = '<option value="">全部用户</option>' +
            this.userOptions.map(o =>
                `<option value="${this.escapeHtml(o.value)}">${this.escapeHtml(o.label)}</option>`
            ).join('');
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
            if (this.filterUser) {
                // 已删除用户存的是 user_id，其余为 username
                const opt = this.userOptions.find(o => o.value === this.filterUser);
                if (opt && opt.type === 'user_id') filters.user_id = opt.value;
                else filters.username = this.filterUser;
            }
            if (this.filterAction) filters.action = this.filterAction;
            if (this.filterDate) {
                // 如果是日期，则查询该日期范围内的记录
                const startDate = `${this.filterDate}T00:00:00Z`;
                const endDate = `${this.filterDate}T23:59:59Z`;
                filters.start_date = startDate;
                filters.end_date = endDate;
            }

            // 调用 API
            const result = await auditService.getLogs(this.pageSize, offset, filters);

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
            const detailsSummary = this.summarizeDetails(log.details);
            const detailsObj = this.normalizeDetails(log.details);

            return `
                <tr class="hover:bg-blue-50 transition cursor-pointer" data-log-id="${this.escapeHtml(log.id)}">
                    <td class="px-4 py-3 text-sm whitespace-nowrap text-gray-600">${timeStr}</td>
                    <td class="px-4 py-3 text-sm font-medium">
                        <div class="flex items-center gap-2">
                            <div class="w-6 h-6 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                                <i class="fas fa-user text-blue-600 text-xs"></i>
                            </div>
                            <span class="text-gray-800" title="${log.user_id ? 'user_id: ' + this.escapeHtml(log.user_id) : ''}">
                                ${this.escapeHtml(log.user?.username || log.user?.full_name || log.user_id)}
                            </span>
                        </div>
                    </td>
                    <td class="px-4 py-3">
                        <span class="px-2 py-1 rounded-full text-xs font-medium ${actionColor}">
                            ${actionLabel}
                        </span>
                    </td>
                    <td class="px-4 py-3 text-sm text-gray-600">${this.escapeHtml(log.resource_type || '-')}</td>
                    <td class="px-4 py-3 text-sm text-gray-600">
                        <div class="flex items-center gap-2">
                            <span class="truncate flex-1" title="${this.escapeHtml(detailsSummary.full)}">
                                ${this.escapeHtml(detailsSummary.preview)}
                            </span>
                            ${detailsObj ? `
                                <button class="audit-detail-btn px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition flex-shrink-0" title="查看完整详情">
                                    <i class="fas fa-eye"></i>详情
                                </button>
                            ` : ''}
                        </div>
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
     * 规范化 details 字段：后端该列是 JSON，可能返回对象、字符串或 null。
     * - 对象 → 返回原对象（供弹窗展示）+ 序列化字符串（用于摘要/标题）。
     * - 字符串 → 尝试 JSON.parse，失败则当作纯文本。
     * - null/undefined → null
     */
    normalizeDetails(d) {
        if (d == null) return null;
        if (typeof d === 'object') return d;
        if (typeof d === 'string') {
            try { return JSON.parse(d); } catch { return d; }
        }
        return d;
    }

    /**
     * 生成详情摘要：表格列里只显示一句话的精简摘要，避免 [object Object]；
     * 完整 JSON 留给点击「详情」按钮/行打开弹窗查看。
     * 返回 { preview, full }：preview 用于单元格显示，full 保留用作 title 悬浮提示。
     */
    summarizeDetails(d) {
        if (d == null || d === '') return { preview: '-', full: '' };
        const norm = this.normalizeDetails(d);
        const fullText = typeof norm === 'string' ? norm : JSON.stringify(norm, null, 2);

        if (typeof norm === 'string') {
            return { preview: norm.length > 40 ? norm.slice(0, 40) + '…' : norm, full: norm };
        }
        if (typeof norm !== 'object') {
            return { preview: String(norm), full: String(norm) };
        }

        // 对象：抽取最有信息量的前 1~2 个字段作为预览
        const keys = Object.keys(norm);
        if (keys.length === 0) return { preview: '{}', full: fullText };

        const PREFERRED_KEYS = ['username', 'name', 'fullName', 'full_name', 'ip', 'role', 'action',
                                'resource_id', 'resourceId', 'record_code', 'school_code', 'schoolCode', 'source'];
        const summary = [];
        for (const k of PREFERRED_KEYS) {
            if (k in norm && norm[k] != null) {
                const v = typeof norm[k] === 'object' ? JSON.stringify(norm[k]) : String(norm[k]);
                summary.push(`${k}: ${v.length > 20 ? v.slice(0, 20) + '…' : v}`);
                if (summary.length >= 2) break;
            }
        }
        // 兜底：取前两个 key
        if (summary.length === 0) {
            for (const k of keys.slice(0, 2)) {
                const v = typeof norm[k] === 'object' ? JSON.stringify(norm[k]) : String(norm[k]);
                summary.push(`${k}: ${v.length > 20 ? v.slice(0, 20) + '…' : v}`);
            }
        }
        const preview = summary.join(', ');
        return { preview: preview.length > 60 ? preview.slice(0, 60) + '…' : preview, full: fullText };
    }

    /**
     * 打开详情弹窗，显示完整 JSON（带字段分解以便阅读）
     */
    openDetail(log) {
        const modal = document.getElementById('auditDetailModal');
        const content = document.getElementById('auditDetailContent');
        if (!modal || !content) return;

        const norm = this.normalizeDetails(log.details);
        const formatted = JSON.stringify({
            id: log.id,
            created_at: log.created_at,
            user_id: log.user_id,
            action: log.action,
            resource_type: log.resource_type,
            resource_id: log.resource_id,
            ip_address: log.ip_address,
            user: log.user ? { id: log.user.id, username: log.user.username, full_name: log.user.full_name } : null,
            details: norm,
        }, null, 2);
        content.textContent = formatted || '（空）';
        modal.classList.remove('hidden');
        // 保存当前行号引用，便于复制按钮直接复制该 JSON
        this._currentDetailLog = log;
    }

    closeDetail() {
        document.getElementById('auditDetailModal')?.classList.add('hidden');
        this._currentDetailLog = null;
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

// P2-10 阶段B：审计日志实例改为模块内单例，不再挂 window
let auditLogInstance = null;
export function initAuditLog() {
    auditLogInstance = new AuditLog();
    return auditLogInstance.init();
}
