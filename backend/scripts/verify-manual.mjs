// 验证 recognizer 手动模式兼容 API（locateRegions / analyzeWithRegions / resizeToMaxEdge / labToRgb）
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const opencvPath = path.resolve(__dirname, '../node_modules/@techstark/opencv-js/dist/opencv.js');
const opencvBuild = require(opencvPath);

function getCv(m) {
  return new Promise((res) => {
    if (m && m.Mat) return res(m);
    if (m instanceof Promise) m.then(res);
    else m.onRuntimeInitialized = () => res(m);
  });
}

const cv = await getCv(opencvBuild);

const rec = await import('../../frontend/js/opencv/recognizer.js');
rec.setCv(cv);

// 合成一张 1000x1000 的图（灰底，无角标）走手动模式兜底
const h = 1000, w = 1000;
const buf = new Uint8ClampedArray(h * w * 4);
for (let i = 0; i < h * w; i++) { buf[i*4]=200; buf[i*4+1]=200; buf[i*4+2]=200; buf[i*4+3]=255; }
const mat = cv.matFromArray(h, w, cv.CV_8UC4, buf);

const img = { data: { buffer: buf.buffer }, width: w, height: h };
// 用 ImageData-like 走 resizeToMaxEdge
const id = { width: w, height: h, data: { buffer: buf.buffer } };

const comp = await rec.resizeToMaxEdge(mat, 1600);
console.log('[resizeToMaxEdge] returned Mat?', comp instanceof cv.Mat, comp instanceof cv.Mat ? `${comp.cols}x${comp.rows}` : 'original');

// 手动区域：cardRect 在左半，tube 在右下
const regions = {
  canvasSize: { width: w, height: h },
  tube: { x: 700, y: 400, w: 200, h: 200 },
  tubeZone: 'manual',
  blocks: Array.from({length:7}, (_,i)=>({ x: 50+i*120, y:100, w:90, h:200, concentration: [0,0.05,0.1,0.2,0.5,1,2][i] })),
};
const res = await rec.analyzeWithRegions(mat, { concentrations: [0,0.05,0.1,0.2,0.5,1,2] }, regions);
console.log('[analyzeWithRegions] ok?', res.ok, 'mainValue:', res.mainValueText, 'deltaE:', res.deltaE, 'conf:', res.confidence);
console.log('[analyzeWithRegions] sampleColor(RGB):', res.sampleColor);
console.log('[labToRgbExport]', rec.labToRgbExport({L:128,a:0,b:0}));
console.log('MANUAL API OK');
