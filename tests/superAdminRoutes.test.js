/**
 * @jest-environment node
 *
 * 平台超管账号管理路由回归测试
 * - 新增 /api/user/super-admin/:id/reset-password
 * - 修复 /api/user/super-admin/:id 删除时 id 类型错误
 */

jest.mock('../backend/lib/tenantClient.js', () => ({
  createTenantClient: (prisma) => prisma,
  isValidSchoolCode: (c) => typeof c === 'string' && /^[a-z0-9-]{1,40}$/.test(c),
  schemaNameOf: () => null,
  resolveSchemaName: () => 'public',
  assertSafeSchemaName: (n) => n,
  disconnectAllTenantClients: async () => {},
  DEFAULT_SCHEMA: 'public',
}))

jest.mock('../backend/lib/tenantProvisioner.js', () => ({
  isValidSchoolCode: (c) => typeof c === 'string' && /^[a-z0-9-]{1,40}$/.test(c),
  provisionSchool: async () => ({ school: {} }),
}))

jest.mock('../backend/middleware/authMiddleware.js', () => ({
  createAuthMiddleware: () => ({
    authenticateUser: (req, res, next) => {
      const mockUser = req.headers['x-mock-user']
      if (!mockUser) {
        return res.status(401).json({ error: '未认证' })
      }
      try {
        req.user = JSON.parse(mockUser)
      } catch {
        return res.status(400).json({ error: 'mock user 格式错误' })
      }
      next()
    },
    authorizeAdmin: (req, res, next) => next(),
    authorizeRoles: () => (req, res, next) => next(),
  }),
  revokeToken: async () => true,
  revokeAllUserTokens: async () => {},
  isTokenRevoked: async () => false,
  getRevocationInfo: async () => null,
}))

import request from 'supertest'
import express from 'express'
import { createUserRoutes } from '../backend/routes/userRoutes.js'

const SECRET = 'unit-test-secret-1234567890'

function makeApp(userManager) {
  const app = express()
  app.use(express.json())
  app.use('/api/user', createUserRoutes(userManager))
  return app
}

function makeUserManager(overrides = {}) {
  return {
    jwtSecret: SECRET,
    rootPrisma: {},
    isStrongPassword: (pwd) => /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(pwd),
    forTenant: () => ({
      listPlatformSuperAdmins: overrides.listPlatformSuperAdmins || jest.fn(async () => []),
      createPlatformSuperAdmin: overrides.createPlatformSuperAdmin || jest.fn(async () => ({ success: true })),
      deletePlatformSuperAdmin: overrides.deletePlatformSuperAdmin || jest.fn(async () => ({ success: true })),
      resetPassword: overrides.resetPassword || jest.fn(async () => ({ success: true })),
    }),
    verifyToken: () => ({ valid: true }),
  }
}

function superAdminHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Mock-User': JSON.stringify({ userId: 'admin1', username: 'super', role: 'admin', schoolCode: null }),
  }
}

function tenantAdminHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Mock-User': JSON.stringify({ userId: 'admin2', username: 'school-admin', role: 'admin', schoolCode: 'school-a' }),
  }
}

describe('平台超管账号管理路由', () => {
  test('POST /api/user/super-admin/:id/reset-password 可被平台超管调用', async () => {
    const resetPassword = jest.fn(async () => ({ success: true, message: '密码已重置' }))
    const app = makeApp(makeUserManager({ resetPassword }))
    const res = await request(app)
      .post('/api/user/super-admin/cuid123abc/reset-password')
      .set(superAdminHeaders())
      .send({ newPassword: 'NewPassw0rd1' })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(resetPassword).toHaveBeenCalledWith('cuid123abc', 'NewPassw0rd1', expect.objectContaining({ role: 'admin', schoolCode: null }))
  })

  test('POST /api/user/super-admin/:id/reset-password 拒绝非平台超管', async () => {
    const app = makeApp(makeUserManager())
    const res = await request(app)
      .post('/api/user/super-admin/cuid123abc/reset-password')
      .set(tenantAdminHeaders())
      .send({ newPassword: 'NewPassw0rd1' })
    expect(res.status).toBe(403)
  })

  test('POST /api/user/super-admin/:id/reset-password 拒绝弱密码', async () => {
    const app = makeApp(makeUserManager())
    const res = await request(app)
      .post('/api/user/super-admin/cuid123abc/reset-password')
      .set(superAdminHeaders())
      .send({ newPassword: '12345678' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/密码/)
  })

  test('DELETE /api/user/super-admin/:id 使用字符串 cuid', async () => {
    const deletePlatformSuperAdmin = jest.fn(async () => ({ success: true }))
    const app = makeApp(makeUserManager({ deletePlatformSuperAdmin }))
    const res = await request(app)
      .delete('/api/user/super-admin/cuid_delete_001')
      .set(superAdminHeaders())
    expect(res.status).toBe(200)
    expect(deletePlatformSuperAdmin).toHaveBeenCalledWith('cuid_delete_001', 'admin1')
  })
})
