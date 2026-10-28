// pathogenDevice.js — 病原体设备自动采集（VirusHunter2.0B）领域逻辑
//
// 职责（本文件为协议口径的唯一事实源，路由层只做编排）：
//   ① 设备密钥生成 / 哈希 / 提取（与 lib/openApiKeys.js 同口径，前缀 pdv_）；
//   ② VirusHunter2.0B 上报报文校验与归一（字段、点位字典结构、时间格式）；
//   ③ 报文 → pathogen 记录负载映射（与手动导入 Word 的报告结构同构，见前端 modules/Pathogen.js）；
//   ④ 风险计算（与前端 utils/pathogenRisk.js 同规则：Ct<20 高 / 20~30 中 / 30~35 低 / ≥35 极低；
//      内参/内标不计阳性）；
//   ⑤ 食堂识别（SampleStr 模糊匹配学校食堂名单，别名兼容，回落设备默认食堂）；
//   ⑥ 幂等 record_code 派生（device_no + DetectionNumber，重复上传不产生第二条记录）。
//
// ⚠️ 本文件不接触数据库、不做租户路由；所有 IO 由 routes/pathogenDeviceRoutes.js 负责。

import crypto from 'node:crypto'

export const DEVICE_KEY_PREFIX = 'pdv_'

// ───────────────────────── 设备密钥 ─────────────────────────

/** 生成一把设备密钥（明文 + 哈希 + 展示串）。明文仅创建/轮换时返回一次。 */
export function generateDeviceKey() {
  const raw = crypto.randomBytes(32).toString('base64url')
  const plain = DEVICE_KEY_PREFIX + raw
  return {
    plain,
    hash: hashDeviceKey(plain),
    prefix: deviceKeyDisplayPrefix(plain),
    last4: plain.slice(-4),
  }
}

/** sha256(明文) → hex，与库中 key_hash 比对（随机长串，sha256 足够，无需慢哈希）。 */
export function hashDeviceKey(plain) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex')
}

function deviceKeyDisplayPrefix(plain) {
  return String(plain).slice(0, DEVICE_KEY_PREFIX.length + 8)
}

/** 从请求中提取设备密钥：X-API-Key 优先，兼容 Authorization: Bearer。 */
export function extractDeviceKey(req) {
  const headerKey = req.get?.('x-api-key')
  if (headerKey && String(headerKey).trim()) return String(headerKey).trim()
  const auth = req.get?.('authorization')
  if (auth && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, '').trim()
    if (token) return token
  }
  return null
}

// ───────────────────────── 协议字段校验 ─────────────────────────

const MAX_SAMPLE_STR = 200
const MAX_PEOPLE_STR = 60
const MAX_NUMBER_LEN = 64
const MAX_FILE_NAME = 200
const MAX_CHIP_LEN = 64
const MAX_PARMS_ENTRIES = 64
const MAX_FLUORESCENCE_POINTS = 64 // result_data 快照截断保留的点数（防 JSON 膨胀）
const CHANNEL_RE = /^(FAM|HEX|ROX|CY5)-[1-8]$/i
const INTERNAL_CONTROL_RE = /内标|内参|内控|internal\s*control|(^|[^a-z])ic([^a-z]|$)/i

/** 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DDTHH:mm:ss' / 带时区 ISO → Date；失败返回 null。 */
export function parseDetectionDateTime(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se || 0))
  if (Number.isNaN(dt.getTime())) return null
  // 拒绝 JS Date 自动滚动的非法日历日（2026-02-30 等）
  if (dt.getFullYear() !== Number(y) || dt.getMonth() !== Number(mo) - 1 || dt.getDate() !== Number(d)) return null
  return dt
}

/** 业务日期（YYYY-MM-DD，本地时区口径，与前端 getLocalDateStr / 库内 testDate 一致）。 */
export function toBusinessDateStr(dt) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

function timeStr(dt) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 校验 VirusHunter2.0B 上报报文（设备编号由路由层单独校验）。
 * @returns {{ ok: true, data: object } | { ok: false, message: string }}
 *          data 为归一后的字段（时间已解析、点位按 Parms 归一、荧光截断保留）。
 */
