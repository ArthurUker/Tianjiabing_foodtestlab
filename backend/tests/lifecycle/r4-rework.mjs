// P3-LIFECYCLE-AB-R4 · R13-1/2/3 定点（自有隔离实例；真实 PG + 真实 HTTP 路由栈）
//
// 覆盖：
//   R13-1 管理端读路径（preview/dict/samples）grant 身份 fail-closed：
//         - 缺身份/孤儿/错配/世代过期 → 403（含 code），grant 就地隔离；响应不含 items/field_schema
//         - 拒绝路径不读租户记录（用"无 schema 学校"证明：若先取样会 500，实测 403）
//         - 隔离写失败仍 403（注入 update 抛错）
//         - 同 code 重建（新 id/新 generation）→ 旧 grant 403；合法 grant 成功（preview/dict/samples 200）
//   R13-2 004 映射证据：两租户同 audit_id 各绑各的；快照/ user_id 与映射冲突非零拒绝零误写；
//         unknown/duplicate/expired/out-of-run 拒绝；有效映射绑定；摘要篡改拒绝；重跑幂等
//   R13-3 006 空快照语义统一：人类主体 + user_id NULL + {SQL NULL / jsonb null / {}} ⇒ GATE_FAIL；
//         修复（补快照）后 GATE_PASS；系统主体 + 语义空快照不误报、+ 真快照 ⇒ GATE_FAIL（G3③）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { execFileSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import { listMigrationFiles, applyTenantChain, parseDbUrl } from '../../lib/tenantProvisioner.js'
import { createAdminOpenApiRoutes } from '../../routes/adminOpenApiRoutes.js'
import { schemaNameOf } from '../../lib/tenantClient.js'

const ADMIN_URL = process.env.ADMIN_DATABASE_URL
const EV = process.env.EVIDENCE_DIR
if (!ADMIN_URL || !EV) { console.error('缺 ADMIN_DATABASE_URL / EVIDENCE_DIR'); process.exit(2) }

