// openApiFieldSchema.js — 开放接口「对外字段契约」的单一事实源
//
// 三处复用同一份定义，避免手写三套逐渐漂移：
//   ① GET /api/open/v1/dict     → 字段字典（对方据此写映射）
//   ② GET /api/open/v1/samples  → 合成样例（对方在无真实数据时即可开发）
//   ③ 超管「接入说明」          → 接入包内容
// 真实响应仍由 openApiScope.buildOpenRecord 生成（同一套投影规则），
// 样例先构造「合成原始记录」再走同一投影，保证样例与真实响应形态一致。

import crypto from 'node:crypto'
import { isPiiKey } from './openApiScope.js'
//
// 字段清单依据（2026-09-15 只读元数据核验，见 backend/tests/openapi/db-readonly-checks.mjs）：
//   leanMeat  : batchNo/canteen/inspector/meatType/remark/result/testDate
//   oil       : acidValue/colorLevel/oilTemp/tpmValue/canteen/inspector/remark/testDate
//   pathogen  : allTestItems[]/positiveDetails[]/positiveItems/riskLevel/riskReason/internalControlStatus/recheckReports[]/modificationLogs[]
//   pesticide : vegetableType/batchNo/result/remark/canteen/inspector/testDate
//   tableware : atpPoints[]/location/rluValue(字符串!)/result/testType/correctiveAction/recheckResult/recheckRecords[]/finalStatus/modificationLogs[]
//   复检      : 仅 tableware(recheckRecords) 与 pathogen(recheckReports) 真实存在，故只有这两类产出复检样例
//
// ⚠️ 契约约定：字段一律按**对外响应中的路径**描述（顶层字段直接写名，业务字段统一在 result.* 下）。
//    v1 内的历史行为修正与客户端升级要求见 docs/OPEN_API_INTEGRATION.md。

export const OPEN_API_CONTRACT_VERSION = 'v1'

/** 结论枚举（与 openApiScope.deriveConclusion 的取值一一对应）。 */
export const CONCLUSION_VALUES = [
  { value: 'pass', label: '合格', description: '按记录内保存的判定结果为合格' },
  { value: 'fail', label: '不合格', description: '按记录内保存的判定结果为不合格' },
  { value: 'warning', label: '警戒', description: '记录内保存的判定含“警戒”（如餐具 ATP 200~500 RLU）' },
  { value: 'unknown', label: '未判定', description: '记录内没有可解析的判定文本（不等于“不合格”）' },
]

/** 仅当授权开启 include_inspector 时才出现在响应中的字段（字典会标注 conditional）。 */
const INSPECTOR_FIELD = {
  path: 'inspector', label: '检测人姓名', type: 'string', unit: null, nullable: true, required: false,
  conditional: true, conditional_on: 'include_inspector',
  description: '仅当该学校授权开启「下发检测人姓名」时出现；关闭时该字段不存在（含复检/修改轨迹内的姓名一律不下发）',
  source: 'platform',
}

