// tenantSync.js — 把全部租户 schema 与 prisma/schema.prisma 对齐（防 P2022 漂移）
//
// 被两处复用（单一事实源，避免与 deploy.sh 逻辑分叉）：
//   1. scripts/backend/sync-tenant-schemas.mjs —— 手动/部署期一键同步（npm run db:sync）
//   2. server.js 的启动自愈 —— 服务每次启动时后台把全部租户对齐
//
// 关键点（解决「控制台 UI 新建的租户不会被重新 db push」的漏洞）：
//   - 读取 public."School" 中【全部】学校代码（含运行时新建、不在 SCHOOL_CODES 的学校），
//     对每个调用 provisionSchool（内部幂等执行 `prisma db push`），把新列推到每个租户 schema。
//   - 额外对 SchoolCustomization 做跨【全部 schema】的 NULL 回填（RK40），
//     因为旧学校历史行的新列为 NULL 会导致前端期望非空 JSON 时崩溃。
//
// 仅对「增量变更（加列/加表）」安全；破坏性变更（改列名/类型/删列）需人工处理。

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { provisionSchool } from './tenantProvisioner.js'
import { schemaNameOf } from './tenantClient.js'
import { ensureFieldOptionSeeds } from './fieldOptionService.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_DIR = path.resolve(__dirname, '..')

// SchoolCustomization 各定制列的默认回填值（与 provisionSchool 默认值保持一致）
const OBJ_COLS = ['field_labels', 'field_rules', 'field_options', 'field_order', 'custom_fields', 'theme_config', 'field_types']
const ARR_COLS = ['hidden_fields', 'test_types']
const DEFAULT_VISIBLE_TYPES = JSON.stringify(['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'])
const DEFAULT_CANTEENS = JSON.stringify(['一食堂', '二食堂', '三食堂'])
// 默认全部菜单项可见（与 admin-schools.html UI 的"全勾选"状态一致，
// 避免新学校被误判为"全隐藏"导致侧边栏空白）
const DEFAULT_VISIBLE_MENU_ITEMS = JSON.stringify([
  'dashboard', 'tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen',
  'adminSchools', 'exportData', 'backupRestore', 'userManagement', 'auditLog', 'logout',
])

function runPrismaGenerate() {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['prisma', 'generate'], {
      cwd: BACKEND_DIR,
      env: process.env,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`prisma generate 失败，退出码 ${code}`))
    )
  })
}

/**
 * 对【全部】持有 SchoolCustomization 表的 schema（public + 各租户）执行：
 *   ADD COLUMN IF NOT EXISTS 已知定制列 + 把历史 NULL 回填为安全默认值。
 * 列名为本模块常量（来自 schema.prisma，安全）；schema 名经 information_schema 取得，
 * 非 public 时再经 assertSafeSchemaName 二次防御（防止拼接进 DDL 的注入）。
 */
export async function backfillSchoolCustomization(prisma, log = console.log) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = 'SchoolCustomization'`
  )
  if (!rows.length) {
    log('[SKIP] 未找到任何 SchoolCustomization 表，跳过回填')
    return
  }
  for (const { table_schema } of rows) {
    // 防御：schema 名来自 information_schema 目录（均由 provisionSchool 在创建时校验过，
    // 非终端用户输入），此处再放行「public / school_<...> / school-<...>」三类合法形态，
    // 拒绝任何含空格、引号、分号等可注入 DDL 的名称。注意需兼容连字符形态（如 school-gtest）。
    if (table_schema !== 'public' && !/^(school_[a-z0-9_]+|school-[a-z0-9-]+)$/.test(table_schema)) {
      throw new Error(`非法 schema 名: "${table_schema}"（回填 SchoolCustomization 中止以避免注入）`)
    }
    for (const c of OBJ_COLS) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "${c}" TEXT`
      )
      await prisma.$executeRawUnsafe(
        `UPDATE "${table_schema}"."SchoolCustomization" SET "${c}" = '{}' WHERE "${c}" IS NULL`
      )
    }
    for (const c of ARR_COLS) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "${c}" TEXT`
      )
      await prisma.$executeRawUnsafe(
        `UPDATE "${table_schema}"."SchoolCustomization" SET "${c}" = '[]' WHERE "${c}" IS NULL`
      )
    }
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "visible_types" TEXT`
    )
    await prisma.$executeRawUnsafe(
      `UPDATE "${table_schema}"."SchoolCustomization" SET "visible_types" = $1 WHERE "visible_types" IS NULL`,
      DEFAULT_VISIBLE_TYPES
    )
    // 菜单栏定制（菜单项可见性）：默认全选（与可见检测类型一致的"友好默认"策略）
    // 注意：field_types 已由上方 OBJ_COLS 循环统一 ADD COLUMN，此处无需重复
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "visible_menu_items" TEXT`
    )
    await prisma.$executeRawUnsafe(
      `UPDATE "${table_schema}"."SchoolCustomization" SET "visible_menu_items" = $1 WHERE "visible_menu_items" IS NULL`,
      DEFAULT_VISIBLE_MENU_ITEMS
    )
    // 学校食堂信息（学校基本信息）：默认 一/二/三 食堂；保存时同步 field_options.canteen
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "canteens" TEXT`
    )
    await prisma.$executeRawUnsafe(
      `UPDATE "${table_schema}"."SchoolCustomization" SET "canteens" = $1 WHERE "canteens" IS NULL`,
      DEFAULT_CANTEENS
    )
    log(`✅ SchoolCustomization 回填完成: ${table_schema}`)
  }
}

/**
 * 把全部租户 schema 与当前 schema.prisma 对齐。
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} [opts]
 * @param {string} [opts.adminPassword] 新建租户用（已存在租户不会重建账号，仅推表）
 * @param {boolean} [opts.skipGenerate] 跳过 prisma generate（运行时自愈/部署已生成过则置 true）
 * @param {(m:string)=>void} [opts.log]
 */
export async function syncAllTenantSchemas(prisma, { adminPassword = '', skipGenerate = false, log = console.log } = {}) {
  if (!skipGenerate) {
    log('① 重新生成 Prisma 客户端...')
    await runPrismaGenerate()
  }

  // P1/P2: 仅同步启用中的学校,已停用(逻辑删除)学校不再纳入批量同步
  const rows = await prisma.$queryRawUnsafe(`SELECT "code" FROM public."School" WHERE "status" = 'active'`)
  const codes = rows.map((r) => r.code).filter(Boolean)
  if (codes.length) {
    log(`\n② 同步 ${codes.length} 个租户 schema 与 schema.prisma 对齐（含控制台 UI 新建的租户）...`)
    for (const code of codes) {
      try {
        await provisionSchool({ prisma, code, adminPassword, log: () => {}, allowExisting: true })
        log(`  ✅ ${code}`)
      } catch (e) {
        // 单个租户失败不阻断其余租户与回填，记录后继续
        log(`  ❌ ${code} 同步失败 - ${e.message}`)
      }
    }
  } else {
    log('[SKIP] public."School" 中无学校，跳过租户 schema 同步')
  }

  log('\n③ SchoolCustomization 增量列回填（跨全部 schema）...')
  await backfillSchoolCustomization(prisma, log)

  log('\n④ FieldOption 字段选项种子回填（跨全部租户，幂等）...')
  for (const code of codes) {
    try {
      await ensureFieldOptionSeeds(prisma, code, (m) => log(`  [${code}] ${m}`))
    } catch (e) {
      log(`  ❌ ${code} 字段选项种子失败 - ${e.message}`)
    }
  }

  log('\n✅ 所有租户 schema 已与 schema.prisma 对齐。')
}
