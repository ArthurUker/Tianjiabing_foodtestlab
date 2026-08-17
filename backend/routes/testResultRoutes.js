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
import { execFile } from 'node:child_process'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'
import { CASE_DEFS, RESULT_OPTIONS } from '../lib/testCaseDefs.js'
import { syncTestResultDocs, EVIDENCE_STORE_DIR, PROJECT_ROOT } from '../lib/testReportSync.js'

const VALID_RESULTS = new Set(['passed', 'failed', 'skipped', 'pending'])
// 合法用例组：CASE_DEFS 定义的分组 + 前端"新问题反馈"专用组（清单外新问题/缺陷上报）
const VALID_GROUPS = new Set([...CASE_DEFS.map((g) => g.group), 'new_问题'])

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
    const { case_id, case_group, case_title, result, detail, evidence, tester_name } = body || {}
    if (!case_id || typeof case_id !== 'string' || case_id.length > 50) return { error: 'case_id 必填且不超过 50 字符' }
    if (!VALID_GROUPS.has(case_group)) return { error: `case_group 必须为 ${[...VALID_GROUPS].join(' / ')}` }
    if (!VALID_RESULTS.has(result)) return { error: 'result 必须为 passed/failed/skipped/pending' }
    const clean = (s, max) => (s == null ? '' : String(s)).slice(0, max)
    // TD-TesterNameRequired: 测试人员姓名必填，作为提交人标识。
    // 空则拦截，避免回退成登录账号，防止「账号名/姓名」混用导致同一人被拆成多条记录。
    const testerName = clean(tester_name, 50).trim()
    if (!testerName) return { error: '测试人员姓名必填，请先填写后再保存' }
    return {
      data: {
        case_id: clean(case_id, 50),
        case_group,
        case_title: clean(case_title, 200),
        result,
        detail: clean(detail, 2000),
        evidence: clean(evidence, 5000),
        tester_name: testerName,
      },
    }
  }

  // TD-CloseGuard: 该 case_id（任意提交人维度）已被收口 → 拒绝任何 POST 更新，
  // 避免「绕过汇总页收口按钮偷偷改结果」。汇总页可重新打开后才会放行。
  async function assertNotClosed(caseId) {
    const closed = await prisma.testResult.findFirst({
      where: { case_id: caseId, closed: true },
      select: { id: true, submitted_by: true, closed_at: true, closed_by: true },
    })
    return closed
  }

  // 同步 docs 报告 + 重建 dist（让 Caddy 立即生效）。
  // 复用同一把 syncing 锁，避免并发提交多次清空重建 dist。
  let syncing = false
  async function runSyncAndBuild() {
    if (process.env.TEST_REPORT_DOCS_SYNC === 'false') return { skipped: true }
    if (syncing) return { skipped: true, reason: '同步进行中' }
    syncing = true
    try {
      // 1) 重新生成 docs/test-results/latest/（snapshot.json / REPORT.md / index.html / 证据副本）
      const docs = await syncTestResultDocs({ prisma })
      // 2) 重建 dist/（把最新报告同步进 Caddy 服务的部署目录，否则网页看到的是旧副本）
      // TD-SyncFix: 项目根必须用 PROJECT_ROOT（原 path.resolve(EVIDENCE_STORE_DIR, '../..')
      // 只上两级算成了 backend/，导致 build-static.js 路径错误 → fs.existsSync 恒 false →
      // dist 永远不重建，Caddy 服务的 dist 里始终是旧报告。同时 ESM 不能用 require()，改 import execFile。
      const rootDir = PROJECT_ROOT
      const buildScript = path.join(rootDir, 'scripts', 'build-static.js')
      let distOk = true
      let distErr = ''
      if (fs.existsSync(buildScript)) {
        try {
          await new Promise((resolve, reject) => {
            const cp = execFile(
              process.execPath, [buildScript],
              { cwd: rootDir, timeout: 120000 },
              (err) => {
                if (err) reject(new Error(err.message))
                else resolve()
              }
            )
            if (cp && cp.stderr) cp.stderr.on('data', (d) => { if (String(d).trim()) console.error('[testResultRoutes] build-static stderr:', String(d).trim()) })
          })
        } catch (e) {
          distOk = false
          distErr = e.message
        }
      }
      return { skipped: false, docs, distOk, distErr }
    } finally {
      syncing = false
    }
  }

  // 保存成功后自动同步 docs 报告并重建 dist（fire-and-forget，不阻塞响应）
  function scheduleDocsSync() {
    if (process.env.TEST_REPORT_DOCS_SYNC === 'false') return
    runSyncAndBuild().catch((e) => {
      console.error('[testResultRoutes] 同步+构建失败:', e?.message || e)
    })
  }

  // ── GET /api/test-results/defs — 用例清单（放最前，避免被 /:xxx 风格路由吞）──
  // TD-DefsNoCache: 用例清单会被前端动态渲染，禁止浏览器缓存（否则开发更新用例后
  // 测试人员看不到新分组/新用例，误以为"没更新"）。
  router.get('/defs', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      // TD-CloseList: 同步返回【已收口 case_id 集合】（任一提交人已收口即整组收口），
      // 上报页据此把对应用例折叠到"已完成"区、不再可继续测试。
      const closedRows = await prisma.testResult.findMany({
        where: { closed: true },
        select: { case_id: true, closed_by: true, closed_at: true, submitted_by: true },
      })
      // 按 case_id 聚合：保留最早收口记录（first），便于前端展示收口人/时间
      const closedMap = new Map()
      for (const r of closedRows) {
        if (!closedMap.has(r.case_id)) {
          closedMap.set(r.case_id, {
            case_id: r.case_id,
            closed_by: r.closed_by,
            closed_at: r.closed_at,
            by_submitter: r.submitted_by,
          })
        }
      }
      // TD-ServerOnly: 需连接服务器执行的用例（serverOnly=true，如 B7-旧schema/B8/B9）
      // 从浏览器上报清单过滤，不再显示在 test-report.html——已移出到
      // docs/测试执行-服务器侧-<日期>.md，由开发通过 VS Code 连接服务器执行。
      const browserDefs = CASE_DEFS
        .map((g) => ({ ...g, cases: g.cases.filter((c) => !c.serverOnly) }))
        .filter((g) => g.cases.length > 0)
      res.json({
        success: true,
        data: browserDefs,
        result_options: RESULT_OPTIONS,
        closed_case_ids: [...closedMap.values()],
      })
    } catch (e) {
      console.error('[testResultRoutes] defs 失败:', e)
      res.status(500).json({ success: false, error: '获取用例清单失败' })
    }
  })

  // ── GET /api/test-results/me — 当前登录用户信息（供汇总页等静态页面显示）──
  router.get('/me', (req, res) => {
    const user = req.user || {}
    res.json({
      success: true,
      data: {
        userId: user.userId || user.id || null,
        username: user.username || null,
        role: user.role || null,
        schoolCode: user.schoolCode || null,
      },
    })
  })

  // ── GET /api/test-results/summary — 汇总 ──
  router.get('/summary', async (req, res) => {
    try {
      // TD-SummaryDedupe: 每个 case_id 按 case_group + case_id 分组时只算一次（取最新一次提交）。
      // 修复前 bug：groupBy 直接累加所有 TestResult 行，同一 case 多次更新会让汇总数 > 用例总数
      // （如吴翠楠 17 项却显示 37）。修复后：每个 case 只计 1 次，按其最新 result 判定。
      // TD-SummaryClosed: 同步返回 closed 计数，供前端把"已收口"用例从分子（问题项/result 计数）中移除；
      // 分母（total = 用例总数）保持不变。
      const latestPerCase = await prisma.$queryRawUnsafe(`
        SELECT case_group, result, closed FROM (
          SELECT case_group, case_id, result, closed,
            ROW_NUMBER() OVER (PARTITION BY case_group, case_id ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST) AS rn
          FROM "TestResult"
        ) t WHERE rn = 1
      `)
      const summary = {}
      for (const row of latestPerCase) {
        const g = row.case_group
        const r = row.result
        if (!summary[g]) summary[g] = { passed: 0, failed: 0, skipped: 0, pending: 0, closed: 0 }
        if (row.closed) summary[g].closed += 1
        else if (summary[g][r] !== undefined) summary[g][r] += 1
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
      // TD-CloseGuard: 收口守卫 —— 该 case_id 任一提交人已收口则拒绝更新
      const closed = await assertNotClosed(data.case_id)
      if (closed) {
        return res.status(409).json({
          success: false,
          error: `该用例已被 ${closed.closed_by || closed.submitted_by} 收口（${closed.closed_at ? new Date(closed.closed_at).toISOString() : ''}），需先在汇总报告页打开后再继续测试`,
        })
      }
      const username = req.user?.username || 'unknown'
      // tester_name 仅用于区分提交人，不是 TestResult 表字段，写入前剥离
      const testerName = (data.tester_name || '').trim()
      delete data.tester_name
      // 提交人标识 = 前端填的测试人员姓名（已在 sanitizeBody 强制必填）
      const submittedBy = testerName
      // 真实账号追溯：submitted_by_role 记录「角色@账号」
      const roleDesc = `${req.user?.role || ''}@${username}`.trim()
      // 一个测试人员对一个用例只保留一条最新结果（复测更新）——按 姓名/账号 维度 upsert
      const existing = await prisma.testResult.findFirst({
        where: { case_id: data.case_id, submitted_by: submittedBy },
      })
      const record = existing
        ? await prisma.testResult.update({
            where: { id: existing.id },
            data: { ...data, submitted_by: submittedBy, submitted_by_role: roleDesc, updated_at: new Date() },
          })
        : await prisma.testResult.create({
            data: { ...data, submitted_by: submittedBy, submitted_by_role: roleDesc },
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
        // 磁盘目录统一用【原始中文 case_id】（与 relPath / GET 读取解码路径一致，避免 Caddy/Express 解码后找不到）；
        // URL 中仍用 encodeURIComponent 编码形式（浏览器请求时自动编码，服务端解码回中文匹配磁盘目录）。
        const encCaseId = encodeURIComponent(case_id)
        const dir = path.join(EVIDENCE_STORE_DIR, case_id)
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

  // ── POST /api/test-results/close — 收口管理（按 case_id 整组收口）──
  // body: { case_ids: string[], closed: boolean }
  //   - case_ids: 要收口/打开的用例 id 数组（同一 case_id 任一提交人收口即整组收口）
  //   - closed: true=收口 / false=打开
  // 任何已登录用户可操作（收口是测试负责人对任务下结论的协作动作）。
  router.post('/close', express.json({ limit: '32kb' }), async (req, res) => {
    try {
      const { case_ids, closed } = req.body || {}
      if (!Array.isArray(case_ids) || case_ids.length === 0) {
        return res.status(400).json({ success: false, error: 'case_ids 必填且为非空数组' })
      }
      if (typeof closed !== 'boolean') {
        return res.status(400).json({ success: false, error: 'closed 必填且为布尔值（true=收口 / false=打开）' })
      }
      // 限制单次最多 100 个 case，避免误操作大面积影响
      const ids = case_ids.slice(0, 100).map((s) => String(s).trim()).filter(Boolean)
      if (!ids.length) return res.status(400).json({ success: false, error: 'case_ids 全为空' })

      const username = req.user?.username || 'unknown'
      const now = new Date()
      // 收口/打开：通过 case_id 维度更新该用例所有提交人的记录
      // （按业务约定：同一 case_id 收口后任一提交人都不再能测试）
      // TD-CloseKeepUpdatedAt: 改用 $executeRawUnsafe 只更新 closed 相关字段，
      // 避免 Prisma @updatedAt 自动改写 updated_at——否则收口会污染所有记录的
      // updated_at，导致「取最新结果」判定失效（收口后看不到最后真实测试结果）。
      const placeholders = ids.map((_, i) => `$${i + (closed ? 3 : 1)}`).join(', ')
      const matched = closed
        ? await prisma.$executeRawUnsafe(
            `UPDATE "TestResult" SET "closed" = true, "closed_by" = $1, "closed_at" = $2 WHERE "case_id" IN (${placeholders})`,
            username, now, ...ids
          )
        : await prisma.$executeRawUnsafe(
            `UPDATE "TestResult" SET "closed" = false, "closed_by" = NULL, "closed_at" = NULL WHERE "case_id" IN (${placeholders})`,
            ...ids
          )
      res.json({
        success: true,
        data: {
          case_ids: ids,
          closed,
          matched,
          operator: username,
          at: now.toISOString(),
        },
      })
      scheduleDocsSync() // 收口状态变化 → 重新生成报告
    } catch (e) {
      console.error('[testResultRoutes] 收口失败:', e)
      res.status(500).json({ success: false, error: '收口失败：' + e.message })
    }
  })

  // ── POST /api/test-results/sync — 手动重新同步汇总报告并重建 dist（与提交后自动同步同一套逻辑）──
  router.post('/sync', async (req, res) => {
    try {
      const r = await runSyncAndBuild()
      if (r.skipped) {
        return res.json({ success: true, skipped: true, message: r.reason || '同步已跳过（TEST_REPORT_DOCS_SYNC=false 或正在同步）' })
      }
      res.json({
        success: true,
        docs: { generatedAt: r.docs.generatedAt, itemCount: r.docs.itemCount },
        dist: { ok: r.distOk, error: r.distErr || null },
        message: r.distOk ? '同步完成，汇总报告已更新' : 'docs 已更新，但 dist 重建失败：' + r.distErr,
      })
    } catch (e) {
      console.error('[testResultRoutes] 同步失败:', e)
      res.status(500).json({ success: false, error: '同步失败：' + e.message })
    }
  })

  // ── GET /api/test-results/evidence/:caseId/:file — 读取证据图片（sendFile 防路径穿越）──
  router.get('/evidence/:caseId/:file', (req, res) => {
    try {
      const decCaseId = decodeURIComponent(req.params.caseId)
      // 只取 basename + 白名单字符，杜绝 ../ 穿越
      const file = path.basename(String(req.params.file || ''))
      if (!/^[A-Za-z0-9._-]+$/.test(file)) return res.status(400).json({ success: false, error: '非法文件名' })
      // case_id 目录允许中文（Q1-果蔬阶段A / new_问题 等），只拦截空/超长/含路径分隔符的穿越路径
      if (!decCaseId || decCaseId.length > 80 || /[\/\\]/.test(decCaseId)) return res.status(400).json({ success: false, error: '非法用例标识' })
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
