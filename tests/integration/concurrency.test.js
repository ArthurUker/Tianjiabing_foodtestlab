// tests/integration/concurrency.test.js
//
// 多租户隔离集成测试（方案② Schema-per-tenant）—— P3-W0-T02A-R1 修订版。
//
// 修订要点（闭合复审 R1/R3）：
//   * **Prisma 业务路径也先核验**：每个读/写都在新的 interactive transaction 上，先用共享
//     `verifyRuntimeIdentity`（薄适配）核验 expectedSchema/身份/marker，再执行同一 tx 的业务 SQL；
//     不以 pg Client 的验证结果或缓存结果给 Prisma 连接作担保。
//   * 新增 A 组拒绝负例：schema 越界（连接前）/ 运行时 schema 不符 / 业务 SQL=0 的实际调用观测。
//   * 并发写入：每个事务**提交成功后立即登记**行键；`Promise.allSettled` 等全部结束后再清理。
//
// 保留原 10 个功能测试语义（4 个纯函数 + 2 个缓存/回落 + 4 个隔离/并发/无跨 schema 回落）。

import { PrismaClient } from '@prisma/client'
import {
  resolveSchemaName,
  createTenantClient,
  disconnectAllTenantClients,
} from '../../backend/lib/tenantClient.js'
import gate from '../helpers/db-isolation.js'
import {
  loadIsolationConfig,
  tenantCodesFor,
  assertSchemaDerivationMatches,
  connectAsRestricted,
  createRegistry,
  cleanupRegistered,
  settleAll,
  withVerifiedTenantTx,
  verifyRuntimeIdentity,
  schemaOf,
  prismaTxAsQueryClient,
  TARGET_REFUSAL_CODES,
} from './pg-bootstrap.js'

let cfg
let client
let registry
let basePrisma
let TENANTS
let SCHEMAS
let FIXTURE_TABLES // P3-DB-FIXTURE-R1：tenant code → fixture schema 内该 slot 的 messages 表（物理分离）

beforeAll(async () => {
  cfg = loadIsolationConfig()
  expect(process.env.DATABASE_URL).toBe(cfg.url)
  // 门禁派生 schema 必须与生产 resolveSchemaName 一致（单一事实源交叉核对）
  expect(assertSchemaDerivationMatches(cfg)).toBe(true)
  const conn = await connectAsRestricted(cfg, 'public')
  client = conn.client
  registry = createRegistry(cfg)
  const codes = tenantCodesFor(cfg)
  TENANTS = [codes.a, codes.b, codes.c]
  SCHEMAS = TENANTS.map(schemaOf)
  const derivedFixtures = gate.derivedNamespace(cfg.runId)
  FIXTURE_TABLES = Object.fromEntries(TENANTS.map((t) => {
    const slot = Object.keys(derivedFixtures.tenants).find((s) => derivedFixtures.tenants[s] === t)
    return [t, derivedFixtures.fixtureMessages[slot]]
  }))
  basePrisma = new PrismaClient({ datasources: { db: { url: cfg.url } } })
})

afterAll(async () => {
  // 分别尝试所有释放/清理动作，不因第一处失败跳过；原始错误与后续错误都保留
  const result = await settleAll([
    // P3-DB-FIXTURE-R2：真实业务表行（runId 前缀）先清（用租户 tx；须在租户客户端断开之前）
    { name: 'cleanupBusinessRows', fn: () => cleanupBusinessRows() },
    { name: 'disconnectTenantClients', fn: () => disconnectAllTenantClients() },
    { name: 'basePrisma.$disconnect', fn: () => (basePrisma ? basePrisma.$disconnect() : Promise.resolve()) },
    { name: 'cleanupRegistered', fn: () => (client && registry ? cleanupRegistered(client, registry) : Promise.resolve()) },
    { name: 'pgClient.end', fn: () => (client ? client.end() : Promise.resolve()) },
  ])
  if (!result.ok) {
    const err = new Error(`[AFTER_ALL_FAILED] ${result.errors.length} teardown step(s) failed`)
    err.details = result.errors
    throw err
  }
})

// ── P3-DB-FIXTURE-R2：真实已迁移业务表（A/B 学校 schema）的元数据与清理 ──
//   · 正例矩阵只用**未限定表名**的业务查询（不得用 schema-qualified fixture 表冒充业务 search_path 正例，
//     见 R8 复审 §其它交叉点）；
//   · registry（createRegistry）只接受 fixture messages 表 → 业务行由本套件按 runId 前缀自清。
const BIZ_USER = '"User"'
const BIZ_RECORD = '"TestRecord"'
const bizKey = (kind, slot) => `r2-${kind}-${slot}-${cfg.runId}`
const bizLike = () => `r2-%-${cfg.runId}`

