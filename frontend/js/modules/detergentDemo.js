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

import { isEmbedded, postToParent } from '../utils/embed.js';
import { authService } from '../services/AuthService.js';
import {
  recognize, MARKER_DICT, TEMPLATE as OPENCV_TEMPLATE,
  locateRegions, analyzeWithRegions, detectBlocksInRect,
  analyzeDetergentImage, drawOverlay, buildResultHtml, getCv,
} from '../opencv/recognizer.js';

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
let currentMode = 'manual';     // 'manual' | 'template'（前端本地）| 'backend'（服务器排队）

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
init();

function init() {
  // 识别引擎（opencv）加载状态提示
  const cvBadge = document.getElementById('cvStatus');
  getCv().then(() => {
    if (cvBadge) { cvBadge.style.background = '#16a34a'; cvBadge.innerHTML = '<i class="fas fa-check"></i> 识别引擎就绪'; }
  }).catch(() => {
    if (cvBadge) { cvBadge.style.background = '#dc2626'; cvBadge.innerHTML = '<i class="fas fa-times"></i> 识别引擎加载失败'; }
  });

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

    // 兼容多种结果字段：优先 mainValue，其次 refinedValue，最后从 mainValueText 解析
    let val = lastResult.mainValue ?? lastResult.refinedValue;
    if (val === undefined || val === null || String(val) === '') {
      const parsed = parseFloat(lastResult.mainValueText);
      if (!Number.isNaN(parsed)) val = parsed;
    }

    const valueText = lastResult.mainValueText || (val != null ? `${val} mg/L` : '');
    // GB 14934 洗涤剂残留判定：≤0.005 mg/100cm² 合格（与 Tableware.js 保持一致）
    let judge = '';
    if (val != null && !Number.isNaN(Number(val))) {
      judge = Number(val) <= 0.005 ? '合格 (≤0.005)' : '不合格 (>0.005)';
    }

    postToParent({
      value: val != null ? String(val) : '',
      valueText,
      judge,
      detail: lastResult,
    }, 'detergent');
  });

  // 模式切换（前端本地 / 后端排队）
  const modeManual = document.getElementById('modeManual');
  const modeTemplate = document.getElementById('modeTemplate');
  const modeBackend = document.getElementById('modeBackend');
  const backendStatus = document.getElementById('backendStatus');
  const setMode = (m) => {
    currentMode = m;
    modeManual?.classList.toggle('active', m === 'manual');
    modeTemplate?.classList.toggle('active', m === 'template');
    modeBackend?.classList.toggle('active', m === 'backend');
    if (backendStatus) backendStatus.style.display = m === 'backend' ? 'block' : 'none';
    const guide = document.getElementById('btnTemplateGuide');
    if (guide) guide.style.display = (m === 'template' || m === 'backend') ? 'inline-block' : 'none';
    const tip = document.getElementById('modeTip');
    if (tip) {
      if (m === 'template') {
        tip.innerHTML = '<strong>全自动（模板）— 前端：</strong>浏览器本地调用 OpenCV.js 识别，不上传服务器。';
      } else if (m === 'backend') {
        tip.innerHTML = '<strong>全自动（模板）— 后端：</strong>图片上传服务器排队识别，同一时间只处理一个任务。';
      } else {
        tip.innerHTML = '<strong>手动调整：</strong>自动圈出比色卡/样品 → 你确认或拖框矫正 → 再微调 7 个色块 → 识别。';
      }
    }
  };
  modeManual?.addEventListener('click', () => setMode('manual'));
  modeTemplate?.addEventListener('click', () => setMode('template'));
  modeBackend?.addEventListener('click', () => setMode('backend'));
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
      else if (currentMode === 'backend') runBackendStep(img);
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
  const cv = await getCv().catch(() => null);
  if (!cv) { alert('识别引擎尚未就绪，请稍候再试'); return; }
  const synth = await import('../utils/syntheticDetergent.js').catch(() => null);
  if (synth?.generateSyntheticDetergentCanvas) {
    const c = synth.generateSyntheticDetergentCanvas();
    sourceImage = c;
    if (currentMode === 'template') runTemplateStep(c);   // 一键验证 ArUco 模板识别
    else if (currentMode === 'backend') runBackendStep(c); // 后端排队识别
    else runLocateStep(c);                                 // 手动两步流程
  } else {
    console.warn('合成图模块不可用');
  }
}

