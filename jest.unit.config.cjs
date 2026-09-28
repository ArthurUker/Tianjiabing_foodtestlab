/**
 * P3-CLOSE-B-R1（AUD-040）— **离线 unit 入口**配置。
 *
 * 语义：tests/*.test.js 中**不需要真库**的文件（显式逐文件清单，见 tests/runners/entry-sets.cjs）。
 *   · **不挂** `tests/helpers/db-isolation-setup.cjs`（无 DB 门禁）→ 缺 TEST_DATABASE_URL / TEST_DB_CONTEXT_FILE 也能跑；
 *   · 不回落 `.env`/`DATABASE_URL`：本入口的用例不连库（audit runner 对 unit 面做 DB 指示符扫描守护）；
 *   · testMatch 用**逐文件绝对化路径**（无 glob），不依赖 shell 的 `**` 展开。
 *
 * 运行：npm run test:unit
 */
const { JEST_UNIT_TESTMATCH } = require('./tests/runners/entry-sets.cjs')

module.exports = {
  displayName: 'unit (offline; no DB gate)',
  testEnvironment: 'jsdom',
  // setupFiles **只保留非 DB 的 setup-env.js**（supertest/superagent 的 TextEncoder polyfill）；
  // **不得**挂 `tests/helpers/db-isolation-setup.cjs`（否则又回到“unit 被全局 DB 门禁绑定”）。
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testMatch: JEST_UNIT_TESTMATCH,
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/integration/', '<rootDir>/tests/isolation/'],
  passWithNoTests: false,
  transform: {
    '^.+\\.js$': ['babel-jest', {
      configFile: false,
      babelrc: false,
      presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
    }],
  },
  moduleFileExtensions: ['js', 'json'],
  collectCoverageFrom: [
    'frontend/js/utils/Validator.js',
    'frontend/js/utils/pathogenRisk.js',
  ],
}
