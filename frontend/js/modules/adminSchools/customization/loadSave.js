// ====== 界面定制加载 / 联动 / 保存（机械迁移自 admin-schools.html 2630-2754 + 3022-3072 + 3601-3781）======
// 含：loadCustomization、菜单可见项渲染、预览联动绑定、级联选项整树提交、保存定制（含乐观锁）。
// renderCanteenInputs / updateBadgeStyleHint 属学校详情域，由装配层注入（避免与 detailView 循环依赖）。
import { state, markDirty, resetDirty, parseJSON } from './store.js';
import { MODULE_FIELDS, TABLE_MANAGED_FIELDS, orderFields } from './moduleFields.js';
import { showNotice } from '../ui.js';
import { adminFetch } from '../context.js';
import { renderPreview, getActiveTheme } from '../preview.js';
import { applyAdminTheme, highlightThemePreset } from '../adminTheme.js';
import { renderFieldModuleTabs, renderFieldList } from './fieldList.js';
import { setSchoolCustomization } from '/js/utils/schoolCustomization.js';
import { MENU_ITEMS, MODULE_REGISTRY } from '/js/modules/registry.js';

let renderCanteenInputs = () => {};
let updateBadgeStyleHint = () => {};
export function initLoadSave({ renderCanteenInputs: rc, updateBadgeStyleHint: ub }) {
    renderCanteenInputs = rc;
    updateBadgeStyleHint = ub;
}

// 丢弃未保存的修改：重新加载服务端定制
document.getElementById('discardCustomBtn').addEventListener('click', () => { loadCustomization(); });

// 加载某校定制（含级联 FieldOption），渲染到编辑区
export async function loadCustomization() {
    if (!state.currentSchoolCode) return;
    // 重置状态
    state.fieldLabels = {};
    state.hiddenFields = new Set();
    state.customFields = {};
    state.fieldOptions = {};
    state.fieldTypes = {};
    state.sectionTitles = {};
    state.fieldRules = {};
    state.fieldOrder = {};
    state.fieldCascade = {};   // 级联字段选项（FieldOption 表）

    // 首次进入时渲染菜单项 checkbox DOM（dataset 标记防重复，避免重建 DOM 丢失用户勾选）
    const menuContainer = document.getElementById('visibleMenuItems');
    if (menuContainer && !menuContainer.dataset.rendered) {
        renderVisibleMenuItems();
        menuContainer.dataset.rendered = '1';
    }

    try {
        const resp = await adminFetch(`/api/admin/schools/${state.currentSchoolCode}/customization`);
        if (resp.ok) {
            const json = await resp.json();
            const c = json.data || {};
            state.currentCustomization = c;

            // 优先读 visible_menu_items（新字段）；旧数据只有 visible_types 时兜底
            const savedMenuItems = parseJSON(c.visible_menu_items);
            const visTypes = parseJSON(c.visible_types) || [];
            const menuItemsToCheck = savedMenuItems !== null
                ? savedMenuItems
                : [...visTypes, 'dashboard', 'adminSchools', 'exportData', 'backupRestore', 'userManagement', 'auditLog', 'logout'];
            document.querySelectorAll('.vis-menu-item').forEach(cb => { cb.checked = menuItemsToCheck.includes(cb.value); });

            state.fieldLabels = parseJSON(c.field_labels) || {};
            state.hiddenFields = new Set(parseJSON(c.hidden_fields) || []);
            // 顶层新列优先，回退 theme_config 嵌套（兼容旧数据）
            state.customFields = parseJSON(c.custom_fields) || parseJSON(c.theme_config)?.custom_fields || {};
            state.fieldTypes = parseJSON(c.field_types) || parseJSON(c.theme_config)?.field_types || {};
            state.fieldOptions = parseJSON(c.field_options) || parseJSON(c.theme_config)?.field_options || {};
            // 级联字段选项（FieldOption 表）：后端 GET customization 已把 field_cascade 合并进 data
            state.fieldCascade = (parseJSON(c.field_cascade) && typeof c.field_cascade === 'object') ? parseJSON(c.field_cascade) : {};
            Object.keys(TABLE_MANAGED_FIELDS).forEach(mod => {
                if (!state.fieldCascade[mod]) state.fieldCascade[mod] = {};
                TABLE_MANAGED_FIELDS[mod].forEach(f => {
                    if (!Array.isArray(state.fieldCascade[mod][f])) state.fieldCascade[mod][f] = [];
                });
            });
            state.sectionTitles = parseJSON(c.theme_config)?.section_titles || {};
            const sysTitleVal = parseJSON(c.theme_config)?.systemTitle || '';
            document.getElementById('bf_systemTitle').value = sysTitleVal;
            const sysCount = document.getElementById('bf_systemTitleCount');
            if (sysCount) sysCount.textContent = Array.from(sysTitleVal).length;
            // 学校食堂信息回填（canteens 新列优先；兼容旧数据从 field_options.canteen 读取）
            let canteens = parseJSON(c.canteens);
            if (!Array.isArray(canteens) || !canteens.length) {
                const foOpts = parseJSON(c.field_options)?.canteen;
                if (Array.isArray(foOpts) && foOpts.length) canteens = foOpts;
            }
            renderCanteenInputs(Array.isArray(canteens) ? canteens : []);
            // RBAC 收敛：回填访客功能开关（boolean 列，非 JSON）
            const guestEnabledEl = document.getElementById('bf_guestEnabled');
            if (guestEnabledEl) guestEnabledEl.checked = !!c.guest_enabled;
            state.fieldOrder = parseJSON(c.field_order) || parseJSON(c.theme_config)?.field_order || {};
            // 校徽排版配置（主题定制一部分）。存在未保存修改时保留内存中的草稿，
            // 避免从基本信息 Tab 进入「界面定制」时把刚排好的校徽覆盖掉。
            // 校徽排版：仅当界面定制与基本信息均无未保存修改时，才用服务端值覆盖内存值（避免丢失未保存的编辑）
            if (!state.customDirty && !state.logoStyleDirty) {
                state.logoStyle = parseJSON(c.theme_config)?.logo_style || null;
            }
            updateBadgeStyleHint();

            // 回显已保存的预设主题
            const savedTheme = parseJSON(c.theme_config)?.theme;
            state.selectedThemeId = (savedTheme?.preset && window.SchoolThemes.getPreset(savedTheme.preset)) ? savedTheme.preset : null;
            if (savedTheme?.accent) {
                document.getElementById('bf_themeColor').value = savedTheme.accent;
                document.getElementById('bf_themeColorPicker').value = savedTheme.accent;
            }
            highlightThemePreset();

            // XR-04：拿到完整 theme_config 后，用与师生端一致的 resolveTheme 精确化管理端主题
            applyAdminTheme({
                themeColor: document.getElementById('bf_themeColor').value.trim(),
                customization: c,
            });

            const rules = parseJSON(c.field_rules) || {};
            state.fieldRules = rules;
        } else {
            document.querySelectorAll('.vis-menu-item').forEach(cb => { cb.checked = true; });
            state.fieldRules = {};
        }
    } catch (e) {
        console.warn('⚠️ 加载定制配置失败，使用默认值:', e.message);
        document.querySelectorAll('.vis-menu-item').forEach(cb => { cb.checked = true; });
        state.fieldRules = {};
    }
    renderFieldModuleTabs();
    renderFieldList();
    bindPreviewEvents();
    renderPreview();
    resetDirty();
}

