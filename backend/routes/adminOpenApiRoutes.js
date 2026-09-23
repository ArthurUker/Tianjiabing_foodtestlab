// adminOpenApiRoutes.js — 开放接口「超管配置」API（控制台「开放接口」视图后端）
//
// 挂载：server.js `app.use('/api/admin/open-api', ...)`；全部端点
// authenticateUser + requirePlatformSuperAdmin（平台超管：role=admin 且无 schoolCode）。
//
// 端点：
//   GET    /clients                        — 对接方列表（含凭证摘要 + 学校授权，一次取全）
//   POST   /clients                        — 新建对接方
//   PATCH  /clients/:id                    — 修改基础信息 / 停用启用 / IP 白名单 / 限流
//   POST   /clients/:id/credentials        — 生成新凭证（明文 Key 仅本次响应返回一次）
//   POST   /clients/:id/credentials/:cid/revoke — 吊销凭证
//   PUT    /clients/:id/grants             — 覆盖式设置学校授权（未出现的学校 → 停用，不物理删除）
//   GET    /clients/:id/preview            — 预览：该对接方将看到的 JSON 形态（脱敏后）
//   GET    /export                         — 导出配置（灾后重建用；含 key_hash，不含明文密钥）
//   POST   /import                         — 导入配置（按 id upsert，用于重建/迁移）
//
// 审计：全部变更写 writeAdminOpsLog（public.SystemLog，[admin-audit] 前缀）。

import express from 'express'
import { writeAdminOpsLog } from '../lib/auditLog.js'
import { generateApiKey } from '../lib/openApiKeys.js'
import { createTenantClient, schemaNameOf, isValidSchoolCode, assertSafeSchemaName } from '../lib/tenantClient.js'
import { RECORD_ROUTE_TYPES } from '../lib/recordNormalize.js'
import { resolveGrantTypes, grantDateRange, buildOpenRecord, computeProjectionFingerprint } from '../lib/openApiScope.js'
import { OPEN_API_CONTRACT_VERSION, listFieldDescriptors, buildSyntheticSamples, extractCustomFieldMeta, buildAllowedResultKeyMap } from '../lib/openApiFieldSchema.js'

const TAG = '[adminOpenApiRoutes]'
const OPS_ACTION = {
  clientCreate: 'openapi_client_create',
  clientUpdate: 'openapi_client_update',
  credentialCreate: 'openapi_credential_create',
  credentialRevoke: 'openapi_credential_revoke',
  grantsUpdate: 'openapi_grants_update',
  configImport: 'openapi_config_import',
}

const MAX_IP_ENTRIES = 50
const IP_OR_CIDR_RE = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/

function badRequest(res, message) {
  return res.status(400).json({ success: false, error: message })
}

/** 'YYYY-MM-DD' → Date（Asia/Shanghai 当日 00:00）；空/非法返回 null。 */
function parseDay(value) {
  if (value == null || value === '') return null
  const s = String(value).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined // undefined = 非法（与 null 区分）
  const d = new Date(`${s}T00:00:00+08:00`)
  return Number.isNaN(d.getTime()) ? undefined : d
}

