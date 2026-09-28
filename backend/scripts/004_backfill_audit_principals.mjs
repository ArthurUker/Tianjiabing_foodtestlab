// 004_backfill_audit_principals.mjs — P3-LIFECYCLE-AB-R4 · Release B1 回填（幂等、可 dry-run、可重入）
//
// 目标：把 AuditLog 中 `principal_id IS NULL` 的历史行按 R9 可证明性规则绑定主体：
//   P-0 principal 已非空                 → skip
//   P-1 user_id 非空（稳定主体 id，FK 兜底）→ 建档并绑定（写 provenance 快照）
//   P-1b 快照含合法 subject_user_id        → 建档并绑定（形态非法 ⇒ 拒绝，不建档）
//   P-2 外部映射证据（--mapping + --expect-digest）→ 逐行绑定（**仅当无稳定主体值时**）
//   P-3 仅 username / 无稳定锚点           → **拒绝**（进待人工清单；不猜测、不改行）
//   P-4 user_id 与 actor_snapshot 皆无     → 绑系统主体
//
// R13-2 修正：
//   · 映射按 **(schema, audit_id)** 精确定位 —— 不同租户的同名 audit_id 绝不共用（禁止跨租户套用）；
//   · 映射**只在** `user_id` 与 `actor_snapshot.subject_user_id` 均无稳定值时适用；
//   · 与稳定值冲突、重复行、未知目标、过期行 ⇒ **整体非零拒绝，零写入**（先全量只读预校验，再回填）；
//   · 每行映射必须携带可审证据（evidence / approved_by / reviewed_at）；
//   · **文件 SHA-256 只是完整性校验，不能单独证明身份归属**。
//
// R14-1 修正（本版，收紧陈旧判据）：
//   · **P-2 每行 `pre` 为必填合同**（可选 `valid_until` 不能作为唯一陈旧判据）：
//       pre = { user_id, principal_id, actor_snapshot_sha256 }
//     `actor_snapshot_sha256` = 完整 actor_snapshot 的**规范化摘要**（递归键排序后无空白 JSON 文本的 sha256；
//     SQL NULL ⇒ null）。**仅核 subject_user_id 不足以发现 username-only 等快照变化**，故必须整对象摘要。
//   · 未绑定目标：pre 三项必须与当前 DB 事实一致（user_id / principal_id / 快照摘要）——不符即 `stale_mapping_pre_state`；
//   · **已绑定目标**（principal_id 非空）：核对 `AuditPrincipal.scope_key == schema` 且
//     `subject_user_id == 映射主体` —— 一致才允许**幂等重跑**（skip）；不一致 ⇒ `mapping_conflicts_with_bound_principal`
//     **整体非零拒绝**（不得直接跳过，也不得改写历史已绑定主体）；
//   · 绑定 UPDATE 按预校验事实做**条件保护**（`principal_id IS NULL AND user_id/pre 快照 不变`）并检查影响行数。
//   · 辅助：`--print-pre <schema>:<audit_id>` 打印可直接粘贴的 pre 事实块（避免手算摘要失误）。
//
// R15/R6 修正（并发陈旧绑定；**本文件的最终判据与原子边界**）：
//   · 映射绑定的**最后判据 = 证据文件 `pre`**（不再只比"重读值"）：在**行事务内**重读目标行 →
//     与 `pre` 逐项对齐（user_id / principal_id / 整快照摘要）→ 不符即 `STALE_MAPPING_PRE_STATE_AT_BIND`；
//     由此堵住"预校验后用另一 username-only 快照替换事实、再被重读放行"的错绑时序（R15 §未闭合）。
//   · **主体建档与审计绑定在同一事务**（`runAtomic`：真实客户端 = `$transaction`；等价原子边界见下）：
//     UPDATE 影响 0 行 / 判据不符 / 任何异常 ⇒ 事务回滚，**绝不留下孤立 AuditPrincipal**。
//   · **原子性边界（准确表述，撤回旧"任何失败整体零写入"）**：
//       - 映射**预校验失败**（结构/冲突/未知/过期/跑外）⇒ 只读阶段失败 ⇒ **零写入**（全批）；
//       - **运行期**行级失败（race / stale / 目标消失）⇒ 该**行事务**回滚（主体+绑定原子），进程非零退出并**停止后续行**；
//         但**此前已提交的行不回滚**（无全批事务；逐行事务 + 逐校顺序执行）。
//   · `--all-tenants` 语义 = 逐校顺序 + 逐行事务；**不是**全批原子。
//   · 测试用 DI 钩子：`runBackfill({ testHooks: { afterPrevalidate, beforeMappedBind } })`（仅注入点，无产品分支）。
//
// 用法：
//   node backend/scripts/004_backfill_audit_principals.mjs --dry-run [--schema <s>|--all-tenants] [--mapping <file> --expect-digest <sha256>]
//   node backend/scripts/004_backfill_audit_principals.mjs [--schema <s>|--all-tenants] [--mapping <file> --expect-digest <sha256>] [--json <out>]
//   node backend/scripts/004_backfill_audit_principals.mjs --print-pre <schema>:<audit_id>     # 生成映射 pre 事实块
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { schemaNameOf } from '../lib/tenantClient.js'

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f, d = null) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const DRY = has('--dry-run')
const ALL = has('--all-tenants')
const SCHEMA = val('--schema')
const MAPPING_FILE = val('--mapping')
const EXPECT_DIGEST = val('--expect-digest')
const JSON_OUT = val('--json')
const BASE_URL = process.env.DATABASE_URL
/** CLI 判定：导入本模块（测试注入 runBackfill）时**不得**触发任何 process.exit / 连接。 */
export const isMain = !!process.argv[1] && process.argv[1].endsWith('004_backfill_audit_principals.mjs')
if (isMain) {
  if (!BASE_URL) { console.error('需要 DATABASE_URL（管理连接串）'); process.exit(2) }
  if (!SCHEMA && !ALL && !has('--print-pre')) { console.error('需要 --schema <schema> 或 --all-tenants（或 --print-pre）'); process.exit(2) }
  if (MAPPING_FILE && !EXPECT_DIGEST) { console.error('--mapping 必须同时提供 --expect-digest <sha256>（证据完整性）'); process.exit(2) }
}

