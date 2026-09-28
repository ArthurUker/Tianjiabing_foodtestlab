/**
 * P3-CLOSE-B-R1（AUD-040）— **DB 入口**配置（root 面里需要真库的文件；显式逐文件清单）。
 *
 * 门禁（与 integration 完全同一实现，AUD-039）：`tests/helpers/db-isolation-setup.cjs`
 *   · 缺 `TEST_DATABASE_URL` 或 `TEST_DB_CONTEXT_FILE`（或配置冲突/越界）→ **任何测试模块加载前抛错**：
 *     非零退出、**0 用例执行、0 skip**；
 *   · **不回落** `DATABASE_URL`、不读业务 `.env`；合法时才在校验后把 `DATABASE_URL` 指向受校验的测试 URL。
 *
 * 运行：npm run test:db
 */
const { JEST_DB_TESTMATCH } = require('./tests/runners/entry-sets.cjs')

module.exports = {
  displayName: 'db (isolated PG; gate enforced)',
  testEnvironment: 'node',
  setupFiles: [
    '<rootDir>/tests/setup-env.js',
    '<rootDir>/tests/helpers/db-isolation-setup.cjs',
  ],
  testMatch: JEST_DB_TESTMATCH,
  testPathIgnorePatterns: ['/node_modules/'],
  passWithNoTests: false,
  transform: {
    '^.+\\.js$': ['babel-jest', {
      configFile: false,
      babelrc: false,
      presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
    }],
  },
  moduleFileExtensions: ['js', 'json'],
  moduleDirectories: ['node_modules', '<rootDir>/backend/node_modules'],
  testTimeout: 60000,
}