export function validateUploadPayload(body) {
  const errors = []
  // 失败统一带 errors（全量原因）：设备方一次就能改完，也便于服务端日志定位（2026-10-22）
  const fail = (message, all) => ({ ok: false, message, errors: Array.isArray(all) && all.length ? all.slice(0, 20) : [message] })
  if (!isPlainObject(body)) return fail('请求体必须是 JSON 对象')

  const str = (v) => (typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : ''))

  const deviceNo = str(body.DeviceNo)
  if (!deviceNo) errors.push('DeviceNo不能为空')
  else if (deviceNo.length > MAX_NUMBER_LEN) errors.push(`DeviceNo长度不能超过${MAX_NUMBER_LEN}`)

  const startRaw = str(body.DetectionDateTime)
  const startDt = parseDetectionDateTime(startRaw)
  if (!startRaw) errors.push('DetectionDateTime不能为空')
  else if (!startDt) errors.push('DetectionDateTime格式错误（应为 YYYY-MM-DD HH:mm:ss）')

  const endRaw = str(body.DetectionEndDateTime)
  const endDt = parseDetectionDateTime(endRaw)
  if (!endRaw) errors.push('DetectionEndDateTime不能为空')
  else if (!endDt) errors.push('DetectionEndDateTime格式错误（应为 YYYY-MM-DD HH:mm:ss）')
  else if (startDt && endDt < startDt) errors.push('DetectionEndDateTime早于DetectionDateTime')

  const sampleStr = str(body.SampleStr)
  if (!sampleStr) errors.push('SampleStr不能为空')
  else if (sampleStr.length > MAX_SAMPLE_STR) errors.push(`SampleStr长度不能超过${MAX_SAMPLE_STR}`)

  const peopleStr = str(body.DetectionPeopleStr)
  if (!peopleStr) errors.push('DetectionPeopleStr不能为空')
  else if (peopleStr.length > MAX_PEOPLE_STR) errors.push(`DetectionPeopleStr长度不能超过${MAX_PEOPLE_STR}`)

  const detectionNumber = str(body.DetectionNumber)
  if (!detectionNumber) errors.push('DetectionNumber不能为空')
  else if (detectionNumber.length > MAX_NUMBER_LEN) errors.push(`DetectionNumber长度不能超过${MAX_NUMBER_LEN}`)

  const fileName = str(body.FileName)
  if (!fileName) errors.push('FileName不能为空')
  else if (fileName.length > MAX_FILE_NAME) errors.push(`FileName长度不能超过${MAX_FILE_NAME}`)

  const chipName = str(body.ChipName)
  if (!chipName) errors.push('ChipName不能为空')
  else if (chipName.length > MAX_CHIP_LEN) errors.push(`ChipName长度不能超过${MAX_CHIP_LEN}`)

  const chipNumber = str(body.ChipNumber)
  if (!chipNumber) errors.push('ChipNumber不能为空')
  else if (chipNumber.length > MAX_CHIP_LEN) errors.push(`ChipNumber长度不能超过${MAX_CHIP_LEN}`)

  const chipId = str(body.ChipID)
  if (chipId.length > MAX_CHIP_LEN) errors.push(`ChipID长度不能超过${MAX_CHIP_LEN}`)

  // 点位三张字典：Parms 定义「本次实际使用的点位」，ResultList/CTList 必须覆盖同一点位集合
  const parms = body.Parms
  if (!isPlainObject(parms)) {
    errors.push('Parms必须是对象（点位名称字典）')
  } else if (Object.keys(parms).length === 0) {
    errors.push('Parms不能为空（至少包含一个点位）')
  } else if (Object.keys(parms).length > MAX_PARMS_ENTRIES) {
    errors.push(`Parms点位数量不能超过${MAX_PARMS_ENTRIES}`)
  }

  const resultList = body.ResultList
  if (!isPlainObject(resultList)) errors.push('ResultList必须是对象（点位判读结果）')

  const ctList = body.CTList
  if (!isPlainObject(ctList)) errors.push('CTList必须是对象（点位CT值）')

  const fluo = body.OptimizationDataLists
  if (!isPlainObject(fluo)) errors.push('OptimizationDataLists必须是对象（点位荧光数据集合）')

  if (errors.length) return fail(`参数校验失败：${errors[0]}`, errors.map((e) => `参数校验失败：${e}`))

  // 点位集合一致性（以 Parms 为准）
  const points = Object.keys(parms)
  const badChannel = points.find((k) => !CHANNEL_RE.test(k))
  if (badChannel) {
    return fail(`参数校验失败：点位标识 ${badChannel} 不合法（应为 通道-序号，如 FAM-1，通道∈{FAM,HEX,ROX,CY5}，序号1~8）`)
  }
  for (const p of points) {
    if (typeof resultList[p] !== 'boolean') {
      return fail(`参数校验失败：ResultList 缺少点位 ${p} 的布尔判读值`)
    }
    if (typeof ctList[p] !== 'string' && typeof ctList[p] !== 'number') {
      return fail(`参数校验失败：CTList 缺少点位 ${p} 的CT值（未检出用 "-"）`)
    }
  }
  // ResultList/CTList 中 Parms 之外的点位视为脏数据：忽略（不阻断），以 Parms 为准

  // 荧光数据：数组结构校验（超长截断仅发生在快照落库时）
  if (isPlainObject(fluo)) {
    for (const p of points) {
      const arr = fluo[p]
      if (arr === undefined) continue // 允许缺省（设备可只回传判读与 CT）
      if (!Array.isArray(arr) || arr.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
        return fail(`参数校验失败：OptimizationDataLists.${p} 必须是数字数组`)
      }
    }
  }

  // 归一：点位按 Parms 顺序，CT 统一为字符串（'-' 表示未检出）
  const normalizedPoints = points.map((p) => ({
    key: p,
    name: str(parms[p]) || '未知靶标',
    positive: resultList[p] === true,
    ctRaw: str(ctList[p]) || '-',
    fluorescence: Array.isArray(fluo?.[p]) ? fluo[p].slice(0, MAX_FLUORESCENCE_POINTS) : [],
    fluorescenceTruncated: Array.isArray(fluo?.[p]) && fluo[p].length > MAX_FLUORESCENCE_POINTS,
  }))

  return {
    ok: true,
    data: {
      deviceNo,
      startDt,
      endDt,
      sampleStr,
      peopleStr,
      detectionNumber,
      fileName,
      chipId,
      chipName,
      chipNumber,
      points: normalizedPoints,
    },
  }
}

