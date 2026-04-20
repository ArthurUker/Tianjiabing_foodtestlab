/**
 * 离线模式管理器 - 支持离线操作和自动同步
 * 
 * 功能:
 * - 检测网络状态
 * - 离线操作缓存
 * - 自动同步管理
 * - 冲突解决
 * - 用户通知
 */

class OfflineModeManager {
  constructor(apiClient, indexedDBManager) {
    this.apiClient = apiClient;
    this.db = indexedDBManager;
    this.isOnline = navigator.onLine;
    this.isOfflineMode = !this.isOnline;
    this.syncInProgress = false;
    this.listeners = [];
    this.conflictStrategy = 'last-write-wins'; // 冲突解决策略
    this.maxRetries = 3;
    this.retryDelay = 2000; // 2秒

    this.init();
  }

  /**
   * 初始化离线管理器
   */
  init() {
    // 监听网络状态变化
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());

    // 监听数据变化
    if (this.db) {
      this.db.on('data-changed', (data) => this.handleDataChanged(data));
      this.db.on('sync-complete', (data) => this.handleSyncComplete(data));
      this.db.on('sync-error', (error) => this.handleSyncError(error));
    }

    console.log(`✓ 离线模式管理器初始化完成 (当前状态: ${this.isOnline ? '在线' : '离线'})`);
  }

  /**
   * 处理网络恢复事件
   */
  async handleOnline() {
    console.log('🟢 网络已恢复');
    this.isOnline = true;
    this.isOfflineMode = false;
    this.emit('online');

    // 自动同步待同步数据
    await this.syncPendingOperations();
  }

  /**
   * 处理网络断线事件
   */
  handleOffline() {
    console.log('🔴 网络已断开');
    this.isOnline = false;
    this.isOfflineMode = true;
    this.emit('offline');
  }

  /**
   * 处理数据变化
   */
  handleDataChanged(data) {
    // 如果在离线模式，加入同步队列
    if (this.isOfflineMode) {
      console.log('📝 离线模式下数据变化，已加入同步队列');
      // 数据已经被BaseTestModule自动添加到同步队列
    }
    this.emit('data-changed', data);
  }

  /**
   * 处理同步完成
   */
  handleSyncComplete(data) {
    console.log('✓ 数据同步完成');
    this.emit('sync-complete', data);
  }

  /**
   * 处理同步错误
   */
  handleSyncError(error) {
    console.error('✗ 数据同步出错:', error);
    this.emit('sync-error', error);
  }

  /**
   * 同步待同步的操作
   * @param {Object} options - 选项
   */
  async syncPendingOperations(options = {}) {
    if (!this.isOnline) {
      console.warn('⚠️ 当前处于离线状态，无法同步');
      return false;
    }

    if (this.syncInProgress) {
      console.log('⏳ 同步进行中，请稍候...');
      return false;
    }

    this.syncInProgress = true;
    const startTime = Date.now();

    try {
      console.log('🔄 开始同步待同步数据...');

      // 获取待同步操作
      const pendingOps = await this.db.getPendingSyncs();

      if (pendingOps.length === 0) {
        console.log('✓ 无待同步数据');
        return true;
      }

      // 按操作分类
      const grouped = this.groupOperations(pendingOps);

      // 同步用户数据
      if (grouped.users && grouped.users.length > 0) {
        await this.syncOperations('users', grouped.users);
      }

      // 同步测试记录
      if (grouped.testRecords && grouped.testRecords.length > 0) {
        await this.syncOperations('testRecords', grouped.testRecords);
      }

      // 同步其他数据
      for (const [storeName, ops] of Object.entries(grouped)) {
        if (!['users', 'testRecords'].includes(storeName) && ops.length > 0) {
          await this.syncOperations(storeName, ops);
        }
      }

      const duration = Date.now() - startTime;
      console.log(`✓ 同步完成 (耗时 ${duration}ms)`);
      this.emit('sync-complete', {
        totalOps: pendingOps.length,
        duration
      });

      return true;
    } catch (error) {
      console.error('✗ 同步失败:', error);
      this.emit('sync-error', error);
      return false;
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * 按存储分组待同步操作
   */
  groupOperations(operations) {
    const grouped = {};

    operations.forEach(op => {
      if (!grouped[op.storeName]) {
        grouped[op.storeName] = [];
      }
      grouped[op.storeName].push(op);
    });

    return grouped;
  }

  /**
   * 同步特定存储的操作
   */
  async syncOperations(storeName, operations) {
    console.log(`📤 同步 ${storeName}: ${operations.length} 条操作`);

    for (const op of operations) {
      try {
        await this.syncSingleOperation(op);
        
        // 标记为已同步
        await this.db.update('syncQueue', {
          ...op,
          status: 'completed',
          syncedAt: Date.now()
        });

        this.emit('operation-synced', {
          id: op.id,
          storeName,
          action: op.action
        });
      } catch (error) {
        console.error(`同步操作失败 [${op.id}]:`, error);
        
        // 增加重试次数
        const newOp = {
          ...op,
          retryCount: op.retryCount + 1,
          lastError: error.message,
          status: op.retryCount < this.maxRetries ? 'retry' : 'failed'
        };

        await this.db.update('syncQueue', newOp);

        if (newOp.status === 'failed') {
          this.emit('operation-failed', {
            id: op.id,
            storeName,
            action: op.action,
            error
          });
        }
      }
    }
  }

  /**
   * 同步单个操作
   */
  async syncSingleOperation(operation) {
    const { action, storeName, data } = operation;

    // 发送到服务器
    const response = await this.apiClient.post(`/api/sync/${storeName}`, {
      action,
      data,
      syncId: operation.id,
      timestamp: operation.timestamp
    });

    return response;
  }

  /**
   * 本地操作(离线模式)
   * @param {string} storeName - 表名
   * @param {string} action - 操作类型
   * @param {Object} data - 数据
   */
  async localOperation(storeName, action, data) {
    // 如果在线，直接同步到服务器
    if (this.isOnline) {
      return this.remoteOperation(storeName, action, data);
    }

    // 离线模式：本地存储 + 加入同步队列
    console.log(`📝 离线操作: ${action} ${storeName}`);

    try {
      // 本地操作
      switch (action) {
        case 'add':
          data.id = data.id || `offline_${Date.now()}_${Math.random()}`;
          data._syncStatus = 'pending';
          data._createdAt = Date.now();
          await this.db.add(storeName, data);
          break;

        case 'update':
          data._syncStatus = 'pending';
          data._updatedAt = Date.now();
          await this.db.update(storeName, data);
          break;

        case 'delete':
          await this.db.delete(storeName, data.id);
          break;

        default:
          throw new Error(`未知操作: ${action}`);
      }

      // 加入同步队列
      await this.db.queueSync(action, storeName, data);

      return {
        success: true,
        offline: true,
        id: data.id,
        message: '操作已保存，待网络恢复时同步'
      };
    } catch (error) {
      console.error('本地操作失败:', error);
      throw error;
    }
  }

  /**
   * 远程操作(在线模式)
   */
  async remoteOperation(storeName, action, data) {
    console.log(`🌐 远程操作: ${action} ${storeName}`);

    try {
      // 调用API
      let response;
      switch (action) {
        case 'add':
          response = await this.apiClient.post(`/api/${storeName}`, data);
          // 同时保存到本地缓存
          await this.db.add(storeName, response);
          break;

        case 'update':
          response = await this.apiClient.put(`/api/${storeName}/${data.id}`, data);
          // 同时更新本地缓存
          await this.db.update(storeName, response);
          break;

        case 'delete':
          response = await this.apiClient.delete(`/api/${storeName}/${data.id}`);
          // 删除本地缓存
          await this.db.delete(storeName, data.id);
          break;

        default:
          throw new Error(`未知操作: ${action}`);
      }

      return {
        success: true,
        offline: false,
        data: response
      };
    } catch (error) {
      console.error('远程操作失败:', error);
      
      // 如果网络错误，转为离线模式操作
      if (error.isNetworkError) {
        console.log('💾 网络错误，转为离线操作');
        return this.localOperation(storeName, action, data);
      }

      throw error;
    }
  }

  /**
   * 获取离线模式状态报告
   */
  async getStatus() {
    const stats = await this.db.getStats();
    const pending = await this.db.getPendingSyncs();

    return {
      isOnline: this.isOnline,
      isOfflineMode: this.isOfflineMode,
      syncInProgress: this.syncInProgress,
      pendingOperations: pending.length,
      databaseStats: stats,
      pendingDetails: pending.map(p => ({
        id: p.id,
        action: p.action,
        storeName: p.storeName,
        timestamp: new Date(p.timestamp),
        retryCount: p.retryCount,
        status: p.status
      }))
    };
  }

  /**
   * 手动清理已完成的同步记录
   */
  async cleanupSyncQueue() {
    try {
      const allSyncs = await this.db.getAll('syncQueue');
      const completed = allSyncs.filter(s => s.status === 'completed');
      
      for (const sync of completed) {
        await this.db.delete('syncQueue', sync.id);
      }

      console.log(`✓ 已清理 ${completed.length} 条已完成的同步记录`);
      return completed.length;
    } catch (error) {
      console.error('清理同步队列失败:', error);
      return 0;
    }
  }

  /**
   * 事件监听
   */
  on(event, callback) {
    this.listeners.push({ event, callback });
  }

  /**
   * 移除事件监听
   */
  off(event, callback) {
    this.listeners = this.listeners.filter(
      l => !(l.event === event && l.callback === callback)
    );
  }

  /**
   * 触发事件
   */
  emit(event, data) {
    this.listeners
      .filter(l => l.event === event)
      .forEach(l => {
        try {
          l.callback(data);
        } catch (e) {
          console.error(`事件回调错误 [${event}]:`, e);
        }
      });
  }
}

// 全局单例
let globalOfflineModeManager = null;

/**
 * 获取全局离线模式管理器实例
 */
function getOfflineModeManager() {
  return globalOfflineModeManager;
}

/**
 * 初始化全局离线模式管理器
 */
function initOfflineModeManager(apiClient, indexedDBManager) {
  globalOfflineModeManager = new OfflineModeManager(apiClient, indexedDBManager);
  return globalOfflineModeManager;
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    OfflineModeManager,
    getOfflineModeManager,
    initOfflineModeManager
  };
}
