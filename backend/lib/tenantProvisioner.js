// tenantProvisioner.js — 租户（学校）初始化核心逻辑（方案② Schema-per-tenant）
//
// 被两处复用，保证首部署与运行时"动态建学校"行为完全一致：
//   1. prisma/provision-tenants.js —— 首次部署批量初始化（deploy.sh 调用）
//   2. server.js 的 POST /api/admin/schools —— 运行时超管动态新增学校
//
// 单个学校的初始化步骤（全部幂等）：
//   ① 创建 schema `school_<code>`
//   ② 以**版本化迁移链末端**为源物化业务表（P3-W2-T02-R1：`migrate diff --from-empty
//      --to-schema-datamodel` 生成 DDL → psql（search_path 限定）执行 → 与 public 逐项自证；
//      不再使用运行期 `prisma db push`）
//   ③ 写入 public."School" / "SchoolCustomization" 系统记录
//   ④ 在租户 schema 内创建首个 manager 账号（admin 角色保留给平台超管）

import bcryptjs from 'bcryptjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { schemaNameOf, isValidSchoolCode, assertSafeSchemaName } from './tenantClient.js'
import {
  LOCK_TABLE_SHAPE, LOCK_TABLE_SHAPE_MISMATCH, lockTableShapeIssues,
} from './publicInfraShape.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// backend 目录（schema.prisma 位于 backend/prisma/schema.prisma）
const BACKEND_DIR = path.resolve(__dirname, '..')

// 校验/命名统一由 tenantClient 提供（DS-06 单一事实源），此处再导出以兼容既有引用。
export { schemaNameOf, isValidSchoolCode }

/**
 * P3-W2-T02（AUD-009 / RC-04）：历史 db push 参数构造点。
 *
 * ⚠️ **P3-W2-T02-R1 起产品路径不再调用**（租户结构来源改为版本化迁移链末端，见下方
 * `materializeOrAlignTenantStructure`）。本导出仅为 P3-W2-T02 的历史证据 harness 兼容保留；
 * 新增代码不得使用。（静态护栏：`backend/tests/tenant-sync/` 用例断言产品路径无 db push。）
 * @param {{acceptDataLoss?: boolean}} [opts]
 * @returns {string[]}
 */
export function buildTenantPushArgs({ acceptDataLoss = false } = {}) {
  const args = ['prisma', 'db', 'push', '--skip-generate']
  if (acceptDataLoss) args.push('--accept-data-loss')
  return args
}

/**
 * 显式 opt-in 开关（默认关闭）。
 * P3-W2-T02-R1 语义：允许**执行破坏性结构语句**（DROP / ALTER COLUMN TYPE / SET NOT NULL /
 * TRUNCATE / DELETE），仅运营/运维在明确评审后设置；默认任何破坏性语句都会让对齐整体拒绝。
 * 兼容旧名 `TENANT_DB_PUSH_ACCEPT_DATA_LOSS`，新增一等名 `TENANT_ALIGN_ACCEPT_DESTRUCTIVE`。
 */
export function tenantPushAcceptDataLossEnabled() {
  return process.env.TENANT_ALIGN_ACCEPT_DESTRUCTIVE === 'true'
    || process.env.TENANT_DB_PUSH_ACCEPT_DATA_LOSS === 'true'
}

// ============================================================================
// P3-W2-T02-R2（RC-04）：**逐租户版本化迁移** —— 每个 public 与 tenant 都能证明已应用迁移的
//   名称 / checksum / 状态 / 失败原因，并按可回放版本路径升级。
//   · 事实源：`prisma/migrations/*/migration.sql`（版本化链，仅追加，不改已应用内容/checksum）。
//   · public：Prisma `_prisma_migrations`（name + checksum + finished/rolled_back + logs）——
//     由 tenantSync 逐条与链文件比对（checksum 不一致 / 未知条目 / pending / failed 一律阻断）。
//   · tenant：**本模块的逐租户台账** `"<schema>"."_tenant_migrations"`
//     （migration_name, checksum, status, started_at, finished_at, projection_sha256,
//       skipped_sweeps, chain_digest, detail）——由逐租户**回放链文件**产生，不使用
//     migrate diff 末态 SQL、不使用链摘要、不使用 public 迁移状态冒充。
//   · 逐租户回放：按链顺序执行每个文件的 SQL（`search_path=<目标 schema>`）；
//     文件内"扫全库"语句（`pg_namespace` / `information_schema` 循环，用于一次性补齐存量租户）
//     在逐租户回放中被**投影剔除**（其单 schema 效果 = 同文件非循环语句在该 schema 下的效果，
//     由回放后与 public（链末、checksum 受校验）的逐项自证兜底），并记 skipped_sweeps 计数。
//   · 六类历史库：空库 → 全链回放；正常旧链/曾 resolve → 台账缺失时按**结构见证**探测版本
//     前缀，前缀一致 → 受控 baseline（记 baselined + 见证证据）+ 回放其后迁移；
//     见证不一致/部分执行/无法证明 → **fail-closed**（TENANT_MIGRATION_STATE_UNPROVABLE）。
//   · 破坏性/删除类语句属于版本化链本身（按版本执行）；额外对象永不自动 DROP（见 tenantSync 检查）。
// ============================================================================

const DEFAULT_MIGRATIONS_DIR = path.join(BACKEND_DIR, 'prisma', 'migrations')

/**
 * 迁移链目录（默认 `backend/prisma/migrations`）。
 * 测试/维护 seam：`TENANT_MIGRATIONS_DIR` 必须是**绝对路径且存在**（否则 fail-closed）——
 * 用于"只读校验同一实例的候选链"（如 R4 注入未分类迁移）。链的权威性由 public._prisma_migrations
 * 逐条 checksum 比对兜底：指向别的链只会产生 MIGRATION_CHECKSUM_MISMATCH/未知条目并阻断。
 */
export function migrationsDir() {
  const override = String(process.env.TENANT_MIGRATIONS_DIR || '').trim()
  if (!override) return DEFAULT_MIGRATIONS_DIR
  if (!path.isAbsolute(override)) throw new Error(`TENANT_MIGRATIONS_DIR 必须是绝对路径：${override}`)
  if (!fs.existsSync(override)) throw new Error(`TENANT_MIGRATIONS_DIR 不存在：${override}`)
  return override
}
const DATAMODEL = path.join(BACKEND_DIR, 'prisma', 'schema.prisma')

// ───────────────────────── 凭据卫生（URL/口令不进 argv/日志） ─────────────────────────

/** 错误/日志脱敏：连接串口令位与 PASSWORD=... 一律掩码（对未知文本安全）。 */
export function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/(postgres(?:ql)?:\/\/[^:@/\s'"]+:)[^@/\s'"]+(@)/gi, '$1***$2')
    .replace(/\b([A-Za-z0-9_]*password[A-Za-z0-9_]*)(=)(['"]?)[^\s'"]+(['"]?)/gi, '$1$2$3***$4')
    .replace(/(--from-url\s+)\S+/gi, '$1<redacted-url>')
    .replace(/(--to-url\s+)\S+/gi, '$1<redacted-url>')
}

/**
 * 解析 postgres URL → libpq 连接参数（口令仅作为返回值，**不进 argv**）。
 * @returns {{host:string, port:string, database:string, user:string, password:string}|null}
 */
export function parseDbUrl(url) {
  try {
    const u = new URL(String(url))
    if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') return null
    return {
      host: u.hostname || '127.0.0.1',
      port: u.port || '5432',
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
      user: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    }
  } catch { return null }
}

/** psql 的 argv（**常量、无秘密**；连接信息经 PG* 环境 + PGPASSFILE 传递）。 */
export function psqlArgv() {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-']
}

/** 写 0600 临时 pgpass 文件（口令只落该文件；调用方负责清理）。 */
async function writePgPassFile(conn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'p3w2r2-pgpass-'))
  const file = path.join(dir, 'pgpass')
  const line = `${conn.host}:${conn.port}:${conn.database}:${conn.user}:${conn.password}\n`
  await fsp.writeFile(file, line, { mode: 0o600 })
  return { file, dir, cleanup: async () => { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}) } }
}

/** psql 子进程环境：连接信息（不含口令）+ PGPASSFILE（0600 文件）。 */
export function buildPsqlEnv(conn, passFile, baseEnv = process.env) {
  return {
    PATH: baseEnv.PATH, HOME: baseEnv.HOME,
    PGHOST: conn.host, PGPORT: String(conn.port), PGDATABASE: conn.database, PGUSER: conn.user,
    PGPASSFILE: passFile,
    PGSSLMODE: baseEnv.PGSSLMODE || 'prefer',
  }
}

/**
 * 执行一批 SQL（stdin 流式；psql 参数无秘密；失败信息脱敏后抛出）。
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
export async function runPsqlBatch({ conn, sql, timeoutMs = 180000 }) {
  const { file, cleanup } = await writePgPassFile(conn)
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('psql', psqlArgv(), { env: buildPsqlEnv(conn, file), timeout: timeoutMs })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d) => { stdout += d.toString() })
      child.stderr?.on('data', (d) => { stderr += d.toString() })
      child.on('error', (e) => reject(new Error(`psql 启动失败: ${redactSecrets(e.message)}`)))
      child.on('close', (code, signal) => {
        if (code === 0) return resolve({ stdout, stderr })
        reject(new Error(`psql 执行失败（退出码 ${code}${signal ? `/${signal}` : ''}）: ${redactSecrets(stderr || stdout).slice(0, 800)}`))
      })
      child.stdin.write(String(sql || ''))
      child.stdin.end()
    })
  } finally {
    await cleanup()
  }
}

// ───────────────────────── 迁移链事实源 ─────────────────────────

/** 迁移链事实源（可追溯）：按目录名字典序的 `migration.sql` 列表。 */
export function listMigrationFiles() {
  let entries = []
  const dir = migrationsDir()
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
    .map((e) => ({ name: e.name, file: path.join(dir, e.name, 'migration.sql') }))
    .filter((m) => fs.existsSync(m.file))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 单个迁移文件的 checksum（sha256，与 Prisma `_prisma_migrations.checksum` 同口径）。 */
export function fileChecksum(name) {
  const file = path.join(migrationsDir(), name, 'migration.sql')
  if (!fs.existsSync(file)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 迁移链清单（name + checksum#前 12 + bytes），供检查/证据/协议发布。 */
export function chainManifest() {
  return listMigrationFiles().map((m) => {
    const buf = fs.readFileSync(m.file)
    return { name: m.name, checksum: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length }
  })
}

/** 迁移链内容摘要（sha256；仅文件内容，不含数据）。 */
export function migrationChainDigest() {
  const h = crypto.createHash('sha256')
  for (const m of listMigrationFiles()) h.update(`${m.name}\0${fs.readFileSync(m.file)}\n`)
  return h.digest('hex')
}

/**
 * 期望结构（表集合）的事实源：`prisma/schema.prisma` 的 model 声明。
 * ⚠️ 仅用于**结构自证/漂移检查**，不作为租户结构来源（来源 = 版本化链文件）。
 */
export function readExpectedTenantTables() {
  try {
    const text = fs.readFileSync(DATAMODEL, 'utf8')
    const blocks = [...text.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm)]
    const tables = new Set()
    for (const [, name, body] of blocks) {
      const mapped = body.match(/@@map\("([^"]+)"\)/)
      tables.add(mapped ? mapped[1] : name)
    }
    if (!tables.size) return { ok: false, reason: 'schema.prisma 未解析到任何 model' }
    return { ok: true, tables, count: tables.size, source: 'backend/prisma/schema.prisma' }
  } catch (e) {
    return { ok: false, reason: `读取/解析 schema.prisma 失败: ${e.message}` }
  }
}

// ───────────────────────── SQL 语句切分 / 逐租户投影 ─────────────────────────

/**
 * 语句切分（识别 `$$ … $$` 块与单引号字符串，避免把函数体/DO 块切开）。
 * @returns {string[]} 去注释后的语句数组（不含空串）
 */
export function splitSqlStatements(script) {
  const src = String(script || '')
  const stmts = []
  let cur = ''
  let inDollar = false
  let inSingle = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    const next = src[i + 1]
    if (inLineComment) { if (ch === '\n') inLineComment = false; continue }
    if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i += 1 } continue }
    if (!inDollar && !inSingle && ch === '-' && next === '-') { inLineComment = true; i += 1; continue }
    if (!inDollar && !inSingle && ch === '/' && next === '*') { inBlockComment = true; i += 1; continue }
    if (!inSingle && ch === '$' && next === '$') { inDollar = !inDollar; cur += '$$'; i += 1; continue }
    if (!inDollar && ch === "'") inSingle = !inSingle
    if (!inDollar && !inSingle && ch === ';') {
      const s = cur.trim()
      if (s) stmts.push(s)
      cur = ''
      continue
    }
    cur += ch
  }
  const tail = cur.trim()
  if (tail) stmts.push(tail)
  return stmts
}

// ───────────────────────── 迁移分类协议（R5 ⑥ + public-only/per-tenant 协议） ─────────────────────────
//
// 规则（可执行、按 checksum 固定；不凭任意子串推断语义）：
//   1. **每个迁移文件必须显式声明作用域**（新文件在文件头写 `-- @scope: both` 或 `-- @scope: public`）：
//        · `both`   = 结构同时属于 public（migrate deploy）与每个 tenant（逐租户回放）；
//        · `public` = **仅 public**（如 `revoked_tokens` 这类认证事实源）：逐租户回放**整条跳过**，
//                     只在租户台账记 `skipped_public_only`（可证明"该版本不适用于租户"，且不会在租户
//                     建出非契约表 → 不会触发 TENANT_EXTRA_OBJECTS）。
//   2. **语句级分类**：语句含 catalog 引用（`pg_*` / `information_schema`）时必须有**显式分类**，否则
//      **fail-closed**（`TENANT_PROJECTION_UNCLASSIFIED`）——绝不按子串静默跳过：
//        · 文件头注册表（下方 `TENANT_MIGRATION_REGISTRY`，按**文件 checksum** 固定）里的 `skip`/`scoped` 摘要；
//        · 或语句紧邻的注释标记：`-- @tenant-skip: <reason>`（跳过）/ `-- @tenant-scoped: <reason>`（执行，
//          已人工复核"只查本 schema"）。标记与语句之间只能隔空行/其它注释。
//   3. 未含 catalog 引用的普通 DDL 一律**执行**（保持"默认全执行"，不因未知而吞语句）。
//   4. 注册表 checksum 不匹配（文件被改动）→ fail-closed（`TENANT_MIGRATION_REGISTRY_CHECKSUM_MISMATCH`）。
const TENANT_MIGRATION_REGISTRY = Object.freeze({
  '20260726000000_baseline': { checksum: 'c22a386cc2950e18e1d3b1d47f8cf055371be271b8909fae6413d6b01ba19048', scope: 'both', skip: [], stmtCount: 46 },
  // 该文件的 FieldOption 自引用外键守卫（IF NOT EXISTS (SELECT 1 FROM pg_constraint …)）**未做 schema 过滤**：
  // 逐租户回放时由回放的临时 pg_constraint 视图语义化为「只看本 schema」（见 applyTenantChain 的 shim），
  // 因此显式分类为 scoped（执行），不得跳过——否则租户会永久缺该外键。
  '20260726100000_add_customization_columns_if_missing': { checksum: '857762e304737690f6ec68f0a86c51a57c4539c5767599864fe48580982ca545', scope: 'both', skip: [], scoped: ['68afaf5c9cf726fb1950ae3ae2279debbd93ae5c63c884a7fabe4d1727296497'], stmtCount: 23 },
  '20260729000000_add_must_change_password': { checksum: '73745a2640185b1c2e6ce66dc14e435072ad5ee12198e0662c6c59420aba4e36', scope: 'both', skip: [], stmtCount: 1 },
  '20260814000000_remove_backup_model': { checksum: '42b99992bd724d77d9ff2691a06dd83d8222b67d045cc77b8d2ec5886f7c42ca', scope: 'both', skip: [], stmtCount: 4 },
  '20260814020000_unify_school_customization_text': { checksum: 'a9ebb76c2d6b8772a60d9fa72d348b1a02c9d86e428d848e6bebb47a54bd8448', scope: 'both', skip: [], stmtCount: 12 },
  '20260814030000_revert_customization_to_jsonb': { checksum: 'a53e2597942da9c94d053ff9da844f0c5c3ff593aa12c2612c342be7edd70ffe', scope: 'both', skip: [], stmtCount: 12 },
  // 扫全库语句（DO 块遍历 school_* 一次性补齐存量租户）：逐租户回放时跳过（其单 schema 效果由同文件
  // 非循环语句覆盖 + 回放后自证）；摘要 = 规范化语句 sha256（内容绑定，不随空白变化）
  '20260814040000_json_fields_to_jsonb': { checksum: 'da8d6f408529ad849e37db7c70569cd4998fc61670a86bbc34d71c0a07a1772f', scope: 'both', skip: ['879b8d1da6b7ed26305587b07ad8e58da764549b277e3ab69b2e2338b2c0db6a'], stmtCount: 11 },
  '20260816000000_add_school_short_name_unique': { checksum: '8efb3856c67065abeff11a466fa51b727fb1839443c1070da57d57c35738e46d', scope: 'both', skip: [], stmtCount: 1 },
  '20260825000000_add_frequency_threshold_calendar': { checksum: 'c3ef86c51ff8f19ab628401794f75af9e1c9f510ca0f97173dc74ee0609468f6', scope: 'both', skip: ['cdc4b2c2780fa0bc946631e1959a0020c109926204f48ac50ff822eda79b2747'], stmtCount: 5 },
  '20260825120000_test_report_rewrite': { checksum: '3e4ec2bc57b415ad8889028c7b89cc69302e539f34a902d815b8d616ce0b5325', scope: 'both', skip: [], stmtCount: 11 },
  '20260915120000_open_api_tables': { checksum: '69d10c487793312e3cbdb01e4883f2457d225958314348221460d01e0433929a', scope: 'both', skip: ['880226f6221a2cea88a0cf1600cd007babab84da4bfecb5bf4df004de0cf5789'], stmtCount: 11 },
  // P3-FRIENDLY-LINKS（2026-09-28，第 17 位，`@scope: both`）：登录页友情链接表（`public."FriendlyLink"`
  // 权威副本 + 各租户同名空表，结构对齐用）。4 条语句中**显式跳过 2 条**（逐租户回放不执行）：
  //   ① 种子数据（id=fl-seed-campus-foodsafety）——**仅 public**，租户副本永不写入；
  //   ② 扫全库 DO 块（一次性为存量 school_* 建空表）——单 schema 效果由同文件 2 条普通 DDL
  //      的逐租户回放覆盖（CREATE TABLE / CREATE INDEX 均带 IF NOT EXISTS，幂等）。
  //   ⚠️ 其后新增迁移必须继续追加（不得插队）：本文件为当前链尾。
  '20260928120000_friendly_links': { checksum: 'd895a2ca8c265912614c634d6fc6cb0e0df425a07398fa3a9c0b8294df57f309', scope: 'both', skip: ['a55f8344faeacc689674b90303875103ef7cd4d9c36bfaf758e63be2268872d6', '895f1a63f79e00cd71a0d5fa45b8f6dffaec198c34506358661a7b136b76d375'], stmtCount: 4 },
})

