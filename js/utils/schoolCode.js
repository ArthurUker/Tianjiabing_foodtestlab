// utils/schoolCode.js — 方案A 租户标识提取（访问层唯一依赖"路径/域名"的代码位置）
//
// 设计原则（见多租户访问与识别机制设计方案 §2.2）：
//   业务代码不直接依赖"路径"或"域名"这一具体实现细节，仅依赖本文件返回的 schoolCode。
//   未来从无域名（路径前缀）切换到子域名时，只需替换 extractSchoolCode 内部实现，
//   其余逻辑与标识来源无关，迁移成本最小化。

/**
 * 从 URL 识别 schoolCode（访问层唯一依赖"路径/域名"的代码位置）。
 * 当前阶段（IP + 端口，无域名）：/school-a/login → "school-a"
 * 回退：查询参数 ?school=...，兼容未配置路径重写的静态服务器 / 本地开发。
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

// 未来切换域名后的实现（仅替换本函数，业务无需改动）：
// export function extractSchoolCode() {
//     return window.location.hostname.split('.')[0]
// }
