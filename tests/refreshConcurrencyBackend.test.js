/**
 * @jest-environment node
 *
 * 第六轮·检查项 1 · 方案 C：后端 /refresh-token 并发行为实测
 *
 * 目的：不经前端，直接以两个并发 HTTP 请求携带同一个 refresh token 打真实的
 * refresh 端点（supertest + 真实 createUserRoutes + 真实 UserManager +
 * 真实 revokeToken/getRevocationInfo，仅 Prisma 为内存 stub，
 * revoked_tokens 的 INSERT ... ON CONFLICT (jti) DO NOTHING 语义按真实表精确模拟），
 * 确认：
 *   1.（修复后）并发二次使用 → 赢家 200 新对；输家 401 {code:'REFRESH_CONCURRENT'}，
 *      **不吊销全部会话**（修复前此处即触发 user_all 全量吊销 = 全端登出）；
 *   2. 宽限期（默认 30s）之外的再次使用 → 维持核弹语义：401 + user_all 全量吊销
 *      + SECURITY:REFRESH_TOKEN_REPLAY（真重放检测未被削弱）；
 *   3. 并发竞争事件落 SECURITY:REFRESH_CONCURRENT_ROTATION（供告警通道审计）。
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
// tenantProvisioner 被 userRoutes 引入（isValidSchoolCode）；mock 掉避免拉起 Prisma 生成物
jest.mock('../backend/lib/tenantProvisioner.js', () => ({
  isValidSchoolCode: (c) => typeof c === 'string' && /^[a-z0-9-]{1,40}$/.test(c),
}));

import express from 'express';
import request from 'supertest';
import { UserManager } from '../backend/modules/UserManager.js';
import { createUserRoutes } from '../backend/routes/userRoutes.js';

const SECRET = 'unit-test-secret-1234567890';

/**
 * 内存版 Prisma stub：核心是 public.revoked_tokens 的真实唯一约束语义——
 *   INSERT ... ON CONFLICT (jti) DO NOTHING → 冲突返回 0（revokeToken 据此判定二次使用）；
 *   SELECT revoked_at, reason ... WHERE jti → getRevocationInfo 宽限判定；
 *   user_all 记录 + iat 比对 → isTokenRevoked。
 * revoked_at 可注入偏移（backdateMs）以模拟"宽限期外"的真重放。
 */
function makeStubPrisma(user) {
  const revoked = new Map(); // jti -> { userId, tokenType, reason, revokedAt }
  const stub = {
    _revoked: revoked,
    _userAllCount: () => [...revoked.values()].filter((r) => r.tokenType === 'user_all').length,
    user: {
      findUnique: jest.fn(async ({ where }) => {
        if (where.id !== undefined) return where.id === user.id ? user : null;
        if (where.username !== undefined) return where.username === user.username ? user : null;
        return null;
      }),
      update: jest.fn(async (args) => ({ ...user, ...args.data })),
    },
    auditLog: { create: jest.fn(async (a) => a) },
    systemLog: { create: jest.fn(async (a) => a) },
    $transaction: jest.fn(async (cb) => cb(stub)),
    $executeRawUnsafe: jest.fn(async (sql, ...params) => {
      const s = sql.trim();
      if (/^CREATE|^DELETE/i.test(s)) return 0;
      if (/INSERT INTO public\.revoked_tokens/i.test(s)) {
        if (/'user_all'/.test(s)) {
          // revokeAllUserTokens: (jti, user_id, school_code, reason, expires_at)
          revoked.set(params[0], {
            userId: params[1], tokenType: 'user_all', reason: params[3], revokedAt: new Date(),
          });
          return 1;
        }
        // revokeToken: (jti, user_id, school_code, token_type, reason, expires_at) + ON CONFLICT DO NOTHING
        if (revoked.has(params[0])) return 0; // ← 唯一约束冲突：二次使用
        revoked.set(params[0], {
          userId: params[1], tokenType: params[3], reason: params[4], revokedAt: new Date(),
        });
        return 1;
      }
      return 1;
    }),
    $queryRawUnsafe: jest.fn(async (sql, ...params) => {
      if (/SELECT revoked_at, reason, token_type/i.test(sql)) {
        const row = revoked.get(params[0]);
        return row ? [{ revoked_at: row.revokedAt, reason: row.reason, token_type: row.tokenType }] : [];
      }
      if (/SELECT 1 AS hit/i.test(sql)) {
        const [jti, userId, iat] = params;
        const hit = (jti && revoked.has(jti)) || [...revoked.values()].some(
          (r) => r.tokenType === 'user_all' && r.userId === userId && r.revokedAt.getTime() / 1000 >= iat
        );
        return hit ? [{ hit: 1 }] : [];
      }
      return [];
    }),
  };
  return stub;
}

