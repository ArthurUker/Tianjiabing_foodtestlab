// testResultRoutes.js — 浏览器测试结果上报 API（临时测试工具）
//
// 端点（全部 authenticateUser，任意已登录账号可提交/查看——测试场景）：
//   GET  /api/test-results             — 列表（按 case_group / result / submitted_by 筛选 + 分页）
//   POST /api/test-results             — 提交/更新一条用例结果（upsert by case_id + submitted_by）
//   GET  /api/test-results/summary     — 汇总（按 case_group × result 计数，供服务器拉取看效果）
//
// 设计：
//   - 一个测试人员对一个用例保留一条最新结果（upsert），支持复测更新
//   - 任意已登录用户可提交（测试人员用各自账号登录 test-report.html）
//   - 数据落 public."TestResult"（基础 prisma 单例）

import express from 'express'
import { createAuthMiddleware } from '../middleware/authMiddleware.js'

const VALID_RESULTS = new Set(['passed', 'failed', 'skipped', 'pending'])
const VALID_GROUPS = new Set(['wcn_业务', 'zsp_备份'])

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

  // ── GET /api/test-results/summary — 汇总（先注册，避免被 /:id 风格路由吞）──
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
  router.post('/', async (req, res) => {
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
    } catch (e) {
      console.error('[testResultRoutes] 提交失败:', e)
      res.status(500).json({ success: false, error: '提交测试结果失败' })
    }
  })

  return router
}
