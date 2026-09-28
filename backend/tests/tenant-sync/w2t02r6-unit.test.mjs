// P3-W2-T02-R6 定点单元测试（**无需数据库/PG**；npm run test:backend 覆盖）
//
// 覆盖 R8 对 W2 的四处"未受保护/不原子/不持久"代码路径：
//   ① 空租户 `ensureTenantLedger()` 的建台账 DDL 写批必须受 advisory + owner/fencing guard
//   ② 通用失败分支：failed 台账写入受同一 guard + **写后核对**；写不入不得声称"已记录"且保留互斥锁
//   ③ 人工 `--force-unlock` 的 CAS 必须与执行批处于**同一 advisory 互斥事务**（含"探测后、删除前"seam）
//   ④ baseline：批内先写**非终态** `baseline_pending`（阻断不依赖后续写入）→ 复证通过才提升为 baselined；
//      复证/提升失败均保持非终态阻断；apply 路径遇 `baseline_pending` 拒绝回放
// ⑤ 锁表正式 migration 只交排期方案（本包不创建 migration）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureTenantLedger, recordTenantFailureRow, forceReleaseTenantMigrationLock, migrationLockGuardSql,
  migrationLockAdvisoryKey, baselineTenantFromProof, applyTenantChain, listMigrationFiles,
  migrationLockDdl, migrationLockUpgradeStatements, TENANT_LEDGER, MIGRATION_LOCK_TABLE,
} from '../../lib/tenantProvisioner.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
const SRC = read('backend/lib/tenantProvisioner.js')
const CLI = read('backend/sync-tenant-schemas.mjs')

