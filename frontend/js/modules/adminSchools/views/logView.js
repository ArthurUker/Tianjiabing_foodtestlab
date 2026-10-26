/*
 * 日志中心视图（2026-10-22）
 * ------------------------------------------------------------
 * 超管一级菜单「日志管理」，三个页签：
 *   ① 数据库日志：分类（设备上传/认证会话/安全事件/平台操作/系统运行）× 级别 × 时间 × 学校 × 设备 × 关键词，
 *      分面计数、分页、行详情（context 结构化）、导出 NDJSON；
 *   ② 文件日志：白名单目录（应用日志/rsyslog/journal）在线查看最近 N 行 + 关键字过滤 + 下载；
 *   ③ 保留与清理：分类保留期/压缩阈值（自动压缩 + 到期清理）、容量统计、先预览再执行。
 *
 * 口径：单条日志的 category 存在 SystemLog.context.category（后端 lib/auditLog.js#deriveLogCategory 派生）；
 *   失败类日志按窗口聚合（context.repeat_count），列表里以「×N」呈现，避免故障重试刷爆表格。
 */
import { escapeHtml } from '../ui.js';

const TABS = [
    { key: 'db', label: '数据库日志', icon: 'fa-database' },
    { key: 'files', label: '文件日志', icon: 'fa-file-alt' },
    { key: 'retention', label: '保留与清理', icon: 'fa-broom' },
];

const CATS = [
    { key: 'all', label: '全部' },
    { key: 'device', label: '设备上传' },
    { key: 'openapi', label: '开放接口' },
    { key: 'auth', label: '认证会话' },
    { key: 'security', label: '安全事件' },
    { key: 'admin', label: '平台操作' },
    { key: 'system', label: '系统运行' },
];

const RANGES = [
    { key: 'today', label: '今天' },
    { key: '7d', label: '近 7 天' },
    { key: '30d', label: '近 30 天' },
    { key: '90d', label: '近 90 天' },
    { key: 'all', label: '全部' },
];

const LEVEL_BADGE = {
    info: 'bg-blue-50 text-blue-700',
    warn: 'bg-amber-50 text-amber-700',
    error: 'bg-red-50 text-red-700',
    debug: 'bg-gray-100 text-gray-600',
};

const CAT_BADGE = {
    device: 'bg-indigo-50 text-indigo-700',
    openapi: 'bg-cyan-50 text-cyan-700',
    auth: 'bg-emerald-50 text-emerald-700',
    security: 'bg-rose-50 text-rose-700',
    admin: 'bg-violet-50 text-violet-700',
    system: 'bg-gray-100 text-gray-700',
};

function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
    return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function rangeToSince(range) {
    if (range === 'all') return null;
    const now = new Date();
    if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = { '7d': 7, '30d': 30, '90d': 90 }[range] || 7;
    return new Date(now.getTime() - days * 86400_000);
}

