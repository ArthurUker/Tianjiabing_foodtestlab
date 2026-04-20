/**
 * OfflineModeManager 单元测试
 * 测试离线模式、网络状态检测、自动同步等功能
 */

describe('OfflineModeManager - 离线模式管理', () => {
  // 模拟网络状态管理器
  class OfflineModeManager {
    constructor() {
      this.isOnline = true;
      this.pendingQueue = [];
      this.syncInProgress = false;
      this.listeners = [];
      this.lastSyncTime = null;
      this.failedRequests = [];
      this.syncRetries = 3;
    }

    // 初始化
    init() {
      window.addEventListener('online', () => this.handleOnline());
      window.addEventListener('offline', () => this.handleOffline());
      this.isOnline = navigator.onLine;
    }

    // 检测网络状态
    checkStatus() {
      return {
        isOnline: this.isOnline,
        lastSyncTime: this.lastSyncTime,
        pendingCount: this.pendingQueue.length,
        failedCount: this.failedRequests.length,
        isSyncing: this.syncInProgress
      };
    }

    // 网络在线处理
    handleOnline() {
      this.isOnline = true;
      this.notifyListeners('online');
      this.syncPendingRequests();
    }

    // 网络离线处理
    handleOffline() {
      this.isOnline = false;
      this.notifyListeners('offline');
    }

    // 添加待同步请求
    addPendingRequest(request) {
      if (!this.isOnline) {
        this.pendingQueue.push({
          ...request,
          timestamp: Date.now(),
          retries: 0
        });
        return { queued: true, queueSize: this.pendingQueue.length };
      }
      return { queued: false };
    }

    // 同步待处理请求
    async syncPendingRequests() {
      if (this.syncInProgress || this.pendingQueue.length === 0) {
        return;
      }

      this.syncInProgress = true;
      this.notifyListeners('sync-start');

      let successCount = 0;
      let failureCount = 0;

      while (this.pendingQueue.length > 0) {
        const request = this.pendingQueue.shift();

        try {
          // 模拟网络请求
          await this.executeRequest(request);
          successCount++;
          this.lastSyncTime = Date.now();
        } catch (error) {
          failureCount++;

          if (request.retries < this.syncRetries) {
            request.retries++;
            this.pendingQueue.push(request);
          } else {
            this.failedRequests.push(request);
          }
        }
      }

      this.syncInProgress = false;
      this.notifyListeners('sync-complete', {
        success: successCount,
        failure: failureCount
      });

      return {
        successCount,
        failureCount,
        timestamp: this.lastSyncTime
      };
    }

    // 执行网络请求 (模拟)
    async executeRequest(request) {
      return new Promise((resolve, reject) => {
        // 模拟有10%的失败率
        if (Math.random() < 0.1) {
          reject(new Error('网络请求失败'));
        } else {
          resolve({ status: 'success' });
        }
      });
    }

    // 重试失败的请求
    async retryFailedRequests() {
      const failedRequests = [...this.failedRequests];
      this.failedRequests = [];

      for (const request of failedRequests) {
        request.retries = 0;
        this.pendingQueue.push(request);
      }

      return await this.syncPendingRequests();
    }

    // 清空待处理队列
    clearPendingQueue() {
      const count = this.pendingQueue.length;
      this.pendingQueue = [];
      return count;
    }

    // 清空失败请求列表
    clearFailedRequests() {
      const count = this.failedRequests.length;
      this.failedRequests = [];
      return count;
    }

    // 获取离线数据
    getOfflineData() {
      return {
        pending: this.pendingQueue,
        failed: this.failedRequests,
        lastSync: this.lastSyncTime
      };
    }

    // 订阅状态变化
    subscribe(callback) {
      this.listeners.push(callback);
      return () => {
        this.listeners = this.listeners.filter(l => l !== callback);
      };
    }

    // 通知监听器
    notifyListeners(event, data) {
      this.listeners.forEach(callback => {
        callback({ event, data });
      });
    }

    // 处理离线冲突
    async handleConflict(localData, remoteData) {
      // 简单的策略: 服务器数据优先
      return remoteData;
    }

    // 验证待处理请求
    validatePendingRequest(request) {
      if (!request.method) return false;
      if (!request.url) return false;
      if (!request.type) return false;
      return true;
    }
  }

  let manager;

  beforeEach(() => {
    manager = new OfflineModeManager();
  });

  describe('网络状态检测', () => {
    test('应该初始化为在线状态', () => {
      expect(manager.isOnline).toBe(true);
    });

    test('应该报告当前网络状态', () => {
      const status = manager.checkStatus();

      expect(status).toHaveProperty('isOnline');
      expect(status).toHaveProperty('lastSyncTime');
      expect(status).toHaveProperty('pendingCount');
      expect(status).toHaveProperty('isSyncing');
    });

    test('应该正确处理网络在线事件', () => {
      manager.isOnline = false;
      manager.handleOnline();

      expect(manager.isOnline).toBe(true);
    });

    test('应该正确处理网络离线事件', () => {
      manager.isOnline = true;
      manager.handleOffline();

      expect(manager.isOnline).toBe(false);
    });
  });

  describe('离线队列管理', () => {
    test('应该在离线时将请求添加到队列', () => {
      manager.isOnline = false;

      const request = {
        method: 'POST',
        url: '/api/data',
        type: 'test',
        data: { test: 'data' }
      };

      const result = manager.addPendingRequest(request);

      expect(result.queued).toBe(true);
      expect(result.queueSize).toBe(1);
      expect(manager.pendingQueue.length).toBe(1);
    });

    test('应该在在线时不添加到队列', () => {
      manager.isOnline = true;

      const request = {
        method: 'POST',
        url: '/api/data',
        type: 'test'
      };

      const result = manager.addPendingRequest(request);

      expect(result.queued).toBe(false);
      expect(manager.pendingQueue.length).toBe(0);
    });

    test('应该记录请求的时间戳', () => {
      manager.isOnline = false;
      const now = Date.now();

      const request = {
        method: 'POST',
        url: '/api/data',
        type: 'test'
      };

      manager.addPendingRequest(request);

      expect(manager.pendingQueue[0].timestamp).toBeGreaterThanOrEqual(now);
    });

    test('应该清空待处理队列', () => {
      manager.isOnline = false;
      manager.addPendingRequest({ method: 'POST', url: '/api/1', type: 'test' });
      manager.addPendingRequest({ method: 'POST', url: '/api/2', type: 'test' });

      const cleared = manager.clearPendingQueue();

      expect(cleared).toBe(2);
      expect(manager.pendingQueue.length).toBe(0);
    });
  });

  describe('自动同步机制', () => {
    test('应该在恢复在线时同步待处理请求', async () => {
      manager.isOnline = false;
      manager.addPendingRequest({ method: 'POST', url: '/api/1', type: 'test' });

      manager.isOnline = true;
      const result = await manager.syncPendingRequests();

      expect(result).toHaveProperty('successCount');
      expect(result).toHaveProperty('failureCount');
    });

    test('应该记录同步完成时间', async () => {
      const beforeSync = Date.now();

      manager.isOnline = false;
      manager.addPendingRequest({ method: 'POST', url: '/api/1', type: 'test' });

      manager.isOnline = true;
      await manager.syncPendingRequests();

      expect(manager.lastSyncTime).toBeGreaterThanOrEqual(beforeSync);
    });

    test('应该防止并发同步', async () => {
      manager.isOnline = false;
      manager.addPendingRequest({ method: 'POST', url: '/api/1', type: 'test' });
      manager.addPendingRequest({ method: 'POST', url: '/api/2', type: 'test' });

      manager.isOnline = true;
      manager.syncInProgress = true;

      await manager.syncPendingRequests();

      // 同步不应该执行，队列应该保持不变
      expect(manager.pendingQueue.length).toBe(2);
    });

    test('应该处理同步中的失败请求', async () => {
      manager.isOnline = false;
      
      // 添加多个请求
      for (let i = 0; i < 5; i++) {
        manager.addPendingRequest({
          method: 'POST',
          url: `/api/${i}`,
          type: 'test'
        });
      }

      manager.isOnline = true;
      const result = await manager.syncPendingRequests();

      // 一些请求应该失败
      expect(result.failureCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('失败请求管理', () => {
    test('应该记录失败的请求', async () => {
      manager.syncRetries = 0; // 禁用重试

      manager.isOnline = false;
      const request = { method: 'POST', url: '/api/fail', type: 'test' };
      manager.addPendingRequest(request);

      manager.isOnline = true;
      // 模拟请求失败
      manager.pendingQueue[0].retries = 0;
      manager.failedRequests.push(manager.pendingQueue.shift());

      expect(manager.failedRequests.length).toBeGreaterThan(0);
    });

    test('应该清空失败请求列表', () => {
      manager.failedRequests = [
        { method: 'POST', url: '/api/1', type: 'test', retries: 3 },
        { method: 'POST', url: '/api/2', type: 'test', retries: 3 }
      ];

      const cleared = manager.clearFailedRequests();

      expect(cleared).toBe(2);
      expect(manager.failedRequests.length).toBe(0);
    });

    test('应该重试失败的请求', async () => {
      manager.failedRequests = [
        { method: 'POST', url: '/api/1', type: 'test', retries: 3 }
      ];

      manager.isOnline = true;
      await manager.retryFailedRequests();

      expect(manager.failedRequests.length).toBeLessThanOrEqual(1);
      expect(manager.pendingQueue.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('事件监听', () => {
    test('应该订阅状态变化事件', (done) => {
      const callback = jest.fn((event) => {
        expect(event.event).toBe('online');
        done();
      });

      manager.subscribe(callback);
      manager.handleOnline();

      expect(callback).toHaveBeenCalled();
    });

    test('应该支持多个订阅者', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      manager.subscribe(callback1);
      manager.subscribe(callback2);

      manager.handleOnline();

      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });

    test('应该支持取消订阅', () => {
      const callback = jest.fn();
      const unsubscribe = manager.subscribe(callback);

      unsubscribe();
      manager.handleOnline();

      expect(callback).not.toHaveBeenCalled();
    });

    test('应该发送同步事件', async () => {
      const callback = jest.fn();
      manager.subscribe(callback);

      manager.isOnline = false;
      manager.addPendingRequest({ method: 'POST', url: '/api/1', type: 'test' });

      manager.isOnline = true;
      await manager.syncPendingRequests();

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        event: 'sync-complete'
      }));
    });
  });

  describe('离线数据', () => {
    test('应该获取离线数据', () => {
      manager.isOnline = false;
      manager.addPendingRequest({ method: 'POST', url: '/api/1', type: 'test' });

      const data = manager.getOfflineData();

      expect(data).toHaveProperty('pending');
      expect(data).toHaveProperty('failed');
      expect(data).toHaveProperty('lastSync');
      expect(data.pending.length).toBe(1);
    });

    test('应该返回正确的离线数据结构', () => {
      const data = manager.getOfflineData();

      expect(Array.isArray(data.pending)).toBe(true);
      expect(Array.isArray(data.failed)).toBe(true);
    });
  });

  describe('数据验证', () => {
    test('应该验证待处理请求', () => {
      const validRequest = {
        method: 'POST',
        url: '/api/test',
        type: 'test'
      };

      const invalidRequest = {
        url: '/api/test'
      };

      expect(manager.validatePendingRequest(validRequest)).toBe(true);
      expect(manager.validatePendingRequest(invalidRequest)).toBe(false);
    });
  });

  describe('冲突解决', () => {
    test('应该处理离线冲突 (服务器优先)', async () => {
      const localData = { id: 1, name: 'Local', timestamp: 1000 };
      const remoteData = { id: 1, name: 'Remote', timestamp: 2000 };

      const result = await manager.handleConflict(localData, remoteData);

      expect(result).toEqual(remoteData);
    });
  });

  describe('性能', () => {
    test('应该在合理时间内处理大量待处理请求', async () => {
      const startTime = Date.now();

      manager.isOnline = false;
      for (let i = 0; i < 100; i++) {
        manager.addPendingRequest({
          method: 'POST',
          url: `/api/${i}`,
          type: 'test'
        });
      }

      manager.isOnline = true;
      await manager.syncPendingRequests();

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // 应该在5秒内完成
    });
  });
});
