// 病原体设备自动采集（VirusHunter2.0B）路由级单测（无 DB）：
//   协议校验口径 / 风险计算 / 食堂识别 / 记录映射 / 幂等 record_code /
//   上传接口鉴权与归属链（缺失/无效密钥、停用、设备编号不一致、学校缺失、重复上传、正常入库）/
//   超管 CRUD 归一（device_no 唯一与不可变、学校与绑定用户引用完整性、密钥不明文返回）。
//
// 说明：走「路由 handler 直接调用」（与 tests/friendly-links/friendlyLinkRoutes.unit.test.mjs 同范式），
//   不连数据库、不发 HTTP；租户客户端经 tenantClientFactory 注入内存桩。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPathogenDeviceUploadRoutes,
  createAdminPathogenDeviceRoutes,
} from '../../routes/pathogenDeviceRoutes.js'
import {
  validateUploadPayload,
  calculateDeviceRisk,
  matchSchoolCanteen,
  buildPathogenRecordPayload,
  deviceRecordCode,
  chipRecordCode,
  detectionFingerprint,
  normalizeChipNumber,
  buildCaseKey,
  isSameCase,
  generateDeviceKey,
  hashDeviceKey,
  extractDeviceKey,
  parseDetectionDateTime,
  toBusinessDateStr,
} from '../../lib/pathogenDevice.js'

// ───────────────────────── 测试脚手架 ─────────────────────────

/** 取出 router 上指定 method+path 的最终 handler（跳过中间件）。 */
function handlerOf(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle
    }
  }
  throw new Error(`路由未找到：${method.toUpperCase()} ${routePath}`)
}

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {}, ended: false,
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
    set(k, v) { this.headers[k] = v; return this },
    end() { this.ended = true; return this },
  }
}

/** 构造一份合法上报报文（可局部覆盖）。 */
function makePayload(overrides = {}) {
  return {
    DeviceNo: 'VH-2B-001',
    DetectionDateTime: '2026-09-17 08:30:00',
    DetectionEndDateTime: '2026-09-17 10:45:00',
    SampleStr: '二食堂 餐盘涂抹样 汤胜亮',
    DetectionPeopleStr: '张三',
    DetectionNumber: '20260917001',
    FileName: '20260917_0830_1045_二食堂.vhfl',
    ChipID: 'TS001',
    ChipName: '四通道微流控芯片',
    ChipNumber: 'SN20260917001',
    Parms: { 'FAM-1': 'ORF1ab', 'FAM-2': 'N', 'HEX-1': '内参' },
    OptimizationDataLists: { 'FAM-1': [0.12, 0.45, 0.89], 'FAM-2': [0.08, 0.32, 0.77], 'HEX-1': [0.1, 0.4, 0.8] },
    ResultList: { 'FAM-1': true, 'FAM-2': false, 'HEX-1': true },
    CTList: { 'FAM-1': '25.3', 'FAM-2': '-', 'HEX-1': '28.7' },
    ...overrides,
  }
}

/** 上传面内存桩 prisma + 租户桩。 */
function makeUploadStubs({ device, platformKey = null, school = { code: 'school-a', status: 'active' }, canteens = ['一食堂', '二食堂'], tenantUser = { id: 'u-1', status: 'active' }, existingRecord = null, existingRecords = [] } = {}) {
  const key = generateDeviceKey()
  const row = {
    id: 'dev-1',
    device_no: 'VH-2B-001',
    school_code: 'school-a',
    binding_user_id: 'u-1',
    default_canteen: null,
    status: 'active',
    rate_limit_per_min: 60,
    ip_whitelist: null,
    upload_count: 0,
    last_used_at: null,
    last_upload_at: null,
    ...(device || {}),
    key_hash: device?.key_hash || key.hash,
  }
  const created = []
  const pkUpdates = []
  const prisma = {
    pathogenDevice: {
      async findUnique({ where }) {
        if (where.key_hash && where.key_hash !== row.key_hash) return null
        if (where.device_no && where.device_no !== row.device_no) return null
        return row
      },
      async update({ data }) { Object.assign(row, data); return row },
    },
    // 统一上传密钥桩（B 方案）：仅 key_hash 命中 active 行时被路由采用
    pathogenUploadKey: {
      async findUnique({ where }) {
        if (!platformKey) return null
        return where.key_hash === platformKey.key_hash ? platformKey : null
      },
      async update({ data }) { Object.assign(platformKey, data); pkUpdates.push(data); return platformKey },
    },
    school: { async findUnique() { return school } },
    schoolCustomization: { async findUnique() { return { canteens } } },
    systemLog: { async create() { return { id: 'log-1' } } },
  }
  const stored = [...(existingRecord ? [existingRecord] : []), ...existingRecords] // 已入库记录（供芯片/档案检索）
  const updated = []
  const tenant = {
    user: { async findUnique() { return tenantUser } },
    testRecord: {
      async findUnique({ where }) {
        return stored.find((r) => r.record_code === where.record_code) || null
      },
      /** 支持路由用到的 Prisma JSON 路径过滤（chip.number / canteen / sampleType）+ created_at 倒序 */
      async findMany({ where = {}, orderBy, take } = {}) {
        const pathEq = (obj, path, val) => {
          let cur = obj
          for (const p of path) { cur = cur?.[p] }
          return cur === val
        }
        const hit = stored
          .filter((r) => (where.test_type ? r.test_type === where.test_type : true))
          .filter((r) => {
            if (where.result_data?.path) return pathEq(r.result_data, where.result_data.path, where.result_data.equals)
            if (where.sample_info?.path) return pathEq(r.sample_info, where.sample_info.path, where.sample_info.equals)
            return true
          })
          .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        void orderBy
        return typeof take === 'number' ? hit.slice(0, take) : hit
      },
      async findFirst(args = {}) {
        const list = await this.findMany(args)
        return list[0] || null
      },
      async update({ where, data }) {
        const r = stored.find((x) => x.id === where.id)
        if (!r) throw new Error('not found')
        Object.assign(r, data)
        updated.push({ id: where.id, data })
        return r
      },
      async create({ data }) {
        const rec = { id: 'rec-new', created_at: new Date().toISOString(), ...data }
        created.push(rec)
        stored.push(rec)
        return rec
      },
    },
    auditLog: { async create() { return { id: 'audit-1' } } },
  }
  const tenantClientFactory = (p, schoolCode) => {
    assert.equal(schoolCode, 'school-a')
    void p
    return tenant
  }
  return { prisma, tenant, created, updated, stored, plainKey: key.plain, row, tenantClientFactory, pkUpdates }
}

async function invokeUpload({ prisma, tenantClientFactory, body, apiKey, ip = '127.0.0.1' }) {
  const router = createPathogenDeviceUploadRoutes({ prisma, tenantClientFactory })
  const handler = handlerOf(router, 'post', '/upload')
  const res = makeRes()
  const headers = {}
  if (apiKey) headers['x-api-key'] = apiKey
  await handler({
    ip, originalUrl: '/api/open/pathogen-device/upload', headers,
    get(name) { return headers[String(name).toLowerCase()] || null },
    body,
  }, res)
  return res
}

