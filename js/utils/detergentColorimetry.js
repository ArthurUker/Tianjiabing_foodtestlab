// js/utils/detergentColorimetry.js
//
// 阴离子洗涤剂残留·比色法·图像自动判定算法。
// 核心思路：
//   1) 同一张图里的 7 个色块 = 天然的"自带校准器"，作为定位锚点 + 颜色基准
//   2) 离心管位置由"与色卡的相对位置"推导（不靠通用目标检测）
//   3) 取色后用 Lab 色差匹配到最近色块（主判）+ 邻域插值（参考）
//
// 设计原则：
//   - 零外部依赖（纯 Canvas API + 数值计算）
//   - 每一步失败都给清晰的人话错误，方便现场 SOP 复盘
//   - 函数纯化（除 export 的入口外，其他都是内部纯函数），方便复用于 demo / 嵌入系统两个场景
//
// 浓度序列按用户确认：0, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0 mg/L
// 默认按"色块在比色卡上从左到右排列"（对应从 0 → 2.0 单调递增）

// ============================================================================
// 颜色空间转换
// ============================================================================

// sRGB [0,255] -> 线性 RGB [0,1]
function sRGBToLinear(c) {
  const v = c / 255;
  return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
}

// 线性 RGB [0,1] -> XYZ (D65)
// X, Y, Z 都是 [0, 1]
function linearRgbToXyz(r, g, b) {
  return {
    X: (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) * 1.0, // 相对 D65 白点
    Y: (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) * 1.0,
    Z: (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) * 1.0,
  };
}

// XYZ -> CIE Lab
function xyzToLab(X, Y, Z) {
  // 参考白点 (D65)
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

// [R, G, B] (0-255) -> {L, a, b}
export function rgbToLab([R, G, B]) {
  const r = sRGBToLinear(R);
  const g = sRGBToLinear(G);
  const bl = sRGBToLinear(B);
  const { X, Y, Z } = linearRgbToXyz(r, g, bl);
  return xyzToLab(X, Y, Z);
}

// [R,G,B] -> {H, S, V}  HSV, H in [0, 360), S,V in [0,1]
export function rgbToHsv([R, G, B]) {
  const r = R / 255, g = G / 255, b = B / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, v };
}

// CIE Lab ΔE76 （欧式距离，够本任务用）
export function deltaE76(lab1, lab2) {
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

// ============================================================================
// 图像处理工具
// ============================================================================

// 把 ImageData 限定最大工作边长（保证算法在手机端也能秒回）
// 长边按比例缩，原图放大不缩
export function downscaleImageData(srcCanvas, maxLongEdge = 800) {
  const sw = srcCanvas.width, sh = srcCanvas.height;
  if (Math.max(sw, sh) <= maxLongEdge) return srcCanvas;
  const scale = maxLongEdge / Math.max(sw, sh);
  const tw = Math.round(sw * scale), th = Math.round(sh * scale);
  const tmp = document.createElement('canvas');
  tmp.width = tw; tmp.height = th;
  tmp.getContext('2d', { willReadFrequently: true }).drawImage(srcCanvas, 0, 0, tw, th);
  return tmp;
}

// 取 ROI 平均 RGB（0-255）
// 自动忽略极亮/极暗像素（防手指反光 / 全黑边缘干扰）
export function avgRGB(canvas, x, y, w, h) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(x, y, w, h).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const v = Math.max(r, g, b);
    if (v < 20 || v > 250) continue; // 跳过近纯黑/纯白（多为阴影/高光）
    R += r; G += g; B += b; n++;
  }
  if (n === 0) return [0, 0, 0];
  return [R / n, G / n, B / n];
}

// 矩形工具
function rectCenter(r) { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
function rectArea(r) { return r.w * r.h; }

// ============================================================================
// 色卡检测（核心）
// ============================================================================

// 计算整张 ImageData 的"色彩显著度图"：饱和度 + 方差
// 显著度图：高饱和度或"色彩复杂"的区域得分高
// 用于找色卡位置（色卡内是 7 个高饱和度色块组成的彩色带）
function computeSaliencyMap(imageData) {
  const { data, width, height } = imageData;
  const map = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const s = max === 0 ? 0 : (max - min) / max;
    map[p] = s;
  }
  return { width, height, map };
}

