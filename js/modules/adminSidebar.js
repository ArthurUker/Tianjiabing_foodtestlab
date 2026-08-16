/**
 * admin-schools.html 页面侧边栏 + 视图管理（从内联 <script> 抽离，P-Refactor）。
 *
 * 职责：
 *   1. 左侧菜单栏：一级菜单 / 二级菜单（subnav）切换、折叠、滚动同步激活态
 *   2. 主区多视图：平台总览 / 学校管理 / 账号与权限 / 备份运维 / 测试报告
 *   3. 「账号与权限」三个子视图：平台超管 / 学校用户 / 审计日志（含分页器）
 *   4. 「备份运维」两个子视图：全部备份 / 按学校（含 KPI、分页、恢复模态）
 *   5. 回收站操作按钮绑定（复制 / 查看 / 归档清理 / 再删除）
 *   6. 顶部「退出登录」按钮
 *
 * 依赖（由 admin-schools.html 的 <script type="module"> 暴露到 window）：
 *   - window.authService      （AuthService 单例，getToken / logout）
 *   - window.getApiBaseUrl    （生产同源返回空串）
 *   - window.switchSchoolsSubview （学校管理子视图切换，module script 暴露）
 *
 * 执行时序：本文件作为普通 <script src> 置于 <body> 末尾，IIFE 立即执行。
 *   初始化阶段仅做 DOM 收纳 + 事件绑定（不依赖 module script）；真正调用
 *   window.switchSchoolsSubview 发生在用户点击菜单时（此时 module script 已执行完毕）。
 */

    (function initAdminSidebar() {
        const sidebar = document.getElementById('adminSidebar');
        const items = sidebar ? sidebar.querySelectorAll('.admin-sidebar__item') : [];
        const main = document.querySelector('.admin-main');

        // 【DOM 收纳】
        // 1) adminViewOverview/Accounts/Backup/Reports 等新视图节点最初是在 <main> 之外追加的，
        //    把它们统一挪进 <main>，保证侧边栏布局正确包裹所有视图；
        // 2) 把原有的 .container.mx-auto... 包成 adminViewSchools，与新视图并列。
        if (main) {
            document.querySelectorAll('.admin-view').forEach((v) => {
                if (v.parentNode !== main) main.appendChild(v);
            });
        }
        const schoolsContainer = document.querySelector('#adminViewSchools') ||
            document.querySelector('.container.mx-auto.px-4.py-6.max-w-7xl');
        if (schoolsContainer && !schoolsContainer.classList.contains('admin-view')) {
            // 包裹 schoolsContainer 为 admin-view
            const wrap = document.createElement('section');
            wrap.className = 'admin-view';
            wrap.id = 'adminViewSchools';
            wrap.setAttribute('data-view', 'schools');
            schoolsContainer.parentNode.insertBefore(wrap, schoolsContainer);
            wrap.appendChild(schoolsContainer);
        }

        function switchTo(viewName, opts = {}) {
            // 隐藏所有视图
            document.querySelectorAll('.admin-view').forEach((v) => v.classList.add('hidden'));
            // 显示目标视图
            const target = document.querySelector('.admin-view[data-view="' + viewName + '"]');
            if (target) target.classList.remove('hidden');
            // 更新一级菜单激活态
            items.forEach((it) => {
                it.classList.toggle('active', it.getAttribute('data-view') === viewName);
            });

            // 控制二级菜单展开/收起：仅当前一级菜单的 subnav 展开，其余收起
            document.querySelectorAll('.admin-sidebar__subnav').forEach((sn) => {
                const parentView = sn.getAttribute('data-subnav');
                const isCurrent = parentView === viewName;
                sn.classList.toggle('expanded', isCurrent);
                const parentItem = document.querySelector('.admin-sidebar__item[data-view="' + parentView + '"]');
                if (parentItem) parentItem.classList.toggle('expanded', isCurrent);
            });

            // schools 视图：按指定 subview 渲染主区（默认 list）
            if (viewName === 'schools') {
                const subName = opts.subview || 'list';
                if (typeof window.switchSchoolsSubview === 'function') {
                    window.switchSchoolsSubview(subName);
                }
            }

            // accounts 视图：按指定 subview 渲染主区（默认 super-admins）
            if (viewName === 'accounts') {
                const subName = opts.subview || 'super-admins';
                if (typeof window.switchAccountsSubview === 'function') {
                    window.switchAccountsSubview(subName);
                }
            }

            // backup 视图：按指定 subview 渲染主区（默认 all）
            if (viewName === 'backup') {
                const subName = opts.subview || 'all';
                if (typeof window.switchBackupSubview === 'function') {
                    window.switchBackupSubview(subName);
                }
            }

            // 滚动到顶部
            window.scrollTo({ top: 0, behavior: 'smooth' });
            // URL hash 同步（轻量、可分享）
            try {
                const hash = opts.subview ? '#view=' + viewName + '&subview=' + opts.subview : '#view=' + viewName;
                history.replaceState(null, '', hash);
            } catch (e) { /* file:// 等场景下 history.replaceState 可能抛错 */ }
        }

        // 一级菜单点击
        items.forEach((it) => {
            it.addEventListener('click', () => switchTo(it.getAttribute('data-view')));
        });

        // 二级菜单点击（学校管理：学校列表 / 回收站 / 5 个学校配置）
        document.querySelectorAll('[data-subnav="schools"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
            sub.addEventListener('click', () => {
                switchTo('schools', { subview: sub.getAttribute('data-subview') });
            });
        });

        // 二级菜单点击（账号与权限：平台超管 / 学校用户 / 审计日志）
        document.querySelectorAll('[data-subnav="accounts"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
            sub.addEventListener('click', () => {
                switchTo('accounts', { subview: sub.getAttribute('data-subview') });
            });
        });

        // 二级菜单点击（备份运维：全部 / 按学校）
        document.querySelectorAll('[data-subnav="backup"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
            sub.addEventListener('click', () => {
                switchTo('backup', { subview: sub.getAttribute('data-subview') });
            });
        });

        // 「当前学校」分组关闭按钮：等价于关闭详情、返回列表
        document.getElementById('sidebarCloseSchool')?.addEventListener('click', () => {
            document.getElementById('closeDetail')?.click();
        });

        // 快速入口卡（总览里的 4 张卡）跳转
        document.querySelectorAll('[data-goto]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                switchTo(el.getAttribute('data-goto'));
            });
        });

        // 顶部右侧退出登录按钮（与侧边栏底部共用同一逻辑）
        function doLogout() {
            if (!window.confirm('确定要退出登录吗？')) return;
            // authService 在 module 作用域内，普通 <script> 无法直接引用，
            // 需通过 module script 暴露的 window.authService 跨作用域调用。
            const svc = window.authService;
            const done = () => window.location.replace('./super-admin-login.html');
            if (svc && typeof svc.logout === 'function') {
                svc.logout().finally(done);
            } else {
                done();
            }
        }
        const btnLogoutTop = document.getElementById('btnLogoutTop');
        if (btnLogoutTop) btnLogoutTop.addEventListener('click', doLogout);
        const btnSidebarLogout = document.getElementById('btnSidebarLogout');
        if (btnSidebarLogout) btnSidebarLogout.addEventListener('click', doLogout);

        // 折叠/展开侧边栏
        const toggleBtn = document.getElementById('adminSidebarToggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                sidebar.classList.toggle('collapsed');
                const collapsed = sidebar.classList.contains('collapsed');
                toggleBtn.querySelector('i').className = collapsed ? 'fas fa-angle-double-right' : 'fas fa-angle-double-left';
                try { localStorage.setItem('admin_sidebar_collapsed', collapsed ? '1' : '0'); } catch (e) {}
            });
            try {
                if (localStorage.getItem('admin_sidebar_collapsed') === '1') {
                    sidebar.classList.add('collapsed');
                    toggleBtn.querySelector('i').className = 'fas fa-angle-double-right';
                }
            } catch (e) {}
        }

        // 快捷按钮：跳转学校管理（保留 backup 入口兼容老 DOM）
        // 注：btnGoSchoolsToBackup DOM 已不存在（adminViewBackup 重构为内嵌），此处?.绑定安全 noop。
        const goSchools = (subview) => {
            // 是否已选中学校：以左侧「当前学校」分组是否可见为准（跨 script 作用域，避免引用 module 内变量）
            const grp = document.getElementById('sidebarSchoolConfigGroup');
            const hasSchool = grp && !grp.classList.contains('hidden');
            switchTo('schools', { subview: hasSchool ? subview : 'list' });
        };
        document.getElementById('btnGoSchoolsToBackup')?.addEventListener('click', () => goSchools('backup'));

        // 「新建超管」按钮：直接复用原 btnAccountMgmt 触发逻辑（弹层仍完整）
        const btnAccountMgmtInlineNew = document.getElementById('btnAccountMgmtInlineNew');
        const btnAccountMgmt = document.getElementById('btnAccountMgmt');
        if (btnAccountMgmtInlineNew && btnAccountMgmt) {
            btnAccountMgmtInlineNew.addEventListener('click', () => btnAccountMgmt.click());
        } else if (btnAccountMgmtInlineNew) {
            btnAccountMgmtInlineNew.addEventListener('click', () => {
                const modal = document.getElementById('saAccountModal');
                if (modal) modal.classList.remove('hidden');
            });
        }

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
        window.switchAccountsSubview = switchAccountsSubview;

        // --- 子视图 1: 平台超管内嵌列表（与 SuperAdminAccount.js 共享接口契约） ---
        async function loadSuperAdminsInline() {
            const tbody = document.getElementById('saInlineList');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-gray-400 py-6">加载中…</td></tr>';
            try {
                // 优先使用 module 内 authService 与 getApiBaseUrl（由 module script 暴露）
                const svc = window.authService;
                const apiBase = (typeof window.getApiBaseUrl === 'function' ? window.getApiBaseUrl() : '');
                const token = svc && typeof svc.getToken === 'function' ? svc.getToken() : '';
                const res = await fetch(`${apiBase}/api/user/super-admin`, {
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
                });
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
                    const svc = window.authService;
                    const apiBase = (typeof window.getApiBaseUrl === 'function' ? window.getApiBaseUrl() : '');
                    const token = svc && typeof svc.getToken === 'function' ? svc.getToken() : '';
                    const res = await fetch(`${apiBase}/api/admin/schools?limit=200`, {
                        headers: { Authorization: 'Bearer ' + token }
                    });
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
                const svc = window.authService;
                const apiBase = (typeof window.getApiBaseUrl === 'function' ? window.getApiBaseUrl() : '');
                const token = svc && typeof svc.getToken === 'function' ? svc.getToken() : '';
                const res = await fetch(`${apiBase}/api/admin/schools/${encodeURIComponent(schoolCode)}/users`, {
                    headers: { Authorization: 'Bearer ' + token }
                });
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
                const svc = window.authService;
                const apiBase = (typeof window.getApiBaseUrl === 'function' ? window.getApiBaseUrl() : '');
                const token = svc && typeof svc.getToken === 'function' ? svc.getToken() : '';
                const params = auGetParams();
                const res = await fetch(`${apiBase}/api/audit-logs?${params.toString()}`, {
                    headers: { Authorization: 'Bearer ' + token }
                });
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

        // 简易 HTML 转义工具（避免 XSS 注入渲染）
        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        // ============================================================
        // 「备份运维」内嵌实现（全部 / 按学校）—— 直接调 /api/admin/backups
        // ============================================================
        const BACKUP_PAGE_SIZE = 15;
        const bkState = { all: { page: 1, total: 0 }, bySchool: { page: 1, total: 0 } };
        let bkSchoolsLoaded = false;

        function bkFetch(path, opts = {}) {
            const svc = window.authService;
            const apiBase = (typeof window.getApiBaseUrl === 'function' ? window.getApiBaseUrl() : '');
            const token = svc && typeof svc.getToken === 'function' ? svc.getToken() : '';
            return fetch(`${apiBase}/api/admin/backups${path}`, {
                ...opts,
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
            });
        }

        function bkFmtSize(n) {
            if (n == null) return '-';
            const num = Number(n);
            if (isNaN(num) || num <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.min(units.length - 1, Math.floor(Math.log(num) / Math.log(1024)));
            return (num / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
        }

        function bkFmtTime(s) {
            if (!s) return '-';
            try { return new Date(s).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return String(s); }
        }

        function bkStatusBadge(s) {
            const t = String(s || '');
            if (t === 'pass' || t === 'verified') {
                return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs"><i class="fas fa-check"></i>已验证</span>';
            }
            if (t === 'fail' || t === 'failed') {
                return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs"><i class="fas fa-times"></i>失败</span>';
            }
            if (t === 'pending' || t === 'running') {
                return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full text-xs"><i class="fas fa-clock"></i>' + escapeHtml(t) + '</span>';
            }
            return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs">' + escapeHtml(t || '-') + '</span>';
        }

        function bkRowTpl(r, withSchool) {
            const id = String(r.id || '');
            const size = bkFmtSize(r.fileSize);
            const verified = bkStatusBadge(r.verifyStatus || r.status);
            const download = `
                <button class="text-blue-600 hover:underline" data-act="download-enc" data-id="${id}"><i class="fas fa-lock mr-1"></i>AES</button>
                <button class="ml-3 text-blue-600 hover:underline" data-act="download-plain" data-id="${id}"><i class="fas fa-file mr-1"></i>明文</button>`;
            return `
                <tr>
                    <td class="px-3 py-2 text-gray-700 whitespace-nowrap">${escapeHtml(bkFmtTime(r.createdAt))}</td>
                    ${withSchool ? `<td class="px-3 py-2"><span class="inline-flex px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs">${escapeHtml(String(r.scope || 'all'))}</span></td><td class="px-3 py-2 font-mono text-gray-800">${escapeHtml(String(r.schoolCode || '-'))}</td>` : `<td class="px-3 py-2"><span class="inline-flex px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full text-xs">${escapeHtml(String(r.scope || 'all'))}</span></td>`}
                    <td class="px-3 py-2 text-gray-600">${escapeHtml(size)}</td>
                    <td class="px-3 py-2">${verified}</td>
                    <td class="px-3 py-2 text-right whitespace-nowrap">
                        <button class="text-sm text-blue-600 hover:underline" data-act="verify" data-id="${id}">验证</button>
                        <span class="mx-1 text-gray-300">|</span>
                        ${download}
                        <span class="mx-1 text-gray-300">|</span>
                        <button class="text-sm text-red-600 hover:underline" data-act="restore" data-id="${id}" data-code="${escapeHtml(String(r.schoolCode || ''))}">恢复</button>
                    </td>
                </tr>`;
        }

        function bkUpdatePager(prefix, total) {
            const st = bkState[prefix === 'All' ? 'all' : 'bySchool'];
            const page = st.page;
            const pageSize = BACKUP_PAGE_SIZE;
            const totalPages = Math.max(1, Math.ceil(total / pageSize));
            const pager = document.getElementById('bkPager' + prefix);
            const prev = document.getElementById('bkPrev' + prefix);
            const next = document.getElementById('bkNext' + prefix);
            if (pager) pager.textContent = `第 ${page}/${totalPages} 页  · 共 ${total} 条`;
            if (prev) prev.disabled = page <= 1;
            if (next) next.disabled = page >= totalPages;
        }

        async function bkLoadAll() {
            const tbody = document.getElementById('bkListAll');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-400 py-6">加载中…</td></tr>';
            const page = bkState.all.page;
            try {
                const res = await bkFetch(`?page=${page}&pageSize=${BACKUP_PAGE_SIZE}`);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                const list = j.data || [];
                bkState.all.total = j.total || 0;
                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-400 py-6">暂无备份</td></tr>';
                    bkUpdatePager('All', 0);
                    bkRefreshKpi([]);
                    return;
                }
                tbody.innerHTML = list.map((r) => bkRowTpl(r, true)).join('');
                bkUpdatePager('All', bkState.all.total);
                bkRefreshKpi(list);
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center text-red-500 py-6">加载失败：${escapeHtml(String(e.message || e))}</td></tr>`;
            }
        }

        async function bkLoadBySchool(schoolCode) {
            const tbody = document.getElementById('bkListBySchool');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-400 py-6">加载中…</td></tr>';
            const page = bkState.bySchool.page;
            try {
                const res = await bkFetch(`?schoolCode=${encodeURIComponent(schoolCode)}&page=${page}&pageSize=${BACKUP_PAGE_SIZE}`);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                const list = j.data || [];
                bkState.bySchool.total = j.total || 0;
                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-400 py-6">该学校暂无备份</td></tr>';
                    bkUpdatePager('Sch', 0);
                    return;
                }
                tbody.innerHTML = list.map((r) => {
                    const id = String(r.id || '');
                    return `
                        <tr>
                            <td class="px-3 py-2 text-gray-700 whitespace-nowrap">${escapeHtml(bkFmtTime(r.createdAt))}</td>
                            <td class="px-3 py-2 text-gray-600">${escapeHtml(bkFmtSize(r.fileSize))}</td>
                            <td class="px-3 py-2">${bkStatusBadge(r.verifyStatus || r.status)}</td>
                            <td class="px-3 py-2 text-right whitespace-nowrap">
                                <button class="text-sm text-blue-600 hover:underline" data-act="verify" data-id="${id}">验证</button>
                                <span class="mx-1 text-gray-300">|</span>
                                <button class="text-sm text-blue-600 hover:underline" data-act="download-enc" data-id="${id}"><i class="fas fa-lock mr-1"></i>AES</button>
                                <button class="ml-3 text-blue-600 hover:underline" data-act="download-plain" data-id="${id}"><i class="fas fa-file mr-1"></i>明文</button>
                                <span class="mx-1 text-gray-300">|</span>
                                <button class="text-sm text-red-600 hover:underline" data-act="restore" data-id="${id}" data-code="${escapeHtml(schoolCode)}">恢复</button>
                            </td>
                        </tr>`;
                }).join('');
                bkUpdatePager('Sch', bkState.bySchool.total);
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="4" class="text-center text-red-500 py-6">加载失败：${escapeHtml(String(e.message || e))}</td></tr>`;
            }
        }

        function bkRefreshKpi(list) {
            try {
                const total = bkState.all.total || list.length;
                const verified = list.filter((r) => ['pass', 'verified'].includes(String(r.verifyStatus || ''))).length;
                const failed = list.filter((r) => {
                    const s = String(r.verifyStatus || r.status || '');
                    return ['fail', 'failed', 'pending', 'running'].includes(s);
                }).length;
                const latest = list.length ? list[0] : null;
                const elT = document.getElementById('bkKpiTotal');
                const elV = document.getElementById('bkKpiVerified');
                const elF = document.getElementById('bkKpiFailed');
                const elL = document.getElementById('bkKpiLatest');
                if (elT) elT.textContent = total;
                if (elV) elV.textContent = verified;
                if (elF) elF.textContent = failed;
                if (elL) elL.textContent = latest ? bkFmtTime(latest.createdAt) : '-';
            } catch (_) { /* 静默 */ }
        }

        async function bkEnsureSchoolsLoaded() {
            const sel = document.getElementById('bkSchoolSelect');
            if (!sel) return;
            if (bkSchoolsLoaded && sel.options.length > 1) return;
            try {
                const svc = window.authService;
                const apiBase = (typeof window.getApiBaseUrl === 'function' ? window.getApiBaseUrl() : '');
                const token = svc && typeof svc.getToken === 'function' ? svc.getToken() : '';
                const res = await fetch(`${apiBase}/api/admin/schools?limit=200`, { headers: { Authorization: 'Bearer ' + token } });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                const list = j.data?.schools || j.schools || j.data || [];
                if (Array.isArray(list)) {
                    list.forEach((s) => {
                        const opt = document.createElement('option');
                        opt.value = s.code || s.schoolCode || s.id;
                        opt.textContent = `${s.code || ''} - ${s.fullName || s.full_name || s.shortName || s.short_name || ''}`;
                        sel.appendChild(opt);
                    });
                    bkSchoolsLoaded = true;
                }
            } catch (e) {
                console.warn('[bk] 加载学校列表失败:', e);
            }
        }

        // 子视图切换
        function switchBackupSubview(subName) {
            document.querySelectorAll('#adminViewBackup .admin-subview').forEach((s) => {
                s.classList.toggle('hidden', s.getAttribute('data-subview') !== subName);
            });
            document.querySelectorAll('[data-subnav="backup"] .admin-sidebar__subitem[data-subview]').forEach((s) => {
                s.classList.toggle('active', s.getAttribute('data-subview') === subName);
            });
            if (subName === 'all') {
                bkLoadAll();
            } else if (subName === 'by-school') {
                bkEnsureSchoolsLoaded();
            }
        }
        window.switchBackupSubview = switchBackupSubview;

        // 操作按钮：全部 / 单校的复合事件委托
        async function bkAction(act, id, extra) {
            try {
                if (act === 'verify') {
                    const res = await bkFetch(`/${id}/verify`, { method: 'POST' });
                    const j = await res.json();
                    if (res.ok && j.success) {
                        alert('验证完成 ✅\n\n' + (j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n'));
                    } else {
                        alert('验证失败 ❌\n\n' + ((j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || j.error));
                    }
                    if (document.getElementById('adminViewBackup') && !document.getElementById('adminViewBackup').classList.contains('hidden')) {
                        bkReloadCurrent();
                    }
                } else if (act === 'download-enc' || act === 'download-plain') {
                    const fmt = act === 'download-enc' ? 'encrypted' : 'plain';
                    const apiBase = (typeof window.getApiBaseUrl === 'function' ? window.getApiBaseUrl() : '');
                    const svc = window.authService;
                    const token = svc && typeof svc.getToken === 'function' ? svc.getToken() : '';
                    const url = `${apiBase}/api/admin/backups/${id}/download?format=${fmt}`;
                    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
                    if (!r.ok) {
                        const j = await r.json().catch(() => ({}));
                        throw new Error(j.error || `HTTP ${r.status}`);
                    }
                    const blob = await r.blob();
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `backup-${id}.${fmt === 'encrypted' ? 'aes' : 'sql.gz'}`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                } else if (act === 'run-all') {
                    if (!confirm('立即备份所有学校？这会创建一份新的备份记录。')) return;
                    const res = await bkFetch('/run', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
                    const j = await res.json();
                    if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
                    alert(`备份完成 ✅ 文件：${j.data?.file || '-'}`);
                    bkLoadAll();
                } else if (act === 'run-single') {
                    const code = extra || '';
                    if (!code) return;
                    if (!confirm(`立即备份学校 ${code}？`)) return;
                    const res = await bkFetch('/run', { method: 'POST', body: JSON.stringify({ scope: 'single', schoolCode: code }) });
                    const j = await res.json();
                    if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
                    alert(`备份完成 ✅ 文件：${j.data?.file || '-'}`);
                    bkLoadBySchool(code);
                } else if (act === 'restore') {
                    bkOpenRestore(id, extra);
                }
            } catch (e) {
                alert('操作失败：' + (e.message || e));
            }
        }
        function bkReloadCurrent() {
            const active = document.querySelector('#adminViewBackup .admin-subview:not(.hidden)');
            if (!active) return;
            const sub = active.getAttribute('data-subview');
            if (sub === 'all') bkLoadAll();
            if (sub === 'by-school') {
                const code = document.getElementById('bkSchoolSelect').value;
                if (code) bkLoadBySchool(code);
            }
        }

        // 模态
        let bkRestoreTarget = null;
        function bkOpenRestore(id, schoolCode) {
            bkRestoreTarget = { id, schoolCode };
            const modal = document.getElementById('bkRestoreModal');
            const input = document.getElementById('bkRestoreConfirm');
            const doBtn = document.getElementById('bkRestoreDo');
            if (input) { input.value = ''; }
            if (doBtn) doBtn.disabled = true;
            if (modal) modal.classList.remove('hidden');
            setTimeout(() => { try { input.focus(); } catch (_) {} }, 50);
        }
        function bkCloseRestore() {
            const modal = document.getElementById('bkRestoreModal');
            if (modal) modal.classList.add('hidden');
            bkRestoreTarget = null;
        }

        // 按钮绑定
        document.getElementById('bkRefreshAll')?.addEventListener('click', bkLoadAll);
        document.getElementById('bkRunAll')?.addEventListener('click', () => bkAction('run-all'));
        document.getElementById('bkPrevAll')?.addEventListener('click', () => {
            if (bkState.all.page > 1) { bkState.all.page--; bkLoadAll(); }
        });
        document.getElementById('bkNextAll')?.addEventListener('click', () => {
            const max = Math.ceil(bkState.all.total / BACKUP_PAGE_SIZE);
            if (bkState.all.page < max) { bkState.all.page++; bkLoadAll(); }
        });

        document.getElementById('bkSchoolSelect')?.addEventListener('change', (e) => {
            const code = e.target.value;
            const addBtn = document.getElementById('bkRunSingle');
            if (addBtn) addBtn.disabled = !code;
            if (code) {
                bkState.bySchool.page = 1;
                bkLoadBySchool(code);
            } else {
                const tbody = document.getElementById('bkListBySchool');
                if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-400 py-6">请先选择学校</td></tr>';
                bkUpdatePager('Sch', 0);
            }
        });
        document.getElementById('bkRunSingle')?.addEventListener('click', () => {
            const code = document.getElementById('bkSchoolSelect').value;
            bkAction('run-single', null, code);
        });
        document.getElementById('bkPrevSch')?.addEventListener('click', () => {
            const code = document.getElementById('bkSchoolSelect').value;
            if (code && bkState.bySchool.page > 1) { bkState.bySchool.page--; bkLoadBySchool(code); }
        });
        document.getElementById('bkNextSch')?.addEventListener('click', () => {
            const code = document.getElementById('bkSchoolSelect').value;
            const max = Math.ceil(bkState.bySchool.total / BACKUP_PAGE_SIZE);
            if (code && bkState.bySchool.page < max) { bkState.bySchool.page++; bkLoadBySchool(code); }
        });

        // 列表内操作（事件委托）：两个列表共用同一处理
        ['bkListAll', 'bkListBySchool'].forEach((id) => {
            document.getElementById(id)?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-act]');
                if (!btn) return;
                bkAction(btn.getAttribute('data-act'), btn.getAttribute('data-id'), btn.getAttribute('data-code'));
            });
        });

        // 模态按钮
        document.getElementById('bkRestoreClose')?.addEventListener('click', bkCloseRestore);
        document.getElementById('bkRestoreCancel')?.addEventListener('click', bkCloseRestore);
        document.getElementById('bkRestoreConfirm')?.addEventListener('input', (e) => {
            const doBtn = document.getElementById('bkRestoreDo');
            if (doBtn) doBtn.disabled = e.target.value.trim() !== 'RESTORE';
        });
        document.getElementById('bkRestoreDo')?.addEventListener('click', async () => {
            if (!bkRestoreTarget) return;
            const { id, schoolCode } = bkRestoreTarget;
            try {
                const res = await bkFetch(`/${id}/restore`, { method: 'POST', body: JSON.stringify({ schoolCode }) });
                const j = await res.json();
                if (res.ok && j.success) {
                    alert('恢复完成 ✅\n\n' + (j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n'));
                    bkCloseRestore();
                    bkReloadCurrent();
                } else {
                    alert('恢复失败 ❌\n\n' + ((j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || j.error));
                }
            } catch (e) {
                alert('恢复异常：' + (e.message || e));
            }
        });

        // KPI 数据填充：从原页面渲染后的 DOM 推断（最小侵入）。
        // 学校列表 tbody id = schoolTbody；回收站是独立 table（在 recycleBinList 内），
        // 二者分开统计，避免把回收站误算进「学校总数」。
        function refreshKpi() {
            try {
                const schoolRows = document.querySelectorAll('#schoolTbody tr');
                // 排除「加载中…/暂无学校」这类占位行（真实行必含操作按钮 .btn-manage）
                const realRows = Array.from(schoolRows).filter((tr) => tr.querySelector('.btn-manage'));
                const total = realRows.length;
                let active = 0;
                realRows.forEach((tr) => {
                    if ((tr.textContent || '').includes('启用')) active++;
                });
                const recycled = document.querySelectorAll('#recycleBinList tbody tr').length;
                if (document.getElementById('kpiTotalSchools')) document.getElementById('kpiTotalSchools').textContent = total;
                if (document.getElementById('kpiActiveSchools')) document.getElementById('kpiActiveSchools').textContent = active;
                if (document.getElementById('kpiRecycleSchools')) document.getElementById('kpiRecycleSchools').textContent = recycled;
            } catch (e) { /* 静默 */ }
        }
        // 初次刷新 + 列表刷新后定时刷新 KPI（用 MutationObserver 太重，简单 setInterval 即可）
        setTimeout(refreshKpi, 1500);
        setInterval(refreshKpi, 8000);

        // 回收站数量徽标（recycleBinList 渲染为 <table><tbody><tr>，用 tbody tr 统计）
        function refreshRecycleBadge() {
            try {
                const recycleCount = document.querySelectorAll('#recycleBinList tbody tr').length;
                const badge = document.getElementById('adminSidebarBadgeSchools');
                if (!badge) return;
                const n = parseInt(recycleCount, 10);
                if (n > 0) {
                    badge.textContent = n;
                    badge.removeAttribute('hidden');
                } else {
                    badge.setAttribute('hidden', '');
                }
            } catch (e) {}
        }
        setTimeout(refreshRecycleBadge, 2000);
        setInterval(refreshRecycleBadge, 8000);

        // 顶部 super_admin 统计（软实现，从 super_admin 弹层渲染后的列表行推断）
        function refreshSuperAdminKpi() {
            try {
                // 超管列表 tbody id = saAdminList（SuperAdminAccount.js 的 listEl）
                const rows = document.querySelectorAll('#saAdminList tr');
                if (document.getElementById('kpiSuperAdmins')) {
                    document.getElementById('kpiSuperAdmins').textContent = rows.length || '?';
                }
            } catch (e) {}
        }
        setInterval(refreshSuperAdminKpi, 8000);

        // 启动：按 URL hash 恢复视图
        const hashMatch = (location.hash || '').match(/view=([a-z]+)/);
        const initialView = hashMatch ? hashMatch[1] : 'overview';
        switchTo(initialView);

        // 调试用：暴露切换函数
        window.adminSidebarSwitch = switchTo;

        // ===== P-Refactor 时序竞态修复 =====
        // 背景：本文件是普通 <script>（同步执行，先于 module script），而
        //       window.switchSchoolsSubview 由 module script 在文档解析完成后才暴露。
        //       若初始视图是 'schools'（如 URL hash=#view=schools 时刷新页面），
        //       switchTo('schools') 会因 switchSchoolsSubview 尚未就绪而被跳过，
        //       导致学校列表/回收站/详情面板的显隐状态初始化错误。
        // 修复：注册一个 module 就绪回调，module script 暴露 switchSchoolsSubview 后
        //       由它调用本回调，重放一次「当前视图 + 子视图」切换，纠正状态。
        window.__adminSidebarOnModuleReady = function () {
            // 仅当当前激活视图是 schools 且上次切换因时序被跳过时，才补调
            const activeView = document.querySelector('.admin-view:not(.hidden)');
            const viewName = activeView ? activeView.getAttribute('data-view') : null;
            if (viewName === 'schools') {
                // 重放默认子视图（list）；若 URL 带 subview 则按 subview
                const subMatch = (location.hash || '').match(/subview=([a-z-]+)/);
                const subName = subMatch ? subMatch[1] : 'list';
                if (typeof window.switchSchoolsSubview === 'function') {
                    window.switchSchoolsSubview(subName);
                }
            }
        };
    })();
