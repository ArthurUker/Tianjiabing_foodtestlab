// js/opencv/recognizer.js
//
// 洗涤剂比色识别 · 共享识别核心（前后端统一 opencv 方案）
// ----------------------------------------------------------------------------
// 设计原则（依据已确认决策）：
//   - 前后端使用同一套算法：角标用 ArUco DICT_ARUCO_MIP_36（强纠错），
//     单应校正到标准模板，7 色块 + 样品区取 Lab，ΔE2000 比色。
//   - cv 来源适配两种环境：
//       浏览器：UMD 挂载 window.cv（vendor/opencv/opencv.js）
//       Node：import cv from '@techstark/opencv-js'
//   - 旧的自研 3 环角标 + ΔE76 已废弃，本文件为唯一识别实现。
//
// 暴露：
//   getCv()             -> Promise<cv>，等待 opencv 运行时就绪
//   recognize(img, opts)-> Promise<result>，img 为 canvas / ImageData / 文件路径(仅Node)
//   MARKER_DICT         -> 字典常量名
//   CONCENTRATIONS      -> 默认浓度序列
// ============================================================================

export const MARKER_DICT = 'DICT_ARUCO_MIP_36';
export const CONCENTRATIONS = [0, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0];

// 标准模板归一化坐标（与旧 TEMPLATE_DESIGN 一致，原点=卡片左上，1.0=整卡宽/高）
export const TEMPLATE = {
  // 四个角标中心点（归一化）
  markers: {
    TL: { x: 0.13, y: 0.13 },
    TR: { x: 0.87, y: 0.13 },
    BL: { x: 0.13, y: 0.87 },
    BR: { x: 0.87, y: 0.87 },
  },
  // 比色卡与离心管上下分开，避免拍摄指导卡重叠，同时给单应校正后采样留出清晰区域
  tubeSlot: { x: 0.40, y: 0.18, w: 0.20, h: 0.22 }, // 离心管区（上方，竖放）
  // 比色卡区：真实比色卡 89mm × 52mm（宽×高，纵横比 ≈1.71:1）。
  // 相对整张 A4 拍摄卡（210×297mm）：宽 89/210≈0.424，高 52/297≈0.175；
  // 下方居中摆放（x 居中、y 取 0.52 处），标记框精确等于真实比色卡尺寸。
  cardSlot: { x: 0.288, y: 0.52, w: 0.424, h: 0.175 },
  blockCount: 7,
};

// ----------------------------------------------------------------------------
// cv 加载适配（依赖注入：后端注入 cv，浏览器读 window.cv）
// ----------------------------------------------------------------------------
let _injectedCv = null;
let _cvPromise = null;

// 后端调用方（Worker）在 opencv 加载后注入，避免共享文件硬依赖 npm 包路径
export function setCv(cv) {
  _injectedCv = cv;
  _cvPromise = Promise.resolve(cv);
}

export function getCv() {
  if (_cvPromise) return _cvPromise;
  _cvPromise = new Promise((resolve, reject) => {
    // 浏览器：vendor/opencv/opencv.js 挂到 window.cv（UMD）
    const src = (typeof window !== 'undefined' && window.cv) ? window.cv : null;
    if (src) {
      if (src.Mat) return resolve(src);
      // @techstark/opencv-js 浏览器 UMD 可能是 promise-like（window.cv.then）
      if (typeof src.then === 'function') { src.then((cv) => resolve(cv)); return; }
      if (src.onRuntimeInitialized) {
        src.onRuntimeInitialized = () => resolve(src);
      } else {
        const t = setInterval(() => {
          if (src.Mat) { clearInterval(t); resolve(src); }
        }, 50);
        setTimeout(() => { clearInterval(t); reject(new Error('opencv 初始化超时')); }, 30000);
      }
      return;
    }
    // 已注入（后端）
    if (_injectedCv) return resolve(_injectedCv);
    reject(new Error('未找到 opencv（window.cv 不存在且未注入 cv）'));
  });
  return _cvPromise;
}

