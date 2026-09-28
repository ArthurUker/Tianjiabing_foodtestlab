// publicFriendlyLinkRoutes.js — 友情链接公开只读接口（登录页消费，免鉴权）
//
// 端点（**无凭证**，区别于 /api/admin/friendly-links）：
//   GET  /            — 启用中的友情链接列表（按 sort_order 升序）；供 login.html 渲染
//   POST /:id/visit   — 登录页点击计数（visit_count+1 / last_visit_at=now）；fire-and-forget，无返回体
//
// 安全与容量口径：
//   · 只读投影（lib/friendlyLinks.toPublicFriendlyLink）：不外泄 created_by / status / 计数等管理字段；
//   · URL 在写入侧已强制 http/https 且禁带凭证（lib/friendlyLinks.normalizeFriendlyLinkUrl），
//     本路由不做二次放行，也不做任何跳转（301/302）——**避免开放重定向面**；
//   · 计数端点只对 enabled 且存在的 id 生效，其余一律 204（不区分"不存在/已停用"，避免枚举）；
//   · 两级限流：GET 120 次/分钟/IP，POST 60 次/分钟/IP（超限 429，由上层 rateLimit 中间件给出）；
//   · Cache-Control: no-store —— 超管改配置后刷新即生效，不依赖缓存过期。
//
// ⚠️ 挂载顺序硬约束：必须位于 `app.use('/api', recognitionRoutes)` 之前（该挂载点带全局
//    authenticateUser，会把免鉴权接口一律拦成 401；见 server.js 同段落注释）。
// ⚠️ 租户就绪闸门（tenantReadinessGate）**不豁免**本路径：迁移未证实完成时返回 503，
//    登录页按"接口不可用"回退内置兜底链接（与用户能否登录一致——该窗口内所有租户登录同样被阻断）。

import express from 'express'
import { friendlyLinkOrderBy, isValidFriendlyLinkId, toPublicFriendlyLink } from '../lib/friendlyLinks.js'

const TAG = '[publicFriendlyLinkRoutes]'

export function createPublicFriendlyLinkRoutes({ prisma, rateLimit }) {
  const router = express.Router()
  const readLimiter = typeof rateLimit === 'function' ? rateLimit(120, 60_000) : ((req, res, next) => next())
  const writeLimiter = typeof rateLimit === 'function' ? rateLimit(60, 60_000) : ((req, res, next) => next())

  // ── GET / — 启用中的友情链接（登录页渲染用） ──
  router.get('/', readLimiter, async (req, res) => {
    try {
      const rows = await prisma.friendlyLink.findMany({
        where: { status: 'enabled' },
        orderBy: friendlyLinkOrderBy(),
      })
      res.set('Cache-Control', 'no-store')
      res.json({ success: true, data: { items: rows.map(toPublicFriendlyLink) } })
    } catch (e) {
      // 迁移未落库 / 表缺失 / DB 不可用：不向匿名调用方暴露内部结构，登录页按失败回退兜底链接
      console.error(`${TAG} 查询友情链接失败:`, e)
      res.status(503).set('Cache-Control', 'no-store').json({ success: false, error: '友情链接暂不可用' })
    }
  })

  // ── POST /:id/visit — 点击计数（无鉴权；仅计数，不含任何写业务数据路径） ──
  router.post('/:id/visit', writeLimiter, async (req, res) => {
    try {
      const { id } = req.params
      if (!isValidFriendlyLinkId(id)) return res.status(204).end()
      const link = await prisma.friendlyLink.findUnique({ where: { id }, select: { id: true, status: true } })
      if (!link || link.status !== 'enabled') return res.status(204).end()
      await prisma.friendlyLink.update({
        where: { id },
        data: { visit_count: { increment: 1 }, last_visit_at: new Date() },
      })
      res.status(204).end()
    } catch (e) {
      // 计数失败绝不影响用户跳转（前端 fire-and-forget），仅留服务端日志
      console.error(`${TAG} 点击计数失败:`, e)
      res.status(204).end()
    }
  })

  return router
}

export default { createPublicFriendlyLinkRoutes }
