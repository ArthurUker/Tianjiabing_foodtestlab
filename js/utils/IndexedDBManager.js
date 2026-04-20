/**
 * IndexedDB管理器 - 本地数据库管理
 * 
 * 功能:
 * - 初始化和管理IndexedDB数据库
 * - 支持多表CRUD操作
 * - 数据版本控制
 * - 自动同步机制
 * - 查询过滤和排序
 * 
 * 使用场景:
 * - 大规模数据本地存储
 * - 离线模式支持
 * - 性能优化(减少网络请求)
 * - 长期数据持久化
 */

class IndexedDBManager {
  constructor(dbName = 'FoodTestLabDB', version = 1) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;
    this.stores = {};
    this.isInitialized = false;
    this.syncQueue = [];
    this.isSyncing = false;
    this.listeners = [];
  }

  /**
   * 初始化数据库
   * @param {Object} schema - 数据库架构定义
   * @example
   * manager.init({
   *   users: { keyPath: 'id', indexes: ['email', 'username'] },
   *   testRecords: { keyPath: 'id', indexes: ['userId', 'date', 'type'] },
   *   syncLog: { keyPath: 'id', indexes: ['timestamp'] }
   * })
   */
  init(schema) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => {
        console.error('IndexedDB初始化失败:', request.error);
        reject(new Error(`数据库打开失败: ${request.error}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.stores = schema;
        this.isInitialized = true;
        console.log('✓ IndexedDB初始化成功');
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        console.log('📦 升级数据库架构...');

        // 创建所有表
        Object.entries(schema).forEach(([storeName, config]) => {
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, {
              keyPath: config.keyPath,
              autoIncrement: config.autoIncrement !== false
            });

            // 创建索引
            if (config.indexes && Array.isArray(config.indexes)) {
              config.indexes.forEach(indexName => {
                try {
                  store.createIndex(indexName, indexName, { unique: false });
                } catch (e) {
                  console.warn(`索引创建失败: ${indexName}`, e);
                }
              });
            }
          }
        });

        console.log('✓ 数据库架构创建完成');
      };
    });
  }

  /**
   * 添加记录
   * @param {string} storeName - 表名
   * @param {Object} data - 数据
   */
  async add(storeName, data) {
    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.add(data);

      request.onsuccess = () => {
        console.log(`✓ 添加记录到 ${storeName}:`, request.result);
        this.emit('data-changed', { action: 'add', store: storeName, data });
        resolve(request.result);
      };

      request.onerror = () => reject(new Error(`添加失败: ${request.error}`));
    });
  }

  /**
   * 获取记录
   * @param {string} storeName - 表名
   * @param {*} key - 主键
   */
  async get(storeName, key) {
    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`查询失败: ${request.error}`));
    });
  }

  /**
   * 获取所有记录
   * @param {string} storeName - 表名
   * @param {Object} options - 选项 { limit, offset, index, range }
   */
  async getAll(storeName, options = {}) {
    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);

      let results = [];
      let request;

      // 如果指定了索引，使用索引查询
      if (options.index) {
        const index = store.index(options.index);
        request = options.range 
          ? index.getAll(options.range)
          : index.getAll();
      } else {
        request = store.getAll();
      }

      request.onsuccess = () => {
        results = request.result;

        // 应用分页
        if (options.limit) {
          const offset = options.offset || 0;
          results = results.slice(offset, offset + options.limit);
        }

        resolve(results);
      };

      request.onerror = () => reject(new Error(`查询失败: ${request.error}`));
    });
  }

  /**
   * 更新记录
   * @param {string} storeName - 表名
   * @param {Object} data - 数据(必须包含主键)
   */
  async update(storeName, data) {
    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(data);

      request.onsuccess = () => {
        console.log(`✓ 更新记录 ${storeName}:`, request.result);
        this.emit('data-changed', { action: 'update', store: storeName, data });
        resolve(request.result);
      };

      request.onerror = () => reject(new Error(`更新失败: ${request.error}`));
    });
  }

  /**
   * 删除记录
   * @param {string} storeName - 表名
   * @param {*} key - 主键
   */
  async delete(storeName, key) {
    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(key);

      request.onsuccess = () => {
        console.log(`✓ 删除记录 ${storeName}:`, key);
        this.emit('data-changed', { action: 'delete', store: storeName, key });
        resolve(true);
      };

      request.onerror = () => reject(new Error(`删除失败: ${request.error}`));
    });
  }

  /**
   * 批量删除记录
   * @param {string} storeName - 表名
   * @param {Array} keys - 主键数组
   */
  async deleteMultiple(storeName, keys) {
    if (!this.db) throw new Error('数据库未初始化');

    const results = [];
    for (const key of keys) {
      try {
        results.push(await this.delete(storeName, key));
      } catch (e) {
        console.error(`删除失败: ${key}`, e);
        results.push(false);
      }
    }
    return results;
  }

  /**
   * 清空表
   * @param {string} storeName - 表名
   */
  async clear(storeName) {
    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.clear();

      request.onsuccess = () => {
        console.log(`✓ 表 ${storeName} 已清空`);
        resolve(true);
      };

      request.onerror = () => reject(new Error(`清空失败: ${request.error}`));
    });
  }

  /**
   * 查询记录(条件查询)
   * @param {string} storeName - 表名
   * @param {Function} predicate - 条件函数
   */
  async query(storeName, predicate) {
    const allRecords = await this.getAll(storeName);
    return allRecords.filter(predicate);
  }

  /**
   * 查询记录(索引查询)
   * @param {string} storeName - 表名
   * @param {string} indexName - 索引名
   * @param {*} value - 索引值
   */
  async queryByIndex(storeName, indexName, value) {
    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(value);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`查询失败: ${request.error}`));
    });
  }

  /**
   * 范围查询
   * @param {string} storeName - 表名
   * @param {string} indexName - 索引名
   * @param {IDBKeyRange} range - 范围对象
   */
  async queryByRange(storeName, indexName, range) {
    if (!this.db) throw new Error('数据库未初始化');

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(range);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`范围查询失败: ${request.error}`));
    });
  }

  /**
   * 添加到同步队列(用于离线模式)
   * @param {string} action - 操作类型 (add/update/delete)
   * @param {string} storeName - 表名
   * @param {Object} data - 数据
   */
  async queueSync(action, storeName, data) {
    const syncItem = {
      id: `${Date.now()}_${Math.random()}`,
      timestamp: Date.now(),
      action,
      storeName,
      data,
      retryCount: 0,
      status: 'pending'
    };

    try {
      await this.add('syncQueue', syncItem);
      console.log(`✓ 操作已加入同步队列:`, syncItem.id);
      return syncItem.id;
    } catch (e) {
      console.error('同步队列写入失败:', e);
      throw e;
    }
  }

  /**
   * 获取待同步的操作列表
   */
  async getPendingSyncs() {
    try {
      const syncs = await this.query('syncQueue', item => 
        item.status === 'pending' || item.status === 'retry'
      );
      return syncs.sort((a, b) => a.timestamp - b.timestamp);
    } catch (e) {
      console.error('获取待同步数据失败:', e);
      return [];
    }
  }

  /**
   * 执行离线同步(当网络恢复时调用)
   * @param {Function} syncFunction - 同步函数(接收待同步数据数组)
   */
  async executeSync(syncFunction) {
    if (this.isSyncing) {
      console.log('⏳ 同步进行中，请稍候...');
      return;
    }

    this.isSyncing = true;
    const pending = await this.getPendingSyncs();

    if (pending.length === 0) {
      console.log('✓ 无待同步数据');
      this.isSyncing = false;
      return;
    }

    console.log(`🔄 开始同步 ${pending.length} 条数据...`);

    try {
      // 按批次同步(每批100条)
      const batchSize = 100;
      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        
        try {
          const results = await syncFunction(batch);
          
          // 标记已同步的项
          for (const item of batch) {
            await this.update('syncQueue', {
              ...item,
              status: 'completed',
              syncedAt: Date.now()
            });
          }
          
          console.log(`✓ 已同步第 ${i + batch.length}/${pending.length} 条`);
        } catch (batchError) {
          console.error(`批次同步失败:`, batchError);
          
          // 更新重试次数
          for (const item of batch) {
            await this.update('syncQueue', {
              ...item,
              retryCount: item.retryCount + 1,
              status: item.retryCount < 3 ? 'retry' : 'failed',
              lastError: batchError.message
            });
          }
        }
      }

      console.log('✓ 同步完成');
      this.emit('sync-complete', { totalSynced: pending.length });
    } catch (error) {
      console.error('同步过程出错:', error);
      this.emit('sync-error', error);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 获取数据库统计信息
   */
  async getStats() {
    const stats = {};

    for (const [storeName] of Object.entries(this.stores)) {
      try {
        const allRecords = await this.getAll(storeName);
        const storageSize = JSON.stringify(allRecords).length;
        stats[storeName] = {
          recordCount: allRecords.length,
          storageSize: `${(storageSize / 1024).toFixed(2)} KB`
        };
      } catch (e) {
        stats[storeName] = { error: e.message };
      }
    }

    return stats;
  }

  /**
   * 导出数据为JSON
   * @param {string} storeName - 表名(可选，不指定则导出全部)
   */
  async exportToJSON(storeName) {
    const data = {};

    if (storeName) {
      // 导出单个表
      data[storeName] = await this.getAll(storeName);
    } else {
      // 导出所有表
      for (const [name] of Object.entries(this.stores)) {
        data[name] = await this.getAll(name);
      }
    }

    return data;
  }

  /**
   * 从JSON导入数据
   * @param {Object} data - 数据对象
   */
  async importFromJSON(data) {
    let imported = 0;

    for (const [storeName, records] of Object.entries(data)) {
      if (!Array.isArray(records)) continue;

      for (const record of records) {
        try {
          await this.add(storeName, record);
          imported++;
        } catch (e) {
          console.warn(`导入失败: ${storeName}`, e);
        }
      }
    }

    console.log(`✓ 已导入 ${imported} 条数据`);
    return imported;
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
      .forEach(l => l.callback(data));
  }

  /**
   * 关闭数据库
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('✓ 数据库已关闭');
    }
  }
}

// 全局单例
let globalIndexedDBManager = null;

/**
 * 获取全局IndexedDB管理器实例
 */
function getIndexedDBManager() {
  if (!globalIndexedDBManager) {
    globalIndexedDBManager = new IndexedDBManager();
  }
  return globalIndexedDBManager;
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IndexedDBManager, getIndexedDBManager };
}
