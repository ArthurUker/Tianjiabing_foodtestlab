import { UIHelper } from './utils/UIHelper.js';
import { initTableware } from './modules/Tableware.js';
import { GenericTestModule } from './modules/GenericTest.js';
import { initPathogen } from './modules/Pathogen.js';
import { initDashboard } from './modules/Dashboard.js';
import { ExportService } from './services/ExportService.js';
import { initializeSampleData } from './utils/SampleDataGenerator.js';
// ✨ 学校个性化配置：提取 schoolCode + 应用 SchoolCustomization 到静态录入表单
import { extractSchoolCode } from './utils/schoolCode.js';
import { ensureSchoolConfig, getSchoolCustomization, applyCustomizationToAllForms, applySchoolCustomizationToTitles, applySchoolBranding, applyVisibleTypesToNav, onSchoolConfigChanged } from './utils/schoolCustomization.js';
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
import { GuestDashboard } from './modules/GuestDashboard.js';
// 6. ✨ 引入会话管理服务

// P2-10 阶段B：移除 window.renderQuickAccessData 全局函数。
// 快速访问模式的表格渲染由 index.html 内联脚本自身兜底完成，无需全局暴露。

console.log('✅ main.js 模块加载开始');

// P2-10 阶段B：导航处理函数改为模块内函数（不再挂 window，由事件委托调用）
function handleNavigation(target) {
    console.log('🔧 handleNavigation 被调用，目标:', target);
    
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
        console.log('✅ 导航成功，显示:', target);
        
        // 特殊处理：初始化需要动态渲染的模块（P2-10：直接调用 import 的 initAuditLog，不再走 window）
        if (target === 'audit-log') {
            try {
                console.log('🔧 审计日志模块初始化中...');
                initAuditLog();
                console.log('✅ 审计日志模块初始化成功');
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
        if (btn) handleNavigation(btn.dataset.target);
    });
}

// P2-10 阶段B：接收模块内动态生成 HTML 发出的导航请求（替代 window.handleNavigation 内联调用）
document.addEventListener('app:navigate', (e) => {
    const target = e.detail && e.detail.target;
    if (target) handleNavigation(target);
});

