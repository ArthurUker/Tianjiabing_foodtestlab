// tests/integration/jest.integration.config.cjs
//
// 并发竞态集成测试专用配置（区别于默认单测套件）：
// - testEnvironment 用 'node'（真实定时器/连接池，贴近并发竞态现场）
// - 不收集前端覆盖率，不跑 jsdom
// - 只匹配 tests/integration 下的 .test.js
//
// 运行：npm run test:integration
// 前置：需要一个可达的 PostgreSQL（见 pg-bootstrap.js 的 getDatabaseUrl）。
//       本机可用 brew 安装的 PG；CI 可注入 DATABASE_URL。

module.exports = {
  testEnvironment: 'node',
  rootDir: '../..',
  testMatch: ['**/tests/integration/**/*.test.js'],
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
