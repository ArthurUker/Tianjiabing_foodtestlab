// 合成测试卡：生成一张带四角 ArUco 定位标（ARUCO_MIP_36h12）的标准比色卡画布，
// 用于前端「合成测试图」按钮一键验证模板（ArUco）识别全流程，无需实体打印。
import { MARKER_DICT, TEMPLATE } from '../opencv/recognizer.js';

// marker id 映射（与 recognizer 一致：TL=0, TR=1, BL=2, BR=3）
const MARKER_IDS = { TL: 0, TR: 1, BL: 2, BR: 3 };

// 7 个比色块浓度（与 recognizer.CONCENTRATIONS 一致）
const CONC = [0, 0.05, 0.1, 0.2, 0.5, 1, 2];

// 浓度 -> 近似颜色（蓝绿色梯度，越浓越深蓝）
function concColor(c) {
  if (c === 0) return [245, 245, 245];
  const t = Math.min(1, c / 2);
  return [
    Math.round(220 - t * 170),
    Math.round(240 - t * 120),
    Math.round(245 - t * 40),
  ];
}

export function generateSyntheticDetergentCanvas(size = 1000) {
  const cv = (typeof window !== 'undefined' && window.cv) ? window.cv : null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // 白底（含安静区）
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // 比色卡插槽（浅灰底）
  const card = TEMPLATE.cardSlot;
  const cardPx = { x: card.x * size, y: card.y * size, w: card.w * size, h: card.h * size };
  ctx.fillStyle = '#eeeeee';
  ctx.fillRect(cardPx.x, cardPx.y, cardPx.w, cardPx.h);

  // 7 个色块
  const sw = cardPx.w / CONC.length;
  CONC.forEach((c, i) => {
    const [r, g, b] = concColor(c);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(cardPx.x + i * sw + sw * 0.1, cardPx.y + cardPx.h * 0.15, sw * 0.8, cardPx.h * 0.7);
  });

  // 样品插槽（离心管区域）：取浓度 0.5 对应的颜色
  const tube = TEMPLATE.tubeSlot;
  const tubePx = { x: tube.x * size, y: tube.y * size, w: tube.w * size, h: tube.h * size };
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(tubePx.x, tubePx.y, tubePx.w, tubePx.h);
  const [tr, tg, tb] = concColor(0.5);
  ctx.fillStyle = `rgb(${tr},${tg},${tb})`;
  ctx.fillRect(tubePx.x + tubePx.w * 0.25, tubePx.y + tubePx.h * 0.2, tubePx.w * 0.5, tubePx.h * 0.6);

  // 四角 ArUco 定位标（需安静区白边）
  const cell = size * 0.13;        // 标中心到角的距离
  const mkSize = Math.round(size * 0.045);
  const pad = Math.round(size * 0.02);
  const drawAruco = (cx, cy, id) => {
    const x = Math.round(cx - mkSize / 2 - pad);
    const y = Math.round(cy - mkSize / 2 - pad);
    const box = mkSize + pad * 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, box, box);
    if (cv && cv.Mat && cv.generateImageMarker) {
      const dict = cv.getPredefinedDictionary(cv[MARKER_DICT]);
      const m = new cv.Mat();
      cv.generateImageMarker(dict, id, mkSize, m, 1);
      cv.imshow(canvas, m); // 直接绘制到画布（含覆盖）
      m.delete();
      // imshow 会覆盖整张？opencv imshow 只绘制 marker 到 canvas 指定位置，这里用 drawImage 偏移
    } else {
      // 无 opencv 时的降级：画一个方块占位（无法被算法识别，仅用于视觉）
      ctx.fillStyle = '#000000';
      ctx.fillRect(cx - mkSize / 2, cy - mkSize / 2, mkSize, mkSize);
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.round(mkSize * 0.5)}px monospace`;
      ctx.fillText(String(id), cx - mkSize * 0.15, cy + mkSize * 0.2);
    }
  };

  // 注意：cv.imshow 会覆盖整个 canvas，因此改为先把 marker 画到临时 canvas 再 drawImage
  const drawArucoSafe = (cx, cy, id) => {
    const x = cx, y = cy;
    if (cv && cv.Mat && cv.generateImageMarker) {
      const dict = cv.getPredefinedDictionary(cv[MARKER_DICT]);
      const m = new cv.Mat();
      cv.generateImageMarker(dict, id, mkSize, m, 1);
      const tmp = document.createElement('canvas');
      tmp.width = m.cols; tmp.height = m.rows;
      cv.imshow(tmp, m);
      m.delete();
      const dx = Math.round(x - m.cols / 2 - pad);
      const dy = Math.round(y - m.rows / 2 - pad);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(dx, dy, m.cols + pad * 2, m.rows + pad * 2);
      ctx.drawImage(tmp, dx + pad, dy + pad);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - mkSize / 2 - pad, y - mkSize / 2 - pad, mkSize + pad * 2, mkSize + pad * 2);
      ctx.fillStyle = '#000000';
      ctx.fillRect(x - mkSize / 2, y - mkSize / 2, mkSize, mkSize);
    }
  };

  drawArucoSafe(cell, cell, MARKER_IDS.TL);
  drawArucoSafe(size - cell, cell, MARKER_IDS.TR);
  drawArucoSafe(cell, size - cell, MARKER_IDS.BL);
  drawArucoSafe(size - cell, size - cell, MARKER_IDS.BR);

  return canvas;
}

export default { generateSyntheticDetergentCanvas };
