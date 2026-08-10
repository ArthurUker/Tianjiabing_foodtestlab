// 004_backup-verify.mjs — 离线验证备份文件可恢复性（P0 自动验证闭环 L2-Lite）
//
// 用法：
//   node scripts/004_backup-verify.mjs <backup.aes> [meta.json]
//   （meta.json 缺省时自动取同目录同名 .meta.json）
//
// 校验项（不依赖生产库，无需启动 PostgreSQL 实例）：
//   ① 解密成功（AES-256-GCM 认证通过 = 密文未被篡改/损坏）
//   ② sha256 与 meta.json 记录一致
//   ③ gunzip 解压成功（gzip 流完整）
//   ④ CREATE TABLE 数量（排除 _prisma_migrations）与 meta.tableCounts 表数一致
//
// 用途：可接入每日备份后自动跑一遍（离线 L2），或恢复演练前人工抽查。
// 依赖加密主密钥（TENCENT_* 或 BACKUP_MASTER_KEY），与备份时一致。
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { decryptFile, kmsMode } from '../lib/backupKms.js'

const TAG = '[004_backup-verify]'

function fatal(msg) {
  console.error(`${TAG} ❌ ${msg}`)
  process.exitCode = 1
}

async function main() {
  const args = process.argv.slice(2)
  const aesPath = args[0]
  if (!aesPath) { console.error(`${TAG} 用法: node scripts/004_backup-verify.mjs <backup.aes> [meta.json]`); process.exit(2) }
  if (!kmsMode()) { fatal('未配置加密主密钥（TENCENT_* 或 BACKUP_MASTER_KEY），无法解密验证'); return }

  // 文件名约定：<baseName>.sql.gz.aes ↔ <baseName>.meta.json（注意中间无 .sql.gz）
  const metaPath = args[1] || aesPath.replace(/\.sql\.gz\.aes$/, '.meta.json')
  if (!fs.existsSync(aesPath)) { fatal(`备份文件不存在: ${aesPath}`); return }
  if (!fs.existsSync(metaPath)) { fatal(`meta.json 不存在: ${metaPath}（恢复必须有 meta，二者须成对保管）`); return }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  const checks = []

  // ① 解密
  try {
    const plain = await decryptFile(fs.readFileSync(aesPath), meta)
    checks.push(['① 解密', '通过（GCM 认证 OK，密文完整）'])

    // ② sha256
    const hash = crypto.createHash('sha256').update(plain).digest('hex')
    const match = meta.sha256 && hash === meta.sha256
    checks.push([`② sha256`, match ? '一致' : `不一致（备份=${hash.slice(0,16)}…，meta=${String(meta.sha256).slice(0,16)}…）`])
    if (!match) { fatal('sha256 不匹配，备份文件可能被修改或与 meta 不对应'); return }

    // ③ gunzip
    let text = ''
    try { text = zlib.gunzipSync(plain).toString() } catch { fatal('gunzip 失败：gzip 流损坏'); return }
    checks.push(['③ gzip', `解压成功（${plain.length} bytes → ${Buffer.byteLength(text)} bytes）`])

    // ④ CREATE TABLE 数量 vs tableCounts 表数（兼容 meta.tableCounts 为对象或 JSON 字符串）
    const createTables = (text.match(/CREATE TABLE/g) || []).length -
      (text.match(/CREATE TABLE\s+(?:"[^"]+"\.)?"_prisma_migrations"/g) || []).length
    const tc = meta.tableCounts
    const expectedTables = tc ? Object.keys(typeof tc === 'string' ? JSON.parse(tc) : tc).length : null
    if (expectedTables == null) {
      checks.push(['④ 表数', `无法对比（meta 无 tableCounts），dump 中 CREATE TABLE=${createTables}`])
    } else {
      const ok = createTables === expectedTables
      checks.push([`④ 表数`, ok ? `一致（${createTables}）` : `不一致（dump=${createTables}，预期=${expectedTables}）`])
      if (!ok) { fatal('CREATE TABLE 数量与备份时基线不一致，备份不完整'); return }
    }

    checks.push([`   数据`, `${(text.match(/^COPY/gm) || []).length} 张表含数据（COPY 语句）`])
  } catch (e) {
    fatal(`解密失败（${e.message}）——备份文件损坏或密钥不匹配`)
    return
  }

  console.log(`${TAG} 验证文件: ${aesPath}`)
  console.log(`${TAG} meta:     ${metaPath}`)
  for (const [k, v] of checks) console.log(`${TAG} ${k}: ${v}`)
  console.log(`${TAG} ✅ 验证通过：该备份文件可解密、可解压、结构完整，可进入恢复流程`)
}

main().catch((e) => { fatal(e.message || String(e)) })
