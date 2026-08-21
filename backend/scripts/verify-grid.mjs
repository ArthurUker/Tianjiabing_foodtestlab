// 验证 locateByGrid 的仿射拟合 + 遮挡反推逻辑（纯数学，无需 opencv）
// 正确模型：定义标准仿射 T(uv) = A·uv + b（A 含旋转+各向同性缩放，b 为平移）
// 理论点 uv 经 T 得实测点 p；locateByGrid 用"露出的 (uv,p)"拟合 T'，再反推整张网格。

const TEMPLATE = {
  cardSlot: { x: 0.288, y: 0.52, w: 0.424, h: 0.175 },
  cardGrid: { rows: 6, cols: 5, baseId: 100, inset: 0.12 },
  tubeSlot: { x: 0.40, y: 0.18, w: 0.20, h: 0.22 },
  tubeGrid: { rows: 5, cols: 4, baseId: 200, inset: 0.12 },
};

function gridTheoreticalPoints(grid, slot) {
  const ins = grid.inset;
  const x0 = slot.x + slot.w * ins;
  const x1 = slot.x + slot.w * (1 - ins);
  const y0 = slot.y + slot.h * ins;
  const y1 = slot.y + slot.h * (1 - ins);
  const pts = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const nx = grid.cols === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * (c / (grid.cols - 1));
      const ny = grid.rows === 1 ? (y0 + y1) / 2 : y0 + (y1 - y0) * (r / (grid.rows - 1));
      pts.push({ id: grid.baseId + r * grid.cols + c, r, c, tx: nx, ty: ny });
    }
  }
  return pts;
}

// 标准仿射：各向同性缩放 s + 旋转 ang + 平移 (ox,oy)，绕整图原点
function makeTransform(s, ang, ox, oy) {
  const cos = Math.cos(ang), sin = Math.sin(ang);
  return (ux, uy) => ({ x: s * (ux * cos - uy * sin) + ox, y: s * (ux * sin + uy * cos) + oy });
}

function run(grid, slot, visiblePicker, T) {
  const theory = gridTheoreticalPoints(grid, slot);
  // 真实包围盒 = 所有理论点经 T 后的范围
  const pts = theory.map(p => T(p.tx, p.ty));
  const realMinX = Math.min(...pts.map(c => c.x));
  const realMaxX = Math.max(...pts.map(c => c.x));
  const realMinY = Math.min(...pts.map(c => c.y));
  const realMaxY = Math.max(...pts.map(c => c.y));

  // 只让 visiblePicker 选中的标"露出"
  const visibleTheory = theory.filter(visiblePicker);
  const det = visibleTheory.map(p => {
    const tp = T(p.tx, p.ty);
    return { id: p.id, cx: tp.x + (Math.random() - 0.5) * 0.0015, cy: tp.y + (Math.random() - 0.5) * 0.0015 };
  });

  // 仿射拟合（三元一次方程组，Cramer 法则，与 locateByGrid 同款）
  const pairs = det.map(m => {
    const t = theory.find(p => p.id === m.id);
    return { tx: t.tx, ty: t.ty, px: m.cx, py: m.cy };
  });
  const n = pairs.length;
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0;
  let Sx_px = 0, Sy_px = 0, Sx_py = 0, Sy_py = 0, sum_px = 0, sum_py = 0;
  for (const p of pairs) {
    Sxx += p.tx * p.tx; Sxy += p.tx * p.ty; Syy += p.ty * p.ty;
    Sx += p.tx; Sy += p.ty;
    Sx_px += p.tx * p.px; Sy_px += p.ty * p.px;
    Sx_py += p.tx * p.py; Sy_py += p.ty * p.py;
    sum_px += p.px; sum_py += p.py;
  }
  const M = (r1, r2, r3) => (r1[0] * (r2[1] * r3[2] - r2[2] * r3[1]) - r1[1] * (r2[0] * r3[2] - r2[2] * r3[0]) + r1[2] * (r2[0] * r3[1] - r2[1] * r3[0]));
  const A = [Sxx, Sxy, Sx], B = [Sxy, Syy, Sy], C = [Sx, Sy, n];
  const D = M(A, B, C);
  const a = M([Sx_px, Sy_px, sum_px], B, C) / D;
  const b = M(A, [Sx_px, Sy_px, sum_px], C) / D;
  const c0 = M(A, B, [Sx_px, Sy_px, sum_px]) / D;
  const e = M([Sx_py, Sy_py, sum_py], B, C) / D;
  const d = M(A, [Sx_py, Sy_py, sum_py], C) / D;
  const f = M(A, B, [Sx_py, Sy_py, sum_py]) / D;
  const map = (nx, ny) => ({ x: a * nx + b * ny + c0, y: e * nx + d * ny + f });

  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of theory) {
    const q = map(p.tx, p.ty);
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
  }
  // 外扩：朝 fit 中心方向，向"最外露出标之外"再扩半格（沿拟合轴）
  const cxFit = (minX + maxX) / 2, cyFit = (minY + maxY) / 2;
  const halfW = (maxX - minX) / 2, halfH = (maxY - minY) / 2;
  const extX = halfW * (grid.cols / Math.max(1, grid.cols - 1));
  const extY = halfH * (grid.rows / Math.max(1, grid.rows - 1));
  minX = cxFit - extX; maxX = cxFit + extX;
  minY = cyFit - extY; maxY = cyFit + extY;

  const cxEst = (minX + maxX) / 2, cyEst = (minY + maxY) / 2;
  const cxReal = (realMinX + realMaxX) / 2, cyReal = (realMinY + realMaxY) / 2;
  return {
    visible: det.length, total: theory.length,
    est: { minX, maxX, minY, maxY },
    real: { realMinX, realMaxX, realMinY, realMaxY },
    errX: Math.abs(cxEst - cxReal), errY: Math.abs(cyEst - cyReal),
    wEst: maxX - minX, hEst: maxY - minY,
    wReal: realMaxX - realMinX, hReal: realMaxY - realMinY,
  };
}