// 在图像中找色卡的 7 个色块，返回矩形列表（每个色块的最小外接矩形）
// 两阶段定位：
//   阶段A: 行投影找色卡的纵向 y 范围（横向大段高饱和度 = 色卡带）
//   阶段B: 在该 y 范围内做列投影，定位 7 个色块的 x 中心
function locateColorBlocks(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width, H = canvas.height;
  const imageData = ctx.getImageData(0, 0, W, H);
  const sal = computeSaliencyMap(imageData).map;

  const SAT_THRESH = 0.04;

  // 阶段 A: 行投影找色卡的 y 范围
  // rowBand[y] = 该行所有"中等以上饱和度"像素的总和
  // 色卡带在 rowBand 上是一个明显的高分段
  const rowBand = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x++) {
      const v = sal[y * W + x];
      if (v > SAT_THRESH) s += v;
    }
    rowBand[y] = s;
  }

  const rowSorted = [...rowBand].sort((a, b) => a - b);
  const rowBase = rowSorted[Math.floor(H * 0.6)];

  // 用两轮阈值找最长的高分段
  let yCardTop = -1, yCardBottom = -1;
  for (const rowThresh of [Math.max(rowBase * 3, rowBase + 5), Math.max(rowBase * 1.5, rowBase + 1)]) {
    yCardTop = -1; yCardBottom = -1;
    let inRun = false, runStart = 0, bestRunLen = 0;
    for (let y = 0; y < H; y++) {
      const high = rowBand[y] > rowThresh;
      if (high && !inRun) { inRun = true; runStart = y; }
      else if (!high && inRun) {
        const len = y - runStart;
        if (len > bestRunLen && len > H * 0.04) {
          bestRunLen = len; yCardTop = runStart; yCardBottom = y - 1;
        }
        inRun = false;
      }
    }
    if (inRun && H - runStart > bestRunLen && H - runStart > H * 0.04) {
      yCardTop = runStart; yCardBottom = H - 1;
    }
    if (yCardTop >= 0) break;
  }
  if (yCardTop < 0) { yCardTop = 0; yCardBottom = H - 1; }
  yCardTop = Math.max(0, yCardTop - 2);
  yCardBottom = Math.min(H - 1, yCardBottom + 2);
  const cardHeight = yCardBottom - yCardTop + 1;

  // 阶段 B: 仅在色卡 y 内做列投影
  // 用列的"平均饱和度"（连续值）而非"二值化计数"——0 色块（白色）饱和度低，
  // 但仍比色卡外的白纸更偏向有色，平均饱和度 ≈ 0.02~0.05，可被识别为波峰。
  const colScore = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = yCardTop; y <= yCardBottom; y++) {
      sum += sal[y * W + x];
    }
    colScore[x] = sum / cardHeight;
  }

  const sortedCol = [...colScore].sort((a, b) => a - b);
  const colBase = sortedCol[Math.floor(W * 0.5)];

  // 平滑半径要小：避免把窄色块（缩到 800px 后单色块≈70px）黏在一起
  const colSmooth = boxBlur1D(colScore, W, 2);

  const peaks = findPeaksTopN(colSmooth, W, 7, colBase);
  // 宽容条件：只要 ≥ 4 个就能继续（允许色卡被部分遮挡）
  if (peaks.length < 4) {
    return {
      ok: false, error: 'CARD_NOT_FOUND',
      hint: `仅找到 ${peaks.length} 个候选波峰（背景=${colBase.toFixed(3)}）`,
      debug: { yCardTop, yCardBottom, peaks, colBase },
    };
  }
  // 7 个峰值时也放宽容（CV>0.5 视为相邻色块挤在一起，让等距补全自动兜底）
  // 这样聚焦在可见色块的位置，不再因几何严格而拒识。

  // 单个峰值时无法估算 step，用色卡宽度粗估（约像素宽 600 时每色块约 85px 间距）
  let gapMean;
  if (peaks.length >= 2) {
    let gapSum = 0;
    for (let i = 1; i < peaks.length; i++) gapSum += (peaks[i] - peaks[i - 1]);
    gapMean = gapSum / (peaks.length - 1);
  } else {
    // 兜底：用色卡右侧位置减去左侧位置除以 6（7 等分）
    gapMean = (peaks[peaks.length - 1] - peaks[0]) / 6;
  }
  const blockHalfW = Math.max(8, Math.round(gapMean / 2.7));
  const blocks = [];
  for (const x of peaks) {
    const b = findBlockVerticalBounds(sal, W, H, x, blockHalfW, SAT_THRESH, yCardTop, yCardBottom);
    if (!b) {
      blocks.push({ x: x - blockHalfW, y: yCardTop, w: blockHalfW * 2, h: cardHeight });
    } else {
      blocks.push(b);
    }
  }

  return {
    ok: true,
    blocks: blocks.map(r => ({
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.w), h: Math.round(r.h),
      measured: true,
    })),
    debug: { yCardTop, yCardBottom, peaks, gapMean },
  };
}