/** 本校自有 User 行（`created_by` 外键的目标；幂等 ensure，供 record 行与解析/命中用例共用）。 */
const ownUserKey = (slot) => bizKey('u', slot)
const ensureOwnUser = (slot, tenant) => withVerifiedTenantTx(basePrisma, cfg, tenant, async (tx) => {
  await tx.$executeRawUnsafe(
    `INSERT INTO ${BIZ_USER} (id, username, password_hash, full_name, role, status, school_code, created_at, updated_at)
     VALUES ($1, $1, 'x', 'r2 own row', 'operator', 'active', $2, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    ownUserKey(slot), tenant,
  )
})

/** 只清本套件写入的业务行（id 形如 `r2-<kind>-<slot>-<runId>`；两个学校各清一次）。 */
async function cleanupBusinessRows() {
  const errors = []
  // 顺序：先生成行后引用方（TestRecord.created_by → User(id) 外键），否则删除会被外键拒绝
  const targets = [
    { tenant: TENANTS[0], table: BIZ_RECORD },
    { tenant: TENANTS[1], table: BIZ_RECORD },
    { tenant: TENANTS[0], table: BIZ_USER },
    { tenant: TENANTS[1], table: BIZ_USER },
  ]
  for (const t of targets) {
    try {
      await withVerifiedTenantTx(basePrisma, cfg, t.tenant, async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM ${t.table} WHERE id LIKE $1`, bizLike())
      })
    } catch (e) {
      errors.push({ table: t.table, tenant: t.tenant, code: (e && e.code) || 'UNKNOWN', message: String(e && e.message).slice(0, 120) })
    }
  }
  // 残留自证：清理后本套件前缀行数必须为 0（否则抛错，不静默）
  for (const t of targets) {
    try {
      const rows = await withVerifiedTenantTx(basePrisma, cfg, t.tenant, (tx) =>
        tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${t.table} WHERE id LIKE $1`, bizLike()))
      if (rows[0].n !== 0) errors.push({ table: t.table, tenant: t.tenant, code: 'RESIDUAL_ROWS', message: `remaining=${rows[0].n}` })
    } catch (e) {
      errors.push({ table: t.table, tenant: t.tenant, code: (e && e.code) || 'UNKNOWN', message: `verify:${String(e && e.message).slice(0, 100)}` })
    }
  }
  if (errors.length > 0) {
    const agg = new Error(`[BIZ_CLEANUP_FAILED] ${errors.length} business-row cleanup/verify step(s) failed`)
    agg.code = 'BIZ_CLEANUP_FAILED'
    agg.errors = errors
    throw agg
  }
  return { cleanedTargets: targets.length }
}

/** 未限定/限定名 → 解析到的 schema（列表达式，经 pg_class/pg_namespace；null = 无法解析）。
 *  注意：**不得**用 regclass 文本比较（regclass 输出会因当前 search_path 省略 schema 前缀）。 */
const nsParamExpr = (n) =>
  `(SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass($${n}))::text`
/** pg 受限连接侧：qname → 解析到的 schema。 */
const nsViaClient = async (qname) => (await client.query(`SELECT ${nsParamExpr(1)} AS ns`, [qname])).rows[0].ns

// 读某租户的 messages：核验（同一 tx）→ 业务 SELECT（同一 tx）。
// P3-DB-FIXTURE-R1：合成 messages 已迁出学校 schema（避免 TENANT_EXTRA_OBJECTS），
//   改为 fixture schema 内**每租户 slot 一张表**（物理分离断言不变；identity expectedSchema 仍为学校 schema）。
async function readTenantViaTx(tenant) {
  return withVerifiedTenantTx(basePrisma, cfg, tenant, async (tx) => {
    return tx.$queryRawUnsafe(`SELECT tenant_tag FROM ${gate.quoteQualified(FIXTURE_TABLES[tenant])}`)
  })
}

// 记录实际发生的 SQL 类型（判别性观测：拒绝时必须只有核验 SELECT、业务 SQL=0）
function recordingAdapter(tx, calls) {
  return {
    async query(sql, params = []) {
      const m = /^\s*([a-z]+)/i.exec(sql)
      calls.push((m ? m[1] : '?').toUpperCase())
      const rows = await tx.$queryRawUnsafe(sql, ...(Array.isArray(params) ? params : [params]))
      return { rows: Array.isArray(rows) ? rows : [] }
    },
  }
}

describe('resolveSchemaName —— 统一 school_ 前缀（纯函数，无 DB 访问）', () => {
  test('普通代码加 school_ 前缀', () => {
    expect(resolveSchemaName('tianjiabing')).toBe('school_tianjiabing')
    expect(resolveSchemaName('sysdynit')).toBe('school_sysdynit')
  })

  test('历史 school- 写法归一为 school_（幂等）', () => {
    expect(resolveSchemaName('school-a')).toBe('school_a')
    expect(resolveSchemaName('school-tianjiabing')).toBe('school_tianjiabing')
    expect(resolveSchemaName('school_tianjiabing')).toBe('school_tianjiabing')
  })

  test('含非法字符的代码被整体拒绝，回落默认 schema（REG-1: DS-06）', () => {
    expect(resolveSchemaName('foo a!@#')).toBe('public')
    expect(resolveSchemaName('a.b/c')).toBe('public')
  })

  test('空 / 未定义回落到默认 schema（public）', () => {
    expect(resolveSchemaName('')).toBe('public')
    expect(resolveSchemaName(null)).toBe('public')
    expect(resolveSchemaName(undefined)).toBe('public')
  })
})

describe('createTenantClient —— 按 schema 隔离与缓存', () => {
  test('同一 schema 重复获取返回同一缓存客户端（连接数可控）', () => {
    const a1 = createTenantClient(basePrisma, TENANTS[0])
    const a2 = createTenantClient(basePrisma, TENANTS[0])
    expect(a1).toBe(a2)
    const b1 = createTenantClient(basePrisma, TENANTS[1])
    expect(b1).not.toBe(a1)
  })

  test('public / 空代码复用基础客户端', () => {
    expect(createTenantClient(basePrisma, null)).toBe(basePrisma)
    expect(createTenantClient(basePrisma, '')).toBe(basePrisma)
  })

  test('每个租户客户端只读到本 schema 数据（每次事务内先核验）', async () => {
    for (const t of TENANTS) {
      const rows = await readTenantViaTx(t)
      expect(rows.length).toBe(1)
      expect(rows[0].tenant_tag).toBe(t)
    }
  })
})

describe('A. 拒绝边界（实际消费 helper；前置拒绝 + 调用计数）', () => {
  const spiesOf = () => {
    // counts.callback 由**传入的实际业务回调**递增（不能只计 beforeBusiness hook）
    const counts = { factory: 0, transaction: 0, business: 0, callback: 0 }
    return { counts, hooks: {
      afterFactory: () => { counts.factory += 1 },
      afterTransactionStart: () => { counts.transaction += 1 },
      beforeBusiness: () => { counts.business += 1 },
    } }
  }
  test('正对照：合法调用命中 spies（factory=1、transaction=1、business=1）', async () => {
    const { counts, hooks } = spiesOf()
    const rows = await withVerifiedTenantTx(basePrisma, cfg, TENANTS[0], async (tx) => { counts.callback += 1; return tx.$queryRawUnsafe(`SELECT tenant_tag FROM ${gate.quoteQualified(FIXTURE_TABLES[TENANTS[0]])}`) }, { hooks })
    expect(rows.length).toBe(1)
    expect(counts).toEqual({ factory: 1, transaction: 1, business: 1, callback: 1 })
  })
  test('URL drift：前置拒绝，零 factory/零事务/零业务', async () => {
    const original = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgresql://someone:else@127.0.0.1:5432/other_db'
    const { counts, hooks } = spiesOf()
    let thrown = null
    try { await withVerifiedTenantTx(basePrisma, cfg, TENANTS[0], async () => { counts.callback += 100 }, { hooks }) } catch (e) { thrown = e } finally { process.env.DATABASE_URL = original }
    expect(thrown).not.toBeNull()
    expect(thrown.code).toBe('TARGET_URL_DRIFT')
    expect(counts).toEqual({ factory: 0, transaction: 0, business: 0, callback: 0 })
  })
  test('越界 tenant code（固定业务 code）→ 前置拒绝，零副作用', async () => {
    const { counts, hooks } = spiesOf()
    let thrown = null
    try { await withVerifiedTenantTx(basePrisma, cfg, 'school_tjb', async () => { counts.callback += 100 }, { hooks }) } catch (e) { thrown = e }
    expect(thrown).not.toBeNull()
    expect(thrown.code).toBe('TARGET_CODE_NOT_ALLOWED')
    expect(counts).toEqual({ factory: 0, transaction: 0, business: 0, callback: 0 })
  })
  test('expectedSchema 覆写被拒（不允许改写目标关系）', async () => {
    const { counts, hooks } = spiesOf()
    let thrown = null
    try { await withVerifiedTenantTx(basePrisma, cfg, TENANTS[0], async () => { counts.callback += 100 }, { hooks, expectedSchema: 'school_tjb' }) } catch (e) { thrown = e }
    expect(thrown).not.toBeNull()
    expect(String(thrown.message)).toMatch(/EXPECTED_SCHEMA_OVERRIDE_FORBIDDEN/)
    expect(counts).toEqual({ factory: 0, transaction: 0, business: 0, callback: 0 })
  })
  test('Prisma 事务：运行时 schema 不符（直接调用 createTenantClient + 共享核验；与 helper 证据分工并列，不替代）→ 仅 SELECT、业务 SQL=0', async () => {
    const calls = []
    // 真实生产客户端（TENANTS[1] 的 schema）；期望 SCHEMAS[0] → 共享核验必须拒绝
    const db = createTenantClient(basePrisma, TENANTS[1])
    let thrown = null
    try {
      await db.$transaction(async (tx) => {
        const recordingTx = {
          $queryRawUnsafe: async (sql, ...params) => {
            const m = /^\s*([a-z]+)/i.exec(sql)
            calls.push((m ? m[1] : '?').toUpperCase())
            return tx.$queryRawUnsafe(sql, ...params)
          },
        }
        await verifyRuntimeIdentity(prismaTxAsQueryClient(recordingTx), cfg, { expectedSchema: SCHEMAS[0] })
        // 只有核验通过才会到达这里；若到达说明门禁失效
        await tx.$executeRawUnsafe(`INSERT INTO ${gate.quoteQualified(FIXTURE_TABLES[TENANTS[1]])} (tenant_tag, body) VALUES ($1, $2)`, 'should-not-happen', 'x')
      })
    } catch (e) { thrown = e }
    expect(thrown).not.toBeNull()
    expect(thrown.code).toBe('RUNTIME_IDENTITY_MISMATCH')
    expect(calls.every((c) => c === 'SELECT')).toBe(true)
    expect(calls).not.toContain('INSERT')
  })

  test('真实 helper + 真实事务：hook 在真实 tx 内切换 search_path → 共享核验拒绝（factory/transaction=1、callback=0）', async () => {
    const counts = { factory: 0, transaction: 0, business: 0, callback: 0 }
    let observedSchema = null
    const hooks = {
      afterFactory: () => { counts.factory += 1 },
      afterTransactionStart: async (tx) => {
        counts.transaction += 1
        // 在**真实事务**内改写 search_path（同一 tx；不伪造核验返回、不直接抛错）
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${SCHEMAS[1]}, public`)
        const rows = await tx.$queryRawUnsafe('SELECT current_schema() AS s')
        observedSchema = rows[0].s
      },
      beforeBusiness: () => { counts.business += 1 },
    }
    let thrown = null
    try {
      await withVerifiedTenantTx(basePrisma, cfg, TENANTS[0], async () => { counts.callback += 1 }, { hooks })
    } catch (e) { thrown = e }
    expect(observedSchema).toBe(SCHEMAS[1]) // 记录实际 current_schema
    expect(thrown).not.toBeNull()
    expect(thrown.code).toBe('RUNTIME_IDENTITY_MISMATCH') // 固定错误
    expect(counts).toEqual({ factory: 1, transaction: 1, business: 0, callback: 0 }) // 业务执行器调用=0
  })

  test('hook 中断语义（仅证明 hook 可中断，不作为"核验拒绝"证据）', async () => {
    const { counts, hooks } = spiesOf()
    hooks.beforeBusiness = () => { const e = new Error('stop-before-business'); e.code = 'STOP_BEFORE_BUSINESS'; throw e }
    let thrown = null
    try { await withVerifiedTenantTx(basePrisma, cfg, TENANTS[0], async () => { counts.callback += 100 }, { hooks }) } catch (e) { thrown = e }
    expect(thrown).not.toBeNull()
    expect(thrown.code).toBe('STOP_BEFORE_BUSINESS')
    expect(counts).toEqual({ factory: 1, transaction: 1, business: 0, callback: 0 })
  })

  test('pg 连接链：expectedSchema 不符必须明确拒绝（不允许"无异常也通过"）', async () => {
    await expect(connectAsRestricted(cfg, SCHEMAS[0])).rejects.toMatchObject({
      code: expect.stringMatching(/RUNTIME_IDENTITY_MISMATCH|SCHEMA_NOT_ALLOWED|RUNTIME_(MEMBERSHIP|PRIVILEGE)_REJECTED/),
    })
  })
  test('前置检查三分（assertTargetAllowed）', () => {
    expect(() => gate.assertTargetAllowed(cfg, { tenantCode: TENANTS[0] })).not.toThrow()
    expect(() => gate.assertTargetAllowed(cfg, { tenantCode: 'school_tjb' })).toThrow(/TARGET_CODE_NOT_ALLOWED/)
    expect(() => gate.assertTargetAllowed(cfg, { tenantCode: null, expectedSchema: 'school_tjb' })).toThrow(/SCHEMA_NOT_ALLOWED/)
    expect(() => gate.assertTargetAllowed(cfg, { tenantCode: TENANTS[0], url: 'postgresql://x:y@127.0.0.1:5432/z' })).toThrow(/TARGET_URL_DRIFT/)
  })
})

