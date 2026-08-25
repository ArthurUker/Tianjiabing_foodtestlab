// 问题反馈视图（issuesView）—— 计划外：测试中发现的新问题，上报 + 跟踪我的反馈
//
// 形态：工单流（问题卡片列表）+ 顶部反馈表单（标题+描述+分步截图）
// 数据源：GET /api/test-results/cases?source=issue（默认"我反馈的"，可切"全部"）
// 反馈：POST /api/test-results/executions（无 case_key，带 title → 自动建 issue 用例）
// 复测：同一卡片内提交新 execution（带 case_key=ISS-xxx）
// 标记修复：POST /api/test-results/cases/mark-fixed
import { apiGet, apiPost, statusBadge, sourceBadge, renderEvidence, timeAgo } from './shared.js';
import { escapeHtml, showNotice } from '../../ui.js';

let _testerName = '';
let _scope = 'mine'; // mine | all

export function initIssuesView() {
    return (subName) => render();
}

async function render() {
    const container = document.getElementById('adminViewReportsContent');
    if (!container) return;
    _testerName = localStorage.getItem('tr_tester_name') || '';
    container.innerHTML = `
        <div class="max-w-[1400px] mx-auto px-4 py-4">
            <!-- 反馈表单（默认折叠，点按钮展开） -->
            <div class="glass-card mb-4">
                <button id="isToggleForm" class="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50">
                    <span class="w-8 h-8 rounded-lg bg-fuchsia-500/10 text-fuchsia-600 flex items-center justify-center"><i class="fas fa-plus"></i></span>
                    <span class="font-semibold text-gray-800">反馈新问题</span>
                    <span class="text-xs text-gray-500">测试过程中发现的缺陷</span>
                    <i class="fas fa-chevron-down ml-auto text-gray-400" id="isFormChev"></i>
                </button>
                <div id="isFormBody" class="hidden px-4 pb-4 border-t border-gray-100">
                    <div class="mt-3 space-y-3">
                        <div>
                            <label class="text-xs text-gray-500">问题标题 *</label>
                            <input id="isTitle" type="text" maxlength="200" class="mt-1 w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:ring-2 focus:ring-fuchsia-500" placeholder="简明描述问题">
                        </div>
                        <div>
                            <label class="text-xs text-gray-500">复现步骤 / 期望 vs 实际</label>
                            <textarea id="isDetail" rows="3" class="mt-1 w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:ring-2 focus:ring-fuchsia-500" placeholder="1. 操作步骤... 2. 期望... 3. 实际..."></textarea>
                        </div>
                        <div>
                            <label class="text-xs text-gray-500">分步截图（按顺序添加）</label>
                            <div id="isEvidence" class="mt-1 flex flex-wrap gap-2"></div>
                            <input type="file" id="isFileInput" accept="image/*" multiple class="mt-1 text-xs text-gray-500">
                        </div>
                        <div class="flex gap-2">
                            <button id="isSubmit" class="px-4 py-2 rounded-lg bg-fuchsia-500 hover:bg-fuchsia-600 text-white text-sm">提交问题</button>
                        </div>
                    </div>
                </div>
            </div>
            <!-- 范围切换 -->
            <div class="flex items-center gap-2 mb-3">
                <button class="is-scope-btn px-3 py-1.5 rounded-lg text-sm ${_scope === 'mine' ? 'bg-fuchsia-500 text-white' : 'bg-gray-100 text-gray-600'}" data-scope="mine">我反馈的</button>
                <button class="is-scope-btn px-3 py-1.5 rounded-lg text-sm ${_scope === 'all' ? 'bg-fuchsia-500 text-white' : 'bg-gray-100 text-gray-600'}" data-scope="all">全部</button>
                <button id="isRefresh" class="ml-auto px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm text-gray-700"><i class="fas fa-sync-alt mr-1"></i>刷新</button>
            </div>
            <!-- 问题卡片流 -->
            <div id="isList" class="space-y-3">
                <div class="text-center text-gray-400 py-8"><i class="fas fa-spinner fa-spin mr-2"></i>加载中…</div>
            </div>
        </div>
    `;
    // 表单折叠
    document.getElementById('isToggleForm').addEventListener('click', () => {
        const body = document.getElementById('isFormBody');
        const chev = document.getElementById('isFormChev');
        body.classList.toggle('hidden');
        chev.classList.toggle('fa-chevron-down');
        chev.classList.toggle('fa-chevron-up');
    });
    // 范围切换
    document.querySelectorAll('.is-scope-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _scope = btn.dataset.scope;
            render();
        });
    });
    document.getElementById('isRefresh').addEventListener('click', () => loadList());
    // 反馈表单
    bindForm();
    // 加载列表
    loadList();
}

