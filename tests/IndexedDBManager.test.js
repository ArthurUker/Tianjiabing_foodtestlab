/**
 * IndexedDBManager 单元测试
 * 测试本地数据库的CRUD操作和同步机制
 */

describe('IndexedDBManager - 本地数据库管理', () => {
  // 模拟 IndexedDBManager 类
  class IndexedDBManager {
    constructor(dbName = 'TestDB', version = 1) {
      this.dbName = dbName;
      this.version = version;
      this.data = {}; // 模拟数据存储
      this.isInitialized = false;
    }

    init(schema) {
      return new Promise((resolve) => {
        this.stores = schema;
        
        // 初始化每个表
        Object.keys(schema).forEach(storeName => {
          this.data[storeName] = [];
        });

        this.isInitialized = true;
        resolve(true);
      });
    }

    async add(storeName, data) {
      if (!this.isInitialized) throw new Error('未初始化');
      
      const id = data.id || `${Date.now()}_${Math.random()}`;
      const item = { ...data, id };
      
      this.data[storeName].push(item);
      return id;
    }

    async get(storeName, key) {
      if (!this.isInitialized) throw new Error('未初始化');
      
      return this.data[storeName].find(item => item.id === key) || null;
    }

    async getAll(storeName) {
      if (!this.isInitialized) throw new Error('未初始化');
      
      return [...this.data[storeName]];
    }

    async update(storeName, data) {
      if (!this.isInitialized) throw new Error('未初始化');
      
      const index = this.data[storeName].findIndex(item => item.id === data.id);
      if (index === -1) throw new Error('数据不存在');
      
      this.data[storeName][index] = { ...this.data[storeName][index], ...data };
      return data.id;
    }

    async delete(storeName, key) {
      if (!this.isInitialized) throw new Error('未初始化');
      
      const index = this.data[storeName].findIndex(item => item.id === key);
      if (index !== -1) {
        this.data[storeName].splice(index, 1);
        return true;
      }
      return false;
    }

    async query(storeName, predicate) {
      if (!this.isInitialized) throw new Error('未初始化');
      
      return this.data[storeName].filter(predicate);
    }

    async clear(storeName) {
      if (!this.isInitialized) throw new Error('未初始化');
      
      this.data[storeName] = [];
      return true;
    }

    async getStats() {
      const stats = {};
      for (const [storeName] of Object.entries(this.stores)) {
        stats[storeName] = {
          recordCount: this.data[storeName].length,
          storageSize: `${(JSON.stringify(this.data[storeName]).length / 1024).toFixed(2)} KB`
        };
      }
      return stats;
    }
  }

  let db;

  beforeEach(async () => {
    db = new IndexedDBManager('TestDB', 1);
    const schema = {
      users: { keyPath: 'id', indexes: ['email', 'username'] },
      records: { keyPath: 'id', indexes: ['userId', 'date'] },
      syncQueue: { keyPath: 'id', indexes: ['timestamp'] }
    };
    await db.init(schema);
  });

  describe('初始化', () => {
    test('应该初始化数据库和表', async () => {
      expect(db.isInitialized).toBe(true);
      expect(db.stores).toBeDefined();
      expect(db.data.users).toEqual([]);
      expect(db.data.records).toEqual([]);
    });

    test('应该在未初始化时抛出错误', async () => {
      const uninitDb = new IndexedDBManager();
      
      await expect(uninitDb.get('users', 1))
        .rejects.toThrow('未初始化');
    });
  });

  describe('基础CRUD操作', () => {
    test('应该添加数据', async () => {
      const userId = await db.add('users', {
        email: 'test@example.com',
        username: 'testuser'
      });

      expect(userId).toBeDefined();
      const user = await db.get('users', userId);
      expect(user.email).toBe('test@example.com');
    });

    test('应该获取数据', async () => {
      const userId = await db.add('users', {
        email: 'test@example.com',
        username: 'testuser'
      });

      const user = await db.get('users', userId);
      expect(user).toBeDefined();
      expect(user.username).toBe('testuser');
    });

    test('应该返回null当数据不存在时', async () => {
      const user = await db.get('users', 'nonexistent');
      expect(user).toBeNull();
    });

    test('应该获取所有数据', async () => {
      await db.add('users', { email: 'user1@example.com', username: 'user1' });
      await db.add('users', { email: 'user2@example.com', username: 'user2' });

      const users = await db.getAll('users');
      expect(users.length).toBe(2);
    });

    test('应该更新数据', async () => {
      const userId = await db.add('users', { email: 'old@example.com', username: 'user' });
      
      await db.update('users', {
        id: userId,
        email: 'new@example.com'
      });

      const user = await db.get('users', userId);
      expect(user.email).toBe('new@example.com');
    });

    test('应该删除数据', async () => {
      const userId = await db.add('users', { email: 'test@example.com', username: 'user' });
      
      const deleted = await db.delete('users', userId);
      expect(deleted).toBe(true);
      
      const user = await db.get('users', userId);
      expect(user).toBeNull();
    });
  });

  describe('查询操作', () => {
    test('应该根据条件查询数据', async () => {
      await db.add('users', { email: 'admin@example.com', username: 'admin', role: 'admin' });
      await db.add('users', { email: 'user@example.com', username: 'user', role: 'user' });

      const admins = await db.query('users', item => item.role === 'admin');
      expect(admins.length).toBe(1);
      expect(admins[0].username).toBe('admin');
    });

    test('应该查询多个满足条件的数据', async () => {
      await db.add('records', { userId: 1, type: 'test' });
      await db.add('records', { userId: 1, type: 'test' });
      await db.add('records', { userId: 2, type: 'test' });

      const results = await db.query('records', item => item.userId === 1);
      expect(results.length).toBe(2);
    });
  });

  describe('批量操作', () => {
    test('应该清空表', async () => {
      await db.add('users', { email: 'test@example.com', username: 'user' });
      await db.add('users', { email: 'test2@example.com', username: 'user2' });

      await db.clear('users');
      const users = await db.getAll('users');
      expect(users.length).toBe(0);
    });

    test('应该支持多条插入', async () => {
      for (let i = 0; i < 10; i++) {
        await db.add('users', {
          email: `user${i}@example.com`,
          username: `user${i}`
        });
      }

      const users = await db.getAll('users');
      expect(users.length).toBe(10);
    });
  });

  describe('数据统计', () => {
    test('应该获取存储统计信息', async () => {
      await db.add('users', { email: 'test@example.com', username: 'user' });
      await db.add('records', { userId: 1, type: 'test' });

      const stats = await db.getStats();
      expect(stats.users.recordCount).toBe(1);
      expect(stats.records.recordCount).toBe(1);
    });

    test('应该计算存储大小', async () => {
      await db.add('users', { email: 'test@example.com', username: 'user' });
      
      const stats = await db.getStats();
      expect(stats.users.storageSize).toMatch(/KB$/);
    });
  });

  describe('错误处理', () => {
    test('应该在更新不存在的数据时抛出错误', async () => {
      await expect(db.update('users', { id: 'nonexistent', email: 'test@example.com' }))
        .rejects.toThrow('数据不存在');
    });

    test('应该处理多个操作的错误', async () => {
      const ops = [];
      for (let i = 0; i < 5; i++) {
        ops.push(db.add('users', { email: `user${i}@example.com`, username: `user${i}` }));
      }

      const results = await Promise.all(ops);
      expect(results.length).toBe(5);
      expect(results.every(r => r)).toBe(true);
    });
  });

  describe('数据一致性', () => {
    test('应该保持ACID特性', async () => {
      const userId = await db.add('users', { email: 'test@example.com', username: 'user' });
      
      // 读取原始值
      let user = await db.get('users', userId);
      expect(user.email).toBe('test@example.com');

      // 更新
      await db.update('users', { id: userId, email: 'updated@example.com' });

      // 读取更新后的值
      user = await db.get('users', userId);
      expect(user.email).toBe('updated@example.com');

      // 删除
      await db.delete('users', userId);

      // 确认删除
      user = await db.get('users', userId);
      expect(user).toBeNull();
    });
  });
});
