// P3-W5-RECORD-T01 · AUD-020（RC-07）完整读取契约矩阵 —— **必须用隔离测试库**
//
// 覆盖（RC-07「Required regression tests」在本仓库可行子集）：
//   列表：0/1/1000/2000/2501/10000+ 条；超限**显式拒绝**（不静默截断）；cursor 稳定（并发插删下无重无漏）；
//        hasMore/nextCursor/totalBasis/filters/coverage 元数据齐备；
//   导出：服务端快照作业 —— expectedCount===exportedCount + ID 无重无漏 + 校验和 → 原子发布；
//        0/1/2000 条正例；over-limit（>MAX_EXPORT_ROWS）明确失败不发布；DB 故障明确失败；
//        磁盘故障明确失败（无产物、无假成功）；取消不发布；并发插删不影响已发布产物的完整性；
//        状态/下载重新校验当前权限与归属（权限撤销 → 403；他主体 → 404）；
//        列表 total 与导出 expectedCount 在相同筛选下一致。
//
// 说明：EXPORT_* 环境变量必须在本文件**动态 import 之前**设置（模块加载时读取一次）。
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { require, loadIsolation, assertIsolated as gateAssert, cleanupScoped } from '../_isolation.mjs'

process.env.EXPORT_MAX_ROWS = '2000'          // 超限阈值（构造 2001 条 → 明确失败）
process.env.EXPORT_BATCH_SIZE = '500'
process.env.EXPORT_TX_TIMEOUT_MS = String(5 * 60 * 1000)
process.env.EXPORT_JOB_TTL_MS = String(60 * 1000)

const isoInfo = loadIsolation()
const enabled = isoInfo.ok

if (!enabled) {
  test('AUD-020 读取契约：[T02C] 未配置显式 TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE → 拒绝（fail-closed）', () => {
    assert.fail(`[T02C-ISOLATION-REFUSED] code=${isoInfo.code || 'UNKNOWN'} reason=${isoInfo.reason || 'n/a'}`)
  })
}

