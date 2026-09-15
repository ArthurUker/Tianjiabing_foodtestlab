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
  buildOpenRecord,
  encodeCursor,
  decodeCursor,
  computeManifestDigest,
  computeFiltersFingerprint,
  computeProjectionFingerprint,
  CURRENT_CURSOR_VERSION,
  toIsoShanghai,
} from '../lib/openApiScope.js'
import { DEFAULT_OPEN_TYPES } from '../lib/openApiScope.js'
import { OPEN_API_CONTRACT_VERSION, listFieldDescriptors, buildSyntheticSamples, extractCustomFieldMeta } from '../lib/openApiFieldSchema.js'

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

/** 把 grant 的日期范围翻译成 SQL 条件（业务检测日期，取 sample_info.testDate 前 10 位）。 */
function dateClause(grant, params) {
  const { start, end } = grantDateRange(grant)
  const parts = []
  // testDate 缺失/非法 → 无法判定业务日期；带范围授权时排除（会在对接文档中说明）
  if (start) {
    params.push(start)
    parts.push(`(substring("sample_info"->>'testDate' from 1 for 10) IS NOT NULL AND substring("sample_info"->>'testDate' from 1 for 10) >= $${params.length}::date)`)
  }
  if (end) {
    params.push(end)
    parts.push(`(substring("sample_info"->>'testDate' from 1 for 10) IS NOT NULL AND substring("sample_info"->>'testDate' from 1 for 10) <= $${params.length}::date)`)
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : ''
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
          'required=true 表示该类型当前全部记录均出现该字段；required=false 表示可能缺失（历史数据/学校配置差异）。',
          'type=unknown 表示平台不保证其类型（通常来自学校自定义字段），需按实际值处理。',
          'result 内可能出现与顶层同义的冗余副本（canteen/testDate/inspector），取值以顶层为准。',
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
          const item = buildOpenRecord(s.record, grant, { schoolCode: school.code, schoolName: school.name })
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
        projection_fingerprint: computeProjectionFingerprint(grant),
        visible_types: types,
        include_inspector: grant.include_inspector === true,
        count: samples.length,
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
      // 投影/可见性策略指纹：类型白名单、病原体/检测人/附件开关、业务日期范围
      const projection = computeProjectionFingerprint(grant)

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
        items: page.map((r) => buildOpenRecord(r, grant, { schoolCode: school.code, schoolName: school.name })),
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
      const projection = computeProjectionFingerprint(grant)
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

      const { start: gStart, end: gEnd } = grantDateRange(grant)
      const start = req.query.start ? String(req.query.start) : gStart
      const end = req.query.end ? String(req.query.end) : gEnd

      // 口径拆解（可解释，不再用"以 stats 为准"这类含糊说法）：
      //   scope_total    = 授权范围内记录数（类型 + 授权业务日期范围）
      //   included_total = 参与合格率计算的记录数（= scope_total，因为范围内记录必有合法日期）
      //   excluded[]     = 未参与计算的原因与条数（当前仅「业务日期缺失/非法」一类）
      //   pass_rate      = numerator / denominator，分母为 0 时返回 null（不返回 0 以免被误读为"全部不合格"）
      const params = [types]
      const dateExpr = `substring("sample_info"->>'testDate' from 1 for 10)`
      const validDate = `${dateExpr} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`
      const inRangeParts = [validDate]
      if (start) { params.push(start); inRangeParts.push(`${dateExpr} >= $${params.length}::date`) }
      if (end) { params.push(end); inRangeParts.push(`${dateExpr} <= $${params.length}::date`) }
      const inRangeExpr = inRangeParts.join(' AND ')

      const passExpr = `CASE
          WHEN "test_type" = 'pathogen' THEN (COALESCE("result_data"->>'riskLevel','') = '无风险')
          WHEN "test_type" = 'oil' THEN (
            CASE WHEN COALESCE("result_data"->>'colorLevel','') <> ''
                 THEN (COALESCE("result_data"->>'colorLevel','') NOT LIKE '%不合格%')
                 ELSE (COALESCE("result_data"->>'result','') LIKE '%合格%' AND COALESCE("result_data"->>'result','') NOT LIKE '%不合格%')
            END)
          ELSE (COALESCE("result_data"->>'result','') LIKE '%合格%' AND COALESCE("result_data"->>'result','') NOT LIKE '%不合格%')
        END`

      const db = createTenantClient(prisma, school.code)
      // ⚠️ excluded 必须用 COALESCE 包一层：testDate 缺失时 `substring(NULL) ~ 'regex'` 为 NULL，
      //    而 `FILTER (WHERE NOT NULL)` 不计数 → 会把"日期缺失"的记录漏掉（2026-09-15 只读库验证实测：
      //    实际 1 条被漏报为 0）。COALESCE(..., false) 后 NULL 与"格式非法"统一计为排除。
      const rows = await db.$queryRawUnsafe(
        `SELECT "test_type",
                count(*) FILTER (WHERE ${inRangeExpr})::int AS scope_total,
                count(*) FILTER (WHERE ${inRangeExpr} AND ${passExpr})::int AS pass_count,
                count(*) FILTER (WHERE NOT COALESCE(${validDate}, false))::int AS excluded_invalid_date
         FROM "${schema}"."TestRecord"
         WHERE "test_type" = ANY($1::text[])
         GROUP BY "test_type" ORDER BY "test_type"`,
        ...params,
      )

      const rateOf = (n, d) => (d > 0 ? Number((n / d).toFixed(4)) : null)
      const scopeTotal = rows.reduce((s, r) => s + Number(r.scope_total), 0)
      const passCount = rows.reduce((s, r) => s + Number(r.pass_count), 0)
      const excludedInvalid = rows.reduce((s, r) => s + Number(r.excluded_invalid_date), 0)
      const toExcluded = (n) => (n > 0
        ? [{ reason: 'missing_or_invalid_test_date', label: '检测日期缺失或格式非法（无法定位业务日期）', count: n }]
        : [])

      ok(res, {
        contract_version: OPEN_API_CONTRACT_VERSION,
        school_code: school.code,
        start: start || null,
        end: end || null,
        // ── 以下 3 个字段为 v1 既有字段，含义保持不变（兼容旧调用方） ──
        total: scopeTotal,
        pass_count: passCount,
        pass_rate: rateOf(passCount, scopeTotal),
        // ── 可解释口径 ──
        scope_total: scopeTotal,
        included_total: scopeTotal,
        excluded_total: excludedInvalid,
        excluded: toExcluded(excludedInvalid),
        pass_rate_detail: {
          numerator: passCount,
          denominator: scopeTotal,
          value: rateOf(passCount, scopeTotal),
          when_denominator_zero: 'null（不返回 0，避免被误读为全部不合格）',
        },
        exclusion_policy: '合格率只统计能定位业务日期的记录；「日期缺失/非法」的记录条数与原因在 excluded 中列明，'
          + '不会静默丢弃。若授权本身带业务日期范围，则范围外记录不属于本次统计范围（不计入 excluded）。',
        by_type: rows.map((r) => {
          const t = Number(r.scope_total)
          const p = Number(r.pass_count)
          const ex = Number(r.excluded_invalid_date)
          return {
            test_type: r.test_type,
            total: t,                    // 兼容旧字段
            pass_count: p,
            pass_rate: rateOf(p, t),
            scope_total: t,
            included_total: t,
            excluded_total: ex,
            excluded: toExcluded(ex),
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
