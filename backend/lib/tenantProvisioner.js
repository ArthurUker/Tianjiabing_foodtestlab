// tenantProvisioner.js — 租户（学校）初始化核心逻辑（方案② Schema-per-tenant）
//
// 被两处复用，保证首部署与运行时"动态建学校"行为完全一致：
//   1. prisma/provision-tenants.js —— 首次部署批量初始化（deploy.sh 调用）
//   2. server.js 的 POST /api/admin/schools —— 运行时超管动态新增学校
//
// 单个学校的初始化步骤（全部幂等）：
//   ① 创建 schema `school_<code>`
//   ② 用 `prisma db push` 把业务表推入该 schema
//   ③ 写入 public."School" / "SchoolCustomization" 系统记录
//   ④ 在租户 schema 内创建首个 manager 账号（admin 角色保留给平台超管）

import bcryptjs from 'bcryptjs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { schemaNameOf, isValidSchoolCode, assertSafeSchemaName } from './tenantClient.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// backend 目录（schema.prisma 位于 backend/prisma/schema.prisma）
const BACKEND_DIR = path.resolve(__dirname, '..')

// 校验/命名统一由 tenantClient 提供（DS-06 单一事实源），此处再导出以兼容既有引用。
export { schemaNameOf, isValidSchoolCode }

/**
 * 异步执行 `npx prisma db push`，返回 stdout 字符串。
 * 用 spawn 替代 spawnSync，避免阻塞事件循环（TD-SpawnSync）。
 * @param {string[]} args
 * @param {string} databaseUrl
 * @param {string} schema
 * @returns {Promise<string>}
 */
function runPrismaPush(args, databaseUrl, schema) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', args, {
      cwd: BACKEND_DIR,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 120000
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(stdout)
      const detail = stderr || stdout || (signal ? `被信号 ${signal} 终止` : `退出码 ${code}`)
      reject(new Error(`prisma db push 失败 (schema=${schema}): ${detail.slice(0, 1000)}`))
    })
  })
}

/**
 * 初始化单个学校。
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} opts.prisma 全局 Prisma 单例（连 public）
 * @param {string} opts.code 学校代码（小写字母数字连字符）
 * @param {string} [opts.name] 学校显示名
 * @param {string} opts.adminPassword 租户 admin 初始密码
 * @param {string} [opts.databaseUrl] 基础连接串（默认取 process.env.DATABASE_URL）
 * @param {(msg:string)=>void} [opts.log] 日志回调
 * @returns {Promise<{code:string, schema:string, created:boolean, adminCreated:boolean}>}
 */
export async function provisionSchool({
  prisma,
  code,
  name,
  adminPassword,
  databaseUrl = process.env.DATABASE_URL,
  log = () => {}
}) {
  if (!isValidSchoolCode(code)) {
    throw new Error(`非法学校代码: ${code}（仅允许小写字母、数字、连字符，长度 1~40）`)
  }
  const baseUrl = (databaseUrl || '').split('?')[0]
  if (!baseUrl) throw new Error('缺少 DATABASE_URL，无法初始化学校')

  const schema = schemaNameOf(code)
  // DS-05：任何把 schema 名拼进 SQL/DDL 前强制白名单校验（不匹配立即 throw）
  assertSafeSchemaName(schema)
  const displayName = name || `学校(${code})`
  const pw = adminPassword || 'changeme'

  // ① 创建 schema（幂等）
  const exists = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
    schema
  )
  let created = false
  if (!exists.length) {
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    created = true
    log(`✅ 创建 schema: ${schema}`)
  } else {
    log(`ℹ️ schema 已存在: ${schema}`)
  }

  // ② 推送业务表到该 schema（prisma db push，指定 ?schema=）
  const tenantUrl = `${baseUrl}?schema=${encodeURIComponent(schema)}`
  log(`→ 推送表结构到 ${schema} ...`)
  // ② 推送业务表到该 schema（异步非阻塞，避免阻塞事件循环，TD-SpawnSync）
  // NB-05: --accept-data-loss 仅首次 provision（无数据）时相对安全；
  // reprovision 场景去掉该 flag，避免列类型不兼容时静默丢数据。
  const isReprovision = !created
  const pushArgs = ['prisma', 'db', 'push', '--skip-generate']
  if (isReprovision) {
    log('⚠️ reprovision: 跳过 --accept-data-loss，避免静默丢数据')
  } else {
    pushArgs.push('--accept-data-loss')
  }
  const pushOutput = await runPrismaPush(pushArgs, tenantUrl, schema)
  log(`✅ ${schema} 表结构就绪 (${pushOutput.split('\n').slice(-3).join(' | ')})`)

  // ③ 系统记录（public，幂等）
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."School" ("id","code","name","status","created_at","updated_at")
     VALUES ($1,$2,$3,'active',now(),now())
     ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "updated_at" = now()`,
    `sch_${code}`,
    code,
    displayName
  )
  // BS-02：开通即写入安全默认值（仅首次创建生效，不覆盖已有记录）。
  // 各字段 JSON 形态与前端 js/utils/schoolCustomization.js 解析逻辑一致：
  //   对象类（field_labels/field_rules/field_options/field_order/custom_fields/theme_config）→ '{}'
  //   数组类（hidden_fields/test_types）→ '[]'
  //   visible_types → 默认五大模块全开，避免开通即白屏
  const DEFAULT_VISIBLE_TYPES = JSON.stringify(['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'])
  await prisma.$executeRawUnsafe(
    `INSERT INTO public."SchoolCustomization"
       ("id","school_code","theme_config","field_labels","hidden_fields","field_rules",
        "field_options","field_order","custom_fields","test_types","visible_types","updated_at")
     VALUES ($1,$2,'{}','{}','[]','{}','{}','{}','{}','[]',$3,now())
     ON CONFLICT ("school_code") DO NOTHING`,
    `sc_${code}`,
    code,
    DEFAULT_VISIBLE_TYPES
  )
  log(`✅ 系统记录 public."School"/"SchoolCustomization" 就绪`)

  // ④ 租户内首个 manager（幂等：已存在则跳过）
  //    admin 角色仅保留给平台超管（public schema，schoolCode=null），
  //    学校内最高权限为 manager，避免跨校越权。
  let managerCreated = false
  const hash = await bcryptjs.hash(pw, 10)
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`)
    const found = await tx.$queryRawUnsafe(
      `SELECT 1 FROM "User" WHERE "username" = 'manager' LIMIT 1`
    )
    if (found.length) {
      log(`ℹ️ 租户 ${code} 已存在 manager，跳过创建`)
      return
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO "User"
         ("id","username","password_hash","full_name","role","status","school_code","created_at","updated_at")
       VALUES ($1,'manager',$2,'School Manager','manager','active',$3,now(),now())`,
      `u_${code}_manager`,
      hash,
      code
    )
    managerCreated = true
    log(`✅ 已为租户 ${code} 创建 manager 账号`)
  })

  return { code, schema, created, managerCreated }
}

export default { provisionSchool, isValidSchoolCode, schemaNameOf }
