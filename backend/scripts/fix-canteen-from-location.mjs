// fix-canteen-from-location.mjs
// -----------------------------------------------------------------------------
// 背景：
//   田家炳中学等学校的餐具/通用检测记录中，部分记录的 sample_info.canteen（食堂）
//   为空，而 sample_info.location 被误填成了「检测点位 / 设备芯片编号」（如"芯片编号"）。
//   看板 getRecordCanteen() 曾把 location 回退成食堂名，导致"各食堂合格率对比"图
//   冒出"芯片编号"之类的假食堂。Dashboard.js / GenericTest.js 已修复取值逻辑，
//   但入库的历史脏数据仍需补正。
//
// 本脚本职责：
//   1. 找出指定学校下 canteen 为空、但 location 非空的 TestRecord
//   2. 若 location 值命中「合法食堂名列表」→ 安全回填到 canteen（location 清空，避免歧义）
//   3. 若 location 值不像食堂名（如"芯片编号""餐具表面""操作台"）→ 收集进「待人工处理」清单
//
// 默认 dry-run（只扫描+打印，不写入）。加 --fix 才真正 UPDATE。
// 用法：
//   node scripts/fix-canteen-from-location.mjs [--school tianjiabing] [--fix]
// -----------------------------------------------------------------------------

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

// 合法食堂名（与表单下拉一致）。可按需扩充。
const VALID_CANTEENS = new Set(['一食堂', '二食堂', '三食堂', '四食堂', '五食堂', '六食堂'])

const args = process.argv.slice(2)
const schoolArg = (args.find((a) => a.startsWith('--school=')) || '--school=tianjiabing').split('=')[1]
const dryRun = !args.includes('--fix')

const prisma = new PrismaClient()

function parseJSON(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback
  } catch {
    return fallback
  }
}

async function main() {
  // 1) 找到该校用户
  const users = await prisma.user.findMany({
    where: { school_code: schoolArg },
    select: { id: true, username: true, full_name: true },
  })
  if (users.length === 0) {
    console.error(`未找到 school_code="${schoolArg}" 的用户，请确认学校代码。`)
    await prisma.$disconnect()
    process.exit(1)
  }
  const userIds = users.map((u) => u.id)
  console.log(`学校 ${schoolArg}：命中用户 ${users.length} 个 → ${users.map((u) => u.username).join(', ')}`)

  // 2) 拉取这些用户创建的、canteen 为空的记录
  const records = await prisma.testRecord.findMany({
    where: { created_by: { in: userIds } },
    select: { id: true, record_code: true, test_type: true, sample_info: true },
  })

  const fixed = []
  const needReview = []

  for (const r of records) {
    const info = parseJSON(r.sample_info, {})
    const canteen = (info.canteen || '').toString().trim()
    const location = (info.location || '').toString().trim()
    if (canteen || !location) continue // canteen 有值 或 location 为空 → 跳过

    if (VALID_CANTEENS.has(location)) {
      fixed.push({ id: r.id, record_code: r.record_code, test_type: r.test_type, from: location, to: location })
    } else {
      needReview.push({ id: r.id, record_code: r.record_code, test_type: r.test_type, badLocation: location })
    }
  }

  console.log(`\n扫描记录总数: ${records.length}`)
  console.log(`可直接回填(canteen=location且location为合法食堂名): ${fixed.length}`)
  console.log(`需人工处理(location非食堂名，如芯片编号/检测点位): ${needReview.length}`)

  if (fixed.length) {
    console.log('\n--- 可回填清单 ---')
    for (const f of fixed) console.log(`  [${f.test_type}] ${f.record_code}  location="${f.from}" → canteen="${f.to}"`)
  }
  if (needReview.length) {
    console.log('\n--- 待人工处理清单（location 不是食堂名，需手动指定正确食堂）---')
    for (const n of needReview) console.log(`  [${n.test_type}] ${n.record_code}  错误location="${n.badLocation}"`)
  }

  if (dryRun) {
    console.log('\n[dry-run] 未写入任何数据。确认无误后加 --fix 执行回填。')
    await prisma.$disconnect()
    return
  }

  // 3) 真正回填
  let done = 0
  for (const f of fixed) {
    const info = parseJSON(
      (await prisma.testRecord.findUnique({ where: { id: f.id }, select: { sample_info: true } })).sample_info,
      {}
    )
    info.canteen = f.to
    delete info.location // 清空 location，避免再次被误读为食堂
    await prisma.testRecord.update({
      where: { id: f.id },
      data: { sample_info: JSON.stringify(info) },
    })
    done++
  }
  console.log(`\n[fix] 已回填 ${done} 条。待人工处理的 ${needReview.length} 条未改动。`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('执行失败:', e)
  await prisma.$disconnect()
  process.exit(1)
})
