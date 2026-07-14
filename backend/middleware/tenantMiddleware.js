// tenantMiddleware.js — 请求级租户路由（方案② Schema-per-tenant）
//
// 在 authenticateUser 之后调用：读取 req.user.schoolCode，
// 挂上请求级租户客户端 req.db（由 lib/tenantClient.js 构造）。
// 所有受保护路由的 handler 均通过 req.db 访问数据库，从而落在该校 schema。

import { createTenantClient, resolveSchemaName, DEFAULT_SCHEMA } from '../lib/tenantClient.js'

/**
 * 构造租户中间件。返回的函数在已认证请求上挂载 req.db 与 req.tenantSchema。
 * @param {import('@prisma/client').PrismaClient} prisma 全局 Prisma 单例
 * @param {string} [defaultSchema] dev/test 共享 schema 名，默认 public
 */
export function createTenantMiddleware(prisma, defaultSchema = DEFAULT_SCHEMA) {
  return (req, res, next) => {
    const schoolCode = req.user?.schoolCode || null
    req.tenantSchema = resolveSchemaName(schoolCode, defaultSchema)
    req.db = createTenantClient(prisma, schoolCode, defaultSchema)
    next()
  }
}

export default createTenantMiddleware
