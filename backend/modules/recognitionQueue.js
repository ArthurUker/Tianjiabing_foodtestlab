// backend/modules/recognitionQueue.js
// 识别任务队列：同一时间只处理 1 个学校的请求，其余入队并返回排队位置。
// 任务状态存内存 Map，支持轮询查询。
//
// 实现说明：在 Node 主线程串行处理（非 Worker 线程）。原因：OpenCV 5 JS 的
// cv.imread 在 Worker 线程内因文件/网络 API 受限会卡死；主线程已验证可正常
// imread + recognize。队列串行保证同一时刻只跑 1 个识别，HTTP 轮询请求仍可被
// 事件循环处理（recognize 内部有多个 await 让出）。

import cvModule from '@techstark/opencv-js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { recognize, setCv } from '../../js/opencv/recognizer.js';

function getCv(m) {
  return new Promise((res) => {
    if (m && m.Mat) return res(m);
    if (m instanceof Promise) m.then(res);
    else m.onRuntimeInitialized = () => res(m);
  });
}

const QUEUE_TIMEOUT_MS = 5 * 60 * 1000; // 排队/处理超过 5 分钟报错（按 Q4 决策）

class RecognitionQueue {
  constructor() {
    this.cv = null;
    this.ready = false;
    this.queue = [];          // 等待中的任务 { jobId, image, concentrations, enqueuedAt }
    this.processing = null;   // 正在处理的任务
    this.jobs = new Map();    // jobId -> { status, position, result, error, humanMessage, createdAt }
    this.seq = 0;
    this._initPromise = this._init();
  }

  async _init() {
    try {
      const cv = await getCv(cvModule);
      setCv(cv);
      this.cv = cv;
      this.ready = true;
      console.log('[recognitionQueue] opencv ready');
      this._pump(); // 引擎就绪后启动队列处理
    } catch (e) {
      console.error('[recognitionQueue] opencv init failed:', e && e.stack ? e.stack : e);
    }
  }

  async _decode(image) {
    const cv = this.cv;
    // 像素数组格式（前端 canvas getImageData 提供）：{ rgba: ArrayBuffer, width, height }
    if (image.rgba && image.width && image.height) {
      const bytes = new Uint8Array(image.rgba);
      const mat = cv.matFromArray(image.height, image.width, cv.CV_8UC4, bytes);
      return mat;
    }
    // base64 dataUrl（API 上传，recognitionRoutes.js 传入 { dataUrl: image }）
    // 前端固定输出 PNG dataUrl，用 pngjs 解码为像素数组后走 matFromArray。
    // 避免使用 cv.imread：OpenCV 5 JS 在 Node 端依赖 document.createElement('canvas') 会失败。
    if (image.dataUrl && typeof image.dataUrl === 'string') {
      const b64 = image.dataUrl.includes(',') ? image.dataUrl.split(',')[1] : image.dataUrl;
      const buf = Buffer.from(b64, 'base64');
      const png = PNG.sync.read(buf);
      const rgba = cv.matFromArray(png.height, png.width, cv.CV_8UC4, png.data);
      if (!rgba || rgba.empty()) throw new Error('dataUrl 解码失败');
      return rgba;
    }
    // 文件路径：Node 端 OpenCV 5 JS 的 imread 依赖浏览器 canvas 不可用，
    // 此处保留 filePath 兼容，但生产推荐前端传 rgba 像素。
    if (image.filePath) {
      const mat = cv.imread(image.filePath);
      if (!mat || mat.empty()) throw new Error('图片解码失败');
      return mat;
    }
    throw new Error('不支持的图片数据格式（需 rgba 像素数组 / dataUrl / filePath）');
  }

  async _process(task) {
    let mat = null;
    try {
      if (!this.ready) throw new Error('识别引擎尚未就绪');
      mat = await this._decode(task.image);
      const result = await recognize(mat, { concentrations: task.concentrations });
      this._setJob(task.jobId, { status: 'done', result });
    } catch (e) {
      this._setJob(task.jobId, { status: 'failed', error: 'recognize_failed', humanMessage: String(e && e.message ? e.message : e) });
    } finally {
      if (mat && typeof mat.delete === 'function' && !mat.isDeleted()) mat.delete();
      this.processing = null;
      this._pump();
    }
  }

  _setJob(jobId, patch) {
    const cur = this.jobs.get(jobId) || {};
    this.jobs.set(jobId, { ...cur, ...patch });
  }

  _pump() {
    if (this.processing || this.queue.length === 0) return;
    if (!this.ready) return;
    const task = this.queue.shift();
    this.processing = task;
    this._setJob(task.jobId, { status: 'processing', position: 0 });
    // 异步处理（不 await，让事件循环继续处理轮询请求）
    this._process(task);
  }

  // 提交一个识别任务，返回 { jobId, status, position, queued }
  submit(image, concentrations) {
    const jobId = `rec_${Date.now()}_${++this.seq}`;
    this.jobs.set(jobId, { status: 'queued', position: this.queue.length + (this.processing ? 1 : 0), createdAt: Date.now() });
    const task = { jobId, image, concentrations, enqueuedAt: Date.now() };
    this.queue.push(task);
    this.queue.forEach((t, i) => this._setJob(t.jobId, { position: i + 1 }));
    if (!this.processing) this._setJob(jobId, { status: 'processing', position: 0 });
    this._pump();
    return { jobId, status: this.jobs.get(jobId).status, position: this.jobs.get(jobId).position };
  }

  // 查询任务状态
  status(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return { status: 'not_found' };
    if ((job.status === 'queued' || job.status === 'processing') && Date.now() - (job.createdAt || 0) > QUEUE_TIMEOUT_MS) {
      return { status: 'failed', error: 'timeout', humanMessage: '识别任务超时（>5分钟），请重试' };
    }
    return job;
  }
}

const queue = new RecognitionQueue();
export default queue;
export { RecognitionQueue };
