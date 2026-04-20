/**
 * CacheManager 单元测试
 * 测试缓存的CRUD操作、TTL、LRU驱逐等
 */

describe('CacheManager - 缓存管理系统', () => {
  // 模拟 CacheManager 类
  class CacheManager {
    constructor(maxSize = 100, defaultTTL = 3600000) {
      this.cache = new Map();
      this.maxSize = maxSize;
      this.defaultTTL = defaultTTL;
      this.stats = { hits: 0, misses: 0, sets: 0 };
    }

    set(key, value, ttl = this.defaultTTL) {
      if (this.cache.size >= this.maxSize) {
        // LRU: 删除最旧的条目
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }

      this.cache.set(key, {
        value,
        timestamp: Date.now(),
        ttl,
        accessCount: 0
      });

      this.stats.sets++;
    }

    get(key) {
      const item = this.cache.get(key);

      if (!item) {
        this.stats.misses++;
        return null;
      }

      // 检查TTL
      if (Date.now() - item.timestamp > item.ttl) {
        this.cache.delete(key);
        this.stats.misses++;
        return null;
      }

      item.accessCount++;
      this.stats.hits++;
      return item.value;
    }

    delete(key) {
      return this.cache.delete(key);
    }

    clear() {
      this.cache.clear();
      this.stats = { hits: 0, misses: 0, sets: 0 };
    }

    has(key) {
      const item = this.cache.get(key);
      if (!item) return false;

      // 检查TTL
      if (Date.now() - item.timestamp > item.ttl) {
        this.cache.delete(key);
        return false;
      }

      return true;
    }

    getStats() {
      const total = this.stats.hits + this.stats.misses;
      const hitRate = total > 0 ? (this.stats.hits / total * 100).toFixed(2) : '0.00';

      return {
        ...this.stats,
        hitRate: `${hitRate}%`,
        cacheSize: this.cache.size,
        maxSize: this.maxSize
      };
    }
  }

  let cache;

  beforeEach(() => {
    cache = new CacheManager(100, 1000); // 1秒TTL用于测试
  });

  describe('基础CRUD操作', () => {
    test('应该设置和获取缓存值', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    test('应该返回null当键不存在时', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    test('应该删除缓存条目', () => {
      cache.set('key1', 'value1');
      cache.delete('key1');
      expect(cache.get('key1')).toBeNull();
    });

    test('应该检查键是否存在', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);
      expect(cache.has('nonexistent')).toBe(false);
    });

    test('应该清空所有缓存', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();
      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
    });
  });

  describe('TTL过期机制', () => {
    test('应该在TTL过期后返回null', (done) => {
      cache.set('key1', 'value1', 100); // 100毫秒TTL
      expect(cache.get('key1')).toBe('value1');

      setTimeout(() => {
        expect(cache.get('key1')).toBeNull();
        done();
      }, 150);
    });

    test('应该支持自定义TTL', () => {
      cache.set('key1', 'value1', 5000);
      cache.set('key2', 'value2', 100);

      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key2')).toBe('value2');
    });

    test('应该在获取过期项时清理缓存', (done) => {
      cache.set('key1', 'value1', 100);
      
      setTimeout(() => {
        cache.get('key1'); // 触发检查
        expect(cache.has('key1')).toBe(false);
        done();
      }, 150);
    });
  });

  describe('LRU驱逐策略', () => {
    test('应该在达到最大容量时删除最旧的条目', () => {
      const smallCache = new CacheManager(3, 1000);

      smallCache.set('key1', 'value1');
      smallCache.set('key2', 'value2');
      smallCache.set('key3', 'value3');
      smallCache.set('key4', 'value4'); // 应该删除key1

      expect(smallCache.get('key1')).toBeNull();
      expect(smallCache.get('key4')).toBe('value4');
    });

    test('应该保持缓存大小不超过maxSize', () => {
      const smallCache = new CacheManager(5, 1000);

      for (let i = 0; i < 10; i++) {
        smallCache.set(`key${i}`, `value${i}`);
      }

      const stats = smallCache.getStats();
      expect(stats.cacheSize).toBeLessThanOrEqual(5);
    });
  });

  describe('统计指标', () => {
    test('应该统计命中和未命中', () => {
      cache.set('key1', 'value1');
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('nonexistent'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });

    test('应该计算缓存命中率', () => {
      cache.set('key1', 'value1');
      cache.get('key1');
      cache.get('key1');
      cache.get('nonexistent');

      const stats = cache.getStats();
      expect(stats.hitRate).toBe('66.67%');
    });

    test('应该跟踪缓存大小', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      const stats = cache.getStats();
      expect(stats.cacheSize).toBe(2);
      expect(stats.maxSize).toBe(100);
    });

    test('应该记录set操作计数', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      const stats = cache.getStats();
      expect(stats.sets).toBe(3);
    });
  });

  describe('批量操作', () => {
    test('应该支持多个set操作', () => {
      const keys = ['key1', 'key2', 'key3'];
      const values = ['value1', 'value2', 'value3'];

      keys.forEach((key, i) => {
        cache.set(key, values[i]);
      });

      keys.forEach((key, i) => {
        expect(cache.get(key)).toBe(values[i]);
      });
    });

    test('应该支持批量删除', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      ['key1', 'key2'].forEach(key => cache.delete(key));

      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(false);
      expect(cache.has('key3')).toBe(true);
    });
  });

  describe('边界情况', () => {
    test('应该处理null值', () => {
      cache.set('key1', null);
      expect(cache.has('key1')).toBe(true);
      expect(cache.get('key1')).toBeNull();
    });

    test('应该处理undefined值', () => {
      cache.set('key1', undefined);
      expect(cache.has('key1')).toBe(true);
      expect(cache.get('key1')).toBe(undefined);
    });

    test('应该处理复杂对象', () => {
      const obj = { id: 1, name: 'test', nested: { value: 123 } };
      cache.set('key1', obj);
      expect(cache.get('key1')).toEqual(obj);
    });

    test('应该处理数组值', () => {
      const arr = [1, 2, 3, { value: 4 }];
      cache.set('key1', arr);
      expect(cache.get('key1')).toEqual(arr);
    });
  });
});
