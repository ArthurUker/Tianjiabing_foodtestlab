/**
 * AuditLog - 操作审计日志模块
 * 记录和展示所有数据修改操作，便于追踪和审计
 */

import { authService } from '../services/AuthService.js';
import { UINotification } from '../utils/UINotification.js';
import { router } from '../core/Router.js';

export class AuditLog {
    constructor() {
        this.moduleName = '审计日志';
        this.logs = [];
        this.currentPage = 1;
        this.pageSize = 20;
        this.totalLogs = 0;
    }

    /**
     * 初始化模块
     */
    init() {
        console.log('🔧 ' + this.moduleName + ' 初始化中...');
        
        // 检查权限
        if (!router.isAdmin()) {
            console.warn('⚠️ 用户无权访问审计日志模块');
            return false;
        }

        this.renderUI();
        this.bindEvents();
        this.loadAuditLogs();

        console.log('✅ ' + this.moduleName + ' 初始化完成');
        return true;
    }

    /**
     * 渲染审计日志 UI
     */
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
                    <button id="btnExportLogs" class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition flex items-center">
                        <i class="fas fa-download mr-2"></i>导出日志
                    </button>
                </div>

                <!-- 筛选条件 -->
                <div class="bg-white rounded-lg shadow-md p-4 space-y-4">
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <!-- 操作类型过滤 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">操作类型</label>
                            <select id="actionFilter" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <option value="">所有操作</option>
                                <option value="create">创建</option>
                                <option value="update">编辑</option>
                                <option value="delete">删除</option>
                                <option value="export">导出</option>
                                <option value="login">登录</option>
                                <option value="logout">登出</option>
                            </select>
                        </div>

                        <!-- 数据表过滤 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">数据表</label>
                            <select id="tableFilter" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <option value="">所有表</option>
                                <option value="tableware">餐具检测</option>
                                <option value="pesticide">果蔬农残</option>
                                <option value="oil">食用油</option>
                                <option value="leanMeat">肉蛋检测</option>
                                <option value="pathogen">病原体</option>
                                <option value="users">用户管理</option>
                            </select>
                        </div>

                        <!-- 用户过滤 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">操作用户</label>
                            <input 
                                type="text" 
                                id="userFilter"
                                placeholder="输入用户名..."
                                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                        </div>

                        <!-- 日期范围 -->
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">日期范围</label>
                            <select id="dateRangeFilter" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <option value="">所有时间</option>
                                <option value="today">今天</option>
                                <option value="week">本周</option>
                                <option value="month">本月</option>
                                <option value="quarter">本季度</option>
                            </select>
                        </div>
                    </div>

                    <div class="flex gap-2">
                        <button id="btnFilterLogs" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
                            <i class="fas fa-search mr-2"></i>搜索
                        </button>
                        <button id="btnClearFilters" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition">
                            <i class="fas fa-times mr-2"></i>清除筛选
                        </button>
                    </div>
                </div>

                <!-- 日志列表 -->
                <div class="bg-white rounded-lg shadow-md overflow-hidden">
                    <table class="w-full">
                        <thead class="bg-gray-100 border-b">
                            <tr>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">时间</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">操作人</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">操作类型</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">数据表</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">记录ID</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">状态</th>
                                <th class="px-6 py-3 text-left text-sm font-semibold text-gray-700">操作</th>
                            </tr>
                        </thead>
                        <tbody id="logTable" class="divide-y">
                            <!-- 日志行将插入这里 -->
                        </tbody>
                    </table>
                </div>

                <!-- 分页 -->
                <div class="flex justify-between items-center">
                    <div class="text-sm text-gray-600">
                        共 <span id="totalCount">0</span> 条日志，第 <span id="currentPage">1</span> 页
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

            <!-- 日志详情模态框 -->
            <div id="logDetailModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
                <div class="bg-white rounded-lg shadow-xl p-6 w-full max-w-2xl max-h-96 overflow-y-auto">
                    <h3 class="text-xl font-bold mb-4">操作详情</h3>
                    <div class="space-y-4" id="logDetailContent">
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
        // 搜索
        document.getElementById('btnFilterLogs').addEventListener('click', () => this.loadAuditLogs());

