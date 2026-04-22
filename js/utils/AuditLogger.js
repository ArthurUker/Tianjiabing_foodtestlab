/**
 * AuditLogger - 用户操作日志工具
 * 将每次用户操作记录到 localStorage，按天存储
 * Key 格式：audit_YYYY-MM-DD
 * 最多保留 30 天日志
 */

const MAX_DAYS = 30;

function getTodayKey() {
    return 'audit_' + new Date().toISOString().slice(0, 10);
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
 * 记录一条操作日志
 * @param {string} action     - 操作类型：login / logout / create / update / delete / export
 * @param {string} module     - 模块名称：tableware / pesticide / oil / leanMeat / pathogen / users / system
 * @param {string} detail     - 操作描述，如 "新增餐具记录 #123"
 */
export function logOperation(action, module, detail = '') {
    try {
        const key = getTodayKey();
        const existing = JSON.parse(localStorage.getItem(key) || '[]');

        existing.push({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            user: getCurrentUser(),
            action,
            module,
            detail,
            status: 'success'
        });

        localStorage.setItem(key, JSON.stringify(existing));
        _pruneOldLogs();
    } catch (e) {
        // 日志写入失败不影响主流程
        console.warn('[AuditLogger] 写入失败:', e.message);
    }
}

/**
 * 获取指定日期的日志列表
 * @param {string} dateStr - 'YYYY-MM-DD'，默认今天
 * @returns {Array}
 */
export function getLogsByDate(dateStr) {
    const key = 'audit_' + (dateStr || new Date().toISOString().slice(0, 10));
    try {
        return JSON.parse(localStorage.getItem(key) || '[]');
    } catch {
        return [];
    }
}

/**
 * 获取所有有日志的日期列表（降序）
 * @returns {string[]} - ['YYYY-MM-DD', ...]
 */
export function getAvailableDates() {
    const dates = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('audit_')) {
            dates.push(k.replace('audit_', ''));
        }
    }
    return dates.sort((a, b) => b.localeCompare(a));
}

/**
 * 清除所有日志（仅管理员操作时调用）
 */
export function clearAllLogs() {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('audit_')) keysToRemove.push(k);
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
}

/** 内部：清理超过 MAX_DAYS 的旧日志 */
function _pruneOldLogs() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

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
