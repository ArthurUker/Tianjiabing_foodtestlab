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
//
// 「学校 schema 内禁止 role=admin」制度兜底：
//   - 制度上：学校租户下只允许 manager / operator / viewer 三级账号，admin 只能存在于 public（平台超管）。
//   - 现状：历史上某次 provisionSchool/UserManager 未做白名单校验的版本可能写入了 role=admin
//     的脏数据（如 2026-07-23 写入的 school_demo.admin，截图复现的根因）。
//   - 兜底：每次 syncAllTenantSchemas / provisionSchool.reprovision 之前，自动把所有学校 schema
//     内 role=admin 的 User 行降级为 manager（保留 username、id、密码），避免「重新初始化」后
//     出现「平台管理员账号」在子租户下被新建/保留。

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { provisionSchool } from './tenantProvisioner.js'
import { schemaNameOf } from './tenantClient.js'
import { ensureFieldOptionSeeds } from './fieldOptionService.js'
// 「学校 schema 内禁止 role=admin」制度兜底（详见 schoolAdminPurge.js）。
// re-export 让其它模块仍可 from 'tenantSync.js' 引用，保持单一事实源；
// 同时让 syncAllTenantSchemas() 末尾统一调用它（避免与 provisionSchool 内嵌降级流程分叉）。
// 注意：`export { x } from './y.js'` 仅转导出、不在本模块作用域创建绑定，
// 因此需先用 import 引入（供下方 syncAllTenantSchemas 调用），再显式 export 保持转导出语义。
import { purgeInvalidAdminInSchools, findInvalidAdminInSchool, ADMIN_PURGE_CONSTANTS } from './schoolAdminPurge.js'
export { purgeInvalidAdminInSchools, findInvalidAdminInSchool, ADMIN_PURGE_CONSTANTS }

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
 * 对【活跃 / 正常】持有 SchoolCustomization 表的 schema（public + 各未删除租户）执行：
 *   ADD COLUMN IF NOT EXISTS 已知定制列 + 把历史 NULL 回填为安全默认值。
 * 列名为本模块常量（来自 schema.prisma，安全）；schema 名经 information_schema 取得，
 * 并以 public."School"（status ≠ 'deleted'）为单一事实源推导集合；
 * recycle_*（回收站）、school_*_old_*（影子恢复残留）、school_<code> 历史孤儿 schema
 * 明确跳过（不 throw），其余非白名单名称（含空格/引号/分号等可注入 DDL 字符）拒绝执行。
 */
export async function backfillSchoolCustomization(prisma, log = console.log) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = 'SchoolCustomization'`
  )
  if (!rows.length) {
    log('[SKIP] 未找到任何 SchoolCustomization 表，跳过回填')
    return
  }

  // 活跃 / 正常 schema 白名单：public + 全部【未删除】学校的 schema（status ≠ 'deleted'，含 active/disabled）。
  // 已删除学校的 schema 已被 RENAME 进 recycle_*/old_*，由下方其他规则覆盖。
  // 数据库里还可能出现历史孤儿 schema：学校已在 public."School" 物理删除，但 schema 未被 RENAME
  // （典型场景：旧版本删校流程缺 RENAME 步骤；运维/测试遗留下空表 schema）。
  // 此类 schema 内部所有业务表均为空，【跳过回填】（不 throw，避免再次阻断部署），
  // 但 console.warn 提示运维可手动 DROP SCHEMA ... CASCADE 清理。
  const schoolRows = await prisma.school.findMany({
    where: { status: { not: 'deleted' } },
    select: { code: true }
  })
  const activeSchemas = new Set(['public', ...schoolRows.map((r) => schemaNameOf(r.code)).filter(Boolean)])

  for (const { table_schema } of rows) {
    if (activeSchemas.has(table_schema)) {
      // 活跃 / 正常 schema：继续回填（下方原逻辑）
    } else if (/^recycle_[a-z0-9_]+$/.test(table_schema) || /^school_[a-z0-9_]+_old_[0-9]+$/.test(table_schema)) {
      // 回收站 / 影子恢复残留：系统自身产生的合法非活跃 schema，跳过回填
      log(`[SKIP] 跳过非活跃 schema 回填: ${table_schema}`)
      continue
    } else if (/^school_[a-z0-9_]+$/.test(table_schema)) {
      // 历史孤儿：跳过回填（不 throw），console.warn 提示运维清理
      console.warn(`[WARN] 跳过孤儿 schema 回填: ${table_schema}（在 public."School" 中找不到对应学校，建议手动 DROP SCHEMA "${table_schema}" CASCADE 清理）`)
      continue
    } else {
      // 其余任何非白名单名称（含空格/引号/分号等可注入 DDL 字符）仍视为注入风险，拒绝执行
      throw new Error(`非法 schema 名: "${table_schema}"（回填 SchoolCustomization 中止以避免注入）`)
    }
    for (const c of OBJ_COLS) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "${c}" JSONB`
      )
      await prisma.$executeRawUnsafe(
        `UPDATE "${table_schema}"."SchoolCustomization" SET "${c}" = '{}' WHERE "${c}" IS NULL`
      )
    }
    for (const c of ARR_COLS) {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "${c}" JSONB`
      )
      await prisma.$executeRawUnsafe(
        `UPDATE "${table_schema}"."SchoolCustomization" SET "${c}" = '[]' WHERE "${c}" IS NULL`
      )
    }
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "visible_types" JSONB`
    )
    // P1-4: 全库统一为 jsonb（schema.prisma Json 类型），$1 为 text 参数（Prisma 传参），
    // 赋 jsonb 列必须显式 $1::jsonb（否则 PG 42804）。这是 jsonb 列写入的正确写法，非兼容 hack。
    await prisma.$executeRawUnsafe(
      `UPDATE "${table_schema}"."SchoolCustomization" SET "visible_types" = $1::jsonb WHERE "visible_types" IS NULL`,
      DEFAULT_VISIBLE_TYPES
    )
    // 菜单栏定制（菜单项可见性）：默认全选（与可见检测类型一致的"友好默认"策略）
    // 注意：field_types 已由上方 OBJ_COLS 循环统一 ADD COLUMN，此处无需重复
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "visible_menu_items" JSONB`
    )
    await prisma.$executeRawUnsafe(
      `UPDATE "${table_schema}"."SchoolCustomization" SET "visible_menu_items" = $1::jsonb WHERE "visible_menu_items" IS NULL`,
      DEFAULT_VISIBLE_MENU_ITEMS
    )
    // 学校食堂信息（学校基本信息）：默认 一/二/三 食堂；保存时同步 field_options.canteen
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "canteens" JSONB`
    )
    await prisma.$executeRawUnsafe(
      `UPDATE "${table_schema}"."SchoolCustomization" SET "canteens" = $1::jsonb WHERE "canteens" IS NULL`,
      DEFAULT_CANTEENS
    )
    // 访客功能开关（RBAC 收敛）：boolean 列，默认关闭（false，需平台超管显式开启）
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${table_schema}"."SchoolCustomization" ADD COLUMN IF NOT EXISTS "guest_enabled" BOOLEAN NOT NULL DEFAULT false`
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
  const rows = await prisma.school.findMany({
    where: { status: 'active' },
    select: { code: true }
  })
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

  log('\n⑤ 学校 schema 内 role=admin 历史脏数据自愈（降级为 manager）...')
  await purgeInvalidAdminInSchools(prisma, log)

  log('\n✅ 所有租户 schema 已与 schema.prisma 对齐。')
}
