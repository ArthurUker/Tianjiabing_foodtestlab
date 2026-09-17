// db-readonly-checks.mjs — 开放接口的「数据库行为」只读核验脚本
//
// 用途：验证分页/时间比较/清单完整性与统计口径在**真实数据库**上的行为。
// 严格只读：仅 SELECT；输出仅结构元数据（键名、类型、计数）与断言结果，
// 不输出任何检测内容（字段值）、不含 PII、不写库。
//
// 运行（需要 DATABASE_URL，通常从 backend/.env 注入）：
//   cd backend && node tests/openapi/db-readonly-checks.mjs [学校代码，默认 tjb]

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const SCHOOL = process.argv[2] || 'tjb'
const SCHEMA = `school_${SCHOOL}`
const T = `"${SCHEMA}"."TestRecord"`

const results = []
function check(name, pass, detail) {
  results.push({ name, pass: pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO', detail })
}
function section(title) { console.log(`\n=== ${title} ===`) }

/** 与 openApiRoutes 完全同款的「UTC 墙钟字符串」转换（此处复刻用于对比验证）。 */
const utcWallClock = (d) => new Date(d).toISOString().slice(0, 23).replace('T', ' ')

async function main() {
  // ── 0. 会话时区与列类型（解释时间比较口径） ──
  section('0. 时区与列类型')
  const tzRow = await prisma.$queryRawUnsafe(
    `SELECT current_setting('TimeZone') AS session_tz,
            (SELECT data_type FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'TestRecord' AND column_name = 'updated_at') AS updated_at_type,
            (SELECT data_type FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'TestRecord' AND column_name = 'created_at') AS created_at_type`,
    SCHEMA,
  )
  console.log('会话时区 / updated_at 类型 / created_at 类型:', tzRow[0])
  check('updated_at 为 timestamp(无时区)', tzRow[0]?.updated_at_type === 'timestamp without time zone', tzRow[0]?.updated_at_type)

  // ── 1. 各类型计数 ──
  section('1. 各检测类型记录数')
  const byType = await prisma.$queryRawUnsafe(`SELECT "test_type", count(*)::int AS n FROM ${T} GROUP BY 1 ORDER BY 1`)
  console.log(byType)

  // ── 2. result_data / sample_info 的键与观测类型（仅元数据，无值） ──
  section('2. result_data 键元数据（键名 + JSON 类型 + 出现次数）')
  for (const t of byType.map((r) => r.test_type)) {
    const keys = await prisma.$queryRawUnsafe(
      `SELECT kv.key, jsonb_typeof(kv.value) AS vtype, count(*)::int AS n
         FROM ${T} t, jsonb_each(t."result_data") AS kv
        WHERE t."test_type" = $1
        GROUP BY 1,2 ORDER BY 1,2`,
      t,
    )
    console.log(`- ${t}:`)
    for (const k of keys) console.log(`    ${k.key} (${k.vtype}) × ${k.n}`)
  }

  section('2b. sample_info 键元数据')
  const sampleKeys = await prisma.$queryRawUnsafe(
    `SELECT kv.key, jsonb_typeof(kv.value) AS vtype, count(*)::int AS n
       FROM ${T} t, jsonb_each(t."sample_info") AS kv GROUP BY 1,2 ORDER BY 1,2`,
  )
  console.log(sampleKeys)

  // ── 3. 复检结构键 ──
  section('3. 复检结构（含 recheckRecords / recheckReports 的记录数与元素键）')
  const rc = await prisma.$queryRawUnsafe(
    `SELECT jsonb_typeof("result_data"->'recheckRecords') AS rc_type,
            jsonb_typeof("result_data"->'recheckReports') AS rp_type, count(*)::int AS n
       FROM ${T} GROUP BY 1,2 ORDER BY 3 DESC`,
  )
  console.log(rc)
  for (const field of ['recheckRecords', 'recheckReports']) {
    const r = await prisma.$queryRawUnsafe(
      `SELECT kv.key, jsonb_typeof(kv.value) AS vtype, count(*)::int AS n
         FROM ${T} t, jsonb_array_elements(t."result_data"->$1) AS e, jsonb_each(e) AS kv
        GROUP BY 1,2 ORDER BY 1,2`,
      field,
    )
    if (r.length) {
      console.log(`  ${field}[].* :`)
      for (const k of r) console.log(`    ${k.key} (${k.vtype}) × ${k.n}`)
    }
  }

  // ── 3b. 数组型字段的元素键（用于字段字典的嵌套路径） ──
  section('3b. 数组字段元素键元数据')
  const arrayPaths = [
    ['atpPoints', `t."result_data"->'atpPoints'`],
    ['allTestItems', `t."result_data"->'allTestItems'`],
    ['positiveDetails', `t."result_data"->'positiveDetails'`],
    ['recheckRecords[].points', `(SELECT jsonb_agg(p) FROM jsonb_array_elements(t."result_data"->'recheckRecords') r, jsonb_array_elements(r->'points') p)`],
    ['recheckReports', `t."result_data"->'recheckReports'`],
    ['recheckReports[].points', `(SELECT jsonb_agg(p) FROM jsonb_array_elements(t."result_data"->'recheckReports') r, jsonb_array_elements(r->'points') p)`],
    ['result_data.sampleInfo', `jsonb_build_array(t."result_data"->'sampleInfo')`],
  ]
  for (const [label, expr] of arrayPaths) {
    const r = await prisma.$queryRawUnsafe(
      `SELECT kv.key, jsonb_typeof(kv.value) AS vtype, count(*)::int AS n
         FROM ${T} t, LATERAL jsonb_array_elements(${expr}) AS e, jsonb_each(e) AS kv
        WHERE jsonb_typeof(e) = 'object'
        GROUP BY 1,2 ORDER BY 1,2`,
    )
    console.log(`- ${label}:`, r.length ? r : '（无数据）')
  }

  // ── 4. 键集稳定性（用于说明书「自定义字段」边界） ──
  section('4. result_data 中的非内置键（可能来自学校自定义字段）')
  const known = new Set(['result', 'testType', 'location', 'rluValue', 'atpPoints', 'colorLevel', 'tpm', 'acid',
    'oilTemp', 'tpmValue', 'acidValue', 'qualityLevel', 'vegetableType', 'batchNo', 'meatType',
    'riskLevel', 'sampleId', 'sampleType', 'positiveItems', 'positiveDetails', 'allTestItems',
    'recheckRecords', 'recheckReports', 'modificationLogs', 'finalStatus', 'traceabilityRecords',
    'remarks', 'remark', 'note', 'canteen', 'testDate', 'inspector'])
  const allKeys = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT kv.key FROM ${T} t, jsonb_each(t."result_data") AS kv ORDER BY 1`,
  )
  const extra = allKeys.map((r) => r.key).filter((k) => !known.has(k))
  console.log('未列入内置清单的键:', extra.length ? extra : '（无）')

  // ── 5. 键集稳定性（用于说明书「自定义字段」边界） ──
  section('5. 键集稳定性（用于说明书「自定义字段」边界）')
  const keyRows = await prisma.$queryRawUnsafe(
    `SELECT "test_type", count(DISTINCT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys("result_data") AS k))::int AS distinct_keysets
       FROM ${T} GROUP BY 1 ORDER BY 1`,
  )
  console.log(keyRows)
  const dateQuality = await prisma.$queryRawUnsafe(
    `SELECT "test_type",
            count(*)::int AS total,
            count(*) FILTER (WHERE substring("sample_info"->>'testDate' from 1 for 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')::int AS valid_date
       FROM ${T} GROUP BY 1 ORDER BY 1`,
  )
  console.log('检测日期有效性:', dateQuality)

  // ── 5b. 变更可见性证据：编辑/复检是否真的刷新 updated_at ──
  // 增量同步完全依赖 updated_at；若某些写入路径不刷新它，同步就会漏（本次核验只读统计，不读内容）
  section('5b. updated_at 是否随编辑刷新（updated_at > created_at 的记录数）')
  const bumpRows = await prisma.$queryRawUnsafe(
    `SELECT "test_type",
            count(*)::int AS total,
            count(*) FILTER (WHERE "updated_at" > "created_at")::int AS bumped,
            count(*) FILTER (WHERE "updated_at" = "created_at")::int AS same
       FROM ${T} GROUP BY 1 ORDER BY 1`,
  )
  console.table(bumpRows)
  const bumped = bumpRows.reduce((s, r) => s + Number(r.bumped), 0)
  check('存在 updated_at 被刷新的记录（编辑/复检会推进水位）', bumped > 0, `bumped=${bumped}`)

  // ── 6. 游标分页完整性（用与接口同款的比较方式） ──
  section('6. 游标分页完整性（keyset, updated_at ASC + id ASC）')
  const types = ['tableware', 'pesticide', 'oil', 'leanMeat']
  const totalRow = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${T} WHERE "test_type" = ANY($1::text[])`, types)
  const expected = totalRow[0].n
  const seen = new Set()
  let cursorU = null, cursorI = '', pages = 0, dup = 0, monotonic = true, prev = null
  for (let i = 0; i < 50; i++) {
    const rows = cursorU
      ? await prisma.$queryRawUnsafe(
          `SELECT "id","updated_at" FROM ${T}
            WHERE ("updated_at" > $1::timestamp OR ("updated_at" = $1::timestamp AND "id" > $2))
              AND "test_type" = ANY($3::text[])
            ORDER BY "updated_at" ASC, "id" ASC LIMIT $4`,
          utcWallClock(cursorU), cursorI, types, 201)
      : await prisma.$queryRawUnsafe(
          `SELECT "id","updated_at" FROM ${T} WHERE "test_type" = ANY($1::text[])
            ORDER BY "updated_at" ASC, "id" ASC LIMIT $2`, types, 201)
    pages++
    const hasMore = rows.length > 200
    const page = hasMore ? rows.slice(0, 200) : rows
    for (const r of page) {
      if (seen.has(r.id)) dup++
      seen.add(r.id)
      if (prev) {
        const curTs = r.updated_at.getTime(), prevTs = prev.updated_at.getTime()
        if (curTs < prevTs || (curTs === prevTs && String(r.id) <= String(prev.id))) monotonic = false
      }
      prev = r
    }
    const last = page[page.length - 1]
    if (!hasMore || !last) break
    cursorU = last.updated_at
    cursorI = last.id
  }
  console.log({ expected, fetched: seen.size, pages, duplicates: dup, strictlyMonotonic: monotonic })
  check('分页取全（fetched == 期望条数）', seen.size === expected, `${seen.size}/${expected}`)
  check('分页无重复', dup === 0, `duplicates=${dup}`)
  check('排序严格单调（无回退/漏页）', monotonic === true, `monotonic=${monotonic}`)

  // ── 7. 清单摘要与统计口径可解释性 ──
  section('7. 清单与统计口径（与 /stats 同源谓词）')
  // 2026-09-17：本脚本原先在内部**复刻**了一份 /stats 的 SQL，后续口径改成"互斥桶 + 日历校验"后它就过期了。
  // 现在直接引用实现里的单一事实源（lib/openApiScope.businessDateValidSql），避免第二套定义再次漂移。
  const { businessDateValidSql } = await import('../../lib/openApiScope.js')
  const validDate = businessDateValidSql()
  const manifestRows = await prisma.$queryRawUnsafe(
    `SELECT "record_code", "updated_at" FROM ${T} WHERE "test_type" = ANY($1::text[]) ORDER BY "record_code" ASC`, types)
  check('清单条数 == 记录条数（同类型集合）', manifestRows.length === expected, `${manifestRows.length}/${expected}`)

  // 无效日期：分别用「新日历口径」与「旧正则口径」计数，差值即"格式像日期但日历不存在"的脏值数
  const invalidRow = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM ${T}
      WHERE "test_type" = ANY($1::text[]) AND NOT COALESCE(${validDate}, false)`, types)
  const invalid = Number(invalidRow[0].n)
  const invalidByRegex = dateQuality.reduce((s, r) => s + (Number(r.total) - Number(r.valid_date)), 0)
  console.log(`日期无效/缺失：日历口径=${invalid}，旧正则口径=${invalidByRegex}（差值 ${invalidByRegex - invalid} = 日历脏值数）`)
  check('日历口径较正则口径更严（invalid ≥ 正则口径）', invalid >= invalidByRegex, `${invalid} vs ${invalidByRegex}`)

  // 7b. 执行与 /stats **同源谓词**的只读 SQL，验证互斥桶与恒等式
  //     （该校授权无日期范围、脚本不传 start/end → 请求范围不限 ⇒ 请求范围外恒为 0）
  section('7b. /stats 同源 SQL 执行与自洽性（互斥桶）')
  const inScopeExpr = validDate
  const passExpr = `CASE
          WHEN "test_type" = 'pathogen' THEN (COALESCE("result_data"->>'riskLevel','') = '无风险')
          WHEN "test_type" = 'oil' THEN (
            CASE
              WHEN COALESCE("result_data"->>'colorLevel','') IN ('合格','警戒') THEN TRUE
              WHEN COALESCE("result_data"->>'colorLevel','') = '不合格' THEN FALSE
              ELSE (COALESCE("result_data"->>'result','') LIKE '%合格%' AND COALESCE("result_data"->>'result','') NOT LIKE '%不合格%')
            END)
          ELSE (COALESCE("result_data"->>'result','') LIKE '%合格%' AND COALESCE("result_data"->>'result','') NOT LIKE '%不合格%')
        END`
  const statsRows = await prisma.$queryRawUnsafe(
    `SELECT "test_type",
            count(*) FILTER (WHERE ${inScopeExpr})::int AS scope_total,
            count(*) FILTER (WHERE ${inScopeExpr} AND ${passExpr})::int AS pass_count,
            count(*) FILTER (WHERE NOT COALESCE(${validDate}, false))::int AS excluded_invalid_date
       FROM ${T} WHERE "test_type" = ANY($1::text[]) GROUP BY "test_type" ORDER BY "test_type"`,
    types,
  )
  console.table(statsRows)
  const sumIn = statsRows.reduce((s, r) => s + Number(r.scope_total), 0)
  const sumPass = statsRows.reduce((s, r) => s + Number(r.pass_count), 0)
  const sumEx = statsRows.reduce((s, r) => s + Number(r.excluded_invalid_date), 0)
  check('stats SQL 可执行（语法/绑定有效）', Array.isArray(statsRows) && statsRows.length > 0, `rows=${statsRows.length}`)
  check('scope_total 合计 == 有效日期记录数', sumIn === (expected - invalid), `${sumIn} vs ${expected - invalid}`)
  check('excluded 合计 == 日期无效记录数', sumEx === invalid, `${sumEx} vs ${invalid}`)
  check('scope_total + excluded == 记录总数（每行恰好落一个桶，无双计）', sumIn + sumEx === expected, `${sumIn}+${sumEx} vs ${expected}`)
  check('pass_count ≤ scope_total（分母不含无效日期）', sumPass <= sumIn, `${sumPass}/${sumIn}`)

  // ── 汇总 ──
  section('汇总')
  for (const r of results) console.log(`${r.pass.padEnd(4)} ${r.name} — ${r.detail}`)
  const failed = results.filter((r) => r.pass === 'FAIL').length
  console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 全部通过')
  await prisma.$disconnect()
  process.exit(failed ? 1 : 0)
}

main().catch(async (e) => {
  console.error('ERROR:', e.message)
  await prisma.$disconnect()
  process.exit(2)
})
