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

/** 从 evidence 文本中解析出证据条目列表（支持本地上传 URL 与外链） */
function parseEvidenceList(evidence) {
  if (!evidence) return []
  const tokens = String(evidence)
    .split(/[\n\r,;，；]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  const list = []
  for (const t of tokens) {
    // 本地上传：/api/test-results/evidence/<encCaseId>/<file>
    const m = t.match(/^\/api\/test-results\/evidence\/([^/]+)\/([^/?#]+)$/)
    if (m) {
      const encCaseId = m[1]
      const file = decodeURIComponent(m[2])
      const decCaseId = decodeURIComponent(encCaseId)
      const def = CASE_INDEX.get(decCaseId)
      list.push({
        raw: t,
        type: 'local',
        encCaseId,
        decCaseId,
        file,
        caseTitle: def ? def.title : decCaseId,
        relPath: `evidence/${encCaseId}/${encodeURIComponent(file)}`, // 相对 docs/test-results/latest/
      })
    } else if (/^https?:\/\//i.test(t)) {
      list.push({ raw: t, type: 'url', url: t })
    }
  }
  return list
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
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #f3f4f6; color: #1f2937; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; }
  header h1 { font-size: 22px; }
  header .meta { color: #6b7280; font-size: 12px; margin-top: 6px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin: 18px 0; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; }
  .card .gname { font-size: 13px; font-weight: 600; color: #374151; }
  .card .num { font-size: 26px; font-weight: 700; margin: 6px 0 4px; }
  .card .sub { font-size: 12px; color: #6b7280; }
  .card .chips { margin-top: 8px; font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0; }
  .filters select, .filters input { border: 1px solid #d1d5db; border-radius: 8px; padding: 7px 10px; font-size: 13px; background: #fff; }
  .filters input { flex: 1; min-width: 200px; }
  .item { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; display: flex; gap: 12px; }
  .badge { flex-shrink: 0; width: 56px; text-align: center; border-radius: 6px; color: #fff; font-size: 12px; padding: 4px 0; height: fit-content; }
  .item .body { flex: 1; min-width: 0; }
  .item .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 700; }
  .item .title { font-size: 13px; color: #374151; margin-top: 2px; }
  .item .meta { font-size: 11px; color: #9ca3af; margin-top: 4px; }
  .item .detail { font-size: 12px; color: #b45309; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 6px 8px; margin-top: 8px; white-space: pre-wrap; }
  .evid { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .evid img.thumb { width: 92px; height: 68px; object-fit: cover; border-radius: 6px; border: 1px solid #e5e7eb; cursor: zoom-in; }
  .evid a.ext { font-size: 12px; color: #2563eb; text-decoration: none; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 6px; padding: 6px 10px; }
  .count-line { font-size: 12px; color: #6b7280; margin: 8px 0; }
  .empty { text-align: center; color: #9ca3af; padding: 40px 0; }
  #lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.82); display: none; align-items: center; justify-content: center; z-index: 99; cursor: zoom-out; }
  #lightbox img { max-width: 92vw; max-height: 90vh; border-radius: 6px; }
  @media (max-width: 640px) { .item { flex-direction: column; } .badge { width: fit-content; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🧪 浏览器测试结果汇总</h1>
    <div class="meta">生成时间：<span id="genTime"></span> · 数据源：数据库 <code>public."TestResult"</code> · 证据图片见本目录 <code>evidence/</code></div>
  </header>

  <div class="cards" id="cards"></div>

  <div class="filters">
    <select id="fGroup"><option value="">全部分组</option>${groupFilterOptions}</select>
    <select id="fResult"><option value="">全部结果</option>${resultFilterOptions}</select>
    <select id="fUser"><option value="">全部提交人</option></select>
    <input id="fKeyword" type="search" placeholder="搜索用例编号 / 标题 / 实际表现…">
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
    const chips = ['passed','failed','skipped','pending'].map(k =>
      '<span style="color:' + LABELS[k].color + '">' + LABELS[k].emoji + ' ' + LABELS[k].label + ' ' + g.counts[k] + '</span>'
    ).join('');
    return '<div class="card"><div class="gname">' + esc(g.groupName) + '</div>' +
      '<div class="num">' + g.done + '<span style="font-size:13px;color:#9ca3af">/' + g.total + ' 已测</span></div>' +
      '<div class="sub">完成度 ' + pct + '%</div><div class="chips">' + chips + '</div></div>';
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
    return '<div class="item">' +
      '<div class="badge" style="background:' + b.color + '">' + b.emoji + ' ' + b.label + '</div>' +
      '<div class="body"><div class="id">' + esc(it.case_id) + '</div>' +
      '<div class="title">' + esc(it.case_title) + '</div>' +
      '<div class="meta">提交人：' + esc(it.submitted_by || '—') + ' · 更新：' + fmt(it.updated_at) + '</div>' +
      (it.detail ? '<div class="detail">📝 ' + esc(it.detail) + '</div>' : '') +
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
        // 上传时目录名 = encodeURIComponent(case_id)（见 testResultRoutes.js /upload），源用 encCaseId
        const src = path.join(evidenceDir, ev.encCaseId, ev.file)
        if (!fs.existsSync(src)) continue
        const dstDir = path.join(evOutDir, ev.encCaseId)
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
