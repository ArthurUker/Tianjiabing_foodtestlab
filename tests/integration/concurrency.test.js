// tests/integration/concurrency.test.js
//
// 并发竞态集成测试 —— 验证方案② Schema-per-tenant 在「事务包裹 + 请求级 SET LOCAL
// search_path」下的隔离安全性。必须使用真实 PostgreSQL（本测试会真正并发打连接池）。
//
// 被测核心（生产代码，直接复用，非重写）：
//   - backend/lib/tenantClient.js 的 setSearchPath()（★唯一切换点）
//   - backend/lib/tenantClient.js 的 resolveSchemaName()
//   - backend/lib/tenantClient.js 的 createTenantClient()（递归 Proxy）
//
// 关键不变量（竞态安全的根基）：
//   1. 每次业务访问都在一个事务内 SET LOCAL search_path，提交后该 LOCAL 设置即丢弃；
//   2. 因此同一连接（连接池复用）上的下一次请求不会继承上一次租户的 search_path；
//   3. 高并发交错下，租户 A 的查询绝不会返回租户 B 的数据。

import pg from 'pg'
import { setSearchPath, resolveSchemaName, createTenantClient } from '../../backend/lib/tenantClient.js'
import {
  createPool,
  bootstrapTenants,
  teardownTenants,
  TENANTS,
} from './pg-bootstrap.js'

const { Pool } = pg

let pool

// ---- 适配器：把生产的 setSearchPath(tx, code) 作用于真实 pg 客户端 ----
// 生产代码内部执行 tx.$executeRawUnsafe(`SET LOCAL search_path TO ...`)，
// 这里把 $executeRawUnsafe 映射到 pg client 的 query，从而复用生产代码路径。
function txAdapter(client) {
  return { $executeRawUnsafe: (sql) => client.query(sql) }
}

// 复刻 createTenantClient 的事务包裹模式（BEGIN → setSearchPath → query → COMMIT）
async function tenantQuery(pool, schoolCode, sql, params = []) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await setSearchPath(txAdapter(client), schoolCode) // 复用生产切换点
    const res = await client.query(sql, params)
    await client.query('COMMIT')
    return res
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// 用「真实 createTenantClient Proxy」+ 一个以真实 pg 为后端的伪 Prisma，
// 端到端地验证 Proxy 会把 search_path 正确注入到每一次 model 方法调用。
//
// 关键设计：createTenantClient 在调用 model 方法时执行
//   value.apply(fnTarget, args)   // fnTarget = tx.<model>
// 其中 tx 是 $transaction 回调收到的「事务客户端」。为了让 model 方法能落到
// 本次事务的真实连接，tx.<model> 必须携带该 client（通过 $client 暴露），
// 且 model 方法一律用 `this.$client` 取连接 —— 这样并发的多个事务各自持有
// 独立 client，绝不会共享/互相覆盖（这正是我们要验证的隔离前提）。
function makeFakePrisma(pool) {
  const api = {
    $transaction: async (fn) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const tx = {
          $executeRawUnsafe: (sql) => client.query(sql),
          // model 命名空间只承载 $client，供 Proxy 注入的 fnTarget 使用
          messages: { $client: client },
        }
        const r = await fn(tx)
        await client.query('COMMIT')
        return r
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },
  }
  // 顶层 model 须为对象（供 Proxy 递归），其方法用 `this.$client` 落到事务连接。
  // Proxy 实际以 tx.messages（含 $client）作为 this 调用，故执行的是本次事务的连接。
  api.messages = {
    findMany() {
      return this.$client.query('SELECT tenant_tag FROM messages').then((r) => r.rows)
    },
    insert(tag) {
      return this.$client
        .query('INSERT INTO messages (tenant_tag, body) VALUES ($1, $2) RETURNING id', [
          tag,
          `insert-${tag}`,
        ])
        .then((r) => r.rows[0])
    },
    count() {
      return this.$client
        .query('SELECT count(*)::int AS n FROM messages')
        .then((r) => r.rows[0].n)
    },
  }
  return api
}

beforeAll(async () => {
  pool = createPool()
  await bootstrapTenants(pool)
})

afterAll(async () => {
  if (pool) {
    await teardownTenants(pool)
    await pool.end()
  }
})

