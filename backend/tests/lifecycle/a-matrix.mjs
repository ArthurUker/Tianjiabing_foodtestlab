// P3-LIFECYCLE-AB-R3 · Release A 定点矩阵（自有隔离实例；真实 PG）
//
// 环境：
//   TEST_DATABASE_URL  测试角色连接串（scratch 实例）
//   ADMIN_DATABASE_URL 管理连接串（建 schema / 回放链 / DDL 断言）
//   EVIDENCE_DIR       证据目录（写 JSON 结果）
//
// 覆盖（PLAN_A_R2 §3 映射）：
//   A-0 链口径（15 文件、M1 紧随 follow-up 链尾、@scope 标注、台账 chain_digest）
//   A-P1 空库：全链回放 → nullable/CHECK NOT VALID/系统主体/FK SET NULL+RESTRICT
//   A-P2 旧库：14 链 + 历史审计行 → 滚动只回放 M1 → 行数不变、旧 NULL 保留、删用户不删审计
//   A-P3 强门禁：INSERT/UPDATE 无 principal 被拒（含回填旧时间）；写门面人类/系统/username-only
//   A-P4 读双来源：user_id 为 NULL + principal 锚点仍可筛出
//   A-P5 软删除 + epoch 同事务（public.revoked_tokens）+ 禁复活（UserManager 真调用）
//   A-G  grant 身份：缺失/错配/世代过期/孤儿 fail-closed + 就地隔离 + 硬删撤授权 + 恢复不继承 + 重授恢复
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import {
  listMigrationFiles, migrationChainDigest, applyTenantChain, parseDbUrl,
} from '../../lib/tenantProvisioner.js'
import { writeTenantAuditLog } from '../../lib/auditLog.js'
import { classifyGrantIdentity, quarantineGrant, GRANT_IDENTITY_CODES } from '../../lib/openApiGrantIdentity.js'
import { UserManager } from '../../modules/UserManager.js'
import { schemaNameOf } from '../../lib/tenantClient.js'

const TEST_URL = process.env.TEST_DATABASE_URL
const ADMIN_URL = process.env.ADMIN_DATABASE_URL
const EV = process.env.EVIDENCE_DIR
if (!TEST_URL || !ADMIN_URL || !EV) {
  console.error('缺少 TEST_DATABASE_URL / ADMIN_DATABASE_URL / EVIDENCE_DIR')
  process.exit(2)
}

