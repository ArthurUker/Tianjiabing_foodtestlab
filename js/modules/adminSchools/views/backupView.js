/*
 * 备份运维视图（P-BackupOps v2）
 * ------------------------------------------------------------
 * 学校管理控制台左侧「备份运维」入口的二级视图集合：
 *   - global : 全局备份（一键备份全部学校租户 + 全局备份列表）
 *   - single : 单点备份（学校列表 → 学校详情 → 单校备份）
 *   - restore: 恢复管理（选择目标学校 + 选择备份文件 → 单点/批量影子恢复）
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

    // 恢复管理视图状态
    let restoreSelectedSchools = new Set();
    let restoreSchoolFilter = '';
    let restoreScopeFilter = '';
    let restoreBackupFilter = '';
    let restoreCurrentBackups = [];

    // 当前待恢复备份记录
    let restoreTarget = null;

    const api = (path, opts = {}) => {
        const headers = authHeaders();
        const body = opts.body;
        const isJson = body && typeof body === 'string' && body.trim().startsWith('{');
        return fetch(`${API_BASE}/api/admin/backups${path}`, {
            ...opts,
            headers: { ...headers, ...(opts.headers || {}), ...(isJson ? { 'Content-Type': 'application/json' } : {}) }
        }).then(async (r) => {
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            return j;
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

    // ===================== 恢复管理子视图 =====================
    async function loadRestoreSchools() {
        await loadSchools();
        restoreSelectedSchools.clear();
        renderRestoreSchoolList();
        updateRestoreBackupPanel();
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

        // 绑定单个 checkbox
        list.querySelectorAll('.restore-school-checkbox').forEach((cb) => {
            cb.addEventListener('change', () => {
                if (cb.checked) restoreSelectedSchools.add(cb.value);
                else restoreSelectedSchools.delete(cb.value);
                refreshRestoreSelectAll();
                updateRestoreBackupPanel();
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

    function updateRestoreBackupPanel() {
        const count = restoreSelectedSchools.size;
        const placeholder = count === 0
            ? '请先选择上方目标学校'
            : `已选 ${count} 所学校；单选可恢复任意备份，多选仅可恢复全局备份`;
        document.getElementById('bkRestoreList').innerHTML = `<tr><td colspan="6" class="text-center text-gray-400 py-6">${placeholder}</td></tr>`;
        if (pagers.restoreBackup) pagers.restoreBackup.setTotal(0).setPage(1);
        document.getElementById('restoreSelectedCount').textContent = `已选 ${count}`;
        updateRestoreSchoolSummary();
        if (count > 0) loadRestoreBackups(1);
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
            if (restoreScopeFilter) params.set('scope', restoreScopeFilter);
            const j = await api(`/?${params.toString()}`);
            const rows = (j.data || []).filter((r) => {
                if (!restoreBackupFilter.trim()) return true;
                const term = restoreBackupFilter.trim().toLowerCase();
                return fmtTime(r.createdAt).toLowerCase().includes(term)
                    || (r.schoolCode || '').toLowerCase().includes(term);
            });
            restoreCurrentBackups = rows;
            renderBackupTable('bkRestoreList', rows, { showType: true, selectedCount: restoreSelectedSchools.size });
            pagers.restoreBackup.setTotal(j.total || 0);
        } catch (e) {
            notify(`加载备份文件列表失败：${e.message}`);
            renderBackupTable('bkRestoreList', [], { showType: true, selectedCount: 0 });
            pagers.restoreBackup.setTotal(0).setPage(1);
        }
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
        document.getElementById('restoreScopeFilter')?.addEventListener('change', (e) => {
            restoreScopeFilter = e.target.value || '';
            loadRestoreBackups(1);
        });
        document.getElementById('restoreBackupSearch')?.addEventListener('input', (e) => {
            restoreBackupFilter = e.target.value || '';
            loadRestoreBackups(1);
        });
        document.getElementById('restoreBackupRefresh')?.addEventListener('click', () => loadRestoreBackups(1));
    }

    // ===================== 通用表格 / 分页 / 操作 =====================
    function renderBackupTable(tbodyId, rows, opts = {}) {
        const { showType = true, selectedCount = 0 } = opts;
        const tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        const cols = 5 + (showType ? 1 : 0);

        tbody.innerHTML = rows.length
            ? rows.map((r) => {
                let restoreBtn = '';
                if (selectedCount === 1) {
                    restoreBtn = btn('fa-undo', '恢复', 'border-red-300 text-red-600 hover:bg-red-50', `data-act="restore" data-id="${r.id}"`);
                } else if (selectedCount > 1 && r.scope === 'all') {
                    restoreBtn = btn('fa-layer-group', '批量恢复', 'border-red-300 text-red-600 hover:bg-red-50', `data-act="batch-restore" data-id="${r.id}"`);
                }
                return `
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
                            ${restoreBtn}
                        </td>
                    </tr>
                `;
            }).join('')
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
            notify(format === 'encrypted' ? '已下载加密备份（.aes），请与同名 .meta.json 配对保管' : '已下载明文备份', 'success');
        } catch (e) {
            console.error('[backupView] 下载失败:', e);
            alert('下载失败\n\n' + (e.message || '未知错误'));
        }
    }

    // ===================== 恢复模态框 =====================
    function openRestoreModal(item) {
        const codes = Array.from(restoreSelectedSchools);
        if (codes.length !== 1) {
            notify('单点恢复需且仅需选择一所目标学校');
            return;
        }
        const targetCode = codes[0];
        restoreTarget = { ...item, targetCode };
        document.getElementById('bkRestoreTargetCode').textContent = targetCode;
        document.getElementById('bkRestoreFileName').textContent = `${fmtTime(item.createdAt)} / ${escapeHtml(item.schoolCode || '全部学校')}`;
        document.getElementById('bkRestoreConfirm').value = '';
        document.getElementById('bkRestoreDo').disabled = true;
        document.getElementById('bkRestoreModal').classList.remove('hidden');
    }

    function openBatchRestoreModal(item) {
        const codes = Array.from(restoreSelectedSchools);
        if (codes.length < 2) {
            notify('批量恢复至少需要选择两所学校');
            return;
        }
        if (item.scope !== 'all') {
            notify('批量恢复仅支持全局备份');
            return;
        }
        restoreTarget = { ...item, targetCodes: codes };
        document.getElementById('bkBatchRestoreTarget').textContent = `${fmtTime(item.createdAt)} / 全部学校`;
        document.getElementById('bkBatchRestoreCount').textContent = String(codes.length);
        document.getElementById('bkBatchRestoreConfirm').value = '';
        document.getElementById('bkBatchRestoreDo').disabled = true;
        const list = document.getElementById('bkBatchSchoolList');
        list.innerHTML = codes.map((code) => {
            const s = allSchools.find((x) => x.code === code);
            return `<div class="text-left py-1 text-sm text-gray-700"><i class="fas fa-school text-blue-500 mr-1"></i>${escapeHtml(s?.name || code)} <span class="text-xs text-gray-400 font-mono">${code}</span></div>`;
        }).join('');
        document.getElementById('bkBatchRestoreModal').classList.remove('hidden');
    }

    function bindRestoreModal() {
        // 单点恢复
        const modal = document.getElementById('bkRestoreModal');
        const close = document.getElementById('bkRestoreClose');
        const cancel = document.getElementById('bkRestoreCancel');
        const confirm = document.getElementById('bkRestoreConfirm');
        const exec = document.getElementById('bkRestoreDo');

        const closeModal = () => modal?.classList.add('hidden');
        close?.addEventListener('click', closeModal);
        cancel?.addEventListener('click', closeModal);

        const checkConfirm = () => {
            if (exec) exec.disabled = confirm?.value !== 'RESTORE';
        };
        confirm?.addEventListener('input', checkConfirm);

        exec?.addEventListener('click', async () => {
            if (!restoreTarget || confirm.value !== 'RESTORE') return;
            exec.disabled = true;
            exec.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>恢复中…';
            try {
                const j = await api(`/${restoreTarget.id}/restore`, {
                    method: 'POST',
                    body: JSON.stringify({ targetSchoolCode: restoreTarget.targetCode, confirmText: 'RESTORE' })
                });
                if (j.success) {
                    alert('恢复完成 ✅\n\n' + (j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n'));
                    closeModal();
                    loadRestoreBackups(pagers.restoreBackup?.page || 1);
                } else {
                    alert(`恢复失败 ❌\n\n${(j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || j.error}`);
                }
            } catch (e) { notify(`恢复失败：${e.message}`); }
            exec.disabled = false;
            exec.innerHTML = '确认恢复';
        });

        // 批量恢复
        const bModal = document.getElementById('bkBatchRestoreModal');
        const bClose = document.getElementById('bkBatchRestoreClose');
        const bCancel = document.getElementById('bkBatchRestoreCancel');
        const bConfirm = document.getElementById('bkBatchRestoreConfirm');
        const bExec = document.getElementById('bkBatchRestoreDo');

        const closeBatch = () => bModal?.classList.add('hidden');
        bClose?.addEventListener('click', closeBatch);
        bCancel?.addEventListener('click', closeBatch);

        const checkBatchConfirm = () => {
            if (bExec) bExec.disabled = bConfirm?.value !== 'RESTORE_ALL';
        };
        bConfirm?.addEventListener('input', checkBatchConfirm);

        bExec?.addEventListener('click', async () => {
            if (!restoreTarget || bConfirm.value !== 'RESTORE_ALL') return;
            bExec.disabled = true;
            bExec.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>批量恢复中…';
            try {
                const j = await api(`/${restoreTarget.id}/restore-batch`, {
                    method: 'POST',
                    body: JSON.stringify({ confirmText: 'RESTORE_ALL', targetSchoolCodes: restoreTarget.targetCodes })
                });
                if (j.success) {
                    const summary = (j.results || []).map((r) => `${r.schoolCode}: ${r.success ? '成功' : '失败'}${r.error ? ` (${r.error})` : ''}`).join('\n');
                    alert(`批量恢复完成 ✅\n\n${summary || '全部成功'}`);
                    closeBatch();
                    loadRestoreBackups(pagers.restoreBackup?.page || 1);
                } else {
                    alert(`批量恢复失败 ❌\n\n${j.error || '未知错误'}`);
                }
            } catch (e) { notify(`批量恢复失败：${e.message}`); }
            bExec.disabled = false;
            bExec.innerHTML = '确认批量恢复';
        });
    }

    // ===================== 表格事件委托 =====================
    function bindTableEvents() {
        document.getElementById('adminViewBackup')?.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const { act, id } = btn.dataset;

            if (act === 'verify') {
                let reload = null;
                if (activeSub === 'global') reload = () => loadGlobalBackups(pagers.global?.page || 1);
                else if (activeSub === 'single') reload = () => loadSingleBackups(singleSelectedSchool.code, pagers.single?.page || 1);
                else if (activeSub === 'restore') reload = () => loadRestoreBackups(pagers.restoreBackup?.page || 1);
                doVerify(id, reload);
                return;
            }

            if (act === 'download-enc') {
                // 加密下载：密文安全，无需二次确认，直接下载 .aes（需与 .meta.json 配对保管）
                doDownload(id, 'encrypted');
                return;
            }

            if (act === 'download-plain') {
                // 明文下载：含全部业务数据，需单独强二次确认；服务端默认 403 拒绝，除非 BACKUP_PLAIN_DOWNLOAD_ALLOWED=true
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

            if (act === 'restore') {
                const item = findBackupInCurrentViews(id);
                if (item) openRestoreModal(item);
                return;
            }

            if (act === 'batch-restore') {
                const item = findBackupInCurrentViews(id);
                if (item) openBatchRestoreModal(item);
                return;
            }
        });
    }

    function findBackupInCurrentViews(id) {
        // 先从当前恢复列表找
        let item = restoreCurrentBackups.find((r) => r.id === id);
        if (item) return item;
        // 否则异步查全部
        api(`/?pageSize=500`).then((j) => {
            item = (j.data || []).find((r) => r.id === id);
            if (item) {
                if (restoreSelectedSchools.size === 1) openRestoreModal(item);
                else openBatchRestoreModal(item);
            }
        }).catch((e) => notify(e.message));
        return null;
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
    bindRestoreModal();
    bindTableEvents();

    // 暴露给 sidebar.js 的全局函数
    window.switchBackupSubview = switchBackupSubview;

    return { switchBackupSubview, loadBackupSubview, hasUnsaved: () => false };
}