// ---------------------------------------------------------------------------
// 全自动方案：模板（A4 拍摄指导卡）识别
// ---------------------------------------------------------------------------
async function runTemplateStep(image) {
  await runRecognitionInternal(image, 'browser');
}

async function runBackendStep(image) {
  await runRecognitionInternal(image, 'server');
}

async function runRecognitionInternal(image, source) {
  stage = 'analyzing';
  clearManualOverride();
  resultPanel.style.display = 'none';
  resultLegend.style.display = 'none';
  destroyRegionLayer();
  destroyBlockLayer();
  drawImageToCanvas(image);
  drawWorkCanvas(image);

  let res;
  try {
    if (source === 'server') {
      setBusy(true, '正在上传到服务器排队识别…');
      res = await recognizeBackend(workCanvas);
    } else {
      setBusy(true, '正在按拍摄指导卡定位（OpenCV 角标识别）…');
      const raw = await recognize(workCanvas, { concentrations: CONCENTRATIONS });
      res = adaptOpencvResult(raw, workCanvas);
      res.recognitionSource = 'browser';
    }
  } catch (e) {
    console.error(e);
    res = { ok: false, stage: 'exception', error: 'TEMPLATE_FAIL', humanMessage: (source === 'server' ? '后端识别失败：' : '模板识别失败：') + (e?.message || e) };
  }
  setBusy(false);

  if (!res.ok) {
    console.warn('[detergentDemo] 识别未成功：', res.humanMessage);
    showTemplateFallback(res);
    return;
  }

  stage = 'result';
  lastResult = res;
  if (res.tightCardRect) currentRegions = Object.assign({}, currentRegions, { tightCardRect: normRect(res.tightCardRect, res.canvasSize) });
  drawOverlay(canvas, res, {
    scaleX: canvas.width / res.canvasSize.width,
    scaleY: canvas.height / res.canvasSize.height,
    tightCardRect: res.tightCardRect
      ? { xPx: res.tightCardRect.xPx, yPx: res.tightCardRect.yPx, wPx: res.tightCardRect.wPx, hPx: res.tightCardRect.hPx }
      : null,
  });
  renderResult(res);
  resultPanel.style.display = 'block';
  resultLegend.style.display = 'block';
  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 统一读取有效 token：优先 AuthService 命名空间 token，兼容旧裸 key
function getEffectiveToken() {
  return (typeof authService !== 'undefined' && authService?.getToken && authService.getToken())
    || localStorage.getItem('authToken') || localStorage.getItem('token') || '';
}

// 后端排队识别：上传 base64 → /api/recognize，轮询状态拿到结果
async function recognizeBackend(canvasEl) {
  const apiUrl = (window.API_BASE || '').replace(/\/$/, '') || '';
  let token = getEffectiveToken();

  // token 为空时先尝试静默刷新（access token 30 分钟过期是常态，refresh token 7 天有效）
  if (!token && typeof authService !== 'undefined' && authService?.refreshToken) {
    try {
      const refreshed = await authService.refreshToken();
      if (refreshed.success) token = getEffectiveToken();
    } catch (e) {
      console.warn('[detergentDemo] 静默刷新失败:', e?.message || e);
    }
  }

  if (!token) {
    return { ok: false, stage: 'auth', error: 'NO_TOKEN', humanMessage: '登录已过期，请重新登录后再试。' };
  }

  const dataUrl = canvasEl.toDataURL('image/png');
  setBusy(true, '正在提交到服务器…');

  let jobId;
  try {
    const submit = await fetch(`${apiUrl}/api/recognize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: dataUrl, concentrations: CONCENTRATIONS }),
    });
    if (submit.status === 401) {
      // 提交瞬间 token 过期：再尝试一次刷新
      if (typeof authService !== 'undefined' && authService?.refreshToken) {
        const refreshed = await authService.refreshToken();
        if (refreshed.success) {
          token = getEffectiveToken();
          const retry = await fetch(`${apiUrl}/api/recognize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ image: dataUrl, concentrations: CONCENTRATIONS }),
          });
          const retryJson = await retry.json().catch(() => ({}));
          if (!retry.ok || !retryJson.ok || !retryJson.jobId) {
            return { ok: false, stage: 'submit', error: retryJson.error || retry.status, humanMessage: retryJson.humanMessage || `提交失败：HTTP ${retry.status}` };
          }
          jobId = retryJson.jobId;
        } else {
          return { ok: false, stage: 'auth', error: 'TOKEN_EXPIRED', humanMessage: '登录已过期，请重新登录后再试。' };
        }
      } else {
        return { ok: false, stage: 'auth', error: 'TOKEN_EXPIRED', humanMessage: '登录已过期，请重新登录后再试。' };
      }
    } else {
      const submitJson = await submit.json().catch(() => ({}));
      if (!submit.ok || !submitJson.ok || !submitJson.jobId) {
        return { ok: false, stage: 'submit', error: submitJson.error || submit.status, humanMessage: submitJson.humanMessage || `提交失败：HTTP ${submit.status}` };
      }
      jobId = submitJson.jobId;
    }
  } catch (e) {
    return { ok: false, stage: 'submit', error: 'NETWORK', humanMessage: '提交到服务器失败：' + (e?.message || e) };
  }

  // 轮询，最多 5 分钟
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    setBusy(true, '服务器识别中，请稍候…');
    await new Promise(r => setTimeout(r, 1200));
    try {
      const currentToken = getEffectiveToken() || token;
      const poll = await fetch(`${apiUrl}/api/recognize/status/${jobId}`, {
        headers: { Authorization: `Bearer ${currentToken}` },
      });
      if (poll.status === 401) {
        if (typeof authService !== 'undefined' && authService?.refreshToken) {
          const refreshed = await authService.refreshToken();
          if (refreshed.success) token = getEffectiveToken();
          else return { ok: false, stage: 'auth', error: 'TOKEN_EXPIRED', humanMessage: '登录已过期，请重新登录后再试。' };
        } else {
          return { ok: false, stage: 'auth', error: 'TOKEN_EXPIRED', humanMessage: '登录已过期，请重新登录后再试。' };
        }
        continue;
      }
      const pollJson = await poll.json().catch(() => ({}));
      if (!poll.ok) continue;

      if (pollJson.status === 'queued') {
        setBusy(true, `排队中，前方还有 ${pollJson.position || 0} 个任务…`);
        continue;
      }
      if (pollJson.status === 'processing') {
        setBusy(true, '服务器正在识别…');
        continue;
      }
      if (pollJson.status === 'done' && pollJson.result) {
        const adapted = adaptOpencvResult(pollJson.result, canvasEl);
        adapted.recognitionSource = 'server';
        return adapted;
      }
      if (pollJson.status === 'failed') {
        return { ok: false, stage: 'failed', error: pollJson.error, humanMessage: pollJson.humanMessage || '服务器识别失败' };
      }
    } catch (e) {
      console.warn('[recognizeBackend] 轮询异常', e);
    }
  }
  return { ok: false, stage: 'timeout', error: 'TIMEOUT', humanMessage: '后端识别超时（>5分钟），请重试。' };
}

