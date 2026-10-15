// pathogenDeviceRoutes.js — 病原体检测设备自动采集（VirusHunter2.0B 对接）
//
// 两面：
//  ① 设备上传面 createPathogenDeviceUploadRoutes({ prisma })
//     挂载 server.js `app.use('/api/open/pathogen-device', ...)`，**免人类 JWT**：
//       POST /upload — 设备推送检测结果。认证 = 设备密钥（X-API-Key / Bearer，sha256 哈希比对），
//       归属 = 密钥 → PathogenDevice.school_code（报文中的 DeviceNo 必须与密钥设备一致，
//       报文中任何租户信息一律忽略）。写入经 createTenantClient(school_code) 物理隔离落库。
//     响应口径与厂商对接文档一致：成功 { code: 0, message: 'success', data: { reportId } }。
//
//  ② 超管配置面 createAdminPathogenDeviceRoutes({ prisma, authenticateUser, requirePlatformSuperAdmin })
//     挂载 server.js `app.use('/api/admin/pathogen-devices', ...)`：
//       GET    /                     查询（按 school_code 过滤）
//       POST   /                     新增（明文密钥仅此一次返回）
//       PATCH  /:id                  修改（device_no / school_code 不可变）
//       DELETE /:id                  删除
//       POST   /:id/rotate-key       轮换密钥（旧密钥立即失效）
//       GET    /export               导出（含 key_hash，不含明文；灾后重建）
//       POST   /import               导入（按 id upsert）
//
// ⚠️ 数据权威副本在 public."PathogenDevice"（迁移 20261014120000_pathogen_devices）：
//    读写一律用基础 prisma 单例，**绝不用 req.db**（租户副本仅结构对齐，永不写入）。
// ⚠️ 挂载顺序：必须位于 server.js 下方 `app.use('/api', recognitionRoutes)` 兜底之前，
//    否则设备上传会被其全局 authenticateUser 拦成 401（同 /api/open 踩坑教训）。

import express from 'express'
import { writeSystemLog, writeAdminOpsLog } from '../lib/auditLog.js'
import { writeRecordAuditLog, buildRecordWriteData } from '../lib/recordNormalize.js'
import { createTenantClient, isValidSchoolCode } from '../lib/tenantClient.js'
import {
  generateDeviceKey,
  hashDeviceKey,
  extractDeviceKey,
  validateUploadPayload,
  buildPathogenRecordPayload,
  chipRecordCode,
  normalizeChipNumber,
  detectionFingerprint,
  fingerprintOfStoredRecord,
  buildCaseKey,
  isSameCase,
  buildDeviceRound,
} from '../lib/pathogenDevice.js'
import { ipAllowed, normalizeIp } from '../lib/openApiKeys.js'

const TAG = '[pathogenDeviceRoutes]'

// 设备编号：大写字母、数字、连字符、下划线（厂商设备序列号习惯），1~64
const DEVICE_NO_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_DEVICE_NAME = 60
const MAX_DISABLED_REASON = 200
const MAX_IP_ENTRIES = 50
const IP_OR_CIDR_RE = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/
const WINDOW_MS = 60 * 1000
const USAGE_FLUSH_MS = 60 * 1000
const DENY_LOG_THROTTLE_MS = 60 * 1000
const DEFAULT_RATE_LIMIT = 60
// 统一上传密钥平台级限流（兜底闸门：防止一把共享钥匙被滥用刷全平台；设备级限流另行执行）
const PLATFORM_RATE_LIMIT = 600
const MAX_RATE_LIMIT = 600
const OPS_ACTION = {
  create: 'pathogen_device_create',
  update: 'pathogen_device_update',
  remove: 'pathogen_device_delete',
  rotate: 'pathogen_device_rotate_key',
  import: 'pathogen_device_import',
  platformKey: 'pathogen_platform_key_create', // 创建/轮换统一上传密钥（单活：停旧建新）
  platformKeyToggle: 'pathogen_platform_key_toggle', // 统一上传密钥启停
}

/** 设备上传面响应：{ code, message, data }（与厂商对接文档一致）。 */
function reply(res, status, code, message, data = null) {
  return res.status(status).json({ code, message, data })
}

function badRequest(res, message) {
  return res.status(400).json({ success: false, error: message })
}

/** 列表/详情投影：绝不外泄 key_hash。 */
function toDeviceView(row) {
  return {
    id: row.id,
    device_no: row.device_no,
    school_code: row.school_code,
    name: row.name ?? null,
    binding_user_id: row.binding_user_id ?? null,
    default_canteen: row.default_canteen ?? null,
    status: row.status,
    key_prefix: row.key_prefix,
    key_last4: row.key_last4,
    rate_limit_per_min: row.rate_limit_per_min,
    ip_whitelist: Array.isArray(row.ip_whitelist) ? row.ip_whitelist : [],
    upload_count: row.upload_count ?? 0,
    last_used_at: row.last_used_at ?? null,
    last_upload_at: row.last_upload_at ?? null,
    disabled_at: row.disabled_at ?? null,
    disabled_reason: row.disabled_reason ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  }
}

/** 取该校食堂名单（SchoolCustomization.canteens 优先，回落 field_options.canteen）。 */
async function loadSchoolCanteens(prisma, schoolCode) {
  const customization = await prisma.schoolCustomization.findUnique({ where: { school_code: schoolCode } })
  const fromCanteens = Array.isArray(customization?.canteens) ? customization.canteens.map(String) : null
  const fromFieldOptions = Array.isArray(customization?.field_options?.canteen)
    ? customization.field_options.canteen.map(String)
    : null
  return fromCanteens ?? fromFieldOptions ?? []
}

