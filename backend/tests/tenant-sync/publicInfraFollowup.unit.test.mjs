// P3-PUBLIC-INFRA-FOLLOWUP-R1（R10 §接力裁决 2）：历史 FieldOption FK 跨 schema 误判的
//   前向修复契约 + 旧 13 文件字节不变 + public-only/租户失败两分支口径区分。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { listMigrationFiles, chainManifest, migrationChainDigest, buildTenantProjection } from '../../lib/tenantProvisioner.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8')
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(repoRoot, p))).digest('hex')

const FOLLOWUP_MIG = '20260927120000_public_infra_field_option_self_fk'
// P3-PUBLIC-INFRA-TESTS-R2（R17 B-6）：历史位置证明 —— 前向修复**固定第 14 位**；M1/M2（窗口 3）只追加其后（当前链尾 = M2）。
const M1_MIG = '20260927130000_lifecycle_audit_principal_expand'
const M2_MIG = '20260927140000_lifecycle_audit_principal_enforce'
// P3-FRIENDLY-LINKS（2026-09-28）：友情链接表（`@scope: both`）追加为当前链尾（第 17 位）
const FL_MIG = '20260928120000_friendly_links'
const FOLLOWUP_SQL_PATH = `backend/prisma/migrations/${FOLLOWUP_MIG}/migration.sql`
const followupSql = read(FOLLOWUP_SQL_PATH)
/** SQL 主体（剥掉 `--` 行注释；头部注释里会引用历史缺陷写法，判据只看可执行语句）。 */
const followupBody = followupSql.replace(/--[^\n]*/g, '')
const SRC = read('backend/lib/tenantProvisioner.js')

