// P3-W3-R1 · DEFECT-1 复现/修复 harness（真实隔离 PG 实例；恢复切换后租户授权重放）
//
// 缺陷（CONS-T01 登记，总控裁决选项①）：恢复引擎 `pg_dump --no-acl` 的产物不含 GRANT；
// 暂存 schema 由**管理身份**创建/灌入，双重 rename 切换后新目标 schema 上**没有**租户角色
// （隔离实例里是测试角色）的 USAGE / 表级 ACL / 序列授权 → 之后以该角色运行的套件全部
// 42501（`permission denied for schema school_...`）。本 harness 用**真实角色访问**做判别，
// 而不是只看台账字段：
//
//   ①（正例）恢复前记录目标 schema 的逐项授权基线（aclexplode：schema/表/序列 × grantee × privilege），
//     恢复后逐项比对必须一致；同时用**测试角色连接**做真实 SELECT / UPDATE ... WHERE false /
//     DELETE ... WHERE false —— 修复前必定 42501（复现），修复后必须成功。
//   ②（修复登记）恢复结果的 `aclReplay` 必须登记进台账（jobId/owner 归属本任务，applied 非空）。
//   ③（负例）注入"基线外额外授权"（另一个角色在**他校** schema 上的 USAGE/SELECT）：恢复目标校后
//     (i) 目标 schema 不得出现该角色的任何授权（不扩散）；(ii) 他校 schema 的授权不得被改动（最小面）。
//
// 运行（先 source provisioner 的 test-env.sh + fixture 的 w3-env.sh）：
//   node --test --test-concurrency=1 backend/tests/backup/w3-grant-replay.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { loadW3Harness, assertInstanceIdentity, readCanaries, backendRequire } from './_w3-harness.mjs'

const w3 = loadW3Harness()
const enabled = w3.ok

if (!enabled) {
  test('授权重放 harness：[W3] 缺少隔离实例环境 → 拒绝（fail-closed，不 skip）', () => {
    assert.fail(`[W3-HARNESS-REFUSED] code=${w3.code} missing=${(w3.missing || []).join(',')} reason=${w3.reason || 'n/a'}；需 provisioner + w3-instance-fixture 的环境`)
  })
}

