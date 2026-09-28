// P3-PUBLIC-INFRA-CHAIN-R1 定点单元测试（**无需数据库/PG**）
//
// 覆盖（R9 §1 / R6 C1+C2+C3 同一可审发布）：
//   ① 链尾新增 2 个 `-- @scope: public` migration：锁表 + 吊销表（表/三索引），顺序确定；
//   ② 与 runtime 历史定义**逐字等价**（除 `public.` 前缀）+ 形状契约（列/默认值/主键/索引列序）一致；
//   ③ **运行时 DDL 已撤出**（静态护栏）：authMiddleware 无 CREATE/ALTER；tenantProvisioner 的
//      形状断言函数不执行任何写/DDL；`readTenantMigrationLock` 不吞形状错误（fail-closed）；
//   ④ 只读形状探针（桩 prisma）：缺表/错列/错默认值/缺索引/错列序/唯一索引 → 确定 issues；
//   ⑤ `baseline_pending` 为**正式已知非终态**：以确定码上报（非"未知状态"兜底）且仍阻断；
//   ⑥ 认证侧 `AUTH_INFRA_MISSING` 码与吊销形状契约同源；tenantSync 闸门接入形状检查。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listMigrationFiles, chainManifest, migrationLockDdl, migrationLockUpgradeStatements, MIGRATION_LOCK_TABLE,
} from '../../lib/tenantProvisioner.js'
import {
  LOCK_TABLE_SHAPE, REVOKED_TOKENS_SHAPE, REVOKED_TOKENS_INDEXES,
  lockTableShapeIssues, revokedTokensShapeIssues, publicInfraShapeReport,
  AUTH_INFRA_MISSING, LOCK_TABLE_SHAPE_MISMATCH, PUBLIC_INFRA_SHAPE_MISMATCH,
} from '../../lib/publicInfraShape.js'
import {
  readTenantMigrationProof, LEDGER_NON_TERMINAL_STATUS, PUBLIC_TRAFFIC_BLOCKING_STATUS,
} from '../../lib/tenantSync.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')
const norm = (s) => String(s).replace(/\s+/g, ' ').replace(/public\./g, '').trim().replace(/;$/, '')

const LOCK_MIG = '20260926120000_public_infra_tenant_migration_locks'
const REVOKED_MIG = '20260926120100_public_infra_revoked_tokens'
// P3-PUBLIC-INFRA-FOLLOWUP-R1：历史 FieldOption FK 跨 schema 误判的前向修复（**第 14 位**，public-only；非当前链尾）
const FOLLOWUP_MIG = '20260927120000_public_infra_field_option_self_fk'
// P3-LIFECYCLE-AB-R3（窗口 3，R10 放行后）：M1/M2 生命周期迁移（`@scope: both`）**只追加**在第 14 位之后（当前链尾 = M2）
const M1_MIG = '20260927130000_lifecycle_audit_principal_expand'
const M2_MIG = '20260927140000_lifecycle_audit_principal_enforce'
const lockSql = read(`backend/prisma/migrations/${LOCK_MIG}/migration.sql`)
const revokedSql = read(`backend/prisma/migrations/${REVOKED_MIG}/migration.sql`)
const followupSql = read(`backend/prisma/migrations/${FOLLOWUP_MIG}/migration.sql`)
const m1Sql = read(`backend/prisma/migrations/${M1_MIG}/migration.sql`)
const m2Sql = read(`backend/prisma/migrations/${M2_MIG}/migration.sql`)

// ── 桩 prisma（只读探针用）：按 SQL 形态返回可注入的行 ──
function stubPrisma({ columns = [], pk = [], indexes = [] } = {}) {
  return {
    async $queryRawUnsafe(sql) {
      if (/pg_index/.test(sql) && /indisprimary/.test(sql)) return pk
      if (/pg_index/.test(sql)) return indexes
      if (/pg_attribute/.test(sql)) return columns
      throw new Error(`stub: 未预期的 SQL: ${String(sql).slice(0, 60)}`)
    },
  }
}
const colRows = (shape) => shape.columns.map((c) => ({ name: c.name, type: c.type, not_null: c.notNull, default_expr: c.defaultExpr }))

