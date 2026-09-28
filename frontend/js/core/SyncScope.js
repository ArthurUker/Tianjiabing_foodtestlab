// SyncScope.js — P3-W4-T01（AUD-001）同步作用域：本地缓存/离线队列一律按 tenant + subject + resource 隔离。
//
// 缺陷原状：缓存键 `cache_<table>`、队列键 `pending_<table>`、指纹键 `fingerprint_index_<table>`、
// 退避键 `app_sync_backoff_until` 都是**全局键**——不含学校（tenant）也不含账号（subject）。
// 同一浏览器切校/换账号后，新主体可读到旧主体缓存；A 校待上传的记录会被以 B 校凭据写入 B 校。
//
// 本模块提供唯一的作用域解析与键构造入口：
//   resolveSyncScope()          → { tenant, subjectId, subjectHash, scopeId }
//   buildScopedKeys(table, s)   → { cacheKey, queueKey, fingerprintKey, tombstoneKey, backoffKey }
//   quarantineLegacySyncKeys()  → 旧键**一次性隔离封存并记录**（不静默双读、不原地删除用户数据）
//
// 迁移口径（与任务包一致）：旧键不再被任何业务路径读取；首次升级时把旧键内容原样封存到
// `legacy_quarantine_v1__<原键>`，并写入 `sync_scope_migration_v2` 记录（含每键字节数/条目数与时间）。
// 之所以不做"迁移到当前主体"：旧数据的主体归属不可证明，若迁移给"当时登录的人"就是把 A 的数据
// 交给 B —— 与 AUD-001 的修复目标相冲突。封存保留数据、但从使用面彻底移除。
//
// 无外部依赖（除既有 schoolCode 解析），可在 jsdom / 浏览器 / 测试替身下运行。

import { extractSchoolCode } from '../utils/schoolCode.js';

export const SCOPE_SCHEMA_VERSION = 2;
export const NO_TENANT = '__no_tenant__';
export const ANON_SUBJECT = 'anonymous';

/** 旧键（无作用域）→ 需要隔离封存的对象；新键均含 `_v2__`，因此不会误伤自身。 */
export const SCOPE_MIGRATION_KEY = 'sync_scope_migration_v2';
export const QUARANTINE_PREFIX = 'legacy_quarantine_v1__';
export const SCOPE_VIOLATION_KEY = 'sync_scope_violations_v2';
export const SCOPE_VIOLATION_MAX = 200;

const LEGACY_EXACT_KEYS = new Set(['app_sync_backoff_until']);
const LEGACY_KEY_RE = /^(cache_|pending_|fingerprint_index_)([A-Za-z0-9_-]+)$/;

