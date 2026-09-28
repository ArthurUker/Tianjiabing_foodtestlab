// 文件路径: core/Storage.js

import { auditService } from '../services/AuditService.js';
import { AdaptiveUploadQueue } from './AdaptiveUploadQueue.js';
// TD-TenantIsolation：认证态 key 已按学校命名空间隔离，读取需拼 schoolCode 前缀
import { extractSchoolCode } from '../utils/schoolCode.js';
// P3-W4-T01（AUD-001）：缓存/队列/指纹/退避键的唯一作用域入口（tenant + subject + resource）
import { resolveSyncScope, buildScopedKeys, quarantineLegacySyncKeys, recordScopeViolation } from './SyncScope.js';
// P3-W4-T01（AUD-021/AUD-022）：显式同步状态机 + 版本化队列 + 字段级三路合并
import { SYNC_STATES, SYNC_EVENTS, applyTransition, normalizeQueueSnapshot, serializeQueueSnapshot, threeWayMergeRecords, summarizeConflict, CONTROL_FIELDS } from './SyncStateMachine.js';

const DEFAULT_CONFIG = {
    apiBaseUrl: '/api/records',
    // A+B 修复（2026-09-14）：原为 200 —— 每次同步固定请求 ?limit=200&offset=0，
    // 服务端按 created_at desc 排序，导致单模块超过 200 条时更早的历史记录永远拉不到，
    // 看板/列表据此漏数据（田家炳补导后 leanMeat 481、pesticide 290、tableware 234）。
    // 提升到 1000（后端 MAX_RECORDS_LIMIT=2000 兜底）。若将来单模块逼近该值，
    // 应改为服务端聚合统计 + 分页拉取，而不是继续抬高此值（全量拉取会拖慢首屏）。
    maxSyncRows: 1000,
    syncCooldownMs: 30000,
    queueBatchSize: 5,
    queueBatchDelayMs: 400,
    minRetryDelayMs: 1000,
    maxRetryDelayMs: 30000,
    // 仅保留基名；实际键在构造时按 tenant+subject 作用域化（AUD-001）
    globalBackoffKey: 'app_sync_backoff_until',
    // AUD-022：409 后只允许"字段级三路合并无冲突"的自动重基，且每条任务最多 1 次预算
    autoRebaseBudget: 1
};

const TABLE_NAME_MAP = {
    leanMeat: 'leanMeat',
    oil: 'oil',
    pathogen: 'pathogen',
    pesticide: 'pesticide',
    tableware: 'tableware'
};

const SERVER_META_FIELDS = new Set([
    'record_code', 'test_type', 'test_name',
    'created_at', 'updated_at', 'completed_at',
    '_status'
]);

const VOLATILE_FIELDS = new Set([
    'id', '_status', 'status', 'record_code',
    'created_at', 'updated_at', 'createdAt', 'updatedAt',
    'sync_time', 'last_sync_at', 'modificationLogs',
    'recheckRecords', 'recheckReports', 'importTime',
    'importUser', 'lastModified',
    // P3-W4-T01：本地同步态的元字段（状态机/冲突附件/基线声明）不得进入内容指纹与三路合并
    '_syncState', '_base', '_conflict', 'base_version', 'base_updated_at',
]);

export class StorageService {
    constructor(tableName, config = {}) {
        this.tableName = tableName;
        this.apiBaseUrl = config.apiBaseUrl || DEFAULT_CONFIG.apiBaseUrl;
        this.maxSyncRows = config.maxSyncRows || DEFAULT_CONFIG.maxSyncRows;
        this.syncCooldownMs = config.syncCooldownMs || DEFAULT_CONFIG.syncCooldownMs;
        this.queueBatchSize = config.queueBatchSize || DEFAULT_CONFIG.queueBatchSize;
        this.queueBatchDelayMs = config.queueBatchDelayMs || DEFAULT_CONFIG.queueBatchDelayMs;
        this.minRetryDelayMs = config.minRetryDelayMs || DEFAULT_CONFIG.minRetryDelayMs;
        this.maxRetryDelayMs = config.maxRetryDelayMs || DEFAULT_CONFIG.maxRetryDelayMs;
        this.globalBackoffKey = config.globalBackoffKey || DEFAULT_CONFIG.globalBackoffKey;
        // AUD-022：409 后"字段级三路合并无冲突"才允许自动重基，且每条任务限 1 次预算
        this.autoRebaseBudget = Number.isInteger(config.autoRebaseBudget) ? config.autoRebaseBudget : DEFAULT_CONFIG.autoRebaseBudget;

        const dbTableName = TABLE_NAME_MAP[tableName] || tableName;
        this.apiEndpoint = `${this.apiBaseUrl}/${dbTableName}`;

        // ===== P3-W4-T01（AUD-001）：缓存/队列/指纹/墓碑/退避键一律按 tenant + subject + resource 作用域 =====
        // 作用域在构造时快照（tenant=学校 code；subject=用户/访客标识，回退 token payload）。
        // 旧键（cache_<table> 等）不再被任何路径读取 —— 首次升级时一次性隔离封存并记录（见 SyncScope.js）。
        this.syncScope = resolveSyncScope();
        this._scopeFingerprint = this.syncScope.scopeId;
        const scopedKeys = buildScopedKeys(tableName, this.syncScope);
        this.localCacheKey = scopedKeys.cacheKey;
        this.pendingRequestsKey = scopedKeys.queueKey;
        this.fingerprintIndexKey = scopedKeys.fingerprintKey;
        this.tombstoneKey = scopedKeys.tombstoneKey;
        this.tempMapKey = scopedKeys.tempMapKey;
        // 退避属于同步态：不得跨主体共享（否则一个主体的 429 会阻塞另一个主体）
        this.globalBackoffKey = scopedKeys.backoffKey;

        this.pendingTempIds = new Set();
        this.processingRequestIds = new Set();
        this.eventListeners = { error: [], sync: [] };
        this._lastSyncTime = 0;
        this._isProcessingQueue = false;
        this._queueTimer = null;
        this._serverFingerprintIndex = new Map();
        this._inFlightTempIds = new Set();      // AUD-021：create 在途的 tempId（出队后编辑要能追上）
        this._postCreateEdits = new Map();      // AUD-021：在途 create 的编辑（成功后转 update）
        this._postCreateDelete = new Set();     // AUD-021：在途 create 的删除意图（成功后删服务器行）
        // P3-W5-RECORD-T01（AUD-020 / RC-07）：本地缓存只是**分页窗口**，不是全量。
        // 覆盖范围元数据（returned/total/hasMore/partial）随缓存一起按 tenant+subject 作用域落盘，
        // 供看板/报告声明数据范围，禁止再把「?limit=maxSyncRows 的结果」称作完整。
        this._coverage = null;
        this._tombstones = new Set();           // AUD-021：已删除 id（阻止 pending-merge/同步复活）
        this._tombstonesLoaded = false;
        this._tempIdMap = new Map();            // temp id → server id（编辑转 update 的映射来源）
        this._tempIdMapLoaded = false;

        this._legacyMigration = quarantineLegacySyncKeys({ scope: this.syncScope });
        if (this._legacyMigration.ran && (this._legacyMigration.discarded || []).length) {
            console.warn(`[Storage:${tableName}] AUD-001 键作用域升级：已一次性隔离封存旧键 ${this._legacyMigration.discarded.length} 个（不迁移、不双读）`);
            this._emit('sync', { type: 'scope_migration', discarded: this._legacyMigration.discarded });
        }

        this._initializeLocalCache();

        this._uploadQueue = new AdaptiveUploadQueue({
            initialInterval: config.initialInterval || 800,
            minInterval: config.minInterval || 400,
            maxInterval: config.maxInterval || 15000,
            maxConcurrent: config.maxConcurrent || 1,
            getHeaders: () => this._getHeaders(),
            // P1-24: 传入 apiBaseUrl 回调，使队列请求跟随 StorageService 配置
            getBaseUrl: () => this.apiBaseUrl,
            onProgress: (status) => {
                if (status.isPaused) this._setGlobalBackoff(status.currentInterval);
                this._emit('sync', { type: 'queue_progress', status });
            }
        });

        setTimeout(() => this._processQueuedRequests(), 100);
    }

