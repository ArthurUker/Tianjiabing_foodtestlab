/**
 * 设备上报报文归档（2026-11-03）
 *
 * 背景：此前只把报文解析成结构化字段入库（result_data.rawDetection 等），
 *   **原始 JSON 没有原样留存**——厂商说"我明明传的是 X"、或要复盘"设备到底发了什么"时无法对账。
 *
 * 方案（B）：原样报文 **gzip 落盘**，数据库只存路径 + 大小 + sha256。
 *   · 目录：DEVICE_PAYLOAD_DIR（默认 /var/lib/foodsentinel/device-payloads），按天分目录
 *   · 文件名：<芯片号或设备号>_<ISO时间>_<HTTP状态>_<业务码>.json.gz
 *   · 超过 DEVICE_PAYLOAD_MAX_BYTES（默认 2MB，与请求体上限一致）不归档，只返回 too_large
 *   · 保留期 DEVICE_PAYLOAD_RETENTION_DAYS（默认 90 天），由 scripts/prune-device-payloads.mjs 清理
 *
 * ⚠️ 与"日志脱敏"策略的关系：日志里仍**不得**出现样本描述/人名（见 uploadPayloadDiagnostics）；
 *   归档文件是**原始报文**（含 SampleStr 等），因此要求：目录权限 0700、仅服务账号可读、
 *   通过超管接口按记录调取，不对外暴露静态路径。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { promisify } from 'node:util'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

export const PAYLOAD_DIR = process.env.DEVICE_PAYLOAD_DIR || '/var/lib/foodsentinel/device-payloads'
export const MAX_BYTES = Number(process.env.DEVICE_PAYLOAD_MAX_BYTES || 2 * 1024 * 1024)
export const RETENTION_DAYS = Number(process.env.DEVICE_PAYLOAD_RETENTION_DAYS || 90)

const pad = (n) => String(n).padStart(2, '0')
/** 文件名安全片段（防路径穿越/非法字符） */
function safeSegment(v) {
  return String(v || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown'
}
function dayDir(at) {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * 归档一条原始报文。**永不抛错**（返回 {ok:false, reason}），避免影响上报主流程。
 * @param {object} opts
 * @param {object} opts.payload   原始请求体
 * @param {string} [opts.schoolCode]
 * @param {string} [opts.deviceNo]
 * @param {string} [opts.chipNumber]
 * @param {number} [opts.status]  HTTP 状态（便于区分成功/失败报文）
 * @param {string} [opts.code]    业务码 / 失败原因
 * @param {string} [opts.ip]
 */
export async function archiveDevicePayload(opts = {}) {
  const at = opts.at ? new Date(opts.at) : new Date()
  try {
    const raw = JSON.stringify(opts.payload ?? null)
    const bytes = Buffer.byteLength(raw)
    if (bytes > MAX_BYTES) {
      return { ok: false, reason: 'too_large', bytes, limit: MAX_BYTES }
    }
    const dir = path.join(PAYLOAD_DIR, dayDir(at))
    const name = [
      safeSegment(opts.chipNumber || opts.deviceNo),
      at.toISOString().replace(/[:.]/g, '-'),
      safeSegment(opts.status ?? 'ok'),
      safeSegment(opts.code || 'OK'),
    ].join('_') + '.json.gz'
    const full = path.join(dir, name)
    const gz = await gzip(Buffer.from(raw, 'utf8'), { level: 6 })
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.writeFile(full, gz, { mode: 0o600 })
    // 追加当日索引（一行一条），超管列表据此检索；失败不影响归档
    const entry = {
      path: full,
      name,
      at: at.toISOString(),
      school_code: opts.schoolCode || null,
      device_no: opts.deviceNo || null,
      chip_number: opts.chipNumber || null,
      status: opts.status ?? null,
      code: opts.code || null,
      bytes,
      gz_bytes: gz.length,
    }
    await fs.appendFile(path.join(dir, 'index.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 }).catch(() => {})
    return {
      ok: true,
      path: full,
      bytes,
      gzBytes: gz.length,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      at: at.toISOString(),
      schoolCode: opts.schoolCode || null,
      deviceNo: opts.deviceNo || null,
      chipNumber: opts.chipNumber || null,
      status: opts.status ?? null,
      code: opts.code || null,
    }
  } catch (e) {
    console.warn('[DevicePayloadArchive] 归档失败（不影响上报）:', e.message)
    return { ok: false, reason: 'io_error', error: e.message }
  }
}

/** 读取归档报文（只允许归档目录内文件，防路径穿越）。 */
export async function readArchivedPayload(fullPath) {
  const root = path.resolve(PAYLOAD_DIR)
  const resolved = path.resolve(String(fullPath || ''))
  if (!resolved.startsWith(root + path.sep)) throw new Error('非法归档路径')
  const buf = await gunzip(await fs.readFile(resolved))
  return buf.toString('utf8')
}

/** 清理过期归档（按天目录 mtime）。返回 {scanned, removed, keepDays}。 */
export async function pruneArchivedPayloads({ days = RETENTION_DAYS, dryRun = false } = {}) {
  const root = path.resolve(PAYLOAD_DIR)
  const cutoff = Date.now() - Number(days) * 86400000
  let scanned = 0
  let removed = 0
  let entries = []
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (e) {
    return { scanned: 0, removed: 0, keepDays: Number(days), skipped: 'dir_not_found' }
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const dir = path.join(root, ent.name)
    const st = await fs.stat(dir).catch(() => null)
    if (!st) continue
    scanned += 1
    if (st.mtimeMs >= cutoff) continue
    if (!dryRun) await fs.rm(dir, { recursive: true, force: true })
    removed += 1
  }
  return { scanned, removed, keepDays: Number(days), dryRun }
}

/**
 * 列出最近 N 天的归档报文（读取每日 index.jsonl，按时间倒序）。
 * @param {{days?:number, school?:string, chip?:string, status?:string, code?:string, limit?:number}} q
 */
export async function listArchivedPayloads(q = {}) {
  const days = Math.max(1, Math.min(Number(q.days) || 7, Math.max(1, RETENTION_DAYS)))
  const limit = Math.max(1, Math.min(Number(q.limit) || 200, 500))
  const root = path.resolve(PAYLOAD_DIR)
  const wanted = []
  const today = new Date()
  for (let i = 0; i < days; i += 1) {
    const d = new Date(today.getTime() - i * 86400000)
    wanted.push(path.join(root, dayDir(d)))
  }
  const out = []
  const indexed = new Set()
  for (const dir of wanted) {
    let text = ''
    try {
      text = await fs.readFile(path.join(dir, 'index.jsonl'), 'utf8')
    } catch {
      text = ''
    }
    // 兜底：索引功能上线前归档的文件，按文件名 + mtime 还原元数据（保证列表不丢历史）
    try {
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json.gz'))
      for (const f of files) {
        const full = path.join(dir, f)
        indexed.add(full)
        // 形如 <chip>_<ISO>_<status>_<code>.json.gz
        const m = /^(.*)_(\d{4}-\d{2}-\d{2}T[^_]+)_([^_]+)_(.+)\.json\.gz$/.exec(f)
        const st = await fs.stat(full).catch(() => null)
        if (!st) continue
        out.push({
          path: full,
          name: f,
          at: st.mtime.toISOString(),
          school_code: null,
          device_no: null,
          chip_number: m ? m[1] : null,
          status: m ? Number(m[3]) : null,
          code: m ? m[4] : null,
          bytes: st.size,
          gz_bytes: st.size,
          derived: true,
        })
      }
    } catch {
      /* 目录不存在 */
    }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      let e
      try {
        e = JSON.parse(t)
      } catch {
        continue
      }
      if (q.school && String(e.school_code || '').toLowerCase() !== String(q.school).toLowerCase()) continue
      if (q.chip && !String(e.chip_number || '').toLowerCase().includes(String(q.chip).toLowerCase())) continue
      if (q.device && !String(e.device_no || '').toLowerCase().includes(String(q.device).toLowerCase())) continue
      if (q.status && String(e.status ?? '') !== String(q.status)) continue
      if (q.code && !String(e.code || '').toLowerCase().includes(String(q.code).toLowerCase())) continue
      out.push(e)
    }
  }
  // 去重：同一 path 只保留一条（索引条目优先，derived 条目靠后）
  const seen = new Map()
  for (const e of out) {
    const key = e.path
    if (!seen.has(key) || !e.derived) seen.set(key, e)
  }
  const merged = [...seen.values()]
  merged.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return { items: merged.slice(0, limit), total: merged.length, scannedDays: days }
}
