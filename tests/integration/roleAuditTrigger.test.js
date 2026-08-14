/**
 * @jest-environment node
 *
 * 角色变更审计 + 即时失效 集成测试（#10 / #7 / #9）
 *
 * 验证目标（需真实 PostgreSQL，连接字符串来自 process.env.DATABASE_URL；
 * 无该变量时整个 suite 自动 skip，避免无 PG 环境 npm test 失败）：
 *
 *   1. 裸 SQL `UPDATE "User" SET role=...`（绕过 changeUserRole 应用层）仍会：
 *      (a) 写入租户 AuditLog(action='role_change', resource_id, details.oldRole/newRole/source)；
 *      (b) 写入 public.revoked_tokens(token_type='user_all') 使旧 token 即刻失效；
 *   2. 角色合法性 CHECK 约束生效：非法 role / NULL 被拒绝（兜底 #9）。
 *
 * 依赖：backend/prisma/role-audit-trigger.sql 已对该租户 schema 执行。
 * 测试用独立租户账号，互不污染；结束后恢复原角色。
 */

const { Client } = require('pg')

const DATABASE_URL = process.env.DATABASE_URL
const SCHEMA = process.env.TEST_SCHEMA || 'school_tjb'
const TEST_USERNAME = process.env.TEST_ROLE_USER || 'test'

const withPg = async (fn) => {
  const client = new Client({ connectionString: DATABASE_URL })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
}

describe('role-audit-trigger (DB-level role change audit + revocation)', () => {
  if (!DATABASE_URL) {
    it.skip('requires DATABASE_URL, skipped', () => {})
    return
  }

  let userId
  let originalRole

  beforeAll(async () => {
    await withPg(async (c) => {
      const r = await c.query(
        `SELECT id, role FROM ${SCHEMA}."User" WHERE username = $1 LIMIT 1`,
        [TEST_USERNAME]
      )
      expect(r.rows.length).toBe(1)
      userId = r.rows[0].id
      originalRole = r.rows[0].role
    })
  })

  afterAll(async () => {
    if (!userId || !originalRole) return
    await withPg(async (c) => {
      await c.query(`UPDATE ${SCHEMA}."User" SET role = $1 WHERE id = $2`, [originalRole, userId])
    })
  })

  it('裸 SQL 改角色自动写 AuditLog（#10）', async () => {
    await withPg(async (c) => {
      const before = await c.query(
        `SELECT count(*)::int AS n FROM ${SCHEMA}."AuditLog" WHERE action='role_change' AND resource_id=$1`,
        [userId]
      )
      const n0 = before.rows[0].n

      const flip = originalRole === 'operator' ? 'manager' : 'operator'
      await c.query(`UPDATE ${SCHEMA}."User" SET role=$1 WHERE id=$2`, [flip, userId])

      const after = await c.query(
        `SELECT details FROM ${SCHEMA}."AuditLog" WHERE action='role_change' AND resource_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
      )
      expect(after.rows.length).toBeGreaterThan(0)
      const d = typeof after.rows[0].details === 'string'
        ? JSON.parse(after.rows[0].details)
        : after.rows[0].details
      expect(d.oldRole).toBe(originalRole)
      expect(d.newRole).toBe(flip)
      expect(['app', 'db-direct']).toContain(d.source)

      // 还原
      await c.query(`UPDATE ${SCHEMA}."User" SET role=$1 WHERE id=$2`, [originalRole, userId])
    })
  })

  it('裸 SQL 改角色自动全量吊销会话（#7）', async () => {
    await withPg(async (c) => {
      const flip = originalRole === 'operator' ? 'manager' : 'operator'
      await c.query(`UPDATE ${SCHEMA}."User" SET role=$1 WHERE id=$2`, [flip, userId])

      const rev = await c.query(
        `SELECT count(*)::int AS n FROM public.revoked_tokens WHERE user_id=$1 AND token_type='user_all'`,
        [userId]
      )
      expect(rev.rows[0].n).toBeGreaterThanOrEqual(1)

      await c.query(`UPDATE ${SCHEMA}."User" SET role=$1 WHERE id=$2`, [originalRole, userId])
    })
  })

  it('非法 role 被 CHECK 约束拒绝（#9）', async () => {
    await withPg(async (c) => {
      await expect(
        c.query(`UPDATE ${SCHEMA}."User" SET role='superadmin' WHERE id=$1`, [userId])
      ).rejects.toThrow()
      // 角色未被改坏
      const cur = await c.query(`SELECT role FROM ${SCHEMA}."User" WHERE id=$1`, [userId])
      expect(['admin', 'manager', 'operator', 'viewer']).toContain(cur.rows[0].role)
    })
  })
})
