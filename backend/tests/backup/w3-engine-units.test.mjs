// P3-W3-T01 单元层定点测试（无需数据库；纯函数/文件台账/中间件语义）
//
// 覆盖：
//   · dump 反推行数（AUD-006 的第二路证据）与分块流式解析
//   · 任务身份/台账原子写/工作区归属校验（AUD-007）
//   · 保留策略清理不得触碰台账目录（.jobs）
//   · 互斥锁键派生与 all-scope 稳定排序（AUD-005）
//   · 写屏障中间件与 READONLY_MODE 复用（AUD-005）
//   · 类型化错误 → HTTP 映射（409/503/500）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { analyzeDumpText, createDumpAnalyzer, diffCounts } from '../../lib/dumpCounts.js'
import {
  newJobId, randomToken, maintenanceLockKey, lockLabelsForScope,
  createJobRecord, readJobRecord, updateJobRecord, listJobRecords,
  createJobWorkspace, removeOwnWorkspace, jobLedgerRoot, jobWorkspaceDir, assertInside,
} from '../../lib/backupJobs.js'
import {
  beginWriteBarrier, endWriteBarrier, isWriteBarrierActive, writeBarrierSnapshot,
  createWriteBarrierMiddleware, resolveRequestSchoolCode,
  enterGlobalMaintenance, exitGlobalMaintenance, __resetWriteBarrierStateForTests,
} from '../../lib/tenantWriteBarrier.js'
import {
  MaintenanceLockBusyError, ArtifactConsistencyError, OwnershipViolationError,
  DrainTimeoutError, httpErrorFor, BACKUP_ERROR_CODES,
} from '../../lib/backupErrors.js'
import { cleanupOldBackups } from '../../lib/backupService.js'

const SAMPLE_DUMP = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '\\restrict abc',
  'SET statement_timeout = 0;',
  'CREATE SCHEMA public; CREATE SCHEMA school_demo; CREATE SCHEMA school_other;',
  '--',
  '-- Name: _prisma_migrations; Type: TABLE; Schema: school_demo; Owner: -',
  '--',
  'CREATE TABLE school_demo."_prisma_migrations" (id text);',
  '--',
  '-- Data for Name: _prisma_migrations; Type: TABLE DATA; Schema: school_demo; Owner: -',
  '--',
  'COPY school_demo."_prisma_migrations" (id) FROM stdin;',
  'mig-1',
  'mig-2',
  '\\.',
  '--',
  '-- Name: TestRecord; Type: TABLE; Schema: school_demo; Owner: -',
  '--',
  'CREATE TABLE school_demo."TestRecord" (id text, note text);',
  '--',
  '-- Data for Name: TestRecord; Type: TABLE DATA; Schema: school_demo; Owner: -',
  '--',
  'COPY school_demo."TestRecord" (id, note) FROM stdin;',
  'r1\t\\\\. escaped line',
  'r2\tplain',
  '\\.',
  '--',
  '-- Name: Empty; Type: TABLE; Schema: school_other; Owner: -',
  '--',
  'CREATE TABLE school_other."Empty" (id text);',
  '--',
  '-- Data for Name: Empty; Type: TABLE DATA; Schema: school_other; Owner: -',
  '--',
  'COPY school_other."Empty" (id) FROM stdin;',
  '\\.',
  '-- Name: User; Type: TABLE; Schema: school_other; Owner: -',
  'CREATE TABLE school_other."User" (id text);',
  'COPY school_other."User" (id) FROM stdin;',
  'u1',
  '\\.',
  '\\unrestrict abc',
].join('\n')

test('dump 反推行数：按 COPY 段计数、空表计 0、排除 _prisma_migrations、尊重转义行', () => {
  const r = analyzeDumpText(SAMPLE_DUMP)
  assert.equal(r.counts['school_demo.TestRecord'], 2)
  assert.equal(r.counts['school_other.Empty'], 0)
  assert.equal(r.counts['school_other.User'], 1)
  assert.equal(r.counts['school_demo._prisma_migrations'], undefined)
  // CREATE TABLE 计数排除 _prisma_migrations（供 L1 校验）
  assert.equal(r.createTableCount, 3)
})

