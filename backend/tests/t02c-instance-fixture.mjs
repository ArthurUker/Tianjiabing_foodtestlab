// P3-W0-T02C/T02E 专用**实例准备**辅助（backend/tests/ 本包新建；不是测试，不被 node --test 收集）。
//
// 目的：在本包**新建的独占隔离实例**内准备 backend 业务套件与 live-api 所需的最小业务结构：
//   ① public 业务表：**版本化链**（`prisma migrate deploy`；P3-FIXTURE-MIGRATED-R1 起 fixture 不再使用 db push）；
//   ② 派生租户 schema 的业务表（`lib/tenantSync.syncAllTenantSchemas`，仅处理本实例 public."School" 中的派生 code）；
//   ③ **数据契约 seed（T02E）**：
//      · public 平台超管（role='admin' 且 school_code 为空 → 只能走生产专用路由 /api/user/super-admin/login）；
//      · 派生学校（public."School" 行）+ 该校租户内的 manager / operator 账号
//        （must_change_password=false，登录一律显式携带 schoolCode —— 生产 /api/user/login 的 NB-04 语义）；
//      · 口令只经 env（T02E_*）传递，缺失即 fail-closed，绝不落日志/证据；
//      · 注意生产不变量（P0-PROV）：学校租户内不得出现 role='admin'，本校最高角色是 manager。
//   ④ 给**测试角色**（cfg.role）补齐本实例内业务表所需 DML 授权（仅本库、仅 public 业务表；租户 schema 已由 T02A fixture 授权）。
//
// 不做：不连接其他库、不写业务 dotenv、不改生产模块、不在仓库外留凭据。
// 用法：node backend/tests/t02c-instance-fixture.mjs <runId> [evidenceJsonPath]
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(here, '..')
const repoRoot = path.resolve(backendDir, '..')

const runId = process.argv[2]
if (!runId) {
  console.error(JSON.stringify({ ok: false, code: 'E_ARG', message: 'usage: node t02c-instance-fixture.mjs <runId> [evidenceJson]' }))
  process.exit(1)
}
const evidencePath = process.argv[3] || null

// ===== P3-W0-T02E 数据契约 env（口令只经 env 传递；缺失/弱口令 fail-closed，值绝不打印）=====
const CONTRACT = {
  superAdminUsername: process.env.T02E_SUPER_ADMIN_USERNAME || 'admin',
  superAdminPassword: process.env.T02E_SUPER_ADMIN_PASSWORD || '',
  managerUsername: process.env.T02E_SCHOOL_MANAGER_USERNAME || 'manager',
  managerPassword: process.env.T02E_SCHOOL_MANAGER_PASSWORD || '',
  operatorUsername: process.env.T02E_SCHOOL_OPERATOR_USERNAME || 'operator',
  operatorPassword: process.env.T02E_SCHOOL_OPERATOR_PASSWORD || '',
}
{
  const missing = Object.entries(CONTRACT).filter(([k, v]) => k.endsWith('Password') && !v).map(([k]) => k)
  if (missing.length) {
    console.error(JSON.stringify({ ok: false, code: 'E_CONTRACT_ENV', message: `T02E 数据契约口令缺失（只经 env 传递）: ${missing.join(', ')}` }))
    process.exit(1)
  }
  const weak = Object.entries(CONTRACT).filter(([k, v]) => k.endsWith('Password') && !(String(v).length >= 8 && /[a-zA-Z]/.test(v) && /[0-9]/.test(v))).map(([k]) => k)
  if (weak.length) {
    console.error(JSON.stringify({ ok: false, code: 'E_CONTRACT_WEAK_PASSWORD', message: `T02E 契约口令强度不足（≥8 位且含字母与数字）: ${weak.join(', ')}` }))
    process.exit(1)
  }
  // 与 /api/user/login 的用户名口径一致（UserManager.validateUserInput：3~50 位字母/数字/下划线）
  const badUsername = Object.entries(CONTRACT).filter(([k, v]) => k.endsWith('Username') && !/^[a-zA-Z0-9_]{3,50}$/.test(String(v))).map(([k]) => k)
  if (badUsername.length) {
    console.error(JSON.stringify({ ok: false, code: 'E_CONTRACT_USERNAME', message: `T02E 契约用户名非法（3~50 位字母/数字/下划线）: ${badUsername.join(', ')}` }))
    process.exit(1)
  }
}

