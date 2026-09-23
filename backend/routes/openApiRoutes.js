// openApiRoutes.js — 开放接口（第三方只读数据拉取）
//
// 挂载：server.js `app.use('/api/open', openApiRoutes)`，认证走 createOpenApiAuth
// （API Key，见 middleware/openApiAuth.js），**不经过人类 JWT / req.db**。
//
// 端点（全部只读，无任何写入路径）：
//   GET /api/open/v1/ping                      — 连通性 + 服务器时间（接入自检、时钟对齐）
//   GET /api/open/v1/profile                   — 当前 Key 的身份与授权范围（含 scope_version）
//   GET /api/open/v1/schools                   — 授权范围内的学校列表
//   GET /api/open/v1/dict?school_code=         — 字典：开放类型 / 食堂列表 / 结论枚举
//   GET /api/open/v1/test-records?...          — 检测记录**增量拉取**（游标分页）
//   GET /api/open/v1/sync/manifest?...         — 全量清单（对账/删除感知：本地有、清单无 = 已删除）
//   GET /api/open/v1/stats?...                 — 合格率统计（对账用，口径同员工端 /api/test-records/stats）
//
// 同步协议（与对接文档一致）：
//   ① 每轮同步先调 manifest（默认只回 total+digest），digest 一致即结束；
//   ② digest 变化 → detail=1 拉全量清单，本地 diff 出「新增/变更/删除」；
//   ③ 变更明细用 test-records 的游标增量拉取（游标内含授权指纹，授权变更必然 409 → 重新同步）；
//   ④ 游标水位基于 (updated_at, id)：**不用 created_at**（历史导入数据的 created_at 是业务日期）。
//
// 安全边界：school_code 必须命中该对接方的 grant（active），否则 403；类型必须命中 grant 白名单。

import express from 'express'
import { createOpenApiAuth } from '../middleware/openApiAuth.js'
import { createTenantClient, schemaNameOf, isValidSchoolCode, assertSafeSchemaName } from '../lib/tenantClient.js'
import {
  resolveGrantTypes,
  grantAllowsType,
  grantDateRange,
  grantDateSqlClause,
  buildOpenRecord,
  encodeCursor,
  decodeCursor,
  computeManifestDigest,
  computeFiltersFingerprint,
  computeProjectionFingerprint,
  recordChangeToken,
  CURRENT_CURSOR_VERSION,
  toIsoShanghai,
  BUSINESS_DATE_TEXT_EXPR,
  businessDateValidSql,
  parseDayParam,
  maxDay,
  minDay,
} from '../lib/openApiScope.js'
import { DEFAULT_OPEN_TYPES } from '../lib/openApiScope.js'
import { OPEN_API_CONTRACT_VERSION, listFieldDescriptors, buildSyntheticSamples, extractCustomFieldMeta, buildAllowedResultKeyMap, allowedKeysFingerprint } from '../lib/openApiFieldSchema.js'

const TAG = '[openApiRoutes]'
const MAX_PAGE_SIZE = 200
const DEFAULT_PAGE_SIZE = 100
const MANIFEST_ITEM_CAP = 20000   // 单校清单条数上限（超出需改分页，见对接文档阈值说明）

const CONCLUSION_ENUM = [
  { code: 'pass', label: '合格' },
  { code: 'fail', label: '不合格' },
  { code: 'warning', label: '警戒' },
  { code: 'unknown', label: '未判定' },
]

/**
 * 把 Date 转成「UTC 墙钟字符串」（'YYYY-MM-DD HH:mm:ss.SSS'），用于与 `timestamp`(无时区) 列比较。
 *
 * ⚠️ 必须这样传：TestRecord.updated_at 是 `timestamp without time zone`，Prisma 写入/读出的是
 * UTC 墙钟值（读回为 Date 时按 UTC 解释）。若直接把 JS Date 作为 SQL 参数绑定，PostgreSQL 会
 * 按 timestamptz 语义与会话时区（生产为 Asia/Shanghai）比较，等于把列值整体 +8h，
 * 造成 `updated_at > 水位` 每页跳过 8 小时窗口的数据（2026-09-15 实测：1129 条只翻出 407 条）。
 * 传无时区字符串 + `::timestamp` 强转即可消除该偏移。
 */
function toUtcWallClock(d) {
  const dt = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString().slice(0, 23).replace('T', ' ')
}

function ok(res, data) {
  return res.json({ code: 0, data: { ...data, server_time: toIsoShanghai(new Date()) } })
}

function fail(res, status, code, message) {
  return res.status(status).json({ code, error: message, server_time: toIsoShanghai(new Date()) })
}

