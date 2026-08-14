/**
 * authMiddleware.js — 统一认证与授权中间件
 * 所有需要保护的路由统一使用此文件的中间件，禁止在路由文件中重复实现认证逻辑。
 *
 * 依赖：UserManager 实例需在 server.js 初始化后通过工厂函数注入。
 * 用法：
 *   import { createAuthMiddleware } from '../middleware/authMiddleware.js'
 *   const { authenticateUser, authorizeAdmin, authorizeRoles } = createAuthMiddleware(userManager)
 *
 * 【安全修复 H1/H2/DS3-H1】本文件另导出「令牌吊销存储」能力（public.revoked_tokens）：
 *   - ensureRevocationInfra / isTokenRevoked / revokeToken / revokeAllUserTokens / cleanupExpiredRevocations
 *   窗口 2（角色变更/禁用/删除用户的写入调用点）应 import 这些函数写入吊销记录，
 *   本文件的 authenticateUser 负责校验（jti 精确吊销 + user_all 全量吊销）。
 */

import { randomUUID } from 'crypto'
import { createTenantClient } from '../lib/tenantClient.js'

// ============================================================================
// 令牌吊销存储（H2）—— public.revoked_tokens
//
// 【部署一致性（强制）】吊销记录必须落在所有服务实例共享的存储（数据库/Redis），
// 严禁进程内内存结构（如普通 Map）：多实例负载均衡下，进程内存方案会导致吊销
// 仅在部分实例生效。当前实现以 PostgreSQL public schema 为共享存储。
//
// 【状态缓存说明（H1-2/H1-3）】原要求引入 ≤30s TTL 的状态缓存以减轻主库压力，
// 且缓存本身也必须是共享存储。当前技术栈无 Redis，"DB 里缓存 DB 数据"无意义，
// 故默认【每请求直查 DB】（user 主键查询 + revoked_tokens 主键查询，各 1 次索引命中，
// 状态变更生效延迟窗口 = 0）。预留 setAuthStateCache() 注入点：接入 Redis 后注入
// 适配器 { get(key), set(key, value, ttlMs) } 即可启用 30s TTL 缓存，届时接受并明确
// 「状态变更/吊销生效延迟 ≤ 缓存 TTL（30s）」。禁止注入进程内 Map 实现。
// ============================================================================

const REVOKED_TOKENS_DDL = [
  `CREATE TABLE IF NOT EXISTS public.revoked_tokens (
     jti         TEXT PRIMARY KEY,
     user_id     TEXT NOT NULL,
     school_code TEXT,
     token_type  TEXT NOT NULL DEFAULT 'access',
     reason      TEXT,
     revoked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at  TIMESTAMPTZ NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at_idx ON public.revoked_tokens (expires_at)`,
  `CREATE INDEX IF NOT EXISTS revoked_tokens_user_idx ON public.revoked_tokens (user_id, token_type, revoked_at)`,
]

let _ensureInfraPromise = null

/**
 * 幂等创建吊销表与索引（memoized，一个进程只真正执行一次）。
 */
export function ensureRevocationInfra(prisma) {
  if (!_ensureInfraPromise) {
    _ensureInfraPromise = (async () => {
      for (const sql of REVOKED_TOKENS_DDL) {
        await prisma.$executeRawUnsafe(sql)
      }
    })().catch((e) => {
      // 失败后允许下次重试（例如 DB 暂不可用时启动）
      _ensureInfraPromise = null
      throw e
    })
  }
  return _ensureInfraPromise
}

/**
 * 校验令牌是否已被吊销：
 *   1) jti 精确命中吊销表（单令牌吊销 / refresh 轮转标记）；
 *   2) user_all 全量吊销：该用户存在吊销时间 >= 令牌签发时间(iat) 的 user_all 记录
 *      （用于 refresh 重放触发的全会话吊销、以及窗口 2 的禁用/删除/改角色场景）。
 * @returns {Promise<boolean>} true = 已吊销
 */
