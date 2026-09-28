// auditPrincipal.js — 审计主体锚点（P3-LIFECYCLE-AB-R3 / M1）
//
// 不可变主体模型：每条审计行必须绑定一个 AuditPrincipal（B 期 M2 后为 NOT NULL）。
//   · kind='user'  ：subject_user_id = 稳定 User.id（事件写入 / 004 回填 P-1 / 映射证据 P-2）；
//   · kind='system'：subject_user_id='system'，每 scope 恰 1 行，仅承载"无主体且无快照"事件（P-4）。
//
// R9 冻结裁决（不得违反）：
//   · **username-only 一律拒绝**：本模块不提供、也不得新增任何按 username 猜测主体的路径；
//   · 可绑定的只有：稳定 subject_user_id（User.id / 快照中的 subject_user_id）或独立可审映射证据
//     （映射证据由 004 的 --mapping 入口驱动，逐行 UPDATE；M2 里不重放猜测逻辑）；
//   · 无法证明的历史行：004 列入待人工清单；若拖到 M2 仍未绑定 ⇒ M2 fail-closed（租户阻断）。
//
// 主体 id 生成：
//   · 人类主体：deterministic（scope_key + subject_user_id 的 sha256 前缀）——同一主体在重复执行/多路径下
//     永远映射到同一 principal 行（幂等）；
//   · 系统主体：`system-principal:<scope_key>`（M1 迁移播种时使用同一规则）。
import crypto from 'node:crypto'

export const SYSTEM_SUBJECT_ID = 'system'
export const PRINCIPAL_KINDS = Object.freeze({ USER: 'user', SYSTEM: 'system' })

const scopeKeyCache = new WeakMap()

/** 当前 schema（scope_key）。search_path 由连接固定；对同一 client 缓存。 */
export async function currentScopeKey(client) {
  if (client && typeof client === 'object' && scopeKeyCache.has(client)) return scopeKeyCache.get(client)
  const rows = await client.$queryRawUnsafe('SELECT current_schema() AS s')
  const key = rows && rows[0] && rows[0].s ? String(rows[0].s) : ''
  if (!key) {
    const err = new Error('无法解析当前 schema（current_schema() 为空）——审计主体绑定拒绝执行')
    err.code = 'AUDIT_PRINCIPAL_SCOPE_UNRESOLVED'
    throw err
  }
  if (client && typeof client === 'object') scopeKeyCache.set(client, key)
  return key
}

/** 人类主体 principal id（确定性）。 */
export function principalIdForSubject(scopeKey, subjectUserId) {
  return 'principal:' + crypto.createHash('sha256').update(`${scopeKey}\0${subjectUserId}`).digest('hex').slice(0, 32)
}

/** 系统主体 principal id（与 M1 迁移播种规则一致）。 */
export function systemPrincipalId(scopeKey) {
  return `system-principal:${scopeKey}`
}

/** id 形态校验：只接受非空字符串、无控制字符、长度合理（防止把垃圾值当主体 id 建档）。 */
export function isValidSubjectId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 191 && !/[\u0000-\u001f\s]/.test(value)
}

function subjectShapeError(value) {
  const err = new Error(
    `历史主体值形态非法（${JSON.stringify(value)}）：仅接受稳定主体 id（无空白/控制字符，长度 ≤191）。` +
    `R9：username-only 不允许自动映射，形态非法不得建档。`
  )
  err.code = 'AUDIT_PRINCIPAL_SUBJECT_INVALID'
  return err
}

/**
 * 事件写入路径：确保主体存在（同事务调用）。
 * 只接受稳定 subject id；**不接受** username。
 */
export async function ensurePrincipalForSubject(client, { subjectUserId, subjectUsername = null, schoolCode = null, origin = 'event' }) {
  if (!isValidSubjectId(subjectUserId)) throw subjectShapeError(subjectUserId)
  const scopeKey = await currentScopeKey(client)
  const id = principalIdForSubject(scopeKey, subjectUserId)
  return client.auditPrincipal.upsert({
    where: { scope_key_subject_user_id: { scope_key: scopeKey, subject_user_id: subjectUserId } },
    update: {}, // 主体不可变：已存在不回写（保留 origin/observed_at 的首次证据）
    create: {
      id,
      kind: PRINCIPAL_KINDS.USER,
      scope_key: scopeKey,
      school_code: schoolCode || null,
      subject_user_id: subjectUserId,
      subject_username: subjectUsername || null,
      origin,
      observed_at: new Date(),
    },
  })
}

