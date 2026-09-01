// ====== 可视化编辑模式（机械迁移自 admin-schools.html 1314-1334 + 1376-1765，仅做依赖注入，无行为变化）======
import { state, markDirty } from './customization/store.js';
import { MODULE_FIELDS, MODULE_INFO } from './customization/moduleFields.js';
import { renderFieldList, renderFieldModuleTabs } from './customization/fieldList.js';
import { registerVisualEditHooks, getPreviewIframe, isPreviewReady, renderPreview } from './preview.js';
import { highlightThemePreset } from './adminTheme.js';
import { escapeHtml } from './ui.js';
import { MODULE_REGISTRY, getAllModules } from '/js/modules/registry.js';

let visualEditMode = false;
let visualEditBound = false;

// 切换可视化编辑模式
document.getElementById('visualEditToggle').addEventListener('change', function() {
    visualEditMode = this.checked;
    localStorage.setItem('veEnabled', visualEditMode ? 'true' : 'false');
    if (visualEditMode) {
        enableVisualEdit();
    } else {
        disableVisualEdit();
    }
});

// 引导横幅关闭
const veHintCloseEl = document.getElementById('veHintClose');
if (veHintCloseEl) veHintCloseEl.addEventListener('click', () => {
    document.getElementById('veHint').style.display = 'none';
    localStorage.setItem('veHintClosed', '1');
});

// 挂钩预览：就绪/重放后按需重新标记可编辑元素（原 preview 内 1189 / 1308 行调用）
registerVisualEditHooks({
    onPreviewReadyIfToggleOn: () => { if (document.getElementById('visualEditToggle')?.checked) enableVisualEdit(); },
    reapplyAfterBaselineRestore: () => { if (visualEditMode) enableVisualEdit(); },
});

function enableVisualEdit() {
    const previewIframe = getPreviewIframe();
    if (!previewIframe || !isPreviewReady()) return;
    const doc = previewIframe.contentDocument;
    if (!doc) return;

    // 注入 hover 高亮样式（幂等：预览每次重放后会重新调用本函数，样式只注入一次）
    if (!doc.getElementById('visual-edit-style')) {
        const style = doc.createElement('style');
        style.id = 'visual-edit-style';
        style.textContent = `
            .ve-editable { cursor: pointer !important; transition: outline 0.15s !important; }
            .ve-editable:hover { outline: 2px solid #3b82f6 !important; outline-offset: 1px !important; background-color: rgba(59,130,246,0.08) !important; }
            .ve-badge { position: absolute; background: #3b82f6; color: #fff; font-size: 10px; padding: 1px 6px; border-radius: 3px; pointer-events: none; z-index: 9999; white-space: nowrap; }
        `;
        doc.head.appendChild(style);
    }

    // 标记可编辑元素
    const titleEl = doc.getElementById('systemTitle');
    if (titleEl) { titleEl.classList.add('ve-editable'); titleEl.dataset.veType = 'title'; }

    const logoEl = doc.getElementById('systemLogo');
    if (logoEl) { logoEl.classList.add('ve-editable'); logoEl.dataset.veType = 'logo'; }

    doc.querySelectorAll('nav.glass-dark').forEach(nav => {
        nav.classList.add('ve-editable');
        nav.dataset.veType = 'navcolor';
    });

    // 导航菜单项（target → module 由注册中心派生）
    const navTargetMap = Object.fromEntries(
        getAllModules().map((m) => [m.navTarget, m.code])
    );
    Object.entries(navTargetMap).forEach(([target, module]) => {
        const btn = doc.querySelector(`[data-target="${target}"]`);
        if (btn) { btn.classList.add('ve-editable'); btn.dataset.veType = 'navitem'; btn.dataset.veModule = module; }
    });

    // 表格表头（sectionId → module 由注册中心派生）
    const moduleSectionMap = Object.fromEntries(
        getAllModules().map((m) => [m.navTarget, m.code])
    );
    Object.entries(moduleSectionMap).forEach(([sectionId, moduleCode]) => {
        const section = doc.getElementById(sectionId);
        if (!section) return;
        // 显示所有模块表单（可视化编辑时需要看到表单）
        section.classList.remove('hidden');
        // 表格表头
        section.querySelectorAll('table thead th').forEach((th, idx) => {
            th.classList.add('ve-editable');
            th.dataset.veType = 'th';
            th.dataset.veModule = moduleCode;
            th.dataset.veIndex = idx;
        });
        // 表单中的 select → 点击编辑选项
        section.querySelectorAll('form select').forEach(sel => {
            sel.classList.add('ve-editable');
            sel.dataset.veType = 'formselect';
            sel.dataset.veModule = moduleCode;
            sel.dataset.veField = sel.name || '';
        });
        // 表单中的 label → 点击编辑标签文字
        section.querySelectorAll('form label').forEach(lbl => {
            if (!lbl.textContent.trim()) return;
            lbl.classList.add('ve-editable');
            lbl.dataset.veType = 'formlabel';
            lbl.dataset.veModule = moduleCode;
            // 找到关联的 input/select
            const sibling = lbl.parentElement.querySelector('input,select,textarea');
            if (sibling && sibling.name) lbl.dataset.veField = sibling.name;
        });
        // 表单中的 input（有 placeholder 的）→ 点击编辑 placeholder
        section.querySelectorAll('form input[placeholder]').forEach(inp => {
            if (!inp.name) return;
            inp.classList.add('ve-editable');
            inp.dataset.veType = 'forminput';
            inp.dataset.veModule = moduleCode;
            inp.dataset.veField = inp.name;
        });
    });

    // 看板卡片标题 / 各模块小标题
    doc.querySelectorAll('[data-title-key]').forEach(el => {
        el.classList.add('ve-editable');
        el.dataset.veType = 'heading';
        el.dataset.veKey = el.dataset.titleKey;
        if (!el.dataset.origTitle) el.dataset.origTitle = el.textContent.trim();
    });

    // 统一点击处理（避免重复绑定）
    if (!visualEditBound) {
        doc.addEventListener('click', veClickHandler, true);
        visualEditBound = true;
    }
}

