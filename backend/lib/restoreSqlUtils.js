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
// pg_dump -Fp 全库备份输出结构（PG14/PG18 实测）：
//   --
//   -- PostgreSQL database dump
//   --
//   \restrict <token>          ← PG17+ 才有的 meta-command（PG14 不识别，丢弃）
//   -- Dumped from database version 14.23
//   --
//   SET statement_timeout = 0;
//   ...
//   CREATE SCHEMA public;  CREATE SCHEMA school_a;  CREATE SCHEMA school_b; ...
//   --
//   -- Name: school_a."X"; Type: TABLE; Schema: school_a; Owner: -
//   --
//   CREATE TABLE school_a."X" ( ... 含复杂 CHECK CONSTRAINT ... );
//   ALTER TABLE ONLY school_a."X" ADD CONSTRAINT ...;
//   CREATE INDEX ... ON school_a."X" ...;
//   CREATE FUNCTION school_a.audit_role_change() ... LANGUAGE plpgsql AS $_$ ... $_$;  ← PL/pgSQL dollar-quote
//   COPY school_a."X" (...) FROM stdin;
//   <data>
//   \.
//
// 目标 schema 的段以 pg_dump 标准锚点
//   `-- Name: ...; Type: ...; Schema: <schema>; Owner: -`
// 开头，整段（建表 + 约束 + 索引 + 函数 + COPY 数据 + 数据行）按 schema 归属整体保留 / 丢弃。
//
// TD-Backup-Restore-Extract-Bug：旧实现用括号配对算法判断多行语句结束，对复杂
//   - CONSTRAINT ... CHECK ((role = ANY (ARRAY['admin'::text, ...])))  （字符串内 + 多层括号）
//   - PL/pgSQL 函数体（dollar-quote `$_$ ... $_$`）
//   - 多表紧邻（COPY 紧跟 CREATE TABLE 的多行块）
// 全部误判，导致：① 整段 CREATE TABLE/FUNCTION 被截短 ② COPY 块被错切 ③ 孤立
// `\.` 行残留 → psql -f 报 "invalid command \\"（截图错误）。
//
// 修复：以 pg_dump 标准段锚点为界，整段隔离 → 不再做括号配对解析。

const SCHEMA_LIKE = /^[a-z][a-z0-9_]*$/ // schema 名只允许小写字母数字下划线

