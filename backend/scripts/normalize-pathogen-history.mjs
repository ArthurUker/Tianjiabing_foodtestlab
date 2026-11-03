#!/usr/bin/env node
/**
 * 一次性归一：把**历史**病原体记录统一到"设备口径"（2026-11-03）
 *
 * 只改这些字段（检测值/时间/食堂/芯片/检测员一律不动）：
 *   result_data.allTestItems[].result   → 阴性 / 阳性（未检出、- 归为阴性）
 *   result_data.allTestItems[].isInternalControl（内标/内控/IC 补标记）
 *   result_data.positiveItems / positiveDetails / riskLevel / riskReason
 *   result_data.internalControlStatus   → 「内参: 阴性/阳性」
 *   recheckReports[]（复测轮次）同样处理
 *
 * 安全措施：
 *   · 默认 **dry-run**（只看不改），必须显式 `--apply` 才落库
 *   · 落库前把所有将被修改的原始 result_data 备份到 JSON 文件
 *   · 用乐观锁 CAS（where id+version）写入，避免覆盖并发修改
 *   · 幂等：已归一（无差异）的记录不动
 *
 * 用法：
 *   node scripts/normalize-pathogen-history.mjs                 # dry-run 全量
 *   node scripts/normalize-pathogen-history.mjs --schools tjb   # 只某校
 *   node scripts/normalize-pathogen-history.mjs --apply         # 真正写入
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { createTenantClient } from '../lib/tenantClient.js'
import { normalizePathogenResult } from '../lib/pathogenRisk.js'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const schoolArg = argv.indexOf('--schools')
const onlySchools = schoolArg >= 0 ? String(argv[schoolArg + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : null
const SAMPLE_SHOW = 12

const prisma = new PrismaClient()
const bkDir = process.env.DEVICE_BACKUP_DIR || '/var/lib/foodsentinel/backups'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

/** 只比较/写这几个业务字段 */
/**
 * 语义投影：只比对**本次确实要改**的东西，避免 cosmetic 差异（如 positiveDetails 多一个字段）
 * 造成"看起来要改、其实没变"的无谓写入。
 */
function projection(rd = {}) {
  const items = Array.isArray(rd.allTestItems) ? rd.allTestItems : []
  return JSON.stringify({
    判读: items.map((x) => String(x?.result ?? '')),
    内参标记: items.map((x) => (x?.isInternalControl ? 1 : 0)),
    阳性项: rd.positiveItems ?? null,
    阳性明细: (Array.isArray(rd.positiveDetails) ? rd.positiveDetails : []).map((x) => `${x?.pathogen}|${x?.ct}|${x?.ctRaw}`),
    风险: rd.riskLevel ?? null,
    理由: rd.riskReason ?? null,
    内参: rd.internalControlStatus ?? null,
  })
}
const same = (a, b) => String(a) === String(b)
const uniqJudgements = (items) => [...new Set((items || []).map((x) => String(x?.result ?? '')))]

