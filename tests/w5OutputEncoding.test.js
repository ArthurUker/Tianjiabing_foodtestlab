/**
 * P3-W5-T01（AUD-003 / RC-05）· 存储型 XSS 输出编码注入回归（jsdom）
 *
 * 覆盖三类 sink（任务包验收 ②）：
 *   ① 列表      GenericTestModule.render()          —— 备注（属性+文本）、食堂/检测人/品种等
 *   ② 详情      GenericTestModule.showDetailModal()  —— 备注、整改措施、复检说明
 *                GenericTestModule.showEditModal()    —— 整改日志（user/action/content）、textarea 初值
 *   ③ 导出预览  ExportService._doPreviewReport()     —— 报表单元格 / 备注（既有 _escapeHtml 路径，防回归）
 *
 * 断言口径：注入载荷**绝不得**变成元素/属性/事件（querySelector 找不到注入元素、属性表不增多），
 * 但**必须**以文本形式原样可见（不静默丢数据）。
 */
import { html, mount, setText, setAttr, toNodes } from '../frontend/js/core/domSafe.js';
import { GenericTestModule } from '../frontend/js/modules/GenericTest.js';
import { ExportService } from '../frontend/js/services/ExportService.js';

// 三类载荷：属性闭合 / 标签闭合 / 编码变体
const PAYLOAD_ATTR = '"><img src=x onerror="alert(1)">';
const PAYLOAD_TAG = '</textarea><script>alert(1)</script>';
const PAYLOAD_ENC = '&lt;img src=x onerror=alert(1)&gt;';
const PAYLOADS = [PAYLOAD_ATTR, PAYLOAD_TAG, PAYLOAD_ENC];

function makeBareModule({ moduleName = 'pesticide', tableId = 'pesticide_tableBody', records = [] } = {}) {
    const mod = Object.create(GenericTestModule.prototype);
    Object.assign(mod, {
        moduleName,
        tableId,
        currentPage: 1,
        recordsPerPage: 10,
        sortOrder: 'desc',
        selectedCanteenFilter: 'all',
        selectedMeatTypes: [],
        storage: {
            getAll: () => records,
            update: () => true,
            on: () => {},
            off: () => {},
        },
    });
    return mod;
}

describe('P3-W5-T01 · domSafe 安全渲染通道', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    test('文本插入：载荷只能是文本，不产生元素/事件', () => {
        for (const payload of PAYLOADS) {
            const host = document.createElement('div');
            mount(host, html`<span class="x">${payload}</span>`);
            expect(host.querySelector('img')).toBeNull();
            expect(host.querySelector('script')).toBeNull();
            expect(host.querySelector('span').textContent).toBe(payload);   // 原样可见，不被静默丢弃
            expect(host.querySelectorAll('*').length).toBe(1);              // 只应存在模板里的 span
        }
    });

    test('属性插入：引号闭合串经 setAttribute 落地，不新增属性、不产生元素', () => {
        for (const payload of PAYLOADS) {
            const host = document.createElement('div');
            mount(host, html`<span title="${payload}">x</span>`);
            const span = host.querySelector('span');
            expect(span.getAttributeNames()).toEqual(['title']);            // 未被"注入"出 onerror 等属性
            expect(span.getAttribute('title')).toBe(payload);
            expect(span.getAttribute('onerror')).toBeNull();
            expect(host.querySelector('img')).toBeNull();
        }
    });

    test('textarea 内容位置：闭合标签逃逸串不会突破 textarea', () => {
        const host = document.createElement('div');
        mount(host, html`<textarea id="t">${PAYLOAD_TAG}</textarea>`);
        expect(host.querySelector('script')).toBeNull();
        expect(host.querySelector('#t').value).toBe(PAYLOAD_TAG);
        expect(host.querySelectorAll('*').length).toBe(1);
    });

    test('嵌套模板 / 数组 / 条件片段：结构由代码决定，数据不改变结构', () => {
        const host = document.createElement('div');
        const on = true;
        mount(host, html`${[html`<b>${PAYLOAD_ATTR}</b>`, html`<i>${'ok'}</i>`]}${on ? html`<u>${PAYLOAD_TAG}</u>` : ''}`);
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('script')).toBeNull();
        expect(host.querySelectorAll('b,i,u').length).toBe(3);
        expect(host.querySelector('b').textContent).toBe(PAYLOAD_ATTR);
        expect(host.querySelector('u').textContent).toBe(PAYLOAD_TAG);
    });

    test('setText / setAttr：null 处理与既有显示约定一致（null → 空文本 / 移除属性）', () => {
        const node = document.createElement('span');
        setText(node, null);
        expect(node.textContent).toBe('');
        setAttr(node, 'title', undefined);
        expect(node.hasAttribute('title')).toBe(false);
        setAttr(node, 'data-id', 12);
        expect(node.getAttribute('data-id')).toBe('12');
        expect(toNodes(null).length).toBe(0);
    });
});

