/**
 * friendlyLinks.js — 友情链接（登录页外链）的**字段口径与校验唯一事实源**
 *
 * 背景（2026-09-28）：登录卡下方「友情链接」原为 frontend/pages/login.html 内硬编码的单条外链，
 *   现改为平台超管在超管控制台「友情链接」视图中维护（多条 / 排序 / 启停 / 一键访问 / 访问计数）。
 *   数据权威副本在 public."FriendlyLink"（模型见 prisma/schema.prisma；迁移 20260928120000_friendly_links），
 *   读侧免鉴权接口 /api/public/friendly-links 与写侧 /api/admin/friendly-links 共用本模块口径，
 *   **不得**在路由或前端另立一套校验（避免「界面放过、接口拒绝」或反过来的漂移）。
 *
 * 安全口径（外链是"用户可影响的 URL 被渲染成 href"的典型 XSS/开放重定向面）：
 *   1. 仅允许 http / https 绝对地址（拒绝 javascript: / data: / vbscript: / file: 等伪协议）；
 *   2. 拒绝携带账号密码的地址（https://user:pass@host）——避免把凭证写进页面源码与 Referer；
 *   3. 拒绝空白与控制字符（换行会切断 href 属性语义）；
 *   4. 名称/描述/分组为**纯文本**（前端一律 textContent 渲染，不拼 innerHTML）；
 *   5. 图标仅允许 FontAwesome 类名白名单形态（`<style> fa-xxx`），拒绝任意 class/属性注入。
 */

/** 链接状态白名单：enabled 在登录页展示；disabled 仅存在于管理台。 */
export const FRIENDLY_LINK_STATUS = Object.freeze(['enabled', 'disabled'])

/** 单库上限（避免登录页被塞爆 + 管理台一次渲染过多行）。 */
export const FRIENDLY_LINK_MAX = 50

/** 默认图标（未指定 icon 时前端使用的兜底类名，与登录页原样式一致）。 */
export const FRIENDLY_LINK_DEFAULT_ICON = 'fas fa-link'

export const FRIENDLY_LINK_LIMITS = Object.freeze({
  name: 60,
  url: 500,
  description: 200,
  icon: 60,
  groupName: 20,
  sortOrderMax: 9999,
})

/** FontAwesome 类名形态：`<style> fa-xxx [fa-yyy]`（仅小写字母/数字/连字符与空格）。 */
const ICON_RE = /^(fas|far|fal|fad|fab|fa-solid|fa-regular|fa-brands)\s+fa-[a-z0-9-]+(?:\s+fa-[a-z0-9-]+)*$/
/** 控制字符（含 \n \r \t 与 NUL）：出现即拒绝。 */
const CONTROL_RE = /[\u0000-\u001f\u007f]/
/** 允许的 URL 协议。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
/** 合法主键形态（cuid/种子 id 均满足；用于路径参数早退，避免无谓查询）。 */
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/

export function isValidFriendlyLinkId(id) {
  return typeof id === 'string' && ID_RE.test(id)
}

/**
 * 规范化并校验目标地址。
 * @returns {{ok:true, value:string} | {ok:false, reason:string}}
 */
export function normalizeFriendlyLinkUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: false, reason: '地址不能为空' }
  if (s.length > FRIENDLY_LINK_LIMITS.url) return { ok: false, reason: `地址过长（上限 ${FRIENDLY_LINK_LIMITS.url} 字符）` }
  if (CONTROL_RE.test(s) || /\s/.test(s)) return { ok: false, reason: '地址不能包含空白或控制字符' }
  let u
  try {
    u = new URL(s)
  } catch {
    return { ok: false, reason: '地址必须是完整 URL（含 http:// 或 https://）' }
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) return { ok: false, reason: '仅支持 http / https 协议的外链' }
  if (u.username || u.password) return { ok: false, reason: '地址不能携带账号密码' }
  if (!u.hostname) return { ok: false, reason: '地址缺少主机名' }
  return { ok: true, value: u.toString() }
}

/**
 * 规范化并校验图标类名；空值 → null（前端用内置默认图标）。
 * @returns {{ok:true, value:string|null} | {ok:false, reason:string}}
 */
export function normalizeFriendlyLinkIcon(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  const s = String(raw).trim().replace(/\s+/g, ' ')
  if (!s) return { ok: true, value: null }
  if (s.length > FRIENDLY_LINK_LIMITS.icon) return { ok: false, reason: `图标类名过长（上限 ${FRIENDLY_LINK_LIMITS.icon} 字符）` }
  if (!ICON_RE.test(s)) return { ok: false, reason: '图标仅支持 FontAwesome 类名（如 fas fa-link）' }
  return { ok: true, value: s }
}

