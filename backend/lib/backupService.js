// backupService.js — 数据备份引擎（P0；P3-W3-T01 加固：任务台账 / 命名空间独占 / 共享快照）
//
// 提供「单校 / 全库」两种逻辑备份（pg_dump -Fp -Z6），流程（RC-03 口径）：
//   ① 任务身份：高熵 jobId 贯穿台账 / 工作目录 / 产物名 / 日志（AUD-007）
//   ② 互斥：同 scope（含全部目标 schema + public）用 PG advisory lock 独占，
//      与同校恢复共用同一把锁；并发只允许一个执行者，其余明确 409（AUD-005 边界）
//   ③ 快照一致（AUD-006）：默认在同一 REPEATABLE READ 事务内 `pg_export_snapshot()`，
//      行数统计、结构快照与 pg_dump（--snapshot）共享同一快照边界；
//      降级模式（live）下从 dump 反推行数并与直读计数交叉核对，不一致**拒绝登记 ok/passed**
//   ④ 独占命名空间：每 job 私有工作目录（0700）→ 完整生成 + 校验 → 目录整体 rename 原子发布
//      （半成品永不可见；同秒同 scope 并发也不会互相覆盖）
//   ⑤ 失败只清理本任务台账登记的工作目录（绝不触碰他人产物）
//   ⑥ 流式 AES-256-GCM 信封加密（密钥源见 backupKms.js，fail-closed）→ .aes
//   ⑦ L1 校验：gzip 完整性 + CREATE TABLE 数量 + 每表 COPY 行数反推
//   ⑧ 写 public."BackupRun" 记录（status=ok / verify_status=passed；不一致时根本不写）
//   ⑨ 按 BACKUP_KEEP_DAYS 清理过期备份（0/负数 = 禁用自动清理，依赖磁盘水位告警）
//
// 被复用：
//   - scripts/003_backup-now.mjs —— CLI（手动/定时触发）
//   - /api/admin/backups（P1，控制台触发）/api/school/backups（学校侧）
//
// ⚠️ 与 tenantClient.js 的约定：schema 名一律经 schemaNameOf()/assertSafeSchemaName()
//    归一与白名单校验，禁止直接用 public.School.code 拼 SQL。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { schemaNameOf, assertSafeSchemaName } from './tenantClient.js'
import { sealDek, kmsMode } from './backupKms.js'
import { writeSystemLog } from './auditLog.js'
import {
  jobLedgerRoot, newJobId, createJobRecord, updateJobRecord, readJobRecord, listJobRecords,
  createJobWorkspace, removeOwnWorkspace, publishWorkspaceAtomically,
  withMaintenanceLock, lockLabelsForScope,
} from './backupJobs.js'
import { analyzeGzDump, diffCounts } from './dumpCounts.js'
import { ArtifactConsistencyError } from './backupErrors.js'

const TAG = '[backupService]'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = path.resolve(__dirname, '..')

// ─────────────────────────────────────────────────────────────
// 环境与路径
// ─────────────────────────────────────────────────────────────
export function backupRootDir() {
  return process.env.BACKUP_DIR || path.join(BACKEND_DIR, 'backups')
}

// 部署时区固定 Asia/Shanghai（deploy.sh 的 systemd 设 TZ=Asia/Shanghai）。
// ⚠️ new Date().toISOString() 恒返回 UTC：上海 00:00~07:59 时 UTC 仍是前一天，
// 若用它做目录/文件名日期，凌晨定时备份（02:00）会落进"前一天"目录——真实时区 bug（P0 审查修复）。
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000
export function localNow() {
  return new Date(Date.now() + TZ_OFFSET_MS)
}
/** 备份日期目录（上海时区 YYYY-MM-DD）。 */
export function backupDateDir() {
  return localNow().toISOString().slice(0, 10)
}

function keepDays() {
  const v = Number(process.env.BACKUP_KEEP_DAYS || 7)
  return Number.isFinite(v) && v >= 1 ? v : 7
}

/** 快照模式：'snapshot'（默认，共享导出快照）| 'live'（降级，dump 反推 + 交叉核对）。 */
function snapshotMode() {
  const v = String(process.env.BACKUP_SNAPSHOT_MODE || 'snapshot').toLowerCase()
  return v === 'live' ? 'live' : 'snapshot'
}
/** 互斥事务上限（覆盖：导出快照 + 计数/结构 + 加密 + 发布；须容纳整个备份）。 */
function maintenanceTxTimeoutMs() {
  const v = Number(process.env.BACKUP_TX_TIMEOUT_MS || 30 * 60 * 1000)
  return Number.isFinite(v) && v > 0 ? v : 30 * 60 * 1000
}

