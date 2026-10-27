/*
* 病原体设备视图（2026-10-14，VirusHunter2.0B 对接）
* ------------------------------------------------------------
* 控制台一级菜单「病原体设备」：按学校租户维护「设备编号 → 学校」映射，
* 设备凭此处签发的密钥调用 POST /api/open/pathogen-device/upload 自动上报检测结果。
*
* 能力：查询（按学校过滤）/ 新增 / 修改 / 删除 / 停启用 / 轮换密钥 / 导出。
* 口径：字段校验唯一事实源在 backend/lib/pathogenDevice.js 与
*   routes/pathogenDeviceRoutes.js（前端只做即时提示，不作安全边界）；
*   所有动态内容一律 escapeHtml 后渲染；明文密钥仅在新增/轮换响应中出现一次。
*/
import { escapeHtml } from '../ui.js';

const UPLOAD_ENDPOINT = '/api/open/pathogen-device/upload';

/* ─────────── 接口使用指导（界面与「下载 MD 文档」的唯一事实源） ───────────
 * 口径与 backend/lib/pathogenDevice.js、routes/pathogenDeviceRoutes.js 对齐；
 * 接口如有调整，先改这里（改完界面与下载自动同步）。`<平台域名>` 在渲染/下载时替换为 location.origin。 */
const GUIDE_MD = [
    '# 病原体检测设备数据上传接口 · 使用指导',
    '',
    '> VirusHunter2.0B 自动采集对接（2026-10-14）。本指导与平台「病原体设备」配置页同源，可直接交付设备/上传程序开发方。',
    '',
    '## 1. 接口概况',
    '',
    '| 项 | 值 |',
    '|---|---|',
    '| 接口地址 | `POST <平台域名>/api/open/pathogen-device/upload` |',
    '| Content-Type | `application/json` |',
    '| 请求体上限 | 2MB（超限返回 413 `PAYLOAD_TOO_LARGE`） |',
    '| 数据归属 | 完全由报文 `DeviceNo` 查「学校-设备编号」映射决定；**报文不包含、也不需要任何学校信息** |',
    '| 限流 | 每设备默认 60 次/分钟（超限 429，响应带 `Retry-After` 秒数）；统一密钥另有平台级 600 次/分钟兜底 |',
    '',
    '**认证方式（两种模式，同一接口，任选其一）**：',
    '',
    '| 模式 | 密钥形态 | 归属判定 | 适用 |',
    '|---|---|---|---|',
    '| **统一上传密钥（推荐，默认形态）** | 全平台**共用一把**平台级密钥（控制台「病原体设备」页顶部创建/轮换） | 密钥只做准入；归属**完全由报文 `DeviceNo`** 查映射表决定 | 设备数量多、希望接入形态统一的场景：一把钥匙 + 设备编号绑定 |',
    '| 设备密钥（可选，严格模式） | **每台设备一把**独立密钥（新增设备时签发） | 密钥即设备；报文 `DeviceNo` 必须与密钥所属设备一致（不一致 403） | 单校/少量设备、要求更高隔离性的场景 |',
    '',
    '两种模式的认证头一致：`X-API-Key: <密钥>` 或 `Authorization: Bearer <密钥>`（二选一）。',
    '',
    '## 2. 接入前准备（由平台超管在控制台完成，随密钥一并交付）',
    '',
    '**模式一：统一上传密钥（推荐）**',
    '',
    '1. 控制台「病原体设备」页**顶部**「创建/轮换」统一上传密钥 → 立即抄录明文（仅此一次展示）',
    '2. 为每个学校绑定设备编号：选择学校 →「新增设备」→ 填写设备编号、绑定用户、默认食堂（设备即完成登记）',
    '3. 所有设备/上传程序配置**同一把**统一密钥 + 各自的设备编号',
    '',
    '**模式二：每设备独立密钥（可选）**',
    '',
    '1. 控制台「病原体设备」→ 选择学校 →「新增设备」：填写设备编号、绑定用户、默认食堂',
    '2. 保存后**立即抄录该设备的明文密钥**——仅此一次展示，遗失只能轮换',
    '3. 每台设备配置自己的密钥，报文携带与之一致的设备编号',
    '',
    '## 3. 请求报文字段',
    '',
    '| 字段 | 类型 | 必填 | 说明 |',
    '|---|---|---|---|',
    '| DeviceNo | string | 是 | 设备编号，须与控制台配置完全一致（不一致返回 403） |',
    '| DetectionDateTime | string | 是 | 检测开始时间，`YYYY-MM-DD HH:mm:ss`（兼容 `YYYY-MM-DDTHH:mm:ss`） |',
    '| DetectionEndDateTime | string | 是 | 检测结束时间，`YYYY-MM-DD HH:mm:ss`，不得早于开始时间 |',
    '| SampleStr | string | 是 | 样本描述，须含食堂名称（如「二食堂 餐盘涂抹样」） |',
    '| DetectionPeopleStr | string | 是 | 检测员姓名 |',
    '| DetectionNumber | string | 是 | 报告编号（设备侧唯一），**幂等键之一** |',
    '| FileName | string | 是 | 原始报告文件名 |',
    '| ChipID | string | 否 | 芯片 ID |',
    '| ChipName | string | 是 | 芯片名称 |',
    '| ChipNumber | string | 是 | 芯片序列号 |',
    '| Parms | object | 是 | 点位配置：通道 → 检测项名称；通道限 `FAM/HEX/ROX/CY5` + `-` + 序号 1~8（如 `FAM-1`） |',
    '| OptimizationDataLists | object | 是 | 点位荧光数据集合；**无荧光数据时传空对象 `{}`**；各通道数组（数字）可缺省，单通道超 96 点截断 |',
    '| ResultList | object | 是 | 各通道是否阳性（true/false），**必须覆盖 Parms 的每个通道** |',
    '| CTList | object | 是 | 各通道 Ct 值（字符串；阴性填 `-`），必须覆盖每个通道 |',
    '',
    '## 4. 完整报文示例',
    '',
    '```json',
    '{',
    '  "DeviceNo": "VH-2B-001",',
    '  "DetectionDateTime": "2026-09-17 08:30:00",',
    '  "DetectionEndDateTime": "2026-09-17 10:45:00",',
    '  "SampleStr": "二食堂 餐盘涂抹样",',
    '  "DetectionPeopleStr": "张三",',
    '  "DetectionNumber": "20260917001",',
    '  "FileName": "20260917_0830_1045_二食堂.vhfl",',
    '  "ChipID": "TS001",',
    '  "ChipName": "四通道微流控芯片",',
    '  "ChipNumber": "SN20260917001",',
    '  "Parms": { "FAM-1": "ORF1ab", "FAM-2": "N", "HEX-1": "内参" },',
    '  "OptimizationDataLists": { "FAM-1": [0.12, 0.45, 0.89], "FAM-2": [0.08, 0.32, 0.77], "HEX-1": [0.1, 0.4, 0.8] },',
    '  "ResultList": { "FAM-1": true, "FAM-2": false, "HEX-1": true },',
    '  "CTList": { "FAM-1": "25.3", "FAM-2": "-", "HEX-1": "28.7" }',
    '}',
    '```',
    '',
    '## 5. 响应格式',
    '',
    '成功（HTTP 200）：',
    '',
    '```json',
    '{ "code": 0, "message": "success", "data": { "reportId": "RC-pathogen-<64位十六进制>", "duplicated": false } }',
    '```',
    '',
    '重复上传（HTTP 200，幂等）：',
    '',
    '```json',
    '{ "code": 0, "message": "success", "data": { "reportId": "RC-pathogen-<与首次相同>", "duplicated": true } }',
    '```',
    '',
    '失败（HTTP 4xx/5xx）：',
    '',
    '```json',
    '{ "code": "VALIDATION_ERROR", "message": "参数校验失败：DetectionNumber不能为空", "data": null }',
    '```',
    '',
    '## 6. 错误码与处理动作',
    '',
    '| HTTP | code | 含义 | 应做什么 |',
    '|---|---|---|---|',
    '| 401 | MISSING_KEY | 未携带密钥 | 补 `X-API-Key` 请求头 |',
    '| 401 | INVALID_KEY | 密钥无效 | 核对密钥；确认统一密钥/设备未被停用、未被轮换 |',
    '| 403 | DEVICE_NOT_REGISTERED | （统一密钥模式）报文设备编号未在任何学校登记 | 先在控制台为该设备所属学校绑定此设备编号 |',
    '| 403 | DEVICE_DISABLED | 设备已停用 | 联系平台超管在控制台启用 |',
    '| 403 | DEVICE_MISMATCH | 报文 DeviceNo 与密钥所属设备不一致 | 核对设备编号配置 |',
    '| 403 | SCHOOL_DISABLED | 归属学校已停用 | 联系平台超管 |',
    '| 400 | VALIDATION_ERROR | 报文格式/字段错误 | 按 message 修正后重传（**勿原样重试**） |',
    '| 409 | SCHOOL_NOT_FOUND | 归属学校不存在 | 联系平台超管重新配置设备 |',
    '| 413 | PAYLOAD_TOO_LARGE | 请求体超 2MB | 检查荧光数组等字段大小 |',
    '| 422 | CANTEEN_NOT_IN_LIST | SampleStr 明确写了「四食堂」等，但该校食堂列表没有这个名称 | 不要静默改归属：请学校在「学校管理 → 基本信息」补该食堂，或更正样本信息后重传 |',
    '| 422 | CANTEEN_UNRESOLVED | 食堂无法识别且设备未配默认食堂 | SampleStr 含食堂名，或让超管配置默认食堂 |',
    '| 422 | BINDING_USER_MISSING | 设备绑定用户已失效 | 让超管在控制台改绑有效用户 |',
    '| 429 | RATE_LIMITED | 超过设备限流 | 按 `Retry-After` 退避后重试 |',
    '| 500 | INTERNAL_ERROR | 服务端异常 | 退避重试（建议 1s/5s/30s，至多 3 次） |',
    '',
    '## 7. 幂等与重试',
    '',
    '- **幂等键 = 设备编号 + DetectionNumber**：重复上传返回同一 `reportId` 且 `duplicated:true`，不会产生重复记录，网络超时后可放心重传',
    '- 4xx（除 429）为数据/配置问题：**修正后重传，勿原样重试**',
    '- 429 / 5xx / 网络错误：退避重试，建议间隔 1s、5s、30s，至多 3 次',
    '',
    '## 8. 数据落库口径（与手动导入完全一致）',
    '',
    '- **食堂识别**：SampleStr 中含该校食堂名即自动匹配（支持「二食堂 / 第2食堂 / 2号食堂 / 全角数字」等写法）；识别不到回落设备「默认食堂」；两者都没有 → 422 拒绝，**不会写入「未知食堂」**',
    '- **业务日期**：取 DetectionDateTime 的日期部分',
    '- **风险分档**（按阳性项最低 Ct）：Ct<20 高风险 / 20~30 中风险 / 30~35 低风险 / ≥35 极低风险；内参通道不计阳性',
    '- 记录以**「设备」来源**进入学校「病原体检测」列表（样本 ID 旁有徽标，详情可溯源设备编号），看板/导出/开放接口自动覆盖，无需学校额外操作',
    '',
    '## 9. 联调自检清单',
    '',
    '- [ ] 不携带密钥上传 → 401 MISSING_KEY',
    '- [ ] 使用错误 DeviceNo 上传 → 403 DEVICE_MISMATCH',
    '- [ ] 正常上传 → `code:0` 且返回 reportId',
    '- [ ] 同一 DetectionNumber 重复上传 → `duplicated:true`，reportId 不变',
    '- [ ] 控制台「病原体设备」该设备上传次数 +1、最近上传时间更新',
    '- [ ] 学校「病原体检测」列表出现该记录且带「设备」徽标',
].join('\n');

