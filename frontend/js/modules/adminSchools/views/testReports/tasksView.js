// 测试任务视图（tasksView）—— 计划内：后台安排的用例清单，逐条执行/复测
//
// 形态：分组折叠卡 + 用例行 + 行内展开填报面板（结果按钮组 + 详情 + 证据截图）
// 数据源：GET /api/test-results/defs（用例清单）+ GET /api/test-results/cases?source=task（当前状态）
// 提交：POST /api/test-results/executions（追加式）
// 复测轨迹：行内展开时 GET /api/test-results/cases/:id/history
import { apiGet, apiPost, statusBadge, renderEvidence, timeAgo } from './shared.js';
import { escapeHtml, showNotice } from '../../ui.js';

let _defsCache = null;      // 用例清单缓存（避免频繁拉取）
let _casesCache = new Map(); // case_key → 当前状态
let _testerName = '';        // 测试人员姓名（localStorage 记住）

export function initTasksView() {
    // 返回 switcher，供 sidebar 调用
    return (subName) => render();
}

async function loadDefs() {
    if (_defsCache) return _defsCache;
    const data = await apiGet('/api/test-results/defs');
    _defsCache = data.data || [];
    return _defsCache;
}

async function loadCasesStatus() {
    const data = await apiGet('/api/test-results/cases?source=task');
    _casesCache = new Map();
    for (const c of (data.data || [])) {
        _casesCache.set(c.case_key, c);
    }
}

async function render() {
    const container = document.getElementById('adminViewReportsContent');
    if (!container) return;
    container.innerHTML = `
        <div class="max-w-[1600px] mx-auto px-4 py-4">
            <!-- 顶部：测试人员身份 + 进度 -->
            <div class="glass-card mb-4 p-4 flex flex-wrap items-center gap-4">
                <div class="flex items-center gap-2">
                    <i class="fas fa-user-shield text-emerald-600"></i>
                    <label class="text-sm text-gray-700">测试人员</label>
                    <input id="trTesterName" type="text" placeholder="姓名" maxlength="20"
                           class="px-3 py-1.5 rounded-lg border border-gray-300 text-sm w-32 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
                </div>
                <div id="trProgress" class="flex gap-4 text-sm text-gray-600"></div>
                <div class="ml-auto flex gap-2">
                    <button id="trRefresh" class="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm text-gray-700">
                        <i class="fas fa-sync-alt mr-1"></i>刷新
                    </button>
                </div>
            </div>
            <!-- 分组折叠区 -->
            <div id="trGroups" class="space-y-3">
                <div class="text-center text-gray-400 py-8"><i class="fas fa-spinner fa-spin mr-2"></i>加载中…</div>
            </div>
        </div>
    `;
    // 绑定事件 + 加载数据
    const nameInput = document.getElementById('trTesterName');
    _testerName = localStorage.getItem('tr_tester_name') || '';
    nameInput.value = _testerName;
    nameInput.addEventListener('change', () => {
        _testerName = nameInput.value.trim();
        localStorage.setItem('tr_tester_name', _testerName);
    });
    document.getElementById('trRefresh').addEventListener('click', () => render());
    try {
        await loadDefs();
        await loadCasesStatus();
        renderGroups();
    } catch (e) {
        document.getElementById('trGroups').innerHTML = `<div class="text-center text-rose-500 py-8">加载失败：${escapeHtml(e.message)}</div>`;
    }
}

