// adminDiskRoutes.js — 磁盘管理 API（控制台「磁盘管理」视图后端，仅平台超管）
//
// 背景（2026-08-27 容量策略）：本机已移除全部"上限自动删除"
//   （journal SystemMaxUse、logrotate size/rotate、BACKUP_KEEP_DAYS 均停用），
//   改为磁盘 ≥90% 水位告警（scripts/disk-usage-alert.sh）+ 超管在控制台人工决策清理。
//   本路由即"人工决策"的执行入口：查看水位 / journal 收缩 / 日志删除 / 按天删备份。
//
// 端点（全部 authenticateUser + requirePlatformSuperAdmin）：
//   GET  /api/admin/disk/overview            — 水位总览（挂载点、journal、日志文件、备份按天、PG）
//   POST /api/admin/disk/journal/vacuum      — 收缩 journal（{days}，经 root 包装脚本）
//   POST /api/admin/disk/logs/delete         — 删除日志文件（{paths:[...]}，白名单目录内）
//   POST /api/admin/disk/backups/delete-day  — 按天删除备份（{day:'YYYY-MM-DD'}，文件+BackupRun 行同删）
//
// 安全：
//   - journal 收缩与 rsyslog/journal 文件删除需要 root → 经固定包装脚本
//     /usr/local/sbin/disk-manage.sh（sudoers NOPASSWD 白名单，脚本内再做参数与路径校验）
//   - 所有路径参数做前缀白名单 + '..' 拒绝；execFile 数组参数（无 shell 注入面）
//   - 所有变更操作写 writeAdminOpsLog 审计（public.AdminOpsLog）

import express from 'express'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeAdminOpsLog } from '../lib/auditLog.js'

const TAG = '[adminDiskRoutes]'

// 允许查看/删除的目录白名单（前缀精确匹配，尾部 / 防前缀混淆，如 /xx/abc2 不匹配 /xx/abc/）
const LOG_DIRS = [
  '/mnt/datadisk0/foodsentinel/logs/',        // 应用+备份+日志告警（foodsentinel 属主）
  '/mnt/datadisk0/system-logs/syslog/',       // rsyslog 输出（syslog:adm）
  '/mnt/datadisk0/system-logs/journal/',      // journald 归档（root，经包装脚本操作）
]
const DU_TARGETS = [
  ...LOG_DIRS,
  '/mnt/datadisk0/system-logs/disk-alert.log',
  '/mnt/datadisk0/foodsentinel/data/pgdata',  // PG 集群（postgres 属主，读大小需 root）
  '/var/log/journal',                          // bind 挂载入口（与上面同内容）
]

/** 白名单校验：路径必须落在允许的目录前缀内，且无 '..' 等穿越段。 */
function assertAllowedPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('非法路径')
  if (p.includes('..')) throw new Error('路径含 ..')
  const ok = LOG_DIRS.some((d) => p === d.slice(0, -1) || p.startsWith(d))
  if (!ok) throw new Error(`路径不在白名单目录内: ${p}`)
}

