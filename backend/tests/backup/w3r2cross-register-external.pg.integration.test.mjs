// P3-W3-CROSS-REG-R2 · 外部备份注册 —— **真实 PG** 定点（隔离实例；不跳过、不回落业务库）。
//
// 覆盖（R10 :12 要求"真实 PG 审计事务回滚反例"）：
//   ① 正例（真实 PG）：注册成功 → BackupRun + 独立审计行**都在**（同事务提交）；
//   ② **审计失败 → 整体回滚**：在 public."SystemLog" 注入 BEFORE INSERT trigger（仅拦
//      `backup_external_registered`）→ 注册必须拒绝，且 **BackupRun 无残留、审计无残留**
//      （证明"记录与审计同生共死"，非"先写记录后补审计"）；
//   ③ 来源 fail-closed（真实 PG）：未提供显式来源 → REG_SOURCE_REQUIRED；meta.runId 缺失
//      （旧格式）→ REG_META_SOURCE_MISSING；两者均**零落库**；
//   ④ 学校身份校核（真实 PG）：目标实例不存在的学校 → REG_SCHOOL_UNKNOWN，零落库。
//
// 运行（先 source provisioner test-env.sh；W3REG_ADMIN_DATABASE_URL=实例管理连接）：
//   BACKUP_DIR=<实例目录>/w3reg-backups BACKUP_MASTER_KEY=<base64-32B> \
//   W3REG_ADMIN_DATABASE_URL=postgresql://<admin>:<pw>@127.0.0.1:<port>/<db> \
//   node --test --test-concurrency=1 backend/tests/backup/w3r2cross-register-external.pg.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { encryptFile } from '../../lib/backupKms.js'
import { registerExternalBackup } from '../../lib/externalBackupRegistration.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const require = createRequire(import.meta.url)
const gate = require(path.join(repoRoot, 'tests/helpers/db-isolation.cjs'))

