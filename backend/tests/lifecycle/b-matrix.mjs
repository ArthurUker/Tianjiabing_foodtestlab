// P3-LIFECYCLE-AB-R3 · Release B 定点矩阵（自有隔离实例；真实 PG）
//
// 覆盖：
//   B-P1 004：--dry-run 零写入 → 实跑（P-1/P-4 绑定、P-3 进待人工清单，绝不自动）
//   B-P2 M2 自足：绑定残量 → VALIDATE → SET NOT NULL（attnotnull=true / convalidated=true / G2=0）
//   B-P3 M2 fail-closed：P-3 残量 ⇒ RAISE、租户阻断（结构保持 pre-M2）
//   B-P4 映射证据：--expect-digest 不符 ⇒ 004 拒绝；相符 ⇒ 逐行绑定、证据登记
//   B-P5 006 只读门禁：不达标 ⇒ 列出未达标租户并非零退出；全绿 ⇒ GATE_PASS
//   B-P6 回退演练：B client → **回退 A client**，DB 保持 M2（A client 读写正常）
//   B-P7 单次 align：staging 一次 align 内完成 M1+M2（失败时保留旧结构、不切换）
//
// 注（写实登记）：当前产品写入面（写门面 + M1 CHECK）使 P-3/P-4 **未绑定残量在常规路径不可达**；
// 本矩阵通过"临时 DROP CHECK → 插入模拟残量行 → 还原 CHECK"构造负例（仅本包 scratch schema），
// 以证明 004/M2 对残量的 fail-closed 行为真实有效。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import { listMigrationFiles, migrationChainDigest, applyTenantChain, parseDbUrl } from '../../lib/tenantProvisioner.js'
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
const m1Name = '20260927130000_lifecycle_audit_principal_expand'
const m2Name = '20260927140000_lifecycle_audit_principal_enforce'
const preFiles = allFiles.filter((f) => f.name < m1Name)
const digestNow = migrationChainDigest()
const S = { b: schemaNameOf('ab-b'), c: schemaNameOf('ab-c'), old: schemaNameOf('ab-old'), fresh: schemaNameOf('ab-fresh') }
// 契约租户（openapi-http 建立过 School 行）也纳入全租户门禁
const RUN_ID = process.env.RUN_ID
const contractSchema = schemaNameOf(`t02a-${RUN_ID}-a`)