describe('并发竞态 —— 高并发交错下无跨租户数据泄露', () => {
  test('多租户并发查询各自只返回本租户数据', async () => {
    const CONCURRENCY = 30
    const tasks = []
    for (const tenant of TENANTS) {
      for (let i = 0; i < CONCURRENCY; i++) {
        tasks.push(readTenantViaTx(tenant).then((rows) => ({ tenant, rows })))
      }
    }
    const settled = await Promise.allSettled(tasks)
    const failures = settled.filter((s) => s.status === 'rejected')
    expect(failures.map((f) => String(f.reason && f.reason.message).slice(0, 120))).toEqual([])
    const results = settled.map((s) => s.value)
    expect(results.length).toBe(TENANTS.length * CONCURRENCY)
    for (const { tenant, rows } of results) {
      expect(rows.length).toBe(1)
      expect(rows[0].tenant_tag).toBe(tenant)
    }
  })

  test('并发写入不串租户：每租户写入只落在本 schema；提交后立即登记行键', async () => {
    const INSERTS = 10
    const jobs = []
    for (const tenant of TENANTS) {
      for (let i = 0; i < INSERTS; i++) {
        const keyValue = `ins-${tenant}-${i}`
        jobs.push(
          withVerifiedTenantTx(basePrisma, cfg, tenant, async (tx) => {
            await tx.$executeRawUnsafe(`INSERT INTO ${gate.quoteQualified(FIXTURE_TABLES[tenant])} (tenant_tag, body) VALUES ($1, $2)`, keyValue, `insert-${tenant}`)
          }).then(() => {
            // 提交成功后**立即**登记（不等断言、不等其它任务）
            registry.addTaskRow({ qname: FIXTURE_TABLES[tenant], keyColumn: 'tenant_tag', keyValue })
          })
        )
      }
    }
    const settled = await Promise.allSettled(jobs)
    const failures = settled.filter((s) => s.status === 'rejected')
    expect(failures.map((f) => String(f.reason && f.reason.message).slice(0, 120))).toEqual([])

    for (const tenant of TENANTS) {
      const rows = await readTenantViaTx(tenant)
      expect(rows.length).toBe(1 + INSERTS)
      for (const r of rows) {
        expect(r.tenant_tag === tenant || r.tenant_tag.startsWith(`ins-${tenant}`)).toBe(true)
      }
    }
  })

  test('并发部分提交后失败：已提交任务行全部登记、allSettled 后清理归零、原失败保留', async () => {
    const tenant = TENANTS[1]
    const N = 6
    const prefix = `part-${tenant}-`
    const successKeys = []
    const jobs = []
    for (let i = 0; i < N; i += 1) {
      const key = `${prefix}${i}`
      const shouldFail = i === N - 1 // 最后一项在业务回调失败（已提交的成功项必须已登记）
      jobs.push(
        withVerifiedTenantTx(basePrisma, cfg, tenant, async (tx) => {
          if (shouldFail) throw Object.assign(new Error('injected business failure after partial commits'), { code: 'INJECTED_PARTIAL' })
          await tx.$executeRawUnsafe(`INSERT INTO ${gate.quoteQualified(FIXTURE_TABLES[tenant])} (tenant_tag, body) VALUES ($1, $2)`, key, 'partial')
        }).then(() => {
          successKeys.push(key)
          registry.addTaskRow({ qname: FIXTURE_TABLES[tenant], keyColumn: 'tenant_tag', keyValue: key })
        })
      )
    }
    const settled = await Promise.allSettled(jobs)
    const rejected = settled.filter((x) => x.status === 'rejected')
    const fulfilled = settled.filter((x) => x.status === 'fulfilled')
    expect(rejected.length).toBe(1)
    expect(String(rejected[0].reason.code)).toBe('INJECTED_PARTIAL') // 原始失败保留
    expect(fulfilled.length).toBe(N - 1)
    expect(successKeys.length).toBe(N - 1)
    expect(registry.list().filter((e) => e.keyValue.startsWith(prefix)).length).toBe(N - 1)

    // allSettled 之后（无在途任务）执行**本套件实际** cleanup helper → 已提交行最终 0
    const beforeIdle = await readTenantViaTx(tenant)
    expect(beforeIdle.filter((r) => r.tenant_tag.startsWith(prefix)).length).toBe(N - 1)
    await cleanupRegistered(client, registry)
    const afterCleanup = await readTenantViaTx(tenant)
    expect(afterCleanup.filter((r) => r.tenant_tag.startsWith(prefix)).length).toBe(0)
  })
})

