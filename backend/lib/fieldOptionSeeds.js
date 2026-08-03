// fieldOptionSeeds.js — FieldOption 表（级联选项配置）的系统默认种子数据
//
// 与 admin-schools.html 的 MODULE_FIELDS 默认 options 对齐，作为「系统内置选项」的
// 单一事实源：新建租户 / 历史租户首次同步时，若某 (module, field) 顶级选项为空，
// 则自动插入本种子，保证管理端打开字段弹窗能看到系统默认选项、录入端有可用下拉。
//
// 结构：
//   FIELD_OPTION_SEEDS[module][field] = {
//     cascadeTarget?: string   // 子选项归属的目标字段码（仅级联源字段有；如 testType → location）
//     options: [               // 顶级选项列表（字符串 = value 与 label 相同）
//       '中文选项',
//       { value: 'atp', label: '表面清洁度', isDefault: true, children: ['子选项', ...] },
//     ]
//   }
//
// 说明：tableware.testType 的 value 为机器值（atp / detergent，录入端计算逻辑硬依赖），
// label 为显示文本；其 children 为 tableware.location 的选项行（跨字段级联）。
// 其它模块的普通下拉字段（result / meatType / tpmValue / canteen 等）不在此表，
// 仍由 SchoolCustomization.field_options（JSON）管理，两套体系互不干扰。

export const FIELD_OPTION_SEEDS = {
  tableware: {
    testType: {
      cascadeTarget: 'location',
      options: [
        {
          value: 'atp',
          label: '表面清洁度',
          isDefault: true,
          children: ['餐具表面', '砧板表面', '操作台面', '餐桌表面', '其他接触面'],
        },
        {
          value: 'detergent',
          label: '洗涤剂残留',
          children: ['不锈钢餐具', '密胺类餐具'],
        },
      ],
    },
    location: {
      options: ['餐具表面', '砧板表面', '操作台面', '餐桌表面', '其他接触面'],
    },
  },
};

/** 所有选项由 FieldOption 表管理的字段集合（用于后端校验/前端判定"级联字段"） */
export const TABLE_MANAGED_FIELDS = Object.fromEntries(
  Object.entries(FIELD_OPTION_SEEDS).map(([module, fields]) => [
    module,
    Object.keys(fields),
  ])
);
