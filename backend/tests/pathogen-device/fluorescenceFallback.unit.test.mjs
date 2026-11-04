/**
 * 荧光曲线兜底判读（2026-11-04）
 * 算法口径与 rdpms chipAnalysis/judge.ts 一致（只读参考，未改其代码）：
 *   Hampel 去毛刺(窗口5, MAD×1.4826) → 基线前12点均值/σ → 阈值 baseMean+10σ
 *   → 首个过阈循环线性插值 → 形状校验(ΔF≥3σ 且 末点≥baseMean+5σ) → Ct≤40 判阳
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeCurve, analyzeFluorescence, despike, FALLBACK_PARAMS } from '../../lib/fluorescenceFallback.js'

/** 构造曲线：基线 base±jitter，从 riseStart 起按 factor 指数上升 */
function curve({ base = 100, jitter = 1, cycles = 45, riseStart = null, factor = 1.6 } = {}) {
  const out = []
  let v = base
  for (let i = 0; i < cycles; i += 1) {
    const noise = ((i * 37) % 7 - 3) * jitter // 确定性伪随机，避免测试抖动
    if (riseStart != null && i >= riseStart) v *= factor
    out.push(Number((v + noise).toFixed(1)))
  }
  return out
}

test('参数与 rdpms 同口径', () => {
  assert.equal(FALLBACK_PARAMS.baselineCycles, 12)
  assert.equal(FALLBACK_PARAMS.k, 10)
  assert.equal(FALLBACK_PARAMS.cutoff, 40)
  assert.equal(FALLBACK_PARAMS.shapeSigma, 3)
})

test('典型 S 型扩增 → 算出 Ct 且判阳', () => {
  const r = judgeCurve(curve({ riseStart: 25, factor: 1.6 }))
  assert.ok(r.ct != null, '应算出 Ct')
  assert.ok(r.ct > 20 && r.ct < 30, `Ct 应落在扩增起点附近，实际 ${r.ct}`)
  assert.equal(r.positive, true)
  assert.equal(r.ctMethod, 'THRESHOLD')
  assert.ok(r.reasons.includes('PASS'))
})

test('平坦曲线（无扩增）→ 不给 Ct，判阴', () => {
  const r = judgeCurve(curve({}))
  assert.equal(r.ct, null)
  assert.equal(r.positive, false)
  assert.ok(r.reasons.includes('NO_CT'))
})

test('上升但幅度不足（形状校验不通过）→ 判阴（防假阳性）', () => {
  // 只把末点抬高一点点：ΔF 远小于 3σ
  const pts = curve({})
  pts[pts.length - 1] += 3
  const r = judgeCurve(pts)
  assert.equal(r.positive, false)
})

test('Ct 超过 cutoff(40) → 不判阳', () => {
  const r = judgeCurve(curve({ riseStart: 41, factor: 1.5 }))
  assert.equal(r.positive, false)
})

test('Hampel 去毛刺不破坏整段 S 上升（2026-11-04 回归：全局中位数会抹平曲线）', () => {
  const rising = Array.from({ length: 45 }, (_, i) => (i < 20 ? 100 : 100 * 1.5 ** (i - 19)))
  const cleaned = despike(rising)
  // 上升段（内点）应保持单调不减的形态，末点不得被压回基线
  assert.ok(cleaned[cleaned.length - 2] > 100, '倒数第二点不应被抹平')
  assert.ok(Math.abs(cleaned[44] - rising[44]) < 1e-6 || cleaned[44] > 100, '末点不应被替换为基线')
  // 孤立尖刺应被抹掉
  const spiked = curve({})
  spiked[10] += 5000
  const fixed = despike(spiked)
  assert.ok(Math.abs(fixed[10] - spiked[10]) > 1, '孤立尖刺应被替换')
})

test('整芯片判读：内参未扩增不再判「质控失败」（环境样本不要求内参）；靶标扩增仍计入阳性', () => {
  const r = analyzeFluorescence({
    optimizationDataLists: {
      'FAM-1': curve({}),                        // 内参：平线（未扩增）
      'CY5-6': curve({ riseStart: 28, factor: 1.55 }), // 大肠埃希氏菌：有扩增
      'FAM-3': curve({}),                        // 阴性靶标
      'FAM-7': curve({}),                        // 未使用通道（parms='-'）
    },
    parms: { 'FAM-1': '内参', 'CY5-6': '大肠埃希氏菌', 'FAM-3': '札如', 'FAM-7': '-' },
  })
  assert.equal(r.channels.length, 3, '未使用通道（靶标 "-"）应被跳过')
  // 2026-11-04 口径：环境样本不要求内参扩增 → 不得据此判质控失败（字段已移除）
  assert.equal(r.internalControlFailed, undefined, '不应再输出质控失败判定')
  assert.equal(r.positives.length, 1)
  assert.equal(r.positives[0].target, '大肠埃希氏菌')
  assert.ok(r.positives[0].ct != null)
})

