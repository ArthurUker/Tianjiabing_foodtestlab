// ====== adminSchools 页面共享上下文（依赖注入 + 统一请求）======
// 页面装配时注入 authService / getApiBaseUrl（替代原 window 全局暴露）。
// 各视图统一使用 adminFetch / apiBase / authHeaders，不再自行拼 token。

let authService = null;
let getApiBaseUrl = null;

export function initAdminContext({ authService: a, getApiBaseUrl: b }) {
    authService = a;
    getApiBaseUrl = b;
}

export function getAuthService() {
    return authService;
}

// 原页面顶层 const API_BASE 的函数化形态（模块加载早于注入，不能做顶层常量）
export function apiBase() {
    return getApiBaseUrl ? getApiBaseUrl() : '';
}

// backupView.js 直接调用 getApiBase() / getAuthToken()（见 backupView.js:16,233-234），
// 这里补齐同名导出，避免模块因「缺少导出」而整体加载失败（Uncaught SyntaxError）。
// getApiBase() 等价于 apiBase()；getAuthToken() 委托已注入的 authService.getToken()。
export function getApiBase() {
    return apiBase();
}

export function getAuthToken() {
    return authService ? authService.getToken() : null;
}

// 统一 JSON 请求头（原内联 authHeaders 的等价收敛）
export function authHeaders() {
    const token = authService ? authService.getToken() : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

// fetch + 自动拼 API 根地址并注入 Authorization（GET 也带 Content-Type，与原页面行为一致）
export async function adminFetch(url, options = {}) {
    const token = authService ? authService.getToken() : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(getApiBaseUrl() + url, Object.assign({}, options, { headers: Object.assign({}, headers, options.headers || {}) }));
}
