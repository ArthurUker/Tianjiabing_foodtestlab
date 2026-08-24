// 文件路径: core/Storage.js

import { auditService } from '../services/AuditService.js';
import { AdaptiveUploadQueue } from './AdaptiveUploadQueue.js';
// TD-TenantIsolation：认证态 key 已按学校命名空间隔离，读取需拼 schoolCode 前缀
import { extractSchoolCode } from '../utils/schoolCode.js';

const DEFAULT_CONFIG = {
    apiBaseUrl: '/api/records',
    maxSyncRows: 200,
    syncCooldownMs: 30000,
    queueBatchSize: 5,
    queueBatchDelayMs: 400,
    minRetryDelayMs: 1000,
    maxRetryDelayMs: 30000,
    globalBackoffKey: 'app_sync_backoff_until'
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
    'importUser', 'lastModified'
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

        const dbTableName = TABLE_NAME_MAP[tableName] || tableName;
        this.apiEndpoint = `${this.apiBaseUrl}/${dbTableName}`;

        this.localCacheKey = `cache_${tableName}`;
        this.pendingRequestsKey = `pending_${tableName}`;
        this.fingerprintIndexKey = `fingerprint_index_${tableName}`;

        this.pendingTempIds = new Set();
        this.processingRequestIds = new Set();
        this.eventListeners = { error: [], sync: [] };
        this._lastSyncTime = 0;
        this._isProcessingQueue = false;
        this._queueTimer = null;
        this._serverFingerprintIndex = new Map();

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
        const tempRecord = { ...clean, id: tempId, _status: 'pending' };

        this._addToLocalCache(tempRecord);
        this.pendingTempIds.add(tempId);

        this._addPendingRequest({
            id: this._genReqId('create'),
            type: 'create',
            data: tempRecord,
            tempId,
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

        cached[index] = {
            ...cached[index],
            ...clean,
            id,
            _status: 'updating'
        };
        this._updateLocalCache(cached);

        if (this._isTempId(id)) {
            this._queueTempUpdate(id, clean);
        } else {
            this._addPendingRequest({
                id: this._genReqId('update'),
                type: 'update',
                recordId: id,
                data: { ...clean, version: cached[index].version ?? clean.version },
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
        this._updateLocalCache(cached);

        if (this._isTempId(id)) {
            this.pendingTempIds.delete(id);
            this._cleanupTempRequests(id);
        } else {
            this._addPendingRequest({
                id: this._genReqId('delete'),
                type: 'delete',
                recordId: id,
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

            const serverDataMap = new Map();
            const serverFingerprintIndex = new Map();
            for (const row of serverRows) {
                const content = (row.data && typeof row.data === 'object') ? row.data : row;
                const normalized = { ...content, id: row.id, _status: 'synced' };
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

                if (localItem._status === 'updating' || localItem._status === 'pending') {
                    mergedData.push(localItem);
                    continue;
                }

                if (serverDataMap.has(localItem.id)) {
                    mergedData.push(serverDataMap.get(localItem.id));
                }
            }

            for (const [id, serverItem] of serverDataMap) {
                if (!processedIds.has(id)) mergedData.push(serverItem);
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
        const todo = all.filter(r =>
            !this.processingRequestIds.has(r.id) &&
            r._failed !== true &&
            (!r.nextAttemptAt || r.nextAttemptAt <= now)
        );

        if (todo.length === 0) {
            const waiting = all.filter(r => !r._failed && r.nextAttemptAt && r.nextAttemptAt > now);
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

                    const maxRetries = isVersionConflict ? 2 : 3;
                    const shouldRetry = !isClientError && currentRetry <= maxRetries;

                    if (shouldRetry) {
                        const retryDelay = this._computeRetryDelay(currentRetry, e?.retryAfterMs);
                        if (isRateLimited) this._setGlobalBackoff(retryDelay);
                        // TD-409-Retry: 版本冲突重试前先获取服务端最新 version，避免用旧 version 永久 409。
                        // 优先用 409 响应体携带的 serverVersion（AdaptiveUploadQueue 已解析），省一次 GET；
                        // 缺失时才回退 _fetchLatestVersion。
                        if (isVersionConflict && req.type === 'update' && req.recordId) {
                            try {
                                const sv = e.serverVersion;
                                const latestVersion = (sv !== undefined && sv !== null && sv !== 'stale')
                                    ? sv
                                    : await this._fetchLatestVersion(req.recordId);
                                if (latestVersion != null) req.data = { ...req.data, version: latestVersion };
                            } catch (_) { /* 拉取失败则沿用原 payload，交给下层失败处理 */ }
                        }
                        this._updateRequestRetry(req.id, currentRetry, Date.now() + retryDelay);
                    } else {
                        this._markRequestFailed(req.id, e.message || '请求失败');
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

    async _handleCreate(req) {
        const { id: reqId, tempId, data } = req;
        const { id, _status, ...realData } = this._sanitizePayload(data || {});

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
        const savedRecord = { ...content, id: serverRow.id, _status: 'synced' };

        this._replaceTempIdInCache(tempId, savedRecord);
        this._indexServerFingerprint(savedRecord);
        this._emit('sync', { type: 'create', record: savedRecord });
        auditService.log('create', this.tableName, null, `新增记录 #${savedRecord.id || '?'}`).catch(() => {});
    }

    async _handleUpdate(req) {
        const { id: reqId, recordId, data } = req;
        const { id, _status, ...realData } = this._sanitizePayload(data || {});

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
            const patched = { ...content, id: serverRow.id, _status: 'synced' };
            this._applyServerRecord(patched);
            this._indexServerFingerprint(patched);
        } else {
            this._updateCacheStatus(recordId, 'synced');
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
        auditService.log('delete', this.tableName, null, `删除记录 #${recordId}`).catch(() => {});
    }

    // TD-409-Retry: 拉取服务端记录的最新 version，供版本冲突重试前更新 payload
    async _fetchLatestVersion(recordId) {
        try {
            const res = await fetch(`${this.apiEndpoint}/${recordId}`, { headers: this._getHeaders() });
            if (!res.ok) return null;
            const json = await res.json();
            const row = json && (json.data || json);
            return row && row.version != null ? row.version : null;
        } catch {
            return null;
        }
    }

    _initializeLocalCache() {
        if (!localStorage.getItem(this.localCacheKey)) {
            localStorage.setItem(this.localCacheKey, JSON.stringify({ data: [] }));
        }
        if (!localStorage.getItem(this.pendingRequestsKey)) {
            localStorage.setItem(this.pendingRequestsKey, JSON.stringify([]));
        }
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
        const incoming = rows || [];
        if (opts.forceServer === true) {
            localStorage.setItem(this.localCacheKey, JSON.stringify({ data: incoming.slice() }));
            return;
        }
        const localRows = this._getLocalCacheData();
        const pendingMap = new Map();
        for (const item of localRows) {
            const isTemp = this._isTempId(item.id);
            const isDirty = item._status === 'pending' || item._status === 'updating';
            if (isTemp || isDirty) pendingMap.set(String(item.id), item);
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
        const rows = this._getLocalCacheData();
        const idx = rows.findIndex(r => String(r.id) === String(serverRecord.id));
        const fresh = { ...serverRecord, id: serverRecord.id, _status: 'synced' };

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
            const parsed = JSON.parse(raw || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    _setPendingRequests(list) {
        localStorage.setItem(this.pendingRequestsKey, JSON.stringify(Array.isArray(list) ? list : []));
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

    _replaceTempIdInCache(tempId, savedRecord) {
        const rows = this._getLocalCacheData();
        const index = rows.findIndex(r => r.id === tempId);
        if (index !== -1) {
            rows[index] = { ...savedRecord, _status: 'synced' };
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
            this._updateLocalCache(rows);
        }
    }

    _queueTempUpdate(tempId, data) {
        this._addPendingRequest({
            id: this._genReqId('update_temp'),
            type: 'update_temp',
            tempId,
            data,
            timestamp: Date.now(),
            retryCount: 0
        });
    }

    async _handleUpdateTemp(req) {
        const list = this._getPendingRequests();
        const createReqIndex = list.findIndex(r => r.type === 'create' && r.tempId === req.tempId);
        if (createReqIndex !== -1) {
            list[createReqIndex].data = {
                ...list[createReqIndex].data,
                ...req.data
            };
            this._setPendingRequests(list);
        }
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
