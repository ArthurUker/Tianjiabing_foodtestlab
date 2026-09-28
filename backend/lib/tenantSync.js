// tenantSync.js — 逐租户迁移/结构检查与显式升级（P3-W2-T02-R2；防 P2022 漂移）
//
// 被两处复用（单一事实源，避免与 deploy.sh 逻辑分叉）：
//   1. backend/sync-tenant-schemas.mjs —— 手动/部署期一键升级（npm run db:sync / --check）
//   2. server.js 的启动入口 —— **只调用 check 模式**（只读检测；startup 永不写结构）
//
// P3-W2-T02-R2（RC-04）—— 两种模式（syncAllTenantSchemas 的 `mode`）：
//   - `'check'`（**启动默认、也是启动唯一允许的模式**）：**只读**证明与检查
//     ① public 迁移证明：`_prisma_migrations` 逐条 name/checksum/finished/rolled_back/logs vs 链文件
//        （failed / pending / checksum 不一致 / 未知条目 / rolled-back 未重放 / 台账缺失 → 阻断租户流量）；
//     ② 每校逐租户台账证明：`"<schema>"."_tenant_migrations"`（name/checksum/status/detail）vs 链文件；
//     ③ 结构：表 / 列 / 主键 / 外键 / 唯一索引 vs public（链末、checksum 受校验）；缺失与**额外对象**都登记；
//     ④ public 额外表分类：白名单（`_prisma_migrations`/`revoked_tokens`/`recycle_bin`）外 → 阻断 readiness。
//     状态含 `MIGRATION_FAILED|MIGRATIONS_PENDING|MIGRATION_CHECKSUM_MISMATCH|MIGRATION_LEDGER_UNKNOWN_ENTRY|
//     MIGRATION_LEDGER_MISSING|TENANT_MIGRATION_FAILED|TENANT_MIGRATIONS_PENDING|TENANT_MIGRATION_LEDGER_MISSING|
//     TENANT_MIGRATION_CHECKSUM_MISMATCH|TENANT_STRUCTURE_DRIFT|TENANT_EXTRA_OBJECTS|PUBLIC_EXTRA_OBJECTS|…`
//     + `globalBlockers`（是否阻断流量）+ `blockedSchools`；**不执行任何 DDL/DML**。
//   - `'apply'`（**仅显式命令**：npm run db:sync / 实例 fixture；启动侧任何 AUTO_SYNC_TENANTS 值都不进入）：
//     逐租户**按版本化链回放**（tenantProvisioner.applyTenantMigrations）→ 每迁移落台账
//     （name/checksum/status/projection/skipped_sweeps）；失败记 failed + 脱敏原因并上抛，绝不打印成功汇总。
//     运行期无 `prisma db push`、无 `migrate diff` 末态 SQL、不用 public 迁移状态冒充逐租户执行。
//
// 关键点（控制台 UI 新建的租户同样覆盖）：
//   - 读取 public."School" 中【全部非删除学校】（含运行时新建、以及 disabled 停用校 —— RC-04：
//     停用校在升级清单内，重新启用前必须通过版本检查），逐校推进/检查。
//   - 额外对 SchoolCustomization 做跨【全部 schema】的 NULL 回填（RK40），
//     因为旧学校历史行的新列为 NULL 会导致前端期望非空 JSON 时崩溃。
//
// 额外对象（台账/历史遗留/测试合成）：一律**不自动 DROP**，阻断受影响能力，交人工/migration 处置。
//
// 「学校 schema 内禁止 role=admin」制度兜底：
//   - 制度上：学校租户下只允许 manager / operator / viewer 三级账号，admin 只能存在于 public（平台超管）。
//   - 现状：历史上某次 provisionSchool/UserManager 未做白名单校验的版本可能写入了 role=admin
//     的脏数据（如 2026-07-23 写入的 school_demo.admin，截图复现的根因）。
//   - 兜底：每次 syncAllTenantSchemas / provisionSchool.reprovision 之前，自动把所有学校 schema
//     内 role=admin 的 User 行降级为 manager（保留 username、id、密码），避免「重新初始化」后
//     出现「平台管理员账号」在子租户下被新建/保留。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  provisionSchool, readExpectedTenantTables, compareTenantStructureToPublic,
  listMigrationFiles, migrationChainDigest, chainManifest, redactSecrets,
  readTenantMigrationLedger, TENANT_LEDGER, TENANT_LEDGER_WHITELIST,
  MIGRATION_LOCK_TABLE, classifyTenantMigration, buildTenantProjection, fileChecksum,
} from './tenantProvisioner.js'
import { schemaNameOf } from './tenantClient.js'
// P3-PUBLIC-INFRA-CHAIN-R1（R9 §1 / R6 C3）：public 基础设施（锁表 + 吊销表/三索引）**只读形状检查**入闸门。
import { publicInfraShapeReport, PUBLIC_INFRA_SHAPE_MISMATCH } from './publicInfraShape.js'
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

