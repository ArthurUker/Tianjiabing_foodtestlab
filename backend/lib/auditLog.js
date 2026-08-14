// auditLog.js — 统一审计写入门面（收敛 TD-P2-13「三套审计日志」；IF-3/REG-3 三源统一收口）
//
// 背景：系统原有三类审计写入路径（租户 auditLog / 系统 systemLog / 前端离线 localStorage），
// 字段口径不一致。本模块把所有「落库」的审计写入收口到两个函数，禁止在 handler 内
// 裸写 `db.auditLog.create` / `db.systemLog.create`（会漏字段、破坏口径）。
//
//   - writeTenantAuditLog：租户级操作（CRUD / 登录成功 / 导入），落该学校 schema 的 auditLog。
//   - writeSystemLog：系统级离散事件（安全事件 SECURITY:*、平台超管操作 [admin-audit]*），
//     落 public schema 的 systemLog；写入时自动补齐「统一审计字段规范 v1」canonical 键。
//   - writeAdminOpsLog：平台级管理操作（操作者无租户归属，如平台超管删除某校用户）的
//     专用入口，内部委派 writeSystemLog，message 格式与 UserManager.logAdminAction 的
//     超管兜底路径一致（`[admin-audit] <action> target=<id>`），保证单一查询前缀可覆盖。
//
// 前端离线日志（js/utils/AuditLogger.js 写 localStorage）属离线兜底，不进库，不在此收口。
//
// ─── 统一审计字段规范 v1（IF-3/REG-3）───────────────────────────────────────
// 全量审计事件分布在两张表，canonical 字段映射如下：
//
//   canonical 键        租户 <schema>."AuditLog"        public."SystemLog"（context JSON 内）
//   ─────────────      ─────────────────────────      ─────────────────────────────────
//   actor_id            user_id（列）                   context.actor_id
//   action_type         action（列）                    context.action_type（缺省时由 message
//                                                       前缀 SECURITY:X / [admin-audit] X 推导）
//   target_id           resource_id（列）               context.target_id
//   details_json        details（列，JSON 字符串）       context（列，JSON 字符串）
//   created_at          created_at（列）                created_at（列）
//
// 「查某用户全部操作历史」需 UNION 两类来源（详见 tests/auditUnificationRegression.test.js
// 中 queryUnifiedAuditTrail 的等价实现）：
//
//   SELECT user_id AS actor_id, action AS action_type, resource_id AS target_id,
//          details AS details_json, created_at
//     FROM "<school_x>"."AuditLog" WHERE user_id = $1        -- 每个租户 schema 一份
//   UNION ALL
//   SELECT context::jsonb->>'actor_id', COALESCE(context::jsonb->>'action_type',
//          split_part(message, ' ', 1)), context::jsonb->>'target_id', context, created_at
//     FROM public."SystemLog"
//    WHERE (message LIKE 'SECURITY:%' OR message LIKE '[admin-audit]%')
//      AND context::jsonb->>'actor_id' = $1
//   ORDER BY created_at DESC;
// ────────────────────────────────────────────────────────────────────────────

/**
 * 写入租户级审计日志（落当前租户 schema 的 auditLog）。
 * @param {object} db 租户客户端（req.db 或 UserManager 的 this.prisma）
 * @param {object} p
 * @param {string} p.actorId 操作人 user_id
 * @param {string} p.action login|create|update|delete|export|import|login_failed
 * @param {string} [p.resourceType] test_record|user|backup|etc
 * @param {string} [p.resourceId]
 * @param {object|string} [p.details]
 * @param {string} [p.ip]
 */
export async function writeTenantAuditLog(db, { actorId, action, resourceType, resourceId, details, ip }) {
  return db.auditLog.create({
    data: {
      user_id: actorId,
      action,
      resource_type: resourceType || null,
      resource_id: resourceId || null,
      // P1-4: details 列升级为 Json（jsonb），直接传对象（Prisma 自动序列化）。
      // 兼容字符串入参：字符串原样存储（Prisma 存为 JSON 字符串），对象存为 JSON 对象。
      details: details || null,
      ip_address: ip || null,
    },
  })
}

/**
 * 从 message 前缀推导 canonical action_type：
 *   'SECURITY:REFRESH_TOKEN_REPLAY ...' → 'SECURITY:REFRESH_TOKEN_REPLAY'
 *   '[admin-audit] user_delete target=x' → 'user_delete'
 *   '[admin-audit-fallback] role_change target=x' → 'role_change'
 */
