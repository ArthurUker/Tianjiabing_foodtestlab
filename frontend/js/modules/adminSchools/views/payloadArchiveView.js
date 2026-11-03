// ====== 病原体设备 · 原始上报报文（2026-11-03，方案 B 归档）======
// 二级菜单「病原体设备 → 原始上报报文」：列出设备上报的原始 JSON（成功/失败都归档），
// 支持按天数/学校/设备/芯片号/状态筛选、查看与下载原文。
// ⚠️ 仅超管可见（接口 /api/admin/pathogen-devices/payloads 由 requirePlatformSuperAdmin 保护）。

let ctx = null;
let mounted = false;
let loadedOnce = false;

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}
function fmtTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return esc(v);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
function fmtSize(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

const PANEL_HTML = `
<div id="pdPayloadPanelInner">
  <div class="flex flex-wrap items-end gap-3 mb-4">
    <div>
      <label class="block text-xs text-gray-500 mb-1">最近</label>
      <select id="pdPlDays" class="border border-gray-300 rounded px-2 py-1.5 text-sm">
        <option value="1">1 天</option>
        <option value="7" selected>7 天</option>
        <option value="30">30 天</option>
        <option value="90">90 天</option>
      </select>
    </div>
    <div>
      <label class="block text-xs text-gray-500 mb-1">学校代码</label>
      <input id="pdPlSchool" type="text" placeholder="如 tjb（可空）" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-32" autocomplete="off">
    </div>
    <div>
      <label class="block text-xs text-gray-500 mb-1">设备编号</label>
      <input id="pdPlDevice" type="text" placeholder="可空" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-36" autocomplete="off">
    </div>
    <div>
      <label class="block text-xs text-gray-500 mb-1">芯片编号</label>
      <input id="pdPlChip" type="text" placeholder="模糊匹配" class="border border-gray-300 rounded px-2 py-1.5 text-sm w-40" autocomplete="off">
    </div>
    <div>
      <label class="block text-xs text-gray-500 mb-1">结果</label>
      <select id="pdPlStatus" class="border border-gray-300 rounded px-2 py-1.5 text-sm">
        <option value="">全部</option>
        <option value="200">仅成功（200）</option>
        <option value="400">仅失败（4xx/5xx）</option>
      </select>
    </div>
    <button id="pdPlSearch" type="button" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">查询</button>
    <span id="pdPlStat" class="text-xs text-gray-500 ml-auto"></span>
  </div>
  <div class="overflow-x-auto border border-gray-200 rounded">
    <table class="w-full text-sm">
      <thead class="bg-gray-50 text-gray-600">
        <tr>
          <th class="text-left px-3 py-2 font-medium">上报时间</th>
          <th class="text-left px-3 py-2 font-medium">学校</th>
          <th class="text-left px-3 py-2 font-medium">设备编号</th>
          <th class="text-left px-3 py-2 font-medium">芯片编号</th>
          <th class="text-left px-3 py-2 font-medium">结果</th>
          <th class="text-right px-3 py-2 font-medium">大小</th>
          <th class="text-right px-3 py-2 font-medium">操作</th>
        </tr>
      </thead>
      <tbody id="pdPlRows"><tr><td colspan="7" class="px-3 py-6 text-center text-gray-400">加载中…</td></tr></tbody>
    </table>
  </div>
  <p class="text-xs text-gray-400 mt-2">
    说明：每条设备上报（含被拒的）都会把原始 JSON 压缩存档，库内只存路径；此处可查看/下载原文用于与厂商对账。
    文件保留期由后端 DEVICE_PAYLOAD_RETENTION_DAYS（默认 90 天）控制。
  </p>
</div>`;

function currentQuery() {
    const el = (id) => document.getElementById(id);
    const status = el('pdPlStatus')?.value || '';
    return {
        days: el('pdPlDays')?.value || '7',
        school: (el('pdPlSchool')?.value || '').trim(),
        device: (el('pdPlDevice')?.value || '').trim(),
        chip: (el('pdPlChip')?.value || '').trim(),
        status,
        limit: '200',
    };
}

async function loadList() {
    const rows = document.getElementById('pdPlRows');
    const stat = document.getElementById('pdPlStat');
    if (!rows) return;
    const q = currentQuery();
    if (q.status === '400') q.status = ''; // 前端只有"仅成功/全部"，失败筛选走 code/status 说明
    const qs = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => { if (v) qs.set(k, v); });
    rows.innerHTML = '<tr><td colspan="7" class="px-3 py-6 text-center text-gray-400">加载中…</td></tr>';
    try {
        const res = await fetch(`${ctx.apiBase}/api/admin/pathogen-devices/payloads?${qs.toString()}`, { headers: ctx.authHeaders() });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
        let items = json.data?.items || [];
        const onlyFail = document.getElementById('pdPlStatus')?.value === '400';
        if (onlyFail) items = items.filter((x) => Number(x.status) >= 400);
        if (stat) stat.textContent = `共 ${items.length} 条（扫描 ${json.data?.scannedDays ?? q.days} 天）`;
        if (!items.length) {
            rows.innerHTML = '<tr><td colspan="7" class="px-3 py-6 text-center text-gray-400">该条件下没有归档报文</td></tr>';
            return;
        }
        rows.innerHTML = items.map((x) => {
            const ok = Number(x.status) === 200;
            const badge = ok
                ? '<span class="px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-xs">成功 200</span>'
                : `<span class="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-xs">${esc(x.status)} ${esc(x.code || '')}</span>`;
            return `<tr class="border-t border-gray-100 hover:bg-gray-50">
                <td class="px-3 py-2 whitespace-nowrap">${fmtTime(x.at)}</td>
                <td class="px-3 py-2">${esc(x.school_code || '—')}</td>
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
        rows.innerHTML = `<tr><td colspan="7" class="px-3 py-6 text-center text-red-500">加载失败：${esc(e.message)}</td></tr>`;
    }
}

function openJsonModal(path, content, meta) {
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
            <div class="px-5 py-2 text-xs text-gray-500 border-b bg-gray-50" id="pdPlModalMeta"></div>
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
    modal.dataset.name = String(meta?.chip_number || meta?.device_no || 'payload') + '_' + String(path).split('/').pop().replace('.json.gz', '');
    document.getElementById('pdPlModalMeta').innerHTML = `<span class="font-mono">${esc(path)}</span>`;
    document.getElementById('pdPlJson').textContent = content;
    modal.classList.remove('hidden');
}

async function viewPayload(path) {
    try {
        const res = await fetch(`${ctx.apiBase}/api/admin/pathogen-devices/payloads/content?path=${encodeURIComponent(path)}`, { headers: ctx.authHeaders() });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
        const pretty = JSON.stringify(json.data.payload, null, 2);
        openJsonModal(path, pretty, { chip_number: path.split('/').pop().split('_')[0] });
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

    // 把「设备管理」现有内容包进 #pdSubDevices，并追加「原始上报报文」面板
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
            if (e.target.closest('#pdPlSearch')) return void loadList();
        });
        payloads.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('input')) loadList();
        });
        const daysSel = payloads.querySelector('#pdPlDays');
        if (daysSel) daysSel.addEventListener('change', () => loadList());
    }

    // 一级菜单切入本视图后，把侧边栏二级项的选中态与当前面板对齐（避免"面板是 A、菜单高亮 B"）
    const parentItem = document.querySelector('.admin-sidebar__item[data-view="pathogendevices"]');
    if (parentItem) {
        parentItem.addEventListener('click', () => {
            setTimeout(() => {
                const onPayloads = !document.getElementById('pdSubPayloads')?.classList.contains('hidden');
                setSubview(onPayloads ? 'payloads' : 'devices');
            }, 0);
        });
    }

    // 二级菜单点击：切面板（若一级菜单未激活，先走正常视图切换）
    document.querySelectorAll('[data-subnav="pathogendevices"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
        sub.addEventListener('click', () => {
            const parent = document.querySelector('.admin-sidebar__item[data-view="pathogendevices"]');
            if (parent && !parent.classList.contains('active')) parent.click();
            setSubview(sub.getAttribute('data-subview'));
        });
    });
}
