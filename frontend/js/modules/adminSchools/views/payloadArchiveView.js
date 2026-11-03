// ====== 病原体设备 · 原始上报报文（2026-11-03，方案 B 归档）======
// 二级菜单「病原体设备 → 原始上报报文」：设备上报的原始 JSON 文件管理。
// 设计目标（2026-11-03 第二轮）：
//   · 一眼看清：总量/成功/失败/占用空间 四张卡片
//   · **按学校分类**：左侧学校列表带条数（失败数标红），点击即筛选；显示学校名称而非代码
//   · 按状态分类：全部 / 成功 / 失败 三个标签页
//   · 定位单个文件：芯片号模糊搜索 + 最近 N 天
// ⚠️ 仅超管可见（接口 requirePlatformSuperAdmin）。

let ctx = null;
let mounted = false;
let loadedOnce = false;
let state = { school: '', status: '', days: '7', chip: '', device: '', data: null };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const api = (p) => `${ctx.API_BASE || ''}${p}`;

function fmtTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return esc(v);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtSize(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

const PANEL_HTML = `
<div class="space-y-4">
  <!-- 概览卡片 -->
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <div class="border border-gray-200 rounded-lg p-3">
      <div class="text-xs text-gray-500">归档报文</div>
      <div class="text-2xl font-bold text-gray-800" id="pdPlStatTotal">—</div>
      <div class="text-xs text-gray-400">最近 <span id="pdPlStatDays">7</span> 天</div>
    </div>
    <div class="border border-green-200 bg-green-50 rounded-lg p-3">
      <div class="text-xs text-green-700">上传成功</div>
      <div class="text-2xl font-bold text-green-700" id="pdPlStatOk">—</div>
      <div class="text-xs text-green-600">HTTP 200（含复测并入）</div>
    </div>
    <div class="border border-red-200 bg-red-50 rounded-lg p-3">
      <div class="text-xs text-red-700">被拒 / 失败</div>
      <div class="text-2xl font-bold text-red-700" id="pdPlStatFail">—</div>
      <div class="text-xs text-red-600">用于排查"设备说传了"</div>
    </div>
    <div class="border border-gray-200 rounded-lg p-3">
      <div class="text-xs text-gray-500">占用空间</div>
      <div class="text-2xl font-bold text-gray-800" id="pdPlStatSize">—</div>
      <div class="text-xs text-gray-400">压缩后 <span id="pdPlStatGz">—</span></div>
    </div>
  </div>

  <div class="flex flex-col lg:flex-row gap-4">
    <!-- 左：按学校分类 -->
    <aside class="flex-shrink-0 w-full" style="max-width:16rem">
      <div class="border border-gray-200 rounded-lg overflow-hidden">
        <div class="px-3 py-2 bg-gray-50 text-xs font-medium text-gray-600 flex items-center justify-between">
          <span><i class="fas fa-school mr-1"></i>按学校分类</span>
          <span class="text-gray-400" id="pdPlSchoolCount"></span>
        </div>
        <div id="pdPlSchools" class="overflow-auto divide-y divide-gray-100" style="max-height:420px"></div>
      </div>
      <p class="text-xs text-gray-400 mt-2 leading-relaxed">
        索引上线前的历史文件没有学校信息，会归到「未识别」。
      </p>
    </aside>

    <!-- 右：筛选 + 列表 -->
    <div class="flex-1 min-w-0">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <div class="inline-flex rounded-lg border border-gray-200 overflow-hidden" id="pdPlTabs">
          <button type="button" data-st="" class="px-3 py-1.5 text-sm bg-blue-600 text-white">全部</button>
          <button type="button" data-st="200" class="px-3 py-1.5 text-sm bg-white text-gray-600 border-l border-gray-200">成功</button>
          <button type="button" data-st="fail" class="px-3 py-1.5 text-sm bg-white text-gray-600 border-l border-gray-200">失败</button>
        </div>
        <select id="pdPlDays" class="border border-gray-300 rounded px-2 py-1.5 text-sm">
          <option value="1">最近 1 天</option>
          <option value="7" selected>最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="90">最近 90 天</option>
        </select>
        <input id="pdPlChip" type="text" placeholder="芯片编号（模糊）" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" autocomplete="off">
        <input id="pdPlDevice" type="text" placeholder="设备编号" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" autocomplete="off">
        <button id="pdPlSearch" type="button" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">查询</button>
        <button id="pdPlReset" type="button" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200">重置</button>
      </div>

      <div class="overflow-x-auto border border-gray-200 rounded-lg">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 text-gray-600">
            <tr>
              <th class="text-left px-3 py-2 font-medium">上报时间</th>
              <th class="text-left px-3 py-2 font-medium">归属学校</th>
              <th class="text-left px-3 py-2 font-medium">设备编号</th>
              <th class="text-left px-3 py-2 font-medium">芯片编号</th>
              <th class="text-left px-3 py-2 font-medium">结果</th>
              <th class="text-right px-3 py-2 font-medium">大小</th>
              <th class="text-right px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody id="pdPlRows"><tr><td colspan="7" class="px-3 py-8 text-center text-gray-400">加载中…</td></tr></tbody>
        </table>
      </div>
      <p class="text-xs text-gray-400 mt-2">
        每条上报（含被拒）都会把原始 JSON 压缩存档，库内只存路径；文件保留期由
        <code class="bg-gray-100 px-1 rounded">DEVICE_PAYLOAD_RETENTION_DAYS</code>（默认 90 天）控制。
      </p>
    </div>
  </div>
</div>`;

function renderSchools(stats) {
    const host = document.getElementById('pdPlSchools');
    const cnt = document.getElementById('pdPlSchoolCount');
    if (!host) return;
    const list = stats?.bySchool || [];
    if (cnt) cnt.textContent = `${list.length} 个`;
    const rows = [{ code: '', name: '全部学校', count: stats?.total || 0, failed: stats?.failed || 0 }]
        .concat(list.map((s) => ({ code: s.code || '', name: s.name, count: s.count, failed: s.failed })));
    host.innerHTML = rows.map((s) => {
        const active = String(state.school || '') === String(s.code || '');
        return `<button type="button" data-school="${esc(s.code)}"
            class="w-full text-left px-3 py-2 hover:bg-blue-50 ${active ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}">
            <div class="flex items-center justify-between gap-2">
              <span class="truncate">${esc(s.name)}</span>
              <span class="text-xs ${active ? 'text-blue-600' : 'text-gray-400'}">${s.count}</span>
            </div>
            ${s.failed ? `<div class="text-xs text-red-500 mt-0.5">其中失败 ${s.failed}</div>` : ''}
        </button>`;
    }).join('');
}

function renderStats(stats) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('pdPlStatTotal', stats?.total ?? '—');
    set('pdPlStatOk', stats?.success ?? '—');
    set('pdPlStatFail', stats?.failed ?? '—');
    set('pdPlStatSize', fmtSize(stats?.bytes));
    set('pdPlStatGz', fmtSize(stats?.gzBytes));
    set('pdPlStatDays', state.days);
}

