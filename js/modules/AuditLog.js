/**
 * AuditLog - 操作审计日志模块（按用户+日期分组版）
 * 主列表：每个用户每天的所有操作为一个条目，展示最新一条操作
 * 点击条目：弹出详情面板，显示该用户当天所有操作记录
 */

import { UINotification } from '../utils/UINotification.js';
import { getLogsByDate, getAvailableDates, clearAllLogs, logOperation } from '../utils/AuditLogger.js';

export class AuditLog {
    constructor() {
        this.moduleName = '审计日志';
        this.entries = [];       // 分组后的 (user, date) 条目
        this.currentPage = 1;
        this.pageSize = 15;
        this.filterDate = '';    // 筛选特定日期，空=全部
        this.filterUser = '';    // 筛选特定用户名
    }

    init() {
        console.log('🔧 ' + this.moduleName + ' 初始化中...');
        this.renderUI();
        this.bindEvents();
        this.loadEntries();
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
                            <i class="fas fa-download mr-2"></i>导出当天日志
                        </button>
                        <button id="btnClearAllLogs" class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition flex items-center">
                            <i class="fas fa-trash mr-2"></i>清空所有日志
                        </button>
                    </div>
                </div>

                <!-- 筛选条件 -->
                <div class="bg-white rounded-lg shadow-md p-4">
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">查看日期</label>
                            <div class="flex gap-2 items-center">
                                <input type="date" id="dateSelector"
                                    class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                                <button id="btnTodayLogs" class="px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 whitespace-nowrap">今天</button>
                            </div>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">操作用户</label>
                            <input type="text" id="userFilter" placeholder="输入用户名..."
                                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                        </div>
                        <div class="flex items-end gap-2">
                            <button id="btnFilterLogs" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">
                                <i class="fas fa-search mr-2"></i>筛选
                            </button>
                            <button id="btnClearFilters" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition">
                                <i class="fas fa-times mr-2"></i>重置
                            </button>
                        </div>
                    </div>
                </div>

                <!-- 有日志的日期快速跳转 -->
                <div id="dateChips" class="flex flex-wrap gap-2"></div>

                <!-- 汇总统计 -->
                <div id="logStats" class="grid grid-cols-3 md:grid-cols-6 gap-3"></div>

                <!-- 分组条目列表 -->
                <div class="bg-white rounded-lg shadow-md overflow-hidden">
                    <table class="w-full">
                        <thead class="bg-gray-100 border-b">
                            <tr>
                                <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">操作用户</th>
                                <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">日期</th>
                                <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">操作次数</th>
                                <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">最新操作</th>
                                <th class="px-4 py-3 text-left text-sm font-semibold text-gray-700">最新时间</th>
                                <th class="px-4 py-3 text-center text-sm font-semibold text-gray-700">操作</th>
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
                        共 <span id="totalCount">0</span> 条，第 <span id="currentPageNum">1</span> 页
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

            <!-- 详情弹窗 -->
            <div id="detailModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
                <div class="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
                    <div class="flex justify-between items-center p-5 border-b">
                        <h3 class="text-lg font-bold text-gray-800" id="detailTitle">操作详情</h3>
                        <button id="btnCloseDetail" class="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
                    </div>
                    <div class="overflow-y-auto flex-1 p-5">
                        <table class="w-full text-sm">
                            <thead class="bg-gray-50 sticky top-0">
                                <tr>
                                    <th class="px-3 py-2 text-left font-semibold text-gray-700">时间</th>
                                    <th class="px-3 py-2 text-left font-semibold text-gray-700">操作类型</th>
                                    <th class="px-3 py-2 text-left font-semibold text-gray-700">模块</th>
                                    <th class="px-3 py-2 text-left font-semibold text-gray-700">操作详情</th>
                                </tr>
                            </thead>
                            <tbody id="detailTable" class="divide-y"></tbody>
                        </table>
                    </div>
                    <div class="p-4 border-t text-right">
                        <button id="btnExportDetail" class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 mr-2">
                            <i class="fas fa-download mr-1"></i>导出此记录
                        </button>
                        <button id="btnCloseDetail2" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400">关闭</button>
                    </div>
                </div>
            </div>
        `;
    }

    bindEvents() {
        document.getElementById('btnFilterLogs')?.addEventListener('click', () => {
            this.filterDate = document.getElementById('dateSelector')?.value || '';
            this.filterUser = (document.getElementById('userFilter')?.value || '').trim().toLowerCase();
            this.currentPage = 1;
            this.loadEntries();
        });

        document.getElementById('btnClearFilters')?.addEventListener('click', () => {
            document.getElementById('dateSelector').value = '';
            document.getElementById('userFilter').value = '';
            this.filterDate = '';
            this.filterUser = '';
            this.currentPage = 1;
            this.loadEntries();
        });

        document.getElementById('btnTodayLogs')?.addEventListener('click', () => {
            const today = new Date().toISOString().slice(0, 10);
            document.getElementById('dateSelector').value = today;
            this.filterDate = today;
            this.filterUser = '';
            this.currentPage = 1;
            this.loadEntries();
        });

        document.getElementById('btnExportLogs')?.addEventListener('click', () => {
            const today = new Date().toISOString().slice(0, 10);
            this.exportDate(today);
        });

        document.getElementById('btnClearAllLogs')?.addEventListener('click', () => {
            if (confirm('确定要清空所有审计日志吗？此操作不可撤销。')) {
                clearAllLogs();
                logOperation('delete', 'system', '管理员清空所有审计日志');
                UINotification.success('所有日志已清空');
                this.loadEntries();
            }
        });

        document.getElementById('btnPrevPage')?.addEventListener('click', () => {
            if (this.currentPage > 1) { this.currentPage--; this.renderTable(); }
        });
        document.getElementById('btnNextPage')?.addEventListener('click', () => {
            if (this.currentPage * this.pageSize < this.entries.length) { this.currentPage++; this.renderTable(); }
        });

        document.getElementById('btnCloseDetail')?.addEventListener('click', () => this.closeDetail());
        document.getElementById('btnCloseDetail2')?.addEventListener('click', () => this.closeDetail());
    }

    /**
     * 加载并生成分组条目
     */
    loadEntries() {
        const dates = getAvailableDates();
        const entryMap = new Map(); // key: "user||date"

        for (const date of dates) {
            if (this.filterDate && date !== this.filterDate) continue;
            const logs = getLogsByDate(date);
            for (const log of logs) {
                const user = log.user || '未知用户';
                if (this.filterUser && !user.toLowerCase().includes(this.filterUser)) continue;
                const key = `${user}||${date}`;
                if (!entryMap.has(key)) {
                    entryMap.set(key, { user, date, logs: [] });
                }
                entryMap.get(key).logs.push(log);
            }
        }

        // 转为数组，每个条目取最新一条操作
        const entries = Array.from(entryMap.values()).map(entry => {
            const sorted = entry.logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            return {
                user: entry.user,
                date: entry.date,
                count: sorted.length,
                latest: sorted[0],
                allLogs: sorted
            };
        });

        // 按最新操作时间倒序排列
        entries.sort((a, b) => new Date(b.latest.timestamp) - new Date(a.latest.timestamp));
        this.entries = entries;
        this.currentPage = 1;

        this.renderDateChips();
        this.renderStats();
        this.renderTable();
    }

    renderDateChips() {
        const container = document.getElementById('dateChips');
        if (!container) return;
        const dates = getAvailableDates();
        if (dates.length === 0) { container.innerHTML = ''; return; }
        container.innerHTML = '<span class="text-sm text-gray-500 self-center mr-1">有记录的日期：</span>' +
            dates.map(d => {
                const active = d === this.filterDate ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300';
                return `<button class="px-3 py-1 text-sm rounded-full ${active} transition" onclick="window.auditLog.jumpToDate('${d}')">${d}</button>`;
            }).join('');
    }

    renderStats() {
        const container = document.getElementById('logStats');
        if (!container) return;
        const counts = { login: 0, logout: 0, create: 0, update: 0, delete: 0, export: 0 };
        for (const entry of this.entries) {
            for (const log of entry.allLogs) {
                if (log.action in counts) counts[log.action]++;
            }
        }
        const labels = { login: '登录', logout: '登出', create: '新增', update: '修改', delete: '删除', export: '导出' };
        const colors = { login: 'blue', logout: 'gray', create: 'green', update: 'yellow', delete: 'red', export: 'purple' };
        container.innerHTML = Object.entries(counts).map(([action, count]) => `
            <div class="bg-white rounded-lg shadow p-3 text-center">
                <div class="text-2xl font-bold text-${colors[action]}-600">${count}</div>
                <div class="text-xs text-gray-500 mt-1">${labels[action]}</div>
            </div>
        `).join('');
    }

    renderTable() {
        const tbody = document.getElementById('logTable');
        const emptyTip = document.getElementById('emptyTip');
        if (!tbody) return;

        if (this.entries.length === 0) {
            tbody.innerHTML = '';
            emptyTip?.classList.remove('hidden');
            document.getElementById('totalCount').textContent = '0';
            document.getElementById('currentPageNum').textContent = '1';
            return;
        }
        emptyTip?.classList.add('hidden');

        const start = (this.currentPage - 1) * this.pageSize;
        const page = this.entries.slice(start, start + this.pageSize);

        tbody.innerHTML = page.map((entry, idx) => {
            const entryIndex = start + idx;
            const latest = entry.latest;
            const actionLabel = this.getActionLabel(latest.action);
            const actionColor = this.getActionColor(latest.action);
            const timeStr = new Date(latest.timestamp).toLocaleTimeString('zh-CN', { hour12: false });

            return `
                <tr class="hover:bg-blue-50 transition cursor-pointer" onclick="window.auditLog.showDetail(${entryIndex})">
                    <td class="px-4 py-3">
                        <div class="flex items-center gap-2">
                            <div class="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                                <i class="fas fa-user text-blue-600 text-xs"></i>
                            </div>
                            <span class="font-medium text-gray-800">${this.escapeHtml(entry.user)}</span>
                        </div>
                    </td>
                    <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">${entry.date}</td>
                    <td class="px-4 py-3">
                        <span class="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-700 font-bold text-sm">${entry.count}</span>
                    </td>
                    <td class="px-4 py-3">
                        <span class="px-2 py-1 rounded-full text-xs font-medium ${actionColor} mr-2">${actionLabel}</span>
                        <span class="text-sm text-gray-700">${this.getModuleLabel(latest.module)} · ${this.escapeHtml(latest.detail || '')}</span>
                    </td>
                    <td class="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">${timeStr}</td>
                    <td class="px-4 py-3 text-center">
                        <button class="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
                            onclick="event.stopPropagation(); window.auditLog.showDetail(${entryIndex})">
                            查看详情
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        document.getElementById('totalCount').textContent = this.entries.length;
        document.getElementById('currentPageNum').textContent = this.currentPage;
    }

