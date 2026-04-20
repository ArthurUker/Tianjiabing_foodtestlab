import { UIHelper } from './utils/UIHelper.js';
import { initTableware } from './modules/Tableware.js';
import { GenericTestModule } from './modules/GenericTest.js';
import { initPathogen } from './modules/Pathogen.js';
import { initDashboard } from './modules/Dashboard.js';
import { ExportService } from './services/ExportService.js';
// 1. ✨ 引入新模块
import { BackupRestoreService } from './modules/BackupRestore.js';

console.log('✅ main.js 模块加载开始');

document.addEventListener('DOMContentLoaded', () => {
    console.log('✅ DOMContentLoaded 事件触发');
    
    try {
        document.body.classList.add('loaded');
        
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

        // 6. ✨ 初始化数据备份模块
        console.log('🔧 BackupRestoreService 初始化中...');
        try {
            const backupService = new BackupRestoreService();
            backupService.init();
            console.log('✅ BackupRestoreService 初始化成功');
        } catch (error) {
            console.error('❌ BackupRestoreService 初始化失败:', error);
        }
        
        console.log('✅✅✅ 所有模块初始化完成！');
    } catch (error) {
        console.error('❌❌❌ DOMContentLoaded 中发生错误:', error);
        console.error('Stack:', error.stack);
    }
});
