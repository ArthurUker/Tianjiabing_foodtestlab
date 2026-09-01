/**
 * 身份认证服务模块 (Authentication Service)
 * 负责处理用户身份识别和敏感操作的权限校验
 */
// TD-TenantIsolation：认证态 key 已按学校命名空间隔离，读取需拼 schoolCode 前缀
import { extractSchoolCode } from '../utils/schoolCode.js';
// P1-2: 原生 confirm() 在 iframe 预览（index.html?preview=true）下会被浏览器禁用，
// 统一改用自定义 UINotification.confirm（Promise 风格，iframe 下可正常点击确定/取消）
import { UINotification } from '../utils/UINotification.js';

export class OperationGuard {
    /**
     * 核心功能：敏感操作权限控制
     * - 删除操作：弹出二次确认对话框，确认后执行
     * - 编辑操作：直接执行（已通过用户管理系统鉴权）
     * P1-2: 由同步 confirm() 改为异步 UINotification.confirm（返回 Promise），
     * 调用方需 await（已在全部 6 处调用点改造）。返回值语义不变：
     * 用户确认 → 执行 onSuccess；取消 → 不执行。
     * @param {string} actionName - 操作名称（如"删除记录"、"编辑数据"）
     * @param {Function} onSuccess - 验证通过后的回调函数，参数为当前用户名
     * @returns {Promise<void>}
     */
    async verify(actionName, onSuccess) {
        const isDelete = actionName.includes('删除');
        if (isDelete) {
            const ok = await UINotification.confirm(`确定要${actionName}吗？此操作不可撤销。`, '操作确认');
            if (!ok) return;
        }
        onSuccess(this.getCurrentUser());
    }

    /**
     * 获取当前登录用户的显示名称
     */
    getCurrentUser() {
        try {
            // TD-TenantIsolation：按当前学校命名空间读取用户信息；
            // 兼容旧版未命名空间的 'current_user' 键（升级期间两键并存）
            const code = extractSchoolCode() || '';
            const scopedKey = code ? `current_user__${code}` : 'current_user';
            const raw = localStorage.getItem(scopedKey) || localStorage.getItem('current_user');
            if (!raw) return '未知用户';
            const user = JSON.parse(raw);
            return user.fullName || user.username || '未知用户';
        } catch {
            return '未知用户';
        }
    }
}

// 导出单例对象，确保整个应用共用同一个认证状态
export const operationGuard = new OperationGuard();