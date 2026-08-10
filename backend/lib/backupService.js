// backupService.js — 数据备份引擎（P0）
//
// 提供「单校 / 全库」两种逻辑备份（pg_dump -Fp -Z6），流程：
//   ① 枚举学校（public.School）→ schemaNameOf() 归一（防 school-gtest / school_gtest 双形态）
//   ② 统计各表行数（meta.tableCounts，供 L2 恢复后对比）
//   ③ pg_dump 输出 .sql.gz（MVCC 单事务快照，备份期间不阻塞业务写入）
//   ④ 流式 AES-256-GCM 信封加密 → .aes（密钥源见 backupKms.js，fail-closed）
//   ⑤ L1 校验：gzip 完整性 + CREATE TABLE 数量对比
//   ⑥ 写 public."BackupRun" 记录（status=ok / verify 结果）
//   ⑦ 按 BACKUP_KEEP_DAYS 清理过期备份
//
// 被复用：
//   - scripts/003_backup-now.mjs —— CLI（手动/定时触发）
//   - 后续 /api/admin/backups（P1，控制台触发）
//
// ⚠️ 与 tenantClient.js 的约定：schema 名一律经 schemaNameOf()/assertSafeSchemaName()
//    归一与白名单校验，禁止直接用 public.School.code 拼 SQL。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { schemaNameOf, assertSafeSchemaName } from './tenantClient.js'
import { sealDek, kmsMode } from './backupKms.js'
import { writeSystemLog } from './auditLog.js'

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

// ─────────────────────────────────────────────────────────────
// 元数据采集
// ─────────────────────────────────────────────────────────────

/**
 * 读取 public."School" 学校代码。
 * @param {boolean} [opts.includeDisabled] 全库备份应包含停用学校（数据法定留存：停用≠可丢失，
 *   否则主库故障时停用学校的数据无灾难恢复保障——P0 审查修复）。单校备份按 code 直接备份不受影响。
 */
