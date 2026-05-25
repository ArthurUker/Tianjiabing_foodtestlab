import { UIHelper } from './utils/UIHelper.js';
import { initTableware } from './modules/Tableware.js';
import { GenericTestModule } from './modules/GenericTest.js';
import { initPathogen } from './modules/Pathogen.js';
import { initDashboard } from './modules/Dashboard.js';
import { ExportService } from './services/ExportService.js';
import { initializeSampleData } from './utils/SampleDataGenerator.js';
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

// ✨ 全局快速访问模式渲染函数 - 直接暴露给window
window.renderQuickAccessData = () => {
    console.log('🎯 快速访问模式渲染函数被调用');
    
    const tbody = document.getElementById('tablewareRecords');
    if (!tbody) {
        console.warn('⚠️ tablewareRecords 元素不存在');
        return;
    }
    
    const cacheData = localStorage.getItem('cache_tableware');
    if (!cacheData) {
        console.warn('⚠️ 缓存无数据');
        return;
    }
    
    try {
        const parsed = JSON.parse(cacheData);
        const records = parsed.data || [];
        console.log(`✅ 发现${records.length}条记录`);
        
        if (records.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6">暂无数据</td></tr>`;
            return;
        }
        
        let html = '';
        records.slice(0, 20).forEach(record => {
            html += `<tr>
                <td class="border px-4 py-2">${record.testDate || ''}</td>
                <td class="border px-4 py-2">${record.canteen || ''}</td>
                <td class="border px-4 py-2">${record.location || ''}</td>
                <td class="border px-4 py-2">${record.rluValue || ''}</td>
                <td class="border px-4 py-2">${record.result || ''}</td>
                <td class="border px-4 py-2">${record.inspector || ''}</td>
                <td class="border px-4 py-2">-</td>
            </tr>`;
        });
        tbody.innerHTML = html;
        console.log(`✅ 已渲染${records.length}条记录`);
    } catch (e) {
        console.error('❌ 渲染失败:', e);
    }
};

console.log('✅ main.js 模块加载开始');

// ✅ 全局导航处理函数 - 作为 onclick 属性的备份
window.handleNavigation = function(target) {
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
        
        // 特殊处理：初始化需要动态渲染的模块
        if (target === 'audit-log' && typeof window.initAuditLog === 'function') {
            try {
                console.log('🔧 审计日志模块初始化中...');
                window.initAuditLog();
                console.log('✅ 审计日志模块初始化成功');
            } catch (error) {
                console.error('❌ 审计日志模块初始化失败:', error);
            }
        }
        // 切换到看板时强制刷新数据，确保显示各模块最新缓存
        if (target === 'dashboard' && typeof window.loadDashboardData === 'function') {
            try {
                window.loadDashboardData();
            } catch (error) {
                console.error('❌ 看板刷新失败:', error);
            }
        }
    } else {
        console.error('❌ 无法找到内容区域:', target);
    }
};

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
            guestAuthService.quickAccessAsViewer();
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
        
        // 🎯 暴露 router 到全局作用域（用于调试和登出功能）
        window.router = router;
        console.log('✅ Router 初始化完成, window.router 已暴露');
        
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

        // 3. 看板初始化
        console.log('🔧 initDashboard 调用中...');
        try {
            console.log('📝 initDashboard 是否存在:', typeof initDashboard);
            const result = initDashboard();
            console.log('📊 initDashboard 返回值:', result);
            // 🎯 暴露 initDashboard 到全局作用域以便调试
            window.initDashboard = initDashboard;
            console.log('✅ initDashboard 完成');
            
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
            // 即使出错，也尝试暴露函数
            window.initDashboard = initDashboard;
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
        // 暴露 initAuditLog 到全局以支持动态导航
        window.initAuditLog = initAuditLog;
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
            
            console.log('🔍 管理员token:', !!isAdminLoggedIn);
            console.log('🔍 访客状态:', isGuestLoggedIn);
            
            if (isGuestLoggedIn && !isAdminLoggedIn) {
                console.log('✅ 检测到访客登录，初始化访客仪表板...');
                
                // 检查是否为快速访问模式
                const isQuickAccess = guestAuthService.isQuickAccessMode();
                if (isQuickAccess) {
                    console.log('📊 快速访问模式 - 进入只读数据查看');
                }
                
                const guestDashboard = new GuestDashboard();
                guestDashboard.init();
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
        window.isQuickAccessModeOnInit = isQuickAccessMode;  // 保存状态用于调试
        console.log('🔍 DEBUG: isQuickAccessMode =', isQuickAccessMode);
        
        if (isQuickAccessMode) {
            console.log('🎯 快速访问模式 - 启用后备数据渲染');
            window.backupRendererScheduled = true;
            setTimeout(() => {
                window.backupRendererExecuted = true;
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