function renderTabs() {
    document.querySelectorAll('#pdPlTabs button').forEach((b) => {
        const on = String(b.getAttribute('data-st')) === String(state.status);
        b.className = `px-3 py-1.5 text-sm ${on ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border-l border-gray-200'}`;
    });
}

async function loadList() {
    const rows = document.getElementById('pdPlRows');
    if (!rows) return;
    rows.innerHTML = '<tr><td colspan="7" class="px-3 py-8 text-center text-gray-400">加载中…</td></tr>';

    const qs = new URLSearchParams();
    qs.set('days', state.days);
    qs.set('limit', '500');
    if (state.chip) qs.set('chip', state.chip);
    if (state.device) qs.set('device', state.device);

    try {
        const res = await fetch(api(`/api/admin/pathogen-devices/payloads?${qs.toString()}`), { headers: ctx.authHeaders() });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON：多为路由未命中被前端回退成 HTML */ }
        if (!json) throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${api('/api/admin/pathogen-devices/payloads')}`);
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);

        let items = json.data?.items || [];
        // 前端做「学校 / 状态」二次过滤（保持一次请求拿到全量统计）
        if (state.school) items = items.filter((x) => String(x.school_code || '') === String(state.school));
        if (state.status === '200') items = items.filter((x) => Number(x.status) === 200);
        if (state.status === 'fail') items = items.filter((x) => Number(x.status) >= 400);

        state.data = json.data;
        renderStats(json.data?.stats);
        renderSchools(json.data?.stats);
        renderTabs();

        if (!items.length) {
            rows.innerHTML = '<tr><td colspan="7" class="px-3 py-8 text-center text-gray-400">该条件下没有归档报文</td></tr>';
            return;
        }
        rows.innerHTML = items.map((x) => {
            const ok = Number(x.status) === 200;
            const badge = ok
                ? `<span class="px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-xs">成功 200</span>`
                : `<span class="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-xs">${esc(x.status)} ${esc(x.code || '')}</span>`;
            const schoolCell = x.school_name
                ? `<div class="text-gray-800">${esc(x.school_name)}</div><div class="text-xs text-gray-400 font-mono">${esc(x.school_code)}</div>`
                : `<span class="text-gray-400 text-xs">未识别（历史文件）</span>`;
            return `<tr class="border-t border-gray-100 hover:bg-gray-50">
                <td class="px-3 py-2 whitespace-nowrap">${fmtTime(x.at)}</td>
                <td class="px-3 py-2">${schoolCell}</td>
                <td class="px-3 py-2 font-mono text-xs">${esc(x.device_no || '—')}</td>
                <td class="px-3 py-2 font-mono text-xs">${esc(x.chip_number || '—')}</td>
                <td class="px-3 py-2">${badge}</td>
                <td class="px-3 py-2 text-right whitespace-nowrap">${fmtSize(x.bytes)}<span class="text-gray-400 text-xs"> / ${fmtSize(x.gz_bytes)}</span></td>
                <td class="px-3 py-2 text-right whitespace-nowrap">
                    <button type="button" class="text-blue-600 hover:underline text-xs" data-pl-view="${esc(x.path)}">查看</button>
                    <button type="button" class="text-gray-600 hover:underline text-xs ml-2" data-pl-copy="${esc(x.path)}">复制路径</button>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        rows.innerHTML = `<tr><td colspan="7" class="px-3 py-8 text-center text-red-500">加载失败：${esc(e.message)}</td></tr>`;
    }
}