test('① 空租户建台账批受 guard（advisory + owner/fencing）', () => {
  const fn = SRC.slice(SRC.indexOf('export async function ensureTenantLedger'), SRC.indexOf('export async function ensureTenantLedger') + 700)
  assert.ok(/guardSql = ''/.test(fn), '必须是可选 guardSql 参数')
  assert.ok(/runPsqlBatch\(\{ conn, sql: `\$\{guardSql\}\$\{tenantLedgerDdl\(schema\)\}` \}\)/.test(fn), '建台账必须与 guard 同批执行')
  assert.ok(!/prisma\.\$executeRawUnsafe\(tenantLedgerDdl/.test(SRC), '建台账不得绕过 psql 批（不得用 prisma 裸执行）')
  assert.ok(/await ensureTenantLedger\(\{ conn, schema, log, guardSql: guardFor\(\) \}\)/.test(SRC), 'apply 路径的调用点必须传 guard')
  assert.equal(typeof ensureTenantLedger, 'function')
  // guard 语义（与执行批同一函数，故同一边界）
  const g = migrationLockGuardSql({ schema: 'school_x', owner: 'o', fencingToken: 1 })
  assert.ok(/pg_try_advisory_lock/.test(g) && /TENANT_MIGRATION_SQL_IN_PROGRESS/.test(g) && /TENANT_MIGRATION_LOCK_LOST/.test(g))
})

test('② 失败状态写入：同 guard + 写后核对 + 不实声称 + 保留锁待复核', () => {
  assert.equal(typeof recordTenantFailureRow, 'function', '必须导出可测的失败写入核对函数')
  const fn = SRC.slice(SRC.indexOf('export async function recordTenantFailureRow'), SRC.indexOf('export async function recordTenantFailureRow') + 1200)
  assert.ok(/readTenantMigrationLedger\(prisma, schema\)/.test(fn) && /row\.status === 'failed'/.test(fn), '必须写后核对台账行状态')
  assert.ok(/return \{ ok: false, reason \}/.test(fn), '核对不一致必须返回 ok:false（不得静默成功）')
  const branch = SRC.slice(SRC.indexOf('const recorded = await recordTenantFailureRow'), SRC.indexOf('const recorded = await recordTenantFailureRow') + 1200)
  assert.ok(/sql: guardFor\(\) \+ baseInsert\('failed', detail\)/.test(branch), '失败写入必须带 guard')
  assert.ok(/if \(!recorded\.ok\) holdLockForReview = true/.test(branch), '写不入必须保留锁')
  assert.ok(/recorded\.ok\s*\n?\s*\? '已记入台账 failed'/.test(branch) && /\*\*失败状态未能记入台账\*\*/.test(branch), '必须区分"已记录/未记录"两种文案')
  assert.ok(/err\.ledgerRecorded = recorded\.ok/.test(branch) && /err\.lockHeldForReview = !recorded\.ok/.test(branch))
  assert.ok(/if \(lockAcquired && prisma && !holdLockForReview\)/.test(SRC), 'finally 必须按 holdLockForReview 决定是否释放锁')
  assert.ok(/\*\*保留\*\*迁移互斥锁/.test(SRC), '保留锁必须留日志与人工清除指引')
  assert.ok(!/await runPsqlBatch\(\{ conn, sql: guardFor\(\) \+ baseInsert\('failed', detail\) \}\)\.catch\(\(\) => \{\}\)/.test(SRC), '不得再"吞掉写失败"')
})

test('③ 人工清锁：同 advisory 互斥事务内 CAS（原子），带竞态 seam 与结果分类', () => {
  const fn = SRC.slice(SRC.indexOf('export async function forceReleaseTenantMigrationLock'), SRC.indexOf('// ───────────────────────── baseline 提交前结构指纹'))
  assert.ok(/conn = null/.test(fn) && /TENANT_UNLOCK_CONN_REQUIRED/.test(fn), '缺 psql 通道必须拒绝（不接受裸 DELETE）')
  assert.ok(/pg_try_advisory_lock\(\$\{key\}\)/.test(fn), '必须在同一事务内先取 advisory 互斥')
  assert.ok(/IF acquired IS NOT true THEN[\s\S]{0,200}TENANT_MIGRATION_SQL_IN_PROGRESS/.test(fn), '拿不到 advisory 必须整体拒绝')
  assert.ok(/WITH d AS \([\s\S]{0,200}DELETE FROM public\."\$\{MIGRATION_LOCK_TABLE\}"/.test(fn), '删除必须与 advisory 同批')
  assert.ok(/SELECT count\(\*\) INTO n FROM d/.test(fn) && /IF n <> 1 THEN[\s\S]{0,300}TENANT_UNLOCK_CAS_MISMATCH/.test(fn), '必须断言恰好删除 1 行，否则事务内 RAISE（回滚）')
  assert.ok(/TENANT_FORCE_UNLOCK_PRE_DELETE_DELAY_MS/.test(CLI) && /preDeleteDelayMs: Number\(process\.env\.TENANT_FORCE_UNLOCK_PRE_DELETE_DELAY_MS/.test(CLI), 'CLI 必须传"探测后、删除前"seam')
  assert.ok(/Math\.min\(10000, Math\.max\(0, Number\(preDeleteDelayMs\)/.test(fn), 'seam 必须钳制（≤10s）')
  assert.ok(/'SQL_IN_PROGRESS'/.test(fn) && /'CAS_MISMATCH'/.test(fn) && /atomic: 'advisory\+tx'/.test(fn))
  assert.ok(/outcome === 'SQL_IN_PROGRESS'/.test(CLI) && /未删除任何锁/.test(CLI), 'CLI 必须处理 SQL_IN_PROGRESS 并说明未删除')
  assert.ok(/conn: unlockConn/.test(CLI) && /parseDbUrl\(String\(process\.env\.DATABASE_URL\)\.split\('\?'\)\[0\]\)/.test(CLI), 'CLI 必须把 psql 通道传给清锁')
  assert.ok(!/崩溃锁用 --force-unlock <code> --yes 人工清除/.test(CLI), 'R8 点名的旧帮助文本必须移除')
  assert.ok(/--owner <o> --fencing <n> --yes/.test(CLI), '帮助文本必须给出 CAS 形式')
})

test('④ baseline：非终态先写 → 复证通过才提升；失败/提升失败均保持阻断且不称回滚', () => {
  const fn = SRC.slice(SRC.indexOf('export async function baselineTenantFromProof'), SRC.indexOf('/** 台账存在性保证'))
  assert.ok(/VALUES \('\$\{f\.name\}', '\$\{fileChecksum\(f\.name\)\}', 'baseline_pending', now\(\), NULL/.test(fn), '批内必须写非终态 baseline_pending')
  assert.ok(!/VALUES \('\$\{f\.name\}', '\$\{fileChecksum\(f\.name\)\}', 'baselined'/.test(fn), '批内不得直接写终态 baselined')
  assert.ok(/status='baseline_pending', finished_at=NULL/.test(fn), 'ON CONFLICT 也必须回到非终态')
  assert.ok(/r\.status === 'baseline_pending'/.test(fn) && /TENANT_BASELINE_LEDGER_INCOMPLETE/.test(fn), '事务后必须核对非终态行')
  // 复证失败：保持非终态 + 阻断与留痕无关
  assert.ok(/ledgerStatus = 'baseline_pending'/.test(fn) && /err\.blocked = true/.test(fn), '复证失败必须标注非终态阻断')
  assert.ok(/与失败留痕是否写入无关/.test(fn) || /与后续 UPDATE 是否成功无关/.test(fn), '必须声明阻断不依赖后续写入')
  assert.ok(/err\.committed = true/.test(fn) && /err\.rolledBack = false/.test(fn), '必须保持"已提交、未回滚"语义')
  assert.ok(/markerWritten/.test(fn), '失败留痕必须作为审计信息单独上报')
  // 复证通过 → 提升；提升失败 → PROMOTION_FAILED
  assert.ok(/SET status = 'baselined', finished_at = now\(\)/.test(fn) && /AND status = 'baseline_pending'/.test(fn), '提升必须显式限定非终态行')
  assert.ok(/TENANT_BASELINE_PROMOTION_FAILED/.test(fn) && /promotedRows\.length !== names\.length/.test(fn), '提升不完整必须显式失败')
  // apply 路径遇 baseline_pending 拒绝回放
  assert.ok(/TENANT_BASELINE_PENDING_REVIEW/.test(fn) === false && /TENANT_BASELINE_PENDING_REVIEW/.test(SRC), '拒绝回放码必须在 apply 路径')
  const applyFn = SRC.slice(SRC.indexOf('const pendingBaselineRows'), SRC.indexOf('const pendingBaselineRows') + 900)
  assert.ok(/ledger\.rows\.filter\(\(r\) => r\.status === 'baseline_pending'\)/.test(applyFn) && /拒绝按链回放/.test(applyFn))
  assert.ok(typeof applyTenantChain === 'function' && typeof baselineTenantFromProof === 'function')
})

test('⑤ 锁表版本化：排期方案已由 P3-PUBLIC-INFRA-CHAIN-R1 落地（入链 + 撤出运行时 CREATE/ALTER）', () => {
  // 场景保持（"入链 + 撤出运行时 DDL + 只读形状检查"同一发布），断言按链尾所有者包更新：
  //   · 链 11 → 13：新增 2 个 `-- @scope: public` migration（锁表 / 吊销表，第 12/13 位；逐项归因见该包 RESULT）；
  //     P3-PUBLIC-INFRA-FOLLOWUP-R1 追加 1 个 public 前向修复（FieldOption FK，第 14 位）→ 14；
  //     P3-LIFECYCLE-AB-R3 只在其后追加 M1/M2（`@scope: both`，第 15/16 位）→ 16；
  //     P3-FRIENDLY-LINKS 再追加 1 个 `@scope: both`（友情链接表，第 17 位）→ 17；
  //   · 锁表 DDL 只出现在**唯一**的 public migration 内（旧 11 文件与后续文件（含 M1/M2）仍不得包含）；
  //   · 运行时 ensure 不再执行 DDL（静态护栏：函数体内无 $executeRawUnsafe / CREATE / ALTER）。
  assert.equal(listMigrationFiles().length, 17, '迁移链 = 原 11 + 公共基础设施 2（第 12/13 位）+ public 前向修复 1（第 14 位）+ M1/M2 2（第 15/16 位）+ 友情链接 1（第 17 位；R17 B-6）')
  const legacy = listMigrationFiles().slice(0, 11)
  for (const m of legacy) {
    const sql = read(`backend/prisma/migrations/${m.name}/migration.sql`)
    assert.ok(!/_tenant_migration_locks/.test(sql), `${m.name} 不得包含锁表 DDL（链尾所有者包才有）`)
  }
  const lockMigration = listMigrationFiles().find((m) => /_tenant_migration_locks/.test(read(`backend/prisma/migrations/${m.name}/migration.sql`)))
  assert.ok(lockMigration, '锁表必须已入链（唯一含锁表 DDL 的 public migration）')
  const lockSql = read(`backend/prisma/migrations/${lockMigration.name}/migration.sql`)
  assert.ok(/@scope: public/.test(lockSql), '锁表 migration 必须是 @scope: public')
  assert.ok(/CREATE TABLE IF NOT EXISTS "_tenant_migration_locks"/.test(lockSql) && /ADD COLUMN IF NOT EXISTS/.test(lockSql))
  assert.ok(!/DROP|DELETE FROM|TRUNCATE/.test(lockSql), '入链 migration 不得包含破坏性语句')
  assert.ok(/CREATE TABLE IF NOT EXISTS "_tenant_migration_locks"/.test(lockSql), '正式迁移须创建锁表')
  assert.ok(/ADD COLUMN IF NOT EXISTS heartbeat_at/.test(lockSql), '正式迁移须升级旧锁表')
  // ⚠️ 运行时定义仅作"同形对照"，不再被执行（静态护栏：ensure 体内不得出现 DDL 执行）
  const ensureFn = SRC.slice(SRC.indexOf('export async function assertTenantMigrationLockTableShape'), SRC.indexOf('export function migrationLockTableShape'))
  assert.ok(!/\$executeRawUnsafe/.test(ensureFn), 'ensure（形状断言）不得执行任何 SQL 写/DDL')
  assert.ok(/lockTableShapeIssues/.test(ensureFn) && /LOCK_TABLE_SHAPE_MISMATCH/.test(ensureFn), '缺形状必须抛确定码')
  // 只禁"锁表 DDL 的执行"，不禁其它 DDL（如租户 schema 的 CREATE SCHEMA 属另一路径）
  assert.ok(!/\$executeRawUnsafe\(\s*(createSql|migrationLockDdl|migrationLockUpgrade)/.test(SRC), '产品路径不得再执行锁表 CREATE/ALTER')
  // 对照定义仍与 migration 同形（具体逐字断言见 publicInfraChain.unit.test.mjs）
  const ddl = migrationLockDdl() + migrationLockUpgradeStatements().join('\n')
  assert.ok(/CREATE TABLE IF NOT EXISTS/.test(ddl) && /ADD COLUMN IF NOT EXISTS/.test(ddl))
  assert.ok(!/DROP|DELETE FROM|TRUNCATE/.test(ddl))
  assert.ok(migrationLockDdl().includes(MIGRATION_LOCK_TABLE) && TENANT_LEDGER === '_tenant_migrations')
  assert.equal(migrationLockAdvisoryKey('school_x'), migrationLockAdvisoryKey('school_x'))
})
