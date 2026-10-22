// adminLogRoutes.js — 日志中心 API（控制台「日志管理」视图后端，仅平台超管）
//
// 背景（2026-10-22）：磁盘管理已有"文件清单 + 删除"，但日志**内容**只能上服务器 tail；
//   设备上传链路也只有 stdout 文件 + 节流后的 SystemLog，界面完全看不到。
//   本路由补上「分类 / 查询 / 详情 / 导出 / 保留策略 / 文件在线查看」。
//
// 端点（全部 authenticateUser + requirePlatformSuperAdmin）：
//   GET  /api/admin/logs                  统一查询（分类/级别/时间/学校/设备/关键词 + 分面计数 + 分页）
//   GET  /api/admin/logs/stats            按天 × 分类计数 + 表体量（容量规划）
//   GET  /api/admin/logs/retention        读取保留策略与分类字典
//   POST /api/admin/logs/retention        修改保留策略（{rules:{device:{retentionDays,compressAfterDays}}}）
//   POST /api/admin/logs/purge            执行压缩+清理（{dryRun:true} 先预览）
//   POST /api/admin/logs/export           按当前筛选导出 NDJSON（流式，不落盘）
//   GET  /api/admin/logs/files            可查看的日志文件清单（白名单目录）
//   GET  /api/admin/logs/files/view       查看某文件最近 N 行（可关键字过滤）
//   GET  /api/admin/logs/files/download   下载某文件
//   GET  /api/admin/logs/:id              单条详情（context 结构化）
//
// 安全：
//   · 路径一律走白名单前缀 + '..' 拒绝；root 属主目录经 sudo 包装脚本（disk-manage.sh）
//   · 行数与读取字节有上限（防打爆内存）；导出有行数上限
//   · 策略变更 / 执行清理 / 导出均写 admin 审计

import express from 'express'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { writeAdminOpsLog } from '../lib/auditLog.js'
import {
  CATEGORIES, CATEGORY_LABELS, DEFAULT_RULES, readRetention, writeRetention,
  categoryWhere, applyRetention, backfillCategories,
} from '../lib/logRetention.js'

const TAG = '[adminLogRoutes]'

const APP_LOG_DIR = '/mnt/datadisk0/foodsentinel/logs'
/** 可查看目录白名单（先直接读，失败再走 root 包装脚本）。 */
const VIEW_DIRS = [
  APP_LOG_DIR,
  '/mnt/datadisk0/system-logs/syslog',
  '/mnt/datadisk0/system-logs/journal',
]
const MAX_VIEW_LINES = 2000
const MAX_READ_BYTES = 4 * 1024 * 1024   // 读取窗口上限 4MB
const MAX_EXPORT_ROWS = 20000
const MAX_PAGE_SIZE = 200

function assertViewPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('非法路径')
  if (p.includes('..')) throw new Error('路径含 ..')
  const ok = VIEW_DIRS.some((d) => p === d || p.startsWith(d + '/'))
  if (!ok) throw new Error('路径不在可查看目录内')
}

