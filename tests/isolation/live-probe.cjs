'use strict'
/**
 * P3-W0-T02A-R1 — 真实独占实例验证探针（独立 controller 进程）。
 * 闭合复审 R3/R4：keep/sentinel 基准在**被测清理之前**由 controller 建立；权限拒绝用真实调用证明；
 * 部分成功+清理失败注入；所有失败分支 finally 释放；管理凭据只从 0600 文件读取。
 */
const crypto = require('node:crypto')
const gate = require('../helpers/db-isolation.cjs')
const provision = require('./provision.cjs')
const { Client } = require('pg')

const out = { probe: 'P3-W0-T02A-R1-live', steps: [], checks: {}, errors: [] }
const check = (n, v) => { out.checks[n] = v }

async function adminClient(runId, database) {
  const { rec } = provision.readOwnership(runId)
  const { user, password } = provision.readAdminCredentials(runId)
  const c = new Client({ connectionString: `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${rec.port}/${database}`, application_name: 't02a-live-controller' })
  let mainError = null
  try { await c.connect() } catch (e) { mainError = e }
  if (!mainError) return c
  let releaseError = null
  try { await c.end() } catch (ee) { releaseError = ee } // connect 失败也尝试释放；失败单独保留
  mainError.detail = {
    ...(mainError.detail || {}),
    connectFailed: true,
    releaseAttempted: true,
    releaseError: releaseError ? { code: releaseError.code || 'UNKNOWN', message: String(releaseError.message).slice(0, 120) } : null,
  }
  throw mainError
}
async function snapshot(admin, cfg, keepSchema, keepTable) {
  const s = await admin.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(id::text || ':' || note, ',' ORDER BY id)), 'empty') AS digest FROM ${gate.quoteQualified(cfg.sentinel.schema + '.sentinel_rows')}`)
  const k = await admin.query(`SELECT count(*)::int AS n FROM ${gate.quoteQualified(keepTable)}`)
  const ks = await admin.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, [keepSchema])
  return { sentinel: s.rows[0], keep: k.rows[0], keepSchemaExists: ks.rows[0].n }
}

async function main() {
  const cfg = gate.assertIsolationConfigOrThrow(process.env)
  out.runId = cfg.runId
  out.steps.push('config_accepted')
  check('no_admin_credentials_in_test_env', process.env.ADMIN_PASSWORD === undefined && process.env.ADMIN_USER === undefined)
  check('no_foreign_database_url_in_test_env', process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === cfg.url)

  let adminPostgres = null
  let adminDb = null
  const releaseErrors = []
  let client = null
  try {
    adminPostgres = await adminClient(cfg.runId, 'postgres')
    adminDb = await adminClient(cfg.runId, cfg.database) // 若此处失败，finally 仍会 end 已创建的 adminPostgres
    // controller 前置：keep 对象 + 基准（均在清理之前）
    const keepSchema = `t02a_keep_${cfg.runId}_${crypto.randomBytes(3).toString('hex')}`
    const keepTable = `${keepSchema}.keep_rows`
    check('keep_absent_before_create', (await adminDb.query(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`, [keepSchema])).rows[0].n === 0)
    await adminDb.query(`CREATE SCHEMA ${gate.quoteIdent(keepSchema)}`)
    await adminDb.query(`CREATE TABLE ${gate.quoteIdent(keepSchema)}.keep_rows (id serial PRIMARY KEY, note text NOT NULL)`)
    await adminDb.query(`INSERT INTO ${gate.quoteIdent(keepSchema)}.keep_rows (note) VALUES ('keep-before-cleanup')`)
    out.before = await snapshot(adminDb, cfg, keepSchema, keepTable)
    out.steps.push('controller_created_keep_and_before_baseline')

    // 受限角色受控连接 + 核验
    const conn = await gate.connectGuarded(cfg, { Client, expectedSchema: 'public' })
    client = conn.client
    out.identity = conn.verified.identity
    out.marker = conn.verified.marker
    check('marker_readonly_proven_by_catalog', conn.verified.marker.canInsert === false)
    check('identity_schema_is_public', conn.verified.identity.schema === 'public')
    const role = (await client.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0]
    check('role_attrs_all_false', Object.values(role).every((v) => v === false))
    check('no_role_membership', (await client.query(`SELECT count(*)::int AS n FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`)).rows[0].n === 0)

    // 真实权限拒绝
    const denied = async (sql, params = []) => { try { await client.query(sql, params); return null } catch (e) { return e.code || 'UNKNOWN' } }
    out.denials = {
      marker_insert: await denied(`INSERT INTO ${gate.quoteQualified(cfg.markerTable)} (key, value) VALUES ('tamper', 'x')`),
      marker_update: await denied(`UPDATE ${gate.quoteQualified(cfg.markerTable)} SET value = 'tamper' WHERE key = 'instance_tag'`),
      sentinel_update: await denied(`UPDATE ${gate.quoteQualified(cfg.sentinel.schema + '.sentinel_rows')} SET note = 'tamper' WHERE id = 1`),
      schema_create: await denied(`CREATE SCHEMA t02a_should_fail_${cfg.runId}`),
      table_create_public: await denied(`CREATE TABLE public.t02a_should_fail_${cfg.runId} (id int)`),
    }
    check('marker_write_denied', out.denials.marker_insert !== null && out.denials.marker_update !== null)
    check('sentinel_write_denied', out.denials.sentinel_update !== null)
    check('schema_create_denied', out.denials.schema_create !== null)
    check('table_create_in_public_denied', out.denials.table_create_public !== null)

    // ── 跨库：**同一正确测试凭据**，只改变数据库名（目标库已由本连接正对照证明可连）──
    const testUrl = new URL(process.env.TEST_DATABASE_URL)
    const testPassword = decodeURIComponent(testUrl.password)
    const crossUrl = new URL(testUrl.toString())
    crossUrl.pathname = '/postgres'
    let crossCode = null
    const cross = new Client({ connectionString: crossUrl.toString(), connectionTimeoutMillis: 5000, application_name: 't02a-cross-db-probe' })
    let crossReleaseError = null
    try { await cross.connect(); crossCode = 'CONNECTED' } catch (e) { crossCode = (e && e.code) || 'THROWN' }
    try { await cross.end() } catch (e) { crossReleaseError = (e && e.code) || 'UNKNOWN' }
    out.crossDatabase = { sameRole: true, samePassword: true, onlyDatabaseChanged: true, refusalCode: crossCode, releaseError: crossReleaseError }
    check('cross_db_release_clean', crossReleaseError === null)
    // 必须是明确的授权拒绝（42501）；28xxx/ECONNREFUSED/超时不能代替
    check('cross_database_denied_42501', crossCode === '42501')

    // ── 冒用管理员（**另一测**：测试角色的正确密码 + 管理员用户名，同一 host/port/db）──
    let impostorCode = null
    const impostor = new Client({
      connectionString: `postgresql://${encodeURIComponent(cfg.adminRole)}:${encodeURIComponent(testPassword)}@${cfg.host}:${cfg.port}/${cfg.database}`,
      connectionTimeoutMillis: 5000, application_name: 't02a-admin-impersonation-probe',
    })
    let impostorReleaseError = null
    try { await impostor.connect(); impostorCode = 'CONNECTED' } catch (e) { impostorCode = (e && e.code) || 'THROWN' }
    try { await impostor.end() } catch (e) { impostorReleaseError = (e && e.code) || 'UNKNOWN' }
    out.adminImpersonation = { authRefusalCode: impostorCode, releaseError: impostorReleaseError }
    check('admin_impersonation_release_clean', impostorReleaseError === null)
    check('admin_impersonation_auth_denied', impostorCode === '28P01' || impostorCode === '28000')

    // ── marker 写权限集合适配：controller 临时授予 UPDATE → 门禁必须拒绝 → 撤销 → 恢复通过 ──
    let markerInjection = { granted: false, refused: false, revoked: false, restored: false }
    try {
      await adminDb.query(`GRANT UPDATE ON ${gate.quoteQualified(cfg.markerTable)} TO ${gate.quoteIdent(cfg.role)}`)
      markerInjection.granted = true
      let refusedCode = null
      try { await gate.connectGuarded(cfg, { Client, expectedSchema: 'public' }); refusedCode = 'NO_REFUSAL' } catch (e) { refusedCode = (e && e.code) || 'THROWN' }
      markerInjection.refused = refusedCode === gate.CODES.MARKER_MISMATCH
      markerInjection.refusalCode = refusedCode
    } finally {
      try { await adminDb.query(`REVOKE UPDATE ON ${gate.quoteQualified(cfg.markerTable)} FROM ${gate.quoteIdent(cfg.role)}`); markerInjection.revoked = true } catch { /* recorded below */ }
      try { const again = await gate.connectGuarded(cfg, { Client, expectedSchema: 'public' }); markerInjection.restored = again.verified.ok === true; try { await again.client.end() } catch { /* ignore */ } } catch { markerInjection.restored = false }
    }
    out.markerWriteInjection = markerInjection
    check('marker_update_injection_refused', markerInjection.refused)
    check('marker_write_grant_revoked_and_restored', markerInjection.revoked && markerInjection.restored)

    // ── P3-DB-FIXTURE-R1（R7 CLOSE-B B1）：产物 schema 不再含合成 fixture 对象；fixture schema 是唯一位置 ──
    const regclass = async (qname) => (await adminDb.query('SELECT to_regclass($1)::text AS t', [qname])).rows[0].t
    const fixtureFacts = {
      publicMessages: await regclass('public.messages'),
      publicMarker: await regclass('public.t02a_instance_marker'),
      schoolMessages: await regclass(`${cfg.schemas.a}.messages`),
      fixtureMarker: await regclass(cfg.markerTable),
      fixtureMessagesA: await regclass(cfg.fixtureMessages.a),
      fixtureMessagesB: await regclass(cfg.fixtureMessages.b),
      fixtureMessagesC: await regclass(cfg.fixtureMessages.c),
    }
    out.fixtureFacts = fixtureFacts
    check('public_messages_absent', fixtureFacts.publicMessages === null)
    check('public_marker_absent', fixtureFacts.publicMarker === null)
    check('school_messages_absent', fixtureFacts.schoolMessages === null)
    check('fixture_marker_present', fixtureFacts.fixtureMarker !== null)
    check('fixture_messages_present', fixtureFacts.fixtureMessagesA !== null && fixtureFacts.fixtureMessagesB !== null && fixtureFacts.fixtureMessagesC !== null)
    // 哨兵不变：独立 owner、与 fixture schema 分离（不可写性由前文 deny 检查证明）
    const sentinelOwnerRows = (await adminDb.query('SELECT r.rolname AS owner FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1', [cfg.sentinel.schema])).rows
    check('sentinel_owner_separate', sentinelOwnerRows.length === 1 && sentinelOwnerRows[0].owner === cfg.sentinel.owner
      && cfg.sentinel.owner !== cfg.adminRole && cfg.sentinel.schema !== cfg.fixtureSchema)

    // ── argv 无秘密证明（provisioner 在真实 spawn 边界记录）──
    const argvRecord = (() => { try { return JSON.parse(require('node:fs').readFileSync(require('node:path').join(provision.taskRoot(cfg.runId), 'psql-argv.json'), 'utf8')) } catch { return null } })()
    out.psqlArgvAudit = argvRecord
    check('psql_argv_has_no_secret', !!argvRecord && argvRecord.argvContainsSecret === false && argvRecord.argv.every((x) => !x.includes(testPassword) && !x.includes('://')))

    // 正常路径：登记行清理（fixture schema 的 slot-a messages —— P3-DB-FIXTURE-R1 后的唯一可写测试表）
    const fxMessages = cfg.fixtureMessages.a
    const registry = gate.createRegistry(cfg)
    const tag = `probe-${cfg.runId}`
    await client.query(`INSERT INTO ${gate.quoteQualified(fxMessages)} (tenant_tag, body) VALUES ($1, 'probe')`, [tag])
    registry.addTaskRow({ qname: fxMessages, keyColumn: 'tenant_tag', keyValue: tag })
    const cleaned = await gate.cleanupRegistered(client, registry)
    const left = (await client.query(`SELECT count(*)::int AS n FROM ${gate.quoteQualified(fxMessages)} WHERE tenant_tag = $1`, [tag])).rows[0].n
    check('registered_row_cleaned', cleaned.cleaned === 1 && left === 0)

    // 结构化登记负例
    const reg2 = gate.createRegistry(cfg)
    let rejectedScope = false
    let rejectedCol = false
    let rejectedKey = false
    try { reg2.addTaskRow({ qname: 'public.revoked_tokens', keyColumn: 'jti', keyValue: tag }) } catch (e) { rejectedScope = e.code === gate.CODES.REGISTRY_REJECTED }
    try { reg2.addTaskRow({ qname: fxMessages, keyColumn: 'reason', keyValue: tag }) } catch (e) { rejectedCol = e.code === gate.CODES.REGISTRY_REJECTED }
    try { reg2.addTaskRow({ qname: fxMessages, keyColumn: 'tenant_tag', keyValue: 'not-this-run' }) } catch (e) { rejectedKey = e.code === gate.CODES.REGISTRY_REJECTED }
    check('registry_rejects_out_of_scope', rejectedScope)
    check('registry_rejects_unknown_column', rejectedCol)
    check('registry_rejects_foreign_row_key', rejectedKey)

    // 部分成功 + 清理失败注入（真实登记两项；仅第二项的删除被注入失败）
    const tagOk = `probe-partial-ok-${cfg.runId}-${crypto.randomBytes(2).toString('hex')}`
    const tagFail = `probe-partial-fail-${cfg.runId}-${crypto.randomBytes(2).toString('hex')}`
    await client.query(`INSERT INTO ${gate.quoteQualified(fxMessages)} (tenant_tag, body) VALUES ($1, 'probe'), ($2, 'probe')`, [tagOk, tagFail])
    const registryPartial = gate.createRegistry(cfg)
    registryPartial.addTaskRow({ qname: fxMessages, keyColumn: 'tenant_tag', keyValue: tagOk })
    registryPartial.addTaskRow({ qname: fxMessages, keyColumn: 'tenant_tag', keyValue: tagFail })
    const failingClient = {
      async query(sql, params) {
        if (Array.isArray(params) && params[0] === tagFail) { const e = new Error('injected delete failure'); e.code = '42703'; throw e }
        return client.query(sql, params)
      },
    }
    let agg = null
    try { await gate.cleanupRegistered(failingClient, registryPartial) } catch (e) { agg = e }
    check('partial_cleanup_failure_nonzero', agg !== null && agg.code === 'CLEANUP_FAILED' && Array.isArray(agg.cleanupErrors) && agg.cleanupErrors.length === 1)
    out.cleanupFailure = agg ? { code: agg.code, errors: agg.cleanupErrors } : null
    const okLeft = (await client.query(`SELECT count(*)::int AS n FROM ${gate.quoteQualified(fxMessages)} WHERE tenant_tag = $1`, [tagOk])).rows[0].n
    const failLeft = (await client.query(`SELECT count(*)::int AS n FROM ${gate.quoteQualified(fxMessages)} WHERE tenant_tag = $1`, [tagFail])).rows[0].n
    out.partialRows = { okRowRemaining: okLeft, failedRowRemaining: failLeft }
    check('successful_registered_row_cleaned', okLeft === 0)
    check('failed_row_kept_for_manual_handling', failLeft === 1)
    // controller（人工处置）：清理注入失败留下的行
    await adminDb.query(`DELETE FROM ${gate.quoteQualified(fxMessages)} WHERE tenant_tag = $1`, [tagFail])
    out.controllerManualCleanup = { deletedFailedRow: true }

    // after 基准：sentinel 与 keep 必须不变（controller 在清理后重读）
    await client.end(); client = null
    out.after = await snapshot(adminDb, cfg, keepSchema, keepTable)
    check('sentinel_unchanged', out.before.sentinel.n === out.after.sentinel.n && out.before.sentinel.digest === out.after.sentinel.digest)
    check('keep_object_preserved', out.before.keep.n === out.after.keep.n && out.after.keepSchemaExists === 1)
    out.steps.push('done')
  } catch (e) {
    out.errors.push({ step: 'fatal', code: (e && e.code) || 'UNKNOWN', message: String(e && e.message).slice(0, 200) })
  } finally {
    // 所有失败分支可靠释放：逐项尝试，错误分别记录（不跳过、不覆盖）
    for (const [name, c] of [['client', client], ['adminDb', adminDb], ['adminPostgres', adminPostgres]]) {
      if (!c) continue
      try { await c.end() } catch (e) { releaseErrors.push({ name, code: (e && e.code) || 'UNKNOWN', message: String((e && e.message) || '').slice(0, 120) }) }
    }
    out.releaseErrors = releaseErrors
    check('no_release_errors', releaseErrors.length === 0)
  }
  out.ok = Object.values(out.checks).every((v) => v === true) && out.errors.length === 0 && (out.releaseErrors || []).length === 0
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.ok ? 0 : 1)
}

main().catch((e) => {
  out.ok = false
  out.errors.push({ step: 'main', code: (e && e.code) || 'UNKNOWN', message: String(e && e.message).slice(0, 200) })
  console.log(JSON.stringify(out, null, 2))
  process.exit(1)
})
