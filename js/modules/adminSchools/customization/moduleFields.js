// ====== 模块字段定义（纯常量 + 纯函数，抽离自 admin-schools.html）======
// section 用于字段管理列表中按"表单分组"分块渲染：
//   main=主信息；points=检测点位信息；rectification=整改记录
//   缺省/未知归入 main（兼容旧数据 / 自定义字段）
import { MENU_ITEMS } from '/js/modules/registry.js';

// 模块信息映射（代码 → 中文名 + 图标），统一由注册中心派生，避免与前端重复维护
// 派生源：MENU_ITEMS（覆盖全部 12 个菜单项，含 5 检测模块 + 5 管理功能 + 数据看板 + 退出登录）。
// 检测模块在 MENU_ITEMS 与 MODULE_REGISTRY 中 label/icon 一致，后者被前者覆盖（同值，幂等）。
export const MODULE_INFO = Object.fromEntries(
    MENU_ITEMS.map((m) => [m.code, { name: m.label, icon: m.icon }])
);

export const SECTION_INFO = {
    main: { title: '主信息', showTitle: true },
    points: { title: '检测点位信息', showTitle: true },
    rectification: { title: '整改记录', showTitle: true },
};

export const MODULE_FIELDS = {
    tableware: [
        // 主信息（标题隐式）
        { name: 'testDate', label: '日期', builtin: true, type: 'date', section: 'main' },
        { name: 'canteen', label: '食堂', builtin: true, type: 'select', section: 'main' },  // 默认 options 来自学校基本信息设置（field_options.canteen）
        { name: 'inspector', label: '检测员', builtin: true, type: 'select', section: 'main' },  // 运行时从 users 列表填充
        // 检测点位信息
        { name: 'testType', label: '检测项目', builtin: true, type: 'select', section: 'points', options: ['表面清洁度', '洗涤剂残留'] },
        { name: 'location', label: '检测点位', builtin: true, type: 'select', section: 'points', options: ['餐具表面', '砧板表面', '操作台面', '餐桌表面', '其他接触面'] },
        { name: 'rluValue', label: 'RLU值', builtin: true, type: 'number', section: 'points' },
        { name: 'result', label: '结果', builtin: true, type: 'select', section: 'points', options: ['合格', '不合格'] },
        // 整改记录
        { name: 'correctiveAction', label: '整改措施', builtin: true, type: 'textarea', section: 'rectification' },
        { name: 'recheckResult', label: '复检结果备注', builtin: true, type: 'textarea', section: 'rectification' },
    ],
    pesticide: [
        // 基本信息（与 GenericTest 录入表单第一段对齐）
        { name: 'testDate', label: '日期', builtin: true, type: 'date', section: 'main' },
        { name: 'canteen', label: '食堂', builtin: true, type: 'select', section: 'main' },
        { name: 'inspector', label: '检测员', builtin: true, type: 'select', section: 'main' },
        // 检测点位信息（与录入表单第二段对齐）
        { name: 'vegetableType', label: '蔬菜品种', builtin: true, type: 'text', section: 'points' },
        // P2-定制修复：batchNo 由 text 改为 select（与录入端静态下拉一致），
        // 使界面定制中「检测项目」出现选项增删入口，避免"新增检测项目无显示/无可删除项目"。
        { name: 'batchNo', label: '检测项目', builtin: true, type: 'select', section: 'points', options: ['克百威-胶体金检测卡', '水胺硫磷-胶体金检测卡', '噻虫嗪-胶体金检测卡', '通用显色试纸', '二氧化硫显色试剂'] },
        { name: 'result', label: '结果', builtin: true, type: 'select', section: 'points', options: ['合格', '不合格'] },
    ],
    oil: [
        // 基本信息
        { name: 'testDate', label: '日期', builtin: true, type: 'date', section: 'main' },
        { name: 'canteen', label: '食堂', builtin: true, type: 'select', section: 'main' },
        { name: 'inspector', label: '检测员', builtin: true, type: 'select', section: 'main' },
        // 检测点位信息
        { name: 'oilTemp', label: '油温', builtin: true, type: 'number', section: 'points' },
        { name: 'tpmValue', label: '油品颜色', builtin: true, type: 'select', section: 'points', options: ['浅黄色', '淡黄色', '微绿色', '浅绿色', '明显绿色', '深绿色', '蓝色'] },
        { name: 'acidValue', label: '酸价值', builtin: true, type: 'number', section: 'points' },
        { name: 'qualityLevel', label: '品质等级', builtin: true, type: 'text', section: 'points' },
    ],
    leanMeat: [
        // 基本信息
        { name: 'testDate', label: '日期', builtin: true, type: 'date', section: 'main' },
        { name: 'canteen', label: '食堂', builtin: true, type: 'select', section: 'main' },
        { name: 'inspector', label: '检测员', builtin: true, type: 'select', section: 'main' },
        // 检测点位信息
        { name: 'meatType', label: '肉类品种', builtin: true, type: 'select', section: 'points', options: ['猪肉', '牛肉', '羊肉', '鸡肉', '鸭肉', '其他'] },
        // P2-定制修复：batchNo 由 text 改为 select（与录入端静态下拉一致），
        // 使界面定制中「检测项目」出现选项增删入口，避免"新增检测项目无显示/无可删除项目"。
        { name: 'batchNo', label: '检测项目', builtin: true, type: 'select', section: 'points', options: ['恩诺沙星-胶体金检测卡', '氟苯尼考-胶体金检测卡', '盐酸克伦特罗-胶体金检测卡', '莱克多巴胺-胶体金检测卡', '沙丁胺醇-胶体金检测卡', '铅-重金属检测（GB 2762 鱼虾类≤0.5mg/kg）', '镉-重金属检测（GB 2762 鱼虾类≤0.1mg/kg）'] },
        { name: 'result', label: '结果', builtin: true, type: 'select', section: 'points', options: ['合格', '不合格'] },
    ],
};

