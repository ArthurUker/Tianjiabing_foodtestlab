#!/usr/bin/env node
/**
 * 清理过期的设备原始报文归档（2026-11-03）
 *
 * 归档策略见 lib/devicePayloadArchive.js：按天目录、gzip、默认保留 90 天。
 * 用法：
 *   node scripts/prune-device-payloads.mjs               # 按 DEVICE_PAYLOAD_RETENTION_DAYS（默认 90）清理
 *   node scripts/prune-device-payloads.mjs --days 30     # 指定保留天数
 *   node scripts/prune-device-payloads.mjs --dry-run     # 只统计不删除
 *
 * 建议 crontab（每天 04:20）：
 *   20 4 * * * cd /opt/foodsentinel/backend && /usr/bin/node scripts/prune-device-payloads.mjs >> /var/log/foodsentinel/payload-prune.log 2>&1
 */
import { pruneArchivedPayloads, PAYLOAD_DIR, RETENTION_DAYS } from '../lib/devicePayloadArchive.js'

const argv = process.argv.slice(2)
const daysArg = argv.indexOf('--days')
const days = daysArg >= 0 ? Number(argv[daysArg + 1]) : RETENTION_DAYS
const dryRun = argv.includes('--dry-run')

console.log(`归档目录: ${PAYLOAD_DIR}`)
console.log(`保留天数: ${days}${dryRun ? '（dry-run，不删除）' : ''}`)
const r = await pruneArchivedPayloads({ days, dryRun })
console.log(`扫描日目录 ${r.scanned} 个｜删除 ${r.removed} 个${r.skipped ? `｜${r.skipped}` : ''}`)
