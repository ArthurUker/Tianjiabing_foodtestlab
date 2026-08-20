// 005_cleanup-old-schemas.mjs — 清理影子恢复残留的旧备份点 schema（school_<code>_old_<ts>）
//
// 背景：restoreService 每次恢复会把原 schema 改名为 school_<code>_old_<时间戳> 保留
// （支持回滚）。默认 RESTORE_DROP_OLD 未设置时旧 schema 永不自动删除，长期累积会占用
// 大量磁盘空间且结构各不相同（旧备份点缺新列，易误导排查）。
//
// 用法：
//   node scripts/005_cleanup-old-schemas.mjs --dry-run        # 只列出将删除的 schema，不执行（默认）
//   node scripts/005_cleanup-old-schemas.mjs --execute        # 真正执行 DROP
//   node scripts/005_cleanup-old-schemas.mjs --keep 5         # 每所学校保留最近 5 个备份点（默认 5）
//   node scripts/005_cleanup-old-schemas.mjs --all --dry-run  # 清空全部备份点（危险，需 --execute）
//
// 安全设计：
//   - 默认 dry-run，绝不删数据；
//   - 只匹配 /^school_[a-z0-9_]+_old_[0-9]+$/ 格式（restoreService 的命名规范），
//     任何其它 schema 一律不碰（含 public / 活跃 school_<code> / recycle_*）；
//   - 按学校分组，每组按时间戳升序保留最近 N 个（--keep），删除更早的；
//   - 删除前打印每个待删 schema 的估算大小与建库时间，供人工确认。
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const TAG = '[005_cleanup-old-schemas]'
const prisma = new PrismaClient()

const OLD_SCHEMA_RE = /^school_[a-z0-9_]+_old_[0-9]+$/

function parseArgs() {
  const argv = process.argv.slice(2)
  const opts = { dryRun: true, keep: 5, all: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute') opts.dryRun = false
    else if (argv[i] === '--dry-run') opts.dryRun = true
    else if (argv[i] === '--all') opts.all = true
    else if (argv[i] === '--keep') {
      opts.keep = parseInt(argv[++i], 10)
      if (!Number.isFinite(opts.keep) || opts.keep < 0) { console.error(`${TAG} --keep 需为非负整数`); process.exit(2) }
    }
    else { console.error(`${TAG} 未知参数: ${argv[i]}`); process.exit(2) }
  }
  return opts
}

async function listOldSchemas() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT nspname AS name,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
            pg_get_userbyid(nspowner) AS owner
       FROM pg_namespace n
       LEFT JOIN pg_class c ON c.oid = NULL
      WHERE n.nspname ~ '^school_[a-z0-9_]+_old_[0-9]+$'
      ORDER BY n.nspname`
  )
  // pg_namespace 无建库时间列，改查信息架构获取 schema 内最早的可见时间戳（近似）
  const withTs = []
  for (const r of rows) {
    let ts = null
    try {
      const m = r.name.match(/_old_(\d+)$/)
      if (m) ts = new Date(Number(m[1])).toISOString()
    } catch { /* 忽略 */ }
    // 估算大小：遍历 schema 内所有表求和（pg_namespace 无直接大小，用 information_schema + pg_class）
    let size = '?'
    try {
      const [{ total }] = await prisma.$queryRawUnsafe(
        `SELECT COALESCE(pg_size_pretty(SUM(pg_total_relation_size(c.oid))), '0 bytes') AS total
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r','m','i')`,
        r.name
      )
      size = total
    } catch { /* 忽略 */ }
    withTs.push({ name: r.name, ts, size })
  }
  return withTs
}

async function main() {
  const opts = parseArgs()
  console.log(`${TAG} 模式: ${opts.dryRun ? 'DRY-RUN（仅预览，不执行）' : 'EXECUTE（将真正删除）'} | 每校保留最近 ${opts.keep} 个${opts.all ? ' | --all 清空全部备份点' : ''}`)

  const all = await listOldSchemas()
  if (!all.length) { console.log(`${TAG} 未发现任何 school_*_old_* 备份点 schema，无需清理。`); return }

  // 按学校分组（去掉 _old_<ts> 后缀作为组 key）
  const groups = new Map()
  for (const s of all) {
    const key = s.name.replace(/_old_\d+$/, '')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }

  // 每组按时间戳升序 → 前 (len - keep) 个为待删（--all 则全删）
  const toDrop = []
  const toKeep = []
  for (const [key, items] of groups) {
    const sorted = items.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
    const dropCount = opts.all ? sorted.length : Math.max(0, sorted.length - opts.keep)
    const drop = sorted.slice(0, dropCount)
    toDrop.push(...drop)
    toKeep.push(...sorted.slice(dropCount))
  }

  console.log(`\n${TAG} 共 ${all.length} 个备份点 / ${groups.size} 所学校；将删除 ${toDrop.length} 个，保留 ${toKeep.length} 个。\n`)
  if (toKeep.length) {
    console.log(`${TAG} —— 将保留 ——`)
    for (const s of toKeep) console.log(`  ✅ ${s.name}  (${s.size})`)
    console.log('')
  }
  if (toDrop.length) {
    console.log(`${TAG} —— 将删除（可回滚备份点）——`)
    for (const s of toDrop) console.log(`  🗑  ${s.name}  (${s.size})`)
    console.log('')
  }

  if (opts.dryRun) {
    console.log(`${TAG} DRY-RUN 结束。确认无误后用 --execute 真正执行（建议先手动抽查 1 个备份点内容）。`)
    return
  }

  // 确认交互：--execute 仍需人工输入 yes 确认（防误删）
  process.stdout.write(`${TAG} 确认删除以上 ${toDrop.length} 个 schema？输入 yes 继续: `)
  const answer = await new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.once('data', (d) => resolve(String(d).trim().toLowerCase()))
  })
  if (answer !== 'yes') { console.log(`${TAG} 已取消。`); return }

  for (const s of toDrop) {
    const safe = OLD_SCHEMA_RE.test(s.name)
    if (!safe) { console.error(`${TAG} 拒绝删除非法 schema 名: ${s.name}`); continue }
    console.log(`${TAG} DROP SCHEMA ${s.name} CASCADE ...`)
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s.name}" CASCADE`)
  }
  console.log(`\n${TAG} 完成：已删除 ${toDrop.length} 个备份点 schema。`)
}

main()
  .catch((e) => { console.error(`${TAG} 失败:`, e.message); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect() })
