// 验证 generateImageMarker 两种调用的差异：预分配 vs 空 Mat
import cvModule from '@techstark/opencv-js';

function getCv(m) {
  return new Promise((res) => {
    if (m && m.Mat) return res(m);
    if (m instanceof Promise) m.then(res);
    else m.onRuntimeInitialized = () => res(m);
  });
}

// 统计 Mat 里非全同值（即黑白图案）的占比
function patternStats(cv, m) {
  const gray = new cv.Mat();
  if (m.channels() === 3) cv.cvtColor(m, gray, cv.COLOR_RGB2GRAY); else m.copyTo(gray);
  const d = gray.data; let black = 0, white = 0, other = 0;
  for (let i = 0; i < d.length; i++) { if (d[i] < 40) black++; else if (d[i] > 215) white++; else other++; }
  gray.delete();
  return { rows: m.rows, cols: m.cols, blackPct: (black / d.length * 100).toFixed(1), whitePct: (white / d.length * 100).toFixed(1), otherPct: (other / d.length * 100).toFixed(1) };
}

async function main() {
  const cv = await getCv(cvModule);
  const dict = cv.getPredefinedDictionary(cv['DICT_ARUCO_MIP_36']);
  const mkSize = 80; // 模拟前端小码尺寸

  // 方式 A：前端当前写法，预分配固定尺寸
  try {
    const mA = cv.Mat.zeros(mkSize, mkSize, cv.CV_8UC1);
    cv.generateImageMarker(dict, 0, mkSize, mA, 1);
    console.log('[A] 预分配 Mat.zeros:', JSON.stringify(patternStats(cv, mA)), '非空:', !mA.empty());
    mA.delete();
  } catch (e) { console.log('[A] 预分配抛错:', e.message); }

  // 方式 B：空 Mat（后端 diag 写法）
  try {
    const mB = new cv.Mat();
    cv.generateImageMarker(dict, 0, mkSize, mB, 1);
    console.log('[B] 空 Mat:', JSON.stringify(patternStats(cv, mB)), '非空:', !mB.empty());
    mB.delete();
  } catch (e) { console.log('[B] 空 Mat 抛错:', e.message); }
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