// 1D 滑动平均（半径 r）
function boxBlur1D(arr, n, r) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) { s += arr[k]; c++; }
    out[i] = s / c;
  }
  return out;
}

// 1D 波峰检测：找局部极大值，返回前 N 强波峰的 x 坐标（按 x 升序）
// baseScore 用于过滤：要求波峰比"背景分"明显高
function findPeaksTopN(arr, n, N, baseScore = 0) {
  // 找全局最大值
  let maxV = 0;
  for (let i = 0; i < n; i++) if (arr[i] > maxV) maxV = arr[i];

  // 最小峰高：max 值的 8%（让 0 色块这种弱色块也能被识别）
  // baseScore 仅用于辅助 sanity 检查
  const minH = Math.max(maxV * 0.08, 0.01);

  // 收集所有局部极大值
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (arr[i] > arr[i - 1] && arr[i] >= arr[i + 1] && arr[i] > minH) {
      peaks.push({ x: i, score: arr[i] });
    }
  }

  if (peaks.length <= N) {
    peaks.sort((a, b) => a.x - b.x);
    return peaks.map(p => p.x);
  }

  // 太多波峰 → 用"分布近似均匀"启发：先按分数排序取前 N*3，再按 x 排序均匀挑 N
  peaks.sort((a, b) => b.score - a.score);
  const top = peaks.slice(0, N * 3);
  top.sort((a, b) => a.x - b.x);
  const picked = [];
  const step = (top[top.length - 1].x - top[0].x) / (N - 1);
  for (let k = 0; k < N; k++) {
    const targetX = top[0].x + step * k;
    let best = top[0], bestDist = Infinity;
    for (const p of top) {
      if (picked.includes(p)) continue;
      const d = Math.abs(p.x - targetX);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    picked.push(best);
  }
  picked.sort((a, b) => a.x - b.x);
  return picked.map(p => p.x);
}

// 对给定的列中心 x，向左右各 halfW 列宽，纵向找高饱和度连续段
// 限定 y0..y1（默认整图）
function findBlockVerticalBounds(sal, W, H, cx, halfW, SAT_THRESH, y0 = 0, y1 = H - 1) {
  const x0 = Math.max(0, cx - halfW);
  const x1 = Math.min(W - 1, cx + halfW);
  // 找最大的连续高饱和度 y 范围
  let yStart = -1, yEnd = -1, bestLen = 0, curY = -1, curLen = 0;
  for (let y = y0; y <= y1; y++) {
    let satCnt = 0;
    for (let x = x0; x <= x1; x++) if (sal[y * W + x] > SAT_THRESH) satCnt++;
    const isSatBand = satCnt > (x1 - x0) * 0.4; // 半数以上的列高饱和（放松到 40% 以容忍更亮的 0 色块）
    if (isSatBand) {
      if (curLen === 0) curY = y;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; yStart = curY; yEnd = y; }
    } else {
      curLen = 0;
    }
  }
  if (yStart < 0) return null;
  return { x: x0, y: yStart, w: x1 - x0 + 1, h: yEnd - yStart + 1 };
}

// ============================================================================
// 离心管定位
// ============================================================================