// ----------------------------------------------------------------------------
// 角标检测：返回 4 个角标的归一化坐标（相对原图尺寸）
// ----------------------------------------------------------------------------
async function detectMarkersNormalized(cv, mat, width, height) {
  const gray = new cv.Mat();
  if (mat.channels() === 3) cv.cvtColor(mat, gray, cv.COLOR_RGB2GRAY);
  else if (mat.channels() === 4) cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  else mat.copyTo(gray);

  const dict = cv.getPredefinedDictionary(cv[MARKER_DICT]);
  const detectorParams = new cv.aruco_DetectorParameters();
  const refineParams = new cv.aruco_RefineParameters(10, 3.0, true);
  const detector = new cv.aruco_ArucoDetector(dict, detectorParams, refineParams);

  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rejected = new cv.MatVector();
  detector.detectMarkers(gray, corners, ids, rejected);

  const found = [];
  const idCount = (ids && ids.total && ids.total() > 0) ? ids.total() : 0;
  if (idCount > 0) {
    for (let i = 0; i < idCount; i++) {
      const c = corners.get(i); // 4x2 角点
      // 计算中心
      let cx = 0, cy = 0;
      for (let k = 0; k < 4; k++) {
        cx += c.data32F[k * 2];
        cy += c.data32F[k * 2 + 1];
      }
      cx /= 4; cy /= 4;
      found.push({ id: ids.data32S[i], cx: cx / width, cy: cy / height, corners: c });
    }
  }
  gray.delete(); dict.delete(); detectorParams.delete(); refineParams.delete();
  detector.delete(); corners.delete(); ids.delete(); rejected.delete();
  return found;
}

// 把检测到的 4 个角标按位置判定 TL/TR/BL/BR（不再靠尺寸 hack）
function assignMarkerRoles(markers) {
  if (markers.length < 4) return null;
  // 取面积/置信最靠四角的 4 个；按中心点分象限
  const cxAvg = markers.reduce((s, m) => s + m.cx, 0) / markers.length;
  const cyAvg = markers.reduce((s, m) => s + m.cy, 0) / markers.length;
  const roleOf = (m) => {
    const top = m.cy < cyAvg;
    const left = m.cx < cxAvg;
    return (top ? (left ? 'TL' : 'TR') : (left ? 'BL' : 'BR'));
  };
  const roles = {};
  for (const m of markers) {
    const r = roleOf(m);
    // 若冲突（同角色多个），保留更靠近该角的
    if (!roles[r] || distToCorner(m, r) < distToCorner(roles[r], r)) roles[r] = m;
  }
  return (roles.TL && roles.TR && roles.BL && roles.BR) ? roles : null;
}

function distToCorner(m, role) {
  const tx = role === 'TL' || role === 'BL' ? 0.1 : 0.9;
  const ty = role === 'TL' || role === 'TR' ? 0.09 : 0.91;
  return Math.hypot(m.cx - tx, m.cy - ty);
}

// ----------------------------------------------------------------------------
// 单应校正：用 4 角标把原图 warp 到标准正视图
// ----------------------------------------------------------------------------
function buildHomography(cv, roles, width, height) {
  const src = [], dst = [];
  for (const role of ['TL', 'TR', 'BR', 'BL']) {
    const m = roles[role];
    src.push(new cv.Point(m.cx * width, m.cy * height));
    const t = TEMPLATE.markers[role];
    dst.push(new cv.Point(t.x * width, t.y * height));
  }
  const srcMat = cv.matFromArray(4, 1, cv.CV_32FC2, src.flatMap(p => [p.x, p.y]));
  const dstMat = cv.matFromArray(4, 1, cv.CV_32FC2, dst.flatMap(p => [p.x, p.y]));
  const H = cv.getPerspectiveTransform(srcMat, dstMat);
  srcMat.delete(); dstMat.delete();
  return H;
}

