// utils/schoolCode.js — 方案A 租户标识提取（访问层唯一依赖"路径/域名"的代码位置）
//
// 设计原则（见多租户访问与识别机制设计方案 §2.2）：
//   业务代码不直接依赖"路径"或"域名"这一具体实现细节，仅依赖本文件返回的 schoolCode。
//   未来从无域名（路径前缀）切换到子域名时，只需替换 extractSchoolCode 内部实现，
//   其余逻辑与标识来源无关，迁移成本最小化。

/**
 * 从 URL 识别 schoolCode（访问层唯一依赖"路径/域名"的代码位置）。
 *
 * 解析优先级（明确规则，生成端 buildSchoolLoginUrl 与解析端必须一致）：
 *   1) 路径前缀：/<code>/... → code。约定「学校代码即 URL 首段」（单一事实来源：
 *      学校代码 = 部署基路径首段），如 /demo/login.html → "demo"。
 *      ⚠️ 仅匹配单一层级基路径；多层挂载（/apps/demo/login.html）会误取首段 "apps"，
 *      属不支持拓扑，部署时请保证学校代码即路径首段（与系统 tenantProvisioner 约定一致）。
 *   2) 查询参数兜底：?school=...。用于根部署或路径前缀不可用时显式指定。
 *
 * 路径优先于查询的设计意图（安全）：路径前缀由部署/路由控制，用户不可随意篡改租户；
 * 查询参数由前端拼接或用户手工修改，仅作兜底。即便用户把 ?school=xxx 改成别的学校，
 * 后端登录仍以「该校 schema 内校验用户名+密码 + 租户归属校验」为准，不会跨租户认证。
 *
 * ⚠️ 大小写敏感：正则仅允许小写 [a-z0-9-]，故 /Demo/... 路径无法命中，回退查询参数；
 * 若未带 ?school= 则返回 null（登录将因 schoolCode 非法被后端拒绝，而非静默回退默认学校）。
 * ⚠️ 保留前缀：schoolCode 不得为 "api"（与 /api/ 路由冲突，后端已用 (?!api/) 负向预查保护）。
 *
 * @param {string} [pathname] 路径，默认取当前页面路径
 * @param {string} [search] 查询串，默认取当前页面查询串
 * @returns {string|null} schoolCode 或 null（无标识时走 dev/test 共享 schema）
 */
export function extractSchoolCode(pathname = window.location.pathname, search = window.location.search) {
    const fromPath = pathname.match(/^\/([a-z0-9-]+)\//)
    if (fromPath) return fromPath[1]
    const fromQuery = new URLSearchParams(search).get('school')
    return fromQuery || null
}

/**
 * 生成某学校的登录页地址（生成端，与 extractSchoolCode 解析端共用同一约定）。
 * 约定：沿用当前页面所在「部署基路径」拼接 login.html，并附带 ?school=<code> 兜底参数。
 *   - 基路径推导：取 pathname 去掉末尾文件名得到目录（如 /demo/admin-schools.html → /demo/）。
 *     这样无论部署在根（/）还是子路径（/demo/），生成的 login.html 与控制台同目录，
 *     浏览器可见路径即 /<base>login.html，extractSchoolCode 按路径前缀正确识别租户。
 *   - ?school= 兜底：即便基路径推导与实际挂载不一致，查询参数也能让解析端拿到正确 code。
 * @param {string} code 学校代码
 * @param {{pathname?:string,origin?:string}} [opts] 测试可注入 pathname/origin，默认取 window.location
 * @returns {string} 完整登录地址
 */
export function buildSchoolLoginUrl(code, opts = {}) {
    const pathname = opts.pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '')
    const origin = opts.origin ?? (typeof window !== 'undefined' ? window.location.origin : '')
    const c = String(code || '').replace(/^school_/, '').replace(/_/g, '-')
    const base = pathname.replace(/[^/]*$/, '') // 当前页面目录，兼容子路径部署
    return `${origin}${base}login.html?school=${encodeURIComponent(c)}`
}

// 未来切换域名后的实现（仅替换本函数，业务无需改动）：
// export function extractSchoolCode() {
//     return window.location.hostname.split('.')[0]
// }
