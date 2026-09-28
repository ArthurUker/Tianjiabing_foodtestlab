// P3-FIXTURE-MIGRATED-R2 · fixture 单测（离线；无 PG、无网络）
// 覆盖："吊销表/三索引的事实源 = 链尾 `-- @scope: public` migration + backend/lib/publicInfraShape.js 只读契约"
//   —— 旧运行时 DDL 常量（authMiddleware.REVOKED_TOKENS_DDL）已随公共链删除；fixture 不得补建产品设施。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const provision = require(path.join(repoRoot, 'tests/isolation/provision.cjs'))

const publicInfraShape = () => import(path.join(repoRoot, 'backend', 'lib', 'publicInfraShape.js'))

// 只读 stub：按 SQL 形态回答台账 / 列 / 主键 / 索引
const stubClient = ({ ledger, cols, idx, pk = ['jti'] }) => ({
  $queryRawUnsafe: async (sql) => {
    if (/_prisma_migrations/.test(sql)) return ledger
    if (/pg_attribute/.test(sql) && /ORDER BY a\.attnum/.test(sql)) return cols
    if (/array_agg/.test(sql) && /indisprimary/.test(sql)) return [{ cols: pk }]
    if (/indisvalid/.test(sql)) return idx
    return []
  },
})
const goodCols = (shape) => shape.columns.map((c) => ({ name: c.name, type: c.type, not_null: c.notNull, default_expr: c.defaultExpr }))
const goodIdx = (indexes) => indexes.map((i) => ({ name: i.name, is_unique: false, cols: [...i.columns], is_valid: true, is_ready: true, method: 'btree', is_partial: false }))

test('① 链上 public 基础设施文件可枚举（含 @scope: public 的 public_infra_* 两条）', () => {
  const files = provision.publicInfraChainFiles().map((f) => f.name)
  assert.ok(files.includes('20260926120000_public_infra_tenant_migration_locks'), JSON.stringify(files))
  assert.ok(files.includes('20260926120100_public_infra_revoked_tokens'), JSON.stringify(files))
  for (const f of provision.publicInfraChainFiles()) assert.match(f.checksum, /^[0-9a-f]{64}$/)
})

test('② 旧运行时 DDL 依赖已彻底移除（无可执行引用 / 无旧 API / 无补建语句）', () => {
  assert.equal(provision.runtimeRevokedTokensDdl, undefined)
  assert.equal(provision.productRevocationDdlSource, undefined)
  assert.equal(provision.assertRuntimeRevocationDdlInSync, undefined)
  assert.equal(provision.assertRevocationInfraShape, undefined)
  const src = require('node:fs').readFileSync(path.join(repoRoot, 'tests/isolation/provision.cjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.doesNotMatch(src, /REVOKED_TOKENS_DDL/)
  assert.doesNotMatch(src, /CREATE TABLE[^;]{0,80}revoked_tokens/i)
  assert.doesNotMatch(src, /CREATE (UNIQUE )?INDEX[^;]{0,80}revoked_tokens/i)
})

test('③ 缺 shapeFn → E_SHAPE_FN_REQUIRED（fail-closed，不静默跳过形状核对）', async () => {
  await assert.rejects(
    () => provision.revocationShapeIssues({ client: stubClient({ ledger: [], cols: [], idx: [] }) }),
    (e) => e.code === 'E_SHAPE_FN_REQUIRED')
})

test('④ 链上 migration 未应用/checksum 不一致 → 拒绝（测试准备阶段不补建）', async () => {
  const mod = await publicInfraShape()
  const shapeFn = (c) => mod.revokedTokensShapeIssues(c)
  const files = provision.publicInfraChainFiles()
  // 缺一条
  await assert.rejects(
    () => provision.assertRevocationInfraFromChain({
      client: stubClient({ ledger: files.slice(1).map((f) => ({ migration_name: f.name, checksum: f.checksum, finished_at: 'x' })), cols: goodCols(mod.REVOKED_TOKENS_SHAPE), idx: goodIdx(mod.REVOKED_TOKENS_INDEXES) }),
      shapeFn,
    }),
    (e) => e.code === 'E_PUBLIC_INFRA_MIGRATION_NOT_APPLIED')
  // checksum 漂移
  await assert.rejects(
    () => provision.assertRevocationInfraFromChain({
      client: stubClient({ ledger: files.map((f) => ({ migration_name: f.name, checksum: 'deadbeef'.repeat(8), finished_at: 'x' })), cols: goodCols(mod.REVOKED_TOKENS_SHAPE), idx: goodIdx(mod.REVOKED_TOKENS_INDEXES) }),
      shapeFn,
    }),
    (e) => e.code === 'E_PUBLIC_INFRA_MIGRATION_NOT_APPLIED')
})

test('⑤ 形状违规（缺列/缺索引）→ E_PUBLIC_INFRA_SHAPE；合规 → ok', async () => {
  const mod = await publicInfraShape()
  const shapeFn = (c) => mod.revokedTokensShapeIssues(c)
  const ledger = provision.publicInfraChainFiles().map((f) => ({ migration_name: f.name, checksum: f.checksum, finished_at: 'x' }))
  const okRes = await provision.assertRevocationInfraFromChain({
    client: stubClient({ ledger, cols: goodCols(mod.REVOKED_TOKENS_SHAPE), idx: goodIdx(mod.REVOKED_TOKENS_INDEXES) }), shapeFn,
  })
  assert.equal(okRes.ok, true)
  assert.equal(okRes.shapeChecked, true)
  assert.equal(okRes.shape.ok, true)
  await assert.rejects(
    () => provision.assertRevocationInfraFromChain({
      client: stubClient({
        ledger,
        cols: goodCols(mod.REVOKED_TOKENS_SHAPE).filter((c) => c.name !== 'expires_at'),
        idx: goodIdx(mod.REVOKED_TOKENS_INDEXES).filter((i) => i.name !== 'revoked_tokens_user_idx'),
      }), shapeFn,
    }),
    (e) => e.code === 'E_PUBLIC_INFRA_SHAPE' && /column-missing:expires_at/.test(e.message) && /index-missing:revoked_tokens_user_idx/.test(e.message))
})

test('⑥ 不传 shapeFn 时只做链上 migration 核对（shapeChecked=false，诚实留痕）', async () => {
  const ledger = provision.publicInfraChainFiles().map((f) => ({ migration_name: f.name, checksum: f.checksum, finished_at: 'x' }))
  const res = await provision.assertRevocationInfraFromChain({ client: stubClient({ ledger, cols: [], idx: [] }) })
  assert.equal(res.ok, true)
  assert.equal(res.shapeChecked, false)
})

test('⑦ 产品契约是只读的（无 DDL），且 fixture 侧无动态 import（Jest CJS VM 约束）', () => {
  const shapeSrc = require('node:fs').readFileSync(path.join(repoRoot, 'backend', 'lib', 'publicInfraShape.js'), 'utf8')
  const code = shapeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.doesNotMatch(code, /\b(CREATE TABLE|ALTER TABLE|CREATE INDEX|DROP TABLE)\b/i)
  const provSrc = require('node:fs').readFileSync(path.join(repoRoot, 'tests/isolation', 'provision.cjs'), 'utf8')
  assert.doesNotMatch(provSrc, /await import\(/)   // 动态 import ESM 在 Jest CJS VM 下会 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG
})
