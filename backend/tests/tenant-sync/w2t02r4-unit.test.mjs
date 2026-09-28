// P3-W2-T02-R4 定点单元测试（**无需数据库/PG**；npm run test:backend 覆盖）
//
// 覆盖 R6 四项反例的可离线验证面（取代 w2t02r3-unit.test.mjs；R3 语义中被推翻的部分在此更新）：
//   ① 无"环境变量放行租户流量"通道：server.js 不得出现 attestation 语义（静态护栏）
//   ② 分类失败 与 public 未知额外对象 → traffic-blocking（同时挡 readyz 与真实租户 API）
//   ③ 互斥锁：心跳 + 主机/PID 存活证明 + fencing token；锁龄不能作为接管依据
//   ④ 离线 baseline：证明与全链写入同锁 + 单事务 + 前置断言；无逐行非事务 upsert
// 并保留 R3 已通过的能力断言（链/注册表/投影 fail-closed/证明清单/凭据卫生/额外对象）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listMigrationFiles, chainManifest, fileChecksum, migrationChainDigest, migrationsDir,
  splitSqlStatements, statementDigest, classifyTenantMigration, buildTenantProjection,
  migrationClassificationRegistry, isAllSchemaSweepStatement,
  migrationLockDdl, MIGRATION_LOCK_TABLE, TENANT_LEDGER, migrationLockIdentity, isProcessAlive,
  acquireTenantMigrationLock, heartbeatTenantMigrationLock, assertTenantMigrationLockHeld,
  startMigrationLockHeartbeat, releaseTenantMigrationLock, forceReleaseTenantMigrationLock,
  readTenantMigrationLock, listTenantMigrationLocks, migrationLockDdl as _ddl,
  readExpectedTenantTables, buildBaselineProof, baselineTenantFromProof, applyTenantChain,
  tenantLedgerDdl, parseDbUrl, psqlArgv, redactSecrets,
} from '../../lib/tenantProvisioner.js'
import { PUBLIC_INFRA_TABLES, PUBLIC_TRAFFIC_BLOCKING_STATUS } from '../../lib/tenantSync.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

test('① 产品路径无"声明式放行"通道：server.js 不得含 attestation 语义', () => {
  const server = read('backend/server.js')
  // 注释/告警文案里说明"该通道已删除"是允许的；禁止的是**可执行引用**（读 env / 写字段 / 放行分支）
  assert.ok(!/process\.env\.TENANT_READINESS_ATTESTED/.test(server), '不得再读取 attestation 环境变量')
  assert.ok(!/TENANT_READINESS_ATTEST/.test(server.replace(/TENANT_READINESS_ATTESTED/g, 'X')), '不得存在其它 attest 环境变量别名')
  assert.ok(!/attested\s*[:.]/.test(server), 'server.js 不得再出现 attested 字段/属性访问')
  // 闸门必须保持：未就绪 → 全局阻断 → 归属 → 按校阻断 → 才 next()
  assert.ok(/globalBlockers\.some\(\(g\) => g\.trafficBlocking !== false\)/.test(server), '全局阻断判据必须在放行之前')
  assert.ok(server.includes("status: 'NOT_VERIFIED'") && server.includes('TENANT_MIGRATION_NOT_READY'))
  assert.ok(/TENANT_SYNC_MODE === 'off'/.test(server))
  // off 模式必须带 traffic-blocking global blocker（不是"只 503 readyz"）
  const offBlock = server.slice(server.indexOf("if (TENANT_SYNC_MODE === 'off')"), server.indexOf('    let result = null'))
  assert.ok(/code: 'NOT_VERIFIED', trafficBlocking: true/.test(offBlock), 'off 模式必须是 traffic-blocking')
  assert.ok(!/return next\(\)/.test(offBlock), 'off 模式不得出现放行分支')
})

