// Idempotency middleware for Express
// 注意：内存存储仅适用于单实例或低并发环境，生产建议使用 Redis

import crypto from 'crypto'

const store = new Map();
const TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 10000;        // NB-11: 最大条目数限制
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
let lastCleanupAt = 0;

function bodyHash(body) {
  if (!body) return '';
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

function cleanup() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL) {
    return;
  }

  lastCleanupAt = now;
  for (const [k, v] of store.entries()) {
    if (now - v.timestamp > TTL) store.delete(k);
  }
}

const PENDING_TIMEOUT = 60 * 1000; // pending 占位超时（防 handler 崩溃后占位永久阻塞同 key 请求）

export default function idempotencyMiddleware(req, res, next) {
  const key = (req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || '').toString();
  // Only apply to mutating methods where idempotency is useful
  if (!key || !['POST', 'PUT', 'DELETE'].includes(req.method)) return next();

  cleanup();

  // NB-11: 将请求体哈希纳入缓存键，防止同 key 不同 body 的请求命中错误缓存
  const cacheKey = `${key}:${bodyHash(req.body)}`;

  const cached = store.get(cacheKey);
  if (cached) {
    // R2-02: 区分「处理中占位」与「已完成缓存结果」
    if (cached.pending) {
      // 并发请求命中处理中占位（TOCTOU 防护）：同 key 的另一请求正在处理。
      // 占位超时兜底：若 handler 崩溃未回写，超时后自动失效，避免永久 409。
      if (Date.now() - cached.timestamp > PENDING_TIMEOUT) {
        store.delete(cacheKey);
      } else {
        return res.status(409).json({ error: '请求正在处理中，请勿重复提交' });
      }
    } else {
      console.log(`[Idempotency] returning cached result for ${key}`);
      res.status(cached.status || 200).json(cached.result);
      return;
    }
  }

  // NB-11: Map 大小达到上限时拒绝新缓存
  if (store.size >= MAX_ENTRIES) {
    return res.status(429).json({ error: 'Idempotency store is full, please retry later' });
  }

  // R2-02: 先写入 pending 占位再放行，封堵 check-then-act 竞态窗口
  store.set(cacheKey, { pending: true, timestamp: Date.now() });

  const originalJson = res.json.bind(res);

  res.json = (body) => {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Cache successful responses
        store.set(cacheKey, { result: body, timestamp: Date.now(), status: res.statusCode, pending: false });
      } else {
        // 失败响应：删除占位，允许客户端修正后重试
        store.delete(cacheKey);
      }
    } catch (e) {
      // ignore cache errors
      console.warn('[Idempotency] cache write failed', e.message);
    }
    return originalJson(body);
  };

  next();
}
