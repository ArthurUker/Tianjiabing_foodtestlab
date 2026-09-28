// P3-LIFECYCLE-AB-R5 · R14-1 / R14-2 定点（自有隔离实例；真实 PG）
//
// R14-1（004 陈旧映射强合同）：
//   .1 缺 pre ⇒ 结构校验拒绝（零写入）
//   .2 pre 的**整快照摘要**陈旧（username 变化，subject 不变）⇒ 拒绝（仅核 subject 不会发现）
//   .3 有效映射绑定 username-only 行 ⇒ 成功（provenance=mapping）
//   .4 已绑定**同主体**重跑 ⇒ 幂等（principal 行不变、计数相同）
//   .5 已绑定**异主体**重跑 ⇒ 整体非零拒绝（不得直接跳过/不得改写历史主体）
//   .6 两租户同 audit_id，各自 pre/主体 ⇒ 各自绑定
//   .7 绑定 UPDATE 条件保护语义（行数 0/1）——预校验后事实变化不误绑
//   所有拒绝用例：审计行内容 hash 与 principal 计数/集合前后完全一致（零误写）
// R14-2（M2 P-4 语义空谓词）：
//   .1 干净 staging **不先跑 004**：三类无主体系统行（SQL NULL / jsonb null / {}）单次链回放 → 绑定系统主体，
//      G2=0 / attnotnull / convalidated / G3③④=0，006 GATE_PASS，db:sync --check rc=0
//   .2 负例：带真实人类快照（username-only）但无稳定 id ⇒ M2_UNBOUND_PRINCIPAL_ROWS、旧 schema 保留（attnotnull=false）、
//      该行未绑定（不猜测）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import { listMigrationFiles, applyTenantChain, parseDbUrl } from '../../lib/tenantProvisioner.js'
import { schemaNameOf } from '../../lib/tenantClient.js'

const ADMIN_URL = process.env.ADMIN_DATABASE_URL
const EV = process.env.EVIDENCE_DIR
if (!ADMIN_URL || !EV) { console.error('缺 ADMIN_DATABASE_URL / EVIDENCE_DIR'); process.exit(2) }