const admin = isMain || BASE_URL ? new PrismaClient({ datasources: { db: { url: BASE_URL } } }) : null
const withSchema = (url, schema) => `${url}${url.includes('?') ? '&' : '?'}schema=${schema}`
const subjectOk = (v) => typeof v === 'string' && v.length > 0 && v.length <= 191 && !/[\u0000-\u001f\s]/.test(v)
const schemaOk = (v) => typeof v === 'string' && /^[a-zA-Z0-9_]{1,63}$/.test(v)
const mkey = (schema, auditId) => `${schema}\u0000${auditId}`

/** 规范化 JSON：递归键排序 + 无空白（数组保序）。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}

/** 完整 actor_snapshot 的规范化摘要；SQL NULL ⇒ null（与 jsonb 'null' 区分：后者摘要 = sha256('null')）。 */
export function snapshotDigestFromText(snapText, isSqlNull) {
  if (isSqlNull) return null
  let parsed
  try { parsed = JSON.parse(snapText) } catch { return `RAW:${crypto.createHash('sha256').update(String(snapText)).digest('hex')}` }
  return crypto.createHash('sha256').update(canonicalJson(parsed)).digest('hex')
}

/** 候选租户 schema = School 行推导 ∪ 现存 school_* 目录；再过滤为**实际存在 AuditLog 表**者（其余计入 skipped）。 */
export async function listTenantSchemas() {
  const rows = await admin.$queryRawUnsafe(`SELECT code FROM public."School" ORDER BY code`)
  const schemas = rows.map((r) => schemaNameOf(r.code)).filter(Boolean)
  const extra = await admin.$queryRawUnsafe(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'school\\_%' ORDER BY schema_name`)
  const fromDb = extra.map((r) => r.schema_name)
  const candidates = [...new Set([...schemas, ...fromDb])]
  const usable = []
  const skipped = []
  for (const s of candidates) {
    // 可回填前提：AuditLog 存在且已有 M1 列面（principal_id + actor_snapshot）——
    // 未推进到 M1 的 schema/幻影 schema 一律跳过并登记（不得对其回填，也不得崩溃）
    const has = await admin.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='AuditLog' AND column_name IN ('principal_id','actor_snapshot')`, s)
    if (has[0].n === 2) usable.push(s); else skipped.push({ schema: s, reason: 'auditlog_or_m1_columns_missing' })
  }
  return { usable, skipped }
}