/** 分类协议对外的可审计快照（供 `--check`/证据输出；值即编译进上表的常量）。 */
export function migrationClassificationRegistry() {
  return Object.entries(TENANT_MIGRATION_REGISTRY).map(([name, v]) => ({
    name, checksum: v.checksum, scope: v.scope, skippedStatements: v.skip.length,
  }))
}

/** 语句规范化摘要（空白折叠 + sha256；与注册表 skip/scoped 摘要同口径）。 */
export function statementDigest(sql) {
  return crypto.createHash('sha256').update(String(sql).replace(/\s+/g, ' ').trim()).digest('hex')
}

const SCOPE_RE = /^\s*--\s*@scope:\s*(both|public)\s*$/im
const MARKER_SKIP_RE = /^\s*--\s*@tenant-skip:\s*(.+)$/m
const MARKER_SCOPED_RE = /^\s*--\s*@tenant-scoped:\s*(.+)$/m
/** catalog 引用判据（仅用于**要求显式分类**，绝不用于静默跳过）。 */
const CATALOG_RE = /\b(pg_[a-z_]+|information_schema)\b/i

/**
 * 语句切分（保留每个语句**紧邻的注释**用于标记解析）。
 * @returns {{statements:Array<{sql:string, digest:string, comment:string, markers:{skip?:string, scoped?:string}}>, scope:string|null}}
 */
export function splitMigrationStatementsWithMarkers(script) {
  const raw = String(script || '')
  const scopeMatch = raw.match(SCOPE_RE)
  const statements = []
  const stmts = splitSqlStatements(raw)
  // 逐个语句在原文中定位（顺序扫描，保证注释归属正确）
  let cursor = 0
  for (const sql of stmts) {
    const idx = raw.indexOf(sql.slice(0, 40), cursor)
    if (idx === -1) { statements.push({ sql, digest: statementDigest(sql), comment: '', markers: {} }); continue }
    const head = raw.slice(cursor, idx)
    // 只取紧邻的注释块（自上一个语句结束起）
    const commentLines = head.split('\n').filter((l) => /^\s*--/.test(l))
    const comment = commentLines.join('\n')
    const skip = comment.match(MARKER_SKIP_RE)
    const scoped = comment.match(MARKER_SCOPED_RE)
    statements.push({
      sql, digest: statementDigest(sql), comment,
      markers: { ...(skip ? { skip: skip[1].trim() } : {}), ...(scoped ? { scoped: scoped[1].trim() } : {}) },
    })
    cursor = idx + Math.min(sql.length, 40)
  }
  return { statements, scope: scopeMatch ? scopeMatch[1] : null }
}

/**
 * 分类单个迁移（纯函数；不执行任何 SQL）。
 * @param {{name:string, sql:string, checksum?:string}} file
 * @returns {{name:string, scope:string, checksumOk:boolean|null, executed:Array, skipped:Array, unclassified:Array, stmtCount:number}}
 * @throws {Error} TENANT_SCOPE_UNCLASSIFIED / TENANT_MIGRATION_REGISTRY_CHECKSUM_MISMATCH（fail-closed）
 */
export function classifyTenantMigration({ name, sql, checksum = null }) {
  const reg = TENANT_MIGRATION_REGISTRY[name] || null
  if (reg && checksum && reg.checksum !== checksum) {
    const err = new Error(
      `${name}: 文件 checksum 与分类注册表不一致（注册表 ${reg.checksum.slice(0, 12)}…，实际 ${String(checksum).slice(0, 12)}…）。` +
      `分类按 checksum 固定，文件被改动必须重新人工分类（RC-04：不得凭子串推断语义）。`)
    err.code = 'TENANT_MIGRATION_REGISTRY_CHECKSUM_MISMATCH'
    err.migration = name
    throw err
  }
  const parsed = splitMigrationStatementsWithMarkers(sql)
  const scope = reg?.scope || parsed.scope
  if (!scope) {
    const err = new Error(
      `${name}: 未声明迁移作用域。新迁移必须在文件头写 \`-- @scope: both\`（public 与每个租户）或 ` +
      `\`-- @scope: public\`（仅 public，逐租户回放整条跳过）；逐租户回放对未声明作用域 fail-closed。`)
    err.code = 'TENANT_SCOPE_UNCLASSIFIED'
    err.migration = name
    throw err
  }
  const executed = []
  const skipped = []
  const unclassified = []
  for (const st of parsed.statements) {
    const regSkip = reg?.skip?.includes(st.digest)
    const regScoped = reg?.scoped?.includes(st.digest)
    if (regSkip || st.markers.skip) {
      skipped.push({ digest: st.digest, reason: st.markers.skip || `registry-skip:${name}`, head: st.sql.replace(/\s+/g, ' ').slice(0, 120) })
      continue
    }
    if (regScoped || st.markers.scoped) {
      executed.push({ digest: st.digest, classifiedAs: 'scoped', reason: st.markers.scoped || `registry-scoped:${name}` })
      continue
    }
    if (CATALOG_RE.test(st.sql)) {
      unclassified.push({ digest: st.digest, head: st.sql.replace(/\s+/g, ' ').slice(0, 140) })
      continue
    }
    executed.push({ digest: st.digest, classifiedAs: 'plain' })
  }
  if (unclassified.length) {
    if (scope === 'public') {
      // P3-PUBLIC-INFRA-CHAIN-R1（协议对齐；与 R6 §4 / W1-R3 §3 的文字协议一致）：
      // `@scope: public` 的文件**逐租户整条跳过**（skipped_public_only，投影为空）——语句级分类
      // 在租户侧没有任何执行语义，因此其 catalog 自证语句（DO $$ … pg_catalog … $$）只登记为
      // skipped（带确定 reason），**不**触发 TENANT_PROJECTION_UNCLASSIFIED。
      // 注意：租户作用域（scope=both）仍保持 fail-closed（见下方 throw），不得借此放宽。
      for (const u of unclassified) {
        skipped.push({ digest: u.digest, reason: 'scope=public（整条跳过；租户不执行，无需语句级分类）', head: u.head })
      }
      unclassified.length = 0
    } else {
      const err = new Error(
        `${name}: 含 catalog 引用（pg_*/information_schema）的语句缺少显式分类（${unclassified.length} 条）→ fail-closed。` +
        `处置：在语句前加 \`-- @tenant-scoped: 仅查本 schema（人工复核）\` 或 \`-- @tenant-skip: 原因\`；` +
        `或在 TENANT_MIGRATION_REGISTRY 按 checksum 登记摘要。首条：${unclassified[0].head}`)
      err.code = 'TENANT_PROJECTION_UNCLASSIFIED'
      err.migration = name
      err.unclassified = unclassified
      throw err
    }
  }
  return { name, scope, checksumOk: reg ? true : null, executed, skipped, unclassified, stmtCount: parsed.statements.length }
}

/**
 * 逐租户投影（由 `classifyTenantMigration` 驱动；**不含任何子串推断的静默跳过**）。
 * @returns {{sql:string, skipped:number, kept:number, skippedDetail:Array, scope:string, classification:object}}
 */
export function buildTenantProjection({ name, sql, checksum = null }) {
  const classification = classifyTenantMigration({ name, sql, checksum })
  if (classification.scope === 'public') {
    // 仅 public：逐租户回放整条跳过（不执行任何语句；台账记 skipped_public_only）
    return { sql: '', skipped: classification.stmtCount, kept: 0, skippedDetail: [{ reason: 'scope=public（公共事实源，不落租户）' }], scope: 'public', classification }
  }
  const { statements } = splitMigrationStatementsWithMarkers(sql)
  const skipDigests = new Set(classification.skipped.map((s) => s.digest))
  const kept = statements.filter((s) => !skipDigests.has(s.digest))
  return {
    sql: kept.map((s) => `${s.sql};`).join('\n\n') + (kept.length ? '\n' : ''),
    skipped: statements.length - kept.length,
    kept: kept.length,
    skippedDetail: classification.skipped,
    scope: classification.scope,
    classification,
  }
}

/** 兼容旧名（R2 证据脚本/测试引用）：等价于不含作用域声明的投影（仅用于 11 文件链）。 */
export function projectTenantMigrationSql(script, { name = null, checksum = null } = {}) {
  if (!name) {
    // 未给迁移名：按"默认全执行"投影（不做任何子串跳过）——供旧调用方在纯文本场景使用
    const stmts = splitSqlStatements(script)
    return { sql: stmts.map((s) => `${s};`).join('\n\n') + '\n', skippedSweeps: 0, kept: stmts.length }
  }
  const p = buildTenantProjection({ name, sql: script, checksum })
  return { sql: p.sql, skippedSweeps: p.skipped, kept: p.kept, scope: p.scope, skippedDetail: p.skippedDetail }
}

/** 兼容旧名（R2 测试引用）：catalog 引用判据（现在只用于"要求显式分类"，不再用于跳过）。 */
export function isAllSchemaSweepStatement(sql) {
  return CATALOG_RE.test(String(sql))
}

// ───────────────────────── 逐租户迁移台账（唯一版本事实源） ─────────────────────────

export const TENANT_LEDGER = '_tenant_migrations'
/** 台账表是否为"非契约基础设施"（漂移检查白名单；不参与 parity/额外对象判定）。 */
export const TENANT_LEDGER_WHITELIST = new Set([TENANT_LEDGER])

function ledgerIdent(schema) {
  assertSafeSchemaName(schema)
  return `"${schema}"."${TENANT_LEDGER}"`
}

/** 台账 DDL（幂等；只在显式升级命令/建校/恢复对齐时由引擎执行，检查路径永不调用）。 */
export function tenantLedgerDdl(schema) {
  return `CREATE TABLE IF NOT EXISTS ${ledgerIdent(schema)} (
  migration_name text PRIMARY KEY,
  checksum text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  projection_sha256 text,
  skipped_sweeps integer NOT NULL DEFAULT 0,
  chain_digest text,
  detail text
);\n`
}

/**
 * 只读读取台账。表不存在 → `{exists:false, rows:[]}`（≠ 已证明）。
 * @returns {Promise<{exists:boolean, rows:Array<object>}>}
 */
export async function readTenantMigrationLedger(prisma, schema) {
  assertSafeSchemaName(schema)
  const ns = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=$1::text AND table_name=$2::text`,
    schema, TENANT_LEDGER)
  if (!ns.length) return { exists: false, rows: [] }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT migration_name, checksum, status, started_at, finished_at, projection_sha256, skipped_sweeps, chain_digest, detail
       FROM ${ledgerIdent(schema)} ORDER BY migration_name`)
  return { exists: true, rows }
}

// ───────────────────────── 版本探测（结构见证，前缀一致性） ─────────────────────────

/**
 * 结构见证（按链顺序）：用于台账缺失（db push 演进库 / 备份恢复 staging）时**保守探测**版本前缀。
 * 规则：存在最大 k 使 0..k 的见证全部成立、k 之后的见证全部不成立 → `prefix(k)`；
 *       见证全不成立且无 model 表 → `empty`；其余（部分执行/顺序矛盾）→ `unprovable`（fail-closed）。
 */
