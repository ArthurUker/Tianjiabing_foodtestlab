import { UIHelper } from './utils/UIHelper.js';
import { initTableware } from './modules/Tableware.js';
import { GenericTestModule } from './modules/GenericTest.js';
import { initPathogen } from './modules/Pathogen.js';
import { initDashboard } from './modules/Dashboard.js';
import { ExportService } from './services/ExportService.js';
import { initializeSampleData } from './utils/SampleDataGenerator.js';
// ✨ 学校个性化配置：提取 schoolCode + 应用 SchoolCustomization 到静态录入表单
import { extractSchoolCode } from './utils/schoolCode.js';
import { escapeHtml } from './utils/schoolCustomization/shared.js';
import { ensureSchoolConfig, getSchoolCustomization, applyCustomizationToAllForms, applySchoolCustomizationToTitles, applySchoolBranding, applyVisibleTypesToNav, applyVisibleMenuItemsToNav, onSchoolConfigChanged, onSchoolInfoChanged, revalidateSchoolInfo } from './utils/schoolCustomization.js';
// 1. ✨ 引入新模块
import { BackupRestoreService } from './modules/BackupRestore.js';
// 2. ✨ 引入认证与路由
import { router } from './core/Router.js';
// 3. ✨ 引入用户管理模块
import { initUserManagement } from './modules/UserManagement.js';
// 4. ✨ 引入权限服务
import { permissionService } from './services/PermissionService.js';
// 5. ✨ 引入审计日志模块
import { initAuditLog } from './modules/AuditLog.js';
import { sessionManager } from './services/SessionManager.js';
import guestAuthService from './services/GuestAuthService.js';
import { authService } from './services/AuthService.js';
import { GuestDashboard } from './modules/GuestDashboard.js';
// 6. ✨ 引入会话管理服务
// N1/N2/N3: 检测频率/日历/月报模块
import { showTodayDetectionHint, renderFrequencyCards, initFrequencySettings, loadDailyReminderBar } from './modules/FrequencyModule.js';
// P0-quickAccess: 快速访问模式检测 + CSS 注入收敛为单一事实来源（原 index.html ~330 行散落逻辑）
import { isQuickAccessMode, injectQuickAccessStyle } from './modules/quickAccess.js';

// P0-quickAccess: 表格渲染由 Tableware/GenericTest 内建 quickAccess 分支处理；
// dashboard 卡片由 Dashboard.js loadDashboardData 处理；登出按钮由 Router.setupLogoutButton 绑定。
// 原 index.html 868-1100 三块兜底脚本已删除（与上述实现重复且含 XSS）。


// P2-10 阶段B：导航处理函数改为模块内函数（不再挂 window，由事件委托调用）
function handleNavigation(target) {
    
    if (!target) return;
    
    // 获取所有按钮和内容区域
    const allBtns = document.querySelectorAll('.nav-btn');
    const allSections = document.querySelectorAll('.content-section');
    
    // 移除所有激活状态
    allBtns.forEach(btn => {
        btn.classList.remove('active', 'bg-blue-700');
    });
    allSections.forEach(section => {
        section.classList.add('hidden');
    });
    
    // 找到目标按钮并激活
    const targetBtn = Array.from(allBtns).find(btn => btn.getAttribute('data-target') === target);
    if (targetBtn) {
        targetBtn.classList.add('active', 'bg-blue-700');
    }
    
    // 显示目标内容
    const targetSection = document.getElementById(target);
    if (targetSection) {
        targetSection.classList.remove('hidden');
        // 切换到对应模块后，页面回到默认顶部（避免沿用上一模块的滚动位置）
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        
        // 特殊处理：初始化需要动态渲染的模块（P2-10：直接调用 import 的 initAuditLog，不再走 window）
        if (target === 'audit-log') {
            try {
                initAuditLog();
            } catch (error) {
                console.error('❌ 审计日志模块初始化失败:', error);
            }
        }
        // P1-20: 使用 CustomEvent 替代 window.loadDashboardData 全局函数调用
        if (target === 'dashboard') {
            try {
                document.dispatchEvent(new CustomEvent('dashboard:refresh'));
            } catch (error) {
                console.error('❌ 看板刷新失败:', error);
            }
        }
    } else {
        console.error('❌ 无法找到内容区域:', target);
    }
}