export async function listSchoolCodes(prisma, { includeDisabled = false } = {}) {
  const where = includeDisabled ? '' : `WHERE status = 'active'`
  const rows = await prisma.$queryRawUnsafe(`SELECT code FROM public."School" ${where}`)
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

// ─────────────────────────────────────────────────────────────
// pg_dump 执行
// ─────────────────────────────────────────────────────────────

/**
 * 执行 pg_dump 并写出 .sql.gz 临时文件。
 * @param {object} opts
 * @param {string[]} opts.schemas 要 dump 的 schema 列表（显式列表：全库时排除无注册行的孤儿 schema，
 *   保证 dump 内容与 tableCounts 统计集合严格一致，L1 校验不会误判）
 * @param {string} opts.outPath 输出 .sql.gz 路径
 * @returns {Promise<{bytes: number}>}
 */
function runPgDump({ schemas, outPath }) {
  return new Promise((resolve, reject) => {
    const args = [
      `--dbname=${cleanDatabaseUrl()}`,
      '--format=plain',
      '--compress=6',
      '--no-owner',
      '--no-acl',
      '--lock-wait-timeout=30',
    ]
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
        fs.unlinkSync(outPath)
        reject(new Error(`pg_dump 失败（exit=${code}, schema=${schemas.join(',')}）: ${stderr.slice(0, 800)}`))
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
// 流式加密 + L1 校验
// ─────────────────────────────────────────────────────────────

/**
 * L1 校验：流式 gunzip 验证 gzip 完整性（损坏即 reject），并统计 CREATE TABLE 数量
 * （与 meta.tableCounts 表数对比，防"备份了空库/半库"）。
 * 返回 { createTableCount }。
 */
function countCreateTablesInGz(gzPath) {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip()
    let createTableCount = 0
    let tail = ''
    gunzip.on('data', (chunk) => {
      // 处理跨 chunk 边界：保留尾部 24 字节参与下一次匹配
      const text = tail + chunk.toString('utf8')
      const total = (text.match(/CREATE TABLE/g) || []).length
      // 显式排除 _prisma_migrations：PG 各版本对「--schema 是否携带该表」行为不同
      // （本地 PG18 实测不 dump，生产 PG14 可能 dump），必须与 tableCounts（业务表）严格对齐
      const mig = (text.match(/CREATE TABLE\s+(?:"[^"]+"\.)?"_prisma_migrations"/g) || []).length
      createTableCount += total - mig
      tail = text.slice(-24)
    })
    gunzip.on('error', reject) // gzip 损坏 → L1 失败
    gunzip.on('end', () => resolve({ createTableCount }))
    fs.createReadStream(gzPath).pipe(gunzip)
  })
}

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
 * @returns {Promise<object>} { filePath, metaPath, meta, tableCounts, verify }
 */
export async function runBackup(opts) {
  try {
    return await executeBackup(opts)
  } catch (e) {
    await reportBackupFailure(opts.prisma, opts.scope, e)
    throw e
  }
}

async function executeBackup({ prisma, scope, schoolCode, createdBy = 'system', log = console.log }) {
  if (scope === 'single' && !schoolCode) throw new Error(`${TAG} 单校备份必须提供 schoolCode`)
  if (!kmsMode()) throw new Error(`${TAG} 未配置加密主密钥（TENCENT_* 或 BACKUP_MASTER_KEY），fail-closed 拒绝执行`)

  // 磁盘空间预检（防定时任务写满系统盘）
  await ensureDiskSpace()

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

  // ② 行数统计（L2 校验基线，集合与 dump 一致）
  const tableCounts = await collectTableCounts(prisma, dumpSchemas)
  const totalTables = Object.keys(tableCounts).length

  // ③ pg_dump
  const ts = localNow().toISOString().replace(/[-:]/g, '').slice(0, 15) // 上海时区 YYYYMMDD_HHMMSS
  const baseName = `${scope === 'all' ? 'all-databases' : dumpSchema}.${ts}`
  const tmpGz = path.join(dir, `${baseName}.sql.gz.tmp`)
  const aesPath = path.join(dir, `${baseName}.sql.gz.aes`)
  const metaPath = path.join(dir, `${baseName}.meta.json`)

  // 主流程包 try：任何失败清理半成品（.aes / .tmp），避免目录残留"看似有效实则损坏"的文件
  let size = 0
  let createTableCount = 0
  let meta = null
  try {
    const { bytes } = await runPgDump({ schemas: dumpSchemas, outPath: tmpGz })
    log(`${TAG} pg_dump 完成：${bytes} bytes（gz），${totalTables} 张表`)

    // ④ L1 校验（gzip 完整性 + CREATE TABLE 数量对比，排除 _prisma_migrations）
    ;({ createTableCount } = await countCreateTablesInGz(tmpGz))
    if (createTableCount !== totalTables) {
      throw new Error(`${TAG} L1 校验失败：dump 中 CREATE TABLE=${createTableCount}，预期=${totalTables}`)
    }
    log(`${TAG} L1 校验通过（gzip 完整，CREATE TABLE=${createTableCount}）`)

    // ⑤ 加密 .sql.gz 压缩流 → .aes
    ;({ meta } = await encryptGzStreaming(tmpGz, aesPath))
    // meta 内嵌 tableCounts：L2 恢复后行数对比基线，且使 meta.json 自包含（不依赖 BackupRun 表）
    meta.tableCounts = tableCounts
    // meta.json 含 DEK 密文（信封外层），权限 600
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 })
    await fsp.unlink(tmpGz).catch(() => {})
    size = (await fsp.stat(aesPath)).size
  } catch (e) {
    // 失败清理：半写 .aes 必须删除（否则会被误认为有效备份），tmp 一并清理
    await fsp.unlink(aesPath).catch(() => {})
    await fsp.unlink(tmpGz).catch(() => {})
    throw e
  }

  // ⑥ 写 BackupRun 记录
  let runId = null
  try {
    const rec = await prisma.backupRun.create({
      data: {
        // P0：CLI/systemd timer 触发均记 scheduled_*；P1 API 手动触发时区分 manual_*
        run_type: scope === 'all' ? 'scheduled_all' : 'scheduled_school',
        scope,
        schema_name: dumpSchema,
        school_code: scope === 'single' ? schoolCode : null,
        file_path: aesPath,
        file_size: size,
        table_counts: JSON.stringify(tableCounts),
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

  // ⑦ 清理过期（扫描备份根目录下全部日期子目录）
  await cleanupOldBackups(backupRootDir())

  log(`${TAG} ✅ 备份完成：${aesPath}（${size} bytes），L1 校验通过，BackupRun=${runId || 'N/A'}`)
  return { filePath: aesPath, metaPath, meta, tableCounts, verify: { createTableCount, expected: totalTables }, runId }
}

/**
 * 磁盘空间预检：备份根目录所在文件系统剩余空间低于阈值（默认 1024MB，BACKUP_MIN_FREE_MB 可调）
 * 则拒绝备份（fail-closed），避免定时任务把系统盘写满影响主服务。
 * 平台不支持 statfs（Node < 19.6）或目录不可达时跳过预检（不阻断备份）。
 */
async function ensureDiskSpace() {
  await fsp.mkdir(backupRootDir(), { recursive: true, mode: 0o700 })
  let s
  try {
    s = await fsp.statfs(backupRootDir())
  } catch { return } // ENOSYS / 平台不支持 → 跳过
  const minBytes = Number(process.env.BACKUP_MIN_FREE_MB || 1024) * 1024 * 1024
  const freeBytes = Number(s.bavail) * Number(s.bsize)
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
      context: { action_type: 'backup_failed', scope, ts: new Date().toISOString() },
    })
  } catch (e) {
    console.error(`${TAG} 备份失败告警日志写入失败: ${e.message}`)
  }
}

/**
 * 清理超过 BACKUP_KEEP_DAYS 的备份文件（.aes/.meta/.tmp 均清理）。
 * 递归扫描 root 下全部日期子目录——若只扫当天目录，历史日期的备份永远不会被清理，
 * 保留策略将完全失效（P0 审查修复）。
 */
export async function cleanupOldBackups(root) {
  const cutoff = Date.now() - keepDays() * 24 * 60 * 60 * 1000
  let removed = 0
  const walk = async (dir) => {
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
  }
  await walk(root)
  if (removed) console.log(`${TAG} 清理过期备份 ${removed} 个（保留 ${keepDays()} 天）`)
  return removed
}