export function witnessProbes() {
  const col = (schema, table, column) => async (prisma) => (await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns WHERE table_schema=$1::text AND table_name=$2::text AND column_name=$3::text`,
    schema, table, column)).length > 0
  const table = (schema, name) => async (prisma) => (await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.tables WHERE table_schema=$1::text AND table_name=$2::text`,
    schema, name)).length > 0
  // baseline 见证的表集合 = **从链文件自身解析**（不硬编码、也不依赖 datamodel 的当前末态；
  // 后续迁移新增的表由各自见证负责）。
  const baselineTables = (() => {
    const files = listMigrationFiles()
    const f = files[0]
    if (!f) return []
    const sql = fs.readFileSync(f.file, 'utf8')
    const created = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1])
    // 链内后续迁移删除的表（如 remove_backup_model 的 Backup）不算 baseline 见证 —— 从链文件解析，不硬编码
    const dropped = new Set()
    for (const mf of files) {
      const text = fs.readFileSync(mf.file, 'utf8')
      for (const m of text.matchAll(/DROP TABLE (?:IF EXISTS )?"([A-Za-z_][A-Za-z0-9_]*)"/g)) dropped.add(m[1])
    }
    return [...new Set(created)].filter((t) => !dropped.has(t))
  })()
  return [
    { index: 0, name: '20260726000000_baseline', label: `baseline 建表（${baselineTables.length} 张）`, check: async (prisma, schema) => {
      if (!baselineTables.length) return false
      const rows = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1::text AND table_name=ANY($2::text[])`,
        schema, baselineTables)
      return Number(rows[0]?.n) === baselineTables.length
    } },
    { index: 1, name: '20260726100000_add_customization_columns_if_missing', label: 'SchoolCustomization.field_labels', check: (p, s) => col(s, 'SchoolCustomization', 'field_labels')(p) },
    { index: 2, name: '20260729000000_add_must_change_password', label: 'User.must_change_password', check: (p, s) => col(s, 'User', 'must_change_password')(p) },
    { index: 6, name: '20260814040000_json_fields_to_jsonb', label: 'AuditLog.details=jsonb 且 TestRecord.result_data=jsonb', check: async (prisma, schema) => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT table_name, data_type FROM information_schema.columns
          WHERE table_schema=$1::text AND ((table_name='AuditLog' AND column_name='details') OR (table_name='TestRecord' AND column_name='result_data'))`,
        schema)
      return rows.length === 2 && rows.every((r) => r.data_type === 'jsonb')
    } },
    { index: 7, name: '20260816000000_add_school_short_name_unique', label: 'School.short_name 唯一索引', check: async (prisma, schema) => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
          JOIN pg_namespace n ON n.oid=t.relnamespace
         WHERE n.nspname=$1::text AND t.relname='School' AND i.indisunique AND pg_get_indexdef(i.indexrelid) ILIKE '%short_name%'`,
        schema)
      return Number(rows[0]?.n) >= 1
    } },
    { index: 8, name: '20260825000000_add_frequency_threshold_calendar', label: 'FrequencyThreshold + DetectionCalendar', check: async (prisma, schema) => (await table(schema, 'FrequencyThreshold')(prisma)) && (await table(schema, 'DetectionCalendar')(prisma)) },
    { index: 9, name: '20260825120000_test_report_rewrite', label: 'TestCase + TestExecution', check: async (prisma, schema) => (await table(schema, 'TestCase')(prisma)) && (await table(schema, 'TestExecution')(prisma)) },
    { index: 10, name: '20260915120000_open_api_tables', label: 'OpenApiClient/Credential/Grant', check: async (prisma, schema) => (await table(schema, 'OpenApiClient')(prisma)) && (await table(schema, 'OpenApiCredential')(prisma)) && (await table(schema, 'OpenApiGrant')(prisma)) },
    // 第 17 位（P3-FRIENDLY-LINKS）：登录页友情链接表（public 权威副本；租户侧同名空表，仅结构对齐）。
    // 链尾必须落在 tenantRelevantIndex（最后一个非 `@scope: public` 迁移）上，否则无台账存量库的
    // 版本探测会从 head 退化为 prefix。
    { index: 16, name: '20260928120000_friendly_links', label: 'FriendlyLink（友情链接）', check: (p, s) => table(s, 'FriendlyLink')(p) },
  ]
}

/**
 * 探测租户迁移状态。
 * @returns {Promise<{kind:'empty'|'prefix'|'head'|'unprovable', satisfiedUpTo:number, holds:boolean[], witnesses:Array}>}
 */
export async function detectTenantMigrationState(prisma, schema) {
  assertSafeSchemaName(schema)
  const probes = witnessProbes()
  const holds = []
  for (const p of probes) {
    let ok = false
    try { ok = await p.check(prisma, schema) } catch { ok = false }
    holds.push({ index: p.index, name: p.name, label: p.label, holds: ok })
  }
  const pattern = holds.map((h) => h.holds)
  const firstFalse = pattern.indexOf(false)
  const empty = firstFalse === 0
  const isPrefix = (() => {
    let seenFalse = false
    for (const v of pattern) {
      if (v === false) seenFalse = true
      else if (seenFalse) return false // true 出现在 false 之后 → 顺序矛盾
    }
    return true
  })()
  if (empty) {
    // 无 model 表：确认为空 schema（或只有台账），按"从零回放"处理
    const expected = readExpectedTenantTables()
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1::text AND table_name=ANY($2::text[])`,
      schema, expected.ok ? [...expected.tables] : [])
    if (Number(rows[0]?.n) === 0) return { kind: 'empty', satisfiedUpTo: -1, holds, witnesses: holds }
  }
  if (!isPrefix) return { kind: 'unprovable', satisfiedUpTo: -1, holds, witnesses: holds }
  const satisfiedUpTo = firstFalse === -1 ? holds[holds.length - 1].index : holds[firstFalse - 1]?.index ?? -1
  const files = listMigrationFiles()
  // P3-PUBLIC-INFRA-CHAIN-R1：租户侧"链尾"= 最后一个**租户相关**（`@scope` !== public）迁移。
  // `@scope: public` 的迁移逐租户整条跳过（台账记 skipped_public_only），不落租户结构 ——
  // 因此不得作为租户见证的边界；否则链尾新增 public-only 迁移后，即使全部见证为真，
  // 无台账存量库的版本探测也会从 `head` 退化为 `prefix`（拒绝路径/基线语义随之偏移）。
  const tenantRelevantIndex = (() => {
    let last = -1
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i]
      try {
        const sql = fs.existsSync(f.file) ? fs.readFileSync(f.file, 'utf8') : ''
        const cls = classifyTenantMigration({ name: f.name, sql, checksum: fileChecksum(f.name) })
        if (cls.scope !== 'public') last = i
      } catch {
        // 分类失败 → 保守视为租户相关（fail-closed 方向：宁可 prefix，也不把不完整结构判成 head）
        last = i
      }
    }
    return last
  })()
  return {
    kind: satisfiedUpTo >= tenantRelevantIndex ? 'head' : 'prefix',
    satisfiedUpTo,
    tenantHeadIndex: tenantRelevantIndex,
    holds, witnesses: holds,
  }
}

// ───────────────────────── 逐租户迁移引擎 ─────────────────────────

const LEDGER_TERMINAL = new Set(['applied', 'applied_projected', 'baselined', 'skipped_public_only'])

// ───────────────────────── 并发互斥（R5 ④：同一 schema 仅一个迁移执行者） ─────────────────────────

/**
 * 迁移互斥锁（public 基础设施表；与租户台账同属引擎簿记，检查侧白名单）。
 * ✅ 版本化归属（P3-PUBLIC-INFRA-CHAIN-R1 / R9 §1）：本表结构已**正式入链**
 * `backend/prisma/migrations/20260926120000_public_infra_tenant_migration_locks`
 * （`-- @scope: public`；含 CREATE TABLE IF NOT EXISTS + 逐列 ADD COLUMN IF NOT EXISTS + 结构自证）。
 * 运行时 **不再 CREATE/ALTER**（同一可审发布撤出）：`ensureTenantMigrationLockTable()` 只做
 * **只读形状断言**，缺表/错列/错形 → `TENANT_LOCK_TABLE_SHAPE_MISMATCH` → 该校 fail-closed 阻断。
 * 下方 `migrationLockDdl()`/`migrationLockUpgradeStatements()` **仅作等价对照与只读契约来源**
 * （测试断言 migration 文件与它们逐列同形），产品路径不再执行。
 * R4 重做（R6 ③：锁龄不能证明旧执行者已停止）+ R5（R7 ①：会话级 SQL 互斥；默认禁自动接管）：
 *   · `heartbeat_at` = 持有者**存活心跳**（执行期间由 engine 定期续期）；
 *   · `hostname`/`pid` = 持有者身份（同主机可做存活证明）；
 *   · `fencing_token` = 每次获得/接管自增；持有者每步校验 token，失权即 fail-closed（防"被接管后仍写"）。
 * 接管规则（**只有能证明旧执行者已停止才接管**）：
 *   · 心跳新鲜（age < staleMs）→ 等待至超时后拒绝（`TENANT_MIGRATION_LOCK_HELD`）；
 *   · 心跳过期 + **同主机且 PID 已不存在** → CAS 接管（fencing+1）；
 *   · 心跳过期但**无法证明死亡**（异主机 / PID 存活 / 无 PID 记录）→ 拒绝
 *     （`TENANT_MIGRATION_LOCK_STALE_UNPROVABLE`，需人工 `--force-unlock`）；
 *   · `TENANT_MIGRATION_LOCK_STALE_TAKEOVER=off` → 连可证明的接管也禁止（最保守）。
 */
export const MIGRATION_LOCK_TABLE = '_tenant_migration_locks'
/** ⚠️ **不再执行**：链上 migration 的唯一结构事实源为 migration.sql；本函数是"同形对照"（测试用）。 */
export function migrationLockDdl() {
  return `CREATE TABLE IF NOT EXISTS public."${MIGRATION_LOCK_TABLE}" (
  schema_name text PRIMARY KEY,
  owner text NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  fencing_token bigint NOT NULL DEFAULT 1,
  hostname text,
  pid integer
);\n`
}

/** ⚠️ **不再执行**（存量升级由 migration 内的 ADD COLUMN IF NOT EXISTS 完成）；仅"同形对照"（测试用）。 */
export function migrationLockUpgradeStatements() {
  return [
    `ALTER TABLE public."${MIGRATION_LOCK_TABLE}" ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz NOT NULL DEFAULT now()`,
    `ALTER TABLE public."${MIGRATION_LOCK_TABLE}" ADD COLUMN IF NOT EXISTS fencing_token bigint NOT NULL DEFAULT 1`,
    `ALTER TABLE public."${MIGRATION_LOCK_TABLE}" ADD COLUMN IF NOT EXISTS hostname text`,
    `ALTER TABLE public."${MIGRATION_LOCK_TABLE}" ADD COLUMN IF NOT EXISTS pid integer`,
  ]
}

/**
 * P3-PUBLIC-INFRA-CHAIN-R1（R9 §1 / R6 C2）：锁表**只读形状断言**（不再建表/升级）。
 * 缺表/缺列/错类型/错默认值/主键不符 → 抛 `TENANT_LOCK_TABLE_SHAPE_MISMATCH`（携带 issues）。
 * 只发 SELECT（pg_catalog）；受限角色亦可执行（pg_catalog 不受 privilege 过滤）。
 * @param {{$queryRawUnsafe:Function}} prisma
 * @returns {Promise<{ok:true, shape:'ok'}>}
 */
export async function assertTenantMigrationLockTableShape({ prisma }) {
  const issues = await lockTableShapeIssues(prisma)
  if (issues.length > 0) {
    const err = new Error(
      `${MIGRATION_LOCK_TABLE}: 公共基础设施形状不符（${issues.join('；')}）→ fail-closed 阻断该校。` +
      `结构由链尾 migration 管理（20260926120000_public_infra_tenant_migration_locks）：请先 prisma migrate deploy；` +
      `运行时不再自动建表/升级（P3-PUBLIC-INFRA-CHAIN-R1）。`)
    err.code = LOCK_TABLE_SHAPE_MISMATCH
    err.issues = issues
    err.runtimeDdlWithdrawn = true
    throw err
  }
  return { ok: true, shape: 'ok' }
}

/** 兼容旧名（既有调用点）：语义已改为**只读形状断言**（不再 CREATE/ALTER）。 */
export async function ensureTenantMigrationLockTable({ prisma }) {
  return assertTenantMigrationLockTableShape({ prisma })
}

/** 形状契约快照（供 --check/证据输出；值与链上 migration 同形）。 */
export function migrationLockTableShape() {
  return LOCK_TABLE_SHAPE
}

/** 本进程身份（用于存活证明）。 */
export function migrationLockIdentity() {
  return { hostname: os.hostname(), pid: process.pid }
}

/** 同主机 PID 存活探测（探测失败一律视为"存活/未知"→ 不可接管，保守）。 */
export function isProcessAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return null      // 无记录 → 未知
  if (n === process.pid) return true
  try { process.kill(n, 0); return true } catch (e) {
    // R7 ②：**只有 ESRCH**（无此进程）可证明已死亡；EPERM 等一律视为"存活/未知"（保守，不得据此接管）
    if (e && e.code === 'ESRCH') return false
    return true
  }
}

/**
 * 某 schema 的迁移 SQL 会话互斥键（会话级 advisory lock）。
 * 由 schema 名确定性派生（64 位有符号，落在 int64 安全区间）。
 */
export function migrationLockAdvisoryKey(schema) {
  assertSafeSchemaName(schema)
  const h = crypto.createHash('sha256').update(`tenant-migration-sql:${schema}`).digest()
  // 取 48 位 → 保留余量避免符号/边界问题
  const n = h.readUIntBE(0, 6)
  return n
}

/**
 * 是否有**会话**正在为该 schema 执行迁移 SQL（只读；查 pg_locks 的 advisory 段）。
 * 语义：执行中的 psql 会话在批首取得会话级 advisory 锁，直到该会话结束（含崩溃）才由 PG 自动释放
 * —— 因此"父进程已死 + psql 子进程仍在跑"这一窗口必然可见。
 */
export async function sqlExecutorInFlight({ prisma, schema }) {
  const key = migrationLockAdvisoryKey(schema)
  const rows = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND granted
        AND ((classid::bigint << 32) | objid::bigint) = ${key}`)
  return Number(rows[0]?.n || 0) > 0
}

/**
 * 每个 SQL 批的**首语句**（R7 ①）：
 *   ① 取得会话级 advisory 锁（拿不到 → 该 schema 已有执行中的 SQL 会话 → fail-closed）；
 *   ② 在**同一事务内**断言"本执行者仍持锁（owner + fencing_token 匹配且心跳未过期）"
 *      —— 使 fencing 在 SQL 写入期间同样有效（被接管后的孤儿 psql 进程会在此处失败，不再落任何 DDL）。
 * 锁在 psql 会话结束时由 PG 自动释放（进程崩溃同样释放）。
 */
export function migrationLockGuardSql({ schema, owner, fencingToken, staleMs = 30 * 60 * 1000 }) {
  assertSafeSchemaName(schema)
  const key = migrationLockAdvisoryKey(schema)
  const stale = Math.max(1000, Number(staleMs) || 0)
  const esc = (v) => String(v).replace(/'/g, "''")
  return `-- R5 执行期间数据库互斥（会话级 advisory + 事务内 fencing 断言）
DO $r5_guard$
DECLARE acquired boolean; cur_owner text; cur_fence bigint; cur_fresh boolean;
BEGIN
  SELECT pg_try_advisory_lock(${key}) INTO acquired;
  IF acquired IS NOT true THEN
    RAISE EXCEPTION 'TENANT_MIGRATION_SQL_IN_PROGRESS: 该 schema 已有执行中的迁移 SQL 会话（会话级 advisory 互斥被占用）→ 拒绝并发写入';
  END IF;
  SELECT owner, fencing_token, (heartbeat_at > now() - (${stale}::bigint * interval '1 millisecond'))
    INTO cur_owner, cur_fence, cur_fresh
    FROM public."${MIGRATION_LOCK_TABLE}" WHERE schema_name = '${esc(schema)}';
  IF cur_owner IS NULL THEN
    RAISE EXCEPTION 'TENANT_MIGRATION_LOCK_LOST: 迁移锁行不存在（已被人工清除或从未建立）→ 拒绝写入';
  END IF;
  IF cur_owner <> '${esc(owner)}' OR cur_fence <> ${Number(fencingToken)}::bigint THEN
    RAISE EXCEPTION 'TENANT_MIGRATION_LOCK_LOST: 锁已易主（当前 owner=% fencing=%，本执行者 ${esc(owner)}#${Number(fencingToken)}）→ 拒绝写入', cur_owner, cur_fence;
  END IF;
  IF cur_fresh IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'TENANT_MIGRATION_LOCK_LOST: 心跳已过期（本执行者可能已被判定失联）→ 拒绝写入';
  END IF;
END $r5_guard$;`
}

/** 读锁行（只读；读错误返回 null）。**形状不符不吞**（fail-closed）。 */
export async function readTenantMigrationLock({ prisma, schema }) {
  assertSafeSchemaName(schema)
  try {
    await ensureTenantMigrationLockTable({ prisma })
    const rows = await prisma.$queryRawUnsafe(
      `SELECT schema_name, owner, locked_at, heartbeat_at, fencing_token, hostname, pid,
              EXTRACT(EPOCH FROM (now() - heartbeat_at))::int AS heartbeat_age_s
         FROM public."${MIGRATION_LOCK_TABLE}" WHERE schema_name = $1`, schema)
    return rows[0] || null
  } catch (e) {
    // P3-PUBLIC-INFRA-CHAIN-R1：形状不符是**产品性 fail-closed**——不得吞成"无锁"。
    // （若吞掉，调用方会以为"未加锁"继续写入，掩盖基础设施缺失；历史语义仅对普通读错误返回 null。）
    if (e && e.code === LOCK_TABLE_SHAPE_MISMATCH) throw e
    return null
  }
}

/** 全锁列表（只读诊断；供 `--check`/运维）。 */
export async function listTenantMigrationLocks({ prisma }) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT schema_name, owner, hostname, pid, fencing_token,
              EXTRACT(EPOCH FROM (now() - heartbeat_at))::int AS heartbeat_age_s
         FROM public."${MIGRATION_LOCK_TABLE}" ORDER BY schema_name`)
    return rows
  } catch { return [] }
}

/**
 * 取得某 schema 的迁移互斥锁。
 * @returns {Promise<{ok:boolean, owner:string, tookOver:boolean, fencingToken:number, takeoverReason:string|null}>}
 */