// ===================== P3-W2-T02-R2（RC-04）：迁移/结构检查（只读）+ 明确状态 + 阻断分类 =====================
// 事实源（每个 public 与 tenant 都能证明"名称 / checksum / 状态 / 失败原因"）：
//   · public：Prisma `_prisma_migrations`（migration_name + checksum + finished_at/rolled_back_at + logs）
//     逐条与本包链文件比对（checksum 不一致 / 未知条目 / pending / failed / rolled-back 未重放 → 阻断）；
//   · tenant：`"<schema>"."_tenant_migrations"`（本包逐租户台账：name + checksum + status + detail）；
//   · 结构：表 / 列 / 主键 / 外键 / 唯一索引 vs public（链末、checksum 受校验）；
//     缺失与**额外对象**都登记，额外对象**不自动 DROP**（阻断受影响能力，交人工/migration 处置）。
// 本区域全部函数**只读**（只发 SELECT；测试用代理客户端证明零写 API 调用）。
export { readExpectedTenantTables, chainManifest, migrationChainDigest, TENANT_LEDGER, TENANT_LEDGER_WHITELIST } from './tenantProvisioner.js'

const LEDGER_KNOWN_STATUS = new Set(['applied', 'applied_projected', 'baselined', 'skipped_public_only'])
/** P3-PUBLIC-INFRA-CHAIN-R1（R9 §1）：台账**已知非终态**（正式协议；阻断，但以确定码上报）。
 *  `baseline_pending` = 受控 baseline 已提交但复证/提升未完成（R6 §3）——不属"未知状态"，
 *  也不依赖 unknownStatuses 的通用兜底文案。 */
export const LEDGER_NON_TERMINAL_STATUS = new Set(['baseline_pending'])
const LEDGER_NON_TERMINAL_BASELINE_PENDING = 'baseline_pending'
/** public 迁移层中**阻断租户流量**的状态（RC-04：部署 migration 成功后才开放 readiness）。 */
export const PUBLIC_TRAFFIC_BLOCKING_STATUS = new Set([
  'MIGRATION_FAILED',
  'MIGRATIONS_PENDING',
  'MIGRATION_CHECKSUM_MISMATCH',
  'MIGRATION_LEDGER_UNKNOWN_ENTRY',
  'MIGRATION_LEDGER_MISSING',
  'CANNOT_CHECK',
  // R6 ②：不再只挡 readyz —— 分类不可判定与 public 未知额外对象同样阻断真实租户 API
  'PUBLIC_EXTRA_OBJECTS',
  'TENANT_MIGRATION_UNCLASSIFIED',
  'TENANT_MIGRATION_REGISTRY_CHECKSUM_MISMATCH',
  'NOT_VERIFIED',
  // P3-PUBLIC-INFRA-CHAIN-R1（R9 §1 / R6 C3）：public 基础设施（锁表/吊销表+三索引）形状不符
  'PUBLIC_INFRA_SHAPE_MISMATCH',
])
/** public 已知基础设施表（非 model 表；不在名单内即"未知额外对象"→ 阻断 readiness，不自动 DROP）。 */
export const PUBLIC_INFRA_TABLES = ['_prisma_migrations', 'revoked_tokens', 'recycle_bin', MIGRATION_LOCK_TABLE]

/** 只读读取迁移文件（分类用；失败不吞错）。 */
function readFileSyncSafe(name) {
  const f = listMigrationFiles().find((m) => m.name === name)
  if (!f) throw new Error(`迁移文件不存在: ${name}`)
  return fs.readFileSync(f.file, 'utf8')
}

/** public 迁移证明（只读；逐条 checksum 校验）。 */
export async function readMigrationState(prisma) {
  const files = chainManifest()
  const byName = new Map(files.map((f) => [f.name, f.checksum]))
  let rows = []
  let tableMissing = false
  let readError = null
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count, logs
         FROM public._prisma_migrations ORDER BY migration_name`)
  } catch (e) { tableMissing = true; readError = redactSecrets(e.message) }

  const applied = rows.filter((r) => r.finished_at && !r.rolled_back_at)
  const failed = rows.filter((r) => !r.finished_at && !r.rolled_back_at)
  const rolledBack = rows.filter((r) => r.rolled_back_at)
  const appliedNames = new Set(applied.map((r) => r.migration_name))
  const pending = files.map((f) => f.name).filter((n) => !appliedNames.has(n))
  const rolledBackUnapplied = rolledBack.filter((r) => !appliedNames.has(r.migration_name)).map((r) => r.migration_name)
  const checksumMismatches = applied
    .filter((r) => byName.has(r.migration_name) && String(r.checksum) !== byName.get(r.migration_name))
    .map((r) => ({ name: r.migration_name, ledger: String(r.checksum).slice(0, 12), file: String(byName.get(r.migration_name)).slice(0, 12) }))
  const unknownEntries = rows.filter((r) => !byName.has(r.migration_name))
    .map((r) => ({ name: r.migration_name, finished: !!r.finished_at, rolledBack: !!r.rolled_back_at }))

  const status = tableMissing ? 'MIGRATION_LEDGER_MISSING'
    : failed.length ? 'MIGRATION_FAILED'
      : checksumMismatches.length ? 'MIGRATION_CHECKSUM_MISMATCH'
        : unknownEntries.length ? 'MIGRATION_LEDGER_UNKNOWN_ENTRY'
          : (pending.length || rolledBackUnapplied.length) ? 'MIGRATIONS_PENDING'
            : 'OK'
  return {
    ok: status === 'OK', status, tableMissing, readError,
    applied: applied.map((r) => ({ name: r.migration_name, checksum: String(r.checksum).slice(0, 12), finishedAt: r.finished_at, appliedSteps: r.applied_steps_count })),
    pending, rolledBackUnapplied,
    rolledBack: rolledBack.map((r) => ({ name: r.migration_name, at: r.rolled_back_at })),
    failed: failed.map((r) => ({ name: r.migration_name, startedAt: r.started_at, reason: redactSecrets(String(r.logs || '')).slice(0, 300) })),
    checksumMismatches, unknownEntries,
    trafficBlocking: PUBLIC_TRAFFIC_BLOCKING_STATUS.has(status),
    chain: { count: files.length, digest: migrationChainDigest() },
  }
}

/** public 额外对象分类（白名单内为已知基础设施；名单外 → 未知额外对象，阻断 readiness，不自动 DROP）。 */
export async function checkPublicExtraObjects(prisma) {
  const expected = readExpectedTenantTables()
  const rows = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`)
  const known = new Set([...(expected.ok ? expected.tables : []), ...PUBLIC_INFRA_TABLES])
  const extraTables = rows.map((r) => r.table_name).filter((n) => !known.has(n))
  return { extraTables, whitelist: PUBLIC_INFRA_TABLES, blocking: extraTables.length > 0 }
}

