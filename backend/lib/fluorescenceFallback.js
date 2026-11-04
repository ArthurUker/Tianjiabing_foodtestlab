/**
 * 荧光曲线兜底判读（2026-11-04）
 *
 * 用途：设备上报时 `CTList` **全部为空（"-"）** 的情况下，改用设备上传的
 *   `OptimizationDataLists`（每通道 45 个循环点的原始荧光）自行推算 Ct，
 *   避免"设备没传 Ct → 整条记录被判全阴 → 阳性漏报"。
 *
 * 算法来源：**只读参考**同服务器 rdpms 项目的 `chipAnalysis/judge.ts`
 *   （threshold-v1 / despike / shapeOf / firstCrossing / decide），
 *   ⚠️ 未对 rdpms 的代码做任何修改，仅按相同口径在本项目内独立实现。
 *
 * 口径（与 rdpms DEFAULT_PARAMS 一致）：
 *   baselineCycles = 12（但不超过数据长度的 1/3）｜ k = 10 ｜ cutoff = 40 ｜ shapeSigma = 3
 *   ① Hampel 去毛刺：窗口 5（i-2..i+2），MAD×1.4826，偏离 > 3×MAD 替换为窗口中位数
 *      （只处理内点；不复用"全局中位数"，那样会把整段 S 型上升抹平——2026-11-04 踩过坑）
 *   ② 基线 = 前 N 点均值 baseMean，σ = 总体标准差（除以 n）
 *   ③ 阈值 = baseMean + k·σ
 *   ④ Ct = 首个 > 阈值的循环（线性插值）
 *   ⑤ 形状校验：ΔF = max−baseMean ≥ 3σ 且 末点 ≥ baseMean + 5σ
 *   ⑥ 阳性 = Ct 存在 && Ct ≤ 40 && 形状校验通过
 *
 * ⚠️ 重要约束：推算结果**必须显式标注来源**（ctSource='fallback'），
 *   不得当作设备原始数据使用；同时在记录上打人工复核标记。
 */

/** 默认参数（与 rdpms chipAnalysis/judge.ts 的 DEFAULT_PARAMS 同口径） */
export const FALLBACK_PARAMS = {
  baselineCycles: 12,
  k: 10,
  cutoff: 40,
  shapeSigma: 3,
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
const sdPopulation = (a) => {
  if (a.length < 2) return 0
  const m = mean(a)
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length)
}

/**
 * Hampel 去毛刺（同 rdpms despike）：窗口 5，MAD×1.4826，只处理内点。
 * 不改原始数据，返回副本。
 */
export function despike(points = []) {
  const out = [...points]
  for (let i = 2; i < points.length - 2; i += 1) {
    const window = points.slice(i - 2, i + 3).slice().sort((a, b) => a - b)
    const median = window[2]
    const mad = window.map((v) => Math.abs(v - median)).sort((a, b) => a - b)[2] * 1.4826
    if (mad > 0 && Math.abs(points[i] - median) > 3 * mad) out[i] = median
  }
  return out
}

const smooth = (points, w = 5) => points.map((_, i) => {
  const from = Math.max(0, i - Math.floor(w / 2))
  const to = Math.min(points.length, i + Math.floor(w / 2) + 1)
  return mean(points.slice(from, to))
})

function shapeOf(points, baseline) {
  const baseMean = mean(baseline)
  const sigma = Math.max(sdPopulation(baseline), 1e-9)
  const deltaF = Math.max(...points) - baseMean
  return { baseMean, sigma, deltaF, endAbove: points[points.length - 1] >= baseMean + 5 * sigma }
}

function firstCrossing(points, threshold) {
  for (let i = 0; i < points.length; i += 1) {
    if (points[i] > threshold) {
      if (i === 0) return 1
      const span = points[i] - points[i - 1]
      return span === 0 ? i + 1 : i + (threshold - points[i - 1]) / span
    }
  }
  return null
}

function decide(ct, cutoff, shapeOk, method, threshold, noiseSigma, deltaF, extra = []) {
  const reasons = [...extra]
  if (ct == null) reasons.push('NO_CT')
  else if (ct > cutoff) reasons.push('CT_OVER_CUTOFF')
  if (!shapeOk) reasons.push('WEAK_AMPLIFICATION_SHAPE')
  const positive = ct != null && ct <= cutoff && shapeOk
  if (positive) reasons.push('PASS')
  return {
    ct,
    ctMethod: method,
    threshold,
    noiseSigma,
    deltaF,
    positive,
    confidence: positive ? 'HIGH' : 'LOW',
    reasons,
  }
}

/**
 * 单通道曲线判读（threshold-v1；另支持 rdpms 的 curvature-v1 / expfit-v1 供对照）。
 * @param {number[]} points 原始荧光序列（按循环顺序）
 * @param {'threshold-v1'|'curvature-v1'|'expfit-v1'} algorithm
 * @param {object} params 覆盖 FALLBACK_PARAMS
 */
