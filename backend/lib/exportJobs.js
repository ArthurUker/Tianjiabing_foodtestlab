// exportJobs.js —— 权威导出作业（P3-W5-RECORD-T01 / AUD-020 / RC-07 定稿方案）
//
// RC-07 要求的落地方式：**dedicated export endpoint + server-side snapshot read + streaming artifact generation**
//   ① 提交带筛选/权限上下文的导出 job；
//   ② 服务端在**固定数据快照**内按**稳定顺序分批读取**（同一 REPEATABLE READ 事务内 keyset 批读），
//      并**流式**写入**私有产物**（0600，仓库外运行时目录）；
//   ③ 完成后校验 expectedCount/exportedCount、ID 无重无漏、筛选范围与判定版本，再**原子发布**（tmp → rename）；
//   ④ 下载只服务**已完成**产物；创建/查询状态/下载均在路由层**重新校验当前主体权限与归属**；
//   ⑤ 失败/超限/取消 → 明确失败，**绝不**把残缺文件当"完整报告"发布，也不退回固定 limit。
//
// 为什么是文件系统台账（不是数据库表）：
//   本包约束「不得改 schema/migration」（job 落新表依赖 RC-04）。既有设施经核查不满足：
//   `GuestExportRequest` 是"访客导出申请审批"实体（无执行/产物语义，且全仓无创建点）；`BackupRun` 是平台备份台账。
//   故本实现用**文件系统持久台账**（manifest.json 原子写 + 产物原子 rename），并显式声明单实例边界（见 MULTI_INSTANCE_NOTE）。
//   多实例部署需要共享存储（NF-A-02）——届时只替换本模块的 store 实现，路由契约不变。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildRecordPayload } from './recordNormalize.js'

/** 默认作业根：以 cwd 推断仓库布局（兼容从仓库根或 backend/ 运行；测试可用 EXPORT_JOB_DIR 覆盖）。 */
function resolveDefaultJobRoot() {
  const cwd = process.cwd()
  const fromRoot = path.join(cwd, 'backend', '.export-jobs')
  const fromBackend = path.join(cwd, '.export-jobs')
  if (fs.existsSync(path.join(cwd, 'backend', 'prisma'))) return fromRoot
  if (fs.existsSync(path.join(cwd, 'prisma'))) return fromBackend
  return fromRoot
}

export const EXPORT_JOB_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
})

// P3-W5-RECORD-T01-R1：限额改为**调用时读取 env**（getter）。
// 原实现是模块加载时快照 —— 测试/运维无法在同一进程内切换阈值（上一包的「≤2000 全量校验」用例
// 因此只能在超限时提前 return，未覆盖真实成功分支）。破坏性/语义不变：超限仍**明确失败**。
export const EXPORT_LIMITS = Object.freeze({
  get MAX_EXPORT_ROWS() { return Number(process.env.EXPORT_MAX_ROWS || 200000) }, // 超限 → 明确失败（不发布）
  get BATCH_SIZE() { return Number(process.env.EXPORT_BATCH_SIZE || 500) },
  get TX_TIMEOUT_MS() { return Number(process.env.EXPORT_TX_TIMEOUT_MS || 10 * 60 * 1000) },
  get TX_MAX_WAIT_MS() { return Number(process.env.EXPORT_TX_MAX_WAIT_MS || 15 * 1000) },
  get JOB_TTL_MS() { return Number(process.env.EXPORT_JOB_TTL_MS || 7 * 24 * 60 * 60 * 1000) },
  // 重启恢复：owner 进程已消失，或作业超过该时长没有更新（跨主机/pid 复用兜底）→ 判为中断
  get JOB_STALE_MS() { return Number(process.env.EXPORT_JOB_STALE_MS || Math.max(Number(process.env.EXPORT_TX_TIMEOUT_MS || 0), 15 * 60 * 1000)) },
})

export const MULTI_INSTANCE_NOTE =
  'export job store is local-disk (single-instance deployment). Multi-instance requires shared store (NF-A-02); contract unchanged.'

const SCHEMA_VERSION = 'export.v1'
const VERDICT_VERSION = 'conclusionVerdict.v1'
const READ_CONTRACT_VERSION = 'readContract.v1'

