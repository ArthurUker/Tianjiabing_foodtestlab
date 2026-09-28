// SyncStateMachine.js — P3-W4-T01（AUD-021 + AUD-022）客户端同步状态机与合并语义（纯函数，无副作用）。
//
// 缺陷原状（AUD-021）：临时记录没有显式生命周期 —— create 出队/在途后的编辑只尝试合并"仍在队列里的
// create"，合并不到就静默丢弃；删除临时记录又被 _updateLocalCache 的 pending-merge 从旧存储里复活成幽灵行。
// 缺陷原状（AUD-022）：409 只带 serverVersion，客户端把 version 换成最新值后整量重放 —— 静默覆盖他人的更新。
//
// 本模块给出唯一写入路径所需的显式状态机 + 结构化队列表述 + 三路合并：
//   TEMP_CREATED → EDITING_PENDING → SYNCING → SYNCED / FAILED / CONFLICT / DELETED

export const SYNC_STATES = Object.freeze({
    TEMP_CREATED: 'TEMP_CREATED',         // 本地新建（temp id），未入队发送
    EDITING_PENDING: 'EDITING_PENDING',   // 有未确认的本地改动，等待发送
    SYNCING: 'SYNCING',                   // 在途（create/update/delete 请求已发出）
    SYNCED: 'SYNCED',                     // 与服务端基线一致
    FAILED: 'FAILED',                     // 明确失败（权限/网络/重试耗尽），需用户重试或编辑
    CONFLICT: 'CONFLICT',                 // 显式冲突态：需用户裁决（禁止静默覆盖/自动重放）
    DELETED: 'DELETED',                   // 已删除（终态；墓碑阻止复活）
});

export const SYNC_EVENTS = Object.freeze({
    SAVE: 'SAVE',
    EDIT: 'EDIT',
    SEND_START: 'SEND_START',
    SEND_OK: 'SEND_OK',
    SEND_FAIL: 'SEND_FAIL',
    SEND_CONFLICT: 'SEND_CONFLICT',
    DELETE_SEND_START: 'DELETE_SEND_START',
    DELETE_OK: 'DELETE_OK',
    REBASE: 'REBASE',
    DELETE: 'DELETE',
});

export const QUEUE_SCHEMA_VERSION = 2;

const ALL_STATES = Object.values(SYNC_STATES);

/** 显式转移表：`from` 之外的状态收到该事件 → 非法转移（记录拒绝原因，不静默吞掉）。 */
export const TRANSITIONS = Object.freeze({
    [SYNC_EVENTS.SAVE]: { from: [null, undefined, SYNC_STATES.SYNCED, SYNC_STATES.FAILED, SYNC_STATES.CONFLICT, SYNC_STATES.DELETED], to: SYNC_STATES.TEMP_CREATED },
    [SYNC_EVENTS.EDIT]: { from: [SYNC_STATES.TEMP_CREATED, SYNC_STATES.EDITING_PENDING, SYNC_STATES.SYNCING, SYNC_STATES.SYNCED, SYNC_STATES.FAILED, SYNC_STATES.CONFLICT], to: SYNC_STATES.EDITING_PENDING },
    // 发送尝试允许从"未确认"的任一状态发起（TEMP_CREATED/EDITING_PENDING 为普通入队即发送的路径），
    // 其三种结局（OK/FAIL/CONFLICT）因此也必须能从这些状态落脚 —— 否则会把合法时序误报为非法转移。
    [SYNC_EVENTS.SEND_START]: { from: [SYNC_STATES.TEMP_CREATED, SYNC_STATES.EDITING_PENDING, SYNC_STATES.SYNCING, SYNC_STATES.FAILED, SYNC_STATES.CONFLICT], to: SYNC_STATES.SYNCING },
    [SYNC_EVENTS.SEND_OK]: { from: [SYNC_STATES.SYNCING, SYNC_STATES.TEMP_CREATED, SYNC_STATES.EDITING_PENDING, SYNC_STATES.FAILED, SYNC_STATES.CONFLICT], to: SYNC_STATES.SYNCED },
    [SYNC_EVENTS.SEND_FAIL]: { from: [SYNC_STATES.SYNCING, SYNC_STATES.TEMP_CREATED, SYNC_STATES.EDITING_PENDING], to: SYNC_STATES.FAILED },
    [SYNC_EVENTS.SEND_CONFLICT]: { from: [SYNC_STATES.SYNCING, SYNC_STATES.TEMP_CREATED, SYNC_STATES.EDITING_PENDING, SYNC_STATES.FAILED], to: SYNC_STATES.CONFLICT },
    [SYNC_EVENTS.DELETE_SEND_START]: { from: [SYNC_STATES.SYNCED, SYNC_STATES.EDITING_PENDING, SYNC_STATES.FAILED, SYNC_STATES.CONFLICT], to: SYNC_STATES.SYNCING },
    [SYNC_EVENTS.DELETE_OK]: { from: [SYNC_STATES.SYNCING, SYNC_STATES.TEMP_CREATED, SYNC_STATES.EDITING_PENDING, SYNC_STATES.FAILED, SYNC_STATES.CONFLICT], to: SYNC_STATES.DELETED },
    [SYNC_EVENTS.REBASE]: { from: [SYNC_STATES.SYNCING, SYNC_STATES.FAILED, SYNC_STATES.CONFLICT], to: SYNC_STATES.EDITING_PENDING },
    [SYNC_EVENTS.DELETE]: { from: ALL_STATES, to: SYNC_STATES.DELETED },
});

/**
 * 应用一次显式状态转移。
 * @returns {{ ok:boolean, state:string, previous:(string|null), event:string, rejected:boolean }}
 */
