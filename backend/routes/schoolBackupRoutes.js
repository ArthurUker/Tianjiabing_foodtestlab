// schoolBackupRoutes.js — 学校侧备份 API（TD-School-Backup-Sync 第⑦轮）
//
// 与超管的 /api/admin/backups 能力对齐（list / run / download / verify / restore），
// 但严格限制在【当前学校租户】内：
//   - 鉴权：仅 role ∈ {'admin','manager'} 且 req.user.schoolCode 非空可调用
//     → 平台超管（role=admin 且 schoolCode 为空）拒绝，避免越权
//     → 普通员工 operator/viewer 拒绝（读操作超出职责范围，写操作更不允许）
//   - 列表：固定 where = { school_code: req.user.schoolCode }，忽略 URL 上的
//     schoolCode / scope 参数，防止通过筛选参数跨校看数据
//   - run：强制 scope='single' + schoolCode=req.user.schoolCode，忽略 body 的 schoolCode/scope
//   - download / verify / restore：先取 BackupRun，再校验
//     run.school_code === req.user.schoolCode，不匹配返回 403（防止 GUID 扫描）
//   - restore：targetSchoolCode 强制 = req.user.schoolCode，禁止改写到其他学校
//
// 审计：writeTenantAuditLog（落到学校租户 schema 的 auditLog，不是 public 系统日志）

import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import { runBackup } from '../lib/backupService.js'
import { verifyBackupFile } from '../lib/backupVerify.js'
import { runRestore } from '../lib/restoreService.js'
import { writeTenantAuditLog } from '../lib/auditLog.js'
import { compareSchemaSnapshot } from '../lib/schemaCompatibility.js'

const TAG = '[schoolBackupRoutes]'