document.addEventListener('DOMContentLoaded', async () => {
    console.log('✅ DOMContentLoaded 事件触发');
    
    try {
        document.body.classList.add('loaded');
        
        // 🎯 检查是否为快速访问模式 (从 URL 参数或 localStorage 读取)
        const urlParams = new URLSearchParams(window.location.search);
        const isQuickAccessParam = urlParams.get('quickAccess') === 'true';
        
        // 也检查 localStorage (备选方案) - 使用单例实例
        const isQuickAccessStorage = guestAuthService.isQuickAccessMode();
        
        const isQuickAccessMode = isQuickAccessParam || isQuickAccessStorage;
        console.log('🔍 URL参数quickAccess:', isQuickAccessParam);
        console.log('🔍 localStorage is_quick_access:', isQuickAccessStorage);
        console.log('🔍 最终快速访问模式:', isQuickAccessMode);
        
        // ✨ 如果是快速访问模式但还没有访客信息，则自动创建临时访客
        if (isQuickAccessMode && !guestAuthService.isLoggedIn()) {
            console.log('⚡ 快速访问模式已激活 - 自动创建临时访客信息');
            await guestAuthService.quickAccessAsViewer();
        }
        
        // ✨ 在快速访问模式下初始化示例数据
        if (isQuickAccessMode) {
            console.log('📊 初始化快速访问模式的示例数据...');
            initializeSampleData();
        }
        
        // 0. 🔐 初始化路由与认证系统 (必须最先执行)
        console.log('🔧 Router 初始化中...');
        await router.init();
        router.setupAll();

        // 1. UI 初始化 (它会自动处理侧边栏点击切换)
        console.log('🔧 UIHelper.setupNavigation 调用中...');
        
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
                console.log('✅ UIHelper.setupNavigation 完成');
            } catch (error) {
                console.error('❌ UIHelper.setupNavigation 失败:', error);
            }
        });
        
        // 🎯 快速访问模式：隐藏管理功能菜单 (必须在 UIHelper.setupNavigation 之后执行)
        if (isQuickAccessMode) {
            console.log('✨ ========== 快速访问模式激活 - 开始隐藏菜单与编辑功能 ==========');
            
            // 方法1: 使用内联 CSS 样式 (使用 !important)
            const style = document.createElement('style');
            style.textContent = `
                button[data-target="export-data"],
                button[data-target="backup-restore"],
                button[data-admin-only],
                div[data-admin-only],
                #btnExportDashboard,
                #btnAddAtpPoint,
                #btnImportPathogen,
                #btnDownloadTemplate,
                #fileInput,
                #pathogenFileInput,
                .btn-delete,
                .btn-edit,
                .btn-remove-point,
                #tablewareTestForm button[type="submit"],
                #pesticideTestForm button[type="submit"],
                #oilTestForm button[type="submit"],
                #leanMeatTestForm button[type="submit"] {
                    display: none !important;
                }
                div.text-xs.text-gray-400.font-semibold {
                    display: none !important;
                }
                /* 禁用录入表单操作 */
                #tablewareTestForm input,
                #tablewareTestForm select,
                #tablewareTestForm textarea,
                #pesticideTestForm input,
                #pesticideTestForm select,
                #pesticideTestForm textarea,
                #oilTestForm input,
                #oilTestForm select,
                #oilTestForm textarea,
                #leanMeatTestForm input,
                #leanMeatTestForm select,
                #leanMeatTestForm textarea {
                    background-color: #f5f5f5 !important;
                    cursor: not-allowed !important;
                    opacity: 0.8 !important;
                }
            `;
            document.head.appendChild(style);
            
            console.log('✅ 访客模式：已通过CSS隐藏录入/编辑/删除功能');
        }


        // 2. 业务模块初始化
        console.log('🔧 initTableware 调用中...');
        initTableware();
        console.log('✅ initTableware 完成');
        
        console.log('🔧 initPathogen 调用中...');
        initPathogen();
        console.log('✅ initPathogen 完成');
        
        console.log('🔧 GenericTestModule 初始化中...');
        new GenericTestModule({ moduleName: 'pesticide', formId: 'pesticideTestForm', tableId: 'pesticideRecords' });
        new GenericTestModule({ moduleName: 'oil', formId: 'oilTestForm', tableId: 'oilRecords' });
        new GenericTestModule({ moduleName: 'leanMeat', formId: 'leanMeatTestForm', tableId: 'leanMeatRecords' });
        console.log('✅ GenericTestModule 完成');

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
            console.log('✅ 学校个性化配置已应用到录入表单', schoolCode || '(无 schoolCode，跳过)');
            // 主页顶部标题/校徽按校动态显示（README 品牌中立化要求）
            applySchoolBranding(schoolCode);
            // RK3/RK36：配置就绪后再消费 visible_types，使导航/内容区反映该校可见模块；
            // 随后由 Router 重新施加权限/访客规则，保证「不可见模块」不会因配置被强行显示。
            applyVisibleTypesToNav(customization);
            router.updateNavigationByPermission();
        } catch (e) {
            console.error('❌ 学校个性化配置应用失败:', e);
        }

        // CR-06：跨标签页配置同步。同一 origin 下其它标签页改写该校定制缓存后，
        // 本标签页自动重应用可见性/标签/校徽/权限，保持多标签页一致。
        try {
            const syncCode = extractSchoolCode();
            if (syncCode) {
                onSchoolConfigChanged(syncCode, (cfg) => {
                    applyVisibleTypesToNav(cfg);
                    applyCustomizationToAllForms(cfg);
                    applySchoolCustomizationToTitles(cfg);
                    applySchoolBranding(syncCode);
                    router.updateNavigationByPermission();
                });
            }
        } catch (e) {
            console.error('❌ 跨标签页配置同步注册失败:', e);
        }

        // 3. 看板初始化
        console.log('🔧 initDashboard 调用中...');
        try {
            console.log('📝 initDashboard 是否存在:', typeof initDashboard);
            const result = initDashboard();
            console.log('📊 initDashboard 返回值:', result);
            console.log('✅ initDashboard 完成');
            // 看板由 initDashboard 动态重建，必须在构建完成后再次应用小标题覆盖
            applySchoolCustomizationToTitles(customization);

            // 🔥 强制确保Dashboard显示正确标题
            setTimeout(() => {
                const dashboardH2 = document.querySelector('#dashboard h2');
                if (dashboardH2 && dashboardH2.textContent.includes('实时数据概览')) {
                    console.warn('⚠️ Dashboard标题未更新，强制纠正...');
                    if (typeof createDashboardStructure === 'function') {
                        createDashboardStructure();
                        console.log('✅ Dashboard已强制重新初始化');
                    }
                }
            }, 500);
        } catch (error) {
            console.error('❌ initDashboard 执行出错:', error.message, error.stack);
        }

        // 4. 看板快速导出功能 (仅非快速访问模式)
        if (!isQuickAccessMode) {
            console.log('🔧 绑定导出按钮事件...');
            document.getElementById('btnExportDashboard')?.addEventListener('click', () => {
                ExportService.generatePDF('dashboard', '食品安全日报');
            });
            console.log('✅ 导出按钮事件绑定完成');
        }

        // 5. 初始化数据导出报告模块 (仅非快速访问模式)
        if (!isQuickAccessMode) {
            console.log('🔧 ExportService 初始化中...');
            try {
                const exportService = new ExportService();
                exportService.init();
                console.log('✅ ExportService 初始化成功');
            } catch (error) {
                console.error('❌ ExportService 初始化失败:', error);
            }
        }

        // 5b. ✨ 初始化数据备份与恢复模块 (仅非快速访问模式)
        if (!isQuickAccessMode) {
            console.log('🔧 BackupRestoreService 初始化中...');
            try {
                const backupRestore = new BackupRestoreService();
                backupRestore.init();
                console.log('✅ BackupRestoreService 初始化成功');
            } catch (error) {
                console.error('❌ BackupRestoreService 初始化失败:', error);
            }
        }

        // 6. ✨ 初始化用户管理模块 (仅管理员可访问)
        if (!isQuickAccessMode) {
            console.log('🔧 UserManagement 初始化中...');
            try {
                if (router.isAdmin() || permissionService.hasRole('manager')) {
                    initUserManagement();
                    console.log('✅ UserManagement 初始化成功');
                } else {
                    console.log('⚠️ 当前用户无权访问用户管理模块');
                }
            } catch (error) {
                console.error('❌ UserManagement 初始化失败:', error);
            }
        }

        // 7. ✨ 初始化审计日志模块 (仅管理员可访问)
        // P2-10：动态导航通过 import 的 initAuditLog 直接调用，无需挂 window
        if (!isQuickAccessMode) {
            console.log('🔧 AuditLog 初始化中...');
            try {
                if (router.isAdmin()) {
                    initAuditLog();
                    console.log('✅ AuditLog 初始化成功');
                } else {
                    console.log('⚠️ 当前用户无权访问审计日志模块');
                }
            } catch (error) {
                console.error('❌ AuditLog 初始化失败:', error);
            }
        }

        // 8. ✨ 初始化会话管理 (针对所有用户)
        console.log('🔧 SessionManager 初始化中...');
        try {
            sessionManager.init();
            console.log('✅ SessionManager 初始化成功');
        } catch (error) {
            console.error('❌ SessionManager 初始化失败:', error);
        }

        // 10. ✨ 初始化访客中心 (仅访客登录用户可访问)
        console.log('🔧 GuestDashboard 初始化中...');
        try {
            // 🎯 关键修复：只有当访客已登录且管理员未登录时，才显示访客仪表板
            const isAdminLoggedIn = router.getToken ? router.getToken() : localStorage.getItem('auth_token');
            const isGuestLoggedIn = guestAuthService.isLoggedIn();
            
            // DS-16: 仅打印是否持有 token 的布尔值，严禁输出 token 内容
            console.log('🔍 管理员已登录:', !!isAdminLoggedIn);
            console.log('🔍 访客状态:', isGuestLoggedIn);
            
            if (isGuestLoggedIn && !isAdminLoggedIn) {
                console.log('✅ 检测到访客登录，初始化访客仪表板...');
                
                // 检查是否为快速访问模式
                const isQuickAccess = guestAuthService.isQuickAccessMode();
                if (isQuickAccess) {
                    console.log('📊 快速访问模式 - 进入只读数据查看');
                }
                
                const guestDashboard = new GuestDashboard();
                await guestDashboard.init();
                console.log('✅ GuestDashboard 初始化成功');
                
                // 显示访客菜单
                document.querySelectorAll('.guest-menu-section').forEach(el => {
                    el.classList.remove('hidden');
                });
                
                // ✨ 隐藏管理员仪表板，显示访客仪表板
                const adminDashboard = document.getElementById('dashboard');
                const guestDashboardEl = document.getElementById('guest-dashboard');
                
                if (adminDashboard) {
                    adminDashboard.classList.add('hidden');
                    console.log('✅ 已隐藏管理员仪表板');
                }
                
                if (guestDashboardEl) {
                    guestDashboardEl.classList.remove('hidden');
                    console.log('✅ 已显示访客仪表板');
                }
                
                // 隐藏管理员菜单项
                document.querySelectorAll('[data-admin-only]').forEach(el => {
                    el.classList.add('hidden');
                });
                console.log('✅ 已隐藏管理员菜单项');
            } else {
                console.log('⚠️ 当前用户非访客身份，跳过 GuestDashboard 初始化');
            }
        } catch (error) {
            console.error('❌ GuestDashboard 初始化失败:', error);
        }

        // ✨ 导航已在初始化开始时设置，无需重复调用
        console.log('✅✅✅ 所有模块初始化完成！');
        
        // ✨ 快速访问模式：后备数据渲染器
        console.log('🔍 DEBUG: isQuickAccessMode =', isQuickAccessMode);
        
        if (isQuickAccessMode) {
            console.log('🎯 快速访问模式 - 启用后备数据渲染');
            setTimeout(() => {
                console.log('🎯 后备渲染器：2秒后检查表格并填充数据');
                
                // 专门处理餐具洁净度
                const tbody = document.getElementById('tablewareRecords');
                if (tbody) {
                    const cacheData = localStorage.getItem('cache_tableware');
                    if (cacheData) {
                        try {
                            const parsed = JSON.parse(cacheData);
                            const records = parsed.data || [];
                            console.log(`🎯 餐具洁净度: 发现${records.length}条记录`);
                            
                            if (records.length > 0) {
                                let html = '';
                                records.slice(0, 20).forEach(record => {
                                    const testDate = record.testDate || '';
                                    const canteen = record.canteen || '';
                                    const location = record.location || '';
                                    const rluValue = record.rluValue || '';
                                    const result = record.result || '';
                                    const inspector = record.inspector || '';
                                    
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
                                console.log(`✅ 餐具洁净度: 已渲染${records.length}条记录`);
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
        } else {
            console.log('🔍 DEBUG: 快速访问模式未启用');
        }

    } catch (error) {
        console.error('❌❌❌ DOMContentLoaded 中发生错误:', error);
        console.error('Stack:', error.stack);
    }
});
