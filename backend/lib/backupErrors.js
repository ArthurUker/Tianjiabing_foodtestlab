// backupErrors.js — 备份/恢复引擎的**类型化错误与 HTTP 映射**（P3-W3-T01 / RC-03）
//
// 目的：把状态机内部的拒绝原因（互斥锁占用、产物不一致、归属校验失败、drain 超时）
// 变成调用方可判别的类型化错误；路由层只做「类型 → HTTP 状态码」映射，不再靠字符串匹配。
//
// 设计口径（任务包 P3-W3-T01）：
//   - 并发请求只有一个获得执行权，其余**明确拒绝**（409/423 类），不得静默排队或空跑；
//   - 产物不一致（计数与 dump 不同快照）**不得登记 ok/passed**，必须抛出并进入失败清理；
//   - 归属校验失败是 fail-closed 的硬错误（不做任何 DROP/RENAME）。

const TAG = '[backupErrors]'

/** 引擎错误码（稳定契约；路由/测试/审计都引用同一常量）。 */
export const BACKUP_ERROR_CODES = Object.freeze({
  BACKUP_LOCK_BUSY: 'BACKUP_LOCK_BUSY',
  RESTORE_LOCK_BUSY: 'RESTORE_LOCK_BUSY',
  ARTIFACT_INCONSISTENT: 'BACKUP_ARTIFACT_INCONSISTENT',
  OWNERSHIP_VIOLATION: 'RESTORE_OWNERSHIP_VIOLATION',
  DRAIN_TIMEOUT: 'RESTORE_DRAIN_TIMEOUT',
  WORKSPACE_VIOLATION: 'BACKUP_WORKSPACE_VIOLATION',
})

/** 备份/恢复互斥：同 scope 已有任务持有 advisory lock → 明确拒绝（409）。 */
export class MaintenanceLockBusyError extends Error {
  constructor(message, detail = {}) {
    super(`${TAG} ${message}`)
    this.name = 'MaintenanceLockBusyError'
    this.code = detail.kind === 'restore' ? BACKUP_ERROR_CODES.RESTORE_LOCK_BUSY : BACKUP_ERROR_CODES.BACKUP_LOCK_BUSY
    this.status = 409
    this.detail = detail
  }
}

/** 计数与 dump 不共享同一快照 → 产物不可信，拒绝登记（500，需人工排查写入并发/快照能力）。 */
export class ArtifactConsistencyError extends Error {
  constructor(message, detail = {}) {
    super(`${TAG} ${message}`)
    this.name = 'ArtifactConsistencyError'
    this.code = BACKUP_ERROR_CODES.ARTIFACT_INCONSISTENT
    this.status = 500
    this.detail = detail
  }
}

/** 归属校验失败（staging/old schema 的 oid 与台账登记不符）→ fail-closed，不做任何 DROP/RENAME。 */
export class OwnershipViolationError extends Error {
  constructor(message, detail = {}) {
    super(`${TAG} ${message}`)
    this.name = 'OwnershipViolationError'
    this.code = BACKUP_ERROR_CODES.OWNERSHIP_VIOLATION
    this.status = 500
    this.detail = detail
  }
}

/** 恢复写屏障的 drain 超时：旧写事务未在窗口内结束 → 中止恢复（不推进到 SWITCHING）。 */
export class DrainTimeoutError extends Error {
  constructor(message, detail = {}) {
    super(`${TAG} ${message}`)
    this.name = 'DrainTimeoutError'
    this.code = BACKUP_ERROR_CODES.DRAIN_TIMEOUT
    this.status = 503
    this.detail = detail
  }
}

/** 工作区/台账路径越界（非本任务登记的目录）→ 拒绝删除/发布。 */
export class WorkspaceViolationError extends Error {
  constructor(message, detail = {}) {
    super(`${TAG} ${message}`)
    this.name = 'WorkspaceViolationError'
    this.code = BACKUP_ERROR_CODES.WORKSPACE_VIOLATION
    this.status = 500
    this.detail = detail
  }
}

/**
 * 引擎错误 → HTTP 响应（status/code/error）。非类型化错误按 500 处理（保持既有行为）。
 * @param {unknown} e
 * @param {{fallbackMessage?: string}} [opts]
 * @returns {{status:number, code:string|null, error:string}}
 */
export function httpErrorFor(e, opts = {}) {
  const status = Number(e?.status)
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return {
      status,
      code: e.code || null,
      error: e.message || opts.fallbackMessage || '请求失败',
    }
  }
  return { status: 500, code: e?.code || null, error: e?.message || opts.fallbackMessage || '内部错误' }
}
