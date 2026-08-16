/**
 * admin-schools 控制台 · 共享依赖上下文（P-Refactor）。
 *
 * 页面主 module script 在认证守卫通过后调用 initAdminContext() 注入
 * authService / getApiBaseUrl；本目录其余模块统一经由 adminFetch / getApiBase /
 * getAuthToken 获取服务与令牌，消除此前散落在各视图里的 window.* 全局依赖与
 * 7 处重复的取 token 样板代码。
 */
let authService = null;
let apiBaseUrlFn = null;

export function initAdminContext({ authService: svc, getApiBaseUrl }) {
    authService = svc || null;
    apiBaseUrlFn = typeof getApiBaseUrl === 'function' ? getApiBaseUrl : null;
}

export function getAuthService() {
    return authService;
}

export function getApiBase() {
    return apiBaseUrlFn ? apiBaseUrlFn() : '';
}

export function getAuthToken() {
    if (authService && typeof authService.getToken === 'function') return authService.getToken();
    return (authService && authService.token) || '';
}

/**
 * 带认证头的 API 请求帮手。
 * 统一行为：Content-Type + Authorization Bearer；调用方可通过 options.headers 覆盖。
 */
export function adminFetch(path, options = {}) {
    return fetch(getApiBase() + path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + getAuthToken(),
            ...(options.headers || {}),
        },
    });
}