/** 校验绑定用户存在于该校租户（返回 { ok } 或 { ok:false, message }）。 */
async function assertBindingUser(prisma, schoolCode, userId, tenantClientFactory) {
  const factory = tenantClientFactory || createTenantClient
  try {
    const db = factory(prisma, schoolCode)
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, status: true } })
    if (!user) return { ok: false, message: `绑定用户 ${userId} 不存在于该校` }
    if (user.status !== 'active') return { ok: false, message: `绑定用户 ${userId} 已被停用，请先启用或改绑其他用户` }
    return { ok: true }
  } catch (e) {
    return { ok: false, message: `绑定用户校验失败：${e.message}` }
  }
}

// ───────────────────────── ① 设备上传面 ─────────────────────────

export function createPathogenDeviceUploadRoutes({ prisma, tenantClientFactory }) {
  const router = express.Router()
  /** 滑动窗口计数：deviceId → number[]（毫秒时间戳） */
  const hits = new Map()
  /** 用量落库节流：deviceId → 上次写入时间 */
  const lastUsageFlush = new Map()
  /** 拒绝日志节流：`${ip}|${code}` → 上次记录时间 */
  const lastDenyLog = new Map()

  function pruneHits(now) {
    for (const [id, arr] of hits) {
      const kept = arr.filter((t) => now - t < WINDOW_MS)
      if (kept.length) hits.set(id, kept)
      else hits.delete(id)
    }
  }

  function logDeniedThrottled(ip, code, detail) {
    const key = `${normalizeIp(ip)}|${code}`
    const now = Date.now()
    const prev = lastDenyLog.get(key) || 0
    if (now - prev < DENY_LOG_THROTTLE_MS) return
    lastDenyLog.set(key, now)
    writeSystemLog(prisma, {
      level: 'warn',
      message: `PATHOGEN_DEVICE_DENIED ${code}`,
      context: { action_type: 'pathogen_device_denied', code, ip: normalizeIp(ip), path: detail?.path || null, device_no: detail?.deviceNo || null, ts: new Date().toISOString() },
    }).catch((e) => console.warn(`${TAG} 拒绝事件落库失败:`, e.message))
  }

  function flushUsage(device) {
    const now = Date.now()
    const prev = lastUsageFlush.get(device.id) || 0
    if (now - prev < USAGE_FLUSH_MS) return
    lastUsageFlush.set(device.id, now)
    prisma.pathogenDevice
      .update({ where: { id: device.id }, data: { last_used_at: new Date() } })
      .catch((e) => console.warn(`${TAG} 用量落库失败:`, e.message))
  }

  /** 统一上传密钥用量落库（节流；桶名加 `pk:` 前缀避免与设备 id 冲突）。 */
  function flushPlatformUsage(platformKey) {
    const now = Date.now()
    const bucket = `pk:${platformKey.id}`
    const prev = lastUsageFlush.get(bucket) || 0
    if (now - prev < USAGE_FLUSH_MS) return
    lastUsageFlush.set(bucket, now)
    prisma.pathogenUploadKey
      .update({ where: { id: platformKey.id }, data: { last_used_at: new Date() } })
      .catch((e) => console.warn(`${TAG} 统一密钥用量落库失败:`, e.message))
  }

  router.post('/upload', async (req, res) => {
    const ip = normalizeIp(req.ip || req.connection?.remoteAddress)
    const path = req.originalUrl || req.url

    // ── ① 密钥认证（B 方案：两种模式共存，同一接口）──
    //   · 设备密钥模式（严格，可选）：密钥即设备，报文 DeviceNo 必须与密钥所属设备一致；
    //   · 统一上传密钥模式（推荐，默认形态）：全平台设备共用一把平台级密钥，归属**完全由报文
    //     DeviceNo** 查 PathogenDevice「学校-设备编号」映射决定——设备必须先在学校登记。
    const plain = extractDeviceKey(req)
    if (!plain) {
      logDeniedThrottled(ip, 'MISSING_KEY', { path })
      return reply(res, 401, 'MISSING_KEY', '缺少设备密钥（请使用 X-API-Key 或 Authorization: Bearer）')
    }

    const keyHash = hashDeviceKey(plain)
    let device = null
    let platformKey = null
    try {
      device = await prisma.pathogenDevice.findUnique({ where: { key_hash: keyHash } })
      if (!device) {
        const pk = await prisma.pathogenUploadKey.findUnique({ where: { key_hash: keyHash } })
        if (pk && pk.status === 'active' && !pk.disabled_at) platformKey = pk
      }
    } catch (e) {
      console.error(`${TAG} 设备/统一密钥查询异常:`, e)
      return reply(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
    }
    if (!device && !platformKey) {
      logDeniedThrottled(ip, 'INVALID_KEY', { path })
      return reply(res, 401, 'INVALID_KEY', '密钥无效：既不是有效的设备密钥，也不是有效的统一上传密钥')
    }
    const authMode = device ? 'device' : 'unified'

    // ── ② 设备密钥模式：设备级前置检查（保持既有错误优先级）；统一模式：平台密钥级限流 ──
    if (authMode === 'device') {
      if (device.status !== 'active' || device.disabled_at) {
        logDeniedThrottled(ip, 'DEVICE_DISABLED', { path, deviceNo: device.device_no })
        return reply(res, 403, 'DEVICE_DISABLED', `设备 ${device.device_no} 已停用，请联系平台管理员启用`)
      }
      if (!ipAllowed(ip, device.ip_whitelist)) {
        logDeniedThrottled(ip, 'IP_DENIED', { path, deviceNo: device.device_no })
        return reply(res, 403, 'IP_DENIED', `来源 IP 不在白名单内（${ip}）`)
      }
    } else {
      // 统一密钥级限流（平台级桶：一把共享钥匙被滥用时的兜底闸门；设备级限流见 ⑤）
      const nowTs = Date.now()
      pruneHits(nowTs)
      const pkBucket = `pk:${platformKey.id}`
      const pkArr = hits.get(pkBucket) || []
      if (pkArr.length >= PLATFORM_RATE_LIMIT) {
        const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (nowTs - pkArr[0])) / 1000))
        logDeniedThrottled(ip, 'RATE_LIMITED', { path })
        res.setHeader('Retry-After', String(retryAfter))
        return reply(res, 429, 'RATE_LIMITED', `请求过于频繁（平台上限 ${PLATFORM_RATE_LIMIT} 次/分钟）`)
      }
      pkArr.push(nowTs)
      hits.set(pkBucket, pkArr)
      flushPlatformUsage(platformKey)
    }

    // ── ③ 协议校验 ──
    const validation = validateUploadPayload(req.body)
    if (!validation.ok) {
      logDeniedThrottled(ip, 'VALIDATION_ERROR', { path, deviceNo: device?.device_no || null })
      return reply(res, 400, 'VALIDATION_ERROR', validation.message)
    }
    const payload = validation.data

    // ── ④ 设备定位与一致性 ──
    if (authMode === 'device') {
      // 设备密钥模式：报文设备编号必须与密钥所属设备一致（防跨校冒用 / 租户冲突）
      if (payload.deviceNo !== device.device_no) {
        logDeniedThrottled(ip, 'DEVICE_MISMATCH', { path, deviceNo: device.device_no })
        return reply(res, 403, 'DEVICE_MISMATCH', `报文设备编号 ${payload.deviceNo} 与密钥所属设备不一致`)
      }
    } else {
      // 统一密钥模式：按报文设备编号定位设备（必须已在学校登记且启用）
      try {
        device = await prisma.pathogenDevice.findUnique({ where: { device_no: payload.deviceNo } })
      } catch (e) {
        console.error(`${TAG} 设备定位异常:`, e)
        return reply(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
      }
      if (!device) {
        logDeniedThrottled(ip, 'DEVICE_NOT_REGISTERED', { path, deviceNo: payload.deviceNo })
        return reply(res, 403, 'DEVICE_NOT_REGISTERED', `设备编号 ${payload.deviceNo} 未在任何学校登记：请先在控制台「病原体设备」为所属学校绑定该设备编号`)
      }
      if (device.status !== 'active' || device.disabled_at) {
        logDeniedThrottled(ip, 'DEVICE_DISABLED', { path, deviceNo: device.device_no })
        return reply(res, 403, 'DEVICE_DISABLED', `设备 ${device.device_no} 已停用，请联系平台管理员启用`)
      }
      if (!ipAllowed(ip, device.ip_whitelist)) {
        logDeniedThrottled(ip, 'IP_DENIED', { path, deviceNo: device.device_no })
        return reply(res, 403, 'IP_DENIED', `来源 IP 不在白名单内（${ip}）`)
      }
    }

    // ── ⑤ 设备级限流（按设备滑动窗口；两种模式共用） ──
    const now = Date.now()
    pruneHits(now)
    const limit = Number(device.rate_limit_per_min) > 0 ? Number(device.rate_limit_per_min) : DEFAULT_RATE_LIMIT
    const arr = hits.get(device.id) || []
    if (arr.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - arr[0])) / 1000))
      logDeniedThrottled(ip, 'RATE_LIMITED', { path, deviceNo: device.device_no })
      res.setHeader('Retry-After', String(retryAfter))
      return reply(res, 429, 'RATE_LIMITED', `请求过于频繁（上限 ${limit} 次/分钟）`)
    }
    arr.push(now)
    hits.set(device.id, arr)
    flushUsage(device)

    // ── ⑥ 归属学校存在性 ──
    let school
    try {
      school = await prisma.school.findUnique({
        where: { code: device.school_code },
        select: { id: true, code: true, name: true, status: true },
      })
    } catch (e) {
      console.error(`${TAG} 学校查询异常:`, e)
      return reply(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
    }
    if (!school) {
      logDeniedThrottled(ip, 'SCHOOL_NOT_FOUND', { path, deviceNo: device.device_no })
      return reply(res, 409, 'SCHOOL_NOT_FOUND', '设备归属学校不存在或已被删除，请联系平台管理员重新配置设备')
    }
    if (school.status !== 'active') {
      logDeniedThrottled(ip, 'SCHOOL_DISABLED', { path, deviceNo: device.device_no })
      return reply(res, 403, 'SCHOOL_DISABLED', '设备归属学校已停用，请联系平台管理员')
    }

    // ── ⑦ 记录负载构建（食堂识别 + 风险计算） ──
    let canteens
    try {
      canteens = await loadSchoolCanteens(prisma, device.school_code)
    } catch (e) {
      console.warn(`${TAG} 食堂名单读取失败（回落设备默认食堂）:`, e.message)
      canteens = []
    }
    const built = buildPathogenRecordPayload({
      payload,
      deviceNo: device.device_no,
      canteens,
      defaultCanteen: device.default_canteen || null,
    })
    if (!built.ok) {
      logDeniedThrottled(ip, built.code, { path, deviceNo: device.device_no })
      return reply(res, 422, built.code, built.message)
    }

    // ── ⑧ 重复判定（以**芯片编号**为准）+ 复测轮次合并（2026-10-15 与产品确认）──
    //   一张芯片只产生一组数据，且只在芯片测试完成后上传：
    //   · 同芯片 + 内容一致   → 幂等放行（返回既有 reportId，不产生新记录）
    //   · 同芯片 + 内容不一致 → 409 CHIP_REVIEW_REQUIRED「芯片编号重复，请人工复核」
    //                           （仅在既有记录上追加复核标记，不改动检测数据；第二张同编号芯片数据请走人工上传导出报告）
    //   · 同档案不同芯片（食堂 + 样本类型 + 样本描述 + 设备，且检测日期在 CASE_WINDOW_DAYS 天内）
    //                        → 作为**复测轮次**并入既有记录（检测次数 +1，前端按「初检 / 第 N 次检测（复测）」呈现）
    const recordCode = chipRecordCode(payload.chipNumber)
    const factory = tenantClientFactory || createTenantClient
    let db
    try {
      db = factory(prisma, device.school_code)
    } catch (e) {
      console.error(`${TAG} 租户客户端异常:`, e)
      return reply(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
    }

    const targetChip = normalizeChipNumber(payload.chipNumber)
    let chipHit = null
    let chipRound = null          // 命中的轮次（为空表示命中记录自身的芯片）
    let caseHit = null
    try {
      // 芯片命中检索：同时覆盖 ① 记录自身的芯片号 ② 已并入的各复测轮次芯片号；芯片号按**归一化**比较
      // （大小写/空格差异视为同一张芯片）。按创建时间倒序取最近 300 条为该学校的检索窗口。
      const recent = await db.testRecord.findMany({
        where: { test_type: 'pathogen' },
        orderBy: { created_at: 'desc' },
        take: 300,
      })
      for (const rec of recent || []) {
        const ownChip = normalizeChipNumber(rec.result_data?.chip?.number)
        if (ownChip && ownChip === targetChip) { chipHit = rec; break }
        const rounds = Array.isArray(rec.result_data?.recheckReports) ? rec.result_data.recheckReports : []
        const hitRound = rounds.find((x) => x && normalizeChipNumber(x.chipNumber) === targetChip)
        if (hitRound) { chipHit = rec; chipRound = hitRound; break }
      }
      if (!chipHit) {
        // 同档案候选：按「食堂 + 样本类型」取最近 20 条（该组合下样本描述可能不同），
        // 在内存中逐条按「归一档案键 + 时间窗」精确比对，命中最近一条即视为复测
        const candidates = await db.testRecord.findMany({
          where: {
            test_type: 'pathogen',
            sample_info: { path: ['canteen'], equals: built.data.canteen },
            result_data: { path: ['sampleType'], equals: built.data.sampleType },
          },
          orderBy: { created_at: 'desc' },
          take: 20,
        })
        caseHit = (candidates || []).find((r) => isSameCase(r, built.data)) || null
      }
    } catch (e) {
      console.error(`${TAG} 重复/档案检索异常:`, e)
      return reply(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
    }

    // ⑧.1 同芯片命中：一致 → 幂等；不一致 → 请人工复核
    if (chipHit) {
      // 命中「记录自身芯片」用记录指纹；命中「已并入轮次」用该轮次指纹
      const storedFp = chipRound
        ? (chipRound.contentFingerprint || null)
        : (chipHit.result_data?.contentFingerprint || fingerprintOfStoredRecord(chipHit.result_data, chipHit.sample_info))
      if (storedFp && storedFp === built.data.contentFingerprint) {
        return reply(res, 200, 0, 'success', { reportId: chipHit.record_code, duplicated: true })
      }
      const flags = Array.isArray(chipHit.result_data?.reviewFlags) ? chipHit.result_data.reviewFlags : []
      const flag = {
        type: 'chip_duplicate',
        at: new Date().toISOString(),
        device_no: device.device_no,
        chip_number: payload.chipNumber,
        attempted_sample_id: payload.detectionNumber,
        attempted_report_file: payload.fileName,
        existing_sample_id: chipRound ? (chipRound.sampleId || null) : (chipHit.result_data?.sampleId || null),
        existing_round: chipRound ? (chipRound.roundNo || null) : 1,
        hint: '芯片编号重复且本次数据不一致，请人工复核；第二张同编号芯片数据请走人工上传导出的报告',
      }
      try {
        await db.testRecord.update({
          where: { id: chipHit.id },
          data: { result_data: { ...chipHit.result_data, reviewFlags: [flag, ...flags].slice(0, 20) } },
        })
      } catch (e) {
        console.warn(`${TAG} 复核标记写入失败（不影响拒绝语义）:`, e.message)
      }
      await writeRecordAuditLog(db, device.binding_user_id, 'update', 'test_record', chipHit.id, {
        test_type: 'pathogen',
        record_code: chipHit.record_code,
        source: 'device',
        auth_mode: authMode,
        device_no: device.device_no,
        school_code: device.school_code,
        review: 'chip_duplicate',
        chip_number: payload.chipNumber,
        attempted_sample_id: payload.detectionNumber,
      }, ip)
      logDeniedThrottled(ip, 'CHIP_REVIEW_REQUIRED', { path, deviceNo: device.device_no })
      return reply(res, 409, 'CHIP_REVIEW_REQUIRED',
        `芯片编号 ${payload.chipNumber} 已有数据且本次内容不一致：芯片编号重复，请人工复核（第二张同编号芯片数据请走人工上传导出的报告）`,
        { reportId: chipHit.record_code, reviewRequired: true })
    }

    // ⑧.2 同档案不同芯片 → 复测轮次并入既有记录
    if (caseHit && isSameCase(caseHit, built.data)) {
      const rounds = Array.isArray(caseHit.result_data?.recheckReports) ? caseHit.result_data.recheckReports : []
      const roundNo = rounds.filter((r) => r && r.source === 'device').length + 2 // 父记录本身 = 第 1 轮
      const round = buildDeviceRound({
        built: built.data,
        payload,
        deviceNo: device.device_no,
        roundNo,
        uploadedAt: Date.now(),
        parentInspector: caseHit.sample_info?.inspector || null,
      })
      const merged = {
        ...caseHit.result_data,
        recheckReports: [round, ...rounds],
        // 结论以最新轮次为准（与手动复检 TD-Recheck-Sync 同口径）
        finalStatus: round.isPassed ? '复检通过' : `复检${round.riskLevel}`,
        riskLevel: round.isPassed ? '无风险' : round.riskLevel,
        positiveItems: round.isPassed ? '无' : round.positiveItems,
        positiveDetails: round.positiveDetails,
        riskReason: round.riskReason,
        result: round.isPassed ? '合格' : '不合格',
        modificationLogs: [{
          time: new Date().toLocaleString('zh-CN', { hour12: false }),
          user: `设备 ${device.device_no}`,
          action: '设备复测轮次入库',
          // 检测员变更显式写入变更日志（复测可能换人，需可追溯/可展示）
          content: `${round.roundLabel}（芯片 ${payload.chipNumber}、样本 ${payload.detectionNumber}、检测员 ${round.inspector}${round.inspectorChanged ? `（初检为 ${round.prevInspector}）` : ''}）：${round.riskReason}`,
        }, ...(Array.isArray(caseHit.result_data?.modificationLogs) ? caseHit.result_data.modificationLogs : [])],
      }
      try {
        await db.testRecord.update({ where: { id: caseHit.id }, data: { result_data: merged } })
      } catch (e) {
        console.error(`${TAG} 复测轮次写入异常:`, e)
        return reply(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
      }
      await writeRecordAuditLog(db, device.binding_user_id, 'update', 'test_record', caseHit.id, {
        test_type: 'pathogen',
        record_code: caseHit.record_code,
        source: 'device',
        auth_mode: authMode,
        device_no: device.device_no,
        school_code: device.school_code,
        round: roundNo,
        chip_number: payload.chipNumber,
      }, ip)
      prisma.pathogenDevice
        .update({
          where: { id: device.id },
          data: { upload_count: { increment: 1 }, last_upload_at: new Date(), last_used_at: new Date() },
        })
        .catch((e) => console.warn(`${TAG} 设备统计落库失败:`, e.message))
      console.log(`${TAG} 设备复测轮次入库: device=${device.device_no} school=${device.school_code} record=${caseHit.record_code} round=${roundNo}`)
      return reply(res, 200, 0, 'success', { reportId: caseHit.record_code, round: roundNo, appended: true })
    }

    // ── ⑨ 绑定用户校验（created_by not-null 外键的审计归属） ──
    const binding = await assertBindingUser(prisma, device.school_code, device.binding_user_id, factory)
    if (!binding.ok) {
      logDeniedThrottled(ip, 'BINDING_USER_MISSING', { path, deviceNo: device.device_no })
      return reply(res, 422, 'BINDING_USER_MISSING', `${binding.message}；请在控制台为该设备改绑有效用户`)
    }

    // ── ⑩ 写入（与手动导入同一记录结构 / 同一租户 schema） ──
    const writeData = buildRecordWriteData('pathogen', built.data)
    if (!writeData.ok) {
      logDeniedThrottled(ip, 'VALIDATION_ERROR', { path, deviceNo: device.device_no })
      return reply(res, 400, 'VALIDATION_ERROR', `参数校验失败：${writeData.message}`)
    }

    let record
    try {
      record = await db.testRecord.create({
        data: {
          record_code: recordCode,
          created_by: device.binding_user_id,
          version: 1,
          ...writeData.data,
        },
      })
    } catch (e) {
      // P2002：并发重复上传 → 幂等返回既有记录
      if (e.code === 'P2002' || String(e.message || '').includes('Unique constraint')) {
        try {
          const existing = await db.testRecord.findUnique({ where: { record_code: recordCode } })
          if (existing) {
            return reply(res, 200, 0, 'success', { reportId: existing.record_code, duplicated: true })
          }
        } catch (_) { /* fallthrough */ }
      }
      console.error(`${TAG} 记录写入异常:`, e)
      return reply(res, 500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试')
    }

    // ── ⑪ 审计与统计（非阻断）──
    // auth_mode 入审计：事后可区分「设备密钥（严格模式）」与「统一上传密钥」两种来源
    await writeRecordAuditLog(db, device.binding_user_id, 'create', 'test_record', record.id, {
      test_type: 'pathogen',
      record_code: recordCode,
      source: 'device',
      auth_mode: authMode,
      device_no: device.device_no,
      school_code: device.school_code,
    }, ip)
    prisma.pathogenDevice
      .update({
        where: { id: device.id },
        data: { upload_count: { increment: 1 }, last_upload_at: new Date(), last_used_at: new Date() },
      })
      .catch((e) => console.warn(`${TAG} 设备统计落库失败:`, e.message))

    console.log(`${TAG} 设备上报入库: device=${device.device_no} school=${device.school_code} record=${recordCode}`)
    return reply(res, 200, 0, 'success', { reportId: record.record_code })
  })

  return router
}

// ───────────────────────── ② 超管配置面 ─────────────────────────

export function createAdminPathogenDeviceRoutes({ prisma, authenticateUser, requirePlatformSuperAdmin, tenantClientFactory }) {
  const router = express.Router()
  router.use(authenticateUser, requirePlatformSuperAdmin)

  /** 新增/修改共用的字段归一（返回 { ok, data } 或 { ok:false, message }）。 */
  async function normalizeDeviceInput(body, { schoolCodeFixed = null } = {}) {
    const errors = []
    const str = (v) => (typeof v === 'string' ? v.trim() : '')

    const deviceNo = str(body.device_no)
    if (!deviceNo) errors.push('device_no 不能为空')
    else if (!DEVICE_NO_RE.test(deviceNo)) errors.push('device_no 仅允许字母/数字/连字符/下划线（1~64 位）')

    const schoolCode = schoolCodeFixed ?? str(body.school_code)
    if (!schoolCode) errors.push('school_code 不能为空')
    else if (!isValidSchoolCode(schoolCode)) errors.push('school_code 非法（仅小写字母/数字/连字符，1~40 位）')

    const bindingUserId = str(body.binding_user_id)
    if (!bindingUserId) errors.push('binding_user_id 不能为空（记录创建人，该校租户内有效用户）')

    const name = str(body.name)
    if (name.length > MAX_DEVICE_NAME) errors.push(`备注名长度不能超过 ${MAX_DEVICE_NAME}`)

    const defaultCanteen = body.default_canteen == null || body.default_canteen === '' ? null : str(body.default_canteen)
    if (defaultCanteen && defaultCanteen.length > 60) errors.push('默认食堂长度不能超过 60')

    let rateLimit = DEFAULT_RATE_LIMIT
    if (body.rate_limit_per_min != null && body.rate_limit_per_min !== '') {
      const n = Number(body.rate_limit_per_min)
      if (!Number.isInteger(n) || n < 1 || n > MAX_RATE_LIMIT) errors.push(`rate_limit_per_min 必须是 1~${MAX_RATE_LIMIT} 的整数`)
      else rateLimit = n
    }

    let ipWhitelist = null
    if (body.ip_whitelist != null) {
      if (!Array.isArray(body.ip_whitelist)) errors.push('ip_whitelist 必须是数组')
      else if (body.ip_whitelist.length > MAX_IP_ENTRIES) errors.push(`ip_whitelist 最多 ${MAX_IP_ENTRIES} 条`)
      else if (body.ip_whitelist.some((ip) => !IP_OR_CIDR_RE.test(String(ip || '').trim()))) errors.push('ip_whitelist 含非法 IP/CIDR')
      else ipWhitelist = body.ip_whitelist.map((ip) => String(ip).trim())
    }

    if (errors.length) return { ok: false, message: errors[0] }

    // 引用完整性：学校存在且启用
    const school = await prisma.school.findUnique({
      where: { code: schoolCode },
      select: { id: true, code: true, name: true, status: true },
    })
    if (!school) return { ok: false, message: `学校 ${schoolCode} 不存在` }
    if (school.status !== 'active') return { ok: false, message: `学校 ${schoolCode} 已停用，不能配置设备` }

    // 默认食堂须在该校食堂名单内（防随手填错导致归属混乱）
    if (defaultCanteen) {
      const canteens = await loadSchoolCanteens(prisma, schoolCode)
      if (canteens.length && !canteens.includes(defaultCanteen)) {
        return { ok: false, message: `默认食堂「${defaultCanteen}」不在该校食堂名单（${canteens.join('、')}）内` }
      }
    }

    // 绑定用户必须存在于该校租户
    const binding = await assertBindingUser(prisma, schoolCode, bindingUserId, tenantClientFactory)
    if (!binding.ok) return { ok: false, message: binding.message }

    return {
      ok: true,
      data: { deviceNo, schoolCode, bindingUserId, name: name || null, defaultCanteen, rateLimit, ipWhitelist },
    }
  }

  // ── 查询 ──
  router.get('/', async (req, res) => {
    try {
      const schoolCode = typeof req.query.school_code === 'string' ? req.query.school_code.trim() : ''
      const where = schoolCode ? { school_code: schoolCode } : {}
      const rows = await prisma.pathogenDevice.findMany({
        where,
        orderBy: [{ school_code: 'asc' }, { created_at: 'asc' }],
      })
      res.json({ success: true, data: rows.map(toDeviceView), total: rows.length })
    } catch (e) {
      console.error(`${TAG} 设备列表查询失败:`, e)
      res.status(500).json({ success: false, error: '查询失败' })
    }
  })

  // ── 导出（灾后重建；含 key_hash，不含明文） ──
  router.get('/export', async (_req, res) => {
    try {
      const rows = await prisma.pathogenDevice.findMany({ orderBy: { created_at: 'asc' } })
      // 统一上传密钥（单活：仅导最新一行；含 key_hash、不含明文——灾后重建用）
      const pkRow = await prisma.pathogenUploadKey.findFirst({ orderBy: [{ created_at: 'desc' }, { id: 'desc' }] })
      res.json({
        success: true,
        data: {
          version: 1,
          exported_at: new Date().toISOString(),
          devices: rows.map((r) => ({
            id: r.id,
            device_no: r.device_no,
            school_code: r.school_code,
            name: r.name ?? null,
            binding_user_id: r.binding_user_id,
            default_canteen: r.default_canteen ?? null,
            status: r.status,
            key_hash: r.key_hash,
            key_prefix: r.key_prefix,
            key_last4: r.key_last4,
            rate_limit_per_min: r.rate_limit_per_min,
            ip_whitelist: Array.isArray(r.ip_whitelist) ? r.ip_whitelist : [],
          })),
          // 统一上传密钥（B 方案）：仅最新一行（单活）；不含明文
          platform_key: pkRow ? {
            key_hash: pkRow.key_hash,
            key_prefix: pkRow.key_prefix,
            key_last4: pkRow.key_last4,
            status: pkRow.status,
          } : null,
        },
      })
    } catch (e) {
      console.error(`${TAG} 设备导出失败:`, e)
      res.status(500).json({ success: false, error: '导出失败' })
    }
  })

  // ── 统一上传密钥（B 方案）：查询 / 创建或轮换 / 启停 ──
  // 语义：全平台单活——同一时刻至多一行 status='active'（创建/轮换 = 停旧 + 建新，保留历史行）。
  // ⚠️ 静态路由必须先于 `/:id` 动态路由注册（Express 按注册顺序匹配，否则 'platform-key' 会被当作 id）。
  const platformKeyView = (row) => (row ? {
    id: row.id,
    status: row.status,
    key_prefix: row.key_prefix,
    key_last4: row.key_last4,
    disabled_at: row.disabled_at ?? null,
    last_used_at: row.last_used_at ?? null,
    created_at: row.created_at ?? null,
  } : null)

  router.get('/platform-key', async (_req, res) => {
    try {
      const row = await prisma.pathogenUploadKey.findFirst({ orderBy: [{ created_at: 'desc' }, { id: 'desc' }] })
      res.json({ success: true, data: { exists: !!row, key: platformKeyView(row) } })
    } catch (e) {
      console.error(`${TAG} 统一密钥查询失败:`, e)
      res.status(500).json({ success: false, error: '查询失败' })
    }
  })

  // 创建或轮换：停用现有 active 行 + 插入新行（同一事务，外部无"双活"窗口）；明文仅此一次返回
  router.post('/platform-key', async (req, res) => {
    try {
      const key = generateDeviceKey()
      // 单活：先停用全部 active 行，再建新行（同一事务；外部无"双活"窗口）
      const [disableResult, created] = await prisma.$transaction([
        prisma.pathogenUploadKey.updateMany({
          where: { status: 'active' },
          data: { status: 'disabled', disabled_at: new Date() },
        }),
        prisma.pathogenUploadKey.create({
          data: {
            key_hash: key.hash,
            key_prefix: key.prefix,
            key_last4: key.last4,
            status: 'active',
            created_by: req.user?.userId || null,
          },
        }),
      ])
      const rotated = Number(disableResult?.count) > 0
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.platformKey,
        actor: req.user?.userId || null,
        targetId: created.id,
        targetSchoolCode: null,
        details: { rotated, key_prefix: created.key_prefix, key_last4: created.key_last4 },
      })
      res.json({ success: true, data: { apiKey: key.plain, rotated, key: platformKeyView(created) } })
    } catch (e) {
      console.error(`${TAG} 统一密钥创建/轮换失败:`, e)
      res.status(500).json({ success: false, error: '创建或轮换失败' })
    }
  })

  // 启停：作用于最新一行（单活语义下即当前生效密钥）
  router.patch('/platform-key', async (req, res) => {
    try {
      const status = req.body?.status
      if (status !== 'active' && status !== 'disabled') return badRequest(res, "status 必须为 'active' 或 'disabled'")
      const row = await prisma.pathogenUploadKey.findFirst({ orderBy: [{ created_at: 'desc' }, { id: 'desc' }] })
      if (!row) return badRequest(res, '尚未创建统一上传密钥（请先「创建」）')
      const updated = await prisma.pathogenUploadKey.update({
        where: { id: row.id },
        data: status === 'disabled'
          ? { status: 'disabled', disabled_at: new Date() }
          : { status: 'active', disabled_at: null },
      })
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.platformKeyToggle,
        actor: req.user?.userId || null,
        targetId: updated.id,
        targetSchoolCode: null,
        details: { status: updated.status },
      })
      res.json({ success: true, data: platformKeyView(updated) })
    } catch (e) {
      console.error(`${TAG} 统一密钥启停失败:`, e)
      res.status(500).json({ success: false, error: '启停失败' })
    }
  })

  // ── 导入（按 id upsert；用于重建/迁移，不动明文密钥） ──
  router.post('/import', async (req, res) => {
    try {
      const list = Array.isArray(req.body?.devices) ? req.body.devices : null
      if (!list) return badRequest(res, 'devices 必须为数组')
      if (list.length > 500) return badRequest(res, '单次最多导入 500 条')
      let upserted = 0
      for (const item of list) {
        if (!item?.id || !item?.device_no || !item?.school_code || !item?.key_hash) {
          return badRequest(res, '导入项缺少 id/device_no/school_code/key_hash')
        }
        await prisma.pathogenDevice.upsert({
          where: { id: String(item.id) },
          create: {
            id: String(item.id),
            device_no: String(item.device_no),
            school_code: String(item.school_code),
            binding_user_id: String(item.binding_user_id || ''),
            name: item.name ?? null,
            default_canteen: item.default_canteen ?? null,
            status: item.status === 'disabled' ? 'disabled' : 'active',
            key_hash: String(item.key_hash),
            key_prefix: String(item.key_prefix || 'pdv_'),
            key_last4: String(item.key_last4 || '****'),
            rate_limit_per_min: Number(item.rate_limit_per_min) > 0 ? Number(item.rate_limit_per_min) : DEFAULT_RATE_LIMIT,
            ip_whitelist: Array.isArray(item.ip_whitelist) ? item.ip_whitelist : null,
          },
          update: {
            device_no: String(item.device_no),
            school_code: String(item.school_code),
            binding_user_id: String(item.binding_user_id || ''),
            name: item.name ?? null,
            default_canteen: item.default_canteen ?? null,
            status: item.status === 'disabled' ? 'disabled' : 'active',
            key_hash: String(item.key_hash),
            key_prefix: String(item.key_prefix || 'pdv_'),
            key_last4: String(item.key_last4 || '****'),
            rate_limit_per_min: Number(item.rate_limit_per_min) > 0 ? Number(item.rate_limit_per_min) : DEFAULT_RATE_LIMIT,
            ip_whitelist: Array.isArray(item.ip_whitelist) ? item.ip_whitelist : null,
          },
        })
        upserted += 1
      }
      // 统一上传密钥（可选）：按 key_hash 去重 upsert——已存在则跳过（不覆盖，避免重建时误换生效密钥）
      const pkIn = req.body?.platform_key
      if (pkIn && typeof pkIn === 'object' && pkIn.key_hash) {
        const dup = await prisma.pathogenUploadKey.findUnique({ where: { key_hash: String(pkIn.key_hash) }, select: { id: true } })
        if (!dup) {
          await prisma.pathogenUploadKey.create({
            data: {
              key_hash: String(pkIn.key_hash),
              key_prefix: String(pkIn.key_prefix || 'pdv_'),
              key_last4: String(pkIn.key_last4 || '****'),
              status: pkIn.status === 'disabled' ? 'disabled' : 'active',
            },
          })
          upserted += 1
        }
      }
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.import,
        actor: req.user?.userId || null,
        details: { upserted },
      })
      res.json({ success: true, data: { upserted } })
    } catch (e) {
      console.error(`${TAG} 设备导入失败:`, e)
      res.status(500).json({ success: false, error: '导入失败' })
    }
  })

  // ── 新增 ──
  router.post('/', async (req, res) => {
    try {
      const norm = await normalizeDeviceInput(req.body || {})
      if (!norm.ok) return badRequest(res, norm.message)
      const { deviceNo, schoolCode, bindingUserId, name, defaultCanteen, rateLimit, ipWhitelist } = norm.data

      const dup = await prisma.pathogenDevice.findUnique({ where: { device_no: deviceNo }, select: { id: true } })
      if (dup) return badRequest(res, `设备编号 ${deviceNo} 已存在（全局唯一）`)

      const key = generateDeviceKey()
      const row = await prisma.pathogenDevice.create({
        data: {
          device_no: deviceNo,
          school_code: schoolCode,
          binding_user_id: bindingUserId,
          name,
          default_canteen: defaultCanteen,
          rate_limit_per_min: rateLimit,
          ip_whitelist: ipWhitelist,
          key_hash: key.hash,
          key_prefix: key.prefix,
          key_last4: key.last4,
          created_by: req.user?.userId || null,
        },
      })
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.create,
        actor: req.user?.userId || null,
        targetId: row.id,
        targetSchoolCode: schoolCode,
        details: { device_no: deviceNo, binding_user_id: bindingUserId, default_canteen: defaultCanteen },
      })
      // 明文密钥仅此一次返回
      res.json({ success: true, data: { ...toDeviceView(row), apiKey: key.plain } })
    } catch (e) {
      if (e.code === 'P2002') return badRequest(res, '设备编号已存在（全局唯一）')
      console.error(`${TAG} 设备新增失败:`, e)
      res.status(500).json({ success: false, error: '新增失败' })
    }
  })

  // ── 修改 ──
  router.patch('/:id', async (req, res) => {
    try {
      const row = await prisma.pathogenDevice.findUnique({ where: { id: req.params.id } })
      if (!row) return res.status(404).json({ success: false, error: '设备不存在' })

      const body = req.body || {}
      // device_no / school_code 不可变（变更 = 删旧建新，保证映射稳定与已上传记录归属清晰）
      if (body.device_no != null && String(body.device_no).trim() !== row.device_no) {
        return badRequest(res, 'device_no 不可修改；如需变更请删除后重新配置')
      }
      if (body.school_code != null && String(body.school_code).trim() !== row.school_code) {
        return badRequest(res, 'school_code 不可修改；如需变更请删除后重新配置')
      }

      const norm = await normalizeDeviceInput(
        {
          device_no: row.device_no,
          school_code: row.school_code,
          binding_user_id: body.binding_user_id ?? row.binding_user_id,
          name: body.name ?? row.name ?? '',
          default_canteen: body.default_canteen ?? row.default_canteen,
          rate_limit_per_min: body.rate_limit_per_min ?? row.rate_limit_per_min,
          ip_whitelist: body.ip_whitelist ?? row.ip_whitelist,
        },
        { schoolCodeFixed: row.school_code },
      )
      if (!norm.ok) return badRequest(res, norm.message)

      const patch = {
        binding_user_id: norm.data.bindingUserId,
        name: norm.data.name,
        default_canteen: norm.data.defaultCanteen,
        rate_limit_per_min: norm.data.rateLimit,
        ...(norm.data.ipWhitelist ? { ip_whitelist: norm.data.ipWhitelist } : {}),
      }

      // 启停
      if (body.status != null) {
        if (!['active', 'disabled'].includes(String(body.status))) return badRequest(res, 'status 仅支持 active / disabled')
        if (String(body.status) !== row.status) {
          if (body.status === 'disabled') {
            patch.status = 'disabled'
            patch.disabled_at = new Date()
            patch.disabled_reason = String(body.disabled_reason ?? '').slice(0, MAX_DISABLED_REASON) || null
          } else {
            patch.status = 'active'
            patch.disabled_at = null
            patch.disabled_reason = null
          }
        }
      }

      const updated = await prisma.pathogenDevice.update({ where: { id: row.id }, data: patch })
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.update,
        actor: req.user?.userId || null,
        targetId: row.id,
        targetSchoolCode: row.school_code,
        details: { device_no: row.device_no, changed: Object.keys(patch) },
      })
      res.json({ success: true, data: toDeviceView(updated) })
    } catch (e) {
      console.error(`${TAG} 设备修改失败:`, e)
      res.status(500).json({ success: false, error: '修改失败' })
    }
  })

  // ── 删除 ──
  router.delete('/:id', async (req, res) => {
    try {
      const row = await prisma.pathogenDevice.findUnique({ where: { id: req.params.id } })
      if (!row) return res.status(404).json({ success: false, error: '设备不存在' })
      await prisma.pathogenDevice.delete({ where: { id: row.id } })
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.remove,
        actor: req.user?.userId || null,
        targetId: row.id,
        targetSchoolCode: row.school_code,
        details: { device_no: row.device_no },
      })
      res.json({ success: true, message: '已删除；该设备已上传的记录不受影响' })
    } catch (e) {
      console.error(`${TAG} 设备删除失败:`, e)
      res.status(500).json({ success: false, error: '删除失败' })
    }
  })

  // ── 轮换密钥（旧密钥立即失效） ──
  router.post('/:id/rotate-key', async (req, res) => {
    try {
      const row = await prisma.pathogenDevice.findUnique({ where: { id: req.params.id } })
      if (!row) return res.status(404).json({ success: false, error: '设备不存在' })
      const key = generateDeviceKey()
      const updated = await prisma.pathogenDevice.update({
        where: { id: row.id },
        data: { key_hash: key.hash, key_prefix: key.prefix, key_last4: key.last4 },
      })
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.rotate,
        actor: req.user?.userId || null,
        targetId: row.id,
        targetSchoolCode: row.school_code,
        details: { device_no: row.device_no },
      })
      res.json({ success: true, data: { ...toDeviceView(updated), apiKey: key.plain } })
    } catch (e) {
      console.error(`${TAG} 密钥轮换失败:`, e)
      res.status(500).json({ success: false, error: '轮换失败' })
    }
  })

  return router
}

export default { createPathogenDeviceUploadRoutes, createAdminPathogenDeviceRoutes }
