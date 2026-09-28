// Idempotency middleware for Express —— 作用域绑定版（P3-W5-RECORD-T01 / AUD-002 / RC-01）
//
// 变更背景（AUD-002，BATCH 验证）：
//   旧实现 cacheKey = `${Idempotency-Key}:${bodyHash}`，**只有内容等价一个条件**：
//     · 不含租户 / 主体 / 资源 / 方法维度 → A 校（或另一个账号）用同 key + 同 body 会命中 B 校的缓存响应（跨主体泄漏）；
//     · 且中间件经 `router.use('/api/test-records'|'/api/records', …)` 挂在**认证之前** → 未认证/无权限请求也能读到缓存。
//   修复（RC-01「scoped state identity」在无 schema 变更前提下的落地）：
//     ① 身份键 = sha256(contractVersion | tenant | subject | resource | operationId)
//        —— tenant/subject **只从认证上下文推导**（req.user，由 authenticateUser 注入），不信请求体声明；
//     ② 规范化 payload hash 仅作**同键一致性校验**：同键异载荷 = 明确 409 冲突（不再是"另一条新请求"）；
//     ③ 中间件改挂在各写路由的 `authenticateUser, requireEditorOrAbove` **之后**（见 recordRoutes.js），
//        ⇒ 命中必然已经过当前认证与授权；权限被撤回的请求在命中之前就被拒（旧权限缓存不授予新权限）。
//
// R1 追加修复（P3-W5-RECORD-T01-R1 / R3 复审 RECORD 裁决 · 反例 2）：
//   上一版 `resourceScopeOf()` 只取**路由模板**（`req.route.path`，不含 path 参数实参）——
//   同一用户以同 key、同 body 对 `/api/records/oil/r1` 与 `/api/records/oil/r2` 发 PUT 时，
//   两条请求得到**同一身份**：第二条命中缓存、handler 未执行却拿到第一条的 200 `{id:'r1'}`。
//   现把**规范化后的具体资源标识**纳入身份（模板 + 实参路径 + 排序后的 path 参数）：
//     · r1 / r2 等不同具体资源 → 不同身份（各自执行，返回各自 id）；
//     · 同目标重试（同 key 同 body 同资源）→ 身份不变 → 仍去重；
//     · 同 key 异 body 同目标 → 仍 409（载荷一致性校验不变）。
//   `CONTRACT_VERSION` 随之升为 `idem.v2`（身份公式变更：旧进程内缓存条目不会以旧公式被误命中）。
//
// 已知边界（登记，不在本包范围）：
//   · store 仍是进程内 Map（NF-A-02）：多实例下不共享，键格式已按 RC-01 定型，引入共享存储时无需再改语义；
//   · tenant 身份当前用 `schoolCode`（schema 名同源）。RC-01 要求的 tenantImmutableId + tenantGeneration
//     需要 schema 变更（RC-04/RC-08·AUD-047 负责），届时只需替换 `tenantScopeOf()` 一处。
import crypto from 'crypto'

const store = new Map();
const TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 10000;        // NB-11: 最大条目数限制
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const PENDING_TIMEOUT = 60 * 1000; // pending 占位超时（防 handler 崩溃后占位永久阻塞同 key 请求）
const CONTRACT_VERSION = 'idem.v2';
const MAX_RESOURCE_LEN = 300;      // 具体资源标识长度上限（防超长 path 撑爆身份串/响应体）
let lastCleanupAt = 0;

/** 规范化：对象键排序、数组保序、其余原值 —— 保证 `{a:1,b:2}` 与 `{b:2,a:1}` 同哈希。 */
function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalizeValue(value[k]);
    return out;
  }
  return value;
}

