/**
 * 病原体结果归一化与风险评估（**唯一实现**，2026-11-03）
 *
 * 背景：设备上报链路（lib/pathogenDevice.js）与手动导入链路（前端 utils/pathogenRisk.js）
 *   各有一份"阳性识别 + 风险分档"实现，阈值虽一致但**文案/用词/项数**不同：
 *   · 设备：阴性/阳性；全 24 通道（含未使用通道占位 '-'）
 *   · 手动：未检出/阳性；仅报告里列出的项目
 *   现场对比同一张芯片的两条记录，用户看到"结果不一致"。
 *
 * 口径（2026-11-03 用户确认）：**以设备为准**
 *   —— 设备报文信息更全；芯片换代时靶标会变，不能用旧报告的固定靶标去套。
 *   因此：保留设备给出的靶标名（不做固定字典映射）、跳过未使用通道、
 *   判读统一为「阴性 / 阳性」、风险只保留本文件这一份实现。
 */

/** 内参/内标/内控（中英文）识别：这些通道不计入阳性，也不参与风险分级。 */
export const INTERNAL_CONTROL_RE = /内标|内参|内控|internal\s*control|(^|[^a-z])ic([^a-z]|$)/i

/** 判读用词归一：未检出 / 阴性 / - / negative → "阴性"；阳性 / + / (+) → "阳性"。 */
export function normalizeJudgement(v) {
  if (v === true) return '阳性'
  if (v === false) return '阴性'
  const s = String(v ?? '').trim()
  if (!s || s === '-' || s === '—') return '阴性'
  // ⚠️ 「弱阳性」保留原词：这是实验室真实判读，压成"阳性"会丢语义（风险计算仍按阳性处理，见 isPositiveJudgement）
  if (/弱阳性|弱阳|weak/i.test(s)) return '弱阳性'
  if (/阳性|positive|^\+$|^\(\+\)$|^＋$|^强阳/i.test(s)) return '阳性'
  return '阴性'
}

/** 是否按"阳性"计入风险（阳性 / 弱阳性 都算阳性）。 */
export function isPositiveJudgement(v) {
  return /阳性/.test(normalizeJudgement(v))
}

/** 从检测项里取「有效阳性」（排除内参；按 Ct 升序，Ct 越小越严重）。 */
export function extractPositives(allTestItems = []) {
  return (Array.isArray(allTestItems) ? allTestItems : [])
    .filter((it) => it && isPositiveJudgement(it.result) && !(it.isInternalControl || INTERNAL_CONTROL_RE.test(String(it.pathogen || ''))))
    .map((it) => {
      const ctRaw = it.ctRaw ?? it.ct ?? '-'
      const ct = parseFloat(it.ct ?? it.ctRaw)
      return { pathogen: it.pathogen || '未知靶标', channel: it.channel || null, ct: Number.isFinite(ct) ? ct : 999, ctRaw }
    })
}

/** 风险分档（与既有阈值一致：<20 高 / <30 中 / <35 低 / ≥35 极低）。 */
export function calcRisk(allTestItems = []) {
  const positives = extractPositives(allTestItems)
  if (!positives.length) {
    return {
      positiveItemsDisplay: '无',
      positiveDetails: [],
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
  const critical = positives.find((p) => p.ct === minCt) || positives[0]
  return {
    positiveItemsDisplay: positives.map((p) => `${p.pathogen}(Ct:${p.ctRaw})`).join(', '),
    positiveDetails: positives.map((p) => ({ pathogen: p.pathogen, ct: p.ct, ctRaw: p.ctRaw, ...(p.channel ? { channel: p.channel } : {}) })),
    riskLevel,
    riskReason: `${critical.pathogen}，Ct=${critical.ctRaw}。${interpretation}`,
    interpretation,
    minCt,
  }
}

/**
 * 统一一条病原体记录的 result_data（设备与手动两条链路共用）：
 * · 判读统一 阴性/阳性
 * · 内参统一标记 isInternalControl
 * · 阳性项 / 风险 按同一规则重算（无检测项时不动）
 */
export function normalizePathogenResult(rd = {}) {
  const rawItems = Array.isArray(rd.allTestItems) ? rd.allTestItems : []
  if (!rawItems.length) return rd
  // 跳过未使用通道（历史设备记录里的 "病原体=-" 占位项）——原始 parms 仍在 rawDetection 中
  const items = rawItems.filter((it) => {
    const name = String(it?.pathogen ?? '').trim()
    return name && name !== '-' && name !== '—'
  })
  const normalized = items.map((it, idx) => {
    const name = it?.pathogen ?? ''
    const isIc = it?.isInternalControl === true || INTERNAL_CONTROL_RE.test(String(name))
    return { ...it, no: idx + 1, result: normalizeJudgement(it?.result), ...(isIc ? { isInternalControl: true } : {}) }
  })
  const risk = calcRisk(normalized)
  const icItems = normalized.filter((x) => x.isInternalControl)
  const internalControlStatus = icItems.length
    ? icItems.map((x) => `内参: ${x.result}`).join(', ')
    : (rd.internalControlStatus || '无内标数据')
  return {
    ...rd,
    allTestItems: normalized,
    positiveItems: risk.positiveItemsDisplay,
    positiveDetails: risk.positiveDetails,
    riskLevel: risk.riskLevel,
    riskReason: risk.riskReason,
    internalControlStatus,
  }
}

/**
 * 样本类型分类（2026-11-03，设备口径：按样本描述关键词归类，不再只看"水"字）。
 * 注意：芯片换代时靶标会变，但样本类型是业务分类，与靶标无关，可稳定映射。
 */
const SAMPLE_TYPE_RULES = [
  [/水样|水龙头|洗碗机|洗手池|水池|直饮水|二次供水|末梢水|水箱|水杯水/, '水样'],
  [/餐具|餐盘|碗|筷|勺|杯子|工用具|刀具|案板|砧板/, '餐具/工用具涂抹样'],
  [/手部|手表面|手指|手套/, '手部涂抹样'],
  [/台面|操作台|冰箱|门把|地面|墙面|案板面|环境/, '环境涂抹样'],
  [/饭菜|食品|熟食|原料|留样|乳|肉|蛋|蔬菜|水果|米面|油/, '食品样本'],
]
export function classifySampleType(text) {
  const s = String(text || '')
  for (const [re, label] of SAMPLE_TYPE_RULES) {
    if (re.test(s)) return label
  }
  return '其他样本'
}