/** 读取 + 结构校验映射证据（重复/缺证据/过期 ⇒ 直接拒绝；SHA 只作完整性门槛）。 */
export function loadMappingEvidence() {
  const buf = fs.readFileSync(MAPPING_FILE)
  const digest = crypto.createHash('sha256').update(buf).digest('hex')
  if (digest !== EXPECT_DIGEST) {
    throw new Error(`映射证据摘要不符：expect=${EXPECT_DIGEST} actual=${digest}（拒绝按未验证证据绑定）`)
  }
  const rows = JSON.parse(buf.toString('utf8'))
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('映射证据为空或非数组')
  return { digest, ...validateMappingRows(rows) }
}

/** 行级结构校验（导出供测试与 CLI 共用；返回 { map, rows, problems }）。 */
export function validateMappingRows(rows) {
  const map = new Map()
  const problems = []
  rows.forEach((r, i) => {
    const where = `row[${i}]`
    if (!r || typeof r !== 'object') { problems.push({ i, reason: 'row_not_object' }); return }
    if (!schemaOk(r.schema)) problems.push({ i, reason: 'schema_invalid', where })
    if (typeof r.audit_id !== 'string' || !r.audit_id) problems.push({ i, reason: 'audit_id_invalid', where })
    if (!subjectOk(r.subject_user_id)) problems.push({ i, reason: 'subject_user_id_invalid', where })
    // 可审证据：来源 + 审批痕迹 + 复核时间（SHA 完整性不能替代这些字段）
    if (typeof r.evidence !== 'string' || r.evidence.trim().length < 4) problems.push({ i, reason: 'evidence_missing', where })
    if (typeof r.approved_by !== 'string' || !r.approved_by.trim()) problems.push({ i, reason: 'approved_by_missing', where })
    if (typeof r.reviewed_at !== 'string' || Number.isNaN(Date.parse(r.reviewed_at))) problems.push({ i, reason: 'reviewed_at_invalid', where })
    // R14-1：pre 为**必填**绑定前事实（缺 pre ⇒ 拒绝；valid_until 不能替代）
    const pre = r.pre
    if (pre == null || typeof pre !== 'object' || Array.isArray(pre)) {
      problems.push({ i, reason: 'pre_required_missing', where })
    } else {
      if (!('user_id' in pre)) problems.push({ i, reason: 'pre_user_id_missing', where })
      else if (pre.user_id != null && !subjectOk(pre.user_id)) problems.push({ i, reason: 'pre_user_id_invalid', where })
      if (!('principal_id' in pre)) problems.push({ i, reason: 'pre_principal_id_missing', where })
      else if (pre.principal_id != null && typeof pre.principal_id !== 'string') problems.push({ i, reason: 'pre_principal_id_invalid', where })
      if (!('actor_snapshot_sha256' in pre)) problems.push({ i, reason: 'pre_snapshot_digest_missing', where })
      else if (pre.actor_snapshot_sha256 != null && !/^[0-9a-f]{64}$/.test(String(pre.actor_snapshot_sha256))) {
        problems.push({ i, reason: 'pre_snapshot_digest_invalid', where })
      }
    }
    if (r.valid_until != null && (typeof r.valid_until !== 'string' || Number.isNaN(Date.parse(r.valid_until)))) {
      problems.push({ i, reason: 'valid_until_invalid', where })
    } else if (r.valid_until != null && Date.parse(r.valid_until) < Date.now()) {
      problems.push({ i, reason: 'mapping_expired', where, valid_until: r.valid_until })
    }
    if (problems.some((p) => p.i === i)) return
    const k = mkey(r.schema, r.audit_id)
    if (map.has(k)) { problems.push({ i, reason: 'duplicate_mapping_row', where, key: `${r.schema}/${r.audit_id}` }); return }
    map.set(k, { ...r, _index: i })
  })
  if (problems.length) {
    const err = new Error(`映射证据结构校验失败（${problems.length} 项）：${JSON.stringify(problems.slice(0, 6))}`)
    err.code = 'MAPPING_EVIDENCE_INVALID'
    err.problems = problems
    throw err
  }
  return { map, rows: rows.length, problems }
}