describe('P3-W5-T01 · sink ①列表（GenericTest.render）', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    test('业务字段注入不得产生元素/事件，备注属性与文本原样保留', () => {
        const records = [{
            id: PAYLOAD_ATTR,
            testDate: PAYLOAD_TAG,
            canteen: PAYLOAD_ATTR,
            vegetableType: PAYLOAD_TAG,
            batchNo: PAYLOAD_ATTR,
            inspector: PAYLOAD_TAG,
            result: '合格',
            remark: PAYLOAD_ATTR,
        }];
        document.body.innerHTML = '<table><tbody id="pesticide_tableBody"></tbody></table>';
        makeBareModule({ records }).render();

        const tbody = document.getElementById('pesticide_tableBody');
        expect(tbody.querySelector('img')).toBeNull();
        expect(tbody.querySelector('script')).toBeNull();
        expect(tbody.querySelectorAll('tr').length).toBe(1);

        const remark = tbody.querySelector('td div[title]');
        expect(remark.getAttribute('title')).toBe(PAYLOAD_ATTR);            // 属性上下文：原样但非结构
        expect(remark.getAttribute('onerror')).toBeNull();
        expect(remark.textContent).toContain('备注:');
        // 详情按钮的 data-id 同样来自记录 ID（属性槽位）
        expect(tbody.querySelector('.btn-detail').getAttribute('data-id')).toBe(PAYLOAD_ATTR);
    });
});

describe('P3-W5-T01 · sink ②详情（详情弹窗 / 整改复检弹窗）', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    test('详情弹窗：备注 / 整改措施 / 复检说明注入不得产生元素，且文本可见', () => {
        const record = {
            id: 'r1',
            testDate: '2026-09-25',
            canteen: PAYLOAD_ATTR,
            inspector: PAYLOAD_TAG,
            vegetableType: PAYLOAD_ATTR,
            batchNo: PAYLOAD_TAG,
            result: '合格',
            remark: PAYLOAD_TAG,
            correctiveAction: PAYLOAD_TAG,
            recheckRecords: [{ isPassed: false, time: '2026-09-25 10:00', recheckInspector: PAYLOAD_ATTR, description: PAYLOAD_TAG }],
        };
        const mod = makeBareModule({ records: [record] });
        mod.showDetailModal('r1');

        const modal = document.getElementById('detailModal');
        expect(modal).not.toBeNull();
        expect(modal.querySelector('img')).toBeNull();
        expect(modal.querySelector('script')).toBeNull();
        expect(modal.textContent).toContain(PAYLOAD_TAG);                  // 整改措施以文本呈现
        expect(modal.textContent).toContain('复检人：');
    });

    test('整改/复检弹窗：textarea 初值与整改日志注入不得逃逸', () => {
        const record = {
            id: 'r2',
            testDate: '2026-09-25',
            canteen: '一食堂',
            inspector: '张三',
            result: '不合格',
            correctiveAction: PAYLOAD_TAG,
            modificationLogs: [{ time: '2026-09-25 09:00', user: PAYLOAD_ATTR, action: '更新整改措施', content: PAYLOAD_TAG }],
            recheckRecords: [],
        };
        const mod = makeBareModule({ records: [record] });
        mod.showEditModal(record, '李四');

        const modal = document.getElementById('editModal');
        expect(modal).not.toBeNull();
        expect(modal.querySelector('script')).toBeNull();
        expect(modal.querySelector('img')).toBeNull();
        // textarea 初值：闭合串不能被解析为标签（值原样、元素数不增）
        expect(modal.querySelector('#newCorrectiveAction').value).toBe(PAYLOAD_TAG);
        // 日志文本与属性均槽位化
        const logHost = modal.querySelector('#auditLogsList');
        expect(logHost.textContent).toContain(PAYLOAD_TAG);
        expect(logHost.querySelector('img')).toBeNull();
    });
});

describe('P3-W5-T01 · sink ③导出预览（ExportService）', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    test('报表单元格/备注注入不得产生元素（既有 _escapeHtml 路径防回归）', () => {
        document.body.innerHTML = '<div class="report-content" id="reportPreview"></div>';
        // 绕过构造函数（其会实例化 5 个 StorageService）；只测渲染路径本身
        const svc = Object.create(ExportService.prototype);
        svc.collectData = () => ({
            pesticide: [{
                testDate: '2026-09-25',
                canteen: PAYLOAD_ATTR,
                inspector: PAYLOAD_TAG,
                vegetableType: PAYLOAD_ATTR,
                batchNo: PAYLOAD_TAG,
                result: '合格',
                remark: PAYLOAD_TAG,
            }],
            tableware: [], oil: [], leanMeat: [], pathogen: [],
        });

        svc._doPreviewReport({
            title: '注入回归报表',
            startDate: '2026-09-01',
            endDate: '2026-09-25',
            testTypes: ['pesticide'],
            canteens: ['all'],
            meatTypes: ['all'],
            notes: '',
        });

        const preview = document.getElementById('reportPreview');
        expect(preview.innerHTML.length).toBeGreaterThan(0);
        expect(preview.querySelector('img')).toBeNull();
        expect(preview.querySelector('script')).toBeNull();
        expect(preview.textContent).toContain(PAYLOAD_ATTR);   // 转义后仍可见（不静默丢数据）
        expect(preview.textContent).toContain(PAYLOAD_TAG);
    });
});
