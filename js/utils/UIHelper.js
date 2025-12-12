export class UIHelper {
    static setupNavigation() {
        const navButtons = document.querySelectorAll('.nav-btn');
        const contentSections = document.querySelectorAll('.content-section');

        navButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-target');
                
                // 移除所有激活状态
                navButtons.forEach(b => b.classList.remove('active', 'bg-blue-700'));
                contentSections.forEach(section => section.classList.add('hidden'));
                
                // 激活当前按钮和对应内容
                btn.classList.add('active', 'bg-blue-700');
                const targetSection = document.getElementById(target);
                if (targetSection) {
                    targetSection.classList.remove('hidden');
                }
            });
        });
    }
}
