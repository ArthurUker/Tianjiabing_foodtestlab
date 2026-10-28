#!/usr/bin/env node
/**
 * 病原体设备上报接口 · 压测脚本（2026-10-28，P0 阶段）
 *
 * 用途：验证「设备测试完自动上传」在**并发 / 规模**下的数据正确性（不是跑分）。
 * 目标环境：测试学校（school=test）+ 临时压测设备 ZZTT-STRESS-01。
 *
 * 用法：
 *   node scripts/stress-pathogen-upload.mjs dup          # ① 并发同芯片双传（幂等）
 *   node scripts/stress-pathogen-upload.mjs rounds       # ② 并发不同芯片并入同一档案（轮次）
 *   node scripts/stress-pathogen-upload.mjs mixed        # ③ 混合并发
 *   node scripts/stress-pathogen-upload.mjs prep-scale 5000   # ④-a 灌历史记录（超过 300 条窗口）
 *   node scripts/stress-pathogen-upload.mjs scale <chip> # ④-b 重传老芯片（应幂等）
 *   node scripts/stress-pathogen-upload.mjs rate         # ⑥ 平台限流边界（429）
 *
 * 环境变量：STRESS_KEY（压测设备密钥）、BASE_URL（默认 http://127.0.0.1:3002）
 */
import { PrismaClient } from '@prisma/client'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3002'
const KEY = process.env.STRESS_KEY
const DEVICE = 'ZZTT-STRESS-01'
const prisma = new PrismaClient()

if (!KEY) { console.error('缺少 STRESS_KEY'); process.exit(1) }

const today = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const stamp = () => Date.now().toString(36).toUpperCase()

function payload({ chip, sampleId, detectionTime = `${today()} 09:00:00`, endTime = `${today()} 09:30:00`, positive = false }) {
  return {
    DeviceNo: DEVICE,
    DetectionDateTime: detectionTime,
    DetectionEndDateTime: endTime,
    SampleStr: '一食堂 餐盘涂抹样',
    DetectionPeopleStr: '压测员',
    DetectionNumber: sampleId,
    FileName: `stress_${chip}.vhfl`,
    ChipID: 'TS001',
    ChipName: '四通道微流控芯片',
    ChipNumber: chip,
    Parms: { 'FAM-1': 'ORF1ab', 'FAM-2': 'N', 'HEX-1': '内参' },
    OptimizationDataLists: { 'FAM-1': [0.1, 0.2], 'FAM-2': [0.1, 0.2], 'HEX-1': [0.1, 0.2] },
    ResultList: { 'FAM-1': positive, 'FAM-2': false, 'HEX-1': true },
    CTList: { 'FAM-1': positive ? '22.5' : '-', 'FAM-2': '-', 'HEX-1': '27.0' },
  }
}