/** 作业根目录：优先 EXPORT_JOB_DIR（部署可指向数据盘），默认 backend/.export-jobs（gitignore 之外亦不落仓库提交）。 */
export function jobRoot() {
  return process.env.EXPORT_JOB_DIR || resolveDefaultJobRoot()
}
function jobDir(jobId) {
  return path.join(jobRoot(), 'jobs', jobId)
}
export function manifestPathOf(jobId) {
  return path.join(jobDir(jobId), 'manifest.json')
}
export function exportJobArtifactPath(jobId) {
  return path.join(jobDir(jobId), 'artifact.ndjson')
}

function atomicWriteJsonSync(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function readManifest(jobId) {
  try {
    return JSON.parse(fs.readFileSync(manifestPathOf(jobId), 'utf8'))
  } catch {
    return null
  }
}

function updateManifest(jobId, patch) {
  const cur = readManifest(jobId) || {}
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }
  atomicWriteJsonSync(manifestPathOf(jobId), next)
  return next
}

/** 取消标记（与 runner 协作：runner 只在批间检查，绝不半发布）。 */
const cancelFlags = new Set()
export function requestCancel(jobId) {
  cancelFlags.add(jobId)
}

/**
 * 创建作业并同步返回 manifest（queued）。
 * @param {{prisma:any, tenantScope:string, subject:string, role:string, filters:object, testTypes:string[]}} args
 */
export function createExportJob({ tenantScope, subject, role, filters }) {
  const jobId = `exp-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`
  fs.mkdirSync(jobDir(jobId), { recursive: true, mode: 0o700 })
  const manifest = {
    jobId,
    schemaVersion: SCHEMA_VERSION,
    readContractVersion: READ_CONTRACT_VERSION,
    verdictVersion: VERDICT_VERSION,
    tenantScope,
    subject,
    permissionSnapshot: { role, at: new Date().toISOString() },
    filters: filters || {},
    state: EXPORT_JOB_STATES.QUEUED,
    expectedCount: null,
    exportedCount: 0,
    idMissCount: null,
    idDupCount: 0,
    checksum: null,
    bytes: null,
    artifact: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    updatedAt: new Date().toISOString(),
    multiInstanceNote: MULTI_INSTANCE_NOTE,
    // R1（重启恢复/部署边界）：记录 owner 进程与台账根 —— 用于「进程崩溃后把 running 作业判为中断」
    // 以及审计"该作业由哪个实例创建"。跨主机时 pid 探活不适用，只按 JOB_STALE_MS 兜底。
    owner: { pid: process.pid, hostname: os.hostname(), storeRoot: jobRoot(), since: new Date().toISOString() },
  }
  atomicWriteJsonSync(manifestPathOf(jobId), manifest)
  return manifest
}

/** pid 是否存活（同主机语义；EPERM 视为存活——进程存在但无权限发信号）。 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code === 'EPERM'
  }
}

/**
 * 判定并（必要时）回收**中断残留**作业（P3-W5-RECORD-T01-R1）。
 * 中断 = 作业处于 queued/running，且满足任一：
 *   ① owner 与当前进程同主机且 owner.pid 已不存在（进程崩溃/被杀）；
 *   ② 作业超过 `EXPORT_JOB_STALE_MS` 未更新（跨主机 / pid 复用 / owner 缺失的兜底）。
 * 回收动作：清理该作业目录内的 `.tmp-` 半成品 + 置 failed（`EXPORT_INTERRUPTED`）。
 * **绝不发布产物**（artifact 不置位 ⇒ 下载仍 409），也绝不回收已完成/已失败/已取消作业。
 */
function recoverIfInterrupted(manifest, { now = Date.now(), staleMs = EXPORT_LIMITS.JOB_STALE_MS, pidAlive = isPidAlive } = {}) {
  if (!manifest || ![EXPORT_JOB_STATES.QUEUED, EXPORT_JOB_STATES.RUNNING].includes(manifest.state)) return manifest
  const ts = Date.parse(manifest.updatedAt || manifest.startedAt || manifest.createdAt || '')
  const stale = !Number.isFinite(ts) || (now - ts > staleMs)
  const owner = manifest.owner || {}
  const sameHost = !!owner.hostname && owner.hostname === os.hostname()
  const ownerPid = Number(owner.pid)
  const ownerAlive = sameHost && Number.isFinite(ownerPid) ? !!pidAlive(ownerPid) : null
  // 同主机且 owner 已死 ⇒ 立刻判定中断；否则只有在超时未更新时才判定（避免误杀在同主机其他进程里正常运行的作业）
  if (!(ownerAlive === false || stale)) return manifest
  try {
    const dir = jobDir(manifest.jobId)
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.includes('.tmp-')) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* ignore */ } }
      }
    }
  } catch { /* 清理失败不掩盖状态判定 */ }
  return updateManifest(manifest.jobId, {
    state: EXPORT_JOB_STATES.FAILED,
    error: {
      code: 'EXPORT_INTERRUPTED',
      message: '导出进程在中途退出（重启恢复）：作业标记为失败且未发布产物，请重新发起导出',
    },
    interruptedRecoveredAt: new Date().toISOString(),
    interruptedReason: ownerAlive === false ? 'owner-process-gone' : 'stale-no-update',
    finishedAt: new Date().toISOString(),
  })
}

