/**
 * Jest 配置（P2-21）
 * - 项目 package.json 为 "type": "module"（ESM），本配置用 .cjs 后缀以便 Node 正确解析。
 * - 通过 babel-jest + .babelrc(env.test) 将 ESM(import/export) 转译为 CJS，实现 Jest 对 ESM 源码的兼容。
 * - 测试环境使用 jsdom，兼容前端模块（window/document）。
 */
module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['**/tests/**/*.test.js'],
  transform: {
    '^.+\\.js$': 'babel-jest',
  },
  moduleFileExtensions: ['js', 'json'],
  collectCoverageFrom: [
    'js/utils/Validator.js',
    'js/utils/pathogenRisk.js',
  ],
};
