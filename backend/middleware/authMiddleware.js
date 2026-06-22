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
export function createAuthMiddleware(userManager) {

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

  return { authenticateUser, authorizeAdmin, authorizeRoles }
}
