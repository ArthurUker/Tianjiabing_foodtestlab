// tests/integration/jest.integration.config.cjs
//
// 并发竞态集成测试专用配置（区别于默认单测套件）：
// - testEnvironment 用 'node'（真实定时器/连接池，贴近并发竞态现场）
// - 不收集前端覆盖率，不跑 jsdom
// - 只匹配 tests/integration 下的 .test.js
//
// 运行：npm run test:integration（或 npx jest --config <本文件>）
// 前置（P3-W0-T02A 起为强制）：显式 TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE，
//   指向本任务独占 PG 实例与受限角色；无默认值、无 DATABASE_URL fallback。
//   setupFiles 在**任何测试文件/连接之前**执行配置校验：缺失/冲突/越界 → 直接失败（非零，不 skip）。
//   见 docs/TEST_DATABASE_ISOLATION.md 与 tests/helpers/db-isolation.cjs。

module.exports = {
  testEnvironment: 'node',
  rootDir: '../..',
  testMatch: ['**/tests/integration/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/helpers/db-isolation-setup.cjs'],
  transform: {
    // 内联 babel preset，确保 backend/ 下的 ESM 源码（含独立 package.json 边界）
    // 也能被转译为 CJS，不依赖仓库根的 .babelrc（文件相对配置不跨 package 边界）。
    '^.+\\.js$': [
      'babel-jest',
      {
        presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
      },
    ],
  },
  moduleFileExtensions: ['js', 'json'],
  // backend/ 有独立 node_modules（含 @prisma/client）；让根目录下的测试也能解析到它
  moduleDirectories: ['node_modules', '<rootDir>/backend/node_modules'],
  testTimeout: 60000,
}
