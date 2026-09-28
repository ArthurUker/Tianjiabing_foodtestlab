// AdaptiveUploadQueue.js
// 渐进式节流上传队列 + 多层去重（适配 StorageService）

export class AdaptiveUploadQueue {
  constructor(options = {}) {
    this._initialInterval = options.initialInterval ?? 800;
    this._minInterval = options.minInterval ?? 400;
    this._maxInterval = options.maxInterval ?? 15000;
    this._currentInterval = this._initialInterval;
    this._maxConcurrent = options.maxConcurrent ?? 1;
    this._inFlight = 0;

    this._successStreak = 0;
    this._speedUpThreshold = options.speedUpThreshold ?? 8;
    this._slowDownFactor = 2.0;
    this._speedUpFactor = 0.85;

    this._queueMap = new Map();
    this._queueList = [];

    this._inFlightKeys = new Set();

    this._completedFingerprints = new Map();
    this._fingerprintTTL = options.fingerprintTTL ?? 60000;
    this._maxFingerprintCache = options.maxFingerprintCache ?? 500;

    this._isProcessing = false;
    this._pausedUntil = 0;
    this._lastSentTime = 0;

    this._totalEnqueued = 0;
    this._totalCompleted = 0;
    this._totalSkipped = 0;
    this._onProgress = options.onProgress ?? null;
    this._getHeaders = options.getHeaders ?? (() => ({}));
    // P1-24: 新增 getBaseUrl 回调，避免 _doRequest() 硬编码 /api/records 前缀
    this._getBaseUrl = options.getBaseUrl ?? (() => '/api/records');
  }

  enqueue(collection, recordId, payload, opts = {}) {
    return new Promise((resolve, reject) => {
      const method = (opts.method || (recordId ? 'PUT' : 'POST')).toUpperCase();

      // 内容指纹去重
      const fingerprint = this._makeFingerprint(collection, recordId, payload);
      if (this._isRecentlyCompleted(fingerprint)) {
        this._totalSkipped++;
        this._notifyProgress();
        resolve({ skipped: true, reason: 'duplicate_content' });
        return;
      }

      const queueKey = `${collection}::${recordId || 'new'}::${method}`;
      if (this._queueMap.has(queueKey)) {
        const existing = this._queueMap.get(queueKey);
        existing.payload = { ...existing.payload, ...payload };
        existing.fingerprint = this._makeFingerprint(collection, recordId, existing.payload);
        existing.resolvers.push(resolve);
        existing.rejectors.push(reject);
        return;
      }

      const item = {
        collection,
        recordId,
        payload,
        method,
        fingerprint,
        attempt: 0,
        idempotencyKey: opts.idempotencyKey || this._generateIdempotencyKey(collection, recordId),
        resolvers: [resolve],
        rejectors: [reject],
        enqueuedAt: Date.now(),
      };

      this._queueMap.set(queueKey, item);
      this._queueList.push(item);
      this._totalEnqueued++;
      this._notifyProgress();

      if (!this._isProcessing) this._scheduleNext(0);
    });
  }

  _scheduleNext(delay) {
    setTimeout(() => this._processNext(), Math.max(0, delay));
  }

  async _processNext() {
    const now = Date.now();
    if (now < this._pausedUntil) {
      const wait = this._pausedUntil - now;
      this._scheduleNext(wait);
      return;
    }

    if (this._inFlight >= this._maxConcurrent) return;
    if (this._queueList.length === 0) {
      this._isProcessing = false;
      return;
    }

    this._isProcessing = true;

    const elapsed = Date.now() - this._lastSentTime;
    if (elapsed < this._currentInterval) {
      this._scheduleNext(this._currentInterval - elapsed);
      return;
    }

    const item = this._queueList.shift();
    const queueKey = `${item.collection}::${item.recordId || 'new'}::${item.method}`;
    this._queueMap.delete(queueKey);

    if (this._isRecentlyCompleted(item.fingerprint)) {
      this._totalSkipped++;
      this._totalCompleted++;
      this._notifyProgress();
      item.resolvers.forEach(r => r({ skipped: true, reason: 'duplicate_on_dequeue' }));
      this._scheduleNext(0);
      return;
    }

    this._inFlight++;
    this._lastSentTime = Date.now();

    try {
      const result = await this._doRequest(item);
      this._inFlight--;
      this._successStreak++;
      this._totalCompleted++;
      this._markCompleted(item.fingerprint);
      this._notifyProgress();

      if (this._successStreak >= this._speedUpThreshold) {
        const newInterval = Math.max(this._minInterval, Math.floor(this._currentInterval * this._speedUpFactor));
        if (newInterval < this._currentInterval) this._currentInterval = newInterval;
        this._successStreak = 0;
      }

      item.resolvers.forEach(r => r(result));
      this._scheduleNext(this._currentInterval);
    } catch (error) {
      this._inFlight--;

      if (error.status === 429) {
        this._successStreak = 0;
        const newInterval = Math.min(this._maxInterval, Math.floor(this._currentInterval * this._slowDownFactor));
        this._currentInterval = newInterval;
        const retryAfter = error.retryAfter ? parseInt(error.retryAfter) * 1000 : null;
        const pauseDuration = retryAfter ?? newInterval * 1.5;
        this._pausedUntil = Date.now() + pauseDuration;

        item.attempt++;
        if (item.attempt <= 5) {
          this._queueList.unshift(item);
          this._queueMap.set(queueKey, item);
        } else {
          item.rejectors.forEach(r => r(error));
          this._totalCompleted++;
          this._notifyProgress();
        }

        this._scheduleNext(pauseDuration);
      } else if (error.status === 409) {
        // P3-W4-T01（AUD-022）：409 一律**不再**把 latest version 盖回旧 payload 后自动重试。
        // 原 TD-409-Retry 行为会让 stale 全量载荷静默覆盖他人的更新（AUD-022 已实证）。
        // 现改为：把冲突信息（latest/conflict/reason）原样交给上层 —— Storage 的状态机做
        // 字段级三路合并（无冲突才自动重基，且显式声明 base_version/base_updated_at）或进入
        // 显式 CONFLICT 态请用户裁决；队列本身立即 reject，不做任何重放。
        // 注意：仍需释放 _isProcessing 并继续调度（缺陷B修复不回退，否则队列死锁）。
        item.attempt++;
        item.rejectors.forEach(r => r(error));
        this._totalCompleted++;
        this._notifyProgress();
        this._isProcessing = false;
        this._scheduleNext(this._currentInterval);
      } else {
        // P3-W4-T01（AUD-021）：明确的客户端错误（4xx，除 408/425/429）不重试 ——
        // 原实现会把 403/400/404 也退避重试至 ~14s，使"显式 FAILED 态"迟迟不可达且白白放大权限拒绝流量。
        // 网络错误/5xx 仍按既有指数退避重试（不改变既有语义）。
        item.attempt++;
        const definitiveClientError = typeof error.status === 'number'
          && error.status >= 400 && error.status < 500
          && error.status !== 408 && error.status !== 425 && error.status !== 429;
        const delay = Math.min(1000 * Math.pow(2, item.attempt), 30000);
        if (!definitiveClientError && item.attempt <= 3) {
          this._queueList.unshift(item);
          this._queueMap.set(queueKey, item);
          this._scheduleNext(delay);
        } else {
          item.rejectors.forEach(r => r(error));
          this._totalCompleted++;
          this._notifyProgress();
          this._isProcessing = false;
          this._scheduleNext(this._currentInterval);
        }
      }
    }
  }

