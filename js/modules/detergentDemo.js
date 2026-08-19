/**
 * 阴离子洗涤剂残留 · 拍照自动识别（纯前端演示）
 *
 * 流程（两步式，解决「算法没识别准样品/比色卡」的反馈）：
 *   1) 上传图片 → 算法 locateRegions 自动定位「比色卡区域」「样品区域」
 *   2) 在画布上先展示这两个区域框，让用户确认：
 *        - 识别正确 → 点「确认区域」→ 自动取色比色
 *        - 识别有误 → 手动拖动 / 缩放两个框矫正 → 再点「确认区域」
 *   3) 在（可能矫正过的）区域上执行 analyzeWithRegions 比色，输出浓度
 */

import { analyzeDetergentImage, locateRegions, analyzeWithRegions, analyzeWithTemplate, detectBlocksInRect, TEMPLATE_DESIGN, drawOverlay, drawRegionBoxes, buildResultHtml } from '../utils/detergentColorimetry.js';
import { isEmbedded, postToParent } from '../utils/embed.js';

const CONCENTRATIONS = [0, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0];

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const fileInput = document.getElementById('fileInput');
const uploadZone = document.getElementById('uploadZone');
const canvasWrap = document.getElementById('canvasWrap');
const canvas = document.getElementById('canvas');
const btnSample = document.getElementById('btnSample');
const btnClear = document.getElementById('btnClear');
const resultPanel = document.getElementById('resultPanel');
const resultGrid = document.getElementById('resultGrid');
const manualOverrideSection = document.getElementById('manualOverrideSection');
const qcSection = document.getElementById('qcSection');
const distanceTable = document.getElementById('distanceTable');
const blocksTable = document.getElementById('blocksTable');
const sampleInfo = document.getElementById('sampleInfo');
const resultLegend = document.getElementById('resultLegend');
const embedActions = document.getElementById('embedActions');
const btnConfirmResult = document.getElementById('btnConfirmResult');

// 区域确认 UI（动态创建，挂在 main 内）
let regionActions = document.getElementById('regionActions');
let regionHint = document.getElementById('regionHint');
let blockActions = document.getElementById('blockActions');
let regionLayer = document.getElementById('regionLayer');

const ctx = canvas.getContext('2d', { willReadFrequently: true });

// 离屏工作画布：统一降到 800 长边，作为算法 + 坐标基准，
// 保证 locateRegions 与 analyzeWithRegions 使用同一套坐标系。
const workCanvas = document.createElement('canvas');
const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

// 模块级状态
let sourceImage = null;          // 原图 Image
let locateCanvasSize = null;     // locateRegions 内部降采样后的尺寸 {width,height}
let currentRegions = null;       // 归一化坐标 { cardRect:{x,y,w,h}, tube:{x,y,w,h}, modified }（相对定位 canvas）
let currentBlocks = null;        // 色块微调层：归一化色块列表 [{x,y,w,h,concentration}]
let blockLayer = null;           // 色块微调 DOM 覆盖层
let initialLoc = null;           // 初次定位完整结果（含精确 blocks）
let lastResult = null;           // 比色结果
let stage = 'idle';              // idle | locating | region_confirm | block_confirm | analyzing | result
let currentMode = 'manual';     // 'manual'（两步手动调整）| 'template'（全自动模板）

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
init();

