/**
 * AuditLogger - 用户操作日志工具
 * 将每次用户操作记录到 localStorage，按天存储
 * Key 格式：audit_YYYY-MM-DD
 * 最多保留 30 天日志
 */
// TD-TenantIsolation：认证态 key 已按学校命名空间隔离，读取需拼 schoolCode 前缀
import { extractSchoolCode } from './schoolCode.js';

const MAX_DAYS = 30;

// DS-16: 兜底脱敏——details 里若被调用方误拼入 JWT/手机号，落库前先打码，
// 避免敏感凭证/PII 持久化到 localStorage 审计日志。
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const CN_MOBILE_RE = /\b(1[3-9]\d)(\d{4})(\d{4})\b/g;

function sanitizeDetails(text) {
    if (typeof text !== 'string' || !text) return text;
    return text
        .replace(JWT_RE, (m) => m.slice(0, 6) + '…')
        .replace(CN_MOBILE_RE, (_, p1, _p2, p3) => `${p1}****${p3}`);
}

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
        // TD-TenantIsolation：按当前学校命名空间读取
        const code = extractSchoolCode() || '';
        const raw = localStorage.getItem(code ? `current_user__${code}` : 'current_user');
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
        try {
        const code = extractSchoolCode() || '';
        userObj = JSON.parse(localStorage.getItem(code ? `current_user__${code}` : 'current_user') || 'null');
    } catch { /* ignore */ }
        const sc = schoolCode || (userObj && (userObj.schoolCode || userObj.school_code)) || '未知学校';

        existing.push({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            user: getCurrentUser(),
            school_code: sc,
            action,
            resource_type: resourceType,
            resource_id: resourceId,
            details: sanitizeDetails(details),
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
