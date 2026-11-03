#!/usr/bin/env node
/**
 * 回填归档报文的归属（学校 / 设备）—— 2026-11-03
 *
 * 背景：归档索引（每日 index.jsonl）是后加的，之前落盘的文件没有 school_code/device_no，
 *   在「原始上报报文」页里全归到「未识别（历史文件）」。
 *
 * 做法：对每个日期目录
 *   ① 读现有 index.jsonl（按 path 建索引）
 *   ② 列出目录里的 *.json.gz，缺索引条目的按文件名还原
 *   ③ 对 school_code 为空的条目：用**芯片号**在各租户 TestRecord 里反查（chip_nos 命中）→ 补 school/device
 *   ④ 重写 index.jsonl（先备份 .bak），条目按时间倒序
 *
 * 幂等：可重复执行；只补空值，不覆盖已有归属。
 *
 * 用法：
 *   node scripts/backfill-payload-index.mjs --dry-run
 *   node scripts/backfill-payload-index.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PAYLOAD_DIR } from '../lib/devicePayloadArchive.js'

const DRY = process.argv.includes('--dry-run')
const p = new PrismaClient()

/** 从文件名还原：<chip>_<ISO>_<status>_<code>.json.gz */
function parseName(f) {
  const m = /^(.*)_(\d{4}-\d{2}-\d{2}T[^_]+)_([^_]+)_(.+)\.json\.gz$/.exec(f)
  return {
    chip: m ? m[1] : null,
    at: m ? m[2].replace(/-(\d{2})-(\d{2})-(\d{2})(\d{3})Z$/, ':$1:$2.$3Z') : null,
    status: m ? Number(m[3]) : null,
    code: m ? m[4] : null,
  }
}

async function findByChip(schools, chip) {
  if (!chip) return null
  for (const code of schools) {
    try {
      const rows = await p.$queryRawUnsafe(
        `SELECT result_data->>'deviceNo' AS device_no
           FROM school_${code}."TestRecord"
          WHERE test_type='pathogen' AND chip_nos @> ARRAY[$1]::text[]
          ORDER BY created_at DESC LIMIT 1`,
        chip,
      )
      if (rows.length) return { school_code: code, device_no: rows[0]?.device_no || null }
    } catch {
      /* 该租户无表或结构异常，跳过 */
    }
  }
  return null
}

async function main() {
  const schoolRows = await p.$queryRawUnsafe(`SELECT code FROM public."School" ORDER BY code`)
  const schools = schoolRows.map((r) => r.code)
  console.log(`归档目录: ${PAYLOAD_DIR}`)
  console.log(`租户: ${schools.join(', ')}`)

  let dirs = []
  try {
    dirs = (await fs.readdir(PAYLOAD_DIR, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    console.log('归档目录不存在，无需回填')
    return
  }

  let totalFiles = 0
  let filled = 0
  let stillUnknown = 0

  for (const day of dirs) {
    const dir = path.join(PAYLOAD_DIR, day)
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json.gz'))
    if (!files.length) continue

    // ① 现有索引
    const index = new Map()
    try {
      const text = await fs.readFile(path.join(dir, 'index.jsonl'), 'utf8')
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const e = JSON.parse(t)
          if (e.path) index.set(e.path, e)
        } catch { /* 忽略坏行 */ }
      }
    } catch { /* 没有索引文件 */ }

    // ② 合并文件清单
    const merged = []
    for (const f of files) {
      totalFiles += 1
      const full = path.join(dir, f)
      const st = await fs.stat(full).catch(() => null)
      const meta = parseName(f)
      const exist = index.get(full) || {}
      let entry = {
        path: full,
        name: f,
        at: exist.at || (st ? st.mtime.toISOString() : null),
        school_code: exist.school_code || null,
        device_no: exist.device_no || null,
        chip_number: exist.chip_number || meta.chip || null,
        status: exist.status ?? meta.status ?? null,
        code: exist.code || meta.code || null,
        bytes: exist.bytes ?? st?.size ?? 0,
        gz_bytes: exist.gz_bytes ?? st?.size ?? 0,
      }
      // ③ 缺归属 → 按芯片号反查
      if (!entry.school_code && entry.chip_number) {
        const hit = await findByChip(schools, entry.chip_number)
        if (hit) {
          entry.school_code = hit.school_code
          entry.device_no = hit.device_no
          filled += 1
          console.log(`  补归属 ${f} → ${hit.school_code} / ${hit.device_no || '—'}`)
        }
      }
      if (!entry.school_code) stillUnknown += 1
      merged.push(entry)
    }

    merged.sort((a, b) => String(b.at).localeCompare(String(a.at)))
    const out = merged.map((e) => JSON.stringify(e)).join('\n') + '\n'
    if (!DRY) {
      const idxPath = path.join(dir, 'index.jsonl')
      await fs.copyFile(idxPath, `${idxPath}.bak`).catch(() => {})
      await fs.writeFile(idxPath, out, { mode: 0o600 })
    }
    console.log(`  ${day}: ${files.length} 个文件${DRY ? '（dry-run，不写）' : '，索引已重写'}`)
  }

  console.log(`\n合计 ${totalFiles} 个文件；补上归属 ${filled} 个；仍未知 ${stillUnknown} 个${DRY ? '（dry-run）' : ''}`)
}

main()
  .catch((e) => { console.error('回填异常：', e); process.exitCode = 1 })
  .finally(() => p.$disconnect())