/**
 * 只读预校验：把映射与 DB 现状对照（未知目标 / 与稳定主体冲突 / pre 绑定前事实不符）。
 * **任何问题 ⇒ 调用方整体非零退出，零写入。**
 */
export async function validateMappingAgainstDb(mapping, schemas) {
  const problems = []
  const schemaSet = new Set(schemas)
  const bySchema = new Map()
  for (const m of mapping.map.values()) {
    if (!schemaSet.has(m.schema)) { problems.push({ reason: 'mapping_schema_out_of_run', key: `${m.schema}/${m.audit_id}` }); continue }
    if (!bySchema.has(m.schema)) bySchema.set(m.schema, [])
    bySchema.get(m.schema).push(m)
  }
  for (const [schema, rows] of bySchema) {
    for (const m of rows) {
      const found = await admin.$queryRawUnsafe(
        `SELECT "id", "principal_id", "user_id", "actor_snapshot"::text AS snap_text, "actor_snapshot" IS NULL AS is_sql_null
           FROM "${schema}"."AuditLog" WHERE "id" = $1`, m.audit_id)
      if (!found.length) { problems.push({ reason: 'unknown_mapping_target', key: `${schema}/${m.audit_id}` }); continue }
      const row = found[0]
      const curDigest = snapshotDigestFromText(row.snap_text, row.is_sql_null)
      if (row.principal_id) {
        // R14-1：已绑定 ⇒ **核对既有主体**（scope_key + subject_user_id）与映射一致才允许幂等重跑；
        // 不一致（或主体行缺失）⇒ 整体非零拒绝（不得直接跳过、不得改写历史已绑定主体）。
        const p = await admin.$queryRawUnsafe(
          `SELECT "scope_key", "subject_user_id", "kind" FROM "${schema}"."AuditPrincipal" WHERE "id" = $1`, row.principal_id)
        const bound = p[0]
        if (!bound) {
          problems.push({ reason: 'mapping_bound_principal_missing', key: `${schema}/${m.audit_id}`, principal_id: row.principal_id })
        } else if (bound.scope_key !== schema || bound.subject_user_id !== m.subject_user_id) {
          problems.push({
            reason: 'mapping_conflicts_with_bound_principal', key: `${schema}/${m.audit_id}`,
            bound: { scope_key: bound.scope_key, subject_user_id: bound.subject_user_id, kind: bound.kind },
            mapped: m.subject_user_id,
          })
        }
        continue
      }
      const snapSubj = (() => { try { return JSON.parse(row.snap_text)?.subject_user_id ?? null } catch { return null } })()
      if (row.user_id != null && row.user_id !== m.subject_user_id) {
        problems.push({ reason: 'mapping_conflicts_with_user_id', key: `${schema}/${m.audit_id}`, stable: row.user_id, mapped: m.subject_user_id })
        continue
      }
      if (row.user_id == null && snapSubj != null && snapSubj !== m.subject_user_id) {
        problems.push({ reason: 'mapping_conflicts_with_snapshot', key: `${schema}/${m.audit_id}`, stable: snapSubj, mapped: m.subject_user_id })
        continue
      }
      // R14-1：pre 三项逐一对齐（含**整快照规范化摘要**，可发现 username-only 变化）
      const pre = m.pre
      const preUser = pre.user_id ?? null
      const prePid = pre.principal_id ?? null
      const preDigest = pre.actor_snapshot_sha256 ?? null
      if (preUser !== (row.user_id ?? null) || prePid !== (row.principal_id ?? null) || preDigest !== curDigest) {
        problems.push({
          reason: 'stale_mapping_pre_state', key: `${schema}/${m.audit_id}`,
          expect: { user_id: preUser, principal_id: prePid, actor_snapshot_sha256: preDigest },
          actual: { user_id: row.user_id ?? null, principal_id: row.principal_id ?? null, actor_snapshot_sha256: curDigest },
        })
      }
    }
  }
  return problems
}