function openJsonModal(path, content) {
    let modal = document.getElementById('pdPlModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'pdPlModal';
        modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4';
        modal.innerHTML = `
          <div class="bg-white rounded-lg shadow-2xl w-full max-w-5xl flex flex-col" style="max-height:90vh">
            <div class="px-5 py-3 border-b flex items-center justify-between">
              <h3 class="font-bold text-gray-800"><i class="fas fa-file-code text-blue-600 mr-2"></i>原始上报报文</h3>
              <button type="button" data-pl-close class="text-gray-500 hover:text-gray-700"><i class="fas fa-times"></i></button>
            </div>
            <div class="px-5 py-2 text-xs text-gray-500 border-b bg-gray-50 font-mono break-all" id="pdPlModalMeta"></div>
            <div class="p-5 overflow-auto flex-1">
              <pre id="pdPlJson" class="text-xs leading-relaxed bg-gray-900 p-4 rounded overflow-auto" style="color:#bbf7d0"></pre>
            </div>
            <div class="px-5 py-3 border-t flex justify-end gap-2">
              <button type="button" data-pl-download class="px-3 py-1.5 text-sm bg-gray-100 rounded hover:bg-gray-200">下载 JSON</button>
              <button type="button" data-pl-close class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">关闭</button>
            </div>
          </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.closest('[data-pl-close]')) modal.classList.add('hidden');
            if (e.target.closest('[data-pl-download]')) {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([modal.dataset.json || '{}'], { type: 'application/json' }));
                a.download = (modal.dataset.name || 'payload') + '.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
        });
    }
    modal.dataset.json = content;
    modal.dataset.name = String(path).split('/').pop().replace('.json.gz', '');
    document.getElementById('pdPlModalMeta').textContent = path;
    document.getElementById('pdPlJson').textContent = content;
    modal.classList.remove('hidden');
}

async function viewPayload(path) {
    try {
        const res = await fetch(api(`/api/admin/pathogen-devices/payloads/content?path=${encodeURIComponent(path)}`), { headers: ctx.authHeaders() });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 同上 */ }
        if (!json) throw new Error('接口返回非 JSON');
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        openJsonModal(path, JSON.stringify(json.data.payload, null, 2));
    } catch (e) {
        ctx.notify(`读取报文失败：${e.message}`, 'error');
    }
}

function setSubview(name) {
    const devices = document.getElementById('pdSubDevices');
    const payloads = document.getElementById('pdSubPayloads');
    const isPayloads = name === 'payloads';
    if (devices) devices.classList.toggle('hidden', isPayloads);
    if (payloads) payloads.classList.toggle('hidden', !isPayloads);
    document.querySelectorAll('[data-subnav="pathogendevices"] .admin-sidebar__subitem[data-subview]').forEach((s) => {
        s.classList.toggle('active', s.getAttribute('data-subview') === name);
    });
    if (isPayloads && !loadedOnce) {
        loadedOnce = true;
        loadList();
    }
}

export function initPathogenPayloadView(options) {
    ctx = options;
    if (mounted) return;
    mounted = true;

    const host = document.getElementById('adminViewPathogenDevices');
    if (!host) return;

    if (!document.getElementById('pdSubDevices')) {
        const devices = document.createElement('div');
        devices.id = 'pdSubDevices';
        while (host.firstChild) devices.appendChild(host.firstChild);
        const payloads = document.createElement('div');
        payloads.id = 'pdSubPayloads';
        payloads.className = 'hidden';
        payloads.innerHTML = PANEL_HTML;
        host.appendChild(devices);
        host.appendChild(payloads);

        payloads.addEventListener('click', (e) => {
            const view = e.target.closest('[data-pl-view]');
            if (view) return void viewPayload(view.getAttribute('data-pl-view'));
            const copy = e.target.closest('[data-pl-copy]');
            if (copy) {
                navigator.clipboard?.writeText(copy.getAttribute('data-pl-copy'));
                return void ctx.notify('路径已复制', 'success');
            }
            const school = e.target.closest('[data-school]');
            if (school) {
                state.school = school.getAttribute('data-school') || '';
                loadList();
                return;
            }
            const tab = e.target.closest('#pdPlTabs button');
            if (tab) {
                state.status = tab.getAttribute('data-st') || '';
                renderTabs();
                loadList();
                return;
            }
            if (e.target.closest('#pdPlSearch')) return void loadList();
            if (e.target.closest('#pdPlReset')) {
                Object.assign(state, { school: '', status: '', days: '7', chip: '', device: '' });
                const d = document.getElementById('pdPlDays'); if (d) d.value = '7';
                const c = document.getElementById('pdPlChip'); if (c) c.value = '';
                const dv = document.getElementById('pdPlDevice'); if (dv) dv.value = '';
                return void loadList();
            }
        });
        payloads.addEventListener('change', (e) => {
            if (e.target.id === 'pdPlDays') {
                state.days = e.target.value;
                loadList();
            }
        });
        payloads.addEventListener('input', (e) => {
            if (e.target.id === 'pdPlChip') state.chip = e.target.value.trim();
            if (e.target.id === 'pdPlDevice') state.device = e.target.value.trim();
        });
        payloads.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('input')) loadList();
        });
    }

    // 一级菜单切入本视图后，把侧边栏二级项高亮与当前面板对齐
    const parentItem = document.querySelector('.admin-sidebar__item[data-view="pathogendevices"]');
    if (parentItem) {
        parentItem.addEventListener('click', () => {
            setTimeout(() => {
                const onPayloads = !document.getElementById('pdSubPayloads')?.classList.contains('hidden');
                setSubview(onPayloads ? 'payloads' : 'devices');
            }, 0);
        });
    }

    // 二级菜单点击：切面板（若一级未激活，先走正常视图切换）
    document.querySelectorAll('[data-subnav="pathogendevices"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
        sub.addEventListener('click', () => {
            const parent = document.querySelector('.admin-sidebar__item[data-view="pathogendevices"]');
            if (parent && !parent.classList.contains('active')) parent.click();
            setSubview(sub.getAttribute('data-subview'));
        });
    });
}
