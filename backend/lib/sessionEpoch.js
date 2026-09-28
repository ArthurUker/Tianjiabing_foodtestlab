/**
 * sessionEpoch.js — P3-W1-T01（RC-02）统一失效模型：**唯一事实源 + 单点校验**
 *
 * 设计口径（任务包 §设计口径，不另行发挥）：
 *   · 失效模型 = **用户级 epoch + 学校级 epoch**（单调时间戳），落在既有
 *     `public.revoked_tokens`（保留表、语义并入，不删历史审计；token_type 取
 *     'user_epoch' / 'school_epoch'，jti 为确定性键 → **O(1) upsert**）。
 *   · **单点校验**：`buildSessionValiditySql()` 是唯一的失效判定 SQL——一条语句同时覆盖
 *       ① jti 精确吊销（登出/轮转，保留旧语义）
 *       ② user_all 全量吊销（历史语义 + role-audit DB 触发器写入，保留）
 *       ③ user_epoch（改密/降权/禁用/删除）
 *       ④ school_epoch（停校 O(1)）
 *       ⑤ 学校状态（School.status <> 'active' 的权威状态，覆盖"先停校、后建 epoch"的历史数据）
 *     比较口径统一为 iat+1（AUD-015）：`revoked_at >= to_timestamp(iat + 1)`
 *     —— 同秒内新签发的 token 不被误杀（改密后同秒自动重登），旧 token（iat 至少早 1 秒）正确失效。
 *   · **吊销与业务同事务**（AUD-016）：`runSessionSafeMutation()` 在**一个连接/一个事务**里
 *       执行「业务写（raw SQL，schema 限定）→ epoch 写入（public）」；任一步失败整体回滚，
 *       不再"业务成功 + 吊销吞错"。
 *   · **两阶段兼容**（AUD-012/015/016 共同前提）：`legacyTokenMode()` =
 *       compat（默认，阶段一）：无 jti 的旧 token 仍按 状态 + epoch 校验通过（jti 精确吊销不适用，
 *                                 但时间维度失效语义安全等价）；
 *       strict（阶段二，`SESSION_LEGACY_TOKEN_MODE=strict` 显式运维开关）：无 jti 一律拒绝。
 *     兼容期用度量（legacyTokenMetrics）观测旧 token 流量，供阶段二切换决策。
 *   · **fail-soft 边界**（AUD-014）：仅 `failSoftMayApply(req)`（可证明只读：GET/HEAD/OPTIONS）
 *       且在 `AUTH_FAILSOFT_MAX_MS`（默认 30s，明确时限）内允许降级；写请求一律 fail-closed。
 *
 * 时钟：`sessionNow()` 可注入（`setSessionClock`），用于**固定时钟**用例钉死 iat 边界。
 * 纯函数（`isSessionStale` / SQL 构造）不触 DB，便于单测。
 */
import { schemaNameOf, assertSafeSchemaName } from './tenantClient.js'

/**
 * 用户级 epoch 的记录类型：沿用 `user_all`（**语义统一**：该用户 revoked_at 之前签发的全部会话失效）。
 * 与历史/DB 触发器的差异只在键：新模型用确定性键 `user_epoch:<userId>` + upsert（每用户一行、O(1)），
 * 历史 `revokeAllUserTokens`（随机键）与 `role-audit-trigger.sql` 仍是合法生产者，判定口径完全一致。
 */
export const USER_EPOCH_TYPE = 'user_all'
export const SCHOOL_EPOCH_TYPE = 'school_epoch'
export const USER_EPOCH_PREFIX = 'user_epoch:'
export const SCHOOL_EPOCH_PREFIX = 'school_epoch:'

/** epoch 记录保留期：必须显著长于最长令牌 TTL（refresh 7d），避免被清理后"复活"旧 token。 */
export const DEFAULT_EPOCH_TTL_MS = Number(process.env.SESSION_EPOCH_TTL_MS || 30 * 86400 * 1000)

/** 兼容阶段常量。 */
export const LEGACY_TOKEN_COMPAT = 'compat'
export const LEGACY_TOKEN_STRICT = 'strict'

// ============================== 时钟（可注入，固定时钟用例） ==============================

let _clock = () => Date.now()

/** 当前时间（ms）。所有 epoch 写入/判定都经此函数，便于固定时钟测试。 */
export function sessionNow() {
  return Number(_clock())
}

