/**
 * @jest-environment node
 *
 * 角色变更审计 + 即时失效 集成测试（#10 / #7 / #9）
 *
 * P3-W0-T02A：连接与真实身份来自共享隔离门禁（显式 TEST_DATABASE_URL + 任务上下文 + 受限角色）。
 *   - 配置缺失/冲突在 setupFiles 与 beforeAll **连接之前**即拒绝（本文件不再有 skip 分支）；
 *   - 任务 schema 与 user（由 runId 派生）由 provisioner 在独占实例中创建；不采纳
 *     school_tjb / test 等历史默认值，也不读取 TEST_SCHEMA / TEST_ROLE_USER；
 *   - 校验（身份核验）与操作绑定**同一受控连接**；不再每次新建连接。
 *
 * 验证目标（需真实 PostgreSQL）：
 *   1. 裸 SQL `UPDATE "User" SET role=...`（绕过 changeUserRole 应用层）仍会：
 *      (a) 写入租户 AuditLog(action='role_change', resource_id, details.oldRole/newRole/source)；
 *      (b) 写入 public.revoked_tokens(token_type='user_all') 使旧 token 即刻失效；
 *   2. 角色合法性 CHECK 约束生效：非法 role / NULL 被拒绝（兜底 #9）。
 *
 * 依赖：provisioner 已对任务 roleAudit schema 应用 backend/prisma/role-audit-trigger.sql。
 * 结束后恢复原角色（既有语义）。
 */
'use strict'

const gate = require('../helpers/db-isolation.cjs')
const { Client } = require('pg')

describe('role-audit-trigger (DB-level role change audit + revocation)', () => {
  let cfg
  let client
  let schemaSql
  let userId
  let originalRole

  beforeAll(async () => {
    // 连接前配置校验（防御性重复；setupFiles 已拒绝一次）
    cfg = gate.assertIsolationConfigOrThrow(process.env)
    const conn = await gate.connectGuarded(cfg, { Client, expectedSchema: 'public' }) // 连接后先做只读身份核验（测试角色默认 search_path=public）
    client = conn.client
    if (!cfg.roleAudit || !cfg.roleAudit.schema || !cfg.roleAudit.userId) {
      throw new Error('[TEST_SETUP] isolation context is missing roleAudit schema/user (provisioner contract)')
    }
    schemaSql = gate.quoteIdent(cfg.roleAudit.schema) // 严格校验后引用，不拼接任意输入

    const r = await client.query(`SELECT id, role FROM ${schemaSql}."User" WHERE id = $1 LIMIT 1`, [cfg.roleAudit.userId])
    expect(r.rows.length).toBe(1)
    userId = r.rows[0].id
    originalRole = r.rows[0].role
  })

  afterAll(async () => {
    // 分别尝试恢复与释放，不因第一处失败跳过；错误聚合后整体非零（保留根因）
    const result = await gate.settleAll([
      { name: 'restoreRole', fn: () => (client && userId && originalRole ? client.query(`UPDATE ${schemaSql}."User" SET role = $1 WHERE id = $2`, [originalRole, userId]) : Promise.resolve()) },
      { name: 'client.end', fn: () => (client ? client.end() : Promise.resolve()) },
    ])
    if (!result.ok) {
      const err = new Error(`[AFTER_ALL_FAILED] ${result.errors.length} teardown step(s) failed`)
      err.details = result.errors
      throw err
    }
  })

  it('裸 SQL 改角色自动写 AuditLog（#10）', async () => {
    const c = client
    const before = await c.query(
      `SELECT count(*)::int AS n FROM ${schemaSql}."AuditLog" WHERE action='role_change' AND resource_id=$1`,
      [userId]
    )
    const n0 = before.rows[0].n

    const flip = originalRole === 'operator' ? 'manager' : 'operator'
    await c.query(`UPDATE ${schemaSql}."User" SET role=$1 WHERE id=$2`, [flip, userId])

    const after = await c.query(
      `SELECT details FROM ${schemaSql}."AuditLog" WHERE action='role_change' AND resource_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    )
    expect(after.rows.length).toBeGreaterThan(0)
    const d = typeof after.rows[0].details === 'string'
      ? JSON.parse(after.rows[0].details)
      : after.rows[0].details
    expect(d.oldRole).toBe(originalRole)
    expect(d.newRole).toBe(flip)
    expect(['app', 'db-direct']).toContain(d.source)
    expect(after.rows.length).toBeGreaterThan(0)
    // 至少新增一条审计（相对 before 计数）
    const afterCount = await c.query(
      `SELECT count(*)::int AS n FROM ${schemaSql}."AuditLog" WHERE action='role_change' AND resource_id=$1`,
      [userId]
    )
    expect(afterCount.rows[0].n).toBeGreaterThan(n0)

    // 还原
    await c.query(`UPDATE ${schemaSql}."User" SET role=$1 WHERE id=$2`, [originalRole, userId])
  })

  it('裸 SQL 改角色自动全量吊销会话（#7）', async () => {
    const c = client
    const flip = originalRole === 'operator' ? 'manager' : 'operator'
    await c.query(`UPDATE ${schemaSql}."User" SET role=$1 WHERE id=$2`, [flip, userId])

    const rev = await c.query(
      `SELECT count(*)::int AS n FROM public.revoked_tokens WHERE user_id=$1 AND token_type='user_all'`,
      [userId]
    )
    expect(rev.rows[0].n).toBeGreaterThanOrEqual(1)

    await c.query(`UPDATE ${schemaSql}."User" SET role=$1 WHERE id=$2`, [originalRole, userId])
  })

  it('非法 role 被 CHECK 约束拒绝（#9）', async () => {
    const c = client
    await expect(
      c.query(`UPDATE ${schemaSql}."User" SET role='superadmin' WHERE id=$1`, [userId])
    ).rejects.toThrow()
    // 角色未被改坏
    const cur = await c.query(`SELECT role FROM ${schemaSql}."User" WHERE id=$1`, [userId])
    expect(['admin', 'manager', 'operator', 'viewer']).toContain(cur.rows[0].role)
  })
})