// ───────────────────────── R6：原子绑定原语 ─────────────────────────
/** 原子边界：真实客户端 = 单事务；受限替身/已在事务中的客户端 = 直接执行（等效边界，见文件头）。 */
export const runAtomic = (db, fn) => (db && typeof db.$transaction === 'function'
  ? db.$transaction(fn, { timeout: 30_000, maxWait: 10_000 })   // 回填事务短；余量供测试/慢主机（仅事务边界，非判据）
  : fn(db))

const raceError = (msg, code = 'MAPPING_RACE_OR_STALE') => Object.assign(new Error(msg), { code })
const staleAtBindError = (detail) => Object.assign(
  new Error(`STALE_MAPPING_PRE_STATE_AT_BIND: ${detail.schema}/${detail.auditId}（绑定点判据 = 映射证据 pre；事实已变，拒绝误绑）`),
  { code: 'STALE_MAPPING_PRE_STATE_AT_BIND', detail })

/** 事务内：主体建档（幂等；返回真实 id；DRY 只计算不写）。 */
async function ensureSubjectTx(tx, schema, subj, origin) {
  const pid = 'principal:b4:' + crypto.createHash('sha256').update(`${schema}\0${subj}`).digest('hex').slice(0, 24)
  if (DRY) return pid
  await tx.$executeRawUnsafe(
    `INSERT INTO "AuditPrincipal" ("id","kind","scope_key","subject_user_id","origin","observed_at")
     VALUES ($1,'user',$2,$3,$4,now()) ON CONFLICT ("scope_key","subject_user_id") DO NOTHING`,
    pid, schema, subj, origin)
  const rows = await tx.$queryRawUnsafe(
    `SELECT "id" FROM "AuditPrincipal" WHERE "scope_key"=$1 AND "subject_user_id"=$2 LIMIT 1`, schema, subj)
  return rows[0]?.id || pid
}

