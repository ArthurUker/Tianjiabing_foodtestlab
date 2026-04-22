/**
 * 身份认证服务模块 (Authentication Service)
 * 负责处理用户身份识别和敏感操作的权限校验
 */
export class AuthService {
    /**
     * 核心功能：敏感操作权限控制
     * - 删除操作：弹出二次确认对话框，确认后执行
     * - 编辑操作：直接执行（已通过用户管理系统鉴权）
     * @param {string} actionName - 操作名称（如"删除记录"、"编辑数据"）
     * @param {Function} onSuccess - 验证通过后的回调函数，参数为当前用户名
     */
    verify(actionName, onSuccess) {
        const isDelete = actionName.includes('删除');
        if (isDelete) {
            if (!confirm(`确定要${actionName}吗？此操作不可撤销。`)) return;
        }
        onSuccess(this.getCurrentUser());
    }

    /**
     * 获取当前登录用户的显示名称
     */
    getCurrentUser() {
        try {
            const raw = localStorage.getItem('current_user');
            if (!raw) return '未知用户';
            const user = JSON.parse(raw);
            return user.fullName || user.username || '未知用户';
        } catch {
            return '未知用户';
        }
    }
}

// 导出单例对象，确保整个应用共用同一个认证状态
export const auth = new AuthService();