// 把归一化矩形映射到裁剪后图像坐标并取平均 Lab
function sampleAvgLab(cv, warped, rectNorm, width, height) {
  const x = Math.round(rectNorm.x * width);
  const y = Math.round(rectNorm.y * height);
  const w = Math.round(rectNorm.w * width);
  const h = Math.round(rectNorm.h * height);
  const roi = warped.roi(new cv.Rect(x, y, Math.max(1, w), Math.max(1, h)));
  const lab = new cv.Mat();
  const rgb = new cv.Mat();
  cv.cvtColor(roi, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  // 取中位数（比均值更抗噪）
  const data = lab.data; // Uint8: L,a,b 各通道
  const n = lab.rows * lab.cols;
  const ch = [ [], [], [] ];
  for (let i = 0; i < data.length; i += 3) {
    ch[0].push(data[i]); ch[1].push(data[i + 1]); ch[2].push(data[i + 2]);
  }
  ch.forEach(arr => arr.sort((a, b) => a - b));
  const med = (arr) => arr.length ? arr[Math.floor(arr.length / 2)] : 0;
  roi.delete(); lab.delete(); rgb.delete();
  return { L: med(ch[0]), a: med(ch[1]) - 128, b: med(ch[2]) - 128 };
}

// ΔE2000（CIEDE2000）实现
function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = [lab1.L, lab1.a, lab1.b];
  const [L2, a2, b2] = [lab2.L, lab2.a, lab2.b];
  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * 180 / Math.PI + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) * 180 / Math.PI + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = h2p - h1p;
  if (C1p * C2p !== 0) {
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  } else dhp = 0;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * Math.PI / 180 / 2);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  const Hbarp = (Math.abs(h1p - h2p) <= 180) ? (h1p + h2p) / 2
    : (h1p + h2p < 360) ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  const T = 1 - 0.17 * Math.cos((Hbarp - 30) * Math.PI / 180)
    + 0.24 * Math.cos(2 * Hbarp * Math.PI / 180)
    + 0.32 * Math.cos((3 * Hbarp + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * Hbarp - 63) * Math.PI / 180);
  const dTheta = 30 * Math.exp(-Math.pow((Hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * Math.PI / 180) * Rc;
  const dE = Math.sqrt(
    Math.pow(dLp / (kL * Sl), 2) +
    Math.pow(dCp / (kC * Sc), 2) +
    Math.pow(dHp / (kH * Sh), 2) +
    Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh))
  );
  return dE;
}

// ----------------------------------------------------------------------------
// 实测色卡精框：在 cardSlot 大框 ROI 内找真实比色卡的最小包围盒（显示用）
//   思路：把 ROI 转 HSV，对饱和度通道做"逐列积分"找左右边界、"逐行积分"找上下边界，
//   再按真实比色卡合理纵横比（宽:高 ≈ 1.71:1，即 89mm × 52mm）裁剪，避免把桌面/空白也圈进去。
// ----------------------------------------------------------------------------
function findTightColorCard(cv, warped, cardSlotNorm, width, height) {
  const x = Math.round(cardSlotNorm.x * width);
  const y = Math.round(cardSlotNorm.y * height);
  const w = Math.max(1, Math.round(cardSlotNorm.w * width));
  const h = Math.max(1, Math.round(cardSlotNorm.h * height));
  const roi = warped.roi(new cv.Rect(x, y, w, h));

  const hsv = new cv.Mat();
  cv.cvtColor(roi, hsv, cv.COLOR_RGBA2RGB);   // warped 是 RGBA
  cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
  const s = new cv.Mat();
  cv.extractChannel(hsv, s, 1); // 1 = S 通道

  const rows = s.rows, cols = s.cols;
  const colSum = new Array(cols).fill(0);
  const rowSum = new Array(rows).fill(0);
  const sd = s.data; // Uint8 单通道
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = sd[r * cols + c];
      colSum[c] += v;
      rowSum[r] += v;
    }
  }
  hsv.delete(); s.delete();

  // 列积分阈值（相对峰值）
  const maxCol = Math.max(...colSum, 1);
  const colThr = maxCol * 0.18;
  let left = -1, right = -1;
  for (let c = 0; c < cols; c++) { if (colSum[c] > colThr) { left = c; break; } }
  for (let c = cols - 1; c >= 0; c--) { if (colSum[c] > colThr) { right = c; break; } }
  // 行积分阈值
  const maxRow = Math.max(...rowSum, 1);
  const rowThr = maxRow * 0.18;
  let top = -1, bot = -1;
  for (let r = 0; r < rows; r++) { if (rowSum[r] > rowThr) { top = r; break; } }
  for (let r = rows - 1; r >= 0; r--) { if (rowSum[r] > rowThr) { bot = r; break; } }

  roi.delete();

  // 兜底：找不到明显色块列则退回大框
  if (left < 0 || right < 0 || top < 0 || bot < 0 || right - left < cols * 0.1 || bot - top < rows * 0.1) {
    return { x: cardSlotNorm.x, y: cardSlotNorm.y, w: cardSlotNorm.w, h: cardSlotNorm.h };
  }

  // 按真实比色卡合理纵横比（宽:高 ≈ 1.71:1，89mm×52mm）对称裁剪，避免把空白边圈进
  let tW = right - left + 1, tH = bot - top + 1;
  const aspect = 1.71;
  if (tW / tH > aspect * 1.6) {
    // 太宽：以高度为准收窄宽度
    const wantW = Math.round(tH * aspect);
    const cxMid = left + (right - left) / 2;
    left = Math.max(0, Math.round(cxMid - wantW / 2));
    right = Math.min(cols - 1, left + wantW);
    tW = right - left + 1;
  } else if (tH / tW > 1 / aspect * 1.6) {
    // 太高：以宽度为准压低高度
    const wantH = Math.round(tW / aspect);
    const cyMid = top + (bot - top) / 2;
    top = Math.max(0, Math.round(cyMid - wantH / 2));
    bot = Math.min(rows - 1, top + wantH);
    tH = bot - top + 1;
  }

  // 归一化（相对整图）
  return {
    x: (x + left) / width,
    y: (y + top) / height,
    w: tW / width,
    h: tH / height,
  };
}

