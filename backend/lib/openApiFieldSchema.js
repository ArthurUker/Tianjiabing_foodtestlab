// openApiFieldSchema.js — 开放接口「对外字段契约」的单一事实源
//
// 三处复用同一份定义，避免手写三套逐渐漂移：
//   ① GET /api/open/v1/dict     → 字段字典（对方据此写映射）
//   ② GET /api/open/v1/samples  → 合成样例（对方在无真实数据时即可开发）
//   ③ 超管「接入说明」          → 接入包内容
// 真实响应仍由 openApiScope.buildOpenRecord 生成（同一套投影规则），
// 样例先构造「合成原始记录」再走同一投影，保证样例与真实响应形态一致。
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
//    平台保证 v1 内「不删除、不改语义」，新增字段为向后兼容的新增。

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
  { path: 'initial_conclusion', label: '初检结论', type: 'enum', unit: null, nullable: false, required: true, enum: CONCLUSION_VALUES.map((c) => c.value), description: '记录内保存的初检判定', source: 'platform' },
  { path: 'final_conclusion', label: '最终结论', type: 'enum', unit: null, nullable: false, required: true, enum: CONCLUSION_VALUES.map((c) => c.value), description: '有复检时取复检结论，否则与初检一致', source: 'platform' },
  { path: 'conclusion', label: '结论（对外统一口径）', type: 'enum', unit: null, nullable: false, required: true, enum: CONCLUSION_VALUES.map((c) => c.value), description: '等于 final_conclusion，推荐直接使用此字段', source: 'platform' },
  { path: 'final_conclusion_basis', label: '最终结论来源', type: 'enum', unit: null, nullable: false, required: true, enum: ['initial', 'recheck'], description: 'initial=无复检、沿用初检；recheck=由复检结论覆盖', source: 'platform' },
  { path: 'conclusion_text', label: '结论原文', type: 'string', unit: null, nullable: true, required: false, description: '记录内保存的判定文本原样返回（如「整改后复检合格」「不合格 (>500)」）', source: 'platform' },
  { path: 'conclusion_source', label: '结论来源', type: 'string', unit: null, nullable: false, required: true, description: "固定为 'stored'：结论是**录入/检测当时保存**的值，不是按当前阈值重新计算的结果", source: 'platform' },
  { path: 'is_positive', label: '是否阳性', type: 'boolean', unit: null, nullable: true, required: false, description: '仅病原体有意义（true=阳性、false=阴性）；非病原体为 null', source: 'platform' },
  { path: 'result', label: '检测业务数据', type: 'object', unit: null, nullable: false, required: true, description: '该类型的业务字段集合（见同类型 result.* 条目）；字段随类型与学校自定义配置不同', source: 'platform' },
  { path: 'created_at', label: '记录创建时间', type: 'datetime', unit: null, nullable: false, required: true, format: 'ISO8601 +08:00', description: '⚠️ 历史导入数据的创建时间可能等于业务日期零点，不要用它做增量同步', source: 'platform' },
  { path: 'updated_at', label: '数据变更时间', type: 'datetime', unit: null, nullable: false, required: true, format: 'ISO8601 +08:00', description: '**增量同步唯一依据**；记录内容发生任何对外可见变更（含复检）都会刷新', source: 'platform' },
  { path: 'data_version', label: '数据版本', type: 'integer', unit: null, nullable: false, required: true, source: 'platform' },
]

