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

console.log('✅ main.js 模块加载开始');

document.addEventListener('DOMContentLoaded', async () => {
    console.log('✅ DOMContentLoaded 事件触发');
    
    try {
        document.body.classList.add('loaded');
        
        // 0. 🔐 初始化路由与认证系统 (必须最先执行)
        console.log('🔧 Router 初始化中...');
        await router.init();
        router.setupAll();
        console.log('✅ Router 初始化完成');
        
        // 1. UI 初始化 (它会自动处理侧边栏点击切换)
        console.log('🔧 UIHelper.setupNavigation 调用中...');
        UIHelper.setupNavigation();
        console.log('✅ UIHelper.setupNavigation 完成');

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

        // 4. 看板快速导出功能
        console.log('🔧 绑定导出按钮事件...');
        document.getElementById('btnExportDashboard')?.addEventListener('click', () => {
            ExportService.generatePDF('dashboard', '食品安全日报');
        });
        console.log('✅ 导出按钮事件绑定完成');

        // 5. 初始化数据导出报告模块
        console.log('🔧 ExportService 初始化中...');
        try {
            const exportService = new ExportService();
            exportService.init();
            console.log('✅ ExportService 初始化成功');
        } catch (error) {
            console.error('❌ ExportService 初始化失败:', error);
        }

        // 6. ✨ 初始化用户管理模块 (仅管理员可访问)
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

        // 7. ✨ 初始化审计日志模块 (仅管理员可访问)
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

        // 8. ✨ 初始化访客管理模块 (仅管理员可访问)
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

        // 9. ✨ 初始化会话管理 (针对所有用户)
        console.log('🔧 SessionManager 初始化中...');
        try {
            sessionManager.init();
            console.log('✅ SessionManager 初始化成功');
        } catch (error) {
            console.error('❌ SessionManager 初始化失败:', error);
        }
        
        console.log('✅✅✅ 所有模块初始化完成！');
    } catch (error) {
        console.error('❌❌❌ DOMContentLoaded 中发生错误:', error);
        console.error('Stack:', error.stack);
    }
});
