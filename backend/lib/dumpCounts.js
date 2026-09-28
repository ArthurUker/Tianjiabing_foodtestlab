// dumpCounts.js — 从 pg_dump 明文（或 .sql.gz 流）反推行数（P3-W3-T01 / AUD-006）
//
// 用途：备份时「计数 / 结构 / dump」必须共享同一快照边界。本模块提供第二路证据——
//   直接从 dump 文本统计每张表的 COPY 数据行数（pg_dump 对空表也会输出
//   `COPY ... FROM stdin;` + `\.`，因此每个表的行数都能从 dump 本身得到）。
//   快照模式下它与快照内 count(*) 交叉核对（必须完全一致才允许登记 ok/passed）；
//   降级（live）模式下它是唯一可信计数来源，与 live 计数不一致时**拒绝登记**。
//
// 解析口径（与 backupService/backupVerify 的历史实现保持一致）：
//   · 只统计行首 `CREATE TABLE`（排除 _prisma_migrations），避免误计 SystemLog 数据里的字样；
//   · COPY 段以 `COPY <schema>.<table> (...) FROM stdin;` 开始，`\.`（独占一行）结束；
//     COPY text 格式中数据里的反斜杠点会被转义为 `\\.`，因此“独占一行的 \.”只会是终止符；
//   · 流式（逐行、跨 chunk 保余）处理，内存不随 dump 体积增长。

import fs from 'node:fs'
import zlib from 'node:zlib'

const IDENT = '(?:"[^"]+"|[A-Za-z0-9_$]+)'
const COPY_HEADER_RE = new RegExp(`^COPY\\s+(${IDENT})\\s*\\.\\s*(${IDENT})\\s*(?:\\(|FROM\\s+stdin)`, 'i')

/** 去掉标识符两侧的双引号。 */
function unquote(ident) {
  return ident.startsWith('"') && ident.endsWith('"') ? ident.slice(1, -1) : ident
}

/** pg_dump 行首建表语句（排除 _prisma_migrations；兼容带/不带引号两种形态）。 */
function countCreateTableLine(line) {
  if (!/^\s*CREATE TABLE\b/i.test(line)) return false
  if (/^\s*CREATE TABLE\s+(?:(?:"[^"]+"|[\w]+)\.)?"?_prisma_migrations"?\s*\(/i.test(line)) return false
  return true
}

/**
 * 创建一个流式 dump 分析器。
 * @returns {{write:(chunk:Buffer|string)=>void, end:()=>({createTableCount:number, counts:Record<string,number>, copyTables:string[], bytes:number})}}
 */
export function createDumpAnalyzer() {
  let buffer = ''
  let inCopy = false
  // 正在计数的表（`schema.table`）；null = 处于被跳过的 COPY 段（_prisma_migrations）
  let copyTable = null
  let createTableCount = 0
  let bytes = 0
  const counts = {}
  const copyTables = []

  const handleLine = (line) => {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line
    if (inCopy) {
      if (l === '\\.') { inCopy = false; copyTable = null; return }
      if (copyTable !== null) counts[copyTable] += 1
      return
    }
    if (/^\s*COPY\s/i.test(l)) {
      const m = l.match(COPY_HEADER_RE)
      if (m) {
        const table = `${unquote(m[1])}.${unquote(m[2])}`
        inCopy = true
        if (unquote(m[2]) === '_prisma_migrations') { copyTable = null; return }
        if (counts[table] === undefined) counts[table] = 0
        copyTables.push(table)
        copyTable = table
        return
      }
    }
    if (countCreateTableLine(l)) createTableCount += 1
  }

  return {
    write(chunk) {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      bytes += Buffer.byteLength(s)
      buffer += s
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) handleLine(line)
    },
    end() {
      if (buffer) handleLine(buffer)
      return { createTableCount, counts, copyTables, bytes }
    },
  }
}

/** 同步分析 dump 文本（单元测试/小文件用）。 */
export function analyzeDumpText(text) {
  const a = createDumpAnalyzer()
  a.write(text)
  return a.end()
}

/** 流式分析 .sql.gz（生产路径：备份后的 L1 校验 + 计数反推一次完成）。 */
export function analyzeGzDump(gzPath) {
  return new Promise((resolve, reject) => {
    const analyzer = createDumpAnalyzer()
    const gunzip = zlib.createGunzip()
    gunzip.on('data', (chunk) => analyzer.write(chunk))
    gunzip.on('error', reject)
    gunzip.on('end', () => resolve(analyzer.end()))
    fs.createReadStream(gzPath).pipe(gunzip)
  })
}

/**
 * 比对两路计数（快照 count(*) vs dump 反推）。
 * @returns {{consistent:boolean, mismatches:Array<{table:string, snapshot:number|null, dump:number|null}>}}
 */
export function diffCounts(snapshotCounts, dumpCounts) {
  const mismatches = []
  const keys = new Set([...Object.keys(snapshotCounts || {}), ...Object.keys(dumpCounts || {})])
  for (const table of [...keys].sort()) {
    const a = snapshotCounts && snapshotCounts[table] !== undefined ? Number(snapshotCounts[table]) : null
    const b = dumpCounts && dumpCounts[table] !== undefined ? Number(dumpCounts[table]) : null
    if (a !== b) mismatches.push({ table, snapshot: a, dump: b })
  }
  return { consistent: mismatches.length === 0, mismatches }
}
