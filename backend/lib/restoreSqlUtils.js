// restoreSqlUtils.js — 影子恢复 SQL 处理纯函数（无 Node 特有 API，可单测）
//
// 只包含纯字符串变换：pg_dump 输出中的 schema 名改写。
// 与 restoreService.js 分离：保持纯函数可被 jest 直接 import（无 import.meta 依赖）。

/**
 * 重写 SQL 中的 schema 名：把源 schema（school_x）引用改写为目标影子 schema（school_x_restore）。
 * 兼容两种 pg_dump 输出形态（实测）：
 *   - PG18：`CREATE SCHEMA school_demo;` + `CREATE TABLE school_demo."Attachment" (`（schema 无引号）
 *   - 旧版：`CREATE TABLE "school_demo"."Attachment" (`（schema 带引号）
 * 安全边界：`school_demo.`（后接点）与 `CREATE SCHEMA school_demo;` 精确匹配，
 * 不会误伤 `school_demo_restore`（其后是下划线而非点）。
 */
export function rewriteSchemaNames(sql, fromSchema, toSchema) {
  let out = sql.replace(
    new RegExp(`CREATE SCHEMA\\s+"?${fromSchema}"?\\s*;`, 'g'),
    `CREATE SCHEMA "${toSchema}";`
  )
  // 先替换带引号的 schema 限定，再替换不带引号的（二者互不重叠）
  out = out.replaceAll(`"${fromSchema}".`, `"${toSchema}".`)
  out = out.replaceAll(`${fromSchema}.`, `${toSchema}.`)
  return out
}
