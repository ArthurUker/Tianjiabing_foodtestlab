// ====== 学校列表 + 回收站 + 租户预览 + 手动复制对话框（机械迁移自 admin-schools.html 1776-2146 + 初始化区）======
// openDetail / switchSchoolsSubview 属学校详情域，由装配层注入（避免视图模块相互循环依赖）。
// 迁移注记：btn-recycle-goto 中 typeof openSchoolDetail === 'function' 的探测在原代码中即为
// false（全项目无该定义，走 fallthrough DOM 查找），此处保持原行为。
import { state } from '../customization/store.js';
import { escapeHtml, showNotice } from '../ui.js';
import { adminFetch } from '../context.js';

let gotoDetail = () => {};
let switchSchoolsSubview = () => {};

export function initSchoolsListView({ openDetail, switchSchoolsSubview: sw }) {
    gotoDetail = openDetail;
    switchSchoolsSubview = sw;
    // 列表工具条
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadSchools);
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.addEventListener('input', renderSchools);
    bindRecycleBinControls();
    loadSchools();
}

export function schoolLoginUrl(code) {
    const c = String(code || '').replace(/^school_/, '').replace(/_/g, '-');
    return `${location.origin}/${encodeURIComponent(c)}/login.html?school=${encodeURIComponent(c)}`;
}

// RBAC 收敛：学校租户预览窗口（超管以 iframe 预览该校登录页/网页，不进入该校业务数据）
function openPreviewSchool(code) {
    const school = state.allSchools.find(s => s.code === code);
    const name = school ? (school.name || code) : code;
    const url = schoolLoginUrl(code);
    document.getElementById('previewSchoolTitle').textContent = `${name} (${code})`;
    document.getElementById('previewSchoolOpenLink').href = url;
    document.getElementById('previewSchoolFrame').src = url;
    document.getElementById('previewSchoolModal').classList.remove('hidden');
}
function closePreviewSchool() {
    document.getElementById('previewSchoolModal').classList.add('hidden');
    document.getElementById('previewSchoolFrame').src = 'about:blank'; // 释放 iframe，避免后台继续运行
}
// 预览窗口关闭：点遮罩 / 关闭按钮 / ESC
document.querySelectorAll('[data-preview-close]').forEach(el => {
    el.addEventListener('click', closePreviewSchool);
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('previewSchoolModal').classList.contains('hidden')) {
        closePreviewSchool();
    }
});

// 当 Clipboard API 与 execCommand 均失败时弹出的降级对话框（用户手动复制 / 点击打开）
function showManualCopyDialog(url) {
    const dlg = document.getElementById('manualCopyDialog');
    const inp = document.getElementById('manualCopyInput');
    const openBtn = document.getElementById('manualCopyOpen');
    const copyBtn = document.getElementById('manualCopyDo');
    const closeBtn = document.getElementById('manualCopyClose');
    if (!dlg || !inp) return;
    inp.value = url;
    dlg.classList.remove('hidden');
    dlg.classList.add('flex');
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const onClose = () => {
        dlg.classList.add('hidden');
        dlg.classList.remove('flex');
        openBtn.onclick = null; copyBtn.onclick = null; closeBtn.onclick = null;
    };
    openBtn.onclick = () => { window.open(url, '_blank', 'noopener'); onClose(); };
    copyBtn.onclick = async () => {
        const ok = await (async () => {
            try {
                if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(url); return true; }
            } catch { /* 降级到 execCommand */ }
            try {
                inp.select(); return document.execCommand('copy');
            } catch { return false; }
        })();
        if (ok) { copyBtn.innerHTML = '<i class="fas fa-check mr-1"></i>已复制'; setTimeout(() => { copyBtn.innerHTML = '<i class="fas fa-copy mr-1"></i>复制'; }, 1500); }
        else { showNotice('复制仍失败，请手动 Ctrl+C 选择文本', 'error'); }
    };
    closeBtn.onclick = onClose;
}

export async function loadSchools() {
    const tbody = document.getElementById('schoolTbody');
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-gray-400">加载中...</td></tr>';
    try {
        const resp = await adminFetch('/api/admin/schools');
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || '加载失败');
        state.allSchools = json.data || [];
        renderSchools();
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-red-500">${escapeHtml(e.message)}</td></tr>`;
    }
}