function init() {
  if (!fileInput) return;
  fileInput.addEventListener('change', handleFile);
  if (uploadZone) {
    ['dragover', 'dragenter'].forEach(ev => uploadZone.addEventListener(ev, e => { e.preventDefault(); uploadZone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => uploadZone.addEventListener(ev, e => { e.preventDefault(); uploadZone.classList.remove('dragover'); }));
    uploadZone.addEventListener('drop', e => {
      const f = e.dataTransfer?.files?.[0];
      if (f) loadFile(f);
    });
  }
  btnSample?.addEventListener('click', () => {
    sourceImage = null;
    runSample(); // 合成测试图总是走手动两步流程（便于直接验证逻辑）
  });
  btnClear?.addEventListener('click', resetAll);
  btnConfirmResult?.addEventListener('click', () => {
    if (!lastResult || !lastResult.ok) return;
    postToParent({ concentration: lastResult.mainValue, rawText: lastResult.mainValueText }, 'detergent');
  });

  // 模式切换
  const modeManual = document.getElementById('modeManual');
  const modeTemplate = document.getElementById('modeTemplate');
  const setMode = (m) => {
    currentMode = m;
    modeManual?.classList.toggle('active', m === 'manual');
    modeTemplate?.classList.toggle('active', m === 'template');
    const guide = document.getElementById('btnTemplateGuide');
    if (guide) guide.style.display = m === 'template' ? 'inline-block' : 'none';
    const tip = document.getElementById('modeTip');
    if (tip) {
      tip.innerHTML = m === 'template'
        ? '<strong>全自动（模板）：</strong>按规范把比色卡/离心管放进标准指导卡对应插槽，俯拍上传即可自动定位识别。需先打印指导卡。'
        : '<strong>手动调整：</strong>自动圈出比色卡/样品 → 你确认或拖框矫正 → 再微调 7 个色块 → 识别。';
    }
  };
  modeManual?.addEventListener('click', () => setMode('manual'));
  modeTemplate?.addEventListener('click', () => setMode('template'));
  setMode('manual');

  document.getElementById('btnTemplateGuide')?.addEventListener('click', showTemplateGuide);
}

// ---------------------------------------------------------------------------
// 文件加载
// ---------------------------------------------------------------------------
function handleFile(e) {
  const f = e.target.files?.[0];
  if (f) loadFile(f);
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      sourceImage = img;
      if (currentMode === 'template') runTemplateStep(img);
      else runLocateStep(img);
    };
    img.onerror = () => alert('图片加载失败');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// ---------------------------------------------------------------------------
// 合成测试图
// ---------------------------------------------------------------------------
async function runSample() {
  const synth = await import('../utils/syntheticDetergent.js').catch(() => null);
  if (synth?.generateSyntheticDetergentCanvas) {
    const c = synth.generateSyntheticDetergentCanvas();
    sourceImage = c;
    runLocateStep(c);
  } else {
    console.warn('合成图模块不可用');
  }
}

// ---------------------------------------------------------------------------
// 全自动方案：模板（A4 拍摄指导卡）识别
// ---------------------------------------------------------------------------
async function runTemplateStep(image) {
  stage = 'analyzing';
  clearManualOverride();
  resultPanel.style.display = 'none';
  resultLegend.style.display = 'none';
  destroyRegionLayer();
  destroyBlockLayer();
  drawImageToCanvas(image);
  drawWorkCanvas(image);
  setBusy(true, '正在按拍摄指导卡定位…');

  let res;
  try {
    res = analyzeWithTemplate(workCanvas, { concentrations: CONCENTRATIONS });
  } catch (e) {
    console.error(e);
    res = { ok: false, stage: 'exception', error: 'TEMPLATE_FAIL', humanMessage: '模板识别失败：' + (e?.message || e) };
  }
  setBusy(false);

  if (!res.ok) {
    console.warn('[detergentDemo] 模板识别未成功：', res.humanMessage);
    showTemplateFallback(res);
    return;
  }

  stage = 'result';
  lastResult = res;
  // 模板模式也展示 7 个色块 + 样品框
  drawOverlay(canvas, res, { scaleX: canvas.width / res.canvasSize.width, scaleY: canvas.height / res.canvasSize.height });
  renderResult(res);
  resultPanel.style.display = 'block';
  resultLegend.style.display = 'block';
  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 模板识别失败时，提示并自动切回手动模式 */
function showTemplateFallback(res) {
  stage = 'result';
  renderResult(res);
  resultPanel.style.display = 'block';
  resultLegend.style.display = 'block';
  // 给出切回手动模式的入口
  const note = document.createElement('div');
  note.className = 'hint-box';
  note.style.marginTop = '10px';
  note.innerHTML = `💡 全自动模板未识别到定位黑框。请改用 <strong>「手动调整」模式</strong> 手动框选，或确认已按标准指导卡拍摄。`;
  resultPanel.appendChild(note);
}

// ---------------------------------------------------------------------------
// A4 拍摄指导卡（模板）预览 / 打印 —— 与算法 TEMPLATE_DESIGN 严格一致
// ---------------------------------------------------------------------------
// 这是一张「打印出来给操作员摆放实物」的实物操作卡：
//   - 四角印 4 个「回」字嵌套角标（算法定位用，尺寸递减便于识别身份）
//   - 上方红框区画离心管轮廓（竖放示意）
//   - 下方蓝框区画 7 色块轮廓（横放示意，带编号 0–6）
//   - 顶部标题 + 方向标识，底部 4 步操作说明
function showTemplateGuide() {
  const w = 794, h = 1123; // A4 @96dpi
  const g = document.createElement('canvas');
  g.width = w; g.height = h;
  const c = g.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);

  const D = TEMPLATE_DESIGN;
  const px = (nx) => Math.round(nx * w);
  const py = (ny) => Math.round(ny * h);

  // 画「回」字定位标：外黑实块 + 白环 + 中心黑点（同心三环，便于算法三环检测）
  function drawFinder(cx, cy, size) {
    const s = size, half = s / 2, q = s / 7;
    c.fillStyle = '#000';
    c.fillRect(cx - half, cy - half, s, s);
    c.fillStyle = '#fff';
    c.fillRect(cx - half + q, cy - half + q, s - 2 * q, s - 2 * q);
    c.fillStyle = '#000';
    c.fillRect(cx - half + 2 * q, cy - half + 2 * q, s - 4 * q, s - 4 * q);
  }

  // ===== 1. 顶部标题栏 + 方向标识 =====
  c.fillStyle = '#111'; c.font = 'bold 36px sans-serif'; c.textAlign = 'left';
  c.fillText('阴离子洗涤剂残留 · 标准拍摄指导卡', px(0.06), py(0.045));
  c.font = 'bold 22px sans-serif'; c.fillStyle = '#dc2626';
  c.fillText('↑ 此边朝上（文字方向，勿倒置拍摄）', px(0.06), py(0.085));

  // ===== 2. 离心管摆放区（红框，竖放示意）=====
  const tubeR = { x: px(D.tubeSlot.x), y: py(D.tubeSlot.y), w: px(D.tubeSlot.w), h: px(D.tubeSlot.h) };
  c.fillStyle = '#fef2f2'; c.fillRect(tubeR.x, tubeR.y, tubeR.w, tubeR.h);
  c.strokeStyle = '#dc2626'; c.lineWidth = 4; c.setLineDash([12, 8]);
  c.strokeRect(tubeR.x, tubeR.y, tubeR.w, tubeR.h); c.setLineDash([]);
  // 离心管轮廓（竖放）：管帽 + 管身 + 刻度
  const tx = tubeR.x + tubeR.w / 2;
  const tubeTop = tubeR.y + 18, tubeBot = tubeR.y + tubeR.h - 18;
  const tubeW = Math.min(tubeR.w * 0.28, 70);
  c.fillStyle = '#fff'; c.strokeStyle = '#dc2626'; c.lineWidth = 3;
  // 管帽
  c.fillRect(tx - tubeW / 2, tubeTop, tubeW, 16);
  c.strokeRect(tx - tubeW / 2, tubeTop, tubeW, 16);
  // 管身（下宽上窄）
  c.beginPath();
  c.moveTo(tx - tubeW / 2, tubeTop + 16);
  c.lineTo(tx + tubeW / 2, tubeTop + 16);
  c.lineTo(tx + tubeW * 0.62, tubeBot);
  c.lineTo(tx - tubeW * 0.62, tubeBot);
  c.closePath(); c.fill(); c.stroke();
  // 刻度线
  c.lineWidth = 1; c.strokeStyle = '#dc2626';
  for (let i = 1; i <= 4; i++) {
    const yy = tubeTop + 16 + (tubeBot - tubeTop - 16) * (i / 5);
    c.beginPath(); c.moveTo(tx - tubeW * 0.6, yy); c.lineTo(tx - tubeW * 0.2, yy); c.stroke();
  }
  c.fillStyle = '#dc2626'; c.font = 'bold 24px sans-serif'; c.textAlign = 'center';
  c.fillText('离心管竖放于此', tx, tubeR.y - 8);
  c.font = '15px sans-serif'; c.fillStyle = '#7f1d1d';
  c.fillText('（管口朝上，放红框内居中）', tx, tubeR.y + tubeR.h + 18);

  // ===== 3. 比色卡摆放区（蓝框，横放 7 色块示意）=====
  const cardR = { x: px(D.cardSlot.x), y: py(D.cardSlot.y), w: px(D.cardSlot.w), h: px(D.cardSlot.h) };
  c.fillStyle = '#eef2ff'; c.fillRect(cardR.x, cardR.y, cardR.w, cardR.h);
  c.strokeStyle = '#2563eb'; c.lineWidth = 4; c.setLineDash([12, 8]);
  c.strokeRect(cardR.x, cardR.y, cardR.w, cardR.h); c.setLineDash([]);
  // 7 个色块轮廓（带编号）
  const bw = cardR.w / 7;
  const bh = Math.min(cardR.h * 0.62, 78);
  const by = cardR.y + (cardR.h - bh) / 2 + 6;
  for (let i = 0; i < 7; i++) {
    const bx = cardR.x + i * bw + 4;
    c.fillStyle = '#fff'; c.fillRect(bx, by, bw - 8, bh);
    c.strokeStyle = '#2563eb'; c.lineWidth = 2; c.strokeRect(bx, by, bw - 8, bh);
    c.fillStyle = '#1e3a8a'; c.font = 'bold 20px sans-serif'; c.textAlign = 'center';
    c.fillText(String(i), bx + (bw - 8) / 2, by + bh / 2 + 7);
  }
  c.fillStyle = '#2563eb'; c.font = 'bold 24px sans-serif'; c.textAlign = 'center';
  c.fillText('比色卡横放于此（蓝框内，与 7 格对齐）', cardR.x + cardR.w / 2, cardR.y - 8);

  // ===== 4. 四角定位标（算法用，标注勿遮挡）=====
  const f = D.mainFinders;
  drawFinder(px(f.TL.x), py(f.TL.y), f.TL.size);
  drawFinder(px(f.TR.x), py(f.TR.y), f.TR.size);
  drawFinder(px(f.BL.x), py(f.BL.y), f.BL.size);
  drawFinder(px(f.BR.x), py(f.BR.y), f.BR.size);
  c.fillStyle = '#000'; c.font = '13px sans-serif'; c.textAlign = 'center';
  c.fillText('定位标·勿遮挡', px(f.TL.x), py(f.TL.y) + f.TL.size / 2 + 16);
  c.fillText('定位标·勿遮挡', px(f.TR.x), py(f.TR.y) + f.TR.size / 2 + 16);
  c.fillText('定位标·勿遮挡', px(f.BL.x), py(f.BL.y) + f.BL.size / 2 + 16);
  c.fillText('定位标·勿遮挡', px(f.BR.x), py(f.BR.y) + f.BR.size / 2 + 16);

  // ===== 5. 底部操作说明 =====
  c.textAlign = 'left'; c.fillStyle = '#111'; c.font = 'bold 20px sans-serif';
  c.fillText('操作说明：', px(0.06), py(0.945));
  c.font = '16px sans-serif'; c.fillStyle = '#333';
  const tips = [
    '① 打印本卡（建议 A4 彩色，卡纸更佳），平铺于纯色桌面，避免黑色背景。',
    '② 比色卡横放下方蓝框、离心管竖放上方红框，与虚线框对齐居中。',
    '③ 手机垂直俯拍，光照均匀，四角定位标完整入镜、不反光不遮挡。',
    '④ 上传照片后在识别页选「全自动（模板）」模式，系统自动定位并比色。',
  ];
  tips.forEach((t, i) => c.fillText(t, px(0.06), py(0.965) + i * 26));

  const url = g.toDataURL('image/png');
  const win = window.open('', '_blank');
  if (!win) { alert('预览被浏览器拦截，请允许弹出窗口'); return; }
  win.document.write(`<html><head><title>拍摄指导卡</title></head><body style="margin:0;text-align:center;">
    <img src="${url}" style="width:100%;max-width:794px;">
    <p><button onclick="window.print()" style="padding:12px 24px;font-size:16px;">打印此 A4 指导卡</button></p>
    </body></html>`);
  win.document.close();
}

// ---------------------------------------------------------------------------
// 步骤一：区域定位
// ---------------------------------------------------------------------------
async function runLocateStep(image) {
  stage = 'locating';
  // 重置 UI
  clearManualOverride();
  resultPanel.style.display = 'none';
  resultLegend.style.display = 'none';
  destroyRegionLayer();
  setBusy(true, '正在定位比色卡与样品区域…');

  // 先把图绘到展示画布（用于 overlay/交互），并绘制到离屏工作画布（800 基准，算法坐标）
  drawImageToCanvas(image);
  drawWorkCanvas(image);

  let loc;
  try {
    loc = locateRegions(workCanvas, { concentrations: CONCENTRATIONS });
  } catch (e) {
    console.error(e);
    loc = { ok: false, stage: 'exception', error: 'LOCATE_FAIL', humanMessage: '区域定位失败：' + (e?.message || e) };
  }
  setBusy(false);

  if (!loc.ok) {
    // 定位失败：给出兜底区域 + 允许纯手动框选
    console.warn('[detergentDemo] 区域定位未成功，进入手动框选:', loc.humanMessage);
    const fb = fallbackRegions(workCanvas.width, workCanvas.height);
    currentRegions = fb;
    locateCanvasSize = { width: workCanvas.width, height: workCanvas.height };
    startRegionConfirm(true, loc.humanMessage || '未能自动定位，请手动拖拽框选比色卡与样品区域');
    return;
  }

  // 把 locate 返回的像素坐标（基于降采样 800 的 canvas）转成归一化
  locateCanvasSize = loc.canvasSize;
  initialLoc = loc;
  currentRegions = {
    cardRect: normRect(loc.cardRect, loc.canvasSize),
    tube: normRect(loc.tube, loc.canvasSize),
    modified: false,
  };

  startRegionConfirm(false, '请确认下方绿/蓝虚线框是否准确圈中了「比色卡」与「样品」。无误请点「确认区域」；有误请直接拖动框或角标矫正。');
}

// ---------------------------------------------------------------------------
// 步骤一之后：区域确认阶段（可拖拽 / 缩放）
// ---------------------------------------------------------------------------
function startRegionConfirm(manual, hintText) {
  stage = 'region_confirm';
  // canvas 只保留原图；可交互的区域框由 DOM 覆盖层 (#regionLayer) 显示，
  // 避免 clearRect 把原图擦掉，也避免 canvas 文字与 DOM 标签重叠。

  ensureRegionUI();
  showRegionActions(true, manual);
  if (hintText) showRegionHint(hintText, manual ? 'warn' : 'info');
  buildRegionLayer();
}

// ---------------------------------------------------------------------------
// 步骤二（微调）：色块确认层 —— 7 个色块各自可拖拽/缩放，第二次调整
// ---------------------------------------------------------------------------
function startBlockConfirm() {
  stage = 'block_confirm';
  ensureRegionUI();
  showBlockActions(true);
  showRegionHint('已自动识别 7 个色块。若个别色块未对准彩色格子，可直接拖动或拉角标微调；无误请点「开始比色识别」。', 'info');
  buildBlockLayer();
}

/** 在 canvas 上叠加 7 个可拖拽/缩放的色块框 */
function buildBlockLayer() {
  destroyBlockLayer();
  blockLayer = document.createElement('div');
  blockLayer.id = 'blockLayer';
  blockLayer.className = 'region-layer';
  canvasWrap.appendChild(blockLayer);

  currentBlocks.forEach((b, idx) => {
    const box = createBlockBox(idx);
    blockLayer.appendChild(box);
  });
  layoutBlockBoxes();
  window.addEventListener('resize', layoutBlockBoxes);
}

function destroyBlockLayer() {
  if (blockLayer) { blockLayer.remove(); blockLayer = null; }
  window.removeEventListener('resize', layoutBlockBoxes);
}

function createBlockBox(idx) {
  const box = document.createElement('div');
  box.className = `block-box bb-${idx}`;
  box.dataset.idx = idx;
  const conc = CONCENTRATIONS[idx];
  box.innerHTML = `<span class="bb-label">${conc} mg/L</span>`;
  ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(handle => {
    const h = document.createElement('span');
    h.className = `rb-handle rb-${handle}`;
    h.dataset.handle = handle;
    box.appendChild(h);
  });

  box.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('rb-handle')) return;
    startBlockDrag(e, box, idx, 'move');
  });
  box.addEventListener('touchstart', (e) => {
    if (e.target.classList.contains('rb-handle')) return;
    startBlockDrag(e, box, idx, 'move', true);
  }, { passive: false });
  box.querySelectorAll('.rb-handle').forEach(h => {
    h.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      startBlockDrag(e, box, idx, 'resize', false, h.dataset.handle);
    });
    h.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      startBlockDrag(e, box, idx, 'resize', true, h.dataset.handle);
    }, { passive: false });
  });
  return box;
}