test('② 分类失败 / public 未知额外对象 → traffic-blocking（不得只挡 readyz）', () => {
  const lib = read('backend/lib/tenantSync.js')
  const cls = lib.slice(lib.indexOf('// ①b 链分类一致性'), lib.indexOf('// ② public 额外对象分类'))
  assert.ok(/trafficBlocking: true/.test(cls), '分类失败必须 traffic-blocking（R6 ②）')
  assert.ok(!/trafficBlocking: false/.test(lib), 'tenantSync 不得再有 trafficBlocking:false 的阻断项')
  const extras = lib.slice(lib.indexOf('// ② public 额外对象分类'), lib.indexOf('// ③ 逐校'))
  assert.ok(/code: 'PUBLIC_EXTRA_OBJECTS', trafficBlocking: true/.test(extras), 'public 未知额外表必须进入 traffic-blocking 全局阻断')
  for (const s of ['PUBLIC_EXTRA_OBJECTS', 'TENANT_MIGRATION_UNCLASSIFIED', 'MIGRATION_FAILED', 'MIGRATIONS_PENDING', 'MIGRATION_CHECKSUM_MISMATCH', 'CANNOT_CHECK']) {
    assert.ok(PUBLIC_TRAFFIC_BLOCKING_STATUS.has(s), `${s} 必须在流量阻断集合`)
  }
  assert.ok(PUBLIC_INFRA_TABLES.includes(MIGRATION_LOCK_TABLE))
})

test('③ 互斥锁：心跳/身份/fencing；锁龄不是接管依据；有可证明死亡路径与人工清除', () => {
  const ddl = migrationLockDdl()
  for (const col of ['heartbeat_at', 'fencing_token', 'hostname', 'pid']) {
    assert.ok(ddl.includes(col), `锁表必须含 ${col}（存活证明/fencing）`)
  }
  const src = read('backend/lib/tenantProvisioner.js')
  assert.ok(/isProcessAlive\(holder\.pid\)/.test(src), '接管必须做 PID 存活探测')
  assert.ok(/sameHost && holder\.pid && alive === false/.test(src), '只有"同主机 + PID 已不存在"才算可证明死亡')
  assert.ok(/TENANT_MIGRATION_LOCK_STALE_UNPROVABLE/.test(src), '无法证明时必须拒绝并给人工通道')
  assert.ok(/TENANT_MIGRATION_LOCK_LOST/.test(src), '持有者每步失权断言必须存在')
  assert.ok(/heartbeatTenantMigrationLock/.test(src) && /assertTenantMigrationLockHeld/.test(src))
  assert.ok(/forceReleaseTenantMigrationLock/.test(src) && /TENANT_MIGRATION_LOCK_STALE_TAKEOVER/.test(src) === true)
  // 旧实现"仅按 locked_at 超时即 UPDATE 接管"必须已不存在
  assert.ok(!/WHERE schema_name = \$1 AND locked_at < now\(\) - \(\$3::bigint/.test(src), '锁龄独占的接管条件必须移除')
  const me = migrationLockIdentity()
  assert.equal(typeof me.hostname, 'string')
  assert.equal(me.pid, process.pid)
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(999999), false)
  assert.equal(isProcessAlive(null), null)
  assert.equal(typeof acquireTenantMigrationLock, 'function')
  assert.equal(typeof heartbeatTenantMigrationLock, 'function')
  assert.equal(typeof assertTenantMigrationLockHeld, 'function')
  assert.equal(typeof startMigrationLockHeartbeat, 'function')
  assert.equal(typeof releaseTenantMigrationLock, 'function')
  assert.equal(typeof forceReleaseTenantMigrationLock, 'function')
  assert.equal(typeof readTenantMigrationLock, 'function')
  assert.equal(typeof listTenantMigrationLocks, 'function')
})

