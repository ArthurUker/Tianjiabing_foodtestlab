/**
 * Jest 配置（P2-21）
 * - 项目 package.json 为 "type": "module"（ESM），本配置用 .cjs 后缀以便 Node 正确解析。
 * - 通过 babel-jest + .babelrc(env.test) 将 ESM(import/export) 转译为 CJS，实现 Jest 对 ESM 源码的兼容。
 * - 测试环境使用 jsdom，兼容前端模块（window/document）。
 */
module.exports = {
  testEnvironment: 'jsdom',
  // 全局 setup（在任何测试模块加载前执行）：为 supertest/superagent 补 TextEncoder
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testMatch: ['**/tests/**/*.test.js'],
  // 并发竞态集成测试需要 live PostgreSQL，单独用 tests/integration/jest.integration.config.cjs 运行，
  // 不纳入默认单测套件（避免无 PG 环境 npm test 失败）。
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/integration/'],
  // 内联 babel 配置：backend/ 是独立 package（有自己的 package.json），根 .babelrc 不会
  // 跨包生效，导致 tests/ 引用 backend/lib/*.js（如 securityGuards.js）时 ESM 未被转译。
  // 此处显式指定 preset（与根 .babelrc 的 env.test 等价），并禁用文件级配置查找，保证
  // 所有被测模块（含 backend 包内）走同一转译管线。
  transform: {
    '^.+\\.js$': ['babel-jest', {
      configFile: false,
      babelrc: false,
      presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
    }],
  },
  moduleFileExtensions: ['js', 'json'],
  // 前端源码已迁入 frontend/js/，覆盖率收集路径同步更新
  collectCoverageFrom: [
    'frontend/js/utils/Validator.js',
    'frontend/js/utils/pathogenRisk.js',
  ],
};