function deriveActionType(message) {
  if (typeof message !== 'string') return null
  if (message.startsWith('SECURITY:')) return message.split(/\s/)[0]
  const m = message.match(/^\[admin-audit(?:-fallback)?\]\s+(\S+)/)
  return m ? m[1] : null
}

/**
 * 统一审计字段规范 v1：为 SystemLog.context 补齐 canonical 键（snake_case）。
 * - 只增不删：保留调用方原始键（actorId / userId / timestamp 等），保证既有消费方无感知；
 * - 已显式提供 canonical 键的调用方（如 writeAdminOpsLog）不被覆盖；
 * - logSecurityEvent 的语义映射：actorId → actor_id（操作者）、
 *   userId / targetUserId → target_id（受影响用户，即事件主体）。
 */
function normalizeAuditContext(context, message) {
  if (context == null) return null
  if (typeof context !== 'object') return { raw: String(context) }
  const c = { ...context }
  if (c.actor_id === undefined) c.actor_id = c.actorId ?? null
  if (c.actor_username === undefined) c.actor_username = c.actorUsername ?? null
  if (c.actor_role === undefined) c.actor_role = c.actorRole ?? null
  if (c.actor_school_code === undefined) c.actor_school_code = c.actorSchoolCode ?? null
  if (c.target_id === undefined) c.target_id = c.targetUserId ?? c.userId ?? null
  if (c.action_type === undefined) c.action_type = c.action ?? deriveActionType(message)
  if (c.ts === undefined) c.ts = c.timestamp ?? new Date().toISOString()
  return c
}

/**
 * 写入系统级日志（落 public schema 的 systemLog）。
 * context 为对象时自动补齐统一审计字段规范 v1 的 canonical 键（见文件头）。
 * @param {object} prisma 基础 Prisma 单例（连 public）
 * @param {object} p
 * @param {string} [p.level] info|warn|error|debug
 * @param {string} p.message
 * @param {object|string} [p.context]
 */
export async function writeSystemLog(prisma, { level = 'info', message, context }) {
  const normalized = normalizeAuditContext(context, message)
  return prisma.systemLog.create({
    data: {
      level,
      message,
      // P1-4: context 列升级为 Json（jsonb），normalizeAuditContext 已保证对象，直接传。
      context: normalized || null,
    },
  })
}

/**
 * 平台级管理操作审计（REG-4）：操作者为平台超管（school_code 为空、不存在于任何
 * 租户 schema 的 User 表）时的统一写入入口。落 public."SystemLog"（不能落租户
 * AuditLog——其 user_id 对 User 表有外键，超管在租户 schema 无对应行会写入失败）。
 *
 * message 与 UserManager.logAdminAction 的超管兜底路径同格式：
 *   `[admin-audit] <action> target=<targetId>`
 * 因此 `message LIKE '[admin-audit]%'` 单一条件即可覆盖全部平台级管理操作。
 *
 * @param {object} prisma 基础 Prisma 单例（连 public）
 * @param {object} p
 * @param {string} p.action 如 admin_delete_school_user
 * @param {object} [p.actor] { userId, username, role, schoolCode, ip }（schoolCode 可为 null）
 * @param {string} [p.targetId] 目标用户 id
 * @param {string} [p.targetSchoolCode] 目标用户所属学校 code
 * @param {object} [p.details] 附加信息（目标用户名快照等）
 * @param {string} [p.level] 默认 warn（高危管理操作）
 */
export async function writeAdminOpsLog(prisma, { action, actor, targetId, targetSchoolCode, details, level = 'warn' }) {
  return writeSystemLog(prisma, {
    level,
    message: `[admin-audit] ${action} target=${targetId || ''}`,
    context: {
      ...(details || {}),
      action_type: action,
      actor_id: actor?.userId ?? null,
      actor_username: actor?.username ?? null,
      actor_role: actor?.role ?? null,
      actor_school_code: actor?.schoolCode ?? null,
      target_id: targetId ?? null,
      target_school_code: targetSchoolCode ?? null,
      ip: actor?.ip ?? null,
      ts: new Date().toISOString(),
    },
  })
}

export default { writeTenantAuditLog, writeSystemLog, writeAdminOpsLog }