async function main() {
  const schools = (await prisma.school.findMany({ where: { status: { not: 'deleted' } }, select: { code: true, name: true }, orderBy: { code: 'asc' } }))
    .filter((s) => !onlySchools || onlySchools.includes(s.code))

  console.log(`模式：${APPLY ? '**APPLY（真写入）**' : 'dry-run（只看不改）'}`)
  console.log(`学校：${schools.map((s) => s.code).join(', ')}`)

  const backup = []
  let scanned = 0
  let changedRecords = 0
  let changedRounds = 0
  const samples = []
  const perSchool = []

  for (const s of schools) {
    const db = createTenantClient(prisma, s.code)
    let rows = []
    try {
      // 只取有检测项的记录（批量导入/压测的空记录直接跳过，省时间）
      rows = await db.$queryRawUnsafe(`
        SELECT id, record_code, version, sample_info, result_data
          FROM "TestRecord"
         WHERE test_type = 'pathogen'
           AND jsonb_array_length(COALESCE(result_data->'allTestItems','[]'::jsonb)) > 0
         ORDER BY created_at ASC`)
    } catch (e) {
      console.warn(`  ${s.code} 读取失败（跳过）：${e.message}`)
      continue
    }

    let schoolChanged = 0
    for (const row of rows) {
      scanned += 1
      const rd = row.result_data || {}
      const after = normalizePathogenResult(rd)

      // 复测轮次同样归一
      const rounds = Array.isArray(rd.recheckReports) ? rd.recheckReports : []
      let roundsChanged = 0
      const roundProj = (x = {}) => JSON.stringify({
        判读: (Array.isArray(x.allTestItems) ? x.allTestItems : []).map((i) => String(i?.result ?? '')),
        阳性项: x.positiveItems ?? null,
        明细: (Array.isArray(x.positiveDetails) ? x.positiveDetails : []).map((d) => `${d?.pathogen}|${d?.ct}|${d?.ctRaw}`),
        风险: x.riskLevel ?? null,
        理由: x.riskReason ?? null,
      })
      const newRounds = rounds.map((r) => {
        if (!r || !Array.isArray(r.allTestItems) || !r.allTestItems.length) return r
        const rAfter = normalizePathogenResult({ ...r })
        const dirty = !same(roundProj(r), roundProj(rAfter))
        if (!dirty) return r
        roundsChanged += 1
        return {
          ...r,
          allTestItems: rAfter.allTestItems,
          positiveItems: rAfter.positiveItems,
          positiveDetails: rAfter.positiveDetails,
          riskLevel: rAfter.riskLevel,
          riskReason: rAfter.riskReason,
        }
      })

      const afterPick = {
        allTestItems: after.allTestItems,
        positiveItems: after.positiveItems,
        positiveDetails: after.positiveDetails,
        riskLevel: after.riskLevel,
        riskReason: after.riskReason,
        internalControlStatus: after.internalControlStatus,
      }
      const dirty = !same(projection(rd), projection(afterPick)) || roundsChanged > 0
      if (!dirty) continue

      changedRecords += 1
      schoolChanged += 1
      changedRounds += roundsChanged
      if (samples.length < SAMPLE_SHOW) {
        samples.push({
          school: s.code,
          record_code: row.record_code,
          testDate: row.sample_info?.testDate,
          canteen: row.sample_info?.canteen,
          before: { 判读: uniqJudgements(rd.allTestItems), 阳性项: rd.positiveItems, 风险: rd.riskLevel, 内参: rd.internalControlStatus },
          after: { 判读: uniqJudgements(afterPick.allTestItems), 阳性项: afterPick.positiveItems, 风险: afterPick.riskLevel, 内参: afterPick.internalControlStatus },
          roundsChanged,
        })
      }

      if (APPLY) {
        backup.push({ id: row.id, record_code: row.record_code, version: row.version, result_data: rd })
        const data = { result_data: { ...rd, ...afterPick }, version: { increment: 1 } }
        const upd = await db.testRecord.updateMany({ where: { id: row.id, version: row.version }, data })
        if (!upd || upd.count !== 1) console.warn(`  ⚠ 乐观锁冲突跳过：${row.record_code}`)
      }
    }
    perSchool.push(`${s.code}(${s.name}): ${rows.length} 条扫描，${schoolChanged} 条修改`)
    console.log(`  ${s.code}：扫描 ${rows.length} 条，需修改 ${schoolChanged} 条`)
  }

  console.log('\n=== 汇总 ===')
  perSchool.forEach((l) => console.log('  ' + l))
  console.log(`  合计：扫描 ${scanned} 条，需修改 ${changedRecords} 条（含复测轮次 ${changedRounds} 个）`)

  if (samples.length) {
    console.log('\n=== 改前 / 改后（样例，最多 12 条） ===')
    for (const x of samples) {
      console.log(`\n  ${x.school} ${String(x.record_code).slice(0, 34)}…（${x.testDate} / ${x.canteen}）${x.roundsChanged ? ` 轮次改动 ${x.roundsChanged}` : ''}`)
      console.log('    判读 :', JSON.stringify(x.before.判读), '→', JSON.stringify(x.after.判读))
      console.log('    阳性 :', JSON.stringify(x.before.阳性项), '→', JSON.stringify(x.after.阳性项))
      console.log('    风险 :', x.before.风险, '→', x.after.风险)
      console.log('    内参 :', JSON.stringify(x.before.内参), '→', JSON.stringify(x.after.内参))
    }
  }

  if (APPLY && backup.length) {
    await fs.mkdir(bkDir, { recursive: true, mode: 0o700 })
    const file = path.join(bkDir, `pathogen-normalize-${stamp}.json`)
    await fs.writeFile(file, JSON.stringify(backup, null, 0), { mode: 0o600 })
    console.log(`\n备份已写入：${file}（${backup.length} 条原始 result_data，可据此回滚）`)
  } else if (!APPLY) {
    console.log('\n（dry-run 未写入任何数据；确认无误后加 --apply 执行）')
  }
}

main()
  .catch((e) => { console.error('执行异常：', e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
