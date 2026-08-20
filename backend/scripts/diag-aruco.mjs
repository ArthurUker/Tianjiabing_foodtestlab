// backend/scripts/diag-aruco.mjs (OpenCV 5.0)
// 精准诊断 5.0 aruco：drawMarker+静区 -> detectMarkers，定位是调用问题还是模块问题。
import cvModule from '@techstark/opencv-js';

function getCv(m) {
  return new Promise((res) => {
    if (m && m.Mat) return res(m);
    if (m instanceof Promise) m.then(res);
    else m.onRuntimeInitialized = () => res(m);
  });
}

async function main() {
  const cv = await getCv(cvModule);
  console.log('[diag] cv ready');

  const dictName = 'DICT_ARUCO_MIP_36';
  const dict = cv.getPredefinedDictionary(cv[dictName]);

  // 生成 4 个带静区的 marker，拼大图
  const W = 1000, H = 1000;
  const big = new cv.Mat(H, W, cv.CV_8UC3, [255, 255, 255, 0]);
  const mkSize = 200, pad = 80, cell = mkSize + pad * 2;
  const pos = [[60, 60], [W - 60 - cell, 60], [60, H - 60 - cell], [W - 60 - cell, H - 60 - cell]];
  const grayMarks = [];
  for (const pid of [0, 1, 2, 3]) {
    const m = new cv.Mat();
    cv.generateImageMarker(dict, pid, mkSize, m, 1);
    const cc = new cv.Mat(cell, cell, cv.CV_8UC1, [255, 0, 0, 0]);
    m.copyTo(cc.roi(new cv.Rect(pad, pad, m.cols, m.rows)));
    // 转 RGB 贴大图
    const rgb = new cv.Mat();
    cv.cvtColor(cc, rgb, cv.COLOR_GRAY2RGB);
    const [x, y] = pos[pid];
    rgb.copyTo(big.roi(new cv.Rect(x, y, cell, cell)));
    grayMarks.push(cc); rgb.delete(); m.delete();
  }

  // 检测
  const gray = new cv.Mat();
  cv.cvtColor(big, gray, cv.COLOR_RGB2GRAY);
  const dp = new cv.aruco_DetectorParameters();
  const rp = new cv.aruco_RefineParameters(10, 3.0, true);
  const det = new cv.aruco_ArucoDetector(dict, dp, rp);
  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rej = new cv.MatVector();
  det.detectMarkers(gray, corners, ids, rej);
  const n = ids.total();
  console.log('[diag] detected:', n, 'ids:', Array.from(ids.data32S || []).slice(0, n));
  console.log('[diag] rejected contours:', rej.size());

  gray.delete(); dp.delete(); rp.delete(); det.delete();
  corners.delete(); ids.delete(); rej.delete();
  big.delete(); grayMarks.forEach(g => g.delete());
}
main().catch((e) => { console.error('[diag] FAIL', e); process.exit(1); });
