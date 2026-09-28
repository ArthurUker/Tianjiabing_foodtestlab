// P3-W3-T01 恢复状态机定点集成测试（真实隔离 PG 实例；AUD-004 + AUD-005 + NF-B-02）
//
// 判别证据（对应任务包退出条件 ①②）：
//   ① 并发恢复互斥：同校两个恢复请求只一个获得执行权，另一个 409 明确拒绝，
//      被拒方不创建/不删除任何对象；写屏障（per-school + READONLY_MODE）在 STAGING 期生效、结束后拆除
//   ② 暂存撞名注入：预建的【历史固定名】与【他任务暂存名】schema 及其哨兵行在全部路径下都不被 DROP；
//      本任务暂存名含随机熵且登记 OID；失败清理只 DROP 本任务登记且 OID 复核通过的暂存 schema
//   附：RESTORE_DROP_OLD 语义、drain 超时中止（屏障有效性）、台账无残留、/tmp 无明文 SQL（NF-B-02）
//
// 运行（先 source provisioner 的 test-env.sh 与 fixture 的 w3-env.sh）：
//   node --test --test-concurrency=1 backend/tests/backup/w3-restore-state-machine.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  loadW3Harness, assertInstanceIdentity, readCanaries, readRealSentinel,
  listTmpPlaintextRestoreFiles, backendRequire,
} from './_w3-harness.mjs'

const w3 = loadW3Harness()
const enabled = w3.ok

if (!enabled) {
  test('恢复状态机集成测试：[W3] 缺少隔离实例环境 → 拒绝（fail-closed，不 skip）', () => {
    assert.fail(`[W3-HARNESS-REFUSED] code=${w3.code} missing=${(w3.missing || []).join(',')} reason=${w3.reason || 'n/a'}；需 provisioner + w3-instance-fixture 的环境`)
  })
}