describe('无跨 schema 回落 —— 租户查询绝不命中 public', () => {
  test('public 独有的行不会出现在任何租户查询结果中', async () => {
    for (const t of TENANTS) {
      const rows = await readTenantViaTx(t)
      expect(rows.some((r) => r.tenant_tag === 'public')).toBe(false)
    }
  })
})

// ── P3-DB-FIXTURE-R1（R7 CLOSE-B B1 取 O1）：fixture 对象迁址的定点判别证据 ──
describe('P3-DB-FIXTURE-R1 —— fixture 对象迁出 public / 学校 schema', () => {
  test('public 与学校 schema 不再有合成 fixture 对象；fixture schema 是唯一位置', async () => {
    const reg = async (qname) => (await client.query('SELECT to_regclass($1)::text AS t', [qname])).rows[0].t
    expect(await reg('public.messages')).toBe(null)
    expect(await reg('public.t02a_instance_marker')).toBe(null)
    for (const s of SCHEMAS) expect(await reg(`${s}.messages`)).toBe(null)
    expect(await reg(cfg.markerTable)).not.toBe(null)
    for (const t of TENANTS) expect(await reg(FIXTURE_TABLES[t])).not.toBe(null)
  })
  test('租户 tx 内 unqualified `messages` 不再解析到任何表（无 search_path 回落）；显式 fixture 表可读', async () => {
    const rows = await withVerifiedTenantTx(basePrisma, cfg, TENANTS[0], async (tx) => {
      return tx.$queryRawUnsafe("SELECT to_regclass('messages')::text AS resolved")
    })
    expect(rows[0].resolved).toBe(null)
    const fixtureRows = await readTenantViaTx(TENANTS[0])
    expect(fixtureRows.length).toBe(1)
  })
})