function renderSchools() {
    const tbody = document.getElementById('schoolTbody');
    const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
    const filtered = keyword
        ? state.allSchools.filter(s => (s.code || '').toLowerCase().includes(keyword) || (s.name || '').toLowerCase().includes(keyword))
        : state.allSchools;
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-gray-400">暂无学校</td></tr>';
        return;
    }
    tbody.innerHTML = filtered.map(s => `
        <tr>
            <td class="font-mono text-xs">${escapeHtml(s.code)}</td>
            <td>${escapeHtml(s.name || '')}</td>
            <td>${escapeHtml(s.short_name || '')}</td>
            <td>${s.status === 'active' ? '<span class="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">启用</span>' : '<span class="px-2 py-0.5 bg-gray-200 text-gray-600 rounded-full text-xs">停用</span>'}</td>
            <td>${s.logo_url ? `<img src="${escapeHtml(s.logo_url)}" alt="logo" class="w-7 h-7 object-contain rounded">` : '<i class="fas fa-school text-gray-300"></i>'}</td>
            <td class="text-xs text-gray-500">${s.created_at ? new Date(s.created_at).toLocaleDateString() : ''}</td>
            <td><div class="flex items-center gap-1"><a href="${escapeHtml(schoolLoginUrl(s.code))}" target="_blank" rel="noopener" class="text-xs text-blue-600 hover:text-blue-800 hover:underline break-all max-w-[200px] truncate" title="${escapeHtml(schoolLoginUrl(s.code))}（点击新窗口打开）">${escapeHtml(schoolLoginUrl(s.code))}</a><button class="btn-copy-login flex-shrink-0 px-1.5 py-0.5 text-xs bg-gray-100 hover:bg-blue-100 text-gray-500 hover:text-blue-700 rounded transition" data-url="${escapeHtml(schoolLoginUrl(s.code))}" title="复制登录地址（请用无痕窗口打开）"><i class="fas fa-copy"></i></button></div></td>
            <td><div class="flex items-center gap-1">
                <button class="px-2 py-1 text-xs bg-emerald-50 text-emerald-700 rounded hover:bg-emerald-100 transition btn-preview-school" data-code="${escapeHtml(s.code)}" title="在超管界面预览该校租户网页（iframe）"><i class="fas fa-eye mr-1"></i>预览</button>
                <button class="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100 transition btn-manage" data-code="${escapeHtml(s.code)}"><i class="fas fa-cog mr-1"></i>管理</button>
                <button class="px-2 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100 transition btn-delete-school" data-code="${escapeHtml(s.code)}" title="停用该校（数据保留）"><i class="fas fa-trash mr-1"></i>停用</button>
                ${s.status === 'disabled' ? `<button class="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition btn-hard-delete" data-code="${escapeHtml(s.code)}" title="彻底删除（移入回收站，90 天内可恢复）"><i class="fas fa-eraser mr-1"></i>彻底删除</button>` : ''}
            </div></td>
        </tr>
    `).join('');

    // 学校列表"复制登录地址"按钮：兼容三段降级（Clipboard API → execCommand → 模态弹窗）
    async function copyTextFallback(text) {
        // 方案1：现代 Clipboard API（要求 secure context / 用户授权）
        if (navigator.clipboard && window.isSecureContext) {
            try { await navigator.clipboard.writeText(text); return 'clipboard-api'; }
            catch (e) { /* fall through */ }
        }
        // 方案2：execCommand('copy')，兼容旧浏览器/非安全上下文
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.top = '-9999px';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            if (ok) return 'exec-command';
        } catch (e) { /* fall through */ }
        // 方案3：模态弹窗让用户手动复制
        return null;
    }

    tbody.querySelectorAll('.btn-copy-login').forEach(btn => {
        btn.addEventListener('click', async () => {
            const url = btn.dataset.url;
            const ok = await copyTextFallback(url);
            if (ok) {
                btn.innerHTML = '<i class="fas fa-check text-green-600"></i>';
                setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1500);
                const msg = ok === 'exec-command'
                    ? '✅ 登录地址已复制（兼容模式）！请用 <b>无痕窗口</b>（Ctrl+Shift+N）打开'
                    : '✅ 登录地址已复制！请用 <b>无痕窗口</b>（Ctrl+Shift+N）打开';
                showNotice(msg, 'info');
            } else {
                // 降级到模态弹窗（也方便直接点链接打开）
                showManualCopyDialog(url);
            }
        });
    });
    tbody.querySelectorAll('.btn-manage').forEach(btn => {
        btn.addEventListener('click', () => gotoDetail(btn.dataset.code));
    });
    // RBAC 收敛：学校租户预览窗口（超管以 iframe 预览该校网页，无需进入该校业务数据）
    tbody.querySelectorAll('.btn-preview-school').forEach(btn => {
        btn.addEventListener('click', () => openPreviewSchool(btn.dataset.code));
    });

    // P1: 逻辑删除(软删除——置 disabled,数据保留)
    tbody.querySelectorAll('.btn-delete-school').forEach(btn => {
        btn.addEventListener('click', async () => {
            const code = btn.dataset.code;
            if (!confirm(`确定要停用学校「${code}」吗？\n停用后该校用户将无法登录，数据会保留。`)) return;
            try {
                const resp = await adminFetch(`/api/admin/schools/${code}`, { method: 'DELETE' });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || '删除失败');
                showNotice(data.message || `✅ 学校 ${code} 已停用`, 'success');
                loadSchools();
            } catch (e) {
                showNotice('❌ ' + e.message, 'error');
            }
        });
    });

    // S1#1: 彻底删除（必须先停用，移入回收站 90 天内可恢复）
    tbody.querySelectorAll('.btn-hard-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const code = btn.dataset.code;
            if (!confirm(`⚠️ 即将彻底删除学校「${code}」\n\n• 该校数据将移入回收站\n• 90 天内可恢复\n• 90 天后需手动清除后不可恢复\n\n确定继续吗？`)) return;
            try {
                const resp = await adminFetch(`/api/admin/schools/${code}/hard`, { method: 'DELETE' });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || '彻底删除失败');
                showNotice(data.message || `✅ 学校 ${code} 已移入回收站`, 'success');
                loadSchools();
            } catch (e) {
                showNotice('❌ ' + e.message, 'error');
            }
        });
    });
}

