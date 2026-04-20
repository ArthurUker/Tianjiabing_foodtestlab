/**
 * ConfigManager 单元测试
 * 测试配置管理、环境配置、嵌套配置等功能
 */

describe('ConfigManager - 配置管理', () => {
  // 模拟 ConfigManager 类
  class ConfigManager {
    constructor() {
      this.config = {};
      this.defaults = {};
      this.env = process.env.NODE_ENV || 'development';
    }

    // 设置配置
    set(key, value) {
      const keys = key.split('.');
      let obj = this.config;

      for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]]) {
          obj[keys[i]] = {};
        }
        obj = obj[keys[i]];
      }

      obj[keys[keys.length - 1]] = value;
    }

    // 获取配置
    get(key, defaultValue = null) {
      const keys = key.split('.');
      let obj = this.config;

      for (const k of keys) {
        if (obj && typeof obj === 'object' && k in obj) {
          obj = obj[k];
        } else {
          return defaultValue !== null ? defaultValue : this.defaults[key];
        }
      }

      return obj;
    }

    // 设置默认值
    setDefault(key, value) {
      this.defaults[key] = value;
    }

    // 批量设置配置
    setMultiple(configs) {
      for (const [key, value] of Object.entries(configs)) {
        this.set(key, value);
      }
    }

    // 获取所有配置
    getAll() {
      return JSON.parse(JSON.stringify(this.config));
    }

    // 获取子配置对象
    getSection(section) {
      return this.get(section, {});
    }

    // 检查配置是否存在
    has(key) {
      return this.get(key) !== null;
    }

    // 删除配置
    delete(key) {
      const keys = key.split('.');
      let obj = this.config;

      for (let i = 0; i < keys.length - 1; i++) {
        if (obj[keys[i]]) {
          obj = obj[keys[i]];
        } else {
          return false;
        }
      }

      delete obj[keys[keys.length - 1]];
      return true;
    }

    // 重置配置
    reset() {
      this.config = {};
    }

    // 加载环境变量
    loadEnv() {
      if (process.env.API_URL) {
        this.set('api.url', process.env.API_URL);
      }
      if (process.env.API_KEY) {
        this.set('api.key', process.env.API_KEY);
      }
      if (process.env.DATABASE_URL) {
        this.set('database.url', process.env.DATABASE_URL);
      }
    }

    // 获取当前环境
    getEnv() {
      return this.env;
    }

    // 检查是否为生产环境
    isProduction() {
      return this.env === 'production';
    }

    // 检查是否为开发环境
    isDevelopment() {
      return this.env === 'development';
    }

    // 合并配置
    merge(otherConfig) {
      const merged = { ...this.config };

      const deepMerge = (target, source) => {
        for (const key in source) {
          if (typeof source[key] === 'object' && !Array.isArray(source[key])) {
            target[key] = deepMerge(target[key] || {}, source[key]);
          } else {
            target[key] = source[key];
          }
        }
        return target;
      };

      return deepMerge(merged, otherConfig);
    }

    // 验证必需的配置
    validate(requiredKeys) {
      const missing = [];

      for (const key of requiredKeys) {
        if (!this.has(key)) {
          missing.push(key);
        }
      }

      return {
        valid: missing.length === 0,
        missing
      };
    }

    // 冻结配置 (使其不可修改)
    freeze() {
      this.config = Object.freeze(this.config);
    }

    // 导出为JSON
    exportJSON() {
      return JSON.stringify(this.config, null, 2);
    }

    // 导入JSON
    importJSON(jsonString) {
      try {
        this.config = JSON.parse(jsonString);
        return true;
      } catch (error) {
        return false;
      }
    }
  }

  let configManager;

  beforeEach(() => {
    configManager = new ConfigManager();
  });

  describe('基础配置操作', () => {
    test('应该设置配置值', () => {
      configManager.set('app.name', 'TestApp');

      expect(configManager.get('app.name')).toBe('TestApp');
    });

    test('应该获取配置值', () => {
      configManager.set('app.version', '1.0.0');

      const version = configManager.get('app.version');
      expect(version).toBe('1.0.0');
    });

    test('应该返回默认值当配置不存在时', () => {
      const value = configManager.get('nonexistent', 'default');

      expect(value).toBe('default');
    });

    test('应该设置多层嵌套配置', () => {
      configManager.set('database.connection.host', 'localhost');
      configManager.set('database.connection.port', 5432);

      expect(configManager.get('database.connection.host')).toBe('localhost');
      expect(configManager.get('database.connection.port')).toBe(5432);
    });
  });

  describe('默认值管理', () => {
    test('应该设置默认值', () => {
      configManager.setDefault('timeout', 5000);

      const value = configManager.get('timeout');
      expect(value).toBe(5000);
    });

    test('应该在值不存在时使用默认值', () => {
      configManager.setDefault('retries', 3);

      const value = configManager.get('api.retries');
      expect(value).toBe(3);
    });
  });

  describe('批量操作', () => {
    test('应该批量设置配置', () => {
      configManager.setMultiple({
        'app.name': 'MyApp',
        'app.version': '2.0.0',
        'api.timeout': 3000
      });

      expect(configManager.get('app.name')).toBe('MyApp');
      expect(configManager.get('app.version')).toBe('2.0.0');
      expect(configManager.get('api.timeout')).toBe(3000);
    });

    test('应该获取所有配置', () => {
      configManager.set('a', 1);
      configManager.set('b', 2);

      const all = configManager.getAll();

      expect(all).toHaveProperty('a');
      expect(all).toHaveProperty('b');
    });
  });

  describe('配置检查', () => {
    test('应该检查配置是否存在', () => {
      configManager.set('api.url', 'http://localhost');

      expect(configManager.has('api.url')).toBe(true);
      expect(configManager.has('api.missing')).toBe(false);
    });

    test('应该获取子配置对象', () => {
      configManager.set('database.host', 'localhost');
      configManager.set('database.port', 5432);

      const dbConfig = configManager.getSection('database');

      expect(dbConfig).toHaveProperty('host');
      expect(dbConfig).toHaveProperty('port');
    });
  });

  describe('配置删除', () => {
    test('应该删除配置', () => {
      configManager.set('temp.data', 'value');

      configManager.delete('temp.data');

      expect(configManager.get('temp.data')).toBeNull();
    });

    test('应该重置所有配置', () => {
      configManager.set('a', 1);
      configManager.set('b', 2);

      configManager.reset();

      const all = configManager.getAll();
      expect(Object.keys(all).length).toBe(0);
    });
  });

  describe('环境配置', () => {
    test('应该获取当前环境', () => {
      const env = configManager.getEnv();

      expect(['development', 'production', 'test']).toContain(env);
    });

    test('应该判断是否为生产环境', () => {
      const isProduction = configManager.isProduction();

      expect(typeof isProduction).toBe('boolean');
    });

    test('应该判断是否为开发环境', () => {
      const isDevelopment = configManager.isDevelopment();

      expect(typeof isDevelopment).toBe('boolean');
    });
  });

  describe('环境变量加载', () => {
    test('应该从环境变量加载配置', () => {
      process.env.API_URL = 'http://api.example.com';

      configManager.loadEnv();

      expect(configManager.get('api.url')).toBe('http://api.example.com');
    });

    test('应该处理缺失的环境变量', () => {
      delete process.env.API_URL;

      configManager.loadEnv();

      // 不应该抛出错误
      expect(true).toBe(true);
    });
  });

  describe('配置合并', () => {
    test('应该合并配置对象', () => {
      configManager.set('a', 1);
      configManager.set('b', 2);

      const merged = configManager.merge({ b: 20, c: 3 });

      expect(merged.a).toBe(1);
      expect(merged.b).toBe(20);
      expect(merged.c).toBe(3);
    });

    test('应该递归合并嵌套配置', () => {
      configManager.set('app.name', 'Test');
      configManager.set('app.version', '1.0');

      const merged = configManager.merge({
        app: { version: '2.0', author: 'Me' }
      });

      expect(merged.app.name).toBe('Test');
      expect(merged.app.version).toBe('2.0');
      expect(merged.app.author).toBe('Me');
    });
  });

  describe('配置验证', () => {
    test('应该验证必需的配置', () => {
      configManager.set('api.url', 'http://localhost');
      configManager.set('api.key', 'secret');

      const result = configManager.validate(['api.url', 'api.key']);

      expect(result.valid).toBe(true);
      expect(result.missing.length).toBe(0);
    });

    test('应该找到缺失的配置', () => {
      configManager.set('api.url', 'http://localhost');

      const result = configManager.validate(['api.url', 'api.key', 'api.timeout']);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain('api.key');
      expect(result.missing).toContain('api.timeout');
    });
  });

  describe('导入导出', () => {
    test('应该导出为JSON', () => {
      configManager.set('app.name', 'TestApp');

      const json = configManager.exportJSON();

      expect(typeof json).toBe('string');
      expect(json).toContain('TestApp');
    });

    test('应该导入JSON', () => {
      const json = JSON.stringify({
        app: { name: 'ImportedApp' },
        api: { url: 'http://localhost' }
      });

      const result = configManager.importJSON(json);

      expect(result).toBe(true);
      expect(configManager.get('app.name')).toBe('ImportedApp');
    });

    test('应该处理无效的JSON', () => {
      const result = configManager.importJSON('invalid json');

      expect(result).toBe(false);
    });
  });

  describe('配置冻结', () => {
    test('应该冻结配置', () => {
      configManager.set('immutable', true);
      configManager.freeze();

      expect(() => {
        configManager.config.new_value = 'should fail';
      }).toThrow();
    });
  });

  describe('复杂配置场景', () => {
    test('应该处理多层级配置', () => {
      configManager.setMultiple({
        'app.name': 'MyApp',
        'app.version': '1.0.0',
        'database.production.host': 'prod.db.com',
        'database.production.port': 5432,
        'database.development.host': 'localhost',
        'database.development.port': 5432,
        'api.endpoints.users': '/api/users',
        'api.endpoints.posts': '/api/posts'
      });

      expect(configManager.get('database.production.host')).toBe('prod.db.com');
      expect(configManager.get('api.endpoints.users')).toBe('/api/users');
    });

    test('应该支持动态配置更新', () => {
      configManager.set('cache.ttl', 300);
      expect(configManager.get('cache.ttl')).toBe(300);

      configManager.set('cache.ttl', 600);
      expect(configManager.get('cache.ttl')).toBe(600);
    });

    test('应该配置覆盖', () => {
      configManager.set('api.timeout', 5000);
      configManager.set('api.timeout', 3000);

      expect(configManager.get('api.timeout')).toBe(3000);
    });
  });

  describe('边界情况', () => {
    test('应该处理空值配置', () => {
      configManager.set('empty', null);

      expect(configManager.get('empty')).toBeNull();
    });

    test('应该处理布尔值配置', () => {
      configManager.set('debug.enabled', true);

      expect(configManager.get('debug.enabled')).toBe(true);
    });

    test('应该处理数组配置', () => {
      configManager.set('allowed.origins', ['http://localhost:3000', 'http://example.com']);

      const origins = configManager.get('allowed.origins');
      expect(Array.isArray(origins)).toBe(true);
      expect(origins.length).toBe(2);
    });

    test('应该处理对象配置', () => {
      configManager.set('custom.data', { nested: { value: 123 } });

      const data = configManager.get('custom.data');
      expect(data.nested.value).toBe(123);
    });
  });
});
