// ====== 字段管理列表（机械迁移自 admin-schools.html 2756-3020，仅做依赖注入，无行为变化）======
// 含：模块子 Tab、字段行渲染、显示/隐藏/改名/删除、拖拽 + 键盘/按钮排序、新增自定义字段。
import { state, markDirty } from './store.js';
import { MODULE_FIELDS, MODULE_INFO, SECTION_INFO, SECTION_ORDER, POINTS_TITLE_BY_MODULE, orderFields, isTableManagedField } from './moduleFields.js';
import { escapeHtml, showNotice } from '../ui.js';
import { renderPreview } from '../preview.js';
import { openRulePopover, openStatPopover } from './popovers.js';

// 渲染模块子 Tab
export function renderFieldModuleTabs() {
    const container = document.getElementById('fieldModuleTabs');
    const visibleModules = Array.from(document.querySelectorAll('.vis-menu-item:checked')).map(cb => cb.value);
    // 致病菌检测无字段管理（字段由导入报告自动识别），不生成对应 Tab
    const modules = (visibleModules.length ? visibleModules : Object.keys(MODULE_FIELDS)).filter(m => m !== 'pathogen');
    if (!modules.length) modules.push('tableware');
    if (!modules.includes(state.currentFieldModule)) state.currentFieldModule = modules[0] || 'tableware';
    container.innerHTML = modules.map(code => {
        const info = MODULE_INFO[code] || { name: code };
        const active = code === state.currentFieldModule;
        return `<button type="button" class="fm-tab px-2 py-1 text-xs rounded-t font-medium ${active ? 'bg-blue-50 text-blue-700 border-b-2 border-blue-500' : 'text-gray-500 hover:text-blue-500'}" data-module="${code}">${info.name}</button>`;
    }).join('');
    container.querySelectorAll('.fm-tab').forEach(btn => {
        btn.addEventListener('click', () => { state.currentFieldModule = btn.dataset.module; renderFieldModuleTabs(); renderFieldList(); });
    });
}

// 获取当前模块的完整字段列表（内置 + 自定义），并应用拖拽排序
export function getCurrentModuleFields() {
    const builtin = MODULE_FIELDS[state.currentFieldModule] || [];
    const custom = state.customFields[state.currentFieldModule] || [];
    return orderFields([...builtin, ...custom], state.fieldOrder[state.currentFieldModule]);
}

// 渲染单行字段（不绑事件，由 renderFieldList 负责绑定）
function renderFieldRow(f) {
    const label = state.fieldLabels[f.name] || f.label;
    const hidden = state.hiddenFields.has(f.name);
    const isCustom = !f.builtin;
    const rule = state.fieldRules[f.name] || {};
    const reqBadge = rule.required ? '<span class="text-xs px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded" title="已设为必填">必填</span>' : '';
    return `
        <div class="fl-row flex items-center gap-2 py-1 group" data-field="${escapeHtml(f.name)}" role="listitem" aria-label="字段 ${escapeHtml(label)}，可用上下按钮或键盘方向键调整顺序">
            <button type="button" class="fl-move fl-up px-1 text-gray-300 hover:text-gray-600" data-field="${escapeHtml(f.name)}" title="上移" aria-label="上移字段 ${escapeHtml(label)}"><i class="fas fa-arrow-up"></i></button>
            <button type="button" class="fl-move fl-down px-1 text-gray-300 hover:text-gray-600" data-field="${escapeHtml(f.name)}" title="下移" aria-label="下移字段 ${escapeHtml(label)}"><i class="fas fa-arrow-down"></i></button>
            <button type="button" class="fl-drag cursor-grab text-gray-300 hover:text-gray-500 select-none" data-field="${escapeHtml(f.name)}" title="拖动调整顺序（亦可用上下按钮或键盘方向键）" aria-label="拖动调整顺序：字段 ${escapeHtml(label)}"><i class="fas fa-grip-vertical"></i></button>
            <label class="flex items-center cursor-pointer" title="${hidden ? '已隐藏，点击显示' : '显示中，点击隐藏'}">
                <input type="checkbox" class="fl-visible" data-field="${escapeHtml(f.name)}" ${!hidden ? 'checked' : ''}>
            </label>
            <span class="text-xs text-gray-400 font-mono w-28 truncate" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            <input type="text" value="${escapeHtml(label)}" class="fl-label flex-1 px-2 py-1 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-400" data-field="${escapeHtml(f.name)}" data-original="${escapeHtml(f.label)}">
            ${(() => {
                const t = state.fieldTypes[f.name] || f.type || 'text';
                const tl = { text:'文本',number:'数字',date:'日期',select:'下拉',textarea:'多行',checkbox:'勾选' }[t] || t;
                const tc = { text:'gray-500',number:'blue-600',date:'green-600',select:'purple-600',textarea:'orange-600',checkbox:'amber-600' }[t] || 'gray-500';
                return '<span class="inline-flex items-center shrink-0 whitespace-nowrap text-xs px-2 py-0.5 bg-'+tc.replace('-600','-100').replace('-500','-100')+' text-'+tc+' rounded mr-1" title="字段类型：'+tl+'">'+tl+'</span>';
            })()}
            ${isCustom ? '<span class="text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded">自定义</span>' : ''}
            ${isCustom && (f.statRole === 'result') ? '<span class="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded" title="参与合格率统计">统计</span>' : ''}
            ${reqBadge}
            <button type="button" class="sp-gear px-2 py-1 text-xs text-gray-400 hover:text-purple-600 hover:bg-purple-50 rounded transition" data-field="${escapeHtml(f.name)}" data-label="${escapeHtml(label)}" title="${isTableManagedField(state.currentFieldModule, f.name) ? '设置选项与联动（含子选项级联）' : '设置字段类型与统计规则'}"><i class="fas fa-chart-pie"></i></button>
            <button type="button" class="rp-gear px-2 py-1 text-xs text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition" data-field="${escapeHtml(f.name)}" data-label="${escapeHtml(label)}" title="设置校验规则（必填 / 字数）"><i class="fas fa-cog"></i></button>
            <button type="button" class="fl-delete px-2 py-1 text-xs text-red-500 hover:bg-red-50 rounded transition" data-field="${escapeHtml(f.name)}" data-builtin="${f.builtin}" title="${f.builtin ? '隐藏该字段' : '删除该字段'}">
                <i class="fas ${f.builtin ? 'fa-eye-slash' : 'fa-trash'}"></i>
            </button>
        </div>
    `;
}

