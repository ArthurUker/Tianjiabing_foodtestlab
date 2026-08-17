/**
 * 平台超管控制台 · 左侧功能菜单 + 主区多视图切换（P-Refactor：由原 adminSidebar.js
 * 普通 script 重构为 ESM，由页面 module script 末尾统一装配）。
 *
 * 职责：
 *   1. DOM 收纳：4 个 admin-view 视图 section 统一挪进 <main>；schools 容器动态补壳
 *   2. 一级/二级菜单切换、侧栏折叠、URL hash 路由恢复、退出登录
 *
 * 时序说明：本模块改为 ESM 后由 module script 装配，所有子视图切换函数经参数注入、
 * 且在页面全部状态就绪后才初始化 —— 原先普通 script 先于 module 执行导致的时序竞态
 * （__adminSidebarOnModuleReady 补丁）已自然消除，无需任何 window 中转。
 *
 * @param {object} views 子视图切换函数（全部可选，缺失时对应视图仅做显隐切换）
 * @param {Function} [views.switchSchoolsSubview]  学校管理（页面 module script 提供）
 * @param {Function} [views.switchAccountsSubview] 账号与权限（views/accountsView.js 提供）
 * @param {Function} [views.switchBackupSubview]   备份运维（views/backupView.js 提供）
 * @param {Function} [views.switchReportsSubview]  测试报告（由本模块内置处理，见 switchTo 中的 reports 分支）
 * @returns {{ switchTo: (viewName: string, opts?: { subview?: string }) => void }}
 */
import { getAuthService, adminFetch } from './context.js';
import { showNotice } from './ui.js';

/**
 * 「测试报告」视图的默认 subview 切换器。
 * 在主区两个 iframe（submit / summary）之间切换，并同步顶栏图标/标题/描述
 * 与「新窗口打开」链接指向。无依赖注入，按惯例 mount 于 adminViewReports。
 *
 * P-ReportsSync: submit subview 时显示「同步」按钮（汇总报告由 /api/test-results/sync 生成），
 * summary subview 时隐藏（汇总报告本身已是最新的生成产物，无需再触发生成）。
 */
function switchDefaultReports(subName) {
    const target = subName === 'summary' ? 'summary' : 'submit';
    const ICONS = {
        submit: { icon: 'fa-clipboard-check', color: 'bg-emerald-500/10 text-emerald-600', title: '数据上报', desc: '填写并提交测试用例结果（token 自动复用登录态）', openHref: '/test-report.html' },
        summary: { icon: 'fa-chart-bar',         color: 'bg-indigo-500/10 text-indigo-600',     title: '汇总报告', desc: 'docs/test-results/latest/（由生成脚本自动产出）',         openHref: '/docs/test-results/latest/index.html' }
    };
    // 切换两个 subview 显隐
    document.querySelectorAll('[data-reports-subview]').forEach((el) => {
        el.classList.toggle('hidden', el.getAttribute('data-reports-subview') !== target);
    });
    // 同步顶栏图标 / 标题 / 描述 / 「新窗口打开」链接
    const meta = ICONS[target];
    const iconEl = document.getElementById('adminReportsIcon');
    const titleEl = document.getElementById('adminReportsTitle');
    const descEl = document.getElementById('adminReportsDesc');
    const openEl = document.getElementById('adminReportsOpenNew');
    if (iconEl) {
        iconEl.className = 'shrink-0 w-10 h-10 rounded-lg ' + meta.color + ' flex items-center justify-center text-lg';
        iconEl.innerHTML = '<i class="fas ' + meta.icon + '"></i>';
    }
    if (titleEl) titleEl.textContent = meta.title;
    if (descEl) descEl.textContent = meta.desc;
    if (openEl) openEl.setAttribute('href', meta.openHref);
    // P-ReportsSync: submit subview 显示「同步」按钮，summary 隐藏。
    // 同步按钮的 click handler 由 initAdminSidebar 装配时一次性注册，无需在此重复绑定。
    const syncBtn = document.getElementById('adminReportsSync');
    if (syncBtn) syncBtn.hidden = (target !== 'submit');
    // 更新左侧二级菜单 active 态（保持 hash 切换、键盘可达也一致生效）
    document.querySelectorAll('[data-subnav="reports"] .admin-sidebar__subitem').forEach((sub) => {
        sub.classList.toggle('active', sub.getAttribute('data-subview') === target);
    });
}