    /**
     * 显示指定条目的详情弹窗
     */
    showDetail(entryIndex) {
        const entry = this.entries[entryIndex];
        if (!entry) return;

        document.getElementById('detailTitle').textContent =
            `${this.escapeHtml(entry.user)} 的操作记录 · ${entry.date}（共 ${entry.count} 次操作）`;

        const tbody = document.getElementById('detailTable');
        tbody.innerHTML = entry.allLogs.map(log => {
            const actionLabel = this.getActionLabel(log.action);
            const actionColor = this.getActionColor(log.action);
            const timeStr = new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
            return `
                <tr class="hover:bg-gray-50">
                    <td class="px-3 py-2 text-gray-600 whitespace-nowrap">${timeStr}</td>
                    <td class="px-3 py-2">
                        <span class="px-2 py-1 rounded-full text-xs font-medium ${actionColor}">${actionLabel}</span>
                    </td>
                    <td class="px-3 py-2 text-gray-600">${this.getModuleLabel(log.module)}</td>
                    <td class="px-3 py-2 text-gray-700">${this.escapeHtml(log.detail || '')}</td>
                </tr>
            `;
        }).join('');

        // 绑定导出按钮
        document.getElementById('btnExportDetail').onclick = () => this.exportEntryLogs(entry);
        document.getElementById('detailModal').classList.remove('hidden');
    }

