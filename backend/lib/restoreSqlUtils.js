// restoreSqlUtils.js — 影子恢复 SQL 处理纯函数（无 Node 特有 API，可单测）
//
// 只包含纯字符串变换：pg_dump 输出中的 schema 名改写 + 全库备份的单校段提取。
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

// ─────────────────────────────────────────────────────────────
// 全库备份 → 单校段提取（方案B：全库备份记录对学校可见，恢复只提取自己 schema）
// ─────────────────────────────────────────────────────────────
// pg_dump -Fp 全库备份输出结构（PG18 实测）：
//   SET ... ; SELECT pg_catalog.set_config('search_path','',false); SET default_tablespace = ''; ...
//   CREATE SCHEMA public;  CREATE SCHEMA school_a;  CREATE SCHEMA school_b; ...
//   CREATE TABLE school_a."X" ( ... );  ALTER TABLE ONLY school_a."X" ADD CONSTRAINT ...;
//   COPY school_a."X" (...) FROM stdin;  <data>  \.
//   CREATE INDEX "x_idx" ON school_a."X" ...;
// 目标 schema 的表 / 索引 / 约束 / COPY 数据均以 `school_x.` 前缀限定，可精确切分。

const SCHEMA_LIKE = /^[a-z][a-z0-9_]*$/ // schema 名只允许小写字母数字下划线（assertSafeSchemaName 同源）

/**
 * 从全库备份 SQL 文本中提取【指定 schema】的完整段（建表 + 约束 + 索引 + COPY 数据）。
 * 保留语句顺序；同时保留前置的全局 SET / search_path / default_* 等必要上下文，
 * 使提取后的片段可独立 psql -f 执行（与单校备份文件的语义一致）。
 * @param {string} sql 全库备份明文 SQL
 * @param {string} schema 目标 schema 名（如 school_demo）
 * @returns {string} 只含目标 schema 的 SQL 片段
 */
export function extractSchemaSegment(sql, schema) {
  if (!schema || !SCHEMA_LIKE.test(schema)) throw new Error(`非法 schema 名: ${schema}`)
  const lines = sql.split('\n')
  const out = []
  let i = 0
  let firstContent = true // 首个非注释非空行之前允许保留头部全局 SET

  // 目标 schema 的限定名引用形式（兼容带引号 / 不带引号）：
  //   school_a."X"   /   school_a.X   /   "school_a"."X"（少见）
  const quotedSchema = '"' + schema + '"'
  const prefixDot = schema + '.'
  const quotedPrefixDot = quotedSchema + '.'

  const inTarget = (line) =>
    line.includes(prefixDot) || line.includes(quotedPrefixDot) || line.includes(quotedSchema + '.')
  const isCreateSchemaOf = (line, name) =>
    new RegExp(`^CREATE\\s+SCHEMA\\s+"?${name}"?\\s*;`, 'i').test(line)

  while (i < lines.length) {
    const line = lines[i]

    // 1) 头部全局上下文：首个内容行之前的所有 SET / SELECT pg_catalog / 注释 全保留；
    //    但 CREATE SCHEMA 不属于这里（见 2）。
    if (firstContent) {
      const trimmed = line.trim()
      const isHeadSetup = /^(SET\s|SELECT\s+pg_catalog\.|--|$)/i.test(trimmed)
      const isCreateSchema = /^CREATE\s+SCHEMA\s/i.test(trimmed)
      if (isHeadSetup && !isCreateSchema) {
        out.push(line)
        i++
        continue
      }
      // 遇到 CREATE SCHEMA 或 CREATE TABLE 等实际内容后，头部结束
      firstContent = false
    }

    // 2) CREATE SCHEMA：只保留目标 schema 的声明（其它 schema 的删掉）
    if (/^CREATE\s+SCHEMA\s/i.test(line.trim())) {
      if (isCreateSchemaOf(line, schema)) out.push(line)
      i++
      continue
    }

    // 3) COPY 数据块：COPY <schema>.<table> ... FROM stdin; 直到 `\.`
    if (/^COPY\s/i.test(line.trim())) {
      if (inTarget(line)) {
        out.push(line)
        i++
        while (i < lines.length && lines[i].trim() !== '\\.') {
          out.push(lines[i])
          i++
        }
        if (i < lines.length) { out.push(lines[i]); i++ } // `\.`
      } else {
        // 跳过其它 schema 的 COPY 及其数据块
        i++
        while (i < lines.length && lines[i].trim() !== '\\.') i++
        if (i < lines.length) i++
      }
      continue
    }

    // 4) 一般语句（CREATE TABLE / ALTER TABLE / CREATE INDEX / CREATE SEQUENCE / GRANT 等）：
    //    CREATE TABLE 与 ALTER TABLE 可能跨多行（字段列表 / 约束），用 inTarget 判定归属；
    //    非目标 schema 的多行块整体跳过直到语句结束（行尾 ; 或裸 ); 行）。
    const trimmedLine = line.trim()
    if (inTarget(line)) {
      out.push(line)
      i++
      continue
    }
    // 非目标 schema 的多行语句（CREATE TABLE x ( ... );）需要整体跳过，直到该语句结束
    if (/^(CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+UNIQUE\s+INDEX|CREATE\s+INDEX|CREATE\s+SEQUENCE|GRANT|REVOKE|CREATE\s+VIEW|CREATE\s+FUNCTION)/i.test(trimmedLine)) {
      let depth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length
      i++
      // 跨行时维护括号深度；行尾 ; 且深度≤0 视为语句结束
      while (i < lines.length) {
        const l = lines[i]
        depth += (l.match(/\(/g) || []).length - (l.match(/\)/g) || []).length
        const ends = /;\s*$/.test(l.trim()) && depth <= 0
        i++
        if (ends) break
      }
      continue
    }

    // 5) 其余行（空行 / 注释 / pg_dump 分节注释头）——仅当上一条已属于目标段时顺带保留，
    //    否则丢弃（避免把其它 schema 段的分隔注释带进来造成误导）
    const prev = out[out.length - 1]
    const prevBelongs = prev !== undefined && inTarget(prev)
    if (prevBelongs || /^--/.test(line.trim()) && i === lines.length - 1) out.push(line)
    i++
  }

  // 收尾：确保片段以分号结尾（若被截断）不必要——按行提取天然保留完整语句。
  return out.join('\n')
}
