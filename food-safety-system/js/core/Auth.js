/**
 * 身份认证服务模块 (Authentication Service)
 * 负责处理用户身份识别和敏感操作的权限校验
 */
export class AuthService {
    constructor() {
        // 模拟当前登录用户，实际项目中应从 Session/Token 解析
        this.currentUser = "郭博(管理员)"; 
        // 模拟管理员密码
        this.adminPassword = "8888"; 
    }

    /**
     * 核心功能：请求敏感操作权限
     * @param {string} actionName - 操作名称（如"删除记录"、"编辑数据"）
     * @param {Function} onSuccess - 验证通过后的回调函数
     */
    verify(actionName, onSuccess) {
        // 简单的 Prompt 交互，后续可升级为漂亮的 Modal 弹窗
        const input = prompt(`【安全校验】\n您正在进行敏感操作：${actionName}\n请输入管理员密码以继续：`);

        if (input === this.adminPassword) {
            // 密码正确，执行回调，并将当前操作人传回去（用于记日志）
            onSuccess(this.currentUser);
        } else if (input !== null) {
            // 输入了密码但错误
            alert("❌ 验证失败：密码错误，拒绝操作。");
        }
        // 如果点击了取消 (input === null)，则静默失败，不执行任何操作
    }

    /**
     * 获取当前用户信息
     */
    getCurrentUser() {
        return this.currentUser;
    }
}

// 导出单例对象，确保整个应用共用同一个认证状态
export const auth = new AuthService();