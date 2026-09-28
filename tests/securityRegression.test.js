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
 *   - 吊销写入失败 → **业务与 epoch 写在同一事务内整体回滚，错误上抛**（无半提交、无 epoch 行）。
 *     【P3-CLOSE-T01 语义修订，溯源】原行为「业务操作不回滚 + 落 SECURITY:REVOCATION_WRITE_FAILED」
 *     是 AUD-016 明确废除的旧语义（P3-W1-T01 / RC-02 改为同事务）；
 *     本文件该用例的场景（吊销写失败）保留，仅断言随新语义更新（回滚证明改用可信事务替身）。
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
// P3-PUBLIC-INFRA-CHAIN-R1：形状契约（与链尾 migration 同形；stub 按它应答只读形状探针）
import { REVOKED_TOKENS_SHAPE, REVOKED_TOKENS_INDEXES } from '../backend/lib/publicInfraShape.js';

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
      // P3-PUBLIC-INFRA-CHAIN-R1（受保护测试最小适配；**场景与断言不变**，逐项归因见该包 RESULT）：
      // 吊销表结构移交链尾 migration 后，运行时改用 pg_catalog 只读形状断言（缺结构 → AUTH_INFRA_MISSING 503）。
      // stub 按合规形状应答该探针；既有吊销语义分支不变。
      // P3-PUBLIC-INFRA-FOLLOWUP-R1（最小适配，场景/断言不变）：探针增查 indisvalid/indisready/方法/谓词/表达式
      // → 索引行补 `is_valid/is_ready/method/is_partial/expr_cols`（健康索引恒为真）。
      if (/pg_index/.test(sql) && /indisprimary/.test(sql)) return [{ cols: ['jti'] }] // 主键探针（含 pg_attribute join，必须先于列探针判定）
      if (/pg_index/.test(sql)) return REVOKED_TOKENS_INDEXES.map((i) => ({ name: i.name, is_unique: false, is_valid: true, is_ready: true, method: 'btree', is_partial: false, expr_cols: 0, cols: [...i.columns] }))
      if (/pg_attribute/.test(sql)) {
        return REVOKED_TOKENS_SHAPE.columns.map((c) => ({ name: c.name, type: c.type, not_null: c.notNull, default_expr: c.defaultExpr }));
      }
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

/**
 * P3-CLOSE-T01：**可信事务替身**（只服务 AUD-016「整体回滚」证明用例）。
 *
 * 与 `makeStubPrisma` 的差异在于 `$transaction` 真实模拟事务语义，而不是"直接回调"：
 *   · 业务写（tx.user.update）在事务内**确实执行并落地到存储**（可观测 status=disabled）；
 *   · epoch 写失败（`failNextEpochWrite` 注入）→ 事务内已执行的写入按**撤销日志逆序回滚**，
 *     存储复原为事务开始前状态，随后把原始错误上抛（与真实 DB 回滚语义一致）；
 *   · 因此判定依据不是「user.update 未被调用」——回滚证明 = ①写入在事务内生效过
 *     ②回滚后存储状态复原 ③无 epoch 行。epoch 写入行本身也进入撤销日志（成功即提交）。
 */
