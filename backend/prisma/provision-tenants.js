// provision-tenants.js — 首次部署多租户批量初始化（方案② Schema-per-tenant）
//
// 在 `prisma db push`（已把业务表推到 public）之后运行（由 deploy.sh 调用）。
// 具体单校初始化逻辑统一在 lib/tenantProvisioner.js（与运行时"动态建学校"共用）。
//
// 环境变量：
//   DATABASE_URL        必填（来自 .env，不含 ?schema=）
//   SCHOOL_CODES        逗号分隔的学校代码，如 "tianjiabing"。为空则跳过（仅用 public 共享 schema）
//   SCHOOL_NAME_<code>  可选，学校显示名；缺省用 "学校(<code>)"
//   SEED_ADMIN_PASSWORD 租户 manager 初始密码（取自 .env，与 public 种子 admin 一致）

import { PrismaClient } from '@prisma/client'
import { provisionSchool } from '../lib/tenantProvisioner.js'

const prisma = new PrismaClient()

const codes = (process.env.SCHOOL_CODES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const adminPassword =
  process.env.SEED_ADMIN_PASSWORD || process.env.SEED_OPERATOR_PASSWORD || ''

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[FATAL] 缺少 DATABASE_URL，无法初始化多租户。')
    process.exit(1)
  }
  if (!codes.length) {
    console.log('[SKIP] SCHOOL_CODES 为空，跳过多租户初始化（dev/test 仅用 public 共享 schema）。')
    return
  }
  // M1（窗口2）：弱默认密码回退已移除。缺少初始密码时直接失败退出，
  // 不再 console.warn 后继续建校（除非显式声明开发例外 ALLOW_INSECURE_TENANT_PASSWORD=true）。
  if (!adminPassword && process.env.ALLOW_INSECURE_TENANT_PASSWORD !== 'true') {
    console.error(
      '[FATAL] 未提供 SEED_ADMIN_PASSWORD（或 SEED_OPERATOR_PASSWORD），拒绝初始化租户。\n' +
      '        请在 .env 中设置强密码后重试；本地开发可显式设置 ALLOW_INSECURE_TENANT_PASSWORD=true。'
    )
    process.exit(1)
  }

  let failed = 0
  for (const code of codes) {
    console.log(`\n=== 初始化租户: ${code} ===`)
    try {
      await provisionSchool({
        prisma,
        code,
        name: process.env[`SCHOOL_NAME_${code}`],
        adminPassword,
        log: (m) => console.log(`  ${m}`)
      })
    } catch (e) {
      failed += 1
      console.error(`  ❌ 租户 ${code} 初始化失败: ${e.message}`)
    }
  }
  if (failed > 0) {
    console.error(`\n❌ ${failed} 个租户初始化失败，请检查上方日志。`)
    process.exit(1)
  }
}

main()
  .catch((e) => {
    console.error('❌ 多租户初始化失败:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
