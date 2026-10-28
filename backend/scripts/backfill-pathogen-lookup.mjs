#!/usr/bin/env node
/**
 * 回填病原体检测记录的检索派生列（chip_nos / case_key）
 *
 * 背景：迁移 20261028120000_pathogen_record_lookup_indexes 给 TestRecord 增加了
 *   `chip_nos TEXT[]`（自身芯片 + 各复测轮次芯片，GIN 索引）与 `case_key TEXT`（档案键），
 *   用于把「取最近 300/20 条再内存比对」改为精确查询。新写入由上传路由维护；
 *   **历史记录**需用本脚本补齐，否则老记录会因 case_key 为空而在判重/合并时被跳过。
 *
 * 口径：与写入路径**完全同源**（复用 lib/pathogenDevice.js 的 normalizeChipNumber / buildCaseKey），
 *   不手写 SQL 归一化，避免时区/空格/大小写口径差。
 *
 * 幂等：只处理 `case_key IS NULL` 的行；可重复执行。
 *
 * 用法：
 *   node scripts/backfill-pathogen-lookup.mjs            # 实际写入
 *   node scripts/backfill-pathogen-lookup.mjs --dry-run  # 只统计，不写
 */
import { PrismaClient } from '@prisma/client'
import { createTenantClient } from '../lib/tenantClient.js'
import { normalizeChipNumber, buildCaseKey } from '../lib/pathogenDevice.js'

const DRY = process.argv.includes('--dry-run')
const prisma = new PrismaClient()

function deriveColumns(rec) {
  const rd = rec.result_data || {}
  const si = rec.sample_info || {}
  const own = normalizeChipNumber(rd?.chip?.number)
  const rounds = Array.isArray(rd.recheckReports) ? rd.recheckReports : []
  const chips = [own, ...rounds.map((x) => normalizeChipNumber(x?.chipNumber))].filter(Boolean)
  const chipNos = [...new Set(chips)]
  const caseKey = buildCaseKey({
    canteen: si.canteen,
    sampleType: rd.sampleType,
    sampleInfo: rd.sampleInfo,
    deviceNo: rd.deviceNo,
    sampleId: rd.sampleId,
  })
  return { chipNos, caseKey }
}

async function main() {
  const schools = await prisma.school.findMany({
    where: { status: { not: 'deleted' } },
    select: { code: true, name: true },
    orderBy: { code: 'asc' },
  })
  console.log(`回填开始${DRY ? '（dry-run，不写库）' : ''}：${schools.length} 所学校`)
  let totalUpdated = 0
  let totalFailed = 0

  for (const s of schools) {
    let db
    try {
      db = createTenantClient(prisma, s.code)
    } catch (e) {
      console.warn(`  跳过 ${s.code}：租户客户端不可用（${e.message}）`)
      continue
    }
    let updated = 0
    // 反复取「case_key 为空」的前 N 条，直到没有（更新后即不再命中，天然终止）
    for (;;) {
      const rows = await db.testRecord.findMany({
        where: { test_type: 'pathogen', case_key: null },
        select: { id: true, record_code: true, result_data: true, sample_info: true },
        orderBy: { created_at: 'asc' },
        take: 200,
      }).catch((e) => {
        console.warn(`  读取失败 ${s.code}：${e.message}`)
        return []
      })
      if (!rows.length) break
      for (const r of rows) {
        const { chipNos, caseKey } = deriveColumns(r)
        if (DRY) { updated += 1; continue }
        try {
          await db.testRecord.update({ where: { id: r.id }, data: { chip_nos: chipNos, case_key: caseKey } })
          updated += 1
        } catch (e) {
          totalFailed += 1
          console.warn(`  更新失败 ${s.code}/${r.record_code}：${e.message}`)
        }
      }
      if (DRY) break
    }
    totalUpdated += updated
    console.log(`  ${s.code}（${s.name}）：${updated} 条`)
  }

  console.log(`\n回填完成${DRY ? '（dry-run）' : ''}：更新 ${totalUpdated} 条，失败 ${totalFailed} 条`)
  if (totalFailed > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error('回填异常：', e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
