// P3-W2-T02-R5 定点单元测试（**无需数据库/PG**；npm run test:backend 覆盖）
//
// 覆盖 R7 对 W2 的四个可判别边界：
//   ① 父进程死亡 ≠ SQL 执行者死亡：会话级 advisory 互斥 + 批内 fencing 断言 + **默认禁自动接管**
//   ② 人工清锁 = owner+fencing **CAS**；只有 ESRCH 可证明 PID 死亡
//   ③ baseline 事务边界：提交前（互斥+结构指纹+前置断言）失败 → 回滚；提交后复证失败 → **已提交、未回滚**、标记 failed
//   ④ 锁表版本化只交链尾方案（本包不创建正式 migration）
// 并保留 R4 已通过的能力断言（guard 接入点、指纹稳定性、CLI 语义、链未被抢占）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isProcessAlive, migrationLockAdvisoryKey, migrationLockGuardSql, sqlExecutorInFlight,
  migrationLockDdl, migrationLockUpgradeStatements, MIGRATION_LOCK_TABLE, TENANT_LEDGER,
  acquireTenantMigrationLock, forceReleaseTenantMigrationLock, readTenantMigrationLock,
  structureFingerprintQuery, structureFingerprint, buildBaselineProof, baselineTenantFromProof,
  applyTenantChain, listMigrationFiles, migrationChainDigest, migrationsDir,
} from '../../lib/tenantProvisioner.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
const SRC = read('backend/lib/tenantProvisioner.js')
const CLI = read('backend/sync-tenant-schemas.mjs')

test('① 执行期间数据库互斥：会话级 advisory + 事务内 fencing 断言，接入**每个** SQL 批', () => {
  const key = migrationLockAdvisoryKey('school_x')
  assert.equal(Number.isSafeInteger(key), true)
  assert.equal(key, migrationLockAdvisoryKey('school_x'), 'advisory key 必须确定性派生')
  assert.notEqual(key, migrationLockAdvisoryKey('school_y'))
  const g = migrationLockGuardSql({ schema: 'school_x', owner: "o'brien", fencingToken: 7 })
  assert.ok(/pg_try_advisory_lock\(\d+\)/.test(g), '批首必须尝试会话级 advisory 锁')
  assert.ok(g.includes('TENANT_MIGRATION_SQL_IN_PROGRESS'), '拿不到 advisory → 明确的 SQL_IN_PROGRESS 拒绝码')
  assert.ok(g.includes("o''brien"), 'owner 必须做 SQL 转义')
  assert.ok(g.includes('7::bigint') && /cur_owner <> /.test(g), '事务内必须比对 owner + fencing_token')
  assert.ok(/cur_fresh IS DISTINCT FROM true/.test(g) && /heartbeat_at > now\(\)/.test(g), '事务内必须校验心跳未过期')
  assert.ok(g.includes('TENANT_MIGRATION_LOCK_LOST'))
  // 只读探测（pg_locks，不产生副作用/不在连接池上 acquire-release）
  assert.ok(/FROM pg_locks/.test(SRC) && /locktype = 'advisory'/.test(SRC) && /classid::bigint << 32/.test(SRC))
  assert.equal(typeof sqlExecutorInFlight, 'function')
  assert.ok(!/pg_advisory_unlock/.test(SRC), '不得用 acquire-then-release 探测（连接池会换连接）')
  // 接入点：apply 三个批 + baseline 单事务批
  // R6：guard 覆盖点扩到 5 处（apply 三批 + 空租户建台账 + 失败状态写入）
  assert.ok((SRC.match(/guardFor\(\)/g) || []).length >= 4, 'R6：写入批（跳批/主批/建台账/失败写入）都要带 guard（后置条件分支不再自带写入）')
  assert.ok(/await ensureTenantLedger\(\{ conn, schema, log, guardSql: guardFor\(\) \}\)/.test(SRC), 'R6①：建台账批必须带 guard')
  assert.ok(/sql: guardFor\(\) \+ baseInsert\('failed', detail\)/.test(SRC), 'R6②：失败状态写入必须带 guard')
  assert.ok(/migrationLockGuardSql\(\{ schema, owner, fencingToken: lock\.fencingToken \}\)/.test(SRC), 'baseline 批首必须带 guard')
})

