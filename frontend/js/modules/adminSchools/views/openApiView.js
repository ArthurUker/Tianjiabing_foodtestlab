/*
 * 开放接口视图（2026-09-15，朴食科技对接需求）
 * ------------------------------------------------------------
 * 控制台左侧「开放接口」入口：平台超管按「对接方 × 学校」开通只读数据接口。
 *   - 对接方：第三方身份（名称/备注/启停/IP 白名单/限流）
 *   - 凭证：一对一或多把 API Key（明文只显示一次；支持到期、吊销、轮换双活）
 *   - 学校授权：哪些学校、哪些检测类型、检测人是否下发、病原体是否开放、业务日期范围
 *   - 接入说明：接口地址与同步流程（对方可直接照抄）
 *   - 预览：该对接方对某校实际会拿到的 JSON 形态（脱敏后，用于人工核对）
 *
 * 后端：/api/admin/open-api/*（平台超管）；对外接口为 /api/open/v1/*（API Key 认证，
 * 与本页面无关，本页只做配置与留痕查看）。配置变更全部写 public.SystemLog 审计。
 */

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(v) {
    if (!v) return '-';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '-';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const TYPE_LABELS = {
    tableware: '餐具洁净度',
    pesticide: '果蔬农残',
    oil: '食用油品质',
    leanMeat: '肉蛋农残',
    pathogen: '病原体',
};
const ALL_TYPES = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];

