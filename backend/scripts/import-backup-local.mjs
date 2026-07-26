// import-backup-local.mjs — 将旧版备份 JSON（tables.{表}.data[]）导入本地测试的 public schema。
//
// 旧备份结构：{ version, timestamp, tables: { tableware:{data:[...]}, pesticide:{...}, oil:{...}, leanMeat:{...}, pathogen:{...} } }
// 新系统结构：统一存 TestRecord（test_type + sample_info(JSON) + result_data(JSON) + created_by）。
//
// 映射：
//   - test_type   = 旧表名（tableware/pesticide/oil/leanMeat/pathogen，与新系统一致）
//   - record_code = IMPORT-{表}-{旧id}（幂等，重复运行自动跳过）
//   - sample_info = 样本/上下文字段
//   - result_data = 检测结果字段（保持原始全部字段，无数据丢失）
//   - status      = completed（历史数据视为已完成）
//   - created_by  = admin 用户（本地测试 platform 账号）
//   - created_at  = 由 testDate 推断（无效则 now）
//
// 用法：node scripts/import-backup-local.mjs [备份文件路径]

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import fs from 'fs'

const BACKUP_DEFAULT = '/var/folders/6v/sk5g296520z6hvn1q3v9_xnr0000gn/T/codebuddy-dropped-files/f2aea884-4d90-45f3-b9d9-519207b9150f/lab_backup_2026-05-22.json'
const backupPath = process.argv[2] || BACKUP_DEFAULT

const TEST_NAME = {
  tableware: '餐具洁净度检测',
  pesticide: '农药残留检测',
  oil: '食用油检测',
  leanMeat: '瘦肉精检测',
  pathogen: '病原体检测',
}

// 各表「样本/上下文」字段（存入 sample_info）；其余结果字段存入 result_data
const SAMPLE_FIELDS = {
  tableware: ['canteen', 'location', 'testDate', 'testType', 'inspector'],
  pesticide: ['canteen', 'testDate', 'inspector', 'vegetableType', 'batchNo'],
  oil: ['canteen', 'testDate', 'inspector'],
  leanMeat: ['canteen', 'testDate', 'inspector', 'meatType', 'batchNo'],
  pathogen: ['canteen', 'sampleId', 'testDate', 'inspector', 'sampleInfo', 'sampleType'],
}

function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

function drop(obj, keys) {
  const out = {}
  const skip = new Set(keys)
  for (const [k, v] of Object.entries(obj)) if (!skip.has(k)) out[k] = v
  return out
}

function parseDate(s) {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

async function main() {
  if (!fs.existsSync(backupPath)) {
    console.error('备份文件不存在:', backupPath)
    process.exit(1)
  }
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'))
  const tables = backup.tables || {}
  console.log(`备份版本: ${backup.version}, 时间戳: ${backup.timestamp}`)
  console.log('包含表:', Object.keys(tables).join(', '))

  const prisma = new PrismaClient()
  const admin = await prisma.user.findFirst({ where: { username: 'admin' } })
  if (!admin) {
    console.error('未找到 admin 用户，请先 seed。')
    await prisma.$disconnect()
    process.exit(1)
  }
  console.log('导入归属用户:', admin.username, admin.id, '(school_code=', admin.school_code, '→ public)')

  let totalImported = 0
  let totalSkipped = 0
  const summary = {}

  for (const [table, obj] of Object.entries(tables)) {
    const rows = obj?.data || []
    let imported = 0
    let skipped = 0
    const sampleFields = SAMPLE_FIELDS[table] || []
    for (const row of rows) {
      const oldId = row.id
      const recordCode = `IMPORT-${table}-${oldId}`
      const existing = await prisma.testRecord.findUnique({ where: { record_code: recordCode } })
      if (existing) {
        skipped++
        continue
      }
      const sampleInfo = pick(row, sampleFields)
      const resultData = drop(row, [...sampleFields, 'id', '_status'])
      const ts = parseDate(row.testDate) || new Date()
      await prisma.testRecord.create({
        data: {
          record_code: recordCode,
          test_type: table,
          test_name: TEST_NAME[table] || table,
          sample_info: JSON.stringify(sampleInfo),
          result_data: JSON.stringify(resultData),
          status: 'completed',
          created_by: admin.id,
          created_at: ts,
          updated_at: ts,
          completed_at: ts,
        },
      })
      imported++
    }
    summary[table] = { total: rows.length, imported, skipped }
    totalImported += imported
    totalSkipped += skipped
    console.log(`- ${table}: 共 ${rows.length} 条，新增 ${imported}，跳过(已存在) ${skipped}`)
  }

  const finalCount = await prisma.testRecord.count()
  await prisma.$disconnect()
  console.log('\n=== 导入完成 ===')
  console.log('本次新增:', totalImported, ' 跳过(已存在):', totalSkipped)
  console.log('public schema TestRecord 当前总数:', finalCount)
}

main().catch(async (e) => {
  console.error('导入失败:', e)
  process.exit(1)
})