/** 仅供测试：注入固定时钟；传 null 恢复系统时钟。 */
export function setSessionClock(fn) {
  _clock = typeof fn === 'function' ? fn : (() => Date.now())
}

// ============================== 确定性键（O(1) upsert） ==============================

export function userEpochKey(userId) {
  if (!userId) throw new Error('[sessionEpoch] userEpochKey 需要 userId')
  return `${USER_EPOCH_PREFIX}${userId}`
}

export function schoolEpochKey(schoolCode) {
  if (!schoolCode) throw new Error('[sessionEpoch] schoolEpochKey 需要 schoolCode')
  return `${SCHOOL_EPOCH_PREFIX}${schoolCode}`
}

// ============================== 纯判定（single comparison） ==============================

/**
 * 统一失效判定（**唯一比较**）：
 *   · 令牌携带 `idt`（毫秒签发时刻，P3-W1-T01 新增声明）→ 精确比较：epoch/吊销时间 >= idt → 失效。
 *     这闭合了「同秒内先签发、后吊销」的窗口（旧 token 必失效），同时保留
 *     「同秒内先吊销、后签发（改密后自动重登）」的新 token 仍有效。
 *   · 旧 token（无 idt）→ 退化为 iat+1s 语义（AUD-015 兼容边界）。
 * @param {{ iat: number, idt?: number|null, userEpochAt?: Date|number|string|null, schoolEpochAt?: Date|number|string|null }} args
 * @returns {{ stale: boolean, source: 'user_all'|'school_epoch'|null, precise: boolean }}
 */
export function isSessionStale({ iat, idt = null, userEpochAt = null, schoolEpochAt = null }) {
  const precise = Number.isFinite(Number(idt)) && Number(idt) > 0
  const thresholdMs = precise ? Number(idt) : (Math.floor(Number(iat) || 0) + 1) * 1000
  const asMs = (v) => {
    if (v === null || v === undefined) return null
    if (typeof v === 'number') return v
    const t = new Date(v).getTime()
    return Number.isFinite(t) ? t : null
  }
  const stale = (v) => {
    const ms = asMs(v)
    return ms !== null && ms >= thresholdMs
  }
  // 学校级优先报出（范围更大、更易解释），同一比较口径
  if (stale(schoolEpochAt)) return { stale: true, source: SCHOOL_EPOCH_TYPE, precise }
  if (stale(userEpochAt)) return { stale: true, source: USER_EPOCH_TYPE, precise }
  return { stale: false, source: null, precise }
}

/**
 * 单点失效校验 SQL（唯一事实源）。
 * 参数顺序：**$1 jti, $2 userId, $3 iat（秒）, $4 schoolCode, $5 idt（毫秒，可空）**。
 * （iat 固定在 $3：与既有 revoked 校验调用的历史参数位保持兼容，见会话回归套件替身语义。）
 * 时间阈值（对 jti 分支之外的记录统一适用）：
 *   idt 存在 → to_timestamp(idt/1000)（精确毫秒）；否则 → to_timestamp(iat + 1)（旧 token 兼容边界）。
 * 命中返回 { hit, source, reason, revoked_at }；未命中返回空集。
 */
export function buildSessionValiditySql() {
  const THRESHOLD = `CASE WHEN $5::bigint IS NOT NULL THEN to_timestamp($5::bigint / 1000.0) ELSE to_timestamp($3::bigint + 1) END`
  return `SELECT 1 AS hit, t.source, t.reason, t.revoked_at
      FROM (
        SELECT 'jti'::text AS source, reason, revoked_at
          FROM public.revoked_tokens WHERE jti = $1::text
        UNION ALL
        SELECT '${USER_EPOCH_TYPE}'::text AS source, reason, revoked_at
          FROM public.revoked_tokens
         WHERE token_type = '${USER_EPOCH_TYPE}' AND user_id = $2::text
           AND revoked_at >= ${THRESHOLD}
        UNION ALL
        SELECT '${SCHOOL_EPOCH_TYPE}'::text AS source, reason, revoked_at
          FROM public.revoked_tokens
         WHERE token_type = '${SCHOOL_EPOCH_TYPE}' AND $4::text IS NOT NULL AND school_code = $4::text
           AND revoked_at >= ${THRESHOLD}
        UNION ALL
        SELECT 'school_disabled'::text AS source, 'school_disabled'::text AS reason, now() AS revoked_at
          FROM public."School"
         WHERE $4::text IS NOT NULL AND code = $4::text AND status <> 'active'
      ) t
     ORDER BY t.revoked_at DESC
     LIMIT 1`
}

