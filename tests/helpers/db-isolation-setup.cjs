'use strict'
/**
 * P3-W0-T02A — Jest setupFiles 入口（连接前拒绝的统一挂载点）。
 *
 * 直接 Jest config / 单文件入口 / npm run test:integration 都会先执行本文件：
 *   - 配置缺失/冲突/越界 → **抛错**（Jest 该 suite 直接失败，非零退出；不 skip、不降级）；
 *   - 配置通过 → 只做"验证后显式设置"：把 DATABASE_URL 指向本次测试 URL（供生产 tenantClient 兼容），
 *     并清除旧默认通道（TEST_SCHEMA / TEST_ROLE_USER），测试代码不再读取它们。
 *
 * 本文件不做任何连接（连接与身份核验由 tests/helpers/db-isolation.cjs 的 connectGuarded 负责）。
 */
const { checkIsolationConfig, describeRefusal } = require('./db-isolation.cjs')

const result = checkIsolationConfig(process.env)

if (!result.ok) {
  const refusal = describeRefusal(result)
  const detailText = refusal.detail ? ` detail=${JSON.stringify(refusal.detail)}` : ''
  // 只输出安全原因与字段名；不打印 URL、密码或环境转储
  const err = new Error(
    `[T02A-ISOLATION-REFUSED] code=${refusal.code} reason=${refusal.reason}${detailText} | ` +
    'requires explicit TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE (no default, no DATABASE_URL fallback); ' +
    'see docs/TEST_DATABASE_ISOLATION.md'
  )
  err.code = refusal.code // 供入口观测/汇总以结构化方式读取（不含秘密）
  throw err
}

// 验证通过后才显式设置（兼容生产 tenantClient 的 DATABASE_URL 读取；值来自受校验的测试 URL）
process.env.DATABASE_URL = result.cfg.url
// 阻断旧默认通道：本包测试不读取这两个变量
delete process.env.TEST_SCHEMA
delete process.env.TEST_ROLE_USER
