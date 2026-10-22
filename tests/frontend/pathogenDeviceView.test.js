/**
 * 病原体设备配置视图 · 交互逻辑回归（2026-10-16）
 *
 * 需求：学校筛选支持跨校查看；界面按「① 选学校 → ② 新增设备」的操作顺序重排。
 *  默认进入「全部学校」总览；新增动作跟随学校上下文（跨校时禁用并说明原因）；
 *  设备列表支持客户端筛选；空态给出下一步动作。
 */
import { initPathogenDeviceView } from '../../frontend/js/modules/adminSchools/views/pathogenDeviceView.js';

const SCHOOLS = [
    { code: 'school-a', name: '甲中学', status: 'active' },
    { code: 'school-b', name: '乙中学', status: 'active' },
    { code: 'school-c', name: '丙中学', status: 'active' },
];
const DEVICES = [
    { id: 'd1', school_code: 'school-a', device_no: 'VH-A-001', name: '甲校设备', binding_state: 'active', valid_from: '2025-01-01T00:00:00', valid_to: null, binding_range: '2025-01-01 ~ 至今', binding_user_id: 'u1', binding_user_name: '郭仁康', binding_user_username: 'renkang', binding_user_status: 'active', default_canteen: '一食堂', status: 'active', key_prefix: 'pdv_aaaa', key_last4: '1111', upload_count: 1, last_upload_at: null, ip_whitelist: [], rate_limit_per_min: 60 },
    { id: 'd2', school_code: 'school-b', device_no: 'VH-B-001', name: '乙校设备', binding_state: 'ended', valid_from: '2025-01-01T00:00:00', valid_to: '2026-09-30T00:00:00', binding_range: '2025-01-01 ~ 2026-09-30', binding_user_id: 'b26f1ea6-cd54-49ae-b716-632cc247ffab', binding_user_name: null, binding_user_username: null, binding_user_status: null, default_canteen: '二食堂', status: 'active', key_prefix: 'pdv_bbbb', key_last4: '2222', upload_count: 2, last_upload_at: null, ip_whitelist: [], rate_limit_per_min: 60 },
    { id: 'd3', school_code: 'school-a', device_no: 'VH-A-002', name: '甲校设备2', binding_state: 'active', valid_from: '2025-06-01T00:00:00', valid_to: null, binding_range: '2025-06-01 ~ 至今', binding_user_id: 'u3', binding_user_name: 'renkang', binding_user_username: 'renkang', binding_user_status: 'disabled', default_canteen: '二食堂', status: 'active', key_prefix: 'pdv_cccc', key_last4: '3333', upload_count: 0, last_upload_at: null, ip_whitelist: [], rate_limit_per_min: 60 },
];

const flush = async (times = 5) => { for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0)); };

function setupFetchSpy() {
    const calls = [];
    // 写操作留档：{ url, method, body }（断言 PATCH 报文用；calls 仍保持纯 URL 便于既有断言）
    const writes = [];
    global.fetch = async (url, init = {}) => {
        const u = String(url);
        calls.push(u);
        if (init && init.method && init.method !== 'GET') {
            let parsed = null;
            try { parsed = init.body ? JSON.parse(init.body) : null; } catch { parsed = init.body; }
            writes.push({ url: u, method: init.method, body: parsed });
        }
        global.fetch.writes = writes;
        const json = (body) => ({ ok: true, status: 200, json: async () => body });
        if (u.includes('/api/admin/schools?')) return json({ success: true, data: SCHOOLS });
        if (u.includes('/platform-key')) return json({ success: true, data: { exists: false, key: null } });
        if (u.includes('/customization')) {
            const m = /\/schools\/([^/]+)\/customization/.exec(u);
            const code = m ? decodeURIComponent(m[1]) : '';
            const canteens = code === 'school-a' ? ['教工餐厅', '学生餐厅'] : []; // 其余校未配置 → 前端内置兜底
            return json({ success: true, data: { canteens, field_options: {} } });
        }
        if (u.includes('/replace')) {
            // 失败路径可注入（模拟「该绑定已结束 / 新编号已在用」等 400）
            if (global.__replaceFail) {
                return { ok: false, status: 400, json: async () => ({ success: false, error: global.__replaceFail }) };
            }
            return json({ success: true, data: { apiKey: 'pdv_NEWKEY_abcdefghijklmnopqrstuvwxyz012345678', device: { id: 'd1-new', device_no: 'VH-A-002' } } });
        }
        if (u.includes('/close')) return json({ success: true, data: { id: 'd1', binding_state: 'ended' } });
        if (u.includes('/api/admin/pathogen-devices')) {
            const m = /school_code=([^&]+)/.exec(u);
            const list = m ? DEVICES.filter((d) => d.school_code === decodeURIComponent(m[1])) : DEVICES; // 不带 school_code → 全部
            return json({ success: true, data: list });
        }
        return json({ success: true, data: [] });
    };
    return calls;
}

