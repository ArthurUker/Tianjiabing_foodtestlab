// P3-W3-CROSS-REG-R2 · 外部备份注册模块离线单元测试（**无需数据库/PG**）。
//
// 覆盖（受控最小面；R1 的 11 场景语义保留 + R2 来源 fail-closed 扩展）：
//   ① 正例：合法产物 + meta + 显式来源 → 落 BackupRun（run_type='external_import'、
//      created_by='external:<sourceRunId>'）+ 独立审计（同事务）+ 学校身份校核（schoolStatus）；
//   ② --dry-run：全校验但不落库；
//   ③ 完整性/一致性拒绝：sha256 篡改 / 大小不符 / 表计数不符 / scope·school·来源不符 / meta 缺字段；
//   ④ 路径安全拒绝：root 外（穿越）/ 符号链接；
//   ⑤ 冲突拒绝：同 file_path / 同 checksum+scope+school 已注册；
//   ⑥ 契约边界：注册记录不伪装本实例来源（run_type/created_by/审计三处一致）；
//   ⑦ **来源 fail-closed（R10 :12/:19）**：未提供显式来源 → REG_SOURCE_REQUIRED；
//      meta.runId 缺失（旧格式）→ REG_META_SOURCE_MISSING；不允许 external:unknown；
//   ⑧ **学校身份校核（R10）**：目标实例不存在该校 / 状态异常 → REG_SCHOOL_UNKNOWN；
//   ⑨ **审计失败 → 整体回滚（mock 层）**：SystemLog 写入失败时 BackupRun 不得提交。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { encryptFile } from '../../lib/backupKms.js'
import { registerExternalBackup, ExternalRegistrationError } from '../../lib/externalBackupRegistration.js'

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// ── 产物构造（真实加密+压缩；local 主密钥模式）──
process.env.BACKUP_MASTER_KEY = process.env.BACKUP_MASTER_KEY || crypto.randomBytes(32).toString('base64')

const SQL_TEXT = [
  'CREATE TABLE "t1" (id integer);',
  'CREATE TABLE "t2" (id integer);',
  'COPY "t1" (id) FROM stdin;',
  '1',
  '\\.',
].join('\n')

/** 生成一份可被 verifyBackupFile 通过的真实产物（.sql.gz.aes + .meta.json）。 */
async function makeArtifact(rootDir, { overrides = {}, name = 'w3r2cross-fixed' } = {}) {
  const plain = zlib.gzipSync(Buffer.from(SQL_TEXT)) // 加密前明文 = gz 字节（与原备份链路同口径）
  const { cipherBuf, meta } = await encryptFile(plain)
  meta.sha256 = sha256hex(plain)
  meta.tableCounts = { 'school_t1.t1': 0, 'school_t1.t2': 0 }
  meta.schemaSnapshot = {
    school_t1: { t1: [{ column: 'id', type: 'integer' }], t2: [{ column: 'id', type: 'integer' }] },
  }
  meta.snapshotMode = 'snapshot'
  meta.scope = 'single'
  meta.schoolCode = 't1'
  meta.runId = 'srcrun-unit-1'
  meta.countsCrossCheck = { mode: 'snapshot', result: 'passed', tables: 2 }
  Object.assign(meta, overrides)
  if (typeof overrides.fileSize !== 'number') meta.fileSize = cipherBuf.length

  const dir = path.join(rootDir, '2026-09-26')
  fs.mkdirSync(dir, { recursive: true })
  const aesPath = path.join(dir, `${name}.sql.gz.aes`)
  const metaPath = path.join(dir, `${name}.meta.json`)
  fs.writeFileSync(aesPath, cipherBuf, { mode: 0o600 })
  // overrides 中值为 undefined 的键（如 runId: undefined）须从 JSON 中消失（模拟旧格式）
  fs.writeFileSync(metaPath, JSON.stringify(meta, (k, v) => (v === undefined ? undefined : v), 2), { mode: 0o600 })
  return { aesPath, metaPath, meta, cipherBuf }
}