/** 单校租户台账证明（只读）：name/checksum/status/detail + 版本（最后一个终态迁移 vs 链尾）。 */
export async function readTenantMigrationProof(prisma, schema) {
  const files = chainManifest()
  const fileMap = new Map(files.map((f) => [f.name, f.checksum]))
  const head = files[files.length - 1]?.name || null
  const ledger = await readTenantMigrationLedger(prisma, schema)
  if (!ledger.exists) {
    return {
      exists: false, status: 'TENANT_MIGRATION_LEDGER_MISSING', version: { at: null, head, appliedCount: 0, chainCount: files.length },
      baselined: 0, applied: [], pending: files.map((f) => f.name), failed: [], checksumMismatches: [], unknownEntries: [], unknownStatuses: [],
    }
  }
  const terminal = ledger.rows.filter((r) => LEDGER_KNOWN_STATUS.has(r.status))
  const terminalNames = new Set(terminal.map((r) => r.migration_name))
  const failedRows = ledger.rows.filter((r) => r.status === 'failed')
  // P3-PUBLIC-INFRA-CHAIN-R1（R9 §1）：`baseline_pending` 是**正式已知非终态**（不是"未知状态"）：
  //   它天然阻断（不属 terminal），且 `--check`/启动必须给出确定口径（TENANT_BASELINE_PENDING），
  //   不依赖"未知状态"的通用兜底文案。
  const baselinePendingRows = ledger.rows.filter((r) => r.status === LEDGER_NON_TERMINAL_BASELINE_PENDING)
  const unknownStatuses = ledger.rows.filter((r) => !LEDGER_KNOWN_STATUS.has(r.status) && r.status !== 'failed' && r.status !== LEDGER_NON_TERMINAL_BASELINE_PENDING)
  const pending = files.map((f) => f.name).filter((n) => !terminalNames.has(n))
  const checksumMismatches = ledger.rows
    .filter((r) => fileMap.has(r.migration_name) && String(r.checksum) !== fileMap.get(r.migration_name))
    .map((r) => ({ name: r.migration_name, ledger: String(r.checksum).slice(0, 12), file: String(fileMap.get(r.migration_name)).slice(0, 12) }))
  const unknownEntries = ledger.rows.filter((r) => !fileMap.has(r.migration_name)).map((r) => ({ name: r.migration_name, status: r.status }))
  const appliedNames = terminal.map((r) => r.migration_name).sort()
  const status = failedRows.length ? 'TENANT_MIGRATION_FAILED'
    : checksumMismatches.length ? 'TENANT_MIGRATION_CHECKSUM_MISMATCH'
      : unknownEntries.length ? 'TENANT_MIGRATION_LEDGER_UNKNOWN_ENTRY'
        : (pending.length || unknownStatuses.length) ? 'TENANT_MIGRATIONS_PENDING'
          : 'OK'
  return {
    exists: true, status,
    version: { at: appliedNames[appliedNames.length - 1] || null, head, appliedCount: appliedNames.length, chainCount: files.length },
    baselined: terminal.filter((r) => r.status === 'baselined').length,
    applied: appliedNames,
    pending, failed: failedRows.map((r) => ({ name: r.migration_name, detail: redactSecrets(String(r.detail || '')).slice(0, 300), startedAt: r.started_at })),
    checksumMismatches, unknownEntries,
    unknownStatuses: unknownStatuses.map((r) => ({ name: r.migration_name, status: r.status })),
    // 已知非终态（`baseline_pending`；R9 §1 正式协议）：仍阻断，且以确定码上报（不混入 unknownStatuses）
    nonTerminal: baselinePendingRows.map((r) => ({ name: r.migration_name, status: r.status, detail: redactSecrets(String(r.detail || '')).slice(0, 200), startedAt: r.started_at })),
    baselinePending: baselinePendingRows.length,
    projection: terminal.map((r) => ({ name: r.migration_name, status: r.status, skippedSweeps: Number(r.skipped_sweeps || 0) })),
  }
}