async function readRowTx(tx, schema, auditId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT "principal_id", "user_id", "actor_snapshot"::text AS snap_text, "actor_snapshot" IS NULL AS is_sql_null
       FROM "${schema}"."AuditLog" WHERE "id" = $1`, auditId)
  return rows[0] || null
}

/**
 * 映射行绑定（R6 核心）：**事务内**重读 → 与 `pre` 逐项对齐（最终判据同源）→ 建档 → 条件保护 UPDATE。
 * 任一步失败 ⇒ 抛错 ⇒ 事务回滚（不留下新主体、不改审计行）。
 */
async function bindMappedRowAtomic(db, { schema, auditId, mapped, testHooks }) {
  return runAtomic(db, async (tx) => {
    const pre = mapped.pre
    const row = await readRowTx(tx, schema, auditId)
    if (!row) throw raceError(`mapping_target_missing: ${schema}/${auditId}`)
    if (row.principal_id) {
      const p = await tx.$queryRawUnsafe(
        `SELECT "scope_key", "subject_user_id", "kind" FROM "${schema}"."AuditPrincipal" WHERE "id"=$1`, row.principal_id)
      const bound = p[0]
      if (bound && bound.kind === 'user' && bound.scope_key === schema && bound.subject_user_id === mapped.subject_user_id) {
        return { alreadyBound: true, principalId: row.principal_id, affected: 0 }
      }
      throw raceError(`mapping_conflicts_with_bound_principal_at_bind: ${schema}/${auditId}`)
    }
    const digest = snapshotDigestFromText(row.snap_text, row.is_sql_null)
    if ((row.user_id ?? null) !== (pre.user_id ?? null) || digest !== (pre.actor_snapshot_sha256 ?? null)) {
      throw staleAtBindError({
        schema, auditId,
        expect: { user_id: pre.user_id ?? null, actor_snapshot_sha256: pre.actor_snapshot_sha256 ?? null },
        actual: { user_id: row.user_id ?? null, actor_snapshot_sha256: digest },
      })
    }
    if (testHooks?.beforeMappedBind) await testHooks.beforeMappedBind({ schema, auditId, tx })
    const pid = await ensureSubjectTx(tx, schema, mapped.subject_user_id, 'mapping')
    const affected = DRY ? 1 : await tx.$executeRawUnsafe(
      `UPDATE "${schema}"."AuditLog"
          SET "principal_id"=$1,
              "actor_snapshot" = COALESCE("actor_snapshot", jsonb_build_object('source','mapping','observed_at',now(),'subject_user_id',$2))
        WHERE "id"=$3 AND "principal_id" IS NULL
          AND "user_id" IS NOT DISTINCT FROM $4
          AND "actor_snapshot" IS NOT DISTINCT FROM $5::jsonb`,
      pid, mapped.subject_user_id, auditId, row.user_id ?? null, row.is_sql_null ? null : row.snap_text)
    if (affected !== 1) throw raceError(`MAPPING_RACE_OR_STALE: ${schema}/${auditId} 影响行数=${affected}（重读→UPDATE 之间事实变化；拒绝误绑）`)
    return { alreadyBound: false, principalId: pid, affected }
  })
}

/** 派生绑定（P-1 / P-1b / P-4）：事务内重读（事实即判据）→ 建档 → 条件保护 UPDATE；0 行 ⇒ 并发已绑则幂等跳过，否则回滚报错。 */
async function bindDerivedAtomic(db, { schema, auditId, subjectUserId = null, source = 'backfill', systemPid = null }) {
  return runAtomic(db, async (tx) => {
    const row = await readRowTx(tx, schema, auditId)
    if (!row) return { alreadyBound: true, affected: 0 }
    if (row.principal_id) return { alreadyBound: true, principalId: row.principal_id, affected: 0 }
    let pid = systemPid
    if (!subjectUserId) {
      if (!DRY) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "AuditPrincipal" ("id","kind","scope_key","subject_user_id","subject_username","origin","observed_at")
           VALUES ($1,'system',$2,'system','system','system',now()) ON CONFLICT ("scope_key","subject_user_id") DO NOTHING`,
          systemPid, schema)
      }
    } else {
      pid = await ensureSubjectTx(tx, schema, subjectUserId, source === 'mapping' ? 'mapping' : 'backfilled')
    }
    const args = subjectUserId
      ? [pid, subjectUserId, source, auditId, row.user_id ?? null, row.is_sql_null ? null : row.snap_text]
      : [pid, auditId, row.user_id ?? null, row.is_sql_null ? null : row.snap_text]
    const sql = subjectUserId
      ? `UPDATE "${schema}"."AuditLog"
            SET "principal_id"=$1,
                "actor_snapshot" = COALESCE("actor_snapshot", jsonb_build_object('source',$3,'observed_at',now(),'subject_user_id',$2))
          WHERE "id"=$4 AND "principal_id" IS NULL
            AND "user_id" IS NOT DISTINCT FROM $5
            AND "actor_snapshot" IS NOT DISTINCT FROM $6::jsonb`
      : `UPDATE "${schema}"."AuditLog"
            SET "principal_id"=$1
          WHERE "id"=$2 AND "principal_id" IS NULL
            AND "user_id" IS NOT DISTINCT FROM $3
            AND "actor_snapshot" IS NOT DISTINCT FROM $4::jsonb`
    const affected = DRY ? 1 : await tx.$executeRawUnsafe(sql, ...args)
    if (affected !== 1) {
      const after = await readRowTx(tx, schema, auditId)
      if (after && after.principal_id) return { alreadyBound: true, principalId: after.principal_id, affected: 0 }
      throw raceError(`DERIVED_RACE_OR_STALE: ${schema}/${auditId} 影响行数=${affected}`)
    }
    return { alreadyBound: false, principalId: pid, affected }
  })
}