// ───────────────────────── 风险计算（与前端 pathogenRisk.js 同规则） ─────────────────────────

export function isPositiveResultText(result) {
  if (!result) return false
  const s = String(result).trim()
  return s.includes('阳性') || s === '+' || s === '(+)' || s === '＋'
}

/**
 * 由点位集合计算阳性项与风险等级。内参/内标不计阳性（与手动导入口径一致）。
 * @returns {{ positiveDetails: Array, positiveItemsDisplay: string, riskLevel: string, riskReason: string, minCt: number|null }}
 */
export function calculateDeviceRisk(points) {
  const positives = points
    .filter((p) => p.positive && !INTERNAL_CONTROL_RE.test(p.name))
    .map((p) => {
      const ct = parseFloat(p.ctRaw)
      return { pathogen: p.name, channel: p.key, ct: Number.isFinite(ct) ? ct : 999, ctRaw: p.ctRaw }
    })

  if (positives.length === 0) {
    return {
      positiveDetails: [],
      positiveItemsDisplay: '无',
      riskLevel: '无风险',
      riskReason: '所有检测项均为阴性',
      minCt: null,
    }
  }

  const minCt = Math.min(...positives.map((p) => p.ct))
  let riskLevel
  let interpretation
  if (minCt < 20) {
    riskLevel = '高风险'
    interpretation = '病原体载量高，提示可能存在活性感染源，需立即处置'
  } else if (minCt < 30) {
    riskLevel = '中风险'
    interpretation = '检出中等载量病原体核酸，建议加强清洁消毒'
  } else if (minCt < 35) {
    riskLevel = '低风险'
    interpretation = '检出低载量病原体核酸，可能为环境残留，建议常规消毒'
  } else {
    riskLevel = '极低风险'
    interpretation = '仅检出微量核酸片段，通常为环境残留或非活性核酸，无需特殊处置（参考：Kitajima et al., 2012）'
  }

  const positiveItemsDisplay = positives.map((p) => `${p.pathogen}(Ct:${p.ctRaw})`).join(', ')
  const critical = positives.find((p) => p.ct === minCt) || positives[0]
  const riskReason = `${critical.pathogen}，Ct=${critical.ctRaw}。${interpretation}`

  return { positiveDetails: positives, positiveItemsDisplay, riskLevel, riskReason, minCt }
}

