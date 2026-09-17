// 数据库集成测试的**隔离门禁**（2026-09-17 审阅 F8 修复）
//
// 旧实现的两个真实缺陷：
//   ① 只检查"整条连接串里是否出现 review_test" → `postgresql://review_test@127.0.0.1/foodsentinel`
//      这种**用户名里含 review_test、库名是生产库**的连接串也能通过；
//   ② `deleteMany({})` 无条件整表删除 → 一旦①被绕过，清理动作本身就是事故。
//
// 现在的规则（在任何客户端创建 / 任何写操作之前执行）：
//   · 专用环境变量 `REVIEW_TEST_DATABASE_URL`；未设置 → 调用方 **SKIP**（绝不回落到 DATABASE_URL）；
//   · **解析连接串**并校验 `pathname` 的库名（不是整串匹配）；
//   · 库名必须匹配 `(^|[_-])(review[_-]?test|drill|test)$` 且**不得**匹配生产黑名单；
//   · schema 必须匹配 `^school_review[a-z0-9_]*$`（禁止 public / 真实学校 schema）；
//   · 运行时再断言 `current_database()` / `current_schema()`（双重确认，写前调用）；
//   · 清理一律带**范围条件**（created_by / record_code 前缀），禁止 deleteMany({})。
import { createRequire } from 'node:module'

/** 依赖定位不依赖仓库绝对路径（旧实现写死 /opt/foodsentinel/backend/package.json，CI 无法独立运行）。 */
export const require = createRequire(import.meta.url)

const ALLOWED_DB_RE = /(^|[_-])(review[_-]?test|drill|test)$/i
const FORBIDDEN_DB_RES = [/^foodsentinel$/i, /^rdpms$/i, /^postgres$/i, /prod/i, /production/i]
const ALLOWED_SCHEMA_RE = /^school_review[a-z0-9_]*$/

export function testDbUrl() {
  return process.env.REVIEW_TEST_DATABASE_URL || ''
}

export function isConfigured() {
  return Boolean(testDbUrl())
}

/** 解析连接串，返回库名/用户/主机（不返回密码，日志里也不打印完整连接串）。 */
export function parseDbUrl(url = testDbUrl()) {
  const u = new URL(url)
  return {
    db: decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: decodeURIComponent(u.username || ''),
    host: u.hostname,
    hasQuery: Boolean(u.search),
  }
}

/**
 * 配置级校验：**必须在创建任何 PrismaClient 之前**调用（不通过直接 throw，避免"带病继续"）。
 * @param {{schema: string}} opts
 */
export function assertIsolationConfig({ schema } = {}) {
  const url = testDbUrl()
  if (!url) throw new Error('SKIP: TEST_DATABASE_URL not configured（未设置 REVIEW_TEST_DATABASE_URL）')
  const { db, user, host } = parseDbUrl(url)
  if (!db) throw new Error('拒绝运行：连接串缺少数据库名')
  if (!ALLOWED_DB_RE.test(db)) {
    throw new Error(`拒绝运行：数据库名 "${db}" 不是测试库（要求以 review_test / drill / _test 结尾）—— 注意用户名或 query 里出现 review_test 不算数`)
  }
  for (const re of FORBIDDEN_DB_RES) {
    if (re.test(db)) throw new Error(`拒绝运行：数据库名 "${db}" 命中生产黑名单 ${re}`)
  }
  if (schema !== undefined) {
    if (typeof schema !== 'string' || !ALLOWED_SCHEMA_RE.test(schema)) {
      throw new Error(`拒绝运行：schema "${schema}" 不是专用测试 schema（要求 school_review…），禁止 public / 真实学校 schema`)
    }
  }
  return { url, db, user, host }
}

/**
 * 运行时校验：在**任何读写之前**调用，确认真实连接与配置一致。
 * @returns {Promise<{db:string, schema:string}>}
 */
export async function assertIsolated(client, expectedDb, label = 'client') {
  const rows = await client.$queryRawUnsafe('SELECT current_database() AS db, current_schema() AS schema')
  const row = rows[0] || {}
  if (row.db !== expectedDb) {
    throw new Error(`安全校验失败：${label} 连到的库是 "${row.db}"，与预期的隔离库 "${expectedDb}" 不一致`)
  }
  if (!ALLOWED_DB_RE.test(row.db) || FORBIDDEN_DB_RES.some((re) => re.test(row.db))) {
    throw new Error(`安全校验失败：${label} 连到的库名 "${row.db}" 不像测试库`)
  }
  return { db: row.db, schema: row.schema }
}

/** 范围清理（替代 deleteMany({})）：只删本套件创建的记录。 */
export async function cleanupScoped(db, where, label = 'cleanup') {
  if (!where || Object.keys(where).length === 0) {
    throw new Error(`拒绝执行无范围清理（${label}）：必须给出 created_by / record_code 前缀等条件`)
  }
  return db.testRecord.deleteMany({ where })
}
