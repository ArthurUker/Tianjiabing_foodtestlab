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

export function generateSyntheticDetergentCanvas(size = 2000) {
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

  // 方形定位标识矩阵：铺在比色卡区与样品区（模拟实体卡打印，用于遮挡推断验证）
  const drawGrid = (slot, grid) => {
    const ins = grid.inset;
    const x0 = (slot.x + slot.w * ins) * size, x1 = (slot.x + slot.w * (1 - ins)) * size;
    const y0 = (slot.y + slot.h * ins) * size, y1 = (slot.y + slot.h * (1 - ins)) * size;
    const gcell = Math.min((x1 - x0) / (grid.cols - 1), (y1 - y0) / (grid.rows - 1));
    const gs = Math.max(40, Math.round(gcell * 0.6));
    const gpad = Math.round((gcell - gs) / 2);
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const gx = x0 + (grid.cols === 1 ? (x1 - x0) / 2 : (x1 - x0) * (c / (grid.cols - 1)));
        const gy = y0 + (grid.rows === 1 ? (y1 - y0) / 2 : (y1 - y0) * (r / (grid.rows - 1)));
        drawArucoSafe(gx, gy, grid.baseId + r * grid.cols + c, gs + gpad * 2);
      }
    }
  };
  drawGrid(TEMPLATE.cardGrid, TEMPLATE.cardGrid);
  drawGrid(TEMPLATE.tubeGrid, TEMPLATE.tubeGrid);

  // 将灰度 ArUco Mat 绘制到临时 canvas 再 drawImage 到主画布，完全绕开 cv.imshow
  // （cv.imshow 对灰度 Mat→canvas 在浏览器 UMD 版行为不可靠，会覆盖整张画布）
  function matToCanvas(cv, m) {
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
      const tmp = matToCanvas(cv, m);
      m.delete();
      ctx.drawImage(tmp, x + pad, y + pad);
    } else {
      // 无 opencv 时的降级：画一个方块占位（无法被算法识别，仅用于视觉）
      ctx.fillStyle = '#000000';
      ctx.fillRect(cx - mkSize / 2, cy - mkSize / 2, mkSize, mkSize);
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.round(mkSize * 0.5)}px monospace`;
      ctx.fillText(String(id), cx - mkSize * 0.15, cy + mkSize * 0.2);
    }
  };

  // 网格标：同样先生成 Mat，转临时 canvas，再带静区 drawImage 到主画布
  const drawArucoSafe = (cx, cy, id, gsize, gpad) => {
    const x = cx, y = cy;
    const mk = (gsize != null) ? gsize : mkSize;
    const gp = (gpad != null) ? gpad : pad;
    if (cv && cv.Mat && cv.generateImageMarker) {
      const dict = cv.getPredefinedDictionary(cv[MARKER_DICT]);
      const m = new cv.Mat();
      cv.generateImageMarker(dict, id, mk, m, 1);
      const tmp = matToCanvas(cv, m);
      m.delete();
      const dx = Math.round(x - m.cols / 2 - gp);
      const dy = Math.round(y - m.rows / 2 - gp);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(dx, dy, m.cols + gp * 2, m.rows + gp * 2);
      ctx.drawImage(tmp, dx + gp, dy + gp);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - mk / 2 - gp, y - mk / 2 - gp, mk + gp * 2, mk + gp * 2);
      ctx.fillStyle = '#000000';
      ctx.fillRect(x - mk / 2, y - mk / 2, mk, mk);
    }
  };

  drawArucoSafe(cell, cell, MARKER_IDS.TL);
  drawArucoSafe(size - cell, cell, MARKER_IDS.TR);
  drawArucoSafe(cell, size - cell, MARKER_IDS.BL);
  drawArucoSafe(size - cell, size - cell, MARKER_IDS.BR);

  return canvas;
}

export default { generateSyntheticDetergentCanvas };
