import fs from 'node:fs';
import path from 'node:path';
import {
    applySchoolCustomizationToForm,
    ensurePesticideAssayOptions,
    PESTICIDE_BATCH_DEFAULTS,
    PESTICIDE_SULFUR_DIOXIDE_LABEL,
} from '../../frontend/js/utils/schoolCustomization/fields.js';
import { resultOptionsFor } from '../../frontend/js/colloidal/PhotoEntry.js';
import { normalizeAssayLabel, SULFUR_DIOXIDE_KIT_LABEL } from '../../frontend/js/utils/assayLabels.js';

const root = process.cwd();

function mountForm(id = 'pesticideTestForm') {
    document.body.innerHTML = `
        <form id="${id}">
            <div class="grid">
                <select name="batchNo"><option value="克百威-胶体金检测卡">克百威-胶体金检测卡</option></select>
                <select name="result"><option value="合格">合格</option><option value="不合格">不合格</option></select>
            </div>
        </form>`;
    return document.getElementById(id);
}

const valuesOf = (select) => Array.from(select.options).map((option) => option.value);

describe('果蔬农残 / 二氧化硫快速检测试剂盒选项', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('静态录入表单和管理端默认选项使用“二氧化硫快速检测试剂盒”', () => {
        const html = fs.readFileSync(path.join(root, 'frontend/pages/index.html'), 'utf8');
        expect(SULFUR_DIOXIDE_KIT_LABEL).toBe('二氧化硫快速检测试剂盒');
        expect(PESTICIDE_SULFUR_DIOXIDE_LABEL).toBe(SULFUR_DIOXIDE_KIT_LABEL);
        expect(html).toContain(`value="${PESTICIDE_SULFUR_DIOXIDE_LABEL}"`);
        expect(html).toContain('>合格</option>');
        expect(html).toContain('>不合格</option>');

        const fieldsSource = fs.readFileSync(
            path.join(root, 'frontend/js/modules/adminSchools/customization/moduleFields.js'),
            'utf8',
        );
        expect(fieldsSource).toContain(PESTICIDE_SULFUR_DIOXIDE_LABEL);
    });

    test('历史名称统一映射，不影响其它项目名称', () => {
        expect(normalizeAssayLabel('二氧化硫显色试剂（肉眼判读）')).toBe(SULFUR_DIOXIDE_KIT_LABEL);
        expect(normalizeAssayLabel('二氧化硫显色试剂')).toBe(SULFUR_DIOXIDE_KIT_LABEL);
        expect(normalizeAssayLabel('通用显色试纸')).toBe('通用显色试纸');
        expect(normalizeAssayLabel(null)).toBe(null);
    });

    test('学校定制把项目与结果清空时恢复默认项，不出现“无选项”', () => {
        const form = mountForm();
        applySchoolCustomizationToForm(form, { field_options: { batchNo: [], result: [] } });

        const batch = form.querySelector('select[name="batchNo"]');
        const result = form.querySelector('select[name="result"]');
        expect(valuesOf(batch)).toEqual(PESTICIDE_BATCH_DEFAULTS);
        expect(batch.value).toBe(PESTICIDE_BATCH_DEFAULTS[0]);
        expect(valuesOf(result)).toEqual(['', '合格', '不合格']);
        expect(result.value).toBe('');
    });

    test('保留学校自定义项目并升级旧名称值，不产生重复选项', () => {
        const form = mountForm();
        form.querySelector('select[name="batchNo"]').innerHTML = [
            '<option value="克百威-胶体金检测卡">克百威-胶体金检测卡</option>',
            '<option value="二氧化硫显色试剂">二氧化硫显色试剂</option>',
        ].join('');
        applySchoolCustomizationToForm(form, {
            field_options: {
                batchNo: ['克百威-胶体金检测卡', '二氧化硫显色试剂', '二氧化硫显色试剂（肉眼判读）'],
                result: ['合格'],
            },
        });

        const batch = form.querySelector('select[name="batchNo"]');
        expect(valuesOf(batch)).toEqual(['克百威-胶体金检测卡', PESTICIDE_SULFUR_DIOXIDE_LABEL]);
        const sulfur = Array.from(batch.options).find((option) => option.value === PESTICIDE_SULFUR_DIOXIDE_LABEL);
        expect(sulfur.textContent).toBe(PESTICIDE_SULFUR_DIOXIDE_LABEL);
        expect(valuesOf(form.querySelector('select[name="result"]'))).toEqual(['合格']);
    });

    test('空自定义列表补齐后重复应用仍保持幂等，并覆盖新增检测点位', () => {
        const form = mountForm();
        const firstPoint = form.querySelector('.grid');
        const newPoint = firstPoint.cloneNode(true);
        newPoint.querySelector('[name="batchNo"]').name = 'batchNo[]';
        newPoint.querySelector('[name="result"]').name = 'result[]';
        newPoint.querySelector('[name="batchNo[]"]').innerHTML = '';
        newPoint.querySelector('[name="result[]"]').innerHTML = '';
        form.appendChild(newPoint);

        const customization = { field_options: { batchNo: [], result: [] } };
        applySchoolCustomizationToForm(form, customization);
        const firstCounts = [...form.querySelectorAll('select')].map((select) => select.options.length);
        ensurePesticideAssayOptions(form);
        expect([...form.querySelectorAll('select')].map((select) => select.options.length)).toEqual(firstCounts);
        expect(valuesOf(form.querySelector('[name="batchNo[]"]'))).toEqual(PESTICIDE_BATCH_DEFAULTS);
        expect(valuesOf(form.querySelector('[name="result[]"]'))).toEqual(['', '合格', '不合格']);
    });

    test('未配置照片识别的项目保留人工合格/不合格，不出现空下拉', () => {
        const manual = resultOptionsFor(null);
        expect(manual.mode).toBe('manual');
        expect(manual.items.map(([value]) => value)).toEqual(['', '合格', '不合格']);
        expect(manual.items.map(([, text]) => text)).toEqual(['请选择', '合格', '不合格']);
        expect(manual.items.flat().join('|')).not.toContain('照片识别');

        const single = resultOptionsFor({ channels: [{}] });
        expect(single.mode).toBe('single');
        expect(single.items.map(([value]) => value)).toEqual([
            '', '合格', '不合格', '__photo_upload__', '__photo_camera__',
        ]);
        expect(resultOptionsFor({ channels: [{}, {}, {}] }).mode).toBe('triplex');
    });

    test('兜底仅作用于果蔬农残，不改变其它模块的空选项语义', () => {
        const form = mountForm('leanMeatTestForm');
        applySchoolCustomizationToForm(form, { field_options: { batchNo: [], result: [] } });
        expect(valuesOf(form.querySelector('[name="batchNo"]'))).toEqual(['']);
        expect(valuesOf(form.querySelector('[name="result"]'))).toEqual(['']);
    });
});
