// tenantWriteBarrier.js — 恢复窗口的**应用侧写屏障**（P3-W3-T01 / AUD-005）
//
// 背景（Phase 2 结论）：影子恢复的 STAGING → SWITCHING 窗口内，目标学校的业务写入
// 在切换后会被丢弃（写到旧 schema，切换后不再可见）。此前只有「人工预设 READONLY_MODE +
// Caddy respond 503」这套人工流程，恢复流程自身不联动任何写入阻断。
//
// 本模块提供两级屏障（都由恢复状态机在进入 STAGING 前安装、任务结束后拆除）：
//   ① 精确屏障（per-school）：按学校代码注册，写请求命中该校即 503 + Retry-After；
//      由 `createWriteBarrierMiddleware()` 消费——挂载点见 RESULT.md 的 DESIGN BLOCKER
//      （`backend/server.js` 属保护项，本轮不修改；模块已导出中间件与精确判定）。
//   ② 既有全局开关复用（READONLY_MODE）：恢复窗口内由引擎置 true（结束后按进入前的值还原），
//      立即对**已挂载**的 readOnlyMiddleware 生效，覆盖全部 HTTP 写路径；
//      这是零改动接入路径（不动 deploy/Caddy，也不动 server.js）。
//
// 边界（必须显式声明）：HTTP 层屏障不能阻断后台任务与直连写入；
// 正确性底座仍是「PG advisory lock 互斥 + in-flight drain + 归属复核」，屏障是三层中的一层。

const TAG = '[tenantWriteBarrier]'

/** schoolCode → { jobId, since, reason }（仅本进程可见；跨进程状态见台账/锁）。 */
const barriers = new Map()

/** 全局维护开关的令牌栈（token → 进入前的 READONLY_MODE 原值）。 */
const maintenanceStack = []

/** 安装精确写屏障（schoolCode 必填；重复安装同一学校 → 拒绝，防任务交叉）。 */
export function beginWriteBarrier({ schoolCode, jobId, reason = 'restore' }) {
  if (!schoolCode || typeof schoolCode !== 'string') throw new Error(`${TAG} beginWriteBarrier 需要 schoolCode`)
  if (!jobId || typeof jobId !== 'string') throw new Error(`${TAG} beginWriteBarrier 需要 jobId`)
  const existing = barriers.get(schoolCode)
  if (existing && existing.jobId !== jobId) {
    throw new Error(`${TAG} 学校 ${schoolCode} 已有写屏障（jobId=${existing.jobId}），拒绝交叉安装`)
  }
  barriers.set(schoolCode, { jobId, since: new Date().toISOString(), reason })
  return { schoolCode, ...barriers.get(schoolCode) }
}

/** 拆除写屏障：只有**安装它的同一个 jobId** 才能拆除（防误释放他人屏障）。 */
export function endWriteBarrier({ schoolCode, jobId }) {
  const existing = barriers.get(schoolCode)
  if (!existing) return { released: false, reason: 'not_found' }
  if (jobId && existing.jobId !== jobId) return { released: false, reason: 'job_mismatch', activeJobId: existing.jobId }
  barriers.delete(schoolCode)
  return { released: true, jobId: existing.jobId }
}

export function isWriteBarrierActive(schoolCode) {
  return barriers.has(schoolCode)
}

export function writeBarrierSnapshot() {
  return [...barriers.entries()].map(([schoolCode, v]) => ({ schoolCode, ...v }))
}

/**
 * 复用既有 READONLY_MODE 开关（进入时置 true，释放最后一张令牌时还原原值）。
 * 嵌套调用安全：只有栈空时才还原，且还原的是**最早**一次进入前的值。
 */
export function enterGlobalMaintenance({ token, reason = 'restore' }) {
  const t = token || `maint-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
  const previous = process.env.READONLY_MODE
  maintenanceStack.push({ token: t, previous, reason, enteredAt: new Date().toISOString() })
  process.env.READONLY_MODE = 'true'
  return { token: t, previous: previous === undefined ? null : previous }
}

export function exitGlobalMaintenance(token) {
  const idx = maintenanceStack.findIndex((e) => e.token === token)
  if (idx === -1) return { released: false, reason: 'token_not_found' }
  const [entry] = maintenanceStack.splice(idx, 1)
  if (maintenanceStack.length === 0) {
    if (entry.previous === undefined) delete process.env.READONLY_MODE
    else process.env.READONLY_MODE = entry.previous
    return { released: true, restored: entry.previous === undefined ? null : entry.previous }
  }
  return { released: true, restored: 'maintained_by_outer_token' }
}

export function globalMaintenanceSnapshot() {
  return { active: maintenanceStack.length > 0, tokens: maintenanceStack.map((e) => ({ token: e.token, reason: e.reason, enteredAt: e.enteredAt })) }
}

/**
 * 从请求解析目标学校代码（用于精确屏障判定）。顺序：
 *   ① 认证用户所属学校（req.user.schoolCode）；
 *   ② 路径前缀 `/<schoolCode>/...`（多租户路径重写前的形态）；
 *   ③ query `?school=`。
 * 纯函数，可单测。
 */
export function resolveRequestSchoolCode(req) {
  const direct = req?.user?.schoolCode
  if (typeof direct === 'string' && direct) return direct
  const pathValue = typeof req?.path === 'string' ? req.path : ''
  const m = pathValue.match(/^\/([a-z0-9-]{1,40})(?:\/|$)/)
  if (m && !['api', 'css', 'js', 'assets', 'dist', 'health', 'favicon.ico'].includes(m[1])) return m[1]
  const q = req?.query?.school
  if (typeof q === 'string' && /^[a-z0-9-]{1,40}$/.test(q)) return q
  return null
}

/**
 * 写屏障中间件：非 GET/HEAD/OPTIONS 请求在以下任一条件成立时返回 503：
 *   · 全局维护开关 READONLY_MODE=true（与 readOnlyMiddleware 语义一致）；
 *   · 请求目标的学校正在恢复（精确屏障）。
 * 挂载示例（需 server.js 接线，见 DESIGN BLOCKER 注记）：
 *   app.use(createWriteBarrierMiddleware())
 */
export function createWriteBarrierMiddleware({ exemptPrefixes = ['/api/health'] } = {}) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
    if (exemptPrefixes.some((p) => req.path.startsWith(p))) return next()
    if (process.env.READONLY_MODE === 'true') {
      return res.status(503).json({ success: false, code: 'GLOBAL_MAINTENANCE', error: '系统维护中（数据恢复），请稍后重试' })
    }
    const schoolCode = resolveRequestSchoolCode(req)
    if (schoolCode && barriers.has(schoolCode)) {
      const b = barriers.get(schoolCode)
      res.setHeader('Retry-After', '5')
      return res.status(503).json({
        success: false,
        code: 'TENANT_WRITE_BARRIER',
        error: `学校 ${schoolCode} 数据恢复中（写入暂时不可用），请稍后重试`,
        jobId: b.jobId,
      })
    }
    return next()
  }
}

/** 仅供测试/诊断：清空屏障状态（不触碰 READONLY_MODE）。 */
export function __resetWriteBarrierStateForTests() {
  barriers.clear()
  maintenanceStack.length = 0
}
