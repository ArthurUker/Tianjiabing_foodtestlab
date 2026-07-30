/**
 * badgeEditor.js —— 校徽图形化排版编辑器
 *
 * 作用：管理端"校徽排版 / 裁切"编辑器。
 * 管理员上传校徽后，可在此：
 *   - 在「源图」上拖拽 / 拖角缩放一个裁切框（可锁定比例，如 1:1、3:4）
 *   - 实时预览校徽在顶部导航上的最终效果（背景水印层 或 小徽章）
 *   - 背景模式下：在预览舞台上拖动定位、滑块缩放与调不透明度
 *   - 保存后产出 logo_style（含裁切后的 data URL），供 branding.js 渲染
 *
 * 两种挂载形态（DS-BRAND-03）：
 *   - openBadgeEditor(opts)       ：弹出模态框（保留旧调用方兼容）
 *   - mountBadgeEditor(el, opts)  ：把同一套编辑器直接渲染进任意容器（如管理控制台
 *                                    "基本信息" 里的"顶部栏预览编辑模式"，内嵌、非弹窗）
 *
 * 该模块为纯 DOM / Canvas，不依赖 schoolCustomization 其它子模块，避免循环引用。
 * 安全：源图若为 data URL（管理端上传默认压缩为 jpeg data URL）可自由绘制；
 *       若为跨域远程 URL 且无 CORS 头，canvas 会被污染，此时降级为「不裁切、直接用原图」。
 */

const DEFAULTS = {
    display: 'background',   // 'background' | 'badge'
    posX: 88,                // 背景模式下在水印层的水平位置（%）
    posY: 50,                // 垂直位置（%）
    scale: 1.6,              // 背景模式缩放（相对导航高度的倍率）
    opacity: 0.16,           // 背景模式不透明度
    aspectLock: true,        // 裁切锁定比例
    badgeSize: 48,           // 徽章模式尺寸(px)
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)) }
function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d }

