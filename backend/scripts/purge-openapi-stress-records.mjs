// purge-openapi-stress-records.mjs — 清除开放接口租户中的压测数据（2026-11-20）
//
// 背景（DeepSeek 两轮联调复核 + 全量修复）：
//   2026-10 的压测在 school_test 灌入 5,817 条记录（占全量 98.9%），其中两台
//   ZZTT-STRESS-01 设备分别累积 977 / 416 轮 recheckReports（单条 result_data
//   1.28MB / 0.55MB），污染了开放接口的对账基线（manifest digest / stats /
//   客户留档的 records.csv）。其中「高风险」样本实际为压测产物，非真实事件。
//
// 做法（幂等 / 可审计 / 默认 dry-run）：
//   · 候选 = sample_info.inspector='压测员' OR result_data.deviceNo LIKE 'ZZTT-STRESS-%'
//   · --apply 前先导出命中记录完整 JSON 备份（0600，写入成功且大小校验通过才删除）
//   · 单事务 DELETE，仅删除候选集合；打印清理前后总数与数据画像
//
// 用法：
//   # 只读预演（默认）
//   node backend/scripts/purge-openapi-stress-records.mjs --school test
//   # 执行（需显式 --apply；备份路径可覆盖）
//   node backend/scripts/purge-openapi-stress-records.mjs --school test --apply \
//     --backup /mnt/datadisk0/foodsentinel/backups/openapi-stress-purge-<ts>.json
//
// ⚠️ 该操作会显著改变开放接口的 manifest digest 与统计口径；执行前必须与对接方
//    约定「基线重置」（客户端丢弃旧 records.csv 基线并全量重拉一次）。

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { schemaNameOf, assertSafeSchemaName } from '../lib/tenantClient.js'

const args = process.argv.slice(2)
const argOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}
const SCHOOL = argOf('--school')
const APPLY = args.includes('--apply')
const BACKUP = argOf('--backup')

if (!SCHOOL) {
  console.error(JSON.stringify({ ok: false, code: 'E_ARG', message: '用法：--school <学校码> [--apply] [--backup <path>]' }))
  process.exit(1)
}

const schema = schemaNameOf(SCHOOL)
assertSafeSchemaName(schema)

const MATCH_SQL = `("sample_info"->>'inspector' = '压测员' OR COALESCE("result_data"->>'deviceNo','') LIKE 'ZZTT-STRESS-%')`
// eslint-disable-next-line no-restricted-syntax -- 一次性运维脚本：需跨租户 schema 直接读写，无请求上下文（与 005_cleanup-old-schemas.mjs 同模式）
const prisma = new PrismaClient()

const rows = await prisma.$queryRawUnsafe(
  `SELECT "id", "record_code", "test_type", "status", "version", "created_at", "updated_at", "sample_info", "result_data"
     FROM "${schema}"."TestRecord"
    WHERE ${MATCH_SQL}
    ORDER BY "record_code" ASC`,
)
const [{ total }] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS total FROM "${schema}"."TestRecord"`)
const bytes = rows.reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r.result_data || {}), 'utf8'), 0)

const profile = await prisma.$queryRawUnsafe(
  `SELECT count(*)::int AS remain,
          count(*) FILTER (WHERE COALESCE("result_data"->>'riskLevel','') NOT IN ('', '无风险'))::int AS risky
     FROM "${schema}"."TestRecord"
    WHERE NOT ${MATCH_SQL}`,
)

console.log(JSON.stringify({
  ok: true,
  school: SCHOOL,
  schema,
  totalBefore: Number(total),
  matched: rows.length,
  matchedBytes: bytes,
  remainAfter: Number(profile[0].remain),
  remainRisky: Number(profile[0].risky),
  apply: APPLY,
  samples: rows.slice(0, 5).map((r) => ({
    record_code: r.record_code,
    test_type: r.test_type,
    version: Number(r.version),
    result_bytes: Buffer.byteLength(JSON.stringify(r.result_data || {}), 'utf8'),
  })),
}, null, 2))

if (!APPLY) {
  console.log('\n[dry-run] 未删除任何记录。确认后加 --apply 执行（必须先与对接方约定基线重置）。')
  await prisma.$disconnect()
  process.exit(0)
}

if (rows.length === 0) {
  console.log('[apply] 命中 0 条，幂等结束。')
  await prisma.$disconnect()
  process.exit(0)
}

// ── 备份（先落盘并校验，再删除）──
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const backupPath = BACKUP || path.join('/mnt/datadisk0/foodsentinel/backups', `openapi-stress-purge-${SCHOOL}-${ts}.json`)
fs.mkdirSync(path.dirname(backupPath), { recursive: true })
const payload = JSON.stringify({
  school: SCHOOL,
  schema,
  created_at: new Date().toISOString(),
  match_rule: MATCH_SQL,
  count: rows.length,
  rows,
})
fs.writeFileSync(backupPath, payload, { mode: 0o600 })
const written = fs.statSync(backupPath).size
if (written !== Buffer.byteLength(payload, 'utf8')) {
  console.error(JSON.stringify({ ok: false, code: 'E_BACKUP_SIZE', backupPath, written }))
  process.exit(1)
}
console.log(JSON.stringify({ backup: backupPath, backupBytes: written }))

// ── 事务删除（仅命中集合）──
const ids = rows.map((r) => r.id)
const deleted = await prisma.$transaction(async (tx) => {
  return tx.$executeRawUnsafe(
    `DELETE FROM "${schema}"."TestRecord" WHERE "id" = ANY($1::text[])`,
    ids,
  )
})
console.log(JSON.stringify({ ok: true, deleted: Number(deleted), backup: backupPath }))

const after = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS total FROM "${schema}"."TestRecord"`)
console.log(JSON.stringify({ ok: true, totalAfter: Number(after[0].total), note: '请通知对接方丢弃旧基线并全量重拉（manifest digest 已变化）' }))

await prisma.$disconnect()
