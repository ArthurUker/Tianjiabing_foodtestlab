// testResultRoutes.js — 浏览器测试结果上报 API（临时测试工具）
//
// 端点（全部 authenticateUser，任意已登录账号可提交/查看——测试场景）：
//   GET  /api/test-results/defs                — 用例清单（CASE_DEFS 单一权威副本，供前端渲染）
//   GET  /api/test-results                     — 列表（按 case_group / result / submitted_by 筛选 + 分页）
//   POST /api/test-results                     — 提交/更新一条用例结果（upsert by case_id + submitted_by）
//   POST /api/test-results/upload              — 上传证据图片（base64 JSON，无 multipart 依赖）
//   GET  /api/test-results/evidence/:caseId/:file — 读取已上传的证据图片（走 /api 反代，无需改 Caddy）
//   GET  /api/test-results/summary             — 汇总（按 case_group × result 计数，供服务器拉取看效果）
//
// 设计：
//   - 一个测试人员对一个用例保留一条最新结果（upsert），支持复测更新
//   - 任意已登录用户可提交（测试人员用各自账号登录 test-report.html）
//   - 数据落 public."TestResult"（基础 prisma 单例）
//   - 保存成功后自动把结果整理同步到 docs/test-results/latest/（可用 TEST_REPORT_DOCS_SYNC=false 关闭）

import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'
import { CASE_DEFS, RESULT_OPTIONS } from '../lib/testCaseDefs.js'
import { syncTestResultDocs, EVIDENCE_STORE_DIR } from '../lib/testReportSync.js'

const VALID_RESULTS = new Set(['passed', 'failed', 'skipped', 'pending'])
const VALID_GROUPS = new Set(CASE_DEFS.map((g) => g.group))

// 图片上传白名单：mime → 扩展名
const ALLOWED_IMAGE_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const MAX_FILE_BYTES = 5 * 1024 * 1024 // 单张 ≤ 5MB（解码后）
const MAX_FILES_PER_REQ = 8 // 单次 ≤ 8 张

