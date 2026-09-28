/**
 * publicInfraShape.js — P3-PUBLIC-INFRA-CHAIN-R1
 *
 * 公共基础设施（public）对象的**只读形状契约**（单一事实源 = 链尾 migration）：
 *   · `public._tenant_migration_locks`（迁移互斥锁表；租户迁移引擎）
 *   · `public.revoked_tokens`（令牌吊销事实源）+ 3 个非唯一索引
 *
 * 纪律（R9 裁决 / RC-04 "同一可审发布"）：
 *   ① 结构由 `prisma migrate deploy` 创建/升级（`-- @scope: public` 链尾 migration），
 *      **运行时不得再 CREATE/ALTER/CREATE INDEX**；
 *   ② 运行时只允许**只读断言**：缺表/缺列/错列/缺索引 → 确定的 fail-closed 码：
 *        · 租户迁移引擎侧：`TENANT_LOCK_TABLE_SHAPE_MISMATCH`
 *        · 认证侧：`AUTH_INFRA_MISSING`（503，**不进 fail-soft**）
 *        · 检查侧（db:sync --check）：`PUBLIC_INFRA_SHAPE_MISMATCH`（traffic-blocking）
 *   ③ 本模块**不导入 Prisma / middleware / 生产客户端**，只用 `pg_catalog`
 *      （pg_catalog 不受 privilege 过滤，受限测试角色同样可读；不依赖 information_schema 的权限可见性）。
 */

/** 期望的默认值表达式（pg_get_expr 口径）。null = 不要求默认值。 */
const col = (name, type, notNull, defaultExpr = null) => Object.freeze({ name, type, notNull, defaultExpr })

export const LOCK_TABLE = '_tenant_migration_locks'
/** 锁表形状（与 runtime 历史 `migrationLockDdl()/migrationLockUpgradeStatements()` 逐列同形）。 */
export const LOCK_TABLE_SHAPE = Object.freeze({
  table: LOCK_TABLE,
  columns: Object.freeze([
    col('schema_name', 'text', true),
    col('owner', 'text', true),
    col('locked_at', 'timestamp with time zone', true, 'now()'),
    col('heartbeat_at', 'timestamp with time zone', true, 'now()'),
    col('fencing_token', 'bigint', true, '1'),
    col('hostname', 'text', false),
    col('pid', 'integer', false),
  ]),
  primaryKey: Object.freeze(['schema_name']),
})

export const REVOKED_TOKENS = 'revoked_tokens'
/** 吊销表形状（与 runtime 历史 `REVOKED_TOKENS_DDL` 逐列同形）。 */
export const REVOKED_TOKENS_SHAPE = Object.freeze({
  table: REVOKED_TOKENS,
  columns: Object.freeze([
    col('jti', 'text', true),
    col('user_id', 'text', true),
    col('school_code', 'text', false),
    col('token_type', 'text', true, "'access'::text"),
    col('reason', 'text', false),
    col('revoked_at', 'timestamp with time zone', true, 'now()'),
    col('expires_at', 'timestamp with time zone', true),
  ]),
  primaryKey: Object.freeze(['jti']),
})
/** 吊销表 3 索引（名称 + 列序 + 非唯一；P3-W1-T01 停校 O(1) 关键路径）。 */
export const REVOKED_TOKENS_INDEXES = Object.freeze([
  Object.freeze({ name: 'revoked_tokens_expires_at_idx', columns: Object.freeze(['expires_at']) }),
  Object.freeze({ name: 'revoked_tokens_user_idx', columns: Object.freeze(['user_id', 'token_type', 'revoked_at']) }),
  Object.freeze({ name: 'revoked_tokens_school_epoch_idx', columns: Object.freeze(['school_code', 'token_type', 'revoked_at']) }),
])

export const LOCK_TABLE_SHAPE_MISMATCH = 'TENANT_LOCK_TABLE_SHAPE_MISMATCH'
export const AUTH_INFRA_MISSING = 'AUTH_INFRA_MISSING'
export const PUBLIC_INFRA_SHAPE_MISMATCH = 'PUBLIC_INFRA_SHAPE_MISMATCH'

const eqArray = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])

const COLUMNS_SQL = `
SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
       pg_get_expr(d.adbin, d.adrelid) AS default_expr
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
 WHERE n.nspname = 'public' AND c.relname = $1
 ORDER BY a.attnum`
// 注意：`array_agg(attname)` 的类型是 name[]，node-postgres 无该数组解析器（会返回字面量字符串）
//       → 必须 `::text` 转换，保证跨客户端（pg / Prisma）都得到 JS 数组。
const PRIMARY_KEY_SQL = `
SELECT (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS cols
  FROM pg_index ix
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public' AND t.relname = $1 AND ix.indisprimary`
// P3-PUBLIC-INFRA-FOLLOWUP-R1：索引**可用性/形态**完整判据（R10：原探针只查名称/列序/唯一性）。
//   · `indisvalid`/`indisready` = 索引对查询可用/已就绪（REINDEX 失败、并发建索引中断、系统目录被改 → false）；
//   · `method` = 访问方法（契约 = btree；hash/gin 等虽同名但不满足停校 O(1) 等值查询语义）；
//   · `is_partial`/`expr_cols` = 谓词/表达式索引（同名但**不覆盖**契约列全集 → 不得当作契约索引）。
const INDEXES_SQL = `
SELECT i.relname AS name, ix.indisunique AS is_unique,
       ix.indisvalid AS is_valid, ix.indisready AS is_ready,
       am.amname AS method, (ix.indpred IS NOT NULL) AS is_partial,
       (SELECT count(*)::int FROM unnest(ix.indkey::int2[]) AS k(attnum) WHERE k.attnum = 0) AS expr_cols,
       (SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS cols
  FROM pg_class i
  JOIN pg_index ix ON ix.indexrelid = i.oid
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = i.relam
 WHERE n.nspname = 'public' AND t.relname = $1`

