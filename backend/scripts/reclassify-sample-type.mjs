#!/usr/bin/env node
/**
 * 历史样本类型重分类（2026-11-03）
 *
 * 背景：旧口径下"样本类型"在手动导入侧看**项目名称**、设备侧只看"水"字，
 *   导致 68 条"洗碗机水样"被记成"食品/环境样本""环境样本"。
 * 新口径（用户确认）：洗碗机水样 / 食品样本 / 餐具·工用具涂抹样 / 环境样本 / 其他样本，
 *   一律按**样本描述**（result_data.sampleInfo）分类。
 *
 * 用法：
 *   node scripts/reclassify-sample-type.mjs            # dry-run（默认）
 *   node scripts/reclassify-sample-type.mjs --apply    # 落库（先备份）
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { createTenantClient } from '../lib/tenantClient.js'
import { classifySampleType } from '../lib/pathogenRisk.js'

const APPLY = process.argv.includes('--apply')
const bkDir = '/var/lib/foodsentinel/backups'
const prisma = new PrismaClient()

const dist = new Map()      // `${from} → ${to}` => count
const samples = []

async function main() {
  const schools = await prisma.school.findMany({ where: { status: { not: 'deleted' } }, select: { code: true, name: true }, orderBy: { code: 'asc' } })
  console.log(`模式：${APPLY ? '**APPLY**' : 'dry-run'}｜学校：${schools.map((s) => s.code).join(', ')}`)
  const backup = []
  let changed = 0
  let scanned = 0

  for (const s of schools) {
    const db = createTenantClient(prisma, s.code)
    const rows = await db.$queryRawUnsafe(`
      SELECT id, record_code, version, sample_info, result_data
        FROM "TestRecord"
       WHERE test_type = 'pathogen'
         AND COALESCE(result_data->>'sampleInfo','') <> ''`).catch((e) => {
      console.warn(`  ${s.code} 读取失败：${e.message}`)
      return []
    })
    let schoolChanged = 0
    for (const row of rows) {
      scanned += 1
      const rd = row.result_data || {}
      const from = rd.sampleType || '（空）'
      const to = classifySampleType(rd.sampleInfo)
      if (from === to) continue
      changed += 1
      schoolChanged += 1
      const key = `${from} → ${to}`
      dist.set(key, (dist.get(key) || 0) + 1)
      if (samples.length < 12) samples.push({ school: s.code, d: row.sample_info?.testDate, desc: rd.sampleInfo, from, to })
      if (APPLY) {
        backup.push({ school: s.code, id: row.id, record_code: row.record_code, sample_type: from })
        const upd = await db.testRecord.updateMany({
          where: { id: row.id, version: row.version },
          data: { result_data: { ...rd, sampleType: to }, version: { increment: 1 } },
        })
        if (!upd || upd.count !== 1) console.warn(`  ⚠ 乐观锁冲突跳过：${row.record_code}`)
      }
    }
    console.log(`  ${s.code}：扫描 ${rows.length} 条，需改 ${schoolChanged} 条`)
  }

  console.log('\n=== 变化分布 ===')
  ;[...dist.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k} ：${v} 条`))
  console.log(`\n合计：扫描 ${scanned} 条，需改 ${changed} 条`)

  if (samples.length) {
    console.log('\n=== 样例 ===')
    samples.forEach((x) => console.log(`  ${x.school} ${x.d || '—'} ｜ ${x.desc} ｜ ${x.from} → ${x.to}`))
  }

  if (APPLY && backup.length) {
    await fs.mkdir(bkDir, { recursive: true, mode: 0o700 })
    const f = path.join(bkDir, `sample-type-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await fs.writeFile(f, JSON.stringify(backup), { mode: 0o600 })
    console.log(`\n备份：${f}（${backup.length} 条）`)
  } else if (!APPLY) {
    console.log('\n（dry-run 未写入；确认后加 --apply）')
  }
}

main()
  .catch((e) => { console.error('执行异常：', e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