/** 各类型 result.* 字段（依据实测元数据；required 表示该类型全部记录均出现）。 */
const TYPE_FIELDS = {
  tableware: [
    { path: 'result.testType', label: '检测项目', type: 'string', unit: null, nullable: true, required: false, description: '如 表面清洁度 / 洗涤剂残留；历史记录中仅部分存在，取值以学校配置为准', source: 'platform' },
    { path: 'result.location', label: '检测点位', type: 'string', unit: null, nullable: true, required: false, source: 'platform' },
    { path: 'result.rluValue', label: 'RLU 值', type: 'string', unit: 'RLU', nullable: true, required: true, description: '⚠️ 字符串类型（历史录入即文本），需自行转数值', source: 'platform' },
    { path: 'result.result', label: '结果文本', type: 'string', unit: null, nullable: true, required: true, description: '如「合格 (<200)」「不合格 (>500)」', source: 'platform' },
    { path: 'result.atpPoints', label: 'ATP 点位明细', type: 'array<object>', unit: null, nullable: true, required: false, item_fields: ['loc(点位)', 'rlu(RLU 字符串)', 'res(结论文本)', 'testType(检测项目，部分记录存在)'], source: 'platform' },
    { path: 'result.correctiveAction', label: '整改措施', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.recheckResult', label: '复检结果备注', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.recheckRecords', label: '复检记录', type: 'array<object>', unit: null, nullable: true, required: false, description: '有复检时才出现（实测仅餐具/病原体有）。元素中 user（复检人姓名）**不下发**', item_fields: ['id(序号)', 'time(复检时间字符串)', 'isPassed(是否通过 boolean)', 'points(点位明细 array)'], source: 'platform' },
    { path: 'result.finalStatus', label: '最终状态文本', type: 'string', unit: null, nullable: true, required: false, description: '如「整改后复检合格」，有复检时出现', source: 'platform' },
    { path: 'result.remark', label: '备注', type: 'string', unit: null, nullable: true, required: false, source: 'platform' },
  ],
  pesticide: [
    { path: 'result.vegetableType', label: '蔬菜品种', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.batchNo', label: '检测项目（检测卡/试剂）', type: 'string', unit: null, nullable: true, required: true, description: '如「克百威-胶体金检测卡」；取值以学校配置为准', source: 'platform' },
    { path: 'result.result', label: '结果文本', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.remark', label: '备注', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
  ],
  leanMeat: [
    { path: 'result.meatType', label: '肉类品种', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.batchNo', label: '检测项目（检测卡）', type: 'string', unit: null, nullable: true, required: true, description: '如「恩诺沙星-胶体金检测卡」；取值以学校配置为准', source: 'platform' },
    { path: 'result.result', label: '结果文本', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.remark', label: '备注', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
  ],
  oil: [
    { path: 'result.colorLevel', label: '油品颜色等级', type: 'string', unit: null, nullable: true, required: true, description: '合格判定的首选依据（见 /stats 口径）', source: 'platform' },
    { path: 'result.tpmValue', label: 'TPM 值', type: 'string', unit: '%（极性组分）', nullable: true, required: true, description: '⚠️ 字符串类型，需自行转数值', source: 'platform' },
    { path: 'result.acidValue', label: '酸价值', type: 'string', unit: 'mg KOH/g', nullable: true, required: false, description: '⚠️ 字符串类型；实测仅部分记录存在', source: 'platform' },
    { path: 'result.oilTemp', label: '油温', type: 'string', unit: '℃', nullable: true, required: true, description: '⚠️ 字符串类型', source: 'platform' },
    { path: 'result.remark', label: '备注', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
  ],
  pathogen: [
    { path: 'result.riskLevel', label: '风险等级', type: 'string', unit: null, nullable: true, required: true, description: '「无风险」为合格；其他非空值视为阳性/有风险', source: 'platform' },
    { path: 'result.riskReason', label: '风险原因', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.positiveItems', label: '阳性项目', type: 'string', unit: null, nullable: true, required: true, description: '阳性项目名称（可能为空字符串）', source: 'platform' },
    { path: 'result.positiveDetails', label: '阳性明细', type: 'array<object>', unit: null, nullable: true, required: true, item_fields: ['pathogen(致病菌名)', 'ct(number)', 'ctRaw(string)'], source: 'platform' },
    { path: 'result.allTestItems', label: '全部检测项', type: 'array<object>', unit: null, nullable: true, required: true, item_fields: ['no(序号，实测存在 number 与 string 两种)', 'channel(通道)', 'pathogen(致病菌名)', 'result(结果文本)', 'ct(string)', 'isInternalControl(是否内控 boolean)'], source: 'platform' },
    { path: 'result.internalControlStatus', label: '内控状态', type: 'string', unit: null, nullable: true, required: true, source: 'platform' },
    { path: 'result.recheckReports', label: '复检报告', type: 'array<object>', unit: null, nullable: true, required: false, description: '有复检时才出现；元素中的人名类字段不下发', source: 'platform' },
  ],
}

/** 历史数据中可能出现在 result.* 内的冗余副本字段（与顶层同义，取值以顶层为准）。 */
const REDUNDANT_IN_RESULT = [
  { path: 'result.canteen', label: '食堂（历史冗余副本）', type: 'string', unit: null, nullable: true, required: false, description: '与顶层 canteen 同义；历史写入残留，建议忽略并以顶层为准', source: 'platform' },
  { path: 'result.testDate', label: '检测日期（历史冗余副本）', type: 'string', unit: null, nullable: true, required: false, description: '与顶层 test_date 同义；建议忽略并以顶层为准', source: 'platform' },
  { path: 'result.inspector', label: '检测人（历史冗余副本）', type: 'string', unit: null, nullable: true, required: false, conditional: true, conditional_on: 'include_inspector', description: '仅在开启「下发检测人姓名」时可能出现；关闭时与顶层 inspector 一起被剔除', source: 'platform' },
]

/**
 * 取某检测类型的完整字段清单。
 * @param {string} testType
 * @param {{ customFieldNames?: string[], fieldLabels?: Record<string,string> }} [ctx]
 *        学校自定义字段（来自已核验的 SchoolCustomization.custom_fields 元数据），
 *        仅作为「school_custom」来源追加说明，不参与投影（投影对自定义字段默认放行）。
 */
export function listFieldDescriptors(testType, ctx = {}) {
  const type = String(testType)
  // INSPECTOR_FIELD 必须显式并入：它不在 COMMON_FIELDS 中（因为带 conditional 语义），
  // 早期实现只做 map 替换导致字典里根本没有 inspector 条目（2026-09-15 由测试发现）。
  const base = [...COMMON_FIELDS, INSPECTOR_FIELD, ...(TYPE_FIELDS[type] || []), ...REDUNDANT_IN_RESULT]
  const custom = Array.isArray(ctx.customFieldNames) ? ctx.customFieldNames : []
  const labels = ctx.fieldLabels && typeof ctx.fieldLabels === 'object' ? ctx.fieldLabels : {}
  const customDescriptors = custom
    .filter((n) => typeof n === 'string' && n)
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
  return [...base, ...customDescriptors]
}

/* ─────────────────────── 合成样例 ───────────────────────
 * 全部为**构造数据**（不抽样自生产记录），经与真实记录相同的投影（buildOpenRecord）后下发，
 * 因此样例形态与真实响应一致；record_code 统一以 SAMPLE- 前缀，便于客户端识别与排除。
 * 复检场景仅对真实存在复检结构的类型（tableware = recheckRecords、pathogen = recheckReports）产出。
 */

const SAMPLE_INSPECTOR = '示例姓名（虚构）'
const SAMPLE_CANTEEN = '示例食堂'
const SAMPLE_DATE = '2026-01-15'

function sampleBase(testType, testName, scenario, sampleInfo, resultData) {
  return {
    scenario,
    record: {
      id: `sample-${testType}-${scenario}`,
      record_code: `SAMPLE-${testType}-${scenario}`,
      test_type: testType,
      test_name: testName,
      sample_info: { testDate: SAMPLE_DATE, canteen: SAMPLE_CANTEEN, inspector: SAMPLE_INSPECTOR, ...sampleInfo },
      result_data: resultData,
      status: 'completed',
      created_at: new Date(`${SAMPLE_DATE}T00:00:00+08:00`),
      updated_at: new Date(`${SAMPLE_DATE}T00:00:00+08:00`),
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
      testType: 'atp', location: '砧板表面', rluValue: '614', result: '不合格 (>500)',
      finalStatus: '整改后复检合格',
      recheckRecords: [{ id: 1, time: `${SAMPLE_DATE} 15:30`, user: SAMPLE_INSPECTOR, isPassed: true, points: [{ loc: '砧板表面', rlu: '96', res: '合格' }] }],
      modificationLogs: [{ time: `${SAMPLE_DATE} 15:31`, user: SAMPLE_INSPECTOR, action: '复检', content: '复检合格' }],
      atpPoints: [{ loc: '砧板表面', rlu: '614', res: '不合格' }],
      correctiveAction: '已重新清洗消毒', recheckResult: '复检合格', canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
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
    sampleBase('oil', '食用油品质检测', 'pass', {}, {
      colorLevel: '浅黄色', tpmValue: '0.06', acidValue: '0.30', oilTemp: '180', remark: '',
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
    sampleBase('oil', '食用油品质检测', 'fail', {}, {
      colorLevel: '深绿色', tpmValue: '0.31', acidValue: '3.2', oilTemp: '195', remark: '建议更换食用油',
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
  ],
  pathogen: () => [
    sampleBase('pathogen', '病原体检测', 'pass', {}, {
      riskLevel: '无风险', riskReason: '', positiveItems: '', positiveDetails: [],
      internalControlStatus: '有效',
      allTestItems: [
        { no: 1, channel: 'A1', pathogen: '沙门氏菌（示例）', result: '未检出', ct: '', isInternalControl: false },
        { no: 2, channel: 'A2', pathogen: '内控（示例）', result: '正常', ct: '', isInternalControl: true },
      ],
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
    sampleBase('pathogen', '病原体检测', 'positive', {}, {
      riskLevel: '高风险', riskReason: '检出沙门氏菌（示例）', positiveItems: '沙门氏菌（示例）',
      positiveDetails: [{ pathogen: '沙门氏菌（示例）', ct: 21.5, ctRaw: '21.5' }],
      internalControlStatus: '有效',
      allTestItems: [{ no: 1, channel: 'A1', pathogen: '沙门氏菌（示例）', result: '检出', ct: '21.5', isInternalControl: false }],
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
    sampleBase('pathogen', '病原体检测', 'recheck_passed', {}, {
      riskLevel: '高风险', riskReason: '检出沙门氏菌（示例）', positiveItems: '沙门氏菌（示例）',
      finalStatus: '整改后复检合格',
      recheckReports: [{ id: 1, time: `${SAMPLE_DATE} 16:00`, user: SAMPLE_INSPECTOR, isPassed: true }],
      positiveDetails: [], internalControlStatus: '有效',
      allTestItems: [{ no: 1, channel: 'A1', pathogen: '沙门氏菌（示例）', result: '未检出', ct: '', isInternalControl: false }],
      canteen: SAMPLE_CANTEEN, testDate: SAMPLE_DATE, inspector: SAMPLE_INSPECTOR,
    }),
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
  return { names, labels }
}

/** 契约版本 + 字段清单的稳定指纹（供接入包/对账参考，不参与游标）。 */
export function fieldSchemaFingerprint(testType, ctx = {}) {
  const list = listFieldDescriptors(testType, ctx).map((f) => `${f.path}|${f.type}`)
  return `${OPEN_API_CONTRACT_VERSION}:${testType}:${list.length}`
}