export async function backfillSchema(schema, mapping, { dbFactory = null, testHooks = null } = {}) {
  const db = dbFactory
    ? dbFactory(schema)
    : new PrismaClient({ datasources: { db: { url: withSchema(BASE_URL, schema) } } })
  try {
    const summary = { schema, dryRun: DRY, p1: 0, p1b: 0, p2: 0, p4: 0, refused: [], skipped: 0, atomic: 'per-row-transaction' }
    // 循环外重读仅用于**分档**（P-1/P-1b/P-3/P-4 与映射命中）；绑定判据一律在行事务内重取
    const nullRows = await db.$queryRawUnsafe(
      `SELECT "id", "user_id", "actor_snapshot"::text AS snap_text, "actor_snapshot" IS NULL AS is_sql_null
         FROM "AuditLog" WHERE "principal_id" IS NULL ORDER BY "id"`)
    const systemPid = `system-principal:${schema}`

    for (const row of nullRows) {
      const snapRaw = row.is_sql_null ? null : (() => { try { return JSON.parse(row.snap_text) } catch { return null } })()
      const snapIsPlainObject = snapRaw !== null && typeof snapRaw === 'object' && !Array.isArray(snapRaw)
      const snapHasKeys = snapIsPlainObject && Object.keys(snapRaw).length > 0
      const snapSubj = snapIsPlainObject ? (snapRaw.subject_user_id ?? null) : null
      const mapped = mapping ? mapping.map.get(mkey(schema, row.id)) : null
      // 稳定值优先：user_id → 快照 subject_user_id（映射**不得**覆盖稳定值；冲突已在预校验拒绝）
      if (row.user_id != null) {
        const r = await bindDerivedAtomic(db, { schema, auditId: row.id, subjectUserId: row.user_id, source: 'backfill' })
        if (r.alreadyBound) summary.skipped++; else summary.p1++
        continue
      }
      if (snapSubj != null) {
        if (subjectOk(snapSubj)) {
          const r = await bindDerivedAtomic(db, { schema, auditId: row.id, subjectUserId: snapSubj, source: 'backfill' })
          if (r.alreadyBound) summary.skipped++; else summary.p1b++
          continue
        }
        summary.refused.push({ audit_id: row.id, reason: 'invalid_subject_shape', subject_user_id: String(snapSubj).slice(0, 80) })
        continue
      }
      if (mapped) {
        const r = await bindMappedRowAtomic(db, { schema, auditId: row.id, mapped, testHooks })
        if (r.alreadyBound) summary.skipped++; else summary.p2++
        continue
      }
      if (snapHasKeys) {
        summary.refused.push({ audit_id: row.id, reason: 'username_only_refused', snapshot_keys: Object.keys(snapRaw).slice(0, 8) })
        continue
      }
      const r = await bindDerivedAtomic(db, { schema, auditId: row.id, systemPid })
      if (r.alreadyBound) summary.skipped++; else summary.p4++
    }
    return summary
  } finally { await db.$disconnect() }
}

/**
 * 回填编排（导出供测试注入交错钩子）：
 *   testHooks.afterPrevalidate —— 预校验通过后、任何回填前（构造"预校验后、重读前"交错）
 *   testHooks.beforeMappedBind —— 映射行事务内、UPDATE 前（构造"重读后、UPDATE 前"交错）
 */
