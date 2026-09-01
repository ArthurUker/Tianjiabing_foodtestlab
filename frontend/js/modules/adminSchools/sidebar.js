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
 * @param {Function} [views.switchAuditSubview]    审计日志（views/auditView.js 提供）
 * @param {Function} [views.switchBackupSubview]   备份运维（views/backupView.js 提供）
 * @param {Function} [views.switchReportsSubview]  测试报告（TR-Rewrite：三视图 tasks/issues/list，由 admin-schools.html module script 注入）
 * @returns {{ switchTo: (viewName: string, opts?: { subview?: string }) => void }}
 */
import { getAuthService, adminFetch } from './context.js';
import { showNotice } from './ui.js';

export function initAdminSidebar({
    switchSchoolsSubview,
    switchAccountsSubview,
    switchAuditSubview,
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

        // audit 视图：按指定 subview 渲染主区（默认 console）
        if (viewName === 'audit') {
            const subName = opts.subview || 'console';
            if (typeof switchAuditSubview === 'function') {
                switchAuditSubview(subName);
            }
        }

        // backup 视图：按指定 subview 渲染主区（默认 global）
        if (viewName === 'backup') {
            const subName = opts.subview || 'global';
            if (typeof switchBackupSubview === 'function') {
                switchBackupSubview(subName);
            }
        }

        // reports 视图：TR-Rewrite 后三视图（tasks/issues/list），由 admin-schools.html 注入 switchReportsSubview。
        // 默认 tasks（测试任务）；二级菜单 active 态由各视图自行管理或由 sidebar 通用逻辑同步。
        if (viewName === 'reports') {
            const subName = opts.subview || 'tasks';
            if (typeof switchReportsSubview === 'function') {
                switchReportsSubview(subName);
            }
        }

        // 滚动到顶部
        window.scrollTo({ top: 0, behavior: 'smooth' });
        // URL hash 同步（轻量、可分享）
        try {
            const hash = opts.subview ? '#view=' + viewName + '&subview=' + opts.subview : '#view=' + viewName;
            history.replaceState(null, '', hash);
        } catch (e) { /* file:// 等场景下 history.replaceState 可能抛错 */ }

        // 同步侧边栏底部说明：一级菜单介绍 + 当前激活的二级菜单介绍
        // 使用 requestAnimationFrame，确保各子视图切换函数已同步完 active 态
        requestAnimationFrame(updateSidebarHint);
    }

    /**
     * 根据当前激活的一级/二级菜单更新底部说明区。
     * 一级菜单说明 + 二级菜单说明分两行显示，均读取 DOM 上的 data-desc。
     */
    function updateSidebarHint() {
        const container = document.getElementById('adminSidebarHint');
        if (!container) return;

        const activeItem = sidebar.querySelector('.admin-sidebar__item.active');
        const activeSub = sidebar.querySelector('.admin-sidebar__subitem.active');
        const itemDesc = activeItem?.getAttribute('data-desc');
        const subDesc = activeSub?.getAttribute('data-desc');

        let html = '';
        if (itemDesc) {
            html += '<div><i class="fas fa-info-circle mr-1"></i>' + escapeHtml(itemDesc) + '</div>';
        }
        if (subDesc && subDesc !== itemDesc) {
            html += '<div class="mt-1"><i class="fas fa-chevron-right mr-1 text-[10px]"></i>' + escapeHtml(subDesc) + '</div>';
        }

        container.innerHTML = html || '<i class="fas fa-info-circle mr-1"></i>请选择左侧菜单查看对应功能说明';
    }

    function escapeHtml(text) {
        if (text == null) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // 一级菜单点击
    items.forEach((it) => {
        it.addEventListener('click', () => {
            const viewName = it.getAttribute('data-view');
            const isActive = it.classList.contains('active');
            const hasSubnav = it.classList.contains('has-subnav');
            // 若已激活且带二级菜单：点击切换（收起/展开）二级菜单，而非重新打开
            if (isActive && hasSubnav) {
                const subnav = document.querySelector('.admin-sidebar__subnav[data-subnav="' + viewName + '"]');
                const willExpand = !it.classList.contains('expanded');
                it.classList.toggle('expanded', willExpand);
                if (subnav) subnav.classList.toggle('expanded', willExpand);
                updateSidebarHint();
                return;
            }
            switchTo(viewName);
        });
    });

    // 二级菜单点击（学校管理：学校列表 / 回收站 / 5 个学校配置）
    document.querySelectorAll('[data-subnav="schools"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
        sub.addEventListener('click', () => {
            switchTo('schools', { subview: sub.getAttribute('data-subview') });
        });
    });

    // 二级菜单点击（账号与权限：平台超管 / 学校用户）
    document.querySelectorAll('[data-subnav="accounts"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
        sub.addEventListener('click', () => {
            switchTo('accounts', { subview: sub.getAttribute('data-subview') });
        });
    });

    // 二级菜单点击（审计日志：控制台审计日志 / 学校审计日志）
    document.querySelectorAll('[data-subnav="audit"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
        sub.addEventListener('click', () => {
            switchTo('audit', { subview: sub.getAttribute('data-subview') });
        });
    });

    // 二级菜单点击（备份运维：全局备份 / 单点备份 / 恢复管理）
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

    // TR-Rewrite: 测试报告视图改为原生模块（废弃 iframe），reload/sync 按钮已移除。
    // 二级菜单 active 态同步（三视图共享）
    document.querySelectorAll('[data-subnav="reports"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
        sub.addEventListener('click', () => {
            document.querySelectorAll('[data-subnav="reports"] .admin-sidebar__subitem').forEach((s) => s.classList.remove('active'));
            sub.classList.add('active');
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

    // 移动端侧栏抽屉开关
    const mobileMenuBtn = document.getElementById('adminMobileMenuBtn');
    const sidebarBackdrop = document.getElementById('adminSidebarBackdrop');
    function openMobileSidebar() {
        if (!sidebar) return;
        sidebar.classList.add('admin-sidebar--open');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('hidden');
        document.body.classList.add('admin-sidebar-open');
    }
    function closeMobileSidebar() {
        if (!sidebar) return;
        sidebar.classList.remove('admin-sidebar--open');
        if (sidebarBackdrop) sidebarBackdrop.classList.add('hidden');
        document.body.classList.remove('admin-sidebar-open');
    }
    if (mobileMenuBtn && sidebar) {
        mobileMenuBtn.addEventListener('click', () => {
            if (sidebar.classList.contains('admin-sidebar--open')) closeMobileSidebar();
            else openMobileSidebar();
        });
    }
    if (sidebarBackdrop) {
        sidebarBackdrop.addEventListener('click', closeMobileSidebar);
    }
    // 点击菜单项后自动关闭抽屉（移动端）
    function closeDrawerIfMobile() {
        if (window.innerWidth < 1024) closeMobileSidebar();
    }
    items.forEach((it) => it.addEventListener('click', closeDrawerIfMobile));
    sidebar?.querySelectorAll('.admin-sidebar__subitem').forEach((sub) => sub.addEventListener('click', closeDrawerIfMobile));
    // ESC / 切到桌面尺寸时自动关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMobileSidebar();
    });
    window.addEventListener('resize', () => {
        if (window.innerWidth >= 1024) closeMobileSidebar();
    });

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

    // 初始加载也更新一次底部说明
    requestAnimationFrame(updateSidebarHint);

    return { switchTo };
}