// ----------------------------------------------------------------------------
// 主识别
// ----------------------------------------------------------------------------
export async function recognize(img, options = {}) {
  const cv = await getCv();
  const concentrations = options.concentrations || CONCENTRATIONS;

  // 1) 解码为 Mat（canvas/ImageData 先做 ≤1600px 压缩兜底，避免大图拖慢检测/爆内存）
  let mat, width, height, _compressed = null;
  if (img instanceof cv.Mat) {
    mat = img; width = mat.cols; height = mat.rows;
  } else if (typeof ImageData !== 'undefined' && img instanceof ImageData) {
    _compressed = await resizeToMaxEdge(img, 1600);
    if (_compressed instanceof cv.Mat) { mat = _compressed; width = mat.cols; height = mat.rows; }
    else { mat = cv.matFromArray(img.height, img.width, cv.CV_8UC4, new Uint8Array(img.data.buffer)); width = img.width; height = img.height; }
  } else if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
    _compressed = await resizeToMaxEdge(img, 1600);
    if (_compressed instanceof cv.Mat) { mat = _compressed; width = mat.cols; height = mat.rows; }
    else { const id = img.getContext('2d').getImageData(0, 0, img.width, img.height); mat = cv.matFromArray(id.height, id.width, cv.CV_8UC4, new Uint8Array(id.data.buffer)); width = img.width; height = img.height; }
  } else {
    throw new Error('recognize 只接受 cv.Mat / ImageData / HTMLCanvasElement（字符串路径已移除，请先解码为像素）');
  }

  try {
    // 2) 角标检测
    const markers = await detectMarkersNormalized(cv, mat, width, height);
    if (markers.length < 4) {
      return { ok: false, stage: 'markers', error: 'marker_count',
        humanMessage: `只检测到 ${markers.length} 个定位角标（需 4 个），请确认四角 ArUco 标未被遮挡或拍全`,
        found: markers.length };
    }
    const roles = assignMarkerRoles(markers);
    if (!roles) {
      return { ok: false, stage: 'markers', error: 'marker_roles',
        humanMessage: '4 个角标位置异常，无法判定四角，请重新摆正拍摄',
        found: markers.length };
    }

    // 3) 单应校正到标准正视图
    const H = buildHomography(cv, roles, width, height);
    const warped = new cv.Mat();
    cv.warpPerspective(mat, warped, H, new cv.Size(width, height));
    H.delete();

    // 4) 取色：7 色块 + 样品区（均在标准模板归一化坐标内）
    const cardLab = [];
    const { x: cx, y: cy, w: cw, h: ch } = TEMPLATE.cardSlot;
    const blockW = cw / TEMPLATE.blockCount;
    for (let i = 0; i < TEMPLATE.blockCount; i++) {
      cardLab.push(sampleAvgLab(cv, warped,
        { x: cx + i * blockW + blockW * 0.15, y: cy + ch * 0.15, w: blockW * 0.7, h: ch * 0.7 }, width, height));
    }
    const tubeLab = sampleAvgLab(cv, warped, TEMPLATE.tubeSlot, width, height);

    // 5) 比色：样品到 7 色块最近 ΔE2000
    const dists = cardLab.map((lab, i) => ({
      blockIdx: i, concentration: concentrations[i], lab,
      deltaE: deltaE2000(tubeLab, lab),
    })).sort((a, b) => a.deltaE - b.deltaE);
    const main = dists[0];

    let confidence = 0;
    if (main.deltaE <= 3) confidence = 0.95;
    else if (main.deltaE <= 6) confidence = 0.85;
    else if (main.deltaE <= 12) confidence = 0.65;
    else if (main.deltaE <= 18) confidence = 0.45;
    else confidence = 0.30;

    // 4.5) 在 cardSlot 大框内计算「真实色卡最小包围盒」精框（仅用于显示对齐，不参与比色）
    // 必须在使用 warped 之前调用，避免在 warped.delete() 之后误用已释放的 Mat。
    let tightCardNorm = null;
    try {
      tightCardNorm = findTightColorCard(cv, warped, TEMPLATE.cardSlot, width, height);
    } catch (e) { console.warn('findTightColorCard failed', e); }

    warped.delete();

    return {
      ok: true,
      mainValue: main.concentration,
      mainValueText: formatConc(main.concentration),
      deltaE: Number(main.deltaE.toFixed(2)),
      confidence: Number(confidence.toFixed(2)),
      sampleLab: tubeLab,
      blocks: cardLab.map((lab, i) => ({ concentration: concentrations[i], lab })),
      tightCardRect: tightCardNorm
        ? { x: tightCardNorm.x, y: tightCardNorm.y, w: tightCardNorm.w, h: tightCardNorm.h,
            xPx: Math.round(tightCardNorm.x * width), yPx: Math.round(tightCardNorm.y * height),
            wPx: Math.round(tightCardNorm.w * width), hPx: Math.round(tightCardNorm.h * height) }
        : null,
      sortedDistances: dists.map(d => ({
        concentration: d.concentration, deltaE: Number(d.deltaE.toFixed(2)), lab: d.lab,
      })),
      anomalySuspected: main.deltaE > 18,
      markerCount: markers.length,
      canvasSize: { width, height },
    };
  } finally {
    if (!(img instanceof cv.Mat)) mat.delete();
  }
}