describe('resolveSchemaName —— schoolCode 即 schema 名', () => {
  test('schoolCode 原样作为 schema 名（方案A）', () => {
    expect(resolveSchemaName('school-a')).toBe('school-a')
    expect(resolveSchemaName('school-b')).toBe('school-b')
  })

  test('非法字符被净化，仅保留字母数字下划线连字符', () => {
    expect(resolveSchemaName('school a!@#')).toBe('schoola')
    expect(resolveSchemaName('a.b/c')).toBe('abc')
  })

  test('空 / 未定义回落到默认 schema（public）', () => {
    expect(resolveSchemaName('')).toBe('public')
    expect(resolveSchemaName(null)).toBe('public')
    expect(resolveSchemaName(undefined)).toBe('public')
  })
})

describe('setSearchPath —— 事务级切换点', () => {
  test('事务内 SET LOCAL search_path 生效，提交后不残留', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await setSearchPath(txAdapter(client), 'school-a')
      const during = await client.query('SHOW search_path')
      expect(during.rows[0].search_path).toContain('school-a')

      await client.query('COMMIT')
      // 提交后 LOCAL 设置应被丢弃，回落到默认（不含 school-a）
      const after = await client.query('SHOW search_path')
      expect(after.rows[0].search_path).not.toContain('school-a')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  test('public 始终作为兜底 schema 保留在 search_path 中', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await setSearchPath(txAdapter(client), 'school-b')
      const r = await client.query('SHOW search_path')
      expect(r.rows[0].search_path).toMatch(/public$/)
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

describe('并发竞态 —— 高并发交错下无跨租户数据泄露', () => {
  test('多租户并发查询各自只返回本租户数据', async () => {
    const CONCURRENCY = 30 // 每租户并发数
    const tasks = []
    for (const tenant of TENANTS) {
      for (let i = 0; i < CONCURRENCY; i++) {
        tasks.push(
          tenantQuery(pool, tenant, 'SELECT tenant_tag FROM messages').then((res) => ({
            tenant,
            rows: res.rows,
          }))
        )
      }
    }
    const results = await Promise.all(tasks)

    expect(results.length).toBe(TENANTS.length * CONCURRENCY)
    for (const { tenant, rows } of results) {
      // 每个租户表只有自己的一行，泄露会表现为行数!=1 或 tenant_tag 不符
      expect(rows.length).toBe(1)
      expect(rows[0].tenant_tag).toBe(tenant)
    }
  })

  test('createTenantClient Proxy 在并发下也只命中正确租户', async () => {
    const fakePrisma = makeFakePrisma(pool)
    const CONCURRENCY = 30
    const tasks = []
    for (const tenant of TENANTS) {
      const db = createTenantClient(fakePrisma, tenant) // 真实 Proxy
      for (let i = 0; i < CONCURRENCY; i++) {
        tasks.push(
          db.messages.findMany().then((rows) => ({ tenant, rows }))
        )
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
    const fakePrisma = makeFakePrisma(pool)
    const INSERTS = 10
    const tasks = []
    for (const tenant of TENANTS) {
      const db = createTenantClient(fakePrisma, tenant)
      for (let i = 0; i < INSERTS; i++) {
        tasks.push(db.messages.insert(`ins-${tenant}-${i}`))
      }
    }
    await Promise.all(tasks)

    // 校验：每个租户表恰好 1（初始种子）+ INSERTS 行，且 tenant_tag 前缀正确
    for (const tenant of TENANTS) {
      const db = createTenantClient(fakePrisma, tenant)
      const n = await db.messages.count()
      expect(n).toBe(1 + INSERTS)
      const rows = await db.messages.findMany()
      for (const r of rows) {
        // 种子行 tenant_tag === tenant；并发插入行 tenant_tag === `ins-<tenant>-<i>`
        // 二者都只可能属于本租户 → 验证写入未串到其它 schema
        expect(r.tenant_tag === tenant || r.tenant_tag.startsWith(`ins-${tenant}`)).toBe(
          true
        )
      }
    }
  })
})

describe('连接池复用安全 —— 同一连接上的后续请求不继承前租户 search_path', () => {
  test('事务提交后，长连连接上的新查询回落到默认 schema', async () => {
    const client = await pool.connect()
    try {
      // 第一次：以 school-c 身份查询（提交）
      await client.query('BEGIN')
      await setSearchPath(txAdapter(client), 'school-c')
      const r1 = await client.query('SELECT tenant_tag FROM messages')
      expect(r1.rows[0].tenant_tag).toBe('school-c')
      await client.query('COMMIT')

      // 不重开事务，直接查询默认 search_path —— 不应再命中 school-c
      const r2 = await client.query('SELECT tenant_tag FROM messages')
      expect(r2.rows[0].tenant_tag).toBe('public')
    } finally {
      client.release()
    }
  })
})