export async function acquireTenantMigrationLock({
  prisma, schema, owner, staleMs = 30 * 60 * 1000, waitMs = null,
  // R7 ①：**默认禁自动接管**（最安全即时修法）。仅在显式 `TENANT_MIGRATION_LOCK_STALE_TAKEOVER=on`
  // 的维护模式下，且"心跳过期 + 可证明死亡(ESRCH) + 无执行中 SQL 会话"三条同时成立才接管。
  allowStaleTakeover = String(process.env.TENANT_MIGRATION_LOCK_STALE_TAKEOVER || 'off') === 'on',
}) {
  assertSafeSchemaName(schema)
  const waitBudget = waitMs === null
    ? Math.max(0, Number(process.env.TENANT_MIGRATION_LOCK_TIMEOUT_MS || 0))   // 默认 0 = 立即拒绝
    : Math.max(0, Number(waitMs) || 0)
  const stale = Math.max(1000, Number(staleMs) || 0)
  const me = migrationLockIdentity()
  await ensureTenantMigrationLockTable({ prisma })
  const deadline = Date.now() + waitBudget
  let holder = null
  for (;;) {
    const inserted = await prisma.$executeRawUnsafe(
      `INSERT INTO public."${MIGRATION_LOCK_TABLE}" (schema_name, owner, locked_at, heartbeat_at, fencing_token, hostname, pid)
       VALUES ($1, $2, now(), now(), 1, $3, $4) ON CONFLICT (schema_name) DO NOTHING`,
      schema, owner, me.hostname, me.pid)
    if (Number(inserted) === 1) return { ok: true, owner, tookOver: false, fencingToken: 1, takeoverReason: null }

    holder = (await readTenantMigrationLock({ prisma, schema })) || {}
    const ageMs = Number(holder.heartbeat_age_s ?? 0) * 1000
    const sameHost = !!(holder.hostname && holder.hostname === me.hostname)
    const alive = isProcessAlive(holder.pid)
    const provableDead = !!(sameHost && holder.pid && alive === false)
    if (provableDead) {
      // R6 ③ 主判据（**证明原执行者已停止**）+ R7 ① 两项新增前提：
      //   · 默认禁止自动接管（需显式 TAKEOVER=on）；
      //   · 心跳必须已过期（避免"父进程刚起子进程还被误判"）；
      //   · 不得有执行中的 SQL 会话（psql 子进程/PG backend 仍可能继续执行长 SQL）。
      const inFlight = await sqlExecutorInFlight({ prisma, schema })
      const heartbeatStale = ageMs >= stale
      if (!allowStaleTakeover || !heartbeatStale || inFlight) {
        const why = !allowStaleTakeover
          ? '默认禁止自动接管（TENANT_MIGRATION_LOCK_STALE_TAKEOVER 未设为 on）'
          : (!heartbeatStale ? `心跳尚未过期（${holder.heartbeat_age_s ?? '?'}s < ${Math.round(stale / 1000)}s）` : '该 schema 仍有执行中的迁移 SQL 会话（会话级 advisory 互斥被占用）')
        const err = new Error(
          `${schema}: 原持有者进程已不存在（同主机 pid=${holder.pid} 无此进程），但**不得自动接管**：${why}。` +
          `R7 ①：父进程死亡不等于 SQL 执行者死亡（psql 子进程/PG backend 可能仍在执行）。` +
          `处置：确认 SQL 会话确实结束（\`--check\` 可见锁；必要时查 pg_stat_activity/pg_locks）后，` +
          `用 \`--force-unlock <code> --owner <owner> --fencing <n> --yes\` 人工清除；` +
          `或显式 \`TENANT_MIGRATION_LOCK_STALE_TAKEOVER=on\` 在维护窗口内允许"可证明死亡"的接管。`)
        err.code = inFlight ? 'TENANT_MIGRATION_SQL_IN_PROGRESS' : 'TENANT_MIGRATION_LOCK_STALE_UNPROVABLE'
        err.schema = schema
        err.holder = { owner: holder.owner || null, hostname: holder.hostname || null, pid: holder.pid ?? null, heartbeatAgeSeconds: holder.heartbeat_age_s ?? null }
        err.sqlInFlight = inFlight
        err.takeoverDisabled = !allowStaleTakeover
        throw err
      }
      const took = await prisma.$executeRawUnsafe(
        `UPDATE public."${MIGRATION_LOCK_TABLE}"
            SET owner = $2, locked_at = now(), heartbeat_at = now(), fencing_token = fencing_token + 1, hostname = $3, pid = $4
          WHERE schema_name = $1 AND fencing_token = $5::bigint`,
        schema, owner, me.hostname, me.pid, String(holder.fencing_token))
      if (Number(took) === 1) {
        return {
          ok: true, owner, tookOver: true, fencingToken: Number(holder.fencing_token) + 1,
          takeoverReason: `原执行者已停止（同主机 pid=${holder.pid} 不存在；心跳 ${holder.heartbeat_age_s}s 前）`,
        }
      }
      continue                                   // CAS 失败（竞争者已接管）→ 重新读取判定
    }
    if (ageMs >= stale) {
      // 心跳过期但**无法证明**死亡（异主机 / 无 pid / pid 仍存活）→ 拒绝（锁龄本身不是证据）
      const err = new Error(
        `${schema}: 互斥锁心跳已过期（${holder.heartbeat_age_s ?? '?'}s > ${Math.round(stale / 1000)}s）但**无法证明**原执行者已停止` +
        `（owner=${holder.owner || '?'}，hostname=${holder.hostname || '(未记录)'}，pid=${holder.pid ?? '(未记录)'}，pid存活=${alive === null ? '未知' : alive}；` +
        `本机=${me.hostname}）→ 按 R6 ③ 拒绝自动接管。` +
        `处置：确认该进程确已退出/失联后，用 \`node backend/sync-tenant-schemas.mjs --force-unlock <code>\`（需 --yes）人工清除。`)
      err.code = 'TENANT_MIGRATION_LOCK_STALE_UNPROVABLE'
      err.schema = schema
      err.holder = { owner: holder.owner || null, hostname: holder.hostname || null, pid: holder.pid ?? null, heartbeatAgeSeconds: holder.heartbeat_age_s ?? null }
      throw err
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 150))
  }
  const h = holder || {}
  const err = new Error(
    `${schema}: 已有迁移执行者持有互斥锁（owner=${h.owner || '?'}，心跳 ${h.heartbeat_age_s ?? '?'}s 前，fencing=${h.fencing_token ?? '?'}）→ 本执行者拒绝并发迁移。` +
    `等待其完成再重试；绝不并行修改同一 schema（接管需能证明原执行者已停止）。`)
  err.code = 'TENANT_MIGRATION_LOCK_HELD'
  err.schema = schema
  err.holder = { owner: h.owner || null, heartbeatAgeSeconds: h.heartbeat_age_s ?? null, fencingToken: h.fencing_token ?? null }
  throw err
}

/** 心跳续期（执行期间定期调用；返回 ok=false 表示已失权）。 */
export async function heartbeatTenantMigrationLock({ prisma, schema, owner, fencingToken }) {
  try {
    const n = await prisma.$executeRawUnsafe(
      `UPDATE public."${MIGRATION_LOCK_TABLE}" SET heartbeat_at = now()
        WHERE schema_name = $1 AND owner = $2 AND fencing_token = $3::bigint`,
      schema, owner, String(fencingToken))
    return { ok: Number(n) === 1 }
  } catch { return { ok: false } }
}

/** 持有者失权断言（每迁移/每关键写之前调用；失败 → fail-closed，绝不继续写）。 */
export async function assertTenantMigrationLockHeld({ prisma, schema, owner, fencingToken }) {
  const cur = await readTenantMigrationLock({ prisma, schema })
  if (cur && cur.owner === owner && Number(cur.fencing_token) === Number(fencingToken)) return true
  const err = new Error(
    `${schema}: 迁移互斥锁已失权（我=${owner}#${fencingToken}，当前=${cur ? `${cur.owner}#${cur.fencing_token}` : '(无锁)'}）` +
    `→ 立即停止写入（fail-closed；可能有另一执行者已接管）。`)
  err.code = 'TENANT_MIGRATION_LOCK_LOST'
  err.schema = schema
  throw err
}

/** 启动心跳计时器（返回 stop()；unref 不阻塞进程退出）。 */
export function startMigrationLockHeartbeat({ prisma, schema, owner, fencingToken, intervalMs = null, log = () => {} }) {
  const ms = Math.max(1000, Number(intervalMs || process.env.TENANT_MIGRATION_LOCK_HEARTBEAT_MS || 10000))
  const timer = setInterval(() => {
    heartbeatTenantMigrationLock({ prisma, schema, owner, fencingToken })
      .then((r) => { if (!r.ok) log(`❌ ${schema}: 互斥锁心跳失败（已失权 fencing=${fencingToken}）→ 后续写入将 fail-closed`) })
      .catch(() => {})
  }, ms)
  if (typeof timer.unref === 'function') timer.unref()
  return { stop: () => clearInterval(timer), intervalMs: ms }
}

/** 释放互斥锁（仅持有者+token 匹配才释放）。 */
export async function releaseTenantMigrationLock({ prisma, schema, owner, fencingToken = null }) {
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM public."${MIGRATION_LOCK_TABLE}" WHERE schema_name = $1 AND owner = $2` + (fencingToken === null ? '' : ' AND fencing_token = $3::bigint'),
      ...(fencingToken === null ? [schema, owner] : [schema, owner, String(fencingToken)]))
  } catch { /* 释放失败不掩盖主错误；锁将按"可证明死亡"接管或人工清除 */ }
}

/**
 * 人工清除崩溃锁（CLI `--force-unlock <code> --owner <o> --fencing <n> --yes`）：
 * **唯一**在无法自动接管时的放行通道。R7 ②：必须对"已展示给运维的 owner + fencing_token"做 **CAS**
 * —— 不匹配则不删并返回当前行（调用方重新展示），**绝不能删掉后来取得的新锁**。
 * @returns {Promise<{released:number, previous:object|null, current:object|null, outcome:string}>}
 */
export async function forceReleaseTenantMigrationLock({
  prisma, conn = null, schema, expectOwner = null, expectFencingToken = null, preDeleteDelayMs = 0,
}) {
  assertSafeSchemaName(schema)
  const previous = await readTenantMigrationLock({ prisma, schema })
  await ensureTenantMigrationLockTable({ prisma })
  if (!previous) return { released: 0, previous: null, current: null, outcome: 'NO_LOCK' }
  if (!expectOwner || expectFencingToken === null || expectFencingToken === undefined) {
    return { released: 0, previous, current: previous, outcome: 'EXPECTATION_REQUIRED' }
  }
  if (!conn || !conn.user) {
    // R8 ③：清除动作必须与执行批同处一个 advisory 互斥边界 → 必须走 psql 事务批（不接受"探测后裸 DELETE"）
    const err = new Error(`${schema}: 人工清锁需要 libpq 连接参数（须与执行批处于同一 advisory 互斥事务；不接受裸 DELETE）→ 拒绝`)
    err.code = 'TENANT_UNLOCK_CONN_REQUIRED'
    throw err
  }
  const key = migrationLockAdvisoryKey(schema)
  const esc = (v) => String(v).replace(/'/g, "''")
  const delayMs = Math.min(10000, Math.max(0, Number(preDeleteDelayMs) || 0))
  const batch = `-- R6 ③：同一 advisory 互斥事务内完成"再确认无执行中 SQL 会话 + CAS 删除"
DO $r6_unlock$
DECLARE acquired boolean; n int;
BEGIN
  SELECT pg_try_advisory_lock(${key}) INTO acquired;
  IF acquired IS NOT true THEN
    RAISE EXCEPTION 'TENANT_MIGRATION_SQL_IN_PROGRESS: 该 schema 已有执行中的迁移 SQL 会话（会话级 advisory 互斥被占用）→ 拒绝人工清锁';
  END IF;
  ${delayMs ? `PERFORM pg_sleep(${(delayMs / 1000).toFixed(3)});  -- 测试 seam：探测后、删除前窗口` : ''}
  WITH d AS (
    DELETE FROM public."${MIGRATION_LOCK_TABLE}"
     WHERE schema_name = '${esc(schema)}' AND owner = '${esc(expectOwner)}' AND fencing_token = ${Number(expectFencingToken)}::bigint
    RETURNING 1)
  SELECT count(*) INTO n FROM d;
  IF n <> 1 THEN
    RAISE EXCEPTION 'TENANT_UNLOCK_CAS_MISMATCH: CAS 未匹配（期望 owner=% fencing=% → 删除 0 行）→ 整个事务回滚，未删除任何锁',
      '${esc(expectOwner)}', ${Number(expectFencingToken)};
  END IF;
END $r6_unlock$;`
  let batchError = null
  try {
    await runPsqlBatch({ conn, sql: batch })
  } catch (e) {
    batchError = e
  }
  const current = await readTenantMigrationLock({ prisma, schema })
  const msg = batchError ? String(batchError.message) : ''
  const outcome = !batchError ? 'RELEASED'
    : /TENANT_MIGRATION_SQL_IN_PROGRESS/.test(msg) ? 'SQL_IN_PROGRESS'
      : /TENANT_UNLOCK_CAS_MISMATCH/.test(msg) ? (current ? 'CAS_MISMATCH' : 'RELEASED_BY_OTHER')
        : 'ERROR'
  return {
    released: outcome === 'RELEASED' ? 1 : 0, previous, current, outcome,
    error: batchError ? redactSecrets(msg).slice(0, 300) : null,
    atomic: 'advisory+tx',
  }
}

// ───────────────────────── baseline 提交前结构指纹（R7 ③） ─────────────────────────

/**
 * 结构指纹（**单条 SQL**，可同时用于 Prisma 侧与批内事务内）：
 * 覆盖 columns（类型/udt/可空/默认值，去 schema 限定）、约束（含 convalidated）、索引（唯一性+列序+谓词）、
 * 非契约对象（视图/物化视图/序列/外部表/分区表/函数/触发器）与额外表名。
 * 不含**数据语义**（NOT NULL/孤儿/重复扫描）——那部分只在证明阶段与提交后复证覆盖（见协议增量 §4）。
 * 指纹稳定：台账表（`_tenant_migrations`）及其索引/约束被显式排除。
 */
export function structureFingerprintQuery(schema, tables) {
  assertSafeSchemaName(schema)
  const esc = (v) => String(v).replace(/'/g, "''")
  const list = (tables || []).map((t) => `'${esc(t)}'`).join(',')
  return `SELECT COALESCE(md5(string_agg(x, '|' ORDER BY x)), 'empty') AS fp FROM (
  SELECT 'c:'||c.table_name||'.'||c.column_name||':'||c.data_type||':'||c.udt_name||':'||c.is_nullable||':'||
         regexp_replace(COALESCE(c.column_default,''), '"?[A-Za-z_][A-Za-z0-9_]*"?\\.', '', 'g') AS x
    FROM information_schema.columns c
   WHERE c.table_schema = '${esc(schema)}' AND c.table_name = ANY(ARRAY[${list}]::text[])
  UNION ALL
  SELECT 't:'||t.table_name FROM information_schema.tables t
   WHERE t.table_schema = '${esc(schema)}' AND t.table_type = 'BASE TABLE'
     AND t.table_name <> '${TENANT_LEDGER}' AND NOT (t.table_name = ANY(ARRAY[${list}]::text[]))
  UNION ALL
  SELECT 'k:'||con.conname||':'||con.contype::text||':'||con.convalidated::text||':'||
         regexp_replace(pg_get_constraintdef(con.oid), '"?[A-Za-z_][A-Za-z0-9_]*"?\.', '', 'g')
    FROM pg_constraint con JOIN pg_class tc ON tc.oid = con.conrelid JOIN pg_namespace n ON n.oid = tc.relnamespace
   WHERE n.nspname = '${esc(schema)}' AND tc.relname = ANY(ARRAY[${list}]::text[])
  UNION ALL
  SELECT 'i:'||ic.relname||':'||ix.indisunique::text||':'||COALESCE(pg_get_expr(ix.indpred, ix.indrelid), '')||':'||
         COALESCE((SELECT string_agg(a.attname||':'||k.ord::text, ',' ORDER BY k.ord)
                     FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                     LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum), '')
    FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_class tc ON tc.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = tc.relnamespace
   WHERE n.nspname = '${esc(schema)}' AND tc.relname = ANY(ARRAY[${list}]::text[])
  UNION ALL
  SELECT 'o:'||c.relkind::text||':'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = '${esc(schema)}' AND c.relkind IN ('v','m','S','f','p')
  UNION ALL
  SELECT 'f:'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${esc(schema)}'
  UNION ALL
  SELECT 'g:'||t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = '${esc(schema)}' AND NOT t.tgisinternal
) s(x)`
}

/** 取当前结构指纹（Prisma 侧；与批内校验使用同一 SQL）。 */
export async function structureFingerprint({ prisma, schema }) {
  const expected = readExpectedTenantTables()
  const rows = await prisma.$queryRawUnsafe(structureFingerprintQuery(schema, expected.ok ? [...expected.tables] : []))
  return rows[0]?.fp ?? null
}

// ───────────────────────── 学校标识解析 / baseline 目标校验（B2） ─────────────────────────

/**
 * 恢复流程的**临时 staging schema** 判据（与 restoreService 的 `<target>_stg_<token>` 命名一致）。
 *
 * staging schema 不是"可接入的正式学校"：它没有可执行的正式学校命令，
 * 也不得对其记 baseline（应先修复可复用的源 schema 或使用新备份重建）。
 */
export function isRestoreStagingSchema(schema) {
  const s = String(schema || '')
  return /_stg_/.test(s) || /_restore$/.test(s)
}

/** 由 schema 反推学校 code（`school_a_b` → `a-b`）；非 `school_` 形态返回 null。 */
export function schoolCodeFromSchema(schema) {
  const s = String(schema || '')
  if (!/^school_/.test(s)) return null
  const code = s.slice('school_'.length).replace(/_/g, '-')
  return code || null
}

/** staging schema 的固定指引（不给出无法执行的正式学校命令）。 */
export const BASELINE_STAGING_GUIDANCE =
  '该 schema 是恢复流程的临时 staging schema：不存在可执行的正式学校命令，也不得对其记 baseline；' +
  '请先修复**可复用的源 schema**（或使用新备份重建），再对正式学校走受控接入。'

/**
 * 解析 `--baseline-plan` / `--baseline-apply` 的位置参数（B2）。
 *
 * 契约：**只接受 `School.code`**（如 `zhsy`）；schema 形态（`school_zhsy`）必须被明确拒绝，
 * 不得再派生出 `school_school_zhsy` 这类无效目标。
 *
 * @returns {{ok:true, code:string, schema:string} | {ok:false, code:string|null, reason:string, hint:string}}
 */
export function interpretBaselineTargetArg(raw) {
  const arg = String(raw ?? '').trim()
  if (!arg) {
    return { ok: false, code: null, reason: '缺少学校标识', hint: '用法：--baseline-plan <School.code>（示例：--baseline-plan zhsy）' }
  }
  const lower = arg.toLowerCase()
  if (isRestoreStagingSchema(lower)) {
    return { ok: false, code: null, reason: `"${arg}" 是恢复流程的临时 staging schema 标识`, hint: BASELINE_STAGING_GUIDANCE }
  }
  if (/^school_/.test(lower)) {
    return {
      ok: false, code: null,
      reason: `"${arg}" 是 schema 名（school_<code>），不是学校代码（School.code）`,
      hint: '参数必须是 School.code：`--baseline-plan zhsy` 才寻址 schema `school_zhsy`；传 schema 名会被拒绝（否则会派生出 school_school_zhsy）。',
    }
  }
  const schema = schemaNameOf(lower)
  if (!schema) {
    return { ok: false, code: null, reason: `非法学校代码 "${arg}"`, hint: '学校代码仅允许字母/数字/连字符（示例：zhsy、school-a）' }
  }
  if (isRestoreStagingSchema(schema)) {
    return { ok: false, code: null, reason: `"${arg}" 派生出的 schema（${schema}）是临时 staging schema`, hint: BASELINE_STAGING_GUIDANCE }
  }
  return { ok: true, code: lower, schema }
}

/**
 * 校验 baseline 目标：**参数 → School.code → 派生 schema** 三者一致（B2）。
 * 只接受可复用源的正式学校；staging schema / 已删除学校 / schema 形态参数一律拒绝。
 */
export async function resolveBaselineSchoolTarget({ prisma, raw }) {
  const parsed = interpretBaselineTargetArg(raw)
  if (!parsed.ok) return parsed
  const row = await prisma.school
    .findUnique({ where: { code: parsed.code }, select: { code: true, status: true } })
    .catch(() => null)
  if (!row) {
    return {
      ok: false, code: parsed.code,
      reason: `public."School" 中不存在 code=${parsed.code} 的学校（或已被删除/回收）`,
      hint: '--baseline-plan/--baseline-apply 只接受可复用源的正式学校；已删除学校请以新备份重建。',
    }
  }
  const schema = schemaNameOf(row.code)
  if (!schema || schema !== parsed.schema) {
    return {
      ok: false, code: row.code,
      reason: `School.code=${row.code} 与其派生 schema 不一致（期望 ${parsed.schema}）`,
      hint: '请核对 School.code 与 schema 命名（`school_<code>`，`-`→`_`）。',
    }
  }
  if (isRestoreStagingSchema(schema)) {
    return { ok: false, code: row.code, reason: `School.code=${row.code} 派生出临时 staging schema（${schema}）`, hint: BASELINE_STAGING_GUIDANCE }
  }
  return { ok: true, code: row.code, schema, status: row.status }
}

/**
 * fail-closed 的受控接入提示（B2 修复）：使用**经校验的 School.code**，
 * staging schema 则给出 staging 指引（绝不给出无法执行的正式学校命令）。
 */
export function baselineAdmissionGuidance(schema, { schoolCode = null } = {}) {
  if (isRestoreStagingSchema(schema)) return `受控接入路径：${BASELINE_STAGING_GUIDANCE}`
  const code = schoolCode || schoolCodeFromSchema(schema) || '<School.code>'
  return `受控接入路径：① \`node backend/sync-tenant-schemas.mjs --baseline-plan ${code}\` 生成离线证明计划（结构+默认值+约束+索引+未知对象+数据语义）；` +
    `② 人工按计划 repair（或备份后按 runbook 重建）；③ 证明通过后用 \`--baseline-apply ${code} --evidence <plan.json>\` 记录 baseline。`
}

