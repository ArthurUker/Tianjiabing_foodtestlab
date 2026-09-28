'use strict'
/**
 * P3-W0-T02A-R1 — 共享门禁纯单元/受控替身回归（不连接数据库）。
 * 覆盖复审 R2 的 namespace/身份/权限收紧与 R4 的判别性观测。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const gate = require('../helpers/db-isolation.cjs')
const { CODES } = gate

const RUN_ID = 't02arun1234'
const CANARY = `canary-${crypto.randomBytes(6).toString('hex')}`
const tmpDirs = []
const derived = gate.derivedNamespace(RUN_ID)

function makeContext(override = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't02ar1-ctx-'))
  tmpDirs.push(dir)
  const base = {
    task: 'P3-W0-T02A',
    runId: RUN_ID,
    instance: { host: '127.0.0.1', port: 55513, database: derived.database, role: derived.role, instanceTag: derived.instanceTag, markerTable: derived.markerTable },
    allowedSchemas: derived.allowedSchemas.slice(),
    allowedFixtureObjects: derived.fixtureObjects.slice(),
    tenants: { ...derived.tenants },
    roleAudit: { ...derived.roleAudit },
    sentinel: { schema: derived.sentinelSchema, owner: derived.sentinelOwner, table: `${derived.sentinelSchema}.sentinel_rows` },
  }
  const ctx = { ...base, ...override }
  if (override.instance) ctx.instance = { ...base.instance, ...override.instance }
  if (override.roleAudit) ctx.roleAudit = { ...base.roleAudit, ...override.roleAudit }
  const file = path.join(dir, 'context.json')
  fs.writeFileSync(file, override.__raw !== undefined ? override.__raw : JSON.stringify(ctx, null, 2))
  return { file, ctx }
}
const goodUrl = (ctx, q = '') => `postgresql://${ctx.instance.role}:${CANARY}@${ctx.instance.host}:${ctx.instance.port}/${ctx.instance.database}${q}`
const env = (file, url) => ({ TEST_DB_CONTEXT_FILE: file, ...(url !== undefined ? { TEST_DATABASE_URL: url } : {}) })

afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

describe('B. 契约精确绑定（连接前拒绝）', () => {
  test('合法上下文通过（正对照）', () => {
    const { file, ctx } = makeContext()
    const r = gate.checkIsolationConfig(env(file, goodUrl(ctx)))
    expect(r.ok).toBe(true)
    expect(r.cfg.tenants.a).toBe(derived.tenants.a)
    expect(r.cfg.roleAudit.schema).toBe(derived.schemas.ra)
  })

  test('allowedSchemas 混入固定业务 schema（school_tjb）→ CONTRACT_MISMATCH', () => {
    const { file, ctx } = makeContext({ allowedSchemas: [...derived.allowedSchemas, 'school_tjb'] })
    expect(gate.checkIsolationConfig(env(file, goodUrl(ctx))).code).toBe(CODES.CONTRACT_MISMATCH)
  })

  test('allowedSchemas 缺一项 / 换为 school_a → CONTRACT_MISMATCH', () => {
    const a = makeContext({ allowedSchemas: derived.allowedSchemas.slice(1) })
    expect(gate.checkIsolationConfig(env(a.file, goodUrl(a.ctx))).code).toBe(CODES.CONTRACT_MISMATCH)
    const b = makeContext({ allowedSchemas: derived.allowedSchemas.map((s) => (s === derived.schemas.a ? 'school_a' : s)) })
    expect(gate.checkIsolationConfig(env(b.file, goodUrl(b.ctx))).code).toBe(CODES.CONTRACT_MISMATCH)
  })

  test('跨 run 的 schema / tenant / 库 / 角色 / marker / fixture 越界 → CONTRACT_MISMATCH', () => {
    const cases = [
      () => makeContext({ allowedSchemas: derived.allowedSchemas.map((s) => (s === derived.schemas.a ? 'school_t02aotherrun_a' : s)) }),
      () => makeContext({ tenants: { ...derived.tenants, a: 't02a-otherrun-a' } }),
      () => makeContext({ instance: { ...derived, database: 't02a_iso_otherrun1' } }),
      () => makeContext({ instance: { database: derived.database, role: 't02a_role_otherrun1', instanceTag: derived.instanceTag, markerTable: derived.markerTable, host: '127.0.0.1', port: 55513 } }),
      () => makeContext({ instance: { database: derived.database, role: derived.role, instanceTag: derived.instanceTag, markerTable: `${derived.fixtureSchema}.marker_v2`, host: '127.0.0.1', port: 55513 } }),
      // P3-DB-FIXTURE-R1：旧位置的 public.messages 已不在契约；fixture 集合必须与 runId 派生集合精确相等
      () => makeContext({ allowedFixtureObjects: [...derived.fixtureObjects.slice(0, -1), 'public.some_other_table'] }),
      () => makeContext({ allowedFixtureObjects: [...derived.fixtureObjects.slice(0, -1), 'public.messages'] }),
      () => makeContext({ fixture: { schema: `t02a_fx_otherrun1` } }),
      () => makeContext({ roleAudit: { ...derived.roleAudit, schema: 'school_tjb' } }),
      () => makeContext({ roleAudit: { ...derived.roleAudit, userId: 'school_tjb_admin' } }),
      () => makeContext({ sentinel: { schema: 'public', owner: derived.sentinelOwner, table: 'public.sentinel_rows' } }),
    ]
    for (const build of cases) {
      const m = build()
      const r = gate.checkIsolationConfig(env(m.file, goodUrl(m.ctx)))
      expect(r.ok).toBe(false)
      expect([CODES.CONTRACT_MISMATCH, CODES.URL_MISMATCH]).toContain(r.code)
    }
  })

  test('默认端口（context 5432 或 URL 5432）→ DEFAULT_PORT_REJECTED', () => {
    const a = makeContext({ instance: { port: 5432 } })
    expect(gate.checkIsolationConfig(env(a.file, `postgresql://${a.ctx.instance.role}:${CANARY}@127.0.0.1:5432/${a.ctx.instance.database}`)).code).toBe(CODES.DEFAULT_PORT_REJECTED)
  })

  test('URL 重复参数 / 覆写参数 / decode 异常 → 固定安全错误（不回显输入）', () => {
    const { file, ctx } = makeContext()
    expect(gate.checkIsolationConfig(env(file, `${goodUrl(ctx)}?schema=public&schema=${derived.schemas.a}`)).code).toBe(CODES.URL_PARAM_DUPLICATE)
    expect(gate.checkIsolationConfig(env(file, `${goodUrl(ctx)}?host=evil`)).code).toBe(CODES.URL_PARAM_FORBIDDEN)
    const bad = gate.checkIsolationConfig(env(file, goodUrl(ctx).replace('t02arun1234', 't02arun1234%ZZ')))
    expect([CODES.URL_INVALID, CODES.URL_MISMATCH]).toContain(bad.code)
    expect(JSON.stringify(bad)).not.toContain('%ZZ')
  })
})

describe('A/B. 运行时核验（替身；判别性观测）', () => {
  function fakeClient({ identity, roleRows, memberCount = 0, nsRows, markerRows, onQuery }) {
    const calls = []
    return {
      calls,
      async query(sql, params = []) {
        calls.push({ sql: sql.replace(/\s+/g, ' ').slice(0, 60), params })
        if (onQuery) onQuery(sql, calls)
        if (/current_database\(\)/.test(sql)) return { rows: [identity] }
        // 顺序：成员查询含 "FROM pg_roles WHERE rolname = current_user" 子查询，必须先判 pg_auth_members
        if (/FROM pg_auth_members/.test(sql)) return { rows: [{ n: memberCount }] }
        if (/FROM pg_roles WHERE rolname = current_user/.test(sql)) return { rows: roleRows }
        if (/FROM pg_namespace/.test(sql)) return { rows: nsRows }
        if (/has_table_privilege/.test(sql)) return { rows: markerRows }
        if (/t02a_instance_marker/.test(sql)) return { rows: [{ value: derived.instanceTag }] }
        return { rows: [] }
      },
    }
  }
  const goodIdentity = { db: derived.database, cu: derived.role, su: derived.role, addr: '127.0.0.1/32', port: 55513, schema: 'public' }
  const goodRole = [{ rolname: derived.role, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]
  const goodNs = [{ schema: 'public', owner: derived.adminRole }]
  const goodMarker = [{ owner: derived.adminRole, schema_owner: derived.adminRole, can_insert: false, can_update: false, can_delete: false, can_truncate: false }]
  const cfg = () => gate.checkIsolationConfig(env(makeContext().file, goodUrl(makeContext().ctx))).cfg

  test('正对照：完全匹配 → 通过（证明替身命中同一核验路径）', async () => {
    const c = cfg()
    const r = await gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, nsRows: goodNs, markerRows: goodMarker }), c, { expectedSchema: 'public' })
    expect(r.ok).toBe(true)
    expect(r.identity.schema).toBe('public')
  })

  test('expectedSchema 越界 → 拒绝且零查询（连接前语义）', async () => {
    const c = cfg()
    const client = fakeClient({ identity: goodIdentity, roleRows: goodRole, nsRows: goodNs, markerRows: goodMarker })
    await expect(gate.verifyRuntimeIdentity(client, c, { expectedSchema: 'school_tjb' })).rejects.toMatchObject({ code: CODES.SCHEMA_NOT_ALLOWED })
    expect(client.calls.length).toBe(0)
  })

  test('角色缺记录 / 属性非布尔 → RUNTIME_PRIVILEGE_REJECTED', async () => {
    const c = cfg()
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: [], nsRows: goodNs, markerRows: goodMarker }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.RUNTIME_PRIVILEGE_REJECTED })
    const partial = [{ rolname: derived.role, rolsuper: null, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: partial, nsRows: goodNs, markerRows: goodMarker }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.RUNTIME_PRIVILEGE_REJECTED })
    const nonSuperHigh = [{ rolname: derived.role, rolsuper: false, rolcreatedb: true, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: nonSuperHigh, nsRows: goodNs, markerRows: goodMarker }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.RUNTIME_PRIVILEGE_REJECTED })
  })

  test('任意成员关系（含两跳链）→ RUNTIME_MEMBERSHIP_REJECTED', async () => {
    const c = cfg()
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, memberCount: 1, nsRows: goodNs, markerRows: goodMarker }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.RUNTIME_MEMBERSHIP_REJECTED })
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, memberCount: 2, nsRows: goodNs, markerRows: goodMarker }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.RUNTIME_MEMBERSHIP_REJECTED })
  })

  test('null 地址 / schema 不符 → RUNTIME_IDENTITY_MISMATCH', async () => {
    const c = cfg()
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: { ...goodIdentity, addr: null }, roleRows: goodRole, nsRows: goodNs, markerRows: goodMarker }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.RUNTIME_IDENTITY_MISMATCH })
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: { ...goodIdentity, schema: derived.schemas.a }, roleRows: goodRole, nsRows: goodNs, markerRows: goodMarker }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.RUNTIME_IDENTITY_MISMATCH })
  })

  test('namespace owner 非任务管理角色 / marker 可写或缺失 → 拒绝', async () => {
    const c = cfg()
    const mk = (over = {}) => ({ owner: derived.adminRole, schema_owner: derived.adminRole, can_insert: false, can_update: false, can_delete: false, can_truncate: false, ...over })
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, nsRows: [{ schema: 'public', owner: 'postgres' }], markerRows: goodMarker }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.SCHEMA_NOT_ALLOWED })
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, nsRows: goodNs, markerRows: [mk({ can_insert: true })] }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.MARKER_MISMATCH })
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, nsRows: goodNs, markerRows: [] }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.MARKER_MISMATCH })
    // R2：仅 UPDATE 被授予（INSERT=false）也必须拒绝 —— 写权限集合适配
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, nsRows: goodNs, markerRows: [mk({ can_update: true })] }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.MARKER_MISMATCH })
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, nsRows: goodNs, markerRows: [mk({ can_truncate: true })] }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.MARKER_MISMATCH })
    // P3-DB-FIXTURE-R1：marker 的**表 owner** 或 **所在 schema owner** 任一非任务管理角色 → 拒绝
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, nsRows: goodNs, markerRows: [mk({ owner: 'postgres' })] }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.MARKER_MISMATCH })
    await expect(gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, nsRows: goodNs, markerRows: [mk({ schema_owner: 'postgres' })] }), c, { expectedSchema: 'public' })).rejects.toMatchObject({ code: CODES.MARKER_MISMATCH })
    // 正对照：四项全 false 时通过，且返回体含写权限明细
    const okRes = await gate.verifyRuntimeIdentity(fakeClient({ identity: goodIdentity, roleRows: goodRole, nsRows: goodNs, markerRows: goodMarker }), c, { expectedSchema: 'public' })
    expect(okRes.ok).toBe(true)
    expect(okRes.marker).toMatchObject({ canInsert: false, canUpdate: false, canDelete: false, canTruncate: false })
  })
})

describe('C. 结构化登记（越界拒绝）', () => {
  const cfg = () => gate.checkIsolationConfig(env(makeContext().file, goodUrl(makeContext().ctx))).cfg
  test('越界 qname / 未知列 / 外部行键 / 空键 → REGISTRY_REJECTED', () => {
    const registry = gate.createRegistry(cfg())
    const fxTable = derived.fixtureMessages.a
    expect(() => registry.addTaskRow({ qname: 'public.revoked_tokens', keyColumn: 'jti', keyValue: `x-${RUN_ID}` })).toThrow(/REGISTRY_REJECTED/)
    // P3-DB-FIXTURE-R1：旧位置（public / 学校 schema 的 messages）必须被拒；只有 fixture 表可登记
    expect(() => registry.addTaskRow({ qname: 'public.messages', keyColumn: 'tenant_tag', keyValue: `x-${RUN_ID}` })).toThrow(/REGISTRY_REJECTED/)
    expect(() => registry.addTaskRow({ qname: `${derived.schemas.a}.messages`, keyColumn: 'tenant_tag', keyValue: `x-${RUN_ID}` })).toThrow(/REGISTRY_REJECTED/)
    expect(() => registry.addTaskRow({ qname: fxTable, keyColumn: 'body', keyValue: `x-${RUN_ID}` })).toThrow(/REGISTRY_REJECTED/)
    expect(() => registry.addTaskRow({ qname: fxTable, keyColumn: 'tenant_tag', keyValue: 'no-runId-here' })).toThrow(/REGISTRY_REJECTED/)
    expect(() => registry.addTaskRow({ qname: fxTable, keyColumn: 'tenant_tag', keyValue: '' })).toThrow(/REGISTRY_REJECTED/)
    expect(() => registry.addTaskRow({ qname: `${fxTable}; DROP TABLE x`, keyColumn: 'tenant_tag', keyValue: `x-${RUN_ID}` })).toThrow()
    // 正对照：fixture 表 + 允许列 + 含 runId 的键值 → 接受
    expect(registry.addTaskRow({ qname: fxTable, keyColumn: 'tenant_tag', keyValue: `x-${RUN_ID}` })).toBe(1)
    expect(registry.size()).toBe(1)
  })
  test('settleAll：分别尝试全部动作并聚合（不因第一个失败跳过）', async () => {
    const order = []
    const r = await gate.settleAll([
      { name: 'a', fn: async () => { order.push('a'); throw new Error('boom-a') } },
      { name: 'b', fn: async () => { order.push('b') } },
      { name: 'c', fn: async () => { order.push('c'); throw Object.assign(new Error('boom-c'), { code: 'X' }) } },
    ])
    expect(order).toEqual(['a', 'b', 'c'])
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.name)).toEqual(['a', 'c'])
  })
})


// ── P3-W0-T02A-R3：三态解析 / 深冻结 / 失败释放 ──
const provision = require('./provision.cjs')
afterEach(() => { provision.__setRunForTests(null) })

describe('R3-L1. 三态解析（合成注入；含平台 no-match 契约）', () => {
  test('probePid：rc=1+stderr / rc=0 空 / 畸形行 / 另一 PID / signal → unknown；absent 与 present 正对照', () => {
    provision.__setRunForTests((cmd, args) => {
      if (cmd !== 'ps') return { code: 0, stdout: '', stderr: '' }
      const pid = Number(args[args.length - 1])
      if (pid === 111) return { code: 1, stdout: '', stderr: 'ps: illegal option' }
      if (pid === 222) return { code: 0, stdout: '', stderr: '' }
      if (pid === 333) return { code: 0, stdout: '333 postgres\n444 extra\n', stderr: '' }
      if (pid === 444) return { code: 0, stdout: '999 other-process\n', stderr: '' }
      if (pid === 555) return { code: null, signal: 'SIGKILL', stdout: '', stderr: '' }
      if (pid === 666) return { code: 1, stdout: '', stderr: '' } // 平台 no-match 契约 → absent
      if (pid === 777) return { code: 0, stdout: '777 postgres -D /tmp/x\n', stderr: '' } // present
      return { code: 2, stdout: '', stderr: 'unexpected' }
    })
    expect(provision.probePid(111)).toMatchObject({ state: 'unknown', reason: 'command_error' })
    expect(provision.probePid(222)).toMatchObject({ state: 'unknown', reason: 'empty_output_rc0' })
    expect(provision.probePid(333)).toMatchObject({ state: 'unknown', reason: 'line_count' })
    expect(provision.probePid(444)).toMatchObject({ state: 'unknown', reason: 'pid_mismatch' })
    expect(provision.probePid(555)).toMatchObject({ state: 'unknown', reason: 'signal' })
    expect(provision.probePid(666)).toMatchObject({ state: 'absent' })
    expect(provision.probePid(777)).toMatchObject({ state: 'present', pid: 777 })
  })

  test('probePort：rc=0 garbage / rc=1+stderr / 混合坏行 → unknown；released 与 listening 正对照（含多 PID）', () => {
    provision.__setRunForTests((cmd, args) => {
      if (cmd !== 'lsof') return { code: 1, stdout: '', stderr: '' }
      const target = String(args[1])
      if (target.includes('60001')) return { code: 0, stdout: 'garbage', stderr: '' }
      if (target.includes('60002')) return { code: 1, stdout: '', stderr: 'lsof: error' }
      if (target.includes('60003')) return { code: 0, stdout: '123\nbad\n', stderr: '' }
      if (target.includes('60004')) return { code: 0, stdout: '123\n456\n', stderr: '' }
      if (target.includes('60005')) return { code: 1, stdout: '', stderr: '' } // no-match 契约 → released
      return { code: 3, stdout: '', stderr: 'unexpected' }
    })
    expect(provision.probePort(60001)).toMatchObject({ state: 'unknown', reason: 'malformed_pid_line' })
    expect(provision.probePort(60002)).toMatchObject({ state: 'unknown', reason: 'command_error' })
    expect(provision.probePort(60003)).toMatchObject({ state: 'unknown', reason: 'malformed_pid_line' })
    expect(provision.probePort(60004)).toMatchObject({ state: 'listening', pids: [123, 456] })
    expect(provision.probePort(60005)).toMatchObject({ state: 'released' })
  })

  test('up 端口预检 unknown → 拒绝创建/启动（零 initdb/start 调用）', async () => {
    const runId = `t02a${crypto.randomBytes(4).toString('hex')}`
    const calls = []
    provision.__setRunForTests((cmd, args) => {
      calls.push(cmd)
      if (cmd === 'lsof') return { code: 0, stdout: '', stderr: '' } // rc=0 空 → unknown
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(provision.up({ runId, port: 55524 })).rejects.toMatchObject({ code: 'E_PROBE_UNKNOWN' })
    expect(calls.filter((c) => c === 'initdb' || c === 'pg_ctl')).toEqual([])
    expect(fs.existsSync(provision.taskRoot(runId))).toBe(false)
  })

  test('hasDatadirArg：精确匹配 -D；前缀碰撞与空参数不放行', () => {
    expect(provision.hasDatadirArg('/usr/bin/postgres -D /tmp/a/data -p 55518', '/tmp/a/data')).toBe(true)
    expect(provision.hasDatadirArg('/usr/bin/postgres -D /tmp/a/data-extra -p 55518', '/tmp/a/data')).toBe(false)
    expect(provision.hasDatadirArg('/usr/bin/postgres -D  -p 55518', '/tmp/a/data')).toBe(false)
    expect(provision.hasDatadirArg('/usr/bin/postgres -p 55518', '/tmp/a/data')).toBe(false)
  })
})

describe('R3-H1. cfg 深冻结（篡改不能改变允许范围）', () => {
  test('顶层与嵌套集合/对象均冻结；篡改尝试全部无效', () => {
    const { file, ctx } = makeContext()
    const r = gate.checkIsolationConfig(env(file, goodUrl(ctx)))
    expect(r.ok).toBe(true)
    const cfg = r.cfg
    const snapshot = JSON.stringify({ url: cfg.url, runId: cfg.runId, schemas: cfg.schemas, allowedSchemas: cfg.allowedSchemas, tenants: cfg.tenants, fixtures: cfg.allowedFixtureObjects, roleAudit: cfg.roleAudit })
    for (const [label, mutate] of [
      ['url', () => { cfg.url = 'postgresql://evil:1@127.0.0.1:1/x' }],
      ['runId', () => { cfg.runId = 'hackedrun12345' }],
      ['schemas', () => { cfg.schemas.a = 'school_tjb' }],
      ['allowedSchemas.push', () => cfg.allowedSchemas.push('school_tjb')],
      ['tenants', () => { cfg.tenants.a = 'school_tjb' }],
      ['allowedFixtureObjects.push', () => cfg.allowedFixtureObjects.push('public.evil')],
      ['roleAudit', () => { cfg.roleAudit.schema = 'school_tjb' }],
      ['derived', () => { cfg.derived.schemas.a = 'school_tjb' }],
    ]) {
      let threw = false
      try { mutate() } catch { threw = true }
      expect([true, false]).toContain(threw) // 静默失败或抛错都可接受
    }
    const after = JSON.stringify({ url: cfg.url, runId: cfg.runId, schemas: cfg.schemas, allowedSchemas: cfg.allowedSchemas, tenants: cfg.tenants, fixtures: cfg.allowedFixtureObjects, roleAudit: cfg.roleAudit })
    expect(after).toBe(snapshot) // 值未被改变
    expect(Object.isFrozen(cfg)).toBe(true)
    for (const key of ['schemas', 'allowedSchemas', 'tenants', 'allowedFixtureObjects', 'roleAudit', 'derived', 'instance', 'fixtureMessages', 'fixtureObjects']) {
      if (cfg[key] !== undefined) expect(Object.isFrozen(cfg[key])).toBe(true)
    }
    // 冻结后前置检查仍按原契约工作
    expect(() => gate.assertTargetAllowed(cfg, { tenantCode: cfg.tenants.a, url: cfg.url })).not.toThrow()
    expect(() => gate.assertTargetAllowed(cfg, { tenantCode: 'school_tjb', url: cfg.url })).toThrow(/TARGET_CODE_NOT_ALLOWED/)
  })
})

describe('R3-H3. 失败释放（合成 Client；原始错误与释放错误同时保留）', () => {
  const makeFakeClient = ({ connectError = null, endError = null, identity, adminRole, instanceTag }) => {
    const state = { connectCalls: 0, endCalls: 0 }
    class FakeClient {
      constructor() { this.state = state }
      async connect() { state.connectCalls += 1; if (connectError) throw connectError }
      async end() { state.endCalls += 1; if (endError) throw endError }
      async query(sql) {
        if (/current_database\(\)/.test(sql)) return { rows: [identity] }
        if (/pg_auth_members/.test(sql)) return { rows: [{ n: 0 }] }
        if (/FROM pg_roles WHERE rolname = current_user/.test(sql)) return { rows: [{ rolname: identity.cu, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }] }
        if (/FROM pg_namespace/.test(sql)) return { rows: [{ schema: identity.schema, owner: 'pg_database_owner' }] }
        if (/has_table_privilege/.test(sql)) return { rows: [{ owner: adminRole, schema_owner: adminRole, can_insert: false, can_update: false, can_delete: false, can_truncate: false }] }
        if (/t02a_instance_marker/.test(sql)) return { rows: [{ value: instanceTag }] }
        return { rows: [] }
      }
    }
    return { FakeClient, state }
  }
  const cfgOf = () => {
    const { file, ctx } = makeContext()
    const r = gate.checkIsolationConfig(env(file, goodUrl(ctx)))
    return r.cfg
  }

  test('connect 拒绝 + end 失败 → 原错误保留，releaseError 同时记录（不被覆盖）', async () => {
    const cfg = cfgOf()
    const connectError = Object.assign(new Error('connection refused (injected)'), { code: 'ECONNREFUSED' })
    const endError = Object.assign(new Error('end failed (injected)'), { code: 'E_END' })
    const { FakeClient, state } = makeFakeClient({ connectError, endError, adminRole: cfg.adminRole, instanceTag: cfg.instanceTag, identity: { db: cfg.database, cu: cfg.role, su: cfg.role, addr: '127.0.0.1/32', port: cfg.port, schema: 'public' } })
    let thrown = null
    try { await gate.connectGuarded(cfg, { Client: FakeClient, expectedSchema: 'public' }) } catch (e) { thrown = e }
    expect(thrown).not.toBeNull()
    expect(thrown.code).toBe('ECONNREFUSED') // 原始错误保留
    expect(thrown.detail.releaseAttempted).toBe(true)
    expect(thrown.detail.releaseError).toMatchObject({ code: 'E_END' })
    expect(state.connectCalls).toBe(1)
    expect(state.endCalls).toBe(1) // connect 失败后仍尝试释放
  })

  test('核验通过 → 正常返回（不调用 end，交由调用方）；核验失败 + end 成功 → releaseError=null', async () => {
    const cfg = cfgOf()
    const okClient = makeFakeClient({ adminRole: cfg.adminRole, instanceTag: cfg.instanceTag, identity: { db: cfg.database, cu: cfg.role, su: cfg.role, addr: '127.0.0.1/32', port: cfg.port, schema: 'public' } })
    const ok = await gate.connectGuarded(cfg, { Client: okClient.FakeClient, expectedSchema: 'public' })
    expect(ok.verified.ok).toBe(true)
    expect(okClient.state.endCalls).toBe(0)

    const bad = makeFakeClient({ adminRole: cfg.adminRole, instanceTag: cfg.instanceTag, identity: { db: cfg.database, cu: cfg.role, su: cfg.role, addr: '127.0.0.1/32', port: cfg.port, schema: 'school_tjb' } })
    let thrown = null
    try { await gate.connectGuarded(cfg, { Client: bad.FakeClient, expectedSchema: 'public' }) } catch (e) { thrown = e }
    expect(thrown.code).toBe('RUNTIME_IDENTITY_MISMATCH')
    expect(thrown.detail.stage).toBe('verify')
    expect(thrown.detail.releaseAttempted).toBe(true)
    expect(thrown.detail.releaseError).toBeNull()
    expect(bad.state.endCalls).toBe(1)
  })
})
