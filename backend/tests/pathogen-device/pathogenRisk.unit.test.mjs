/**
 * 病原体结果归一化（2026-11-03，设备口径为唯一实现）
 * 覆盖：判读用词统一 / 内参识别 / 风险分档单一实现 / 样本类型分类 / 未使用通道跳过
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeJudgement,
  calcRisk,
  normalizePathogenResult,
  classifySampleType,
  INTERNAL_CONTROL_RE,
} from '../../lib/pathogenRisk.js'
import { validateUploadPayload, buildPathogenRecordPayload } from '../../lib/pathogenDevice.js'

test('判读用词归一：未检出/阴性/- → 阴性；阳性/+/(+) → 阳性', () => {
  assert.equal(normalizeJudgement('未检出'), '阴性')
  assert.equal(normalizeJudgement('阴性'), '阴性')
  assert.equal(normalizeJudgement('-'), '阴性')
  assert.equal(normalizeJudgement(null), '阴性')
  assert.equal(normalizeJudgement(false), '阴性')
  assert.equal(normalizeJudgement('阳性'), '阳性')
  assert.equal(normalizeJudgement('+'), '阳性')
  assert.equal(normalizeJudgement('(+)'), '阳性')
  assert.equal(normalizeJudgement(true), '阳性')
})

test('内参识别：内参/内标/内控/IC 都算内参', () => {
  for (const n of ['内参', '内标', '内控', 'Internal Control', 'IC']) {
    assert.equal(INTERNAL_CONTROL_RE.test(n), true, n)
  }
  assert.equal(INTERNAL_CONTROL_RE.test('沙门氏菌'), false)
})

test('风险分档（唯一实现）：<20 高 / <30 中 / <35 低 / ≥35 极低，且内参不计阳性', () => {
  const mk = (name, result, ct) => ({ pathogen: name, channel: 'FAM-1', result, ctRaw: ct })
  assert.equal(calcRisk([mk('ORF1ab', '阴性', '-')]).riskLevel, '无风险')
  assert.equal(calcRisk([mk('内标', '阳性', '20.0')]).riskLevel, '无风险', '内参阳性不算风险')
  assert.equal(calcRisk([mk('ORF1ab', '阳性', '15.2')]).riskLevel, '高风险')
  assert.equal(calcRisk([mk('ORF1ab', '阳性', '25.3')]).riskLevel, '中风险')
  assert.equal(calcRisk([mk('ORF1ab', '阳性', '31.0')]).riskLevel, '低风险')
  assert.equal(calcRisk([mk('ORF1ab', '阳性', '36.4')]).riskLevel, '极低风险')
  // 多阳性取最小 Ct
  const r = calcRisk([mk('A', '阳性', '31.0'), mk('B', '阳性', '22.1')])
  assert.equal(r.riskLevel, '中风险')
  assert.equal(r.minCt, 22.1)
  assert.match(r.positiveItemsDisplay, /B\(Ct:22.1\)/)
})

test('结果归一：判读词统一 + 内参标记 + 阳性项/风险重算 + 内参状态统一文案', () => {
  const rd = {
    allTestItems: [
      { no: 1, pathogen: '内标', channel: 'CY5-1', result: '未检出', ct: '-' },
      { no: 2, pathogen: '诺如GII', channel: 'HEX-5', result: '阳性', ct: '35.43' },
      { no: 3, pathogen: '沙门氏菌', channel: 'FAM-2', result: '未检出', ct: '-' },
    ],
    positiveItems: '旧值',
    riskLevel: '未知',
  }
  const out = normalizePathogenResult(rd)
  assert.deepEqual(out.allTestItems.map((x) => x.result), ['阴性', '阳性', '阴性'])
  assert.equal(out.allTestItems[0].isInternalControl, true, '内标应被标记为内参')
  assert.equal(out.positiveItems, '诺如GII(Ct:35.43)')
  assert.equal(out.riskLevel, '极低风险')
  assert.equal(out.internalControlStatus, '内参: 阴性', '内参状态统一为「内参: 阴性/阳性」')
})

test('样本类型分类：按关键词而非只认"水"字', () => {
  assert.equal(classifySampleType('洗碗机水样'), '水样')
  assert.equal(classifySampleType('一食堂 水样'), '水样')
  assert.equal(classifySampleType('二食堂 餐盘涂抹样'), '餐具/工用具涂抹样')
  assert.equal(classifySampleType('饭菜样本'), '食品样本')
  assert.equal(classifySampleType('操作台面涂抹'), '环境涂抹样')
  assert.equal(classifySampleType('手部涂抹样'), '手部涂抹样')
  assert.equal(classifySampleType('随便写的'), '其他样本')
})

test('设备报文：未使用通道（Parms = "-"）不生成检测项，但原始报文仍完整保留', () => {
  const raw = {
    DeviceNo: 'D-1',
    DetectionDateTime: '2026-11-03 09:00:00',
    DetectionEndDateTime: '2026-11-03 09:30:00',
    SampleStr: '一食堂 洗碗机水样',
    DetectionPeopleStr: '张三',
    DetectionNumber: '1',
    FileName: 'x.vhfl',
    ChipName: '四通道微流控芯片',
    ChipNumber: 'CHIP-1',
    Parms: { 'FAM-1': '内参', 'FAM-2': '诺如', 'FAM-3': '-', 'ROX-1': '-', 'ROX-2': '沙门氏菌' },
    OptimizationDataLists: {},
    ResultList: { 'FAM-1': true, 'FAM-2': false, 'FAM-3': false, 'ROX-1': false, 'ROX-2': false },
    CTList: { 'FAM-1': '26.0', 'FAM-2': '-', 'FAM-3': '-', 'ROX-1': '-', 'ROX-2': '-' },
  }
  const v = validateUploadPayload(raw)
  assert.equal(v.ok, true, JSON.stringify(v))
  const built = buildPathogenRecordPayload({ payload: v.data, deviceNo: 'D-1', canteens: ['一食堂'], defaultCanteen: null })
  assert.equal(built.ok, true, JSON.stringify(built))
  assert.equal(built.data.allTestItems.length, 3, '5 个通道中 2 个是占位（"-"），应只保留 3 项')
  assert.deepEqual(built.data.allTestItems.map((x) => x.pathogen), ['内参', '诺如', '沙门氏菌'])
  assert.equal(built.data.sampleType, '水样', '样本类型按关键词分类')
  // 原始报文快照不丢通道
  assert.equal(Object.keys(built.data.rawDetection.parms).length, 5)
})
