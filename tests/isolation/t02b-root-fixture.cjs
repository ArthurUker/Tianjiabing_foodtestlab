'use strict'
/**
 * P3-W0-T02B — root Jest 专用 controller fixture（在**新建自有实例**内精确补齐 public."School"/"User"
 * 与学校 schema 的 "User" 所需的受控行/授权；不执行 db push/migrate/seed，不接管已有对象）。
 *
 * 位置：tests/isolation/（本包允许新增的 root 专用 fixture）。T02A 共享门禁/provisioner 均未修改。
 *
 * 用法：node tests/isolation/t02b-root-fixture.cjs --run-id <id> [--out <json>] [--evidence-copy <path>]
 * 退出码：0 = fixture 就绪；非 0 = 拒绝（已存在对象 owner/行不符、School 清单越界、权限不足等），不接管。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const gate = require('../helpers/db-isolation.cjs')
const provision = require('./provision.cjs')

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const fail = (code, message, detail) => {
  console.error(JSON.stringify({ ok: false, code, message, detail: detail || null }))
  process.exit(1)
}

async function main() {
  const runId = arg('run-id')
  if (!runId) fail('E_ARG', 'missing --run-id')
  const derived = gate.derivedNamespace(runId)
  const schoolCode = derived.tenants.a              // runId 派生（非业务样式命名）
  const schoolSchema = derived.schemas.a
  const platformAdminId = `t02b-${runId}-platform-admin`
  const platformAdminUsername = `t02b_${runId}_platform_admin`

  const { rec } = provision.readOwnership(runId)
  const { user: adminUser, password: adminPassword } = provision.readAdminCredentials(runId)

  const { Client } = require('pg')
  const admin = new Client({
    connectionString: `postgresql://${adminUser}:${encodeURIComponent(adminPassword)}@127.0.0.1:${rec.port}/${derived.database}`,
    connectionTimeoutMillis: 8000, application_name: 't02b-root-fixture',
  })
  await admin.connect()
  let mainError = null
  let result = null
  try {
    // 0) 目标 schema 必须已由 T02A provisioner 建好（不接管/不新建业务对象）
    const ns = await admin.query(`SELECT n.nspname AS schema, r.rolname AS owner FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1`, [schoolSchema])
    if (ns.rows.length !== 1) fail('E_SCHEMA_MISSING', 'school schema (runId-derived) is missing; provision first', { schoolSchema })
    if (ns.rows[0].owner !== derived.adminRole) fail('E_SCHEMA_OWNER', 'school schema owner mismatch', { owner: ns.rows[0].owner })

    // 1) public."School" / public."User"：**只核对不建**（migration-first；R17/B-1：fixture 不得以手写 DDL 绕链）
    const requireTable = async (name) => {
      const exists = await admin.query(`SELECT r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relname=$1`, [name])
      if (exists.rows.length === 0) {
        fail('E_PUBLIC_NOT_MIGRATED', `public."${name}" missing — public chain must be applied first (migration-first; fixture does not create product tables)`, { table: `public.${name}` })
      }
      if (exists.rows[0].owner !== derived.adminRole) fail('E_TABLE_OWNER', `public."${name}" exists but is not owned by the task admin role`, { owner: exists.rows[0].owner })
      return { created: false, verified: true }
    }
    const schoolTable = await requireTable('School')
    const userTable = await requireTable('User')
    // 链上契约事实（一次性只读核对，供证据）：id/updated_at 均 NOT NULL 且**无列默认**
    const schoolIdContract = await admin.query(
      `SELECT a.attname AS col, a.attnotnull AS not_null, (d.adbin IS NOT NULL) AS has_default
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
        WHERE n.nspname='public' AND c.relname='School' AND a.attname IN ('id','updated_at') AND a.attnum > 0`)
    const idCol = schoolIdContract.rows.find((r) => r.col === 'id') || {}
    const updatedAtCol = schoolIdContract.rows.find((r) => r.col === 'updated_at') || {}
    if (idCol.not_null !== true || idCol.has_default === true) {
      fail('E_SCHOOL_ID_CONTRACT', 'public."School".id must be NOT NULL without column default (chain contract)', { idCol })
    }

    // 1b) 学校 schema 结构：**不由本 fixture 造表**（R17/B-1：不得先造租户合成 User 污染链）。
    //     改为调用**产品入口**回放版本化租户链（migration-first）→ 租户 "User" 等结构来自链，而非手写 DDL。
    let chainReplay = null

    // 2) School 清单核对：**只允许本任务登记的 code**（若出现其它活跃学校 → 拒绝，业务 purge 不执行）
    const schoolRows = await admin.query(`SELECT code, status FROM public."School"`)
    const foreign = schoolRows.rows.filter((r) => r.code !== schoolCode)
    if (foreign.length > 0) fail('E_SCHOOL_LIST_SCOPE', 'public."School" contains rows outside this task (refusing to run a real purge)', { foreign: foreign.map((f) => f.code) })
    const mine = schoolRows.rows.filter((r) => r.code === schoolCode)
    const fixtureSchoolId = `t02b-${runId}-school`
    let schoolIdSource = null
    if (mine.length === 0) {
      // R17/B-1：链上 School.id NOT NULL 且**无列默认** → 必须显式给稳定有效 id（updated_at 同）
      await admin.query(
        `INSERT INTO public."School" (id, code, name, status, updated_at) VALUES ($1, $2, $3, 'active', now())`,
        [fixtureSchoolId, schoolCode, `T02B isolated school ${schoolCode}`])
      schoolIdSource = 'fixture-insert@B-1'
    } else {
      // 既有行：**幂等核对**（身份不可篡改）
      const existing = await admin.query(`SELECT id, status FROM public."School" WHERE code=$1`, [schoolCode])
      if (existing.rows.length !== 1 || typeof existing.rows[0].id !== 'string' || existing.rows[0].id.length === 0) {
        fail('E_SCHOOL_ID_MISSING', 'existing school row lacks a usable id (refusing to tamper with identity)', { row: existing.rows[0] || null })
      }
      schoolIdSource = 'existing-row(identity-untouched)'
      if (existing.rows[0].status !== 'active') {
        await admin.query(`UPDATE public."School" SET status='active', updated_at=now() WHERE code=$1`, [schoolCode])
      }
    }

    // 1c) 租户链回放（产品入口；migration-first）——产出租户 "User" 等结构（不再手写合成表）
    {
      const { PrismaClient } = require(path.join(__dirname, '..', '..', 'backend', 'node_modules/@prisma/client'))
      const syncMod = await import(path.join(__dirname, '..', '..', 'backend', 'lib', 'tenantSync.js'))
      // 产品租户同步/客户端依赖进程内 DATABASE_URL（本实例管理连接；仅进程内，不落盘）
      process.env.DATABASE_URL = process.env.DATABASE_URL || `postgresql://${adminUser}:${encodeURIComponent(adminPassword)}@127.0.0.1:${rec.port}/${derived.database}`
      const syncPrisma = new PrismaClient({ datasources: { db: { url: `postgresql://${adminUser}:${encodeURIComponent(adminPassword)}@127.0.0.1:${rec.port}/${derived.database}` } } })
      const logs = []
      try {
        const adminPasswordForSeed = `${crypto.randomBytes(18).toString('hex')}Aa1`
        const res = await syncMod.syncAllTenantSchemas(syncPrisma, { skipGenerate: true, adminPassword: adminPasswordForSeed, log: (m) => logs.push(String(m).slice(0, 160)) })
        if (res && res.ok === false) fail('E_TENANT_CHAIN_REPLAY', 'tenant chain replay failed (migration-first)', { failed: (res.failed || []).slice(0, 3) })
      } finally {
        await syncPrisma.$disconnect().catch(() => {})
      }
      const tenantUserRow = await admin.query(
        `SELECT r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname=$1 AND c.relname='User'`,
        [schoolSchema])
      if (tenantUserRow.rows.length === 0) fail('E_TENANT_USER_MISSING', 'tenant chain did not create "User" (expected from versioned chain)', { schoolSchema })
      if (tenantUserRow.rows[0].owner !== derived.adminRole) fail('E_TENANT_USER_OWNER', `"${schoolSchema}"."User" exists but is not owned by the task admin role`, { owner: tenantUserRow.rows[0].owner })
      const ledger = await admin.query(`SELECT status, count(*)::int AS n FROM "${schoolSchema}"."_tenant_migrations" GROUP BY status ORDER BY status`)
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${schoolSchema}"."User" TO ${gate.quoteIdent(derived.role)}`)
      chainReplay = { via: 'backend/lib/tenantSync.js#syncAllTenantSchemas', ledgerByStatus: Object.fromEntries(ledger.rows.map((r) => [r.status, r.n])), userTableOwner: tenantUserRow.rows[0].owner, logTail: logs.slice(-3) }
    }

    // 3) public 平台 admin（正对照必须**实际存在**；school_code IS NULL → 不属于任何学校）
    const existingAdmin = await admin.query(`SELECT id, role, school_code FROM public."User" WHERE id=$1`, [platformAdminId])
    if (existingAdmin.rows.length === 0) {
      await admin.query(
        `INSERT INTO public."User" (id, username, password_hash, role, status, school_code, updated_at) VALUES ($1, $2, 'fixture-not-a-real-hash', 'admin', 'active', NULL, now())`,
        [platformAdminId, platformAdminUsername]
      )
    } else if (existingAdmin.rows[0].role !== 'admin' || existingAdmin.rows[0].school_code !== null) {
      fail('E_PLATFORM_ADMIN_SHAPE', 'existing platform admin row has unexpected shape', { row: existingAdmin.rows[0] })
    }

    // 4) 最小授权给测试角色（只读 public 两表；schema 内 User 的 DML 由 T02A fixture 已授予）
    const role = gate.quoteIdent(derived.role)
    await admin.query(`REVOKE ALL ON public."School" FROM PUBLIC`)
    await admin.query(`REVOKE ALL ON public."User" FROM PUBLIC`)
    await admin.query(`GRANT SELECT ON public."School" TO ${role}`)
    await admin.query(`GRANT SELECT ON public."User" TO ${role}`)
    // 明确不授予的写权限（供负例断言）
    const denied = {}
    for (const [label, sql] of [
      ['school_insert', `has_table_privilege('${derived.role}', 'public."School"', 'INSERT')`],
      ['school_update', `has_table_privilege('${derived.role}', 'public."School"', 'UPDATE')`],
      ['school_delete', `has_table_privilege('${derived.role}', 'public."School"', 'DELETE')`],
      ['public_user_insert', `has_table_privilege('${derived.role}', 'public."User"', 'INSERT')`],
      ['public_user_update', `has_table_privilege('${derived.role}', 'public."User"', 'UPDATE')`],
      ['public_user_delete', `has_table_privilege('${derived.role}', 'public."User"', 'DELETE')`],
    ]) {
      const r = await admin.query(`SELECT ${sql} AS v`)
      denied[label] = r.rows[0].v
    }
    if (Object.values(denied).some((v) => v !== false)) fail('E_PUBLIC_WRITE_GRANTED', 'test role must not hold write privileges on public tables', denied)

    // 5) sentinel baseline（独立所有者对象，purge 不应触及）
    const sentinel = await admin.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(id::text || ':' || note, ',' ORDER BY id)), 'empty') AS digest FROM ${gate.quoteQualified(derived.sentinelSchema + '.sentinel_rows')}`)

    result = {
      ok: true,
      task: 'P3-W0-T02B',
      runId,
      port: rec.port,
      database: derived.database,
      schoolCode,
      schoolSchema,
      platformAdminId,
      platformAdminUsername,
      publicTables: { School: schoolTable, User: userTable },
      schoolId: (await admin.query(`SELECT id FROM public."School" WHERE code=$1`, [schoolCode])).rows[0].id,
      schoolIdSource,
      schoolIdContract: { id: { notNull: idCol.not_null === true, hasDefault: idCol.has_default === true }, updated_at: { notNull: updatedAtCol.not_null === true, hasDefault: updatedAtCol.has_default === true } },
      tenantChainReplay: chainReplay,
      tenantUserTable: { schema: schoolSchema, created: false, viaChain: true },
      schoolListBaseline: schoolRows.rows.map((r) => r.code).filter((c) => c === schoolCode),
      testRoleDeniedOnPublicWrites: denied,
      sentinelBefore: sentinel.rows[0],
      generatedAtUtc: new Date().toISOString(),
    }
  } catch (e) {
    mainError = e
  }
  let releaseError = null
  try { await admin.end() } catch (e) { releaseError = e }
  if (mainError) {
    console.error(JSON.stringify({
      ok: false, code: mainError.code || 'E_UNKNOWN', message: String(mainError.message).slice(0, 300),
      releaseError: releaseError ? { code: releaseError.code || 'UNKNOWN' } : null,
    }))
    process.exit(1)
  }
  if (releaseError) fail('E_FIXTURE_RELEASE', 'controller client end() failed', { code: releaseError.code || 'UNKNOWN' })

  const out = arg('out', path.join(provision.taskRoot(runId), 't02b-fixture.json'))
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  const evidenceCopy = arg('evidence-copy')
  if (evidenceCopy) { fs.mkdirSync(path.dirname(evidenceCopy), { recursive: true }); fs.writeFileSync(evidenceCopy, JSON.stringify(result, null, 2) + '\n') }
  console.log(JSON.stringify({ ok: true, fixtureFile: out, evidenceCopy: evidenceCopy || null, schoolCode, schoolSchema, platformAdminId, sentinelBefore: result.sentinelBefore }, null, 2))
  process.exit(0)
}

main().catch((e) => { console.error(JSON.stringify({ ok: false, code: (e && e.code) || 'E_MAIN', message: String(e && e.message).slice(0, 300) })); process.exit(1) })
