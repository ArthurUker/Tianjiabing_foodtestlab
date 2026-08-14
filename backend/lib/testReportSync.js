/**
 * testReportSync.js — 浏览器测试结果 → docs 静态报告同步引擎
 *
 * 职责：把数据库 public."TestResult" 的测试结果整理为直观的静态报告，写入
 *   <根>/docs/test-results/latest/
 *     ├── snapshot.json   原始数据快照（结构化，供程序读取）
 *     ├── REPORT.md      Markdown 报告（GitHub/IDE 直接渲染）
 *     ├── index.html     自包含 HTML 报告（内联样式 + 交互筛选/放大，可离线打开）
 *     └── evidence/      证据图片副本（从 backend/uploads/test-evidence/ 复制，相对路径引用）
 *
 * 触发方式：
 *   1. 自动：testResultRoutes.js 在 POST /api/test-results 保存成功后 fire-and-forget 调用；
 *   2. 手动：node scripts/sync-test-results-docs.mjs
 *
 * 说明：
 *   - 报告产物（docs/test-results/latest/）是「整理后的呈现」，权威数据仍在数据库；
 *   - 服务器 git 部署（deploy.sh 的 git fetch + reset）会还原本目录到仓库版本，
 *     需要归档时手动 git add docs/test-results 提交即可。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASE_DEFS, RESULT_LABELS, indexCaseDefs } from './testCaseDefs.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 项目根目录（backend/lib/ → ../..） */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
/** 运行时证据图片目录（上传路由与同步引擎共用） */
export const EVIDENCE_STORE_DIR = path.join(PROJECT_ROOT, 'backend', 'uploads', 'test-evidence')
/** docs 报告输出目录 */
export const DOCS_OUT_DIR = path.join(PROJECT_ROOT, 'docs', 'test-results', 'latest')

const CASE_INDEX = indexCaseDefs()

/** 安全转义 HTML */
function escHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 时间 → 'YYYY-MM-DD HH:mm' */
function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 从 evidence 文本中解析出证据条目列表（支持本地上传 URL 与外链）
 * 兼容两种格式：
 *  - 旧格式：URL/文本按换行逗号分隔的纯文本
 *  - 新格式（有序分步）：JSON 数组 [{"seq":1,"caption":"步骤1","urls":["/api/.../a.png"]}, ...]
 */
function parseEvidenceList(evidence) {
  if (!evidence) return []
  const raw = String(evidence)
  // 新格式：JSON 有序步骤数组 → 展平为带步骤说明的证据条目
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        const list = []
        for (const s of arr) {
          if (!s || typeof s !== 'object') continue
          const urls = Array.isArray(s.urls) ? s.urls : []
          for (const u of urls) {
            list.push({ stepSeq: s.seq, stepCaption: (s.caption || '').trim(), ...tokenizeEvidence(String(u)) })
          }
        }
        if (list.length) return list
      }
    } catch { /* 不是合法 JSON，回退旧格式 */ }
  }
  const list = []
  const tokens = raw.split(/[\n\r,;，；]+/).map((t) => t.trim()).filter(Boolean)
  for (const t of tokens) {
    const item = tokenizeEvidence(t)
    if (item) list.push({ ...item, stepSeq: undefined, stepCaption: '' })
  }
  return list
}

