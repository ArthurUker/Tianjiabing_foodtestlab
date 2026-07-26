// js/modules/registry.js
// RK32 / RK34：统一模块注册中心。
// 取代分散在 admin-schools.html 的 MODULE_INFO / navTargetMap / moduleSectionMap
// 与 schoolCustomization.js 内零散的模块常量，成为「检测模块」的单一事实来源。
// 新增检测类型时只需在此登记，导航、可见性、字段应用、管理后台预览均自动跟随。

/** 检测模块注册表：code -> 元信息 */
export const MODULE_REGISTRY = {
  tableware: {
    code: 'tableware',
    label: '餐具洁净度',
    icon: 'fa-utensils',
    navTarget: 'tableware-test',   // 对应导航按钮 data-target 与内容区 id
    formId: 'tablewareTestForm',   // 静态定制字段表单 id（pathogen 无静态表单）
    defaultVisible: true,
  },
  pesticide: {
    code: 'pesticide',
    label: '果蔬农残',
    icon: 'fa-leaf',
    navTarget: 'pesticide-test',
    formId: 'pesticideTestForm',
    defaultVisible: true,
  },
  oil: {
    code: 'oil',
    label: '食用油品质',
    icon: 'fa-oil-can',
    navTarget: 'oil-test',
    formId: 'oilTestForm',
    defaultVisible: true,
  },
  leanMeat: {
    code: 'leanMeat',
    label: '瘦肉精检测',
    icon: 'fa-drumstick-bite',
    navTarget: 'lean-meat-test',
    formId: 'leanMeatTestForm',
    defaultVisible: true,
  },
  pathogen: {
    code: 'pathogen',
    label: '致病菌检测',
    icon: 'fa-virus',
    navTarget: 'pathogen-test',
    formId: null, // 由 initPathogen 独立处理，不进入静态定制字段管线
    defaultVisible: true,
  },
};

/** 导航展示顺序（同时决定看板/预览中各模块的出现次序） */
export const MODULE_ORDER = ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'];

export function getAllModules() {
  return MODULE_ORDER.map((code) => MODULE_REGISTRY[code]);
}

export function getModuleByCode(code) {
  return MODULE_REGISTRY[code] || null;
}

export function getModuleByNavTarget(target) {
  return getAllModules().find((m) => m.navTarget === target) || null;
}

export function getNavTargetForModule(code) {
  const m = MODULE_REGISTRY[code];
  return m ? m.navTarget : null;
}

export function getFormIdForModule(code) {
  const m = MODULE_REGISTRY[code];
  return m ? m.formId : null;
}

/** 默认可见模块（visible_types 缺省时使用） */
export function getDefaultVisibleTypes() {
  return getAllModules()
    .filter((m) => m.defaultVisible)
    .map((m) => m.code);
}

/** 校验某 code 是否为已注册模块 */
export function isValidModuleCode(code) {
  return Boolean(MODULE_REGISTRY[code]);
}
