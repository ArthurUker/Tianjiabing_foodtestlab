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

// 与 getActionLabel 一致的完整动作清单（用于筛选下拉与文案渲染同步）
const ALL_ACTIONS = [
    { value: 'login', label: '登录' },
    { value: 'logout', label: '登出' },
    { value: 'login_failed', label: '登录失败' },
    { value: 'create', label: '创建' },
    { value: 'update', label: '更新' },
    { value: 'delete', label: '删除' },
    { value: 'backup', label: '备份' },
    { value: 'restore', label: '恢复' },
    { value: 'export', label: '导出' },
    { value: 'import', label: '导入' },
    { value: 'print', label: '打印' },
    { value: 'role_change', label: '角色变更' },
    { value: 'password_reset', label: '密码重置' },
    { value: 'must_change_password', label: '强制改密' },
    { value: 'user_disable', label: '禁用用户' },
    { value: 'user_enable', label: '启用用户' },
];

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
    // 渲染动作下拉（统一使用 ALL_ACTIONS，确保前端筛选项与后端白名单同步）
    // ------------------------------------------------------------------
    function renderActionOptions(prefix) {
        const sel = document.getElementById(prefix + 'Action');
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">全部动作</option>' + ALL_ACTIONS
            .map((a) => `<option value="${escapeHtml(a.value)}">${escapeHtml(a.label)}</option>`)
            .join('');
        // 保留之前的 value（如果还在动作清单中）
        if (current && ALL_ACTIONS.some((a) => a.value === current)) sel.value = current;
    }

    // ------------------------------------------------------------------
    // 日期快捷选项（用户需求：不预填日期，默认为「全部时间」；
    // 同时提供「最近 7 / 30 天」快捷按钮，用户可一键缩小查询范围）
    // ------------------------------------------------------------------
    function applyDefaultDateRange(prefix, days) {
        const startEl = document.getElementById(prefix + 'StartDate');
        const endEl = document.getElementById(prefix + 'EndDate');
        if (!startEl || !endEl || !days) return;
        if (startEl.dataset.userSet === 'true' || endEl.dataset.userSet === 'true') return;
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - (days - 1));
        const fmt = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${dd}`;
        };
        startEl.value = fmt(start);
        endEl.value = fmt(end);
    }

    /**
     * 「最近 N 天」快捷按钮：清空 user-set 标记后写入开始/截止。
     * 与「全部时间」按钮互斥，最后一次点击生效。
     */
    function bindDateShortcuts(prefix) {
        const clearBtn = document.getElementById(prefix + 'DateAllBtn');
        const sevenBtn = document.getElementById(prefix + 'Date7Btn');
        const thirtyBtn = document.getElementById(prefix + 'Date30Btn');
        const startEl = document.getElementById(prefix + 'StartDate');
        const endEl = document.getElementById(prefix + 'EndDate');

        function applyAndReload(days) {
            // 先清掉 user-set（让 applyDefaultDateRange 重新写入）
            if (startEl) startEl.dataset.userSet = '';
            if (endEl) endEl.dataset.userSet = '';
            if (days == null) {
                // 全部时间：查询该学校审计日志的最早时间，截止为当前时间
                const code = document.getElementById('saAuditSchoolSelect')?.value || '';

                if (code) {
                    adminFetch(`/api/audit-logs/school/${encodeURIComponent(code)}/date-range`)
                        .then(r => r.json())
                        .then(res => {
                            if (res.success && res.data.earliest) {
                                const d = new Date(res.data.earliest);
                                const y = d.getFullYear();
                                const m = String(d.getMonth() + 1).padStart(2, '0');
                                const day = String(d.getDate()).padStart(2, '0');
                                if (startEl) startEl.value = `${y}-${m}-${day}`;
                            } else {
                                if (startEl) startEl.value = '';
                            }
                            // 截止日期始终为当前时间
                            const now = new Date();
                            const ny = now.getFullYear();
                            const nm = String(now.getMonth() + 1).padStart(2, '0');
                            const nd = String(now.getDate()).padStart(2, '0');
                            if (endEl) endEl.value = `${ny}-${nm}-${nd}`;
                            if (startEl) startEl.dataset.userSet = 'true';
                            if (endEl) endEl.dataset.userSet = 'true';
                            // 高亮按钮
                            [clearBtn, sevenBtn, thirtyBtn].forEach((btn) => {
                                if (btn) btn.classList.remove('bg-indigo-100', 'text-indigo-700');
                            });
                            if (clearBtn) clearBtn.classList.add('bg-indigo-100', 'text-indigo-700');
                            // 触发加载
                            const pane = prefix === 'au' ? consolePane : schoolPane;
                            if (pane) { pane.state.page = 1; pane.load(); }
                        })
                        .catch(() => {
                            // 失败时回退到留空
                            if (startEl) { startEl.value = ''; startEl.dataset.userSet = 'true'; }
                            if (endEl) { endEl.value = ''; endEl.dataset.userSet = 'true'; }
                            [clearBtn, sevenBtn, thirtyBtn].forEach((btn) => {
                                if (btn) btn.classList.remove('bg-indigo-100', 'text-indigo-700');
                            });
                            if (clearBtn) clearBtn.classList.add('bg-indigo-100', 'text-indigo-700');
                            const pane = prefix === 'au' ? consolePane : schoolPane;
                            if (pane) { pane.state.page = 1; pane.load(); }
                        });
                } else {
                    if (startEl) { startEl.value = ''; startEl.dataset.userSet = 'true'; }
                    if (endEl) { endEl.value = ''; endEl.dataset.userSet = 'true'; }
                    [clearBtn, sevenBtn, thirtyBtn].forEach((btn) => {
                        if (btn) btn.classList.remove('bg-indigo-100', 'text-indigo-700');
                    });
                    if (clearBtn) clearBtn.classList.add('bg-indigo-100', 'text-indigo-700');
                    const pane = prefix === 'au' ? consolePane : schoolPane;
                    if (pane) { pane.state.page = 1; pane.load(); }
                }
                return; // 异步加载，提前返回避免重复 load
            } else {
                applyDefaultDateRange(prefix, days);
                // applyDefaultDateRange 不会写 userSet，标记为已设置避免被覆盖
                if (startEl) startEl.dataset.userSet = 'true';
                if (endEl) endEl.dataset.userSet = 'true';
            }
            // 高亮当前激活的快捷按钮
            [clearBtn, sevenBtn, thirtyBtn].forEach((btn) => {
                if (btn) btn.classList.remove('bg-indigo-100', 'text-indigo-700');
            });
            const active = days == null ? clearBtn : (days === 7 ? sevenBtn : thirtyBtn);
            if (active) active.classList.add('bg-indigo-100', 'text-indigo-700');

            const pane = prefix === 'au' ? consolePane : schoolPane;
            if (pane) {
                pane.state.page = 1;
                pane.load();
            }
        }

        if (clearBtn && !clearBtn.dataset.bound) {
            clearBtn.dataset.bound = 'true';
            clearBtn.addEventListener('click', () => applyAndReload(null));
        }
        if (sevenBtn && !sevenBtn.dataset.bound) {
            sevenBtn.dataset.bound = 'true';
            sevenBtn.addEventListener('click', () => applyAndReload(7));
        }
        if (thirtyBtn && !thirtyBtn.dataset.bound) {
            thirtyBtn.dataset.bound = 'true';
            thirtyBtn.addEventListener('click', () => applyAndReload(30));
        }
        // 初始激活态：默认 = 全部时间
        if (clearBtn) clearBtn.classList.add('bg-indigo-100', 'text-indigo-700');
    }

    /**
     * 标记当前查询模式为「全部时间」，避免下次 panel 切换时被旧值回填。
     */
    function setDateManualCleared(prefix) {
        const startEl = document.getElementById(prefix + 'StartDate');
        const endEl = document.getElementById(prefix + 'EndDate');
        if (startEl) { startEl.value = ''; startEl.dataset.userSet = 'true'; }
        if (endEl) { endEl.value = ''; endEl.dataset.userSet = 'true'; }
    }

    // ------------------------------------------------------------------
    // 操作人下拉填充（学校子视图专用 —— 平台超管跨租户时按学校 code 拉取用户）
    // ------------------------------------------------------------------
    async function loadSchoolUsers(schoolCode) {
        const sel = document.getElementById('saAuditActor');
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">全部用户（加载中…）</option>';
        sel.disabled = true;
        try {
            const res = await adminFetch(`/api/admin/schools/${encodeURIComponent(schoolCode)}/users`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
            renderUserSelect(sel, rows, current);
            sel.disabled = false;
        } catch (e) {
            sel.innerHTML = '<option value="">全部用户（加载失败）</option>';
            sel.disabled = false;
        }
    }

    // ------------------------------------------------------------------
    // 操作人下拉填充（控制台子视图专用 —— 调用 /api/audit-logs/users 从 req.db 查 user）
    // ------------------------------------------------------------------
    async function loadConsoleUsers() {
        const sel = document.getElementById('auActor');
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">全部用户（加载中…）</option>';
        sel.disabled = true;
        try {
            const res = await adminFetch('/api/audit-logs/users');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const rows = Array.isArray(data?.data?.users) ? data.data.users : [];
            renderUserSelect(sel, rows, current);
            sel.disabled = false;
        } catch (e) {
            sel.innerHTML = '<option value="">全部用户（加载失败）</option>';
            sel.disabled = false;
        }
    }

    // 共用：根据用户行渲染下拉选项。row 形如 { id, username, full_name, role, status }
    // 显示策略：以「真名（full_name）」为主、用户名为辅助 —— 用户体验上更符合
    // "从系统选择某个用户（显示真名）"的诉求；如果只有 username 没有 full_name，
    // 则回退显示 username。
    function renderUserSelect(sel, rows, keepValue) {
        const opts = ['<option value="">全部用户</option>'];
        const validValues = new Set(['']);
        rows.forEach((u) => {
            if (!u || !u.id) return;
            const realName = String(u.full_name || '').trim();
            const userName = String(u.username || '').trim();
            const roleLabel = u.role === 'admin' ? '管理员' : (u.role === 'manager' ? '主管' : (u.role || ''));
            // 渲染文本：真名在前，没有真名就回退到用户名
            const main = realName || userName || u.id;
            const sub = realName && userName ? ` (${userName})` : '';
            const text = `${main}${sub}${roleLabel ? ` · ${roleLabel}` : ''}${u.status === 'disabled' ? ' [已禁用]' : ''}`;
            opts.push(`<option value="${escapeHtml(String(u.id))}">${escapeHtml(text)}</option>`);
            validValues.add(String(u.id));
        });
        sel.innerHTML = opts.join('');
        // 仅当先前选中的 user_id 仍在结果集中时保留（兼容：用户已被删除时清空筛选）
        if (keepValue && validValues.has(String(keepValue))) sel.value = keepValue;
    }

    // ------------------------------------------------------------------
    // 重置筛选（用户需求：默认查询「全部时间」；重置也回到全部时间，仅清动作/操作人）
    // ------------------------------------------------------------------
    function bindResetFilters(prefix) {
        const btn = document.getElementById(prefix + 'ResetFiltersBtn');
        if (!btn || btn.dataset.bound) return;
        btn.dataset.bound = 'true';
        btn.addEventListener('click', () => {
            // 日期清空（全部时间）
            setDateManualCleared(prefix);
            // 重新激活「全部时间」按钮（高亮状态）
            const clearBtn = document.getElementById(prefix + 'DateAllBtn');
            const sevenBtn = document.getElementById(prefix + 'Date7Btn');
            const thirtyBtn = document.getElementById(prefix + 'Date30Btn');
            [clearBtn, sevenBtn, thirtyBtn].forEach((b) => b && b.classList.remove('bg-indigo-100', 'text-indigo-700'));
            if (clearBtn) clearBtn.classList.add('bg-indigo-100', 'text-indigo-700');

            const actorEl = document.getElementById(prefix + 'Actor');
            if (actorEl) actorEl.value = '';
            const actionEl = document.getElementById(prefix + 'Action');
            if (actionEl) actionEl.value = '';

            // 触发对应 pane 重新加载（page=1）
            const pane = prefix === 'au' ? consolePane : schoolPane;
            if (pane) {
                pane.state.page = 1;
                pane.load();
            }
        });
    }

    // ------------------------------------------------------------------
    // 审计日志面板工厂（复用给 console / school 两套 DOM）
    // ------------------------------------------------------------------
    function createAuditLogPane({ prefix, fetchLogs }) {
        const state = {
            page: 1, perPage: 50, total: 0, totalPages: 1, logs: [],
            currentDetailLog: null,
            // 加载版本号：每次 load 自增；await 之后只接受当前最新版本的结果，
            // 避免快速切换筛选时旧请求的「暂无日志记录」覆盖新请求的真实数据。
            loadVersion: 0,
            placeholderMode: 'loading', // loading / need-school / empty / error
            placeholderMsg: '',
        };
        const el = (id) => document.getElementById(prefix + id);

        function setPlaceholder(tbody, mode, msg) {
            state.placeholderMode = mode;
            state.placeholderMsg = msg || '';
            const text = {
                loading: '加载中…',
                'need-school': '请先选择学校',
                empty: '暂无日志记录',
                error: msg ? `查询失败：${escapeHtml(msg)}` : '查询失败',
            }[mode];
            const cls = mode === 'error' ? 'text-center text-red-500 py-6' : 'text-center text-gray-400 py-6';
            tbody.innerHTML = `<tr><td colspan="5" class="${cls}">${escapeHtml(text || '')}</td></tr>`;
        }

        function getParams() {
            const start = el('StartDate')?.value;
            const end = el('EndDate')?.value;
            const actor = el('Actor')?.value;
            const action = el('Action')?.value;
            const params = new URLSearchParams();
            if (start) params.set('startDate', new Date(start + 'T00:00:00+08:00').toISOString());
            if (end) {
                // 含当日：end 取 23:59:59.999 +08:00
                params.set('endDate', new Date(end + 'T23:59:59.999+08:00').toISOString());
            }
            if (actor) params.set('userId', actor);
            if (action) params.set('action', action);
            params.set('offset', String((state.page - 1) * state.perPage));
            params.set('limit', String(state.perPage));
            return params;
        }

        async function load() {
            const tbody = el('InlineList');
            if (!tbody) return;
            const myVersion = ++state.loadVersion;
            // 学校子视图在未选学校时显示明确占位，不发请求
            if (prefix === 'saAudit' && !getSchoolCode()) {
                state.total = 0;
                state.totalPages = 1;
                state.logs = [];
                setPlaceholder(tbody, 'need-school');
                updatePagination();
                return;
            }
            setPlaceholder(tbody, 'loading');
            try {
                const params = getParams();
                const { list, total } = await fetchLogs(params);
                // 期间用户可能又触发了新的 load()：丢弃过时结果
                if (myVersion !== state.loadVersion) return;
                state.total = Number(total ?? (Array.isArray(list) ? list.length : 0));
                state.totalPages = Math.max(1, Math.ceil(state.total / state.perPage));
                if (state.page > state.totalPages) {
                    state.page = state.totalPages;
                    // 用最新版本号再发一次
                    if (myVersion !== state.loadVersion) return;
                    return load();
                }
                state.logs = Array.isArray(list) ? list : [];
                if (state.logs.length === 0) {
                    setPlaceholder(tbody, 'empty');
                    updatePagination();
                    return;
                }
                tbody.innerHTML = state.logs.map((l) => {
                    const ts = l.created_at || l.createdAt || l.timestamp || '-';
                    const actor = l.user?.username || l.user?.full_name || l.user_id || '-';
                    const action = l.action || '-';
                    const target = l.resource_type ? `${l.resource_type}#${l.resource_id || ''}` : '-';
                    const description = describeAuditLog(l);
                    return `
                        <tr class="hover:bg-gray-50" data-log-id="${escapeHtml(String(l.id || ''))}">
                            <td class="px-3 py-2 text-gray-700 whitespace-nowrap">${escapeHtml(formatAuditTime(ts))}</td>
                            <td class="px-3 py-2 text-gray-800">${escapeHtml(String(actor))}</td>
                            <td class="px-3 py-2"><span class="inline-flex px-2 py-0.5 ${getActionColor(action)} rounded-full text-xs">${escapeHtml(getActionLabel(action))}</span></td>
                            <td class="px-3 py-2 text-gray-600 font-mono">${escapeHtml(String(target))}</td>
                            <td class="px-3 py-2">
                                <span class="text-blue-600 hover:text-blue-800 hover:underline cursor-pointer" title="${escapeHtml(description.full)}${description.full ? '\n点击查看完整详情' : ''}" data-log-id="${escapeHtml(String(l.id || ''))}">
                                    ${escapeHtml(description.preview) || '-'}
                                </span>
                            </td>
                        </tr>`;
                }).join('');
                state.placeholderMode = 'data';
                updatePagination();
            } catch (e) {
                if (myVersion !== state.loadVersion) return;
                setPlaceholder(tbody, 'error', String(e?.message || e));
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

        // 自动查询：日期/动作/操作人 变化即触发 load（不依赖「查询」按钮）
        ['StartDate', 'EndDate', 'Action'].forEach((id) => {
            const node = el(id);
            if (node && !node.dataset.autoQueryBound) {
                node.addEventListener('change', () => {
                    node.dataset.userSet = 'true';
                    state.page = 1;
                    load();
                });
                node.dataset.autoQueryBound = 'true';
            }
        });
        const actorEl = el('Actor');
        if (actorEl && !actorEl.dataset.autoQueryBound) {
            actorEl.addEventListener('change', () => {
                state.page = 1;
                load();
            });
            actorEl.dataset.autoQueryBound = 'true';
        }

        // 详情列文字点击 -> 详情弹窗（仅详情 span 可触发，非整行）
        const table = el('InlineList')?.closest('table');
        if (table && !table.dataset.listenerAttached) {
            table.addEventListener('click', (e) => {
                // 只响应详情列上带 data-log-id 的 span 点击
                const target = e.target.closest('span[data-log-id]');
                if (!target) return;
                const logId = target.dataset.logId;
                const log = state.logs.find((l) => String(l.id) === logId);
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
    // 当前所选学校代码用闭包变量维护（避免 window 全局污染，便于模块化和单测）
    // ------------------------------------------------------------------
    let schoolCode = '';
    const getSchoolCode = () => schoolCode;
    const schoolPane = createAuditLogPane({
        prefix: 'saAudit',
        fetchLogs: async (params) => {
            const code = schoolCode;
            if (!code) return { list: [], total: 0 };
            const res = await adminFetch(`/api/audit-logs/school/${encodeURIComponent(code)}?${params.toString()}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            return { list: data.data || [], total: data.total ?? data.totalCount };
        },
    });

    async function loadSchoolsForAudit() {
        const sel = document.getElementById('saAuditSchoolSelect');
        if (!sel || sel.options.length > 1) return;
        try {
            const res = await adminFetch('/api/admin/schools?limit=500');
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

    const schoolSelect = document.getElementById('saAuditSchoolSelect');
    if (schoolSelect && !schoolSelect.dataset.listenerAttached) {
        schoolSelect.addEventListener('change', (e) => {
            schoolCode = e.target.value;
            const tbody = document.getElementById('saAuditInlineList');
            if (!schoolCode) {
                if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">请先选择学校</td></tr>';
                schoolPane.state.total = 0;
                schoolPane.state.totalPages = 1;
                schoolPane.state.logs = [];
                schoolPane.state.loadVersion++; // 取消任何在飞的旧 load
                schoolPane.updatePagination();
                // 清空操作人下拉
                const actorSel = document.getElementById('saAuditActor');
                if (actorSel) {
                    actorSel.innerHTML = '<option value="">全部用户</option>';
                }
                return;
            }
            // 联动：异步加载该校用户列表到「操作人」下拉
            loadSchoolUsers(schoolCode);
            // 切换学校时清空操作人筛选、重置到第 1 页，避免跨学校筛选残留
            const actorSel = document.getElementById('saAuditActor');
            if (actorSel) actorSel.value = '';
            schoolPane.state.page = 1;
            schoolPane.load();
        });
        schoolSelect.dataset.listenerAttached = 'true';
    }

    // 学校下拉搜索：输入时过滤 option（不破坏 value 选择）
    const schoolSearch = document.getElementById('saAuditSchoolSearch');
    if (schoolSearch && !schoolSearch.dataset.listenerAttached) {
        schoolSearch.addEventListener('input', (e) => {
            const q = String(e.target.value || '').trim().toLowerCase();
            const sel = document.getElementById('saAuditSchoolSelect');
            if (!sel) return;
            Array.from(sel.options).forEach((opt) => {
                if (!opt.value) {
                            opt.hidden = false;
                            return;
                        }
                const txt = String(opt.textContent || '').toLowerCase();
                opt.hidden = q && !txt.includes(q);
            });
        });
        schoolSearch.dataset.listenerAttached = 'true';
    }

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
        const item = ALL_ACTIONS.find((a) => a.value === action);
        return item ? item.label : (action || '-');
    }

    function getActionColor(action) {
        const colors = {
            login: 'bg-blue-100 text-blue-700', logout: 'bg-gray-100 text-gray-700',
            create: 'bg-green-100 text-green-700', update: 'bg-yellow-100 text-yellow-700',
            delete: 'bg-red-100 text-red-700', backup: 'bg-purple-100 text-purple-700',
            restore: 'bg-orange-100 text-orange-700', export: 'bg-indigo-100 text-indigo-700',
            import: 'bg-teal-100 text-teal-700', print: 'bg-cyan-100 text-cyan-700',
            login_failed: 'bg-red-100 text-red-700',
            role_change: 'bg-orange-100 text-orange-700', password_reset: 'bg-orange-100 text-orange-700',
            must_change_password: 'bg-amber-100 text-amber-700',
            user_disable: 'bg-red-100 text-red-700', user_enable: 'bg-green-100 text-green-700',
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
            case 'user_disable': sentence = `${actor} 禁用用户${resourceId ? '（' + resourceId + '）' : ''}`; break;
            case 'user_enable': sentence = `${actor} 启用用户${resourceId ? '（' + resourceId + '）' : ''}`; break;
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

    // 一次性渲染两个子视图的动作下拉，确保动作清单完整
    renderActionOptions('au');
    renderActionOptions('saAudit');
    // 用户需求：「按时间筛选默认是所有时间的审计日志」→ 进入时不预填日期，
    // 通过快捷按钮（全部时间 / 最近 7 天 / 最近 30 天）调整。
    setDateManualCleared('au');
    setDateManualCleared('saAudit');
    // 把"全部时间"按钮初始高亮（setDateManualCleared 不会触发 bindDateShortcuts.applyAndReload）
    ['au', 'saAudit'].forEach((p) => {
        const btn = document.getElementById(p + 'DateAllBtn');
        if (btn) {
            btn.classList.add('bg-indigo-100', 'text-indigo-700');
            const s7 = document.getElementById(p + 'Date7Btn');
            const s30 = document.getElementById(p + 'Date30Btn');
            if (s7) s7.classList.remove('bg-indigo-100', 'text-indigo-700');
            if (s30) s30.classList.remove('bg-indigo-100', 'text-indigo-700');
        }
    });

    // 控制台子视图：异步加载操作人下拉（平台超管可访问 /api/audit-logs/users）
    // 学校子视图的操作人下拉在用户选择学校时按需加载（见 schoolSelect.change）
    loadConsoleUsers();
    bindResetFilters('au');
    bindResetFilters('saAudit');
    bindDateShortcuts('au');
    bindDateShortcuts('saAudit');

    // 延迟加载学校列表：只有切到学校审计日志子视图时才填充一次
    function ensureSchoolOptions() {
        const sel = document.getElementById('saAuditSchoolSelect');
        if (sel && sel.options.length <= 1) loadSchoolsForAudit();
    }

    // 重写 switchAuditSubview：切到学校审计日志时先初始化学校下拉；
    // 若尚未选择学校，保留占位提示，不发起查询；
    // 若已选择学校则重新查询（保持数据新鲜）。
    const originalSwitch = switchAuditSubview;
    function switchAuditSubviewWithInit(subName) {
        originalSwitch(subName);
        if (subName === 'school') {
            ensureSchoolOptions();
            if (!schoolCode) {
                const tbody = document.getElementById('saAuditInlineList');
                if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">请先选择学校</td></tr>';
                schoolPane.state.total = 0;
                schoolPane.state.totalPages = 1;
                schoolPane.state.logs = [];
                schoolPane.updatePagination();
            }
        }
    }

    return { switchAuditSubview: switchAuditSubviewWithInit };
}
