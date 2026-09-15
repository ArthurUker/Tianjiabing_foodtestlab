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
import { resolveGrantTypes, grantDateRange, buildOpenRecord } from '../lib/openApiScope.js'

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

/** 判断授权范围是否有实质变化（用于 scope_version 递增 → 触发对方重新同步）。 */
function scopeSignature(g) {
  return JSON.stringify({
    t: Array.isArray(g.visible_types) ? [...g.visible_types].sort() : null,
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
      if (!grant) return badRequest(res, '该校未授权给此对接方')

      const school = await prisma.school.findUnique({ where: { code: schoolCode }, select: { code: true, name: true } })
      const schema = schemaNameOf(schoolCode)
      assertSafeSchemaName(schema)
      const types = resolveGrantTypes(grant)
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
          items: rows.map((r) => buildOpenRecord(r, grant, { schoolCode, schoolName: school?.name || null })),
        },
      })
    } catch (e) {
      console.error(`${TAG} 预览失败:`, e)
      res.status(500).json({ success: false, error: e.message || '预览失败' })
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
