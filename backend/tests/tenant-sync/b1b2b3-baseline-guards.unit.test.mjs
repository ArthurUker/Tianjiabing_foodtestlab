// P3-B1B2B3 定点单元测试（**离线；不需要 PG**；由 `npm run test:backend` 覆盖，0 skip）
//
// 判别目标（对应生产升级阻塞 B1–B3）：
//   B1 缺契约表：`buildBaselineProof()` **仍产出完整证明**（不崩溃）——
//       · 缺失表 → `tables.contract.present=false`；其上的 NOT NULL / 外键 / 唯一索引扫描
//         **绝不查询不存在的表**（本测试把"查询缺失表"建模为 PG 42P01 抛出，一旦查询即失败）；
//       · 未扫描项必须显式记 `data.semantics=false`（不得算通过）；
//       · 全程只读（仅 SELECT），零建表/零台账写入。
//   B2 目标解析：`--baseline-plan/--baseline-apply` 只接受 `School.code`；
//       schema 形态（`school_zhsy`）必须清楚拒绝、正确示例 `zhsy` 必须寻址 `school_zhsy`；
//       staging schema 不得给出无法执行的正式学校命令。
//   B3 唯一索引真实语义：NULLS DISTINCT 的 NULL 组不报重复（单列/复合）、
//       NULLS NOT DISTINCT 纳入 NULL、部分索引带谓词、表达式索引按键表达式；
//       无效/未就绪索引、键表达式不可读、扫描失败 → 记"未证明"（fail-closed）。
//   不退化：完整干净 schema 的证明必须仍然通过（不得因加固而误伤）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBaselineProof, interpretBaselineTargetArg, resolveBaselineSchoolTarget,
  baselineAdmissionGuidance, isRestoreStagingSchema, schoolCodeFromSchema, readExpectedTenantTables,
} from '../../lib/tenantProvisioner.js'

// ───────────────────────── 假 Prisma（只按 SQL 形状应答；未知查询即失败） ─────────────────────────

// 契约表事实源 = schema.prisma（与 buildBaselineProof 同源）：完整模型 → "干净 schema 不退化" 用例才有意义
const EXPECTED_TABLES = [...readExpectedTenantTables().tables]

/**
 * @param {object} spec
 *   pgVersion  默认 140023（PG14：无 NULLS NOT DISTINCT 列）
 *   cols       { [schema]: Array<{table_name,column_name,data_type,udt_name,is_nullable,column_default}> }
 *   cons       { [schema]: Array<{table_name,contype,validated,def}> }
 *   idx        { [schema]: Array<{table_name,index_name,is_unique,is_valid,is_ready,nulls_not_distinct,predicate,keys,def}> }
 *   baseTables { [schema]: string[] }          ← 不在此清单中的表被查询 → 42P01（模拟 PG）
 *   unknown    { [schema]: Array<{kind,name}> }
 *   dupCount   (sql, schema, tableName) => number  （默认 0）
 */
function makeFakePrisma(spec) {
  const queries = []
  const baseTables = spec.baseTables || {}
  const tableOf = (sql) => {
    const m = String(sql).match(/"([A-Za-z0-9_]+)"\."([A-Za-z0-9_]+)"/) || String(sql).match(/"([A-Za-z0-9_]+)"/)
    return m ? m[2] || m[1] : null
  }
  const ensureTable = (sql, schema) => {
    const t = tableOf(sql)
    if (!t) return
    if (!(baseTables[schema] || []).includes(t)) {
      const e = new Error(`relation "${schema}.${t}" does not exist`)
      e.code = '42P01'
      throw e
    }
  }
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      const s = String(sql)
      queries.push({ sql: s, args })
      if (/server_version_num/.test(s)) return [{ v: spec.pgVersion ?? 140023 }]
      const sch = (args && args[0]) || (s.match(/"([A-Za-z0-9_]+)"\./)?.[1] ?? null)
      if (/FROM information_schema\.columns/.test(s)) return spec.cols?.[sch] || []
      if (/FROM pg_constraint/.test(s)) return spec.cons?.[sch] || []
      if (/FROM pg_index/.test(s)) return spec.idx?.[sch] || []
      if (/'view' AS kind/.test(s)) return spec.unknown?.[sch] || []
      if (/FROM information_schema\.tables/.test(s)) return (baseTables[sch] || []).map((t) => ({ table_name: t }))
      if (/HAVING count\(\*\) > 1/.test(s)) { ensureTable(s, sch); return [{ n: spec.dupCount ? spec.dupCount(s, sch, tableOf(s)) : 0 }] }
      if (/LEFT JOIN/.test(s)) { ensureTable(s, sch); return [{ n: 0 }] }
      if (/IS NULL\s*$/.test(s.trim())) { ensureTable(s, sch); return [{ n: 0 }] }
      throw new Error(`未预期的查询（测试桩需扩展）: ${s.slice(0, 140)}`)
    },
  }
  return { prisma, queries }
}