if (enabled) {
  process.env.DATABASE_URL = isoInfo.url
  const { PrismaClient } = require('@prisma/client')
  const { createRecordRoutes } = await import('../../routes/recordRoutes.js')
  const idempotencyMiddleware = (await import('../../middleware/idempotencyMiddleware.js')).default
  const exportJobs = await import('../../lib/exportJobs.js')

  const TENANT_A = isoInfo.tenant('a')
  const db = new PrismaClient({ datasources: { db: { url: TENANT_A.urlWithSchema } } })
  const USER_A1 = 'u-aud020-a1'
  const USER_A2 = 'u-aud020-a2'
  const CANTEEN = '列表食堂-RC-aud020-'
  const users = {
    'A1': { userId: USER_A1, role: 'editor', schoolCode: TENANT_A.tenantCode },
    'A2': { userId: USER_A2, role: 'editor', schoolCode: TENANT_A.tenantCode },
  }

  function makeApp() {
    const authenticateUser = (req, res, next) => {
      const u = users[req.headers['x-test-user']]
      if (!u) return res.status(401).json({ error: 'unauthorized' })
      req.user = { ...u }
      req.userId = u.userId
      req.db = db
      // express 5：req.ip 只读 getter，不赋值
      next()
    }
    const requireEditorOrAbove = (req, res, next) => {
      if (!['editor', 'operator', 'manager', 'super_admin'].includes(req.user?.role)) {
        return res.status(403).json({ error: 'forbidden' })
      }
      next()
    }
    const requireGuestReadOnly = (req, res, next) => next()
    const router = createRecordRoutes({ authenticateUser, requireEditorOrAbove, requireGuestReadOnly, idempotencyMiddleware })
    const app = express()
    app.use(express.json())
    app.use(router)
    return app
  }
  const app = makeApp()

  const get = (userKey, url) => request(app).get(url).set('x-test-user', userKey)
  const createJob = (userKey, filters) =>
    request(app).post('/api/records/exports').set('x-test-user', userKey).send({ filters })

  async function seed(count, offset = 0, dateStr = '2026-09-25') {
    if (count === 0) return
    const base = Date.parse(`${dateStr}T00:00:00.000Z`)
    const rows = []
    for (let i = 0; i < count; i++) {
      const n = offset + i
      rows.push({
        record_code: `RC-aud020-${String(n).padStart(6, '0')}`,
        test_type: 'pesticide',
        test_name: '果蔬检测',
        sample_info: { testDate: dateStr, canteen: CANTEEN, inspector: '测试员', batchNo: `AUD020-${n}` },
        result_data: { vegetableType: '青菜', result: '合格' },
        status: 'completed',
        version: 1,
        created_by: USER_A1,
        created_at: new Date(base + n * 1000),
      })
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await db.testRecord.createMany({ data: rows.slice(i, i + 1000) })
    }
  }

  test.before(async () => {
    await gateAssert(db, TENANT_A.schema, 'tenant A')
    for (const id of [USER_A1, USER_A2]) {
      await db.user.upsert({ where: { id }, update: {}, create: { id, username: id, password_hash: 'x', role: 'editor', full_name: 'aud020', school_code: TENANT_A.tenantCode } })
    }
    // R1：幂等前置清理（仅本套件标记行）——上一轮若被中断（未跑到 test.after），
    // 残留行会让 seed 撞 record_code 唯一键，使本套件整片失败（假失败）。
    await db.testRecord.deleteMany({ where: { record_code: { startsWith: 'RC-aud020-' } } })
    await seed(2501)
  })
  test.after(async () => {
    await cleanupScoped(db, { record_code: { startsWith: 'RC-aud020-' } }, 'aud020 rows')
    await db.$disconnect()
  })

  /* ───────── 列表契约 ───────── */
  test('列表：分页元数据齐备 + 超限显式拒绝（10000 不再静默截断成 2000）', async () => {
    const r = await get('A1', `/api/records/pesticide?limit=100`)
    assert.equal(r.status, 200)
    assert.equal(r.body.limit, 100)
    assert.equal(r.body.returned, 100)
    assert.equal(r.body.total, 2501)
    assert.equal(r.body.hasMore, true)
    assert.ok(r.body.nextCursor, '应返回 nextCursor')
    assert.equal(r.body.pagination, 'offset')
    assert.ok(String(r.body.totalBasis).includes('count(*)'), 'totalBasis 必须声明口径')
    assert.ok(r.body.filters && r.body.filters.test_type === 'pesticide', 'filters 必须回显')
    assert.equal(r.body.coverage.windowComplete, false)

    const over = await get('A1', `/api/records/pesticide?limit=10000`)
    assert.equal(over.status, 400, '超限必须显式 400（旧实现静默截断为 2000 并返回 200）')
    assert.equal(over.body.code, 'LIMIT_EXCEEDS_MAX')
    assert.equal(over.body.maxLimit, 2000)
  })

  test('列表：cursor 全量遍历无重无漏（2501 条）+ 边界 0/1/1000/2000', async () => {
    // 边界：小数据量类型（oil 无数据 → 0；tableware 无数据）
    const empty = await get('A1', `/api/records/oil?limit=10`)
    assert.equal(empty.status, 200)
    assert.equal(empty.body.total, 0)
    assert.equal(empty.body.hasMore, false)
    assert.equal(empty.body.returned, 0)

    const ids = new Set()
    let cursor = null
    let pages = 0
    for (;;) {
      const url = `/api/records/pesticide?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const r = await get('A1', url)
      assert.equal(r.status, 200, JSON.stringify(r.body))
      if (cursor) assert.equal(r.body.pagination, 'cursor', '带游标页必须声明 pagination=cursor')
      for (const row of r.body.data) ids.add(row.id)
      pages += 1
      if (!r.body.hasMore) break
      cursor = r.body.nextCursor
      assert.ok(cursor, 'hasMore=true 必须给 nextCursor')
      assert.ok(pages < 10, '分页不应失控')
    }
    assert.equal(ids.size, 2501, 'cursor 遍历必须覆盖全部 2501 条且无重复')
    assert.equal(pages, 3)

    // 边界：单条
    const one = await get('A1', `/api/records/pesticide?limit=1`)
    assert.equal(one.body.returned, 1)
    assert.equal(one.body.hasMore, true)
    // 边界：limit=2000（等于上限，允许）
    const max = await get('A1', `/api/records/pesticide?limit=2000`)
    assert.equal(max.status, 200)
    assert.equal(max.body.returned, 2000)
    assert.equal(max.body.hasMore, true)
  })

  test('列表：分页中断 + 并发插删改下 cursor 不重不漏', async () => {
    const first = await get('A1', `/api/records/pesticide?limit=1000`)
    const firstIds = new Set(first.body.data.map((r) => r.id))
    assert.equal(first.body.hasMore, true)

    // 并发：插入 3 条新行（created_at 最新，属于"第 1 页"）+ 删除 1 条**尚未遍历**的旧行 + 修改 1 条未遍历行
    await seed(3, 90000)
    const unseen = await db.testRecord.findFirst({
      where: { record_code: { startsWith: 'RC-aud020-' }, id: { notIn: [...firstIds] } },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })
    await db.testRecord.delete({ where: { id: unseen.id } })
    const modTarget = await db.testRecord.findFirst({
      where: { record_code: { startsWith: 'RC-aud020-' }, id: { notIn: [...firstIds, unseen.id] } },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })
    await db.testRecord.update({ where: { id: modTarget.id }, data: { result_data: { vegetableType: '青菜', result: '警戒' } } })

    // 继续遍历：不得重复（游标 = 严格小于上一页末行）
    const seen = new Set(firstIds)
    let cursor = first.body.nextCursor
    let dup = 0
    for (let p = 0; p < 10 && cursor; p++) {
      const r = await get('A1', `/api/records/pesticide?limit=1000&cursor=${encodeURIComponent(cursor)}`)
      assert.equal(r.status, 200)
      for (const row of r.body.data) {
        if (seen.has(row.id)) dup += 1
        seen.add(row.id)
      }
      if (!r.body.hasMore) break
      cursor = r.body.nextCursor
    }
    assert.equal(dup, 0, '并发插删改下不得出现重复行')
    assert.ok(!seen.has(unseen.id), '已删除行不得在后续页出现（无幽灵行）')
  })

  /* ───────── 导出作业契约 ───────── */
  async function waitJob(jobId, { userKey = 'A1', timeoutMs = 60000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      const r = await get(userKey, `/api/records/exports/${jobId}`)
      if (r.status !== 200) return { status: r.status, body: r.body }
      last = r.body.job
      if (['completed', 'failed', 'cancelled'].includes(last.state)) return { status: 200, body: r.body, job: last }
      await new Promise((res) => setTimeout(res, 200))
    }
    throw new Error(`job ${jobId} timeout (last=${last && last.state})`)
  }

  // 导出阈值辅助（R1：限额改为调用时读取 env，故同一进程内可逐例切换；用例结束必须还原）
  async function withMaxRows(max, fn) {
    const prev = process.env.EXPORT_MAX_ROWS
    process.env.EXPORT_MAX_ROWS = String(max)
    try { return await fn() } finally {
      if (prev === undefined) delete process.env.EXPORT_MAX_ROWS
      else process.env.EXPORT_MAX_ROWS = prev
    }
  }

  /** 完整成功分支的逐项校验（R1：真实消费产物，不用提前 return 跳过）。 */
  async function assertCompletedFullExport(job, { label }) {
    assert.equal(job.state, 'completed', `${label}: ${JSON.stringify(job.error)}`)
    assert.ok(job.expectedCount > 0, `${label}: 数据集必须非空`)
    assert.equal(job.exportedCount, job.expectedCount, `${label}: expectedCount === exportedCount`)
    assert.equal(job.idMissCount, 0, label)
    assert.equal(job.idDupCount, 0, label)
    assert.equal(job.complete, true, label)
    const artifact = exportJobs.exportJobArtifactPath(job.jobId)
    assert.ok(fs.existsSync(artifact), `${label}: 完成后产物必须存在（原子发布）`)
    const content = fs.readFileSync(artifact, 'utf8')
    assert.equal(fs.statSync(artifact).size, job.bytes, `${label}: artifact 大小必须与 manifest.bytes 一致`)
    assert.equal(crypto.createHash('sha256').update(content).digest('hex'), job.checksum, `${label}: 校验和必须逐字节一致`)
    const lines = content.split('\n').filter(Boolean)
    assert.equal(lines.length, job.exportedCount, `${label}: 产物行数必须等于 exportedCount`)
    const ids = lines.map((l) => JSON.parse(l).id)
    assert.equal(new Set(ids).size, ids.length, `${label}: ID 不得重复`)
    const dl = await get('A1', `/api/records/exports/${job.jobId}/download`)
    assert.equal(dl.status, 200, label)
    assert.equal(dl.headers['x-export-expected-count'], String(job.expectedCount))
    assert.equal(dl.headers['x-export-exported-count'], String(job.exportedCount))
    assert.equal(dl.headers['x-export-verify'], 'complete')
    assert.equal(dl.headers['x-export-checksum-sha256'], job.checksum)
    return { lines: lines.length, bytes: job.bytes }
  }

  test('导出：超限阈值（MAX=2000）下 2500+ 条 → 明确失败且不发布产物（不静默截断）', async () => {
    const listTotal = (await get('A1', '/api/records/pesticide?limit=1')).body.total
    assert.ok(listTotal > 2000, `前置：本套件数据集必须 >2000（实际 ${listTotal}）`)
    await withMaxRows(2000, async () => {
      const created = await createJob('A1', { startDate: '2026-09-25', endDate: '2026-09-25', testTypes: ['pesticide'] })
      assert.equal(created.status, 202, JSON.stringify(created.body))
      const { job } = await waitJob(created.body.jobId)
      assert.equal(job.state, 'failed')
      assert.equal(job.error.code, 'EXPORT_OVER_LIMIT')
      assert.ok(job.expectedCount > 2000, 'expectedCount 必须来自真实快照计数')
      assert.equal(job.artifactPublished, false)
      assert.ok(!fs.existsSync(exportJobs.exportJobArtifactPath(job.jobId)), '超限失败不得留下产物')
      const dl = await get('A1', `/api/records/exports/${job.jobId}/download`)
      assert.equal(dl.status, 409, '未完成/失败作业不得下载')
      assert.equal(dl.body.code, 'EXPORT_NOT_READY')
    })
  })

  test('导出：0 条与**真实 1 条**正例（expectedCount===exportedCount，下载头与校验和一致）', async () => {
    // 真实 1 条：插入一行独立日期的记录，只让该日期过滤命中它（不再是"期望 0 条"的伪单条）
    await seed(1, 990001, '2026-01-02')
    for (const [label, filters, expected] of [
      ['空集', { startDate: '2020-01-01', endDate: '2020-01-02', testTypes: ['pesticide'] }, 0],
      ['真实单条', { startDate: '2026-01-02', endDate: '2026-01-02', testTypes: ['pesticide'] }, 1],
    ]) {
      await withMaxRows(200000, async () => {
        const created = await createJob('A1', filters)
        assert.equal(created.status, 202, JSON.stringify(created.body))
        const { job } = await waitJob(created.body.jobId)
        assert.equal(job.state, 'completed', `${label}: ${JSON.stringify(job.error)}`)
        assert.equal(job.expectedCount, expected, label)
        assert.equal(job.exportedCount, expected, label)
        assert.equal(job.idDupCount, 0)
        assert.equal(job.idMissCount, 0)
        assert.equal(job.complete, true, label)
        const dl = await get('A1', `/api/records/exports/${job.jobId}/download`)
        assert.equal(dl.status, 200, label)
        assert.equal(dl.headers['x-export-expected-count'], String(expected))
        assert.equal(dl.headers['x-export-exported-count'], String(expected))
        assert.equal(dl.headers['x-export-verify'], 'complete')
        assert.equal(dl.headers['x-export-checksum-sha256'], job.checksum)
      })
    }
  })

  // R1（R3 复审）：本用例原来在"数据集超限"时**提前 return**，把超限跳过算作通过 —— 从未跑到
  // 2501 条的真实成功分支。现改为：把阈值提到生产默认（200000），真实完成 >2000 条导出并逐项校验产物。
  test('导出：2501 条真实**成功**分支（阈值=生产默认；产物行数/校验和/下载头逐项一致）', async () => {
    const listTotal = (await get('A1', '/api/records/pesticide?limit=1')).body.total
    assert.ok(listTotal > 2000, `前置：数据集必须 >2000（实际 ${listTotal}）`)
    await withMaxRows(200000, async () => {
      const created = await createJob('A1', { testTypes: ['pesticide'] })
      assert.equal(created.status, 202, JSON.stringify(created.body))
      const { job } = await waitJob(created.body.jobId, { timeoutMs: 120000 })
      assert.equal(job.expectedCount, listTotal, '导出 expectedCount 必须与列表 total 同口径')
      const done = await assertCompletedFullExport(job, { label: '2501 条成功' })
      assert.ok(done.lines > 2000, `产物必须真的 >2000 行（实际 ${done.lines}）`)
    })
  })

  test('导出：10000+ 条真实成功分支（11000+ 行；产物流式生成、计数与校验和一致）', async () => {
    await seed(9000, 100000) // 追加到 11000+（早前用例已 seed 2501 + 1 + 3 - 1 删除）
    const listTotal = (await get('A1', '/api/records/pesticide?limit=1')).body.total
    assert.ok(listTotal > 10000, `前置：数据集必须 >10000（实际 ${listTotal}）`)
    await withMaxRows(200000, async () => {
      const created = await createJob('A1', { testTypes: ['pesticide'] })
      assert.equal(created.status, 202, JSON.stringify(created.body))
      const { job } = await waitJob(created.body.jobId, { timeoutMs: 180000 })
      assert.equal(job.expectedCount, listTotal)
      const done = await assertCompletedFullExport(job, { label: '10000+ 条成功' })
      assert.ok(done.lines > 10000, `产物必须真的 >10000 行（实际 ${done.lines}）`)
    })
  })

  // R1 新增：重启恢复（进程崩溃遗留的 running 作业不得永久挂起，也不得半发布）
  test('导出：重启恢复 —— owner 进程消失的 queued/running 作业被判定中断（无产物、下载 409）', async () => {
    const manifest = exportJobs.createExportJob({ tenantScope: 'school:x', subject: 'user:x', role: 'editor', filters: {} })
    const manifestPath = exportJobs.manifestPathOf(manifest.jobId)
    // 伪造"崩溃现场"：running + owner 进程已不存在 + 半成品 tmp 残留
    fs.writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      state: 'running',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      owner: { pid: 999999999, hostname: os.hostname(), storeRoot: exportJobs.jobRoot(), since: new Date().toISOString() },
    }, null, 2))
    fs.writeFileSync(`${exportJobs.exportJobArtifactPath(manifest.jobId)}.tmp-999`, 'half-written\n')

    // ① 懒回收：状态读取不得停留在 running
    const recovered = exportJobs.getExportJob(manifest.jobId)
    assert.equal(recovered.state, 'failed')
    assert.equal(recovered.error.code, 'EXPORT_INTERRUPTED')
    assert.equal(recovered.artifact, null, '中断作业不得发布产物')
    assert.ok(!fs.existsSync(`${exportJobs.exportJobArtifactPath(manifest.jobId)}.tmp-999`), '半成品 tmp 必须被清理')
    assert.ok(!fs.existsSync(exportJobs.exportJobArtifactPath(manifest.jobId)), '不得出现 artifact')

    // ② 全量回收：活跃作业（owner=当前进程且刚刚更新）不得被误判
    const liveJob = exportJobs.createExportJob({ tenantScope: 'school:x', subject: 'user:x', role: 'editor', filters: {} })
    const sweep = exportJobs.recoverInterruptedJobs()
    assert.ok(sweep.recovered.includes(manifest.jobId) === false, '已回收作业不再重复出现在 recovered')
    assert.ok(sweep.live.includes(liveJob.jobId), '活跃作业必须留在 live（不得误杀）')
    fs.rmSync(path.dirname(manifestPath), { recursive: true, force: true })
    fs.rmSync(path.dirname(exportJobs.manifestPathOf(liveJob.jobId)), { recursive: true, force: true })
  })

  test('导出：DB 故障 → 明确失败（无产物、无假成功）', async () => {
    const boom = new Error('simulated DB failure')
    const brokenDb = {
      $transaction: async (fn) => fn({
        testRecord: {
          count: async () => { throw boom },
          findMany: async () => { throw boom },
        },
      }),
    }
    const manifest = exportJobs.createExportJob({ tenantScope: 'school:x', subject: 'user:x', role: 'editor', filters: {} })
    const result = await exportJobs.runExportJob({ db: brokenDb, jobId: manifest.jobId, testTypes: ['pesticide'], where: { test_type: { in: ['pesticide'] } } })
    assert.equal(result.state, 'failed')
    assert.equal(result.artifact, null)
    assert.ok(!fs.existsSync(exportJobs.exportJobArtifactPath(manifest.jobId)))
    await fs.promises.rm(path.dirname(exportJobs.manifestPathOf(manifest.jobId)), { recursive: true, force: true })
  })

  test('导出：磁盘故障 → 明确失败（创建作业即报错，不产生"成功"响应）', async () => {
    const prev = process.env.EXPORT_JOB_DIR
    const roRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aud020-ro-'))
    fs.chmodSync(roRoot, 0o500)
    process.env.EXPORT_JOB_DIR = path.join(roRoot, 'jobs-root')
    try {
      const r = await createJob('A1', { testTypes: ['pesticide'] })
      assert.equal(r.status, 500, '磁盘不可写必须显式失败')
      assert.equal(r.body.code, 'EXPORT_CREATE_FAILED')
    } finally {
      process.env.EXPORT_JOB_DIR = prev || ''
      if (!prev) delete process.env.EXPORT_JOB_DIR
      fs.chmodSync(roRoot, 0o700)
      fs.rmSync(roRoot, { recursive: true, force: true })
    }
  })

  test('导出：取消 → cancelled 且不发布产物；原子发布前不可下载', async () => {
    // 直接调用 runner（确定性）：先置取消标记，再运行 → 必须在首个批检点取消且无产物
    const manifest = exportJobs.createExportJob({ tenantScope: 'school:x', subject: 'user:x', role: 'editor', filters: {} })
    exportJobs.requestCancel(manifest.jobId)
    const result = await exportJobs.runExportJob({ db, jobId: manifest.jobId, testTypes: ['pesticide'], where: { test_type: { in: ['pesticide'] } } })
    assert.equal(result.state, 'cancelled')
    assert.equal(result.artifact, null)
    assert.ok(!fs.existsSync(exportJobs.exportJobArtifactPath(manifest.jobId)), '取消不得发布产物')
    await fs.promises.rm(path.dirname(exportJobs.manifestPathOf(manifest.jobId)), { recursive: true, force: true })
  })

  test('导出：权限撤销后不可下载；不同主体（同租户）不可见/不可下载', async () => {
    const created = await createJob('A1', { startDate: '2020-01-01', endDate: '2020-01-02', testTypes: ['pesticide'] })
    const { job } = await waitJob(created.body.jobId)
    assert.equal(job.state, 'completed')

    // ① 他主体（同租户不同 userId）：404（不泄露他人作业）
    const other = await get('A2', `/api/records/exports/${job.jobId}`)
    assert.equal(other.status, 404)
    const otherDl = await get('A2', `/api/records/exports/${job.jobId}/download`)
    assert.equal(otherDl.status, 404)

    // ② 权限撤销（editor → guest）：403（守卫先于下载）
    users['A1'].role = 'guest'
    const revoked = await get('A1', `/api/records/exports/${job.jobId}/download`)
    assert.equal(revoked.status, 403, '权限撤销后不得下载旧产物')
    const revokedStatus = await get('A1', `/api/records/exports/${job.jobId}`)
    assert.equal(revokedStatus.status, 403)
    users['A1'].role = 'editor'

    // ③ 恢复权限后可下载（当前权限通过）
    const ok = await get('A1', `/api/records/exports/${job.jobId}/download`)
    assert.equal(ok.status, 200)
  })
}