/** 单校状态严重度（用于选择"主状态"）。 */
const SCHOOL_STATUS_PRECEDENCE = [
  'TENANT_SCHEMA_MISSING', 'TENANT_MIGRATION_FAILED', 'TENANT_MIGRATION_CHECKSUM_MISMATCH',
  'TENANT_MIGRATION_LEDGER_UNKNOWN_ENTRY', 'TENANT_MIGRATION_LEDGER_MISSING', 'TENANT_MIGRATIONS_PENDING',
  // P3-PUBLIC-INFRA-CHAIN-R1：`TENANT_BASELINE_PENDING` 作为**附加 blocker**上报（见 checkTenantSchemas），
  // 而**主状态保持 `TENANT_MIGRATIONS_PENDING`** —— 既把"已知非终态"正式纳入协议，又不改变既有
  // 主状态语义（R6/R5 定点期望不劣化）。
  'TENANT_STRUCTURE_DRIFT', 'TENANT_EXTRA_OBJECTS', 'CHECK_ERROR', 'OK',
]
const schoolStatusRank = (s) => {
  const i = SCHOOL_STATUS_PRECEDENCE.indexOf(s)
  return i === -1 ? SCHOOL_STATUS_PRECEDENCE.length : i
}

/**
 * **只读**全量检查：public 迁移证明 + public 额外对象分类 + 各非删除学校（active+disabled）
 * 台账证明 + 结构/额外对象比对。
 * @returns {Promise<object>} 含 ok/status/globalBlockers/blockedSchools/schoolStatuses
 */
