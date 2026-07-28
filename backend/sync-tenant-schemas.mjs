// sync-tenant-schemas.mjs — 把所有已存在租户的数据库 schema 与 prisma/schema.prisma 对齐
//
// 用途（防 P2022 schema 漂移复发）：
//   修改 schema.prisma 后，Prisma 客户端被重新生成（开始期望新列），但各租户 schema
//   仍是旧结构，导致 P2022: column does not exist。本脚本一次性完成：
//     ① 重新生成 Prisma 客户端（prisma generate）
//     ② 读取 public."School" 中【全部】学校代码（含运行时新建、不在 SCHOOL_CODES 的学校），
//        对每个调用 provisionSchool（内部幂等执行 `prisma db push`），把新列推到每个租户 schema。
//     ③ SchoolCustomization 增量列跨全部 schema 的 NULL 回填（RK40）。
//
// 用法：
//   node backend/sync-tenant-schemas.mjs
// 或（package.json 已加）：
//   npm run db:sync
// 在部署脚本中调用时可跳过 generate（部署期已生成）：SKIP_PRISMA_GENERATE=1 node backend/sync-tenant-schemas.mjs
//
// 注意：仅对「增量变更（加列/加表）」安全；破坏性变更（改列名/类型/删列）需人工处理。

import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { syncAllTenantSchemas } from './lib/tenantSync.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

const adminPassword = process.env.SEED_ADMIN_PASSWORD || process.env.SEED_OPERATOR_PASSWORD || ''
const prisma = new PrismaClient()

syncAllTenantSchemas(prisma, {
  adminPassword,
  skipGenerate: process.env.SKIP_PRISMA_GENERATE === '1',
  log: (m) => console.log(m)
})
  .catch((e) => {
    console.error('❌ 同步失败:', e.message)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