/** 单条证据 token → {type, url|relPath 等}；无法识别则返回 null */
function tokenizeEvidence(t) {
  const m = t.match(/^\/api\/test-results\/evidence\/([^/]+)\/([^/?#]+)$/)
  if (m) {
    const encCaseId = m[1]
    const file = decodeURIComponent(m[2])
    const decCaseId = decodeURIComponent(encCaseId)
    const def = CASE_INDEX.get(decCaseId)
    return {
      raw: t,
      type: 'local',
      encCaseId,
      decCaseId,
      file,
      caseTitle: def ? def.title : decCaseId,
      // relPath 用【解码中文名】做目录：浏览器请求时自动 URL 编码，Caddy 解码后匹配磁盘中文目录。
      // 若用编码名做目录，Caddy 收到解码后的路径找不到文件，会 SPA fallback 返回 HTML 导致图片碎裂。
      relPath: `evidence/${decCaseId}/${encodeURIComponent(file)}`, // 相对 docs/test-results/latest/
    }
  }
  if (/^https?:\/\//i.test(t)) return { raw: t, type: 'url', url: t }
  return null
}

/** 解析全部结果 → 按组组织的结构化快照 */
function buildSnapshot(results) {
  // TD-SyncLatest: 每个 case_id 只保留【最新】一条提交记录。
  // 修复前 bug：findMany 按 updated_at DESC 排序，但 Map.set 后写覆盖先写，
  // 最终每个 case_id 留下的是数组最后一条（= 最旧记录），导致同一用例被多人
  // 复测后，汇总页显示的却是旧结果（如 B6 显示 05:45 的旧记录而非 11:44 的新记录）。
  const byId = new Map()
  for (const r of results) {
    const cur = byId.get(r.case_id)
    if (!cur || (r.updated_at ?? 0) >= (cur.updated_at ?? 0)) byId.set(r.case_id, r)
  }

  // TD-CloseMap: 收集每个 case_id 的最早收口记录（同一 case_id 任一提交人收口即整组收口），
  // 汇总报告页据此打"已收口"标记。
  const closedMap = new Map()
  for (const r of results) {
    if (!r.closed) continue
    const cur = closedMap.get(r.case_id)
    if (!cur || (r.closed_at ?? 0) < (cur.closed_at ?? 0)) {
      closedMap.set(r.case_id, { closed_by: r.closed_by, closed_at: r.closed_at, by_submitter: r.submitted_by })
    }
  }

  const groups = CASE_DEFS.map((g) => {
    const items = g.cases.map((c) => {
      const rec = byId.get(c.id)
      const evidenceList = rec ? parseEvidenceList(rec.evidence) : []
      const closedInfo = closedMap.get(c.id)
      return {
        case_id: c.id,
        case_title: c.title,
        result: rec ? rec.result : 'pending',
        detail: rec?.detail || '',
        evidence: rec?.evidence || '',
        evidence_list: evidenceList,
        submitted_by: rec?.submitted_by || '',
        submitted_by_role: rec?.submitted_by_role || '',
        created_at: rec?.created_at || null,
        updated_at: rec?.updated_at || null,
        // TD-Close: 收口状态 + 收口人/时间（仅整组任一提交人收口后置 true）
        closed: !!closedInfo,
        closed_by: closedInfo?.closed_by || null,
        closed_at: closedInfo?.closed_at || null,
      }
    })
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0, closed: 0 }
    for (const it of items) {
      if (it.closed) counts.closed += 1
      else counts[it.result] += 1
    }
    const done = counts.passed + counts.failed + counts.skipped
    return { group: g.group, groupName: g.groupName, total: items.length, counts, done, items }
  })

  // TD-ExtraGroup: 清单外用例（如前端「新问题反馈」new_问题 组）也纳入报告。
  // 修复前 bug：buildSnapshot 只遍历 CASE_DEFS，new_问题 组 3 条反馈在汇总页完全
  // 不可见，造成「上报成功但汇总看不到」。
  const extraRecs = [...byId.values()].filter((r) => !CASE_INDEX.has(r.case_id))
  if (extraRecs.length) {
    const items = extraRecs.map((rec) => {
      const evidenceList = parseEvidenceList(rec.evidence)
      const closedInfo = closedMap.get(rec.case_id)
      return {
        case_id: rec.case_id,
        case_title: rec.case_title || rec.case_id,
        result: rec.result || 'pending',
        detail: rec?.detail || '',
        evidence: rec?.evidence || '',
        evidence_list: evidenceList,
        submitted_by: rec?.submitted_by || '',
        submitted_by_role: rec?.submitted_by_role || '',
        created_at: rec?.created_at || null,
        updated_at: rec?.updated_at || null,
        closed: !!closedInfo,
        closed_by: closedInfo?.closed_by || null,
        closed_at: closedInfo?.closed_at || null,
      }
    })
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 }
    for (const it of items) counts[it.result] += 1
    const done = counts.passed + counts.failed + counts.skipped
    groups.push({ group: 'new_问题', groupName: '新问题 / 缺陷反馈', total: items.length, counts, done, items })
  }

  const overall = groups.reduce(
    (acc, g) => {
      for (const k of ['passed', 'failed', 'skipped', 'pending', 'closed']) acc[k] += g.counts[k] || 0
      acc.total += g.total
      return acc
    },
    { passed: 0, failed: 0, skipped: 0, pending: 0, closed: 0, total: 0 }
  )
  overall.done = overall.passed + overall.failed + overall.skipped

  return { generated_at: new Date().toISOString(), overall, groups }
}

function escMd(s) {
  return String(s || '').replace(/([\[\]])/g, '\\$1')
}

// ═══════════════════════ Markdown 报告 ═══════════════════════
function renderMarkdown(snap) {
  const L = RESULT_LABELS
  const lines = []
  lines.push('# 浏览器测试结果汇总')
  lines.push('')
  lines.push(`> 生成时间：${fmtDateTime(snap.generated_at)}（数据源：数据库 \`public."TestResult"\`）`)
  lines.push('> 报告目录：`docs/test-results/latest/`；证据图片：`docs/test-results/latest/evidence/`')
  lines.push('')
  lines.push('## 一、总体统计')
  lines.push('')
  lines.push('| 分组 | 通过 | 失败 | 跳过 | 待测 | 已测/总数 | 完成度 |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const g of snap.groups) {
    const pct = g.total ? Math.round((g.done / g.total) * 100) : 0
    lines.push(`| ${g.groupName} | ${g.counts.passed} | ${g.counts.failed} | ${g.counts.skipped} | ${g.counts.pending} | ${g.done}/${g.total} | ${pct}% |`)
  }
  const o = snap.overall
  lines.push(
    `| **合计** | **${o.passed}** | **${o.failed}** | **${o.skipped}** | **${o.pending}** | **${o.done}/${o.total}** | **${o.total ? Math.round((o.done / o.total) * 100) : 0}%** |`
  )
  lines.push('')

  lines.push('## 二、用例明细')
  lines.push('')
  for (const g of snap.groups) {
    lines.push(`### ${g.groupName}`)
    lines.push('')
    lines.push('| 用例 | 结果 | 提交人 | 最近更新 |')
    lines.push('|---|---:|---|---|')
    for (const it of g.items) {
      const r = L[it.result]
      lines.push(`| **${it.case_id}** ${it.case_title} | ${r.emoji} ${r.label} | ${it.submitted_by || '—'} | ${fmtDateTime(it.updated_at) || '—'} |`)
    }
    lines.push('')
    const detailed = g.items.filter((it) => it.detail || it.evidence_list.length)
    if (detailed.length) {
      lines.push('**详情与证据：**')
      lines.push('')
      for (const it of detailed) {
        lines.push(`- **${it.case_id}**（${L[it.result]?.label || it.result}）`)
        if (it.detail) lines.push(`  - 实际表现：${String(it.detail).replace(/\n/g, ' ')}`)
        for (const ev of it.evidence_list) {
          if (ev.type === 'local') {
            lines.push(`  - 证据图：![${escMd(it.case_title || ev.caseTitle || '证据')}](${ev.relPath})`)
          } else {
            lines.push(`  - 证据链接：[${ev.url}](${ev.url})`)
          }
        }
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

// ═══════════════════════ HTML 报告 ═══════════════════════
function renderHtml(snap) {
  const safeJson = JSON.stringify(snap).replace(/</g, '\\u003c')
  const L = RESULT_LABELS
  const groupFilterOptions = snap.groups
    .map((g) => `<option value="${escHtml(g.group)}">${escHtml(g.groupName)}</option>`)
    .join('')
  const resultFilterOptions = Object.entries(L)
    .map(([k, v]) => `<option value="${k}">${v.emoji} ${v.label}</option>`)
    .join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>浏览器测试结果汇总</title>
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<style>
  /* TD-GlassReport: 玻璃态设计语言，与 admin-schools.html 的 .glass 风格一致 */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1f2937; background: linear-gradient(135deg, #ffe6f0 0%, #fff5e6 30%, #e6f3ff 60%, #f0e6ff 100%); min-height: 100vh; }
  .glass-card { background: rgba(255,255,255,0.66); border: 1px solid rgba(255,255,255,0.78); border-radius: 1.7rem; backdrop-filter: blur(14px) saturate(180%); box-shadow: 0 16px 46px rgba(40,60,100,0.2), inset 0 2px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.55), inset 0 0 34px rgba(255,255,255,0.3); }
  .glass-section { background: rgba(255,255,255,0.72); border: 1px solid rgba(255,255,255,0.6); border-radius: 1.25rem; box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 4px 14px rgba(40,60,100,0.08); }
  .glass-tile { background: linear-gradient(135deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.55) 100%); border: 1px solid rgba(255,255,255,0.85); border-radius: 1.25rem; backdrop-filter: blur(10px) saturate(160%); box-shadow: 0 8px 24px rgba(40,60,100,0.12), inset 0 1px 0 rgba(255,255,255,0.95); }
  .glass-input { background: rgba(255,255,255,0.72); border: 1px solid rgba(255,255,255,0.6); border-radius: 1rem; backdrop-filter: blur(8px) saturate(160%); padding: 9px 14px; font-size: 14px; color: #1f2937; transition: all .15s ease; }
  .glass-input:focus { background: rgba(255,255,255,0.92); border-color: rgba(99,102,241,0.5); box-shadow: 0 0 0 3px rgba(99,102,241,0.12); outline: none; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 16px 20px 60px; }
  .topnav { position: sticky; top: 0; z-index: 50; background: rgba(20,28,48,0.86); border-bottom: 1px solid rgba(255,255,255,0.5); backdrop-filter: blur(14px) saturate(180%); color: #fff; }
  .topnav .container { max-width: 1180px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .topnav .brand { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
  .topnav .brand-logo { width: 36px; height: 36px; border-radius: 10px; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .topnav .brand-logo i { color: #fde047; font-size: 18px; }
  .topnav h1 { font-size: 20px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .topnav .brand-tag { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: rgba(255,255,255,0.2); white-space: nowrap; }
  .topnav .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
  .topnav-btn, .topnav-link { display: inline-flex; align-items: center; padding: 7px 14px; border-radius: 10px; font-size: 14px; font-weight: 600; text-decoration: none; cursor: pointer; transition: all .15s ease; box-shadow: 0 2px 6px rgba(0,0,0,0.15); border: none; color: #fff; }
  .topnav-btn:hover, .topnav-link:hover { transform: translateY(-1px); box-shadow: 0 4px 10px rgba(0,0,0,0.2); }
  .topnav-emerald { background: #34d399; } .topnav-emerald:hover { background: #6ee7b7; }
  .topnav-indigo { background: #818cf8; } .topnav-indigo:hover { background: #a5b4fc; }
  .topnav-yellow { background: #facc15; color: #1f2937; } .topnav-yellow:hover { background: #fde047; }
  .topnav-rose { background: #fb7185; } .topnav-rose:hover { background: #fda4af; }
  .topnav-ghost { background: rgba(255,255,255,0.15); color: #fff; } .topnav-ghost:hover { background: rgba(255,255,255,0.25); }
  .topnav-user { display: inline-flex; align-items: center; padding: 6px 12px; border-radius: 10px; background: rgba(255,255,255,0.15); font-size: 13px; }
  .topnav-btn:disabled { opacity: .6; cursor: not-allowed; transform: none; box-shadow: none; }
  .topnav-btn i { display: inline-block; transition: transform .4s ease; }
  .topnav-btn.spin i { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .topnav .pulse { animation: pulse 1.5s infinite; box-shadow: 0 0 0 0 rgba(79,70,229,0.4); }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(79,70,229,0.4); } 70% { box-shadow: 0 0 0 10px rgba(79,70,229,0); } 100% { box-shadow: 0 0 0 0 rgba(79,70,229,0); } }
  .meta-bar { padding: 12px 18px; margin-bottom: 18px; font-size: 13px; color: #4b5563; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .meta-bar code { background: rgba(255,255,255,0.6); padding: 2px 8px; border-radius: 6px; font-size: 12px; border: 1px solid rgba(255,255,255,0.7); }
  .hidden { display: none !important; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 22px; }
  .card { padding: 20px; }
  .card .gname { font-size: 15px; font-weight: 600; color: #374151; }
  .card .num-row { display: flex; align-items: baseline; gap: 6px; margin-top: 12px; }
  .card .num { font-size: 36px; font-weight: 700; line-height: 1; background: linear-gradient(135deg, #10b981 0%, #6366f1 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .card .num-total { font-size: 15px; color: #6b7280; }
  .card .pct { margin-left: auto; font-size: 12px; color: #475569; background: rgba(255,255,255,0.6); padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.7); backdrop-filter: blur(8px); }
  .card .chips { margin-top: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; font-size: 13px; }
  .chip { display: flex; align-items: center; gap: 8px; }
  .chip .icon { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .chip .lbl { color: #4b5563; flex: 1; }
  .chip .v { font-weight: 700; color: #111827; }
  .progress { width: 100%; height: 6px; background: rgba(229,231,235,0.6); border-radius: 999px; margin-top: 12px; overflow: hidden; }
  .progress > div { height: 100%; background: linear-gradient(90deg, #34d399 0%, #6366f1 100%); border-radius: 999px; transition: width .3s ease; }
  .filters { display: flex; gap: 12px; flex-wrap: wrap; padding: 18px 22px; margin-bottom: 14px; }
  .filters select { min-width: 130px; }
  .filters input { flex: 1; min-width: 220px; }
  /* 整页卡片网格：列数随容器宽度自动增加（窗口越大列越多），每张卡片保留最小宽度以容纳左文右图两列布局 */
  #list { display: grid; grid-template-columns: repeat(auto-fill, minmax(440px, 1fr)); gap: 16px; }
  .item { padding: 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; min-height: 220px; transition: all .2s ease; }
  .item:hover { background: rgba(255,255,255,0.85); transform: translateY(-1px); box-shadow: 0 12px 36px rgba(40,60,100,0.15), inset 0 2px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.55); }
  .item-text { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .badge { width: fit-content; min-width: 64px; text-align: center; border-radius: 12px; padding: 6px 10px; font-size: 12px; font-weight: 600; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
  .item .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 700; background: linear-gradient(135deg, rgba(99,102,241,0.1) 0%, rgba(16,185,129,0.1) 100%); color: #4f46e5; padding: 3px 10px; border-radius: 8px; border: 1px solid rgba(99,102,241,0.15); display: inline-block; }
  .item .title { font-size: 14px; color: #1f2937; font-weight: 500; line-height: 1.5; }
  .item .meta { font-size: 12px; color: #6b7280; }
  .item .detail { font-size: 13px; color: #92400e; background: rgba(254,243,199,0.65); border: 1px solid rgba(252,211,77,0.5); border-radius: 12px; padding: 10px 14px; white-space: pre-wrap; backdrop-filter: blur(6px); }
  .evid { display: grid; grid-template-columns: 1fr; grid-template-rows: 1fr; height: 100%; min-height: 0; }
  .evid .pic { position: relative; border-radius: 12px; overflow: hidden; border: 2px solid rgba(255,255,255,0.8); box-shadow: 0 4px 10px rgba(40,60,100,0.15); transition: all .2s ease; background: rgba(255,255,255,0.5); height: 100%; min-height: 0; }
  .evid .pic:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(40,60,100,0.2); border-color: #6366f1; }
  .evid img.thumb { width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in; }
  .evid .caption { position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 10px; font-size: 11px; color: #fff; background: linear-gradient(to top, rgba(0,0,0,0.65), transparent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .evid.multi { grid-template-columns: repeat(2, 1fr); grid-template-rows: repeat(auto-fit, minmax(100px, 1fr)); }
  .evid a.ext { font-size: 13px; color: #4f46e5; text-decoration: none; background: rgba(238,242,255,0.7); border: 1px solid rgba(99,102,241,0.25); border-radius: 10px; padding: 8px 14px; align-self: center; }
  .count-line { font-size: 13px; color: #6b7280; margin: 14px 4px 10px; }
  .empty { text-align: center; color: #9ca3af; padding: 60px 0; font-size: 14px; }
  #lightbox { position: fixed; inset: 0; background: rgba(15,23,42,0.85); backdrop-filter: blur(8px); display: none; align-items: center; justify-content: center; z-index: 99; cursor: zoom-out; }
  #lightbox img { max-width: 92vw; max-height: 90vh; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  /* 窄屏（卡片最小宽度放不下两列并排）时，整页与卡片内部都改为上下堆叠 */
  @media (max-width: 460px) { #list { grid-template-columns: 1fr; } }
  @media (max-width: 720px) { .topnav .container { padding: 12px 14px; } .item { grid-template-columns: 1fr; padding: 16px; } .badge { width: fit-content; } .filters { padding: 14px; } }
</style>
</head>
<body>
<nav class="topnav">
  <div class="container">
    <div class="brand">
      <div class="brand-logo"><i class="fas fa-flask"></i></div>
      <h1>浏览器测试结果汇总</h1>
      <span class="brand-tag">汇总报告</span>
    </div>
    <div class="actions">
      <a href="/test-report.html" class="topnav-link topnav-emerald"><i class="fas fa-clipboard-check mr-1.5"></i>测试报告</a>
      <span class="topnav-btn topnav-yellow"><i class="fas fa-chart-bar mr-1.5"></i>汇总报告</span>
      <span id="userInfo" class="topnav-user hidden"><i class="fas fa-user-circle mr-1.5"></i><span id="userName">—</span></span>
      <button id="logoutBtn" type="button" class="topnav-btn topnav-rose hidden"><i class="fas fa-sign-out-alt mr-1.5"></i>退出</button>
      <a id="loginLink" href="/super-admin-login.html" class="topnav-link topnav-indigo hidden"><i class="fas fa-sign-in-alt mr-1.5"></i>登录</a>
      <button id="refreshBtn" type="button" class="topnav-btn topnav-indigo"><i class="fas fa-sync-alt mr-1.5"></i>刷新</button>
    </div>
  </div>
</nav>

<div class="wrap">
  <div class="meta-bar glass-section">
    生成时间：<span id="genTime"></span> · 数据源：数据库 <code>public."TestResult"</code> · 证据图片见本目录 <code>evidence/</code>
  </div>

  <div class="cards" id="cards"></div>

  <div class="filters glass-section">
    <select id="fGroup" class="glass-input"><option value="">全部分组</option>${groupFilterOptions}</select>
    <select id="fResult" class="glass-input"><option value="">全部结果</option>${resultFilterOptions}</select>
    <select id="fUser" class="glass-input"><option value="">全部提交人</option></select>
    <select id="fClosed" class="glass-input" title="收口筛选：已收口=测试任务已完成/不再继续；未收口=可继续测试"><option value="">全部收口</option><option value="open">未收口</option><option value="closed">已收口</option></select>
    <input id="fKeyword" type="search" class="glass-input" placeholder="🔍 搜索用例编号 / 标题 / 实际表现…">
  </div>
  <div class="count-line" id="countLine"></div>
  <div id="list"></div>
  <div class="empty" id="empty" style="display:none">没有符合条件的用例</div>
</div>
<div id="lightbox"><img id="lbImg" src="" alt=""></div>

<script>
const SNAPSHOT = ${safeJson};
const LABELS = ${JSON.stringify(Object.fromEntries(Object.entries(L).map(([k, v]) => [k, { label: v.label, emoji: v.emoji, color: v.color }])))};
const $ = (id) => document.getElementById(id);

function fmt(t) { if (!t) return '—'; const d = new Date(t); if (isNaN(d)) return '—'; const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// TD-CloseAction: 当前登录状态（按钮权限判定用）
// 必须在 renderList 等任何调用之前声明，避免 let 暂时性死区（TDZ）导致
// "Cannot access '_loginState' before initialization"。
let _loginState = { loggedIn: false, username: null, role: null }
function getLoginState() { return _loginState }

function renderCards() {
  $('cards').innerHTML = SNAPSHOT.groups.map(g => {
    const pct = g.total ? Math.round(g.done / g.total * 100) : 0;
    const remain = g.total - g.done;
    const mkChip = (k, lbl) => '<div class="chip" style="color:' + LABELS[k].color + '"><i class="icon">' + LABELS[k].emoji + '</i><span class="lbl">' + lbl + '</span><span class="v">' + (k === 'pending' ? remain : g.counts[k]) + '</span></div>';
    const chips = mkChip('passed','通过') + mkChip('failed','失败') + mkChip('skipped','跳过') + mkChip('pending','待测');
    return '<div class="card glass-tile">' +
      '<div class="gname">' + esc(g.groupName.split(' · ')[0]) + '</div>' +
      '<div class="num-row"><span class="num">' + g.done + '</span><span class="num-total">/ ' + g.total + ' 项</span>' +
      '<span class="pct">完成 ' + pct + '%</span></div>' +
      '<div class="progress"><div style="width:' + pct + '%"></div></div>' +
      '<div class="chips">' + chips + '</div></div>';
  }).join('');
  const u = new Set();
  SNAPSHOT.groups.forEach(g => g.items.forEach(it => { if (it.submitted_by) u.add(it.submitted_by); }));
  $('fUser').innerHTML = '<option value="">全部提交人</option>' + [...u].map(x => '<option>' + esc(x) + '</option>').join('');
}

function allItems() { const a = []; SNAPSHOT.groups.forEach(g => g.items.forEach(it => a.push(it))); return a; }

function renderList() {
  const fg = $('fGroup').value, fr = $('fResult').value, fu = $('fUser').value, kw = $('fKeyword').value.trim().toLowerCase();
  // TD-CloseFilter: 列表筛选增加 closed 维度
  const fClosed = $('fClosed') ? $('fClosed').value : '';
  const items = allItems().filter(it =>
    (!fg || it.group === fg) &&
    (!fr || it.result === fr) &&
    (!fu || it.submitted_by === fu) &&
    (!fClosed || (fClosed === 'closed' ? !!it.closed : !it.closed)) &&
    (!kw || (it.case_id + ' ' + it.case_title + ' ' + it.detail).toLowerCase().includes(kw))
  );
  $('empty').style.display = items.length ? 'none' : 'block';
  $('list').innerHTML = items.map(it => {
    const b = LABELS[it.result] || { label: it.result, emoji: '?', color: '#9ca3af' };
    const localEvs = (it.evidence_list || []).filter(e => e.type === 'local');
    const urlEvs = (it.evidence_list || []).filter(e => e.type === 'url');
    const pics = localEvs.map(e => {
      const cap = e.stepCaption ? esc(e.stepCaption) : '';
      return '<div class="pic">' +
        '<img class="thumb" src="' + esc(e.relPath) + '" alt="' + esc(it.case_title) + '" onclick="openLb(this.src)">' +
        (cap ? '<div class="caption">' + cap + '</div>' : '') +
        '</div>';
    }).join('');
    const links = urlEvs.map(e => '<a class="ext" href="' + esc(e.url) + '" target="_blank" rel="noopener">🔗 证据链接</a>').join('');
    const evidClass = 'evid' + (localEvs.length > 1 ? ' multi' : '');
    const GRAD = { passed: 'linear-gradient(135deg,#34d399,#10b981)', failed: 'linear-gradient(135deg,#fb7185,#e11d48)', skipped: 'linear-gradient(135deg,#fbbf24,#d97706)', pending: 'linear-gradient(135deg,#cbd5e1,#94a3b8)' };
    // TD-Close: 已收口时灰化卡片 + 显示「已收口」徽章 + 收口人/时间
    const closedAt = it.closed_at ? fmt(it.closed_at) : '';
    const closedBadge = it.closed
      ? '<span class="badge" style="background:linear-gradient(135deg,#94a3b8,#64748b); margin-left:6px">🔒 已收口</span>'
      : '';
    const closedMeta = it.closed
      ? '<div class="meta">🔒 收口人：' + esc(it.closed_by || '—') + (closedAt ? ' · 🕐 收口时间：' + closedAt : '') + '</div>'
      : '';
    // 收口/打开按钮：仅已登录用户可见
    const loginState = (typeof getLoginState === 'function') ? getLoginState() : { loggedIn: false };
    const actionBtn = loginState.loggedIn
      ? (it.closed
          ? '<button class="btn-closed-open" data-case="' + esc(it.case_id) + '" data-closed="0" style="background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.3); color:#4f46e5; padding:6px 12px; border-radius:10px; font-size:12px; font-weight:600; cursor:pointer;"><i class="fas fa-lock-open mr-1"></i>打开收口</button>'
          : '<button class="btn-closed-open" data-case="' + esc(it.case_id) + '" data-closed="1" style="background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.3); color:#059669; padding:6px 12px; border-radius:10px; font-size:12px; font-weight:600; cursor:pointer;"><i class="fas fa-lock mr-1"></i>收口</button>')
      : '';
    const cardOpacity = it.closed ? 'opacity:.78;' : '';
    return '<div class="item glass-section" style="' + cardOpacity + '">' +
      '<div class="item-text">' +
      '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">' +
        '<div class="badge" style="background:' + (GRAD[it.result] || '#9ca3af') + '">' + b.emoji + ' ' + b.label + '</div>' +
        closedBadge +
        (actionBtn ? '<div style="margin-left:auto">' + actionBtn + '</div>' : '') +
      '</div>' +
      '<div class="id">' + esc(it.case_id) + '</div>' +
      '<div class="title">' + esc(it.case_title) + '</div>' +
      '<div class="meta">👤 提交人：' + esc(it.submitted_by || '—') + ' · 🕐 更新：' + fmt(it.updated_at) + '</div>' +
      closedMeta +
      (it.detail ? '<div class="detail">' + esc(it.detail) + '</div>' : '') +
      (links ? '<div>' + links + '</div>' : '') +
      '</div>' +
      (pics ? '<div class="' + evidClass + '">' + pics + '</div>' : '') +
      '</div>';
  }).join('');
  // 绑定收口/打开按钮事件
  $('list').querySelectorAll('.btn-closed-open').forEach((btn) => {
    btn.addEventListener('click', () => toggleClosed(btn.dataset.case, btn.dataset.closed === '1', btn));
  });
  const done = items.filter((it) => it.result !== 'pending' && !it.closed).length;
  const closed = items.filter((it) => it.closed).length;
  let line = '共 ' + items.length + ' 项（已测 ' + done + '）';
  if (closed) line += ' · 已收口 ' + closed;
  $('countLine').textContent = line;
}

function openLb(src) { $('lbImg').src = src; $('lightbox').style.display = 'flex'; }
$('lightbox').addEventListener('click', () => $('lightbox').style.display = 'none');
['fGroup','fResult','fUser'].forEach(id => $(id).addEventListener('change', renderList));
$('fKeyword').addEventListener('input', renderList);

$('genTime').textContent = fmt(SNAPSHOT.generated_at);
renderCards();
renderList();

// 从 localStorage/sessionStorage 探测 token（兼容命名空间 key）
// 修订：原正则要求两段都恰好以 eyJ 开头，很多合法 JWT 因 payload/signature 段非 eyJ 开头
// 而被误判为非法，导致页面看不到登录态。改为按 JWT 形态（三段 base64url）校验，不强制每段前缀。
function findToken() {
  try {
    for (const store of [sessionStorage, localStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k || (!k.startsWith('auth_token') && k !== 'token')) continue;
        const v = store.getItem(k);
        if (v && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return v;
      }
    }
  } catch (e) { /* 存储不可用时忽略 */ }
  return null;
}

async function apiGet(path, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(path, { headers });
  if (r.status === 401) throw new Error('UNAUTHORIZED');
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.json();
}

function redirectToLogin() {
  const here = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = '/super-admin-login.html?redirect=' + here;
}

// 未登录/令牌失效时：高亮登录入口，并询问是否跳转到登录页
function promptLogin(reason) {
  const link = $('loginLink');
  link.classList.remove('hidden');
  link.classList.add('pulse');
  link.title = reason || '请先登录';
  if (confirm((reason || '当前操作需要登录') + '，是否前往登录页？')) {
    redirectToLogin();
  }
}

// 注：_loginState / getLoginState 已提前至脚本顶部声明（见 esc 之后），
// 此处不再重复声明，避免 let 重声明与 TDZ 问题。

async function initUser() {
  const token = findToken();
  if (!token) {
    // 无 token 时显示登录入口，让用户点击进入超管登录；
    // 不主动跳转，避免用户仅仅是浏览公开数据时被强制打断。
    $('loginLink').classList.remove('hidden');
    return;
  }
  try {
    const j = await apiGet('/api/test-results/me', token);
    if (!j.success || !j.data.username) {
      $('loginLink').classList.remove('hidden');
      return;
    }
    $('userName').textContent = j.data.username + (j.data.role ? ' (' + j.data.role + ')' : '');
    $('userInfo').classList.remove('hidden');
    $('logoutBtn').classList.remove('hidden');
    $('loginLink').classList.add('hidden');
    _loginState = { loggedIn: true, username: j.data.username, role: j.data.role || null }
    // 登录后让每张卡显示「收口/打开」按钮
    try { renderList() } catch (e) { /* 首次加载时 renderList 还未定义 */ }
  } catch (e) {
    if (e.message === 'UNAUTHORIZED') {
      // 登录已过期：直接跳超管登录页，不弹窗
      redirectToLogin();
      return;
    }
    console.error('获取当前用户失败:', e.message);
  }
}

// TD-CloseAction: 收口/打开用例（按 case_id 维度，整组任一提交人都会受影响）
async function toggleClosed(caseId, toClosed, btn) {
  if (!_loginState.loggedIn) { promptLogin('收口操作需要先登录'); return; }
  const action = toClosed ? '收口' : '打开'
  if (!confirm('确认要【' + action + '】用例 ' + caseId + ' 吗？\\n\\n' + (toClosed
    ? '收口后该用例将归入「已完成」，上报系统不再显示此用例。'
    : '打开后该用例可重新测试。'))) return
  const oldHtml = btn.innerHTML
  btn.disabled = true
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>' + (toClosed ? '收口中…' : '打开中…')
  try {
    const r = await fetch('/api/test-results/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + findToken() },
      body: JSON.stringify({ case_ids: [caseId], closed: toClosed }),
    })
    const j = await r.json()
    if (!j.success) throw new Error(j.error || '操作失败')
    // 收口/打开成功后让后端重新生成报告（close 路由内已触发 scheduleDocsSync）。
    // 等待 1.5s 让同步完成，然后带时间戳重新加载页面（避免浏览器缓存旧 snapshot.json）
    setTimeout(() => { window.location.href = window.location.pathname + '?_=' + Date.now() }, 1500)
  } catch (e) {
    alert('操作失败：' + e.message)
    btn.disabled = false
    btn.innerHTML = oldHtml
  }
}

$('logoutBtn').addEventListener('click', () => {
  try {
    ['auth_token', 'current_user', 'token_expiry', 'refresh_token',
     'auth_token_updated_at', 'auth_refresh_rotated_at', 'auth_refresh_lock'].forEach((base) => {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k === base || k.startsWith(base + '__')) localStorage.removeItem(k);
      }
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k === base || k.startsWith(base + '__')) sessionStorage.removeItem(k);
      }
    });
  } catch (e) { /* 忽略 */ }
  window.location.href = '/super-admin-login.html';
});

// 刷新：重新从数据库生成报告并重建 dist，然后带时间戳重新加载页面（避免浏览器缓存）
// 修订：未登录或 token 失效时直接跳超管登录页，不再弹窗询问（避免被「刷新需要先登录」打断）。
async function refreshReport() {
  const btn = $('refreshBtn');
  if (btn.disabled) return;

  const token = findToken();
  if (!token) {
    redirectToLogin();
    return;
  }

  function resetBtn() {
    btn.disabled = false;
    btn.classList.remove('spin');
    btn.innerHTML = '<i class="fas fa-sync-alt mr-1.5"></i>刷新';
  }

  btn.disabled = true;
  btn.classList.add('spin');
  btn.innerHTML = '<i class="fas fa-sync-alt mr-1.5"></i>刷新中...';
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
    const r = await fetch('/api/test-results/sync', { method: 'POST', headers });
    if (r.status === 401) {
      // 登录已过期：直接跳超管登录页，不弹窗
      redirectToLogin();
      return;
    }
    const j = await r.json();
    if (!j.success) throw new Error(j.error || '刷新失败');
    window.location.href = window.location.pathname + '?_=' + Date.now();
  } catch (e) {
    alert('刷新失败：' + e.message);
    resetBtn();
  }
}
$('refreshBtn').addEventListener('click', refreshReport);
initUser();
</script>
</body>
</html>
`
}

// ═══════════════════════ 同步主流程 ═══════════════════════
/**
 * 同步测试结果到 docs/test-results/latest/
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} opts.prisma - 基础 prisma 实例（public schema）
 * @param {string} [opts.outDir] - 输出目录（默认 docs/test-results/latest，测试可覆盖）
 * @param {string} [opts.evidenceDir] - 证据源目录（默认 backend/uploads/test-evidence）
 * @returns {Promise<{ok: boolean, generatedAt: string, groupCount: number, itemCount: number, evidenceCopied: number}>}
 */
export async function syncTestResultDocs({ prisma, outDir = DOCS_OUT_DIR, evidenceDir = EVIDENCE_STORE_DIR }) {
  const results = await prisma.testResult.findMany({ orderBy: { updated_at: 'desc' } })
  const snap = buildSnapshot(results)

  fs.mkdirSync(outDir, { recursive: true })

  // 1) snapshot.json
  fs.writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(snap, null, 2), 'utf8')

  // 2) REPORT.md
  fs.writeFileSync(path.join(outDir, 'REPORT.md'), renderMarkdown(snap), 'utf8')

  // 3) index.html
  fs.writeFileSync(path.join(outDir, 'index.html'), renderHtml(snap), 'utf8')

  // 4) 证据图片副本（先清空再复制，保证与数据库引用一致）
  // TD-SyncRobust: 清空失败（如目录被 root 属主占位导致 EACCES）不应阻断整个同步。
  // 降级为「不清空、直接覆盖复制」，snapshot/REPORT/index 仍正常生成，仅可能残留旧孤儿图片。
  const evOutDir = path.join(outDir, 'evidence')
  try {
    fs.rmSync(evOutDir, { recursive: true, force: true })
  } catch (e) {
    console.error('[testReportSync] 清空 evidence 目录失败（将继续覆盖复制）:', e?.message || e)
  }
  let evidenceCopied = 0
  for (const g of snap.groups) {
    for (const it of g.items) {
      for (const ev of it.evidence_list) {
        if (ev.type !== 'local') continue
        // 源目录与输出目录统一用【解码中文名】（上传路由已改为中文目录，见 testResultRoutes.js /upload）
        const src = path.join(evidenceDir, ev.decCaseId, ev.file)
        if (!fs.existsSync(src)) continue
        const dstDir = path.join(evOutDir, ev.decCaseId)
        fs.mkdirSync(dstDir, { recursive: true })
        fs.copyFileSync(src, path.join(dstDir, ev.file))
        evidenceCopied += 1
      }
    }
  }

  return {
    ok: true,
    generatedAt: snap.generated_at,
    groupCount: snap.groups.length,
    itemCount: snap.overall.total,
    evidenceCopied,
  }
}