/** 系统主体（P-4 专用；每 scope 恰 1 行）。 */
export async function ensureSystemPrincipal(client, { schoolCode = null } = {}) {
  const scopeKey = await currentScopeKey(client)
  const id = systemPrincipalId(scopeKey)
  return client.auditPrincipal.upsert({
    where: { id },
    update: {},
    create: {
      id,
      kind: PRINCIPAL_KINDS.SYSTEM,
      scope_key: scopeKey,
      school_code: schoolCode || null,
      subject_user_id: SYSTEM_SUBJECT_ID,
      subject_username: SYSTEM_SUBJECT_ID,
      origin: 'system',
      observed_at: new Date(),
    },
  })
}

/**
 * 解析一次审计写入应绑定的主体（同一事务内 upsert + 使用）：
 *   1. subjectUserId（调用方给出的稳定 id，通常 = actorId / req.user.userId）⇒ 人类主体；
 *   2. 否则若快照含合法 subject_user_id ⇒ 人类主体（P-1，事件时点主体）；
 *   3. 否则 ⇒ 系统主体（**仅当**确无主体标识；调用方若提供了无法证明的人类标识（如 username-only），
 *      必须自行按 R9 拒绝，不得到达这里冒充系统事件）。
 */
export async function resolvePrincipalForWrite(client, { subjectUserId = null, snapshot = null, schoolCode = null, subjectUsername = null }) {
  if (isValidSubjectId(subjectUserId)) {
    return ensurePrincipalForSubject(client, { subjectUserId, subjectUsername, schoolCode, origin: 'event' })
  }
  const snapSubject = snapshot && typeof snapshot === 'object' ? snapshot.subject_user_id : null
  if (snapSubject != null) {
    // 形态非法 ⇒ 拒绝（不静默降级为系统主体）
    if (!isValidSubjectId(snapSubject)) throw subjectShapeError(snapSubject)
    return ensurePrincipalForSubject(client, { subjectUserId: snapSubject, subjectUsername: null, schoolCode, origin: 'event' })
  }
  return ensureSystemPrincipal(client, { schoolCode })
}

/**
 * 组装事件时点主体快照（actor_snapshot 列）。
 * `subject_user_id` 只在有稳定 id 时写入 —— 它是历史回填 P-1 的唯一可证明锚点。
 */
export function buildActorSnapshot({ source = 'event', userId = null, username = null, role = null, schoolCode = null, ip = null, extra = null } = {}) {
  const snap = { source, observed_at: new Date().toISOString() }
  if (isValidSubjectId(userId)) snap.subject_user_id = userId
  if (username) snap.username = String(username).slice(0, 191)
  if (role) snap.role = String(role)
  if (schoolCode) snap.school_code = String(schoolCode)
  if (ip) snap.ip = String(ip)
  if (extra && typeof extra === 'object') snap.details = extra
  return snap
}

/**
 * 历史行分类（004 回填 / M2 残量绑定共用；只读判定，不做任何 username 猜测）：
 *   P-0 principal_id 非空          ⇒ skip
 *   P-1 稳定主体 id（user_id 列或快照 subject_user_id）⇒ bindSubject（id 值）
 *   P-2 外部映射证据命中（由调用方先行提供；本函数只认已给出的 evidence 命中）
 *   P-3 仅 username / 无主体标识的人类行 ⇒ refused（待人工 / M2 fail-closed）
 *   P-4 user_id 与 actor_snapshot 皆无 ⇒ system
 */
export function classifyAuditRow(row, evidenceSubjectId = null) {
  if (row.principal_id) return { tier: 'P-0', action: 'skip' }
  if (isValidSubjectId(row.user_id)) return { tier: 'P-1', action: 'bindSubject', subjectUserId: row.user_id, anchor: 'user_id' }
  if (evidenceSubjectId != null) {
    if (!isValidSubjectId(evidenceSubjectId)) throw subjectShapeError(evidenceSubjectId)
    return { tier: 'P-2', action: 'bindSubject', subjectUserId: evidenceSubjectId, anchor: 'mapping' }
  }
  const snap = row.actor_snapshot && typeof row.actor_snapshot === 'object' ? row.actor_snapshot : null
  if (snap && snap.subject_user_id != null) {
    if (!isValidSubjectId(snap.subject_user_id)) throw subjectShapeError(snap.subject_user_id)
    return { tier: 'P-1', action: 'bindSubject', subjectUserId: snap.subject_user_id, anchor: 'snapshot' }
  }
  if (snap && (snap.username || Object.keys(snap).length > 0)) {
    return { tier: 'P-3', action: 'refused', reason: 'username_only_refused' }
  }
  return { tier: 'P-4', action: 'system' }
}