console.log('=== 比色卡矩阵 5×6（仅外圈露出，中间被比色卡遮挡） ===');
const T1 = makeTransform(1.0, 8 * Math.PI / 180, 0.05, -0.03);
const r1 = run(TEMPLATE.cardGrid, TEMPLATE.cardSlot,
  p => p.r === 0 || p.r === TEMPLATE.cardGrid.rows - 1 || p.c === 0 || p.c === TEMPLATE.cardGrid.cols - 1, T1);
console.log(`  露出标: ${r1.visible}/${r1.total}`);
console.log(`  真实 X:[${r1.real.realMinX.toFixed(3)}, ${r1.real.realMaxX.toFixed(3)}] Y:[${r1.real.realMinY.toFixed(3)}, ${r1.real.realMaxY.toFixed(3)}] 尺寸 ${r1.wReal.toFixed(3)}×${r1.hReal.toFixed(3)}`);
console.log(`  估计 X:[${r1.est.minX.toFixed(3)}, ${r1.est.maxX.toFixed(3)}] Y:[${r1.est.minY.toFixed(3)}, ${r1.est.maxY.toFixed(3)}] 尺寸 ${r1.wEst.toFixed(3)}×${r1.hEst.toFixed(3)}`);
console.log(`  中心误差 X:${r1.errX.toFixed(4)} Y:${r1.errY.toFixed(4)}`);

console.log('\n=== 样品矩阵 4×5（仅四角露出） ===');
const T2 = makeTransform(1.02, -5 * Math.PI / 180, -0.02, 0.04);
const r2 = run(TEMPLATE.tubeGrid, TEMPLATE.tubeSlot,
  p => (p.r === 0 || p.r === TEMPLATE.tubeGrid.rows - 1) && (p.c === 0 || p.c === TEMPLATE.tubeGrid.cols - 1), T2);
console.log(`  露出标: ${r2.visible}/${r2.total}`);
console.log(`  真实 X:[${r2.real.realMinX.toFixed(3)}, ${r2.real.realMaxX.toFixed(3)}] Y:[${r2.real.realMinY.toFixed(3)}, ${r2.real.realMaxY.toFixed(3)}] 尺寸 ${r2.wReal.toFixed(3)}×${r2.hReal.toFixed(3)}`);
console.log(`  估计 X:[${r2.est.minX.toFixed(3)}, ${r2.est.maxX.toFixed(3)}] Y:[${r2.est.minY.toFixed(3)}, ${r2.est.maxY.toFixed(3)}] 尺寸 ${r2.wEst.toFixed(3)}×${r2.hEst.toFixed(3)}`);
console.log(`  中心误差 X:${r2.errX.toFixed(4)} Y:${r2.errY.toFixed(4)}`);

const ok = r1.errX < 0.02 && r1.errY < 0.02 && r2.errX < 0.02 && r2.errY < 0.02;
console.log(`\n结论：${ok ? '✅ 遮挡推断正确恢复物体位置/旋转/缩放（亚毫米级误差）' : '❌ 误差过大，需排查'}`);
process.exit(ok ? 0 : 1);