async function loadList() {
    const wrap = document.getElementById('isList');
    if (!wrap) return;
    wrap.innerHTML = '<div class="text-center text-gray-400 py-8"><i class="fas fa-spinner fa-spin mr-2"></i>加载中…</div>';
    try {
        const url = _scope === 'mine' && _testerName
            ? `/api/test-results/cases?source=issue&tester=${encodeURIComponent(_testerName)}`
            : '/api/test-results/cases?source=issue';
        const data = await apiGet(url);
        const items = data.data || [];
        if (items.length === 0) {
            wrap.innerHTML = '<div class="text-center text-gray-400 py-8">还没有问题反馈</div>';
            return;
        }
        // 排序：待复测 > 失败 > 已收口
        items.sort((a, b) => {
            const rank = c => c.closed ? 3 : (c.fixed_pending_retest ? 1 : (c.current_result === 'failed' ? 2 : 4));
            return rank(a) - rank(b);
        });
        wrap.innerHTML = items.map(c => renderIssueCard(c)).join('');
        bindCardActions();
    } catch (e) {
        wrap.innerHTML = `<div class="text-center text-rose-500 py-8">加载失败：${escapeHtml(e.message)}</div>`;
    }
}

function renderIssueCard(c) {
    const closed = c.closed;
    const fixed = c.fixed_pending_retest && !closed;
    return `
        <div class="glass-card p-4 ${fixed ? 'border-l-4 border-l-orange-400' : ''} ${closed ? 'opacity-70' : ''}" data-case-id="${escapeHtml(c.id)}" data-case-key="${escapeHtml(c.case_key)}">
            <div class="flex items-start gap-3">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap mb-1">
                        <span class="text-xs font-mono text-fuchsia-600">${escapeHtml(c.case_key)}</span>
                        <span class="font-medium text-gray-800">${escapeHtml(c.title)}</span>
                        ${statusBadge(c.current_result, { closed, fixedPending: fixed })}
                    </div>
                    <div class="text-xs text-gray-500">
                        反馈人 ${escapeHtml(c.reported_by || '未知')} · ${timeAgo(c.reported_at)}
                        · ${c.rounds || 0} 轮
                        ${c.fixed_note ? ` · <span class="text-orange-600">⚡已修复：${escapeHtml(c.fixed_note)}</span>` : ''}
                    </div>
                    ${c.last_detail ? `<div class="mt-2 text-sm text-gray-600">${escapeHtml(c.last_detail)}</div>` : ''}
                </div>
                <div class="flex gap-1 shrink-0">
                    ${!closed ? `
                        ${fixed ? '' : `<button class="is-btn-fix px-2 py-1 rounded text-xs bg-amber-100 text-amber-700 hover:bg-amber-200">标记已修复</button>`}
                        <button class="is-btn-retest px-2 py-1 rounded text-xs bg-emerald-500 text-white hover:bg-emerald-600">复测</button>
                    ` : `<button class="is-btn-reopen px-2 py-1 rounded text-xs bg-blue-100 text-blue-700 hover:bg-blue-200">重新打开</button>`}
                </div>
            </div>
            <div class="is-panel hidden mt-3 pt-3 border-t border-gray-100"></div>
        </div>
    `;
}

function bindCardActions() {
    document.querySelectorAll('.is-btn-retest').forEach(btn => {
        btn.addEventListener('click', async () => {
            const card = btn.closest('[data-case-id]');
            const panel = card.querySelector('.is-panel');
            const caseKey = card.dataset.caseKey;
            if (panel.classList.contains('hidden')) {
                panel.classList.remove('hidden');
                await renderRetestPanel(panel, caseKey);
            } else panel.classList.add('hidden');
        });
    });
    document.querySelectorAll('.is-btn-fix').forEach(btn => {
        btn.addEventListener('click', async () => {
            const card = btn.closest('[data-case-id]');
            const caseId = card.dataset.caseId;
            const note = prompt('修复说明（可选）') || '';
            try {
                await apiPost('/api/test-results/cases/mark-fixed', { case_id: caseId, fixed: true, note });
                showNotice('✅ 已标记修复·待复测', 'success');
                loadList();
            } catch (e) { showNotice('标记失败：' + e.message, 'error'); }
        });
    });
    document.querySelectorAll('.is-btn-reopen').forEach(btn => {
        btn.addEventListener('click', async () => {
            const card = btn.closest('[data-case-id]');
            const caseId = card.dataset.caseId;
            try {
                await apiPost('/api/test-results/cases/close', { case_ids: [caseId], closed: false });
                showNotice('✅ 已重新打开', 'success');
                loadList();
            } catch (e) { showNotice('打开失败：' + e.message, 'error'); }
        });
    });
}