// ───────────────────────── lib：协议校验 ─────────────────────────

test('协议校验：合法报文通过并归一（时间解析 / 点位按 Parms）', () => {
  const r = validateUploadPayload(makePayload())
  assert.equal(r.ok, true)
  assert.equal(r.data.deviceNo, 'VH-2B-001')
  assert.equal(r.data.points.length, 3)
  assert.equal(r.data.points[0].name, 'ORF1ab')
  assert.equal(r.data.points[0].positive, true)
  assert.equal(r.data.points[1].ctRaw, '-')
})

test('协议校验：必填缺失逐个报错（对齐厂商文档口径）', () => {
  const cases = [
    ['DetectionNumber', 'DetectionNumber不能为空'],
    ['SampleStr', 'SampleStr不能为空'],
    ['DetectionPeopleStr', 'DetectionPeopleStr不能为空'],
    ['FileName', 'FileName不能为空'],
    ['ChipName', 'ChipName不能为空'],
    ['ChipNumber', 'ChipNumber不能为空'],
  ]
  for (const [field, msg] of cases) {
    const body = makePayload()
    delete body[field]
    const r = validateUploadPayload(body)
    assert.equal(r.ok, false, `${field} 应被拒绝`)
    assert.ok(r.message.includes(msg), `${field} 错误信息应包含 ${msg}，实际：${r.message}`)
  }
})

test('协议校验：时间格式与先后顺序', () => {
  assert.equal(validateUploadPayload(makePayload({ DetectionDateTime: '17/09/2026' })).ok, false)
  assert.equal(validateUploadPayload(makePayload({ DetectionDateTime: '2026-02-30 10:00:00' })).ok, false)
  const r = validateUploadPayload(makePayload({ DetectionEndDateTime: '2026-09-17 07:00:00' }))
  assert.equal(r.ok, false)
  assert.ok(r.message.includes('早于'))
  assert.equal(validateUploadPayload(makePayload({ DetectionDateTime: '2026-09-17T08:30:00' })).ok, true)
})

test('协议校验：点位结构与 ResultList/CTList 覆盖', () => {
  assert.ok(validateUploadPayload(makePayload({ Parms: { 'FAM-9': 'X' } })).message.includes('不合法'))
  assert.ok(validateUploadPayload(makePayload({ ResultList: { 'FAM-1': true } })).message.includes('缺少点位 FAM-2'))
  assert.ok(validateUploadPayload(makePayload({ CTList: {} })).message.includes('CTList'))
  assert.ok(validateUploadPayload(makePayload({ OptimizationDataLists: { 'FAM-1': ['x'] } })).message.includes('数字数组'))
  assert.equal(validateUploadPayload(makePayload({ OptimizationDataLists: {} })).ok, true)
})

test('协议校验：业务日期展示串', () => {
  const dt = parseDetectionDateTime('2026-09-17 08:30:00')
  assert.equal(toBusinessDateStr(dt), '2026-09-17')
})

// ───────────────────────── lib：风险与食堂 ─────────────────────────

test('风险计算：全阴性=无风险；阳性按 Ct 分档；内参不计阳性', () => {
  const pts = (list) => list.map(([key, name, positive, ctRaw]) => ({ key, name, positive, ctRaw }))
  assert.equal(calculateDeviceRisk(pts([['FAM-1', 'N', false, '-']])).riskLevel, '无风险')
  assert.equal(calculateDeviceRisk(pts([['HEX-1', '内参', true, '20.0']])).riskLevel, '无风险')
  assert.equal(calculateDeviceRisk(pts([['FAM-1', 'ORF1ab', true, '15.2']])).riskLevel, '高风险')
  assert.equal(calculateDeviceRisk(pts([['FAM-1', 'ORF1ab', true, '25.3']])).riskLevel, '中风险')
  assert.equal(calculateDeviceRisk(pts([['FAM-1', 'ORF1ab', true, '31.0']])).riskLevel, '低风险')
  assert.equal(calculateDeviceRisk(pts([['FAM-1', 'ORF1ab', true, '36.0']])).riskLevel, '极低风险')
  const r = calculateDeviceRisk(pts([['FAM-1', 'ORF1ab', true, '25.3'], ['FAM-2', 'N', true, '18.0']]))
  assert.equal(r.positiveDetails.length, 2)
  assert.equal(r.minCt, 18.0)
  assert.ok(r.positiveItemsDisplay.includes('ORF1ab(Ct:25.3)'))
})

test('食堂识别：精确 + 别名（第2食堂/全角）匹配，未命中返回 null', () => {
  const canteens = ['一食堂', '二食堂', '三食堂']
  assert.equal(matchSchoolCanteen('二食堂 餐盘', canteens), '二食堂')
  assert.equal(matchSchoolCanteen('第2食堂 涂抹', canteens), '二食堂')
  assert.equal(matchSchoolCanteen('２号食堂', canteens), '二食堂')
  assert.equal(matchSchoolCanteen('操场直饮水', canteens), null)
})

test('记录映射：食堂不可识别且无默认食堂 → 拒绝（不写未知食堂）', () => {
  const v = validateUploadPayload(makePayload({ SampleStr: '操场直饮水 王五' }))
  const built = buildPathogenRecordPayload({ payload: v.data, deviceNo: 'VH-2B-001', canteens: ['一食堂', '二食堂'], defaultCanteen: null })
  assert.equal(built.ok, false)
  assert.equal(built.code, 'CANTEEN_UNRESOLVED')
})

test('记录映射：与手动导入同构（三键 / 检测项 / 溯源键）', () => {
  const v = validateUploadPayload(makePayload())
  const built = buildPathogenRecordPayload({ payload: v.data, deviceNo: 'VH-2B-001', canteens: ['一食堂', '二食堂'], defaultCanteen: '一食堂' })
  assert.equal(built.ok, true)
  const d = built.data
  assert.equal(d.testDate, '2026-09-17')
  assert.equal(d.canteen, '二食堂')
  assert.equal(d.inspector, '张三')
  assert.equal(d.sampleId, '20260917001')
  assert.equal(d.riskLevel, '中风险')
  assert.equal(d.allTestItems.length, 3)
  assert.equal(d.allTestItems[2].isInternalControl, true)
  assert.equal(d.source, 'device')
  assert.equal(d.deviceNo, 'VH-2B-001')
  assert.equal(d.rawDetection.resultList['FAM-1'], true)
})

test('幂等 record_code：同设备+同样本稳定，跨设备/跨样本不同', () => {
  const a = deviceRecordCode('VH-2B-001', '20260917001')
  const b = deviceRecordCode('VH-2B-001', '20260917001')
  const c = deviceRecordCode('VH-2B-002', '20260917001')
  const d = deviceRecordCode('VH-2B-001', '20260917002')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.notEqual(a, d)
  assert.match(a, /^RC-pathogen-[0-9a-f]{64}$/)
})

