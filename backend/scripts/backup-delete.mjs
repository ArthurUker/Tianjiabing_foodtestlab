// backup-delete.mjs — 删除 BackupRun 记录及其物理文件（一次性运维脚本，生产环境）
//
// 用法（生产环境，必须以 foodsentinel 用户运行）：
//   # 按 ID 精确删除（推荐，绝不误伤）：
//   node scripts/backup-delete.mjs --ids id1,id2 --dry-run
//   node scripts/backup-delete.mjs --ids id1,id2 --confirm
//   # 按日期范围删除（粗粒度，谨慎）：
//   node scripts/backup-delete.mjs --before 2026-08-27 --dry-run
//   node scripts/backup-delete.mjs --before 2026-08-27 --confirm
//
// 安全设计：
//   - 默认 dry-run，必须显式 --confirm 才会真删；
//   - 同时删除 .sql.gz.aes 及其 .meta.json（如存在）；
//   - 若文件不存在，仍删除数据库记录（孤儿记录清理）。

import 'dotenv/config'
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'

const TAG = '[backup-delete]'
const prisma = new PrismaClient()

function parseArgs() {
  const argv = process.argv.slice(2)
  const opts = { before: null, ids: null, dryRun: true }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ids') {
      opts.ids = argv[++i]
      if (!opts.ids) { console.error(`${TAG} --ids 缺少值（逗号分隔的备份记录 ID）`); process.exit(2) }
    } else if (argv[i] === '--before') {
      opts.before = argv[++i]
      if (!opts.before) { console.error(`${TAG} --before 缺少日期`); process.exit(2) }
    } else if (argv[i] === '--confirm') {
      opts.dryRun = false
    } else if (argv[i] === '--dry-run') {
      opts.dryRun = true
    } else {
      console.error(`${TAG} 未知参数: ${argv[i]}`)
      process.exit(2)
    }
  }
  if (!opts.ids && !opts.before) {
    console.error(`${TAG} 必须指定 --ids <id,id> 或 --before <YYYY-MM-DD>`)
    process.exit(2)
  }
  return opts
}

async function main() {
  const opts = parseArgs()
  let runs
  if (opts.ids) {
    const idList = opts.ids.split(',').map((s) => s.trim()).filter(Boolean)
    console.log(`${TAG} 按 ID 精确查找 ${idList.length} 条记录...`)
    runs = await prisma.backupRun.findMany({ where: { id: { in: idList } } })
    const found = new Set(runs.map((r) => r.id))
    const missing = idList.filter((id) => !found.has(id))
    if (missing.length) console.warn(`${TAG} 以下 ID 在库中未找到（将跳过）: ${missing.join(', ')}`)
  } else {
    const cutoff = new Date(`${opts.before}T23:59:59.999Z`)
    console.log(`${TAG} 查找 created_at <= ${opts.before} 的备份记录...`)
    runs = await prisma.backupRun.findMany({
      where: { created_at: { lte: cutoff } },
      orderBy: { created_at: 'desc' },
    })
  }

  if (runs.length === 0) {
    console.log(`${TAG} 没有找到符合条件的备份记录`)
    return
  }

  console.log(`${TAG} 找到 ${runs.length} 条记录：`)
  for (const r of runs) {
    const metaPath = r.file_path.replace(/\.sql\.gz\.aes$/, '.meta.json')
    const aesExists = fs.existsSync(r.file_path)
    const metaExists = fs.existsSync(metaPath)
    console.log(`  - ${r.id} | ${r.created_at.toISOString()} | ${r.file_path}`)
    console.log(`      .aes 存在: ${aesExists}, .meta.json 存在: ${metaExists}`)
  }

  if (opts.dryRun) {
    console.log(`\n${TAG} 当前为 dry-run，未删除任何内容。如需删除请重跑并加 --confirm`)
    return
  }

  let deletedRecords = 0
  let deletedFiles = 0
  let failedFiles = 0

  for (const r of runs) {
    const metaPath = r.file_path.replace(/\.sql\.gz\.aes$/, '.meta.json')
    for (const p of [r.file_path, metaPath]) {
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p)
          console.log(`${TAG} 已删除文件: ${p}`)
          deletedFiles++
        }
      } catch (e) {
        console.error(`${TAG} 删除文件失败: ${p}`, e.message)
        failedFiles++
      }
    }
    await prisma.backupRun.delete({ where: { id: r.id } })
    deletedRecords++
  }

  console.log(`\n${TAG} 删除完成：记录 ${deletedRecords} 条，文件 ${deletedFiles} 个，失败 ${failedFiles} 个`)
}

main()
  .catch((e) => {
    console.error(`${TAG} 失败:`, e.message || e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
