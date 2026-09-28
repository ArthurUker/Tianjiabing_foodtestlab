// 006_register-external-backup.mjs — 离线管理 CLI：受控注册外部备份产物（P3-W3-CROSS-REG-R1）
//
// 用途：把**非本实例产生**的备份产物（如源库 A 导出的 .sql.gz.aes + .meta.json，已人工放入
// 本实例 BACKUP_DIR）登记进本实例 BackupRun，使其可被既有恢复入口（POST /:id/restore 或
// runRestore）引用；并留独立审计（[admin-audit] backup_external_registered）。
//
// 用法：
//   node backend/scripts/006_register-external-backup.mjs --aes <path.sql.gz.aes> \
//     --source-run-id <id> [--meta <path.meta.json>] [--school <code>] [--actor <label>] \
//     [--dry-run] --yes
//
// 来源 fail-closed（R10 :12/:19）：`--source-run-id` **必填**，且必须与产物 `meta.runId` 一致；
// 缺失/不一致/旧格式（无 runId）一律拒绝（不写 external:unknown，不标"来源已验证"）。
//
// 纪律：
//   · 产物必须位于本实例 BACKUP_DIR（env BACKUP_DIR 或 backend/backups）内；符号链接/穿越拒绝；
//   · 完整校验（sha256/大小/scope/school/表计数/结构快照/来源）不通过即拒绝；
//   · 未带 --yes 且未 --dry-run：只打印计划并退出码 2（防误操作）；--dry-run 全校验但不落库；
//   · **不**放宽 restore-from-upload 的 runId 防伪造链（本入口独立）。
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { registerExternalBackup, ExternalRegistrationError, defaultBackupRootDir } from '../lib/externalBackupRegistration.js'

const TAG = '[006_register-external-backup]'

function parseArgs() {
  const argv = process.argv.slice(2)
  const opts = { aes: null, meta: null, school: null, sourceRunId: null, actor: null, dryRun: false, yes: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--aes') opts.aes = argv[++i]
    else if (a === '--meta') opts.meta = argv[++i]
    else if (a === '--school') opts.school = argv[++i]
    else if (a === '--source-run-id') opts.sourceRunId = argv[++i]
    else if (a === '--actor') opts.actor = argv[++i]
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--yes') opts.yes = true
    else { console.error(`${TAG} 未知参数: ${a}`); process.exit(2) }
  }
  if (!opts.aes) {
    console.error(`${TAG} 必须提供 --aes <path.sql.gz.aes>`)
    process.exit(2)
  }
  if (!opts.sourceRunId || !String(opts.sourceRunId).trim()) {
    console.error(`${TAG} 必须提供 --source-run-id <源实例 BackupRun id>（来源 fail-closed：禁止未知来源注册）`)
    process.exit(2)
  }
  return opts
}

async function main() {
  const opts = parseArgs()
  const rootDir = defaultBackupRootDir()
  console.log(`${TAG} 目标 BACKUP_DIR: ${rootDir}`)
  console.log(`${TAG} 产物: ${opts.aes}${opts.meta ? `，meta: ${opts.meta}` : ''}${opts.school ? `，school=${opts.school}` : ''}${opts.sourceRunId ? `，sourceRunId=${opts.sourceRunId}` : ''}`)

  if (!opts.dryRun && !opts.yes) {
    console.error(`${TAG} 未确认：请先 --dry-run 查看校验结果，或加 --yes 明确执行注册。`)
    process.exit(2)
  }

  const prisma = new PrismaClient()
  try {
    const r = await registerExternalBackup({
      prisma,
      aesPath: opts.aes,
      metaPath: opts.meta,
      expectSchoolCode: opts.school,
      expectSourceRunId: opts.sourceRunId,
      actor: { userId: null, username: opts.actor || 'offline-cli', role: 'offline-admin', schoolCode: null, ip: null },
      rootDir,
      dryRun: opts.dryRun,
      log: (m) => console.log(m),
    })
    console.log(`${TAG} ${r.dryRun ? 'DRY-RUN 通过（未落库）' : '注册完成'}: ${JSON.stringify(r, null, 2)}`)
    if (r.warnings?.length) console.log(`${TAG} ⚠️ warnings: ${r.warnings.join('；')}`)
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

main().catch((e) => {
  if (e instanceof ExternalRegistrationError) {
    console.error(`${TAG} ❌ 拒绝注册 [${e.code}]：${e.message}`)
  } else {
    console.error(`${TAG} ❌ 失败：${e.message}`)
  }
  process.exitCode = 1
})
