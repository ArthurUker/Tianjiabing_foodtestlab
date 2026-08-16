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
 * @returns {{ switchTo: (viewName: string, opts?: { subview?: string }) => void }}
 */
import { getAuthService } from './context.js';

export function initAdminSidebar({
    switchSchoolsSubview,
    switchAccountsSubview,
    switchBackupSubview,
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
    // 补丁已随本次重构移除，不再需要重放）
    const hashMatch = (location.hash || '').match(/view=([a-z]+)/);
    const initialView = hashMatch ? hashMatch[1] : 'overview';
    const targetView = document.querySelector('.admin-view:not(.hidden)');
    switchTo(targetView ? targetView.getAttribute('data-view') : initialView);

    return { switchTo };
}
