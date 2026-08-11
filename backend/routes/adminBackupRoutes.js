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
      if (schoolCode) where.school_code = schoolCode
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
      // 全库备份不能直接单校恢复（无目标 schema 对应关系），需先下载后按单校备份恢复
      if (run.scope === 'all') {
        return res.status(400).json({ success: false, error: '全库备份不支持直接恢复，请使用单校备份文件恢复' })
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
