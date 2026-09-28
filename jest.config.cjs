/**
 * Jest 配置（P2-21）
 * - 项目 package.json 为 "type": "module"（ESM），本配置用 .cjs 后缀以便 Node 正确解析。
 * - 通过 babel-jest + .babelrc(env.test) 将 ESM(import/export) 转译为 CJS，实现 Jest 对 ESM 源码的兼容。
 * - 测试环境使用 jsdom，兼容前端模块（window/document）。
 */
/**
 * P3-CLOSE-B-R1（AUD-040）拆分后的定位：**root 全量面**（unit ∪ db），保留原门禁语义；
 *   · 离线 unit 面 → `jest.unit.config.cjs`（`npm run test:unit`；**不挂**门禁）；
 *   · 需真库的 root 面 → `jest.db.config.cjs`（`npm run test:db`；挂门禁）；
 *   · 本文件 = 两者并集（`npm test` 已改为 `test:unit && test:db` 串行；本配置仍可单独用于基线核对）。
 * `testMatch` 由 shell/Jest 通配改为**逐文件清单**（tests/runners/entry-sets.cjs），
 * 避免 `**` 语义差异与“新增文件静默不在清单”两类漏跑（audit-entry-coverage 守护）。
 */
const { JEST_ROOT_ALL_TESTMATCH } = require('./tests/runners/entry-sets.cjs')

module.exports = {
  testEnvironment: 'jsdom',
  // 全局 setup（在任何测试模块加载前执行）：
  //   1) setup-env.js：为 supertest/superagent 补 TextEncoder；
  //   2) db-isolation-setup.cjs（P3-W0-T02B / AUD-039）：**与 integration 完全同一**的隔离门禁——
  //      缺/错显式 TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE 时在任何 Prisma 客户端创建/连接前拒绝。
  //      合法时在校验后才设置 DATABASE_URL=cfg.url（供生产 tenantClient 兼容）。
  //      AUD-040（P3-CLOSE-B-R1）已把默认入口拆为 unit（离线）/db（门禁），本文件门禁语义保持不变。
  setupFiles: [
    '<rootDir>/tests/setup-env.js',
    '<rootDir>/tests/helpers/db-isolation-setup.cjs',
  ],
  // 逐文件清单（等价于原 `**/tests/**/*.test.js` 去掉被忽略目录后的 29 文件；见 audit-entry-coverage B1）
  testMatch: JEST_ROOT_ALL_TESTMATCH,
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
