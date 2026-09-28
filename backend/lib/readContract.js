// readContract.js —— 「完整读取契约」的服务端实现（P3-W5-RECORD-T01 / AUD-020 / RC-07）
//
// RC-07 定稿要求（列表侧）：
//   · 服务端分页（优先稳定 cursor），响应返回 hasMore/nextCursor、total 的计算口径与过滤条件；
//   · **超限显式拒绝**（不静默截断）——禁止再用 `Math.min(limit, MAX)` 把 10000 悄悄降成 2000；
//   · 消费方（列表 / 看板 / 导出）复用同一契约，并在 UI / 报告中声明数据范围。
//
// 本模块只提供纯函数（可单测），不碰数据库；路由负责把 where 交给 Prisma。
//
// 游标语义：`orderBy [{created_at:'desc'},{id:'desc'}]` 的 keyset 分页。
//   · 稳定：同 created_at 的行由 id 兜底，不会像 skip/offset 那样在并发写入下重复或漏行；
//   · 并发可见性：新插入行（created_at 更大）只会出现在第 1 页，不影响后续页；删除行按语义"消失"；
//   · 导出（权威路径）不走本模块的 offset，而在**同一数据库快照事务**内用 keyset 分批（见 exportJobs.js）。

export const DEFAULT_PAGE_LIMIT = 100
export const MAX_PAGE_LIMIT = 2000

function toInt(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number.parseInt(String(value), 10)
  return Number.isFinite(n) ? n : null
}

/**
 * 解析分页参数（含超限显式拒绝）。
 * @returns {{ok:true,limit:number,offset:number,cursor:null|{createdAt:Date,id:string}}|{ok:false,status:number,code:string,error:string,extra?:object}}
 */
export function parsePageQuery(query = {}, { maxLimit = MAX_PAGE_LIMIT, defaultLimit = DEFAULT_PAGE_LIMIT } = {}) {
  const rawLimit = toInt(query.limit)
  const limit = rawLimit === null ? defaultLimit : rawLimit
  if (limit <= 0) {
    return { ok: false, status: 400, code: 'INVALID_LIMIT', error: `limit 必须为正整数（收到 ${JSON.stringify(query.limit)}）` }
  }
  if (limit > maxLimit) {
    // RC-07：不静默截断 —— 明确告知上限与替代方案（分页/导出作业）
    return {
      ok: false, status: 400, code: 'LIMIT_EXCEEDS_MAX',
      error: `limit=${limit} 超出服务端上限 ${maxLimit}；请使用分页（cursor/offset）读取，或走权威导出作业 POST /api/records/exports`,
      extra: { requestedLimit: limit, maxLimit },
    }
  }
  const rawOffset = toInt(query.offset)
  const offset = rawOffset === null ? 0 : rawOffset
  if (offset < 0) {
    return { ok: false, status: 400, code: 'INVALID_OFFSET', error: 'offset 不能为负' }
  }
  let cursor = null
  if (query.cursor !== undefined && query.cursor !== null && String(query.cursor).trim() !== '') {
    cursor = decodeCursor(query.cursor)
    if (!cursor) {
      return { ok: false, status: 400, code: 'INVALID_CURSOR', error: 'cursor 非法或已损坏（应为上次响应返回的 nextCursor 原样回传）' }
    }
  }
  return { ok: true, limit, offset, cursor }
}

/** 游标编码：base64url(JSON{ c: ISO 时间, i: id })。 */
export function encodeCursor(row) {
  if (!row || !row.id || row.created_at === undefined || row.created_at === null) return null
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at)
  if (Number.isNaN(createdAt.getTime())) return null
  const raw = JSON.stringify({ c: createdAt.toISOString(), i: String(row.id) })
  return Buffer.from(raw, 'utf8').toString('base64url')
}

export function decodeCursor(cursor) {
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.c !== 'string' || typeof parsed.i !== 'string' || !parsed.i) return null
    const createdAt = new Date(parsed.c)
    if (Number.isNaN(createdAt.getTime())) return null
    return { createdAt, id: parsed.i }
  } catch {
    return null
  }
}

/** keyset 条件：严格"晚于"游标行（desc 序）——与 orderBy [created_at desc, id desc] 配套。 */
export function cursorWhere(cursor) {
  if (!cursor) return null
  return {
    OR: [
      { created_at: { lt: cursor.createdAt } },
      { created_at: cursor.createdAt, id: { lt: cursor.id } },
    ],
  }
}

/** 合并 where（保持调用方原有条件；游标条件按 AND 叠加）。 */
export function mergeWhere(baseWhere, cursorCond) {
  if (!cursorCond) return baseWhere
  if (!baseWhere || Object.keys(baseWhere).length === 0) return cursorCond
  return { AND: [baseWhere, cursorCond] }
}

/**
 * 组装响应分页元数据（列表/看板/导出 UI 共用同一形状，任何消费方不得再把"本页"当"全量"）。
 * @param {{rows:Array, total:number, limit:number, offset:number, cursorUsed:boolean, filters?:object, totalBasis?:string}} args
 */
export function pageMeta({ rows, total, limit, offset, cursorUsed = false, filters = null, totalBasis = null }) {
  const returned = rows.length
  const hasMore = cursorUsed
    ? returned === limit && returned > 0            // 游标模式：取满一页即认为可能还有（下一页自然收敛为空）
    : (offset + returned) < total
  // 两种模式都提供 nextCursor（offset 模式给客户端"续读并切换到稳定游标"的能力）
  const nextCursor = returned > 0 ? encodeCursor(rows[rows.length - 1]) : null
  return {
    total,
    limit,
    offset: cursorUsed ? null : offset,
    returned,
    hasMore,
    nextCursor,
    pagination: cursorUsed ? 'cursor' : 'offset',
    totalBasis: totalBasis || 'count(*) with same filters on current tenant schema',
    filters: filters || null,
    coverage: cursorUsed
      ? { mode: 'cursor', pageReturned: returned, windowComplete: false }
      : { mode: 'offset', windowStart: offset, windowEnd: offset + returned, windowComplete: offset + returned >= total },
  }
}

/** 列表窗口声明（前端/报告用它判断"本地缓存是否等于全量"）。 */
export function windowIsComplete(meta) {
  if (!meta || typeof meta !== 'object') return false
  if (meta.pagination === 'cursor') return meta.hasMore === false
  return (Number(meta.offset) + Number(meta.returned)) >= Number(meta.total)
}
