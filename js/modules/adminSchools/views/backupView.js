/*
* 备份运维视图（P-BackupOps v3）
* ------------------------------------------------------------
* 学校管理控制台左侧「备份运维」入口的二级视图集合：
*   - global : 全局备份（一键备份全部学校租户 + 全局备份列表）
*   - single : 单点备份（学校列表 → 学校详情 → 单校备份）
*   - restore: 恢复管理（三段式：目标学校 / 选择备份数据源 / 流程确认与执行）
*
* 恢复管理 v3 改造要点：
*   - 卡片 1「目标学校」保留单选/多选/全选能力；
*   - 卡片 2「选择备份数据源」按学校选择模式动态加载备份列表：
*       · 单选学校  → 可看 全局备份 + 该校自己的单点备份
*       · 多选/全选 → 只能看 全局备份（其余类型不展示，不可选择）
*     备份数据来源支持：① 备份库选择（单选一份） ② 本地文件上传（.aes + .meta.json）
*   - 卡片 3「流程确认与执行」做摘要提示 + 确认词 + 统一执行入口（不再有模态）
*
* 后端：/api/admin/backups / /api/admin/schools（super_admin）
*/

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
    if (n == null) return '-';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(s) {
    if (!s) return '-';
    const d = new Date(s);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function verifyBadge(r) {
    if (r.verifyStatus === 'passed') return '<span class="text-green-600 text-xs"><i class="fas fa-check-circle mr-1"></i>已验证</span>';
    if (r.verifyStatus === 'failed') return '<span class="text-red-600 text-xs"><i class="fas fa-times-circle mr-1"></i>验证失败</span>';
    return '<span class="text-gray-400 text-xs">未验证</span>';
}

function typeBadge(r) {
    return r.scope === 'all'
        ? '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-600 border border-blue-100"><i class="fas fa-globe mr-1"></i>全局</span>'
        : '<span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-indigo-50 text-indigo-600 border border-indigo-100"><i class="fas fa-bullseye mr-1"></i>单点</span>';
}

function btn(icon, text, cls = '', attrs = '') {
    return `<button type="button" class="px-2 py-1 text-xs rounded border ${cls}" ${attrs}>${icon ? `<i class="fas ${icon} mr-1"></i>` : ''}${text}</button>`;
}

import { TablePager, paginateArray } from '../components/tablePager.js';

export function initBackupView({ API_BASE, authHeaders, notify }) {
    // 公共状态
    let activeSub = 'global';
    let allSchools = [];

    // 分页实例（每个子视图独立）
    const pagers = { global: null, single: null, restoreSchool: null, restoreBackup: null };

    // 单点备份视图状态
    let singleSelectedSchool = null;
    let singleFilter = '';

    // 恢复管理视图状态（v3 重构）
    let restoreSelectedSchools = new Set();
    let restoreSchoolFilter = '';
    let restoreScopeFilter = '';
    let restoreBackupFilter = '';
    let restoreCurrentBackups = [];
    /** 选中的备份来源：'server' = 从备份库选；'local' = 本地上传 */
    let restoreSourceTab = 'server';
    /** 服务端选中：当前选中的备份 id（仅允许单选一份） */
    let restoreSelectedBackupId = null;
    /** 本地选中：上传的 { dataFile: File, metaFile?: File, meta?: object } */
    let restoreLocalPayload = null;

    const api = (path, opts = {}) => {
        const headers = authHeaders();
        const body = opts.body;
        const isJson = body && typeof body === 'string' && body.trim().startsWith('{');
        return fetch(`${API_BASE}/api/admin/backups${path}`, {
            ...opts,
            headers: { ...headers, ...(opts.headers || {}), ...(isJson ? { 'Content-Type': 'application/json' } : {}) }
        }).then(async (r) => {
            if (r.status === 204) return { success: true, data: [], total: 0 };
            const ct = r.headers.get('content-type') || '';
            const text = await r.text();
            let j = null;
            try { j = text ? JSON.parse(text) : null; } catch (e) { /* ignore */ }
            if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
            return j || { success: true };
        });
    };

    /** 直接调 adminBackup 的 API（不强行 JSON 解析） */
    const apiRaw = (path, opts = {}) => {
        return fetch(`${API_BASE}${path}`, {
            ...opts,
            headers: { ...authHeaders(), ...(opts.headers || {}) }
        });
    };

    // ===================== 学校列表（公共） =====================
    async function loadSchools(force = false) {
        if (!force && allSchools.length) return allSchools;
        try {
            const r = await fetch(`${API_BASE}/api/admin/schools?limit=500`, { headers: authHeaders() });
            const text = await r.text();
            let j = null;
            try { j = text ? JSON.parse(text) : null; } catch (e) { /* ignore */ }
            if (!r.ok) {
                notify(`加载学校列表失败：${(j && j.error) || `HTTP ${r.status}`}`);
                allSchools = [];
            } else {
                allSchools = (j && j.data) || [];
            }
        } catch (e) {
            notify(`加载学校列表异常：${e.message}`);
            allSchools = [];
        }
        return allSchools;
    }

    // ===================== 全局备份子视图 =====================
    async function loadGlobalKpis() {
        try {
            const j = await api(`/?scope=all&pageSize=500`);
            const rows = j.data || [];
            const passed = rows.filter((r) => r.verifyStatus === 'passed').length;
            const failed = rows.filter((r) => r.verifyStatus === 'failed').length;
            const pending = rows.length - passed - failed;
            const latest = rows[0];
            const set = (id, v) => {
                const el = document.getElementById(id);
                if (el) el.textContent = v;
            };
            set('bkGlobalKpiTotal', String(rows.length));
            set('bkGlobalKpiVerified', String(passed));
            set('bkGlobalKpiFailed', String(failed + pending));
            set('bkGlobalKpiLatest', latest ? fmtTime(latest.createdAt) : '-');
        } catch (e) {
            console.error('[backupView] 加载全局 KPI 失败', e);
        }
    }

    async function loadGlobalBackups(page = 1) {
        if (!pagers.global) {
            pagers.global = new TablePager({
                id: 'bkGlobal',
                containerId: 'bkGlobalPager',
                defaultPerPage: 15,
                onChange: (state) => loadGlobalBackups(state.page),
            }).mount();
        }
        pagers.global.setPage(page);
        const tbody = document.getElementById('bkGlobalList');
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-400 py-6">加载中…</td></tr>';
        try {
            const j = await api(`/?scope=all&page=${page}&pageSize=${pagers.global.perPage}`);
            const rows = j.data || [];
            renderBackupTable('bkGlobalList', rows, { showType: true });
            pagers.global.setTotal(j.total || 0);
        } catch (e) {
            notify(`加载全局备份列表失败：${e.message}`);
            renderBackupTable('bkGlobalList', [], { showType: true });
            pagers.global.setTotal(0).setPage(1);
        }
    }

    async function runGlobalBackup() {
        if (!confirm('确认触发全局备份？将备份所有学校租户及系统表。')) return;
        try {
            const j = await api('/run', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
            notify(`全局备份完成：${j.data?.file || ''}`);
            loadGlobalBackups(1);
            loadGlobalKpis();
        } catch (e) {
            notify(`全局备份失败：${e.message}`);
        }
    }

    function bindGlobalEvents() {
        document.getElementById('bkGlobalRunAll')?.addEventListener('click', runGlobalBackup);
        document.getElementById('bkGlobalRefresh')?.addEventListener('click', () => { loadGlobalBackups(1); loadGlobalKpis(); });
    }

    // ===================== 单点备份子视图 =====================
    async function loadSingleSchools() {
        await loadSchools();
        loadSingleKpis();
        renderSingleSchoolGrid();
    }

    async function loadSingleKpis() {
        try {
            const j = await api(`/?scope=single&pageSize=500`);
            const rows = j.data || [];
            const backedCodes = new Set(rows.map((r) => r.schoolCode).filter(Boolean));
            const latest = rows[0];
            const set = (id, v) => {
                const el = document.getElementById(id);
                if (el) el.textContent = v;
            };
            set('bkSingleKpiTotal', String(allSchools.length));
            set('bkSingleKpiBacked', String(backedCodes.size));
            set('bkSingleKpiLatest', latest ? fmtTime(latest.createdAt) : '-');
        } catch (e) {
            console.error('[backupView] 加载单点 KPI 失败', e);
        }
    }

    function renderSingleSchoolGrid() {
        const grid = document.getElementById('singleSchoolGrid');
        if (!grid) return;
        const term = singleFilter.trim().toLowerCase();
        const list = allSchools.filter((s) => {
            if (!term) return true;
            return (s.name || '').toLowerCase().includes(term) || (s.code || '').toLowerCase().includes(term);
        });

        const countEl = document.getElementById('singleSchoolCount');
        if (countEl) countEl.textContent = `共 ${list.length} 所学校`;

        grid.innerHTML = list.length
            ? list.map((s) => {
                const isActive = singleSelectedSchool && singleSelectedSchool.code === s.code;
                return `
                    <button type="button" class="single-school-card ${isActive ? 'active' : ''}" data-code="${escapeHtml(s.code)}">
                        <span class="icon bg-gradient-to-br from-teal-400 to-blue-500">
                            ${escapeHtml((s.name || s.code || '?').slice(0, 1))}
                        </span>
                        <div class="meta">
                            <div class="title truncate">${escapeHtml(s.name || s.code)}</div>
                            <div class="code truncate">${escapeHtml(s.code)}</div>
                        </div>
                        <span class="arrow"><i class="fas fa-chevron-right"></i></span>
                    </button>
                `;
            }).join('')
            : '<div class="text-center text-gray-400 py-8 text-sm">未找到匹配学校</div>';
    }

    function switchSingleSchool(code) {
        const school = allSchools.find((s) => s.code === code);
        if (!school) return;
        singleSelectedSchool = school;
        pagers.single = null; // 切换学校后重建分页器，避免 onChange 闭包引用旧学校
        renderSingleSchoolGrid();
        document.getElementById('singleDetailTitle').textContent = `${escapeHtml(school.name || school.code)} 的单点备份`;
        document.getElementById('singleDetailSub').textContent = `对学校 ${escapeHtml(school.code)} 单独执行备份，仅转储该租户 schema 数据`;
        const runBtn = document.getElementById('singleRunBackup');
        if (runBtn) runBtn.disabled = false;
        loadSingleBackups(code, 1);
    }

    /** 回到单点备份的学校列表态：清空选中学校与筛选，重置右侧详情面板 */
    function backToSingleList() {
        singleSelectedSchool = null;
        singleFilter = '';
        const filterInput = document.getElementById('singleSchoolFilter');
        if (filterInput) filterInput.value = '';
        const title = document.getElementById('singleDetailTitle');
        if (title) title.textContent = '请选择学校';
        const sub = document.getElementById('singleDetailSub');
        if (sub) sub.textContent = '点击左侧学校查看备份记录并执行单点备份';
        const runBtn = document.getElementById('singleRunBackup');
        if (runBtn) runBtn.disabled = true;
        const tbody = document.getElementById('bkSingleList');
        if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-400 py-10">请先选择左侧学校</td></tr>';
        const pager = document.getElementById('bkSinglePager');
        if (pager) pager.innerHTML = '';
        pagers.single = null; // 重建分页器，避免闭包引用旧学校
        renderSingleSchoolGrid();
    }

    async function loadSingleBackups(schoolCode, page = 1) {
        if (!pagers.single) {
            pagers.single = new TablePager({
                id: 'bkSingle',
                containerId: 'bkSinglePager',
                defaultPerPage: 15,
                onChange: (state) => loadSingleBackups(schoolCode, state.page),
            }).mount();
        }
        pagers.single.setPage(page);
        const tbody = document.getElementById('bkSingleList');
        if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-400 py-6">加载中…</td></tr>';
        try {
            const j = await api(`/?scope=single&schoolCode=${encodeURIComponent(schoolCode)}&page=${page}&pageSize=${pagers.single.perPage}`);
            const rows = j.data || [];
            renderBackupTable('bkSingleList', rows, { showType: false });
            pagers.single.setTotal(j.total || 0);
        } catch (e) {
            notify(`加载单点备份列表失败：${e.message}`);
            renderBackupTable('bkSingleList', [], { showType: false });
            pagers.single.setTotal(0).setPage(1);
        }
    }

    async function runSingleBackup() {
        if (!singleSelectedSchool) return;
        const { code, name } = singleSelectedSchool;
        if (!confirm(`确认对学校 ${name || code}（${code}）执行单点备份？`)) return;
        try {
            const j = await api('/run', { method: 'POST', body: JSON.stringify({ scope: 'single', schoolCode: code }) });
            notify(`单点备份完成：${j.data?.file || ''}`);
            loadSingleBackups(code, 1);
        } catch (e) {
            notify(`单点备份失败：${e.message}`);
        }
    }

    function bindSingleEvents() {
        document.getElementById('singleSchoolFilter')?.addEventListener('input', (e) => {
            singleFilter = e.target.value || '';
            renderSingleSchoolGrid();
        });
        document.getElementById('singleSchoolRefresh')?.addEventListener('click', () => loadSingleSchools());
        document.getElementById('singleSchoolGrid')?.addEventListener('click', (e) => {
            const card = e.target.closest('button[data-code]');
            if (card) switchSingleSchool(card.dataset.code);
        });
        document.getElementById('singleRunBackup')?.addEventListener('click', runSingleBackup);
    }

    // ===================== 恢复管理子视图（v3） =====================
    // 单选/多选判定
    function isSingleRestore() { return restoreSelectedSchools.size === 1; }
    function isMultiRestore() { return restoreSelectedSchools.size > 1; }

    async function loadRestoreSchools() {
        await loadSchools();
        // 进入时清空已选项 + 备份选中
        restoreSelectedSchools.clear();
        restoreSelectedBackupId = null;
        restoreLocalPayload = null;
        renderRestoreSchoolList();
        updateRestoreBackupPanel();
        renderRestoreConfirmCard();
    }

    function renderRestoreSchoolList() {
        const list = document.getElementById('restoreSchoolList');
        if (!list) return;
        const term = restoreSchoolFilter.trim().toLowerCase();
        const filtered = allSchools.filter((s) => {
            if (!term) return true;
            return (s.name || '').toLowerCase().includes(term) || (s.code || '').toLowerCase().includes(term);
        });

        if (!pagers.restoreSchool) {
            pagers.restoreSchool = new TablePager({
                id: 'restoreSchool',
                containerId: 'restoreSchoolPager',
                defaultPerPage: 12,
                perPageOptions: [6, 12, 24, 48],
                serverSide: false,
                onChange: () => renderRestoreSchoolList(),
            }).mount();
        }
        const p = paginateArray(filtered, pagers.restoreSchool.page, pagers.restoreSchool.perPage);
        pagers.restoreSchool.setTotal(p.total).setPage(p.page);

        list.innerHTML = p.data.length
            ? p.data.map((s) => {
                const checked = restoreSelectedSchools.has(s.code) ? 'checked' : '';
                return `
                    <label class="flex items-center gap-2 p-1.5 rounded-lg border border-gray-100 hover:bg-gray-50 cursor-pointer transition ${checked ? 'bg-blue-50/60 border-blue-200' : 'bg-white'}">
                        <input type="checkbox" value="${escapeHtml(s.code)}" class="restore-school-checkbox rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0" ${checked}>
                        <div class="flex-1 min-w-0">
                            <div class="text-sm font-medium text-gray-800 truncate">${escapeHtml(s.name || s.code)}</div>
                            <div class="text-xs text-gray-500 font-mono truncate">${escapeHtml(s.code)}</div>
                        </div>
                    </label>
                `;
            }).join('')
            : '<div class="text-center text-gray-400 text-sm py-6 col-span-full">未找到匹配学校</div>';

        list.querySelectorAll('.restore-school-checkbox').forEach((cb) => {
            cb.addEventListener('change', () => {
                if (cb.checked) restoreSelectedSchools.add(cb.value);
                else restoreSelectedSchools.delete(cb.value);
                refreshRestoreSelectAll();
                updateRestoreBackupPanel();
                renderRestoreConfirmCard();
            });
        });

        document.getElementById('restoreSelectedCount').textContent = `已选 ${restoreSelectedSchools.size}`;
        updateRestoreSchoolSummary();
    }

    function updateRestoreSchoolSummary() {
        const countEl = document.getElementById('restoreSummaryCount');
        const totalEl = document.getElementById('restoreSummaryTotal');
        if (countEl) countEl.textContent = String(restoreSelectedSchools.size);
        if (totalEl) totalEl.textContent = String(allSchools.length);
    }

    function getFilteredRestoreSchools() {
        const term = restoreSchoolFilter.trim().toLowerCase();
        return allSchools.filter((s) => {
            if (!term) return true;
            return (s.name || '').toLowerCase().includes(term) || (s.code || '').toLowerCase().includes(term);
        });
    }

    function refreshRestoreSelectAll() {
        const cb = document.getElementById('restoreSelectAll');
        if (!cb) return;
        const filtered = getFilteredRestoreSchools();
        const filteredCodes = new Set(filtered.map((s) => s.code));
        const checkedCount = Array.from(restoreSelectedSchools).filter((code) => filteredCodes.has(code)).length;
        const total = filtered.length;
        if (total === 0) {
            cb.checked = false; cb.indeterminate = false;
        } else if (checkedCount === total) {
            cb.checked = true; cb.indeterminate = false;
        } else if (checkedCount > 0) {
            cb.checked = false; cb.indeterminate = true;
        } else {
            cb.checked = false; cb.indeterminate = false;
        }
    }

    /** 更新卡片 2：根据学校选择模式决定：
     *   - 0 所选：提示选择学校，禁用 Tab；
     *   - 1 所选（单选）：允许看 全局 + 本校单点；默认 scope=全局；
     *   - ≥2 所选：强制 scope=全局（隐藏单点类型），类型筛选器锁定；
     *   - 多选学校时，range 控件禁用；
     * 同时刷新提示语，恢复完整摘要。 */
    function updateRestoreBackupPanel() {
        const count = restoreSelectedSchools.size;
        const tabs = document.querySelectorAll('[data-source-tab]');
        const scopeSel = document.getElementById('restoreScopeFilter');
        const hintEl = document.getElementById('restoreSourceHint');

        // Tab 启用/禁用
        tabs.forEach((b) => {
            const enabled = count > 0;
            b.disabled = !enabled;
            b.classList.toggle('opacity-50', !enabled);
            b.classList.toggle('cursor-not-allowed', !enabled);
        });

        // 类型筛选：多选时锁定为 'all'，禁用控件
        if (count > 1) {
            restoreScopeFilter = 'all';
            if (scopeSel) {
                scopeSel.value = 'all';
                scopeSel.disabled = true;
                scopeSel.classList.add('opacity-50', 'cursor-not-allowed');
            }
        } else {
            if (scopeSel) {
                scopeSel.disabled = false;
                scopeSel.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }

        // 提示文案
        if (hintEl) {
            if (count === 0) hintEl.textContent = '请先选择目标学校';
            else if (count === 1) {
                const code = Array.from(restoreSelectedSchools)[0];
                hintEl.textContent = `已选 1 所学校：可看 全局备份 + 学校 ${code} 自己的单点备份；选择来源（备份库或本地上传）`;
            } else {
                hintEl.textContent = `已选 ${count} 所学校（多选/全选）：仅可看全局备份；本地上传仍可使用`;
            }
        }

        const tbody = document.getElementById('bkRestoreList');
        const pagerContainer = document.getElementById('restoreBackupPager');

        if (count === 0) {
            if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center text-gray-400 py-6">请先选择上方目标学校</td></tr>`;
            if (pagers.restoreBackup) pagers.restoreBackup.setTotal(0).setPage(1);
            document.getElementById('restoreSelectedCount').textContent = `已选 0`;
            updateRestoreSchoolSummary();
            return;
        }

        document.getElementById('restoreSelectedCount').textContent = `已选 ${count}`;
        updateRestoreSchoolSummary();

        if (restoreSourceTab === 'server') {
            loadRestoreBackups(1);
        } else {
            // 本地 Tab：清空表格，给出上传提示
            if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center text-gray-500 py-8 text-sm">
                <i class="fas fa-upload mr-1 text-gray-400"></i>
                请在下方"本地上传"区域选择已下载到本地的加密备份文件（.aes + .meta.json）
            </td></tr>`;
            if (pagers.restoreBackup) pagers.restoreBackup.setTotal(0).setPage(1);
        }
    }

    /** 当前是否允许选中该备份：
     *  - 单选模式：任意 scope（局部过滤：由恢复面板第二卡片做）；
     *    「不可选」情形：当 scope=single 且 schoolCode 不在已选学校内。
     *  - 多选模式：仅允许 scope=all。
     */
    function isBackupSelectable(row) {
        if (isMultiRestore()) {
            return row.scope === 'all';
        }
        if (isSingleRestore()) {
            const code = Array.from(restoreSelectedSchools)[0];
            // 全局备份对该单选学校永远可选
            if (row.scope === 'all') return true;
            // 单点备份只允许选本校的
            if (row.scope === 'single') return row.schoolCode === code;
            return false;
        }
        return false;
    }

    function isBackupRowDisabled(row) {
        // 多选时禁用非 all；单选时禁用其他学校的 single
        if (isMultiRestore()) return row.scope !== 'all';
        if (isSingleRestore()) return row.scope === 'single' && !restoreSelectedSchools.has(row.schoolCode || '');
        return false;
    }

    async function loadRestoreBackups(page = 1) {
        if (!pagers.restoreBackup) {
            pagers.restoreBackup = new TablePager({
                id: 'restoreBackup',
                containerId: 'restoreBackupPager',
                defaultPerPage: 15,
                onChange: (state) => loadRestoreBackups(state.page),
            }).mount();
        }
        pagers.restoreBackup.setPage(page);
        const tbody = document.getElementById('bkRestoreList');
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-400 py-6">加载中…</td></tr>';

        try {
            const params = new URLSearchParams();
            params.set('page', String(page));
            params.set('pageSize', String(pagers.restoreBackup.perPage));

            if (isMultiRestore()) {
                // 多选学校时只看全局备份（强制 scope=all）
                params.set('scope', 'all');
            } else if (isSingleRestore()) {
                // 单选学校：传 schoolCode 让后端 OR 出【本校单点 + 全部全局】
                params.set('schoolCode', String(Array.from(restoreSelectedSchools)[0]));
                if (restoreScopeFilter) params.set('scope', restoreScopeFilter);
            }

            const j = await api(`/?${params.toString()}`);
            // 关键：单选时即使后端按 schoolCode 过滤，仍需在 UI 层二次过滤掉其他学校的 single 行（应不会出现，但兜底）
            const filtered = (j.data || []).filter((r) => !isBackupRowDisabled(r));
            restoreCurrentBackups = filtered;
            renderSelectableBackupTable('bkRestoreList', filtered);
            pagers.restoreBackup.setTotal(filtered.length); // 客户端已筛选，total 不再展示精确服务端值
        } catch (e) {
            notify(`加载备份文件列表失败：${e.message}`);
            renderSelectableBackupTable('bkRestoreList', []);
            pagers.restoreBackup.setTotal(0).setPage(1);
        }
    }

    /** 可选备份表格：单击行 → 选中（允许 is-disabled 行用 title 提示但点击无效） */
    function renderSelectableBackupTable(tbodyId, rows) {
        const tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        if (!rows.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="px-3 py-8 text-center text-gray-400 text-sm">暂无备份记录</td></tr>`;
            return;
        }
        tbody.innerHTML = rows.map((r) => {
            const disabled = isBackupRowDisabled(r);
            const sel = restoreSelectedBackupId === r.id;
            const cls = [
                'border-b border-gray-100',
                disabled ? 'is-disabled' : 'is-selectable hover:bg-gray-50',
                sel ? 'is-selected' : '',
            ].filter(Boolean).join(' ');
            const reason = disabled
                ? (isMultiRestore() ? '多选模式仅可选择全局备份' : '仅可选择该学校自己的单点备份')
                : '';
            return `
                <tr class="${cls}" data-id="${escapeHtml(r.id)}" ${disabled ? `title="${reason}"` : ''}>
                    <td class="px-3 py-2 text-xs"><span class="restore-radio"></span></td>
                    <td class="px-3 py-2 text-xs text-gray-700">${fmtTime(r.createdAt)}</td>
                    <td class="px-3 py-2 text-xs">${typeBadge(r)}</td>
                    <td class="px-3 py-2 text-xs">${escapeHtml(r.schoolCode || '全部学校')}</td>
                    <td class="px-3 py-2 text-xs">${fmtBytes(r.fileSize)}</td>
                    <td class="px-3 py-2 text-xs">${verifyBadge(r)}</td>
                </tr>
            `;
        }).join('');
    }

    function handleRestoreRowClick(id) {
        const item = restoreCurrentBackups.find((r) => r.id === id);
        if (!item || isBackupRowDisabled(item)) {
            notify(isMultiRestore() ? '多选/全选学校时，仅能选择全局备份' : '仅能选择该学校自己的单点备份');
            return;
        }
        if (restoreSelectedBackupId === id) {
            restoreSelectedBackupId = null;
        } else {
            restoreSelectedBackupId = id;
        }
        // 重新渲染以更新高亮
        renderSelectableBackupTable('bkRestoreList', restoreCurrentBackups);
        renderRestoreConfirmCard();
    }

    function setRestoreSchoolPanelExpanded(expanded) {
        const body = document.getElementById('restoreSchoolPanelBody');
        const summary = document.getElementById('restoreSchoolPanelSummary');
        const btn = document.getElementById('restoreToggleSchoolPanel');
        if (!body || !summary) return;
        body.classList.toggle('hidden', !expanded);
        summary.classList.toggle('hidden', expanded);
        if (btn) {
            const icon = btn.querySelector('i');
            const text = btn.querySelector('span');
            if (icon) icon.className = expanded ? 'fas fa-chevron-up mr-1' : 'fas fa-chevron-down mr-1';
            if (text) text.textContent = expanded ? '收起' : '展开';
        }
    }

    /** 切换数据源 Tab（备份库 / 本地） */
    function switchRestoreSourceTab(tab) {
        restoreSourceTab = tab;
        document.querySelectorAll('[data-source-tab]').forEach((b) => {
            b.classList.toggle('active', b.dataset.sourceTab === tab);
        });
        document.getElementById('restoreSourceServer')?.classList.toggle('hidden', tab !== 'server');
        document.getElementById('restoreSourceLocal')?.classList.toggle('hidden', tab !== 'local');

        // 切换 Tab 时清空"另一侧"已选项
        if (tab === 'server') {
            restoreLocalPayload = null;
            renderRestoreLocalInfo();
        } else if (tab === 'local') {
            restoreSelectedBackupId = null;
        }
        updateRestoreBackupPanel();
        renderRestoreConfirmCard();
    }

    /** 本地上传：点击或拖拽 → 选择文件 → 解析 meta.json → 暂存 */
    function bindLocalUploadEvents() {
        const dropZone = document.getElementById('restoreLocalDropZone');
        const fileInput = document.getElementById('restoreLocalFileInput');
        if (!dropZone || !fileInput) return;

        const openPicker = () => {
            if (restoreSelectedSchools.size === 0) {
                notify('请先在上方选择目标学校');
                return;
            }
            fileInput.value = '';
            fileInput.click();
        };
        dropZone.addEventListener('click', openPicker);
        fileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            handleLocalFiles(files);
        });

        // 拖拽支持
        ['dragenter', 'dragover'].forEach((evt) =>
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault(); e.stopPropagation();
                if (restoreSelectedSchools.size === 0) return;
                dropZone.classList.add('is-dragover');
            })
        );
        ['dragleave', 'drop'].forEach((evt) =>
            dropZone.addEventListener(evt, (e) => {
                e.preventDefault(); e.stopPropagation();
                dropZone.classList.remove('is-dragover');
            })
        );
        dropZone.addEventListener('drop', (e) => {
            if (restoreSelectedSchools.size === 0) return;
            const files = Array.from(e.dataTransfer?.files || []);
            handleLocalFiles(files);
        });

        document.getElementById('restoreLocalClear')?.addEventListener('click', () => {
            restoreLocalPayload = null;
            renderRestoreLocalInfo();
            renderRestoreConfirmCard();
        });
    }

    async function handleLocalFiles(files) {
        if (!files.length) return;
        if (files.length > 2) {
            notify('本地上传最多选 2 个文件：1 个 .aes + 1 个 .meta.json');
            return;
        }
        let dataFile = null;
        let metaFile = null;
        for (const f of files) {
            const lower = f.name.toLowerCase();
            if (lower.endsWith('.meta.json')) metaFile = f;
            else if (lower.endsWith('.aes')) dataFile = f;
            else if (lower.endsWith('.sql.gz') || lower.endsWith('.gz') || lower.endsWith('.sql')) {
                // ★仅 .aes 才允许本地上传恢复：明文上传无 meta.sha256 可比对，无完整性保障。
                notify('本地上传仅支持加密备份 .aes（明文上传无法做完整性校验，已拒绝）。请从备份库下载加密备份后上传。');
                return;
            }
        }
        if (!dataFile) {
            notify('未识别到加密备份文件 (.aes)。如需下载，请到「全局备份/单点备份」点击「下载加密」。');
            return;
        }
        if (!metaFile) {
            notify('缺少配套 .meta.json 文件。恢复强校验要求 .aes 与 .meta.json 同时上传（meta 内含 sha256 等指纹）。');
            return;
        }
        let meta = null;
        try {
            const txt = await metaFile.text();
            meta = JSON.parse(txt);
        } catch (e) {
            notify(`解析 meta.json 失败：${e.message}`);
            return;
        }
        // ★P-Recovery-Audit v1：客户端 WebCrypto 计算 .aes 的 sha256（hex）。
        //   必须与 meta.sha256 一致，否则拒绝执行（文件可能被篡改或选错）。
        notify('正在用浏览器 WebCrypto 计算 sha256…');
        const clientSha = await sha256HexOfFile(dataFile);
        const matchesMeta = !!(meta && meta.sha256 && clientSha.toLowerCase() === String(meta.sha256).toLowerCase());
        if (!matchesMeta) {
            const ok = confirm(
                '⚠️ 文件完整性校验失败\n\n' +
                `客户端 sha256：${clientSha.slice(0, 16)}…\n` +
                `meta.sha256   ：${(meta.sha256 || '(缺失)').slice(0, 16)}…\n\n` +
                '这表示您选择的 .aes 与 .meta.json 不是同一份备份，或文件被篡改。\n' +
                '继续上传无法通过服务端强校验并会被拒绝。是否仍要继续（仅用于调试）？'
            );
            if (!ok) return;
        }
        restoreLocalPayload = { dataFile, metaFile, meta, clientSha, shaMatches: matchesMeta };
        renderRestoreLocalInfo();
        renderRestoreConfirmCard();
        notify(matchesMeta ? '✅ 本地校验通过：sha256 与 meta.json 一致' : '⚠️ 本地校验未通过，但已确认继续', matchesMeta ? 'success' : 'warn');
    }

    /** 使用 WebCrypto 计算文件 sha256（hex）。仅支持 HTTPS / localhost 等 secure context，但 admin 控制台已是 auth + secure context。 */
    function sha256HexOfFile(file) {
        return new Promise(async (resolve, reject) => {
            try {
                const buf = await file.arrayBuffer();
                const digest = await crypto.subtle.digest('SHA-256', buf);
                const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
                resolve(hex);
            } catch (e) { reject(e); }
        });
    }

    function renderRestoreLocalInfo() {
        const info = document.getElementById('restoreLocalFileInfo');
        const list = document.getElementById('restoreLocalFileList');
        if (!info || !list) return;
        if (!restoreLocalPayload) {
            info.classList.add('hidden');
            list.innerHTML = '';
            return;
        }
        info.classList.remove('hidden');
        const { dataFile, metaFile, meta, clientSha, shaMatches } = restoreLocalPayload;
        const item = (f, color, icon) => `
            <div class="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-2 text-sm">
                <div class="flex items-center gap-2 truncate">
                    <i class="fas ${icon} text-${color}-500"></i>
                    <span class="truncate font-mono text-xs text-gray-700">${escapeHtml(f.name)}</span>
                </div>
                <div class="text-xs text-gray-500 ml-3 shrink-0">${fmtBytes(f.size)} · ${f.name.toLowerCase().endsWith('.aes') ? '加密' : '明文'}</div>
            </div>
        `;
        // ★P-Recovery-Audit v1：显示完整指纹 + 校验结果
        const metaSummary = meta
            ? `<div class="grid grid-cols-2 gap-2 text-xs text-gray-600 mt-1 px-1">
                <div><span class="text-gray-400">scope：</span><b>${escapeHtml(meta.scope || '-')}</b></div>
                <div><span class="text-gray-400">schoolCode：</span><b class="font-mono">${escapeHtml(meta.schoolCode || '全部')}</b></div>
                <div><span class="text-gray-400">原始 runId：</span><b class="font-mono">${escapeHtml(meta.runId || '(meta 无指纹)')}</b></div>
                <div><span class="text-gray-400">原始 fileSize：</span><b>${escapeHtml(String(meta.fileSize != null ? meta.fileSize : '-'))}</b></div>
                <div class="col-span-2"><span class="text-gray-400">meta.sha256：</span><b class="font-mono truncate inline-block max-w-[260px] align-middle">${escapeHtml((meta.sha256 || '(缺失)').slice(0, 32))}…</b></div>
                <div class="col-span-2"><span class="text-gray-400">客户端 sha256：</span><b class="font-mono truncate inline-block max-w-[260px] align-middle">${escapeHtml((clientSha || '-').slice(0, 32))}…</b></div>
                <div class="col-span-2">
                    ${shaMatches === true
                        ? '<span class="text-green-700"><i class="fas fa-shield-check mr-1"></i>校验通过：客户端 sha256 与 meta.sha256 完全一致</span>'
                        : (shaMatches === false
                            ? '<span class="text-red-700"><i class="fas fa-shield-virus mr-1"></i>校验失败：客户端 sha256 与 meta.sha256 不一致，文件可能被篡改</span>'
                            : '<span class="text-gray-500"><i class="fas fa-shield-question mr-1"></i>校验未执行</span>')}
                </div>
            </div>`
            : `<div class="text-xs text-amber-600 mt-1 px-1">
                <i class="fas fa-exclamation-circle mr-1"></i>未提供 .meta.json。
            </div>`;
        list.innerHTML = item(dataFile, 'blue', 'fa-database') + (metaFile ? item(metaFile, 'amber', 'fa-file-code') : '') + metaSummary;
    }

    /** 卡片 3：根据当前"已选学校 + 已选备份源"渲染摘要 */
    function renderRestoreConfirmCard() {
        const schoolsEl = document.getElementById('restoreConfirmSchools');
        const sourceEl = document.getElementById('restoreConfirmSource');
        const modeEl = document.getElementById('restoreConfirmMode');
        const warnEl = document.getElementById('restoreConfirmWarn');
        const wordEl = document.getElementById('restoreConfirmWord');
        const execBtn = document.getElementById('restoreExecuteBtn');
        const confirmInput = document.getElementById('restoreExecConfirm');

        const codes = Array.from(restoreSelectedSchools);
        const schoolLabel = (code) => {
            const s = allSchools.find((x) => x.code === code);
            return s ? `${s.name || s.code} <span class="text-xs text-gray-400 font-mono">${code}</span>` : `<span class="font-mono">${code}</span>`;
        };

        // 目标学校
        if (schoolsEl) {
            if (codes.length === 0) schoolsEl.innerHTML = '<span class="text-gray-400">未选择</span>';
            else if (codes.length === 1) schoolsEl.innerHTML = schoolLabel(codes[0]);
            else schoolsEl.innerHTML = `共 <b class="text-red-600">${codes.length}</b> 所学校 <details class="mt-1 inline-block text-xs text-gray-500 cursor-pointer"><summary>展开列表</summary><div class="mt-1 max-h-32 overflow-y-auto pl-2">${codes.map((c) => schoolLabel(c)).join('<br>')}</div></details>`;
        }

        // 数据源
        let sourceSummary = '';
        if (restoreSourceTab === 'server') {
            if (!restoreSelectedBackupId) {
                sourceSummary = '<span class="text-gray-400">未选择</span>';
            } else {
                const item = restoreCurrentBackups.find((r) => r.id === restoreSelectedBackupId);
                if (item) {
                    sourceSummary = `${typeBadge(item)} &nbsp;${fmtTime(item.createdAt)} &nbsp;`
                        + `<span class="font-mono text-gray-700">${escapeHtml(item.schoolCode || '全部学校')}</span> &nbsp;`
                        + `<span class="text-gray-500 text-xs">${fmtBytes(item.fileSize)}</span>`;
                } else {
                    sourceSummary = '<span class="text-gray-400">已选项已失效，请重新选择</span>';
                }
            }
        } else {
            if (!restoreLocalPayload) {
                sourceSummary = '<span class="text-gray-400">未上传</span>';
            } else {
                const { dataFile, meta } = restoreLocalPayload;
                sourceSummary = `<span class="font-mono text-xs text-blue-700">${escapeHtml(dataFile.name)}</span>`
                    + (meta && meta.scope ? ` &nbsp;${meta.scope === 'all' ? '全局' : '单点'}` : '')
                    + (meta && meta.schoolCode ? ` &nbsp;<span class="text-gray-500 text-xs">${escapeHtml(meta.schoolCode)}</span>` : '');
            }
        }
        if (sourceEl) sourceEl.innerHTML = sourceSummary;

        // 恢复模式
        let mode = '未确认';
        let word = 'RESTORE';
        if (codes.length === 0) {
            mode = '<span class="text-gray-400">请先选择目标学校</span>';
        } else if (codes.length >= 2) {
            mode = `<span class="px-2 py-0.5 rounded bg-red-100 text-red-700 text-xs"><i class="fas fa-layer-group mr-1"></i>批量恢复（全库备份 → ${codes.length} 校）</span>`;
            word = 'RESTORE_ALL';
        } else if (restoreSourceTab === 'server' && !restoreSelectedBackupId) {
            mode = '<span class="text-amber-600 text-xs">请在第二卡片选择一份备份文件</span>';
        } else if (restoreSourceTab === 'local' && !restoreLocalPayload) {
            mode = '<span class="text-amber-600 text-xs">请在第二卡片上传本地备份文件</span>';
        } else {
            const item = restoreSourceTab === 'server'
                ? restoreCurrentBackups.find((r) => r.id === restoreSelectedBackupId)
                : null;
            const t = item ? item.scope : (restoreLocalPayload?.meta?.scope || null);
            if (t === 'all') mode = '<span class="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-xs"><i class="fas fa-globe mr-1"></i>单点恢复（全库备份 → 提取 1 校）</span>';
            else if (t === 'single') mode = '<span class="px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 text-xs"><i class="fas fa-bullseye mr-1"></i>单点恢复（单校备份 → 该校）</span>';
            else mode = '<span class="text-amber-600 text-xs">等待扫描备份表头…</span>';
        }
        if (modeEl) modeEl.innerHTML = mode;
        if (wordEl) wordEl.textContent = word;
        if (confirmInput) confirmInput.placeholder = word;

        // 警告区：根据模式动态调整文案
        if (warnEl) {
            if (codes.length >= 2) {
                warnEl.innerHTML = `
                    <i class="fas fa-exclamation-triangle mr-1"></i>
                    <strong>批量恢复（不可逆）</strong>：将使用全库备份对所选 <b>${codes.length}</b> 所学校逐一执行影子恢复（每校独立事务、原子切换）；
                    单校失败不影响其它学校，整体完成前请勿关闭页面。`;
            } else if (codes.length === 1) {
                warnEl.innerHTML = `
                    <i class="fas fa-exclamation-triangle mr-1"></i>
                    <strong>危险操作</strong>：影子恢复过程会先在临时 schema 还原并校验，通过后单事务原子切换生产 schema；
                    切换前任何校验失败都不会影响原数据，一旦切换则不可逆，请确认目标学校与数据源无误后再执行。`;
            } else {
                warnEl.innerHTML = `
                    <i class="fas fa-info-circle mr-1"></i>
                    危险操作：影子恢复不可逆，请先在上方选择目标学校，并在第二卡片选择备份数据源。`;
            }
        }

        // 按钮启用判定
        const canExec = canExecuteRestore(codes);
        if (execBtn) {
            execBtn.disabled = !canExec;
            execBtn.textContent = codes.length >= 2 ? '批量恢复' : '开始恢复';
        }
        if (confirmInput && canExec) {
            // 仅在按钮启用且确认词匹配时才允许执行
            const checkWord = () => {
                if (!execBtn) return;
                execBtn.disabled = !canExec || confirmInput.value.trim() !== word;
            };
            confirmInput.oninput = checkWord;
            // 初始立刻校验（用户已输入）
            checkWord();
        } else if (confirmInput) {
            confirmInput.oninput = null;
        }
    }

    function canExecuteRestore(codes) {
        if (codes.length === 0) return false;
        if (codes.length >= 2) {
            // 批量：仅能使用全局备份；服务端选中或本地上传均可
            if (restoreSourceTab === 'server') {
                const item = restoreCurrentBackups.find((r) => r.id === restoreSelectedBackupId);
                return !!(item && item.scope === 'all');
            }
            // 本地上传批量：必须提供 meta.json（带 runId / scope=all 才能通过服务端强校验）
            const lp = restoreLocalPayload;
            return !!(lp && lp.meta && lp.meta.runId && lp.meta.scope === 'all' && lp.shaMatches !== false);
        }
        // 单选：必须有数据源
        if (restoreSourceTab === 'server') {
            return !!restoreSelectedBackupId;
        }
        // 本地上传单选：必须有 meta + runId，且客户端校验通过（未通过会再二次确认）
        const lp = restoreLocalPayload;
        return !!(lp && lp.meta && lp.meta.runId && lp.shaMatches !== false);
    }

    /** 执行恢复：单点 / 批量 / 本地上传 */
    async function executeRestore() {
        const codes = Array.from(restoreSelectedSchools);
        const isMulti = codes.length >= 2;
        const word = isMulti ? 'RESTORE_ALL' : 'RESTORE';
        const confirmInput = document.getElementById('restoreExecConfirm');
        const execBtn = document.getElementById('restoreExecuteBtn');
        if (!canExecuteRestore(codes)) return;
        if (confirmInput.value.trim() !== word) {
            notify(`请输入确认词 ${word}`);
            return;
        }
        const srcDesc = isMulti
            ? `${codes.length} 所学校 × 1 份备份`
            : (codes.length === 1 ? `${codes[0]}` : '');

        execBtn.disabled = true;
        execBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>' + (isMulti ? '批量恢复中…' : '恢复中…');
        try {
            if (restoreSourceTab === 'local') {
                await executeRestoreFromLocal({ codes, isMulti });
            } else if (isMulti) {
                await executeBatchRestore({ codes });
            } else {
                await executeSingleRestore({ code: codes[0] });
            }
        } finally {
            execBtn.disabled = false;
            execBtn.innerHTML = isMulti
                ? '<i class="fas fa-layer-group mr-1"></i>批量恢复'
                : '<i class="fas fa-undo mr-1"></i>开始恢复';
        }
    }

    async function executeSingleRestore({ code }) {
        const id = restoreSelectedBackupId;
        try {
            const j = await api(`/${id}/restore`, {
                method: 'POST',
                body: JSON.stringify({ targetSchoolCode: code, confirmText: 'RESTORE' })
            });
            if (j.success) {
                alert('恢复完成 ✅\n\n' + (j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n'));
                document.getElementById('restoreExecConfirm').value = '';
                loadRestoreBackups(pagers.restoreBackup?.page || 1);
            } else {
                alert(`恢复失败 ❌\n\n${(j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || j.error}`);
            }
        } catch (e) {
            notify(`恢复失败：${e.message}`);
        }
    }

    async function executeBatchRestore({ codes }) {
        const id = restoreSelectedBackupId;
        try {
            const j = await api(`/${id}/restore-batch`, {
                method: 'POST',
                body: JSON.stringify({ confirmText: 'RESTORE_ALL', targetSchoolCodes: codes })
            });
            if (j.data) {
                const lines = (j.data.results || []).map((r) =>
                    `${r.schoolCode}: ${r.ok ? '成功' : '失败'}${r.error ? ` (${r.error})` : ''}`).join('\n');
                alert(`批量恢复完成 ✅\n\n请求 ${j.data.requested} / 成功 ${j.data.succeeded} / 失败 ${j.data.failed} / 耗时 ${j.data.elapsedMs}ms\n\n${lines}`);
                document.getElementById('restoreExecConfirm').value = '';
                loadRestoreBackups(pagers.restoreBackup?.page || 1);
            } else {
                alert(`批量恢复失败 ❌\n\n${j.error || '未知错误'}`);
            }
        } catch (e) {
            notify(`批量恢复失败：${e.message}`);
        }
    }

    async function executeRestoreFromLocal({ codes, isMulti }) {
        const { dataFile, metaFile, meta, clientSha } = restoreLocalPayload;
        const word = isMulti ? 'RESTORE_ALL' : 'RESTORE';
        try {
            // ★P-Recovery-Audit v1：必须从 meta.json 取出 runId；缺失则拒绝提交（服务端强校验的前提）。
            const runId = meta && meta.runId;
            if (!runId) {
                notify('上传失败：所选 meta.json 缺少 runId，无法做服务端交叉校验。请到备份库重新下载配套 meta.json 后再试。');
                return;
            }
            // 把文件读成 base64 + JSON 提交，避免引入 multer 等依赖
            const dataB64 = await readFileAsBase64(dataFile);
            let metaB64 = null;
            if (metaFile) metaB64 = await readFileAsBase64(metaFile);
            const payload = {
                confirmText: word,
                runId,                                                    // ★强校验 ①：原始备份 ID
                data: { filename: dataFile.name, contentBase64: dataB64, size: dataFile.size },
                meta: metaFile ? { filename: metaFile.name, contentBase64: metaB64 } : null,
                clientSha256: clientSha || undefined,                     // ★强校验 ②：客户端 sha256
            };
            if (isMulti) payload.targetSchoolCodes = codes;
            else payload.targetSchoolCode = codes[0];

            const r = await apiRaw('/api/admin/backups/restore-from-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const text = await r.text();
            let j = null;
            try { j = text ? JSON.parse(text) : null; } catch (_) {}
            if (!r.ok) {
                alert(`本地恢复失败 ❌\n\n${(j && j.error) || `HTTP ${r.status}`}\n\n参考：审计日志记录了此次失败原因（reason 字段），可到「审计日志」查看`);
                return;
            }
            if (isMulti) {
                const lines = ((j.data && j.data.results) || []).map((x) =>
                    `${x.schoolCode}: ${x.ok ? '成功' : '失败'}${x.error ? ` (${x.error})` : ''}`).join('\n');
                alert(`批量恢复完成 ✅\n\n${lines || '全部成功'}`);
            } else {
                const lines = ((j.checks) || []).map(([k, v]) => `${k}: ${v}`).join('\n');
                alert(`恢复完成 ✅\n\n${lines || 'OK'}`);
            }
            document.getElementById('restoreExecConfirm').value = '';
        } catch (e) {
            notify(`本地恢复失败：${e.message}`);
        }
    }

    function readFileAsBase64(file) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => {
                const result = fr.result || '';
                const idx = result.indexOf(',');
                resolve(idx >= 0 ? result.slice(idx + 1) : result);
            };
            fr.onerror = () => reject(new Error(`读取文件 ${file.name} 失败：${fr.error?.message || 'unknown'}`));
            fr.readAsDataURL(file);
        });
    }

    function bindRestoreEvents() {
        document.getElementById('restoreSchoolSearch')?.addEventListener('input', (e) => {
            restoreSchoolFilter = e.target.value || '';
            if (pagers.restoreSchool) pagers.restoreSchool.setPage(1);
            renderRestoreSchoolList();
            refreshRestoreSelectAll();
        });
        document.getElementById('restoreSelectAll')?.addEventListener('change', (e) => {
            const checked = e.target.checked;
            getFilteredRestoreSchools().forEach((s) => {
                if (checked) restoreSelectedSchools.add(s.code);
                else restoreSelectedSchools.delete(s.code);
            });
            renderRestoreSchoolList();
            refreshRestoreSelectAll();
            updateRestoreBackupPanel();
            renderRestoreConfirmCard();
        });
        document.getElementById('restoreToggleSchoolPanel')?.addEventListener('click', () => {
            const body = document.getElementById('restoreSchoolPanelBody');
            setRestoreSchoolPanelExpanded(body?.classList.contains('hidden') || false);
        });
        document.getElementById('restoreSchoolPanelSummary')?.addEventListener('click', (e) => {
            if (e.target.closest('[data-act="expand-schools"]')) {
                setRestoreSchoolPanelExpanded(true);
            }
        });

        // 数据源 Tab 切换
        document.querySelectorAll('[data-source-tab]').forEach((b) => {
            b.addEventListener('click', () => switchRestoreSourceTab(b.dataset.sourceTab));
        });

        document.getElementById('restoreScopeFilter')?.addEventListener('change', (e) => {
            restoreScopeFilter = e.target.value || '';
            loadRestoreBackups(1);
        });
        document.getElementById('restoreBackupSearch')?.addEventListener('input', (e) => {
            restoreBackupFilter = e.target.value || '';
            // 客户端再过滤一遍
            filterRestoreBackups();
        });
        document.getElementById('restoreBackupRefresh')?.addEventListener('click', () => {
            if (restoreSourceTab === 'server') loadRestoreBackups(1);
            else renderRestoreLocalInfo();
        });

        // 表格点击：选中备份
        document.getElementById('bkRestoreList')?.addEventListener('click', (e) => {
            const tr = e.target.closest('tr[data-id]');
            if (!tr) return;
            handleRestoreRowClick(tr.dataset.id);
        });

        // 本地上传事件
        bindLocalUploadEvents();

        // 第三个卡片：执行按钮
        document.getElementById('restoreExecuteBtn')?.addEventListener('click', executeRestore);
    }

    function filterRestoreBackups() {
        const term = (restoreBackupFilter || '').trim().toLowerCase();
        if (!term) {
            renderSelectableBackupTable('bkRestoreList', restoreCurrentBackups);
            if (pagers.restoreBackup) pagers.restoreBackup.setTotal(restoreCurrentBackups.length);
            return;
        }
        const rows = restoreCurrentBackups.filter((r) =>
            fmtTime(r.createdAt).toLowerCase().includes(term)
            || (r.schoolCode || '').toLowerCase().includes(term)
        );
        renderSelectableBackupTable('bkRestoreList', rows);
        if (pagers.restoreBackup) pagers.restoreBackup.setTotal(rows.length);
    }

    // ===================== 通用表格 / 分页 / 操作（global / single 共用） =====================
    function renderBackupTable(tbodyId, rows, opts = {}) {
        const { showType = true } = opts;
        const tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        const cols = 5 + (showType ? 1 : 0);

        tbody.innerHTML = rows.length
            ? rows.map((r) => `
                <tr class="border-b border-gray-100 hover:bg-gray-50">
                    <td class="px-3 py-2 text-xs text-gray-700">${fmtTime(r.createdAt)}</td>
                    ${showType ? `<td class="px-3 py-2 text-xs">${typeBadge(r)}</td>` : ''}
                    <td class="px-3 py-2 text-xs">${escapeHtml(r.schoolCode || '全部学校')}</td>
                    <td class="px-3 py-2 text-xs">${fmtBytes(r.fileSize)}</td>
                    <td class="px-3 py-2 text-xs">${verifyBadge(r)}</td>
                    <td class="px-3 py-2 text-xs whitespace-nowrap text-right">
                        ${btn('fa-check', '验证', 'border-gray-300 text-gray-600 hover:bg-gray-100', `data-act="verify" data-id="${r.id}"`)}
                        ${btn('fa-download', '下载加密', 'border-gray-300 text-gray-600 hover:bg-gray-100', `data-act="download-enc" data-id="${r.id}"`)}
                        ${btn('fa-file-code', '明文下载', 'border-amber-300 text-amber-700 hover:bg-amber-50', `data-act="download-plain" data-id="${r.id}"`)}
                    </td>
                </tr>
            `).join('')
            : `<tr><td colspan="${cols}" class="px-3 py-8 text-center text-gray-400 text-sm">暂无备份记录</td></tr>`;
    }

    async function doVerify(id, reload) {
        try {
            const j = await api(`/${id}/verify`, { method: 'POST' });
            if (j.success) {
                const lines = (j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n');
                alert(`验证通过 ✅\n\n${lines}`);
            } else {
                alert(`验证失败 ❌\n\n${(j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || j.error}`);
            }
            if (reload) reload();
        } catch (e) { notify(`验证失败：${e.message}`); }
    }

    async function doDownload(id, format) {
        const url = `${API_BASE}/api/admin/backups/${id}/download?format=${format}`;
        try {
            const r = await fetch(url, { headers: authHeaders() });
            if (!r.ok) {
                let bodyText = '';
                try { bodyText = await r.text(); } catch (_) { /* ignore */ }
                let msg = `HTTP ${r.status}`;
                try {
                    const j = JSON.parse(bodyText);
                    if (j.error) msg = j.error;
                } catch (_) { /* body 不是 JSON，保留状态码 */ }
                if (r.status === 403 && format === 'plain') {
                    msg += '（明文下载被服务端禁止：需在服务端设置 BACKUP_PLAIN_DOWNLOAD_ALLOWED=true 后方可启用）';
                }
                throw new Error(msg);
            }
            const blob = await r.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `backup-${id}.${format === 'encrypted' ? 'aes' : 'sql.gz'}`;
            a.click();
            URL.revokeObjectURL(a.href);
            // ★P-Recovery-Audit v1：加密下载时同步拉 meta.json（指纹文件），
            //   让用户上传本地恢复时能同时提供两者以做 sha256 完整性校验。
            if (format === 'encrypted') {
                notify('已下载加密备份（.aes），正在下载配套 meta.json…', 'success');
                try {
                    const metaUrl = `${API_BASE}/api/admin/backups/${id}/meta`;
                    const mr = await fetch(metaUrl, { headers: authHeaders() });
                    if (!mr.ok) {
                        warn(`meta.json 下载失败（HTTP ${mr.status}），本地上传恢复将无法校验完整性`);
                    } else {
                        const mBlob = await mr.blob();
                        const ma = document.createElement('a');
                        ma.href = URL.createObjectURL(mBlob);
                        ma.download = `backup-${id}.meta.json`;
                        ma.click();
                        URL.revokeObjectURL(ma.href);
                        notify('已下载加密备份 + meta.json。两份文件需保管在同一目录，本地上传时请同时选择。', 'success');
                    }
                } catch (e) {
                    warn(`meta.json 下载失败：${e.message}`);
                }
            } else {
                notify('已下载明文备份', 'success');
            }
        } catch (e) {
            console.error('[backupView] 下载失败:', e);
            alert('下载失败\n\n' + (e.message || '未知错误'));
        }
    }

    // ===================== 表格事件委托（global + single 表的下载/验证） =====================
    function bindTableEvents() {
        document.getElementById('adminViewBackup')?.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const { act, id } = btn.dataset;

            if (act === 'verify') {
                let reload = null;
                if (activeSub === 'global') reload = () => loadGlobalBackups(pagers.global?.page || 1);
                else if (activeSub === 'single') reload = () => loadSingleBackups(singleSelectedSchool.code, pagers.single?.page || 1);
                doVerify(id, reload);
                return;
            }

            if (act === 'download-enc') {
                doDownload(id, 'encrypted');
                return;
            }

            if (act === 'download-plain') {
                const ok = confirm(
                    '⚠️ 明文下载警告\n\n' +
                    '将以明文 SQL（未加密）下载该备份，文件中包含全部业务数据。\n' +
                    '此操作默认被服务端禁止（返回 403），仅当服务端设置了 BACKUP_PLAIN_DOWNLOAD_ALLOWED=true 时才允许。\n\n' +
                    '确认要尝试明文下载吗？'
                );
                if (!ok) { notify('已取消明文下载', 'info'); return; }
                doDownload(id, 'plain');
                return;
            }
        });
    }

    // ===================== 子视图切换 =====================
    function switchBackupSubview(subview) {
        activeSub = subview || 'global';

        // 更新二级菜单激活态
        document.querySelectorAll('[data-subnav="backup"] .admin-sidebar__subitem').forEach((el) => {
            if (el.dataset.subview === activeSub) el.classList.add('active');
            else el.classList.remove('active');
        });

        // 显隐子视图容器
        document.querySelectorAll('#adminViewBackup > .container > .admin-subview').forEach((el) => {
            el.classList.toggle('hidden', el.dataset.subview !== activeSub);
        });

        if (activeSub === 'global') {
            loadGlobalBackups(1);
            loadGlobalKpis();
        } else if (activeSub === 'single') {
            backToSingleList();
            loadSingleSchools();
        } else if (activeSub === 'restore') {
            loadRestoreSchools();
        }
    }

    function loadBackupSubview() {
        switchBackupSubview(activeSub);
    }

    // ===================== 初始化绑定 =====================
    bindGlobalEvents();
    bindSingleEvents();
    bindRestoreEvents();
    bindTableEvents();

    // 暴露给 sidebar.js 的全局函数
    window.switchBackupSubview = switchBackupSubview;

    return { switchBackupSubview, loadBackupSubview, hasUnsaved: () => false };
}
