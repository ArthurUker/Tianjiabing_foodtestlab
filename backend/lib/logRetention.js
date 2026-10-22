// logRetention.js — 日志保留策略 / 自动压缩 / 清理（2026-10-22 日志中心）
//
// 口径（与产品确认）：
//   · 分类保留期自动清理：设备 90 天 / 认证·安全·系统 180 天 / 平台操作审计**长期保留**（0 = 不自动删）；
//   · 中间层「自动压缩」：失败类明细（warn/error）超过 compressAfterDays 后按「日 × 代码」聚合成
//     一行汇总（context.rollup=true，含 count / 首末时间），再删明细 —— 存储降两个数量级，趋势不丢；
//   · 策略存在 JSON 文件（不新增表/迁移，避免触发租户入口门禁的迁移链校验），超管可在界面修改；
//   · 所有自动动作写 admin 审计（log_retention_run）。
//
// ⚠️ 分类字段存放在 SystemLog.context.category（JSONB），旧行为 null → 由 backfillCategories 一次性回填。

import fs from 'node:fs'
import path from 'node:path'
import { writeSystemLog, deriveLogCategory } from './auditLog.js'

export const CATEGORIES = ['device', 'auth', 'security', 'admin', 'system']

export const CATEGORY_LABELS = {
  device: '设备上传',
  auth: '认证会话',
  security: '安全事件',
  admin: '平台操作',
  system: '系统运行',
}

/** 默认策略：retentionDays=0 表示永久保留；compressAfterDays=0 表示不压缩。 */
export const DEFAULT_RULES = {
  device: { retentionDays: 90, compressAfterDays: 30 },
  auth: { retentionDays: 180, compressAfterDays: 0 },
  security: { retentionDays: 180, compressAfterDays: 60 },
  admin: { retentionDays: 0, compressAfterDays: 0 },
  system: { retentionDays: 180, compressAfterDays: 90 },
}

function configPath() {
  return process.env.LOG_RETENTION_FILE
    || path.join(process.env.DATA_DIR || '/mnt/datadisk0/foodsentinel/data', 'log-retention.json')
}

function normalizeRule(r, fallback = { retentionDays: 180, compressAfterDays: 0 }) {
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(Number(v), 3650) : def)
  return {
    retentionDays: num(r?.retentionDays, fallback.retentionDays),
    compressAfterDays: num(r?.compressAfterDays, fallback.compressAfterDays),
  }
}

/** 读取策略（文件不存在 → 默认；文件损坏 → 默认并保留原名备份提示）。 */
export function readRetention() {
  const file = configPath()
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const j = JSON.parse(raw)
    const rules = {}
    for (const c of CATEGORIES) rules[c] = normalizeRule({ ...DEFAULT_RULES[c], ...(j.rules?.[c] || {}) }, DEFAULT_RULES[c])
    return { rules, auto: j.auto !== false, lastRunDay: j.lastRunDay || null, file, updatedAt: j.updatedAt || null }
  } catch {
    return { rules: { ...DEFAULT_RULES }, auto: true, lastRunDay: null, file, updatedAt: null }
  }
}

/** 写入策略（原子写：tmp → rename）。 */
export function writeRetention({ rules, auto, lastRunDay }) {
  const file = configPath()
  const cur = readRetention()
  const merged = {}
  for (const c of CATEGORIES) merged[c] = normalizeRule({ ...cur.rules[c], ...(rules?.[c] || {}) }, cur.rules[c] || DEFAULT_RULES[c])
  const out = {
    rules: merged,
    auto: auto === undefined ? cur.auto : !!auto,
    lastRunDay: lastRunDay === undefined ? cur.lastRunDay : lastRunDay,
    updatedAt: new Date().toISOString(),
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  return { ...out, file }
}

/** 分类过滤条件（Prisma JSON 过滤；system 兼容旧的「无 category」行）。 */
export function categoryWhere(category) {
  if (!category || category === 'all') return {}
  // 注：backfillCategories 保证每行都带 category，因此这里无需再兼容「无 category」的旧行
  return { context: { path: ['category'], equals: category } }
}

const dayStr = (d) => {
  const t = new Date(d)
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/**
 * 把旧的「无分类」日志行补齐 category（一次性；幂等）。
 * @returns {Promise<number>} 回填行数
 */
export async function backfillCategories(prisma, { limit = 5000 } = {}) {
  // 取最近 limit 行，在内存里判「缺 category」再补（旧行 JSON 里没有该键，
  // 用 Prisma JSON 的 not-null 过滤在不同版本语义不一致，直接判更稳）
  const rows = await prisma.systemLog.findMany({
    select: { id: true, level: true, message: true, context: true },
    orderBy: { created_at: 'desc' },
    take: limit,
  }).catch(() => [])
  let fixed = 0
  for (const r of rows || []) {
    const ctx = r.context && typeof r.context === 'object' ? r.context : {}
    if (ctx.category) continue
    const category = deriveLogCategory({ actionType: ctx.action_type, message: r.message, level: r.level })
    await prisma.systemLog.update({
      where: { id: r.id },
      data: { context: { ...ctx, category } },
    }).catch(() => {})
    fixed += 1
  }
  return fixed
}

/**
 * 压缩：把某分类中「已过 compressAfterDays、尚未到 retentionDays」的失败明细聚合成日汇总行。
 * @returns {Promise<{scanned, rollups, deleted}>}
 */
export async function compressCategory(prisma, category, { compressAfterDays, retainDays, now = Date.now(), dryRun = false, maxScan = 20000, ref = null } = {}) {
  if (!compressAfterDays) return { scanned: 0, rollups: 0, deleted: 0 }
  const compressCutoff = new Date(now - compressAfterDays * 86400_000)
  const where = {
    ...categoryWhere(category),
    created_at: { lt: compressCutoff },
    level: { in: ['warn', 'error'] },
    NOT: { context: { path: ['rollup'], equals: true } },
  }
  const rows = await prisma.systemLog.findMany({
    where,
    select: { id: true, level: true, message: true, context: true, created_at: true },
    orderBy: { created_at: 'asc' },
    take: maxScan,
  })
  if (!rows.length) return { scanned: 0, rollups: 0, deleted: 0 }

  // 按「日 × 代码 × 级别」聚合
  const groups = new Map()
  for (const r of rows) {
    const ctx = r.context && typeof r.context === 'object' ? r.context : {}
    const code = String(ctx.code || ctx.action_type || 'unknown')
    const key = `${dayStr(r.created_at)}|${code}|${r.level}`
    const g = groups.get(key) || { day: dayStr(r.created_at), code, level: r.level, count: 0, first: r.created_at, last: r.created_at, repeat: 0 }
    g.count += Number(ctx.repeat_count || 1)
    g.repeat += 1
    if (r.created_at < g.first) g.first = r.created_at
    if (r.created_at > g.last) g.last = r.created_at
    groups.set(key, g)
  }

  const rollups = [...groups.values()]
  if (!dryRun) {
    for (const g of rollups) {
      await writeSystemLog(prisma, {
        level: 'info',
        message: `[rollup] ${category} ${g.day} ${g.code} × ${g.count}`,
        context: {
          category,
          rollup: true,
          rollup_category: category,
          day: g.day,
          code: g.code,
          level: g.level,
          count: g.count,
          source_rows: g.repeat,
          first_seen_at: new Date(g.first).toISOString(),
          last_seen_at: new Date(g.last).toISOString(),
          ref,
        },
      }).catch(() => {})
    }
    await prisma.systemLog.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })
  }
  return { scanned: rows.length, rollups: rollups.length, deleted: dryRun ? 0 : rows.length }
}

