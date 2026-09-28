// adminFriendlyLinkRoutes.js — 友情链接管理 API（控制台「友情链接」视图后端，仅平台超管）
//
// 背景（2026-09-28）：登录卡下方「友情链接」原为 frontend/pages/login.html 内硬编码的单条外链
//   （https://foodsafety.digifluidic.com/）。现改由平台超管在此维护：多条 / 排序 / 启停 /
//   一键访问 / 访问计数。登录页读侧为免鉴权只读接口 /api/public/friendly-links（见 publicFriendlyLinkRoutes.js）。
//
// 端点（全部 authenticateUser + requirePlatformSuperAdmin）：
//   GET    /               — 列表（含停用项）+ 汇总（总数 / 启用 / 停用 / 累计访问）
//   POST   /               — 新建（name / url 必填，其余可选；缺省排序值自动追加到末尾）
//   PUT    /:id            — 更新（**merge 语义**：只更新请求体中出现的字段）
//   POST   /reorder        — 重排（{ids:[...]} 按数组顺序重写 sort_order = (i+1)*10）
//   DELETE /:id            — 删除（硬删；平台级配置表，无软删/回收站语义）
//
// 数据：一律用基础 prisma 单例读写 **public**（权威副本），绝不用 req.db（租户副本永不写入）。
// 审计：所有变更写 writeAdminOpsLog（public.SystemLog，[admin-audit] 前缀），与磁盘/开放接口一致。
// 校验：字段口径与安全规则见 lib/friendlyLinks.js（读写两侧唯一事实源）。

import express from 'express'
import { writeAdminOpsLog } from '../lib/auditLog.js'
import {
  FRIENDLY_LINK_MAX,
  friendlyLinkOrderBy,
  isValidFriendlyLinkId,
  nextFriendlyLinkSortOrder,
  normalizeFriendlyLinkFields,
} from '../lib/friendlyLinks.js'

const TAG = '[adminFriendlyLinkRoutes]'

