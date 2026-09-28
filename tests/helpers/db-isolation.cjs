'use strict'
/**
 * P3-W0-T02A-R1 — 共享数据库测试隔离门禁（单一事实源；无加载副作用）。
 *
 * 本版闭合复审 R1/R2 的两组缺口：
 *   A) 核验可在**真正执行 SQL 的客户端**上运行（pg Client 或 Prisma interactive transaction 薄适配），
 *      并显式核对 expected schema / namespace 归属 / marker 只读；两条消费链各自可观测拒绝。
 *   B) 上下文不再"声称允许就允许"：allowedSchemas / tenant codes / roleAudit / markerTable /
 *      fixture 清单必须与 runId 派生契约**精确相等**；URL 参数全解析、重复身份参数拒绝、
 *      decode 异常固定安全错误；拒绝默认 5432；角色属性必须完整且严格 false、拒绝一切成员关系。
 *
 * P3-DB-FIXTURE-R1（R7 CLOSE-B B1 取 O1）：门禁 fixture 对象**迁出 public 与学校 schema**，
 *   放入 runId 派生的专用 fixture schema（`t02a_fx_<runId>`，owner = 任务管理角色）：
 *     · marker：`<fx>.t02a_instance_marker`（测试角色只读；写权限集合必须全 false）；
 *     · messages：每租户 slot 一张 `<fx>.messages_{a,b,c}`（物理分离；产物 schema 不再有合成表）；
 *     · `public.revoked_tokens` 是**正式认证基础设施**，留在 public，不搬迁、不降级。
 *   哨兵（`t02a_sent_<runId>` + 独立 owner）语义不变：不进 allowedSchemas、测试角色不可写。
 *
 * 加载本模块无副作用：不连接、不读 dotenv、不写文件、不改 env。
 */
const fs = require('node:fs')

const CODES = Object.freeze({
  MISSING_TEST_URL: 'MISSING_TEST_URL',
  MISSING_CONTEXT: 'MISSING_CONTEXT',
  CONTEXT_UNREADABLE: 'CONTEXT_UNREADABLE',
  CONTEXT_INVALID: 'CONTEXT_INVALID',
  CONTRACT_MISMATCH: 'CONTRACT_MISMATCH',
  URL_INVALID: 'URL_INVALID',
  URL_MISMATCH: 'URL_MISMATCH',
  URL_PARAM_FORBIDDEN: 'URL_PARAM_FORBIDDEN',
  URL_PARAM_DUPLICATE: 'URL_PARAM_DUPLICATE',
  DEFAULT_PORT_REJECTED: 'DEFAULT_PORT_REJECTED',
  BUSINESS_NAME_REJECTED: 'BUSINESS_NAME_REJECTED',
  IDENTIFIER_INVALID: 'IDENTIFIER_INVALID',
  REGISTRY_REJECTED: 'REGISTRY_REJECTED',
  RUNTIME_IDENTITY_MISMATCH: 'RUNTIME_IDENTITY_MISMATCH',
  RUNTIME_PRIVILEGE_REJECTED: 'RUNTIME_PRIVILEGE_REJECTED',
  RUNTIME_MEMBERSHIP_REJECTED: 'RUNTIME_MEMBERSHIP_REJECTED',
  MARKER_MISMATCH: 'MARKER_MISMATCH',
  SCHEMA_NOT_ALLOWED: 'SCHEMA_NOT_ALLOWED',
  PG_MODULE_MISSING: 'PG_MODULE_MISSING',
  TARGET_URL_DRIFT: 'TARGET_URL_DRIFT',
  TARGET_CODE_NOT_ALLOWED: 'TARGET_CODE_NOT_ALLOWED',
  PROBE_INDETERMINATE: 'PROBE_INDETERMINATE',
})

