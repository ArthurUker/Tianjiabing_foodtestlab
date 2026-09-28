// P3-W1-T01 会话失效矩阵套件共用桥（不是测试文件：不以 .test.mjs 结尾，node --test 不收集）。
//
// 职责：隔离契约读取（TEST_* → provisioner 上下文）→ 管理连接（schema owner，等价生产
// DATABASE_URL 角色）派生 → 身份核验 → 真实 UserManager / 认证中间件 / 路由 handler 构造。
// 任一前置缺失 → fail-closed（抛错，绝不 skip、不回落业务库）。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = path.resolve(here, '../../..')
export const backendRequire = createRequire(path.join(repoRoot, 'backend/package.json'))
const gate = require(path.join(repoRoot, 'tests/helpers/db-isolation.cjs'))

/** 读取隔离上下文 + 派生管理连接（provisoner 的 admin.env）。 */
export function loadW1Context() {
  const check = gate.checkIsolationConfig(process.env)
  if (!check.ok) {
    throw new Error(`[W1-HARNESS-REFUSED] ${check.code}: ${check.reason}（需 provisioner 的 test-env.sh）`)
  }
  const cfg = check.cfg
  const derived = gate.derivedNamespace(cfg.runId)
  const contextPath = process.env.TEST_DB_CONTEXT_FILE
  const ctx = JSON.parse(fs.readFileSync(contextPath, 'utf8'))
  const instanceRoot = path.dirname(contextPath)
  const adminEnv = fs.readFileSync(path.join(instanceRoot, 'admin.env'), 'utf8')
  const adminUser = adminEnv.match(/^ADMIN_USER=(.*)$/m)?.[1]
  const adminPassword = adminEnv.match(/^ADMIN_PASSWORD=(.*)$/m)?.[1]
  if (!adminUser || !adminPassword) throw new Error('[W1-HARNESS-REFUSED] admin.env 缺少凭据')
  const ownership = JSON.parse(fs.readFileSync(path.join(instanceRoot, 'ownership.json'), 'utf8'))
  const adminUrl = `postgresql://${adminUser}:${encodeURIComponent(adminPassword)}@127.0.0.1:${cfg.port}/${cfg.database}`
  return { cfg, derived, ctx, adminUrl, adminUser, ownership, instanceRoot }
}

/** 创建管理连接（引擎/业务写用；schema owner）。 */
export function createAdminPrisma(w1) {
  const { PrismaClient } = backendRequire('@prisma/client')
  return new PrismaClient({ datasources: { db: { url: w1.adminUrl } } })
}

/** 身份核验（写任何数据之前；失败即抛出）。 */
export async function assertAdminIdentity(prisma, w1) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT current_database() AS db, current_user AS cu, inet_server_addr()::text AS addr, inet_server_port() AS port'
  )
  const id = rows?.[0] || {}
  const addr = typeof id.addr === 'string' ? id.addr.split('/')[0] : id.addr
  const problems = []
  if (id.db !== w1.cfg.database) problems.push(`db=${id.db}`)
  if (id.cu !== w1.ownership.user && id.cu !== w1.adminUser) problems.push(`user=${id.cu}`)
  if (addr !== w1.cfg.host) problems.push(`addr=${id.addr}`)
  if (Number(id.port) !== Number(w1.cfg.port)) problems.push(`port=${id.port}`)
  if (problems.length) throw new Error(`[W1-IDENTITY] 管理连接未指向本任务隔离实例: ${problems.join(', ')}`)
  return { db: id.db, user: id.cu, port: Number(id.port), addr }
}

/** tenantClient 的 baseDatabaseUrl() 读 process.env.DATABASE_URL → 指向本实例管理连接。 */
export function pointEngineEnvToInstance(w1) {
  process.env.DATABASE_URL = w1.adminUrl
}

/** 确保学校行存在（public."School"），供 epoch/school 状态用例使用。 */
export async function ensureSchoolRow(prisma, { code, name = 'W1 会话矩阵测试校', status = 'active' }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."School" ("id","code","name","status","created_at","updated_at")
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT ("code") DO UPDATE SET "status" = EXCLUDED."status", "updated_at" = NOW()`,
    `w1-school-${code}`, code, name, status
  )
}

/** 在租户 schema 内建/重置一个测试用户（存在则更新密码与状态）。 */
export async function upsertTenantUser(prisma, { schema, schoolCode, username, passwordHash, role = 'operator', status = 'active', mustChange = false }, bcryptjs) {
  const id = `w1-user-${username}`
  const exists = await prisma.$queryRawUnsafe(`SELECT "id" FROM "${schema}"."User" WHERE "id" = $1`, id)
  if (exists.length) {
    await prisma.$executeRawUnsafe(
      `UPDATE "${schema}"."User" SET "status" = $2, "role" = $3, "password_hash" = $4, "must_change_password" = $5, "school_code" = $6, "updated_at" = NOW() WHERE "id" = $1`,
      id, status, role, passwordHash, mustChange, schoolCode
    )
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."User" ("id","username","password_hash","role","full_name","status","school_code","must_change_password","created_at","updated_at")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,
      id, username, passwordHash, role, `W1 ${username}`, status, schoolCode, mustChange
    )
  }
  return id
}

/** 租户 User 表是否就绪（缺表 → 调用方 fail-closed 报错，不 skip）。 */
export async function assertTenantUserTable(prisma, schema) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'User' LIMIT 1`,
    schema
  )
  if (!rows.length) {
    throw new Error(`[W1-HARNESS-REFUSED] 租户 schema ${schema} 缺少 "User" 表（需先跑既有 fixture 链：t02c-instance-fixture）`)
  }
}

/** 事务内已建的 epoch 行读取（诊断/断言）。 */
export async function readEpochRows(prisma, { userId = null, schoolCode = null }) {
  return prisma.$queryRawUnsafe(
    `SELECT jti, user_id, school_code, token_type, reason, revoked_at
       FROM public.revoked_tokens
      WHERE ($1::text IS NOT NULL AND user_id = $1::text)
         OR ($2::text IS NOT NULL AND school_code = $2::text)
      ORDER BY revoked_at DESC`,
    userId, schoolCode
  )
}
