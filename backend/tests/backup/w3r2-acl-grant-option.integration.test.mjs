// P3-W3-R2 · restore ACL **grant option** 反例与修复判别 harness（真实隔离 PG 实例）
//
// 历史缺陷：
//   `restoreService.js` 已采集 `grantable`（:245-269），但差集（:299-317）与自证（:346-375）只按
//   `grantee:privilege` 比对 ⇒ **基线 `WITH GRANT OPTION`、切换后只有同名普通权限时误报
//   `verifiedIdentical=true`**（授权可转授性丢失却"通过"）。
//
// 本 harness 的判别全部基于**真实 PG ACL**（`aclexplode(...).is_grantable`）+ 真实 `GRANT` 重放：
//   ① 反例：基线 WITH GRANT OPTION → 降级为普通权限 → 重放后必须**补回**可转授（修复前 applied=0 且误报通过）
//   ② 幂等：同一场景重放第二次必须零动作零语句
//   ③ 普通基线不降权：现状多出可转授 ⇒ 不得 REVOKE（仅登记 upgrade；严格相同为 false 但基线下界满足）
//   ④ 不存在对象：基线含已 DROP 对象 ⇒ skipped 精确登记、不抛错、严格相同为 false
//   ⑤ 目标外 schema 零扩散：他 schema 的 ACL 逐项不变
//   ⑥ PUBLIC：基线的 PUBLIC 授权同样被重放（含 grant option）
//   ⑦ fail-closed：不可执行的 GRANT（角色不存在）⇒ 抛错（调用方保留旧 schema 供回滚）
//
// 运行（先 source provisioner test-env.sh + w3-env.sh）：
//   node --test --test-concurrency=1 backend/tests/backup/w3r2-acl-grant-option.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { loadW3Harness, backendRequire } from './_w3-harness.mjs'

const w3 = loadW3Harness()
const enabled = w3.ok

if (!enabled) {
  test('W3-R2 ACL grant option harness：[W3] 缺少隔离实例环境 → 拒绝（fail-closed，不 skip）', () => {
    assert.fail(`[W3-HARNESS-REFUSED] code=${w3.code} missing=${(w3.missing || []).join(',')} reason=${w3.reason || 'n/a'}`)
  })
}