const col = (table_name, column_name, is_nullable = 'NO') => ({
  table_name, column_name, data_type: 'text', udt_name: 'text', is_nullable, column_default: null,
})
const idx = (o) => ({
  table_name: 'User', index_name: 'User_email_key', is_unique: true, is_valid: true, is_ready: true,
  nulls_not_distinct: false, predicate: null, keys: ['email'], def: 'CREATE UNIQUE INDEX "User_email_key" ON "User" USING btree (email)', ...o,
})
const allChecks = (proof) => Object.fromEntries(proof.checks.map((c) => [c.id, c.ok]))
const onlySelect = (queries) => queries.every((q) => /^\s*SELECT/i.test(q.sql))
const sqlTouching = (queries, re) => queries.filter((q) => re.test(q.sql)).map((q) => q.sql)

/** 完整、干净的双 schema 模型（证明应当通过） */
function cleanSpec(overrides = {}) {
  const cols = {}
  const cons = {}
  const idxRows = {}
  const base = {}
  for (const sch of ['public', 'school_ok']) {
    cols[sch] = EXPECTED_TABLES.flatMap((t) => [col(t, 'id'), col(t, 'email', 'YES')])
    cons[sch] = [{ table_name: 'User', contype: 'p', validated: true, def: 'PRIMARY KEY (id)' }]
    idxRows[sch] = [idx({})]
    base[sch] = [...EXPECTED_TABLES]
  }
  return { cols, cons, idx: idxRows, baseTables: base, unknown: {}, ...overrides }
}

// ─────────────────────────────────── B1 ───────────────────────────────────

test('B1：缺契约表不崩溃——产出完整计划、缺失表与未扫描项显式不通过、零写入', async () => {
  const spec = cleanSpec()
  // 租户缺 AuditPrincipal（= 生产旧 schema 的真实形态）；public 有
  spec.baseTables.school_ok = EXPECTED_TABLES.filter((t) => t !== 'AuditPrincipal')
  spec.cols.school_ok = spec.cols.school_ok.filter((c) => c.table_name !== 'AuditPrincipal')
  spec.idx.school_ok = [idx({}), idx({ table_name: 'AuditPrincipal', index_name: 'AuditPrincipal_scope_key', keys: ['scope_key', 'subject_user_id'] })]
  spec.cons.school_ok = [...spec.cons.school_ok, { table_name: 'AuditLog', contype: 'f', validated: true, def: 'FOREIGN KEY (principal_id) REFERENCES AuditPrincipal(id)' }]
  const { prisma, queries } = makeFakePrisma(spec)

  const proof = await buildBaselineProof({ prisma, schema: 'school_ok', referenceSchema: 'public' })

  assert.equal(proof.ok, false, '缺表时必须 proofOk=false')
  const checks = allChecks(proof)
  assert.equal(checks['tables.contract.present'], false, '缺失契约表必须显式不通过')
  assert.equal(checks['data.semantics'], false, '未扫描的数据语义不得算通过')
  // 关键：**绝不查询不存在的表**（桩会把这类查询抛成 42P01）
  assert.equal(sqlTouching(queries, /"school_ok"\."AuditPrincipal"/).length, 0, '不得查询租户不存在的表')
  assert.ok(onlySelect(queries), '证明必须全程只读（仅 SELECT）')
  assert.ok(queries.length > 0 && !queries.some((q) => /INSERT|UPDATE|DELETE|CREATE|ALTER|DROP/i.test(q.sql)), '证明不得含任何写语句')
  assert.match(proof.checks.find((c) => c.id === 'tables.contract.present').detail, /AuditPrincipal/)
  assert.match(proof.checks.find((c) => c.id === 'data.semantics').detail, /未扫描|未证明/)
})

test('B1：完整干净 schema 的证明结果不退化（全部通过）', async () => {
  const { prisma, queries } = makeFakePrisma(cleanSpec())
  const proof = await buildBaselineProof({ prisma, schema: 'school_ok', referenceSchema: 'public' })
  assert.equal(proof.ok, true, `完整 schema 必须通过；未通过项=${JSON.stringify(proof.checks.filter((c) => !c.ok))}`)
  assert.ok(proof.proofDigest && proof.proofDigest.length === 64)
  assert.ok(onlySelect(queries))
})

// ─────────────────────────────────── B3 ───────────────────────────────────

