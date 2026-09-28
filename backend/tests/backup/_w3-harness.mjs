// P3-W3-T01 集成测试共用桥（不是测试：文件名不以 .test.mjs 结尾，node --test 不会收集）。
//
// 职责（只做“配置读取 + 隔离身份核验 + 现场观测”，不含任何业务断言）：
//   · 唯一配置来源：provisioner 的 TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE（隔离契约）
//     以及本包 fixture 产出的 W3_* / BACKUP_* 环境（管理连接、备份目录、台账目录、测试密钥）；
//   · 任一缺失 → ok:false（调用方在注册阶段 fail-closed 拒绝，绝不 skip、不回落业务连接）；
//   · 身份核验：引擎以实例**管理角色（schema owner，等价生产 DATABASE_URL 角色）**执行 DDL；
//     测试在写任何数据之前核验：库名/端口/回环地址/实例标记/管理角色名与隔离契约一致，
//     且库名不是业务样式（与 tests/helpers/db-isolation.cjs 的派生契约交叉核对）。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = path.resolve(here, '../../..')
/** 从 backend 依赖树解析（@prisma/client 等只装在 backend/node_modules）。 */
export const backendRequire = createRequire(path.join(repoRoot, 'backend/package.json'))
const gate = require(path.join(repoRoot, 'tests/helpers/db-isolation.cjs'))

const RUN_ID_RE = /^[a-z0-9]{8,32}$/
const BUSINESS_LIKE = [/^foodsentinel/i, /^food_lab/i, /^school_tjb/i, /^postgres$/i, /^test$/i, /^school_reviewtest$/i]