if (enabled) {
  // ── P3-CLOSE-T01（AUD-040 前置）：台账按**套件/轮次隔离** ──
  // 每个套件使用 fixture 台账根下的独立子目录（含 pid），使「单实例单次 npm run test:backend」
  // （node --test 文件序）不依赖文件执行顺序，且历史轮次/同实例其他套件的记录不进入本套件断言。
  // 只改测试侧：产品代码（backupJobs.jobLedgerRoot 惰性读 env）与 fixture 目录布局均未改。
  process.env.BACKUP_JOB_LEDGER_DIR = path.join(w3.ledgerDir, `suite-grant-replay-${process.pid}`)
  process.env.DATABASE_URL = w3.adminUrl
  const { PrismaClient } = backendRequire('@prisma/client')
  const { runBackup } = await import('../../lib/backupService.js')
  const { runRestore } = await import('../../lib/restoreService.js')
  const { readJobRecord } = await import('../../lib/backupJobs.js')

  const prisma = new PrismaClient({ datasources: { db: { url: w3.adminUrl } } })
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('[W3-HARNESS-REFUSED] 本 harness 需要测试角色连接串 TEST_DATABASE_URL（provisioner test-env.sh）')
  }
  const rolePrisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
  const silent = () => {}

  const testRole = w3.derived.role
  const extraRole = `w3r1x_${String(w3.cfg.runId).slice(-10)}`
  let baselineBackup = null
  let restoreResult = null

  /** 逐项授权读取（本地实现：不依赖被测模块，保证"修复前"也能独立观测到缺陷）。 */
  async function readPrivileges(db, schema) {
    const schemaRows = await db.$queryRawUnsafe(
      `SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type AS privilege
         FROM pg_namespace n
         CROSS JOIN LATERAL aclexplode(n.nspacl) a
         LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname = $1::text
        ORDER BY grantee, privilege`, schema)
    const objectRows = await db.$queryRawUnsafe(
      `SELECT c.relname AS name, c.relkind AS kind, COALESCE(r.rolname, 'PUBLIC') AS grantee, a.privilege_type AS privilege
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) a
         LEFT JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname = $1::text AND c.relkind IN ('r','p','v','m','S')
        ORDER BY c.relname, grantee, privilege`, schema)
    return {
      schemaPrivileges: schemaRows.map((r) => `${r.grantee}:${r.privilege}`),
      objectPrivileges: objectRows.map((r) => `${r.name}:${r.grantee}:${r.privilege}`),
    }
  }

  const onlyRole = (list, role) => list.filter((x) => x.split(':').includes(role)).sort()

  /** 以测试角色做真实访问（修复前 42501）。 */
  async function assertRoleAccessWorks(tag) {
    const [{ n }] = await rolePrisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${w3.schemaA}"."User"`)
    assert.equal(typeof Number(n), 'number', `${tag}: 测试角色 SELECT 必须可用`)
    // UPDATE/DELETE 权限位（WHERE false → 零行变更，只验证 ACL，不改数据）
    await rolePrisma.$executeRawUnsafe(`UPDATE "${w3.schemaA}"."TestRecord" SET "test_type" = "test_type" WHERE false`)
    await rolePrisma.$executeRawUnsafe(`DELETE FROM "${w3.schemaA}"."TestRecord" WHERE false`)
    return Number(n)
  }

  test.before(async () => {
    const identity = await assertInstanceIdentity(prisma, w3)
    console.log(`[W3R1] 实例身份已核验：db=${identity.db} user=${identity.user} port=${identity.port} tag=${identity.instanceTag}`)
    console.log(`[W3R1] 目标校=${w3.schoolA} schema=${w3.schemaA} 租户角色=${testRole}`)

    // 基线备份（本轮恢复的输入；pg_dump --no-acl → 产物不含 GRANT，即缺陷根因）
    baselineBackup = await runBackup({ prisma, scope: 'single', schoolCode: w3.schoolA, createdBy: 'w3r1-grant-replay', log: silent })
    const run = await prisma.backupRun.findUnique({ where: { id: baselineBackup.runId } })
    assert.ok(run, '基线备份必须已登记 BackupRun')
    baselineBackup = { ...run, metaPath: baselineBackup.metaPath }

    // 负例现场：基线外额外授权（他校 schema B 上的另一角色授权）
    await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${extraRole}') THEN CREATE ROLE "${extraRole}" NOLOGIN; END IF; END $$;`)
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${w3.schemaB}" TO "${extraRole}"`)
    await prisma.$executeRawUnsafe(`GRANT SELECT ON "${w3.schemaB}"."User" TO "${extraRole}"`)
  })

  test.after(async () => {
    // 负例清理：撤销额外授权并删除临时角色（不留残余授权/角色）
    try {
      await prisma.$executeRawUnsafe(`REVOKE ALL ON "${w3.schemaB}"."User" FROM "${extraRole}"`)
      await prisma.$executeRawUnsafe(`REVOKE ALL ON SCHEMA "${w3.schemaB}" FROM "${extraRole}"`)
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${extraRole}"`)
    } catch (e) {
      console.log(`[W3R1] 负例角色清理告警: ${String(e.message).slice(0, 160)}`)
    }
    await rolePrisma.$disconnect()
    await prisma.$disconnect()
  })

  test('① 切换后租户授权与基线逐项一致（正例；修复前 = 42501 复现）', async () => {
    const before = await readPrivileges(prisma, w3.schemaA)
    const beforeSchema = onlyRole(before.schemaPrivileges, testRole)
    const beforeObjects = onlyRole(before.objectPrivileges, testRole)
    assert.ok(beforeSchema.length >= 1, '前置：目标 schema 必须已有租户角色 USAGE 基线')
    assert.ok(beforeObjects.length >= 1, '前置：目标 schema 的表必须已有租户角色授权基线')
    console.log(`[W3R1] 恢复前基线：schema 级 ${beforeSchema.length} 项 / 对象级 ${beforeObjects.length} 项（角色=${testRole}）`)
    await assertRoleAccessWorks('恢复前')

    const prev = process.env.RESTORE_DROP_OLD
    process.env.RESTORE_DROP_OLD = 'drop'
    try {
      restoreResult = await runRestore({ prisma, backup: baselineBackup, targetSchoolCode: w3.schoolA, actor: { username: 'w3r1-grant-replay' }, log: silent })
    } finally {
      if (prev === undefined) delete process.env.RESTORE_DROP_OLD
      else process.env.RESTORE_DROP_OLD = prev
    }
    assert.equal(restoreResult.ok, true, `恢复必须成功: ${restoreResult.error || ''}`)
    assert.equal(restoreResult.schema, w3.schemaA)

    const after = await readPrivileges(prisma, w3.schemaA)
    const afterSchema = new Set(onlyRole(after.schemaPrivileges, testRole))
    const afterObjects = new Set(onlyRole(after.objectPrivileges, testRole))
    const missingSchema = beforeSchema.filter((x) => !afterSchema.has(x))
    const missingObjects = beforeObjects.filter((x) => !afterObjects.has(x))
    console.log(`[W3R1] 恢复后：schema 级命中 ${beforeSchema.length - missingSchema.length}/${beforeSchema.length}，对象级命中 ${beforeObjects.length - missingObjects.length}/${beforeObjects.length}`)
    assert.deepEqual(missingSchema, [], `切换后 schema 级授权缺失（DEFECT-1）：${missingSchema.join(', ')}`)
    assert.deepEqual(missingObjects, [], `切换后对象级授权缺失（DEFECT-1）：${missingObjects.slice(0, 12).join(', ')}${missingObjects.length > 12 ? ` …共 ${missingObjects.length} 项` : ''}`)

    // 真实访问判别（修复前：42501 permission denied for schema …）
    const n = await assertRoleAccessWorks('恢复后')
    console.log(`[W3R1] 测试角色恢复后真实访问通过（SELECT/UPDATE/DELETE 权限位），User 行数=${n}`)

    // 撞名哨兵与真实数据仍须在位（W3-T01 判别证据不回归）
    const canaries = await readCanaries(prisma, w3)
    assert.equal(canaries.legacy.exists && canaries.foreign.exists, true, '撞名哨兵不得被本次恢复触碰')
  })

  test('② 重放动作登记台账（jobId 归属本任务、applied 非空、逐项可核）', async () => {
    assert.ok(restoreResult && restoreResult.ok, '前置：① 的恢复必须成功')
    const replay = restoreResult.aclReplay
    assert.ok(replay, '恢复结果必须携带 aclReplay（切换后授权重放登记）')
    assert.ok(replay.applied.length >= 1, `重放必须实际应用授权（applied=${replay.applied.length}）`)
    assert.equal(replay.schema, w3.schemaA, '重放只允许命中本任务目标 schema')
    const rec = readJobRecord(restoreResult.jobId)
    assert.equal(rec.state, 'COMPLETE')
    assert.ok(rec.aclReplay, '台账必须登记 aclReplay（owner=本任务 jobId）')
    assert.equal(rec.aclReplay.applied.length, replay.applied.length)
    assert.ok(rec.aclReplay.baseline?.digest, '台账必须登记基线摘要（可核验基线来源）')
    assert.equal(rec.aclReplay.verifiedIdentical, true, '重放后必须自证与基线逐项一致')
    console.log(`[W3R1] 台账 aclReplay：applied=${rec.aclReplay.applied.length} skipped=${rec.aclReplay.skipped.length} 基线条目=${rec.aclReplay.baseline.schemaPrivilegeCount}+${rec.aclReplay.baseline.objectPrivilegeCount}`)
  })

  test('③ 负例：基线外额外授权不被扩散，他校 schema 不被改动（最小面）', async () => {
    // 目标 schema 上不得出现负例角色的任何授权（重放只允许来自基线）
    const after = await readPrivileges(prisma, w3.schemaA)
    const spread = [...after.schemaPrivileges, ...after.objectPrivileges].filter((x) => x.includes(extraRole))
    assert.deepEqual(spread, [], `基线外额外授权被扩散到目标 schema：${spread.join(', ')}`)

    // 他校（schema B）上的额外授权必须原样保留且未被改动
    const bAfter = await readPrivileges(prisma, w3.schemaB)
    const bExtra = onlyRole(bAfter.schemaPrivileges, extraRole)
    const bExtraObj = onlyRole(bAfter.objectPrivileges, extraRole)
    assert.deepEqual(bExtra, [`${extraRole}:USAGE`], '他校 schema 级额外授权不得被改动')
    assert.deepEqual(bExtraObj, [`User:${extraRole}:SELECT`], '他校表级额外授权不得被改动')

    // 恢复动作只允许命中目标 schema（结果自证）
    assert.equal(restoreResult.aclReplay.schema, w3.schemaA)
    const touchedOther = (restoreResult.aclReplay.applied || []).filter((a) => a.schema && a.schema !== w3.schemaA)
    assert.deepEqual(touchedOther, [], '重放动作不得命中其他 schema')
    console.log(`[W3R1] 负例通过：目标 schema 无 ${extraRole} 授权；他校 B 额外授权原样（USAGE+SELECT）`)
  })
}
