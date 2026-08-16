// ====== 字段弹层三件套（机械迁移自 admin-schools.html 3074-3599，仅做依赖注入，无行为变化）======
// 1) 字段校验规则弹层（傻瓜式：无需手填字段名）
// 2) 自定义字段「类型与统计」弹层（RK35，含选项 chips 管理）
// 3) 级联字段（FieldOption 表）选项树编辑器
// renderFieldList 由装配层注入（saveRule/saveStat 后刷新列表），避免与 fieldList.js 循环依赖。
// 迁移注记：原 readTreeRowState 局部变量 state 与 store.state 同名，已最小重命名为 rowState（无行为变化）。
import { state, markDirty } from './store.js';
import { MODULE_FIELDS, TABLE_MANAGED_FIELDS, isTableManagedField, isCascadeSource, fieldLabelOf } from './moduleFields.js';
import { escapeHtml, showNotice } from '../ui.js';
import { renderPreview } from '../preview.js';

let renderFieldList = () => {};
export function initPopovers({ renderFieldList: refresh }) { renderFieldList = refresh; }

// ====== 字段校验规则弹层（傻瓜式：无需手填字段名）======
// 统一弹层定位：贴近触发按钮右侧；按钮不可见/过偏则回退到视口居中
function positionPopover(pop, btn, estHeight) {
    // 把 popover 临时挂到 body 下，逃出 .glass 容器的 backdrop-filter 定位上下文
    // （CSS 规定：transform/filter/backdrop-filter/perspective/will-change 都会劫持 position:fixed）
    if (pop.parentElement !== document.body) document.body.appendChild(pop);
    pop.style.display = 'block';
    // 先让浏览器计算一次尺寸（避免同步布局读到 0）
    void pop.offsetHeight;
    const w = pop.offsetWidth || 300;
    const h = pop.offsetHeight || estHeight || 240;
    const rect = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 判定按钮是否在可视区（任一维度为 0 视为不可见）
    const btnVisible = rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0
        && rect.left < vw && rect.top < vh;
    let left, top;
    if (!btnVisible) {
        // 不可见 → 居中
        left = Math.max(8, (vw - w) / 2);
        top = Math.max(8, (vh - h) / 2);
    } else {
        // 默认贴按钮右侧；右侧越界则改贴左侧；上/下溢出则回弹
        left = rect.right + 8;
        if (left + w > vw - 8) left = Math.max(8, rect.left - w - 8);
        if (left < 8) left = 8;
        top = rect.top;
        if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    }
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
}