// ───────────────────────── 离线受控 baseline 的完整证明（R5 ②） ─────────────────────────

/**
 * baseline 证明（**只读**）：无台账旧库要记 baseline 前，必须证明"结构与数据语义与迁移链末端一致"。
 * 覆盖（全部必需）：
 *   ① 表集合、列（类型/udt/可空性/**默认值**）；
 *   ② 主键/唯一/外键约束（含 `convalidated`：未验证约束不算证明）；
 *   ③ **全部索引**（唯一与非唯一，按规范化定义比较）；
 *   ④ CHECK 约束；
 *   ⑤ 触发器/函数/物化视图/未归属序列 → 任何"未知对象"都必须为零（否则人工分类）；
 *   ⑥ 额外对象（表/列/索引/约束双向差集）→ 必须为零；
 *   ⑦ 数据语义：NOT NULL 列无 NULL；外键无孤儿；唯一索引无重复。
 * B1/B3 硬化（本函数只读、永不建对象）：
 *   · 缺契约表 → `tables.contract.present=false`；其上的 NOT NULL / 外键 / 唯一索引扫描
 *     **不查询不存在的表**，改记"未扫描/未证明"并令 `data.semantics=false`（不得算通过）；
 *   · 索引有效性：`indisvalid/indisready` 任一为假 → `indexes.valid=false`（无效索引不维护唯一性）；
 *   · 唯一索引按真实语义检查：默认 NULLS DISTINCT（含 NULL 的键组不构成冲突）、
 *     `NULLS NOT DISTINCT`（PG15+）纳入 NULL、部分索引按谓词限定、表达式索引按键表达式；
 *     键表达式不可读 / 扫描失败 → 记"未证明"（fail-closed）。
 * @returns {Promise<{ok:boolean, checks:Array<{id:string,ok:boolean,detail:string}>, proofDigest:string, counts:object}>}
 */