// 按 MENU_ITEMS 注册表渲染菜单可见项 checkbox（按 category 分组）。退出登录项 canHide=false 强制 checked+disabled
function renderVisibleMenuItems() {
    const container = document.getElementById('visibleMenuItems');
    if (!container) return;
    const groups = [
        { key: 'data',   label: '数据看板', icon: 'fa-chart-line' },
        { key: 'test',   label: '检测模块', icon: 'fa-flask' },
        { key: 'admin',  label: '管理功能', icon: 'fa-shield-halved' },
        { key: 'action', label: '其它',    icon: 'fa-ellipsis' },
    ];
    container.innerHTML = groups.map(g => {
        const items = MENU_ITEMS.filter(m => m.category === g.key);
        if (!items.length) return '';
        return `
            <div>
                <div class="text-xs font-medium text-gray-500 mb-1.5"><i class="fas ${g.icon} mr-1"></i>${g.label}</div>
                <div class="flex flex-col gap-1 pl-1">
                    ${items.map(m => `
                        <label class="flex items-center gap-2 text-sm">
                            <input type="checkbox" value="${m.code}" class="vis-menu-item" data-category="${m.category}" ${m.canHide ? '' : 'checked disabled'}>
                            <i class="fas ${m.icon} w-4 text-gray-500"></i>
                            <span>${m.label}</span>
                            ${m.canHide ? '' : '<span class="text-xs text-gray-400 ml-auto">强制显示</span>'}
                        </label>
                    `).join('')}
                </div>
            </div>
        `;
    }).join('');
}