/** 稳定短哈希（FNV-1a 32bit，十六进制）—— 键名不落主体原始标识（避免 PII 进存储键）。 */
export function fnv1aHex(input) {
    const str = String(input == null ? '' : input);
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function safeStorage(store) {
    if (store) return store;
    try { return globalThis.localStorage || null; } catch { return null; }
}

function getItem(store, key) {
    try { return store ? store.getItem(key) : null; } catch { return null; }
}

function readJson(store, key) {
    const raw = getItem(store, key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

function fromUserObject(user) {
    if (!user || typeof user !== 'object') return null;
    return user.id || user.user_id || user.userId || user.username || user.name || null;
}

function fromJwtPayload(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return null;
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
        const json = decodeURIComponent(
            atob(b64 + pad).split('').map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`).join('')
        );
        const payload = JSON.parse(json);
        return payload.sub || payload.userId || payload.user_id || payload.username || payload.id || null;
    } catch {
        return null;
    }
}

/**
 * 解析当前主体的标识（账号维度）：优先用户对象（localStorage → sessionStorage），
 * 其次访客对象，最后回退解码本租户命名空间内的 token payload（仅用于缓存键派生，不做鉴权判定）。
 * @returns {{ subjectId: string|null, subjectSource: string }}
 */
export function resolveSubject({ storage, sessionStore, tenant } = {}) {
    const ls = safeStorage(storage);
    const ss = sessionStore || (() => { try { return globalThis.sessionStorage || null; } catch { return null; } })();
    const ns = tenant && tenant !== NO_TENANT ? `__${tenant}` : '';
    const candidates = [
        ['current_user', 'localStorage.current_user'],
        ['current_guest', 'localStorage.current_guest'],
    ];
    for (const [base, label] of candidates) {
        const fromLs = fromUserObject(readJson(ls, `${base}${ns}`)) || fromUserObject(readJson(ls, base));
        if (fromLs) return { subjectId: String(fromLs), subjectSource: label };
        const fromSs = fromUserObject(readJson(ss, `${base}${ns}`)) || fromUserObject(readJson(ss, base));
        if (fromSs) return { subjectId: String(fromSs), subjectSource: `${label}(session)` };
    }
    for (const tokenBase of ['auth_token', 'guest_token']) {
        const token = getItem(ls, `${tokenBase}${ns}`) || getItem(ss, `${tokenBase}${ns}`)
            || getItem(ls, tokenBase) || getItem(ss, tokenBase);
        const sub = fromJwtPayload(token);
        if (sub) return { subjectId: String(sub), subjectSource: `jwt:${tokenBase}` };
    }
    return { subjectId: null, subjectSource: 'none' };
}

/**
 * 解析同步作用域。tenant 取当前部署路径/查询参数的学校代码（与认证态命名空间同一来源）。
 * @returns {{ schemaVersion:number, tenant:string, subjectId:string, subjectHash:string, subjectSource:string, scopeId:string }}
 */
export function resolveSyncScope({ storage, sessionStore, pathname, search } = {}) {
    let tenant = null;
    try {
        tenant = extractSchoolCode(pathname, search);
    } catch {
        tenant = null;
    }
    if (!tenant) tenant = NO_TENANT;
    const { subjectId, subjectSource } = resolveSubject({ storage, sessionStore, tenant });
    const effectiveSubject = subjectId || ANON_SUBJECT;
    const subjectHash = fnv1aHex(`${tenant}|${effectiveSubject}`);
    return {
        schemaVersion: SCOPE_SCHEMA_VERSION,
        tenant,
        subjectId: effectiveSubject,
        subjectSource,
        subjectHash,
        scopeId: `${tenant}::${subjectHash}`,
    };
}

/**
 * 构造资源维度的全部存储键（tenant + subject + resource 三元组）。
 */
export function buildScopedKeys(tableName, scope) {
    const tenant = (scope && scope.tenant) || NO_TENANT;
    const subjectHash = (scope && scope.subjectHash) || fnv1aHex(ANON_SUBJECT);
    const res = String(tableName || 'unknown');
    const prefix = `v${SCOPE_SCHEMA_VERSION}__${tenant}__${subjectHash}`;
    return {
        scopeId: `${tenant}::${subjectHash}`,
        cacheKey: `cache_${prefix}__${res}`,
        queueKey: `pending_${prefix}__${res}`,
        fingerprintKey: `fingerprint_index_${prefix}__${res}`,
        tombstoneKey: `tombstones_${prefix}__${res}`,
        tempMapKey: `temp_map_${prefix}__${res}`,
        backoffKey: `app_sync_backoff_until__${prefix}`,
    };
}

export function isLegacySyncKey(key) {
    if (!key || typeof key !== 'string') return false;
    if (key.startsWith(QUARANTINE_PREFIX)) return false;
    if (key.includes(`_v${SCOPE_SCHEMA_VERSION}__`)) return false;    // 新键自身
    if (LEGACY_EXACT_KEYS.has(key)) return true;
    return LEGACY_KEY_RE.test(key);
}

/**
 * 旧键一次性隔离封存 + 记录（幂等：迁移记录已存在即不再执行）。
 * 封存失败（如配额不足）时保留原键并如实记录 `quarantine_failed`，不静默丢数据。
 * @returns {{ ran:boolean, record:object|null, discarded:Array }}
 */
export function quarantineLegacySyncKeys({ storage, scope } = {}) {
    const ls = safeStorage(storage);
    if (!ls) return { ran: false, record: null, discarded: [] };
    const existing = readJson(ls, SCOPE_MIGRATION_KEY);
    if (existing && Number(existing.schemaVersion) >= SCOPE_SCHEMA_VERSION) {
        return { ran: false, record: existing, discarded: existing.discardedLegacyKeys || [] };
    }
    const legacyKeys = [];
    try {
        for (let i = 0; i < ls.length; i++) {
            const key = ls.key(i);
            if (isLegacySyncKey(key)) legacyKeys.push(key);
        }
    } catch { /* 枚举失败则不迁移（不得凭猜测删除） */ }

    const discarded = [];
    const failed = [];
    for (const key of legacyKeys.sort()) {
        const raw = getItem(ls, key);
        let items = null;
        try {
            const parsed = raw ? JSON.parse(raw) : null;
            items = Array.isArray(parsed) ? parsed.length : (parsed && Array.isArray(parsed.data) ? parsed.data.length : null);
        } catch { items = null; }
        try {
            ls.setItem(QUARANTINE_PREFIX + key, raw == null ? '' : raw);
        } catch (e) {
            failed.push({ key, reason: 'quarantine_write_failed', bytes: raw ? raw.length : 0 });
            continue;   // 封存失败 → 保留原键（数据优先），业务侧同样不读
        }
        try { ls.removeItem(key); } catch { /* 移除失败则原键仍在，但业务侧不读 */ }
        discarded.push({ key, bytes: raw ? raw.length : 0, items });
    }

    const record = {
        schemaVersion: SCOPE_SCHEMA_VERSION,
        migratedAt: new Date().toISOString(),
        policy: 'one-time-quarantine-no-dual-read',
        scopeAtMigration: scope ? { tenant: scope.tenant, subjectHash: scope.subjectHash } : null,
        discardedLegacyKeys: discarded,
        quarantineFailed: failed,
    };
    try { ls.setItem(SCOPE_MIGRATION_KEY, JSON.stringify(record)); } catch { /* 记录失败不影响隔离本身 */ }
    return { ran: true, record, discarded };
}

/** 记录一次"作用域不匹配"的任务隔离（AUD-001：身份切换后旧任务不得以新主体身份上传）。 */
export function recordScopeViolation({ storage, item, reason } = {}) {
    const ls = safeStorage(storage);
    if (!ls) return;
    let list = [];
    try { list = JSON.parse(getItem(ls, SCOPE_VIOLATION_KEY) || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    list.push({
        at: new Date().toISOString(),
        reason: reason || 'scope_mismatch',
        requestId: item ? item.id : null,
        requestType: item ? item.type : null,
        taskScope: item ? item.scope : null,
        recordId: item ? (item.recordId || item.tempId || null) : null,
    });
    try { ls.setItem(SCOPE_VIOLATION_KEY, JSON.stringify(list.slice(-SCOPE_VIOLATION_MAX))); } catch { /* 记录失败不影响隔离 */ }
}