const COMMON_FIELDS = [
  { path: 'record_id', label: '平台内部记录 ID', type: 'string', unit: null, nullable: false, required: true, description: '平台数据库主键，仅用于排障；业务幂等请用 record_code', source: 'platform' },
  { path: 'record_code', label: '记录业务码', type: 'string', unit: null, nullable: false, required: true, description: '跨次拉取稳定不变的业务唯一键，用于本地 upsert 与清单比对', source: 'platform' },
  { path: 'school_code', label: '学校代码', type: 'string', unit: null, nullable: false, required: true, description: '平台学校代码（schema 名去前缀）', source: 'platform' },
  { path: 'school_name', label: '学校名称', type: 'string', unit: null, nullable: false, required: true, source: 'platform' },
  { path: 'test_type', label: '检测类型', type: 'enum', unit: null, nullable: false, required: true, enum: ['tableware', 'pesticide', 'oil', 'leanMeat', 'pathogen'], description: '类型白名单由授权决定', source: 'platform' },
  { path: 'test_name', label: '检测类型名称', type: 'string', unit: null, nullable: false, required: true, source: 'platform' },
  { path: 'test_date', label: '检测业务日期', type: 'date', unit: null, nullable: true, required: false, format: 'YYYY-MM-DD', description: '业务日期；极少数历史记录为空（与结论无关，不得据此判定为未完成）', source: 'platform' },
  { path: 'canteen', label: '食堂', type: 'string', unit: null, nullable: true, required: false, source: 'platform' },
  { path: 'status', label: '记录状态', type: 'enum', unit: null, nullable: false, required: true, enum: ['pending', 'completed', 'failed', 'archived'], source: 'platform' },
  { path: 'initial_conclusion', label: '初检结论', type: 'enum', unit: null, nullable: false, required: true, enum: CONCLUSION_VALUES.map((c) => c.value), description: '无复检时按当前保存值映射；有复检且未保存独立初检快照时为 unknown，不逆推', source: 'platform' },
  { path: 'final_conclusion', label: '最终结论', type: 'enum', unit: null, nullable: false, required: true, enum: CONCLUSION_VALUES.map((c) => c.value), description: '有复检时取复检结论，否则与初检一致', source: 'platform' },
  { path: 'conclusion', label: '结论（对外统一口径）', type: 'enum', unit: null, nullable: false, required: true, enum: CONCLUSION_VALUES.map((c) => c.value), description: '等于 final_conclusion，推荐直接使用此字段', source: 'platform' },
  { path: 'final_conclusion_basis', label: '最终结论来源', type: 'enum', unit: null, nullable: false, required: true, enum: ['initial', 'recheck'], description: 'initial=无复检、沿用初检；recheck=由复检结论覆盖', source: 'platform' },
  { path: 'conclusion_conflict', label: '复检结论冲突', type: 'boolean', unit: null, nullable: false, required: true, description: '复检 isPassed 与可识别的 finalStatus 相反时为 true；结构化 isPassed 优先', source: 'platform' },
  { path: 'change_token', label: '逐记录变化标识', type: 'string', unit: null, nullable: false, required: true, description: '毫秒级更新时间与内部记录版本的组合；用于清单和明细对账', source: 'platform' },
  { path: 'conclusion_text', label: '结论原文', type: 'string', unit: null, nullable: true, required: false, description: '记录内保存的判定文本原样返回（如「整改后复检合格」「不合格 (>500)」）', source: 'platform' },
  { path: 'conclusion_source', label: '结论来源', type: 'string', unit: null, nullable: false, required: true, description: "固定为 'stored'：结论是**录入/检测当时保存**的值，不是按当前阈值重新计算的结果", source: 'platform' },
  {
    path: 'is_positive', label: '是否阳性', type: 'boolean', unit: null, nullable: true, required: false,
    // 阶段语义（2026-09-23 验收后补）：该字段是**初检阶段的检出证据**，不是复检结论、也不是"确诊"。
    description: '仅病原体有意义（非病原体恒为 null）。语义 = **当前保存的检出证据**：`result.positiveDetails` 非空 ⟺ true；'
      + '该键缺失时按 `riskLevel ≠ 无风险` 兜底。**注意阶段**：它反映初检留下的检出证据，**不是复检结论、也不等于确诊** —— '
      + '复检合格后若 `positiveDetails` 仍是初检遗留值，本字段会保持 true，与 `final_conclusion=pass` / `final_conclusion_basis=recheck` '
      + '**并存不矛盾**（初检检出 → 复检通过）。判断"当前是否合格"请用 final_conclusion，不要用本字段。',
    source: 'platform',
  },
  { path: 'result', label: '检测业务数据', type: 'object', unit: null, nullable: false, required: true, description: '该类型的业务字段集合（见同类型 result.* 条目）；字段随类型与学校自定义配置不同', source: 'platform' },
  { path: 'created_at', label: '记录创建时间', type: 'datetime', unit: null, nullable: false, required: true, format: 'ISO8601 +08:00', description: '⚠️ 历史导入数据的创建时间可能等于业务日期零点，不要用它做增量同步', source: 'platform' },
  { path: 'updated_at', label: '数据变更时间', type: 'datetime', unit: null, nullable: false, required: true, format: 'ISO8601 +08:00（毫秒）', description: '记录变更排序时间；逐条比较请用 change_token，并以 manifest.digest 做最终对账', source: 'platform' },
  { path: 'data_version', label: '数据版本', type: 'integer', unit: null, nullable: false, required: true, source: 'platform' },
]

/**
 * 复检记录（通用）—— 2026-09-17 审阅 F7 修复。
 *
 * 依据**写入路径**（而非"当前数据里观察到什么"）：前端 `frontend/js/modules/GenericTest.js:549-550`
 * 对**油品 / 果蔬农残 / 肉蛋**（GenericTest 三类型）同样会写 `record.recheckRecords`；
 * 旧字典只按实测样本给餐具登记了该结构 → 白名单把它们剔除，导致"复检证据被丢掉、
 * 但 final_conclusion 仍按复检结论输出"的自相矛盾响应。元素中的 `user`（复检人姓名）由 PII 递归剔除。
 */