test('B3：普通 UNIQUE（NULLS DISTINCT）单列——含 NULL 的键组不得报重复', async () => {
  const spec = cleanSpec()
  spec.baseTables.school_ok = [...EXPECTED_TABLES]
  const { prisma, queries } = makeFakePrisma(spec)
  const proof = await buildBaselineProof({ prisma, schema: 'school_ok', referenceSchema: 'public' })
  const dupSql = sqlTouching(queries, /HAVING count\(\*\) > 1/)
  assert.equal(dupSql.length, 1, '存在一个唯一索引 → 恰好一次重复扫描')
  assert.match(dupSql[0], /\(email\) IS NOT NULL/, 'NULLS DISTINCT 必须排除含 NULL 的键组')
  assert.equal(allChecks(proof)['data.semantics'], true, 'NULL 不应被误报为重复')
})

test('B3：复合唯一键——任一键列为 NULL 的组不报重复；全非空冲突仍拒绝', async () => {
  const spec = cleanSpec()
  spec.idx.school_ok = [idx({ index_name: 'User_org_email_key', keys: ['org_id', 'email'] })]
  spec.idx.public = spec.idx.school_ok
  const { prisma, queries } = makeFakePrisma(spec)
  let proof = await buildBaselineProof({ prisma, schema: 'school_ok', referenceSchema: 'public' })
  const sql1 = sqlTouching(queries, /HAVING count\(\*\) > 1/)[0]
  assert.match(sql1, /\(org_id\) IS NOT NULL AND \(email\) IS NOT NULL/, '复合键必须逐列排除 NULL')
  assert.equal(allChecks(proof)['data.semantics'], true)

  // 非 NULL 冲突（真实重复）→ 必须拒绝
  const spec2 = cleanSpec()
  spec2.dupCount = () => 1
  const { prisma: p2 } = makeFakePrisma(spec2)
  proof = await buildBaselineProof({ prisma: p2, schema: 'school_ok', referenceSchema: 'public' })
  assert.equal(allChecks(proof)['data.semantics'], false, '真实重复值必须不通过')
})

test('B3：NULLS NOT DISTINCT 必须纳入 NULL（不得盲目排除）', async () => {
  const spec = cleanSpec()
  spec.idx.school_ok = [idx({ nulls_not_distinct: true })]
  spec.idx.public = spec.idx.school_ok
  spec.dupCount = () => 1 // 模拟 NULL 组重复（NULLS NOT DISTINCT 下是真实冲突）
  const { prisma, queries } = makeFakePrisma(spec)
  const proof = await buildBaselineProof({ prisma, schema: 'school_ok', referenceSchema: 'public' })
  const sql = sqlTouching(queries, /HAVING count\(\*\) > 1/)[0]
  assert.doesNotMatch(sql, /IS NOT NULL/, 'NULLS NOT DISTINCT 不得加 IS NOT NULL 过滤')
  assert.match(sql, /WHERE TRUE AND TRUE/)
  assert.equal(allChecks(proof)['data.semantics'], false, 'NULLS NOT DISTINCT 的 NULL 重复必须不通过')
})

test('B3：部分索引按谓词限定；表达式索引按键表达式（不再静默跳过）', async () => {
  const spec = cleanSpec()
  spec.idx.school_ok = [idx({ index_name: 'User_active_email_key', predicate: 'deleted_at IS NULL' })]
  spec.idx.public = spec.idx.school_ok
  const { prisma, queries } = makeFakePrisma(spec)
  await buildBaselineProof({ prisma, schema: 'school_ok', referenceSchema: 'public' })
  const sql = sqlTouching(queries, /HAVING count\(\*\) > 1/)[0]
  assert.match(sql, /\(deleted_at IS NULL\)/, '部分索引必须带谓词')
  assert.match(sql, /\(email\) IS NOT NULL/)

  const spec2 = cleanSpec()
  spec2.idx.school_ok = [idx({ index_name: 'User_lower_email_key', keys: ['lower(email)'] })]
  spec2.idx.public = spec2.idx.school_ok
  const { prisma: p2, queries: q2 } = makeFakePrisma(spec2)
  const p = await buildBaselineProof({ prisma: p2, schema: 'school_ok', referenceSchema: 'public' })
  const sql2 = sqlTouching(q2, /HAVING count\(\*\) > 1/)[0]
  assert.ok(sql2, '表达式索引必须被检查（旧实现静默跳过）')
  assert.match(sql2, /GROUP BY lower\(email\)/)
  assert.match(sql2, /\(lower\(email\)\) IS NOT NULL/)
  assert.equal(allChecks(p)['data.semantics'], true)
})

test('B3：无效/未就绪索引 → 明确不通过（既不算通过也不静默跳过）', async () => {
  const spec = cleanSpec()
  spec.idx.school_ok = [idx({ is_valid: false })]
  spec.idx.public = spec.idx.school_ok
  const { prisma, queries } = makeFakePrisma(spec)
  const proof = await buildBaselineProof({ prisma, schema: 'school_ok', referenceSchema: 'public' })
  const checks = allChecks(proof)
  assert.equal(proof.ok, false)
  assert.equal(checks['indexes.valid'], false, '无效索引必须显式不通过')
  assert.equal(checks['data.semantics'], false, '无效索引的唯一性无法证明 → 不通过')
  assert.equal(sqlTouching(queries, /HAVING count\(\*\) > 1/).length, 0, '无效索引不得进入重复扫描')
})

