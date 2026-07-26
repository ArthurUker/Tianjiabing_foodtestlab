// tenantClient.js — 多学校隔离核心抽象（方案② Schema-per-tenant）
//
// 设计目标：业务代码统一通过 `req.db.<model>.<method>(...)` 访问数据库，
// 由本模块把请求路由到对应学校的 schema。
//
// ⚠️ 重要背景（为何不用 SET search_path）：
//   Prisma 在生成 SQL 时会把表名【硬编码】为 datasource 的 schema（默认 public），
//   例如 `SELECT ... FROM "public"."User"`。因此在事务里执行
//   `SET LOCAL search_path TO "school_x", public` 对 Prisma 的 model 查询【完全无效】
//   （只对裸 $queryRaw 生效）。这是 Prisma 的已知限制：动态 schema-per-tenant
//   无法通过 search_path 实现。
//
// ✅ 采用方案：为每个 schema 缓存一个「带 ?schema=school_x 连接串」的 PrismaClient。
//   Prisma 会据此把所有 model 查询限定到该 schema，天然隔离、无跨租户竞态。
//   为控制连接数：
//     - 每个租户客户端使用较小的 connection_limit（TENANT_CONNECTION_LIMIT）；
//     - 客户端按 LRU 缓存，超过 MAX_TENANT_CLIENTS 时淘汰最久未用者并断开连接。
//   public（系统表 School / SchoolCustomization 与 dev/test 共享库）直接复用传入的
//   基础 prisma 单例，不额外建客户端。

import { PrismaClient } from '@prisma/client'

const DEFAULT_SCHEMA = process.env.DEFAULT_SCHEMA || 'public'
// 租户客户端上限（LRU）与每客户端连接数上限（控制总连接数）
const MAX_TENANT_CLIENTS = Number(process.env.MAX_TENANT_CLIENTS || 25)
const TENANT_CONNECTION_LIMIT = Number(process.env.TENANT_CONNECTION_LIMIT || 3)

// schema -> { client: PrismaClient, lastUsed: number }
const tenantClients = new Map()

// —— 对外学校代码白名单（DS-06：全系统单一事实源）——
// 对外输入 schoolCode 只允许小写字母、数字、连字符，长度 1~40，不允许下划线。
const CODE_RE = /^[a-z0-9-]{1,40}$/

export function isValidSchoolCode(code) {
  return typeof code === 'string' && CODE_RE.test(code)
}

// —— schema 名白名单（DS-05）——
// 必须 school_ 前缀 + 小写字母数字下划线，且 ≤ 63 字符（PG 标识符上限）。
// 任何把 schema 名拼进 DDL/连接串前都必须先过此校验，不匹配立即 throw。
const SAFE_SCHEMA_RE = /^school_[a-z0-9_]+$/
const MAX_SCHEMA_LEN = 63

export function assertSafeSchemaName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_SCHEMA_LEN || !SAFE_SCHEMA_RE.test(name)) {
    throw new Error(`非法 schema 名: ${JSON.stringify(name)}（必须满足 /^school_[a-z0-9_]+$/ 且长度 ≤ 63）`)
  }
  return name
}

// 由学校代码推导 schema 名 —— 全系统 schema 命名的【单一事实源】。
// 统一加 "school_" 前缀，避免学校代码与系统 schema（public / pg_catalog /
// information_schema）冲突，并防止 schema 名注入。
// 归一规则（幂等、注入安全，DS-06 统一后）：
//   - 空/非法 → null（由 resolveSchemaName 回落到默认 schema）
//   - 已带 "school_" 前缀 → 去前缀后按 code 白名单（-→_ 还原）校验再归一
//   - 历史/URL 写法 "school-xxx" → 归一为 "school_xxx"
//   - 普通代码 "tianjiabing" → "school_tianjiabing"，code 中 "-" 替换为 "_"
export function schemaNameOf(schoolCode) {
  if (typeof schoolCode !== 'string' || schoolCode.length === 0) return null
  let code = schoolCode.toLowerCase()
  if (/^school_/.test(code)) {
    // 已是 schema 形态：去前缀，把 _ 视作历史 - 的归一结果还原后校验
    code = code.slice('school_'.length).replace(/_/g, '-')
  } else {
    code = code.replace(/^school-/, '')
  }
  if (!CODE_RE.test(code)) return null
  return `school_${code.replace(/-/g, '_')}`
}

// 由 schoolCode 推导 schema 名；为空时回落到默认 schema（dev/test 共享）。
export function resolveSchemaName(schoolCode, defaultSchema = DEFAULT_SCHEMA) {
  return schemaNameOf(schoolCode) || defaultSchema
}

function baseDatabaseUrl() {
  return (process.env.DATABASE_URL || '').split('?')[0]
}

function buildTenantUrl(schema) {
  assertSafeSchemaName(schema) // DS-05: 连接串拼接前强制白名单校验
  const base = baseDatabaseUrl()
  if (!base) throw new Error('缺少 DATABASE_URL，无法创建租户客户端')
  return `${base}?schema=${encodeURIComponent(schema)}&connection_limit=${TENANT_CONNECTION_LIMIT}`
}

// 获取（或创建并缓存）绑定到指定 schema 的 PrismaClient。
function getSchemaClient(schema) {
  const hit = tenantClients.get(schema)
  if (hit) {
    hit.lastUsed = Date.now()
    return hit.client
  }
  // LRU 淘汰：超过上限时断开最久未使用的客户端
  if (tenantClients.size >= MAX_TENANT_CLIENTS) {
    let oldestKey = null
    let oldest = Infinity
    for (const [k, v] of tenantClients) {
      if (v.lastUsed < oldest) {
        oldest = v.lastUsed
        oldestKey = k
      }
    }
    if (oldestKey) {
      const ev = tenantClients.get(oldestKey)
      tenantClients.delete(oldestKey)
      ev.client.$disconnect().catch(e => console.warn('[tenantClient] LRU淘汰disconnect失败:', e.message))
    }
  }
  const client = new PrismaClient({ datasources: { db: { url: buildTenantUrl(schema) } } })
  tenantClients.set(schema, { client, lastUsed: Date.now() })
  return client
}

// ★ 唯一切换点：为空时/公共 schema 复用基础 prisma；否则返回该 schema 的专属客户端。
// 保持与旧签名兼容：(prisma, schoolCode, defaultSchema)
export function createTenantClient(prisma, schoolCode, defaultSchema = DEFAULT_SCHEMA) {
  const schema = resolveSchemaName(schoolCode, defaultSchema)
  if (!schema || schema === defaultSchema) return prisma
  return getSchemaClient(schema)
}

// 断开所有租户客户端（进程退出时调用，优雅关闭）
export async function disconnectAllTenantClients() {
  const tasks = []
  for (const [, v] of tenantClients) tasks.push(v.client.$disconnect().catch(e => console.warn('[tenantClient] 关闭disconnect失败:', e.message)))
  tenantClients.clear()
  await Promise.all(tasks)
}

export { DEFAULT_SCHEMA }
