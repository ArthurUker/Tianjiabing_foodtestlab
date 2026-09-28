// 隔离门禁的**负例回归**（P3-W0-T02C 起的新语义；纯函数，不需要数据库）。
//
// 覆盖：
//   · 未配置显式 `TEST_DATABASE_URL` + `TEST_DB_CONTEXT_FILE` → **拒绝**（fail-closed，不 skip、不回落 `DATABASE_URL`）；
//   · 仅给一个变量 / context 文件缺失或坏 JSON → 拒绝；
//   · URL 与 context 派生值不符、固定业务库名、默认端口、重复/非法 query 参数 → 拒绝；
//   · 派生契约（allowedSchemas / tenants / database / role）必须与 runId 派生集合**精确相等**；
//   · 合法配置 → `ok=true` 且派生值齐备（本套件不建立任何数据库连接）；
//   · 旧符号（`testDbUrl` / `parseDbUrl` / `assertIsolationConfig`）→ 明确迁移指引，且错误信息不含连接串/凭据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { gate, loadIsolation, cleanupScoped, testDbUrl, parseDbUrl, assertIsolationConfig } from '../_isolation.mjs'

const ENV_KEYS = ['TEST_DATABASE_URL', 'TEST_DB_CONTEXT_FILE', 'DATABASE_URL']