/** 读取并校验本包运行环境（不抛；调用方决定 fail-closed 行为）。 */
export function loadW3Harness(env = process.env) {
  const required = ['TEST_DATABASE_URL', 'TEST_DB_CONTEXT_FILE', 'W3_ADMIN_DATABASE_URL', 'W3_INSTANCE_JSON', 'BACKUP_DIR', 'BACKUP_JOB_LEDGER_DIR', 'BACKUP_MASTER_KEY']
  const missing = required.filter((k) => !env[k] || String(env[k]).trim() === '')
  if (missing.length) return { ok: false, code: 'W3_ENV_MISSING', missing }
  // 隔离契约（与共享门禁同一实现；拒绝默认端口/业务库/非派生身份）
  const gateResult = gate.checkIsolationConfig({ TEST_DATABASE_URL: env.TEST_DATABASE_URL, TEST_DB_CONTEXT_FILE: env.TEST_DB_CONTEXT_FILE })
  if (!gateResult.ok) return { ok: false, code: gateResult.code, reason: gateResult.reason }
  const cfg = gateResult.cfg
  const derived = gate.derivedNamespace(cfg.runId)

  let instance
  try { instance = JSON.parse(fs.readFileSync(env.W3_INSTANCE_JSON, 'utf8')) } catch (e) {
    return { ok: false, code: 'W3_INSTANCE_JSON_UNREADABLE', reason: e.message }
  }
  if (instance.runId !== cfg.runId) return { ok: false, code: 'W3_RUNID_MISMATCH' }
  if (instance.database !== cfg.database || Number(instance.port) !== Number(cfg.port)) {
    return { ok: false, code: 'W3_INSTANCE_CONTRACT_MISMATCH' }
  }
  if (instance.adminRole !== derived.adminRole) return { ok: false, code: 'W3_ADMIN_ROLE_MISMATCH' }

  // 管理连接串：只允许指向同一隔离实例的**管理角色**（回环、非默认端口、同库）
  let url
  try { url = new URL(env.W3_ADMIN_DATABASE_URL) } catch { return { ok: false, code: 'W3_ADMIN_URL_INVALID' } }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return { ok: false, code: 'W3_ADMIN_URL_INVALID' }
  if (!['127.0.0.1', '::1'].includes(url.hostname)) return { ok: false, code: 'W3_ADMIN_URL_NOT_LOOPBACK' }
  if (String(url.port) !== String(cfg.port)) return { ok: false, code: 'W3_ADMIN_URL_PORT_MISMATCH' }
  if (decodeURIComponent(url.pathname.replace(/^\//, '')) !== cfg.database) return { ok: false, code: 'W3_ADMIN_URL_DB_MISMATCH' }
  if (decodeURIComponent(url.username) !== derived.adminRole) return { ok: false, code: 'W3_ADMIN_URL_ROLE_MISMATCH' }
  if (BUSINESS_LIKE.some((re) => re.test(cfg.database)) || !RUN_ID_RE.test(cfg.runId)) return { ok: false, code: 'W3_BUSINESS_LIKE_TARGET' }
  if (String(env.BACKUP_DIR).startsWith('/') === false) return { ok: false, code: 'W3_BACKUP_DIR_NOT_ABSOLUTE' }
  if (!String(env.BACKUP_DIR).startsWith(instance.backupDir)) return { ok: false, code: 'W3_BACKUP_DIR_OUTSIDE_INSTANCE' }
  if (!String(env.BACKUP_JOB_LEDGER_DIR).startsWith(instance.ledgerDir)) return { ok: false, code: 'W3_LEDGER_DIR_OUTSIDE_INSTANCE' }

  return {
    ok: true,
    cfg,
    derived,
    instance,
    adminUrl: env.W3_ADMIN_DATABASE_URL,
    backupDir: env.BACKUP_DIR,
    ledgerDir: env.BACKUP_JOB_LEDGER_DIR,
    masterKey: env.BACKUP_MASTER_KEY,
    schoolA: instance.schools.a,
    schoolB: instance.schools.b,
    schemaA: instance.schemas.a,
    schemaB: instance.schemas.b,
    legacyStaging: instance.collisionCanaries.legacyStaging,
    foreignStaging: instance.collisionCanaries.foreignStaging,
    realSentinelIdA: `${instance.realSentinelRowIdBase}-a`,
    realSentinelIdB: `${instance.realSentinelRowIdBase}-b`,
    instanceRoot: instance.envFile ? path.dirname(instance.envFile) : null,
  }
}

/** 运行期身份核验（写任何数据之前；失败即抛出）。 */
export async function assertInstanceIdentity(prisma, w3) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT current_database() AS db, current_user AS cu, inet_server_addr()::text AS addr, inet_server_port() AS port`
  )
  const id = rows?.[0] || {}
  const addr = typeof id.addr === 'string' ? id.addr.split('/')[0] : id.addr
  const problems = []
  if (id.db !== w3.cfg.database) problems.push(`db=${id.db}`)
  if (id.cu !== w3.derived.adminRole) problems.push(`user=${id.cu}`)
  if (addr !== w3.cfg.host) problems.push(`addr=${id.addr}`)
  if (Number(id.port) !== Number(w3.cfg.port)) problems.push(`port=${id.port}`)
  // P3-DB-FIXTURE-R1：marker 位于 runId 派生的 fixture schema（不再在 public）；表名取自冻结 cfg
  const marker = await prisma.$queryRawUnsafe(`SELECT value FROM ${gate.quoteQualified(w3.cfg.markerTable)} WHERE key = 'instance_tag' LIMIT 1`)
  if (marker?.[0]?.value !== w3.cfg.instanceTag) problems.push(`marker=${marker?.[0]?.value}`)
  if (problems.length) {
    throw new Error(`[W3-IDENTITY] 引擎连接未指向本任务隔离实例（拒绝执行）: ${problems.join(', ')}`)
  }
  return { db: id.db, user: id.cu, port: Number(id.port), addr, instanceTag: marker[0].value }
}

/** 只读核验哨兵：历史固定名/他任务暂存名两个 schema 及其哨兵行必须始终存在。 */
export async function readCanaries(prisma, w3) {
  const out = {}
  for (const [name, schema, table] of [
    ['legacy', w3.legacyStaging, 'legacy_canary'],
    ['foreign', w3.foreignStaging, 'foreign_canary'],
  ]) {
    const ns = await prisma.$queryRawUnsafe('SELECT oid::text AS oid FROM pg_namespace WHERE nspname = $1', schema)
    if (!ns.length) { out[name] = { schema, exists: false }; continue }
    const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${schema}"."${table}"`)
    out[name] = { schema, exists: true, rows: Number(rows[0].n), oid: ns[0].oid }
  }
  return out
}

/** 目标学校真实数据哨兵（租户 a）：必须能在恢复后按 id 复核到。 */
export async function readRealSentinel(prisma, w3, schema = w3.schemaA, id = w3.realSentinelIdA) {
  const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${schema}"."User" WHERE id = $1`, id)
  return Number(rows[0].n)
}

/** 统计 backupDir 下的“已发布产物目录”（形如 <date>/<base>.<jobId> 的目录）。 */
export function listPublishedDirs(backupDir) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      if (e.name === '.jobs') continue
      // 日期目录继续下钻；产物目录名形如 `<base>.<kind>-<ts>-<16hex>`
      if (/\.[a-z]+-\d{8}t\d{8}-[0-9a-f]{16}$/.test(e.name)) out.push(p)
      else walk(p)
    }
  }
  walk(backupDir)
  return out
}

/** /tmp 下 restore_*.sql 明文残留（NF-B-02：必须始终为空集）。 */
export function listTmpPlaintextRestoreFiles() {
  const out = []
  for (const dir of ['/tmp', '/var/tmp']) {
    try {
      for (const n of fs.readdirSync(dir)) if (/^restore_.*\.sql$/.test(n)) out.push(path.join(dir, n))
    } catch { /* 目录不可读忽略 */ }
  }
  return out
}
