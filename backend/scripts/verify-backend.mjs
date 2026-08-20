// backend/scripts/verify-backend.mjs
// 验证后端识别链路：队列 + Worker + 共享 recognizer。
// 生成合成图 -> base64 -> recognitionQueue.submit -> 轮询 status -> 打印结果。
import recognitionQueue from '../modules/recognitionQueue.js';
import { CONCENTRATIONS } from '../../js/opencv/recognizer.js';
import fs from 'node:fs';
import { PNG } from 'pngjs';

async function main() {
  // 用一张真实上传图片验证后端全链路（队列+解码+recognize）
  // 该图无角标，预期返回 marker_count 错误（验证链路通畅 + 错误处理正确）
  const imgPath = '../dist/docs/test-results/latest/evidence/V1-肉蛋/1786436392302_b17e5eb7.png';
  if (!fs.existsSync(imgPath)) { console.error('测试图片不存在'); process.exit(1); }
  const png = PNG.sync.read(fs.readFileSync(imgPath));
  const rgba = Buffer.from(png.data); // RGBA

  console.log('[backend] ready state:', recognitionQueue.ready);
  console.log('[backend] submitting job (real image, no markers expected)...');
  const job = recognitionQueue.submit({ rgba: rgba.buffer, width: png.width, height: png.height }, CONCENTRATIONS);
  console.log('[backend] job submitted:', job);

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const st = recognitionQueue.status(job.jobId);
    if (st.status === 'done' || st.status === 'failed') {
      console.log('[backend] FINAL:', JSON.stringify(st, null, 2));
      recognitionQueue.stop?.();
      process.exit(st.status === 'done' ? 0 : 1);
    }
    console.log(`[backend] poll ${i}: status=${st.status} pos=${st.position}`);
  }
  console.log('[backend] timeout waiting');
  recognitionQueue.stop?.();
  process.exit(1);
}
main().catch((e) => { console.error('FAIL', e); process.exit(1); });
