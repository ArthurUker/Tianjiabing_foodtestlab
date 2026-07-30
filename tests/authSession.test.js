/**
 * 【窗口 1】会话与身份鉴权生命周期回归测试
 * 覆盖：H1（禁用后旧 token 失效）、H2（jti 吊销 / user_all 全量吊销）、
 *       DS3-H1（双令牌签发 / refresh 一次性轮转 / 重放语义）、
 *       DS3-M2（账号级锁定）、DS3-M3（禁用账号时序与统一记录）。
 *
 * 说明：使用内存 stub 模拟 Prisma（仅测业务逻辑，不依赖 PostgreSQL）；
 * 多实例共享存储语义（真实 revoked_tokens 表）由部署环境保证，此处按同等语义模拟。
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

import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import { UserManager } from '../backend/modules/UserManager.js';
import {
  createAuthMiddleware,
  revokeToken,
  revokeAllUserTokens,
  isTokenRevoked,
} from '../backend/middleware/authMiddleware.js';

const SECRET = 'unit-test-secret-1234567890';
const PASSWORD = 'Passw0rd123';
const HASH = bcryptjs.hashSync(PASSWORD, 4);

/** 内存版 Prisma stub：模拟 User/AuditLog 与 public.revoked_tokens 的共享存储语义 */
function makeStubPrisma({ user = null, guest = null, failedLoginCount = 0 } = {}) {
  const revokedJtis = new Set();
  const userAllRevocations = []; // { userId, revokedAtSec }

  const stub = {
    _revokedJtis: revokedJtis,
    _userAll: userAllRevocations,
    user: {
      findUnique: jest.fn(async ({ where }) => {
        if (!user) return null;
        for (const [k, v] of Object.entries(where)) {
          if (user[k] !== v) return null;
        }
        return user;
      }),
      update: jest.fn(async () => user),
    },
    guest: { findUnique: jest.fn(async () => guest) },
    auditLog: {
      count: jest.fn(async () => failedLoginCount),
      create: jest.fn(async (args) => args),
    },
    systemLog: { create: jest.fn(async (args) => args) },
    $executeRawUnsafe: jest.fn(async (sql, ...params) => {
      const s = sql.trim();
      if (/^CREATE/i.test(s)) return 0;
      if (/^DELETE/i.test(s)) return 0;
      if (/INSERT INTO public\.revoked_tokens/i.test(s)) {
        if (/'user_all'/.test(s)) {
          // revokeAllUserTokens: (jti, user_id, school_code, reason, expires_at)
          userAllRevocations.push({ userId: params[1], revokedAtSec: Date.now() / 1000 });
          return 1;
        }
        // revokeToken: (jti, user_id, school_code, token_type, reason, expires_at) ON CONFLICT DO NOTHING
        const jti = params[0];
        if (revokedJtis.has(jti)) return 0;
        revokedJtis.add(jti);
        return 1;
      }
      return 1;
    }),
    $queryRawUnsafe: jest.fn(async (sql, jti, userId, iat) => {
      if (/FROM public\.revoked_tokens/i.test(sql)) {
        const hit =
          revokedJtis.has(jti) ||
          userAllRevocations.some((r) => r.userId === userId && r.revokedAtSec >= iat);
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

function activeUser(overrides = {}) {
  return {
    id: 'u1',
    username: 'alice',
    email: null,
    full_name: 'Alice',
    role: 'operator',
    status: 'active',
    school_code: null,
    password_hash: HASH,
    ...overrides,
  };
}

describe('DS3-H1: 双令牌签发（access 短 TTL + refresh 独立密钥）', () => {
  const um = new UserManager(makeStubPrisma(), SECRET);

  test('buildAccessToken 携带 jti，默认 TTL 30 分钟', () => {
    const { token, expiresIn, jti } = um.buildAccessToken(activeUser());
    expect(jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(expiresIn).toBe(30 * 60);
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    expect(decoded.jti).toBe(jti);
    expect(decoded.type).toBeUndefined();
  });

  test('两次签发的 jti 不重复', () => {
    expect(um.buildAccessToken(activeUser()).jti).not.toBe(um.buildAccessToken(activeUser()).jti);
  });

  test('refresh token 使用独立密钥且 type=refresh，verifyRefreshToken 可验签', () => {
    const { refreshToken, refreshExpiresIn } = um.buildRefreshToken(activeUser());
    expect(refreshExpiresIn).toBe(7 * 86400);
    // access 密钥验不过 refresh token（独立密钥）
    expect(() => jwt.verify(refreshToken, SECRET)).toThrow();
    const decoded = um.verifyRefreshToken(refreshToken);
    expect(decoded.type).toBe('refresh');
    expect(decoded.jti).toBeTruthy();
    expect(decoded.userId).toBe('u1');
  });

  test('类型隔离：access token 不能当 refresh 用，refresh token 不能当 access 用', () => {
    const { token } = um.buildAccessToken(activeUser());
    expect(() => um.verifyRefreshToken(token)).toThrow(/无效/);
    const { refreshToken } = um.buildRefreshToken(activeUser());
    expect(um.verifyToken(refreshToken).valid).toBe(false);
  });

  test('登录成功同时返回 access + refresh 双令牌', async () => {
    const stub = makeStubPrisma({ user: activeUser() });
    const manager = new UserManager(stub, SECRET);
    const result = await manager.loginUser('alice', PASSWORD);
    expect(result.token).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.expiresIn).toBe(30 * 60);
    expect(result.refreshExpiresIn).toBe(7 * 86400);
  });
});

describe('DS3-H1: refresh token 一次性轮转与重放语义（吊销存储）', () => {
  test('同一 refresh jti 第一次写入吊销成功，第二次返回 false（= 重放）', async () => {
    const stub = makeStubPrisma();
    const args = { jti: 'r-jti-1', userId: 'u1', tokenType: 'refresh', reason: 'rotated', expiresAt: new Date(Date.now() + 1000) };
    expect(await revokeToken(stub, args)).toBe(true);
    expect(await revokeToken(stub, args)).toBe(false); // 重放检测依赖此语义
  });

  test('revokeAllUserTokens 后，早于吊销时间签发的令牌全部判定为已吊销', async () => {
    const stub = makeStubPrisma();
    const iat = Math.floor(Date.now() / 1000) - 10; // 10 秒前签发
    await revokeAllUserTokens(stub, { userId: 'u1', reason: 'refresh_replay' });
    expect(await isTokenRevoked(stub, { jti: 'any-new-jti', userId: 'u1', iat })).toBe(true);
    expect(await isTokenRevoked(stub, { jti: 'any', userId: 'other-user', iat })).toBe(false);
  });
});

describe('H1/H2: authenticateUser 状态回查与吊销校验', () => {
  function setup(user, stubOverrides = {}) {
    const stub = makeStubPrisma({ user, ...stubOverrides });
    const um = new UserManager(stub, SECRET);
    const { authenticateUser } = createAuthMiddleware(um, stub);
    return { stub, um, authenticateUser };
  }

  function callAuth(authenticateUser, token) {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();
    return authenticateUser(req, res, next).then(() => ({ req, res, next }));
  }

  test('有效令牌 + active 用户 → 放行', async () => {
    const user = activeUser();
    const { um, authenticateUser } = setup(user);
    const { token } = um.buildAccessToken(user);
    const { res, next } = await callAuth(authenticateUser, token);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('H1: 用户被禁用后，未过期的旧 access token 立即 401', async () => {
    const user = activeUser();
    const { stub, um, authenticateUser } = setup(user);
    const { token } = um.buildAccessToken(user);
    user.status = 'disabled'; // 模拟 disableUser 之后
    const { res, next } = await callAuth(authenticateUser, token);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(stub.user.findUnique).toHaveBeenCalled(); // 确认发生了 DB 回查
  });

  test('H1: 用户被删除后旧 token 立即 401', async () => {
    const user = activeUser();
    const { um, authenticateUser } = setup(user);
    const { token } = um.buildAccessToken(user);
    const stub2 = makeStubPrisma({ user: null }); // 用户已不存在
    const um2 = new UserManager(stub2, SECRET);
    const { authenticateUser: auth2 } = createAuthMiddleware(um2, stub2);
    const { res, next } = await callAuth(auth2, token);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('H2: jti 写入吊销表后，该 token 立即 401', async () => {
    const user = activeUser();
    const { stub, um, authenticateUser } = setup(user);
    const { token, jti } = um.buildAccessToken(user);
    await revokeToken(stub, { jti, userId: user.id, expiresAt: new Date(Date.now() + 3600e3) });
    const { res, next } = await callAuth(authenticateUser, token);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('H2: revokeAllUserTokens（重放触发的全量吊销）使该用户所有旧 token 失效', async () => {
    const user = activeUser();
    const { stub, um, authenticateUser } = setup(user);
    const { token } = um.buildAccessToken(user);
    await new Promise((r) => setTimeout(r, 1100)); // 确保吊销时间晚于签发时间（秒级精度）
    await revokeAllUserTokens(stub, { userId: user.id, reason: 'refresh_replay' });
    const { res, next } = await callAuth(authenticateUser, token);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('破坏性变更：不含 jti 的旧版员工 token 一律 401', async () => {
    const user = activeUser();
    const { authenticateUser } = setup(user);
    const legacyToken = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, schoolCode: null },
      SECRET, { expiresIn: '7d' }
    );
    const { res, next } = await callAuth(authenticateUser, legacyToken);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('DS3-M2: 账号级失败锁定', () => {
  test('窗口内失败次数达到阈值（默认 5）→ ACCOUNT_LOCKED（423）', async () => {
    const stub = makeStubPrisma({ user: activeUser(), failedLoginCount: 5 });
    const um = new UserManager(stub, SECRET);
    await expect(um.loginUser('alice', PASSWORD)).rejects.toMatchObject({
      code: 'ACCOUNT_LOCKED',
      status: 423,
    });
  });

  test('失败次数低于阈值时正常登录', async () => {
    const stub = makeStubPrisma({ user: activeUser(), failedLoginCount: 4 });
    const um = new UserManager(stub, SECRET);
    const result = await um.loginUser('alice', PASSWORD);
    expect(result.success).toBe(true);
  });

  test('计数存储故障时 fail-open（不误锁全员）', async () => {
    const stub = makeStubPrisma({ user: activeUser() });
    stub.auditLog.count.mockRejectedValue(new Error('db down'));
    const um = new UserManager(stub, SECRET);
    const result = await um.loginUser('alice', PASSWORD);
    expect(result.success).toBe(true);
  });
});

describe('DS3-M3: 禁用账号登录路径（时序与记录）', () => {
  test('禁用账号 + 正确密码 → 抛"该用户已被禁用"，且统一记录 login_failed', async () => {
    const stub = makeStubPrisma({ user: activeUser({ status: 'disabled' }) });
    const um = new UserManager(stub, SECRET);
    await expect(um.loginUser('alice', PASSWORD)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(stub.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'login_failed' }) })
    );
  });

  test('禁用账号 + 错误密码 → 与普通密码错误同样的通用报错（不泄露禁用状态）', async () => {
    const stub = makeStubPrisma({ user: activeUser({ status: 'disabled' }) });
    const um = new UserManager(stub, SECRET);
    await expect(um.loginUser('alice', 'WrongPass999')).rejects.toThrow('用户不存在或密码错误');
  });
});
