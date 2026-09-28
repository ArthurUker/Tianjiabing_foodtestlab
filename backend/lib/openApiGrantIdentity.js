// openApiGrantIdentity.js — OpenAPI grant 身份校验（P3-LIFECYCLE-AB-R3 / M1）
//
// 目的（AUD-025 家族 / 同 code 重建不继承）：
//   · grant 必须绑定**授权时的**学校稳定身份：`school_id`（不可变）+ `school_generation`（世代）；
//   · 读时 fail-closed：身份缺失（历史行 NULL）/ 错配（school_id 不符）/ 世代过期（学校硬删重建）/
//     孤儿（学校不存在）⇒ 拒绝访问 + **就地隔离**（禁用 grant，bump scope_version）；
//   · 隔离写失败 ⇒ 仍然拒绝（绝不因"写隔离失败"而放行）；
//   · 学校硬删 ⇒ 同事务撤 grant（schoolRoutes）；恢复 ⇒ **不自动重授**（重授需人工/平台显式操作）。
//
// 判定矩阵：
//   grant 缺 school_id 或 school_generation         → GRANT_IDENTITY_MISSING
//   school 不存在（孤儿）                            → GRANT_IDENTITY_ORPHAN
//   school.id !== grant.school_id                    → GRANT_IDENTITY_MISMATCH（同 code 重建/换实体）
//   school.generation !== grant.school_generation    → GRANT_IDENTITY_STALE_GENERATION

export const GRANT_IDENTITY_CODES = Object.freeze({
  MISSING: 'GRANT_IDENTITY_MISSING',
  ORPHAN: 'GRANT_IDENTITY_ORPHAN',
  MISMATCH: 'GRANT_IDENTITY_MISMATCH',
  STALE: 'GRANT_IDENTITY_STALE_GENERATION',
})

/**
 * 纯函数判定（不触库）：grant 与 school（需含 id/generation）是否身份一致。
 * @returns {{ok:true}|{ok:false, code:string, detail:string}}
 */
export function classifyGrantIdentity(grant, school) {
  if (!grant) return { ok: false, code: GRANT_IDENTITY_CODES.ORPHAN, detail: 'grant 不存在' }
  const schoolId = grant.school_id
  const schoolGeneration = grant.school_generation
  if (schoolId == null || schoolGeneration == null) {
    return {
      ok: false,
      code: GRANT_IDENTITY_CODES.MISSING,
      detail: 'grant 缺少授权时绑定的学校身份（school_id/school_generation）；历史 grant 需重新授权',
    }
  }
  if (!school) {
    return { ok: false, code: GRANT_IDENTITY_CODES.ORPHAN, detail: '学校不存在（孤儿 grant）' }
  }
  if (school.id !== schoolId) {
    return {
      ok: false,
      code: GRANT_IDENTITY_CODES.MISMATCH,
      detail: 'school_id 与当前学校实体不符（同 code 重建不继承旧授权）',
    }
  }
  if (Number(school.generation) !== Number(schoolGeneration)) {
    return {
      ok: false,
      code: GRANT_IDENTITY_CODES.STALE,
      detail: `school_generation 过期（grant=${schoolGeneration}，current=${school.generation}）`,
    }
  }
  return { ok: true }
}

/**
 * 就地隔离：禁用 grant + 记录原因/时间 + bump scope_version（使既有客户端游标失效）。
 * **绝不抛出**——调用方在失败时仍须拒绝请求（fail-closed 不依赖隔离写成功）。
 * @returns {Promise<{quarantined:boolean, error?:string}>}
 */
export async function quarantineGrant(prisma, grant, reasonCode, detail = '') {
  if (!grant || !grant.id) return { quarantined: false, error: 'grant 行缺失' }
  try {
    await prisma.openApiGrant.update({
      where: { id: grant.id },
      data: {
        status: 'disabled',
        revoked_at: new Date(),
        revoked_reason: `${reasonCode}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`,
        scope_version: Number(grant.scope_version || 1) + 1,
      },
    })
    return { quarantined: true }
  } catch (e) {
    return { quarantined: false, error: e && e.message ? e.message : String(e) }
  }
}
