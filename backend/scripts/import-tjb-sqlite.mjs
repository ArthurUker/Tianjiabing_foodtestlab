// import-tjb-sqlite.mjs — 将田家炳中学（school_tjb）旧 SQLite 库中缺失的记录导入新系统
//
// 与 import-tjb-backup.mjs（2026-08 上批，n=703）的区别：
//   1) 数据源是旧 **SQLite 库**（foodtestlab.db）经人工复核后生成的 manifest.json，不再是备份 JSON；
//   2) **保留** recheckRecords / modificationLogs / recheckReports / traceabilityRecords
//      —— 上批脚本的 DROP_FIELDS 会剥掉这些复检字段，导致 7 条「整改后复检合格」记录只剩结论没有明细；
//   3) 提供 --repair 子功能：为已存在但丢了复检明细的记录回填明细。
//
// 写入字段口径（与上批 703 条一致，归属用户除外）：
//   record_code 沿用旧库；sample_info={testDate,canteen,inspector}；result_data 业务字段平铺；
//   status=completed；version=0；data_version=1；
//   created_at = completed_at = testDate 00:00:00(+08:00)（本地时区，与上批落盘值一致）；
//   created_by = 由 manifest.owner_username 解析（可按条覆盖 created_by_username），
//                默认回退 lidan（现李丹账户，2026-09-14 人工复核确认）。
//
// 安全设计：**默认只做干跑（dry-run），不写任何数据**；必须显式传 --commit 才落库。
//
// 用法（在 backend/ 目录、以 foodsentinel 用户执行，依赖 backend/.env 与 @prisma/client）：
//   node scripts/import-tjb-sqlite.mjs <manifest.json>                 # 干跑，只统计与预览
//   node scripts/import-tjb-sqlite.mjs <manifest.json> --commit        # 正式插入
//   node scripts/import-tjb-sqlite.mjs <manifest.json> --repair <repair-recheck.json>          # 干跑修补
//   node scripts/import-tjb-sqlite.mjs <manifest.json> --repair <repair-recheck.json> --commit # 正式修补
//
// 幂等：插入按 record_code 去重跳过；修补仅在目标记录尚无 recheckRecords 时执行。

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import fs from 'fs'

const TARGET_SCHEMA = 'school_tjb'
const OWNER_USERNAME = 'lidan'   // 归属现李丹账户；若 manifest 未指定则回退到它

