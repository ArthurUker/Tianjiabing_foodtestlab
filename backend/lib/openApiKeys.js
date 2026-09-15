// openApiKeys.js — 开放接口 API Key 的生成 / 哈希 / 提取 / IP 白名单判定
//
// 设计口径（2026-09-15 定稿）：
//   - 明文密钥形如 `oap_<43 位 base64url>`（32 字节随机），**只在生成时返回一次**；
//   - 库中仅存 sha256 哈希（key_hash 唯一索引）—— 密钥是随机长串，sha256 足以抵御
//     暴力枚举，无需 bcrypt（且每次请求都要校验，慢哈希会成为性能瓶颈）；
//   - 库里同时存 key_prefix（展示用前缀）与 key_last4（展示用后四位），
//     供超管界面辨认"是哪一把"，泄露风险极低；
//   - 轮换 = 生成新密钥 + 给旧密钥设 expires_at（双活窗口），到期由中间件按时间判定失效。

import crypto from 'node:crypto'

export const KEY_PREFIX = 'oap_'

/** 生成一把新密钥（明文 + 哈希 + 展示串）。 */
export function generateApiKey() {
  const raw = crypto.randomBytes(32).toString('base64url')
  const plain = KEY_PREFIX + raw
  return {
    plain,
    hash: hashApiKey(plain),
    prefix: displayPrefix(plain),
    last4: plain.slice(-4),
  }
}

/** sha256(明文) → hex，与库中 key_hash 比对。 */
export function hashApiKey(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex')
}

/** 展示前缀：oap_ + 前 8 位随机串（不含密钥主体，可安全入库/展示）。 */
export function displayPrefix(plain) {
  return String(plain).slice(0, KEY_PREFIX.length + 8)
}

/**
 * 从请求中提取 API Key。
 * 支持两种携带方式（兼容不同 HTTP 客户端习惯）：
 *   1) X-API-Key: oap_xxx
 *   2) Authorization: Bearer oap_xxx
 * 返回 null 表示未携带。
 */
export function extractApiKey(req) {
  const headerKey = req.get('x-api-key')
  if (headerKey && String(headerKey).trim()) return String(headerKey).trim()
  const auth = req.get('authorization')
  if (auth && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, '').trim()
    if (token) return token
  }
  return null
}

/** IPv4-mapped IPv6（::ffff:1.2.3.4）归一为 IPv4，便于白名单比较。 */
export function normalizeIp(ip) {
  const s = String(ip || '').trim()
  const m = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  return m ? m[1] : s
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = (n << 8) + v
  }
  return n >>> 0
}

/**
 * IP 白名单判定。空数组/非数组/缺省 = 不限制（返回 true）。
 * 支持：精确 IPv4、"192.168.1.0/24" 形式的 CIDR、精确 IPv6 字符串。
 */
export function ipAllowed(rawIp, whitelist) {
  if (!Array.isArray(whitelist) || whitelist.length === 0) return true
  const ip = normalizeIp(rawIp)
  if (!ip) return false
  const ipInt = ipv4ToInt(ip)
  for (const raw of whitelist) {
    const entry = String(raw || '').trim()
    if (!entry) continue
    if (entry === ip) return true
    const cidr = entry.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
    if (cidr && ipInt !== null) {
      const base = ipv4ToInt(cidr[1])
      const bits = Number(cidr[2])
      if (base === null || bits < 0 || bits > 32) continue
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
      if ((ipInt & mask) === (base & mask)) return true
    }
  }
  return false
}