function makeTransactionalStubPrisma({ user = null } = {}) {
  const state = { user: user ? { ...user } : null, revoked: new Map() };
  const calls = { txUserUpdate: 0, epochWriteAttempts: 0, statusSeenInsideTx: null, rolledBack: false };
  let epochFailure = null;

  function runTransaction(cb) {
    const undo = []; // 撤销日志（逆序执行 = 回滚）
    const tx = {
      user: {
        update: jest.fn(async ({ data }) => {
          const prev = state.user ? { ...state.user } : null;
          state.user = { ...state.user, ...data };
          calls.txUserUpdate += 1;
          calls.statusSeenInsideTx = state.user.status;
          undo.push(() => { state.user = prev });
          return { ...state.user };
        }),
      },
      $executeRawUnsafe: jest.fn(async (sql, ...params) => {
        if (!/INSERT INTO public\.revoked_tokens/i.test(sql)) return 0;
        calls.epochWriteAttempts += 1;
        if (epochFailure) throw epochFailure; // epoch 写失败：本行不落地，交由回滚撤销业务写
        const [jti, userId, schoolCode, reason] = params;
        const prev = state.revoked.has(jti) ? state.revoked.get(jti) : null;
        state.revoked.set(jti, {
          jti, userId, schoolCode, reason,
          type: /'school_epoch'/.test(sql) ? 'school_epoch' : 'user_all',
        });
        undo.push(() => { if (prev === null) state.revoked.delete(jti); else state.revoked.set(jti, prev) });
        return 1;
      }),
    };
    return (async () => {
      try {
        return await cb(tx);
      } catch (e) {
        for (let i = undo.length - 1; i >= 0; i -= 1) undo[i](); // 逆序回滚
        calls.rolledBack = true;
        throw e;
      }
    })();
  }

  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }) => {
        if (!state.user) return null;
        if (where.id !== undefined) return where.id === state.user.id ? { ...state.user } : null;
        if (where.username !== undefined) return where.username === state.user.username ? { ...state.user } : null;
        return null;
      }),
      update: jest.fn(async (args) => { state.user = { ...state.user, ...args.data }; return { ...state.user }; }),
      delete: jest.fn(async () => ({ ...state.user })),
      count: jest.fn(async () => 2),
    },
    testRecord: { count: jest.fn(async () => 0) },
    auditLog: { create: jest.fn(async (args) => args), count: jest.fn(async () => 0) },
    systemLog: { create: jest.fn(async (args) => args) },
    $transaction: jest.fn((cb) => runTransaction(cb)),
    $executeRawUnsafe: jest.fn(async () => 1),
    // P3-PUBLIC-INFRA-CHAIN-R1（受保护测试最小适配，场景不变）：可信事务替身同样按合规形状应答
    // 认证基础设施的 pg_catalog 只读形状探针（见 makeStubPrisma 注释；
    // P3-PUBLIC-INFRA-FOLLOWUP-R1 起索引行还需 is_valid/is_ready/method/is_partial/expr_cols）。
    $queryRawUnsafe: jest.fn(async (sql) => {
      if (/pg_index/.test(sql) && /indisprimary/.test(sql)) return [{ cols: ['jti'] }]
      if (/pg_index/.test(sql)) return REVOKED_TOKENS_INDEXES.map((i) => ({ name: i.name, is_unique: false, is_valid: true, is_ready: true, method: 'btree', is_partial: false, expr_cols: 0, cols: [...i.columns] }))
      if (/pg_attribute/.test(sql)) {
        return REVOKED_TOKENS_SHAPE.columns.map((c) => ({ name: c.name, type: c.type, not_null: c.notNull, default_expr: c.defaultExpr }))
      }
      return []
    }),
  };

  return { prisma, state, calls, failNextEpochWrite: (e) => { epochFailure = e; } };
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

  // 【P3-CLOSE-T01 修订（场景保留，断言随 AUD-016 新语义更新）】
  // 原断言：result.success===true（业务不回滚）+ SECURITY:REVOCATION_WRITE_FAILED（吊销吞错）
  //   —— 逐字编码 AUD-016 已废除的旧语义（见 evidence/P3-W1-T01/PROTECTED_CONFLICT.md）。
  // 新语义（P3-W1-T01 / RC-02）：业务写与用户级 epoch 写同事务，epoch 写失败 ⇒ 整体回滚 + 错误上抛。
  // 回滚证明用**可信事务替身**（makeTransactionalStubPrisma：事务内写入生效 → 失败逆序回滚），
  // 不以「user.update 未被调用」代替回滚证明。
  test('吊销写入失败 → 业务与 epoch 同事务整体回滚（无半提交、无 epoch 行、错误上抛）', async () => {
    const store = makeTransactionalStubPrisma({ user: makeUser() });
    store.failNextEpochWrite(new Error('db down')); // 令 epoch（user_all）写入失败
    const um = new UserManager(store.prisma, SECRET);

    await expect(um.disableUser('u1', managerActor)).rejects.toThrow(/db down/);

    // ① 失败点就是 epoch 写（业务写与 epoch 写在同一事务内：epoch 写被尝试过）
    expect(store.calls.epochWriteAttempts).toBe(1);
    // ② 业务写确实在事务内执行并生效（"没调用 update" 不构成回滚证明）
    expect(store.calls.txUserUpdate).toBeGreaterThanOrEqual(1);
    expect(store.calls.statusSeenInsideTx).toBe('disabled');
    // ③ 无半提交：事务失败后整体回滚 → 存储中的用户状态复原为 active
    expect(store.calls.rolledBack).toBe(true);
    expect(store.state.user.status).toBe('active');
    // ④ 无 epoch 行（user_epoch:u1 / user_all 均未落地）
    expect([...store.state.revoked.keys()]).toEqual([]);
    // ⑤ 旧语义的「吞错 + 安全事件」不再出现
    const calls = store.prisma.systemLog.create.mock.calls.map(([a]) => a?.data?.message || '');
    expect(calls.some((m) => m.includes('SECURITY:REVOCATION_WRITE_FAILED'))).toBe(false);
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
