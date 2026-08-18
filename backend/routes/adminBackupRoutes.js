// adminBackupRoutes.js — 备份管理 API（P1：控制台「运维备份」Tab 后端）
//
// 端点（全部 requirePlatformSuperAdmin，即平台超管）：
//   GET    /api/admin/backups                — 备份列表（BackupRun，分页/筛选）
//   POST   /api/admin/backups/run            — 触发备份（{scope:'all'|'single', schoolCode?}）
//   GET    /api/admin/backups/:id/download?format=plain|encrypted — 下载备份
//   POST   /api/admin/backups/:id/verify     — 触发离线验证（backupVerify）
//   POST   /api/admin/backups/:id/restore    — 影子恢复（{targetSchoolCode, confirmText:'RESTORE'}）
//
// 安全：
//   - 下载 plain（明文）默认拒绝：公网 HTTP 环境明文下载=裸奔。需 BACKUP_PLAIN_DOWNLOAD_ALLOWED=true
//     且建议在 HTTPS/内网下使用（P0 已确认生产公网当前为 HTTP）
//   - 恢复必须 confirmText === 'RESTORE' + 平台超管 + 审计（runRestore 内部 writeAdminOpsLog）

import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { runBackup } from '../lib/backupService.js'
import { verifyBackupFile } from '../lib/backupVerify.js'
import { runRestore } from '../lib/restoreService.js'
import { writeAdminOpsLog } from '../lib/auditLog.js'

const TAG = '[adminBackupRoutes]'