const gate = require(path.join(repoRoot, 'tests/helpers/db-isolation.cjs'))
const provision = require(path.join(repoRoot, 'tests/isolation/provision.cjs'))
const bcryptjs = require(path.join(backendDir, 'node_modules/bcryptjs'))
const { createTenantClient } = await import(path.join(backendDir, 'lib/tenantClient.js'))

const steps = []
const fail = (code, message, detail) => {
  const out = { ok: false, code, message, detail: detail || null, steps }
  if (evidencePath) { fs.mkdirSync(path.dirname(evidencePath), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify(out, null, 2) + '\n') }
  console.error(JSON.stringify(out)), process.exit(1)
}

async function main() {
  const derived = gate.derivedNamespace(runId)
  const { rec } = provision.readOwnership(runId)
  const { user: adminUser, password: adminPassword } = provision.readAdminCredentials(runId)
  const adminUrl = `postgresql://${encodeURIComponent(adminUser)}:${encodeURIComponent(adminPassword)}@127.0.0.1:${rec.port}/${derived.database}`
  const testRoleUrl = `postgresql://${encodeURIComponent(derived.role)}:x@127.0.0.1:${rec.port}/${derived.database}`

  // ── ① public 业务表：**版本化迁移链**（不再 db push / 不再 --accept-data-loss）──
  //   provision.cjs 的 up() 已在"任何 public 预置对象之前"执行 public_migrate_deploy（migration-first）；
  //   这里调用共享前置做**幂等复核**：台账必须逐条 name+checksum 完整，否则 fail-closed（绝不用 resolve 冒充）。
  const { ensurePublicMigrated } = await import('./harness-check/_prepare-migrated-instance.mjs')
  const pub = await ensurePublicMigrated({
    adminUrl,
    cfg: { derived },
    log: (m) => steps.push({ step: 'public_migrate_prep_log', message: String(m).slice(0, 200) }),
  })
  steps.push({ step: 'public_migrate_prep', mode: pub.mode, applied: pub.ledger.applied.length, chainTotal: pub.ledger.chainTotal })

  process.env.DATABASE_URL = adminUrl // 仅本进程内临时指向隔离实例（供 tenantSync 内部使用）
  const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'))
  const { syncAllTenantSchemas } = await import(path.join(backendDir, 'lib/tenantSync.js'))
  const adminPrisma = new PrismaClient({ datasources: { db: { url: adminUrl } } })

  // ── ①c 派生学校行（仅本任务派生 code；public 表由迁移链建立后**长期存在**，此处只做幂等 upsert）──
  await adminPrisma.school.upsert({
    where: { code: derived.tenants.a },
    update: { status: 'active' },
    create: { code: derived.tenants.a, name: `T02C isolated school ${derived.tenants.a}`, status: 'active' },
  })
  steps.push({ step: 'ensure_school_row', code: derived.tenants.a })

  const syncLogs = []
  try {
    await syncAllTenantSchemas(adminPrisma, { skipGenerate: true, log: (m) => syncLogs.push(String(m).slice(0, 200)) })
    steps.push({ step: 'syncAllTenantSchemas', ok: true, logs: syncLogs.slice(-8) })
  } catch (e) {
    fail('E_TENANT_SYNC', 'tenant schema sync failed', { code: e.code || 'UNKNOWN', message: String(e.message).slice(0, 300), logs: syncLogs.slice(-8) })
  }

  // ── ③ 数据契约 seed（T02E）：平台超管（public）+ 派生学校租户内 manager/operator ──
  const schoolRow = await adminPrisma.school.findUnique({ where: { code: derived.tenants.a } })
  if (!schoolRow) fail('E_SCHOOL_MISSING', 'derived school row missing after ensure step')

  // ③a 平台超管（public schema；role=admin 且 school_code=null → 生产仅接受 /api/user/super-admin/login）
  const existingSuper = await adminPrisma.user.findFirst({ where: { username: CONTRACT.superAdminUsername, school_code: null } })
  let superAdmin = existingSuper
  if (!existingSuper) {
    const password_hash = await bcryptjs.hash(CONTRACT.superAdminPassword, 10)
    superAdmin = await adminPrisma.user.create({
      data: { username: CONTRACT.superAdminUsername, password_hash, role: 'admin', status: 'active', school_code: null, must_change_password: false, full_name: 'T02E-CONTRACT platform super admin' },
    })
  }
  steps.push({ step: 'seed_contract_super_admin', username: superAdmin.username, role: superAdmin.role, schoolCode: null, created: !existingSuper })

  // ③b 派生学校租户内 manager/operator（生产不变量 P0-PROV：租户内不得有 role='admin'；本校最高为 manager）
  const tenantClient = createTenantClient(adminPrisma, derived.tenants.a)
  const tenantSeeded = []
  for (const u of [
    { username: CONTRACT.managerUsername, password: CONTRACT.managerPassword, role: 'manager' },
    { username: CONTRACT.operatorUsername, password: CONTRACT.operatorPassword, role: 'operator' },
  ]) {
    const existing = await tenantClient.user.findFirst({ where: { username: u.username } })
    if (existing) {
      await tenantClient.user.update({
        where: { id: existing.id },
        data: { password_hash: await bcryptjs.hash(u.password, 10), role: u.role, status: 'active', must_change_password: false },
      })
      tenantSeeded.push({ username: u.username, role: u.role, created: false, updated: true })
      continue
    }
    const password_hash = await bcryptjs.hash(u.password, 10)
    const created = await tenantClient.user.create({
      data: { username: u.username, password_hash, role: u.role, status: 'active', school_code: derived.tenants.a, must_change_password: false, full_name: 'T02E-CONTRACT school account' },
    })
    tenantSeeded.push({ username: created.username, role: created.role, created: true, id: created.id })
  }
  steps.push({ step: 'seed_contract_tenant_accounts', schoolCode: derived.tenants.a, accounts: tenantSeeded.map((a) => ({ username: a.username, role: a.role, created: a.created })) })

  // ③c 契约自检：口令 hash 必须能通过生产 bcryptjs 校验（防止 seed 与登录口径漂移）
  const seededManager = await tenantClient.user.findFirst({ where: { username: CONTRACT.managerUsername } })
  const seededOperator = await tenantClient.user.findFirst({ where: { username: CONTRACT.operatorUsername } })
  const seededSuper = await adminPrisma.user.findUnique({ where: { username: CONTRACT.superAdminUsername } })
  const hashOk = {
    manager: seededManager ? await bcryptjs.compare(CONTRACT.managerPassword, seededManager.password_hash) : false,
    operator: seededOperator ? await bcryptjs.compare(CONTRACT.operatorPassword, seededOperator.password_hash) : false,
    superAdmin: seededSuper ? await bcryptjs.compare(CONTRACT.superAdminPassword, seededSuper.password_hash) : false,
  }
  steps.push({ step: 'contract_hash_selfcheck', hashOk })
  if (!hashOk.manager || !hashOk.operator || !hashOk.superAdmin) {
    fail('E_CONTRACT_HASH', 'contract password hash self-check failed (seed vs bcryptjs compare)', { hashOk })
  }

  // ── ④ 测试角色：本实例内业务表所需 DML（仅 public；租户 schema 已由 fixture 授权）──
  const grants = []
  const roleIdent = gate.quoteIdent(derived.role)
  for (const sql of [
    `GRANT USAGE ON SCHEMA public TO ${roleIdent}`,
    `GRANT CREATE ON SCHEMA public TO ${roleIdent}`, // 生产回查/吊销路径可能在 public 建临时对象（本实例业务需要；PUBLIC 仍无 CREATE）
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleIdent}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleIdent}`,
  ]) {
    await adminPrisma.$executeRawUnsafe(sql)
    grants.push(sql.replace(/\s+/g, ' ').slice(0, 90))
  }
  // 复核授权（catalog）
  const rolePriv = await adminPrisma.$queryRawUnsafe(
    `SELECT has_table_privilege($1, 'public."TestRecord"', 'INSERT') AS tr_insert,
            has_table_privilege($1, 'public."User"', 'UPDATE') AS user_update,
            has_table_privilege($1, 'public."AuditLog"', 'INSERT') AS audit_insert`,
    derived.role,
  )
  steps.push({ step: 'grants_test_role_public_dml', grants, verified: rolePriv[0] })

  // ── ④b 租户 schema 业务表授权（**必须在 syncAllTenantSchemas 之后**：GRANT ON ALL TABLES 只覆盖当时存在的表）──
  //       契约固化点 = provision.grantPostReplayTenantDml（与 report-auth / 其它 fixture 共用同一实现）。
  const tenantGrants = await provision.grantPostReplayTenantDml({
    query: (sql) => adminPrisma.$executeRawUnsafe(sql),
    role: derived.role,
    schemas: [derived.schemas.a],
    log: (m) => steps.push({ step: 'post_replay_grant_log', message: String(m).slice(0, 160) }),
  })
  const tenantPriv = await adminPrisma.$queryRawUnsafe(
    `SELECT has_table_privilege($1, $2, 'INSERT') AS tr_insert,
            has_table_privilege($1, $2, 'DELETE') AS tr_delete`,
    derived.role, `${derived.schemas.a}."TestRecord"`)
  steps.push({ step: 'grants_test_role_tenant_dml', tenantGrants, verified: tenantPriv[0] })
  if (!tenantPriv[0] || tenantPriv[0].tr_insert !== true || tenantPriv[0].tr_delete !== true) {
    fail('E_TENANT_GRANT', 'tenant business tables are not writable by the test role after sync', { verified: tenantPriv[0] || null })
  }

  // ── ④c ensure **门禁依赖**的最小对象（P3-DB-FIXTURE-R1：迁入 runId 派生的专用 fixture schema）──
  //        · `<fx>.t02a_instance_marker`（测试角色只读；写权限集合必须全 false）
  //        · `<fx>.messages_{a,b,c}`（每租户 slot 一张；测试角色 DML）
  //        旧位置（public / 学校 schema）**不再创建**任何合成 fixture 对象（否则触发
  //        PUBLIC_EXTRA_OBJECTS / TENANT_EXTRA_OBJECTS）；prisma db push 只管理 public，fixture schema 不受影响。
  const adminRoleIdent = gate.quoteIdent(derived.adminRole)
  const roleIdentForMarker = gate.quoteIdent(derived.role)
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
  await adminPrisma.$executeRawUnsafe(`REVOKE ALL ON ${markerIdent} FROM ${roleIdentForMarker}`)
  await adminPrisma.$executeRawUnsafe(`GRANT SELECT ON ${markerIdent} TO ${roleIdentForMarker}`)
  await adminPrisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA ${fxIdent} TO ${roleIdentForMarker}`)
  for (const slot of gate.FIXTURE_CONTRACT.messagesSlots) {
    const tableIdent = gate.quoteQualified(derived.fixtureMessages[slot])
    await adminPrisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ${tableIdent} (id serial PRIMARY KEY, tenant_tag text NOT NULL, body text NOT NULL)`)
    await adminPrisma.$executeRawUnsafe(`ALTER TABLE ${tableIdent} OWNER TO ${adminRoleIdent}`)
    const n = await adminPrisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${tableIdent}`)
    if (n[0].n === 0) {
      await adminPrisma.$executeRawUnsafe(`INSERT INTO ${tableIdent} (tenant_tag, body) VALUES ($1, $2)`, derived.tenants[slot], `data-of-${derived.tenants[slot]}`)
    }
    await adminPrisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableIdent} TO ${roleIdentForMarker}`)
    const seqIdent = gate.quoteQualified(`${derived.fixtureSchema}.${gate.FIXTURE_CONTRACT.messagesTablePrefix}${slot}_id_seq`)
    await adminPrisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON SEQUENCE ${seqIdent} TO ${roleIdentForMarker}`)
  }
  // 门禁 fixture 契约中留在 public 的认证基础设施（public.revoked_tokens）：
  //   P3-FIXTURE-MIGRATED-R1：**本 fixture 不再 DROP / 不再运行时重建**（那是 rc-04 要撤出的运行时 DDL）；
  //   该表由"链上 public migration（窗口 2 之后）"或"provision 前置按运行时形状补齐"建立 →
  //   这里只做**只读核对**：① provision 的运行时 DDL 与产品 authMiddleware 的 DDL 逐字一致；② 实际形状断言。
  {
    // P3-FIXTURE-MIGRATED-R2：事实源 = 链尾 `-- @scope: public` migration（运行时 DDL 已撤出、常量已删除）。
    //   → 只读核对：① 链上 migration 已应用且 checksum 一致；② publicInfraShape.js 的吊销表/三索引形状；
    //   缺失或错形 → 抛 typed error（fixture **不补建/不修复**产品基础设施，也不放宽产品闸门）。
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
  // ── ④d 受限角色真实 DML 自证（P3-FIXTURE-MIGRATED-R1：GRANT 必须在回放后，并以真实 DML 证明）──
  //   通道 = 测试角色连接（TEST_DATABASE_URL）；每条语句真跑，事务内执行并**回滚**（零残留，rowCount 逐条留痕）。
  {
    const testRoleUrlReal = process.env.TEST_DATABASE_URL
    if (!testRoleUrlReal) fail('E_TEST_URL', 'TEST_DATABASE_URL is required for the restricted-role DML self-proof')
    const pubId = `dml-${derived.instanceTag}-pub`
    const tnId = `dml-${derived.instanceTag}-tn`
    const probeClient = provision.createRoleProbeClient({ roleUrl: testRoleUrlReal, applicationName: 't02c-role-dml-probe' })
    await probeClient.connect()
    try {
      const publicProbe = await provision.runRestrictedRoleDmlProbe({
        client: probeClient,
        items: [
          { label: 'public.select', sql: `SELECT count(*)::int AS n FROM public."School"` },
          { label: 'public.insert', sql: `INSERT INTO public."SystemLog" (id, level, message) VALUES ($1, 'info', $2)`, params: [pubId, 't02c restricted-role DML self-proof'] },
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
        subjectUserId: seededManager.id,
        subjectUsername: seededManager.username,
        schoolCode: derived.tenants.a,
        origin: 'event',
      })
      const systemPrincipalIdExpected = auditPrincipalMod.systemPrincipalId(derived.schemas.a)
      if (!principalRow || principalRow.kind !== 'user' || principalRow.subject_user_id !== seededManager.id) {
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
              VALUES ($1, $2, $3, 'fixture-dml-proof', 'TestRecord')`, params: [tnId, seededManager.id, principalRow.id] },
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

  const fixtureObjects = await adminPrisma.$queryRawUnsafe(
    `SELECT n.nspname AS schema, c.relname, r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
     WHERE n.nspname = $1 OR (n.nspname = 'public' AND c.relname = 'revoked_tokens') ORDER BY 1, 2`, derived.fixtureSchema)
  steps.push({ step: 'ensure_fixture_objects', fixtureSchema: derived.fixtureSchema, fixtureObjects })

  const markerCheck = await adminPrisma.$queryRawUnsafe(
    `SELECT r.rolname AS owner, sr.rolname AS schema_owner,
            (SELECT value FROM ${markerIdent} WHERE key = 'instance_tag') AS instance_tag,
            has_table_privilege($1, c.oid, 'INSERT') AS can_insert,
            has_table_privilege($1, c.oid, 'UPDATE') AS can_update,
            has_table_privilege($1, c.oid, 'DELETE') AS can_delete,
            has_table_privilege($1, c.oid, 'TRUNCATE') AS can_truncate
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_roles r ON r.oid = c.relowner
     JOIN pg_roles sr ON sr.oid = n.nspowner
     WHERE n.nspname = $2 AND c.relname = $3`, derived.role, derived.fixtureSchema, gate.FIXTURE_CONTRACT.markerTableName)
  const markerRow = markerCheck[0]
  steps.push({ step: 'ensure_gate_marker', marker: markerRow })
  if (!markerRow || markerRow.owner !== derived.adminRole || markerRow.schema_owner !== derived.adminRole || markerRow.instance_tag !== derived.instanceTag
      || markerRow.can_insert !== false || markerRow.can_update !== false || markerRow.can_delete !== false || markerRow.can_truncate !== false) {
    fail('E_MARKER_REBUILD', 'gate marker ensure did not match the isolation contract', { marker: markerRow || null })
  }

  // 与 T02A/T02B 既有 fixture 兼容：这些 insert 不带时间戳列，需数据库默认值（仅本实例内补齐）
  for (const stmt of [
    `ALTER TABLE public."User" ALTER COLUMN created_at SET DEFAULT now()`,
    `ALTER TABLE public."User" ALTER COLUMN updated_at SET DEFAULT now()`,
    `ALTER TABLE public."School" ALTER COLUMN created_at SET DEFAULT now()`,
    `ALTER TABLE public."School" ALTER COLUMN updated_at SET DEFAULT now()`,
  ]) { await adminPrisma.$executeRawUnsafe(stmt) }
  // 租户 schema 同样需要（root Jest 的 p0 套件按旧 fixture DDL 插入，不带时间戳列）
  for (const tbl of ['User', 'School', 'TestRecord']) {
    for (const col of ['created_at', 'updated_at']) {
      try {
        await adminPrisma.$executeRawUnsafe(`ALTER TABLE "${derived.schemas.a}"."${tbl}" ALTER COLUMN ${col} SET DEFAULT now()`)
      } catch { /* 列或表不存在则跳过（由 Prisma 结构决定） */ }
    }
  }
  // P3-DB-FIXTURE-R1：学校 schema **不再**重建合成 messages（迁移后它们只在 fixture schema；
  // 否则学校 schema 的额外对象会触发 TENANT_EXTRA_OBJECTS 阻断）
  steps.push({
    step: 'no_synthetic_school_tables',
    note: 'synthetic messages live in the runId-derived fixture schema only',
    fixtureSchema: derived.fixtureSchema,
    fixtureMessages: { ...derived.fixtureMessages },
  })

  steps.push({ step: 'timestamp_defaults_for_existing_fixtures', ok: true, tenantSchema: derived.schemas.a })

  // 表与行基线（供 after-check 比对）
  const tables = await adminPrisma.$queryRawUnsafe(
    `SELECT n.nspname AS schema, count(*)::int AS tables FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname IN ('public', $1) GROUP BY n.nspname ORDER BY n.nspname`,
    derived.schemas.a,
  )
  const counts = {
    publicSchool: await adminPrisma.school.count(),
    publicUser: await adminPrisma.user.count(),
    tenantUser: await tenantClient.user.count(),
    tenantTestRecord: await tenantClient.testRecord.count(),
  }
  await tenantClient.$disconnect()
  await adminPrisma.$disconnect()

  const out = {
    ok: true,
    task: 'P3-W0-T02E',
    runId,
    port: rec.port,
    database: derived.database,
    testRole: derived.role,
    adminRole: derived.adminRole,
    schoolCode: derived.tenants.a,
    tenantSchema: derived.schemas.a,
    tablesBySchema: tables,
    counts,
    // T02E 数据契约清单（不含任何口令值；口令只经 env T02E_* 传递）
    contract: {
      passwordSource: 'env(T02E_*_PASSWORD)；仅 env 传递，不落日志',
      publicSuperAdmin: { username: CONTRACT.superAdminUsername, role: 'admin', schoolCode: null, loginRoute: '/api/user/super-admin/login（生产专用路由）' },
      tenantAccounts: tenantSeeded.map((a) => ({ username: a.username, role: a.role, schoolCode: derived.tenants.a, loginRoute: '/api/user/login（显式 schoolCode）' })),
      hashSelfCheck: hashOk,
      notes: [
        '生产不变量 P0-PROV：学校租户内不得出现 role=admin（本校最高为 manager）',
        '生产 NB-04：/api/user/login 必须显式携带合法 schoolCode',
        'provisionSchool 建校的初始 manager 为临时密码（must_change_password=true，首登强制改密）',
      ],
    },
    grants,
    tenantGrants,
    tenantPrivileges: tenantPriv[0],
    rolePrivileges: rolePriv[0],
    gateMarker: markerRow,
    fixtureObjects,
    // P3-FIXTURE-MIGRATED-R2：吊销表形状由链上契约核对（provision.assertRevocationInfraFromChain）；
    //   旧运行时 DDL 时代的 revCols/revOwner 变量已随该路径删除 → 这里改为引用链上核对结果。
    revocationInfra: (steps.find((s) => s.step === 'revocation_infra_from_chain') || null),
    schoolRow: { code: schoolRow.code, status: schoolRow.status },
    testRoleUrlShape: testRoleUrl.replace(/:[^:@/]*@/, ':***@'), // 仅形状，不含口令
    steps,
    generatedAtUtc: new Date().toISOString(),
  }
  if (evidencePath) { fs.mkdirSync(path.dirname(evidencePath), { recursive: true }); fs.writeFileSync(evidencePath, JSON.stringify(out, null, 2) + '\n') }
  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => fail('E_UNKNOWN', String((e && e.message) || e), { code: (e && e.code) || 'UNKNOWN' }))