// 把 opencv recognizer 的结果适配为旧 renderResult 期望的格式
function adaptOpencvResult(raw, canvasEl) {
  if (!raw || !raw.ok) {
    return { ok: false, humanMessage: raw?.humanMessage || '识别失败', stage: raw?.stage || 'unknown' };
  }
  const W = canvasEl.width, H = canvasEl.height;
  const { cardSlot, tubeSlot } = OPENCV_TEMPLATE;
  // 取色块/样品框（像素）
  const tube = {
    x: Math.round(tubeSlot.x * W), y: Math.round(tubeSlot.y * H),
    w: Math.round(tubeSlot.w * W), h: Math.round(tubeSlot.h * H), zone: 'tube'
  };
  const sampleLab = raw.sampleLab || { L: 0, a: 0, b: 0 };
  const sampleColor = labToRgb(sampleLab);
  const blocks = (raw.blocks || []).map((b) => ({
    concentration: b.concentration,
    color: labToRgb(b.lab),
    lab: b.lab,
  }));
  const qc = {
    ok: !raw.anomalySuspected,
    notes: raw.anomalySuspected ? [{ level: 'warn', text: '色差偏大，建议复核样品摆放与光照' }] : []
  };
  return {
    ok: true,
    canvasSize: { width: W, height: H },
    mainValue: raw.mainValue,
    refinedValue: raw.mainValue,
    mainValueText: raw.mainValueText,
    deltaE: raw.deltaE,
    confidence: raw.confidence,
    sampleColor, sampleLab, tube, tubeZone: 'tube',
    blocks, qc,
    sortedDistances: (raw.sortedDistances || []).map((d) => ({
      concentration: d.concentration, deltaE: d.deltaE,
      color: labToRgb(d.lab || { L: 0, a: 0, b: 0 })
    })),
  };
}