// ---------- 子区块 HTML（模态与内嵌共用，靠容器作用域避免 ID 冲突）----------
function stageHTML() {
    // 预览舞台镜像真实顶部导航：左=校徽品牌+校名，右=用户/角色/登出；整条满宽，
    // 背景水印模式下裁切框可在此全宽舞台上拖动定位，所见即师生端实际效果。
    return `
    <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px;">顶部导航预览（真实效果）</div>
    <div id="beStage" style="position:relative;height:60px;border-radius:12px;overflow:hidden;background:linear-gradient(135deg,rgba(30,41,59,.95),rgba(15,23,42,.97));box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);cursor:crosshair;">
      <div id="beBgLayer" style="position:absolute;inset:0;background-repeat:no-repeat;pointer-events:none;"></div>
      <div style="position:relative;z-index:1;height:100%;display:flex;align-items:center;justify-content:space-between;padding:0 18px;color:#fff;">
        <div style="display:flex;align-items:center;gap:12px;min-width:0;">
          <div id="beBadgeSlot"></div>
          <span id="beTitle" style="font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;opacity:.92;flex-shrink:0;">
          <span><i class="far fa-user mr-1"></i>管理员</span>
          <span style="font-size:11px;padding:1px 8px;background:rgba(255,255,255,.18);border-radius:999px;">学校管理员</span>
          <span style="padding:4px 10px;background:rgba(239,68,68,.85);border-radius:6px;"><i class="fas fa-sign-out-alt"></i></span>
        </div>
      </div>
    </div>`
}
function cropHTML() {
    return `
    <div>
      <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px;">1. 选择裁切区域</div>
      <div id="beSourceWrap" style="position:relative;display:inline-block;line-height:0;max-width:100%;border-radius:10px;overflow:hidden;background:#f3f4f6;">
        <img id="beSourceImg" alt="源图" style="display:block;max-width:100%;max-height:340px;">
        <div id="beCropBox" style="position:absolute;border:2px solid #2563eb;box-shadow:0 0 0 9999px rgba(0,0,0,.45);cursor:move;">
          <div class="be-h" data-dir="nw" style="position:absolute;left:-6px;top:-6px;width:12px;height:12px;background:#2563eb;border-radius:3px;cursor:nwse-resize;"></div>
          <div class="be-h" data-dir="ne" style="position:absolute;right:-6px;top:-6px;width:12px;height:12px;background:#2563eb;border-radius:3px;cursor:nesw-resize;"></div>
          <div class="be-h" data-dir="sw" style="position:absolute;left:-6px;bottom:-6px;width:12px;height:12px;background:#2563eb;border-radius:3px;cursor:nesw-resize;"></div>
          <div class="be-h" data-dir="se" style="position:absolute;right:-6px;bottom:-6px;width:12px;height:12px;background:#2563eb;border-radius:3px;cursor:nwse-resize;"></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap;">
        <label style="font-size:13px;color:#374151;display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" id="beAspectLock" ${''}> 锁定比例
        </label>
        <label style="font-size:13px;color:#374151;display:flex;align-items:center;gap:6px;">
          比例
          <select id="beRatio" style="border:1px solid #d1d5db;border-radius:6px;padding:2px 4px;">
            <option value="1">1:1 正方形</option>
            <option value="0.75">3:4 竖版</option>
            <option value="1.3333">4:3 横版</option>
            <option value="free">自由</option>
          </select>
        </label>
      </div>
      <div id="beWarn" style="display:none;margin-top:10px;font-size:12px;color:#b45309;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;"></div>
    </div>`
}
function controlsHTML() {
    return `
    <div>
      <div style="display:flex;gap:8px;">
        <button id="beModeBg" type="button" class="be-mode" style="flex:1;padding:8px;border-radius:8px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:13px;color:#374151;">背景水印</button>
        <button id="beModeBadge" type="button" class="be-mode" style="flex:1;padding:8px;border-radius:8px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:13px;color:#374151;">小徽章</button>
      </div>
      <div id="beBgCtrls" style="margin-top:14px;">
        <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">缩放（相对导航高度）</label>
        <input id="beScale" type="range" min="0.4" max="4" step="0.05" value="1.6" style="width:100%;">
        <label style="display:block;font-size:12px;color:#6b7280;margin-top:10px;margin-bottom:4px;">不透明度</label>
        <input id="beOpacity" type="range" min="0.05" max="0.6" step="0.01" value="0.16" style="width:100%;">
        <p style="font-size:11px;color:#9ca3af;margin-top:6px;">提示：在上方预览条上按住拖动可调整校徽位置。</p>
      </div>
      <div id="beBadgeCtrls" style="margin-top:14px;display:none;">
        <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px;">徽章尺寸 (px)</label>
        <input id="beBadgeSize" type="range" min="32" max="80" step="2" value="48" style="width:100%;">
      </div>
    </div>`
}
function actionsHTML(embedded) {
    if (embedded) {
        return `<div style="display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:16px;">
          <span id="beAppliedHint" style="font-size:12px;color:#16a34a;opacity:0;transition:opacity .2s;">✅ 已应用</span>
          <button id="beApply" type="button" style="border:none;background:#7c3aed;color:#fff;padding:8px 22px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;">应用排版</button>
        </div>`
    }
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-top:1px solid #eee;background:#fafafa;">
      <button id="beReset" type="button" style="border:1px solid #d1d5db;background:#fff;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;color:#374151;"><i class="fas fa-undo mr-1"></i>重置裁切</button>
      <div style="display:flex;gap:10px;">
        <button id="beCancel" type="button" style="border:1px solid #d1d5db;background:#fff;padding:8px 18px;border-radius:8px;cursor:pointer;font-size:14px;color:#374151;">取消</button>
        <button id="beSave" type="button" style="border:none;background:#7c3aed;color:#fff;padding:8px 22px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;">保存排版</button>
      </div>
    </div>`
}

function buildEditorInner(embedded) {
    if (embedded) {
        // 顶部栏预览独占整宽（"顶部栏单独的预览编辑模式"），下方再分两栏：源图裁切 | 控制
        return `
        ${stageHTML()}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px;">
          ${cropHTML()}
          ${controlsHTML()}
        </div>
        ${actionsHTML(true)}`
    }
    // 模态：左侧裁切、右侧预览+控制（原布局）
    return `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:20px;overflow:auto;">
      ${cropHTML()}
      <div>
        ${stageHTML()}
        ${controlsHTML()}
      </div>
    </div>
    ${actionsHTML(false)}`
}

/**
 * 把校徽编辑器渲染进指定容器（内嵌模式，非弹窗）。
 * @param {HTMLElement} container 挂载容器
 * @param {Object} opts
 * @param {string} opts.logoUrl        原图地址
 * @param {Object} [opts.logoStyle]     已有排版配置（回显）
 * @param {string} [opts.schoolName]    学校名（预览标题用）
 * @param {boolean} [opts.embedded]     是否为内嵌形态（影响布局与动作按钮）
 * @param {Function} [opts.onSave]      保存/应用回调，入参为新的 logoStyle 对象
 * @param {Function} [opts.onCollapse]  内嵌形态下"收起"回调
 * @returns {{destroy:Function, apply:Function, reset:Function, getState:Function}|null}
 */
export function mountBadgeEditor(container, opts) {
    if (!container || !opts || !opts.logoUrl) return null
    const embedded = !!opts.embedded
    const { logoUrl, logoStyle, schoolName = '示例学校', onSave, onCollapse } = opts
    const base = Object.assign({}, DEFAULTS, logoStyle || {})
    const state = {
        display: base.display === 'background' ? 'background' : 'badge',
        posX: num(base.posX, 88),
        posY: num(base.posY, 50),
        scale: num(base.scale, 1.6),
        opacity: num(base.opacity, 0.16),
        aspectLock: !!base.aspectLock,
        badgeSize: num(base.badgeSize, 48),
        crop: (base.crop && typeof base.crop === 'object')
            ? { x: num(base.crop.x, 0), y: num(base.crop.y, 0), w: num(base.crop.w, 100), h: num(base.crop.h, 100) }
            : { x: 0, y: 0, w: 100, h: 100 },
        croppedUrl: (typeof base.croppedUrl === 'string') ? base.croppedUrl : null,
        ratio: (base.crop && base.crop.w && base.crop.h) ? (base.crop.w / base.crop.h) : 1,
        tainted: false,
    }

    container.innerHTML = buildEditorInner(embedded)
    // 回显比例/锁定选项
    const aspectEl = container.querySelector('#beAspectLock')
    if (aspectEl) aspectEl.checked = state.aspectLock
    const ratioEl = container.querySelector('#beRatio')
    if (ratioEl) {
        const r = state.ratio
        ratioEl.value = Math.abs(r - 1) < 0.01 ? '1' : Math.abs(r - 0.75) < 0.01 ? '0.75' : Math.abs(r - 1.3333) < 0.01 ? '1.3333' : 'free'
    }

    const $ = (id) => container.querySelector('#' + id)
    const srcImg = $('beSourceImg')
    const cropBox = $('beCropBox')
    const stage = $('beStage')
    const bgLayer = $('beBgLayer')
    const badgeSlot = $('beBadgeSlot')
    const titleEl = $('beTitle')

    titleEl.textContent = `${schoolName}食品安全检验管理系统`

    // 预览舞台用学校真实主题色，所见更真实（DS-BRAND-03）
    applyThemeToStage()

    let dispW = 0, dispH = 0, natW = 0, natH = 0
    const isData = logoUrl.startsWith('data:')
    srcImg.crossOrigin = isData ? null : 'anonymous'
    srcImg.onload = () => {
        natW = srcImg.naturalWidth
        natH = srcImg.naturalHeight
        dispW = srcImg.clientWidth
        dispH = srcImg.clientHeight
        state.ratio = state.crop.w / state.crop.h || 1
        applyCropBox()
        bake()
    }
    srcImg.onerror = () => showWarn('校徽图片加载失败，请检查地址或改传本地图片。')
    srcImg.src = logoUrl

    function showWarn(msg) { const w = $('beWarn'); if (w) { w.textContent = msg; w.style.display = 'block' } }

    function applyThemeToStage() {
        const tc = (document.getElementById('bf_themeColor')?.value || '').trim()
        if (tc && /^#?[0-9a-fA-F]{3,8}$/.test(tc)) {
            const hex = tc.startsWith('#') ? tc : '#' + tc
            stage.style.background = `linear-gradient(135deg, ${hex}, ${shade(hex, -18)})`
        }
    }
    function shade(hex, amt) {
        const n = parseInt(hex.replace('#', ''), 16)
        let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt
        r = clamp(r, 0, 255); g = clamp(g, 0, 255); b = clamp(b, 0, 255)
        return `rgb(${r},${g},${b})`
    }

    function applyCropBox() {
        if (!dispW || !dispH) return
        cropBox.style.left = (state.crop.x / 100 * dispW) + 'px'
        cropBox.style.top = (state.crop.y / 100 * dispH) + 'px'
        cropBox.style.width = (state.crop.w / 100 * dispW) + 'px'
        cropBox.style.height = (state.crop.h / 100 * dispH) + 'px'
    }
    function readCropBox() {
        state.crop.x = clamp(parseFloat(cropBox.style.left) / dispW * 100, 0, 100)
        state.crop.y = clamp(parseFloat(cropBox.style.top) / dispH * 100, 0, 100)
        state.crop.w = clamp(parseFloat(cropBox.style.width) / dispW * 100, 2, 100)
        state.crop.h = clamp(parseFloat(cropBox.style.height) / dispH * 100, 2, 100)
    }

    function bake() {
        if (!natW || !natH) return
        const sx = state.crop.x / 100 * natW
        const sy = state.crop.y / 100 * natH
        const sw = state.crop.w / 100 * natW
        const sh = state.crop.h / 100 * natH
        const maxSide = 360
        const k = Math.min(1, maxSide / Math.max(sw, sh))
        const dw = Math.max(1, Math.round(sw * k))
        const dh = Math.max(1, Math.round(sh * k))
        const canvas = document.createElement('canvas')
        canvas.width = dw; canvas.height = dh
        try {
            canvas.getContext('2d').drawImage(srcImg, sx, sy, sw, sh, 0, 0, dw, dh)
            state.croppedUrl = canvas.toDataURL('image/jpeg', 0.85)
        } catch (e) {
            state.tainted = true
            state.croppedUrl = logoUrl
            showWarn('该图片为跨域地址且不允许读取像素，已自动跳过裁切，将直接使用原图。建议改为上传本地图片以获得裁切能力。')
        }
        renderPreview()
    }

    function renderPreview() {
        const url = state.croppedUrl || logoUrl
        const bg = state.display === 'background'
        bgLayer.style.display = bg ? 'block' : 'none'
        badgeSlot.style.display = bg ? 'none' : 'block'
        $('beBgCtrls').style.display = bg ? 'block' : 'none'
        $('beBadgeCtrls').style.display = bg ? 'none' : 'block'
        stage.style.cursor = bg ? 'grab' : 'default'

        if (bg) {
            bgLayer.style.backgroundImage = `url("${url}")`
            bgLayer.style.backgroundSize = `auto ${state.scale * 100}%`
            // 水印位置完全由用户拖动 / scale/opacity 控制，自由定位。
            // 注意：不再做"收敛到侧边"处理——既满足"随意拖动"需求，也与真实渲染
            // （branding.js 严格使用编辑器设定的 posX/posY）保持一致；低不透明度 + 校名投影已保证可读性。
            bgLayer.style.backgroundPosition = `${state.posX}% ${state.posY}%`
            bgLayer.style.opacity = String(state.opacity)
            // 背景水印模式下校名需投影以保证在水印之上的可读性（与 branding.js 一致）
            titleEl.style.textShadow = '0 1px 4px rgba(0,0,0,.45)'
        } else {
            titleEl.style.textShadow = 'none'
            const size = state.badgeSize
            badgeSlot.innerHTML = `<div style="width:${size}px;height:${size}px;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);flex-shrink:0;"><img src="${url}" style="width:100%;height:100%;object-fit:contain;padding:2px;"></div>`
        }
    }

    // 交互：移动裁切框
    cropBox.addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('be-h')) return
        e.preventDefault()
        cropBox.setPointerCapture(e.pointerId)
        const startX = e.clientX, startY = e.clientY
        const oLeft = parseFloat(cropBox.style.left), oTop = parseFloat(cropBox.style.top)
        const move = (ev) => {
            let nl = oLeft + (ev.clientX - startX)
            let nt = oTop + (ev.clientY - startY)
            nl = clamp(nl, 0, dispW - parseFloat(cropBox.style.width))
            nt = clamp(nt, 0, dispH - parseFloat(cropBox.style.height))
            cropBox.style.left = nl + 'px'
            cropBox.style.top = nt + 'px'
            readCropBox(); bake()
        }
        const up = () => { cropBox.removeEventListener('pointermove', move); cropBox.removeEventListener('pointerup', up) }
        cropBox.addEventListener('pointermove', move)
        cropBox.addEventListener('pointerup', up)
    })

    // 交互：拖角缩放裁切框
    cropBox.querySelectorAll('.be-h').forEach((h) => {
        h.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation()
            h.setPointerCapture(e.pointerId)
            const dir = h.dataset.dir
            const startX = e.clientX, startY = e.clientY
            const oLeft = parseFloat(cropBox.style.left), oTop = parseFloat(cropBox.style.top)
            const oW = parseFloat(cropBox.style.width), oH = parseFloat(cropBox.style.height)
            const move = (ev) => {
                const dx = ev.clientX - startX
                const dy = ev.clientY - startY
                let nl = oLeft, nt = oTop, nw = oW, nh = oH
                if (dir.includes('e')) nw = clamp(oW + dx, dispW * 0.02, dispW - oLeft)
                if (dir.includes('w')) { nw = clamp(oW - dx, dispW * 0.02, oLeft + oW); nl = oLeft + (oW - nw) }
                if (dir.includes('s')) nh = clamp(oH + dy, dispH * 0.02, dispH - oTop)
                if (dir.includes('n')) { nh = clamp(oH - dy, dispH * 0.02, oTop + oH); nt = oTop + (oH - nh) }
                if (state.aspectLock && dir.length === 2) {
                    nh = nw / state.ratio
                    if (dir.includes('n')) nt = oTop + oH - nh
                    if (nh > dispH - nt) { nh = dispH - nt; nw = nh * state.ratio; if (dir.includes('w')) nl = oLeft + oW - nw }
                }
                cropBox.style.left = nl + 'px'; cropBox.style.top = nt + 'px'
                cropBox.style.width = nw + 'px'; cropBox.style.height = nh + 'px'
                readCropBox(); bake()
            }
            const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up) }
            h.addEventListener('pointermove', move)
            h.addEventListener('pointerup', up)
        })
    })

    // 交互：预览舞台拖动定位（背景模式）
    stage.addEventListener('pointerdown', (e) => {
        if (state.display !== 'background') return
        if (e.target === badgeSlot || badgeSlot.contains(e.target)) return
        e.preventDefault()
        stage.setPointerCapture(e.pointerId)
        stage.style.cursor = 'grabbing'
        const rect = stage.getBoundingClientRect()
        const move = (ev) => {
            state.posX = clamp((ev.clientX - rect.left) / rect.width * 100, 0, 100)
            state.posY = clamp((ev.clientY - rect.top) / rect.height * 100, 0, 100)
            renderPreview()
        }
        const up = () => {
            stage.style.cursor = 'grab'
            stage.removeEventListener('pointermove', move)
            stage.removeEventListener('pointerup', up)
        }
        stage.addEventListener('pointermove', move)
        stage.addEventListener('pointerup', up)
    })

    // 控件
    $('beAspectLock').addEventListener('change', (e) => {
        state.aspectLock = e.target.checked
        if (state.aspectLock) state.ratio = (state.crop.w / state.crop.h) || 1
    })
    $('beRatio').addEventListener('change', (e) => {
        const v = e.target.value
        if (v === 'free') { state.aspectLock = false; $('beAspectLock').checked = false; return }
        state.aspectLock = true; $('beAspectLock').checked = true
        state.ratio = parseFloat(v)
        const cx = state.crop.x + state.crop.w / 2
        const cy = state.crop.y + state.crop.h / 2
        let nw = state.crop.w
        let nh = nw / state.ratio
        if (nh > 100) { nh = 100; nw = nh * state.ratio }
        state.crop.w = nw; state.crop.h = nh
        state.crop.x = clamp(cx - nw / 2, 0, 100 - nw)
        state.crop.y = clamp(cy - nh / 2, 0, 100 - nh)
        applyCropBox(); bake()
    })
    $('beScale').addEventListener('input', (e) => { state.scale = parseFloat(e.target.value); renderPreview() })
    $('beOpacity').addEventListener('input', (e) => { state.opacity = parseFloat(e.target.value); renderPreview() })
    $('beBadgeSize').addEventListener('input', (e) => { state.badgeSize = parseInt(e.target.value, 10); renderPreview() })

    function setMode(m) {
        state.display = m
        $('beModeBg').style.background = m === 'background' ? '#7c3aed' : '#fff'
        $('beModeBg').style.color = m === 'background' ? '#fff' : '#374151'
        $('beModeBadge').style.background = m === 'badge' ? '#7c3aed' : '#fff'
        $('beModeBadge').style.color = m === 'badge' ? '#fff' : '#374151'
        renderPreview()
    }
    $('beModeBg').addEventListener('click', () => setMode('background'))
    $('beModeBadge').addEventListener('click', () => setMode('badge'))

    function doSave() {
        const result = {
            display: state.display,
            croppedUrl: state.croppedUrl,
            crop: state.crop,
            posX: Math.round(state.posX * 10) / 10,
            posY: Math.round(state.posY * 10) / 10,
            scale: state.scale,
            opacity: state.opacity,
            aspectLock: state.aspectLock,
            badgeSize: state.badgeSize,
        }
        try { onSave && onSave(result) } catch (e) { /* 忽略回调异常 */ }
        return result
    }

    let escHandler = null
    if (embedded) {
        const applyBtn = $('beApply')
        if (applyBtn) applyBtn.addEventListener('click', () => {
            doSave()
            const hint = $('beAppliedHint')
            if (hint) { hint.style.opacity = '1'; setTimeout(() => { hint.style.opacity = '0' }, 1500) }
        })
    } else {
        $('beReset').addEventListener('click', () => {
            state.crop = { x: 0, y: 0, w: 100, h: 100 }
            state.ratio = 1
            applyCropBox(); bake()
        })
        const close = () => { if (escHandler) document.removeEventListener('keydown', escHandler); cleanup(); opts.__onClose && opts.__onClose() }
        $('beCloseX') && $('beCloseX').addEventListener('click', close)
        $('beCancel').addEventListener('click', close)
        $('beSave').addEventListener('click', () => { doSave(); close() })
        escHandler = (e) => { if (e.key === 'Escape') close() }
        document.addEventListener('keydown', escHandler)
    }

    function cleanup() { /* 容器 innerHTML 由调用方清空；此处预留清理钩子 */ }

    // 初始化
    setMode(state.display)
    renderPreview()

    return {
        apply: doSave,
        reset: () => { state.crop = { x: 0, y: 0, w: 100, h: 100 }; state.ratio = 1; applyCropBox(); bake() },
        getState: () => state,
        destroy: () => { if (escHandler) document.removeEventListener('keydown', escHandler); container.innerHTML = '' },
    }
}

/**
 * 弹出模态框形式的校徽编辑器（兼容旧调用方）。
 * @param {Object} opts 同 mountBadgeEditor，额外忽略 embedded
 */
export function openBadgeEditor(opts) {
    if (!opts || !opts.logoUrl) return
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;'
    overlay.innerHTML = `
    <div class="be-modal" style="background:#fff;border-radius:16px;width:960px;max-width:96vw;max-height:94vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.3);font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #eee;">
        <div>
          <div style="font-size:16px;font-weight:700;color:#1f2937;"><i class="fas fa-crop-alt" style="color:#7c3aed;margin-right:8px;"></i>校徽排版 / 裁切</div>
          <div style="font-size:12px;color:#9ca3af;margin-top:2px;">上传后在左侧裁切，右侧实时预览顶部导航效果，可拖动定位、缩放</div>
        </div>
        <button id="beCloseX" type="button" style="border:none;background:#f3f4f6;width:32px;height:32px;border-radius:8px;cursor:pointer;color:#6b7280;font-size:16px;">&times;</button>
      </div>
      <div id="beBody" style="display:flex;flex-direction:column;min-height:0;"></div>
    </div>`
    document.body.appendChild(overlay)
    document.body.style.overflow = 'hidden'

    const body = overlay.querySelector('#beBody')
    const ctrl = mountBadgeEditor(body, Object.assign({}, opts, { embedded: false }))

    const remove = () => {
        document.body.style.overflow = ''
        overlay.remove()
    }
    // 模态底部"取消/保存"由 mountBadgeEditor 内部接线，关闭时清理遮罩
    const origCloseX = body.querySelector('#beCloseX')
    if (origCloseX) origCloseX.addEventListener('click', remove)
    const cancel = body.querySelector('#beCancel')
    if (cancel) cancel.addEventListener('click', remove)
    const save = body.querySelector('#beSave')
    if (save) save.addEventListener('click', remove)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) remove() })

    return ctrl
}