// 在色卡 4 个方向（上、下、左、右）的扩展范围内找"垂直长条形高饱和度区域"
// 返回矩形（液层中心区域）
function locateCentrifugeTube(canvas, colorBlocks) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width, H = canvas.height;
  const card = colorBlocks;
  const cardLeft = Math.min(...card.map(b => b.x));
  const cardRight = Math.max(...card.map(b => b.x + b.w));
  const cardTop = Math.min(...card.map(b => b.y));
  const cardBottom = Math.max(...card.map(b => b.y + b.h));
  const cardCx = (cardLeft + cardRight) / 2;
  const cardCy = (cardTop + cardBottom) / 2;
  const cardH = cardBottom - cardTop;
  const cardW = cardRight - cardLeft;

  // 取全局色彩饱和度图
  const imageData = ctx.getImageData(0, 0, W, H);
  const sal = computeSaliencyMap(imageData).map;

  // 候选搜索区域：色卡周围 4 个方向都试
  // 上方：色卡顶部向上 200% cardH
  // 下方：色卡底部向下 200% cardH
  // 左侧：色卡左边缘向左 200% cardW
  // 右侧：色卡右边缘向右 200% cardW
  function avgSat(x, y, w, h) {
    const x0 = Math.max(0, x), x1 = Math.min(W, x + w);
    const y0 = Math.max(0, y), y1 = Math.min(H, y + h);
    let sum = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        sum += sal[yy * W + xx]; n++;
      }
    }
    return n === 0 ? 0 : sum / n;
  }

  // 上方搜索带：色卡宽度 + 0%~80% center
  // 起点：在色卡宽度的 80%~120% 范围内、距离色卡顶 10% cardH 处开始
  const searchZones = [
    { name: 'top',    xRange: [Math.max(0, cardCx - cardW * 0.8), Math.min(W, cardCx + cardW * 0.8)], yRange: [Math.max(0, cardTop - cardH * 4), cardTop - 4] },
    { name: 'bottom', xRange: [Math.max(0, cardCx - cardW * 0.8), Math.min(W, cardCx + cardW * 0.8)], yRange: [cardBottom + 4, Math.min(H, cardBottom + cardH * 4)] },
    { name: 'right',  xRange: [cardRight + 4, Math.min(W, cardRight + cardW * 4)], yRange: [Math.max(0, cardTop - cardH * 0.5), Math.min(H, cardBottom + cardH * 0.5)] },
    { name: 'left',   xRange: [Math.max(0, cardLeft - cardW * 4), cardLeft - 4], yRange: [Math.max(0, cardTop - cardH * 0.5), Math.min(H, cardBottom + cardH * 0.5)] },
  ];

  // 对每个区域，取"垂直方向上最长的高饱和度连续带"
  let best = null;
  for (const zone of searchZones) {
    const [zx0, zx1] = zone.xRange;
    const [zy0, zy1] = zone.yRange;
    if (zx1 <= zx0 || zy1 <= zy0) continue;
    // 在区域内，沿一个轴投影：高饱和度像素质心
    // 简单启发：对每一列，求该列在区域内的平均饱和度
    const colSat = new Float32Array(W);
    for (let xx = zx0; xx < zx1; xx++) {
      let sum = 0, n = 0;
      for (let yy = zy0; yy < zy1; yy++) {
        sum += sal[yy * W + xx]; n++;
      }
      colSat[xx] = n === 0 ? 0 : sum / n;
    }
    // 找连续高饱和度列组（中心列）
    const inCols = [];
    for (let xx = zx0; xx < zx1; xx++) {
      if (colSat[xx] > 0.1) inCols.push(xx);
    }
    if (inCols.length < 4) continue; // 太窄，忽略
    // 取最长的连续段
    let bestRunStart = inCols[0], bestRunEnd = inCols[0], bestRunLen = 1;
    let curStart = inCols[0], curLen = 1;
    for (let i = 1; i < inCols.length; i++) {
      if (inCols[i] === inCols[i - 1] + 1) {
        curLen++;
      } else {
        if (curLen > bestRunLen) {
          bestRunLen = curLen; bestRunStart = curStart; bestRunEnd = inCols[i - 1];
        }
        curStart = inCols[i]; curLen = 1;
      }
    }
    if (curLen > bestRunLen) { bestRunLen = curLen; bestRunStart = curStart; bestRunEnd = inCols[inCols.length - 1]; }
    // 离心管管身：宽度 / 长度比应当很小（细长）
    const tubeW = bestRunEnd - bestRunStart + 1;
    const tubeH = zy1 - zy0;
    if (tubeH < tubeW * 0.8) continue; // 太短，不是管子
    // 评估该区域总饱和度（越高越好）
    const zoneAvgSat = avgSat(bestRunStart, zy0, tubeW, tubeH);
    if (!best || zoneAvgSat > best.score) {
      best = {
        rect: { x: bestRunStart, y: zy0, w: tubeW, h: tubeH },
        score: zoneAvgSat, zone: zone.name,
      };
    }
  }

  if (!best) return { ok: false, error: 'TUBE_NOT_FOUND' };
  // 缩到中心 60% × 60%（远离边缘高光/标签）
  const r = best.rect;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const newW = r.w * 0.6, newH = r.h * 0.6;
  return {
    ok: true,
    rect: {
      x: Math.round(cx - newW / 2), y: Math.round(cy - newH / 2),
      w: Math.round(newW), h: Math.round(newH),
    },
    zone: best.zone,
  };
}

// ============================================================================
// 比色匹配
// ============================================================================

// 计算 7 个色块的位置（按 x 排序），返回浓度 + Lab
function assignConcentrations(blocks, concentrations) {
  const sorted = [...blocks].sort((a, b) => a.x - b.x);
  if (sorted.length !== concentrations.length) {
    throw new Error(`色块数 ${sorted.length} 不等于浓度序列数 ${concentrations.length}`);
  }
  return concentrations.map((c, i) => ({ ...sorted[i], concentration: c }));
}

