// backend/scripts/verify-opencv.mjs
// 验证 @techstark/opencv-js 在 Node 下可加载，并测试 aruco 字典 + 基础 Mat 操作。
// 用途：确认后端识别地基可用（aruco MIP_36h12、Mat、cvtColor 到 Lab）。
import cvModule from '@techstark/opencv-js';

function getCv(cvModule) {
  return new Promise((resolve) => {
    if (cvModule && cvModule.Mat) return resolve(cvModule);
    if (cvModule instanceof Promise) {
      cvModule.then((cv) => resolve(cv));
    } else {
      cvModule.onRuntimeInitialized = () => resolve(cvModule);
    }
  });
}

async function main() {
  const cv = await getCv(cvModule);
  console.log('[verify] opencv ready, version:', cv.getBuildInformation ? 'ok' : 'n/a');

  // 1) aruco 字典：MIP_36h12 在 OpenCV5 对应 DICT_ARUCO_MIP_36
  const dictName = 'DICT_ARUCO_MIP_36';
  const dict = cv.getPredefinedDictionary(cv[dictName]);
  console.log('[verify] dictionary created:', !!dict, dictName);

  // 2) 基础 Mat 创建 + 取色到 Lab
  const mat = new cv.Mat(10, 10, cv.CV_8UC3, [120, 200, 80, 0]);
  console.log('[verify] Mat created rows/cols:', mat.rows, mat.cols);

  const lab = new cv.Mat();
  cv.cvtColor(mat, lab, cv.COLOR_RGB2Lab);
  console.log('[verify] cvtColor RGB->Lab ok, type:', lab.type());
  mat.delete();
  lab.delete();

  // 3) 探测器构造（OpenCV5 需 3 参数：dict, detectorParams, refineParams）
  const detectorParams = new cv.aruco_DetectorParameters();
  const refineParams = new cv.aruco_RefineParameters(10, 3.0, true);
  const detector = new cv.aruco_ArucoDetector(dict, detectorParams, refineParams);
  console.log('[verify] ArucoDetector created:', !!detector);

  // 4) 尝试在一张空白图上 detectMarkers（应返回 0 个，验证调用链路）
  const gray = new cv.Mat(200, 200, cv.CV_8UC1, [255, 0, 0, 0]);
  const corners = new cv.MatVector();
  const ids = new cv.Mat();
  const rejected = new cv.MatVector();
  detector.detectMarkers(gray, corners, ids, rejected);
  console.log('[verify] detectMarkers ran, found:', ids.rows, 'markers on blank image');
  gray.delete(); corners.delete(); ids.delete(); rejected.delete();

  console.log('[verify] ALL OK');
}

main().catch((e) => {
  console.error('[verify] FAILED:', e);
  process.exit(1);
});