/** 探测 pg_dump 二进制路径：优先 PG_DUMP_BIN，其次 PG 安装目录，最后 PATH。 */
export function detectPgDumpBin() {
  if (process.env.PG_DUMP_BIN) return process.env.PG_DUMP_BIN
  // Ubuntu 常见路径（与服务器 PostgreSQL 14 匹配；多版本时取最高）
  try {
    const dirs = fs.readdirSync('/usr/lib/postgresql').map((v) => Number(v)).filter((v) => v > 0).sort((a, b) => b - a)
    if (dirs.length) return `/usr/lib/postgresql/${dirs[0]}/bin/pg_dump`
  } catch { /* 非 Linux/未安装，回落到 PATH */ }
  return 'pg_dump'
}

/** 解析 DATABASE_URL（去掉 ?schema= 等 query，pg_dump 不支持该参数形式）。 */
function cleanDatabaseUrl() {
  const url = (process.env.DATABASE_URL || '').split('?')[0]
  if (!url) throw new Error(`${TAG} 缺少 DATABASE_URL`)
  return url
}

/** 任务归属信息（台账 owner 字段；用于人工核对崩溃残留）。 */
function ownerInfo() {
  return {
    pid: process.pid,
    hostname: process.env.HOSTNAME || '',
    username: process.env.USER || process.env.LOGNAME || '',
    startedAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────
// 元数据采集（可传 prisma 单例或 interactive tx —— 同一 tx = 同一快照）
// ─────────────────────────────────────────────────────────────

/**
 * 读取 public."School" 学校代码。
 * @param {boolean} [opts.includeDisabled] 全库备份应包含停用学校（数据法定留存：停用≠可丢失，
 *   否则主库故障时停用学校的数据无灾难恢复保障——P0 审查修复）。单校备份按 code 直接备份不受影响。
 */
export async function listSchoolCodes(prisma, { includeDisabled = false } = {}) {
  const rows = await prisma.school.findMany({
    where: includeDisabled ? {} : { status: 'active' },
    select: { code: true }
  })
  return rows.map((r) => r.code).filter(Boolean)
}

/** 列出某 schema 下全部业务表（排除 Prisma 迁移表）。public 为系统 schema 放行。 */
export async function listTablesInSchema(prisma, schema) {
  if (schema !== 'public') assertSafeSchemaName(schema)
  const rows = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE' AND table_name != '_prisma_migrations'
     ORDER BY table_name`,
    schema
  )
  return rows.map((r) => r.table_name)
}

/** 统计一批表的行数，返回 {"schema.table": count}。 */
export async function collectTableCounts(prisma, schemas) {
  const counts = {}
  for (const schema of schemas) {
    if (schema !== 'public') assertSafeSchemaName(schema)
    const tables = await listTablesInSchema(prisma, schema)
    for (const table of tables) {
      // count(*) 返回 bigint（pg 驱动可能给 string/BigInt），Number() 统一转数值
      const [{ count }] = await prisma.$queryRawUnsafe(
        `SELECT count(*) AS count FROM "${schema}"."${table}"`
      )
      counts[`${schema}.${table}`] = Number(count)
    }
  }
  return counts
}

/**
 * 采集一组 schema 的表结构快照（用于恢复时的 schema 兼容性校验）。
 * 返回 {"schema": {"table": [{column_name, data_type}]}}，排除 _prisma_migrations。
 * 设计目的：备份时记录结构版本，恢复前可对比"备份结构"与"当前 schema.prisma 期望的结构"，
 * 若列缺失/类型不一致可提前告警并自动对齐（2026-08-20 can_view_pathogen 事故的延伸修复）。
 */
export async function collectSchemaSnapshot(prisma, schemas) {
  const snapshot = {}
  for (const schema of schemas) {
    if (schema !== 'public') assertSafeSchemaName(schema)
    const rows = await prisma.$queryRawUnsafe(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name != '_prisma_migrations'
       ORDER BY table_name, ordinal_position`,
      schema
    )
    const tables = {}
    for (const r of rows) {
      if (!tables[r.table_name]) tables[r.table_name] = []
      tables[r.table_name].push({ column: r.column_name, type: r.data_type })
    }
    snapshot[schema] = tables
  }
  return snapshot
}