if (enabled) {
  // 台账隔离（沿用 CLOSE-A 约定）：本套件用 fixture 台账根下的独立子目录
  process.env.BACKUP_JOB_LEDGER_DIR = path.join(w3.ledgerDir, `suite-w3r2-acl-${process.pid}`)
  process.env.DATABASE_URL = w3.adminUrl

  const { PrismaClient } = backendRequire('@prisma/client')
  const { readSchemaAclSnapshot, replaySchemaAcl } = await import('../../lib/restoreService.js')

  const prisma = new PrismaClient({ datasources: { db: { url: w3.adminUrl } } })
  const tail = String(w3.cfg.runId).slice(-10)
  const ROLE = `w3r2_role_${tail}`
  const MISSING_ROLE = `w3r2_missing_${tail}`
  const S1 = `w3r2_acl_${tail}`
  const S2 = `w3r2_acl_other_${tail}`
  const silent = () => {}

  const q = (sql, ...args) => prisma.$executeRawUnsafe(sql, ...args)
  const raw = (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args)

  /** 逐项 ACL 读取（本地实现：不依赖被测模块，保证"修复前"也能独立观测）：含 is_grantable。 */
  async function grantsOf(schema) {
    const rows = await raw(
      `SELECT 'schema' AS level, NULL::text AS obj, COALESCE(r.rolname,'PUBLIC') AS grantee,
              a.privilege_type AS privilege, (a.is_grantable = true) AS grantable
         FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
         LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname = $1::text
        UNION ALL
       SELECT CASE WHEN c.relkind = 'S' THEN 'sequence' ELSE 'table' END, c.relname,
              COALESCE(r.rolname,'PUBLIC'), a.privilege_type, (a.is_grantable = true)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) a
         LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname = $1::text AND c.relkind = ANY(ARRAY['r','p','v','m','S'])`,
      schema
    )
    return rows
      .map((r) => `${r.level}:${r.obj || '-'}:${r.grantee}:${r.privilege}:${r.grantable ? 1 : 0}`)
      .sort()
  }
  const grantableSet = (list) => new Set(list.filter((x) => x.endsWith(':1')))

  test.before(async () => {
    await q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE "${ROLE}" NOLOGIN; END IF; END $$;`)
    for (const s of [S1, S2]) {
      await q(`DROP SCHEMA IF EXISTS "${s}" CASCADE`)
      await q(`CREATE SCHEMA "${s}"`)
      await q(`CREATE TABLE "${s}".t1 (id int)`)
      await q(`CREATE SEQUENCE "${s}".s1`)
    }
    // 他 schema 的"基线外授权"（⑤ 零扩散判据）
    await q(`GRANT USAGE ON SCHEMA "${S2}" TO "${ROLE}"`)
    await q(`GRANT SELECT ON "${S2}".t1 TO "${ROLE}"`)
  })

  test.after(async () => {
    for (const s of [S1, S2]) await q(`DROP SCHEMA IF EXISTS "${s}" CASCADE`)
    await q(`DROP ROLE IF EXISTS "${ROLE}"`)
    await q(`DROP ROLE IF EXISTS "${MISSING_ROLE}"`)
    await prisma.$disconnect()
  })

  test('① 反例：基线 WITH GRANT OPTION → 降级为普通权限 → 必须补回可转授（修复前 applied=0 且误报通过）', async () => {
    // 基线：schema USAGE / table SELECT / sequence USAGE，全部 **可转授**
    await q(`GRANT USAGE ON SCHEMA "${S1}" TO "${ROLE}" WITH GRANT OPTION`)
    await q(`GRANT SELECT ON "${S1}".t1 TO "${ROLE}" WITH GRANT OPTION`)
    await q(`GRANT USAGE ON SEQUENCE "${S1}".s1 TO "${ROLE}" WITH GRANT OPTION`)
    const baseline = await readSchemaAclSnapshot(prisma, S1)
    assert.ok(baseline.schemaPrivileges.some((p) => p.grantee === ROLE && p.grantable === true), '基线必须含可转授的 schema 授权')
    assert.ok(baseline.objectPrivileges.some((p) => p.name === 't1' && p.grantable === true), '基线必须含可转授的表授权')
    assert.ok(baseline.objectPrivileges.some((p) => p.name === 's1' && p.grantable === true), '基线必须含可转授的序列授权')

    // 模拟"恢复切换后"：同名权限仍在，但**只剩普通权限**（不可转授）
    for (const [objSql] of [['SCHEMA'], ['TABLE'], ['SEQUENCE']]) {
      if (objSql === 'SCHEMA') await q(`REVOKE GRANT OPTION FOR USAGE ON SCHEMA "${S1}" FROM "${ROLE}"`)
      if (objSql === 'TABLE') await q(`REVOKE GRANT OPTION FOR SELECT ON "${S1}".t1 FROM "${ROLE}"`)
      if (objSql === 'SEQUENCE') await q(`REVOKE GRANT OPTION FOR USAGE ON SEQUENCE "${S1}".s1 FROM "${ROLE}"`)
    }
    const downgraded = await grantsOf(S1)
    assert.equal(grantableSet(downgraded).size, 0, '前置：切换后必须无任何可转授权限（反例场景成立）')

    const result = await replaySchemaAcl({ queryable: prisma, schema: S1, baseline, log: silent })

    // 判别（修复前此处失败：applied=0，且 verifiedIdentical 误报 true）
    assert.ok(result.applied.length >= 3, `基线含可转授时必须重放补齐（修复前 applied=${result.applied.length}）`)
    assert.equal(result.verifiedBaselineSatisfied, true, '重放后必须满足基线下界（含可转授）')
    const after = grantableSet(await grantsOf(S1))
    for (const expect of [
      `schema:-:${ROLE}:USAGE:1`,
      `table:t1:${ROLE}:SELECT:1`,
      `sequence:s1:${ROLE}:USAGE:1`,
    ]) assert.ok(after.has(expect), `必须恢复可转授：${expect}`)
  })

  test('② 幂等：同场景重放第二次零动作零语句', async () => {
    const baseline = await readSchemaAclSnapshot(prisma, S1)
    const again = await replaySchemaAcl({ queryable: prisma, schema: S1, baseline, log: silent })
    assert.equal(again.applied.length, 0, '第二次必须零动作')
    assert.equal(again.statements, 0, '第二次必须零语句')
    assert.equal(again.verifiedBaselineSatisfied, true)
    assert.equal(again.verifiedIdentical, true, '已严格一致（含 grantable）时 verifiedIdentical 应为 true')
    assert.deepEqual(again.skipped, [])
  })

  test('③ 普通基线而现状已有可转授 ⇒ 不得 REVOKE（仅登记 upgrade；不虚称严格相同）', async () => {
    // 普通基线：撤销可转授后再取基线
    await q(`REVOKE GRANT OPTION FOR USAGE ON SCHEMA "${S1}" FROM "${ROLE}"`)
    await q(`REVOKE GRANT OPTION FOR SELECT ON "${S1}".t1 FROM "${ROLE}"`)
    await q(`REVOKE GRANT OPTION FOR USAGE ON SEQUENCE "${S1}".s1 FROM "${ROLE}"`)
    const plainBaseline = await readSchemaAclSnapshot(prisma, S1)
    // 现状"升级"（模拟目标侧已有可转授）
    await q(`GRANT USAGE ON SCHEMA "${S1}" TO "${ROLE}" WITH GRANT OPTION`)

    const result = await replaySchemaAcl({ queryable: prisma, schema: S1, baseline: plainBaseline, log: silent })
    assert.equal(result.applied.length, 0, '普通基线不得触发任何动作（尤其不得 REVOKE）')
    assert.equal(result.statements, 0, '不得生成 REVOKE/GRANT 语句')
    assert.equal(result.verifiedBaselineSatisfied, true, '基线下界仍满足')
    assert.equal(result.verifiedIdentical, false, '现状多出可转授 ⇒ 不得虚称双向完全相同')
    assert.ok(result.grantOptionUpgrades.some((u) => u.level === 'schema' && u.grantee === ROLE), '多出的可转授必须准确登记')
    const still = grantableSet(await grantsOf(S1))
    assert.ok(still.has(`schema:-:${ROLE}:USAGE:1`), '现状的可转授不得被撤销')
  })

  test('④ 基线含已不存在对象：skipped 精确登记、不抛错、严格相同为 false', async () => {
    // 重置为干净可判定状态：仅 schema USAGE（普通）+ 一个将被删除的对象授权
    await q(`REVOKE ALL ON SCHEMA "${S1}" FROM "${ROLE}"`)
    await q(`REVOKE ALL ON "${S1}".t1 FROM "${ROLE}"`)
    await q(`REVOKE ALL ON SEQUENCE "${S1}".s1 FROM "${ROLE}"`)
    await q(`GRANT USAGE ON SCHEMA "${S1}" TO "${ROLE}"`)
    await q(`GRANT SELECT ON "${S1}".t1 TO "${ROLE}"`)
    await q(`GRANT USAGE ON SEQUENCE "${S1}".s1 TO "${ROLE}"`)
    const baseline = await readSchemaAclSnapshot(prisma, S1)
    await q(`DROP SEQUENCE "${S1}".s1`)
    await q(`REVOKE USAGE ON SCHEMA "${S1}" FROM "${ROLE}"`)

    const result = await replaySchemaAcl({ queryable: prisma, schema: S1, baseline, log: silent })
    assert.ok(result.skipped.some((s) => s.object === 's1' && s.reason === 'object-missing-after-switch'), '不存在对象必须登记为 skipped')
    assert.equal(result.verifiedBaselineSatisfied, true, '对象已不存在不算基线未满足（只登记）')
    assert.equal(result.verifiedIdentical, false, '对象集合不同 ⇒ 严格相同为 false')
    assert.ok(result.strictMismatch.skippedCount >= 1, 'strictMismatch 必须解释差异来源')
  })

  test('⑤ 目标外 schema 零扩散：他 schema ACL 逐项不变', async () => {
    const beforeS2 = await grantsOf(S2)
    const baseline = await readSchemaAclSnapshot(prisma, S1)
    await replaySchemaAcl({ queryable: prisma, schema: S1, baseline, log: silent })
    assert.deepEqual(await grantsOf(S2), beforeS2, '他 schema 的授权必须逐项不变')
    const entries = await raw(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1::text`, S1)
    assert.equal(Number(entries[0].n), 1)
  })

  test('⑥ PUBLIC 授权同样被重放（PG 约束：PUBLIC 不能持有 grant option，重放不得对其生成 WITH GRANT OPTION）', async () => {
    // 背景：PostgreSQL 明文禁止 `GRANT ... TO PUBLIC WITH GRANT OPTION`（0LP01「grant options can only be granted to roles」），
    // 因此 PUBLIC 的基线 `is_grantable` 恒为 false ⇒ 重放语句不得带 WITH GRANT OPTION（否则整批 psql 失败）。
    await assert.rejects(
      () => q(`GRANT USAGE ON SCHEMA "${S1}" TO PUBLIC WITH GRANT OPTION`),
      /grant options can only be granted to roles/,
      '前置事实：PG 不允许给 PUBLIC 授予可转授权限'
    )
    await q(`GRANT USAGE ON SCHEMA "${S1}" TO PUBLIC`)
    const baseline = await readSchemaAclSnapshot(prisma, S1)
    assert.ok(baseline.schemaPrivileges.some((p) => p.grantee === 'PUBLIC' && p.privilege === 'USAGE' && p.grantable === false), 'PUBLIC 基线条目 grantable 必须为 false')
    await q(`REVOKE USAGE ON SCHEMA "${S1}" FROM PUBLIC`)
    const result = await replaySchemaAcl({ queryable: prisma, schema: S1, baseline, log: silent })
    assert.ok(result.applied.some((a) => a.grantee === 'PUBLIC' && a.level === 'schema'), 'PUBLIC 授权必须参与重放')
    const after = await grantsOf(S1)
    assert.ok(after.includes(`schema:-:PUBLIC:USAGE:0`), 'PUBLIC 的 USAGE 必须恢复')
    assert.ok(!grantableSet(after).has(`schema:-:PUBLIC:USAGE:1`), 'PUBLIC 不得被写入可转授（PG 禁止）')
  })

  test('⑦ fail-closed：不可执行的 GRANT（角色不存在）⇒ 抛错（调用方保留旧 schema 供回滚）', async () => {
    const baseline = await readSchemaAclSnapshot(prisma, S1)
    // 构造一个语法合法但必然失败的重放项：授予不存在的角色
    const poisoned = {
      ...baseline,
      schemaPrivileges: [...baseline.schemaPrivileges, { grantee: MISSING_ROLE, privilege: 'USAGE', grantable: false }],
    }
    await assert.rejects(
      () => replaySchemaAcl({ queryable: prisma, schema: S1, baseline: poisoned, log: silent }),
      /psql 失败|fail-closed|未达成基线一致/,
      '重放失败必须抛错（fail-closed）'
    )
    // 旧 schema 仍存在（本函数不 drop；生产路径 drop-old 在重放之后）
    const [exists] = await raw(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1::text`, S1)
    assert.equal(Number(exists.n), 1, '失败后目标 schema 必须仍在（可回滚）')
  })
}