export async function buildBaselineProof({ prisma, schema, referenceSchema = 'public' }) {
  assertSafeSchemaName(schema)
  const expected = readExpectedTenantTables()
  const checks = []
  const push = (id, ok, detail = '') => { checks.push({ id, ok: !!ok, detail: String(detail).slice(0, 300) }) }
  if (!expected.ok) return { ok: false, checks: [{ id: 'schema.prisma', ok: false, detail: expected.reason }], proofDigest: null, counts: {} }
  const tables = [...expected.tables]

  // ① 列（类型/udt/可空性/默认值）
  const loadCols = async (sch) => prisma.$queryRawUnsafe(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = $1::text AND table_name = ANY($2::text[])`, sch, tables)
  const refCols = await loadCols(referenceSchema)
  const curCols = await loadCols(schema)
  const colKey = (c) => `${c.table_name}.${c.column_name}|${c.data_type}|${c.udt_name}|${c.is_nullable}|${c.column_default === null ? 'NULL' : String(c.column_default)}`
  const refColSet = new Set(refCols.map(colKey))
  const curColSet = new Set(curCols.map(colKey))
  const missingCols = [...refColSet].filter((x) => !curColSet.has(x))
  const extraCols = [...curColSet].filter((x) => !refColSet.has(x))
  push('columns.type.nullable.default', missingCols.length === 0 && extraCols.length === 0,
    `缺失/不一致 ${missingCols.length}，额外 ${extraCols.length}${missingCols.length ? `；例：${missingCols[0]}` : ''}${extraCols.length ? `；例：${extraCols[0]}` : ''}`)

  // ② 约束（pk/u/f/c，含 convalidated）
  const loadCons = async (sch) => prisma.$queryRawUnsafe(
    `SELECT c.relname AS table_name, con.contype AS contype, con.convalidated AS validated, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1::text AND c.relname = ANY($2::text[])`, sch, tables)
  const refCons = await loadCons(referenceSchema)
  const curCons = await loadCons(schema)
  const conKey = (c) => `${c.table_name}|${c.contype}|${normalizeConstraintDef(c.def)}`
  const refConSet = new Set(refCons.map(conKey))
  const curConSet = new Set(curCons.map(conKey))
  const missingCons = [...refConSet].filter((x) => !curConSet.has(x))
  const unvalidated = curCons.filter((c) => !c.validated).map(conKey)
  push('constraints.pk.unique.fk.check', missingCons.length === 0, `缺失 ${missingCons.length}${missingCons.length ? `；例：${missingCons[0]}` : ''}`)
  push('constraints.validated', unvalidated.length === 0, `未验证（NOT VALID）约束 ${unvalidated.length}${unvalidated.length ? `；例：${unvalidated[0]}` : ''}`)

  // ③ 全部索引（唯一 + 非唯一）
  // B3：数据语义扫描需要**真实索引语义**（键表达式/谓词/NULLS 语义/有效性），
  //     因此这里一次性取回目录事实（结构比较仍按规范化定义，语义不变）。
  const pgNum = Number((await prisma.$queryRawUnsafe(`SELECT current_setting('server_version_num')::int AS v`))[0]?.v || 0)
  const nullsNotDistinctExpr = pgNum >= 150000 ? 'i.indnullsnotdistinct' : 'false::boolean'
  const loadIdx = async (sch) => prisma.$queryRawUnsafe(
    `SELECT t.relname AS table_name,
            i.indexrelid::regclass::text AS index_name,
            i.indisunique AS is_unique,
            i.indisvalid AS is_valid,
            i.indisready AS is_ready,
            ${nullsNotDistinctExpr} AS nulls_not_distinct,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
            (SELECT array_agg(pg_get_indexdef(i.indexrelid, k.k, false) ORDER BY k.k)
               FROM generate_series(1, i.indnkeyatts) AS k(k)) AS keys,
            pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1::text AND t.relname = ANY($2::text[])`, sch, tables)
  const idxKey = (i) => `${i.table_name}|u=${i.is_unique}|${normalizeConstraintDef(i.def)}`
  const refIdxSet = new Set((await loadIdx(referenceSchema)).map(idxKey))
  const curIdxRows = await loadIdx(schema)
  const curIdxSet = new Set(curIdxRows.map(idxKey))
  const missingIdx = [...refIdxSet].filter((x) => !curIdxSet.has(x))
  const extraIdx = [...curIdxSet].filter((x) => !refIdxSet.has(x))
  push('indexes.all', missingIdx.length === 0 && extraIdx.length === 0,
    `缺失 ${missingIdx.length}，额外 ${extraIdx.length}${missingIdx.length ? `；例：${missingIdx[0]}` : ''}${extraIdx.length ? `；例：${extraIdx[0]}` : ''}`)

  // ③b 索引有效性（B3）：定义相同但**无效/未就绪**的索引不维护唯一性 → 不算证明通过
  const invalidIdx = curIdxRows.filter((i) => !i.is_valid || !i.is_ready)
  push('indexes.valid', invalidIdx.length === 0,
    `无效/未就绪索引 ${invalidIdx.length}${invalidIdx.length ? `：${invalidIdx.slice(0, 4).map((i) => i.index_name).join(', ')}` : ''}`)

  // ④ 未知对象（视图/物化视图/触发器/函数/未归属于本 schema 表的序列）
  const loadUnknown = async (sch) => prisma.$queryRawUnsafe(
    `SELECT 'view' AS kind, relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1::text AND relkind IN ('v','m')
     UNION ALL
     SELECT 'trigger', t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1::text AND NOT t.tgisinternal
     UNION ALL
     SELECT 'function', p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1::text
     UNION ALL
     SELECT 'sequence', c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1::text AND c.relkind='S'`, sch)
  const unknowns = await loadUnknown(schema)
  push('no.unknown.objects', unknowns.length === 0, `未知对象 ${unknowns.length}${unknowns.length ? `；例：${unknowns.slice(0, 4).map((u) => `${u.kind}:${u.name}`).join(', ')}` : ''}`)

  // ⑤ 表集合：缺失契约表（B1）与额外表（台账/白名单除外）
  const tenantTables = (await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1::text AND table_type='BASE TABLE'`, schema))
    .map((t) => t.table_name)
  const presentTables = new Set(tenantTables)
  const missingTables = tables.filter((t) => !presentTables.has(t))
  push('tables.contract.present', missingTables.length === 0,
    `缺失契约表 ${missingTables.length}${missingTables.length ? `：${missingTables.slice(0, 6).join(', ')}` : ''}`)
  const extraTables = tenantTables.filter((t) => !expected.tables.has(t) && !TENANT_LEDGER_WHITELIST.has(t))
  push('no.extra.tables', extraTables.length === 0, `额外表 ${extraTables.length}${extraTables.length ? `：${extraTables.slice(0, 6).join(', ')}` : ''}`)

  // ⑥ 数据语义（只读扫描；**缺失表/无法证明一律记不通过，绝不跳过算通过**）
  const dataChecks = []
  const notProven = []
  const presentCols = new Set(curCols.map((c) => `${c.table_name}.${c.column_name}`))
  try {
    const notNullCols = refCols.filter((c) => c.is_nullable === 'NO')
    for (const c of notNullCols.slice(0, 60)) {
      if (!presentTables.has(c.table_name)) { notProven.push(`NOT NULL未扫描:${c.table_name}`); continue }
      if (!presentCols.has(`${c.table_name}.${c.column_name}`)) { notProven.push(`NOT NULL未扫描:${c.table_name}.${c.column_name}(列缺失)`); continue }
      const rows = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "${schema}"."${c.table_name}" WHERE "${c.column_name}" IS NULL`)
      if (Number(rows[0]?.n) > 0) dataChecks.push(`NOT NULL 列含 NULL: ${c.table_name}.${c.column_name}(${rows[0].n})`)
    }
    for (const fk of refCons.filter((c) => c.contype === 'f').slice(0, 40)) {
      const m = String(fk.def).match(/FOREIGN KEY \(([^)]+)\) REFERENCES (?:[^.\s"]+\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\(([^)]+)\)/i)
      if (!m) continue
      const [, childCols, parentTable, parentCols] = m
      if (!presentTables.has(fk.table_name) || !presentTables.has(parentTable)) {
        notProven.push(`外键未扫描:${fk.table_name}→${parentTable}`); continue
      }
      const child = childCols.split(',').map((s) => s.trim().replace(/"/g, ''))
      const parent = parentCols.split(',').map((s) => s.trim().replace(/"/g, ''))
      if (child.some((cc) => !presentCols.has(`${fk.table_name}.${cc}`)) || parent.some((pc) => !presentCols.has(`${parentTable}.${pc}`))) {
        notProven.push(`外键未扫描:${fk.table_name}→${parentTable}(列缺失)`); continue
      }
      const join = child.map((cc, i) => `c."${cc}" = p."${parent[i]}"`).join(' AND ')
      const notNull = child.map((cc) => `c."${cc}" IS NOT NULL`).join(' AND ')
      const rows = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "${schema}"."${fk.table_name}" c
          LEFT JOIN "${schema}"."${parentTable}" p ON ${join}
          WHERE ${notNull} AND p."${parent[0]}" IS NULL`)
      if (Number(rows[0]?.n) > 0) dataChecks.push(`外键孤儿: ${fk.table_name}→${parentTable}(${rows[0].n})`)
    }
    // 唯一索引：按**真实 PostgreSQL 语义**检查（B3）——
    //   · 默认 NULLS DISTINCT：任一键列为 NULL 的组不构成冲突（不得报重复）；
    //   · NULLS NOT DISTINCT（PG15+）：NULL 视为相等，必须纳入检查；
    //   · 部分索引：只在谓词命中行内检查；表达式索引：按目录中的键表达式检查；
    //   · 无效/未就绪索引、键表达式不可读、扫描失败 → 记为"未证明"（fail-closed，不算通过）。
    const uniqIdx = curIdxRows.filter((i) => i.is_unique)
    for (const idx of uniqIdx.slice(0, 40)) {
      if (!presentTables.has(idx.table_name)) { notProven.push(`唯一索引未扫描:${idx.index_name}(表缺失)`); continue }
      if (!idx.is_valid || !idx.is_ready) { notProven.push(`唯一索引未扫描:${idx.index_name}(无效/未就绪)`); continue }
      const keyExprs = Array.isArray(idx.keys) ? idx.keys.map((k) => String(k ?? '').trim()) : []
      if (!keyExprs.length || keyExprs.some((k) => !k)) { notProven.push(`唯一索引未扫描:${idx.index_name}(键表达式不可读)`); continue }
      const keyNotNull = keyExprs.map((k) => `(${k}) IS NOT NULL`).join(' AND ')
      const whereSql = [idx.nulls_not_distinct ? 'TRUE' : keyNotNull, idx.predicate ? `(${idx.predicate})` : 'TRUE'].join(' AND ')
      const dupSql =
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM "${schema}"."${idx.table_name}" ` +
        `WHERE ${whereSql} GROUP BY ${keyExprs.join(', ')} HAVING count(*) > 1) d`
      let rows
      try {
        rows = await prisma.$queryRawUnsafe(dupSql)
      } catch (e) {
        notProven.push(`唯一索引无法证明:${idx.index_name}(${redactSecrets(e.message).slice(0, 80)})`); continue
      }
      if (Number(rows[0]?.n) > 0) dataChecks.push(`唯一索引重复值: ${idx.table_name}(${keyExprs.join(',')})`)
    }
  } catch (e) {
    // 扫描异常 = 未证明（fail-closed；绝不当成通过）
    dataChecks.push(`数据语义扫描异常（未证明）: ${redactSecrets(e.message).slice(0, 120)}`)
  }
  if (notProven.length) {
    dataChecks.push(`未扫描/未证明 ${notProven.length} 项（不通过）：${notProven.slice(0, 3).join('；')}`)
  }
  push('data.semantics', dataChecks.length === 0, `数据级问题 ${dataChecks.length}${dataChecks.length ? `；${dataChecks.slice(0, 3).join(' | ')}` : ''}`)

  const ok = checks.every((c) => c.ok)
  const proofDigest = crypto.createHash('sha256').update(JSON.stringify({
    schema, reference: referenceSchema, checks: checks.map((c) => `${c.id}:${c.ok}`), detail: checks.map((c) => c.detail),
    chain: migrationChainDigest(),
  })).digest('hex')
  return { ok, checks, proofDigest, counts: { tables: tenantTables.length, columns: curCols.length, constraints: curCons.length, indexes: curIdxSet.size } }
}

/**
 * 显式离线 baseline（人工动作；**必须先有通过证明且摘要匹配**）——R4 ④：证明与台账写入的原子边界。
 *
 * 步骤（全部在**迁移互斥锁内**执行，故并发迁移者被排除）：
 *   ① 取锁（与 applyTenantChain 同一把锁）→ 证明（`buildBaselineProof`）→ 摘要匹配校验；
 *   ② 单事务批（psql `--single-transaction`）：台账 DDL（幂等）+ **前置断言**（无 failed 行、
 *      既有行的 checksum 必须与链文件一致、不存在链外条目）+ 全链 upsert；
 *      **提交前任一步失败 → 整个事务回滚**（不会留下半套 baselined）；
 *      提交后复证失败 → 事务已提交（**不可回滚**）→ 标记 `failed`(baseline_postcheck=FAILED) 并阻断该校（见 ③）；
 *   ③ 事后校验：整链 11 条均 `baselined` + 重新证明仍通过（锁内应无变化），否则报 `TENANT_BASELINE_POSTCHECK_FAILED`。
 * 不执行任何迁移 SQL、不改结构/数据。
 * @param {{prisma:object, conn:object, schema:string, expectedProofDigest:string, referenceSchema?:string, log?:Function, lockOwner?:string}} opts
 */
export async function baselineTenantFromProof({ prisma, conn, schema, expectedProofDigest, referenceSchema = 'public', log = () => {}, lockOwner = null }) {
  assertSafeSchemaName(schema)
  if (!conn || !conn.user) {
    const err = new Error(`${schema}: 离线 baseline 需要 libpq 连接参数（原子事务批的执行通道）→ 拒绝（fail-closed）`)
    err.code = 'TENANT_BASELINE_CONN_REQUIRED'
    throw err
  }
  if (!expectedProofDigest) {
    const err = new Error(`${schema}: 离线 baseline 需要提供证明摘要（--evidence 计划文件）→ 拒绝（fail-closed）`)
    err.code = 'TENANT_BASELINE_EVIDENCE_REQUIRED'
    throw err
  }
  const me = migrationLockIdentity()
  const owner = lockOwner || `baseline:${me.pid}@${me.hostname}`
  const lock = await acquireTenantMigrationLock({ prisma, schema, owner })
  try {
    if (lock.tookOver) log(`⚠️  ${schema}: 接管互斥锁（${lock.takeoverReason}；fencing=${lock.fencingToken}）`)
    const proof = await buildBaselineProof({ prisma, schema, referenceSchema })
    if (!proof.ok) {
      const err = new Error(`${schema}: baseline 证明未通过 → 拒绝记录 baseline。失败项：${proof.checks.filter((c) => !c.ok).map((c) => `${c.id}(${c.detail})`).join('；')}`)
      err.code = 'TENANT_BASELINE_PROOF_FAILED'
      err.schema = schema
      err.checks = proof.checks
      throw err
    }
    if (proof.proofDigest !== expectedProofDigest) {
      const err = new Error(`${schema}: 计划文件摘要与实际现场不一致（计划 ${String(expectedProofDigest).slice(0, 12)}…，现场 ${String(proof.proofDigest).slice(0, 12)}…）→ 拒绝（现场已变化，请重新生成计划）`)
      err.code = 'TENANT_BASELINE_PROOF_DIGEST_MISMATCH'
      throw err
    }
    await assertTenantMigrationLockHeld({ prisma, schema, owner, fencingToken: lock.fencingToken })

    // R7 ③：提交前结构指纹（Prisma 侧）；批内事务中再算一次比对 → 独立 DDL 会话在**提交前**窗口内的改动会被拦下并整体回滚
    const fingerprintBefore = await structureFingerprint({ prisma, schema })
    const files = listMigrationFiles()
    const chainDigest = migrationChainDigest()
    const names = files.map((f) => f.name)
    const detail = `baseline(proof=${proof.proofDigest.slice(0, 16)};chain=${chainDigest.slice(0, 16)};checks=${proof.checks.length}✔;by=${owner}#${lock.fencingToken})`
    const fingerprintCheck = `DO $baseline_fp$
DECLARE v text;
BEGIN
  SELECT (${structureFingerprintQuery(schema, [...readExpectedTenantTables().tables])}) INTO v;
  IF v IS DISTINCT FROM '${String(fingerprintBefore).replace(/'/g, "''")}' THEN
    RAISE EXCEPTION 'TENANT_BASELINE_PRE_COMMIT_STRUCTURE_CHANGED: 提交前结构指纹不一致（计划期 % ≠ 提交期 %）→ 整个事务回滚，请在重新生成计划后重试', '${String(fingerprintBefore).slice(0, 12)}', COALESCE(left(v, 12), 'null');
  END IF;
END $baseline_fp$;`
    const valuesList = files.map((f) => `('${f.name}','${fileChecksum(f.name)}')`).join(',\n      ')
    const nameList = names.map((n) => `'${n}'`).join(',')
    const precheck = `DO $baseline_pre$
DECLARE bad text;
BEGIN
  SELECT string_agg(migration_name, ',') INTO bad FROM ${ledgerIdent(schema)}
   WHERE status = 'failed' AND COALESCE(detail, '') NOT LIKE '%baseline_postcheck=FAILED%';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '台账存在 failed 迁移（必须先人工处置）：%', bad;
  END IF;
  SELECT string_agg(l.migration_name, ',') INTO bad
    FROM ${ledgerIdent(schema)} l
    JOIN (VALUES
      ${valuesList}
    ) AS v(n, c) ON l.migration_name = v.n
   WHERE l.checksum <> v.c;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '台账 checksum 与链文件不一致（禁止 baseline 覆盖）：%', bad;
  END IF;
  SELECT string_agg(migration_name, ',') INTO bad FROM ${ledgerIdent(schema)}
   WHERE migration_name NOT IN (${nameList});
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '台账存在链外条目（需人工核对，禁止 baseline 覆盖）：%', bad;
  END IF;
END $baseline_pre$;`
    // R8 ④：批内先写**非终态** `baseline_pending` —— 该校天然被阻断；只有复证通过才**提升**为终态 baselined
    const upserts = files.map((f) => `INSERT INTO ${ledgerIdent(schema)} (migration_name, checksum, status, started_at, finished_at, projection_sha256, skipped_sweeps, chain_digest, detail)
  VALUES ('${f.name}', '${fileChecksum(f.name)}', 'baseline_pending', now(), NULL, NULL, 0, '${chainDigest}', $r4$${detail}$r4$)
  ON CONFLICT (migration_name) DO UPDATE SET status='baseline_pending', finished_at=NULL, checksum=EXCLUDED.checksum,
    projection_sha256=NULL, skipped_sweeps=0, chain_digest=EXCLUDED.chain_digest, detail=EXCLUDED.detail;`).join('\n')
    // 提交前延迟 seam（仅测试/受控反例用；缺省不生效，上限 10s）
    const preDelay = Math.min(10000, Math.max(0, Number(process.env.TENANT_BASELINE_PRE_COMMIT_DELAY_MS || 0)))
    if (preDelay) { log(`→ ${schema}: [seam] 提交前等待 ${preDelay}ms（用于受控并发结构变化反例）`); await new Promise((r) => setTimeout(r, preDelay)) }
    // 单事务（psql --single-transaction）：**会话互斥 + 事务内 fencing 断言 + 结构指纹 + 前置断言 + 全链写入**。
    // 提交前任一步失败 → 整个事务回滚（台账无写入）。
    await runPsqlBatch({
      conn,
      sql: [
        migrationLockGuardSql({ schema, owner, fencingToken: lock.fencingToken }),
        tenantLedgerDdl(schema),
        fingerprintCheck,
        precheck,
        upserts,
      ].join('\n'),
    })

    const after = await readTenantMigrationLedger(prisma, schema)
    const staged = new Set(after.rows.filter((r) => r.status === 'baseline_pending').map((r) => r.migration_name))
    const missing = names.filter((n) => !staged.has(n))
    if (missing.length) {
      const err = new Error(`${schema}: baseline 事务后核对失败——以下迁移未落 baseline_pending：${missing.join(',')}（事务边界异常，请取证排查）`)
      err.code = 'TENANT_BASELINE_LEDGER_INCOMPLETE'
      err.schema = schema
      throw err
    }
    // 提交后延迟 seam（仅测试/受控反例用；缺省不生效，上限 10s）
    const postDelay = Math.min(10000, Math.max(0, Number(process.env.TENANT_BASELINE_POST_COMMIT_DELAY_MS || 0)))
    if (postDelay) { log(`→ ${schema}: [seam] 提交后等待 ${postDelay}ms（用于受控并发结构变化反例）`); await new Promise((r) => setTimeout(r, postDelay)) }
    const stamp = new Date().toISOString()
    const post = await buildBaselineProof({ prisma, schema, referenceSchema })
    if (!post.ok) {
      // R8 ④：台账**已提交**（不可回滚），且行仍是**非终态** `baseline_pending` → 该校按 TENANT_MIGRATIONS_PENDING 阻断
      //        —— 阻断**不依赖**任何后续 UPDATE 是否成功（失败留痕只是审计信息）。
      const failedChecks = post.checks.filter((c) => !c.ok).map((c) => c.id).join('；')
      let markerWritten = false
      try {
        markerWritten = Number(await prisma.$executeRawUnsafe(
          `UPDATE ${ledgerIdent(schema)} SET detail = COALESCE(detail, '') || $1 WHERE migration_name = ANY($2::text[])`,
          `;baseline_postcheck=FAILED@${stamp};failed_checks=${failedChecks}`, names)) === names.length
      } catch (e) {
        log(`⚠️  ${schema}: 失败留痕写入未生效（${redactSecrets(e.message)}）——不影响阻断（台账仍为非终态 baseline_pending）`)
      }
      const err = new Error(
        `${schema}: **台账已提交（未回滚）**，但其后结构证明失败 → 台账保持**非终态**（status=baseline_pending，${names.length} 条）` +
        `→ 该校按 TENANT_MIGRATIONS_PENDING **持续阻断**（与失败留痕是否写入无关：${markerWritten ? '已写入留痕' : '留痕未生效'}）；` +
        `失败项：${failedChecks}。处置：人工复核结构后重新生成计划并 --baseline-apply。`)
      err.code = 'TENANT_BASELINE_POSTCHECK_FAILED'
      err.schema = schema
      err.committed = true
      err.rolledBack = false
      err.blocked = true
      err.ledgerStatus = 'baseline_pending'
      err.markerWritten = markerWritten
      err.failedChecks = post.checks.filter((c) => !c.ok).map((c) => c.id)
      throw err
    }
    // 复证通过 → **提升**为终态 baselined（唯一能把该校从阻断放开的写入）。
    // P3-PUBLIC-INFRA-CHAIN-R1（R9 §1）：**关闭"复证 → 提升"之间未经结构再核的窗口** ——
    //   提升与**结构指纹再核**在**同一 psql 单事务**内完成：只要复证时点之后结构又变（哪怕迁移链
    //   已 applied），事务内指纹断言即 RAISE → 提升整体回滚 → 台账保持非终态 baseline_pending
    //   → 该校持续阻断；不允许出现"事后对象被删/错形却仍被放行"的窗口。
    const fingerprintAfter = await structureFingerprint({ prisma, schema })
    const expectedAfter = String(fingerprintAfter ?? '').replace(/'/g, "''")
    let promoted = 0
    let promoteError = null
    try {
      await runPsqlBatch({
        conn,
        sql: `DO $promote_fp$
DECLARE v text;
BEGIN
  SELECT (${structureFingerprintQuery(schema, [...readExpectedTenantTables().tables])}) INTO v;
  IF v IS DISTINCT FROM '${expectedAfter}' THEN
    RAISE EXCEPTION 'TENANT_BASELINE_PROMOTION_STRUCTURE_CHANGED: 复证与提升之间结构再次变化（复证 % ≠ 提升 %）→ 不提升（保持非终态阻断）', '${String(fingerprintAfter || '').slice(0, 12)}', COALESCE(left(v, 12), 'null');
  END IF;
END $promote_fp$;
UPDATE ${ledgerIdent(schema)} SET status = 'baselined', finished_at = now(), detail = COALESCE(detail, '') || ';baseline_postcheck=OK@${stamp}'
  WHERE migration_name IN (${names.map((n) => `'${n}'`).join(',')}) AND status = 'baseline_pending';`,
      })
    } catch (e) { promoteError = e }
    const promotedRows = (await readTenantMigrationLedger(prisma, schema)).rows.filter((r) => r.status === 'baselined')
    if (promotedRows.length !== names.length) {
      const structureChanged = /TENANT_BASELINE_PROMOTION_STRUCTURE_CHANGED/.test(String(promoteError && promoteError.message || ''))
      const err = new Error(
        `${schema}: **台账已提交（未回滚）**，但"提升为 baselined"未完成（${promotedRows.length}/${names.length}）` +
        (structureChanged
          ? `；原因：**复证后结构再次变化**（TENANT_BASELINE_PROMOTION_STRUCTURE_CHANGED，提升事务整体回滚）`
          : '') +
        `→ 台账保持非终态（baseline_pending）→ 该校按 TENANT_MIGRATIONS_PENDING **持续阻断**；` +
        `请人工复核后重新 --baseline-apply（无需回滚）。${promoteError ? `提升错误：${redactSecrets(promoteError.message).slice(0, 200)}` : ''}`)
      err.code = structureChanged ? 'TENANT_BASELINE_PROMOTION_STRUCTURE_CHANGED' : 'TENANT_BASELINE_PROMOTION_FAILED'
      err.schema = schema
      err.committed = true
      err.rolledBack = false
      err.blocked = true
      err.ledgerStatus = 'baseline_pending'
      err.promoted = promotedRows.length
      throw err
    }
    promoted = promotedRows.length
    log(`→ ${schema}: 离线受控 baseline 已完成 ${files.length} 条（提交前事务原子：会话互斥+指纹+前置断言；提交后复证通过并提升为 baselined；未改结构/数据）`)
    return {
      schema, baselined: names, proofDigest: proof.proofDigest, checks: proof.checks,
      lockOwner: owner, fencingToken: lock.fencingToken, ledgerRows: after.rows.length,
      fingerprint: fingerprintBefore, postcheck: 'OK', stagedStatus: 'baseline_pending',
    }
  } finally {
    await releaseTenantMigrationLock({ prisma, schema, owner, fencingToken: lock.fencingToken })
  }
}

/** 台账存在性保证（显式命令路径；检查路径永不调用）。 */
export async function ensureTenantLedger({ conn, schema, log = () => {}, guardSql = '' }) {
  assertSafeSchemaName(schema)
  // R8 ①：建台账也是一次**结构写入批** → 必须与执行批同处"会话级 advisory + 事务内 fencing"边界
  await runPsqlBatch({ conn, sql: `${guardSql}${tenantLedgerDdl(schema)}` })
  log(`→ ${schema}: 台账就绪（${TENANT_LEDGER}）`)
}

