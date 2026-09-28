// P3-W3-T01 专用**实例准备**辅助（backend/tests/backup/ 本包新建；不是测试，不被 node --test 收集）。
//
// 目的（在 provisioner 独占实例之上，为本包定点测试准备可复现现场）：
//   ① 复用既有 T02C fixture（`t02c-instance-fixture.mjs`，只读设施不修改）：
//      public 业务表（prisma db push）+ 租户 schema 同步 + 最小 seed + 测试角色授权；
//   ② 补建 slot b 学校行并再同步一次（本包需要“两所不同学校并发备份”的现场）；
//   ③ 撞名注入现场：预建【历史固定名】`<schemaA>_restore` 与【他任务暂存名】`<schemaA>_stg_deadbeef`，
//      各含哨兵行 —— 用于证明新引擎绝不 DROP 未登记对象（AUD-004）；
//   ④ 真实数据哨兵行：租户 a/b 各 1 行 User，用于证明失败清理/切换审核不触碰真实数据；
//   ⑤ 写出本包运行环境文件（0600）：管理连接串 / BACKUP_DIR / 台账目录 / 加密主密钥（测试专用随机值）。
//
// 用法（需先 source provisioner 的 test-env.sh，提供 TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE）：
//   node backend/tests/backup/w3-instance-fixture.mjs <runId> <instanceJsonPath> [t02cEvidenceJsonPath]
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(here, '../..')
const repoRoot = path.resolve(backendDir, '..')

const runId = process.argv[2]
const instanceJsonPath = process.argv[3]
const t02cEvidencePath = process.argv[4] || null
if (!runId || !instanceJsonPath) {
  console.error(JSON.stringify({ ok: false, code: 'E_ARG', message: 'usage: node w3-instance-fixture.mjs <runId> <instanceJsonPath> [t02cEvidenceJsonPath]' }))
  process.exit(1)
}

const gate = require(path.join(repoRoot, 'tests/helpers/db-isolation.cjs'))
const provision = require(path.join(repoRoot, 'tests/isolation/provision.cjs'))

const steps = []
const fail = (code, message, detail) => {
  const out = { ok: false, code, message, detail: detail || null, steps }
  console.error(JSON.stringify(out))
  process.exit(1)
}

