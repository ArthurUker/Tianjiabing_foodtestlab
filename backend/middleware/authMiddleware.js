/**
 * authMiddleware.js — 统一认证与授权中间件
 * 所有需要保护的路由统一使用此文件的中间件，禁止在路由文件中重复实现认证逻辑。
 *
 * 依赖：UserManager 实例需在 server.js 初始化后通过工厂函数注入。
 * 用法：
 *   import { createAuthMiddleware } from '../middleware/authMiddleware.js'
 *   const { authenticateUser, authorizeAdmin, authorizeRoles } = createAuthMiddleware(userManager)
 */

/**
 * 工厂函数：接收 userManager 实例，返回一组认证/授权中间件
 * @param {UserManager} userManager
 */
import { createTenantClient } from '../lib/tenantClient.js'

export function createAuthMiddleware(userManager, prisma) {

  /**
   * authenticateUser
   * 验证请求头中的 Bearer Token，将解码后的用户信息挂载到 req.user
   * req.user 结构：{ userId, username, email, role }
   */
  function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '❌ 缺少授权令牌' })
    }

    const token = authHeader.substring(7)
    const verification = userManager.verifyToken(token)

    if (!verification.valid) {
      return res.status(401).json({ error: '❌ 令牌无效或已过期' })
    }

    req.user = verification.user
    // 挂载请求级租户客户端，使独立 Router 内路由也能通过 req.db 访问数据库，
    // 无需各路由自行重复注入（修复 auditRoutes/syncRoutes 中 req.db 为 undefined 的问题）
    if (prisma) {
      req.db = createTenantClient(prisma, req.user?.schoolCode)
    }
    next()
  }

  /**
   * authorizeAdmin
   * 必须在 authenticateUser 之后使用。
   * 仅允许 role 为 'admin' 的用户通过。
   */
  function authorizeAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
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
    if (prisma) {
      try {
        const rows = await prisma.$queryRawUnsafe(
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
    if (!role || role === 'guest' || role === 'viewer') {
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