// TD-PopoverAutoSize: 字段管理弹窗宽度自适应——以视口宽度的 1/3~1/2 为基础区间，
// 再按内容（顶级选项数、是否有子选项）做微调；过窄/过宽都修正。极窄屏退化为通栏。
// 通过 CSS 变量 --sp-width 传给 .sc-popover--auto；高度仍走 max-height + 内容自适应。
function sizeStatPopover(pop) {
    if (!pop) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 1) 极窄屏（手机/侧边栏折叠态）：宽度近似通栏，留 16px 边距
    if (vw < 640) {
        pop.style.setProperty('--sp-width', (vw - 16) + 'px');
        pop.style.maxHeight = (vh - 32) + 'px';
        return;
    }
    // 2) 计算候选宽度：先按 1/2 视口作为「理想宽度」，再按内容微调
    const halfVw = vw * 0.5;        // 理想上限：半屏
    const thirdVw = vw / 3;         // 下限：1/3 屏（保证不会被压到极窄）
    // 内容密度因子：树形结构项越多，宽度倾向于接近上限（让 chips/输入框不挤）
    const topRows = pop.querySelectorAll('[data-tree-row]').length;
    const childChips = pop.querySelectorAll('[data-child-chip]').length;
    let density = 0.5; // 默认 1/2
    if (topRows >= 4 || childChips >= 8) density = 0.5;        // 内容多 → 顶到 1/2
    else if (topRows === 0) density = Math.max(0.4, 0.5);     // 空态：略窄
    else if (topRows <= 2 && childChips <= 3) density = 0.42;  // 内容少：略窄
    let ideal = vw * density;
    // 3) 上下限夹紧
    const minW = Math.max(360, thirdVw);                       // 至少 360px
    const maxW = Math.min(800, halfVw);                         // 最多 800px 或半屏
    let width = Math.min(maxW, Math.max(minW, ideal));
    // 4) 不超过视口（含边距）；移动端平板额外留 32px
    const viewportCap = vw - 32;
    width = Math.min(width, viewportCap);
    // 5) 高度：自适应内容，最大不超过视口 - 32
    pop.style.setProperty('--sp-width', width + 'px');
    pop.style.maxHeight = (vh - 32) + 'px';
}
// 视口尺寸变化时同步重置弹窗尺寸（用户拖动浏览器边缘 / 折叠侧栏时）
let _spResizeRaf = null;
window.addEventListener('resize', () => {
    if (document.getElementById('statPopover').style.display !== 'block') return;
    if (_spResizeRaf) return;
    _spResizeRaf = requestAnimationFrame(() => {
        _spResizeRaf = null;
        sizeStatPopover(document.getElementById('statPopover'));
        // 重置后位置可能越界，再走一次定位
        const pop = document.getElementById('statPopover');
        const anchor = pop._anchorBtn;
        if (anchor) positionPopover(pop, anchor, 540);
    });
});
let rulePopoverField = null;
export function openRulePopover(btn, fieldName, label) {
    closeRulePopover();
    rulePopoverField = fieldName;
    const r = state.fieldRules[fieldName] || {};
    document.getElementById('rpLabel').textContent = label || fieldName;
    document.getElementById('rpRequired').checked = !!r.required;
    document.getElementById('rpMax').value = r.maxLength || '';
    document.getElementById('rpMin').value = r.minLength || '';
    positionPopover(document.getElementById('rulePopover'), btn, 236);
}
export function saveRuleFromPopover() {
    if (!rulePopoverField) return;
    const r = {};
    if (document.getElementById('rpRequired').checked) r.required = true;
    let mx = parseInt(document.getElementById('rpMax').value, 10);
    let mn = parseInt(document.getElementById('rpMin').value, 10);
    if (!Number.isFinite(mx) || mx < 0) mx = 0;
    if (!Number.isFinite(mn) || mn < 0) mn = 0;
    // 最小字数不能大于最大字数：自动纠正并提示，避免保存出"永远填不对"的规则
    if (mx > 0 && mn > mx) {
        [mn, mx] = [mx, mn];
        showNotice('最小字数大于最大字数，已自动交换', 'error');
    }
    if (mx > 0) r.maxLength = mx;
    if (mn > 0) r.minLength = mn;
    if (Object.keys(r).length) state.fieldRules[rulePopoverField] = r;
    else delete state.fieldRules[rulePopoverField];
    markDirty();
    renderFieldList();
}
export function closeRulePopover() {
    if (rulePopoverField) saveRuleFromPopover();
    rulePopoverField = null;
    document.getElementById('rulePopover').style.display = 'none';
}
document.getElementById('rpDone').addEventListener('click', () => closeRulePopover());
document.getElementById('rpCancel').addEventListener('click', () => { rulePopoverField = null; document.getElementById('rulePopover').style.display = 'none'; });
document.addEventListener('click', (e) => {
    const pop = document.getElementById('rulePopover');
    if (pop.style.display === 'block' && !pop.contains(e.target) && !e.target.closest('.rp-gear')) {
        closeRulePopover();
    }
});
document.addEventListener('keydown', (e) => {
    const pop = document.getElementById('rulePopover');
    if (e.key === 'Escape' && pop.style.display === 'block') closeRulePopover();
});

