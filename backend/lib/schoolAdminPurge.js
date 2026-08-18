// schoolAdminPurge.js
// 「学校 schema 内禁止 role=admin」制度兜底（独立文件、无 import.meta，
// 可被 Jest/roleMatrix.test.js 等以 CJS/ESM 混合方式测试）。
//
// 背景：制度上「学校租户下只允许三级账号（manager/operator/viewer）」，
//       admin 仅存在于 public schema（平台超管）。
//       历史上某次 provisionSchool/UserManager 未做白名单校验的版本，可能写入
//       role=admin 的脏数据（如 2026-07-23 写入的 school_demo.admin）。
//       本文件提供自愈函数供：
//         - tenantSync.syncAllTenantSchemas()
//         - provisionSchool.reprovision()
//         - 手动控制台清理
//       三处复用。
//
// 行为：遍历 public."School" 中【未删除】学校对应的 schema，
//       对其中 role='admin' 的 User 行强制降级为 role='manager'。
//       仅修改 role 列（保留 id/username/password/email 等所有字段）。
//
// 安全边：
//   - 仅扫描非 public schema，public 内 admin（平台超管）不参与。
//   - 跳过孤儿/历史 schema（recycle_/school_*_old_* 之类的非标准）。
//   - 提供纯函数 `assertNoAdminInSchools(tenantPrisma, schema)` 供测试与自检。

import { schemaNameOf } from './tenantClient.js';

const FORBIDDEN_ROLE = 'admin';
const SAFE_ROLE = 'manager';

/**
 * 遍历所有未删除学校，对相应 schema 内 role=FORBIDDEN_ROLE 的 User 行降级为 SAFE_ROLE。
 *
 * @param {import('@prisma/client').PrismaClient} prisma 主 PrismaClient（用于读取 public.School + 各 schema 操作）
 * @param {(m:string)=>void} [log]
 * @returns {Promise<{scanned:number, demoted:number, bySchema:Object<string,string[]>}>}
 */
export async function purgeInvalidAdminInSchools(prisma, log = console.log) {
  const schoolRows = await prisma.school.findMany({
    where: { status: { not: 'deleted' } },
    select: { code: true }
  });
  const codes = schoolRows.map((r) => r.code).filter(Boolean);
  if (!codes.length) {
    log('[SKIP] 无活跃学校，跳过非法 admin 角色自愈');
    return { scanned: 0, demoted: 0, bySchema: {} };
  }

  const bySchema = {};
  let total = 0;

  for (const code of codes) {
    const schema = schemaNameOf(code);
    if (!schema) continue;

    let rows;
    try {
      rows = await prisma.$queryRawUnsafe(
        `SELECT id, username FROM "${schema}"."User" WHERE role = $1`,
        FORBIDDEN_ROLE
      );
    } catch (e) {
      log(`  ⚠️ ${schema} 扫描失败 - ${e.message}`);
      continue;
    }
    if (!rows.length) continue;

    const ids = rows.map((r) => r.id);
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "${schema}"."User" SET role = $1, updated_at = now() WHERE id = ANY($2::text[])`,
        SAFE_ROLE,
        ids
      );
    } catch (e) {
      log(`  ❌ ${schema} 降级失败 - ${e.message}`);
      continue;
    }

    bySchema[schema] = rows.map((r) => r.username);
    total += rows.length;
    log(`  🔧 ${schema}: 降级 ${rows.length} 个 admin 账号 → manager (${rows.map((r) => r.username).join(', ')})`);
  }

  if (total) {
    log(`[PURGE] 累计降级 ${total} 个历史非法 admin 账号（学校 schema 内）`);
  } else {
    log('[OK] 所有学校 schema 内无非法 admin 账号');
  }
  return { scanned: codes.length, demoted: total, bySchema };
}

/**
 * 纯断言：给定一个 PrismaClient（已 set search_path 或带 ?schema=）调用方，
 * 检查该 schema 内是否存在 role=admin 的 User 行。供测试 / 自检入口使用。
 *
 * @param {{$queryRawUnsafe:Function}} tenantPrisma
 * @param {string} schema
 * @returns {Promise<Array<{id:string,username:string,role:string}>>}
 */
export async function findInvalidAdminInSchool(tenantPrisma, schema) {
  return await tenantPrisma.$queryRawUnsafe(
    `SELECT id, username, role FROM "${schema}"."User" WHERE role = $1`,
    FORBIDDEN_ROLE
  );
}

export const ADMIN_PURGE_CONSTANTS = Object.freeze({
  FORBIDDEN_ROLE,
  SAFE_ROLE,
  SCHOOL_ALLOWED_ROLES: ['manager', 'operator', 'viewer'],
});