// ── 环境加载（fail-closed：缺失即注册阶段失败，不 skip、不回落）──
function loadEnv(env = process.env) {
  const required = ['TEST_DATABASE_URL', 'TEST_DB_CONTEXT_FILE', 'W3REG_ADMIN_DATABASE_URL', 'BACKUP_DIR', 'BACKUP_MASTER_KEY']
  const missing = required.filter((k) => !env[k] || String(env[k]).trim() === '')
  if (missing.length) return { ok: false, code: 'PGREG_ENV_MISSING', missing }
  const g = gate.checkIsolationConfig({ TEST_DATABASE_URL: env.TEST_DATABASE_URL, TEST_DB_CONTEXT_FILE: env.TEST_DB_CONTEXT_FILE })
  if (!g.ok) return { ok: false, code: g.code, reason: g.reason }
  const cfg = g.cfg
  const derived = gate.derivedNamespace(cfg.runId)
  let url
  try { url = new URL(env.W3REG_ADMIN_DATABASE_URL) } catch { return { ok: false, code: 'PGREG_ADMIN_URL_INVALID' } }
  if (!['127.0.0.1', '::1'].includes(url.hostname)) return { ok: false, code: 'PGREG_ADMIN_URL_NOT_LOOPBACK' }
  if (String(url.port) !== String(cfg.port)) return { ok: false, code: 'PGREG_ADMIN_URL_PORT_MISMATCH' }
  if (decodeURIComponent(url.pathname.replace(/^\//, '')) !== cfg.database) return { ok: false, code: 'PGREG_ADMIN_URL_DB_MISMATCH' }
  if (decodeURIComponent(url.username) !== derived.adminRole) return { ok: false, code: 'PGREG_ADMIN_URL_ROLE_MISMATCH' }
  if (!path.isAbsolute(env.BACKUP_DIR)) return { ok: false, code: 'PGREG_BACKUP_DIR_NOT_ABSOLUTE' }
  return { ok: true, cfg, derived, adminUrl: env.W3REG_ADMIN_DATABASE_URL, backupDir: env.BACKUP_DIR }
}

const envInfo = loadEnv()
const enabled = envInfo.ok

if (!enabled) {
  test('W3REG 注册 PG 定点：[PGREG] 缺少隔离实例环境 → 拒绝（fail-closed，不 skip）', () => {
    assert.fail(`[PGREG-HARNESS-REFUSED] code=${envInfo.code} missing=${(envInfo.missing || []).join(',')} reason=${envInfo.reason || 'n/a'}`)
  })
}

if (enabled) {
  const { PrismaClient } = require(path.join(repoRoot, 'backend/node_modules/@prisma/client'))
  const prisma = new PrismaClient({ datasources: { db: { url: envInfo.adminUrl } } })
  const tail = String(envInfo.cfg.runId).slice(-8)
  const SCODE = `w3reg-${tail}`
  const SRC_RUN = 'srcrun-pg-1'
  const BACKUP_DIR = envInfo.backupDir
  fs.mkdirSync(BACKUP_DIR, { recursive: true })

  const q = (sql, ...args) => prisma.$executeRawUnsafe(sql, ...args)
  const raw = (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args)

  const SQL_TEXT = 'CREATE TABLE "t1" (id integer);\nCREATE TABLE "t2" (id integer);\nCOPY "t1" (id) FROM stdin;\n1\n\\.\n'
  async function makeArtifact(name, overrides = {}, sqlText = SQL_TEXT) {
    const plain = zlib.gzipSync(Buffer.from(sqlText))
    const { cipherBuf, meta } = await encryptFile(plain)
    meta.sha256 = crypto.createHash('sha256').update(plain).digest('hex')
    meta.tableCounts = { [`school_${SCODE.replace(/-/g, '_')}.t1`]: 0, [`school_${SCODE.replace(/-/g, '_')}.t2`]: 0 }
    meta.schemaSnapshot = { [`school_${SCODE.replace(/-/g, '_')}`]: { t1: [{ column: 'id', type: 'integer' }], t2: [{ column: 'id', type: 'integer' }] } }
    meta.snapshotMode = 'snapshot'
    meta.scope = 'single'
    meta.schoolCode = SCODE
    meta.runId = SRC_RUN
    meta.countsCrossCheck = { mode: 'snapshot', result: 'passed', tables: 2 }
    Object.assign(meta, overrides)
    if (typeof overrides.fileSize !== 'number') meta.fileSize = cipherBuf.length
    const dir = path.join(BACKUP_DIR, '2026-09-27')
    fs.mkdirSync(dir, { recursive: true })
    const aesPath = path.join(dir, `${name}.sql.gz.aes`)
    const metaPath = path.join(dir, `${name}.meta.json`)
    fs.writeFileSync(aesPath, cipherBuf, { mode: 0o600 })
    fs.writeFileSync(metaPath, JSON.stringify(meta, (k, v) => (v === undefined ? undefined : v), 2), { mode: 0o600 })
    return { aesPath, metaPath, real: fs.realpathSync(aesPath) }
  }

  const logRows = (since) => prisma.systemLog.count({
    where: { message: { startsWith: '[admin-audit] backup_external_registered' }, created_at: { gte: since } },
  })

  test('前置：实例身份与 public 表就绪（前置于任何注册动作）', async () => {
    const id = (await raw('SELECT current_database() AS db, current_user AS cu, inet_server_port() AS port'))[0]
    assert.equal(id.db, envInfo.cfg.database)
    assert.equal(id.cu, envInfo.derived.adminRole)
    assert.equal(Number(id.port), Number(envInfo.cfg.port))
    for (const t of ['BackupRun', 'SystemLog', 'School']) {
      const ok = (await raw(`SELECT to_regclass('public."${t}"') IS NOT NULL AS ok`))[0].ok
      assert.equal(ok, true, `public."${t}" 必须存在（实例需先 migrate deploy）`)
    }
    await prisma.school.upsert({ where: { code: SCODE }, update: {}, create: { code: SCODE, name: `W3REG PG 定点学校 ${tail}` } })

    // 幂等清理（仅限本测试学校的 external_import 记录与其对应审计）→ 支持重复运行
    const olds = await prisma.backupRun.findMany({ where: { school_code: SCODE, run_type: 'external_import' }, select: { id: true } })
    const oldIds = olds.map((o) => o.id)
    if (oldIds.length) {
      const logs = await prisma.systemLog.findMany({
        where: { message: { startsWith: '[admin-audit] backup_external_registered' } },
        select: { id: true, context: true },
      })
      const delIds = logs.filter((l) => l.context && oldIds.includes(l.context.target_id)).map((l) => l.id)
      if (delIds.length) await prisma.systemLog.deleteMany({ where: { id: { in: delIds } } })
      await prisma.backupRun.deleteMany({ where: { id: { in: oldIds } } })
    }
  })

  test('① 正例（真实 PG）：注册成功 → BackupRun 与独立审计行都在（同事务提交）', async () => {
    const a = await makeArtifact('pg-ok')
    const t0 = new Date(Date.now() - 1000)
    const r = await registerExternalBackup({ prisma, aesPath: a.aesPath, rootDir: BACKUP_DIR, expectSourceRunId: SRC_RUN })
    assert.equal(r.ok, true)
    const rec = await prisma.backupRun.findUnique({ where: { file_path: a.real } })
    assert.ok(rec, 'BackupRun 行必须存在')
    assert.equal(rec.run_type, 'external_import')
    assert.equal(rec.created_by, `external:${SRC_RUN}`)
    assert.equal(rec.scope, 'single')
    assert.equal(rec.school_code, SCODE)
    assert.equal(Number(rec.file_size), r.sizeBytes)
    assert.equal(rec.checksum, r.sha256)
    const log = await prisma.systemLog.findFirst({
      where: { message: { startsWith: '[admin-audit] backup_external_registered' }, created_at: { gte: t0 } },
      orderBy: { created_at: 'desc' },
    })
    assert.ok(log, '独立审计行必须存在')
    assert.equal(log.context.target_id, rec.id)
    assert.equal(log.context.origin, 'external')
    assert.equal(log.context.source_run_id ?? log.context.sourceRunId, SRC_RUN)
    assert.equal(log.context.school_status ?? log.context.schoolStatus, 'active')
  })

  test('② 审计失败 → 整体回滚：BackupRun 无残留、审计无残留（trigger 注入）', async () => {
    const a = await makeArtifact('pg-rollback', {}, `${SQL_TEXT}-- rollback-case（差异化 checksum，避免与正例重复注册冲突）\n`)
    await q(`CREATE OR REPLACE FUNCTION w3reg_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.message LIKE '%backup_external_registered%' THEN RAISE EXCEPTION 'w3reg-injected-audit-failure'; END IF; RETURN NEW; END $$`)
    await q(`CREATE TRIGGER w3reg_block_audit_trg BEFORE INSERT ON public."SystemLog" FOR EACH ROW EXECUTE FUNCTION w3reg_block_audit()`)
    const t1 = new Date()
    try {
      await assert.rejects(
        () => registerExternalBackup({ prisma, aesPath: a.aesPath, rootDir: BACKUP_DIR, expectSourceRunId: SRC_RUN }),
        (e) => /w3reg-injected-audit-failure|injected|SystemLog/i.test(String(e.message)) || e.name === 'PrismaClientKnownRequestError',
      )
      const rec = await prisma.backupRun.findUnique({ where: { file_path: a.real } })
      assert.equal(rec, null, '审计失败必须导致 BackupRun 不落库（整体回滚，无半套）')
      assert.equal(await logRows(t1), 0, '审计行不得残留')
    } finally {
      await q('DROP TRIGGER IF EXISTS w3reg_block_audit_trg ON public."SystemLog"').catch(() => {})
      await q('DROP FUNCTION IF EXISTS w3reg_block_audit()').catch(() => {})
    }
    // 触发器移除后，同一产物可走正常路径（证明失败仅由注入引起）
    const r2 = await registerExternalBackup({ prisma, aesPath: a.aesPath, rootDir: BACKUP_DIR, expectSourceRunId: SRC_RUN })
    assert.equal(r2.ok, true)
  })

  test('③ 来源 fail-closed（真实 PG）：缺显式来源 / 旧格式（无 runId）→ 拒绝且零落库', async () => {
    const a1 = await makeArtifact('pg-nosrc')
    await assert.rejects(
      () => registerExternalBackup({ prisma, aesPath: a1.aesPath, rootDir: BACKUP_DIR }),
      (e) => e.code === 'REG_SOURCE_REQUIRED',
    )
    assert.equal(await prisma.backupRun.findUnique({ where: { file_path: a1.real } }), null)

    const a2 = await makeArtifact('pg-legacy', { runId: undefined })
    await assert.rejects(
      () => registerExternalBackup({ prisma, aesPath: a2.aesPath, rootDir: BACKUP_DIR, expectSourceRunId: SRC_RUN }),
      (e) => e.code === 'REG_META_SOURCE_MISSING',
    )
    assert.equal(await prisma.backupRun.findUnique({ where: { file_path: a2.real } }), null)
  })

  test('④ 学校身份校核（真实 PG）：不存在该校 → REG_SCHOOL_UNKNOWN 且零落库', async () => {
    const a = await makeArtifact('pg-ghost', { schoolCode: `w3reg-ghost-${tail}` })
    await assert.rejects(
      () => registerExternalBackup({ prisma, aesPath: a.aesPath, rootDir: BACKUP_DIR, expectSourceRunId: SRC_RUN }),
      (e) => e.code === 'REG_SCHOOL_UNKNOWN',
    )
    assert.equal(await prisma.backupRun.findUnique({ where: { file_path: a.real } }), null)
  })

  test.after(async () => { await prisma.$disconnect().catch(() => {}) })
}
