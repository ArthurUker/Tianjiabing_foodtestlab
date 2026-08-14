/**
 * @jest-environment node
 *
 * R2-07 / 架构优化计划 P0-2：
 * requireEditorOrAbove 白名单越权回归测试。
 *
 * 背景：修复前 server.js 本地版 requireEditorOrAbove 仅判 guest/viewer，
 * 对 token 注入的非法角色（superuser/root/editor 等）直接放行，绕过写权限守卫。
 * 修复后：统一使用工厂版（含 VALID_ROLES 白名单），非法角色一律 403。
 *
 * requireEditorOrAbove 为纯函数（只读 req.user.role），不依赖 userManager/prisma，
 * 故传空 stub 即可调用；且测试环境（NODE_ENV=test）会跳过吊销基础设施初始化。
 */

// authMiddleware 间接 import tenantClient → @prisma/client，后者加载时会读取 backend/.env；
// 测试以非服务用户运行无读取权限，故 mock 掉 tenantClient 避免拉起真实 PrismaClient（与 refreshConcurrencyBackend 一致）。
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

const { requireEditorOrAbove } = createAuthMiddleware({}, {});

function run(role) {
  const req = { user: role ? { role } : {} };
  const res = {
    statusCode: 0,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nextCalled = false;
  requireEditorOrAbove(req, res, () => { nextCalled = true; });
  return { status: res.statusCode, nextCalled, body: res.body };
}

describe('requireEditorOrAbove · 白名单越权回归', () => {
  test('合法写角色（admin/manager/operator）通过', () => {
    for (const role of ['admin', 'manager', 'operator']) {
      const r = run(role);
      expect(r.nextCalled).toBe(true);
      expect(r.status).toBe(0);
    }
  });

  test('只读角色 viewer 被拒 403', () => {
    const r = run('viewer');
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(403);
  });

  test('访客 guest 被拒 403', () => {
    const r = run('guest');
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(403);
  });

  test('非法注入角色（superuser/root/editor/super_admin/god）被白名单拒绝 403', () => {
    for (const role of ['superuser', 'root', 'editor', 'super_admin', 'god']) {
      const r = run(role);
      expect(r.nextCalled).toBe(false);
      expect(r.status).toBe(403);
    }
  });

  test('缺失 role 被拒 403', () => {
    const r = run(undefined);
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(403);
  });
});
