// repair-ct-fallback-records.mjs — 清除「荧光兜底判读」污染的历史记录（2026-11-18）
//
// 背景：2026-11-04 上线的兜底判读在设备 CTList 全为 "-" 时，用荧光曲线按
//   「基线 + 10σ」推算 Ct。实测该阈值对**基线漂移**同样触发（45 循环只涨 30%、
//   末段斜率恒定、无指数段与平台），把漂移判成扩增 → 记录出现设备端没有的阳性项。
//   现已移除兜底（lib/fluorescenceFallback.js 删除），本脚本按**设备原始判读**重算受影响记录。
//
// 做法：
//   · 只取 result_data 含 ct_fallback_computed 的记录（幂等：修完再跑命中 0 条）
//   · 以 result_data.rawDetection 的 parms/resultList/ctList 为唯一事实来源重算
//     positiveItems / positiveDetails / riskLevel / riskReason / allTestItems / internalControlStatus
//   · 删除 fallbackAnalysis 与 ct_fallback_computed 复核标记（其它标记如食堂不在名单保留）
//   · 追加 modificationLogs 审计条目（含修前/修后结论）
//
// 用法：node backend/scripts/repair-ct-fallback-records.mjs [--dry-run]

import { PrismaClient } from '@prisma/client'
import { createTenantClient, schemaNameOf } from '../lib/tenantClient.js'
import { calculateDeviceRisk } from '../lib/pathogenDevice.js'
import { INTERNAL_CONTROL_RE } from '../lib/pathogenRisk.js'

const DRY = process.argv.includes('--dry-run')
const prisma = new PrismaClient()

function rebuild(resultData) {
  const rd = resultData.rawDetection || {}
  const parms = rd.parms || {}
  const results = rd.resultList || {}
  const cts = rd.ctList || {}
  const points = Object.keys(parms).map((key) => ({
    key,
    name: parms[key],
    positive: results[key] === true,
    ctRaw: cts[key],
  }))
  const risk = calculateDeviceRisk(points)
  const items = points
    .filter((p) => p.name && p.name !== '-' && p.name !== '—')
    .map((p, i) => ({
      no: i + 1,
      pathogen: p.name,
      channel: p.key,
      ct: p.ctRaw,
      result: p.positive ? '阳性' : '阴性',
      isInternalControl: INTERNAL_CONTROL_RE.test(p.name),
    }))
  const ic = items.filter((it) => it.isInternalControl).map((it) => `${it.pathogen}: ${it.result}`).join(', ') || '无内标数据'

  const next = {
    ...resultData,
    positiveItems: risk.positiveItemsDisplay,
    positiveDetails: risk.positiveDetails,
    riskLevel: risk.riskLevel,
    riskReason: risk.riskReason,
    allTestItems: items,
    internalControlStatus: ic,
  }
  delete next.fallbackAnalysis
  next.reviewFlags = (next.reviewFlags || []).filter((f) => f?.type !== 'ct_fallback_computed')
  next.modificationLogs = [
    ...(next.modificationLogs || []),
    {
      at: new Date().toISOString(),
      by: 'system',
      action: 'recalculate',
      reason: '移除荧光兜底判读（2026-11-18）：兜底把基线漂移判成扩增，按设备原始判读重算',
      before: { positiveItems: resultData.positiveItems || null, riskLevel: resultData.riskLevel || null },
      after: { positiveItems: risk.positiveItemsDisplay, riskLevel: risk.riskLevel },
    },
  ]
  return next
}

const schools = await prisma.$queryRawUnsafe('SELECT code FROM public."School" ORDER BY code')
let touched = 0
for (const { code } of schools) {
  const schema = schemaNameOf(code)
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, record_code, sample_info, result_data FROM "${schema}"."TestRecord"
       WHERE result_data::text LIKE '%ct_fallback_computed%'
          OR result_data::text LIKE '%"ctSource":"fallback"%'
          OR result_data ? 'fallbackAnalysis'`,
  ).catch(() => [])
  if (!rows.length) continue
  const db = createTenantClient(prisma, code)
  for (const row of rows) {
    const next = rebuild(row.result_data)
    console.log(
      `${DRY ? '[dry]' : '[fix]'} ${schema} ${row.record_code} ` +
      `阳性「${row.result_data.positiveItems || '无'}」/ ${row.result_data.riskLevel} → 「${next.positiveItems}」/ ${next.riskLevel}`,
    )
    if (!DRY) await db.testRecord.update({ where: { id: row.id }, data: { result_data: next } })
    touched += 1
  }
}
console.log(`\n${DRY ? '将修复' : '已修复'} ${touched} 条记录`)
await prisma.$disconnect()