// 字段在表单中的分组（与 Tableware.js 的录入表单保持一致）。
// 字段管理列表按此顺序分块渲染，每段可显示标题。
export const SECTION_ORDER = ['main', 'points', 'rectification'];

// 模块特定的 'points' 段标题（与 GenericTest 录入表单保持一致）
export const POINTS_TITLE_BY_MODULE = {
    pesticide: '果蔬农残检测信息',
    oil: '食用油品质检测信息',
    leanMeat: '肉蛋农残检测信息',
};

// 级联字段的选项整体存于租户 FieldOption 表（不在 field_options JSON）：
//   - value（机器值，如 atp）/ label（显示文本，如 表面清洁度）可分离
//   - 顶级选项 + 子选项（跨字段联动：testType → location）
// 编辑实时写回内存 fieldCascade，随「保存定制」统一 PUT 到后端。
export const TABLE_MANAGED_FIELDS = { tableware: ['testType', 'location'] };
// 级联源字段 → 联动目标字段（source 顶级选项的 children 归属 target 字段）
export const CASCADE_SOURCE_MAP = { tableware: { testType: 'location' } };

export function isTableManagedField(module, field) {
    return Array.isArray(TABLE_MANAGED_FIELDS[module]) && TABLE_MANAGED_FIELDS[module].includes(field);
}

export function isCascadeSource(module, field) {
    return !!(CASCADE_SOURCE_MAP[module] && CASCADE_SOURCE_MAP[module][field]);
}

export function fieldLabelOf(field) {
    return { testType: '检测项目', location: '检测点位' }[field] || field;
}

// 按保存的顺序对字段列表做稳定重排（未列出的保持原相对位置并排在后面）
export function orderFields(list, order) {
    if (!Array.isArray(order) || !order.length) return list;
    const pos = new Map(order.map((n, i) => [n, i]));
    return list
        .map((f, i) => ({ f, i }))
        .sort((a, b) => {
            const pa = pos.has(a.f.name) ? pos.get(a.f.name) : Infinity;
            const pb = pos.has(b.f.name) ? pos.get(b.f.name) : Infinity;
            return pa !== pb ? pa - pb : a.i - b.i;
        })
        .map(x => x.f);
}