/** 纯文本字段（trim + 长度上限；空串 → null）。 */
function normalizeText(raw, { label, max }) {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  const s = String(raw).trim()
  if (!s) return { ok: true, value: null }
  if (CONTROL_RE.test(s)) return { ok: false, reason: `${label}不能包含控制字符` }
  if (s.length > max) return { ok: false, reason: `${label}过长（上限 ${max} 字）` }
  return { ok: true, value: s }
}

/**
 * 规范化写入字段（**局部更新语义**：只处理 body 中出现的键，未出现的键不参与更新）。
 *
 * @param {object} body 请求体
 * @param {{requireCore?: boolean}} [opts] requireCore=true 时 name/url 必填（新建场景）
 * @returns {{ok:boolean, errors:string[], value:object}}
 */
export function normalizeFriendlyLinkFields(body, { requireCore = false } = {}) {
  const src = (body && typeof body === 'object') ? body : {}
  const errors = []
  const value = {}
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k)

  // name（必填：新建要求出现且非空；更新时空值视为非法，避免"链接无名"）
  if (requireCore || has('name')) {
    const s = String(src.name ?? '').trim()
    if (!s) errors.push('名称不能为空')
    else if (CONTROL_RE.test(s)) errors.push('名称不能包含控制字符')
    else if (s.length > FRIENDLY_LINK_LIMITS.name) errors.push(`名称过长（上限 ${FRIENDLY_LINK_LIMITS.name} 字）`)
    else value.name = s
  }

  // url（同上：外链地址不允许被清空）
  if (requireCore || has('url')) {
    const r = normalizeFriendlyLinkUrl(src.url)
    if (r.ok) value.url = r.value
    else errors.push(r.reason)
  }

  if (has('description')) {
    const r = normalizeText(src.description, { label: '描述', max: FRIENDLY_LINK_LIMITS.description })
    if (r.ok) value.description = r.value
    else errors.push(r.reason)
  }

  if (has('groupName') || has('group_name')) {
    const r = normalizeText(has('groupName') ? src.groupName : src.group_name, { label: '分组', max: FRIENDLY_LINK_LIMITS.groupName })
    if (r.ok) value.group_name = r.value
    else errors.push(r.reason)
  }

  if (has('icon')) {
    const r = normalizeFriendlyLinkIcon(src.icon)
    if (r.ok) value.icon = r.value
    else errors.push(r.reason)
  }

  if (has('sortOrder') || has('sort_order')) {
    const raw = has('sortOrder') ? src.sortOrder : src.sort_order
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0 || n > FRIENDLY_LINK_LIMITS.sortOrderMax) {
      errors.push(`排序值需为 0~${FRIENDLY_LINK_LIMITS.sortOrderMax} 的整数`)
    } else value.sort_order = n
  }

  if (has('status')) {
    const s = String(src.status ?? '').trim()
    if (!FRIENDLY_LINK_STATUS.includes(s)) errors.push('状态仅支持 enabled（启用）/ disabled（停用）')
    else value.status = s
  }

  if (has('openInNewTab') || has('open_in_new_tab')) {
    const raw = has('openInNewTab') ? src.openInNewTab : src.open_in_new_tab
    if (typeof raw !== 'boolean') errors.push('openInNewTab 需为布尔值')
    else value.open_in_new_tab = raw
  }

  return { ok: errors.length === 0, errors, value }
}

/** 管理台排序：sort_order 升序 → created_at 升序（稳定顺序，前端"上移/下移"按此基线）。 */
export function friendlyLinkOrderBy() {
  return [{ sort_order: 'asc' }, { created_at: 'asc' }]
}

/** 追加到末尾时使用的下一个排序值（步长 10，便于手工插队）。 */
export function nextFriendlyLinkSortOrder(maxSortOrder) {
  const n = Number(maxSortOrder)
  return (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0) + 10
}

/**
 * 公开投影（登录页）：只保留渲染必需字段。
 * ⚠️ 不外泄 created_by / status / visit_count / 时间戳等管理侧字段（最小披露）。
 */
export function toPublicFriendlyLink(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    description: row.description || '',
    icon: row.icon || FRIENDLY_LINK_DEFAULT_ICON,
    groupName: row.group_name || '',
    openInNewTab: row.open_in_new_tab !== false,
  }
}
