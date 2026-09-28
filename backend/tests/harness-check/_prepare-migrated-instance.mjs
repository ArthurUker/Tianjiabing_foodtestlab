// P3-HARNESS-CHECK-R1 —— 真实 server harness 前置：把自有隔离实例推进到「已迁移 + 默认 check 可放行」。
//
// 目标（不绕过）：public 走 `prisma migrate deploy`；租户走版本化链回放（`sync-tenant-schemas.mjs` 显式 apply）；
//   随后 `--check` 必须 rc=0；server 以**默认 check** 启动（不设 AUTO_SYNC_TENANTS）。
// **不使用**：`db push`、`--accept-data-loss`、`AUTO_SYNC_TENANTS=false`、`TENANT_READINESS_ATTESTED`。
//
// 关键事实（只读依据；P3-FIXTURE-MIGRATED-R1 更新）：
//   · P3005 的**根因**是"public 预置对象早于 migrate deploy"（provisioner 预置 `public.revoked_tokens`）。
//     **修复方式 = 顺序**：`tests/isolation/provision.cjs` 的 `up()` 现在含 `public_migrate_deploy` 阶段
//     （`created_database` 之后、任何 public 预置对象之前执行版本化链）→ 本模块不再需要、也不再使用
//     `ALTER TABLE … SET SCHEMA` 临时寄存/迁回认证表；不使用 `migrate resolve`、不使用 attestation、
//     不使用 `AUTO_SYNC_TENANTS=false`。
//   · 若实例是**旧顺序**产物（public 已有 `revoked_tokens` 但既无 `_prisma_migrations` 也无 datamodel 表），
//     本模块 fail-closed（`E_PUBLIC_AUTH_INFRA_BEFORE_MIGRATION`）：请用新 provision 重建实例，不要就地放行。
//   · 若 public 已存在 datamodel 表但**没有** `_prisma_migrations`（= 其它 fixture 用 `db push` 建过 public），
//     本模块 **fail-closed**（`E_PUBLIC_NOT_MIGRATED_NONEMPTY`）：不允许用 resolve/末态对齐冒充版本化迁移；
//     这是 fixture 归属包需要适配的接口阻塞点（见本包 `BLOCKERS.md`）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const backendDir = path.resolve(here, '..', '..')
export const repoRoot = path.resolve(backendDir, '..')
const require = createRequire(import.meta.url)

const LEDGER = '_prisma_migrations'
const REVOCATION_TABLE = 'revoked_tokens'

