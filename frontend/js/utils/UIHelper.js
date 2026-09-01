export class UIHelper {
    static setupNavigation() {
        console.log('🔧 UIHelper.setupNavigation() - 开始设置导航');
        
        // 获取所有导航按钮
        const navButtons = document.querySelectorAll('.nav-btn');
        const contentSections = document.querySelectorAll('.content-section');
        
        console.log(`✅ 发现 ${navButtons.length} 个导航按钮，${contentSections.length} 个内容区域`);
        
        if (navButtons.length === 0) {
            console.error('❌ 没有找到任何导航按钮');
            return;
        }
        
        // 为每个导航按钮添加点击事件监听器
        navButtons.forEach((button) => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                
                const targetId = button.getAttribute('data-target');
                console.log(`📍 点击导航，目标: ${targetId}`);
                
                if (!targetId) {
                    console.warn('⚠️ 按钮没有 data-target 属性');
                    return;
                }
                
                // 移除所有按钮的激活样式
                navButtons.forEach((btn) => {
                    btn.classList.remove('active', 'bg-blue-700');
                });
                
                // 隐藏所有内容区域
                contentSections.forEach((section) => {
                    section.classList.add('hidden');
                });
                
                // 添加当前按钮的激活样式
                button.classList.add('active', 'bg-blue-700');
                
                // 显示目标内容区域
                const targetSection = document.getElementById(targetId);
                if (targetSection) {
                    targetSection.classList.remove('hidden');
                    // 切换到对应模块后，页面回到默认顶部
                    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
                    console.log(`✅ 显示内容区域: ${targetId}`);
                } else {
                    console.error(`❌ 无法找到内容区域: ${targetId}`);
                }
            });
        });
        
        console.log('✅ UIHelper.setupNavigation() - 导航设置完成');
    }
}