export function createTestResultRoutes(userManager, prisma) {
  const router = express.Router()
  const { authenticateUser } = createAuthMiddleware(userManager, prisma)
  router.use(authenticateUser)

  // 字段白名单校验（防脏数据）
  function sanitizeBody(body) {
    const { case_id, case_group, case_title, result, detail, evidence } = body || {}
    if (!case_id || typeof case_id !== 'string' || case_id.length > 50) return { error: 'case_id 必填且不超过 50 字符' }
    if (!VALID_GROUPS.has(case_group)) return { error: `case_group 必须为 ${[...VALID_GROUPS].join(' / ')}` }
    if (!VALID_RESULTS.has(result)) return { error: 'result 必须为 passed/failed/skipped/pending' }
    const clean = (s, max) => (s == null ? '' : String(s)).slice(0, max)
    return {
      data: {
        case_id: clean(case_id, 50),
        case_group,
        case_title: clean(case_title, 200),
        result,
        detail: clean(detail, 2000),
        evidence: clean(evidence, 5000),
      },
    }
  }

  // 保存成功后自动同步 docs 报告（fire-and-forget，不阻塞响应）
  function scheduleDocsSync() {
    if (process.env.TEST_REPORT_DOCS_SYNC === 'false') return
    syncTestResultDocs({ prisma }).catch((e) => {
      console.error('[testResultRoutes] docs 报告同步失败:', e?.message || e)
    })
  }

  // ── GET /api/test-results/defs — 用例清单（放最前，避免被 /:xxx 风格路由吞）──
  router.get('/defs', (req, res) => {
    res.json({ success: true, data: CASE_DEFS, result_options: RESULT_OPTIONS })
  })

  // ── GET /api/test-results/summary — 汇总 ──
  router.get('/summary', async (req, res) => {
    try {
      const groups = await prisma.testResult.groupBy({
        by: ['case_group', 'result'],
        _count: { id: true },
      })
      // 按负责人分组组织
      const summary = {}
      for (const g of groups) {
        if (!summary[g.case_group]) summary[g.case_group] = { passed: 0, failed: 0, skipped: 0, pending: 0 }
        summary[g.case_group][g.result] = g._count.id
      }
      res.json({ success: true, data: summary })
    } catch (e) {
      console.error('[testResultRoutes] summary 失败:', e)
      res.status(500).json({ success: false, error: '获取汇总失败' })
    }
  })

  // ── GET /api/test-results — 列表 ──
  router.get('/', async (req, res) => {
    try {
      const { case_group, result, submitted_by, page = '1', pageSize = '200' } = req.query
      const take = Math.min(Math.max(Number(pageSize) || 200, 1), 500)
      const skip = (Math.max(Number(page) || 1, 1) - 1) * take
      const where = {}
      if (case_group) where.case_group = case_group
      if (result) where.result = result
      if (submitted_by) where.submitted_by = submitted_by

      const [total, items] = await Promise.all([
        prisma.testResult.count({ where }),
        prisma.testResult.findMany({ where, orderBy: { created_at: 'desc' }, skip, take }),
      ])
      res.json({ success: true, data: items, total })
    } catch (e) {
      console.error('[testResultRoutes] 列表失败:', e)
      res.status(500).json({ success: false, error: '获取测试结果失败' })
    }
  })

  // ── POST /api/test-results — 提交/更新（upsert by case_id + submitted_by）──
  router.post('/', express.json({ limit: process.env.BODY_LIMIT || '8mb' }), async (req, res) => {
    try {
      const { error, data } = sanitizeBody(req.body)
      if (error) return res.status(400).json({ success: false, error })
      const username = req.user?.username || 'unknown'
      // 一个测试人员对一个用例只保留一条最新结果（复测更新）
      const existing = await prisma.testResult.findFirst({
        where: { case_id: data.case_id, submitted_by: username },
      })
      const record = existing
        ? await prisma.testResult.update({
            where: { id: existing.id },
            data: { ...data, updated_at: new Date() },
          })
        : await prisma.testResult.create({
            data: { ...data, submitted_by: username, submitted_by_role: req.user?.role || null },
          })
      res.json({ success: true, data: record })
      scheduleDocsSync() // 提交成功 → 后台同步 docs 报告
    } catch (e) {
      console.error('[testResultRoutes] 提交失败:', e)
      res.status(500).json({ success: false, error: '提交测试结果失败' })
    }
  })

  // ── POST /api/test-results/upload — 上传证据图片（base64 JSON，避免引入 multipart 依赖）──
  router.post('/upload', express.json({ limit: process.env.BODY_LIMIT || '30mb' }), async (req, res) => {
    try {
      const { case_id, files } = req.body || {}
      if (!case_id || typeof case_id !== 'string' || case_id.length > 50) {
        return res.status(400).json({ success: false, error: 'case_id 必填且不超过 50 字符' })
      }
      if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_REQ) {
        return res.status(400).json({ success: false, error: `files 需为 1~${MAX_FILES_PER_REQ} 个元素的数组` })
      }

      const urls = []
      for (const f of files) {
        const mime = String(f?.type || '').toLowerCase()
        const ext = ALLOWED_IMAGE_MIME[mime]
        if (!ext) return res.status(400).json({ success: false, error: `不支持的文件类型: ${mime || '未知'}` })
        const buf = Buffer.from(String(f?.data || ''), 'base64')
        if (buf.length === 0) return res.status(400).json({ success: false, error: '图片数据为空' })
        if (buf.length > MAX_FILE_BYTES) {
          return res.status(400).json({ success: false, error: `单张图片不能超过 ${MAX_FILE_BYTES / 1024 / 1024}MB` })
        }
        const encCaseId = encodeURIComponent(case_id)
        const dir = path.join(EVIDENCE_STORE_DIR, encCaseId)
        fs.mkdirSync(dir, { recursive: true })
        const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`
        fs.writeFileSync(path.join(dir, filename), buf)
        urls.push(`/api/test-results/evidence/${encCaseId}/${filename}`)
      }
      res.json({ success: true, urls })
    } catch (e) {
      console.error('[testResultRoutes] 图片上传失败:', e)
      res.status(500).json({ success: false, error: '图片上传失败' })
    }
  })

  // ── GET /api/test-results/evidence/:caseId/:file — 读取证据图片（sendFile 防路径穿越）──
  router.get('/evidence/:caseId/:file', (req, res) => {
    try {
      const decCaseId = decodeURIComponent(req.params.caseId)
      // 只取 basename + 白名单字符，杜绝 ../ 穿越
      const file = path.basename(String(req.params.file || ''))
      if (!/^[A-Za-z0-9._-]+$/.test(file)) return res.status(400).json({ success: false, error: '非法文件名' })
      if (!/^[A-Za-z0-9_\-.]{1,80}$/.test(decCaseId)) return res.status(400).json({ success: false, error: '非法用例标识' })
      const abs = path.join(EVIDENCE_STORE_DIR, decCaseId, file)
      if (!abs.startsWith(path.join(EVIDENCE_STORE_DIR, decCaseId))) {
        return res.status(400).json({ success: false, error: '非法路径' })
      }
      if (!fs.existsSync(abs)) return res.status(404).json({ success: false, error: '证据文件不存在' })
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.sendFile(abs)
    } catch (e) {
      console.error('[testResultRoutes] 证据读取失败:', e)
      res.status(500).json({ success: false, error: '证据读取失败' })
    }
  })

  return router
}
