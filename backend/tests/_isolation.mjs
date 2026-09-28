// backend 数据库集成测试的**隔离门禁桥接层**（P3-W0-T02C / AUD-039）。
//
// 设计口径（总控已定，不另行发挥）：
//   · **唯一配置来源** = `TEST_DATABASE_URL` + `TEST_DB_CONTEXT_FILE`（经 `tests/helpers/db-isolation` 体系）；
//     未配置 → **非零拒绝（fail-closed）**，不再 skip、不回落 `DATABASE_URL`、不读业务 dotenv。
//   · **不复制第二份门禁**：全部规则、派生值、运行期核验都来自 `tests/helpers/db-isolation.cjs` 同一实现
//     （本文件只做 ESM 桥接与调用适配）。
//   · 旧的 `REVIEW_TEST_DATABASE_URL` 语义已废弃：相关旧符号保留为**明确报错的迁移指引**，
//     错误信息不含任何连接串/凭据/环境转储。
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 依赖定位不依赖仓库绝对路径（保持旧实现的可移植性）。 */
export const require = createRequire(import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
/** 共享门禁（与 tests/integration、root Jest 同一份实现）。 */
export const gate = require(path.join(repoRoot, 'tests/helpers/db-isolation.cjs'))
export const CODES = gate.CODES
export const derivedNamespace = gate.derivedNamespace

const LEGACY_HINT = 'REVIEW_TEST_DATABASE_URL 体系已废弃（P3-W0-T02C）：请使用 TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE，见 docs/TEST_DATABASE_ISOLATION.md'

/** 旧符号：调用即报错的迁移指引（不泄露任何连接信息）。 */
export function testDbUrl() {
  throw Object.assign(new Error(`[T02C-MIGRATION] ${LEGACY_HINT}`), { code: 'T02C_LEGACY_DISABLED' })
}
export function parseDbUrl() {
  throw Object.assign(new Error(`[T02C-MIGRATION] ${LEGACY_HINT}`), { code: 'T02C_LEGACY_DISABLED' })
}
export function assertIsolationConfig() {
  throw Object.assign(new Error(`[T02C-MIGRATION] ${LEGACY_HINT}`), { code: 'T02C_LEGACY_DISABLED' })
}

/**
 * 读取并校验显式隔离配置（**不抛**，供套件在测试注册阶段决定"拒绝"还是"运行"）。
 * @returns {{ok:true, cfg:object, url:string, db:string, role:string, schemaOf:(key?:string)=>{schema:string,tenantCode:string}}} | {ok:false, code:string, reason:string}
 */
export function loadIsolation(env = process.env) {
  const result = gate.checkIsolationConfig({
    TEST_DATABASE_URL: env.TEST_DATABASE_URL,
    TEST_DB_CONTEXT_FILE: env.TEST_DB_CONTEXT_FILE,
  })
  if (!result.ok) return { ok: false, code: result.code, reason: result.reason, field: result.field || null }
  const cfg = result.cfg
  // 显式派生值落到 process.env.DATABASE_URL（生产 tenantClient 的连接来源；这是**显式配置**而非回退）
  process.env.DATABASE_URL = cfg.url
  const derived = gate.derivedNamespace(cfg.runId)
  return {
    ok: true,
    cfg,
    url: cfg.url,
    db: cfg.database,
    role: cfg.role,
    adminRole: cfg.adminRole,
    derived,
    /** 取派生租户（默认 slot a）：返回 {slot, tenantCode, schema, urlWithSchema} */
    tenant(key = 'a') {
      const schema = cfg.schemas[key]
      const tenantCode = cfg.tenants[key]
      if (!schema || !tenantCode) throw Object.assign(new Error(`[T02C-TENANT] unknown tenant slot: ${key}`), { code: 'T02C_TENANT_SLOT' })
      return { slot: key, tenantCode, schema, urlWithSchema: gate.buildSchemaUrl ? gate.buildSchemaUrl(cfg.url, schema) : `${cfg.url}${cfg.url.includes('?') ? '&' : '?'}schema=${schema}` }
    },
  }
}

/**
 * 供测试体使用：要求配置存在（缺失 → 抛 T02C_ISOLATION_REFUSED；套件在注册阶段已拒绝，这里只是兜底）。
 */
export function requireIsolation() {
  const info = loadIsolation()
  if (!info.ok) {
    throw Object.assign(new Error(`[T02C-ISOLATION-REFUSED] code=${info.code} reason=${info.reason}`), { code: info.code })
  }
  return info
}

/**
 * 运行期核验（**同一** `verifyRuntimeIdentity`）：Prisma 客户端或 pg Client 都接受。
 * @param {object} client Prisma client / interactive tx 或 pg Client
 * @param {string} expectedSchema 期望 schema（必须来自派生值）
 * @param {string} label 诊断标签
 */
export async function assertIsolated(client, expectedSchema, label = 'client') {
  const adapter = typeof client.$queryRawUnsafe === 'function'
    ? { query: async (sql, params = []) => ({ rows: await client.$queryRawUnsafe(sql, ...params) }) }
    : client
  const res = await gate.verifyRuntimeIdentity(adapter, requireIsolation().cfg, { expectedSchema })
  if (!res || res.ok !== true) throw Object.assign(new Error(`[T02C-IDENTITY] ${label} verification failed`), { code: 'RUNTIME_IDENTITY_MISMATCH' })
  // 兼容历史取法：顶层直接暴露 schema（identity.schema 的投影），避免调用方解构差异
  return { ...res, schema: res.identity ? res.identity.schema : null, dbName: res.identity ? res.identity.db : null }
}

/** 范围清理（保留旧语义：必须给出条件；禁止无条件整表删除）。 */
export async function cleanupScoped(db, where, label = 'cleanup') {
  if (!where || Object.keys(where).length === 0) {
    throw new Error(`拒绝执行无范围清理（${label}）：必须给出 created_by / record_code 前缀等条件`)
  }
  return db.testRecord.deleteMany({ where })
}
