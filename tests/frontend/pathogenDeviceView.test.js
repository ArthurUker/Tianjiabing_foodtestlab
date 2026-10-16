/**
 * 病原体设备配置视图 · 学校筛选「全部学校」回归（2026-10-16）
 *
 * 需求：学校下拉需支持跨校查看（全选）。
 *  ① 选「全部学校」→ 列表请求不得带 school_code，且多出「学校」列区分归属
 *  ② 选具体学校 → 请求带 school_code，隐藏「学校」列
 *  ③ 跨校视图下点「新增设备」→ 必须提示先选定具体学校（设备编号→学校绑定不能悬空）
 */
import { initPathogenDeviceView } from '../../frontend/js/modules/adminSchools/views/pathogenDeviceView.js';

const SCHOOLS = [
    { code: 'school-a', name: '甲中学', status: 'active' },
    { code: 'school-b', name: '乙中学', status: 'active' },
];
const DEVICES = [
    { id: 'd1', school_code: 'school-a', device_no: 'VH-A-001', name: '', binding_user_id: 'u1', default_canteen: '一食堂', status: 'active', key_prefix: 'pdv_aaaa', key_last4: '1111', upload_count: 1, last_upload_at: null, ip_whitelist: [], rate_limit_per_min: 60 },
    { id: 'd2', school_code: 'school-b', device_no: 'VH-B-001', name: '', binding_user_id: 'u2', default_canteen: '二食堂', status: 'active', key_prefix: 'pdv_bbbb', key_last4: '2222', upload_count: 2, last_upload_at: null, ip_whitelist: [], rate_limit_per_min: 60 },
];

const flush = async (times = 4) => { for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0)); };

function setupFetchSpy() {
    const calls = [];
    global.fetch = async (url) => {
        calls.push(String(url));
        const json = (body) => ({ ok: true, status: 200, json: async () => body });
        const u = String(url);
        if (u.includes('/api/admin/schools?')) return json({ success: true, data: SCHOOLS });
        if (u.includes('/platform-key')) return json({ success: true, data: { exists: false, key: null } });
        if (u.includes('school_code=school-a')) return json({ success: true, data: DEVICES.filter((d) => d.school_code === 'school-a') });
        if (u.includes('school_code=school-b')) return json({ success: true, data: DEVICES.filter((d) => d.school_code === 'school-b') });
        if (u.includes('/api/admin/pathogen-devices')) return json({ success: true, data: DEVICES }); // 不带 school_code → 全部
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
    return { notify, calls };
}

const selectAll = async () => {
    const sel = document.getElementById('pdSchoolSelect');
    sel.value = '__all__';
    sel.dispatchEvent(new Event('change'));
    await flush();
};

describe('病原体设备视图 · 学校筛选「全部学校」', () => {
    test('① 选择「全部学校」→ 请求不带 school_code，渲染跨校行并显示「学校」列', async () => {
        const { calls } = await mount();
        await selectAll();

        const listCalls = calls.filter((u) => u.includes('/api/admin/pathogen-devices') && !u.includes('platform-key'));
        const lastList = listCalls[listCalls.length - 1];
        expect(lastList).toBeDefined();
        expect(lastList).not.toContain('school_code');      // 关键：跨校查询不带 school_code

        const rows = document.getElementById('pdDeviceRows').innerHTML;
        expect(rows).toContain('VH-A-001');
        expect(rows).toContain('VH-B-001');
        expect(rows).toContain('甲中学');                    // 两校归属都渲染出来
        expect(rows).toContain('乙中学');
        expect(document.getElementById('pdColSchool').classList.contains('hidden')).toBe(false); // 学校列可见
    });

    test('② 选择具体学校 → 请求带 school_code，隐藏「学校」列', async () => {
        const { calls } = await mount();
        const sel = document.getElementById('pdSchoolSelect');
        sel.value = 'school-a';
        sel.dispatchEvent(new Event('change'));
        await flush();

        const lastList = calls.filter((u) => u.includes('/api/admin/pathogen-devices') && !u.includes('platform-key')).pop();
        expect(lastList).toContain('school_code=school-a');
        const rows = document.getElementById('pdDeviceRows').innerHTML;
        expect(rows).toContain('VH-A-001');
        expect(rows).not.toContain('VH-B-001');
        expect(document.getElementById('pdColSchool').classList.contains('hidden')).toBe(true);
    });

    test('③ 跨校视图下点「新增设备」→ 提示先选定具体学校，且不打开表单弹层', async () => {
        const { notify } = await mount();
        await selectAll();
        document.querySelector('[data-act="new"]').click();
        await flush(2);

        expect(notify).toHaveBeenCalledWith(expect.stringContaining('选择'), 'error');
        expect(document.getElementById('pdModal').classList.contains('hidden')).toBe(true);
    });

    test('④ 跨校视图下编辑设备 → 按该设备所属学校加载绑定用户候选（不落到当前无学校状态）', async () => {
        const { calls } = await mount();
        await selectAll();
        document.querySelector('[data-act="edit"][data-id="d2"]').click();
        await flush(4);

        // 编辑 school-b 的设备 → 应请求 school-b 的用户/界面定制
        expect(calls.some((u) => u.includes('/api/admin/schools/school-b/users'))).toBe(true);
        expect(document.getElementById('pdModal').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('pdDeviceNo').value).toBe('VH-B-001');
    });
});