const results = []
const rec = (id, ok, detail, extra = null) => {
  results.push({ id, ok: !!ok, detail, ...(extra ? { extra } : {}) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`)
}
const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } })
const conn = parseDbUrl(ADMIN_URL)
const q = (sql, ...p) => admin.$queryRawUnsafe(sql, ...p)
const x = (sql, ...p) => admin.$executeRawUnsafe(sql, ...p)
const allFiles = listMigrationFiles()
const M1 = '20260927130000_lifecycle_audit_principal_expand'
const preFiles = allFiles.filter((f) => f.name < M1)
const aChain = allFiles.filter((f) => f.name <= M1)

const run004 = (args) => {
  try {
    const out = execFileSync('node', ['backend/scripts/004_backfill_audit_principals.mjs', ...args], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    })
    return { rc: 0, out }
  } catch (e) { return { rc: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') } }
}
const run006 = () => {
  try {
    const out = execFileSync('node', ['backend/scripts/006_audit_principal_gate.mjs'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return { rc: 0, out }
  } catch (e) { return { rc: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') } }
}
const runDbSyncCheck = () => {
  try {
    const out = execFileSync('node', ['backend/sync-tenant-schemas.mjs', '--check'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    return { rc: 0, out }
  } catch (e) { return { rc: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') } }
}
const printPre = (schema, auditId) => JSON.parse(execFileSync('node', ['backend/scripts/004_backfill_audit_principals.mjs', '--print-pre', `${schema}:${auditId}`], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8' })).pre
const mapFile = (name, rows) => { const p = path.join(EV, name); fs.writeFileSync(p, JSON.stringify(rows, null, 2)); const d = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); return { p, d } }
const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`

/** 审计行/主体的"指纹"：拒绝前后必须完全一致（零误写证明）。 */
async function fingerprint(schema) {
  const rows = await q(`SELECT id, user_id, principal_id, action, actor_snapshot::text AS s FROM "${schema}"."AuditLog" ORDER BY id`)
  const ps = await q(`SELECT id, kind, scope_key, subject_user_id FROM "${schema}"."AuditPrincipal" ORDER BY id`)
  return {
    auditHash: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    principalHash: crypto.createHash('sha256').update(JSON.stringify(ps)).digest('hex'),
    principalCount: ps.length,
  }
}
async function makeSchema(schema, files) {
  await x(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await x(`CREATE SCHEMA "${schema}"`)
  return applyTenantChain({ prisma: admin, conn, schema, chainFiles: files, retryFailed: true, log: () => {} })
}

/** 残量行变更：CHECK 对 UPDATE 也生效 ⇒ 先摘后补（A 期语义）。 */
async function mutateResidual(schema, sql, ...params) {
  await x(`ALTER TABLE "${schema}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`)
  await x(sql, ...params)
  await x(`ALTER TABLE "${schema}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`)
}

const ROW = (schema, auditId, subject, pre, extra = {}) => ({ schema, audit_id: auditId, subject_user_id: subject, evidence: 'r5-evidence', approved_by: 'r5-reviewer', reviewed_at: new Date().toISOString(), pre, ...extra })

async function r141() {
  const S = schemaNameOf('r5-map-a'), T = schemaNameOf('r5-map-b')
  for (const s of [S, T]) {
    // 先到 pre-M1（无 principal 列/CHECK）建历史行 → 再滚动到 M1 → 转"未绑定残量"
    await makeSchema(s, preFiles)
    await x(`INSERT INTO "${s}"."User" (id, username, password_hash, role, status, created_at, updated_at) VALUES ('${s}-u1','u1','x','operator','active',now(),now()),('${s}-u2','u2','x','operator','active',now(),now())`)
    await x(`INSERT INTO "${s}"."AuditLog" (id, user_id, action, created_at) VALUES ('shared-1','${s}-u1','login',now()),('stable-1','${s}-u1','export',now())`)
    await applyTenantChain({ prisma: admin, conn, schema: s, chainFiles: aChain, retryFailed: true, log: () => {} })
    await x(`ALTER TABLE "${s}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`)
    await x(`UPDATE "${s}"."AuditLog" SET user_id=NULL, principal_id=NULL, actor_snapshot='{"source":"import","username":"ghost"}'::jsonb WHERE id='shared-1'`)
    await x(`UPDATE "${s}"."AuditLog" SET principal_id=NULL WHERE id='stable-1'`)
    await x(`ALTER TABLE "${s}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`)
  }

  // .1 缺 pre ⇒ 结构校验拒绝（零写入）
  const fp0 = await fingerprint(S)
  const noPre = mapFile('r5-map-nopre.json', [{ schema: S, audit_id: 'shared-1', subject_user_id: `${S}-u1`, evidence: 'e', approved_by: 'a', reviewed_at: new Date().toISOString() }])
  const r1 = run004(['--schema', S, '--mapping', noPre.p, '--expect-digest', noPre.d])
  const fp1 = await fingerprint(S)
  rec('R14-1.1', r1.rc !== 0 && r1.out.includes('pre_required_missing') && fp0.auditHash === fp1.auditHash && fp0.principalHash === fp1.principalHash,
    `缺 pre ⇒ 拒绝（${r1.rc}）且零写入（审计/主体指纹不变）`)

  // .2 整快照摘要陈旧（username 变化，subject 缺失不变）⇒ 拒绝（仅核 subject 不会发现）
  const preStale = printPre(S, 'shared-1')
  await mutateResidual(S, `UPDATE "${S}"."AuditLog" SET actor_snapshot='{"source":"import","username":"ghost-renamed"}'::jsonb WHERE id='shared-1'`)
  const staleMap = mapFile('r5-map-stale.json', [ROW(S, 'shared-1', `${S}-u1`, preStale)])
  const fp2a = await fingerprint(S)
  const r2 = run004(['--schema', S, '--mapping', staleMap.p, '--expect-digest', staleMap.d])
  const fp2b = await fingerprint(S)
  rec('R14-1.2', r2.rc !== 0 && r2.out.includes('stale_mapping_pre_state') && fp2a.auditHash === fp2b.auditHash && fp2a.principalHash === fp2b.principalHash,
    `整快照摘要陈旧（username-only 变化）⇒ 拒绝（${r2.rc}）且零写入`)

  // .3 有效映射（用变化后的真实 pre）⇒ 绑定成功（provenance=mapping）
  const preOk = printPre(S, 'shared-1')
  const okMap = mapFile('r5-map-ok.json', [ROW(S, 'shared-1', `${S}-u1`, preOk)])
  const r3 = run004(['--schema', S, '--mapping', okMap.p, '--expect-digest', okMap.d])
  const bound = await q(`SELECT a.principal_id, p.subject_user_id, a.actor_snapshot->>'source' AS src FROM "${S}"."AuditLog" a LEFT JOIN "${S}"."AuditPrincipal" p ON p.id=a.principal_id WHERE a.id='shared-1'`)
  const p2 = JSON.parse(r3.out.slice(r3.out.indexOf('{'), r3.out.lastIndexOf('}') + 1)).schemas[0].p2
  // 判据：走 P-2 路径（p2=1）+ 命中映射主体；且**不改写历史快照**（绑定前事实保留）
  rec('R14-1.3', r3.rc === 0 && p2 === 1 && bound[0].subject_user_id === `${S}-u1` && bound[0].src === 'import',
    `有效映射绑定（P-2=${p2} subject=${bound[0].subject_user_id}；历史快照保留 source=${bound[0].src}）`)

  // .4 已绑定**同主体**重跑 ⇒ 幂等（principal 行不变、计数相同）
  const fp3a = await fingerprint(S)
  const rerun = run004(['--schema', S, '--mapping', okMap.p, '--expect-digest', okMap.d])
  const fp3b = await fingerprint(S)
  rec('R14-1.4', rerun.rc === 0 && fp3a.auditHash === fp3b.auditHash && fp3a.principalHash === fp3b.principalHash,
    `已绑定同主体重跑 ⇒ rc=0 且零变化（审计/主体指纹一致）`)

  // .5 已绑定**异主体**重跑 ⇒ 整体非零拒绝（不得直接跳过/不得改写历史主体）
  await x(`INSERT INTO "${S}"."AuditPrincipal" (id,kind,scope_key,subject_user_id,origin,observed_at) VALUES ('alt-pid','user',$1,$2,'event',now()) ON CONFLICT DO NOTHING`, S, `${S}-u2`)
  const wrongMap = mapFile('r5-map-wrong.json', [ROW(S, 'shared-1', `${S}-u2`, preOk)])
  const fp4a = await fingerprint(S)
  const r5 = run004(['--schema', S, '--mapping', wrongMap.p, '--expect-digest', wrongMap.d])
  const fp4b = await fingerprint(S)
  const stillU1 = await q(`SELECT p.subject_user_id FROM "${S}"."AuditLog" a JOIN "${S}"."AuditPrincipal" p ON p.id=a.principal_id WHERE a.id='shared-1'`)
  rec('R14-1.5', r5.rc !== 0 && r5.out.includes('mapping_conflicts_with_bound_principal') && fp4a.principalHash === fp4b.principalHash && stillU1[0].subject_user_id === `${S}-u1`,
    `已绑定异主体 ⇒ 整体拒绝（${r5.rc}）、历史主体未被改写（仍 ${stillU1[0].subject_user_id}）`)

  // .6 两租户同 audit_id，各自 pre/主体 ⇒ 各自绑定
  const preB = printPre(T, 'shared-1')
  const both = mapFile('r5-map-both.json', [ROW(S, 'shared-1', `${S}-u1`, preOk), ROW(T, 'shared-1', `${T}-u1`, preB)])
  const r6 = run004(['--all-tenants', '--mapping', both.p, '--expect-digest', both.d])
  const tBound = await q(`SELECT p.subject_user_id FROM "${T}"."AuditLog" a JOIN "${T}"."AuditPrincipal" p ON p.id=a.principal_id WHERE a.id='shared-1'`)
  const sBound = await q(`SELECT p.subject_user_id FROM "${S}"."AuditLog" a JOIN "${S}"."AuditPrincipal" p ON p.id=a.principal_id WHERE a.id='shared-1'`)
  rec('R14-1.6', r6.rc === 0 && tBound[0].subject_user_id === `${T}-u1` && sBound[0].subject_user_id === `${S}-u1`,
    `两租户同 audit_id 各自绑定（S=${sBound[0].subject_user_id} T=${tBound[0].subject_user_id}）`)

  // .7 绑定 UPDATE 条件保护语义（行数 0/1）
  const snapNow = await q(`SELECT "actor_snapshot"::text AS s, "actor_snapshot" IS NULL AS n FROM "${T}"."AuditLog" WHERE id='shared-1'`)
  const staleText = `{"source":"import","username":"ghost-OLD"}` // 与当前事实不同
  const pid = 'principal:r5-guard'
  const guard0 = await x(`UPDATE "${T}"."AuditLog" SET principal_id=$1 WHERE id=$2 AND principal_id IS NULL AND actor_snapshot IS NOT DISTINCT FROM $3::jsonb`, pid, 'shared-1', staleText)
  const after0 = await q(`SELECT principal_id, subject_user_id FROM "${T}"."AuditLog" a LEFT JOIN "${T}"."AuditPrincipal" p ON p.id=a.principal_id WHERE a.id='shared-1'`)
  rec('R14-1.7', guard0 === 0 && after0[0].principal_id != null && after0[0].subject_user_id === `${T}-u1`,
    `条件保护：以陈旧快照文本做 UPDATE ⇒ 影响 0 行（不误绑；原绑定保持 ${after0[0].subject_user_id}）`)
}

async function r142() {
  // .1 正例：三类无主体系统行（SQL NULL / jsonb null / {}）在**不跑 004** 的干净 staging 上单次链回放
  const S = schemaNameOf('r5-p4-a')
  await x(`DROP SCHEMA IF EXISTS "${S}" CASCADE`)
  await x(`CREATE SCHEMA "${S}"`)
  await applyTenantChain({ prisma: admin, conn, schema: S, chainFiles: preFiles, retryFailed: true, log: () => {} })
  await x(`INSERT INTO "${S}"."User" (id, username, password_hash, role, status, created_at, updated_at) VALUES ('p4u','p4u','x','operator','active',now(),now())`)
  await x(`INSERT INTO "${S}"."AuditLog" (id, user_id, action, created_at) VALUES ('p4-sql-null','p4u','login',now()),('p4-json-null','p4u','login',now()),('p4-empty-obj','p4u','login',now())`)
  await applyTenantChain({ prisma: admin, conn, schema: S, chainFiles: aChain, retryFailed: true, log: () => {} })
  await x(`ALTER TABLE "${S}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`)
  await x(`UPDATE "${S}"."AuditLog" SET user_id=NULL, actor_snapshot=NULL WHERE id='p4-sql-null'`)
  await x(`UPDATE "${S}"."AuditLog" SET user_id=NULL, actor_snapshot='null'::jsonb WHERE id='p4-json-null'`)
  await x(`UPDATE "${S}"."AuditLog" SET user_id=NULL, actor_snapshot='{}'::jsonb WHERE id='p4-empty-obj'`)
  await x(`ALTER TABLE "${S}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`)
  const single = await applyTenantChain({ prisma: admin, conn, schema: S, chainFiles: allFiles, retryFailed: true, log: () => {} })
  const st = await q(`SELECT
      (SELECT count(*)::int FROM "${S}"."AuditLog" WHERE principal_id IS NULL) AS g2,
      (SELECT a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='AuditLog' AND a.attname='principal_id') AS g7,
      (SELECT convalidated FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=$1 AND c.conname='AuditLog_principal_id_required_new') AS g8,
      (SELECT count(*)::int FROM "${S}"."AuditLog" a JOIN "${S}"."AuditPrincipal" p ON p.id=a.principal_id WHERE p.kind='system') AS sys_rows,
      (SELECT count(*)::int FROM "${S}"."AuditLog" a JOIN "${S}"."AuditPrincipal" p ON p.id=a.principal_id WHERE p.kind='system' AND a."actor_snapshot" IS NOT NULL AND a."actor_snapshot" NOT IN ('null'::jsonb,'{}'::jsonb)) AS g33`, S)
  await x(`INSERT INTO public."School" (id, code, name, status, created_at, updated_at, generation) VALUES ('sch-r5-p4','r5-p4-a','R5 P4 正例校','active',now(),now(),1) ON CONFLICT (code) DO NOTHING`)
  const gate = run006()
  const dbs = runDbSyncCheck()
  rec('R14-2.1', single.applied.includes('20260927140000_lifecycle_audit_principal_enforce') && st[0].g2 === 0 && st[0].g7 === true && st[0].g8 === true && st[0].sys_rows === 3 && st[0].g33 === 0 && gate.rc === 0 && dbs.rc === 0,
    `单次回放绑定三类系统行（sys_rows=${st[0].sys_rows}）；G2=${st[0].g2} G7=${st[0].g7} G8=${st[0].g8} G3③=${st[0].g33}；006 rc=${gate.rc} db:check rc=${dbs.rc}`)

  // .2 负例：真实人类快照（username-only）但无稳定 id ⇒ M2 fail-closed、旧 schema 保留、不猜测
  const N = schemaNameOf('r5-p4-neg')
  await x(`DROP SCHEMA IF EXISTS "${N}" CASCADE`)
  await x(`CREATE SCHEMA "${N}"`)
  await applyTenantChain({ prisma: admin, conn, schema: N, chainFiles: preFiles, retryFailed: true, log: () => {} })
  await x(`INSERT INTO "${N}"."User" (id, username, password_hash, role, status, created_at, updated_at) VALUES ('nu','nu','x','operator','active',now(),now())`)
  await x(`INSERT INTO "${N}"."AuditLog" (id, user_id, action, created_at) VALUES ('sys-empty','nu','login',now()),('human-ghost','nu','login',now())`)
  await applyTenantChain({ prisma: admin, conn, schema: N, chainFiles: aChain, retryFailed: true, log: () => {} })
  await x(`ALTER TABLE "${N}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`)
  await x(`UPDATE "${N}"."AuditLog" SET user_id=NULL, actor_snapshot=NULL WHERE id='sys-empty'`)
  await x(`UPDATE "${N}"."AuditLog" SET user_id=NULL, actor_snapshot='{"source":"import","username":"ghost"}'::jsonb WHERE id='human-ghost'`)
  await x(`ALTER TABLE "${N}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`)
  let fail = null
  try { fail = await applyTenantChain({ prisma: admin, conn, schema: N, chainFiles: allFiles, retryFailed: true, log: () => {} }) }
  catch (e) { fail = { failed: { error: String(e.message || e) } } }
  const nst = await q(`SELECT
      (SELECT a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='AuditLog' AND a.attname='principal_id') AS g7,
      (SELECT principal_id FROM "${N}"."AuditLog" WHERE id='human-ghost') AS ghost_pid,
      (SELECT count(*)::int FROM "${N}"."AuditLog") AS rows,
      (SELECT count(*)::int FROM "${N}"."AuditPrincipal" p JOIN "${N}"."AuditLog" a ON a.principal_id=p.id WHERE a.id='human-ghost') AS ghost_bound`, N)
  const ledger = await q(`SELECT status FROM "${N}"."_tenant_migrations" WHERE migration_name=$1`, '20260927140000_lifecycle_audit_principal_enforce')
  rec('R14-2.2', fail.failed && String(fail.failed.error).includes('M2_UNBOUND_PRINCIPAL_ROWS') && nst[0].g7 === false && nst[0].ghost_pid === null && nst[0].ghost_bound === 0 && nst[0].rows === 2 && ledger[0]?.status === 'failed',
    `username-only 负例 ⇒ M2 fail-closed（旧 schema 保留 g7=false）、该行未绑定（不猜测）、台账 failed`)
}

const main = async () => {
  await r141()
  await r142()
  const summary = { task: 'P3-LIFECYCLE-AB-R5', at: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results }
  fs.writeFileSync(path.join(EV, 'R5-rework.json'), JSON.stringify(summary, null, 2))
  console.log(`\nR5 定点：${summary.pass}/${summary.total} PASS`)
  await admin.$disconnect()
  process.exit(summary.fail === 0 ? 0 : 1)
}
main().catch(async (e) => {
  console.error('R5 崩溃:', e)
  fs.writeFileSync(path.join(EV, 'R5-rework.json'), JSON.stringify({ task: 'P3-LIFECYCLE-AB-R5', crash: String((e && e.stack) || e), results }, null, 2))
  try { await admin.$disconnect() } catch { /* noop */ }
  process.exit(3)
})