export function judgeCurve(points = [], algorithm = 'threshold-v1', params = {}) {
  const p = { ...FALLBACK_PARAMS, ...params }
  const raw = (Array.isArray(points) ? points : []).map((v) => Number(v)).filter((v) => Number.isFinite(v))
  if (raw.length < 8) {
    return { ct: null, ctMethod: 'INSUFFICIENT_DATA', threshold: 0, noiseSigma: 0, deltaF: 0, positive: false, confidence: 'LOW', reasons: ['INSUFFICIENT_DATA'] }
  }
  const cleaned = despike(raw)
  const baseLen = Math.min(p.baselineCycles, Math.max(3, Math.floor(cleaned.length / 3)))
  const baseline = cleaned.slice(0, baseLen)
  const { sigma, deltaF, endAbove } = shapeOf(cleaned, baseline)
  const baseMean = mean(baseline)
  const threshold = baseMean + p.k * sigma
  const shapeOk = deltaF >= p.shapeSigma * sigma && endAbove

  if (algorithm === 'curvature-v1') {
    // 未过阈值说明没有真实扩增，不能仅凭二阶导给 Ct（平坦曲线曲率也非零）
    if (firstCrossing(cleaned, threshold) == null) {
      return decide(null, p.cutoff, shapeOk, 'MAX_CURVATURE', threshold, sigma, deltaF)
    }
    const sm = smooth(cleaned)
    let bestIndex = -1
    let best = 0
    for (let i = 1; i < sm.length - 1; i += 1) {
      const d2 = sm[i + 1] - 2 * sm[i] + sm[i - 1]
      if (d2 > best) { best = d2; bestIndex = i }
    }
    return decide(bestIndex < 0 ? null : bestIndex + 1, p.cutoff, shapeOk, 'MAX_CURVATURE', threshold, sigma, deltaF)
  }

  if (algorithm === 'expfit-v1') {
    // 阈值以上前 8 个点做指数拟合（平台期不参与）
    const indices = cleaned.map((v, i) => (v > threshold ? i : -1)).filter((i) => i >= 0).slice(0, 8)
    if (indices.length < 3) return decide(null, p.cutoff, shapeOk, 'EXP_FIT', threshold, sigma, deltaF)
    const xs = indices.map((i) => i + 1)
    const ys = indices.map((i) => Math.log(Math.max(cleaned[i], 1e-9)))
    const xMean = mean(xs)
    const yMean = mean(ys)
    const denominator = xs.reduce((s, x) => s + (x - xMean) ** 2, 0)
    const b = denominator === 0 ? 0 : xs.reduce((s, x, i) => s + (x - xMean) * (ys[i] - yMean), 0) / denominator
    const a = yMean - b * xMean
    const ct = b > 0 ? (Math.log(threshold) - a) / b : null
    const efficiency = b > 0 ? 10 ** b - 1 : null
    return decide(ct, p.cutoff, shapeOk, 'EXP_FIT', threshold, sigma, deltaF,
      efficiency == null ? [] : [`EFFICIENCY=${efficiency.toFixed(3)}`])
  }

  // threshold-v1（默认）：基线 + kσ，首个过阈循环 + 线性插值
  return decide(firstCrossing(cleaned, threshold), p.cutoff, shapeOk, 'THRESHOLD', threshold, sigma, deltaF)
}

/** 内参/内标/内控识别（与 lib/pathogenRisk.js 同口径，避免循环依赖在此重复声明） */
const INTERNAL_CONTROL_RE = /内标|内参|内控|internal\s*control|(^|[^a-z])ic([^a-z]|$)/i

/**
 * 对整张芯片的曲线做兜底判读。
 * @param {object} args
 * @param {Record<string, number[]>} args.optimizationDataLists 通道 → 荧光序列
 * @param {Record<string, string>} args.parms 通道 → 靶标名
 * @param {string} [args.algorithm]
 * @returns {{channels: Array, positives: Array, internalControl: object|null, internalControlFailed: boolean, hasAmplification: boolean}}
 */
export function analyzeFluorescence({ optimizationDataLists = {}, parms = {}, algorithm = 'threshold-v1' } = {}) {
  const channels = []
  for (const key of Object.keys(optimizationDataLists || {})) {
    const points = optimizationDataLists[key]
    if (!Array.isArray(points) || points.length < 8) continue
    const target = parms?.[key]
    // 未使用通道（靶标为 '-'）跳过：它们不是真实检测项
    if (!target || target === '-' || target === '—') continue
    const r = judgeCurve(points, algorithm)
    channels.push({
      channel: key,
      target,
      isInternalControl: INTERNAL_CONTROL_RE.test(String(target)),
      ...r,
    })
  }
  const ic = channels.find((c) => c.isInternalControl) || null
  const positives = channels.filter((c) => !c.isInternalControl && c.positive)
  return {
    channels,
    positives,
    internalControl: ic,
    // 内参未扩增 = 本次检测质控失败（说明书：内参基因作为提取/加样质控）
    internalControlFailed: ic ? !ic.positive : false,
    hasAmplification: positives.length > 0 || channels.some((c) => c.positive),
    algorithm,
    params: FALLBACK_PARAMS,
  }
}
