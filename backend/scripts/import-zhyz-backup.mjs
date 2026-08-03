// import-zhyz-backup.mjs — 将珠海一中旧系统备份 JSON（tables.{表}.data[]）迁移到
// 新系统 school_zhyz（珠海市第一中学）租户 schema 的 TestRecord。
//
// 旧备份结构：{ version, timestamp, tables: { tableware:{data:[...]}, pesticide:{...}, oil:{...}, leanMeat:{...}, pathogen:{...} } }
// 新系统规则（对齐 backend/server.js buildRecordWriteData + schema.prisma）：
//   - test_type     = 旧表名（白名单一致）
//   - test_name     = TEST_TYPE_LABELS 标准标签
//   - sample_info   = { testDate, canteen, inspector }（JSON）
//   - result_data   = 业务字段全部平铺（JSON，无数据丢失）
//   - status        = completed（历史数据）
//   - created_by    = 目标租户现有 manager（u_zhyz_manager）
//   - record_code   = 沿用旧系统唯一 record_code（RC-*），幂等，重复导入自动跳过
//   - created_at/completed_at = 由 testDate 推导（+08:00）
//
// 用法：
//   node scripts/import-zhyz-backup.mjs <backup.json>            # 正式导入
//   node scripts/import-zhyz-backup.mjs <backup.json> --dry-run  # 仅预览整理结果，不写库
//
// 注意：请在 backend/ 目录下执行（依赖 backend/.env 与 @prisma/client）。

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import crypto from 'crypto'

const TARGET_SCHOOL_CODE = 'zhyz'          // 珠海市第一中学（珠海一中）
const TARGET_SCHEMA = 'school_zhyz'
const OWNER_USERNAME = 'manager'           // 目标租户现有 manager 用户名
const BACKUP_DEFAULT = '/tmp/codebuddy-dropped-files/1c8ae284-19d8-4e60-8992-e502148575b0/lab_backup_2026-08-03.json'

const TEST_TYPE_LABELS = {
  tableware: '餐具洁净度检测',
  pathogen: '病原体检测',
  leanMeat: '肉、蛋农残检测',
  oil: '食用油品质检测',
  pesticide: '果蔬农残检测',
}

// sample_info 只抽这三个上下文字段；其余业务字段全部进 result_data
const CONTEXT_FIELDS = ['testDate', 'canteen', 'inspector']
// 系统元数据 / 旧系统同步字段 / TestRecord 顶层列，不进入 result_data
const DROP_FIELDS = new Set([
  'id', '_status', 'version', 'created_at', 'updated_at',
  'modificationLogs', 'recheckRecords', 'recheckReports', 'traceabilityRecords',
  'record_code', 'test_type', 'test_name', 'status',
])