// 渲染当前模块的所有字段，按 section 分块（保留段内 fieldOrder）
export function renderFieldList() {
    const container = document.getElementById('fieldListContainer');
    if (!container) return;
    const code = state.currentFieldModule;
    const fields = getCurrentModuleFields();

    // 按 SECTION_ORDER 顺序收集，缺省/未知归入 main
    const grouped = new Map();
    SECTION_ORDER.forEach(k => grouped.set(k, []));
    fields.forEach(f => {
        const sec = SECTION_INFO[f.section] ? f.section : 'main';
        if (!grouped.has(sec)) grouped.set(sec, []);
        grouped.get(sec).push(f);
    });

    // 分块渲染：每段显示标题（统一 mt-3 间距），段内按 fieldOrder 保留
    const parts = [];
    grouped.forEach((arr, sec) => {
        if (!arr.length) return;
        const info = SECTION_INFO[sec] || { title: sec, showTitle: true };
        // 模块特定标题覆盖
        const titleOverride = sec === 'points' ? POINTS_TITLE_BY_MODULE[state.currentFieldModule] : null;
        const sectionTitle = titleOverride || info.title;
        if (info.showTitle) {
            parts.push(
                `<div class="fl-section flex items-center gap-2 mt-3 py-1.5 px-1 border-b border-gray-200" data-section="${escapeHtml(sec)}">` +
                    `<span class="text-xs font-semibold text-gray-600">${escapeHtml(sectionTitle)}</span>` +
                    `<span class="text-xs text-gray-400">${arr.length} 个字段</span>` +
                `</div>`
            );
        }
        arr.forEach(f => parts.push(renderFieldRow(f)));
    });
    container.innerHTML = parts.join('');

    // 绑定事件
    container.querySelectorAll('.fl-visible').forEach(cb => {
        cb.addEventListener('change', () => {
            if (cb.checked) state.hiddenFields.delete(cb.dataset.field);
            else state.hiddenFields.add(cb.dataset.field);
            markDirty();
            renderPreview();
        });
    });
    container.querySelectorAll('.fl-label').forEach(input => {
        input.addEventListener('input', () => {
            const field = input.dataset.field;
            const original = input.dataset.original;
            if (input.value.trim() && input.value.trim() !== original) {
                state.fieldLabels[field] = input.value.trim();
            } else {
                delete state.fieldLabels[field];
            }
            markDirty();
            renderPreview();
        });
    });
    container.querySelectorAll('.fl-delete').forEach(btn => {
        btn.addEventListener('click', () => {
            const field = btn.dataset.field;
            const isBuiltin = btn.dataset.builtin === 'true';
            if (isBuiltin) {
                // 内置字段：切换隐藏状态
                if (state.hiddenFields.has(field)) {
                    state.hiddenFields.delete(field);
                } else {
                    state.hiddenFields.add(field);
                }
            } else {
                // 自定义字段：从列表中删除（同步清理排序/标签/规则等残留引用）
                state.customFields[state.currentFieldModule] = (state.customFields[state.currentFieldModule] || []).filter(f => f.name !== field);
                delete state.fieldLabels[field];
                state.hiddenFields.delete(field);
                delete state.fieldRules[field];
                delete state.fieldOptions[field];
                if (Array.isArray(state.fieldOrder[state.currentFieldModule])) {
                    state.fieldOrder[state.currentFieldModule] = state.fieldOrder[state.currentFieldModule].filter(n => n !== field);
                }
            }
            markDirty();
            renderFieldList();
            renderPreview();
        });
    });
    container.querySelectorAll('.rp-gear').forEach(btn => {
        btn.addEventListener('click', () => openRulePopover(btn, btn.dataset.field, btn.dataset.label));
    });
    container.querySelectorAll('.sp-gear').forEach(btn => {
        btn.addEventListener('click', () => openStatPopover(btn, btn.dataset.field, btn.dataset.label));
    });
    bindFieldDrag(container);
}