    getAll() {
        const cached = this._getLocalCacheData();
        this._syncFromApi().catch(e => console.error(`[${this.tableName}] Sync failed:`, e));
        return cached;
    }

    /** 供其它模块（导出/看板/快速访问）读取当前作用域，避免各自硬编码 `cache_<table>`（AUD-001 收口）。 */
    getSyncScope() {
        return { ...this.syncScope };
    }

    /** 当前作用域下的全部存储键（只读快照，供诊断与后续调用方迁移使用）。 */
    getStorageKeys() {
        return {
            cacheKey: this.localCacheKey,
            queueKey: this.pendingRequestsKey,
            fingerprintKey: this.fingerprintIndexKey,
            tombstoneKey: this.tombstoneKey,
            tempMapKey: this.tempMapKey,
            backoffKey: this.globalBackoffKey,
        };
    }

    // P1-14: 新增强制同步刷新方法，调用方需要最新数据时使用
    // 解决 getAll() 同步返回本地缓存导致数据一致性无保障的问题
    // 注意：getAll() 保留同步签名以兼容现有 ~30 处调用方，需服务端最新数据时改用 getAllFresh()
    async getAllFresh() {
        await this._syncFromApi(true);
        return this._getLocalCacheData();
    }

    save(data) {
        const clean = this._sanitizePayload(data || {});

        // 模块级本地去重：相同内容不重复入队
        const localDup = this._findLocalDuplicate(clean);
        if (localDup) {
            this._emit('sync', { type: 'local_dedupe_hit', record: localDup });
            return { ...localDup };
        }

        const tempId = `temp_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
        // 显式状态机入口：TEMP_CREATED（AUD-021）
        const tempRecord = { ...clean, id: tempId, _status: 'pending', _syncState: SYNC_STATES.TEMP_CREATED };

        this._addToLocalCache(tempRecord);
        this.pendingTempIds.add(tempId);

        this._addPendingRequest({
            id: this._genReqId('create'),
            type: 'create',
            state: SYNC_STATES.TEMP_CREATED,
            data: tempRecord,
            tempId,
            scope: this._scopeFingerprint,     // 任务归属快照：跨主体后不得以新主体凭据上传
            timestamp: Date.now(),
            retryCount: 0
        });

        this._processQueuedRequests();
        return tempRecord;
    }

    update(id, updatedData) {
        const cached = this._getLocalCacheData();
        const index = cached.findIndex(r => String(r.id) === String(id));
        if (index === -1) return false;

        const clean = this._sanitizePayload(updatedData || {});
        const localDup = this._findLocalDuplicate(clean, id);
        if (localDup) {
            // 更新内容与其他本地记录重复，保持当前记录不再继续上传，避免冲突刷屏
            this._emit('error', {
                request: { type: 'update', recordId: id },
                error: new Error('本地去重命中：与另一条记录内容相同，已跳过重复更新')
            });
            return false;
        }

        // AUD-022：保存"本地已同步基线"（三路合并的 base），并在载荷中声明重基基线
        const baseSnapshot = { ...cached[index] };
        const baseVersion = baseSnapshot.version ?? clean.version ?? null;
        const baseUpdatedAt = baseSnapshot.updated_at || baseSnapshot.updatedAt || null;
        cached[index] = {
            ...cached[index],
            ...clean,
            id,
            _status: 'updating',
            _syncState: SYNC_STATES.EDITING_PENDING,
            _base: this._baseSnapshotOf(baseSnapshot),
        };
        this._updateLocalCache(cached, { forceServer: true });

        if (this._isTempId(id)) {
            this._queueTempUpdate(id, clean);
        } else {
            this._addPendingRequest({
                id: this._genReqId('update'),
                type: 'update',
                state: SYNC_STATES.EDITING_PENDING,
                recordId: id,
                // version 保持既有 CAS 语义；base_version/base_updated_at 为 AUD-022 的显式重基声明
                data: this._withBaseDeclaration({ ...clean, version: baseVersion }, { version: baseVersion, updated_at: baseUpdatedAt }),
                base: { version: baseVersion, updatedAt: baseUpdatedAt },
                baseSnapshot: this._baseSnapshotOf(baseSnapshot),
                scope: this._scopeFingerprint,
                autoRebaseAttempts: 0,
                timestamp: Date.now(),
                retryCount: 0
            });
        }

        this._processQueuedRequests();
        return true;
    }

    delete(id) {
        const cached = this._getLocalCacheData();
        const index = cached.findIndex(r => String(r.id) === String(id));
        if (index === -1) return false;

        cached.splice(index, 1);
        // AUD-021：墓碑（删除后不得被 pending-merge / 全量同步复活成幽灵行）
        this._addTombstone(id);
        this._updateLocalCache(cached, { forceServer: true });

        if (this._isTempId(id)) {
            this.pendingTempIds.delete(id);
            if (this._inFlightTempIds.has(id)) {
                // create 已在途，无法撤回 → 保留 create 任务并标记"成功后立即删除服务器行"
                this._flagPostCreateDelete(id);
            } else {
                this._cleanupTempRequests(id);
            }
        } else {
            this._addPendingRequest({
                id: this._genReqId('delete'),
                type: 'delete',
                state: SYNC_STATES.DELETED,
                recordId: id,
                scope: this._scopeFingerprint,
                timestamp: Date.now(),
                retryCount: 0
            });
        }

        this._processQueuedRequests();
        return true;
    }

    on(event, cb) {
        if (this.eventListeners[event]) this.eventListeners[event].push(cb);
    }

    // TD-EventLeak: 提供 off 方法，便于模块在重新初始化时移除 storage.on('sync') 等监听
    off(event, cb) {
        if (this.eventListeners[event]) {
            this.eventListeners[event] = this.eventListeners[event].filter(fn => fn !== cb);
        }
    }

    _getHeaders() {
        const token = this._getAuthToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    // 供同页其它模块（如 Dashboard 拉取服务端聚合统计）复用同一套
    // 租户命名空间 + 员工/访客令牌回退逻辑，避免各模块各写一份导致鉴权口径分叉。
    getAuthHeaders() {
        return this._getHeaders();
    }

    _getAuthToken() {
        // TD-TenantIsolation：按当前学校命名空间读取（与 AuthService._nsKey 保持一致）
        // P2-记住我：AuthService.saveToken 在「不勾选记住我」时只写 sessionStorage 并清除
        // localStorage 副本，故此处必须回退读 sessionStorage，否则该模式下同步/拉取全部失败。
        const code = extractSchoolCode() || '';
        const adminKey = code ? `auth_token__${code}` : 'auth_token';
        const guestKey = code ? `guest_token__${code}` : 'guest_token';
        const adminToken = localStorage.getItem(adminKey) || sessionStorage.getItem(adminKey);
        const guestToken = localStorage.getItem(guestKey) || sessionStorage.getItem(guestKey);
        return adminToken || guestToken || null;
    }

    _canSyncWithServer() {
        const token = this._getAuthToken();
        if (!token) return false;
        return true;
    }

    async _syncFromApi(force = false) {
        const now = Date.now();
        if (!force && this._lastSyncTime > 0 && (now - this._lastSyncTime) < this.syncCooldownMs) {
            return;
        }
        if (!this._canSyncWithServer()) return;
        this._lastSyncTime = now;

        // TD-Fetch-Timeout: 防止服务端 hang 住导致 Promise 永久 pending
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
            const res = await fetch(`${this.apiEndpoint}?limit=${this.maxSyncRows}&offset=0`, {
                headers: this._getHeaders(),
                signal: controller.signal
            });
            if (!res.ok) {
                // 401/403 属于预期的权限拒绝（如访客无权访问 pathogen 模块），
                // 不应视为同步故障，静默返回避免误导性的 Sync failed 报错。
                if (res.status === 401 || res.status === 403) return;
                throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
            }

            const response = await res.json();
            const serverRows = Array.isArray(response) ? response : (response.data || []);

            // P3-W5-RECORD-T01（AUD-020 / RC-07）：记录本次同步窗口的覆盖范围（不再假定"拉到的就是全量"）。
            // 服务端契约：{ total, limit, offset, returned, hasMore, nextCursor, pagination, totalBasis, filters }
            const meta = (!Array.isArray(response) && response && typeof response === 'object') ? response : {};
            const totalFromServer = Number.isFinite(Number(meta.total)) ? Number(meta.total) : null;
            const hasMore = typeof meta.hasMore === 'boolean'
                ? meta.hasMore
                : (totalFromServer !== null ? serverRows.length < totalFromServer : false);
            const partial = hasMore || (totalFromServer !== null && serverRows.length < totalFromServer);
            this._coverage = {
                fetchedAt: new Date().toISOString(),
                window: { limit: this.maxSyncRows, offset: 0 },
                returned: serverRows.length,
                total: totalFromServer,
                hasMore,
                partial,
                complete: !partial,
                pagination: meta.pagination || 'offset',
                nextCursor: meta.nextCursor || null,
                totalBasis: meta.totalBasis || null,
                filters: meta.filters || null,
            };
            this._persistCoverage();

            const serverDataMap = new Map();
            const serverFingerprintIndex = new Map();
            for (const row of serverRows) {
                // AUD-021：已删除（墓碑）的记录不得被全量同步复活
                if (this._isTombstoned(row.id)) continue;
                const content = (row.data && typeof row.data === 'object') ? row.data : row;
                const normalized = { ...content, id: row.id, _status: 'synced', _syncState: SYNC_STATES.SYNCED };
                serverDataMap.set(row.id, normalized);
                serverFingerprintIndex.set(this._buildFingerprint(normalized), normalized);
            }
            this._serverFingerprintIndex = serverFingerprintIndex;
            this._persistFingerprintIndex(serverFingerprintIndex);

            const localCache = this._getLocalCacheData();
            const mergedData = [];
            const processedIds = new Set();

            for (const localItem of localCache) {
                processedIds.add(localItem.id);
                if (this._isTempId(localItem.id)) {
                    mergedData.push(localItem);
                    continue;
                }

                if (localItem._status === 'updating' || localItem._status === 'pending' || this._isDirtySyncState(localItem._syncState)) {
                    mergedData.push(localItem);
                    continue;
                }

                if (serverDataMap.has(localItem.id)) {
                    mergedData.push(serverDataMap.get(localItem.id));
                }
            }

            for (const [id, serverItem] of serverDataMap) {
                if (!processedIds.has(id) && !this._isTombstoned(id)) mergedData.push(serverItem);
            }

            mergedData.sort((a, b) => {
                const idA = typeof a.id === 'string' ? 9999999999 : Number(a.id || 0);
                const idB = typeof b.id === 'string' ? 9999999999 : Number(b.id || 0);
                return idB - idA;
            });

            this._updateLocalCache(mergedData);
            this._emit('sync', { type: 'full_sync' });
        } catch (err) {
            // 超时（AbortError）时重置冷却时间，允许尽快重试
            if (err && err.name === 'AbortError') this._lastSyncTime = 0;
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /** 覆盖范围元数据落盘（与缓存同作用域键，避免跨主体串味）。 */
    _persistCoverage() {
        try {
            if (this._coverage) localStorage.setItem(`${this.localCacheKey}__coverage`, JSON.stringify(this._coverage));
        } catch (e) {
            console.warn('⚠️ 覆盖范围元数据落盘失败（不影响数据）:', e.message);
        }
    }

    /**
     * P3-W5-RECORD-T01-R1（AUD-020）：服务端**权威快照导出**落地本地缓存后，同步更新覆盖范围元数据。
     *
     * 语义（保守）：只有当服务端作业自证完整（expectedCount === exportedCount === 实际行数）时，
     * 才把该类型标为 `complete`；任何计数缺失/不一致 → 一律 `partial`（宁可声明非全量，不得冒充全量）。
     * @param {{rows?:Array, expected?:number|null, exported?:number|null, jobId?:string|null, checksum?:string|null}} info
     */
    markAuthoritativeCoverage({ rows = [], expected = null, exported = null, jobId = null, checksum = null } = {}) {
        const rowCount = Array.isArray(rows) ? rows.length : 0;
        const expectedNum = Number.isFinite(Number(expected)) ? Number(expected) : null;
        const exportedNum = Number.isFinite(Number(exported)) ? Number(exported) : null;
        const consistent = expectedNum !== null && exportedNum !== null
            && expectedNum === exportedNum && rowCount === exportedNum;
        const partial = !consistent;
        this._coverage = {
            fetchedAt: new Date().toISOString(),
            source: 'authoritative-export',
            window: { limit: null, offset: 0, jobId, checksum },
            returned: rowCount,
            total: expectedNum,
            hasMore: false,
            partial,
            complete: !partial,
            pagination: 'snapshot',
            nextCursor: null,
            totalBasis: 'export-job expectedCount === exportedCount（服务端快照）',
            filters: null,
            consistency: { expected: expectedNum, exported: exportedNum, rows: rowCount, consistent },
        };
        this._persistCoverage();
        return this.getCoverage();
    }

    /**
     * 本地数据覆盖范围（P3-W5-RECORD-T01 / AUD-020）。
     * 任何"总数/完整"文案必须使用 returns 中的口径，不得再用 `rows.length` 冒充全量。
     */
    getCoverage() {
        if (!this._coverage) {
            try {
                const raw = localStorage.getItem(`${this.localCacheKey}__coverage`);
                this._coverage = raw ? JSON.parse(raw) : null;
            } catch { this._coverage = null; }
        }
        if (!this._coverage) {
            return { known: false, partial: true, complete: false, returned: null, total: null, label: '覆盖范围未知（尚未完成一次服务端同步）' };
        }
        const { returned, total, partial, source } = this._coverage;
        const authoritative = source === 'authoritative-export';
        const label = partial
            ? `${authoritative ? '权威快照' : '本地窗口'} ${returned}/${total === null ? '未知' : total} 条（部分数据，非全量）`
            : (authoritative
                ? `权威快照 ${returned} 条（expectedCount/exportedCount/渲染数一致）`
                : `本地窗口 ${returned} 条（与服务端总数一致）`);
        return { known: true, ...this._coverage, label };
    }

    async _processQueuedRequests() {
        if (!this._canSyncWithServer()) return;
        if (this._isProcessingQueue) return;

        const now = Date.now();
        const backoffUntil = this._getGlobalBackoffUntil();
        if (backoffUntil > now) {
            this._scheduleQueueProcess(backoffUntil - now);
            return;
        }

        const all = this._getPendingRequests();
        // ===== P3-W4-T01（AUD-001）：作用域守卫 —— 归属不属于当前主体的任务一律隔离，绝不上传 =====
        // 典型场景：A 校离线创建后切到 B 校（键本身已隔离，此处为纵深防御 + 显式记录）。
        let quarantined = 0;
        const scoped = [];
        for (const r of all) {
            if (!r.scope || r.scope === this._scopeFingerprint) { scoped.push(r); continue; }
            if (r._scopeViolation) continue;   // 已隔离过的直接丢弃，不再重复登记
            recordScopeViolation({ item: r, reason: 'scope_mismatch' });
            quarantined++;
        }
        if (quarantined > 0) {
            this._setPendingRequests(scoped);
            this._emit('sync', { type: 'scope_violation_quarantined', count: quarantined });
            this._emit('error', {
                request: { type: 'scope', count: quarantined },
                error: new Error(`AUD-001：${quarantined} 个待上传任务不属于当前主体作用域(${this._scopeFingerprint})，已隔离且不会上传`)
            });
        }

        const todo = scoped.filter(r =>
            !this.processingRequestIds.has(r.id) &&
            r._failed !== true &&
            (!r.nextAttemptAt || r.nextAttemptAt <= now)
        );

        if (todo.length === 0) {
            const waiting = scoped.filter(r => !r._failed && r.nextAttemptAt && r.nextAttemptAt > now);
            if (waiting.length > 0) {
                const earliest = Math.min(...waiting.map(r => r.nextAttemptAt));
                this._scheduleQueueProcess(earliest - now + 50);
            }
            return;
        }

        this._isProcessingQueue = true;

        try {
            const batch = todo.slice(0, this.queueBatchSize);
            for (const req of batch) {
                this.processingRequestIds.add(req.id);
                // AUD-021：记录级状态机同步标记"发送中"（delete 任务的行已被移除，_markRecordState 自然 no-op）
                this._markRecordState(req, SYNC_STATES.SYNCING);

                try {
                    if (req.type === 'create') await this._handleCreate(req);
                    else if (req.type === 'update') await this._handleUpdate(req);
                    else if (req.type === 'delete') await this._handleDelete(req);
                    else if (req.type === 'update_temp') await this._handleUpdateTemp(req);

                    this._removeRequestFromQueue(req.id);
                    this.processingRequestIds.delete(req.id);
                } catch (e) {
                    const httpStatus = e && e.status;
                    const currentRetry = (req.retryCount || 0) + 1;
                    const isRateLimited = httpStatus === 429;
                    const isVersionConflict = httpStatus === 409;
                    const isClientError = httpStatus >= 400 && httpStatus < 500 && !isRateLimited && !isVersionConflict;

                    if (isVersionConflict) {
                        // ===== P3-W4-T01（AUD-022）：409 一律不"换 version 整量重放" =====
                        // 字段级三路合并（base=本地已同步快照 / local=本地改动 / server=latest）：
                        //   无实质冲突 → 自动重基一次（携带 base_version+base_updated_at 显式声明）；
                        //   有冲突/预算耗尽 → 显式 CONFLICT 态，交用户裁决（绝不自动落库覆盖他人）。
                        req.autoRebaseAttempts = Number(req.autoRebaseAttempts || 0) + 1;
                        await this._handleConflict(req, e);
                        this.processingRequestIds.delete(req.id);
                        continue;
                    }

                    const maxRetries = 3;
                    const shouldRetry = !isClientError && currentRetry <= maxRetries;

                    if (shouldRetry) {
                        const retryDelay = this._computeRetryDelay(currentRetry, e?.retryAfterMs);
                        if (isRateLimited) this._setGlobalBackoff(retryDelay);
                        this._updateRequestRetry(req.id, currentRetry, Date.now() + retryDelay);
                    } else {
                        this._markRequestFailed(req.id, e.message || '请求失败');
                        this._markRecordState(req, SYNC_STATES.FAILED);
                        // FIX-15: 权限拒绝（403/401）的 create 请求，回滚本地 temp 记录，
                        // 避免 viewer 看到"保存成功"后刷新又消失的假成功，以及 localStorage 脏数据残留。
                        if (req.type === 'create' && (httpStatus === 403 || httpStatus === 401)) {
                            this._rollbackTempRecord(req.tempId);
                        }
                        this._emit('error', { request: req, error: e });
                    }

                    this.processingRequestIds.delete(req.id);
                }
            }
        } finally {
            this._isProcessingQueue = false;
            const remaining = this._getPendingRequests();
            const hasReady = remaining.some(r => !r._failed && (!r.nextAttemptAt || r.nextAttemptAt <= Date.now()));
            if (hasReady) this._scheduleQueueProcess(this.queueBatchDelayMs);
        }
    }

    /**
     * P3-W4-T01（AUD-022）：409 冲突处理 —— 唯一允许的路径是"字段级三路合并"或"显式冲突态"。
     * 明确禁止：把 serverVersion 盖回旧 payload 后整量重放（原 TD-409-Retry 行为，会静默覆盖他人更新）。
     */
    async _handleConflict(req, error) {
        const recordId = req.recordId || req.tempId;
        const serverLatest = this._conflictLatestFromError(error) || await this._fetchLatestRecord(recordId);
        const serverData = this._businessFieldsOf(serverLatest || {});
        const localData = this._businessFieldsOf(req.data || {});
        const baseData = req.baseSnapshot || {};
        const merge = threeWayMergeRecords({ base: baseData, local: localData, server: serverData });
        const conflicts = merge.conflicts || [];
        const attemptsUsed = Number(req.autoRebaseAttempts || 0);

        if (serverLatest && conflicts.length === 0 && attemptsUsed <= this.autoRebaseBudget) {
            // 无实质冲突 → 以 latest 为基线做字段级重基，并显式声明 base_version / base_updated_at
            this._applyRebasedRecord(recordId, {
                ...serverData,
                ...merge.merged,
                id: recordId,
                _status: 'updating',
                _syncState: SYNC_STATES.EDITING_PENDING,
            });
            this._removeRequestFromQueue(req.id);
            this._addPendingRequest({
                id: this._genReqId('update'),
                type: 'update',
                state: SYNC_STATES.EDITING_PENDING,
                recordId,
                data: this._withBaseDeclaration(merge.merged, serverLatest),
                base: { version: serverLatest.version ?? null, updatedAt: serverLatest.updated_at || serverLatest.updatedAt || null },
                baseSnapshot: serverData,
                scope: this._scopeFingerprint,
                autoRebaseAttempts: attemptsUsed + 1,
                reason: 'conflict_rebase',
                timestamp: Date.now(),
                retryCount: 0,
            });
            this._emit('sync', {
                type: 'conflict_rebased',
                recordId,
                appliedFields: merge.appliedFields,
                adoptedFields: merge.adoptedFields,
            });
            this._scheduleQueueProcess(this.queueBatchDelayMs);
            return;
        }

        // 有实质字段冲突 / 重基预算耗尽 / 拿不到服务端基线 → 显式冲突态（用户裁决；不自动落库）
        const serverReason = (error && error.conflict && error.conflict.reason) || null;
        const reason = !serverLatest
            ? 'unresolved_server_baseline'
            : (conflicts.length ? 'field_conflict' : (serverReason || 'conflict'))
        const summary = summarizeConflict({
            reason,
            fields: conflicts.map((c) => c.field),
            base: baseData,
            local: localData,
            server: serverData,
        })
        if (serverReason) summary.serverReason = serverReason
        this._markRequestConflict(req.id, summary);
        this._markRecordState(req, SYNC_STATES.CONFLICT, { _conflict: summary });
        this._emit('sync', { type: 'conflict', recordId, conflict: summary });
        this._emit('error', { request: req, error, conflict: summary });
    }

    _conflictLatestFromError(error) {
        if (!error) return null;
        if (error.latest && typeof error.latest === 'object') return error.latest;
        if (error.conflictBody && error.conflictBody.latest && typeof error.conflictBody.latest === 'object') return error.conflictBody.latest;
        return null;
    }

    /** 业务字段抽取（剥离控制/协议字段）——三路合并与基础快照共用。 */
    _businessFieldsOf(record) {
        const out = {};
        for (const [k, v] of Object.entries(record || {})) {
            if (CONTROL_FIELDS.has(k)) continue;
            out[k] = v;
        }
        return out;
    }

    _baseSnapshotOf(record) {
        return this._businessFieldsOf(record || {});
    }

    /** 在载荷中显式声明重基基线（AUD-022 协议的一部分；version 保持既有 CAS 兼容语义）。 */
    _withBaseDeclaration(payload, base) {
        const out = { ...(payload || {}) };
        const version = base && base.version !== undefined && base.version !== null ? base.version : null;
        const updatedAt = base ? (base.updated_at || base.updatedAt || null) : null;
        if (version !== null) {
            out.version = version;
            out.base_version = version;
        }
        if (updatedAt) out.base_updated_at = updatedAt;
        return out;
    }

    /** 拉取服务端单条完整记录（冲突重基的 server 侧基线）。 */
    async _fetchLatestRecord(recordId) {
        try {
            const res = await fetch(`${this.apiEndpoint}/${recordId}`, { headers: this._getHeaders() });
            if (!res.ok) return null;
            const json = await res.json();
            const row = json && (json.data || json);
            return row && typeof row === 'object' ? row : null;
        } catch {
            return null;
        }
    }

    _isDirtySyncState(state) {
        return state === SYNC_STATES.EDITING_PENDING
            || state === SYNC_STATES.SYNCING
            || state === SYNC_STATES.TEMP_CREATED
            || state === SYNC_STATES.FAILED
            || state === SYNC_STATES.CONFLICT;
    }

    /** 把状态机状态写回本地记录（可选附加字段），非法转移留痕但不静默。 */
    _markRecordState(req, state, extra = {}) {
        const id = (req && (req.recordId || req.tempId)) || null;
        if (!id) return;
        const rows = this._getLocalCacheData();
        const idx = rows.findIndex(r => String(r.id) === String(id));
        if (idx === -1) return;
        const eventMap = {
            [SYNC_STATES.SYNCING]: SYNC_EVENTS.SEND_START,
            [SYNC_STATES.SYNCED]: SYNC_EVENTS.SEND_OK,
            [SYNC_STATES.FAILED]: SYNC_EVENTS.SEND_FAIL,
            [SYNC_STATES.CONFLICT]: SYNC_EVENTS.SEND_CONFLICT,
            [SYNC_STATES.DELETED]: SYNC_EVENTS.DELETE_OK,
            [SYNC_STATES.EDITING_PENDING]: SYNC_EVENTS.EDIT,
        };
        const transition = applyTransition(rows[idx]._syncState, eventMap[state]);
        if (transition.rejected) {
            console.warn(`[Storage:${this.tableName}] 状态机：${rows[idx]._syncState} --${eventMap[state]}--> ${state} 非法转移（按目标态落库并留痕）`);
        }
        rows[idx] = { ...rows[idx], _syncState: state, ...extra };
        if (state === SYNC_STATES.FAILED || state === SYNC_STATES.CONFLICT) rows[idx]._status = 'updating';
        if (state === SYNC_STATES.SYNCED || state === SYNC_STATES.TEMP_CREATED) rows[idx]._status = state === SYNC_STATES.SYNCED ? 'synced' : 'pending';
        this._updateLocalCache(rows, { forceServer: true });
    }

    _applyRebasedRecord(recordId, record) {
        const rows = this._getLocalCacheData();
        const idx = rows.findIndex(r => String(r.id) === String(recordId));
        if (idx === -1) return;
        rows[idx] = { ...rows[idx], ...record, id: rows[idx].id };
        this._updateLocalCache(rows, { forceServer: true });
    }

    _setRequestState(reqId, state) {
        const list = this._getPendingRequests();
        const idx = list.findIndex(r => r.id === reqId);
        if (idx === -1) return;
        list[idx].state = state;
        this._setPendingRequests(list);
    }

    _markRequestConflict(reqId, summary) {
        const list = this._getPendingRequests();
        const idx = list.findIndex(r => r.id === reqId);
        if (idx === -1) return;
        list[idx].state = SYNC_STATES.CONFLICT;
        list[idx]._failed = true;                 // 不自动重试：必须由用户裁决/编辑后重新入队
        list[idx]._conflict = summary;
        list[idx].nextAttemptAt = null;
        this._setPendingRequests(list);
    }

    _flagPostCreateDelete(tempId) {
        this._postCreateDelete.add(tempId);
        const list = this._getPendingRequests();
        const item = list.find(r => r.type === 'create' && r.tempId === tempId);
        if (item) {
            item.postCreateDelete = true;
            this._setPendingRequests(list);
        }
    }

    _enqueueDeleteTask(recordId) {
        this._addTombstone(recordId);
        this._addPendingRequest({
            id: this._genReqId('delete'),
            type: 'delete',
            state: SYNC_STATES.DELETED,
            recordId,
            scope: this._scopeFingerprint,
            reason: 'post_create_delete',
            timestamp: Date.now(),
            retryCount: 0
        });
        this._processQueuedRequests();
    }

    _enqueueUpdateTask({ recordId, payload, base, baseSnapshot, reason }) {
        this._addPendingRequest({
            id: this._genReqId('update'),
            type: 'update',
            state: SYNC_STATES.EDITING_PENDING,
            recordId,
            data: this._withBaseDeclaration({ ...(payload || {}) }, base || {}),
            base: base || { version: null, updatedAt: null },
            baseSnapshot: baseSnapshot || {},
            scope: this._scopeFingerprint,
            autoRebaseAttempts: 0,
            reason: reason || 'edit',
            timestamp: Date.now(),
            retryCount: 0
        });
        this._processQueuedRequests();
    }

    async _handleCreate(req) {
        const { id: reqId, tempId, data } = req;
        const { id, _status, _syncState, _base, _conflict, ...realData } = this._sanitizePayload(data || {});

        // AUD-021：标记在途，使"create 出队后的编辑"能追上来（合并进 post-create update）
        this._inFlightTempIds.add(tempId);
        this._setRequestState(req.id, SYNC_STATES.SYNCING);
        try {
            // 云端去重校验：先检查本地缓存的云端指纹索引
            const cloudDup = await this._findCloudDuplicate(realData);
            if (cloudDup) {
                this._replaceTempIdInCache(tempId, cloudDup);
                this._emit('sync', { type: 'cloud_dedupe_hit', record: cloudDup });
                return;
            }

            const responseJson = await this._uploadQueue.enqueue(this.tableName, null, realData, {
                method: 'POST',
                idempotencyKey: reqId
            });

            if (responseJson && responseJson.skipped) {
                this._emit('sync', { type: 'queue_skipped_duplicate', tempId });
                return;
            }

            const serverRow = (responseJson && (responseJson.data || responseJson)) || {};
            const content = (serverRow.data && typeof serverRow.data === 'object') ? serverRow.data : serverRow;
            const savedRecord = { ...content, id: serverRow.id, _status: 'synced', _syncState: SYNC_STATES.SYNCED };
            if (serverRow.id) this._mapTempId(tempId, serverRow.id);

            const postEdits = this._postCreateEdits.get(tempId) || req.postCreateEdits || null;
            const deleteAfterCreate = this._postCreateDelete.has(tempId) || req.postCreateDelete === true;

            // AUD-021：把在途编辑合并进本地行（不静默丢失），并保证 temp id 被替换为 server id
            this._replaceTempIdInCache(tempId, savedRecord, postEdits);
            this._indexServerFingerprint({ ...savedRecord, ...(postEdits || {}) });
            this._emit('sync', { type: 'create', record: savedRecord });
            auditService.log('create', this.tableName, null, `新增记录 #${savedRecord.id || '?'}`).catch(() => {});

            if (savedRecord.id && deleteAfterCreate) {
                // 删除意图发生在 create 在途期间：创建后必须立即删除服务器行（不得留幽灵行）
                this._enqueueDeleteTask(savedRecord.id);
                this._emit('sync', { type: 'create_then_delete', recordId: savedRecord.id });
            } else if (savedRecord.id && postEdits && Object.keys(postEdits).length > 0) {
                // AUD-021：create 出队/在途期间的编辑 → 转为针对新 id 的 update 任务（不再丢弃）
                this._enqueueUpdateTask({
                    recordId: savedRecord.id,
                    payload: postEdits,
                    base: { version: savedRecord.version ?? null, updatedAt: savedRecord.updated_at || null },
                    baseSnapshot: this._baseSnapshotOf(savedRecord),
                    reason: 'post_create_edit',
                });
            }
        } finally {
            this._inFlightTempIds.delete(tempId);
            this._postCreateEdits.delete(tempId);
            this._postCreateDelete.delete(tempId);
        }
    }

    async _handleUpdate(req) {
        const { id: reqId, recordId, data } = req;
        // 载荷保留 version / base_version / base_updated_at（AUD-022 的 CAS + 重基声明）
        const declared = this._withBaseDeclaration({ ...(data || {}) }, req.base || {});
        const { id, _status, _syncState, _base, _conflict, ...realData } = this._sanitizePayload(declared);

        const responseJson = await this._uploadQueue.enqueue(this.tableName, recordId, realData, {
            method: 'PUT',
            idempotencyKey: reqId
        });

        if (responseJson && responseJson.skipped) {
            this._updateCacheStatus(recordId, 'synced');
            return;
        }

        const serverRow = (responseJson && (responseJson.data || responseJson)) || {};
        const content = (serverRow.data && typeof serverRow.data === 'object') ? serverRow.data : serverRow;

        // 冲突恢复后，以服务端最新版本覆盖本地，确保本地与云端一致
        // 缺陷X（Step3）: 改用 _applyServerRecord（forceServer），避免本地旧 dirty 记录
        // 覆盖服务端成功响应导致 _status/version 永久陈旧。
        if (serverRow && serverRow.id) {
            const patched = { ...content, id: serverRow.id, _status: 'synced', _syncState: SYNC_STATES.SYNCED };
            this._applyServerRecord(patched);
            this._indexServerFingerprint(patched);
        } else {
            this._updateCacheStatus(recordId, 'synced');
            this._markRecordState(req, SYNC_STATES.SYNCED);
        }

        auditService.log('update', this.tableName, null, `修改记录 #${recordId}`).catch(() => {});
    }

    async _handleDelete(req) {
        const { id: reqId, recordId } = req;
        const responseJson = await this._uploadQueue.enqueue(this.tableName, recordId, {}, {
            method: 'DELETE',
            idempotencyKey: reqId
        });

        if (responseJson && responseJson.skipped) return;
        this._removeFingerprintByRecordId(recordId);
        // AUD-021：删除后写墓碑并确保本地行不存在（防复活）
        this._addTombstone(recordId);
        this._pruneCacheRow(recordId);
        auditService.log('delete', this.tableName, null, `删除记录 #${recordId}`).catch(() => {});
    }

    _initializeLocalCache() {
        if (!localStorage.getItem(this.localCacheKey)) {
            localStorage.setItem(this.localCacheKey, JSON.stringify({ data: [] }));
        }
        if (!localStorage.getItem(this.pendingRequestsKey)) {
            // 队列为版本化快照（AUD-021）：{ schemaVersion, items[] }
            this._setPendingRequests([]);
        }
        this._loadTombstones();
        this._loadTempIdMap();
        this._loadPersistedFingerprintIndex();
        this._migrateCache(); // 净化已存在于 localStorage 的历史脏数据
    }

    // 历史脏数据净化：部分旧记录 canteen(食堂) 为空，而 location 被误填成
    // 「检测点位 / 设备芯片编号」(如"芯片编号"/"餐具表面")。此处把 location
    // 确实是合法食堂名的情况回填到 canteen，其余保持原样（不再被 getRecordCanteen 当作食堂）。
    _normalizeRecord(rec) {
        if (!rec || typeof rec !== 'object') return rec;
        const info = rec.sample_info && typeof rec.sample_info === 'object' ? rec.sample_info : null;
        if (!info) return rec;
        // 合法食堂名白名单（与 Dashboard.DEFAULT_CANTEENS 保持一致）
        const VALID_CANTEENS = ['一食堂', '二食堂', '三食堂'];
        const canteen = (info.canteen || '').toString().trim();
        const location = (info.location || '').toString().trim();
        if (!canteen && location && VALID_CANTEENS.includes(location)) {
            info.canteen = location;
            delete info.location; // 清空，避免再次被误读为食堂
        }
        return rec;
    }

    // 一次性迁移：把当前 localStorage 缓存里历史脏数据写回，确保已存在的
    // 旧校名等数据在下次渲染前被净化。
    _migrateCache() {
        try {
            const raw = localStorage.getItem(this.localCacheKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const rows = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.data) ? parsed.data : null;
            if (!rows) return;
            let changed = false;
            for (const r of rows) {
                const before = JSON.stringify(r.sample_info);
                this._normalizeRecord(r);
                if (JSON.stringify(r.sample_info) !== before) changed = true;
            }
            if (changed) this._updateLocalCache(rows);
        } catch {
            /* 迁移失败不影响正常使用 */
        }
    }

    _getLocalCacheData() {
        try {
            const raw = localStorage.getItem(this.localCacheKey);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            let rows;
            if (Array.isArray(parsed)) rows = parsed;
            else if (parsed && Array.isArray(parsed.data)) rows = parsed.data;
            else return [];
            // 读取即净化：保证任意来源（缓存/导入）的数据在消费前已规范
            return rows.map((r) => this._normalizeRecord(r));
        } catch {
            return [];
        }
    }

    _updateLocalCache(rows, opts = {}) {
        // Q2: 覆盖缓存前保留本地 pending/updating 记录(离线未上传数据),避免被服务器数据抹掉
        // 与 _syncFromApi 的合并策略一致:temp_id 或 pending/updating 状态的记录优先保留
        // 缺陷X（Step2）: 新增 opts.forceServer —— 为 true 时跳过 pending merge 覆盖，
        //   用于"服务端写操作成功响应"路径（_applyServerRecord），避免本地旧 dirty 记录
        //   无条件覆盖服务端最新数据（导致 _status/version 永久陈旧）。
        //   默认 false，不改动任何现有调用点行为（离线保护语义保持不变）。
        // AUD-021：墓碑（已删除 id）在两条路径上都不得被写回 —— 删除后不复活
        const incoming = (rows || []).filter(r => !this._isTombstoned(r && r.id));
        if (opts.forceServer === true) {
            localStorage.setItem(this.localCacheKey, JSON.stringify({ data: incoming.slice() }));
            return;
        }
        const localRows = this._getLocalCacheData();
        const pendingMap = new Map();
        for (const item of localRows) {
            const isTemp = this._isTempId(item.id);
            const isDirty = item._status === 'pending' || item._status === 'updating' || this._isDirtySyncState(item._syncState);
            if ((isTemp || isDirty) && !this._isTombstoned(item.id)) pendingMap.set(String(item.id), item);
        }
        let merged = incoming.slice();
        if (pendingMap.size > 0) {
            const seen = new Set(merged.map(r => String(r.id)));
            // 服务器已有同名 id 时以本地 pending 版本优先(可能含未上传修改)
            merged = merged.map(r => pendingMap.get(String(r.id)) || r);
            for (const [id, p] of pendingMap) {
                if (!seen.has(id)) merged.push(p);
            }
        }
        localStorage.setItem(this.localCacheKey, JSON.stringify({ data: merged }));
    }

    _addToLocalCache(record) {
        const rows = this._getLocalCacheData();
        rows.unshift(record);
        this._updateLocalCache(rows);
    }

    _replaceRecordInCache(recordId, record) {
        const rows = this._getLocalCacheData();
        const idx = rows.findIndex(r => String(r.id) === String(recordId));
        if (idx >= 0) {
            rows[idx] = record;
            this._updateLocalCache(rows);
        }
    }

    // 缺陷X（Step3）: 服务端写操作成功响应路径的缓存落盘。
    // 与 _replaceRecordInCache 的区别：以 forceServer 跳过 pending merge，
    // 避免本地旧 dirty 记录（_status=updating/pending）无条件覆盖服务端最新数据，
    // 从而消除 "_status/version 永久陈旧" 的持久性缺陷。
    // 边界处理：
    //   - serverV === localV：允许覆盖（serverRow 为权威，version 相等不构成回退）
    //   - synced 但 serverV < localV：console.warn 留痕后仍以服务端为准覆盖（便于排查）
    //   - local._status === 'pending'：本地未上传新建，禁止覆盖（离线保护）
    _applyServerRecord(serverRecord) {
        // AUD-021：已删除（墓碑）的记录不得被服务端响应复活
        if (this._isTombstoned(serverRecord && serverRecord.id)) return;
        const rows = this._getLocalCacheData();
        const idx = rows.findIndex(r => String(r.id) === String(serverRecord.id));
        const fresh = { ...serverRecord, id: serverRecord.id, _status: 'synced', _syncState: SYNC_STATES.SYNCED };

        if (idx >= 0) {
            const local = rows[idx];
            const serverV = Number(serverRecord.version ?? 0);
            const localV = Number(local.version ?? 0);
            if (local._status === 'pending') {
                // 本地未上传新建记录，禁止被服务端覆盖（离线保护）
                return;
            }
            if (serverV < localV && local._status !== 'updating') {
                console.warn(`[Storage] _applyServerRecord 异常：serverV(${serverV}) < localV(${localV}), id=${serverRecord.id}, 以服务端为准覆盖`);
            }
            // 修复 S2a：服务端响应若未携带复检记录（incoming 为空数组/缺省）但本地已有，
            // 保留本地 recheckRecords，防止复检记录被"空响应"覆盖导致弹窗显示"暂无复检记录"。
            if ((!Array.isArray(serverRecord.recheckRecords) || serverRecord.recheckRecords.length === 0)
                && Array.isArray(local.recheckRecords) && local.recheckRecords.length > 0) {
                fresh.recheckRecords = local.recheckRecords;
            }
            rows[idx] = fresh;
        } else {
            rows.unshift(fresh);
        }
        this._updateLocalCache(rows, { forceServer: true });
    }

    _getPendingRequests() {
        try {
            const raw = localStorage.getItem(this.pendingRequestsKey);
            const snap = normalizeQueueSnapshot(raw);
            if (!snap.ok) {
                // AUD-021：队列结构变更需版本化 + 一次性迁移。旧结构（裸数组/未知版本）不静默双读：
                // 记为迁移事件后按空队列启动（其归属/结构无法证明，宁可显式丢弃也不以错误语义发送）。
                this._recordQueueMigration(snap.reason, raw);
                this._setPendingRequests([]);
                return [];
            }
            return snap.items.filter(r => r && typeof r === 'object');
        } catch {
            return [];
        }
    }

    _setPendingRequests(list) {
        localStorage.setItem(this.pendingRequestsKey, serializeQueueSnapshot(list));
    }

    _recordQueueMigration(reason, raw) {
        try {
            const key = 'sync_queue_migration_v2';
            const prev = JSON.parse(localStorage.getItem(key) || '[]');
            const list = Array.isArray(prev) ? prev : [];
            let items = null;
            try {
                const parsed = raw ? JSON.parse(raw) : null;
                items = Array.isArray(parsed) ? parsed.length : null;
            } catch { items = null; }
            list.push({
                at: new Date().toISOString(),
                reason: reason || 'unknown',
                queueKey: this.pendingRequestsKey,
                scope: this._scopeFingerprint,
                bytes: raw ? raw.length : 0,
                items,
            });
            localStorage.setItem(key, JSON.stringify(list.slice(-50)));
        } catch { /* 记录失败不影响隔离本身 */ }
    }

    // ===== P3-W4-T01（AUD-021）：墓碑 / temp→server 映射 =====
    _loadTombstones() {
        if (this._tombstonesLoaded) return this._tombstones;
        this._tombstonesLoaded = true;
        try {
            const parsed = JSON.parse(localStorage.getItem(this.tombstoneKey) || 'null');
            const ids = parsed && parsed.ids && typeof parsed.ids === 'object' ? Object.keys(parsed.ids) : [];
            this._tombstones = new Set(ids.map(String));
        } catch {
            this._tombstones = new Set();
        }
        return this._tombstones;
    }

    _isTombstoned(id) {
        if (id === undefined || id === null) return false;
        return this._loadTombstones().has(String(id));
    }

    _addTombstone(id) {
        if (id === undefined || id === null) return;
        this._loadTombstones().add(String(id));
        this._persistTombstones();
    }

    _persistTombstones() {
        try {
            const ids = {};
            for (const id of Array.from(this._tombstones).slice(-500)) ids[id] = Date.now();
            localStorage.setItem(this.tombstoneKey, JSON.stringify({ schemaVersion: 1, ids }));
        } catch { /* 忽略持久化失败（内存墓碑仍生效） */ }
    }

    _pruneCacheRow(recordId) {
        const rows = this._getLocalCacheData();
        const filtered = rows.filter(r => String(r.id) !== String(recordId));
        if (filtered.length !== rows.length) this._updateLocalCache(filtered, { forceServer: true });
    }

    _loadTempIdMap() {
        if (this._tempIdMapLoaded) return this._tempIdMap;
        this._tempIdMapLoaded = true;
        try {
            const parsed = JSON.parse(localStorage.getItem(this.tempMapKey) || 'null');
            const map = parsed && parsed.map && typeof parsed.map === 'object' ? Object.entries(parsed.map) : [];
            this._tempIdMap = new Map(map.map(([k, v]) => [String(k), String(v)]));
        } catch {
            this._tempIdMap = new Map();
        }
        return this._tempIdMap;
    }

    _mapTempId(tempId, serverId) {
        if (!tempId || !serverId) return;
        this._loadTempIdMap().set(String(tempId), String(serverId));
        try {
            localStorage.setItem(this.tempMapKey, JSON.stringify({ schemaVersion: 1, map: Object.fromEntries(this._tempIdMap) }));
        } catch { /* 忽略持久化失败 */ }
    }

    _addPendingRequest(request) {
        const list = this._getPendingRequests();
        list.push(request);
        this._setPendingRequests(list);
    }

    _removeRequestFromQueue(reqId) {
        const list = this._getPendingRequests().filter(r => r.id !== reqId);
        this._setPendingRequests(list);
    }

    _markRequestFailed(reqId, reason) {
        const list = this._getPendingRequests();
        const index = list.findIndex(r => r.id === reqId);
        if (index !== -1) {
            list[index]._failed = true;
            list[index]._failReason = reason;
            this._setPendingRequests(list);
        }
    }

    _updateRequestRetry(reqId, count, nextAttemptAt = null) {
        const list = this._getPendingRequests();
        const index = list.findIndex(r => r.id === reqId);
        if (index !== -1) {
            list[index].retryCount = count;
            list[index].nextAttemptAt = nextAttemptAt;
            this._setPendingRequests(list);
        }
    }

    _replaceTempIdInCache(tempId, savedRecord, pendingEdits = null) {
        const rows = this._getLocalCacheData();
        const index = rows.findIndex(r => r.id === tempId);
        const serverId = (savedRecord && savedRecord.id) || tempId;
        if (index !== -1) {
            const edits = pendingEdits && typeof pendingEdits === 'object' ? pendingEdits : null;
            const hasEdits = !!edits && Object.keys(edits).length > 0;
            rows[index] = hasEdits
                // AUD-021：在途编辑合并进本地行（保持 dirty），由随后的 post-create update 任务确认
                ? { ...savedRecord, ...edits, id: serverId, _status: 'updating', _syncState: SYNC_STATES.EDITING_PENDING }
                : { ...savedRecord, id: serverId, _status: 'synced', _syncState: SYNC_STATES.SYNCED };
            // 缺陷X（Step3）: create 成功响应以服务端为权威，跳过 pending merge，
            // 避免本地 tempId 旧记录（pending）被误并入覆盖服务端新建数据。
            this._updateLocalCache(rows, { forceServer: true });
        }
        this.pendingTempIds.delete(tempId);
    }

    _updateCacheStatus(recordId, status) {
        const rows = this._getLocalCacheData();
        const index = rows.findIndex(r => String(r.id) === String(recordId));
        if (index !== -1) {
            rows[index]._status = status;
            if (status === 'synced') rows[index]._syncState = SYNC_STATES.SYNCED;
            this._updateLocalCache(rows);
        }
    }

    /**
     * AUD-021：临时记录编辑的三条路径（唯一写入路径，不允许静默丢弃）：
     *   ① create 仍在队列（未发送）      → 直接把编辑并入 create 载荷；
     *   ② create 已在途（已出队/发送中） → 记为 post-create 编辑，成功后转为针对新 id 的 update；
     *   ③ create 已完成（有 temp→server 映射）→ 直接转为针对 server id 的 update；
     *      映射缺失（如跨刷新丢失）     → 显式 CONFLICT 态（保留编辑，请用户处理）。
     */
    _queueTempUpdate(tempId, data) {
        const list = this._getPendingRequests();
        const queuedCreate = list.find(r => r.type === 'create' && r.tempId === tempId && !this.processingRequestIds.has(r.id));
        if (queuedCreate) {
            queuedCreate.data = { ...queuedCreate.data, ...data };
            queuedCreate.state = SYNC_STATES.EDITING_PENDING;
            queuedCreate.editedAt = Date.now();
            this._setPendingRequests(list);
            const rows = this._getLocalCacheData();
            const idx = rows.findIndex(r => String(r.id) === String(tempId));
            if (idx !== -1) {
                rows[idx] = { ...rows[idx], _syncState: SYNC_STATES.EDITING_PENDING };
                this._updateLocalCache(rows, { forceServer: true });
            }
            return;
        }
        if (this._inFlightTempIds.has(tempId)) {
            this._appendPostCreateEdits(tempId, data);
            return;
        }
        const mappedId = this._loadTempIdMap().get(String(tempId));
        if (mappedId) {
            const baseRow = this._getLocalCacheData().find(r => String(r.id) === String(mappedId)) || {};
            this._enqueueUpdateTask({
                recordId: mappedId,
                payload: data,
                base: { version: baseRow.version ?? null, updatedAt: baseRow.updated_at || baseRow.updatedAt || null },
                baseSnapshot: this._baseSnapshotOf(baseRow),
                reason: 'temp_edit_after_create',
            });
            return;
        }
        const rows = this._getLocalCacheData();
        const idx = rows.findIndex(r => String(r.id) === String(tempId));
        if (idx !== -1) {
            const summary = summarizeConflict({
                reason: 'orphan_temp_edit',
                fields: Object.keys(data || {}),
                base: null,
                local: data,
                server: null,
            });
            rows[idx] = { ...rows[idx], _status: 'updating', _syncState: SYNC_STATES.CONFLICT, _conflict: summary };
            this._updateLocalCache(rows, { forceServer: true });
            this._emit('sync', { type: 'conflict', recordId: tempId, conflict: summary });
            this._emit('error', {
                request: { type: 'update_temp', tempId },
                error: new Error('AUD-021：临时记录已失去服务端映射，编辑已保留并标记为冲突（未静默丢弃）'),
                conflict: summary,
            });
        }
    }

    /** AUD-021：把在途 create 的编辑记为 post-create 编辑（内存 + 持久化队列项）。 */
    _appendPostCreateEdits(tempId, edits) {
        const merged = { ...(this._postCreateEdits.get(tempId) || {}), ...(edits || {}) };
        this._postCreateEdits.set(tempId, merged);
        const list = this._getPendingRequests();
        const item = list.find(r => r.type === 'create' && r.tempId === tempId);
        if (item) {
            item.postCreateEdits = { ...(item.postCreateEdits || {}), ...(edits || {}) };
            item.state = SYNC_STATES.EDITING_PENDING;
            this._setPendingRequests(list);
        }
        const rows = this._getLocalCacheData();
        const idx = rows.findIndex(r => String(r.id) === String(tempId));
        if (idx !== -1) {
            rows[idx] = { ...rows[idx], _syncState: SYNC_STATES.EDITING_PENDING };
            this._updateLocalCache(rows, { forceServer: true });
        }
    }

    /** 兼容旧任务类型（版本化迁移后不应再出现）：能并入仍未发送的 create 则并入，否则留痕。 */
    async _handleUpdateTemp(req) {
        const list = this._getPendingRequests();
        const createReqIndex = list.findIndex(r => r.type === 'create' && r.tempId === req.tempId);
        if (createReqIndex !== -1) {
            list[createReqIndex].data = { ...list[createReqIndex].data, ...req.data };
            this._setPendingRequests(list);
            return;
        }
        this._appendPostCreateEdits(req.tempId, req.data || {});
    }

    _cleanupTempRequests(tempId) {
        const list = this._getPendingRequests().filter(r => r.tempId !== tempId);
        this._setPendingRequests(list);
    }

    // FIX-15: 权限拒绝时的本地 temp 记录回滚。
    // 从本地缓存移除指定 tempId 的 pending 记录，并清理其关联的 pending 请求队列，
    // 使 viewer 越权"新增"的记录不留脏数据（与 _cleanupTempRequests 配合使用）。
    _rollbackTempRecord(tempId) {
        if (!tempId) return;
        const rows = this._getLocalCacheData();
        const filtered = rows.filter(r => String(r.id) !== String(tempId));
        if (filtered.length !== rows.length) {
            this._updateLocalCache(filtered, { forceServer: true });
        }
        this.pendingTempIds.delete(tempId);
        this._cleanupTempRequests(tempId);
    }

    _genReqId(type) {
        return `sync_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${type}`;
    }

    _isTempId(id) {
        return typeof id === 'string' && id.startsWith('temp_');
    }

    _computeRetryDelay(retryCount, retryAfterMs) {
        const backoff = Math.min(this.minRetryDelayMs * (2 ** Math.max(0, retryCount - 1)), this.maxRetryDelayMs);
        if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
            return Math.min(Math.max(retryAfterMs, backoff), this.maxRetryDelayMs);
        }
        return backoff;
    }

    _getGlobalBackoffUntil() {
        const raw = Number(localStorage.getItem(this.globalBackoffKey));
        return Number.isFinite(raw) ? raw : 0;
    }

    _setGlobalBackoff(delayMs) {
        const target = Date.now() + Math.max(0, delayMs || this.minRetryDelayMs);
        const current = this._getGlobalBackoffUntil();
        if (target > current) {
            localStorage.setItem(this.globalBackoffKey, String(target));
        }
    }

    _scheduleQueueProcess(delayMs) {
        if (this._queueTimer) clearTimeout(this._queueTimer);
        this._queueTimer = setTimeout(() => {
            this._queueTimer = null;
            this._processQueuedRequests();
        }, Math.max(0, delayMs || 0));
    }

    _sanitizePayload(payload) {
        return Object.fromEntries(
            Object.entries(payload || {}).filter(([k]) => !SERVER_META_FIELDS.has(k))
        );
    }

    _stripVolatileFields(value) {
        if (Array.isArray(value)) {
            return value.map(v => this._stripVolatileFields(v));
        }
        if (value && typeof value === 'object') {
            const clean = {};
            Object.keys(value).forEach(key => {
                if (VOLATILE_FIELDS.has(key)) return;
                clean[key] = this._stripVolatileFields(value[key]);
            });
            return clean;
        }
        return value;
    }

    _normalizeForHash(value) {
        if (Array.isArray(value)) {
            return value
                .map(v => this._normalizeForHash(v))
                .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        }
        if (value && typeof value === 'object') {
            const sorted = {};
            Object.keys(value).sort().forEach(k => {
                sorted[k] = this._normalizeForHash(value[k]);
            });
            return sorted;
        }
        return value;
    }

    _buildFingerprint(record) {
        const sanitized = this._stripVolatileFields(record || {});
        const normalized = this._normalizeForHash(sanitized);
        return `${this.tableName}::${JSON.stringify(normalized)}`;
    }

    _findLocalDuplicate(payload, excludeId = null) {
        const fp = this._buildFingerprint(payload || {});
        const rows = this._getLocalCacheData();
        for (const row of rows) {
            if (excludeId != null && String(row.id) === String(excludeId)) continue;
            if (this._buildFingerprint(row) === fp) return row;
        }
        return null;
    }

    _indexServerFingerprint(record) {
        const fp = this._buildFingerprint(record || {});
        this._serverFingerprintIndex.set(fp, record);
        this._persistFingerprintIndex(this._serverFingerprintIndex);
    }

    _removeFingerprintByRecordId(recordId) {
        for (const [fp, row] of this._serverFingerprintIndex.entries()) {
            if (String(row.id) === String(recordId)) {
                this._serverFingerprintIndex.delete(fp);
            }
        }
        this._persistFingerprintIndex(this._serverFingerprintIndex);
    }

    async _findCloudDuplicate(payload) {
        const fp = this._buildFingerprint(payload || {});

        if (this._serverFingerprintIndex.has(fp)) {
            return this._serverFingerprintIndex.get(fp);
        }

        // 索引未命中时强制拉一次云端，保证跨端同步后仍可去重
        await this._syncFromApi(true);
        if (this._serverFingerprintIndex.has(fp)) {
            return this._serverFingerprintIndex.get(fp);
        }

        return null;
    }

    _loadPersistedFingerprintIndex() {
        try {
            const raw = localStorage.getItem(this.fingerprintIndexKey);
            if (!raw) return;
            const rows = JSON.parse(raw);
            if (!Array.isArray(rows)) return;
            const map = new Map();
            for (const item of rows) {
                if (item && item.fp && item.record) map.set(item.fp, item.record);
            }
            this._serverFingerprintIndex = map;
        } catch {
            this._serverFingerprintIndex = new Map();
        }
    }

    _persistFingerprintIndex(map) {
        try {
            const entries = Array.from((map || new Map()).entries()).map(([fp, record]) => ({ fp, record }));
            localStorage.setItem(this.fingerprintIndexKey, JSON.stringify(entries.slice(-this.maxSyncRows)));
        } catch {
            // ignore persist errors
        }
    }

    _emit(event, data) {
        if (!this.eventListeners[event]) return;
        this.eventListeners[event].forEach(cb => cb(data));
    }
}