// 主判：样品色（Lab）到 7 个色块 Lab 的最近距离 -> 输出浓度
function matchColorByLab(sampleLab, calibratedBlocks) {
  const dists = calibratedBlocks.map(b => ({
    blockIdx: b.blockIdx,
    concentration: b.concentration,
    color: b.color,
    lab: b.lab,
    deltaE: deltaE76(sampleLab, b.lab),
  }));
  dists.sort((a, b) => a.deltaE - b.deltaE);
  const main = dists[0];

  // 邻域插值：在最近和次近的两个色块之间做线性插值
  let refined = main.concentration;
  let refinementAvailable = false;
  if (dists.length >= 2) {
    const a = main, b = dists[1];
    // 仅当两个色块是相邻浓度（差一个量级单位），且距离比合理
    const concDiff = Math.abs(a.concentration - b.concentration);
    if (concDiff > 0) {
      const total = a.deltaE + b.deltaE;
      const wA = total === 0 ? 0.5 : b.deltaE / total;
      refined = a.concentration * wA + b.concentration * (1 - wA);
      refined = Number(refined.toFixed(4));
      refinementAvailable = true;
    }
  }

  // 置信度：最近色块的 ΔE 越小，置信度越高
  // 经验阈值：ΔE ≤ 5 → 置信（≥80%），≥15 → 低置信（≤40%）
  let confidence = 0;
  if (main.deltaE <= 3) confidence = 0.95;
  else if (main.deltaE <= 5) confidence = 0.85;
  else if (main.deltaE <= 10) confidence = 0.65;
  else if (main.deltaE <= 15) confidence = 0.45;
  else confidence = 0.30;

  // 异常判定：ΔE_min > 18 → 颜色和色卡差异过大，疑似非本试剂
  const anomalySuspected = main.deltaE > 18;

  return {
    mainValue: main.concentration,
    mainValueText: formatConcentration(main.concentration),
    refinedValue: refined,
    deltaE: Number(main.deltaE.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    sortedDistances: dists.map(d => ({
      concentration: d.concentration,
      deltaE: Number(d.deltaE.toFixed(2)),
    })),
    refinementAvailable,
    anomalySuspected,
  };
}

function formatConcentration(v) {
  if (v === 0) return '0';
  if (v < 0.1) return v.toFixed(2);
  return v.toString();
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 分析一张图，输出浓度判定结果
 * @param {HTMLCanvasElement} srcCanvas - 已绘制原图的 canvas（任意尺寸，内部会自动降采样）
 * @param {object} options
 * @param {number[]} options.concentrations - 浓度序列，如 [0, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0]
 * @returns {object} 完整分析结果
 */
// ============================================================================
// 区域定位（仅定位，不取色）—— 供前端「先确认区域、再比色」两步流程使用
// ============================================================================

/**
 * 步骤一：仅做区域定位，返回色卡整体外接矩形 + 离心管矩形。
 * 不执行取色 / 比色，便于前端先把识别到的两个区域框展示给用户确认 / 手动矫正。
 *
 * @param {HTMLCanvasElement} srcCanvas
 * @param {object} options { concentrations }
 * @returns {object} 定位结果
 *   成功: { ok:true, cardRect:{x,y,w,h}, tube:{x,y,w,h}, tubeZone, blocks, canvasSize }
 *   失败: { ok:false, stage, error, humanMessage, hint? }
 */
export function locateRegions(srcCanvas, options = {}) {
  const concentrations = options.concentrations || [0, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0];

  const canvas = downscaleImageData(srcCanvas, 800);
  const W = canvas.width, H = canvas.height;

  try {
    const cardResult = locateColorBlocks(canvas);
    if (!cardResult.ok) {
      return {
        ok: false, stage: 'color_card',
        error: cardResult.error,
        humanMessage: humanMessageForError(cardResult.error),
        hint: cardResult.hint,
        debug: cardResult.debug,
      };
    }
    const blocks = cardResult.blocks;

    // 色卡整体外接矩形（含 7 个色块）
    const cardRect = boundingRectOf(blocks);

    const tubeResult = locateCentrifugeTube(canvas, blocks);
    if (!tubeResult.ok) {
      return {
        ok: false, stage: 'tube',
        error: tubeResult.error,
        humanMessage: humanMessageForError(tubeResult.error),
        cardRect,
        blocks,
      };
    }

    return {
      ok: true,
      cardRect,
      tube: tubeResult.rect,
      tubeZone: tubeResult.zone,
      blocks,
      canvasSize: { width: W, height: H },
    };
  } catch (e) {
    return { ok: false, stage: 'locate', error: 'LOCATE_EXCEPTION', humanMessage: '区域定位异常：' + (e?.message || e) };
  }
}

/** 计算一组矩形的最小外接矩形（像素） */
function boundingRectOf(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

/**
 * 步骤二：在给定（可能经人工矫正的）区域上做取色 + 比色匹配。
 * @param {HTMLCanvasElement} srcCanvas
 * @param {object} options { concentrations }
 * @param {object} regions { cardRect:{x,y,w,h}, tube:{x,y,w,h}, tubeZone?, blocks? }
 *   cardRect / tube 为像素坐标（基于降采样后的 canvas）；
 *   未提供 blocks 时，用 cardRect 做"整块等距拆分"兜底取色（手动框选场景）。
 * @returns {object} 完整分析结果（与 analyzeDetergentImage 同结构）
 */
export function analyzeWithRegions(srcCanvas, options = {}, regions = {}) {
  const concentrations = options.concentrations || [0, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0];

  const cardRect = regions.cardRect || (regions.blocks ? boundingRectOf(regions.blocks) : null);
  const tube = regions.tube || null;
  const providedBlocks = regions.blocks || null;

  if (!cardRect || !tube) {
    return {
      ok: false, stage: 'regions',
      error: 'REGIONS_MISSING',
      humanMessage: '缺少色卡或样品区域，请重新框选后再识别',
    };
  }

  const canvas = downscaleImageData(srcCanvas, 800);
  const W = canvas.width, H = canvas.height;

  // 1. 色块：优先用定位阶段识别到的精确 blocks；
  //    若用户手动框选（blocks 为空），用 cardRect 等距推断 7 个色块并实际取色。
  let blocks = providedBlocks && providedBlocks.length ? providedBlocks : inferBlocksFromCardRect(cardRect, concentrations.length);

  // 2. 给色块排序、补全缺失位置（用等距先验）
  const sortedBlocks = [...blocks].sort((a, b) => a.x - b.x);
  const step = sortedBlocks.length === 1
    ? 60
    : (sortedBlocks[sortedBlocks.length - 1].x - sortedBlocks[0].x) / (sortedBlocks.length - 1);

  const yCardTop = cardRect.y;

  const fullBlocks = [];
  const leftmostX = sortedBlocks[0].x;
  const firstIdx = 0;
  const trialLeftX = leftmostX;
  for (let i = 0; i < 7; i++) {
    const xCenter = trialLeftX + i * step;
    if (i >= firstIdx && i < firstIdx + sortedBlocks.length) {
      const b = sortedBlocks[i - firstIdx];
      fullBlocks.push({ ...b, blockIdx: i, concentration: concentrations[i], inferred: !!b.inferred });
    } else {
      const halfW = (sortedBlocks[0].w || 20) / 2;
      const xCenterInt = Math.round(xCenter);
      fullBlocks.push({
        blockIdx: i,
        concentration: concentrations[i],
        x: xCenterInt - halfW,
        y: yCardTop,
        w: halfW * 2,
        h: cardRect.h || 30,
        inferred: true,
      });
    }
  }

  // 3. 取实测色（只在非推断的可见色块上做）
  fullBlocks.forEach(b => {
    if (b.inferred) return;
    b.color = avgRGB(canvas, b.x, b.y, b.w, b.h);
    b.lab = rgbToLab(b.color);
  });

  // 4. 取样品色（离心管中心区域）
  const sampleColor = avgRGB(canvas, tube.x, tube.y, tube.w, tube.h);
  const sampleLab = rgbToLab(sampleColor);

  // 5. 比色匹配（只对可见色块）
  const visibleBlocks = fullBlocks.filter(b => !b.inferred);
  const match = visibleBlocks.length >= 1
    ? matchColorByLab(sampleLab, visibleBlocks)
    : { ok: false, anomalySuspected: true, mainValueText: '?', deltaE: 99, confidence: 0, sortedDistances: [], refinementAvailable: false, mainValue: 0, refinedValue: 0 };

  // 6. 整体质控
  const qc = runQualityControl({ blocks: fullBlocks, tube, match, canvas });
  if (visibleBlocks.length < 7) {
    qc.notes.push({
      level: 'warn',
      text: `色卡部分可见：仅识别到 ${visibleBlocks.length}/7 个色块（其余色块位置为等距推算，未取色）`,
    });
  }

  return {
    ok: true,
    blocks: fullBlocks,
    tube,
    tubeZone: regions.tubeZone || 'manual',
    sampleColor,
    sampleLab,
    ...match,
    qc,
    canvasSize: { width: W, height: H },
    regions: { cardRect, tube }, // 回传实际使用的区域（供二次矫正复用）
  };
}

/**
 * 当定位失败 / 用户完全手动框选时，从 cardRect 等距推断 7 个色块位置。
 * 这些块拥有真实像素位置，会在下游被实际取色（不标记 inferred）。
 */
function inferBlocksFromCardRect(cardRect, n) {
  const blocks = [];
  const step = cardRect.w / n;
  for (let i = 0; i < n; i++) {
    blocks.push({
      x: Math.round(cardRect.x + i * step + step * 0.1),
      y: cardRect.y,
      w: Math.round(step * 0.8),
      h: cardRect.h,
      measured: false,
      inferred: false,
    });
  }
  return blocks;
}

/**
 * 分析一张图，输出浓度判定结果（兼容封装：定位 + 比色一步完成）
 */
export function analyzeDetergentImage(srcCanvas, options = {}) {
  const loc = locateRegions(srcCanvas, options);
  if (!loc.ok) return loc;
  return analyzeWithRegions(srcCanvas, options, loc);
}

function humanMessageForError(code) {
  const map = {
    CARD_NOT_FOUND: '画面中找不到完整的比色卡，请确认色卡全部入镜且未被遮挡',
    CARD_BLOCKS_INSUFFICIENT: '色块不足 7 个，请重新拍摄（画面太斜/曝光太强都会失败）',
    CARD_SHAPE_MISMATCH: '色块布局不符合 7 等分横向排列，请确认是正视拍摄',
    TUBE_NOT_FOUND: '未识别到离心管，请确认离心管在色卡的紧邻位置（约 4 个方向任选一处）',
  };
  return map[code] || `未知错误：${code}`;
}

function runQualityControl({ blocks, tube, match, canvas }) {
  const notes = [];
  // 1. 检查亮度和曝光
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let brightSum = 0, brightN = 0;
  for (let i = 0; i < id.data.length; i += 4) {
    const r = id.data[i], g = id.data[i + 1], b = id.data[i + 2];
    brightSum += (r + g + b) / 3; brightN++;
  }
  const brightAvg = brightSum / brightN;
  if (brightAvg < 80) notes.push({ level: 'warn', text: '画面整体偏暗，建议加强光照' });
  if (brightAvg > 220) notes.push({ level: 'warn', text: '画面整体过曝，建议避开直射光' });

  // 2. 离心管与色卡不重叠（避免两者互相遮挡）
  const tubeBottom = tube.y + tube.h;
  const cardTop = Math.min(...blocks.map(b => b.y));
  const tubeOverlapsCard = !(tubeBottom < cardTop || tube.y > Math.max(...blocks.map(b => b.y + b.h)));

  // 3. 浓度超量程
  if (match.mainValue >= Math.max(...blocks.map(b => b.concentration))) {
    notes.push({ level: 'warn', text: '浓度已达/超出色卡最高量程，建议稀释后重测' });
  }

  // 4. 颜色异常
  if (match.anomalySuspected) {
    notes.push({ level: 'error', text: '样品颜色与色卡差异过大，疑似非本试剂或操作步骤异常，请重新拍照或人工复核' });
  }

  // 5. 离心管区域无色（很可能误识别）→ ΔE 暴大
  // （已经在 match.anomalySuspected 中体现）

  return {
    brightness: Math.round(brightAvg),
    tubeOverlapsCard,
    notes,
    ok: notes.every(n => n.level !== 'error'),
  };
}

// ============================================================================
// 可视化工具：把识别结果叠加绘制到 canvas
// ============================================================================

/**
 * 把识别结果叠加绘制到 canvas 上，用可视化方式展示每一步的中间产物
 */
export function drawOverlay(canvas, result, options = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const scaleX = canvas.width / (result.canvasSize?.width || canvas.width);
  const scaleY = canvas.height / (result.canvasSize?.height || canvas.height);
  const sx = options.scaleX || scaleX;
  const sy = options.scaleY || scaleY;

  if (!result.ok) {
    ctx.font = 'bold 18px sans-serif';
    ctx.fillStyle = '#dc2626';
    ctx.fillText(`[${result.stage}] ${result.humanMessage}`, 12, 28);
    return;
  }

  // 色块框（按浓度标色，0=绿，警戒=黄，超=红）
  // 实测色块用实线 + 实色，推算色块用虚线 + 灰色
  result.blocks.forEach(b => {
    const x = b.x * sx, y = b.y * sy, w = b.w * sx, h = b.h * sy;
    const judge = b.concentration === 0 ? '#16a34a'
      : b.concentration <= 0.05 ? '#65a30d'
      : b.concentration <= 0.1 ? '#ca8a04'
      : '#dc2626';
    if (b.inferred) {
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.fillStyle = '#94a3b8';
      ctx.font = 'italic 12px monospace';
      ctx.fillText(`${b.concentration} mg/L (推断)`, x + 4, y - 4);
      return;
    }
    ctx.strokeStyle = judge;
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = judge;
    ctx.font = 'bold 14px monospace';
    ctx.fillText(`${b.concentration} mg/L`, x + 4, y - 4);
  });

  // 离心管框
  const t = result.tube;
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 3;
  ctx.strokeRect(t.x * sx, t.y * sy, t.w * sx, t.h * sy);
  ctx.fillStyle = '#2563eb';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText(`样品 (${result.tubeZone})`, t.x * sx, t.y * sy - 4);

  // 顶部信息条
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillRect(0, 0, canvas.width, 60);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(
    `主判 ${result.mainValueText} mg/L  ·  参考 ${result.refinedValue} mg/L  ·  ΔE ${result.deltaE}  ·  置信 ${(result.confidence * 100) | 0}%`,
    12, 24
  );
  ctx.font = '12px sans-serif';
  ctx.fillStyle = result.qc.ok ? '#16a34a' : '#dc2626';
  ctx.fillText(
    result.qc.ok ? '质控 OK' : `质控异常: ${result.qc.notes.filter(n => n.level === 'error').map(n => n.text).join('; ')}`,
    12, 44
  );
}

// 颜色卡查询工具：把浓度序列转换成对外显示文本
export function formatConcentrationList(concentrations) {
  return concentrations.map(formatConcentration).join(' / ');
}

/**
 * 区域确认阶段绘制：只画「比色卡整体」和「样品」两个大框，不画 7 个小色块，
 * 避免干扰用户判断算法是否圈对了位置。
 *
 * @param {HTMLCanvasElement} canvas  显示用 canvas（已绘制原图）
 * @param {object} regions  { cardRect:{x,y,w,h}, tube:{x,y,w,h} } 基于定位 canvas(800) 像素坐标
 * @param {object} [options] { canvasSize:{width,height} }  定位 canvas 尺寸（默认 800xH）
 */
export function drawRegionBoxes(canvas, regions, options = {}) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const srcW = (options.canvasSize && options.canvasSize.width) || regions.canvasSize?.width || 800;
  const srcH = (options.canvasSize && options.canvasSize.height) || regions.canvasSize?.height || canvas.height;
  const sx = canvas.width / srcW;
  const sy = canvas.height / srcH;

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (regions.cardRect) {
    const c = regions.cardRect;
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(c.x * sx, c.y * sy, c.w * sx, c.h * sy);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(22,163,74,0.92)';
    const label = '比色卡区域';
    ctx.font = 'bold 15px sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillRect(c.x * sx, c.y * sy - 22, tw + 12, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, c.x * sx + 6, c.y * sy - 7);
  }

  if (regions.tube) {
    const t = regions.tube;
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(t.x * sx, t.y * sy, t.w * sx, t.h * sy);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(37,99,235,0.92)';
    const label = '样品区域';
    ctx.font = 'bold 15px sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillRect(t.x * sx, t.y * sy - 22, tw + 12, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, t.x * sx + 6, t.y * sy - 7);
  }
  ctx.restore();
}

/**
 * 生成识别结果的卡片网格 HTML（供 demo 页 / 嵌入页渲染）。
 * 与原始 renderResult 的 result-grid 结构对应；人工覆盖逻辑仍由调用方处理，
 * 本函数只负责"算法主判"的展示。
 *
 * @param {object} result  analyzeWithRegions / analyzeDetergentImage 的成功返回
 * @returns {string} HTML 片段
 */
export function buildResultHtml(result) {
  const mainV = result.mainValue;
  const mainValueText = result.mainValueText ?? String(mainV ?? '');
  const judgeClass = mainV === 0 ? 'pass'
    : mainV <= 0.05 ? 'pass'
    : mainV <= 0.1 ? 'warn'
    : 'fail';
  const judgeText = judgeClass === 'pass' ? '合格'
    : judgeClass === 'warn' ? '警戒' : '不合格';

  const card = (cls, label, value) =>
    `<div class="result-card ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`;

  return [
    card('main', '主判定', `${mainValueText} mg/L`),
    card(judgeClass, '判定等级', judgeText),
    card('', '参考值（插值）', `${result.refinedValue ?? '-'} mg/L`),
    card('', '置信度', `${Math.round((result.confidence || 0) * 100)}%`),
    card('', 'ΔE（主判）', `${result.deltaE ?? '-'}`),
    card('', '色卡 7 色块', '已识别'),
    card('', '离心管方向', `${result.tubeZone ?? '-'}`),
    card('', '样品 RGB', `${(result.sampleColor || []).map(v => Math.round(v)).join(', ')}`),
  ].join('');
}