test('④ 离线 baseline：证明与全链写入同锁 + 单事务 + 前置断言；无逐行非事务 upsert', () => {
  const src = read('backend/lib/tenantProvisioner.js')
  const fn = src.slice(src.indexOf('export async function baselineTenantFromProof'), src.indexOf('/** 台账存在性保证'))
  assert.ok(/acquireTenantMigrationLock/.test(fn), 'baseline 必须取迁移互斥锁')
  assert.ok(/assertTenantMigrationLockHeld/.test(fn), '写台账前必须核对锁未失权')
  // R5（R7 ③）更新：同一事务批必须带"会话互斥 guard + 提交前结构指纹校验"
  assert.ok(/migrationLockGuardSql\(\{ schema, owner, fencingToken: lock\.fencingToken \}\)/.test(fn)
    && /fingerprintCheck/.test(fn) && /tenantLedgerDdl\(schema\)/.test(fn) && /precheck/.test(fn) && /upserts/.test(fn),
    'guard + DDL + 提交前指纹校验 + 前置断言 + 全链 upsert 必须在同一个 psql 单事务批里')
  assert.ok(/TENANT_BASELINE_CONN_REQUIRED/.test(fn), '缺少事务通道时必须 fail-closed')
  assert.ok(/baseline_pre\$/.test(fn) && /RAISE EXCEPTION/.test(fn), '前置断言必须能在事务内 RAISE')
  assert.ok(/TENANT_BASELINE_LEDGER_INCOMPLETE/.test(fn), '事后整链校验必须存在')
  assert.ok(/TENANT_BASELINE_POSTCHECK_FAILED/.test(fn), '事后重新证明必须存在')
  assert.ok(!/await prisma\.\$executeRawUnsafe\(\s*`INSERT INTO \$\{ledgerIdent\(schema\)\} \(migration_name, checksum, status, started_at, finished_at, projection_sha256, skipped_sweeps, chain_digest, detail\)\s*VALUES \(\$1/.test(fn),
    '逐行 prisma upsert（无事务）必须移除')
  assert.equal(typeof buildBaselineProof, 'function')
  assert.equal(typeof baselineTenantFromProof, 'function')
  // 命令行：不得在证明之前预建台账；必须提供人工清除锁入口
  const cli = read('backend/sync-tenant-schemas.mjs')
  assert.ok(!/ensureTenantLedger/.test(cli), 'CLI 不得在证明之前预建台账（R6 ④）')
  assert.ok(/--force-unlock/.test(cli) && /--yes/.test(cli), '崩溃锁必须有人工清除入口')
  assert.ok(cli.includes('--baseline-plan') && cli.includes('--baseline-apply'))
})

test('R3 能力保留：链/注册表 checksum 绑定 + 分类协议 fail-closed + @scope:public 跳过', () => {
  const files = listMigrationFiles()
  // P3-PUBLIC-INFRA-CHAIN-R1（链尾所有者）新增 2 个 `-- @scope: public` migration（锁表 + 吊销表，第 12/13 位）；
  // P3-PUBLIC-INFRA-FOLLOWUP-R1 追加 1 个 public 前向修复（FieldOption FK，固定第 14 位）；
  // P3-LIFECYCLE-AB-R3 只在其后追加 M1/M2（`@scope: both`，第 15/16 位）：
  // 场景与断言保持（链 = 磁盘事实源、checksum 与文件一致），仅计数 11 → 13 → 14 → 16（逐项归因见各包 RESULT/R17 B-6）。
  assert.equal(files.length, 16)
  for (const m of chainManifest()) assert.equal(fileChecksum(m.name), m.checksum)
  const reg = migrationClassificationRegistry()
  assert.equal(reg.length, 11)
  assert.equal(reg.reduce((a, r) => a + r.skippedStatements, 0), 3)
  for (const m of chainManifest()) {
    const proj = buildTenantProjection({ name: m.name, sql: read(`backend/prisma/migrations/${m.name}/migration.sql`), checksum: m.checksum })
    const stmts = splitSqlStatements(read(`backend/prisma/migrations/${m.name}/migration.sql`))
    assert.equal(proj.kept + proj.skipped, stmts.length)
  }
  assert.throws(() => classifyTenantMigration({ name: '20990101000000_new', sql: 'CREATE TABLE "A"(id text);', checksum: 'x' }),
    (e) => e.code === 'TENANT_SCOPE_UNCLASSIFIED')
  assert.throws(() => classifyTenantMigration({
    name: '20990101000001_new',
    sql: '-- @scope: both\nDO $$ BEGIN PERFORM 1 FROM information_schema.columns; END $$;',
    checksum: 'x',
  }), (e) => e.code === 'TENANT_PROJECTION_UNCLASSIFIED')
  const marked = classifyTenantMigration({
    name: '20990101000002_new',
    sql: '-- @scope: both\n-- @tenant-scoped: 仅查本 schema\nDO $$ BEGIN PERFORM 1 FROM pg_namespace; END $$;',
    checksum: 'x',
  })
  assert.equal(marked.executed.length, 1)
  const pub = buildTenantProjection({ name: '20990101000003_pub', sql: '-- @scope: public\nCREATE TABLE "revoked_tokens"(jti text);', checksum: 'x' })
  assert.equal(pub.scope, 'public')
  assert.equal(pub.kept, 0)
  assert.ok(!/rebuildTenantSchemaFromChain/.test(read('backend/lib/tenantProvisioner.js')))
  assert.equal(TENANT_LEDGER, '_tenant_migrations')
  assert.ok(tenantLedgerDdl('school_x').includes('"_tenant_migrations"'))
  // 链目录 seam：相对/不存在路径必须 fail-closed（不得静默换链）
  const prev = process.env.TENANT_MIGRATIONS_DIR
  try {
    process.env.TENANT_MIGRATIONS_DIR = 'relative/dir'
    assert.throws(() => migrationsDir(), /必须是绝对路径/)
    process.env.TENANT_MIGRATIONS_DIR = '/nonexistent-r4-chain-dir'
    assert.throws(() => migrationsDir(), /不存在/)
  } finally {
    if (prev === undefined) delete process.env.TENANT_MIGRATIONS_DIR
    else process.env.TENANT_MIGRATIONS_DIR = prev
  }
  assert.equal(migrationChainDigest(), migrationChainDigest())
  // P3-LIFECYCLE-AB-R3（M1 expand，第 15 位）新增 `AuditPrincipal`（不可变主体锚点）：
  // 期望租户表 21 → 22（事实源 = schema.prisma model 声明；**逐项归因**，不盲加数字）。R17 B-6 见本包 RESULT。
  const expectedTables = readExpectedTenantTables()
  assert.equal(expectedTables.count, 22, '期望租户表 = 21（R4 基线）+ 1（M1 新增 AuditPrincipal）')
  assert.ok(expectedTables.tables.has('AuditPrincipal'), '新增表必须可归因为 M1 的 AuditPrincipal')
})

test('R3 能力保留：证明清单覆盖 + 凭据卫生 + 无 db push/末态 diff', () => {
  const src = read('backend/lib/tenantProvisioner.js')
  for (const id of ['columns.type.nullable.default', 'constraints.pk.unique.fk.check', 'constraints.validated',
    'indexes.all', 'no.unknown.objects', 'no.extra.tables', 'data.semantics']) {
    assert.ok(src.includes(`'${id}'`), `证明清单必须包含 ${id}`)
  }
  assert.deepEqual(psqlArgv(), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'])
  const conn = parseDbUrl('postgresql://u:p%40ss@127.0.0.1:5432/db')
  assert.equal(conn.password, 'p@ss')
  assert.ok(!redactSecrets('failed: postgresql://u:secret@h/db password=secret').includes('secret'))
  assert.ok(!/runPrismaPush/.test(src) && !/'migrate',\s*'diff'/.test(src))
  assert.ok(/TENANT_MIGRATION_STATE_UNPROVABLE/.test(src) && /diagnosticOnly/.test(src))
  assert.ok(!/allowBaseline/.test(src))
  assert.equal(typeof applyTenantChain, 'function')
  assert.ok(/assertTenantMigrationLockHeld\(\{ prisma, schema, owner: lockOwner, fencingToken: lockFencing \}\)/.test(src),
    'applyTenantChain 必须每迁移前断言锁')
  assert.ok(/heartbeat\.stop\(\)/.test(src), 'applyTenantChain 必须停止心跳')
  assert.ok(statementDigest('  SELECT 1; ') === statementDigest('SELECT 1;'))
  assert.equal(isAllSchemaSweepStatement('select 1 from pg_namespace'), true)
})