async function mount() {
    document.body.innerHTML = '<div id="adminViewPathogenDevices"></div>';
    const notify = jest.fn();
    const calls = setupFetchSpy();
    initPathogenDeviceView({ API_BASE: '', authHeaders: () => ({}), notify });
    await flush();
    return { notify, calls, writes: global.fetch.writes };
}

const chooseSchool = async (code) => {
    const sel = document.getElementById('pdSchoolSelect');
    sel.value = code;
    sel.dispatchEvent(new Event('change'));
    await flush();
};

const listCalls = (calls) => calls.filter((u) => u.includes('/api/admin/pathogen-devices') && !u.includes('platform-key'));

describe('病原体设备视图 · 学校筛选与操作顺序', () => {
    test('① 默认进入「全部学校」跨校视图：请求不带 school_code，两校设备同屏且显示「学校」列', async () => {
        const { calls } = await mount();

        expect(document.getElementById('pdSchoolSelect').value).toBe('__all__');
        const last = listCalls(calls).pop();
        expect(last).toBeDefined();
        expect(last).not.toContain('school_code');

        const rows = document.getElementById('pdDeviceRows').innerHTML;
        expect(rows).toContain('VH-A-001');
        expect(rows).toContain('VH-B-001');
        expect(rows).toContain('甲中学');
        expect(rows).toContain('乙中学');
        expect(document.getElementById('pdColSchool').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('pdCount').textContent).toContain('共 3 台');
    });

    test('② 选择具体学校 → 请求带 school_code，隐藏「学校」列并修正模式提示', async () => {
        const { calls } = await mount();
        await chooseSchool('school-a');

        const last = listCalls(calls).pop();
        expect(last).toContain('school_code=school-a');
        const rows = document.getElementById('pdDeviceRows').innerHTML;
        expect(rows).toContain('VH-A-001');
        expect(rows).not.toContain('VH-B-001');
        expect(document.getElementById('pdColSchool').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('pdModeHint').textContent).toContain('当前学校');
    });

    test('③ 跨校视图下「新增设备」禁用并说明原因（动作不悬空，不弹表单）', async () => {
        await mount();
        const btn = document.getElementById('pdNewBtn');
        expect(btn.disabled).toBe(true);
        expect(btn.title).toContain('具体学校');
        btn.click();
        await flush(2);
        expect(document.getElementById('pdModal').classList.contains('hidden')).toBe(true);
    });

    test('④ 选定具体学校后「新增设备」可用；跨校编辑设备按其所属学校加载上下文', async () => {
        const { calls } = await mount();
        await chooseSchool('school-a');
        expect(document.getElementById('pdNewBtn').disabled).toBe(false);

        // 回到跨校视图，编辑乙校设备 → 应加载乙校用户/界面定制
        await chooseSchool('__all__');
        document.querySelector('[data-act="edit"][data-id="d2"]').click();
        await flush(5);
        expect(calls.some((u) => u.includes('/api/admin/schools/school-b/users'))).toBe(true);
        expect(document.getElementById('pdModal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('pdDeviceNo').value).toBe('VH-B-001');
    });

    test('⑤ 设备筛选框：按关键词（学校名 / 设备编号）客户端过滤', async () => {
        await mount();
        const input = document.getElementById('pdSearch');

        input.value = '乙中学';
        input.dispatchEvent(new Event('input'));
        await flush(2);
        let rows = document.getElementById('pdDeviceRows').innerHTML;
        expect(rows).toContain('VH-B-001');
        expect(rows).not.toContain('VH-A-001');
        expect(document.getElementById('pdCount').textContent).toContain('显示 1 / 共 3 台');

        input.value = 'VH-A';
        input.dispatchEvent(new Event('input'));
        await flush(2);
        rows = document.getElementById('pdDeviceRows').innerHTML;
        expect(rows).toContain('VH-A-001');
        expect(rows).not.toContain('VH-B-001');

        input.value = '不存在的设备';
        input.dispatchEvent(new Event('input'));
        await flush(2);
        expect(document.getElementById('pdEmptyHint').innerHTML).toContain('没有匹配');
    });

    test('⑥ 具体学校的空态给出「新增设备」动作入口（含按钮）', async () => {
        await mount();
        await chooseSchool('school-c'); // 该校无设备
        const hint = document.getElementById('pdEmptyHint');
        expect(hint.classList.contains('hidden')).toBe(false);
        expect(hint.innerHTML).toContain('尚未配置检测设备');
        expect(hint.innerHTML).toContain('data-act="new"'); // 空态可直接新增
    });
});

describe('病原体设备视图 · 绑定用户展示', () => {
    test('展示姓名（账号）而不是 UUID；解析不到时降级为截断 id + 完整 id 放 tooltip', async () => {
        await mount();
        const rows = document.getElementById('pdDeviceRows').innerHTML;
        expect(rows).toContain('郭仁康');
        expect(rows).toContain('（renkang）');
        expect(rows).toContain('b26f1ea6…');                                  // 降级：截断形态
        expect(rows).toContain('title="绑定用户 ID（未解析到姓名）：b26f1ea6'); // 完整 id 只放 tooltip 备查
        // 完整 UUID 不得作为可见文本出现（剔除 title 属性后再断言）
        const visible = rows.replace(/title="[^"]*"/g, '');
        expect(visible).not.toContain('b26f1ea6-cd54-49ae-b716-632cc247ffab');
        // 姓名与账号相同（只有 username）→ 不重复显示括号账号；停用用户标注
        const parenCount = rows.split('（renkang）').length - 1;
        expect(parenCount).toBe(1);
        expect(rows).toContain('［已停用］');
    });
});

describe('病原体设备视图 · 默认食堂选项来源（与手动录入同口径）', () => {
    test('学校未配置食堂列表 → 用内置默认名单，并在表单里明确提示去维护', async () => {
        await mount();
        await chooseSchool('school-b');                 // 未配置
        document.querySelector('[data-act="new"]').click();
        await flush(5);

        const opts = Array.from(document.getElementById('pdDefaultCanteen').options).map((o) => o.value);
        expect(opts).toEqual(expect.arrayContaining(['一食堂', '二食堂', '三食堂']));
        const hint = document.getElementById('pdCanteenHint');
        expect(hint.classList.contains('hidden')).toBe(false);
        expect(hint.textContent).toContain('尚未配置食堂列表');
        expect(hint.textContent).toContain('学校管理 → 基本信息');
    });

    test('学校已配置自定义食堂 → 以配置为准，且不再显示兜底提示', async () => {
        await mount();
        await chooseSchool('school-a');                 // 已配置 教工餐厅/学生餐厅
        document.querySelector('[data-act="new"]').click();
        await flush(5);

        const opts = Array.from(document.getElementById('pdDefaultCanteen').options).map((o) => o.value);
        expect(opts).toContain('教工餐厅');
        expect(opts).toContain('学生餐厅');
        expect(opts).not.toContain('一食堂');            // 内置默认不再混入
        expect(document.getElementById('pdCanteenHint').classList.contains('hidden')).toBe(true);
    });
});

describe('病原体设备视图 · 绑定台账（绑定期间 / 仅看在用 / 变更编号）', () => {
    test('绑定期间列与状态徽标：在用显示「起 ~ 至今」，已结束显示区间与「已结束」', async () => {
        await mount();
        const rows = document.getElementById('pdDeviceRows').innerHTML;
        expect(rows).toContain('2025-01-01 ~ 至今');      // d1 在用
        expect(rows).toContain('在用');
        expect(rows).toContain('2025-01-01 ~ 2026-09-30'); // d2 已结束
        expect(rows).toContain('已结束');
    });

    test('「仅看在用」勾选后过滤掉历史（已结束）绑定行', async () => {
        await mount();
        const before = document.getElementById('pdDeviceRows').innerHTML;
        expect(before).toContain('VH-B-001');              // 已结束行默认可见（台账保留历史）

        const cb = document.getElementById('pdOnlyActive');
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
        await flush(2);
        const after = document.getElementById('pdDeviceRows').innerHTML;
        expect(after).not.toContain('VH-B-001');
        expect(after).toContain('VH-A-001');
    });

    test('已结束的绑定不显示「变更编号 / 结束绑定 / 轮换」动作（仅历史可查、可删）', async () => {
        await mount();
        const rowsHtml = document.getElementById('pdDeviceRows').innerHTML;
        const endedRow = rowsHtml.split('<tr').find((r) => r.includes('VH-B-001')) || '';
        expect(endedRow).not.toContain('data-act="replace"');
        expect(endedRow).not.toContain('data-act="close"');
        expect(endedRow).not.toContain('data-act="rotate"');
        expect(endedRow).toContain('data-act="del"');

        const activeRow = rowsHtml.split('<tr').find((r) => r.includes('VH-A-001')) || '';
        expect(activeRow).toContain('data-act="replace"');
        expect(activeRow).toContain('data-act="close"');
    });

    test('变更编号流程：弹层回显原绑定 → 提交调用 replace 接口并弹出新密钥', async () => {
        const { calls } = await mount();
        document.querySelector('[data-act="replace"][data-id="d1"]').click();
        await flush(2);

        const modal = document.getElementById('pdReplaceModal');
        expect(modal.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('pdReplaceFrom').textContent).toContain('VH-A-001');
        expect(document.getElementById('pdReplaceDate').value).toMatch(/^\d{4}-\d{2}-\d{2}$/); // 默认今天

        // 填新编号 + 确认（window.confirm 桩返回 true）
        document.getElementById('pdReplaceTo').value = 'VH-A-002';
        jest.spyOn(window, 'confirm').mockReturnValue(true);
        document.querySelector('[data-act="replace-save"]').click();
        await flush(6);

        const replaceCall = calls.find((u) => u.includes('/replace'));
        expect(replaceCall).toBeTruthy();
        expect(replaceCall).toContain('/d1/replace');
        expect(document.getElementById('pdReplaceModal').classList.contains('hidden')).toBe(true);
        // 新密钥弹层（明文仅一次）
        expect(document.getElementById('pdKeyModal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('pdKeyPlain').value).toMatch(/^pdv_/);
        window.confirm.mockRestore();
    });

    test('结束绑定：确认日期后调用 close 接口', async () => {
        const { calls } = await mount();
        jest.spyOn(window, 'prompt').mockReturnValue('2026-10-16');
        document.querySelector('[data-act="close"][data-id="d1"]').click();
        await flush(6);
        const closeCall = calls.find((u) => u.includes('/close'));
        expect(closeCall).toBeTruthy();
        expect(closeCall).toContain('/d1/close');
        window.prompt.mockRestore();
    });
});

describe('病原体设备视图 · 绑定期间编辑（超管纠正 / 补录期间）', () => {
    test('编辑弹层回显绑定期间：在用行结束日期为空（= 至今），已结束行回显结束日', async () => {
        await mount();

        // 在用行（d1：2025-01-01 ~ 至今）
        document.querySelector('[data-act="edit"][data-id="d1"]').click();
        await flush(5);
        expect(document.getElementById('pdValidFrom').value).toBe('2025-01-01');
        expect(document.getElementById('pdValidTo').value).toBe('');
        expect(document.getElementById('pdValidTo').disabled).toBe(false);   // 编辑态可改
        expect(document.getElementById('pdRangeHint').textContent).toContain('至今');

        // 已结束行（d2：2025-01-01 ~ 2026-09-30）
        document.querySelector('[data-act="edit"][data-id="d2"]').click();
        await flush(5);
        expect(document.getElementById('pdValidFrom').value).toBe('2025-01-01');
        expect(document.getElementById('pdValidTo').value).toBe('2026-09-30');
    });

    test('新增弹层只开放起始日期（结束日期禁用），默认今天', async () => {
        await mount();
        await chooseSchool('school-a');
        document.querySelector('[data-act="new"]').click();
        await flush(5);
        expect(document.getElementById('pdValidFrom').value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(document.getElementById('pdValidTo').disabled).toBe(true);
        expect(document.getElementById('pdValidTo').value).toBe('');
    });

    test('保存编辑 → PATCH 报文携带 valid_from / valid_to', async () => {
        const { writes } = await mount();
        document.querySelector('[data-act="edit"][data-id="d1"]').click();
        await flush(5);
        document.getElementById('pdValidTo').value = '2026-12-31';
        document.getElementById('pdSaveBtn').click();
        await flush(6);

        const patch = writes.find((w) => w.method === 'PATCH');
        expect(patch).toBeTruthy();
        expect(patch.url).toContain('/d1');
        expect(patch.body.valid_from).toBe('2025-01-01');
        expect(patch.body.valid_to).toBe('2026-12-31');
        expect(document.getElementById('pdModal').classList.contains('hidden')).toBe(true);
    });

    test('清空「已结束」绑定的结束日期 = 恢复在用，需二次确认；取消则不提交', async () => {
        const { writes } = await mount();
        document.querySelector('[data-act="edit"][data-id="d2"]').click();
        await flush(5);

        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
        document.getElementById('pdValidTo').value = '';
        document.getElementById('pdSaveBtn').click();
        await flush(6);
        expect(confirmSpy).toHaveBeenCalled();
        expect(String(confirmSpy.mock.calls[0][0])).toContain('恢复为「在用」');
        expect(writes.some((w) => w.method === 'PATCH')).toBe(false);

        // 确认后提交：valid_to = null（后端清空结束时间）
        confirmSpy.mockReturnValue(true);
        document.getElementById('pdSaveBtn').click();
        await flush(6);
        const patch = writes.find((w) => w.method === 'PATCH');
        expect(patch.body.valid_to).toBeNull();
        confirmSpy.mockRestore();
    });

    test('结束日期早于起始日期 → 前端拦截，不发请求', async () => {
        const { writes, notify } = await mount();
        document.querySelector('[data-act="edit"][data-id="d1"]').click();
        await flush(5);
        document.getElementById('pdValidTo').value = '2024-12-01';
        document.getElementById('pdSaveBtn').click();
        await flush(4);

        expect(writes.some((w) => w.method === 'PATCH')).toBe(false);
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('必须晚于起始日期'), 'error');
    });

    test('「绑定期间」列可点击直达编辑弹层（期间编辑入口显性化）', async () => {
        await mount();
        expect(document.getElementById('pdDeviceRows').innerHTML).toContain('data-act="edit-range"');
        document.querySelector('[data-act="edit-range"][data-id="d1"]').click();
        await flush(5);
        expect(document.getElementById('pdModal').classList.contains('hidden')).toBe(false);
        expect(document.activeElement.id).toBe('pdValidFrom');
    });
});

describe('病原体设备视图 · 变更编号的健壮性（连点防护 / 失败原因可见 / 生效日下限）', () => {
    afterEach(() => { delete global.__replaceFail; jest.restoreAllMocks(); });

    test('生效日期下限 = 原绑定起始日次日（避免选同一天被后端 400 打回）', async () => {
        await mount();
        document.querySelector('[data-act="replace"][data-id="d1"]').click();
        await flush(2);
        const dateEl = document.getElementById('pdReplaceDate');
        expect(dateEl.min).toBe('2025-01-02');                     // d1 valid_from = 2025-01-01
        expect(dateEl.value >= dateEl.min).toBe(true);
    });

    test('连点「确认变更」只发一次请求（重复提交会撞「已结束 / 已在用」）', async () => {
        const { writes } = await mount();
        jest.spyOn(window, 'confirm').mockReturnValue(true);
        document.querySelector('[data-act="replace"][data-id="d1"]').click();
        await flush(2);
        document.getElementById('pdReplaceTo').value = 'VH-A-900';

        const save = document.getElementById('pdReplaceSave');
        save.click();
        save.click();
        save.click();
        await flush(8);

        const posts = writes.filter((w) => w.method === 'POST' && w.url.includes('/replace'));
        expect(posts).toHaveLength(1);
    });

    test('失败时就地展示服务端原因，并自动刷新台账（陈旧页面自愈）', async () => {
        global.__replaceFail = '该绑定已结束，无法变更；如需恢复请在控制台重新新增该设备编号';
        const { calls, writes } = await mount();
        jest.spyOn(window, 'confirm').mockReturnValue(true);
        document.querySelector('[data-act="replace"][data-id="d1"]').click();
        await flush(2);
        document.getElementById('pdReplaceTo').value = 'VH-A-900';
        document.getElementById('pdReplaceSave').click();
        await flush(8);

        const err = document.getElementById('pdReplaceError');
        expect(err.classList.contains('hidden')).toBe(false);
        expect(err.textContent).toContain('该绑定已结束');
        // 失败后自动拉一次列表（POST 之后仍有 list 请求）
        const postIdx = writes.findIndex((w) => w.method === 'POST' && w.url.includes('/replace'));
        expect(postIdx).toBeGreaterThanOrEqual(0);
        expect(listCalls(calls).length).toBeGreaterThan(1);
        // 按钮恢复可用（下一次可继续操作）
        expect(document.getElementById('pdReplaceSave').disabled).toBe(false);
    });
});
