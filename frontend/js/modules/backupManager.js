/**
 * 运维备份管理模块（P1）
 * ------------------------------------------------------------
 * 学校管理控制台「运维备份」Tab 的专用逻辑（仅平台超管可见）。
 * 后端：/api/admin/backups（列表 / run / download / verify / restore，全部 super_admin）。
 * 能力：
 *   - 备份列表（分页，含校验状态）
 *   - 手动触发备份（全库 / 单校）
 *   - 离线验证（verify）、下载（encrypted / plain，明文需服务端放行）
 *   - 影子恢复（恢复模态：目标学校 + 输入 RESTORE 确认）
 * 由 admin-schools.html 的 inline module 通过 initBackupManager({ API_BASE, authHeaders, notify }) 初始化，
 * 返回 { load(), hasUnsaved() } 供宿主 switchTab 调度。
 */

function escapeHtml(s) {
  if (s == null) return ''
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function fmtBytes(n) {
  if (n == null) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function fmtTime(s) {
  if (!s) return '-'
  const d = new Date(s)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function initBackupManager({ API_BASE, authHeaders, notify }) {
  let currentPage = 1
  const PAGE_SIZE = 15
  let schoolOptions = [] // 学校列表（单校备份 / 恢复目标）
  let restoreTarget = null // 当前选中待恢复的备份记录

  const api = (path, opts = {}) => {
    const headers = authHeaders()
    return fetch(`${API_BASE}/api/admin/backups${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
        return j
      })
  }

  function btn(icon, text, cls = '', attrs = '') {
    return `<button type="button" class="px-2 py-1 text-xs rounded border ${cls}" ${attrs}>${icon ? `<i class="fas ${icon} mr-1"></i>` : ''}${text}</button>`
  }

  function verifyBadge(r) {
    if (r.verifyStatus === 'passed') return '<span class="text-green-600 text-xs"><i class="fas fa-check-circle mr-1"></i>已验证</span>'
    if (r.verifyStatus === 'failed') return '<span class="text-red-600 text-xs"><i class="fas fa-times-circle mr-1"></i>验证失败</span>'
    return '<span class="text-gray-400 text-xs">未验证</span>'
  }

  function renderRows(items) {
    const tbody = document.getElementById('bm_tableBody')
    if (!tbody) return
    tbody.innerHTML = items.length ? items.map((r) => `
      <tr class="border-b border-gray-100 hover:bg-gray-50">
        <td class="px-3 py-2 text-xs text-gray-700">${fmtTime(r.createdAt)}</td>
        <td class="px-3 py-2 text-xs">
          ${r.scope === 'all' ? '<span class="text-blue-600">全库</span>' : `<span class="text-indigo-600">单校</span>`}
        </td>
        <td class="px-3 py-2 text-xs">${escapeHtml(r.schoolCode || '—')}</td>
        <td class="px-3 py-2 text-xs">${fmtBytes(r.fileSize)}</td>
        <td class="px-3 py-2 text-xs">${verifyBadge(r)}</td>
        <td class="px-3 py-2 text-xs whitespace-nowrap">
          ${btn('fa-check', '验证', 'border-gray-300 text-gray-600 hover:bg-gray-100', `data-act="verify" data-id="${r.id}"`)}
          ${btn('fa-download', '下载', 'border-gray-300 text-gray-600 hover:bg-gray-100', `data-act="download" data-id="${r.id}"`)}
          ${r.scope === 'single' ? btn('fa-undo', '恢复', 'border-red-300 text-red-600 hover:bg-red-50', `data-act="restore" data-id="${r.id}"`) : ''}
        </td>
      </tr>
    `).join('') : '<tr><td colspan="6" class="px-3 py-8 text-center text-gray-400 text-sm">暂无备份记录，点击「立即备份」生成</td></tr>'
  }

  function renderPager(total) {
    const el = document.getElementById('bm_pager')
    if (!el) return
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    el.innerHTML = `
      <button type="button" class="px-2 py-1 text-xs border rounded disabled:opacity-40 ${currentPage <= 1 ? 'disabled' : ''}" data-pg="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="px-2 text-xs text-gray-500">第 ${currentPage} / ${pages} 页</span>
      <button type="button" class="px-2 py-1 text-xs border rounded disabled:opacity-40 ${currentPage >= pages ? 'disabled' : ''}" data-pg="${currentPage + 1}" ${currentPage >= pages ? 'disabled' : ''}>下一页</button>
    `
  }

  async function loadBackups(page = 1) {
    currentPage = page
    try {
      const j = await api(`/?page=${page}&pageSize=${PAGE_SIZE}`)
      renderRows(j.data || [])
      renderPager(j.total || 0)
      console.log('[backupManager] 已加载备份', (j.data||[]).length, '/', j.total || 0)
    } catch (e) {
      console.error('[backupManager] 加载备份列表失败:', e)
      notify(`加载备份列表失败：${e.message}`)
      // 即使失败也显示空表格
      renderRows([])
      renderPager(0)
    }
  }

  async function loadSchools() {
    try {
      const r = await fetch(`${API_BASE}/api/admin/schools`, { headers: authHeaders() })
      const text = await r.text()
      let j = null
      try { j = text ? JSON.parse(text) : null } catch (e) { /* ignore */ }
      if (!r.ok) {
        const msg = (j && j.error) || `HTTP ${r.status}`
        console.error('[backupManager] /api/admin/schools 失败:', r.status, text)
        notify(`加载学校列表失败：${msg}`)
        schoolOptions = []
        return
      }
      schoolOptions = (j && j.data) || []
      console.log('[backupManager] 已加载学校', schoolOptions.length, '所')
      // 重新渲染已有下拉（bindRun 注入）
      const sel = document.getElementById('bm_schoolSelect')
      if (sel) {
        sel.innerHTML = '<option value="">— 选择学校 —</option>' +
          schoolOptions.map((s) => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name || s.code)}</option>`).join('')
      }
    } catch (e) {
      console.error('[backupManager] loadSchools 异常:', e)
      notify(`加载学校列表异常：${e.message}`)
      schoolOptions = []
    }
  }

  function schoolSelectHtml(selectId, selected) {
    return `<select id="${selectId}" class="text-xs border rounded px-2 py-1.5 bg-white">
      <option value="">— 选择学校 —</option>
      ${schoolOptions.map((s) => `<option value="${escapeHtml(s.code)}" ${selected === s.code ? 'selected' : ''}>${escapeHtml(s.name || s.code)}</option>`).join('')}
    </select>`
  }

  // ── 触发备份 ──
  function bindRun() {
    const btnAll = document.getElementById('bm_runAll')
    const btnSingle = document.getElementById('bm_runSingle')
    const sel = document.getElementById('bm_schoolSelect')
    if (btnAll) btnAll.addEventListener('click', () => doRun('all', null))
    if (btnSingle) btnSingle.addEventListener('click', () => doRun('single', sel?.value))
  }

  async function doRun(scope, schoolCode) {
    if (scope === 'single' && !schoolCode) { notify('请选择要备份的学校'); return }
    const c = confirm(scope === 'all' ? '确认触发全库备份？（所有学校 + 系统表）' : `确认备份学校 ${schoolCode}？`)
    if (!c) return
    try {
      const j = await api('/run', { method: 'POST', body: JSON.stringify({ scope, schoolCode }) })
      notify(`备份完成：${j.data?.file || ''}`)
      loadBackups(1)
    } catch (e) {
      notify(`备份失败：${e.message}`)
    }
  }

  // ── 验证 / 下载 ──
  async function doVerify(id) {
    try {
      const j = await api(`/${id}/verify`, { method: 'POST' })
      if (j.success) {
        const lines = (j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n')
        alert(`验证通过 ✅\n\n${lines}`)
      } else {
        alert(`验证失败 ❌\n\n${(j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || j.error}`)
      }
      loadBackups(currentPage)
    } catch (e) { notify(`验证失败：${e.message}`) }
  }

  async function doDownload(id, format) {
    const url = `${API_BASE}/api/admin/backups/${id}/download?format=${format}`
    try {
      // 需带 Authorization 的下载：fetch → blob（避免 <a download> 不带 token）
      const r = await fetch(url, { headers: authHeaders() })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${r.status}`)
      }
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `backup-${id}.${format === 'encrypted' ? 'aes' : 'sql.gz'}`
      a.click()
      URL.revokeObjectURL(a.href)

      // ★P-Recovery-Audit v1：加密下载时同步拉取配套 meta.json（指纹文件），
      //   本地上传恢复要求 .aes 与 .meta.json 同时上传并做 sha256 完整性校验。
      if (format === 'encrypted') {
        try {
          const metaUrl = `${API_BASE}/api/admin/backups/${id}/meta`
          const mr = await fetch(metaUrl, { headers: authHeaders() })
          if (!mr.ok) throw new Error(`HTTP ${mr.status}`)
          const mBlob = await mr.blob()
          const ma = document.createElement('a')
          ma.href = URL.createObjectURL(mBlob)
          ma.download = `backup-${id}.meta.json`
          ma.click()
          URL.revokeObjectURL(ma.href)
          notify('已下载加密备份及配套 meta.json，恢复时请同时上传这两个文件')
        } catch (e) {
          notify(`meta.json 下载失败：${e.message}；本地上传恢复将缺少完整性校验文件`)
        }
      }
    } catch (e) {
      notify(`下载失败：${e.message}`)
    }
  }

  // ── 影子恢复模态 ──
  function openRestoreModal(item) {
    restoreTarget = item
    const modal = document.getElementById('bm_restoreModal')
    if (!modal) return
    modal.classList.remove('hidden')
    const body = document.getElementById('bm_restoreBody')
    body.innerHTML = `
      <div class="text-sm text-gray-700 space-y-2">
        <p>备份：<b>${escapeHtml(item.schemaName || item.schoolCode)}</b>（${fmtTime(item.createdAt)}）</p>
        <p>将执行<b class="text-red-600">影子恢复</b>：先还原到临时 schema 并校验行数，通过后原子切换（原 schema 保留为备份）。</p>
        <div class="flex items-center gap-2">
          <label class="text-xs text-gray-500">目标学校</label>
          ${schoolSelectHtml('bm_restoreTarget', item.schoolCode)}
        </div>
        <div class="flex items-center gap-2">
          <label class="text-xs text-gray-500">确认词</label>
          <input id="bm_restoreConfirm" type="text" placeholder="输入 RESTORE" autocomplete="off" class="border rounded px-2 py-1.5 text-sm flex-1" />
        </div>
        <p id="bm_restoreHint" class="text-xs text-gray-400 pl-1" data-state="empty">需输入 <code class="font-mono text-red-600">RESTORE</code>（区分大小写、首尾不能有空格）才能执行</p>
      </div>
    `
  }

  function bindRestoreModal() {
    const close = document.getElementById('bm_restoreClose')
    const exec = document.getElementById('bm_restoreExec')
    if (close) close.addEventListener('click', () => document.getElementById('bm_restoreModal')?.classList.add('hidden'))

    // ── 实时校验输入框：在用户输入瞬间给出合法性反馈，避免点完按钮才发现不对 ──
    const refreshHint = () => {
      const hint = document.getElementById('bm_restoreHint')
      const input = document.getElementById('bm_restoreConfirm')
      if (!hint || !input) return
      const v = input.value
      if (!v) {
        hint.textContent = '需输入 RESTORE（区分大小写、首尾不能有空格）才能执行'
        hint.className = 'text-xs text-gray-400 pl-1'
        hint.dataset.state = 'empty'
        return
      }
      // 严格校验：拒绝空格绕过、区分大小写、长度必须完全一致
      if (v !== 'RESTORE') {
        let reason = ''
        if (v.trim() !== v) reason = '（首尾有空格）'
        else if (v.trim().toUpperCase() === 'RESTORE' && v !== 'RESTORE') reason = '（需全大写）'
        else if (v.length !== 7) reason = `（长度错误，应为 7 字符，当前 ${v.length}）`
        hint.innerHTML = `✗ 确认词错误${reason}，正确值为 <code class="font-mono text-red-600">RESTORE</code>`
        hint.className = 'text-xs text-red-600 pl-1 font-medium'
        hint.dataset.state = 'invalid'
        return
      }
      hint.innerHTML = '✓ 确认词正确'
      hint.className = 'text-xs text-green-600 pl-1 font-medium'
      hint.dataset.state = 'valid'
    }
    // 模态每次重新打开时（openRestoreModal 重写 body）才拿到新 input，需事件委托到 modal 容器
    const modalEl = document.getElementById('bm_restoreModal')
    if (modalEl) modalEl.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'bm_restoreConfirm') refreshHint()
    })

    if (exec) exec.addEventListener('click', async () => {
      if (!restoreTarget) return
      const target = document.getElementById('bm_restoreTarget')?.value
      const confirmText = document.getElementById('bm_restoreConfirm')?.value
      if (!target) { notify('请选择目标学校'); return }
      // 加严校验：拒绝空值、首尾空格绕过；区分大小写严格 === 'RESTORE'
      if (confirmText !== 'RESTORE') {
        let detail = '确认词必须为 RESTORE'
        if (!confirmText || !confirmText.trim()) detail = '确认词不能为空'
        else if (confirmText.trim() !== confirmText) detail = '确认词首尾不能有空格'
        else if (confirmText.trim().toUpperCase() === 'RESTORE') detail = '确认词必须为大写 RESTORE（区分大小写）'
        // 强反馈：alert 是模态中心强提示，notify 是页面顶部提示，双保险
        alert(`❌ ${detail}\n\n当前输入：「${confirmText}」`)
        notify(`确认词错误：${detail}`, 'error')
        refreshHint() // 同步把输入框旁的 hint 切到错误样式
        return
      }
      if (!confirm('警告：恢复将用备份数据替换目标学校的当前数据（原数据保留为 school_<code>_old_<ts>）。确认继续？')) return
      exec.disabled = true
      exec.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>恢复中…'
      try {
        const j = await api(`/${restoreTarget.id}/restore`, { method: 'POST', body: JSON.stringify({ targetSchoolCode: target, confirmText: 'RESTORE' }) })
        if (j.success) {
          alert('恢复完成 ✅\n\n' + (j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n'))
          document.getElementById('bm_restoreModal')?.classList.add('hidden')
          loadBackups(currentPage)
        } else {
          alert(`恢复失败 ❌\n\n${(j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || j.error}`)
        }
      } catch (e) { notify(`恢复失败：${e.message}`) }
      exec.disabled = false
      exec.innerHTML = '<i class="fas fa-undo mr-1"></i>执行恢复'
    })
  }

  // ── 表格事件委托 ──
  function bindTable() {
    const tbody = document.getElementById('bm_tableBody')
    if (!tbody) return
    tbody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]')
      if (!btn) return
      const { act, id } = btn.dataset
      if (act === 'verify') doVerify(id)
      else if (act === 'download') {
        const fmt = confirm('下载加密文件（.aes，需与 meta.json 配对保管）？\n确定则下载密文 .aes；取消则尝试明文下载（默认会被服务端以 403 拒绝）')
        if (!fmt) {
          // 用户主动取消：立即给可见提示，避免「点了取消却没反应」的体感问题；
          // 仍发起明文请求以保留「明文下载默认禁止」的 403 校验路径。
          notify('已选择取消 → 将尝试明文下载（默认会被服务端 403 拒绝，公网 HTTP 下属预期行为）', 'info')
        }
        doDownload(id, fmt ? 'encrypted' : 'plain')
      } else if (act === 'restore') {
        // 从当前行数据找记录（简化：调列表接口取该条）
        api(`/?pageSize=100`).then((j) => {
          const item = (j.data || []).find((r) => r.id === id)
          if (item) openRestoreModal(item)
        }).catch((e) => notify(e.message))
      }
    })
    const pager = document.getElementById('bm_pager')
    if (pager) pager.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-pg]')
      if (b && !b.disabled) loadBackups(Number(b.dataset.pg))
    })
  }

  /** 进入 Tab 时加载。 */
  function load() {
    // 诊断入口：每次进入 tab 都打印 token 来源 & 当前 API_BASE，便于排错
    try {
      const t = authHeaders().Authorization || '(no token)'
      console.log('[backupManager] load() 被调用 | API_BASE=', API_BASE, '| Authorization=', t.slice(0, 32) + '...')
    } catch (e) {
      console.warn('[backupManager] 无法打印诊断信息:', e.message)
    }
    if (!schoolOptions.length) loadSchools() // 不再 else，否则修复失败后无法再拉
    loadBackups(1)
  }

  function hasUnsaved() { return false }

  // 宿主页渲染面板骨架（Tab 面板 id=tab-backup）后调用一次绑定
  const root = document.getElementById('tab-backup')
  if (root) {
    root.innerHTML = `
      <div class="space-y-4">
        <div class="bg-white rounded-lg border border-gray-200 p-4">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 class="text-sm font-semibold text-gray-800"><i class="fas fa-database mr-1 text-blue-600"></i>数据备份</h3>
              <p class="text-xs text-gray-400 mt-0.5">每日 02:00 全库定时备份（systemd timer）+ 手动触发；备份经 AES-256-GCM 信封加密落系统盘</p>
            </div>
            <div class="flex items-center gap-2">
              ${schoolSelectHtml('bm_schoolSelect')}
              <button type="button" id="bm_runSingle" class="px-3 py-1.5 text-xs rounded bg-white border border-indigo-300 text-indigo-600 hover:bg-indigo-50"><i class="fas fa-plus mr-1"></i>单校备份</button>
              <button type="button" id="bm_runAll" class="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700"><i class="fas fa-hdd mr-1"></i>立即备份全部</button>
            </div>
          </div>
        </div>
        <div class="bg-white rounded-lg border border-gray-200">
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead><tr class="bg-gray-50 text-left text-xs text-gray-500">
                <th class="px-3 py-2">时间</th><th class="px-3 py-2">类型</th><th class="px-3 py-2">学校</th>
                <th class="px-3 py-2">大小</th><th class="px-3 py-2">校验</th><th class="px-3 py-2">操作</th>
              </tr></thead>
              <tbody id="bm_tableBody"></tbody>
            </table>
          </div>
          <div id="bm_pager" class="flex items-center justify-end gap-2 px-3 py-2 border-t border-gray-100"></div>
        </div>
      </div>
      <div id="bm_restoreModal" class="hidden fixed inset-0 bg-black/40 flex items-center justify-center z-50" style="z-index:999">
        <div class="bg-white rounded-lg shadow-xl w-full max-w-md p-5">
          <div class="flex items-center justify-between mb-3">
            <h4 class="text-sm font-semibold text-gray-800"><i class="fas fa-undo mr-1 text-red-500"></i>影子恢复</h4>
            <button type="button" id="bm_restoreClose" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
          </div>
          <div id="bm_restoreBody"></div>
          <div class="flex justify-end gap-2 mt-4">
            <button type="button" id="bm_restoreClose2" class="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-600">取消</button>
            <button type="button" id="bm_restoreExec" class="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700"><i class="fas fa-undo mr-1"></i>执行恢复</button>
          </div>
        </div>
      </div>
    `
    bindRun()
    bindTable()
    bindRestoreModal()
    const close2 = document.getElementById('bm_restoreClose2')
    if (close2) close2.addEventListener('click', () => document.getElementById('bm_restoreModal')?.classList.add('hidden'))
  }

  return { load, hasUnsaved }
}