function sudoManage(...args) {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['/usr/local/sbin/disk-manage.sh', ...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${(stderr || err.message || '').toString().trim().slice(0, 300)}`))
      resolve(stdout.toString())
    })
  })
}

/** 从文件尾部读取至多 bytes 字节（不足则整文件），返回文本。 */
async function readTailText(file, bytes = MAX_READ_BYTES) {
  const st = await fsp.stat(file)
  const start = Math.max(0, st.size - bytes)
  const len = st.size - start
  const buf = Buffer.alloc(len)
  const fh = await fsp.open(file, 'r')
  try {
    await fh.read(buf, 0, len, start)
  } finally {
    await fh.close()
  }
  return { text: buf.toString('utf8'), truncated: start > 0, size: st.size, start }
}

/** 关键字过滤（大小写不敏感；多关键字以空格分隔，全部命中才算）。 */
function filterLines(lines, q) {
  const kws = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!kws.length) return lines
  return lines.filter((l) => {
    const s = l.toLowerCase()
    return kws.every((k) => s.includes(k))
  })
}

/** 查询条件 → Prisma where。 */
function buildWhere(q) {
  const and = []
  const since = q.since ? new Date(q.since) : null
  const until = q.until ? new Date(q.until) : null
  if ((since && !Number.isNaN(since.getTime())) || (until && !Number.isNaN(until.getTime()))) {
    and.push({ created_at: { ...(since && !Number.isNaN(since.getTime()) ? { gte: since } : {}), ...(until && !Number.isNaN(until.getTime()) ? { lte: until } : {}) } })
  }
  if (q.level && q.level !== 'all') and.push({ level: String(q.level) })
  const catWhere = categoryWhere(String(q.category || 'all'))
  if (catWhere.OR) and.push({ OR: catWhere.OR })
  else if (catWhere.context) and.push({ context: catWhere.context })
  if (q.q) and.push({ message: { contains: String(q.q), mode: 'insensitive' } })
  if (q.device_no) and.push({ context: { path: ['device_no'], equals: String(q.device_no) } })
  if (q.school_code) {
    and.push({
      OR: [
        { context: { path: ['school_code'], equals: String(q.school_code) } },
        { context: { path: ['target_school_code'], equals: String(q.school_code) } },
      ],
    })
  }
  if (q.action_type) and.push({ context: { path: ['action_type'], equals: String(q.action_type) } })
  return and.length ? { AND: and } : {}
}

const toView = (r) => ({
  id: r.id,
  level: r.level,
  message: r.message,
  context: r.context || null,
  category: r.context?.category || null,
  created_at: r.created_at,
})

export function createAdminLogRoutes({ prisma, authenticateUser, requirePlatformSuperAdmin }) {
  const router = express.Router()
  router.use(authenticateUser, requirePlatformSuperAdmin)

  // 首次进入日志中心时把旧行的分类补齐（幂等；失败不影响查询）
  let backfilled = false
  async function ensureBackfill() {
    if (backfilled) return
    backfilled = true
    await backfillCategories(prisma).catch((e) => console.warn(`${TAG} 分类回填失败:`, e.message))
  }

  // ── 统一查询 ──
  router.get('/', async (req, res) => {
    try {
      await ensureBackfill()
      const q = req.query || {}
      const page = Math.max(1, Number(q.page) || 1)
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(q.pageSize) || 50))
      const where = buildWhere(q)

      const [total, rows] = await Promise.all([
        prisma.systemLog.count({ where }),
        prisma.systemLog.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ])

      // 分面计数：分类 / 级别（用于页签徽标；范围 = 除自身维度外的其它筛选）
      const catWhereBase = { ...where }
      const facets = { categories: {}, levels: {} }
      await Promise.all(CATEGORIES.map(async (c) => {
        const w = { AND: [catWhereBase, { OR: categoryWhere(c).OR || [] }].filter(Boolean) }
        if (c === 'system') {
          facets.categories[c] = await prisma.systemLog.count({
            where: { AND: [catWhereBase, { OR: [{ context: { path: ['category'], equals: 'system' } }, { context: { path: ['category'], equals: null } }] }] },
          }).catch(() => 0)
        } else {
          facets.categories[c] = await prisma.systemLog.count({
            where: { AND: [catWhereBase, { context: { path: ['category'], equals: c } }] },
          }).catch(() => 0)
        }
        void w
      }))
      await Promise.all(['info', 'warn', 'error', 'debug'].map(async (lv) => {
        facets.levels[lv] = await prisma.systemLog.count({ where: { AND: [catWhereBase, { level: lv }] } }).catch(() => 0)
      }))

      res.json({
        success: true,
        data: {
          items: rows.map(toView),
          total,
          page,
          pageSize,
          facets,
          labels: CATEGORY_LABELS,
        },
      })
    } catch (e) {
      console.error(`${TAG} 日志查询失败:`, e)
      res.status(500).json({ success: false, error: e.message || '查询失败' })
    }
  })

  // ── 按天 × 分类统计 + 表体量 ──
  router.get('/stats', async (req, res) => {
    try {
      await ensureBackfill()
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 30))
      const since = new Date(Date.now() - days * 86400_000)
      const rows = await prisma.systemLog.findMany({
        where: { created_at: { gte: since } },
        select: { created_at: true, level: true, context: true },
        orderBy: { created_at: 'asc' },
        take: 50000,
      })
      const byDay = {}
      const totals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]))
      const levels = { info: 0, warn: 0, error: 0, debug: 0 }
      for (const r of rows) {
        const d = new Date(r.created_at)
        const p = (n) => String(n).padStart(2, '0')
        const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
        const cat = r.context?.category || 'system'
        byDay[day] = byDay[day] || { day, total: 0, categories: {} }
        byDay[day].total += 1
        byDay[day].categories[cat] = (byDay[day].categories[cat] || 0) + 1
        totals[cat] = (totals[cat] || 0) + 1
        levels[r.level] = (levels[r.level] || 0) + 1
      }
      let tableBytes = 0, rowCount = 0
      try {
        const r = await prisma.$queryRawUnsafe(`SELECT pg_total_relation_size('public."SystemLog"')::bigint AS sz, (SELECT count(*)::int FROM public."SystemLog") AS n`)
        tableBytes = Number(r?.[0]?.sz) || 0
        rowCount = Number(r?.[0]?.n) || 0
      } catch { /* 忽略体量统计失败 */ }
      res.json({
        success: true,
        data: {
          days,
          byDay: Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1)),
          totals,
          levels,
          tableBytes,
          rowCount,
          labels: CATEGORY_LABELS,
        },
      })
    } catch (e) {
      console.error(`${TAG} 日志统计失败:`, e)
      res.status(500).json({ success: false, error: e.message || '统计失败' })
    }
  })

  // ── 保留策略：读 ──
  router.get('/retention', async (_req, res) => {
    try {
      const cfg = readRetention()
      res.json({ success: true, data: { ...cfg, categories: CATEGORIES, labels: CATEGORY_LABELS, defaults: DEFAULT_RULES } })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message || '读取失败' })
    }
  })

  // ── 保留策略：改 ──
  router.post('/retention', async (req, res) => {
    try {
      const rules = req.body?.rules
      if (!rules || typeof rules !== 'object') return res.status(400).json({ success: false, error: '缺少 rules' })
      for (const c of Object.keys(rules)) {
        if (!CATEGORIES.includes(c)) return res.status(400).json({ success: false, error: `未知分类: ${c}` })
        for (const k of Object.keys(rules[c] || {})) {
          if (!['retentionDays', 'compressAfterDays'].includes(k)) return res.status(400).json({ success: false, error: `未知字段: ${c}.${k}` })
          const v = Number(rules[c][k])
          if (!Number.isInteger(v) || v < 0 || v > 3650) {
            return res.status(400).json({ success: false, error: `${c}.${k} 必须是 0~3650 的整数（0 = 永久保留 / 不压缩）` })
          }
        }
      }
      const next = writeRetention({ rules, auto: req.body?.auto })
      await writeAdminOpsLog(prisma, {
        action: 'log_retention_update',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: '', targetSchoolCode: null,
        details: { rules: next.rules, auto: next.auto },
        level: 'warn',
      })
      res.json({ success: true, data: next })
    } catch (e) {
      res.status(400).json({ success: false, error: e.message || '保存失败' })
    }
  })

  // ── 执行清理/压缩（dryRun 先预览）──
  router.post('/purge', async (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false
      const r = await applyRetention(prisma, { dryRun, auto: false })
      if (!dryRun) {
        await writeAdminOpsLog(prisma, {
          action: 'log_purge_run',
          actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
          targetId: '', targetSchoolCode: null,
          details: { deleted: r.totalDeleted, rollups: r.totalRollups, per_category: r.categories },
          level: 'warn',
        })
      }
      res.json({ success: true, data: r })
    } catch (e) {
      console.error(`${TAG} 清理失败:`, e)
      res.status(500).json({ success: false, error: e.message || '清理失败' })
    }
  })

  // ── 导出（按当前筛选，NDJSON 流式返回）──
  router.post('/export', async (req, res) => {
    try {
      const where = buildWhere(req.body || {})
      const rows = await prisma.systemLog.findMany({ where, orderBy: { created_at: 'desc' }, take: MAX_EXPORT_ROWS })
      const fname = `systemlog-${new Date().toISOString().slice(0, 10)}-${rows.length}.ndjson`
      await writeAdminOpsLog(prisma, {
        action: 'log_export',
        actor: { userId: req.user?.userId, username: req.user?.username, role: req.user?.role, schoolCode: null, ip: req.ip },
        targetId: '', targetSchoolCode: null,
        details: { count: rows.length, filter: { category: req.body?.category || 'all', level: req.body?.level || 'all', since: req.body?.since || null, until: req.body?.until || null, q: req.body?.q || null } },
        level: 'info',
      })
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`)
      for (const r of rows) res.write(`${JSON.stringify(r)}\n`)
      res.end()
    } catch (e) {
      console.error(`${TAG} 导出失败:`, e)
      res.status(500).json({ success: false, error: e.message || '导出失败' })
    }
  })

  // ── 文件清单 ──
  router.get('/files', async (_req, res) => {
    try {
      const out = []
      // ① 应用日志目录（foodsentinel 属主，直接读）
      for (const e of await fsp.readdir(APP_LOG_DIR, { withFileTypes: true }).catch(() => [])) {
        if (!e.isFile()) continue
        const p = path.join(APP_LOG_DIR, e.name)
        try {
          const st = await fsp.stat(p)
          out.push({ path: p, name: e.name, size: st.size, mtime: st.mtimeMs, readable: true })
        } catch { /* 忽略 */ }
      }
      // ② root 属主目录（经包装脚本 ls）
      for (const dir of ['/mnt/datadisk0/system-logs/syslog', '/mnt/datadisk0/system-logs/journal']) {
        try {
          const raw = await sudoManage('ls', dir)
          for (const line of raw.trim().split('\n').filter(Boolean)) {
            const [size, mtime, ...rest] = line.split('\t')
            const p = rest.join('\t')
            out.push({ path: p, name: path.basename(p), size: Number(size), mtime: Number(mtime) * 1000, readable: true })
          }
        } catch { /* 目录不存在 */ }
      }
      out.sort((a, b) => b.mtime - a.mtime)
      res.json({ success: true, data: { files: out.slice(0, 300), dirs: VIEW_DIRS, maxLines: MAX_VIEW_LINES } })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message || '读取失败' })
    }
  })

  // ── 查看文件最近 N 行 ──
  router.get('/files/view', async (req, res) => {
    try {
      const p = String(req.query.path || '')
      assertViewPath(p)
      const lines = Math.min(MAX_VIEW_LINES, Math.max(10, Number(req.query.lines) || 200))
      const q = String(req.query.q || '')
      const isGz = /\.gz$/.test(p)
      const inAppDir = p.startsWith(APP_LOG_DIR + '/')

      let text = ''
      let truncated = false
      let size = 0
      if (inAppDir) {
        if (isGz) {
          const st = await fsp.stat(p)
          size = st.size
          if (st.size > 40 * 1024 * 1024) return res.status(413).json({ success: false, error: '压缩包过大（>40MB），请下载后查看' })
          const buf = await fsp.readFile(p)
          text = zlib.gunzipSync(buf).toString('utf8')
          truncated = true
        } else {
          const r = await readTailText(p)
          text = r.text
          truncated = r.truncated
          size = r.size
        }
      } else {
        // root 属主：交给包装脚本（tail -n 或 zcat|tail）
        text = await sudoManage('read-lines', p, String(lines * 5))
        truncated = true
        size = 0
      }

      let all = text.split('\n')
      if (truncated && all.length) all = all.slice(1) // 首行可能被截断
      const filtered = filterLines(all, q).filter((l) => l !== '')
      const tail = filtered.slice(-lines)
      res.json({
        success: true,
        data: {
          path: p, size, truncated, lines: tail,
          matched: filtered.length, total: all.length,
          limit: lines, q,
        },
      })
    } catch (e) {
      res.status(400).json({ success: false, error: e.message || '读取失败' })
    }
  })

  // ── 下载文件 ──
  router.get('/files/download', async (req, res) => {
    try {
      const p = String(req.query.path || '')
      assertViewPath(p)
      const inAppDir = p.startsWith(APP_LOG_DIR + '/')
      if (!inAppDir) {
        // root 属主文件：先经脚本落到临时文件再流式返回
        const tmp = path.join('/tmp', `log-dl-${process.pid}-${Date.now()}.log`)
        await sudoManage('copy-out', p, tmp)
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}"`)
        res.setHeader('Content-Type', 'application/octet-stream')
        const stream = fs.createReadStream(tmp)
        stream.pipe(res)
        stream.on('close', () => fs.promises.unlink(tmp).catch(() => {}))
        return
      }
      if (!fs.existsSync(p)) return res.status(404).json({ success: false, error: '文件不存在' })
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p)}"`)
      res.setHeader('Content-Type', 'application/octet-stream')
      fs.createReadStream(p).pipe(res)
    } catch (e) {
      res.status(400).json({ success: false, error: e.message || '下载失败' })
    }
  })

  // ── 单条详情（必须放在静态路径之后）──
  router.get('/:id', async (req, res) => {
    try {
      const row = await prisma.systemLog.findUnique({ where: { id: req.params.id } })
      if (!row) return res.status(404).json({ success: false, error: '日志不存在' })
      res.json({ success: true, data: toView(row) })
    } catch (e) {
      res.status(500).json({ success: false, error: e.message || '查询失败' })
    }
  })

  return router
}

export default { createAdminLogRoutes }
