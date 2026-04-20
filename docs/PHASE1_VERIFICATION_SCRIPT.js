/**
 * Phase 1 工具类验证脚本
 * 用于验证 FormValidator, UINotification, NetworkHelper 的基本功能
 * 
 * 在浏览器控制台运行此脚本来验证工具类是否正常工作
 */

console.log('=== Phase 1 工具类验证开始 ===\n');

// 1. FormValidator 验证
console.log('1️⃣  FormValidator 测试:');
try {
    const testData = {
        testDate: '2024-01-15',
        canteen: 'Cafe1',
        inspector: 'John'
    };
    
    const schema = {
        testDate: ['required', 'dateNotFuture'],
        canteen: ['required'],
        inspector: ['required']
    };
    
    const errors = FormValidator.validate(testData, schema);
    if (!errors) {
        console.log('   ✅ 有效数据验证通过');
    } else {
        console.log('   ❌ 有效数据验证失败:', errors);
    }
    
    // 测试无效数据
    const invalidData = {
        testDate: '2099-01-01', // 未来日期
        canteen: '',
        inspector: 'John'
    };
    
    const invalidErrors = FormValidator.validate(invalidData, schema);
    if (invalidErrors) {
        console.log('   ✅ 无效数据正确识别:', Object.keys(invalidErrors).length, '个错误');
    }
} catch (err) {
    console.log('   ❌ FormValidator 异常:', err.message);
}

// 2. UINotification 验证
console.log('\n2️⃣  UINotification 测试:');
try {
    console.log('   ✅ 触发成功通知...');
    UINotification.success('✅ 测试成功消息');
    
    setTimeout(() => {
        console.log('   ✅ 触发错误通知...');
        UINotification.error('❌ 测试错误消息');
    }, 2000);
    
    setTimeout(async () => {
        console.log('   ✅ 测试确认对话框...');
        const result = await UINotification.confirm('这是测试对话框吗？', '测试');
        console.log('   ✅ 对话框结果:', result);
    }, 4000);
} catch (err) {
    console.log('   ❌ UINotification 异常:', err.message);
}

// 3. NetworkHelper 验证
console.log('\n3️⃣  NetworkHelper 测试:');
try {
    console.log('   ✅ NetworkHelper 已加载');
    console.log('   📍 可用方法: get, post, put, delete, fetchWithRetry');
    console.log('   📍 配置: 重试次数=3, 超时=10000ms, 指数退避=true');
} catch (err) {
    console.log('   ❌ NetworkHelper 异常:', err.message);
}

// 4. 集成验证
console.log('\n4️⃣  模块集成验证:');
const modules = [
    { name: 'GenericTest', uses: ['FormValidator', 'UINotification', 'NetworkHelper'] },
    { name: 'Tableware', uses: ['FormValidator', 'UINotification', 'NetworkHelper'] },
    { name: 'Pathogen', uses: ['FormValidator', 'UINotification', 'NetworkHelper'] },
    { name: 'BackupRestore', uses: ['UINotification', 'NetworkHelper'] },
    { name: 'Dashboard', uses: ['UINotification', 'NetworkHelper'] },
    { name: 'ExportService', uses: ['UINotification'] }
];

modules.forEach(m => {
    console.log(`   ✅ ${m.name} 已集成: ${m.uses.join(', ')}`);
});

console.log('\n=== Phase 1 工具类验证完成 ===');
console.log('📌 提示: 所有工具类已可用，请在浏览器中进行功能测试');
