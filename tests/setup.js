/**
 * Jest 测试环境设置
 * 初始化全局对象和模拟
 */

// 模拟 localStorage
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};

global.localStorage = localStorageMock;

// 模拟 indexedDB
const indexedDBMock = {
  open: jest.fn(() => ({
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  })),
};

global.indexedDB = indexedDBMock;

// 模拟 fetch
global.fetch = jest.fn();

// 重置所有模拟
beforeEach(() => {
  jest.clearAllMocks();
  localStorageMock.getItem.mockClear();
  localStorageMock.setItem.mockClear();
  localStorageMock.removeItem.mockClear();
  localStorageMock.clear.mockClear();
});

// 测试超时
jest.setTimeout(10000);

// 忽略控制台输出（可选）
global.console = {
  ...console,
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
};