function renderGroups() {
    const wrap = document.getElementById('trGroups');
    if (!_defsCache || _defsCache.length === 0) {
        wrap.innerHTML = '<div class="text-center text-gray-400 py-8">暂无用例</div>';
        return;
    }
    // 进度统计
    let total = 0, passed = 0, failed = 0, pending = 0, fixed = 0;
    for (const g of _defsCache) {
        for (const c of g.cases) {
            total++;
            const st = _casesCache.get(c.id);
            if (!st || st.current_result === 'pending') pending++;
            else if (st.current_result === 'passed') passed++;
            else if (st.current_result === 'failed') failed++;
            if (st?.fixed_pending_retest && !st?.closed) fixed++;
        }
    }
    document.getElementById('trProgress').innerHTML = `
        <span>已测 <b class="text-gray-900">${total - pending}</b>/${total}</span>
        <span class="text-emerald-600">通过 ${passed}</span>
        <span class="text-rose-600">失败 ${failed}</span>
        <span class="text-gray-500">未测 ${pending}</span>
        ${fixed ? `<span class="text-orange-600">待复测 ${fixed}🔔</span>` : ''}
    `;

    let html = '';
    for (const g of _defsCache) {
        const stats = countGroup(g);
        const allClosed = g.cases.every(c => _casesCache.get(c.id)?.closed);
        html += `
            <div class="glass rounded-2xl border border-white/50 shadow-lg overflow-hidden mb-4">
                <button class="tr-group-header w-full px-5 py-3.5 flex items-center gap-3 hover:bg-white/40 text-left bg-white/30 backdrop-blur-sm" data-group="${escapeHtml(g.group)}">
                    <i class="fas fa-chevron-right tr-chevron text-gray-500 transition-transform"></i>
                    <span class="font-semibold text-gray-800">${escapeHtml(g.groupName || g.group)}</span>
                    <span class="text-xs text-gray-600">${g.cases.length} 用例</span>
                    <span class="ml-auto flex gap-2 text-xs">
                        ${stats.passed ? `<span class="text-emerald-600">✅${stats.passed}</span>` : ''}
                        ${stats.failed ? `<span class="text-rose-600">❌${stats.failed}</span>` : ''}
                        ${stats.fixed ? `<span class="text-orange-600">🔔${stats.fixed}</span>` : ''}
                        ${stats.pending ? `<span class="text-gray-500">⏳${stats.pending}</span>` : ''}
                        ${stats.closed ? `<span class="text-blue-600">🔒${stats.closed}</span>` : ''}
                    </span>
                </button>
                <div class="tr-group-body hidden border-t border-white/40 bg-white/20 backdrop-blur-sm p-3">
                    ${renderCaseRows(g)}
                </div>
            </div>
        `;
    }
    wrap.innerHTML = html;
    // 绑定折叠
    wrap.querySelectorAll('.tr-group-header').forEach(btn => {
        btn.addEventListener('click', () => {
            const body = btn.nextElementSibling;
            const chev = btn.querySelector('.tr-chevron');
            body.classList.toggle('hidden');
            chev.classList.toggle('fa-chevron-right');
            chev.classList.toggle('fa-chevron-down');
        });
    });
    // 待复测的组默认展开
    for (const g of _defsCache) {
        const stats = countGroup(g);
        if (stats.fixed > 0) {
            const btn = wrap.querySelector(`[data-group="${CSS.escape(g.group)}"]`);
            if (btn) btn.click();
        }
    }
    // 行内操作绑定
    bindRowActions();
}

function countGroup(g) {
    const s = { passed: 0, failed: 0, skipped: 0, pending: 0, closed: 0, fixed: 0 };
    for (const c of g.cases) {
        const st = _casesCache.get(c.id);
        if (st?.closed) s.closed++;
        else if (!st || st.current_result === 'pending') s.pending++;
        else if (st.current_result === 'passed') s.passed++;
        else if (st.current_result === 'failed') s.failed++;
        else if (st.current_result === 'skipped') s.skipped++;
        if (st?.fixed_pending_retest && !st?.closed) s.fixed++;
    }
    return s;
}