test('设备密钥：前缀 / 哈希往返 / 请求头提取', () => {
  const k = generateDeviceKey()
  assert.match(k.plain, /^pdv_/)
  assert.equal(hashDeviceKey(k.plain), k.hash)
  assert.equal(extractDeviceKey({ get: (n) => (n === 'x-api-key' ? k.plain : null) }), k.plain)
  assert.equal(extractDeviceKey({ get: (n) => (n === 'authorization' ? `Bearer ${k.plain}` : null) }), k.plain)
  assert.equal(extractDeviceKey({ get: () => null }), null)
})

// ───────────────────────── 上传接口：鉴权与归属链 ─────────────────────────

test('上传：未携带密钥 → 401 MISSING_KEY', async () => {
  const { prisma, tenantClientFactory } = makeUploadStubs()
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: null })
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.code, 'MISSING_KEY')
})

test('上传：密钥无效 → 401 INVALID_KEY', async () => {
  const { prisma, tenantClientFactory } = makeUploadStubs()
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: 'pdv_wrong' })
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.code, 'INVALID_KEY')
})

test('上传：设备停用 → 403 DEVICE_DISABLED', async () => {
  const { prisma, tenantClientFactory, plainKey } = makeUploadStubs({ device: { status: 'disabled', disabled_at: new Date() } })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: plainKey })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'DEVICE_DISABLED')
})

test('上传：报文 DeviceNo 与密钥设备不一致 → 403 DEVICE_MISMATCH（跨校冒用防护）', async () => {
  const { prisma, tenantClientFactory, plainKey } = makeUploadStubs()
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload({ DeviceNo: 'VH-2B-999' }), apiKey: plainKey })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'DEVICE_MISMATCH')
})

test('上传：参数格式错误 → 400 且不落库', async () => {
  const { prisma, tenantClientFactory, plainKey, created } = makeUploadStubs()
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload({ DetectionNumber: '' }), apiKey: plainKey })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'VALIDATION_ERROR')
  assert.ok(res.body.message.includes('DetectionNumber不能为空'))
  assert.equal(created.length, 0)
})

test('上传：归属学校不存在 → 409 SCHOOL_NOT_FOUND', async () => {
  const { prisma, tenantClientFactory, plainKey } = makeUploadStubs({ school: null })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: plainKey })
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'SCHOOL_NOT_FOUND')
})

test('上传：食堂不可识别且无默认食堂 → 422 CANTEEN_UNRESOLVED', async () => {
  const { prisma, tenantClientFactory, plainKey } = makeUploadStubs()
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload({ SampleStr: '操场直饮水 王五' }), apiKey: plainKey })
  assert.equal(res.statusCode, 422)
  assert.equal(res.body.code, 'CANTEEN_UNRESOLVED')
})

/** 构造一条「已入库」的设备记录（与报文同内容时内容指纹一致，供芯片/档案判定用例）。 */
function makeStoredRecord({ payload = makePayload(), recordCode = null, reviewFlags = [], rounds = [], created_at = '2026-09-17T00:00:00.000Z', id = 'rec-old' } = {}) {
  const v = validateUploadPayload(payload)
  const built = buildPathogenRecordPayload({ payload: v.data, deviceNo: 'VH-2B-001', canteens: ['一食堂', '二食堂'], defaultCanteen: null })
  return {
    id,
    record_code: recordCode || chipRecordCode(v.data.chipNumber),
    created_at,
    test_type: 'pathogen',
    sample_info: { testDate: built.data.testDate, canteen: built.data.canteen, inspector: built.data.inspector },
    result_data: { ...built.data, reviewFlags, recheckReports: rounds },
  }
}

test('芯片语义：同芯片 + 内容一致 → 幂等放行（同一 reportId、不新建记录）', async () => {
  const stored = makeStoredRecord()
  const { prisma, tenantClientFactory, plainKey, created } = makeUploadStubs({ existingRecord: stored })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: plainKey })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.code, 0)
  assert.equal(res.body.data.duplicated, true)
  assert.equal(res.body.data.reportId, stored.record_code)
  assert.equal(created.length, 0)
})

test('芯片语义：同芯片 + 内容不一致 → 409 CHIP_REVIEW_REQUIRED「请人工复核」+ 打复核标记 + 不改检测数据', async () => {
  const stored = makeStoredRecord()
  const { prisma, tenantClientFactory, plainKey, created, stored: all } = makeUploadStubs({ existingRecord: stored })
  // 同芯片、同编号，但 CT 不同（18.0 vs 25.3）→ 内容不一致
  const res = await invokeUpload({
    prisma, tenantClientFactory, plainKey,
    body: makePayload({ CTList: { 'FAM-1': '18.0', 'FAM-2': '-', 'HEX-1': '28.7' } }),
    apiKey: plainKey,
  })
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'CHIP_REVIEW_REQUIRED')
  assert.match(res.body.message, /请人工复核/)
  assert.equal(res.body.data.reviewRequired, true)
  assert.equal(res.body.data.reportId, stored.record_code)
  assert.equal(created.length, 0)
  const flags = all[0].result_data.reviewFlags
  assert.equal(flags.length, 1)
  assert.equal(flags[0].type, 'chip_duplicate')
  assert.equal(flags[0].chip_number, 'SN20260917001')
  assert.equal(flags[0].attempted_sample_id, '20260917001')
  // 原检测数据不被改写
  assert.equal(all[0].result_data.rawDetection.ctList['FAM-1'], '25.3')
})

test('档案语义：同样本编号 + 新芯片（同日）→ 并入为复测轮次（round 2、检测次数 +1、结论以新轮次为准）', async () => {
  const stored = makeStoredRecord() // 父记录 = 第 1 轮（ORF1ab 阳性 Ct25.3 → 中风险）
  const { prisma, tenantClientFactory, plainKey, created, stored: all } = makeUploadStubs({ existingRecord: stored })
  const second = makePayload({
    ChipNumber: 'SN20260917002',       // 第二张芯片（同一样本复测）
    // 样本编号保持一致：同一档案的身份 = 食堂+样本类型+样本描述+**样本编号**+设备
    CTList: { 'FAM-1': '-', 'FAM-2': '-', 'HEX-1': '27.9' },
    ResultList: { 'FAM-1': false, 'FAM-2': false, 'HEX-1': true },
  })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: second, apiKey: plainKey })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.appended, true)
  assert.equal(res.body.data.round, 2)
  assert.equal(res.body.data.reportId, stored.record_code)
  assert.equal(created.length, 0) // 不新建记录
  const rd = all[0].result_data
  assert.equal(rd.recheckReports.length, 1)
  assert.equal(rd.recheckReports[0].roundNo, 2)
  assert.equal(rd.recheckReports[0].roundLabel, '第 2 次检测（复测）')
  assert.equal(rd.recheckReports[0].chipNumber, 'SN20260917002')
  assert.equal(rd.recheckReports[0].sampleId, '20260917001')
  assert.equal(rd.recheckReports[0].source, 'device')
  // 结论以最新轮次为准（与手动复检 TD-Recheck-Sync 同口径）
  assert.equal(rd.finalStatus, '复检通过')
  assert.equal(rd.riskLevel, '无风险')
  assert.equal(rd.positiveItems, '无')
  assert.equal(rd.result, '合格')
  assert.equal(rd.modificationLogs[0].action, '设备复测轮次入库')
  assert.match(rd.modificationLogs[0].content, /第 2 次检测（复测）/)
})

