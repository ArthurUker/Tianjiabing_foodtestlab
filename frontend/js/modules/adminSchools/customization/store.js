// ====== adminSchools 定制状态中心（第二阶段抽离自 admin-schools.html 内联 module）======
// 原页面散落的模块级 let 状态统一收敛至此，跨模块共享一律经 state 对象读写。
// markDirty / resetDirty / beforeunload 的 DOM 行为与原实现逐字保持一致。
export const state = {
    currentSchoolCode: null,   // 当前打开详情的学校代码（basicForm 保存、用户管理、定制保存均使用）
    allSchools: [],            // 学校列表缓存（loadSchools 拉取，openDetail 查找）
    selectedThemeId: null,     // 当前选中的主题预设 id（null = 未选/自定义颜色）
    currentCustomization: {},  // 当前学校定制（含乐观锁 updated_at 基线）

    // 当前编辑状态（字段维度）
    fieldLabels: {},       // { fieldName: customLabel }
    hiddenFields: new Set(), // [ fieldName, ... ]
    customFields: {},      // { moduleCode: [ { name, label }, ... ] }
    fieldOptions: {},      // { fieldName: [option1, option2, ...] }
    fieldTypes: {},        // { fieldName: 'text'|'number'|'date'|'select'|'textarea'|'checkbox' }  字段类型覆盖
    sectionTitles: {},     // { titleKey: "自定义标题" }  看板卡片 / 模块小标题
    fieldRules: {},        // { fieldName: { required, maxLength, minLength } }  傻瓜式校验规则
    fieldOrder: {},        // { moduleCode: [fieldName, ...] }  字段显示顺序（拖拽排序）
    fieldCascade: {},      // { module: { field: [ {value,label,isDefault,children:[{value,label}]} ] } }  级联字段选项（FieldOption 表）
    currentFieldModule: 'tableware', // 字段管理当前 tab
    customDirty: false,    // 界面定制是否有未保存修改
    logoStyle: null,       // 校徽排版配置（theme_config.logo_style），由编辑器写回
    logoStyleDirty: false, // 校徽排版是否有未保存修改（随「基本信息」保存）
};

export function markDirty() {
    state.customDirty = true;
    const b = document.getElementById('saveCustomBtn');
    if (b) b.innerHTML = '<i class="fas fa-save mr-2"></i>保存定制 <span class="text-xs opacity-80">● 未保存</span>';
    const d = document.getElementById('discardCustomBtn');
    if (d) d.classList.remove('hidden');
    const h = document.getElementById('customDirtyHint');
    if (h) { h.textContent = '有未保存的修改'; h.classList.remove('text-gray-400'); h.classList.add('text-amber-600'); }
}

export function resetDirty() {
    state.customDirty = false;
    const b = document.getElementById('saveCustomBtn');
    if (b) b.innerHTML = '<i class="fas fa-save mr-2"></i>保存定制';
    const d = document.getElementById('discardCustomBtn');
    if (d) d.classList.add('hidden');
    const h = document.getElementById('customDirtyHint');
    if (h) { h.textContent = '修改会实时反映到预览，点「保存定制」后对该校生效'; h.classList.add('text-gray-400'); h.classList.remove('text-amber-600'); }
}

// loadCustomization 开头整体重置字段编辑状态（原内联逐项赋值块的等价收敛）
export function resetFieldEditingState() {
    state.fieldLabels = {};
    state.hiddenFields = new Set();
    state.customFields = {};
    state.fieldOptions = {};
    state.fieldTypes = {};
    state.sectionTitles = {};
    state.fieldRules = {};
    state.fieldOrder = {};
    state.fieldCascade = {};
}

// 服务端字段 JSON（对象或字符串两种形态）安全解析
export function parseJSON(v) {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
}

// 刷新/关闭页面时的未保存保护
window.addEventListener('beforeunload', (e) => {
    if (state.customDirty) { e.preventDefault(); e.returnValue = ''; }
});
