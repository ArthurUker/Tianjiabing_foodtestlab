// tests/isolation/jest.isolation.config.cjs
//
// P3-W0-T02A — 门禁纯单元/受控替身回归的独立 Jest 配置（**不需要 PG、不连库**）。
// 与 root Jest / integration 配置彼此独立，避免影响既有套件基线。
//
// 运行：npx jest --config tests/isolation/jest.isolation.config.cjs
module.exports = {
  testEnvironment: 'node',
  rootDir: '../..',
  testMatch: ['**/tests/isolation/**/*.test.cjs'],
  testTimeout: 30000,
}
