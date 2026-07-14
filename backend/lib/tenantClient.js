// tenantClient.js — 多学校隔离核心抽象（方案② Schema-per-tenant）
//
// 设计目标：业务代码统一通过 `req.db.<model>.<method>(...)` 访问数据库，
// 由本模块在事务内按当前登录学校设置 search_path，路由到对应 schema。
//
// ⚠️ 切换点（预留 PgBouncer Session 模式）：
//   当前采用「事务包裹」策略——每个 model 方法调用都被包进
//   `prisma.$transaction(async tx => { setSearchPath(tx, code); ... })`。
//   将来若改用 PgBouncer（pool_mode = session），只需修改本文件的
//   `setSearchPath` 与 `createTenantClient`（去掉事务包裹、仅在连接获取时
//   设置一次 search_path），业务 handler 代码零改动。
//
// 严禁为每校各自 new 一个 PrismaClient（会退化为方案③连接膨胀）。

const DEFAULT_SCHEMA = process.env.DEFAULT_SCHEMA || 'public'

// client 级方法：不在事务包裹内透传（保持原语义）
const PASSTHROUGH = new Set([
  '$connect',
  '$disconnect',
  '$use',
  '$extends',
  '$on',
  '$metric',
  '$applyPendingMigrations'
])

function sanitizeSchoolCode(schoolCode) {
  if (!schoolCode) return null
  // 仅保留字母数字下划线，防止 schema 名注入
  const safe = String(schoolCode).replace(/[^a-zA-Z0-9_]/g, '')
  return safe || null
}

// 由 schoolCode 推导 schema 名；为空时回落到默认 schema（dev/test 共享）
export function resolveSchemaName(schoolCode, defaultSchema = DEFAULT_SCHEMA) {
  const code = sanitizeSchoolCode(schoolCode)
  if (!code) return defaultSchema
  return `school_${code}`
}

// ★ 唯一切换点：在事务内设置 search_path
// 始终把 public 作为兜底 schema，确保系统表 School / SchoolCustomization
// （位于 public）始终可被解析。
export async function setSearchPath(tx, schoolCode, defaultSchema = DEFAULT_SCHEMA) {
  const schema = resolveSchemaName(schoolCode, defaultSchema)
  await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`)
}

// 构造请求级租户客户端：任意 model 方法调用都会被包进事务并设置 search_path
export function createTenantClient(prisma, schoolCode, defaultSchema = DEFAULT_SCHEMA) {
  const make = (target, path) =>
    new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'symbol') return t[prop]

        const value = t[prop]

        // 透传 client 级生命周期 / 扩展方法
        if (PASSTHROUGH.has(prop)) return value

        // $transaction：在回调执行前注入 search_path
        if (prop === '$transaction') {
          return (arg, ...rest) =>
            prisma.$transaction(async (tx) => {
              await setSearchPath(tx, schoolCode, defaultSchema)
              return typeof arg === 'function' ? arg(tx) : arg
            }, ...rest)
        }

        // 裸 raw 查询：同样在事务内带 search_path
        if (
          prop === '$executeRawUnsafe' ||
          prop === '$executeRaw' ||
          prop === '$queryRawUnsafe' ||
          prop === '$queryRaw'
        ) {
          return (...args) =>
            prisma.$transaction(async (tx) => {
              await setSearchPath(tx, schoolCode, defaultSchema)
              return value.apply(tx, args)
            })
        }

        // 嵌套对象（如 prisma.testRecord）→ 继续代理并累积路径
        if (value && typeof value === 'object') {
          return make(value, [...path, prop])
        }

        // 业务方法（如 prisma.testRecord.findMany）→ 包进事务
        if (typeof value === 'function') {
          return (...args) =>
            prisma.$transaction(async (tx) => {
              await setSearchPath(tx, schoolCode, defaultSchema)
              // 沿路径在事务客户端上定位到对应的 model 对象作为 this
              let fnTarget = tx
              for (const p of path) fnTarget = fnTarget[p]
              return value.apply(fnTarget, args)
            })
        }

        return value
      }
    })

  return make(prisma, [])
}

export { DEFAULT_SCHEMA }