test('① 链位次入链：3 个 @scope: public migration 固定第 12/13/14 位（锁表 / 吊销表 / FieldOption FK 前向修复），其后只追加 M1/M2', () => {
  const files = listMigrationFiles()
  assert.equal(files.length, 16, '链 = 原 11（both/既有）+ 3 个 public（第 12/13/14 位）+ M1/M2（第 15/16 位，P3-LIFECYCLE-AB-R3）')
  // 历史位置证明（**绝对位次**，不随链增长漂移；不得用 length-3/2/1 冒充）
  assert.equal(files[11].name, LOCK_MIG, '第 12 位：锁表')
  assert.equal(files[12].name, REVOKED_MIG, '第 13 位：吊销表')
  assert.equal(files[13].name, FOLLOWUP_MIG, '第 14 位：FieldOption FK 前向修复（**非**当前链尾）')
  // 其后**只**追加 M1/M2（且它们是 both，非 public-only）
  assert.deepEqual(files.slice(14).map((m) => m.name), [M1_MIG, M2_MIG], '第 15/16 位只能是 M1/M2（追加式，不得插队）')
  assert.ok(/^\s*--\s*@scope:\s*both\s*$/m.test(m1Sql) && /^\s*--\s*@scope:\s*both\s*$/m.test(m2Sql), 'M1/M2 必须 @scope: both（租户投影；不得冒充 public-only）')
  assert.ok(/^\s*--\s*@scope:\s*public\s*$/m.test(lockSql) && /^\s*--\s*@scope:\s*public\s*$/m.test(revokedSql) && /^\s*--\s*@scope:\s*public\s*$/m.test(followupSql), '三者必须显式 @scope: public')
  assert.ok(!/@scope:\s*both/.test(lockSql + revokedSql + followupSql), '不得声明 both（不得进租户投影）')
  // public-only 家族恰为三者（防把 M1/M2 误纳入或以旧 public 冒充链尾）
  const publicOnly = files.filter((m) => /^\s*--\s*@scope:\s*public\s*$/m.test(read(`backend/prisma/migrations/${m.name}/migration.sql`)))
  assert.deepEqual(publicOnly.map((m) => m.name), [LOCK_MIG, REVOKED_MIG, FOLLOWUP_MIG], 'public-only 家族恰为锁表/吊销表/前向修复三者')
  assert.ok(/CREATE TABLE IF NOT EXISTS "_tenant_migration_locks"/.test(lockSql))
  for (const col of ['heartbeat_at', 'fencing_token', 'hostname', 'pid']) {
    assert.ok(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}`).test(lockSql), `存量升级必须含 ${col}`)
  }
  assert.ok(!/DROP|DELETE FROM|TRUNCATE/.test(lockSql + revokedSql), '入链 migration 不得含破坏性语句')
  assert.ok(/CREATE TABLE IF NOT EXISTS revoked_tokens/.test(revokedSql))
  for (const idx of REVOKED_TOKENS_INDEXES) {
    const re = new RegExp(`CREATE INDEX IF NOT EXISTS ${idx.name} ON revoked_tokens \\(${idx.columns.join(', ')}\\)`)
    assert.ok(re.test(revokedSql), `索引定义必须逐字一致：${idx.name}`)
  }
})

test('② 与 runtime 定义逐字等价（规范化 public. 前缀）+ 形状契约一致', () => {
  // 锁表：CREATE 与逐列 ALTER 与 runtime 定义同形
  assert.ok(norm(lockSql).includes(norm(migrationLockDdl())), 'CREATE 语句必须与 migrationLockDdl() 逐字同形')
  for (const stmt of migrationLockUpgradeStatements()) {
    assert.ok(norm(lockSql).includes(norm(stmt)), `升级语句必须同形：${stmt.slice(0, 60)}…`)
  }
  // 形状契约（列/类型/非空/默认值）与 migration 中自证清单一致
  for (const c of LOCK_TABLE_SHAPE.columns) assert.ok(lockSql.includes(`('${c.name}'`), `锁表自证必须覆盖 ${c.name}`)
  for (const c of REVOKED_TOKENS_SHAPE.columns) assert.ok(revokedSql.includes(`('${c.name}'`), `吊销表自证必须覆盖 ${c.name}`)
  assert.ok(lockSql.includes("ARRAY['schema_name']"), '锁表主键自证 = schema_name')
  assert.ok(revokedSql.includes("ARRAY['jti']"), '吊销表主键自证 = jti')
  assert.equal(LOCK_TABLE_SHAPE.table, MIGRATION_LOCK_TABLE)
})

test('③ 运行时 DDL 已撤出（静态护栏；同一发布内 C2 生效）', () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const auth = stripComments(read('backend/middleware/authMiddleware.js'))
  const prov = stripComments(read('backend/lib/tenantProvisioner.js'))
  assert.ok(!/CREATE\s+(TABLE|INDEX)/i.test(auth), 'authMiddleware 不得再含 CREATE TABLE/INDEX（注释除外）')
  assert.ok(!/ALTER\s+TABLE/i.test(auth), 'authMiddleware 不得再含 ALTER TABLE（注释除外）')
  assert.ok(/AUTH_INFRA_MISSING/.test(auth), '认证侧必须以确定码 fail-closed')
  assert.ok(!/REVOKED_TOKENS_DDL/.test(auth), '历史运行时 DDL 常量必须删除')
  const assertFn = prov.slice(prov.indexOf('export async function assertTenantMigrationLockTableShape'), prov.indexOf('export function migrationLockTableShape'))
  assert.ok(!/\$executeRawUnsafe|\$executeRaw\b/.test(assertFn), '锁表形状断言不得执行任何写/DDL')
  assert.ok(/lockTableShapeIssues/.test(assertFn) && /LOCK_TABLE_SHAPE_MISMATCH/.test(assertFn), '断言函数必须调用只读探针并以确定码抛错')
  assert.ok(!/\$executeRawUnsafe\(\s*createSql|\$executeRawUnsafe\(\s*migrationLockDdl|\$executeRawUnsafe\(\s*migrationLockUpgrade/.test(prov), '产品路径不得执行锁表 CREATE/ALTER')
  const readLockFn = prov.slice(prov.indexOf('export async function readTenantMigrationLock'), prov.indexOf('export async function readTenantMigrationLock') + 900)
  assert.ok(/e\.code === LOCK_TABLE_SHAPE_MISMATCH\) throw e/.test(readLockFn), '形状不符不得被吞成"无锁"')
  // 等价定义保留但标注"不执行/同形对照"（注释在原始源码中，故用未剥离注释的文本检查）
  const provRaw = read('backend/lib/tenantProvisioner.js')
  assert.ok(/不再执行/.test(provRaw) && /同形对照/.test(provRaw))
})

test('③b @scope: public 协议对齐：catalog 自证语句不触发 TENANT_PROJECTION_UNCLASSIFIED（both 仍 fail-closed）', async () => {
  const { buildTenantProjection } = await import('../../lib/tenantProvisioner.js')
  const pubSql = '-- @scope: public\nCREATE TABLE IF NOT EXISTS revoked_tokens (jti text);\nDO $$\nBEGIN\n  PERFORM 1 FROM pg_class WHERE relname = \'x\';\nEND $$;\n'
  const proj = buildTenantProjection({ name: '20990101000001_pub_selfprove', sql: pubSql, checksum: 'x' })
  assert.equal(proj.scope, 'public')
  assert.equal(proj.kept, 0, 'public：租户侧零执行（整条跳过）')
  assert.equal(proj.skipped, 2, '两条语句全部登记为 skipped（含 catalog 自证块）')
  // 租户作用域（both）仍保持 fail-closed：不允许借 public 放宽
  assert.throws(
    () => buildTenantProjection({ name: '20990101000002_both_selfprove', sql: `-- @scope: both\nDO $$\nBEGIN\n  PERFORM 1 FROM pg_class WHERE relname = 'x';\nEND $$;\n`, checksum: 'x' }),
    (e) => e.code === 'TENANT_PROJECTION_UNCLASSIFIED',
    'both 作用域的 catalog 语句缺显式分类必须 fail-closed（不放宽）',
  )
})

test('④ 只读形状探针：缺表/错列/错默认值/缺索引/错列序/唯一索引 → 确定 issues（桩）', async () => {
  // 合规形状（锁表 + 吊销表）→ 无 issues
  const goodLock = stubPrisma({ columns: colRows(LOCK_TABLE_SHAPE), pk: [{ cols: ['schema_name'] }] })
  assert.deepEqual(await lockTableShapeIssues(goodLock), [])
  const goodRevoked = stubPrisma({
    columns: colRows(REVOKED_TOKENS_SHAPE), pk: [{ cols: ['jti'] }],
    indexes: REVOKED_TOKENS_INDEXES.map((i) => ({ name: i.name, is_unique: false, is_valid: true, is_ready: true, method: 'btree', is_partial: false, expr_cols: 0, cols: [...i.columns] })),
  })
  assert.deepEqual(await revokedTokensShapeIssues(goodRevoked), [])
  const good = await publicInfraShapeReport({ async $queryRawUnsafe(sql, table) {
    return table === MIGRATION_LOCK_TABLE ? goodLock.$queryRawUnsafe(sql) : goodRevoked.$queryRawUnsafe(sql)
  } })
  assert.equal(good.ok, true)
  // 缺表
  assert.deepEqual(await lockTableShapeIssues(stubPrisma({ columns: [] })), [`table-missing:public.${MIGRATION_LOCK_TABLE}`])
  assert.deepEqual(await revokedTokensShapeIssues(stubPrisma({ columns: [] })), ['table-missing:public.revoked_tokens'])
  // 错列（缺列 / 类型不符 / 非空不符 / 默认值不符 / 额外列）
  const badCols = colRows(LOCK_TABLE_SHAPE).filter((c) => c.name !== 'pid')
  badCols.find((c) => c.name === 'fencing_token').type = 'integer'
  badCols.find((c) => c.name === 'hostname').not_null = true
  badCols.find((c) => c.name === 'heartbeat_at').default_expr = null
  badCols.push({ name: 'extra_col', type: 'text', not_null: false, default_expr: null })
  const issues = await lockTableShapeIssues(stubPrisma({ columns: badCols, pk: [{ cols: ['schema_name'] }] }))
  for (const want of ['column-missing:pid', 'column-type:fencing_token', 'column-notnull:hostname', 'column-default:heartbeat_at', 'column-extra:extra_col']) {
    assert.ok(issues.some((i) => i.startsWith(want)), `应报告 ${want}*，实际：${issues.join('；')}`)
  }
  // 主键不符
  const pkIssues = await lockTableShapeIssues(stubPrisma({ columns: colRows(LOCK_TABLE_SHAPE), pk: [{ cols: ['owner'] }] }))
  assert.ok(pkIssues.some((i) => /^primary-key/.test(i)))
  // 缺索引 / 错列序 / 唯一索引
  const idxIssues = await revokedTokensShapeIssues(stubPrisma({
    columns: colRows(REVOKED_TOKENS_SHAPE), pk: [{ cols: ['jti'] }],
    indexes: [
      { name: 'revoked_tokens_expires_at_idx', is_unique: false, cols: ['expires_at'] },
      { name: 'revoked_tokens_user_idx', is_unique: false, cols: ['user_id', 'revoked_at', 'token_type'] }, // 列序错
      { name: 'revoked_tokens_school_epoch_idx', is_unique: true, cols: ['school_code', 'token_type', 'revoked_at'] }, // 唯一（错）
    ],
  }))
  assert.ok(idxIssues.some((i) => /index-columns:revoked_tokens_user_idx/.test(i)), `列序错必须报告：${idxIssues.join('；')}`)
  assert.ok(idxIssues.some((i) => /index-unique:revoked_tokens_school_epoch_idx/.test(i)), `唯一索引必须报告：${idxIssues.join('；')}`)
  // P3-PUBLIC-INFRA-FOLLOWUP-R1：可用性/形态负例（indisvalid / indisready / 方法 / 谓词 / 表达式）
  const negStub = (patch) => stubPrisma({
    columns: colRows(REVOKED_TOKENS_SHAPE), pk: [{ cols: ['jti'] }],
    indexes: REVOKED_TOKENS_INDEXES.map((i) => ({ name: i.name, is_unique: false, is_valid: true, is_ready: true, method: 'btree', is_partial: false, expr_cols: 0, cols: [...i.columns], ...(i.name === 'revoked_tokens_expires_at_idx' ? patch : {}) })),
  })
  const ivIssues = await revokedTokensShapeIssues(negStub({ is_valid: false }))
  assert.ok(ivIssues.some((i) => /index-invalid:revoked_tokens_expires_at_idx/.test(i)), `indisvalid=false 必须报告：${ivIssues.join('；')}`)
  const irIssues = await revokedTokensShapeIssues(negStub({ is_ready: false }))
  assert.ok(irIssues.some((i) => /index-not-ready:revoked_tokens_expires_at_idx/.test(i)), `indisready=false 必须报告：${irIssues.join('；')}`)
  const mIssues = await revokedTokensShapeIssues(negStub({ method: 'hash' }))
  assert.ok(mIssues.some((i) => /index-method:revoked_tokens_expires_at_idx/.test(i)), `方法不符必须报告：${mIssues.join('；')}`)
  const pIssues = await revokedTokensShapeIssues(negStub({ is_partial: true }))
  assert.ok(pIssues.some((i) => /index-partial:revoked_tokens_expires_at_idx/.test(i)), `谓词索引必须报告：${pIssues.join('；')}`)
  const eIssues = await revokedTokensShapeIssues(negStub({ expr_cols: 1 }))
  assert.ok(eIssues.some((i) => /index-expression:revoked_tokens_expires_at_idx/.test(i)), `表达式索引必须报告：${eIssues.join('；')}`)
  // 桩缺字段（旧形态）→ 视为 unknown 并拒绝（不得静默通过）
  const unknownIssues = await revokedTokensShapeIssues(stubPrisma({
    columns: colRows(REVOKED_TOKENS_SHAPE), pk: [{ cols: ['jti'] }],
    indexes: REVOKED_TOKENS_INDEXES.map((i) => ({ name: i.name, is_unique: false, cols: [...i.columns] })),
  }))
  assert.ok(unknownIssues.some((i) => /index-invalid:revoked_tokens_expires_at_idx\(indisvalid=unknown\)/.test(i)), `缺可用性字段必须 fail-closed：${unknownIssues.join('；')}`)
  // 聚合报告：前缀 + 确定码（两设施都缺表）
  const agg = await publicInfraShapeReport({ async $queryRawUnsafe() { return [] } })
  assert.equal(agg.ok, false)
  assert.equal(agg.code, PUBLIC_INFRA_SHAPE_MISMATCH)
  assert.ok(agg.issues.every((i) => /^(_tenant_migration_locks|revoked_tokens):/.test(i)))
})

test('⑤ baseline_pending = 正式已知非终态：确定码上报且仍阻断（桩台账）', async () => {
  const chain = chainManifest() // 用 checksum（listMigrationFiles 只有 name/file/bytes）
  const rows = chain.map((f) => ({ migration_name: f.name, checksum: f.checksum, status: 'applied', started_at: new Date(), finished_at: new Date(), projection_sha256: null, skipped_sweeps: 0, chain_digest: 'x', detail: null }))
  rows[0] = { ...rows[0], status: 'baseline_pending', finished_at: null, detail: ';baseline_postcheck=FAILED@t' }
  const prisma = {
    async $queryRawUnsafe(sql, schema, table) {
      if (/information_schema\.tables/.test(sql)) return [{ '?column?': 1 }]
      if (/_tenant_migrations/.test(sql)) return rows
      throw new Error(`stub: 未预期 SQL ${String(sql).slice(0, 50)}`)
    },
  }
  const proof = await readTenantMigrationProof(prisma, 'school_x')
  assert.equal(proof.baselinePending, 1, 'baseline_pending 必须单独计数')
  assert.equal(proof.nonTerminal[0].name, rows[0].migration_name)
  assert.equal(proof.status, 'TENANT_MIGRATIONS_PENDING', '非终态 → 仍阻断（pending）')
  assert.ok(!proof.unknownStatuses.some((u) => u.status === 'baseline_pending'), '不得混入 unknownStatuses（否则是"未知状态"兜底）')
  assert.ok(LEDGER_NON_TERMINAL_STATUS.has('baseline_pending'))
  assert.ok(PUBLIC_TRAFFIC_BLOCKING_STATUS.has(PUBLIC_INFRA_SHAPE_MISMATCH), '形状不符必须阻断租户流量')
  const sync = read('backend/lib/tenantSync.js')
  assert.ok(/publicInfraShapeReport/.test(sync) && /PUBLIC_INFRA_SHAPE_MISMATCH/.test(sync), '检查侧必须接入形状闸门')
  assert.ok(/TENANT_BASELINE_PENDING/.test(sync), '--check 必须给已知非终态确定码')
})

test('⑥ 认证侧契约：AUTH_INFRA_MISSING 与吊销形状同源；缺表/缺索引即为该码', async () => {
  assert.equal(AUTH_INFRA_MISSING, 'AUTH_INFRA_MISSING')
  assert.deepEqual(await revokedTokensShapeIssues(stubPrisma({ columns: [] })), ['table-missing:public.revoked_tokens'])
  const missingIdx = await revokedTokensShapeIssues(stubPrisma({
    columns: colRows(REVOKED_TOKENS_SHAPE), pk: [{ cols: ['jti'] }],
    indexes: REVOKED_TOKENS_INDEXES.slice(0, 2).map((i) => ({ name: i.name, is_unique: false, is_valid: true, is_ready: true, method: 'btree', is_partial: false, expr_cols: 0, cols: [...i.columns] })),
  }))
  assert.deepEqual(missingIdx, ['index-missing:revoked_tokens_school_epoch_idx'])
  const { assertRevocationInfra } = await import('../../middleware/authMiddleware.js')
  await assert.rejects(() => assertRevocationInfra(stubPrisma({ columns: [] })), (e) => e.code === AUTH_INFRA_MISSING && e.runtimeDdlWithdrawn === true)
  await assert.doesNotReject(() => assertRevocationInfra(stubPrisma({
    columns: colRows(REVOKED_TOKENS_SHAPE), pk: [{ cols: ['jti'] }],
    indexes: REVOKED_TOKENS_INDEXES.map((i) => ({ name: i.name, is_unique: false, is_valid: true, is_ready: true, method: 'btree', is_partial: false, expr_cols: 0, cols: [...i.columns] })),
  })))
})
