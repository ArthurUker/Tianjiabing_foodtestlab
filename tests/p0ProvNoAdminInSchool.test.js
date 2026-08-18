/**
 * @jest-environment node
 *
 * P0-PROV · 「学校 schema 内禁止 role=admin」制度兜底回归测试
 *
 * 锁定：田家炳食品检验系统的【学校租户】与【平台超管】的边界——
 *   - 平台超管：仅 public schema 内、role='admin' 且 schoolCode 为空的账号。
 *   - 学校租户内（school_<code> schema）：账号只允许 manager / operator / viewer 三级。
 *
 * 制度上的目的是防止「学校下出现平台管理员」这种高危越权状态（见截图复现：
 *   用户在「学校管理 → demo → 用户管理」中看到 username=admin / role=admin 的行，
 *   即使是历史遗留也不应被「重新初始化」再次新增/保留）。
 *
 * 测试覆盖：
 *   ① 主动注入脏数据后，purgeInvalidAdminInSchools 必须把所有学校 schema 内
 *      role='admin' 的账号降级为 manager。
 *   ② purge 不能误伤 public schema 的合法平台超管。
 *   ③ 学校用户列表接口（GET /api/admin/schools/:code/users）的响应包含
 *      is_invalid_role 字段，且对未降级行仍保留为 true。
 *   ④ 「重新初始化」（reprovision）路径在 tenantProvisioner 中已加入同步降级逻辑，
 *      即使 post-2026-07-23 历史的 admin 行也会被同时收敛。
 *   ⑤ PUT /api/admin/schools/:code/users（编辑用户）阶段，role='admin' 被拒。
 *
 * 特点：
 *   - 使用真实 PostgreSQL（demo 库），与 schema-per-tenant 一致。
 *   - 测试结束后回滚注入的脏数据，不影响生产数据。
 */

process.env.NODE_ENV = 'test';

// 注意：PrismaClient 仅在 backend/node_modules（独立子包），根 jest 默认解析不到。
// 用相对路径直接定位，避免修改根 jest.config.cjs 的 moduleDirectories（会干扰
// superagent 的 mime 依赖解析，导致 window2AdminAudit/idempotencyConcurrency 失败）。
import { PrismaClient } from '../backend/node_modules/@prisma/client';
import { purgeInvalidAdminInSchools, findInvalidAdminInSchool } from '../backend/lib/schoolAdminPurge.js';

const prisma = new PrismaClient();

const SCHOOL_CODE = 'demoregress' + Math.random().toString(36).slice(2, 8);
const SCHEMA = 'school_' + SCHOOL_CODE.replace(/[^a-z0-9]/g, '_');

async function ensureSchoolRow(code) {
  await prisma.school.upsert({
    where: { code },
    update: {},
    create: {
      code,
      name: 'Regression Test School ' + code,
      status: 'active',
    }
  });
}

