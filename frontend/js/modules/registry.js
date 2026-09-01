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
    label: '肉蛋农残检测',
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

/**
 * 菜单项注册表（菜单栏定制）：覆盖侧边栏全部可定制项
 * （检测模块 + 管理功能 + 数据看板 + 退出登录）。
 * 与 MODULE_REGISTRY 互补：本表管"菜单栏显隐定制"，MODULE_REGISTRY 继续管"检测模块注册"。
 * 退出登录（logout）的 domSelector 用 ID 选择器（无 data-target），其它用 data-target 属性。
 * canHide=false 表示强制始终显示（如退出登录，不允许被定制隐藏）。
 */
export const MENU_ITEMS = [
    { code: 'dashboard',       label: '数据看板',       icon: 'fa-tachometer-alt',  domSelector: '[data-target="dashboard"]',       category: 'data',   canHide: true,  defaultVisible: true },
    { code: 'tableware',       label: '餐具洁净度',     icon: 'fa-utensils',        domSelector: '[data-target="tableware-test"]',  category: 'test',   canHide: true,  defaultVisible: true },
    { code: 'pesticide',       label: '果蔬农残',       icon: 'fa-leaf',            domSelector: '[data-target="pesticide-test"]',  category: 'test',   canHide: true,  defaultVisible: true },
    { code: 'oil',             label: '食用油品质',     icon: 'fa-oil-can',         domSelector: '[data-target="oil-test"]',        category: 'test',   canHide: true,  defaultVisible: true },
    { code: 'leanMeat',        label: '肉蛋农残检测',   icon: 'fa-drumstick-bite',  domSelector: '[data-target="lean-meat-test"]',  category: 'test',   canHide: true,  defaultVisible: true },
    { code: 'pathogen',        label: '致病菌检测',     icon: 'fa-virus',           domSelector: '[data-target="pathogen-test"]',   category: 'test',   canHide: true,  defaultVisible: true },
    { code: 'adminSchools',    label: '学校管理',       icon: 'fa-school',          domSelector: '[data-target="admin-schools"]',   category: 'admin',  canHide: true,  defaultVisible: true, adminOnly: true },
    { code: 'exportData',      label: '数据导出',       icon: 'fa-file-export',     domSelector: '[data-target="export-data"]',     category: 'admin',  canHide: true,  defaultVisible: true, adminOnly: true },
    { code: 'backupRestore',   label: '数据备份与恢复', icon: 'fa-history',         domSelector: '[data-target="backup-restore"]',  category: 'admin',  canHide: true,  defaultVisible: true, adminOnly: true },
    { code: 'userManagement',  label: '用户管理',       icon: 'fa-users',           domSelector: '[data-target="user-management"]', category: 'admin',  canHide: true,  defaultVisible: true, adminOnly: true },
    { code: 'auditLog',        label: '审计日志',       icon: 'fa-clipboard-list',  domSelector: '[data-target="audit-log"]',       category: 'admin',  canHide: true,  defaultVisible: true, adminOnly: true },
    { code: 'logout',          label: '退出登录',       icon: 'fa-sign-out-alt',    domSelector: '#sidebarBtnLogout',              category: 'action', canHide: false, defaultVisible: true },
]

/** 默认可见菜单项（visible_menu_items 缺省时使用） */
export function getDefaultVisibleMenuItems() {
    return MENU_ITEMS.filter((m) => m.defaultVisible).map((m) => m.code)
}

/** 校验某 code 是否为已注册菜单项 */
export function isValidMenuItemCode(code) {
    return MENU_ITEMS.some((m) => m.code === code)
}

/** 按 code 查找菜单项 */
export function getMenuItemByCode(code) {
    return MENU_ITEMS.find((m) => m.code === code) || null
}

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