test('① 默认禁自动接管；开启时须"心跳过期 + ESRCH 死亡证明 + 无执行中 SQL 会话"', () => {
  assert.ok(/TENANT_MIGRATION_LOCK_STALE_TAKEOVER \|\| 'off'\) === 'on'/.test(SRC), '接管必须默认关闭（最安全即时修法）')
  assert.ok(/const inFlight = await sqlExecutorInFlight\(\{ prisma, schema \}\)/.test(SRC), '接管前必须探测执行中的 SQL 会话')
  assert.ok(/const heartbeatStale = ageMs >= stale/.test(SRC), '接管必须要求心跳已过期（父进程刚起子进程的窗口不算）')
  assert.ok(/!allowStaleTakeover \|\| !heartbeatStale \|\| inFlight/.test(SRC), '三重前提必须同时成立才允许接管')
  assert.ok(/err\.code = inFlight \? 'TENANT_MIGRATION_SQL_IN_PROGRESS'/.test(SRC), '有执行中 SQL 时必须给专用拒绝码')
  assert.ok(/const provableDead = !!\(sameHost && holder\.pid && alive === false\)/.test(SRC), '死亡证明仍须同主机 + 有 pid + pid 不存在')
})

test('② 只有 ESRCH 可证明死亡；EPERM/其它错误一律"未死亡"', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(999999), false, 'ESRCH（无此进程）→ 死亡')
  assert.equal(isProcessAlive(1), true, 'pid 1 通常 EPERM → 未知=未死亡，绝不能据此接管')
  assert.equal(isProcessAlive(0), null)
  assert.equal(isProcessAlive(-5), null)
  assert.equal(isProcessAlive('abc'), null)
  assert.ok(/if \(e && e\.code === 'ESRCH'\) return false/.test(SRC), '只认 ESRCH')
  assert.ok(!/return e && e\.code === 'EPERM' \? true : false/.test(SRC), '旧的"非 EPERM 即死亡"必须移除')
})