  async _doRequest(item) {
    let url;
    let method = item.method || 'PUT';
    // P1-24: URL 前缀改用 getBaseUrl 回调，跟随 StorageService.apiBaseUrl 配置
    const baseUrl = this._getBaseUrl();
    if (method === 'POST') {
      url = `${baseUrl}/${item.collection}`;
    } else if (method === 'PUT') {
      url = `${baseUrl}/${item.collection}/${item.recordId}`;
    } else if (method === 'DELETE') {
      url = `${baseUrl}/${item.collection}/${item.recordId}`;
    } else {
      url = `${baseUrl}/${item.collection}/${item.recordId || ''}`;
    }

    const baseHeaders = this._getHeaders() || {};
    const headers = { 'Content-Type': 'application/json', ...baseHeaders };
    if (item.idempotencyKey) headers['Idempotency-Key'] = item.idempotencyKey;

    const opts = { method, headers };
    if (method === 'POST' || method === 'PUT') {
      opts.body = JSON.stringify(item.payload);
    }

    const response = await fetch(url, opts);
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      err.retryAfter = response.headers.get('Retry-After');
      // P3-W4-T01（AUD-022）：409 响应体解析（扩展冲突信息）——仅解析并上抛，不在此层做任何重试决策。
      // 兼容：旧服务端只给 serverVersion 时，err.conflict/latest 为空，上层按"无冲突信息"处理（仍不自动重放）。
      if (response.status === 409) {
        try {
          const body = await response.json();
          err.conflictBody = body;
          if (body && typeof body.serverVersion !== 'undefined') err.serverVersion = body.serverVersion;
          if (body && typeof body.latest !== 'undefined') err.latest = body.latest;
          if (body && typeof body.conflict !== 'undefined') err.conflict = body.conflict;
        } catch (_) { /* 响应体非 JSON 时忽略：上层仍走显式冲突处理，不自动重放 */ }
        err.retryable = false;
      }
      throw err;
    }
    return response.json();
  }

  // 说明（P3-W4-T01/AUD-022）：原 `_fetchLatest()`（409 后拉取最新 version 供重试）已移除 ——
  // 它正是"stale 全量重放"链路的一环。冲突处置统一由 Storage 的同步状态机负责。

  _makeFingerprint(collection, recordId, payload) {
    const content = `${collection}::${recordId || 'new'}::${JSON.stringify(
      Object.keys(payload || {}).sort().reduce((acc, k) => { acc[k] = payload[k]; return acc; }, {})
    )}`;
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
    return `${collection}::${recordId || 'new'}::${hash}`;
  }

  _generateIdempotencyKey(collection, recordId) {
    return `${collection}-${recordId || 'new'}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  }

  _cleanupExpiredFingerprints(now = Date.now()) {
    for (const [fp, ts] of this._completedFingerprints.entries()) {
      if (now - ts > this._fingerprintTTL) {
        this._completedFingerprints.delete(fp);
      }
    }
  }

  _markCompleted(fingerprint) {
    const now = Date.now();
    // P1-19: 使用 TTL 批量过期清理，替代固定上限 FIFO 淘汰。
    this._cleanupExpiredFingerprints(now);
    this._completedFingerprints.set(fingerprint, now);
  }

  _isRecentlyCompleted(fingerprint) {
    this._cleanupExpiredFingerprints();
    const ts = this._completedFingerprints.get(fingerprint);
    if (!ts) return false;
    return true;
  }

  _notifyProgress() {
    if (!this._onProgress) return;
    this._onProgress(this.getStatus());
  }

  getStatus() {
    return {
      total: this._totalEnqueued,
      completed: this._totalCompleted,
      skipped: this._totalSkipped,
      pending: this._queueList.length,
      inFlight: this._inFlight,
      currentInterval: this._currentInterval,
      isPaused: Date.now() < this._pausedUntil,
      percent: this._totalEnqueued > 0 ? Math.floor((this._totalCompleted / this._totalEnqueued) * 100) : 0
    };
  }
}
