/**
 * @jest-environment node
 *
 * H4-ext / #8 · DB 回查失败降级（fail-soft → fail-closed 折中） + #9 角色覆盖枚举校验
 *
 * 不依赖真实 PostgreSQL（内存 stub）。通过让回查 user.findUnique 抛错模拟 DB 抖动，
 * 验证：
 *   - 连续失败 < 阈值：沿用 token 角色 fail-soft 放行（next 调用，不 503）；
 *   - 连续失败 >= 阈值（默认 3）：fail-closed 返回 503；
 *   - 回查恢复后计数清零，1 次失败不再 503；
 *   - #9：DB role 为非法值/NULL 时，不覆盖 token 角色（防绕过）。
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

import bcryptjs from 'bcryptjs';
import { UserManager } from '../backend/modules/UserManager.js';
import { createAuthMiddleware, getRecheckFailState, _resetRecheckFailStateForTest } from '../backend/middleware/authMiddleware.js';

const SECRET = 'unit-test-secret-1234567890';
const PASSWORD = 'Passw0rd123';
const HASH = bcryptjs.hashSync(PASSWORD, 4);

function makeUser(overrides = {}) {
  return {
    id: 'u1',
    username: 'operator1',
    role: 'operator',
    status: 'active',
    school_code: null,
    password_hash: HASH,
    must_change_password: false,
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

// stub：user.findUnique 可配置为抛错或返回指定对象，isTokenRevoked 默认未吊销
function makeStubPrisma({ user, findUniqueImpl }) {
  const stub = {
    user: {
      findUnique:
        findUniqueImpl ||
        jest.fn(async ({ where }) => {
          if (!user) return null;
          if (where.id !== undefined) return where.id === user.id ? user : null;
          return null;
        }),
      update: jest.fn(async (args) => ({ ...user, ...args.data })),
      delete: jest.fn(async () => user),
    },
    $queryRawUnsafe: jest.fn(async () => []), // isTokenRevoked 未命中
    $executeRawUnsafe: jest.fn(async () => 1),
  };
  return stub;
}

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
  _resetRecheckFailStateForTest(); // 重置进程级连续失败计数，保证用例独立
});

describe('#8 · DB 回查失败降级（fail-soft → fail-closed 折中）', () => {
  test('连续失败 < 阈值：fail-soft 放行（沿用 token 角色，不 503）', async () => {
    const user = makeUser();
    const dbErr = jest.fn(async () => { throw new Error('db down') });
    const prisma = makeStubPrisma({ user, findUniqueImpl: dbErr });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    for (let i = 1; i <= 2; i++) {
      const { res, next } = await passAuth(prisma, um, token);
      expect(res.status).not.toHaveBeenCalledWith(503);
      expect(next).toHaveBeenCalled();
      const state = getRecheckFailState();
      expect(state.consecutiveFails).toBe(i);
      expect(state.isFailClosed).toBe(false);
    }
  });

  test('连续失败达阈值（3）：fail-closed 返回 503', async () => {
    const user = makeUser();
    const dbErr = jest.fn(async () => { throw new Error('db down') });
    const prisma = makeStubPrisma({ user, findUniqueImpl: dbErr });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    // 第 1、2 次：放行
    await passAuth(prisma, um, token);
    await passAuth(prisma, um, token);
    // 第 3 次：fail-closed
    const third = await passAuth(prisma, um, token);
    expect(third.res.status).toHaveBeenCalledWith(503);
    expect(third.next).not.toHaveBeenCalled();
    expect(getRecheckFailState().isFailClosed).toBe(true);
  });

  test('回查恢复后计数清零：1 次失败不再 503', async () => {
    const user = makeUser();
    const dbErr = jest.fn(async () => { throw new Error('db down') });
    const prisma = makeStubPrisma({ user, findUniqueImpl: dbErr });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    // 先打满阈值，进入 fail-closed
    await passAuth(prisma, um, token);
    await passAuth(prisma, um, token);
    const third = await passAuth(prisma, um, token);
    expect(third.res.status).toHaveBeenCalledWith(503);

    // 恢复：findUnique 正常返回 active 用户
    const okPrisma = makeStubPrisma({ user });
    const { next, res } = await passAuth(okPrisma, um, token);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(getRecheckFailState().consecutiveFails).toBe(0);
    expect(getRecheckFailState().isFailClosed).toBe(false);
  });
});

describe('#9 · 角色覆盖枚举校验（防 NULL/非法值绕过）', () => {
  test('DB role 为非法值：不覆盖 token 角色（沿用旧角色）', async () => {
    const user = makeUser({ role: 'operator' });
    const dbUser = { ...user, role: 'superadmin' }; // 非法
    const prisma = makeStubPrisma({ user: dbUser });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    const { req, next } = await passAuth(prisma, um, token);
    expect(next).toHaveBeenCalled();
    expect(req.user.role).toBe('operator'); // 未被非法值覆盖
  });

  test('DB role 为 NULL：不覆盖 token 角色', async () => {
    const user = makeUser({ role: 'manager' });
    const dbUser = { ...user, role: null };
    const prisma = makeStubPrisma({ user: dbUser });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    const { req, next } = await passAuth(prisma, um, token);
    expect(next).toHaveBeenCalled();
    expect(req.user.role).toBe('manager');
  });

  test('DB role 为合法且不同：正常覆盖（保持 H1-ext 行为）', async () => {
    const user = makeUser({ role: 'viewer' });
    const dbUser = { ...user, role: 'manager' };
    const prisma = makeStubPrisma({ user: dbUser });
    const um = new UserManager(prisma, SECRET);
    const { token } = um.buildAccessToken(user);

    const { req, next } = await passAuth(prisma, um, token);
    expect(next).toHaveBeenCalled();
    expect(req.user.role).toBe('manager');
  });
});