test('dump 反推行数：分块写入（跨 chunk 边界）结果与整体一致', () => {
  const analyzer = createDumpAnalyzer()
  const chunkSize = 37
  for (let i = 0; i < SAMPLE_DUMP.length; i += chunkSize) analyzer.write(SAMPLE_DUMP.slice(i, i + chunkSize))
  const r = analyzer.end()
  assert.deepEqual(r.counts, analyzeDumpText(SAMPLE_DUMP).counts)
  assert.equal(r.createTableCount, 3)
})

test('diffCounts：逐表比对（缺失表按 null 处理，不一致必须被指出）', () => {
  const a = { 's.t1': 2, 's.t2': 0 }
  assert.equal(diffCounts(a, { 's.t1': 2, 's.t2': 0 }).consistent, true)
  const d = diffCounts(a, { 's.t1': 3, 's.t2': 0 })
  assert.equal(d.consistent, false)
  assert.deepEqual(d.mismatches, [{ table: 's.t1', snapshot: 2, dump: 3 }])
  assert.equal(diffCounts(a, { 's.t1': 2 }).consistent, false, 'dump 缺表不得当作一致')
})

test('任务身份：jobId 高熵且唯一；staging token 为 8 位十六进制', () => {
  const ids = new Set()
  for (let i = 0; i < 2000; i++) ids.add(newJobId('backup'))
  assert.equal(ids.size, 2000)
  for (const id of [...ids].slice(0, 5)) assert.match(id, /^backup-\d{8}t\d{8}-[0-9a-f]{16}$/)
  assert.match(randomToken(4), /^[0-9a-f]{8}$/)
})

test('锁键：同一标签稳定、不同标签互异；all-scope 标签按字典序（防死锁）', () => {
  assert.equal(maintenanceLockKey('maint:schema:school_a'), maintenanceLockKey('maint:schema:school_a'))
  assert.notEqual(maintenanceLockKey('maint:schema:school_a'), maintenanceLockKey('maint:schema:school_b'))
  const key = BigInt(maintenanceLockKey('maint:schema:school_a'))
  assert.ok(key > 0n && key <= 0x7fffffffffffffffn, '必须落在 PG bigint 正区间')
  const labels = lockLabelsForScope({ scope: 'all', schemas: ['school_z', 'school_a'] })
  assert.deepEqual(labels, ['maint:schema:public', 'maint:schema:school_a', 'maint:schema:school_z'])
  assert.deepEqual(lockLabelsForScope({ scope: 'single', schema: 'school_a' }), ['maint:schema:school_a'])
})