/** 在受控 env 下求值（不修改真实环境；finally 还原）。 */
function withEnv(env, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  try {
    for (const k of ENV_KEYS) {
      const v = env[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return fn()
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

const check = (env) => withEnv(env, () => gate.checkIsolationConfig({
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  TEST_DB_CONTEXT_FILE: process.env.TEST_DB_CONTEXT_FILE,
}))

/** 构造合法 context（与 runId 派生值一致）。 */
function makeContext(runId, overrides = {}) {
  const d = gate.derivedNamespace(runId)
  const ctx = {
    task: 'P3-W0-T02A', runId,
    instance: { host: '127.0.0.1', port: 55539, database: d.database, role: d.role, instanceTag: d.instanceTag, markerTable: d.markerTable },
    allowedSchemas: d.allowedSchemas,
    allowedFixtureObjects: d.fixtureObjects.slice(),
    tenants: d.tenants,
    roleAudit: d.roleAudit,
    ...overrides,
  }
  return { d, ctx }
}
const urlFor = (d, over = {}) => {
  const port = over.port === undefined ? 55539 : over.port
  const db = over.database || d.database
  return `postgresql://${d.role}:fixture-pw@127.0.0.1:${port}/${db}`
}

test('T02C 门禁：缺全部显式配置 → 拒绝（MISSING_TEST_URL；DATABASE_URL 不构成授权）', () => {
  const r = check({ TEST_DATABASE_URL: undefined, TEST_DB_CONTEXT_FILE: undefined, DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/foodsentinel' })
  assert.equal(r.ok, false)
  assert.equal(String(r.code), 'MISSING_TEST_URL')
})

test('T02C 门禁：仅 TEST_DATABASE_URL（缺 context）→ 拒绝（MISSING_CONTEXT）', () => {
  const { d } = makeContext('t02cgateonlyurl1')
  const r = check({ TEST_DATABASE_URL: urlFor(d), TEST_DB_CONTEXT_FILE: undefined })
  assert.equal(r.ok, false)
  assert.equal(String(r.code), 'MISSING_CONTEXT')
})

test('T02C 门禁：context 文件缺失 / 非 JSON → 拒绝（不返回 ok）', () => {
  const missing = check({ TEST_DATABASE_URL: 'postgresql://t02a_role_x:y@127.0.0.1:55539/t02a_iso_x', TEST_DB_CONTEXT_FILE: '/nonexistent/context.json' })
  assert.equal(missing.ok, false)
})

test('T02C 门禁：URL 与 context 派生值不符 → 拒绝（URL_MISMATCH / 契约类拒绝）', () => {
  const { d } = makeContext('t02cgateurlmismatch')
  // 库名不符
  const r = check({ TEST_DATABASE_URL: urlFor(d, { database: 'other_db' }), TEST_DB_CONTEXT_FILE: writeCtx(d, 't02cgateurlmismatch') })
  assert.equal(r.ok, false)
  assert.ok(['URL_MISMATCH', 'CONTRACT_MISMATCH'].includes(String(r.code)), `实际 code=${r.code}`)
})

test('T02C 门禁：固定业务库名 / 默认端口 / 重复 query → 拒绝', () => {
  const runId = 't02cgatebusiness1'
  const { d, ctx } = makeContext(runId)
  const file = writeCtxRaw(ctx)
  // 固定业务库名（其余仍为派生）→ 契约不符
  const biz = check({ TEST_DATABASE_URL: urlFor(d, { database: 'school_reviewtest' }), TEST_DB_CONTEXT_FILE: file })
  assert.equal(biz.ok, false)
  // 默认端口
  ctx.instance.port = 5432
  const fileDefault = writeCtxRaw(ctx)
  const def = check({ TEST_DATABASE_URL: urlFor(d, { port: 5432 }), TEST_DB_CONTEXT_FILE: fileDefault })
  assert.equal(def.ok, false)
  assert.equal(String(def.code), 'DEFAULT_PORT_REJECTED')
  // 重复参数
  ctx.instance.port = 55539
  const file2 = writeCtxRaw(ctx)
  const dup = check({ TEST_DATABASE_URL: `${urlFor(d)}?schema=public&schema=public`, TEST_DB_CONTEXT_FILE: file2 })
  assert.equal(dup.ok, false)
})

test('T02C 门禁：派生契约必须精确相等（allowedSchemas 多一个 / 少一个都拒绝）', () => {
  const runId = 't02cgatecontract1'
  const { d, ctx } = makeContext(runId)
  const extra = writeCtxRaw({ ...ctx, allowedSchemas: [...ctx.allowedSchemas, 'school_tjb'] })
  const rc1 = check({ TEST_DATABASE_URL: urlFor(d), TEST_DB_CONTEXT_FILE: extra })
  assert.equal(rc1.ok, false)
  const fewer = writeCtxRaw({ ...ctx, allowedSchemas: ctx.allowedSchemas.slice(1) })
  const rc2 = check({ TEST_DATABASE_URL: urlFor(d), TEST_DB_CONTEXT_FILE: fewer })
  assert.equal(rc2.ok, false)
})

test('T02C 门禁：合法派生配置 → ok=true（纯配置判定，不建立任何连接）', () => {
  const runId = 't02cgategoodcfg1'
  const { d } = makeContext(runId)
  const r = check({ TEST_DATABASE_URL: urlFor(d), TEST_DB_CONTEXT_FILE: writeCtx(d, runId) })
  assert.equal(r.ok, true, `拒绝原因=${r.code} ${r.reason}`)
  assert.equal(r.cfg.runId, runId)
  assert.equal(r.cfg.database, d.database)
  assert.equal(r.cfg.role, d.role)
  // 派生租户可用（供套件取 schema）
  const info = withEnv({ TEST_DATABASE_URL: urlFor(d), TEST_DB_CONTEXT_FILE: writeCtx(d, runId) }, () => loadIsolation())
  assert.equal(info.ok, true)
  assert.equal(info.tenant('a').schema, d.schemas.a)
  assert.match(info.tenant('a').urlWithSchema, /schema=/)
})

test('T02C：旧符号（testDbUrl / parseDbUrl / assertIsolationConfig）→ 迁移指引且不含连接串/凭据', () => {
  for (const fn of [testDbUrl, parseDbUrl, assertIsolationConfig]) {
    let thrown = null
    try { fn('postgresql://user:secret@127.0.0.1:5432/db') } catch (e) { thrown = e }
    assert.ok(thrown, '旧符号必须报错（不得静默）')
    assert.equal(String(thrown.code), 'T02C_LEGACY_DISABLED')
    assert.match(String(thrown.message), /TEST_DATABASE_URL \+ TEST_DB_CONTEXT_FILE/)
    assert.equal(/secret|postgresql:\/\//.test(String(thrown.message)), false, '迁移提示不得回显连接串/凭据')
  }
})

test('T02C：清理必须带范围条件（禁止无条件整表删除）', async () => {
  await assert.rejects(() => cleanupScoped({}, {}, 't'), /拒绝执行无范围清理/)
  await assert.rejects(() => cleanupScoped({}, null, 't'), /拒绝执行无范围清理/)
})

// ── 受控 context 文件（写在本进程临时目录；不触库、不写仓库）──
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't02c-gate-ctx-'))
function writeCtxRaw(ctx) {
  const f = path.join(TMP, `ctx-${Math.random().toString(16).slice(2)}.json`)
  fs.writeFileSync(f, JSON.stringify(ctx))
  return f
}
function writeCtx(d, runId, overrides = {}) {
  return writeCtxRaw({
    task: 'P3-W0-T02A', runId,
    instance: { host: '127.0.0.1', port: 55539, database: d.database, role: d.role, instanceTag: d.instanceTag, markerTable: d.markerTable },
    allowedSchemas: d.allowedSchemas,
    allowedFixtureObjects: d.fixtureObjects.slice(),
    tenants: d.tenants,
    roleAudit: d.roleAudit,
    ...overrides,
  })
}