// ====== RK35: 自定义字段「类型与统计」弹层 ======
let statPopoverField = null;
function findCustomFieldDef(fieldName) {
    const list = state.customFields[state.currentFieldModule] || [];
    return list.find(f => f.name === fieldName) || null;
}
function syncStatPopoverVisibility() {
    const tableManaged = _statPopoverField && isTableManagedField(state.currentFieldModule, _statPopoverField);
    const spTypeEl = document.getElementById('spType');
    const spStatRoleEl = document.getElementById('spStatRole');
    // 级联字段：「输入类型」与「统计角色」整段隐藏（选项由 FieldOption 表管理，类型固定 select）
    document.getElementById('spTypeSection').style.display = tableManaged ? 'none' : 'block';
    document.getElementById('spStatSection').style.display = tableManaged ? 'none' : 'block';
    document.getElementById('spTreeWrap').style.display = tableManaged ? 'block' : 'none';
    document.getElementById('spOptionsWrap').style.display = (!tableManaged && spTypeEl.value === 'select') ? 'block' : 'none';
    document.getElementById('spQualifiedWrap').style.display =
        (!tableManaged && spStatRoleEl.value === 'result') ? 'block' : 'none';
}

// ===== RK35 选项 chips 管理 =====
// 把现有选项数组渲染为可删除的标签
function renderSpOptionsChips(arr) {
    const list = document.getElementById('spOptionsList');
    if (!list) return;
    if (!Array.isArray(arr) || arr.length === 0) {
        list.innerHTML = '<span class="text-xs text-gray-400 italic px-1 self-center">暂无选项</span>';
        _statPopoverChips = [];
        return;
    }
    list.innerHTML = arr.map((opt, idx) =>
        `<span class="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-800 rounded text-xs" data-opt-idx="${idx}">${escapeHtml(opt)}<button type="button" class="sp-opt-del text-purple-500 hover:text-purple-900 ml-1" data-opt="${escapeHtml(opt)}" title="删除该选项">×</button></span>`
    ).join('');
    _statPopoverChips = arr.slice();
    // 重新绑定删除事件（innerHTML 覆盖了原元素）
    list.querySelectorAll('.sp-opt-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const cur = getSpOptionsChips();
            const v = btn.dataset.opt;
            const next = cur.filter(x => x !== v);
            renderSpOptionsChips(next);
        });
    });
}

// 从 chips DOM 读出当前数组（去重、去空、保留顺序）
// FIX-11: 原实现 querySelectorAll('[data-opt-idx]') 命中的是外层 <span>（只带 data-opt-idx），
// 而真正携带选项值的是内层 <button data-opt="...">。读 span.dataset.opt 恒为 undefined，
// 导致 getSpOptionsChips() 永远返回 []，删除一个 chip 会清空全部、且保存时无法写回 → "删不掉"。
function getSpOptionsChips() {
    const list = document.getElementById('spOptionsList');
    if (!list) return [];
    return Array.from(list.querySelectorAll('[data-opt]'))
        .map(el => el.dataset.opt || '')
        .filter(Boolean);
}

// ====== 级联字段（FieldOption 表）选项树编辑器 ======
let _statPopoverField = null;
let _statPopoverChips = [];

// 读取单行 DOM 状态（含子选项）。简单字段无 .tree-value 时，value 自动从 label 同步。
function readTreeRowState(row) {
    const valueEl = row.querySelector('.tree-value');
    const labelEl = row.querySelector('.tree-label');
    const label = (labelEl?.value || '').trim();
    const value = (valueEl?.value || '').trim() || label;  // 无 .tree-value 的简单字段：value=label
    const isDefault = !!row.querySelector('.tree-default')?.checked;
    const children = [];
    row.querySelectorAll('[data-child-chip]').forEach(chip => {
        const v = chip.dataset.value || '';
        if (v) children.push({ value: v, label: chip.dataset.label || v });
    });
    return { value, label, isDefault, children };
}

// 从 DOM 收集整棵树 → 写回 fieldCascade（输入实时同步；增删走重渲染）
function collectSpTreeToState() {
    const field = _statPopoverField;
    if (!field || !isTableManagedField(state.currentFieldModule, field)) return;
    const listEl = document.getElementById('spTreeList');
    if (!listEl) return;
    const module = state.currentFieldModule;
    if (!state.fieldCascade[module]) state.fieldCascade[module] = {};
    const rows = [];
    listEl.querySelectorAll('[data-tree-row]').forEach(row => {
        const rowState = readTreeRowState(row);
        if (rowState.value) rows.push(rowState);
    });
    state.fieldCascade[module][field] = rows;
}