export function createAdminBackupRoutes({ prisma, authenticateUser, requirePlatformSuperAdmin }) {
  const router = express.Router()
  router.use(authenticateUser, requirePlatformSuperAdmin)

  /** 由 BackupRun id 取记录并校验文件存在。 */
  async function loadRun(id, res) {
    const run = await prisma.backupRun.findUnique({ where: { id } })
    if (!run || !run.file_path || !fs.existsSync(run.file_path)) {
      res.status(404).json({ success: false, error: '备份记录或文件不存在' })
      return null
    }
    return run
  }

  // ── GET /api/admin/backups — 备份列表 ──
  router.get('/', async (req, res) => {
    try {
      const { schoolCode, scope, page = '1', pageSize = '20' } = req.query
      const take = Math.min(Math.max(Number(pageSize) || 20, 1), 100)
      const skip = (Math.max(Number(page) || 1, 1) - 1) * take
      const where = {}
      // 方案B：指定学校时，同时返回该学校的单校备份与【全库备份】（全库备份覆盖所有租户，
      // 各学校在"按学校"视图都应有记录可见；恢复时由 runRestore 提取本校 schema 段）。
      if (schoolCode) where.OR = [{ school_code: schoolCode }, { scope: 'all' }]
      if (scope) where.scope = scope

      const [total, items] = await Promise.all([
        prisma.backupRun.count({ where }),
        prisma.backupRun.findMany({ where, orderBy: { created_at: 'desc' }, skip, take }),
      ])
      res.json({
        success: true,
        data: items.map((r) => ({
          id: r.id,
          runType: r.run_type,
          scope: r.scope,
          schemaName: r.schema_name,
          schoolCode: r.school_code,
          fileSize: r.file_size,
          tableCounts: r.table_counts,
          checksum: r.checksum,
          encrypted: r.encrypted,
          status: r.status,
          verifyStatus: r.verify_status,
          createdAt: r.created_at,
        })),
        total,
        page: Number(page) || 1,
        pageSize: take,
      })
    } catch (e) {
      console.error(`${TAG} 列表失败:`, e)
      res.status(500).json({ success: false, error: '获取备份列表失败' })
    }
  })

  // ── POST /api/admin/backups/run — 触发备份（同步，中小库秒级完成）──
  router.post('/run', async (req, res) => {
    try {
      const { scope = 'all', schoolCode } = req.body || {}
      if (scope !== 'all' && scope !== 'single') {
        return res.status(400).json({ success: false, error: 'scope 必须是 all 或 single' })
      }
      if (scope === 'single' && !schoolCode) {
        return res.status(400).json({ success: false, error: '单校备份必须提供 schoolCode' })
      }
      const result = await runBackup({
        prisma,
        scope,
        schoolCode: scope === 'single' ? schoolCode : undefined,
        createdBy: req.user?.username || 'super_admin',
      })
      await writeAdminOpsLog(prisma, {
        action: 'backup_run',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: result.runId || '',
        targetSchoolCode: scope === 'single' ? schoolCode : null,
        details: { scope, file: path.basename(result.filePath) },
        level: 'info',
      })
      res.json({ success: true, data: { runId: result.runId, file: path.basename(result.filePath), size: result.tableCounts } })
    } catch (e) {
      console.error(`${TAG} 触发备份失败:`, e)
      res.status(500).json({ success: false, error: e.message || '触发备份失败' })
    }
  })

  // ── GET /api/admin/backups/:id/download?format=plain|encrypted ──
  router.get('/:id/download', async (req, res) => {
    try {
      const run = await loadRun(req.params.id, res)
      if (!run) return
      const format = req.query.format || 'plain'
      // 白名单校验：防 format=xxx 绕过明文限制落入解密分支（TD-School-Backup-Sync 审查修复）
      if (!['plain', 'encrypted'].includes(format)) {
        return res.status(400).json({ success: false, error: 'format 仅支持 plain 或 encrypted' })
      }
      const aesPath = run.file_path
      const metaPath = aesPath.replace(/\.sql\.gz\.aes$/, '.meta.json')

      // 明文下载：公网 HTTP 环境拒绝（P0 已确认生产公网当前为 HTTP）
      if (format === 'plain' && process.env.BACKUP_PLAIN_DOWNLOAD_ALLOWED !== 'true') {
        return res.status(403).json({
          success: false,
          error: '明文下载默认禁止：公网 HTTP 下明文传输=数据裸奔。请启用 HTTPS/内网后设置 BACKUP_PLAIN_DOWNLOAD_ALLOWED=true',
        })
      }

      await writeAdminOpsLog(prisma, {
        action: 'backup_download',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: run.id,
        targetSchoolCode: run.school_code,
        details: { format, file: path.basename(aesPath) },
        level: 'warn', // 下载敏感数据，warn 级审计
      })

      if (format === 'encrypted') {
        res.download(aesPath, path.basename(aesPath))
        return
      }
      // plain：解密后流式返回 .sql.gz
      const { decryptFile } = await import('../lib/backupKms.js')
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      const plain = await decryptFile(fs.readFileSync(aesPath), meta)
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(aesPath).replace(/\.aes$/, '')}"`)
      res.send(plain)
    } catch (e) {
      console.error(`${TAG} 下载失败:`, e)
      res.status(500).json({ success: false, error: e.message || '下载失败' })
    }
  })

  // ── POST /api/admin/backups/:id/verify — 离线验证 ──
  router.post('/:id/verify', async (req, res) => {
    try {
      const run = await loadRun(req.params.id, res)
      if (!run) return
      const metaPath = run.file_path.replace(/\.sql\.gz\.aes$/, '.meta.json')
      const result = await verifyBackupFile(run.file_path, metaPath)
      // 回写 verify_status
      await prisma.backupRun.update({
        where: { id: run.id },
        data: { verify_status: result.ok ? 'passed' : 'failed' },
      }).catch(() => {})
      await writeAdminOpsLog(prisma, {
        action: 'backup_verify',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: run.id,
        targetSchoolCode: run.school_code,
        details: { ok: result.ok, error: result.error || null },
        level: 'info',
      })
      res.json({ success: result.ok, checks: result.checks, error: result.error || null })
    } catch (e) {
      console.error(`${TAG} 验证失败:`, e)
      res.status(500).json({ success: false, error: e.message || '验证失败' })
    }
  })

  // ── POST /api/admin/backups/:id/restore-batch — 批量影子恢复（异步逐校执行）──
  // 用途：大事故应急，从一份全库备份同时/逐个恢复多所学校，避免 50 校逐个手动点。
  // 设计要点（P 大事故批量恢复）：
  //   - 仅支持全库备份（scope='all'）：全库 dump 含所有租户 schema 段，可按 targetSchoolCodes
  //     逐校提取。单校备份（scope='single'）只含一校，批量无意义 → 400。
  //   - 请求体 { confirmText:'RESTORE_ALL', targetSchoolCodes:[...] }。
  //     confirmText 强制 'RESTORE_ALL'（区别于单校 'RESTORE'，防误触发）。
  //   - 逐校调用 runRestore（每校独立原子事务，互不影响）；串行执行避免 DB 并发压力。
  //   - 返回逐校结果数组 [{schoolCode, ok, schema, checks, error}]，含成功/失败明细。
  //   - 审计：逐校 writeAdminOpsLog（action 含 backup_restore / backup_restore_failed）。
  router.post('/:id/restore-batch', async (req, res) => {
    try {
      const run = await loadRun(req.params.id, res)
      if (!run) return
      const { confirmText, targetSchoolCodes } = req.body || {}
      if (confirmText !== 'RESTORE_ALL') {
        return res.status(400).json({ success: false, error: '批量恢复必须输入确认词 RESTORE_ALL' })
      }
      if (!Array.isArray(targetSchoolCodes) || targetSchoolCodes.length === 0) {
        return res.status(400).json({ success: false, error: '缺少 targetSchoolCodes（至少一个学校代码）' })
      }
      // 去重 + 去空 + 只保留字符串（防 [object Object] 注入）
      const codes = [...new Set(targetSchoolCodes.filter((c) => typeof c === 'string').map((c) => c.trim()).filter(Boolean))]
      if (codes.length === 0) {
        return res.status(400).json({ success: false, error: 'targetSchoolCodes 均为空' })
      }
      // 上限保护：防误操作/恶意请求一次恢复过多学校（每校一次完整恢复，代价高）
      const MAX_BATCH_SCHOOLS = 200
      if (codes.length > MAX_BATCH_SCHOOLS) {
        return res.status(400).json({ success: false, error: `一次批量恢复最多 ${MAX_BATCH_SCHOOLS} 所学校（当前 ${codes.length} 所），请分批执行` })
      }
      // 仅全库备份支持批量（见顶部注释）
      if (run.scope !== 'all') {
        return res.status(400).json({ success: false, error: '批量恢复仅支持全库备份（scope=all）' })
      }
      const actor = { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip }
      // 串行逐校恢复：每校独立事务，一校失败不影响其它
      const results = []
      const startedAt = Date.now()
      for (const code of codes) {
        try {
          const r = await runRestore({ prisma, backup: run, targetSchoolCode: code, actor })
          results.push({ schoolCode: code, ok: r.ok, schema: r.schema, checks: r.checks, error: r.error || null })
        } catch (e) {
          results.push({ schoolCode: code, ok: false, schema: null, checks: [], error: e.message || String(e) })
        }
      }
      const okCount = results.filter((r) => r.ok).length
      const elapsedMs = Date.now() - startedAt
      await writeAdminOpsLog(prisma, {
        action: 'backup_restore_batch',
        actor,
        targetId: run.id,
        targetSchoolCode: null,
        details: {
          requested: codes.length,
          succeeded: okCount,
          failed: codes.length - okCount,
          schools: codes,
          results, // 逐校明细（含成功/失败原因）
          elapsedMs,
        },
        level: okCount === codes.length ? 'warn' : 'error',
      })
      res.json({
        success: okCount === codes.length,
        data: {
          requested: codes.length,
          succeeded: okCount,
          failed: codes.length - okCount,
          elapsedMs,
          results,
        },
      })
    } catch (e) {
      console.error(`${TAG} 批量恢复失败:`, e)
      res.status(500).json({ success: false, error: e.message || '批量恢复失败' })
    }
  })

  // ── POST /api/admin/backups/:id/restore — 影子恢复（同步执行）──
  router.post('/:id/restore', async (req, res) => {
    try {
      const run = await loadRun(req.params.id, res)
      if (!run) return
      const { targetSchoolCode, confirmText } = req.body || {}
      if (confirmText !== 'RESTORE') {
        return res.status(400).json({ success: false, error: '必须输入确认词 RESTORE' })
      }
      if (!targetSchoolCode) {
        return res.status(400).json({ success: false, error: '缺少 targetSchoolCode' })
      }
      // 方案B：全库备份现在支持单校恢复——runRestore 内部按 targetSchoolCode
      // 提取该 schema 段（extractSchemaSegment），只恢复目标学校，不影响其他租户。
      // 显式校验：恢复目标学校必须与该备份匹配（单校备份只能恢复本校；全库备份可恢复任意学校）。
      if (run.scope !== 'all' && run.school_code !== targetSchoolCode) {
        return res.status(400).json({ success: false, error: '该备份不属于目标学校，无法恢复' })
      }
      const actor = { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip }
      const result = await runRestore({
        prisma,
        backup: run,
        targetSchoolCode,
        actor,
      })
      res.json({ success: result.ok, checks: result.checks, error: result.error || null, schema: result.schema, oldSchema: result.oldSchema })
    } catch (e) {
      console.error(`${TAG} 恢复失败:`, e)
      res.status(500).json({ success: false, error: e.message || '恢复失败' })
    }
  })

  return router
}