/**
 * 逐租户迁移引擎核心：以**显式迁移链描述**为来源，把目标 schema 推进到链尾。
 *
 * 纪律（R5 返工后）：
 *   · 台账缺失 + **非空** schema → **fail-closed**（`TENANT_MIGRATION_STATE_UNPROVABLE`）：
 *     不再凭结构见证自动推断整条历史并写 `baselined`；仅当 **empty**（零 model 表）才从零回放。
 *     旧库接入唯一路径 = 离线受控证明（`buildBaselineProof` + `baselineTenantFromProof`）或人工 repair。
 *   · 并发：进入前取得 `public._tenant_migration_locks` 互斥（跨进程；失败即拒绝，可安全重试）。
 *   · 分类：每迁移按 [作用域 + 语句级显式分类] 投影；`@scope: public` 整条跳过（记 `skipped_public_only`）；
 *     含 catalog 引用但未分类的语句 fail-closed（绝不静默吞语句）。
 *   · 失败：记台账 `failed`（脱敏原因）并上抛；不自动重试（`retryFailed` 显式）。
 *
 * @param {{prisma:object, conn:object, schema:string, chainFiles:Array<{name:string,file?:string,checksum:string,sql?:string}>,
 *          retryFailed?:boolean, log?:Function, lock?:boolean, lockOwner?:string, staleLockMs?:number,
 *          schoolCode?:string|null}} opts  `schoolCode` 仅用于 fail-closed 提示中的**正式学校命令**（B2）
 */
export async function applyTenantChain({
  prisma, conn, schema, chainFiles, retryFailed = false, log = () => {},
  lock = true, lockOwner = `pid-${process.pid}`, staleLockMs = 30 * 60 * 1000, schoolCode = null,
}) {
  assertSafeSchemaName(schema)
  if (!Array.isArray(chainFiles) || !chainFiles.length) throw new Error('迁移链为空：拒绝在无版本化来源时修改租户结构（RC-04）')
  const chainDigest = migrationChainDigest()
  const readSql = (f) => (f.sql !== undefined ? String(f.sql) : fs.readFileSync(f.file, 'utf8'))
  const checksumOf = (f) => f.checksum || crypto.createHash('sha256').update(f.sql !== undefined ? String(f.sql) : fs.readFileSync(f.file)).digest('hex')

  const witnessByName = new Map(witnessProbes().map((w) => [w.name, w]))
  const result = { schema, status: 'noop', baselined: [], applied: [], skippedPublicOnly: [], pending: [], failed: null, locked: false }
  // R7 ①：每个 SQL 批的**首语句**（会话级 advisory + 事务内 owner/fencing/心跳断言）
  const guardFor = () => (lockAcquired && prisma
    ? migrationLockGuardSql({ schema, owner: lockOwner, fencingToken: lockFencing, staleMs: staleLockMs }) + '\n'
    : '')

  // ⓪ 迁移前静态分类（不写任何东西；未分类/作用域缺失在此 fail-closed）
  const classified = chainFiles.map((f) => {
    const sql = readSql(f)
    const checksum = checksumOf(f)
    const projection = buildTenantProjection({ name: f.name, sql, checksum })
    return { file: f, sql, checksum, projection }
  })

  let lockAcquired = false
  let lockFencing = null
  let heartbeat = null
  let holdLockForReview = false   // R8 ②：失败状态写不入台账时保留锁（fail-closed）
  try {
    if (lock && prisma) {
      const l = await acquireTenantMigrationLock({ prisma, schema, owner: lockOwner, staleMs: staleLockMs })
      lockAcquired = true
      lockFencing = l.fencingToken
      result.locked = true
      result.lockOwner = lockOwner
      result.fencingToken = l.fencingToken
      if (l.tookOver) log(`⚠️  ${schema}: 接管互斥锁（${l.takeoverReason}；fencing=${l.fencingToken}）`)
      heartbeat = startMigrationLockHeartbeat({ prisma, schema, owner: lockOwner, fencingToken: l.fencingToken, log })
    }

    let ledger = await readTenantMigrationLedger(prisma, schema)

    // ① 台账缺失：仅"空 schema"可从零回放；非空一律 fail-closed（R5 ②：不得凭稀疏见证推断历史）
    if (!ledger.exists) {
      const state = await detectTenantMigrationState(prisma, schema)
      log(`→ ${schema}: 无台账；结构见证（**仅诊断**）= ${state.kind}（satisfiedUpTo=${state.satisfiedUpTo}）`)
      if (state.kind !== 'empty') {
        const err = new Error(
          `${schema}: 台账缺失且存在既有结构 → 无法证明历史迁移状态，拒绝写入（RC-04 fail-closed）。` +
          `见证（仅诊断，不作为 baseline 依据）：${state.holds.map((h) => `${h.name.slice(0, 14)}=${h.holds ? '1' : '0'}`).join(' ')}。` +
          // B2：提示必须使用**经校验的 School.code**（不是 schema 名）；staging schema 给 staging 指引。
          baselineAdmissionGuidance(schema, { schoolCode }) +
          `不得 db push / 不盲目 resolve / 不由引擎自动 baseline。`)
        err.code = 'TENANT_MIGRATION_STATE_UNPROVABLE'
        err.schema = schema
        err.witnesses = state.holds
        err.diagnosticOnly = true
        throw err
      }
      await ensureTenantLedger({ conn, schema, log, guardSql: guardFor() })
      ledger = await readTenantMigrationLedger(prisma, schema)
    }

    // ② 失败迁移：默认拒绝，显式 retryFailed 才继续
    const done = new Set(ledger.rows.filter((r) => LEDGER_TERMINAL.has(r.status)).map((r) => r.migration_name))
    const failedRows = ledger.rows.filter((r) => r.status === 'failed')
    if (failedRows.length && !retryFailed) {
      const f = failedRows[failedRows.length - 1]
      const err = new Error(
        `${schema}: 台账存在失败迁移 ${f.migration_name}（reason=${redactSecrets(f.detail || 'n/a')}）。` +
        `按契约不自动重试/不盲目 resolve；人工核实后显式 ` + '`--retry-tenant-migrations`' + ` 重试。`)
      err.code = 'TENANT_MIGRATION_FAILED'
      err.schema = schema
      err.migration = f.migration_name
      err.detail = redactSecrets(f.detail || '')
      throw err
    }

    // R8 ④：baseline 已提交但未提升（status=baseline_pending）→ 拒绝按链回放（避免在未证实结构上重复执行迁移）
    const pendingBaselineRows = ledger.rows.filter((r) => r.status === 'baseline_pending')
    if (pendingBaselineRows.length) {
      const err = new Error(
        `${schema}: 台账存在 ${pendingBaselineRows.length} 条 baseline 待提升行（status=baseline_pending：baseline 已提交，但事后校验或提升未完成）` +
        `→ 拒绝按链回放（该校当前按 TENANT_MIGRATIONS_PENDING 阻断）。处置：人工复核结构后重新 \`--baseline-plan\` / \`--baseline-apply\`。`)
      err.code = 'TENANT_BASELINE_PENDING_REVIEW'
      err.schema = schema
      err.pendingBaseline = pendingBaselineRows.length
      throw err
    }

    const pending = classified.filter((c) => !done.has(c.file.name))
    result.pending = pending.map((p) => p.file.name)
    if (!pending.length) {
      result.status = 'up-to-date'
      log(`→ ${schema}: 已在链尾（台账 ${ledger.rows.length} 行；链 ${classified.length} 个）`)
      return result
    }
    log(`→ ${schema}: 待应用 ${pending.length} 个迁移（search_path 限定；分类驱动投影；口令不经 argv）`)

    for (const item of pending) {
      // R6 ③：每迁移前核对"我仍持锁"（fencing），失权立即 fail-closed（绝不续写）
      if (lockAcquired) await assertTenantMigrationLockHeld({ prisma, schema, owner: lockOwner, fencingToken: lockFencing })
      const { file, checksum, projection } = item
      const projectionSha = crypto.createHash('sha256').update(projection.sql).digest('hex')
      const baseInsert = (status, detail, extra = '') => `INSERT INTO ${ledgerIdent(schema)} (migration_name, checksum, status, started_at, finished_at, projection_sha256, skipped_sweeps, chain_digest, detail)
         VALUES ('${file.name}', '${checksum}', '${status}', now(), ${status === 'failed' ? 'NULL' : 'now()'}, ${status === 'skipped_public_only' ? 'NULL' : `'${projectionSha}'`}, ${projection.skipped}, '${chainDigest}', $r3$${detail}$r3$)
       ON CONFLICT (migration_name) DO UPDATE SET status=EXCLUDED.status, finished_at=EXCLUDED.finished_at, checksum=EXCLUDED.checksum,
         projection_sha256=EXCLUDED.projection_sha256, skipped_sweeps=EXCLUDED.skipped_sweeps, chain_digest=EXCLUDED.chain_digest, detail=EXCLUDED.detail;${extra}`

      // scope=public：整条跳过（记 skipped_public_only，可证明"不适用于租户"）
      if (projection.scope === 'public') {
        await runPsqlBatch({ conn, sql: guardFor() + baseInsert('skipped_public_only', `scope=public；跳过语句 ${projection.classification.stmtCount} 条（不落租户）`) })
        result.skippedPublicOnly.push(file.name)
        log(`  ⏭  ${file.name}（scope=public：逐租户不适用，记 skipped_public_only）`)
        continue
      }

      const shim = [
        `DROP VIEW IF EXISTS "${schema}"."pg_constraint";`,
        `CREATE VIEW "${schema}"."pg_constraint" AS SELECT * FROM pg_catalog.pg_constraint WHERE connamespace = '"${schema}"'::regnamespace;`,
      ].join('\n')
      const batch = [
        guardFor() + `SET LOCAL search_path TO "${schema}", public, pg_catalog;`,
        shim,
        projection.sql,
        `DROP VIEW IF EXISTS "${schema}"."pg_constraint";`,
        baseInsert(projection.skipped > 0 ? 'applied_projected' : 'applied',
          `kept=${projection.kept};skipped=${projection.skipped};scope=${projection.scope}` +
          `${projection.skippedDetail?.length ? `;skip_reasons=${projection.skippedDetail.map((s) => s.reason).join('|').slice(0, 200)}` : ''}`),
      ].join('\n')
      try {
        await runPsqlBatch({ conn, sql: batch })
        const probe = witnessByName.get(file.name)
        if (probe) {
          const holds = await probe.check(prisma, schema).catch(() => false)
          if (!holds) {
            const detail = `后置条件未满足（${probe.label}）——迁移执行完成但效果缺失`
            // R6 ②：此处不再自带写入（旧实现无 guard 且吞异常）——由外层通用失败分支统一经
            // recordTenantFailureRow（guard + 写后核对）记录；本处只负责抛错
            const err = new Error(`${schema}: 迁移 ${file.name} 后置条件验证失败：${detail}`)
            err.code = 'TENANT_MIGRATION_POSTCONDITION_FAILED'
            err.schema = schema
            err.migration = file.name
            err.detail = detail
            throw err
          }
        }
        result.applied.push(file.name)
        log(`  ✅ ${file.name}（kept=${projection.kept} skipped=${projection.skipped}${probe ? '；后置条件 ✓' : ''}）`)
      } catch (e) {
        const detail = redactSecrets(e.message).slice(0, 500)
        // R8 ②：受同一 guard 保护；**写后核对**；写不入则如实上报（不得声称"已记录"）并保留互斥锁待人工复核
        const recorded = await recordTenantFailureRow({
          prisma, conn, schema, name: file.name, log, sql: guardFor() + baseInsert('failed', detail),
        })
        if (!recorded.ok) holdLockForReview = true
        result.failed = { migration: file.name, recorded: recorded.ok }
        const err = new Error(
          `${schema}: 迁移 ${file.name} 执行失败（` +
          (recorded.ok
            ? '已记入台账 failed'
            : `**失败状态未能记入台账**（写入/核对未通过：${recorded.reason}）→ 已保留迁移互斥锁（owner=${lockOwner}#${lockFencing}）待人工复核，清除需 --force-unlock` ) +
          `；不自动回退/不盲目 resolve）：${detail}`)
        err.code = e.code === 'TENANT_MIGRATION_POSTCONDITION_FAILED' ? e.code : 'TENANT_MIGRATION_EXEC_FAILED'
        err.schema = schema
        err.migration = file.name
        err.detail = detail
        err.ledgerRecorded = recorded.ok
        err.lockHeldForReview = !recorded.ok
        throw err
      }
    }
    result.status = result.applied.length || result.skippedPublicOnly.length ? 'upgraded' : 'noop'
    return result
  } finally {
    if (heartbeat) heartbeat.stop()
    if (lockAcquired && prisma && !holdLockForReview) {
      await releaseTenantMigrationLock({ prisma, schema, owner: lockOwner, fencingToken: lockFencing })
    } else if (holdLockForReview) {
      log(`⛔ ${schema}: **保留**迁移互斥锁（owner=${lockOwner}，fencing=${lockFencing}）待人工复核：失败状态未能记入台账；` +
        `清除需 \`--force-unlock <code> --owner ${lockOwner} --fencing ${lockFencing} --yes\`（或确认无 SQL 会话后按 runbook 处置）。`)
    }
  }
}

/**
 * R8 ②：写入"迁移失败"台账行并**核对生效**（受 guard 保护的同一个 SQL 批）。
 * 返回 { ok, reason }；ok=false 时调用方必须如实上报"未记录"并保留互斥锁。
 */
export async function recordTenantFailureRow({ prisma, conn, schema, name, sql, log = () => {} }) {
  try {
    await runPsqlBatch({ conn, sql })
  } catch (e) {
    const reason = redactSecrets(e.message).slice(0, 200)
    log(`❌ ${schema}: 失败状态写入未生效（${reason}）`)
    return { ok: false, reason }
  }
  try {
    const l = await readTenantMigrationLedger(prisma, schema)
    const row = l.rows.find((r) => r.migration_name === name)
    if (row && row.status === 'failed') return { ok: true, reason: null }
    const reason = `核对不一致（status=${row ? row.status : '(无行)'}）`
    log(`❌ ${schema}: 失败状态写入后${reason}`)
    return { ok: false, reason }
  } catch (e) {
    const reason = `核对异常: ${redactSecrets(e.message).slice(0, 160)}`
    log(`❌ ${schema}: ${reason}`)
    return { ok: false, reason }
  }
}

/**
 * 生产入口：以**真实链文件**（`prisma/migrations/*`）调用引擎。
 * @param {{prisma:object, conn:object, schema:string, retryFailed?:boolean, log?:Function}} opts
 */
export async function applyTenantMigrations({ prisma, conn, schema, retryFailed = false, log = () => {}, schoolCode = null }) {
  const chainFiles = listMigrationFiles().map((f) => ({
    name: f.name, file: f.file, checksum: crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'),
  }))
  return applyTenantChain({ prisma, conn, schema, chainFiles, retryFailed, log, schoolCode })
}

export function normalizeConstraintDef(def) {
  return String(def)
    .replace(/\s+/g, ' ')
    .replace(/"?[A-Za-z_][A-Za-z0-9_]*"?\./g, '')
    .trim()
}

/**
 * 结构自证：目标 schema 与参照 schema（public = 迁移链末端）在**契约对象集合**（schema.prisma 的 model 表）
 * 上必须逐项一致——表 / 列（类型·可空性）/ 主键 / 唯一 / 外键。
 * 只读；不一致返回 ok:false + 明细（调用方 fail-closed）。
 */