const results = []
const rec = (id, ok, detail, extra = null) => {
  results.push({ id, ok: !!ok, detail, ...(extra ? { extra } : {}) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const tenantCodeFresh = process.env.LIFE_TENANT_FRESH || 'ab-fresh'
const tenantCodeOld = process.env.LIFE_TENANT_OLD || 'ab-old'
const schemaFresh = schemaNameOf(tenantCodeFresh)
const schemaOld = schemaNameOf(tenantCodeOld)
const testRole = new URL(TEST_URL.replace('postgresql://', 'http://')).username
const withSchema = (url, schema) => `${url}${url.includes('?') ? '&' : '?'}schema=${schema}`

const adminPrisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
const tenantFreshDb = new PrismaClient({ datasources: { db: { url: withSchema(ADMIN_URL, schemaFresh) } } })
const tenantOldDb = new PrismaClient({ datasources: { db: { url: withSchema(ADMIN_URL, schemaOld) } } })
const conn = parseDbUrl(ADMIN_URL)
if (!conn.password) {
  conn.password = decodeURIComponent(new URL(ADMIN_URL.replace('postgresql://', 'http://')).password || '')
}

const q = (client, sql, ...params) => client.$queryRawUnsafe(sql, ...params)
const x = (client, sql, ...params) => client.$executeRawUnsafe(sql, ...params)
async function prepSchema(schema) {
  // 幂等重跑：先清空本包专用的两个 schema（仅本实例、非产品库）
  await x(adminPrisma, `DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await x(adminPrisma, `CREATE SCHEMA "${schema}"`)
}
async function grantDml(schema) {
  await x(adminPrisma, `GRANT USAGE ON SCHEMA "${schema}" TO "${testRole}"`)
  await x(adminPrisma, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${testRole}"`)
  await x(adminPrisma, `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${testRole}"`)
}

const allFiles = listMigrationFiles()
const m1Name = '20260927130000_lifecycle_audit_principal_expand'
const m2Name = '20260927140000_lifecycle_audit_principal_enforce'
const preFiles = allFiles.filter((f) => f.name < m1Name)
// Release A 的链 = 截止 M1（15 文件）；M2 属 Release B（本矩阵不得应用）
const aChain = allFiles.filter((f) => f.name <= m1Name)
const digestNow = migrationChainDigest() // 当前（含 M2）产品算法值
const digestA = (() => { // A 期（15 文件）产品算法值——供登记对照，不作为当前台账预期
  const h = crypto.createHash('sha256')
  for (const f of aChain) h.update(`${f.name}\0${fs.readFileSync(f.file)}\n`)
  return h.digest('hex')
})()

const main = async () => {
  // ── A-0 链口径 ─────────────────────────────────────────────────────────────────────
  rec('A-0.1', aChain.length === 15 && aChain[14].name === m1Name, `A 链（截止 M1）文件数=${aChain.length}，新增=${aChain[14]?.name}`)
  rec('A-0.2', aChain[13].name === '20260927120000_public_infra_field_option_self_fk', `M1 紧随 follow-up 链尾（前一个=${aChain[13].name}）`)
  rec('A-0.4', allFiles.length === 16 && allFiles[15].name === m2Name, `M2（B 期）紧随 M1：${allFiles[15]?.name}（A 矩阵不应用）`)
  const m1Sql = fs.readFileSync(path.join(process.cwd(), 'backend/prisma/migrations', m1Name, 'migration.sql'), 'utf8')
  rec('A-0.3', /^--\s*@scope:\s*both\s*$/m.test(m1Sql), 'M1 声明 @scope: both')

  // ── A-P1 空库全链回放 ────────────────────────────────────────────────────────────────
  await prepSchema(schemaFresh)
  const r1 = await applyTenantChain({ prisma: adminPrisma, conn, schema: schemaFresh, chainFiles: aChain, log: () => {} })
  await grantDml(schemaFresh)
  // 15 文件 = 12 租户相关（applied）+ 3 个 @scope: public（逐租户整条跳过 skipped_public_only）
  rec('A-P1.0', (r1.status === 'applied' || r1.status === 'upgraded') && r1.applied.length === 12 && r1.skippedPublicOnly.length === 3,
    `空库回放（A 链）applied=${r1.applied.length} + skippedPublicOnly=${r1.skippedPublicOnly.length} = 15 status=${r1.status}`, { failed: r1.failed })

  const cols = await q(adminPrisma, `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='AuditLog' AND column_name IN ('user_id','principal_id','actor_snapshot')`, schemaFresh)
  const colMap = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]))
  rec('A-P1.1', colMap.user_id === 'YES' && colMap.principal_id === 'YES' && colMap.actor_snapshot === 'YES', `AuditLog 三列可空（user_id=${colMap.user_id} principal_id=${colMap.principal_id} actor_snapshot=${colMap.actor_snapshot}）`)

  const check = await q(adminPrisma, `SELECT conname, convalidated, contype FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND c.conname='AuditLog_principal_id_required_new'`, schemaFresh)
  rec('A-P1.2', check.length === 1 && check[0].contype === 'c' && check[0].convalidated === false, `CHECK 存在且 NOT VALID（convalidated=${check[0]?.convalidated}）`)

  const fk = await q(adminPrisma, `SELECT conname, confdeltype FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND conname IN ('AuditLog_user_id_fkey','AuditLog_principal_id_fkey') ORDER BY conname`, schemaFresh)
  const fkMap = Object.fromEntries(fk.map((r) => [r.conname, r.confdeltype]))
  rec('A-P1.3', fkMap.AuditLog_user_id_fkey === 'n' && fkMap.AuditLog_principal_id_fkey === 'r', `FK：user_id=${fkMap.AuditLog_user_id_fkey}(n=SET NULL) principal_id=${fkMap.AuditLog_principal_id_fkey}(r=RESTRICT)`)

  const sysRows = await q(adminPrisma, `SELECT id, kind, scope_key, subject_user_id FROM "${schemaFresh}"."AuditPrincipal" WHERE kind='system'`)
  rec('A-P1.4', sysRows.length === 1 && sysRows[0].scope_key === schemaFresh && sysRows[0].subject_user_id === 'system', `系统主体恰 1 行（scope_key=${sysRows[0]?.scope_key}）`)

  const idx = await q(adminPrisma, `SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='AuditPrincipal'`, schemaFresh)
  const idxNames = idx.map((u) => u.indexname)
  rec('A-P1.5', idxNames.includes('AuditPrincipal_scope_key_subject_user_id_key') && idxNames.includes('AuditPrincipal_subject_user_id_idx'), `AuditPrincipal 复合唯一+索引：${idxNames.length} 个`)

  const ledger1 = await q(adminPrisma, `SELECT migration_name, status, chain_digest FROM "${schemaFresh}"."_tenant_migrations" WHERE migration_name=$1`, m1Name)
  rec('A-P1.6', ledger1.length === 1 && ledger1[0].chain_digest === digestNow,
    `台账 M1 行 chain_digest == 引擎当时产品算法（${String(ledger1[0]?.chain_digest).slice(0, 12)}…）；A 期 15 文件值与当前 16 文件值均已登记`)

  // ── A-P2 旧库（14 链）→ 滚动只回放 M1 ────────────────────────────────────────────────
  await prepSchema(schemaOld)
  const r2 = await applyTenantChain({ prisma: adminPrisma, conn, schema: schemaOld, chainFiles: preFiles, log: () => {} })
  await grantDml(schemaOld)
  // 14 = 11 租户相关（applied）+ 3 个 @scope: public（逐租户跳过）
  rec('A-P2.0', (r2.status === 'applied' || r2.status === 'upgraded') && r2.applied.length === 11 && r2.skippedPublicOnly.length === 3, `旧库先回放 14 链 applied=${r2.applied.length} + skipped=${r2.skippedPublicOnly.length}`)

  const mkUser = (id, name) => x(adminPrisma, `INSERT INTO "${schemaOld}"."User" (id, username, password_hash, role, status, created_at, updated_at) VALUES ($1,$2,'x','operator','active',now(),now())`, id, name)
  await mkUser('u-hist-1', 'hist1'); await mkUser('u-hist-2', 'hist2'); await mkUser('u-hist-3', 'hist3')
  const mkAudit = (id, uid, action) => x(adminPrisma, `INSERT INTO "${schemaOld}"."AuditLog" (id, user_id, action, created_at) VALUES ($1,$2,$3,now())`, id, uid, action)
  await mkAudit('al-1', 'u-hist-1', 'login'); await mkAudit('al-2', 'u-hist-2', 'export'); await mkAudit('al-3', 'u-hist-1', 'create')
  const before = await q(adminPrisma, `SELECT count(*)::int AS n FROM "${schemaOld}"."AuditLog"`)

  const r2b = await applyTenantChain({ prisma: adminPrisma, conn, schema: schemaOld, chainFiles: aChain, log: () => {} })
  await grantDml(schemaOld)
  const after = await q(adminPrisma, `SELECT count(*)::int AS n, count(principal_id)::int AS with_p FROM "${schemaOld}"."AuditLog"`)
  rec('A-P2.1', r2b.applied.length === 1 && r2b.applied[0] === m1Name, `滚动仅应用 M1：${JSON.stringify(r2b.applied)}`)
  rec('A-P2.2', before[0].n === after[0].n && after[0].n === 3 && after[0].with_p === 0, `历史行数不变（${before[0].n}→${after[0].n}），存量 principal 仍全 NULL（NOT VALID 不校验）`)

  const fkOld = await q(adminPrisma, `SELECT confdeltype FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND conname='AuditLog_user_id_fkey'`, schemaOld)
  rec('A-P2.3', fkOld[0]?.confdeltype === 'n', `M1 后 user_id FK=SET NULL（confdeltype=${fkOld[0]?.confdeltype}）`)

  // A-P2.4a（实测交互，写实登记）：回填前直接删"有 NULL principal 审计行"的用户 →
  //   FK SET NULL 的内部 UPDATE 触发 CHECK → **删除被拒**（fail-safe：宁拒绝、不丢审计）。
  let delBlocked = { rejected: false, code: null }
  try { await x(adminPrisma, `DELETE FROM "${schemaOld}"."User" WHERE id='u-hist-2'`) }
  catch (e) { delBlocked = { rejected: true, code: String(e?.meta?.code || e.message).slice(0, 60) } }
  const stillThere = await q(adminPrisma, `SELECT count(*)::int AS n FROM "${schemaOld}"."AuditLog"`)
  rec('A-P2.4a', delBlocked.rejected && delBlocked.code.includes('23514') && stillThere[0].n === 3,
    `回填前删用户被 CHECK 拒绝（fail-safe，审计零丢失）：${delBlocked.code}`)

  // A-P2.4b：先按主体绑定该用户的行（模拟 004 回填）→ 再删 → 审计保留、user_id→NULL（级联销毁解除的终态）
  const pidHist2 = `principal:${(await import('node:crypto')).createHash('sha256').update(`${schemaOld}\0u-hist-2`).digest('hex').slice(0, 32)}`
  await x(adminPrisma, `INSERT INTO "${schemaOld}"."AuditPrincipal" (id,kind,scope_key,school_code,subject_user_id,subject_username,created_at,origin,observed_at)
    VALUES ($1,'user',$2,NULL,'u-hist-2','hist2',now(),'backfilled',now()) ON CONFLICT DO NOTHING`, pidHist2, schemaOld)
  await x(adminPrisma, `UPDATE "${schemaOld}"."AuditLog" SET principal_id=$1 WHERE id='al-2'`, pidHist2)
  let delOk2 = true, delErr2 = null
  try { await x(adminPrisma, `DELETE FROM "${schemaOld}"."User" WHERE id='u-hist-2'`) } catch (e) { delOk2 = false; delErr2 = e.message }
  const afterDel = await q(adminPrisma, `SELECT count(*)::int AS n, count(user_id)::int AS with_user FROM "${schemaOld}"."AuditLog"`)
  const orphan = await q(adminPrisma, `SELECT user_id, principal_id FROM "${schemaOld}"."AuditLog" WHERE id='al-2'`)
  rec('A-P2.4b', delOk2 && afterDel[0].n === 3 && afterDel[0].with_user === 2 && orphan[0].user_id === null && orphan[0].principal_id === pidHist2,
    `回填后删用户：审计保留（3 行）、al-2.user_id→NULL、主体锚点保留${delErr2 ? ' err=' + delErr2 : ''}`)

  // ── A-P3 强门禁 ────────────────────────────────────────────────────────────────────
  let gateInsert = { rejected: false, code: null }
  try { await x(adminPrisma, `INSERT INTO "${schemaOld}"."AuditLog" (id, user_id, action, created_at) VALUES ('al-gate', 'u-hist-1', 'login', '2020-01-01T00:00:00Z')`) }
  catch (e) { gateInsert = { rejected: true, code: String(e?.meta?.code || e.message).slice(0, 80) } }
  rec('A-P3.1', gateInsert.rejected && gateInsert.code.includes('23514'), `INSERT 无 principal 被拒（回填旧时间无法绕过）：${gateInsert.code}`)

  let gateUpdate = { rejected: false, code: null }
  try { await x(adminPrisma, `UPDATE "${schemaOld}"."AuditLog" SET action='touched' WHERE id='al-1'`) }
  catch (e) { gateUpdate = { rejected: true, code: String(e?.meta?.code || e.message).slice(0, 80) } }
  rec('A-P3.2', gateUpdate.rejected && gateUpdate.code.includes('23514'), `UPDATE 旧行不补 principal 被拒：${gateUpdate.code}`)

  const sysPid = `system-principal:${schemaOld}`
  const pidHist1 = `principal:${(await import('node:crypto')).createHash('sha256').update(`${schemaOld}\0u-hist-1`).digest('hex').slice(0, 32)}`
  await x(adminPrisma, `INSERT INTO "${schemaOld}"."AuditPrincipal" (id,kind,scope_key,school_code,subject_user_id,subject_username,created_at,origin,observed_at)
    VALUES ($1,'user',$2,NULL,'u-hist-1','hist1',now(),'backfilled',now()) ON CONFLICT DO NOTHING`, pidHist1, schemaOld)
  let okUpdate = true
  try { await x(adminPrisma, `UPDATE "${schemaOld}"."AuditLog" SET principal_id=$1 WHERE id='al-1'`, pidHist1) } catch { okUpdate = false }
  rec('A-P3.3', okUpdate, '旧行补（人类）principal 后 UPDATE 合法（门禁只拦缺主体）')

  const humanRow = await writeTenantAuditLog(tenantOldDb, { actorId: 'u-hist-1', action: 'login', actor: { username: 'hist1', role: 'operator', schoolCode: tenantCodeOld } })
  rec('A-P3.4', !!humanRow.principal_id && humanRow.actor_snapshot?.subject_user_id === 'u-hist-1', `写门面人类事件：principal=${String(humanRow.principal_id).slice(0, 18)}… snapshot.subject=${humanRow.actor_snapshot?.subject_user_id}`)

  const systemRow = await writeTenantAuditLog(tenantOldDb, { actorId: null, action: 'export' })
  rec('A-P3.5', systemRow.principal_id === sysPid, `写门面系统事件（无主体无快照）→ 系统 principal：${systemRow.principal_id}`)

  let usernameOnly = { threw: false, code: null }
  try { await writeTenantAuditLog(tenantOldDb, { actorId: null, action: 'login', actor: { username: 'ghost-no-id' } }) }
  catch (e) { usernameOnly = { threw: true, code: e.code } }
  rec('A-P3.6', usernameOnly.threw && usernameOnly.code === 'AUDIT_PRINCIPAL_SUBJECT_UNPROVABLE', `R9：username-only 写门面显式拒绝（${usernameOnly.code}）`)

  // ── A-P4 读双来源 ──────────────────────────────────────────────────────────────────
  await x(adminPrisma, `UPDATE "${schemaOld}"."AuditLog" SET user_id=NULL WHERE id=(SELECT id FROM "${schemaOld}"."AuditLog" WHERE principal_id=(SELECT id FROM "${schemaOld}"."AuditPrincipal" WHERE subject_user_id='u-hist-1' LIMIT 1) LIMIT 1)`)
  const dual = await q(adminPrisma, `SELECT count(*)::int AS n FROM "${schemaOld}"."AuditLog" WHERE user_id='u-hist-1' OR principal_id=(SELECT id FROM "${schemaOld}"."AuditPrincipal" WHERE subject_user_id='u-hist-1' LIMIT 1)`)
  const single = await q(adminPrisma, `SELECT count(*)::int AS n FROM "${schemaOld}"."AuditLog" WHERE user_id='u-hist-1'`)
  rec('A-P4.1', dual[0].n > single[0].n, `双来源命中 ${dual[0].n} 行 > 单列 ${single[0].n} 行（user_id=NULL 的历史行可见）`)

  // ── A-P5 软删除 + epoch 同事务 + 禁复活 ─────────────────────────────────────────────
  await mkUser('u-del-target', 'del-target')
  const um = new UserManager(adminPrisma, 'test-secret').forTenant(tenantCodeOld)
  let delOk = true, delErr = null
  try { await um.deleteUser('u-del-target', { userId: 'u-hist-3', username: 'hist3', role: 'admin' }) }
  catch (e) { delOk = false; delErr = e.message }
  const delRow = await q(adminPrisma, `SELECT status, disabled_reason, deleted_at, deleted_by FROM "${schemaOld}"."User" WHERE id='u-del-target'`)
  const epochRow = await q(adminPrisma, `SELECT jti, reason FROM public.revoked_tokens WHERE jti=$1`, 'user_epoch:u-del-target')
  rec('A-P5.1', delOk && delRow[0]?.status === 'disabled' && delRow[0]?.deleted_at != null && delRow[0]?.deleted_by === 'u-hist-3', `软删除落位（status=${delRow[0]?.status} deleted_by=${delRow[0]?.deleted_by}）${delErr ? ' err=' + delErr : ''}`)
  rec('A-P5.2', epochRow.length === 1 && epochRow[0].reason === 'user_delete', `epoch 与软删同事务（public.revoked_tokens jti=user_epoch:u-del-target）`)

  let revive = { rejected: false, code: null }
  try { await um.enableUser('u-del-target', { userId: 'u-hist-3' }) }
  catch (e) { revive = { rejected: true, code: e.status || e.statusCode || 'ERR' } }
  const still = await q(adminPrisma, `SELECT deleted_at FROM "${schemaOld}"."User" WHERE id='u-del-target'`)
  rec('A-P5.3', revive.rejected && still[0]?.deleted_at != null, `禁复活：enableUser 被拒（${revive.code}）且 deleted_at 保持`)

  // ── A-G grant 身份 ────────────────────────────────────────────────────────────────
  const schoolX = await adminPrisma.school.create({ data: { code: `ab-life-${Date.now().toString(36)}`, name: '生命周期A校', status: 'active' } })
  const client = await adminPrisma.openApiClient.create({ data: { id: `ab-life-client-${Date.now().toString(36)}`, name: 'A 矩阵对接方', status: 'active', rate_limit_per_min: 6000 } })
  const mkGrant = (schoolCode, idn) => adminPrisma.openApiGrant.create({ data: { client_id: client.id, school_code: schoolCode, status: 'active', scope_version: 1, ...idn } })
  const gGood = await mkGrant(schoolX.code, { school_id: schoolX.id, school_generation: schoolX.generation })
  const gMissing = await mkGrant(`${schoolX.code}-m`, {})
  const gStale = await mkGrant(`${schoolX.code}-s`, { school_id: schoolX.id, school_generation: 99 })
  const gMis = await mkGrant(`${schoolX.code}-x`, { school_id: 'other-school-id', school_generation: schoolX.generation })

  const vGood = classifyGrantIdentity(gGood, schoolX)
  const vMissing = classifyGrantIdentity(gMissing, schoolX)
  const vStale = classifyGrantIdentity(gStale, schoolX)
  const vMis = classifyGrantIdentity(gMis, schoolX)
  const vOrphan = classifyGrantIdentity(gGood, null)
  rec('A-G.1', vGood.ok === true, '身份一致 grant 放行')
  rec('A-G.2', vMissing.code === GRANT_IDENTITY_CODES.MISSING && vStale.code === GRANT_IDENTITY_CODES.STALE && vMis.code === GRANT_IDENTITY_CODES.MISMATCH && vOrphan.code === GRANT_IDENTITY_CODES.ORPHAN,
    `四类 fail-closed：${vMissing.code}/${vStale.code}/${vMis.code}/${vOrphan.code}`)

  const q1 = await quarantineGrant(adminPrisma, gMissing, GRANT_IDENTITY_CODES.MISSING, 'matrix')
  const gMissingAfter = await adminPrisma.openApiGrant.findUnique({ where: { id: gMissing.id } })
  rec('A-G.3', q1.quarantined && gMissingAfter.status === 'disabled' && gMissingAfter.scope_version === 2 && String(gMissingAfter.revoked_reason).startsWith('GRANT_IDENTITY_MISSING'),
    `就地隔离：status=${gMissingAfter.status} scope_version=${gMissingAfter.scope_version} reason=${gMissingAfter.revoked_reason}`)

  await x(adminPrisma, `UPDATE public."OpenApiGrant" SET status='disabled', revoked_at=now(), revoked_reason='school_hard_delete', scope_version=scope_version+1 WHERE school_code=$1 AND status <> 'disabled'`, schoolX.code)
  const gGoodAfter = await adminPrisma.openApiGrant.findUnique({ where: { id: gGood.id } })
  rec('A-G.4', gGoodAfter.status === 'disabled' && gGoodAfter.revoked_reason === 'school_hard_delete', `硬删撤授权（同 SQL 语义）：${gGoodAfter.status}/${gGoodAfter.revoked_reason}`)

  const restored = await adminPrisma.school.update({ where: { id: schoolX.id }, data: { generation: schoolX.generation + 1 } })
  const vAfterRestore = classifyGrantIdentity(gGoodAfter, restored)
  rec('A-G.5', vAfterRestore.code === GRANT_IDENTITY_CODES.STALE, `恢复（generation+1）后旧 grant 仍 fail-closed：${vAfterRestore.code}`)
  const regranted = await adminPrisma.openApiGrant.update({ where: { id: gGood.id }, data: { status: 'active', school_generation: restored.generation, revoked_at: null, revoked_reason: null } })
  rec('A-G.6', classifyGrantIdentity(regranted, restored).ok === true, '显式重授（刷新 generation）后恢复放行')

  // ── 汇总 ───────────────────────────────────────────────────────────────────────────
  const summary = {
    task: 'P3-LIFECYCLE-AB-R3', stage: 'A', at: new Date().toISOString(), digestNow, digestA, aChainFiles: aChain.length,
    schemas: { [tenantCodeFresh]: schemaFresh, [tenantCodeOld]: schemaOld },
    total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length,
    results,
  }
  fs.writeFileSync(path.join(EV, 'A-matrix.json'), JSON.stringify(summary, null, 2))
  console.log(`\nA 矩阵：${summary.pass}/${summary.total} PASS`)
  await adminPrisma.$disconnect(); await tenantFreshDb.$disconnect(); await tenantOldDb.$disconnect()
  process.exit(summary.fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('A 矩阵崩溃:', e)
  fs.writeFileSync(path.join(EV, 'A-matrix.json'), JSON.stringify({ task: 'P3-LIFECYCLE-AB-R3', stage: 'A', crash: String((e && e.stack) || e), results }, null, 2))
  try { await adminPrisma.$disconnect(); await tenantFreshDb.$disconnect(); await tenantOldDb.$disconnect() } catch { /* noop */ }
  process.exit(3)
})