function disableVisualEdit() {
    const previewIframe = getPreviewIframe();
    if (!previewIframe) return;
    const doc = previewIframe.contentDocument;
    if (!doc) return;
    const style = doc.getElementById('visual-edit-style');
    if (style) style.remove();
    doc.querySelectorAll('.ve-editable').forEach(el => {
        el.classList.remove('ve-editable');
        delete el.dataset.veType;
        delete el.dataset.veModule;
        delete el.dataset.veField;
        delete el.dataset.veKey;
    });
    // 恢复 content-section 的 hidden 状态（保留第一个可见）
    const sections = doc.querySelectorAll('.content-section');
    sections.forEach((s, i) => { if (i > 0) s.classList.add('hidden'); });
    if (visualEditBound) { doc.removeEventListener('click', veClickHandler, true); visualEditBound = false; }
}

function veClickHandler(e) {
    if (!visualEditMode) return;
    const target = e.target.closest('.ve-editable');
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    openVisualEdit(target);
}

function openVisualEdit(el) {
    const type = el.dataset.veType;
    const fieldsContainer = document.getElementById('veFields');
    document.getElementById('veType').value = type;
    document.getElementById('veField').value = el.dataset.veField || '';
    document.getElementById('veModule').value = el.dataset.veModule || '';

    if (type === 'title') {
        document.getElementById('veTitle').textContent = '编辑系统标题';
        document.getElementById('veIcon').className = 'fas fa-heading mr-2 text-blue-600';
        const currentTitle = (document.getElementById('bf_systemTitle')?.value || '').trim();
        const fallback = `${(document.getElementById('bf_name').value.trim() || '示例学校')}食品安全检验管理系统`;
        fieldsContainer.innerHTML = `
            <div>
                <label class="block text-sm text-gray-600 mb-1">系统标题（留空则默认：<span class="text-gray-400">${escapeHtml(fallback)}</span>）</label>
                <input id="ve_input" type="text" maxlength="50" value="${escapeHtml(currentTitle)}" placeholder="${escapeHtml(fallback)}" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
            </div>`;
        document.getElementById('veHideBtn').classList.add('hidden');
    } else if (type === 'logo') {
        document.getElementById('veTitle').textContent = '编辑校徽';
        document.getElementById('veIcon').className = 'fas fa-image mr-2 text-blue-600';
        fieldsContainer.innerHTML = `
            <div>
                <label class="block text-sm text-gray-600 mb-1">校徽图片 URL（留空使用默认盾牌图标）</label>
                <input id="ve_input" type="url" value="${escapeHtml(document.getElementById('bf_logoUrl').value)}" placeholder="https://..." class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm">
            </div>`;
        document.getElementById('veHideBtn').classList.add('hidden');
    } else if (type === 'navcolor') {
        document.getElementById('veTitle').textContent = '编辑导航栏主题色';
        document.getElementById('veIcon').className = 'fas fa-palette mr-2 text-blue-600';
        const currentColor = document.getElementById('bf_themeColor').value || '#1a73e8';
        fieldsContainer.innerHTML = `
            <div>
                <label class="block text-sm text-gray-600 mb-1">主题色</label>
                <div class="flex items-center gap-2">
                    <input id="ve_input" type="text" value="${escapeHtml(currentColor)}" class="flex-1 px-3 py-2 border border-gray-300 rounded-lg">
                    <input id="ve_colorPicker" type="color" value="${escapeHtml(currentColor)}" class="w-10 h-10 rounded cursor-pointer border border-gray-300">
                </div>
            </div>`;
        document.getElementById('veHideBtn').classList.add('hidden');
        const picker = document.getElementById('ve_colorPicker');
        const input = document.getElementById('ve_input');
        picker.oninput = () => input.value = picker.value;
        input.oninput = () => picker.value = input.value;
    } else if (type === 'navitem') {
        const moduleCode = el.dataset.veModule;
        const info = MODULE_INFO[moduleCode] || { name: moduleCode };
        document.getElementById('veTitle').textContent = `编辑模块：${info.name}`;
        document.getElementById('veIcon').className = `fas ${info.icon} mr-2 text-blue-600`;
        const visibleTypes = new Set(Array.from(document.querySelectorAll('.vis-menu-item:checked')).map(cb => cb.value).filter(c => MODULE_REGISTRY[c]));
        fieldsContainer.innerHTML = `
            <div class="space-y-2">
                <label class="flex items-center gap-2">
                    <input id="ve_visible" type="checkbox" ${visibleTypes.has(moduleCode) ? 'checked' : ''}>
                    <span class="text-sm">在主界面显示此模块</span>
                </label>
                <p class="text-xs text-gray-400">取消勾选后，该校用户将看不到此检测模块</p>
            </div>`;
        document.getElementById('veHideBtn').classList.add('hidden');
    } else if (type === 'th') {
        const moduleCode = el.dataset.veModule;
        const origLabel = el.dataset.origLabel || el.textContent.trim();
        const fieldDef = (MODULE_FIELDS[moduleCode] || []).find(f => f.label === origLabel);
        const fieldName = fieldDef?.name || origLabel;
        const currentLabel = state.fieldLabels[fieldName] || origLabel;
        const isHidden = state.hiddenFields.has(fieldName);
        document.getElementById('veTitle').textContent = `编辑字段：${origLabel}`;
        document.getElementById('veIcon').className = 'fas fa-tag mr-2 text-blue-600';
        document.getElementById('veField').value = fieldName;
        fieldsContainer.innerHTML = `
            <div>
                <label class="block text-sm text-gray-600 mb-1">显示名称</label>
                <input id="ve_input" type="text" value="${escapeHtml(currentLabel)}" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <p class="text-xs text-gray-400 mt-1">技术字段名：<code>${escapeHtml(fieldName)}</code></p>
            </div>`;
        document.getElementById('veHideBtn').classList.remove('hidden');
        document.getElementById('veHideBtn').textContent = isHidden ? '显示此字段' : '隐藏此字段';
        document.getElementById('veHideBtn').onclick = () => {
            if (isHidden) state.hiddenFields.delete(fieldName);
            else state.hiddenFields.add(fieldName);
            renderFieldList();
            renderPreview();
            closeVisualEdit();
        };
    } else if (type === 'formselect') {
        const fieldName = el.dataset.veField;
        const moduleCode = el.dataset.veModule;
        // 获取当前选项（优先用 fieldOptions 覆盖值，否则用 iframe 内 select 的实际选项）
        const currentOpts = state.fieldOptions[fieldName] || Array.from(el.querySelectorAll('option')).map(o => o.textContent.trim());
        document.getElementById('veTitle').textContent = `编辑选项：${fieldName}`;
        document.getElementById('veIcon').className = 'fas fa-list mr-2 text-blue-600';
        document.getElementById('veField').value = fieldName;
        fieldsContainer.innerHTML = `
            <div>
                <label class="block text-sm text-gray-600 mb-2">选项列表（可增删改、拖拽排序）</label>
                <div id="veOptionsList" class="space-y-2"></div>
                <button type="button" id="veAddOption" class="mt-2 text-sm text-blue-600 hover:underline"><i class="fas fa-plus mr-1"></i>新增选项</button>
            </div>`;
        document.getElementById('veHideBtn').classList.add('hidden');

        const optsList = document.getElementById('veOptionsList');
        function renderOptsList(opts) {
            optsList.innerHTML = opts.map((opt, i) => `
                <div class="flex items-center gap-2" data-idx="${i}">
                    <input type="text" value="${escapeHtml(opt)}" class="ve-opt flex-1 px-2 py-1 border border-gray-300 rounded text-sm">
                    <button type="button" class="ve-opt-up px-2 text-gray-400 hover:text-gray-700" title="上移"><i class="fas fa-arrow-up"></i></button>
                    <button type="button" class="ve-opt-down px-2 text-gray-400 hover:text-gray-700" title="下移"><i class="fas fa-arrow-down"></i></button>
                    <button type="button" class="ve-opt-del px-2 text-red-500 hover:bg-red-50 rounded" title="删除"><i class="fas fa-trash"></i></button>
                </div>
            `).join('');
            // 绑定排序/删除
            optsList.querySelectorAll('.ve-opt-up').forEach(btn => {
                btn.onclick = () => {
                    const idx = parseInt(btn.parentElement.dataset.idx);
                    if (idx === 0) return;
                    const vals = getOptsValues();
                    [vals[idx-1], vals[idx]] = [vals[idx], vals[idx-1]];
                    renderOptsList(vals);
                };
            });
            optsList.querySelectorAll('.ve-opt-down').forEach(btn => {
                btn.onclick = () => {
                    const idx = parseInt(btn.parentElement.dataset.idx);
                    const vals = getOptsValues();
                    if (idx >= vals.length - 1) return;
                    [vals[idx+1], vals[idx]] = [vals[idx], vals[idx+1]];
                    renderOptsList(vals);
                };
            });
            optsList.querySelectorAll('.ve-opt-del').forEach(btn => {
                btn.onclick = () => btn.parentElement.remove();
            });
        }
        function getOptsValues() {
            return Array.from(optsList.querySelectorAll('.ve-opt')).map(i => i.value.trim()).filter(v => v);
        }
        renderOptsList(currentOpts);
        document.getElementById('veAddOption').onclick = () => {
            const div = document.createElement('div');
            div.className = 'flex items-center gap-2';
            div.dataset.idx = optsList.children.length;
            div.innerHTML = `
                <input type="text" value="" placeholder="新选项" class="ve-opt flex-1 px-2 py-1 border border-gray-300 rounded text-sm">
                <button type="button" class="ve-opt-up px-2 text-gray-400 hover:text-gray-700"><i class="fas fa-arrow-up"></i></button>
                <button type="button" class="ve-opt-down px-2 text-gray-400 hover:text-gray-700"><i class="fas fa-arrow-down"></i></button>
                <button type="button" class="ve-opt-del px-2 text-red-500 hover:bg-red-50 rounded"><i class="fas fa-trash"></i></button>
            `;
            optsList.appendChild(div);
            div.querySelector('.ve-opt-up').onclick = () => {
                const idx = parseInt(div.dataset.idx);
                const vals = getOptsValues();
                if (idx > 0) { [vals[idx-1], vals[idx]] = [vals[idx], vals[idx-1]]; renderOptsList(vals); }
            };
            div.querySelector('.ve-opt-down').onclick = () => {
                const idx = parseInt(div.dataset.idx);
                const vals = getOptsValues();
                if (idx < vals.length - 1) { [vals[idx+1], vals[idx]] = [vals[idx], vals[idx+1]]; renderOptsList(vals); }
            };
            div.querySelector('.ve-opt-del').onclick = () => div.remove();
            div.querySelector('.ve-opt').focus();
        };
        // 存储 getOptsValues 供 submit 使用
        document.getElementById('veForm').dataset.getOpts = '1';
    } else if (type === 'formlabel' || type === 'forminput') {
        const fieldName = el.dataset.veField;
        const moduleCode = el.dataset.veModule;
        const isLabel = type === 'formlabel';
        const currentText = isLabel
            ? (state.fieldLabels[fieldName] || el.textContent.replace(/[*\s]+$/,'').trim())
            : (state.fieldLabels[fieldName] || el.placeholder || '');
        document.getElementById('veTitle').textContent = `编辑${isLabel ? '标签' : '提示文字'}：${fieldName}`;
        document.getElementById('veIcon').className = 'fas fa-tag mr-2 text-blue-600';
        document.getElementById('veField').value = fieldName;
        fieldsContainer.innerHTML = `
            <div>
                <label class="block text-sm text-gray-600 mb-1">${isLabel ? '显示标签' : '输入框提示文字（placeholder）'}</label>
                <input id="ve_input" type="text" value="${escapeHtml(currentText)}" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <p class="text-xs text-gray-400 mt-1">技术字段名：<code>${escapeHtml(fieldName)}</code></p>
            </div>`;
        document.getElementById('veHideBtn').classList.add('hidden');
    } else if (type === 'heading') {
        const key = el.dataset.veKey;
        const origTitle = el.dataset.origTitle || el.textContent.trim();
        const current = state.sectionTitles[key] || origTitle;
        document.getElementById('veTitle').textContent = '编辑标题';
        document.getElementById('veIcon').className = 'fas fa-heading mr-2 text-blue-600';
        document.getElementById('veField').value = key; // 复用 veField 存放 titleKey
        fieldsContainer.innerHTML = `
            <div>
                <label class="block text-sm text-gray-600 mb-1">显示标题</label>
                <input id="ve_input" type="text" value="${escapeHtml(current)}" class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <p class="text-xs text-gray-400 mt-1">标识：<code>${escapeHtml(key)}</code></p>
            </div>`;
        document.getElementById('veHideBtn').classList.add('hidden');
    }

    document.getElementById('visualEditModal').classList.remove('hidden');
    document.getElementById('visualEditModal').classList.add('flex');
}

