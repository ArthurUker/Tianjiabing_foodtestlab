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
        try {
          const latest = await this._fetchLatest(item.collection, item.recordId);
          item.payload = { ...item.payload, version: latest.version };
          item.fingerprint = this._makeFingerprint(item.collection, item.recordId, item.payload);
          item.attempt++;
          if (item.attempt <= 3) {
            this._queueList.unshift(item);
            this._queueMap.set(queueKey, item);
            this._scheduleNext(500);
          } else {
            item.rejectors.forEach(r => r(error));
            this._totalCompleted++;
            this._notifyProgress();
          }
        } catch (fetchError) {
          item.rejectors.forEach(r => r(error));
          this._totalCompleted++;
          this._notifyProgress();
        }
      } else {
        item.attempt++;
        const delay = Math.min(1000 * Math.pow(2, item.attempt), 30000);
        if (item.attempt <= 3) {
          this._queueList.unshift(item);
          this._queueMap.set(queueKey, item);
          this._scheduleNext(delay);
        } else {
          item.rejectors.forEach(r => r(error));
          this._totalCompleted++;
          this._notifyProgress();
          this._scheduleNext(this._currentInterval);
        }
      }
    }
  }

  async _doRequest(item) {
    let url;
    let method = item.method || 'PUT';
    if (method === 'POST') {
      url = `/api/records/${item.collection}`;
    } else if (method === 'PUT') {
      url = `/api/records/${item.collection}/${item.recordId}`;
    } else if (method === 'DELETE') {
      url = `/api/records/${item.collection}/${item.recordId}`;
    } else {
      url = `/api/records/${item.collection}/${item.recordId || ''}`;
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
      throw err;
    }
    return response.json();
  }

  async _fetchLatest(collection, recordId) {
    const response = await fetch(`/api/records/${collection}/${recordId}`);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    return response.json();
  }

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

  _markCompleted(fingerprint) {
    if (this._completedFingerprints.size >= this._maxFingerprintCache) {
      const oldestKey = this._completedFingerprints.keys().next().value;
      this._completedFingerprints.delete(oldestKey);
    }
    this._completedFingerprints.set(fingerprint, Date.now());
  }

  _isRecentlyCompleted(fingerprint) {
    const ts = this._completedFingerprints.get(fingerprint);
    if (!ts) return false;
    if (Date.now() - ts > this._fingerprintTTL) {
      this._completedFingerprints.delete(fingerprint);
      return false;
    }
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