// 绑定预览联动
function bindPreviewEvents() {
    document.querySelectorAll('.vis-menu-item').forEach(cb => {
        cb.onchange = () => { renderFieldModuleTabs(); markDirty(); renderPreview(); };
    });
    ['bf_name', 'bf_logoUrl', 'bf_systemTitle'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.oninput = () => {
            if (id === 'bf_systemTitle') {
                const c = document.getElementById('bf_systemTitleCount');
                if (c) c.textContent = Array.from(el.value).length;
            }
            renderPreview();
        };
    });
    const themeEl = document.getElementById('bf_themeColor');
    if (themeEl) themeEl.oninput = () => { markDirty(); renderPreview(); };
    const themePicker = document.getElementById('bf_themeColorPicker');
    if (themePicker) themePicker.oninput = () => { document.getElementById('bf_themeColor').value = themePicker.value; markDirty(); renderPreview(); };
}

// 级联字段选项整树提交（FieldOption 表，PUT 幂等替换）
async function saveFieldCascade() {
    for (const module of Object.keys(TABLE_MANAGED_FIELDS)) {
        const fields = state.fieldCascade[module] || {};
        for (const field of Object.keys(fields)) {
            const options = (fields[field] || []).map(o => ({
                value: o.value,
                label: o.label || o.value,
                isDefault: !!o.isDefault,
                children: Array.isArray(o.children) ? o.children.map(c => ({ value: c.value, label: c.label || c.value })) : [],
            }));
            const resp = await adminFetch(`/api/admin/schools/${state.currentSchoolCode}/field-options`, {
                method: 'PUT',
                body: JSON.stringify({ module_code: module, field_code: field, options })
            });
            if (!resp.ok) {
                const j = await resp.json().catch(() => ({}));
                throw new Error(`保存级联「${module}.${field}」失败：${j.error || ('HTTP ' + resp.status)}`);
            }
        }
    }
}

