// backupJobs.js — 备份/恢复任务身份、私有工作区、文件台账与 PG 互斥锁（P3-W3-T01 / RC-03）
//
// 为什么需要本模块（AUD-004/005/006/007 的共同底座）：
//   · 备份与恢复此前以「非独占、非原子、无归属登记」的方式操作共享命名空间
//     （schema 名、文件名、共享数据）——本模块提供任务可标识 + 命名空间独占 +
//     失败只清理自己对象的**机械保证**；
//   · 恢复的暂存 schema 名必须含随机熵且**登记归属**（ownership），任何 DROP/RENAME
//     前都要用 PG 的 schema OID 复核「目标对象仍是本任务创建的那一个」；
//   · 同 scope 备份/恢复用 PG advisory lock 互斥（跨进程/跨实例有效），
//     并发请求只有一个获得执行权，其余明确 409 拒绝（不复用进程内 mutex）。
//
// 存储口径（任务包第 5 条：当前环境不允许新 migration）：
//   · 任务台账 = **文件系统**（`<BACKUP_DIR>/.jobs/<jobId>.json`，0600，原子写）；
//     不使用 public 系统表，避免依赖未就绪的 migration 纪律（W2）。
//   · 多实例限制（显式声明）：文件台账只对同机同盘进程可见；锁是 PG 级（跨实例有效），
//     但台账读取（如崩溃残留清理）在多实例部署下需改为库内表——见 RESULT.md 未决项。
//
// 命名与路径口径：
//   · jobId = `<kind>-<utcTimestamp>-<16 hex 随机>`，高熵且单调可读；
//   · 备份产物 = 发布目录 `<BACKUP_DIR>/<date>/<baseName>.<jobId>/`（目录 rename 原子发布）；
//   · 恢复暂存 = `school_<code>_stg_<8 hex>`（≤63 字符，永不使用固定名 `school_<code>_restore`）。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { MaintenanceLockBusyError, WorkspaceViolationError, OwnershipViolationError } from './backupErrors.js'

const TAG = '[backupJobs]'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = path.resolve(__dirname, '..')

/** 台账/工作区根：默认挂在备份根下（同一文件系统 → rename 原子），可显式覆盖。 */
export function jobLedgerRoot() {
  if (process.env.BACKUP_JOB_LEDGER_DIR) return process.env.BACKUP_JOB_LEDGER_DIR
  const backupRoot = process.env.BACKUP_DIR || path.join(BACKEND_DIR, 'backups')
  return path.join(backupRoot, '.jobs')
}

/** 高熵任务 ID：`<kind>-<yyyymmddthhmmssmm>-<16 hex>`（小写、同毫秒也不碰撞）。 */
export function newJobId(kind = 'job') {
  const ts = new Date().toISOString()
    .replace(/[-:]/g, '').replace('.', '').toLowerCase().slice(0, 17) // yyyymmddthhmmssmm
  return `${kind}-${ts}-${crypto.randomBytes(8).toString('hex')}`
}

/** 随机十六进制 token（默认 4 字节 = 8 hex，用于 staging/old schema 名）。 */
export function randomToken(bytes = 4) {
  return crypto.randomBytes(bytes).toString('hex')
}

/** 路径包含校验：`target` 必须落在 `base` 内（含 base 自身）；拒绝 `..` 逃逸。 */
export function assertInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target))
  if (rel === '') return true
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new WorkspaceViolationError(`路径越界：${target} 不在 ${base} 内`, { base, target })
  }
  return true
}

// ─────────────────────────────────────────────────────────────
// 文件台账（原子写）
// ─────────────────────────────────────────────────────────────

function jobRecordPath(jobId) {
  if (!/^[a-z0-9-]{8,120}$/.test(String(jobId))) {
    throw new WorkspaceViolationError(`非法 jobId: ${JSON.stringify(jobId)}`, { jobId })
  }
  return path.join(jobLedgerRoot(), `${jobId}.json`)
}