function parseDate(s) {
  if (!s) return null
  // testDate 形如 2026-06-03（业务日期，按 +08:00 解释）
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim())
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`)
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function mapRecord(table, row) {
  const context = {}
  for (const f of CONTEXT_FIELDS) if (row[f] !== undefined && row[f] !== null && row[f] !== '') context[f] = row[f]

  const resultData = {}
  for (const [k, v] of Object.entries(row)) {
    if (DROP_FIELDS.has(k)) continue
    resultData[k] = v
  }
  // 与系统写入一致：result_data 平铺时也带上三个上下文字段（buildRecordWriteData 行为）
  for (const f of CONTEXT_FIELDS) if (context[f] !== undefined && resultData[f] === undefined) resultData[f] = context[f]

  const ts = parseDate(row.testDate) || new Date()
  return {
    record_code: row.record_code || `RC-${table}-${crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 24)}`,
    test_type: table,
    test_name: TEST_TYPE_LABELS[table] || table,
    sample_info: JSON.stringify(context),
    result_data: JSON.stringify(resultData),
    status: 'completed',
    created_by: null, // 由调用方填充
    created_at: ts,
    completed_at: ts,
  }
}

async function main() {
  const backupPath = process.argv[2] || BACKUP_DEFAULT
  const dryRun = process.argv.includes('--dry-run')

  if (!fs.existsSync(backupPath)) {
    console.error('备份文件不存在:', backupPath)
    process.exit(1)
  }
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'))
  const tables = backup.tables || {}
  const tableNames = Object.keys(tables)
  console.log(`备份版本: ${backup.version}, 时间戳: ${backup.timestamp}`)
  console.log(`目标租户: ${TARGET_SCHOOL_CODE} (schema=${TARGET_SCHEMA}), 模式: ${dryRun ? 'DRY-RUN 仅预览' : '正式导入'}\n`)

  const prisma = new PrismaClient()

  // ① 确认目标租户 schema 存在
  const schemaExists = await prisma.$queryRawUnsafe(
    'SELECT 1 FROM pg_namespace WHERE nspname = $1', TARGET_SCHEMA
  )
  if (!schemaExists.length) {
    console.error(`❌ 目标 schema ${TARGET_SCHEMA} 不存在，请先开通学校 ${TARGET_SCHOOL_CODE}`)
    await prisma.$disconnect()
    process.exit(1)
  }

  // ② 归属用户：target schema 中 username=manager 的 User.id
  const ownerRows = await prisma.$queryRawUnsafe(
    `SELECT "id" FROM "${TARGET_SCHEMA}"."User" WHERE "username" = $1 LIMIT 1`, OWNER_USERNAME
  )
  if (!ownerRows.length) {
    console.error(`❌ ${TARGET_SCHEMA} 中未找到用户 ${OWNER_USERNAME}，无法归属记录`)
    await prisma.$disconnect()
    process.exit(1)
  }
  const ownerId = ownerRows[0].id
  console.log(`归属用户: ${OWNER_USERNAME} (${ownerId})`)

  // ③ 整理 + 统计
  const plan = []
  let total = 0
  for (const table of tableNames) {
    const rows = tables[table]?.data || []
    if (!rows.length) { console.log(`[空] ${table}: 0 条`); continue }
    const mapped = rows.map(r => ({ ...mapRecord(table, r), created_by: ownerId }))
    plan.push({ table, rows: mapped })
    total += mapped.length
    console.log(`[整理] ${table}: ${rows.length} 条 → TestRecord ${mapped.length} 条`)
  }
  console.log(`\n合计整理 ${total} 条待导入记录。`)

  // 预览：每表打印 1 条整理结果
  if (dryRun) {
    console.log('\n===== 整理结果预览（每表第 1 条）=====')
    for (const { table, rows } of plan) {
      const r = rows[0]
      console.log(`\n--- ${table} (${rows.length} 条) ---`)
      console.log('record_code :', r.record_code)
      console.log('test_name   :', r.test_name)
      console.log('sample_info :', r.sample_info)
      console.log('result_data :', r.result_data)
      console.log('status      :', r.status, '| created_at:', r.created_at.toISOString(), '| created_by:', r.created_by)
    }
    console.log('\n[DRY-RUN] 未写库。确认无误后去掉 --dry-run 执行正式导入。')
    await prisma.$disconnect()
    return
  }

  // ④ 正式导入（按 record_code 幂等去重）
  let inserted = 0, skipped = 0, errors = 0
  for (const { table, rows } of plan) {
    for (const r of rows) {
      try {
        const exist = await prisma.$queryRawUnsafe(
          `SELECT 1 FROM "${TARGET_SCHEMA}"."TestRecord" WHERE "record_code" = $1 LIMIT 1`, r.record_code
        )
        if (exist.length) { skipped++; continue }
        await prisma.$executeRawUnsafe(
          `INSERT INTO "${TARGET_SCHEMA}"."TestRecord"
             ("id","record_code","test_type","test_name","sample_info","result_data","status",
              "created_by","created_at","updated_at","version","data_version","completed_at")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),0,1,$10)`,
          crypto.randomUUID(), r.record_code, r.test_type, r.test_name,
          r.sample_info, r.result_data, r.status, r.created_by, r.created_at, r.completed_at
        )
        inserted++
      } catch (e) {
        errors++
        console.error(`  ❌ ${table} ${r.record_code}: ${e.message}`)
      }
    }
  }
  const cnt = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "${TARGET_SCHEMA}"."TestRecord"`
  )
  console.log(`\n✅ 导入完成: 插入 ${inserted}, 跳过(已存在) ${skipped}, 失败 ${errors}; ${TARGET_SCHEMA}.TestRecord 现有 ${cnt[0].n} 条`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('导入失败:', e)
  process.exit(1)
})
