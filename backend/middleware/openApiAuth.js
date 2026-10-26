// openApiAuth.js — 开放接口（第三方只读）认证中间件
//
// 与 authenticateUser 的关系：**完全独立**。开放接口是机器对机器调用，没有人类 JWT、
// 没有 req.db（不注入租户客户端，取数由路由按 grant 的 school_code 显式创建），
// 也不参与 requireEditorOrAbove / requireGuestReadOnly 等人类语义的守卫。
//
// 校验链（任一失败即拒绝，且不泄露内部信息）：
//   ① 提取 API Key（X-API-Key 或 Authorization: Bearer）
//   ② key_hash 查凭证 → 存在 / 未吊销 / 未过期
//   ③ 所属对接方 status=active
//   ④ IP 白名单（对接方维度；为空 = 不限制）
//   ⑤ 按凭证限流（滑动窗口，窗口 60s，上限取对接方 rate_limit_per_min）
// 通过后挂载 req.openApi = { client, credential }。
//
// 副作用写入（均为节流/非阻塞）：
//   - credential.last_used_at / call_count 与 client.last_used_at：每凭证最多 60s 写一次；
//   - **调用日志（2026-10-26）**：每次请求一行写 public.SystemLog（category=openapi），
//     成功与失败都记（client_id/path/status/code/rows/ms/ip/ua），按「对接方+路径+结论」窗口聚合，
//     repeat_count 记次数、sum_rows 记累计返回条数（不记业务字段内容）。

import { extractApiKey, hashApiKey, ipAllowed, normalizeIp } from '../lib/openApiKeys.js'
import { writeAggregatedLog } from '../lib/logThrottle.js'

const TAG = '[openApiAuth]'
const WINDOW_MS = 60 * 1000
const USAGE_FLUSH_MS = 60 * 1000 // 最近使用/计数落库节流
const LOG_WINDOW_MS = 60 * 1000  // 调用日志聚合窗口

/** 拒绝响应统一结构：{ code, error }，便于第三方程序化处理。 */
function deny(res, status, code, message, extraHeaders = {}) {
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
  return res.status(status).json({ code, error: message })
}

/** 从响应体推断「返回条数」（只取数量，不取内容；不同接口的承载字段略有差异）。 */
function rowsOf(body) {
  const d = body?.data
  if (Array.isArray(d)) return d.length
  if (!d || typeof d !== 'object') return null
  for (const k of ['items', 'records', 'list', 'results', 'rows']) {
    if (Array.isArray(d[k])) return d[k].length
  }
  return typeof d.total === 'number' ? d.total : null
}