async function renderRetestPanel(panel, caseKey) {
    panel.innerHTML = `
        <div class="space-y-3">
            <div>
                <label class="text-xs text-gray-500">本轮结果</label>
                <div class="flex gap-2 mt-1">
                    <button class="is-result-btn px-4 py-2 rounded-lg border-2 border-gray-200 text-sm" data-result="passed">✅ 通过</button>
                    <button class="is-result-btn px-4 py-2 rounded-lg border-2 border-gray-200 text-sm" data-result="failed">❌ 仍失败</button>
                    <button class="is-result-btn px-4 py-2 rounded-lg border-2 border-gray-200 text-sm" data-result="skipped">⏭️ 跳过</button>
                </div>
            </div>
            <textarea id="isRetestDetail" rows="2" class="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm" placeholder="本轮说明"></textarea>
            <button id="isRetestSubmit" class="px-4 py-2 rounded-lg bg-emerald-500 text-white text-sm disabled:opacity-50" disabled>提交本轮结果</button>
        </div>
    `;
    let selectedResult = null;
    panel.querySelectorAll('.is-result-btn').forEach(b => {
        b.addEventListener('click', () => {
            selectedResult = b.dataset.result;
            const colorMap = { passed: 'border-emerald-500 text-emerald-700', failed: 'border-rose-500 text-rose-600', skipped: 'border-amber-500 text-amber-600' };
            panel.querySelectorAll('.is-result-btn').forEach(x => x.className = 'is-result-btn px-4 py-2 rounded-lg border-2 border-gray-200 text-sm');
            b.className = 'is-result-btn px-4 py-2 rounded-lg border-2 text-sm ' + colorMap[selectedResult];
            document.getElementById('isRetestSubmit').disabled = false;
        });
    });
    document.getElementById('isRetestSubmit').addEventListener('click', async () => {
        if (!selectedResult) return;
        if (!_testerName) { showNotice('请先在测试任务页填好姓名', 'error'); return; }
        const detail = document.getElementById('isRetestDetail').value.trim();
        try {
            await apiPost('/api/test-results/executions', { case_key: caseKey, result: selectedResult, detail, tester_name: _testerName });
            showNotice('✅ 复测结果已提交', 'success');
            loadList();
        } catch (e) { showNotice('提交失败：' + e.message, 'error'); }
    });
}

function bindForm() {
    const evidenceUrls = [];
    const fileInput = document.getElementById('isFileInput');
    const evWrap = document.getElementById('isEvidence');
    fileInput.addEventListener('change', async () => {
        for (const file of fileInput.files) {
            if (evidenceUrls.length >= 8) { showNotice('最多 8 张', 'error'); break; }
            const dataUrl = await fileToBase64(file);
            try {
                const tempKey = `new-issue-${Date.now()}`;
                const r = await apiPost('/api/test-results/upload', { case_id: tempKey, files: [{ type: file.type, data: dataUrl.split(',')[1] }] });
                evidenceUrls.push(...(r.urls || []));
                evWrap.innerHTML = renderEvidence(JSON.stringify(evidenceUrls), { maxShow: 8, size: 'h-16 w-16' });
            } catch (e) { showNotice('上传失败：' + e.message, 'error'); }
        }
        fileInput.value = '';
    });
    document.getElementById('isSubmit').addEventListener('click', async () => {
        const title = document.getElementById('isTitle').value.trim();
        const detail = document.getElementById('isDetail').value.trim();
        if (!title) { showNotice('请填写问题标题', 'error'); return; }
        if (!_testerName) { showNotice('请先在测试任务页填好测试人员姓名', 'error'); return; }
        const btn = document.getElementById('isSubmit');
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>提交中…';
        try {
            await apiPost('/api/test-results/executions', {
                title, result: 'failed', detail,
                evidence: evidenceUrls.length ? JSON.stringify(evidenceUrls) : '',
                tester_name: _testerName, group: 'new_问题反馈',
            });
            showNotice('✅ 问题已反馈', 'success');
            document.getElementById('isTitle').value = '';
            document.getElementById('isDetail').value = '';
            evidenceUrls.length = 0;
            evWrap.innerHTML = '';
            loadList();
        } catch (e) { showNotice('反馈失败：' + e.message, 'error'); }
        btn.disabled = false;
        btn.textContent = '提交问题';
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
