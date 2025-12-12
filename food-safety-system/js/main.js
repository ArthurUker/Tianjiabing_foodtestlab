import { UIHelper } from './utils/UIHelper.js';
import { initTableware } from './modules/Tableware.js';
import { GenericTestModule } from './modules/GenericTest.js';
import { initPathogen } from './modules/Pathogen.js';
import { initDashboard } from './modules/Dashboard.js';
import { ExportService } from './services/ExportService.js';

document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('loaded');
    
    // 1. UI 初始化
    UIHelper.setupNavigation();

    // 2. 业务模块初始化
    initTableware();
    initPathogen();
    
    new GenericTestModule({ moduleName: 'pesticide', formId: 'pesticideTestForm', tableId: 'pesticideRecords' });
    new GenericTestModule({ moduleName: 'oil', formId: 'oilTestForm', tableId: 'oilRecords' });
    new GenericTestModule({ moduleName: 'leanMeat', formId: 'leanMeatTestForm', tableId: 'leanMeatRecords' });

    // 3. 看板初始化
    initDashboard();

    // 4. 看板快速导出功能
    document.getElementById('btnExportDashboard')?.addEventListener('click', () => {
        ExportService.generatePDF('dashboard', '食品安全日报');
    });

    // 5. 初始化数据导出报告模块 - 重点检查这里！
    try {
        const exportService = new ExportService();
        exportService.init();
        console.log('✅ ExportService 初始化成功');
    } catch (error) {
        console.error('❌ ExportService 初始化失败:', error);
    }
});