test('档案语义：第三轮继续并入（round 3），且轮次按新在前排列', async () => {
  const stored = makeStoredRecord({ rounds: [{ source: 'device', roundNo: 2, chipNumber: 'SN-X2' }] })
  const { prisma, tenantClientFactory, plainKey, stored: all } = makeUploadStubs({ existingRecord: stored })
  const third = makePayload({ ChipNumber: 'SN20260917003' }) // 同样本编号 + 第三张芯片
  const res = await invokeUpload({ prisma, tenantClientFactory, body: third, apiKey: plainKey })
  assert.equal(res.body.data.round, 3)
  const rounds = all[0].result_data.recheckReports
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0].roundNo, 3)
  assert.equal(rounds[1].roundNo, 2)
})

test('档案语义：同样本编号但超出时间窗（>7 天）→ 不并入，新建独立记录', async () => {
  const stored = makeStoredRecord() // 检测日期 2026-09-17
  const { prisma, tenantClientFactory, plainKey, created } = makeUploadStubs({ existingRecord: stored })
  const later = makePayload({
    ChipNumber: 'SN20261015009',
    // 样本编号保持一致，仅日期超出窗口 → 唯一拦截因素应是时间窗
    DetectionDateTime: '2026-10-15 08:30:00',
    DetectionEndDateTime: '2026-10-15 10:45:00',
  })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: later, apiKey: plainKey })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.appended, undefined)
  assert.equal(created.length, 1)
  assert.equal(created[0].record_code, chipRecordCode('SN20261015009'))
})

test('档案语义：同食堂但样本描述不同 → 不并入（视为不同样本，新建）', async () => {
  const stored = makeStoredRecord()
  const { prisma, tenantClientFactory, plainKey, created } = makeUploadStubs({ existingRecord: stored })
  const other = makePayload({ ChipNumber: 'SN20260917005', SampleStr: '二食堂 操作台面涂抹样' })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: other, apiKey: plainKey })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.appended, undefined)
  assert.equal(created.length, 1)
})

test('档案语义（回归）：同食堂 + 同样本描述 + 同日 + 同设备，但**样本编号不同** → 不得并入（各自独立记录）', async () => {
  // 事故背景（2026-10-16）：真实上传因「样本编号不同」却同样本描述而被既有档案吸收。
  // 修复：档案键纳入样本编号。
  const stored = makeStoredRecord() // 样本编号 20260917001（同日、同描述、同设备）
  const { prisma, tenantClientFactory, plainKey, created, stored: all } = makeUploadStubs({ existingRecord: stored })
  const differentSample = makePayload({ ChipNumber: 'SN20260917003', DetectionNumber: '20260917003' })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: differentSample, apiKey: plainKey })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.appended, undefined)          // 不并入
  assert.equal(created.length, 1)                          // 独立新建
  assert.equal(created[0].result_data.sampleId, '20260917003')
  assert.equal((all[0].result_data.recheckReports || []).length, 0) // 既有档案不被改动
})

test('上传：正常入库 → 写入 school-a 租户、返回 reportId、三键与来源键正确', async () => {
  const { prisma, tenantClientFactory, plainKey, created } = makeUploadStubs()
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: plainKey })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.code, 0)
  assert.equal(res.body.message, 'success')
  assert.equal(res.body.data.reportId, chipRecordCode('SN20260917001'))
  assert.equal(created.length, 1)
  const rec = created[0]
  assert.equal(rec.created_by, 'u-1')
  assert.equal(rec.test_type, 'pathogen')
  assert.equal(rec.sample_info.canteen, '二食堂')
  assert.equal(rec.sample_info.testDate, '2026-09-17')
  assert.equal(rec.sample_info.inspector, '张三')
  assert.equal(rec.result_data.source, 'device')
  assert.equal(rec.result_data.riskLevel, '中风险')
  assert.equal(rec.result_data.allTestItems.length, 3)
})
// ───────────────────────── 超管 CRUD 归一 ─────────────────────────

function makeAdminStubs({ users = [{ id: 'u-1', status: 'active' }], schools = [{ code: 'school-a', status: 'active', name: 'A校' }], canteens = ['一食堂', '二食堂'], devices = [], platformKeys = [] } = {}) {
  const rows = devices.slice()
  const pkRows = platformKeys.slice()
  const prisma = {
    school: { async findUnique({ where }) { return schools.find((s) => s.code === where.code) || null } },
    schoolCustomization: { async findUnique() { return { canteens } } },
    pathogenDevice: {
      async findUnique({ where }) { return rows.find((r) => r.id === where.id || r.device_no === where.device_no) || null },
      async findMany({ where } = {}) { return where && where.school_code ? rows.filter((r) => r.school_code === where.school_code) : rows },
      async create({ data }) { const row = { id: `dev-${rows.length + 1}`, upload_count: 0, last_used_at: null, last_upload_at: null, disabled_at: null, disabled_reason: null, created_at: new Date(), updated_at: new Date(), ...data }; rows.push(row); return row },
      async update({ where, data }) { const row = rows.find((r) => r.id === where.id); if (!row) throw new Error('not found'); Object.assign(row, data); return row },
      async delete({ where }) { const i = rows.findIndex((r) => r.id === where.id); if (i >= 0) rows.splice(i, 1) },
      async upsert() { return {} },
    },
    // 统一上传密钥桩（B 方案）：单活语义由路由保证，桩按数组维护
    pathogenUploadKey: {
      async findUnique({ where }) { return pkRows.find((r) => r.key_hash === where.key_hash || r.id === where.id) || null },
      async findFirst({ orderBy } = {}) { return pkRows.slice().sort((a, b) => String(b.id).localeCompare(String(a.id)))[0] || null },
      async create({ data }) { const row = { id: `pk-${pkRows.length + 1}`, disabled_at: null, last_used_at: null, created_at: new Date(), updated_at: new Date(), ...data }; pkRows.push(row); return row },
      async update({ where, data }) { const row = pkRows.find((r) => r.id === where.id); if (!row) throw new Error('not found'); Object.assign(row, data); return row },
      async updateMany({ where, data }) {
        const hit = pkRows.filter((r) => (where.status ? r.status === where.status : true))
        hit.forEach((r) => Object.assign(r, data))
        return { count: hit.length }
      },
    },
    systemLog: { async create() { return { id: 'log-1' } } },
  }
  prisma.$transaction = async (ops) => Promise.all(ops)
  const tenantClientFactory = () => ({
    user: {
      async findUnique({ where }) { return users.find((u) => u.id === where.id) || null },
      // 设备列表「绑定用户 → 姓名」批量解析用
      async findMany({ where } = {}) {
        const ids = where?.id?.in || []
        return users.filter((u) => ids.includes(u.id))
      },
    },
  })
  return { prisma, rows, pkRows, tenantClientFactory }
}

