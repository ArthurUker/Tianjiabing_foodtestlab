// 文件路径: core/Storage.js

import { logOperation } from '../utils/AuditLogger.js';
import { AdaptiveUploadQueue } from './AdaptiveUploadQueue.js';

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

        const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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
        const index = cached.findIndex(r => r.id == id);
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
        const index = cached.findIndex(r => r.id == id);
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

    _getHeaders() {
        const token = this._getAuthToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    _getAuthToken() {
        const adminToken = localStorage.getItem('auth_token');
        const guestToken = localStorage.getItem('guest_token');
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

        const res = await fetch(`${this.apiEndpoint}?limit=${this.maxSyncRows}&offset=0`, {
            headers: this._getHeaders()
        });
        if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

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
                        this._updateRequestRetry(req.id, currentRetry, Date.now() + retryDelay);
                    } else {
                        this._markRequestFailed(req.id, e.message || '请求失败');
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
        logOperation('create', this.tableName, `新增记录 #${savedRecord.id || '?'}`);
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
        if (serverRow && serverRow.id) {
            const patched = { ...content, id: serverRow.id, _status: 'synced' };
            this._replaceRecordInCache(serverRow.id, patched);
            this._indexServerFingerprint(patched);
        } else {
            this._updateCacheStatus(recordId, 'synced');
        }

        logOperation('update', this.tableName, `修改记录 #${recordId}`);
    }

    async _handleDelete(req) {
        const { id: reqId, recordId } = req;
        const responseJson = await this._uploadQueue.enqueue(this.tableName, recordId, {}, {
            method: 'DELETE',
            idempotencyKey: reqId
        });

        if (responseJson && responseJson.skipped) return;
        this._removeFingerprintByRecordId(recordId);
        logOperation('delete', this.tableName, `删除记录 #${recordId}`);
    }

    _initializeLocalCache() {
        if (!localStorage.getItem(this.localCacheKey)) {
            localStorage.setItem(this.localCacheKey, JSON.stringify({ data: [] }));
        }
        if (!localStorage.getItem(this.pendingRequestsKey)) {
            localStorage.setItem(this.pendingRequestsKey, JSON.stringify([]));
        }
        this._loadPersistedFingerprintIndex();
    }

    _getLocalCacheData() {
        try {
            const raw = localStorage.getItem(this.localCacheKey);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && Array.isArray(parsed.data)) return parsed.data;
            return [];
        } catch {
            return [];
        }
    }

    _updateLocalCache(rows) {
        localStorage.setItem(this.localCacheKey, JSON.stringify({ data: rows || [] }));
    }

    _addToLocalCache(record) {
        const rows = this._getLocalCacheData();
        rows.unshift(record);
        this._updateLocalCache(rows);
    }

    _replaceRecordInCache(recordId, record) {
        const rows = this._getLocalCacheData();
        const idx = rows.findIndex(r => r.id == recordId);
        if (idx >= 0) {
            rows[idx] = record;
            this._updateLocalCache(rows);
        }
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
            this._updateLocalCache(rows);
        }
        this.pendingTempIds.delete(tempId);
    }

    _updateCacheStatus(recordId, status) {
        const rows = this._getLocalCacheData();
        const index = rows.findIndex(r => r.id == recordId);
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