test('B3：键表达式不可读 → 未证明（fail-closed，不算通过）', async () => {
  const spec = cleanSpec()
  spec.idx.school_ok = [idx({ keys: [''] })]
  spec.idx.public = spec.idx.school_ok
  const { prisma, queries } = makeFakePrisma(spec)
  const proof = await buildBaselineProof({ prisma, schema: 'school_ok', referenceSchema: 'public' })
  assert.equal(allChecks(proof)['data.semantics'], false)
  assert.equal(sqlTouching(queries, /HAVING count\(\*\) > 1/).length, 0)
  assert.match(proof.checks.find((c) => c.id === 'data.semantics').detail, /未证明|未扫描/)
})

test('B3：PG14 目录无 NULLS NOT DISTINCT 列时不得引用该列（版本自适应）', async () => {
  const spec = cleanSpec()
  const { prisma, queries } = makeFakePrisma(spec)
  await buildBaselineProof({ prisma, schema: 'school_ok', referenceSchema: 'public' })
  const idxSql = sqlTouching(queries, /FROM pg_index/)[0]
  assert.ok(idxSql)
  assert.match(idxSql, /false::boolean AS nulls_not_distinct/, 'PG14 必须以常量 false 取代该列')
})

// ─────────────────────────────────── B2 ───────────────────────────────────

test('B2：正确示例 zhsy 寻址 school_zhsy；schema 形态 school_zhsy 必须清楚拒绝', () => {
  const ok = interpretBaselineTargetArg('zhsy')
  assert.deepEqual([ok.ok, ok.code, ok.schema], [true, 'zhsy', 'school_zhsy'])

  const bad = interpretBaselineTargetArg('school_zhsy')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /schema 名/)
  assert.match(bad.hint, /School\.code/)
  assert.equal(bad.schema, undefined, 'schema 形态参数不得派生出 school_school_zhsy')

  assert.equal(interpretBaselineTargetArg('').ok, false)
  assert.equal(interpretBaselineTargetArg('!!').ok, false)
  const dash = interpretBaselineTargetArg('school-a')
  assert.deepEqual([dash.ok, dash.code, dash.schema], [true, 'school-a', 'school_a'], 'dash 形态是合法 code（schema 归一为 school_a）')
})

test('B2：staging schema 不得给出无法执行的正式学校命令', () => {
  assert.equal(isRestoreStagingSchema('school_zhsy_stg_ab12'), true)
  assert.equal(isRestoreStagingSchema('school_zhsy'), false)
  assert.equal(schoolCodeFromSchema('school_zhsy'), 'zhsy')

  const stg = interpretBaselineTargetArg('zhsy_stg_ab12')
  assert.equal(stg.ok, false)
  assert.match(stg.hint, /staging/)
  assert.match(stg.hint, /可复用的源|新备份/)

  const guidance = baselineAdmissionGuidance('school_zhsy_stg_ab12')
  assert.doesNotMatch(guidance, /--baseline-plan\s+\S/, 'staging 指引不得给出正式学校命令')
  assert.match(guidance, /可复用的源|新备份/)

  const normal = baselineAdmissionGuidance('school_zhsy')
  assert.match(normal, /--baseline-plan zhsy/, '提示必须使用 School.code')
  assert.doesNotMatch(normal, /--baseline-plan school_zhsy/, '提示不得使用 schema 名')
  // 显式传入 code（provisionSchool 路径）优先
  assert.match(baselineAdmissionGuidance('school_zhsy', { schoolCode: 'zhsy' }), /--baseline-plan zhsy/)
})

test('B2：resolveBaselineSchoolTarget 校验 code 与 School 行、派生 schema 一致', async () => {
  const mk = (row) => ({ school: { findUnique: async () => row } })

  const okTarget = await resolveBaselineSchoolTarget({ prisma: mk({ code: 'zhsy', status: 'active' }), raw: 'zhsy' })
  assert.deepEqual([okTarget.ok, okTarget.schema], [true, 'school_zhsy'])

  const missing = await resolveBaselineSchoolTarget({ prisma: mk(null), raw: 'nosuch' })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /不存在/)

  const mismatch = await resolveBaselineSchoolTarget({ prisma: mk({ code: 'other', status: 'active' }), raw: 'zhsy' })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.reason, /不一致/)

  const staging = await resolveBaselineSchoolTarget({ prisma: mk({ code: 'zhsy', status: 'active' }), raw: 'zhsy_stg_1' })
  assert.equal(staging.ok, false)
  assert.match(staging.hint, /staging/)
})
