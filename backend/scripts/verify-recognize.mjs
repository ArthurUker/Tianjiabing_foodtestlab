// backend/scripts/verify-recognize.mjs (OpenCV 5.0)
// 用正确静区合成图验证 recognize() 完整成功路径。
import cvModule from '@techstark/opencv-js';
import { recognize, setCv, MARKER_DICT, CONCENTRATIONS } from '../../frontend/js/opencv/recognizer.js';

function getCv(m) {
  return new Promise((res) => {
    if (m && m.Mat) return res(m);
    if (m instanceof Promise) m.then(res);
    else m.onRuntimeInitialized = () => res(m);
  });
}

function drawMarker(cv, img, markerId, x, y, cell) {
  const dict = cv.getPredefinedDictionary(cv[MARKER_DICT]);
  const pad = 80;
  const m = new cv.Mat();
  cv.generateImageMarker(dict, markerId, 200, m, 1);
  const mkSize = m.cols;
  // 断言：marker 生成后自身黑像素
  let selfDark = 0;
  for (let yy = 0; yy < m.rows; yy++) for (let xx = 0; xx < m.cols; xx++) if (m.ucharAt(yy, xx) < 128) selfDark++;
  const rgb = new cv.Mat();
  cv.cvtColor(m, rgb, cv.COLOR_GRAY2RGB);
  cv.rectangle(img, new cv.Point(x, y), new cv.Point(x + cell, y + cell), [255, 255, 255, 0], -1);
  rgb.copyTo(img.roi(new cv.Rect(x + pad, y + pad, mkSize, mkSize)));
  console.log(`[drawMarker] id=${markerId} at(${x},${y}) mSize=${mkSize} selfDark=${selfDark}`);
  m.delete(); rgb.delete(); dict.delete();
}

async function main() {
  const cv = await getCv(cvModule);
  setCv(cv);

  const W = 1000, H = 1000;
  const img = new cv.Mat(H, W, cv.CV_8UC3, [255, 255, 255, 0]);
  const cell = 180;
  const mpos = 40, mfar = W - 40 - 200 - 80; // 确保 x+pad(80)+mkSize(200) <= W
  drawMarker(cv, img, 0, mpos, mpos, cell);                       // TL
  drawMarker(cv, img, 1, mfar, mpos, cell);                       // TR
  drawMarker(cv, img, 2, mpos, mfar, cell);                       // BL
  drawMarker(cv, img, 3, mfar, mfar, cell);                       // BR

  if (process.env.WITH_BLOCKS === '1') {
  // 比色卡 7 块：中央安全带 y[430,570]，完全避开四角 marker
  const cardY = 430, cardH = 140;
  const cardX = 200, cardW = 600;
  const blockW = cardW / 7;
  for (let i = 0; i < 7; i++) {
    const v = Math.round(210 - i * 22);
    cv.rectangle(img, new cv.Point(cardX + i * blockW, cardY),
      new cv.Point(cardX + (i + 1) * blockW, cardY + cardH), [v, v, v, 0], -1);
  }
  // 样品区：中央带内
  const tubeX = 420, tubeY = 430, tubeW = 160, tubeH = 140;
  cv.rectangle(img, new cv.Point(tubeX, tubeY), new cv.Point(tubeX + tubeW, tubeY + tubeH),
    [140, 140, 140, 0], -1);
  }

  // 统计 4 个 marker 区域黑像素，确认是否都画上
  {
    const g2 = new cv.Mat();
    cv.cvtColor(img, g2, cv.COLOR_RGB2GRAY);
    const cell = 360;
    const pos = [[40, 40], [W - 40 - cell, 40], [40, H - 40 - cell], [W - 40 - cell, H - 40 - cell]];
    for (const [x, y] of pos) {
      let dark = 0;
      for (let yy = y + 80; yy < y + 280; yy++)
        for (let xx = x + 80; xx < x + 280; xx++)
          if (g2.ucharAt(yy, xx) < 128) dark++;
      console.log(`[verify:region] @(${x},${y}) dark=${dark}`);
    }
    g2.delete();
  }

  // 独立检测一次（复制诊断脚本逻辑）对比
  {
    const gray = new cv.Mat();
    cv.cvtColor(img, gray, cv.COLOR_RGB2GRAY);
    const dict = cv.getPredefinedDictionary(cv[MARKER_DICT]);
    const dp = new cv.aruco_DetectorParameters();
    const rp = new cv.aruco_RefineParameters(10, 3.0, true);
    const det = new cv.aruco_ArucoDetector(dict, dp, rp);
    const corners = new cv.MatVector();
    const ids = new cv.Mat();
    const rej = new cv.MatVector();
    det.detectMarkers(gray, corners, ids, rej);
    console.log('[verify:independent] detected:', ids.total(), 'ids:', Array.from(ids.data32S || []).slice(0, ids.total()));
    gray.delete(); dp.delete(); rp.delete(); det.delete(); corners.delete(); ids.delete(); rej.delete(); dict.delete();
  }

  console.error('[verify] before recognize, img size', img.cols, img.rows);
  let result;
  try {
    result = await recognize(img, { concentrations: CONCENTRATIONS });
    console.log('[recognize] result:', JSON.stringify(result, null, 2));
  } catch (e) {
    console.log('[recognize] ERROR:', e && e.stack ? e.stack : e);
  }

  img.delete();
  if (!result || !result.ok) process.exit(1);
}
main().catch((e) => { console.error('[recognize] FAILED', e); process.exit(1); });