const USER = {
  id: 'u1', username: 'op1', email: null, full_name: '操作员', role: 'operator',
  status: 'active', school_code: null, must_change_password: false,
};

function buildApp(prisma) {
  const um = new UserManager(prisma, SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/user', createUserRoutes(um));
  return { app, um };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('方案C · 并发双请求携带同一 refresh token（多标签页竞争的服务端等价复现）', () => {
  test('恰好一方 200 轮转成功；另一方 401 REFRESH_CONCURRENT；【不】吊销全部会话', async () => {
    const prisma = makeStubPrisma(USER);
    const { app, um } = buildApp(prisma);
    const { refreshToken } = um.buildTokenPair(USER);

    // 两个"标签页"同时发出刷新（Promise.all 并发进入端点处理链）
    const [r1, r2] = await Promise.all([
      request(app).post('/api/user/refresh-token').set('X-Refresh-Token', refreshToken),
      request(app).post('/api/user/refresh-token').set('X-Refresh-Token', refreshToken),
    ]);

    const winner = [r1, r2].find((r) => r.status === 200);
    const loser = [r1, r2].find((r) => r.status === 401);

    // 恰好一胜一败（原子 INSERT ON CONFLICT 保证不可能双胜）
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(winner.body.token).toBeTruthy();
    expect(winner.body.refreshToken).toBeTruthy();

    // 修复核心：输家收到可识别的 REFRESH_CONCURRENT，且【没有】全量吊销
    expect(loser.body.code).toBe('REFRESH_CONCURRENT');
    expect(prisma._userAllCount()).toBe(0); // ← 修复前这里是 1（全端核爆）

    // 赢家拿到的新 token 对依然可用（会话未受牵连）：新 refresh token 可正常轮转
    const r3 = await request(app).post('/api/user/refresh-token')
      .set('X-Refresh-Token', winner.body.refreshToken);
    expect(r3.status).toBe(200);
  });

  test('并发竞争事件落 SECURITY:REFRESH_CONCURRENT_ROTATION（纳入告警扫描范围）', async () => {
    const prisma = makeStubPrisma(USER);
    const { app, um } = buildApp(prisma);
    const { refreshToken } = um.buildTokenPair(USER);

    await Promise.all([
      request(app).post('/api/user/refresh-token').set('X-Refresh-Token', refreshToken),
      request(app).post('/api/user/refresh-token').set('X-Refresh-Token', refreshToken),
    ]);

    const msgs = prisma.systemLog.create.mock.calls.map(([a]) => a?.data?.message || '');
    expect(msgs.some((m) => m.includes('SECURITY:REFRESH_CONCURRENT_ROTATION'))).toBe(true);
    expect(msgs.some((m) => m.includes('SECURITY:REFRESH_TOKEN_REPLAY'))).toBe(false);
  });
});

describe('方案C · 宽限期外的真重放：核弹语义必须原样保留', () => {
  test('30s 宽限外再次使用同一 refresh token → 401 + 吊销全部会话 + SECURITY:REFRESH_TOKEN_REPLAY', async () => {
    const prisma = makeStubPrisma(USER);
    const { app, um } = buildApp(prisma);
    const { refreshToken } = um.buildTokenPair(USER);

    // 第一次使用：正常轮转
    const first = await request(app).post('/api/user/refresh-token').set('X-Refresh-Token', refreshToken);
    expect(first.status).toBe(200);

    // 把该 jti 的吊销时间回拨 60s（> 默认 30s 宽限）——模拟"很久之后旧 token 再现"
    for (const row of prisma._revoked.values()) {
      if (row.tokenType === 'refresh') row.revokedAt = new Date(Date.now() - 60_000);
    }

    // 旧 token 再次使用 → 真重放
    const replay = await request(app).post('/api/user/refresh-token').set('X-Refresh-Token', refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBeUndefined(); // 不是 REFRESH_CONCURRENT
    expect(prisma._userAllCount()).toBe(1);   // 全量吊销已执行

    const msgs = prisma.systemLog.create.mock.calls.map(([a]) => a?.data?.message || '');
    expect(msgs.some((m) => m.includes('SECURITY:REFRESH_TOKEN_REPLAY'))).toBe(true);
  });

  test('管理员手工吊销（reason≠rotated）的 token 被使用 → 不享受宽限，走核弹路径', async () => {
    const prisma = makeStubPrisma(USER);
    const { app, um } = buildApp(prisma);
    const { refreshToken } = um.buildTokenPair(USER);
    const decoded = um.verifyRefreshToken(refreshToken);

    // 该 jti 已因管理操作被吊销（reason='user_disable'，非 'rotated'）——刚刚发生也不豁免
    prisma._revoked.set(decoded.jti, {
      userId: USER.id, tokenType: 'refresh', reason: 'user_disable', revokedAt: new Date(),
    });

    const r = await request(app).post('/api/user/refresh-token').set('X-Refresh-Token', refreshToken);
    expect(r.status).toBe(401);
    expect(r.body.code).toBeUndefined();
    expect(prisma._userAllCount()).toBe(1);
  });
});

// ============ 窗口C · C-1 回归：refresh token 篡改 schoolCode（DS3-H2 绑定校验） ============
// 场景：攻击者持有对该 userId 合法签发、但 schoolCode 声明与 DB 权威 school_code 不一致
// 的 refresh token（等价于跨租户复用签发逻辑 / 篡改后重签）。刷新端点第 4 步以 DB 查询
// 结果为准做交叉校验，不一致必须拒绝并落 SECURITY:TENANT_SCHEMA_MISMATCH 事件。
describe('窗口C · C-1 · refresh token userId↔schema 绑定校验回归', () => {
  test('token 声明 schoolCode 与 DB 权威 school_code 不一致 → 401 拒绝，不签发新令牌，落 SECURITY:TENANT_SCHEMA_MISMATCH', async () => {
    const prisma = makeStubPrisma(USER); // DB 权威：USER.school_code = null（public schema）
    const { app, um } = buildApp(prisma);

    // 构造租户声明被篡改的 refresh token：同一 userId，schoolCode 伪造为 evil-school
    const { refreshToken: tamperedToken } = um.buildRefreshToken({ ...USER, school_code: 'evil-school' });
    expect(um.verifyRefreshToken(tamperedToken).schoolCode).toBe('evil-school'); // 前置确认篡改生效

    const r = await request(app).post('/api/user/refresh-token').set('X-Refresh-Token', tamperedToken);

    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
    expect(r.body.refreshToken).toBeUndefined();

    const msgs = prisma.systemLog.create.mock.calls.map(([a]) => a?.data?.message || '');
    expect(msgs.some((m) => m.includes('SECURITY:TENANT_SCHEMA_MISMATCH'))).toBe(true);
  });

  test('对照组：schoolCode 声明与 DB 一致 → 正常刷新（绑定校验不误伤合法用户）', async () => {
    const prisma = makeStubPrisma(USER);
    const { app, um } = buildApp(prisma);
    const { refreshToken } = um.buildTokenPair(USER); // schoolCode=null，与 DB 一致

    const r = await request(app).post('/api/user/refresh-token').set('X-Refresh-Token', refreshToken);
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();

    const msgs = prisma.systemLog.create.mock.calls.map(([a]) => a?.data?.message || '');
    expect(msgs.some((m) => m.includes('SECURITY:TENANT_SCHEMA_MISMATCH'))).toBe(false);
  });
});