export function applyTransition(current, event) {
    const rule = TRANSITIONS[event];
    const previous = current === undefined ? null : current;
    if (!rule) return { ok: false, state: previous, previous, event, rejected: true };
    if (!rule.from.includes(previous)) return { ok: false, state: previous, previous, event, rejected: true };
    return { ok: true, state: rule.to, previous, event, rejected: false };
}

/** 队列快照：`{ schemaVersion, items[] }`；旧结构（裸数组/未知版本）一律判为需要一次性迁移。 */
export function normalizeQueueSnapshot(raw) {
    if (raw === undefined || raw === null || raw === '') {
        return { ok: true, items: [], version: QUEUE_SCHEMA_VERSION, legacy: false, reason: null };
    }
    let parsed = raw;
    if (typeof raw === 'string') {
        try { parsed = JSON.parse(raw); } catch { return { ok: false, items: [], legacy: true, reason: 'unparsable' }; }
    }
    if (Array.isArray(parsed)) return { ok: false, items: [], legacy: true, reason: 'legacy_array_schema' };
    if (!parsed || typeof parsed !== 'object') return { ok: false, items: [], legacy: true, reason: 'not_object' };
    if (Number(parsed.schemaVersion) !== QUEUE_SCHEMA_VERSION || !Array.isArray(parsed.items)) {
        return { ok: false, items: [], legacy: true, reason: `unknown_schema_version:${parsed.schemaVersion}` };
    }
    return { ok: true, items: parsed.items, version: QUEUE_SCHEMA_VERSION, legacy: false, reason: null };
}

export function serializeQueueSnapshot(items) {
    return JSON.stringify({ schemaVersion: QUEUE_SCHEMA_VERSION, items: Array.isArray(items) ? items : [] });
}

/** 服务端控制字段：不参与三路合并（由服务端权威决定或本地状态机维护）。 */
export const CONTROL_FIELDS = Object.freeze(new Set([
    'id', 'version', 'record_code', 'test_type', 'test_name', 'status',
    'created_at', 'updated_at', 'createdAt', 'updatedAt',
    '_status', '_syncState', '_conflict', '_base', '_pendingAfterCreate', '_scope',
    'sync_time', 'last_sync_at',
    // 传输/协议控制字段（AUD-022）：不参与业务字段合并
    'base_version', 'base_updated_at', 'expected_updated_at', 'result_data_mode', 'idempotencyKey',
]));

export function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((v, i) => deepEqual(v, b[i]));
    }
    if (typeof a !== 'object') return false;
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/**
 * 字段级三路合并（base = 本地已同步基线快照，local = 本地当前值，server = 服务端 latest）。
 * 规则：
 *   local === server            → 取该值（双方一致）
 *   base   === local            → 仅服务端改 → 采用服务端值
 *   base   === server           → 仅本地改 → 保留本地值
 *   双方都改且不同（对象可再拆） → 递归合并；叶子字段双方都改且不同 → **显式冲突**
 * 返回 conflicts 为空时，才是"可安全自动重基"的写回；否则必须进入 CONFLICT 态请用户裁决。
 */
export function threeWayMergeRecords({ base = {}, local = {}, server = {}, ignoreKeys = CONTROL_FIELDS } = {}) {
    const b0 = isPlainObject(base) ? base : {};
    const l0 = isPlainObject(local) ? local : {};
    const s0 = isPlainObject(server) ? server : {};
    const conflicts = [];
    const appliedFields = [];
    const adoptedFields = [];
    const merged = { ...s0 };
    const keys = new Set([...Object.keys(b0), ...Object.keys(l0), ...Object.keys(s0)]);

    for (const key of keys) {
        if (ignoreKeys.has(key)) continue;
        const b = b0[key]; const l = l0[key]; const s = s0[key];
        if (deepEqual(l, s)) {
            if (l === undefined) delete merged[key];
            else merged[key] = l;
            continue;
        }
        if (deepEqual(b, l)) {                       // 仅服务端改
            if (s === undefined) delete merged[key];
            else merged[key] = s;
            adoptedFields.push(key);
            continue;
        }
        if (deepEqual(b, s)) {                       // 仅本地改
            if (l === undefined) delete merged[key];
            else merged[key] = l;
            appliedFields.push(key);
            continue;
        }
        if (isPlainObject(l) && isPlainObject(s)) {  // 双方都改 → 下钻
            const nested = threeWayMergeRecords({
                base: isPlainObject(b) ? b : {},
                local: l,
                server: s,
                ignoreKeys: new Set(),
            });
            merged[key] = nested.merged;
            appliedFields.push(...nested.appliedFields.map((f) => `${key}.${f}`));
            adoptedFields.push(...nested.adoptedFields.map((f) => `${key}.${f}`));
            conflicts.push(...nested.conflicts.map((c) => ({ ...c, field: `${key}.${c.field}` })));
            continue;
        }
        // 双方都改且不同（或结构不可分解）→ 冲突：保留本地值以便用户裁决，绝不用本地覆盖服务端落库
        merged[key] = l;
        conflicts.push({ field: key, base: b === undefined ? null : b, local: l === undefined ? null : l, server: s === undefined ? null : s });
    }
    return { merged, conflicts, appliedFields, adoptedFields };
}

/** 把 CONFLICT 附件压缩成可持久化的安全结构（去重字段名 + 摘要）。 */
export function summarizeConflict({ reason, fields = [], base = null, local = null, server = null, capturedAt = null } = {}) {
    return {
        reason: reason || 'unknown',
        fields: Array.from(new Set(fields)),
        base,
        local,
        server,
        capturedAt: capturedAt || new Date().toISOString(),
    };
}