if (enabled) {
  // ── P3-CLOSE-T01（AUD-040 前置）：台账按**套件/轮次隔离** ──
  // 用例 ① 断言"首个 COMPLETE 恢复记录的旧 schema 仍保留"、⑥ 断言"工作目录为空"，
  // 都要求台账只含本套件本次链路的记录。此前依赖文件执行顺序（grant-replay 先跑时，
  // 其 RESTORE_DROP_OLD=drop 的记录会成为 find(COMPLETE) 的首个命中 → 断言必然失败）。
  // 现将本套件台账指向 fixture 台账根下的独立子目录（含 pid）——单实例单次 test:backend
  // 不再依赖文件排序，重复运行/历史轮次也不污染本套件。
  // 只改测试侧：产品代码（backupJobs.jobLedgerRoot 惰性读 env）与 fixture 目录布局均未改。
  process.env.BACKUP_JOB_LEDGER_DIR = path.join(w3.ledgerDir, `suite-restore-state-machine-${process.pid}`)
  process.env.DATABASE_URL = w3.adminUrl
  const { PrismaClient } = backendRequire('@prisma/client')
  const { runBackup } = await import('../../lib/backupService.js')
  const { runRestore } = await import('../../lib/restoreService.js')
  const { listJobRecords, jobLedgerRoot, readJobRecord } = await import('../../lib/backupJobs.js')
  const { isWriteBarrierActive, writeBarrierSnapshot } = await import('../../lib/tenantWriteBarrier.js')

  const prisma = new PrismaClient({ datasources: { db: { url: w3.adminUrl } } })
  const silent = () => {}
  const tmpPlaintextBaseline = listTmpPlaintextRestoreFiles() // 套件开始前的既有残留（不被本套件计入）
  let baseline = null // 真实备份（RESTORE 用）
  let tampered = null // 篡改计数的备份（失败清理用）

  const restoreRecords = () => listJobRecords().filter((r) => !r.corrupt && r.kind === 'restore')
  const schemaExists = async (name) => (await prisma.$queryRawUnsafe('SELECT 1 FROM pg_namespace WHERE nspname = $1', name)).length > 0

  test.before(async () => {
    const identity = await assertInstanceIdentity(prisma, w3)
    console.log(`[W3] 实例身份已核验：db=${identity.db} user=${identity.user} port=${identity.port} tag=${identity.instanceTag}`)
    baseline = await runBackup({ prisma, scope: 'single', schoolCode: w3.schoolA, createdBy: 'w3-restore-suite', log: silent })
    const run = await prisma.backupRun.findUnique({ where: { id: baseline.runId } })
    assert.ok(run, '基线备份必须已登记 BackupRun')
    baseline = { ...run, metaPath: baseline.metaPath }

    // 篡改副本：改 meta 中某表计数 → 通过离线验证、但恢复行数校验必然失败（确定性失败注入）
    const fixtureDir = path.join(w3.instanceRoot, 'w3-fixtures', 'tampered')
    await fsp.mkdir(fixtureDir, { recursive: true, mode: 0o700 })
    const meta = JSON.parse(fs.readFileSync(baseline.metaPath, 'utf8'))
    const key = Object.keys(meta.tableCounts).find((k) => k.startsWith(`${w3.schemaA}.`))
    assert.ok(key, 'per-table counts 必须存在')
    meta.tableCounts[key] = Number(meta.tableCounts[key]) + 1
    const tamperedAes = path.join(fixtureDir, path.basename(baseline.file_path))
    const tamperedMeta = path.join(fixtureDir, path.basename(baseline.metaPath))
    await fsp.copyFile(baseline.file_path, tamperedAes)
    await fsp.writeFile(tamperedMeta, JSON.stringify(meta, null, 2), { mode: 0o600 })
    tampered = {
      id: 'w3-tampered-run',
      file_path: tamperedAes,
      scope: 'single',
      school_code: w3.schoolA,
      table_counts: meta.tableCounts,
      checksum: meta.sha256,
      tamperedTable: key,
    }
  })

  test.after(async () => {
    // 屏障状态必须已清空（任何测试失败都不允许留下“永久只读”）
    assert.deepEqual(writeBarrierSnapshot(), [], '测试结束后不得残留写屏障')
    await prisma.$disconnect()
  })

  test('① 并发恢复互斥：只一个执行（另一个 RESTORE_LOCK_BUSY 409），屏障仅在窗口内生效', async () => {
    const beforeRecords = restoreRecords().length
    const observed = []
    const hook = (tag) => ({
      afterStaging: async () => {
        observed.push({
          tag,
          readonlyMode: process.env.READONLY_MODE,
          barrierActive: isWriteBarrierActive(w3.schoolA),
        })
      },
    })
    const results = await Promise.allSettled([
      runRestore({ prisma, backup: baseline, targetSchoolCode: w3.schoolA, actor: { username: 'w3-a' }, log: silent, __hooks: hook('A') }),
      runRestore({ prisma, backup: baseline, targetSchoolCode: w3.schoolA, actor: { username: 'w3-b' }, log: silent, __hooks: hook('B') }),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.ok)
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(ok.length, 1, '同校并发恢复必须恰好一个成功')
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.code, 'RESTORE_LOCK_BUSY')
    assert.equal(rejected[0].reason.status, 409)

    // 胜者窗口内屏障必须生效；被拒者从未进入 staging
    assert.equal(observed.length, 1, '只有胜者进入 STAGING')
    assert.equal(observed[0].readonlyMode, 'true', 'STAGING 期必须复用 READONLY_MODE 全局写阻断')
    assert.equal(observed[0].barrierActive, true, 'STAGING 期必须有 per-school 写屏障')
    // 结束后拆除（进程环境还原，屏障清空）
    assert.notEqual(process.env.READONLY_MODE, 'true', '恢复结束后必须还原 READONLY_MODE')
    assert.equal(isWriteBarrierActive(w3.schoolA), false)

    const records = restoreRecords()
    assert.equal(records.length, beforeRecords + 2)
    const winner = records.find((r) => r.state === 'COMPLETE')
    const loser = records.find((r) => r.state === 'FAILED' && r.errorCode === 'RESTORE_LOCK_BUSY')
    assert.ok(winner && loser)
    assert.equal(loser.stagingSchema ?? null, null, '被拒任务不得创建暂存 schema')
    assert.equal(loser.workspace ?? null, null, '被拒任务不得创建工作目录')
    assert.equal(await readRealSentinel(prisma, w3), 1, '真实数据哨兵必须在位')
    // 默认语义（RESTORE_DROP_OLD 未设）：旧 schema 保留，供人工回滚
    assert.ok(winner.oldSchema, '胜利者台账必须登记旧 schema 名')
    assert.equal(await schemaExists(winner.oldSchema), true, '默认语义下旧 schema 必须保留')
  })

  test('② 撞名注入 + 暂存命名：随机暂存名/OID 登记；历史固定名与他任务暂存名不被 DROP', async () => {
    const complete = restoreRecords().filter((r) => r.state === 'COMPLETE')
    const rec = complete[complete.length - 1]
    assert.match(rec.stagingSchema, new RegExp(`^${w3.schemaA}_stg_[0-9a-f]{8}$`), '暂存名必须含随机熵')
    assert.notEqual(rec.stagingSchema, w3.legacyStaging)
    assert.notEqual(rec.stagingSchema, w3.foreignStaging)
    assert.ok(rec.stagingOid, '暂存 schema 必须登记 OID 归属')
    assert.equal(await schemaExists(rec.stagingSchema), false, '暂存名在切换后必须消失（已 rename 为目标 schema）')
    assert.equal(await schemaExists(w3.schemaA), true)

    const canaries = await readCanaries(prisma, w3)
    assert.equal(canaries.legacy.exists, true, '历史固定名 schema 必须存活（AUD-004 撞名主体）')
    assert.equal(canaries.legacy.rows, 1)
    assert.equal(canaries.foreign.exists, true, '他任务暂存形态名 schema 必须存活')
    assert.equal(canaries.foreign.rows, 1)
    // 恢复后目标 schema 中的数据 = 备份基线（逐表行数抽查）
    const key = Object.keys(baseline.table_counts).find((k) => k.endsWith('.TestRecord'))
    if (key) {
      const table = key.split('.').pop()
      const [{ n }] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${w3.schemaA}"."${table}"`)
      assert.equal(Number(n), Number(baseline.table_counts[key]))
    }
  })

  test('③ 失败清理：篡改计数 → 拒绝切换；只 DROP 本任务登记暂存 schema，他人对象与真实数据不受影响', async () => {
    const tmpBefore = listTmpPlaintextRestoreFiles()
    const recordsBefore = restoreRecords().length
    const r = await runRestore({ prisma, backup: tampered, targetSchoolCode: w3.schoolA, actor: { username: 'w3-c' }, log: silent })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /行数校验不一致/)
    assert.ok(r.jobId)

    const rec = readJobRecord(r.jobId)
    assert.equal(rec.state, 'FAILED')
    assert.equal(rec.stagingSchema, r.stagingSchema)
    assert.equal(await schemaExists(r.stagingSchema), false, '失败任务必须只 DROP 自己登记的暂存 schema')
    assert.equal(rec.cleanup?.dropped, true)
    assert.equal(fs.existsSync(path.join(jobLedgerRoot(), 'work', r.jobId)), false, '失败工作目录必须清理')

    const canaries = await readCanaries(prisma, w3)
    assert.equal(canaries.legacy.exists, true)
    assert.equal(canaries.legacy.rows, 1)
    assert.equal(canaries.foreign.exists, true)
    assert.equal(canaries.foreign.rows, 1)
    assert.equal(await readRealSentinel(prisma, w3), 1, '真实数据必须不受失败恢复影响')
    assert.equal(restoreRecords().length, recordsBefore + 1)
    // NF-B-02：明文 SQL 不再落 /tmp
    assert.deepEqual(listTmpPlaintextRestoreFiles().filter((f) => !tmpBefore.includes(f)), [], '/tmp 不得新增 restore_*.sql 明文文件')
  })

  test('④ drain 超时中止：屏障前在途写事务未结束时拒绝推进（数据零影响）', async () => {
    const prevTimeout = process.env.RESTORE_DRAIN_TIMEOUT_MS
    process.env.RESTORE_DRAIN_TIMEOUT_MS = '800'
    let result
    // 用同一 Prisma 客户端开一个“屏障前启动、停留 4s”的事务（其最后语句命中目标 schema）
    const lingering = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${w3.schemaA}"."User"`)
      await new Promise((resolve) => setTimeout(resolve, 4000))
    }, { timeout: 20000, maxWait: 20000 })
    try {
      await new Promise((resolve) => setTimeout(resolve, 300)) // 确保事务已在 pg_stat_activity 中可见
      result = await runRestore({ prisma, backup: baseline, targetSchoolCode: w3.schoolA, actor: { username: 'w3-d' }, log: silent })
    } finally {
      await lingering.catch(() => {})
      if (prevTimeout === undefined) delete process.env.RESTORE_DRAIN_TIMEOUT_MS
      else process.env.RESTORE_DRAIN_TIMEOUT_MS = prevTimeout
    }
    assert.equal(result.ok, false)
    assert.equal(result.code, 'RESTORE_DRAIN_TIMEOUT')
    assert.match(String(result.error), /drain 超时/)
    assert.equal(result.stagingSchema, null, 'drain 未通过时不得创建暂存 schema')
    assert.equal(await readRealSentinel(prisma, w3), 1, '中止恢复对数据零影响')
    const rec = readJobRecord(result.jobId)
    assert.equal(rec.state, 'FAILED')
    assert.equal(rec.errorCode, 'RESTORE_DRAIN_TIMEOUT')
    assert.equal(rec.drain ?? null, null, 'drain 未完成不得登记 drain 结果')
    // 屏障已拆除
    assert.equal(isWriteBarrierActive(w3.schoolA), false)
    assert.notEqual(process.env.READONLY_MODE, 'true')
  })

  test('⑤ RESTORE_DROP_OLD=drop：只清理本任务产生的旧 schema，不误删他任务保留的旧 schema', async () => {
    const keptOldSchemas = restoreRecords().filter((r) => r.state === 'COMPLETE' && r.postSwitch?.oldSchema).map((r) => r.postSwitch.oldSchema)
    assert.ok(keptOldSchemas.length >= 1, '前置：默认语义应保留过旧 schema')
    const prev = process.env.RESTORE_DROP_OLD
    process.env.RESTORE_DROP_OLD = 'drop'
    let r
    try {
      r = await runRestore({ prisma, backup: baseline, targetSchoolCode: w3.schoolA, actor: { username: 'w3-e' }, log: silent })
    } finally {
      if (prev === undefined) delete process.env.RESTORE_DROP_OLD
      else process.env.RESTORE_DROP_OLD = prev
    }
    assert.equal(r.ok, true)
    assert.equal(await schemaExists(r.oldSchema), false, 'RESTORE_DROP_OLD=drop 必须真正清理本任务旧 schema')
    for (const kept of keptOldSchemas) {
      assert.equal(await schemaExists(kept), true, `他任务保留的旧 schema 不得被误删: ${kept}`)
    }
    assert.equal(await readRealSentinel(prisma, w3), 1)
    const canaries = await readCanaries(prisma, w3)
    assert.equal(canaries.legacy.exists && canaries.foreign.exists, true)
  })

  test('⑦ 全库备份单校恢复：只提取目标学校段（另一校数据零影响），all-scope 锁覆盖全部对象', async () => {
    const allBackup = await runBackup({ prisma, scope: 'all', createdBy: 'w3-restore-suite', log: silent })
    const run = await prisma.backupRun.findUnique({ where: { id: allBackup.runId } })
    assert.ok(run)
    const sentinelABefore = await readRealSentinel(prisma, w3, w3.schemaA, w3.realSentinelIdA)
    const r = await runRestore({ prisma, backup: run, targetSchoolCode: w3.schoolB, actor: { username: 'w3-f' }, log: silent })
    assert.equal(r.ok, true)
    assert.equal(r.schema, w3.schemaB)
    // 只提取本校段：另一校真实数据哨兵不受影响
    assert.equal(await readRealSentinel(prisma, w3, w3.schemaA, w3.realSentinelIdA), sentinelABefore)
    assert.equal(await readRealSentinel(prisma, w3, w3.schemaB, w3.realSentinelIdB), 1)
    // 恢复后行数 = 全库备份中本校段的计数（抽查 TestRecord/User）
    for (const suffix of ['.TestRecord', '.User']) {
      const key = Object.keys(run.table_counts).find((k) => k === `${w3.schemaB}${suffix}`)
      if (!key) continue
      const table = key.split('.').pop()
      const [{ n }] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${w3.schemaB}"."${table}"`)
      assert.equal(Number(n), Number(run.table_counts[key]), `${table} 行数必须与备份基线一致`)
    }
    const canaries = await readCanaries(prisma, w3)
    assert.equal(canaries.legacy.exists && canaries.foreign.exists, true, '撞名哨兵在全库恢复路径下同样不得被触碰')
  })

  test('⑥ 台账无残留：全部恢复记录为终态、登记暂存对象均已消失、工作目录清空、/tmp 无明文', async () => {
    const records = restoreRecords()
    assert.ok(records.length >= 5)
    for (const rec of records) {
      assert.ok(['COMPLETE', 'FAILED', 'RECOVERY_REQUIRED'].includes(rec.state), `非终态残留: ${rec.jobId} state=${rec.state}`)
      if (rec.stagingSchema) {
        assert.equal(await schemaExists(rec.stagingSchema), false, `暂存对象残留: ${rec.jobId} → ${rec.stagingSchema}`)
      }
    }
    const workRoot = path.join(jobLedgerRoot(), 'work')
    const leftovers = fs.existsSync(workRoot) ? fs.readdirSync(workRoot) : []
    assert.deepEqual(leftovers, [], '工作目录必须全部清空（发布即 rename / 失败即删除）')
    const newTmpPlaintext = listTmpPlaintextRestoreFiles().filter((f) => !tmpPlaintextBaseline.includes(f))
    assert.deepEqual(newTmpPlaintext, [], '本套件不得在 /tmp 新增 restore_*.sql 明文文件（NF-B-02）')
    assert.equal(isWriteBarrierActive(w3.schoolA), false)
  })

  // ===== 追加（P3-W3-R1，DEFECT-1 回归护栏；只追加，不修改既有断言）=====
  test('⑧ 切换后租户授权与恢复前基线逐项一致（DEFECT-1 回归护栏）', async () => {
    // 独立实现（不调用被测模块的读取函数）：aclexplode 逐项读取目标 schema 上租户角色的授权。
    // P3-W3-R2（R4 返工）：独立读数**纳入 is_grantable** —— 与产品差集同一身份口径（可转授也参与比对），
    // 使本护栏不再是"名字相同即一致"的弱判别。
    const role = w3.derived.role
    const readRolePrivileges = async (schema) => {
      const schemaRows = await prisma.$queryRawUnsafe(
        `SELECT a.privilege_type AS p, (a.is_grantable = true) AS g FROM pg_namespace n
           CROSS JOIN LATERAL aclexplode(n.nspacl) a
           LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = $1::text AND COALESCE(r.rolname, 'PUBLIC') = $2::text
          ORDER BY 1`, schema, role)
      const objectRows = await prisma.$queryRawUnsafe(
        `SELECT c.relname AS n, a.privilege_type AS p, (a.is_grantable = true) AS g FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
           CROSS JOIN LATERAL aclexplode(c.relacl) a
           LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE ns.nspname = $1::text AND c.relkind = ANY($3::text[]) AND COALESCE(r.rolname, 'PUBLIC') = $2::text
          ORDER BY 1, 2`, schema, role, ['r', 'p', 'v', 'm', 'S'])
      return {
        schema: schemaRows.map((x) => `${x.p}:${x.g ? 1 : 0}`),
        objects: objectRows.map((x) => `${x.n}:${x.p}:${x.g ? 1 : 0}`),
      }
    }

    const before = await readRolePrivileges(w3.schemaA)
    assert.ok(before.schema.length >= 1, '前置：目标 schema 必须有租户角色 schema 级授权基线')
    assert.ok(before.objects.length >= 1, '前置：目标 schema 必须有租户角色对象级授权基线')

    const r = await runRestore({ prisma, backup: baseline, targetSchoolCode: w3.schoolA, actor: { username: 'w3-g' }, log: silent })
    assert.equal(r.ok, true, `恢复必须成功: ${r.error || ''}`)

    const after = await readRolePrivileges(w3.schemaA)
    assert.deepEqual(after.schema, before.schema, `切换后 schema 级授权必须与基线一致（DEFECT-1）`)
    assert.deepEqual(after.objects, before.objects, `切换后对象级授权必须与基线逐项一致（DEFECT-1）：缺失 ${before.objects.filter((x) => !after.objects.includes(x)).slice(0, 8).join(',')}`)

    // 修复登记：重放结果必须入台账（且自证满足基线下界）
    assert.ok(r.aclReplay && r.aclReplay.applied.length >= 1, '恢复必须登记授权重放结果')
    // P3-W3-R2（R4 返工）：字段口径说准 —— 断言**基线下界（逐项含可转授）已满足**，
    // 不虚称"双向完全相同"：恢复可能补出基线上不存在的新对象（如 _tenant_migrations），
    // 此时 verifiedIdentical=false 属**正确**语义，但必须由 strictMismatch 解释来源。
    assert.equal(r.aclReplay.verifiedBaselineSatisfied, true, '重放后必须满足基线下界（含可转授）')
    if (r.aclReplay.verifiedIdentical !== true) {
      const m = r.aclReplay.strictMismatch || {}
      const explained = (m.extraObjectNames || 0) + (m.missingObjectNames || 0) + (m.extraNotExpandedCount || 0)
        + (m.grantOptionUpgradeCount || 0) + (m.skippedCount || 0)
      assert.ok(explained > 0, `verifiedIdentical=false 必须由 strictMismatch 解释：${JSON.stringify(m)}`)
    }
    const rec = readJobRecord(r.jobId)
    assert.ok(rec.aclBaseline?.digest, '台账必须登记切换前授权基线摘要')
    assert.equal(rec.aclReplay.applied.length, r.aclReplay.applied.length)

    // 真实角色访问判别（修复前 = 42501 permission denied for schema）
    if (process.env.TEST_DATABASE_URL) {
      const { PrismaClient } = backendRequire('@prisma/client')
      const rolePrisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } })
      try {
        const [{ n }] = await rolePrisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${w3.schemaA}"."User"`)
        assert.equal(typeof Number(n), 'number', '租户角色必须能 SELECT 目标 schema')
        await rolePrisma.$executeRawUnsafe(`DELETE FROM "${w3.schemaA}"."TestRecord" WHERE false`)
      } finally {
        await rolePrisma.$disconnect()
      }
    }
    assert.equal(isWriteBarrierActive(w3.schoolA), false)
  })
}