// 字段拖拽排序：仅从左侧手柄发起，drop 后更新 fieldOrder 并联动预览
let draggingField = null;

// XR-05 / RK-43：上移/下移（键盘/触摸均可用），与拖拽共用同一重排逻辑
function moveField(field, dir) {
    const names = getCurrentModuleFields().map(f => f.name);
    const from = names.indexOf(field);
    if (from < 0) return;
    const to = from + dir;
    if (to < 0 || to >= names.length) return;
    names.splice(from, 1);
    names.splice(to, 0, field);
    state.fieldOrder[state.currentFieldModule] = names;
    markDirty();
    renderFieldList();
    renderPreview();
}

function bindFieldDrag(container) {
    container.setAttribute('role', 'list');
    container.querySelectorAll('.fl-row').forEach(row => {
        const handle = row.querySelector('.fl-drag');
        if (handle) {
            handle.addEventListener('mousedown', () => row.setAttribute('draggable', 'true'));
            handle.addEventListener('mouseup', () => row.setAttribute('draggable', 'false'));
            // RK-43：键盘方向键亦可重排
            handle.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowUp') { e.preventDefault(); moveField(row.dataset.field, -1); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); moveField(row.dataset.field, 1); }
            });
        }
        row.addEventListener('dragstart', (e) => {
            draggingField = row.dataset.field;
            e.dataTransfer.effectAllowed = 'move';
            row.classList.add('opacity-40');
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('opacity-40');
            row.setAttribute('draggable', 'false');
            draggingField = null;
        });
        row.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            const targetField = row.dataset.field;
            if (!draggingField || draggingField === targetField) return;
            const names = getCurrentModuleFields().map(f => f.name);
            const from = names.indexOf(draggingField);
            if (from < 0) return;
            names.splice(from, 1);
            const to = names.indexOf(targetField);
            if (to < 0) return;
            const rect = row.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height / 2;
            names.splice(after ? to + 1 : to, 0, draggingField);
            state.fieldOrder[state.currentFieldModule] = names;
            draggingField = null;
            markDirty();
            renderFieldList();
            renderPreview();
        });
    });
    // XR-05：触摸/点击上移下移（HTML5 拖拽在触屏不可用，按钮为等效入口）
    container.querySelectorAll('.fl-up').forEach(btn => btn.addEventListener('click', () => moveField(btn.dataset.field, -1)));
    container.querySelectorAll('.fl-down').forEach(btn => btn.addEventListener('click', () => moveField(btn.dataset.field, 1)));
}

// 新增自定义字段（显示名必填，字段名可留空自动生成）
document.getElementById('addFieldBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('newFieldName');
    const labelInput = document.getElementById('newFieldLabel');
    const label = labelInput.value.trim();
    if (!label) { showNotice('请输入字段显示名称', 'error'); return; }
    let name = nameInput.value.trim();
    if (!name) name = 'cf_' + Date.now().toString(36);
    if (!/^[a-zA-Z_][\w]*$/.test(name)) { showNotice('字段名需为英文/下划线开头，可留空自动生成', 'error'); return; }
    // 检查重名
    const exists = getCurrentModuleFields().some(f => f.name === name);
    if (exists) { showNotice('字段名已存在', 'error'); return; }
    if (!state.customFields[state.currentFieldModule]) state.customFields[state.currentFieldModule] = [];
    state.customFields[state.currentFieldModule].push({ name, label, builtin: false });
    nameInput.value = '';
    labelInput.value = '';
    markDirty();
    renderFieldList();
    renderPreview();
});