async function main() {
  if (!process.env.TEST_DATABASE_URL || !process.env.TEST_DB_CONTEXT_FILE) {
    fail('E_ENV', 'TEST_DATABASE_URL / TEST_DB_CONTEXT_FILE 必须由 provisioner 的 test-env.sh 提供（先 source 再运行本工具）')
  }
  const derived = gate.derivedNamespace(runId)
  const { root, rec } = provision.readOwnership(runId)
  const { user: adminUser, password: adminPassword } = provision.readAdminCredentials(runId)
  const adminUrl = `postgresql://${encodeURIComponent(adminUser)}:${encodeURIComponent(adminPassword)}@127.0.0.1:${rec.port}/${derived.database}`
  const schoolA = derived.tenants.a
  const schoolB = derived.tenants.b
  const schemaA = derived.schemas.a
  const schemaB = derived.schemas.b

  // ── ① 复用 T02C fixture（public 表 + 租户同步 + seed + 测试角色授权）──
  const t02c = spawnSync(process.execPath, [path.join(backendDir, 'tests/t02c-instance-fixture.mjs'), runId, t02cEvidencePath || ''].filter(Boolean), {
    cwd: repoRoot, encoding: 'utf8', timeout: 600000,
    env: { ...process.env },
  })
  steps.push({ step: 't02c_fixture', rc: t02c.status, tail: `${(t02c.stdout || '').slice(-200)}${(t02c.stderr || '').slice(-400)}` })
  if (t02c.status !== 0) fail('E_T02C_FIXTURE', 'T02C 实例 fixture 失败（共享只读设施，不修改）', { rc: t02c.status, tail: `${(t02c.stdout || '').slice(-500)}${(t02c.stderr || '').slice(-800)}` })

  // ── ② 补建 slot b + 再同步（本包需要两所学校的并发现场）──
  process.env.DATABASE_URL = adminUrl
  const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'))
  const { syncAllTenantSchemas } = await import(path.join(backendDir, 'lib/tenantSync.js'))
  const prisma = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  await prisma.school.upsert({
    where: { code: schoolB },
    update: { status: 'active' },
    create: { code: schoolB, name: `W3 isolated school B ${runId}`, status: 'active' },
  })
  await prisma.school.upsert({
    where: { code: schoolA },
    update: { status: 'active' },
    create: { code: schoolA, name: `W3 isolated school A ${runId}`, status: 'active' },
  })
  const syncLogs = []
  await syncAllTenantSchemas(prisma, { skipGenerate: true, log: (m) => syncLogs.push(String(m).slice(0, 160)) })
  steps.push({ step: 'sync_tenants', schools: [schoolA, schoolB], logs: syncLogs.slice(-6) })

  // ── ③ 撞名注入现场（未登记对象：新引擎绝不能 DROP）──
  const legacyStaging = `${schemaA}_restore` // 历史固定名（AUD-004 的撞名主体）
  const foreignStaging = `${schemaA}_stg_deadbeef` // 他任务暂存形态名
  for (const [schema, table, marker] of [
    [legacyStaging, 'legacy_canary', `legacy-${runId}`],
    [foreignStaging, 'foreign_canary', `foreign-${runId}`],
  ]) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."${table}" (id text PRIMARY KEY, note text NOT NULL)`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."${table}" (id, note) VALUES ($1, 'must-survive')`, marker)
  }
  steps.push({ step: 'collision_canaries', legacyStaging, foreignStaging })

  // ── ④ 真实数据哨兵行（租户 a/b 各 1 行；备份/恢复全程必须可按 id 复核）──
  const realRowId = `w3-real-${runId}`
  for (const schema of [schemaA, schemaB]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."User" (id, username, password_hash, full_name, role, status, created_at, updated_at)
       VALUES ($1, $2, 'x', 'w3 sentinel', 'operator', 'active', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      `${realRowId}-${schema.slice(-1)}`,
      `${realRowId}-${schema.slice(-1)}`,
    )
  }
  steps.push({ step: 'real_sentinels', ids: [`${realRowId}-a`, `${realRowId}-b`] })

  // ── ⑤ 运行环境文件（0600）：管理连接串 / 备份目录 / 台账目录 / 测试加密主密钥 ──
  const backupDir = path.join(root, 'backups')
  const ledgerDir = path.join(backupDir, '.jobs')
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
  const masterKey = crypto.randomBytes(32).toString('base64')
  const envFile = path.join(root, 'w3-env.sh')
  fs.writeFileSync(envFile, [
    `export W3_ADMIN_DATABASE_URL='${adminUrl}'`,
    `export W3_INSTANCE_JSON='${instanceJsonPath}'`,
    `export W3_INSTANCE_ROOT='${root}'`,
    `export BACKUP_DIR='${backupDir}'`,
    `export BACKUP_JOB_LEDGER_DIR='${ledgerDir}'`,
    `export BACKUP_MASTER_KEY='${masterKey}'`,
    '',
  ].join('\n'), { mode: 0o600 })

  const summary = {
    ok: true,
    task: 'P3-W3-T01',
    runId,
    port: rec.port,
    database: derived.database,
    adminRole: derived.adminRole,
    testRole: derived.role,
    schools: { a: schoolA, b: schoolB },
    schemas: { a: schemaA, b: schemaB },
    collisionCanaries: { legacyStaging, foreignStaging },
    realSentinelRowIdBase: realRowId,
    backupDir,
    ledgerDir,
    envFile,
    steps,
    generatedAtUtc: new Date().toISOString(),
  }
  await prisma.$disconnect()
  fs.mkdirSync(path.dirname(instanceJsonPath), { recursive: true })
  fs.writeFileSync(instanceJsonPath, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((e) => fail('E_UNKNOWN', String((e && e.message) || e), { code: (e && e.code) || 'UNKNOWN' }))