/** 迁移链文件（name + sha256(文件内容)，与 Prisma checksum 同口径）。 */
export function chainFiles() {
  const dir = path.join(backendDir, 'prisma', 'migrations')
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const file = path.join(dir, e.name, 'migration.sql')
      const buf = fs.readFileSync(file)
      return { name: e.name, file, checksum: crypto.createHash('sha256').update(buf).digest('hex') }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function prismaClient(adminUrl) {
  const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'))
  return new PrismaClient({ datasources: { db: { url: adminUrl } } })
}

/** expected datamodel 表名（唯一事实源 = 引擎的 datamodel 读取；只读导入）。 */
async function expectedPublicTables() {
  const mod = await import(path.join(backendDir, 'lib/tenantProvisioner.js'))
  const r = mod.readExpectedTenantTables()
  if (!r || r.ok !== true) throw Object.assign(new Error('无法从 schema.prisma 读取 datamodel 表清单'), { code: 'E_EXPECTED_TABLES' })
  return [...r.tables]
}

/** 只读：public 迁移台账 vs 链文件。 */
export async function probePublicLedger(adminUrl) {
  const client = prismaClient(adminUrl)
  try {
    const chain = chainFiles()
    const reg = await client.$queryRawUnsafe(`SELECT to_regclass('public.${LEDGER}')::text AS t`)
    const hasLedger = reg[0]?.t !== null
    if (!hasLedger) return { hasLedger: false, complete: false, applied: [], pending: chain.map((c) => c.name), failed: [], rolledBack: [], checksumMismatch: [], unknown: [] }
    const rows = await client.$queryRawUnsafe(
      `SELECT migration_name, checksum, finished_at, rolled_back_at FROM public.${LEDGER} ORDER BY migration_name`)
    const byName = new Map(rows.map((r) => [r.migration_name, r]))
    const applied = [], pending = [], failed = [], rolledBack = [], checksumMismatch = []
    for (const c of chain) {
      const row = byName.get(c.name)
      if (!row) { pending.push(c.name); continue }
      if (row.finished_at == null && row.rolled_back_at != null) { rolledBack.push(c.name); continue }
      if (row.finished_at == null) { failed.push(c.name); continue }
      if (String(row.checksum) !== c.checksum) { checksumMismatch.push(c.name); continue }
      applied.push(c.name)
    }
    const chainNames = new Set(chain.map((c) => c.name))
    const unknown = rows.map((r) => r.migration_name).filter((n) => !chainNames.has(n))
    const complete = pending.length === 0 && failed.length === 0 && rolledBack.length === 0 && checksumMismatch.length === 0 && unknown.length === 0
    return { hasLedger: true, complete, applied, pending, failed, rolledBack, checksumMismatch, unknown, total: rows.length, chainTotal: chain.length }
  } finally {
    await client.$disconnect().catch(() => {})
  }
}

/** 只读：public 中已存在的 datamodel 表（= 非迁移链建立的业务结构）。 */
export async function countPublicDatamodelTables(adminUrl) {
  const expected = await expectedPublicTables()
  const client = prismaClient(adminUrl)
  try {
    const rows = await client.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`,
      expected)
    return { n: Number(rows[0]?.n || 0), expected: expected.length }
  } finally {
    await client.$disconnect().catch(() => {})
  }
}

/**
 * public：确保迁移链已应用（幂等）。
 * 返回 { mode: 'already_migrated' | 'deployed', steps[] }；失败抛 typed error（无 parked：寄存逻辑已删除）。
 */
export async function ensurePublicMigrated({ adminUrl, cfg, log = () => {} }) {
  const steps = []
  const before = await probePublicLedger(adminUrl)
  steps.push({ step: 'public_ledger_probe_before', hasLedger: before.hasLedger, complete: before.complete, applied: before.applied.length, chainTotal: before.chainTotal })
  if (before.complete) { log(`public 迁移链已应用（${before.applied.length}/${before.chainTotal}）→ 跳过 deploy`); return { mode: 'already_migrated', steps, ledger: before } }
  if (before.hasLedger) {
    const err = new Error(`public 台账存在但不完整（pending=${before.pending.length} failed=${before.failed.length} rolledBack=${before.rolledBack.length} checksumMismatch=${before.checksumMismatch.length} unknown=${before.unknown.length}）→ fail-closed（人工按 deploy/MIGRATION_FAILURE_RUNBOOK.md 处置，不由测试自动 resolve）`)
    err.code = 'E_PUBLIC_LEDGER_INCOMPLETE'
    err.detail = before
    throw err
  }
  const dm = await countPublicDatamodelTables(adminUrl)
  steps.push({ step: 'public_datamodel_tables_probe', datamodelTablesPresent: dm.n, expectedDatamodelTables: dm.expected })
  if (dm.n > 0) {
    const err = new Error(`public 已存在 ${dm.n} 张 datamodel 表但无 _prisma_migrations：疑似 fixture 使用 db push 建 public（本包禁止 db push / 末态对齐冒充版本化迁移）→ fail-closed`)
    err.code = 'E_PUBLIC_NOT_MIGRATED_NONEMPTY'
    err.detail = { datamodelTablesPresent: dm.n }
    throw err
  }

  // 旧顺序产物探测（只读）：public 已有认证表但无台账、无 datamodel 表 ⇒ 预置对象早于迁移 → fail-closed。
  const client = prismaClient(adminUrl)
  try {
    const reg = await client.$queryRawUnsafe(`SELECT to_regclass('public.${REVOCATION_TABLE}')::text AS t`)
    const preExistingInfra = reg[0]?.t !== null
    steps.push({ step: 'public_auth_infra_probe', revocationTokensPresent: preExistingInfra })
    if (preExistingInfra) {
      const err = new Error(
        `public.${REVOCATION_TABLE} 已存在，但该库既无 _prisma_migrations 也无 datamodel 表 → 属"预置对象早于迁移"的旧顺序产物。` +
        `本模块**不做** SET SCHEMA 寄存、不做 resolve 放行：请用新版 tests/isolation/provision.cjs（含 public_migrate_deploy 阶段）重建实例，` +
        `或换用新实例后重跑前置。`)
      err.code = 'E_PUBLIC_AUTH_INFRA_BEFORE_MIGRATION'
      err.detail = { revocationTokensPresent: true, hasLedger: false, datamodelTables: 0 }
      throw err
    }
    const deploy = spawnSync(path.join(backendDir, 'node_modules/.bin/prisma'),
      ['migrate', 'deploy', '--schema', path.join(backendDir, 'prisma/schema.prisma')], {
        cwd: backendDir, encoding: 'utf8', timeout: 300000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: adminUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      })
    steps.push({ step: 'prisma_migrate_deploy', rc: deploy.status, tail: `${(deploy.stdout || '').slice(-400)}${(deploy.stderr || '').slice(-400)}` })
    if (deploy.status !== 0) {
      const err = new Error(`prisma migrate deploy 失败（rc=${deploy.status}）：${(deploy.stderr || deploy.stdout || '').slice(-300)}`)
      err.code = 'E_MIGRATE_DEPLOY_FAILED'
      err.detail = { rc: deploy.status }
      throw err
    }
  } finally {
    await client.$disconnect().catch(() => {})
  }

  const after = await probePublicLedger(adminUrl)
  steps.push({ step: 'public_ledger_probe_after', complete: after.complete, applied: after.applied.length, chainTotal: after.chainTotal })
  if (!after.complete) {
    const err = new Error(`migrate deploy 后台账仍不完整（applied=${after.applied.length}/${after.chainTotal}）→ fail-closed`)
    err.code = 'E_PUBLIC_LEDGER_INCOMPLETE_AFTER_DEPLOY'
    err.detail = after
    throw err
  }
  return { mode: 'deployed', steps, ledger: after }
}

/**
 * 租户：显式 apply（版本化链回放）+ 只读 --check（rc=0 才放行）。
 *
 * P3-CLOSE-B-R5（R19 §剩余工程事项 1 / B-7b）：子进程 env 必须**安全透传调用者已有的
 * `SEED_ADMIN_PASSWORD`**（新建学校需要初始管理口令时由产品入口使用）。
 *   · **不打印值**、不派生隐式默认值、**不使用** `ALLOW_INSECURE_TENANT_PASSWORD`；
 *   · 调用者未提供口令时：先做只读 `--check`
 *     - 通过（无待建校）→ 不需要 apply，直接返回（`skippedApply:true`）；
 *     - 未通过（存在需补建的 schema）→ 抛 `E_SEED_ADMIN_PASSWORD_MISSING`（**非零拒绝**，不 skip）。
 */
export function ensureTenantChain({ adminUrl, log = () => {}, seedAdminPassword = process.env.SEED_ADMIN_PASSWORD } = {}) {
  const steps = []
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: adminUrl, SKIP_PRISMA_GENERATE: '1' }
  if (seedAdminPassword) env.SEED_ADMIN_PASSWORD = seedAdminPassword // 值只进子进程 env，绝不进 steps/日志
  const passwordProvided = !!seedAdminPassword
  const checkOnly = () => spawnSync(process.execPath, [path.join(backendDir, 'sync-tenant-schemas.mjs'), '--check'], { cwd: backendDir, encoding: 'utf8', timeout: 300000, env })
  if (!passwordProvided) {
    const pre = checkOnly()
    const preOut = `${pre.stdout || ''}${pre.stderr || ''}`
    steps.push({ step: 'tenant_chain_precheck_without_password', rc: pre.status, tail: preOut.slice(-300) })
    if (pre.status !== 0) {
      const err = new Error('缺少 SEED_ADMIN_PASSWORD，且存在待补建的租户 schema → 拒绝（fail-closed；不派生默认口令、不使用 ALLOW_INSECURE_TENANT_PASSWORD）')
      err.code = 'E_SEED_ADMIN_PASSWORD_MISSING'
      err.detail = { checkRc: pre.status, hint: '调用者需提供 SEED_ADMIN_PASSWORD（值不落日志）或在用例侧清理其新建的 School 行' }
      throw err
    }
    log('租户链已一致（无需 apply）：未提供 SEED_ADMIN_PASSWORD 亦可放行')
    return { steps, checkRc: 0, tail: preOut.slice(-800), skippedApply: true, seedAdminPasswordProvided: false }
  }
  const apply = spawnSync(process.execPath, [path.join(backendDir, 'sync-tenant-schemas.mjs')], { cwd: backendDir, encoding: 'utf8', timeout: 600000, env })
  steps.push({ step: 'tenant_chain_apply', rc: apply.status, seedAdminPasswordProvided: true, tail: `${(apply.stdout || '').slice(-500)}${(apply.stderr || '').slice(-500)}` })
  if (apply.status !== 0) {
    const err = new Error(`租户版本化链回放失败（rc=${apply.status}）：${(apply.stderr || apply.stdout || '').slice(-300)}`)
    err.code = 'E_TENANT_CHAIN_APPLY_FAILED'
    err.detail = { rc: apply.status }
    throw err
  }
  const check = checkOnly()
  const checkOut = `${check.stdout || ''}${check.stderr || ''}`
  steps.push({ step: 'tenant_chain_check', rc: check.status, tail: checkOut.slice(-500) })
  if (check.status !== 0) {
    const err = new Error(`db:sync --check 未通过（rc=${check.status}）→ 默认 check 启动不会放行：${checkOut.slice(-400)}`)
    err.code = 'E_TENANT_CHAIN_NOT_READY'
    err.detail = { rc: check.status }
    throw err
  }
  log('租户链已到链尾且 --check rc=0（默认 check 可放行）')
  return { steps, checkRc: check.status, tail: checkOut.slice(-800) }
}

/** 一次完成：public 迁移 → 租户链 → --check。 */
export async function prepareMigratedInstance({ adminUrl, cfg, log = () => {} }) {
  const pub = await ensurePublicMigrated({ adminUrl, cfg, log })
  const ten = ensureTenantChain({ adminUrl, log })
  return { ok: true, public: pub, tenant: ten }
}

// ── CLI：`node backend/tests/harness-check/_prepare-migrated-instance.mjs`（需 TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE）──
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gate = require(path.join(repoRoot, 'tests/helpers/db-isolation.cjs'))
  const provision = require(path.join(repoRoot, 'tests/isolation/provision.cjs'))
  const res = gate.checkIsolationConfig({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_DB_CONTEXT_FILE: process.env.TEST_DB_CONTEXT_FILE })
  if (!res.ok) { console.error(JSON.stringify({ ok: false, code: res.code, reason: res.reason })); process.exit(2) }
  const cfg = res.cfg
  const { user: u, password: p } = provision.readAdminCredentials(cfg.runId)
  const { rec } = provision.readOwnership(cfg.runId)
  const adminUrl = `postgresql://${encodeURIComponent(u)}:${encodeURIComponent(p)}@127.0.0.1:${rec.port}/${cfg.database}`
  prepareMigratedInstance({ adminUrl, cfg, log: (m) => console.error(`[prep] ${m}`) })
    .then((r) => { console.log(JSON.stringify({ ok: true, publicMode: r.public.mode, tenantCheckRc: r.tenant.checkRc }, null, 2)); process.exit(0) })
    .catch((e) => { console.error(JSON.stringify({ ok: false, code: e.code || 'E_PREP', message: e.message }, null, 2)); process.exit(1) })
}