function formatConc(v) {
  if (v === 0) return '0';
  if (v < 0.1) return v.toFixed(2);
  return v.toString();
}

// ----------------------------------------------------------------------------
// 手动模式兼容 API（迁移自旧 detergentColorimetry.js，统一走 opencv 方案）
//   前端「手动调整」流程：先自动定位 → 用户拖框纠正 → 微调色块 → 比色。
//   这里提供与旧接口同名的函数，底层改用 ArUco 单应校正 + ΔE2000。
// ----------------------------------------------------------------------------

// 把任意输入画布/图压缩到 maxEdge 以内（默认 1600），避免大图爆内存/拖慢检测
export async function resizeToMaxEdge(img, maxEdge = 1600) {
  const cv = await getCv();
  let srcMat, width, height;
  if (img instanceof cv.Mat) {
    srcMat = img; width = img.cols; height = img.rows;
  } else if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
    const id = img.getContext('2d').getImageData(0, 0, img.width, img.height);
    srcMat = cv.matFromArray(id.height, id.width, cv.CV_8UC4, new Uint8Array(id.data.buffer));
    width = img.width; height = img.height;
  } else if (typeof ImageData !== 'undefined' && img instanceof ImageData) {
    srcMat = cv.matFromArray(img.height, img.width, cv.CV_8UC4, new Uint8Array(img.data.buffer));
    width = img.width; height = img.height;
  } else {
    return img; // 不支持的类型原样返回
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) {
    if (!(img instanceof cv.Mat)) srcMat.delete();
    return img;
  }
  const scale = maxEdge / longEdge;
  const dstW = Math.round(width * scale), dstH = Math.round(height * scale);
  const out = new cv.Mat();
  cv.resize(srcMat, out, new cv.Size(dstW, dstH), 0, 0, cv.INTER_AREA);
  if (!(img instanceof cv.Mat)) srcMat.delete();
  return out; // cv.Mat（调用方负责 delete）
}