export function createAdminFriendlyLinkRoutes({ prisma, authenticateUser, requirePlatformSuperAdmin }) {
  const router = express.Router()
  router.use(authenticateUser, requirePlatformSuperAdmin)

  const actorOf = (req) => ({
    userId: req.user?.userId ?? null,
    username: req.user?.username ?? null,
    role: req.user?.role ?? null,
    schoolCode: null, // 平台级配置：与学校无关
    ip: req.ip,
  })

  const badRequest = (res, message) => res.status(400).json({ success: false, error: message })
  const notFound = (res) => res.status(404).json({ success: false, error: '友情链接不存在（可能已被删除）' })

  /** 列表 + 汇总（管理台首屏一次取全量，条数受 FRIENDLY_LINK_MAX 约束，无需分页）。 */
  router.get('/', async (req, res) => {
    try {
      const items = await prisma.friendlyLink.findMany({ orderBy: friendlyLinkOrderBy() })
      const summary = {
        total: items.length,
        enabled: items.filter((i) => i.status === 'enabled').length,
        disabled: items.filter((i) => i.status === 'disabled').length,
        visits: items.reduce((a, i) => a + (Number(i.visit_count) || 0), 0),
        max: FRIENDLY_LINK_MAX,
      }
      res.json({ success: true, data: { items, summary } })
    } catch (e) {
      console.error(`${TAG} 查询友情链接失败:`, e)
      res.status(500).json({ success: false, error: `查询友情链接失败：${e.message}` })
    }
  })

  /** 新建。 */
  router.post('/', async (req, res) => {
    try {
      const { ok, errors, value } = normalizeFriendlyLinkFields(req.body, { requireCore: true })
      if (!ok) return badRequest(res, errors.join('；'))

      const count = await prisma.friendlyLink.count()
      if (count >= FRIENDLY_LINK_MAX) return badRequest(res, `友情链接数量已达上限（${FRIENDLY_LINK_MAX} 条），请先删除或合并`)

      if (value.sort_order === undefined) {
        const last = await prisma.friendlyLink.findFirst({ orderBy: { sort_order: 'desc' }, select: { sort_order: true } })
        value.sort_order = nextFriendlyLinkSortOrder(last?.sort_order)
      }
      if (value.status === undefined) value.status = 'enabled'

      const created = await prisma.friendlyLink.create({
        data: { ...value, created_by: req.user?.userId || req.user?.username || null },
      })
      await writeAdminOpsLog(prisma, {
        action: 'friendly_link.create', actor: actorOf(req), targetId: created.id, targetSchoolCode: null,
        details: { name: created.name, url: created.url, status: created.status, sort_order: created.sort_order }, level: 'warn',
      })
      res.json({ success: true, data: created })
    } catch (e) {
      console.error(`${TAG} 新建友情链接失败:`, e)
      res.status(500).json({ success: false, error: `新建友情链接失败：${e.message}` })
    }
  })

  /** 重排：按 ids 数组顺序重写 sort_order（多事务原子；ids 必须全部存在）。 */
  router.post('/reorder', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids : null
      if (!ids || !ids.length) return badRequest(res, '缺少 ids 数组（按目标顺序排列的链接 id）')
      if (ids.length > FRIENDLY_LINK_MAX) return badRequest(res, `一次最多重排 ${FRIENDLY_LINK_MAX} 条`)
      if (!ids.every(isValidFriendlyLinkId)) return badRequest(res, 'ids 含非法 id')
      if (new Set(ids).size !== ids.length) return badRequest(res, 'ids 含重复项')

      const found = await prisma.friendlyLink.findMany({ where: { id: { in: ids } }, select: { id: true } })
      if (found.length !== ids.length) {
        const known = new Set(found.map((f) => f.id))
        return badRequest(res, `部分链接不存在或已被删除：${ids.filter((i) => !known.has(i)).join(', ')}`)
      }

      await prisma.$transaction(ids.map((id, i) => prisma.friendlyLink.update({ where: { id }, data: { sort_order: (i + 1) * 10 } })))
      await writeAdminOpsLog(prisma, {
        action: 'friendly_link.reorder', actor: actorOf(req), targetId: '', targetSchoolCode: null,
        details: { count: ids.length, order: ids }, level: 'warn',
      })
      res.json({ success: true, data: { count: ids.length } })
    } catch (e) {
      console.error(`${TAG} 重排友情链接失败:`, e)
      res.status(500).json({ success: false, error: `重排失败：${e.message}` })
    }
  })

  /** 更新（merge 语义：只处理请求体中出现的字段）。 */
  router.put('/:id', async (req, res) => {
    try {
      const { id } = req.params
      if (!isValidFriendlyLinkId(id)) return notFound(res)
      const existing = await prisma.friendlyLink.findUnique({ where: { id } })
      if (!existing) return notFound(res)

      const { ok, errors, value } = normalizeFriendlyLinkFields(req.body, { requireCore: false })
      if (!ok) return badRequest(res, errors.join('；'))
      if (!Object.keys(value).length) return badRequest(res, '没有需要更新的字段')

      const updated = await prisma.friendlyLink.update({ where: { id }, data: value })
      await writeAdminOpsLog(prisma, {
        action: 'friendly_link.update', actor: actorOf(req), targetId: id, targetSchoolCode: null,
        details: {
          name: updated.name,
          changed: Object.keys(value),
          before: { name: existing.name, url: existing.url, status: existing.status, sort_order: existing.sort_order },
          after: { name: updated.name, url: updated.url, status: updated.status, sort_order: updated.sort_order },
        },
        level: 'warn',
      })
      res.json({ success: true, data: updated })
    } catch (e) {
      console.error(`${TAG} 更新友情链接失败:`, e)
      res.status(500).json({ success: false, error: `更新友情链接失败：${e.message}` })
    }
  })

  /** 删除（硬删；审计保留被删名称/地址快照，便于事后追溯）。 */
  router.delete('/:id', async (req, res) => {
    try {
      const { id } = req.params
      if (!isValidFriendlyLinkId(id)) return notFound(res)
      const existing = await prisma.friendlyLink.findUnique({ where: { id } })
      if (!existing) return notFound(res)

      await prisma.friendlyLink.delete({ where: { id } })
      await writeAdminOpsLog(prisma, {
        action: 'friendly_link.delete', actor: actorOf(req), targetId: id, targetSchoolCode: null,
        details: { name: existing.name, url: existing.url, status: existing.status, visit_count: existing.visit_count }, level: 'warn',
      })
      res.json({ success: true, data: { id } })
    } catch (e) {
      console.error(`${TAG} 删除友情链接失败:`, e)
      res.status(500).json({ success: false, error: `删除友情链接失败：${e.message}` })
    }
  })

  return router
}

export default { createAdminFriendlyLinkRoutes }
