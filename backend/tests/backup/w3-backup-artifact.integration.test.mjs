// P3-W3-T01 备份产物定点集成测试（真实隔离 PG 实例；AUD-006 + AUD-007）
//
// 判别证据（对应任务包退出条件 ③④）：
//   ③ 备份持续写入下计数一致：快照正例（并发写入不进 dump，仍登记 ok/passed）
//      + 负例（live 模式检出不一致 → 拒绝登记、无 BackupRun 行、无发布产物、写失败日志）
//   ④ 同秒同范围并发备份：同 scope 并发只一个执行（另一个 409）；不同校并发一方失败不删对方产物
//
// 运行（先 source provisioner 的 test-env.sh 与 fixture 的 w3-env.sh）：
//   node --test --test-concurrency=1 backend/tests/backup/w3-backup-artifact.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadW3Harness, assertInstanceIdentity, listPublishedDirs, backendRequire } from './_w3-harness.mjs'

const w3 = loadW3Harness()
const enabled = w3.ok

if (!enabled) {
  test('备份产物集成测试：[W3] 缺少隔离实例环境 → 拒绝（fail-closed，不 skip）', () => {
    assert.fail(`[W3-HARNESS-REFUSED] code=${w3.code} missing=${(w3.missing || []).join(',')} reason=${w3.reason || 'n/a'}；需 provisioner + w3-instance-fixture 的环境`)
  })
}