        // 清除筛选
        document.getElementById('btnClearFilters').addEventListener('click', () => this.clearFilters());

        // 导出
        document.getElementById('btnExportLogs').addEventListener('click', () => this.exportLogs());

        // 分页
        document.getElementById('btnPrevPage').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.loadAuditLogs();
            }
        });

        document.getElementById('btnNextPage').addEventListener('click', () => {
            if (this.currentPage * this.pageSize < this.totalLogs) {
                this.currentPage++;
                this.loadAuditLogs();
            }
        });

        // 关闭详情
        document.getElementById('btnCloseDetail').addEventListener('click', () => {
            document.getElementById('logDetailModal').classList.add('hidden');
        });
    }

    /**
     * 加载审计日志
     */
    async loadAuditLogs() {
        try {
            UINotification.loading('正在加载审计日志...');

            // 获取筛选条件
            const action = document.getElementById('actionFilter')?.value;
            const table = document.getElementById('tableFilter')?.value;
            const user = document.getElementById('userFilter')?.value;
            const dateRange = document.getElementById('dateRangeFilter')?.value;

            // 模拟日志数据 (实际应从后端 API 获取)
            // TODO: 调用 GET /api/audit/logs API
            const mockLogs = this.generateMockLogs();

            this.logs = mockLogs;
            this.totalLogs = mockLogs.length;
            this.renderLogTable();

            UINotification.success('审计日志已加载 (' + mockLogs.length + ' 条)');
        } catch (error) {
            console.error('❌ 加载审计日志错误:', error);
            UINotification.error('加载审计日志时出错');
        }
    }

    /**
     * 生成模拟日志数据 (为演示用)
     */
    generateMockLogs() {
        const actions = ['create', 'update', 'delete', 'export', 'login', 'logout'];
        const tables = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];
        const users = ['admin', 'manager', '李丹', '王宏'];
        const logs = [];

        for (let i = 0; i < 50; i++) {
            logs.push({
                id: 1000 + i,
                timestamp: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString(),
                user: users[Math.floor(Math.random() * users.length)],
                action: actions[Math.floor(Math.random() * actions.length)],
                table: tables[Math.floor(Math.random() * tables.length)],
                recordId: Math.floor(Math.random() * 1000),
                status: Math.random() > 0.1 ? 'success' : 'failed',
                ipAddress: `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
                oldValue: '{"status": "合格"}',
                newValue: '{"status": "不合格"}'
            });
        }

        return logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    /**
     * 渲染日志表格
     */
    renderLogTable() {
        const tableBody = document.getElementById('logTable');
        tableBody.innerHTML = '';

        const startIdx = (this.currentPage - 1) * this.pageSize;
        const endIdx = startIdx + this.pageSize;
        const pageData = this.logs.slice(startIdx, endIdx);

        pageData.forEach(log => {
            const row = document.createElement('tr');
            row.className = 'hover:bg-gray-50 transition';
            
            const actionLabel = this.getActionLabel(log.action);
            const actionColor = this.getActionColor(log.action);
            const statusColor = log.status === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800';

            row.innerHTML = `
                <td class="px-6 py-4 text-sm text-gray-600">
                    ${new Date(log.timestamp).toLocaleString()}
                </td>
                <td class="px-6 py-4">
                    <div class="flex items-center">
                        <div class="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center mr-2">
                            <i class="fas fa-user text-blue-600 text-xs"></i>
                        </div>
                        <span class="font-medium text-gray-800">${log.user}</span>
                    </div>
                </td>
                <td class="px-6 py-4">
                    <span class="px-3 py-1 rounded-full text-sm font-medium ${actionColor}">
                        ${actionLabel}
                    </span>
                </td>
                <td class="px-6 py-4 text-sm text-gray-600">${log.table}</td>
                <td class="px-6 py-4 text-sm text-gray-600">#${log.recordId}</td>
                <td class="px-6 py-4">
                    <span class="px-3 py-1 rounded-full text-sm font-medium ${statusColor}">
                        ${log.status === 'success' ? '成功' : '失败'}
                    </span>
                </td>
                <td class="px-6 py-4">
                    <button class="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm" onclick="window.auditLog.showDetail(${JSON.stringify(log)})">
                        <i class="fas fa-eye mr-1"></i>详情
                    </button>
                </td>
            `;
            tableBody.appendChild(row);
        });

        document.getElementById('totalCount').textContent = this.totalLogs;
        document.getElementById('currentPage').textContent = this.currentPage;
    }

    /**
     * 获取操作类型标签
     */
    getActionLabel(action) {
        const labels = {
            'create': '创建',
            'update': '编辑',
            'delete': '删除',
            'export': '导出',
            'login': '登录',
            'logout': '登出'
        };
        return labels[action] || action;
    }

    /**
     * 获取操作类型颜色
     */
    getActionColor(action) {
        const colors = {
            'create': 'bg-green-100 text-green-800',
            'update': 'bg-blue-100 text-blue-800',
            'delete': 'bg-red-100 text-red-800',
            'export': 'bg-purple-100 text-purple-800',
            'login': 'bg-yellow-100 text-yellow-800',
            'logout': 'bg-gray-100 text-gray-800'
        };
        return colors[action] || 'bg-gray-100 text-gray-800';
    }

    /**
     * 显示日志详情
     */
    showDetail(log) {
        const modal = document.getElementById('logDetailModal');
        const content = document.getElementById('logDetailContent');

        content.innerHTML = `
            <div class="space-y-3">
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <span class="text-sm text-gray-500">时间</span>
                        <p class="font-medium">${new Date(log.timestamp).toLocaleString()}</p>
                    </div>
                    <div>
                        <span class="text-sm text-gray-500">操作人</span>
                        <p class="font-medium">${log.user}</p>
                    </div>
                    <div>
                        <span class="text-sm text-gray-500">操作类型</span>
                        <p class="font-medium">${this.getActionLabel(log.action)}</p>
                    </div>
                    <div>
                        <span class="text-sm text-gray-500">数据表</span>
                        <p class="font-medium">${log.table}</p>
                    </div>
                    <div>
                        <span class="text-sm text-gray-500">记录ID</span>
                        <p class="font-medium">#${log.recordId}</p>
                    </div>
                    <div>
                        <span class="text-sm text-gray-500">IP地址</span>
                        <p class="font-medium">${log.ipAddress}</p>
                    </div>
                </div>

                <hr>

                <div>
                    <span class="text-sm text-gray-500">变更前值</span>
                    <div class="bg-gray-100 p-3 rounded mt-1 text-sm font-mono overflow-x-auto">
                        ${log.oldValue || 'N/A'}
                    </div>
                </div>

                <div>
                    <span class="text-sm text-gray-500">变更后值</span>
                    <div class="bg-gray-100 p-3 rounded mt-1 text-sm font-mono overflow-x-auto">
                        ${log.newValue || 'N/A'}
                    </div>
                </div>
            </div>
        `;

        modal.classList.remove('hidden');
    }

    /**
     * 清除筛选条件
     */
    clearFilters() {
        document.getElementById('actionFilter').value = '';
        document.getElementById('tableFilter').value = '';
        document.getElementById('userFilter').value = '';
        document.getElementById('dateRangeFilter').value = '';
        this.currentPage = 1;
        this.loadAuditLogs();
    }

    /**
     * 导出日志
     */
    async exportLogs() {
        try {
            UINotification.loading('正在导出日志...');

            // 生成 CSV 内容
            let csv = '时间,操作人,操作类型,数据表,记录ID,状态,IP地址\n';
            this.logs.forEach(log => {
                csv += `"${new Date(log.timestamp).toLocaleString()}","${log.user}","${this.getActionLabel(log.action)}","${log.table}","${log.recordId}","${log.status}","${log.ipAddress}"\n`;
            });

            // 创建下载链接
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
            link.click();

            UINotification.success('日志已导出');
        } catch (error) {
            console.error('❌ 导出日志错误:', error);
            UINotification.error('导出日志时出错');
        }
    }
}

// 导出并初始化
export function initAuditLog() {
    const auditLog = new AuditLog();
    window.auditLog = auditLog; // 暴露到全局以便内联事件使用
    auditLog.init();
    return auditLog;
}