/**
 * 从全库备份 SQL 文本中提取【指定 schema】的完整段（建表 + 约束 + 索引 + COPY 数据 + 函数）。
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

  const quotedSchema = '"' + schema + '"'
  const prefixDot = schema + '.'
  const quotedPrefixDot = quotedSchema + '.'

  const inTarget = (line) =>
    line.includes(prefixDot) || line.includes(quotedPrefixDot) || line.includes(quotedSchema + '.')
  const isCreateSchemaOf = (line, name) =>
    new RegExp(`^CREATE\\s+SCHEMA\\s+"?${name}"?\\s*;`, 'i').test(line)

  // pg_dump 标准段锚点：第二行 `Name: ...; Type: ...; Schema: ...; Owner: ...`
  // 段边界规则：以 `Name:` 行（无论是否是 `Data for Name:` 数据段）作为新段起点。
  // 段终止于下一个 `Name:`/`Data for Name:` 行之前。无需检查前后 `--`（pg_dump
  // 在两段之间至少含一个 `--` 行，但形状不一致——CONSTRAINT/INDEX/FUNCTION 段以
  // `--` 收尾，TABLE 段直接紧接空行后开始下一段）。
  const SECTION_HEADER_RE = /^--\s*(?:Data for )?Name:\s*(.+?);\s*Type:\s*(.+?);\s*Schema:\s*(.+?);\s*Owner:\s*(.+?)$/
  const looksLikeSectionHeader = (idx) => SECTION_HEADER_RE.test(lines[idx])

  while (i < lines.length) {
    const line = lines[i]

    // 1) 头部全局上下文：首个非内容行之前的所有 SET / SELECT / 注释 全保留；
    //    但 CREATE SCHEMA 不属于这里（见 2）。
    //    【PG17+ 兼容】丢弃 psql meta-command 行（\restrict、\unrestrict、\encoding 等，
    //    旧 PG14 不识别会导致 psql -f 报 "invalid command \\"）。
    if (firstContent) {
      const trimmed = line.trim()
      const isPsqlMeta = /^\\(restrict|unrestrict|encoding|connect|set|unset|echo|qecho|warninfo|pset)\b/.test(trimmed)
      if (isPsqlMeta) { i++; continue }
      const isHeadSetup = /^(SET\s|SELECT\s+pg_catalog\.|--|$)/i.test(trimmed)
      const isCreateSchema = /^CREATE\s+SCHEMA\s/i.test(trimmed)
      if (isHeadSetup && !isCreateSchema) {
        out.push(line)
        i++
        continue
      }
      firstContent = false
    }

    // 2) CREATE SCHEMA：只保留目标 schema 的声明
    if (/^CREATE\s+SCHEMA\s/i.test(line.trim())) {
      if (isCreateSchemaOf(line, schema)) out.push(line)
      i++
      continue
    }

    // 3) pg_dump 段锚点：以"段"为单位整体保留 / 丢弃。
    //    修复 TD-Backup-Restore-Extract-Bug 的核心——整段从 `Name:` 行开始到下一个
    //    `Name:` 行之前，不做任何括号/dollar-quote 解析，避免 PL/pgSQL/复杂 CHECK 误判。
    if (looksLikeSectionHeader(i)) {
      const m = lines[i].match(SECTION_HEADER_RE)
      const sectionSchema = m[3].trim()
      // 定位下一段头（下一个 `Name:` 行）
      let nextHeaderIdx = lines.length
      for (let scan = i + 1; scan < lines.length; scan++) {
        if (looksLikeSectionHeader(scan)) { nextHeaderIdx = scan; break }
      }
      if (sectionSchema === schema) {
        // 落地：一行 `Name: ...` 锚点 + 段内所有内容（CREATE/ALTER/COPY/函数体/数据行）
        out.push(lines[i])
        for (let k = i + 1; k < nextHeaderIdx; k++) out.push(lines[k])
      }
      // 跳过整段（无论是否保留），落到下一段头
      i = nextHeaderIdx
      continue
    }

    // 4) 兜底：COPY 数据块单独处理（即便在段锚点未识别的回退路径里也要正确切 `\.`）。
    if (/^COPY\s/i.test(line.trim())) {
      if (inTarget(line)) {
        out.push(line)
        i++
        while (i < lines.length && lines[i].trim() !== '\\.') {
          out.push(lines[i])
          i++
        }
        if (i < lines.length) { out.push(lines[i]); i++ }
      } else {
        i++
        while (i < lines.length && lines[i].trim() !== '\\.') i++
        if (i < lines.length) i++
      }
      continue
    }

    // 5) 兜底：段锚点未匹配到（异常 dump）的旧行为——按 inTarget + 括号配对
    //    正常 pg_dump 输出不会走这里。仅做最基本的安全处理。
    const trimmedLine = line.trim()
    if (inTarget(line)) { out.push(line); i++; continue }
    if (/^(CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+UNIQUE\s+INDEX|CREATE\s+INDEX|CREATE\s+SEQUENCE|GRANT|REVOKE|CREATE\s+VIEW|CREATE\s+FUNCTION)/i.test(trimmedLine)) {
      let depth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length
      i++
      while (i < lines.length) {
        const l = lines[i]
        depth += (l.match(/\(/g) || []).length - (l.match(/\)/g) || []).length
        const ends = /;\s*$/.test(l.trim()) && depth <= 0
        i++
        if (ends) break
      }
      continue
    }
    // 其余（空行 / 注释）：不保留（避免把其它 schema 段的分隔注释带进来）
    i++
  }

  return out.join('\n')
}