/**
 * 原始上报报文 · 查看器回归（2026-11-04 重做）
 *
 * 覆盖：列表渲染（失败行标红/健康徽标）、查看器三页签（基本信息 / 点位与荧光 / 原始 JSON）、
 *       荧光数组展开、JSON 搜索与"仅显示匹配行"、Esc 关闭。
 */
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const PAYLOAD = {
    DeviceNo: '20230914010008',
    DetectionDateTime: '2026-11-04 11:40:00',
    DetectionEndDateTime: '2026-11-04 11:45:15',
    SampleStr: '二食堂 餐盘涂抹样',
    DetectionPeopleStr: 'QJY',
    DetectionNumber: 'R-20261104-01',
    FileName: '20261104_1140_1145.vhfl',
    ChipID: 'TS001',
    ChipName: '呼吸道24项病原体检测',
    ChipNumber: '20261022010046',
    Parms: { 'FAM-1': '乙型流感病毒', 'HEX-1': '甲型流感病毒' },
    ResultList: { 'FAM-1': true, 'HEX-1': false },
    CTList: { 'FAM-1': '25.3', 'HEX-1': '-' },
    OptimizationDataLists: { 'FAM-1': [0.1, 0.4, 0.9, 1.2], 'HEX-1': [] },
};

const ROWS = [
    { path: '/mnt/datadisk0/foodsentinel/data/device-payloads/test/a.json.gz', at: '2026-11-04T03:45:15.000Z', school_code: 'tjb', school_name: '珠海市田家炳中学', device_no: '20230914010008', chip_number: '20261022010046', status: 200, code: null, bytes: 6400, gz_bytes: 2400 },
    { path: '/mnt/datadisk0/foodsentinel/data/device-payloads/test/b.json.gz', at: '2026-11-04T02:00:00.000Z', school_code: 'tjb', school_name: '珠海市田家炳中学', device_no: '20230817010003', chip_number: 'X2', status: 422, code: 'CANTEEN_UNRESOLVED', bytes: 2200, gz_bytes: 1100 },
];

function setupFetch() {
    const calls = [];
    global.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
        if (u.includes('/payloads/content')) return json({ success: true, data: { path: 'x', payload: PAYLOAD } });
        if (u.includes('/payloads?')) {
            return json({
                success: true,
                data: {
                    items: ROWS,
                    stats: { total: 2, success: 1, failed: 1, bytes: 8600, gzBytes: 3500, bySchool: [{ code: 'tjb', name: '珠海市田家炳中学', count: 2, failed: 1 }] },
                },
            });
        }
        return json({ success: true, data: {} });
    };
    return calls;
}

async function mount() {
    jest.resetModules();
    document.body.innerHTML = `
        <button class="admin-sidebar__item" data-view="pathogendevices"></button>
        <div data-subnav="pathogendevices">
            <button class="admin-sidebar__subitem" data-subview="devices">设备管理</button>
            <button class="admin-sidebar__subitem" data-subview="payloads">原始上报报文</button>
        </div>
        <div id="adminViewPathogenDevices"><div id="inner">device panel</div></div>`;
    const notify = jest.fn();
    const calls = setupFetch();
    const mod = await import('../../frontend/js/modules/adminSchools/views/payloadArchiveView.js');
    mod.initPathogenPayloadView({ API_BASE: '', authHeaders: () => ({}), notify });
    // 切到「原始上报报文」二级页
    document.querySelector('[data-subview="payloads"]').click();
    await flush();
    return { notify, calls };
}

describe('原始上报报文 · 列表', () => {
    test('统计卡片、学校分类、成功/失败徽标与失败行标红', async () => {
        await mount();
        expect(document.getElementById('pdPlStatTotal').textContent).toBe('2');
        expect(document.getElementById('pdPlStatOk').textContent).toBe('1');
        expect(document.getElementById('pdPlStatFail').textContent).toBe('1');
        const opts = Array.from(document.getElementById('pdPlSchool').options).map((o) => o.textContent).join(' | ');
        expect(opts).toContain('珠海市田家炳中学');
        expect(opts).toContain('失败 1');

        const html = document.getElementById('pdPlRows').innerHTML;
        expect(html).toContain('成功 200');
        expect(html).toContain('422 CANTEEN_UNRESOLVED');
        expect(html).toContain('data-pl-view=');        // 保持既有「链接式」操作列
        expect(html).toContain('复制路径');
    });
});

describe('原始上报报文 · 查看器', () => {
    test('三页签：基本信息 / 点位与荧光 / 原始 JSON，且 JSON 有语法着色', async () => {
        await mount();
        document.querySelector('[data-pl-view]').click();
        await flush();

        const modal = document.getElementById('pdPlModal');
        expect(modal.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('pdPlBadge').textContent).toContain('成功 200');
        expect(document.getElementById('pdPlMeta').innerHTML).toContain('20261022010046');

        // 基本信息
        const basic = document.getElementById('pdPlPaneBasic').innerHTML;
        expect(basic).toContain('20230914010008');
        expect(basic).toContain('二食堂 餐盘涂抹样');
        expect(basic).toContain('阳性点位 1');
        expect(basic).toContain('FAM-1');

        // 点位与荧光
        document.querySelector('[data-pl-tab="points"]').click();
        await flush();
        expect(document.getElementById('pdPlPanePoints').classList.contains('hidden')).toBe(false);
        const pts = document.getElementById('pdPlPanePoints').innerHTML;
        expect(pts).toContain('乙型流感病毒');
        expect(pts).toContain('25.3');
        expect(pts).toContain('阳性');
        expect(pts).toContain('data-pl-fl="0"');

        // 展开荧光数组
        document.querySelector('[data-pl-fl="0"]').click();
        await flush(2);
        const flBox = document.getElementById('pdPlFl0');
        expect(flBox.classList.contains('hidden')).toBe(false);
        expect(flBox.innerHTML).toContain('0.9');

        // 原始 JSON：着色 + 搜索
        document.querySelector('[data-pl-tab="raw"]').click();
        await flush();
        const pre = document.getElementById('pdPlJson');
        expect(pre.innerHTML).toContain('color:#7dd3fc');   // 键
        expect(pre.innerHTML).toContain('color:#86efac');   // 字符串值

        const search = document.getElementById('pdPlJsonSearch');
        search.value = '25.3';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await flush(2);
        expect(document.getElementById('pdPlJsonStat').textContent).toContain('匹配 1 行');

        const only = document.getElementById('pdPlJsonOnlyMatch');
        only.checked = true;
        only.dispatchEvent(new Event('input', { bubbles: true }));
        await flush(2);
        const filtered = document.getElementById('pdPlJson').innerHTML;
        expect(filtered).toContain('25.3');
        expect(filtered).not.toContain('DetectionPeopleStr');
    });

    test('点击遮罩 / Esc 均可关闭', async () => {
        await mount();
        document.querySelectorAll('[data-pl-view]')[1].click();
        await flush();
        const modal = document.getElementById('pdPlModal');
        expect(modal.classList.contains('hidden')).toBe(false);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await flush(2);
        expect(modal.classList.contains('hidden')).toBe(true);

        // 再打开 → 点关闭按钮
        document.querySelectorAll('[data-pl-view]')[1].click();
        await flush();
        expect(modal.classList.contains('hidden')).toBe(false);
        modal.querySelector('[data-pl-close]').click();
        await flush(2);
        expect(modal.classList.contains('hidden')).toBe(true);
    });
});
