/**
 * 「备份运维」视图（P-Refactor：从 adminSidebar.js 机械迁移）。
 *
 * 两个子视图：
 *   1. 全部备份（all）：KPI 卡（总数/已验证/失败/最近）+ 列表 + 分页 + 立即备份
 *   2. 按学校（by-school）：学校下拉 → 该校备份列表 + 单校备份 + 分页
 *
 * 恢复走确认模态（输入 RESTORE 才可执行，对齐 deleteFiles 二次确认规范 RK-35）；
 * 下载支持 AES 加密包与明文两种格式。
 *
 * 迁移改动（仅依赖注入，无行为变化）：
 *   - bkFetch / bkEnsureSchoolsLoaded / bkAction 中 window.authService + window.getApiBaseUrl
 *     样板 → context.js 的 adminFetch / getApiBase / getAuthToken
 *   - 删除 window.switchBackupSubview 暴露（改由 initBackupView() 返回值注入 sidebar）
 */
import { adminFetch, getApiBase, getAuthToken } from '../context.js';
import { escapeHtml } from '../ui.js';

export function initBackupView() {
        // ============================================================
        // 「备份运维」内嵌实现（全部 / 按学校）—— 直接调 /api/admin/backups
        // ============================================================
        const BACKUP_PAGE_SIZE = 15;
        const bkState = { all: { page: 1, total: 0 }, bySchool: { page: 1, total: 0 } };
        let bkSchoolsLoaded = false;

        function bkFetch(path, opts = {}) {
            return adminFetch('/api/admin/backups' + path, opts);
        }

        function bkFmtSize(n) {
            if (n == null) return '-';
            const num = Number(n);
            if (isNaN(num) || num <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.min(units.length - 1, Math.floor(Math.log(num) / Math.log(1024)));
            return (num / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
        }

        function bkFmtTime(s) {
            if (!s) return '-';
            try { return new Date(s).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return String(s); }
        }

        function bkStatusBadge(s) {
            const t = String(s || '');
            if (t === 'pass' || t === 'verified') {
                return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs"><i class="fas fa-check"></i>已验证</span>';
            }
            if (t === 'fail' || t === 'failed') {
                return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs"><i class="fas fa-times"></i>失败</span>';
            }
            if (t === 'pending' || t === 'running') {
                return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full text-xs"><i class="fas fa-clock"></i>' + escapeHtml(t) + '</span>';
            }
            return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs">' + escapeHtml(t || '-') + '</span>';
        }

        function bkRowTpl(r, withSchool) {
            const id = String(r.id || '');
            const size = bkFmtSize(r.fileSize);
            const verified = bkStatusBadge(r.verifyStatus || r.status);
            const download = `
                <button class="text-blue-600 hover:underline" data-act="download-enc" data-id="${id}"><i class="fas fa-lock mr-1"></i>AES</button>
                <button class="ml-3 text-blue-600 hover:underline" data-act="download-plain" data-id="${id}"><i class="fas fa-file mr-1"></i>明文</button>`;
            return `
                <tr>
                    <td class="px-3 py-2 text-gray-700 whitespace-nowrap">${escapeHtml(bkFmtTime(r.createdAt))}</td>
                    ${withSchool ? `<td class="px-3 py-2"><span class="inline-flex px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs">${escapeHtml(String(r.scope || 'all'))}</span></td><td class="px-3 py-2 font-mono text-gray-800">${escapeHtml(String(r.schoolCode || '-'))}</td>` : `<td class="px-3 py-2"><span class="inline-flex px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full text-xs">${escapeHtml(String(r.scope || 'all'))}</span></td>`}
                    <td class="px-3 py-2 text-gray-600">${escapeHtml(size)}</td>
                    <td class="px-3 py-2">${verified}</td>
                    <td class="px-3 py-2 text-right whitespace-nowrap">
                        <button class="text-sm text-blue-600 hover:underline" data-act="verify" data-id="${id}">验证</button>
                        <span class="mx-1 text-gray-300">|</span>
                        ${download}
                        <span class="mx-1 text-gray-300">|</span>
                        <button class="text-sm text-red-600 hover:underline" data-act="restore" data-id="${id}" data-code="${escapeHtml(String(r.schoolCode || ''))}">恢复</button>
                    </td>
                </tr>`;
        }

        function bkUpdatePager(prefix, total) {
            const st = bkState[prefix === 'All' ? 'all' : 'bySchool'];
            const page = st.page;
            const pageSize = BACKUP_PAGE_SIZE;
            const totalPages = Math.max(1, Math.ceil(total / pageSize));
            const pager = document.getElementById('bkPager' + prefix);
            const prev = document.getElementById('bkPrev' + prefix);
            const next = document.getElementById('bkNext' + prefix);
            if (pager) pager.textContent = `第 ${page}/${totalPages} 页  · 共 ${total} 条`;
            if (prev) prev.disabled = page <= 1;
            if (next) next.disabled = page >= totalPages;
        }

        async function bkLoadAll() {
            const tbody = document.getElementById('bkListAll');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-400 py-6">加载中…</td></tr>';
            const page = bkState.all.page;
            try {
                const res = await bkFetch(`?page=${page}&pageSize=${BACKUP_PAGE_SIZE}`);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                const list = j.data || [];
                bkState.all.total = j.total || 0;
                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-400 py-6">暂无备份</td></tr>';
                    bkUpdatePager('All', 0);
                    bkRefreshKpi([]);
                    return;
                }
                tbody.innerHTML = list.map((r) => bkRowTpl(r, true)).join('');
                bkUpdatePager('All', bkState.all.total);
                bkRefreshKpi(list);
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center text-red-500 py-6">加载失败：${escapeHtml(String(e.message || e))}</td></tr>`;
            }
        }

        async function bkLoadBySchool(schoolCode) {
            const tbody = document.getElementById('bkListBySchool');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-400 py-6">加载中…</td></tr>';
            const page = bkState.bySchool.page;
            try {
                const res = await bkFetch(`?schoolCode=${encodeURIComponent(schoolCode)}&page=${page}&pageSize=${BACKUP_PAGE_SIZE}`);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                const list = j.data || [];
                bkState.bySchool.total = j.total || 0;
                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-400 py-6">该学校暂无备份</td></tr>';
                    bkUpdatePager('Sch', 0);
                    return;
                }
                tbody.innerHTML = list.map((r) => {
                    const id = String(r.id || '');
                    return `
                        <tr>
                            <td class="px-3 py-2 text-gray-700 whitespace-nowrap">${escapeHtml(bkFmtTime(r.createdAt))}</td>
                            <td class="px-3 py-2 text-gray-600">${escapeHtml(bkFmtSize(r.fileSize))}</td>
                            <td class="px-3 py-2">${bkStatusBadge(r.verifyStatus || r.status)}</td>
                            <td class="px-3 py-2 text-right whitespace-nowrap">
                                <button class="text-sm text-blue-600 hover:underline" data-act="verify" data-id="${id}">验证</button>
                                <span class="mx-1 text-gray-300">|</span>
                                <button class="text-sm text-blue-600 hover:underline" data-act="download-enc" data-id="${id}"><i class="fas fa-lock mr-1"></i>AES</button>
                                <button class="ml-3 text-blue-600 hover:underline" data-act="download-plain" data-id="${id}"><i class="fas fa-file mr-1"></i>明文</button>
                                <span class="mx-1 text-gray-300">|</span>
                                <button class="text-sm text-red-600 hover:underline" data-act="restore" data-id="${id}" data-code="${escapeHtml(schoolCode)}">恢复</button>
                            </td>
                        </tr>`;
                }).join('');
                bkUpdatePager('Sch', bkState.bySchool.total);
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="4" class="text-center text-red-500 py-6">加载失败：${escapeHtml(String(e.message || e))}</td></tr>`;
            }
        }

        function bkRefreshKpi(list) {
            try {
                const total = bkState.all.total || list.length;
                const verified = list.filter((r) => ['pass', 'verified'].includes(String(r.verifyStatus || ''))).length;
                const failed = list.filter((r) => {
                    const s = String(r.verifyStatus || r.status || '');
                    return ['fail', 'failed', 'pending', 'running'].includes(s);
                }).length;
                const latest = list.length ? list[0] : null;
                const elT = document.getElementById('bkKpiTotal');
                const elV = document.getElementById('bkKpiVerified');
                const elF = document.getElementById('bkKpiFailed');
                const elL = document.getElementById('bkKpiLatest');
                if (elT) elT.textContent = total;
                if (elV) elV.textContent = verified;
                if (elF) elF.textContent = failed;
                if (elL) elL.textContent = latest ? bkFmtTime(latest.createdAt) : '-';
            } catch (_) { /* 静默 */ }
        }

        async function bkEnsureSchoolsLoaded() {
            const sel = document.getElementById('bkSchoolSelect');
            if (!sel) return;
            if (bkSchoolsLoaded && sel.options.length > 1) return;
            try {
                const res = await adminFetch('/api/admin/schools?limit=200');
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                const list = j.data?.schools || j.schools || j.data || [];
                if (Array.isArray(list)) {
                    list.forEach((s) => {
                        const opt = document.createElement('option');
                        opt.value = s.code || s.schoolCode || s.id;
                        opt.textContent = `${s.code || ''} - ${s.fullName || s.full_name || s.shortName || s.short_name || ''}`;
                        sel.appendChild(opt);
                    });
                    bkSchoolsLoaded = true;
                }
            } catch (e) {
                console.warn('[bk] 加载学校列表失败:', e);
            }
        }

        // 子视图切换
        function switchBackupSubview(subName) {
            document.querySelectorAll('#adminViewBackup .admin-subview').forEach((s) => {
                s.classList.toggle('hidden', s.getAttribute('data-subview') !== subName);
            });
            document.querySelectorAll('[data-subnav="backup"] .admin-sidebar__subitem[data-subview]').forEach((s) => {
                s.classList.toggle('active', s.getAttribute('data-subview') === subName);
            });
            if (subName === 'all') {
                bkLoadAll();
            } else if (subName === 'by-school') {
                bkEnsureSchoolsLoaded();
            }
        }

        // 操作按钮：全部 / 单校的复合事件委托
        async function bkAction(act, id, extra) {
            try {
                if (act === 'verify') {
                    const res = await bkFetch(`/${id}/verify`, { method: 'POST' });
                    const j = await res.json();
                    if (res.ok && j.success) {
                        alert('验证完成 ✅\n\n' + (j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n'));
                    } else {
                        alert('验证失败 ❌\n\n' + ((j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || j.error));
                    }
                    if (document.getElementById('adminViewBackup') && !document.getElementById('adminViewBackup').classList.contains('hidden')) {
                        bkReloadCurrent();
                    }
                } else if (act === 'download-enc' || act === 'download-plain') {
                    const fmt = act === 'download-enc' ? 'encrypted' : 'plain';
                    const url = `${getApiBase()}/api/admin/backups/${id}/download?format=${fmt}`;
                    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + getAuthToken() } });
                    if (!r.ok) {
                        const j = await r.json().catch(() => ({}));
                        throw new Error(j.error || `HTTP ${r.status}`);
                    }
                    const blob = await r.blob();
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `backup-${id}.${fmt === 'encrypted' ? 'aes' : 'sql.gz'}`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                } else if (act === 'run-all') {
                    if (!confirm('立即备份所有学校？这会创建一份新的备份记录。')) return;
                    const res = await bkFetch('/run', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
                    const j = await res.json();
                    if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
                    alert(`备份完成 ✅ 文件：${j.data?.file || '-'}`);
                    bkLoadAll();
                } else if (act === 'run-single') {
                    const code = extra || '';
                    if (!code) return;
                    if (!confirm(`立即备份学校 ${code}？`)) return;
                    const res = await bkFetch('/run', { method: 'POST', body: JSON.stringify({ scope: 'single', schoolCode: code }) });
                    const j = await res.json();
                    if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
                    alert(`备份完成 ✅ 文件：${j.data?.file || '-'}`);
                    bkLoadBySchool(code);
                } else if (act === 'restore') {
                    bkOpenRestore(id, extra);
                }
            } catch (e) {
                alert('操作失败：' + (e.message || e));
            }
        }
        function bkReloadCurrent() {
            const active = document.querySelector('#adminViewBackup .admin-subview:not(.hidden)');
            if (!active) return;
            const sub = active.getAttribute('data-subview');
            if (sub === 'all') bkLoadAll();
            if (sub === 'by-school') {
                const code = document.getElementById('bkSchoolSelect').value;
                if (code) bkLoadBySchool(code);
            }
        }

        // 模态
        let bkRestoreTarget = null;
        function bkOpenRestore(id, schoolCode) {
            bkRestoreTarget = { id, schoolCode };
            const modal = document.getElementById('bkRestoreModal');
            const input = document.getElementById('bkRestoreConfirm');
            const doBtn = document.getElementById('bkRestoreDo');
            if (input) { input.value = ''; }
            if (doBtn) doBtn.disabled = true;
            if (modal) modal.classList.remove('hidden');
            setTimeout(() => { try { input.focus(); } catch (_) { /* 部分浏览器可能拦截聚焦 */ } }, 50);
        }
        function bkCloseRestore() {
            const modal = document.getElementById('bkRestoreModal');
            if (modal) modal.classList.add('hidden');
            bkRestoreTarget = null;
        }

        // 按钮绑定
        document.getElementById('bkRefreshAll')?.addEventListener('click', bkLoadAll);
        document.getElementById('bkRunAll')?.addEventListener('click', () => bkAction('run-all'));
        document.getElementById('bkPrevAll')?.addEventListener('click', () => {
            if (bkState.all.page > 1) { bkState.all.page--; bkLoadAll(); }
        });
        document.getElementById('bkNextAll')?.addEventListener('click', () => {
            const max = Math.ceil(bkState.all.total / BACKUP_PAGE_SIZE);
            if (bkState.all.page < max) { bkState.all.page++; bkLoadAll(); }
        });

        document.getElementById('bkSchoolSelect')?.addEventListener('change', (e) => {
            const code = e.target.value;
            const addBtn = document.getElementById('bkRunSingle');
            if (addBtn) addBtn.disabled = !code;
            if (code) {
                bkState.bySchool.page = 1;
                bkLoadBySchool(code);
            } else {
                const tbody = document.getElementById('bkListBySchool');
                if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-400 py-6">请先选择学校</td></tr>';
                bkUpdatePager('Sch', 0);
            }
        });
        document.getElementById('bkRunSingle')?.addEventListener('click', () => {
            const code = document.getElementById('bkSchoolSelect').value;
            bkAction('run-single', null, code);
        });
        document.getElementById('bkPrevSch')?.addEventListener('click', () => {
            const code = document.getElementById('bkSchoolSelect').value;
            if (code && bkState.bySchool.page > 1) { bkState.bySchool.page--; bkLoadBySchool(code); }
        });
        document.getElementById('bkNextSch')?.addEventListener('click', () => {
            const code = document.getElementById('bkSchoolSelect').value;
            const max = Math.ceil(bkState.bySchool.total / BACKUP_PAGE_SIZE);
            if (code && bkState.bySchool.page < max) { bkState.bySchool.page++; bkLoadBySchool(code); }
        });

        // 列表内操作（事件委托）：两个列表共用同一处理
        ['bkListAll', 'bkListBySchool'].forEach((id) => {
            document.getElementById(id)?.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-act]');
                if (!btn) return;
                bkAction(btn.getAttribute('data-act'), btn.getAttribute('data-id'), btn.getAttribute('data-code'));
            });
        });

        // 模态按钮
        document.getElementById('bkRestoreClose')?.addEventListener('click', bkCloseRestore);
        document.getElementById('bkRestoreCancel')?.addEventListener('click', bkCloseRestore);
        document.getElementById('bkRestoreConfirm')?.addEventListener('input', (e) => {
            const doBtn = document.getElementById('bkRestoreDo');
            if (doBtn) doBtn.disabled = e.target.value.trim() !== 'RESTORE';
        });
        document.getElementById('bkRestoreDo')?.addEventListener('click', async () => {
            if (!bkRestoreTarget) return;
            const { id, schoolCode } = bkRestoreTarget;
            try {
                const res = await bkFetch(`/${id}/restore`, { method: 'POST', body: JSON.stringify({ schoolCode }) });
                const j = await res.json();
                if (res.ok && j.success) {
                    alert('恢复完成 ✅\n\n' + (j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n'));
                    bkCloseRestore();
                    bkReloadCurrent();
                } else {
                    alert('恢复失败 ❌\n\n' + ((j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || j.error));
                }
            } catch (e) {
                alert('恢复异常：' + (e.message || e));
            }
        });

        return { switchBackupSubview };
}