export async function checkTenantSchemas(prisma, { log = console.log } = {}) {
  const expected = readExpectedTenantTables()
  const asOf = new Date().toISOString()
  const base = {
    mode: 'check', readOnly: true, ok: false, status: 'CANNOT_CHECK',
    checked: 0, drifted: [], missingSchemas: [], errored: [], blockedSchools: [],
    globalBlockers: [], schoolStatuses: {}, publicExtraObjects: null, publicInfraShapes: null,
    pendingMigrations: [], failedMigrations: [], expectedTables: null,
    migrationStatus: null, chainDigest: null,
    uncovered: ['非唯一普通索引（性能项）', 'CHECK 约束', '默认值表达式', '序列归属', '触发器/函数', '分区/继承'],
    details: [], asOf,
  }
  if (!expected.ok) {
    log(`⚠️  [租户结构检查] 无法检查（${expected.reason}）→ TENANT_SCHEMA_CHECK=CANNOT_CHECK（未做任何写操作）`)
    return { ...base, reason: expected.reason }
  }
  base.expectedTables = expected.count
  base.chainDigest = migrationChainDigest()

  // ① public 迁移证明（checksum 逐条）
  let publicMigration
  try {
    publicMigration = await readMigrationState(prisma)
  } catch (e) {
    publicMigration = { ok: false, status: 'CANNOT_CHECK', readError: redactSecrets(e.message), trafficBlocking: true, pending: [], failed: [], checksumMismatches: [], unknownEntries: [], rolledBackUnapplied: [], applied: [], chain: { count: expected.count, digest: base.chainDigest } }
  }
  base.migrationStatus = {
    status: publicMigration.status, ok: publicMigration.ok,
    applied: publicMigration.applied.length, pending: publicMigration.pending,
    failed: publicMigration.failed, rolledBackUnapplied: publicMigration.rolledBackUnapplied,
    checksumMismatches: publicMigration.checksumMismatches, unknownEntries: publicMigration.unknownEntries,
    readError: publicMigration.readError || null,
  }
  base.pendingMigrations = publicMigration.pending || []
  base.failedMigrations = (publicMigration.failed || []).map((f) => f.name)

  const globalBlockers = []
  if (!publicMigration.ok) {
    globalBlockers.push({
      code: publicMigration.status,
      trafficBlocking: publicMigration.trafficBlocking !== false,
      detail: publicMigration.status === 'MIGRATION_FAILED'
        ? `failed=[${(publicMigration.failed || []).map((f) => `${f.name}:${f.reason}`).join(' | ')}]`
        : publicMigration.status === 'MIGRATIONS_PENDING'
          ? `pending=[${(publicMigration.pending || []).slice(0, 6).join(',')}${publicMigration.rolledBackUnapplied?.length ? ` | rolled_back_unapplied=[${publicMigration.rolledBackUnapplied.join(',')}]` : ''}]`
          : publicMigration.status === 'MIGRATION_CHECKSUM_MISMATCH'
            ? `checksum 不一致: ${(publicMigration.checksumMismatches || []).map((c) => `${c.name}(${c.ledger}≠${c.file})`).join(', ')}`
            : publicMigration.status === 'MIGRATION_LEDGER_UNKNOWN_ENTRY'
              ? `未知迁移条目: ${(publicMigration.unknownEntries || []).map((u) => u.name).join(', ')}`
              : `public._prisma_migrations ${publicMigration.readError || '不可读'}`,
    })
    log(`⚠️  [迁移证明] public: TENANT_SCHEMA_CHECK=${publicMigration.status}（阻断租户流量=${publicMigration.trafficBlocking !== false}）`)
  } else {
    log(`   [迁移证明] public: OK（applied=${publicMigration.applied.length} checksum 逐条一致）`)
  }

  // ①b 链分类一致性（R5 ⑥ + 分类协议）：未分类/作用域缺失/注册表 checksum 不一致 → readiness 不就绪
  base.chainClassification = []
  try {
    for (const f of chainManifest()) {
      const raw = readFileSyncSafe(f.name)
      const projection = buildTenantProjection({ name: f.name, sql: raw, checksum: f.checksum })
      base.chainClassification.push({
        name: f.name, checksum: f.checksum, scope: projection.scope,
        executed: projection.kept, skipped: projection.skipped,
      })
    }
  } catch (e) {
    base.chainClassificationError = redactSecrets(e.message)
    globalBlockers.push({
      code: e.code === 'TENANT_SCOPE_UNCLASSIFIED' ? 'TENANT_MIGRATION_UNCLASSIFIED'
        : e.code === 'TENANT_MIGRATION_REGISTRY_CHECKSUM_MISMATCH' ? 'TENANT_MIGRATION_REGISTRY_CHECKSUM_MISMATCH' : 'CANNOT_CHECK',
      // R6 ②：分类不可判定 = 无法证明租户结构演进安全 → **同时**阻断 readyz 与真实租户 API
      trafficBlocking: true,
      detail: `迁移分类协议不满足：${redactSecrets(e.message)}`,
    })
    log(`⚠️  [迁移分类] ${e.code || 'CANNOT_CHECK'}：${redactSecrets(e.message)}（阻断租户流量：readyz 503 + 真实租户 API 503）`)
  }

  // ①d public 基础设施**只读形状检查**（P3-PUBLIC-INFRA-CHAIN-R1：R6 C3 入闸门）
  //   锁表 `_tenant_migration_locks` + 吊销表 `revoked_tokens`（表/列/主键 + 3 非唯一索引）。
  //   缺表/错列/缺索引 → traffic-blocking（readyz 503 + 真实租户 API 503）；**只发 SELECT**。
  //   运行时不再自建结构（migration 为唯一事实源）——因此这里必须显式失败，不得静默。
  try {
    base.publicInfraShapes = await publicInfraShapeReport(prisma)
    if (!base.publicInfraShapes.ok) {
      globalBlockers.push({
        code: PUBLIC_INFRA_SHAPE_MISMATCH, trafficBlocking: true,
        detail: `public 基础设施形状不符 ${base.publicInfraShapes.issues.length} 项：${base.publicInfraShapes.issues.slice(0, 8).join('；')}（结构由链尾 migration 管理；运行时不再自建）`,
      })
      log(`⚠️  [公共基础设施] public 形状不符 ${base.publicInfraShapes.issues.length} 项 → 阻断租户流量：${base.publicInfraShapes.issues.slice(0, 6).join('；')}`)
    } else {
      log('   [公共基础设施] public: 锁表 + 吊销表（含三索引）形状 OK（只读核验）')
    }
  } catch (e) {
    // 检查**自身失败**不是"形状 OK" —— CANNOT_CHECK + traffic-blocking（与 ② 同口径）
    base.publicInfraShapes = { ok: false, code: 'CANNOT_CHECK', issues: [redactSecrets(e.message)] }
    globalBlockers.push({
      code: 'CANNOT_CHECK', trafficBlocking: true,
      detail: `public 基础设施形状检查失败（pg_catalog 不可读/查询异常）：${redactSecrets(e.message)}`,
    })
    log(`⚠️  [公共基础设施] 形状检查失败 → CANNOT_CHECK（阻断租户流量）：${redactSecrets(e.message)}`)
  }

  // ② public 额外对象分类（白名单外 → 阻断 readiness，不自动 DROP）
  try {
    base.publicExtraObjects = await checkPublicExtraObjects(prisma)
  } catch (e) {
    // R5 ③：检查**自身失败**不是"没有额外对象" —— 必须 CANNOT_CHECK + global blocker（阻断流量）
    base.publicExtraObjects = { extraTables: [], error: redactSecrets(e.message), blocking: true, cannotCheck: true }
    globalBlockers.push({
      code: 'CANNOT_CHECK', trafficBlocking: true,
      detail: `public 额外对象检查失败（目录不可读/查询异常）：${redactSecrets(e.message)}`,
    })
    log(`⚠️  [额外对象] public 检查失败 → CANNOT_CHECK（阻断租户流量；不代表"无额外对象"）：${redactSecrets(e.message)}`)
  }
  if (base.publicExtraObjects?.blocking) {
    const extra = base.publicExtraObjects.extraTables || []
    // R6 ②：public 出现**未经分类的额外对象**（白名单外）不只是 readiness 问题——
    // 未知对象意味着"迁移链之外有人动过库"，租户结构演进不再可证明 → traffic-blocking（真实租户 API 503）。
    if (!base.publicExtraObjects.cannotCheck) {
      globalBlockers.push({
        code: 'PUBLIC_EXTRA_OBJECTS', trafficBlocking: true,
        detail: `public 未知额外表 ${extra.length} 个：${extra.slice(0, 8).join(', ')}（不自动 DROP；需纳入链/白名单或人工处置）`,
      })
    }
    log(`⚠️  [额外对象] public: 未知额外表 ${extra.length} 个（白名单：${PUBLIC_INFRA_TABLES.join(',')}）：${extra.slice(0, 8).join(', ')} —— 阻断租户流量（readyz 503 + 真实租户 API 503），不自动 DROP`)
  }

  // ③ 逐校：台账证明 + 结构/额外对象
  const rows = await prisma.school.findMany({ where: { status: { not: 'deleted' } }, select: { code: true, status: true } })
  const schools = rows.filter((r) => r.code).map((r) => ({ code: r.code, status: r.status || 'active' }))
  const expectedList = [...expected.tables]
  const publicCols = await prisma.$queryRawUnsafe(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, expectedList)
  const publicColMap = new Map()
  for (const c of publicCols) publicColMap.set(`${c.table_name}.${c.column_name}`, `${c.data_type}|${c.udt_name}|${c.is_nullable}`)

  const details = base.details
  const drifted = base.drifted
  const missingSchemas = base.missingSchemas
  const errored = base.errored
  const blockedSchools = base.blockedSchools

  for (const { code, status: schoolStatus } of schools) {
    const tag = schoolStatus === 'active' ? code : `${code}(disabled)`
    const schema = schemaNameOf(code)
    const entry = { code, schema, schoolStatus, status: 'OK', blockers: [] }
    try {
      if (!schema) throw new Error(`非法学校代码: ${code}（无法推导 schema）`)
      const ns = await prisma.$queryRawUnsafe('SELECT 1 FROM pg_namespace WHERE nspname = $1::text', schema)
      if (!ns.length) {
        entry.status = 'TENANT_SCHEMA_MISSING'
        entry.blockers.push('TENANT_SCHEMA_MISSING')
        missingSchemas.push({ code, schema, schoolStatus })
        details.push(`❌ ${tag}: schema ${schema} 不存在（未初始化）`)
      } else {
        // 台账证明
        const proof = await readTenantMigrationProof(prisma, schema)
        entry.migration = proof
        entry.version = proof.version
        if (proof.status !== 'OK') entry.blockers.push(proof.status)
        // P3-PUBLIC-INFRA-CHAIN-R1（R9 §1）：`baseline_pending` = **正式已知非终态** → 以确定码阻断
        if (proof.baselinePending > 0) {
          entry.blockers.push('TENANT_BASELINE_PENDING')
          details.push(`⛔ ${tag}: 台账含**已知非终态** TENANT_BASELINE_PENDING（status=baseline_pending，${proof.baselinePending} 条；受控 baseline 复证未通过/提升未完成）→ 该校阻断（主状态仍按 pending 上报）；处置：人工复核结构后重新 --baseline-apply（勿手工改状态）`)
        }
        if (proof.status === 'TENANT_MIGRATION_FAILED') {
          details.push(`⛔ ${tag}: 台账失败迁移 ${proof.failed.map((f) => f.name).join(',')}（reason=${proof.failed.map((f) => f.detail).join(' | ')}）`)
        } else if (proof.status !== 'OK') {
          details.push(`⛔ ${tag}: 迁移台账 ${proof.status}（version=${proof.version.at || '(none)'}/${proof.version.head}；pending=${proof.pending.length}）`)
        } else {
          details.push(`   ${tag}: 迁移台账 OK（version=${proof.version.at}；baselined=${proof.baselined} applied=${proof.applied.length}）`)
        }

        // 结构 + 额外对象（vs public；台账表为白名单基础设施）
        const tables = await prisma.$queryRawUnsafe(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1::text AND table_type = 'BASE TABLE'`, schema)
        const tenantTables = new Set(tables.map((t) => t.table_name))
        const missingTables = expectedList.filter((t) => !tenantTables.has(t))
        // 额外**表**（非契约表、非引擎白名单）——不自动 DROP，纳入阻断（R5 ②：未知差异必须阻断）
        const extraTables = [...tenantTables].filter((t) => !expected.tables.has(t) && !TENANT_LEDGER_WHITELIST.has(t))
        const cols = await prisma.$queryRawUnsafe(
          `SELECT table_name, column_name, data_type, udt_name, is_nullable
             FROM information_schema.columns WHERE table_schema = $1::text AND table_name = ANY($2::text[])`, schema, expectedList)
        const tenantColMap = new Map(cols.map((c) => [`${c.table_name}.${c.column_name}`, `${c.data_type}|${c.udt_name}|${c.is_nullable}`]))
        const columnDiffs = []
        for (const [key, expectedType] of publicColMap) {
          const got = tenantColMap.get(key)
          if (got === undefined) columnDiffs.push({ table: key.split('.')[0], column: key.split('.')[1], expected: expectedType, actual: '(缺失)' })
          else if (got !== expectedType) columnDiffs.push({ table: key.split('.')[0], column: key.split('.')[1], expected: expectedType, actual: got })
        }
        const parity = await compareTenantStructureToPublic(prisma, { schema, referenceSchema: 'public' })
        const constraintDiffs = parity.ok ? [] : (parity.missingDiffs || []).filter((d) => /^(约束|索引)/.test(d))
        const extraDiffs = [
          ...extraTables.map((t) => `表 额外: ${t}`),
          ...(parity.extraDiffs || []).filter((d) => {
            const m = d.match(/^表 额外: (.+)$/)
            if (m) return !TENANT_LEDGER_WHITELIST.has(m[1])
            // 台账表的列/索引不属于契约对象，白名单剔除
            return !(d.includes(TENANT_LEDGER))
          }),
        ]
        entry.structure = { missingTables, columnDiffs, constraintDiffs, extraDiffs: extraDiffs.slice(0, 20) }
        if (missingTables.length || columnDiffs.length || constraintDiffs.length) {
          entry.blockers.push('TENANT_STRUCTURE_DRIFT')
          drifted.push({ code, schema, schoolStatus, missingTables, extraTables: [], columnDiffs, constraintDiffs })
          details.push(`⚠️  ${tag}: 结构漂移（缺表 ${missingTables.length} / 列差异 ${columnDiffs.length} / 约束索引差异 ${constraintDiffs.length}）`)
        }
        if (extraDiffs.length) {
          entry.blockers.push('TENANT_EXTRA_OBJECTS')
          details.push(`⚠️  ${tag}: 未知额外对象 ${extraDiffs.length} 项（不自动 DROP；需 migration/人工处置）：${extraDiffs.slice(0, 6).join('；')}`)
        }
      }
    } catch (e) {
      entry.status = 'CHECK_ERROR'
      entry.blockers.push('CHECK_ERROR')
      entry.error = redactSecrets(e.message)
      errored.push({ code, schema: schema || null, schoolStatus, message: entry.error })
      details.push(`❌ ${tag}: 检查失败 - ${entry.error}`)
    }
    const primary = entry.blockers.length
      ? entry.blockers.slice().sort((a, b) => schoolStatusRank(a) - schoolStatusRank(b))[0]
      : 'OK'
    entry.status = primary
    if (primary !== 'OK') blockedSchools.push(code)
    base.schoolStatuses[code] = entry
  }

  const structureOk = drifted.length === 0 && missingSchemas.length === 0 && errored.length === 0
  const publicOk = publicMigration.ok && !(base.publicExtraObjects?.blocking) && !base.chainClassificationError
    && base.publicInfraShapes?.ok === true // P3-PUBLIC-INFRA-CHAIN-R1：两设施形状必须只读核实通过
  const ok = structureOk && publicOk && blockedSchools.length === 0
  const cannotCheck = base.publicExtraObjects?.cannotCheck === true || !!base.chainClassificationError
  const status = cannotCheck ? 'CANNOT_CHECK'
    : (!publicMigration.ok && publicMigration.status !== 'OK')
      ? publicMigration.status
      : (base.publicExtraObjects?.blocking ? 'PUBLIC_EXTRA_OBJECTS'
        : ok ? 'OK'
          : (missingSchemas.length || errored.length || blockedSchools.length) ? 'INCOMPLETE' : 'DRIFT')

  for (const d of details) log(`  [租户结构检查] ${d}`)
  if (ok) {
    log(`✅ [租户结构检查] ${schools.length} 所学校（active+disabled）迁移台账与结构均与版本化链一致（只读；未做任何写操作）`)
    log(`   TENANT_SCHEMA_CHECK=OK schools=${schools.length} expectedTables=${expected.count} chain=${String(base.chainDigest).slice(0, 12)}`)
  } else {
    log(`⚠️  [租户结构检查] 未通过：TENANT_SCHEMA_CHECK=${status} blockingSchools=[${blockedSchools.join(',')}] globalBlockers=[${globalBlockers.map((g) => g.code).join(',')}]（只读；不自动修复）`)
    log(`   处置（显式）：npm run db:sync（逐租户版本化回放，非破坏）；public 迁移问题按 runbook 人工核实后处置。`)
  }
  return {
    ...base,
    ok, status, checked: schools.length,
    schoolsChecked: schools.map((s) => `${s.code}:${s.status}`),
    globalBlockers,
    trafficBlocked: globalBlockers.some((g) => g.trafficBlocking),
    drifted, missingSchemas, errored, blockedSchools,
  }
}

/**
 * 把全部非删除学校的租户 schema **按版本化迁移链推进到链尾**（P3-W2-T02-R2）。
 *
 * 两种模式（`mode`）：
 *   - `'check'`（**启动默认**）：委托 checkTenantSchemas 做**只读**证明/检查（public 迁移 checksum +
 *     逐租户台账 + 结构/额外对象），返回结构化结果；不执行任何 DDL/DML。
 *   - `'apply'`（**仅显式命令**：`npm run db:sync` / 实例 fixture；启动侧任何 `AUTO_SYNC_TENANTS` 值
 *     都不进入本模式）：逐校 `provisionSchool`（内部逐租户按链回放并落台账 + 自证）+ 回填 + 种子 +
 *     admin 降级。失败**聚合上报**：任一学校/步骤失败 → `ok:false` + `failed[]`（含错误码），
 *     并且**绝不**打印成功汇总。
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} [opts]
 * @param {'apply'|'check'} [opts.mode] 默认 'apply'（保持既有调用方语义）；启动侧显式传 'check'
 * @param {string} [opts.adminPassword] 新建租户用（已存在租户不会重建账号）
 * @param {boolean} [opts.skipGenerate] 跳过 prisma generate（部署已生成过则置 true）
 * @param {boolean} [opts.acceptDataLoss] 历史签名兼容：true 视为允许**重试**台账中失败迁移（默认 false）
 * @param {boolean} [opts.retryFailed] 显式允许重试失败迁移（与 acceptDataLoss 等价，优先）
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<object>} check → checkTenantSchemas 结果；apply → {mode:'apply', ok, total, succeeded, failed[], failures}
 */
export async function syncAllTenantSchemas(prisma, { mode = 'apply', adminPassword = '', skipGenerate = false, acceptDataLoss = false, retryFailed = false, log = console.log } = {}) {
  if (mode === 'check') return checkTenantSchemas(prisma, { log })
  if (mode !== 'apply') throw new Error(`未知同步模式: ${mode}（仅支持 'check' | 'apply'）`)

  if (!skipGenerate) {
    log('① 重新生成 Prisma 客户端...')
    await runPrismaGenerate()
  }

  const failures = []
  const record = (code, step, message) => {
    failures.push({ code, step, message: String(message).slice(0, 500) })
  }

  // RC-04：**全部非删除学校**（active + disabled）都在升级清单内 —— 停用校重新启用前必须通过版本检查，
  // 因此其结构也在此对齐（deleted 学校的 schema 已 rename 进回收站，不在此列）。
  const rows = await prisma.school.findMany({
    where: { status: { not: 'deleted' } },
    select: { code: true, status: true }
  })
  const codes = rows.filter((r) => r.code).map((r) => r.code)
  const disabledCount = rows.filter((r) => r.status === 'disabled').length
  let succeeded = 0
  if (codes.length) {
    log(`\n② 同步 ${codes.length} 个租户 schema 与迁移链末端对齐（含 disabled ${disabledCount} 所；控制台 UI 新建租户同样覆盖）...`)
    for (const code of codes) {
      try {
        await provisionSchool({ prisma, code, adminPassword, log: () => {}, allowExisting: true, acceptDataLoss: acceptDataLoss === true || retryFailed === true })
        log(`  ✅ ${code}`)
        succeeded += 1
      } catch (e) {
        // 单个租户失败不阻断其余租户与回填，但必须**聚合上报**（AUD-009：失败不得被汇报成成功）
        // 附错误码（如 TENANT_STRUCTURE_DESTRUCTIVE_REFUSED / TENANT_STRUCTURE_PARITY_FAILED），便于脚本/运维定位
        log(`  ❌ ${code} 同步失败 - ${e.code ? `[${e.code}] ` : ''}${e.message}`)
        record(code, 'provisionSchool', `${e.code ? `[${e.code}] ` : ''}${e.message}`)
      }
    }
  } else {
    log('[SKIP] public."School" 中无学校，跳过租户 schema 同步')
  }

  log('\n③ SchoolCustomization 增量列回填（跨全部 schema）...')
  try {
    await backfillSchoolCustomization(prisma, log)
  } catch (e) {
    log(`  ❌ SchoolCustomization 回填失败 - ${e.message}`)
    record('*', 'backfillSchoolCustomization', e.message)
  }

  log('\n④ FieldOption 字段选项种子回填（跨全部租户，幂等）...')
  for (const code of codes) {
    try {
      await ensureFieldOptionSeeds(prisma, code, (m) => log(`  [${code}] ${m}`))
    } catch (e) {
      log(`  ❌ ${code} 字段选项种子失败 - ${e.message}`)
      record(code, 'fieldOptionSeeds', e.message)
    }
  }

  log('\n⑤ 学校 schema 内 role=admin 历史脏数据自愈（降级为 manager）...')
  try {
    await purgeInvalidAdminInSchools(prisma, log)
  } catch (e) {
    log(`  ❌ admin 脏数据自愈失败 - ${e.message}`)
    record('*', 'purgeInvalidAdminInSchools', e.message)
  }

  const ok = failures.length === 0
  if (ok) {
    log('\n✅ 所有租户 schema 已与 schema.prisma 对齐。')
  } else {
    // AUD-009：失败必须显式汇总（旧实现无论失败与否都打印上一行的 ✅，部署/启动侧据此误判成功）
    log(`\n❌ 租户 schema 对齐未全部完成：${failures.length} 项失败（涉及 ${new Set(failures.map((f) => f.code)).size} 个对象）——未达成"全部对齐"。`)
    for (const f of failures) log(`   - ${f.code} · ${f.step} · ${f.message}`)
    log('   处置：查看上方失败明细；破坏性变更须走 prisma migration（RC-04）。')
  }
  return { mode: 'apply', ok, total: codes.length, succeeded, failed: failures }
}
