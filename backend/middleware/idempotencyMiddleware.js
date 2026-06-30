// Idempotency middleware for Express
// 注意：内存存储仅适用于单实例或低并发环境，生产建议使用 Redis

const store = new Map();
const TTL = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
let lastCleanupAt = 0;

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

export default function idempotencyMiddleware(req, res, next) {
  const key = (req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || '').toString();
  // Only apply to mutating methods where idempotency is useful
  if (!key || !['POST', 'PUT', 'DELETE'].includes(req.method)) return next();

  cleanup();

  const cached = store.get(key);
  if (cached) {
    console.log(`[Idempotency] returning cached result for ${key}`);
    res.status(cached.status || 200).json(cached.result);
    return;
  }

  const originalJson = res.json.bind(res);

  res.json = (body) => {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Cache successful responses
        store.set(key, { result: body, timestamp: Date.now(), status: res.statusCode });
      }
    } catch (e) {
      // ignore cache errors
      console.warn('[Idempotency] cache write failed', e.message);
    }
    return originalJson(body);
  };

  next();
}
