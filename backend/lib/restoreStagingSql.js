// restoreStagingSql.js — 恢复暂存 SQL 的纯变换辅助（P3-W3-T01 / AUD-004）
//
// 与 restoreSqlUtils.js 分离的原因：后者属既有模块（本包未授权修改），
// 而新恢复引擎需要一个**新增**的纯函数把备份 SQL 中冗余的 `CREATE SCHEMA "<暂存名>"` 剔除。
//
// 背景：新引擎在**执行备份 SQL 之前**先显式 `CREATE SCHEMA "<随机暂存名>"`，
// 以便立即取得并登记 pg_namespace OID（归属证据：任何 DROP/RENAME 前都要用 OID 复核
// 「该对象仍是本任务创建的那一个」）。而备份 SQL 自身带一条
// `CREATE SCHEMA <暂存名>;`（由 rewriteSchemaNames 从原 schema 名改写而来），
// 会与之冲突（ERROR: schema ... already exists）→ 故执行前剔除该冗余语句。
//
// 纯字符串变换（无 Node 特有 API / 无 import.meta），可被 Jest 直接 import。

/**
 * 移除 SQL 中针对**指定 schema** 的 `CREATE SCHEMA` 语句。
 *
 * 兼容形态：`CREATE SCHEMA school_x;` / `CREATE SCHEMA "school_x";`（可带前导空白）；
 * 同一行若还有其它语句，只删本语句、保留其余内容；删空的行整行丢弃。
 *
 * @param {string} sql 备份明文 SQL（已完成 schema 名重写）
 * @param {string} schemaName 暂存 schema 名（只删它的 CREATE SCHEMA）
 * @returns {string}
 */
export function stripCreateSchema(sql, schemaName) {
  const re = new RegExp(`CREATE\\s+SCHEMA\\s+(?:"${schemaName}"|${schemaName})\\s*;`, 'gi')
  const out = []
  for (const line of String(sql).split('\n')) {
    if (!/CREATE\s+SCHEMA/i.test(line)) { out.push(line); continue }
    const rest = line.replace(re, '')
    if (rest.trim() === '') continue
    out.push(rest)
  }
  return out.join('\n')
}

export default { stripCreateSchema }
