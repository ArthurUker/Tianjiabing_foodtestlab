// 验证新 TEMPLATE：DICT_6X6_1000 + 外扩矩阵（比色卡区 9x11=99 id100-198，样品区 7x9=63 id300-362）
// 1) 全部标生成+检测  2) 模拟比色卡盖住 cardSlot 中央，验证外围标露出可定位
import cvModule from '@techstark/opencv-js';

function getCv(m){return new Promise(r=>{if(m&&m.Mat)return r(m);if(m instanceof Promise)m.then(r);else m.onRuntimeInitialized=()=>r(m);});}

// 复制 recognizer 的 TEMPLATE（保持同步）
const MARKER_DICT = 'DICT_6X6_1000';
const TEMPLATE = {
  markers: { TL:{x:0.13,y:0.13}, TR:{x:0.87,y:0.13}, BL:{x:0.13,y:0.87}, BR:{x:0.87,y:0.87} },
  tubeSlot: { x:0.40, y:0.18, w:0.20, h:0.22 },
  cardSlot: { x:0.288, y:0.52, w:0.424, h:0.175 },
  cardGrid: { x:0.255, y:0.49, w:0.49, h:0.235, rows:7, cols:9, baseId:100, inset:0.08 },
  tubeGrid: { x:0.365, y:0.14, w:0.27, h:0.30, rows:9, cols:7, baseId:300, inset:0.08 },
};

function gridPts(grid){
  const ins=grid.inset, x0=grid.x+grid.w*ins, x1=grid.x+grid.w*(1-ins), y0=grid.y+grid.h*ins, y1=grid.y+grid.h*(1-ins);
  const pts=[];
  for(let r=0;r<grid.rows;r++)for(let c=0;c<grid.cols;c++){
    const nx=grid.cols===1?(x0+x1)/2:x0+(x1-x0)*(c/(grid.cols-1));
    const ny=grid.rows===1?(y0+y1)/2:y0+(y1-y0)*(r/(grid.rows-1));
    pts.push({id:grid.baseId+r*grid.cols+c, nx, ny});
  }
  return pts;
}

async function main(){
  const cv = await getCv(cvModule);
  const dict = cv.getPredefinedDictionary(cv[MARKER_DICT]);
  const W=1588,H=2246;
  const big=new cv.Mat(H,W,cv.CV_8UC3,[255,255,255,0]);

  const place=(id,cx,cy,mk)=>{
    const m=new cv.Mat(); cv.generateImageMarker(dict,id,mk,m,1);
    const x=Math.round(cx-m.cols/2),y=Math.round(cy-m.rows/2);
    const rgb=new cv.Mat(); cv.cvtColor(m,rgb,cv.COLOR_GRAY2RGB);
    rgb.copyTo(big.roi(new cv.Rect(x,y,m.cols,m.rows)));
    m.delete(); rgb.delete();
  };

  // 四角
  const cs=220;
  place(0,cs,cs,cs); place(1,W-cs,cs,cs); place(2,cs,H-cs,cs); place(3,W-cs,H-cs,cs);

  // 矩阵
  const mk=50;
  const cardPts=gridPts(TEMPLATE.cardGrid);
  const tubePts=gridPts(TEMPLATE.tubeGrid);
  const allPts=[...cardPts,...tubePts];

  // 模拟比色卡盖住 cardSlot 中央：只画"不在 cardSlot 内"的标（露出的）
  const inSlot=(nx,ny)=> nx>=TEMPLATE.cardSlot.x && nx<=TEMPLATE.cardSlot.x+TEMPLATE.cardSlot.w && ny>=TEMPLATE.cardSlot.y && ny<=TEMPLATE.cardSlot.y+TEMPLATE.cardSlot.h;
  let exposed=0, covered=0;
  for(const p of cardPts){
    if(inSlot(p.nx,p.ny)) covered++; else exposed++;
    place(p.id, p.nx*W, p.ny*H, mk); // 实际打印时所有标都画，这里仅统计
  }
  for(const p of tubePts) place(p.id, p.nx*W, p.ny*H, mk);

  // 检测
  const gray=new cv.Mat(); cv.cvtColor(big,gray,cv.COLOR_RGB2GRAY);
  const dp=new cv.aruco_DetectorParameters();
  const rp=new cv.aruco_RefineParameters(10,3.0,true);
  const det=new cv.aruco_ArucoDetector(dict,dp,rp);
  const corners=new cv.MatVector(), ids=new cv.Mat(), rej=new cv.MatVector();
  det.detectMarkers(gray,corners,ids,rej);
  const found=Array.from(ids.data32S||[]).sort((a,b)=>a-b);
  // 真实模拟遮挡：过滤掉 cardSlot 内的 id（被比色卡盖住，检测不到）
  const coveredIds=new Set(cardPts.filter(p=>inSlot(p.nx,p.ny)).map(p=>p.id));
  const realFound=found.filter(id=>!coveredIds.has(id));

  console.log('总标数:', allPts.length, '(比色卡',cardPts.length,'样品',tubePts.length,')');
  console.log('比色卡区被盖住(中央):', covered, ' 露出(外围):', exposed);
  console.log('检测全部:', found.length, ' (应≈全部,验证生成)');
  console.log('模拟遮挡后真实可见:', realFound.length);
  console.log('比色卡矩阵可见:', realFound.filter(i=>i>=100&&i<100+99).length, '/30 需>=4 可定位');
  console.log('样品矩阵可见:', realFound.filter(i=>i>=300&&i<300+63).length);

  gray.delete();dp.delete();rp.delete();det.delete();corners.delete();ids.delete();rej.delete();big.delete();
}
main().catch(e=>{console.error('FAIL',e);process.exit(1);});
