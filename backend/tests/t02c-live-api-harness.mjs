// P3-W0-T02C/T02E 专用 live-api harness（backend/tests/ 本包新建；不是测试）。
//
// 职责：在**本任务独占实例**上用**任务自有回环端口**拉起真实后端，运行 `tests/integration/live-api.mjs`，
//       跑完停止后端并核验端口释放；随后以管理身份做**脚本数据 SQL 清理**与 **after-check**；全过程落盘。
//
// 边界（总控口径）：BASE_URL 只允许指向本任务后端（回环 + 本 harness 指定端口）；
//   学校 code 一律取 provisioner 派生值；不使用任何默认端口（3002/5432 均不出现）；
//   T02E 数据契约口令只经 env 透传给 live-api（缺失即 fail-closed），绝不写日志/证据。
// 并行通告（T02E）：P3-CONS-T01 可能正在编辑 openApiRoutes.js —— 若后端启动/健康检查失败，
//   保留原始启动日志（*.attempt1）原样重试一次；绝不修改/还原对方文件。
//
// 用法：node backend/tests/t02c-live-api-harness.mjs <runId> <port> <evidenceDir>
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// P3-FIXTURE-MIGRATED-R2：吊销表形状事实源 = 产品只读契约（链尾 migration ⟷ 该契约同形）
import { revokedTokensShapeIssues } from '../lib/publicInfraShape.js'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(here, '..')
const repoRoot = path.resolve(backendDir, '..')

const runId = process.argv[2]
const port = Number(process.argv[3])
const evidenceDir = process.argv[4]
if (!runId || !Number.isInteger(port) || !evidenceDir) {
  console.error(JSON.stringify({ ok: false, code: 'E_ARG', message: 'usage: node t02c-live-api-harness.mjs <runId> <port> <evidenceDir>' }))
  process.exit(1)
}
fs.mkdirSync(evidenceDir, { recursive: true })
const out = { ok: false, runId, port, steps: [] }

const gate = require(path.join(repoRoot, 'tests/helpers/db-isolation.cjs'))
const provision = require(path.join(repoRoot, 'tests/isolation/provision.cjs'))
// P3-HARNESS-CHECK-R1：真实 server 前置 = 已迁移实例 + 默认 check（public migrate deploy → 租户链回放 → --check）
const { prepareMigratedInstance } = await import('./harness-check/_prepare-migrated-instance.mjs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const portIsFree = () => new Promise((resolve) => {
  const srv = net.createServer()
  srv.once('error', () => resolve(false))
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
})
const writeEvidence = () => fs.writeFileSync(path.join(evidenceDir, 'live-api-harness.json'), JSON.stringify(out, null, 2) + '\n')

// ===== P3-W0-T02E 数据契约 env（与 t02c-instance-fixture.mjs 同一套；口令只经 env 透传，不落日志）=====
const CONTRACT_ENV_KEYS = [
  'T02E_SUPER_ADMIN_PASSWORD',
  'T02E_SCHOOL_MANAGER_PASSWORD',
  'T02E_SCHOOL_OPERATOR_PASSWORD',
  'T02E_DYN_SCHOOL_ADMIN_PASSWORD',
  'T02E_DYN_SCHOOL_NEW_PASSWORD',
]
const contractEnv = {}
for (const k of CONTRACT_ENV_KEYS) {
  if (!process.env[k]) {
    console.error(JSON.stringify({ ok: false, code: 'E_CONTRACT_ENV', message: `missing ${k}（数据契约口令只经 env 传递；由外层 shell 生成并同批传给 fixture 与 harness）` }))
    process.exit(1)
  }
  contractEnv[k] = process.env[k]
}
const CONTRACT_USER_ENV = {
  T02E_SUPER_ADMIN_USERNAME: process.env.T02E_SUPER_ADMIN_USERNAME || 'admin',
  T02E_SCHOOL_MANAGER_USERNAME: process.env.T02E_SCHOOL_MANAGER_USERNAME || 'manager',
  T02E_SCHOOL_OPERATOR_USERNAME: process.env.T02E_SCHOOL_OPERATOR_USERNAME || 'operator',
}

// 动态学校 code 推导（必须与 live-api.mjs 完全一致）
const dynSchoolOf = (tenantCode) => process.env.T02C_DYN_SCHOOL_CODE || `dyn${tenantCode.replace(/[^a-z0-9]/gi, '').slice(-12)}`

