// testResultRoutes.js — 浏览器测试报告模块 API（重构版 TR-Rewrite）
//
// 语义对齐检测业务模型（检测计划/风险上报 → 复检 → 合格 → 结案）：
//   TestCase = 用例/问题状态承载体；TestExecution = 追加式执行记录（保留完整复测轨迹）。
//   source=task  后台安排的测试任务（case_key=CASE_DEFS 用例编号，含 guide 执行指引）
//   source=issue 测试人员自发反馈的问题（上报时动态创建，第 1 轮 execution 即反馈本身）
//   当前状态 = 最新一条 TestExecution.result（派生）；收口/修复标记为用例级字段。
//
// 端点（全部 authenticateUser，任意已登录账号可提交/查看——测试场景）：
//   GET  /api/test-results/defs                — 任务用例清单（CASE_DEFS 权威源，前端渲染任务列表）
//   GET  /api/test-results/cases               — 用例/问题列表 + 当前状态（task+issue 统一展示）
//   GET  /api/test-results/cases/:id/history    — 单用例完整复测轨迹（时间线）
//   POST /api/test-results/executions           — 提交一次执行（追加式，永不覆盖；自动创建 issue 用例）
//   POST /api/test-results/cases/close          — 收口/打开（用例级，批量）
//   POST /api/test-results/cases/mark-fixed     — 标记已修复·待复测（开发打标）
//   GET  /api/test-results/summary              — 实时汇总（分组×状态 + 来源×状态）
//   GET  /api/test-results/me                    — 当前登录账号信息
//   POST /api/test-results/upload                — 上传证据图片（base64 JSON，沿用现有机制）
//   GET  /api/test-results/evidence/:caseId/:file — 读取证据图片（防穿越，沿用现有机制）
//
// 舍弃：旧 upsert 模式（TestExecution 追加保留轨迹）、testReportSync 自动同步、build-static 重建、
//      /sync /close-by-case_id 多行 hack、/list 旧列表接口。归档改显式 /export（后续实现）。

import express from 'express'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'
import { CASE_DEFS, RESULT_OPTIONS } from '../lib/testCaseDefs.js'
import { fileURLToPath } from 'node:url'

// 证据存储目录（与旧 EVIDENCE_STORE_DIR 路径一致，避免已有证据丢失）
const EVIDENCE_STORE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads', 'test-evidence')

const VALID_RESULTS = new Set(['passed', 'failed', 'skipped'])
const VALID_GROUPS = new Set(CASE_DEFS.map((g) => g.group))

// 图片上传白名单：mime → 扩展名
const ALLOWED_IMAGE_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_FILES_PER_REQ = 8

// CASE_DEFS 扁平索引：case_key → { group, title, guide }
const CASE_INDEX = new Map()
for (const g of CASE_DEFS) {
    for (const c of g.cases) {
        if (!c.serverOnly) CASE_INDEX.set(c.id, { group: g.group, groupName: g.groupName, title: c.title, guide: c.guide || '' })
    }
}

/**
 * 派生用例当前状态：最新一条 execution 的 result；无 execution 视为 pending。
 * @param {string} caseId TestCase.id
 */
async function deriveLatestState(prisma, caseId) {
    const latest = await prisma.testExecution.findFirst({
        where: { case_id: caseId },
        orderBy: [{ round: 'desc' }, { executed_at: 'desc' }],
        select: { result: true, tester_name: true, executed_at: true, detail: true },
    })
    return latest
        ? { result: latest.result, testerName: latest.tester_name, executedAt: latest.executed_at, detail: latest.detail }
        : { result: 'pending', testerName: null, executedAt: null, detail: null }
}