export function initAdminSidebar({
    switchSchoolsSubview,
    switchAccountsSubview,
    switchBackupSubview,
    switchReportsSubview,
} = {}) {
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
    // 包裹 schoolsContainer 为 admin-view。fallback 选择器需兼容两类容器宽度：
    //   - legacy 写法：.max-w-7xl（旧版 sidebar 依赖）
    //   - 现行写法：.max-w-[2000px]（与 adminViewOverview/Accounts/Backup/Reports 统一宽度，P-Fix）
    // 缺其中任一者会导致 schools 容器未被收纳、跨视图切换遗留显示（用户反馈现象）。
    const schoolsContainer = document.querySelector('#adminViewSchools') ||
        document.querySelector(
            '.container.mx-auto.px-4.py-6.max-w-7xl, ' +
            '.container.mx-auto.px-4.py-6.max-w-\\[2000px\\]'
        );
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
        // P-ReportsFill: 同步当前激活视图到 .admin-layout 的 data 属性，
        // 让 CSS 可以为 reports 视图放宽 max-width（iframe 内的报告填满主区）
        const layout = document.querySelector('.admin-layout');
        if (layout) layout.setAttribute('data-active-view', viewName);
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
            if (typeof switchSchoolsSubview === 'function') {
                switchSchoolsSubview(subName);
            }
        }

        // accounts 视图：按指定 subview 渲染主区（默认 super-admins）
        if (viewName === 'accounts') {
            const subName = opts.subview || 'super-admins';
            if (typeof switchAccountsSubview === 'function') {
                switchAccountsSubview(subName);
            }
        }

        // backup 视图：按指定 subview 渲染主区（默认 all）
        if (viewName === 'backup') {
            const subName = opts.subview || 'all';
            if (typeof switchBackupSubview === 'function') {
                switchBackupSubview(subName);
            }
        }

        // reports 视图：按指定 subview 切换主区内的两个 iframe（默认 submit = 数据上报）。
        // 默认实现已覆盖典型需求（切换 submit/summary、刷新 iframe、更新「重新载入/新窗口打开」指向）；
        // 调用方也可通过 switchReportsSubview 注入自定义行为（覆盖默认）。未注入时使用内置 switchDefaultReports。
        if (viewName === 'reports') {
            const subName = opts.subview || 'submit';
            const handler = typeof switchReportsSubview === 'function'
                ? switchReportsSubview
                : (sn) => switchDefaultReports(sn);
            handler(subName);
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

    // 二级菜单点击（测试报告：数据上报 / 汇总报告）
    document.querySelectorAll('[data-subnav="reports"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
        sub.addEventListener('click', () => {
            switchTo('reports', { subview: sub.getAttribute('data-subview') });
        });
    });

    // 「重新载入」按钮：刷新当前激活的 iframe
    const btnReportsReload = document.getElementById('adminReportsReload');
    if (btnReportsReload) {
        btnReportsReload.addEventListener('click', () => {
            const active = document.querySelector('.reports-subview:not(.hidden) iframe');
            if (active) {
                // 给 URL 追加时间戳后再去掉，避免缓存；iframe.contentWindow.location.reload() 会重新加载
                try { active.contentWindow.location.reload(); } catch (e) { active.src = active.src; }
            }
        });
    }

    // P-ReportsSync: 「同步」按钮 → 调用后端 /api/test-results/sync 重新生成汇总报告 + 重建 dist。
    // 独立于 test-report.html 内的 syncNow：因 iframe 内嵌模式下 test-report.html 的顶部 nav 被隐藏，
    // 同步入口迁到 admin-schools 控制台顶部条上。两端共享同一后端接口，结果一致；
    // admin-schools 端自管 loading/成功/失败反馈（避免跨 iframe 状态同步的脆弱性）。
    const btnReportsSync = document.getElementById('adminReportsSync');
    if (btnReportsSync) {
        const syncIcon = btnReportsSync.querySelector('i');
        const syncText = document.getElementById('adminReportsSyncText');
        btnReportsSync.addEventListener('click', async () => {
            if (btnReportsSync.disabled) return;
            btnReportsSync.disabled = true;
            const origIconClass = syncIcon ? syncIcon.className : '';
            const origText = syncText ? syncText.textContent : '';
            if (syncIcon) syncIcon.className = 'fas fa-spinner fa-spin mr-1';
            if (syncText) syncText.textContent = '同步中...';
            try {
                const r = await adminFetch('/api/test-results/sync', { method: 'POST' });
                const j = await r.json().catch(() => ({}));
                if (!r.ok || !j.success) {
                    throw new Error(j.error || `HTTP ${r.status}`);
                }
                showNotice(j.message || '同步完成，汇总报告已更新', 'success');
                // 同步完成后自动刷新 submit iframe，让测试人员看到自己刚保存的最新结果
                try {
                    const iframe = document.getElementById('reportsIframeSubmit');
                    if (iframe) iframe.contentWindow.location.reload();
                } catch (_) { /* 跨域或被卸载时静默 */ }
            } catch (e) {
                showNotice('同步失败：' + (e.message || e), 'error');
            } finally {
                btnReportsSync.disabled = false;
                if (syncIcon) syncIcon.className = origIconClass;
                if (syncText) syncText.textContent = origText;
            }
        });
    }

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
        // authService 由页面 module script 经 context 注入
        const svc = getAuthService();
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
            try { localStorage.setItem('admin_sidebar_collapsed', collapsed ? '1' : '0'); } catch (e) { /* 隐私模式等场景忽略 */ }
        });
        try {
            if (localStorage.getItem('admin_sidebar_collapsed') === '1') {
                sidebar.classList.add('collapsed');
                toggleBtn.querySelector('i').className = 'fas fa-angle-double-right';
            }
        } catch (e) { /* 读取失败按未折叠处理 */ }
    }

    // 快捷按钮：跳转学校管理（保留 backup 入口兼容老 DOM）
    // 注：btnGoSchoolsToBackup DOM 已不存在（adminViewBackup 重构为内嵌），此处?.绑定安全 noop。
    const goSchools = (subview) => {
        // 是否已选中学校：以左侧「当前学校」分组是否可见为准
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

    // 启动：按 URL hash 恢复视图（P-Refactor：改为 ESM 后在页面 module 末尾统一装配、
    // 仅此一次调用即可 —— 原普通 script 先行执行的时序竞态与 __adminSidebarOnModuleReady
    // 补丁已随本次重构移除，不再需要重放）。
    // hash 格式：#view=reports  或  #view=reports&subview=submit
    // hash 中的 subview 用于按视图恢复二级子状态（仅当当前 hash 显式指定该视图时生效）。
    const hashStr = location.hash || '';
    const hashViewMatch = hashStr.match(/view=([a-z]+)/);
    const hashSubMatch = hashStr.match(/subview=([a-z-]+)/);
    const initialView = hashViewMatch ? hashViewMatch[1] : null;
    const initialSubview = hashSubMatch ? hashSubMatch[1] : undefined;
    const domDefault = document.querySelector('.admin-view:not(.hidden)');
    if (initialView) {
        switchTo(initialView, { subview: initialSubview });
    } else if (domDefault) {
        switchTo(domDefault.getAttribute('data-view'));
    } else {
        switchTo('overview');
    }

    return { switchTo };
}