function renderCaseRows(g) {
    let html = '<div class="space-y-2">';
    // 待复测置顶 → 失败次之 → 未测 → 已通过 → 已收口
    const ordered = [...g.cases].sort((a, b) => {
        const sa = _casesCache.get(a.id) || {};
        const sb = _casesCache.get(b.id) || {};
        const rank = c => c.closed ? 5 : (c.fixed_pending_retest ? 1 : (c.current_result === 'failed' ? 2 : (c.current_result === 'pending' ? 3 : 4)));
        return rank(sa) - rank(sb);
    });
    for (const c of ordered) {
        const st = _casesCache.get(c.id) || {};
        const closed = st.closed;
        const result = st.current_result || 'pending';
        const fixed = st.fixed_pending_retest && !closed;
        const rowBg = fixed
            ? 'bg-orange-50/90 border-orange-200'
            : 'bg-white/85 hover:bg-white border-gray-200';
        html += `
            <div class="tr-row rounded-xl border ${rowBg} shadow-sm backdrop-blur-sm transition-colors" data-case-key="${escapeHtml(c.id)}">
                <div class="px-4 py-3 flex items-start gap-3">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-xs text-gray-500 font-mono">${escapeHtml(c.id)}</span>
                            <span class="font-medium text-gray-800">${escapeHtml(c.title)}</span>
                            ${statusBadge(result, { closed, fixedPending: fixed })}
                            ${st.current_tester ? `<span class="text-xs text-gray-400">· ${escapeHtml(st.current_tester)} ${timeAgo(st.last_executed_at)}</span>` : ''}
                        </div>
                        ${c.guide ? `<details class="mt-1 text-xs text-gray-500"><summary class="cursor-pointer hover:text-gray-700">执行指引</summary><div class="mt-1 whitespace-pre-wrap">${escapeHtml(c.guide)}</div></details>` : ''}
                    </div>
                    <div class="flex gap-2 shrink-0">
                        ${!closed ? `<button class="tr-btn-exec px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs"><i class="fas fa-play mr-1"></i>${fixed ? '复测' : '执行'}</button>` : '<span class="text-xs text-gray-400 px-2 py-1">已收口</span>'}
                    </div>
                </div>
                <div class="tr-panel hidden mt-3 pt-3 px-4 pb-3 border-t border-gray-200"></div>
            </div>
        `;
    }
    html += '</div>';
    return html;
}

function bindRowActions() {
    document.querySelectorAll('.tr-btn-exec').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const row = btn.closest('.tr-row');
            const panel = row.querySelector('.tr-panel');
            const caseKey = row.dataset.caseKey;
            if (panel.classList.contains('hidden')) {
                panel.classList.remove('hidden');
                await renderExecPanel(panel, caseKey);
            } else {
                panel.classList.add('hidden');
            }
        });
    });
}

