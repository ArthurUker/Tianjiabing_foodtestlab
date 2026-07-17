// auditLog.js — 统一审计写入门面（收敛 TD-P2-13「三套审计日志」）
//
// 背景：系统原有三类审计写入路径（租户 auditLog / 系统 systemLog / 前端离线 localStorage），
// 字段口径不一致。本模块把所有「落库」的审计写入收口到两个函数，禁止在 handler 内
// 裸写 `db.auditLog.create` / `db.systemLog.create`（会漏字段、破坏口径）。
//
//   - writeTenantAuditLog：租户级操作（CRUD / 登录成功 / 导入），落该学校 schema 的 auditLog。
//   - writeSystemLog：系统级离散事件（如失败登录、用户不存在），落 public.schema 的 systemLog。
//
// 前端离线日志（js/utils/AuditLogger.js 写 localStorage）属离线兜底，不进库，不在此收口。

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
      details: details ? JSON.stringify(details) : null,
      ip_address: ip || null,
    },
  })
}

/**
 * 写入系统级日志（落 public.schema 的 systemLog）。
 * @param {object} prisma 基础 Prisma 单例（连 public）
 * @param {object} p
 * @param {string} [p.level] info|warn|error|debug
 * @param {string} p.message
 * @param {object|string} [p.context]
 */
export async function writeSystemLog(prisma, { level = 'info', message, context }) {
  return prisma.systemLog.create({
    data: {
      level,
      message,
      context: context ? JSON.stringify(context) : null,
    },
  })
}

export default { writeTenantAuditLog, writeSystemLog }
