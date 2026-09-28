// P3-W5-REPORT-AUTH-T01 报告授权矩阵 —— 实例准备（本包新建；不是测试，不被 node --test 收集）。
//
// 目的：在**本包独占隔离实例**内准备报告授权矩阵套件所需的最小结构：
//   ① public 业务表：**版本化链**（`prisma migrate deploy`；P3-FIXTURE-MIGRATED-R1 起不再 db push）；
//   ② 派生租户 schema 业务表（lib/tenantSync.syncAllTenantSchemas，仅处理本实例 public."School" 中的派生 code）；
//   ③ 门禁依赖对象（P3-DB-FIXTURE-R1：fixture schema 内 t02a_instance_marker / messages_{a,b,c}）按契约 ensure；
//   ④ 账号 seed：平台超管（public，role=admin 且 school_code=NULL）+ 租户 manager/operator/viewer
//      （must_change_password=false；生产不变量：租户内最高 manager）；
//   ⑤ 报告模块测试数据：1 个 task 用例 + 1 个 issue 用例 + 1 条执行记录 + 1 个证据文件。
//
// 纪律：口令只经 env（RPTAUTH_*_PASSWORD）传递，缺失即 fail-closed，绝不落日志/证据；
//       不连接其他库、不读业务 dotenv、不改生产模块。
// 用法：node backend/tests/report-auth/report-auth-fixture.mjs <runId> <evidenceJsonPath>
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(here, '..', '..')
const repoRoot = path.resolve(backendDir, '..')

const runId = process.argv[2]
const evidencePath = process.argv[3] || null
if (!runId) {
  console.error(JSON.stringify({ ok: false, code: 'E_ARG', message: 'usage: node report-auth-fixture.mjs <runId> <evidenceJsonPath>' }))
  process.exit(1)
}

// ===== 口令（只经 env；强度校验 fail-closed；值绝不打印）=====
const ACCOUNTS = {
  superAdmin: { username: 'rptauth_admin', role: 'admin', schoolCode: null, envKey: 'RPTAUTH_SUPER_ADMIN_PASSWORD' },
  manager: { username: 'rptauth_manager', role: 'manager', envKey: 'RPTAUTH_MANAGER_PASSWORD' },
  operator: { username: 'rptauth_operator', role: 'operator', envKey: 'RPTAUTH_OPERATOR_PASSWORD' },
  viewer: { username: 'rptauth_viewer', role: 'viewer', envKey: 'RPTAUTH_VIEWER_PASSWORD' },
}
{
  const missing = []
  const weak = []
  for (const a of Object.values(ACCOUNTS)) {
    const v = process.env[a.envKey]
    if (!v) { missing.push(a.envKey); continue }
    if (!(String(v).length >= 8 && /[a-zA-Z]/.test(v) && /[0-9]/.test(v))) weak.push(a.envKey)
  }
  if (missing.length || weak.length) {
    console.error(JSON.stringify({ ok: false, code: 'E_CONTRACT_ENV', message: '口令缺失或强度不足（≥8 位且含字母与数字）', missing, weak }))
    process.exit(1)
  }
}

const gate = require(path.join(repoRoot, 'tests/helpers/db-isolation.cjs'))
const provision = require(path.join(repoRoot, 'tests/isolation/provision.cjs'))
const bcryptjs = require(path.join(backendDir, 'node_modules/bcryptjs'))

const steps = []
const fail = (code, message, detail) => {
  const out = { ok: false, task: 'P3-W5-REPORT-AUTH-T01', code, message, detail: detail || null, steps }
  if (evidencePath) { fs.mkdirSync(path.dirname(evidencePath), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify(out, null, 2) + '\n') }
  console.error(JSON.stringify(out))
  process.exit(1)
}