export function initOpenApiView({ API_BASE, authHeaders, notify }) {
    const state = {
        clients: [],
        schools: [],
        selectedId: null,
        tab: 'grants',      // grants | credentials | guide | preview
        draft: null,        // 当前编辑中的授权草稿（切 tab 不丢）
        loaded: false,
    };

    async function api(path, opts = {}) {
        const resp = await fetch(`${API_BASE}/api/admin/open-api${path}`, {
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const text = await resp.text();
        let j = {};
        try { j = text ? JSON.parse(text) : {}; } catch (e) { j = { error: text?.slice(0, 200) }; }
        if (!resp.ok || j.success === false) throw new Error(j.error || `HTTP ${resp.status}`);
        return j.data ?? j;
    }

    const client = () => state.clients.find((c) => c.id === state.selectedId) || null;

    /* ─────────────── 骨架 ─────────────── */
    function renderSkeleton() {
        const root = document.getElementById('adminViewOpenApi');
        if (!root) return;
        root.innerHTML = `
        <div class="container mx-auto px-4 py-6 max-w-[2000px]">
            <div class="flex items-center justify-between flex-wrap gap-3 mb-4">
                <div>
                    <h2 class="text-xl font-semibold text-gray-800"><i class="fas fa-plug text-emerald-600 mr-2"></i>开放接口</h2>
                    <p class="text-xs text-gray-500 mt-1">
                        为第三方（如朴食科技）开通<b>指定学校、指定范围</b>的只读数据接口：对方持 API Key 拉取，
                        平台<b>不开放任何写入</b>；未开通的学校与检测类型一律不可见。配置变更全部写入审计日志。
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <button id="oapiNew" type="button" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition shadow"><i class="fas fa-plus mr-1"></i>新建对接方</button>
                    <button id="oapiExport" type="button" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"><i class="fas fa-file-export mr-1"></i>导出配置</button>
                    <button id="oapiImport" type="button" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"><i class="fas fa-file-import mr-1"></i>导入配置</button>
                    <button id="oapiRefresh" type="button" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"><i class="fas fa-sync-alt mr-1"></i>刷新</button>
                </div>
            </div>

            <div class="admin-card mb-4">
                <div id="oapiList">加载中…</div>
            </div>

            <div id="oapiDetail"></div>
        </div>
        <div id="oapiModal" class="hidden fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4"></div>`;

        document.getElementById('oapiNew')?.addEventListener('click', openCreateClient);
        document.getElementById('oapiRefresh')?.addEventListener('click', () => load(true));
        document.getElementById('oapiExport')?.addEventListener('click', exportConfig);
        document.getElementById('oapiImport')?.addEventListener('click', importConfig);
        bindModalDismiss();
    }

    /* ─────────────── 对接方列表 ─────────────── */
    function renderList() {
        const el = document.getElementById('oapiList');
        if (!el) return;
        if (!state.clients.length) {
            el.innerHTML = '<p class="text-sm text-gray-400 py-3">（暂无对接方，点击右上「新建对接方」开始）</p>';
            return;
        }
        const rows = state.clients.map((c) => {
            const activeGrants = c.grants.filter((g) => g.status === 'active');
            const activeKeys = c.credentials.filter((k) => k.status === 'active');
            const sel = c.id === state.selectedId;
            return `<tr class="border-b last:border-0 ${sel ? 'bg-blue-50' : ''}">
                <td class="py-2 px-2">
                    <button type="button" class="oapi-select text-left font-medium text-gray-800 hover:text-blue-700" data-id="${escapeHtml(c.id)}">
                        ${escapeHtml(c.name)}
                    </button>
                    <div class="text-xs text-gray-400">${escapeHtml(c.description || '—')}</div>
                </td>
                <td class="py-2 px-2">
                    ${c.status === 'active'
                        ? '<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-xs">启用</span>'
                        : '<span class="px-2 py-0.5 rounded bg-gray-200 text-gray-600 text-xs">已停用</span>'}
                </td>
                <td class="py-2 px-2 text-xs text-gray-600">
                    ${activeGrants.length
                        ? activeGrants.map((g) => `${escapeHtml(g.school_name || g.school_code)}<span class="text-gray-400">（${g.effective_types.map((t) => TYPE_LABELS[t] || t).join('、')}）</span>`).join('<br>')
                        : '<span class="text-gray-400">未授权任何学校</span>'}
                </td>
                <td class="py-2 px-2 text-xs text-gray-600">
                    ${activeKeys.length
                        ? activeKeys.map((k) => `<div class="font-mono">${escapeHtml(k.key_prefix)}…${escapeHtml(k.key_last4)}</div>`).join('')
                        : '<span class="text-gray-400">无有效凭证</span>'}
                </td>
                <td class="py-2 px-2 text-xs text-gray-500">${fmtTime(c.last_used_at)}</td>
                <td class="py-2 px-2 text-right whitespace-nowrap">
                    <button type="button" class="oapi-select px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100" data-id="${escapeHtml(c.id)}">配置</button>
                </td>
            </tr>`;
        }).join('');
        el.innerHTML = `<table class="w-full text-sm">
            <thead><tr class="text-left text-gray-500 border-b">
                <th class="py-2 px-2">对接方</th><th class="py-2 px-2">状态</th><th class="py-2 px-2">授权学校与范围</th>
                <th class="py-2 px-2">有效凭证</th><th class="py-2 px-2">最近调用</th><th class="py-2 px-2"></th>
            </tr></thead><tbody>${rows}</tbody></table>`;

        el.querySelectorAll('.oapi-select').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.selectedId = btn.dataset.id;
                state.draft = null;
                state.tab = 'grants';
                renderList();
                renderDetail();
            });
        });
    }

    /* ─────────────── 详情面板 ─────────────── */
    function renderDetail() {
        const host = document.getElementById('oapiDetail');
        if (!host) return;
        const c = client();
        if (!c) { host.innerHTML = ''; return; }

        const tabs = [
            ['grants', '学校授权'],
            ['credentials', '凭证管理'],
            ['guide', '接入说明'],
            ['preview', '数据预览'],
        ];
        host.innerHTML = `
        <div class="admin-card mb-4">
            <div class="flex items-start justify-between flex-wrap gap-3">
                <div>
                    <h3 class="flex items-center gap-2">
                        <i class="fas fa-handshake text-blue-500"></i>${escapeHtml(c.name)}
                        ${c.status === 'active' ? '' : '<span class="px-2 py-0.5 rounded bg-gray-200 text-gray-600 text-xs">已停用</span>'}
                    </h3>
                    <p class="text-xs text-gray-500 mt-1">
                        限流 ${c.rate_limit_per_min} 次/分钟 ·
                        IP 白名单 ${c.ip_whitelist.length ? escapeHtml(c.ip_whitelist.join('、')) : '不限制'} ·
                        最近调用 ${fmtTime(c.last_used_at)}
                        ${c.disabled_reason ? ` · 停用原因：${escapeHtml(c.disabled_reason)}` : ''}
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <button id="oapiEdit" type="button" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"><i class="fas fa-edit mr-1"></i>编辑基础信息</button>
                    <button id="oapiToggle" type="button" class="px-3 py-1.5 text-sm ${c.status === 'active' ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'} rounded-lg">
                        ${c.status === 'active' ? '<i class="fas fa-ban mr-1"></i>停用对接方' : '<i class="fas fa-check mr-1"></i>恢复启用'}
                    </button>
                </div>
            </div>
            <div class="flex items-center gap-1 mt-4 border-b border-gray-100">
                ${tabs.map(([k, label]) => `<button type="button" data-tab="${k}" class="oapi-tab px-3 py-2 text-sm ${state.tab === k ? 'text-blue-700 border-b-2 border-blue-600 font-medium' : 'text-gray-500 hover:text-gray-700'}">${label}</button>`).join('')}
            </div>
            <div id="oapiTabBody" class="pt-4"></div>
        </div>`;

        host.querySelectorAll('.oapi-tab').forEach((b) => b.addEventListener('click', () => {
            state.tab = b.dataset.tab;
            renderDetail();
        }));
        document.getElementById('oapiEdit')?.addEventListener('click', () => openEditClient(c));
        document.getElementById('oapiToggle')?.addEventListener('click', () => toggleClient(c));

        const body = document.getElementById('oapiTabBody');
        if (state.tab === 'grants') renderGrantsTab(body, c);
        else if (state.tab === 'credentials') renderCredentialsTab(body, c);
        else if (state.tab === 'guide') renderGuideTab(body, c);
        else renderPreviewTab(body, c);
    }

    /* ─────────────── 学校授权 ─────────────── */
    function ensureDraft(c) {
        if (state.draft) return state.draft;
        const map = new Map();
        for (const g of c.grants) {
            map.set(g.school_code, {
                schoolCode: g.school_code,
                enabled: g.status === 'active',
                visibleTypes: g.effective_types.filter((t) => t !== 'pathogen' || g.include_pathogen),
                includePathogen: g.include_pathogen,
                includeInspector: g.include_inspector,
                includeAttachments: g.include_attachments,
                startDate: g.start_date || '',
                endDate: g.end_date || '',
                scopeVersion: g.scope_version,
            });
        }
        state.draft = map;
        return map;
    }

    function draftItem(map, schoolCode) {
        if (!map.has(schoolCode)) {
            map.set(schoolCode, {
                schoolCode, enabled: false, visibleTypes: ['tableware', 'pesticide', 'oil', 'leanMeat'],
                includePathogen: false, includeInspector: false, includeAttachments: false,
                startDate: '', endDate: '', scopeVersion: null,
            });
        }
        return map.get(schoolCode);
    }

    /** 只读查询（渲染用）：不写入 map —— 避免"未被用户触碰的学校"也被提交（会被判为停用授权）。 */
    function peekItem(map, schoolCode) {
        return map.get(schoolCode) || {
            schoolCode, enabled: false, visibleTypes: ['tableware', 'pesticide', 'oil', 'leanMeat'],
            includePathogen: false, includeInspector: false, includeAttachments: false,
            startDate: '', endDate: '', scopeVersion: null,
        };
    }

    function draftSummary(map) {
        const on = [...map.values()].filter((g) => g.enabled);
        if (!on.length) return '当前未授权任何学校（保存后对第三方不可见任何数据）';
        return on.map((g) => {
            const types = g.visibleTypes.filter((t) => t !== 'pathogen' || g.includePathogen).map((t) => TYPE_LABELS[t] || t).join('、');
            const range = g.startDate ? `自 ${g.startDate} 起${g.endDate ? ` 至 ${g.endDate}` : ''}` : '全部时间';
            const pii = g.includeInspector ? '含检测人姓名' : '不含检测人姓名';
            return `${g.schoolCode}（${types}｜${range}｜${pii}）`;
        }).join('；');
    }

    function renderGrantsTab(host, c) {
        const map = ensureDraft(c);
        const rowHtml = state.schools.map((s) => {
            const item = peekItem(map, s.school_code);
            const disabled = s.status !== 'active';
            const typeBoxes = ALL_TYPES.map((t) => {
                const isPath = t === 'pathogen';
                const checked = item.visibleTypes.includes(t) || (isPath && item.includePathogen);
                return `<label class="inline-flex items-center gap-1 mr-3 text-xs ${disabled ? 'text-gray-300' : 'text-gray-600'}">
                    <input type="checkbox" class="oapi-type rounded" data-school="${escapeHtml(s.school_code)}" data-type="${t}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
                    ${TYPE_LABELS[t]}${isPath ? '<span class="text-[10px] text-amber-600">（敏感）</span>' : ''}
                </label>`;
            }).join('');
            return `<div class="border border-gray-100 rounded-lg p-3 mb-2 ${item.enabled ? 'bg-blue-50/40' : ''}">
                <div class="flex items-center justify-between flex-wrap gap-2">
                    <label class="inline-flex items-center gap-2 font-medium text-sm ${disabled ? 'text-gray-400' : 'text-gray-800'}">
                        <input type="checkbox" class="oapi-school rounded" data-school="${escapeHtml(s.school_code)}" ${item.enabled ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
                        ${escapeHtml(s.name)} <span class="font-mono text-xs text-gray-400">${escapeHtml(s.school_code)}</span>
                        ${disabled ? '<span class="text-xs text-gray-400">（学校已停用）</span>' : ''}
                        ${item.scopeVersion ? `<span class="text-xs text-gray-400">scope v${item.scopeVersion}</span>` : ''}
                    </label>
                    <div class="text-xs text-gray-500">
                        检测人：
                        <select class="oapi-inspector border border-gray-300 rounded px-1 py-0.5" data-school="${escapeHtml(s.school_code)}">
                            <option value="0" ${item.includeInspector ? '' : 'selected'}>不下发</option>
                            <option value="1" ${item.includeInspector ? 'selected' : ''}>下发</option>
                        </select>
                        业务日期：
                        <input type="date" class="oapi-start border border-gray-300 rounded px-1 py-0.5" data-school="${escapeHtml(s.school_code)}" value="${escapeHtml(item.startDate)}" />
                        ~
                        <input type="date" class="oapi-end border border-gray-300 rounded px-1 py-0.5" data-school="${escapeHtml(s.school_code)}" value="${escapeHtml(item.endDate)}" />
                    </div>
                </div>
                <div class="mt-2">${typeBoxes}</div>
            </div>`;
        }).join('');

        host.innerHTML = `
            <p class="text-xs text-gray-500 mb-3">
                勾选学校即授权该校数据；检测类型按白名单下发（<b>病原体默认不开放</b>，勾选即视为开放，需业务确认）。
                保存时会自动比对范围差异并递增该授权的 scope_version —— <b>范围变更后第三方会收到 409，需要重新对账同步</b>。
            </p>
            <div class="mb-3">${rowHtml}</div>
            <div class="rounded-lg bg-gray-50 border border-gray-100 p-3 text-xs text-gray-600 mb-3">
                <b>保存后效果：</b>${escapeHtml(draftSummary(map))}
            </div>
            <div class="flex items-center gap-2">
                <button id="oapiSaveGrants" type="button" class="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"><i class="fas fa-save mr-1"></i>保存授权</button>
                <button id="oapiResetGrants" type="button" class="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">重置</button>
                <span id="oapiGrantsMsg" class="text-xs text-gray-500"></span>
            </div>`;

        host.querySelectorAll('.oapi-school').forEach((cb) => cb.addEventListener('change', () => {
            const item = draftItem(map, cb.dataset.school);
            item.enabled = cb.checked;
            renderDetail();
        }));
        host.querySelectorAll('.oapi-type').forEach((cb) => cb.addEventListener('change', () => {
            const item = draftItem(map, cb.dataset.school);
            const t = cb.dataset.type;
            if (t === 'pathogen') {
                item.includePathogen = cb.checked;
                item.visibleTypes = cb.checked
                    ? [...new Set([...item.visibleTypes, 'pathogen'])]
                    : item.visibleTypes.filter((x) => x !== 'pathogen');
            } else {
                item.visibleTypes = cb.checked
                    ? [...new Set([...item.visibleTypes, t])]
                    : item.visibleTypes.filter((x) => x !== t);
            }
            renderDetail();
        }));
        host.querySelectorAll('.oapi-inspector').forEach((sel) => sel.addEventListener('change', () => {
            draftItem(map, sel.dataset.school).includeInspector = sel.value === '1';
            renderDetail();
        }));
        host.querySelectorAll('.oapi-start').forEach((inp) => inp.addEventListener('change', () => {
            draftItem(map, inp.dataset.school).startDate = inp.value;
        }));
        host.querySelectorAll('.oapi-end').forEach((inp) => inp.addEventListener('change', () => {
            draftItem(map, inp.dataset.school).endDate = inp.value;
        }));
        document.getElementById('oapiResetGrants')?.addEventListener('click', () => { state.draft = null; renderDetail(); });
        document.getElementById('oapiSaveGrants')?.addEventListener('click', saveGrants);
    }

    async function saveGrants() {
        const c = client();
        const map = state.draft;
        if (!c || !map) return;
        const msg = document.getElementById('oapiGrantsMsg');
        const grants = [...map.values()].map((g) => ({
            schoolCode: g.schoolCode,
            visibleTypes: g.visibleTypes.filter((t) => t !== 'pathogen' || g.includePathogen),
            includePathogen: g.includePathogen,
            includeInspector: g.includeInspector,
            includeAttachments: g.includeAttachments,
            startDate: g.startDate || null,
            endDate: g.endDate || null,
            status: g.enabled ? 'active' : 'disabled',
        }));
        const enabled = grants.filter((g) => g.status === 'active');
        if (enabled.length && !confirm(`确认保存授权？\n\n${draftSummary(map)}\n\n范围变更会使第三方的增量游标失效（需重新对账同步）。`)) return;
        if (msg) msg.textContent = '保存中…';
        try {
            const data = await api(`/clients/${c.id}/grants`, { method: 'PUT', body: { grants } });
            const changed = (data.applied || []).filter((a) => a.action === 'updated').map((a) => a.school_code);
            notify(`授权已保存${changed.length ? `（范围变更：${changed.join('、')} → 需通知对方重新同步）` : ''}`, 'success');
            state.draft = null;
            await load(false);
        } catch (e) {
            if (msg) msg.textContent = `保存失败：${e.message}`;
            notify(e.message || '保存授权失败', 'error');
        }
    }

    /* ─────────────── 凭证管理 ─────────────── */
    function renderCredentialsTab(host, c) {
        const rows = c.credentials.map((k) => {
            const expired = k.expires_at && new Date(k.expires_at).getTime() <= Date.now();
            const st = k.status === 'revoked'
                ? '<span class="px-2 py-0.5 rounded bg-gray-200 text-gray-600 text-xs">已吊销</span>'
                : expired
                    ? '<span class="px-2 py-0.5 rounded bg-amber-50 text-amber-700 text-xs">已过期</span>'
                    : '<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-xs">有效</span>';
            return `<tr class="border-b last:border-0">
                <td class="py-2 px-2">${escapeHtml(k.label)}</td>
                <td class="py-2 px-2 font-mono text-xs">${escapeHtml(k.key_prefix)}…${escapeHtml(k.key_last4)}</td>
                <td class="py-2 px-2">${st}</td>
                <td class="py-2 px-2 text-xs text-gray-500">${k.expires_at ? `至 ${fmtTime(k.expires_at)}` : '长期有效'}</td>
                <td class="py-2 px-2 text-xs text-gray-500">${fmtTime(k.last_used_at)}</td>
                <td class="py-2 px-2 text-xs text-gray-500">${k.call_count}</td>
                <td class="py-2 px-2 text-xs text-gray-500">${escapeHtml(k.revoked_reason || '')}</td>
                <td class="py-2 px-2 text-right">
                    ${k.status === 'active' && !expired
                        ? `<button type="button" class="oapi-revoke px-2 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100" data-cid="${escapeHtml(k.id)}">吊销</button>`
                        : ''}
                </td>
            </tr>`;
        }).join('');

        host.innerHTML = `
            <p class="text-xs text-gray-500 mb-3">
                密钥明文<b>只在生成时显示一次</b>（库中仅存哈希，无法找回）。轮换做法：先生成新密钥交给对方，
                旧密钥到期后自动失效（建议重叠期 1~7 天）。输入调用次数为节流累加值，仅供参考。
            </p>
            <div class="flex items-center gap-2 mb-3">
                <input id="oapiKeyLabel" type="text" placeholder="凭证备注（如：生产 / 沙箱 / 2026-09 轮换）" class="px-2 py-1.5 text-sm border border-gray-300 rounded-lg w-72" />
                <input id="oapiKeyDays" type="number" min="1" max="3650" placeholder="有效天数（留空=长期）" class="px-2 py-1.5 text-sm border border-gray-300 rounded-lg w-52" />
                <button id="oapiNewKey" type="button" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"><i class="fas fa-key mr-1"></i>生成新密钥</button>
            </div>
            ${c.credentials.length ? `<table class="w-full text-sm">
                <thead><tr class="text-left text-gray-500 border-b">
                    <th class="py-2 px-2">备注</th><th class="py-2 px-2">Key</th><th class="py-2 px-2">状态</th>
                    <th class="py-2 px-2">有效期</th><th class="py-2 px-2">最近使用</th><th class="py-2 px-2">调用次数</th>
                    <th class="py-2 px-2">吊销原因</th><th class="py-2 px-2"></th>
                </tr></thead><tbody>${rows}</tbody></table>`
                : '<p class="text-sm text-gray-400 py-2">（尚无凭证，生成后即可交付对方接入）</p>'}`;

        document.getElementById('oapiNewKey')?.addEventListener('click', createCredential);
        host.querySelectorAll('.oapi-revoke').forEach((b) => b.addEventListener('click', () => revokeCredential(b.dataset.cid)));
    }

    async function createCredential() {
        const c = client();
        if (!c) return;
        const label = document.getElementById('oapiKeyLabel')?.value?.trim() || '生产';
        const daysRaw = document.getElementById('oapiKeyDays')?.value;
        if (daysRaw && !confirm('设置有效期后，到期将自动失效（对方需在此之前换用新密钥）。确认继续？')) return;
        try {
            const data = await api(`/clients/${c.id}/credentials`, {
                method: 'POST',
                body: { label, expires_in_days: daysRaw ? Number(daysRaw) : null },
            });
            openModal(`<h4 class="text-base font-semibold text-gray-800 mb-2"><i class="fas fa-key text-amber-500 mr-2"></i>密钥已生成（仅显示这一次）</h4>
                <p class="text-xs text-gray-500 mb-3">请立即复制并通过安全渠道发给对方。关闭后无法再次查看，只能吊销重发。</p>
                <div class="flex items-center gap-2">
                    <input id="oapiKeyPlain" type="text" readonly value="${escapeHtml(data.api_key)}" class="flex-1 px-3 py-2 border border-gray-300 rounded-lg font-mono text-xs bg-gray-50" />
                    <button id="oapiKeyCopy" type="button" class="px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">复制</button>
                </div>
                <p class="text-xs text-gray-400 mt-2">备注：${escapeHtml(data.label)}${data.expires_at ? ` · 有效期至 ${fmtTime(data.expires_at)}` : ' · 长期有效'}</p>
                <div class="flex justify-end mt-4">
                    <button id="oapiKeyClose" type="button" class="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">我已复制，关闭</button>
                </div>`, { dismissible: false });
            document.getElementById('oapiKeyCopy')?.addEventListener('click', async () => {
                const input = document.getElementById('oapiKeyPlain');
                try { await navigator.clipboard.writeText(input.value); notify('密钥已复制', 'success'); }
                catch (e) { input.select(); document.execCommand?.('copy'); notify('密钥已复制', 'success'); }
            });
            document.getElementById('oapiKeyClose')?.addEventListener('click', () => {
                if (!confirm('关闭后无法再次查看该密钥（库中只存哈希、无法找回），确认已经复制或保存？')) return;
                closeModal();
                notify('弹窗已关闭；如未保存，请在「凭证管理」吊销后重新生成', 'success');
            });
            await load(false);
        } catch (e) {
            notify(e.message || '生成密钥失败', 'error');
        }
    }

    async function revokeCredential(cid) {
        const c = client();
        if (!c) return;
        if (!confirm('确认吊销该密钥？对方将立即无法调用（不可恢复）。')) return;
        try {
            await api(`/clients/${c.id}/credentials/${cid}/revoke`, { method: 'POST', body: { reason: '超管手动吊销' } });
            notify('密钥已吊销', 'success');
            await load(false);
        } catch (e) {
            notify(e.message || '吊销失败', 'error');
        }
    }

    /* ─────────────── 接入说明 ─────────────── */
    function renderGuideTab(host, c) {
        const base = `${location.origin}/api/open/v1`;
        const keySample = c.credentials.find((k) => k.status === 'active')?.key_prefix
            ? `${c.credentials.find((k) => k.status === 'active').key_prefix}…（完整密钥只在生成时显示）`
            : 'oap_xxxxxxxx…（请先生成密钥）';
        host.innerHTML = `
            <div class="text-sm text-gray-700 space-y-3">
                <div class="rounded-lg bg-blue-50 border border-blue-100 p-3 text-xs">
                    <b>接口地址</b>（只读）：<code class="font-mono">${escapeHtml(base)}</code><br>
                    认证方式：请求头 <code class="font-mono">X-API-Key: &lt;密钥&gt;</code>（亦支持 <code class="font-mono">Authorization: Bearer &lt;密钥&gt;</code>）<br>
                    当前对接方密钥：<code class="font-mono">${escapeHtml(keySample)}</code>
                </div>
                <div>
                    <b>可用端点</b>
                    <ul class="list-disc pl-5 text-xs text-gray-600 mt-1 space-y-0.5">
                        <li><code class="font-mono">GET /ping</code> — 连通性与服务器时间</li>
                        <li><code class="font-mono">GET /profile</code> — 当前密钥的授权范围（含 scope_version）</li>
                        <li><code class="font-mono">GET /schools</code> — 授权学校列表</li>
                        <li><code class="font-mono">GET /dict?school_code=</code> — 检测类型 / 食堂 / 结论枚举</li>
                        <li><code class="font-mono">GET /sync/manifest?school_code=[&detail=1]</code> — 全量清单与摘要指纹（对账 / 删除感知）</li>
                        <li><code class="font-mono">GET /test-records?school_code=&cursor=&limit=</code> — 检测记录增量拉取</li>
                        <li><code class="font-mono">GET /stats?school_code=&start=&end=</code> — 合格率统计（对账）</li>
                    </ul>
                </div>
                <div class="rounded-lg bg-gray-50 border border-gray-100 p-3">
                    <b class="text-xs">同步流程（对接方实现）</b>
                    <ol class="list-decimal pl-5 text-xs text-gray-600 mt-1 space-y-0.5">
                        <li>每轮同步先调 <code class="font-mono">sync/manifest</code>（默认只回 total+digest），digest 一致即结束；</li>
                        <li>digest 变化 → <code class="font-mono">detail=1</code> 拉全量清单，本地 diff 出「新增 / 变更 / 已删除」；</li>
                        <li>本轮删除感知：<b>本地有、清单没有 = 该记录已删除</b>（平台侧为硬删除，无回收站）；</li>
                        <li>明细用 <code class="font-mono">test-records</code> 游标增量拉取，中断后带 <code class="font-mono">cursor</code> 续传；</li>
                        <li>返回 <code class="font-mono">409 SCOPE_CHANGED</code> 表示授权范围已变更，需重新对账（回到第 1 步）。</li>
                    </ol>
                    <p class="text-[11px] text-gray-500 mt-2">
                        提示：条数与合格率对账时请以 <code class="font-mono">/stats</code> 为准（其口径排除检测日期缺失的脏数据，可能与明细条数相差极少数）。
                    </p>
                </div>
                <div>
                    <b class="text-xs">调用示例</b>
                    <pre class="bg-gray-900 text-gray-100 text-[11px] rounded-lg p-3 mt-1 overflow-x-auto">curl -H "X-API-Key: &lt;密钥&gt;" "${escapeHtml(base)}/ping"
curl -H "X-API-Key: &lt;密钥&gt;" "${escapeHtml(base)}/sync/manifest?school_code=&lt;学校代码&gt;&detail=1"
curl -H "X-API-Key: &lt;密钥&gt;" "${escapeHtml(base)}/test-records?school_code=&lt;学校代码&gt;&limit=100"</pre>
                </div>
                <p class="text-xs text-gray-500">
                    ⚠️ 停用对接方或吊销密钥只能阻止<b>后续读取</b>，已下载到对方数据库的数据需按双方约定另行处理；
                    收紧授权时请在下方「待通知清单」中确认需对方清理的范围。
                </p>
            </div>`;
    }

    /* ─────────────── 数据预览 ─────────────── */
    function renderPreviewTab(host, c) {
        const active = c.grants.filter((g) => g.status === 'active');
        host.innerHTML = `
            <p class="text-xs text-gray-500 mb-3">选择学校抽样预览：这是对方通过接口实际会拿到的 JSON（内部字段与检测人姓名默认已剔除）。</p>
            <div class="flex items-center gap-2 mb-3">
                <select id="oapiPreviewSchool" class="px-2 py-1.5 text-sm border border-gray-300 rounded-lg">
                    ${active.map((g) => `<option value="${escapeHtml(g.school_code)}">${escapeHtml(g.school_name || g.school_code)}</option>`).join('')}
                </select>
                <button id="oapiPreviewRun" type="button" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700" ${active.length ? '' : 'disabled'}>预览</button>
                <span class="text-xs text-gray-400">（未授权任何学校时无法预览）</span>
            </div>
            <pre id="oapiPreviewOut" class="bg-gray-900 text-gray-100 text-[11px] rounded-lg p-3 overflow-auto max-h-[480px]">（点击「预览」查看）</pre>`;
        document.getElementById('oapiPreviewRun')?.addEventListener('click', async () => {
            const schoolCode = document.getElementById('oapiPreviewSchool')?.value;
            const out = document.getElementById('oapiPreviewOut');
            if (!schoolCode) return;
            if (out) out.textContent = '加载中…';
            try {
                const data = await api(`/clients/${c.id}/preview?schoolCode=${encodeURIComponent(schoolCode)}&limit=3`);
                if (out) out.textContent = JSON.stringify(data, null, 2);
            } catch (e) {
                if (out) out.textContent = `预览失败：${e.message}`;
            }
        });
    }

    /* ─────────────── 对接方增删改 ─────────────── */
    function openCreateClient() {
        openModal(`<h4 class="text-base font-semibold text-gray-800 mb-3"><i class="fas fa-plus text-blue-600 mr-2"></i>新建对接方</h4>
            <div class="space-y-3 text-sm">
                <label class="block"><span class="text-gray-600">名称 *</span>
                    <input id="oapiNewName" type="text" placeholder="如：朴食科技" class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg" /></label>
                <label class="block"><span class="text-gray-600">备注 / 联系人</span>
                    <input id="oapiNewDesc" type="text" placeholder="如：对接人 球哥 / 用于智慧食堂食安模块" class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg" /></label>
                <label class="block"><span class="text-gray-600">IP 白名单（逗号分隔，留空=不限制）</span>
                    <input id="oapiNewIp" type="text" placeholder="如：203.0.113.10, 198.51.100.0/24" class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg" /></label>
                <label class="block"><span class="text-gray-600">限流（次/分钟）</span>
                    <input id="oapiNewRate" type="number" min="1" max="6000" value="60" class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg" /></label>
            </div>
            <div class="flex justify-end gap-2 mt-4">
                <button type="button" class="oapi-cancel px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">取消</button>
                <button id="oapiNewSubmit" type="button" class="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">创建</button>
            </div>`);
        bindModalCancel();
        document.getElementById('oapiNewSubmit')?.addEventListener('click', async () => {
            const name = document.getElementById('oapiNewName')?.value?.trim();
            if (!name) { notify('请填写名称', 'error'); return; }
            const ipRaw = document.getElementById('oapiNewIp')?.value || '';
            const ip_whitelist = ipRaw.split(',').map((s) => s.trim()).filter(Boolean);
            try {
                await api('/clients', {
                    method: 'POST',
                    body: {
                        name,
                        description: document.getElementById('oapiNewDesc')?.value?.trim() || null,
                        ip_whitelist,
                        rate_limit_per_min: Number(document.getElementById('oapiNewRate')?.value) || 60,
                    },
                });
                closeModal();
                notify('对接方已创建，下一步：生成密钥 + 勾选学校授权', 'success');
                await load(false);
            } catch (e) {
                notify(e.message || '创建失败', 'error');
            }
        });
    }

    function openEditClient(c) {
        openModal(`<h4 class="text-base font-semibold text-gray-800 mb-3"><i class="fas fa-edit text-blue-600 mr-2"></i>编辑「${escapeHtml(c.name)}」</h4>
            <div class="space-y-3 text-sm">
                <label class="block"><span class="text-gray-600">名称 *</span>
                    <input id="oapiEditName" type="text" value="${escapeHtml(c.name)}" class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg" /></label>
                <label class="block"><span class="text-gray-600">备注 / 联系人</span>
                    <input id="oapiEditDesc" type="text" value="${escapeHtml(c.description || '')}" class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg" /></label>
                <label class="block"><span class="text-gray-600">IP 白名单（逗号分隔，留空=不限制）</span>
                    <input id="oapiEditIp" type="text" value="${escapeHtml(c.ip_whitelist.join(', '))}" class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg" /></label>
                <label class="block"><span class="text-gray-600">限流（次/分钟）</span>
                    <input id="oapiEditRate" type="number" min="1" max="6000" value="${c.rate_limit_per_min}" class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg" /></label>
            </div>
            <div class="flex justify-end gap-2 mt-4">
                <button type="button" class="oapi-cancel px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">取消</button>
                <button id="oapiEditSubmit" type="button" class="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">保存</button>
            </div>`);
        bindModalCancel();
        document.getElementById('oapiEditSubmit')?.addEventListener('click', async () => {
            try {
                await api(`/clients/${c.id}`, {
                    method: 'PATCH',
                    body: {
                        name: document.getElementById('oapiEditName')?.value?.trim(),
                        description: document.getElementById('oapiEditDesc')?.value?.trim() || null,
                        ip_whitelist: (document.getElementById('oapiEditIp')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
                        rate_limit_per_min: Number(document.getElementById('oapiEditRate')?.value) || 60,
                    },
                });
                closeModal();
                notify('已保存', 'success');
                await load(false);
            } catch (e) {
                notify(e.message || '保存失败', 'error');
            }
        });
    }

    async function toggleClient(c) {
        const disabling = c.status === 'active';
        if (disabling && !confirm(`确认停用「${c.name}」？其全部密钥将立即失效，对方无法再拉取任何数据。`)) return;
        try {
            await api(`/clients/${c.id}`, {
                method: 'PATCH',
                body: { status: disabling ? 'disabled' : 'active', disabled_reason: disabling ? '超管手动停用' : undefined },
            });
            notify(disabling ? '对接方已停用' : '对接方已恢复', 'success');
            await load(false);
        } catch (e) {
            notify(e.message || '操作失败', 'error');
        }
    }

    /* ─────────────── 配置导出 / 导入 ─────────────── */
    function exportConfig() {
        // 走浏览器下载（不带 Authorization 的同源下载会 401，故用 fetch + blob）
        fetch(`${API_BASE}/api/admin/open-api/export`, { headers: authHeaders() })
            .then(async (r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const text = await r.text();
                const blob = new Blob([text], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `open-api-config-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(a.href);
                notify('配置已导出（含密钥哈希，不含明文密钥）', 'success');
            })
            .catch((e) => notify(e.message || '导出失败', 'error'));
    }

    function importConfig() {
        openModal(`<h4 class="text-base font-semibold text-gray-800 mb-3"><i class="fas fa-file-import text-blue-600 mr-2"></i>导入配置</h4>
            <p class="text-xs text-gray-500 mb-2">粘贴导出的 JSON（用于灾后重建；按 id upsert，凭证按 key_hash 去重，不会重复创建）。</p>
            <textarea id="oapiImportText" rows="10" class="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-xs" placeholder='{"version":1,"clients":[...]}'></textarea>
            <div class="flex justify-end gap-2 mt-3">
                <button type="button" class="oapi-cancel px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">取消</button>
                <button id="oapiImportSubmit" type="button" class="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">导入</button>
            </div>`);
        bindModalCancel();
        document.getElementById('oapiImportSubmit')?.addEventListener('click', async () => {
            let payload;
            try { payload = JSON.parse(document.getElementById('oapiImportText')?.value || '{}'); }
            catch (e) { notify('JSON 解析失败', 'error'); return; }
            try {
                const data = await api('/import', { method: 'POST', body: payload });
                closeModal();
                notify(`导入完成：对接方 ${data.clientCount} / 授权 ${data.grantCount} / 凭证 ${data.credentialCount}`, 'success');
                await load(false);
            } catch (e) {
                notify(e.message || '导入失败', 'error');
            }
        });
    }

    /* ─────────────── 弹层工具 ─────────────── */
    // dismissible=false 用于「一次性密钥」这类误关即不可恢复的弹窗：不响应遮罩点击与 ESC，
    // 必须点弹窗内的显式按钮关闭（2026-09-15 用户反馈：密钥弹窗无关闭入口）。
    function openModal(html, opts = {}) {
        const m = document.getElementById('oapiModal');
        if (!m) return;
        const dismissible = opts.dismissible !== false;
        m.dataset.dismissible = dismissible ? '1' : '0';
        m.innerHTML = `<div class="relative bg-white rounded-xl shadow-2xl w-full max-w-xl p-5 pt-8 max-h-[85vh] overflow-y-auto">
            <button type="button" id="oapiModalX" title="关闭"
                    class="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 text-xl leading-none">&times;</button>
            ${html}</div>`;
        m.classList.remove('hidden');
        // 右上角 ×：普通弹窗直接关；一次性密钥弹窗需二次确认（不可恢复）
        document.getElementById('oapiModalX')?.addEventListener('click', () => {
            if (dismissible) return closeModal();
            if (!confirm('关闭后无法再次查看该密钥（库中只存哈希、无法找回），确认已经复制或保存？')) return;
            closeModal();
        });
    }
    function closeModal() {
        const m = document.getElementById('oapiModal');
        if (m) { m.classList.add('hidden'); m.innerHTML = ''; }
    }
    function bindModalCancel() {
        document.querySelectorAll('.oapi-cancel').forEach((b) => b.addEventListener('click', closeModal));
    }
    function bindModalDismiss() {
        const m = document.getElementById('oapiModal');
        if (!m) return;
        // 点遮罩（弹窗内容之外）关闭；仅对可关闭弹窗生效
        m.addEventListener('click', (e) => {
            if (e.target !== m) return;
            if (m.dataset.dismissible === '0') return;
            closeModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || m.classList.contains('hidden')) return;
            if (m.dataset.dismissible === '0') return;
            closeModal();
        });
    }

    /* ─────────────── 数据加载 ─────────────── */
    async function load(showNotice) {
        try {
            if (!state.schools.length) {
                const sResp = await fetch(`${API_BASE}/api/admin/schools`, { headers: authHeaders() });
                const sJson = await sResp.json().catch(() => ({}));
                state.schools = (sJson.data || []).map((s) => ({ school_code: s.code, name: s.name, status: s.status }));
            }
            const data = await api('/clients');
            state.clients = data.clients || data || [];
            if (state.selectedId && !client()) state.selectedId = null;
            renderList();
            renderDetail();
            state.loaded = true;
            if (showNotice) notify('已刷新', 'success');
        } catch (e) {
            const el = document.getElementById('oapiList');
            if (el) el.innerHTML = `<p class="text-sm text-red-600 py-3">加载失败：${escapeHtml(e.message)}</p>`;
            notify(e.message || '加载开放接口配置失败', 'error');
        }
    }

    renderSkeleton();
    load(false);

    return { reload: load };
}
