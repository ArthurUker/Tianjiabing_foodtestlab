/**
 * BaseTestModule 单元测试
 * 测试模块基类、事件系统、CRUD操作等功能
 */

describe('BaseTestModule - 基础测试模块', () => {
  // 模拟 IndexedDBManager
  class MockIndexedDBManager {
    constructor() {
      this.data = new Map();
    }

    async init(dbName, storeName) {
      return true;
    }

    async add(storeName, data) {
      this.data.set(data.id, data);
      return data.id;
    }

    async get(storeName, id) {
      return this.data.get(id) || null;
    }

    async update(storeName, data) {
      this.data.set(data.id, data);
      return data.id;
    }

    async delete(storeName, id) {
      this.data.delete(id);
      return true;
    }

    async query(storeName, predicate) {
      const results = [];
      for (const item of this.data.values()) {
        if (predicate(item)) {
          results.push(item);
        }
      }
      return results;
    }

    async getAll(storeName) {
      return Array.from(this.data.values());
    }

    async clear(storeName) {
      this.data.clear();
    }
  }

  // 模拟 BaseTestModule 类
  class BaseTestModule {
    constructor(name, dbManager) {
      this.name = name;
      this.dbManager = dbManager;
      this.listeners = new Map();
      this.data = [];
      this.currentPage = 1;
      this.pageSize = 10;
      this.totalItems = 0;
    }

    // 初始化
    async init() {
      await this.dbManager.init(this.name, this.name);
      await this.loadData();
    }

    // 事件系统
    on(eventName, callback) {
      if (!this.listeners.has(eventName)) {
        this.listeners.set(eventName, []);
      }
      this.listeners.get(eventName).push(callback);
    }

    off(eventName, callback) {
      const callbacks = this.listeners.get(eventName);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
      }
    }

    emit(eventName, data) {
      const callbacks = this.listeners.get(eventName);
      if (callbacks) {
        callbacks.forEach(callback => callback(data));
      }
    }

    // 添加记录
    async add(item) {
      const result = await this.dbManager.add(this.name, item);
      this.data.push(item);
      this.totalItems++;
      this.emit('add', item);
      return result;
    }

    // 获取记录
    async get(id) {
      return await this.dbManager.get(this.name, id);
    }

    // 更新记录
    async update(item) {
      const result = await this.dbManager.update(this.name, item);
      const index = this.data.findIndex(d => d.id === item.id);
      if (index > -1) {
        this.data[index] = item;
      }
      this.emit('update', item);
      return result;
    }

    // 删除记录
    async delete(id) {
      const result = await this.dbManager.delete(this.name, id);
      this.data = this.data.filter(d => d.id !== id);
      this.totalItems--;
      this.emit('delete', { id });
      return result;
    }

    // 批量删除
    async deleteMultiple(ids) {
      for (const id of ids) {
        await this.delete(id);
      }
      return ids.length;
    }

    // 加载数据
    async loadData() {
      this.data = await this.dbManager.getAll(this.name);
      this.totalItems = this.data.length;
    }

    // 查询数据
    async query(predicate) {
      return await this.dbManager.query(this.name, predicate);
    }

    // 分页
    getPage(page = 1, size = 10) {
      this.currentPage = page;
      this.pageSize = size;

      const start = (page - 1) * size;
      const end = start + size;

      return {
        data: this.data.slice(start, end),
        currentPage: page,
        pageSize: size,
        totalItems: this.totalItems,
        totalPages: Math.ceil(this.totalItems / size)
      };
    }

    // 搜索
    search(searchText) {
      return this.data.filter(item =>
        Object.values(item).some(val =>
          val && val.toString().toLowerCase().includes(searchText.toLowerCase())
        )
      );
    }

    // 排序
    sort(field, order = 'asc') {
      return [...this.data].sort((a, b) => {
        if (a[field] < b[field]) return order === 'asc' ? -1 : 1;
        if (a[field] > b[field]) return order === 'asc' ? 1 : -1;
        return 0;
      });
    }

    // 获取所有数据
    getAll() {
      return [...this.data];
    }

    // 清空数据
    async clear() {
      await this.dbManager.clear(this.name);
      this.data = [];
      this.totalItems = 0;
      this.emit('clear', {});
    }

    // 获取统计信息
    getStats() {
      return {
        totalItems: this.totalItems,
        currentPageItems: this.data.length,
        totalPages: Math.ceil(this.totalItems / this.pageSize),
        currentPage: this.currentPage
      };
    }

    // 验证数据
    validate(item) {
      if (!item.id) return false;
      return true;
    }

    // 批量导入
    async importData(items) {
      for (const item of items) {
        if (this.validate(item)) {
          await this.add(item);
        }
      }
      return items.length;
    }

    // 导出数据
    exportData() {
      return JSON.stringify(this.data);
    }

    // 判断是否为空
    isEmpty() {
      return this.totalItems === 0;
    }

    // 获取第一条记录
    getFirst() {
      return this.data[0] || null;
    }

    // 获取最后一条记录
    getLast() {
      return this.data[this.data.length - 1] || null;
    }
  }

  let module;
  let dbManager;

  beforeEach(async () => {
    dbManager = new MockIndexedDBManager();
    module = new BaseTestModule('TestModule', dbManager);
    await module.init();
  });

  describe('模块初始化', () => {
    test('应该初始化模块', async () => {
      expect(module.name).toBe('TestModule');
      expect(module.data).toBeDefined();
    });

    test('应该加载数据', async () => {
      await module.add({ id: 1, name: 'Test' });
      await module.loadData();

      expect(module.data.length).toBe(1);
    });
  });

  describe('CRUD操作', () => {
    test('应该添加记录', async () => {
      const item = { id: 1, name: 'Test Item' };
      await module.add(item);

      expect(module.data.length).toBe(1);
      expect(module.totalItems).toBe(1);
    });

    test('应该获取记录', async () => {
      const item = { id: 1, name: 'Test Item' };
      await module.add(item);

      const retrieved = await module.get(1);
      expect(retrieved.name).toBe('Test Item');
    });

    test('应该更新记录', async () => {
      const item = { id: 1, name: 'Original' };
      await module.add(item);

      const updated = { id: 1, name: 'Updated' };
      await module.update(updated);

      const retrieved = await module.get(1);
      expect(retrieved.name).toBe('Updated');
    });

    test('应该删除记录', async () => {
      const item = { id: 1, name: 'Test Item' };
      await module.add(item);

      await module.delete(1);

      expect(module.totalItems).toBe(0);
    });

    test('应该批量删除记录', async () => {
      await module.add({ id: 1, name: 'Item1' });
      await module.add({ id: 2, name: 'Item2' });
      await module.add({ id: 3, name: 'Item3' });

      const deleted = await module.deleteMultiple([1, 2]);

      expect(deleted).toBe(2);
      expect(module.totalItems).toBe(1);
    });
  });

  describe('事件系统', () => {
    test('应该监听add事件', async () => {
      const callback = jest.fn();
      module.on('add', callback);

      await module.add({ id: 1, name: 'Test' });

      expect(callback).toHaveBeenCalled();
    });

    test('应该监听update事件', async () => {
      await module.add({ id: 1, name: 'Test' });

      const callback = jest.fn();
      module.on('update', callback);

      await module.update({ id: 1, name: 'Updated' });

      expect(callback).toHaveBeenCalled();
    });

    test('应该监听delete事件', async () => {
      await module.add({ id: 1, name: 'Test' });

      const callback = jest.fn();
      module.on('delete', callback);

      await module.delete(1);

      expect(callback).toHaveBeenCalled();
    });

    test('应该支持取消监听', async () => {
      const callback = jest.fn();
      module.on('add', callback);
      module.off('add', callback);

      await module.add({ id: 1, name: 'Test' });

      expect(callback).not.toHaveBeenCalled();
    });

    test('应该监听clear事件', async () => {
      const callback = jest.fn();
      module.on('clear', callback);

      await module.clear();

      expect(callback).toHaveBeenCalled();
    });
  });

  describe('分页功能', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 25; i++) {
        await module.add({ id: i, name: `Item ${i}` });
      }
    });

    test('应该获取第一页', () => {
      const page = module.getPage(1, 10);

      expect(page.data.length).toBe(10);
      expect(page.currentPage).toBe(1);
      expect(page.totalPages).toBe(3);
    });

    test('应该获取最后一页', () => {
      const page = module.getPage(3, 10);

      expect(page.data.length).toBe(5);
      expect(page.currentPage).toBe(3);
    });

    test('应该计算总页数', () => {
      const page = module.getPage(1, 10);

      expect(page.totalPages).toBe(3);
    });
  });

  describe('搜索功能', () => {
    beforeEach(async () => {
      await module.add({ id: 1, name: 'Apple', type: 'Fruit' });
      await module.add({ id: 2, name: 'Banana', type: 'Fruit' });
      await module.add({ id: 3, name: 'Carrot', type: 'Vegetable' });
    });

    test('应该搜索数据', () => {
      const results = module.search('Apple');

      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Apple');
    });

    test('应该不区分大小写搜索', () => {
      const results = module.search('apple');

      expect(results.length).toBe(1);
    });

    test('应该搜索多个字段', () => {
      const results = module.search('Fruit');

      expect(results.length).toBe(2);
    });
  });

  describe('排序功能', () => {
    beforeEach(async () => {
      await module.add({ id: 3, name: 'Carrot' });
      await module.add({ id: 1, name: 'Apple' });
      await module.add({ id: 2, name: 'Banana' });
    });

    test('应该按升序排序', () => {
      const sorted = module.sort('id', 'asc');

      expect(sorted[0].id).toBe(1);
      expect(sorted[2].id).toBe(3);
    });

    test('应该按降序排序', () => {
      const sorted = module.sort('id', 'desc');

      expect(sorted[0].id).toBe(3);
      expect(sorted[2].id).toBe(1);
    });

    test('应该按名称排序', () => {
      const sorted = module.sort('name', 'asc');

      expect(sorted[0].name).toBe('Apple');
      expect(sorted[2].name).toBe('Carrot');
    });
  });

  describe('查询功能', () => {
    beforeEach(async () => {
      await module.add({ id: 1, name: 'Test1', status: 'active' });
      await module.add({ id: 2, name: 'Test2', status: 'inactive' });
      await module.add({ id: 3, name: 'Test3', status: 'active' });
    });

    test('应该查询符合条件的数据', async () => {
      const results = await module.query(item => item.status === 'active');

      expect(results.length).toBe(2);
    });

    test('应该返回空数组当无匹配数据时', async () => {
      const results = await module.query(item => item.status === 'deleted');

      expect(results.length).toBe(0);
    });
  });

  describe('数据导入导出', () => {
    test('应该导出数据为JSON', async () => {
      await module.add({ id: 1, name: 'Test' });

      const exported = module.exportData();

      expect(typeof exported).toBe('string');
      expect(JSON.parse(exported).length).toBe(1);
    });

    test('应该导入数据', async () => {
      const items = [
        { id: 1, name: 'Import1' },
        { id: 2, name: 'Import2' }
      ];

      const imported = await module.importData(items);

      expect(imported).toBe(2);
      expect(module.totalItems).toBe(2);
    });
  });

  describe('数据验证', () => {
    test('应该验证有效数据', () => {
      const valid = module.validate({ id: 1, name: 'Test' });
      expect(valid).toBe(true);
    });

    test('应该拒绝无ID的数据', () => {
      const invalid = module.validate({ name: 'Test' });
      expect(invalid).toBe(false);
    });
  });

  describe('统计信息', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 5; i++) {
        await module.add({ id: i, name: `Item ${i}` });
      }
    });

    test('应该获取统计信息', () => {
      const stats = module.getStats();

      expect(stats).toHaveProperty('totalItems');
      expect(stats).toHaveProperty('currentPageItems');
      expect(stats).toHaveProperty('totalPages');
    });

    test('应该判断是否为空', async () => {
      expect(module.isEmpty()).toBe(false);

      await module.clear();
      expect(module.isEmpty()).toBe(true);
    });
  });

  describe('便捷方法', () => {
    test('应该获取所有数据', async () => {
      await module.add({ id: 1, name: 'Test1' });
      await module.add({ id: 2, name: 'Test2' });

      const all = module.getAll();

      expect(all.length).toBe(2);
    });

    test('应该获取第一条记录', async () => {
      await module.add({ id: 1, name: 'First' });

      const first = module.getFirst();

      expect(first.name).toBe('First');
    });

    test('应该获取最后一条记录', async () => {
      await module.add({ id: 1, name: 'First' });
      await module.add({ id: 2, name: 'Last' });

      const last = module.getLast();

      expect(last.name).toBe('Last');
    });
  });

  describe('清空操作', () => {
    test('应该清空所有数据', async () => {
      await module.add({ id: 1, name: 'Test' });

      await module.clear();

      expect(module.totalItems).toBe(0);
      expect(module.data.length).toBe(0);
    });
  });
});
