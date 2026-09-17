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
import { RECORD_ROUTE_TYPES, TEST_TYPE_LABELS, getLatestRecheckPassed, isValidBusinessDate } from './recordNormalize.js'

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

/** 未登记字段被白名单丢弃时的告警（同一键只提示一次，避免刷日志）。 */
const _droppedKeyWarned = new Set()
function warnDroppedKey(key) {
  if (_droppedKeyWarned.has(key)) return
  _droppedKeyWarned.add(key)
  console.warn(`[openApiScope] 未登记字段按白名单丢弃（不下发）：result.${key}（如需下发请在 lib/openApiFieldSchema.js 登记）`)
}

/**
 * 递归投影：剔除内部字段 + PII 字段。仅处理普通对象/数组，深度上限 8 层防御异常结构。
 * @param {*} value 任意 JSON 值
 * @param {{allowedKeys?: Set<string>|null, onDropped?: (k:string)=>void}} options
 * @param {number} depth
 */
function projectValue(value, options = {}, depth = 0) {
  if (depth > 8) return null
  if (Array.isArray(value)) return value.map((v) => projectValue(v, options, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (INTERNAL_RESULT_KEYS.has(k)) continue
      if (isPiiKey(k)) continue
      // 顶层白名单（2026-09-16 审阅 M2）：只放行「字段字典登记过的 result.* 键」；
      // 容器内部（depth>0）仍走递归黑名单，为未来新增的人名类键兜底。
      if (depth === 0 && options.allowedKeys instanceof Set && !options.allowedKeys.has(k)) {
        if (typeof options.onDropped === 'function') options.onDropped(k)
        else warnDroppedKey(k)
        continue
      }
      out[k] = projectValue(v, options, depth + 1)
    }
    return out
  }
  return value
}

/**
 * 对外下发的结果数据。双层策略：
 *   ① **顶层白名单**：只允许字典登记过的 `result.*` 键（含学校自定义字段）——未登记不再无条件透传；
 *   ② 容器内**递归黑名单**：剔除内部字段与 PII（人名类键正则兜底）。
 *
 * @param {*} resultData
 * @param {{allowedKeys?: Set<string>|null, onDropped?: (k:string)=>void}} [options]
 *        `allowedKeys` 未传 = 不做顶层白名单（仅供内部/兼容场景；**对外路由必须传**，
 *        由 `openApiFieldSchema.buildAllowedResultKeyMap` 生成）
 */
export function projectResultData(resultData, options = {}) {
  if (!resultData || typeof resultData !== 'object' || Array.isArray(resultData)) return {}
  return projectValue(resultData, options, 0)
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
export function grantDateRange(grant) {  const toDay = (d) => {
    if (!d) return null
    const dt = d instanceof Date ? d : new Date(d)
    if (Number.isNaN(dt.getTime())) return null
    return dt.toISOString().slice(0, 10)
  }
  return { start: toDay(grant?.start_date), end: toDay(grant?.end_date) }
}

/* ─────────────── 业务日期（sample_info.testDate）安全比较 ───────────────
 *
 * ⚠️ 2026-09-16 线上故障根因：业务日期在库内是**文本**（`sample_info->>'testDate'` 前 10 位），
 * 而历史实现写成 `substring(...) >= $N::date`。PostgreSQL **没有 text → date 的隐式转换**，
 * 该表达式直接报 `operator does not exist: text >= date`（HINT: You might need to add explicit type casts）
 * → 只要请求带 `start`/`end`，或授权配置了业务日期范围（grant.start_date/end_date），接口必然 500。
 *
 * 正确做法：参数归一为 `YYYY-MM-DD` 文本，两侧都按**文本比较**（同长度 ISO 文本的字典序 = 时间序），
 * 且比较前先过合法性正则，避免 `2026-1-1` 这类脏值被字典序误判入范围。
 */
export const BUSINESS_DATE_TEXT_EXPR = `substring(COALESCE("sample_info"->>'testDate','') from 1 for 10)`

/**
 * 业务日期合法性 SQL 片段：**格式 + 真实公历**（与 `parseDayParam` 的 JS 校验同语义）。
 *
 * 纯文本/数值判定，**不对原始值做 `::date`**：脏历史数据（`2026-02-30` / `2026-13-01` / 空值）
 * 只会被判为 false，绝不触发 `date/time field value out of range` 500。
 * `::int` 强转全部放在 CASE 分支内（PostgreSQL 保证 CASE 只求值命中的分支），因此只有
 * 先通过 `${...} ~ '^[0-9]{4}-...$'` 的值才会被强转。
 */
export function businessDateValidSql() {
  const t = BUSINESS_DATE_TEXT_EXPR
  const y = `substring(${t} from 1 for 4)`
  const mo = `substring(${t} from 6 for 2)`
  const d = `substring(${t} from 9 for 2)`
  const leap = `((${y}::int % 4 = 0 AND ${y}::int % 100 <> 0) OR ${y}::int % 400 = 0)`
  return `(CASE
      WHEN ${t} !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN false
      WHEN ${mo} NOT BETWEEN '01' AND '12' THEN false
      WHEN ${d} NOT BETWEEN '01' AND '31' THEN false
      WHEN ${mo} = '02' THEN (${d}::int <= CASE WHEN ${leap} THEN 29 ELSE 28 END)
      WHEN ${mo} IN ('04','06','09','11') THEN (${d}::int <= 30)
      ELSE true
    END)`
}

/**
 * 解析日期型查询参数（start / end）。
 * 接受 `YYYY-MM-DD`，或 ISO8601 日期时间（取日期部分，如 `2026-01-15T10:00:00+08:00`）。
 * @returns {{ok:true, day:string|null}|{ok:false, code:string, message:string}}
 */
export function parseDayParam(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: true, day: null }
  const s = String(raw).trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/)
  if (!m) return { ok: false, code: 'INVALID_DAY_FORMAT', message: '日期需为 YYYY-MM-DD（或 ISO8601 日期时间）' }
  const day = `${m[1]}-${m[2]}-${m[3]}`
  const dt = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== day) {
    return { ok: false, code: 'INVALID_DAY_VALUE', message: `日期 ${day} 不存在（请检查月份/日期）` }
  }
  return { ok: true, day }
}

