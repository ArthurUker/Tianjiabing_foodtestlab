// backend/scripts/diag-perid.mjs
// 对每个 id 单独生成+检测，确认 generateImageMarker 对不同 id 是否正常。
import cvModule from '@techstark/opencv-js';
import { MARKER_DICT } from '../../js/opencv/recognizer.js';

function getCv(m) {
  return new Promise((res) => {
    if (m && m.Mat) return res(m);
    if (m instanceof Promise) m.then(res);
    else m.onRuntimeInitialized = () => res(m);
  });
}

async function main() {
  const cv = await getCv(cvModule);
  const dict = cv.getPredefinedDictionary(cv[MARKER_DICT]);
  for (const pid of [0, 1, 2, 3]) {
    const m = new cv.Mat();
    cv.generateImageMarker(dict, pid, 200, m, 1);
    const pad = 80, cell = 200 + pad * 2;
    const cc = new cv.Mat(cell, cell, cv.CV_8UC1, [255, 0, 0, 0]);
    m.copyTo(cc.roi(new cv.Rect(pad, pad, m.cols, m.rows)));
    const rgb = new cv.Mat();
    cv.cvtColor(cc, rgb, cv.COLOR_GRAY2RGB);
    const gray = new cv.Mat();
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const dp = new cv.aruco_DetectorParameters();
    const rp = new cv.aruco_RefineParameters(10, 3.0, true);
    const det = new cv.aruco_ArucoDetector(dict, dp, rp);
    const corners = new cv.MatVector();
    const ids = new cv.Mat();
    const rej = new cv.MatVector();
    det.detectMarkers(gray, corners, ids, rej);
    const n = ids.total();
    console.log(`pid=${pid} -> detected=${n} ids=${Array.from(ids.data32S || []).slice(0, n)}`);
    m.delete(); cc.delete(); rgb.delete(); gray.delete();
    dp.delete(); rp.delete(); det.delete(); corners.delete(); ids.delete(); rej.delete();
  }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
