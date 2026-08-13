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
  const byId = new Map()
  for (const r of results) byId.set(r.case_id, r)

  const groups = CASE_DEFS.map((g) => {
    const items = g.cases.map((c) => {
      const rec = byId.get(c.id)
      const evidenceList = rec ? parseEvidenceList(rec.evidence) : []
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
      }
    })
    const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 }
    for (const it of items) counts[it.result] += 1
    const done = counts.passed + counts.failed + counts.skipped
    return { group: g.group, groupName: g.groupName, total: items.length, counts, done, items }
  })

  const overall = groups.reduce(
    (acc, g) => {
      for (const k of ['passed', 'failed', 'skipped', 'pending']) acc[k] += g.counts[k]
      acc.total += g.total
      return acc
    },
    { passed: 0, failed: 0, skipped: 0, pending: 0, total: 0 }
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
<style>
  /* TD-GlassReport: 玻璃态设计语言，与 admin-schools.html 的 .glass 风格一致 */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1f2937; background: linear-gradient(135deg, #ffe6f0 0%, #fff5e6 30%, #e6f3ff 60%, #f0e6ff 100%); min-height: 100vh; }
  .glass-card { background: rgba(255,255,255,0.66); border: 1px solid rgba(255,255,255,0.78); border-radius: 1.7rem; backdrop-filter: blur(14px) saturate(180%); box-shadow: 0 16px 46px rgba(40,60,100,0.2), inset 0 2px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.55), inset 0 0 34px rgba(255,255,255,0.3); }
  .glass-section { background: rgba(255,255,255,0.72); border: 1px solid rgba(255,255,255,0.6); border-radius: 1.25rem; box-shadow: inset 0 1px 0 rgba(255,255,255,0.7), 0 4px 14px rgba(40,60,100,0.08); }
  .glass-tile { background: linear-gradient(135deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.55) 100%); border: 1px solid rgba(255,255,255,0.85); border-radius: 1.25rem; backdrop-filter: blur(10px) saturate(160%); box-shadow: 0 8px 24px rgba(40,60,100,0.12), inset 0 1px 0 rgba(255,255,255,0.95); }
  .glass-input { background: rgba(255,255,255,0.72); border: 1px solid rgba(255,255,255,0.6); border-radius: 1rem; backdrop-filter: blur(8px) saturate(160%); padding: 9px 14px; font-size: 14px; color: #1f2937; transition: all .15s ease; }
  .glass-input:focus { background: rgba(255,255,255,0.92); border-color: rgba(99,102,241,0.5); box-shadow: 0 0 0 3px rgba(99,102,241,0.12); outline: none; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 60px; }
  header { padding: 28px 32px; margin-bottom: 22px; }
  header .h-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header .icon-box { width: 52px; height: 52px; border-radius: 14px; background: linear-gradient(135deg, #34d399 0%, #6366f1 100%); color: white; display: flex; align-items: center; justify-content: center; box-shadow: 0 6px 20px rgba(99,102,241,0.3); font-size: 22px; }
  header h1 { font-size: 22px; font-weight: 700; color: #1f2937; }
  header .meta { color: #6b7280; font-size: 13px; margin-top: 4px; }
  header .meta code { background: rgba(255,255,255,0.6); padding: 2px 8px; border-radius: 6px; font-size: 12px; border: 1px solid rgba(255,255,255,0.7); }
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
  .item { padding: 18px 22px; margin-bottom: 12px; display: flex; gap: 16px; align-items: stretch; transition: all .2s ease; }
  .item:hover { background: rgba(255,255,255,0.85); transform: translateY(-1px); box-shadow: 0 12px 36px rgba(40,60,100,0.15), inset 0 2px 0 rgba(255,255,255,0.95), inset 0 0 0 1px rgba(255,255,255,0.55); }
  .badge { flex-shrink: 0; min-width: 72px; text-align: center; border-radius: 14px; padding: 8px 10px; height: fit-content; font-size: 13px; font-weight: 600; color: #fff; align-self: flex-start; box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
  .item .body { flex: 1; min-width: 0; }
  .item .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 700; background: linear-gradient(135deg, rgba(99,102,241,0.1) 0%, rgba(16,185,129,0.1) 100%); color: #4f46e5; padding: 3px 10px; border-radius: 8px; border: 1px solid rgba(99,102,241,0.15); display: inline-block; }
  .item .title { font-size: 14px; color: #1f2937; margin-top: 8px; font-weight: 500; line-height: 1.5; }
  .item .meta { font-size: 12px; color: #6b7280; margin-top: 6px; }
  .item .detail { font-size: 13px; color: #92400e; background: rgba(254,243,199,0.65); border: 1px solid rgba(252,211,77,0.5); border-radius: 12px; padding: 10px 14px; margin-top: 10px; white-space: pre-wrap; backdrop-filter: blur(6px); }
  .evid { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
  .evid img.thumb { width: 96px; height: 72px; object-fit: cover; border-radius: 10px; border: 2px solid rgba(255,255,255,0.8); cursor: zoom-in; transition: all .2s ease; box-shadow: 0 4px 10px rgba(40,60,100,0.15); }
  .evid img.thumb:hover { transform: scale(1.05); border-color: #6366f1; }
  .evid a.ext { font-size: 13px; color: #4f46e5; text-decoration: none; background: rgba(238,242,255,0.7); border: 1px solid rgba(99,102,241,0.25); border-radius: 10px; padding: 8px 14px; align-self: center; }
  .count-line { font-size: 13px; color: #6b7280; margin: 14px 4px 10px; }
  .empty { text-align: center; color: #9ca3af; padding: 60px 0; font-size: 14px; }
  #lightbox { position: fixed; inset: 0; background: rgba(15,23,42,0.85); backdrop-filter: blur(8px); display: none; align-items: center; justify-content: center; z-index: 99; cursor: zoom-out; }
  #lightbox img { max-width: 92vw; max-height: 90vh; border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  @media (max-width: 720px) { header { padding: 20px; } .item { flex-direction: column; padding: 16px; } .badge { width: fit-content; } .filters { padding: 14px; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="glass-card">
    <div class="h-row">
      <div class="icon-box">🧪</div>
      <div>
        <h1>浏览器测试结果汇总</h1>
        <div class="meta">生成时间：<span id="genTime"></span> · 数据源：数据库 <code>public."TestResult"</code> · 证据图片见本目录 <code>evidence/</code></div>
      </div>
    </div>
  </header>

  <div class="cards" id="cards"></div>

  <div class="filters glass-section">
    <select id="fGroup" class="glass-input"><option value="">全部分组</option>${groupFilterOptions}</select>
    <select id="fResult" class="glass-input"><option value="">全部结果</option>${resultFilterOptions}</select>
    <select id="fUser" class="glass-input"><option value="">全部提交人</option></select>
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
  const items = allItems().filter(it =>
    (!fg || it.group === fg) &&
    (!fr || it.result === fr) &&
    (!fu || it.submitted_by === fu) &&
    (!kw || (it.case_id + ' ' + it.case_title + ' ' + it.detail).toLowerCase().includes(kw))
  );
  $('empty').style.display = items.length ? 'none' : 'block';
  $('list').innerHTML = items.map(it => {
    const b = LABELS[it.result] || { label: it.result, emoji: '?', color: '#9ca3af' };
    const evid = (it.evidence_list || []).map(e => {
      if (e.type === 'local') return '<img class="thumb" src="' + esc(e.relPath) + '" alt="' + esc(it.case_title) + '" onclick="openLb(this.src)">';
      return '<a class="ext" href="' + esc(e.url) + '" target="_blank" rel="noopener">🔗 证据链接</a>';
    }).join('');
    const GRAD = { passed: 'linear-gradient(135deg,#34d399,#10b981)', failed: 'linear-gradient(135deg,#fb7185,#e11d48)', skipped: 'linear-gradient(135deg,#fbbf24,#d97706)', pending: 'linear-gradient(135deg,#cbd5e1,#94a3b8)' };
    return '<div class="item glass-section">' +
      '<div class="badge" style="background:' + (GRAD[it.result] || '#9ca3af') + '">' + b.emoji + ' ' + b.label + '</div>' +
      '<div class="body"><div class="id">' + esc(it.case_id) + '</div>' +
      '<div class="title">' + esc(it.case_title) + '</div>' +
      '<div class="meta">👤 提交人：' + esc(it.submitted_by || '—') + ' · 🕐 更新：' + fmt(it.updated_at) + '</div>' +
      (it.detail ? '<div class="detail">' + esc(it.detail) + '</div>' : '') +
      (evid ? '<div class="evid">' + evid + '</div>' : '') +
      '</div></div>';
  }).join('');
  const done = items.filter(it => it.result !== 'pending').length;
  $('countLine').textContent = '共 ' + items.length + ' 项（已测 ' + done + '）';
}

function openLb(src) { $('lbImg').src = src; $('lightbox').style.display = 'flex'; }
$('lightbox').addEventListener('click', () => $('lightbox').style.display = 'none');
['fGroup','fResult','fUser'].forEach(id => $(id).addEventListener('change', renderList));
$('fKeyword').addEventListener('input', renderList);

$('genTime').textContent = fmt(SNAPSHOT.generated_at);
renderCards();
renderList();
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
  const evOutDir = path.join(outDir, 'evidence')
  fs.rmSync(evOutDir, { recursive: true, force: true })
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