// 证据文件内容（1x1 PNG；仅测试用固定字节）
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function main() {
  // ① 显式隔离配置（fail-closed）并与 argv runId 交叉校验
  const cfgResult = gate.checkIsolationConfig({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_DB_CONTEXT_FILE: process.env.TEST_DB_CONTEXT_FILE })
  if (!cfgResult.ok) fail('E_ISOLATION_REFUSED', `isolation config refused: ${cfgResult.code}`, { reason: cfgResult.reason })
  const cfg = cfgResult.cfg
  if (cfg.runId !== runId) fail('E_RUNID_MISMATCH', 'argv runId 与 context runId 不一致', { argv: runId, context: cfg.runId })
  const derived = gate.derivedNamespace(runId)
  const { root, rec } = provision.readOwnership(runId)
  const { user: adminUser, password: adminPassword } = provision.readAdminCredentials(runId)
  const adminUrl = `postgresql://${encodeURIComponent(adminUser)}:${encodeURIComponent(adminPassword)}@127.0.0.1:${rec.port}/${derived.database}`
  steps.push({ step: 'context_loaded', runId, port: rec.port, database: derived.database, tenant: derived.tenants.a, schema: derived.schemas.a })

  // ⓪ 前置：T02A 门禁辅助对象的**历史位置残留**（public / 学校 schema；P3-DB-FIXTURE-R1 后不再创建）。
  //    P3-FIXTURE-MIGRATED-R1：只在**证明**（同实例、owner=实例管理角色、零行、列指纹一致）后清理；证明不通过 → fail-closed。
  //    **不再清理 public.revoked_tokens**（认证基础设施，留 public；由链上 public migration 或 provision 前置按运行时形状建立）。
  {
    const pgRequire = createRequire(path.join(repoRoot, 'package.json'))
    const { Client } = pgRequire('pg')
    const pre = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 8000, application_name: 'rptauth-fixture-pre' })
    await pre.connect()
    const legacy = [
      { schema: 'public', table: 'messages', cols: ['id', 'tenant_tag', 'body'] },
      { schema: 'public', table: 't02a_instance_marker', cols: ['key', 'value'] },
      { schema: derived.schemas.a, table: 'messages', cols: ['id', 'tenant_tag', 'body'] },
    ]
    const decisions = []
    try {
      for (const t of legacy) {
        const qual = `${gate.quoteIdent(t.schema)}.${gate.quoteIdent(t.table)}`
        const reg = await pre.query('SELECT to_regclass($1)::text AS t', [qual])
        if (reg.rows[0]?.t === null) { decisions.push({ schema: t.schema, table: t.table, state: 'absent' }); continue }
        const meta = await pre.query(
          `SELECT r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname=$1 AND c.relname=$2`, [t.schema, t.table])
        const cols = await pre.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`, [t.schema, t.table])
        const cnt = await pre.query(`SELECT count(*)::int AS n FROM ${qual}`)
        const owner = meta.rows[0]?.owner || null
        const rows = Number(cnt.rows[0]?.n ?? -1)
        const colsNow = cols.rows.map((c) => c.column_name).sort()
        const shapeOk = JSON.stringify(colsNow) === JSON.stringify([...t.cols].sort())
        const proven = owner === derived.adminRole && rows === 0 && shapeOk
        decisions.push({ schema: t.schema, table: t.table, state: proven ? 'dropped' : 'refused', owner, rows, shapeOk })
        if (proven) await pre.query(`DROP TABLE ${qual}`)
      }
    } finally {
      await pre.end().catch(() => {})
    }
    steps.push({ step: 'pre_cleanup_legacy_helpers', decisions })
    const refused = decisions.filter((d) => d.state === 'refused')
    if (refused.length) fail('E_LEGACY_HELPER_REFUSED', '遗留辅助对象不满足"本实例 owner/零行/列指纹一致"证明 → 拒绝清理（fail-closed）', { refused })
  }

  // ① public 业务表：**版本化迁移链**（provision up 已 migration-first；这里幂等复核台账完整性，缺一即 fail-closed）
  const { ensurePublicMigrated } = await import('../harness-check/_prepare-migrated-instance.mjs')
  const pub = await ensurePublicMigrated({ adminUrl, cfg: { derived }, log: (m) => steps.push({ step: 'public_migrate_prep_log', message: String(m).slice(0, 200) }) })
  steps.push({ step: 'public_migrate_prep', mode: pub.mode, applied: pub.ledger.applied.length, chainTotal: pub.ledger.chainTotal })

  process.env.DATABASE_URL = adminUrl // 仅本进程内临时指向隔离实例（tenantSync 依赖）
  const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'))
  const { syncAllTenantSchemas } = await import(path.join(backendDir, 'lib/tenantSync.js'))
  const { createTenantClient } = await import(path.join(backendDir, 'lib/tenantClient.js'))
  const { CASE_DEFS } = await import(path.join(backendDir, 'lib/testCaseDefs.js'))
  const { verifySessionValidity } = await import(path.join(backendDir, 'middleware/authMiddleware.js'))

  const adminPrisma = new PrismaClient({ datasources: { db: { url: adminUrl } } })

  // ③ 派生学校行 + 门禁依赖对象（marker 是后续门禁运行期核验的必需对象，先于租户同步重建）
  await adminPrisma.school.upsert({
    where: { code: derived.tenants.a },
    update: { status: 'active' },
    create: { code: derived.tenants.a, name: `RPTAUTH isolated school ${derived.tenants.a}`, status: 'active' },
  })
  steps.push({ step: 'ensure_school_row', code: derived.tenants.a })

  // ③b 门禁依赖对象（P3-DB-FIXTURE-R1：位于 runId 派生的 fixture schema；public 不再放合成对象）；
  //     revoked_tokens = 正式认证基础设施（留 public）：由链上 public migration（窗口 2 之后）或 provision 前置
  //     按**运行时逐字形状**建立；本 fixture 只做只读核对（不再运行时自建、不再 DROP）。
  const adminRoleIdent = gate.quoteIdent(derived.adminRole)
  const roleIdent = gate.quoteIdent(derived.role)
  const fxIdent = gate.quoteIdent(derived.fixtureSchema)
  const markerIdent = gate.quoteQualified(derived.markerTable)
  await adminPrisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${fxIdent}`)
  await adminPrisma.$executeRawUnsafe(`ALTER SCHEMA ${fxIdent} OWNER TO ${adminRoleIdent}`)
  await adminPrisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${markerIdent} (key text PRIMARY KEY, value text NOT NULL)`)
  await adminPrisma.$executeRawUnsafe(`ALTER TABLE ${markerIdent} OWNER TO ${adminRoleIdent}`)
  await adminPrisma.$executeRawUnsafe(
    `INSERT INTO ${markerIdent} (key, value) VALUES ('instance_tag', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    derived.instanceTag,
  )
  await adminPrisma.$executeRawUnsafe(`REVOKE ALL ON ${markerIdent} FROM PUBLIC`)
  await adminPrisma.$executeRawUnsafe(`REVOKE ALL ON ${markerIdent} FROM ${roleIdent}`)
  await adminPrisma.$executeRawUnsafe(`GRANT SELECT ON ${markerIdent} TO ${roleIdent}`)
  await adminPrisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA ${fxIdent} TO ${roleIdent}`)
  for (const slot of gate.FIXTURE_CONTRACT.messagesSlots) {
    const tableIdent = gate.quoteQualified(derived.fixtureMessages[slot])
    await adminPrisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${tableIdent} (id serial PRIMARY KEY, tenant_tag text NOT NULL, body text NOT NULL)`)
    await adminPrisma.$executeRawUnsafe(`ALTER TABLE ${tableIdent} OWNER TO ${adminRoleIdent}`)
    const n = await adminPrisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${tableIdent}`)
    if (n[0].n === 0) {
      await adminPrisma.$executeRawUnsafe(`INSERT INTO ${tableIdent} (tenant_tag, body) VALUES ($1, $2)`, derived.tenants[slot], `data-of-${derived.tenants[slot]}`)
    }
    await adminPrisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableIdent} TO ${roleIdent}`)
    const seqIdent = gate.quoteQualified(`${derived.fixtureSchema}.${gate.FIXTURE_CONTRACT.messagesTablePrefix}${slot}_id_seq`)
    await adminPrisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON SEQUENCE ${seqIdent} TO ${roleIdent}`)
  }
  const fixtureObjects = await adminPrisma.$queryRawUnsafe(
    `SELECT n.nspname AS schema, c.relname, r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
     WHERE n.nspname = $1 ORDER BY 2`, derived.fixtureSchema)
  steps.push({ step: 'ensure_gate_objects', fixtureSchema: derived.fixtureSchema, fixtureObjects })

  // ④ 租户 schema 同步（provisionSchool 幂等推全表；租户 messages 已在上方移除 → 对齐无需丢数据）
  //    adminPassword 仅进程内随机生成，用于租户首个 manager（must_change_password=true）——不落日志、不用于本包测试身份。
  const syncLogs = []
  try {
    const syncRes = await syncAllTenantSchemas(adminPrisma, {
      skipGenerate: true,
      adminPassword: `${crypto.randomBytes(18).toString('hex')}Aa1`,
      log: (m) => syncLogs.push(String(m).slice(0, 200)),
    })
    if (syncRes && syncRes.ok === false) {
      fail('E_TENANT_SYNC', 'syncAllTenantSchemas 聚合失败（不得按成功放行）', { failed: syncRes.failed || null, logs: syncLogs.slice(-8) })
    }
    steps.push({ step: 'syncAllTenantSchemas', ok: true, logs: syncLogs.slice(-8) })
  } catch (e) {
    fail('E_TENANT_SYNC', 'tenant schema sync failed', { code: e.code || 'UNKNOWN', message: String(e.message).slice(0, 300), logs: syncLogs.slice(-8) })
  }

  // ④b 回放后 GRANT（契约固化点）+ 认证设施只读核对（运行时 DDL 逐字一致 + 形状断言）
  {
    // public 业务表：测试角色需 USAGE + DML 才能跑受限角色自证（与 t02c fixture 同口径；**回放后**施加）
    const roleIdentPub = gate.quoteIdent(derived.role)
    const publicGrants = []
    for (const sql of [
      `GRANT USAGE ON SCHEMA public TO ${roleIdentPub}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleIdentPub}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleIdentPub}`,
    ]) {
      await adminPrisma.$executeRawUnsafe(sql)
      publicGrants.push(sql.replace(/\s+/g, ' ').slice(0, 110))
    }
    steps.push({ step: 'post_replay_grant_public', grants: publicGrants })
    const applied = await provision.grantPostReplayTenantDml({
      query: (sql) => adminPrisma.$executeRawUnsafe(sql),
      role: derived.role,
      schemas: [derived.schemas.a],
      log: (m) => steps.push({ step: 'post_replay_grant_log', message: String(m).slice(0, 160) }),
    })
    steps.push({ step: 'post_replay_grant_tenant', applied })
    // P3-FIXTURE-MIGRATED-R2：吊销表/三索引的事实源 = 链尾 `-- @scope: public` migration（只读核对；
    //   运行时 DDL 常量已随公共链撤出）→ 缺失/错形即拒绝，不在测试准备阶段补建产品设施。
    const shapeMod = await import(path.join(backendDir, 'lib', 'publicInfraShape.js'))   // ESM 调用方注入产品契约
    const infra = await provision.assertRevocationInfraFromChain({
      client: adminPrisma,
      shapeFn: (c) => shapeMod.revokedTokensShapeIssues(c),
    })
    steps.push({
      step: 'revocation_infra_from_chain',
      contract: infra.shape.contract,
      migrations: infra.migration.files,
      migrationOk: infra.migration.ok,
      shapeOk: infra.shape.ok,
      shapeIssues: infra.shape.issues,
    })
  }

  // ⑤ 时间戳默认值（供不带时间戳列的插入路径；与 T02C fixture 口径一致）
  for (const stmt of [
    `ALTER TABLE public."User" ALTER COLUMN created_at SET DEFAULT now()`,
    `ALTER TABLE public."User" ALTER COLUMN updated_at SET DEFAULT now()`,
    `ALTER TABLE public."School" ALTER COLUMN created_at SET DEFAULT now()`,
    `ALTER TABLE public."School" ALTER COLUMN updated_at SET DEFAULT now()`,
    `ALTER TABLE public."TestCase" ALTER COLUMN created_at SET DEFAULT now()`,
    `ALTER TABLE public."TestCase" ALTER COLUMN updated_at SET DEFAULT now()`,
    `ALTER TABLE public."TestExecution" ALTER COLUMN executed_at SET DEFAULT now()`,
  ]) {
    try { await adminPrisma.$executeRawUnsafe(stmt) } catch { /* 列不存在则跳过 */ }
  }
  for (const tbl of ['User', 'School', 'TestCase', 'TestExecution']) {
    for (const col of ['created_at', 'updated_at', 'executed_at']) {
      try { await adminPrisma.$executeRawUnsafe(`ALTER TABLE "${derived.schemas.a}"."${tbl}" ALTER COLUMN ${col} SET DEFAULT now()`) } catch { /* 跳过 */ }
    }
  }

  // ⑥ 访客开关（quick-access 需要 SchoolCustomization.guest_enabled=true）
  await adminPrisma.schoolCustomization.upsert({
    where: { school_code: derived.tenants.a },
    update: { guest_enabled: true },
    create: { school_code: derived.tenants.a, guest_enabled: true },
  })
  steps.push({ step: 'guest_enabled', schoolCode: derived.tenants.a })

  // ⑦ 账号 seed（幂等 upsert / update；must_change_password=false）
  const tenantClient = createTenantClient(adminPrisma, derived.tenants.a)
  const seeded = {}
  {
    const a = ACCOUNTS.superAdmin
    const password_hash = await bcryptjs.hash(process.env[a.envKey], 10)
    const existing = await adminPrisma.user.findFirst({ where: { username: a.username, school_code: null } })
    const row = existing
      ? await adminPrisma.user.update({ where: { id: existing.id }, data: { password_hash, role: 'admin', status: 'active', school_code: null, must_change_password: false } })
      : await adminPrisma.user.create({ data: { username: a.username, password_hash, role: 'admin', status: 'active', school_code: null, must_change_password: false, full_name: 'RPTAUTH platform super admin' } })
    seeded.superAdmin = { username: row.username, role: row.role, schoolCode: null, id: row.id }
  }
  for (const key of ['manager', 'operator', 'viewer']) {
    const a = ACCOUNTS[key]
    const password_hash = await bcryptjs.hash(process.env[a.envKey], 10)
    const existing = await tenantClient.user.findFirst({ where: { username: a.username } })
    const row = existing
      ? await tenantClient.user.update({ where: { id: existing.id }, data: { password_hash, role: a.role, status: 'active', must_change_password: false } })
      : await tenantClient.user.create({ data: { username: a.username, password_hash, role: a.role, status: 'active', school_code: derived.tenants.a, must_change_password: false, full_name: `RPTAUTH ${a.role} account` } })
    seeded[key] = { username: row.username, role: row.role, schoolCode: derived.tenants.a, id: row.id }
  }
  steps.push({ step: 'seed_accounts', accounts: Object.fromEntries(Object.entries(seeded).map(([k, v]) => [k, { username: v.username, role: v.role, schoolCode: v.schoolCode }])) })

  // 哈希自检（seed 与生产登录口径一致性）
  const seededTenant = {}
  for (const key of ['manager', 'operator', 'viewer']) {
    const row = await tenantClient.user.findFirst({ where: { username: ACCOUNTS[key].username } })
    seededTenant[key] = row ? await bcryptjs.compare(process.env[ACCOUNTS[key].envKey], row.password_hash) : false
  }
  const superRow = await adminPrisma.user.findUnique({ where: { username: ACCOUNTS.superAdmin.username } })
  const hashOk = { superAdmin: superRow ? await bcryptjs.compare(process.env[ACCOUNTS.superAdmin.envKey], superRow.password_hash) : false, ...seededTenant }
  steps.push({ step: 'hash_selfcheck', hashOk })
  if (!Object.values(hashOk).every(Boolean)) fail('E_HASH_SELFCHECK', '账号口令 hash 自检失败', { hashOk })

  // ⑧ 报告模块测试数据（幂等：先清本包用例的执行记录，再 upsert 用例）
  const firstBrowserDef = CASE_DEFS.flatMap((g) => g.cases).find((c) => !c.serverOnly)
  if (!firstBrowserDef) fail('E_CASE_DEFS', 'CASE_DEFS 中找不到 browser 用例')
  const taskCaseRow = await adminPrisma.testCase.upsert({
    where: { case_key: firstBrowserDef.id },
    update: { source: 'task', group: 'rptauth', title: `RPTAUTH 任务用例 ${firstBrowserDef.id}`, closed: false, closed_by: null, closed_at: null, fixed_pending_retest: false, fixed_note: null, updated_at: new Date() },
    create: { case_key: firstBrowserDef.id, source: 'task', group: 'rptauth', title: `RPTAUTH 任务用例 ${firstBrowserDef.id}`, guide: '' },
  })
  const issueCaseRow = await adminPrisma.testCase.upsert({
    where: { case_key: 'RPTAUTH-ISS-1' },
    update: { source: 'issue', group: 'rptauth', title: 'RPTAUTH 反馈用例', closed: false, closed_by: null, closed_at: null, fixed_pending_retest: false, fixed_note: null, updated_at: new Date() },
    create: { case_key: 'RPTAUTH-ISS-1', source: 'issue', group: 'rptauth', title: 'RPTAUTH 反馈用例', reported_by: 'fixture', reported_at: new Date() },
  })
  await adminPrisma.testExecution.deleteMany({ where: { case_id: { in: [taskCaseRow.id, issueCaseRow.id] } } })
  await adminPrisma.testExecution.create({
    data: { case_id: taskCaseRow.id, round: 1, result: 'failed', detail: 'fixture 初始执行', tester_name: 'fixture-setup', tester_role: 'system@fixture' },
  })
  steps.push({ step: 'seed_report_cases', task: { id: taskCaseRow.id, case_key: taskCaseRow.case_key }, issue: { id: issueCaseRow.id, case_key: issueCaseRow.case_key } })

  // ⑨ 证据文件（写入报告模块证据目录；after-check 将核验其存在性与字节）
  const evidenceDir = path.join(backendDir, 'uploads', 'test-evidence', taskCaseRow.id)
  fs.mkdirSync(evidenceDir, { recursive: true })
  const evidenceFileName = 'rptauth-fixture.png'
  fs.writeFileSync(path.join(evidenceDir, evidenceFileName), PNG_1X1)
  steps.push({ step: 'seed_evidence_file', caseId: taskCaseRow.id, file: evidenceFileName, bytes: PNG_1X1.length })

  // ⑩ 门禁运行期核验（管理身份；marker 位于 fixture schema）：owner/只读契约在"迁移链 + fixture 契约"下成立
  const markerCheck = await adminPrisma.$queryRawUnsafe(
    `SELECT r.rolname AS owner, sr.rolname AS schema_owner,
            (SELECT value FROM ${markerIdent} WHERE key='instance_tag') AS instance_tag,
            has_table_privilege($1, c.oid, 'INSERT') AS can_insert,
            has_table_privilege($1, c.oid, 'UPDATE') AS can_update,
            has_table_privilege($1, c.oid, 'DELETE') AS can_delete,
            has_table_privilege($1, c.oid, 'TRUNCATE') AS can_truncate
     FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_roles r ON r.oid=c.relowner
     JOIN pg_roles sr ON sr.oid=n.nspowner
     WHERE n.nspname=$2 AND c.relname=$3`, derived.role, derived.fixtureSchema, gate.FIXTURE_CONTRACT.markerTableName)
  const marker = markerCheck[0]
  if (!marker || marker.owner !== derived.adminRole || marker.schema_owner !== derived.adminRole || marker.instance_tag !== derived.instanceTag
    || marker.can_insert !== false || marker.can_update !== false || marker.can_delete !== false || marker.can_truncate !== false) {
    fail('E_MARKER_REBUILD', 'gate marker ensure 未满足隔离契约', { marker: marker || null })
  }
  steps.push({ step: 'gate_marker_ok', marker })

  // ⑪ 会话模型自检：seed 的平台超管会话校验函数可调用（W1 统一模型可服务，不另造失效判断）
  const validity = await verifySessionValidity(adminPrisma, { jti: null, userId: 'rptauth-probe', iat: Math.floor(Date.now() / 1000), schoolCode: null })
  steps.push({ step: 'session_model_probe', validity: { invalid: validity.invalid === true, source: validity.source || null } })

  // ⑫ 受限角色真实 DML 自证（回放后 GRANT 的证据；事务内执行并回滚 → 零残留）
  {
    const testRoleUrlReal = process.env.TEST_DATABASE_URL
    if (!testRoleUrlReal) fail('E_TEST_URL', 'TEST_DATABASE_URL is required for the restricted-role DML self-proof')
    const pubId = `dml-${derived.instanceTag}-rptauth-pub`
    const tnId = `dml-${derived.instanceTag}-rptauth-tn`
    const probeClient = provision.createRoleProbeClient({ roleUrl: testRoleUrlReal, applicationName: 'rptauth-role-dml-probe' })
    await probeClient.connect()
    try {
      const publicProbe = await provision.runRestrictedRoleDmlProbe({
        client: probeClient,
        items: [
          { label: 'public.select', sql: `SELECT count(*)::int AS n FROM public."School"` },
          { label: 'public.insert', sql: `INSERT INTO public."SystemLog" (id, level, message) VALUES ($1, 'info', $2)`, params: [pubId, 'rptauth restricted-role DML self-proof'] },
          { label: 'public.update', sql: `UPDATE public."SystemLog" SET level = level WHERE id = $1`, params: [pubId] },
          { label: 'public.delete', sql: `DELETE FROM public."SystemLog" WHERE id = $1`, params: [pubId] },
        ],
        log: (m) => steps.push({ step: 'role_dml_probe_log', message: String(m).slice(0, 220) }),
      })
      // R17/B-2：走**产品入口**确保人类主体锚点（同一 schema；kind=user，禁止与 system 混用）
      //   产品租户客户端要求进程内 DATABASE_URL（指向本实例管理连接；不落盘、不进日志）
      process.env.DATABASE_URL = process.env.DATABASE_URL || adminUrl
      const { createTenantClient } = await import(path.join(backendDir, 'lib', 'tenantClient.js'))
      const auditPrincipalMod = await import(path.join(backendDir, 'lib', 'auditPrincipal.js'))
      const tenantAuditClient = createTenantClient(adminPrisma, derived.tenants.a)
      const principalRow = await auditPrincipalMod.ensurePrincipalForSubject(tenantAuditClient, {
        subjectUserId: seeded.manager.id,
        subjectUsername: seeded.manager.username,
        schoolCode: derived.tenants.a,
        origin: 'event',
      })
      const systemPrincipalIdExpected = auditPrincipalMod.systemPrincipalId(derived.schemas.a)
      if (!principalRow || principalRow.kind !== 'user' || principalRow.subject_user_id !== seeded.manager.id) {
        fail('E_AUDIT_PRINCIPAL_KIND', 'principal anchor is not the manager kind=user principal', { row: principalRow || null })
      }
      if (principalRow.id === systemPrincipalIdExpected) {
        fail('E_AUDIT_PRINCIPAL_KIND', 'user principal id equals system principal id (kind mixing would violate G3)', { id: principalRow.id })
      }
      steps.push({
        step: 'audit_principal_binding',
        schema: derived.schemas.a,
        principalId: principalRow.id,
        kind: principalRow.kind,
        subjectUserId: principalRow.subject_user_id,
        subjectUsername: principalRow.subject_username,
        origin: principalRow.origin,
        systemPrincipalId: systemPrincipalIdExpected,
        via: 'backend/lib/auditPrincipal.js#ensurePrincipalForSubject（产品入口）',
        semantics: 'human-event：principal_id(kind=user, subject_user_id=manager.id) 与 user_id 一致；system 主体未被混用',
      })
      const tenantProbe = await provision.runRestrictedRoleDmlProbe({
        client: probeClient,
        items: [
          { label: 'tenant.select', sql: `SELECT count(*)::int AS n FROM "${derived.schemas.a}"."TestRecord"` },
          // R17/B-2：M2 下 AuditLog.principal_id 必填，且必须与 user_id 的**人类主体**一致（不得混 system）
          { label: 'tenant.insert', sql: `INSERT INTO "${derived.schemas.a}"."AuditLog" (id, user_id, principal_id, action, resource_type)
              VALUES ($1, $2, $3, 'fixture-dml-proof', 'TestRecord')`, params: [tnId, seeded.manager.id, principalRow.id] },
          { label: 'tenant.update', sql: `UPDATE "${derived.schemas.a}"."AuditLog" SET resource_type = resource_type WHERE id = $1`, params: [tnId] },
          { label: 'tenant.delete', sql: `DELETE FROM "${derived.schemas.a}"."AuditLog" WHERE id = $1`, params: [tnId] },
        ],
        log: (m) => steps.push({ step: 'role_dml_probe_log', message: String(m).slice(0, 220) }),
      })
      steps.push({ step: 'restricted_role_dml_proof', public: publicProbe, tenant: tenantProbe })
      if (!publicProbe.ok || !tenantProbe.ok) {
        fail('E_RESTRICTED_ROLE_DML', 'restricted role cannot perform SELECT/INSERT/UPDATE/DELETE after post-replay GRANT', { public: publicProbe, tenant: tenantProbe })
      }
    } finally {
      await probeClient.end().catch(() => {})
    }
  }

  const counts = {
    publicSchool: await adminPrisma.school.count(),
    publicUser: await adminPrisma.user.count(),
    publicTestCase: await adminPrisma.testCase.count(),
    publicTestExecution: await adminPrisma.testExecution.count(),
    tenantUser: await tenantClient.user.count(),
  }
  await tenantClient.$disconnect()
  await adminPrisma.$disconnect()

  const out = {
    ok: true,
    task: 'P3-W5-REPORT-AUTH-T01',
    runId,
    instanceRoot: root,
    port: rec.port,
    database: derived.database,
    schoolCode: derived.tenants.a,
    tenantSchema: derived.schemas.a,
    accounts: Object.fromEntries(Object.entries(seeded).map(([k, v]) => [k, { username: v.username, role: v.role, schoolCode: v.schoolCode }])),
    accountsPasswordSource: 'env(RPTAUTH_*_PASSWORD)；仅 env 传递，不落日志/证据',
    hashSelfCheck: hashOk,
    cases: {
      task: { id: taskCaseRow.id, case_key: taskCaseRow.case_key, source: 'task' },
      issue: { id: issueCaseRow.id, case_key: issueCaseRow.case_key, source: 'issue' },
      nonexistentId: 'rptauth-no-such-case',
    },
    evidenceFile: { caseId: taskCaseRow.id, file: evidenceFileName, bytes: PNG_1X1.length },
    counts,
    steps,
    generatedAtUtc: new Date().toISOString(),
  }
  if (evidencePath) { fs.mkdirSync(path.dirname(evidencePath), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify(out, null, 2) + '\n') }
  console.log(JSON.stringify({ ok: true, task: out.task, runId, schoolCode: out.schoolCode, tenantSchema: out.tenantSchema, cases: out.cases, counts }, null, 2))
}

main().catch((e) => fail('E_UNKNOWN', String((e && e.message) || e), { code: (e && e.code) || 'UNKNOWN' }))
