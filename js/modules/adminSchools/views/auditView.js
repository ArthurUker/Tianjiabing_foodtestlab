/**
 * 「审计日志」独立一级视图
 *
 * 包含两个子视图：
 *   1. 控制台审计日志（public.AuditLog，平台超管自身操作）
 *   2. 学校审计日志（按学校 code 切换租户 schema 后读取该校 AuditLog）
 *
 * 两个人视图共用同一套可读性渲染与详情弹窗，仅数据源与 DOM 前缀不同。
 */
import { adminFetch } from '../context.js';
import { escapeHtml } from '../ui.js';

export function initAuditView() {
    // ------------------------------------------------------------------
    // 子视图切换
    // ------------------------------------------------------------------
    function switchAuditSubview(subName) {
        const subs = document.querySelectorAll('#adminViewAudit .admin-subview');
        subs.forEach((s) => s.classList.toggle('hidden', s.getAttribute('data-subview') !== subName));
        document.querySelectorAll('[data-subnav="audit"] .admin-sidebar__subitem[data-subview]').forEach((s) => {
            s.classList.toggle('active', s.getAttribute('data-subview') === subName);
        });
        if (subName === 'console') consolePane.load();
        if (subName === 'school') schoolPane.load();
    }

    // ------------------------------------------------------------------
    // 审计日志面板工厂（复用给 console / school 两套 DOM）
    // ------------------------------------------------------------------
    function createAuditLogPane({ prefix, fetchLogs }) {
        const state = { page: 1, perPage: 50, total: 0, totalPages: 1, logs: [], currentDetailLog: null };
        const el = (id) => document.getElementById(prefix + id);

        function getParams() {
            const start = el('StartDate')?.value;
            const end = el('EndDate')?.value;
            const actor = el('Actor')?.value.trim();
            const action = el('Action')?.value;
            const params = new URLSearchParams();
            if (start) params.set('startDate', new Date(start).toISOString());
            if (end) params.set('endDate', new Date(end).toISOString());
            if (actor) params.set('userId', actor);
            if (action) params.set('action', action);
            params.set('offset', String((state.page - 1) * state.perPage));
            params.set('limit', String(state.perPage));
            return params;
        }

        async function load() {
            const tbody = el('InlineList');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">加载中…</td></tr>';
            try {
                const params = getParams();
                const { list, total } = await fetchLogs(params);
                state.total = Number(total ?? list.length);
                state.totalPages = Math.max(1, Math.ceil(state.total / state.perPage));
                if (state.page > state.totalPages) {
                    state.page = state.totalPages;
                    return load();
                }
                state.logs = list;
                if (!Array.isArray(list) || list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">暂无日志记录</td></tr>';
                    updatePagination();
                    return;
                }
                tbody.innerHTML = list.map((l) => {
                    const ts = l.created_at || l.createdAt || l.timestamp || '-';
                    const actor = l.user?.username || l.user?.full_name || l.user_id || '-';
                    const action = l.action || '-';
                    const target = l.resource_type ? `${l.resource_type}#${l.resource_id || ''}` : '-';
                    const description = describeAuditLog(l);
                    return `
                        <tr class="hover:bg-gray-50 cursor-pointer" data-log-id="${escapeHtml(String(l.id || ''))}">
                            <td class="px-3 py-2 text-gray-700 whitespace-nowrap">${escapeHtml(formatAuditTime(ts))}</td>
                            <td class="px-3 py-2 text-gray-800">${escapeHtml(String(actor))}</td>
                            <td class="px-3 py-2"><span class="inline-flex px-2 py-0.5 ${getActionColor(action)} rounded-full text-xs">${escapeHtml(getActionLabel(action))}</span></td>
                            <td class="px-3 py-2 text-gray-600 font-mono">${escapeHtml(String(target))}</td>
                            <td class="px-3 py-2 text-gray-600">
                                <div class="flex items-center gap-2">
                                    <span class="truncate max-w-xs" title="${escapeHtml(description.full)}">${escapeHtml(description.preview)}</span>
                                    <button type="button" class="audit-view-detail-btn px-2 py-0.5 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 whitespace-nowrap" title="查看完整详情">查看</button>
                                </div>
                            </td>
                        </tr>`;
                }).join('');
                updatePagination();
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="5" class="text-center text-red-500 py-6">查询失败：${escapeHtml(String(e.message || e))}</td></tr>`;
                updatePagination();
            }
        }

        function updatePagination() {
            const info = el('PaginationInfo');
            const total = state.total;
            const start = total === 0 ? 0 : (state.page - 1) * state.perPage + 1;
            const end = Math.min(start + state.perPage - 1, total);
            if (info) info.textContent = total > 0 ? `显示 ${start}-${end} 条，共 ${total} 条（${state.totalPages} 页）` : '暂无记录';

            const container = el('PageButtonsContainer');
            if (container) {
                const pages = state.totalPages;
                let startPage = Math.max(1, state.page - 2);
                let endPage = Math.min(pages, startPage + 4);
                if (endPage - startPage < 4 && pages > 4) startPage = Math.max(1, endPage - 4);
                let html = '';
                for (let i = startPage; i <= endPage; i++) {
                    const active = i === state.page;
                    html += `<button type="button" class="${prefix}-page-btn px-3 py-1 ${active ? 'bg-blue-500 text-white' : 'bg-gray-100 hover:bg-gray-200'} rounded" data-page="${i}">${i}</button>`;
                }
                container.innerHTML = html;
            }
            const prev = el('PrevPageBtn');
            const next = el('NextPageBtn');
            if (prev) prev.disabled = state.page <= 1;
            if (next) next.disabled = state.page >= state.totalPages;
        }

        // 一次性事件绑定
        const pager = el('TablePaginationContainer');
        if (pager && !pager.dataset.listenerAttached) {
            pager.addEventListener('click', (e) => {
                const pageBtn = e.target.closest(`.${prefix}-page-btn`);
                if (pageBtn) {
                    state.page = parseInt(pageBtn.dataset.page, 10) || 1;
                    load();
                    return;
                }
                if (e.target.closest(`#${prefix}PrevPageBtn`) && state.page > 1) {
                    state.page--;
                    load();
                }
                if (e.target.closest(`#${prefix}NextPageBtn`) && state.page < state.totalPages) {
                    state.page++;
                    load();
                }
            });
            pager.dataset.listenerAttached = 'true';
        }
        const jumpForm = el('PageJumpForm');
        if (jumpForm && !jumpForm.dataset.listenerAttached) {
            jumpForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const input = el('PageJumpInput');
                const target = Math.max(1, Math.min(state.totalPages, parseInt(input.value, 10) || 1));
                state.page = target;
                input.value = '';
                load();
            });
            jumpForm.dataset.listenerAttached = 'true';
        }
        const perPage = el('RecordsPerPageSelect');
        if (perPage && !perPage.dataset.listenerAttached) {
            perPage.addEventListener('change', (e) => {
                state.perPage = parseInt(e.target.value, 10) || 50;
                state.page = 1;
                load();
            });
            perPage.dataset.listenerAttached = 'true';
        }
        const refreshBtn = el('RefreshBtn');
        if (refreshBtn && !refreshBtn.dataset.listenerAttached) {
            refreshBtn.addEventListener('click', () => {
                state.page = 1;
                load();
            });
            refreshBtn.dataset.listenerAttached = 'true';
        }

        // 表格行点击 -> 详情弹窗
        const table = el('InlineList')?.closest('table');
        if (table && !table.dataset.listenerAttached) {
            table.addEventListener('click', (e) => {
                const row = e.target.closest('tr[data-log-id]');
                if (!row) return;
                const log = state.logs.find((l) => String(l.id) === row.dataset.logId);
                if (log) openAuditDetail(log, state);
            });
            table.dataset.listenerAttached = 'true';
        }

        return { state, load, updatePagination };
    }

    // ------------------------------------------------------------------
    // 控制台审计日志面板
    // ------------------------------------------------------------------
    const consolePane = createAuditLogPane({
        prefix: 'au',
        fetchLogs: async (params) => {
            const res = await adminFetch(`/api/audit-logs?${params.toString()}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            return { list: data.data || [], total: data.total ?? data.totalCount };
        },
    });

    // ------------------------------------------------------------------
    // 学校审计日志面板
    // ------------------------------------------------------------------
    let schoolCode = '';
    async function loadSchoolsForAudit() {
        const sel = document.getElementById('saSchoolSelect');
        if (!sel || sel.options.length > 1) return;
        try {
            const res = await adminFetch('/api/admin/schools?limit=200');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const list = data.data?.schools || data.schools || data.data || data || [];
            if (Array.isArray(list)) {
                list.forEach((s) => {
                    const opt = document.createElement('option');
                    opt.value = s.code || s.schoolCode || s.id;
                    opt.textContent = `${s.code || ''} - ${s.fullName || s.full_name || s.shortName || s.short_name || s.name || ''}`;
                    sel.appendChild(opt);
                });
            }
        } catch (e) {
            // 静默失败，用户可点刷新重试
        }
    }
    const schoolPane = createAuditLogPane({
        prefix: 'sa',
        fetchLogs: async (params) => {
            if (!schoolCode) return { list: [], total: 0 };
            const res = await adminFetch(`/api/audit-logs/school/${encodeURIComponent(schoolCode)}?${params.toString()}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            return { list: data.data || [], total: data.total ?? data.totalCount };
        },
    });

    document.getElementById('saSchoolSelect')?.addEventListener('change', (e) => {
        schoolCode = e.target.value;
        const tbody = document.getElementById('saInlineList');
        if (!schoolCode) {
            if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">请先选择学校</td></tr>';
            schoolPane.state.total = 0;
            schoolPane.state.totalPages = 1;
            schoolPane.updatePagination();
            return;
        }
        schoolPane.state.page = 1;
        schoolPane.load();
    });

    // ------------------------------------------------------------------
    // 详情弹窗（全局共用）
    // ------------------------------------------------------------------
    let currentDetailState = null;

    document.getElementById('auditLogDetailClose')?.addEventListener('click', closeAuditDetail);
    document.getElementById('auditLogDetailCloseBtn')?.addEventListener('click', closeAuditDetail);
    document.getElementById('auditLogDetailModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'auditLogDetailModal') closeAuditDetail();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAuditDetail();
    });
    document.getElementById('auditLogDetailCopy')?.addEventListener('click', async () => {
        const log = currentDetailState?.log;
        if (!log) return;
        const payload = {
            id: log.id,
            created_at: log.created_at,
            user_id: log.user_id,
            user: log.user ? { id: log.user.id, username: log.user.username, full_name: log.user.full_name } : null,
            action: log.action,
            resource_type: log.resource_type,
            resource_id: log.resource_id,
            ip_address: log.ip_address,
            details: normalizeAuditDetails(log.details),
        };
        const json = JSON.stringify(payload, null, 2);
        try {
            await navigator.clipboard.writeText(json);
            const btn = document.getElementById('auditLogDetailCopy');
            const original = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-check mr-1"></i>已复制';
            setTimeout(() => { btn.innerHTML = original; }, 1500);
        } catch (_) {
            window.prompt('复制失败，请手动复制：', json);
        }
    });

    function openAuditDetail(log, stateRef) {
        const modal = document.getElementById('auditLogDetailModal');
        const body = document.getElementById('auditLogDetailBody');
        if (!modal || !body) return;

        const details = normalizeAuditDetails(log.details);
        const detailJson = details == null ? '（无）' : JSON.stringify(details, null, 2);
        const description = describeAuditLog(log);

        body.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div><span class="text-gray-500">时间：</span>${escapeHtml(formatAuditTime(log.created_at || log.createdAt))}</div>
                <div><span class="text-gray-500">操作者：</span>${escapeHtml(log.user?.username || log.user?.full_name || log.user_id || '-')}</div>
                <div><span class="text-gray-500">动作：</span><span class="inline-flex px-2 py-0.5 ${getActionColor(log.action)} rounded-full text-xs">${escapeHtml(getActionLabel(log.action))}</span></div>
                <div><span class="text-gray-500">目标：</span>${escapeHtml(log.resource_type || '-')}${log.resource_id ? ' <span class="font-mono text-gray-600">#' + escapeHtml(String(log.resource_id)) + '</span>' : ''}</div>
                <div><span class="text-gray-500">IP 地址：</span>${escapeHtml(log.ip_address || '-')}</div>
                <div><span class="text-gray-500">日志 ID：</span><span class="font-mono text-xs text-gray-600">${escapeHtml(String(log.id || '-'))}</span></div>
            </div>
            <div>
                <div class="text-gray-500 mb-1">文字描述：</div>
                <div class="bg-blue-50 text-blue-900 px-3 py-2 rounded-lg">${escapeHtml(description.full)}</div>
            </div>
            <div>
                <div class="text-gray-500 mb-1">完整详情（JSON）：</div>
                <pre class="bg-gray-50 text-gray-800 p-3 rounded-lg overflow-auto text-xs font-mono whitespace-pre-wrap break-all">${escapeHtml(detailJson)}</pre>
            </div>
        `;
        currentDetailState = { log, state: stateRef };
        modal.classList.remove('hidden');
    }

    function closeAuditDetail() {
        document.getElementById('auditLogDetailModal')?.classList.add('hidden');
        currentDetailState = null;
    }

    // ------------------------------------------------------------------
    // 可读性工具函数
    // ------------------------------------------------------------------
    function formatAuditTime(ts) {
        if (!ts || ts === '-') return '-';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return String(ts);
        return d.toLocaleString('zh-CN', { hour12: false });
    }

    function getActionLabel(action) {
        const labels = {
            login: '登录', logout: '登出', create: '创建', update: '更新', delete: '删除',
            backup: '备份', restore: '恢复', export: '导出', import: '导入', print: '打印',
            login_failed: '登录失败', role_change: '角色变更', password_reset: '密码重置',
            must_change_password: '强制改密', user_disable: '禁用用户', user_enable: '启用用户',
        };
        return labels[action] || action;
    }

    function getActionColor(action) {
        const colors = {
            login: 'bg-blue-100 text-blue-700', logout: 'bg-gray-100 text-gray-700',
            create: 'bg-green-100 text-green-700', update: 'bg-yellow-100 text-yellow-700',
            delete: 'bg-red-100 text-red-700', backup: 'bg-purple-100 text-purple-700',
            restore: 'bg-orange-100 text-orange-700', export: 'bg-indigo-100 text-indigo-700',
            import: 'bg-teal-100 text-teal-700', login_failed: 'bg-red-100 text-red-700',
            role_change: 'bg-orange-100 text-orange-700', password_reset: 'bg-orange-100 text-orange-700',
        };
        return colors[action] || 'bg-indigo-100 text-indigo-700';
    }

    function normalizeAuditDetails(d) {
        if (d == null) return null;
        if (typeof d === 'object') return d;
        if (typeof d === 'string') {
            try { return JSON.parse(d); } catch { return d; }
        }
        return d;
    }

    function describeAuditLog(log) {
        const action = log.action || '';
        const actor = log.user?.username || log.user?.full_name || log.user_id || '系统';
        const resourceType = log.resource_type || '';
        const resourceId = log.resource_id || '';
        const details = normalizeAuditDetails(log.details);

        let sentence = '';
        switch (action) {
            case 'login': sentence = `${actor} 登录系统`; break;
            case 'logout': sentence = `${actor} 登出系统`; break;
            case 'create': sentence = `${actor} 创建${resourceType ? ' ' + resourceType : ''}${resourceId ? '（' + resourceId + '）' : ''}`; break;
            case 'update': sentence = `${actor} 更新${resourceType ? ' ' + resourceType : ''}${resourceId ? '（' + resourceId + '）' : ''}`; break;
            case 'delete': sentence = `${actor} 删除${resourceType ? ' ' + resourceType : ''}${resourceId ? '（' + resourceId + '）' : ''}`; break;
            case 'backup': sentence = `${actor} 执行备份${resourceId ? '：' + resourceId : ''}`; break;
            case 'restore': sentence = `${actor} 执行恢复${resourceId ? '：' + resourceId : ''}`; break;
            case 'export': sentence = `${actor} 导出${resourceType ? ' ' + resourceType : '数据'}`; break;
            case 'import': sentence = `${actor} 导入${resourceType ? ' ' + resourceType : '数据'}`; break;
            case 'role_change': sentence = `${actor} 变更角色${resourceId ? '（' + resourceId + '）' : ''}`; break;
            case 'password_reset': sentence = `${actor} 重置密码${resourceId ? '（' + resourceId + '）' : ''}`; break;
            default: sentence = `${actor} 执行操作「${action}」`;
        }

        const extra = [];
        if (details && typeof details === 'object') {
            if (details.username && details.username !== actor) extra.push(`目标用户：${details.username}`);
            if (details.role) extra.push(`角色：${details.role}`);
            if (details.school_code || details.schoolCode) extra.push(`学校：${details.school_code || details.schoolCode}`);
            if (details.ip && !log.ip_address) extra.push(`IP：${details.ip}`);
        }
        const full = extra.length ? `${sentence}；${extra.join('，')}` : sentence;
        const preview = full.length > 55 ? full.slice(0, 55) + '…' : full;
        return { preview, full };
    }

    // 延迟加载学校列表：只有切到学校审计日志子视图时才填充一次
    function ensureSchoolOptions() {
        const sel = document.getElementById('saSchoolSelect');
        if (sel && sel.options.length <= 1) loadSchoolsForAudit();
    }

    // 重写 switchAuditSubview：切到学校审计日志时先初始化学校下拉；
    // 若尚未选择学校，保留占位提示，不发起查询。
    const originalSwitch = switchAuditSubview;
    function switchAuditSubviewWithInit(subName) {
        originalSwitch(subName);
        if (subName === 'school') {
            ensureSchoolOptions();
            if (!schoolCode) {
                const tbody = document.getElementById('saInlineList');
                if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">请先选择学校</td></tr>';
                schoolPane.state.total = 0;
                schoolPane.state.totalPages = 1;
                schoolPane.updatePagination();
            }
        }
    }

    return { switchAuditSubview: switchAuditSubviewWithInit };
}