/* 极简 Markdown → HTML（服务「接口使用指导」；与 openApiView 同款口径，避免跨视图引依赖）。
 * 支持：``` 代码块 / | 表格 / #~#### 标题 / > 引用 / - 列表 / 数字列表 / **加粗** / `行内代码` */
function mdInline(s) {
    return escapeHtml(s)
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/`([^`]+)`/g, '<code class="font-mono text-[11px] bg-gray-100 px-1 rounded">$1</code>');
}

function renderMdBlocks(lines) {
    const out = [];
    let i = 0;
    const src = Array.isArray(lines) ? lines : [];
    while (i < src.length) {
        const line = String(src[i]);
        if (line.startsWith('```')) {
            const buf = [];
            i++;
            while (i < src.length && !String(src[i]).startsWith('```')) buf.push(src[i++]);
            i++;
            out.push(`<pre class="bg-gray-900 text-gray-100 text-[11px] rounded-lg p-3 overflow-auto max-h-[320px] mb-2">${escapeHtml(buf.join('\n'))}</pre>`);
            continue;
        }
        if (line.startsWith('|')) {
            const rows = [];
            while (i < src.length && String(src[i]).startsWith('|')) rows.push(src[i++]);
            const head = rows[0] || '';
            const body = rows.slice(2);
            const cells = (r) => String(r).split('|').slice(1, -1).map((x) => x.trim());
            out.push(`<div class="overflow-auto mb-2"><table class="w-full text-xs">
                <thead><tr class="text-left text-gray-500 border-b">${cells(head).map((h) => `<th class="py-1 px-2">${mdInline(h)}</th>`).join('')}</tr></thead>
                <tbody>${body.map((r) => `<tr class="border-b last:border-0">${cells(r).map((x) => `<td class="py-1 px-2 align-top">${mdInline(x)}</td>`).join('')}</tr>`).join('')}</tbody>
            </table></div>`);
            continue;
        }
        if (/^#{1,4}\s/.test(line)) {
            out.push(`<p class="text-sm font-bold text-gray-800 mt-4 mb-1 border-b border-gray-200 pb-1">${mdInline(line.replace(/^#{1,4}\s/, ''))}</p>`);
            i++;
            continue;
        }
        if (line.startsWith('> ')) {
            out.push(`<p class="text-xs text-gray-600 border-l-2 border-gray-300 pl-2 mb-1">${mdInline(line.slice(2))}</p>`);
            i++;
            continue;
        }
        if (/^- /.test(line)) {
            out.push(`<p class="text-xs text-gray-600 mb-1 pl-2">• ${mdInline(line.slice(2))}</p>`);
            i++;
            continue;
        }
        if (/^\d+\.\s/.test(line)) {
            out.push(`<p class="text-xs text-gray-600 mb-1 pl-2">${mdInline(line)}</p>`);
            i++;
            continue;
        }
        if (line.trim() === '') { i++; continue; }
        out.push(`<p class="text-xs text-gray-600 mb-1">${mdInline(line)}</p>`);
        i++; // ⚠️ 必须推进：漏掉即死循环（2026-10-14 点击「接口使用指导」页面卡死事故）
    }
    return out.join('');
}

