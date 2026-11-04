// ====== 病原体设备 · 原始上报报文（2026-11-03 归档 / 2026-11-04 查看器重做）======
// 二级菜单「病原体设备 → 原始上报报文」：设备上报的原始 JSON 文件管理。
//
// 列表：概览四卡 + 左「按学校分类」+ 状态页签 + 天数/芯片/设备筛选。
// **查看器（本次重做）**——原来只把整包 JSON 塞进 <pre>，点位/荧光一屏数字，定位字段只能靠肉眼翻：
//   ① 顶部结论条：成功/失败码、上报时间、学校、设备、芯片、体积；
//   ② 三个页签：
//      基本信息 —— 12 个关键字段的键值表 + 结果摘要（阳性点位、层级）；
//      点位与荧光 —— 每个点位一行：通道/项目/判定/Ct/荧光点数 + 迷你曲线，可展开看原始数组；
//      原始 JSON —— 语法着色 + 关键字搜索（可只显示匹配行）+ 自动换行 + 复制/下载；
//   ③ 键盘 Esc 关闭、点遮罩关闭、复制路径。
// ⚠️ 仅超管可见（接口 requirePlatformSuperAdmin）。

let ctx = null;
let mounted = false;
let loadedOnce = false;
let state = { school: '', status: '', days: '7', chip: '', device: '', data: null, items: [], rows: [] };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const api = (p) => `${ctx.API_BASE || ''}${p}`;

function fmtTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtSize(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(2)} MB`;
}
/** JSON 语法着色（在原始文本上分词后再逐段转义，避免二次转义破坏引号）。 */
function highlightJson(raw) {
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(raw))) {
        out += esc(raw.slice(last, m.index));
        if (m[1]) {
            out += m[2]
                ? `<span style="color:#7dd3fc">${esc(m[1])}</span>${esc(m[2])}`
                : `<span style="color:#86efac">${esc(m[1])}</span>`;
        } else if (m[3]) {
            out += `<span style="color:#f0abfc">${esc(m[3])}</span>`;
        } else if (m[4]) {
            out += `<span style="color:#fcd34d">${esc(m[4])}</span>`;
        }
        last = re.lastIndex;
    }
    out += esc(raw.slice(last));
    return out;
}

const PANEL_HTML = `
<div class="space-y-4">
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