function makeAdminRouter(prisma, tenantClientFactory) {
  return createAdminPathogenDeviceRoutes({
    prisma,
    authenticateUser: (req, _res, next) => { req.user = { userId: 'su-1', role: 'admin', schoolCode: null }; next() },
    requirePlatformSuperAdmin: (req, _res, next) => next(),
    tenantClientFactory,
  })
}

async function invokeAdmin(router, method, routePath, { params = {}, body = {}, query = {} } = {}) {
  const handler = handlerOf(router, method, routePath)
  const res = makeRes()
  await handler({ params, body, query, user: { userId: 'su-1' }, ip: '127.0.0.1' }, res)
  return res
}

test('超管新增：学校不存在 / 绑定用户缺失 / 默认食堂不在名单 → 400', async () => {
  const s1 = makeAdminStubs({ schools: [] })
  let res = await invokeAdmin(makeAdminRouter(s1.prisma, s1.tenantClientFactory), 'post', '/', { body: { device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1' } })
  assert.equal(res.statusCode, 400)
  assert.ok(res.body.error.includes('不存在'))

  const s2 = makeAdminStubs({ users: [] })
  res = await invokeAdmin(makeAdminRouter(s2.prisma, s2.tenantClientFactory), 'post', '/', { body: { device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-x' } })
  assert.equal(res.statusCode, 400)
  assert.ok(res.body.error.includes('绑定用户'))

  const s3 = makeAdminStubs()
  res = await invokeAdmin(makeAdminRouter(s3.prisma, s3.tenantClientFactory), 'post', '/', { body: { device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1', default_canteen: '四食堂' } })
  assert.equal(res.statusCode, 400)
  assert.ok(res.body.error.includes('不在该校食堂名单'))
})

test('超管新增：设备编号全局唯一（重复 → 400）', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs({
    devices: [{ id: 'dev-1', device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1', status: 'active', key_hash: 'h', key_prefix: 'pdv_x', key_last4: '1234', rate_limit_per_min: 60 }],
  })
  const res = await invokeAdmin(makeAdminRouter(prisma, tenantClientFactory), 'post', '/', { body: { device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1' } })
  assert.equal(res.statusCode, 400)
  assert.ok(res.body.error.includes('已存在'))
})

test('超管新增：成功返回明文密钥一次，列表投影不含 key_hash', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs()
  const router = makeAdminRouter(prisma, tenantClientFactory)
  const res = await invokeAdmin(router, 'post', '/', { body: { device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1', name: '快检室1号机', default_canteen: '二食堂' } })
  assert.equal(res.statusCode, 200)
  assert.match(res.body.data.apiKey, /^pdv_/)
  assert.equal(res.body.data.device_no, 'VH-2B-001')
  assert.equal(res.body.data.default_canteen, '二食堂')
  assert.equal(res.body.data.key_hash, undefined)

  const list = await invokeAdmin(router, 'get', '/', { query: { school_code: 'school-a' } })
  assert.equal(list.statusCode, 200)
  assert.equal(list.body.data.length, 1)
  assert.equal(JSON.stringify(list.body.data).includes('key_hash'), false)
})

test('超管修改：device_no / school_code 不可变；启停落 disabled 字段', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs({
    devices: [{ id: 'dev-1', device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1', status: 'active', key_hash: 'h', key_prefix: 'pdv_x', key_last4: '1234', rate_limit_per_min: 60, ip_whitelist: null, name: null, default_canteen: null }],
  })
  const router = makeAdminRouter(prisma, tenantClientFactory)
  let res = await invokeAdmin(router, 'patch', '/:id', { params: { id: 'dev-1' }, body: { device_no: 'VH-2B-002' } })
  assert.equal(res.statusCode, 400)
  assert.ok(res.body.error.includes('不可修改'))

  res = await invokeAdmin(router, 'patch', '/:id', { params: { id: 'dev-1' }, body: { school_code: 'school-b' } })
  assert.equal(res.statusCode, 400)
  assert.ok(res.body.error.includes('不可修改'))

  res = await invokeAdmin(router, 'patch', '/:id', { params: { id: 'dev-1' }, body: { status: 'disabled', disabled_reason: '设备返厂' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.status, 'disabled')
  assert.equal(res.body.data.disabled_reason, '设备返厂')

  res = await invokeAdmin(router, 'patch', '/:id', { params: { id: 'dev-1' }, body: { status: 'active' } })
  assert.equal(res.body.data.status, 'active')
  assert.equal(res.body.data.disabled_reason, null)
})

test('超管轮换密钥：返回新明文，展示前缀已更换', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs({
    devices: [{ id: 'dev-1', device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1', status: 'active', key_hash: 'old-hash', key_prefix: 'pdv_old', key_last4: '0000', rate_limit_per_min: 60, ip_whitelist: null, name: null, default_canteen: null }],
  })
  const res = await invokeAdmin(makeAdminRouter(prisma, tenantClientFactory), 'post', '/:id/rotate-key', { params: { id: 'dev-1' }, body: {} })
  assert.equal(res.statusCode, 200)
  assert.match(res.body.data.apiKey, /^pdv_/)
  assert.notEqual(res.body.data.key_prefix, 'pdv_old')
})

test('超管删除：物理删除且不影响后续查询', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs({
    devices: [{ id: 'dev-1', device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1', status: 'active', key_hash: 'h', key_prefix: 'pdv_x', key_last4: '1234', rate_limit_per_min: 60 }],
  })
  const router = makeAdminRouter(prisma, tenantClientFactory)
  const res = await invokeAdmin(router, 'delete', '/:id', { params: { id: 'dev-1' } })
  assert.equal(res.statusCode, 200)
  const list = await invokeAdmin(router, 'get', '/', { query: { school_code: 'school-a' } })
  assert.equal(list.body.data.length, 0)
})

// ───────────────────────── B 方案：统一上传密钥模式 ─────────────────────────

function makePlatformKey(overrides = {}) {
  const k = generateDeviceKey()
  return { id: 'pk-1', key_hash: k.hash, key_prefix: k.prefix, key_last4: k.last4, status: 'active', disabled_at: null, last_used_at: null, plain: k.plain, ...overrides }
}

test('统一密钥：正常上传 → 200 且归属由报文 DeviceNo 决定的学校', async () => {
  const pk = makePlatformKey()
  const { prisma, tenantClientFactory, created, pkUpdates } = makeUploadStubs({ platformKey: pk })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: pk.plain })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.code, 0)
  assert.equal(res.body.data.reportId, chipRecordCode('SN20260917001'))
  assert.equal(created.length, 1)
  assert.equal(created[0].sample_info.canteen, '二食堂')
  // 统一密钥最近使用时间被节流更新
  assert.ok(pkUpdates.some((d) => d.last_used_at instanceof Date))
})

test('统一密钥：报文设备编号未在任何学校登记 → 403 DEVICE_NOT_REGISTERED', async () => {
  const pk = makePlatformKey()
  const { prisma, tenantClientFactory } = makeUploadStubs({ platformKey: pk, device: { device_no: 'VH-2B-OTHER' } })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: pk.plain })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'DEVICE_NOT_REGISTERED')
  assert.match(res.body.message, /未在任何学校登记/)
})

test('统一密钥：归属设备已停用 → 403 DEVICE_DISABLED', async () => {
  const pk = makePlatformKey()
  const { prisma, tenantClientFactory } = makeUploadStubs({ platformKey: pk, device: { status: 'disabled', disabled_at: new Date() } })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: pk.plain })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'DEVICE_DISABLED')
})

test('统一密钥：密钥本身已停用 → 401 INVALID_KEY（等同无效密钥）', async () => {
  const pk = makePlatformKey({ status: 'disabled', disabled_at: new Date() })
  const { prisma, tenantClientFactory } = makeUploadStubs({ platformKey: pk })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: pk.plain })
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.code, 'INVALID_KEY')
})

test('统一密钥：报文格式错误 → 400（设备定位前即校验，与设备密钥模式一致）', async () => {
  const pk = makePlatformKey()
  const { prisma, tenantClientFactory, created } = makeUploadStubs({ platformKey: pk })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload({ DetectionNumber: '' }), apiKey: pk.plain })
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.code, 'VALIDATION_ERROR')
  assert.equal(created.length, 0)
})

test('统一密钥：设备 IP 白名单不匹配 → 403 IP_DENIED（设备级白名单仍生效）', async () => {
  const pk = makePlatformKey()
  const { prisma, tenantClientFactory } = makeUploadStubs({ platformKey: pk, device: { ip_whitelist: ['10.0.0.0/8'] } })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: pk.plain, ip: '192.168.1.50' })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'IP_DENIED')
})

test('统一密钥：归属学校不存在 → 409 SCHOOL_NOT_FOUND', async () => {
  const pk = makePlatformKey()
  const { prisma, tenantClientFactory } = makeUploadStubs({ platformKey: pk, school: null })
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload(), apiKey: pk.plain })
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'SCHOOL_NOT_FOUND')
})

