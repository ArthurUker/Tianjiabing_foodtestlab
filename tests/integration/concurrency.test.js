// tests/integration/concurrency.test.js
//
// 多租户隔离集成测试 —— 验证方案② Schema-per-tenant 在【每 schema 独立
// PrismaClient（?schema=school_x）】架构下的隔离安全性。必须使用真实 PostgreSQL。
//
// 背景（为何不再用 SET search_path）：
//   Prisma 生成 SQL 时把表名硬编码为 datasource schema（默认 public），
//   `SET LOCAL search_path` 对 Prisma 的 model 查询无效。故改为按 schema 缓存
//   带 ?schema= 连接串的 PrismaClient，由 Prisma 自身把查询限定到该 schema。
//
// 被测核心（生产代码，直接复用）：
//   - backend/lib/tenantClient.js 的 resolveSchemaName()（schema 命名单一事实源）
//   - backend/lib/tenantClient.js 的 createTenantClient()（按 schema 返回/缓存客户端）
//
// 关键不变量：
//   1. 每个租户客户端的查询只落在其 schema，绝不返回其它租户数据；
//   2. 高并发交错下无跨租户泄露；
//   3. 同一 schema 重复获取返回同一缓存客户端（连接数可控）。

import { PrismaClient } from '@prisma/client'
import {
  resolveSchemaName,
  createTenantClient,
  disconnectAllTenantClients,
} from '../../backend/lib/tenantClient.js'
import {
  createPool,
  bootstrapTenants,
  teardownTenants,
  getDatabaseUrl,
  schemaOf,
  TENANTS,
} from './pg-bootstrap.js'

let pool
let basePrisma

beforeAll(async () => {
  // 确保 tenantClient.createTenantClient 使用与 bootstrap 相同的库
  process.env.DATABASE_URL = getDatabaseUrl()
  pool = createPool()
  await bootstrapTenants(pool)
  basePrisma = new PrismaClient({ datasources: { db: { url: getDatabaseUrl() } } })
})

afterAll(async () => {
  await disconnectAllTenantClients()
  if (basePrisma) await basePrisma.$disconnect()
  if (pool) {
    await teardownTenants(pool)
    await pool.end()
  }
})

// 通过租户客户端读取 messages（裸查询走该客户端 ?schema= 的 search_path）
async function readTenant(code) {
  const db = createTenantClient(basePrisma, code)
  const rows = await db.$queryRawUnsafe('SELECT tenant_tag FROM messages')
  return rows
}

describe('resolveSchemaName —— 统一 school_ 前缀', () => {
  test('普通代码加 school_ 前缀', () => {
    expect(resolveSchemaName('tianjiabing')).toBe('school_tianjiabing')
    expect(resolveSchemaName('sysdynit')).toBe('school_sysdynit')
  })

  test('历史 school- 写法归一为 school_（幂等）', () => {
    expect(resolveSchemaName('school-a')).toBe('school_a')
    expect(resolveSchemaName('school-tianjiabing')).toBe('school_tianjiabing')
    expect(resolveSchemaName('school_tianjiabing')).toBe('school_tianjiabing')
  })

  test('含非法字符的代码被整体拒绝，回落默认 schema（REG-1: DS-06 白名单拒绝语义，取代旧「净化保留」）', () => {
    // 现行 schemaNameOf 对不满足 /^[a-z0-9-]{1,40}$/ 的输入返回 null → 回落 public，
    // 比旧的"剥离非法字符后保留"更安全（避免 'foo a!@#' 与 'fooa' 静默撞同一 schema）。
    expect(resolveSchemaName('foo a!@#')).toBe('public')
    expect(resolveSchemaName('a.b/c')).toBe('public')
  })

  test('空 / 未定义回落到默认 schema（public）', () => {
    expect(resolveSchemaName('')).toBe('public')
    expect(resolveSchemaName(null)).toBe('public')
    expect(resolveSchemaName(undefined)).toBe('public')
  })
})

describe('createTenantClient —— 按 schema 隔离与缓存', () => {
  test('同一 schema 重复获取返回同一缓存客户端（连接数可控）', () => {
    const a1 = createTenantClient(basePrisma, 'school-a')
    const a2 = createTenantClient(basePrisma, 'school-a')
    expect(a1).toBe(a2)
    const b1 = createTenantClient(basePrisma, 'school-b')
    expect(b1).not.toBe(a1)
  })

  test('public / 空代码复用基础客户端', () => {
    expect(createTenantClient(basePrisma, null)).toBe(basePrisma)
    expect(createTenantClient(basePrisma, '')).toBe(basePrisma)
  })

  test('每个租户客户端只读到本 schema 数据', async () => {
    for (const t of TENANTS) {
      const rows = await readTenant(t)
      expect(rows.length).toBe(1)
      expect(rows[0].tenant_tag).toBe(t)
    }
  })
})

describe('并发竞态 —— 高并发交错下无跨租户数据泄露', () => {
  test('多租户并发查询各自只返回本租户数据', async () => {
    const CONCURRENCY = 30
    const tasks = []
    for (const tenant of TENANTS) {
      for (let i = 0; i < CONCURRENCY; i++) {
        tasks.push(readTenant(tenant).then((rows) => ({ tenant, rows })))
      }
    }
    const results = await Promise.all(tasks)

    expect(results.length).toBe(TENANTS.length * CONCURRENCY)
    for (const { tenant, rows } of results) {
      expect(rows.length).toBe(1)
      expect(rows[0].tenant_tag).toBe(tenant)
    }
  })

  test('并发写入不串租户：每租户写入只落在本 schema', async () => {
    const INSERTS = 10
    const tasks = []
    for (const tenant of TENANTS) {
      const db = createTenantClient(basePrisma, tenant)
      for (let i = 0; i < INSERTS; i++) {
        tasks.push(
          db.$executeRawUnsafe(
            `INSERT INTO messages (tenant_tag, body) VALUES ($1, $2)`,
            `ins-${tenant}-${i}`,
            `insert-${tenant}`
          )
        )
      }
    }
    await Promise.all(tasks)

    for (const tenant of TENANTS) {
      const db = createTenantClient(basePrisma, tenant)
      const rows = await db.$queryRawUnsafe('SELECT tenant_tag FROM messages')
      // 1 初始种子 + INSERTS 并发插入
      expect(rows.length).toBe(1 + INSERTS)
      for (const r of rows) {
        expect(r.tenant_tag === tenant || r.tenant_tag.startsWith(`ins-${tenant}`)).toBe(true)
      }
    }
  })
})

describe('无跨 schema 回落 —— 租户查询绝不命中 public', () => {
  test('public 独有的行不会出现在任何租户查询结果中', async () => {
    // public.messages 有一行 tenant_tag = 'public'
    for (const t of TENANTS) {
      const rows = await readTenant(t)
      expect(rows.some((r) => r.tenant_tag === 'public')).toBe(false)
    }
  })
})