// P2-10 阶段B：导航按钮改用事件委托（index.html 静态按钮已移除 onclick）
const navEl = document.querySelector('nav.space-y-1');
if (navEl) {
    navEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-target]');
        if (btn) {
            handleNavigation(btn.dataset.target);
            closeSidebar(); // 手机端：点击菜单项后收起侧边栏
        }
    });
}

// ═══ 手机端侧边栏抽屉 ═══
function initSidebar() {
    const sb = document.querySelector('.sidebar-menu');
    const ov = document.getElementById('sbOverlay');
    const tg = document.getElementById('sbToggle');
    if (!sb || !ov || !tg) return;
    window.closeSidebar = function closeSidebar() {
        sb.classList.remove('sb-open');
        ov.classList.remove('sb-show');
        ov.style.display = 'none';
    };
    tg.addEventListener('click', () => {
        const isOpen = sb.classList.contains('sb-open');
        if (isOpen) { window.closeSidebar(); }
        else {
            sb.classList.add('sb-open');
            ov.style.display = 'block';
            requestAnimationFrame(() => ov.classList.add('sb-show'));
        }
    });
    ov.addEventListener('click', window.closeSidebar);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSidebar);
else initSidebar();

// P2-10 阶段B：接收模块内动态生成 HTML 发出的导航请求（替代 window.handleNavigation 内联调用）
document.addEventListener('app:navigate', (e) => {
    const target = e.detail && e.detail.target;
    if (target) handleNavigation(target);
});