function closeVisualEdit() {
    document.getElementById('visualEditModal').classList.add('hidden');
    document.getElementById('visualEditModal').classList.remove('flex');
}

document.getElementById('veClose').addEventListener('click', closeVisualEdit);
document.getElementById('veCancel').addEventListener('click', closeVisualEdit);

document.getElementById('veForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const type = document.getElementById('veType').value;
    const fieldName = document.getElementById('veField').value;
    const input = document.getElementById('ve_input');
    const val = input?.value.trim();

    if (type === 'title') {
        document.getElementById('bf_systemTitle').value = val || '';
    } else if (type === 'logo') {
        document.getElementById('bf_logoUrl').value = val || '';
    } else if (type === 'navcolor') {
        const color = val || '#1a73e8';
        document.getElementById('bf_themeColor').value = color;
        document.getElementById('bf_themeColorPicker').value = color;
        state.selectedThemeId = null; // 手动改色 → 自定义主题
        highlightThemePreset();
    } else if (type === 'navitem') {
        const moduleCode = document.getElementById('veModule').value;
        const cb = document.querySelector(`.vis-menu-item[value="${moduleCode}"]`);
        if (cb) cb.checked = document.getElementById('ve_visible').checked;
        renderFieldModuleTabs();
    } else if (type === 'th') {
        const moduleCode = document.getElementById('veModule').value;
        const fieldDef = (MODULE_FIELDS[moduleCode] || []).find(f => f.name === fieldName);
        const origLabel = fieldDef?.label || fieldName;
        if (val && val !== origLabel) {
            state.fieldLabels[fieldName] = val;
        } else {
            delete state.fieldLabels[fieldName];
        }
        renderFieldList();
    } else if (type === 'formselect') {
        // 收集选项列表
        const optsList = document.getElementById('veOptionsList');
        const opts = Array.from(optsList.querySelectorAll('.ve-opt')).map(i => i.value.trim()).filter(v => v);
        if (opts.length) {
            state.fieldOptions[fieldName] = opts;
        } else {
            delete state.fieldOptions[fieldName];
        }
    } else if (type === 'formlabel' || type === 'forminput') {
        if (val) {
            state.fieldLabels[fieldName] = val;
        } else {
            delete state.fieldLabels[fieldName];
        }
        renderFieldList();
    } else if (type === 'heading') {
        const key = document.getElementById('veField').value;
        if (val) state.sectionTitles[key] = val;
        else delete state.sectionTitles[key];
    }

    if (type !== 'logo') markDirty();
    renderPreview();
    closeVisualEdit();
});