test('台账：create/read/update/list 原子写；重复 jobId 拒绝覆盖；越界路径拒绝', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'w3-ledger-'))
  process.env.BACKUP_JOB_LEDGER_DIR = path.join(root, '.jobs')
  try {
    const jobId = newJobId('unit')
    await createJobRecord({ jobId, kind: 'unit', state: 'QUEUED' })
    assert.equal(readJobRecord(jobId).state, 'QUEUED')
    await updateJobRecord(jobId, { state: 'RUNNING' })
    assert.equal(readJobRecord(jobId).state, 'RUNNING')
    assert.equal(listJobRecords().length, 1)
    await assert.rejects(() => createJobRecord({ jobId, kind: 'unit' }), /拒绝覆盖/)
    // 原子写不留 tmp 残渣
    const leftovers = fs.readdirSync(jobLedgerRoot()).filter((n) => n.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
    // 路径包含校验
    assert.throws(() => assertInside('/a/b', '/a/c'), /路径越界/)
    assert.equal(assertInside('/a/b', '/a/b/c'), true)
  } finally {
    delete process.env.BACKUP_JOB_LEDGER_DIR
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('工作区归属：台账无记录/未登记 → 拒绝删除；登记一致 → 只删自己的目录', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'w3-ws-'))
  process.env.BACKUP_JOB_LEDGER_DIR = path.join(root, '.jobs')
  try {
    const jobId = newJobId('unit')
    // 未登记工作区：createJobRecord 未写 workspace → 拒绝删除（fail-closed）
    await createJobRecord({ jobId, kind: 'unit', state: 'QUEUED', workspace: null })
    const dir = await createJobWorkspace(jobId)
    await fsp.writeFile(path.join(dir, 'half.aes'), 'partial')
    const r = await removeOwnWorkspace(jobId, 'unit-test')
    assert.equal(r.removed, false)
    assert.equal(r.reason, 'no_workspace_registered')
    assert.equal(fs.existsSync(dir), true)
    // 登记一致 → 删除
    await updateJobRecord(jobId, { workspace: dir })
    const r2 = await removeOwnWorkspace(jobId, 'unit-test')
    assert.equal(r2.removed, true)
    assert.equal(fs.existsSync(dir), false)
    // 台账记录缺失 → 拒绝
    const ghost = newJobId('unit')
    await assert.rejects(() => removeOwnWorkspace(ghost, 'unit-test'), /台账记录缺失/)
  } finally {
    delete process.env.BACKUP_JOB_LEDGER_DIR
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('保留策略清理：跳过台账目录，只清过期产物文件并删空产物目录', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'w3-clean-'))
  process.env.BACKUP_DIR = root
  process.env.BACKUP_JOB_LEDGER_DIR = path.join(root, '.jobs')
  process.env.BACKUP_KEEP_DAYS = '7'
  try {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    const dayDir = path.join(root, '2020-01-01')
    const pkgDir = path.join(dayDir, 'school_a.20200101_000000.backup-x-abc')
    await fsp.mkdir(pkgDir, { recursive: true })
    const oldAes = path.join(pkgDir, 'school_a.20200101_000000.sql.gz.aes')
    const oldMeta = path.join(pkgDir, 'school_a.20200101_000000.meta.json')
    await fsp.writeFile(oldAes, 'x')
    await fsp.writeFile(oldMeta, '{}')
    await fsp.utimes(oldAes, old, old)
    await fsp.utimes(oldMeta, old, old)
    // 台账目录里的记录（即使很旧）必须保留
    const jobId = newJobId('unit')
    await createJobRecord({ jobId, kind: 'unit', state: 'COMPLETE', workspace: null })
    const ledgerFile = path.join(jobLedgerRoot(), `${jobId}.json`)
    await fsp.utimes(ledgerFile, old, old)
    const removed = await cleanupOldBackups(root)
    assert.equal(removed, 2)
    assert.equal(fs.existsSync(oldAes), false)
    assert.equal(fs.existsSync(pkgDir), false, '空产物目录应被清理')
    assert.equal(fs.existsSync(ledgerFile), true, '台账文件不得按保留策略删除')
  } finally {
    delete process.env.BACKUP_DIR
    delete process.env.BACKUP_JOB_LEDGER_DIR
    delete process.env.BACKUP_KEEP_DAYS
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('写屏障：per-school 精确阻断、jobId 归属拆除、其他学校不受影响', async () => {
  __resetWriteBarrierStateForTests()
  const middleware = createWriteBarrierMiddleware()
  const call = (req) => new Promise((resolve) => {
    const res = {
      statusCode: 200, body: null, headers: {},
      status(c) { this.statusCode = c; return this },
      json(b) { this.body = b; resolve({ res: this, nextCalled: false }); return this },
      setHeader(k, v) { this.headers[k] = v },
    }
    middleware(req, res, () => resolve({ res, nextCalled: true }))
  })

  beginWriteBarrier({ schoolCode: 't02a-run-x-a', jobId: 'restore-1' })
  assert.equal(isWriteBarrierActive('t02a-run-x-a'), true)
  // 该校写请求 → 503 + Retry-After
  const blocked = await call({ method: 'POST', path: '/api/records', user: { schoolCode: 't02a-run-x-a' } })
  assert.equal(blocked.res.statusCode, 503)
  assert.equal(blocked.res.body.code, 'TENANT_WRITE_BARRIER')
  assert.equal(blocked.res.headers['Retry-After'], '5')
  // 该校读请求 → 放行
  assert.equal((await call({ method: 'GET', path: '/api/records', user: { schoolCode: 't02a-run-x-a' } })).nextCalled, true)
  // 其他学校写请求 → 放行
  assert.equal((await call({ method: 'POST', path: '/api/records', user: { schoolCode: 'other-school' } })).nextCalled, true)
  // 路径前缀/query 也能识别目标学校
  assert.equal((await call({ method: 'POST', path: '/t02a-run-x-a/api/records' })).res.statusCode, 503)
  assert.equal(resolveRequestSchoolCode({ method: 'POST', path: '/api/records', query: { school: 't02a-run-x-a' } }), 't02a-run-x-a')
  // 错误 jobId 不能拆除
  assert.equal(endWriteBarrier({ schoolCode: 't02a-run-x-a', jobId: 'restore-2' }).released, false)
  assert.equal(isWriteBarrierActive('t02a-run-x-a'), true)
  assert.equal(endWriteBarrier({ schoolCode: 't02a-run-x-a', jobId: 'restore-1' }).released, true)
  assert.equal(writeBarrierSnapshot().length, 0)

  // 全局维护开关（复用 READONLY_MODE）：进入 → 阻断所有写；释放 → 还原原值
  delete process.env.READONLY_MODE
  const t = enterGlobalMaintenance({ token: 'unit-maint' }).token
  assert.equal(process.env.READONLY_MODE, 'true')
  const globalBlocked = await call({ method: 'POST', path: '/api/anything' })
  assert.equal(globalBlocked.res.statusCode, 503)
  assert.equal(globalBlocked.res.body.code, 'GLOBAL_MAINTENANCE')
  exitGlobalMaintenance(t)
  assert.equal(process.env.READONLY_MODE, undefined, '未设置过 → 释放后必须删除而不是留 "undefined"')
  // 嵌套：内层释放不还原，外层释放才还原到最初值
  process.env.READONLY_MODE = 'false'
  const t1 = enterGlobalMaintenance({ token: 'outer' }).token
  const t2 = enterGlobalMaintenance({ token: 'inner' }).token
  exitGlobalMaintenance(t2)
  assert.equal(process.env.READONLY_MODE, 'true')
  exitGlobalMaintenance(t1)
  assert.equal(process.env.READONLY_MODE, 'false')
  delete process.env.READONLY_MODE
  __resetWriteBarrierStateForTests()
})

test('类型化错误 → HTTP 映射：锁占用 409、drain 超时 503、不一致/归属 500', () => {
  const lock = new MaintenanceLockBusyError('busy', { kind: 'restore' })
  assert.equal(lock.code, BACKUP_ERROR_CODES.RESTORE_LOCK_BUSY)
  assert.deepEqual(httpErrorFor(lock).status, 409)
  const lockBackup = new MaintenanceLockBusyError('busy', { kind: 'backup' })
  assert.equal(lockBackup.code, BACKUP_ERROR_CODES.BACKUP_LOCK_BUSY)
  assert.equal(httpErrorFor(new DrainTimeoutError('drain', {})).status, 503)
  assert.equal(httpErrorFor(new ArtifactConsistencyError('inconsistent', {})).status, 500)
  assert.equal(httpErrorFor(new OwnershipViolationError('ownership', {})).status, 500)
  const plain = new Error('boom')
  const mapped = httpErrorFor(plain, { fallbackMessage: '失败' })
  assert.equal(mapped.status, 500)
  assert.equal(mapped.error, 'boom')
})

test('工作区目录名与 jobId 绑定（拒绝按拼接路径删除他人目录）', () => {
  process.env.BACKUP_JOB_LEDGER_DIR = path.join(os.tmpdir(), 'w3-path-unit', '.jobs')
  try {
    const jobId = newJobId('unit')
    assert.equal(path.basename(jobWorkspaceDir(jobId)), jobId)
    assert.throws(() => jobWorkspaceDir('../../etc'), /非法 jobId|路径越界/)
  } finally {
    delete process.env.BACKUP_JOB_LEDGER_DIR
  }
})
