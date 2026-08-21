// 文件路径: js/modules/BackupRestore.js
// 学校租户内的「数据备份与恢复」模块（TD-School-Backup-Sync 第⑦轮）。
//
// 与超管界面（js/modules/adminSchools/views/backupView.js）保持 UI 一致：
//   KPI 卡（总数/已验证/失败/最近）+ 备份列表 + 分页 + 立即备份 +
//   验证 / AES+明文下载 / 影子恢复（RESTORE 确认模态）。
//
// 唯一区别：所有接口走 /api/school/backups（强制本校隔离），不能跨校。
// 旧实现（localStorage 下载上传 / 云端同步 5 张表）已废弃——cvm 备份体系下，
// 浏览器缓存的导出/导入语义本身就在 cvm cvm 备份范畴之外，本模块整体替换。
import { UINotification } from '../utils/UINotification.js';
import { extractSchoolCode } from '../utils/schoolCode.js';
import { authService } from '../services/AuthService.js';
import { auditService } from '../services/AuditService.js';
import { escapeHtml } from '../utils/schoolCustomization/shared.js';

const BACKUP_PAGE_SIZE = 15;

export class BackupRestoreService {
    constructor() {
        this.moduleName = '数据备份与恢复';
        this._abortCtrl = null;
        this._page = 1;
        this._total = 0;
        this._runIdInFlight = null;
    }

    init() {
        // TD-EventLeak-Phase2：重新初始化先取消上一次监听
        this._abortCtrl?.abort();
        this._abortCtrl = new AbortController();
        this.renderUI();
        this.bindEvents();
        this.loadList();
    }

    destroy() {
        this._abortCtrl?.abort();
        this._abortCtrl = null;
    }

