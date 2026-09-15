// openApiScope.js — 开放接口的「授权范围解析 + 对外字段投影 + 结论口径 + 游标」单一事实源
//
// 三条硬规则（2026-09-15 设计评审定稿）：
//   ① 范围：只有 grant 里显式开放的检测类型可见；病原体（pathogen）需显式开关；
//      未授权学校一律 403 —— 调用方传的 school_code 必须命中该对接方的 grant。
//   ② 字段：**绝不直接下发 result_data 原始 JSON**。先剔内部字段（modificationLogs 等），
//      再递归剔除 PII（检测人/复检人名等，正则兜底，未来新增的人名类字段自动不外泄）；
//      是否返回 inspector 由 grant 的 include_inspector 决定（默认 false = 不下发该字段）。
//   ③ 结论：结论是**随记录冻结存储**的（录入时按当时阈值产出），不是每次实时计算；
//      故对外给 initial_conclusion（初检）+ final_conclusion（复检后）并标注 source='stored'。
//      统计口径另有一套 SQL LIKE 判定（见 routes/openApiRoutes.js 的 /stats），仅供对账。

import crypto from 'node:crypto'
import { RECORD_ROUTE_TYPES, TEST_TYPE_LABELS, getLatestRecheckPassed } from './recordNormalize.js'

/** 未配置 visible_types 时的默认开放范围（与访客白名单同口径，病原体恒不含）。 */
export const DEFAULT_OPEN_TYPES = ['tableware', 'pesticide', 'oil', 'leanMeat']

/** 对内/对外恒定剔除的内部字段（内部审计轨迹或服务端元数据，非业务数据）。 */
const INTERNAL_RESULT_KEYS = new Set([
  'modificationLogs',   // 修改轨迹 {time,user,action,content}：内部审计，含人名
  'traceabilityRecords', // 旧系统信封残留的追溯元数据
  'created_by',
  'createdBy',
  'importTime',
  'importUser',
  'lastModified',
  'sync_time',
  'last_sync_at',
  'version',
  'data_version',
])

/**
 * PII 键名模式（递归匹配）。命中即剔除 —— 这是"未来新增人名类字段默认不外泄"的兜底，
 * 比逐字段枚举更可靠。注意只匹配**整个键名**，不做子串匹配，避免误伤业务字段
 * （如 sampleSource / usedCount / userDefinedField 之类不会被误删）。
 */
const PII_KEY_PATTERNS = [
  /^inspector$/i,
  /^sampler$/i,
  /^checker$/i,
  /^tester$/i,
  /^operator$/i,
  /^user$/i,
  /^user_?name$/i,
  /^full_?name$/i,
  /^staff$/i,
  /^employee$/i,
  /^phone$/i,
  /^mobile$/i,
  /^tel$/i,
]

function isPiiKey(key) {
  return PII_KEY_PATTERNS.some((re) => re.test(key))
}

/**
 * 递归投影：剔除内部字段 + PII 字段。仅处理普通对象/数组，深度上限 8 层防御异常结构。
 * @param {*} value 任意 JSON 值
 * @param {number} depth
 */
function projectValue(value, depth = 0) {
  if (depth > 8) return null
  if (Array.isArray(value)) return value.map((v) => projectValue(v, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (INTERNAL_RESULT_KEYS.has(k)) continue
      if (isPiiKey(k)) continue
      out[k] = projectValue(v, depth + 1)
    }
    return out
  }
  return value
}

/** 对外下发的结果数据（已剔除内部字段与 PII）。 */
export function projectResultData(resultData) {
  if (!resultData || typeof resultData !== 'object') return {}
  return projectValue(resultData)
}

/** 解析某条 grant 实际开放的检测类型（与 RECORD_ROUTE_TYPES 求交，pathogen 需显式开关）。 */
export function resolveGrantTypes(grant) {
  const raw = Array.isArray(grant?.visible_types) ? grant.visible_types : null
  const base = raw && raw.length > 0 ? raw : DEFAULT_OPEN_TYPES
  const allowed = base
    .map((t) => String(t))
    .filter((t) => RECORD_ROUTE_TYPES.has(t))
    .filter((t) => (t === 'pathogen' ? grant?.include_pathogen === true : true))
    // 自定义检测类型不在 RECORD_ROUTE_TYPES 内，一律不下发（默认不开放）
  return [...new Set(allowed)]
}

export function grantAllowsType(grant, testType) {
  return resolveGrantTypes(grant).includes(String(testType))
}

/** 业务检测日期范围判定：grant.start_date / end_date（含边界）；日期非法/缺失视为不在范围内。 */
export function grantDateRange(grant) {
  const toDay = (d) => {
    if (!d) return null
    const dt = d instanceof Date ? d : new Date(d)
    if (Number.isNaN(dt.getTime())) return null
    return dt.toISOString().slice(0, 10)
  }
  return { start: toDay(grant?.start_date), end: toDay(grant?.end_date) }
}

/* ─────────────── 结论口径（与前端 Dashboard.isQualified / stats SQL 同源）─────────────── */

const PASS = 'pass'
const FAIL = 'fail'
const WARN = 'warning'
const UNKNOWN = 'unknown'