export function createOpenApiAuth({ prisma }) {
  /** 滑动窗口计数：credentialId → number[]（毫秒时间戳） */
  const hits = new Map()
  /** 用量落库节流：credentialId → 上次写入时间 */
  const lastUsageFlush = new Map()

  function pruneHits(now) {
    for (const [id, arr] of hits) {
      const kept = arr.filter((t) => now - t < WINDOW_MS)
      if (kept.length) hits.set(id, kept)
      else hits.delete(id)
    }
  }

  function flushUsage(credential, client) {
    const now = Date.now()
    const prev = lastUsageFlush.get(credential.id) || 0
    if (now - prev < USAGE_FLUSH_MS) return
    lastUsageFlush.set(credential.id, now)
    const nowDate = new Date()
    Promise.all([
      prisma.openApiCredential.update({
        where: { id: credential.id },
        data: { last_used_at: nowDate, call_count: { increment: 1 } },
      }),
      prisma.openApiClient.update({ where: { id: client.id }, data: { last_used_at: nowDate } }),
    ]).catch((e) => console.warn(`${TAG} 用量落库失败:`, e.message))
  }

  /**
   * 每次调用一行（含未通过认证的请求）：
   * 在 res 完成时统一记录，路由侧无需逐个埋点；用 res.json 包装捕获结论码与返回条数。
   */
  function installCallLog(req, res, ip, path) {
    const startedAt = Date.now()
    const origJson = res.json.bind(res)
    res.json = (body) => {
      res.locals.oaCode = body?.code || null
      res.locals.oaRows = rowsOf(body)
      res.locals.oaSchool = body?.data?.school_code || null
      return origJson(body)
    }
    res.on('finish', () => {
      const status = res.statusCode
      const code = res.locals.oaCode || null
      const isErr = status >= 400
      const client = req.openApi?.client
      const rows = res.locals.oaRows
      writeAggregatedLog(prisma, {
        key: `${client?.id || 'unknown'}|${path}|${code || (isErr ? status : 'OK')}`,
        level: isErr ? 'warn' : 'info',
        message: isErr ? `OPENAPI_DENIED ${code || status} ${path}` : `OPENAPI_CALL ${path}`,
        context: {
          action_type: isErr ? 'openapi_denied' : 'openapi_call',
          category: 'openapi',
          client_id: client?.id || null,
          client_name: client?.name || null,
          credential_id: req.openApi?.credential?.id || null,
          path,
          method: req.method,
          status,
          code,
          school_code: res.locals.oaSchool || null,
          rows: rows ?? null,
          ms: Date.now() - startedAt,
          ip,
          ua: String(req.headers['user-agent'] || '').slice(0, 120) || null,
        },
        metrics: { sum_rows: Number(rows) || 0 },
        windowMs: LOG_WINDOW_MS,
      }).catch((e) => console.warn(`${TAG} 调用日志落库失败:`, e.message))
    })
  }

  return function openApiAuth(req, res, next) {
    const ip = normalizeIp(req.ip || req.connection?.remoteAddress)
    const path = String(req.originalUrl || req.url || '').split('?')[0]
    installCallLog(req, res, ip, path)

    const plain = extractApiKey(req)
    if (!plain) {
      return deny(res, 401, 'MISSING_KEY', '缺少 API Key（请使用 X-API-Key 或 Authorization: Bearer）')
    }

    prisma.openApiCredential
      .findUnique({ where: { key_hash: hashApiKey(plain) }, include: { client: true } })
      .then(async (credential) => {
        if (!credential) {
          return deny(res, 401, 'INVALID_KEY', 'API Key 无效')
        }
        if (credential.status !== 'active' || credential.revoked_at) {
          return deny(res, 401, 'CREDENTIAL_REVOKED', 'API Key 已吊销')
        }
        if (credential.expires_at && new Date(credential.expires_at).getTime() <= Date.now()) {
          return deny(res, 401, 'CREDENTIAL_EXPIRED', 'API Key 已过期')
        }

        const client = credential.client
        if (!client || client.status !== 'active') {
          return deny(res, 403, 'CLIENT_DISABLED', '对接方已被停用，请联系平台管理员')
        }

        if (!ipAllowed(ip, client.ip_whitelist)) {
          return deny(res, 403, 'IP_DENIED', `来源 IP 不在白名单内（${ip}）`)
        }

        // 限流（滑动窗口，按凭证独立计数）
        const now = Date.now()
        pruneHits(now)
        const limit = Number(client.rate_limit_per_min) > 0 ? Number(client.rate_limit_per_min) : 60
        const arr = hits.get(credential.id) || []
        if (arr.length >= limit) {
          const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - arr[0])) / 1000))
          return deny(res, 429, 'RATE_LIMITED', `请求过于频繁（上限 ${limit} 次/分钟）`, { 'Retry-After': String(retryAfter) })
        }
        arr.push(now)
        hits.set(credential.id, arr)

        flushUsage(credential, client)
        req.openApi = { client, credential, ip }
        next()
      })
      .catch((e) => {
        console.error(`${TAG} 凭证校验异常:`, e)
        return deny(res, 500, 'AUTH_ERROR', '认证服务异常')
      })
  }
}

export default createOpenApiAuth
