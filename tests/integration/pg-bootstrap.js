// tests/integration/pg-bootstrap.js
//
// 并发竞态集成测试的 PostgreSQL 引导模块。
// 负责：解析连接串 / 创建多租户 schema / 建表 / 写入可区分的种子行。
// 真实 PostgreSQL 才能复现 search_path 事务级隔离与连接池竞态，故本模块只用于
// 需要 live PG 的集成测试（jest 默认单测套件不会加载本文件）。

import pg from 'pg'
import { resolveSchemaName } from '../../backend/lib/tenantClient.js'
const { Pool } = pg

// 测试用租户学校代码。真实 schema 名由生产的 resolveSchemaName 推导（school_<code>），
// 确保测试与生产走同一套命名逻辑（单一事实源）。
export const TENANTS = ['school-a', 'school-b', 'school-c']

// 学校代码 → 真实 schema 名（复用生产逻辑）
export const schemaOf = (code) => resolveSchemaName(code)

export function getDatabaseUrl() {
  // 允许通过环境变量注入真实连接串；缺省使用本机 brew 安装的 PG 默认参数
  return (
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@127.0.0.1:5432/foodsentinel_test'
  )
}

export function createPool() {
  return new Pool({ connectionString: getDatabaseUrl() })
}

// 在数据库内建立测试用的多租户结构：
//   public.messages  +  school-a.messages / school-b.messages / school-c.messages
// 每个 schema 的 messages 表含 tenant_tag 列，用于断言"某次查询只返回本租户数据"。
export async function bootstrapTenants(pool) {
  const client = await pool.connect()
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS public')
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.messages (
        id serial PRIMARY KEY,
        tenant_tag text NOT NULL,
        body text NOT NULL
      )
    `)

    for (const t of TENANTS) {
      const schema = schemaOf(t)
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      await client.query(`
        CREATE TABLE IF NOT EXISTS "${schema}".messages (
          id serial PRIMARY KEY,
          tenant_tag text NOT NULL,
          body text NOT NULL
        )
      `)
      // 清空后写入「仅属于该租户」的可区分行，便于泄露检测
      await client.query(`TRUNCATE TABLE "${schema}".messages`)
      await client.query(
        `INSERT INTO "${schema}".messages (tenant_tag, body) VALUES ($1, $2)`,
        [t, `data-of-${t}`]
      )
    }
    // public 也放一行，确保「回落到 public」的查询不会误命中租户数据
    await client.query('TRUNCATE TABLE public.messages')
    await client.query(
      'INSERT INTO public.messages (tenant_tag, body) VALUES ($1, $2)',
      ['public', 'data-of-public']
    )
  } finally {
    client.release()
  }
}

// 彻底清理测试结构（测试套件结束后调用）
export async function teardownTenants(pool) {
  const client = await pool.connect()
  try {
    for (const t of TENANTS) {
      await client.query(`DROP SCHEMA IF EXISTS "${schemaOf(t)}" CASCADE`)
    }
    await client.query('DROP TABLE IF EXISTS public.messages')
  } finally {
    client.release()
  }
}