/** 状态读取（含懒回收到期中断作业：重启后 GET 状态不得永久停留在 running）。 */
export function getExportJob(jobId) {
  return recoverIfInterrupted(readManifest(jobId))
}

/**
 * 全量回收中断作业（部署/运维钩子；也可由测试直接调用）。
 * @returns {{scanned:number, recovered:string[], live:string[]}}
 */
export function recoverInterruptedJobs(opts = {}) {
  const jobsRoot = path.join(jobRoot(), 'jobs')
  if (!fs.existsSync(jobsRoot)) return { scanned: 0, recovered: [], live: [] }
  const recovered = []
  const live = []
  let scanned = 0
  for (const jobId of fs.readdirSync(jobsRoot)) {
    const m = readManifest(jobId)
    if (!m) continue
    scanned += 1
    if (![EXPORT_JOB_STATES.QUEUED, EXPORT_JOB_STATES.RUNNING].includes(m.state)) continue
    const after = recoverIfInterrupted(m, opts)
    if (after && after.state === EXPORT_JOB_STATES.FAILED && after.error && after.error.code === 'EXPORT_INTERRUPTED') recovered.push(jobId)
    else live.push(jobId)
  }
  return { scanned, recovered, live }
}

/**
 * 执行作业：**同一 REPEATABLE READ 事务**内 count + keyset 批读 + 流式写私有产物；
 * 完成后做 ID 无重无漏 + 计数一致性校验，通过才原子发布。
 */