// 自动定位：返回归一化 cardRect / tube（含四角 fallback 时返回 ok:false）
export async function locateRegions(img, options = {}) {
  const concentrations = options.concentrations || CONCENTRATIONS;
  const cv = await getCv();
  let mat, width, height;
  if (img instanceof cv.Mat) { mat = img; width = mat.cols; height = mat.rows; }
  else if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
    const id = img.getContext('2d').getImageData(0, 0, img.width, img.height);
    mat = cv.matFromArray(id.height, id.width, cv.CV_8UC4, new Uint8Array(id.data.buffer));
    width = img.width; height = img.height;
  } else {
    throw new Error('locateRegions 仅支持 canvas');
  }
  try {
    const markers = await detectMarkersNormalized(cv, mat, width, height);
    if (markers.length >= 4) {
      const roles = assignMarkerRoles(markers);
      if (roles) {
        const cardRectPx = px(TEMPLATE.cardSlot, width, height);
        let tightCardPx = null;
        try {
          const tightNorm = findTightColorCard(cv, mat, TEMPLATE.cardSlot, width, height);
          tightCardPx = { x: Math.round(tightNorm.x * width), y: Math.round(tightNorm.y * height),
            w: Math.round(tightNorm.w * width), h: Math.round(tightNorm.h * height) };
        } catch (e) { console.warn('locateRegions tightCard failed', e); }
        return {
          ok: true, canvasSize: { width, height },
          cardRect: cardRectPx,
          tightCardRect: tightCardPx,
          tube: px(TEMPLATE.tubeSlot, width, height),
          blocks: inferBlocks(regionsPx(TEMPLATE.cardSlot, width, height), concentrations.length, false),
        };
      }
    }
    // 模板定位失败：返回 ok:false，由调用方进入手动框选兜底
    return { ok: false, canvasSize: { width, height }, stage: 'markers',
      humanMessage: `只检测到 ${markers.length} 个定位角标（需 4 个），请手动框选比色卡与样品区域` };
  } finally {
    if (!(img instanceof cv.Mat)) mat.delete();
  }
}
function px(slot, width, height) {
  return { x: Math.round(slot.x * width), y: Math.round(slot.y * height), w: Math.round(slot.w * width), h: Math.round(slot.h * height) };
}

// 在用户框定的比色卡内识别 7 个色块（基于等距网格；真实场景由用户微调层校正）
export function detectBlocksInRect(img, cardRect, blockCount) {
  const concentrations = CONCENTRATIONS;
  const blocks = inferBlocks(cardRect, blockCount, false);
  return blocks;
}

function inferBlocks(cardRect, n, measured) {
  const step = cardRect.w / n;
  const blocks = [];
  for (let i = 0; i < n; i++) {
    blocks.push({
      x: Math.round(cardRect.x + i * step + step * 0.1),
      y: Math.round(cardRect.y + cardRect.h * 0.15),
      w: Math.round(step * 0.8),
      h: Math.round(cardRect.h * 0.7),
      concentration: CONCENTRATIONS[i],
      measured: !!measured,
      inferred: !measured,
    });
  }
  return blocks;
}