export async function compareTenantStructureToPublic(prisma, { schema, referenceSchema = 'public' } = {}) {
  const expected = readExpectedTenantTables()
  if (!expected.ok) return { ok: false, reason: expected.reason, diffs: [] }
  const tables = [...expected.tables]
  const diffs = []
  const load = async (sch) => {
    const cols = await prisma.$queryRawUnsafe(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable
         FROM information_schema.columns WHERE table_schema = $1::text AND table_name = ANY($2::text[])`,
      sch, tables)
    const cons = await prisma.$queryRawUnsafe(
      `SELECT c.relname AS table_name, con.contype AS contype, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1::text AND con.contype IN ('p','u','f') AND c.relname = ANY($2::text[])`,
      sch, tables)
    const tableSet = new Set(cols.map((c) => c.table_name))
    const colSet = new Set(cols.map((c) => `${c.table_name}.${c.column_name}|${c.data_type}|${c.udt_name}|${c.is_nullable}`))
    const conSet = new Set(cons.map((c) => `${c.table_name}|${c.contype}|${normalizeConstraintDef(c.def)}`))
    // 唯一索引：Prisma 的 @unique / @@unique 在 PG 里落成 CREATE UNIQUE INDEX（不出现在 pg_constraint），
    // 必须单独覆盖（否则"唯一约束"面 = 0 项，等于没查）。
    const idx = await prisma.$queryRawUnsafe(
      `SELECT c.relname AS table_name, i.indisunique AS is_unique, i.indisprimary AS is_primary,
              pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1::text AND c.relname = ANY($2::text[])`,
      sch, tables)
    const idxSet = new Set(idx.map((i) => `${i.table_name}|u=${i.is_unique}|p=${i.is_primary}|${normalizeConstraintDef(i.def)}`))
    return { tableSet, colSet, conSet, idxSet }
  }
  const cur = await load(schema)
  const ref = await load(referenceSchema)
  const missing = (a, b, label) => { for (const x of a) if (!b.has(x)) diffs.push(`${label} 缺失: ${x}`) }
  const extra = (a, b, label) => { for (const x of a) if (!b.has(x)) diffs.push(`${label} 额外: ${x}`) }
  missing(ref.tableSet, cur.tableSet, '表')
  missing(ref.colSet, cur.colSet, '列')
  missing(ref.conSet, cur.conSet, '约束(主键/外键)')
  missing(ref.idxSet, cur.idxSet, '索引(唯一/主键)')
  // 额外对象（目标有、参照无）：**不自动 DROP**，由调用方分类/阻断（RC-04：不可悄悄删除）
  extra(cur.tableSet, ref.tableSet, '表')
  extra(cur.idxSet, ref.idxSet, '索引(唯一/主键)')
  // 列按名比较（类型差异由上面的 colSet 缺失项覆盖；此处只关心"多出来的列"）
  const colName = (s) => new Set([...s].map((x) => x.split('|')[0]))
  extra(colName(cur.colSet), colName(ref.colSet), '列')
  extra(cur.conSet, ref.conSet, '约束(主键/外键)')
  const missingDiffs = diffs.filter((d) => d.includes('缺失'))
  const extraDiffs = diffs.filter((d) => d.includes('额外'))
  return {
    ok: missingDiffs.length === 0,
    diffs: diffs.slice(0, 40),
    missingDiffs: missingDiffs.slice(0, 40),
    extraDiffs: extraDiffs.slice(0, 40),
    counts: {
      tables: ref.tableSet.size, columns: ref.colSet.size,
      primaryKeys: [...ref.conSet].filter((x) => x.includes('|p|')).length,
      foreignKeys: [...ref.conSet].filter((x) => x.includes('|f|')).length,
      uniqueIndexes: [...ref.idxSet].filter((x) => x.includes('|u=true|')).length,
      indexes: ref.idxSet.size,
    },
  }
}

// 租户初始 manager 用户名校验规则（与 UserManager / validationMiddleware 的 username 规则一致）
const USERNAME_RE = /^[a-zA-Z0-9_]{3,50}$/
export { USERNAME_RE }

/**
 * 初始化单个学校。
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} opts.prisma 全局 Prisma 单例（连 public）
 * @param {string} opts.code 学校代码（小写字母数字连字符）
 * @param {string} [opts.name] 学校显示名
 * @param {string} [opts.adminUsername] 租户首个 manager 用户名（默认 'manager'，可自定义避免各校雷同）
 * @param {string} opts.adminPassword 租户 admin 初始密码
 * @param {string} [opts.databaseUrl] 基础连接串（默认取 process.env.DATABASE_URL）
 * @param {boolean} [opts.acceptDataLoss] 既有租户结构对齐是否允许丢数据（默认 false = 非破坏性；
 *   仅显式传入或 TENANT_DB_PUSH_ACCEPT_DATA_LOSS=true 时生效，新建校恒为 false）
 * @param {(msg:string)=>void} [opts.log] 日志回调
 * @returns {Promise<{code:string, schema:string, created:boolean, adminCreated:boolean, adminUsername:string}>}
 */
export async function provisionSchool({
  prisma,
  code,
  name,
  adminUsername = 'manager',
  adminPassword,
  databaseUrl = process.env.DATABASE_URL,
  log = () => {},
  allowExisting = false,
  acceptDataLoss: acceptDataLossOpt = false
}) {
  if (!isValidSchoolCode(code)) {
    throw new Error(`非法学校代码: ${code}（仅允许小写字母、数字、连字符，长度 1~40）`)
  }
  // 初始 manager 用户名：自定义时强制白名单校验（字母/数字/下划线 3~50 位）
  const managerUsername = String(adminUsername || 'manager')
  if (!USERNAME_RE.test(managerUsername)) {
    throw new Error(`非法初始管理员用户名: ${managerUsername}（仅允许字母、数字、下划线，长度 3~50）`)
  }
  const baseUrl = (databaseUrl || '').split('?')[0]
  if (!baseUrl) throw new Error('缺少 DATABASE_URL，无法初始化学校')

  const schema = schemaNameOf(code)
  // DS-05：任何把 schema 名拼进 SQL/DDL 前强制白名单校验（不匹配立即 throw）
  assertSafeSchemaName(schema)
  const displayName = name || `学校(${code})`

  // M1/M2（窗口2）：废除弱默认密码 'changeme' 回退。
  // - adminPassword 缺失时不再静默降级；仅当 manager 账号确实需要创建时才要求密码
  //   （见步骤④），保证 tenantSync 对已有租户的幂等同步（不建号、不需要密码）不受影响。
  // - 显式开发/测试例外：ALLOW_INSECURE_TENANT_PASSWORD=true 时允许回退，
  //   但会打印高危警告，且创建的账号 must_change_password=true。
  const allowInsecureDevPassword = process.env.ALLOW_INSECURE_TENANT_PASSWORD === 'true'
  if (!adminPassword && allowInsecureDevPassword) {
    log(`🚨 [高危] ALLOW_INSECURE_TENANT_PASSWORD=true，租户 ${code} 将使用开发用弱密码，严禁在生产环境使用！`)
  }
  const pw = adminPassword || (allowInsecureDevPassword ? 'changeme' : null)

  // ① 创建 schema（幂等）
  const exists = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
    schema
  )
  // M1: 全新建校（schema 尚不存在）且无可用密码 → 在做任何变更前直接中止，
  //     不再回退弱默认密码。已存在租户的幂等同步（tenantSync/db:sync）不需要
  //     密码（manager 已存在，步骤④跳过），不受影响。
  if (!exists.length && !pw) {
    throw new Error(
      `拒绝建校 ${code}：缺少租户初始管理密码（SEED_ADMIN_PASSWORD / adminPassword）。` +
      `弱默认密码回退已移除；如确为本地开发环境，可显式设置 ALLOW_INSECURE_TENANT_PASSWORD=true`
    )
  }
  let created = false
  if (!exists.length) {
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    created = true
    log(`✅ 创建 schema: ${schema}`)
  } else {
    log(`ℹ️ schema 已存在: ${schema}`)
    // P2: 默认拒绝重复建校；批量同步/重建场景须显式 allowExisting=true
    if (!allowExisting) {
      const err = new Error(`学校代码已存在: ${code}（schema ${schema} 已存在）`)
      err.status = 409
      throw err
    }
  }

  // ② 以**版本化迁移链**为唯一来源推进该 schema（P3-W2-T02-R2，RC-04）
  //    - 新校（created=true，schema 刚建、零对象）：按链顺序**逐个回放**迁移（search_path 限定目标
  //      schema；跨 schema 扫全库语句投影剔除），每个迁移在租户台账 `_tenant_migrations` 记录
  //      name/checksum/status/projection/skipped_sweeps；
  //    - 存量校：台账缺失时按**结构见证**探测版本前缀 → 受控 baseline + 回放其后迁移；
  //      见证不一致/部分执行 → fail-closed（TENANT_MIGRATION_STATE_UNPROVABLE）；
  //    - 失败即记入台账（status='failed' + 脱敏原因）并上抛：不自动回退、不盲目 resolve；
  //    - 运行期无 db push、无 migrate diff 末态 SQL、不用 public 迁移状态冒充。
  const conn = parseDbUrl(baseUrl)
  if (!conn) throw new Error('DATABASE_URL 解析失败（无法建立 libpq 连接参数）')
  log(`→ 以版本化迁移链为源${created ? '回放物化' : '推进'} ${schema} 结构 ...`)
  const migration = await applyTenantMigrations({
    prisma, conn, schema,
    retryFailed: acceptDataLossOpt === true, // 历史签名兼容：显式 true 视为"允许重试失败迁移"
    log: (m) => log(`  [${schema}] ${m}`),
    schoolCode: code, // B2：fail-closed 提示使用正式 School.code
  })
  log(`✅ ${schema} 迁移台账推进完成（status=${migration.status}；baselined=${migration.baselined.length} applied=${migration.applied.length} pending=${migration.pending.length}）`)

  // ②b 逐项自证：契约对象集合（表/列/主键/唯一/外键）必须与 public（迁移链末）一致，否则 fail-closed
  const parity = await compareTenantStructureToPublic(prisma, { schema, referenceSchema: 'public' })
  if (!parity.ok) {
    const err = new Error(
      `租户 schema ${schema} 结构自证失败（与 public/迁移链末不一致，拒绝继续）：` +
      `${parity.diffs.slice(0, 10).join('；')}${parity.diffs.length > 10 ? ` …共 ${parity.diffs.length} 项` : ''}`
    )
    err.code = 'TENANT_STRUCTURE_PARITY_FAILED'
    err.schema = schema
    err.diffs = parity.diffs
    throw err
  }
  log(`✅ ${schema} 结构自证通过（表 ${parity.counts.tables} / 列 ${parity.counts.columns} / 主键 ${parity.counts.primaryKeys} / 唯一索引 ${parity.counts.uniqueIndexes} / 外键 ${parity.counts.foreignKeys}）`)

  // ③ 系统记录（public，幂等）
  // 原 SQL: ON CONFLICT DO UPDATE SET updated_at = now() —— 已存在时仅刷新 updated_at，不覆盖 name。
  // upsert update:{} 等价（@updatedAt 自动刷新）；create 时 id 由 @default(cuid()) 自动生成。
  await prisma.school.upsert({
    where: { code },
    create: { code, name: displayName, status: 'active' },
    update: {}
  })
  // BS-02：开通即写入安全默认值（仅首次创建生效，不覆盖已有记录）。
  // 各字段 JSON 形态与前端 frontend/js/utils/schoolCustomization.js 解析逻辑一致：
  //   对象类（field_labels/field_rules/field_options/field_order/custom_fields/theme_config）→ {}
  //   数组类（hidden_fields/test_types）→ []
  //   visible_types → 默认五大模块全开，避免开通即白屏
  // 迁移 Model API：Json 字段直接传对象/数组，Prisma 自动序列化，无需 ::jsonb cast（PG 42804）。
  const DEFAULT_VISIBLE_TYPES = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen']
  try {
    await prisma.schoolCustomization.create({
      data: {
        school_code: code,
        theme_config: {},
        field_labels: {},
        hidden_fields: [],
        field_rules: {},
        field_options: {},
        field_order: {},
        custom_fields: {},
        test_types: [],
        visible_types: DEFAULT_VISIBLE_TYPES,
      }
    })
  } catch (e) {
    if (e?.code !== 'P2002') throw e // 已存在则忽略（等价 ON CONFLICT DO NOTHING）
  }
  log(`✅ 系统记录 public."School"/"SchoolCustomization" 就绪`)

  // ④ 租户内首个 manager（幂等：该用户名已存在则跳过）
  //    admin 角色仅保留给平台超管（public schema，schoolCode=null），
  //    学校内最高权限为 manager，避免跨校越权。
  //    用户名默认 'manager'，支持超管自定义（如 tjb_admin），避免各校初始账号雷同。
  //    M2: 初始密码属于"临时密码"，账号一律置 must_change_password=true，
  //        首登强制改密的登录侧拦截由窗口1在 login/token 链路实现。
  let managerCreated = false
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`)

    // P0-PROV: 「学校 schema 内禁止 role=admin」制度兜底。
    // 历史脏数据（如 2026-07-23 schema-per-tenant 改造前在 school_demo 内写入的 admin 账号）
    // 必须在此被识别并降级为 manager，否则「重新初始化」会出现"新增平台管理员"的伪影（截图复现的根因）。
    // - 仅删除/降级 school 下 role='admin' 的行（不影响 manager/operator/viewer）
    // - 必须先于下方 SELECT managerUsername 判断执行，确保 fresh state
    const demoted = await tx.$executeRawUnsafe(
      `UPDATE "User" SET role = 'manager', "updated_at" = now() WHERE role = 'admin' RETURNING "username"`
    )
    if (Array.isArray(demoted) && demoted.length) {
      log(`🔧 租户 ${code}: 降级 ${demoted.length} 个历史 admin 账号 → manager (${demoted.map((r) => r.username).join(', ')})`)
    }

    const found = await tx.$queryRawUnsafe(
      `SELECT 1 FROM "User" WHERE "username" = $1 LIMIT 1`,
      managerUsername
    )
    if (found.length) {
      log(`ℹ️ 租户 ${code} 已存在用户 ${managerUsername}，跳过创建`)
      return
    }
    // M1: 需要建号但无可用密码 → 中止（覆盖"schema 已存在但初始用户缺失"的边缘情况）
    if (!pw) {
      throw new Error(
        `拒绝为租户 ${code} 创建初始用户 ${managerUsername}：缺少初始密码（SEED_ADMIN_PASSWORD / adminPassword），` +
        `弱默认密码回退已移除`
      )
    }
    const hash = await bcryptjs.hash(pw, 10)
    await tx.$executeRawUnsafe(
      `INSERT INTO "User"
         ("id","username","password_hash","full_name","role","status","school_code","must_change_password","created_at","updated_at")
       VALUES ($1,$2,$3,'School Manager','manager','active',$4,true,now(),now())`,
      `u_${code}_${managerUsername}`,
      managerUsername,
      hash,
      code
    )
    managerCreated = true
    log(`✅ 已为租户 ${code} 创建初始用户 ${managerUsername}（must_change_password=true，首登需改密）`)
  })

  return { code, schema, created, managerCreated, adminUsername: managerUsername }
}

/**
 * 把单个租户/暂存 schema 推进到**迁移链尾**（P3-W2-T02-R2：逐租户版本化，不再有 db push / 末态 diff）。
 *
 * 与 provisionSchool 不同：只做【迁移推进】——不创建 schema、不建 manager 账号、
 * 不写 public."School"/"SchoolCustomization" 系统记录。避免在恢复/对齐场景下
 * 误触发建号或系统记录更新。
 *
 * 用途（防 P2022 漂移，与 W3 恢复接口兼容）：
 *   - 恢复流程 restoreService 在影子恢复「原子切换」前调用，把 staging schema
 *     （备份带来的旧结构）按版本化链推进：台账缺失时以**结构见证**探测版本前缀
 *     → 受控 baseline + 回放其后迁移；见证不一致（部分执行/未知来源）→ fail-closed
 *     （TENANT_MIGRATION_STATE_UNPROVABLE），由人工按受控 runbook 处置。
 *   - 失败记入 staging 台账（status='failed' + 脱敏原因）并上抛；旧 schema 仍可回滚。
 *
 * @param {object} opts
 * @param {string} [opts.code] 学校代码（非空，将推导 school_<code>）
 * @param {string} [opts.schema] 显式 schema 名（影子恢复临时 schema 等场景，如 school_x_restore）
 * @param {boolean} [opts.retryFailed] 显式允许重试台账中失败的迁移（默认 false）
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<string>} 推进的 schema 名
 */
export async function alignTenantSchema({ code, schema, log = console.log, acceptDataLoss: retryFailedOpt = false, prisma = null }) {
  const targetSchema = schema || schemaNameOf(code)
  if (!targetSchema) throw new Error(`非法学校代码: ${code}（无法推导 schema）`)
  assertSafeSchemaName(targetSchema)
  const baseUrl = (process.env.DATABASE_URL || '').split('?')[0]
  if (!baseUrl) throw new Error('缺少 DATABASE_URL，无法推进 schema')
  const conn = parseDbUrl(baseUrl)
  if (!conn) throw new Error('DATABASE_URL 解析失败（无法建立 libpq 连接参数）')
  log(`→ 以版本化迁移链推进 ${targetSchema} 结构 ...`)
  // 调用方（如 W3 restoreService）可不传 prisma：本函数自建**短生命周期**客户端读台账/见证，用后断开。
  let ownClient = false
  let client = prisma
  if (!client) {
    const mod = await import('@prisma/client')
    client = new mod.PrismaClient({ datasources: { db: { url: baseUrl } } })
    ownClient = true
  }
  try {
    const r = await applyTenantMigrations({
      prisma: client, conn, schema: targetSchema,
      retryFailed: retryFailedOpt === true,
      log: (m) => log(`  [${targetSchema}] ${m}`),
      // B2：显式给了 code（正式学校）才作为提示依据；影子恢复的 staging schema 不带 code
      schoolCode: code || null,
    })
    log(`✅ ${targetSchema} 迁移台账推进完成（status=${r.status}；baselined=${r.baselined.length} applied=${r.applied.length} pending=${r.pending.length}）`)
    return targetSchema
  } finally {
    if (ownClient) await client.$disconnect().catch(() => {})
  }
}

export default { provisionSchool, alignTenantSchema, isValidSchoolCode, schemaNameOf }
