import { UIHelper } from './utils/UIHelper.js';
import { initTableware } from './modules/Tableware.js';
import { GenericTestModule } from './modules/GenericTest.js';
import { initPathogen } from './modules/Pathogen.js';
import { initDashboard } from './modules/Dashboard.js';
import { ExportService } from './services/ExportService.js';
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
// 6. ✨ 引入访客管理模块
import { initGuestManagement } from './modules/GuestManagement.js';
// 7. ✨ 引入会话管理服务
import { sessionManager } from './services/SessionManager.js';
// 8. ✨ 引入访客认证服务
import { GuestAuthService } from './services/GuestAuthService.js';
// 9. ✨ 引入访客中心模块
import { GuestDashboard } from './modules/GuestDashboard.js';
// 10. ✨ 引入导出申请审批模块
import { ExportApproval } from './modules/ExportApproval.js';

console.log('✅ main.js 模块加载开始');

document.addEventListener('DOMContentLoaded', async () => {
    console.log('✅ DOMContentLoaded 事件触发');
    
    try {
        document.body.classList.add('loaded');
        
        // 🎯 检查是否为快速访问模式 (从 URL 参数或 localStorage 读取)
        const urlParams = new URLSearchParams(window.location.search);
        const isQuickAccessParam = urlParams.get('quickAccess') === 'true';
        
        // 也检查 localStorage (备选方案)
        const guestAuthService = new GuestAuthService();
        const isQuickAccessStorage = guestAuthService.isQuickAccessMode();
        
        const isQuickAccessMode = isQuickAccessParam || isQuickAccessStorage;
        console.log('🔍 URL参数quickAccess:', isQuickAccessParam);
        console.log('🔍 localStorage is_quick_access:', isQuickAccessStorage);
        console.log('🔍 最终快速访问模式:', isQuickAccessMode);
        
        // 0. 🔐 初始化路由与认证系统 (必须最先执行)
        console.log('🔧 Router 初始化中...');
        await router.init();
        router.setupAll();
        console.log('✅ Router 初始化完成');
        
        // 1. UI 初始化 (它会自动处理侧边栏点击切换)
        console.log('🔧 UIHelper.setupNavigation 调用中...');
        UIHelper.setupNavigation();
        console.log('✅ UIHelper.setupNavigation 完成');
        
        // 🎯 快速访问模式：隐藏管理功能菜单 (必须在 UIHelper.setupNavigation 之后执行)
        if (isQuickAccessMode) {
            console.log('� ========== 快速访问模式激活 - 开始隐藏菜单 ==========');
            
            // 方法1: 使用内联 CSS 样式 (使用 !important)
            const style = document.createElement('style');
            style.textContent = `
                button[data-target="export-data"],
                button[data-target="backup-restore"],
                button[data-admin-only],
                div[data-admin-only],
                #btnExportDashboard {
                    display: none !important;
                }
                div.text-xs.text-gray-400.font-semibold {
                    display: none !important;
                }
            `;
            document.head.appendChild(style);
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
        initDashboard();
        console.log('✅ initDashboard 完成');

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

        // 6. ✨ 初始化用户管理模块 (仅管理员可访问)
        if (!isQuickAccessMode) {
            console.log('🔧 UserManagement 初始化中...');
            try {
                if (router.isAdmin()) {
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

        // 8. ✨ 初始化访客管理模块 (仅管理员可访问，快速访问模式下跳过)
        if (!isQuickAccessMode) {
            console.log('🔧 GuestManagement 初始化中...');
            try {
                if (router.isAdmin()) {
                    initGuestManagement();
                    console.log('✅ GuestManagement 初始化成功');
                } else {
                    console.log('⚠️ 当前用户无权访问访客管理模块');
                }
            } catch (error) {
                console.error('❌ GuestManagement 初始化失败:', error);
            }
        }

        // 9. ✨ 初始化会话管理 (针对所有用户)
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
            const guestAuthService = new GuestAuthService();
            if (guestAuthService.isLoggedIn()) {
                console.log('✅ 检测到访客登录，初始化访客仪表板...');
                
                // 检查是否为快速访问模式
                const isQuickAccess = guestAuthService.isQuickAccessMode();
                if (isQuickAccess) {
                    console.log('📊 快速访问模式 - 进入只读数据查看');
                }
                
                const guestDashboard = new GuestDashboard();
                guestDashboard.renderUI();
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

        // 11. ✨ 初始化导出申请审批界面 (仅管理员可访问，快速访问模式下跳过)
        if (!isQuickAccessMode) {
            console.log('🔧 ExportApproval 初始化中...');
            try {
                if (router.isAdmin()) {
                    const exportApproval = new ExportApproval();
                    exportApproval.init();
                    console.log('✅ ExportApproval 初始化成功');
                } else {
                    console.log('⚠️ 当前用户无权访问导出申请审批模块');
                }
            } catch (error) {
                console.error('❌ ExportApproval 初始化失败:', error);
            }
        }
        
        console.log('✅✅✅ 所有模块初始化完成！');
    } catch (error) {
        console.error('❌❌❌ DOMContentLoaded 中发生错误:', error);
        console.error('Stack:', error.stack);
    }
});
