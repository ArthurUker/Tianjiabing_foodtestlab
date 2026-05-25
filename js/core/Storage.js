// 文件路径: core/Storage.js

import { logOperation } from '../utils/AuditLogger.js';

// ==========================================
// 0. 内置默认配置
// ==========================================
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

// 表名映射
const TABLE_NAME_MAP = {
    'leanMeat': 'leanMeat', 
    'oil': 'oil',
    'pathogen': 'pathogen',
    'pesticide': 'pesticide',
    'tableware': 'tableware'
};

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
        
        this.pendingTempIds = new Set();
        this.processingRequestIds = new Set();
        this.eventListeners = { error: [], sync: [] };
        this._lastSyncTime = 0; // 防止同步循环：记录最后一次同步时间
        this._isProcessingQueue = false;
        this._queueTimer = null;

        this._initializeLocalCache();
        setTimeout(() => this._processQueuedRequests(), 100);
    }

    getAll() {
        const cached = this._getLocalCacheData();
        this._syncFromApi().catch(e => console.error(`[${this.tableName}] Sync failed:`, e));
        return cached;
    }

    save(data) {
        const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const tempRecord = { ...data, id: tempId, _status: 'pending' };
        
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

        cached[index] = { ...updatedData, id, _status: 'updating' };
        this._updateLocalCache(cached);

        if (this._isTempId(id)) {
            this._queueTempUpdate(id, updatedData);
        } else {
            this._addPendingRequest({
                id: this._genReqId('update'),
                type: 'update',
                recordId: id,
                data: updatedData,
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
        const headers = {
            'Content-Type': 'application/json',
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

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
        // 快速访问令牌不是 JWT，不应请求受保护 API。
        return !token.startsWith('temp-token-');
    }

    async _syncFromApi() {
        // 防止同步循环：30秒内同一表不重复同步
        const now = Date.now();
        if (this._lastSyncTime > 0 && (now - this._lastSyncTime) < this.syncCooldownMs) {
            return;
        }
        if (!this._canSyncWithServer()) {
            return;
        }
        this._lastSyncTime = now;

        const res = await fetch(`${this.apiEndpoint}?limit=${this.maxSyncRows}&offset=0`, {
            headers: this._getHeaders()
        });
        if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

        const response = await res.json();
        const serverRows = Array.isArray(response) ? response : (response.data || []);
        const serverDataMap = new Map();
        serverRows.forEach(row => {
            const content = (row.data && typeof row.data === 'object') ? row.data : row;
            serverDataMap.set(row.id, { ...content, id: row.id, _status: 'synced' });
        });

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
            const idA = typeof a.id === 'string' ? 9999999999 : a.id;
            const idB = typeof b.id === 'string' ? 9999999999 : b.id;
            return idB - idA;
        });

        this._updateLocalCache(mergedData);
        this._emit('sync', { type: 'full_sync' });
    }

    async _processQueuedRequests() {
        if (!this._canSyncWithServer()) {
            return;
        }

        if (this._isProcessingQueue) {
            return;
        }

        const now = Date.now();
        const backoffUntil = this._getGlobalBackoffUntil();
        if (backoffUntil > now) {
            this._scheduleQueueProcess(backoffUntil - now);
            return;
        }

        const all = this._getPendingRequests();
        // 过滤出"可立即执行"的请求：未在处理中、未被标记 failed、nextAttemptAt 已到期
        const todo = all.filter(r =>
            !this.processingRequestIds.has(r.id) &&
            r._failed !== true &&
            (!r.nextAttemptAt || r.nextAttemptAt <= now)
        );
        if (todo.length === 0) {
            // 还有等待退避的请求，继续调度
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
                } catch (e) {
                    const httpStatus = e && e.status;
                    const currentRetry = (req.retryCount || 0) + 1;
                    const isRateLimited = httpStatus === 429;

                    // 4xx（除 429）= 客户端数据错误，永远不会因重试而成功
                    const isClientError = httpStatus >= 400 && httpStatus < 500 && !isRateLimited;

                    const maxRetries = 3;
                    const shouldRetry = !isClientError && currentRetry <= maxRetries;

                    if (shouldRetry) {
                        const retryDelay = this._computeRetryDelay(currentRetry, e?.retryAfterMs);
                        if (isRateLimited) {
                            this._setGlobalBackoff(retryDelay);
                        }
                        this._updateRequestRetry(req.id, currentRetry, Date.now() + retryDelay);
                        console.warn(`[StorageService:${this.tableName}] 请求 ${req.id} 失败(${httpStatus || '网络'}), 第 ${currentRetry}/${maxRetries} 次，${retryDelay}ms 后重试`, e.message);
                    } else {
                        // 超出重试次数或客户端错误：标记 failed，移出活跃队列
                        this._markRequestFailed(req.id, e.message);
                        console.error(`[StorageService:${this.tableName}] 请求 ${req.id} 永久失败(${httpStatus || '网络'}, retry=${currentRetry - 1}):`, e.message);
                        this._emit('error', { request: req, error: e });
                    }
                    this.processingRequestIds.delete(req.id);
                }
            }
        } finally {
            this._isProcessingQueue = false;

            // 只在还有"可执行"请求时才继续调度，避免空轮询刷屏
            const remaining = this._getPendingRequests();
            const hasReady = remaining.some(r => !r._failed && (!r.nextAttemptAt || r.nextAttemptAt <= Date.now()));
            if (hasReady) {
                this._scheduleQueueProcess(this.queueBatchDelayMs);
            }
        }
    }

    async _handleCreate(req) {
        const { id: reqId, tempId, data } = req;
        const { _status, id, ...rawData } = data;

        // 清洗 payload：移除服务端元字段 & 本地控制字段，避免污染 result_data
        const SERVER_META_FIELDS = new Set([
            'record_code', 'test_type', 'test_name',
            'created_at', 'updated_at', 'completed_at'
        ]);
        const realData = Object.fromEntries(
            Object.entries(rawData).filter(([k]) => !SERVER_META_FIELDS.has(k))
        );

        const res = await fetch(this.apiEndpoint, {
            method: 'POST',
            headers: this._getHeaders(),
            body: JSON.stringify(realData)
        });

        await this._throwIfNotOk(res);
        const responseJson = await res.json();
        const serverRow = responseJson.data || responseJson;
        const content = (serverRow.data && typeof serverRow.data === 'object') ? serverRow.data : serverRow;
        const savedRecord = { ...content, id: serverRow.id };

        this._replaceTempIdInCache(tempId, savedRecord);
        this._emit('sync', { type: 'create', record: savedRecord });
        logOperation('create', this.tableName, `新增记录 #${savedRecord.id || '?'}`);
    }

    async _handleUpdate(req) {
        const { id: reqId, recordId, data } = req;
        const { _status, id, ...realData } = data;
        const res = await fetch(`${this.apiEndpoint}/${recordId}`, {
            method: 'PUT',
            headers: this._getHeaders(),
            body: JSON.stringify(realData)
        });
        await this._throwIfNotOk(res);
        this._updateCacheStatus(recordId, 'synced');
        logOperation('update', this.tableName, `修改记录 #${recordId}`);
    }

    async _handleDelete(req) {
        const { id: reqId, recordId } = req;
        const res = await fetch(`${this.apiEndpoint}/${recordId}`, {
            method: 'DELETE',
            headers: this._getHeaders()
        });
        await this._throwIfNotOk(res);
        logOperation('delete', this.tableName, `删除记录 #${recordId}`);
    }
    
    _initializeLocalCache() {
        if (!localStorage.getItem(this.localCacheKey)) localStorage.setItem(this.localCacheKey, JSON.stringify({data:[]}));
        if (!localStorage.getItem(this.pendingRequestsKey)) localStorage.setItem(this.pendingRequestsKey, JSON.stringify([]));
    }
    _getLocalCacheData() { try { return JSON.parse(localStorage.getItem(this.localCacheKey)).data || []; } catch { return []; } }
    _addToLocalCache(r) { const d = this._getLocalCacheData(); d.unshift(r); this._updateLocalCache(d); }
    _updateLocalCache(d) { localStorage.setItem(this.localCacheKey, JSON.stringify({data:d})); }
    _isTempId(id) { return typeof id === 'string' && id.startsWith('temp_'); }
    _genReqId(t) { return `${t}-${Date.now()}-${Math.random()}`; }
    _addPendingRequest(r) { const l = this._getPendingRequests(); l.push(r); localStorage.setItem(this.pendingRequestsKey, JSON.stringify(l)); }
    _getPendingRequests() { try { return JSON.parse(localStorage.getItem(this.pendingRequestsKey)) || []; } catch { return []; } }
    _removeRequestFromQueue(id) { 
        const l = this._getPendingRequests().filter(r => r.id !== id); 
        localStorage.setItem(this.pendingRequestsKey, JSON.stringify(l));
        this.processingRequestIds.delete(id);
    }
    _markRequestFailed(reqId, reason) {
        const list = this._getPendingRequests();
        const index = list.findIndex(r => r.id === reqId);
        if (index !== -1) {
            list[index]._failed = true;
            list[index]._failReason = reason;
            localStorage.setItem(this.pendingRequestsKey, JSON.stringify(list));
        }
        this.processingRequestIds.delete(reqId);
    }
    _updateRequestRetry(reqId, count, nextAttemptAt = null) {
        const list = this._getPendingRequests();
        const index = list.findIndex(r => r.id === reqId);
        if (index !== -1) {
            list[index].retryCount = count;
            list[index].nextAttemptAt = nextAttemptAt;
            localStorage.setItem(this.pendingRequestsKey, JSON.stringify(list));
        }
    }
    _replaceTempIdInCache(tid, rec) {
        const d = this._getLocalCacheData();
        const i = d.findIndex(r => r.id === tid);
        if (i !== -1) { d[i] = { ...rec, _status: 'synced' }; this._updateLocalCache(d); }
    }
    _updateCacheStatus(id, s) {
        const d = this._getLocalCacheData();
        const i = d.findIndex(r => r.id == id);
        if (i !== -1) { d[i]._status = s; this._updateLocalCache(d); }
    }
    _queueTempUpdate(tempId, data) { 
        const requestId = this._genReqId('update_temp');
        this._addPendingRequest({
            id: requestId, type: 'update_temp', tempId, data, timestamp: Date.now(), retryCount: 0
        });
    }
    async _handleUpdateTemp(req) { 
        const { id: requestId, tempId, data } = req;
        const list = this._getPendingRequests();
        const createReqIndex = list.findIndex(r => r.type === 'create' && r.tempId === tempId);
        if (createReqIndex !== -1) {
            list[createReqIndex].data = { ...list[createReqIndex].data, ...data };
            localStorage.setItem(this.pendingRequestsKey, JSON.stringify(list));
        }
    }
    _cleanupTempRequests(tempId) {
        const list = this._getPendingRequests().filter(r => r.tempId !== tempId);
        localStorage.setItem(this.pendingRequestsKey, JSON.stringify(list));
    }
    async _throwIfNotOk(response) {
        if (response.ok) return;

        // 读响应体，打印后端返回的详细错误信息
        let detail = '';
        try {
            const ct = response.headers.get('Content-Type') || '';
            if (ct.includes('application/json')) {
                const body = await response.json();
                detail = body?.details || body?.error || JSON.stringify(body);
            } else {
                detail = await response.text();
            }
        } catch (_) { /* 忽略读体失败 */ }

        const msg = `HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`;
        console.error(`[StorageService] ${msg}`, { url: response.url, status: response.status, detail });

        const error = new Error(msg);
        error.status = response.status;
        error.responseDetail = detail;

        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
            const retryAfterSeconds = Number(retryAfter);
            if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds >= 0) {
                error.retryAfterMs = retryAfterSeconds * 1000;
            }
        }
        throw error;
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
        if (this._queueTimer) {
            clearTimeout(this._queueTimer);
        }
        this._queueTimer = setTimeout(() => {
            this._queueTimer = null;
            this._processQueuedRequests();
        }, Math.max(0, delayMs || 0));
    }
    _emit(e, d) { if(this.eventListeners[e]) this.eventListeners[e].forEach(c=>c(d)); }
}