/** 本地日期（YYYY-MM-DD）；绑定期间展示用（不受 UTC 偏移影响）。 */
function fmtDay(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 日期输入框取值：'YYYY-MM-DD' 或空串（`<input type=date>` 不接受「—」）。 */
function dayValue(v) {
    if (!v) return '';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '' : fmtDay(d);
}

function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* 指导文档与渲染器导出（供 tests/frontend 回归：死循环/口径/转义）。 */
export { GUIDE_MD, renderMdBlocks };

export function initPathogenDeviceView({ API_BASE, authHeaders, notify }) {
    // 跨校查看哨兵：选中它 = 不按学校过滤（后端 GET /api/admin/pathogen-devices 不传 school_code 即返回全部）
    const ALL_SCHOOLS = '__all__';

    const state = {
        schools: [],        // [{ code, name, status }]
        schoolCode: '',     // 当前筛选学校
        devices: [],
        users: [],          // 当前学校用户（绑定用户下拉）
        canteens: [],       // 当前学校食堂名单（默认食堂下拉）
        editing: null,      // null = 新增；否则为编辑中的设备
        keyword: '',        // 设备列表客户端筛选关键词
        onlyActive: false,  // 仅看「在用」绑定（台账含历史行）
        replacing: null,    // 正在变更编号的绑定行
        replaceBusy: false, // 变更编号请求在途（防连点重复提交）
        canteensFallback: false, // 当前学校的食堂名单是否来自内置默认（未配置）
        platformKey: null,  // 统一上传密钥当前视图（B 方案）
        bound: false,
    };

    const el = (id) => document.getElementById(id);

    async function api(path, opts = {}) {
        const resp = await fetch(`${API_BASE}/api/admin/pathogen-devices${path}`, {
            method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j.success === false) throw new Error(j.error || `HTTP ${resp.status}`);
        return j.data;
    }

    async function loadSchools() {
        const resp = await fetch(`${API_BASE}/api/admin/schools?limit=500`, { headers: authHeaders() });
        const j = await resp.json().catch(() => ({}));
        const rows = Array.isArray(j.data) ? j.data : [];
        state.schools = rows.map((s) => ({ code: s.code, name: s.name, status: s.status }));
    }

    async function loadSchoolContext() {
        if (state.schoolCode === ALL_SCHOOLS) { state.users = []; state.canteens = []; return; }
        return loadSchoolContextFor(state.schoolCode);
    }

    /** 按指定学校加载「绑定用户候选 + 食堂名单」（跨校视图下编辑某设备时按其所属学校即时加载）。 */
    async function loadSchoolContextFor(schoolCode) {
        state.users = [];
        state.canteens = [];
        if (!schoolCode || schoolCode === ALL_SCHOOLS) return;
        try {
            const resp = await fetch(`${API_BASE}/api/admin/schools/${encodeURIComponent(schoolCode)}/users`, { headers: authHeaders() });
            const j = await resp.json().catch(() => ({}));
            const rows = Array.isArray(j.data) ? j.data : (Array.isArray(j.users) ? j.users : []);
            state.users = rows.map((u) => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, status: u.status }));
        } catch { /* 绑定用户退化为手工输入 id */ }
        try {
            const resp = await fetch(`${API_BASE}/api/admin/schools/${encodeURIComponent(schoolCode)}/customization`, { headers: authHeaders() });
            const j = await resp.json().catch(() => ({}));
            const cfg = j.data || {};
            // 与手动录入/看板同一口径（frontend/js/utils/schoolCustomization/fields.js#getSchoolCanteens）：
            // ① field_options.canteen（最权威） → ② canteens（兼容历史） → ③ 内置默认 一/二/三食堂
            const pick = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
            const byFieldOptions = pick(cfg.field_options?.canteen);
            const byCanteens = pick(cfg.canteens);
            state.canteensFallback = !byFieldOptions.length && !byCanteens.length; // true = 用的是内置默认名单
            state.canteens = byFieldOptions.length ? byFieldOptions : (byCanteens.length ? byCanteens : ['一食堂', '二食堂', '三食堂']);
        } catch { /* 食堂名单缺失时由后端校验兜底 */ }
    }

    async function load() {
        if (state.schoolCode === ALL_SCHOOLS) {
            // 全部学校：不传 school_code，后端按 school_code, created_at 排序返回全部设备（跨校视图）
            state.devices = await api('');
            renderAll();
            return;
        }
        if (!state.schoolCode) { state.devices = []; renderAll(); return; }
        state.devices = await api(`?school_code=${encodeURIComponent(state.schoolCode)}`);
        renderAll();
    }

    /* ─────────── 骨架 ─────────── */
    function renderSkeleton() {
        const host = el('adminViewPathogenDevices');
        if (!host) return;
        host.innerHTML = `
        <div class="container mx-auto px-4 py-6 max-w-[2000px]">
            <!-- 平台级：标题 + 文档/导出/刷新（不随学校变化） -->
            <div class="flex items-start justify-between flex-wrap gap-3 mb-3">
                <div>
                    <h2 class="text-xl font-semibold text-gray-800"><i class="fas fa-microscope text-blue-500 mr-2"></i>病原体设备</h2>
                    <p class="text-xs text-gray-500 mt-1">
                        维护「检测设备编号 → 学校」映射：<strong>① 选择学校 → ② 新增设备编号</strong>，设备凭密钥调用
                        <code>POST ${UPLOAD_ENDPOINT}</code> 上报，系统按设备编号归属到该校（设备无需感知学校信息）。
                        报文字段与错误码见「接口使用指导」。
                    </p>
                </div>
                <div class="flex items-center gap-2">
                    <button type="button" data-act="guide" class="px-3 py-1.5 text-sm bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 transition" title="查看上传接口使用说明，并可下载 Markdown 指导文档"><i class="fas fa-book-open mr-1"></i>接口使用指导</button>
                    <button type="button" data-act="export" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition" title="导出全部学校设备配置（含密钥哈希，不含明文）"><i class="fas fa-download mr-1"></i>导出配置</button>
                    <button type="button" data-act="refresh" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition"><i class="fas fa-sync-alt mr-1"></i>刷新</button>
                </div>
            </div>

            <!-- 平台级：统一上传密钥（紧凑条；详细说明与危险操作收进「管理」面板） -->
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 mb-3">
                <div class="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span class="text-sm font-medium text-gray-700"><i class="fas fa-key text-indigo-500 mr-1"></i>统一上传密钥</span>
                    <span id="pdPkBadge" class="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-200 text-gray-600">加载中…</span>
                    <span id="pdPkMeta" class="text-xs font-mono text-gray-500"></span>
                    <button type="button" data-act="pk-panel" class="ml-auto px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200" title="展开：查看说明、创建/轮换、停用启用">管理</button>
                </div>
                <div id="pdPkPanel" class="hidden border-t border-gray-100 px-3 py-3 bg-gray-50 rounded-b-lg">
                    <p class="text-xs text-gray-600 mb-2">
                        推荐模式：全平台设备<strong>共用这一把密钥</strong>（请求头 <code>X-API-Key</code>），数据归属
                        <strong>完全由报文中的设备编号</strong>查「学校-设备编号」映射决定——设备必须先在下方按学校完成绑定。
                        <span class="text-red-600">轮换后旧密钥立即失效</span>，请同步更新所有设备上的密钥配置。
                    </p>
                    <div class="flex items-center gap-2">
                        <button type="button" data-act="pk-create" class="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">创建 / 轮换</button>
                        <button type="button" data-act="pk-toggle" class="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">停用</button>
                    </div>
                </div>
            </div>

            <!-- 主操作区：① 选学校 → ② 新增设备（动作跟随上下文，不再悬空） -->
            <div class="bg-white rounded-lg shadow-sm border border-gray-200 px-3 py-2.5 mb-3 flex flex-wrap items-center gap-3">
                <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold">1</span>
                <label for="pdSchoolSelect" class="text-sm text-gray-600">选择学校</label>
                <select id="pdSchoolSelect" class="border border-gray-300 rounded px-3 py-1.5 text-sm min-w-[240px]">
                    <option value="">— 请选择学校 —</option>
                </select>
                <input id="pdSearch" type="text" placeholder="筛选设备编号 / 备注 / 绑定用户" class="border border-gray-300 rounded px-3 py-1.5 text-sm w-64" autocomplete="off">
                <label class="inline-flex items-center gap-1 text-xs text-gray-600" title="台账含历史绑定行；勾选后只看当前在用的设备">
                    <input id="pdOnlyActive" type="checkbox" class="rounded border-gray-300"> 仅看在用
                </label>
                <span id="pdCount" class="text-xs text-gray-500"></span>
                <span class="ml-auto flex items-center gap-2">
                    <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold">2</span>
                    <button id="pdNewBtn" type="button" data-act="new" class="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 shadow">新增设备</button>
                </span>
                <span id="pdModeHint" class="w-full text-xs text-gray-400"></span>
            </div>

            <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="bg-gray-50 text-gray-600">
                        <tr>
                            <th id="pdColSchool" class="px-4 py-3 text-left hidden">学校</th>
                            <th class="px-4 py-3 text-left">设备编号</th>
                            <th class="px-4 py-3 text-left">备注</th>
                            <th class="px-4 py-3 text-left" title="设备上报的数据将以该用户为「创建人」（审计归属），必须是该校的有效用户">绑定用户</th>
                            <th class="px-4 py-3 text-left whitespace-nowrap" title="仅当报文样本信息里认不出食堂时使用；必须是该校食堂列表中的名称">默认食堂</th>
                            <th class="px-4 py-3 text-left whitespace-nowrap" title="该设备编号的绑定有效期（台账）：变更编号时旧绑定结束、新绑定生效，历史永久保留">绑定期间</th>
                            <th class="px-4 py-3 text-center">状态</th>
                            <th class="px-4 py-3 text-left">密钥</th>
                            <th class="px-4 py-3 text-right">上传次数</th>
                            <th class="px-4 py-3 text-left">最近上传</th>
                            <th class="px-4 py-3 text-center">操作</th>
                        </tr>
                    </thead>
                    <tbody id="pdDeviceRows"></tbody>
                </table>
                <div id="pdEmptyHint" class="hidden text-center text-gray-400 py-8 text-sm">该学校尚未配置检测设备</div>
            </div>
        </div>

        <!-- 变更设备编号弹层（台账：关旧建新） -->
        <div id="pdReplaceModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
            <div class="bg-white rounded-lg shadow-2xl w-full max-w-lg">
                <div class="px-5 py-4 border-b flex items-center justify-between">
                    <h3 class="font-bold text-gray-800"><i class="fas fa-exchange-alt text-indigo-600 mr-2"></i>变更设备编号</h3>
                    <button type="button" data-act="replace-cancel" class="text-gray-500 hover:text-gray-700"><i class="fas fa-times"></i></button>
                </div>
                <div class="p-5 space-y-4">
                    <div class="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded p-3">
                        原绑定：<span id="pdReplaceFrom" class="font-medium text-gray-800"></span>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">新设备编号 <span class="text-red-500">*</span></label>
                        <input id="pdReplaceTo" type="text" class="w-full border border-gray-300 rounded px-3 py-2 text-sm" placeholder="替代设备的编号（如 VH-2B-002）" autocomplete="off">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">生效日期</label>
                        <input id="pdReplaceDate" type="date" class="w-full border border-gray-300 rounded px-3 py-2 text-sm">
                    </div>
                    <p class="text-xs text-amber-700">
                        变更后：旧绑定结束于生效日（<strong>历史保留可查</strong>），新绑定自生效日启用并签发新密钥；
                        <strong>旧密钥立即失效</strong>，请同步配置到替代设备。生效日期之前检测的数据（检测时间落在原绑定期间内）仍归原学校。
                    </p>
                    <!-- 失败原因就地展示（toast 会被 confirm/遮挡，且长文案看不清） -->
                    <p id="pdReplaceError" class="hidden text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 break-words"></p>
                </div>
                <div class="px-5 py-4 border-t flex justify-end gap-2">
                    <button type="button" data-act="replace-cancel" class="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">取消</button>
                    <button type="button" id="pdReplaceSave" data-act="replace-save" class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">确认变更</button>
                </div>
            </div>
        </div>

        <!-- 设备表单弹层 -->
        <div id="pdModal" class="hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
            <div class="bg-white rounded-lg shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
                <div class="px-5 py-4 border-b flex items-center justify-between">
                    <h3 class="font-bold text-gray-800" id="pdModalTitle">新增设备</h3>
                    <button type="button" data-pd-close class="text-gray-500 hover:text-gray-700"><i class="fas fa-times"></i></button>
                </div>
                <div class="p-5 space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">设备编号 <span class="text-red-500">*</span></label>
                        <input type="text" id="pdDeviceNo" class="w-full border border-gray-300 rounded px-3 py-2 text-sm" placeholder="如 VH-2B-001（字母/数字/连字符/下划线）" autocomplete="off">
                        <p class="text-xs text-gray-400 mt-1">同一编号同一时刻至多一条「在用」绑定（历史绑定按期间保留）；新增后编号不可修改，换设备请用「变更编号」。设备上报报文须携带同一编号。</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">备注名</label>
                        <input type="text" id="pdName" class="w-full border border-gray-300 rounded px-3 py-2 text-sm" placeholder="如 食堂快检室 1 号机" autocomplete="off">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">绑定用户 <span class="text-red-500">*</span></label>
                        <select id="pdBindingUser" class="w-full border border-gray-300 rounded px-3 py-2 text-sm"></select>
                        <p class="text-xs text-gray-400 mt-1">设备上报记录的「创建人」（审计归属），须为该校租户内有效用户。</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 mb-1">默认食堂</label>
                        <select id="pdDefaultCanteen" class="w-full border border-gray-300 rounded px-3 py-2 text-sm"></select>
                        <p class="text-xs text-gray-400 mt-1">选项来自该校食堂列表（学校管理 → 基本信息 维护）；样本信息中识别不到食堂时回落此值，不设置且无法识别时上报将被拒绝（不会写入「未知食堂」）。</p>
                        <p id="pdCanteenHint" class="text-xs text-amber-700 mt-1 hidden"></p>
                    </div>
                    <div class="border-t border-gray-100 pt-3">
                        <label class="block text-sm font-medium text-gray-700 mb-1">绑定期间 <span class="text-xs font-normal text-gray-400">（台账：起始日含当日 00:00，结束日不含当日）</span></label>
                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <span class="block text-xs text-gray-500 mb-1">起始日期</span>
                                <input type="date" id="pdValidFrom" class="w-full border border-gray-300 rounded px-3 py-2 text-sm">
                            </div>
                            <div>
                                <span class="block text-xs text-gray-500 mb-1">结束日期（留空 = 至今）</span>
                                <input type="date" id="pdValidTo" class="w-full border border-gray-300 rounded px-3 py-2 text-sm">
                            </div>
                        </div>
                        <p id="pdRangeHint" class="text-xs text-gray-400 mt-1"></p>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">限流（次/分钟）</label>
                            <input type="number" id="pdRateLimit" class="w-full border border-gray-300 rounded px-3 py-2 text-sm" min="1" max="600" value="60">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700 mb-1">IP 白名单（逗号分隔，可空）</label>
                            <input type="text" id="pdIpWhitelist" class="w-full border border-gray-300 rounded px-3 py-2 text-sm" placeholder="如 192.168.1.10,10.0.0.0/24" autocomplete="off">
                        </div>
                    </div>
                </div>
                <div class="px-5 py-4 border-t bg-gray-50 flex justify-end gap-3">
                    <button type="button" data-pd-close class="px-4 py-2 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300">取消</button>
                    <button type="button" id="pdSaveBtn" class="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"><i class="fas fa-save mr-1"></i>保存</button>
                </div>
            </div>
        </div>

        <!-- 密钥展示弹层（仅出现一次） -->
        <div id="pdKeyModal" class="hidden fixed inset-0 bg-black bg-opacity-60 z-[60] flex items-center justify-center p-4">
            <div class="bg-white rounded-lg shadow-2xl w-full max-w-lg">
                <div class="px-5 py-4 border-b bg-amber-50 rounded-t-lg">
                    <h3 class="font-bold text-amber-800"><i class="fas fa-key mr-2"></i><span id="pdKeyModalTitle">设备密钥（仅此一次展示）</span></h3>
                </div>
                <div class="p-5 space-y-3">
                    <p class="text-sm text-gray-600">请立即复制并安全交付给设备部署人员；关闭后无法再次查看，遗失只能轮换新密钥。</p>
                    <div class="flex items-stretch gap-2">
                        <input type="text" id="pdKeyPlain" readonly class="flex-1 border border-amber-300 bg-amber-50 rounded px-3 py-2 text-sm font-mono">
                        <button type="button" id="pdKeyCopy" class="px-3 py-2 text-sm bg-amber-500 text-white rounded hover:bg-amber-600"><i class="fas fa-copy mr-1"></i>复制</button>
                    </div>
                    <div class="bg-gray-50 border rounded p-3 text-xs text-gray-600 space-y-1">
                        <div><b>上传地址：</b><code class="font-mono">POST ${UPLOAD_ENDPOINT}</code></div>
                        <div><b>请求头：</b><code class="font-mono">X-API-Key: &lt;上述密钥&gt;</code></div>
                        <div><b>Content-Type：</b><code class="font-mono">application/json</code></div>
                    </div>
                </div>
                <div class="px-5 py-4 border-t bg-gray-50 flex justify-end">
                    <button type="button" id="pdKeyDone" class="px-4 py-2 text-sm bg-gray-700 text-white rounded hover:bg-gray-800">我已保存</button>
                </div>
            </div>
        </div>

        <!-- 接口使用指导弹层（界面内容与「下载 MD 文档」同源：GUIDE_MD） -->
        <div id="pdGuideModal" class="hidden fixed inset-0 bg-black bg-opacity-60 z-[60] flex items-center justify-center p-4">
            <div class="bg-white rounded-lg shadow-2xl w-full max-w-4xl max-h-[88vh] flex flex-col">
                <div class="px-5 py-4 border-b flex items-center justify-between">
                    <h3 class="font-bold text-gray-800"><i class="fas fa-book-open text-indigo-500 mr-2"></i>接口使用指导（设备上传）</h3>
                    <div class="flex items-center gap-2">
                        <button type="button" id="pdGuideDownload" class="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"><i class="fas fa-download mr-1"></i>下载 MD 文档</button>
                        <button type="button" data-pd-close class="text-gray-500 hover:text-gray-700" title="关闭"><i class="fas fa-times"></i></button>
                    </div>
                </div>
                <div id="pdGuideBody" class="px-5 py-4 overflow-y-auto flex-1 min-h-0"></div>
                <div class="px-5 py-3 border-t bg-gray-50 text-xs text-gray-500">本指导与「下载 MD 文档」内容同源（接口地址已按当前站点自动替换）；口径如有调整，以平台最新发布为准。</div>
            </div>
        </div>`;
    }

    function renderSchoolOptions() {
        const sel = el('pdSchoolSelect');
        if (!sel) return;
        sel.innerHTML = '<option value="">— 请选择学校 —</option>' +
            `<option value="${ALL_SCHOOLS}" ${state.schoolCode === ALL_SCHOOLS ? 'selected' : ''}>全部学校（跨校查看）</option>` +
            state.schools.map((s) => `<option value="${escapeHtml(s.code)}" ${s.code === state.schoolCode ? 'selected' : ''}>${escapeHtml(s.name || s.code)}（${escapeHtml(s.code)}）${s.status !== 'active' ? '［已停用］' : ''}</option>`).join('');
    }

    function renderRows() {
        const tbody = el('pdDeviceRows');
        const empty = el('pdEmptyHint');
        if (!tbody) return;
        // 跨校视图（全部学校）：多出一列「学校」用于区分归属
        const showSchool = state.schoolCode === ALL_SCHOOLS;
        const schoolLabel = (code) => {
            const s = state.schools.find((x) => x.code === code);
            const dis = s && s.status !== 'active' ? ' <span class="text-xs text-red-600">［已停用］</span>' : '';
            return `${escapeHtml(s ? (s.name || s.code) : code)} <span class="text-gray-400">（${escapeHtml(code)}）</span>${dis}`;
        };
        const schoolName = (code) => {
            const s = state.schools.find((x) => x.code === code);
            return s ? (s.name || s.code) : code;
        };
        // 客户端筛选：设备编号 / 备注 / 绑定用户 / 学校名（跨校视图下尤其实用）
        const kw = String(state.keyword || '').trim().toLowerCase();
        // 台账视图：默认列出全部（含历史），「仅看在用」可过滤；排序为 在用优先 → 学校 → 绑定起始倒序
        const stateRank = (d) => (d.binding_state === 'active' ? 0 : (d.binding_state === 'ended' ? 1 : 2));
        const list = (kw
            ? state.devices.filter((d) => [d.device_no, d.name, d.binding_user_id, d.school_code, schoolName(d.school_code)]
                .some((v) => String(v || '').toLowerCase().includes(kw)))
            : state.devices.slice())
            .filter((d) => (state.onlyActive ? d.binding_state === 'active' : true))
            .sort((a, b) => {
                const r = stateRank(a) - stateRank(b);
                if (r !== 0) return r;
                const s = String(a.school_code || '').localeCompare(String(b.school_code || ''));
                if (s !== 0) return s;
                return String(b.valid_from || '').localeCompare(String(a.valid_from || ''));
            });
        const counter = el('pdCount');
        if (counter) counter.textContent = state.devices.length ? `显示 ${list.length} / 共 ${state.devices.length} 台` : '';
        if (empty && !list.length) {
            // 空态给出下一步动作（学校已有上下文时直接可新增）
            empty.innerHTML = kw
                ? `没有匹配「${escapeHtml(String(state.keyword).trim())}」的设备`
                : (showSchool
                    ? '全部学校尚未配置检测设备'
                    : '该学校尚未配置检测设备 · <button type="button" data-act="new" class="text-indigo-600 hover:underline">新增设备</button>');
        }
        if (!list.length) {
            tbody.innerHTML = '';
            if (empty) empty.classList.remove('hidden');
            return;
        }
        if (empty) empty.classList.add('hidden');
        tbody.innerHTML = list.map((d) => {
            const active = d.status === 'active';
            // 台账状态：停用 > 已结束 > 在用（"已结束"由 valid_to 决定）
            const bindState = d.binding_state || (active ? 'active' : 'disabled');
            const isActiveRow = bindState === 'active';
            const stateBadge = bindState === 'active'
                ? '<span class="px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">在用</span>'
                : bindState === 'ended'
                    ? '<span class="px-2 py-1 rounded-full text-xs font-medium bg-gray-200 text-gray-600" title="该绑定已结束，历史保留">已结束</span>'
                    : `<span class="px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700" title="${escapeHtml(d.disabled_reason || '')}">已停用</span>`;
            return `
            <tr class="border-t hover:bg-gray-50">
                ${showSchool ? `<td class="px-4 py-3 text-gray-700">${schoolLabel(d.school_code)}</td>` : ''}
                <td class="px-4 py-3 font-medium font-mono">${escapeHtml(d.device_no)}</td>
                <td class="px-4 py-3 text-gray-600">${escapeHtml(d.name || '—')}</td>
                <td class="px-4 py-3 text-gray-600 text-xs">
                    ${d.binding_user_name
                        ? `${escapeHtml(d.binding_user_name)}${d.binding_user_username && d.binding_user_username !== d.binding_user_name ? ` <span class="text-gray-400">（${escapeHtml(d.binding_user_username)}）</span>` : ''}${d.binding_user_status && d.binding_user_status !== 'active' ? ' <span class="text-red-600">［已停用］</span>' : ''}`
                        : `<span class="font-mono text-gray-400" title="绑定用户 ID（未解析到姓名）：${escapeHtml(d.binding_user_id || '')}">${escapeHtml(d.binding_user_id ? `${String(d.binding_user_id).slice(0, 8)}…` : '—')}</span>`}
                </td>
                <td class="px-4 py-3 text-gray-600 whitespace-nowrap">${escapeHtml(d.default_canteen || '—')}</td>
                <td class="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                    <button type="button" class="text-indigo-600 hover:underline" data-act="edit-range" data-id="${escapeHtml(d.id)}" title="调整绑定期间（起始 / 结束日期）"><i class="fas fa-calendar-alt mr-1"></i>${escapeHtml(d.binding_range || `${fmtDay(d.valid_from)} ~ ${d.valid_to ? fmtDay(d.valid_to) : '至今'}`)}</button>
                </td>
                <td class="px-4 py-3 text-center">${stateBadge}</td>
                <td class="px-4 py-3 text-xs font-mono text-gray-500">${escapeHtml(d.key_prefix)}…${escapeHtml(d.key_last4)}</td>
                <td class="px-4 py-3 text-right">${Number(d.upload_count || 0)}</td>
                <td class="px-4 py-3 text-gray-500 text-xs">${fmtTime(d.last_upload_at)}</td>
                <td class="px-4 py-3 text-center whitespace-nowrap">
                    ${isActiveRow ? `
                    <button class="px-2.5 py-1.5 text-xs bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100" data-act="replace" data-id="${escapeHtml(d.id)}" title="设备故障换替代设备：结束当前绑定并启用新设备编号（历史保留）"><i class="fas fa-exchange-alt mr-1"></i>变更编号</button>` : ''}
                    <button class="px-2.5 py-1.5 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100" data-act="edit" data-id="${escapeHtml(d.id)}"><i class="fas fa-edit mr-1"></i>编辑</button>
                    ${isActiveRow ? `
                    <button class="px-2.5 py-1.5 text-xs bg-amber-50 text-amber-700 rounded hover:bg-amber-100" data-act="rotate" data-id="${escapeHtml(d.id)}" title="轮换后旧密钥立即失效"><i class="fas fa-key mr-1"></i>轮换</button>
                    <button class="px-2.5 py-1.5 text-xs ${active ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-green-50 text-green-700 hover:bg-green-100'}" data-act="toggle" data-id="${escapeHtml(d.id)}">${active ? '停用' : '启用'}</button>
                    <button class="px-2.5 py-1.5 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200" data-act="close" data-id="${escapeHtml(d.id)}" title="设备报废/退租：结束绑定但不新增设备（历史保留）"><i class="fas fa-stop-circle mr-1"></i>结束绑定</button>` : ''}
                    <button class="px-2.5 py-1.5 text-xs bg-red-50 text-red-700 rounded hover:bg-red-100" data-act="del" data-id="${escapeHtml(d.id)}" ${isActiveRow ? '' : 'title="删除历史绑定行（将丢失台账记录，建议保留）"'}><i class="fas fa-trash mr-1"></i>删除</button>
                </td>
            </tr>`;
        }).join('');
    }

    function renderAll() {
        renderSchoolOptions();
        const allMode = state.schoolCode === ALL_SCHOOLS;
        // 「学校」列仅在跨校视图（全部学校）下显示
        el('pdColSchool')?.classList.toggle('hidden', !allMode);
        // 「新增设备」必须落到具体学校：跨校/未选时禁用，避免动作悬空
        const canCreate = !!state.schoolCode && !allMode;
        const nb = el('pdNewBtn');
        if (nb) {
            nb.disabled = !canCreate;
            nb.classList.toggle('opacity-50', !canCreate);
            nb.classList.toggle('cursor-not-allowed', !canCreate);
            nb.title = canCreate ? '为当前学校新增一个设备编号' : '跨校视图不可新增：请先在上方选择一个具体学校';
        }
        const hint = el('pdModeHint');
        if (hint) {
            if (allMode) {
                hint.textContent = `跨校视图：显示全部 ${state.schools.length} 所学校的设备；要新增设备请先切到具体学校。`;
            } else if (state.schoolCode) {
                const s = state.schools.find((x) => x.code === state.schoolCode);
                hint.textContent = `当前学校：${s ? (s.name || s.code) : state.schoolCode}（${state.schoolCode}）· 停用学校下的设备上传会被拒绝。`;
            } else {
                hint.textContent = '请选择学校（或「全部学校」跨校查看）以查看/配置设备。';
            }
        }
        renderRows();
    }

    /* ─────────── 弹层 ─────────── */
    async function openModal(device) {
        state.editing = device || null;
        // 跨校视图（全部学校）下编辑：按该设备所属学校即时加载「绑定用户候选 / 食堂名单」
        if (device && state.schoolCode === ALL_SCHOOLS && device.school_code) {
            await loadSchoolContextFor(device.school_code);
        }
        const modal = el('pdModal');
        if (!modal) return;
        el('pdModalTitle').textContent = device ? `编辑设备 ${device.device_no}` : '新增设备';
        el('pdDeviceNo').value = device?.device_no || '';
        el('pdDeviceNo').disabled = !!device;
        el('pdName').value = device?.name || '';
        // 绑定期间（台账）：新增只定起始日（结束日留空=在用，后续可编辑）；编辑时两段均可改。
        const fromEl = el('pdValidFrom');
        const toEl = el('pdValidTo');
        const rangeHint = el('pdRangeHint');
        if (fromEl) fromEl.value = device ? dayValue(device.valid_from) : todayLocal();
        if (toEl) {
            toEl.disabled = !device;
            toEl.value = device ? dayValue(device.valid_to) : '';
        }
        if (rangeHint) {
            rangeHint.textContent = device
                ? `当前：${device.binding_range || `${fmtDay(device.valid_from)} ~ ${device.valid_to ? fmtDay(device.valid_to) : '至今'}`}。改期间会影响「检测时间落在哪段区间」的归属：缩短期间后，落在区间外的报文将被拒绝（DEVICE_BINDING_EXPIRED）；清空结束日期 = 恢复为「在用」。`
                : '设备自起始日期起生效（留空则按保存时刻）；结束日期由「结束绑定 / 变更编号」或保存后在「编辑」中调整。';
        }
        // 绑定用户下拉（无用户列表时退化为手工输入 id）
        const userSel = el('pdBindingUser');
        if (state.users.length) {
            userSel.innerHTML = state.users.map((u) =>
                `<option value="${escapeHtml(u.id)}" ${device?.binding_user_id === u.id ? 'selected' : ''}>${escapeHtml(u.full_name || u.username)}（${escapeHtml(u.username)} / ${escapeHtml(u.role)}${u.status !== 'active' ? ' / 已停用' : ''}）</option>`).join('');
        } else {
            userSel.innerHTML = `<option value="${escapeHtml(device?.binding_user_id || '')}">${escapeHtml(device?.binding_user_id || '（未获取到用户列表，请手工输入用户 ID）')}</option>`;
        }
        // 默认食堂下拉
        const canSel = el('pdDefaultCanteen');
        const canteenOpts = ['<option value="">— 不设置 —</option>']
            .concat(state.canteens.map((c) => `<option value="${escapeHtml(c)}" ${device?.default_canteen === c ? 'selected' : ''}>${escapeHtml(c)}</option>`));
        canSel.innerHTML = canteenOpts.join('');
        // 食堂名单是内置兜底时明确告知（避免管理员以为这是该校真实配置）
        const ch = el('pdCanteenHint');
        if (ch) {
            ch.classList.toggle('hidden', !state.canteensFallback);
            ch.textContent = state.canteensFallback
                ? `该校尚未配置食堂列表，暂用默认名单（${state.canteens.join('、')}）；如与实际不符，请先在 学校管理 → 基本信息 维护食堂列表。`
                : '';
        }
        el('pdRateLimit').value = device?.rate_limit_per_min || 60;
        el('pdIpWhitelist').value = Array.isArray(device?.ip_whitelist) ? device.ip_whitelist.join(',') : '';
        modal.classList.remove('hidden');
    }

    function closeModal() {
        el('pdModal')?.classList.add('hidden');
        el('pdGuideModal')?.classList.add('hidden');
        state.editing = null;
    }

    /* ─────────── 接口使用指导（界面与 MD 下载同源） ─────────── */
    function openGuide() {
        const body = el('pdGuideBody');
        if (body) body.innerHTML = renderMdBlocks(GUIDE_MD.replace(/<平台域名>/g, location.origin).split('\n'));
        el('pdGuideModal')?.classList.remove('hidden');
    }

    function downloadGuide() {
        const text = GUIDE_MD.replace(/<平台域名>/g, location.origin);
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `pathogen-device-api-guide-${new Date().toISOString().slice(0, 10)}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
        notify('指导文档已下载（可直接交付设备方）', 'success');
    }

    function showKeyModal(plain, title) {
        const modal = el('pdKeyModal');
        if (!modal) return;
        if (title && el('pdKeyModalTitle')) el('pdKeyModalTitle').textContent = title;
        el('pdKeyPlain').value = plain;
        modal.classList.remove('hidden');
    }

    /* ─────────── 统一上传密钥（B 方案） ─────────── */
    async function loadPlatformKey() {
        try {
            const data = await api('/platform-key');
            state.platformKey = data?.key || null;
            renderPlatformKey();
        } catch (e) {
            const badge = el('pdPkBadge');
            if (badge) { badge.textContent = '加载失败'; badge.className = 'ml-2 px-2 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700'; }
        }
    }

    function renderPlatformKey() {
        const badge = el('pdPkBadge');
        const meta = el('pdPkMeta');
        const toggleBtn = document.querySelector('[data-act="pk-toggle"]');
        const k = state.platformKey;
        if (!badge) return;
        if (!k) {
            badge.textContent = '未创建';
            badge.className = 'ml-2 px-2 py-1 rounded-full text-xs font-medium bg-gray-200 text-gray-600';
            if (meta) meta.textContent = '';
            if (toggleBtn) { toggleBtn.textContent = '停用'; toggleBtn.disabled = true; }
            return;
        }
        const active = k.status === 'active';
        badge.textContent = active ? '已启用' : '已停用';
        badge.className = active
            ? 'ml-2 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700'
            : 'ml-2 px-2 py-1 rounded-full text-xs font-medium bg-gray-200 text-gray-600';
        if (meta) meta.textContent = `${k.key_prefix}…${k.key_last4}${k.last_used_at ? ` · 最近使用 ${fmtTime(k.last_used_at)}` : ''}`;
        if (toggleBtn) { toggleBtn.textContent = active ? '停用' : '启用'; toggleBtn.disabled = false; }
    }

    async function createPlatformKey() {
        const existing = state.platformKey && state.platformKey.status === 'active';
        const msg = existing
            ? '轮换统一上传密钥？\n\n新密钥仅显示一次；旧密钥立即失效，所有设备需同步更新配置。'
            : '创建统一上传密钥？\n\n密钥仅显示一次，请立即抄录并配置到设备上传程序。';
        if (!window.confirm(msg)) return;
        try {
            const data = await api('/platform-key', { method: 'POST', body: {} });
            showKeyModal(data.apiKey, existing ? '统一上传密钥·新密钥（仅此一次展示）' : '统一上传密钥（仅此一次展示）');
            notify(data.rotated ? '✅ 已轮换，旧密钥已失效' : '✅ 统一上传密钥已创建', 'success');
            await loadPlatformKey();
        } catch (e) {
            notify(`创建失败：${e.message}`, 'error');
        }
    }

    async function togglePlatformKey() {
        const k = state.platformKey;
        if (!k) return;
        const next = k.status === 'active' ? 'disabled' : 'active';
        if (next === 'disabled' && !window.confirm('停用统一上传密钥？\n\n停用后，使用该密钥的所有设备上传都将被拒绝（每设备密钥模式不受影响）。')) return;
        try {
            await api('/platform-key', { method: 'PATCH', body: { status: next } });
            notify(next === 'active' ? '✅ 已启用' : '已停用', 'success');
            await loadPlatformKey();
        } catch (e) {
            notify(`操作失败：${e.message}`, 'error');
        }
    }

    /* ─────────── 台账：变更设备编号 / 结束绑定 ─────────── */
    function todayLocal() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    /** 日期 +N 天（YYYY-MM-DD 本地口径）。 */
    function addDays(day, n) {
        if (!day) return '';
        const [y, m, d] = String(day).split('-').map(Number);
        if (!y || !m || !d) return '';
        const dt = new Date(y, m - 1, d + n);
        const p = (x) => String(x).padStart(2, '0');
        return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
    }

    function setReplaceError(msg) {
        const box = el('pdReplaceError');
        if (!box) return;
        box.textContent = msg || '';
        box.classList.toggle('hidden', !msg);
    }

    function setReplaceBusy(busy) {
        state.replaceBusy = !!busy;
        const btn = el('pdReplaceSave');
        if (!btn) return;
        btn.disabled = !!busy;
        btn.classList.toggle('opacity-60', !!busy);
        btn.classList.toggle('cursor-not-allowed', !!busy);
        btn.textContent = busy ? '处理中…' : '确认变更';
    }

    function openReplaceModal(row) {
        if (!row) return;
        state.replacing = row;
        state.replaceBusy = false;
        const modal = el('pdReplaceModal');
        if (!modal) return;
        el('pdReplaceFrom').textContent = `${row.device_no}（${row.school_code} · ${row.binding_range || ''}）`;
        el('pdReplaceTo').value = '';
        // 生效日期必须「晚于」原绑定起始日：给日期框设下限（次日），避免选了同一天被后端 400 打回
        const minDay = addDays(dayValue(row.valid_from), 1);
        const dateEl = el('pdReplaceDate');
        dateEl.value = todayLocal();
        if (minDay) dateEl.min = minDay;
        if (minDay && dateEl.value && dateEl.value < minDay) dateEl.value = minDay;
        setReplaceError('');
        setReplaceBusy(false);
        modal.classList.remove('hidden');
        el('pdReplaceTo')?.focus();
    }

    async function submitReplace() {
        const row = state.replacing;
        if (!row) return;
        // 连点防护：变更是一次性事务，重复提交必然撞「已结束 / 已在用」返回 400，白白误导用户
        if (state.replaceBusy) return;
        const newNo = el('pdReplaceTo').value.trim();
        const date = el('pdReplaceDate').value;
        setReplaceError('');
        if (!newNo) { setReplaceError('请填写新的设备编号'); return; }
        if (!date) { setReplaceError('请选择生效日期'); return; }
        const minDay = addDays(dayValue(row.valid_from), 1);
        if (minDay && date < minDay) {
            setReplaceError(`生效日期必须晚于原绑定起始日（${dayValue(row.valid_from)}），最早可选 ${minDay}`);
            return;
        }
        if (!window.confirm(`确认变更设备编号？\n\n原编号：${row.device_no}\n新编号：${newNo}\n生效日期：${date}\n\n旧密钥将于生效日失效，请把新密钥配置到替代设备。`)) return;
        setReplaceBusy(true);
        try {
            const data = await api(`/${encodeURIComponent(row.id)}/replace`, {
                method: 'POST',
                body: { new_device_no: newNo, effective_date: date },
            });
            el('pdReplaceModal')?.classList.add('hidden');
            state.replacing = null;
            if (data?.apiKey) showKeyModal(data.apiKey, `变更后的设备密钥 · ${newNo}（仅此一次展示）`);
            notify(`✅ 已变更：${row.device_no} 结束于 ${date}，${newNo} 自该日生效`, 'success');
            await load();
        } catch (e) {
            // 失败大概率是页面数据陈旧（该行已被结束/新编号已在用）：就地说明原因 + 刷新台账，让用户看到真实状态
            setReplaceError(e.message);
            notify(`变更失败：${e.message}`, 'error');
            try { await load(); } catch { /* 刷新失败不影响错误展示 */ }
            // 刷新后原行若已结束（或已不存在），弹层失去意义 → 直接收起
            const fresh = state.devices.find((d) => d.id === row.id);
            if (!fresh || fresh.binding_state !== 'active') {
                el('pdReplaceModal')?.classList.add('hidden');
                state.replacing = null;
            }
        } finally {
            setReplaceBusy(false);
        }
    }

    async function closeBinding(id) {
        const row = state.devices.find((d) => d.id === id);
        if (!row) return;
        const input = window.prompt(
            `结束绑定：${row.device_no}（${row.school_code}）\n\n请输入结束日期（YYYY-MM-DD，默认今天）。\n结束后历史记录保留；该编号只接受「检测时间落在原绑定期间内」的补传数据。`,
            todayLocal(),
        );
        if (input === null) return;
        const date = String(input).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { notify('日期格式应为 YYYY-MM-DD', 'error'); return; }
        try {
            await api(`/${encodeURIComponent(id)}/close`, { method: 'POST', body: { end_date: date } });
            notify('✅ 已结束绑定（历史保留）', 'success');
            await load();
        } catch (e) {
            notify(`结束绑定失败：${e.message}`, 'error');
        }
    }

    async function submit() {
        const deviceNo = el('pdDeviceNo').value.trim();
        const bindingSel = el('pdBindingUser');
        const bindingUserId = bindingSel.value;
        const body = {
            binding_user_id: bindingUserId,
            name: el('pdName').value.trim(),
            default_canteen: el('pdDefaultCanteen').value || null,
            rate_limit_per_min: Number(el('pdRateLimit').value) || 60,
            ip_whitelist: el('pdIpWhitelist').value.split(',').map((s) => s.trim()).filter(Boolean),
        };
        // 绑定期间（本地日期；结束日留空 = 至今）
        const validFrom = el('pdValidFrom')?.value || '';
        const validTo = el('pdValidTo')?.value || '';
        if (validFrom && validTo && validTo <= validFrom) {
            notify('绑定结束日期必须晚于起始日期', 'error');
            return;
        }
        if (validFrom) body.valid_from = validFrom;
        if (state.editing) {
            // 已结束的绑定被清空结束日期 = 恢复为「在用」，先明确确认（会影响区间归属）
            if (state.editing.valid_to && !validTo && !window.confirm(
                `该绑定原已结束于 ${fmtDay(state.editing.valid_to)}。\n\n清空结束日期将把它恢复为「在用」绑定（设备重新可用；若该编号另有在用绑定，将因区间重叠被拒绝）。是否继续？`,
            )) return;
            body.valid_to = validTo || null;
        }
        try {
            if (state.editing) {
                const data = await api(`/${encodeURIComponent(state.editing.id)}`, { method: 'PATCH', body });
                const range = data?.binding_range ? `（${data.binding_range}）` : '';
                notify(`✅ 设备已更新${range}`, 'success');
                closeModal();
            } else {
                if (!deviceNo) { notify('请填写设备编号', 'error'); return; }
                if (!state.schoolCode || state.schoolCode === ALL_SCHOOLS) { notify('请先选择具体的学校租户', 'error'); return; }
                body.device_no = deviceNo;
                body.school_code = state.schoolCode;
                const data = await api('', { method: 'POST', body });
                closeModal();
                if (data?.apiKey) showKeyModal(data.apiKey, '设备密钥（仅此一次展示）');
                notify('✅ 设备已创建', 'success');
            }
            await load();
        } catch (e) {
            notify(`保存失败：${e.message}`, 'error');
        }
    }

    async function rotate(id) {
        const row = state.devices.find((d) => d.id === id);
        if (!row) return;
        if (!window.confirm(`轮换设备「${row.device_no}」的密钥？\n\n旧密钥将立即失效，设备须更换为新密钥后才能继续上报。`)) return;
        try {
            const data = await api(`/${encodeURIComponent(id)}/rotate-key`, { method: 'POST', body: {} });
            if (data?.apiKey) showKeyModal(data.apiKey, '设备密钥·新密钥（仅此一次展示）');
            notify('✅ 已轮换密钥', 'success');
            await load();
        } catch (e) {
            notify(`轮换失败：${e.message}`, 'error');
        }
    }

    async function toggle(id) {
        const row = state.devices.find((d) => d.id === id);
        if (!row) return;
        const next = row.status === 'active' ? 'disabled' : 'active';
        const reason = next === 'disabled' ? window.prompt('停用原因（可选）：') || '' : '';
        try {
            await api(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: next, disabled_reason: reason || null } });
            notify(next === 'active' ? '✅ 已启用，设备可恢复上报' : '已停用，设备上报将被拒绝', 'success');
            await load();
        } catch (e) {
            notify(`状态切换失败：${e.message}`, 'error');
        }
    }

    async function remove(id) {
        const row = state.devices.find((d) => d.id === id);
        if (!row) return;
        if (!window.confirm(`确认删除设备「${row.device_no}」？\n\n删除后该设备无法再上报；已上传的记录不受影响。`)) return;
        try {
            await api(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
            notify('🗑️ 设备已删除', 'success');
            await load();
        } catch (e) {
            notify(`删除失败：${e.message}`, 'error');
        }
    }

    async function exportConfig() {
        try {
            const data = await api('/export');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `pathogen-devices-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            notify('✅ 已导出（含密钥哈希，不含明文；用于灾后重建）', 'success');
        } catch (e) {
            notify(`导出失败：${e.message}`, 'error');
        }
    }

    /* ─────────── 事件绑定（委托到宿主 section，避免重渲染失效） ─────────── */
    function bindEvents() {
        const host = el('adminViewPathogenDevices');
        if (!host || host.dataset.pdBound === '1') return;
        host.dataset.pdBound = '1';

        host.addEventListener('click', async (ev) => {
            if (ev.target.closest('[data-pd-close]')) { closeModal(); return; }
            const btn = ev.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.getAttribute('data-act');
            const id = btn.getAttribute('data-id');
            if (act === 'new') {
                // 新增必须落到某个学校（设备编号→学校绑定）；跨校视图下先让用户选具体学校
                if (state.schoolCode === ALL_SCHOOLS || !state.schoolCode) {
                    notify('请先在上方「学校租户」中选择一个具体学校，再新增设备', 'error');
                    return;
                }
                return openModal(null);
            }
            if (act === 'guide') return openGuide();
            if (act === 'pk-create') return createPlatformKey();
            if (act === 'pk-toggle') return togglePlatformKey();
            if (act === 'pk-panel') { el('pdPkPanel')?.classList.toggle('hidden'); return; }
            if (act === 'refresh') { await loadSchools(); renderSchoolOptions(); await load(); return; }
            if (act === 'export') return exportConfig();
            if (act === 'edit') return openModal(state.devices.find((d) => d.id === id) || null);
            // 「绑定期间」单元格直达：打开编辑弹层并把焦点放到起始日期（期间可编辑）
            if (act === 'edit-range') {
                await openModal(state.devices.find((d) => d.id === id) || null);
                el('pdValidFrom')?.focus();
                return;
            }

            if (act === 'rotate') return rotate(id);
            if (act === 'toggle') return toggle(id);
            if (act === 'del') return remove(id);
            if (act === 'replace') return openReplaceModal(state.devices.find((d) => d.id === id) || null);
            if (act === 'close') return closeBinding(id);
            if (act === 'replace-cancel') {
                if (state.replaceBusy) return; // 请求在途时不允许关闭弹层（避免用户以为已取消）
                el('pdReplaceModal')?.classList.add('hidden');
                state.replacing = null;
                setReplaceError('');
                return;
            }
            if (act === 'replace-save') return submitReplace();
        });

        const schoolSel = el('pdSchoolSelect');
        schoolSel?.addEventListener('change', async () => {
            state.schoolCode = schoolSel.value;
            await loadSchoolContext();
            await load();
        });

        // 设备列表客户端筛选（不触发服务端请求）
        el('pdSearch')?.addEventListener('input', (e) => {
            state.keyword = e.target.value || '';
            renderRows();
        });

        // 台账：仅看在用
        el('pdOnlyActive')?.addEventListener('change', (e) => {
            state.onlyActive = !!e.target.checked;
            renderRows();
        });

        el('pdSaveBtn')?.addEventListener('click', submit);
        el('pdKeyDone')?.addEventListener('click', () => el('pdKeyModal')?.classList.add('hidden'));
        el('pdGuideDownload')?.addEventListener('click', downloadGuide);
        el('pdKeyCopy')?.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(el('pdKeyPlain').value);
                notify('已复制到剪贴板', 'success');
            } catch {
                el('pdKeyPlain').select();
                notify('请手动复制', 'error');
            }
        });
    }

    renderSkeleton();
    bindEvents();
    loadPlatformKey();
    (async () => {
        try {
            await loadSchools();
            // 默认「全部学校」：进页面先给全局概览，而不是随机落在一所学校看到空表
            state.schoolCode = ALL_SCHOOLS;
            renderAll();
            await load();
        } catch (e) {
            notify(`学校列表加载失败：${e.message}`, 'error');
        }
    })();

    return { reload: load };
}