/**
 * 只读形状断言（通用）：表存在 + 列（名称/类型/非空/默认）+ 主键 +（可选）非唯一索引。
 * @param {{$queryRawUnsafe:Function}} prisma 任一可执行只读 SQL 的客户端（真实 Prisma / 测试桩）
 * @param {{table:string, columns:ReadonlyArray, primaryKey:ReadonlyArray, indexes?:ReadonlyArray}} shape
 * @returns {Promise<string[]>} 违规清单（空数组 = 形状合规）；**只发 SELECT**，不写库
 */
export async function infraShapeIssues(prisma, shape) {
  const issues = []
  const cols = await prisma.$queryRawUnsafe(COLUMNS_SQL, shape.table)
  if (!Array.isArray(cols) || cols.length === 0) {
    issues.push(`table-missing:public.${shape.table}`)
    return issues
  }
  const byName = new Map(cols.map((c) => [String(c.name), c]))
  for (const want of shape.columns) {
    const got = byName.get(want.name)
    if (!got) { issues.push(`column-missing:${want.name}`); continue }
    if (String(got.type) !== want.type) issues.push(`column-type:${want.name}(want ${want.type}, got ${got.type})`)
    if (Boolean(got.not_null) !== want.notNull) issues.push(`column-notnull:${want.name}(want ${want.notNull}, got ${got.not_null})`)
    if (want.defaultExpr !== null && String(got.default_expr || '') !== want.defaultExpr) {
      issues.push(`column-default:${want.name}(want ${want.defaultExpr}, got ${got.default_expr || 'null'})`)
    }
  }
  const extra = cols.map((c) => String(c.name)).filter((n) => !shape.columns.some((w) => w.name === n))
  for (const n of extra) issues.push(`column-extra:${n}`)
  // 数组归一：兼容 pg（text[] → JS 数组）与 Prisma（可能返回 `{a,b}` 字面量/字符串）
  const asArray = (v) => Array.isArray(v) ? v.map(String)
    : (typeof v === 'string' && v.trim().startsWith('{') ? v.trim().replace(/^\{|\}$/g, '').split(',').filter((s) => s !== '') : null)
  const show = (v) => (asArray(v) || []).join(',') || 'none'
  if (shape.primaryKey) {
    const pk = await prisma.$queryRawUnsafe(PRIMARY_KEY_SQL, shape.table)
    const got = asArray(pk && pk[0] ? pk[0].cols : null)
    if (!eqArray(got, shape.primaryKey)) issues.push(`primary-key(want ${shape.primaryKey.join(',')}, got ${show(pk && pk[0] ? pk[0].cols : null)})`)
  }
  if (shape.indexes) {
    const idxRows = await prisma.$queryRawUnsafe(INDEXES_SQL, shape.table)
    const byIdx = new Map((idxRows || []).map((r) => [String(r.name), r]))
    for (const want of shape.indexes) {
      const got = byIdx.get(want.name)
      if (!got) { issues.push(`index-missing:${want.name}`); continue }
      // P3-PUBLIC-INFRA-FOLLOWUP-R1：可用性/形态判据（先于唯一性/列序；失效索引即便列序正确也不可用）
      if (got.is_valid !== true) issues.push(`index-invalid:${want.name}(indisvalid=${got.is_valid === undefined ? 'unknown' : got.is_valid})`)
      if (got.is_ready !== true) issues.push(`index-not-ready:${want.name}(indisready=${got.is_ready === undefined ? 'unknown' : got.is_ready})`)
      if (String(got.method || '') !== 'btree') issues.push(`index-method:${want.name}(want btree, got ${got.method === undefined ? 'unknown' : got.method})`)
      if (got.is_partial === true) issues.push(`index-partial:${want.name}(must not have predicate)`)
      if (Number(got.expr_cols || 0) > 0) issues.push(`index-expression:${want.name}(must be plain-column index)`)
      if (got.is_unique === true) issues.push(`index-unique:${want.name}(must be non-unique)`)
      if (!eqArray(asArray(got.cols), want.columns)) issues.push(`index-columns:${want.name}(want ${want.columns.join(',')}, got ${show(got.cols)})`)
    }
  }
  return issues
}

/** 锁表只读形状断言（租户迁移引擎侧）。 */
export async function lockTableShapeIssues(prisma) {
  return infraShapeIssues(prisma, LOCK_TABLE_SHAPE)
}

/** 吊销表 + 3 索引只读形状断言（认证侧/检查侧）。 */
export async function revokedTokensShapeIssues(prisma) {
  return infraShapeIssues(prisma, { ...REVOKED_TOKENS_SHAPE, indexes: REVOKED_TOKENS_INDEXES })
}

/** 两项公共基础设施的合并只读检查（db:sync --check 用）。 */
export async function publicInfraShapeReport(prisma) {
  const lock = await lockTableShapeIssues(prisma)
  const revoked = await revokedTokensShapeIssues(prisma)
  const issues = [...lock.map((i) => `_tenant_migration_locks:${i}`), ...revoked.map((i) => `revoked_tokens:${i}`)]
  return { ok: issues.length === 0, code: issues.length ? PUBLIC_INFRA_SHAPE_MISMATCH : 'OK', issues }
}
