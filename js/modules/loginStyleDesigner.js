/**
 * 登录页样式设计器（独立模块）
 * ------------------------------------------------------------
 * 学校管理控制台「登录样式」Tab 的专用逻辑。与「界面定制」完全解耦，单独加载 / 单独保存。
 * 数据落点：SchoolCustomization.theme_config.login（JSON 对象），复用现有 theme_config 列，
 * 无需新增数据库迁移。结构：
 *   theme_config.login = {
 *     background: { type: 'aurora'|'solid'|'image', color, imageUrl, opacity },
 *     card:       { align: 'left'|'center'|'right', width, radius, shadow, blur, top },
 *     branding:   { showLogo: bool, title, subtitle, logoUrl }
 *   }
 *
 * 编辑方式（DS-LOGIN-GRAPHIC）：
 *   - 表单式（默认）：左侧控件（背景/卡片/品牌）精确设置，右侧实时预览。
 *   - 图形化（新增）：开启「图形化编辑」后，可直接在预览上拖拽卡片调整位置（水平→对齐、
 *     垂直→上下偏移）、拖动右缘手柄调整宽度、点击标题/标语就地编辑文字，所见即所得。
 *     两种方式共享同一份 config，可混用，均点「保存登录样式」对该校生效。
 *
 * 依赖：window.SchoolThemes（themePresets.js，已在 admin-schools.html 引入）。
 * 由 admin-schools.html 的 inline module 通过 initLoginStyleDesigner({ API_BASE, authHeaders, notify }) 初始化，
 * 返回 { load(code), hasUnsaved(), setGraphical(on) } 供宿主页调度。
 */

import { escapeHtml } from '../utils/schoolCustomization/shared.js'

function defaultLoginStyle() {
  return {
    background: { type: 'aurora' },
    card: { align: 'center', width: 420, radius: 18, shadow: true, blur: true, top: 0 },
    branding: { showLogo: true, title: '', subtitle: '', logoUrl: '', footer: '' },
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)) }

// 文件 → dataURL（按 maxDim 等比缩小，避免超大 payload）
function fileToDataURL(file, maxDim = 1600) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith('image/')) return reject(new Error('仅支持图片'))
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let { width, height } = img
        if (width > maxDim || height > maxDim) {
          const scale = Math.min(maxDim / width, maxDim / height)
          width = Math.round(width * scale)
          height = Math.round(height * scale)
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.9))
      }
      img.onerror = () => reject(new Error('图片解析失败'))
      img.src = reader.result
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