export async function isTokenRevoked(prisma, { jti, userId, iat }) {
  const query = () => prisma.$queryRawUnsafe(
    `SELECT 1 AS hit FROM public.revoked_tokens
      WHERE jti = $1
         OR (token_type = 'user_all' AND user_id = $2 AND revoked_at >= to_timestamp($3))
      LIMIT 1`,
    jti || '', userId || '', Math.floor(Number(iat) || 0)
  )
  try {
    await ensureRevocationInfra(prisma)
    const rows = await query()
    return rows.length > 0
  } catch (e) {
    // R2-03: 吊销表查询异常时不得静默降级为「未吊销」（fail-open），否则已吊销 token 会在
    // 吊销表单独故障时被放行。改为向上抛出，交由调用方统一决策：
    //   - authenticateUser 内 Promise.all 抛错 → 进入 fail-soft/fail-closed 折中计数（与 user 回查同口径）
    //   - refresh-token 内 await 抛错 → 进入其 catch 返回 401（fail-closed）
    console.error('❌ [revocation] 吊销校验失败（向上抛出，交由调用方降级决策）:', e.message)
    throw e
  }
}

/**
 * 写入单令牌吊销记录（幂等）。
 * @returns {Promise<boolean>} true = 本次新写入；false = 该 jti 已存在（refresh 重放检测依赖此语义）
 */
export async function revokeToken(prisma, { jti, userId, schoolCode = null, tokenType = 'access', reason = null, expiresAt }) {
  if (!jti || !userId || !expiresAt) throw new Error('revokeToken: 缺少 jti/userId/expiresAt')
  await ensureRevocationInfra(prisma)
  const count = await prisma.$executeRawUnsafe(
    `INSERT INTO public.revoked_tokens (jti, user_id, school_code, token_type, reason, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (jti) DO NOTHING`,
    jti, userId, schoolCode, tokenType, reason, expiresAt
  )
  return count > 0
}

/**
 * 查询某 jti 的吊销记录详情（第六轮·多标签页并发刷新防误吊销）。
 * refresh 端点在 INSERT 冲突（jti 已存在）时调用本函数，读取已有记录的
 * revoked_at/reason，用于区分「刚刚发生的并发轮转竞争（benign）」与
 * 「真正的重放攻击（旧 token 在宽限期外被再次使用）」。
 * @returns {Promise<{revoked_at: Date, reason: string|null, token_type: string}|null>}
 */
export async function getRevocationInfo(prisma, jti) {
  if (!jti) return null
  await ensureRevocationInfra(prisma)
  const rows = await prisma.$queryRawUnsafe(
    `SELECT revoked_at, reason, token_type FROM public.revoked_tokens WHERE jti = $1 LIMIT 1`,
    jti
  )
  return rows.length ? rows[0] : null
}

/**
 * 吊销某用户的全部会话（access + refresh）：写入一条 user_all 记录，
 * 所有「签发时间早于该记录 revoked_at」的令牌全部失效。
 * ttlSeconds 默认 8 天（覆盖 7 天 refresh TTL + 时钟偏差），到期由清理任务删除。
 */