// ─────────────────────────────────────────────────────────────
// pg_dump 执行
// ─────────────────────────────────────────────────────────────

/**
 * 执行 pg_dump 并写出 .sql.gz 临时文件。
 * @param {object} opts
 * @param {string[]} opts.schemas 要 dump 的 schema 列表（显式列表：全库时排除无注册行的孤儿 schema，
 *   保证 dump 内容与 tableCounts 统计集合严格一致，L1 校验不会误判）
 * @param {string} opts.outPath 输出 .sql.gz 路径（位于本任务私有工作目录内）
 * @param {string} [opts.snapshotId] `pg_export_snapshot()` 的导出快照 ID（AUD-006：与统计共享快照）
 * @returns {Promise<{bytes: number}>}
 */
function runPgDump({ schemas, outPath, snapshotId = null }) {
  return new Promise((resolve, reject) => {
    const args = [
      `--dbname=${cleanDatabaseUrl()}`,
      '--format=plain',
      '--compress=6',
      '--no-owner',
      '--no-acl',
      '--lock-wait-timeout=30',
    ]
    if (snapshotId) args.push(`--snapshot=${snapshotId}`)
    for (const s of schemas) args.push(`--schema=${s}`)
    const child = spawn(detectPgDumpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    // 备份文件含全量业务数据，权限收紧 600（P0 审查：防同机其他用户读取）
    const out = fs.createWriteStream(outPath, { mode: 0o600 })
    let stderr = ''
    let failed = false
    child.stdout.pipe(out)
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (e) => { failed = true; reject(e) })
    child.on('close', (code) => {
      if (code !== 0) {
        failed = true
        out.destroy()
        try { fs.unlinkSync(outPath) } catch { /* 已不存在 */ }
        reject(new Error(`pg_dump 失败（exit=${code}, schema=${schemas.join(',')}, snapshot=${snapshotId || 'none'}）: ${stderr.slice(0, 800)}`))
      }
      // code === 0：文件是否真正落盘由 out 'close' 判定（避免竞态读到未写完的文件）
    })
    out.on('error', () => {
      if (!failed) { failed = true; reject(new Error(`写临时文件失败: ${outPath}`)) }
    })
    out.on('close', () => {
      if (!failed) resolve({ bytes: fs.statSync(outPath).size })
    })
  })
}

// ─────────────────────────────────────────────────────────────
// 流式加密
// ─────────────────────────────────────────────────────────────

/**
 * 加密 .sql.gz 压缩流 → .aes（AES-256-GCM，信封外层用主密钥保护 DEK）。
 * 注意：加密对象是【gzip 压缩流】（不预先解压），存储体积小约 9 倍；
 * meta 记录 compression:'gzip'，恢复时先解密再 gunzip。
 * 同时计算 gz 文件的 sha256（元数据校验）。
 */
async function encryptGzStreaming(gzPath, aesPath) {
  const dek = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv)
  const { mode, keyMeta } = await sealDek(dek) // 信封外层：主密钥保护 DEK

  const input = fs.createReadStream(gzPath)
  // .aes 含加密数据，权限 600
  const output = fs.createWriteStream(aesPath, { mode: 0o600 })
  const hash = crypto.createHash('sha256')
  // 链式管道 input →(sha256)→ cipher → output：pipe 自动处理背压与 end 传播，
  // 避免手动 write 不处理背压导致内存随文件大小增长。
  const hashTransform = new Transform({
    transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk) },
  })

  await new Promise((resolve, reject) => {
    let failed = false
    const fail = (e) => { if (!failed) { failed = true; reject(e) } }
    input.on('error', fail)
    cipher.on('error', fail)
    output.on('error', fail)
    // output 'close' 触发 = 文件已关闭且落盘完成，才允许 resolve（避免读未写完的 .aes）
    output.on('close', () => { if (!failed) resolve() })
    input.pipe(hashTransform).pipe(cipher).pipe(output)
  })

  const meta = {
    version: 1,
    algorithm: 'aes-256-gcm',
    mode,
    keyMeta,
    compression: 'gzip',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    sha256: hash.digest('hex'),
    createdAt: new Date().toISOString(),
  }
  return { meta }
}

// ─────────────────────────────────────────────────────────────
// 任务台账辅助
// ─────────────────────────────────────────────────────────────