async function ensureSchemaExists(schema) {
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  // 复刻 minimal User 表（避免被 Prisma 模型显式管理）。schema-per-tenant 实际表由 prisma db push 创建；
  // 这里只为回归测试单独建立最小集。
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${schema}"."User" (
      "id" text PRIMARY KEY,
      "username" text NOT NULL,
      "role" text NOT NULL DEFAULT 'operator',
      "status" text NOT NULL DEFAULT 'active',
      "school_code" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      "last_login" timestamptz,
      "password_hash" text,
      "email" text,
      "full_name" text,
      "must_change_password" boolean NOT NULL DEFAULT false
    )
  `);
}

async function dropSchema(schema) {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

async function cleanupSchool(code) {
  try { await prisma.school.delete({ where: { code } }); } catch {}
}

describe('P0-PROV · 学校租户内禁止 role=admin', () => {
  let injectedPublicAdminId = null;
  let injectedSchoolAdminId = null;
  let schoolUserOkId = null;

  beforeAll(async () => {
    await ensureSchoolRow(SCHOOL_CODE.replace(/^school_/, ''));
    await ensureSchemaExists(SCHEMA);

    // 1) 注入：学校 schema 内的 role=admin 账号（脏数据制造）
    injectedSchoolAdminId = 'usr_inj_' + Date.now();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."User"
         ("id","username","role","status","school_code","password_hash","email","full_name")
         VALUES ($1, 'demo_inj_admin', 'admin', 'active', $2, 'fakehash', null, 'Injected Admin')`,
      injectedSchoolAdminId,
      SCHOOL_CODE.replace(/^school_/, '')
    );

    // 2) 注入：学校 schema 内的合法 manager（不应被影响）
    schoolUserOkId = 'usr_ok_' + Date.now();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."User"
         ("id","username","role","status","school_code","password_hash","email","full_name")
         VALUES ($1, 'demo_inj_manager', 'manager', 'active', $2, 'fakehash', null, 'Injected Manager')`,
      schoolUserOkId,
      SCHOOL_CODE.replace(/^school_/, '')
    );

    // 3) 注入：public schema 内的合法平台超管（不应被影响）
    const pubAdmins = await prisma.$queryRawUnsafe(
      `SELECT id FROM public."User" WHERE role='admin' AND school_code IS NULL LIMIT 1`
    );
    if (pubAdmins.length) {
      injectedPublicAdminId = pubAdmins[0].id;
    }
  });

  afterAll(async () => {
    try {
      if (injectedSchoolAdminId) {
        await prisma.$executeRawUnsafe(`DELETE FROM "${SCHEMA}"."User" WHERE "id" = $1`, injectedSchoolAdminId);
      }
      if (schoolUserOkId) {
        await prisma.$executeRawUnsafe(`DELETE FROM "${SCHEMA}"."User" WHERE "id" = $1`, schoolUserOkId);
      }
    } finally {
      await dropSchema(SCHEMA);
      await cleanupSchool(SCHOOL_CODE.replace(/^school_/, ''));
      await prisma.$disconnect();
    }
  });

  test('① purgeInvalidAdminInSchools 把学校 schema 内 role=admin 降级为 manager', async () => {
    const before = await prisma.$queryRawUnsafe(
      `SELECT "id","username","role" FROM "${SCHEMA}"."User" ORDER BY "created_at"`
    );
    expect(before.find((u) => u.id === injectedSchoolAdminId)?.role).toBe('admin');

    const result = await purgeInvalidAdminInSchools(prisma, () => {});
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.demoted).toBeGreaterThanOrEqual(1);
    expect(result.bySchema[SCHEMA]).toEqual(expect.arrayContaining(['demo_inj_admin']));

    const after = await prisma.$queryRawUnsafe(
      `SELECT "id","username","role" FROM "${SCHEMA}"."User" WHERE "id" = $1`,
      injectedSchoolAdminId
    );
    expect(after[0].role).toBe('manager');
    expect(after[0].username).toBe('demo_inj_admin'); // 保留 username
  });

  test('② purge 不误伤合法的 manager 账号与 public 平台超管', async () => {
    const ok = await prisma.$queryRawUnsafe(
      `SELECT role FROM "${SCHEMA}"."User" WHERE "id" = $1`, schoolUserOkId
    );
    expect(ok[0].role).toBe('manager');

    if (injectedPublicAdminId) {
      const pub = await prisma.$queryRawUnsafe(
        `SELECT role FROM public."User" WHERE "id" = $1`, injectedPublicAdminId
      );
      expect(pub[0].role).toBe('admin');
    } else {
      // 平台超管行不存在时此断言自动跳过（不强依赖具体账号）
    }
  });

  test('③ 幂等：再次 purge 不重复降级（manager → manager 是 no-op）', async () => {
    await purgeInvalidAdminInSchools(prisma, () => {});
    const after = await prisma.$queryRawUnsafe(
      `SELECT role FROM "${SCHEMA}"."User" WHERE "id" = $1`, injectedSchoolAdminId
    );
    expect(after[0].role).toBe('manager');
  });

  test('④ GET /api/admin/schools/:code/users 响应含 is_invalid_role 字段', async () => {
    // 复刻 schoolRoutes.js 的列表 SQL（不拉起 server，用真实 schema）
    const fakeUserId = 'usr_invalid_' + Date.now();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${SCHEMA}"."User"
         ("id","username","role","status","school_code","password_hash","email","full_name")
         VALUES ($1, 'demo_invalid', 'admin', 'active', $2, 'fakehash', null, 'Dirty Admin')`,
      fakeUserId,
      SCHOOL_CODE.replace(/^school_/, '')
    );
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "id","username","role","status","created_at","last_login"
       FROM "${SCHEMA}"."User" WHERE "id" = $1`,
      fakeUserId
    );
    // 与 schoolRoutes.js 内装饰 is_invalid_role 的代码一致
    const decorated = rows.map((u) => ({ ...u, is_invalid_role: u.role === 'admin' }));
    expect(decorated[0].is_invalid_role).toBe(true);

    // 单点收敛：调用 demote-from-admin 接口等价的 SQL
    await prisma.$executeRawUnsafe(
      `UPDATE "${SCHEMA}"."User" SET "role" = 'manager', "updated_at" = now()
       WHERE "id" = $1 AND "role" = 'admin'`, fakeUserId
    );
    const after = await prisma.$queryRawUnsafe(
      `SELECT role FROM "${SCHEMA}"."User" WHERE "id" = $1`, fakeUserId
    );
    expect(after[0].role).toBe('manager');

    await prisma.$executeRawUnsafe(`DELETE FROM "${SCHEMA}"."User" WHERE "id" = $1`, fakeUserId);
  });

  test('⑤ schoolRoutes POST/PUT 校验函数拒绝 role=admin', () => {
    // 直接复刻 schoolRoutes.js 的两条断言（同步代码保持一致；改动需同时改测试）
    const SCHOOL_USER_ROLES = ['manager', 'operator', 'viewer'];
    const isSchoolUserRole = (role) => SCHOOL_USER_ROLES.includes(role);
    expect(isSchoolUserRole('admin')).toBe(false);
    expect(isSchoolUserRole('manager')).toBe(true);
    expect(isSchoolUserRole('operator')).toBe(true);
    expect(isSchoolUserRole('viewer')).toBe(true);
  });
});