function loadJson(p, label) {
  if (!p || !fs.existsSync(p)) {
    console.error(`❌ ${label} 不存在: ${p}`)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8'))
}

async function main() {
  const args = process.argv.slice(2)
  const manifestPath = args.find(a => !a.startsWith('--'))
  const repairIdx = args.indexOf('--repair')
  const repairPath = repairIdx >= 0 ? args[repairIdx + 1] : null
  const commit = args.includes('--commit')
  const mode = commit ? '【正式写入】' : '【DRY-RUN 干跑，不写库】'

  const manifest = loadJson(manifestPath, 'manifest')
  const repair = repairPath ? loadJson(repairPath, 'repair') : null
  const records = manifest.records || []

  console.log(`模式: ${mode}`)
  console.log(`清单: ${manifestPath}`)
  console.log(`生成时间: ${manifest.generated_at}`)
  console.log(`源库 md5: ${manifest.source_md5}`)
  console.log(`目标 schema: ${manifest.target_schema || TARGET_SCHEMA}, 记录数: ${records.length}\n`)

  const prisma = new PrismaClient()

  // ① schema 存在性
  const schemaExists = await prisma.$queryRawUnsafe(
    'SELECT 1 FROM pg_namespace WHERE nspname = $1', TARGET_SCHEMA
  )
  if (!schemaExists.length) {
    console.error(`❌ 目标 schema ${TARGET_SCHEMA} 不存在`)
    await prisma.$disconnect()
    process.exit(1)
  }

  // ② 归属用户：优先取 manifest.owner_username，支持逐条 created_by_username 覆盖
  const defaultOwnerName = manifest.owner_username || OWNER_USERNAME
  const neededNames = [...new Set([defaultOwnerName, ...records.map(r => r.created_by_username).filter(Boolean)])]
  const ownerMap = {}
  for (const name of neededNames) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "id" FROM "${TARGET_SCHEMA}"."User" WHERE "username" = $1 AND "status" = 'active' LIMIT 1`, name
    )
    if (!rows.length) {
      console.error(`❌ ${TARGET_SCHEMA} 中未找到启用用户 ${name}`)
      await prisma.$disconnect()
      process.exit(1)
    }
    ownerMap[name] = rows[0].id
    console.log(`归属用户: ${name} → ${rows[0].id}`)
  }
  const ownerId = ownerMap[defaultOwnerName]

  const before = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "${TARGET_SCHEMA}"."TestRecord"`
  )
  console.log(`导入前 ${TARGET_SCHEMA}.TestRecord 记录数: ${before[0].n}\n`)

  // ③ 逐条查重（以 record_code 为幂等键）
  const toInsert = []
  let alreadyExists = 0
  for (const r of records) {
    const hit = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM "${TARGET_SCHEMA}"."TestRecord" WHERE "record_code" = $1 LIMIT 1`, r.record_code
    )
    if (hit.length) { alreadyExists++; continue }
    toInsert.push(r)
  }
  console.log(`待插入: ${toInsert.length} 条；已存在(跳过): ${alreadyExists} 条`)

  const byType = {}
  for (const r of toInsert) byType[r.test_type] = (byType[r.test_type] || 0) + 1
  console.log('待插入按类型:', byType)

  console.log('\n前 3 条预览:')
  for (const r of toInsert.slice(0, 3)) {
    console.log(`  ${r.record_code}`)
    console.log(`    ${r.test_type} | ${r.test_name} | ${r.sample_info.testDate} ${r.sample_info.canteen} ${r.sample_info.inspector}`)
    console.log(`    created_at=${r.created_at} status=${r.status} v=${r.version}/${r.data_version}`)
    console.log(`    result_data=${JSON.stringify(r.result_data).slice(0, 180)}…`)
  }

  // ④ 复检明细修补预览
  let repairPlan = []
  if (repair) {
    const patches = repair.patches || []
    for (const p of patches) {
      const row = await prisma.$queryRawUnsafe(
        `SELECT "id","version","result_data" FROM "${TARGET_SCHEMA}"."TestRecord" WHERE "record_code" = $1 LIMIT 1`,
        p.record_code
      )
      if (!row.length) { console.log(`  ⚠ 修补目标不存在，跳过: ${p.record_code}`); continue }
      const rd = row[0].result_data
      if (rd && (rd.recheckRecords || rd.modificationLogs)) {
        console.log(`  ⚠ 已含复检明细，跳过: ${p.record_code}`)
        continue
      }
      repairPlan.push({ ...p, id: row[0].id, version: row[0].version })
    }
    console.log(`\n复检明细修补: ${repairPlan.length} 条待补（清单共 ${(repair.patches || []).length} 条）`)
    for (const p of repairPlan.slice(0, 3)) {
      console.log(`  ${p.record_code.slice(0, 46)}… [${p.test_type} ${p.testDate}] 补键: ${Object.keys(p.patch).join(', ')}`)
    }
  }

  if (!commit) {
    console.log('\n[DRY-RUN] 未写入任何数据。确认无误后加 --commit 执行。')
    await prisma.$disconnect()
    return
  }

  // ⑤ 正式写入
  let inserted = 0, errors = 0
  for (const r of toInsert) {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${TARGET_SCHEMA}"."TestRecord"
           ("id","record_code","test_type","test_name","sample_info","result_data","status",
            "created_by","created_at","updated_at","version","data_version","completed_at")
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,now(),$10,$11,$12)`,
        r.id, r.record_code, r.test_type, r.test_name,
        JSON.stringify(r.sample_info), JSON.stringify(r.result_data),
        r.status, ownerMap[r.created_by_username] || ownerId,
        new Date(r.created_at), r.version, r.data_version, new Date(r.completed_at)
      )
      inserted++
    } catch (e) {
      errors++
      console.error(`  ❌ ${r.test_type} ${r.record_code}: ${e.message}`)
    }
  }
  console.log(`\n✅ 插入 ${inserted} 条，失败 ${errors} 条`)

  let patched = 0, patchErrors = 0
  for (const p of repairPlan) {
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "${TARGET_SCHEMA}"."TestRecord"
            SET "result_data" = "result_data" || $1::jsonb,
                "version"     = "version" + 1,
                "updated_at"  = now()
          WHERE "record_code" = $2 AND NOT ("result_data" ? 'recheckRecords')`,
        JSON.stringify(p.patch), p.record_code
      )
      patched++
    } catch (e) {
      patchErrors++
      console.error(`  ❌ 修补 ${p.record_code}: ${e.message}`)
    }
  }
  if (repair) console.log(`✅ 复检明细修补 ${patched} 条，失败 ${patchErrors} 条`)

  const after = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "${TARGET_SCHEMA}"."TestRecord"`
  )
  console.log(`\n导入后 ${TARGET_SCHEMA}.TestRecord 记录数: ${after[0].n}（导入前 ${before[0].n}）`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('执行失败:', e)
  process.exit(1)
})