export async function runBackfill({ schemas, mapping = null, skippedSchemas = [], testHooks = null, dbFactory = null, out = null } = {}) {
  const outObj = out || { task: 'P3-LIFECYCLE-AB-R3/R4/R6', script: '004_backfill_audit_principals', dryRun: DRY, at: new Date().toISOString(), skippedSchemas, schemas: [] }
  if (mapping) {
    outObj.mapping = {
      digest: mapping.digest,
      rows: mapping.rows,
      note: '文件 SHA-256 仅证明内容未变（完整性）；身份归属由逐行 evidence/approved_by/reviewed_at + pre 事实 + 冲突规则共同保证',
    }
    const problems = await validateMappingAgainstDb(mapping, schemas)
    outObj.mapping.validation = { ok: problems.length === 0, problems: problems.slice(0, 20), problemCount: problems.length }
    if (problems.length) {
      const err = new Error(`映射证据与现状冲突/未知/过期（${problems.length} 项）⇒ 零写入，非零退出`)
      err.code = 'MAPPING_PRECHECK_FAILED'
      err.out = outObj
      throw err
    }
  }
  if (testHooks?.afterPrevalidate) await testHooks.afterPrevalidate()
  for (const s of schemas) outObj.schemas.push(await backfillSchema(s, mapping, { dbFactory, testHooks }))
  outObj.refusedTotal = outObj.schemas.reduce((n, s) => n + s.refused.length, 0)
  outObj.atomicity = {
    prevalidationFailure: 'metadata+facts 预校验为只读阶段 ⇒ 全批零写入',
    runtimeRowFailure: '逐行事务（主体建档 + 审计绑定原子）⇒ 该行回滚；进程非零退出并停止后续行；此前已提交行不回滚',
    scope: '逐校顺序 + 逐行事务；**无** all-tenants 全批事务',
  }
  return outObj
}


const main = async () => {
  // 辅助：打印可直接粘贴进映射文件的 pre 事实块（避免手算整快照摘要失误）
  const PRINT_PRE = val('--print-pre')
  if (PRINT_PRE) {
    const [ps, pa] = String(PRINT_PRE).split(':')
    if (!schemaOk(ps) || !pa) { console.error('用法 --print-pre <schema>:<audit_id>'); await admin.$disconnect(); process.exit(2) }
    const rows = await admin.$queryRawUnsafe(
      `SELECT "user_id", "principal_id", "actor_snapshot"::text AS snap_text, "actor_snapshot" IS NULL AS is_sql_null
         FROM "${ps}"."AuditLog" WHERE "id" = $1`, pa)
    if (!rows.length) { console.error(`找不到 ${ps}/${pa}`); await admin.$disconnect(); process.exit(2) }
    const r = rows[0]
    console.log(JSON.stringify({
      schema: ps, audit_id: pa,
      pre: { user_id: r.user_id ?? null, principal_id: r.principal_id ?? null, actor_snapshot_sha256: snapshotDigestFromText(r.snap_text, r.is_sql_null) },
    }, null, 2))
    await admin.$disconnect()
    process.exit(0)
  }
  let schemas, skippedSchemas = []
  if (SCHEMA) {
    const has = await admin.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='AuditLog' AND column_name IN ('principal_id','actor_snapshot')`, SCHEMA)
    if (has[0].n !== 2) { console.error(`指定 schema ${SCHEMA} 缺少 AuditLog/principal_id/actor_snapshot（先推进到 M1；拒绝执行）`); await admin.$disconnect(); process.exit(2) }
    schemas = [SCHEMA]
  } else {
    const listed = await listTenantSchemas()
    schemas = listed.usable
    skippedSchemas = listed.skipped
  }
  let mapping = null
  if (MAPPING_FILE) mapping = loadMappingEvidence()
  let out
  try {
    out = await runBackfill({ schemas, mapping, skippedSchemas })
  } catch (e) {
    if (e.code === 'MAPPING_PRECHECK_FAILED') {
      const text = JSON.stringify(e.out, null, 2)
      console.log(text)
      if (JSON_OUT) fs.writeFileSync(path.resolve(JSON_OUT), text)
      await admin.$disconnect()
      console.error(`004 拒绝执行：${e.message}`)
      process.exit(1)
    }
    throw e
  }
  const text = JSON.stringify(out, null, 2)
  console.log(text)
  if (JSON_OUT) fs.writeFileSync(path.resolve(JSON_OUT), text)
  await admin.$disconnect()
  process.exit(0) // 004 的 P-3 不阻断（待人工清单）；强门禁在 M2 / 006
}
if (isMain) main().catch(async (e) => { console.error('004 失败:', e.message); try { await admin.$disconnect() } catch { /* noop */ } process.exit(1) })