test('② 人工清锁 = owner+fencing CAS（不匹配不删、返回当前行）', () => {
  const fn = SRC.slice(SRC.indexOf('export async function forceReleaseTenantMigrationLock'), SRC.indexOf('// ───────────────────────── baseline 提交前结构指纹'))
  assert.ok(/expectOwner = null, expectFencingToken = null/.test(fn), 'CAS 凭据必须是显式参数')
  assert.ok(/outcome: 'EXPECTATION_REQUIRED'/.test(fn), '缺凭据必须拒绝（不删锁）')
  assert.ok(/WHERE schema_name = '\$\{esc\(schema\)\}' AND owner = '\$\{esc\(expectOwner\)\}' AND fencing_token = \$\{Number\(expectFencingToken\)\}::bigint/.test(fn), 'R6③：DELETE 必须三键 CAS（同一事务内）')
  // R6 ③：CAS 删除进入 psql 单事务批（advisory 互斥 + 行数断言），结果由批错误分类
  assert.ok(/TENANT_UNLOCK_CAS_MISMATCH/.test(fn) && /TENANT_UNLOCK_CONN_REQUIRED/.test(fn)
    && /pg_try_advisory_lock\(\$\{key\}\)/.test(fn) && /atomic: 'advisory\+tx'/.test(fn), 'R6：清锁必须与执行批同处 advisory 互斥事务')
  assert.ok(!/DELETE FROM public\."\$\{MIGRATION_LOCK_TABLE\}" WHERE schema_name = \$1\`/.test(fn), '单键删除必须移除')
  assert.ok(/--owner/.test(CLI) && /--fencing/.test(CLI), 'CLI 必须要求展示过的 owner+fencing')
  assert.ok(/expectOwner: FORCE_UNLOCK_OWNER/.test(CLI) && /CAS 不匹配/.test(CLI), 'CLI 必须在 CAS 失败时重新展示且不删锁')
  assert.ok(/sqlExecutorInFlight\(\{ prisma, schema \}\)/.test(CLI) && /拒绝清除/.test(CLI), 'CLI 必须先探测执行中 SQL 会话')
  assert.equal(typeof forceReleaseTenantMigrationLock, 'function')
  assert.equal(typeof readTenantMigrationLock, 'function')
})

test('③ baseline 边界：提交前指纹校验 → 回滚；提交后失败 → 已提交、标记 failed、不再声称回滚', () => {
  const fn = SRC.slice(SRC.indexOf('export async function baselineTenantFromProof'), SRC.indexOf('/** 台账存在性保证'))
  assert.ok(/structureFingerprint\(\{ prisma, schema \}\)/.test(fn), '计划期必须取结构指纹')
  assert.ok(/TENANT_BASELINE_PRE_COMMIT_STRUCTURE_CHANGED/.test(fn), '批内必须校验指纹并在不一致时 RAISE')
  assert.ok(/TENANT_BASELINE_PRE_COMMIT_DELAY_MS/.test(fn) && /TENANT_BASELINE_POST_COMMIT_DELAY_MS/.test(fn), '受控并发反例的两个 seam 必须存在')
  assert.ok(/Math\.min\(10000, Math\.max\(0, Number\(process\.env\.TENANT_BASELINE_PRE_COMMIT_DELAY_MS/.test(fn), 'seam 必须钳制（≤10s）')
  assert.ok(/err\.committed = true/.test(fn) && /err\.rolledBack = false/.test(fn), '提交后失败必须显式标注"已提交、未回滚"')
  // R6 ④：先写非终态 baseline_pending（阻断与后续写入无关）；复证通过才提升为 baselined
  assert.ok(/baseline_postcheck=FAILED@\$\{stamp\}/.test(fn) && /ledgerStatus = 'baseline_pending'/.test(fn), 'R6：提交后失败保持非终态 + 留痕')
  assert.ok(/TENANT_BASELINE_PROMOTION_FAILED/.test(fn), 'R6：提升失败必须显式报错（保持非终态阻断）')
  assert.ok(/baseline_postcheck=OK@\$\{stamp\}/.test(fn) && /status = 'baselined'/.test(fn), 'R6：成功才提升为 baselined 并留 postcheck=OK 痕')
  assert.ok(/COALESCE\(detail, ''\) NOT LIKE '%baseline_postcheck=FAILED%'/.test(fn), '重新 baseline 只能放行"事后校验失败"这一类 failed 行')
  assert.ok(/TENANT_BASELINE_LEDGER_INCOMPLETE/.test(fn) && /TENANT_BASELINE_PROOF_FAILED/.test(fn))
  // 不再声称"任一步失败全回滚"
  assert.ok(!/任一步失败整体回滚|任一步失败 → 全/.test(SRC), '产品注释不得保留"任一步失败全回滚"的笼统说法')
  assert.ok(!/任一步失败.{0,6}全(部)?回滚/.test(SRC.replace(/不(可|得|应|能)声称[^\n]*/g, '')), '当前产品代码不得声称任一步失败全回滚')
  assert.equal(typeof buildBaselineProof, 'function')
  assert.equal(typeof baselineTenantFromProof, 'function')
})

test('③ 指纹查询：单语句、覆盖结构面、排除台账、确定性', () => {
  const q1 = structureFingerprintQuery('school_x', ['A', 'B'])
  const q2 = structureFingerprintQuery('school_x', ['A', 'B'])
  assert.equal(q1, q2, '同一输入必须产生同一 SQL（保证两处比对同口径）')
  assert.equal((q1.match(/;/g) || []).length, 0, '必须是单条 SELECT（可嵌入 DO 块/Prisma 调用）')
  for (const frag of ['information_schema.columns', 'pg_constraint', 'pg_index', 'relkind', 'pg_proc', 'pg_trigger', 'convalidated', 'indisunique']) {
    assert.ok(q1.includes(frag), `指纹必须覆盖 ${frag}`)
  }
  assert.ok(q1.includes(`<> '${TENANT_LEDGER}'`), '指纹必须排除台账表（表名分支）')
  assert.ok(/NOT \(t\.table_name = ANY\(ARRAY\[/.test(q1), '契约表不得计入"额外表"分支')
  assert.ok(q1.includes(`table_name = ANY(ARRAY[`) && /tc\.relname = ANY\(ARRAY\[/.test(q1), '约束/索引分支只覆盖契约表（台账索引不参与）')
  assert.equal(typeof structureFingerprint, 'function')
})

test('④ 锁表版本化只交链尾方案：本包未抢占迁移链', () => {
  // P3-PUBLIC-INFRA-CHAIN-R1（链尾所有者）其后新增 2 个 `-- @scope: public` migration（锁表 + 吊销表，第 12/13 位）；
  // P3-PUBLIC-INFRA-FOLLOWUP-R1 追加 1 个 public 前向修复（FieldOption FK，第 14 位，不含锁表 DDL）；
  // P3-LIFECYCLE-AB-R3 只在其后追加 M1/M2（`@scope: both`，第 15/16 位）；
  // P3-FRIENDLY-LINKS 再追加 1 个 `@scope: both`（友情链接表，第 17 位）：
  // 场景与断言保持（R5 未抢占链；旧 11 文件仍不含锁表 DDL），仅计数与"唯一含锁表 DDL 的文件"更新。
  assert.equal(listMigrationFiles().length, 17, '迁移链 = 原 11 + 公共基础设施 2（第 12/13 位）+ public 前向修复 1（第 14 位）+ M1/M2 2（第 15/16 位）+ 友情链接 1（第 17 位；逐项归因见各包 RESULT/R17 B-6）')
  const legacy = listMigrationFiles().slice(0, 11)
  for (const m of legacy) {
    const sql = read(`backend/prisma/migrations/${m.name}/migration.sql`)
    assert.ok(!/_tenant_migration_locks/.test(sql), `${m.name} 不得提前包含锁表 DDL`)
  }
  const lockMigrations = listMigrationFiles().filter((m) => /_tenant_migration_locks/.test(read(`backend/prisma/migrations/${m.name}/migration.sql`)))
  assert.equal(lockMigrations.length, 1, '锁表 DDL 只允许出现在唯一的链尾 public migration')
  // P3-PUBLIC-INFRA-CHAIN-R1 落地后：产品注释指向"链尾版本化归属"（R5 方案文档 或 落地 migration）
  assert.ok(/LOCK_TABLE_VERSIONING_PLAN\.md|20260926120000_public_infra_tenant_migration_locks/.test(SRC), '产品注释必须指向链尾版本化归属（R5 方案 或 落地 migration）')
  const lockSql = read('backend/prisma/migrations/20260926120000_public_infra_tenant_migration_locks/migration.sql')
  assert.ok(/^\s*--\s*@scope:\s*public\s*$/m.test(lockSql), '已落地的锁表迁移必须只作用于 public')
  assert.ok(/CREATE TABLE IF NOT EXISTS "_tenant_migration_locks"/.test(lockSql), '锁表结构须由正式迁移创建')
  // 运行时 DDL 仍幂等（bootstrap 期），且升级语句非破坏
  const ddl = migrationLockDdl() + migrationLockUpgradeStatements().join('\n')
  assert.ok(/CREATE TABLE IF NOT EXISTS/.test(ddl) && /ADD COLUMN IF NOT EXISTS/.test(ddl))
  assert.ok(!/DROP|DELETE FROM|TRUNCATE/.test(ddl), '运行时锁表 DDL 不得包含破坏性语句')
  assert.ok(migrationLockDdl().includes(MIGRATION_LOCK_TABLE))
  assert.equal(migrationChainDigest(), migrationChainDigest())
  assert.equal(typeof applyTenantChain, 'function')
  void migrationsDir
})
