// backend/scripts/verify-marker.mjs (OpenCV 4.12)
// 验证 4.x aruco API：检测可用 + 确认 ArucoDetector 构造签名。
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
  console.log('[t] opencv loaded', cv.getVersionString ? cv.getVersionString() : 'n/a');

  const dictName = 'DICT_ARUCO_MIP_36';
  const dict = cv.getPredefinedDictionary(cv[dictName]);
  console.log('[t] dict ready');

  // 4.x: aruco 在 cv.aruco 命名空间；drawMarker 在 cv.aruco.drawMarker
  const id = 0;
  const m = new cv.Mat();
  cv.aruco.drawMarker(dict, id, 200, m, 1);
  // 加白色静区
  const pad = 60, sz = m.rows + pad * 2;
  const canvas = new cv.Mat(sz, sz, cv.CV_8UC1, [255, 0, 0, 0]);
  m.copyTo(canvas.roi(new cv.Rect(pad, pad, m.cols, m.rows)));

  const W = 1000, H = 1000;
  const big = new cv.Mat(H, W, cv.CV_8UC1, [255, 0, 0, 0]);
  const pos = [[60, 60], [740, 60], [60, 740], [740, 740]];
  const pad2 = 60, sz2 = 200 + pad2 * 2;
  for (const pid of [0, 1, 2, 3]) {
    const mm = new cv.Mat();
    cv.aruco.drawMarker(dict, pid, 200, mm, 1);
    const cc = new cv.Mat(sz2, sz2, cv.CV_8UC1, [255, 0, 0, 0]);
    mm.copyTo(cc.roi(new cv.Rect(pad2, pad2, mm.cols, mm.rows)));
    const [x, y] = pos[pid];
    cc.copyTo(big.roi(new cv.Rect(x, y, cc.cols, cc.rows)));
    mm.delete(); cc.delete();
  }

  // 4.x 检测 API 尝试
  let det, detectorParams;
  try {
    detectorParams = new cv.aruco.DetectorParameters();
    det = new cv.aruco.ArucoDetector(dict, detectorParams);
    console.log('using cv.aruco.ArucoDetector(dict, params)');
  } catch (e) {
    try {
      det = new cv.aruco.ArucoDetector(dict);
      console.log('using cv.aruco.ArucoDetector(dict)');
    } catch (e2) {
      console.log('ArucoDetector ctor failed:', e2.message);
    }
  }

  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rej = new cv.MatVector();
  det.detectMarkers(big, corners, ids, rej);
  const n = ids.total();
  console.log('detected:', n, 'ids:', Array.from(ids.data32S || []).slice(0, n));

  m.delete(); canvas.delete(); big.delete();
  if (detectorParams) detectorParams.delete();
  if (det) det.delete();
  corners.delete(); ids.delete(); rej.delete();
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
