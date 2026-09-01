// 问题总览视图（listView）—— 全局：所有问题（任务+反馈）实时状态 + 收口
//
// 形态：实时状态表格（= 检测记录列表同构）+ 行展开轨迹 + 批量收口
// 数据源：GET /api/test-results/cases（task+issue 统一）+ GET /api/test-results/summary
// 收口：POST /api/test-results/cases/close
import { apiGet, apiPost, statusBadge, sourceBadge, renderEvidence, timeAgo } from './shared.js';
import { escapeHtml, showNotice } from '../../ui.js';

export function initListView() {
    return (subName) => render();
}

async function render() {
    const container = document.getElementById('adminViewReportsContent');
    if (!container) return;
    container.innerHTML = `
        <div class="max-w-[1800px] mx-auto px-4 py-4">
            <!-- 顶部统计条 -->
            <div id="lvSummary" class="flex flex-wrap gap-2 mb-4"></div>
            <!-- 筛选器 -->
            <div class="glass-card mb-4 p-3 flex flex-wrap gap-2 items-center">
                <select id="lvFilterSource" class="px-3 py-1.5 rounded-lg border border-gray-300 text-sm">
                    <option value="">全部来源</option>
                    <option value="task">📋 任务</option>
                    <option value="issue">🐞 反馈</option>
                </select>
                <select id="lvFilterGroup" class="px-3 py-1.5 rounded-lg border border-gray-300 text-sm">
                    <option value="">全部分组</option>
                </select>
                <select id="lvFilterResult" class="px-3 py-1.5 rounded-lg border border-gray-300 text-sm">
                    <option value="">全部状态</option>
                    <option value="failed">❌ 失败</option>
                    <option value="passed">✅ 通过</option>
                    <option value="pending">⏳ 未测</option>
                    <option value="skipped">⏭️ 跳过</option>
                </select>
                <input id="lvKeyword" type="text" placeholder="标题关键词" class="px-3 py-1.5 rounded-lg border border-gray-300 text-sm w-40">
                <button id="lvRefresh" class="ml-auto px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm"><i class="fas fa-sync-alt mr-1"></i>刷新</button>
            </div>
            <!-- 主表格 -->
            <div class="glass-card overflow-hidden">
                <table class="w-full text-sm">
                    <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
                        <tr>
                            <th class="px-3 py-2 text-left w-8"><input type="checkbox" id="lvSelectAll"></th>
                            <th class="px-3 py-2 text-left">来源</th>
                            <th class="px-3 py-2 text-left">编号</th>
                            <th class="px-3 py-2 text-left">标题</th>
                            <th class="px-3 py-2 text-left">分组</th>
                            <th class="px-3 py-2 text-left">状态</th>
                            <th class="px-3 py-2 text-left">轮次</th>
                            <th class="px-3 py-2 text-left">最新测试人</th>
                            <th class="px-3 py-2 text-left">最后测试</th>
                            <th class="px-3 py-2 text-left">操作</th>
                        </tr>
                    </thead>
                    <tbody id="lvTbody">
                        <tr><td colspan="10" class="text-center text-gray-400 py-8"><i class="fas fa-spinner fa-spin mr-2"></i>加载中…</td></tr>
                    </tbody>
                </table>
            </div>
            <!-- 批量收口条 -->
            <div id="lvBatchBar" class="hidden mt-3 flex items-center gap-3 p-3 glass-card">
                <span id="lvSelectedCount" class="text-sm text-gray-600">已选 0 项</span>
                <button id="lvBatchClose" class="px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white text-sm">批量收口</button>
                <button id="lvBatchOpen" class="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm">批量打开</button>
            </div>
        </div>
    `;
    ['lvFilterSource', 'lvFilterGroup', 'lvFilterResult'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => load());
    });
    document.getElementById('lvKeyword').addEventListener('input', () => debounce(load()));
    document.getElementById('lvRefresh').addEventListener('click', () => load());
    document.getElementById('lvSelectAll').addEventListener('change', (e) => {
        document.querySelectorAll('.lv-row-check').forEach(c => c.checked = e.target.checked);
        updateBatchBar();
    });
    document.querySelectorAll('.lv-row-check').forEach(c => c.addEventListener('change', updateBatchBar));
    document.getElementById('lvBatchClose').addEventListener('click', () => batchClose(true));
    document.getElementById('lvBatchOpen').addEventListener('click', () => batchClose(false));
    load();
}