export async function runExportJob({ db, jobId, testTypes, where, mapRow = null }) {
  const manifest = readManifest(jobId)
  if (!manifest) throw Object.assign(new Error('export job not found'), { code: 'EXPORT_JOB_NOT_FOUND' })

  updateManifest(jobId, { state: EXPORT_JOB_STATES.RUNNING, startedAt: new Date().toISOString() })
  const artifact = exportJobArtifactPath(jobId)
  const tmp = `${artifact}.tmp-${process.pid}`

  const seen = new Set()
  let exported = 0
  let dup = 0
  let checksum = crypto.createHash('sha256')
  let bytes = 0
  let stream = null

  try {
    await db.$transaction(async (tx) => {
      const expected = await tx.testRecord.count({ where })
      updateManifest(jobId, { expectedCount: expected })
      if (expected > EXPORT_LIMITS.MAX_EXPORT_ROWS) {
        throw Object.assign(new Error(`导出超限：expected=${expected} > MAX_EXPORT_ROWS=${EXPORT_LIMITS.MAX_EXPORT_ROWS}`), { code: 'EXPORT_OVER_LIMIT' })
      }

      stream = fs.createWriteStream(tmp, { mode: 0o600 })
      let cursor = null
      for (;;) {
        if (cancelFlags.has(jobId)) {
          throw Object.assign(new Error('导出已取消'), { code: 'EXPORT_CANCELLED' })
        }
        const batchWhere = cursor
          ? { AND: [where, { OR: [{ created_at: { gt: cursor.createdAt } }, { created_at: cursor.createdAt, id: { gt: cursor.id } }] }] }
          : where
        const rows = await tx.testRecord.findMany({
          where: batchWhere,
          take: EXPORT_LIMITS.BATCH_SIZE,
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        })
        if (rows.length === 0) break
        for (const row of rows) {
          if (seen.has(row.id)) { dup += 1; continue }
          seen.add(row.id)
          const payload = mapRow ? mapRow(row) : buildRecordPayload(row)
          const line = JSON.stringify({ id: row.id, test_type: row.test_type, ...payload }) + '\n'
          bytes += Buffer.byteLength(line)
          checksum.update(line)
          exported += 1
          if (!stream.write(line)) {
            await new Promise((resolve, reject) => { stream.once('drain', resolve); stream.once('error', reject) })
          }
        }
        const last = rows[rows.length - 1]
        cursor = { createdAt: last.created_at, id: last.id }
        if (rows.length < EXPORT_LIMITS.BATCH_SIZE) break
      }
      stream.end()
      await new Promise((resolve, reject) => { stream.once('finish', resolve); stream.once('error', reject) })
      stream = null

      const miss = expected - exported
      if (dup !== 0 || miss !== 0) {
        throw Object.assign(new Error(`导出一致性校验失败：expected=${expected} exported=${exported} miss=${miss} dup=${dup}`), { code: 'EXPORT_INCONSISTENT' })
      }
      updateManifest(jobId, {
        exportedCount: exported,
        idMissCount: 0,
        idDupCount: 0,
        checksum: checksum.digest('hex'),
        bytes,
      })
    }, { isolationLevel: 'RepeatableRead', timeout: EXPORT_LIMITS.TX_TIMEOUT_MS, maxWait: EXPORT_LIMITS.TX_MAX_WAIT_MS })

    // ── 原子发布（tmp → artifact）：只有全部校验通过才可见 ──
    await fsp.rename(tmp, artifact)
    cancelFlags.delete(jobId)
    return updateManifest(jobId, {
      state: EXPORT_JOB_STATES.COMPLETED,
      artifact: path.basename(artifact),
      finishedAt: new Date().toISOString(),
    })
  } catch (e) {
    if (stream) { try { stream.destroy() } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch { /* ignore */ }
    // Prisma 会包装事务内抛出的错误（code 可能丢失），故以取消标记为准判定取消
    const cancelled = e.code === 'EXPORT_CANCELLED' || cancelFlags.has(jobId)
    cancelFlags.delete(jobId)
    updateManifest(jobId, {
      state: cancelled ? EXPORT_JOB_STATES.CANCELLED : EXPORT_JOB_STATES.FAILED,
      error: { code: e.code || 'EXPORT_FAILED', message: String(e.message || e) },
      finishedAt: new Date().toISOString(),
    })
    return readManifest(jobId)
  }
}

/** 允许下载的判定（路由层使用）：状态完成 + 产物存在 + 归属/权限由调用方先行校验。 */
export function isDownloadable(manifest) {
  return !!manifest
    && manifest.state === EXPORT_JOB_STATES.COMPLETED
    && typeof manifest.artifact === 'string'
    && fs.existsSync(exportJobArtifactPath(manifest.jobId))
}

/** 对外视图：剥离服务端路径等内部字段（下载/状态响应只用此形状）。 */
export function publicExportJobView(manifest) {
  if (!manifest) return null
  return {
    jobId: manifest.jobId,
    state: manifest.state,
    schemaVersion: manifest.schemaVersion,
    readContractVersion: manifest.readContractVersion,
    verdictVersion: manifest.verdictVersion,
    filters: manifest.filters,
    expectedCount: manifest.expectedCount,
    exportedCount: manifest.exportedCount,
    idMissCount: manifest.idMissCount,
    idDupCount: manifest.idDupCount,
    checksum: manifest.checksum,
    bytes: manifest.bytes,
    // 是否已原子发布产物（对外只暴露布尔，不暴露服务端路径）
    artifactPublished: !!manifest.artifact,
    complete: manifest.state === EXPORT_JOB_STATES.COMPLETED && manifest.expectedCount === manifest.exportedCount,
    error: manifest.error,
    createdAt: manifest.createdAt,
    startedAt: manifest.startedAt,
    finishedAt: manifest.finishedAt,
    updatedAt: manifest.updatedAt,
    multiInstanceNote: manifest.multiInstanceNote,
  }
}

/** 过期清理（含中断残留 tmp）：返回删除数量，便于可观测。 */
export async function cleanupExpiredJobs({ now = Date.now(), ttlMs = EXPORT_LIMITS.JOB_TTL_MS } = {}) {
  const jobsRoot = path.join(jobRoot(), 'jobs')
  if (!fs.existsSync(jobsRoot)) return { removed: 0, scanned: 0 }
  let removed = 0, scanned = 0
  for (const jobId of await fsp.readdir(jobsRoot)) {
    const dir = path.join(jobsRoot, jobId)
    scanned += 1
    const manifest = readManifest(jobId)
    const ts = manifest ? Date.parse(manifest.createdAt || manifest.updatedAt || '') : NaN
    if (!Number.isFinite(ts) || now - ts > ttlMs) {
      await fsp.rm(dir, { recursive: true, force: true })
      removed += 1
    }
  }
  return { removed, scanned }
}