// ====== S1#1 回收站 ======
export async function loadRecycleBin() {
    const listEl = document.getElementById('recycleBinList');
    if (!listEl) return;
    try {
        const resp = await adminFetch('/api/admin/recycle-bin');
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '获取回收站失败');
        // TD-RecycleBin-Restored-Filter: 已恢复（status='restored'）= 学校已重新启用（回到学校列表），
        // 不应再出现在回收站列表里。后端 SQL 已过滤，这里前端再过滤一次作双重保险 + UI 意图清晰。
        const items = (data.data || []).filter((it) => it.status !== 'restored');
        if (!items.length) {
            listEl.innerHTML = '<p class="text-sm text-gray-400">回收站为空，暂无已彻底删除的学校。</p>';
            return;
        }
        const rows = items.map((it) => {
            // 按 status（active/restored/purged）+ 过期状态渲染徽章与操作按钮。
            // 任意状态都有具体可执行动作，避免空操作列（横杠）。设计：
            //   active  : 恢复 / 清除
            //   expired : 清除（剩余 N 天 = 0 视为过期）
            //   restored: 重新查看（跳学校管理 / 选学校）/ 复制学校代码 / 重新删除（不再进回收站，立即进 purged 状态）
            //   purged  : 归档清理（清掉 recycle_bin 表档案行，业务安全）/ 复制学校代码
            let statusBadge;
            let actions;
            if (it.status === 'restored') {
                statusBadge = '<span class="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-xs">已恢复</span>';
                actions = `
                    <button class="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100 transition btn-recycle-goto" data-code="${escapeHtml(it.original_code)}" title="跳转学校管理查看该校详情"><i class="fas fa-external-link-alt mr-1"></i>查看</button>
                    <button class="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition btn-recycle-copy" data-code="${escapeHtml(it.original_code)}" title="复制学校代码"><i class="fas fa-copy mr-1"></i>复制</button>
                    <button class="px-2 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100 transition btn-recycle-redelete" data-code="${escapeHtml(it.original_code)}" title="重新删除（立即进 purged 状态，不再走回收站）"><i class="fas fa-trash mr-1"></i>再删除</button>`;
            } else if (it.status === 'purged') {
                statusBadge = '<span class="px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-xs" title="该校数据已物理删除，不可恢复">已彻底删除</span>';
                actions = `
                    <button class="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition btn-recycle-copy" data-code="${escapeHtml(it.original_code)}" title="复制学校代码"><i class="fas fa-copy mr-1"></i>复制</button>
                    <button class="px-2 py-1 text-xs bg-slate-50 text-slate-700 rounded hover:bg-slate-200 transition btn-recycle-archive" data-id="${escapeHtml(it.id)}" data-code="${escapeHtml(it.original_code)}" title="清理回收站档案行（业务安全：schema 已 DROP，无可逆影响）"><i class="fas fa-archive mr-1"></i>归档清理</button>`;
            } else if (it.expired) {
                statusBadge = '<span class="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs">已过期</span>';
                actions = `<button class="px-2 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100 transition btn-recycle-purge" data-id="${escapeHtml(it.id)}" title="清除（不可恢复）"><i class="fas fa-eraser mr-1"></i>清除</button>
                    <button class="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition btn-recycle-copy" data-code="${escapeHtml(it.original_code)}" title="复制学校代码"><i class="fas fa-copy mr-1"></i>复制</button>`;
            } else {
                statusBadge = `<span class="px-2 py-0.5 bg-orange-100 text-orange-700 rounded-full text-xs">剩余 ${it.keepDays} 天</span>`;
                actions = `<button class="px-2 py-1 text-xs bg-green-50 text-green-700 rounded hover:bg-green-100 transition btn-recycle-restore" data-id="${escapeHtml(it.id)}" title="恢复学校及数据"><i class="fas fa-undo mr-1"></i>恢复</button>
                    <button class="px-2 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100 transition btn-recycle-purge" data-id="${escapeHtml(it.id)}" title="清除（不可恢复）"><i class="fas fa-eraser mr-1"></i>清除</button>
                    <button class="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition btn-recycle-copy" data-code="${escapeHtml(it.original_code)}" title="复制学校代码"><i class="fas fa-copy mr-1"></i>复制</button>`;
            }
            return `
            <tr class="border-b border-gray-100">
                <td class="py-2 font-mono text-xs">${escapeHtml(it.original_code)}</td>
                <td class="py-2 text-sm">${escapeHtml(it.name || '')}</td>
                <td class="py-2 text-xs text-gray-500">${it.deleted_at ? new Date(it.deleted_at).toLocaleString() : ''}</td>
                <td class="py-2">${statusBadge}</td>
                <td class="py-2">
                    <div class="flex items-center gap-1">${actions}</div>
                </td>
            </tr>`;
        }).join('');
        listEl.innerHTML = `<table class="glass-table"><thead><tr>
            <th class="text-left text-xs text-gray-500">学校代码</th>
            <th class="text-left text-xs text-gray-500">学校名称</th>
            <th class="text-left text-xs text-gray-500">删除时间</th>
            <th class="text-left text-xs text-gray-500">保留状态</th>
            <th class="text-left text-xs text-gray-500">操作</th>
        </tr></thead><tbody>${rows}</tbody></table>`;

        listEl.querySelectorAll('.btn-recycle-restore').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                if (!confirm(`确定要恢复该学校吗？\n将恢复该校 schema 与全部数据（含定制配置）。`)) return;
                try {
                    const resp = await adminFetch(`/api/admin/recycle-bin/${id}/restore`, { method: 'POST' });
                    const data = await resp.json();
                    if (!resp.ok) throw new Error(data.error || '恢复失败');
                    showNotice(data.message || '✅ 学校已恢复', 'success');
                    loadRecycleBin();
                    loadSchools();
                } catch (e) {
                    showNotice('❌ ' + e.message, 'error');
                }
            });
        });
        listEl.querySelectorAll('.btn-recycle-purge').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                if (!confirm(`⚠️ 即将彻底清除该学校（含回收站数据）\n\n此操作不可恢复！确定继续吗？`)) return;
                try {
                    const resp = await adminFetch(`/api/admin/recycle-bin/${id}/purge`, { method: 'POST' });
                    const data = await resp.json();
                    if (!resp.ok) throw new Error(data.error || '清除失败');
                    showNotice(data.message || '✅ 已清除', 'success');
                    loadRecycleBin();
                } catch (e) {
                    showNotice('❌ ' + e.message, 'error');
                }
            });
        });
        // 新增按钮绑定：复制学校代码 / 查看 / 归档清理 / 再删除
        listEl.querySelectorAll('.btn-recycle-copy').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const code = btn.dataset.code;
                if (!code) return;
                try {
                    await navigator.clipboard.writeText(code);
                    showNotice(`已复制学校代码：${code}`, 'success');
                } catch (_) {
                    // 兜底：用临时 textarea 触发 execCommand
                    const ta = document.createElement('textarea');
                    ta.value = code;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand('copy'); showNotice(`已复制：${code}`, 'success'); }
                    catch (e) { showNotice('复制失败，请手动复制：' + code, 'error'); }
                    document.body.removeChild(ta);
                }
            });
        });
        listEl.querySelectorAll('.btn-recycle-goto').forEach((btn) => {
            btn.addEventListener('click', () => {
                const code = btn.dataset.code;
                if (!code) return;
                // 跳转学校列表并按 code 定位该校（当前 subview 切回 list，再由后续 addSchool+runSchoolActions 选中）
                switchSchoolsSubview && switchSchoolsSubview('list');
                setTimeout(() => {
                    try {
                        if (typeof openSchoolDetail === 'function' && typeof findSchoolByCode === 'function') {
                            const s = findSchoolByCode(code);
                            if (s) { openSchoolDetail(s); return; }
                        }
                        const row = Array.from(document.querySelectorAll('#schoolTbody tr'))
                            .find((tr) => (tr.textContent || '').includes(code));
                        if (row && row.querySelector('.btn-manage')) row.querySelector('.btn-manage').click();
                        else showNotice(`未在当前列表中找到 ${code}，请滚动或刷新`, 'warn');
                    } catch (e) { showNotice('跳转失败：' + e.message, 'error'); }
                }, 80);
            });
        });
        listEl.querySelectorAll('.btn-recycle-archive').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const code = btn.dataset.code;
                if (!confirm(`即将清理 ${code} 的回收站档案行。\n\n该校 schema 已被 DROP，无可逆影响。确定继续？`)) return;
                try {
                    const resp = await adminFetch(`/api/admin/recycle-bin/${id}/archive`, { method: 'DELETE' });
                    const data = await resp.json();
                    if (!resp.ok) throw new Error(data.error || '归档失败');
                    showNotice(data.message || '✅ 已归档清理', 'success');
                    loadRecycleBin();
                } catch (e) {
                    showNotice('❌ ' + e.message, 'error');
                }
            });
        });
        listEl.querySelectorAll('.btn-recycle-redelete').forEach((btn) => {
            btn.addEventListener('click', () => {
                const code = btn.dataset.code;
                if (!code) return;
                showNotice('请在「学校管理」列表选中该校 → 操作列的「删除」按钮即可触发彻底删除（不再经回收站）。', 'info');
                switchSchoolsSubview && switchSchoolsSubview('list');
            });
        });
    } catch (e) {
        listEl.innerHTML = `<p class="text-sm text-red-500">❌ ${escapeHtml(e.message)}</p>`;
    }
}

function bindRecycleBinControls() {
    // 「回收站」入口已改由左侧二级菜单（subview=recycle）驱动；
    // 此处仅保留面板内「关闭」按钮 → 返回学校列表。
    const closeBtn = document.getElementById('btnCloseRecycleBin');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => switchSchoolsSubview('list'));
    }
}
