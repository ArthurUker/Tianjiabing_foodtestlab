// restoreService.js — 影子恢复**状态机**（P1；P3-W3-T01 加固：AUD-004/005 + NF-B-02）
//
// 目标：把备份文件恢复到目标学校 schema，且【不直接覆盖原 schema】——
// 先在任务私有暂存 schema（含随机熵 + 台账登记归属）还原并校验，通过后再事务内原子切换（双 rename）。
// 版本漂移/数据错误只会停留在暂存 schema，原数据零影响。
//
// 状态机（每阶段落文件台账：owner/jobId/目标 code/暂存 schema/阶段/时间戳）：
//   QUEUED → LOCKED → BARRIER（写屏障 + drain）→ STAGING → VALIDATING → SWITCHING → COMPLETE
//   （任一步失败 → CLEANUP（只 DROP 本任务登记且 OID 复核通过的暂存 schema）→ FAILED）
//
// RC-03 加固点：
//   ① 互斥（AUD-005）：同校备份/恢复共用一把 PG advisory lock（pg_try_advisory_xact_lock），
//      并发第二个请求**明确 409 拒绝**，不排队、不空跑；锁随事务/进程结束自动释放（无残留）。
//   ② 写屏障 + drain（AUD-005）：进入 STAGING 前安装 per-school 屏障（tenantWriteBarrier）
//      并复用 READONLY_MODE 全局限流；随后 drain 旧的在途写事务（超时 → 中止，不推进到切换）。
//   ③ 命名空间归属（AUD-004）：暂存名 `school_<code>_stg_<8hex>`（随机熵，**废除**固定名
//      `school_<code>_restore`）；旧备份点沿用既有 `school_<code>_old_<epoch ms>` 约定
//      （保护项 scripts/005_cleanup-old-schemas.mjs 依赖 `_old_[0-9]+` 命名，不得破坏）。
//      暂存 schema 创建后登记 pg_namespace OID，任何 DROP/RENAME 之前用 OID 再校验
//      「该对象仍是本任务创建的那一个」；任何 DROP 只命中台账登记对象。
//   ④ NF-B-02：解密后的明文 SQL **不再落 /tmp**——直接经管道（stdin）流式喂给 psql；
//      中间产物（如有）只允许落在台账登记的私有目录（0700）。
//
// 前提与约束：
//   - 目标学校必须已注册（public.School 存在且 status 不限，停用学校也可恢复）
//   - 恢复端 psql 版本必须 ≥ 备份端 pg_dump 版本（PG18 dump 含 \restrict，需 psql ≥ 18）
//   - 恢复是重操作：建议业务低峰执行；切换窗口毫秒级（单事务原子）
//   - 恢复操作必须由平台超管触发（路由层 requirePlatformSuperAdmin 保障）

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { schemaNameOf, assertSafeSchemaName } from './tenantClient.js'
import { verifyBackupFile } from './backupVerify.js'
import { writeAdminOpsLog } from './auditLog.js'
import { rewriteSchemaNames, extractSchemaSegment } from './restoreSqlUtils.js'
import { stripCreateSchema } from './restoreStagingSql.js'
import { alignTenantSchema } from './tenantProvisioner.js'
import { readCurrentSchemaColumns, compareSchemaSnapshot } from './schemaCompatibility.js'
import {
  newJobId, randomToken, createJobRecord, updateJobRecord, readJobRecord, listJobRecords,
  withMaintenanceLock, lockLabelsForScope, schemaOid, assertSchemaOwnership,
} from './backupJobs.js'
import {
  beginWriteBarrier, endWriteBarrier, enterGlobalMaintenance, exitGlobalMaintenance,
} from './tenantWriteBarrier.js'
import { MaintenanceLockBusyError, DrainTimeoutError } from './backupErrors.js'

const TAG = '[restoreService]'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = path.resolve(__dirname, '..')

/** 探测 psql 二进制路径（与 backupService.detectPgDumpBin 同策略）。 */
export function detectPsqlBin() {
  if (process.env.PG_DUMP_BIN) return process.env.PG_DUMP_BIN.replace(/pg_dump$/, 'psql')
  try {
    const dirs = fs.readdirSync('/usr/lib/postgresql').map((v) => Number(v)).filter((v) => v > 0).sort((a, b) => b - a)
    if (dirs.length) return `/usr/lib/postgresql/${dirs[0]}/bin/psql`
  } catch { /* 非 Linux，回落 PATH */ }
  return 'psql'
}

function cleanDatabaseUrl() {
  const url = (process.env.DATABASE_URL || '').split('?')[0]
  if (!url) throw new Error(`${TAG} 缺少 DATABASE_URL`)
  return url
}

/** 互斥事务上限（覆盖：屏障/drain + staging + db push + 切换）。 */
function restoreTxTimeoutMs() {
  const v = Number(process.env.RESTORE_TX_TIMEOUT_MS || 30 * 60 * 1000)
  return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000
}

/** drain 超时（等待旧写事务终结的上限；超时即中止恢复）。 */
function drainTimeoutMs() {
  const v = Number(process.env.RESTORE_DRAIN_TIMEOUT_MS || 10000)
  return Number.isFinite(v) && v >= 0 ? v : 10000
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 执行 psql。三种输入二选一：
 *   · mode='file'  用 -f 执行 SQL 文件；
 *   · mode='cmd'   用 -c 执行单条命令（多语句可含 BEGIN/COMMIT）；
 *   · stdinText    **流式**：不加 -f/-c，明文 SQL 经管道喂给 psql 的 stdin
 *     （NF-B-02：避免解密后的全量业务数据明文落到任何磁盘路径）。
 */
function runPsql({ sqlPath, command, stdinText, log = console.log }) {
  return new Promise((resolve, reject) => {
    const useStdin = sqlPath === undefined && command === undefined
    if (!useStdin && stdinText !== undefined) return reject(new Error('sqlPath/command 与 stdinText 不能同时提供'))
    if (!useStdin && !sqlPath && !command) return reject(new Error('必须提供 sqlPath / command / stdinText'))
    const args = [`--dbname=${cleanDatabaseUrl()}`, '-v', 'ON_ERROR_STOP=1']
    if (sqlPath) args.push('-f', sqlPath)
    else if (command) args.push('-c', command)
    const child = spawn(detectPsqlBin(), args, { stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr })
      reject(new Error(`psql 失败（exit=${code}, stdin=${useStdin ? 'yes' : 'no'}）: ${(stderr || stdout).slice(0, 800)}`))
    })
    if (useStdin) {
      // psql 可能因 SQL 错误提前退出（此时写管道会 EPIPE）——吞掉写错误，以 exit code 为准
      child.stdin.on('error', () => {})
      child.stdin.end(String(stdinText ?? ''))
    }
  })
}