function textToConclusion(text) {
  const s = String(text ?? '').trim()
  if (!s) return UNKNOWN
  if (s.includes('不合格')) return FAIL
  if (s.includes('警戒')) return WARN
  if (s.includes('合格')) return PASS
  return UNKNOWN
}

/**
 * 由记录数据推导初检/最终结论。
 * - 初检：tableware/pesticide/leanMeat 看 result 文本；oil 优先 colorLevel；pathogen 看 riskLevel；
 * - 最终：finalStatus（整改后复检合格 / 复检不合格）优先，无则等于初检；
 * - is_positive：仅病原体有意义（riskLevel 非空且 ≠ 无风险）。
 */
export function deriveConclusion(testType, resultData) {
  const data = resultData && typeof resultData === 'object' ? resultData : {}
  let initial = UNKNOWN
  let text = ''

  if (testType === 'pathogen') {
    const risk = String(data.riskLevel ?? '').trim()
    initial = risk ? (risk === '无风险' ? PASS : FAIL) : UNKNOWN
    text = risk
  } else if (testType === 'oil') {
    const color = String(data.colorLevel ?? '').trim()
    if (color) {
      initial = textToConclusion(color)
      text = color
    } else {
      text = String(data.result ?? '').trim()
      initial = textToConclusion(text)
    }
  } else {
    text = String(data.result ?? '').trim()
    initial = textToConclusion(text)
  }

  const finalStatus = String(data.finalStatus ?? '').trim()
  const recheckPassed = getLatestRecheckPassed(data)
  let final = initial
  if (finalStatus) {
    final = textToConclusion(finalStatus)
    text = finalStatus
  } else if (typeof recheckPassed === 'boolean') {
    final = recheckPassed ? PASS : FAIL
  }

  const isPositive = testType === 'pathogen'
    ? (String(data.riskLevel ?? '').trim() ? String(data.riskLevel).trim() !== '无风险' : null)
    : null

  return { initial, final, text: text || null, isPositive }
}

/* ─────────────── 对外记录序列化 ─────────────── */

/** 本地（Asia/Shanghai，UTC+8）ISO8601，避免依赖进程时区。 */
export function toIsoShanghai(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000)
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00')
}

/** 业务检测日期：只接受 YYYY-MM-DD（或带时间的字符串取前 10 位）；非法返回 null。 */
export function pickTestDate(sampleInfo) {
  const raw = sampleInfo?.testDate
  if (raw == null) return null
  const s = String(raw).trim()
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/**
 * 组装单条对外记录。
 * @param {object} record 租户库 TestRecord 行
 * @param {object} grant  命中的 OpenApiGrant
 * @param {{schoolCode:string, schoolName?:string|null}} ctx
 */
export function buildOpenRecord(record, grant, ctx = {}) {
  const sampleInfo = record.sample_info && typeof record.sample_info === 'object' ? record.sample_info : {}
  const resultData = record.result_data && typeof record.result_data === 'object' ? record.result_data : {}
  const conclusion = deriveConclusion(record.test_type, resultData)

  const item = {
    record_id: record.id,
    record_code: record.record_code,
    school_code: ctx.schoolCode,
    school_name: ctx.schoolName || null,
    test_type: record.test_type,
    test_name: record.test_name || TEST_TYPE_LABELS[record.test_type] || record.test_type,
    test_date: pickTestDate(sampleInfo),
    canteen: sampleInfo.canteen ?? null,
    status: record.status,
    initial_conclusion: conclusion.initial,
    final_conclusion: conclusion.final,
    conclusion: conclusion.final,          // 对外统一以"最终结论"为准
    conclusion_text: conclusion.text,
    conclusion_source: 'stored',           // 记录内冻结值（非实时重算）
    is_positive: conclusion.isPositive,
    result: projectResultData(resultData),
    created_at: toIsoShanghai(record.created_at),
    updated_at: toIsoShanghai(record.updated_at),
    data_version: record.data_version ?? 1,
  }
  if (grant?.include_inspector === true) {
    item.inspector = sampleInfo.inspector ?? null
  }
  return item
}

/* ─────────────── 增量游标 ─────────────── */

const CURSOR_VERSION = 1

/** 游标 = base64url(JSON)，携带学校 + 授权指纹 + 水位(updated_at,id)，由服务端生成/校验。 */
export function encodeCursor({ schoolCode, scopeVersion, updatedAt, id }) {
  const payload = { v: CURSOR_VERSION, s: schoolCode, g: scopeVersion, u: updatedAt, i: id }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** 解析游标；格式非法返回 null；scopeVersion 不匹配由调用方判 409。 */
export function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!obj || obj.v !== CURSOR_VERSION || !obj.s || !obj.u || !obj.i) return null
    return obj
  } catch {
    return null
  }
}

/** 全量清单摘要指纹：record_code + updated_at 升序拼接后 sha256（对方据此判断是否需要重对账）。 */
export function computeManifestDigest(rows) {
  const lines = rows
    .map((r) => `${r.record_code}@${r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at)}`)
    .sort()
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

export default {
  DEFAULT_OPEN_TYPES,
  resolveGrantTypes,
  grantAllowsType,
  grantDateRange,
  projectResultData,
  deriveConclusion,
  buildOpenRecord,
  toIsoShanghai,
  pickTestDate,
  encodeCursor,
  decodeCursor,
  computeManifestDigest,
}
