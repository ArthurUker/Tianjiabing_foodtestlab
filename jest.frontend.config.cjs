/**
 * P3-CLOSE-B-R1（AUD-040）— `test:frontend` 的**fail-closed** 专用配置。
 *
 * 背景（只读盘点 `P3-CLOSE-T01/phaseB/INVENTORY.md` §3.3）：旧 `test:frontend` = `jest tests/**\/*.test.js`，
 * 在 `sh` 下 `**` ≡ `*` → 实际命中 `tests/integration/*.test.js`（**不是前端**），而 root 配置又忽略该目录
 * → 入口“名不副实且静默落空”。本配置把它改为**显式失败**：没有前端套件时以非零退出并给出指引，
 * 既不伪装成通过，也不删除既有入口声明（替代入口 = 本配置 + docs/TEST_DATABASE_ISOLATION.md §10）。
 *
 * 运行：npm run test:frontend（在补充 tests/frontend/**\/*.test.js 之前，预期 rc≠0 且无任何用例执行）
 */
module.exports = {
  displayName: 'frontend (no suite yet — fail-closed)',
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/tests/frontend/**/*.test.js'],
  passWithNoTests: false,
  moduleFileExtensions: ['js', 'json'],
}