// 从内存状态渲染树编辑器
function renderSpTree() {
    const field = _statPopoverField;
    if (!field || !isTableManagedField(state.currentFieldModule, field)) return;
    const listEl = document.getElementById('spTreeList');
    if (!listEl) return;
    const module = state.currentFieldModule;
    if (!state.fieldCascade[module]) state.fieldCascade[module] = {};
    const rows = state.fieldCascade[module][field] || (state.fieldCascade[module][field] = []);
    const source = isCascadeSource(module, field);
    const hintEl = document.getElementById('spTreeHint');
    if (hintEl) {
        hintEl.textContent = source
            ? '为每项配置点位联动；录入端选「' + fieldLabelOf(field) + '」时自动切换点位下拉（未配置的项使用默认可选值）'
            : '该字段为联动目标，顶级选项将作为未配置联动时的默认可选值（不参与联动）';
    }
    listEl.innerHTML = rows.length ? rows.map((r, ri) => {
        const childChips = source && Array.isArray(r.children) && r.children.length
            ? r.children.map(c => '<span class="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 bg-indigo-100 text-indigo-700 rounded-full text-xs font-medium" data-child-chip data-value="' + escapeHtml(c.value) + '" data-label="' + escapeHtml(c.label || c.value) + '">' + escapeHtml(c.label || c.value) + '<button type="button" class="tree-child-del text-indigo-400 hover:text-white hover:bg-indigo-500 rounded-full w-4 h-4 flex items-center justify-center text-[10px] leading-none" data-value="' + escapeHtml(c.value) + '" title="删除该子选项">×</button></span>').join('')
            : '<span class="text-xs text-gray-400 italic px-1 self-center">无子选项</span>';
        const defaultLabelCls = r.isDefault
            ? 'flex items-center gap-1 px-2 py-1.5 border border-amber-300 bg-amber-50 text-amber-700 rounded-md cursor-pointer text-xs font-medium transition select-none'
            : 'flex items-center gap-1 px-2 py-1.5 border border-gray-200 text-gray-500 hover:border-amber-200 hover:bg-amber-50 rounded-md cursor-pointer text-xs font-medium transition select-none';
        const defaultIconCls = r.isDefault ? 'fas fa-star' : 'fas fa-star text-gray-300';
        // 简单字段（value 与 label 相同，无机器值/显示值区分）：只显示一个输入框，避免重复
        const isSimpleField = !r.value || r.value === (r.label || '');
        return `
            <div class="tree-card group border border-gray-200 rounded-lg p-2.5 bg-white shadow-sm hover:shadow-md hover:border-indigo-200 transition" data-tree-row>
                <div class="flex items-center gap-2">
                    <span class="text-gray-300 group-hover:text-gray-400 select-none text-sm leading-none" title="拖拽排序（占位）">⋮⋮</span>
                    ${isSimpleField
                        ? `<input type="text" class="tree-label flex-1 min-w-0 px-2 py-1.5 text-sm text-gray-700 border border-gray-200 rounded-md focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none" placeholder="选项名称" value="${escapeHtml(r.label || r.value)}">`
                        : `<input type="text" class="tree-value flex-1 min-w-0 px-2 py-1.5 border border-gray-200 rounded-md text-sm font-mono focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none" placeholder="选项值（如 atp）" value="${escapeHtml(r.value)}">
                           <input type="text" class="tree-label flex-1 min-w-0 px-2 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-md focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none" placeholder="显示名称" value="${escapeHtml(r.label || r.value)}">`
                    }
                    <label class="${defaultLabelCls}" title="设为录入表单默认选中">
                        <input type="radio" name="treeDefault_${ri}" class="tree-default sr-only" ${r.isDefault ? 'checked' : ''}>
                        <i class="${defaultIconCls}"></i><span>默认</span>
                    </label>
                    <button type="button" class="tree-del p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition" title="${source ? '删除（将同时删除其子选项）' : '删除该选项'}"><i class="fas fa-trash-alt text-xs"></i></button>
                </div>
                ${source ? `
                <div class="mt-2 ml-4 pl-3 border-l-2 border-indigo-100">
                    <div class="text-[11px] text-gray-500 mb-1 flex items-center"><i class="fas fa-link text-indigo-400 mr-1.5"></i>选「<b class="text-indigo-700 mx-0.5">${escapeHtml(r.label || r.value)}</b>」时，下点位可选：</div>
                    <div class="flex flex-wrap gap-1.5 mb-1.5 min-h-[30px] py-1">${childChips}</div>
                    <div class="flex gap-1.5">
                        <input type="text" placeholder="添加点位（Enter 或点 + 添加）" class="tree-child-input flex-1 min-w-0 px-2.5 py-1.5 border border-gray-200 rounded-md text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none">
                        <button type="button" class="tree-child-add flex-shrink-0 px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition whitespace-nowrap"><i class="fas fa-plus mr-1"></i>添加</button>
                    </div>
                </div>` : ''}
            </div>`;
    }).join('') : '<div class="text-xs text-gray-400 italic text-center py-6 bg-gray-50 rounded-lg border border-dashed border-gray-200"><i class="fas fa-inbox block text-gray-300 text-2xl mb-2"></i>暂无选项，点击下方「新增顶级选项」添加</div>';

    // 输入实时同步到内存（不重渲染，避免打断输入焦点）
    listEl.querySelectorAll('.tree-value, .tree-label').forEach(el => {
        el.addEventListener('input', collectSpTreeToState);
    });
    // 「默认」单选切换：收集内存 + 同步视觉（不重渲染，否则会丢其它输入焦点）
    listEl.querySelectorAll('.tree-default').forEach(el => {
        el.addEventListener('change', () => {
            collectSpTreeToState();
            listEl.querySelectorAll('.tree-card').forEach(card => {
                const isDef = !!card.querySelector('.tree-default').checked;
                const lbl = card.querySelector('label');
                const icon = lbl && lbl.querySelector('i');
                if (!lbl || !icon) return;
                if (isDef) {
                    lbl.className = 'flex items-center gap-1 px-2 py-1.5 border border-amber-300 bg-amber-50 text-amber-700 rounded-md cursor-pointer text-xs font-medium transition select-none';
                    icon.className = 'fas fa-star';
                } else {
                    lbl.className = 'flex items-center gap-1 px-2 py-1.5 border border-gray-200 text-gray-500 hover:border-amber-200 hover:bg-amber-50 rounded-md cursor-pointer text-xs font-medium transition select-none';
                    icon.className = 'fas fa-star text-gray-300';
                }
            });
        });
    });
    // 删除顶级选项
    listEl.querySelectorAll('.tree-del').forEach(btn => {
        btn.addEventListener('click', () => {
            const row = btn.closest('[data-tree-row]');
            if (source && row.querySelector('[data-child-chip]')) {
                if (!confirm('删除该选项将同时删除其下所有子选项，确定？')) return;
            }
            row.remove();
            collectSpTreeToState();
            renderSpTree();
        });
    });
    // 删除子选项
    listEl.querySelectorAll('.tree-child-del').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.closest('[data-child-chip]').remove();
            collectSpTreeToState();
            renderSpTree();
        });
    });
    // 添加子选项
    const doChildAdd = (row, input) => {
        const v = (input.value || '').trim();
        if (!v) return;
        const rowState = readTreeRowState(row);
        if (rowState.children.some(c => c.value === v)) { showNotice('该子选项已存在', 'error'); return; }
        rowState.children.push({ value: v, label: v });
        if (!state.fieldCascade[state.currentFieldModule]) state.fieldCascade[state.currentFieldModule] = {};
        const list = state.fieldCascade[state.currentFieldModule][field] || [];
        const idx = Array.from(row.parentElement.querySelectorAll('[data-tree-row]')).indexOf(row);
        if (idx >= 0) list[idx] = rowState;
        state.fieldCascade[state.currentFieldModule][field] = list;
        renderSpTree();
        const rowsEl = document.querySelectorAll('[data-tree-row]');
        const newInput = rowsEl[idx] && rowsEl[idx].querySelector('.tree-child-input');
        if (newInput) newInput.focus();
    };
    listEl.querySelectorAll('.tree-child-add').forEach(btn => {
        btn.addEventListener('click', () => {
            const row = btn.closest('[data-tree-row]');
            doChildAdd(row, row.querySelector('.tree-child-input'));
        });
    });
    listEl.querySelectorAll('.tree-child-input').forEach(input => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); doChildAdd(input.closest('[data-tree-row]'), input); }
        });
    });
}