function dayStr(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** visible_types 归一：只保留系统内置类型；pathogen 必须经 includePathogen 显式开启。 */
function normalizeVisibleTypes(raw, includePathogen) {
  if (!Array.isArray(raw)) return null
  const list = [...new Set(raw.map((t) => String(t)).filter((t) => RECORD_ROUTE_TYPES.has(t)))]
    .filter((t) => (t === 'pathogen' ? includePathogen === true : true))
  return list.length ? list : null
}

/**
 * 判断授权范围是否有实质变化（用于 scope_version 递增 → 触发对方重新同步）。
 *
 * ⚠️ 必须按**生效值**比较，而不是按存储形态比较，否则两类"看起来变了、实际没变"的保存会误触发失效：
 *   ① visible_types 数组顺序不同（["oil","tableware"] vs ["tableware","oil"]）；
 *   ② null/缺省（= 系统默认四类）与显式写出这四类等价。
 * 因此这里统一用 resolveGrantTypes()（已归一 + 过滤病原体开关）后再排序比较。
 */
function scopeSignature(g) {
  return JSON.stringify({
    t: [...resolveGrantTypes(g)].sort(),
    p: g.include_pathogen === true,
    i: g.include_inspector === true,
    a: g.include_attachments === true,
    s: dayStr(g.start_date),
    e: dayStr(g.end_date),
    st: g.status || 'active',
  })
}

export function createAdminOpenApiRoutes({ prisma, authenticateUser, requirePlatformSuperAdmin }) {
  const router = express.Router()
  router.use(authenticateUser, requirePlatformSuperAdmin)

  const actorOf = (req) => ({
    userId: req.user?.userId ?? null,
    username: req.user?.username ?? null,
    role: req.user?.role ?? null,
    schoolCode: null,
    ip: req.ip,
  })

  /** 对接方列表（含凭证摘要与学校授权；学校名从 public.School 补齐）。 */
  router.get('/clients', async (req, res) => {
    try {
      const clients = await prisma.openApiClient.findMany({
        orderBy: { created_at: 'desc' },
        include: {
          credentials: { orderBy: { created_at: 'desc' } },
          grants: { orderBy: { school_code: 'asc' } },
        },
      })
      const codes = [...new Set(clients.flatMap((c) => c.grants.map((g) => g.school_code)))]
      const schools = codes.length
        ? await prisma.school.findMany({ where: { code: { in: codes } }, select: { code: true, name: true, short_name: true, status: true } })
        : []
      const nameOf = new Map(schools.map((s) => [s.code, s]))

      res.json({
        success: true,
        data: clients.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          status: c.status,
          ip_whitelist: Array.isArray(c.ip_whitelist) ? c.ip_whitelist : [],
          rate_limit_per_min: c.rate_limit_per_min,
          last_used_at: c.last_used_at,
          disabled_at: c.disabled_at,
          disabled_reason: c.disabled_reason,
          created_at: c.created_at,
          credentials: c.credentials.map((k) => ({
            id: k.id,
            label: k.label,
            key_prefix: k.key_prefix,
            key_last4: k.key_last4,
            status: k.status,
            expires_at: k.expires_at,
            revoked_at: k.revoked_at,
            revoked_reason: k.revoked_reason,
            last_used_at: k.last_used_at,
            call_count: k.call_count,
            created_at: k.created_at,
          })),
          grants: c.grants.map((g) => {
            const { start, end } = grantDateRange(g)
            return {
              school_code: g.school_code,
              school_name: nameOf.get(g.school_code)?.name || null,
              school_exists: nameOf.has(g.school_code),
              scope_version: g.scope_version,
              status: g.status,
              visible_types: Array.isArray(g.visible_types) ? g.visible_types : null,
              effective_types: resolveGrantTypes(g),
              include_pathogen: g.include_pathogen === true,
              include_inspector: g.include_inspector === true,
              include_attachments: g.include_attachments === true,
              start_date: start,
              end_date: end,
              updated_at: g.updated_at,
            }
          }),
        })),
      })
    } catch (e) {
      console.error(`${TAG} 列表失败:`, e)
      res.status(500).json({ success: false, error: e.message || '读取对接方列表失败' })
    }
  })

  /** 新建对接方。 */
  router.post('/clients', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim()
      if (!name || name.length > 100) return badRequest(res, 'name 必填且不超过 100 字')
      const description = req.body?.description ? String(req.body.description).slice(0, 500) : null
      const ipList = normalizeIpWhitelist(req.body?.ip_whitelist)
      if (ipList === undefined) return badRequest(res, 'IP 白名单格式非法（每项为 IP 或 CIDR，最多 50 条）')
      const rate = Number(req.body?.rate_limit_per_min ?? 60)
      if (!Number.isFinite(rate) || rate < 1 || rate > 6000) return badRequest(res, '限流需在 1~6000 次/分钟之间')

      const created = await prisma.openApiClient.create({
        data: { name, description, ip_whitelist: ipList, rate_limit_per_min: Math.floor(rate), created_by: req.user?.username || null },
      })
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.clientCreate, actor: actorOf(req), targetId: created.id, targetSchoolCode: null,
        details: { name, ip_whitelist: ipList, rate_limit_per_min: created.rate_limit_per_min }, level: 'warn',
      })
      res.json({ success: true, data: { id: created.id } })
    } catch (e) {
      console.error(`${TAG} 新建对接方失败:`, e)
      res.status(500).json({ success: false, error: e.message || '新建对接方失败' })
    }
  })

  /** 修改基础信息 / 停用启用。 */
  router.patch('/clients/:id', async (req, res) => {
    try {
      const client = await prisma.openApiClient.findUnique({ where: { id: req.params.id } })
      if (!client) return res.status(404).json({ success: false, error: '对接方不存在' })

      const data = {}
      if (req.body?.name !== undefined) {
        const name = String(req.body.name).trim()
        if (!name || name.length > 100) return badRequest(res, 'name 必填且不超过 100 字')
        data.name = name
      }
      if (req.body?.description !== undefined) data.description = req.body.description ? String(req.body.description).slice(0, 500) : null
      if (req.body?.ip_whitelist !== undefined) {
        const ipList = normalizeIpWhitelist(req.body.ip_whitelist)
        if (ipList === undefined) return badRequest(res, 'IP 白名单格式非法（每项为 IP 或 CIDR，最多 50 条）')
        data.ip_whitelist = ipList
      }
      if (req.body?.rate_limit_per_min !== undefined) {
        const rate = Number(req.body.rate_limit_per_min)
        if (!Number.isFinite(rate) || rate < 1 || rate > 6000) return badRequest(res, '限流需在 1~6000 次/分钟之间')
        data.rate_limit_per_min = Math.floor(rate)
      }
      if (req.body?.status !== undefined) {
        const status = String(req.body.status)
        if (!['active', 'disabled'].includes(status)) return badRequest(res, 'status 只能为 active / disabled')
        data.status = status
        data.disabled_at = status === 'disabled' ? new Date() : null
        data.disabled_reason = status === 'disabled' ? (req.body?.disabled_reason ? String(req.body.disabled_reason).slice(0, 200) : '超管停用') : null
      }
      if (!Object.keys(data).length) return badRequest(res, '没有需要更新的字段')

      await prisma.openApiClient.update({ where: { id: client.id }, data })
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.clientUpdate, actor: actorOf(req), targetId: client.id, targetSchoolCode: null,
        details: { name: client.name, changes: Object.keys(data) }, level: 'warn',
      })
      res.json({ success: true, data: { id: client.id } })
    } catch (e) {
      console.error(`${TAG} 修改对接方失败:`, e)
      res.status(500).json({ success: false, error: e.message || '修改失败' })
    }
  })

  /** 生成新凭证：明文 Key 仅本次响应返回一次。 */
  router.post('/clients/:id/credentials', async (req, res) => {
    try {
      const client = await prisma.openApiClient.findUnique({ where: { id: req.params.id } })
      if (!client) return res.status(404).json({ success: false, error: '对接方不存在' })
      const label = String(req.body?.label || '生产').slice(0, 40)
      const expiresDays = req.body?.expires_in_days != null ? Number(req.body.expires_in_days) : null
      if (expiresDays != null && (!Number.isFinite(expiresDays) || expiresDays < 1 || expiresDays > 3650)) {
        return badRequest(res, 'expires_in_days 需在 1~3650 之间')
      }

      const key = generateApiKey()
      const created = await prisma.openApiCredential.create({
        data: {
          client_id: client.id,
          label,
          key_hash: key.hash,
          key_prefix: key.prefix,
          key_last4: key.last4,
          expires_at: expiresDays ? new Date(Date.now() + expiresDays * 86400000) : null,
          created_by: req.user?.username || null,
        },
      })
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.credentialCreate, actor: actorOf(req), targetId: client.id, targetSchoolCode: null,
        details: { client: client.name, credential_id: created.id, label, key_prefix: key.prefix, expires_at: created.expires_at }, level: 'warn',
      })
      // ⚠️ 明文密钥仅此一次；库中只有哈希，丢失只能吊销重发
      res.json({ success: true, data: { id: created.id, label, api_key: key.plain, key_prefix: key.prefix, expires_at: created.expires_at } })
    } catch (e) {
      console.error(`${TAG} 生成凭证失败:`, e)
      res.status(500).json({ success: false, error: e.message || '生成凭证失败' })
    }
  })

  /** 吊销凭证。 */
  router.post('/clients/:id/credentials/:cid/revoke', async (req, res) => {
    try {
      const credential = await prisma.openApiCredential.findUnique({ where: { id: req.params.cid } })
      if (!credential || credential.client_id !== req.params.id) return res.status(404).json({ success: false, error: '凭证不存在' })
      if (credential.status === 'revoked') return badRequest(res, '该凭证已吊销')
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : '超管吊销'
      await prisma.openApiCredential.update({
        where: { id: credential.id },
        data: { status: 'revoked', revoked_at: new Date(), revoked_reason: reason },
      })
      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.credentialRevoke, actor: actorOf(req), targetId: credential.client_id, targetSchoolCode: null,
        details: { credential_id: credential.id, key_prefix: credential.key_prefix, reason }, level: 'warn',
      })
      res.json({ success: true })
    } catch (e) {
      console.error(`${TAG} 吊销凭证失败:`, e)
      res.status(500).json({ success: false, error: e.message || '吊销失败' })
    }
  })

  /** 覆盖式设置学校授权：未出现在请求中的学校 → status='disabled'（保留行与 scope_version 历史）。 */
  router.put('/clients/:id/grants', async (req, res) => {
    try {
      const client = await prisma.openApiClient.findUnique({ where: { id: req.params.id }, include: { grants: true } })
      if (!client) return res.status(404).json({ success: false, error: '对接方不存在' })
      const input = Array.isArray(req.body?.grants) ? req.body.grants : null
      if (!input) return badRequest(res, 'grants 必须为数组')

      // 归一 + 校验
      const desired = []
      for (const raw of input) {
        const schoolCode = String(raw?.schoolCode || '').trim()
        if (!isValidSchoolCode(schoolCode)) return badRequest(res, `学校代码非法: ${schoolCode}`)
        const school = await prisma.school.findUnique({ where: { code: schoolCode }, select: { code: true, status: true } })
        if (!school) return badRequest(res, `学校不存在: ${schoolCode}`)
        const includePathogen = raw?.includePathogen === true
        const visibleTypes = normalizeVisibleTypes(raw?.visibleTypes, includePathogen)
        const start = parseDay(raw?.startDate)
        const end = parseDay(raw?.endDate)
        if (start === undefined || end === undefined) return badRequest(res, `${schoolCode}: 日期需为 YYYY-MM-DD`)
        if (start && end && start > end) return badRequest(res, `${schoolCode}: 起始日期不能晚于结束日期`)
        desired.push({
          school_code: schoolCode,
          visible_types: visibleTypes,
          include_pathogen: includePathogen,
          include_inspector: raw?.includeInspector === true,
          include_attachments: raw?.includeAttachments === true,
          start_date: start,
          end_date: end,
          status: raw?.status === 'disabled' ? 'disabled' : 'active',
        })
      }
      const desiredCodes = new Set(desired.map((d) => d.school_code))
      const existing = new Map(client.grants.map((g) => [g.school_code, g]))
      const applied = []

      for (const want of desired) {
        const prev = existing.get(want.school_code)
        if (!prev) {
          const created = await prisma.openApiGrant.create({
            data: { client_id: client.id, ...want, scope_version: 1, created_by: req.user?.username || null },
          })
          applied.push({ school_code: want.school_code, action: 'created', scope_version: created.scope_version })
          continue
        }
        const changed = scopeSignature(prev) !== scopeSignature(want)
        const nextVersion = changed ? Number(prev.scope_version) + 1 : Number(prev.scope_version)
        await prisma.openApiGrant.update({
          where: { id: prev.id },
          data: { ...want, scope_version: nextVersion },
        })
        applied.push({ school_code: want.school_code, action: changed ? 'updated' : 'unchanged', scope_version: nextVersion })
      }

      // 请求中未出现的学校 → 停用（不物理删除，保留历史与 scope_version）
      const disabled = []
      for (const g of client.grants) {
        if (desiredCodes.has(g.school_code)) continue
        if (g.status === 'disabled') continue
        await prisma.openApiGrant.update({
          where: { id: g.id },
          data: { status: 'disabled', scope_version: Number(g.scope_version) + 1 },
        })
        disabled.push(g.school_code)
      }

      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.grantsUpdate, actor: actorOf(req), targetId: client.id, targetSchoolCode: null,
        details: { client: client.name, applied, disabled }, level: 'warn',
      })
      res.json({ success: true, data: { applied, disabled } })
    } catch (e) {
      console.error(`${TAG} 设置授权失败:`, e)
      res.status(500).json({ success: false, error: e.message || '设置授权失败' })
    }
  })

  /** 预览：该对接方对某校实际会拿到的 JSON 形态（抽样，脱敏后）。 */
  router.get('/clients/:id/preview', async (req, res) => {
    try {
      const client = await prisma.openApiClient.findUnique({ where: { id: req.params.id }, include: { grants: true } })
      if (!client) return res.status(404).json({ success: false, error: '对接方不存在' })
      const schoolCode = String(req.query.schoolCode || '').trim()
      if (!isValidSchoolCode(schoolCode)) return badRequest(res, 'schoolCode 非法')
      const grant = client.grants.find((g) => g.school_code === schoolCode)
      // 与对外接口保持同一授权边界：已停用的授权不可预览（否则会"预览得到、接口取不到"）
      if (!grant || grant.status !== 'active') {
        return badRequest(res, grant ? '该校授权已停用，如需预览请先恢复授权' : '该校未授权给此对接方')
      }

      const school = await prisma.school.findUnique({ where: { code: schoolCode }, select: { code: true, name: true } })
      const schema = schemaNameOf(schoolCode)
      assertSafeSchemaName(schema)
      const types = resolveGrantTypes(grant)
      // 字段白名单（与字典同源；2026-09-16 审阅 M2）：预览必须与真实下发一致
      const cust = await prisma.schoolCustomization.findUnique({ where: { school_code: schoolCode } })
      const resultKeyMap = buildAllowedResultKeyMap(types, (t) => extractCustomFieldMeta(cust, t))
      const limit = Math.min(Math.max(Number(req.query.limit) || 3, 1), 20)
      const db = createTenantClient(prisma, schoolCode)
      const rows = types.length
        ? await db.$queryRawUnsafe(
            `SELECT "id","record_code","test_type","test_name","sample_info","result_data","status","created_at","updated_at","data_version"
             FROM "${schema}"."TestRecord" WHERE "test_type" = ANY($1::text[])
             ORDER BY "updated_at" DESC LIMIT $2`,
            types, limit,
          )
        : []
      res.json({
        success: true,
        data: {
          school_code: schoolCode,
          school_name: school?.name || null,
          scope_version: grant.scope_version,
          effective_types: types,
          items: rows.map((r) => buildOpenRecord(r, grant, {
            schoolCode,
            schoolName: school?.name || null,
            allowedResultKeys: resultKeyMap.get(r.test_type),
          })),
        },
      })
    } catch (e) {
      console.error(`${TAG} 预览失败:`, e)
      res.status(500).json({ success: false, error: e.message || '预览失败' })
    }
  })

  /**
   * 控制台「接入说明」用：与对外 GET /v1/dict **同源**的字段字典（超管经 JWT 访问，不需要 API Key）。
   * 仅对**已生效授权**（active）提供，与对外接口的可见范围一致。
   */
  router.get('/clients/:id/dict', async (req, res) => {
    try {
      const client = await prisma.openApiClient.findUnique({ where: { id: req.params.id }, include: { grants: true } })
      if (!client) return res.status(404).json({ success: false, error: '对接方不存在' })
      const schoolCode = String(req.query.schoolCode || '').trim()
      const grant = client.grants.find((g) => g.school_code === schoolCode && g.status === 'active')
      if (!grant) return badRequest(res, '该校未授权或授权已停用（字段字典仅对已生效授权提供）')
      const school = await prisma.school.findUnique({ where: { code: schoolCode }, select: { code: true, name: true } })
      const cust = await prisma.schoolCustomization.findUnique({ where: { school_code: schoolCode } })
      const visibleTypes = resolveGrantTypes(grant)
      const field_schema = {}
      for (const t of visibleTypes) {
        field_schema[t] = {
          contract_version: OPEN_API_CONTRACT_VERSION,
          fields: listFieldDescriptors(t, extractCustomFieldMeta(cust, t)),
        }
      }
      res.json({
        success: true,
        data: {
          contract_version: OPEN_API_CONTRACT_VERSION,
          school_code: schoolCode,
          school_name: school?.name || null,
          scope_version: grant.scope_version,
          // 与对外 /test-records、/samples、/sync/manifest 同源（含投影修订号 + 该校配置指纹，见 F6）
          projection_fingerprint: computeProjectionFingerprint(grant, allowedKeysFingerprint(types, (t) => extractCustomFieldMeta(cust, t))),
          include_inspector: grant.include_inspector === true,
          visible_types: visibleTypes,
          field_schema,
        },
      })
    } catch (e) {
      console.error(`${TAG} 字典预览失败:`, e)
      res.status(500).json({ success: false, error: e.message || '读取字段字典失败' })
    }
  })

  /** 控制台「接入说明」用：与对外 GET /v1/samples 同源的合成样例预览。 */
  router.get('/clients/:id/samples', async (req, res) => {
    try {
      const client = await prisma.openApiClient.findUnique({ where: { id: req.params.id }, include: { grants: true } })
      if (!client) return res.status(404).json({ success: false, error: '对接方不存在' })
      const schoolCode = String(req.query.schoolCode || '').trim()
      const grant = client.grants.find((g) => g.school_code === schoolCode && g.status === 'active')
      if (!grant) return badRequest(res, '该校未授权或授权已停用（样例仅对已生效授权提供）')
      const school = await prisma.school.findUnique({ where: { code: schoolCode }, select: { code: true, name: true } })
      const visibleTypes = resolveGrantTypes(grant)
      let target = visibleTypes
      if (req.query.test_type) {
        const t = String(req.query.test_type)
        if (!visibleTypes.includes(t)) return badRequest(res, `该类型未对${schoolCode}开放: ${t}`)
        target = [t]
      }
      const cust = await prisma.schoolCustomization.findUnique({ where: { school_code: schoolCode } })
      const resultKeyMap = buildAllowedResultKeyMap(visibleTypes, (t) => extractCustomFieldMeta(cust, t))
      const samples = []
      for (const t of target) {
        for (const s of buildSyntheticSamples(t)) {
          samples.push({
            test_type: t,
            scenario: s.scenario,
            synthetic: true,
            item: buildOpenRecord(s.record, grant, { schoolCode, schoolName: school?.name || null, allowedResultKeys: resultKeyMap.get(t) }),
          })
        }
      }
      res.json({
        success: true,
        data: {
          contract_version: OPEN_API_CONTRACT_VERSION,
          school_code: schoolCode,
          scope_version: grant.scope_version,
          include_inspector: grant.include_inspector === true,
          count: samples.length,
          samples,
        },
      })
    } catch (e) {
      console.error(`${TAG} 样例预览失败:`, e)
      res.status(500).json({ success: false, error: e.message || '生成样例失败' })
    }
  })

  /**
   * 接入包（Markdown）：一次性把对方开发者需要的东西打包下载。
   * 内容 = 接口说明 + **已保存**的开放范围 + 字段字典 + 合成样例 + 错误码 + 同步规则 + 检查清单。
   * 安全：不含完整密钥、不含 key_hash、不含生产记录、不含内部配置原文。
   */
  router.get('/clients/:id/package', async (req, res) => {
    try {
      const client = await prisma.openApiClient.findUnique({ where: { id: req.params.id }, include: { grants: true } })
      if (!client) return res.status(404).json({ success: false, error: '对接方不存在' })
      const activeGrants = client.grants.filter((g) => g.status === 'active').sort((a, b) => (a.school_code < b.school_code ? -1 : 1))
      const codes = activeGrants.map((g) => g.school_code)
      const schools = codes.length
        ? await prisma.school.findMany({ where: { code: { in: codes } }, select: { code: true, name: true } })
        : []
      const nameOf = new Map(schools.map((s) => [s.code, s.name]))
      const custs = codes.length
        ? await prisma.schoolCustomization.findMany({ where: { school_code: { in: codes } }, select: { school_code: true, custom_fields: true, field_labels: true } })
        : []
      const custOf = new Map(custs.map((c) => [c.school_code, c]))
      const base = `https://${req.get('host') || '<平台域名>'}/api/open/v1`
      const L = []
      const push = (...xs) => L.push(...xs)

      push(
        '# foodSentinel 开放接口 · 接入包',
        '',
        `- 对接方：**${client.name}**`,
        `- 契约版本：\`${OPEN_API_CONTRACT_VERSION}\``,
        `- 生成时间：${new Date().toISOString()}`,
        `- ⚠️ 本文件中的**开放范围是生成时的授权快照**（学校代码：${activeGrants.map((g) => g.school_code).join('、') || '（当前无生效授权）'}）；`
          + '**实际生效权限一律以 `GET /profile` 为准**（平台可能在此之后调整授权），本快照也不代表其它学校已开通。',
        '- ⚠️ 本文件**不包含任何密钥**：API Key 由平台超管通过安全渠道单独提供，明文只在生成时显示一次。',
        '',
        '## 0. 快速开始（可直接复制运行）',
        '',
        '```bash',
        '# ① 连通性 + 服务器时间（对账时钟）',
        `curl -s -H "X-API-Key: $KEY" ${base}/ping`,
        '',
        '# ② 确认当前授权范围（学校 / 类型 / 字段开关 / scope_version / projection_fingerprint）',
        `curl -s -H "X-API-Key: $KEY" ${base}/profile`,
        '',
        '# ③ 取字段字典（据此写映射：是否下发、单位、结论枚举、自定义字段）',
        `curl -s -H "X-API-Key: $KEY" "${base}/dict?school_code=<校>"`,
        '',
        '# ④ 拉第一页记录（limit ≤ 200；看 has_more / next_cursor）',
        `curl -s -H "X-API-Key: $KEY" "${base}/test-records?school_code=<校>&limit=200"`,
        '',
        '# ⑤ 对账清单（total + digest；detail=1 附全量 {record_code, updated_at}）',
        `curl -s -H "X-API-Key: $KEY" "${base}/sync/manifest?school_code=<校>"`,
        '```',
        '',
        '> `$KEY` 即平台提供的密钥明文（形如 `oap_…`）。**认证只有一种密钥**，可用下面两种方式之一携带；两者同时出现时以 `X-API-Key` 为准。',
        '',
        '**分页响应外层结构**（`GET /test-records`，注意外层是 `data`，单条记录在 `data.items[]`）：',
        '```json',
        '{ "code": 0, "data": { "school_code": "<校>", "scope_version": 1, "projection_fingerprint": "…",',
        '    "count": 200, "has_more": true, "next_cursor": "<最后一页为 null>",',
        '    "server_time": "2026-09-16T12:00:00+08:00", "items": [ { "…": "单条记录对象（见 §4 样例）" } ] } }',
        '```',
        '**清单响应外层结构**（`GET /sync/manifest`，`detail=1` 时才有 `items`）：',
        '```json',
        '{ "code": 0, "data": { "total": 1129, "complete": true, "digest": "…",',
        '    "digest_covers": "cursor_version+scope_version+projection_fingerprint+record_code@updated_at",',
        '    "generated_at": "2026-09-16T12:00:00+08:00",',
        '    "items": [ { "record_code": "RC-…", "updated_at": "2026-09-16T11:05:00+08:00" } ] } }',
        '```',
        '',
        '## 1. 接口地址与认证',
        '',
        `- 基址：\`${base}\``,
        '- 认证（**同一个密钥**，二选一携带方式）：`X-API-Key: <密钥>` 或 `Authorization: Bearer <密钥>`；必须 HTTPS。',
        '- 限流：默认 60 次/分钟（超限返回 429，请按 `Retry-After` 退避）。',
        '- 分页参数：`limit` 默认 **100**、上限 **200**；`limit` 缺失 / 非数字 / `0` 一律**回退默认值**（不报错，兼容既有调用行为）。',
        '- 日期参数（`start` / `end`）：接受 `YYYY-MM-DD` 或 ISO8601 日期时间（取日期部分），**两端含当天**；'
          + '非法日期返回 `400 INVALID_START` / `INVALID_END`，`start > end` 返回 `400 INVALID_RANGE`；'
          + '请求范围与授权业务日期范围**求交集**（请求不能越过授权范围）。',
        '- `projection_fingerprint`（字段可见性指纹）在 `/test-records`、`/samples`、`/sync/manifest` 响应中返回，**`/profile` 不含**该字段。',
        '- 所有成功响应为 `{ "code": 0, "data": {...} }`；失败为 `{ "code": "<错误码>", "error": "..." }`。',
        '',
        '| 端点 | 说明 |',
        '|---|---|',
        '| `GET /ping` | 连通性 + 服务器时间 |',
        '| `GET /profile` | 当前密钥的授权范围（每校 scope_version / 类型 / 日期范围 / 字段开关；**不含** projection_fingerprint） |',
        '| `GET /schools` | 授权学校清单 |',
        '| `GET /dict?school_code=` | 字典：类型、食堂、结论枚举、**字段字典** |',
        '| `GET /samples?school_code=&test_type=` | **合成样例**（非真实数据，可在无数据时开发） |',
        '| `GET /sync/manifest?school_code=[&detail=1]` | 全量清单（total + digest）；`detail=1` 附明细用于对账 |',
        '| `GET /test-records?school_code=&cursor=&limit=` | 检测记录增量拉取（游标分页） |',
        '| `GET /stats?school_code=&start=&end=` | 合格率统计（含排除原因，可对账） |',
        '',
        '## 2. 当前已保存的开放范围',
        '',
      )
      if (!activeGrants.length) {
        push('> ⚠️ 当前**没有任何生效授权**（未勾选学校或已全部停用）。请先在控制台「开放接口 → 学校授权」中配置。', '')
      } else {
        push('| 学校 | 学校代码 | 开放类型 | 业务日期范围 | 检测人姓名 | 病原体 | scope_version |', '|---|---|---|---|---|---|---|')
        for (const g of activeGrants) {
          const { start, end } = grantDateRange(g)
          push(`| ${nameOf.get(g.school_code) || '-'} | \`${g.school_code}\` | ${resolveGrantTypes(g).join('、')} | ${start || '不限'} ~ ${end || '不限'} | ${g.include_inspector ? '下发' : '不下发'} | ${g.include_pathogen ? '开放' : '不开放'} | ${g.scope_version} |`)
        }
        push('')
      }

      push(
        '## 3. 字段字典',
        '',
        '> 读表须知：',
        '> - **必现**只是**当前数据分布观察**（是 = 该类型现有记录都出现），**不是接口输出保证**——请勿据此建必填模型，容错解析以「可空」「下发」为准。',
        '> - **可空**：字段存在但值可能为 `null`。**三态区分**：字段**省略**（不存在）≠ `null`（存在无值）≠ 空串/空数组（有值为空）。',
        '> - **下发=否** 的字段**不会出现在响应中**，列出仅为说明原始存储结构（如 `result.inspector` 属个人信息恒不下发），请勿据此开发。',
        '> - **公共字段只列一次**（该学校所有开放类型一致）；各类型的专属字段分列在其后。数组元素结构见说明中的「元素：…」。',
        '> - ⚠️ **单位标注 ≠ 已核实单位**：字段表「单位」列带 `⚠️未核实` 的（如 `result.tpmValue`）表示该单位仅为**平台界面标注**'
          + '（字段上 `unit_source=platform_label`、`unit_verified=false`），**设备协议/计量文件尚未核实** —— 请勿自行换算（×100 / ÷100），也不要据该字段重新判定历史结论。',
        '',
      )
      const descKey = (f) => `${f.path}|${f.type}|${f.unit || ''}|${f.label || ''}|${f.required ? 1 : 0}|${f.nullable ? 1 : 0}|${f.emitted === false ? 0 : 1}|${f.conditional_on || ''}`
      const commonAcross = (lists) => {
        if (!lists.length) return new Set()
        const common = new Set()
        for (const [path, key] of lists[0].map((f) => [f.path, descKey(f)])) {
          if (lists.every((l) => l.some((f) => f.path === path && descKey(f) === key))) common.add(path)
        }
        return common
      }
      const renderFieldTable = (fields) => {
        push('| 路径 | 中文名 | 类型 | 单位 | 必现 | 可空 | 下发 | 说明 |', '|---|---|---|---|---|---|---|---|')
        for (const f of fields) {
          const typeCell = f.type + (Array.isArray(f.enum) && f.enum.length ? `（取值：${f.enum.join(' / ')}）` : '')
          const itemHint = Array.isArray(f.item_fields) && f.item_fields.length ? `；元素：${f.item_fields.join('、')}` : ''
          const cond = f.conditional_on ? `（条件字段：仅当 ${f.conditional_on} 开启时存在）` : ''
          const desc = String(f.description || '').replace(/\|/g, '/').replace(/\n/g, ' ') + itemHint + cond
          // ⚠️ 单位核实状态必须可见（2026-09-23）：unit_verified=false 的字段在接入包里显式标注，
          //    避免读者把"平台界面标注"当成"经设备协议核实的单位"。
          const unitCellRaw = f.unit ? `${f.unit}${f.unit_verified === false ? ' **⚠️未核实**' : ''}` : '—'
          push(`| \`${f.path}\` | ${f.label || ''} | ${typeCell} | ${unitCellRaw} | ${f.required ? '是' : '否'} | ${f.nullable ? '是' : '否'} | ${f.emitted === false ? '**否**' : '是'} | ${desc} |`)
        }
        push('')
      }
      for (const g of activeGrants) {
        const cust = custOf.get(g.school_code) || {}
        const cf = cust.custom_fields && typeof cust.custom_fields === 'object' ? cust.custom_fields : {}
        const labels = cust.field_labels && typeof cust.field_labels === 'object' ? cust.field_labels : {}
        const types = resolveGrantTypes(g)
        const typeLists = types.map((t) => {
          const arr = Array.isArray(cf[t]) ? cf[t] : []
          const names = arr.filter((f) => f && f.name).map((f) => String(f.name))
          const localLabels = { ...labels }
          for (const f of arr) if (f && f.name && f.label) localLabels[f.name] = String(f.label)
          return { t, fields: listFieldDescriptors(t, { customFieldNames: names, fieldLabels: localLabels }) }
        })
        const schoolName = nameOf.get(g.school_code) || g.school_code
        push(`### ${schoolName} / 公共字段`, '')
        if (!typeLists.length) {
          push('（该校当前未开放任何类型）', '')
          continue
        }
        const common = commonAcross(typeLists.map((x) => x.fields))
        renderFieldTable(typeLists[0].fields.filter((f) => common.has(f.path)))
        for (const { t, fields } of typeLists) {
          push(`### ${schoolName} / ${t} · 专属字段`, '')
          const own = fields.filter((f) => !common.has(f.path))
          if (!own.length) push('（无专属字段，全部为上方公共字段）', '')
          else renderFieldTable(own)
        }
      }

      push('## 4. 合成样例（非真实数据）', '', '> 以下为**构造样例**，`record_code` 以 `SAMPLE-` 前缀标记，请勿写入正式数据集；字段形态与真实响应一致。', '')
      for (const g of activeGrants) {
        // 字段白名单（与字典同源；2026-09-16 审阅 M2）：样例必须与真实下发一致
        const keyMap = buildAllowedResultKeyMap(
          resolveGrantTypes(g),
          (t) => extractCustomFieldMeta(custOf.get(g.school_code) || {}, t),
        )
        for (const t of resolveGrantTypes(g)) {
          for (const s of buildSyntheticSamples(t)) {
            const item = buildOpenRecord(s.record, g, { schoolCode: g.school_code, schoolName: nameOf.get(g.school_code) || null, allowedResultKeys: keyMap.get(t) })
            push(`### ${g.school_code} / ${t} / ${s.scenario}`, '', '```json', JSON.stringify(item, null, 2), '```', '')
          }
        }
      }

      push(
        '## 5. 同步规则（必读）',
        '',
        '**每轮顺序（请不要颠倒，尤其是"删除判定"必须在一致性校验通过之后）**：',
        '',
        '1. 取本轮范围与初始指纹：`GET /sync/manifest?school_code=<校>`（只取 `total` + `digest`）。',
        '   `digest` 覆盖：游标协议版本 + `scope_version` + `projection_fingerprint` + 每条 `record_code@updated_at`。',
        '2. `digest` 与本地保存的一致 → **本轮结束**（不拉明细、**不做任何删除**）。',
        '3. `digest` 变化 → 带 `detail=1` 拉**完整清单**。若返回 `413` 或任何错误，**不得当作空清单**，按第 7 条处理。',
        '4. 拉取所需明细（`test-records` 游标分页）并**暂存**本轮结果：按 `record_code` **整体覆盖**本地记录。',
        '5. 结束前**再取一次** `manifest`：与第 1 步的 `digest` 不一致 → 说明本轮期间数据又变了：**丢弃本轮暂存结果并重跑一轮**。',
        '6. 两读一致 → 本轮才算成功：此时才提交暂存结果、执行"缺失记录"处理（见下）、保存水位与游标。',
        '7. 任何一步失败（401/403/409/429/超时/解析失败/分页中断）→ **保留上一轮完成状态与水位**，退避后重试；'
          + '**重试必须有上限**（建议指数退避：单轮最多 5 次、总时长 ≤ 10 分钟），仍失败则放弃本轮并告警，不要无限重跑。',
        '',
        '**"清单里没有" ≠ "源记录被物理删除"**：记录可能因**业务日期范围、状态、类型可见性**变化而移出当前有效范围。'
          + '统一表述为「**当前有效范围内已不可见**」→ 按双方约定标记撤回/不可见；接口未给出删除原因时，**不要推断源端发生了物理删除**。',
        '',
        '**`next_cursor` 语义（写代码前必读）**：',
        '- 只在**成功处理完一页之后**保存 `next_cursor`；不要预先保存；',
        '- 最后一页 `has_more:false`、`next_cursor:null` → **清空本地游标**，下一轮从 `manifest` 重新对账；',
        '- 游标**不是**下一轮水位：它绑定「学校 + 筛选条件 + `scope_version` + `projection_fingerprint` + 水位 `(updated_at,id)`」，'
          + '换学校/换筛选条件/授权或字段可见性变化后必须丢弃（否则 400 / 409）；',
        '- 游标无固定有效期，但**不建议跨轮次长期保存**：每轮以 `manifest` 为准，游标仅用于单轮内翻页与断点续传；',
        '- 若清单显示某条记录已变更，但你方水位已越过它：用 `since=<字符串时间>` 做**重叠回拉**（建议回退 5 分钟）并幂等去重。',
        '',
        '**增量依据**：`updated_at` 用于**记录变更排序**（排序键 `(updated_at ASC, id ASC)`，同一时间戳靠 `id` 决胜）；'
          + '**完整同步还必须结合服务端游标、`scope_version` 与清单 `digest` 对账**，不得仅凭 `updated_at` 判定同步完成'
          + '（`created_at` 对历史导入数据可能等于业务日期零点，**不可**用于增量）。',
        '',
        '**字段撤回与记录级字段减少**：授权关闭「检测人姓名」后，新响应不再包含该字段；此外平台可能对**单条记录**做规范化'
          + '（如移除 `result` 内的历史同义副本），此时只有 `updated_at`/`digest` 变化，`projection_fingerprint` **不变**。'
          + '两种情况都按同一条规则处理：**凡重新获取到的记录，一律以新响应的完整对象整体覆盖本地同 `record_code` 记录**'
          + '（并清除新响应中已不存在的字段）；本接口只返回完整对象，不存在"部分响应"语义。你方自有业务字段请单独存放，避免被平台对象覆盖。',
        '',
        '收到 `409 SCOPE_CHANGED`（授权或字段可见性变化 / 游标过旧）→ 回到第 1 步重新对账，并重新拉取全部明细以重新投影。',
        '',
        '## 6. 错误码与处理动作',
        '',
        '| HTTP | code | 含义 | 你方应做什么 |',
        '|---|---|---|---|',
        '| 401 | `MISSING_KEY` / `INVALID_KEY` / `CREDENTIAL_REVOKED` / `CREDENTIAL_EXPIRED` | 未携带 / 无效 / 已吊销 / 已过期 | **不要重试**：检查密钥配置与是否已轮换；必要时联系平台换新密钥 |',
        '| 403 | `CLIENT_DISABLED` / `IP_DENIED` / `SCHOOL_NOT_AUTHORIZED` / `TYPE_NOT_AUTHORIZED` | 对接方停用 / IP 不在白名单 / 未授权学校 / 未授权类型 | **不要重试**：核对授权范围与出口 IP；需要变更请联系平台 |',
        '| 400 | `INVALID_CURSOR` / `CURSOR_SCHOOL_MISMATCH` / `CURSOR_FILTER_MISMATCH` / `INVALID_SINCE` / `INVALID_UNTIL` | 游标非法 / 换学校 / 换筛选条件复用游标 / 时间参数非法 | 丢弃本地游标，改从 `manifest` 重新对账后重拉 |',
        '| 409 | `SCOPE_CHANGED` | 授权或字段可见性变化、游标协议过旧 | 重新对账 + **全量重拖并替换式重投影**（不要指望增量覆盖被撤回字段） |',
        '| 413 | `MANIFEST_TOO_LARGE` | 清单超单次上限（**明确拒绝，不返回截断清单**） | **不得当作空清单**：停止对账并联系平台改为分页清单方案 |',
        '| 429 | `RATE_LIMITED` | 触发限流 | 按 `Retry-After` 退避（配合指数退避），降低并发与频率 |',
        '| 5xx / 超时 | — | 平台侧异常 | 有界重试（指数退避 + 上限）；期间**保留旧水位**；持续失败联系平台 |',
        '',
        '## 7. 接入检查清单',
        '',
        '- [ ] `GET /ping` 通，且服务器时间与本机偏差可接受',
        '- [ ] `GET /profile` 的学校与类型范围与本文件 §2 快照一致；**不一致时以 `/profile` 为准**',
        '- [ ] `GET /dict` 能取到字段字典（据此完成字段映射，含"是否下发"与单位口径）',
        '- [ ] `GET /samples` 能取到合成样例（覆盖合格/不合格/复检等场景，且场景与结论一致）',
        '- [ ] 全量拉取一次：条数与 `manifest.total` 一致，`record_code` 无重复',
        '- [ ] 增量拉取：翻页不重不漏；**最后一页 `next_cursor=null` 时已清空本地游标**',
        '- [ ] 本地记录按"**整体替换**"落地（含记录级字段减少：新响应没有的字段会被清除）',
        '- [ ] 未授权学校/类型被 403 拒绝；错误码按 §6 的"应做什么"分流（401/403 不重试）',
        '- [ ] 已实现：`digest` 二读一致后才提交/删除、失败不当空清单、`413` 有处理、重试有上限',
        '- [ ] 抽样 3~5 条与平台方人工核对字段与结论（含不合格与复检各至少 1 条）',
        '',
      )

      const md = L.join('\n')
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="open-api-onboarding-${client.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.md"`)
      res.send(md)
    } catch (e) {
      console.error(`${TAG} 接入包生成失败:`, e)
      res.status(500).json({ success: false, error: e.message || '接入包生成失败' })
    }
  })

  /** 导出配置（灾后重建；public 段不参与备份恢复，故提供此出口）。 */
  router.get('/export', async (req, res) => {
    try {
      const clients = await prisma.openApiClient.findMany({ include: { credentials: true, grants: true } })
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="open-api-config-${new Date().toISOString().slice(0, 10)}.json"`)
      res.send(JSON.stringify({
        version: 1,
        exported_at: new Date().toISOString(),
        note: '开放接口配置导出（含密钥哈希，不含明文密钥）；导入后第三方无需更换 Key',
        clients,
      }, null, 2))
    } catch (e) {
      console.error(`${TAG} 导出失败:`, e)
      res.status(500).json({ success: false, error: e.message || '导出失败' })
    }
  })

  /** 导入配置（按 id upsert；凭证按 key_hash 去重）。 */
  router.post('/import', async (req, res) => {
    try {
      const payload = req.body || {}
      const clients = Array.isArray(payload.clients) ? payload.clients : null
      if (!clients) return badRequest(res, 'payload.clients 必须为数组')
      if (clients.length > 200) return badRequest(res, '单次最多导入 200 个对接方')

      let clientCount = 0, grantCount = 0, credentialCount = 0
      for (const c of clients) {
        const data = {
          name: String(c.name || '未命名对接方').slice(0, 100),
          description: c.description ? String(c.description).slice(0, 500) : null,
          status: c.status === 'disabled' ? 'disabled' : 'active',
          ip_whitelist: Array.isArray(c.ip_whitelist) ? c.ip_whitelist.slice(0, MAX_IP_ENTRIES) : [],
          rate_limit_per_min: Number(c.rate_limit_per_min) > 0 ? Number(c.rate_limit_per_min) : 60,
          created_by: req.user?.username || 'import',
        }
        const saved = await prisma.openApiClient.upsert({
          where: { id: String(c.id) },
          create: { id: String(c.id), ...data },
          update: data,
        })
        clientCount++

        for (const g of Array.isArray(c.grants) ? c.grants : []) {
          if (!isValidSchoolCode(String(g.school_code || ''))) continue
          const start = parseDay(dayStr(g.start_date))
          const end = parseDay(dayStr(g.end_date))
          const value = {
            visible_types: Array.isArray(g.visible_types) ? g.visible_types : null,
            include_pathogen: g.include_pathogen === true,
            include_inspector: g.include_inspector === true,
            include_attachments: g.include_attachments === true,
            start_date: start ?? null,
            end_date: end ?? null,
            status: g.status === 'disabled' ? 'disabled' : 'active',
            scope_version: Number(g.scope_version) > 0 ? Number(g.scope_version) : 1,
          }
          await prisma.openApiGrant.upsert({
            where: { client_id_school_code: { client_id: saved.id, school_code: String(g.school_code) } },
            create: { client_id: saved.id, school_code: String(g.school_code), ...value },
            update: value,
          })
          grantCount++
        }

        for (const k of Array.isArray(c.credentials) ? c.credentials : []) {
          if (!k.key_hash) continue
          const exists = await prisma.openApiCredential.findUnique({ where: { key_hash: String(k.key_hash) } })
          if (exists) continue
          await prisma.openApiCredential.create({
            data: {
              client_id: saved.id,
              label: String(k.label || '生产').slice(0, 40),
              key_hash: String(k.key_hash),
              key_prefix: String(k.key_prefix || 'oap_'),
              key_last4: String(k.key_last4 || ''),
              status: k.status === 'revoked' ? 'revoked' : 'active',
              expires_at: k.expires_at ? new Date(k.expires_at) : null,
              revoked_at: k.revoked_at ? new Date(k.revoked_at) : null,
              revoked_reason: k.revoked_reason ? String(k.revoked_reason).slice(0, 200) : null,
              created_by: req.user?.username || 'import',
            },
          })
          credentialCount++
        }
      }

      await writeAdminOpsLog(prisma, {
        action: OPS_ACTION.configImport, actor: actorOf(req), targetId: '', targetSchoolCode: null,
        details: { clientCount, grantCount, credentialCount }, level: 'warn',
      })
      res.json({ success: true, data: { clientCount, grantCount, credentialCount } })
    } catch (e) {
      console.error(`${TAG} 导入失败:`, e)
      res.status(500).json({ success: false, error: e.message || '导入失败' })
    }
  })

  return router
}

/** IP 白名单归一：返回数组（可为空）或 undefined（非法）。 */
function normalizeIpWhitelist(raw) {
  if (raw == null) return []
  if (!Array.isArray(raw)) return undefined
  if (raw.length > MAX_IP_ENTRIES) return undefined
  const out = []
  for (const item of raw) {
    const s = String(item || '').trim()
    if (!s) continue
    if (!IP_OR_CIDR_RE.test(s)) return undefined
    out.push(s)
  }
  return out
}

export default createAdminOpenApiRoutes
