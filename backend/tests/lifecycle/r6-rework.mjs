// P3-LIFECYCLE-AB-R6 · R15 限定返工定点（自有隔离实例；真实 PG，两种真实交错）
//
// 修复目标（R15 §未闭合）：
//   · 映射绑定的**最终判据 = 证据文件 `pre`**（事务内重读后逐项对齐，而非只比重读值）；
//   · 主体建档 + 审计绑定**同一事务**（UPDATE 0 行 ⇒ 回滚，不留下孤立 AuditPrincipal）；
//   · 真实交错 ①：预校验后、重读前改 username-only 快照 ⇒ 必须拒绝，零误写；
//   · 真实交错 ②：重读后、UPDATE 前改快照 ⇒ 必须拒绝，零误写、无孤儿主体；
//   · 无竞争成功 + 幂等重跑保持；
//   · 原子性边界如实（逐行事务 + 逐校顺序，无全批事务）：前序行已提交不回滚。
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
process.env.DATABASE_URL = ADMIN_URL           // 004 模块级 admin 客户端据此创建
const M = await import('../../scripts/004_backfill_audit_principals.mjs')

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

/** 独立进程/连接改行（真实跨会话交错；绝不与 004 事务同连接）。 */
function mutateInSeparateSession(schemaName, auditId, snapshotJson) {
  const clientPath = path.join(process.cwd(), 'backend/node_modules/@prisma/client/default.js')
  const script = `
    import { PrismaClient } from '${clientPath}'
    const p = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
    // 竞争写入者（维护/导入路径）改"未绑定残量行"的快照：CHECK 对 UPDATE 同样生效 ⇒ 先摘后补
    await p.$executeRawUnsafe('ALTER TABLE "${schemaName}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"')
    await p.$executeRawUnsafe(
      'UPDATE "${schemaName}"."AuditLog" SET "actor_snapshot" = $2::jsonb WHERE "id" = $1',
      '${auditId}', ${JSON.stringify(JSON.stringify(snapshotJson))})
    await p.$executeRawUnsafe('ALTER TABLE "${schemaName}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID')
    await p.$disconnect()
  `
  execFileSync('node', ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8' })
}

async function fingerprint(schema) {
  const rows = await q(`SELECT id, user_id, principal_id, action, actor_snapshot::text AS s FROM "${schema}"."AuditLog" ORDER BY id`)
  const ps = await q(`SELECT id, kind, scope_key, subject_user_id FROM "${schema}"."AuditPrincipal" ORDER BY id`)
  return {
    auditHash: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    principalHash: crypto.createHash('sha256').update(JSON.stringify(ps)).digest('hex'),
    principalCount: ps.length,
    auditHashOf: (id) => crypto.createHash('sha256').update(JSON.stringify(rows.find((r) => r.id === id) || null)).digest('hex'),
  }
}
const printPre = (schema, auditId) => JSON.parse(execFileSync('node', ['backend/scripts/004_backfill_audit_principals.mjs', '--print-pre', `${schema}:${auditId}`], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8' })).pre
const rowsToMapping = (rows) => { const v = M.validateMappingRows(rows); const digest = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); return { digest, rows: v.rows, map: v.map } }
const rowT = (schema, auditId, subject, pre, extra = {}) => ({ schema, audit_id: auditId, subject_user_id: subject, evidence: 'r6-evidence', approved_by: 'r6-reviewer', reviewed_at: new Date().toISOString(), pre, ...extra })

/** 建 schema（pre-M1 建行 → 滚动到 M1 → 转"未绑定残量"）：ids 为 username-only 残量行。 */
async function buildSchema(schemaCode, residualIds, stableIds = []) {
  const S = schemaNameOf(schemaCode)
  await x(`DROP SCHEMA IF EXISTS "${S}" CASCADE`)
  await x(`CREATE SCHEMA "${S}"`)
  await applyTenantChain({ prisma: admin, conn, schema: S, chainFiles: preFiles, retryFailed: true, log: () => {} })
  await x(`INSERT INTO "${S}"."User" (id, username, password_hash, role, status, created_at, updated_at) VALUES ('${schemaCode}-u1','u1','x','operator','active',now(),now()),('${schemaCode}-u2','u2','x','operator','active',now(),now())`)
  for (const id of [...residualIds, ...stableIds]) {
    await x(`INSERT INTO "${S}"."AuditLog" (id, user_id, action, created_at) VALUES ($1,'${schemaCode}-u1','login',now())`, id)
  }
  await applyTenantChain({ prisma: admin, conn, schema: S, chainFiles: aChain, retryFailed: true, log: () => {} })
  await x(`ALTER TABLE "${S}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`)
  for (const id of residualIds) {
    await x(`UPDATE "${S}"."AuditLog" SET user_id=NULL, principal_id=NULL, actor_snapshot=$2::jsonb WHERE id=$1`,
      id, JSON.stringify({ source: 'import', username: `${id}-orig` }))
  }
  for (const id of stableIds) await x(`UPDATE "${S}"."AuditLog" SET principal_id=NULL WHERE id=$1`, id)
  await x(`ALTER TABLE "${S}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`)
  return S
}

const main = async () => {
  // ── R6.1 交错①：预校验后、重读前改 username-only 快照 ⇒ 拒绝、零误写 ────────────────
  {
    const S = await buildSchema('r6-a', ['m-race1'])
    const mapping = rowsToMapping([rowT(S, 'm-race1', `${S}-u1`, printPre(S, 'm-race1'))])
    const hookState = { mutated: false, fpAfterMutation: null }
    const testHooks = {
      afterPrevalidate: async () => {
        mutateInSeparateSession(S, 'm-race1', { source: 'import', username: 'ghost-OTHER-person' })
        hookState.mutated = true
        hookState.fpAfterMutation = await fingerprint(S)   // 基准 = 竞争写入之后（此后 004 不得再改任何行/主体）
      },
    }
    let err = null
    try { await M.runBackfill({ schemas: [S], mapping, testHooks }) } catch (e) { err = e }
    const fpAfter = await fingerprint(S)
    const fpBefore = hookState.fpAfterMutation
    rec('R6.1', hookState.mutated && !!err && err.code === 'STALE_MAPPING_PRE_STATE_AT_BIND'
      && fpBefore.auditHash === fpAfter.auditHash && fpBefore.principalHash === fpAfter.principalHash && fpBefore.principalCount === fpAfter.principalCount,
      `交错①（预校验后改 username-only 快照）⇒ ${err?.code}；审计行/主体指纹零变化（主体数=${fpAfter.principalCount}）`)
  }

  // ── R6.2 交错②：重读后、UPDATE 前改快照 ⇒ 拒绝、零误写、**无孤儿主体** ──────────────
  {
    const S = await buildSchema('r6-b', ['m-race2'])
    const mapping = rowsToMapping([rowT(S, 'm-race2', `${S}-u1`, printPre(S, 'm-race2'))])
    const hookState = { fired: 0 }
    const testHooks = {
      // 交错②：重读后、UPDATE 前事实被改。此处**在同一事务内**改行（PG 的 DDL 是事务性的，
      // 回滚会一并撤销）；若改用独立会话会与相位 A 的 CHECK/表锁互斥而死等 —— 见 RESULT §R6-② 说明。
      beforeMappedBind: async ({ auditId, tx }) => {
        if (auditId !== 'm-race2') return
        hookState.fired++
        await tx.$executeRawUnsafe(`ALTER TABLE "${S}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`)
        await tx.$executeRawUnsafe(`UPDATE "${S}"."AuditLog" SET "actor_snapshot"=$2::jsonb WHERE "id"=$1`, 'm-race2', JSON.stringify({ source: 'import', username: 'ghost-RACE2' }))
        await tx.$executeRawUnsafe(`ALTER TABLE "${S}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`)
      },
    }
    const fpBefore = await fingerprint(S)
    let err = null
    try { await M.runBackfill({ schemas: [S], mapping, testHooks }) } catch (e) { err = e }
    const fp = await fingerprint(S)
    const orphan = await q(`SELECT count(*)::int AS n FROM "${S}"."AuditPrincipal" WHERE kind='user' AND origin='mapping'`)
    const row = await q(`SELECT principal_id, actor_snapshot->>'username' AS u FROM "${S}"."AuditLog" WHERE id='m-race2'`)
    rec('R6.2', hookState.fired === 1 && !!err && err.code === 'MAPPING_RACE_OR_STALE'
      && row[0].principal_id === null && orphan[0].n === 0 && fp.principalCount === fpBefore.principalCount && fp.auditHash === fpBefore.auditHash,
      `交错②（重读后、UPDATE 前改快照）⇒ ${err?.code}；UPDATE 影响 0 行且**事务回滚未留新主体**（mapping 主体=${orphan[0].n}，行仍未绑定）`)
  }

  // ── R6.3 无竞争成功 + R6.4 幂等重跑 ────────────────────────────────────────────────
  {
    const S = await buildSchema('r6-c', ['m-ok'])
    const mappingObj = rowsToMapping([rowT(S, 'm-ok', `${S}-u2`, printPre(S, 'm-ok'))])
    const out1 = await M.runBackfill({ schemas: [S], mapping: mappingObj })
    const s1 = out1.schemas[0]
    const bound = await q(`SELECT a.principal_id, p.subject_user_id, a.actor_snapshot->>'source' AS src FROM "${S}"."AuditLog" a LEFT JOIN "${S}"."AuditPrincipal" p ON p.id=a.principal_id WHERE a.id='m-ok'`)
    const fpA = await fingerprint(S)
    rec('R6.3', s1.p2 === 1 && bound[0].subject_user_id === `${S}-u2` && bound[0].src === 'import' && out1.atomicity?.scope?.includes('无'),
      `无竞争成功：P-2=1、subject=${bound[0].subject_user_id}、历史快照保留（source=${bound[0].src}）；原子性口径=${JSON.stringify(out1.atomicity?.scope || '')}`)

    const problemsAfter = await M.validateMappingAgainstDb(mappingObj, [S])
    const out2 = await M.runBackfill({ schemas: [S], mapping: mappingObj })
    const fpB = await fingerprint(S)
    rec('R6.4', problemsAfter.length === 0 && out2.schemas[0].p2 === 0 && out2.schemas[0].skipped === 0
      && fpA.auditHash === fpB.auditHash && fpA.principalHash === fpB.principalHash,
      `幂等重跑：已绑定行经预校验（主体一致，problems=0）且零写入/零变化（P-2=0 P-0 未列入待处理）`)
  }

  // ── R6.5 原子边界：逐行事务、无全批事务（前序行已提交不回滚） ──────────────────────
  {
    const S = await buildSchema('r6-d', ['r6-2-race'], ['r6-1-ok'])
    const mapping = rowsToMapping([
      // 稳定行：映射主体必须 = 该行真实 user_id（r6-d-u1）；残量行：映射主体为外部证据指定
      rowT(S, 'r6-1-ok', 'r6-d-u1', printPre(S, 'r6-1-ok')),
      rowT(S, 'r6-2-race', `${S}-u2`, printPre(S, 'r6-2-race')),
    ])
    const testHooks = {
      beforeMappedBind: async ({ auditId, tx }) => {
        if (auditId !== 'r6-2-race') return
        await tx.$executeRawUnsafe(`ALTER TABLE "${S}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`)
        await tx.$executeRawUnsafe(`UPDATE "${S}"."AuditLog" SET "actor_snapshot"=$2::jsonb WHERE "id"=$1`, 'r6-2-race', JSON.stringify({ source: 'import', username: 'ghost-BATCH' }))
        await tx.$executeRawUnsafe(`ALTER TABLE "${S}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`)
      },
    }
    let err = null
    try { await M.runBackfill({ schemas: [S], mapping, testHooks }) } catch (e) { err = e }
    const first = await q(`SELECT a.principal_id, p.subject_user_id FROM "${S}"."AuditLog" a LEFT JOIN "${S}"."AuditPrincipal" p ON p.id=a.principal_id WHERE a.id='r6-1-ok'`)
    const second = await q(`SELECT principal_id FROM "${S}"."AuditLog" WHERE id='r6-2-race'`)
    rec('R6.5', !!err && first[0].principal_id != null && first[0].subject_user_id === 'r6-d-u1' && second[0].principal_id === null,
      `行级原子 + 无全批事务：前序行 r6-1-ok **已提交**（subject=${first[0].subject_user_id}）、竞争行 r6-2-race 回滚未绑（err=${err?.code}${err?.out?.mapping?.validation ? ' problems=' + JSON.stringify(err.out.mapping.validation.problems.slice(0, 2)) : ''}）⇒ 报告口径为"逐行事务/逐校顺序"（不得称任何失败整体零写入）`)
  }

  // ── R6.6 CLI rc：陈旧映射（预校验即拒）rc=1；有效映射 rc=0 ────────────────────────
  {
    const S = await buildSchema('r6-e', ['m-cli'])
    const staleRows = [rowT(S, 'm-cli', `${S}-u1`, printPre(S, 'm-cli'))]
    mutateInSeparateSession(S, 'm-cli', { source: 'import', username: 'ghost-CLI' })
    const p = path.join(EV, 'r6-cli-mapping.json')
    fs.writeFileSync(p, JSON.stringify(staleRows, null, 2))
    const d = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    let rcStale
    try { execFileSync('node', ['backend/scripts/004_backfill_audit_principals.mjs', '--schema', S, '--mapping', p, '--expect-digest', d], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8' }); rcStale = 0 } catch (e) { rcStale = e.status ?? 1 }
    const freshRows = [rowT(S, 'm-cli', `${S}-u1`, printPre(S, 'm-cli'))]
    const p2 = path.join(EV, 'r6-cli-mapping-fresh.json')
    fs.writeFileSync(p2, JSON.stringify(freshRows, null, 2))
    const d2 = crypto.createHash('sha256').update(fs.readFileSync(p2)).digest('hex')
    let rcFresh, freshOut = ''
    try { freshOut = execFileSync('node', ['backend/scripts/004_backfill_audit_principals.mjs', '--schema', S, '--mapping', p2, '--expect-digest', d2], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8' }); rcFresh = 0 } catch (e) { rcFresh = e.status ?? 1; freshOut = String(e.stdout || '') }
    const okJson = rcFresh === 0 ? JSON.parse(freshOut.slice(freshOut.indexOf('{'), freshOut.lastIndexOf('}') + 1)) : null
    rec('R6.6', rcStale === 1 && rcFresh === 0 && okJson?.schemas?.[0]?.p2 === 1,
      `CLI rc：陈旧映射 rc=${rcStale}（预校验零写入）／有效映射 rc=${rcFresh}（P-2=${okJson?.schemas?.[0]?.p2}）`)
  }

  const summary = { task: 'P3-LIFECYCLE-AB-R6', at: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results }
  fs.writeFileSync(path.join(EV, 'R6-rework.json'), JSON.stringify(summary, null, 2))
  console.log(`\nR6 定点：${summary.pass}/${summary.total} PASS`)
  await admin.$disconnect()
  process.exit(summary.fail === 0 ? 0 : 1)
}
main().catch(async (e) => {
  console.error('R6 崩溃:', e)
  fs.writeFileSync(path.join(EV, 'R6-rework.json'), JSON.stringify({ task: 'P3-LIFECYCLE-AB-R6', crash: String((e && e.stack) || e), results }, null, 2))
  try { await admin.$disconnect() } catch { /* noop */ }
  process.exit(3)
})