/** 取较晚 / 较早的日期（null 表示"不限"）。用于「授权范围 ∩ 请求范围」。 */
export function maxDay(a, b) {
  return !a ? b : (!b ? a : (a >= b ? a : b))
}
export function minDay(a, b) {
  return !a ? b : (!b ? a : (a <= b ? a : b))
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
    // 食用油口径（业务方 2026-07-23 裁定，与前端 Dashboard.isOilQualified 及 /api/test-records/stats 同源）：
    //   按「品质等级」colorLevel 判定，**仅“不合格”判不合格**；已知等级 合格/警戒 视为合格；
    //   无 colorLevel 时以 result 兜底。
    // ⚠️ 2026-09-17 P1 修复：原实现 `color.includes('不合格') ? FAIL : PASS` 是 **fail-open** ——
    //   任何非空脏值（“深绿色”“foo”“录入错误”）都会被判成“合格”。现改为**显式枚举**：
    //     已知合格类 → pass；已知不合格 → fail；**未识别值回退 result 文本判定**（与 /stats 的 SQL 分支一致）。
    //   实测生产 colorLevel 仅 合格/警戒，本修复对现有数据零影响；若业务方确认“其它等级也算合格”，
    //   需提供权威枚举后再登记到 OIL_COLOR_PASS。
    const color = String(data.colorLevel ?? '').trim()
    if (OIL_COLOR_PASS.has(color)) {
      initial = PASS
      text = color
    } else if (OIL_COLOR_FAIL.has(color)) {
      initial = FAIL
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
  let basis = 'initial'
  if (finalStatus) {
    final = textToConclusion(finalStatus)
    text = finalStatus
    basis = 'recheck'
  } else if (typeof recheckPassed === 'boolean') {
    final = recheckPassed ? PASS : FAIL
    basis = 'recheck'
  }

  const isPositive = testType === 'pathogen'
    ? (String(data.riskLevel ?? '').trim() ? String(data.riskLevel).trim() !== '无风险' : null)
    : null

  return { initial, final, text: text || null, isPositive, basis }
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

/**
 * 业务检测日期：只接受 `YYYY-MM-DD`（或带时间的字符串取前 10 位），且必须是**真实公历日期**；
 * 否则返回 null（2026-09-17：`2026-02-30`/`2026-13-01` 这类"格式像日期"的脏值不再被当正常日期下发）。
 */
export function pickTestDate(sampleInfo) {
  const raw = sampleInfo?.testDate
  if (raw == null) return null
  const s = String(raw).trim()
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (!m) return null
  return isValidBusinessDate(m[1]) ? m[1] : null
}

/** 食用油 colorLevel 权威枚举：仅「不合格」判不合格（业务裁定）；未识别值不得默认合格。 */
export const OIL_COLOR_PASS = new Set(['合格', '警戒'])
export const OIL_COLOR_FAIL = new Set(['不合格'])

/**
 * 组装单条对外记录。
 * @param {object} record 租户库 TestRecord 行
 * @param {object} grant  命中的 OpenApiGrant
 * @param {{schoolCode:string, schoolName?:string|null, allowedResultKeys?:Set<string>}} ctx
 *        `allowedResultKeys` = 该类型允许下发的 result.* 顶层键白名单（对外路由必须传，
 *        由 `openApiFieldSchema.buildAllowedResultKeyMap` 生成，与字段字典同源）
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
    conclusion_source: 'stored',           // 录入/检测当时保存的值（非按当前规则实时重算）
    final_conclusion_basis: conclusion.basis, // 'initial'（无复检）| 'recheck'（由复检结论覆盖）
    is_positive: conclusion.isPositive,
    result: projectResultData(resultData, {
      allowedKeys: ctx.allowedResultKeys instanceof Set ? ctx.allowedResultKeys : null,
      onDropped: ctx.onDroppedResultKey,
    }),
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

// 游标版本：v2 起额外携带 filters 指纹（f）与投影策略指纹（p），用于拒绝"换筛选条件/换策略"复用游标。
const CURSOR_VERSION = 2

/**
 * 游标 = base64url(JSON)，携带：学校 + 授权版本 + **筛选条件指纹** + **投影策略指纹** + 水位(updated_at,id)。
 * 由服务端生成、服务端校验：客户端无法通过替换 school_code / test_type / 日期条件或复用旧策略游标
 * 来扩大可见范围。
 */
export function encodeCursor({ schoolCode, scopeVersion, updatedAt, id, filtersFingerprint, projectionFingerprint }) {
  const payload = {
    v: CURSOR_VERSION,
    s: schoolCode,
    g: scopeVersion,
    f: filtersFingerprint || null,
    p: projectionFingerprint || null,
    u: updatedAt,
    i: id,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** 筛选条件指纹：学校 + 类型集合 + 业务日期范围（客户端请求条件，非授权范围）。 */
export function computeFiltersFingerprint({ schoolCode, types, start, end }) {
  const payload = JSON.stringify({
    s: String(schoolCode || ''),
    t: [...(types || [])].map(String).sort(),
    b: start || null,
    e: end || null,
  })
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/**
 * 投影/可见性策略指纹：任何会改变"对方能看到什么"的授权属性（类型白名单、病原体、检测人、
 * 附件开关、业务日期范围）都参与计算。
 * 用途：① 让清单 digest 能反映"字段可见性变化"（否则关闭检测人姓名时 digest 不变，
 * 客户端会误判为无变化而跳过重投影）；② 校验游标策略一致性。
 */
/**
 * 字段投影实现的修订号 —— **任何改变对外输出内容的改动都必须 bump 本值**：
 *   · result_data 白名单/剔除规则（新增或移除某字段的下发）
 *   · 结论推导口径（例：oil colorLevel 枚举化）
 *   · 影响输出的字段字典结构变化
 *
 * 背景（2026-09-17 审阅 F6）：指纹原先只含授权开关与恒定契约版本 →
 * "记录行与授权都没变、但投影实现变了"时指纹与 manifest digest 都不变，
 * 已完成同步的客户端会一直认为数据未变，长期保留旧字段（例如已被撤回但本地未清除的证据字段）。
 */
export const PROJECTION_REVISION = 'proj-r2-2026-09-17'

export function computeProjectionFingerprint(grant, extra = null) {
  const { start, end } = grantDateRange(grant)
  const payload = JSON.stringify({
    c: CONTRACT_VERSION_FOR_FINGERPRINT,
    r: PROJECTION_REVISION,     // 投影实现修订号（F6）
    k: extra || '',             // 学校"影响输出的配置"指纹（自定义字段经白名单过滤；见 allowedKeysFingerprint）
    t: resolveGrantTypes(grant),
    p: grant?.include_pathogen === true,
    i: grant?.include_inspector === true,
    a: grant?.include_attachments === true,
    s: start,
    e: end,
  })
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

// 独立常量，避免与 openApiFieldSchema 形成循环依赖（该模块不反向依赖本模块）
const CONTRACT_VERSION_FOR_FINGERPRINT = 'v1'

/**
 * 解析游标。格式非法返回 null（调用方判 400）。
 * 版本号写入 `_version` 由调用方判断：低于当前版本 = 旧协议游标（应要求重新对账，而非静默继续）。
 */
export function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!obj || typeof obj !== 'object' || !obj.s || !obj.u || !obj.i) return null
    obj._version = Number(obj.v) || 0
    obj._current = obj._version === CURSOR_VERSION
    return obj
  } catch {
    return null
  }
}

export const CURRENT_CURSOR_VERSION = CURSOR_VERSION

/**
 * 全量清单摘要指纹。
 * 组成 = 协议版本 + 授权版本 + 投影策略指纹 + 每条 `record_code@updated_at`（升序）。
 * 因此以下任一变化都会改变 digest：记录增删改、**授权范围变化、字段可见性策略变化**
 * （后者若不纳入，关闭"下发检测人姓名"后 digest 不变，客户端会误判为无变化而跳过重投影）。
 * @param {Array<{record_code: string, updated_at: Date|string}>} rows
 * @param {{scopeVersion?: number|string, projectionFingerprint?: string}} [meta]
 */
export function computeManifestDigest(rows, meta = {}) {
  const header = [
    `cursor_v${CURSOR_VERSION}`,
    `scope=${meta.scopeVersion ?? ''}`,
    `projection=${meta.projectionFingerprint ?? ''}`,
  ].join('|')
  const lines = rows
    .map((r) => `${r.record_code}@${r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at)}`)
    .sort()
  return crypto.createHash('sha256').update(`${header}\n${lines.join('\n')}`).digest('hex')
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
  computeFiltersFingerprint,
  computeProjectionFingerprint,
}