/** 原子写 JSON：同目录 tmp（0600）→ fsync → rename（替换失败保留旧文件）。 */
export async function writeJsonAtomic(file, value) {
  const dir = path.dirname(file)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${randomToken(3)}`)
  const fh = await fsp.open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(JSON.stringify(value, null, 2) + '\n')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fsp.rename(tmp, file)
  return file
}

/** 新建台账记录（jobId 已存在 → 抛错，不覆盖他人任务）。 */
export async function createJobRecord(record) {
  const { jobId } = record || {}
  const file = jobRecordPath(jobId)
  if (fs.existsSync(file)) {
    throw new WorkspaceViolationError(`台账记录已存在（拒绝覆盖）: ${jobId}`, { jobId })
  }
  const now = new Date().toISOString()
  await writeJsonAtomic(file, { ...record, createdAt: record.createdAt || now, updatedAt: now })
  return file
}

/** 读取单条台账记录（不存在返回 null）。 */
export function readJobRecord(jobId) {
  const file = jobRecordPath(jobId)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new WorkspaceViolationError(`台账记录损坏: ${jobId}（${e.message}）`, { jobId })
  }
}

/** 合并更新台账记录（读-改-写原子替换）。 */
export async function updateJobRecord(jobId, patch) {
  const current = readJobRecord(jobId)
  if (!current) throw new WorkspaceViolationError(`台账记录不存在: ${jobId}`, { jobId })
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
  await writeJsonAtomic(jobRecordPath(jobId), next)
  return next
}

/** 列出全部台账记录（按 jobId 排序；损坏记录以 {jobId, corrupt:true} 呈现，不静默忽略）。 */
export function listJobRecords() {
  const root = jobLedgerRoot()
  let entries
  try { entries = fs.readdirSync(root) } catch { return [] }
  const out = []
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const jobId = name.slice(0, -5)
    try { out.push(readJobRecord(jobId)) } catch (e) { out.push({ jobId, corrupt: true, error: e.message }) }
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// 私有工作区（每 job 独占目录，最小权限）
// ─────────────────────────────────────────────────────────────

export function jobWorkspaceDir(jobId) {
  const dir = path.join(jobLedgerRoot(), 'work', jobId)
  assertInside(path.join(jobLedgerRoot(), 'work'), dir)
  return dir
}

/** 创建本任务私有工作目录（0700）；同名已存在 → 拒绝（防跨任务复用目录）。 */
export async function createJobWorkspace(jobId) {
  const dir = jobWorkspaceDir(jobId)
  if (fs.existsSync(dir)) {
    throw new WorkspaceViolationError(`工作目录已存在（拒绝复用）: ${dir}`, { jobId, dir })
  }
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  await fsp.chmod(dir, 0o700).catch(() => {})
  return dir
}

/**
 * 只清理**本任务台账登记**的工作目录（AUD-007：失败清理只删自己的产物）。
 * 归属证据三件套：① 路径必须等于台账记录的 workspace；② 目录名必须等于 jobId；
 * ③ 仍落在台账根内。任一不满足 → 拒绝删除（fail-closed，保留现场供人工核对）。
 */
export async function removeOwnWorkspace(jobId, reason = 'cleanup') {
  const record = readJobRecord(jobId)
  if (!record) {
    // 无台账记录 = 无归属证据 → fail-closed，绝不按拼接路径删除
    throw new WorkspaceViolationError(`台账记录缺失（拒绝删除工作目录）: ${jobId}`, { jobId })
  }
  const registered = record.workspace || null
  if (!registered) return { removed: false, reason: 'no_workspace_registered', jobId, reasonDetail: reason }
  const dir = jobWorkspaceDir(jobId)
  if (path.resolve(registered) !== path.resolve(dir)) {
    throw new WorkspaceViolationError(`工作目录与台账登记不一致（拒绝删除）: ${dir}`, { jobId, registered, dir })
  }
  if (path.basename(dir) !== jobId) {
    throw new WorkspaceViolationError(`工作目录名与 jobId 不一致（拒绝删除）: ${dir}`, { jobId })
  }
  assertInside(jobLedgerRoot(), dir)
  if (!fs.existsSync(dir)) return { removed: false, reason: 'missing', dir, reasonDetail: reason }
  await fsp.rm(dir, { recursive: true, force: true })
  return { removed: true, dir, reason }
}

/**
 * 原子发布：把工作目录整体 rename 到最终发布目录（单次 rename = 原子切换；
 * 半成品在工作目录里永远不可见）。要求目标目录不存在（不同任务不会互相覆盖）。
 */
export async function publishWorkspaceAtomically(jobId, workDir, publishDir) {
  const record = readJobRecord(jobId)
  if (!record || path.resolve(record.workspace) !== path.resolve(workDir)) {
    throw new WorkspaceViolationError(`发布目录未在台账登记（拒绝发布）: ${workDir}`, { jobId })
  }
  assertInside(path.dirname(publishDir), publishDir)
  if (fs.existsSync(publishDir)) {
    throw new WorkspaceViolationError(`发布目标已存在（拒绝覆盖他人产物）: ${publishDir}`, { jobId, publishDir })
  }
  await fsp.rename(workDir, publishDir)
  return publishDir
}

// ─────────────────────────────────────────────────────────────
// PG advisory lock（跨进程/跨实例互斥）
// ─────────────────────────────────────────────────────────────

/**
 * 稳定锁键：由标签派生 63-bit 正整数（sha256 前 8 字节，最高位清零）。
 * 标签示例：`maint:schema:school_x` / `maint:schema:public`。
 */
export function maintenanceLockKey(label) {
  const h = crypto.createHash('sha256').update(String(label)).digest('hex')
  const v = BigInt('0x' + h.slice(0, 16)) & 0x7fffffffffffffffn
  return v.toString()
}

/**
 * 由 scope 计算需要加锁的对象标签（all-scope 覆盖全部租户 schema + public）。
 * ⚠️ 备份与恢复使用**同一命名空间**（`maint:schema:<schema>`）：同校的备份与恢复、
 * 两次恢复、两次同范围备份都互斥；all-scope 按字典序对全部对象依次取锁（防死锁）。
 */
export function lockLabelsForScope({ scope, schema, schemas }) {
  if (scope === 'all') {
    const list = [...new Set([...(schemas || []), 'public'])].filter(Boolean)
    return list.sort().map((s) => `maint:schema:${s}`)
  }
  if (!schema) throw new Error(`${TAG} 单校任务缺少 schema 标签`)
  return [`maint:schema:${schema}`]
}

/**
 * 在一个 interactive transaction 内按**排序后的稳定顺序**尝试全部锁
 * （pg_try_advisory_xact_lock；任一失败即抛错 → 事务回滚 → 已获锁自动释放，
 *  不会部分持锁制造死锁）。事务持有期间锁有效，跨进程可见。
 * @returns {Promise<{labels:string[], keys:string[], txBackendPid:string|null}>}
 */
export async function acquireLocksInTx(tx, labels, { kind = 'backup' } = {}) {
  const keys = []
  for (const label of [...labels].sort()) {
    const key = maintenanceLockKey(label)
    const rows = await tx.$queryRawUnsafe('SELECT pg_try_advisory_xact_lock($1::bigint) AS ok', key)
    const ok = Array.isArray(rows) && rows.length === 1 && rows[0].ok === true
    if (!ok) {
      throw new MaintenanceLockBusyError(
        `另有任务持有互斥锁（label=${label}）：同 scope 的备份/恢复必须串行，已拒绝本次执行`,
        { kind, label, codes: keys.length }
      )
    }
    keys.push(key)
  }
  let txBackendPid = null
  try {
    const pidRows = await tx.$queryRawUnsafe('SELECT pg_backend_pid()::text AS pid')
    txBackendPid = pidRows?.[0]?.pid ?? null
  } catch { /* best-effort：仅用于 drain 排除自身 */ }
  return { labels: [...labels].sort(), keys, txBackendPid }
}

/**
 * 在 advisory lock 保护下执行任务（整个 body 期间持锁；异常/进程崩溃自动释放）。
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} opts.prisma
 * @param {string[]} opts.labels
 * @param {'backup'|'restore'} [opts.kind]
 * @param {(ctx:{tx:any, labels:string[], keys:string[], txBackendPid:string|null}) => Promise<any>} opts.fn
 * @param {number} [opts.maxWaitMs] 等锁事务启动上限
 * @param {number} [opts.timeoutMs] 事务总时长上限（须覆盖整个备份/恢复）
 */
export async function withMaintenanceLock({
  prisma, labels, kind = 'backup', fn,
  maxWaitMs = 10000, timeoutMs = 30 * 60 * 1000,
  // 备份需要 REPEATABLE READ（导出快照 / 计数 / 结构共享同一快照，AUD-006）；
  // 恢复用默认 ReadCommitted（长事务无需可重复读快照）。
  isolationLevel = kind === 'backup' ? 'RepeatableRead' : 'ReadCommitted',
}) {
  return prisma.$transaction(
    async (tx) => {
      const lock = await acquireLocksInTx(tx, labels, { kind })
      return fn({ tx, ...lock })
    },
    { maxWait: maxWaitMs, timeout: timeoutMs, isolationLevel }
  )
}

/** 读取 schema 的 OID（归属证据；不存在返回 null）。 */
export async function schemaOid(queryable, schemaName) {
  const rows = await queryable.$queryRawUnsafe(
    'SELECT oid::text AS oid FROM pg_namespace WHERE nspname = $1',
    schemaName
  )
  return rows?.[0]?.oid ?? null
}

/**
 * 归属复核：schema 当前 OID 必须与台账登记一致。任一不符 → OwnershipViolationError（不 DROP/RENAME）。
 * @returns {Promise<{oid:string}>}
 */
export async function assertSchemaOwnership(queryable, { jobId, schema, expectedOid, stage }) {
  const actual = await schemaOid(queryable, schema)
  if (actual === null) {
    throw new WorkspaceViolationError(
      `归属复核失败：schema ${schema} 不存在（stage=${stage}）`,
      { jobId, schema, expectedOid, actual, stage }
    )
  }
  if (String(actual) !== String(expectedOid)) {
    throw new OwnershipViolationError(
      `归属复核失败：schema ${schema} 的 OID=${actual} 与台账登记 ${expectedOid} 不符，拒绝 DROP/RENAME`,
      { jobId, schema, expectedOid, actual, stage }
    )
  }
  return { oid: actual }
}