// ───────────────────────── 食堂识别 ─────────────────────────

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** 食堂名别名：一食堂 / 1食堂 / 第1食堂 / 1号食堂 / 第一食堂 / 一号食堂 互通（与前端 canteenAliases 同口径）。 */
export function canteenAliases(name) {
  if (!name) return [name]
  const m = /^([一二三四五六七八九十\d]+)食堂$/.exec(name)
  if (!m) return [name]
  const n = m[1]
  let num
  if (/^\d+$/.test(n)) num = parseInt(n, 10)
  else num = CN_NUM[n]
  if (!num || num < 1 || num > 10) return [name]
  const numToCn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  const cn = numToCn[num - 1]
  const numStr = String(num)
  return [name, cn + '食堂', numStr + '食堂', '第' + numStr + '食堂', numStr + '号食堂', '第' + cn + '食堂', cn + '号食堂']
}

function normalizeForCanteenMatch(t) {
  return String(t || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
}

/**
 * 从样本信息中提取**显式**食堂名（如「四食堂」「第4食堂」「4号食堂」），提取不到返回 null。
 * 用途：报文明确点名了食堂、但该名称不在学校食堂列表时，必须报错而不是静默回落默认食堂。
 */
export function extractExplicitCanteenToken(text) {
  const m = /(?:第\s*)?[一二三四五六七八九十\d]{1,3}\s*号?\s*食堂/.exec(String(text || ''))
  return m ? m[0].replace(/\s+/g, '') : null
}

/** 在 text 中查找学校食堂列表（支持别名）；返回匹配到的食堂名或 null。 */
export function matchSchoolCanteen(text, schoolCanteens) {
  if (!text || !Array.isArray(schoolCanteens) || schoolCanteens.length === 0) return null
  const t = normalizeForCanteenMatch(text)
  for (const c of schoolCanteens) {
    if (t.includes(c)) return c
  }
  for (const c of schoolCanteens) {
    for (const alias of canteenAliases(c)) {
      if (alias !== c && t.includes(alias)) return c
    }
  }
  return null
}

// ───────────────────────── 记录映射 ─────────────────────────

/**
 * 报文 + 归属上下文 → pathogen 记录负载（扁平形态，与手动导入同构；
 * 经 recordNormalize.buildRecordWriteData('pathogen', payload) 落库）。
 *
 * @returns {{ ok: true, data: object } | { ok: false, code: string, message: string }}
 *          ok=false 仅 CANTEAN_UNRESOLVED / CANTEEN_UNRESOLVED（食堂无法识别且无默认食堂；
 *          绝不写「未知」污染看板分组）。
 */
export function buildPathogenRecordPayload({ payload, deviceNo, canteens, defaultCanteen }) {
  const matchedCanteen = matchSchoolCanteen(payload.sampleStr, canteens)
  const explicitCanteen = extractExplicitCanteenToken(payload.sampleStr)
  // ⚠️ 2026-10-28 按现场反馈改为**先入库 + 人工复核**（不再 422 拒绝）：
  //   报文显式点名了食堂但不在该校列表时，**保留原文食堂名入库**（不静默改成默认食堂），
  //   同时打 `canteen_not_in_list` 复核标记，由管理员判断「该校确有该食堂（需补名单）」还是「检测时填错」。
  const unknownCanteen = (!matchedCanteen && explicitCanteen) ? explicitCanteen : null
  const canteen = matchedCanteen || unknownCanteen || defaultCanteen || null
  if (!canteen) {
    // 连食堂名都提取不到、设备也没默认食堂 → 无法归属，仍拒绝（否则看板会出现无食堂数据）
    return {
      ok: false,
      code: 'CANTEEN_UNRESOLVED',
      message: `无法从样本信息「${payload.sampleStr}」识别食堂，且设备未配置默认食堂；请在控制台为该设备设置默认食堂`,
    }
  }
  const reviewFlags = []
  if (unknownCanteen) {
    reviewFlags.push({
      type: 'canteen_not_in_list',
      at: new Date().toISOString(),
      canteen: unknownCanteen,
      school_canteens: canteens,
      sample_str: payload.sampleStr,
      title: '食堂不在学校食堂名单内（已按原文入库，待复核）',
      hint: `报文样本信息为「${payload.sampleStr}」，识别到食堂「${unknownCanteen}」，但该校食堂名单只有（${canteens.join('、')}）。请复核：① 该校确实有「${unknownCanteen}」→ 在「学校管理 → 基本信息」补充食堂名单；② 检测时食堂信息填写有误 → 更正后重新上传（本条已按原文入库，可直接删除或更正）`,
    })
  }

  const risk = calculateDeviceRisk(payload.points)
  const allTestItems = payload.points.map((p, i) => ({
    no: i + 1,
    pathogen: p.name,
    channel: p.key,
    ct: p.ctRaw,
    result: p.positive ? '阳性' : '阴性',
    isInternalControl: INTERNAL_CONTROL_RE.test(p.name),
  }))
  const internalControlStatus = allTestItems
    .filter((it) => it.isInternalControl)
    .map((it) => `${it.pathogen}: ${it.result}`)
    .join(', ') || '无内标数据'

  return {
    ok: true,
    data: {
      // ── 上下文三键（权威位置 sample_info）──
      testDate: toBusinessDateStr(payload.startDt),
      canteen,
      inspector: payload.peopleStr,
      // ── 业务字段（result_data）──
      sampleId: payload.detectionNumber,
      sampleType: payload.sampleStr.includes('水') ? '水样' : '食品/环境样本',
      sampleInfo: payload.sampleStr,
      positiveItems: risk.positiveItemsDisplay,
      positiveDetails: risk.positiveDetails,
      riskLevel: risk.riskLevel,
      riskReason: risk.riskReason,
      allTestItems,
      internalControlStatus,
      // ── 设备采集溯源（手动导入记录无这些键，前端据此展示「设备」来源徽标）──
      source: 'device',
      deviceNo,
      reportFile: payload.fileName,
      chip: {
        id: payload.chipId || null,
        name: payload.chipName,
        number: payload.chipNumber,
      },
      detectionStartAt: `${toBusinessDateStr(payload.startDt)} ${timeStr(payload.startDt)}`,
      detectionEndAt: `${toBusinessDateStr(payload.endDt)} ${timeStr(payload.endDt)}`,
      // 内容指纹（2026-10-15）：芯片编号重复上报时判定「一致 → 幂等放行」/「不一致 → 请人工复核」
      contentFingerprint: detectionFingerprint({
        parms: Object.fromEntries(payload.points.map((p) => [p.key, p.name])),
        resultList: Object.fromEntries(payload.points.map((p) => [p.key, p.positive])),
        ctList: Object.fromEntries(payload.points.map((p) => [p.key, p.ctRaw])),
        detectionStartAt: `${toBusinessDateStr(payload.startDt)} ${timeStr(payload.startDt)}`,
        detectionEndAt: `${toBusinessDateStr(payload.endDt)} ${timeStr(payload.endDt)}`,
        sampleInfo: payload.sampleStr,
        inspector: payload.peopleStr,
      }),
      // 人工复核标记（2026-10-28）：数据**照常入库**，但需管理员确认的情况（如食堂不在名单）
      reviewFlags,
      // 原始协议快照：点位 + 判读 + CT + 截断荧光（完整荧光由设备本地留存，接口不返还）
      rawDetection: {
        parms: Object.fromEntries(payload.points.map((p) => [p.key, p.name])),
        resultList: Object.fromEntries(payload.points.map((p) => [p.key, p.positive])),
        ctList: Object.fromEntries(payload.points.map((p) => [p.key, p.ctRaw])),
        optimizationDataLists: Object.fromEntries(payload.points.map((p) => [p.key, p.fluorescence])),
        fluorescenceTruncated: payload.points.some((p) => p.fluorescenceTruncated),
      },
      // 手动导入记录的空数组键同构（编辑/复检等前端路径直接读这些键）
      modificationLogs: [],
      traceabilityRecords: [],
      recheckReports: [],
    },
  }
}

/**
 * 幂等 record_code（旧口径，保留兼容）：同一设备 + 同一样本编号 = 同一条记录。
 * ⚠️ 自 2026-10-15 起，设备上报的**重复判定以芯片编号为准**（一张芯片只产生一组数据），
 * 新记录使用 chipRecordCode()；本函数仅用于历史记录兼容与回归对照。
 */
export function deviceRecordCode(deviceNo, detectionNumber) {
  const hash = crypto.createHash('sha256').update(`${deviceNo}::${detectionNumber}`).digest('hex')
  return `RC-pathogen-${hash}`
}

/**
 * 芯片编号归一（去空白、统一大写）：同一张芯片的不同书写形式视为同一编号。
 */
export function normalizeChipNumber(chipNumber) {
  return String(chipNumber || '').replace(/[\s\u3000]+/g, '').toUpperCase()
}

/**
 * 幂等 record_code（现行口径）：**一张芯片 = 一组数据 = 一条记录**。
 * 同芯片重复上传 → 命中同一条记录，交由内容指纹判定「幂等放行」还是「请人工复核」。
 */
export function chipRecordCode(chipNumber) {
  const hash = crypto.createHash('sha256').update(`chip::${normalizeChipNumber(chipNumber)}`).digest('hex')
  return `RC-pathogen-chip-${hash}`
}

/**
 * 检测内容指纹：用于判定「同一芯片编号的两次上报是否一致」。
 * 只纳入判定性内容（点位/判读/CT + 检测时段 + 样本描述 + 检测员），不含文件名等展示性字段。
 */
export function detectionFingerprint({ parms, resultList, ctList, detectionStartAt, detectionEndAt, sampleInfo, inspector }) {
  const canonical = JSON.stringify({
    parms: parms || {},
    resultList: resultList || {},
    ctList: ctList || {},
    detectionStartAt: detectionStartAt || '',
    detectionEndAt: detectionEndAt || '',
    sampleInfo: String(sampleInfo || '').trim(),
    inspector: String(inspector || '').trim(),
  })
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

/** 从「已入库记录」还原内容指纹（兼容历史记录：从 rawDetection/三键重算）。 */
export function fingerprintOfStoredRecord(resultData = {}, sampleInfo = {}) {
  return detectionFingerprint({
    parms: resultData?.rawDetection?.parms,
    resultList: resultData?.rawDetection?.resultList,
    ctList: resultData?.rawDetection?.ctList,
    detectionStartAt: resultData?.detectionStartAt,
    detectionEndAt: resultData?.detectionEndAt,
    sampleInfo: resultData?.sampleInfo,
    inspector: sampleInfo?.inspector,
  })
}

/**
 * 档案键：判定「是否同一样本的多轮检测」。
 * 口径（2026-10-15 与产品确认）：同一学校内 **食堂 + 样本类型 + 样本描述（归一）+ 设备编号** 相同，
 * 且两次检测日期相差不超过 CASE_WINDOW_DAYS 天 → 视为同一档案的复测轮次。
 * 说明：检测员不纳入键（复测可能换人）；时间窗避免把该食堂每轮常规抽检并入同一档案。
 */
/**
 * 复测合并时间窗（天）。
 * ⚠️ 2026-10-27 由 7 改为 **0（同一自然日）**：现场实测发现 10-22 与 10-26 两次**独立采样检测**
 *   因「食堂 + 样本描述 + 样本编号 + 设备」相同而被误并为复测轮次，导致列表用首轮日期、
 *   结论却取最新轮次（「10.26 的记录显示成 10.22」）。
 *   复测合并只应覆盖「同一次采样的复测」（通常当日完成）；跨午夜场景可用环境变量
 *   `PATHOGEN_CASE_WINDOW_DAYS` 放宽（如 1 = 允许次日）。
 */
export const CASE_WINDOW_DAYS = Number.isFinite(Number(process.env.PATHOGEN_CASE_WINDOW_DAYS))
  ? Number(process.env.PATHOGEN_CASE_WINDOW_DAYS)
  : 0

export function normalizeSampleText(text) {
  return String(text || '').replace(/[\s\u3000]+/g, ' ').trim()
}

export function buildCaseKey({ canteen, sampleType, sampleInfo, deviceNo }) {
  // ⚠️ 2026-10-28 按现场反馈重定口径：**样本编号（DetectionNumber）不参与身份判定**——
  //   现场它是自由文本（可能是数字编号，也可能是文字说明），且不唯一（实测出现 "1"/"2"/"3"）。
  //   档案身份 = 食堂 + 样本类型 + 样本描述（归一） + 设备编号（+ 检测日期同窗，见 isSameCase）。
  return [canteen, sampleType, normalizeSampleText(sampleInfo), deviceNo].join('||')
}

/**
 * 记录是否属于同一档案（键相同 + 检测日期在窗口内）。
 * ⚠️ 2026-10-16 修正：档案键**纳入样本编号（DetectionNumber）**——「同一个样本」的身份必须包含样本编号，
 *   否则同食堂、同样本描述、同日、同设备的两份**不同样本**会被误并成同一档案的复测轮次
 *   （实测中已发生：真实上传被既有档案吸收）。
 */
export function isSameCase(existing, candidate) {
  const rd = existing?.result_data || {}
  const si = existing?.sample_info || {}
  const keyOf = (sampleInfo, sampleType, canteen, deviceNo, sampleId) => buildCaseKey({ canteen, sampleType, sampleInfo, deviceNo, sampleId })
  const existingKey = keyOf(rd.sampleInfo, rd.sampleType, si.canteen, rd.deviceNo, rd.sampleId)
  const candidateKey = keyOf(candidate.sampleInfo, candidate.sampleType, candidate.canteen, candidate.deviceNo, candidate.sampleId)
  if (existingKey !== candidateKey) return false
  const d1 = new Date(`${si.testDate || ''}T00:00:00Z`).getTime()
  const d2 = new Date(`${candidate.testDate || ''}T00:00:00Z`).getTime()
  if (!Number.isFinite(d1) || !Number.isFinite(d2)) return false
  return Math.abs(d1 - d2) <= CASE_WINDOW_DAYS * 86400000
}

/**
 * 构造「复检轮次」对象：与手动导入的 recheckReports 条目同构（前端 renderRecheckReports 直接可渲染），
 * 并补充设备溯源字段（芯片编号 / 检测时段 / 上传时间 / 轮次），用于区分第一轮与复测。
 */
export function buildDeviceRound({ built, payload, deviceNo, roundNo, uploadedAt, parentInspector = null }) {
  const risk = calculateDeviceRisk(payload.points)
  const allTestItems = payload.points.map((p, i) => ({
    no: i + 1,
    pathogen: p.name,
    channel: p.key,
    ct: p.ctRaw,
    result: p.positive ? '阳性' : '阴性',
    isInternalControl: INTERNAL_CONTROL_RE.test(p.name),
  }))
  return {
    // 与手动复检条目同构字段（前端既有渲染器直接使用）
    id: `device-round-${roundNo}-${Date.now()}`,
    importTime: new Date(uploadedAt).toLocaleString('zh-CN', { hour12: false }),
    importUser: deviceNo,
    testDate: built.testDate,
    sampleId: payload.detectionNumber,
    positiveItems: risk.positiveItemsDisplay,
    positiveDetails: risk.positiveDetails,
    riskLevel: risk.riskLevel,
    riskReason: risk.riskReason,
    allTestItems,
    inspector: payload.peopleStr,
    isPassed: risk.riskLevel === '无风险',
    // 设备溯源扩展（轮次语义）
    source: 'device',
    roundNo,
    roundLabel: roundNo === 1 ? '初检' : `第 ${roundNo} 次检测（复测）`,
    deviceNo,
    chipNumber: payload.chipNumber,
    chipName: payload.chipName,
    reportFile: payload.fileName,
    detectionStartAt: built.detectionStartAt,
    detectionEndAt: built.detectionEndAt,
    uploadedAt: new Date(uploadedAt).toISOString(),
    contentFingerprint: built.contentFingerprint,
    // 检测员变更显式化（2026-10-15 与产品确认：复测可能换人，变化需在结果上体现）
    // 检测员不参与档案键，因此换人仍并入同一档案；此处记录初检检测员与是否变更，供前端标注
    prevInspector: parentInspector || null,
    inspectorChanged: !!(parentInspector && String(parentInspector).trim() && String(parentInspector).trim() !== String(payload.peopleStr || '').trim()),
  }
}