    // ── 视图 ──────────────────────────────────────────────
    renderUI() {
        const content = document.getElementById('backup-restore');
        if (!content) {
            console.error('未找到 id="backup-restore" 的容器，请检查 index.html');
            return;
        }
        const code = extractSchoolCode() || '';
        content.innerHTML = `
            <div class="space-y-4">
                <div class="glass p-6">
                    <div class="flex items-center justify-between mb-4 border-b pb-2">
                        <h2 class="text-2xl font-bold flex items-center">
                            <i class="fas fa-shield-alt text-blue-600 mr-2"></i>数据备份与恢复
                            ${code ? `<span class="ml-2 inline-flex items-center px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs font-mono"><i class="fas fa-school mr-1"></i>${escapeHtml(code)}</span>` : ''}
                        </h2>
                        <div class="flex items-center gap-2">
                            <button id="bkRunNow" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm flex items-center disabled:opacity-50 disabled:cursor-not-allowed">
                                <i class="fas fa-play mr-1"></i> 立即备份
                            </button>
                            <button id="bkRefresh" class="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded hover:bg-gray-50 text-sm flex items-center">
                                <i class="fas fa-sync mr-1"></i> 刷新
                            </button>
                        </div>
                    </div>
                    <div class="bg-blue-50 border border-blue-200 p-4 rounded text-sm text-blue-800">
                        每日 02:00 自动全库备份由平台统一执行（<code class="bg-blue-100 px-1 rounded">systemd timer</code>）；
                        列表中的「全库」备份对全校可见，但只能用于<b>本校恢复</b>（服务端仅提取本校数据段，不触及其它学校）。
                        学校管理员可手动触发本校单校备份、验证、下载（AES 加密包 / 受控明文）以及紧急恢复。
                        恢复为影子恢复（先写临时 schema 校验通过后再原子切换），恢复过程必须输入确认词
                        <code class="bg-blue-100 px-1 rounded">RESTORE</code>。
                    </div>
                </div>

                <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div class="glass p-5">
                        <div class="text-sm text-gray-500">备份总数</div>
                        <div class="text-2xl font-bold text-gray-800 mt-1" id="bkKpiTotal">0</div>
                        <div class="text-xs text-gray-400 mt-1">含手动与定时</div>
                    </div>
                    <div class="glass p-5">
                        <div class="text-sm text-gray-500">已验证通过</div>
                        <div class="text-2xl font-bold text-green-600 mt-1" id="bkKpiVerified">0</div>
                        <div class="text-xs text-gray-400 mt-1">verify_status=passed</div>
                    </div>
                    <div class="glass p-5">
                        <div class="text-sm text-gray-500">失败 / 待验证</div>
                        <div class="text-2xl font-bold text-red-600 mt-1" id="bkKpiFailed">0</div>
                        <div class="text-xs text-gray-400 mt-1">verify_status=failed/pending</div>
                    </div>
                    <div class="glass p-5">
                        <div class="text-sm text-gray-500">最近一次</div>
                        <div class="text-base font-bold text-gray-800 mt-1" id="bkKpiLatest">-</div>
                        <div class="text-xs text-gray-400 mt-1">本地时间</div>
                    </div>
                </div>

                <div class="glass p-6">
                    <div class="flex items-center justify-between mb-4 border-b pb-2">
                        <h3 class="text-lg font-bold flex items-center">
                            <i class="fas fa-list text-blue-600 mr-2"></i>本校备份列表
                        </h3>
                        <div class="text-sm text-gray-500">
                            <span id="bkPager">第 1/1 页 · 共 0 条</span>
                        </div>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead>
                                <tr class="border-b text-left text-gray-500">
                                    <th class="px-3 py-2">时间</th>
                                    <th class="px-3 py-2">大小</th>
                                    <th class="px-3 py-2">校验</th>
                                    <th class="px-3 py-2">结构兼容</th>
                                    <th class="px-3 py-2">触发</th>
                                    <th class="px-3 py-2 text-right">操作</th>
                                </tr>
                            </thead>
                            <tbody id="bkList" class="text-gray-700">
                                <tr><td colspan="6" class="text-center text-gray-400 py-6">加载中…</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="flex items-center justify-between mt-4">
                        <button id="bkPrev" class="px-3 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed text-sm">
                            <i class="fas fa-chevron-left mr-1"></i>上一页
                        </button>
                        <span class="text-sm text-gray-500" id="bkPagerBottom">第 1/1 页 · 共 0 条</span>
                        <button id="bkNext" class="px-3 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed text-sm">
                            下一页<i class="fas fa-chevron-right ml-1"></i>
                        </button>
                    </div>
                </div>

                <!-- 恢复确认模态 -->
                <div id="bkRestoreModal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <div class="bg-white rounded-xl shadow-2xl p-6 w-[28rem] max-w-[90vw]">
                        <div class="flex items-center justify-between mb-4 border-b pb-3">
                            <h3 class="text-lg font-bold text-gray-800 flex items-center">
                                <i class="fas fa-exclamation-triangle text-red-500 mr-2"></i>确认恢复
                            </h3>
                            <button id="bkRestoreClose" class="text-gray-500 hover:text-gray-700"><i class="fas fa-times"></i></button>
                        </div>
                        <p class="text-sm text-gray-700 leading-relaxed mb-3">
                            即将把所选备份恢复为学校 <code class="bg-gray-100 px-1 rounded font-mono" id="bkRestoreSchoolCode">-</code> 的当前数据。
                            恢复流程采用影子恢复：先在临时 schema 还原并校验，通过后再原子切换，原数据被替换为新数据。
                        </p>
                        <div id="bkRestoreSchemaCompat" class="hidden bg-blue-50 border border-blue-200 text-blue-800 p-3 rounded text-xs mb-4">
                            <i class="fas fa-info-circle mr-1"></i>
                            <span id="bkRestoreSchemaCompatText"></span>
                        </div>
                        <div class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-xs mb-4">
                            <i class="fas fa-skull-crossbones mr-1"></i>
                            <strong>危险操作</strong>：恢复将覆盖当前生产数据；恢复过程中请勿刷新或关闭页面。
                        </div>
                        <label class="block text-sm text-gray-700 mb-1">输入确认词 <code class="bg-gray-100 px-1 rounded font-mono">RESTORE</code> 以启用按钮：</label>
                        <input id="bkRestoreConfirm" type="text" autocomplete="off"
                            class="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:border-blue-500 font-mono"
                            placeholder="RESTORE" />
                        <div class="flex justify-end gap-2 mt-5">
                            <button id="bkRestoreCancel" class="px-4 py-2 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 text-sm">取消</button>
                            <button id="bkRestoreDo" disabled
                                class="px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700 text-sm disabled:opacity-40 disabled:cursor-not-allowed">
                                <i class="fas fa-undo-alt mr-1"></i>立即恢复
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    bindEvents() {
        this._abortCtrl?.abort();
        this._abortCtrl = new AbortController();
        const signal = this._abortCtrl.signal;

        const $ = (id) => document.getElementById(id);

        $('bkRunNow')?.addEventListener('click', () => this.runNow(), { signal });
        $('bkRefresh')?.addEventListener('click', () => this.loadList(), { signal });
        $('bkPrev')?.addEventListener('click', () => {
            if (this._page > 1) { this._page--; this.loadList(); }
        }, { signal });
        $('bkNext')?.addEventListener('click', () => {
            const max = Math.ceil(this._total / BACKUP_PAGE_SIZE);
            if (this._page < max) { this._page++; this.loadList(); }
        }, { signal });

        // 列表内操作（事件委托）
        $('bkList')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.getAttribute('data-act');
            const id = btn.getAttribute('data-id');
            if (act === 'verify') return this.verify(id);
            if (act === 'download-enc' || act === 'download-plain') {
                const fmt = act === 'download-enc' ? 'encrypted' : 'plain';
                return this.download(id, fmt);
            }
            if (act === 'restore') return this.openRestore(id);
        }, { signal });

        // 模态
        $('bkRestoreClose')?.addEventListener('click', () => this.closeRestore(), { signal });
        $('bkRestoreCancel')?.addEventListener('click', () => this.closeRestore(), { signal });
        $('bkRestoreConfirm')?.addEventListener('input', (e) => {
            const v = (e.target.value || '').trim();
            const btn = $('bkRestoreDo');
            if (btn) btn.disabled = v !== 'RESTORE';
        }, { signal });
        $('bkRestoreDo')?.addEventListener('click', () => this.doRestore(), { signal });
    }

    // ── 网络层 ──────────────────────────────────────────────
    /** 按当前学校命名空间读取 token（与 AuthService / Storage 一致）。 */
    _token() {
        const code = extractSchoolCode() || '';
        const adminKey = code ? `auth_token__${code}` : 'auth_token';
        const guestKey = code ? `guest_token__${code}` : 'guest_token';
        // 优先内存态（authService.getToken）；其次命名空间 storage
        try {
            const mem = authService && typeof authService.getToken === 'function' ? authService.getToken() : null;
            if (mem && !String(mem).startsWith('temp-token-')) return mem;
        } catch (_) { /* ignore */ }
        return (
            localStorage.getItem(adminKey) || sessionStorage.getItem(adminKey) ||
            localStorage.getItem(guestKey) || sessionStorage.getItem(guestKey) ||
            null
        );
    }

    async _apiFetch(url, opts = {}) {
        const token = this._token();
        if (!token || String(token).startsWith('temp-token-')) {
            throw new Error('请先登录后再操作');
        }
        const headers = Object.assign(
            { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
            opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {},
            opts.headers || {}
        );
        const body = opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string'
            ? JSON.stringify(opts.body) : opts.body;
        const r = await fetch(url, { method: opts.method || 'GET', headers, body });
        if (!r.ok) {
            let err = `HTTP ${r.status}`;
            try {
                const j = await r.json();
                err = j.error || j.message || err;
            } catch (_) { /* ignore */ }
            const e = new Error(err);
            e.status = r.status;
            throw e;
        }
        // 204 / blob 等
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('application/json')) return r.json();
        return r;
    }

    // ── 列表 / KPI ──────────────────────────────────────────
    async loadList() {
        const tbody = document.getElementById('bkList');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-400 py-6">加载中…</td></tr>';
        try {
            const j = await this._apiFetch(`/api/school/backups?page=${this._page}&pageSize=${BACKUP_PAGE_SIZE}`);
            const list = (j && j.data) || [];
            this._total = (j && j.total) || 0;
            if (!list.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-center text-gray-400 py-6">暂无备份</td></tr>';
                this.refreshKpi([]);
                this.updatePager();
                return;
            }
            tbody.innerHTML = list.map((r) => this.rowTpl(r)).join('');
            this.refreshKpi(list);
            this.updatePager();
        } catch (e) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-red-500 py-6">加载失败：${escapeHtml(e.message || String(e))}</td></tr>`;
            this.refreshKpi([]);
            this.updatePager();
        }
    }

    rowTpl(r) {
        const id = String(r.id || '');
        const size = fmtSize(r.fileSize);
        const verified = fmtVerify(r.verifyStatus || r.status);
        // 手动/定时区分：run_type 恒为 scheduled_*（backupService.js），手动触发信息在
        // created_by（后端拼接 "manual_<username>@<school>"），只能以 createdBy 判断。
        const trigger = /manual_/i.test(r.createdBy || '') ? '手动' : '定时';
        // 方案B：全库备份（scope=all）记录现在对学校可见——
        //   - 显示"全库"徽章；恢复走服务端 extractSchemaSegment 只提取本校段；
        //   - 下载一律隐藏（后端 403：全库文件含其他学校数据，学校侧禁止下载）。
        const isAll = String(r.scope || '') === 'all';
        const scopeBadge = isAll
            ? '<span class="inline-flex items-center px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs"><i class="fas fa-database mr-1"></i>全库</span>'
            : `<span class="inline-flex items-center px-2 py-0.5 bg-gray-100 text-gray-700 rounded-full text-xs">${escapeHtml(trigger)}</span>`;
        const compat = fmtSchemaCompat(r);
        const compatSummary = escapeHtml(r.schemaCompatSummary || (compat.label === '无快照' ? '无结构快照' : compat.label));
        const downloadBtns = isAll ? '' : `
                    <button class="text-sm text-blue-600 hover:underline" data-act="download-enc" data-id="${escapeHtml(id)}"><i class="fas fa-lock mr-1"></i>AES</button>
                    <button class="ml-2 text-sm text-blue-600 hover:underline" data-act="download-plain" data-id="${escapeHtml(id)}"><i class="fas fa-file mr-1"></i>明文</button>`;
        return `
            <tr class="border-b hover:bg-gray-50">
                <td class="px-3 py-2 text-gray-700 whitespace-nowrap">${escapeHtml(fmtTime(r.createdAt))}</td>
                <td class="px-3 py-2 text-gray-600">${escapeHtml(size)}</td>
                <td class="px-3 py-2">${verified}</td>
                <td class="px-3 py-2">${compat.badge}</td>
                <td class="px-3 py-2">${scopeBadge}</td>
                <td class="px-3 py-2 text-right whitespace-nowrap">
                    <button class="text-sm text-blue-600 hover:underline" data-act="verify" data-id="${escapeHtml(id)}">验证</button>
                    <span class="mx-1 text-gray-300">|</span>
                    ${downloadBtns}
                    ${isAll ? '' : '<span class="mx-1 text-gray-300">|</span>'}
                    <button class="text-sm text-red-600 hover:underline" data-act="restore" data-id="${escapeHtml(id)}" data-compat-summary="${compatSummary}">恢复</button>
                </td>
            </tr>`;
    }

    refreshKpi(list) {
        const verified = list.filter((r) => ['pass', 'verified', 'passed'].includes(String(r.verifyStatus || ''))).length;
        const failed = list.filter((r) => {
            const s = String(r.verifyStatus || r.status || '');
            return ['fail', 'failed', 'pending', 'running'].includes(s);
        }).length;
        const latest = list.length ? list[0] : null;
        const elT = document.getElementById('bkKpiTotal');
        const elV = document.getElementById('bkKpiVerified');
        const elF = document.getElementById('bkKpiFailed');
        const elL = document.getElementById('bkKpiLatest');
        if (elT) elT.textContent = String(this._total || list.length || 0);
        if (elV) elV.textContent = String(verified);
        if (elF) elF.textContent = String(failed);
        if (elL) elL.textContent = latest ? fmtTime(latest.createdAt) : '-';
    }

    updatePager() {
        const totalPages = Math.max(1, Math.ceil(this._total / BACKUP_PAGE_SIZE));
        const txt = `第 ${this._page}/${totalPages} 页 · 共 ${this._total} 条`;
        const a = document.getElementById('bkPager'); if (a) a.textContent = txt;
        const b = document.getElementById('bkPagerBottom'); if (b) b.textContent = txt;
        const prev = document.getElementById('bkPrev'); if (prev) prev.disabled = this._page <= 1;
        const next = document.getElementById('bkNext'); if (next) next.disabled = this._page >= totalPages;
    }

    // ── 操作 ───────────────────────────────────────────────
    async runNow() {
        const btn = document.getElementById('bkRunNow');
        if (this._runIdInFlight) return;
        if (btn) btn.disabled = true;
        this._runIdInFlight = true;
        try {
            const j = await this._apiFetch('/api/school/backups/run', { method: 'POST', body: {} });
            UINotification.success(`✅ 备份完成：${(j && j.data && j.data.file) || '-'}`);
            try {
                await auditService.log('export', 'system', 'backup', `手动触发本校单校备份：${(j && j.data && j.data.file) || ''}`);
            } catch (_) { /* 审计失败不阻断主流程 */ }
            this._page = 1;
            await this.loadList();
        } catch (e) {
            UINotification.error(`❌ 备份失败：${e.message || e}`);
        } finally {
            this._runIdInFlight = false;
            if (btn) btn.disabled = false;
        }
    }

    async verify(id) {
        try {
            const j = await this._apiFetch(`/api/school/backups/${encodeURIComponent(id)}/verify`, { method: 'POST', body: {} });
            const ok = j && j.success;
            const compatLine = j.schemaCompatSummary ? `结构兼容：${j.schemaCompatSummary}` : '';
            const lines = ((j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || (j.error || '无附加信息')) + (compatLine ? `\n${compatLine}` : '');
            if (ok) {
                UINotification.success(`验证完成 ✅\n${lines}`);
            } else {
                UINotification.error(`验证失败 ❌\n${lines}`);
            }
            try { await auditService.log(ok ? 'export' : 'import', 'system', 'backup', `校验备份 ${id}: ${ok ? '通过' : '失败'}`); } catch (e) { console.warn('[BackupRestore] 审计写入失败（verify）:', e && e.message ? e.message : e); }
            await this.loadList();
        } catch (e) {
            UINotification.error(`验证异常：${e.message || e}`);
        }
    }

    async download(id, format) {
        try {
            const token = this._token();
            if (!token) throw new Error('请先登录');
            const url = `/api/school/backups/${encodeURIComponent(id)}/download?format=${format}`;
            const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            if (!r.ok) {
                let msg = `HTTP ${r.status}`;
                try { const j = await r.json(); msg = j.error || j.message || msg; } catch (e) { console.warn('[BackupRestore] 解析错误响应失败:', e && e.message ? e.message : e); }
                throw new Error(msg);
            }
            const blob = await r.blob();
            const a = document.createElement('a');
            const objectUrl = URL.createObjectURL(blob);
            a.href = objectUrl;
            a.download = `backup-${id}.${format === 'encrypted' ? 'aes' : 'sql.gz'}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
            try { await auditService.log('export', 'system', 'backup', `下载备份 ${id}（${format}）`); } catch (e) { console.warn('[BackupRestore] 审计写入失败（download）:', e && e.message ? e.message : e); }
        } catch (e) {
            UINotification.error(`下载失败：${e.message || e}`);
        }
    }

    // ── 恢复模态 ───────────────────────────────────────────
    _restoreTarget = null;
    openRestore(id) {
        this._restoreTarget = id;
        const code = extractSchoolCode() || '-';
        const codeEl = document.getElementById('bkRestoreSchoolCode');
        if (codeEl) codeEl.textContent = code;
        const input = document.getElementById('bkRestoreConfirm');
        const doBtn = document.getElementById('bkRestoreDo');
        if (input) input.value = '';
        if (doBtn) doBtn.disabled = true;
        // 显示结构兼容提示
        const triggerBtn = document.querySelector(`button[data-act="restore"][data-id="${CSS.escape(id)}"]`);
        const compatSummary = triggerBtn ? triggerBtn.getAttribute('data-compat-summary') : '';
        const compatBox = document.getElementById('bkRestoreSchemaCompat');
        const compatText = document.getElementById('bkRestoreSchemaCompatText');
        if (compatBox && compatText) {
            if (compatSummary) {
                compatText.textContent = compatSummary;
                compatBox.classList.remove('hidden');
            } else {
                compatBox.classList.add('hidden');
            }
        }
        const modal = document.getElementById('bkRestoreModal');
        if (modal) modal.classList.remove('hidden');
        setTimeout(() => { try { input && input.focus(); } catch (e) { console.warn('[BackupRestore] input.focus 失败:', e && e.message ? e.message : e); } }, 50);
    }
    closeRestore() {
        const modal = document.getElementById('bkRestoreModal');
        if (modal) modal.classList.add('hidden');
        this._restoreTarget = null;
    }
    async doRestore() {
        if (!this._restoreTarget) return;
        const id = this._restoreTarget;
        const doBtn = document.getElementById('bkRestoreDo');
        if (doBtn) doBtn.disabled = true;
        try {
            const j = await this._apiFetch(`/api/school/backups/${encodeURIComponent(id)}/restore`, {
                method: 'POST',
                body: { confirmText: 'RESTORE' },
            });
            const ok = j && j.success;
            const compatLine = j.schemaCompatSummary ? `结构兼容：${j.schemaCompatSummary}` : '';
            const lines = ((j.checks || []).map(([k, v]) => `${k}: ${v}`).join('\n') || (j.error || '无附加信息')) + (compatLine ? `\n${compatLine}` : '');
            if (ok) {
                UINotification.success(`恢复完成 ✅\n${lines}`);
            } else {
                UINotification.error(`恢复失败 ❌\n${lines}`);
            }
            try { await auditService.log('import', 'system', 'backup', `${ok ? '恢复' : '失败恢复'} 备份 ${id}`); } catch (e) { console.warn('[BackupRestore] 审计写入失败（restore）:', e && e.message ? e.message : e); }
            this.closeRestore();
            await this.loadList();
        } catch (e) {
            UINotification.error(`恢复异常：${e.message || e}`);
        } finally {
            if (doBtn) doBtn.disabled = false;
        }
    }
}

// ── 工具 ────────────────────────────────────────────────
function fmtSize(n) {
    if (n == null) return '-';
    const num = Number(n);
    if (!isFinite(num) || num <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(num) / Math.log(1024)));
    return (num / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function fmtTime(s) {
    if (!s) return '-';
    try { return new Date(s).toLocaleString('zh-CN', { hour12: false }); } catch (_) { return String(s); }
}

function fmtVerify(s) {
    const t = String(s || '');
    if (['pass', 'verified', 'passed'].includes(t)) {
        return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs"><i class="fas fa-check"></i>已验证</span>';
    }
    if (['fail', 'failed'].includes(t)) {
        return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-xs"><i class="fas fa-times"></i>失败</span>';
    }
    if (['pending', 'running'].includes(t)) {
        return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full text-xs"><i class="fas fa-clock"></i>' + escapeHtml(t) + '</span>';
    }
    return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs">' + escapeHtml(t || '-') + '</span>';
}

function fmtSchemaCompat(r) {
    if (r.schemaCompatible === true) {
        return {
            label: '结构一致',
            badge: '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs"><i class="fas fa-check"></i>结构一致</span>'
        };
    }
    if (r.schemaCompatible === false) {
        return {
            label: '结构偏旧',
            badge: '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-orange-100 text-orange-700 rounded-full text-xs"><i class="fas fa-exclamation-triangle"></i>结构偏旧</span>'
        };
    }
    return {
        label: '无快照',
        badge: '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs">无快照</span>'
    };
}
