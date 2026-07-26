/**
 * AuditLogger - 用户操作日志工具
 * 将每次用户操作记录到 localStorage，按天存储
 * Key 格式：audit_YYYY-MM-DD
 * 最多保留 30 天日志
 */

const MAX_DAYS = 30;

function getLocalDateStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getTodayKey() {
    // 使用 Asia/Shanghai 本地日期作为分组键，避免 UTC 日期导致跨天日志归错日（TD-Timezone-Chaos）
    return 'audit_' + getLocalDateStr();
}

function getCurrentUser() {
    try {
        const raw = localStorage.getItem('current_user');
        if (!raw) return '未知用户';
        const user = JSON.parse(raw);
        return user.fullName || user.username || '未知用户';
    } catch {
        return '未知用户';
    }
}

/**
 * 记录一条操作日志（TD-P2-13 收口：字段口径与后端 auditLog 模型一致）
 * @param {string} action        - 操作类型：login / logout / create / update / delete / export / import
 * @param {string} [resourceType] - 资源类型（对应后端 resource_type）：tableware_tests / user / auth / system ...
 * @param {string} [resourceId]   - 资源 ID（可选）
 * @param {string} [details]      - 操作详情（可选）
 */
export function logOperation(action, resourceType = null, resourceId = null, details = '', schoolCode = null) {
    try {
        const key = getTodayKey();
        const existing = JSON.parse(localStorage.getItem(key) || '[]');

        // RK44: 审计日志补充 school_code，便于多租户审计检索
        let userObj = null;
        try { userObj = JSON.parse(localStorage.getItem('current_user') || 'null'); } catch { /* ignore */ }
        const sc = schoolCode || (userObj && (userObj.schoolCode || userObj.school_code)) || '未知学校';

        existing.push({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            user: getCurrentUser(),
            school_code: sc,
            action,
            resource_type: resourceType,
            resource_id: resourceId,
            details,
            status: 'success'
        });

        localStorage.setItem(key, JSON.stringify(existing));
        _pruneOldLogs();
    } catch (e) {
        // 日志写入失败不影响主流程
        console.warn('[AuditLogger] 写入失败:', e.message);
    }
}

/** 内部：清理超过 MAX_DAYS 的旧日志 */
function _pruneOldLogs() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_DAYS);
    const cutoffStr = getLocalDateStr(cutoff);

    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('audit_')) {
            const dateStr = k.replace('audit_', '');
            if (dateStr < cutoffStr) keysToRemove.push(k);
        }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
}