function mockPrisma({ existingPath = null, existingChecksum = null, schools = { t1: { code: 't1', status: 'active' } }, failAudit = false } = {}) {
  const pending = []
  const committed = []
  const tx = {
    backupRun: {
      create: async ({ data }) => { const r = { id: 'run_ext_test', ...data }; pending.push({ kind: 'run', data: r }); return r },
    },
    systemLog: {
      create: async ({ data }) => {
        if (failAudit) throw new Error('injected audit failure (test)')
        const r = { id: 'log_ext_test', ...data }
        pending.push({ kind: 'log', data: r })
        return r
      },
    },
  }
  return {
    pending,
    committed,
    backupRun: {
      findUnique: async () => existingPath,
      findFirst: async () => existingChecksum,
    },
    school: { findUnique: async ({ where }) => schools[where.code] ?? null },
    $transaction: async (fn) => {
      const res = await fn(tx)          // 回调抛错 → 不提交（模拟事务回滚）
      committed.push(...pending.splice(0))
      return res
    },
    systemLog: tx.systemLog,
  }
}

const committedRuns = (p) => p.committed.filter((x) => x.kind === 'run').map((x) => x.data)
const committedLogs = (p) => p.committed.filter((x) => x.kind === 'log').map((x) => x.data)

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'w3r2cross-reg-')) }
const SRC = 'srcrun-unit-1'

test('正例：合法产物 + 显式来源注册 → BackupRun(external_import) + 独立审计（同事务）+ 学校校核', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root)
  const prisma = mockPrisma()
  const r = await registerExternalBackup({ prisma, aesPath, rootDir: root, expectSourceRunId: SRC, expectSchoolCode: 't1' })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, false)
  assert.equal(r.runId, 'run_ext_test')
  assert.equal(r.scope, 'single')
  assert.equal(r.schoolCode, 't1')
  assert.equal(r.schemaName, 'school_t1')
  assert.equal(r.sourceRunId, SRC)
  assert.equal(r.schoolStatus, 'active')
  const runs = committedRuns(prisma)
  assert.equal(runs.length, 1)
  const rec = runs[0]
  assert.equal(rec.run_type, 'external_import')
  assert.equal(rec.created_by, `external:${SRC}`)
  assert.equal(rec.file_path, fs.realpathSync(aesPath))
  assert.equal(rec.checksum, r.sha256)
  assert.equal(rec.file_size, r.sizeBytes)
  assert.equal(rec.status, 'ok')
  assert.equal(rec.verify_status, 'passed')
  const logs = committedLogs(prisma)
  assert.equal(logs.length, 1)
  assert.match(logs[0].message, /\[admin-audit\] backup_external_registered/)
  assert.equal(logs[0].context.origin, 'external')
  assert.equal(logs[0].context.sourceRunId, SRC)
  assert.equal(logs[0].context.schoolStatus, 'active')
  assert.equal(logs[0].context.action_type, 'backup_external_registered')
})

test('dry-run：全校验通过但不落库/不审计', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root)
  const prisma = mockPrisma()
  const r = await registerExternalBackup({ prisma, aesPath, rootDir: root, expectSourceRunId: SRC, dryRun: true })
  assert.equal(r.ok, true)
  assert.equal(r.dryRun, true)
  assert.equal(r.runId, null)
  assert.equal(prisma.committed.length, 0)
})

test('来源 fail-closed：未提供显式来源 → REG_SOURCE_REQUIRED（且零落库）', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root)
  const prisma = mockPrisma()
  await assert.rejects(
    () => registerExternalBackup({ prisma, aesPath, rootDir: root }),
    (e) => e instanceof ExternalRegistrationError && e.code === 'REG_SOURCE_REQUIRED',
  )
  await assert.rejects(
    () => registerExternalBackup({ prisma, aesPath, rootDir: root, expectSourceRunId: '   ' }),
    (e) => e.code === 'REG_SOURCE_REQUIRED',
  )
  assert.equal(prisma.committed.length, 0)
})

