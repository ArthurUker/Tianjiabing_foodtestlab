// tests/integration/pg-bootstrap.js
//
// P3-W0-T02A-R1 — 门禁化 PG/Prisma 引导（连接来源仅来自共享门禁）。
//
// 与 T02A 初版的区别（闭合复审 R1）：
//   * Prisma 业务连接也在**同一 interactive transaction client** 上先做共享只读核验，再执行
//     业务 SELECT/INSERT；不再让 pg Client 的验证结果给 Prisma 连接作担保。
//   * 不复制校验规则：Prisma tx 经薄适配（`$queryRawUnsafe` → `{rows}`）调用同一
//     `verifyRuntimeIdentity`；不修改生产模块、仍使用真实 `createTenantClient`。
//   * 登记改用结构化任务行键（`createRegistry(cfg).addTaskRow`），清理只按登记项。

import pg from 'pg'
import { resolveSchemaName, createTenantClient } from '../../backend/lib/tenantClient.js'
import gate from '../helpers/db-isolation.js'

const { Client } = pg

/** 学校代码 → 真实 schema 名（复用生产逻辑）。 */
export const schemaOf = (code) => resolveSchemaName(code)

/** 读取并校验隔离配置（连接前；失败抛错 → 不建立任何连接）。 */
export function loadIsolationConfig() {
  return gate.assertIsolationConfigOrThrow(process.env)
}

/** 由任务 runId 派生租户 code 与 schema（与门禁契约同源）。 */
export function tenantCodesFor(cfg) {
  const derived = gate.derivedNamespace(cfg.runId)
  return { ...derived.tenants, schemas: { ...derived.schemas } }
}

/** 一致性断言：门禁派生 schema 必须与生产 resolveSchemaName 完全一致（单一事实源的交叉核对）。 */
export function assertSchemaDerivationMatches(cfg) {
  const derived = gate.derivedNamespace(cfg.runId)
  const mismatches = []
  for (const slot of Object.keys(derived.schemas)) {
    const viaProduction = resolveSchemaName(derived.tenants[slot])
    if (viaProduction !== derived.schemas[slot]) mismatches.push({ slot, viaProduction, derived: derived.schemas[slot] })
  }
  if (mismatches.length > 0) throw new Error(`[SCHEMA_DERIVATION_MISMATCH] ${JSON.stringify(mismatches)}`)
  return true
}

/**
 * 受控受限角色 pg 连接：连接后**先**在**同一连接**上做只读身份核验（含 expectedSchema）。
 * 校验与后续操作绑定同一连接。
 */
export async function connectAsRestricted(cfg, expectedSchema = 'public') {
  const { client, verified } = await gate.connectGuarded(cfg, { Client, expectedSchema })
  return { client, verified }
}

/** Prisma transaction client 的薄适配（仅接口转换，不含任何校验规则）。 */
export function prismaTxAsQueryClient(tx) {
  return {
    async query(sql, params = []) {
      const rows = await tx.$queryRawUnsafe(sql, ...(Array.isArray(params) ? params : [params]))
      return { rows: Array.isArray(rows) ? rows : [] }
    },
  }
}

/**
 * 在**新的事务**上：先共享核验，再执行业务（同一 transaction client）。
 *
 * R2 强化：
 *   * **前置拒绝（在创建客户端/事务之前）**：当前 DATABASE_URL 必须等于冻结 cfg.url；tenantCode 必须在
 *     runId 派生集合内；`opts.expectedSchema` **不能**把目标关系改写为越界对象（不接受覆写）。
 *   * 每次调用都重新核验（不以缓存结果跨物理连接放行）。
 *   * `opts.hooks` 仅用于测试计数（clientFactory / transaction / businessCallback），默认无副作用。
 */
export async function withVerifiedTenantTx(basePrisma, cfg, tenantCode, fn, opts = {}) {
  const hooks = opts.hooks || {}
  if (opts.expectedSchema !== undefined && opts.expectedSchema !== null) {
    throw new Error('[EXPECTED_SCHEMA_OVERRIDE_FORBIDDEN] expectedSchema is derived from the tenant code and cannot be overridden by callers')
  }
  // ── 前置检查（在 createTenantClient / transaction 之前）──
  const pre = gate.assertTargetAllowed(cfg, { tenantCode, expectedSchema: null, url: process.env.DATABASE_URL })
  const expectedSchema = pre.expectedSchema
  if (hooks.beforeFactory) await hooks.beforeFactory()
  const db = createTenantClient(basePrisma, tenantCode)
  if (hooks.afterFactory) await hooks.afterFactory()
  return db.$transaction(async (tx) => {
    if (hooks.afterTransactionStart) await hooks.afterTransactionStart(tx) // 传真实 tx（测试可用于在真实事务内改写 search_path 等）
    const adapter = prismaTxAsQueryClient(tx)
    await gate.verifyRuntimeIdentity(adapter, cfg, { expectedSchema })
    if (hooks.beforeBusiness) await hooks.beforeBusiness()
    const result = await fn(tx, expectedSchema)
    if (hooks.afterBusiness) await hooks.afterBusiness()
    return result
  }, { timeout: opts.timeout || 30000 })
}

/** 供测试断言"前置关系"的可读错误码集合。 */
export const TARGET_REFUSAL_CODES = ['TARGET_URL_DRIFT', 'TARGET_CODE_NOT_ALLOWED', 'SCHEMA_NOT_ALLOWED']

/** 由结构化登记表清理任务行（只清登记项）。 */
export const createRegistry = (cfg) => gate.createRegistry(cfg)
export const cleanupRegistered = gate.cleanupRegistered
export const settleAll = gate.settleAll
export const verifyRuntimeIdentity = gate.verifyRuntimeIdentity