document.addEventListener('DOMContentLoaded', async () => {
    
    try {
        document.body.classList.add('loaded');
        
        // 🎯 检查是否为快速访问模式（P0-quickAccess: 统一收敛至 quickAccess.js 单一来源）
        // FIX: 原写法 `const isQuickAccessMode = isQuickAccessMode()` 因同名遮蔽触发 TDZ 报错，
        // 故将本地布尔值改名为 quickAccessMode，避免与导入的函数 isQuickAccessMode 冲突。
        const quickAccessMode = isQuickAccessMode();
        
        // ✨ 如果是快速访问模式但还没有访客信息，则自动创建临时访客
        if (quickAccessMode && !guestAuthService.isLoggedIn()) {
            await guestAuthService.quickAccessAsViewer();
        }
        
        // ✨ 在快速访问模式下初始化示例数据
        if (quickAccessMode) {
            initializeSampleData();
        }
        
        // 0. 🔐 初始化路由与认证系统 (必须最先执行)
        await router.init();
        router.setupAll();

        // 1. UI 初始化 (它会自动处理侧边栏点击切换)
        
        // 使用 Promise 确保导航设置在下一个微任务中执行
        Promise.resolve().then(() => {
            try {
                const navBtns = document.querySelectorAll('.nav-btn');
                if (navBtns.length === 0) {
                    console.warn('⚠️ 未找到导航按钮，将在 100ms 后重试');
                    setTimeout(() => {
                        UIHelper.setupNavigation();
                    }, 100);
                } else {
                    UIHelper.setupNavigation();
                }
            } catch (error) {
                console.error('❌ UIHelper.setupNavigation 失败:', error);
            }
        });
        
        // 🎯 快速访问模式：隐藏管理功能菜单 (必须在 UIHelper.setupNavigation 之后执行)
        // P0-quickAccess: CSS 注入收敛至 quickAccess.js（幂等，含完整隐藏规则 + 输入禁用样式）
        if (quickAccessMode) {
            injectQuickAccessStyle();
        }


        // 2. 业务模块初始化
        initTableware();
        
        initPathogen();
        
        new GenericTestModule({ moduleName: 'pesticide', formId: 'pesticideTestForm', tableId: 'pesticideRecords' });
        new GenericTestModule({ moduleName: 'oil', formId: 'oilTestForm', tableId: 'oilRecords' });
        new GenericTestModule({ moduleName: 'leanMeat', formId: 'leanMeatTestForm', tableId: 'leanMeatRecords' });

        // ✨ 按校个性化：将 SchoolCustomization 应用到静态录入表单（标签/显隐/必填规则）。
        // 若用户直接打开 index.html（localStorage 无缓存），ensureSchoolConfig 会自动调公开端点兜底拉取。
        // CR-01: 必须在看板/表单可交互前 await 完成；带 3 秒超时降级，后端不可达时不阻塞页面。
        let customization = {};
        try {
            const schoolCode = extractSchoolCode();
            const fetched = await Promise.race([
                ensureSchoolConfig(schoolCode),
                new Promise((resolve) => setTimeout(() => resolve(undefined), 3000))
            ]);
            if (fetched === undefined) {
                console.warn('⚠️ 学校个性化配置拉取超时（3s），以缓存/默认配置继续初始化');
                customization = getSchoolCustomization(schoolCode) || {};
            } else {
                customization = fetched || {};
            }
            applyCustomizationToAllForms(customization);
            applySchoolCustomizationToTitles(customization);
            // 主页顶部标题/校徽按校动态显示（README 品牌中立化要求）
            await applySchoolBranding(schoolCode);
            // RK3/RK36：配置就绪后再消费 visible_types，使导航/内容区反映该校可见模块；
            // 随后由 Router 重新施加权限/访客规则，保证「不可见模块」不会因配置被强行显示。
            applyVisibleTypesToNav(customization);
            applyVisibleMenuItemsToNav(customization);
            router.updateNavigationByPermission();
        } catch (e) {
            console.error('❌ 学校个性化配置应用失败:', e);
        }

        // CR-06：跨标签页配置同步。同一 origin 下其它标签页改写该校定制缓存后，
        // 本标签页自动重应用可见性/标签/校徽/权限，保持多标签页一致。
        try {
            const syncCode = extractSchoolCode();
            if (syncCode) {
                onSchoolConfigChanged(syncCode, async (cfg) => {
                    applyVisibleTypesToNav(cfg);
                    applyVisibleMenuItemsToNav(cfg);
                    applyCustomizationToAllForms(cfg);
                    applySchoolCustomizationToTitles(cfg);
                    // 强制从服务端取最新（绕过 5 分钟缓存），保证定制（含系统标题/校徽排版）即时可见
                    await applySchoolBranding(syncCode, true);
                    router.updateNavigationByPermission();
                });
                // 学校基本信息（校徽/校名/主题色/系统标题）变更实时同步：管理控制台保存后，
                // 师生端打开的标签页通过 storage 事件（跨标签页）或 school:info-changed
                // （同标签页）收到通知，立即强制重拉服务端并重应用品牌，无需刷新页面。
                onSchoolInfoChanged(syncCode, async () => {
                    await applySchoolBranding(syncCode, true);
                    // 基本信息（含学校食堂信息）变更后，强制重拉定制配置并重应用表单，
                    // 使各检测模块的 canteen 下拉选项即时同步（无需刷新页面）
                    try {
                        const cfg = await ensureSchoolConfig(syncCode, true);
                        if (cfg && Object.keys(cfg).length) {
                            applyCustomizationToAllForms(cfg);
                            applySchoolCustomizationToTitles(cfg);
                        }
                    } catch (e) {
                        console.warn('⚠️ 基本信息变更后定制配置重应用失败:', e);
                    }
                    router.updateNavigationByPermission();
                });
                // RK-品牌：标签页重新可见时（如从管理控制台切回），用服务端 updated_at
                // 做版本校验，若管理控制台在后台保存过则刷新缓存并重应用，弥补 storage
                // 事件仅在编辑时标签页已打开才触发的局限，彻底消除"保存后看不到修改"。
                document.addEventListener('visibilitychange', async () => {
                    if (document.visibilityState !== 'visible') return;
                    try {
                        const changed = await revalidateSchoolInfo(syncCode);
                        if (changed) {
                            await applySchoolBranding(syncCode, true);
                            router.updateNavigationByPermission();
                        }
                    } catch (_) { /* 非关键路径 */ }
                });
            }
        } catch (e) {
            console.error('❌ 跨标签页配置同步注册失败:', e);
        }

        // DS-16 / 访客隔离：普通访客（非快速访问）必须进入专用访客视图，
        // 不得初始化普通看板、病原体、打印导出等业务模块，避免左侧完整菜单泄漏。
        // 注意：判断条件要与 Router.updateUserDisplay() 保持一致，避免"标签是访客但跑普通视图"。
        const isGuestLoggedIn = guestAuthService.isLoggedIn();
        const hasGuestInfo = !!guestAuthService.getCurrentGuest();
        const isGuestSession = isGuestLoggedIn || hasGuestInfo;
        const isQuickAccess = guestAuthService.isQuickAccessMode();
        const isRegularGuest = isGuestSession && !isQuickAccess;

        if (isRegularGuest) {
            // ========== 普通访客模式：仅初始化访客看板并隔离管理菜单 ==========
            try {
                const guestDashboard = new GuestDashboard();
                await guestDashboard.init();

                // 隐藏普通看板，显示访客看板
                document.getElementById('dashboard')?.classList.add('hidden');
                document.getElementById('guest-dashboard')?.classList.remove('hidden');

                // 隐藏左侧完整业务导航，仅保留退出登录
                const sidebarNav = document.querySelector('aside nav');
                if (sidebarNav) sidebarNav.classList.add('hidden');

                // 显示访客菜单（若有）
                document.querySelectorAll('.guest-menu-section').forEach(el => {
                    el.classList.remove('hidden');
                });
            } catch (error) {
                console.error('❌ GuestDashboard 初始化失败:', error);
            }
        } else {
            // ========== 普通员工 / 管理员 / 快速访问模式 ==========
            // 3. 看板初始化
            try {
                const result = initDashboard();
                // 看板由 initDashboard 动态重建，必须在构建完成后再次应用小标题覆盖
                applySchoolCustomizationToTitles(customization);

                // 🔥 强制确保Dashboard显示正确标题
                setTimeout(() => {
                    const dashboardH2 = document.querySelector('#dashboard h2');
                    if (dashboardH2 && dashboardH2.textContent.includes('实时数据概览')) {
                        console.warn('⚠️ Dashboard标题未更新，强制纠正...');
                        if (typeof createDashboardStructure === 'function') {
                            createDashboardStructure();
                        }
                    }
                }, 500);
            } catch (error) {
                console.error('❌ initDashboard 执行出错:', error.message, error.stack);
            }

            // N1/N2/N3: 检测频率卡片(月报) + 每日提示 + 配置页初始化
            if (!quickAccessMode) {
                try {
                    // N1+N3: 月报卡片渲染到独立区块 #frequency-report(侧栏菜单切换可见)
                    const reportEl = document.getElementById('frequency-report');
                    if (reportEl) {
                        renderFrequencyCards(reportEl);
                    }
                    // N2: 每日登录提示今日检测项目
                    showTodayDetectionHint();
                    // 顶部滚动提醒条：今日待检测项目（排除已完成的）
                    loadDailyReminderBar();
                    // N1/N2: 检测日历/频率设置页(manager+) - 直接渲染到区块
                    const settingsEl = document.getElementById('frequency-settings');
                    if (settingsEl) {
                        initFrequencySettings(settingsEl);
                    }
                } catch (e) {
                    console.error('❌ 检测频率模块初始化失败:', e.message);
                }
            }

            // 4. 看板快速导出功能 (仅非快速访问模式)
            if (!quickAccessMode) {
                document.getElementById('btnExportDashboard')?.addEventListener('click', () => {
                    ExportService.generatePDF('dashboard', '食品安全日报');
                });
            }

            // 5. 初始化数据导出报告模块 (仅非快速访问模式)
            if (!quickAccessMode) {
                try {
                    const exportService = new ExportService();
                    exportService.init();
                } catch (error) {
                    console.error('❌ ExportService 初始化失败:', error);
                }
            }

            // 5b. ✨ 初始化数据备份与恢复模块 (仅非快速访问模式)
            if (!quickAccessMode) {
                try {
                    const backupRestore = new BackupRestoreService();
                    backupRestore.init();
                } catch (error) {
                    console.error('❌ BackupRestoreService 初始化失败:', error);
                }
            }

            // 6. ✨ 初始化用户管理模块 (仅管理员可访问)
            if (!quickAccessMode) {
                try {
                    if (router.isAdmin() || permissionService.hasRole('manager')) {
                        initUserManagement();
                    }
                } catch (error) {
                    console.error('❌ UserManagement 初始化失败:', error);
                }
            }

            // 7. ✨ 初始化审计日志模块 (admin/manager 可访问,与 README §7.1 及后端权限一致)
            // P15: 原仅 router.isAdmin() 导致 manager 登录见空白页;放宽为与用户管理同条件
            // P2-10：动态导航通过 import 的 initAuditLog 直接调用，无需挂 window
            if (!quickAccessMode) {
                try {
                    if (router.isAdmin() || permissionService.hasRole('manager')) {
                        initAuditLog();
                    }
                } catch (error) {
                    console.error('❌ AuditLog 初始化失败:', error);
                }
            }
        }

        // 8. ✨ 初始化会话管理 (针对所有用户)
        try {
            sessionManager.init();
        } catch (error) {
            console.error('❌ SessionManager 初始化失败:', error);
        }

        // ✨ 导航已在初始化开始时设置，无需重复调用
        
        // ✨ 快速访问模式：后备数据渲染器
        
        if (quickAccessMode) {
            setTimeout(() => {
                
                // 专门处理餐具洁净度
                const tbody = document.getElementById('tablewareRecords');
                if (tbody) {
                    const cacheData = localStorage.getItem('cache_tableware');
                    if (cacheData) {
                        try {
                            const parsed = JSON.parse(cacheData);
                            const records = parsed.data || [];
                            
                            if (records.length > 0) {
                                let html = '';
                                records.slice(0, 20).forEach(record => {
                                    const testDate = escapeHtml(record.testDate || '');
                                    const canteen = escapeHtml(record.canteen || '');
                                    const location = escapeHtml(record.location || '');
                                    const rluValue = escapeHtml(record.rluValue || '');
                                    const result = escapeHtml(record.result || '');
                                    const inspector = escapeHtml(record.inspector || '');
                                    
                                    html += `<tr>
                                        <td class="border px-4 py-2">${testDate}</td>
                                        <td class="border px-4 py-2">${canteen}</td>
                                        <td class="border px-4 py-2">${location}</td>
                                        <td class="border px-4 py-2">${rluValue}</td>
                                        <td class="border px-4 py-2">${result}</td>
                                        <td class="border px-4 py-2">${inspector}</td>
                                        <td class="border px-4 py-2">-</td>
                                    </tr>`;
                                });
                                tbody.innerHTML = html;
                            } else {
                                tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6">暂无数据</td></tr>`;
                            }
                        } catch (e) {
                            console.error(`❌ 餐具洁净度渲染失败:`, e);
                        }
                    } else {
                        console.warn(`⚠️ 餐具缓存无数据`);
                    }
                } else {
                    console.warn(`⚠️ tablewareRecords 元素不存在`);
                }
            }, 2000);  // 2秒延迟
        }

    } catch (error) {
        console.error('❌❌❌ DOMContentLoaded 中发生错误:', error);
        console.error('Stack:', error.stack);
    }
});