function layoutBlockBoxes() {
  if (!blockLayer || !currentBlocks) return;
  const rect = canvasWrap.getBoundingClientRect();
  blockLayer.style.width = rect.width + 'px';
  blockLayer.style.height = rect.height + 'px';
  blockLayer.style.left = '0';
  blockLayer.style.top = '0';
  blockLayer.querySelectorAll('.block-box').forEach(box => {
    const idx = +box.dataset.idx;
    const r = currentBlocks[idx];
    if (!r) return;
    box.style.left = (r.x * 100) + '%';
    box.style.top = (r.y * 100) + '%';
    box.style.width = (r.w * 100) + '%';
    box.style.height = (r.h * 100) + '%';
  });
}

function startBlockDrag(e, box, idx, mode, isTouch, handle) {
  e.preventDefault();
  const clientPt = (ev) => {
    const t = isTouch ? ev.touches[0] : ev;
    return { x: t.clientX, y: t.clientY };
  };
  const wrapRect = canvasWrap.getBoundingClientRect();
  const start = clientPt(e);
  const r0 = { ...currentBlocks[idx] };
  const toNorm = (clientX, clientY) => ({
    x: (clientX - wrapRect.left) / wrapRect.width,
    y: (clientY - wrapRect.top) / wrapRect.height,
  });

  const onMove = (ev) => {
    const p = clientPt(ev);
    const dx = (p.x - start.x) / wrapRect.width;
    const dy = (p.y - start.y) / wrapRect.height;
    let r = { ...r0 };
    if (mode === 'move') {
      r.x = clamp(r0.x + dx, 0, 1 - r.w);
      r.y = clamp(r0.y + dy, 0, 1 - r.h);
    } else {
      const right = r0.x + r0.w, bottom = r0.y + r0.h;
      let left = r0.x, top = r0.y, w = r0.w, h = r0.h;
      if (handle.includes('w')) { left = clamp(r0.x + dx, 0, right - 0.01); w = right - left; }
      if (handle.includes('e')) { w = clamp(r0.w + dx, 0.01, 1 - r0.x); }
      if (handle.includes('n')) { top = clamp(r0.y + dy, 0, bottom - 0.01); h = bottom - top; }
      if (handle.includes('s')) { h = clamp(r0.h + dy, 0.01, 1 - r0.y); }
      r = { x: left, y: top, w, h };
    }
    currentBlocks[idx] = r;
    box.style.left = (r.x * 100) + '%';
    box.style.top = (r.y * 100) + '%';
    box.style.width = (r.w * 100) + '%';
    box.style.height = (r.h * 100) + '%';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

/** 色块微调完成后，用调整后的色块（真实取色）跑比色 */
async function confirmBlocks() {
  if (!currentBlocks) return;
  stage = 'analyzing';
  showBlockActions(false);
  destroyBlockLayer();
  showRegionHint('', '');
  setBusy(true, '正在比色识别…');

  const regions = {
    cardRect: denormRect(currentRegions.cardRect, locateCanvasSize),
    tube: denormRect(currentRegions.tube, locateCanvasSize),
    tubeZone: 'manual',
    blocks: currentBlocks.map((b, i) => ({
      x: Math.round(b.x * locateCanvasSize.width),
      y: Math.round(b.y * locateCanvasSize.height),
      w: Math.round(b.w * locateCanvasSize.width),
      h: Math.round(b.h * locateCanvasSize.height),
      concentration: CONCENTRATIONS[i],
      measured: true,
      inferred: false,
    })),
  };

  let res;
  try {
    res = analyzeWithRegions(workCanvas, { concentrations: CONCENTRATIONS }, regions);
  } catch (e) {
    console.error(e);
    res = { ok: false, stage: 'exception', error: 'ANALYZE_FAIL', humanMessage: '比色识别失败：' + (e?.message || e) };
  }
  setBusy(false);
  stage = 'result';
  lastResult = res;

  if (res.ok) {
    drawOverlay(canvas, res, { scaleX: canvas.width / res.canvasSize.width, scaleY: canvas.height / res.canvasSize.height });
  }
  renderResult(res);
  resultPanel.style.display = 'block';
  resultLegend.style.display = 'block';
  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 仅用于 UI 兜底的等距色块（无算法检测时） */
function inferBlocksForUI(cardRect, n) {
  const blocks = [];
  const step = cardRect.w / n;
  for (let i = 0; i < n; i++) {
    blocks.push({
      x: Math.round(cardRect.x + i * step + step * 0.1),
      y: cardRect.y, w: Math.round(step * 0.8), h: cardRect.h,
      concentration: i,
    });
  }
  return blocks;
}

/** 确认区域 → 进入「色块微调」步骤（第二次调整：每个色块可单独拖拽/缩放） */
async function confirmRegions() {
  if (!currentRegions) return;
  destroyRegionLayer();
  showRegionActions(false);
  showRegionHint('', '');
  setBusy(true, '正在色卡内识别 7 个色块…');

  const regions = {
    cardRect: denormRect(currentRegions.cardRect, locateCanvasSize),
    tube: denormRect(currentRegions.tube, locateCanvasSize),
    tubeZone: 'manual',
  };

  // 在用户框定的比色卡内检测真实色块
  let blocks = null;
  try {
    blocks = detectBlocksInRect(workCanvas, regions.cardRect, CONCENTRATIONS.length);
  } catch (e) { console.error(e); }
  if (!blocks || blocks.length < 4) {
    // 检测不到足够色块：用 cardRect 等距推断，至少让用户能调
    blocks = inferBlocksForUI(regions.cardRect, CONCENTRATIONS.length);
  }

  // 存为「归一化色块列表」，供微调层展示
  currentBlocks = blocks.map(b => ({
    x: b.x / locateCanvasSize.width,
    y: b.y / locateCanvasSize.height,
    w: b.w / locateCanvasSize.width,
    h: b.h / locateCanvasSize.height,
    concentration: b.concentration,
  }));

  setBusy(false);
  startBlockConfirm();
}

// ---------------------------------------------------------------------------
// 步骤（兼容）一步式：保留给不需要确认环节的调用
// ---------------------------------------------------------------------------
async function runOnce() {
  if (!sourceImage) return;
  stage = 'analyzing';
  setBusy(true, '正在识别…');
  drawImageToCanvas(sourceImage);
  let res;
  try {
    res = await analyzeDetergentImage(canvas, { concentrations: CONCENTRATIONS });
  } catch (e) {
    res = { ok: false, stage: 'exception', error: 'ANALYZE_FAIL', humanMessage: '识别失败：' + (e?.message || e) };
  }
  setBusy(false);
  stage = 'result';
  lastResult = res;
  if (res.ok) drawOverlay(canvas, res, { scaleX: canvas.width / res.canvasSize.width, scaleY: canvas.height / res.canvasSize.height });
  renderResult(res);
  resultPanel.style.display = 'block';
  resultLegend.style.display = 'block';
}

// ---------------------------------------------------------------------------
// 渲染结果
// ---------------------------------------------------------------------------
function renderResult(result) {
  if (!result.ok) {
    resultGrid.innerHTML = `<div class="fail-box">⚠️ ${result.humanMessage || '识别失败'}</div>`;
    if (result.hint) {
      resultGrid.innerHTML += `<div class="hint-box">提示：${result.hint}</div>`;
    }
    manualOverrideSection.style.display = 'block';
    renderManualOverride(result);
    qcSection.innerHTML = '';
    return;
  }

  resultGrid.innerHTML = buildResultHtml(result);
  manualOverrideSection.style.display = 'block';
  renderManualOverride(result);
  qcSection.innerHTML = renderQcNotes(result.qc);

  document.getElementById('distanceTable') && fillDistanceTable(result);
  document.getElementById('blocksTable') && fillBlocksTable(result);
  document.getElementById('sampleInfo') && (sampleInfo.innerHTML =
    `离心管区域：x=${result.tube.x}, y=${result.tube.y}, w=${result.tube.w}, h=${result.tube.h}（zone: ${result.tubeZone}）<br>` +
    `样品 RGB：${result.sampleColor.map(v => Math.round(v)).join(', ')}　Lab：L*${result.sampleLab.L?.toFixed?.(1)} a*${result.sampleLab.a?.toFixed?.(1)} b*${result.sampleLab.b?.toFixed?.(1)}`);

  if (isEmbedded()) embedActions.style.display = 'block';
}

function renderQcNotes(qc) {
  if (!qc) return '';
  const icon = qc.ok ? '✅' : '⚠️';
  let html = `<div class="qc-head ${qc.ok ? 'ok' : 'bad'}">${icon} 质控${qc.ok ? '通过' : '异常'}</div>`;
  if (qc.notes?.length) {
    html += '<ul class="qc-list">';
    for (const n of qc.notes) {
      const cls = n.level === 'error' ? 'err' : 'warn';
      html += `<li class="${cls}">[${n.level === 'error' ? '错误' : '提醒'}] ${n.text}</li>`;
    }
    html += '</ul>';
  }
  return html;
}

function fillDistanceTable(result) {
  const tb = distanceTable.querySelector('tbody');
  if (!tb) return;
  tb.innerHTML = '';
  (result.sortedDistances || []).forEach((d, i) => {
    const sw = `rgb(${d.color.map(v => Math.round(v)).join(',')})`;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${d.concentration} mg/L <span class="swatch" style="background:${sw}"></span></td>` +
      `<td>${d.deltaE.toFixed(2)}</td><td>#${i + 1}</td>`;
    tb.appendChild(tr);
  });
}

function fillBlocksTable(result) {
  const tb = blocksTable.querySelector('tbody');
  if (!tb) return;
  tb.innerHTML = '';
  (result.blocks || []).forEach((b, i) => {
    const col = b.color || b.lab;
    const rgb = b.color ? `rgb(${b.color.map(v => Math.round(v)).join(',')})` : '—';
    const lab = b.lab ? `L*${b.lab.L?.toFixed?.(1)} a*${b.lab.a?.toFixed?.(1)} b*${b.lab.b?.toFixed?.(1)}` : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i}</td><td>${b.concentration} mg/L</td><td><span class="swatch" style="background:${rgb}"></span> ${rgb}</td><td>${lab}</td>`;
    tb.appendChild(tr);
  });
}

function renderManualOverride(result) {
  const refined = result.ok ? result.refinedValue : null;
  const main = result.ok ? result.mainValue : null;
  manualOverrideSection.innerHTML = `
    <div class="override-box">
      <label class="override-label">人工修正浓度（mg/L）：</label>
      <input type="number" id="overrideInput" step="0.001" min="0"
             value="${refined ?? main ?? ''}" placeholder="如 0.05">
      <button class="btn" id="btnOverrideApply"><i class="fas fa-check"></i> 应用修正</button>
      <span id="overrideMsg" class="override-msg"></span>
    </div>`;
  const applyBtn = document.getElementById('btnOverrideApply');
  const input = document.getElementById('overrideInput');
  const msg = document.getElementById('overrideMsg');
  applyBtn?.addEventListener('click', () => {
    const v = parseFloat(input.value);
    if (isNaN(v) || v < 0) { msg.textContent = '请输入有效数值'; msg.className = 'override-msg err'; return; }
    msg.textContent = `已修正为 ${v} mg/L`; msg.className = 'override-msg ok';
    if (isEmbedded()) postToParent({ concentration: v, rawText: String(v) }, 'detergent');
  });
}

function clearManualOverride() {
  manualOverrideSection.style.display = 'none';
  manualOverrideSection.innerHTML = '';
}

// ---------------------------------------------------------------------------
// 区域确认 UI（动态）
// ---------------------------------------------------------------------------
function ensureRegionUI() {
  // 区域确认动作条
  if (!regionActions) {
    regionActions = document.createElement('div');
    regionActions.id = 'regionActions';
    regionActions.style.display = 'none';
    regionActions.innerHTML = `
      <div class="ra-btns">
        <button class="btn primary" id="btnConfirmRegion"><i class="fas fa-check-circle"></i> 确认区域，下一步</button>
        <button class="btn ghost" id="btnReLocate"><i class="fas fa-redo"></i> 重新自动定位</button>
        <button class="btn ghost" id="btnCancelRegion"><i class="fas fa-times"></i> 取消</button>
      </div>`;
    const canvasPanel = canvasWrap.closest('.panel');
    canvasPanel?.parentNode.insertBefore(regionActions, canvasPanel.nextSibling);
    document.getElementById('btnConfirmRegion').addEventListener('click', confirmRegions);
    document.getElementById('btnReLocate').addEventListener('click', () => { if (sourceImage) runLocateStep(sourceImage); });
    document.getElementById('btnCancelRegion').addEventListener('click', resetAll);
  }
  // 色块微调动作条（第二次调整）
  if (!blockActions) {
    blockActions = document.createElement('div');
    blockActions.id = 'blockActions';
    blockActions.style.display = 'none';
    blockActions.innerHTML = `
      <div class="ra-btns">
        <button class="btn primary" id="btnConfirmBlocks"><i class="fas fa-check-circle"></i> 开始比色识别</button>
        <button class="btn ghost" id="btnBackRegions"><i class="fas fa-arrow-left"></i> 返回改区域</button>
      </div>`;
    const canvasPanel = canvasWrap.closest('.panel');
    canvasPanel?.parentNode.insertBefore(blockActions, canvasPanel.nextSibling);
    document.getElementById('btnConfirmBlocks').addEventListener('click', confirmBlocks);
    document.getElementById('btnBackRegions').addEventListener('click', () => { if (currentRegions) startRegionConfirm(false, '可重新调整比色卡与样品区域。'); });
  }
  if (!regionHint) {
    regionHint = document.createElement('div');
    regionHint.id = 'regionHint';
    regionHint.style.display = 'none';
    blockActions?.parentNode.insertBefore(regionHint, blockActions);
  }
}

function showRegionActions(show, manual) {
  if (!regionActions) return;
  regionActions.style.display = show ? 'block' : 'none';
  const reloc = document.getElementById('btnReLocate');
  if (reloc) reloc.style.display = manual ? 'none' : 'inline-block';
}

function showBlockActions(show) {
  if (!blockActions) return;
  blockActions.style.display = show ? 'block' : 'none';
}

function showRegionHint(text, kind) {
  if (!regionHint) return;
  if (!text) { regionHint.style.display = 'none'; return; }
  regionHint.style.display = 'block';
  regionHint.className = 'region-hint ' + (kind || 'info');
  regionHint.innerHTML = `<i class="fas fa-${kind === 'warn' ? 'exclamation-triangle' : 'info-circle'}"></i> ${text}`;
}

/** 在 canvas 上叠加可拖拽 / 可缩放的区域框 */
function buildRegionLayer() {
  destroyRegionLayer();
  regionLayer = document.createElement('div');
  regionLayer.id = 'regionLayer';
  regionLayer.className = 'region-layer';
  canvasWrap.appendChild(regionLayer);

  const defs = [
    { key: 'cardRect', label: '比色卡区域', color: 'card' },
    { key: 'tube', label: '样品区域', color: 'tube' },
  ];
  for (const d of defs) {
    const box = createRegionBox(d.key, d.label, d.color);
    regionLayer.appendChild(box);
  }
  layoutRegionBoxes();
  window.addEventListener('resize', layoutRegionBoxes);
}

function destroyRegionLayer() {
  if (regionLayer) { regionLayer.remove(); regionLayer = null; }
  window.removeEventListener('resize', layoutRegionBoxes);
}

/** 创建一个可拖拽 + 角标缩放的区域框 */
function createRegionBox(key, label, colorClass) {
  const box = document.createElement('div');
  box.className = `region-box ${colorClass}`;
  box.dataset.key = key;
  box.innerHTML = `<span class="rb-label">${label}</span>`;
  // 8 个缩放手柄
  ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(handle => {
    const h = document.createElement('span');
    h.className = `rb-handle rb-${handle}`;
    h.dataset.handle = handle;
    box.appendChild(h);
  });

  // 拖动移动
  box.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('rb-handle')) return;
    startDrag(e, box, key, 'move');
  });
  box.addEventListener('touchstart', (e) => {
    if (e.target.classList.contains('rb-handle')) return;
    startDrag(e, box, key, 'move', true);
  }, { passive: false });

  // 缩放手柄
  box.querySelectorAll('.rb-handle').forEach(h => {
    h.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      startDrag(e, box, key, 'resize', false, h.dataset.handle);
    });
    h.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      startDrag(e, box, key, 'resize', true, h.dataset.handle);
    }, { passive: false });
  });

  return box;
}

/** 把归一化坐标映射到 layer 像素位置 */
function layoutRegionBoxes() {
  if (!regionLayer || !currentRegions) return;
  const rect = canvasWrap.getBoundingClientRect();
  regionLayer.style.width = rect.width + 'px';
  regionLayer.style.height = rect.height + 'px';
  regionLayer.style.left = '0';
  regionLayer.style.top = '0';

  regionLayer.querySelectorAll('.region-box').forEach(box => {
    const key = box.dataset.key;
    const r = currentRegions[key];
    if (!r) return;
    box.style.left = (r.x * 100) + '%';
    box.style.top = (r.y * 100) + '%';
    box.style.width = (r.w * 100) + '%';
    box.style.height = (r.h * 100) + '%';
  });
}

function startDrag(e, box, key, mode, isTouch, handle) {
  e.preventDefault();
  const clientPt = (ev) => {
    const t = isTouch ? ev.touches[0] : ev;
    return { x: t.clientX, y: t.clientY };
  };
  const wrapRect = canvasWrap.getBoundingClientRect();
  const start = clientPt(e);
  const r0 = { ...currentRegions[key] };
  const toNorm = (clientX, clientY) => ({
    x: (clientX - wrapRect.left) / wrapRect.width,
    y: (clientY - wrapRect.top) / wrapRect.height,
  });

  const onMove = (ev) => {
    const p = clientPt(ev);
    const dx = (p.x - start.x) / wrapRect.width;
    const dy = (p.y - start.y) / wrapRect.height;
    let r = { ...r0 };
    if (mode === 'move') {
      r.x = clamp(r0.x + dx, 0, 1 - r.w);
      r.y = clamp(r0.y + dy, 0, 1 - r.h);
    } else {
      // resize：根据手柄方向调整 x/y/w/h
      const right = r0.x + r0.w, bottom = r0.y + r0.h;
      let left = r0.x, top = r0.y, w = r0.w, h = r0.h;
      if (handle.includes('w')) { left = clamp(r0.x + dx, 0, right - 0.02); w = right - left; }
      if (handle.includes('e')) { w = clamp(r0.w + dx, 0.02, 1 - r0.x); }
      if (handle.includes('n')) { top = clamp(r0.y + dy, 0, bottom - 0.02); h = bottom - top; }
      if (handle.includes('s')) { h = clamp(r0.h + dy, 0.02, 1 - r0.y); }
      r = { x: left, y: top, w, h };
    }
    currentRegions[key] = r;
    currentRegions.modified = true;
    box.style.left = (r.x * 100) + '%';
    box.style.top = (r.y * 100) + '%';
    box.style.width = (r.w * 100) + '%';
    box.style.height = (r.h * 100) + '%';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function drawImageToCanvas(image) {
  const orig = getImageSize(image);
  const maxW = 760;
  let w = orig.w, h = orig.h;
  if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
  canvas.width = w; canvas.height = h;
  canvasWrap.classList.remove('placeholder');
  canvasWrap.innerHTML = '';
  canvasWrap.appendChild(canvas);
  canvas.style.display = 'block';
  ctx.drawImage(image, 0, 0, w, h);
}

/** 把同一张图绘制到离屏工作画布（降到 800 长边），作为算法统一坐标基准 */
function drawWorkCanvas(image) {
  const orig = getImageSize(image);
  const maxW = 800;
  let w = orig.w, h = orig.h;
  if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
  workCanvas.width = w; workCanvas.height = h;
  workCtx.drawImage(image, 0, 0, w, h);
}

/** 兼容 Image / Canvas / Video 取原始像素尺寸 */
function getImageSize(image) {
  let w = image.width || image.naturalWidth || image.videoWidth;
  let h = image.height || image.naturalHeight || image.videoHeight;
  if (!w || !h) {
    // 合成 canvas 可能直接带 width/height 数值
    w = image.width || 800; h = image.height || 600;
  }
  return { w, h };
}

function setBusy(on, text) {
  let el = document.getElementById('busyOverlay');
  if (on) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'busyOverlay';
      el.className = 'busy-overlay';
      el.innerHTML = `<span class="spinner"></span><span class="busy-text"></span>`;
      canvasWrap.appendChild(el);
    }
    el.querySelector('.busy-text').textContent = text || '处理中…';
    el.style.display = 'flex';
  } else if (el) {
    el.style.display = 'none';
  }
}

function resetAll() {
  stage = 'idle';
  sourceImage = null;
  currentRegions = null;
  currentBlocks = null;
  lastResult = null;
  destroyRegionLayer();
  destroyBlockLayer();
  showRegionActions(false);
  showBlockActions(false);
  showRegionHint('', '');
  resultPanel.style.display = 'none';
  resultLegend.style.display = 'none';
  clearManualOverride();
  qcSection.innerHTML = '';
  setBusy(false);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvasWrap.classList.add('placeholder');
  canvasWrap.innerHTML = '<i class="fas fa-image"></i>';
  canvas.style.display = 'none';
  if (fileInput) fileInput.value = '';
  btnClear && (btnClear.disabled = true);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** 像素 rect → 归一化（相对 locate canvasSize） */
function normRect(r, size) {
  if (!r || !size) return { x: 0, y: 0, w: 0.1, h: 0.1 };
  return { x: r.x / size.width, y: r.y / size.height, w: r.w / size.width, h: r.h / size.height };
}
/** 归一化 → 像素 rect */
function denormRect(r, size) {
  if (!r || !size) return { x: 0, y: 0, w: 10, h: 10 };
  return { x: Math.round(r.x * size.width), y: Math.round(r.y * size.height), w: Math.round(r.w * size.width), h: Math.round(r.h * size.height) };
}

/** 定位失败时的兜底区域（归一化） */
function fallbackRegions(w, h) {
  return {
    cardRect: { x: 0.02, y: 0.15, w: 0.20, h: 0.70 },
    tube: { x: 0.55, y: 0.12, w: 0.35, h: 0.76 },
  };
}

// 上传后启用清空按钮
fileInput?.addEventListener('change', () => { if (btnClear) btnClear.disabled = false; });
