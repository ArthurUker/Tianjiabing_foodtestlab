/**
 * @jest-environment node
 *
 * 第五轮验收 · 阻塞项闭环回归测试（IF-1 / IF-2）
 *
 * IF-1（窗口1↔窗口2 吊销调用链接线）：
 *   - disableUser / changeUserRole / deleteUser / resetPassword / adminUpdateUser(角色或状态)
 *     成功后必须写入 user_all 吊销记录（revokeAllUserTokens，落 public.revoked_tokens）；
 *   - 全链路验证：降权/改密后，旧 access token 过 authenticateUser → 401（H2 即时失效）；
 *   - enableUser / adminUpdateUser 仅改资料 → 不吊销（防过度失效）；
 *   - 吊销写入失败 → 业务操作不回滚，落 SECURITY:REVOCATION_WRITE_FAILED 安全事件。
 *
 * IF-2（must_change_password 消费闭环）：
 *   - loginUser 返回 mustChangePassword 标志（顶层 + user 内）；
 *   - authenticateUser 对 must_change_password=true 的账号：非白名单接口 403
 *     （code: MUST_CHANGE_PASSWORD），白名单（change-password 等）放行；
 *   - changePassword 成功后清除 must_change_password。
 *
 * 使用内存 stub 模拟 Prisma（共享存储 revoked_tokens 语义按真实表模拟），不依赖 PostgreSQL。
 */

// mock 掉 tenantClient，避免测试环境加载 @prisma/client（需生成的客户端）
jest.mock('../backend/lib/tenantClient.js', () => ({
  createTenantClient: (prisma) => prisma,
  isValidSchoolCode: (c) => typeof c === 'string' && /^[a-z0-9-]{1,40}$/.test(c),
  schemaNameOf: () => null,
  resolveSchemaName: () => 'public',
  assertSafeSchemaName: (n) => n,
  disconnectAllTenantClients: async () => {},
  DEFAULT_SCHEMA: 'public',
}));

import bcryptjs from 'bcryptjs';
import { UserManager } from '../backend/modules/UserManager.js';
import { createAuthMiddleware } from '../backend/middleware/authMiddleware.js';

const SECRET = 'unit-test-secret-1234567890';
const PASSWORD = 'Passw0rd123';
const HASH = bcryptjs.hashSync(PASSWORD, 4);

/** 内存版 Prisma stub：模拟 User/AuditLog/SystemLog 与 public.revoked_tokens 共享存储语义 */
function makeStubPrisma({ user = null } = {}) {
  const userAllRevocations = []; // { userId, reason, revokedAtSec }
  const stub = {
    _userAll: userAllRevocations,
    user: {
      findUnique: jest.fn(async ({ where }) => {
        if (!user) return null;
        if (where.id !== undefined) return where.id === user.id ? user : null;
        if (where.username !== undefined) return where.username === user.username ? user : null;
        return null;
      }),
      update: jest.fn(async (args) => ({ ...user, ...args.data })),
      delete: jest.fn(async () => user),
      count: jest.fn(async () => 2),
    },
    testRecord: { count: jest.fn(async () => 0) },
    auditLog: {
      count: jest.fn(async () => 0),
      create: jest.fn(async (args) => args),
    },
    systemLog: { create: jest.fn(async (args) => args) },
    $transaction: jest.fn(async (cb) => cb(stub)),
    $executeRawUnsafe: jest.fn(async (sql, ...params) => {
      const s = sql.trim();
      if (/^CREATE/i.test(s) || /^DELETE/i.test(s)) return 0;
      if (/INSERT INTO public\.revoked_tokens/i.test(s) && /'user_all'/.test(s)) {
        // revokeAllUserTokens 参数序: (jti, user_id, school_code, reason, expires_at)
        userAllRevocations.push({
          userId: params[1],
          reason: params[3],
          revokedAtSec: Date.now() / 1000,
        });
        return 1;
      }
      return 1;
    }),
    $queryRawUnsafe: jest.fn(async (sql, jti, userId, iat) => {
      if (/FROM public\.revoked_tokens/i.test(sql)) {
        const hit = userAllRevocations.some(
          (r) => r.userId === userId && r.revokedAtSec >= iat
        );
        return hit ? [{ hit: 1 }] : [];
      }
      return [];
    }),
  };
  return stub;
}

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeUser(overrides = {}) {
  return {
    id: 'u1',
    username: 'operator1',
    email: null,
    full_name: '操作员一号',
    role: 'operator',
    status: 'active',
    school_code: null,
    password_hash: HASH,
    must_change_password: false,
    ...overrides,
  };
}

