/**
 * 统一的用户界面通知管理系统
 * 提供成功、错误、警告、加载等多种通知方式
 * 
 * @example
 * UINotification.success('保存成功')
 * UINotification.error('操作失败: ' + error.message)
 * UINotification.warning('请注意')
 * 
 * const confirmed = await UINotification.confirm('确定删除?')
 */
export class UINotification {
    static defaultDuration = 3000
    
    /**
     * 显示通知
     * @param {string} message - 通知消息
     * @param {string} type - 通知类型: 'success'|'error'|'warning'|'info'
     * @param {number} duration - 显示时长(ms)，0 表示永不消失
     * @returns {HTMLElement} 通知元素
     */
    static show(message, type = 'info', duration = this.defaultDuration) {
        const notification = document.createElement('div')
        notification.className = `fixed top-4 right-4 px-4 py-3 rounded-lg shadow-lg text-white z-50 flex items-center gap-3 animate-fadeInRight ${this.getTypeClass(type)}`
        notification.innerHTML = `
            <i class="fas ${this.getIcon(type)} text-lg"></i>
            <div class="flex-1">${message}</div>
            <button class="ml-4 text-lg leading-none hover:opacity-80 transition" onclick="this.parentElement.remove()">×</button>
        `
        
        document.body.appendChild(notification)
        
        // 自动消失
        if (duration > 0) {
            setTimeout(() => {
                if (notification.parentElement) {
                    notification.remove()
                }
            }, duration)
        }
        
        return notification
    }
    
    /**
     * 成功通知
     */
    static success(message, duration = 3000) {
        return this.show(`✅ ${message}`, 'success', duration)
    }
    
    /**
     * 错误通知
     */
    static error(message, duration = 5000) {
        return this.show(`❌ ${message}`, 'error', duration)
    }
    
    /**
     * 警告通知
     */
    static warning(message, duration = 4000) {
        return this.show(`⚠️ ${message}`, 'warning', duration)
    }
    
    /**
     * 信息通知
     */
    static info(message, duration = 3000) {
        return this.show(`ℹ️ ${message}`, 'info', duration)
    }
    
    /**
     * 加载通知（永不消失，直到手动关闭）
     */
    static loading(message) {
        return this.show(
            `<i class="fas fa-spinner fa-spin mr-1"></i>${message}`, 
            'info', 
            0
        )
    }
    
    /**
     * 获取通知样式类
     */
    static getTypeClass(type) {
        const typeMap = {
            'success': 'bg-green-600 hover:bg-green-700',
            'error': 'bg-red-600 hover:bg-red-700',
            'warning': 'bg-yellow-600 hover:bg-yellow-700',
            'info': 'bg-blue-600 hover:bg-blue-700'
        }
        return typeMap[type] || typeMap['info']
    }
    
    /**
     * 获取通知图标
     */
    static getIcon(type) {
        const iconMap = {
            'success': 'fa-check-circle',
            'error': 'fa-exclamation-circle',
            'warning': 'fa-exclamation-triangle',
            'info': 'fa-info-circle'
        }
        return iconMap[type] || iconMap['info']
    }
    
    /**
     * 显示确认对话框
     * @param {string} message - 对话框消息
     * @param {string} title - 对话框标题
     * @returns {Promise<boolean>} 用户选择结果
     * 
     * @example
     * if (await UINotification.confirm('确定删除?')) {
     *     // 用户点击了确认
     * }
     */
    static async confirm(message, title = '确认') {
        return new Promise((resolve) => {
            const modal = document.createElement('div')
            modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center'
            modal.innerHTML = `
                <div class="bg-white rounded-lg shadow-xl p-6 max-w-md w-11/12 animate-scaleIn">
                    <h3 class="text-lg font-bold mb-3 text-gray-800">
                        <i class="fas fa-question-circle text-blue-600 mr-2"></i>${title}
                    </h3>
                    <p class="text-gray-700 mb-6">${message}</p>
                    <div class="flex justify-end gap-3">
                        <button class="px-4 py-2 bg-gray-300 text-gray-800 rounded hover:bg-gray-400 transition" id="btnCancel">
                            取消
                        </button>
                        <button class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition" id="btnConfirm">
                            确认
                        </button>
                    </div>
                </div>
            `
            
            document.body.appendChild(modal)
            
            const cleanup = () => modal.remove()
            
            document.getElementById('btnCancel').addEventListener('click', () => {
                cleanup()
                resolve(false)
            })
            
            document.getElementById('btnConfirm').addEventListener('click', () => {
                cleanup()
                resolve(true)
            })
            
            // ESC 键关闭
            const handleEsc = (e) => {
                if (e.key === 'Escape') {
                    document.removeEventListener('keydown', handleEsc)
                    cleanup()
                    resolve(false)
                }
            }
            document.addEventListener('keydown', handleEsc)
        })
    }
    
    /**
     * 显示输入对话框
     * @param {string} message - 提示消息
     * @param {string} title - 对话框标题
     * @param {string} defaultValue - 默认值
     * @returns {Promise<string|null>} 用户输入或 null
     */
    static async prompt(message, title = '输入', defaultValue = '') {
        return new Promise((resolve) => {
            const modal = document.createElement('div')
            modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center'
            modal.innerHTML = `
                <div class="bg-white rounded-lg shadow-xl p-6 max-w-md w-11/12 animate-scaleIn">
                    <h3 class="text-lg font-bold mb-3 text-gray-800">${title}</h3>
                    <p class="text-gray-700 mb-4">${message}</p>
                    <input type="text" id="promptInput" class="w-full border border-gray-300 rounded px-3 py-2 mb-6 focus:outline-none focus:border-blue-500" value="${defaultValue}">
                    <div class="flex justify-end gap-3">
                        <button class="px-4 py-2 bg-gray-300 text-gray-800 rounded hover:bg-gray-400 transition" id="btnCancel">取消</button>
                        <button class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition" id="btnConfirm">确认</button>
                    </div>
                </div>
            `
            
            document.body.appendChild(modal)
            const input = document.getElementById('promptInput')
            input.focus()
            
            const cleanup = () => modal.remove()
            
            const handleSubmit = () => {
                cleanup()
                resolve(input.value)
            }
            
            document.getElementById('btnCancel').addEventListener('click', () => {
                cleanup()
                resolve(null)
            })
            
            document.getElementById('btnConfirm').addEventListener('click', handleSubmit)
            
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') handleSubmit()
            })
        })
    }
    
    /**
     * 清空所有通知
     */
    static clearAll() {
        document.querySelectorAll('.fixed.top-4.right-4').forEach(el => el.remove())
    }
}

// 添加淡入淡出动画 CSS
if (!document.getElementById('notification-styles')) {
    const style = document.createElement('style')
    style.id = 'notification-styles'
    style.textContent = `
        @keyframes fadeInRight {
            from {
                opacity: 0;
                transform: translateX(20px);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }
        
        @keyframes scaleIn {
            from {
                opacity: 0;
                transform: scale(0.95);
            }
            to {
                opacity: 1;
                transform: scale(1);
            }
        }
        
        .animate-fadeInRight {
            animation: fadeInRight 0.3s ease-out;
        }
        
        .animate-scaleIn {
            animation: scaleIn 0.2s ease-out;
        }
    `
    document.head.appendChild(style)
}