/* ─────────── 列表 ─────────── */
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
        if (state.school) items = items.filter((x) => String(x.school_code || '') === String(state.school));
        if (state.status === '200') items = items.filter((x) => Number(x.status) === 200);
        if (state.status === 'fail') items = items.filter((x) => Number(x.status) >= 400);

        state.data = json.data;
        state.items = items;
        renderStats(json.data?.stats);
        renderSchools(json.data?.stats);
        renderTabs();

        if (!items.length) {
            rows.innerHTML = '<tr><td colspan="7" class="px-3 py-8 text-center text-gray-400">该条件下没有归档报文</td></tr>';
            return;
        }
        rows.innerHTML = items.map((x, i) => {
            const ok = Number(x.status) === 200;
            const badge = ok
                ? '<span class="px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-xs">成功 200</span>'
                : `<span class="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-xs">${esc(x.status)} ${esc(x.code || '')}</span>`;
            const schoolCell = x.school_name
                ? `<div class="text-gray-800">${esc(x.school_name)}</div><div class="text-xs text-gray-400 font-mono">${esc(x.school_code)}</div>`
                : '<span class="text-gray-400 text-xs">未识别（历史文件）</span>';
            return `<tr class="border-t border-gray-100 ${ok ? 'hover:bg-gray-50' : 'bg-red-50 hover:bg-red-100'}">
                <td class="px-3 py-2 whitespace-nowrap" title="${esc(fmtTime(x.at))}">${fmtTime(x.at)}</td>
                <td class="px-3 py-2">${schoolCell}</td>
                <td class="px-3 py-2 font-mono text-xs">${esc(x.device_no || '—')}</td>
                <td class="px-3 py-2 font-mono text-xs">${esc(x.chip_number || '—')}</td>
                <td class="px-3 py-2">${badge}</td>
                <td class="px-3 py-2 text-right whitespace-nowrap">${fmtSize(x.bytes)}<span class="text-gray-400 text-xs"> / ${fmtSize(x.gz_bytes)}</span></td>
                <td class="px-3 py-2 text-right whitespace-nowrap">
                    <button type="button" class="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100" data-pl-idx="${i}"><i class="fas fa-eye mr-1"></i>查看</button>
                    <button type="button" class="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 ml-1" data-pl-copy="${esc(x.path)}" title="复制服务器路径"><i class="fas fa-copy"></i></button>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        rows.innerHTML = `<tr><td colspan="7" class="px-3 py-8 text-center text-red-500">加载失败：${esc(e.message)}</td></tr>`;
    }
}

/* ─────────── 查看器 ─────────── */
const BASIC_FIELDS = [
    ['DeviceNo', '设备编号'],
    ['DetectionDateTime', '检测开始时间'],
    ['DetectionEndDateTime', '检测结束时间'],
    ['DetectionNumber', '报告编号'],
    ['SampleStr', '样本描述'],
    ['DetectionPeopleStr', '检测员'],
    ['ChipID', '芯片 ID'],
    ['ChipName', '芯片名称'],
    ['ChipNumber', '芯片序列号'],
    ['FileName', '原始文件名'],
];

function ensureModal() {
    let modal = document.getElementById('pdPlModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'pdPlModal';
    modal.className = 'hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="bg-white rounded-lg shadow-2xl w-full max-w-6xl flex flex-col" style="max-height:92vh">
        <div class="px-5 py-3 border-b flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="font-bold text-gray-800 flex items-center gap-2">
              <i class="fas fa-file-code text-blue-600"></i>原始上报报文
              <span id="pdPlBadge"></span>
            </h3>
            <div class="text-xs text-gray-500 font-mono break-all mt-1" id="pdPlFileName"></div>
          </div>
          <button type="button" data-pl-close class="text-gray-500 hover:text-gray-700 shrink-0" title="关闭（Esc）"><i class="fas fa-times"></i></button>
        </div>

        <div id="pdPlMeta" class="px-5 py-2 border-b bg-gray-50 grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1 text-xs"></div>

        <div class="px-5 pt-2 flex items-center gap-1 border-b">
          <button type="button" data-pl-tab="basic" class="px-3 py-2 text-sm border-b-2">基本信息</button>
          <button type="button" data-pl-tab="points" class="px-3 py-2 text-sm border-b-2">点位与荧光</button>
          <button type="button" data-pl-tab="raw" class="px-3 py-2 text-sm border-b-2">原始 JSON</button>
          <span class="ml-auto text-xs text-gray-400" id="pdPlTabHint"></span>
        </div>

        <div id="pdPlPaneBasic" class="p-5 overflow-auto flex-1 min-h-0"></div>
        <div id="pdPlPanePoints" class="hidden p-5 overflow-auto flex-1 min-h-0"></div>
        <div id="pdPlPaneRaw" class="hidden flex-1 min-h-0 flex flex-col">
          <div class="px-5 py-2 border-b flex flex-wrap items-center gap-2">
            <input id="pdPlJsonSearch" type="text" placeholder="搜索字段或值（如 ChipNumber / 25.3）" class="border border-gray-300 rounded px-2 py-1 text-sm w-72" autocomplete="off">
            <label class="inline-flex items-center gap-1 text-xs text-gray-600"><input id="pdPlJsonOnlyMatch" type="checkbox" class="rounded border-gray-300"> 仅显示匹配行</label>
            <label class="inline-flex items-center gap-1 text-xs text-gray-600"><input id="pdPlJsonWrap" type="checkbox" class="rounded border-gray-300" checked> 自动换行</label>
            <span class="text-xs text-gray-400" id="pdPlJsonStat"></span>
            <span class="ml-auto flex items-center gap-2">
              <button type="button" data-pl-copyjson class="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"><i class="fas fa-copy mr-1"></i>复制</button>
              <button type="button" data-pl-download class="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"><i class="fas fa-download mr-1"></i>下载 JSON</button>
            </span>
          </div>
          <div class="flex-1 min-h-0 overflow-auto bg-gray-900 p-3">
            <pre id="pdPlJson" class="text-xs leading-relaxed whitespace-pre-wrap break-all" style="color:#e5e7eb"></pre>
          </div>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.closest('[data-pl-close]')) return closeModal();
        const tab = e.target.closest('[data-pl-tab]');
        if (tab) return switchTab(tab.getAttribute('data-pl-tab'));
        // 荧光数组展开（弹层挂在 body 上，事件不会冒泡到面板容器）
        const fl = e.target.closest('[data-pl-fl]');
        if (fl) {
            const box = document.getElementById(`pdPlFl${fl.getAttribute('data-pl-fl')}`);
            if (box) box.classList.toggle('hidden');
            return;
        }
        if (e.target.closest('[data-pl-download]')) return downloadJson();
        if (e.target.closest('[data-pl-copyjson]')) return copyJson();
    });
    modal.addEventListener('input', (e) => {
        if (e.target.id === 'pdPlJsonSearch' || e.target.id === 'pdPlJsonOnlyMatch') renderRaw();
        if (e.target.id === 'pdPlJsonWrap') {
            const pre = document.getElementById('pdPlJson');
            if (pre) {
                pre.classList.toggle('whitespace-pre-wrap', e.target.checked);
                pre.classList.toggle('break-all', e.target.checked);
                pre.classList.toggle('whitespace-pre', !e.target.checked);
            }
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    });
    return modal;
}

function closeModal() {
    const modal = document.getElementById('pdPlModal');
    if (modal) modal.classList.add('hidden');
}

function switchTab(name) {
    for (const t of ['basic', 'points', 'raw']) {
        const pane = document.getElementById(`pdPlPane${t[0].toUpperCase()}${t.slice(1)}`);
        if (pane) pane.classList.toggle('hidden', t !== name);
        const btn = document.querySelector(`[data-pl-tab="${t}"]`);
        if (btn) {
            const on = t === name;
            btn.className = `px-3 py-2 text-sm border-b-2 ${on ? 'border-blue-600 text-blue-700 font-medium' : 'border-transparent text-gray-600 hover:text-gray-800'}`;
        }
    }
    if (name === 'raw') renderRaw();
}

function currentPayload() {
    return state.view?.payload || null;
}

function renderMeta(row, payload) {
    const host = document.getElementById('pdPlMeta');
    if (!host) return;
    const cols = [
        ['上报时间', fmtTime(row?.at)],
        ['归属学校', row?.school_name ? `${row.school_name}（${row.school_code || '—'}）` : '未识别'],
        ['设备编号', row?.device_no || payload?.DeviceNo || '—'],
        ['芯片编号', row?.chip_number || payload?.ChipNumber || '—'],
        ['体积', `${fmtSize(row?.bytes)} / 压缩 ${fmtSize(row?.gz_bytes)}`],
        ['结果', row ? `${Number(row.status) === 200 ? '成功' : '失败'} ${row.status}${row.code ? ` ${row.code}` : ''}` : '—'],
        ['文件路径', row?.path || '—'],
    ];
    host.innerHTML = cols.map(([k, v], i) => `
        <div class="${i === cols.length - 1 ? 'lg:col-span-2 col-span-2' : ''}">
          <span class="text-gray-400">${esc(k)}：</span>
          <span class="${k === '文件路径' ? 'font-mono break-all' : 'text-gray-800'}">${esc(v)}</span>
        </div>`).join('');
}

function renderBasic(payload) {
    const host = document.getElementById('pdPlPaneBasic');
    if (!host) return;
    const parms = payload?.Parms && typeof payload.Parms === 'object' ? payload.Parms : {};
    const results = payload?.ResultList && typeof payload.ResultList === 'object' ? payload.ResultList : {};
    const positives = Object.keys(parms).filter((k) => results[k] === true);
    const rows = BASIC_FIELDS.map(([key, label]) => {
        const v = payload?.[key];
        return `<tr class="border-t border-gray-100">
            <td class="px-3 py-2 text-gray-500 whitespace-nowrap w-40">${esc(label)}</td>
            <td class="px-3 py-2 font-mono text-xs break-all">${v === undefined || v === null || v === '' ? '<span class="text-gray-300">—</span>' : esc(v)}</td>
            <td class="px-3 py-2 text-gray-400 text-xs whitespace-nowrap w-40">${esc(key)}</td>
        </tr>`;
    }).join('');
    host.innerHTML = `
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <span class="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-700">点位数 ${Object.keys(parms).length}</span>
        <span class="px-2 py-0.5 rounded-full text-xs ${positives.length ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}">阳性点位 ${positives.length}</span>
        ${positives.length ? `<span class="text-xs text-red-600">${esc(positives.join('、'))}</span>` : ''}
        ${payload?.OptimizationDataLists && typeof payload.OptimizationDataLists === 'object'
            ? `<span class="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-700">荧光通道 ${Object.keys(payload.OptimizationDataLists).length}</span>` : ''}
      </div>
      <table class="w-full text-sm border border-gray-200 rounded">
        <tbody>${rows}</tbody>
      </table>
      <p class="text-xs text-gray-400 mt-2">字段名（右列）与设备上报协议一致，便于对照厂商文档核对。</p>`;
}

function sparkline(arr) {
    const nums = (Array.isArray(arr) ? arr : []).map(Number).filter((n) => Number.isFinite(n));
    if (!nums.length) return '<span class="text-gray-300 text-xs">无数据</span>';
    const max = Math.max(...nums.map((n) => Math.abs(n)), 1e-9);
    const step = Math.max(1, Math.floor(nums.length / 48));
    const picked = nums.filter((_, i) => i % step === 0).slice(0, 48);
    const bars = picked.map((n) => {
        const h = Math.max(2, Math.round((Math.abs(n) / max) * 18));
        return `<span style="display:inline-block;width:3px;height:${h}px;background:#60a5fa;margin-right:1px;vertical-align:bottom"></span>`;
    }).join('');
    return `<span style="line-height:0">${bars}</span> <span class="text-gray-400 text-xs">${nums.length} 点 · 峰值 ${max.toFixed(2)}</span>`;
}

function renderPoints(payload) {
    const host = document.getElementById('pdPlPanePoints');
    if (!host) return;
    const parms = payload?.Parms && typeof payload.Parms === 'object' ? payload.Parms : {};
    const results = payload?.ResultList || {};
    const cts = payload?.CTList || {};
    const fluo = payload?.OptimizationDataLists || {};
    const keys = Object.keys(parms);
    if (!keys.length) {
        host.innerHTML = '<div class="text-sm text-gray-400 py-8 text-center">该报文没有 Parms 点位信息</div>';
        return;
    }
    const body = keys.map((k, i) => {
        const pos = results[k] === true;
        const ct = cts[k] === undefined || cts[k] === null || cts[k] === '' ? '—' : cts[k];
        const arr = Array.isArray(fluo[k]) ? fluo[k] : [];
        return `<tr class="border-t border-gray-100 align-top">
            <td class="px-3 py-2 font-mono text-xs whitespace-nowrap">${esc(k)}</td>
            <td class="px-3 py-2 text-gray-800">${esc(parms[k] || '—')}</td>
            <td class="px-3 py-2 whitespace-nowrap">${pos
                ? '<span class="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-xs">阳性</span>'
                : '<span class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-xs">阴性</span>'}</td>
            <td class="px-3 py-2 font-mono text-xs whitespace-nowrap">${esc(ct)}</td>
            <td class="px-3 py-2">${sparkline(arr)}</td>
            <td class="px-3 py-2 text-right whitespace-nowrap">
              ${arr.length ? `<button type="button" class="text-blue-600 hover:underline text-xs" data-pl-fl="${i}">展开数组</button>` : '<span class="text-gray-300 text-xs">—</span>'}
            </td>
        </tr>
        <tr id="pdPlFl${i}" class="hidden"><td colspan="6" class="px-3 pb-3">
            <pre class="bg-gray-50 border border-gray-200 rounded p-2 text-[11px] overflow-auto max-h-48">${esc(JSON.stringify(arr))}</pre>
        </td></tr>`;
    }).join('');
    host.innerHTML = `
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-600">
          <tr>
            <th class="text-left px-3 py-2 font-medium">通道</th>
            <th class="text-left px-3 py-2 font-medium">检测项目</th>
            <th class="text-left px-3 py-2 font-medium">判定</th>
            <th class="text-left px-3 py-2 font-medium">Ct</th>
            <th class="text-left px-3 py-2 font-medium">荧光曲线</th>
            <th class="text-right px-3 py-2 font-medium">原始数据</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
      <p class="text-xs text-gray-400 mt-2">「展开数组」显示该通道上报的原始荧光点（设备侧未裁剪）。</p>`;
}

function renderRaw() {
    const pre = document.getElementById('pdPlJson');
    const stat = document.getElementById('pdPlJsonStat');
    if (!pre) return;
    const payload = currentPayload();
    if (!payload) { pre.textContent = ''; return; }
    const raw = JSON.stringify(payload, null, 2);
    const kw = String(document.getElementById('pdPlJsonSearch')?.value || '').trim().toLowerCase();
    const onlyMatch = !!document.getElementById('pdPlJsonOnlyMatch')?.checked;

    if (!kw) {
        pre.innerHTML = highlightJson(raw);
        if (stat) stat.textContent = `${raw.split('\n').length} 行 / ${fmtSize(new Blob([raw]).size)}`;
        return;
    }
    const lines = raw.split('\n');
    const hits = lines
        .map((line, i) => ({ line, i }))
        .filter((x) => x.line.toLowerCase().includes(kw));
    if (stat) stat.textContent = `匹配 ${hits.length} 行`;
    if (!hits.length) {
        pre.innerHTML = `<span style="color:#9ca3af">没有匹配「${esc(kw)}」的内容</span>`;
        return;
    }
    if (!onlyMatch) {
        // 整篇着色 + 在命中行前加标记（不破坏 JSON 结构）
        pre.innerHTML = highlightJson(raw);
        return;
    }
    pre.innerHTML = hits.map(({ line, i }) => `<span style="color:#6b7280">${String(i + 1).padStart(4, ' ')} | </span>${highlightJson(line)}`).join('\n');
}

function openViewer(row, payload) {
    const modal = ensureModal();
    state.view = { row, payload };
    const ok = Number(row?.status) === 200;
    const badge = document.getElementById('pdPlBadge');
    if (badge) {
        badge.className = `px-2 py-0.5 rounded text-xs ${ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`;
        badge.textContent = ok ? '成功 200' : `${row?.status ?? ''} ${row?.code || ''}`.trim();
    }
    const name = document.getElementById('pdPlFileName');
    if (name) name.textContent = `${(row?.path || '').split('/').pop() || 'payload.json'}${row?.chip_number ? ` · 芯片 ${row.chip_number}` : ''}`;
    renderMeta(row, payload);
    renderBasic(payload);
    renderPoints(payload);
    if (document.getElementById('pdPlJsonSearch')) document.getElementById('pdPlJsonSearch').value = '';
    if (document.getElementById('pdPlJsonOnlyMatch')) document.getElementById('pdPlJsonOnlyMatch').checked = false;
    switchTab('basic');
    modal.classList.remove('hidden');
}

async function viewPayload(row) {
    if (!row) return;
    try {
        const res = await fetch(api(`/api/admin/pathogen-devices/payloads/content?path=${encodeURIComponent(row.path)}`), { headers: ctx.authHeaders() });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 同上 */ }
        if (!json) throw new Error('接口返回非 JSON');
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        openViewer(row, json.data.payload);
    } catch (e) {
        ctx.notify(`读取报文失败：${e.message}`, 'error');
    }
}

function downloadJson() {
    const payload = currentPayload();
    if (!payload) return;
    const row = state.view?.row || {};
    const name = `${row.chip_number || 'payload'}-${String(row.at || '').replace(/[:.]/g, '-')}.json`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    a.download = name.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
}

async function copyJson() {
    const payload = currentPayload();
    if (!payload) return;
    try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        ctx.notify('报文 JSON 已复制', 'success');
    } catch {
        ctx.notify('复制失败，请用下载', 'error');
    }
}

/* ─────────── 面板切换 ─────────── */
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
            const view = e.target.closest('[data-pl-idx]');
            if (view) return void viewPayload(state.items[Number(view.getAttribute('data-pl-idx'))]);
            const copy = e.target.closest('[data-pl-copy]');
            if (copy) {
                navigator.clipboard?.writeText(copy.getAttribute('data-pl-copy'));
                return void ctx.notify('路径已复制', 'success');
            }
            const fl = e.target.closest('[data-pl-fl]');
            if (fl) {
                const box = document.getElementById(`pdPlFl${fl.getAttribute('data-pl-fl')}`);
                if (box) box.classList.toggle('hidden');
                return;
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

    const parentItem = document.querySelector('.admin-sidebar__item[data-view="pathogendevices"]');
    if (parentItem) {
        parentItem.addEventListener('click', () => {
            setTimeout(() => {
                const onPayloads = !document.getElementById('pdSubPayloads')?.classList.contains('hidden');
                setSubview(onPayloads ? 'payloads' : 'devices');
            }, 0);
        });
    }

    document.querySelectorAll('[data-subnav="pathogendevices"] .admin-sidebar__subitem[data-subview]').forEach((sub) => {
        sub.addEventListener('click', () => {
            const parent = document.querySelector('.admin-sidebar__item[data-view="pathogendevices"]');
            if (parent && !parent.classList.contains('active')) parent.click();
            setSubview(sub.getAttribute('data-subview'));
        });
    });
}

/** 测试用：暴露纯函数（着色/渲染），不参与运行时导出。 */
export const __test__ = { highlightJson, sparkline };
