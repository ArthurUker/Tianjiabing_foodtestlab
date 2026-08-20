/**
 * AuditLog.js —— 学校租户审计日志模块（index.html #audit-log 区块）
 *
 * 设计对齐：本页的搜索控件、动作下拉、详情列显示、分页，
 * 与平台超管界面（admin-schools.html → auditView.js）保持完全一致。
 * 仅额外保留学校租户相关能力：用户下拉、仅本人筛选、KPI 卡片、统计分析、CSV 导出、详情弹窗。
 *
 * 接口：window.AuditLog.init()
 */

const AuditLog = (() => {
    // 操作类型（与超管 auditView.actionTypes 一致：完整 15 项）
    const actionTypes = [
        { value: 'login', label: '登录' },
        { value: 'logout', label: '登出' },
        { value: 'create', label: '新增' },
        { value: 'update', label: '修改' },
        { value: 'delete', label: '删除' },
        { value: 'export', label: '导出' },
        { value: 'import', label: '导入' },
        { value: 'print', label: '打印' },
        { value: 'view', label: '查看' },
        { value: 'search', label: '搜索' },
        { value: 'download', label: '下载' },
        { value: 'upload', label: '上传' },
        { value: 'assign', label: '分配' },
        { value: 'unassign', label: '取消分配' },
        { value: 'reset', label: '重置' }
    ];

    // 操作类型展示标签（完整覆盖 15 项）
    const actionLabels = {
        login: '登录', logout: '登出', create: '新增', update: '修改', delete: '删除',
        export: '导出', import: '导入', print: '打印', view: '查看', search: '搜索',
        download: '下载', upload: '上传', assign: '分配', unassign: '取消分配', reset: '重置'
    };

    // 资源类型展示标签（与超管 auditView.resourceTypes 一致）
    const resourceTypes = [
        { value: 'tableware_test', label: '餐具检测' },
        { value: 'pesticide_test', label: '农药残留检测' },
        { value: 'oil_test', label: '食用油检测' },
        { value: 'lean_meat_test', label: '瘦肉精检测' },
        { value: 'pathogen_test', label: '致病菌检测' },
        { value: 'user', label: '用户' },
        { value: 'detergent_image', label: '洗消图片' },
        { value: 'backup', label: '备份' },
        { value: 'restore', label: '恢复' },
        { value: 'report', label: '报表' },
        { value: 'system', label: '系统' },
        { value: 'school', label: '学校' },
        { value: 'config', label: '配置' },
        { value: 'attachment', label: '附件' },
        { value: 'record', label: '记录' },
        { value: 'unknown', label: '未知' }
    ];

    // 模块状态
    const state = {
        currentPage: 1,
        pageSize: 20,
        totalPages: 1,
        totalCount: 0,
        logs: [],
        filters: {
            action: '',
            userId: '',
            startDate: '',
            endDate: '',
            selfOnly: false
        },
        stats: null,
        users: [],
        kpi: null
    };

    // ====================== 工具函数 ======================
    function formatDateTime(dt) {
        if (!dt) return '—';
        const d = new Date(dt);
        if (isNaN(d.getTime())) return '—';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function truncateText(text, max = 60) {
        if (!text) return '';
        text = String(text);
        return text.length > max ? text.slice(0, max) + '…' : text;
    }

    // 资源类型本地化（与超管一致）
    function getResourceLabel(type) {
        const found = resourceTypes.find((r) => r.value === type);
        return found ? found.label : (type || '—');
    }

    function getActionLabel(action) {
        return actionLabels[action] || action || '—';
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 生成 CSV 字段（防止 Excel 公式注入）
    function csvField(value) {
        let v = value === null || value === undefined ? '' : String(value);
        v = v.replace(/"/g, '""');
        if (/^[=+\-@]/.test(v)) v = "'" + v;
        return '"' + v + '"';
    }

    // 统一 fetch 封装（保持与现有实现一致）
    async function fetchApi(path, options = {}) {
        const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
        const headers = Object.assign({}, options.headers || {}, {
            'Content-Type': 'application/json'
        });
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const resp = await fetch(path, { ...options, headers });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            throw new Error(`请求失败 ${resp.status}: ${errText}`);
        }
        return resp.json();
    }

    // ====================== 数据获取 ======================
    function buildParams() {
        const params = new URLSearchParams();
        const f = state.filters;
        if (f.action) params.set('action', f.action);
        if (f.userId) params.set('userId', f.userId);
        if (f.startDate) params.set('startDate', f.startDate);
        if (f.endDate) params.set('endDate', f.endDate);
        params.set('limit', String(state.pageSize));
        params.set('offset', String((state.currentPage - 1) * state.pageSize));
        return params;
    }

    async function fetchLogs() {
        const params = buildParams();
        const json = await fetchApi(`/api/audit-logs?${params.toString()}`);
        const logs = (json.data || []).map((log) => ({
            id: log.id,
            user: log.user || { username: '系统', full_name: '' },
            action: log.action,
            resource_type: log.resource_type,
            resource_id: log.resource_id,
            details: log.details,
            ip_address: log.ip_address,
            created_at: log.created_at
        }));
        state.logs = logs;
        state.totalCount = json.total || 0;
        state.totalPages = Math.max(1, Math.ceil(state.totalCount / state.pageSize));
        if (state.currentPage > state.totalPages) state.currentPage = state.totalPages;
        return logs;
    }

    async function fetchUsers() {
        try {
            const json = await fetchApi('/api/audit-logs/users');
            state.users = json.data || [];
        } catch (e) {
            state.users = [];
        }
    }

    async function fetchStatsSummary(date) {
        try {
            const params = new URLSearchParams();
            if (date) params.set('date', date);
            const json = await fetchApi(`/api/audit-logs/stats/summary?${params.toString()}`);
            state.stats = json.data;
        } catch (e) {
            state.stats = null;
        }
    }

    // KPI 卡片数值由已有 /stats/summary 端点聚合得到（避免新增后端端点）
    function computeKpiFromStats() {
        const s = state.stats;
        if (!s) { state.kpi = null; return; }
        const byAction = {};
        (s.actionStats || []).forEach((a) => { byAction[a.action] = a._count ? a._count.id : a.count; });
        state.kpi = {
            total: s.totalLogs || 0,
            create: byAction.create || 0,
            update: byAction.update || 0,
            delete: byAction.delete || 0
        };
    }

    // ====================== 渲染 ======================
    function auditToolbarHTML() {
        const actionOptions = actionTypes
            .map((a) => `<option value="${a.value}" ${state.filters.action === a.value ? 'selected' : ''}>${a.label}</option>`)
            .join('');
        const userOptions = state.users
            .map((u) => `<option value="${u.id}" ${state.filters.userId === u.id ? 'selected' : ''}>${escapeHtml(u.full_name || u.username)}</option>`)
            .join('');
        const pageSizeOptions = [10, 20, 50, 100]
            .map((s) => `<option value="${s}" ${state.pageSize === s ? 'selected' : ''}>${s} 条/页</option>`)
            .join('');

        return `
        <div class="audit-toolbar bg-white rounded-lg shadow-sm p-4 mb-4 border border-gray-100">
            <div class="flex flex-wrap items-end gap-3">
                <div>
                    <label class="block text-xs text-gray-500 mb-1">操作类型</label>
                    <select id="audit-action-filter" class="border rounded px-3 py-2 text-sm w-40">
                        <option value="">全部操作</option>
                        ${actionOptions}
                    </select>
                </div>
                <div>
                    <label class="block text-xs text-gray-500 mb-1">用户</label>
                    <select id="audit-user-filter" class="border rounded px-3 py-2 text-sm w-44">
                        <option value="">全部用户</option>
                        ${userOptions}
                    </select>
                </div>
                <div>
                    <label class="block text-xs text-gray-500 mb-1">开始日期</label>
                    <input type="date" id="audit-start-date" value="${state.filters.startDate}" class="border rounded px-3 py-2 text-sm">
                </div>
                <div>
                    <label class="block text-xs text-gray-500 mb-1">结束日期</label>
                    <input type="date" id="audit-end-date" value="${state.filters.endDate}" class="border rounded px-3 py-2 text-sm">
                </div>
                <div class="flex items-end gap-1">
                    <button id="audit-range-all" class="audit-quick px-3 py-2 text-xs rounded border border-gray-200 hover:bg-gray-50">全部时间</button>
                    <button id="audit-range-today" class="audit-quick px-3 py-2 text-xs rounded border border-gray-200 hover:bg-gray-50">今天</button>
                    <button id="audit-range-7" class="audit-quick px-3 py-2 text-xs rounded border border-gray-200 hover:bg-gray-50">最近7天</button>
                    <button id="audit-range-30" class="audit-quick px-3 py-2 text-xs rounded border border-gray-200 hover:bg-gray-50">最近30天</button>
                </div>
                <div class="flex items-end gap-2">
                    <button id="audit-search-btn" class="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700"><i class="fas fa-search mr-1"></i>搜索</button>
                    <button id="audit-reset-btn" class="bg-gray-100 text-gray-700 px-4 py-2 rounded text-sm hover:bg-gray-200">重置</button>
                </div>
                <label class="flex items-end gap-2 text-sm text-gray-600 pb-2">
                    <input type="checkbox" id="audit-self-only" ${state.filters.selfOnly ? 'checked' : ''}>
                    仅查看本人
                </label>
            </div>
        </div>`;
    }

    function statCardsHTML() {
        const s = state.stats;
        if (!s) return '';
        const topUser = (s.topUsers && s.topUsers[0]) || null;
        const userText = topUser
            ? `${topUser.full_name || topUser.username} (${topUser.count})`
            : '—';
        return `
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div class="bg-white rounded-lg shadow-sm p-4 border border-gray-100">
                <div class="text-xs text-gray-500">总日志数</div>
                <div class="text-2xl font-semibold text-blue-600">${s.totalLogs ?? 0}</div>
            </div>
            <div class="bg-white rounded-lg shadow-sm p-4 border border-gray-100">
                <div class="text-xs text-gray-500">操作类型数</div>
                <div class="text-2xl font-semibold text-green-600">${(s.actionStats || []).length}</div>
            </div>
            <div class="bg-white rounded-lg shadow-sm p-4 border border-gray-100">
                <div class="text-xs text-gray-500">最活跃用户</div>
                <div class="text-lg font-semibold text-purple-600 truncate" title="${escapeHtml(userText)}">${escapeHtml(userText)}</div>
            </div>
        </div>`;
    }

    function kpiCardsHTML() {
        const k = state.kpi;
        if (!k) return '';
        return `
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
            <div class="bg-white rounded-lg shadow-sm p-4 border border-gray-100">
                <div class="text-xs text-gray-500">总操作数</div>
                <div class="text-2xl font-semibold text-blue-600">${k.total || 0}</div>
            </div>
            <div class="bg-white rounded-lg shadow-sm p-4 border border-gray-100">
                <div class="text-xs text-gray-500">新增</div>
                <div class="text-2xl font-semibold text-green-600">${k.create || 0}</div>
            </div>
            <div class="bg-white rounded-lg shadow-sm p-4 border border-gray-100">
                <div class="text-xs text-gray-500">修改</div>
                <div class="text-2xl font-semibold text-orange-600">${k.update || 0}</div>
            </div>
            <div class="bg-white rounded-lg shadow-sm p-4 border border-gray-100">
                <div class="text-xs text-gray-500">删除</div>
                <div class="text-2xl font-semibold text-red-600">${k.delete || 0}</div>
            </div>
        </div>`;
    }

    function detailSummary(log) {
        const d = log.details;
        const who = log.user ? (log.user.full_name || log.user.username) : '系统';
        const what = getResourceLabel(log.resource_type);
        if (!d) return `${who} 对${what}执行了${getActionLabel(log.action)}操作`;
        if (typeof d === 'string') return truncateText(d, 80);
        if (d.reason || d.note) return truncateText(d.reason || d.note, 80);
        if (d.method) return `${who} 使用${d.method}对${what}执行${getActionLabel(log.action)}`;
        if (d.target) return `${who} 对${what}「${truncateText(d.target, 30)}」执行${getActionLabel(log.action)}`;
        if (d.count) return `${who} ${getActionLabel(log.action)}${what} ${d.count} 条`;
        return `${who} 对${what}执行了${getActionLabel(log.action)}操作`;
    }

    function buildTable(logs) {
        if (!logs.length) {
            return `<div class="text-center text-gray-400 py-10">暂无审计日志数据</div>`;
        }
        const rows = logs.map((log) => {
            const who = log.user ? (log.user.full_name || log.user.username) : '系统';
            const resourceIdText = log.resource_id ? truncateText(log.resource_id, 16) : '—';
            return `
            <tr class="border-b hover:bg-gray-50 cursor-pointer" data-log-id="${log.id}">
                <td class="px-3 py-2 text-sm whitespace-nowrap">${formatDateTime(log.created_at)}</td>
                <td class="px-3 py-2 text-sm">${escapeHtml(who)}</td>
                <td class="px-3 py-2 text-sm"><span class="inline-block px-2 py-1 rounded bg-blue-50 text-blue-700 text-xs">${getActionLabel(log.action)}</span></td>
                <td class="px-3 py-2 text-sm">${getResourceLabel(log.resource_type)}</td>
                <td class="px-3 py-2 text-sm font-mono text-xs text-gray-500" title="${escapeHtml(log.resource_id || '')}">${escapeHtml(resourceIdText)}</td>
                <td class="px-3 py-2 text-sm text-gray-600">${escapeHtml(detailSummary(log))}</td>
                <td class="px-3 py-2 text-sm font-mono text-xs text-gray-500">${escapeHtml(log.ip_address || '—')}</td>
            </tr>`;
        }).join('');

        return `
        <div class="overflow-x-auto bg-white rounded-lg shadow-sm border border-gray-100">
            <table class="w-full text-left">
                <thead class="bg-gray-50 text-gray-600 text-sm">
                    <tr>
                        <th class="px-3 py-2 font-medium">时间</th>
                        <th class="px-3 py-2 font-medium">用户</th>
                        <th class="px-3 py-2 font-medium">操作</th>
                        <th class="px-3 py-2 font-medium">资源类型</th>
                        <th class="px-3 py-2 font-medium">资源ID</th>
                        <th class="px-3 py-2 font-medium">详情</th>
                        <th class="px-3 py-2 font-medium">IP</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    }

    function paginationHTML() {
        const total = state.totalCount;
        const page = state.currentPage;
        const totalPages = state.totalPages;
        const pageSizeOptions = [10, 20, 50, 100]
            .map((s) => `<option value="${s}" ${state.pageSize === s ? 'selected' : ''}>${s} 条/页</option>`)
            .join('');

        // 页码窗口（与超管一致：最多显示 7 个页码按钮）
        const windowSize = 7;
        let start = Math.max(1, page - Math.floor(windowSize / 2));
        let end = Math.min(totalPages, start + windowSize - 1);
        start = Math.max(1, end - windowSize + 1);
        const pages = [];
        for (let i = start; i <= end; i++) {
            pages.push(`<button class="audit-page px-3 py-1 text-sm rounded border ${i === page ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 hover:bg-gray-50'}" data-page="${i}">${i}</button>`);
        }

        return `
        <div class="flex flex-wrap items-center justify-between gap-3 mt-4">
            <div class="text-sm text-gray-500">
                共 ${total} 条 · 第 ${page}/${totalPages} 页
            </div>
            <div class="flex items-center gap-2">
                <button id="audit-first" class="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50" ${page <= 1 ? 'disabled' : ''}>« 首页</button>
                <button id="audit-prev" class="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50" ${page <= 1 ? 'disabled' : ''}>上一页</button>
                ${pages.join('')}
                <button id="audit-next" class="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
                <button id="audit-last" class="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50" ${page >= totalPages ? 'disabled' : ''}>末页 »</button>
            </div>
            <div class="flex items-center gap-2">
                <select id="audit-page-size" class="border rounded px-2 py-1 text-sm">${pageSizeOptions}</select>
                <span class="text-sm text-gray-500">跳至</span>
                <input id="audit-jump" type="number" min="1" max="${totalPages}" value="${page}" class="border rounded px-2 py-1 text-sm w-16">
                <button id="audit-jump-btn" class="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50">跳转</button>
            </div>
        </div>`;
    }

    function render() {
        const root = document.getElementById('audit-log');
        if (!root) return;
        root.innerHTML = `
            <div class="audit-header flex items-center justify-between mb-4">
                <div>
                    <h2 class="text-xl font-semibold text-gray-800">审计日志</h2>
                    <p class="text-sm text-gray-500">记录系统内所有关键操作，支持按操作类型、用户、时间范围筛选</p>
                </div>
                <div class="flex items-center gap-2">
                    <button id="audit-export-btn" class="bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700"><i class="fas fa-file-csv mr-1"></i>导出CSV</button>
                    <button id="audit-refresh-btn" class="bg-gray-100 text-gray-700 px-4 py-2 rounded text-sm hover:bg-gray-200"><i class="fas fa-sync mr-1"></i>刷新</button>
                </div>
            </div>
            ${statCardsHTML()}
            ${kpiCardsHTML()}
            ${auditToolbarHTML()}
            <div id="audit-table-container">${buildTable(state.logs)}</div>
            ${paginationHTML()}
            <div id="audit-detail-modal" class="hidden fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center">
                <div class="bg-white rounded-lg max-w-lg w-full p-6 relative">
                    <button id="audit-detail-close" class="absolute top-3 right-3 text-gray-400 hover:text-gray-700"><i class="fas fa-times"></i></button>
                    <h3 class="text-lg font-semibold mb-4">审计日志详情</h3>
                    <div id="audit-detail-body"></div>
                </div>
            </div>`;
        bindToolbarEvents();
    }

    // ====================== 详情弹窗 ======================
    function openDetail(log) {
        const body = document.getElementById('audit-detail-body');
        if (!body) return;
        const who = log.user ? (log.user.full_name || log.user.username) : '系统';
        let detailsText = '—';
        if (log.details) {
            detailsText = typeof log.details === 'string'
                ? escapeHtml(log.details)
                : `<pre class="text-xs bg-gray-50 p-2 rounded overflow-auto">${escapeHtml(JSON.stringify(log.details, null, 2))}</pre>`;
        }
        body.innerHTML = `
            <div class="space-y-2 text-sm">
                <div><span class="text-gray-500">时间：</span>${formatDateTime(log.created_at)}</div>
                <div><span class="text-gray-500">用户：</span>${escapeHtml(who)}</div>
                <div><span class="text-gray-500">操作：</span>${getActionLabel(log.action)}</div>
                <div><span class="text-gray-500">资源类型：</span>${getResourceLabel(log.resource_type)}</div>
                <div><span class="text-gray-500">资源ID：</span><span class="font-mono text-xs">${escapeHtml(log.resource_id || '—')}</span></div>
                <div><span class="text-gray-500">IP：</span>${escapeHtml(log.ip_address || '—')}</div>
                <div class="pt-2"><span class="text-gray-500">详情：</span>${detailsText}</div>
            </div>`;
        document.getElementById('audit-detail-modal').classList.remove('hidden');
    }

    function closeDetail() {
        const m = document.getElementById('audit-detail-modal');
        if (m) m.classList.add('hidden');
    }

    // ====================== 事件绑定 ======================
    function applyFiltersFromUI() {
        const actionEl = document.getElementById('audit-action-filter');
        const userEl = document.getElementById('audit-user-filter');
        const startEl = document.getElementById('audit-start-date');
        const endEl = document.getElementById('audit-end-date');
        const selfEl = document.getElementById('audit-self-only');
        state.filters.action = actionEl ? actionEl.value : '';
        state.filters.userId = (selfEl && selfEl.checked) ? '' : (userEl ? userEl.value : '');
        state.filters.startDate = startEl ? startEl.value : '';
        state.filters.endDate = endEl ? endEl.value : '';
        state.filters.selfOnly = selfEl ? selfEl.checked : false;

        // 「仅本人」选中时，清空用户下拉，避免冲突
        if (state.filters.selfOnly && userEl) userEl.value = '';
    }

    async function reload() {
        state.currentPage = 1;
        await loadData();
        render();
    }

    async function loadData() {
        await Promise.all([
            fetchLogs(),
            fetchStatsSummary(state.filters.startDate || undefined)
        ]);
        computeKpiFromStats();
    }

    function bindToolbarEvents() {
        const searchBtn = document.getElementById('audit-search-btn');
        const resetBtn = document.getElementById('audit-reset-btn');
        const refreshBtn = document.getElementById('audit-refresh-btn');
        const exportBtn = document.getElementById('audit-export-btn');
        const selfOnly = document.getElementById('audit-self-only');
        const userFilter = document.getElementById('audit-user-filter');

        if (searchBtn) searchBtn.addEventListener('click', reload);
        if (resetBtn) resetBtn.addEventListener('click', () => {
            state.filters = { action: '', userId: '', startDate: '', endDate: '', selfOnly: false };
            state.currentPage = 1;
            const af = document.getElementById('audit-action-filter');
            const uf = document.getElementById('audit-user-filter');
            const sd = document.getElementById('audit-start-date');
            const ed = document.getElementById('audit-end-date');
            if (af) af.value = '';
            if (uf) uf.value = '';
            if (sd) sd.value = '';
            if (ed) ed.value = '';
            if (selfOnly) selfOnly.checked = false;
            loadData().then(render);
        });
        if (refreshBtn) refreshBtn.addEventListener('click', () => loadData().then(render));
        if (exportBtn) exportBtn.addEventListener('click', exportLogs);

        // 「仅本人」与用户下拉互斥
        if (selfOnly) selfOnly.addEventListener('change', () => {
            if (selfOnly.checked && userFilter) userFilter.value = '';
        });
        if (userFilter) userFilter.addEventListener('change', () => {
            if (userFilter.value && selfOnly) selfOnly.checked = false;
        });

        // 日期快捷按钮（与超管一致：全部时间 / 今天 / 最近7天 / 最近30天）
        const bindQuick = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', () => {
                fn();
                const sd = document.getElementById('audit-start-date');
                const ed = document.getElementById('audit-end-date');
                if (sd) sd.value = state.filters.startDate;
                if (ed) ed.value = state.filters.endDate;
            });
        };
        const today = () => {
            const t = new Date();
            const iso = t.toISOString().slice(0, 10);
            state.filters.startDate = iso;
            state.filters.endDate = iso;
        };
        const daysAgo = (n) => {
            const t = new Date();
            t.setDate(t.getDate() - n);
            state.filters.startDate = t.toISOString().slice(0, 10);
            const now = new Date();
            state.filters.endDate = now.toISOString().slice(0, 10);
        };
        bindQuick('audit-range-all', () => { state.filters.startDate = ''; state.filters.endDate = ''; });
        bindQuick('audit-range-today', today);
        bindQuick('audit-range-7', () => daysAgo(7));
        bindQuick('audit-range-30', () => daysAgo(30));

        // 行点击 → 详情弹窗
        document.querySelectorAll('#audit-table-container tr[data-log-id]').forEach((tr) => {
            tr.addEventListener('click', () => {
                const id = tr.getAttribute('data-log-id');
                const log = state.logs.find((l) => l.id === id);
                if (log) openDetail(log);
            });
        });

        // 分页事件
        const prev = document.getElementById('audit-prev');
        const next = document.getElementById('audit-next');
        const first = document.getElementById('audit-first');
        const last = document.getElementById('audit-last');
        const jumpBtn = document.getElementById('audit-jump-btn');
        const pageSizeSel = document.getElementById('audit-page-size');
        const detailClose = document.getElementById('audit-detail-close');

        if (prev) prev.addEventListener('click', () => { if (state.currentPage > 1) { state.currentPage--; loadData().then(render); } });
        if (next) next.addEventListener('click', () => { if (state.currentPage < state.totalPages) { state.currentPage++; loadData().then(render); } });
        if (first) first.addEventListener('click', () => { state.currentPage = 1; loadData().then(render); });
        if (last) last.addEventListener('click', () => { state.currentPage = state.totalPages; loadData().then(render); });
        document.querySelectorAll('.audit-page').forEach((b) => {
            b.addEventListener('click', () => {
                const p = parseInt(b.getAttribute('data-page'), 10);
                if (p && p !== state.currentPage) { state.currentPage = p; loadData().then(render); }
            });
        });
        if (jumpBtn) jumpBtn.addEventListener('click', () => {
            const j = document.getElementById('audit-jump');
            const p = parseInt(j.value, 10);
            if (p >= 1 && p <= state.totalPages) { state.currentPage = p; loadData().then(render); }
        });
        if (pageSizeSel) pageSizeSel.addEventListener('change', () => {
            state.pageSize = parseInt(pageSizeSel.value, 10);
            state.currentPage = 1;
            loadData().then(render);
        });
        if (detailClose) detailClose.addEventListener('click', closeDetail);
        const modal = document.getElementById('audit-detail-modal');
        if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeDetail(); });
    }

    // ====================== 导出 ======================
    async function exportLogs() {
        try {
            const params = new URLSearchParams();
            if (state.filters.startDate) params.set('start_date', state.filters.startDate);
            if (state.filters.endDate) params.set('end_date', state.filters.endDate);
            if (state.filters.action) params.set('action', state.filters.action);
            const token = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token');
            const resp = await fetch(`/api/audit-logs/export?${params.toString()}`, {
                headers: token ? { Authorization: 'Bearer ' + token } : {}
            });
            if (!resp.ok) throw new Error('导出失败');
            const csv = await resp.text();
            const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('导出失败：' + e.message);
        }
    }

    // ====================== 初始化 ======================
    async function init() {
        // 普通用户默认仅本人
        try {
            const userStr = localStorage.getItem('current_user') || sessionStorage.getItem('current_user');
            if (userStr) {
                const u = JSON.parse(userStr);
                if (u.role && u.role !== 'admin' && u.role !== 'manager') {
                    state.filters.selfOnly = true;
                }
            }
        } catch (e) { /* ignore */ }

        await fetchUsers();
        await loadData();
        render();
    }

    return { init };
})();

export const initAuditLog = () => AuditLog.init();

window.AuditLog = AuditLog;