// 添加顶级选项
document.getElementById('spTreeAddTop').addEventListener('click', () => {
    const field = _statPopoverField;
    if (!field) return;
    if (!state.fieldCascade[state.currentFieldModule]) state.fieldCascade[state.currentFieldModule] = {};
    if (!state.fieldCascade[state.currentFieldModule][field]) state.fieldCascade[state.currentFieldModule][field] = [];
    state.fieldCascade[state.currentFieldModule][field].push({ value: '', label: '', isDefault: false, children: [] });
    renderSpTree();
    const rowsEl = document.querySelectorAll('[data-tree-row]');
    const last = rowsEl[rowsEl.length - 1];
    if (last) last.querySelector('.tree-value')?.focus();
});

// 绑定输入框回车 + 添加按钮 + 初始化
function bindSpOptionsEditor() {
    const input = document.getElementById('spOptionInput');
    const addBtn = document.getElementById('spOptionAddBtn');
    if (!input || !addBtn) return;
    const doAdd = () => {
        const v = input.value.trim();
        if (!v) return;
        const cur = getSpOptionsChips();
        if (cur.includes(v)) { showNotice('该选项已存在', 'error'); return; }
        cur.push(v);
        renderSpOptionsChips(cur);
        input.value = '';
        input.focus();
    };
    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
}
bindSpOptionsEditor();
function findAnyFieldDef(fieldName) {
    const custom = findCustomFieldDef(fieldName);
    if (custom) return { isCustom: true, def: custom };
    for (const [mod, fields] of Object.entries(MODULE_FIELDS)) {
        const b = (fields || []).find(f => f.name === fieldName);
        if (b) return { isCustom: false, def: b, module: mod };
    }
    return null;
}
export function openStatPopover(btn, fieldName, label) {
    closeStatPopover();
    const any = findAnyFieldDef(fieldName);
    if (!any) return;
    statPopoverField = fieldName;
    _statPopoverField = fieldName;  // 用于树编辑器重渲染
    const def = any.def;
    document.getElementById('spLabel').textContent = label || fieldName;
    const pop = document.getElementById('statPopover');
    // 记录锚点按钮：resize 时重定位需要
    pop._anchorBtn = btn;
    // 级联字段（FieldOption 表）：仅显示选项树编辑器（value/label + 联动子选项）
    const tableManaged = isTableManagedField(state.currentFieldModule, fieldName);
    if (tableManaged) {
        document.getElementById('spType').value = 'select';
        document.getElementById('spStatRole').value = '';
        document.getElementById('spQualified').value = '';
        syncStatPopoverVisibility();
        renderSpTree();
        // TD-PopoverAutoSize: 先按内容/视口自动设定宽度，再定位
        sizeStatPopover(pop);
        positionPopover(pop, btn, 540);
        return;
    }
    const resolvedType = any.isCustom ? (def.type || 'text') : (state.fieldTypes[fieldName] || def.type || 'text');
    document.getElementById('spType').value = resolvedType;
    // 把现有选项渲染为 chips（替代旧的逗号分隔文本框）
    // builtin 字段的选项实际存在全局 fieldOptions[fieldName]（用户保存的覆盖值），自定义字段在 def.options
    const opts = (Array.isArray(state.fieldOptions[fieldName]) && state.fieldOptions[fieldName].length)
        ? state.fieldOptions[fieldName]
        : (Array.isArray(def.options) ? def.options : []);
    renderSpOptionsChips(opts.slice());
    document.getElementById('spStatRole').value = def.statRole === 'result' ? 'result' : '';
    document.getElementById('spQualified').value = Array.isArray(def.qualifiedValues) ? def.qualifiedValues.join(',') : '';
    syncStatPopoverVisibility();
    // TD-PopoverAutoSize: 同上，宽度自适应
    sizeStatPopover(pop);
    positionPopover(pop, btn, 360);
}
export function saveStatFromPopover() {
    if (!statPopoverField) return;
    const any = findAnyFieldDef(statPopoverField);
    if (!any) return;
    // 级联字段（FieldOption 表）：编辑已实时写回 fieldCascade，仅标记脏并刷新
    if (isTableManagedField(state.currentFieldModule, statPopoverField)) {
        collectSpTreeToState();
        markDirty();
        renderFieldList();
        renderPreview();
        return;
    }
    const type = document.getElementById('spType').value;
    const statRole = document.getElementById('spStatRole').value;
    // 从 chips 数组读（替代旧的逗号分隔解析）
    const optionsArr = getSpOptionsChips();
    const qualifiedRaw = document.getElementById('spQualified').value.trim();
    if (any.isCustom) {
        const def = any.def;
        def.type = type;
        if (type === 'select') {
            def.options = optionsArr;
            if (!def.options.length) showNotice('下拉类型建议填写至少一个选项', 'error');
        } else {
            delete def.options;
        }
        if (statRole === 'result') {
            def.statRole = 'result';
            def.qualifiedValues = qualifiedRaw ? qualifiedRaw.split(/[，,]/).map(s => s.trim()).filter(Boolean) : [];
            if (!def.qualifiedValues.length) {
                showNotice('参与统计需填写合格值，否则该字段不会计入合格率', 'error');
            }
        } else {
            delete def.statRole;
            delete def.qualifiedValues;
        }
        if (type === 'select' && Array.isArray(def.options) && def.options.length) {
            state.fieldOptions[statPopoverField] = def.options;
        }
    } else {
        // builtin field：仅将类型差异写入 fieldTypes；选项写入 fieldOptions
        if (type && type !== (any.def.type || 'text')) {
            state.fieldTypes[statPopoverField] = type;
        } else {
            delete state.fieldTypes[statPopoverField];
        }
        // FIX-11: 允许删除到空——type 为 select 时始终写回（含空数组），
        // 否则删光选项后 fieldOptions 残留旧值，录入端会回退硬编码默认项导致"删不掉"。
        if (type === 'select') {
            state.fieldOptions[statPopoverField] = optionsArr;
        } else {
            delete state.fieldOptions[statPopoverField];
        }
    }
    markDirty();
    renderFieldList();
    renderPreview();
}
export function closeStatPopover() {
    if (statPopoverField) saveStatFromPopover();
    statPopoverField = null;
    const pop = document.getElementById('statPopover');
    pop.style.display = 'none';
    pop._anchorBtn = null;     // TD-PopoverAutoSize: 释放锚点引用，避免内存泄漏
}
document.getElementById('spType').addEventListener('change', syncStatPopoverVisibility);
document.getElementById('spStatRole').addEventListener('change', syncStatPopoverVisibility);
document.getElementById('spDone').addEventListener('click', () => closeStatPopover());
document.getElementById('spCancel').addEventListener('click', () => { statPopoverField = null; document.getElementById('statPopover').style.display = 'none'; });
document.addEventListener('click', (e) => {
    const pop = document.getElementById('statPopover');
    if (pop.style.display === 'block' && !pop.contains(e.target) && !e.target.closest('.sp-gear')) {
        closeStatPopover();
    }
});
document.addEventListener('keydown', (e) => {
    const pop = document.getElementById('statPopover');
    if (e.key === 'Escape' && pop.style.display === 'block') closeStatPopover();
});