test('统一密钥：与设备密钥互不串台（设备密钥仍走严格模式，报文编号不符即 403）', async () => {
  // 设备密钥模式：payload DeviceNo 与密钥设备不一致 → 403（旧行为不回退）
  const { prisma, tenantClientFactory, plainKey } = makeUploadStubs({})
  const res = await invokeUpload({ prisma, tenantClientFactory, body: makePayload({ DeviceNo: 'VH-2B-999' }), apiKey: plainKey })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'DEVICE_MISMATCH')
})

// ───────────────────────── 统一密钥管理（超管面）─────────────────────────

test('超管：创建统一上传密钥 → 明文仅一次返回，且停用旧行（单活）', async () => {
  const { prisma, pkRows, tenantClientFactory } = makeAdminStubs({
    platformKeys: [{ id: 'pk-0', key_hash: 'old-hash', key_prefix: 'pdv_old', key_last4: '0000', status: 'active', disabled_at: null, last_used_at: null }],
  })
  const res = await invokeAdmin(makeAdminRouter(prisma, tenantClientFactory), 'post', '/platform-key', { body: {} })
  assert.equal(res.statusCode, 200)
  assert.match(res.body.data.apiKey, /^pdv_/)
  assert.equal(res.body.data.rotated, true)
  assert.equal(pkRows.length, 2)
  assert.equal(pkRows[0].status, 'disabled')
  assert.ok(pkRows[0].disabled_at instanceof Date)
  assert.equal(pkRows[1].status, 'active')
})

test('超管：首次创建 → rotated=false 且仅一行 active', async () => {
  const { prisma, pkRows, tenantClientFactory } = makeAdminStubs()
  const res = await invokeAdmin(makeAdminRouter(prisma, tenantClientFactory), 'post', '/platform-key', { body: {} })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.rotated, false)
  assert.equal(pkRows.filter((r) => r.status === 'active').length, 1)
})

test('超管：查询统一密钥 → 只暴露 prefix/last4，不含 key_hash', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs({
    platformKeys: [{ id: 'pk-0', key_hash: 'h0', key_prefix: 'pdv_abc', key_last4: 'wxyz', status: 'active', disabled_at: null, last_used_at: null }],
  })
  const res = await invokeAdmin(makeAdminRouter(prisma, tenantClientFactory), 'get', '/platform-key')
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.exists, true)
  assert.equal(res.body.data.key.key_prefix, 'pdv_abc')
  assert.equal(JSON.stringify(res.body.data).includes('h0'), false)
})

test('超管：未创建时查询 → exists=false', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs()
  const res = await invokeAdmin(makeAdminRouter(prisma, tenantClientFactory), 'get', '/platform-key')
  assert.equal(res.body.data.exists, false)
})

test('超管：停用/启用统一密钥 → 状态与 disabled_at 联动', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs({
    platformKeys: [{ id: 'pk-0', key_hash: 'h0', key_prefix: 'pdv_abc', key_last4: 'wxyz', status: 'active', disabled_at: null, last_used_at: null }],
  })
  const router = makeAdminRouter(prisma, tenantClientFactory)
  let res = await invokeAdmin(router, 'patch', '/platform-key', { body: { status: 'disabled' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.status, 'disabled')
  assert.ok(res.body.data.disabled_at instanceof Date)
  res = await invokeAdmin(router, 'patch', '/platform-key', { body: { status: 'active' } })
  assert.equal(res.body.data.status, 'active')
  assert.equal(res.body.data.disabled_at, null)
})

test('超管：非法 status → 400', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs({
    platformKeys: [{ id: 'pk-0', key_hash: 'h0', key_prefix: 'pdv_abc', key_last4: 'wxyz', status: 'active', disabled_at: null, last_used_at: null }],
  })
  const res = await invokeAdmin(makeAdminRouter(prisma, tenantClientFactory), 'patch', '/platform-key', { body: { status: 'deleted' } })
  assert.equal(res.statusCode, 400)
})

