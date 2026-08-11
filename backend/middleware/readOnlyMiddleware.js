// readOnlyMiddleware.js — 维护模式写阻断（P1）
//
// 背景：影子恢复的 SWITCHING（schema rename）临界窗口不应有业务写入落到错误目标。
// 网关层（Caddy respond 503）只拦"到达网关的请求"；本中间件在应用层拦截所有写请求，
// 覆盖【不经网关的后台写路径】之外的一切 HTTP 写入，双层阻断（见 docs/deployment/backup-module.md）。
//
// 用法：server.js 全局挂载（在路由之前）。READONLY_MODE=true 时：
//   - 所有非 GET/HEAD/OPTIONS 请求返回 503
//   - 豁免路径（如 /api/health 供监控存活探测）
// 内部后台任务（如吊销清理、selfHeal）不受此中间件约束，需在任务入口自行检查 READONLY_MODE。

export function createReadOnlyGuard({ exemptPrefixes = ['/api/health'] } = {}) {
  return (req, res, next) => {
    if (process.env.READONLY_MODE !== 'true') return next()
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
    if (exemptPrefixes.some((p) => req.path.startsWith(p))) return next()
    return res.status(503).json({ success: false, error: '系统维护中（数据恢复），请稍后重试' })
  }
}
