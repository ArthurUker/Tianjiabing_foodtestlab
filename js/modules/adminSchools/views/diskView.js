/*
* 磁盘管理视图（2026-08-27 容量策略配套；v2 批量筛选删除）
* ------------------------------------------------------------
* 控制台左侧「磁盘管理」入口：数据盘/系统盘水位、journal、日志文件、按天备份的
* 查看与人工清理（所有数据不再被上限机制自动删除，清理动作一律人工触发+审计）。
*
* v2 批量能力（用户反馈：逐条勾选太麻烦）：
*   - 日志：按来源（应用/rsyslog）、状态（活跃/轮转）、时间范围（快捷 7/30 天或自定义起止）
*           筛选；支持"全选筛选结果 / 清除筛选选择"，批量删除
*   - 备份：按年筛选、按月分组（全选本月/删除本月）、多选天、删除所选天
*     （批量删除走 days[] 数组端点，一次请求；月/范围删除=前端换算成天数集合）
*
* 后端：/api/admin/disk/*（super_admin；变更操作写 AdminOpsLog 审计）
*/

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(n) {
    if (n == null || isNaN(n)) return '-';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtTime(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayStr(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function usageColor(pct) {
    if (pct >= 90) return 'text-red-600';
    if (pct >= 70) return 'text-amber-600';
    return 'text-emerald-600';
}

export function initDiskView({ API_BASE, authHeaders, notify }) {
    // 状态：筛选条件 + 选择集（选择集跨筛选变化保留，删除按当前选择执行）
    const state = {
        logs: [],                        // 统一日志条目 {path,size,mtime,rotated,group}
        f: { group: 'all', status: 'all', from: '', to: '' },
        selLogs: new Set(),              // 日志路径选择
        selDays: new Set(),              // 备份天选择
        backupDays: [],                  // [{day,size,count}]
    };

    async function api(path, opts = {}) {
        const resp = await fetch(`${API_BASE}/api/admin/disk${path}`, {
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
        const root = document.getElementById('adminViewDisk');
        if (!root) return;
        root.innerHTML = `
        <div class="container mx-auto px-4 py-6 max-w-[2000px]">
            <div class="flex items-center justify-between flex-wrap gap-3 mb-4">
                <div>
                    <h2 class="text-xl font-semibold text-gray-800"><i class="fas fa-hdd text-slate-500 mr-2"></i>磁盘管理</h2>
                    <p class="text-xs text-gray-500 mt-1">容量策略：所有数据<b>不会被上限机制自动删除</b>；磁盘使用率 ≥90% 时系统每 10 分钟告警（本地日志 + 安全事件），清理动作一律在此人工触发并写入审计。</p>
                </div>
                <button id="diskRefresh" type="button" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition shadow"><i class="fas fa-sync-alt mr-1"></i>刷新</button>
            </div>

            <div class="admin-kpi-grid mb-4">
                <div class="admin-kpi-card">
                    <div class="admin-kpi-label"><i class="fas fa-database mr-1"></i>数据盘 /mnt/datadisk0</div>
                    <div id="diskKpiData" class="admin-kpi-value">-</div>
                    <div class="admin-kpi-sub">PG 数据 + 备份 + 全部日志所在盘</div>
                </div>
                <div class="admin-kpi-card">
                    <div class="admin-kpi-label"><i class="fas fa-server mr-1"></i>系统盘 /</div>
                    <div id="diskKpiSys" class="admin-kpi-value">-</div>
                    <div class="admin-kpi-sub">代码 + 运行时（无业务数据）</div>
                </div>
                <div class="admin-kpi-card">
                    <div class="admin-kpi-label"><i class="fas fa-file-alt mr-1"></i>journal 大小</div>
                    <div id="diskKpiJournal" class="admin-kpi-value">-</div>
                    <div class="admin-kpi-sub">systemd 日志（可按天收缩）</div>
                </div>
                <div class="admin-kpi-card">
                    <div class="admin-kpi-label"><i class="fas fa-shield-alt mr-1"></i>备份总量</div>
                    <div id="diskKpiBackup" class="admin-kpi-value">-</div>
                    <div class="admin-kpi-sub">AES 加密备份（永久保留，除非在此删除）</div>
                </div>
            </div>

            <div class="admin-card mb-4">
                <div class="flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <h3><i class="fas fa-chart-pie text-slate-500"></i>挂载点水位（告警阈值 90%）</h3>
                        <p class="text-xs text-gray-500">由 /etc/cron.d/disk-usage-alert 每 10 分钟检查；≥90% 写本地告警日志与安全事件（SECURITY:DISK_USAGE）</p>
                    </div>
                </div>
                <div id="diskMounts" class="mt-3 text-sm text-gray-600">加载中…</div>
            </div>

            <div class="admin-card mb-4">
                <div class="flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <h3><i class="fas fa-file-alt text-slate-500"></i>systemd journal
                            <span id="diskJournalSize" class="ml-2 text-base font-normal text-gray-700">-</span>
                        </h3>
                        <p class="text-xs text-gray-500">当前占用如上；收缩为只保留最近 N 天（journalctl --vacuum-time），不涉及业务数据</p>
                    </div>
                    <div class="flex items-center gap-2">
                        <input id="diskJournalDays" type="number" min="1" max="365" value="7" class="w-20 px-2 py-1.5 text-sm border border-gray-300 rounded-lg" />
                        <span class="text-xs text-gray-500">天</span>
                        <button id="diskJournalVacuum" type="button" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"><i class="fas fa-broom mr-1"></i>收缩 journal</button>
                    </div>
                </div>
                <div id="diskJournalOut" class="mt-2 text-xs text-gray-500 font-mono"></div>
            </div>

            <div class="admin-card mb-4">
                <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
                    <div>
                        <h3><i class="fas fa-scroll text-slate-500"></i>日志文件（应用 / rsyslog）</h3>
                        <p class="text-xs text-gray-500">这里是<b>磁盘文件清理</b>：应用日志=单进程多租户混合输出；rsyslog=操作系统级。学校租户的业务审计日志在数据库（AuditLog/SystemLog），不在此处、也绝不从此处删除</p>
                    </div>
                </div>
                <div class="flex items-center flex-wrap gap-2 mb-3 text-sm">
                    <select id="diskLogGroup" class="px-2 py-1.5 border border-gray-300 rounded-lg text-sm">
                        <option value="all">来源：全部</option>
                        <option value="app">来源：应用日志</option>
                        <option value="rsyslog">来源：rsyslog</option>
                    </select>
                    <select id="diskLogStatus" class="px-2 py-1.5 border border-gray-300 rounded-lg text-sm">
                        <option value="all">状态：全部</option>
                        <option value="active">状态：活跃</option>
                        <option value="rotated">状态：轮转/归档</option>
                    </select>
                    <span class="text-gray-400">|</span>
                    <button id="diskLogPreset7" type="button" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">最近 7 天</button>
                    <button id="diskLogPreset30" type="button" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">最近 30 天</button>
                    <input id="diskLogFrom" type="date" class="px-2 py-1.5 border border-gray-300 rounded-lg text-sm" title="开始日期" />
                    <span class="text-gray-400">~</span>
                    <input id="diskLogTo" type="date" class="px-2 py-1.5 border border-gray-300 rounded-lg text-sm" title="结束日期" />
                    <button id="diskLogClearFilter" type="button" class="px-2 py-1 text-xs text-gray-600 hover:text-gray-800 underline">清除筛选</button>
                    <span class="ml-auto flex items-center gap-2">
                        <button id="diskLogSelFiltered" type="button" class="px-2 py-1 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg">全选筛选结果</button>
                        <button id="diskLogSelNone" type="button" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">清除选择</button>
                        <button id="diskLogsDelete" type="button" class="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-40" disabled><i class="fas fa-trash mr-1"></i>删除所选</button>
                    </span>
                </div>
                <div id="diskLogSummary" class="text-xs text-gray-500 mb-2"></div>
                <div id="diskLogFiles" class="text-sm text-gray-600 max-h-[420px] overflow-y-auto">加载中…</div>
            </div>

            <div class="admin-card mb-4">
                <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
                    <div>
                        <h3><i class="fas fa-university text-indigo-500"></i>学校租户业务日志（数据库 AuditLog，逐校统计/导出/删除）</h3>
                        <p class="text-xs text-gray-500">流程：<b>① 选校+截止日期 → 导出留档</b>（JSON Lines 落数据盘 audit-exports/，可下载）→ <b>② 删除</b>（系统校验"已留档到该日期"才允许删；未导出直接拒绝）。适用于磁盘 ≥90% 需释放空间时按校归档清理</p>
                    </div>
                    <div class="flex items-center gap-2 text-sm">
                        <select id="diskAuditSchool" class="px-2 py-1.5 border border-gray-300 rounded-lg"><option value="tjb">tjb（田家炳）</option><option value="zhyz">zhyz（一中）</option><option value="zhsy">zhsy（实验）</option></select>
                        <input id="diskAuditBefore" type="date" class="px-2 py-1.5 border border-gray-300 rounded-lg" title="截止日期（导/删 之前的日志）" />
                        <button id="diskAuditStats" type="button" class="px-2 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg"><i class="fas fa-calculator mr-1"></i>统计</button>
                    </div>
                </div>
                <div id="diskAuditSummary" class="text-xs text-gray-500 mb-2">选择学校与截止日期后点「统计」；导出与删除都按此截止日期执行</div>
                <div id="diskAuditTable" class="text-sm text-gray-600">尚未统计</div>
                <div class="flex items-center gap-2 mt-3">
                    <button id="diskAuditExport" type="button" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"><i class="fas fa-file-export mr-1"></i>导出留档</button>
                    <button id="diskAuditDelete" type="button" class="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition"><i class="fas fa-trash mr-1"></i>删除已留档部分</button>
                    <span id="diskAuditMsg" class="text-xs text-gray-500"></span>
                </div>
            </div>

            <div class="admin-card">
                <div class="flex items-center justify-between flex-wrap gap-3 mb-3">
                    <div>
                        <h3><i class="fas fa-shield-alt text-slate-500"></i>备份（按天）</h3>
                        <p class="text-xs text-gray-500">删除将<b>同时移除加密备份文件与对应备份记录（含审计索引）</b>，不可恢复；支持多选/按月/按年批量</p>
                    </div>
                    <div class="flex items-center flex-wrap gap-2 text-sm">
                        <select id="diskBkYear" class="px-2 py-1.5 border border-gray-300 rounded-lg text-sm"><option value="all">年份：全部</option></select>
                        <button id="diskBkSelAll" type="button" class="px-2 py-1 text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg">全选（当前筛选）</button>
                        <button id="diskBkSelNone" type="button" class="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-lg">清除选择</button>
                        <button id="diskBkDelete" type="button" class="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-40" disabled><i class="fas fa-trash mr-1"></i>删除所选天</button>
                    </div>
                </div>
                <div id="diskBkSummary" class="text-xs text-gray-500 mb-2"></div>
                <div id="diskBackupDays" class="text-sm text-gray-600 max-h-[420px] overflow-y-auto">加载中…</div>
            </div>
        </div>`;

        const $ = (id) => document.getElementById(id);
        $('diskRefresh')?.addEventListener('click', () => load());
        $('diskJournalVacuum')?.addEventListener('click', () => vacuumJournal());
        // 日志筛选绑定
        $('diskLogGroup')?.addEventListener('change', (e) => { state.f.group = e.target.value; renderLogs(); });
        $('diskLogStatus')?.addEventListener('change', (e) => { state.f.status = e.target.value; renderLogs(); });
        $('diskLogFrom')?.addEventListener('change', (e) => { state.f.from = e.target.value; renderLogs(); });
        $('diskLogTo')?.addEventListener('change', (e) => { state.f.to = e.target.value; renderLogs(); });
        $('diskLogPreset7')?.addEventListener('click', () => { setLogPreset(7); });
        $('diskLogPreset30')?.addEventListener('click', () => { setLogPreset(30); });
        $('diskLogClearFilter')?.addEventListener('click', () => {
            state.f = { group: 'all', status: 'all', from: '', to: '' };
            $('diskLogGroup').value = 'all'; $('diskLogStatus').value = 'all';
            $('diskLogFrom').value = ''; $('diskLogTo').value = '';
            renderLogs();
        });
        $('diskLogSelFiltered')?.addEventListener('click', () => {
            for (const f of filteredLogs()) state.selLogs.add(f.path);
            renderLogs();
        });
        $('diskLogSelNone')?.addEventListener('click', () => { state.selLogs.clear(); renderLogs(); });
        $('diskLogsDelete')?.addEventListener('click', () => deleteSelectedLogs());
        // 备份筛选与批量绑定
        $('diskBkYear')?.addEventListener('change', () => renderBackups());
        $('diskBkSelAll')?.addEventListener('click', () => {
            for (const b of filteredBackupDays()) state.selDays.add(b.day);
            renderBackups();
        });
        $('diskBkSelNone')?.addEventListener('click', () => { state.selDays.clear(); renderBackups(); });
        $('diskBkDelete')?.addEventListener('click', () => deleteSelectedBackupDays());
        // 租户业务日志（AuditLog）统计/导出/删除
        $('diskAuditStats')?.addEventListener('click', () => loadAuditStats());
        $('diskAuditExport')?.addEventListener('click', () => exportAuditLogs());
        $('diskAuditDelete')?.addEventListener('click', () => deleteAuditLogs());
    }

    function setLogPreset(days) {
        const to = new Date();
        const from = new Date(to.getTime() - days * 86400000);
        state.f.from = dayStr(from); state.f.to = dayStr(to);
        const fe = document.getElementById('diskLogFrom'), te = document.getElementById('diskLogTo');
        if (fe) fe.value = state.f.from;
        if (te) te.value = state.f.to;
        renderLogs();
    }

    /* ─────────── 总览 ─────────── */
    function renderOverview(d) {
        const dataMount = d.mounts.find((m) => m.mount === '/mnt/datadisk0');
        const sysMount = d.mounts.find((m) => m.mount === '/');
        const kpiData = document.getElementById('diskKpiData');
        const kpiSys = document.getElementById('diskKpiSys');
        if (kpiData && dataMount) {
            kpiData.innerHTML = `<span class="${usageColor(dataMount.usagePct)}">${dataMount.usagePct}%</span>`;
            kpiData.parentElement.querySelector('.admin-kpi-sub').textContent = `已用 ${fmtBytes(dataMount.used)} / ${fmtBytes(dataMount.total)}`;
        }
        if (kpiSys && sysMount) {
            kpiSys.innerHTML = `<span class="${usageColor(sysMount.usagePct)}">${sysMount.usagePct}%</span>`;
            kpiSys.parentElement.querySelector('.admin-kpi-sub').textContent = `已用 ${fmtBytes(sysMount.used)} / ${fmtBytes(sysMount.total)}`;
        }
        const kpiJournal = document.getElementById('diskKpiJournal');
        if (kpiJournal) kpiJournal.innerHTML = `<span class="text-gray-700">${fmtBytes(d.journal.bytes)}</span>`;
        // journal 卡片内同步显示当前占用（用户反馈：操作区看不到占用量）
        const jSize = document.getElementById('diskJournalSize');
        if (jSize) jSize.textContent = `当前占用 ${fmtBytes(d.journal.bytes)}`;
        const kpiBackup = document.getElementById('diskKpiBackup');
        if (kpiBackup) kpiBackup.innerHTML = `<span class="text-gray-700">${fmtBytes(d.backups.totalBytes)}</span>`;

        const mountsEl = document.getElementById('diskMounts');
        if (mountsEl) {
            mountsEl.innerHTML = `<table class="w-full text-sm">
                <thead><tr class="text-left text-gray-500 border-b">
                    <th class="py-2">挂载点</th><th>使用率</th><th>已用</th><th>可用</th><th>总量</th></tr></thead>
                <tbody>${d.mounts.map((m) => `
                    <tr class="border-b last:border-0">
                        <td class="py-2 font-mono">${escapeHtml(m.mount)}</td>
                        <td><span class="${usageColor(m.usagePct)} font-semibold">${m.usagePct}%</span>
                            ${m.usagePct >= 90 ? '<span class="ml-1 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-xs">告警中</span>' : ''}</td>
                        <td>${fmtBytes(m.used)}</td><td>${fmtBytes(m.avail)}</td><td>${fmtBytes(m.total)}</td>
                    </tr>`).join('')}</tbody></table>`;
        }
    }

    /* ─────────── 日志：筛选 + 批量选择 ─────────── */
    function filteredLogs() {
        const { group, status, from, to } = state.f;
        const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null;
        const toTs = to ? new Date(`${to}T23:59:59`).getTime() : null;
        return state.logs.filter((f) => {
            if (group !== 'all' && f.group !== group) return false;
            if (status === 'active' && f.rotated) return false;
            if (status === 'rotated' && !f.rotated) return false;
            if (fromTs && f.mtime < fromTs) return false;
            if (toTs && f.mtime > toTs) return false;
            return true;
        });
    }

    function renderLogs() {
        const el = document.getElementById('diskLogFiles');
        if (!el) return;
        const filtered = filteredLogs();
        const selFiltered = filtered.filter((f) => state.selLogs.has(f.path));
        const selBytes = [...state.selLogs].reduce((s, p) => s + (state.logs.find((f) => f.path === p)?.size || 0), 0);
        const sumEl = document.getElementById('diskLogSummary');
        if (sumEl) sumEl.textContent = `筛选结果 ${filtered.length} 个 / 共 ${state.logs.length} 个 · 已勾选 ${state.selLogs.size} 个（${fmtBytes(selBytes)}）`;
        const btn = document.getElementById('diskLogsDelete');
        if (btn) btn.disabled = state.selLogs.size === 0;

        const groups = [
            { key: 'app', title: '应用日志（/mnt/datadisk0/foodsentinel/logs）· 单进程多租户混合输出（含 3 校+超管，不分校）+ 定时任务输出', files: filtered.filter((f) => f.group === 'app') },
            { key: 'rsyslog', title: 'rsyslog（/mnt/datadisk0/system-logs/syslog）· 操作系统级（SSH/内核/cron，与应用无关）', files: filtered.filter((f) => f.group === 'rsyslog') },
        ];
        let rows = '';
        for (const g of groups) {
            if (state.f.group !== 'all' && state.f.group !== g.key) continue;
            rows += `<tr class="bg-gray-50"><td colspan="4" class="py-1.5 px-2 text-xs font-semibold text-gray-500">${escapeHtml(g.title)} · 合计 ${fmtBytes(g.files.reduce((s, f) => s + f.size, 0))}</td></tr>`;
            if (!g.files.length) rows += `<tr><td colspan="4" class="py-1.5 px-2 text-xs text-gray-400">（无匹配文件）</td></tr>`;
            for (const f of g.files) {
                const active = !f.rotated;
                rows += `<tr class="border-b last:border-0">
                    <td class="py-1.5 px-2 w-8"><input type="checkbox" class="disk-log-check rounded" value="${escapeHtml(f.path)}" ${state.selLogs.has(f.path) ? 'checked' : ''} /></td>
                    <td class="py-1.5 font-mono text-xs">${escapeHtml(f.path)}</td>
                    <td class="py-1.5 whitespace-nowrap">${fmtBytes(f.size)}${active ? ' <span class="ml-1 px-1 py-0.5 rounded bg-blue-50 text-blue-700 text-xs">活跃</span>' : ''}</td>
                    <td class="py-1.5 whitespace-nowrap text-xs text-gray-500">${fmtTime(f.mtime)}</td>
                </tr>`;
            }
        }
        el.innerHTML = `<table class="w-full text-sm">
            <thead><tr class="text-left text-gray-500 border-b"><th class="py-2 w-8"></th><th>文件</th><th>大小</th><th>最后修改</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
        el.querySelectorAll('.disk-log-check').forEach((cb) => {
            cb.addEventListener('change', () => {
                if (cb.checked) state.selLogs.add(cb.value); else state.selLogs.delete(cb.value);
                renderLogs();
            });
        });
    }

    /* ─────────── 备份：年筛选 + 月分组 + 多选天 ─────────── */
    function filteredBackupDays() {
        const y = document.getElementById('diskBkYear')?.value || 'all';
        return y === 'all' ? state.backupDays : state.backupDays.filter((b) => b.day.startsWith(`${y}-`));
    }

    function renderBackups() {
        const el = document.getElementById('diskBackupDays');
        if (!el) return;
        // 年份下拉只构建一次选项
        const yearSel = document.getElementById('diskBkYear');
        if (yearSel && yearSel.options.length <= 1) {
            const years = [...new Set(state.backupDays.map((b) => b.day.slice(0, 4)))].sort().reverse();
            for (const y of years) {
                const o = document.createElement('option');
                o.value = y; o.textContent = `年份：${y}`;
                yearSel.appendChild(o);
            }
        }

        const list = filteredBackupDays();
        const selDaysList = [...state.selDays];
        const selSize = selDaysList.reduce((s, d) => s + (state.backupDays.find((b) => b.day === d)?.size || 0), 0);
        const sumEl = document.getElementById('diskBkSummary');
        if (sumEl) sumEl.textContent = `筛选结果 ${list.length} 天 / 共 ${state.backupDays.length} 天 · 已勾选 ${state.selDays.size} 天（${fmtBytes(selSize)}）`;
        const btn = document.getElementById('diskBkDelete');
        if (btn) btn.disabled = state.selDays.size === 0;

        if (!list.length) { el.innerHTML = '<p class="text-xs text-gray-400 py-2">（无匹配备份）</p>'; return; }

        // 按月分组渲染：月份头行（全选本月/删除本月）+ 天行（勾选）
        const byMonth = new Map();
        for (const b of list) {
            const m = b.day.slice(0, 7);
            if (!byMonth.has(m)) byMonth.set(m, []);
            byMonth.get(m).push(b);
        }
        let rows = '';
        for (const [month, days] of [...byMonth.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1)) {
            const mSize = days.reduce((s, b) => s + b.size, 0);
            const allChecked = days.every((b) => state.selDays.has(b.day));
            rows += `<tr class="bg-gray-50">
                <td colspan="3" class="py-1.5 px-2 text-xs font-semibold text-gray-500">
                    <label class="inline-flex items-center gap-1 mr-3">
                        <input type="checkbox" class="disk-month-check rounded" data-month="${month}" ${allChecked ? 'checked' : ''} />
                        ${escapeHtml(month)} 全选本月
                    </label>
                    共 ${days.length} 天 · ${fmtBytes(mSize)}
                </td>
                <td class="py-1.5 px-2 text-right"><button type="button" class="disk-month-del px-2 py-1 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100 transition" data-month="${month}"><i class="fas fa-trash mr-1"></i>删除本月</button></td>
            </tr>`;
            for (const b of days) {
                rows += `<tr class="border-b last:border-0">
                    <td class="py-1.5 px-2 w-8"><input type="checkbox" class="disk-day-check rounded" value="${escapeHtml(b.day)}" ${state.selDays.has(b.day) ? 'checked' : ''} /></td>
                    <td class="py-1.5 font-mono">${escapeHtml(b.day)}</td>
                    <td class="py-1.5">${b.count} 个文件</td>
                    <td class="py-1.5">${fmtBytes(b.size)}</td>
                </tr>`;
            }
        }
        el.innerHTML = `<table class="w-full text-sm">
            <thead><tr class="text-left text-gray-500 border-b"><th class="py-2 w-8"></th><th>日期</th><th>文件数</th><th>大小</th></tr></thead>
            <tbody>${rows}</tbody></table>`;

        el.querySelectorAll('.disk-day-check').forEach((cb) => {
            cb.addEventListener('change', () => {
                if (cb.checked) state.selDays.add(cb.value); else state.selDays.delete(cb.value);
                renderBackups();
            });
        });
        el.querySelectorAll('.disk-month-check').forEach((cb) => {
            cb.addEventListener('change', () => {
                const days = (byMonth.get(cb.dataset.month) || []).map((b) => b.day);
                if (cb.checked) days.forEach((d) => state.selDays.add(d));
                else days.forEach((d) => state.selDays.delete(d));
                renderBackups();
            });
        });
        el.querySelectorAll('.disk-month-del').forEach((btn) => {
            btn.addEventListener('click', () => {
                const days = (byMonth.get(btn.dataset.month) || []).map((b) => b.day);
                deleteBackupDays(days, `${btn.dataset.month}（${days.length} 天）`);
            });
        });
    }

    async function load() {
        try {
            const d = await api('/overview');
            // 统一日志条目（app 从 stat 毫秒；rsyslog 后端已转毫秒）
            state.logs = [
                ...d.logs.app.files.map((f) => ({ ...f, group: 'app' })),
                ...d.logs.rsyslog.files.map((f) => ({ ...f, group: 'rsyslog' })),
            ];
            state.backupDays = d.backups.byDay;
            renderOverview(d);
            renderLogs();
            renderBackups();
        } catch (e) {
            notify(e.message || '读取磁盘水位失败', 'error');
        }
    }

    async function vacuumJournal() {
        const input = document.getElementById('diskJournalDays');
        const out = document.getElementById('diskJournalOut');
        const days = Math.min(Math.max(Number(input?.value) || 7, 1), 365);
        if (!confirm(`确认将 journal 收缩为只保留最近 ${days} 天？此操作不可恢复。`)) return;
        if (out) out.textContent = '收缩中…';
        try {
            const d = await api('/journal/vacuum', { method: 'POST', body: { days } });
            if (out) out.textContent = d.output || `完成，journal 现为 ${fmtBytes(d.bytesAfter)}`;
            notify(`journal 已收缩为最近 ${days} 天`, 'success');
            await load();
        } catch (e) {
            if (out) out.textContent = `失败：${e.message}`;
            notify(e.message || 'journal 收缩失败', 'error');
        }
    }

    async function deleteSelectedLogs() {
        if (!state.selLogs.size) return;
        if (!confirm(`确认删除选中的 ${state.selLogs.size} 个日志文件？此操作不可恢复（已写审计）。`)) return;
        try {
            const d = await api('/logs/delete', { method: 'POST', body: { paths: [...state.selLogs] } });
            const failN = d.failed?.length || 0;
            notify(`已删除 ${d.deleted.length} 个文件${failN ? `，失败 ${failN} 个` : ''}`, failN ? 'error' : 'success');
            state.selLogs.clear();
            await load();
        } catch (e) {
            notify(e.message || '删除失败', 'error');
        }
    }

    /** 批量删除天集合：days=[...]，label=确认文案中的范围描述 */
    async function deleteBackupDays(days, label) {
        if (!days.length) { notify('未选择任何日期', 'error'); return; }
        if (!confirm(`确认删除 ${label} 的全部备份？\n\n将同时移除加密备份文件与对应备份记录（含验证/恢复索引），不可恢复！`)) return;
        if (!confirm(`再次确认：永久删除 ${label} 共 ${days.length} 天的备份？`)) return;
        try {
            const d = await api('/backups/delete-day', { method: 'POST', body: { days } });
            notify(`已删除 ${d.totalDays} 天：${d.totalFiles} 个文件、${d.totalRuns} 条记录`, 'success');
            state.selDays.clear();
            await load();
        } catch (e) {
            notify(e.message || '删除备份失败', 'error');
        }
    }

    function deleteSelectedBackupDays() {
        const days = [...state.selDays].sort();
        if (!days.length) return;
        const label = days.length === 1 ? days[0]
            : days.length <= 5 ? days.join('、')
            : `${days[0]} ~ ${days[days.length - 1]}（含间隔共 ${days.length} 天）`;
        deleteBackupDays(days, label);
    }

    /* ─────────── 学校租户业务日志（AuditLog）统计/导出/删除 ─────────── */
    let auditState = { before: null, stats: [] };

    function auditParams() {
        const schoolCode = document.getElementById('diskAuditSchool')?.value;
        const before = document.getElementById('diskAuditBefore')?.value || '';
        return { schoolCode, before };
    }

    async function loadAuditStats() {
        const { before } = auditParams();
        if (!before) { notify('请先选择截止日期', 'error'); return; }
        const msg = document.getElementById('diskAuditMsg');
        if (msg) msg.textContent = '统计中…';
        try {
            const d = await api(`/audit-logs/stats?before=${before}`);
            auditState.before = before;
            auditState.stats = d.schools;
            const el = document.getElementById('diskAuditTable');
            if (el) {
                el.innerHTML = `<table class="w-full text-sm">
                    <thead><tr class="text-left text-gray-500 border-b">
                        <th class="py-2">学校</th><th>总行数</th><th>${before} 之前</th><th>最早</th><th>最新</th></tr></thead>
                    <tbody>${d.schools.map((s) => `
                        <tr class="border-b last:border-0">
                            <td class="py-1.5 font-mono">${escapeHtml(s.schoolCode)}</td>
                            <td>${s.error ? '<span class="text-red-600 text-xs">读取失败</span>' : s.total}</td>
                            <td>${s.error ? '-' : `<b>${s.beforeCount ?? '-'}</b>`}</td>
                            <td class="text-xs text-gray-500">${s.oldest ? s.oldest.slice(0, 10) : '-'}</td>
                            <td class="text-xs text-gray-500">${s.newest ? s.newest.slice(0, 10) : '-'}</td>
                        </tr>`).join('')}</tbody></table>`;
            }
            if (msg) msg.textContent = `统计完成（截止 ${before}）`;
        } catch (e) {
            if (msg) msg.textContent = `统计失败：${e.message}`;
            notify(e.message || '统计失败', 'error');
        }
    }

    async function exportAuditLogs() {
        const { schoolCode, before } = auditParams();
        if (!schoolCode || !before) { notify('请先选择学校与截止日期', 'error'); return; }
        if (!confirm(`确认导出 ${schoolCode} 在 ${before} 之前的全部审计日志为留档文件？`)) return;
        const msg = document.getElementById('diskAuditMsg');
        if (msg) msg.textContent = '导出中…';
        try {
            const d = await api('/audit-logs/export', { method: 'POST', body: { schoolCode, before } });
            if (msg) msg.innerHTML = `已导出 <b>${d.count}</b> 条 → <code class="font-mono">${escapeHtml(d.file)}</code>（${fmtBytes(d.bytes)}，数据盘 audit-exports/）· <a class="text-blue-600 underline" href="${API_BASE}/api/admin/disk/audit-logs/download?file=${encodeURIComponent(d.file)}" download>下载</a>`;
            notify(`${schoolCode} 审计日志已导出 ${d.count} 条`, 'success');
        } catch (e) {
            if (msg) msg.textContent = `导出失败：${e.message}`;
            notify(e.message || '导出失败', 'error');
        }
    }

    async function deleteAuditLogs() {
        const { schoolCode, before } = auditParams();
        if (!schoolCode || !before) { notify('请先选择学校与截止日期', 'error'); return; }
        const msg = document.getElementById('diskAuditMsg');
        // 第一步：查询将删除条数（服务端要求 confirmCount 精确匹配）
        try {
            const d = await api(`/audit-logs/stats?before=${before}`);
            const s = d.schools.find((x) => x.schoolCode === schoolCode);
            if (!s || s.error) throw new Error('该校日志统计不可用');
            if (!s.beforeCount) { notify(`${before} 之前无日志可删`, 'error'); return; }
            if (!confirm(`确认删除 ${schoolCode} 在 ${before} 之前的审计日志？\n将删除 ${s.beforeCount} 条（前提：已导出留档到 ≥ ${before}）。`)) return;
            if (msg) msg.textContent = '删除中…';
            const r = await api('/audit-logs/delete', {
                method: 'POST',
                body: { schoolCode, before, confirmCount: s.beforeCount },
            });
            notify(`已删除 ${schoolCode} ${before} 之前的 ${r.deleted} 条审计日志（留档校验通过：${r.exportVerified}）`, 'success');
            if (msg) msg.textContent = `删除完成：${r.deleted} 条（留档文件 ${r.exportVerified} 已核验）`;
            await loadAuditStats();
        } catch (e) {
            if (msg) msg.textContent = `删除失败：${e.message}`;
            notify(e.message || '删除失败', 'error');
        }
    }

    // 宿主页渲染面板（section#adminViewDisk 静态骨架在 HTML 中，动态内容在此填充）后初始化
    renderSkeleton();
    load();

    return { reload: load };
}