test('超管：导出含 platform_key（哈希、无明文）；导入按 key_hash 去重', async () => {
  const { prisma, pkRows, tenantClientFactory } = makeAdminStubs({
    devices: [{ id: 'dev-1', device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1', status: 'active', key_hash: 'h', key_prefix: 'pdv_x', key_last4: '1234', rate_limit_per_min: 60 }],
    platformKeys: [{ id: 'pk-0', key_hash: 'h0', key_prefix: 'pdv_abc', key_last4: 'wxyz', status: 'active', disabled_at: null, last_used_at: null }],
  })
  const router = makeAdminRouter(prisma, tenantClientFactory)
  const ex = await invokeAdmin(router, 'get', '/export')
  assert.equal(ex.body.data.platform_key.key_hash, 'h0')
  assert.equal(JSON.stringify(ex.body.data.platform_key).includes('plain'), false)
  // 导入同一哈希 → 跳过（不重复建行）
  const im = await invokeAdmin(router, 'post', '/import', { body: { devices: [], platform_key: { key_hash: 'h0', key_prefix: 'pdv_abc', key_last4: 'wxyz' } } })
  assert.equal(im.statusCode, 200)
  assert.equal(pkRows.length, 1)
  // 导入新哈希 → 建行
  const im2 = await invokeAdmin(router, 'post', '/import', { body: { devices: [], platform_key: { key_hash: 'h-new', key_prefix: 'pdv_new', key_last4: '9999' } } })
  assert.equal(im2.statusCode, 200)
  assert.equal(pkRows.length, 2)
})

test('档案语义：最近一条同食堂记录样本描述不同、更早一条匹配 → 仍并入更早那条（候选扫描，防漏判）', async () => {
  // 更早的匹配档案（样本描述一致、同日）
  const matched = makeStoredRecord({ id: 'rec-matched', created_at: '2026-09-17T00:00:00.000Z' })
  // 更新的干扰档案：同食堂同样本类型，但样本描述不同
  const decoy = makeStoredRecord({
    id: 'rec-decoy',
    payload: makePayload({ SampleStr: '二食堂 操作台面涂抹样', ChipNumber: 'SN-DECOY-001' }),
    recordCode: chipRecordCode('SN-DECOY-001'),
    created_at: '2026-09-18T00:00:00.000Z',
  })
  const { prisma, tenantClientFactory, plainKey, created } = makeUploadStubs({ existingRecords: [matched, decoy] })
  const incoming = makePayload({ ChipNumber: 'SN20260917077' }) // 同样本编号 + 新芯片
  const res = await invokeUpload({ prisma, tenantClientFactory, body: incoming, apiKey: plainKey })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.appended, true)
  assert.equal(res.body.data.round, 2)
  assert.equal(res.body.data.reportId, matched.record_code)   // 并入「更早那条匹配档案」而非干扰记录
  assert.equal(created.length, 0)
  assert.equal(matched.result_data.recheckReports.length, 1)
  assert.equal(matched.result_data.recheckReports[0].chipNumber, 'SN20260917077')
  // 干扰档案不被触碰
  assert.equal((decoy.result_data.recheckReports || []).length, 0)
})

test('芯片语义：已并入复测轮次的芯片原样重传 → 幂等（不得重复新增轮次）', async () => {
  // 第二轮（芯片 B）已并入；此处用其原始报文重传
  const stored = makeStoredRecord({
    rounds: [{
      source: 'device',
      roundNo: 2,
      chipNumber: 'SN20260917002',
      sampleId: '20260917002',
      contentFingerprint: detectionFingerprint({
        parms: { 'FAM-1': 'ORF1ab', 'FAM-2': 'N', 'HEX-1': '内参' },
        resultList: { 'FAM-1': true, 'FAM-2': false, 'HEX-1': true },
        ctList: { 'FAM-1': '25.3', 'FAM-2': '-', 'HEX-1': '28.7' },
        detectionStartAt: '2026-09-17 08:30:00',
        detectionEndAt: '2026-09-17 10:45:00',
        sampleInfo: '二食堂 餐盘涂抹样 汤胜亮',
        inspector: '张三',
      }),
    }],
  })
  const { prisma, tenantClientFactory, plainKey, created } = makeUploadStubs({ existingRecord: stored })
  const res = await invokeUpload({
    prisma, tenantClientFactory, plainKey,
    body: makePayload({ ChipNumber: 'SN20260917002', DetectionNumber: '20260917002' }),
    apiKey: plainKey,
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.duplicated, true)          // 幂等，而非新增 round 3
  assert.equal(res.body.data.round, undefined)
  assert.equal(created.length, 0)
  assert.equal(stored.result_data.recheckReports.length, 1) // 轮次数不变
})

test('芯片语义：芯片号大小写/空格差异 → 归一命中同一张芯片（幂等，不误报重复）', async () => {
  const stored = makeStoredRecord() // 芯片 SN20260917001
  const { prisma, tenantClientFactory, plainKey } = makeUploadStubs({ existingRecord: stored })
  const res = await invokeUpload({
    prisma, tenantClientFactory, plainKey,
    body: makePayload({ ChipNumber: '  sn20260917001  ' }),
    apiKey: plainKey,
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.duplicated, true)
  assert.equal(res.body.data.reportId, stored.record_code)
})

test('芯片语义：归一化后内容不一致（大小写不同的同芯片改 CT）→ 409 复核', async () => {
  const stored = makeStoredRecord()
  const { prisma, tenantClientFactory, plainKey, stored: all } = makeUploadStubs({ existingRecord: stored })
  const res = await invokeUpload({
    prisma, tenantClientFactory, plainKey,
    body: makePayload({ ChipNumber: 'sn20260917001', CTList: { 'FAM-1': '30.9', 'FAM-2': '-', 'HEX-1': '28.7' } }),
    apiKey: plainKey,
  })
  assert.equal(res.statusCode, 409)
  assert.equal(res.body.code, 'CHIP_REVIEW_REQUIRED')
  assert.equal(all[0].result_data.reviewFlags[0].chip_number, 'sn20260917001')
})

test('复测换人：轮次记录本人检测员 + inspectorChanged 标记；父记录三键检测员保持初检值', async () => {
  const stored = makeStoredRecord() // 父记录检测员 = 张三（makePayload 默认）
  const { prisma, tenantClientFactory, plainKey } = makeUploadStubs({ existingRecord: stored })
  const res = await invokeUpload({
    prisma, tenantClientFactory, plainKey,
    body: makePayload({ ChipNumber: 'SN20260917002', DetectionPeopleStr: '郭仁康' }),
    apiKey: plainKey,
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.round, 2)
  const round = stored.result_data.recheckReports[0]
  assert.equal(round.inspector, '郭仁康')            // 轮次记录本次检测员
  assert.equal(round.inspectorChanged, true)         // 变更显式标记
  assert.equal(round.prevInspector, '张三')          // 初检检测员留档
  assert.equal(stored.sample_info.inspector, '张三')  // 父记录（上下文三键）保持初检检测员（与手动复检口径一致）
  assert.match(stored.result_data.modificationLogs[0].content, /检测员 郭仁康（初检为 张三）/)
})

test('复测同人：检测员未变 → inspectorChanged=false，不误标变更', async () => {
  const stored = makeStoredRecord() // 初检 张三
  const { prisma, tenantClientFactory, plainKey } = makeUploadStubs({ existingRecord: stored })
  const res = await invokeUpload({
    prisma, tenantClientFactory, plainKey,
    body: makePayload({ ChipNumber: 'SN20260917003' }), // DetectionPeopleStr 默认 张三
    apiKey: plainKey,
  })
  assert.equal(res.statusCode, 200)
  const round = stored.result_data.recheckReports[0]
  assert.equal(round.inspector, '张三')
  assert.equal(round.inspectorChanged, false)
})

test('超管：设备列表不带 school_code → 返回全部学校设备（跨校「全部学校」视图）；带 school_code 仍按校过滤', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs({
    schools: [{ code: 'school-a', status: 'active', name: 'A校' }, { code: 'school-b', status: 'active', name: 'B校' }],
    devices: [
      { id: 'dev-1', device_no: 'VH-A-001', school_code: 'school-a', binding_user_id: 'u-1', status: 'active', key_hash: 'h1', key_prefix: 'pdv_a', key_last4: '1111', rate_limit_per_min: 60, upload_count: 0 },
      { id: 'dev-2', device_no: 'VH-B-001', school_code: 'school-b', binding_user_id: 'u-1', status: 'active', key_hash: 'h2', key_prefix: 'pdv_b', key_last4: '2222', rate_limit_per_min: 60, upload_count: 0 },
    ],
  })
  const router = makeAdminRouter(prisma, tenantClientFactory)
  const all = await invokeAdmin(router, 'get', '/')
  assert.equal(all.statusCode, 200)
  assert.equal(all.body.data.length, 2, '不带 school_code 必须返回全部学校设备')
  assert.deepEqual(all.body.data.map((d) => d.school_code).sort(), ['school-a', 'school-b'])
  // 每行带 school_code，供前端跨校视图渲染「学校」列
  assert.ok(all.body.data.every((d) => typeof d.school_code === 'string' && d.school_code))

  const filtered = await invokeAdmin(router, 'get', '/', { query: { school_code: 'school-b' } })
  assert.equal(filtered.body.data.length, 1)
  assert.equal(filtered.body.data[0].device_no, 'VH-B-001')
})

test('超管：设备列表把「绑定用户」解析为姓名（控制台不展示 UUID）；跨校各自解析', async () => {
  const { prisma, tenantClientFactory } = makeAdminStubs({
    users: [
      { id: 'u-1', username: 'renkang', full_name: '郭仁康', status: 'active' },
      { id: 'u-2', username: 'zhangsan', full_name: null, status: 'disabled' },
    ],
    devices: [
      { id: 'dev-1', device_no: 'VH-A-001', school_code: 'school-a', binding_user_id: 'u-1', status: 'active', key_hash: 'h1', key_prefix: 'pdv_a', key_last4: '1111', rate_limit_per_min: 60, upload_count: 0 },
      { id: 'dev-2', device_no: 'VH-B-001', school_code: 'school-b', binding_user_id: 'u-2', status: 'active', key_hash: 'h2', key_prefix: 'pdv_b', key_last4: '2222', rate_limit_per_min: 60, upload_count: 0 },
    ],
  })
  const res = await invokeAdmin(makeAdminRouter(prisma, tenantClientFactory), 'get', '/')
  assert.equal(res.statusCode, 200)
  const byNo = Object.fromEntries(res.body.data.map((d) => [d.device_no, d]))
  assert.equal(byNo['VH-A-001'].binding_user_name, '郭仁康')
  assert.equal(byNo['VH-A-001'].binding_user_username, 'renkang')
  assert.equal(byNo['VH-A-001'].binding_user_id, 'u-1')          // id 仍返回（供编辑回填）
  assert.equal(byNo['VH-B-001'].binding_user_name, 'zhangsan')   // 无 full_name → 回落 username
  assert.equal(byNo['VH-B-001'].binding_user_status, 'disabled') // 停用可提示
})

test('超管：绑定用户解析失败（租户不可达）→ 列表仍返回，姓名降级为 null', async () => {
  const { prisma } = makeAdminStubs({
    devices: [{ id: 'dev-1', device_no: 'VH-A-001', school_code: 'school-a', binding_user_id: 'u-1', status: 'active', key_hash: 'h1', key_prefix: 'pdv_a', key_last4: '1111', rate_limit_per_min: 60, upload_count: 0 }],
  })
  const failingFactory = () => ({ user: { async findMany() { throw new Error('tenant unreachable') } } })
  const res = await invokeAdmin(makeAdminRouter(prisma, failingFactory), 'get', '/')
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.length, 1)
  assert.equal(res.body.data[0].binding_user_name, null)      // 降级不阻断
  assert.equal(res.body.data[0].binding_user_id, 'u-1')
})

test('食堂口径（与手动录入一致）：学校未配置食堂列表 → 用内置默认名单校验默认食堂', async () => {
  // 真实学校（tjb/zhsy/zhyz）实测就是这种状态：canteens=[] 且 field_options 为空
  const s1 = makeAdminStubs({ canteens: [] })
  let res = await invokeAdmin(makeAdminRouter(s1.prisma, s1.tenantClientFactory), 'post', '/', {
    body: { device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1', default_canteen: '一食堂' },
  })
  assert.equal(res.statusCode, 200, '内置默认名单中的「一食堂」应被接受')

  const s2 = makeAdminStubs({ canteens: [] })
  res = await invokeAdmin(makeAdminRouter(s2.prisma, s2.tenantClientFactory), 'post', '/', {
    body: { device_no: 'VH-2B-002', school_code: 'school-a', binding_user_id: 'u-1', default_canteen: '教工餐厅' },
  })
  assert.equal(res.statusCode, 400)
  assert.ok(res.body.error.includes('一食堂'), '错误信息应列出实际使用的名单')
  assert.ok(res.body.error.includes('学校管理 → 基本信息'), '错误信息应给出配置指引')
})

test('食堂口径：学校配置了自定义食堂 → 以配置为准（内置默认不再兜底）', async () => {
  const s1 = makeAdminStubs({ canteens: ['教工餐厅', '学生餐厅'] })
  let res = await invokeAdmin(makeAdminRouter(s1.prisma, s1.tenantClientFactory), 'post', '/', {
    body: { device_no: 'VH-2B-001', school_code: 'school-a', binding_user_id: 'u-1', default_canteen: '一食堂' },
  })
  assert.equal(res.statusCode, 400, '已配置自定义名单时，内置默认名字不应被接受')

  const s2 = makeAdminStubs({ canteens: ['教工餐厅', '学生餐厅'] })
  res = await invokeAdmin(makeAdminRouter(s2.prisma, s2.tenantClientFactory), 'post', '/', {
    body: { device_no: 'VH-2B-003', school_code: 'school-a', binding_user_id: 'u-1', default_canteen: '教工餐厅' },
  })
  assert.equal(res.statusCode, 200)
})

test('上报归属：学校未配置食堂列表时，报文样本信息仍能按内置默认名单识别食堂', async () => {
  // 事故场景：真实学校 canteens=[] → 设备链路曾取到空名单 → 只能靠设备默认食堂（或 422）
  const { prisma, tenantClientFactory, plainKey, created } = makeUploadStubs({ canteens: [] })
  const res = await invokeUpload({ prisma, tenantClientFactory, plainKey, body: makePayload(), apiKey: plainKey })
  assert.equal(res.statusCode, 200)
  assert.equal(created.length, 1)
  assert.equal(created[0].sample_info.canteen, '二食堂', '应从 SampleStr 识别出「二食堂」（内置默认名单兜底）')
})