async function replay(schema, files, retryFailed = false) { return applyTenantChain({ prisma: admin, conn, schema, chainFiles: files, retryFailed, log: () => {} }) }
async function makeSchema(schema) { await x(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await x(`CREATE SCHEMA "${schema}"`) }
async function dropCheck(schema) { await x(`ALTER TABLE "${schema}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`) }
async function addCheck(schema) { await x(`ALTER TABLE "${schema}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`) }
const runScript = (script, args, env = {}) => {
  try {
    const out = execFileSync('node', [`backend/scripts/${script}`, ...args], {
      env: { ...process.env, DATABASE_URL: ADMIN_URL, ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    })
    return { rc: 0, out }
  } catch (e) { return { rc: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') } }
}

const parseJsonFrom = (out) => {
  const start = out.indexOf('{')
  const end = out.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('输出中未找到 JSON：' + String(out).slice(0, 200))
  return JSON.parse(out.slice(start, end + 1))
}

const main = async () => {
  // ── 准备：重建 A 期望态的 ab-old / ab-fresh（B 自足；不依赖上一次 A 运行的残留） ─────────
  const aChain = allFiles.filter((f) => f.name <= m1Name)
  await makeSchema(S.old)
  await replay(S.old, preFiles)   // 先到 pre-M1 态：历史行（无 principal 列语义）可写入
  await x(`INSERT INTO "${S.old}"."User" (id, username, password_hash, role, status, created_at, updated_at)
           VALUES ('u-hist-1','hist1','x','operator','active',now(),now()),('u-hist-2','hist2','x','operator','active',now(),now()),('u-hist-3','hist3','x','operator','active',now(),now())`)
  await x(`INSERT INTO "${S.old}"."AuditLog" (id, user_id, action, created_at) VALUES ('al-1','u-hist-1','login',now()),('al-2','u-hist-2','export',now()),('al-3','u-hist-1','create',now())`)
  await replay(S.old, aChain)     // 滚动应用 M1（历史行保持 NULL principal）
  // A 期已出现的状态：al-1 已绑人类主体、随后 user_id 被 FK SET NULL（快照仍为空 → 需要 M2 provenance 修复）
  const pidHist1 = 'principal:b4:' + crypto.createHash('sha256').update(`${S.old}\0u-hist-1`).digest('hex').slice(0, 24)
  await x(`INSERT INTO "${S.old}"."AuditPrincipal" (id,kind,scope_key,subject_user_id,subject_username,origin,observed_at)
           VALUES ($1,'user',$2,'u-hist-1','hist1','backfilled',now()) ON CONFLICT ("scope_key","subject_user_id") DO NOTHING`, pidHist1, S.old)
  await x(`UPDATE "${S.old}"."AuditLog" SET principal_id=(SELECT id FROM "${S.old}"."AuditPrincipal" WHERE subject_user_id='u-hist-1'), user_id=NULL WHERE id='al-1'`)
  // 写门面行（人类 + 系统），验证 G3③（系统行不得带快照）
  const oldDb = new (await import('@prisma/client')).PrismaClient({ datasources: { db: { url: `${ADMIN_URL}${ADMIN_URL.includes('?') ? '&' : '?'}schema=${S.old}` } } })
  const { writeTenantAuditLog: writeAuditOld } = await import('../../lib/auditLog.js')
  await writeAuditOld(oldDb, { actorId: 'u-hist-3', action: 'login', actor: { username: 'hist3' } })
  await writeAuditOld(oldDb, { actorId: null, action: 'export' })
  await oldDb.$disconnect()

  await makeSchema(S.fresh)
  await replay(S.fresh, aChain)

  // ── 准备：ab-b（14 链 + 历史行 + M1 + 模拟残量） ─────────────────────────────────────
  await makeSchema(S.b)
  await replay(S.b, preFiles)
  const mkUser = (schema, id, name) => x(`INSERT INTO "${schema}"."User" (id, username, password_hash, role, status, created_at, updated_at) VALUES ($1,$2,'x','operator','active',now(),now())`, id, name)
  await mkUser(S.b, 'b-u1', 'bu1'); await mkUser(S.b, 'b-u2', 'bu2')
  await x(`INSERT INTO "${S.b}"."AuditLog" (id, user_id, action, created_at) VALUES ('b-r1','b-u1','login',now()),('b-r2','b-u2','export',now())`)
  const rB1 = await replay(S.b, allFiles.filter((f) => f.name <= m1Name))
  rec('B-P0.1', rB1.applied.includes(m1Name), `ab-b：14 链 + M1（applied=${rB1.applied.length}）`)

  // 模拟残量（P-3：user_id NULL + 仅 username 快照；P-4：user_id NULL + 无快照）
  await dropCheck(S.b)
  await x(`INSERT INTO "${S.b}"."AuditLog" (id, user_id, action, actor_snapshot, created_at)
           VALUES ('b-r3', NULL, 'login', '{"source":"import","observed_at":"2026-01-01T00:00:00Z","username":"ghost"}'::jsonb, now())`)
  await x(`INSERT INTO "${S.b}"."AuditLog" (id, user_id, action, created_at) VALUES ('b-r4', NULL, 'export', now())`)
  await addCheck(S.b)
  const pre = await q(`SELECT count(*)::int AS nulls FROM "${S.b}"."AuditLog" WHERE principal_id IS NULL`)
  rec('B-P0.2', pre[0].nulls === 4, `ab-b 残量构造：principal NULL=${pre[0].nulls}（r1..r4；r3/r4 为模拟残量，CHECK 已还原）`)

  // ── B-P1 004：dry-run 零写入 → 实跑 ────────────────────────────────────────────────
  const principalsBefore = await q(`SELECT count(*)::int AS n FROM "${S.b}"."AuditPrincipal"`)
  const dry = runScript('004_backfill_audit_principals.mjs', ['--dry-run', '--schema', S.b])
  const dryJson = parseJsonFrom(dry.out)
  const principalsAfterDry = await q(`SELECT count(*)::int AS n FROM "${S.b}"."AuditPrincipal"`)
  const nullsAfterDry = await q(`SELECT count(*)::int AS n FROM "${S.b}"."AuditLog" WHERE principal_id IS NULL`)
  const s0 = dryJson.schemas[0]
  rec('B-P1.1', dry.rc === 0 && principalsBefore[0].n === principalsAfterDry[0].n && nullsAfterDry[0].n === 4,
    `dry-run 零写入（principals ${principalsBefore[0].n}→${principalsAfterDry[0].n}；NULL 保持 4）`)
  rec('B-P1.2', s0.p1 === 2 && s0.p1b === 0 && s0.p2 === 0 && s0.p4 === 1 && s0.refused.length === 1 && s0.refused[0].reason === 'username_only_refused',
    `dry-run 分档：P-1=${s0.p1} P-4=${s0.p4} 拒绝=${s0.refused.length}(${s0.refused[0]?.reason})`)

  const real = runScript('004_backfill_audit_principals.mjs', ['--schema', S.b, '--json', path.join(EV, '004-run-1.json')])
  const realJson = parseJsonFrom(real.out)
  const rows1 = await q(`SELECT id, user_id, principal_id FROM "${S.b}"."AuditLog" WHERE id IN ('b-r1','b-r2','b-r3','b-r4') ORDER BY id`)
  const byId = Object.fromEntries(rows1.map((r) => [r.id, r]))
  rec('B-P1.3', real.rc === 0 && byId['b-r1'].principal_id && byId['b-r2'].principal_id && !byId['b-r3'].principal_id && byId['b-r4'].principal_id
    && byId['b-r4'].principal_id === `system-principal:${S.b}`,
    `实跑：P-1 绑定 r1/r2、P-4→系统主体 r4、P-3 保持未绑 r3（拒绝=${realJson.refusedTotal}）`)

  // 重入：再跑一次 → P-0 全跳过（零新写入）
  const again = runScript('004_backfill_audit_principals.mjs', ['--schema', S.b])
  const againJson = parseJsonFrom(again.out)
  const s1 = againJson.schemas[0]
  rec('B-P1.4', again.rc === 0 && s1.p1 === 0 && s1.p4 === 0 && s1.refused.length === 1, `重入幂等：P-1/P-4=0，拒绝清单保持 1（P-0 跳过）`)

  // ── B-P2/B-P3：M2 自足与 fail-closed ──────────────────────────────────────────────
  let m2Fail = null
  try { m2Fail = await replay(S.b, allFiles) } catch (e) { m2Fail = { failed: { error: String(e.message || e), code: e.code } } }
  const attr0 = await q(`SELECT a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='AuditLog' AND a.attname='principal_id'`, S.b)
  const stillNull = await q(`SELECT count(*)::int AS n FROM "${S.b}"."AuditLog" WHERE principal_id IS NULL`)
  rec('B-P3.1', m2Fail.failed && String(m2Fail.failed.error || '').includes('M2_UNBOUND_PRINCIPAL_ROWS') && attr0[0].attnotnull === false && stillNull[0].n === 1,
    `M2 fail-closed：RAISE（${String(m2Fail.failed?.error || '').slice(0, 60)}…）；attnotnull 保持 false；未绑行保持 1`)
  const failRow = await q(`SELECT status, detail FROM "${S.b}"."_tenant_migrations" WHERE migration_name=$1`, m2Name)
  rec('B-P3.2', failRow.length === 1 && failRow[0].status === 'failed', `M2 失败写入台账失败行（status=${failRow[0]?.status}）`)

  // ── B-P4 映射证据 ────────────────────────────────────────────────────────────────
  const mappingFile = path.join(EV, 'mapping-r3.json')
  // R14-1：映射行必须携带 pre 事实块（产品 --print-pre 生成）
  const preFor = (schema, auditId) => JSON.parse(execFileSync('node', ['backend/scripts/004_backfill_audit_principals.mjs', '--print-pre', `${schema}:${auditId}`], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8' })).pre
  const mrow = (auditId, subj) => ({ schema: S.b, audit_id: auditId, subject_user_id: subj, evidence: 'offline-reviewed-mapping (B-P4)', approved_by: 'b-reviewer', reviewed_at: new Date().toISOString(), pre: preFor(S.b, auditId) })
  fs.writeFileSync(mappingFile, JSON.stringify([mrow('b-r3', 'b-u1')], null, 2))
  const goodDigest = crypto.createHash('sha256').update(fs.readFileSync(mappingFile)).digest('hex')
  const badDigestRun = runScript('004_backfill_audit_principals.mjs', ['--schema', S.b, '--mapping', mappingFile, '--expect-digest', 'deadbeef'.repeat(8)])
  rec('B-P4.1', badDigestRun.rc !== 0 && badDigestRun.out.includes('摘要不符'), `摘要不符 ⇒ 004 拒绝（rc=${badDigestRun.rc}）`)
  const mapRun = runScript('004_backfill_audit_principals.mjs', ['--schema', S.b, '--mapping', mappingFile, '--expect-digest', goodDigest, '--json', path.join(EV, '004-run-2-mapping.json')])
  const r3 = await q(`SELECT principal_id FROM "${S.b}"."AuditLog" WHERE id='b-r3'`)
  rec('B-P4.2', mapRun.rc === 0 && r3[0].principal_id != null, `证据摘要一致 ⇒ 逐行绑定成功（r3.principal=${String(r3[0].principal_id).slice(0, 18)}…，digest=${goodDigest.slice(0, 12)}…）`)

  // ── B-P2 完成：M2 自足 → VALIDATE → SET NOT NULL ──────────────────────────────────
  const m2ok = await replay(S.b, allFiles, true)
  const final = await q(`SELECT
      (SELECT count(*)::int FROM "${S.b}"."AuditLog" WHERE principal_id IS NULL) AS g2,
      (SELECT a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='AuditLog' AND a.attname='principal_id') AS g7,
      (SELECT convalidated FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=$1 AND c.conname='AuditLog_principal_id_required_new') AS g8,
      (SELECT count(*)::int FROM "${S.b}"."AuditPrincipal" p JOIN "${S.b}"."AuditLog" a ON a.principal_id=p.id WHERE p.kind='system' AND a.actor_snapshot IS NOT NULL) AS g33`, S.b)
  rec('B-P2.1', m2ok.applied.includes(m2Name) && final[0].g2 === 0 && final[0].g7 === true && final[0].g8 === true && final[0].g33 === 0,
    `M2 完成：G2=0 G7=${final[0].g7} G8=${final[0].g8} G3③=${final[0].g33}`)
  const ledger = await q(`SELECT migration_name, status, chain_digest FROM "${S.b}"."_tenant_migrations" WHERE migration_name IN ($1,$2) ORDER BY migration_name`, m1Name, m2Name)
  rec('B-P2.2', ledger.length === 2 && ledger.every((l) => l.status === 'applied' && l.chain_digest === digestNow),
    `M1/M2 台账 applied 且 chain_digest == 当时产品算法（${digestNow.slice(0, 12)}…）`)

  // M2 后强门禁语义复验：无 principal 的 INSERT 仍被拒（CHECK 已 validated + SET NOT NULL 双保险）
  let postM2 = { rejected: false, code: null }
  try { await x(`INSERT INTO "${S.b}"."AuditLog" (id, user_id, action, created_at) VALUES ('b-x', NULL, 'login', now())`) }
  catch (e) { postM2 = { rejected: true, code: String(e?.meta?.code || e.message).slice(0, 50) } }
  rec('B-P2.3', postM2.rejected && postM2.code.includes('23502') || postM2.code.includes('23514'), `M2 后无 principal INSERT 仍被拒：${postM2.code}`)

  // ── B-P7 单次 align（staging 恢复路径模拟） ───────────────────────────────────────
  await makeSchema(S.c)
  await replay(S.c, preFiles)
  await mkUser(S.c, 'c-u1', 'cu1')
  await x(`INSERT INTO "${S.c}"."AuditLog" (id, user_id, action, created_at) VALUES ('c-r1','c-u1','login',now())`)
  const single = await replay(S.c, allFiles) // 一次调用内完成 M1+M2（staging 一次 align）
  const cFinal = await q(`SELECT
      (SELECT count(*)::int FROM "${S.c}"."AuditLog" WHERE principal_id IS NULL) AS g2,
      (SELECT a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='AuditLog' AND a.attname='principal_id') AS g7`, S.c)
  rec('B-P7.1', single.applied.includes(m1Name) && single.applied.includes(m2Name) && cFinal[0].g2 === 0 && cFinal[0].g7 === true,
    `单次 align 内完成 M1+M2（applied=${single.applied.length}；G2=0 G7=${cFinal[0].g7}）——失败时不切换由独立负例覆盖`)

  // 负例：同一场景若残量不可绑 → align 失败、结构保持 pre-M2（相当于"失败保留旧 schema、不切换"）
  await makeSchema(schemaNameOf('ab-c2'))
  const S2 = schemaNameOf('ab-c2')
  await replay(S2, preFiles)
  await mkUser(S2, 'c2-u1', 'c2u1')
  await x(`INSERT INTO "${S2}"."AuditLog" (id, user_id, action, created_at) VALUES ('c2-r1','c2-u1','login',now())`)
  await replay(S2, allFiles.filter((f) => f.name <= m1Name))
  await dropCheck(S2)
  await x(`INSERT INTO "${S2}"."AuditLog" (id, user_id, action, actor_snapshot, created_at) VALUES ('c2-bad', NULL, 'login', '{"username":"ghost2"}'::jsonb, now())`)
  await addCheck(S2)
  let singleFail = null
  try { singleFail = await replay(S2, allFiles) } catch (e) { singleFail = { failed: { error: String(e.message || e), code: e.code } } }
  const s2Final = await q(`SELECT
      (SELECT a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='AuditLog' AND a.attname='principal_id') AS g7,
      (SELECT count(*)::int FROM "${S2}"."AuditLog") AS rows`, S2)
  rec('B-P7.2', singleFail.failed && String(singleFail.failed.error).includes('M2_UNBOUND_PRINCIPAL_ROWS') && s2Final[0].g7 === false && s2Final[0].rows === 2,
    `align 失败 ⇒ 不进入 M2（attnotnull 保持 false）、旧数据完整（${s2Final[0].rows} 行）——等价"失败保留旧 schema、不切换"`)

  // ── B-P5 006 只读门禁 ─────────────────────────────────────────────────────────────
  // 先造不达标态（自足：注入一个**已注册但未达 M2** 的租户，避免依赖此前会话残留的 School 行）
  //   ab-old 在开头被重建为 A 期态（未 M2）⇒ 注册它即构成不达标态；后续修复循环会把它迁到 M2
  await x(`INSERT INTO public."School" (id, code, name, status, created_at, updated_at, generation) VALUES ('sch-b-prefail','ab-old','矩阵租户 ab-old（门禁负例）','active',now(),now(),1) ON CONFLICT (code) DO NOTHING`)
  // 不达标态：ab-old 仍有未绑行（等待 004/映射），契约租户尚未 M2 ⇒ 门禁必须失败并列出
  const gateFail = runScript('006_audit_principal_gate.mjs', ['--json', path.join(EV, 'gate-fail.json')])
  const gateFailJson = parseJsonFrom(gateFail.out)
  const failedList = gateFailJson.failed || []
  rec('B-P5.1', gateFail.rc !== 0 && failedList.length >= 1, `门禁不达标 ⇒ 非零退出并列出租户：${failedList.join(', ').slice(0, 120)}`)

  // 清理 A 矩阵 A-G 用例留下的"无 schema 幻影学校"（scratch 数据；避免门禁把它们当成未达标租户）
  await x(`DELETE FROM public."OpenApiGrant" WHERE client_id LIKE 'ab-life-client-%'`)
  await x(`DELETE FROM public."OpenApiClient" WHERE id LIKE 'ab-life-client-%'`)
  await x(`DELETE FROM public."School" WHERE code LIKE 'ab-life-%'`)
  await x(`DELETE FROM public."School" WHERE code LIKE 'r4-%'`)   // 与 R4 返工包共存时的自足清理（scratch）

  // 补齐全部可达租户：注册 School 行（ab-b/ab-c 已就绪）→ 004 全体 → M2 全体
  for (const code of ['ab-b', 'ab-c', 'ab-old', 'ab-fresh']) {
    await x(`INSERT INTO public."School" (id, code, name, status, created_at, updated_at, generation) VALUES ($1,$2,$3,'active',now(),now(),1) ON CONFLICT (code) DO NOTHING`, `sch-${code}`, code, `矩阵租户 ${code}`)
  }
  if (contractSchema) await x(`INSERT INTO public."School" (id, code, name, status, created_at, updated_at, generation) VALUES ($1,$2,$3,'active',now(),now(),1) ON CONFLICT (code) DO NOTHING`, `sch-contract`, `t02a-${RUN_ID}-a`, '契约租户')
  runScript('004_backfill_audit_principals.mjs', ['--all-tenants', '--json', path.join(EV, '004-all-tenants.json')])
  for (const schema of [S.b, S.c, S2, S.old, S.fresh, contractSchema].filter(Boolean)) {
    try { await replay(schema, allFiles, true) } catch (e) { console.log(`（${schema} replay 跳过：${String(e.message).slice(0, 80)}）`) }
  }
  // S2 残量不可绑 ⇒ 保持失败（这正是门禁应捕获的真实不达标态之一）；为演示 GATE_PASS，给 S2 的模拟残量补证据后完成
  // （等价：人工映射证据到场后重放 M2）
  const c2map = path.join(EV, 'mapping-c2.json')
  fs.writeFileSync(c2map, JSON.stringify([{ schema: S2, audit_id: 'c2-bad', subject_user_id: 'c2-u1', evidence: 'offline-reviewed-mapping (B-P5)', approved_by: 'b-reviewer', reviewed_at: new Date().toISOString(), pre: preFor(S2, 'c2-bad') }]))
  const c2digest = crypto.createHash('sha256').update(fs.readFileSync(c2map)).digest('hex')
  runScript('004_backfill_audit_principals.mjs', ['--schema', S2, '--mapping', c2map, '--expect-digest', c2digest])
  const c2again = await replay(S2, allFiles, true)
  rec('B-P5.2', c2again.applied.includes(m2Name), `S2（align 失败租户）经映射证据修复后重放 M2 成功（applied=${c2again.applied.length}）`)

  const gatePass = runScript('006_audit_principal_gate.mjs', ['--json', path.join(EV, 'gate-pass.json')])
  const gatePassJson = parseJsonFrom(gatePass.out)
  rec('B-P5.3', gatePass.rc === 0 && gatePassJson.verdict === 'GATE_PASS',
    `全租户门禁通过：${gatePassJson.tenants.length} 租户 GATE_PASS（含契约租户）`)

  // ── B-P6 两段激活与回退演练（B client → A client；DB 保持 M2） ──────────────────────
  const switchTo = (mode) => {
    const out = execFileSync('node', ['backend/tests/lifecycle/schema-switch.mjs', mode], { encoding: 'utf8' })
    return JSON.parse(out.trim().split('\n').slice(-1)[0])
  }
  const bInfo = switchTo('B')
  rec('B-P6.1', bInfo.isRequired === true, `B2 激活：B 版 client 生成（index=${bInfo.clientIndexSha256.slice(0, 16)}…）且 principal_id isRequired=true`)
  const bDb = new PrismaClient({ datasources: { db: { url: `${ADMIN_URL}${ADMIN_URL.includes('?') ? '&' : '?'}schema=${S.b}` } } })
  const bRows = await bDb.auditLog.count()
  const bSys = await bDb.auditPrincipal.count({ where: { kind: 'system' } })
  await bDb.$disconnect()
  rec('B-P6.2', bRows === 4 && bSys === 1, `B client 对 M2 库读取正常（AuditLog=${bRows}，系统主体=${bSys}）`)

  const aInfo = switchTo('A')
  rec('B-P6.3', aInfo.isRequired === false, `回退：A 版 client 重新生成（index=${aInfo.clientIndexSha256.slice(0, 16)}…）且 principal_id isRequired=false`)

  const aDb = new PrismaClient({ datasources: { db: { url: `${ADMIN_URL}${ADMIN_URL.includes('?') ? '&' : '?'}schema=${S.b}` } } })
  const { writeTenantAuditLog } = await import('../../lib/auditLog.js')
  const w = await writeTenantAuditLog(aDb, { actorId: 'b-u1', action: 'login', actor: { username: 'bu1' } })
  const m2Still = await q(`SELECT a.attnotnull FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='AuditLog' AND a.attname='principal_id'`, S.b)
  await aDb.$disconnect()
  rec('B-P6.4', !!w.principal_id && m2Still[0].attnotnull === true, `回退 A client 后写入正常（principal 绑定 ${String(w.principal_id).slice(0, 16)}…）且 DB 保持 M2（attnotnull=true）`)

  // 交付终态 = B 版（链尾 M2 为 required；A 版在 patch-A 中可重建，回退路径见 B-P6.3/P6.4 证据）
  const finalB = switchTo('B')
  rec('B-P6.5', finalB.isRequired === true, `交付终态 = B 版 client（index=${finalB.clientIndexSha256.slice(0, 16)}…；与链尾 M2 required 一致）`)

  // ── 汇总 ───────────────────────────────────────────────────────────────────────────
  const summary = {
    task: 'P3-LIFECYCLE-AB-R3', stage: 'B', at: new Date().toISOString(), digestNow,
    bClientIndex: bInfo.clientIndexSha256, finalRollbackA: aInfo.clientIndexSha256, finalB: finalB.clientIndexSha256,
    total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results,
  }
  fs.writeFileSync(path.join(EV, 'B-matrix.json'), JSON.stringify(summary, null, 2))
  console.log(`\nB 矩阵：${summary.pass}/${summary.total} PASS`)
  await admin.$disconnect()
  process.exit(summary.fail === 0 ? 0 : 1)
}
main().catch(async (e) => {
  console.error('B 矩阵崩溃:', e)
  fs.writeFileSync(path.join(EV, 'B-matrix.json'), JSON.stringify({ task: 'P3-LIFECYCLE-AB-R3', stage: 'B', crash: String((e && e.stack) || e), results }, null, 2))
  try { await admin.$disconnect() } catch { /* noop */ }
  process.exit(3)
})
