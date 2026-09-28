/**
 * 【窗口 1】会话与身份鉴权生命周期回归测试（P3-W1-T01 / RC-02 后更新）
 * 覆盖：H1（禁用后旧 token 失效）、H2（jti 吊销 / 用户级 epoch=user_all 全量吊销）、
 *       DS3-H1（双令牌签发 / refresh 一次性轮转 / 重放语义）、
 *       DS3-M2（账号级锁定）、DS3-M3（禁用账号时序与统一记录）、
 *       RC-02（两阶段旧 token 兼容窗口：compat 接受 / strict 强制）。
 *
 * 说明：使用内存 stub 模拟 Prisma（仅测业务逻辑，不依赖 PostgreSQL）；
 * 多实例共享存储语义（真实 revoked_tokens 表）由部署环境保证，此处按同等语义模拟。
 *
 * ── P3-W1-T01 语义更新溯源（场景全部保留，仅期望随新模型修正；不删场景）──
 *   ① 统一失效模型：判定 SQL 改为 lib/sessionEpoch.buildSessionValiditySql()（单点比较），
 *      stub 相应按新的参数序 (sql, jti, userId, schoolCode, iat, idt) 模拟；
 *      令牌新增毫秒级 `idt` 声明 → 精确比较（否则退化为 iat+1 兼容边界，AUD-015）。
 *   ② 「破坏性变更：无 jti 旧 token 一律 401」→ 改为**两阶段兼容**（AUD-012/015/016 共同前提）：
 *      compat（默认）接受无 jti 旧 token（仍受 status/epoch 失效约束，安全等价）；
 *      strict（SESSION_LEGACY_TOKEN_MODE=strict）才拒绝——**不得默认全量强制重登**。
 *   ③ DS3-M2「阈值 5 → 423」：生产阈值 5、开发/测试默认放宽（1000）；本用例
 *      显式设置 LOGIN_FAIL_LOCK_THRESHOLD=5 钉死生产语义（原期望依赖放宽前的默认值）。
 *   ④ DS3-M3「禁用账号 + 错误密码 → 通用报错」：现行为文案为「密码错误」
 *      （错误密码路径与禁用路径统一为不可区分的 401；禁用状态不泄露）。
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
// P3-PUBLIC-INFRA-CHAIN-R1：形状契约（与链尾 migration 同形；stub 按它应答只读形状探针）
import { REVOKED_TOKENS_SHAPE, REVOKED_TOKENS_INDEXES } from '../backend/lib/publicInfraShape.js';
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
  // P3-W1-T01：用户级 epoch（token_type='user_all'）记录，时间用**毫秒**（与统一比较口径一致）
  const userAllRevocations = []; // { userId, revokedAtMs }

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
          // 两种写入者：
          //   · revokeAllUserTokens（历史）：(jti, user_id, school_code, reason, expires_at) → 时间取 now()
          //   · sessionEpoch.bumpUserEpoch（新模型）: (jti, user_id, school_code, reason, revoked_at, expires_at)
          const revokedAtMs = params.length >= 6 && params[4] instanceof Date ? params[4].getTime() : Date.now();
          userAllRevocations.push({ userId: params[1], revokedAtMs });
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
    // P3-W1-T01：单点校验 SQL 的参数序为 (sql, jti, userId, iat, schoolCode, idt)；
    // 命中判定与真实 SQL 同口径：jti 精确命中，或 用户级 epoch >= 阈值
    // （有 idt → 精确毫秒；无 idt → iat+1 秒兼容边界）。
    $queryRawUnsafe: jest.fn(async (sql, jti, userId, iat, schoolCode, idt) => {
      // P3-PUBLIC-INFRA-CHAIN-R1（受保护测试最小适配；**场景与断言不变**，逐项归因见该包 RESULT）：
      // 吊销表/3 索引的结构已移交链尾 migration；运行时 `ensureRevocationInfra` 改为 pg_catalog
      // **只读形状断言**（缺表/缺列/缺索引 → AUTH_INFRA_MISSING 503，不进 fail-soft）。
      // 内存 stub 按合规形状应答该探针，使既有吊销语义用例保持原断言。
      // P3-PUBLIC-INFRA-FOLLOWUP-R1（最小适配，场景/断言不变）：探针增查 indisvalid/indisready/
      // 方法/谓词/表达式 → stub 补 `is_valid/is_ready/method/is_partial/expr_cols`（健康索引恒为真）。
      if (/pg_index/.test(sql) && /indisprimary/.test(sql)) return [{ cols: ['jti'] }] // 主键探针（含 pg_attribute join，必须先于列探针判定）
      if (/pg_index/.test(sql)) return REVOKED_TOKENS_INDEXES.map((i) => ({ name: i.name, is_unique: false, is_valid: true, is_ready: true, method: 'btree', is_partial: false, expr_cols: 0, cols: [...i.columns] }))
      if (/pg_attribute/.test(sql)) {
        return REVOKED_TOKENS_SHAPE.columns.map((c) => ({ name: c.name, type: c.type, not_null: c.notNull, default_expr: c.defaultExpr }));
      }
      if (/FROM public\.revoked_tokens/i.test(sql)) {
        const thresholdMs = Number.isFinite(Number(idt)) && Number(idt) > 0
          ? Number(idt)
          : (Math.floor(Number(iat) || 0) + 1) * 1000;
        const hit =
          revokedJtis.has(jti) ||
          userAllRevocations.some((r) => r.userId === userId && r.revokedAtMs >= thresholdMs);
        return hit ? [{ hit: 1, source: 'stub', reason: 'stub' }] : [];
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

  // P3-W1-T01（RC-02）语义更新：原「不含 jti 的旧版员工 token 一律 401」= 全量强制重登（破坏性变更）。
  // 新模型为**两阶段兼容窗口**：compat（默认）接受无 jti 旧 token（仍走 status + epoch 校验，
  // 时间维度失效语义安全等价）；strict（SESSION_LEGACY_TOKEN_MODE=strict 显式运维开关）一律拒绝。
  // 场景保留：同一枚无 jti 旧 token，分别在两阶段下断言。
  test('两阶段兼容：无 jti 旧 token 在 compat 放行、strict 拒绝（AUD-012/015/016 共同前提）', async () => {
    const user = activeUser();
    const { authenticateUser } = setup(user);
    const legacyToken = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, schoolCode: null },
      SECRET, { expiresIn: '7d' }
    );

    const prevMode = process.env.SESSION_LEGACY_TOKEN_MODE;
    try {
      delete process.env.SESSION_LEGACY_TOKEN_MODE; // 阶段一（默认）
      const compat = await callAuth(authenticateUser, legacyToken);
      expect(compat.next).toHaveBeenCalled();
      expect(compat.res.status).not.toHaveBeenCalledWith(401);

      process.env.SESSION_LEGACY_TOKEN_MODE = 'strict'; // 阶段二（显式开关）
      const strict = await callAuth(authenticateUser, legacyToken);
      expect(strict.next).not.toHaveBeenCalled();
      expect(strict.res.status).toHaveBeenCalledWith(401);
      expect(strict.res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'LEGACY_TOKEN_REJECTED', phase: 'strict' })
      );
    } finally {
      if (prevMode === undefined) delete process.env.SESSION_LEGACY_TOKEN_MODE;
      else process.env.SESSION_LEGACY_TOKEN_MODE = prevMode;
    }
  });
});

describe('DS3-M2: 账号级失败锁定', () => {
  // P3-W1-T01 语义澄清（历史失败项 :259 收口）：生产阈值 5；开发/测试环境默认放宽（1000）以避免
  // 调试被锁死。本用例显式钉死**生产语义**（LOGIN_FAIL_LOCK_THRESHOLD=5），场景与期望不变。
  test('窗口内失败次数达到阈值（生产语义 5，显式钉死）→ ACCOUNT_LOCKED（423）', async () => {
    const prev = process.env.LOGIN_FAIL_LOCK_THRESHOLD;
    process.env.LOGIN_FAIL_LOCK_THRESHOLD = '5';
    try {
      const stub = makeStubPrisma({ user: activeUser(), failedLoginCount: 5 });
      const um = new UserManager(stub, SECRET);
      await expect(um.loginUser('alice', PASSWORD)).rejects.toMatchObject({
        code: 'ACCOUNT_LOCKED',
        status: 423,
      });
    } finally {
      if (prev === undefined) delete process.env.LOGIN_FAIL_LOCK_THRESHOLD;
      else process.env.LOGIN_FAIL_LOCK_THRESHOLD = prev;
    }
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

  // P3-W1-T01 语义澄清（历史失败项 :294 收口）：错误密码路径的报错文案现行实现为「密码错误」
  // （统一 401，不区分"用户已禁用"与"密码错误"——禁用状态不泄露；禁用账号 + 正确密码才返回
  // ACCOUNT_DISABLED）。场景不变，仅期望文案与新语义对齐。
  test('禁用账号 + 错误密码 → 与普通密码错误同样的通用报错（不泄露禁用状态）', async () => {
    const stub = makeStubPrisma({ user: activeUser({ status: 'disabled' }) });
    const um = new UserManager(stub, SECRET);
    await expect(um.loginUser('alice', 'WrongPass999')).rejects.toMatchObject({
      code: 'PASSWORD_WRONG',
      message: '密码错误',
      status: 401,
    });
  });
});