process.env.DATABASE_URL = ADMIN_URL // 路由内的 createTenantClient 从 env 取连接串（指向本实例）
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
const aChain = allFiles.filter((f) => f.name <= M1)   // A 期链（M1 止）：principal 可空，用于构造残量负例
const withSchema = (url, s) => `${url}${url.includes('?') ? '&' : '?'}schema=${s}`
const run004 = (args) => {
  try {
    const out = execFileSync('node', ['backend/scripts/004_backfill_audit_principals.mjs', ...args], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    })
    return { rc: 0, out }
  } catch (e) { return { rc: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') } }
}
const run006 = (args = []) => {
  try {
    const out = execFileSync('node', ['backend/scripts/006_audit_principal_gate.mjs', ...args], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    })
    return { rc: 0, out }
  } catch (e) { return { rc: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') } }
}
const parseJson = (out) => { const s = out.indexOf('{'), e = out.lastIndexOf('}'); return JSON.parse(out.slice(s, e + 1)) }
async function makeSchema(schema, files = allFiles) {
  await x(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await x(`CREATE SCHEMA "${schema}"`)
  return applyTenantChain({ prisma: admin, conn, schema, chainFiles: files, retryFailed: true, log: () => {} })
}

// ─────────────────────────── R13-1 ───────────────────────────
async function r131() {
  const CODE_OK = 'r4-http-a', CODE_NO_SCHEMA = 'r4-noschema-a'
  const sOk = schemaNameOf(CODE_OK)
  await makeSchema(sOk)
  // 租户数据（preview 成功路径需要采样行）
  await x(`INSERT INTO "${sOk}"."User" (id, username, password_hash, role, status, created_at, updated_at) VALUES ('r4u','r4u','x','manager','active',now(),now())`)
  await x(`INSERT INTO "${sOk}"."TestRecord" (id, record_code, test_type, test_name, sample_info, result_data, status, created_by, created_at, updated_at, version, data_version)
           VALUES ('r4tr','R4-HTTP-1','tableware','餐具检测','{"canteen":"A","testDate":"2026-09-01"}'::jsonb,'{"result":"合格"}'::jsonb,'completed','r4u',now(),now(),0,1)`)
  const schoolOk = await admin.school.upsert({ where: { code: CODE_OK }, update: { status: 'active' }, create: { code: CODE_OK, name: 'R4 HTTP 学校', status: 'active' } })
  const client = await admin.openApiClient.upsert({ where: { id: 'r4-client' }, update: { status: 'active' }, create: { id: 'r4-client', name: 'R4 对接方', status: 'active', rate_limit_per_min: 6000 } })
  const mkGrant = async (schoolCode, extra) => {
    const old = await admin.openApiGrant.findFirst({ where: { client_id: client.id, school_code: schoolCode } })
    if (old) await admin.openApiGrant.delete({ where: { id: old.id } })
    return admin.openApiGrant.create({ data: { client_id: client.id, school_code: schoolCode, status: 'active', scope_version: 1, ...extra } })
  }
  const app = () => express().use(express.json())
    .use((req, res, next) => { req.user = { userId: 'r4-admin', username: 'r4-admin', role: 'admin', schoolCode: null }; next() })
    .use('/api/admin/open-api', createAdminOpenApiRoutes({ prisma: admin, authenticateUser: (req, res, next) => next(), requirePlatformSuperAdmin: (req, res, next) => next() }))

  // 1) 合法 grant：三条路径成功（保留既有成功响应）
  const gOk = await mkGrant(CODE_OK, { school_id: schoolOk.id, school_generation: schoolOk.generation, visible_types: ['tableware'] })
  const pOk = await request(app()).get(`/api/admin/open-api/clients/${client.id}/preview?schoolCode=${CODE_OK}&limit=1`)
  const dOk = await request(app()).get(`/api/admin/open-api/clients/${client.id}/dict?schoolCode=${CODE_OK}`)
  const sOkRes = await request(app()).get(`/api/admin/open-api/clients/${client.id}/samples?schoolCode=${CODE_OK}`)
  rec('R13-1.1', pOk.status === 200 && Array.isArray(pOk.body?.data?.items) && pOk.body.data.items.length === 1
    && dOk.status === 200 && !!dOk.body?.data?.field_schema && sOkRes.status === 200 && Array.isArray(sOkRes.body?.data?.samples),
    `合法 grant：preview=${pOk.status}(items=${pOk.body?.data?.items?.length}) dict=${dOk.status} samples=${sOkRes.status}`)

  // 2) 缺身份 → 403 + 就地隔离；dict/samples 同判；响应不带 items/field_schema
  const gMissing = await mkGrant('r4-missing-a', {})
  await mkGrant('r4-missing-dict-a', {})   // 独立 grant：dict 单独验证（preview 的隔离不再影响它）
  const pM = await request(app()).get(`/api/admin/open-api/clients/${client.id}/preview?schoolCode=r4-missing-a`)
  const dM = await request(app()).get(`/api/admin/open-api/clients/${client.id}/dict?schoolCode=r4-missing-dict-a`)
  const gMissingAfter = await admin.openApiGrant.findUnique({ where: { id: gMissing.id } })
  const gMissingDictAfter = await admin.openApiGrant.findFirst({ where: { client_id: client.id, school_code: 'r4-missing-dict-a' } })
  rec('R13-1.2', pM.status === 403 && pM.body.code === 'GRANT_IDENTITY_MISSING' && !('items' in (pM.body.data || {}))
    && dM.status === 403 && dM.body.code === 'GRANT_IDENTITY_MISSING' && !('field_schema' in (dM.body.data || {}))
    && gMissingAfter.status === 'disabled' && Number(gMissingAfter.scope_version) === 2 && String(gMissingAfter.revoked_reason).startsWith('GRANT_IDENTITY_MISSING')
    && gMissingDictAfter.status === 'disabled',
    `缺身份：preview=${pM.status}/${pM.body.code} dict=${dM.status}/${dM.body.code}；两 grant 均已隔离`)

  // 3) 世代过期 / 错配 / 孤儿
  const schoolStale = await admin.school.upsert({ where: { code: 'r4-stale-a' }, update: { status: 'active' }, create: { code: 'r4-stale-a', name: 'R4 stale 校', status: 'active' } })
  const schoolMis = await admin.school.upsert({ where: { code: 'r4-mismatch-a' }, update: { status: 'active' }, create: { code: 'r4-mismatch-a', name: 'R4 mismatch 校', status: 'active' } })
  const gStale = await mkGrant('r4-stale-a', { school_id: schoolStale.id, school_generation: 99 })
  const gMis = await mkGrant('r4-mismatch-a', { school_id: 'other-school', school_generation: schoolMis.generation })
  const schoolTmp = await admin.school.upsert({ where: { code: 'r4-orphan-a' }, update: { status: 'active' }, create: { code: 'r4-orphan-a', name: '孤儿校', status: 'active' } })
  const gOrphan = await mkGrant('r4-orphan-a', { school_id: schoolTmp.id, school_generation: schoolTmp.generation })
  await admin.school.delete({ where: { code: 'r4-orphan-a' } }) // 学校行删除 → 孤儿
  const pStale = await request(app()).get(`/api/admin/open-api/clients/${client.id}/preview?schoolCode=r4-stale-a`)
  const pMis = await request(app()).get(`/api/admin/open-api/clients/${client.id}/preview?schoolCode=r4-mismatch-a`)
  const pOrphan = await request(app()).get(`/api/admin/open-api/clients/${client.id}/preview?schoolCode=r4-orphan-a`)
  rec('R13-1.3', pStale.status === 403 && pStale.body.code === 'GRANT_IDENTITY_STALE_GENERATION'
    && pMis.status === 403 && pMis.body.code === 'GRANT_IDENTITY_MISMATCH'
    && pOrphan.status === 403 && pOrphan.body.code === 'GRANT_IDENTITY_ORPHAN',
    `世代过期=${pStale.body.code} 错配=${pMis.body.code} 孤儿=${pOrphan.body.code}`)

  // 4) 拒绝路径不读租户记录：grant 身份无效 + 学校无 schema ⇒ 若先读租户会 500；实测 403
  const schoolNo = await admin.school.upsert({ where: { code: CODE_NO_SCHEMA }, update: { status: 'active' }, create: { code: CODE_NO_SCHEMA, name: '无 schema 校', status: 'active' } })
  const gNo = await mkGrant(CODE_NO_SCHEMA, { school_id: schoolNo.id, school_generation: 99 }) // 身份无效
  const pNo = await request(app()).get(`/api/admin/open-api/clients/${client.id}/preview?schoolCode=${CODE_NO_SCHEMA}`)
  const schemaExists = await q(`SELECT 1 FROM information_schema.schemata WHERE schema_name=$1`, schemaNameOf(CODE_NO_SCHEMA))
  rec('R13-1.4', pNo.status === 403 && schemaExists.length === 0, `拒绝先于租户读取（无 schema 学校仍 403=${pNo.status}，非 500；schema 不存在=${schemaExists.length === 0}）`)

  // 5) 隔离写失败仍 403
  const gFail = await mkGrant('r4-quarfail-a', {})
  const brokenPrisma = new Proxy(admin, {
    get(target, prop, receiver) {
      if (prop === 'openApiGrant') return new Proxy(target.openApiGrant, { get(t2, p2) { if (p2 === 'update') return async () => { throw new Error('injected quarantine write failure') }; const v = t2[p2]; return typeof v === 'function' ? v.bind(t2) : v } })
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const brokenApp = () => express().use(express.json())
    .use((req, res, next) => { req.user = { userId: 'r4-admin', role: 'admin' }; next() })
    .use('/api/admin/open-api', createAdminOpenApiRoutes({ prisma: brokenPrisma, authenticateUser: (req, res, next) => next(), requirePlatformSuperAdmin: (req, res, next) => next() }))
  const pQf = await request(brokenApp()).get(`/api/admin/open-api/clients/${client.id}/preview?schoolCode=r4-quarfail-a`)
  rec('R13-1.5', pQf.status === 403 && pQf.body.code === 'GRANT_IDENTITY_MISSING', `隔离写失败仍 403（${pQf.status}/${pQf.body.code}；不得因写失败放行）`)

  // 6) 同 code 重建：新 id/世代 ⇒ 旧 grant 403；重授（刷新 id/generation）后 200
  await admin.school.update({ where: { code: CODE_OK }, data: { generation: 1 } })
  await admin.openApiGrant.update({ where: { id: gOk.id }, data: { school_generation: 1 } })
  const rebuilt = await admin.school.update({ where: { code: CODE_OK }, data: { generation: 2 } })
  const pOld = await request(app()).get(`/api/admin/open-api/clients/${client.id}/dict?schoolCode=${CODE_OK}`)
  const regrant = await admin.openApiGrant.update({ where: { id: gOk.id }, data: { status: 'active', school_generation: rebuilt.generation, revoked_at: null, revoked_reason: null, scope_version: 3 } })
  const pNew = await request(app()).get(`/api/admin/open-api/clients/${client.id}/preview?schoolCode=${CODE_OK}&limit=1`)
  rec('R13-1.6', pOld.status === 403 && pNew.status === 200, `同 code 重建：旧 grant ${pOld.status}；显式重授后 ${pNew.status}`)
}

// ─────────────────────────── R13-2 ───────────────────────────
async function r132() {
  const SA = schemaNameOf('r4-map-a'), SB = schemaNameOf('r4-map-b')
  for (const s of [SA, SB]) {
    await x(`DROP SCHEMA IF EXISTS "${s}" CASCADE`)
    await x(`CREATE SCHEMA "${s}"`)
    await applyTenantChain({ prisma: admin, conn, schema: s, chainFiles: preFiles, retryFailed: true, log: () => {} })
    await x(`INSERT INTO "${s}"."User" (id, username, password_hash, role, status, created_at, updated_at) VALUES ('${s}-u1','u1','x','operator','active',now(),now()),('${s}-u2','u2','x','operator','active',now(),now())`)
    // 无稳定主体的行（user_id NULL + 仅 username 快照）与稳定主体行，靠"先建后收紧"构造
    await x(`INSERT INTO "${s}"."AuditLog" (id, user_id, action, created_at) VALUES ('shared-1','${s}-u1','login',now()),('stable-1','${s}-u1','export',now()),('snapstable-1','${s}-u2','create',now())`)
    await applyTenantChain({ prisma: admin, conn, schema: s, chainFiles: aChain, retryFailed: true, log: () => {} })
    // 模拟残量：shared-1 置为 username-only（无 user_id、无快照 subject）——A 期（M1 止）语义
    await x(`ALTER TABLE "${s}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`)
    await x(`UPDATE "${s}"."AuditLog" SET user_id=NULL, principal_id=NULL, actor_snapshot='{"source":"import","username":"ghost"}'::jsonb WHERE id='shared-1'`)
    await x(`UPDATE "${s}"."AuditLog" SET principal_id=NULL, actor_snapshot='{"source":"event","subject_user_id":"${s}-u2"}'::jsonb WHERE id='snapstable-1'`)
    await x(`ALTER TABLE "${s}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`)
  }
  const mapFile = (name, rows) => { const p = path.join(EV, name); fs.writeFileSync(p, JSON.stringify(rows, null, 2)); const d = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); return { p, d } }
  // R14-1：映射行必须携带 pre 事实块（此处用产品 --print-pre 生成，避免手算整快照摘要）
  const preFor = (schema, auditId) => {
    try {
      const out = execFileSync('node', ['backend/scripts/004_backfill_audit_principals.mjs', '--print-pre', `${schema}:${auditId}`], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_URL: ADMIN_URL }, encoding: 'utf8',
      })
      return JSON.parse(out).pre
    } catch {
      // 目标不存在（unknown-target 用例）：给结构合法的占位 pre，让"未知目标"判据在工作流中触发
      return { user_id: null, principal_id: null, actor_snapshot_sha256: null }
    }
  }
  const rowT = (schema, auditId, subject, extra = {}) => ({ schema, audit_id: auditId, subject_user_id: subject, evidence: 'offline-review-2026-09-27', approved_by: 'r4-reviewer', reviewed_at: new Date().toISOString(), pre: preFor(schema, auditId), ...extra })

  // 1) 两租户同 audit_id：各绑各的（不得跨租户套用）
  const m1 = mapFile('r4-map-both.json', [rowT(SA, 'shared-1', `${SA}-u1`), rowT(SB, 'shared-1', `${SB}-u1`)])
  const r1 = run004(['--all-tenants', '--mapping', m1.p, '--expect-digest', m1.d])
  const a1 = await q(`SELECT principal_id FROM "${SA}"."AuditLog" WHERE id='shared-1'`)
  const b1 = await q(`SELECT principal_id FROM "${SB}"."AuditLog" WHERE id='shared-1'`)
  const aSub = a1[0].principal_id ? (await q(`SELECT subject_user_id FROM "${SA}"."AuditPrincipal" WHERE id=$1`, a1[0].principal_id))[0].subject_user_id : null
  const bSub = b1[0].principal_id ? (await q(`SELECT subject_user_id FROM "${SB}"."AuditPrincipal" WHERE id=$1`, b1[0].principal_id))[0].subject_user_id : null
  rec('R13-2.1', r1.rc === 0 && aSub === `${SA}-u1` && bSub === `${SB}-u1`, `两租户同 audit_id 各绑各的（A=${aSub} B=${bSub}）`)

  // 2) 重跑幂等（同映射再跑：零新写入、rc=0）
  const before = await q(`SELECT count(*)::int AS n FROM "${SA}"."AuditPrincipal"`)
  const r2 = run004(['--all-tenants', '--mapping', m1.p, '--expect-digest', m1.d])
  const after = await q(`SELECT count(*)::int AS n FROM "${SA}"."AuditPrincipal"`)
  rec('R13-2.2', r2.rc === 0 && before[0].n === after[0].n, `重跑幂等：principals ${before[0].n}→${after[0].n} rc=${r2.rc}`)

  // 复位工具：把指定行恢复为"未绑定"（drop CHECK → 置 NULL → 还原 CHECK；A 期语义）
  const resetUnbound = async (schema, ids) => {
    await x(`ALTER TABLE "${schema}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`)
    for (const id of ids) await x(`UPDATE "${schema}"."AuditLog" SET principal_id=NULL WHERE id=$1`, id)
    await x(`ALTER TABLE "${schema}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`)
  }

  // 3) user_id 稳定值 vs 映射冲突 ⇒ 非零拒绝、零误写（先复位为未绑定态）
  await resetUnbound(SA, ['stable-1'])
  const mConflictUser = mapFile('r4-map-cf-user.json', [rowT(SA, 'stable-1', 'someone-else')])
  const preRow = await q(`SELECT principal_id, user_id FROM "${SA}"."AuditLog" WHERE id='stable-1'`)
  const rc3 = run004(['--schema', SA, '--mapping', mConflictUser.p, '--expect-digest', mConflictUser.d])
  const postRow = await q(`SELECT principal_id, user_id FROM "${SA}"."AuditLog" WHERE id='stable-1'`)
  const otherPid = await q(`SELECT 1 FROM "${SA}"."AuditPrincipal" WHERE subject_user_id='someone-else'`)
  rec('R13-2.3', rc3.rc !== 0 && JSON.stringify(preRow) === JSON.stringify(postRow) && otherPid.length === 0,
    `user_id 冲突 ⇒ rc=${rc3.rc}，行未变、未建档 someone-else`)

  // 4) 快照 subject 稳定值 vs 映射冲突 ⇒ 非零拒绝、零误写（快照优先，不得被映射覆盖）
  await resetUnbound(SA, ['snapstable-1'])
  const mConflictSnap = mapFile('r4-map-cf-snap.json', [rowT(SA, 'snapstable-1', 'mapped-else')])
  const snapPre = await q(`SELECT principal_id, actor_snapshot FROM "${SA}"."AuditLog" WHERE id='snapstable-1'`)
  const rc4 = run004(['--schema', SA, '--mapping', mConflictSnap.p, '--expect-digest', mConflictSnap.d])
  const snapPost = await q(`SELECT principal_id, actor_snapshot FROM "${SA}"."AuditLog" WHERE id='snapstable-1'`)
  rec('R13-2.4', rc4.rc !== 0 && JSON.stringify(snapPre) === JSON.stringify(snapPost), `快照冲突 ⇒ rc=${rc4.rc}（映射不得覆盖稳定快照），行未变`)

  // 5) 快照稳定值优先、同值映射不冲突（幂等容忍）→ 绑定应来自快照
  const mSameSnap = mapFile('r4-map-same-snap.json', [rowT(SA, 'snapstable-1', `${SA}-u2`)])
  const rc5 = run004(['--schema', SA, '--mapping', mSameSnap.p, '--expect-digest', mSameSnap.d])
  const snapBound = await q(`SELECT a.principal_id, p.subject_user_id, a.actor_snapshot->>'source' AS src FROM "${SA}"."AuditLog" a LEFT JOIN "${SA}"."AuditPrincipal" p ON p.id=a.principal_id WHERE a.id='snapstable-1'`)
  rec('R13-2.5', rc5.rc === 0 && snapBound[0].subject_user_id === `${SA}-u2` && snapBound[0].src !== 'mapping',
    `同值映射不冲突；绑定来源=快照（subject=${snapBound[0].subject_user_id} source=${snapBound[0].src}）`)

  // 6) unknown / duplicate / expired / out-of-run 拒绝
  const mUnknown = mapFile('r4-map-unknown.json', [rowT(SA, 'no-such-id', 'x')])
  const rcU = run004(['--schema', SA, '--mapping', mUnknown.p, '--expect-digest', mUnknown.d])
  const mDup = mapFile('r4-map-dup.json', [rowT(SA, 'shared-1', `${SA}-u1`), rowT(SA, 'shared-1', `${SA}-u2`)])
  const rcD = run004(['--schema', SA, '--mapping', mDup.p, '--expect-digest', mDup.d])
  const mExp = mapFile('r4-map-expired.json', [rowT(SA, 'shared-1', `${SA}-u1`, { valid_until: '2026-01-01T00:00:00Z' })])
  const rcE = run004(['--schema', SA, '--mapping', mExp.p, '--expect-digest', mExp.d])
  const mOut = mapFile('r4-map-outrun.json', [rowT(SB, 'shared-1', `${SB}-u1`)])
  const rcO = run004(['--schema', SA, '--mapping', mOut.p, '--expect-digest', mOut.d])
  rec('R13-2.6', rcU.rc !== 0 && rcD.rc !== 0 && rcE.rc !== 0 && rcO.rc !== 0,
    `unknown=${rcU.rc} duplicate=${rcD.rc} expired=${rcE.rc} out-of-run=${rcO.rc}（全非零）`)

  // 7) 摘要篡改拒绝 + 缺失证据字段拒绝
  const mTamper = mapFile('r4-map-tamper.json', [rowT(SA, 'shared-1', `${SA}-u1`)])
  fs.appendFileSync(mTamper.p, '\n') // 篡改（文件内容变了，摘要预期仍用旧值）
  const rcT = run004(['--schema', SA, '--mapping', mTamper.p, '--expect-digest', mTamper.d])
  const mBadEvidence = mapFile('r4-map-noev.json', [{ schema: SA, audit_id: 'shared-1', subject_user_id: `${SA}-u1` }])
  const rcB = run004(['--schema', SA, '--mapping', mBadEvidence.p, '--expect-digest', mBadEvidence.d])
  rec('R13-2.7', rcT.rc !== 0 && rcB.rc !== 0, `摘要篡改=${rcT.rc}；缺 evidence/approved_by/reviewed_at=${rcB.rc}（SHA 正确不能单独证明归属）`)
}

// ─────────────────────────── R13-3 ───────────────────────────
async function r133() {
  // 门禁扫描 public.School 全量：本用例做**作用域收窄**（只保留 G3 校）以便用整体 rc 断言，
  // 其余 r4-* 学校行属前述用例的 fixture（scratch，删除不影响已留存证据）
  await x(`DELETE FROM public."School" WHERE code <> 'r4-g3-a'`)
  const S = schemaNameOf('r4-g3-a')
  await makeSchema(S)
  await admin.school.upsert({ where: { code: 'r4-g3-a' }, update: { status: 'active' }, create: { code: 'r4-g3-a', name: 'R4 G3 校', status: 'active' } })
  await x(`INSERT INTO "${S}"."User" (id, username, password_hash, role, status, created_at, updated_at) VALUES ('g3u','g3u','x','operator','active',now(),now())`)
  // 人类主体 + 无主体 + 三种语义空快照
  const pid = 'principal:g3test'
  await x(`INSERT INTO "${S}"."AuditPrincipal" (id,kind,scope_key,subject_user_id,origin,observed_at) VALUES ($1,'user',$2,'g3u','backfilled',now())`, pid, S)
  await x(`ALTER TABLE "${S}"."AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_principal_id_required_new"`)
  await x(`INSERT INTO "${S}"."AuditLog" (id, user_id, action, principal_id, actor_snapshot, created_at) VALUES
     ('g3-sql-null', NULL, 'login', '${pid}', NULL, now()),
     ('g3-json-null', NULL, 'login', '${pid}', 'null'::jsonb, now()),
     ('g3-empty-obj', NULL, 'login', '${pid}', '{}'::jsonb, now())`)
  await x(`ALTER TABLE "${S}"."AuditLog" ADD CONSTRAINT "AuditLog_principal_id_required_new" CHECK ("principal_id" IS NOT NULL) NOT VALID`)
  const sysPid = `system-principal:${S}`
  await x(`INSERT INTO "${S}"."AuditPrincipal" (id,kind,scope_key,subject_user_id,subject_username,origin,observed_at) VALUES ($1,'system',$2,'system','system','system',now()) ON CONFLICT ("scope_key","subject_user_id") DO NOTHING`, sysPid, S)
  const g1 = run006(['--json', path.join(EV, 'R13-3-gate-fail.json')])
  const g1j = parseJson(g1.out)
  const t1 = g1j.tenants.find((t) => t.schema === S)
  rec('R13-3.1', g1.rc !== 0 && t1 && t1.G3_4 === 3 && t1.problems.some((p) => p.includes('G3④')),
    `人类主体 + 三种语义空快照（SQL NULL/jsonb null/{}）⇒ GATE_FAIL、G3④=${t1?.G3_4}`)

  // 系统主体 + 语义空快照：不误报（G3③ 语义判空）；系统主体 + 真快照：GATE_FAIL（G3③）
  await x(`INSERT INTO "${S}"."AuditLog" (id, user_id, action, principal_id, actor_snapshot, created_at) VALUES ('g3-sys-empty', NULL, 'export', $1, '{}'::jsonb, now())`, sysPid)
  const g2 = run006(); const t2 = parseJson(g2.out).tenants.find((t) => t.schema === S)
  rec('R13-3.2', t2 && t2.G3_3 === 0, `系统主体 + '{}' 语义空快照不触发 G3③（G3③=${t2?.G3_3}）`)
  await x(`INSERT INTO "${S}"."AuditLog" (id, user_id, action, principal_id, actor_snapshot, created_at) VALUES ('g3-sys-real', NULL, 'export', $1, '{"source":"event","subject_user_id":"g3u"}'::jsonb, now())`, sysPid)
  const g3 = run006(); const t3 = parseJson(g3.out).tenants.find((t) => t.schema === S)
  rec('R13-3.3', g3.rc !== 0 && t3 && t3.G3_3 === 1, `系统主体 + 真快照 ⇒ GATE_FAIL、G3③=${t3?.G3_3}`)

  // 修复：清掉系统行真快照（置空）+ 三条人类行补主体快照 ⇒ GATE_PASS
  await x(`UPDATE "${S}"."AuditLog" SET actor_snapshot=NULL WHERE id='g3-sys-real'`)
  await x(`UPDATE "${S}"."AuditLog" SET actor_snapshot='{"source":"m2_backfill","subject_user_id":"g3u"}'::jsonb WHERE id IN ('g3-sql-null','g3-json-null','g3-empty-obj')`)
  // 负例阶段 drop/readd 使 convalidated=false；数据现已一致 ⇒ 还原 M2 的 VALIDATE 状态（G8）
  await x(`ALTER TABLE "${S}"."AuditLog" VALIDATE CONSTRAINT "AuditLog_principal_id_required_new"`)
  const g4 = run006(['--json', path.join(EV, 'R13-3-gate-pass.json')])
  rec('R13-3.4', g4.rc === 0, `修复（补主体快照/清系统真快照）后 GATE_PASS（rc=${g4.rc}）`)
}

const main = async () => {
  await r131()
  await r132()
  await r133()
  const summary = { task: 'P3-LIFECYCLE-AB-R4', at: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results }
  fs.writeFileSync(path.join(EV, 'R4-rework.json'), JSON.stringify(summary, null, 2))
  console.log(`\nR4 定点：${summary.pass}/${summary.total} PASS`)
  await admin.$disconnect()
  process.exit(summary.fail === 0 ? 0 : 1)
}
main().catch(async (e) => {
  console.error('R4 崩溃:', e)
  fs.writeFileSync(path.join(EV, 'R4-rework.json'), JSON.stringify({ task: 'P3-LIFECYCLE-AB-R4', crash: String((e && e.stack) || e), results }, null, 2))
  try { await admin.$disconnect() } catch { /* noop */ }
  process.exit(3)
})