export async function revokeAllUserTokens(prisma, { userId, schoolCode = null, reason = null, ttlSeconds = 8 * 86400 }) {
  if (!userId) throw new Error('revokeAllUserTokens: 缺少 userId')
  await ensureRevocationInfra(prisma)
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.revoked_tokens (jti, user_id, school_code, token_type, reason, expires_at)
     VALUES ($1, $2, $3, 'user_all', $4, $5)`,
    `user_all:${userId}:${randomUUID()}`, userId, schoolCode, reason, new Date(Date.now() + ttlSeconds * 1000)
  )
  return true
}

/**
 * 清理已过期吊销记录（expires_at < now() 的记录对应令牌本身已过期，无需保留），
 * 防止吊销表无限增长（H2-3）。
 */
export async function cleanupExpiredRevocations(prisma) {
  await ensureRevocationInfra(prisma)
  return prisma.$executeRawUnsafe(`DELETE FROM public.revoked_tokens WHERE expires_at < now()`)
}

let _cleanupTimer = null

/**
 * 启动吊销表定时清理任务（每进程仅一个定时器；unref 不阻塞进程退出）。
 * 多实例同时运行也安全（DELETE 幂等）。
 */
export function startRevocationCleanup(prisma, intervalMs = Number(process.env.REVOKED_TOKENS_CLEANUP_INTERVAL_MS || 15 * 60 * 1000)) {
  if (_cleanupTimer) return
  _cleanupTimer = setInterval(() => {
    cleanupExpiredRevocations(prisma).catch(e =>
      console.warn('⚠️ [revocation] 过期吊销记录清理失败:', e.message))
  }, intervalMs)
  if (typeof _cleanupTimer.unref === 'function') _cleanupTimer.unref()
}

// —— 共享认证状态缓存注入点（见文件头说明；仅允许注入 Redis 等共享存储适配器）——
let _authStateCache = null
const AUTH_STATE_CACHE_TTL_MS = Number(process.env.AUTH_STATE_CACHE_TTL_MS || 30_000) // 建议 30s

export function setAuthStateCache(adapter) {
  _authStateCache = adapter && typeof adapter.get === 'function' && typeof adapter.set === 'function'
    ? adapter
    : null
}

// H4-ext / #8: DB 回查失败降级策略（fail-soft → fail-closed 折中计数器）。
// 背景：authenticateUser 的回查 catch 原为「直接 503」（fail-closed），但因 _authStateCache
// 默认 null，回查每次直连 DB；PG 瞬时抖动 / 连接池耗尽会触发全站认证 503 雪崩。
// 折中：维护「进程级连续回查失败计数」，仅当连续失败次数达到阈值才 fail-closed（503），
// 阈值内降级为 fail-soft（沿用 token 角色 + 告警），避免瞬时抖动误伤正常请求。
// 注意：这是进程级计数，多实例各自独立；阈值取 3（约 3×单请求超时 ~30s，与既有 30s TTL 同量级）。
const DB_RECHECK_FAIL_THRESHOLD = Number(process.env.AUTH_DB_RECHECK_FAIL_THRESHOLD || 3)
let _consecutiveRecheckFails = 0
let _recheckFailMetrics = { total: 0, lastError: null, lastAt: null }

// 供测试 / 监控读取当前降级状态（无需重启即可观测是否处于 fail-closed 窗口）
export function getRecheckFailState() {
  return {
    consecutiveFails: _consecutiveRecheckFails,
    threshold: DB_RECHECK_FAIL_THRESHOLD,
    isFailClosed: _consecutiveRecheckFails >= DB_RECHECK_FAIL_THRESHOLD,
    metrics: { ..._recheckFailMetrics }
  }
}

// 仅供测试使用：重置连续失败计数，避免进程级状态跨用例污染
export function _resetRecheckFailStateForTest() {
  _consecutiveRecheckFails = 0
}

// H4-ext / #9：合法角色白名单（与 role-audit-trigger.sql 的 role CHECK 约束口径一致）。
// 集中定义，供 authenticateUser 角色覆盖、requireEditorOrAbove、authorizeAdmin 共用，
// 防止枚举外角色（如 token 注入的 superuser/root）绕过授权守卫。
const VALID_ROLES = new Set(['admin', 'manager', 'operator', 'viewer'])

function _onRecheckFailure(err) {
  _consecutiveRecheckFails += 1
  _recheckFailMetrics.total += 1
  _recheckFailMetrics.lastError = err && err.message
  _recheckFailMetrics.lastAt = Date.now()
  const failClosed = _consecutiveRecheckFails >= DB_RECHECK_FAIL_THRESHOLD
  console.error(
    `❌ [auth] DB 回查失败（连续 ${_consecutiveRecheckFails}/${DB_RECHECK_FAIL_THRESHOLD}，failClosed=${failClosed}）:`,
    err && err.message
  )
  return failClosed
}

function _onRecheckSuccess() {
  if (_consecutiveRecheckFails !== 0) {
    console.warn(`✅ [auth] DB 回查恢复（连续失败计数清零，此前 ${_consecutiveRecheckFails} 次）`)
  }
  _consecutiveRecheckFails = 0
}

// IF-2/M2: must_change_password=true（临时密码账号）时允许访问的接口白名单。
// 除此之外的一切受保护接口一律 403（code: MUST_CHANGE_PASSWORD），
// 服务端强制、不依赖前端自觉；改密成功（changePassword 清 flag）后自动恢复。
const MUST_CHANGE_PASSWORD_ALLOWED_PATHS = [
  '/api/user/change-password',
  '/api/user/logout',
  '/api/user/me',
  '/api/user/verify-token',
]

function isMustChangePasswordAllowed(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0]
  return MUST_CHANGE_PASSWORD_ALLOWED_PATHS.some(p => path === p || path.startsWith(`${p}/`))
}

/**
 * 工厂函数：接收 userManager 实例，返回一组认证/授权中间件
 * @param {UserManager} userManager
 */
export function createAuthMiddleware(userManager, prisma) {

  // 基础（public schema）客户端：优先用显式注入的 prisma；
  // 未注入时（如 userRoutes 只传 userManager）回落到 userManager 持有的根客户端。
  const rootPrisma = prisma || userManager?.rootPrisma || userManager?.prisma || null

  // 初始化吊销基础设施 + 定时清理（测试环境跳过，避免占用句柄/连接）
  if (rootPrisma && process.env.NODE_ENV !== 'test') {
    ensureRevocationInfra(rootPrisma)
      .then(() => startRevocationCleanup(rootPrisma))
      .catch(e => console.error('❌ [revocation] 吊销表初始化失败:', e.message))
  }

  /**
   * authenticateUser
   * 验证请求头中的 Bearer Token，将解码后的用户信息挂载到 req.user
   * req.user 结构：{ userId, username, email, role, schoolCode, jti, iat, exp }
   *
   * 【H1】JWT 签名校验通过后，回查数据库当前用户状态（status !== 'active' → 401）。
   *      禁用/删除用户后，旧 access token 立即失效（生效延迟窗口：直查 DB 时为 0；
   *      注入共享缓存后 ≤ AUTH_STATE_CACHE_TTL_MS，默认 30s，属明确接受的权衡）。
   * 【H2】校验 token 的 jti 是否在吊销表中（含 user_all 全量吊销），命中 → 401。
   * 【破坏性变更】不含 jti 的旧版员工 access token 一律 401（存量会话强制重新登录）。
   */
  async function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '❌ 缺少授权令牌' })
    }

    const token = authHeader.substring(7)
    const verification = userManager.verifyToken(token)

    if (!verification.valid) {
      return res.status(401).json({ error: '❌ 令牌无效或已过期' })
    }

    const u = verification.user

    try {
      if (u.role === 'guest') {
        // —— 访客令牌 ——
        // quick-access 令牌无 DB 实体（userId='quick-access'，2h 短时效），跳过状态回查；
        // 普通访客回查 Guest 表状态与有效期，并校验 user_all 全量吊销。
        if (!u.is_quick_access) {
          const db = createTenantClient(rootPrisma, u.schoolCode)
          const [guest, revoked] = await Promise.all([
            db.guest.findUnique({
              where: { id: u.userId },
              select: { status: true, valid_until: true }
            }),
            isTokenRevoked(rootPrisma, { jti: u.jti, userId: u.userId, iat: u.iat })
          ])
          if (revoked) {
            return res.status(401).json({ error: '❌ 会话已失效，请重新登录' })
          }
          if (!guest || guest.status !== 'active' ||
              (guest.valid_until && guest.valid_until < new Date())) {
            return res.status(401).json({ error: '❌ 访客账号已失效，请重新登录' })
          }
        }
      } else {
        // —— 员工/管理员令牌 ——
        // H2: 新签发的 access token 必带 jti；无 jti 的旧令牌无法参与吊销校验，直接拒绝
        if (!u.jti) {
          return res.status(401).json({ error: '❌ 登录已过期，请重新登录' })
        }

        // 共享缓存命中（仅缓存"校验通过"的结果，TTL 内跳过 DB 回查）
        const cacheKey = `auth:${u.userId}:${u.jti}`
        let cached = null
        if (_authStateCache) {
          try { cached = await _authStateCache.get(cacheKey) } catch { /* 缓存故障降级直查 DB */ }
        }
        const cachedOk = !!cached && cached.ok === true

        if (!cachedOk) {
          const db = createTenantClient(rootPrisma, u.schoolCode)
          const [dbUser, revoked] = await Promise.all([
            db.user.findUnique({
              where: { id: u.userId },
              // H1-ext: 同时回查当前角色，使后台调整角色后旧 token 能尽快生效（最大延迟=缓存 TTL）
              select: { status: true, school_code: true, must_change_password: true, role: true }
            }),
            isTokenRevoked(rootPrisma, { jti: u.jti, userId: u.userId, iat: u.iat })
          ])

          if (revoked) {
            return res.status(401).json({ error: '❌ 会话已被吊销，请重新登录' })
          }
          // H1: 用户不存在（已删除）或已禁用 → 立即失效
          if (!dbUser || dbUser.status !== 'active') {
            return res.status(401).json({ error: '❌ 账号状态已变更，请重新登录' })
          }
          // 令牌租户绑定与 DB 权威值交叉校验（与 DS3-H2 口径一致）
          if ((dbUser.school_code ?? null) !== (u.schoolCode ?? null)) {
            return res.status(401).json({ error: '❌ 令牌租户信息异常，请重新登录' })
          }
          // IF-2/M2: 临时密码账号（must_change_password=true）仅可访问改密白名单接口
          if (dbUser.must_change_password && !isMustChangePasswordAllowed(req)) {
            return res.status(403).json({
              error: '❌ 首次登录须先修改初始密码，方可使用系统',
              code: 'MUST_CHANGE_PASSWORD'
            })
          }

          // H1-ext: 用数据库当前角色覆盖 token 中的角色，角色调整后无需强制重新登录。
          // #9 防御：仅当 DB role 为合法枚举值才覆盖，防止 role=NULL/非法串绕过覆盖逻辑、
          // 使旧高权 token 不被降权（与 role-audit-trigger 的 CHECK 约束口径一致）。
          if (dbUser.role && VALID_ROLES.has(dbUser.role) && dbUser.role !== u.role) {
            u.role = dbUser.role
          }

          // 回查成功：清零连续失败计数（H4-ext / #8 折中）
          _onRecheckSuccess()

          // 注意：must_change_password=true 时不写缓存，保证改密后即时恢复（无 TTL 延迟）。
          // #3: 缓存存 { ok, role }，使缓存命中路径也能同步 DB 最新角色（避免"命中即旧角色"窗口）。
          if (_authStateCache && !dbUser.must_change_password) {
            try {
              await _authStateCache.set(cacheKey, { ok: true, role: dbUser.role || u.role }, AUTH_STATE_CACHE_TTL_MS)
            } catch { /* 忽略缓存写失败 */ }
          }
        } else if (cached && cached.role) {
          // #3: 缓存命中时同步 DB 最新角色（来自上次回查写入），消除"命中即旧 token 角色"窗口。
          if (VALID_ROLES.has(cached.role) && cached.role !== u.role) {
            u.role = cached.role
          }
        }
      }
    } catch (error) {
      // H4-ext / #8: DB 回查异常降级策略（fail-soft → fail-closed 折中）。
      // 历史实现为「一律 503」（fail-closed）：因 _authStateCache 默认 null，回查每次直连 DB，
      // PG 瞬时抖动 / 连接池耗尽会触发全站认证 503 雪崩（可用性代价过高）。
      // 现改为：连续失败达阈值才 fail-closed（503）；阈值内 fail-soft（沿用 token 角色 + 告警），
      // 避免瞬时抖动误伤正常请求，同时连续故障仍快速 fail-closed。
      const failClosed = _onRecheckFailure(error)
      if (failClosed) {
        return res.status(503).json({ error: '认证服务暂不可用，请稍后重试' })
      }
      // fail-soft：回查失败但连续失败未达阈值，沿用 token 内已认证身份继续（保守降级）
      console.warn('⚠️ [auth] 回查失败未达阈值，按 fail-soft 放行（沿用 token 角色）')
    }

    req.user = u
    // 挂载请求级租户客户端，使独立 Router 内路由也能通过 req.db 访问数据库，
    // 无需各路由自行重复注入（修复 auditRoutes/syncRoutes 中 req.db 为 undefined 的问题）
    if (rootPrisma) {
      req.db = createTenantClient(rootPrisma, u?.schoolCode)
    }
    next()
  }

  /**
   * authorizeAdmin
   * 必须在 authenticateUser 之后使用。
   * 仅允许 role 为 'admin' 的用户通过。
   */
  function authorizeAdmin(req, res, next) {
    // #9/#11：role 必须为合法 admin，未知/非法 role 一律拒绝
    if (!req.user || req.user.role !== 'admin' || !VALID_ROLES.has(req.user.role)) {
      return res.status(403).json({ error: '❌ 需要管理员权限' })
    }
    next()
  }

  /**
   * authorizeRoles(...roles)
   * 通用角色授权，允许指定多个角色。
   * 用法：authorizeRoles('admin', 'operator')
   * 必须在 authenticateUser 之后使用。
   */
  function authorizeRoles(...roles) {
    return (req, res, next) => {
      if (!req.user || !roles.includes(req.user.role)) {
        return res.status(403).json({
          error: `❌ 权限不足，需要角色：${roles.join(' 或 ')}`
        })
      }
      next()
    }
  }

  // ====== 访客只读守卫（越权修复 + BS-09 统计依赖） ======
  // 背景：GET /api/records/:tableName、GET /api/test-records 等原先只过 authenticateUser
  // （仅校验 token 有效），guest 令牌可读取所有模块记录（含 pathogen 致病菌/阳性数据）。
  const GUEST_DENIED_TYPES = new Set(['pathogen'])
  const GUEST_DEFAULT_VISIBLE_TYPES = ['tableware', 'pesticide', 'oil', 'leanMeat']

  // M2: 访客 visible_types 内存缓存（60s TTL），避免每次请求查 DB
  const _guestVisibleTypesCache = new Map()   // schoolCode => { value, ts }
  const GUEST_VISIBLE_CACHE_TTL = 60_000      // 60 秒

  /**
   * resolveGuestVisibleTypes(schoolCode)
   * 解析该校 SchoolCustomization.visible_types（public 系统表），并强制剔除 pathogen。
   * 查询失败 / 未配置时降级为默认四大常规模块白名单（永不含 pathogen）。
   * 带 60s 内存缓存（M2），避免高并发访客访问时每次请求都查 public DB。
   */
  async function resolveGuestVisibleTypes(schoolCode) {
    const cacheKey = schoolCode || '__default__'
    const cached = _guestVisibleTypesCache.get(cacheKey)
    if (cached && (Date.now() - cached.ts) < GUEST_VISIBLE_CACHE_TTL) {
      return cached.value
    }

    let visible = null
    if (rootPrisma) {
      try {
        const rows = await rootPrisma.$queryRawUnsafe(
          `SELECT "visible_types" FROM public."SchoolCustomization" WHERE "school_code" = $1 LIMIT 1`,
          schoolCode || ''
        )
        const raw = rows?.[0]?.visible_types
        if (raw) {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
          if (Array.isArray(parsed) && parsed.length) {
            visible = parsed.filter(t => typeof t === 'string')
          }
        }
      } catch (e) {
        console.warn('[requireGuestReadOnly] visible_types 查询失败，降级默认白名单:', e.message)
      }
    }
    if (!visible || !visible.length) visible = [...GUEST_DEFAULT_VISIBLE_TYPES]
    const result = visible.filter(t => !GUEST_DENIED_TYPES.has(t))

    _guestVisibleTypesCache.set(cacheKey, { value: result, ts: Date.now() })
    return result
  }

  /**
   * requireGuestReadOnly
   * 必须在 authenticateUser 之后使用。非 guest 角色直接放行（员工端口径不变）。
   * guest 角色：
   *   1) 只读 —— 仅允许 GET/HEAD；
   *   2) 模块白名单 —— req.params.tableName 必须在该校 visible_types 内且非 pathogen；
   *   3) 挂载 req.guestVisibleTypes，供无 :tableName 参数的端点（如 /api/test-records、
   *      /api/guest/stats）在查询层强制过滤。
   */
  async function requireGuestReadOnly(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ error: '❌ 未认证' })
      }
      if (req.user.role !== 'guest') return next()

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(403).json({ error: '❌ 访客为只读角色，禁止写操作' })
      }

      const allowed = await resolveGuestVisibleTypes(req.user.schoolCode)
      req.guestVisibleTypes = allowed

      const tableName = req.params?.tableName
      if (tableName !== undefined &&
          (GUEST_DENIED_TYPES.has(tableName) || !allowed.includes(tableName))) {
        return res.status(403).json({ error: '❌ 访客无权访问该检测模块' })
      }
      next()
    } catch (error) {
      console.error('❌ requireGuestReadOnly 异常:', error)
      return res.status(500).json({ error: '访客权限校验失败' })
    }
  }

  /**
   * requireEditorOrAbove
   * 必须在 authenticateUser 之后使用。
   * 仅允许 role 不低于 editor（即 editor/operator/manager/admin）通过。
   * guest/viewer 为只读角色，拒绝写操作。
   */
  function requireEditorOrAbove(req, res, next) {
    const role = req.user?.role
    // #9/#11：仅白名单角色可进入写接口；未知/非法 role（含 token 注入的 superuser/root 等）
    // 一律拒绝，防止枚举外角色绕过写权限守卫。
    if (!role || !VALID_ROLES.has(role) || role === 'guest' || role === 'viewer') {
      return res.status(403).json({
        error: '❌ 访客无写入权限，请以正式账号登录后操作'
      })
    }
    next()
  }

  /**
   * clearGuestVisibleTypesCache(schoolCode)
   * 清除该校 visible_types 内存缓存，供 server.js 在 PUT /api/admin/schools/:code/customization
   * 成功后调用，使下一次访客请求重新从 DB 拉取最新的 visible_types。
   */
  function clearGuestVisibleTypesCache(schoolCode) {
    if (schoolCode) {
      _guestVisibleTypesCache.delete(schoolCode)
    } else {
      _guestVisibleTypesCache.clear()
    }
  }

  return { authenticateUser, authorizeAdmin, authorizeRoles, requireEditorOrAbove, requireGuestReadOnly, resolveGuestVisibleTypes, clearGuestVisibleTypesCache }
}