/**
 * 把日期范围翻译成 SQL 条件（业务检测日期，取 sample_info.testDate 前 10 位）。
 *
 * ⚠️ 只做**文本比较**，绝不与 `::date` 混用：业务日期在库内是文本，PostgreSQL 没有 text→date
 * 隐式转换，`substring(...) >= $N::date` 会直接报 `operator does not exist: text >= date`（2026-09-16 线上 500 根因）。
 * 比较前先过合法性正则，避免 `2026-1-1` 这类脏值被字典序误判入范围。
 *
 * @param {{start?:string|null, end?:string|null}} range 已归一的 YYYY-MM-DD（null = 不限）
 * @param {Array} params 参数数组（原地追加）
 * @returns {string} 以 ' AND ' 开头的 SQL 片段（无范围时为空串）
 */
function dateRangeClause(range, params) {
  const parts = []
  const valid = businessDateValidSql()
  if (range?.start) {
    params.push(range.start)
    parts.push(`(${valid} AND ${BUSINESS_DATE_TEXT_EXPR} >= $${params.length})`)
  }
  if (range?.end) {
    params.push(range.end)
    parts.push(`(${valid} AND ${BUSINESS_DATE_TEXT_EXPR} <= $${params.length})`)
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : ''
}

/** 授权范围（grant.start_date/end_date）对应的 SQL 条件。 */
function dateClause(grant, params) {
  return grantDateSqlClause(grant, params)
}

/** 授权范围 ∩ 请求范围（两者都可为 null = 不限）。 */
function effectiveDateRange(grant, query = {}) {
  const g = grantDateRange(grant)
  const s = parseDayParam(query.start)
  const e = parseDayParam(query.end)
  if (!s.ok) return { ok: false, code: 'INVALID_START', message: `start 参数非法：${s.message}` }
  if (!e.ok) return { ok: false, code: 'INVALID_END', message: `end 参数非法：${e.message}` }
  if (s.day && e.day && s.day > e.day) {
    return { ok: false, code: 'INVALID_RANGE', message: `start(${s.day}) 不能晚于 end(${e.day})` }
  }
  return {
    ok: true,
    requested: { start: s.day, end: e.day },
    grantRange: g,
    effective: { start: maxDay(s.day, g.start), end: minDay(e.day, g.end) },
  }
}

export function createOpenApiRoutes({ prisma }) {
  const router = express.Router()
  const openApiAuth = createOpenApiAuth({ prisma })

  // ── 认证：所有 /v1/* 均需有效 API Key ──
  router.use('/v1', openApiAuth)

  /** 读取某个对接方的全部授权（含已停用，便于 profile 展示）。 */
  async function loadGrants(clientId) {
    const rows = await prisma.openApiGrant.findMany({
      where: { client_id: clientId },
      orderBy: { school_code: 'asc' },
    })
    const map = new Map()
    for (const g of rows) map.set(g.school_code, g)
    return map
  }

  /** 校验 school_code：格式合法 + 命中 active grant。返回 { grant, schema, school }。 */
  async function resolveSchool(req, res, schoolCode) {
    const code = String(schoolCode || '').trim()
    if (!isValidSchoolCode(code)) {
      fail(res, 400, 'INVALID_SCHOOL_CODE', 'school_code 格式非法')
      return null
    }
    const grants = await loadGrants(req.openApi.client.id)
    const grant = grants.get(code)
    if (!grant || grant.status !== 'active') {
      fail(res, 403, 'SCHOOL_NOT_AUTHORIZED', `未授权访问学校 ${code}`)
      return null
    }
    const school = await prisma.school.findUnique({ where: { code }, select: { code: true, name: true, short_name: true, status: true } })
    if (!school || school.status !== 'active') {
      fail(res, 404, 'SCHOOL_NOT_FOUND', '学校不存在或已停用')
      return null
    }
    const schema = schemaNameOf(code)
    assertSafeSchemaName(schema)
    return { grant, schema, school }
  }

  /**
   * 与字段字典**同源**的下发白名单（按类型）：未登记的 `result.*` 键不下发。
   * 学校自定义字段取自 SchoolCustomization，因此不会一刀切掉在用字段。
   * （2026-09-16 审阅 M2：原实现为纯黑名单，未登记字段会无条件外发。）
   */
  async function allowedKeysForSchool(schoolCode, types) {
    const cust = await prisma.schoolCustomization.findUnique({ where: { school_code: schoolCode } })
    return buildAllowedResultKeyMap(types, (t) => extractCustomFieldMeta(cust, t))
  }

  /**
   * 学校"影响输出的配置"指纹（2026-09-17 审阅 F6）：与 allowedKeysForSchool 同源，
   * 但抽取为稳定哈希，供 projection_fingerprint 使用 —— 使**自定义字段导致的可见性变化**
   * 也能改变指纹与 manifest digest，触发客户端重投影。
   */
  async function projectionExtra(schoolCode, types) {
    const cust = await prisma.schoolCustomization.findUnique({ where: { school_code: schoolCode } })
    return allowedKeysFingerprint(types, (t) => extractCustomFieldMeta(cust, t))
  }

  // ─────────────── GET /v1/ping ───────────────
  router.get('/v1/ping', (req, res) => {
    ok(res, {
      client_name: req.openApi.client.name,
      credential_label: req.openApi.credential.label,
      credential_prefix: req.openApi.credential.key_prefix,
    })
  })

  // ─────────────── GET /v1/profile ───────────────
  router.get('/v1/profile', async (req, res) => {
    try {
      const client = req.openApi.client
      const grants = await loadGrants(client.id)
      const codes = [...grants.keys()]
      const schools = codes.length
        ? await prisma.school.findMany({ where: { code: { in: codes } }, select: { code: true, name: true, short_name: true, status: true } })
        : []
      const nameOf = new Map(schools.map((s) => [s.code, s]))
      ok(res, {
        client: { name: client.name, rate_limit_per_min: client.rate_limit_per_min },
        credential: {
          label: req.openApi.credential.label,
          prefix: req.openApi.credential.key_prefix,
          last4: req.openApi.credential.key_last4,
          expires_at: toIsoShanghai(req.openApi.credential.expires_at),
        },
        grants: [...grants.values()].map((g) => {
          const { start, end } = grantDateRange(g)
          return {
            school_code: g.school_code,
            school_name: nameOf.get(g.school_code)?.name || null,
            status: g.status,
            scope_version: g.scope_version,
            visible_types: resolveGrantTypes(g),
            include_pathogen: g.include_pathogen === true,
            include_inspector: g.include_inspector === true,
            include_attachments: g.include_attachments === true,
            start_date: start,
            end_date: end,
          }
        }),
      })
    } catch (e) {
      console.error(`${TAG} profile 失败:`, e)
      fail(res, 500, 'INTERNAL_ERROR', '读取授权信息失败')
    }
  })

  // ─────────────── GET /v1/schools ───────────────
  router.get('/v1/schools', async (req, res) => {
    try {
      const grants = await loadGrants(req.openApi.client.id)
      const codes = [...grants.values()].filter((g) => g.status === 'active').map((g) => g.school_code)
      const rows = codes.length
        ? await prisma.school.findMany({
            where: { code: { in: codes }, status: 'active' },
            select: { code: true, name: true, short_name: true },
            orderBy: { code: 'asc' },
          })
        : []
      ok(res, { schools: rows.map((s) => ({ school_code: s.code, school_name: s.name, short_name: s.short_name })) })
    } catch (e) {
      console.error(`${TAG} schools 失败:`, e)
      fail(res, 500, 'INTERNAL_ERROR', '读取学校列表失败')
    }
  })

  // ─────────────── GET /v1/dict ───────────────
  router.get('/v1/dict', async (req, res) => {
    try {
      const ctx = await resolveSchool(req, res, req.query.school_code)
      if (!ctx) return
      const { grant, school } = ctx
      // 食堂列表：优先 SchoolCustomization.canteens，回退 field_options.canteen
      const cust = await prisma.schoolCustomization.findUnique({ where: { school_code: school.code } })
      const canteens = Array.isArray(cust?.canteens)
        ? cust.canteens.map((c) => String(c))
        : (Array.isArray(cust?.field_options?.canteen) ? cust.field_options.canteen.map((c) => String(c)) : [])

      // 字段字典：仅对**当前凭证据此学校已开放的类型**下发；字段定义与实际响应同源（openApiFieldSchema）
      const visibleTypes = resolveGrantTypes(grant)
      if (!visibleTypes.length) return fail(res, 403, 'NO_VISIBLE_TYPE', '该学校当前未开放任何检测类型')
      const field_schema = {}
      for (const t of visibleTypes) {
        const meta = extractCustomFieldMeta(cust, t)
        field_schema[t] = {
          contract_version: OPEN_API_CONTRACT_VERSION,
          field_count: listFieldDescriptors(t, meta).length,
          fields: listFieldDescriptors(t, meta),
        }
      }

      ok(res, {
        contract_version: OPEN_API_CONTRACT_VERSION,
        school_code: school.code,
        school_name: school.name,
        scope_version: grant.scope_version,
        visible_types: visibleTypes,
        default_visible_types: DEFAULT_OPEN_TYPES,
        canteens,
        conclusions: CONCLUSION_ENUM,
        field_schema,
        field_schema_notes: [
          '字段路径按对外响应书写：顶层字段直接给出；检测业务字段统一在 result.* 下。',
          'required 是**当前数据分布观察**（true = 该类型现有全部记录都出现该字段），**不是接口输出保证**：'
            + '不要据此在本地建 NOT NULL / 必填模型；容错解析请以 nullable 与「下发」列为准。',
          '三态区分：**字段省略** = 该字段不存在（未登记或未启用）；**null** = 字段存在但无值；**空字符串/空数组** = 有值但为空（如 result.remark 可为 ""、result.positiveDetails 可为 []）。',
          'type=unknown 表示平台不保证其类型（通常来自学校自定义字段），需按实际值处理。',
          'emitted=false 表示该字段「不会出现在响应中」——列出仅为说明原始存储结构，请勿据此开发（如 result.inspector，属个人信息恒不下发）。',
          '结论字段（initial_conclusion / final_conclusion / conclusion）由平台按**录入时保存的判定文本**映射为枚举（result / colorLevel / riskLevel / finalStatus / 复检结论），'
            + '不是按当前阈值实时重算，因此不会因阈值调整而改变；conclusion_source=stored 即指这一点。',
          '数值类字段一律为**字符串且为原始录入口径**（平台不做换算、不做缩放）；'
            + '⚠️ 例：result.tpmValue 的 "0.06" 是**原始保存值**：其 `unit`（g/100g）是**平台界面标注**，'
            + '`unit_verified:false` 表示**尚未获得设备协议/计量文件核实** —— 请勿自行换算（不要 ×100 或 ÷100），'
            + '也不要据该字段重新判定历史结论；阈值（≤0.13 / ≤0.25）同属当前实现口径，待核验；'
            + '各类型的判定阈值写在对应字段说明里，数组元素的子键见 item_fields。',
          '病原体：riskLevel 非「无风险」即视为不合格/有风险（与统计口径一致），但**不等于确诊阳性**；是否检出以 result.positiveDetails 是否非空为准。',
          'result 内的 canteen / testDate 是历史记录的**同义副本**（新记录不再写入），取值一律以顶层为准。',
          '平台承诺：v1 契约内不删除字段、不改变既有字段语义；新增字段以向后兼容方式追加。',
        ],
      })
    } catch (e) {
      console.error(`${TAG} dict 失败:`, e)
      fail(res, 500, 'INTERNAL_ERROR', '读取字典失败')
    }
  })

  // ─────────────── GET /v1/samples（合成样例）───────────────
  // 用途：对方在没有任何真实数据（或某校刚开通）时也能对着字段开发。
  // 严格为**构造数据**：不抽样自生产记录；record_code 以 SAMPLE- 前缀标记，且 synthetic=true。
  router.get('/v1/samples', async (req, res) => {
    try {
      const ctx = await resolveSchool(req, res, req.query.school_code)
      if (!ctx) return
      const { grant, school } = ctx
      const types = resolveGrantTypes(grant)
      if (!types.length) return fail(res, 403, 'NO_VISIBLE_TYPE', '该学校当前未开放任何检测类型')

      // 字段白名单（与字典同源；2026-09-16 审阅 M2）
      const resultKeyMap = await allowedKeysForSchool(school.code, types)

      let target = types
      if (req.query.test_type) {
        const t = String(req.query.test_type)
        if (!grantAllowsType(grant, t)) return fail(res, 403, 'TYPE_NOT_AUTHORIZED', `未授权的检测类型 ${t}`)
        target = [t]
      }

      const samples = []
      for (const t of target) {
        for (const s of buildSyntheticSamples(t)) {
          // 走与真实记录完全相同的投影 → 样例形态 = 真实响应形态（含 PII 与内部字段剔除）
          const item = buildOpenRecord(s.record, grant, { schoolCode: school.code, schoolName: school.name, allowedResultKeys: resultKeyMap.get(t) })
          samples.push({
            test_type: t,
            scenario: s.scenario,
            synthetic: true,
            note: '合成样例：非真实检测记录，record_code 以 SAMPLE- 开头，请勿写入正式数据集',
            item,
          })
        }
      }

      ok(res, {
        contract_version: OPEN_API_CONTRACT_VERSION,
        school_code: school.code,
        scope_version: grant.scope_version,
        projection_fingerprint: computeProjectionFingerprint(grant, await projectionExtra(school.code, types)),
        visible_types: types,
        include_inspector: grant.include_inspector === true,
        count: samples.length,
        // projection_fingerprint 已在上方按"授权 + 投影修订号 + 学校配置指纹"计算
        samples,
      })
    } catch (e) {
      console.error(`${TAG} samples 失败:`, e)
      fail(res, 500, 'INTERNAL_ERROR', '生成样例失败')
    }
  })

  // ─────────────── GET /v1/test-records（增量拉取）───────────────
  router.get('/v1/test-records', async (req, res) => {
    try {
      const ctx = await resolveSchool(req, res, req.query.school_code)
      if (!ctx) return
      const { grant, schema, school } = ctx

      const limit = Math.min(Math.max(Number(req.query.limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
      const allowedTypes = resolveGrantTypes(grant)
      // 字段白名单（与字典同源；2026-09-16 审阅 M2）
      const resultKeyMap = await allowedKeysForSchool(school.code, allowedTypes)

      // 类型过滤：未指定 = 全部开放类型；指定则必须命中白名单
      let types = allowedTypes
      if (req.query.test_type) {
        const t = String(req.query.test_type)
        if (!grantAllowsType(grant, t)) return fail(res, 403, 'TYPE_NOT_AUTHORIZED', `未授权的检测类型 ${t}`)
        types = [t]
      }
      if (!types.length) return fail(res, 403, 'NO_VISIBLE_TYPE', '该学校当前未开放任何检测类型')

      // 请求级筛选条件指纹（学校 + 类型集合 + until）：游标与筛选条件绑定，
      // 防止"用 A 类型的游标去拉 B 类型"这类换条件复用（那样会静默返回错误的结果集）。
      const untilIso = req.query.until ? String(req.query.until) : null
      const filtersFingerprint = computeFiltersFingerprint({ schoolCode: school.code, types, start: null, end: untilIso })
      // 投影/可见性策略指纹：类型白名单、病原体/检测人/附件开关、业务日期范围、
      // **投影实现修订号 + 学校自定义字段指纹**（F6：仅改投影实现也必须改变指纹）
      const projection = computeProjectionFingerprint(grant, await projectionExtra(school.code, types))

      // 游标：校验版本、学校、筛选条件、授权版本与投影策略
      let watermark = null
      let lastId = ''
      const rawCursor = req.query.cursor ? String(req.query.cursor) : null
      if (rawCursor) {
        const cur = decodeCursor(rawCursor)
        if (!cur) return fail(res, 400, 'INVALID_CURSOR', '游标格式非法')
        if (!cur._current) {
          return fail(res, 409, 'SCOPE_CHANGED', `游标版本过旧（当前 v${CURRENT_CURSOR_VERSION}），同步协议已升级，请重新执行对账同步`)
        }
        if (cur.s !== school.code) return fail(res, 400, 'CURSOR_SCHOOL_MISMATCH', '游标与 school_code 不匹配')
        if (cur.f && cur.f !== filtersFingerprint) {
          return fail(res, 400, 'CURSOR_FILTER_MISMATCH', '游标与本次筛选条件不一致：不可更换 test_type / until 后复用同一游标')
        }
        if (Number(cur.g) !== Number(grant.scope_version) || (cur.p && cur.p !== projection)) {
          return fail(res, 409, 'SCOPE_CHANGED', '授权范围或字段可见性已变更，请重新对账同步后再拉取')
        }
        watermark = new Date(cur.u)
        if (Number.isNaN(watermark.getTime())) return fail(res, 400, 'INVALID_CURSOR', '游标水位非法')
        lastId = String(cur.i)
      } else if (req.query.since) {
        // since 为「重叠回拉」粗筛：不携带 id 决胜位，边界记录可能重复出现（幂等 upsert 可去重），
        // 不作为常规增量手段；常规增量请使用 cursor。
        const since = new Date(String(req.query.since))
        if (Number.isNaN(since.getTime())) return fail(res, 400, 'INVALID_SINCE', 'since 需为 ISO8601 时间')
        watermark = since
      }

      const params = []
      const conds = []
      // 水位条件：(updated_at, id) 复合游标（同一时刻批量导入时靠 id 决胜）。
      // ⚠️ 两个分支必须写成**同一个 OR 组合条件**：若拆成两条 conds，会被下方 join(' AND ')
      // 拼成「A AND B」恒假 → 第二页恒空（2026-09-15 端到端验证抓到的真实 bug）。
      if (watermark) {
        params.push(toUtcWallClock(watermark))
        const pUpdated = params.length
        params.push(lastId)
        const pId = params.length
        conds.push(`("updated_at" > $${pUpdated}::timestamp OR ("updated_at" = $${pUpdated}::timestamp AND "id" > $${pId}))`)
      }
      if (req.query.until) {
        const until = new Date(String(req.query.until))
        if (Number.isNaN(until.getTime())) return fail(res, 400, 'INVALID_UNTIL', 'until 需为 ISO8601 时间')
        params.push(toUtcWallClock(until))
        conds.push(`"updated_at" <= $${params.length}::timestamp`)
      }
      params.push(types)
      conds.push(`"test_type" = ANY($${params.length}::text[])`)

      const dateCond = dateClause(grant, params)
      const whereSql = (conds.length ? `WHERE ${conds.join(' AND ')}` : 'WHERE TRUE') + dateCond

      params.push(limit + 1)
      const sql = `SELECT "id", "record_code", "test_type", "test_name", "sample_info", "result_data", "status", "created_at", "updated_at", "data_version"
                   FROM "${schema}"."TestRecord"
                   ${whereSql}
                   ORDER BY "updated_at" ASC, "id" ASC
                   LIMIT $${params.length}`

      const db = createTenantClient(prisma, school.code)
      const rows = await db.$queryRawUnsafe(sql, ...params)
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      const nextCursor = hasMore && last
        ? encodeCursor({
            schoolCode: school.code,
            scopeVersion: grant.scope_version,
            filtersFingerprint,
            projectionFingerprint: projection,
            updatedAt: new Date(last.updated_at).toISOString(),
            id: last.id,
          })
        : null

      ok(res, {
        contract_version: OPEN_API_CONTRACT_VERSION,
        school_code: school.code,
        school_name: school.name,
        scope_version: grant.scope_version,
        projection_fingerprint: projection,
        visible_types: allowedTypes,
        test_type_filter: req.query.test_type ? String(req.query.test_type) : null,
        count: page.length,
        has_more: hasMore,
        next_cursor: nextCursor,
        items: page.map((r) => buildOpenRecord(r, grant, {
          schoolCode: school.code,
          schoolName: school.name,
          allowedResultKeys: resultKeyMap.get(r.test_type),
        })),
      })
    } catch (e) {
      console.error(`${TAG} test-records 失败:`, e)
      fail(res, 500, 'INTERNAL_ERROR', '读取检测记录失败')
    }
  })

  // ─────────────── GET /v1/sync/manifest（全量清单对账）───────────────
  router.get('/v1/sync/manifest', async (req, res) => {
    try {
      const ctx = await resolveSchool(req, res, req.query.school_code)
      if (!ctx) return
      const { grant, schema, school } = ctx
      const types = resolveGrantTypes(grant)
      if (!types.length) return fail(res, 403, 'NO_VISIBLE_TYPE', '该学校当前未开放任何检测类型')

      const params = [types]
      const dateCond = dateClause(grant, params)
      const db = createTenantClient(prisma, school.code)
      const rows = await db.$queryRawUnsafe(
        `SELECT "record_code", "updated_at" FROM "${schema}"."TestRecord"
         WHERE "test_type" = ANY($1::text[])${dateCond}
         ORDER BY "record_code" ASC`,
        ...params,
      )

      const detail = String(req.query.detail || '') === '1'
      const total = rows.length
      const projection = computeProjectionFingerprint(grant, await projectionExtra(school.code, types))
      // digest 纳入授权版本与投影策略：范围/字段可见性变化也会改变 digest（客户端据此重投影）
      const digest = computeManifestDigest(rows, { scopeVersion: grant.scope_version, projectionFingerprint: projection })
      // ⚠️ 超上限时**明确报错**（413），绝不静默截断成"看似完整"的清单
      if (total > MANIFEST_ITEM_CAP) {
        return fail(res, 413, 'MANIFEST_TOO_LARGE',
          `清单条数 ${total} 超过单次上限 ${MANIFEST_ITEM_CAP}（拒绝返回被截断的清单）。请联系平台改为分页清单对接。`)
      }
      ok(res, {
        contract_version: OPEN_API_CONTRACT_VERSION,
        school_code: school.code,
        scope_version: grant.scope_version,
        projection_fingerprint: projection,
        visible_types: types,
        // 客户端应把 generated_at 与本次同步结束时刻对比：两者之间若有新变更，
        // 本轮结果可能不一致，需再跑一轮（见对接文档「同步轮次一致性」）。
        generated_at: toIsoShanghai(new Date()),
        detail,
        total,
        complete: true,          // 该响应是完整清单（未截断）；为 false 的场景一律以错误码返回
        digest,
        digest_covers: 'cursor_version+scope_version+projection_fingerprint+record_code@updated_at',
        items: detail
          ? rows.map((r) => ({ record_code: r.record_code, updated_at: toIsoShanghai(r.updated_at) }))
          : undefined,
      })
    } catch (e) {
      console.error(`${TAG} manifest 失败:`, e)
      fail(res, 500, 'INTERNAL_ERROR', '读取清单失败')
    }
  })

  // ─────────────── GET /v1/stats（对账用统计）───────────────
  // 口径与员工端 GET /api/test-records/stats 一致；⚠️ testDate 非法/缺失的记录不计入
  // （故条数可能与明细拉取相差极少数脏数据，见对接文档「对账差异说明」）。
  router.get('/v1/stats', async (req, res) => {
    try {
      const ctx = await resolveSchool(req, res, req.query.school_code)
      if (!ctx) return
      const { grant, schema, school } = ctx
      const types = resolveGrantTypes(grant)
      if (!types.length) return fail(res, 403, 'NO_VISIBLE_TYPE', '该学校当前未开放任何检测类型')

      // 参数校验 + 授权范围 ∩ 请求范围（2026-09-16：此前用 `substring(...) >= $N::date`，
      // 因 text→date 无隐式转换，带 start/end 必 500；且请求范围会**覆盖**而非交叠授权范围）
      const rng = effectiveDateRange(grant, req.query)
      if (!rng.ok) return fail(res, 400, rng.code, rng.message)
      const eff = rng.effective

      // ── 集合定义（2026-09-17 P1-1/P1-2 定稿；四个集合**互斥**，可人工验算）──────────────
      //   AuthorizedUniverse（授权可见全集）= 授权类型内、且**授权业务日期范围内**的记录。
      //     · 授权带业务日期范围时：日期缺失/非法的记录**无法归属**该窗口 → 不计入任何返回值
      //       （否则第三方可用 out_of_range_total 反推授权范围外的数据量 —— 授权外数量侧信道，P1-1）；
      //     · 授权未带范围时：全集 = 授权类型内全部记录（含日期缺失/非法，归入 excluded）。
      //   scope_total              ⊂ universe：日期合法 且 落在「授权∩请求」范围内 → 合格率分母
      //   request_out_of_range_total ⊂ universe：日期合法、在授权范围内，但超出**请求**范围
      //   excluded_total           ⊂ universe：仅当授权未带范围时可能 > 0（日期缺失/格式非法/日历不存在）
      //   恒等式：universe_total = scope_total + request_out_of_range_total + excluded_total
      //   ⚠️ 授权范围外的记录**不出现在任何字段里**（连数量也不暴露）。
      //   pass_rate：分母为 0 时返回 null（不返回 0，避免被误读为"全部不合格"）。
      const params = [types]
      const validDate = businessDateValidSql()
      const hasGrantRange = Boolean(rng.grantRange.start || rng.grantRange.end)
      const grantClause = dateRangeClause({ start: rng.grantRange.start, end: rng.grantRange.end }, params)
      const effClause = dateRangeClause({ start: eff.start, end: eff.end }, params)
      const universeSql = `${validDate}${grantClause}`
      const inScopeSql = `${universeSql}${effClause}`
      const invalidDateSql = hasGrantRange ? 'false' : `NOT COALESCE(${validDate}, false)`
      // oil 判定与 lib/openApiScope.deriveConclusion 同源：已知合格类 {合格,警戒}；已知不合格 {不合格}；
      // 未识别值回退 result 文本（不再像旧实现那样"非空即合格"）。
      const passExpr = `CASE
          WHEN "test_type" = 'pathogen' THEN (COALESCE("result_data"->>'riskLevel','') = '无风险')
          WHEN "test_type" = 'oil' THEN (
            CASE
              WHEN COALESCE("result_data"->>'colorLevel','') IN ('合格','警戒') THEN TRUE
              WHEN COALESCE("result_data"->>'colorLevel','') = '不合格' THEN FALSE
              ELSE (COALESCE("result_data"->>'result','') LIKE '%合格%' AND COALESCE("result_data"->>'result','') NOT LIKE '%不合格%')
            END)
          ELSE (COALESCE("result_data"->>'result','') LIKE '%合格%' AND COALESCE("result_data"->>'result','') NOT LIKE '%不合格%')
        END`

      const db = createTenantClient(prisma, school.code)
      const rows = await db.$queryRawUnsafe(
        `SELECT "test_type",
                count(*) FILTER (WHERE ${inScopeSql})::int AS scope_total,
                count(*) FILTER (WHERE ${inScopeSql} AND ${passExpr})::int AS pass_count,
                count(*) FILTER (WHERE ${universeSql} AND NOT (${inScopeSql}))::int AS request_out_of_range,
                count(*) FILTER (WHERE ${invalidDateSql})::int AS excluded_invalid_date
         FROM "${schema}"."TestRecord"
         WHERE "test_type" = ANY($1::text[])
         GROUP BY "test_type" ORDER BY "test_type"`,
        ...params,
      )

      const rateOf = (n, d) => (d > 0 ? Number((n / d).toFixed(4)) : null)
      const scopeTotal = rows.reduce((s, r) => s + Number(r.scope_total), 0)
      const passCount = rows.reduce((s, r) => s + Number(r.pass_count), 0)
      const excludedInvalid = rows.reduce((s, r) => s + Number(r.excluded_invalid_date), 0)
      const requestOutOfRange = rows.reduce((s, r) => s + Number(r.request_out_of_range), 0)
      const universeTotal = scopeTotal + requestOutOfRange + excludedInvalid
      const toExcluded = (n) => (n > 0
        ? [{ reason: 'missing_or_invalid_test_date', label: '检测日期缺失、格式非法或日历不存在（无法定位业务日期）', count: n }]
        : [])

      ok(res, {
        contract_version: OPEN_API_CONTRACT_VERSION,
        school_code: school.code,
        start: eff.start || null,   // 实际生效范围（授权 ∩ 请求），兼容旧字段
        end: eff.end || null,
        // ── 以下 3 个字段为 v1 既有字段，含义保持不变（兼容旧调用方） ──
        total: scopeTotal,
        pass_count: passCount,
        pass_rate: rateOf(passCount, scopeTotal),
        // ── 可解释口径 ──
        scope_total: scopeTotal,
        included_total: scopeTotal,
        universe_total: universeTotal,
        excluded_total: excludedInvalid,
        excluded: toExcluded(excludedInvalid),
        request_out_of_range_total: requestOutOfRange,
        range: {
          requested: { start: rng.requested.start, end: rng.requested.end },
          grant: { start: rng.grantRange.start, end: rng.grantRange.end },
          effective: { start: eff.start, end: eff.end },
          inclusivity: '两端含当天（闭区间）',
          empty: Boolean(eff.start && eff.end && eff.start > eff.end),
          empty_reason: (eff.start && eff.end && eff.start > eff.end)
            ? '请求范围与授权业务日期范围无交集（合法请求，按 0 条返回）'
            : null,
          authorization_boundary: '统计只在「授权可见全集」内进行：授权业务日期范围外的记录不出现在任何字段中（连数量也不可推断）。',
        },
        set_definition: {
          authorized_universe: '授权类型内、且落在授权业务日期范围内的记录（= universe_total）',
          scope_total: '日期合法 且 落在「授权∩请求」范围内 → 合格率分母（= included_total）',
          request_out_of_range_total: '日期合法、在授权范围内，但超出本次请求范围',
          excluded_total: hasGrantRange
            ? '恒为 0：授权带业务日期范围时，日期缺失/非法的记录无法归属该窗口，不计入任何返回值'
            : '日期缺失、格式非法或日历不存在（无法定位业务日期）',
          identity: 'universe_total = scope_total + request_out_of_range_total + excluded_total',
        },
        // ── 指标口径声明（2026-09-17 审阅 F9：统计按**初检**判定，与明细的 final_conclusion 可能不同）──
        metric_basis: 'initial_conclusion',
        metric_basis_note: '本合格率统计的是**初检**判定（与员工端看板同口径）；明细的 final_conclusion/conclusion '
          + '在存在复检时取复检结论，因此"某条明细 conclusion=pass 但未计入 pass_count"是**预期差异**，不是数据错误。'
          + '如需按最终结论统计，请提出需求，平台将以**新字段**（如 pass_rate_final）提供，不改动既有指标含义。',
        pass_rate_detail: {
          numerator: passCount,
          denominator: scopeTotal,
          value: rateOf(passCount, scopeTotal),
          when_denominator_zero: 'null（不返回 0，避免被误读为全部不合格）',
        },
        unknown_policy: '未判定（conclusion=unknown）的记录**计入分母**（保留 v1 口径，本轮不改变）；'
          + '因此 pass_rate 低于 1 **不等于**其余记录都不合格——请用 conclusion 分布解释差值。'
          + '改变分母口径（例如仅统计已判定记录）属于指标语义变更，需双方另行约定后以新字段/新版本提供。',
        exclusion_policy: '合格率只统计能定位业务日期、且落在「授权范围 ∩ 请求范围」内的记录。'
          + '「日期缺失/格式非法/日历不存在」的记录仅在授权未限定业务日期范围时才可能计数（见 excluded），'
          + '因为一旦授权限定了日期窗口，这类记录无法归属该窗口；'
          + '有有效日期、在授权范围内但超出请求范围的记录计入 request_out_of_range_total。'
          + '授权范围外的记录不计入任何字段（不暴露数量）。',
        by_type: rows.map((r) => {
          const t = Number(r.scope_total)
          const p = Number(r.pass_count)
          const ex = Number(r.excluded_invalid_date)
          const oor = Number(r.request_out_of_range)
          return {
            test_type: r.test_type,
            total: t,                    // 兼容旧字段
            pass_count: p,
            pass_rate: rateOf(p, t),
            scope_total: t,
            included_total: t,
            universe_total: t + oor + ex,
            excluded_total: ex,
            excluded: toExcluded(ex),
            request_out_of_range_total: oor,
            pass_rate_detail: { numerator: p, denominator: t, value: rateOf(p, t) },
          }
        }),
      })
    } catch (e) {
      console.error(`${TAG} stats 失败:`, e)
      fail(res, 500, 'INTERNAL_ERROR', '统计失败')
    }
  })

  return router
}

export default createOpenApiRoutes