const ALLOWED_QUERY_PARAMS = Object.freeze(['schema', 'application_name'])
const ALLOWED_HOSTS = Object.freeze(['127.0.0.1', '::1'])
const FORBIDDEN_ROLE_ATTRS = Object.freeze(['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'])
const DEFAULT_PG_PORTS = Object.freeze(['5432'])
/** 本任务固定 fixture 契约（与 runId 无关的常量部分；schema 限定名由 derivedNamespace 生成）。 */
const FIXTURE_CONTRACT = Object.freeze({
  /** 专用 fixture schema 前缀：`${fixtureSchemaPrefix}${runId}`（owner = 任务管理角色）。 */
  fixtureSchemaPrefix: 't02a_fx_',
  /** marker 表名（位于 fixture schema；测试角色只读）。 */
  markerTableName: 't02a_instance_marker',
  /** 每租户 slot 的合成 messages 表名（位于 fixture schema；物理分离）。 */
  messagesTablePrefix: 'messages_',
  messagesSlots: Object.freeze(['a', 'b', 'c']),
  /** 留在 public 的正式基础设施（认证事实源；不在 fixture schema，不搬迁）。 */
  publicFixtureObjects: Object.freeze(['public.revoked_tokens']),
  tenantSlots: Object.freeze(['a', 'b', 'c', 'ra']),
  /** 任务行键允许列（结构化清理仅接受这些列名）。 */
  rowKeyColumns: Object.freeze(['tenant_tag', 'user_id', 'record_code', 'id']),
})
const BUSINESS_NAME_PATTERNS = Object.freeze([
  /^foodsentinel/i, /^food_lab/i, /^school_tjb/i, /^school_a$/i, /^school_b$/i, /^school_c$/i,
  /^postgres$/i, /^test$/i, /^school_reviewtest$/i,
])
const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/
const RUN_ID_RE = /^[a-z0-9]{8,32}$/
const TENANT_CODE_RE = /^[a-z0-9-]{1,40}$/

class IsolationError extends Error {
  constructor(code, reason, detail) {
    super(`[${code}] ${reason}`)
    this.name = 'IsolationError'
    this.code = code
    this.reason = reason
    this.detail = detail || null
  }
}
const reject = (code, reason, detail) => ({ ok: false, code, reason, detail: detail || null })

function isBusinessLikeName(name) {
  if (typeof name !== 'string' || name === '') return true
  return BUSINESS_NAME_PATTERNS.some((re) => re.test(name))
}
function quoteIdent(name) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new IsolationError(CODES.IDENTIFIER_INVALID, 'identifier fails strict allowlist', { length: typeof name === 'string' ? name.length : -1 })
  }
  return `"${name}"`
}
function quoteQualified(qname) {
  const parts = String(qname).split('.')
  if (parts.length !== 2) throw new IsolationError(CODES.IDENTIFIER_INVALID, 'qualified name must be schema.table')
  return `${quoteIdent(parts[0])}.${quoteIdent(parts[1])}`
}
/** 拆分并严格校验 schema.table（返回原始标识符；不用于 SQL 拼接）。 */
function splitQualified(qname) {
  quoteQualified(qname)
  const [schema, table] = String(qname).split('.')
  return { schema, table }
}
function tenantCodeFor(runId, slot) {
  if (!RUN_ID_RE.test(String(runId))) throw new IsolationError(CODES.IDENTIFIER_INVALID, 'runId format invalid')
  if (!/^[a-z]{1,2}$/.test(String(slot))) throw new IsolationError(CODES.IDENTIFIER_INVALID, 'tenant slot format invalid')
  const code = `t02a-${runId}-${slot}`
  if (!TENANT_CODE_RE.test(code) || code.length > 40) throw new IsolationError(CODES.IDENTIFIER_INVALID, 'derived tenant code out of range')
  return code
}

/** runId 派生的完整任务命名空间（唯一权威；上下文必须与它精确相等）。 */
function derivedNamespace(runId) {
  if (!RUN_ID_RE.test(String(runId))) throw new IsolationError(CODES.CONTEXT_INVALID, 'runId format invalid')
  const tenants = {}
  const schemas = {}
  for (const slot of FIXTURE_CONTRACT.tenantSlots) {
    tenants[slot] = tenantCodeFor(runId, slot)
    schemas[slot] = `school_${tenants[slot].replace(/-/g, '_')}`
  }
  const fixtureSchema = `${FIXTURE_CONTRACT.fixtureSchemaPrefix}${runId}`
  const markerTable = `${fixtureSchema}.${FIXTURE_CONTRACT.markerTableName}`
  const fixtureMessages = {}
  const fixtureObjects = []
  for (const slot of FIXTURE_CONTRACT.messagesSlots) {
    fixtureMessages[slot] = `${fixtureSchema}.${FIXTURE_CONTRACT.messagesTablePrefix}${slot}`
    fixtureObjects.push(fixtureMessages[slot])
  }
  fixtureObjects.push(markerTable, ...FIXTURE_CONTRACT.publicFixtureObjects)
  return {
    runId,
    database: `t02a_iso_${runId}`,
    role: `t02a_role_${runId}`,
    adminRole: `t02a_admin_${runId}`,
    sentinelOwner: `t02a_sentinel_${runId}`,
    sentinelSchema: `t02a_sent_${runId}`,
    fixtureSchema,
    fixtureMessages: Object.freeze(fixtureMessages),
    instanceTag: `t02a-${runId}`,
    markerTable,
    fixtureObjects: Object.freeze(fixtureObjects),
    tenants,
    schemas,
    allowedSchemas: ['public', schemas.a, schemas.b, schemas.c, schemas.ra, fixtureSchema],
    roleAudit: { schema: schemas.ra, userId: `t02a-${runId}-user`, username: `t02a_${runId}_user` },
  }
}

