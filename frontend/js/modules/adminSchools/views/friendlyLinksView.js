/*
* 友情链接视图（2026-09-28）
* ------------------------------------------------------------
* 控制台左侧「友情链接」入口：维护登录页（login.html）登录卡下方的外链胶囊。
*
* 背景：该入口原为 login.html 内硬编码的单条外链（校园食安卫士）。现改为可管理：
*   - 多条、排序（上移/下移，落库 sort_order）、启用/停用、新窗口开关、图标与描述；
*   - 「快捷访问」区：一眼看到登录页真实效果（同款毛玻璃胶囊），并可直接打开访问；
*   - 访问统计：登录页真实点击次数（visit_count / last_visit_at），管理台自身的打开不计入。
*
* 后端：/api/admin/friendly-links/*（super_admin；变更写 AdminOpsLog 审计）
*      登录页读侧为免鉴权 /api/public/friendly-links（同一份数据，最小字段投影）。
* 口径：字段校验与安全规则唯一事实源在 backend/lib/friendlyLinks.js —— 前端只做即时提示，
*      不作为安全边界；所有动态内容一律 escapeHtml 后渲染，绝不拼未转义值。
*/

import { escapeHtml } from '../ui.js';

const DEFAULT_ICON = 'fas fa-link';
/** 常用图标预设（点击即填；字段仍接受任意合法 FontAwesome 类名）。 */
const ICON_PRESETS = [
    { icon: 'fas fa-link', label: '链接' },
    { icon: 'fas fa-shield-alt', label: '安全' },
    { icon: 'fas fa-school', label: '学校' },
    { icon: 'fas fa-flask', label: '检测' },
    { icon: 'fas fa-book', label: '文档' },
    { icon: 'fas fa-globe', label: '站点' },
    { icon: 'fas fa-newspaper', label: '资讯' },
    { icon: 'fas fa-handshake', label: '合作' },
    { icon: 'fas fa-headset', label: '客服' },
    { icon: 'fas fa-chart-line', label: '数据' },
];

function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 目标地址是否可安全渲染为 href（与后端同口径：仅 http/https、无凭证）。 */
function safeExternalUrl(raw) {
    try {
        const u = new URL(String(raw || ''));
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.username || u.password) return null;
        return u.toString();
    } catch {
        return null;
    }
}

function safeIcon(raw) {
    const s = String(raw || '').trim().replace(/\s+/g, ' ');
    return /^(fas|far|fal|fad|fab|fa-solid|fa-regular|fa-brands)\s+fa-[a-z0-9-]+(?:\s+fa-[a-z0-9-]+)*$/.test(s) ? s : DEFAULT_ICON;
}