// 手动模式比色：用用户指定的区域（像素）+ 微调色块取 Lab，ΔE2000 比色
export async function analyzeWithRegions(img, options, regions) {
  const concentrations = options.concentrations || CONCENTRATIONS;
  const cv = await getCv();
  let mat, width, height;
  if (img instanceof cv.Mat) { mat = img; width = mat.cols; height = mat.rows; }
  else if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
    const id = img.getContext('2d').getImageData(0, 0, img.width, img.height);
    mat = cv.matFromArray(id.height, id.width, cv.CV_8UC4, new Uint8Array(id.data.buffer));
    width = img.width; height = img.height;
  } else {
    throw new Error('analyzeWithRegions 仅支持 canvas');
  }
  try {
    const tubeLab = sampleAvgLab(cv, mat, rectNorm(regions.tube, width, height), width, height);
    const cardLab = (regions.blocks || []).map(b =>
      sampleAvgLab(cv, mat, rectNorm(b, width, height), width, height));
    const dists = cardLab.map((lab, i) => ({
      blockIdx: i, concentration: concentrations[i], lab,
      deltaE: deltaE2000(tubeLab, lab),
    })).sort((a, b) => a.deltaE - b.deltaE);
    const main = dists[0];
    let confidence = 0;
    if (main.deltaE <= 3) confidence = 0.95;
    else if (main.deltaE <= 6) confidence = 0.85;
    else if (main.deltaE <= 12) confidence = 0.65;
    else if (main.deltaE <= 18) confidence = 0.45;
    else confidence = 0.30;

    const sampleColor = labToRgbExport(tubeLab);
    const blocks = cardLab.map((lab, i) => ({ concentration: concentrations[i], color: labToRgbExport(lab), lab }));
    const qc = {
      ok: main.deltaE <= 18,
      notes: main.deltaE > 18 ? [{ level: 'warn', text: '色差偏大，建议复核样品摆放与光照' }] : [],
    };
    return {
      ok: true,
      canvasSize: { width, height },
      mainValue: main.concentration,
      refinedValue: main.concentration,
      mainValueText: formatConc(main.concentration),
      deltaE: Number(main.deltaE.toFixed(2)),
      confidence: Number(confidence.toFixed(2)),
      sampleColor, sampleLab: tubeLab,
      tube: regions.tube,
      tubeZone: regions.tubeZone || 'manual',
      blocks, qc,
      sortedDistances: dists.map(d => ({ concentration: d.concentration, deltaE: Number(d.deltaE.toFixed(2)), color: labToRgbExport(d.lab), lab: d.lab })),
    };
  } finally {
    if (!(img instanceof cv.Mat)) mat.delete();
  }
}

function rectNorm(r, width, height) {
  return { x: r.x / width, y: r.y / height, w: r.w / width, h: r.h / height };
}

