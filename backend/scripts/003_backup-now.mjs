// 003_backup-now.mjs — 手动/定时触发数据备份（P0 备份引擎 CLI 入口）
//
// 用法：
//   node scripts/003_backup-now.mjs --all          # 全库备份（public + 全部租户 schema）
//   node scripts/003_backup-now.mjs --school demo  # 单校备份
//   node scripts/003_backup-now.mjs --all --dry-run # 只打印计划，不执行
//
// 说明：
//   - 备份 = pg_dump 逻辑快照 + AES-256-GCM 信封加密 + L1 校验 + BackupRun 记录
//   - 加密主密钥：生产用腾讯云 KMS（TENCENT_*），开发可用 BACKUP_MASTER_KEY（见 .env.example）
//   - 备份为安全只读操作（不修改生产数据），默认直接执行；--dry-run 仅预览
//   - systemd timer（部署侧）以 --all 定时调用本脚本
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { runBackup, backupRootDir, backupDateDir, listSchoolCodes } from '../lib/backupService.js'
import { kmsMode } from '../lib/backupKms.js'
import { schemaNameOf } from '../lib/tenantClient.js'

const TAG = '[003_backup-now]'
const prisma = new PrismaClient()

function parseArgs() {
  const argv = process.argv.slice(2)
  const opts = { scope: null, schoolCode: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') opts.scope = 'all'
    else if (argv[i] === '--school') {
      opts.scope = 'single'
      opts.schoolCode = argv[++i]
      if (!opts.schoolCode) { console.error(`${TAG} --school 缺少学校代码`); process.exit(2) }
    }
    else if (argv[i] === '--dry-run') opts.dryRun = true
    else { console.error(`${TAG} 未知参数: ${argv[i]}`); process.exit(2) }
  }
  if (!opts.scope) {
    console.error(`${TAG} 必须指定 --all 或 --school <code>`)
    process.exit(2)
  }
  return opts
}

async function main() {
  const opts = parseArgs()
  console.log(`${TAG} 开始（scope=${opts.scope}${opts.schoolCode ? ', school=' + opts.schoolCode : ''}, dry-run=${opts.dryRun}）`)

  const mode = kmsMode()
  console.log(`${TAG} 加密模式: ${mode ? (mode === 'kms' ? '腾讯云 KMS（信封加密）' : '本地主密钥 BACKUP_MASTER_KEY（仅开发/过渡）') : '❌ 未配置（fail-closed 将拒绝执行）'}`)
  if (!mode) { process.exitCode = 1; return }

  // 计划预览（dry-run 与正常执行都先打印）
  const codes = opts.scope === 'all' ? await listSchoolCodes(prisma, { includeDisabled: true }) : [opts.schoolCode]
  const schemaList = codes
    .map((c) => schemaNameOf(c))
    .filter(Boolean)
  const targetDir = backupRootDir()
  const dateDir = backupDateDir() // 上海时区日期（与引擎一致）
  console.log(`${TAG} 计划：${schemaList.length} 个租户 schema${opts.scope === 'all' ? ' + public' : ''}`)
  console.log(`${TAG} 目标目录: ${targetDir}/${dateDir}`)
  if (opts.dryRun) { console.log(`${TAG} dry-run 结束，未执行备份`); return }

  // 执行
  const result = await runBackup({
    prisma,
    scope: opts.scope,
    schoolCode: opts.scope === 'single' ? opts.schoolCode : undefined,
    createdBy: 'system',
    log: (m) => console.log(m),
  })
  console.log(`${TAG} 完成：${result.filePath}`)
}

main()
  .catch((e) => {
    console.error(`${TAG} 失败:`, e.message || e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