async function post(body) {
  const started = Date.now()
  const res = await fetch(`${BASE}/api/open/pathogen-device/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON（网关错误页等） */ }
  return { status: res.status, json, text: text.slice(0, 200), ms: Date.now() - started }
}

const q = (sql, ...args) => prisma.$queryRawUnsafe(sql, ...args)

async function recordsByChip(chip) {
  return q(`SELECT record_code, chip_nos FROM school_test."TestRecord" WHERE test_type='pathogen' AND chip_nos @> ARRAY[$1]::text[]`, chip)
}
async function recordByCaseKey(caseKey) {
  const rows = await q(`SELECT record_code, result_data, sample_info FROM school_test."TestRecord" WHERE test_type='pathogen' AND case_key=$1 ORDER BY created_at DESC LIMIT 1`, caseKey)
  return rows[0] || null
}


/** 加严校验：同一芯片在「记录本体 + 各复测轮次」中出现次数（应恰好 1；>1 = 被重复并入） */
async function chipOccurrences(chip) {
  const rows = await q(`
    WITH flat AS (
      SELECT record_code, upper(regexp_replace(COALESCE(result_data->'chip'->>'number',''), '\\s','','g')) AS chip
        FROM school_test."TestRecord" WHERE test_type='pathogen'
      UNION ALL
      SELECT r.record_code, upper(regexp_replace(COALESCE(x->>'chipNumber',''), '\\s','','g'))
        FROM school_test."TestRecord" r, jsonb_array_elements(COALESCE(r.result_data->'recheckReports','[]'::jsonb)) x
       WHERE r.test_type='pathogen')
    SELECT count(*)::int AS n FROM flat WHERE chip = upper(regexp_replace($1, '\\s','','g'))`, chip)
  return rows[0]?.n || 0
}

function summarize(label, results) {
  const byStatus = {}
  for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1
  const times = results.map((r) => r.ms).sort((a, b) => a - b)
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] || 0
  const codes = {}
  for (const r of results) { const c = r.json?.code ?? (r.json ? 'OK' : 'NON_JSON'); codes[c] = (codes[c] || 0) + 1 }
  console.log(`\n[${label}] 请求 ${results.length} 次`)
  console.log('  HTTP 分布 :', JSON.stringify(byStatus))
  console.log('  业务码分布:', JSON.stringify(codes))
  console.log(`  延迟       : 中位 ${times[Math.floor(times.length / 2)] || 0}ms / p95 ${p95}ms / 最大 ${times[times.length - 1] || 0}ms`)
  return byStatus
}

const CASES = {
  /** ① 并发同芯片双传：应恰好 1 条记录，其余幂等 200，无 5xx */
  async dup() {
    const chip = `ZZTT-DUP-${stamp()}`
    const sampleId = `ZT-DUP-${stamp()}`
    const body = payload({ chip, sampleId })
    const t0 = Date.now()
    const results = await Promise.all(Array.from({ length: 20 }, () => post(body)))
    summarize(`① 并发同芯片 ×20（${Date.now() - t0}ms 总耗时）`, results)
    const recs = await recordsByChip(chip)
    const fivexx = results.filter((r) => r.status >= 500).length
    const occ = await chipOccurrences(chip) // 加严：同芯片不得被重复并入轮次
    const ok = recs.length === 1 && fivexx === 0 && occ === 1
    console.log(`  记录数=${recs.length}（期望 1）｜芯片出现次数=${occ}（期望 1）｜5xx=${fivexx}（期望 0） → ${ok ? '✅ 通过' : '❌ 未通过'}`)
    return ok
  },

  /** ② 并发不同芯片并入同一档案：轮次号不重不漏 */
  async rounds() {
    const sampleId = `ZT-RND-${stamp()}`
    const baseChip = `ZZTT-RND0-${stamp()}`
    const base = await post(payload({ chip: baseChip, sampleId }))
    console.log(`  基础记录（第 1 轮）: HTTP ${base.status} reportId=${base.json?.data?.reportId?.slice(0, 24)}…`)
    const chips = Array.from({ length: 5 }, (_, i) => `ZZTT-RND${i + 1}-${stamp()}`)
    const t0 = Date.now()
    const results = await Promise.all(chips.map((c, i) => {
      const mm = String(10 + i).padStart(2, '0')
      return post(payload({
        chip: c,
        sampleId,
        detectionTime: `${today()} 10:${mm}:00`,
        endTime: `${today()} 10:${mm}:30`, // 结束必须晚于开始（首版脚本此处写死 09:30 → 全被 400 拒绝）
      }))
    }))
    summarize(`② 并发 5 张新芯片并入同一档案（${Date.now() - t0}ms 总耗时）`, results)

    const caseKey = `一食堂||食品/环境样本||一食堂 餐盘涂抹样||${sampleId}||${DEVICE}`
    const rec = await recordByCaseKey(caseKey)
    const roundsArr = Array.isArray(rec?.result_data?.recheckReports) ? rec.result_data.recheckReports : []
    const roundNos = roundsArr.map((r) => r.roundNo).sort((a, b) => a - b)
    const chipSet = new Set(roundsArr.map((r) => String(r.chipNumber).toUpperCase()))
    const missing = chips.filter((c) => !chipSet.has(c.toUpperCase()))
    const dupNos = roundNos.filter((n, i) => roundNos.indexOf(n) !== i)
    const detectedCount = 1 + roundsArr.length
    console.log(`  检测次数=${detectedCount}（期望 6）｜轮次号=${JSON.stringify(roundNos)}｜缺失芯片=${JSON.stringify(missing)}｜重复轮次号=${JSON.stringify(dupNos)}`)
    let occBad = []
    for (const c of chips) { const o = await chipOccurrences(c); if (o !== 1) occBad.push(`${c}:${o}`) }
    const ok = detectedCount === 6 && missing.length === 0 && dupNos.length === 0 && occBad.length === 0
    if (occBad.length) console.log(`  ❌ 芯片重复并入：${JSON.stringify(occBad)}`)
    console.log(`  → ${ok ? '✅ 通过' : '❌ 未通过（轮次丢失或重号）'}`)
    return ok
  },

  /** ③ 混合并发：同芯片幂等 + 新芯片并入同时发生 */
  async mixed() {
    const sampleId = `ZT-MIX-${stamp()}`
    const baseChip = `ZZTT-MIX0-${stamp()}`
    await post(payload({ chip: baseChip, sampleId }))
    const dupChip = `ZZTT-MIXD-${stamp()}`
    const dupBody = payload({ chip: dupChip, sampleId: `ZT-MIXD-${stamp()}` }) // 独立档案的同芯片重复
    const newChips = Array.from({ length: 5 }, (_, i) => `ZZTT-MIX${i + 1}-${stamp()}`)
    const tasks = [
      ...Array.from({ length: 15 }, () => post(dupBody)),
      ...newChips.map((c) => post(payload({ chip: c, sampleId }))),
    ]
    const results = await Promise.all(tasks)
    summarize('③ 混合并发（15 同芯片 + 5 新芯片）', results)
    const dupRecs = await recordsByChip(dupChip)
    const rec = await recordByCaseKey(`一食堂||食品/环境样本||一食堂 餐盘涂抹样||${sampleId}||${DEVICE}`)
    const roundsArr = Array.isArray(rec?.result_data?.recheckReports) ? rec.result_data.recheckReports : []
    const fivexx = results.filter((r) => r.status >= 500).length
    const occ = await chipOccurrences(dupChip) // 加严：同芯片不得重复并入
    const ok = dupRecs.length === 1 && 1 + roundsArr.length === 6 && fivexx === 0 && occ === 1
    console.log(`  同芯片记录数=${dupRecs.length}（期望 1）｜同芯片出现次数=${occ}（期望 1）｜检测次数=${1 + roundsArr.length}（期望 6）｜5xx=${fivexx}`)
    console.log(`  → ${ok ? '✅ 通过' : '❌ 未通过'}`)
    return ok
  },

  /** ④-a 灌历史记录（直接入库，模拟长时间运行后的数据量），远超旧实现的 300 条窗口 */
  async 'prep-scale'(n = '5000') {
    const count = Number(n)
    const user = await q(`SELECT id FROM school_test."User" WHERE username='renkang' LIMIT 1`)
    const uid = user[0]?.id
    if (!uid) throw new Error('找不到 renkang')
    const prefix = `ZZTT-BULK-${stamp()}`
    const started = Date.now()
    // 批量插入：仅满足必要列；chip_nos/case_key 一并写入（与写入路径同构）
    await q(`
      INSERT INTO school_test."TestRecord"
        (id, record_code, test_type, test_name, sample_info, result_data, status, created_by, created_at, updated_at, version, data_version, chip_nos, case_key)
      SELECT
        'bulk-' || g, 'RC-BULK-' || '${prefix}' || '-' || g, 'pathogen', '病原体检测',
        jsonb_build_object('canteen','一食堂','testDate','${today()}','inspector','压测员'),
        jsonb_build_object('sampleId','BULK-'||g, 'sampleType','食品/环境样本', 'sampleInfo','一食堂 餐盘涂抹样',
                           'deviceNo','${DEVICE}', 'riskLevel','无风险', 'chip', jsonb_build_object('number','ZZTT-BULKCHIP-'||g)),
        'completed', '${uid}', now() - (g || ' minutes')::interval, now(), 1, 1,
        ARRAY['ZZTT-BULKCHIP-' || g], '一食堂||食品/环境样本||一食堂 餐盘涂抹样||BULK-' || g || '||${DEVICE}'
      FROM generate_series(1, ${count}) AS g
      ON CONFLICT (record_code) DO NOTHING`)
    const [{ n: total }] = await q(`SELECT count(*)::int AS n FROM school_test."TestRecord" WHERE test_type='pathogen'`)
    console.log(`  已灌入 ${count} 条历史记录（耗时 ${Date.now() - started}ms）；该校病原体记录总数=${total}`)
    return true
  },

  /** ④-b 重传「老芯片」（已被 5000 条更新记录挤到窗口之外）→ 必须仍然幂等 */
  async scale(chip) {
    if (!chip) { console.error('用法：scale <chip>'); return false }
    const before = await recordsByChip(chip)
    console.log(`  重传前：该芯片命中记录 ${before.length} 条`)
    const res = await post(payload({ chip, sampleId: `ZT-SCALE-${stamp()}` }))
    const after = await recordsByChip(chip)
    const dup = res.json?.data?.duplicated === true
    console.log(`  HTTP ${res.status} duplicated=${dup}（期望 200 + duplicated=true）｜重传后记录数=${after.length}（期望 ${before.length}，不新增）`)
    const ok = res.status === 200 && dup && after.length === before.length
    console.log(`  → ${ok ? '✅ 通过（超出 300 条窗口后仍能判重）' : '❌ 未通过（产生了重复记录或未判重）'}`)
    return ok
  },

  /** ⑥ 平台限流边界：打穿 600 次/分钟，期望出现 429 且带 Retry-After、无 5xx */
  async rate(total = '700', concurrency = '60') {
    const totalN = Number(total)
    const limit = Number(concurrency)
    const t0 = Date.now()
    const results = []
    let idx = 0
    const worker = async () => {
      for (;;) {
        const i = idx++
        if (i >= totalN) return
        results.push(await post(payload({ chip: `ZZTT-RATE-${stamp()}-${i}`, sampleId: `ZT-RATE-${stamp()}-${i}` })))
      }
    }
    await Promise.all(Array.from({ length: limit }, worker))
    summarize(`⑥ 限流边界（${totalN} 请求 / 并发 ${limit}，${Date.now() - t0}ms）`, results)
    const r429 = results.filter((r) => r.status === 429)
    const fivexx = results.filter((r) => r.status >= 500).length
    console.log(`  429 数量=${r429.length}（平台 600/min）｜5xx=${fivexx}`)
    console.log(`  → ${r429.length > 0 && fivexx === 0 ? '✅ 通过（限流生效且未拖垮服务）' : (fivexx ? '❌ 出现 5xx' : '⚠️ 未触发限流（请求量不足以打穿 600/min）')}`)
    return fivexx === 0
  },
}

/** ⑨ 长时间浸泡：持续上报 + 定期采样 RSS/延迟，观察内存泄漏与性能漂移 */
CASES.soak = async (seconds = '86400', qps = '1') => {
  const totalSec = Number(seconds)
  const intervalMs = Math.max(200, Math.floor(1000 / Number(qps)))
  const soakChip = `ZZTT-SOAK-${stamp()}`      // 固定芯片 → 绝大多数请求幂等（不产生新记录）
  const soakBody = payload({ chip: soakChip, sampleId: `ZT-SOAK-${stamp()}` })
  const { execSync } = await import('node:child_process')
  // ⚠️ 必须取 systemd 的 MainPID：服务器上还有其他 node 进程，pgrep 会抓错（实测抓到 19MB 的无关进程）
  const pidOf = () => {
    try {
      const p = String(execSync('systemctl show -p MainPID --value foodsentinel-api', { encoding: 'utf8' })).trim()
      if (p && p !== '0') return p
    } catch { /* 非 systemd 环境回落 pgrep */ }
    try { return String(execSync("pgrep -f 'node server.js' | head -1", { encoding: 'utf8' })).trim() } catch { return '' }
  }
  const rssOf = (pid) => {
    try {
      const line = execSync(`grep VmRSS /proc/${pid}/status`, { encoding: 'utf8' })
      return Number((line.match(/(\d+)\s*kB/) || [])[1] || 0)
    } catch { return 0 }
  }
  const pid = pidOf()
  const startRss = rssOf(pid)
  console.log(`浸泡开始：${totalSec}s @ ${(1000 / intervalMs).toFixed(2)} QPS｜API pid=${pid}｜起始 RSS=${(startRss / 1024).toFixed(1)}MB`)
  console.log('时间\t\t请求\t200\t409\t429\t5xx\t中位ms\tRSS(MB)')
  const t0 = Date.now()
  let sent = 0, ok200 = 0, c409 = 0, c429 = 0, fivexx = 0, newRecords = 0, errCount = 0
  let lat = []
  let lastReport = 0
  while (Date.now() - t0 < totalSec * 1000) {
    const isNew = sent % 60 === 0 && sent > 0
    const body = isNew ? payload({ chip: `ZZTT-SOAKN-${stamp()}-${sent}`, sampleId: `ZT-SOAKN-${stamp()}-${sent}` }) : soakBody
    let r
    try {
      r = await post(body)
    } catch (e) {
      // 浸泡期间服务会因发布重启：连接错误不能让整轮浸泡退出（2026-10-28 实测踩坑）
      errCount += 1
      sent += 1
      await new Promise((res2) => setTimeout(res2, intervalMs))
      continue
    }
    sent += 1
    if (r.status === 200) ok200 += 1
    else if (r.status === 409) c409 += 1
    else if (r.status === 429) c429 += 1
    else if (r.status >= 500) fivexx += 1
    if (isNew && r.status === 200 && r.json?.data && !r.json.data.duplicated) newRecords += 1
    lat.push(r.ms)
    if (lat.length > 200) lat = lat.slice(-200)

    const elapsed = Math.floor((Date.now() - t0) / 1000)
    if (elapsed - lastReport >= 30) {
      lastReport = elapsed
      const sorted = [...lat].sort((a, b) => a - b)
      const med = sorted[Math.floor(sorted.length / 2)] || 0
      console.log(`${elapsed}s\t\t${sent}\t${ok200}\t${c409}\t${c429}\t${fivexx}\t${med}\t${(rssOf(pid) / 1024).toFixed(1)}`)
    }
    await new Promise((res2) => setTimeout(res2, intervalMs))
  }
  const endRss = rssOf(pid)
  console.log(`\n浸泡结束：请求 ${sent}｜200=${ok200} 409=${c409} 429=${c429} 5xx=${fivexx} 连接错误=${errCount}｜新建记录 ${newRecords}（其余为幂等）`)
  console.log(`RSS：${(startRss / 1024).toFixed(1)}MB → ${(endRss / 1024).toFixed(1)}MB（增长 ${(((endRss - startRss) / Math.max(1, startRss)) * 100).toFixed(1)}%）`)
  return fivexx === 0
}

const [cmd, ...rest] = process.argv.slice(2)
if (!CASES[cmd]) {
  console.error(`未知命令：${cmd}；可用：${Object.keys(CASES).join(' / ')}`)
  process.exit(1)
}
CASES[cmd](...rest)
  .then((ok) => { console.log(ok ? '\n结果：通过' : '\n结果：未通过'); process.exitCode = ok ? 0 : 2 })
  .catch((e) => { console.error('压测异常：', e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