let _allCases = [];

async function load() {
    const wrap = document.getElementById('lvTbody');
    if (!wrap) return;
    try {
        // 先拿 summary 补充分组下拉
        const sm = await apiGet('/api/test-results/summary');
        renderSummary(sm.data);
        // 补充分组下拉
        const groups = Object.keys(sm.data?.byGroup || {});
        const sel = document.getElementById('lvFilterGroup');
        const cur = sel.value;
        sel.innerHTML = '<option value="">全部分组</option>' + groups.map(g => `<option value="${escapeHtml(g)}" ${g === cur ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('');

        // 拉所有用例
        const params = new URLSearchParams();
        const src = document.getElementById('lvFilterSource').value;
        const grp = document.getElementById('lvFilterGroup').value;
        const kw = document.getElementById('lvKeyword').value.trim();
        if (src) params.set('source', src);
        if (grp) params.set('group', grp);
        if (kw) params.set('keyword', kw);
        const data = await apiGet('/api/test-results/cases' + (params.toString() ? '?' + params : ''));
        _allCases = data.data || [];
        // 状态筛选（后端按 latest_result 派生筛选）
        const rfilter = document.getElementById('lvFilterResult').value;
        const filtered = rfilter ? _allCases.filter(c => c.current_result === rfilter) : _allCases;
        renderTable(filtered);
    } catch (e) {
        wrap.innerHTML = `<tr><td colspan="10" class="text-center text-rose-500 py-8">加载失败：${escapeHtml(e.message)}</td></tr>`;
    }
}

function renderSummary(data) {
    const t = data?.totals || {};
    const items = [
        { label: '总数', val: t.total, cls: 'bg-gray-100 text-gray-700' },
        { label: '通过', val: t.passed, cls: 'bg-emerald-100 text-emerald-700' },
        { label: '失败', val: t.failed, cls: 'bg-rose-100 text-rose-700' },
        { label: '未测', val: t.pending, cls: 'bg-gray-100 text-gray-500' },
        { label: '待复测', val: t.fixed_pending, cls: 'bg-orange-100 text-orange-700' },
        { label: '已收口', val: t.closed, cls: 'bg-blue-100 text-blue-700' },
    ];
    document.getElementById('lvSummary').innerHTML = items.map(i => `
        <div class="px-3 py-1.5 rounded-lg ${i.cls} text-sm"><span class="font-bold">${i.val}</span> ${i.label}</div>
    `).join('');
}

function renderTable(items) {
    const wrap = document.getElementById('lvTbody');
    if (items.length === 0) {
        wrap.innerHTML = '<tr><td colspan="10" class="text-center text-gray-400 py-8">暂无数据</td></tr>';
        return;
    }
    // 排序：待复测 > 失败 > 未测 > 通过 > 已收口
    items.sort((a, b) => {
        const r = c => c.closed ? 5 : (c.fixed_pending_retest ? 1 : (c.current_result === 'failed' ? 2 : (c.current_result === 'pending' ? 3 : 4)));
        return r(a) - r(b);
    });
    wrap.innerHTML = items.map(c => {
        const fixed = c.fixed_pending_retest && !c.closed;
        return `
            <tr class="border-t border-gray-100 hover:bg-gray-50 ${fixed ? 'bg-orange-50/40' : ''}">
                <td class="px-3 py-2"><input type="checkbox" class="lv-row-check" data-id="${escapeHtml(c.id)}"></td>
                <td class="px-3 py-2">${sourceBadge(c.source)}</td>
                <td class="px-3 py-2 font-mono text-xs">${escapeHtml(c.case_key)}</td>
                <td class="px-3 py-2">${escapeHtml(c.title)}</td>
                <td class="px-3 py-2 text-xs text-gray-500">${escapeHtml(c.group)}</td>
                <td class="px-3 py-2">${statusBadge(c.current_result, { closed: c.closed, fixedPending: fixed })}</td>
                <td class="px-3 py-2 text-center">${c.rounds || 0}</td>
                <td class="px-3 py-2 text-xs">${escapeHtml(c.current_tester || '-')}</td>
                <td class="px-3 py-2 text-xs text-gray-500">${timeAgo(c.last_executed_at)}</td>
                <td class="px-3 py-2">
                    <button class="lv-btn-history text-xs text-sky-600 hover:underline" data-id="${escapeHtml(c.id)}">轨迹</button>
                    ${!c.closed ? `<button class="lv-btn-close text-xs text-blue-600 hover:underline ml-2" data-id="${escapeHtml(c.id)}">收口</button>` : `<button class="lv-btn-open text-xs text-gray-600 hover:underline ml-2" data-id="${escapeHtml(c.id)}">打开</button>`}
                </td>
            </tr>
            <tr class="lv-history-row hidden"><td colspan="10" class="px-6 py-3 bg-gray-50"></td></tr>
        `;
    }).join('');
    bindTableActions();
}

function bindTableActions() {
    document.querySelectorAll('.lv-btn-history').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const row = btn.closest('tr');
            const next = row.nextElementSibling;
            if (next.classList.contains('hidden')) {
                next.classList.remove('hidden');
                next.querySelector('td').innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>加载轨迹…';
                try {
                    const h = await apiGet(`/api/test-results/cases/${encodeURIComponent(id)}/history`);
                    const execs = h.data?.executions || [];
                    next.querySelector('td').innerHTML = execs.length ? execs.map(ex => {
                        const m = { passed: '✅', failed: '❌', skipped: '⏭️' }[ex.result] || '⏳';
                        return `<div class="mb-1 text-xs"><b>第${ex.round}轮</b> ${m} ${escapeHtml(ex.tester_name)} · ${timeAgo(ex.executed_at)}${ex.detail ? ' — ' + escapeHtml(ex.detail) : ''}</div>${renderEvidence(ex.evidence, { maxShow: 6, size: 'h-10 w-10' })}`;
                    }).join('<div class="my-2 border-t border-gray-200"></div>') : '<div class="text-xs text-gray-400">无执行记录</div>';
                } catch (e) { next.querySelector('td').innerHTML = `<span class="text-rose-500 text-xs">${escapeHtml(e.message)}</span>`; }
            } else next.classList.add('hidden');
        });
    });
    document.querySelectorAll('.lv-btn-close').forEach(btn => btn.addEventListener('click', () => singleClose(btn.dataset.id, true)));
    document.querySelectorAll('.lv-btn-open').forEach(btn => btn.addEventListener('click', () => singleClose(btn.dataset.id, false)));
    document.querySelectorAll('.lv-row-check').forEach(c => c.addEventListener('change', updateBatchBar));
}

async function singleClose(id, closed) {
    try {
        await apiPost('/api/test-results/cases/close', { case_ids: [id], closed });
        showNotice(closed ? '✅ 已收口' : '✅ 已打开', 'success');
        load();
    } catch (e) { showNotice('操作失败：' + e.message, 'error'); }
}

function updateBatchBar() {
    const checks = document.querySelectorAll('.lv-row-check:checked');
    const bar = document.getElementById('lvBatchBar');
    if (!bar) return;
    bar.classList.toggle('hidden', checks.length === 0);
    document.getElementById('lvSelectedCount').textContent = `已选 ${checks.length} 项`;
}

async function batchClose(closed) {
    const ids = [...document.querySelectorAll('.lv-row-check:checked')].map(c => c.dataset.id);
    if (ids.length === 0) return;
    try {
        await apiPost('/api/test-results/cases/close', { case_ids: ids, closed });
        showNotice(`✅ 已${closed ? '收口' : '打开'} ${ids.length} 项`, 'success');
        load();
    } catch (e) { showNotice('操作失败：' + e.message, 'error'); }
}

let _debounceTimer = null;
function debounce(fn, delay = 300) {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(fn, delay);
}
