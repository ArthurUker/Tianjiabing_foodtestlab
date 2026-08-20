// backend/routes/recognitionRoutes.js
// 洗涤剂比色识别 API（后端 opencv 方案，单 Worker 排队处理）
//
//   POST /api/recognize          — 提交照片（base64 JSON），入队，返回 jobId + 排队位置
//   GET  /api/recognize/status/:jobId — 轮询任务状态/结果
//
// 设计（按已确认决策）：
//   - 同一时间只处理 1 个学校请求，其余返回"排队中"提示（position 字段）
//   - 后端只返回识别结果 JSON，前端用户确认后再存 PostgreSQL
//   - 排队超过 5 分钟才报错（见 recognitionQueue.js QUEUE_TIMEOUT_MS）

import express from 'express';
import recognitionQueue from '../modules/recognitionQueue.js';
import { createAuthMiddleware } from '../middleware/authMiddleware.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // base64 解码后 ≤ 8MB

export function createRecognitionRoutes(userManager, prisma) {
  const router = express.Router();
  const { authenticateUser } = createAuthMiddleware(userManager, prisma);
  router.use(authenticateUser);

  // 识别队列在 recognitionQueue 模块加载时已在构造函数内自动初始化（_init 中启动 _pump），
  // 无需手动调用 start()。移除旧调用以修复 "recognitionQueue.start is not a function" 崩溃。

  // POST /api/recognize
  router.post('/recognize', (req, res) => {
    try {
      const { image, concentrations } = req.body || {};
      if (!image || typeof image !== 'string') {
        return res.status(400).json({ ok: false, error: 'invalid_image', humanMessage: '请上传图片（base64）' });
      }
      // 校验 base64 大小
      const b64 = image.includes(',') ? image.split(',')[1] : image;
      const approxBytes = Math.ceil((b64.length * 3) / 4);
      if (approxBytes > MAX_IMAGE_BYTES) {
        return res.status(413).json({ ok: false, error: 'image_too_large', humanMessage: '图片过大（≤8MB）' });
      }
      const job = recognitionQueue.submit({ dataUrl: image }, concentrations);
      if (job.status === 'queued' || job.position > 0) {
        return res.json({
          ok: true,
          jobId: job.jobId,
          status: 'queued',
          position: job.position,
          humanMessage: `当前有 ${job.position} 个任务排队中，请稍候`,
        });
      }
      return res.json({ ok: true, jobId: job.jobId, status: 'processing', position: 0 });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'submit_failed', humanMessage: String(e.message || e) });
    }
  });

  // GET /api/recognize/status/:jobId
  router.get('/recognize/status/:jobId', (req, res) => {
    const job = recognitionQueue.status(req.params.jobId);
    if (job.status === 'not_found') {
      return res.status(404).json({ ok: false, error: 'not_found', humanMessage: '任务不存在' });
    }
    if (job.status === 'done') {
      return res.json({ ok: true, status: 'done', result: job.result });
    }
    if (job.status === 'failed') {
      return res.json({ ok: false, status: 'failed', error: job.error, humanMessage: job.humanMessage });
    }
    // queued / processing
    return res.json({ ok: true, status: job.status, position: job.position || 0, humanMessage: job.status === 'queued' ? `排队中，前方 ${job.position} 个任务` : '识别处理中' });
  });

  return router;
}