// 保存定制
document.getElementById('saveCustomBtn').addEventListener('click', async () => {
    const btn = document.getElementById('saveCustomBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';

    try {
        // 收集可见菜单项（菜单栏定制）。退出登录强制包含（disabled 不会被 :checked 选中）
        const visibleMenuItems = Array.from(document.querySelectorAll('.vis-menu-item:checked')).map(cb => cb.value);
        if (!visibleMenuItems.includes('logout')) visibleMenuItems.push('logout');
        // 校验：至少保留一个检测模块
        const visibleTypesFromMenu = visibleMenuItems.filter(c => MODULE_REGISTRY[c]);
        if (!visibleTypesFromMenu.length && !confirm('当前没有勾选任何检测模块，该校主界面将不显示任何检测功能。确定要这样保存吗？')) {
            throw Object.assign(new Error('已取消保存'), { silent: true });
        }

        // 收口：清洗 fieldOrder —— 只保留有效字段名；与默认顺序一致的模块不再写入
        const cleanedOrder = {};
        Object.entries(state.fieldOrder).forEach(([mod, order]) => {
            if (!Array.isArray(order) || !order.length) return;
            const validNames = [
                ...(MODULE_FIELDS[mod] || []).map(f => f.name),
                ...((state.customFields[mod] || []).map(f => f.name)),
            ];
            const validSet = new Set(validNames);
            const filtered = order.filter(n => validSet.has(n));
            if (!filtered.length) return;
            // 与默认顺序完全一致则无需持久化
            const effective = orderFields(
                [...(MODULE_FIELDS[mod] || []), ...((state.customFields[mod] || []))],
                filtered
            ).map(f => f.name);
            if (effective.join(',') !== validNames.join(',')) cleanedOrder[mod] = filtered;
        });
        state.fieldOrder = cleanedOrder;

        // 收集字段规则（已通过弹层写入全局 fieldRules 状态）
        const collectedRules = {};
        Object.entries(state.fieldRules).forEach(([k, r]) => {
            const rule = {};
            if (r && r.required) rule.required = true;
            if (r && r.maxLength > 0) rule.maxLength = r.maxLength;
            if (r && r.minLength > 0) rule.minLength = r.minLength;
            if (Object.keys(rule).length) collectedRules[k] = rule;
        });

        // fieldLabels / hiddenFields / customFields 已在状态变量中维护
        // customFields 存入 theme_config.custom_fields；预设主题存入 theme_config.theme
        const activeTheme = getActiveTheme();
        const themePayload = activeTheme ? {
            preset: state.selectedThemeId,
            accent: activeTheme.accent,
            accentStrong: activeTheme.accentStrong,
            aurora: activeTheme.aurora,
            wash: activeTheme.wash,
            base: activeTheme.base,
            dark: activeTheme.dark,
            darkSolid: activeTheme.darkSolid,
        } : null;
        // 级联字段（testType/location）的选项由 FieldOption 表管理，不写 field_options JSON
        // （避免录入端 fields.js 用文本数组覆盖 value/label 分离的下拉）；
        // 同时清理历史遗留的 field_options.cascade 简化版数据（完整重做后不再使用）。
        const fieldOptionsPayload = { ...state.fieldOptions };
        Object.keys(TABLE_MANAGED_FIELDS).forEach(mod => {
            TABLE_MANAGED_FIELDS[mod].forEach(f => delete fieldOptionsPayload[f]);
        });
        delete fieldOptionsPayload.cascade;
        const themeConfig = { custom_fields: state.customFields, field_options: fieldOptionsPayload, section_titles: state.sectionTitles, field_order: state.fieldOrder, theme: themePayload, logo_style: state.logoStyle || undefined };
        // RK-LS：保留「登录样式」模块已保存的 login（避免界面定制整写 theme_config 时把它清空）
        const preservedLogin = parseJSON(state.currentCustomization?.theme_config)?.login;
        if (preservedLogin) themeConfig.login = preservedLogin;
        // 顶部状态栏标题（系统标题）：与基本信息共用同一字段 bf_systemTitle，整写 theme_config 时须一并保留，
        // 否则在「基本信息」保存的 systemTitle 会被「界面定制」保存覆盖清空。
        const sysTitleVal = (document.getElementById('bf_systemTitle')?.value || '').trim();
        if (sysTitleVal) themeConfig.systemTitle = sysTitleVal;

        // 层级A全链路：custom_fields 同步 required（来自校验规则），供录入端直接渲染必填
        const customFieldsPayload = {};
        Object.entries(state.customFields).forEach(([mod, list]) => {
            customFieldsPayload[mod] = (list || []).map(f => {
                const def = { ...f };
                delete def.builtin;
                if (collectedRules[f.name]?.required) def.required = true;
                return def;
            });
        });

        const customizationPayload = {
            visible_types: visibleTypesFromMenu,
            visible_menu_items: visibleMenuItems,
            field_labels: state.fieldLabels,
            hidden_fields: Array.from(state.hiddenFields),
            field_rules: collectedRules,
            theme_config: themeConfig,
            // 顶层新列（与 theme_config 嵌套并行写入；录入/统计端消费顶层列）
            custom_fields: customFieldsPayload,
            field_options: fieldOptionsPayload,
            field_order: state.fieldOrder,
            field_types: state.fieldTypes,
            // BS-06: 乐观锁——加载时的 updated_at，被他人改过则后端返回 409
            expected_updated_at: state.currentCustomization?.updated_at || undefined
        };
        const resp = await adminFetch(`/api/admin/schools/${state.currentSchoolCode}/customization`, {
            method: 'PUT',
            body: JSON.stringify(customizationPayload)
        });
        // BS-06: 并发冲突处理
        if (resp.status === 409) {
            showNotice('保存失败：该校定制配置刚被其他人修改。请复制你的改动要点，点击学校重新打开后再改。', 'error');
            return;
        }
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error || '保存失败');

        // 级联字段选项（FieldOption 表）整树提交
        await saveFieldCascade();

        // BS-06: 刷新乐观锁基线，避免连续两次保存误报冲突
        if (json.updated_at && state.currentCustomization) state.currentCustomization.updated_at = json.updated_at;

        // 写入本地定制缓存：跨标签页 storage 事件触发该校师生端实时重应用，
        // 无需等待 5 分钟 TTL 或手动刷新页面（预览区亦随之刷新）。
        // 优先重新拉取公开 config（其 customization 含 field_cascade 级联数据），
        // 保证师生端缓存完整（否则保存后级联下拉会暂时缺失直到 TTL 过期重拉）。
        try {
            let freshCustomization = null;
            try {
                const freshResp = await adminFetch(`/api/schools/${state.currentSchoolCode}/config`);
                if (freshResp.ok) {
                    const freshJson = await freshResp.json();
                    freshCustomization = freshJson.data?.customization || null;
                }
            } catch (_) { /* 拉取失败则回落内存 payload */ }
            setSchoolCustomization(state.currentSchoolCode, freshCustomization || customizationPayload);
        } catch (_) { /* 非关键路径 */ }

        // 同步强调色到学校基本信息（theme_color），保证列表/兜底展示一致
        if (themePayload?.accent) {
            try {
                await adminFetch(`/api/admin/schools/${state.currentSchoolCode}`, {
                    method: 'PUT',
                    body: JSON.stringify({ themeColor: themePayload.accent })
                });
            } catch (_) { /* 非关键路径，忽略 */ }
        }
        showNotice('✅ 定制配置已保存，该校师生刷新页面后即可看到新界面', 'success');
        resetDirty();
    } catch (e) {
        if (!e.silent) showNotice('❌ ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        if (state.customDirty) btn.innerHTML = '<i class="fas fa-save mr-2"></i>保存定制 <span class="text-xs opacity-80">● 未保存</span>';
        else btn.innerHTML = '<i class="fas fa-save mr-2"></i>保存定制';
    }
});