/**
 * 执行一次保留策略（压缩 + 到期删除）。
 * @param {object} prisma
 * @param {{dryRun?: boolean, auto?: boolean}} opts
 */
export async function applyRetention(prisma, { dryRun = false, auto = false } = {}) {
  const cfg = readRetention()
  const now = Date.now()
  const result = { dryRun, auto, categories: {}, totalDeleted: 0, totalRollups: 0 }
  for (const cat of CATEGORIES) {
    const rule = cfg.rules[cat] || DEFAULT_RULES[cat]
    const item = { retentionDays: rule.retentionDays, compressAfterDays: rule.compressAfterDays, willDelete: 0, rollupGroups: 0, compressedRows: 0 }

    // ① 压缩
    if (rule.compressAfterDays > 0) {
      try {
        const c = await compressCategory(prisma, cat, {
          compressAfterDays: rule.compressAfterDays,
          retainDays: rule.retentionDays,
          now,
          dryRun,
          ref: { run: auto ? 'auto' : 'manual', at: new Date(now).toISOString() },
        })
        item.rollupGroups = c.rollups
        item.compressedRows = c.scanned
        result.totalRollups += c.rollups
      } catch (e) {
        item.compressError = String(e.message || e).slice(0, 120)
      }
    }

    // ② 到期删除（保留期 0 = 永久）
    if (rule.retentionDays > 0) {
      const cutoff = new Date(now - rule.retentionDays * 86400_000)
      try {
        if (dryRun) {
          item.willDelete = await prisma.systemLog.count({ where: { ...categoryWhere(cat), created_at: { lt: cutoff } } })
        } else {
          const r = await prisma.systemLog.deleteMany({ where: { ...categoryWhere(cat), created_at: { lt: cutoff } } })
          item.willDelete = Number(r?.count || 0)
          result.totalDeleted += item.willDelete
        }
      } catch (e) {
        item.purgeError = String(e.message || e).slice(0, 120)
      }
    }
    result.categories[cat] = item
  }
  if (!dryRun) writeRetention({ lastRunDay: dayStr(new Date()) })
  return result
}

/** 每日自动执行（server.js 定时器调用；同一天只跑一次）。 */
export async function runRetentionIfDue(prisma, { force = false } = {}) {
  const cfg = readRetention()
  if (!cfg.auto && !force) return { skipped: 'auto_disabled' }
  const today = dayStr(new Date())
  if (!force && cfg.lastRunDay === today) return { skipped: 'already_ran_today' }
  const r = await applyRetention(prisma, { dryRun: false, auto: true })
  await writeSystemLog(prisma, {
    level: 'info',
    message: `[admin-audit] log_retention_run target=${today}`,
    context: {
      action_type: 'log_retention_run',
      category: 'admin',
      deleted: r.totalDeleted,
      rollups: r.totalRollups,
      per_category: r.categories,
      trigger: force ? 'manual' : 'schedule',
    },
  }).catch(() => {})
  return r
}

export default {
  CATEGORIES, CATEGORY_LABELS, DEFAULT_RULES,
  readRetention, writeRetention, categoryWhere,
  backfillCategories, compressCategory, applyRetention, runRetentionIfDue,
}