export function initLoginStyleDesigner({ API_BASE, authHeaders, notify }) {
  let code = null
  let config = defaultLoginStyle()
  let dirty = false
  let graphical = false   // DS-LOGIN-GRAPHIC：图形化编辑模式开关
  // 预览所需的学校外观（来自公开端点）：name / shortName / logoUrl / themeColor / theme
  let schoolInfo = { name: '', shortName: '', logoUrl: '', themeColor: '#1a73e8', theme: null }
  let currentCustUpdatedAt = null

  const $ = (id) => document.getElementById(id)

  // ---------- 状态维护 ----------
  function markDirty() {
    dirty = true
    const hint = $('ls_dirtyHint')
    if (hint) hint.innerHTML = '● 有未保存的修改，点「保存登录样式」后对该校生效'
    const resetBtn = $('ls_resetBtn')
    if (resetBtn) resetBtn.classList.remove('hidden')
    const saveBtn = $('ls_saveBtn')
    if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-save mr-2"></i>保存登录样式 <span class="text-xs opacity-80">●</span>'
  }
  function resetDirty() {
    dirty = false
    const hint = $('ls_dirtyHint')
    if (hint) hint.innerHTML = '修改会实时反映到预览，点「保存登录样式」后对该校生效'
    const resetBtn = $('ls_resetBtn')
    if (resetBtn) resetBtn.classList.add('hidden')
    const saveBtn = $('ls_saveBtn')
    if (saveBtn) saveBtn.innerHTML = '<i class="fas fa-save mr-2"></i>保存登录样式'
  }

  // ---------- 控件高亮 ----------
  function highlightBgType() {
    document.querySelectorAll('#lsBgType .ls-bg-btn').forEach((b) => {
      const active = b.dataset.bgType === (config.background.type || 'aurora')
      b.classList.toggle('bg-indigo-50', active)
      b.classList.toggle('border-indigo-500', active)
      b.classList.toggle('text-indigo-700', active)
      b.classList.toggle('border-gray-300', !active)
    })
  }
  function highlightAlign() {
    document.querySelectorAll('#lsCardAlign .ls-align-btn').forEach((b) => {
      const active = b.dataset.align === (config.card.align || 'center')
      b.classList.toggle('bg-indigo-50', active)
      b.classList.toggle('border-indigo-500', active)
      b.classList.toggle('text-indigo-700', active)
      b.classList.toggle('border-gray-300', !active)
    })
  }

  // 更新左侧「登录页校徽」预览缩略图（读取 config 或学校默认校徽）
  function updateLogoPreview(src) {
    const wrap = $('ls_brand_logo_preview')
    if (!wrap) return
    wrap.textContent = ''
    if (src) {
      const img = document.createElement('img')
      img.src = src
      img.alt = '校徽'
      img.style.cssText = 'width:100%;height:100%;object-fit:contain'
      img.onerror = () => {
        wrap.textContent = ''
        wrap.innerHTML = '<i class="fas fa-shield-alt text-2xl text-gray-300"></i>'
      }
      wrap.appendChild(img)
    } else {
      wrap.innerHTML = '<i class="fas fa-shield-alt text-2xl text-gray-300"></i>'
    }
  }

  // ---------- 预览渲染 ----------
  function resolvedTheme() {
    const tc = schoolInfo.theme ? { theme_config: { theme: schoolInfo.theme } } : null
    return window.SchoolThemes.resolveTheme({ themeColor: schoolInfo.themeColor, customization: tc })
  }

  // 仅构建预览 DOM（不含左侧控件同步），便于拖拽时只重建一次后持续直接操作
  function buildPreview() {
    const preview = $('loginStylePreview')
    if (!preview) return

    // 背景层
    let bgStyle = ''
    let overlay = 0
    const bg = config.background || {}
    if (bg.type === 'solid') {
      bgStyle = `background:${bg.color || '#1a73e8'};`
    } else if (bg.type === 'image' && bg.imageUrl) {
      bgStyle = `background-image:url("${escapeHtml(bg.imageUrl)}");background-size:cover;background-position:center;`
      overlay = bg.opacity != null ? bg.opacity : 0.25
    } else {
      // aurora / default：用该校主题壁纸
      const theme = resolvedTheme()
      if (theme) bgStyle = `background:${window.SchoolThemes.swatchBackground(theme)};`
      else bgStyle = 'background:linear-gradient(135deg,#a9c8ff,#ffc2dd,#a9ecd9,#d9c6ff);'
    }

    // 卡片
    const card = config.card || {}
    const align = card.align || 'center'
    const width = card.width || 420
    const radius = card.radius != null ? card.radius : 18
    const shadow = card.shadow === false ? 'none' : '0 20px 60px rgba(0,0,0,0.18)'
    const blur = card.blur === false ? 'none' : 'blur(12px)'
    const cardBg = card.blur === false ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.82)'
    const top = card.top || 0

    // 品牌
    const bd = config.branding || {}
    const title = (bd.title && bd.title.trim()) || schoolInfo.name || '食品安全检验系统'
    const subtitle = (bd.subtitle && bd.subtitle.trim()) || schoolInfo.shortName || schoolInfo.name || '食品安全检验管理平台'
    // 登录页专属校徽：优先用登录样式里单独设置的 logoUrl，否则回退该校默认校徽
    const loginLogo = (bd.logoUrl && bd.logoUrl.trim()) || ''
    const logoSrc = loginLogo || schoolInfo.logoUrl
    const showLogo = bd.showLogo !== false && !!logoSrc
    const logoHtml = showLogo
      ? `<img src="${escapeHtml(logoSrc)}" alt="logo" style="width:56px;height:56px;object-fit:contain" onerror="this.style.display='none'">`
      : '<i class="fas fa-shield-alt text-4xl" style="color:var(--accent,#1a73e8)"></i>'
    const accent = (resolvedTheme() && resolvedTheme().accent) || schoolInfo.themeColor || '#1a73e8'
    // 页脚注释（系统版本号等）：未设置时使用默认文案（版本号取 appVersion.js 单一来源）
    const footer = (bd.footer && bd.footer.trim()) || ('系统版本 ' + (window.APP_VERSION || '3.1.0') + ' · © 2026')

    preview.innerHTML = `
      <div style="position:absolute;inset:0;${bgStyle}"></div>
      <div style="position:absolute;inset:0;background:rgba(0,0,0,${overlay});"></div>
      <div class="ls-stage" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:${align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center'};padding:24px;">
        <div class="ls-card" style="width:${width}px;max-width:calc(100% - 48px);background:${cardBg};border-radius:${radius}px;box-shadow:${shadow};backdrop-filter:${blur};-webkit-backdrop-filter:${blur};padding:32px;transform:translateY(${top}px);">
          <div class="text-center mb-6">
            <div class="mb-3" style="height:56px;display:flex;align-items:center;justify-content:center;">${logoHtml}</div>
            <h1 data-ls-edit="title" style="font-size:20px;font-weight:700;color:#1f2937;margin-bottom:4px;outline:none;">${escapeHtml(title)}</h1>
            <p data-ls-edit="subtitle" style="font-size:13px;color:#6b7280;outline:none;">${escapeHtml(subtitle)}</p>
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:13px;color:#374151;margin-bottom:6px;"><i class="fas fa-user mr-1" style="color:${accent}"></i>用户名</label>
            <div style="width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;color:#9ca3af;font-size:14px;background:#fff;">请输入用户名</div>
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:13px;color:#374151;margin-bottom:6px;"><i class="fas fa-lock mr-1" style="color:${accent}"></i>密码</label>
            <div style="width:100%;padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;color:#9ca3af;font-size:14px;background:#fff;">••••••••</div>
          </div>
          <button type="button" style="width:100%;margin-top:8px;padding:11px;border:none;border-radius:8px;color:#fff;font-weight:600;font-size:15px;background:linear-gradient(90deg,${accent},${window.SchoolThemes.shade(accent, -12)});cursor:default;">登 录</button>
          <p data-ls-edit="footer" style="text-align:center;margin-top:16px;font-size:11px;color:#9ca3af;outline:none;">${escapeHtml(footer)}</p>
        </div>
      </div>`

    // 图形化模式下给卡片挂上直接操作手柄（DS-LOGIN-GRAPHIC）
    if (graphical) enableGraphical()
  }

  // 同步左侧控件视觉状态（不影响预览 DOM，供拖拽过程中实时回写滑块/高亮）
  function syncControls() {
    const bg = config.background || {}
    const card = config.card || {}
    const bd = config.branding || {}
    highlightBgType()
    highlightAlign()
    const solidRow = $('lsSolidRow')
    const imageRow = $('lsImageRow')
    if (solidRow) solidRow.classList.toggle('hidden', bg.type !== 'solid')
    if (imageRow) imageRow.classList.toggle('hidden', bg.type !== 'image')
    if ($('ls_bg_color')) $('ls_bg_color').value = bg.color || '#1a73e8'
    if ($('ls_bg_color_picker')) $('ls_bg_color_picker').value = bg.color || '#1a73e8'
    if ($('ls_bg_image')) $('ls_bg_image').value = bg.imageUrl || ''
    if ($('ls_bg_opacity')) $('ls_bg_opacity').value = bg.opacity != null ? bg.opacity : 0.25
    if ($('lsOpacityVal')) $('lsOpacityVal').textContent = (bg.opacity != null ? bg.opacity : 0.25).toFixed(2)
    if ($('ls_card_width')) $('ls_card_width').value = card.width || 420
    if ($('lsWidthVal')) $('lsWidthVal').textContent = card.width || 420
    if ($('ls_card_radius')) $('ls_card_radius').value = card.radius != null ? card.radius : 18
    if ($('lsRadiusVal')) $('lsRadiusVal').textContent = card.radius != null ? card.radius : 18
    if ($('ls_card_shadow')) $('ls_card_shadow').checked = card.shadow !== false
    if ($('ls_card_blur')) $('ls_card_blur').checked = card.blur !== false
    if ($('ls_brand_logo')) $('ls_brand_logo').checked = bd.showLogo !== false
    if ($('ls_brand_logo_url')) $('ls_brand_logo_url').value = bd.logoUrl || ''
    updateLogoPreview((bd.logoUrl && bd.logoUrl.trim()) || schoolInfo.logoUrl)
    if ($('ls_brand_title')) $('ls_brand_title').value = bd.title || ''
    if ($('ls_brand_subtitle')) $('ls_brand_subtitle').value = bd.subtitle || ''
    if ($('ls_brand_footer')) {
      $('ls_brand_footer').value = bd.footer || ''
      // 页脚注释 placeholder 随系统版本号动态生成（与 appVersion.js 单一事实来源保持一致）
      $('ls_brand_footer').placeholder = '如 系统版本 ' + (window.APP_VERSION || '3.1.0') + ' · © 2026'
    }
  }

  function render() {
    const preview = $('loginStylePreview')
    if (!preview) return
    buildPreview()
    syncControls()
  }

  // ---------- 图形化编辑（DS-LOGIN-GRAPHIC）----------
  function setGraphical(on) {
    graphical = !!on
    const preview = $('loginStylePreview')
    if (preview) preview.classList.toggle('ls-graphical', graphical)
    render()
  }

  function enableGraphical() {
    const preview = $('loginStylePreview')
    const cardEl = preview && preview.querySelector('.ls-card')
    if (!cardEl) return

    // 拖拽卡片：水平决定对齐（左/中/右），垂直决定上下偏移 top
    cardEl.addEventListener('pointerdown', onCardPointerDown)

    // 右侧缩放手柄（调整卡片宽度）
    let handle = cardEl.querySelector('.ls-resize-handle')
    if (!handle) {
      handle = document.createElement('div')
      handle.className = 'ls-resize-handle'
      handle.title = '拖动调整卡片宽度'
      cardEl.appendChild(handle)
    }
    handle.addEventListener('pointerdown', onHandlePointerDown)

    // 标题 / 标语 / 页脚：点击就地编辑文字
    const titleEl = cardEl.querySelector('[data-ls-edit="title"]')
    const subEl = cardEl.querySelector('[data-ls-edit="subtitle"]')
    const footerEl = cardEl.querySelector('[data-ls-edit="footer"]')
    if (titleEl) titleEl.addEventListener('click', (e) => { e.stopPropagation(); beginInlineEdit(titleEl, 'title') })
    if (subEl) subEl.addEventListener('click', (e) => { e.stopPropagation(); beginInlineEdit(subEl, 'subtitle') })
    if (footerEl) footerEl.addEventListener('click', (e) => { e.stopPropagation(); beginInlineEdit(footerEl, 'footer') })
  }

  function onCardPointerDown(e) {
    // 缩放手柄 / 可编辑文字 / 登录按钮：不触发卡片拖拽
    if (e.target.closest('.ls-resize-handle')) return
    if (e.target.closest('[data-ls-edit]')) return
    if (e.target.tagName === 'BUTTON') return
    e.preventDefault()
    const cardEl = e.currentTarget
    const stage = cardEl.parentElement
    const stageRect = stage.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    const startTop = config.card.top || 0
    cardEl.setPointerCapture(e.pointerId)

    // 拖拽中：卡片跟随指针（translate），水平/垂直实时生效，松手后再吸附对齐
    const move = (ev) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      cardEl.style.transform = `translate(${dx}px, ${dy}px)`
    }
    const up = (ev) => {
      cardEl.removeEventListener('pointermove', move)
      cardEl.removeEventListener('pointerup', up)
      // 落点判定：依据松手时卡片中心在舞台中的占比吸附对齐
      const r = cardEl.getBoundingClientRect()
      const cx = r.left + r.width / 2 - stageRect.left
      const pct = cx / stageRect.width
      let align = 'center'
      if (pct < 0.38) align = 'left'
      else if (pct > 0.62) align = 'right'
      const dy = ev.clientY - startY
      config.card.align = align
      config.card.top = clamp(startTop + dy, -220, 220)
      render()        // 以新对齐/偏移重渲染（图形化模式保持，手柄与监听自动重建）
      markDirty()
    }
    cardEl.addEventListener('pointermove', move)
    cardEl.addEventListener('pointerup', up)
  }

  function onHandlePointerDown(e) {
    e.preventDefault(); e.stopPropagation()
    const cardEl = e.currentTarget.parentElement
    const startX = e.clientX
    const startW = config.card.width || 420
    cardEl.setPointerCapture(e.pointerId)

    const move = (ev) => {
      const w = clamp(Math.round(startW + (ev.clientX - startX)), 300, 640)
      config.card.width = w
      cardEl.style.width = w + 'px'
      syncControls()
      markDirty()
    }
    const up = () => {
      cardEl.removeEventListener('pointermove', move)
      cardEl.removeEventListener('pointerup', up)
    }
    cardEl.addEventListener('pointermove', move)
    cardEl.addEventListener('pointerup', up)
  }

  function beginInlineEdit(el, key) {
    el.setAttribute('contenteditable', 'true')
    el.classList.add('ls-editing')
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)

    const finish = () => {
      el.removeAttribute('contenteditable')
      el.classList.remove('ls-editing')
      const txt = el.textContent.trim()
      if (key === 'title') config.branding.title = txt
      else if (key === 'subtitle') config.branding.subtitle = txt
      else if (key === 'footer') config.branding.footer = txt
      syncControls()
      markDirty()
      el.removeEventListener('blur', finish)
      el.removeEventListener('keydown', onKey)
    }
    const onKey = (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); el.blur() }
      else if (ev.key === 'Escape') { ev.preventDefault(); el.blur() }
    }
    el.addEventListener('blur', finish)
    el.addEventListener('keydown', onKey)
  }

  // ---------- 加载 ----------
  async function load(schoolCode) {
    code = schoolCode
    if (!code) return
    resetDirty()
    try {
      // 1) 学校外观（公开端点，无需鉴权）：name/shortName/logoUrl/themeColor + 当前 theme_config
      const pub = await fetch(`/api/schools/${encodeURIComponent(code)}/config`)
      if (pub.ok) {
        const json = await pub.json()
        const d = (json && json.data) || {}
        schoolInfo = {
          name: d.name || '',
          shortName: d.shortName || '',
          logoUrl: d.logoUrl || '',
          themeColor: d.themeColor || '#1a73e8',
          theme: null,
        }
        const tc = d.customization && d.customization.theme_config
        if (tc) {
          try {
            const parsed = typeof tc === 'string' ? JSON.parse(tc) : tc
            schoolInfo.theme = parsed.theme || null
          } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* 外观加载失败不影响主流程 */ }

    try {
      // 2) 已保存的登录样式（超管端点）
      const resp = await fetch(`${API_BASE}/api/admin/schools/${encodeURIComponent(code)}/customization`, { headers: authHeaders() })
      if (resp.ok) {
        const json = await resp.json()
        const c = (json && json.data) || {}
        currentCustUpdatedAt = c.updated_at || null
        const saved = parseThemeConfig(c.theme_config)
        config = mergeLoginStyle(saved && saved.login)
      } else {
        config = defaultLoginStyle()
      }
    } catch (_) {
      config = defaultLoginStyle()
    }
    resetDirty()
    render()
  }

  function parseThemeConfig(tc) {
    if (!tc) return null
    try { return typeof tc === 'string' ? JSON.parse(tc) : tc } catch (_) { return null }
  }
  function mergeLoginStyle(login) {
    const def = defaultLoginStyle()
    if (!login || typeof login !== 'object') return def
    return {
      background: { ...def.background, ...(login.background || {}) },
      card: { ...def.card, ...(login.card || {}) },
      branding: { ...def.branding, ...(login.branding || {}) },
    }
  }

  // ---------- 保存 ----------
  async function save() {
    if (!code) return
    const btn = $('ls_saveBtn')
    const oldHtml = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...'
    try {
      // 读取当前完整 customization，将 login 合并进 theme_config 后整体回写（避免覆盖 theme/logo_style 等）
      const resp = await fetch(`${API_BASE}/api/admin/schools/${encodeURIComponent(code)}/customization`, { headers: authHeaders() })
      let curThemeConfig = {}
      let updatedAt = currentCustUpdatedAt
      if (resp.ok) {
        const json = await resp.json()
        const c = (json && json.data) || {}
        curThemeConfig = parseThemeConfig(c.theme_config) || {}
        updatedAt = c.updated_at || updatedAt
      }
      const merged = { ...curThemeConfig, login: config }
      const body = { theme_config: merged }
      if (updatedAt) body.expected_updated_at = updatedAt

      const put = await fetch(`${API_BASE}/api/admin/schools/${encodeURIComponent(code)}/customization`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
      if (put.status === 409) {
        if (notify) notify('保存失败：该校定制配置刚被其他人修改，请刷新后重试', 'error')
        return
      }
      const json = await put.json()
      if (!put.ok) throw new Error(json.error || '保存失败')
      if (json.updated_at) currentCustUpdatedAt = json.updated_at

      // 写入本地定制缓存，使该校师生端登录页立即读取到新样式（无需等 TTL/刷新）
      try {
        const cacheKey = 'school_customization_' + code
        let cached = null
        try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null') } catch (_) {}
        cached = cached || {}
        cached.theme_config = merged
        localStorage.setItem(cacheKey, JSON.stringify(cached))
      } catch (_) { /* 非关键路径 */ }

      resetDirty()
      if (notify) notify('✅ 登录样式已保存，该校师生访问登录页即可看到新界面', 'success')
    } catch (e) {
      if (notify) notify('❌ ' + (e.message || '保存失败'), 'error')
    } finally {
      btn.disabled = false
      btn.innerHTML = oldHtml
    }
  }

  function reset() {
    if (!code) return
    load(code)
    if (notify) notify('已放弃未保存的修改', 'info')
  }

  // ---------- 绑定静态控件 ----------
  function bind() {
    document.querySelectorAll('#lsBgType .ls-bg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        config.background.type = b.dataset.bgType
        render(); markDirty()
      })
    })
    document.querySelectorAll('#lsCardAlign .ls-align-btn').forEach((b) => {
      b.addEventListener('click', () => {
        config.card.align = b.dataset.align
        render(); markDirty()
      })
    })
    const colorInput = $('ls_bg_color')
    const colorPicker = $('ls_bg_color_picker')
    if (colorInput) colorInput.addEventListener('input', (e) => {
      config.background.color = e.target.value
      if (colorPicker) colorPicker.value = e.target.value
      render(); markDirty()
    })
    if (colorPicker) colorPicker.addEventListener('input', (e) => {
      config.background.color = e.target.value
      if (colorInput) colorInput.value = e.target.value
      render(); markDirty()
    })
    const imgInput = $('ls_bg_image')
    if (imgInput) imgInput.addEventListener('input', (e) => {
      config.background.imageUrl = e.target.value.trim()
      render(); markDirty()
    })
    const fileInput = $('ls_bg_file')
    if (fileInput) fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0]
      if (!file) return
      try {
        const url = await fileToDataURL(file)
        config.background.imageUrl = url
        config.background.type = 'image'
        render(); markDirty()
      } catch (err) {
        if (notify) notify('图片上传失败：' + err.message, 'error')
      }
    })
    const opacity = $('ls_bg_opacity')
    if (opacity) opacity.addEventListener('input', (e) => {
      config.background.opacity = parseFloat(e.target.value)
      if ($('lsOpacityVal')) $('lsOpacityVal').textContent = parseFloat(e.target.value).toFixed(2)
      render(); markDirty()
    })
    const width = $('ls_card_width')
    if (width) width.addEventListener('input', (e) => {
      config.card.width = parseInt(e.target.value, 10)
      if ($('lsWidthVal')) $('lsWidthVal').textContent = e.target.value
      render(); markDirty()
    })
    const radius = $('ls_card_radius')
    if (radius) radius.addEventListener('input', (e) => {
      config.card.radius = parseInt(e.target.value, 10)
      if ($('lsRadiusVal')) $('lsRadiusVal').textContent = e.target.value
      render(); markDirty()
    })
    const shadow = $('ls_card_shadow')
    if (shadow) shadow.addEventListener('change', (e) => {
      config.card.shadow = e.target.checked
      render(); markDirty()
    })
    const blur = $('ls_card_blur')
    if (blur) blur.addEventListener('change', (e) => {
      config.card.blur = e.target.checked
      render(); markDirty()
    })
    const showLogo = $('ls_brand_logo')
    if (showLogo) showLogo.addEventListener('change', (e) => {
      config.branding.showLogo = e.target.checked
      render(); markDirty()
    })
    // 登录页专属校徽：上传（转 data URI）/ 粘贴 URL / 还原默认
    const logoFile = $('ls_brand_logo_file')
    if (logoFile) logoFile.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0]
      if (!file) return
      try {
        const url = await fileToDataURL(file, 800)
        config.branding.logoUrl = url
        render(); markDirty()
      } catch (err) {
        if (notify) notify('校徽上传失败：' + err.message, 'error')
      } finally {
        e.target.value = ''
      }
    })
    const logoUrl = $('ls_brand_logo_url')
    if (logoUrl) logoUrl.addEventListener('input', (e) => {
      config.branding.logoUrl = e.target.value.trim()
      // 填入 logo 时默认勾选「显示校徽 Logo」
      if (config.branding.logoUrl && $('ls_brand_logo')) $('ls_brand_logo').checked = true
      render(); markDirty()
    })
    const logoReset = $('ls_brand_logo_reset')
    if (logoReset) logoReset.addEventListener('click', () => {
      config.branding.logoUrl = ''
      render(); markDirty()
    })
    const title = $('ls_brand_title')
    if (title) title.addEventListener('input', (e) => {
      config.branding.title = e.target.value
      render(); markDirty()
    })
    const subtitle = $('ls_brand_subtitle')
    if (subtitle) subtitle.addEventListener('input', (e) => {
      config.branding.subtitle = e.target.value
      render(); markDirty()
    })
    const footer = $('ls_brand_footer')
    if (footer) footer.addEventListener('input', (e) => {
      config.branding.footer = e.target.value
      render(); markDirty()
    })
    // 图形化编辑开关（DS-LOGIN-GRAPHIC）
    const gToggle = $('ls_graphicalToggle')
    if (gToggle) gToggle.addEventListener('change', (e) => {
      setGraphical(e.target.checked)
      const hint = $('ls_graphicalHint')
      if (hint) hint.style.display = e.target.checked ? 'flex' : 'none'
    })
    const saveBtn = $('ls_saveBtn')
    if (saveBtn) saveBtn.addEventListener('click', save)
    const resetBtn = $('ls_resetBtn')
    if (resetBtn) resetBtn.addEventListener('click', reset)
  }

  // 初始化时即绑定（DOM 静态存在，与 Tab 是否可见无关）
  bind()

  return {
    load,
    hasUnsaved: () => dirty,
    setGraphical,
  }
}