// ── P3-DB-FIXTURE-R2（R8 §其它交叉点）：**真实已迁移 A/B 学校业务表**的正向隔离 ──
//   R8：fixture 表（schema-qualified）只证明物理分离，其查询不依赖租户业务 search_path；
//   本组改用**未限定表名的业务查询**（`"User"`/`"TestRecord"`），证明：
//     ① 每校独有行（跨校不可见）；② tenant tx 的业务查询命中当前学校；
//     ③ 同键跨校不串行（并以"同校同键仍串行"作负对照证明判别力）；④ 不得回退 public。
//   前置（包内 `w2t02r2-fixture.mjs`，见 COMMANDS）：public `migrate deploy` → A/B 逐租户回放
//   → `db:sync` + `--check` rc=0 → 受限角色对**回放后**的业务表补授 USAGE+DML（provision 的
//   `ALL TABLES` 授权在空 schema 上无对象可覆盖；未改 provision/gate）。
describe('P3-DB-FIXTURE-R2 —— 已迁移 A/B 学校业务表正向隔离（未限定业务查询）', () => {
  test('前置合同：A/B 由迁移链落出真实业务表与逐租户台账；public 同名表与 public 专属关系存在', async () => {
    for (const [slot, schema] of [['a', SCHEMAS[0]], ['b', SCHEMAS[1]]]) {
      expect(await nsViaClient(`${schema}."User"`)).toBe(schema) // via nsParamExpr（不经 regclass 文本）
      expect(await nsViaClient(`${schema}."TestRecord"`)).toBe(schema)
      expect(await nsViaClient(`${schema}._tenant_migrations`)).toBe(schema) // 逐租户版本事实源（回放产物）
    }
    // 对照（非空判据）：同一未限定名在 public 上下文（受限角色 search_path=public）命中 public，
    // 而在租户 tx 内必须命中本校 —— 解析确实依赖 search_path，而非固定返回。
    expect(await nsViaClient('"User"')).toBe('public')
    expect(await nsViaClient('public."User"')).toBe('public') // 同名表两侧并存（隔离判别的前提）
    expect(await nsViaClient('public._prisma_migrations')).toBe('public') // public 专属关系（无回退判据的非空前提）
  })

  test('每校独有行：未限定表名下 A/B 各写各读，跨校行不可见（record 业务合同表）', async () => {
    const recA = bizKey('rec', 'a')
    const recB = bizKey('rec', 'b')
    // TestRecord.created_by 有到本校 "User"(id) 的外键 → 先 ensure 本校 User 行（幂等；与解析用例共用）
    await ensureOwnUser('a', TENANTS[0])
    await ensureOwnUser('b', TENANTS[1])
    const insert = (slot, tenant, recId) => withVerifiedTenantTx(basePrisma, cfg, tenant, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO ${BIZ_RECORD} (id, record_code, test_type, test_name, sample_info, result_data, created_by, updated_at)
         VALUES ($1, $1, 'r2-isolation', $2, '{}', '{}', $3, now())`,
        recId, `r2 record ${recId}`, ownUserKey(slot),
      )
    })
    await insert('a', TENANTS[0], recA)
    await insert('b', TENANTS[1], recB)
    const seen = {}
    for (const [slot, tenant] of [['a', TENANTS[0]], ['b', TENANTS[1]]]) {
      const rows = await withVerifiedTenantTx(basePrisma, cfg, tenant, (tx) =>
        tx.$queryRawUnsafe(`SELECT id, created_by FROM ${BIZ_RECORD} WHERE id LIKE $1`, bizLike()))
      seen[slot] = rows.map((r) => r.id)
      expect(rows.every((r) => r.created_by === ownUserKey(slot))).toBe(true) // 外键指向本校 User
    }
    expect(seen.a).toEqual([recA]) // 本校独有行（若串校会看到 recB）
    expect(seen.b).toEqual([recB])
    const cross = await withVerifiedTenantTx(basePrisma, cfg, TENANTS[0], (tx) =>
      tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${BIZ_RECORD} WHERE id = $1`, recB))
    expect(cross[0].n).toBe(0) // 另一校的行在本校不可见
  })

  test('tenant tx 内未限定业务查询命中当前学校（search_path 解析 + current_schema + 行级命中）', async () => {
    const keys = { a: ownUserKey('a'), b: ownUserKey('b') }
    await ensureOwnUser('a', TENANTS[0]) // 幂等（上面 record 用例已建）
    await ensureOwnUser('b', TENANTS[1])
    for (const [slot, tenant, schema] of [['a', TENANTS[0], SCHEMAS[0]], ['b', TENANTS[1], SCHEMAS[1]]]) {
      const other = slot === 'a' ? 'b' : 'a'
      const obs = await withVerifiedTenantTx(basePrisma, cfg, tenant, async (tx) => {
        const res = await tx.$queryRawUnsafe(`SELECT current_schema()::text AS cs, ${nsParamExpr(1)} AS ns`, '"User"')
        const own = await tx.$queryRawUnsafe(`SELECT username, school_code FROM ${BIZ_USER} WHERE username = $1`, keys[slot])
        const otherN = await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${BIZ_USER} WHERE username = $1`, keys[other])
        return { cs: res[0].cs, ns: res[0].ns, own, otherN: otherN[0].n }
      })
      expect(obs.cs).toBe(schema) // 业务 search_path 首项 = 本校
      expect(obs.ns).toBe(schema) // 未限定 "User" 解析到**本校**（不是 public、不是另一校）
      expect(obs.own.length).toBe(1)
      expect(obs.own[0].school_code).toBe(tenant)
      expect(obs.otherN).toBe(0) // 另一校同名键行不可见
    }
  })

  test('不得回退 public：public 专属关系/行在租户 tx 中均不可见（非空判据）', async () => {
    // 非空前提：public 侧确实存在该专属关系（否则 null 断言是空转）
    expect(await nsViaClient('public._prisma_migrations')).toBe('public')
    const pubOnly = `r2-public-only-${cfg.runId}` // 由包内 fixture 以管理身份写入 public."User"（affected 记录在 fixture 证据）
    for (const [tenant, schema] of [[TENANTS[0], SCHEMAS[0]], [TENANTS[1], SCHEMAS[1]]]) {
      const obs = await withVerifiedTenantTx(basePrisma, cfg, tenant, async (tx) => {
        const res = await tx.$queryRawUnsafe(
          `SELECT ${nsParamExpr(1)} AS pub_only_ns, ${nsParamExpr(2)} AS user_ns`,
          '_prisma_migrations', '"User"',
        )
        const pubN = await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${BIZ_USER} WHERE username = $1`, pubOnly)
        return { pubOnlyNs: res[0].pub_only_ns, userNs: res[0].user_ns, pubN: pubN[0].n }
      })
      expect(obs.pubOnlyNs).toBe(null) // public 专属关系未进入业务 search_path（无 public 回退）
      expect(obs.userNs).toBe(schema) // 同名业务表解析到本校
      expect(obs.pubN).toBe(0) // public 专属行读不到
    }
  })

  test('同键跨校不串行：A/B 同名唯一键各自加锁互不阻塞；同校同键仍串行（负对照）', async () => {
    const sameKey = bizKey('same', 'a') // 同一键值在 A/B 各一行（唯一约束仅限本校表内）
    for (const tenant of [TENANTS[0], TENANTS[1]]) {
      await withVerifiedTenantTx(basePrisma, cfg, tenant, async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO ${BIZ_USER} (id, username, password_hash, full_name, role, status, school_code, created_at, updated_at)
           VALUES ($1, $2, 'x', 'r2 same key', 'operator', 'active', $3, now(), now())`,
          sameKey, sameKey, tenant,
        )
      })
    }
    // A 持锁（同名键行）直到显式释放；防呆定时器保证任何失败下都不悬挂
    let releaseA = () => {}
    const holdGate = new Promise((r) => { releaseA = r })
    let signalLocked = () => {}
    const locked = new Promise((r) => { signalLocked = r })
    const safety = setTimeout(() => releaseA(), 15000)
    const lockA = withVerifiedTenantTx(basePrisma, cfg, TENANTS[0], async (tx) => {
      const rows = await tx.$queryRawUnsafe(`SELECT id FROM ${BIZ_USER} WHERE username = $1 FOR UPDATE`, sameKey)
      signalLocked(rows.length)
      await holdGate
      return rows.length
    })
    expect(await locked).toBe(1)

    // ① 跨校同名键：B 不必等 A → 不串行（同一 SQL、同一键值，仅学校不同）
    const cross = await withVerifiedTenantTx(basePrisma, cfg, TENANTS[1], async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '750ms'")
      const rows = await tx.$queryRawUnsafe(`SELECT id FROM ${BIZ_USER} WHERE username = $1 FOR UPDATE`, sameKey)
      return rows.length
    })
    expect(cross).toBe(1)

    // ② 负对照（同校同键）：必须被 A 的行锁串行化 → lock_timeout 触发（证明①的判别力）
    let same = null
    try {
      await withVerifiedTenantTx(basePrisma, cfg, TENANTS[0], async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '500ms'")
        await tx.$queryRawUnsafe(`SELECT id FROM ${BIZ_USER} WHERE username = $1 FOR UPDATE`, sameKey)
      })
      same = { blocked: false }
    } catch (e) {
      same = { blocked: true, code: (e.meta && e.meta.code) || e.code || 'UNKNOWN', message: String(e.message).slice(0, 160) }
    }
    expect(same.blocked).toBe(true)
    expect(`${same.code} ${same.message}`).toMatch(/55P03|lock timeout|canceling statement due to lock timeout/i)

    // ③ 释放 A → 同校同键恢复可加锁（证明②的阻塞来自 A 的行锁，而非环境异常）
    releaseA()
    expect(await lockA).toBe(1)
    clearTimeout(safety)
    const after = await withVerifiedTenantTx(basePrisma, cfg, TENANTS[0], async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '750ms'")
      const rows = await tx.$queryRawUnsafe(`SELECT id FROM ${BIZ_USER} WHERE username = $1 FOR UPDATE`, sameKey)
      return rows.length
    })
    expect(after).toBe(1)
  })
})
