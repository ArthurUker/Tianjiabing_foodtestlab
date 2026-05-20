// 文件路径: core/Storage.js

import { logOperation } from '../utils/AuditLogger.js';

// ==========================================
// 0. 内置默认配置
// ==========================================
const DEFAULT_CONFIG = {
    apiBaseUrl: '/api/records',
    maxSyncRows: 200,
    syncCooldownMs: 30000
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
        
        const dbTableName = TABLE_NAME_MAP[tableName] || tableName;
        this.apiEndpoint = `${this.apiBaseUrl}/${dbTableName}`;
        
        this.localCacheKey = `cache_${tableName}`;
        this.pendingRequestsKey = `pending_${tableName}`;
        
        this.pendingTempIds = new Set();
        this.processingRequestIds = new Set();
        this.eventListeners = { error: [], sync: [] };
        this._lastSyncTime = 0; // 防止同步循环：记录最后一次同步时间

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

        const all = this._getPendingRequests();
        const todo = all.filter(r => !this.processingRequestIds.has(r.id));
        if (todo.length === 0) return;

        for (const req of todo) {
            this.processingRequestIds.add(req.id);
            try {
                if (req.type === 'create') await this._handleCreate(req);
                else if (req.type === 'update') await this._handleUpdate(req);
                else if (req.type === 'delete') await this._handleDelete(req);
                else if (req.type === 'update_temp') await this._handleUpdateTemp(req);
                this._removeRequestFromQueue(req.id);
            } catch (e) {
                console.error(`Request ${req.id} failed:`, e);
                const isIdempotent = req.type !== 'create';
                const currentRetry = (req.retryCount || 0) + 1;
                if (isIdempotent && currentRetry < 3) {
                    this._updateRequestRetryCount(req.id, currentRetry);
                } else {
                    this._removeRequestFromQueue(req.id);
                    this._emit('error', { request: req, error: e });
                }
                this.processingRequestIds.delete(req.id);
            }
        }
    }

    async _handleCreate(req) {
        const { id: reqId, tempId, data } = req;
        const { _status, id, ...realData } = data;

        const res = await fetch(this.apiEndpoint, {
            method: 'POST',
            headers: this._getHeaders(),
            body: JSON.stringify(realData)
        });

        if (!res.ok) throw new Error(res.statusText);
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
        if (!res.ok) throw new Error(res.statusText);
        this._updateCacheStatus(recordId, 'synced');
        logOperation('update', this.tableName, `修改记录 #${recordId}`);
    }

    async _handleDelete(req) {
        const { id: reqId, recordId } = req;
        const res = await fetch(`${this.apiEndpoint}/${recordId}`, {
            method: 'DELETE',
            headers: this._getHeaders()
        });
        if (!res.ok) throw new Error(res.statusText);
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
    _updateRequestRetryCount(reqId, count) {
        const list = this._getPendingRequests();
        const index = list.findIndex(r => r.id === reqId);
        if (index !== -1) {
            list[index].retryCount = count;
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
    _emit(e, d) { if(this.eventListeners[e]) this.eventListeners[e].forEach(c=>c(d)); }
}