async function renderExecPanel(panel, caseKey) {
    panel.innerHTML = '<div class="text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-1"></i>加载历史…</div>';
    const st = _casesCache.get(caseKey) || {};
    let historyHtml = '';
    if (st.id || st.case_key) {
        try {
            const hist = await apiGet(`/api/test-results/cases/${encodeURIComponent(st.id || st.case_key)}/history`);
            const execs = hist.data?.executions || [];
            if (execs.length > 0) {
                historyHtml = '<div class="mb-3 text-xs text-gray-500 space-y-1">';
                for (const ex of execs) {
                    const m = { passed: '✅', failed: '❌', skipped: '⏭️' }[ex.result] || '⏳';
                    historyHtml += `<div>${m} <b>第${ex.round}轮</b> ${escapeHtml(ex.tester_name)} · ${timeAgo(ex.executed_at)}${ex.detail ? ' — ' + escapeHtml(ex.detail) : ''}</div>`;
                }
                historyHtml += '</div>';
            }
        } catch (e) { /* 忽略 */ }
    }
    panel.innerHTML = `
        ${historyHtml}
        ${st.fixed_note ? `<div class="mb-2 text-xs text-orange-600"><i class="fas fa-bell mr-1"></i>已修复：${escapeHtml(st.fixed_note)}</div>` : ''}
        <div class="space-y-3">
            <div>
                <label class="text-xs text-gray-500">本轮结果</label>
                <div class="flex gap-2 mt-1">
                    <button class="tr-result-btn px-4 py-2 rounded-lg border-2 border-emerald-500 text-emerald-700 hover:bg-emerald-50 text-sm" data-result="passed">✅ 通过</button>
                    <button class="tr-result-btn px-4 py-2 rounded-lg border-2 border-gray-200 text-gray-600 hover:border-rose-500 hover:text-rose-600 text-sm" data-result="failed">❌ 失败</button>
                    <button class="tr-result-btn px-4 py-2 rounded-lg border-2 border-gray-200 text-gray-600 hover:border-amber-500 hover:text-amber-600 text-sm" data-result="skipped">⏭️ 跳过</button>
                </div>
            </div>
            <div>
                <label class="text-xs text-gray-500">问题描述 / 期望 vs 实际</label>
                <textarea id="trDetail" rows="2" class="mt-1 w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:ring-2 focus:ring-emerald-500" placeholder="失败时建议填写复现步骤"></textarea>
            </div>
            <div>
                <label class="text-xs text-gray-500">证据截图</label>
                <div id="trEvidence" class="mt-1 flex flex-wrap gap-2"></div>
                <input type="file" id="trFileInput" accept="image/*" multiple class="mt-1 text-xs text-gray-500">
            </div>
            <div class="flex gap-2">
                <button id="trSubmit" class="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm disabled:opacity-50" disabled>提交本轮结果</button>
                <button class="tr-cancel px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm">取消</button>
            </div>
        </div>
    `;
    // 结果按钮选中
    let selectedResult = null;
    panel.querySelectorAll('.tr-result-btn').forEach(b => {
        b.addEventListener('click', () => {
            selectedResult = b.dataset.result;
            panel.querySelectorAll('.tr-result-btn').forEach(x => x.classList.remove('border-2', 'border-emerald-500', 'text-emerald-700'));
            const colorMap = { passed: 'border-emerald-500 text-emerald-700', failed: 'border-rose-500 text-rose-600', skipped: 'border-amber-500 text-amber-600' };
            b.className = 'tr-result-btn px-4 py-2 rounded-lg border-2 text-sm ' + colorMap[selectedResult];
            document.getElementById('trSubmit').disabled = false;
        });
    });
    // 证据上传
    const evidenceUrls = [];
    const fileInput = document.getElementById('trFileInput');
    const evWrap = document.getElementById('trEvidence');
    fileInput.addEventListener('change', async () => {
        for (const file of fileInput.files) {
            if (evidenceUrls.length >= 8) { showNotice('最多 8 张', 'error'); break; }
            const dataUrl = await fileToBase64(file);
            try {
                const r = await apiPost('/api/test-results/upload', { case_id: caseKey, files: [{ type: file.type, data: dataUrl.split(',')[1] }] });
                evidenceUrls.push(...(r.urls || []));
                evWrap.innerHTML = renderEvidence(JSON.stringify(evidenceUrls), { maxShow: 8, size: 'h-16 w-16' });
            } catch (e) { showNotice('上传失败：' + e.message, 'error'); }
        }
        fileInput.value = '';
    });
    // 取消
    panel.querySelector('.tr-cancel').addEventListener('click', () => panel.classList.add('hidden'));
    // 提交
    document.getElementById('trSubmit').addEventListener('click', async () => {
        if (!selectedResult) return;
        if (!_testerName) { showNotice('请先填写测试人员姓名', 'error'); return; }
        const detail = document.getElementById('trDetail').value.trim();
        if (selectedResult === 'failed' && !detail) { showNotice('失败时请填写问题描述', 'error'); return; }
        const btn = document.getElementById('trSubmit');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>提交中…';
        try {
            await apiPost('/api/test-results/executions', {
                case_key: caseKey,
                result: selectedResult,
                detail,
                evidence: evidenceUrls.length ? JSON.stringify(evidenceUrls) : '',
                tester_name: _testerName,
            });
            showNotice('✅ 提交成功', 'success');
            // 刷新数据
            await loadCasesStatus();
            renderGroups();
        } catch (e) {
            showNotice('提交失败：' + e.message, 'error');
            btn.disabled = false;
            btn.textContent = '提交本轮结果';
        }
    });
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}
