/**
 * 「账号与权限」视图（P-Refactor：从 adminSidebar.js 机械迁移）。
 *
 * 两个子视图：
 *   1. 平台超管内嵌列表（接口契约与 SuperAdminAccount.js 一致）
 *   2. 学校用户管理（选学校 → 加载该校用户）
 *
 * 审计日志已独立为「审计日志」一级菜单，不再由本视图承载。
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
    // 「账号与权限」子视图处理（super-admins / school-users）
    // ============================================================
    function switchAccountsSubview(subName) {
        const subs = document.querySelectorAll('#adminViewAccounts .admin-subview');
        subs.forEach((s) => s.classList.toggle('hidden', s.getAttribute('data-subview') !== subName));
        document.querySelectorAll('[data-subnav="accounts"] .admin-sidebar__subitem[data-subview]').forEach((s) => {
            s.classList.toggle('active', s.getAttribute('data-subview') === subName);
        });
        if (subName === 'super-admins') loadSuperAdminsInline();
        if (subName === 'school-users') loadSchoolsForUserMgr();
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

    // 注意（既有问题，非本次重构引入）：列表行按钮 onclick 调用的
    // window.superAdminAction / window.schoolUserAction 在整个项目中均无定义
    // （onclick 里的 `window.xxx &&` 守卫使其安全地静默无操作）。
    // 待后续迭代在 SuperAdminAccount.js 或本模块补齐实现。

    return { switchAccountsSubview };
}
