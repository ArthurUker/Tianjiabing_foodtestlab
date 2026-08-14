/**
 * @jest-environment node
 *
 * H5-ext / #11 · 角色-守卫权限矩阵回归测试
 *
 * 直接对两个核心授权守卫做矩阵断言（无真实 PG 依赖，纯函数式 stub）：
 *   - requireEditorOrAbove：editor/operator/manager/admin 放行，guest/viewer 拒绝（403）
 *   - authorizeAdmin：仅 admin 放行，其余全部拒绝（403）
 *   - requirePlatformSuperAdmin（server.js 本地函数逻辑复刻断言）：
 *       仅 "role=admin 且 schoolCode 为空（平台超管）" 放行；
 *       admin 但带 schoolCode（某校 admin）拒绝；其余角色拒绝。
 *
 * 目的：锁定 RBAC 矩阵，防止后续"角色覆盖/降级策略"改动无意放宽写接口或超管接口权限。
 */

jest.mock('../backend/lib/tenantClient.js', () => ({
  createTenantClient: (prisma) => prisma,
  isValidSchoolCode: (c) => typeof c === 'string' && /^[a-z0-9-]{1,40}$/.test(c),
  schemaNameOf: () => null,
  resolveSchemaName: () => 'public',
  assertSafeSchemaName: (n) => n,
  disconnectAllTenantClients: async () => {},
  DEFAULT_SCHEMA: 'public',
}));

import { createAuthMiddleware } from '../backend/middleware/authMiddleware.js';

const ROLES = ['admin', 'manager', 'operator', 'viewer', 'guest'];

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

// 复刻 server.js requirePlatformSuperAdmin 逻辑（避免拉起整个 server 造成连接占用）
function requirePlatformSuperAdmin(req, res, next) {
  const role = req.user?.role ?? req.userRole;
  const schoolCode = req.user?.schoolCode || null;
  if (role !== 'admin' || schoolCode) {
    return res.status(403).json({ error: '需要平台超管权限' });
  }
  return next();
}

describe('#11 · 角色-守卫权限矩阵', () => {
  // 无需真实 prisma：守卫仅依赖 req.user，createAuthMiddleware 在 NODE_ENV=test 跳过 infra
  process.env.NODE_ENV = 'test';
  const { requireEditorOrAbove, authorizeAdmin } = createAuthMiddleware(null, null);

  describe('requireEditorOrAbove（写接口守卫）', () => {
    test.each(ROLES)('role=%s 的结果符合预期', (role) => {
      const req = { user: { role, schoolCode: null } };
      const res = mockRes();
      let called = false;
      requireEditorOrAbove(req, res, () => { called = true });
      const shouldPass = ['admin', 'manager', 'operator'].includes(role); // editor 名已弃用，等价 operator
      if (shouldPass) {
        expect(called).toBe(true);
        expect(res.status).not.toHaveBeenCalled();
      } else {
        expect(called).toBe(false);
        expect(res.status).toHaveBeenCalledWith(403);
      }
    });
  });

  describe('authorizeAdmin（管理接口守卫）', () => {
    test.each(ROLES)('role=%s 的结果符合预期', (role) => {
      const req = { user: { role, schoolCode: null } };
      const res = mockRes();
      let called = false;
      authorizeAdmin(req, res, () => { called = true });
      if (role === 'admin') {
        expect(called).toBe(true);
        expect(res.status).not.toHaveBeenCalled();
      } else {
        expect(called).toBe(false);
        expect(res.status).toHaveBeenCalledWith(403);
      }
    });
  });

  describe('requirePlatformSuperAdmin（平台超管守卫）', () => {
    test('role=admin 且 schoolCode 为空 → 放行', () => {
      const req = { user: { role: 'admin', schoolCode: null } };
      const res = mockRes();
      let called = false;
      requirePlatformSuperAdmin(req, res, () => { called = true });
      expect(called).toBe(true);
      expect(res.status).not.toHaveBeenCalled();
    });

    test('role=admin 但带有 schoolCode（某校 admin） → 拒绝 403', () => {
      const req = { user: { role: 'admin', schoolCode: 'school_tjb' } };
      const res = mockRes();
      let called = false;
      requirePlatformSuperAdmin(req, res, () => { called = true });
      expect(called).toBe(false);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test.each(['manager', 'operator', 'viewer', 'guest'])('role=%s 即使无 schoolCode 也拒绝 403', (role) => {
      const req = { user: { role, schoolCode: null } };
      const res = mockRes();
      let called = false;
      requirePlatformSuperAdmin(req, res, () => { called = true });
      expect(called).toBe(false);
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('#9 兜底：非法/未知 role 一律拒绝所有写/管理守卫', () => {
    test.each(['', 'superuser', 'root', null, undefined])('role=%p 被 requireEditorOrAbove 拒绝', (role) => {
      const req = { user: { role, schoolCode: null } };
      const res = mockRes();
      let called = false;
      requireEditorOrAbove(req, res, () => { called = true });
      expect(called).toBe(false);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test.each(['', 'superuser', 'root', null, undefined])('role=%p 被 authorizeAdmin 拒绝', (role) => {
      const req = { user: { role, schoolCode: null } };
      const res = mockRes();
      let called = false;
      authorizeAdmin(req, res, () => { called = true });
      expect(called).toBe(false);
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