export function createSchoolBackupRoutes({ prisma, authenticateUser }) {
  const router = express.Router()
  router.use(authenticateUser, requireSchoolAdminOrManager)

  /** 仅学校 admin/manager 允许调用本组 API，平台超管与员工拒绝。 */
  function requireSchoolAdminOrManager(req, res, next) {
    const role = req.user?.role
    const schoolCode = req.user?.schoolCode || null
    if (!role || !schoolCode) {
      return res.status(403).json({
        success: false,
        error: '学校管理员/经理账号才能使用备份功能；平台超管请到控制台使用'
      })
    }
    if (!['admin', 'manager'].includes(role)) {
      return res.status(403).json({ success: false, error: '权限不足：仅学校管理员/经理可使用备份功能' })
    }
    next()
  }

  // 判断某条 BackupRun 当前学校是否可访问：
  //   - 单校备份：school_code 必须 === 本校
  //   - 全库备份（scope='all', school_code=null）：方案B 下对所有学校可见，
  //     允许 verify / restore（restore 内 runRestore 只提取本校 schema 段，不触及其他租户），
  //     但 download 仍禁止（download 端点单独拦截，见下）。
  function isBackupVisibleToSchool(run, schoolCode) {
    if (!run) return false
    if (run.scope === 'all') return true
    return run.school_code === schoolCode
  }

  // 为学校侧构建 schema 兼容报告：仅暴露本校 schema + public，避免泄露其他租户结构。
  function buildSchoolSchemaCompat(run, schoolCode, currentSchemaMap) {
    const snap = run.schema_snapshot || {}
    const relevantSchemas = run.scope === 'all'
      ? Object.keys(snap).filter((s) => s === schoolCode || s === 'public')
      : Object.keys(snap).filter((s) => s === schoolCode)
    if (relevantSchemas.length === 0) {
      return { schemaCompatible: null, schemaCompatSummary: '无结构快照', schemaCompatReports: {} }
    }
    const reports = {}
    let allCompat = true
    for (const schema of relevantSchemas) {
      const current = currentSchemaMap[schema] || {}
      const report = compareSchemaSnapshot(snap[schema], current)
      reports[schema] = report
      if (!report.compatible) allCompat = false
    }
    const diffCount = Object.values(reports).reduce((n, rep) => n + rep.details.length, 0)
    return {
      schemaCompatible: allCompat,
      schemaCompatSummary: allCompat
        ? '结构兼容：与当前代码一致'
        : `结构偏旧：恢复将自动补齐 ${diffCount} 项差异`,
      schemaCompatReports: reports,
    }
  }

  /** 拉一条 BackupRun 并强制校验它属于本校（不匹配返回 403）。全库备份对本校可见（verify/restore 用）。 */
  async function loadRunOwnedBySchool(id, schoolCode, res) {
    const run = await prisma.backupRun.findUnique({ where: { id } })
    if (!run || !run.file_path) {
      res.status(404).json({ success: false, error: '备份记录或文件不存在' })
      return null
    }
    if (!isBackupVisibleToSchool(run, schoolCode)) {
      // 防止猜测 ID 跨校读取 BackupRun 元数据
      res.status(403).json({ success: false, error: '该备份不属于当前学校，无权访问' })
      return null
    }
    if (!fs.existsSync(run.file_path)) {
      res.status(404).json({ success: false, error: '备份文件已不在磁盘上' })
      return null
    }
    return run
  }

  /** 写入租户审计日志（req.db 由 authenticateUser 注入），失败仅警告不阻断主流程。 */
  async function audit(req, action, targetId, details) {
    try {
      await writeTenantAuditLog(req.db, {
        actorId: req.user?.userId || null,
        action,
        resourceType: 'BackupRun',
        resourceId: targetId,
        details,
        ip: req.ip,
      })
    } catch (e) {
      console.warn(`${TAG} 审计写入失败（${action}）: ${e.message}`)
    }
  }

  // ── GET /api/school/backups — 本校备份列表 ──
  router.get('/', async (req, res) => {
    try {
      const schoolCode = req.user.schoolCode
      const { page = '1', pageSize = '20' } = req.query
      const take = Math.min(Math.max(Number(pageSize) || 20, 1), 100)
      const skip = (Math.max(Number(page) || 1, 1) - 1) * take
      // 【强隔离】where 不可因 URL 上的 schoolCode/scope 改变——
      // 不论传 schoolCode 还是 scope，一律按当前学校 + 单校备份过滤。
      // 方案B：学校侧列表 = 本校单校备份 + 平台全库备份（全库备份对所有学校可见，
      // 但后续 download 已隔离、restore 只恢复本校 schema 段，不触及其他学校数据）。
      const where = {
        OR: [
          { school_code: schoolCode, scope: 'single' },
          { scope: 'all' },
        ],
      }

      const [total, items] = await Promise.all([
        prisma.backupRun.count({ where }),
        prisma.backupRun.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take,
        }),
      ])

      // 学校侧只关心本校 schema + 全库备份中的 public 系统表，避免暴露其他租户结构信息。
      const currentSchemaMap = {}
      const schemasToCheck = [schoolCode, 'public']
      const colRows = await prisma.$queryRawUnsafe(
        `SELECT table_schema, table_name, column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = ANY($1::text[]) AND table_name != '_prisma_migrations'
         ORDER BY table_schema, table_name, ordinal_position`,
        schemasToCheck
      )
      for (const row of colRows) {
        const sc = row.table_schema
        const tbl = row.table_name
        if (!currentSchemaMap[sc]) currentSchemaMap[sc] = {}
        if (!currentSchemaMap[sc][tbl]) currentSchemaMap[sc][tbl] = []
        currentSchemaMap[sc][tbl].push({ column: row.column_name, type: row.data_type })
      }

      res.json({
        success: true,
        data: items.map((r) => {
          const compat = buildSchoolSchemaCompat(r, schoolCode, currentSchemaMap)
          return {
            id: r.id,
            runType: r.run_type,
            scope: r.scope,
            schemaName: r.schema_name,
            schoolCode: r.school_code,
            // 手动/定时区分：手动触发时 created_by 以 "manual_" 前缀开头
            // （见 POST /run 的 createdBy 拼接），run_type 恒为 scheduled_*，不能作为判断依据
            createdBy: r.created_by,
            fileSize: r.file_size,
            tableCounts: r.table_counts,
            checksum: r.checksum,
            encrypted: r.encrypted,
            status: r.status,
            verifyStatus: r.verify_status,
            schemaCompatible: compat.schemaCompatible,
            schemaCompatSummary: compat.schemaCompatSummary,
            schemaCompatReports: compat.schemaCompatReports,
            createdAt: r.created_at,
          }
        }),
        total,
        page: Number(page) || 1,
        pageSize: take,
      })
    } catch (e) {
      console.error(`${TAG} 列表失败:`, e)
      res.status(500).json({ success: false, error: '获取备份列表失败' })
    }
  })

  // ── POST /api/school/backups/run — 触发本校备份 ──
  router.post('/run', async (req, res) => {
    try {
      const schoolCode = req.user.schoolCode
      // 【强隔离】scope/schoolCode 完全根据 token 决定，忽略 body 传入
      const result = await runBackup({
        prisma,
        scope: 'single',
        schoolCode,
        // 区分手动触发：以 "manual_" 前缀与定时器的 scheduled_* 区分
        createdBy: `manual_${req.user?.username || 'school_admin'}@${schoolCode}`,
      })
      await audit(req, 'backup_run', result.runId || '', {
        scope: 'single',
        schoolCode,
        file: path.basename(result.filePath),
      })
      res.json({
        success: true,
        data: {
          runId: result.runId,
          file: path.basename(result.filePath),
          size: result.tableCounts,
        },
      })
    } catch (e) {
      console.error(`${TAG} 触发备份失败:`, e)
      res.status(500).json({ success: false, error: e.message || '触发备份失败' })
    }
  })

  // ── GET /api/school/backups/:id/download?format=plain|encrypted ──
  router.get('/:id/download', async (req, res) => {
    try {
      const schoolCode = req.user.schoolCode
      const run = await loadRunOwnedBySchool(req.params.id, schoolCode, res)
      if (!run) return
      const format = req.query.format || 'plain'
      // 白名单校验：防 format=xxx 绕过明文限制落入解密分支（超管版同款缺陷，一并修复）
      if (!['plain', 'encrypted'].includes(format)) {
        return res.status(400).json({ success: false, error: 'format 仅支持 plain 或 encrypted' })
      }
      // 方案B 隔离底线：全库备份物理文件包含【所有学校】数据，学校侧一律禁止下载
      // （即使密文也禁止外泄其它租户数据；恢复走 restore 接口由服务端提取本校段）。
      if (run.scope === 'all') {
        return res.status(403).json({ success: false, error: '全库备份包含其他学校数据，学校侧禁止下载；如需恢复请使用"恢复"功能' })
      }
      const aesPath = run.file_path
      const metaPath = aesPath.replace(/\.sql\.gz\.aes$/, '.meta.json')

      // 与平台超管下载策略保持一致：明文默认拒绝（公网 HTTP 风险与超管共用同一套约束）
      if (format === 'plain' && process.env.BACKUP_PLAIN_DOWNLOAD_ALLOWED !== 'true') {
        return res.status(403).json({
          success: false,
          error: '明文下载默认禁止：公网 HTTP 下明文传输=数据裸奔。请在 HTTPS/内网环境并设置 BACKUP_PLAIN_DOWNLOAD_ALLOWED=true',
        })
      }

      await audit(req, 'backup_download', run.id, {
        format,
        file: path.basename(aesPath),
        schoolCode,
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

  // ── POST /api/school/backups/:id/verify — 离线验证 ──
  router.post('/:id/verify', async (req, res) => {
    try {
      const schoolCode = req.user.schoolCode
      const run = await loadRunOwnedBySchool(req.params.id, schoolCode, res)
      if (!run) return
      const metaPath = run.file_path.replace(/\.sql\.gz\.aes$/, '.meta.json')
      const result = await verifyBackupFile(run.file_path, metaPath)
      // 回写 verify_status（失败不影响返回结构）
      await prisma.backupRun.update({
        where: { id: run.id },
        data: { verify_status: result.ok ? 'passed' : 'failed' },
      }).catch(() => {})

      // 学校侧 schema 兼容报告（本校 + public）
      let compat = { schemaCompatible: null, schemaCompatSummary: '无结构快照', schemaCompatReports: {} }
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
          const currentSchemaMap = {}
          const schemasToCheck = [schoolCode, 'public']
          const colRows = await prisma.$queryRawUnsafe(
            `SELECT table_schema, table_name, column_name, data_type
             FROM information_schema.columns
             WHERE table_schema = ANY($1::text[]) AND table_name != '_prisma_migrations'
             ORDER BY table_schema, table_name, ordinal_position`,
            schemasToCheck
          )
          for (const row of colRows) {
            const sc = row.table_schema
            const tbl = row.table_name
            if (!currentSchemaMap[sc]) currentSchemaMap[sc] = {}
            if (!currentSchemaMap[sc][tbl]) currentSchemaMap[sc][tbl] = []
            currentSchemaMap[sc][tbl].push({ column: row.column_name, type: row.data_type })
          }
          compat = buildSchoolSchemaCompat({ schema_snapshot: meta.schemaSnapshot, scope: run.scope }, schoolCode, currentSchemaMap)
        } catch (metaErr) {
          console.warn(`${TAG} 读取 meta 计算 schema 兼容失败:`, metaErr.message)
        }
      }

      await audit(req, 'backup_verify', run.id, {
        ok: result.ok,
        schoolCode,
        error: result.error || null,
      })
      res.json({
        success: result.ok,
        checks: result.checks,
        error: result.error || null,
        schemaCompatible: compat.schemaCompatible,
        schemaCompatSummary: compat.schemaCompatSummary,
        schemaCompatReports: compat.schemaCompatReports,
      })
    } catch (e) {
      console.error(`${TAG} 验证失败:`, e)
      res.status(500).json({ success: false, error: e.message || '验证失败' })
    }
  })

  // ── POST /api/school/backups/:id/restore — 影子恢复 ──
  router.post('/:id/restore', async (req, res) => {
    try {
      const schoolCode = req.user.schoolCode
      const run = await loadRunOwnedBySchool(req.params.id, schoolCode, res)
      if (!run) return
      const { confirmText } = req.body || {}
      if (confirmText !== 'RESTORE') {
        return res.status(400).json({ success: false, error: '必须输入确认词 RESTORE' })
      }
      // 【强隔离】targetSchoolCode 强制 = req.user.schoolCode，禁止改写到其他学校
      const targetSchoolCode = schoolCode
      // 方案B：全库备份允许学校侧恢复，但 runRestore 只提取【本校】schema 段，
      // 其它学校的数据不会进入恢复流程（extractSchemaSegment 按 schema 精确切分）。
      const actor = {
        userId: req.user?.userId,
        username: req.user?.username,
        role: req.user?.role,
        schoolCode,
        ip: req.ip,
      }
      const result = await runRestore({
        prisma,
        backup: run,
        targetSchoolCode,
        actor,
      })
      await audit(
        req,
        result.ok ? 'backup_restore' : 'backup_restore_failed',
        run.id,
        { schema: result.schema, ok: result.ok, error: result.error || null }
      )
      res.json({
        success: result.ok,
        checks: result.checks,
        error: result.error || null,
        schema: result.schema,
        oldSchema: result.oldSchema,
        schemaCompatible: result.schemaCompatibility?.compatible ?? null,
        schemaCompatSummary: result.schemaCompatibility?.summary ?? '无结构快照',
        schemaCompatReports: result.schemaCompatibility?.reports ?? {},
      })
    } catch (e) {
      console.error(`${TAG} 恢复失败:`, e)
      res.status(500).json({ success: false, error: e.message || '恢复失败' })
    }
  })

  return router
}