/** 清理"脚本产生"的数据：动态学校（schema + public 行）。幂等，可作预清理与收尾清理复用。 */
async function cleanScriptData(adminPrisma, { dynSchool, dynSchema }) {
    const actions = []
    await adminPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${dynSchema}" CASCADE`)
    actions.push({ action: 'drop_schema_if_exists', schema: dynSchema })
    const delCustom = await adminPrisma.$executeRawUnsafe(`DELETE FROM public."SchoolCustomization" WHERE school_code = $1`, dynSchool)
    if (delCustom) actions.push({ action: 'delete_school_customization', schoolCode: dynSchool, rows: delCustom })
    const delSchool = await adminPrisma.$executeRawUnsafe(`DELETE FROM public."School" WHERE code = $1`, dynSchool)
    if (delSchool) actions.push({ action: 'delete_school_row', schoolCode: dynSchool, rows: delSchool })
    return actions
}

async function main() {
  const derived = gate.derivedNamespace(runId)
  const { rec } = provision.readOwnership(runId)
  const { user: adminUser, password: adminPassword } = provision.readAdminCredentials(runId)
  const adminUrl = `postgresql://${encodeURIComponent(adminUser)}:${encodeURIComponent(adminPassword)}@127.0.0.1:${rec.port}/${derived.database}`

  if (!(await portIsFree())) { out.code = 'E_PORT_BUSY'; out.message = `port ${port} is not free`; writeEvidence(); process.exit(1) }
  out.steps.push({ step: 'port_free_before_start', port, free: true })

  // ⓪ 预清理：清除上一轮可能残留的脚本数据（动态学校），保证本轮从「仅契约占位」状态开始。
  //    （幂等；契约占位数据——派生学校/契约账号/门禁对象——不受影响。）
  const dynSchool = dynSchoolOf(derived.tenants.a)
  const dynSchema = `school_${dynSchool}`
  {
    const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'))
    const prePrisma = new PrismaClient({ datasources: { db: { url: adminUrl } } })
    out.preClean = { dynSchool, dynSchema, actions: await cleanScriptData(prePrisma, { dynSchool, dynSchema }) }
    out.steps.push({ step: 'pre_clean', actions: out.preClean.actions.length })
    await prePrisma.$disconnect()
  }

  // ① P3-HARNESS-CHECK-R1：把自有实例推进到「已迁移 + 默认 check 可放行」（幂等；失败 fail-closed，不启动后端）。
  //    public：prisma migrate deploy（禁止 db push / resolve / accept-data-loss）；租户：版本化链回放 + --check rc=0。
  try {
    const cfgRes = gate.checkIsolationConfig({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_DB_CONTEXT_FILE: process.env.TEST_DB_CONTEXT_FILE })
    if (!cfgRes.ok) throw Object.assign(new Error(`[PREP] 隔离配置不合法：${cfgRes.code} ${cfgRes.reason}`), { code: cfgRes.code })
    const prep = await prepareMigratedInstance({ adminUrl, cfg: cfgRes.cfg, log: (m) => out.steps.push({ step: 'migration_prep_log', message: String(m).slice(0, 200) }) })
    out.migrationPrep = { publicMode: prep.public.mode, parked: prep.public.parked, tenantCheckRc: prep.tenant.checkRc, steps: [...prep.public.steps, ...prep.tenant.steps] }
    out.steps.push({ step: 'migration_prep', publicMode: prep.public.mode, tenantCheckRc: prep.tenant.checkRc })
  } catch (e) {
    out.code = 'E_MIGRATION_PREP_FAILED'
    out.error = String((e && e.message) || e)
    out.migrationPrep = { code: (e && e.code) || null, detail: (e && e.detail) || null }
    out.steps.push({ step: 'migration_prep_failed', code: (e && e.code) || null, message: out.error.slice(0, 300) })
    writeEvidence()
    console.error(JSON.stringify({ ok: false, code: out.code, error: out.error }))
    process.exit(1)
  }

  // ② 以隔离实例（管理身份 = 该实例身份）启动真实后端，端口由本任务指定。
  //    并行通告：健康/就绪检查失败 → 保留原始启动日志（*.attempt1）原样重试一次。
  const jwtSecret = require('node:crypto').randomBytes(32).toString('hex')
  const spawnBackend = (logPath) => {
    const fd = fs.openSync(logPath, 'w')
    const child = spawn(process.execPath, ['server.js'], {
      cwd: backendDir,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        NODE_ENV: 'test', PORT: String(port), JWT_SECRET: jwtSecret,
        DATABASE_URL: adminUrl,
        T02C_ISOLATED_INSTANCE: derived.instanceTag,
        // P3-HARNESS-CHECK-R1（溯源）：不再使用 AUTO_SYNC_TENANTS=false 绕过——
        // 前置已把实例推进到迁移链尾（prepareMigratedInstance），此处走**默认 check**：
        // 启动只读检测通过后 readiness=200，租户业务 API 方可放行（false 会同时 503，已不作为测试前提）。
        // 不设置 attestation / db push / accept-data-loss。
      },
      stdio: ['ignore', fd, fd],
    })
    return { child, fd }
  }
  // P3-HARNESS-CHECK-R1：就绪 = liveness(200) ∧ readiness(readyz=200)。
  // 默认 check 下 readyz 200 才表示「public 迁移 + 逐租户台账/结构 + 额外对象」全部通过（无 attestation 放行）。
  const waitHealthy = async () => {
    let lastReadiness = null
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`)
        if (res.status === 200) {
          const rz = await fetch(`http://127.0.0.1:${port}/api/readyz`)
          let body = null
          try { body = await rz.json() } catch { /* 非 JSON */ }
          lastReadiness = { health: 200, readyz: rz.status, body }
          out.readiness = lastReadiness
          if (rz.status === 200) return true
        }
      } catch { /* not up yet */ }
      await sleep(500)
    }
    out.readiness = lastReadiness || { health: null, readyz: null, body: null }
    return false
  }

  const serverLogPath = path.join(evidenceDir, 'live-api-backend-server.log')
  let spawned = spawnBackend(serverLogPath)
  let server = spawned.child
  out.steps.push({ step: 'backend_spawned', pid: server.pid, port, attempt: 1 })

  let healthy = await waitHealthy()
  out.steps.push({ step: 'health_check', healthy, attempt: 1 })
  if (!healthy) {
    // 保留原始启动日志（并行通告要求的"原样重试一次"）
    try { fs.closeSync(spawned.fd) } catch { /* ignore */ }
    const attempt1Path = `${serverLogPath}.attempt1`
    try { fs.renameSync(serverLogPath, attempt1Path) } catch { /* ignore */ }
    const tail = (fs.existsSync(attempt1Path) ? fs.readFileSync(attempt1Path, 'utf8') : '').slice(-600)
    out.steps.push({ step: 'backend_first_attempt_preserved', log: path.basename(attempt1Path), tail })
    await (async () => { try { server.kill('SIGTERM') } catch { /* already gone */ } })()
    await sleep(1000)
    if (!(await portIsFree())) await sleep(2000)

    spawned = spawnBackend(serverLogPath)
    server = spawned.child
    out.steps.push({ step: 'backend_spawned', pid: server.pid, port, attempt: 2 })
    healthy = await waitHealthy()
    out.steps.push({ step: 'health_check', healthy, attempt: 2 })
  }
  if (!healthy) { out.code = 'E_BACKEND_NOT_HEALTHY'; out.error = 'backend did not become healthy+ready (2 attempts; first attempt log preserved)' }

  // P3-HARNESS-CHECK-R1：显式断言目标租户业务 API 可达（默认 check 放行；未认证 → 401，绝不是 503 迁移阻断）。
  if (healthy) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/test-records?schoolCode=${encodeURIComponent(derived.tenants.a)}`)
      let body = null
      try { body = await probe.json() } catch { /* 非 JSON */ }
      out.tenantReachability = { status: probe.status, code: body?.code || null }
      out.steps.push({ step: 'tenant_api_reachability', status: probe.status, code: body?.code || null })
      if (probe.status === 503 || body?.code === 'TENANT_MIGRATION_NOT_READY' || body?.code === 'TENANT_SCHEMA_NOT_READY') {
        out.code = 'E_TENANT_API_BLOCKED'
        out.error = `默认 check 下目标租户业务 API 仍被迁移闸门阻断（status=${probe.status} code=${body?.code}）`
      }
    } catch (e) {
      out.tenantReachability = { error: String((e && e.message) || e) }
    }
  }

  let stopServer = async () => {
    try { server.kill('SIGTERM') } catch { /* already gone */ }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) break
      await sleep(200)
    }
    if (server.exitCode === null && server.signalCode !== null) { /* stopped by signal */ }
    if (server.exitCode === null && server.signalCode === null) { try { server.kill('SIGKILL') } catch { /* ignore */ } ; await sleep(500) }
  }

  try {
    if (!healthy) throw new Error('backend did not become healthy+ready(readyz)')
    if (out.code === 'E_TENANT_API_BLOCKED') throw new Error(out.error)

    // ② 运行 live-api（BASE_URL 只指向本任务后端；学校 code 取派生值；T02E 契约 env 透传，不落日志）
    const live = spawnSync(process.execPath, [path.join(repoRoot, 'tests/integration/live-api.mjs')], {
      cwd: repoRoot, encoding: 'utf8', timeout: 600000,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        T02C_BASE_URL: `http://127.0.0.1:${port}`,
        T02C_SCHOOL_CODE: derived.tenants.a,
        ...CONTRACT_ENV_KEYS.reduce((acc, k) => ({ ...acc, [k]: contractEnv[k] }), {}),
        ...CONTRACT_USER_ENV,
      },
    })
    const liveOut = `${live.stdout || ''}\n${live.stderr || ''}`
    fs.writeFileSync(path.join(evidenceDir, 'live-api-run.log'), liveOut)
    const summary = /通过 (\d+) \/ 失败 (\d+)/.exec(liveOut)
    // R17/B-3：解析脚本输出的**该脚本自建测试用户**指纹与删除/墓碑断言（精确用户，非宽泛白名单）
    const tsMatch = /^T02C_TEST_USER=(\{.*\})$/m.exec(liveOut)
    out.tsUser = tsMatch ? JSON.parse(tsMatch[1]) : null
    out.liveApi = { rc: live.status, pass: summary ? Number(summary[1]) : null, fail: summary ? Number(summary[2]) : null, refused: /T02C-LIVE-API-REFUSED/.test(liveOut), testUser: out.tsUser }
    out.steps.push({ step: 'live_api_run', rc: live.status, pass: out.liveApi.pass, fail: out.liveApi.fail })
    out.steps.push({ step: 'live_api_test_user', username: out.tsUser ? out.tsUser.username : null, deleteStatus: out.tsUser ? out.tsUser.deleteStatus : null, oldTokenStatus: out.tsUser ? out.tsUser.oldTokenStatus : null, newLoginStatus: out.tsUser ? out.tsUser.newLoginStatus : null })
  } catch (e) {
    out.error = String((e && e.message) || e)
  } finally {
    // ③ 停止后端 + 核验端口释放
    await stopServer()
    let released = false
    for (let i = 0; i < 20; i += 1) { if (await portIsFree()) { released = true; break } await sleep(250) }
    out.steps.push({ step: 'backend_stopped', exitCode: server.exitCode, signal: server.signalCode, portReleased: released })
    out.backendStopped = true
    out.portReleased = released
    fs.closeSync(spawned.fd)
  }

  // ④ 脚本数据 SQL 清理 + after-check（管理身份；仅指向本实例库）
  try {
    const { PrismaClient } = require(path.join(backendDir, 'node_modules/@prisma/client'))
    const adminPrisma = new PrismaClient({ datasources: { db: { url: adminUrl } } })
    const cleanup = await cleanScriptData(adminPrisma, { dynSchool, dynSchema })
    out.cleanup = { dynSchool, dynSchema, actions: cleanup }
    out.steps.push({ step: 'script_data_cleanup', actions: cleanup.length })

    // 参数一律显式 ::text 标注（PG 42P18）；无参查询不得传 undefined（会被当作 $1 → 42P18）
    // P3-FIXTURE-MIGRATED-R2 修：Prisma 的 `$queryRawUnsafe(sql, x)` 只绑定**一个**参数——
    //   既有调用形如 q(sql, a, b)（两个标量）也有 q(sql, [a, b])（数组）→ 统一摊平后再展开；
    //   无参查询不得传 undefined/[]（会被当作 $1 → 42P18）。
    const q = async (sql, ...params) => {
      const flat = (params.length === 1 && Array.isArray(params[0])) ? params[0] : params
      return flat.length === 0 ? adminPrisma.$queryRawUnsafe(sql) : adminPrisma.$queryRawUnsafe(sql, ...flat)
    }
    const publicSchools = await q(`SELECT code, status FROM public."School" ORDER BY code`)
    const publicUsers = await q(`SELECT id, username, role, school_code FROM public."User" ORDER BY username`)
    const tenantUsers = await q(`SELECT username, role, school_code, must_change_password, status, deleted_at FROM "${derived.schemas.a}"."User" ORDER BY username`)
    const tenantRecords = await q(`SELECT count(*)::int AS n FROM "${derived.schemas.a}"."TestRecord"`)
    const publicRecords = await q(`SELECT count(*)::int AS n FROM public."TestRecord"`)
    const publicAuditLogs = await q(`SELECT count(*)::int AS n FROM public."AuditLog"`)
    // public 面的审计只允许"平台登录审计"（生产语义：平台超管登录审计落 public；租户登录审计落租户 schema），
    // 不得出现业务数据写入类审计（create/update/delete 等）。
    const publicAuditNonLogin = await q(`SELECT count(*)::int AS n FROM public."AuditLog" WHERE action <> 'login'`)
    const dynSchemaLeft = await q(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1::text`, dynSchema)
    // P3-DB-FIXTURE-R1：marker/messages 位于 runId 派生的 fixture schema（不再在 public / 学校 schema）
    const marker = await q(`SELECT (SELECT value FROM ${gate.quoteQualified(derived.markerTable)} WHERE key='instance_tag') AS instance_tag,
                                   (SELECT r.rolname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
                                     WHERE n.nspname=$1::text AND c.relname=$2::text) AS owner`, derived.fixtureSchema, gate.FIXTURE_CONTRACT.markerTableName)
    // P3-FIXTURE-MIGRATED-R2：吊销表=链上 migration 产物（不再由 fixture 删表重建）
    const revOwner = await q(`SELECT r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
                               WHERE n.nspname='public' AND c.relname='revoked_tokens'`)
    const revChain = await q(`SELECT migration_name, finished_at IS NOT NULL AS finished, checksum
                                FROM public."_prisma_migrations"
                               WHERE migration_name LIKE '%public_infra_revoked_tokens'`)
    const revShapeErrors = await revokedTokensShapeIssues(adminPrisma)
    const fixtureMessages = await q(`SELECT count(*)::int AS n FROM ${gate.quoteQualified(derived.fixtureMessages.a)}`)
    const legacyAbsent = await q(`SELECT to_regclass('public.messages')::text AS public_messages,
                                         to_regclass('public.t02a_instance_marker')::text AS public_marker,
                                         to_regclass($1::text)::text AS school_messages`, `${derived.schemas.a}.messages`)

    const contractPublicUser = String(process.env.T02E_SUPER_ADMIN_USERNAME || 'admin')
    const contractManager = String(process.env.T02E_SCHOOL_MANAGER_USERNAME || 'manager')
    const contractOperator = String(process.env.T02E_SCHOOL_OPERATOR_USERNAME || 'operator')
    const checks = {
      // 契约：public 面 = 平台超管（role=admin、school_code=null）+（当 T02B root fixture 先跑时）
      //   **恰一个身份可核验的控制器平台管理行**（id/username 由 runId 派生：t02b-<runId>-platform-admin）。
      //   非宽泛放行：任何其它额外用户仍判红。
      publicUsersOnlyPlatformSuperAdmin: (() => {
        const controllerAdminId = `t02b-${out.runId}-platform-admin`
        const isContract = (u) => u.username === contractPublicUser && u.role === 'admin' && u.school_code === null
        const isControllerFixtureRow = (u) => u.id === controllerAdminId && u.role === 'admin' && u.school_code === null
        const others = publicUsers.filter((u) => !isContract(u) && !isControllerFixtureRow(u))
        const hasContract = publicUsers.some(isContract)
        const controllerRows = publicUsers.filter(isControllerFixtureRow).length
        return hasContract && controllerRows <= 1 && others.length === 0
      })(),
      // 契约占位：public."School" 仅剩派生学校（脚本动态学校已清理）
      publicSchoolsOnlyDerived: publicSchools.length === 1 && publicSchools[0].code === derived.tenants.a && publicSchools[0].status === 'active',
      // R17/B-3：租户内 = 两个**有效**契约账号（active、无改密标记）+ **恰一条**本脚本测试用户的软删除墓碑
      //   （status=disabled、deleted_at 非空；DELETE=200、旧 token 401、新登录 401/403）——不物理清除、不宽泛放行。
      tenantUsersOnlyContract: (() => {
        const active = tenantUsers.filter((u) => u.status === 'active' && u.deleted_at === null)
        const contractOnly = active.length === 2 && active.every((u) => [contractManager, contractOperator].includes(u.username) && u.must_change_password === false)
        const ts = out.tsUser
        const tomb = ts && ts.username ? tenantUsers.filter((u) => u.username === ts.username) : []
        const tombOk = !!ts && !!ts.username && tomb.length === 1 && tomb[0].status === 'disabled' && tomb[0].deleted_at !== null
          && ts.deleteStatus === 200 && ts.oldTokenStatus === 401 && [401, 403].includes(ts.newLoginStatus)
        return tenantUsers.length === 3 && contractOnly && tombOk
      })(),
      // 脚本数据已清理：租户记录 0
      tenantRecordsZero: tenantRecords[0].n === 0,
      // 无越库写入：public 检测记录 0；public 审计仅平台登录类（无业务写入）
      publicRecordsZero: publicRecords[0].n === 0,
      publicAuditLogLoginOnly: publicAuditNonLogin[0].n === 0,
      // 脚本动态建校已清理
      dynSchemaAbsent: dynSchemaLeft[0].n === 0,
      // 门禁/fixture 对象未被脚本破坏（P3-DB-FIXTURE-R1：位于 fixture schema）
      gateMarkerIntact: marker[0].instance_tag === derived.instanceTag && marker[0].owner === derived.adminRole,
      // 链上契约：migration 已应用 + 形状合规 + 属主为实例管理角色（非测试角色）
      revocationInfraFromChain: revChain.length === 1 && revChain[0].finished === true
        && revShapeErrors.length === 0
        && !!revOwner[0] && revOwner[0].owner === derived.adminRole && revOwner[0].owner !== derived.role,
      fixtureMessagesIntact: fixtureMessages[0].n >= 1,
      // 产物 schema（public / 学校）不得再出现合成 fixture 对象
      syntheticObjectsAbsentFromProductSchemas: legacyAbsent[0].public_messages === null && legacyAbsent[0].public_marker === null && legacyAbsent[0].school_messages === null,
    }
    out.afterCheck = {
      revocationInfra: { migration: revChain, shapeIssues: revShapeErrors, owner: revOwner[0] ? revOwner[0].owner : null, expectedOwner: derived.adminRole },
      tombstone: (() => {
        const ts = out.tsUser
        const row = ts && ts.username ? tenantUsers.find((u) => u.username === ts.username) : null
        return { testUser: ts, row: row ? { username: row.username, status: row.status, deleted_at: row.deleted_at } : null, semantics: 'lifecycle soft-delete tombstone (M1): disabled + deleted_at；不物理删除、不宽泛放行' }
      })(),
      publicSchools, publicUsers, tenantUsers,
      counts: { tenantTestRecord: tenantRecords[0].n, publicTestRecord: publicRecords[0].n, publicAuditLog: publicAuditLogs[0].n, publicAuditLogNonLogin: publicAuditNonLogin[0].n, fixtureMessages: fixtureMessages[0].n },
      dynSchema, checks,
      contractVsScript: {
        contractPlaceholders: ['public 平台超管账号', `public."School" 派生学校 ${derived.tenants.a}`, `租户 ${derived.schemas.a} 内 manager/operator 契约账号`, '门禁对象（marker/messages/revoked_tokens）'],
        scriptDataRemoved: [`动态学校 ${dynSchool}（schema=${dynSchema} + public."School"/SchoolCustomization 行）`, '脚本创建的检测记录（API 清理）', '脚本注册的测试用户（API 清理）'],
      },
    }
    out.steps.push({ step: 'after_check', checks })
    await adminPrisma.$disconnect()
    out.afterCheckOk = Object.values(checks).every(Boolean)
    fs.writeFileSync(path.join(evidenceDir, 'after-check.json'), JSON.stringify(out.afterCheck, null, 2) + '\n')
  } catch (e) {
    out.afterCheckError = String((e && e.message) || e)
    out.steps.push({ step: 'after_check_error', error: out.afterCheckError.slice(0, 200) })
  }

  out.ok = out.backendStopped === true && out.portReleased === true && !!out.liveApi && out.liveApi.refused === false
      && !!out.liveApi.pass && out.liveApi.fail === 0 && out.afterCheckOk === true
      // P3-HARNESS-CHECK-R1：默认 check 就绪（readyz=200）且目标租户 API 未被迁移闸门阻断
      && out.readiness?.readyz === 200 && out.code !== 'E_TENANT_API_BLOCKED' && !out.code
  writeEvidence()
  console.log(JSON.stringify({ ok: out.ok, liveApi: out.liveApi || null, portReleased: out.portReleased, afterCheckOk: out.afterCheckOk === true, steps: out.steps.map((s) => s.step) }, null, 2))
  process.exit(out.ok ? 0 : 1)
}

main().catch((e) => { out.code = 'E_UNKNOWN'; out.error = String((e && e.message) || e); writeEvidence(); console.error(JSON.stringify(out)); process.exit(1) })