test('整芯片判读：内参正常 + 靶标扩增 → 质控通过', () => {
  const r = analyzeFluorescence({
    optimizationDataLists: {
      'FAM-1': curve({ riseStart: 20, factor: 1.5 }),
      'FAM-2': curve({ riseStart: 30, factor: 1.5 }),
    },
    parms: { 'FAM-1': '内参', 'FAM-2': '轮状' },
  })
  assert.ok(r.internalControl && r.internalControl.positive, '内参扩增应如实返回判读结果')
  assert.equal(r.positives.length, 1)
  assert.equal(r.positives[0].target, '轮状')
})

test('数据不足（点数 < 8）→ INSUFFICIENT_DATA，不抛错', () => {
  const r = judgeCurve([1, 2, 3])
  assert.equal(r.ct, null)
  assert.equal(r.ctMethod, 'INSUFFICIENT_DATA')
  assert.equal(judgeCurve([]).positive, false)
})

/* ───────── 集成：整条报文 CT 全空 → 兜底判阳 + 复核标记 ───────── */
import { validateUploadPayload, buildPathogenRecordPayload } from '../../lib/pathogenDevice.js'

function buildRaw({ chip = 'CHIP-FB-001', ctAllEmpty = true } = {}) {
  const ct = (v) => (ctAllEmpty ? '-' : v)
  return {
    DeviceNo: 'DEV-FB-1',
    DetectionDateTime: '2026-11-04 10:11:31',
    DetectionEndDateTime: '2026-11-04 11:45:05',
    SampleStr: '三食堂洗碗机水样',
    DetectionPeopleStr: '李丹',
    DetectionNumber: '01',
    FileName: 'fb.vhfl',
    ChipName: '食源性8项病原体检测',
    ChipNumber: chip,
    Parms: { 'FAM-1': '内参', 'FAM-2': '轮状', 'CY5-6': '大肠埃希氏菌', 'ROX-8': '-' },
    OptimizationDataLists: {
      'FAM-1': curve({}),                        // 内参：平线（环境样本允许，不判失败）
      'FAM-2': curve({}),                        // 阴性
      'CY5-6': curve({ riseStart: 30, factor: 1.5 }), // 有扩增
      'ROX-8': curve({}),                        // 未使用通道
    },
    ResultList: { 'FAM-1': false, 'FAM-2': false, 'CY5-6': false, 'ROX-8': false },
    CTList: { 'FAM-1': ct('26.0'), 'FAM-2': ct('-'), 'CY5-6': ct('33.63'), 'ROX-8': ct('-') },
  }
}

test('集成：CT 全空 + 曲线有扩增 → 兜底算出 Ct 并判阳，打两条复核标记', () => {
  const v = validateUploadPayload(buildRaw())
  assert.equal(v.ok, true, JSON.stringify(v))
  const built = buildPathogenRecordPayload({ payload: v.data, deviceNo: 'DEV-FB-1', canteens: ['三食堂'], defaultCanteen: null })
  assert.equal(built.ok, true, JSON.stringify(built))
  const d = built.data

  // 兜底算出阳性（设备报文里该通道判读为 false / Ct='-'）
  assert.match(d.positiveItems, /大肠埃希氏菌/)
  const item = d.allTestItems.find((x) => x.pathogen === '大肠埃希氏菌')
  assert.equal(item.result, '阳性')
  assert.equal(item.ctSource, 'fallback', '推算的 Ct 必须显式标注来源')
  assert.ok(parseFloat(item.ct) > 25 && parseFloat(item.ct) < 40, `Ct 应落在 25~40，实际 ${item.ct}`)

  // 两条复核标记
  const types = d.reviewFlags.map((f) => f.type)
  assert.ok(types.includes('ct_fallback_computed'), '应标记"设备未上传 Ct，已兜底推算"')
  assert.equal(types.includes('internal_control_failed'), false, '内参未扩增不得再产生质控失败标记')
  const fbFlag = d.reviewFlags.find((f) => f.type === 'ct_fallback_computed')
  assert.match(fbFlag.hint, /系统推算值/)
  assert.ok(d.fallbackAnalysis && d.fallbackAnalysis.algorithm === 'threshold-v1')

  // 未使用通道（ROX-8, 靶标 '-'）不产生检测项
  assert.equal(d.allTestItems.some((x) => x.channel === 'ROX-8'), false)
})

test('集成：设备已上传 Ct → 不触发兜底（保持设备口径）', () => {
  const v = validateUploadPayload(buildRaw({ ctAllEmpty: false }))
  const built = buildPathogenRecordPayload({ payload: v.data, deviceNo: 'DEV-FB-1', canteens: ['三食堂'], defaultCanteen: null })
  assert.equal(built.ok, true)
  assert.equal(built.data.fallbackAnalysis, undefined, '有设备 Ct 时不得兜底')
  assert.equal(built.data.reviewFlags.some((f) => f.type === 'ct_fallback_computed'), false)
  // 设备 Ct=33.63 且判读 false → 仍按设备口径（阳性项不含大肠埃希氏菌）
  const item = built.data.allTestItems.find((x) => x.pathogen === '大肠埃希氏菌')
  assert.equal(item.ctSource, undefined)
})