// rewriteSchemaNames 已拆分至 ./restoreSqlUtils.js（纯函数，便于单元测试）

/**
 * drain：等待**屏障安装之前**启动的在途写事务结束（RC-03「in-flight drain」）。
 *   · 观测口径：pg_stat_activity 中 client backend、xact_start ≤ 屏障时间、
 *     且 query 命中目标 schema 的带引号标识符（`"school_x".`）；
 *   · 观测缺失/不可解析 → 抛错（fail-closed，不允许用缺失数据判定“已清理”）；
 *   · 超时 → DrainTimeoutError（中止恢复，不推进到 STAGING/SWITCHING）。
 */
async function drainActiveWriters(queryable, { schema, barrierStartedAt, excludePids = [], timeoutMs, log = console.log }) {
  const started = Date.now()
  const pids = (excludePids || []).filter((p) => p !== null && p !== undefined).map(Number)
  const pattern = `%"${schema}".%`
  for (;;) {
    const rows = await queryable.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND backend_type = 'client backend'
          AND pid <> pg_backend_pid()
          AND NOT (pid = ANY($1::int[]))
          AND xact_start IS NOT NULL
          AND xact_start <= $2::timestamptz
          AND query ILIKE $3`,
      pids.length ? pids : [0],
      barrierStartedAt,
      pattern
    )
    const n = rows?.[0]?.n
    if (n === undefined || n === null) {
      // 观测缺失/不可解析一律视为失败（禁止“缺数据=已清理”）
      throw new Error(`${TAG} drain 观测无效（pg_stat_activity 未返回计数），fail-closed 中止恢复`)
    }
    if (Number(n) === 0) return { drained: true, remaining: 0, waitedMs: Date.now() - started }
    if (Date.now() - started >= timeoutMs) {
      throw new DrainTimeoutError(
        `drain 超时（${timeoutMs}ms）：仍有 ${n} 个屏障前的在途写事务未结束（schema=${schema}），中止恢复`,
        { schema, remaining: Number(n), timeoutMs, waitedMs: Date.now() - started }
      )
    }
    log(`${TAG} drain 等待中：剩余在途写事务 ${n}`)
    await sleep(250)
  }
}

/**
 * 崩溃残留对账（持锁状态下调用）：只处理**台账登记 + OID 复核通过**的其它恢复任务的暂存 schema。
 * 未登记的同名前缀 schema（例如历史固定名或他人对象）一律不动（AUD-004）。
 */
async function reconcileStaleRestoreJobs({ jobId, targetSchema, queryable, log }) {
  const result = { examined: 0, dropped: [], skipped: [] }
  for (const rec of listJobRecords()) {
    if (rec.corrupt || rec.jobId === jobId || rec.kind !== 'restore') continue
    if (rec.targetSchema !== targetSchema) continue
    if (!rec.stagingSchema) continue
    if (!['LOCKED', 'BARRIER', 'STAGING', 'VALIDATING', 'SWITCHING', 'RECOVERY_REQUIRED'].includes(rec.state)) continue
    result.examined += 1
    const validShape = rec.stagingSchema.startsWith(`${targetSchema}_stg_`) && rec.stagingSchema !== targetSchema
    if (!validShape || !rec.stagingOid) {
      result.skipped.push({ jobId: rec.jobId, reason: 'not-a-registered-staging' })
      continue
    }
    const oid = await schemaOid(queryable, rec.stagingSchema)
    if (oid === null) { result.skipped.push({ jobId: rec.jobId, reason: 'already-gone' }); continue }
    if (String(oid) !== String(rec.stagingOid)) {
      // OID 不符 = 该名字已被他人对象占用 → fail-closed，绝不 DROP
      result.skipped.push({ jobId: rec.jobId, reason: 'oid-mismatch', expected: rec.stagingOid, actual: oid })
      continue
    }
    await runPsql({ command: `DROP SCHEMA "${rec.stagingSchema}" CASCADE` })
    await updateJobRecord(rec.jobId, {
      state: 'RECOVERY_REQUIRED',
      recoveryNote: `暂存 schema 已由 ${jobId} 按台账 OID 复核后清理`,
      reconciledBy: jobId,
      reconciledAt: new Date().toISOString(),
    })
    result.dropped.push({ jobId: rec.jobId, schema: rec.stagingSchema, oid })
    log(`${TAG} 对账清理历史暂存 schema ${rec.stagingSchema}（job=${rec.jobId}，oid 复核通过）`)
  }
  return result
}

/**
 * 失败清理：只 DROP **本任务台账登记且 OID 复核通过**的暂存 schema。
 * 任何一步证据不足 → 不 DROP（fail-closed，保留现场供人工核对）。
 */
async function cleanupOwnStaging({ queryable, jobId, targetSchema, stagingSchema, stagingOid, log = console.log }) {
  if (!stagingSchema || !stagingOid) return { dropped: false, reason: 'nothing-registered' }
  const rec = readJobRecord(jobId)
  if (!rec || rec.stagingSchema !== stagingSchema || String(rec.stagingOid) !== String(stagingOid)) {
    return { dropped: false, reason: 'ledger-mismatch' }
  }
  if (!stagingSchema.startsWith(`${targetSchema}_stg_`) || stagingSchema === targetSchema) {
    return { dropped: false, reason: 'name-not-staging-shaped' }
  }
  try {
    await assertSchemaOwnership(queryable, { jobId, schema: stagingSchema, expectedOid: stagingOid, stage: 'cleanup' })
  } catch (e) {
    return { dropped: false, reason: 'ownership-check-failed', error: e.message }
  }
  await runPsql({ command: `DROP SCHEMA "${stagingSchema}" CASCADE` })
  log(`${TAG} 失败清理：已 DROP 本任务暂存 schema ${stagingSchema}（oid 复核通过，他人对象未触碰）`)
  return { dropped: true, schema: stagingSchema, oid: stagingOid }
}

// ============ P3-W3-R1（DEFECT-1 根修）：切换前后租户授权快照 / 重放（只命中本任务目标 schema）============
// 缺陷：备份产物由 `pg_dump --no-acl` 生成（backupService.js），不含任何 GRANT；暂存 schema 由
// **管理身份**创建并灌入 SQL → 双重 rename 切换后，新目标 schema 上不再有租户角色的 USAGE /
// 表级 ACL / 序列授权 → 之后以租户角色访问即 42501（CONS-T01 实测 70 例 `permission denied for schema`）。
// 根修口径（总控裁决选项①）：SWITCHING **之前**以管理身份快照目标 schema 的逐项授权作为基线；
// 切换后按基线**幂等重放 GRANT**（只命中本任务目标 schema，最小面：不动他校/public、不撤销、
// 不扩散基线外授权）；重放动作与基线摘要登记进任务台账；重放后自证与基线逐项一致，否则抛出
// （fail-closed：任务 FAILED 且旧 schema 保留于切换前，供回滚 —— drop-old 在重放之后才执行）。
const ACL_OBJECT_KINDS = ['r', 'p', 'v', 'm', 'S']

/** 标识符安全引用（授权 SQL 唯一入口；角色名同源校验）。 */
function quoteGrantIdent(name) {
  const s = String(name)
  if (!/^[A-Za-z0-9_$]{1,63}$/.test(s)) throw new Error(`${TAG} 授权重放：非法标识符 ${s}`)
  return `"${s}"`
}

function granteeSql(grantee) {
  return grantee === 'PUBLIC' ? 'PUBLIC' : quoteGrantIdent(grantee)
}

/** 读取 schema 的逐项授权快照（管理身份；nspacl / relacl 经 aclexplode 展开）。 */
export async function readSchemaAclSnapshot(queryable, schema) {
  const schemaRows = await queryable.$queryRawUnsafe(
    `SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type AS privilege, a.is_grantable AS grantable
       FROM pg_namespace n
       CROSS JOIN LATERAL aclexplode(n.nspacl) a
       LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = $1::text
      ORDER BY grantee, privilege`,
    schema
  )
  // 对象清单必须来自 pg_class（LEFT JOIN LATERAL aclexplode）：relacl 为 NULL（= 默认仅 owner）
  // 的对象同样必须出现在清单里 —— 否则"授权缺失"会被误判为"对象不存在"（切换后新对象正是这种形态）。
  const objectRows = await queryable.$queryRawUnsafe(
    `SELECT c.relname AS name, c.relkind AS kind, COALESCE(r.rolname, 'PUBLIC') AS grantee,
            a.privilege_type AS privilege, a.is_grantable AS grantable
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN LATERAL aclexplode(c.relacl) a ON true
       LEFT JOIN pg_roles r ON r.oid = a.grantee
      WHERE n.nspname = $1::text AND c.relkind = ANY($2::text[])
      ORDER BY c.relname, grantee, privilege`,
    schema,
    ACL_OBJECT_KINDS
  )
  const objects = []
  const objectPrivileges = []
  for (const r of objectRows) {
    if (!objects.length || objects[objects.length - 1].name !== r.name) objects.push({ name: r.name, kind: r.kind })
    if (r.privilege === null || r.privilege === undefined) continue
    objectPrivileges.push({ name: r.name, kind: r.kind, grantee: r.grantee, privilege: r.privilege, grantable: r.grantable === true })
  }
  return {
    schema: String(schema),
    schemaPrivileges: schemaRows.map((r) => ({ grantee: r.grantee, privilege: r.privilege, grantable: r.grantable === true })),
    objects,
    objectPrivileges,
    capturedAt: new Date().toISOString(),
  }
}

/** 基线摘要（台账登记用；含可核验 digest，避免把全量 ACL 明细写进台账）。 */
export function aclSnapshotSummary(snapshot) {
  const canonical = JSON.stringify({
    s: [...snapshot.schemaPrivileges].map((p) => `${p.grantee}:${p.privilege}:${p.grantable ? 1 : 0}`).sort(),
    o: [...snapshot.objectPrivileges].map((p) => `${p.name}:${p.grantee}:${p.privilege}:${p.grantable ? 1 : 0}`).sort(),
  })
  return {
    schemaPrivilegeCount: snapshot.schemaPrivileges.length,
    objectPrivilegeCount: snapshot.objectPrivileges.length,
    objectCount: (snapshot.objects || []).length || new Set(snapshot.objectPrivileges.map((p) => p.name)).size,
    digest: createHash('sha256').update(canonical).digest('hex'),
    capturedAt: snapshot.capturedAt,
  }
}

/**
 * 基线 vs 现状的逐项差集（缺什么 → 补什么；基线中已不存在的对象只登记不报错）。
 *
 * P3-W3-R2（R4 返工 / grant option）：**授权身份必须包含"是否可转授"**。
 * 旧实现只比 `${grantee}:${privilege}` ⇒ 基线 `WITH GRANT OPTION`、切换后仅剩同名普通权限时
 * 被误判为"已一致"（applied=0 且自证通过），**可转授性静默丢失**。现定义：
 *   · 缺失 = 现状无同名项 **或** 基线 `grantable=true` 而现状 `grantable=false`（降级同样算缺失 → 重放补 WITH GRANT OPTION）；
 *   · 反向（基线普通、现状可转授）**不属于缺失** ⇒ 不生成任何 REVOKE（最小面），仅在 extras 侧登记为 upgrade。
 *   · schema 与 table/sequence 采用同一身份函数（对称）。
 */
function diffAclAgainstBaseline(baseline, current) {
  const curSchema = new Map()
  for (const p of current.schemaPrivileges) curSchema.set(`${p.grantee}:${p.privilege}`, p.grantable === true)
  const curObjects = new Map()
  // 对象存在性以 pg_class 清单为准（relacl=NULL 的对象也算存在，只是没有额外授权）
  for (const o of current.objects || []) curObjects.set(o.name, { kind: o.kind, privs: new Map() })
  for (const p of current.objectPrivileges) {
    if (!curObjects.has(p.name)) curObjects.set(p.name, { kind: p.kind, privs: new Map() })
    curObjects.get(p.name).privs.set(`${p.grantee}:${p.privilege}`, p.grantable === true)
  }
  const missingSchema = []
  for (const p of baseline.schemaPrivileges) {
    const key = `${p.grantee}:${p.privilege}`
    if (!curSchema.has(key)) missingSchema.push({ ...p, reason: 'missing' })
    else if (p.grantable === true && curSchema.get(key) !== true) missingSchema.push({ ...p, reason: 'grant-option-downgraded' })
  }
  const missingObjects = []
  const skipped = []
  for (const p of baseline.objectPrivileges) {
    const obj = curObjects.get(p.name)
    if (!obj) { skipped.push({ object: p.name, grantee: p.grantee, privilege: p.privilege, reason: 'object-missing-after-switch' }); continue }
    const key = `${p.grantee}:${p.privilege}`
    if (!obj.privs.has(key)) missingObjects.push({ ...p, kind: obj.kind, reason: 'missing' })
    else if (p.grantable === true && obj.privs.get(key) !== true) missingObjects.push({ ...p, kind: obj.kind, reason: 'grant-option-downgraded' })
  }
  return { missingSchema, missingObjects, skipped }
}

/**
 * 按基线幂等重放授权（单批 psql；只命中本任务目标 schema）。
 *
 * P3-W3-R2（R4 返工）—— 返回字段口径说准，不虚称双向相等：
 *   · `verifiedBaselineSatisfied`：**基线下界**（逐项 grantee/privilege/**grantable**，schema+table+sequence）已全部满足；
 *   · `verifiedIdentical`：**双向完全相同**才为 true —— 除基线下界外，还要求无基线外授权、无"现状可转授"升级、
 *     无 skipped 对象、且对象集合（name:kind）两侧一致；
 *   · `strictMismatch`：上述四类差异的计数（解释 `verifiedIdentical=false` 的来源）；
 *   · `grantOptionUpgrades`：基线普通而现状可转授的条目（**只登记、绝不 REVOKE**，最小面）；
 *   · `extraNotExpanded`：基线外授权（同样只登记、不撤销、不扩散）。
 * @returns {Promise<object>} { schema, applied, skipped, extraNotExpanded, grantOptionUpgrades, verifiedBaselineSatisfied, verifiedIdentical, strictMismatch, statements, baseline }
 * @throws 重放后**基线下界**仍未满足 → 抛错（调用方 fail-closed，不继续 drop-old）
 */
export async function replaySchemaAcl({ queryable, schema, baseline, log = console.log }) {
  const current = await readSchemaAclSnapshot(queryable, schema)
  const { missingSchema, missingObjects, skipped } = diffAclAgainstBaseline(baseline, current)
  const statements = []
  const applied = []
  for (const p of missingSchema) {
    statements.push(`GRANT ${p.privilege} ON SCHEMA ${quoteGrantIdent(schema)} TO ${granteeSql(p.grantee)}${p.grantable ? ' WITH GRANT OPTION' : ''};`)
    applied.push({ level: 'schema', schema, grantee: p.grantee, privilege: p.privilege })
  }
  for (const p of missingObjects) {
    const keyword = p.kind === 'S' ? 'SEQUENCE' : 'TABLE'
    statements.push(`GRANT ${p.privilege} ON ${keyword} ${quoteGrantIdent(schema)}.${quoteGrantIdent(p.name)} TO ${granteeSql(p.grantee)}${p.grantable ? ' WITH GRANT OPTION' : ''};`)
    applied.push({ level: p.kind === 'S' ? 'sequence' : 'table', schema, object: p.name, grantee: p.grantee, privilege: p.privilege })
  }
  if (statements.length) {
    await runPsql({ command: statements.join('\n') })
    log(`${TAG} 授权重放：已按基线恢复 ${applied.length} 项授权（schema=${schema}，单批 psql）`)
  } else {
    log(`${TAG} 授权重放：切换后授权与基线一致，无需动作（schema=${schema}）`)
  }

  // 自证：重放后必须满足**基线下界（含可转授）**（否则 fail-closed）
  const verified = await readSchemaAclSnapshot(queryable, schema)
  const after = diffAclAgainstBaseline(baseline, verified)
  if (after.missingSchema.length || after.missingObjects.length) {
    const sample = [
      ...after.missingSchema.map((p) => `${p.grantee}:${p.privilege}@schema${p.reason === 'grant-option-downgraded' ? '(grant-option)' : ''}`),
      ...after.missingObjects.slice(0, 5).map((p) => `${p.grantee}:${p.privilege}@${p.name}${p.reason === 'grant-option-downgraded' ? '(grant-option)' : ''}`),
    ]
    throw new Error(`${TAG} 授权重放未达成基线下界（缺失 ${after.missingSchema.length + after.missingObjects.length} 项，含可转授差异），fail-closed：${sample.join(', ')}`)
  }

  // 基线外授权/升级：只登记（不扩散、不撤销 —— 最小面）。
  // P3-W3-R2：`grantable` 参与身份 —— 基线普通而现状可转授属"升级"，登记但**不 REVOKE**；
  // 它使 `verifiedIdentical`（双向完全相同）为 false，而 `verifiedBaselineSatisfied` 仍为 true。
  const baseSchemaMap = new Map(baseline.schemaPrivileges.map((p) => [`${p.grantee}:${p.privilege}`, p.grantable === true]))
  const baseObjectMap = new Map(baseline.objectPrivileges.map((p) => [`${p.name}:${p.grantee}:${p.privilege}`, p.grantable === true]))
  const extraNotExpanded = []
  const grantOptionUpgrades = []
  for (const p of verified.schemaPrivileges) {
    const key = `${p.grantee}:${p.privilege}`
    if (!baseSchemaMap.has(key)) extraNotExpanded.push({ level: 'schema', grantee: p.grantee, privilege: p.privilege, grantable: p.grantable === true })
    else if (p.grantable === true && baseSchemaMap.get(key) !== true) grantOptionUpgrades.push({ level: 'schema', grantee: p.grantee, privilege: p.privilege })
  }
  for (const p of verified.objectPrivileges) {
    const level = p.kind === 'S' ? 'sequence' : 'table'
    const key = `${p.name}:${p.grantee}:${p.privilege}`
    if (!baseObjectMap.has(key)) extraNotExpanded.push({ level, object: p.name, grantee: p.grantee, privilege: p.privilege, grantable: p.grantable === true })
    else if (p.grantable === true && baseObjectMap.get(key) !== true) grantOptionUpgrades.push({ level, object: p.name, grantee: p.grantee, privilege: p.privilege })
  }
  // 严格双向相同 = 基线下界满足 ∧ 无额外/升级 ∧ 无 skipped ∧ 对象集合（name:kind）两侧一致
  const nameSet = (snap) => new Set((snap.objects || []).map((o) => `${o.name}:${o.kind}`))
  const baseNames = nameSet(baseline)
  const curNames = nameSet(verified)
  const missingObjectNames = [...baseNames].filter((x) => !curNames.has(x)).length
  const extraObjectNames = [...curNames].filter((x) => !baseNames.has(x)).length
  const strictMismatch = {
    extraNotExpandedCount: extraNotExpanded.length,
    grantOptionUpgradeCount: grantOptionUpgrades.length,
    skippedCount: skipped.length,
    missingObjectNames,
    extraObjectNames,
  }
  const verifiedIdentical = strictMismatch.extraNotExpandedCount === 0
    && strictMismatch.grantOptionUpgradeCount === 0
    && strictMismatch.skippedCount === 0
    && strictMismatch.missingObjectNames === 0
    && strictMismatch.extraObjectNames === 0
  return {
    schema: String(schema),
    applied,
    skipped,
    extraNotExpanded,
    grantOptionUpgrades,
    // 基线下界（含可转授）已全部满足；此后才允许调用方继续 drop-old
    verifiedBaselineSatisfied: true,
    // 双向完全相同（不虚称）：仅当基线外无额外/升级、对象集合一致时为 true
    verifiedIdentical,
    strictMismatch,
    statements: statements.length,
    baseline: aclSnapshotSummary(baseline),
  }
}

/**
 * 执行一次影子恢复（状态机；失败返回 {ok:false}，互斥冲突抛 MaintenanceLockBusyError→409）。
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} opts.prisma 基础单例（连 public）
 * @param {object} opts.backup BackupRun 记录（含 file_path / table_counts / scope 等）
 * @param {string} opts.targetSchoolCode 目标学校代码
 * @param {object} [opts.actor] { userId, username, role, schoolCode, ip }（审计）
 * @param {(m:string)=>void} [opts.log]
 * @param {object} [opts.__hooks] 仅供本包定点测试注入（生产调用方不传）：
 *   `afterStaging(ctx)` 在暂存 schema 创建、SQL 灌入之前执行。
 * @returns {Promise<{ok: boolean, schema: string, jobId: string, stagingSchema: string|null, oldSchema: string|null, checks: Array<[string,string]>, error?: string, code?: string|null}>}
 */
export async function runRestore({ prisma, backup, targetSchoolCode, actor, log = console.log, __hooks = {} }) {
  const schema = schemaNameOf(targetSchoolCode)
  if (!schema) throw new Error(`${TAG} 非法学校代码: ${targetSchoolCode}`)
  assertSafeSchemaName(schema)

  const checks = []
  const step = (name, msg) => { checks.push([name, msg]); log(`${TAG} ${name}: ${msg}`) }

  const jobId = newJobId('restore')
  await createJobRecord({
    jobId,
    kind: 'restore',
    targetSchoolCode,
    targetSchema: schema,
    stagingSchema: null,
    stagingOid: null,
    oldSchema: null,
    state: 'QUEUED',
    owner: { pid: process.pid, hostname: process.env.HOSTNAME || '', username: process.env.USER || process.env.LOGNAME || '' },
    stages: [{ stage: 'QUEUED', at: new Date().toISOString() }],
  })

  let stagingSchema = null
  let stagingOid = null
  let oldSchema = null
  let barrierJob = null
  let maintToken = null
  let aclBaseline = null   // P3-W3-R1：切换前目标 schema 授权基线
  let aclReplay = null     // P3-W3-R1：切换后重放登记
  const labels = lockLabelsForScope({ kind: 'restore', scope: 'single', schema })

  try {
    const result = await withMaintenanceLock({
      prisma,
      labels,
      kind: 'restore',
      timeoutMs: restoreTxTimeoutMs(),
      fn: async ({ tx, keys, txBackendPid }) => {
        let targetOidAtStart = null
        try {
          await updateJobRecord(jobId, {
            state: 'LOCKED',
            lockKeys: keys,
            lockTxBackendPid: txBackendPid,
            stages: [{ stage: 'LOCKED', at: new Date().toISOString(), labels }],
          })
          log(`${TAG} 已获得互斥锁（jobId=${jobId}, labels=${labels.join(',')}）`)

          // ── 0. 目标 schema 必须存在（School 注册表指向的 schema）──
          targetOidAtStart = await schemaOid(tx, schema)
          if (!targetOidAtStart) throw new Error(`目标 schema 不存在: ${schema}（学校 ${targetSchoolCode} 未初始化）`)
          await updateJobRecord(jobId, { targetOidAtStart })

          // 崩溃残留对账（持锁 ⇒ 同校历史任务必已结束；只清理台账登记 + OID 复核的对象）
          const reconcile = await reconcileStaleRestoreJobs({ jobId, targetSchema: schema, queryable: tx, log })
          if (reconcile.dropped.length || reconcile.skipped.length) {
            await updateJobRecord(jobId, { staleReconcile: reconcile })
          }

          // ── 1. PREPARING：定位并加载备份文件（解密后明文只在内存）──
          const aesPath = backup.file_path
          if (!aesPath || !fs.existsSync(aesPath)) throw new Error(`备份文件不存在: ${aesPath}`)
          const metaPath = aesPath.replace(/\.sql\.gz\.aes$/, '.meta.json')
          step('PREPARING', `加载备份 ${path.basename(aesPath)}`)
          const v = await verifyBackupFile(aesPath, metaPath)
          if (!v.ok) throw new Error(`备份文件验证未通过: ${v.error}`)
          const { meta, sqlText } = v
          if (meta.tableCounts && typeof meta.tableCounts === 'string') meta.tableCounts = JSON.parse(meta.tableCounts)

          // ── 2. BARRIER：写屏障 + drain（进入 STAGING 前拒绝该校新写入，等待在途写事务终结）──
          await updateJobRecord(jobId, { state: 'BARRIER', stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'BARRIER', at: new Date().toISOString() }] })
          barrierJob = beginWriteBarrier({ schoolCode: targetSchoolCode, jobId, reason: 'restore-window' })
          // 复用既有 READONLY_MODE 全局开关（readOnlyMiddleware 已全局挂载 → 零改动接入；
          // 结束后按进入前的值还原；RESTORE_ENGAGE_READONLY_MODE=false 可关闭）。
          if (process.env.RESTORE_ENGAGE_READONLY_MODE !== 'false') {
            maintToken = enterGlobalMaintenance({ token: `${jobId}:readonly`, reason: 'restore-window' }).token
          }
          const barrierStartedAt = new Date().toISOString()
          step('BARRIER', `写屏障已安装（school=${targetSchoolCode} + READONLY_MODE），开始 drain 在途写事务`)
          const drain = await drainActiveWriters(tx, {
            schema,
            barrierStartedAt,
            excludePids: [txBackendPid],
            timeoutMs: drainTimeoutMs(),
            log,
          })
          step('BARRIER', `drain 完成：屏障前在途写事务=0（等待 ${drain.waitedMs}ms）`)
          await updateJobRecord(jobId, { drain, barrierStartedAt })

          // ── 3. STAGING：随机暂存 schema（登记归属），恢复数据 ──
          // 方案B：备份可能是全库（scope='all'，含多个租户 schema + public），
          // 恢复时只提取【目标学校】的 schema 段，其它 schema 的表/数据不进入暂存 schema，
          // 保证学校侧恢复不触及其他学校数据（租户隔离底线）。
          let sqlSource = sqlText
          let expectedTables = null // 行数校验基线（null = 用 meta.tableCounts 全部）
          if (backup.scope === 'all') {
            const seg = extractSchemaSegment(sqlText, schema)
            if (!seg.trim()) throw new Error(`全库备份中未找到 schema ${schema} 的段，无法恢复`)
            sqlSource = seg
            // 全库备份的 tableCounts 覆盖所有 schema，行数校验只需比对目标 schema 的表
            const tc = meta.tableCounts || {}
            expectedTables = Object.entries(tc).filter(([k]) => k.split('.')[0] === schema)
            if (!expectedTables.length) throw new Error(`meta 中缺少 schema ${schema} 的表计数，拒绝恢复`)
            step('PREPARING', `全库备份 → 仅提取 ${schema} 段（${expectedTables.length} 张表）`)
          }

          stagingSchema = `${schema}_stg_${randomToken(4)}`
          assertSafeSchemaName(stagingSchema)
          if (stagingSchema.length > 63) throw new Error(`暂存 schema 名超长: ${stagingSchema}`)
          await updateJobRecord(jobId, { stagingSchema })
          // 不用 IF NOT EXISTS：若撞名必须失败（绝不复用/覆盖未登记对象）
          await runPsql({ command: `CREATE SCHEMA "${stagingSchema}"` })
          stagingOid = await schemaOid(tx, stagingSchema)
          if (!stagingOid) throw new Error(`暂存 schema 创建后未在 pg_namespace 中出现: ${stagingSchema}`)
          await updateJobRecord(jobId, {
            state: 'STAGING',
            stagingSchema,
            stagingOid,
            stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'STAGING', at: new Date().toISOString(), stagingSchema, stagingOid }],
          })
          step('STAGING', `已创建暂存 schema ${stagingSchema}（oid=${stagingOid}，台账已登记归属）`)

          // 剔除备份 SQL 中冗余的 `CREATE SCHEMA "<暂存名>";`（本任务已在上面显式创建并登记 OID，
          // 若不剔除会因 schema 已存在而中断；见 restoreSqlUtils.stripCreateSchema 说明）
          const sql = stripCreateSchema(rewriteSchemaNames(sqlSource, schema, stagingSchema), stagingSchema)
          if (new RegExp(`CREATE\\s+SCHEMA\\s+"?${stagingSchema}"?\\s*;`, 'i').test(sql)) {
            throw new Error(`暂存 SQL 仍含 CREATE SCHEMA "${stagingSchema}"（拒绝执行，防撞名中断）`)
          }
          if (typeof __hooks.afterStaging === 'function') {
            await __hooks.afterStaging({ jobId, stagingSchema, stagingOid, targetSchema: schema })
          }
          // NF-B-02：明文 SQL 不落盘（原实现写 /tmp/restore_*.sql），直接流式经 psql stdin 执行
          await runPsql({ stdinText: sql })
          const restoredCount = expectedTables ? expectedTables.length : Object.keys(meta.tableCounts || {}).length
          step('STAGING', `已恢复 ${restoredCount} 张表到暂存 schema ${stagingSchema}（流式执行，无明文临时文件）`)

          // ── 3.5 SCHEMA_ALIGN：把暂存 schema 对齐到当前 schema.prisma（防 P2022 漂移，关键）──
          // 背景：备份可能由旧版本生成（缺新列/新表）。若直接切换，当前 Prisma 客户端
          // （已按最新 schema.prisma 重新 generate）查询时会抛 column/table does not exist，
          // 导致恢复后登录/业务接口全面失败（2026-08-20 can_view_pathogen 事故的根因）。
          // 因此在【切换之前】先对暂存 schema 执行幂等 db push 补齐结构：
          //   - 对齐失败 → 抛错进入 FAILED 清理，原 schema 零影响（影子恢复核心理念）；
          //   - 对齐成功 → 继续行数校验，校验对象是"已补齐结构"的暂存 schema，
          //     切换后即与当前代码完全一致，杜绝恢复后 schema 漂移。
          try {
            await alignTenantSchema({ schema: stagingSchema, log: (m) => log(`${TAG} [align] ${m}`) })
            step('SCHEMA_ALIGN', '暂存 schema 已对齐 schema.prisma（新增列/索引已补齐）')
          } catch (alignErr) {
            log(`${TAG} ❌ 暂存 schema 对齐失败（不切换，原数据零影响）: ${alignErr.message}`)
            throw new Error(`暂存 schema 对齐失败: ${alignErr.message}`)
          }

          // ── 3.6 SCHEMA_COMPAT：生成「备份结构 vs 当前代码结构」兼容性报告 ──
          const backupSchemaSnapshot = (meta.schemaSnapshot && meta.schemaSnapshot[schema]) || null
          const currentTables = await readCurrentSchemaColumns(prisma, stagingSchema)
          const compat = compareSchemaSnapshot(backupSchemaSnapshot, currentTables)
          checks.push(['SCHEMA_COMPAT', compat.summary])
          if (!compat.compatible) {
            step('SCHEMA_COMPAT', `结构差异已自动补齐（${compat.details.length} 项）`)
            for (const d of compat.details.slice(0, 20)) {
              log(`${TAG} [compat] ${d}`)
              checks.push(['SCHEMA_COMPAT_DETAIL', d])
            }
            if (compat.details.length > 20) {
              log(`${TAG} [compat] ... 还有 ${compat.details.length - 20} 项差异未列出`)
              checks.push(['SCHEMA_COMPAT_DETAIL', `... 还有 ${compat.details.length - 20} 项差异`])
            }
          } else {
            step('SCHEMA_COMPAT', '备份结构与当前 schema.prisma 一致')
          }

          // ── 4. VALIDATING：行数对比（meta.tableCounts 基线 vs 暂存 schema 实际行数）──
          const mismatches = []
          const countEntries = expectedTables || Object.entries(meta.tableCounts || {})
          if (countEntries.length) {
            for (const [k, expected] of countEntries) {
              const table = k.split('.').pop() // 取表名（跳过源 schema 前缀）
              try {
                const [{ count }] = await prisma.$queryRawUnsafe(
                  `SELECT count(*) AS count FROM "${stagingSchema}"."${table}"`
                )
                if (Number(count) !== Number(expected)) mismatches.push(`${table}: 备份=${expected} 恢复=${count}`)
              } catch (e) {
                mismatches.push(`${table}: 校验失败 ${e.message}`)
              }
            }
            if (mismatches.length) {
              throw new Error(`行数校验不一致（${mismatches.length} 处，如 ${mismatches.slice(0, 3).join('; ')}）`)
            }
          }
          step('VALIDATING', `行数校验通过（${countEntries.length} 张表全一致）`)

          // ── 5. 切换前归属复核（AUD-004）：暂存 + 目标都必须是本任务登记的对象 ──
          await assertSchemaOwnership(tx, { jobId, schema: stagingSchema, expectedOid: stagingOid, stage: 'pre-switch-staging' })
          await assertSchemaOwnership(tx, { jobId, schema, expectedOid: targetOidAtStart, stage: 'pre-switch-target' })

          // ── 5.5 ACL_BASELINE（P3-W3-R1）：切换前以管理身份快照目标 schema 的逐项授权 ──
          // 只读；登记摘要（含 digest）进台账，供切换后重放与事后核验（DEFECT-1 根修）。
          aclBaseline = await readSchemaAclSnapshot(tx, schema)
          const aclSummary = aclSnapshotSummary(aclBaseline)
          await updateJobRecord(jobId, {
            aclBaseline: aclSummary,
            stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'ACL_BASELINE', at: new Date().toISOString(), ...aclSummary }],
          })
          step('ACL_BASELINE', `切换前授权基线已快照：schema 级 ${aclBaseline.schemaPrivileges.length} 项 / 对象级 ${aclBaseline.objectPrivileges.length} 项（覆盖 ${aclSummary.objectCount} 个对象）`)

          // ── 6. SWITCHING：单事务原子双 rename（零窗口）；旧名先登记再执行 ──
          // 命名沿用既有约定 `_old_<epoch ms>`（保持 scripts/005_cleanup-old-schemas.mjs 的
          // `^school_[a-z0-9_]+_old_[0-9]+$` 匹配与按时间戳保留策略不失效）；
          // 归属安全由「台账登记 + OID 复核」保证，同名冲突时 rename 直接失败（fail-closed，事务回滚）。
          oldSchema = `${schema}_old_${Date.now()}`
          assertSafeSchemaName(oldSchema)
          await updateJobRecord(jobId, {
            state: 'SWITCHING',
            oldSchema,
            stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'SWITCHING', at: new Date().toISOString(), oldSchema }],
          })
          const switchSql =
            `BEGIN;` +
            `ALTER SCHEMA "${schema}" RENAME TO "${oldSchema}";` +
            `ALTER SCHEMA "${stagingSchema}" RENAME TO "${schema}";` +
            `COMMIT;`
          await runPsql({ command: switchSql })
          step('SWITCHING', `已原子切换：${schema} ← ${stagingSchema}（旧数据保留于 ${oldSchema}）`)

          // ── 6.5 ACL_REPLAY（P3-W3-R1，DEFECT-1 根修）：切换后按基线幂等重放授权 ──
          // 位置约束：必须在 drop-old **之前** —— 重放失败即 fail-closed（任务 FAILED），
          // 旧 schema 仍在，可人工回滚；成功后新 schema 的访问授权与恢复前完全一致。
          aclReplay = await replaySchemaAcl({ queryable: tx, schema, baseline: aclBaseline, log })
          await updateJobRecord(jobId, {
            aclReplay,
            stages: [...(readJobRecord(jobId)?.stages || []), {
              stage: 'ACL_REPLAY',
              at: new Date().toISOString(),
              applied: aclReplay.applied.length,
              skipped: aclReplay.skipped.length,
              verifiedBaselineSatisfied: aclReplay.verifiedBaselineSatisfied,
              verifiedIdentical: aclReplay.verifiedIdentical,
            }],
          })
          // P3-W3-R2：字段口径说准 —— 基线下界（含可转授）与"双向完全相同"分开陈述，不虚称一致
          checks.push(['ACL_REPLAY', `按基线重放授权 ${aclReplay.applied.length} 项（跳过 ${aclReplay.skipped.length} 项；基线外授权未扩散 ${aclReplay.extraNotExpanded.length} 项；现状多出可转授仅登记未撤销 ${aclReplay.grantOptionUpgrades.length} 项；基线下界=${aclReplay.verifiedBaselineSatisfied}；双向相同=${aclReplay.verifiedIdentical}）`])
          step('ACL_REPLAY', `切换后授权已按基线重放：applied=${aclReplay.applied.length}，基线下界=${aclReplay.verifiedBaselineSatisfied}，双向相同=${aclReplay.verifiedIdentical}（只命中 ${schema}）`)

          // ── 7. COMPLETE：清理旧 schema ──
          // FIX-06：原实现无论 RESTORE_DROP_OLD 为何值都【只打印日志、从不真正 DROP】，导致旧 schema
          //   （school_<code>_old_<ts>）无限残留。现按环境变量语义真正执行清理：
          //   - RESTORE_DROP_OLD=drop  → 切换成功（事务已提交、新数据已生效）后立即 DROP 旧 schema，避免残留；
          //   - 其它/未设置（默认安全）→ 保留旧 schema，仅日志提示运维确认后手动清理（支持回滚）。
          const dropOld = process.env.RESTORE_DROP_OLD === 'drop'
          if (dropOld) {
            // 旧 schema 的归属证据 = 任务开始时记录的目标 OID（rename 不改 OID）
            await assertSchemaOwnership(tx, { jobId, schema: oldSchema, expectedOid: targetOidAtStart, stage: 'drop-old' })
            await runPsql({ command: `DROP SCHEMA "${oldSchema}" CASCADE` })
            step('COMPLETE', `恢复完成，目标 schema=${schema}（旧 schema ${oldSchema} 已清理）`)
          } else {
            log(`${TAG} 旧 schema 保留: ${oldSchema}（确认无误后手动 DROP SCHEMA "${oldSchema}" CASCADE 清理）`)
            step('COMPLETE', `恢复完成，目标 schema=${schema}，旧 schema=${oldSchema}（待人工清理）`)
          }

          await updateJobRecord(jobId, {
            state: 'COMPLETE',
            completedAt: new Date().toISOString(),
            postSwitch: { targetSchema: schema, targetOid: stagingOid, oldSchema: dropOld ? null : oldSchema, oldSchemaOid: targetOidAtStart },
            stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'COMPLETE', at: new Date().toISOString() }],
          })

          // 审计（平台级操作）：写入 schema 兼容性摘要，便于控制台展示与问题排查
          try {
            await writeAdminOpsLog(prisma, {
              action: 'backup_restore',
              actor,
              targetId: backup.id,
              targetSchoolCode,
              details: {
                jobId,
                schema,
                stagingSchema,
                oldSchema,
                files: path.basename(aesPath),
                checkedTables: countEntries.length,
                schemaCompatible: compat.compatible,
                schemaCompatSummary: compat.summary,
                schemaCompatDetails: compat.details.slice(0, 10),
              },
              level: compat.compatible ? 'warn' : 'error',
            })
          } catch (e) { log(`${TAG} ⚠️ 审计写入失败: ${e.message}`) }

          return {
            ok: true,
            schema,
            jobId,
            stagingSchema,
            oldSchema,
            checks,
            schemaCompatibility: compat,
            aclReplay,
          }
        } catch (e) {
          // 失败清理（仍在持锁状态）：只 DROP 本任务登记 + OID 复核通过的暂存 schema
          const cleanup = await cleanupOwnStaging({
            queryable: tx,
            jobId,
            targetSchema: schema,
            stagingSchema,
            stagingOid,
            log,
          }).catch((ce) => ({ dropped: false, reason: 'cleanup-threw', error: ce.message }))
          step('FAILED', e.message)
          try {
            await writeAdminOpsLog(prisma, {
              action: 'backup_restore_failed',
              actor,
              targetId: backup.id,
              targetSchoolCode,
              details: { jobId, schema, stagingSchema, error: e.message, code: e.code || null, cleanup },
              level: 'error',
            })
          } catch { /* 忽略审计失败 */ }
          try {
            await updateJobRecord(jobId, {
              state: 'FAILED',
              error: String(e.message || e).slice(0, 800),
              errorCode: e.code || null,
              cleanup,
              stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'FAILED', at: new Date().toISOString() }],
            })
          } catch { /* 台账写失败不掩盖原错误 */ }
          return { ok: false, schema, jobId, stagingSchema, oldSchema, checks, error: e.message, code: e.code || null, cleanup, aclReplay }
        }
      },
    })
    return result
  } catch (e) {
    // 互斥拒绝：明确向上抛（路由映射 409），不伪装为普通失败
    if (e instanceof MaintenanceLockBusyError) {
      try {
        await updateJobRecord(jobId, {
          state: 'FAILED',
          error: String(e.message).slice(0, 800),
          errorCode: e.code,
          stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'REJECTED_LOCK_BUSY', at: new Date().toISOString() }],
        })
      } catch { /* 台账写失败不掩盖原错误 */ }
      throw e
    }
    // 事务层异常（超时/连接中断等）：锁已释放，尝试对已登记暂存做可核验清理（OID 复核后 DROP）
    const cleanup = await cleanupOwnStaging({
      queryable: prisma,
      jobId,
      targetSchema: schema,
      stagingSchema,
      stagingOid,
      log,
    }).catch((ce) => ({ dropped: false, reason: 'cleanup-threw', error: ce.message }))
    step('FAILED', e.message)
    try {
      await updateJobRecord(jobId, {
        state: 'FAILED',
        error: String(e.message || e).slice(0, 800),
        errorCode: e.code || null,
        cleanup,
        stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'FAILED', at: new Date().toISOString() }],
      })
    } catch { /* 台账写失败不掩盖原错误 */ }
    return { ok: false, schema, jobId, stagingSchema, oldSchema, checks, error: e.message, code: e.code || null, cleanup, aclReplay }
  } finally {
    // 屏障拆除：先解除全局开关，再解除 per-school（顺序无关，但都只在安装者 token 匹配时生效）
    if (maintToken) {
      const r = exitGlobalMaintenance(maintToken)
      log(`${TAG} 全局维护开关已释放（restored=${r.restored ?? 'n/a'}）`)
    }
    if (barrierJob) {
      const r = endWriteBarrier({ schoolCode: targetSchoolCode, jobId })
      log(`${TAG} 写屏障已拆除（released=${r.released}）`)
    }
  }
}