const managerActor = { userId: 'u-mgr', username: 'mgr', role: 'manager', schoolCode: null, ip: '1.2.3.4' };

/** 构造带旧 access token 的认证请求，过真实 authenticateUser */
async function passAuth(prisma, um, token, originalUrl = '/api/test-records') {
  const { authenticateUser } = createAuthMiddleware(um, prisma);
  const req = { headers: { authorization: `Bearer ${token}` }, originalUrl, url: originalUrl };
  const res = mockRes();
  const next = jest.fn();
  await authenticateUser(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ============================================================
// IF-1 · 高危操作后吊销全部会话（revokeAllUserTokens 接线）
// ============================================================

describe('IF-1 · 高危操作 → revokeAllUserTokens 写入 user_all 吊销', () => {
  test.each([
    ['disableUser', (um) => um.disableUser('u1', managerActor), 'user_disable'],
    ['changeUserRole', (um) => um.changeUserRole('u1', 'viewer', managerActor), 'role_change'],
    ['deleteUser', (um) => um.deleteUser('u1', managerActor), 'user_delete'],
    ['resetPassword', (um) => um.resetPassword('u1', 'NewPassw0rd1', managerActor), 'password_reset'],
    ['adminUpdateUser(role)', (um) => um.adminUpdateUser('u1', { role: 'viewer' }, managerActor), 'admin_update_user'],
    ['adminUpdateUser(status)', (um) => um.adminUpdateUser('u1', { status: 'disabled' }, managerActor), 'admin_update_user'],
  ])('%s 成功后写入吊销记录（reason=%s）', async (_name, op, expectedReason) => {
    const prisma = makeStubPrisma({ user: makeUser() });
    const um = new UserManager(prisma, SECRET);
    const result = await op(um);
    expect(result.success).toBe(true);
    expect(prisma._userAll).toHaveLength(1);
    expect(prisma._userAll[0]).toMatchObject({ userId: 'u1', reason: expectedReason });
  });

  test('enableUser 不吊销（启用无需强制下线）', async () => {
    const prisma = makeStubPrisma({ user: makeUser({ status: 'disabled' }) });
    const um = new UserManager(prisma, SECRET);
    await um.enableUser('u1', managerActor);
    expect(prisma._userAll).toHaveLength(0);
  });

  test('adminUpdateUser 仅改资料（full_name）不吊销（防过度失效）', async () => {
    const prisma = makeStubPrisma({ user: makeUser() });
    const um = new UserManager(prisma, SECRET);
    await um.adminUpdateUser('u1', { full_name: '新名字' }, managerActor);
    expect(prisma._userAll).toHaveLength(0);
  });

  test('吊销写入失败 → 业务操作不回滚，落 SECURITY:REVOCATION_WRITE_FAILED', async () => {
    const prisma = makeStubPrisma({ user: makeUser() });
    // 令 revoked_tokens 写入失败（业务 update 已成功）
    prisma.$executeRawUnsafe.mockRejectedValue(new Error('db down'));
    const um = new UserManager(prisma, SECRET);
    const result = await um.disableUser('u1', managerActor);
    expect(result.success).toBe(true);
    // 安全事件落 SystemLog（SECURITY:REVOCATION_WRITE_FAILED）
    const calls = prisma.systemLog.create.mock.calls.map(([a]) => a?.data?.message || '');
    expect(calls.some((m) => m.includes('SECURITY:REVOCATION_WRITE_FAILED'))).toBe(true);
  });
});

describe('IF-1 · H2 全链路：降权/改密后旧 access token 立即 401', () => {
  test('changeUserRole 降权后：旧 token 过 authenticateUser → 401（用户仍 active）', async () => {
    const user = makeUser();
    const prisma = makeStubPrisma({ user });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    // 未降权前：旧 token 正常通过
    const before = await passAuth(prisma, um, token);
    expect(before.next).toHaveBeenCalled();

    // 降权（写入吊销后 revokedAt >= iat）
    await um.changeUserRole('u1', 'viewer', managerActor);
    user.role = 'viewer'; // DB 权威角色已变，但用户仍 active

    const after = await passAuth(prisma, um, token);
    expect(after.next).not.toHaveBeenCalled();
    expect(after.res.status).toHaveBeenCalledWith(401);
  });

  test('resetPassword 改密后：旧 token → 401（被盗 token 不再存活至 TTL）', async () => {
    const user = makeUser();
    const prisma = makeStubPrisma({ user });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    await um.resetPassword('u1', 'NewPassw0rd1', managerActor);

    const { res, next } = await passAuth(prisma, um, token);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ============================================================
// IF-2 · must_change_password 消费闭环
// ============================================================

describe('IF-2 · loginUser 返回 mustChangePassword 标志', () => {
  test('临时密码账号登录 → mustChangePassword:true（顶层 + user 内）', async () => {
    const prisma = makeStubPrisma({ user: makeUser({ must_change_password: true }) });
    const um = new UserManager(prisma, SECRET);
    const result = await um.loginUser('operator1', PASSWORD);
    expect(result.success).toBe(true);
    expect(result.mustChangePassword).toBe(true);
    expect(result.user.mustChangePassword).toBe(true);
  });

  test('正常账号登录 → mustChangePassword:false', async () => {
    const prisma = makeStubPrisma({ user: makeUser() });
    const um = new UserManager(prisma, SECRET);
    const result = await um.loginUser('operator1', PASSWORD);
    expect(result.mustChangePassword).toBe(false);
  });
});

describe('IF-2 · authenticateUser 服务端强制拦截（不依赖前端自觉）', () => {
  test('must_change_password=true → 业务接口 403（code: MUST_CHANGE_PASSWORD）', async () => {
    const user = makeUser({ must_change_password: true });
    const prisma = makeStubPrisma({ user });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    const { res, next } = await passAuth(prisma, um, token, '/api/test-records');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MUST_CHANGE_PASSWORD' })
    );
  });

  test('白名单接口（change-password）放行，允许完成改密', async () => {
    const user = makeUser({ must_change_password: true });
    const prisma = makeStubPrisma({ user });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    const { next } = await passAuth(prisma, um, token, '/api/user/change-password');
    expect(next).toHaveBeenCalled();
  });

  test('flag=false 的正常用户不受影响（业务接口放行）', async () => {
    const user = makeUser();
    const prisma = makeStubPrisma({ user });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    const { next } = await passAuth(prisma, um, token, '/api/test-records');
    expect(next).toHaveBeenCalled();
  });
});

describe('IF-2 · changePassword 清除 must_change_password（恢复正常访问）', () => {
  test('改密成功 → update 带 must_change_password:false', async () => {
    const prisma = makeStubPrisma({ user: makeUser({ must_change_password: true }) });
    const um = new UserManager(prisma, SECRET);
    const result = await um.changePassword('u1', PASSWORD, 'NewPassw0rd1');
    expect(result.success).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ must_change_password: false }),
      })
    );
  });

  test('改密后旧 token 被吊销 → 401；新登录 token → 放行（闭环）', async () => {
    const user = makeUser({ must_change_password: true });
    const prisma = makeStubPrisma({ user });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    await um.changePassword('u1', PASSWORD, 'NewPassw0rd1');
    user.must_change_password = false; // 模拟 DB 更新后的权威状态

    // IF-1: changePassword 会 revokeUserSessions（吊销全部旧会话，防密码泄露后旧 token 存活）→ 旧 token 应 401
    const oldRes = mockRes();
    const oldNext = jest.fn();
    await createAuthMiddleware(um, prisma).authenticateUser(
      { headers: { authorization: `Bearer ${token}` }, originalUrl: '/api/test-records', url: '/api/test-records' },
      oldRes, oldNext
    );
    expect(oldNext).not.toHaveBeenCalled();
    expect(oldRes.status).toHaveBeenCalledWith(401);

    // 改密后重新登录（新 jti）→ must_change_password 已清 + 无吊销命中 → 放行。
    // 真实场景：重新登录必然晚于吊销时刻，这里 sleep 1.1s 越过 stub 秒级精度窗口
    // （真实 DB 中 revoked_at 为毫秒级时间戳，而 jwt iat 为秒级，需保证 iat 严格晚于 revoked_at）。
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = um.buildAccessToken(user);
    const newRes = mockRes();
    const newNext = jest.fn();
    await createAuthMiddleware(um, prisma).authenticateUser(
      { headers: { authorization: `Bearer ${fresh.token}` }, originalUrl: '/api/test-records', url: '/api/test-records' },
      newRes, newNext
    );
    expect(newNext).toHaveBeenCalled();
  });
});