/** 经 sudo 白名单包装脚本执行 root 特权操作（journal 收缩 / 受限 du/ls/删除）。 */
function sudoManage(...args) {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['/usr/local/sbin/disk-manage.sh', ...args], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${(stderr || err.message || '').toString().trim().slice(0, 300)}`))
      resolve(stdout.toString())
    })
  })
}

/** du -sb（字节）。root 目录用包装脚本，自身可读目录直接读。 */
async function duBytes(dir) {
  try {
    const out = await sudoManage('du', dir)
    const n = Number.parseInt(out, 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** 递归统计目录内文件明细（仅自身可读目录用；不可读目录由包装脚本 ls 负责）。 */
async function listFiles(dir, prefix) {
  const out = []
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { out.push(...await listFiles(p, prefix)); continue }
    try {
      const st = await fsp.stat(p)
      out.push({ path: p, size: st.size, mtime: st.mtimeMs, rotated: /\.\d+$|\.gz$/.test(e.name) })
    } catch { /* 忽略单个文件 */ }
  }
  return out
}

export function createAdminDiskRoutes({ prisma, authenticateUser, requirePlatformSuperAdmin }) {
  const router = express.Router()
  router.use(authenticateUser, requirePlatformSuperAdmin)

  const backupDir = () => (process.env.BACKUP_DIR || '/mnt/datadisk0/foodsentinel/backups').replace(/\/+$/, '')

  // ── GET /overview — 水位总览 ──
  router.get('/overview', async (req, res) => {
    try {
      // ① 挂载点水位（df -P 解析，避免平台差异）
      const dfOut = await new Promise((resolve) => {
        execFile('df', ['-P', '/mnt/datadisk0', '/'], (e, stdout) => resolve(e ? '' : stdout))
      })
      const mounts = []
      for (const line of (dfOut || '').trim().split('\n').slice(1)) {
        const c = line.trim().split(/\s+/)
        if (c.length < 6) continue
        mounts.push({ mount: c[5], total: Number(c[1]) * 1024, used: Number(c[2]) * 1024, avail: Number(c[3]) * 1024, usagePct: Number.parseInt(c[4], 10) || 0 })
      }

      // ② journal / pgdata 大小（root 目标走包装脚本）
      const [journalBytes, pgdataBytes] = await Promise.all([
        duBytes('/var/log/journal'),
        duBytes('/mnt/datadisk0/foodsentinel/data/pgdata'),
      ])

      // ③ 日志文件明细：应用日志目录直接读；rsyslog/journal 目录经包装脚本 ls
      let appLogs = await listFiles('/mnt/datadisk0/foodsentinel/logs')
      let rsyslogLogs = []
      let journalFiles = []
      try {
        const out = await sudoManage('ls', '/mnt/datadisk0/system-logs/syslog')
        rsyslogLogs = out.trim().split('\n').filter(Boolean).map((l) => {
          const [size, mtime, ...rest] = l.split('\t')
          const p = rest.join('\t')
          // find %T@ 输出秒（含小数），转毫秒供前端 Date 使用
          return { path: p, size: Number(size), mtime: Number(mtime) * 1000, rotated: /\.\d+$|\.gz$/.test(p) }
        })
      } catch { /* 目录不存在或为空 */ }
      try {
        const out = await sudoManage('ls', '/mnt/datadisk0/system-logs/journal')
        journalFiles = out.trim().split('\n').filter(Boolean).map((l) => {
          const [size, mtime, ...rest] = l.split('\t')
          return { path: rest.join('\t'), size: Number(size), mtime: Number(mtime), rotated: true }
        })
        // journal 目录是多级（/<machine-id>/xxx.jnl），只统计大小，删除走 vacuum
        journalFiles = journalFiles.slice(0, 50)
      } catch { /* 忽略 */ }

      // ④ 备份按天聚合（foodsentinel 属主，可直接读）
      const bd = backupDir()
      const byDay = []
      let backupTotal = 0
      try {
        for (const e of (await fsp.readdir(bd, { withFileTypes: true }))) {
          if (!e.isDirectory()) continue
          const dayDir = path.join(bd, e.name)
          let size = 0, count = 0
          for (const f of (await fsp.readdir(dayDir, { withFileTypes: true }))) {
            if (!f.isFile()) continue
            try { size += (await fsp.stat(path.join(dayDir, f.name))).size; count++ } catch { /* 忽略 */ }
          }
          byDay.push({ day: e.name, size, count })
          backupTotal += size
        }
        byDay.sort((a, b) => a.day < b.day ? 1 : -1)
      } catch { /* 备份目录不存在 */ }

      // ⑤ PG 逻辑库大小（public 库 = foodsentinel）
      let dbSize = null
      try {
        const r = await prisma.$queryRawUnsafe(`SELECT pg_database_size(current_database())::bigint AS n`)
        dbSize = Number(r[0]?.n) || null
      } catch { /* 忽略 */ }

      res.json({
        success: true,
        data: {
          mounts,
          journal: { bytes: journalBytes, fileCount: journalFiles.length },
          pgdata: { bytes: pgdataBytes, dbBytes: dbSize },
          logs: {
            app: { files: appLogs, bytes: appLogs.reduce((s, f) => s + f.size, 0) },
            rsyslog: { files: rsyslogLogs, bytes: rsyslogLogs.reduce((s, f) => s + f.size, 0) },
          },
          backups: { totalBytes: backupTotal, byDay, dir: bd },
          thresholdPct: 90,
        },
      })
    } catch (e) {
      console.error(`${TAG} overview 失败:`, e)
      res.status(500).json({ success: false, error: e.message || '读取磁盘水位失败' })
    }
  })

  // ── POST /journal/vacuum — 收缩 journal 到最近 N 天 ──
  router.post('/journal/vacuum', async (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 365)
      const out = await sudoManage('journal-vacuum', String(days))
      const after = await duBytes('/var/log/journal')
      await writeAdminOpsLog(prisma, {
        action: 'disk_journal_vacuum',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: '', targetSchoolCode: null,
        details: { days }, level: 'info',
      })
      res.json({ success: true, data: { days, output: out.trim().slice(-500), bytesAfter: after } })
    } catch (e) {
      console.error(`${TAG} journal vacuum 失败:`, e)
      res.status(500).json({ success: false, error: e.message || 'journal 收缩失败' })
    }
  })

  // ── POST /logs/delete — 删除白名单目录内的日志文件 ──
  router.post('/logs/delete', async (req, res) => {
    try {
      const paths = Array.isArray(req.body?.paths) ? req.body.paths.slice(0, 200) : []
      if (!paths.length) return res.status(400).json({ success: false, error: '缺少 paths' })
      for (const p of paths) assertAllowedPath(p)

      const deleted = [], failed = []
      for (const p of paths) {
        try {
          await sudoManage('log-delete', p)
          deleted.push(p)
        } catch (e) {
          failed.push({ path: p, error: e.message.slice(0, 120) })
        }
      }
      await writeAdminOpsLog(prisma, {
        action: 'disk_logs_delete',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: '', targetSchoolCode: null,
        details: { count: deleted.length, paths: deleted }, level: 'warn',
      })
      res.json({ success: failed.length === 0, data: { deleted, failed } })
    } catch (e) {
      res.status(400).json({ success: false, error: e.message || '删除失败' })
    }
  })

  // ── POST /backups/delete-day — 批量按天删除备份（文件对 + BackupRun 行）──
  // 入参（二选一）：{ day: 'YYYY-MM-DD' } 或 { days: ['YYYY-MM-DD', ...] }（按月/按年/多选批量）
  router.post('/backups/delete-day', async (req, res) => {
    try {
      let days = []
      if (Array.isArray(req.body?.days)) days = req.body.days.map(String)
      else if (req.body?.day) days = [String(req.body.day)]
      if (!days.length) return res.status(400).json({ success: false, error: '缺少 day / days' })
      if (days.length > 800) return res.status(400).json({ success: false, error: '单次最多 800 天' })
      for (const d of days) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ success: false, error: `日期格式非法: ${d}` })
      }

      const bd = backupDir()
      const results = []
      let totalFiles = 0, totalRuns = 0
      for (const day of [...new Set(days)].sort()) {
        const dayDir = path.join(bd, day)
        if (!dayDir.startsWith(bd + '/') || !fs.existsSync(dayDir)) {
          results.push({ day, removedFiles: 0, removedRuns: 0, skipped: 'not_found' })
          continue
        }
        // 只删 .aes/.meta.json/.tmp 文件对；先查行数，再删文件，最后删 BackupRun 行（保持文件与记录一致）
        const runs = await prisma.backupRun.findMany({
          where: { file_path: { startsWith: dayDir + '/' } },
          select: { id: true },
        })
        let removedFiles = 0
        for (const e of (await fsp.readdir(dayDir, { withFileTypes: true }))) {
          if (!e.isFile()) continue
          await fsp.unlink(path.join(dayDir, e.name)).catch(() => {})
          removedFiles++
        }
        await fsp.rmdir(dayDir).catch(() => {})
        let removedRows = 0
        for (const r of runs) {
          await prisma.backupRun.delete({ where: { id: r.id } }).catch(() => {})
          removedRows++
        }
        totalFiles += removedFiles
        totalRuns += removedRows
        results.push({ day, removedFiles, removedRuns: removedRows })
      }
      await writeAdminOpsLog(prisma, {
        action: 'disk_backups_delete_day',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: '', targetSchoolCode: null,
        details: { days, totalFiles, totalRuns }, level: 'warn',
      })
      res.json({
        success: true,
        data: { days: results, totalDays: results.length, totalFiles, totalRuns },
      })
    } catch (e) {
      console.error(`${TAG} 按天删备份失败:`, e)
      res.status(500).json({ success: false, error: e.message || '删除备份失败' })
    }
  })

  // ════════════════════════════════════════════════════════════════
  // 学校租户业务日志（各 schema AuditLog）统计 / 导出 / 删除
  // 策略：磁盘 ≥90% 告警后，超管按校+截止日期导出留档（服务端落
  //   BACKUP_DIR/audit-exports/，permanent 文件不自动清理），
  //   然后才能删除（守卫：删除截止日期 ≤ 该校最近一次导出截止日期，未留档不可删）。
  // ════════════════════════════════════════════════════════════════

  const AUDIT_SCHOOLS = ['tjb', 'zhyz', 'zhsy']   // 启用中的租户；新增学校后在此登记
  const schemaOf = (code) => `school_${code}`

  /** 导出目录：放数据盘，与备份同级独立子目录（audit-exports/），人工管理不自动清理。 */
  function auditExportDir() {
    const d = path.join(backupDir(), 'audit-exports')
    fs.mkdirSync(d, { recursive: true })
    return d
  }

  // ── GET /audit-logs/stats — 各校 AuditLog 统计（行数/最旧/最新/截止前数量）──
  router.get('/audit-logs/stats', async (req, res) => {
    try {
      const before = typeof req.query.before === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.before) ? req.query.before : null
      const stats = []
      for (const code of AUDIT_SCHOOLS) {
        const s = schemaOf(code)
        try {
          const rows = before
            ? await prisma.$queryRawUnsafe(
                `SELECT count(*)::int AS n, min("created_at") AS oldest, max("created_at") AS newest
                 FROM "${s}"."AuditLog" WHERE "created_at" < ($1::date + interval '1 day')`, before)
            : await prisma.$queryRawUnsafe(
                `SELECT count(*)::int AS n, min("created_at") AS oldest, max("created_at") AS newest FROM "${s}"."AuditLog"`)
          stats.push({
            schoolCode: code, schema: s,
            total: rows[0]?.n || 0,
            oldest: rows[0]?.oldest || null,
            newest: rows[0]?.newest || null,
            beforeCount: before ? (rows[0]?.n || 0) : null,
          })
        } catch (e) {
          stats.push({ schoolCode: code, schema: s, error: e.message.slice(0, 120) })
        }
      }
      res.json({ success: true, data: { schools: stats, before } })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message || '统计失败' })
    }
  })

  // ── POST /audit-logs/export — 导出留档（按校 + 截止日期；服务端写文件，返回下载路径）──
  router.post('/audit-logs/export', async (req, res) => {
    try {
      const schoolCode = String(req.body?.schoolCode || '')
      const before = String(req.body?.before || '')
      if (!AUDIT_SCHOOLS.includes(schoolCode)) return res.status(400).json({ success: false, error: 'schoolCode 非法' })
      if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) return res.status(400).json({ success: false, error: 'before 格式须为 YYYY-MM-DD' })

      const s = schemaOf(schoolCode)
      const rows = await prisma.$queryRawUnsafe(
        `SELECT "id","user_id","action","resource_type","resource_id","details","ip_address","created_at"
         FROM "${s}"."AuditLog" WHERE "created_at" < ($1::date + interval '1 day')
         ORDER BY "created_at" ASC`, before)
      if (!rows.length) return res.status(404).json({ success: false, error: '该截止日期前无日志可导出' })

      // JSON Lines：一行一条，自包含、可流式追加、机器可解析（留档首选格式）
      const dir = auditExportDir()
      const fname = `auditlog_${schoolCode}_before_${before}_${Date.now()}.jsonl`
      const fpath = path.join(dir, fname)
      const lines = rows.map((r) => JSON.stringify({ ...r, _school: schoolCode, _schema: s }))
      await fsp.writeFile(fpath, lines.join('\n') + '\n', { mode: 0o600 })

      await writeAdminOpsLog(prisma, {
        action: 'disk_auditlog_export',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: '', targetSchoolCode: schoolCode,
        details: { before, count: rows.length, file: fname }, level: 'info',
      })
      res.json({ success: true, data: { schoolCode, before, count: rows.length, file: fname, path: fpath, bytes: (await fsp.stat(fpath)).size } })
    } catch (e) {
      console.error(`${TAG} 审计日志导出失败:`, e)
      res.status(500).json({ success: false, error: e.message || '导出失败' })
    }
  })

  // ── GET /audit-logs/download?file=... — 下载已生成的导出文件（限 audit-exports 目录）──
  router.get('/audit-logs/download', async (req, res) => {
    try {
      const file = String(req.query.file || '')
      if (!/^auditlog_[a-z0-9-]+_before_\d{4}-\d{2}-\d{2}_\d+\.jsonl$/.test(file)) {
        return res.status(400).json({ success: false, error: '文件名非法' })
      }
      const p = path.join(auditExportDir(), file)
      if (!fs.existsSync(p)) return res.status(404).json({ success: false, error: '导出文件不存在' })
      res.setHeader('Content-Type', 'application/x-ndjson')
      res.setHeader('Content-Disposition', `attachment; filename="${file}"`)
      fs.createReadStream(p).pipe(res)
    } catch (e) {
      res.status(500).json({ success: false, error: e.message || '下载失败' })
    }
  })

  // ── POST /audit-logs/delete — 删除截止日期前的审计日志（守卫：必须已导出到该截止日）──
  router.post('/audit-logs/delete', async (req, res) => {
    try {
      const schoolCode = String(req.body?.schoolCode || '')
      const before = String(req.body?.before || '')
      if (!AUDIT_SCHOOLS.includes(schoolCode)) return res.status(400).json({ success: false, error: 'schoolCode 非法' })
      if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) return res.status(400).json({ success: false, error: 'before 格式须为 YYYY-MM-DD' })

      // 守卫 ①：该校必须存在"截止日期 ≥ before"的导出文件（未留档不可删）
      const dir = auditExportDir()
      const re = new RegExp(`^auditlog_${schoolCode}_before_(\\d{4}-\\d{2}-\\d{2})_\\d+\\.jsonl$`)
      const exportedBefore = fs.readdirSync(dir)
        .map((f) => { const m = re.exec(f); return m ? m[1] : null })
        .filter(Boolean)
        .sort()
      if (!exportedBefore.length || exportedBefore[exportedBefore.length - 1] < before) {
        return res.status(400).json({
          success: false,
          error: `删除被拒绝：${schoolCode} 尚无截止日期 ≥ ${before} 的导出留档。请先导出，再删除（数据不落盘不删）。`,
        })
      }

      const s = schemaOf(schoolCode)
      const cnt = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "${s}"."AuditLog" WHERE "created_at" < ($1::date + interval '1 day')`, before)
      const willDelete = cnt[0]?.n || 0
      if (!willDelete) return res.status(404).json({ success: false, error: '该截止日期前无日志' })
      if (Number(req.body?.confirmCount) !== willDelete) {
        return res.status(400).json({ success: false, error: `confirmCount 不匹配：将删除 ${willDelete} 条，请在请求体带 confirmCount=${willDelete}` })
      }

      await prisma.$executeRawUnsafe(
        `DELETE FROM "${s}"."AuditLog" WHERE "created_at" < ($1::date + interval '1 day')`, before)
      await writeAdminOpsLog(prisma, {
        action: 'disk_auditlog_delete',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: '', targetSchoolCode: schoolCode,
        details: { before, deleted: willDelete, exportVerified: exportedBefore[exportedBefore.length - 1] }, level: 'warn',
      })
      res.json({ success: true, data: { schoolCode, before, deleted: willDelete, exportVerified: exportedBefore[exportedBefore.length - 1] } })
    } catch (e) {
      console.error(`${TAG} 审计日志删除失败:`, e)
      res.status(500).json({ success: false, error: e.message || '删除失败' })
    }
  })

  return router
}
