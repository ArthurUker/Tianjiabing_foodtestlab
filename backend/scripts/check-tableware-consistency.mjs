#!/usr/bin/env node
// 餐具「记录级结果」自洽巡检（只读，可反复跑 / 可挂定时任务）
//
// 背景：洗涤剂残留（testType=detergent）点位早期表单只写 atpPoints[].res、不写记录级 result，
// 导致"列表显示合格、统计算不合格"（2026-09-24 修复：读取侧回退 + 写入侧按点位补写）。
// 本脚本用于**验证写入侧是否持续自洽**，以及发现任何历史遗漏：
//
//   · 不自洽 = 顶层 result 为空，但 atpPoints 里有可判定的结论（本应被补写/被回退判定）
//   · 输出每校覆盖率和明细；**发现不自洽即退出码 1**（便于告警/CI）
//
// 用法：
//   cd /opt/foodsentinel/backend && set -a && . ./.env && set +a && node scripts/check-tableware-consistency.mjs
//   只读：仅 SELECT；不修改任何数据。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const { tablewareVerdict } = await import('../lib/tablewareVerdict.js')

const prisma = new PrismaClient()
const db = (await prisma.$queryRawUnsafe('SELECT current_database() AS db'))[0].db
console.log(`餐具记录级结果自洽巡检 | 数据库 = ${db} | ${new Date().toISOString()}\n`)

const schemas = (await prisma.$queryRawUnsafe(
  `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'school\\_%' ORDER BY schema_name`,
)).map((r) => r.schema_name)

let inconsistent = 0
let total = 0
let covered = 0

for (const s of schemas) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT "record_code", "version", "result_data",
           "sample_info"->>'testDate' AS d, "sample_info"->>'canteen' AS canteen
      FROM "${s}"."TestRecord"
     WHERE "test_type" = 'tableware'
     ORDER BY "sample_info"->>'testDate' DESC NULLS LAST`)
  if (!rows.length) continue

  const judged = []   // 顶层为空但点位可判定 → 应已被写入侧补写
  for (const r of rows) {
    total++
    const hasTop = String(r.result_data?.result ?? '').trim() !== ''
    if (hasTop) { covered++; continue }
    const v = tablewareVerdict(r.result_data)
    if (v.level !== 'unknown') {
      inconsistent++
      judged.push(`      ⚠️ ${r.d || '(无日期)'} ${r.canteen || '-'} ${String(r.record_code).slice(-10)} 点位判定=${v.level}（${v.text}）`)
    }
  }
  const pct = rows.length ? Math.round((rows.length - judged.length) / rows.length * 100) : 100
  console.log(`  ${s.padEnd(13)} 餐具 ${String(rows.length).padStart(3)} 条，记录级结果覆盖 ${pct}%` +
    (judged.length ? `；**不自洽 ${judged.length} 条**：` : ' ✓'))
  for (const line of judged) console.log(line)
}

console.log(`\n合计：餐具 ${total} 条，有记录级结果 ${covered} 条（${total ? Math.round(covered / total * 100) : 100}%）`)
if (inconsistent) {
  console.log(`❌ 发现 ${inconsistent} 条不自洽（顶层 result 为空但点位可判定）—— 说明写入侧补写没生效，或存在绕过写入路径的数据导入`)
  await prisma.$disconnect()
  process.exit(1)
}
console.log('✅ 无不自洽记录：凡点位可判定的餐具记录，记录级 result 都已具备（写入侧自洽生效）')
await prisma.$disconnect()
