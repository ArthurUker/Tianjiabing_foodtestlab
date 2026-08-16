/**
 * 「账号与权限」视图（P-Refactor：从 adminSidebar.js 机械迁移）。
 *
 * 三个子视图：
 *   1. 平台超管内嵌列表（接口契约与 SuperAdminAccount.js 一致）
 *   2. 学校用户管理（选学校 → 加载该校用户）
 *   3. 审计日志（offset+limit 分页 + 页码滑动窗口，参考 Tableware.js 设计）
 *
 * 迁移改动（仅依赖注入，无行为变化）：
 *   - 4 处 window.authService + window.getApiBaseUrl 取 token 样板 → context.js 的 adminFetch
 *   - 内联 escapeHtml → ui.js 共享版
 *   - 删除 window.switchAccountsSubview 暴露（改由 initAccountsView() 返回值注入 sidebar）
 */
import { adminFetch } from '../context.js';
import { escapeHtml } from '../ui.js';

export function initAccountsView() {
    // ============================================================
    // 「账号与权限」子视图处理（super-admins / school-users / audit-logs）
    // ============================================================
    function switchAccountsSubview(subName) {
        const subs = document.querySelectorAll('#adminViewAccounts .admin-subview');
        subs.forEach((s) => s.classList.toggle('hidden', s.getAttribute('data-subview') !== subName));
        document.querySelectorAll('[data-subnav="accounts"] .admin-sidebar__subitem[data-subview]').forEach((s) => {
            s.classList.toggle('active', s.getAttribute('data-subview') === subName);
        });
        if (subName === 'super-admins') loadSuperAdminsInline();
        if (subName === 'school-users') loadSchoolsForUserMgr();
        if (subName === 'audit-logs') loadAuditLogsInline();
    }

    // --- 子视图 1: 平台超管内嵌列表（与 SuperAdminAccount.js 共享接口契约） ---
    async function loadSuperAdminsInline() {
        const tbody = document.getElementById('saInlineList');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">加载中…</td></tr>';
        try {
            const res = await adminFetch('/api/user/super-admin');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const list = data.admins || data.data || data || [];
            if (!Array.isArray(list) || list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">暂无平台超管账号</td></tr>';
                return;
            }
            tbody.innerHTML = list.map((u) => {
                const enabled = (u.enabled ?? u.isActive ?? true);
                const createdAt = u.created_at || u.createdAt || '-';
                return `
                    <tr>
                        <td class="px-3 py-2 font-mono text-gray-800">${escapeHtml(u.username || '-')}</td>
                        <td class="px-3 py-2">${escapeHtml(u.full_name || u.fullName || '-')}</td>
                        <td class="px-3 py-2">
                            ${enabled ? '<span class="inline-flex px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">已启用</span>' : '<span class="inline-flex px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs">已停用</span>'}
                        </td>
                        <td class="px-3 py-2 text-gray-600">${escapeHtml(String(createdAt))}</td>
                        <td class="px-3 py-2 text-right">
                            <button class="text-sm text-blue-600 hover:underline" onclick="window.superAdminAction && window.superAdminAction('edit', '${escapeHtml(String(u.id || u._id || ''))}')">编辑</button>
                            <button class="ml-3 text-sm text-red-600 hover:underline" onclick="window.superAdminAction && window.superAdminAction('delete', '${escapeHtml(String(u.id || u._id || ''))}')">删除</button>
                        </td>
                    </tr>`;
            }).join('');
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-red-500 py-6">加载失败：${escapeHtml(String(e.message || e))}（接口契约参考 SuperAdminAccount.js）</td></tr>`;
        }
    }
    document.getElementById('suRefreshBtn')?.addEventListener('click', () => loadSuperAdminsInline());

    // --- 子视图 2: 学校用户管理：选择学校 + 加载用户 ---
    async function loadSchoolsForUserMgr() {
        const sel = document.getElementById('suSchoolSelect');
        if (!sel) return;
        if (sel.options.length <= 1) {
            try {
                const res = await adminFetch('/api/admin/schools?limit=200');
                if (res.ok) {
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
                }
            } catch (_) { /* 静默；用户可点刷新重试 */ }
        }
    }
    document.getElementById('suSchoolSelect')?.addEventListener('change', () => {
        document.getElementById('suAddBtn').disabled = !document.getElementById('suSchoolSelect').value;
        const code = document.getElementById('suSchoolSelect').value;
        if (code) loadSchoolUsersInline(code);
    });
    document.getElementById('suRefreshBtn')?.addEventListener('click', () => {
        const code = document.getElementById('suSchoolSelect').value;
        if (code) loadSchoolUsersInline(code);
    });
    async function loadSchoolUsersInline(schoolCode) {
        const tbody = document.getElementById('suInlineList');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">加载中…</td></tr>';
        try {
            const res = await adminFetch(`/api/admin/schools/${encodeURIComponent(schoolCode)}/users`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const list = data.data?.users || data.users || data.data || data || [];
            if (!Array.isArray(list) || list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">该学校暂无用户</td></tr>';
                return;
            }
            tbody.innerHTML = list.map((u) => {
                const enabled = (u.enabled ?? u.isActive ?? true);
                return `
                    <tr>
                        <td class="px-3 py-2 font-mono text-gray-800">${escapeHtml(u.username || '-')}</td>
                        <td class="px-3 py-2">${escapeHtml(u.fullName || u.full_name || '-')}</td>
                        <td class="px-3 py-2">
                            <span class="inline-flex px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs">${escapeHtml(u.role || '-')}</span>
                        </td>
                        <td class="px-3 py-2">
                            ${enabled ? '<span class="inline-flex px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">已启用</span>' : '<span class="inline-flex px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs">已停用</span>'}
                        </td>
                        <td class="px-3 py-2 text-right">
                            <button class="text-sm text-blue-600 hover:underline" onclick="window.schoolUserAction && window.schoolUserAction('edit', '${escapeHtml(String(u.id || u._id || ''))}', '${escapeHtml(schoolCode)}')">编辑</button>
                            <button class="ml-3 text-sm text-orange-600 hover:underline" onclick="window.schoolUserAction && window.schoolUserAction('reset', '${escapeHtml(String(u.id || u._id || ''))}', '${escapeHtml(schoolCode)}')">重置密码</button>
                            <button class="ml-3 text-sm text-red-600 hover:underline" onclick="window.schoolUserAction && window.schoolUserAction('delete', '${escapeHtml(String(u.id || u._id || ''))}', '${escapeHtml(schoolCode)}')">删除</button>
                        </td>
                    </tr>`;
            }).join('');
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-red-500 py-6">加载失败：${escapeHtml(String(e.message || e))}</td></tr>`;
        }
    }
    document.getElementById('suAddBtn')?.addEventListener('click', () => {
        const code = document.getElementById('suSchoolSelect').value;
        if (!code) return;
        window.alert(`请在「学校管理」→ 选中学校（${code}）→「用户管理」Tab 内新增用户。\n（内嵌新增表单将在下个迭代补全，避免与现有 detailPanel.users 双绑）`);
    });

    // --- 子视图 3: 审计日志（直接调 /api/audit-logs，参考检测模块分页器设计） ---
    // 分页状态机（与 Tableware.js / GenericTest.js 一致的页码滑动窗口模式）
    const auState = { page: 1, perPage: 50, total: 0, totalPages: 1 };

    function auGetParams() {
        const start = document.getElementById('auStartDate')?.value;
        const end = document.getElementById('auEndDate')?.value;
        const actor = document.getElementById('auActor')?.value.trim();
        const action = document.getElementById('auAction')?.value;
        const params = new URLSearchParams();
        if (start) params.set('startDate', new Date(start).toISOString());
        if (end) params.set('endDate', new Date(end).toISOString());
        if (actor) params.set('userId', actor);
        if (action) params.set('action', action);
        // 后端 auditRoutes 用 offset+limit 而非 page+limit（取 auditRoutes.js:117 契约）
        params.set('offset', String((auState.page - 1) * auState.perPage));
        params.set('limit', String(auState.perPage));
        return params;
    }

    async function loadAuditLogsInline() {
        const tbody = document.getElementById('auInlineList');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">加载中…</td></tr>';
        try {
            const params = auGetParams();
            const res = await adminFetch(`/api/audit-logs?${params.toString()}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            const list = data.data || [];
            auState.total = Number(data.total ?? data.totalCount ?? list.length);
            auState.totalPages = Math.max(1, Math.ceil(auState.total / auState.perPage));
            if (auState.page > auState.totalPages) {
                auState.page = auState.totalPages;
                return loadAuditLogsInline();
            }
            if (!Array.isArray(list) || list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">暂无日志记录</td></tr>';
                auUpdatePagination();
                return;
            }
            tbody.innerHTML = list.map((l) => {
                const ts = l.created_at || l.createdAt || l.timestamp || '-';
                const actor = l.user?.username || l.user?.full_name || l.user_id || '-';
                const action = l.action || '-';
                const target = l.target_type ? `${l.target_type}#${l.target_id || ''}` : '-';
                const detail = l.details ? (typeof l.details === 'object' ? JSON.stringify(l.details) : String(l.details)) : '-';
                return `
                    <tr>
                        <td class="px-3 py-2 text-gray-700 whitespace-nowrap">${escapeHtml(String(ts))}</td>
                        <td class="px-3 py-2 text-gray-800">${escapeHtml(String(actor))}</td>
                        <td class="px-3 py-2"><span class="inline-flex px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs">${escapeHtml(String(action))}</span></td>
                        <td class="px-3 py-2 text-gray-600 font-mono">${escapeHtml(String(target))}</td>
                        <td class="px-3 py-2 text-gray-600 max-w-md truncate" title="${escapeHtml(String(detail))}">${escapeHtml(String(detail))}</td>
                    </tr>`;
            }).join('');
            auUpdatePagination();
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-red-500 py-6">查询失败：${escapeHtml(String(e.message || e))}</td></tr>`;
            auUpdatePagination();
        }
    }

    // 更新分页器：参考 Tableware.js updatePagination 的页码滑动窗口
    function auUpdatePagination() {
        const info = document.getElementById('auPaginationInfo');
        const total = auState.total;
        const start = total === 0 ? 0 : (auState.page - 1) * auState.perPage + 1;
        const end = Math.min(start + auState.perPage - 1, total);
        if (info) info.textContent = total > 0 ? `显示 ${start}-${end} 条，共 ${total} 条（${auState.totalPages} 页）` : '暂无记录';

        const container = document.getElementById('auPageButtonsContainer');
        if (container) {
            const pages = auState.totalPages;
            let startPage = Math.max(1, auState.page - 2);
            let endPage = Math.min(pages, startPage + 4);
            if (endPage - startPage < 4 && pages > 4) startPage = Math.max(1, endPage - 4);
            let html = '';
            for (let i = startPage; i <= endPage; i++) {
                const active = i === auState.page;
                html += `<button type="button" class="au-page-btn px-3 py-1 ${active ? 'bg-blue-500 text-white' : 'bg-gray-100 hover:bg-gray-200'} rounded" data-page="${i}">${i}</button>`;
            }
            container.innerHTML = html;
        }
        const prev = document.getElementById('auPrevPageBtn');
        const next = document.getElementById('auNextPageBtn');
        if (prev) prev.disabled = auState.page <= 1;
        if (next) next.disabled = auState.page >= auState.totalPages;
    }

    // 事件绑定（容器一次性委托，避免重复绑定）
    const auPager = document.getElementById('auTablePaginationContainer');
    if (auPager && !auPager.dataset.listenerAttached) {
        auPager.addEventListener('click', (e) => {
            const pageBtn = e.target.closest('.au-page-btn');
            if (pageBtn) {
                auState.page = parseInt(pageBtn.dataset.page, 10) || 1;
                loadAuditLogsInline();
                return;
            }
            if (e.target.closest('#auPrevPageBtn') && auState.page > 1) {
                auState.page--;
                loadAuditLogsInline();
            }
            if (e.target.closest('#auNextPageBtn') && auState.page < auState.totalPages) {
                auState.page++;
                loadAuditLogsInline();
            }
        });
        auPager.dataset.listenerAttached = 'true';
    }
    const auJumpForm = document.getElementById('auPageJumpForm');
    if (auJumpForm && !auJumpForm.dataset.listenerAttached) {
        auJumpForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('auPageJumpInput');
            const target = Math.max(1, Math.min(auState.totalPages, parseInt(input.value, 10) || 1));
            auState.page = target;
            input.value = '';
            loadAuditLogsInline();
        });
        auJumpForm.dataset.listenerAttached = 'true';
    }
    const auPerPage = document.getElementById('auRecordsPerPageSelect');
    if (auPerPage && !auPerPage.dataset.listenerAttached) {
        auPerPage.addEventListener('change', (e) => {
            auState.perPage = parseInt(e.target.value, 10) || 50;
            auState.page = 1;
            loadAuditLogsInline();
        });
        auPerPage.dataset.listenerAttached = 'true';
    }
    document.getElementById('auRefreshBtn')?.addEventListener('click', () => {
        auState.page = 1;
        loadAuditLogsInline();
    });

    // 注意（既有问题，非本次重构引入）：列表行按钮 onclick 调用的
    // window.superAdminAction / window.schoolUserAction 在整个项目中均无定义
    // （onclick 里的 `window.xxx &&` 守卫使其安全地静默无操作）。
    // 待后续迭代在 SuperAdminAccount.js 或本模块补齐实现。

    return { switchAccountsSubview };
}
