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
 *
 * FIX（行内列表按钮无响应）：
 *   - 列表行「编辑/重置密码/删除」按钮原本通过 `window.schoolUserAction && window.superAdminAction`
 *     转发，但这两个函数从未定义，浏览器对 `undefined()` 调用静默吞掉（无错、无响应）。
 *   - 在此文件中真正实现这两个全局动作，行为统一委托给 schoolUsersView 弹窗 / SuperAdminAccount
 *     的 saAccountModal，避免重复造轮子。
 */
import { adminFetch } from '../context.js';
import { escapeHtml, showNotice } from '../ui.js';
import { openResetPwd, openUserModal, deleteUser } from './schoolUsersView.js';

export function initAccountsView() {
    // ============================================================
    // FIX（行内列表按钮无响应）：
    //   列表行「编辑/重置密码/删除」按钮原本通过 `window.schoolUserAction && window.superAdminAction`
    //   转发，但这两个函数从未定义，浏览器对 `undefined()` 调用静默吞掉（无错、无响应）。
    //   在 initAccountsView() 内部真正实现这两个全局动作，行为统一委托给 schoolUsersView
    //   弹窗 / SuperAdminAccount 的 saAccountModal，避免重复造轮子。
    //   这里放在 initAccountsView() 内部是为了能闭包调用本作用域的 loadSchoolUsersInline /
    //   loadSuperAdminsInline 来主动刷新列表。
    // ============================================================

    // 行内学校用户缓存：用于 schoolUserAction('edit', id) 按 id 找完整用户对象再打开弹窗
    const schoolUsersCache = new Map();   // key: `${schoolCode}|${userId}` -> user
    const cacheKey = (schoolCode, userId) => `${schoolCode}|${userId}`;

    // 行内平台超管缓存：id -> admin（包含 full_name / email 等）
    const superAdminsCache = new Map();

    // —— 行内学校用户列表的动作分发（编辑/重置密码/删除） ——
    async function schoolUserAction(action, userId, schoolCode) {
        if (!schoolCode || !userId) return;
        const cached = schoolUsersCache.get(cacheKey(schoolCode, userId));
        const username = (cached && cached.username) || '';
        try {
            if (action === 'edit') {
                // 编辑需要完整用户对象（full_name / phone / role / status）
                const userObj = cached || { id: userId, username };
                openUserModal(userObj, schoolCode);
                return;
            }
            if (action === 'reset') {
                // 重置密码弹窗依赖 rp_userId / rp_username / resetPwdModal（与详情面板共用同一组 DOM）
                if (!username) {
                    showNotice('❌ 缺少用户名，无法重置密码', 'error');
                    return;
                }
                openResetPwd(userId, username, schoolCode);
                return;
            }
            if (action === 'delete') {
                if (!username) {
                    showNotice('❌ 缺少用户名，无法删除', 'error');
                    return;
                }
                await deleteUser(userId, username, schoolCode);
                // 详情面板那边的 loadUsers() 也会跑，但行内列表不会自动刷新——手动拉一次
                loadSchoolUsersInline(schoolCode);
                return;
            }
            if (action === 'disable' || action === 'enable') {
                const isActive = (action === 'enable');
                const label = username ? `「${username}」` : `（id=${userId}）`;
                if (!confirm(`确定${isActive ? '启用' : '停用'}用户 ${label} 吗？`)) return;
                try {
                    const res = await adminFetch(`/api/admin/schools/${encodeURIComponent(schoolCode)}/users/${encodeURIComponent(userId)}/status`, {
                        method: 'PATCH',
                        body: JSON.stringify({ status: isActive ? 'active' : 'disabled' })
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error((data && data.error) || '操作失败');
                    showNotice(`✅ 用户已${isActive ? '启用' : '停用'}`, 'success');
                    loadSchoolUsersInline(schoolCode);
                } catch (e) {
                    showNotice('❌ ' + (e && e.message ? e.message : String(e)), 'error');
                }
                return;
            }
            showNotice(`⚠️ 未支持的动作：${action}`, 'error');
        } catch (e) {
            showNotice('❌ ' + (e && e.message ? e.message : String(e)), 'error');
        }
    }

    // —— 行内平台超管列表的动作分发（编辑/删除） ——
    async function superAdminAction(action, adminId) {
        if (!adminId) return;
        const modal = document.getElementById('saAccountModal');
        if (action === 'edit') {
            // 取缓存的 admin 对象（含 full_name / email）；若缓存缺失则拉一次列表兜底
            let admin = superAdminsCache.get(adminId);
            if (!admin) {
                try {
                    const res = await adminFetch('/api/user/super-admin');
                    if (res.ok) {
                        const data = await res.json();
                        const list = data.admins || data.data || data || [];
                        if (Array.isArray(list)) {
                            for (const a of list) superAdminsCache.set(String(a.id || a._id), a);
                            admin = superAdminsCache.get(adminId);
                        }
                    }
                } catch (_) { /* 静默——没数据就让表单只填 username */ }
            }
            // 优先调 SuperAdminAccount.js 暴露的 preFill 接口；
            // 若 SuperAdminAccount.js 尚未初始化（旧兼容），退化为直接操作编辑表单 DOM
            if (typeof window.superAdminOpenEditForm === 'function') {
                window.superAdminOpenEditForm(admin || { id: adminId });
                return;
            }
            // 兜底：直接显示编辑表单（即便 SuperAdminAccount.js 未加载也能让用户看到 form 框架）
            const editWrap = document.getElementById('saEditAdminFormWrap');
            const editIdEl = document.getElementById('saEditAdminId');
            const editUnameEl = document.getElementById('saEditAdminUsername');
            const editFullNameEl = document.getElementById('saEditAdminFullName');
            const editEmailEl = document.getElementById('saEditAdminEmail');
            if (!editWrap) {
                showNotice('❌ 编辑表单未找到（请刷新页面重试）', 'error');
                return;
            }
            if (modal) modal.classList.remove('hidden');
            if (editIdEl) editIdEl.value = adminId;
            if (editUnameEl) editUnameEl.textContent = (admin && admin.username) || `(id=${adminId})`;
            if (editFullNameEl) editFullNameEl.value = (admin && (admin.full_name || admin.fullName)) || '';
            if (editEmailEl) editEmailEl.value = (admin && admin.email) || '';
            editWrap.classList.remove('hidden');
            return;
        }
        if (action === 'delete') {
            // 走与 SuperAdminAccount.js 中相同的接口契约；username 现场回查一次
            let username = '';
            try {
                const res = await adminFetch('/api/user/super-admin');
                if (res.ok) {
                    const data = await res.json();
                    const list = data.admins || data.data || data || [];
                    const target = (Array.isArray(list) ? list : []).find((u) => String(u.id || u._id) === String(adminId));
                    username = (target && (target.username || target.full_name)) || '';
                }
            } catch (_) { /* 静默——若查不到也允许用 id 兜底删除 */ }
            const label = username ? `「${username}」` : `（id=${adminId}）`;
            if (!confirm(`确定删除平台超管账号 ${label} 吗？此操作不可恢复。`)) return;
            try {
                const res = await adminFetch(`/api/user/super-admin/${encodeURIComponent(adminId)}`, { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error((data && data.error) || '删除失败');
                showNotice('✅ 已删除', 'success');
                // 刷新行内列表
                loadSuperAdminsInline();
                // 若 saAccountModal 已打开，同步刷新弹层内列表
                if (modal && !modal.classList.contains('hidden')) {
                    const openBtn = document.getElementById('btnAccountMgmt');
                    if (openBtn) openBtn.click();
                }
            } catch (e) {
                showNotice('❌ ' + (e && e.message ? e.message : String(e)), 'error');
            }
            return;
        }
        showNotice(`⚠️ 未支持的动作：${action}`, 'error');
    }

    // 暴露到 window，供列表行内按钮调用（来自页面内 onclick 字符串拼接的兼容保留）
    window.schoolUserAction = schoolUserAction;
    window.superAdminAction = superAdminAction;
    // SuperAdminAccount.js 提交编辑成功后回调，用于刷新行内列表
    window.superAdminInlineRefresh = () => loadSuperAdminsInline();

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
                const enabled = !(u.status === 'disabled' || u.status === 'inactive' || u.enabled === false || u.isActive === false);
                const createdAt = u.created_at || u.createdAt || '-';
                const adminId = String(u.id || u._id || '');
                superAdminsCache.set(adminId, u);  // 给 superAdminAction('edit', id) 提供完整对象
                const safeId = escapeHtml(adminId);
                return `
                    <tr>
                        <td class="px-3 py-2 font-mono text-gray-800">${escapeHtml(u.username || '-')}</td>
                        <td class="px-3 py-2">${escapeHtml(u.full_name || u.fullName || '-')}</td>
                        <td class="px-3 py-2">
                            ${enabled ? '<span class="inline-flex px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">已启用</span>' : '<span class="inline-flex px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs">已停用</span>'}
                        </td>
                        <td class="px-3 py-2 text-gray-600">${escapeHtml(String(createdAt))}</td>
                        <td class="px-3 py-2 text-right">
                            <button class="text-sm text-blue-600 hover:underline" data-sa-act="edit" data-sa-id="${safeId}">编辑</button>
                            <button class="ml-3 text-sm text-red-600 hover:underline" data-sa-act="delete" data-sa-id="${safeId}">删除</button>
                        </td>
                    </tr>`;
            }).join('');
            // 事件委托，避免 onclick 字符串拼接的转义陷阱
            tbody.querySelectorAll('button[data-sa-act]').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const act = btn.getAttribute('data-sa-act');
                    const id = btn.getAttribute('data-sa-id');
                    if (act && id) superAdminAction(act, id);
                });
            });
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
            // 行内列表缓存，便于 schoolUserAction('edit') 按 id 取完整对象
            // 注意：仅保留当前学校（避免跨校 id 冲突导致缓存命中错误用户）
            for (const k of Array.from(schoolUsersCache.keys())) {
                if (k.startsWith(schoolCode + '|')) schoolUsersCache.delete(k);
            }
            tbody.innerHTML = list.map((u) => {
                const userId = String(u.id || u._id || '');
                schoolUsersCache.set(cacheKey(schoolCode, userId), u);
                const enabled = !(u.status === 'disabled' || u.status === 'inactive' || u.enabled === false || u.isActive === false);
                const safeUsername = escapeHtml(u.username || '');
                const safeUserId = escapeHtml(userId);
                const safeSchoolCode = escapeHtml(schoolCode);
                // 已启用：编辑 / 重置密码 / 停用
                // 已停用：编辑 / 重置密码 / 启用 / 删除
                const actionBtns = enabled
                    ? `<button class="text-sm text-blue-600 hover:underline" data-act="edit" data-id="${safeUserId}" data-school="${safeSchoolCode}">编辑</button>
                       <button class="ml-3 text-sm text-orange-600 hover:underline" data-act="reset" data-id="${safeUserId}" data-school="${safeSchoolCode}">重置密码</button>
                       <button class="ml-3 text-sm text-gray-500 hover:underline" data-act="disable" data-id="${safeUserId}" data-school="${safeSchoolCode}">停用</button>`
                    : `<button class="text-sm text-blue-600 hover:underline" data-act="edit" data-id="${safeUserId}" data-school="${safeSchoolCode}">编辑</button>
                       <button class="ml-3 text-sm text-orange-600 hover:underline" data-act="reset" data-id="${safeUserId}" data-school="${safeSchoolCode}">重置密码</button>
                       <button class="ml-3 text-sm text-green-600 hover:underline" data-act="enable" data-id="${safeUserId}" data-school="${safeSchoolCode}">启用</button>
                       <button class="ml-3 text-sm text-red-600 hover:underline" data-act="delete" data-id="${safeUserId}" data-school="${safeSchoolCode}">删除</button>`;
                return `
                    <tr>
                        <td class="px-3 py-2 font-mono text-gray-800">${safeUsername || '-'}</td>
                        <td class="px-3 py-2">${escapeHtml(u.fullName || u.full_name || '-')}</td>
                        <td class="px-3 py-2">
                            <span class="inline-flex px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs">${escapeHtml(u.role || '-')}</span>
                        </td>
                        <td class="px-3 py-2">
                            ${enabled ? '<span class="inline-flex px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">已启用</span>' : '<span class="inline-flex px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs">已停用</span>'}
                        </td>
                        <td class="px-3 py-2 text-right whitespace-nowrap">
                            ${actionBtns}
                        </td>
                    </tr>`;
            }).join('');
            // 用事件委托绑定按钮，避免 onclick 字符串拼接出现转义陷阱
            tbody.querySelectorAll('button[data-act]').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const act = btn.getAttribute('data-act');
                    const id = btn.getAttribute('data-id');
                    const code = btn.getAttribute('data-school');
                    if (act && id && code) schoolUserAction(act, id, code);
                });
            });
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-red-500 py-6">加载失败：${escapeHtml(String(e.message || e))}</td></tr>`;
        }
    }
    document.getElementById('suAddBtn')?.addEventListener('click', () => {
        const code = document.getElementById('suSchoolSelect').value;
        if (!code) return;
        window.alert(`请在「学校管理」→ 选中学校（${code}）→「用户管理」Tab 内新增用户。\n（内嵌新增表单将在下个迭代补全，避免与现有 detailPanel.users 双绑）`);
    });

    // FIX 已落地：window.superAdminAction / window.schoolUserAction
    //   均已在 initAccountsView() 内定义并暴露到 window，
    //   列表行的 onclick / 事件委托按钮均可正常派发动作。

    return { switchAccountsSubview };
}
