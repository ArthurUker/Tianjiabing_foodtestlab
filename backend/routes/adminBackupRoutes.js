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
import fsp from 'node:fs/promises'
import os from 'node:os'
import crypto from 'node:crypto'
import { runBackup } from '../lib/backupService.js'
import { verifyBackupFile } from '../lib/backupVerify.js'
import { runRestore } from '../lib/restoreService.js'
import { compareAllSchemaSnapshots, compareSchemaSnapshot } from '../lib/schemaCompatibility.js'
import { writeAdminOpsLog } from '../lib/auditLog.js'

const TAG = '[adminBackupRoutes]'

/** 把 base64 字符串还原为 Buffer。容错：去掉 data:*;base64, 前缀与空白。 */
function decodeBase64(b64) {
  if (!b64 || typeof b64 !== 'string') throw new Error('base64 内容为空')
  const cleaned = b64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '')
  return Buffer.from(cleaned, 'base64')
}

/** 上传恢复最大文件大小（明文 .sql.gz 通常 < 50MB，加密 .aes 再小一些；上限 100MB 防御）。 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

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

      // 批量读取当前数据库中这些备份涉及的所有 schema 的列结构（一次性查询，避免 N+1）
      const allBackupSchemas = [...new Set(items.flatMap((r) => Object.keys(r.schema_snapshot || {})))]
      const currentSchemaMap = {}
      if (allBackupSchemas.length > 0) {
        const colRows = await prisma.$queryRawUnsafe(
          `SELECT table_schema, table_name, column_name, data_type
           FROM information_schema.columns
           WHERE table_schema = ANY($1::text[]) AND table_name != '_prisma_migrations'
           ORDER BY table_schema, table_name, ordinal_position`,
          allBackupSchemas
        )
        for (const row of colRows) {
          const sc = row.table_schema
          const tbl = row.table_name
          if (!currentSchemaMap[sc]) currentSchemaMap[sc] = {}
          if (!currentSchemaMap[sc][tbl]) currentSchemaMap[sc][tbl] = []
          currentSchemaMap[sc][tbl].push({ column: row.column_name, type: row.data_type })
        }
      }

      res.json({
        success: true,
        data: items.map((r) => {
          const snap = r.schema_snapshot || {}
          const reports = {}
          let schemaCompatible = null
          let schemaCompatSummary = '无结构快照'
          if (Object.keys(snap).length > 0) {
            let allCompat = true
            for (const [schema, snapshot] of Object.entries(snap)) {
              const current = currentSchemaMap[schema] || {}
              const report = compareSchemaSnapshot(snapshot, current)
              reports[schema] = report
              if (!report.compatible) allCompat = false
            }
            schemaCompatible = allCompat
            schemaCompatSummary = allCompat
              ? '结构兼容：与当前代码一致'
              : `结构偏旧：恢复将自动补齐 ${Object.values(reports).reduce((n, rep) => n + rep.details.length, 0)} 项差异`
          }
          return {
            id: r.id,
            runType: r.run_type,
            scope: r.scope,
            schemaName: r.schema_name,
            schoolCode: r.school_code,
            fileSize: r.file_size,
            tableCounts: r.table_counts,
            schemaSnapshot: r.schema_snapshot,
            checksum: r.checksum,
            encrypted: r.encrypted,
            status: r.status,
            verifyStatus: r.verify_status,
            schemaCompatible,
            schemaCompatSummary,
            schemaCompatReports: reports,
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

  // ── GET /api/admin/backups/:id/meta — 下载对应 .meta.json（加密备份的元数据/指纹）──
  // ★P-Recovery-Audit v1：本地恢复需要在 .aes 之外还拥有 meta.json 才能做 sha256 交叉校验，
  //   提供独立下载接口便于 UI 把「下载备份」从「下 .aes」升级为「下 .aes + .meta.json 配套」。
  router.get('/:id/meta', async (req, res) => {
    try {
      const run = await loadRun(req.params.id, res)
      if (!run) return
      const metaPath = run.file_path.replace(/\.sql\.gz\.aes$/, '.meta.json')
      if (!fs.existsSync(metaPath)) return res.status(404).json({ success: false, error: 'meta.json 不存在' })
      const metaRaw = await fsp.readFile(metaPath, 'utf8')
      // 审计：meta 下载（warn 级）
      await writeAdminOpsLog(prisma, {
        action: 'backup_meta_download',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: run.id,
        targetSchoolCode: run.school_code,
        details: { file: path.basename(metaPath) },
        level: 'warn',
      })
      // 与「下载加密」下载策略一致：返回 meta.json 文件名而非 .json
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(metaPath)}"`)
      res.send(metaRaw)
    } catch (e) {
      console.error(`${TAG} 下载 meta 失败:`, e)
      res.status(500).json({ success: false, error: e.message || '下载 meta 失败' })
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

  // ── POST /api/admin/backups/restore-from-upload ────────────────────────────
  // 本地文件恢复（前端"本地上传"Tab）。接收：
  //   { confirmText: 'RESTORE'|'RESTORE_ALL',
  //     targetSchoolCode?: string,        // 单点
  //     targetSchoolCodes?: string[],     // 批量
  //     runId?: string,                   // ★强校验：原始备份 ID（必填，与 BackupRun 记录交叉核对）
  //     data: { filename, contentBase64, size },   // 必填：备份文件（.aes / .sql.gz / .sql）
  //     meta?: { filename, contentBase64 },        // 加密备份必填；明文可选（服务端会生成）
  //     clientSha256?: string,            // 客户端计算的 sha256（hex）。若提供则与服务端 sha256 比对，不匹配 422。
  //   }
  //
  // 强校验链（P-Recovery-Audit v1）：
  //   ① 必须提供 runId，对应 BackupRun 数据库记录；
  //   ② 上传文件大小（byteLen）必须 === BackupRun.file_size；
  //   ③ 解密后 sha256（与 meta.sha256 双保险）必须 === BackupRun.checksum；
  //   ④ meta 中携带的 runId（若存在）必须 === 请求 runId（防 meta 张冠李戴）；
  //   ⑤ 提供 clientSha256 时必须 === 服务端重新计算的 sha256（防中间人篡改）；
  //   任何一步不通过 → 422 拒绝 + 写 audit（action='backup_restore_upload_rejected'）。
  // 流程：保存到 tmpdir → 构造虚拟 BackupRun → 复用 runRestore。临时文件 finally 清理。
  router.post('/restore-from-upload', async (req, res) => {
    const startedAt = Date.now()
    const tmpFiles = []
    const cleanup = async () => {
      for (const f of tmpFiles) {
        try { await fsp.unlink(f) } catch (_) { /* ignore */ }
      }
    }
    try {
      const { confirmText, targetSchoolCode, targetSchoolCodes, runId, data, meta: metaIn, clientSha256 } = req.body || {}
      const isBatch = !targetSchoolCode && Array.isArray(targetSchoolCodes) && targetSchoolCodes.length > 0
      const codes = isBatch
        ? [...new Set((targetSchoolCodes || []).filter((c) => typeof c === 'string').map((c) => c.trim()).filter(Boolean))]
        : (typeof targetSchoolCode === 'string' && targetSchoolCode.trim() ? [targetSchoolCode.trim()] : [])

      if (isBatch) {
        if (confirmText !== 'RESTORE_ALL') return res.status(400).json({ success: false, error: '批量恢复必须输入确认词 RESTORE_ALL' })
        if (codes.length === 0) return res.status(400).json({ success: false, error: '缺少 targetSchoolCodes' })
        if (codes.length > 200) return res.status(400).json({ success: false, error: `一次批量恢复最多 200 所学校（当前 ${codes.length} 所），请分批执行` })
      } else {
        if (confirmText !== 'RESTORE') return res.status(400).json({ success: false, error: '必须输入确认词 RESTORE' })
        if (codes.length !== 1) return res.status(400).json({ success: false, error: '缺少 targetSchoolCode（仅 1 所）' })
      }
      if (!data || typeof data.contentBase64 !== 'string') {
        return res.status(400).json({ success: false, error: '缺少 data（备份文件内容）' })
      }
      // ★强校验 ①：runId 必须存在并能找到 BackupRun
      if (!runId || typeof runId !== 'string') {
        return res.status(400).json({ success: false, error: '缺少 runId（必须从备份库选择原始记录，以便交叉校验）' })
      }
      const sourceRun = await prisma.backupRun.findUnique({ where: { id: runId } })
      if (!sourceRun) {
        return res.status(404).json({ success: false, error: `runId=${runId} 在 BackupRun 中不存在（拒绝恢复，防伪造来源）` })
      }

      const size = Number(data.size) || 0
      if (size > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ success: false, error: `备份文件过大（${size} bytes），单次上传上限 ${MAX_UPLOAD_BYTES} bytes` })
      }

      // 保存 .aes（或明文临时文件）
      const dataBuf = decodeBase64(data.contentBase64)
      if (dataBuf.length > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ success: false, error: `备份文件过大（${dataBuf.length} bytes），单次上传上限 ${MAX_UPLOAD_BYTES} bytes` })
      }
      // ★强校验 ②：上传文件大小必须 === BackupRun.file_size（防恶意截断/拼接）
      if (Number.isFinite(sourceRun.file_size) && dataBuf.length !== sourceRun.file_size) {
        await writeAdminOpsLog(prisma, {
          action: 'backup_restore_upload_rejected',
          actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
          targetId: runId,
          targetSchoolCode: null,
          details: { reason: 'size_mismatch', declaredSize: dataBuf.length, dbSize: sourceRun.file_size, sourceFile: data.filename },
          level: 'error',
        })
        return res.status(422).json({
          success: false,
          error: `上传文件大小与原始备份不一致：上传 ${dataBuf.length} bytes, 原始 ${sourceRun.file_size} bytes（拒绝恢复，防中间人篡改）`,
        })
      }

      const uploadRunId = `upload-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'restore-upload-'))
      const safeName = (data.filename || 'backup.bin').replace(/[^a-zA-Z0-9._-]/g, '_')
      const aesName = safeName.endsWith('.aes') ? safeName : `${safeName}.sql.gz.aes`
      const aesPath = path.join(tmpDir, `${uploadRunId}-${aesName}`)
      let metaPath = null
      let meta = null

      const lower = safeName.toLowerCase()
      const isEncrypted = lower.endsWith('.aes')

      // 1) 加密备份（.aes）：要求 meta.json
      if (isEncrypted) {
        if (!metaIn || typeof metaIn.contentBase64 !== 'string') {
          await cleanup()
          return res.status(400).json({ success: false, error: '加密备份必须配套上传 meta.json' })
        }
        const metaBuf = decodeBase64(metaIn.contentBase64)
        metaPath = aesPath.replace(/\.sql\.gz\.aes$/, '.meta.json')
        await fsp.writeFile(aesPath, dataBuf)
        await fsp.writeFile(metaPath, metaBuf)
        tmpFiles.push(aesPath, metaPath)
        try {
          meta = JSON.parse(metaBuf.toString('utf8'))
        } catch (e) {
          await cleanup()
          return res.status(400).json({ success: false, error: `meta.json 解析失败：${e.message}` })
        }

        // ★强校验 ③：meta 中若带 runId，必须等于请求 runId（防 meta 与 .aes 来自不同备份）
        if (meta.runId && meta.runId !== runId) {
          await cleanup()
          await writeAdminOpsLog(prisma, {
            action: 'backup_restore_upload_rejected',
            actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
            targetId: runId,
            targetSchoolCode: null,
            details: { reason: 'meta_runId_mismatch', metaRunId: meta.runId, reqRunId: runId, sourceFile: data.filename },
            level: 'error',
          })
          return res.status(422).json({
            success: false,
            error: `meta.json 中的 runId（${meta.runId}）与请求 runId（${runId}）不一致，拒绝恢复`,
          })
        }

        // ★强校验 ④：服务端解密 + sha256，必须等于 meta.sha256 与 BackupRun.checksum（任一不匹配即拒绝）
        try {
          const { decryptFile } = await import('../lib/backupKms.js')
          const plain = await decryptFile(dataBuf, meta)
          const serverSha = crypto.createHash('sha256').update(plain).digest('hex')
          if (meta.sha256 && serverSha !== meta.sha256) {
            throw new Error(`解密 sha256 不一致：服务端 ${serverSha.slice(0, 16)}…, meta ${String(meta.sha256).slice(0, 16)}…`)
          }
          if (sourceRun.checksum && serverSha !== sourceRun.checksum) {
            throw new Error(`解密 sha256 与 BackupRun.checksum 不一致：服务端 ${serverSha.slice(0, 16)}…, DB ${String(sourceRun.checksum).slice(0, 16)}…`)
          }
          // ★强校验 ⑤：客户端预先计算的 sha256（若提供）必须等于服务端重新计算的（防中间人在上传途中篡改）
          if (clientSha256 && typeof clientSha256 === 'string') {
            const clientLower = clientSha256.trim().toLowerCase()
            if (clientLower !== serverSha) {
              throw new Error(`客户端 sha256（${clientLower.slice(0, 16)}…）与服务端重新计算的 sha256（${serverSha.slice(0, 16)}…）不一致，疑似传输中被修改，拒绝恢复`)
            }
          }
        } catch (e) {
          await cleanup()
          await writeAdminOpsLog(prisma, {
            action: 'backup_restore_upload_rejected',
            actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
            targetId: runId,
            targetSchoolCode: null,
            details: { reason: 'sha256_verify_failed', error: e.message, sourceFile: data.filename, clientSha256: clientSha256 || null },
            level: 'error',
          })
          return res.status(422).json({
            success: false,
            error: `本地备份完整性校验失败：${e.message}`,
          })
        }
      } else {
        // 2) 明文 .sql.gz 或 .sql：要求 BACKUP_PLAIN_DOWNLOAD_ALLOWED=true（与明文下载同策略）。
        //    临时加密成 .aes + 写 meta.json，再走 runRestore（保证走标准解密/校验路径）。
        // ★明文上传禁止：明文上传无法做 sha256 完整性校验（meta 中没有 sha256 可比对），
        //   即便 BACKUP_PLAIN_DOWNLOAD_ALLOWED=true 也仍只能下载不能上传恢复——强制走加密通道。
        await cleanup()
        await writeAdminOpsLog(prisma, {
          action: 'backup_restore_upload_rejected',
          actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
          targetId: runId,
          targetSchoolCode: null,
          details: { reason: 'plain_upload_not_allowed', sourceFile: data.filename },
          level: 'error',
        })
        return res.status(400).json({
          success: false,
          error: '本地上传恢复仅支持加密备份 .aes（明文上传无法做完整性校验）。请从备份库下载加密备份（.aes + .meta.json）后上传。',
        })
      }

      // 3) 构造虚拟 BackupRun。scope 优先取自 meta；缺省推断：含 tableCounts 键含 '.'（schema.table）多为多 schema 全库，
      //    含 schoolCode 为单点；兜底 all。
      const tc = meta?.tableCounts || {}
      const tcCount = Object.keys(tc).length
      const scope = meta?.scope || (tcCount > 0 && Object.keys(tc).some((k) => /\.school_/i.test(k)) && Object.keys(tc).some((k) => !k.startsWith('school_')) ? 'all' : 'single')
      const schoolCode = meta?.schoolCode || (scope === 'single' ? (isBatch ? codes[0] : codes[0]) : null)

      const fakeRun = {
        id: runId,
        scope,
        schema_name: scope === 'single' ? `school_${schoolCode}` : null,
        school_code: schoolCode,
        file_path: aesPath,
        table_counts: meta?.tableCounts || null,
        checksum: meta?.sha256 || null,
        encrypted: true,
        verify_status: 'pending',
      }

      const actor = { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip }

      // 4) 复用 runRestore 执行恢复
      if (isBatch) {
        // 仅全库备份支持（与 /restore-batch 同策略：明文/加密全库 dump 含多 schema 段，按目标学校提取）
        if (scope !== 'all') {
          await cleanup()
          return res.status(400).json({ success: false, error: '批量恢复仅支持全库备份（meta.scope=all 或 tableCounts 含多 schema）' })
        }
        const results = []
        for (const code of codes) {
          try {
            const r = await runRestore({ prisma, backup: fakeRun, targetSchoolCode: code, actor })
            results.push({ schoolCode: code, ok: r.ok, schema: r.schema, checks: r.checks, error: r.error || null })
          } catch (e) {
            results.push({ schoolCode: code, ok: false, schema: null, checks: [], error: e.message || String(e) })
          }
        }
        const okCount = results.filter((r) => r.ok).length
        const elapsedMs = Date.now() - startedAt
        await writeAdminOpsLog(prisma, {
          action: 'backup_restore_batch_upload',
          actor,
          targetId: runId,
          targetSchoolCode: null,
          details: { requested: codes.length, succeeded: okCount, failed: codes.length - okCount, schools: codes, results, sourceFile: data.filename, elapsedMs },
          level: okCount === codes.length ? 'warn' : 'error',
        })
        await cleanup()
        return res.json({
          success: okCount === codes.length,
          data: { requested: codes.length, succeeded: okCount, failed: codes.length - okCount, elapsedMs, results },
        })
      }

      // 单点恢复
      if (scope === 'single' && fakeRun.school_code && fakeRun.school_code !== codes[0]) {
        await cleanup()
        return res.status(400).json({ success: false, error: `该备份属于学校 ${fakeRun.school_code}，不能恢复到 ${codes[0]}` })
      }
      const r = await runRestore({ prisma, backup: fakeRun, targetSchoolCode: codes[0], actor })
      await writeAdminOpsLog(prisma, {
        action: r.ok ? 'backup_restore_upload' : 'backup_restore_upload_failed',
        actor,
        targetId: runId,
        targetSchoolCode: codes[0],
        details: { ok: r.ok, schema: r.schema, sourceFile: data.filename, error: r.error || null },
        level: r.ok ? 'warn' : 'error',
      })
      await cleanup()
      return res.json({
        success: r.ok,
        checks: r.checks,
        error: r.error || null,
        schema: r.schema,
        oldSchema: r.oldSchema,
      })
    } catch (e) {
      await cleanup()
      console.error(`${TAG} 本地恢复失败:`, e)
      res.status(500).json({ success: false, error: e.message || '本地恢复失败' })
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