test('① 前向修复 migration：固定第 14 位（其后仅 M1/M2 追加）+ @scope: public + 按目标 schema 精确判别 + 幂等 + 不破坏性', () => {
  const files = listMigrationFiles()
  // 历史位置证明：第 14 位（0 基索引 13）；其后只能追加时间戳更大的迁移（当前 = M1/M2 + 友情链接）
  assert.equal(files[13].name, FOLLOWUP_MIG, '前向修复必须固定在第 14 位（不得再被认作"当前链尾"）')
  const after = files.slice(14).map((m) => m.name)
  assert.deepEqual(after, [M1_MIG, M2_MIG, FL_MIG], '第 14 位之后只追加 M1/M2 + 友情链接（追加式）')
  assert.ok(after.every((n) => n > FOLLOWUP_MIG), '追加式：其后文件名（时间戳序）必须晚于前向修复')
  assert.ok(/^\s*--\s*@scope:\s*public\s*$/m.test(followupSql), '必须显式 @scope: public（逐租户整条跳过）')
  assert.ok(!/@scope:\s*both/.test(followupSql), '不得声明 both（不得进租户投影）')
  // 精确判别：存在性查询必须**同时**限定 schema + 表 + 约束类型（历史缺陷 = 只查 conname）
  assert.ok(/n\.nspname\s*=\s*tgt/.test(followupSql) && /t\.relname\s*=\s*'FieldOption'/.test(followupSql) && /con\.contype\s*=\s*'f'/.test(followupSql), '存在性判别必须限定 nspname+relname+contype')
  assert.ok(!/pg_constraint WHERE conname = 'FieldOption_parent_option_id_fkey'/.test(followupBody), '不得复现历史未限定 schema 的守卫写法')
  // 幂等：缺失才建；重复 >1 → fail-closed；不自动 DROP/重建他人约束
  assert.ok(/IF cnt = 0 THEN/.test(followupSql) && /ADD CONSTRAINT "FieldOption_parent_option_id_fkey"/.test(followupSql), '缺失必须补齐（幂等 ADD CONSTRAINT）')
  assert.ok(/ELSIF cnt > 1 THEN/.test(followupSql) && /RAISE EXCEPTION 'PUBLIC_INFRA_FIELDOPTION_FK_SHAPE_MISMATCH: duplicate-constraints/.test(followupSql), '重复约束必须 fail-closed')
  // 形状自证：自引用 + validated + 定义规范化匹配 + cascade 双 clause
  assert.ok(/con\.convalidated AND con\.conrelid = con\.confrelid/.test(followupSql), '自证必须检查自引用与已验证')
  assert.ok(/regexp_replace\(pg_get_constraintdef/.test(followupSql) && /ON UPDATE CASCADE/.test(followupSql) && /ON DELETE CASCADE/.test(followupSql), '定义匹配必须规范化并含双向 cascade')
  assert.ok(/RAISE EXCEPTION 'PUBLIC_INFRA_FIELDOPTION_FK_SHAPE_MISMATCH: cascade-missing/.test(followupSql), '定义不符必须 fail-closed')
  assert.ok(!/\bDROP\b|DELETE FROM|TRUNCATE/.test(followupBody), '不得包含破坏性语句（DROP/DELETE/TRUNCATE）')
})

test('② 旧 13 文件逐字节/位次未改（对照仓内精简校验基准）+ 第 14 位 + 链 = 17（产品 chainManifest/digest 交叉核对）', () => {
  const lock = JSON.parse(read('backend/tests/tenant-sync/fixtures/legacy-chain-13.lock.json'))
  assert.equal(lock.chain_files.length, 13, '锁文件应固定旧 13 文件')
  for (const f of lock.chain_files) {
    assert.equal(sha256(`backend/prisma/migrations/${f.name}/migration.sql`), f.checksum, `${f.name} 必须与链尾锁 checksum 一致（前向修复不得改动已应用 migration）`)
  }
  const files = listMigrationFiles()
  // 旧 13 的**位次/顺序**也不得漂移（前 13 位逐项同名同序）
  assert.deepEqual(files.slice(0, 13).map((m) => m.name), lock.chain_files.map((f) => f.name), '旧 13 位次/顺序不得漂移')
  assert.equal(files.length, lock.chain_files.length + 4, '链 = 旧 13 + 前向修复 1（第 14 位）+ M1/M2（第 15/16 位）+ 友情链接（第 17 位）')
  assert.equal(files[13].name, FOLLOWUP_MIG, '第 14 位 = 前向修复（非链尾）')
  assert.deepEqual(files.slice(14).map((m) => m.name), [M1_MIG, M2_MIG, FL_MIG], '第 15/16/17 位 = M1/M2 + 友情链接')
  // 产品视角交叉核对：chainManifest 与磁盘清单逐项一致 + digest 可按规范独立重算（name\0内容\n 串联）
  const manifest = chainManifest()
  assert.deepEqual(manifest.map((m) => m.name), files.map((m) => m.name), 'chainManifest 与磁盘清单逐项一致（名称/顺序/长度）')
  assert.equal(manifest.length, 17, '当前总链 = 17')
  const h = crypto.createHash('sha256')
  for (const m of files) h.update(`${m.name}\0${read(`backend/prisma/migrations/${m.name}/migration.sql`)}\n`)
  assert.equal(migrationChainDigest(), h.digest('hex'), '产品 digest = 独立重算（规范：每文件 `${name}\\0${内容}\\n` 串联的 sha256）')
})

test('③ public-only 投影整条跳过，不能把后续 both 迁移也跳过', () => {
  const files = listMigrationFiles()
  const publicOnly = files[13]
  const both = files[14]
  const publicProjection = buildTenantProjection({ ...publicOnly, sql: read(`backend/prisma/migrations/${publicOnly.name}/migration.sql`) })
  const bothProjection = buildTenantProjection({ ...both, sql: read(`backend/prisma/migrations/${both.name}/migration.sql`) })
  assert.equal(publicProjection.scope, 'public')
  assert.equal(publicProjection.kept, 0)
  assert.ok(publicProjection.skipped > 0)
  assert.equal(bothProjection.scope, 'both')
  assert.ok(bothProjection.kept > 0)
})

test('④ 口径区分（静态）：public-only 跳过批失败无失败写入；租户迁移失败经 guard + 诚实上报并保锁', () => {
  // public-only 跳过批：受同一 guard 保护，但**不**调用 recordTenantFailureRow（零失败写入）
  const skipStart = SRC.indexOf("if (projection.scope === 'public')")
  assert.ok(skipStart > 0, '必须存在 scope=public 跳过分支')
  const skipBlock = SRC.slice(skipStart, SRC.indexOf('\n      const shim = [', skipStart))
  assert.ok(/skipped_public_only/.test(skipBlock) && /guardFor\(\)/.test(skipBlock), '跳过批必须写 skipped_public_only 且受 guard 保护')
  assert.ok(!/recordTenantFailureRow/.test(skipBlock) && !/'failed'/.test(skipBlock), '跳过批不得有失败写入路径（前置互斥失败 ≠ 已记 failed）')
  // 租户迁移失败：统一失败分支经 recordTenantFailureRow（guard + 写后核对）；写不入 → 保锁待复核 + 诚实文案
  const failStart = SRC.indexOf('const recorded = await recordTenantFailureRow({')
  assert.ok(failStart > 0, '必须存在统一失败记录分支')
  const failBlock = SRC.slice(failStart, failStart + 900)
  assert.ok(/baseInsert\('failed', detail\)/.test(failBlock), '失败写入必须落 failed 行')
  assert.ok(/if \(!recorded\.ok\) holdLockForReview = true/.test(failBlock), '写不入必须保锁待人工复核')
  assert.ok(/失败状态未能记入台账/.test(failBlock) && /已记入台账 failed/.test(failBlock), '必须同时具备"诚实上报"与"成功记录"两条文案（按 recorded.ok 区分）')
})
