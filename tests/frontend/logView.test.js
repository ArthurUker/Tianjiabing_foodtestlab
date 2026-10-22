/**
 * 日志管理视图 · 交互回归（2026-10-22 日志中心）
 *
 * 覆盖：分类页签计数 / 列表渲染（含重复次数 ×N 与「汇总」标记）/ 行详情 /
 *       文件日志页签 / 保留策略页签（含预览清理）。
 */
import { initLogView } from '../../frontend/js/modules/adminSchools/views/logView.js';

const flush = async (times = 6) => { for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0)); };

const ITEMS = [
    {
        id: 'l1', level: 'info', category: 'device', created_at: '2026-10-22T06:19:10.000Z',
        message: 'PATHOGEN_DEVICE_UPLOAD_OK 20230914010008',
        context: { action_type: 'pathogen_device_upload_ok', category: 'device', device_no: '20230914010008', school_code: 'test', record_code: 'RC-1' },
    },
    {
        id: 'l2', level: 'warn', category: 'device', created_at: '2026-10-22T06:17:22.000Z',
        message: 'PATHOGEN_DEVICE_DENIED CANTEEN_UNRESOLVED',
        context: { action_type: 'pathogen_device_denied', category: 'device', code: 'CANTEEN_UNRESOLVED', device_no: '20230817010003', repeat_count: 3 },
    },
    {
        id: 'l3', level: 'info', category: 'device', created_at: '2026-10-21T00:00:00.000Z',
        message: '[rollup] device 2026-10-20 RATE_LIMITED × 120',
        context: { category: 'device', rollup: true, day: '2026-10-20', code: 'RATE_LIMITED', count: 120 },
    },
];

function setupFetch() {
    const calls = [];
    global.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        const json = (body) => ({ ok: true, status: 200, json: async () => body });
        if (u.includes('/api/admin/logs/retention')) {
            return json({ success: true, data: {
                rules: { device: { retentionDays: 90, compressAfterDays: 30 }, admin: { retentionDays: 0, compressAfterDays: 0 } },
                auto: true, labels: { device: '设备上传', admin: '平台操作' }, categories: ['device', 'admin'],
            } });
        }
        if (u.includes('/api/admin/logs/stats')) {
            return json({ success: true, data: { rowCount: 156, tableBytes: 155648, totals: { device: 41, admin: 34 }, levels: { info: 27, warn: 123, error: 6 }, byDay: [{ day: '2026-10-22', total: 5 }] } });
        }
        if (u.includes('/api/admin/logs/files')) {
            return json({ success: true, data: { files: [{ path: '/mnt/datadisk0/foodsentinel/logs/app.out.log', name: 'app.out.log', size: 2048, mtime: Date.now() }] } });
        }
        if (u.includes('/api/admin/logs/purge')) {
            return json({ success: true, data: { dryRun: true, totalDeleted: 3, totalRollups: 2, categories: { device: { willDelete: 3, rollupGroups: 2 } } } });
        }
        if (u.includes('/api/admin/logs')) {
            return json({ success: true, data: { items: ITEMS, total: 3, page: 1, pageSize: 50, facets: { categories: { device: 3, admin: 34 }, levels: { info: 2, warn: 1 } }, labels: { device: '设备上传', admin: '平台操作' } } });
        }
        return json({ success: true, data: {} });
    };
    return calls;
}

async function mount() {
    document.body.innerHTML = '<div id="adminViewLogs"></div>';
    const notify = jest.fn();
    const calls = setupFetch();
    initLogView({ API_BASE: '', authHeaders: () => ({}), notify });
    await flush();
    return { notify, calls };
}

describe('日志管理视图 · 数据库日志', () => {
    test('分类页签带计数；列表渲染设备/学校与重复次数 ×N；汇总行有标记', async () => {
        await mount();
        const chips = document.getElementById('logCatChips').innerHTML;
        expect(chips).toContain('设备上传');
        expect(chips).toContain('平台操作');

        const rows = document.getElementById('logRows').innerHTML;
        expect(rows).toContain('20230914010008');
        expect(rows).toContain('20230817010003');
        expect(rows).toContain('×3');          // repeat_count 展示
        expect(rows).toContain('汇总');        // rollup 标记
        expect(document.getElementById('logTotal').textContent).toContain('共 3 条');
    });

    test('点击行 → 详情面板展示 context 且可关闭', async () => {
        await mount();
        document.querySelector('[data-act="detail"][data-idx="1"]').click();
        await flush(2);
        const detail = document.getElementById('logDetail');
        expect(detail.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('logDetailBody').innerHTML).toContain('CANTEEN_UNRESOLVED');

        document.querySelector('[data-act="close-detail"]').click();
        await flush(2);
        expect(detail.classList.contains('hidden')).toBe(true);
    });

    test('查询条件写入请求（分类 + 级别 + 关键词）', async () => {
        const { calls } = await mount();
        document.querySelector('[data-act="cat"][data-cat="device"]').click();
        await flush(3);
        document.getElementById('logLevel').value = 'warn';
        document.getElementById('logKeyword').value = 'DENIED';
        document.querySelector('[data-act="query"]').click();
        await flush(3);

        const last = calls.filter((u) => u.includes('/api/admin/logs/?')).pop();
        expect(last).toContain('category=device');
        expect(last).toContain('level=warn');
        expect(last).toContain('q=DENIED');
    });
});

describe('日志管理视图 · 文件日志与保留策略', () => {
    test('切到文件页签 → 列出日志文件（含查看/下载入口）', async () => {
        await mount();
        document.querySelector('[data-act="tab"][data-tab="files"]').click();
        await flush(4);
        expect(document.getElementById('logPaneFiles').classList.contains('hidden')).toBe(false);
        const rows = document.getElementById('logFileRows').innerHTML;
        expect(rows).toContain('app.out.log');
        expect(rows).toContain('data-act="file-view"');
        expect(rows).toContain('data-act="file-dl"');
    });

    test('切到保留页签 → 渲染分类策略输入与容量；预览清理显示统计', async () => {
        await mount();
        document.querySelector('[data-act="tab"][data-tab="retention"]').click();
        await flush(6);

        const rows = document.getElementById('logRetentionRows').innerHTML;
        expect(rows).toContain('data-ret="device"');
        expect(rows).toContain('value="90"');
        expect(rows).toContain('value="30"');
        expect(document.getElementById('logStats').innerHTML).toContain('156');

        document.querySelector('[data-act="purge-preview"]').click();
        await flush(4);
        expect(document.getElementById('logRetentionHint').textContent).toContain('压缩 2 组');
        expect(document.getElementById('logRetentionHint').textContent).toContain('删除 3 条');
    });
});