/**
 * 执行单点校验。fail-closed：查询异常向上抛出（由调用方统一决策，绝不静默放行）。
 * @returns {Promise<{invalid: boolean, reason: string|null, source: string|null}>}
 */
export async function checkSessionValidity(prisma, { jti = null, userId = null, iat, idt = null, schoolCode = null }) {
  const idtMs = Number.isFinite(Number(idt)) && Number(idt) > 0 ? Math.floor(Number(idt)) : null
  const rows = await prisma.$queryRawUnsafe(
    buildSessionValiditySql(),
    jti, userId, Math.floor(Number(iat) || 0), schoolCode, idtMs
  )
  if (!rows || !rows.length) return { invalid: false, reason: null, source: null }
  return { invalid: true, reason: rows[0].reason || null, source: rows[0].source || null }
}

/** 读取用户级/学校级 epoch（诊断与测试用；单条查询）。 */
export async function readSessionEpochs(prisma, { userId = null, schoolCode = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT token_type, revoked_at FROM public.revoked_tokens
      WHERE (token_type = '${USER_EPOCH_TYPE}' AND $1::text IS NOT NULL AND user_id = $1::text)
         OR (token_type = '${SCHOOL_EPOCH_TYPE}' AND $2::text IS NOT NULL AND school_code = $2::text)`,
    userId, schoolCode
  )
  const out = { userEpochAt: null, schoolEpochAt: null }
  for (const r of rows || []) {
    if (r.token_type === USER_EPOCH_TYPE) out.userEpochAt = r.revoked_at
    if (r.token_type === SCHOOL_EPOCH_TYPE) out.schoolEpochAt = r.revoked_at
  }
  return out
}

// ============================== epoch 写入（O(1) upsert） ==============================

/**
 * 写入/推进用户级 epoch（幂等 upsert；同一用户只有一行）。
 * ⚠️ 必须在**与业务变更同一事务**的 tx 上调用（见 runSessionSafeMutation）。
 */
export async function bumpUserEpoch(tx, { userId, schoolCode = null, reason = null, at = sessionNow() }) {
  if (!userId) throw new Error('[sessionEpoch] bumpUserEpoch 需要 userId')
  const atDate = new Date(Number(at))
  const expiresAt = new Date(Number(at) + DEFAULT_EPOCH_TTL_MS)
  // 键：`user_epoch:<userId>`（确定性）→ 每用户一行 upsert（O(1) 单调推进，不随事件累积）
  // token_type 以**字面量**内联（值来自本模块常量，无注入面）：与历史 user_all 写入同形，
  // 便于 DB 触发器/审计/测试替身按 SQL 文本识别类型（参数化为 $1..$6 保持精简）。
  await tx.$executeRawUnsafe(
    `INSERT INTO public.revoked_tokens (jti, user_id, school_code, token_type, reason, revoked_at, expires_at)
     VALUES ($1, $2, $3, '${USER_EPOCH_TYPE}', $4, $5, $6)
     ON CONFLICT (jti) DO UPDATE
       SET revoked_at = EXCLUDED.revoked_at,
           reason = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at,
           school_code = EXCLUDED.school_code`,
    userEpochKey(userId), userId, schoolCode, reason, atDate, expiresAt
  )
  return { userId, at: atDate.toISOString(), reason }
}

/**
 * 写入/推进学校级 epoch（幂等 upsert；停校 O(1) 失效全校会话，禁止逐 token 循环）。
 */
export async function bumpSchoolEpoch(tx, { schoolCode, reason = null, at = sessionNow() }) {
  if (!schoolCode) throw new Error('[sessionEpoch] bumpSchoolEpoch 需要 schoolCode')
  const atDate = new Date(Number(at))
  const expiresAt = new Date(Number(at) + DEFAULT_EPOCH_TTL_MS)
  await tx.$executeRawUnsafe(
    `INSERT INTO public.revoked_tokens (jti, user_id, school_code, token_type, reason, revoked_at, expires_at)
     VALUES ($1, $2, $3, '${SCHOOL_EPOCH_TYPE}', $4, $5, $6)
     ON CONFLICT (jti) DO UPDATE
       SET revoked_at = EXCLUDED.revoked_at,
           reason = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at`,
    schoolEpochKey(schoolCode), `school:${schoolCode}`, schoolCode, reason, atDate, expiresAt
  )
  return { schoolCode, at: atDate.toISOString(), reason }
}

// ============================== 同事务执行器（AUD-016） ==============================

/**
 * 在**同一个根事务/同一连接**里执行「租户业务写 → 用户级 epoch 写入」：
 *   - 业务写通过 `mutate(tx)` 提供（调用方用 schema 限定的 raw SQL，见 UserManager）；
 *   - epoch 写在同一 tx 内提交；任一步失败 → 整体回滚（业务不落地、旧权限不保留）。
 * @param {{ prisma: object, schoolCode: string|null, userId: string, reason: string, at?: number, mutate: (tx: object)=>Promise<any> }} args
 * @returns {Promise<any>} mutate 的返回值
 */
export async function runSessionSafeMutation({ prisma, schoolCode = null, userId, reason, at = sessionNow(), mutate }) {
  if (!userId) throw new Error('[sessionEpoch] runSessionSafeMutation 需要 userId')
  if (typeof mutate !== 'function') throw new Error('[sessionEpoch] runSessionSafeMutation 需要 mutate')
  const schema = schoolCode ? assertSafeSchemaName(schemaNameOf(schoolCode)) : 'public'
  return prisma.$transaction(async (tx) => {
    // 业务写与 epoch 写共用同一连接；显式限定 schema，避免依赖 search_path 默认值
    const result = await mutate({ tx, schema })
    await bumpUserEpoch(tx, { userId, schoolCode, reason, at })
    return result
  })
}

/** 供断言/诊断：某业务写依赖的 schema 标识（纯函数）。 */
export function schemaIdentForSchool(schoolCode) {
  return schoolCode ? assertSafeSchemaName(schemaNameOf(schoolCode)) : 'public'
}

// ============================== 两阶段兼容（AUD-012/015/016） ==============================

/** 阶段解析：默认 compat（阶段一）；`SESSION_LEGACY_TOKEN_MODE=strict` 为阶段二强制。 */
export function legacyTokenMode() {
  const raw = String(process.env.SESSION_LEGACY_TOKEN_MODE || '').trim().toLowerCase()
  return raw === LEGACY_TOKEN_STRICT ? LEGACY_TOKEN_STRICT : LEGACY_TOKEN_COMPAT
}

const _legacyMetrics = { accepted: 0, rejectedStrict: 0, lastAt: null }

/** 记录一次旧 token（无 jti）在兼容阶段的处置，供阶段二切换决策与观测。 */
export function recordLegacyTokenDecision({ accepted }) {
  if (accepted) _legacyMetrics.accepted += 1
  else _legacyMetrics.rejectedStrict += 1
  _legacyMetrics.lastAt = new Date(sessionNow()).toISOString()
}

export function legacyTokenMetrics() {
  return { mode: legacyTokenMode(), ..._legacyMetrics }
}

export function _resetLegacyTokenMetricsForTest() {
  _legacyMetrics.accepted = 0
  _legacyMetrics.rejectedStrict = 0
  _legacyMetrics.lastAt = null
}

// ============================== fail-soft 边界（AUD-014） ==============================

/** 可证明只读的方法（HTTP 语义）：仅这些方法允许在 DB 回查故障时降级。 */
export const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** 是否属于"可证明只读"请求（写请求一律 fail-closed）。 */
export function failSoftMayApply(req) {
  const m = String(req?.method || 'GET').toUpperCase()
  return READ_ONLY_METHODS.has(m)
}

/** 明确时限：连续故障降级窗口（默认 30s），超时一律 fail-closed。 */
export function failSoftWindowMs() {
  const v = Number(process.env.AUTH_FAILSOFT_MAX_MS || 30_000)
  return Number.isFinite(v) && v > 0 ? v : 30_000
}

export default {
  USER_EPOCH_TYPE,
  SCHOOL_EPOCH_TYPE,
  DEFAULT_EPOCH_TTL_MS,
  sessionNow,
  setSessionClock,
  userEpochKey,
  schoolEpochKey,
  isSessionStale,
  buildSessionValiditySql,
  checkSessionValidity,
  readSessionEpochs,
  bumpUserEpoch,
  bumpSchoolEpoch,
  runSessionSafeMutation,
  schemaIdentForSchool,
  legacyTokenMode,
  recordLegacyTokenDecision,
  legacyTokenMetrics,
  failSoftMayApply,
  failSoftWindowMs,
}