/**
 * 崩溃残留对账（仅在**已持有同 scope 互斥锁**时调用）：
 * 同 scope 重叠、状态仍为 LOCKED/RUNNING 的历史任务，其进程必然已死
 * （否则它仍持锁、我们不可能拿到锁）→ 标记 RECOVERY_REQUIRED，并只删除它
 * **台账登记**的未发布工作目录（已发布产物一律保留）。
 */
async function reconcileStaleBackupJobs({ jobId, schemas, log }) {
  const mine = new Set(schemas)
  const result = { examined: 0, marked: [], cleaned: [] }
  for (const rec of listJobRecords()) {
    if (rec.corrupt || rec.jobId === jobId || rec.kind !== 'backup') continue
    if (!['LOCKED', 'RUNNING'].includes(rec.state)) continue
    const overlap = (rec.schemas || []).some((s) => mine.has(s))
    if (!overlap) continue
    result.examined += 1
    await updateJobRecord(rec.jobId, {
      state: 'RECOVERY_REQUIRED',
      recoveryNote: `对账发现于 ${jobId}（持锁进程判定其已死）；仅标记，不自动删除已发布产物`,
      reconciledBy: jobId,
      reconciledAt: new Date().toISOString(),
    })
    result.marked.push(rec.jobId)
    if (rec.workspace && fs.existsSync(rec.workspace)) {
      try {
        const r = await removeOwnWorkspace(rec.jobId, `stale-reconcile-by-${jobId}`)
        result.cleaned.push({ jobId: rec.jobId, removed: r.removed })
      } catch (e) {
        result.cleaned.push({ jobId: rec.jobId, removed: false, error: e.message })
      }
    }
    log(`${TAG} ⚠️ 对账历史备份任务 ${rec.jobId}（state=${rec.state}）→ RECOVERY_REQUIRED`)
  }
  return result
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

/**
 * 执行一次备份（单校或全库）。任何失败会先写 SECURITY:BACKUP_FAILED 系统日志
 * （复用 auditLog.writeSystemLog → public.SystemLog → 现有 securityAlerts 扫描器推送 webhook），
 * 再向外抛出。
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} opts.prisma 基础单例（连 public）
 * @param {'all'|'single'} opts.scope
 * @param {string} [opts.schoolCode] scope='single' 时必填
 * @param {string} [opts.createdBy] 操作者（super_admin username 或 'system'）
 * @param {(m:string)=>void} [opts.log]
 * @param {object} [opts.__hooks] 仅供本包定点测试注入（生产调用方不传）：
 *   `beforeDump(ctx)` 在“计数/结构已取、pg_dump 尚未启动”的窗口内执行。
 * @returns {Promise<object>} { filePath, metaPath, meta, tableCounts, verify, runId, jobId, snapshotMode }
 */
export async function runBackup(opts) {
  try {
    return await executeBackup(opts)
  } catch (e) {
    await reportBackupFailure(opts.prisma, opts.scope, e)
    throw e
  }
}

async function executeBackup({ prisma, scope, schoolCode, createdBy = 'system', log = console.log, __hooks = {} }) {
  if (scope === 'single' && !schoolCode) throw new Error(`${TAG} 单校备份必须提供 schoolCode`)
  if (!kmsMode()) throw new Error(`${TAG} 未配置加密主密钥（TENCENT_* 或 BACKUP_MASTER_KEY），fail-closed 拒绝执行`)

  // 磁盘空间预检（数据盘 90% 水位告警 + 防写满 fail-closed）
  await ensureDiskSpace(prisma)

  const dir = path.join(backupRootDir(), backupDateDir())
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  // 已存在的日期目录强制收紧为 700（备份文件含全量业务数据，仅系统用户可访问）
  await fsp.chmod(dir, 0o700).catch(() => {})

  // ① 确定 schema 范围：dump 采用【显式 schema 列表】。
  //    全库 = 注册学校的归一 schema + public（排除无 School 注册行的孤儿 schema，
  //    保证 dump 内容与 tableCounts 集合一致，L1 校验严格匹配）。
  const dumpSchemas = []
  let dumpSchema = null
  if (scope === 'all') {
    // 全库备份包含全部学校（active + disabled）：停用学校的记录同样承担数据法定留存
    const codes = await listSchoolCodes(prisma, { includeDisabled: true })
    for (const code of codes) {
      const s = schemaNameOf(code)
      if (s) { assertSafeSchemaName(s); dumpSchemas.push(s) }
    }
    dumpSchemas.push('public')
    log(`${TAG} 全库备份：${dumpSchemas.length - 1} 个租户 schema + public`)
  } else {
    const s = schemaNameOf(schoolCode)
    if (!s) throw new Error(`${TAG} 非法学校代码: ${schoolCode}`)
    assertSafeSchemaName(s)
    dumpSchemas.push(s)
    dumpSchema = s
    log(`${TAG} 单校备份：${s}`)
  }

  // ② 任务身份 + 台账（先登记 QUEUED；工作目录在获得互斥锁后才创建）
  const jobId = newJobId('backup')
  await createJobRecord({
    jobId,
    kind: 'backup',
    scope,
    schoolCode: scope === 'single' ? schoolCode : null,
    schemas: [...dumpSchemas],
    workspace: null,
    state: 'QUEUED',
    owner: ownerInfo(),
    stages: [{ stage: 'QUEUED', at: new Date().toISOString() }],
  })

  const labels = lockLabelsForScope({ kind: 'backup', scope, schema: dumpSchema, schemas: dumpSchemas })

  try {
    return await withMaintenanceLock({
      prisma,
      labels,
      kind: 'backup',
      timeoutMs: maintenanceTxTimeoutMs(),
      fn: async ({ tx, keys, txBackendPid }) => {
        await updateJobRecord(jobId, {
          state: 'LOCKED',
          lockKeys: keys,
          lockTxBackendPid: txBackendPid,
          stages: [{ stage: 'LOCKED', at: new Date().toISOString(), labels }],
        })
        log(`${TAG} 已获得互斥锁（jobId=${jobId}, labels=${labels.join(',')}）`)

        // 崩溃残留对账（持锁即证明同 scope 历史 LOCKED/RUNNING 任务已死）
        await reconcileStaleBackupJobs({ jobId, schemas: dumpSchemas, log })

        // ③ 私有工作目录（0700）——本任务全部中间产物只落在这里
        const workspace = await createJobWorkspace(jobId)
        await updateJobRecord(jobId, { workspace, state: 'RUNNING' })

        const ts = localNow().toISOString().replace(/[-:]/g, '').slice(0, 15) // 上海时区 YYYYMMDD_HHMMSS
        const artifactBase = `${scope === 'all' ? 'all-databases' : dumpSchema}.${ts}`
        const gzPath = path.join(workspace, `${artifactBase}.sql.gz.tmp`)
        const aesPath = path.join(workspace, `${artifactBase}.sql.gz.aes`)
        const metaPath = path.join(workspace, `${artifactBase}.meta.json`)
        // 发布目录名含 jobId：同秒同 scope 的并发备份也不会互相覆盖（AUD-007）
        const publishDir = path.join(dir, `${artifactBase}.${jobId}`)
        const finalAesPath = path.join(publishDir, `${artifactBase}.sql.gz.aes`)
        const finalMetaPath = path.join(publishDir, `${artifactBase}.meta.json`)

        // 表数基线（L1 校验：dump 中 CREATE TABLE 条数必须等于业务表数）
        let totalTables = 0
        for (const s of dumpSchemas) totalTables += (await listTablesInSchema(tx, s)).length

        // ④ 取数 + dump（快照一致性是硬约束，见 AUD-006）
        //    互斥事务已是 REPEATABLE READ：下面 counts / snapshot / 导出快照 天然同一快照边界。
        let usedMode = snapshotMode()
        const startedMode = usedMode
        const countsInTx = await collectTableCounts(tx, dumpSchemas)
        const schemaSnapshotResult = await collectSchemaSnapshot(tx, dumpSchemas)

        let snapshotId = null
        if (usedMode === 'snapshot') {
          const snapRows = await tx.$queryRawUnsafe('SELECT pg_export_snapshot() AS snapshot_id')
          snapshotId = String(snapRows?.[0]?.snapshot_id || '')
          if (!snapshotId) throw new Error(`${TAG} pg_export_snapshot() 未返回快照 ID`)
        }

        const dumpAndAnalyze = async (sid) => {
          const { bytes } = await runPgDump({ schemas: dumpSchemas, outPath: gzPath, snapshotId: sid })
          log(`${TAG} pg_dump 完成：${bytes} bytes（gz），${totalTables} 张表${sid ? `（snapshot=${sid}）` : ''}`)
          const a = await analyzeGzDump(gzPath)
          if (a.createTableCount !== totalTables) {
            throw new ArtifactConsistencyError(
              `L1 校验失败：dump 中 CREATE TABLE=${a.createTableCount}，预期=${totalTables}`,
              { jobId, createTableCount: a.createTableCount, expected: totalTables }
            )
          }
          return a
        }

        if (typeof __hooks.beforeDump === 'function') {
          await __hooks.beforeDump({ jobId, mode: usedMode, snapshotId, countsInSnapshot: countsInTx })
        }

        let analysis
        try {
          analysis = await dumpAndAnalyze(snapshotId)
        } catch (e) {
          // 仅当快照能力不可用（pg_dump 不识别 --snapshot / 无权限）时降级重试；
          // 其余错误（含 L1 不一致）原样抛出。降级后仍必须通过下面的交叉核对。
          const unsupported = snapshotId && e.code !== 'BACKUP_ARTIFACT_INCONSISTENT' && /unrecognized option|--snapshot|snapshot/i.test(String(e.message))
          if (!unsupported || process.env.BACKUP_SNAPSHOT_FALLBACK === 'false') throw e
          log(`${TAG} ⚠️ 共享导出快照不可用（${String(e.message).slice(0, 200)}）→ 降级为 live 模式（dump 反推计数 + 交叉核对）`)
          usedMode = 'live'
          snapshotId = null
          analysis = await dumpAndAnalyze(null)
        }

        // 交叉核对：统计计数（快照内）必须与 dump 反推行数**逐表一致**；
        // 不一致 = 计数与 dump 不共享同一快照（并发写入/DDL）→ 拒绝登记 ok/passed（AUD-006）。
        const diff = diffCounts(countsInTx, analysis.counts)
        if (!diff.consistent) {
          throw new ArtifactConsistencyError(
            `计数与 dump 不共享同一快照（mode=${usedMode}），拒绝登记 ok/passed: ${diff.mismatches.slice(0, 5).map((m) => `${m.table} counts=${m.snapshot} dump=${m.dump}`).join('; ')}`,
            { jobId, mode: usedMode, mismatches: diff.mismatches.slice(0, 20) }
          )
        }

        // 登记用的行数基线 = dump 反推值（与 dump 严格一致；上面已证明与统计值一致）
        const tableCounts = analysis.counts
        const createTableCount = analysis.createTableCount
        log(`${TAG} L1 校验通过（gzip 完整，CREATE TABLE=${createTableCount}，计数与 dump 一致，mode=${usedMode}）`)

        // ⑤ 加密 + meta（均在私有工作目录内）
        let meta
        ;({ meta } = await encryptGzStreaming(gzPath, aesPath))
        meta.tableCounts = tableCounts
        meta.schemaSnapshot = schemaSnapshotResult
        meta.snapshotMode = usedMode
        meta.jobId = jobId
        meta.scope = scope
        meta.schoolCode = scope === 'single' ? schoolCode : null
        meta.countsCrossCheck = { mode: usedMode, result: 'passed', tables: Object.keys(tableCounts).length }
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 })
        await fsp.unlink(gzPath).catch(() => {})
        const size = (await fsp.stat(aesPath)).size

        // ⑥ 原子发布：整个工作目录 rename → 发布目录（单次 rename；半成品不可见）
        await updateJobRecord(jobId, {
          state: 'PUBLISHING',
          stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'PUBLISHING', at: new Date().toISOString(), publishDir }],
        })
        await publishWorkspaceAtomically(jobId, workspace, publishDir)
        await updateJobRecord(jobId, { publishedPath: publishDir, state: 'PUBLISHED' })
        log(`${TAG} 产物已原子发布：${finalAesPath}（${size} bytes，jobId=${jobId}）`)

        // ⑦ 写 BackupRun 记录（status=ok / verify_status=passed —— 只有通过全部一致性校验才走到这里）
        let runId = null
        try {
          const rec = await prisma.backupRun.create({
            data: {
              // P0：CLI/systemd timer 触发均记 scheduled_*；P1 API 手动触发时区分 manual_*
              run_type: scope === 'all' ? 'scheduled_all' : 'scheduled_school',
              scope,
              schema_name: dumpSchema,
              school_code: scope === 'single' ? schoolCode : null,
              file_path: finalAesPath,
              file_size: size,
              table_counts: tableCounts,
              schema_snapshot: schemaSnapshotResult,
              checksum: meta.sha256 || null,
              encrypted: true,
              status: 'ok',
              verify_status: 'passed',
              created_by: createdBy,
            },
          })
          runId = rec.id
        } catch (e) {
          log(`${TAG} ⚠️ BackupRun 记录写入失败（备份文件已生成，不受影响）: ${e.message}`)
        }

        // ★P-Recovery-Audit v1：把 runId / scope / schoolCode / fileSize / createdAt 回写 meta.json，
        //   形成「meta 自带指纹」的强校验包。前端下载的 .meta.json 内嵌这些字段，
        //   服务端接收上传时把这些字段与 BackupRun 表交叉对比，防张冠李戴 / 中间人篡改。
        if (runId && meta) {
          try {
            meta.runId = runId
            meta.fileSize = size
            meta.createdAt = new Date().toISOString()
            await fsp.writeFile(finalMetaPath, JSON.stringify(meta, null, 2), { mode: 0o600 })
            // 把 createdAt 也回写到 BackupRun（用同一时间，避免与服务端默认 now() 漂移）
            await prisma.backupRun.update({
              where: { id: runId },
              data: { created_at: new Date(meta.createdAt) },
            }).catch(() => {})
          } catch (e) {
            log(`${TAG} ⚠️ meta.json 指纹回写失败（不影响恢复，但本地上传强校验无法启用）: ${e.message}`)
          }
        }

        await updateJobRecord(jobId, {
          state: 'COMPLETE',
          runId,
          filePath: finalAesPath,
          bytes: size,
          tables: Object.keys(tableCounts).length,
          stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'COMPLETE', at: new Date().toISOString(), runId: runId || null }],
        })

        // ⑧ 清理过期（扫描备份根目录下全部日期子目录；台账目录与未发布工作目录不在清理范围）
        await cleanupOldBackups(backupRootDir())

        log(`${TAG} ✅ 备份完成：${finalAesPath}（${size} bytes），L1 校验通过，BackupRun=${runId || 'N/A'}`)
        return {
          filePath: finalAesPath,
          metaPath: finalMetaPath,
          meta,
          tableCounts,
          verify: { createTableCount, expected: totalTables },
          runId,
          jobId,
          snapshotMode: usedMode,
          startedSnapshotMode: startedMode,
        }
      },
    })
  } catch (e) {
    // 失败清理：只删本任务台账登记的工作目录（已发布产物绝不删除；他人产物更不触碰）
    let cleanup = null
    try {
      cleanup = await removeOwnWorkspace(jobId, 'backup-failed-cleanup')
    } catch (ce) {
      log(`${TAG} ⚠️ 失败清理被拒绝（保留现场供人工核对）: ${ce.message}`)
      cleanup = { removed: false, error: ce.message }
    }
    try {
      await updateJobRecord(jobId, {
        state: 'FAILED',
        error: String(e.message || e).slice(0, 800),
        errorCode: e.code || null,
        cleanup,
        stages: [...(readJobRecord(jobId)?.stages || []), { stage: 'FAILED', at: new Date().toISOString() }],
      })
    } catch { /* 台账写失败不掩盖原错误 */ }
    throw e
  }
}