    closeDetail() {
        document.getElementById('detailModal').classList.add('hidden');
    }

    jumpToDate(dateStr) {
        this.filterDate = dateStr;
        const sel = document.getElementById('dateSelector');
        if (sel) sel.value = dateStr;
        this.filterUser = '';
        this.currentPage = 1;
        this.loadEntries();
    }

    exportDate(dateStr) {
        try {
            const logs = getLogsByDate(dateStr);
            if (logs.length === 0) { UINotification.error('当天暂无日志'); return; }
            let csv = '\uFEFF时间,操作人,操作类型,模块,操作详情\n';
            logs.forEach(log => {
                const time = new Date(log.timestamp).toLocaleString('zh-CN');
                csv += `"${time}","${log.user || ''}","${this.getActionLabel(log.action)}","${this.getModuleLabel(log.module)}","${(log.detail || '').replace(/"/g, '""')}"\n`;
            });
            this._downloadCsv(csv, `audit-${dateStr}.csv`);
            UINotification.success('日志已导出');
        } catch (e) {
            UINotification.error('导出失败');
        }
    }

    exportEntryLogs(entry) {
        try {
            let csv = '\uFEFF时间,操作人,操作类型,模块,操作详情\n';
            entry.allLogs.forEach(log => {
                const time = new Date(log.timestamp).toLocaleString('zh-CN');
                csv += `"${time}","${log.user || ''}","${this.getActionLabel(log.action)}","${this.getModuleLabel(log.module)}","${(log.detail || '').replace(/"/g, '""')}"\n`;
            });
            this._downloadCsv(csv, `audit-${entry.user}-${entry.date}.csv`);
            UINotification.success('日志已导出');
        } catch (e) {
            UINotification.error('导出失败');
        }
    }

    _downloadCsv(csv, filename) {
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
    }

    getActionLabel(action) {
        const m = { login: '登录', logout: '登出', create: '新增', update: '修改', delete: '删除', export: '导出' };
        return m[action] || action;
    }

    getActionColor(action) {
        const m = {
            create: 'bg-green-100 text-green-800',
            update: 'bg-blue-100 text-blue-800',
            delete: 'bg-red-100 text-red-800',
            export: 'bg-purple-100 text-purple-800',
            login: 'bg-yellow-100 text-yellow-800',
            logout: 'bg-gray-100 text-gray-800'
        };
        return m[action] || 'bg-gray-100 text-gray-800';
    }

    getModuleLabel(module) {
        const m = {
            tableware: '餐具洁净', pesticide: '果蔬农残', oil: '食用油',
            leanMeat: '肉蛋检测', pathogen: '病原体', users: '用户管理', system: '系统'
        };
        return m[module] || module || '-';
    }

    escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

export function initAuditLog() {
    const auditLog = new AuditLog();
    window.auditLog = auditLog;
    auditLog.init();
    return auditLog;
}