export function createTestResultRoutes(userManager, prisma) {
    const router = express.Router()
    const { authenticateUser } = createAuthMiddleware(userManager, prisma)
    router.use(authenticateUser)

    // ── GET /api/test-results/defs — 任务用例清单（CASE_DEFS 权威源，不含 serverOnly）──
    router.get('/defs', async (req, res) => {
        try {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
            res.setHeader('Pragma', 'no-cache')
            const browserDefs = CASE_DEFS
                .map((g) => ({ ...g, cases: g.cases.filter((c) => !c.serverOnly) }))
                .filter((g) => g.cases.length > 0)
            res.json({ success: true, data: browserDefs, result_options: RESULT_OPTIONS })
        } catch (e) {
            console.error('[testResultRoutes] defs 失败:', e)
            res.status(500).json({ success: false, error: '获取用例清单失败' })
        }
    })

    // ── GET /api/test-results/me — 当前登录账号信息 ──
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

    // ── GET /api/test-results/cases — 用例/问题列表 + 当前状态（task+issue 统一）──
    // 查询参数：source=task|issue、group=分组、result=状态、tester=测试人、keyword=标题关键词
    router.get('/cases', async (req, res) => {
        try {
            const { source, group, result, tester, keyword } = req.query
            const where = {}
            if (source) where.source = source
            if (group) where.group = group
            if (tester) where.reported_by = tester // issue 的反馈人；task 没有 reported_by
            if (keyword) where.title = { contains: String(keyword) }

            const cases = await prisma.testCase.findMany({
                where,
                orderBy: [{ closed: 'asc' }, { updated_at: 'desc' }],
                take: 500,
            })

            // 派生每个用例的最新状态 + 收集 case_id 集合用于批量查最新 execution
            const caseIds = cases.map((c) => c.id)
            const latestExecs = caseIds.length
                ? await prisma.$queryRawUnsafe(`
                    SELECT DISTINCT ON (case_id) case_id, result, tester_name, executed_at, round, detail
                    FROM "TestExecution"
                    WHERE case_id IN (${caseIds.map((_, i) => `$${i + 1}`).join(',')})
                    ORDER BY case_id, round DESC, executed_at DESC
                `, ...caseIds)
                : []
            const latestMap = new Map(latestExecs.map((e) => [e.case_id, e]))

            // round 数（复测轮次）
            const roundCounts = caseIds.length
                ? await prisma.testExecution.groupBy({
                    by: ['case_id'],
                    where: { case_id: { in: caseIds } },
                    _count: { _all: true },
                })
                : []
            const roundMap = new Map(roundCounts.map((r) => [r.case_id, r._count._all]))

            const data = cases.map((c) => {
                const latest = latestMap.get(c.id)
                const curResult = latest?.result || 'pending'
                // result 筛选（派生状态不能在 SQL where 里过滤，需后置）
                if (result && curResult !== result) return null
                return {
                    id: c.id,
                    case_key: c.case_key,
                    source: c.source,
                    group: c.group,
                    title: c.title,
                    guide: c.guide,
                    reported_by: c.reported_by,
                    reported_at: c.reported_at,
                    fixed_pending_retest: c.fixed_pending_retest,
                    fixed_note: c.fixed_note,
                    closed: c.closed,
                    closed_by: c.closed_by,
                    closed_at: c.closed_at,
                    current_result: curResult,
                    current_tester: latest?.tester_name || null,
                    last_executed_at: latest?.executed_at || null,
                    last_detail: latest?.detail || null,
                    rounds: roundMap.get(c.id) || 0,
                    created_at: c.created_at,
                    updated_at: c.updated_at,
                }
            }).filter(Boolean)

            res.json({ success: true, data })
        } catch (e) {
            console.error('[testResultRoutes] cases 失败:', e)
            res.status(500).json({ success: false, error: '获取用例列表失败' })
        }
    })

    // ── GET /api/test-results/cases/:id/history — 单用例完整复测轨迹（时间线）──
    router.get('/cases/:id/history', async (req, res) => {
        try {
            const caseId = String(req.params.id || '')
            if (!caseId) return res.status(400).json({ success: false, error: 'id 必填' })
            const tc = await prisma.testCase.findUnique({ where: { id: caseId } })
            if (!tc) return res.status(404).json({ success: false, error: '用例不存在' })
            const executions = await prisma.testExecution.findMany({
                where: { case_id: caseId },
                orderBy: [{ round: 'asc' }, { executed_at: 'asc' }],
            })
            res.json({ success: true, data: { case: tc, executions } })
        } catch (e) {
            console.error('[testResultRoutes] history 失败:', e)
            res.status(500).json({ success: false, error: '获取轨迹失败' })
        }
    })

    // ── POST /api/test-results/executions — 提交一次执行（追加式）──
    // body: { case_key?, result, detail?, evidence?, tester_name }
    //   - 任务用例：传 case_key（来自 CASE_DEFS），后端按 case_key 找/建 TestCase
    //   - 新问题反馈：不传 case_key，传 title + group=new_问题反馈；后端建 issue 用例
    //   - 复测既有 issue：传 case_key（ISS-xxx）
    router.post('/executions', express.json({ limit: process.env.BODY_LIMIT || '8mb' }), async (req, res) => {
        try {
            const body = req.body || {}
            const result = String(body.result || '').toLowerCase()
            if (!VALID_RESULTS.has(result)) {
                return res.status(400).json({ success: false, error: 'result 必须为 passed/failed/skipped' })
            }
            const testerName = String(body.tester_name || '').trim().slice(0, 50)
            if (!testerName) return res.status(400).json({ success: false, error: '测试人员姓名必填' })
            const detail = String(body.detail || '').slice(0, 2000)
            const evidence = String(body.evidence || '').slice(0, 5000) // JSON 数组字符串
            const username = req.user?.username || 'unknown'
            const testerRole = `${req.user?.role || ''}@${username}`

            let caseKey = String(body.case_key || '').trim()
            let tc

            if (caseKey) {
                // 既有用例（task 或 issue）：按 case_key 查找
                tc = await prisma.testCase.findUnique({ where: { case_key: caseKey } })
                if (!tc) {
                    // case_key 来自 CASE_DEFS 但尚未建 TestCase → 自动建（任务用例）
                    const def = CASE_INDEX.get(caseKey)
                    if (!def) return res.status(400).json({ success: false, error: `未知的用例编号: ${caseKey}` })
                    tc = await prisma.testCase.create({
                        data: {
                            case_key: caseKey,
                            source: 'task',
                            group: def.group,
                            title: def.title,
                            guide: def.guide,
                        },
                    })
                }
            } else {
                // 新问题反馈：必传 title
                const title = String(body.title || '').trim().slice(0, 200)
                if (!title) return res.status(400).json({ success: false, error: '新问题反馈需提供标题' })
                const group = String(body.group || 'new_问题反馈').trim()
                // 生成 ISS-xxx 编号
                const count = await prisma.testCase.count({ where: { source: 'issue' } })
                caseKey = `ISS-${String(count + 1).padStart(3, '0')}`
                tc = await prisma.testCase.create({
                    data: {
                        case_key: caseKey,
                        source: 'issue',
                        group,
                        title,
                        reported_by: testerName,
                        reported_at: new Date(),
                    },
                })
            }

            // 收口守卫
            if (tc.closed) {
                return res.status(409).json({
                    success: false,
                    error: `该用例已被 ${tc.closed_by || ''} 收口，需先打开后再继续测试`,
                })
            }

            // round 自增（同 case 内）
            const maxRound = await prisma.testExecution.aggregate({
                where: { case_id: tc.id },
                _max: { round: true },
            })
            const round = (maxRound._max.round || 0) + 1

            const execution = await prisma.testExecution.create({
                data: {
                    case_id: tc.id,
                    round,
                    result,
                    detail: detail || null,
                    evidence: evidence || null,
                    tester_name: testerName,
                    tester_role: testerRole,
                },
            })

            // 通过后自动清除"待复测"标记（修复后复测通过 → 标记自然消除）
            if (result === 'passed' && tc.fixed_pending_retest) {
                await prisma.testCase.update({
                    where: { id: tc.id },
                    data: { fixed_pending_retest: false, fixed_note: null, updated_at: new Date() },
                })
            }

            res.json({ success: true, data: { execution, case: { id: tc.id, case_key: tc.case_key } } })
        } catch (e) {
            console.error('[testResultRoutes] 提交执行失败:', e)
            res.status(500).json({ success: false, error: '提交失败：' + e.message })
        }
    })

    // ── POST /api/test-results/cases/close — 收口/打开（用例级，批量）──
    // body: { case_ids: string[], closed: boolean }
    router.post('/cases/close', express.json({ limit: '32kb' }), async (req, res) => {
        try {
            const { case_ids, closed } = req.body || {}
            if (!Array.isArray(case_ids) || case_ids.length === 0) {
                return res.status(400).json({ success: false, error: 'case_ids 必填且为非空数组' })
            }
            if (typeof closed !== 'boolean') {
                return res.status(400).json({ success: false, error: 'closed 必填且为布尔值' })
            }
            const ids = case_ids.slice(0, 100).map((s) => String(s).trim()).filter(Boolean)
            if (!ids.length) return res.status(400).json({ success: false, error: 'case_ids 全为空' })

            const username = req.user?.username || 'unknown'
            const now = new Date()
            const matched = await prisma.testCase.updateMany({
                where: { id: { in: ids } },
                data: closed
                    ? { closed: true, closed_by: username, closed_at: now, updated_at: now }
                    : { closed: false, closed_by: null, closed_at: null, updated_at: now },
            })
            res.json({
                success: true,
                data: { case_ids: ids, closed, matched: matched.count, operator: username, at: now.toISOString() },
            })
        } catch (e) {
            console.error('[testResultRoutes] 收口失败:', e)
            res.status(500).json({ success: false, error: '收口失败：' + e.message })
        }
    })

    // ── POST /api/test-results/cases/mark-fixed — 标记已修复·待复测 ──
    // body: { case_id: string, fixed: boolean, note?: string }
    router.post('/cases/mark-fixed', express.json({ limit: '32kb' }), async (req, res) => {
        try {
            const { case_id, fixed, note } = req.body || {}
            if (!case_id) return res.status(400).json({ success: false, error: 'case_id 必填' })
            if (typeof fixed !== 'boolean') return res.status(400).json({ success: false, error: 'fixed 必填且为布尔值' })
            const username = req.user?.username || 'unknown'
            const now = new Date()
            const updated = await prisma.testCase.updateMany({
                where: { id: String(case_id) },
                data: fixed
                    ? { fixed_pending_retest: true, fixed_note: String(note || '').slice(0, 500) || null, updated_at: now }
                    : { fixed_pending_retest: false, fixed_note: null, updated_at: now },
            })
            if (updated.count === 0) return res.status(404).json({ success: false, error: '用例不存在' })
            res.json({ success: true, data: { case_id, fixed, operator: username, at: now.toISOString() } })
        } catch (e) {
            console.error('[testResultRoutes] mark-fixed 失败:', e)
            res.status(500).json({ success: false, error: '标记失败：' + e.message })
        }
    })

    // ── GET /api/test-results/summary — 实时汇总 ──
    router.get('/summary', async (req, res) => {
        try {
            // 用例总数按 source/group 维度
            const allCases = await prisma.testCase.findMany({
                select: { id: true, source: true, group: true, closed: true, fixed_pending_retest: true },
            })
            // 各 case 最新结果（派生）
            const caseIds = allCases.map((c) => c.id)
            const latestExecs = caseIds.length
                ? await prisma.$queryRawUnsafe(`
                    SELECT DISTINCT ON (case_id) case_id, result
                    FROM "TestExecution"
                    WHERE case_id IN (${caseIds.map((_, i) => `$${i + 1}`).join(',')})
                    ORDER BY case_id, round DESC, executed_at DESC
                `, ...caseIds)
                : []
            const latestMap = new Map(latestExecs.map((e) => [e.case_id, e.result]))

            const summary = {}
            let totals = { total: allCases.length, passed: 0, failed: 0, skipped: 0, pending: 0, closed: 0, fixed_pending: 0 }
            for (const c of allCases) {
                const g = c.group
                if (!summary[g]) summary[g] = { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, closed: 0 }
                summary[g].total += 1
                totals.total // (already set)
                if (c.closed) {
                    summary[g].closed += 1
                    totals.closed += 1
                } else {
                    const r = latestMap.get(c.id) || 'pending'
                    if (summary[g][r] !== undefined) summary[g][r] += 1
                    if (totals[r] !== undefined) totals[r] += 1
                }
                if (c.fixed_pending_retest && !c.closed) totals.fixed_pending += 1
            }
            res.json({ success: true, data: { byGroup: summary, totals } })
        } catch (e) {
            console.error('[testResultRoutes] summary 失败:', e)
            res.status(500).json({ success: false, error: '获取汇总失败' })
        }
    })

    // ── POST /api/test-results/upload — 上传证据图片（base64 JSON，沿用现有机制）──
    router.post('/upload', express.json({ limit: process.env.BODY_LIMIT_UPLOAD || '30mb' }), async (req, res) => {
        try {
            const { case_id, files } = req.body || {}
            if (!case_id || typeof case_id !== 'string' || case_id.length > 80) {
                return res.status(400).json({ success: false, error: 'case_id 必填且不超过 80 字符' })
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

    // ── GET /api/test-results/evidence/:caseId/:file — 读取证据图片（防穿越，沿用现有机制）──
    router.get('/evidence/:caseId/:file', (req, res) => {
        try {
            const decCaseId = decodeURIComponent(req.params.caseId)
            const file = path.basename(String(req.params.file || ''))
            if (!/^[A-Za-z0-9._-]+$/.test(file)) return res.status(400).json({ success: false, error: '非法文件名' })
            if (!decCaseId || decCaseId.length > 80 || /[\/\\]/.test(decCaseId)) {
                return res.status(400).json({ success: false, error: '非法用例标识' })
            }
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
