// 测试报告模块共享工具（API 封装 + 状态徽章/颜色映射 + 证据渲染）
import { adminFetch } from '../context.js';
import { escapeHtml } from '../ui.js';

// ── 状态映射（对齐检测记录列表的视觉语义）──
export const STATUS_META = {
    passed:    { label: '通过',     emoji: '✅', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    failed:    { label: '失败',     emoji: '❌', badge: 'bg-rose-100 text-rose-700 border-rose-200' },
    skipped:   { label: '跳过',     emoji: '⏭️', badge: 'bg-amber-100 text-amber-700 border-amber-200' },
    pending:   { label: '未测',     emoji: '⏳', badge: 'bg-gray-100 text-gray-600 border-gray-200' },
    closed:    { label: '已收口',   emoji: '🔒', badge: 'bg-blue-100 text-blue-700 border-blue-200' },
    fixed:     { label: '待复测',   emoji: '🔔', badge: 'bg-orange-100 text-orange-700 border-orange-200' },
};

export const SOURCE_META = {
    task:  { label: '任务', emoji: '📋', badge: 'bg-sky-100 text-sky-700 border-sky-200' },
    issue: { label: '反馈', emoji: '🐞', badge: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200' },
};

// ── API 封装（统一错误处理 + JSON 解析）──
export async function apiGet(path) {
    const res = await adminFetch(path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
    return data;
}

export async function apiPost(path, body) {
    const res = await adminFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
    return data;
}

// ── 状态徽章 HTML（用 escapeHtml 防注入）──
export function statusBadge(result, opts = {}) {
    const { closed = false, fixedPending = false } = opts;
    if (closed) {
        const m = STATUS_META.closed;
        return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs ${m.badge}">${m.emoji} ${m.label}</span>`;
    }
    let html = '';
    if (fixedPending) {
        const m = STATUS_META.fixed;
        html += `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs ${m.badge}">${m.emoji} ${m.label}</span> `;
    }
    const m = STATUS_META[result] || STATUS_META.pending;
    html += `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs ${m.badge}">${m.emoji} ${m.label}</span>`;
    return html;
}

export function sourceBadge(source) {
    const m = SOURCE_META[source] || SOURCE_META.task;
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs ${m.badge}">${m.emoji} ${m.label}</span>`;
}

// ── 证据图片渲染（evidence 是 JSON 数组字符串）──
export function renderEvidence(evidenceStr, opts = {}) {
    if (!evidenceStr) return '';
    let urls = [];
    try { urls = JSON.parse(evidenceStr); } catch { /* 非数组，忽略 */ }
    if (!Array.isArray(urls) || urls.length === 0) return '';
    const { maxShow = 4, size = 'h-12 w-12' } = opts;
    const shown = urls.slice(0, maxShow);
    const extra = urls.length - shown.length;
    let html = '<div class="flex flex-wrap gap-1.5">';
    for (const u of shown) {
        html += `<a href="${escapeHtml(u)}" target="_blank" class="block ${size} rounded border border-gray-200 overflow-hidden bg-gray-50"><img src="${escapeHtml(u)}" class="h-full w-full object-cover" alt="证据"></a>`;
    }
    if (extra > 0) html += `<span class="text-xs text-gray-500 self-center">+${extra}</span>`;
    html += '</div>';
    return html;
}

// ── 时间格式化（相对时间，简洁）──
export function timeAgo(date) {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
    return d.toLocaleDateString('zh-CN');
}