/** 深冻结（顶层与全部嵌套对象/数组；篡改不能改变后续允许范围）。 */
function deepFreeze(value, seen = new Set()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = value[key]
    if (child && (typeof child === 'object' || typeof child === 'function')) deepFreeze(child, seen)
  }
  return Object.freeze(value)
}

const sortedCopy = (arr) => arr.slice().sort()

/**
 * 纯配置校验（连接之前；无副作用）。
 * @returns {{ok:true,cfg:object}|{ok:false,code:string,reason:string,detail:object|null}}
 */
function checkIsolationConfig(env = process.env) {
  const testUrl = env.TEST_DATABASE_URL
  if (!testUrl || typeof testUrl !== 'string' || testUrl.trim() === '') {
    return reject(CODES.MISSING_TEST_URL, 'TEST_DATABASE_URL is required (no default, no DATABASE_URL fallback)')
  }
  const ctxPath = env.TEST_DB_CONTEXT_FILE
  if (!ctxPath || typeof ctxPath !== 'string' || ctxPath.trim() === '') {
    return reject(CODES.MISSING_CONTEXT, 'TEST_DB_CONTEXT_FILE is required (task-runner generated context)')
  }
  let ctx
  try {
    ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'))
  } catch (e) {
    return reject(e && e.code === 'ENOENT' ? CODES.CONTEXT_UNREADABLE : CODES.CONTEXT_INVALID, 'context file unreadable or not valid JSON', { reason: (e && e.code) || 'INVALID_JSON' })
  }
  if (!ctx || typeof ctx !== 'object' || !ctx.instance || typeof ctx.instance !== 'object') {
    return reject(CODES.CONTEXT_INVALID, 'context.instance missing')
  }
  if (!RUN_ID_RE.test(String(ctx.runId || ''))) return reject(CODES.CONTEXT_INVALID, 'context.runId format invalid')

  let derived
  try { derived = derivedNamespace(String(ctx.runId)) } catch { return reject(CODES.CONTEXT_INVALID, 'context.runId cannot derive a task namespace') }

  const inst = ctx.instance
  for (const k of ['host', 'port', 'database', 'role', 'instanceTag', 'markerTable']) {
    if (inst[k] === undefined || inst[k] === null || inst[k] === '') return reject(CODES.CONTEXT_INVALID, `context.instance.${k} missing`)
  }
  if (!ALLOWED_HOSTS.includes(String(inst.host))) return reject(CODES.CONTEXT_INVALID, 'context.instance.host must be exact loopback', { allowedHosts: ALLOWED_HOSTS.join(',') })
  const port = Number(inst.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return reject(CODES.CONTEXT_INVALID, 'context.instance.port invalid')
  if (DEFAULT_PG_PORTS.includes(String(port))) return reject(CODES.DEFAULT_PORT_REJECTED, 'default PostgreSQL port is not allowed for the task instance')

  // ── 契约精确绑定（不是"上下文声称允许就允许"）──
  const contractChecks = [
    ['instance.database', String(inst.database), derived.database],
    ['instance.role', String(inst.role), derived.role],
    ['instance.instanceTag', String(inst.instanceTag), derived.instanceTag],
    ['instance.markerTable', String(inst.markerTable), derived.markerTable],
  ]
  for (const [field, actual, expected] of contractChecks) {
    if (actual !== expected) return reject(CODES.CONTRACT_MISMATCH, `${field} does not match the runId-derived task contract`, { field })
  }
  if (!Array.isArray(ctx.allowedSchemas) || ctx.allowedSchemas.length === 0) return reject(CODES.CONTEXT_INVALID, 'context.allowedSchemas must be a non-empty array')
  for (const s of ctx.allowedSchemas) {
    if (typeof s !== 'string' || !IDENT_RE.test(s)) return reject(CODES.CONTEXT_INVALID, 'context.allowedSchemas contains an invalid identifier')
  }
  if (JSON.stringify(sortedCopy(ctx.allowedSchemas)) !== JSON.stringify(sortedCopy(derived.allowedSchemas))) {
    return reject(CODES.CONTRACT_MISMATCH, 'allowedSchemas must be exactly the runId-derived namespace set (fixed business schemas are rejected)', { field: 'allowedSchemas' })
  }
  for (const slot of FIXTURE_CONTRACT.tenantSlots) {
    const claimed = ctx.tenants && ctx.tenants[slot]
    if (claimed !== undefined && claimed !== derived.tenants[slot]) {
      return reject(CODES.CONTRACT_MISMATCH, `context.tenants.${slot} does not match the derived tenant code`, { field: `tenants.${slot}` })
    }
  }
  if (ctx.roleAudit) {
    if (ctx.roleAudit.schema !== derived.roleAudit.schema) return reject(CODES.CONTRACT_MISMATCH, 'roleAudit.schema outside the derived namespace', { field: 'roleAudit.schema' })
    if (ctx.roleAudit.userId !== derived.roleAudit.userId) return reject(CODES.CONTRACT_MISMATCH, 'roleAudit.userId is not the task-generated user', { field: 'roleAudit.userId' })
    if (ctx.roleAudit.username !== derived.roleAudit.username) return reject(CODES.CONTRACT_MISMATCH, 'roleAudit.username is not the task-generated username', { field: 'roleAudit.username' })
  }
  if (ctx.sentinel && ctx.sentinel.schema !== undefined && ctx.sentinel.schema !== derived.sentinelSchema) {
    return reject(CODES.CONTRACT_MISMATCH, 'sentinel.schema outside the derived namespace', { field: 'sentinel.schema' })
  }
  if (ctx.fixture && ctx.fixture.schema !== undefined && ctx.fixture.schema !== derived.fixtureSchema) {
    return reject(CODES.CONTRACT_MISMATCH, 'fixture.schema outside the derived namespace', { field: 'fixture.schema' })
  }
  if (!Array.isArray(ctx.allowedFixtureObjects) || ctx.allowedFixtureObjects.length === 0) {
    return reject(CODES.CONTEXT_INVALID, 'context.allowedFixtureObjects must be a non-empty array')
  }
  for (const obj of ctx.allowedFixtureObjects) {
    if (typeof obj !== 'string' || !derived.fixtureObjects.includes(obj)) {
      return reject(CODES.CONTRACT_MISMATCH, 'allowedFixtureObjects contains an object outside the runId-derived fixture contract', { field: 'allowedFixtureObjects' })
    }
  }
  if (JSON.stringify(sortedCopy(ctx.allowedFixtureObjects)) !== JSON.stringify(sortedCopy(derived.fixtureObjects))) {
    return reject(CODES.CONTRACT_MISMATCH, 'allowedFixtureObjects must be exactly the runId-derived fixture object set', { field: 'allowedFixtureObjects' })
  }
  // 业务样式名称（固定业务 schema/库/角色/tag 即使"派生得像"也要拒绝）
  for (const [label, val] of [['database', derived.database], ['role', derived.role], ['instanceTag', derived.instanceTag], ['allowedSchemas', derived.allowedSchemas.join(',')]]) {
    if (isBusinessLikeName(String(val)) || /\bschool_(tjb|a|b|c)\b/.test(String(val))) {
      return reject(CODES.BUSINESS_NAME_REJECTED, `${label} looks like a business/default name`)
    }
  }

  // ── URL 解析（全参数；重复身份参数与 decode 异常明确拒绝）──
  let u
  try {
    u = new URL(testUrl)
  } catch {
    return reject(CODES.URL_INVALID, 'TEST_DATABASE_URL is not a valid URL')
  }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') return reject(CODES.URL_INVALID, 'TEST_DATABASE_URL must be a postgresql:// URL')
  if (!u.username) return reject(CODES.URL_INVALID, 'TEST_DATABASE_URL must include an explicit user')

  const seenKeys = []
  for (const key of u.searchParams.keys()) {
    if (seenKeys.includes(key)) continue
    seenKeys.push(key)
    if (u.searchParams.getAll(key).length > 1) {
      return reject(CODES.URL_PARAM_DUPLICATE, 'duplicate URL parameter is not allowed', { param: key })
    }
    if (!ALLOWED_QUERY_PARAMS.includes(key)) {
      return reject(CODES.URL_PARAM_FORBIDDEN, 'URL query parameter is not in the allowlist', { param: key, allowed: ALLOWED_QUERY_PARAMS.join(',') })
    }
  }
  const schemaParam = u.searchParams.get('schema') || undefined
  if (schemaParam !== undefined && !derived.allowedSchemas.includes(schemaParam)) {
    return reject(CODES.SCHEMA_NOT_ALLOWED, 'URL schema parameter is outside the derived namespace')
  }

  let urlDb
  let urlUser
  try {
    urlDb = decodeURIComponent(u.pathname.replace(/^\//, ''))
    urlUser = decodeURIComponent(u.username)
  } catch {
    // decode 异常：固定安全错误，不打印原输入
    return reject(CODES.URL_INVALID, 'TEST_DATABASE_URL contains invalid percent-encoding')
  }
  const urlPort = u.port === '' ? '5432' : u.port
  if (DEFAULT_PG_PORTS.includes(String(urlPort))) return reject(CODES.DEFAULT_PORT_REJECTED, 'URL uses the default PostgreSQL port')
  if (u.hostname !== String(inst.host)) return reject(CODES.URL_MISMATCH, 'URL host does not match context', { field: 'host' })
  if (urlPort !== String(port)) return reject(CODES.URL_MISMATCH, 'URL port does not match context', { field: 'port' })
  if (urlDb !== String(inst.database)) return reject(CODES.URL_MISMATCH, 'URL database does not match context', { field: 'database' })
  if (urlUser !== String(inst.role)) return reject(CODES.URL_MISMATCH, 'URL user does not match context', { field: 'user' })

  const cfg = deepFreeze({
      url: testUrl,
      host: String(inst.host),
      port,
      database: urlDb,
      role: String(inst.role),
      runId: derived.runId,
      instanceTag: derived.instanceTag,
      markerTable: derived.markerTable,
      allowedSchemas: derived.allowedSchemas.slice(),
      allowedFixtureObjects: ctx.allowedFixtureObjects.slice(),
      tenants: { ...derived.tenants },
      schemas: { ...derived.schemas },
      roleAudit: { ...derived.roleAudit },
      sentinel: { schema: derived.sentinelSchema, owner: derived.sentinelOwner },
      fixtureSchema: derived.fixtureSchema,
      fixtureMessages: { ...derived.fixtureMessages },
      fixtureObjects: derived.fixtureObjects.slice(),
      adminRole: derived.adminRole,
      schemaParam,
      derived, // 冻结的派生契约快照（只读）
  })
  return { ok: true, cfg }
}

function assertIsolationConfigOrThrow(env = process.env) {
  const r = checkIsolationConfig(env)
  if (!r.ok) throw new IsolationError(r.code, r.reason, r.detail)
  return r.cfg
}
function describeRefusal(r) {
  if (r && r.ok === false) return { code: r.code, reason: r.reason, detail: r.detail }
  return { code: 'NONE', reason: 'config accepted', detail: null }
}

/**
 * 运行时核验（只读 SELECT；必须在业务读写/DDL/DML 之前、且在**真正执行 SQL 的客户端**上运行）。
 * @param {{query:Function}} client pg Client 或 Prisma transaction 薄适配（{query(sql, params)->{rows}}）
 * @param {object} cfg checkIsolationConfig().cfg
 * @param {{expectedSchema:string}} opts expectedSchema 必填（public 仅用于 fixture 特例）
 */
async function verifyRuntimeIdentity(client, cfg, opts = {}) {
  const expectedSchema = opts.expectedSchema
  if (!expectedSchema) throw new IsolationError(CODES.SCHEMA_NOT_ALLOWED, 'expectedSchema is required for runtime verification')
  if (!cfg.allowedSchemas.includes(expectedSchema)) {
    throw new IsolationError(CODES.SCHEMA_NOT_ALLOWED, 'expectedSchema is outside the derived namespace', { field: 'expectedSchema' })
  }

  const idRes = await client.query(
    `SELECT current_database() AS db, current_user AS cu, session_user AS su,
            inet_server_addr()::text AS addr, inet_server_port() AS port, current_schema() AS schema`
  )
  const id = (idRes.rows && idRes.rows[0]) || {}
  const mismatches = []
  if (id.db !== cfg.database) mismatches.push({ field: 'current_database', expected: cfg.database, actual: id.db })
  if (id.cu !== cfg.role) mismatches.push({ field: 'current_user', expected: cfg.role, actual: id.cu })
  if (id.su !== cfg.role) mismatches.push({ field: 'session_user', expected: cfg.role, actual: id.su })
  const serverPort = id.port === null || id.port === undefined ? null : Number(id.port)
  if (serverPort !== cfg.port) mismatches.push({ field: 'server_port', expected: cfg.port, actual: serverPort })
  const normalizedAddr = typeof id.addr === 'string' ? id.addr.split('/')[0] : id.addr
  // null 地址不放行（TCP 精确 loopback 契约）
  if (normalizedAddr === null || normalizedAddr === undefined) mismatches.push({ field: 'server_addr', expected: cfg.host, actual: null })
  else if (normalizedAddr !== cfg.host) mismatches.push({ field: 'server_addr', expected: cfg.host, actual: id.addr })
  if (id.schema !== expectedSchema) mismatches.push({ field: 'current_schema', expected: expectedSchema, actual: id.schema })
  if (mismatches.length > 0) {
    throw new IsolationError(CODES.RUNTIME_IDENTITY_MISMATCH, 'runtime identity does not match the task contract', { mismatches })
  }

  // 角色属性：必须恰好一条记录且五项为布尔 false（缺记录/null/非布尔 → 拒绝）
  const roleRes = await client.query(
    `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )
  if ((roleRes.rows || []).length !== 1) {
    throw new IsolationError(CODES.RUNTIME_PRIVILEGE_REJECTED, 'role record must exist exactly once', { rows: (roleRes.rows || []).length })
  }
  const role = roleRes.rows[0]
  if (role.rolname !== cfg.role) throw new IsolationError(CODES.RUNTIME_PRIVILEGE_REJECTED, 'role name mismatch', { field: 'rolname' })
  for (const attr of FORBIDDEN_ROLE_ATTRS) {
    const v = role[attr]
    if (v !== false) {
      throw new IsolationError(CODES.RUNTIME_PRIVILEGE_REJECTED, `role attribute ${attr} must be boolean false`, { attr, valueType: typeof v })
    }
  }

  // 拒绝测试角色的**所有**直接角色成员关系（切断间接成员提权路径；本包无成员需求）
  const memberRes = await client.query(
    `SELECT count(*)::int AS n FROM pg_auth_members m
     WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`
  )
  const memberCount = (memberRes.rows && memberRes.rows[0] && memberRes.rows[0].n) || 0
  if (memberCount !== 0) {
    throw new IsolationError(CODES.RUNTIME_MEMBERSHIP_REJECTED, 'test role must not hold any role membership', { count: memberCount })
  }

  // namespace 归属：expectedSchema 必须存在且 owner 为任务管理角色
  const nsRes = await client.query(
    `SELECT n.nspname AS schema, r.rolname AS owner FROM pg_namespace n
     JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1`,
    [expectedSchema]
  )
  if ((nsRes.rows || []).length !== 1) throw new IsolationError(CODES.SCHEMA_NOT_ALLOWED, 'expected schema does not exist', { field: 'expectedSchema' })
  // public 是清单内特例：PG15+ 的 public schema 归 pg_database_owner 所有（不再是 admin）；任务 schema 必须归 admin
  const owner = nsRes.rows[0].owner
  const allowedOwners = expectedSchema === 'public' ? ['pg_database_owner', cfg.adminRole] : [cfg.adminRole]
  if (!allowedOwners.includes(owner)) {
    throw new IsolationError(CODES.SCHEMA_NOT_ALLOWED, 'expected schema is not owned by the task admin role', { field: 'owner' })
  }

  // marker：存在、owner 为 admin、fixture schema 亦归 admin、且**测试角色对写权限集合全部为 false**
  // （INSERT/UPDATE/DELETE/TRUNCATE 任一为 true 即拒绝；只读性由 catalog 证明，保留 SELECT 读取）
  // P3-DB-FIXTURE-R1：marker 位于 runId 派生的 fixture schema（不再在 public）；schema/表名取自 cfg（已冻结校验）。
  const markerRef = splitQualified(cfg.markerTable)
  const markerRes = await client.query(
    `SELECT r.rolname AS owner,
            sr.rolname AS schema_owner,
            has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
            has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
            has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete,
            has_table_privilege(current_user, c.oid, 'TRUNCATE') AS can_truncate
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_roles r ON r.oid = c.relowner
     JOIN pg_roles sr ON sr.oid = n.nspowner
     WHERE n.nspname = $1 AND c.relname = $2`,
    [markerRef.schema, markerRef.table]
  )
  if ((markerRes.rows || []).length !== 1) throw new IsolationError(CODES.MARKER_MISMATCH, 'instance marker table is missing')
  const marker = markerRes.rows[0]
  if (marker.owner !== cfg.adminRole) throw new IsolationError(CODES.MARKER_MISMATCH, 'instance marker is not owned by the task admin role')
  if (marker.schema_owner !== cfg.adminRole) throw new IsolationError(CODES.MARKER_MISMATCH, 'instance marker schema is not owned by the task admin role')
  const markerWritePrivileges = ['can_insert', 'can_update', 'can_delete', 'can_truncate']
  for (const attr of markerWritePrivileges) {
    if (marker[attr] !== false) {
      throw new IsolationError(CODES.MARKER_MISMATCH, 'test role must not hold any write privilege on the instance marker', { attr, valueType: typeof marker[attr] })
    }
  }
  const markerValueRes = await client.query(
    `SELECT value FROM ${quoteQualified(cfg.markerTable)} WHERE key = 'instance_tag' LIMIT 1`
  )
  const markerValue = (markerValueRes.rows && markerValueRes.rows[0] && markerValueRes.rows[0].value) || null
  if (markerValue !== cfg.instanceTag) throw new IsolationError(CODES.MARKER_MISMATCH, 'instance marker value mismatch', { field: 'instance_tag' })

  return {
    ok: true,
    identity: { db: id.db, user: id.cu, sessionUser: id.su, serverPort, serverAddr: id.addr, schema: id.schema },
    role: { name: role.rolname },
    marker: { owner: marker.owner, canInsert: marker.can_insert, canUpdate: marker.can_update, canDelete: marker.can_delete, canTruncate: marker.can_truncate },
  }
}

/**
 * 前置目标检查（在创建客户端/开启事务**之前**调用；冻结验证后的 cfg）。
 * 覆盖：URL 漂移、tenant code 越界、expectedSchema 与实际目标关系不符（不允许改写目标关系）。
 * @returns {{ok:true, expectedSchema:string}} 或抛 IsolationError
 */
function assertTargetAllowed(cfg, { tenantCode = null, expectedSchema = null, url = undefined } = {}) {
    const currentUrl = url === undefined ? process.env.DATABASE_URL : url
    if (currentUrl !== cfg.url) {
        throw new IsolationError(CODES.TARGET_URL_DRIFT, 'DATABASE_URL drifted away from the frozen isolated cfg.url', { field: 'DATABASE_URL' })
    }
    const derived = derivedNamespace(cfg.runId)
    const isPublicTarget = tenantCode === null || tenantCode === '' || tenantCode === 'public'
    if (isPublicTarget) {
        if (expectedSchema !== null && expectedSchema !== 'public') {
            throw new IsolationError(CODES.SCHEMA_NOT_ALLOWED, 'public target cannot be re-labelled to another schema', { field: 'expectedSchema' })
        }
        return { ok: true, expectedSchema: 'public' }
    }
    const slots = Object.keys(derived.tenants)
    const slot = slots.find((s) => derived.tenants[s] === tenantCode)
    if (!slot) {
        throw new IsolationError(CODES.TARGET_CODE_NOT_ALLOWED, 'tenant code is outside the runId-derived set', { field: 'tenantCode' })
    }
    const derivedSchema = derived.schemas[slot]
    if (expectedSchema !== null && expectedSchema !== derivedSchema) {
        throw new IsolationError(CODES.SCHEMA_NOT_ALLOWED, 'expectedSchema does not match the tenant-derived schema (re-labelling is not allowed)', { field: 'expectedSchema' })
    }
    return { ok: true, expectedSchema: derivedSchema }
}

/**
 * pg Client 受控连接：connect 与 verify 都在同一受控 try 内；**失败路径总是尝试释放**已创建资源，
 * 原始 connect/query/verify 错误与 end 错误**同时保留**（不互相覆盖）。
 */
async function connectGuarded(cfg, { Client, connectTimeoutMs = 5000, expectedSchema } = {}) {
  if (!Client) throw new IsolationError(CODES.PG_MODULE_MISSING, 'pg Client constructor is required (pass explicitly)')
  const client = new Client({ connectionString: cfg.url, connectionTimeoutMillis: connectTimeoutMs, application_name: 't02a-isolation-gate' })
  let mainError = null
  let verified = null
  let stage = 'connect'
  try {
    await client.connect()
    stage = 'verify'
    verified = await verifyRuntimeIdentity(client, cfg, { expectedSchema: expectedSchema || cfg.schemaParam || 'public' })
  } catch (e) { mainError = e }
  if (!mainError) {
    return { client, verified }
  }
  // 释放：无论 connect 是否成功都尝试（pg Client.end 可安全重复调用）
  let releaseError = null
  try { await client.end() } catch (ee) { releaseError = ee }
  mainError.detail = {
    ...(mainError.detail || {}),
    stage,
    releaseAttempted: true,
    releaseError: releaseError ? { code: releaseError.code || 'UNKNOWN', message: String(releaseError.message).slice(0, 120) } : null,
  }
  throw mainError
}


// ── 检索/登记：结构化、绑定 cfg 与任务行键（拒绝越界 qname / 任意 whereSql / 空范围）──

/**
 * 构造绑定 cfg 的登记表：只接受**fixture schema 内的可写 messages 表** + 任务行键列 + 含 runId 的键值。
 * P3-DB-FIXTURE-R1：可写集合 = `<fx>.messages_{a,b,c}`（marker/revoked_tokens 不在其列 —— 前者只读、
 * 后者是正式认证基础设施）；学校 schema 与 public 内不再存在可写测试对象。
 */
function createRegistry(cfg) {
  if (!cfg || !cfg.fixtureMessages || typeof cfg.fixtureMessages !== 'object') throw new IsolationError(CODES.REGISTRY_REJECTED, 'registry requires a validated cfg')
  const allowedObjects = new Set(Object.values(cfg.fixtureMessages))
  const entries = []
  return {
    addTaskRow({ qname, keyColumn, keyValue }) {
      if (!allowedObjects.has(qname)) throw new IsolationError(CODES.REGISTRY_REJECTED, 'qname is outside the runId-derived fixture tables', { field: 'qname' })
      quoteQualified(qname) // 标识符严格校验
      if (!FIXTURE_CONTRACT.rowKeyColumns.includes(keyColumn)) throw new IsolationError(CODES.REGISTRY_REJECTED, 'key column is not in the task row-key allowlist', { field: 'keyColumn' })
      if (typeof keyValue !== 'string' || keyValue === '' || !keyValue.includes(cfg.runId)) {
        throw new IsolationError(CODES.REGISTRY_REJECTED, 'row key value must be non-empty and contain the task runId', { field: 'keyValue' })
      }
      entries.push({ kind: 'rows', qname, keyColumn, keyValue, runId: cfg.runId })
      return entries.length
    },
    list() { return entries.slice() },
    size() { return entries.length },
  }
}

/** 只清已登记结构（结构化 DELETE；失败聚合、保留原始错误，整体非零）。 */
async function cleanupRegistered(client, registry, ctx = {}) {
  const errors = []
  const items = registry.list().slice().reverse()
  for (const item of items) {
    try {
      await client.query(`DELETE FROM ${quoteQualified(item.qname)} WHERE ${quoteIdent(item.keyColumn)} = $1`, [item.keyValue])
    } catch (e) {
      errors.push({ kind: item.kind, qname: item.qname, code: (e && e.code) || 'UNKNOWN', message: e && e.message ? String(e.message).slice(0, 160) : 'unknown' })
    }
  }
  if (errors.length > 0) {
    const agg = new Error(`[CLEANUP_FAILED] ${errors.length} registered row(s) failed to clean; original error preserved`)
    agg.code = 'CLEANUP_FAILED'
    agg.cleanupErrors = errors
    if (ctx.originalError) agg.originalError = ctx.originalError
    throw agg
  }
  return { cleaned: items.length }
}

/**
 * 依次尝试多个释放/清理动作；**每个都执行**，不因第一处失败跳过；
 * 返回 { errors, originalError }，由调用方决定非零（不吞错、不用最后一个错误覆盖根因）。
 */
async function settleAll(actions, ctx = {}) {
  const errors = []
  for (const { name, fn } of actions) {
    try { await fn() } catch (e) { errors.push({ name, code: (e && e.code) || 'UNKNOWN', message: e && e.message ? String(e.message).slice(0, 160) : 'unknown' }) }
  }
  return { errors, originalError: ctx.originalError || null, ok: errors.length === 0 }
}

module.exports = {
  CODES,
  ALLOWED_QUERY_PARAMS,
  ALLOWED_HOSTS,
  FORBIDDEN_ROLE_ATTRS,
  DEFAULT_PG_PORTS,
  FIXTURE_CONTRACT,
  IsolationError,
  checkIsolationConfig,
  assertIsolationConfigOrThrow,
  describeRefusal,
  derivedNamespace,
  verifyRuntimeIdentity,
  assertTargetAllowed,
  deepFreeze,
  connectGuarded,
  createRegistry,
  cleanupRegistered,
  settleAll,
  tenantCodeFor,
  quoteIdent,
  quoteQualified,
  splitQualified,
  isBusinessLikeName,
}