export function initFriendlyLinksView({ API_BASE, authHeaders, notify }) {
    const state = {
        items: [],
        summary: { total: 0, enabled: 0, disabled: 0, visits: 0, max: 50 },
        editingId: null,   // null = 新增；否则为编辑中的 id
        busy: false,
    };

    const el = (id) => document.getElementById(id);

    async function api(path, opts = {}) {
        const resp = await fetch(`${API_BASE}/api/admin/friendly-links${path}`, {
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j.success === false) throw new Error(j.error || `HTTP ${resp.status}`);
        return j.data;
    }

    /* ─────────── 骨架 ─────────── */
    function renderSkeleton() {
        const host = el('adminViewLinks');
        if (!host) return;
        host.innerHTML = `
        <div class="container mx-auto px-4 py-6 max-w-[2000px]">
            <div class="flex items-center justify-between flex-wrap gap-3 mb-4">
                <div>
                    <h2 class="text-xl font-semibold text-gray-800"><i class="fas fa-link text-blue-500 mr-2"></i>友情链接</h2>
                    <p class="text-xs text-gray-500 mt-1">
                        维护各校登录页（<code>login.html</code>）登录卡下方的友情链接：支持多条、排序、启用/停用与访问统计。
                        <b>停用</b>的链接不出现在登录页；登录页读取失败时回退内置兜底链接，不影响登录。
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <button type="button" data-act="refresh" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition"><i class="fas fa-sync-alt mr-1"></i>刷新</button>
                    <button type="button" data-act="new" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition shadow"><i class="fas fa-plus mr-1"></i>新增链接</button>
                </div>
            </div>

            <div class="admin-kpi-grid">
                <div class="admin-kpi-card">
                    <div class="admin-kpi-label"><i class="fas fa-list mr-1"></i>链接总数</div>
                    <div id="flKpiTotal" class="admin-kpi-value">-</div>
                    <div class="admin-kpi-sub">含已停用；上限 <span id="flKpiMax">-</span> 条</div>
                </div>
                <div class="admin-kpi-card">
                    <div class="admin-kpi-label"><i class="fas fa-eye mr-1"></i>登录页展示中</div>
                    <div id="flKpiEnabled" class="admin-kpi-value">-</div>
                    <div class="admin-kpi-sub">状态为「启用」的链接</div>
                </div>
                <div class="admin-kpi-card">
                    <div class="admin-kpi-label"><i class="fas fa-eye-slash mr-1"></i>已停用</div>
                    <div id="flKpiDisabled" class="admin-kpi-value">-</div>
                    <div class="admin-kpi-sub">保留配置但不展示</div>
                </div>
                <div class="admin-kpi-card">
                    <div class="admin-kpi-label"><i class="fas fa-chart-bar mr-1"></i>累计访问</div>
                    <div id="flKpiVisits" class="admin-kpi-value">-</div>
                    <div class="admin-kpi-sub">登录页点击次数（非精确计数）</div>
                </div>
            </div>

            <div class="admin-card">
                <div class="flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <h3><i class="fas fa-external-link-alt text-blue-500"></i>快捷访问</h3>
                        <p class="text-xs text-gray-500">登录页登录卡下方的真实效果（仅「启用」的链接，按排序展示）：<b>1 条</b>显示为胶囊，<b>≥2 条</b>合并为一条底栏（最多 4 条，其余折叠为「+N」）。点击即在新窗口打开；<b>此处打开不计入访问统计</b>。</p>
                    </div>
                    <a id="flLoginPreviewLink" href="/login.html" target="_blank" rel="noopener noreferrer" class="text-xs text-blue-600 hover:text-blue-800 hover:underline"><i class="fas fa-desktop mr-1"></i>打开登录页</a>
                </div>
                <div id="flQuickAccess" class="mt-3">加载中…</div>
            </div>

            <div class="admin-card">
                <h3><i class="fas fa-list-ul text-slate-500"></i>链接管理</h3>
                <div class="overflow-x-auto">
                    <table class="glass-table w-full">
                        <thead>
                            <tr>
                                <th style="width:92px">排序</th>
                                <th>名称</th>
                                <th>目标地址</th>
                                <th style="width:110px">分组</th>
                                <th style="width:96px">状态</th>
                                <th style="width:150px">访问</th>
                                <th style="width:260px">操作</th>
                            </tr>
                        </thead>
                        <tbody id="flTbody"><tr><td colspan="7" class="text-center py-6 text-gray-400">加载中...</td></tr></tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- 新增 / 编辑弹窗 -->
        <div id="flModal" class="hidden fixed inset-0 z-[100]">
            <div class="absolute inset-0 bg-black/50" data-fl-close></div>
            <div class="relative z-10 w-[min(94vw,720px)] mx-auto mt-10 bg-white rounded-xl shadow-2xl overflow-hidden">
                <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-gray-50">
                    <h3 class="font-medium text-gray-800"><i class="fas fa-link mr-2 text-blue-600"></i><span id="flModalTitle">新增友情链接</span></h3>
                    <button type="button" data-fl-close class="px-2 py-1 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-lg transition text-lg leading-none">&times;</button>
                </div>
                <div class="p-5 grid md:grid-cols-2 gap-5 max-h-[70vh] overflow-y-auto">
                    <div class="space-y-3">
                        <label class="block">
                            <span class="text-sm text-gray-700">名称 <b class="text-red-500">*</b></span>
                            <input id="flName" type="text" maxlength="60" placeholder="如：校园食安卫士"
                                   class="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none">
                            <span class="text-xs text-gray-400">登录页胶囊上显示的文案（≤60 字）</span>
                        </label>
                        <label class="block">
                            <span class="text-sm text-gray-700">目标地址 <b class="text-red-500">*</b></span>
                            <input id="flUrl" type="text" maxlength="500" placeholder="https://example.com/"
                                   class="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none">
                            <span class="text-xs text-gray-400">仅支持 http / https 完整地址，不能携带账号密码</span>
                        </label>
                        <label class="block">
                            <span class="text-sm text-gray-700">描述</span>
                            <input id="flDesc" type="text" maxlength="200" placeholder="悬停提示文案（可空）"
                                   class="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none">
                        </label>
                        <div class="grid grid-cols-2 gap-3">
                            <label class="block">
                                <span class="text-sm text-gray-700">分组</span>
                                <input id="flGroup" type="text" maxlength="20" placeholder="如：合作机构"
                                       class="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none">
                            </label>
                            <label class="block">
                                <span class="text-sm text-gray-700">排序值</span>
                                <input id="flSort" type="number" min="0" max="9999" step="10"
                                       class="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none">
                                <span class="text-xs text-gray-400">越小越靠前</span>
                            </label>
                        </div>
                        <label class="block">
                            <span class="text-sm text-gray-700">图标（FontAwesome 类名）</span>
                            <input id="flIcon" type="text" maxlength="60" placeholder="fas fa-link"
                                   class="mt-1 w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-200 focus:border-blue-400 outline-none">
                            <span id="flIconPresets" class="mt-2 flex flex-wrap gap-1"></span>
                        </label>
                        <div class="flex items-center gap-5 pt-1">
                            <label class="inline-flex items-center gap-2 text-sm text-gray-700">
                                <input id="flEnabled" type="checkbox" class="rounded border-gray-300" checked>启用（登录页展示）
                            </label>
                            <label class="inline-flex items-center gap-2 text-sm text-gray-700">
                                <input id="flNewTab" type="checkbox" class="rounded border-gray-300" checked>新窗口打开
                            </label>
                        </div>
                    </div>

                    <div class="space-y-3">
                        <div>
                            <span class="text-sm text-gray-700">登录页效果预览</span>
                            <div class="mt-2 p-5 rounded-xl" style="background:linear-gradient(135deg,#fde68a 0%,#fbcfe8 45%,#c7d2fe 100%);">
                                <div class="text-center text-xs text-gray-500 mb-3">（登录卡已省略）</div>
                                <div id="flPreview" class="flex flex-col items-center gap-2"></div>
                            </div>
                        </div>
                        <div class="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 leading-relaxed">
                            <i class="fas fa-info-circle mr-1"></i>保存后<b>立即生效</b>于所有学校登录页（登录页每次打开拉取最新配置）。
                            名称、描述按纯文本渲染；地址仅允许 http / https。
                        </div>
                        <div id="flModalError" class="hidden p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm"></div>
                    </div>
                </div>
                <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50">
                    <button type="button" data-fl-close class="px-4 py-1.5 text-sm bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition">取消</button>
                    <button type="button" id="flSaveBtn" class="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition shadow"><i class="fas fa-save mr-1"></i>保存</button>
                </div>
            </div>
        </div>

        <!-- 登录页预览样式：与 login.html 的 .friendly-link / .friendly-links__bar* 同视觉
             （此处为镜像副本——登录页样式不跨页共享；改布局时两处必须同步）。
             仅作用于本视图，只定义一次，避免每次重渲染重复注入。 -->
        <style>
            /* 1 条：毛玻璃胶囊 */
            .friendly-link-preview {
                display: inline-flex; align-items: center; justify-content: center;
                width: fit-content; max-width: 100%;
                padding: 7px 18px; border-radius: 999px; font-size: 13px; color: #374151;
                background: rgba(255,255,255,0.55); backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                border: 1px solid rgba(255,255,255,0.6);
                box-shadow: 0 2px 10px rgba(30,44,80,0.08);
                text-decoration: none; transition: color .2s ease, background .2s ease;
            }
            .friendly-link-preview i { margin-right: 8px; font-size: 12px; }
            .friendly-link-preview:hover { color: #2563eb; background: rgba(255,255,255,0.75); }
            /* ≥2 条：合并底栏（统一标签 + 竖线分隔；最多 4 条 + “+N” 展开） */
            .friendly-links__bar {
                display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
                gap: 4px 10px;
                max-width: min(100%, 520px); margin: 0 auto;
                padding: 7px 16px; border-radius: 14px;
                font-size: 12.5px; color: #4b5563; line-height: 1.5;
                background: rgba(255,255,255,0.55); backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                border: 1px solid rgba(255,255,255,0.6);
                box-shadow: 0 2px 10px rgba(30,44,80,0.08);
            }
            .friendly-links__bar-label {
                display: inline-flex; align-items: center;
                color: #9ca3af; font-size: 11.5px; letter-spacing: .04em; white-space: nowrap;
            }
            .friendly-links__bar-label i { margin-right: 6px; font-size: 11px; }
            .friendly-links__bar-items {
                display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
                row-gap: 2px; min-width: 0;
            }
            .friendly-links__bar-items > * + * {
                margin-left: 10px; padding-left: 10px;
                border-left: 1px solid rgba(148, 163, 184, 0.45);
            }
            .friendly-links__bar-items a {
                color: #374151; text-decoration: none; transition: color .2s ease;
                overflow-wrap: anywhere;
            }
            .friendly-links__bar-items a:hover { color: #2563eb; }
            .friendly-links__bar-more {
                background: none; border: 0; padding: 0; font: inherit;
                color: #6b7280; cursor: pointer;
                text-decoration: underline dotted; text-underline-offset: 3px;
            }
            .friendly-links__bar-more:hover { color: #2563eb; }
        </style>`;
    }

    /* ─────────── 渲染：KPI ─────────── */
    function renderKpi() {
        const s = state.summary || {};
        if (el('flKpiTotal')) el('flKpiTotal').textContent = String(s.total ?? 0);
        if (el('flKpiMax')) el('flKpiMax').textContent = String(s.max ?? 50);
        if (el('flKpiEnabled')) el('flKpiEnabled').textContent = String(s.enabled ?? 0);
        if (el('flKpiDisabled')) el('flKpiDisabled').textContent = String(s.disabled ?? 0);
        if (el('flKpiVisits')) el('flKpiVisits').textContent = String(s.visits ?? 0);
    }

    /* ─────────── 渲染：快捷访问（登录页真实布局的镜像预览） ─────────── */
    /**
     * 与 login.html 一致的两种布局（改这里必须同步改 frontend/js/modules/loginPage.js initFriendlyLinks）：
     *   · 1 条 → 毛玻璃胶囊「友情链接：<名称>」；
     *   · ≥2 条 → 一条底栏：统一标签 + 竖线分隔的名称列表，最多 4 条，其余「+N」就地展开。
     */
    const PREVIEW_MAX_VISIBLE = 4;

    function previewTargetAttr(it) {
        return it.open_in_new_tab === false ? '' : 'target="_blank" rel="noopener noreferrer"';
    }

    /** 单条胶囊（含自定义图标）。 */
    function previewPillHtml(it) {
        const url = safeExternalUrl(it.url);
        const inner = `<i class="${escapeHtml(safeIcon(it.icon))}" aria-hidden="true"></i><span>友情链接：${escapeHtml(it.name)}</span>`;
        return url
            ? `<a class="friendly-link-preview" href="${escapeHtml(url)}" ${previewTargetAttr(it)} title="${escapeHtml(it.description || it.name)}">${inner}</a>`
            : `<span class="friendly-link-preview" title="地址非法，登录页不会渲染该链接">${inner}</span>`;
    }

    /** 多条底栏（标签统一使用默认链接图标；名称过长自然换行，不截断）。 */
    function previewBarHtml(list) {
        const items = list.map((it, idx) => {
            const url = safeExternalUrl(it.url);
            const hiddenAttr = idx >= PREVIEW_MAX_VISIBLE ? ' hidden data-fl-extra="1"' : '';
            const label = escapeHtml(it.name);
            const title = escapeHtml(it.description || it.name);
            return url
                ? `<a class="fl-extra-item"${hiddenAttr} href="${escapeHtml(url)}" ${previewTargetAttr(it)} title="${title}">${label}</a>`
                : `<span class="fl-extra-item"${hiddenAttr} title="地址非法，登录页不会渲染该链接">${label}</span>`;
        }).join('');
        const more = list.length > PREVIEW_MAX_VISIBLE
            ? `<button type="button" data-act="fl-more" class="friendly-links__bar-more" title="展开全部友情链接">+${list.length - PREVIEW_MAX_VISIBLE}</button>`
            : '';
        return `<div class="friendly-links__bar" style="margin:0 auto">
            <span class="friendly-links__bar-label"><i class="${escapeHtml(DEFAULT_ICON)}" aria-hidden="true"></i>友情链接</span>
            <span class="friendly-links__bar-items">${items}${more}</span>
        </div>`;
    }

    function renderQuickAccess() {
        const host = el('flQuickAccess');
        if (!host) return;
        const enabled = state.items.filter((i) => i.status === 'enabled');
        if (!enabled.length) {
            host.innerHTML = `<div class="text-sm text-gray-400 py-3">当前没有启用中的链接，登录页将不显示友情链接入口。点击右上角「新增链接」添加。</div>`;
            return;
        }
        const inner = enabled.length === 1 ? previewPillHtml(enabled[0]) : previewBarHtml(enabled);
        host.innerHTML = `
            <!-- 登录卡下方区域：max-width 448px 模拟登录页 max-w-md 卡片宽度，保证预览与线上比例一致 -->
            <div class="py-6 px-4 rounded-xl">
                <div class="mx-auto" style="max-width:448px">${inner}</div>
            </div>
            <p class="text-xs text-gray-400 mt-2">
                布局随条数自动切换：<b>1 条</b>为胶囊；<b>≥2 条</b>合并为底栏（上例即当前 ${enabled.length} 条的形态，名称过长会自然换行）。
                多条时统一使用「链接」图标，不再逐条显示各自的自定义图标。
            </p>`;
    }

    /* ─────────── 渲染：管理列表 ─────────── */
    function renderTable() {
        const tbody = el('flTbody');
        if (!tbody) return;
        if (!state.items.length) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-gray-400">暂无友情链接，点击右上角「新增链接」添加</td></tr>`;
            return;
        }
        tbody.innerHTML = state.items.map((it, idx) => {
            const enabled = it.status === 'enabled';
            const url = safeExternalUrl(it.url);
            const badge = enabled
                ? '<span class="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">启用</span>'
                : '<span class="px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs">已停用</span>';
            return `<tr${enabled ? '' : ' class="opacity-60"'}>
                <td>
                    <div class="flex items-center gap-1">
                        <button type="button" data-act="up" data-id="${escapeHtml(it.id)}" ${idx === 0 ? 'disabled' : ''}
                                class="px-1.5 py-0.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-30" title="上移"><i class="fas fa-arrow-up"></i></button>
                        <button type="button" data-act="down" data-id="${escapeHtml(it.id)}" ${idx === state.items.length - 1 ? 'disabled' : ''}
                                class="px-1.5 py-0.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-30" title="下移"><i class="fas fa-arrow-down"></i></button>
                        <span class="text-xs text-gray-400 ml-1">${escapeHtml(it.sort_order)}</span>
                    </div>
                </td>
                <td>
                    <div class="flex items-center gap-2">
                        <span class="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center flex-shrink-0"><i class="${escapeHtml(safeIcon(it.icon))}"></i></span>
                        <div class="min-w-0">
                            <div class="font-medium text-gray-800 truncate">${escapeHtml(it.name)}</div>
                            ${it.description ? `<div class="text-xs text-gray-400 truncate" title="${escapeHtml(it.description)}">${escapeHtml(it.description)}</div>` : ''}
                        </div>
                    </div>
                </td>
                <td class="text-xs">
                    ${url
                        ? `<a class="text-blue-600 hover:underline break-all" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(url)}">${escapeHtml(it.url.length > 60 ? it.url.slice(0, 60) + '…' : it.url)}</a>${it.open_in_new_tab === false ? ' <span class="text-gray-400">(当前窗口)</span>' : ''}`
                        : `<span class="text-red-500">地址非法：${escapeHtml(String(it.url || '').slice(0, 60))}</span>`}
                </td>
                <td class="text-xs text-gray-600">${it.group_name ? escapeHtml(it.group_name) : '<span class="text-gray-300">—</span>'}</td>
                <td>${badge}</td>
                <td class="text-xs text-gray-600">
                    <div><i class="fas fa-mouse-pointer text-gray-400 mr-1"></i>${escapeHtml(it.visit_count ?? 0)} 次</div>
                    <div class="text-gray-400">${escapeHtml(fmtTime(it.last_visit_at))}</div>
                </td>
                <td>
                    <div class="flex items-center gap-1 flex-wrap">
                        ${url ? `<a data-act="open" href="${escapeHtml(url)}" ${it.open_in_new_tab === false ? '' : 'target="_blank" rel="noopener noreferrer"'}
                                   class="px-2 py-1 text-xs bg-emerald-50 text-emerald-700 rounded hover:bg-emerald-100" title="在新窗口访问该链接（不计入统计）"><i class="fas fa-external-link-alt mr-1"></i>打开</a>` : ''}
                        <button type="button" data-act="edit" data-id="${escapeHtml(it.id)}" class="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100"><i class="fas fa-pen mr-1"></i>编辑</button>
                        <button type="button" data-act="toggle" data-id="${escapeHtml(it.id)}" class="px-2 py-1 text-xs ${enabled ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-green-50 text-green-700 hover:bg-green-100'} rounded">
                            <i class="fas ${enabled ? 'fa-eye-slash' : 'fa-eye'} mr-1"></i>${enabled ? '停用' : '启用'}
                        </button>
                        <button type="button" data-act="del" data-id="${escapeHtml(it.id)}" class="px-2 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100"><i class="fas fa-trash mr-1"></i>删除</button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    function renderAll() {
        renderKpi();
        renderQuickAccess();
        renderTable();
    }

    /* ─────────── 数据加载 ─────────── */
    async function load(showNotice = false) {
        try {
            const data = await api('');
            state.items = Array.isArray(data?.items) ? data.items : [];
            state.summary = data?.summary || { total: state.items.length, enabled: 0, disabled: 0, visits: 0, max: 50 };
            renderAll();
            if (showNotice) notify('友情链接已刷新', 'success');
        } catch (e) {
            const tbody = el('flTbody');
            if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-red-500">加载失败：${escapeHtml(e.message)}</td></tr>`;
            notify(`友情链接加载失败：${e.message}`, 'error');
        }
    }

    /* ─────────── 弹窗 ─────────── */
    function renderIconPresets() {
        const host = el('flIconPresets');
        if (!host) return;
        host.innerHTML = ICON_PRESETS.map((p) =>
            `<button type="button" data-act="icon" data-icon="${escapeHtml(p.icon)}" title="${escapeHtml(p.label)}"
                     class="w-7 h-7 rounded border border-gray-200 text-gray-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-300"><i class="${escapeHtml(p.icon)}"></i></button>`
        ).join('');
    }

    function modalError(msg) {
        const box = el('flModalError');
        if (!box) return;
        if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
        box.textContent = msg;
        box.classList.remove('hidden');
    }

    function updatePreview() {
        const host = el('flPreview');
        if (!host) return;
        const name = (el('flName')?.value || '').trim() || '链接名称';
        const icon = safeIcon(el('flIcon')?.value);
        const url = safeExternalUrl(el('flUrl')?.value);
        host.innerHTML = `<span class="friendly-link-preview${url ? '' : ' opacity-60'}">
            <i class="${escapeHtml(icon)}"></i><span>友情链接：${escapeHtml(name)}</span></span>`;
    }

    function openModal(id = null) {
        state.editingId = id;
        const row = id ? state.items.find((i) => i.id === id) : null;
        if (el('flModalTitle')) el('flModalTitle').textContent = row ? `编辑友情链接：${row.name}` : '新增友情链接';
        if (el('flName')) el('flName').value = row?.name || '';
        if (el('flUrl')) el('flUrl').value = row?.url || '';
        if (el('flDesc')) el('flDesc').value = row?.description || '';
        if (el('flGroup')) el('flGroup').value = row?.group_name || '';
        if (el('flIcon')) el('flIcon').value = row?.icon || DEFAULT_ICON;
        if (el('flSort')) el('flSort').value = String(row ? row.sort_order : (state.items.length ? Math.max(...state.items.map((i) => Number(i.sort_order) || 0)) + 10 : 10));
        if (el('flEnabled')) el('flEnabled').checked = row ? row.status === 'enabled' : true;
        if (el('flNewTab')) el('flNewTab').checked = row ? row.open_in_new_tab !== false : true;
        modalError('');
        updatePreview();
        el('flModal')?.classList.remove('hidden');
        el('flName')?.focus();
    }

    function closeModal() {
        el('flModal')?.classList.add('hidden');
        state.editingId = null;
    }

    async function submit() {
        if (state.busy) return;
        const name = (el('flName')?.value || '').trim();
        const url = (el('flUrl')?.value || '').trim();
        const icon = safeIcon(el('flIcon')?.value);
        if (!name) return modalError('名称不能为空');
        if (name.length > 60) return modalError('名称过长（上限 60 字）');
        if (!safeExternalUrl(url)) return modalError('目标地址必须是完整的 http:// 或 https:// 地址（且不能携带账号密码）');
        const sortRaw = (el('flSort')?.value || '').trim();
        const sortOrder = sortRaw === '' ? undefined : Number(sortRaw);
        if (sortOrder !== undefined && (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999)) {
            return modalError('排序值需为 0~9999 的整数');
        }

        const payload = {
            name,
            url,
            description: (el('flDesc')?.value || '').trim(),
            groupName: (el('flGroup')?.value || '').trim(),
            icon,
            status: el('flEnabled')?.checked ? 'enabled' : 'disabled',
            openInNewTab: !!el('flNewTab')?.checked,
        };
        if (sortOrder !== undefined) payload.sortOrder = sortOrder;

        state.busy = true;
        const btn = el('flSaveBtn');
        const oldHtml = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>保存中...'; }
        try {
            if (state.editingId) {
                await api(`/${encodeURIComponent(state.editingId)}`, { method: 'PUT', body: payload });
                notify('✅ 链接已更新并即时生效于登录页', 'success');
            } else {
                await api('', { method: 'POST', body: payload });
                notify('✅ 链接已创建并即时生效于登录页', 'success');
            }
            closeModal();
            await load();
        } catch (e) {
            modalError(`保存失败：${e.message}`);
        } finally {
            state.busy = false;
            if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }
        }
    }

    /* ─────────── 行操作 ─────────── */
    /** 上移/下移：本地交换后按**整表顺序**回写 sort_order（后端重排为 10/20/30…）。 */
    async function move(id, dir) {
        const idx = state.items.findIndex((i) => i.id === id);
        if (idx < 0) return;
        const to = dir === 'up' ? idx - 1 : idx + 1;
        if (to < 0 || to >= state.items.length) return;
        const next = state.items.slice();
        [next[idx], next[to]] = [next[to], next[idx]];
        state.items = next;
        renderAll();
        try {
            await api('/reorder', { method: 'POST', body: { ids: next.map((i) => i.id) } });
            notify('排序已保存', 'success');
        } catch (e) {
            notify(`排序保存失败：${e.message}`, 'error');
        }
        await load();
    }

    async function toggle(row) {
        const next = row.status === 'enabled' ? 'disabled' : 'enabled';
        try {
            await api(`/${encodeURIComponent(row.id)}`, { method: 'PUT', body: { status: next } });
            notify(next === 'enabled' ? '✅ 已启用，登录页将展示该链接' : '已停用，登录页不再展示该链接', 'success');
        } catch (e) {
            notify(`状态切换失败：${e.message}`, 'error');
        }
        await load();
    }

    async function remove(row) {
        if (!window.confirm(`确认删除友情链接「${row.name}」？\n\n删除后登录页立即不再展示（不可撤销）。`)) return;
        try {
            await api(`/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
            notify('🗑️ 链接已删除', 'success');
        } catch (e) {
            notify(`删除失败：${e.message}`, 'error');
        }
        await load();
    }

    /* ─────────── 事件绑定（全部委托到 #adminViewLinks，避免重渲染后失效） ─────────── */
    function bindEvents() {
        const host = el('adminViewLinks');
        if (!host || host.dataset.flBound === '1') return;
        host.dataset.flBound = '1';

        host.addEventListener('click', async (ev) => {
            const closer = ev.target.closest('[data-fl-close]');
            if (closer) { closeModal(); return; }
            const btn = ev.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.getAttribute('data-act');
            const id = btn.getAttribute('data-id');
            const row = id ? state.items.find((i) => i.id === id) : null;

            if (act === 'new') return openModal(null);
            if (act === 'refresh') return load(true);
            if (act === 'fl-more') {
                // 预览区「+N」：就地展开剩余链接（与登录页底栏的交互一致）
                const box = btn.parentElement;
                if (box) box.querySelectorAll('[data-fl-extra]').forEach((n) => n.removeAttribute('hidden'));
                btn.remove();
                return undefined;
            }
            if (act === 'icon') {
                if (el('flIcon')) el('flIcon').value = btn.getAttribute('data-icon') || DEFAULT_ICON;
                return updatePreview();
            }
            if (act === 'edit') return openModal(id);
            if (act === 'toggle' && row) return toggle(row);
            if (act === 'del' && row) return remove(row);
            if (act === 'up' || act === 'down') return move(id, act);
            // act === 'open'（<a data-act="open">）：交由浏览器默认行为打开，不做拦截
        });

        host.addEventListener('input', (ev) => {
            const t = ev.target;
            if (t && (t.id === 'flName' || t.id === 'flUrl' || t.id === 'flIcon')) updatePreview();
        });

        const saveBtn = el('flSaveBtn');
        if (saveBtn) saveBtn.addEventListener('click', submit);

        document.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Escape') return;
            const m = el('flModal');
            if (m && !m.classList.contains('hidden')) closeModal();
        });
        // Enter 提交（textarea 除外；本表单无 textarea）
        ['flName', 'flUrl', 'flDesc', 'flGroup', 'flIcon', 'flSort'].forEach((fid) => {
            const input = el(fid);
            if (input) input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
        });
    }

    renderSkeleton();
    renderIconPresets();
    bindEvents();
    load();
    return { reload: load, openModal };
}