test('来源 fail-closed：meta.runId 缺失（旧格式）→ REG_META_SOURCE_MISSING', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root, { overrides: { runId: undefined } })
  const prisma = mockPrisma()
  await assert.rejects(
    () => registerExternalBackup({ prisma, aesPath, rootDir: root, expectSourceRunId: SRC }),
    (e) => e.code === 'REG_META_SOURCE_MISSING',
  )
  assert.equal(prisma.committed.length, 0)
})

test('学校身份校核：不存在该校 / 状态异常 → REG_SCHOOL_UNKNOWN', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root, { overrides: { schoolCode: 'ghost' } })
  await assert.rejects(
    () => registerExternalBackup({ prisma: mockPrisma(), aesPath, rootDir: root, expectSourceRunId: SRC }),
    (e) => e.code === 'REG_SCHOOL_UNKNOWN',
  )
  const root2 = tmpRoot()
  const a2 = await makeArtifact(root2, { name: 'badstatus' })
  await assert.rejects(
    () => registerExternalBackup({ prisma: mockPrisma({ schools: { t1: { code: 't1', status: null } } }), aesPath: a2.aesPath, rootDir: root2, expectSourceRunId: SRC }),
    (e) => e.code === 'REG_SCHOOL_UNKNOWN',
  )
})

test('拒绝：审计失败 → 整体回滚（committed 为空，无半套）', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root)
  const prisma = mockPrisma({ failAudit: true })
  await assert.rejects(
    () => registerExternalBackup({ prisma, aesPath, rootDir: root, expectSourceRunId: SRC }),
    (e) => /injected audit failure/.test(String(e.message)),
  )
  assert.equal(prisma.committed.length, 0, '事务回滚后不得有任何已提交行（BackupRun/审计同生共死）')
})

test('拒绝：sha256 篡改（meta.sha256 与明文不符）→ REG_VERIFY_FAILED', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root, { overrides: { sha256: 'a'.repeat(64) } })
  const prisma = mockPrisma()
  await assert.rejects(
    () => registerExternalBackup({ prisma, aesPath, rootDir: root, expectSourceRunId: SRC }),
    (e) => e instanceof ExternalRegistrationError && e.code === 'REG_VERIFY_FAILED',
  )
  assert.equal(prisma.committed.length, 0)
})

test('拒绝：大小不符（meta.fileSize ≠ 文件字节）→ REG_META_MISMATCH', async () => {
  const root = tmpRoot()
  const { aesPath, meta } = await makeArtifact(root)
  fs.writeFileSync(aesPath.replace(/\.sql\.gz\.aes$/, '.meta.json'), JSON.stringify({ ...meta, fileSize: meta.fileSize + 1 }))
  const prisma = mockPrisma()
  await assert.rejects(
    () => registerExternalBackup({ prisma, aesPath, rootDir: root, expectSourceRunId: SRC }),
    (e) => e.code === 'REG_META_MISMATCH',
  )
})

test('拒绝：表计数不一致（tableCounts 多一项）→ REG_VERIFY_FAILED', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root, {
    overrides: { tableCounts: { 'school_t1.t1': 0, 'school_t1.t2': 0, 'school_t1.t3': 0 } },
  })
  const prisma = mockPrisma()
  await assert.rejects(
    () => registerExternalBackup({ prisma, aesPath, rootDir: root, expectSourceRunId: SRC }),
    (e) => e.code === 'REG_VERIFY_FAILED',
  )
})

