/**
 * 病原体设备「接口使用指导」渲染回归（2026-10-14）
 *
 * 背景事故：renderMdBlocks 的普通文本分支漏了 i++ → 命中普通文本行即死循环，
 *   控制台点击「接口使用指导」后页面直接卡死。本套件锁定：
 *   ① 全量渲染必须终止（jest 5s 超时即失败）；
 *   ② 9 个章节、12 个错误码全覆盖；
 *   ③ 字段必填口径与 backend/lib/pathogenDevice.js 一致（曾把
 *      DetectionEndDateTime / OptimizationDataLists 误标为选填）；
 *   ④ 代码块转义（防 XSS）；⑤ 域名占位符可替换。
 */
import { GUIDE_MD, renderMdBlocks } from '../../frontend/js/modules/adminSchools/views/pathogenDeviceView.js';

const renderAll = () => renderMdBlocks(GUIDE_MD.split('\n'));

describe('接口使用指导（GUIDE_MD 渲染）', () => {
    test('全量渲染必须终止且每个章节标题都产出（死循环回归）', () => {
        const html = renderAll();
        expect(html.length).toBeGreaterThan(1000);
        const headings = GUIDE_MD.split('\n').filter((l) => /^## /.test(l));
        expect(headings.length).toBeGreaterThanOrEqual(9);
        for (const h of headings) {
            const text = h.replace(/^##\s+/, '').split('（')[0].trim();
            expect(html).toContain(text);
        }
    });

    test('错误码表 13 项全覆盖（含 B 方案新增 DEVICE_NOT_REGISTERED）', () => {
        const html = renderAll();
        for (const code of [
            'MISSING_KEY', 'INVALID_KEY', 'DEVICE_DISABLED', 'DEVICE_MISMATCH', 'SCHOOL_DISABLED',
            'VALIDATION_ERROR', 'SCHOOL_NOT_FOUND', 'PAYLOAD_TOO_LARGE', 'CANTEEN_UNRESOLVED',
            'BINDING_USER_MISSING', 'RATE_LIMITED', 'INTERNAL_ERROR', 'DEVICE_NOT_REGISTERED',
        ]) {
            expect(html).toContain(code);
        }
    });

    test('双认证模式（B 方案）在指导中成文：统一密钥（推荐）+ 设备密钥（可选严格）', () => {
        const html = renderAll();
        expect(html).toContain('统一上传密钥（推荐');
        expect(html).toContain('设备密钥（可选');
        // 两种模式的归属判定差异必须写明
        expect(GUIDE_MD).toMatch(/完全由报文 `DeviceNo`/);
        expect(GUIDE_MD).toMatch(/报文 `DeviceNo` 必须与密钥所属设备一致/);
        // 统一密钥 onboarding 两步：建密钥 + 按学校绑设备编号
        expect(GUIDE_MD).toContain('创建/轮换」统一上传密钥');
        expect(GUIDE_MD).toMatch(/为每个学校绑定设备编号/);
    });

    test('字段必填口径与 lib 校验一致', () => {
        const rowOf = (field) => GUIDE_MD.split('\n').find((l) => l.startsWith(`| ${field} |`));
        // lib: DeviceNo/DetectionDateTime/DetectionEndDateTime/SampleStr/DetectionPeopleStr/
        //      DetectionNumber/FileName/ChipName/ChipNumber/Parms/ResultList/CTList/
        //      OptimizationDataLists(键) 必填；ChipID 选填
        for (const f of ['DeviceNo', 'DetectionDateTime', 'DetectionEndDateTime', 'SampleStr',
            'DetectionPeopleStr', 'DetectionNumber', 'FileName', 'ChipName', 'ChipNumber',
            'Parms', 'ResultList', 'CTList', 'OptimizationDataLists']) {
            expect(rowOf(f)).toBeTruthy();
            expect(rowOf(f)).toMatch(/\| 是 \|/);
        }
        expect(rowOf('ChipID')).toMatch(/\| 否 \|/);
    });

    test('代码块原样输出并转义（防 XSS）', () => {
        const html = renderMdBlocks(['```json', '{"a": "<script>alert(1)</script>"}', '```']);
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>alert');
    });

    test('域名占位符可替换（渲染/下载前处理）', () => {
        expect(GUIDE_MD).toContain('<平台域名>');
        expect(GUIDE_MD.replace(/<平台域名>/g, 'https://x.example')).not.toContain('<平台域名>');
    });

    test('普通文本行与数字列表行也能渲染（死循环分支的直接覆盖）', () => {
        const html = renderMdBlocks(['普通文本一行', '1. 数字列表一行', '', '```', 'code', '```']);
        expect(html).toContain('普通文本一行');
        expect(html).toContain('1. 数字列表一行');
        expect(html).toContain('code');
    });
});

/* ─── 挂载级回归（jsdom）：点击「接口使用指导」→ 弹层打开 + 内容渲染 + 可滚动结构 ───
 * 背景事故 2（2026-10-14）：弹层用 flex flex-col 但内容区缺 min-h-0 → 被内容撑高超过视口、
 *   居中裁剪导致既不能滚动、顶部「下载 MD 文档」按钮也被挤出屏幕。本用例锁定结构类名。 */
describe('接口使用指导弹层（挂载级）', () => {
    let host;

    beforeEach(() => {
        document.body.innerHTML = '<section id="adminViewPathogenDevices" class="admin-view"></section>';
        host = document.getElementById('adminViewPathogenDevices');
        globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
    });

    afterEach(() => {
        delete globalThis.fetch;
        document.body.innerHTML = '';
    });

    test('点击「接口使用指导」→ 弹层打开、内容渲染、内容区可滚动（min-h-0 + overflow-y-auto）', async () => {
        const { initPathogenDeviceView } = await import('../../frontend/js/modules/adminSchools/views/pathogenDeviceView.js');
        initPathogenDeviceView({ API_BASE: 'http://test.invalid', authHeaders: () => ({}), notify: () => {} });

        const btn = host.querySelector('[data-act="guide"]');
        expect(btn).toBeTruthy();
        btn.click();

        const modal = document.getElementById('pdGuideModal');
        const body = document.getElementById('pdGuideBody');
        expect(modal.className).not.toContain('hidden');
        expect(body.innerHTML).toContain('接口概况');
        expect(body.innerHTML).toContain('MISSING_KEY');
        // 可滚动结构：flex 子项必须 min-h-0 + overflow-y-auto（缺一即被撑高/裁切）
        expect(body.className).toContain('min-h-0');
        expect(body.className).toContain('overflow-y-auto');
        // 弹层整体限高（视口内）
        const card = modal.querySelector('.flex.flex-col');
        expect(card.className).toContain('max-h-');
    });

    test('关闭按钮收起弹层', async () => {
        const { initPathogenDeviceView } = await import('../../frontend/js/modules/adminSchools/views/pathogenDeviceView.js');
        initPathogenDeviceView({ API_BASE: 'http://test.invalid', authHeaders: () => ({}), notify: () => {} });
        host.querySelector('[data-act="guide"]').click();
        expect(document.getElementById('pdGuideModal').className).not.toContain('hidden');
        document.querySelector('#pdGuideModal [data-pd-close]').click();
        expect(document.getElementById('pdGuideModal').className).toContain('hidden');
    });
});