if (enabled) {
  process.env.DATABASE_URL = w3.adminUrl // 引擎（pg_dump/psql）读取
  const { PrismaClient } = backendRequire('@prisma/client')
  const { runBackup } = await import('../../lib/backupService.js')
  const { verifyBackupFile } = await import('../../lib/backupVerify.js')
  const { listJobRecords, jobLedgerRoot, readJobRecord } = await import('../../lib/backupJobs.js')

  const prisma = new PrismaClient({ datasources: { db: { url: w3.adminUrl } } })
  const silent = () => {}

  async function insertConcurrentUser(id) {
    const other = new PrismaClient({ datasources: { db: { url: w3.adminUrl } } })
    try {
      await other.$executeRawUnsafe(
        `INSERT INTO "${w3.schemaA}"."User" (id, username, password_hash, full_name, role, status, created_at, updated_at)
         VALUES ($1, $1, 'x', 'w3 concurrent writer', 'operator', 'active', now(), now())`,
        id,
      )
    } finally {
      await other.$disconnect()
    }
  }

  async function countTenantUsers() {
    const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${w3.schemaA}"."User"`)
    return Number(rows[0].n)
  }

  test.before(async () => {
    const identity = await assertInstanceIdentity(prisma, w3)
    console.log(`[W3] 实例身份已核验：db=${identity.db} user=${identity.user} port=${identity.port} tag=${identity.instanceTag}`)
  })

  test.after(async () => { await prisma.$disconnect() })

  test('快照正例：备份窗口内有并发写入 → 计数与 dump 仍一致，登记 ok/passed', async () => {
    const before = await countTenantUsers()
    const concurrentId = `w3-concurrent-${Date.now()}`
    let observed = null
    const result = await runBackup({
      prisma,
      scope: 'single',
      schoolCode: w3.schoolA,
      createdBy: 'w3-integration',
      log: silent,
      __hooks: {
        beforeDump: async ({ jobId, mode, snapshotId, countsInSnapshot }) => {
          observed = { jobId, mode, snapshotId, countsInSnapshot }
          await insertConcurrentUser(concurrentId) // 独立连接 = 真实并发写入
        },
      },
    })

    assert.equal(result.snapshotMode, 'snapshot', '默认必须是共享导出快照模式')
    assert.ok(observed?.snapshotId, 'pgsql 导出快照 ID 必须存在')
    const key = `${w3.schemaA}.User`
    assert.equal(Number(observed.countsInSnapshot[key]), before, '快照内计数 = 并发写入前')
    assert.equal(Number(result.tableCounts[key]), before, 'dump 计数必须等于快照计数（并发写入不得进入 dump）')
    assert.equal(await countTenantUsers(), before + 1, '并发写入确实落在窗口内（活表已 +1）')

    const v = await verifyBackupFile(result.filePath, result.metaPath)
    assert.equal(v.ok, true, '产物必须通过离线验证（L1/L2-Lite）')
    const run = await prisma.backupRun.findUnique({ where: { id: result.runId } })
    assert.equal(run.status, 'ok')
    assert.equal(run.verify_status, 'passed')
    assert.equal(run.file_path, result.filePath)
    assert.ok(result.filePath.includes(result.jobId), '产物路径必须包含随机 jobId（命名空间独占）')
    const rec = readJobRecord(result.jobId)
    assert.equal(rec.state, 'COMPLETE')
    assert.equal(rec.filePath, result.filePath)
  })

  test('快照负例：live 模式并发写入 → 拒绝登记 ok/passed，且不留产物/不写 BackupRun', async () => {
    const prevMode = process.env.BACKUP_SNAPSHOT_MODE
    process.env.BACKUP_SNAPSHOT_MODE = 'live'
    let threw = null
    const runsBefore = await prisma.backupRun.count()
    const failsBefore = await prisma.systemLog.count({ where: { message: { startsWith: 'SECURITY:BACKUP_FAILED' } } })
    try {
      await runBackup({
        prisma,
        scope: 'single',
        schoolCode: w3.schoolA,
        createdBy: 'w3-integration',
        log: silent,
        __hooks: { beforeDump: async () => { await insertConcurrentUser(`w3-live-mismatch-${Date.now()}`) } },
      })
    } catch (e) {
      threw = e
    } finally {
      if (prevMode === undefined) delete process.env.BACKUP_SNAPSHOT_MODE
      else process.env.BACKUP_SNAPSHOT_MODE = prevMode
    }

    assert.ok(threw, 'live 模式检出不一致必须抛错')
    assert.equal(threw.code, 'BACKUP_ARTIFACT_INCONSISTENT')
    assert.equal(await prisma.backupRun.count(), runsBefore, '不一致的产物绝不能登记 BackupRun')
    const failsAfter = await prisma.systemLog.count({ where: { message: { startsWith: 'SECURITY:BACKUP_FAILED' } } })
    assert.ok(failsAfter > failsBefore, '必须写 SECURITY:BACKUP_FAILED 系统日志')

    const failed = listJobRecords().filter((r) => r.kind === 'backup' && r.state === 'FAILED' && r.errorCode === 'BACKUP_ARTIFACT_INCONSISTENT')
    assert.ok(failed.length >= 1, '台账必须留下 FAILED + errorCode=BACKUP_ARTIFACT_INCONSISTENT 记录')
    const rec = failed[failed.length - 1]
    assert.ok(!rec.publishedPath, '失败任务不得有发布路径')
    assert.equal(fs.existsSync(path.join(jobLedgerRoot(), 'work', rec.jobId)), false, '失败工作目录必须已清理')
    assert.equal(listPublishedDirs(w3.backupDir).some((d) => d.includes(rec.jobId)), false, '不得留下任何该任务发布目录')
  })

  test('同 scope 并发备份：只一个执行，另一个 409 明确拒绝且不产生任何产物', async () => {
    const dirsBefore = listPublishedDirs(w3.backupDir).length
    const results = await Promise.allSettled([
      runBackup({ prisma, scope: 'single', schoolCode: w3.schoolA, createdBy: 'w3-integration', log: silent }),
      runBackup({ prisma, scope: 'single', schoolCode: w3.schoolA, createdBy: 'w3-integration', log: silent }),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(ok.length, 1, '并发同 scope 必须恰好一个成功')
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.code, 'BACKUP_LOCK_BUSY')
    assert.equal(rejected[0].reason.status, 409)

    const dirsAfter = listPublishedDirs(w3.backupDir)
    assert.equal(dirsAfter.length, dirsBefore + 1, '只有成功方新增一个发布目录')
    assert.ok(dirsAfter.some((d) => d.includes(ok[0].value.jobId)))

    // 被拒方：无发布目录、无工作目录、台账 FAILED(LOCK_BUSY)
    const rejectedRecs = listJobRecords().filter((r) => r.kind === 'backup' && r.state === 'FAILED' && r.errorCode === 'BACKUP_LOCK_BUSY')
    assert.ok(rejectedRecs.length >= 1)
    const rec = rejectedRecs[rejectedRecs.length - 1]
    assert.equal(rec.workspace, null, '被拒任务不得创建工作目录')
    assert.equal(listPublishedDirs(w3.backupDir).some((d) => d.includes(rec.jobId)), false)
  })

  test('不同校并发备份：一方失败只清自己，成功方产物完好', async () => {
    let failingJobId = null
    const [failedSide, okSide] = await Promise.allSettled([
      runBackup({
        prisma,
        scope: 'single',
        schoolCode: w3.schoolB,
        createdBy: 'w3-integration',
        log: silent,
        __hooks: { beforeDump: async ({ jobId }) => { failingJobId = jobId; throw new Error('w3-injected-failure：模拟备份中途失败') } },
      }),
      runBackup({ prisma, scope: 'single', schoolCode: w3.schoolA, createdBy: 'w3-integration', log: silent }),
    ])
    assert.equal(failedSide.status, 'rejected')
    assert.equal(okSide.status, 'fulfilled')
    assert.ok(failingJobId)

    assert.equal(fs.existsSync(okSide.value.filePath), true, '成功方产物必须保留（失败清理不得触碰他人产物）')
    const okRec = readJobRecord(okSide.value.jobId)
    assert.equal(okRec.state, 'COMPLETE')
    const failRec = readJobRecord(failingJobId)
    assert.equal(failRec.state, 'FAILED')
    assert.equal(failRec.cleanup?.removed, true, '失败任务必须只清理自己的工作目录')
    assert.equal(fs.existsSync(path.join(jobLedgerRoot(), 'work', failingJobId)), false)
    assert.equal(listPublishedDirs(w3.backupDir).some((d) => d.includes(failingJobId)), false)
  })

  test('产物命名：随机 jobId 独占目录，连续两次备份互不覆盖', async () => {
    const a = await runBackup({ prisma, scope: 'single', schoolCode: w3.schoolB, createdBy: 'w3-integration', log: silent })
    const b = await runBackup({ prisma, scope: 'single', schoolCode: w3.schoolB, createdBy: 'w3-integration', log: silent })
    assert.notEqual(a.jobId, b.jobId)
    assert.notEqual(path.dirname(a.filePath), path.dirname(b.filePath), '两次备份发布目录必须不同')
    assert.ok(path.dirname(a.filePath).includes(a.jobId))
    assert.ok(path.dirname(b.filePath).includes(b.jobId))
    assert.equal(fs.existsSync(a.metaPath), true)
    assert.equal(fs.existsSync(b.metaPath), true)
  })
}
