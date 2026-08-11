// 004_backup-verify.mjs — 离线验证备份文件可恢复性（P0 自动验证闭环 L2-Lite）
//
// 用法：
//   node scripts/004_backup-verify.mjs <backup.aes> [meta.json]
//   （meta.json 缺省时自动取同目录同名 .meta.json）
//
// 校验项（不依赖生产库，无需启动 PostgreSQL 实例）：解密 / sha256 / gunzip / CREATE TABLE 计数。
// 逻辑已提取至 lib/backupVerify.js（与 P1 控制台 API 复用同一实现）。
// 依赖加密主密钥（TENCENT_* 或 BACKUP_MASTER_KEY），与备份时一致。
import 'dotenv/config'
import { verifyBackupFile } from '../lib/backupVerify.js'
import { kmsMode } from '../lib/backupKms.js'

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

  const result = await verifyBackupFile(aesPath, metaPath)

  console.log(`${TAG} 验证文件: ${aesPath}`)
  console.log(`${TAG} meta:     ${metaPath}`)
  for (const [k, v] of result.checks) console.log(`${TAG} ${k}: ${v}`)
  if (result.ok) {
    console.log(`${TAG} ✅ 验证通过：该备份文件可解密、可解压、结构完整，可进入恢复流程`)
  } else {
    fatal(result.error || '验证未通过')
  }
}

main().catch((e) => { fatal(e.message || String(e)) })