/**
 * 磁盘空间预检：备份根目录所在文件系统空间管理（数据盘 90% 水位告警）。
 *   - 剩余空间低于 10%（数据盘占用 ≥90%）：打印告警并写系统日志，提示清理或导出备份
 *     （不阻断备份——数据盘与系统盘分离，备份失败反而影响数据安全；阈值 BACKUP_WARN_PCT，默认 90）。
 *   - 剩余空间低于硬阈值（默认 1024MB，BACKUP_MIN_FREE_MB 可调）：拒绝备份（fail-closed），
 *     避免磁盘写满导致 PG 无法写入。
 * 平台不支持 statfs（Node < 19.6）或目录不可达时跳过预检（不阻断备份）。
 */
async function ensureDiskSpace(prisma) {
  await fsp.mkdir(backupRootDir(), { recursive: true, mode: 0o700 })
  let s
  try {
    s = await fsp.statfs(backupRootDir())
  } catch { return } // ENOSYS / 平台不支持 → 跳过
  const totalBytes = Number(s.blocks) * Number(s.bsize)
  const freeBytes = Number(s.bavail) * Number(s.bsize)
  const usedPct = totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes) * 100 : 0
  // 数据盘占用 ≥90% 时告警提醒清理或导出（不阻断备份）
  const warnPct = Number(process.env.BACKUP_WARN_PCT || 90)
  if (usedPct >= warnPct) {
    const warn = `${TAG} ⚠️ 数据盘空间占用已达 ${usedPct.toFixed(1)}%（阈值 ${warnPct}%），请清理过期备份或导出归档`
    console.log(warn)
    try {
      await writeSystemLog(prisma, { level: 'warn', message: `BACKUP_DISK_WARN used_pct=${usedPct.toFixed(1)} total=${(totalBytes / 1024 / 1024 / 1024).toFixed(1)}GB free=${(freeBytes / 1024 / 1024 / 1024).toFixed(1)}GB` })
    } catch { /* 告警日志失败不影响备份 */ }
  }
  const minBytes = Number(process.env.BACKUP_MIN_FREE_MB || 1024) * 1024 * 1024
  if (freeBytes < minBytes) {
    throw new Error(
      `${TAG} 磁盘剩余空间不足（${(freeBytes / 1024 / 1024).toFixed(0)}MB < 阈值 ${Math.round(minBytes / 1024 / 1024)}MB），拒绝备份`
    )
  }
}