export function initLogView({ API_BASE, authHeaders, notify }) {
    const state = {
        tab: 'db',
        category: 'all',
        level: 'all',
        range: '7d',
        schoolCode: '',
        deviceNo: '',
        clientId: '',
        keyword: '',
        page: 1,
        pageSize: 50,
        items: [],
        total: 0,
        facets: { categories: {}, levels: {} },
        labels: {},
        detail: null,
        // 文件日志
        files: [],
        filePath: '',
        fileLines: 200,
        fileQ: '',
        fileView: null,
        // 保留策略
        retention: null,
        stats: null,
        purgePreview: null,
    };

    const el = (id) => document.getElementById(id);

    async function api(path, opts = {}) {
        const resp = await fetch(`${API_BASE}/api/admin/logs${path}`, {
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
        const host = el('adminViewLogs');
        if (!host) return;
        host.innerHTML = `
        <div class="container mx-auto px-4 py-6 max-w-[2000px]">
            <div class="flex items-start justify-between flex-wrap gap-3 mb-3">
                <div>
                    <h2 class="text-xl font-semibold text-gray-800"><i class="fas fa-clipboard-list text-indigo-500 mr-2"></i>日志管理</h2>
                    <p class="text-xs text-gray-500 mt-1">
                        平台运行日志中心：<strong>分类检索</strong>设备上传/认证/安全/平台操作/系统事件，<strong>在线查看</strong>服务器日志文件，
                        <strong>集中管理</strong>保留期与自动压缩/清理。学校租户内部操作审计请到「审计日志 → 学校审计日志」查看。
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <button type="button" data-act="refresh-all" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"><i class="fas fa-sync-alt mr-1"></i>刷新</button>
                </div>
            </div>

            <div class="flex items-center gap-2 mb-3">
                ${TABS.map((t) => `
                    <button type="button" data-act="tab" data-tab="${t.key}" class="pd-tab px-3 py-1.5 text-sm rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50">
                        <i class="fas ${t.icon} mr-1"></i>${t.label}
                    </button>`).join('')}
            </div>

            <!-- ① 数据库日志 -->
            <div id="logPaneDb">
                <div class="bg-white rounded-lg shadow-sm border border-gray-200 mb-3">
                    <div id="logCatChips" class="px-3 pt-3 pb-1 flex flex-wrap items-center gap-2"></div>
                    <div class="px-3 pb-3 pt-1 flex flex-wrap items-center gap-2">
                        <select id="logRange" class="border border-gray-300 rounded px-3 py-1.5 text-sm">
                            ${RANGES.map((r) => `<option value="${r.key}">${r.label}</option>`).join('')}
                        </select>
                        <select id="logLevel" class="border border-gray-300 rounded px-3 py-1.5 text-sm">
                            <option value="all">全部级别</option>
                            <option value="info">info</option>
                            <option value="warn">warn</option>
                            <option value="error">error</option>
                            <option value="debug">debug</option>
                        </select>
                        <input id="logSchool" type="text" placeholder="学校代码（如 test）" class="border border-gray-300 rounded px-3 py-1.5 text-sm w-40" autocomplete="off">
                        <input id="logDevice" type="text" placeholder="设备编号" class="border border-gray-300 rounded px-3 py-1.5 text-sm w-40" autocomplete="off">
                        <input id="logClient" type="text" placeholder="对接方 client_id" class="border border-gray-300 rounded px-3 py-1.5 text-sm w-40" autocomplete="off">
                        <input id="logKeyword" type="text" placeholder="关键词（匹配日志标题）" class="border border-gray-300 rounded px-3 py-1.5 text-sm w-56" autocomplete="off">
                        <button type="button" data-act="query" class="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"><i class="fas fa-search mr-1"></i>查询</button>
                        <button type="button" data-act="reset" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">重置</button>
                        <button type="button" data-act="export" class="ml-auto px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200" title="按当前筛选导出 NDJSON"><i class="fas fa-download mr-1"></i>导出</button>
                    </div>
                </div>

                <div class="flex gap-3 items-start">
                    <div class="flex-1 min-w-0 bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead class="bg-gray-50 text-gray-600">
                                <tr>
                                    <th class="px-3 py-2 text-left whitespace-nowrap">时间</th>
                                    <th class="px-3 py-2 text-left">分类</th>
                                    <th class="px-3 py-2 text-left">级别</th>
                                    <th class="px-3 py-2 text-left">内容</th>
                                    <th class="px-3 py-2 text-left whitespace-nowrap">设备 / 学校</th>
                                    <th class="px-3 py-2 text-right whitespace-nowrap">次数</th>
                                </tr>
                            </thead>
                            <tbody id="logRows"></tbody>
                        </table>
                        <div id="logEmpty" class="hidden text-center text-gray-400 py-8 text-sm">没有匹配的日志</div>
                        <div class="px-3 py-2 border-t flex items-center gap-2 text-xs text-gray-500">
                            <span id="logTotal"></span>
                            <span class="ml-auto flex items-center gap-2">
                                <button type="button" data-act="prev" class="px-2 py-1 bg-gray-100 rounded hover:bg-gray-200">上一页</button>
                                <span id="logPage"></span>
                                <button type="button" data-act="next" class="px-2 py-1 bg-gray-100 rounded hover:bg-gray-200">下一页</button>
                            </span>
                        </div>
                    </div>
                    <div id="logDetail" class="hidden w-[420px] shrink-0 bg-white rounded-lg shadow-sm border border-gray-200">
                        <div class="px-3 py-2 border-b flex items-center justify-between">
                            <span class="text-sm font-medium text-gray-700">日志详情</span>
                            <div class="flex items-center gap-2">
                                <button type="button" data-act="copy-detail" class="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200">复制</button>
                                <button type="button" data-act="close-detail" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
                            </div>
                        </div>
                        <div id="logDetailBody" class="p-3 text-xs overflow-auto max-h-[70vh]"></div>
                    </div>
                </div>
            </div>

            <!-- ② 文件日志 -->
            <div id="logPaneFiles" class="hidden">
                <div class="bg-white rounded-lg shadow-sm border border-gray-200 mb-3 px-3 py-2 flex flex-wrap items-center gap-2">
                    <span class="text-sm text-gray-600">可查看目录：应用日志 <code class="font-mono text-xs">/mnt/datadisk0/foodsentinel/logs</code>、rsyslog、journal（只读）</span>
                    <button type="button" data-act="files-refresh" class="ml-auto px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"><i class="fas fa-sync-alt mr-1"></i>刷新清单</button>
                </div>
                <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead class="bg-gray-50 text-gray-600">
                            <tr>
                                <th class="px-3 py-2 text-left">文件</th>
                                <th class="px-3 py-2 text-right whitespace-nowrap">大小</th>
                                <th class="px-3 py-2 text-left whitespace-nowrap">最后修改</th>
                                <th class="px-3 py-2 text-center whitespace-nowrap">操作</th>
                            </tr>
                        </thead>
                        <tbody id="logFileRows"></tbody>
                    </table>
                    <div id="logFileEmpty" class="hidden text-center text-gray-400 py-8 text-sm">读取不到日志文件</div>
                </div>
            </div>

            <!-- ③ 保留与清理 -->
            <div id="logPaneRetention" class="hidden">
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
                    <div class="lg:col-span-2 bg-white rounded-lg shadow-sm border border-gray-200">
                        <div class="px-4 py-3 border-b flex items-center justify-between">
                            <div>
                                <h3 class="text-sm font-semibold text-gray-800">分类保留策略</h3>
                                <p class="text-xs text-gray-500 mt-1">保留期 0 = 永久保留；压缩阈值为 0 = 不压缩。超过压缩阈值且未到期的失败明细会按「日 × 代码」汇总成一行（保留次数与首末时间）。</p>
                            </div>
                            <label class="inline-flex items-center gap-1 text-xs text-gray-600">
                                <input id="logAuto" type="checkbox" class="rounded border-gray-300"> 每日自动执行
                            </label>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-sm">
                                <thead class="bg-gray-50 text-gray-600">
                                    <tr>
                                        <th class="px-3 py-2 text-left">分类</th>
                                        <th class="px-3 py-2 text-left">保留天数</th>
                                        <th class="px-3 py-2 text-left">压缩阈值（天）</th>
                                        <th class="px-3 py-2 text-right whitespace-nowrap">近 30 天条数</th>
                                    </tr>
                                </thead>
                                <tbody id="logRetentionRows"></tbody>
                            </table>
                        </div>
                        <div class="px-4 py-3 border-t flex flex-wrap items-center gap-2">
                            <button type="button" data-act="retention-save" class="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">保存策略</button>
                            <button type="button" data-act="purge-preview" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">预览清理</button>
                            <button type="button" data-act="purge-run" class="px-3 py-1.5 text-sm bg-red-50 text-red-700 rounded-lg hover:bg-red-100">执行清理</button>
                            <span id="logRetentionHint" class="text-xs text-gray-500"></span>
                        </div>
                    </div>
                    <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                        <h3 class="text-sm font-semibold text-gray-800 mb-2">容量</h3>
                        <div id="logStats" class="text-xs text-gray-600 space-y-1"></div>
                        <div id="logStatsChart" class="mt-3 space-y-1"></div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 文件查看弹层 -->
        <div id="logFileModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
            <div class="bg-white rounded-lg shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
                <div class="px-4 py-3 border-b flex items-center justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-sm font-medium text-gray-800 truncate" id="logFileTitle">—</div>
                        <div class="text-xs text-gray-500" id="logFileMeta"></div>
                    </div>
                    <button type="button" data-act="file-close" class="text-gray-500 hover:text-gray-700"><i class="fas fa-times"></i></button>
                </div>
                <div class="px-4 py-2 border-b flex flex-wrap items-center gap-2">
                    <select id="logFileLines" class="border border-gray-300 rounded px-2 py-1 text-sm">
                        <option value="200">最近 200 行</option>
                        <option value="500">最近 500 行</option>
                        <option value="1000">最近 1000 行</option>
                        <option value="2000">最近 2000 行</option>
                    </select>
                    <input id="logFileQ" type="text" placeholder="关键字（空格分隔，需全部命中）" class="border border-gray-300 rounded px-2 py-1 text-sm w-72" autocomplete="off">
                    <button type="button" data-act="file-reload" class="px-3 py-1 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700">重新读取</button>
                    <button type="button" data-act="file-download" class="ml-auto px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"><i class="fas fa-download mr-1"></i>下载</button>
                </div>
                <div class="flex-1 min-h-0 overflow-auto bg-gray-900 text-gray-100 text-[11px] font-mono p-3" id="logFileBody"></div>
            </div>
        </div>`;
    }

    /* ─────────── 数据库日志 ─────────── */
    function renderChips() {
        const host = el('logCatChips');
        if (!host) return;
        host.innerHTML = CATS.map((c) => {
            const n = c.key === 'all' ? (Number(state.total) || 0) : (state.facets.categories?.[c.key] || 0);
            const active = state.category === c.key;
            return `<button type="button" data-act="cat" data-cat="${c.key}"
                class="px-3 py-1 rounded-full text-xs border ${active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}">
                ${c.label} <span class="${active ? 'text-white' : 'text-gray-400'}">${n}</span>
            </button>`;
        }).join('');
    }

    function renderRows() {
        const tbody = el('logRows');
        const empty = el('logEmpty');
        if (!tbody) return;
        if (!state.items.length) {
            tbody.innerHTML = '';
            empty?.classList.remove('hidden');
        } else {
            empty?.classList.add('hidden');
            tbody.innerHTML = state.items.map((r, i) => {
                const ctx = r.context || {};
                const repeat = Number(ctx.repeat_count) || 1;
                const cat = r.category || ctx.category || 'system';
                const catLabel = state.labels?.[cat] || CATS.find((c) => c.key === cat)?.label || cat;
                const rollup = ctx.rollup ? '<span class="ml-1 px-1.5 py-0.5 rounded bg-gray-200 text-gray-600 text-[10px]">汇总</span>' : '';
                return `<tr class="border-t hover:bg-gray-50 cursor-pointer" data-act="detail" data-idx="${i}">
                    <td class="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">${fmtTime(r.created_at)}</td>
                    <td class="px-3 py-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-xs ${CAT_BADGE[cat] || CAT_BADGE.system}">${escapeHtml(catLabel)}</span></td>
                    <td class="px-3 py-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded text-xs ${LEVEL_BADGE[r.level] || LEVEL_BADGE.info}">${escapeHtml(r.level)}</span></td>
                    <td class="px-3 py-2 text-gray-700 break-all">${escapeHtml(r.message || '')}${rollup}</td>
                    <td class="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                        ${ctx.device_no ? `<span class="font-mono">${escapeHtml(ctx.device_no)}</span>` : ''}
                        ${ctx.school_code ? `<span class="text-gray-400"> / </span>${escapeHtml(ctx.school_code)}` : ''}
                        ${!ctx.device_no && !ctx.school_code ? '—' : ''}
                    </td>
                    <td class="px-3 py-2 text-right text-xs ${repeat > 1 ? 'text-amber-700 font-medium' : 'text-gray-400'}">${repeat > 1 ? `×${repeat}` : '1'}</td>
                </tr>`;
            }).join('');
        }
        const total = Number(state.total) || 0;
        const pages = Math.max(1, Math.ceil(total / state.pageSize));
        if (el('logTotal')) el('logTotal').textContent = total ? `共 ${total} 条` : '';
        if (el('logPage')) el('logPage').textContent = `${state.page} / ${pages}`;
    }

    function renderDetail() {
        const box = el('logDetail');
        const body = el('logDetailBody');
        if (!box || !body) return;
        const r = state.detail;
        if (!r) { box.classList.add('hidden'); body.innerHTML = ''; return; }
        box.classList.remove('hidden');
        body.innerHTML = `
            <div class="space-y-1 mb-2">
                <div><span class="text-gray-500">时间：</span>${fmtTime(r.created_at)}</div>
                <div><span class="text-gray-500">级别：</span>${escapeHtml(r.level)}</div>
                <div><span class="text-gray-500">分类：</span>${escapeHtml(r.category || '（未分类）')}</div>
                <div class="break-all"><span class="text-gray-500">内容：</span>${escapeHtml(r.message || '')}</div>
            </div>
            <pre class="bg-gray-900 text-gray-100 rounded p-2 text-[11px] overflow-auto max-h-[52vh]">${escapeHtml(JSON.stringify(r.context || {}, null, 2))}</pre>`;
    }

    async function loadLogs() {
        try {
            const params = new URLSearchParams({ category: state.category, level: state.level, page: String(state.page), pageSize: String(state.pageSize) });
            const since = rangeToSince(state.range);
            if (since) params.set('since', since.toISOString());
            if (state.schoolCode) params.set('school_code', state.schoolCode);
            if (state.deviceNo) params.set('device_no', state.deviceNo)
            if (state.clientId) params.set('client_id', state.clientId);
            if (state.keyword) params.set('q', state.keyword);
            const data = await api(`/?${params.toString()}`);
            state.items = data.items || [];
            state.total = data.total || 0;
            state.facets = data.facets || { categories: {}, levels: {} };
            state.labels = data.labels || {};
            renderChips();
            renderRows();
        } catch (e) {
            notify(`日志查询失败：${e.message}`, 'error');
        }
    }

    /* ─────────── 文件日志 ─────────── */
    async function loadFiles() {
        try {
            const data = await api('/files');
            state.files = data.files || [];
            const tbody = el('logFileRows');
            const empty = el('logFileEmpty');
            if (!state.files.length) {
                if (tbody) tbody.innerHTML = '';
                empty?.classList.remove('hidden');
                return;
            }
            empty?.classList.add('hidden');
            if (tbody) {
                tbody.innerHTML = state.files.map((f) => `
                    <tr class="border-t hover:bg-gray-50">
                        <td class="px-3 py-2 font-mono text-xs break-all">${escapeHtml(f.path)}</td>
                        <td class="px-3 py-2 text-right text-xs text-gray-600 whitespace-nowrap">${fmtBytes(f.size)}</td>
                        <td class="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">${fmtTime(new Date(f.mtime).toISOString())}</td>
                        <td class="px-3 py-2 text-center whitespace-nowrap">
                            <button type="button" data-act="file-view" data-path="${escapeHtml(f.path)}" class="px-2 py-1 text-xs bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100">查看</button>
                            <button type="button" data-act="file-dl" data-path="${escapeHtml(f.path)}" class="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200">下载</button>
                        </td>
                    </tr>`).join('');
            }
        } catch (e) {
            notify(`读取日志文件清单失败：${e.message}`, 'error');
        }
    }

    async function viewFile(p) {
        state.filePath = p;
        const params = new URLSearchParams({ path: p, lines: String(state.fileLines) });
        if (state.fileQ) params.set('q', state.fileQ);
        try {
            const data = await api(`/files/view?${params.toString()}`);
            state.fileView = data;
            el('logFileModal')?.classList.remove('hidden');
            if (el('logFileTitle')) el('logFileTitle').textContent = data.path;
            if (el('logFileMeta')) {
                el('logFileMeta').textContent = `命中 ${data.matched} 行 / 可读 ${data.total} 行 · 显示最近 ${data.lines.length} 行${data.truncated ? '（仅读取文件尾部）' : ''}`;
            }
            if (el('logFileBody')) {
                el('logFileBody').innerHTML = data.lines.length
                    ? data.lines.map((l) => `<div class="whitespace-pre-wrap break-all">${escapeHtml(l)}</div>`).join('')
                    : '<div class="text-gray-400">没有匹配内容</div>';
            }
        } catch (e) {
            notify(`读取文件失败：${e.message}`, 'error');
        }
    }

    function downloadFile(p) {
        const url = `${API_BASE}/api/admin/logs/files/download?path=${encodeURIComponent(p)}`;
        fetch(url, { headers: authHeaders() })
            .then(async (resp) => {
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const blob = await resp.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = p.split('/').pop() || 'log.txt';
                a.click();
                URL.revokeObjectURL(a.href);
            })
            .catch((e) => notify(`下载失败：${e.message}`, 'error'));
    }

    /* ─────────── 保留与清理 ─────────── */
    async function loadRetention() {
        try {
            const [cfg, stats] = await Promise.all([api('/retention'), api('/stats?days=30')]);
            state.retention = cfg;
            state.stats = stats;
            if (el('logAuto')) el('logAuto').checked = cfg.auto !== false;
            const tbody = el('logRetentionRows');
            if (tbody) {
                tbody.innerHTML = Object.entries(cfg.rules).map(([cat, rule]) => `
                    <tr class="border-t">
                        <td class="px-3 py-2 whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-xs ${CAT_BADGE[cat] || CAT_BADGE.system}">${escapeHtml(cfg.labels?.[cat] || cat)}</span></td>
                        <td class="px-3 py-2"><input type="number" min="0" max="3650" data-ret="${cat}" data-field="retentionDays" value="${Number(rule.retentionDays) || 0}" class="border border-gray-300 rounded px-2 py-1 text-sm w-24"></td>
                        <td class="px-3 py-2"><input type="number" min="0" max="3650" data-ret="${cat}" data-field="compressAfterDays" value="${Number(rule.compressAfterDays) || 0}" class="border border-gray-300 rounded px-2 py-1 text-sm w-24"></td>
                        <td class="px-3 py-2 text-right text-xs text-gray-600">${Number(stats.totals?.[cat]) || 0}</td>
                    </tr>`).join('');
            }
            if (el('logStats')) {
                el('logStats').innerHTML = `
                    <div>总条数：<b>${Number(stats.rowCount) || 0}</b></div>
                    <div>表占用：<b>${fmtBytes(stats.tableBytes)}</b></div>
                    <div>近 30 天：info ${stats.levels?.info || 0} · warn ${stats.levels?.warn || 0} · error ${stats.levels?.error || 0}</div>`;
            }
            if (el('logStatsChart')) {
                const days = (stats.byDay || []).slice(0, 14).reverse();
                const max = Math.max(1, ...days.map((d) => d.total));
                el('logStatsChart').innerHTML = days.map((d) => `
                    <div class="flex items-center gap-2 text-[11px] text-gray-500">
                        <span class="w-16 shrink-0">${escapeHtml(d.day.slice(5))}</span>
                        <span class="h-2 rounded bg-indigo-400" style="width:${Math.max(2, Math.round((d.total / max) * 100))}%"></span>
                        <span>${d.total}</span>
                    </div>`).join('') || '<div class="text-xs text-gray-400">近 30 天无日志</div>';
            }
        } catch (e) {
            notify(`读取保留策略失败：${e.message}`, 'error');
        }
    }

    async function saveRetention() {
        const rules = {};
        document.querySelectorAll('[data-ret]').forEach((inp) => {
            const cat = inp.getAttribute('data-ret');
            const field = inp.getAttribute('data-field');
            rules[cat] = rules[cat] || {};
            rules[cat][field] = Number(inp.value) || 0;
        });
        try {
            await api('/retention', { method: 'POST', body: { rules, auto: !!el('logAuto')?.checked } });
            notify('✅ 保留策略已保存', 'success');
            await loadRetention();
        } catch (e) {
            notify(`保存失败：${e.message}`, 'error');
        }
    }

    async function purge(dryRun) {
        if (!dryRun && !window.confirm('执行日志清理？\n\n将按当前策略：先压缩超期失败明细为日汇总，再删除超过保留期的日志（平台操作审计永久保留）。此操作不可撤销。')) return;
        try {
            const data = await api('/purge', { method: 'POST', body: { dryRun } });
            state.purgePreview = data;
            const parts = Object.entries(data.categories || {}).map(([cat, v]) => {
                const label = state.retention?.labels?.[cat] || cat;
                const del = v.willDelete || 0;
                const roll = v.rollupGroups || 0;
                if (!del && !roll) return null;
                return `${label}：压缩 ${roll} 组 / 删除 ${del} 条`;
            }).filter(Boolean);
            const hint = el('logRetentionHint');
            if (hint) {
                hint.textContent = dryRun
                    ? `预览：${parts.length ? parts.join('；') : '无需清理'}`
                    : `✅ 已执行：${parts.length ? parts.join('；') : '无需清理'}`;
            }
            notify(dryRun ? '预览完成（未改动数据）' : '✅ 清理已执行', 'success');
            if (!dryRun) await loadRetention();
        } catch (e) {
            notify(`${dryRun ? '预览' : '执行'}失败：${e.message}`, 'error');
        }
    }

    function switchTab(tab) {
        state.tab = tab;
        if (el('logPaneDb')) el('logPaneDb').classList.toggle('hidden', tab !== 'db');
        if (el('logPaneFiles')) el('logPaneFiles').classList.toggle('hidden', tab !== 'files');
        if (el('logPaneRetention')) el('logPaneRetention').classList.toggle('hidden', tab !== 'retention');
        document.querySelectorAll('[data-act="tab"]').forEach((b) => {
            const on = b.getAttribute('data-tab') === tab;
            b.classList.toggle('bg-indigo-600', on);
            b.classList.toggle('text-white', on);
            b.classList.toggle('border-indigo-600', on);
            b.classList.toggle('bg-white', !on);
            b.classList.toggle('text-gray-600', !on);
        });
        if (tab === 'files' && !state.files.length) loadFiles();
        if (tab === 'retention') loadRetention();
    }

    function bindEvents() {
        const host = el('adminViewLogs');
        if (!host || host.dataset.logBound === '1') return;
        host.dataset.logBound = '1';

        host.addEventListener('click', async (ev) => {
            const btn = ev.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.getAttribute('data-act');

            if (act === 'tab') return switchTab(btn.getAttribute('data-tab'));
            if (act === 'refresh-all') {
                if (state.tab === 'db') return loadLogs();
                if (state.tab === 'files') return loadFiles();
                return loadRetention();
            }
            if (act === 'cat') {
                state.category = btn.getAttribute('data-cat');
                state.page = 1;
                return loadLogs();
            }
            if (act === 'query') {
                state.range = el('logRange').value;
                state.level = el('logLevel').value;
                state.schoolCode = el('logSchool').value.trim();
                state.deviceNo = el('logDevice').value.trim();
                state.clientId = el('logClient').value.trim();
                state.keyword = el('logKeyword').value.trim();
                state.page = 1;
                return loadLogs();
            }
            if (act === 'reset') {
                state.category = 'all'; state.level = 'all'; state.range = '7d'; state.schoolCode = ''; state.deviceNo = ''; state.clientId = ''; state.keyword = ''; state.page = 1;
                el('logRange').value = '7d'; el('logLevel').value = 'all'; el('logSchool').value = ''; el('logDevice').value = ''; el('logClient').value = ''; el('logKeyword').value = '';
                return loadLogs();
            }
            if (act === 'prev') { if (state.page > 1) { state.page -= 1; await loadLogs(); } return; }
            if (act === 'next') {
                const pages = Math.max(1, Math.ceil((Number(state.total) || 0) / state.pageSize));
                if (state.page < pages) { state.page += 1; await loadLogs(); }
                return;
            }
            if (act === 'detail') {
                const idx = Number(btn.getAttribute('data-idx'));
                state.detail = state.items[idx] || null;
                return renderDetail();
            }
            if (act === 'close-detail') { state.detail = null; return renderDetail(); }
            if (act === 'copy-detail') {
                try {
                    await navigator.clipboard.writeText(JSON.stringify(state.detail || {}, null, 2));
                    notify('已复制日志详情', 'success');
                } catch { notify('复制失败，请手动选择', 'error'); }
                return;
            }
            if (act === 'export') {
                const body = { category: state.category, level: state.level, q: state.keyword, school_code: state.schoolCode, device_no: state.deviceNo, client_id: state.clientId };
                const since = rangeToSince(state.range);
                if (since) body.since = since.toISOString();
                try {
                    const resp = await fetch(`${API_BASE}/api/admin/logs/export`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders() },
                        body: JSON.stringify(body),
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const blob = await resp.blob();
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `systemlog-${new Date().toISOString().slice(0, 10)}.ndjson`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                    notify('✅ 已导出当前筛选结果', 'success');
                } catch (e) {
                    notify(`导出失败：${e.message}`, 'error');
                }
                return;
            }
            if (act === 'files-refresh') return loadFiles();
            if (act === 'file-view') return viewFile(btn.getAttribute('data-path'));
            if (act === 'file-dl') return downloadFile(btn.getAttribute('data-path'));
            if (act === 'file-close') { el('logFileModal')?.classList.add('hidden'); return; }
            if (act === 'file-reload') {
                state.fileLines = Number(el('logFileLines').value) || 200;
                state.fileQ = el('logFileQ').value.trim();
                return viewFile(state.filePath);
            }
            if (act === 'file-download') return downloadFile(state.filePath);
            if (act === 'retention-save') return saveRetention();
            if (act === 'purge-preview') return purge(true);
            if (act === 'purge-run') return purge(false);
        });
    }

    renderSkeleton();
    bindEvents();
    switchTab('db');
    loadLogs();

    return { reload: loadLogs };
}