/** 规范化 payload hash：仅用于「同键一致性校验」，不参与身份键。 */
export function payloadHashOf(body) {
  const normalized = JSON.stringify(normalizeValue(body === undefined ? null : body));
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/** 租户作用域：只信认证上下文；平台态（超管/无 schoolCode）显式标记，不用"缺失"表示任意学校。 */
export function tenantScopeOf(req) {
  const code = req?.user?.schoolCode;
  return code ? `school:${code}` : 'platform';
}

/** 主体作用域：userId / guestId 为不可变 id（用户名、token 串不作身份）。 */
export function subjectScopeOf(req) {
  if (req?.user?.userId) return `user:${req.user.userId}`;
  if (req?.user?.guestId) return `guest:${req.user.guestId}`;
  return 'anonymous';
}

/** 单个 path 段/参数值规范化：decode → 去控制字符 → 截断（身份只做哈希，不参与 SQL）。 */
function normalizeResourceSegment(value) {
  let s = String(value === undefined || value === null ? '' : value);
  try { s = decodeURIComponent(s); } catch { /* 保留原样（非法 % 转义） */ }
  // 去控制字符 + 折叠空白（防换行/制表符进入身份串与 409 响应体）
  s = s.replace(/[\u0000-\u001f\u007f]+/g, '').replace(/\s+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * 具体资源标识（AUD-002 R1 的核心）：**无 query/hash**、折叠斜杠、去尾斜杠、逐段规范化。
 * 优先 `originalUrl`（挂载后仍是完整路径），回退 `url`/`path`；长度封顶。
 */
export function concreteResourcePathOf(req) {
  const raw = (req && (req.originalUrl || req.url || req.path)) || '/';
  const pathOnly = String(raw).split('?')[0].split('#')[0].replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  const segments = (pathOnly || '/').split('/').filter((s) => s.length > 0).map(normalizeResourceSegment);
  const joined = `/${segments.join('/')}`;
  return joined.length > MAX_RESOURCE_LEN ? joined.slice(0, MAX_RESOURCE_LEN) : joined;
}

/**
 * 资源作用域（导出供路由/测试复用）：`METHOD <模板>#<具体资源>[#参数]`
 *   · 模板（`req.route.path`）+ baseUrl：路由语义（可读、便于诊断）；
 *   · 具体资源路径：**r1 与 r2 必须产生不同身份**（R1 修复点）；
 *   · path 参数（排序后）：兼容 `req.route` 存在但 `originalUrl` 被改写的调用形态。
 */
export function resourceScopeOf(req) {
  const routePath = (req.route && req.route.path) || req.path || '/';
  const base = req.baseUrl || '';
  const template = `${base}${routePath}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  const concrete = concreteResourcePathOf(req);
  let params = '';
  if (req.params && typeof req.params === 'object') {
    const keys = Object.keys(req.params).sort();
    if (keys.length) {
      params = `#${keys.map((k) => `${normalizeResourceSegment(k)}=${normalizeResourceSegment(req.params[k])}`).join(',')}`;
    }
  }
  return `${String(req.method || '').toUpperCase()} ${template}#${concrete}${params}`;
}

/**
 * 幂等作用域（导出供路由/测试复用）：
 * { tenant, subject, resource, operationId, identity }
 */
export function idempotencyScopeOf(req) {
  const tenant = tenantScopeOf(req);
  const subject = subjectScopeOf(req);
  const resource = resourceScopeOf(req);
  const operationId = String(
    (req.headers && (req.headers['idempotency-key'] || req.headers['Idempotency-Key'])) || ''
  ).trim();
  const identity = crypto
    .createHash('sha256')
    .update([CONTRACT_VERSION, tenant, subject, resource, operationId].join('|'))
    .digest('hex');
  return { tenant, subject, resource, operationId, identity };
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

export default function idempotencyMiddleware(req, res, next) {
  const key = (req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || '').toString().trim();
  // Only apply to mutating methods where idempotency is useful
  if (!key || !['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();

  cleanup();

  // AUD-002：身份键 = 作用域 + 操作 id（不再用 bodyHash 参与身份；body 仅做同键一致性校验）
  const scope = idempotencyScopeOf(req);
  const cacheKey = scope.identity;
  const requestPayloadHash = payloadHashOf(req.body);

  const cached = store.get(cacheKey);
  if (cached) {
    // 同键异载荷：明确冲突（RC-01：不能当新请求执行，也不能返回旧响应）
    if (cached.payloadHash !== requestPayloadHash) {
      return res.status(409).json({
        error: '同一 Idempotency-Key 已用于不同请求内容，拒绝执行',
        code: 'IDEMPOTENCY_KEY_REUSE_DIFFERENT_PAYLOAD',
        scope: { tenant: scope.tenant, subject: scope.subject, resource: scope.resource },
      });
    }
    // R2-02: 区分「处理中占位」与「已完成缓存结果」
    if (cached.pending) {
      // 并发请求命中处理中占位（TOCTOU 防护）：同 key 的另一请求正在处理。
      // 占位超时兜底：若 handler 崩溃未回写，超时后自动失效，避免永久 409。
      if (Date.now() - cached.timestamp > PENDING_TIMEOUT) {
        store.delete(cacheKey);
      } else {
        return res.status(409).json({ error: '请求正在处理中，请勿重复提交', code: 'IDEMPOTENCY_IN_FLIGHT' });
      }
    } else {
      // 命中者已在守卫之后（本中间件挂载点：authenticateUser → 授权 → 本中间件），
      // 故此处命中即代表"当前请求已通过当前认证与授权"（旧权限缓存不授予新权限）。
      console.log(`[Idempotency] scoped cache hit for ${scope.subject} @ ${scope.resource}`);
      res.status(cached.status || 200).json(cached.result);
      return;
    }
  }

  // NB-11: Map 大小达到上限时拒绝新缓存
  if (store.size >= MAX_ENTRIES) {
    return res.status(429).json({ error: 'Idempotency store is full, please retry later', code: 'IDEMPOTENCY_STORE_FULL' });
  }

  // R2-02: 先写入 pending 占位再放行，封堵 check-then-act 竞态窗口
  store.set(cacheKey, { pending: true, timestamp: Date.now(), payloadHash: requestPayloadHash, scope });

  const originalJson = res.json.bind(res);

  res.json = (body) => {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Cache successful responses
        store.set(cacheKey, { result: body, timestamp: Date.now(), status: res.statusCode, pending: false, payloadHash: requestPayloadHash, scope });
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

/** 仅供定点测试观测/隔离使用（不参与生产逻辑）。 */
export const __idempotencyInternals = {
  size: () => store.size,
  peek: (identity) => store.get(identity),
  clear: () => store.clear(),
  contractVersion: CONTRACT_VERSION,
};