const RECHECK_RECORD_FIELD = {
  path: 'result.recheckRecords', label: '复检记录', type: 'array<object>', unit: null, nullable: true, required: false,
  description: '有复检时才出现；结论看元素 `isPassed`（true=复检合格）与顶层 `final_conclusion`。元素中的 `user`（复检人姓名）**不下发**',
  item_fields: ['id(序号)', 'time(复检时间字符串)', 'isPassed(是否通过 boolean)', 'points(点位明细 array)'], source: 'platform',
}

/** 各类型 result.* 字段（依据实测元数据 + 写入路径；required 表示该类型全部记录均出现）。 */
const TYPE_FIELDS = {
  tableware: [
    { path: 'result.testType', label: '检测项目', type: 'string', unit: null, nullable: true, required: false, description: '如 表面清洁度 / 洗涤剂残留；历史记录中仅部分存在，取值以学校配置为准', source: 'platform' },
    { path: 'result.location', label: '检测点位', type: 'string', unit: null, nullable: true, required: false, source: 'platform' },
    { path: 'result.rluValue', label: 'RLU 值', type: 'string', unit: 'RLU', nullable: true, required: true, description: '⚠️ 字符串类型（历史录入即文本），需自行转数值', source: 'platform' },
    { path: 'result.result', label: '结果文本', type: 'string', unit: null, nullable: true, required: true, description: '如「合格 (<200)」「不合格 (>500)」', source: 'platform' },
    { path: 'result.atpPoints', label: 'ATP 点位明细', type: 'array<object>', unit: null, nullable: true, required: false, item_fields: ['loc(点位)', 'rlu(RLU 字符串)', 'res(结论文本)', 'testType(检测项目，部分记录存在)'], source: 'platform' },
    { path: 'result.correctiveAction', label: '整改措施', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.recheckResult', label: '复检结果备注', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.recheckRecords', label: '复检记录', type: 'array<object>', unit: null, nullable: true, required: false, description: '有复检时才出现；元素中 user（复检人姓名）不下发', item_fields: ['id(序号)', 'time(复检时间字符串)', 'isPassed(是否通过 boolean)', 'points(点位明细 array)'], source: 'platform' },
    { path: 'result.finalStatus', label: '最终状态文本', type: 'string', unit: null, nullable: true, required: false, description: '如「整改后复检合格」；最终枚举优先取最新复检 isPassed', source: 'platform' },
    { path: 'result.remark', label: '备注', type: 'string', unit: null, nullable: true, required: false, source: 'platform' },
  ],
  pesticide: [
    { path: 'result.vegetableType', label: '蔬菜品种', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.batchNo', label: '检测项目（检测卡/试剂）', type: 'string', unit: null, nullable: true, required: true, description: '如「克百威-胶体金检测卡」；取值以学校配置为准', source: 'platform' },
    { path: 'result.result', label: '结果文本', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.remark', label: '备注', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    RECHECK_RECORD_FIELD,
  ],
  leanMeat: [
    { path: 'result.meatType', label: '肉类品种', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.batchNo', label: '检测项目（检测卡）', type: 'string', unit: null, nullable: true, required: true, description: '如「恩诺沙星-胶体金检测卡」；取值以学校配置为准', source: 'platform' },
    { path: 'result.result', label: '结果文本', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.remark', label: '备注', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    RECHECK_RECORD_FIELD,
  ],
  oil: [
    { path: 'result.colorLevel', label: '综合品质等级', type: 'enum', unit: null, nullable: true, required: true, enum: ['合格', '警戒', '不合格'], description: '⚠️ **不是颜色**：由前端按「TPM 与酸价等级取最差」算出的综合等级（2026-09-16 实测 合格 38 / 警戒 1，无不合格）。结论口径：**仅「不合格」判不合格**，其余等级视为合格（与 `/stats` 同源）', source: 'platform' },
    // ⚠️ 2026-09-17 复核对：**不得**把"前端展示单位"当作"已核实的设备单位"。`unit` 语义保持为**平台标注**（不改），
    //    另加 unit_source/unit_verified 两个机器可读字段表达核实状态，避免下游把它当计量结论使用。
    { path: 'result.tpmValue', label: 'TPM（极性组分）', type: 'string', unit: 'g/100g（平台标注，未经设备协议核实）', unit_source: 'platform_label', unit_verified: false, nullable: true, required: true, description: '字符串类型，平台按**原始录入值**保存（实测范围 0.06~0.20）。⚠️ `g/100g` 标注与阈值（≤0.13 合格 / ≤0.25 警戒 / >0.25 不合格）均为**当前实现/界面口径**，**未经设备协议或计量文件核实**：请勿自行换算，也不要据此字段重新判定历史结论。待补资料：设备型号/固件与协议版本、原始报文、设备显示值与平台保存值对照、阈值出处与批准记录', source: 'platform' },
    { path: 'result.acidValue', label: '酸价值', type: 'string', unit: 'mg KOH/g（前端展示简写 mg/g）', nullable: true, required: false, description: '⚠️ 字符串类型；实测取值 空字符串 21 / 0.3 13 / 0 5。平台判定：<2.5 合格 / <5 警戒 / ≥5 不合格', source: 'platform' },
    { path: 'result.oilTemp', label: '油温', type: 'string', unit: '℃', nullable: true, required: true, description: '⚠️ 字符串类型；实测恒为 35', source: 'platform' },
    { path: 'result.result', label: '结果文本（兜底字段）', type: 'string', unit: null, nullable: true, required: true, description: '**实测 39/39 均为空字符串**——油品结论看 `colorLevel`；本字段仅作历史/其它来源的兜底（`/stats` 在 colorLevel 为空时才回退读它）', source: 'platform' },
    { path: 'result.remark', label: '备注', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    RECHECK_RECORD_FIELD,
  ],
  pathogen: [
    { path: 'result.riskLevel', label: '风险等级', type: 'enum', unit: null, nullable: true, required: true, enum: ['无风险', '低风险', '极低风险'], description: '「无风险」为合格；**其它任何非空值一律视为不合格/有风险**（与 `/stats` 同口径；实测取值仅 无风险 48 / 低风险 9 / 极低风险 9，**没有"高风险"**）。⚠️ 「有风险」**不等于确诊阳性**——是否检出看 `result.positiveDetails`', source: 'platform' },
    { path: 'result.riskReason', label: '风险原因', type: 'string', unit: null, nullable: true, required: true, description: '风险说明文本（实测长度 9~72）', source: 'platform' },
    { path: 'result.positiveItems', label: '检出项目文本', type: 'string', unit: null, nullable: true, required: true, description: '有检出时为致病菌名称（可能多个，含分隔符；实测长度 14~46）；**无风险时为 1 字符占位（非空）**。判断是否检出请用 `result.positiveDetails`', source: 'platform' },
    { path: 'result.positiveDetails', label: '检出明细', type: 'array<object>', unit: null, nullable: true, required: true, description: '**是否检出的权威依据**：非空 ⟺ riskLevel ≠ 无风险（实测 18/18）', item_fields: ['pathogen(致病菌名)', 'ct(number)', 'ctRaw(string)'], source: 'platform' },
    { path: 'result.allTestItems', label: '全部检测项', type: 'array<object>', unit: null, nullable: true, required: true, item_fields: ['no(序号，实测存在 number 与 string 两种)', 'channel(通道)', 'pathogen(致病菌名)', 'result(结果文本)', 'ct(string)', 'isInternalControl(是否内控 boolean)'], source: 'platform' },
    { path: 'result.internalControlStatus', label: '内控状态', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.recheckReports', label: '复检报告', type: 'array<object>', unit: null, nullable: true, required: false, description: '有复检时才出现；结论看 `isPassed`（true=复检合格）。元素中的 `user`（复检人姓名）**不下发**', item_fields: ['id(序号)', 'time(复检时间字符串)', 'isPassed(是否通过 boolean)', 'user(复检人姓名，不下发)'], source: 'platform' },
    { path: 'result.finalStatus', label: '复检状态文本', type: 'string', unit: null, nullable: true, required: false, description: '当前 Web 复检可写「复检通过」或「复检低风险」；与 isPassed 冲突时以 isPassed 为准', source: 'platform' },
    { path: 'result.sampleId', label: '样品编号', type: 'string', unit: null, nullable: true, required: true, description: '2026-09-16 只读实测：66/66 条病原体记录均存在（此前字典漏登记）', source: 'platform' },
    { path: 'result.sampleType', label: '样品类型', type: 'string', unit: null, nullable: true, required: true, description: '2026-09-16 只读实测：66/66 条均存在（此前字典漏登记）', source: 'platform' },
    { path: 'result.sampleInfo', label: '样品说明', type: 'string', unit: null, nullable: true, required: true, description: '⚠️ **普通字符串**（实测长度 5~16 字符，例如样品别名；非 JSON、非对象），按文本处理，勿解析为对象（此前字典漏登记且曾被误判为"双重编码"）', source: 'platform' },
  ],
}

/**
 * `result.*` 内的上下文同义副本（与顶层同义，取值一律以顶层为准）。
 *
 * 背景（2026-09-16 实测）：平台历史上把整份平铺载荷写进 result_data，导致 testDate/canteen/inspector
 * 在 result_data 内各留一份副本 —— 4 个租户 1195 条记录 100% 命中、与 sample_info 冲突 0 条。
 * 自 2026-09-16 起写入端已收口（`lib/recordNormalize.js` 的 stripContextCopies）：
 * **新记录不再产生副本**，因此这两条仅历史数据可能出现，保留说明以兼容老数据。
 */
const REDUNDANT_IN_RESULT = [
  { path: 'result.canteen', label: '食堂（历史同义副本）', type: 'string', unit: null, nullable: true, required: false, description: '与顶层 canteen 同义（**以顶层为准**）；仅历史记录可能出现，新记录不再写入', source: 'platform' },
  { path: 'result.testDate', label: '检测日期（历史同义副本）', type: 'string', unit: null, nullable: true, required: false, description: '与顶层 test_date 同义（**以顶层为准**）；仅历史记录可能出现，新记录不再写入', source: 'platform' },
  { path: 'result.inspector', label: '检测人（历史同义副本，恒不下发）', type: 'string', unit: null, nullable: true, required: false, emitted: false, description: '属个人信息，为**平台内部存储字段：任何情况下都不会出现在响应中**（无论是否开启「下发检测人姓名」）。需要检测人请使用顶层 inspector（由 include_inspector 控制）', source: 'platform' },
]

/**
 * 取某检测类型的完整字段清单。
 * @param {string} testType
 * @param {{ customFieldNames?: string[], fieldLabels?: Record<string,string> }} [ctx]
 *        学校自定义字段（来自已核验的 SchoolCustomization.custom_fields 元数据），
 *        仅作为「school_custom」来源追加说明，不参与投影（投影对自定义字段默认放行）。
 */
/**
 * 出现性语义规范化（2026-09-23，对外验收 C6 修复）。
 *
 * 背景：此前 `required: true` 被用来表达「实测该类型全部记录都出现」（**数据观察**），
 * 于是字典声明 `result.sampleId/sampleType/sampleInfo` 必现，而合成样例并不包含这三个键 ——
 * 字典与样例/真实数据自相矛盾：对接方按字典建严格模型后，官方样例反而校验失败。
 *
 * 现约定（必须与 `field_schema_notes`、接入包「读表须知」、`docs/OPEN_API_INTEGRATION.md` 保持一致）：
 *   · `required: true`  = **服务端投影保证**该字段一定出现在响应中（仅顶层字段，如 record_code/status/结论类/change_token）；
 *   · `result.*` 字段来自**保存的检测数据**，是否出现取决于录入路径与历史数据 → 一律 `required: false`；
 *   · 若观察到「该类型现有记录均出现」，改记 `observed_present`（**数据观察，非输出保证**），
 *     仅供容错解析参考，**不得**据此建必填模型。
 */
const OBSERVED_PRESENT_ALL = '该类型现有记录均出现（数据观察，非输出保证）'

function normalizePresenceSemantics(f) {
  const isBusinessResultField = typeof f.path === 'string' && f.path.startsWith('result.')
  if (!isBusinessResultField) return f
  const observed = f.observed_present || (f.required ? OBSERVED_PRESENT_ALL : null)
  const next = { ...f, required: false }
  if (observed) next.observed_present = observed
  return next
}

export function listFieldDescriptors(testType, ctx = {}) {
  const type = String(testType)
  // INSPECTOR_FIELD 必须显式并入：它不在 COMMON_FIELDS 中（因为带 conditional 语义），
  // 早期实现只做 map 替换导致字典里根本没有 inspector 条目（2026-09-15 由测试发现）。
  const base = [...COMMON_FIELDS, INSPECTOR_FIELD, ...(TYPE_FIELDS[type] || []), ...REDUNDANT_IN_RESULT]
  const custom = Array.isArray(ctx.customFieldNames) ? ctx.customFieldNames : []
  const labels = ctx.fieldLabels && typeof ctx.fieldLabels === 'object' ? ctx.fieldLabels : {}
  const customDescriptors = custom
    .filter((n) => typeof n === 'string' && n)
    .filter((n) => !isPiiKey(n) && !isPiiKey(labels[n] || ''))
    .filter((n) => !base.some((f) => f.path === `result.${n}`))
    .map((n) => ({
      path: `result.${n}`,
      label: labels[n] || n,
      type: 'unknown',
      unit: null,
      nullable: true,
      required: false,
      description: '学校自定义字段：类型与单位由学校配置决定，平台不做保证',
      source: 'school_custom',
    }))
  return [...base, ...customDescriptors].map(normalizePresenceSemantics)
}

/* ─────────────────────── 合成样例 ───────────────────────
 * 全部为**构造数据**（不抽样自生产记录），经与真实记录相同的投影（buildOpenRecord）后下发，
 * 因此样例形态与真实响应一致；record_code 统一以 SAMPLE- 前缀，便于客户端识别与排除。
 * 复检场景仅对真实存在复检结构的类型（tableware = recheckRecords、pathogen = recheckReports）产出。
 */

const SAMPLE_INSPECTOR = '示例姓名（虚构）'
const SAMPLE_CANTEEN = '示例食堂'
const SAMPLE_DATE = '2026-01-15'

function sampleBase(testType, testName, scenario, sampleInfo, resultData, updatedAt = null) {
  // 上下文三键只放 sample_info：样例必须代表**新记录形态**。否则对接方照着样例写
  // result.canteen，而新记录已不再写该副本（2026-09-16 收口，见 lib/recordNormalize.js
  // stripContextCopies），上线即踩空。副本本身仍在字段字典中作为"历史同义副本"列出。
  const rd = { ...(resultData || {}) }
  for (const k of ['testDate', 'canteen', 'inspector']) delete rd[k]
  return {
    scenario,
    record: {
      id: `sample-${testType}-${scenario}`,
      record_code: `SAMPLE-${testType}-${scenario}`,
      test_type: testType,
      test_name: testName,
      sample_info: { testDate: SAMPLE_DATE, canteen: SAMPLE_CANTEEN, inspector: SAMPLE_INSPECTOR, ...sampleInfo },
      result_data: rd,
      status: 'completed',
      created_at: new Date(`${SAMPLE_DATE}T00:00:00+08:00`),
      // 复检会刷新 updated_at（2026-09-16 只读实测：12 条含复检记录全部 updated_at ≥ created_at）；
      // 故含复检的场景必须显式给出 updatedAt（复检时间），否则样例自相矛盾。
      updated_at: new Date(updatedAt ? `${updatedAt}+08:00` : `${SAMPLE_DATE}T00:00:00+08:00`),
      version: 1,
      data_version: 1,
    },
  }
}

const SAMPLE_SCENARIOS = {
  tableware: () => [
    sampleBase('tableware', '餐具洁净度检测', 'pass', {}, {
      testType: 'atp', location: '餐具表面', rluValue: '120', result: '合格 (<200)',
      atpPoints: [{ loc: '餐具表面', rlu: '120', res: '合格' }],
      correctiveAction: '', recheckResult: '', canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
    sampleBase('tableware', '餐具洁净度检测', 'fail', {}, {
      testType: 'atp', location: '砧板表面', rluValue: '614', result: '不合格 (>500)',
      atpPoints: [{ loc: '砧板表面', rlu: '614', res: '不合格' }],
      correctiveAction: '已重新清洗消毒', recheckResult: '', canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
    sampleBase('tableware', '餐具洁净度检测', 'recheck_passed', {}, {
      testType: 'atp', location: '砧板表面', rluValue: '96', result: '合格',
      finalStatus: '整改后复检合格',
      recheckRecords: [{ id: 1, time: `${SAMPLE_DATE} 15:30`, user: SAMPLE_INSPECTOR, isPassed: true, points: [{ loc: '砧板表面', rlu: '96', res: '合格' }] }],
      modificationLogs: [{ time: `${SAMPLE_DATE} 15:31`, user: SAMPLE_INSPECTOR, action: '复检', content: '复检合格' }],
      atpPoints: [{ loc: '砧板表面', rlu: '96', res: '合格' }],
      correctiveAction: '已重新清洗消毒', recheckResult: '复检合格', canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }, `${SAMPLE_DATE} 15:31`),
    sampleBase('tableware', '餐具洁净度检测', 'sparse', {}, {
      result: '合格 (<200)', rluValue: '80', correctiveAction: '', recheckResult: '',
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
  ],
  pesticide: () => [
    sampleBase('pesticide', '果蔬农残检测', 'pass', {}, {
      vegetableType: '白菜（示例）', batchNo: '克百威-胶体金检测卡', result: '合格', remark: '',
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
    sampleBase('pesticide', '果蔬农残检测', 'fail', {}, {
      vegetableType: '豇豆（示例）', batchNo: '水胺硫磷-胶体金检测卡', result: '不合格', remark: '已下架处理',
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
  ],
  leanMeat: () => [
    sampleBase('leanMeat', '肉、蛋农残检测', 'pass', {}, {
      meatType: '猪肉', batchNo: '恩诺沙星-胶体金检测卡', result: '合格', remark: '',
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
    sampleBase('leanMeat', '肉、蛋农残检测', 'fail', {}, {
      meatType: '鸡肉', batchNo: '氟苯尼考-胶体金检测卡', result: '不合格', remark: '已停用该批次',
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
  ],
  oil: () => [
    // 真实形态（2026-09-16 只读实测 school_tjb 39 条）：colorLevel ∈ {合格 38, 警戒 1}
    // —— **不是颜色词**，而是前端按「TPM 与酸价等级取最差」算出的**综合品质等级**；
    // tpmValue 0.06~0.20（g/100g 数值口径）；acidValue 常见 0.3；oilTemp 恒为 35；result 恒为空字符串。
    sampleBase('oil', '食用油品质检测', 'pass', {}, {
      colorLevel: '合格', tpmValue: '0.06', acidValue: '0.3', oilTemp: '35', remark: '',
      result: '', canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
    // 不合格场景为**合成构造**（真实 39 条中未出现不合格）：必须自洽 ——
    // colorLevel=不合格，且 TPM 0.31 > 0.25、酸价 5.2 ≥ 5.0（均按平台阈值判不合格）。
    sampleBase('oil', '食用油品质检测', 'fail', {}, {
      colorLevel: '不合格', tpmValue: '0.31', acidValue: '5.2', oilTemp: '35', remark: '建议更换食用油',
      result: '', canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
  ],
  pathogen: () => [
    // 真实形态（2026-09-16 只读实测 school_tjb 66 条）：riskLevel ∈ {无风险 48, 低风险 9, 极低风险 9}
    // —— **没有"高风险"**；positiveDetails 非空 ⟺ riskLevel ≠ 无风险（18/18）；无风险时 positiveItems 为 1 字符占位。
    sampleBase('pathogen', '病原体检测', 'pass', {}, {
      // 样品标识三件套（2026-09-23 验收 C6）：此前字典登记但样例缺失 → 样例与字典矛盾。
      // 实测 66/66 条真实记录均存在，故样例按真实形态给出**虚构**值（示例标记，勿当真实样品）。
      sampleId: 'SAMPLE-PATH-001', sampleType: '表面涂抹样（示例）', sampleInfo: '留样复检（示例）',
      riskLevel: '无风险', riskReason: '', positiveItems: '-', positiveDetails: [],
      internalControlStatus: '有效',
      allTestItems: [
        { no: 1, channel: 'A1', pathogen: '沙门氏菌（示例）', result: '未检出', ct: '', isInternalControl: false },
        { no: 2, channel: 'A2', pathogen: '内控（示例）', result: '正常', ct: '', isInternalControl: true },
      ],
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
    sampleBase('pathogen', '病原体检测', 'positive', {}, {
      // riskLevel 取真实存在的「低风险」；检出证据 = positiveDetails 非空
      sampleId: 'SAMPLE-PATH-002', sampleType: '表面涂抹样（示例）', sampleInfo: '疑似阳性复核（示例）',
      riskLevel: '低风险', riskReason: '检出沙门氏菌（示例）', positiveItems: '沙门氏菌（示例）',
      positiveDetails: [{ pathogen: '沙门氏菌（示例）', ct: 21.5, ctRaw: '21.5' }],
      internalControlStatus: '有效',
      allTestItems: [{ no: 1, channel: 'A1', pathogen: '沙门氏菌（示例）', result: '检出', ct: '21.5', isInternalControl: false }],
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
    sampleBase('pathogen', '病原体检测', 'recheck_passed', {}, {
      // 复检合格场景的字段分工（避免"复检合格 + 当前阳性"的误读）：
      //   当前 Web 会覆盖 riskLevel/result；positiveDetails 仍是初检留下的检出明细，不能据此恢复完整初检结论。
      //   复检结论 = recheckReports[0].isPassed（对外映射为 final_conclusion / final_conclusion_basis='recheck'）
      //   allTestItems = **当前（复检后）**明细 → 未检出
      //   当前 Web 复检写 finalStatus；旧实测样本未出现，不代表写入路径不支持。
      //   ⚠️ 不再在样例里放 `result`：病原体的 `result` **未登记**进对外字段字典 → 投影会按白名单
      //   静默丢弃（2026-09-23 实测有告警）。要让样例与真实响应形态一致，就不能带会被丢掉的键；
      //   复检结论由顶层 final_conclusion / final_conclusion_basis='recheck' 表达。
      sampleId: 'SAMPLE-PATH-003', sampleType: '表面涂抹样（示例）', sampleInfo: '整改后复检（示例）',
      riskLevel: '无风险', finalStatus: '复检通过', riskReason: '初检检出沙门氏菌（示例）', positiveItems: '沙门氏菌（示例）',
      positiveDetails: [{ pathogen: '沙门氏菌（示例）', ct: 21.5, ctRaw: '21.5' }],
      recheckReports: [{ id: 1, time: `${SAMPLE_DATE} 16:00`, user: SAMPLE_INSPECTOR, isPassed: true }],
      internalControlStatus: '有效',
      allTestItems: [{ no: 1, channel: 'A1', pathogen: '沙门氏菌（示例）', result: '未检出', ct: '', isInternalControl: false }],
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }, `${SAMPLE_DATE} 16:00`),
  ],
}

/**
 * 生成某类型的合成样例（原始记录形态，调用方需再经 buildOpenRecord 投影）。
 * @param {string} testType
 * @returns {Array<{scenario: string, record: object}>}
 */
export function buildSyntheticSamples(testType) {
  const f = SAMPLE_SCENARIOS[String(testType)]
  return f ? f() : []
}

/**
 * 从 SchoolCustomization 提取某检测类型的自定义字段元数据（仅名称与标签）。
 * 抽到本模块是为了让 /v1/dict、超管预览、接入包三处共用同一份解析逻辑。
 * @param {object} cust SchoolCustomization 行（可含 custom_fields / field_labels）
 * @param {string} testType
 * @returns {{names: string[], labels: Record<string,string>}}
 */
export function extractCustomFieldMeta(cust, testType) {
  const cf = cust?.custom_fields && typeof cust.custom_fields === 'object' ? cust.custom_fields : {}
  const arr = Array.isArray(cf[testType]) ? cf[testType] : []
  const names = []
  const labels = {}
  for (const f of arr) {
    if (!f || typeof f !== 'object' || !f.name) continue
    names.push(String(f.name))
    if (f.label) labels[String(f.name)] = String(f.label)
  }
  // 学校级字段标签（field_labels）可覆盖自定义字段标签
  const globalLabels = cust?.field_labels && typeof cust.field_labels === 'object' ? cust.field_labels : {}
  for (const n of names) if (globalLabels[n]) labels[n] = String(globalLabels[n])
  // 同时返回 listFieldDescriptors 的 ctx 形态（customFieldNames/fieldLabels）：
  // 2026-09-16 审阅发现调用方直接把本函数返回值喂给 listFieldDescriptors，而键名不匹配
  // （names/labels vs customFieldNames/fieldLabels）→ **字典路由里学校自定义字段实际未生效**。
  return { names, labels, customFieldNames: names, fieldLabels: labels }
}

/**
 * 允许对外下发的 `result.*` 顶层键集合（**白名单**）。
 *
 * 与字段字典**同源**：字典里登记过的 `result.*` 路径 = 允许下发；未登记 = 不下发（默认拒绝）。
 * 学校自定义字段来自 SchoolCustomization（与字典同一来源），因此不会"一刀切"掉在用字段。
 * 用途：`openApiScope.projectResultData` 的顶层白名单（2026-09-16 审阅 M2：原实现是纯黑名单，
 * 未登记字段会无条件透传）。
 *
 * @param {string} testType
 * @param {{customFieldNames?: string[], fieldLabels?: Record<string,string>}} [ctx]
 * @returns {Set<string>}
 */
export function allowedResultKeys(testType, ctx = {}) {
  const keys = new Set()
  for (const f of listFieldDescriptors(testType, ctx)) {
    if (!f.path.startsWith('result.')) continue
    const k = f.path.slice('result.'.length)
    if (k && !k.includes('.')) keys.add(k)
  }
  return keys
}

/**
 * 学校"影响输出的配置"指纹（2026-09-17 审阅 F6）：把该校**实际会下发的** result 键集合
 * （已按白名单过滤、排序）哈希成 16 位。用于在 projection_fingerprint 中纳入自定义字段的影响，
 * 使"字段可见性因学校配置变化"时也能被同步客户端感知。
 */
export function allowedKeysFingerprint(types, ctxOf = () => ({})) {
  const parts = []
  for (const t of Array.isArray(types) ? types : []) {
    const type = String(t)
    const keys = [...allowedResultKeys(type, ctxOf(type))].sort()
    parts.push(`${type}:${keys.join(',')}`)
  }
  return crypto.createHash('sha256').update(parts.sort().join('|')).digest('hex').slice(0, 16)
}

/** 一次构建多个类型的白名单（路由层用；ctxOf(type) 返回该类型的自定义字段 ctx）。 */
export function buildAllowedResultKeyMap(types, ctxOf = () => ({})) {
  const map = new Map()
  for (const t of Array.isArray(types) ? types : []) {
    const type = String(t)
    map.set(type, allowedResultKeys(type, ctxOf(type)))
  }
  return map
}

/** 契约版本 + 字段清单的稳定指纹（供接入包/对账参考，不参与游标）。 */
export function fieldSchemaFingerprint(testType, ctx = {}) {
  const list = listFieldDescriptors(testType, ctx).map((f) => `${f.path}|${f.type}`)
  return `${OPEN_API_CONTRACT_VERSION}:${testType}:${list.length}`
}
