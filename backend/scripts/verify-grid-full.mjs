// 端到端验证：用 DICT_6X6_250 生成「打印卡」（四角标0-3 + 比色卡矩阵100-129 + 样品矩阵200-219），再 detectMarkers 确认全部可回读。
import cvModule from '@techstark/opencv-js';

function getCv(m){return new Promise(r=>{if(m&&m.Mat)return r(m);if(m instanceof Promise)m.then(r);else m.onRuntimeInitialized=()=>r(m);});}

async function main(){
  const cv = await getCv(cvModule);
  const dictName = 'DICT_6X6_250';
  const dict = cv.getPredefinedDictionary(cv[dictName]);

  const W = 1588, H = 2246; // 2x A4
  const big = new cv.Mat(H, W, cv.CV_8UC3, [255,255,255,0]);

  const place = (id, cx, cy, mk) => {
    const m = new cv.Mat();
    cv.generateImageMarker(dict, id, mk, m, 1);
    const x = Math.round(cx - m.cols/2), y = Math.round(cy - m.rows/2);
    const rgb = new cv.Mat(); cv.cvtColor(m, rgb, cv.COLOR_GRAY2RGB);
    rgb.copyTo(big.roi(new cv.Rect(x, y, m.cols, m.rows)));
    m.delete(); rgb.delete();
  };

  // 四角标
  const cs = 220;
  place(0, cs, cs, cs); place(1, W-cs, cs, cs);
  place(2, cs, H-cs, cs); place(3, W-cs, H-cs, cs);

  // 比色卡矩阵 5x6 (id 100..129)
  const cx0=Math.round(W*0.29), cy0=Math.round(H*0.52), cw=Math.round(W*0.42), ch=Math.round(H*0.175);
  const mk=44;
  for(let r=0;r<6;r++)for(let c=0;c<5;c++){
    const gx=cx0+cw*(0.12+0.76*c/4), gy=cy0+ch*(0.12+0.76*r/5);
    place(100+r*5+c, gx, gy, mk);
  }
  // 样品矩阵 4x5 (id 200..219)
  const tx0=Math.round(W*0.30), ty0=Math.round(H*0.27), tw=Math.round(W*0.40), th=Math.round(H*0.12);
  for(let r=0;r<5;r++)for(let c=0;c<4;c++){
    const gx=tx0+tw*(0.12+0.76*c/3), gy=ty0+th*(0.12+0.76*r/4);
    place(200+r*4+c, gx, gy, mk);
  }

  // 检测
  const gray = new cv.Mat(); cv.cvtColor(big, gray, cv.COLOR_RGB2GRAY);
  const dp = new cv.aruco_DetectorParameters();
  const rp = new cv.aruco_RefineParameters(10, 3.0, true);
  const det = new cv.aruco_ArucoDetector(dict, dp, rp);
  const corners = new cv.MatVector(), ids = new cv.Mat(), rej = new cv.MatVector();
  det.detectMarkers(gray, corners, ids, rej);
  const found = Array.from(ids.data32S || []).sort((a,b)=>a-b);
  console.log('检测总数:', found.length);
  console.log('四角(0-3):', found.filter(i=>i<=3));
  console.log('比色卡矩阵(100-129):', found.filter(i=>i>=100&&i<=129).length, '个');
  console.log('样品矩阵(200-219):', found.filter(i=>i>=200&&i<=219).length, '个');
  console.log('完整 id 列表:', JSON.stringify(found));

  // 清理
  gray.delete(); dp.delete(); rp.delete(); det.delete();
  corners.delete(); ids.delete(); rej.delete(); big.delete();
}
main().catch(e=>{console.error('FAIL',e);process.exit(1);});