/** 备份失败写 SECURITY:BACKUP_FAILED 到 public.SystemLog（由 securityAlerts 扫描器推送 webhook）。 */
async function reportBackupFailure(prisma, scope, error) {
  try {
    await writeSystemLog(prisma, {
      level: 'error',
      message: `SECURITY:BACKUP_FAILED scope=${scope} error=${error.message || String(error)}`,
      context: { action_type: 'backup_failed', scope, ts: new Date().toISOString(), code: error.code || null },
    })
  } catch (e) {
    console.error(`${TAG} 备份失败告警日志写入失败: ${e.message}`)
  }
}

/**
 * 清理超过 BACKUP_KEEP_DAYS 的备份文件（.aes/.meta/.tmp 均清理）。
 * 递归扫描 root 下全部日期子目录——若只扫当天目录，历史日期的备份永远不会被清理，
 * 保留策略将完全失效（P0 审查修复）。
 * 排除：任务台账根（`.jobs`，含未发布工作目录）——它不是备份产物，不得按保留策略删除。
 */
export async function cleanupOldBackups(root) {
  // BACKUP_KEEP_DAYS<=0 = 禁用自动清理（2026-08-27 策略变更：备份数据不自动删除，
  // 改由磁盘水位告警（/usr/local/sbin/disk-usage-alert.sh，≥90% 触发）通知人工决策清理。
  // ⚠️ 必须先守卫再算 cutoff：keepDays=0 时 cutoff=now 会把全部备份删光。
  if (!(keepDays() > 0)) return 0
  const cutoff = Date.now() - keepDays() * 24 * 60 * 60 * 1000
  const ledgerRoot = path.resolve(jobLedgerRoot())
  let removed = 0
  const walk = async (dir) => {
    if (path.resolve(dir) === ledgerRoot) return // 台账/工作区不是备份产物
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { await walk(p); continue }
      if (!/\.(aes|json|tmp)$/.test(e.name)) continue
      try {
        const st = await fsp.stat(p)
        if (st.mtimeMs < cutoff) { await fsp.unlink(p); removed++ }
      } catch { /* 单文件错误忽略，不影响其余清理 */ }
    }
    // 清理后被清空的产物目录（避免遗留空壳目录；日期目录自身保留）
    if (path.resolve(dir) !== path.resolve(root)) {
      try {
        const left = await fsp.readdir(dir)
        if (left.length === 0) await fsp.rmdir(dir)
      } catch { /* 非空/不可读忽略 */ }
    }
  }
  await walk(root)
  if (removed) console.log(`${TAG} 清理过期备份 ${removed} 个（保留 ${keepDays()} 天）`)
  return removed
}

// ─────────────────────────────────────────────────────────────
// 受控外部备份注册入口（P3-W3-CROSS-REG-R1）
// 把**非本实例产生**的备份产物登记进本实例 BackupRun（含独立 external 审计）；
// 实现见 lib/externalBackupRegistration.js（本文件仅 re-export，作为统一入口）。
// ─────────────────────────────────────────────────────────────
export { registerExternalBackup, ExternalRegistrationError, EXTERNAL_RUN_TYPE, EXTERNAL_AUDIT_ACTION } from './externalBackupRegistration.js'