// Lab(OpenCV: L 0-255, a/b 已减128) -> RGB 0-255
function labToRgb(lab) {
  const L = (lab.L / 255) * 100;
  const a = lab.a;
  const b = lab.b;
  let y = (L + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;
  const f = (t) => (t ** 3 > 0.008856) ? t ** 3 : (t - 16 / 116) / 7.787;
  const yr = f(y) * 100, xr = f(x), zr = f(z);
  // D65 参考白
  let R = xr * 3.2406 - f(y) * 1.5372 - f(z) * 0.4986;
  let G = xr * -0.9689 + f(y) * 1.8758 + f(z) * 0.0415;
  let B = xr * 0.0557 - f(y) * 0.2040 + f(z) * 1.0570;
  const gamma = (c) => (c > 0.0031308) ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
  R = Math.max(0, Math.min(1, gamma(R))) * 255;
  G = Math.max(0, Math.min(1, gamma(G))) * 255;
  B = Math.max(0, Math.min(1, gamma(B))) * 255;
  return [Math.round(R), Math.round(G), Math.round(B)];
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
async function showTemplateGuide() {
  const SCALE = 2;                 // 2× DPI，让矩阵小标像素翻倍可生成清晰 ArUco
  const w = 794 * SCALE, h = 1123 * SCALE; // A4 @192dpi
  const g = document.createElement('canvas');
  g.width = w; g.height = h;
  const c = g.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);

  const D = OPENCV_TEMPLATE;
  const px = (nx) => Math.round(nx * w);
  const py = (ny) => Math.round(ny * h);

  // 等待 opencv 就绪（vendor/opencv/opencv.js 挂 window.cv，可能是 promise-like）
  const cv = await getCv();

  // 文本自动换行工具
  function wrapText(text, x, y, maxWidth, lineHeight) {
    const words = text.split('');
    let line = '';
    const lines = [];
    for (let i = 0; i < words.length; i++) {
      const testLine = line + words[i];
      const metrics = c.measureText(testLine);
      if (metrics.width > maxWidth && line.length > 0) {
        lines.push(line);
        line = words[i];
      } else {
        line = testLine;
      }
    }
    lines.push(line);
    lines.forEach((l, idx) => c.fillText(l, x, y + idx * lineHeight));
    return lines.length;
  }

  // 将灰度 ArUco Mat 安全绘制到临时 canvas（绕开 cv.imshow 的不可靠行为）
  function matToCanvas(m) {
    const tmp = document.createElement('canvas');
    tmp.width = m.cols; tmp.height = m.rows;
    const tctx = tmp.getContext('2d');
    const img = tctx.createImageData(m.cols, m.rows);
    const d = m.data; // CV_8UC1
    for (let i = 0; i < d.length; i++) {
      const v = d[i]; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    return tmp;
  }

  // 画 ArUco 定位标（MIP_36h12，与算法同一字典）：生成 marker -> 加静区 -> drawImage
  function drawAruco(cx, cy, cell, markerId) {
    // marker 图案占 cell 的 72%，四周保留白色静区；最小边长保护避免 opencv 抛错
    const cellI = Math.max(16, Math.round(cell));
    const mkSize = Math.max(20, Math.round(cellI * 0.72)); // 最小 20px 保证可被检测
    const pad = Math.max(1, Math.round((cellI - mkSize) / 2));
    try {
      if (cv && cv.Mat && cv.generateImageMarker) {
        const m = new cv.Mat(); // 空 Mat，让 opencv 自行分配正确尺寸
        cv.generateImageMarker(cv.getPredefinedDictionary(cv[MARKER_DICT]), markerId, mkSize, m, 1);
        const off = matToCanvas(m);
        m.delete();
        // 静区白底 + 绘制
        c.fillStyle = '#fff'; c.fillRect(cx - cellI / 2, cy - cellI / 2, cellI, cellI);
        c.drawImage(off, cx - cellI / 2 + pad, cy - cellI / 2 + pad);
      } else {
        // opencv 未就绪兜底：白底黑方块（仍保留静区）
        c.fillStyle = '#fff'; c.fillRect(cx - cellI / 2, cy - cellI / 2, cellI, cellI);
        c.fillStyle = '#000'; c.fillRect(cx - cellI / 2 + pad, cy - cellI / 2 + pad, mkSize, mkSize);
      }
    } catch (err) {
      // 极端情况下（标过小或 opencv 异常）兜底为可见黑方块，保证打印卡可出
      console.warn('drawAruco failed id=' + markerId, err);
      c.fillStyle = '#fff'; c.fillRect(cx - cellI / 2, cy - cellI / 2, cellI, cellI);
      c.fillStyle = '#000'; c.fillRect(cx - cellI / 2 + pad, cy - cellI / 2 + pad, mkSize, mkSize);
    }
  }

  // ===== 1. 顶部标题栏 + 方向标识（居中，避开四角定位标）=====
  c.textAlign = 'center';
  c.fillStyle = '#111'; c.font = `bold ${32 * SCALE}px sans-serif`;
  c.fillText('阴离子洗涤剂残留 · 标准拍摄指导卡', w / 2, py(0.035));
  c.font = `bold ${20 * SCALE}px sans-serif`; c.fillStyle = '#dc2626';
  c.fillText('↑ 此边朝上 · 勿倒置拍摄', w / 2, py(0.072));

  // ===== 2. 离心管摆放提示（文字放在矩阵区域上方，不进入识别矩阵）=====
  c.fillStyle = '#dc2626'; c.font = `bold ${24 * SCALE}px sans-serif`; c.textAlign = 'center';
  // tubeGrid 实际矩阵区域 y 范围约为 [y+inset*h, y+(1-inset)*h]，文字放在矩阵上方留白处
  c.fillText('离心管竖放于此', px(0.5), py(D.tubeGrid.y) - 14 * SCALE);

  // ===== 3. 比色卡摆放提示（文字放在矩阵区域上方，不进入识别矩阵）=====
  c.fillStyle = '#2563eb'; c.font = `bold ${24 * SCALE}px sans-serif`; c.textAlign = 'center';
  c.fillText('比色卡横放于此', px(0.5), py(D.cardGrid.y) - 14 * SCALE);

  // ===== 4. 四角 ArUco 定位标（算法用，图案保持干净，不印任何文字）=====
  // 参考常见 ArUco 打印页做法：marker 图案本身不带文字说明，统一在底部操作说明中提示。
  const fm = D.markers;
  const cellPx = Math.round(0.14 * w); // 角标占位（含静区）约 14% 页宽，识别更稳定
  const markers = [
    { role: 'TL', p: fm.TL, id: 0 }, { role: 'TR', p: fm.TR, id: 1 },
    { role: 'BL', p: fm.BL, id: 2 }, { role: 'BR', p: fm.BR, id: 3 },
  ];
  for (const mk of markers) {
    drawAruco(px(mk.p.x), py(mk.p.y), cellPx, mk.id);
  }

  // ===== 4.5 方形定位标识矩阵（fiducial grid）：铺在红/蓝框内 =====
  //   比色卡区 5×6、样品区 4×5，id 段与算法一致（100+ / 200+）。
  //   实物放上会遮住部分标，算法靠露出的标反推物体真实位置/旋转。
  const drawGrid = (slot, grid, color) => {
    const ins = grid.inset;
    const x0 = px(slot.x + slot.w * ins), x1 = px(slot.x + slot.w * (1 - ins));
    const y0 = py(slot.y + slot.h * ins), y1 = py(slot.y + slot.h * (1 - ins));
    const gcell = Math.min((x1 - x0) / (grid.cols - 1), (y1 - y0) / (grid.rows - 1));
    const gs = Math.max(40, Math.round(gcell * 0.66)); // 小标最小 40px（2x DPI 下），保证 opencv 生成清晰可识别码
    const gpad = Math.max(1, Math.round((gcell - gs) / 2));
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const gx = x0 + (grid.cols === 1 ? (x1 - x0) / 2 : (x1 - x0) * (c / (grid.cols - 1)));
        const gy = y0 + (grid.rows === 1 ? (y1 - y0) / 2 : (y1 - y0) * (r / (grid.rows - 1)));
        const id = grid.baseId + r * grid.cols + c;
        drawAruco(gx, gy, gs + gpad * 2, id);
      }
    }
  };
  // 矩阵铺在 *Grid 大区域（比放置提示框 *Slot 四周外扩），实物放 *Slot 内只盖中央，外围标露出
  drawGrid(D.cardGrid, D.cardGrid, '#2563eb');
  drawGrid(D.tubeGrid, D.tubeGrid, '#dc2626');

  // ===== 5. 底部操作说明 =====
  const noteY = py(0.95);
  c.textAlign = 'left'; c.fillStyle = '#111'; c.font = `bold ${18 * SCALE}px sans-serif`;
  c.fillText('操作说明', px(0.06), noteY);
  c.font = `${15 * SCALE}px sans-serif`; c.fillStyle = '#333';
  const tips = [
    '① 打印本卡（建议 A4 彩色/卡纸），平铺于纯色桌面，避免黑色背景。',
    '② 四角黑白方块为 ArUco 定位标，打印后请勿遮挡、涂改、折叠或覆盖。',
    '③ 比色卡/离心管四周的细小黑白方块是定位矩阵，算法靠露出的方块定位物体，比色卡/离心管放入对应文字提示的矩阵区域内即可（无需盖满矩阵）。',
    '④ 比色卡横放于下方矩阵区、离心管竖放于上方矩阵区，与各自矩阵区大致居中（文字仅为放置提示，识别由四周矩阵完成）。',
    '⑤ 手机垂直俯拍，光照均匀，四角定位标完整入镜、不反光、不遮挡。',
    '⑥ 上传照片后选「全自动（模板）」模式，系统自动定位并比色。',
  ];
  let y = noteY + 26 * SCALE;
  for (const t of tips) {
    const lines = wrapText(t, px(0.06), y, px(0.88), 22 * SCALE);
    y += lines * 22 * SCALE + 6 * SCALE;
  }

  const url = g.toDataURL('image/png');
  const win = window.open('', '_blank');
  if (!win) { alert('预览被浏览器拦截，请允许弹出窗口'); return; }
  win.document.write(`<html><head><title>拍摄指导卡</title>
    <style>
      @page { size: A4; margin: 0; }
      html, body { margin: 0; padding: 0; }
      img { display: block; width: 210mm; height: 297mm; }
      .bar { position: fixed; left: 0; right: 0; bottom: 0; text-align: center;
             padding: 10px 0; background: #fff; border-top: 1px solid #ddd; }
      .bar button { padding: 12px 24px; font-size: 16px; }
      @media print { .bar { display: none; } }
    </style></head><body>
    <img src="${url}">
    <div class="bar"><button onclick="window.print()">打印此 A4 指导卡（请选「实际大小/100%」，勿缩放）</button></div>
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
    loc = await locateRegions(workCanvas, { concentrations: CONCENTRATIONS });
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
    tightCardRect: loc.tightCardRect ? normRect(loc.tightCardRect, loc.canvasSize) : null,
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
    const cardRect = currentRegions?.cardRect
      ? denormRect(currentRegions.cardRect, locateCanvasSize)
      : null;
    const tight = currentRegions?.tightCardRect
      ? denormRect(currentRegions.tightCardRect, locateCanvasSize)
      : null;
    drawOverlay(canvas, res, {
      scaleX: canvas.width / res.canvasSize.width,
      scaleY: canvas.height / res.canvasSize.height,
      cardRect,
      tightCardRect: tight
        ? { xPx: Math.round(tight.x * res.canvasSize.width), yPx: Math.round(tight.y * res.canvasSize.height),
            wPx: Math.round(tight.w * res.canvasSize.width), hPx: Math.round(tight.h * res.canvasSize.height) }
        : null,
    });
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

  const sourceEl = document.getElementById('resultSource');
  const sourceText = document.getElementById('resultSourceText');
  if (sourceEl && sourceText) {
    const src = result.recognitionSource || 'browser';
    sourceText.innerHTML = src === 'server'
      ? '<span class="badge" style="background:#2563eb;color:#fff;padding:2px 8px;border-radius:4px;"><i class="fas fa-server"></i> 后端服务器识别</span>'
      : '<span class="badge" style="background:#16a34a;color:#fff;padding:2px 8px;border-radius:4px;"><i class="fas fa-laptop"></i> 浏览器本地识别</span>';
    sourceEl.style.display = 'block';
  }

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
