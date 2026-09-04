// feedbackRoutes.js — 问题反馈（意见反馈 / Bug 反馈 / 新需求建议）
//
// 面向全部登录身份（manager / operator / viewer / guest）的统一反馈通道：
//   POST /api/feedback — 提交反馈
//
// 处理链：authenticateUser（员工与访客令牌通用，guest 不挂 requireGuestReadOnly ——
//         反馈是唯一允许访客发起的写操作）→ 输入校验 → 单身份节流
//         → public.SystemLog 留档（FEEDBACK: 前缀，可审计可追溯）
//         → 钉钉群机器人推送（DINGTALK_WEBHOOK_URL；DINGTALK_SECRET 加签）
//
// 设计原则：
//   - 零 schema 迁移：不新增表/字段，留档复用 public.SystemLog；
//     钉钉群消息本身即业务存档，推送失败不丢数据（SystemLog 兜底）。
//   - 推送失败 / 未配置 webhook 不影响反馈受理（仍返回 200，delivered 标志区分）。
//   - 节流：每身份 60s 一条（内存态，单实例假设，与 securityAlerts.js 同源假设）。
//     钉钉自定义机器人官方限流 20 条/分钟，本节流同时防刷屏。
//   - 关键词兼容：机器人若用「自定义关键词」安全方式，消息 title 与 text 均固定
//     含「反馈」二字 —— 建议群机器人关键词直接配置为「反馈」。

import express from 'express'
import crypto from 'node:crypto'

const FEEDBACK_TYPES = {
  suggestion: '意见反馈',
  bug: 'Bug 反馈',
  feature: '新需求建议',
}

const CONTENT_MIN = 2
const CONTENT_MAX = 2000
const CONTACT_MAX = 100
const PER_USER_INTERVAL_MS = 60_000
const DINGTALK_TIMEOUT_MS = 5_000

export function createFeedbackRoutes({ prisma, authenticateUser }) {
  const router = express.Router()

  // 单身份节流：userId -> lastSubmitAt(ms)；定期清理防内存泄漏
  const lastSubmitAt = new Map()
  const _gc = setInterval(() => {
    const cutoff = Date.now() - PER_USER_INTERVAL_MS
    for (const [k, ts] of lastSubmitAt) {
      if (ts < cutoff) lastSubmitAt.delete(k)
    }
  }, PER_USER_INTERVAL_MS)
  if (typeof _gc.unref === 'function') _gc.unref()

  /**
   * 组装钉钉 webhook URL。「加签」安全方式：timestamp + '\n' + secret
   * → HMAC-SHA256 → base64 → URL 编码（钉钉官方签名算法）。
   */
  function buildDingtalkUrl() {
    const webhook = process.env.DINGTALK_WEBHOOK_URL || ''
    if (!webhook) return ''
    const secret = process.env.DINGTALK_SECRET || ''
    if (!secret) return webhook
    const ts = Date.now()
    const sign = crypto.createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64')
    return `${webhook}&timestamp=${ts}&sign=${encodeURIComponent(sign)}`
  }

  /**
   * 钉钉 markdown 消息正文（含类型/学校/用户/联系方式/时间/内容）。
   */
  function buildMarkdownText({ typeLabel, content, contact, user, schoolCode, now }) {
    const pad = (n) => String(n).padStart(2, '0')
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    const who = user?.username || user?.userId || '未知'
    return [
      '### 📮 问题反馈（foodsentinel）',
      '',
      `- **类型**：${typeLabel}`,
      `- **学校**：${schoolCode || '（平台级/未归属）'}`,
      `- **用户**：${who}（${user?.role || 'unknown'}）`,
      `- **联系方式**：${contact || '未填写'}`,
      `- **时间**：${ts}`,
      '',
      '**内容**：',
      '',
      content,
    ].join('\n')
  }

  /**
   * 推送钉钉群机器人。永不 throw：失败返回 { delivered:false, reason }。
   */
  async function pushToDingtalk(payload) {
    const url = buildDingtalkUrl()
    if (!url) return { delivered: false, reason: 'DINGTALK_WEBHOOK_URL 未配置' }
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), DINGTALK_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok || body.errcode !== 0) {
        return { delivered: false, reason: `钉钉返回 errcode=${body.errcode} errmsg=${body.errmsg || resp.status}` }
      }
      return { delivered: true }
    } catch (e) {
      return { delivered: false, reason: `推送异常: ${e.message}` }
    }
  }

  router.post('/', authenticateUser, async (req, res) => {
    try {
      const body = req.body || {}
      const type = typeof body.type === 'string' ? body.type : ''
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      const contact = typeof body.contact === 'string' ? body.contact.trim() : ''

      if (!FEEDBACK_TYPES[type]) {
        return res.status(400).json({ error: '反馈类型无效' })
      }
      if (content.length < CONTENT_MIN || content.length > CONTENT_MAX) {
        return res.status(400).json({ error: `反馈内容需在 ${CONTENT_MIN}~${CONTENT_MAX} 字之间` })
      }
      if (contact.length > CONTACT_MAX) {
        return res.status(400).json({ error: `联系方式不能超过 ${CONTACT_MAX} 字` })
      }

      const user = req.user || {}
      const userId = user.userId || req.userId || 'anonymous'

      // 单身份节流（放校验之后，避免无效请求占用节流配额）
      const last = lastSubmitAt.get(userId) || 0
      const waitMs = PER_USER_INTERVAL_MS - (Date.now() - last)
      if (waitMs > 0) {
        return res.status(429).json({ error: `提交过于频繁，请约 ${Math.ceil(waitMs / 1000)} 秒后再试` })
      }

      const typeLabel = FEEDBACK_TYPES[type]
      const schoolCode = user.schoolCode || null
      const now = new Date()

      // 1) 留档 public.SystemLog（FEEDBACK: 前缀可检索；失败不阻断受理）
      try {
        await prisma.systemLog.create({
          data: {
            level: 'info',
            message: `FEEDBACK:${type}`,
            context: {
              school_code: schoolCode,
              user_id: userId,
              username: user.username || null,
              role: user.role || null,
              contact: contact || null,
              content,
              ip: req.ip || null,
              user_agent: (req.headers['user-agent'] || '').slice(0, 200),
            },
          },
        })
      } catch (e) {
        console.error('[feedback] SystemLog 留档失败（反馈仍继续推送）:', e.message)
      }

      // 2) 钉钉群机器人推送（失败不影响受理；title 与 text 均含「反馈」兼容关键词校验）
      const push = await pushToDingtalk({
        msgtype: 'markdown',
        markdown: {
          title: '问题反馈',
          text: buildMarkdownText({ typeLabel, content, contact, user, schoolCode, now }),
        },
      })
      if (!push.delivered) {
        console.warn(`[feedback] 钉钉未推送（${push.reason}）；反馈已留档 SystemLog`)
      }

      lastSubmitAt.set(userId, Date.now())
      return res.json({ success: true, delivered: push.delivered })
    } catch (e) {
      console.error('[feedback] 提交失败:', e)
      return res.status(500).json({ error: '反馈提交失败，请稍后重试' })
    }
  })

  return router
}