// Lab(OpenCV: L 0-255, a/b 已减128) -> RGB 0-255（前端可视化共用，避免重复实现）
export function labToRgbExport(lab) {
  const L = (lab.L / 255) * 100;
  const a = lab.a, b = lab.b;
  let y = (L + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;
  const f = (t) => (t ** 3 > 0.008856) ? t ** 3 : (t - 16 / 116) / 7.787;
  const yr = f(y), xr = f(x), zr = f(z);
  let R = xr * 3.2406 - yr * 1.5372 - zr * 0.4986;
  let G = xr * -0.9689 + yr * 1.8758 + zr * 0.0415;
  let B = xr * 0.0557 - yr * 0.2040 + zr * 1.0570;
  const gamma = (c) => (c > 0.0031308) ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
  return [Math.round(Math.max(0, Math.min(1, gamma(R))) * 255),
          Math.round(Math.max(0, Math.min(1, gamma(G))) * 255),
          Math.round(Math.max(0, Math.min(1, gamma(B))) * 255)];
}

// 旧的非模板一步式入口（保留签名，内部走 opencv 方案）
export async function analyzeDetergentImage(img, options = {}) {
  const raw = await recognize(img, options);
  if (!raw.ok) return raw;
  return {
    ok: true, canvasSize: raw.canvasSize,
    mainValue: raw.mainValue, refinedValue: raw.mainValue,
    mainValueText: raw.mainValueText, deltaE: raw.deltaE, confidence: raw.confidence,
    sampleColor: labToRgbExport(raw.sampleLab), sampleLab: raw.sampleLab,
    tube: px(TEMPLATE.tubeSlot, raw.canvasSize.width, raw.canvasSize.height),
    tubeZone: 'template',
    blocks: raw.blocks.map(b => ({ concentration: b.concentration, color: labToRgbExport(b.lab), lab: b.lab })),
    qc: { ok: !raw.anomalySuspected, notes: raw.anomalySuspected ? [{ level: 'warn', text: '色差偏大' }] : [] },
    sortedDistances: raw.sortedDistances.map(d => ({ concentration: d.concentration, deltaE: d.deltaE, color: labToRgbExport(d.lab), lab: d.lab })),
  };
}

// 旧的可视化接口：在 canvas 上叠加识别框/色块
export function drawOverlay(canvasEl, result, opts = {}) {
  const ctx = canvasEl.getContext('2d');
  const scaleX = opts.scaleX || 1, scaleY = opts.scaleY || 1;
  const W = result.canvasSize?.width || canvasEl.width;
  const H = result.canvasSize?.height || canvasEl.height;
  ctx.save();
  ctx.lineWidth = 3;
  ctx.font = '16px sans-serif';

  // 比色卡区域框（绿色）：优先用调用方提供的 cardRect，否则模板模式用 TEMPLATE 计算
  let cardRect = opts.cardRect || null;
  if (!cardRect && result.tubeZone !== 'manual' && result.tubeZone !== 'manual') {
    cardRect = px(TEMPLATE.cardSlot, W, H);
  }
  if (cardRect) {
    ctx.strokeStyle = '#16a34a';
    ctx.strokeRect(cardRect.x * scaleX, cardRect.y * scaleY, cardRect.w * scaleX, cardRect.h * scaleY);
  }

  // 实测色卡精框（蓝色实线，画在大框内部，用于视觉对齐真实比色卡）
  const tight = result.tightCardRect || opts.tightCardRect;
  if (tight) {
    const tx = (tight.xPx != null ? tight.xPx : tight.x * W) * scaleX;
    const ty = (tight.yPx != null ? tight.yPx : tight.y * H) * scaleY;
    const tw = (tight.wPx != null ? tight.wPx : tight.w * W) * scaleX;
    const th = (tight.hPx != null ? tight.hPx : tight.h * H) * scaleY;
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.strokeRect(tx, ty, tw, th);
    ctx.restore();
  }

  // 样品区框（蓝色）
  if (result.tube) {
    const t = result.tube;
    ctx.strokeStyle = '#2563eb';
    ctx.strokeRect(t.x * scaleX, t.y * scaleY, t.w * scaleX, t.h * scaleY);
  }

  // 7 个色块框（绿，带序号），帮助用户确认比色卡定位是否准确
  if (result.blocks && result.blocks.length) {
    ctx.strokeStyle = '#16a34a';
    ctx.fillStyle = '#16a34a';
    result.blocks.forEach((b, i) => {
      const bx = b.x * scaleX, by = b.y * scaleY, bw = b.w * scaleX, bh = b.h * scaleY;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillText(String(i + 1), bx + 2, by + 14);
    });
  }
  ctx.restore();
}

export function drawRegionBoxes() { /* 区域框由 DOM 覆盖层实现，这里留空兼容调用 */ }

export function buildResultHtml(result) {
  if (!result.ok) return `<div class="fail-box">⚠️ ${result.humanMessage || '识别失败'}</div>`;
  const sw = (c) => `rgb(${c.map(v => Math.round(v)).join(',')})`;
  return `
    <div class="result-head">测定浓度：<strong>${result.mainValueText} mg/L</strong>
      <span class="conf">置信度 ${(result.confidence * 100).toFixed(0)}%</span></div>
    <div class="result-sub">样品 ΔE2000=${result.deltaE}　Zone=${result.tubeZone || 'template'}</div>
    <div class="result-sample" style="background:${sw(result.sampleColor)};"></div>`;
}

export const TEMPLATE_DESIGN = TEMPLATE;
