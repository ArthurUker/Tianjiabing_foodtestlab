/**
 * admin-schools 控制台 · 共享 UI 工具（P-Refactor）。
 */

/** HTML 转义：所有 innerHTML 拼接的动态内容必须经过此函数（签名与原 adminSidebar.js 内联版一致）。 */
export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