test('拒绝：scope 非法 / single 缺 schoolCode / 缺 fileSize → REG_META_INVALID', async () => {
  const root1 = tmpRoot()
  const a1 = await makeArtifact(root1, { overrides: { scope: 'ALL' } })
  await assert.rejects(() => registerExternalBackup({ prisma: mockPrisma(), aesPath: a1.aesPath, rootDir: root1, expectSourceRunId: SRC }), (e) => e.code === 'REG_META_INVALID')

  const root2 = tmpRoot()
  const a2 = await makeArtifact(root2, { overrides: { schoolCode: null } })
  await assert.rejects(() => registerExternalBackup({ prisma: mockPrisma(), aesPath: a2.aesPath, rootDir: root2, expectSourceRunId: SRC }), (e) => e.code === 'REG_META_INVALID')

  const root3 = tmpRoot()
  const a3 = await makeArtifact(root3)
  fs.writeFileSync(a3.aesPath.replace(/\.sql\.gz\.aes$/, '.meta.json'), JSON.stringify({ ...a3.meta, fileSize: undefined }))
  await assert.rejects(() => registerExternalBackup({ prisma: mockPrisma(), aesPath: a3.aesPath, rootDir: root3, expectSourceRunId: SRC }), (e) => e.code === 'REG_META_INVALID')
})

test('拒绝：school 期望不符 / 来源不符 → REG_META_MISMATCH', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root)
  await assert.rejects(
    () => registerExternalBackup({ prisma: mockPrisma(), aesPath, rootDir: root, expectSourceRunId: SRC, expectSchoolCode: 'other' }),
    (e) => e.code === 'REG_META_MISMATCH',
  )
  await assert.rejects(
    () => registerExternalBackup({ prisma: mockPrisma(), aesPath, rootDir: root, expectSourceRunId: 'nope' }),
    (e) => e.code === 'REG_META_MISMATCH',
  )
})

test('拒绝：路径越界（root 外产物）→ REG_PATH_OUTSIDE_ROOT', async () => {
  const root = tmpRoot()
  const outside = tmpRoot()
  const { aesPath } = await makeArtifact(outside)
  await assert.rejects(
    () => registerExternalBackup({ prisma: mockPrisma(), aesPath, rootDir: root, expectSourceRunId: SRC }),
    (e) => e.code === 'REG_PATH_OUTSIDE_ROOT',
  )
})

test('拒绝：符号链接（root 内指向真实产物的链接）→ REG_PATH_SYMLINK', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root)
  const linkPath = path.join(path.dirname(aesPath), 'link.sql.gz.aes')
  fs.symlinkSync(aesPath, linkPath)
  await assert.rejects(
    () => registerExternalBackup({ prisma: mockPrisma(), aesPath: linkPath, rootDir: root, expectSourceRunId: SRC }),
    (e) => e.code === 'REG_PATH_SYMLINK',
  )
})

test('拒绝：重复注册（同 file_path / 同 checksum+scope+school）', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root)
  await assert.rejects(
    () => registerExternalBackup({ prisma: mockPrisma({ existingPath: { id: 'run_dup' } }), aesPath, rootDir: root, expectSourceRunId: SRC }),
    (e) => e.code === 'REG_DUPLICATE_PATH',
  )
  await assert.rejects(
    () => registerExternalBackup({ prisma: mockPrisma({ existingChecksum: { id: 'run_dup2' } }), aesPath, rootDir: root, expectSourceRunId: SRC }),
    (e) => e.code === 'REG_DUPLICATE_CHECKSUM',
  )
})

test('拒绝：api 缺位（无 prisma）→ REG_PRISMA_REQUIRED；root 不存在 → REG_ROOT_MISSING', async () => {
  const root = tmpRoot()
  const { aesPath } = await makeArtifact(root)
  await assert.rejects(() => registerExternalBackup({ aesPath, rootDir: root, expectSourceRunId: SRC }), (e) => e.code === 'REG_PRISMA_REQUIRED')
  await assert.rejects(
    () => registerExternalBackup({ prisma: mockPrisma(), aesPath, rootDir: path.join(root, 'no-such-root'), expectSourceRunId: SRC }),
    (e) => e.code === 'REG_ROOT_MISSING',
  )
})
