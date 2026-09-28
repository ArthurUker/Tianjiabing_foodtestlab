// P3-W5-REPORT-AUTH-T01 报告授权矩阵 —— 共享 harness（本包新建；不是测试，不被 node --test 收集）。
//
// 职责：
//   · 从显式隔离配置（TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE）装载本任务**独占实例**上下文（fail-closed）；
//   · 提供实例管理连接串（管理身份；仅本实例库）与真实 server.js 生命周期（自有回环端口，绝不默认端口）；
//   · 登录 / HTTP 辅助：真实走 W1 统一会话模型的 /api/user/login、/api/user/super-admin/login
//     与访客快捷入口 /api/guest/quick-access —— 认证语义零替身。
//
// 边界（总控口径）：
//   · BASE_URL 只允许指向本任务后端（回环 + RPTAUTH_HTTP_PORT 显式指定）；
//   · 口令只经 env 传递（缺失即 fail-closed），绝不写日志/证据；
//   · 不修改生产模块、不连接其他库、不读业务 dotenv。
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const require = createRequire(import.meta.url)
export const here = path.dirname(fileURLToPath(import.meta.url))
export const backendDir = path.resolve(here, '..', '..')
export const repoRoot = path.resolve(backendDir, '..')

export const gate = require(path.join(repoRoot, 'tests/helpers/db-isolation.cjs'))
export const provision = require(path.join(repoRoot, 'tests/isolation/provision.cjs'))

// P3-HARNESS-CHECK-R1：真实 server 前置 = 已迁移实例 + 默认 check（public migrate deploy → 租户链回放 → --check）
export const { prepareMigratedInstance } = await import('../harness-check/_prepare-migrated-instance.mjs')

/** 端口 → 句柄（spawn 前先落 prep；供 waitHealthy/stopBackend 关联同一实例）。 */
const SPAWNED = new Map()
const appendLog = (handle, line) => {
  if (!handle?.logPath) return
  try { fs.appendFileSync(handle.logPath, `${line}\n`) } catch { /* ignore */ }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 装载隔离上下文（显式 TEST_* 配置；缺失 → 抛 RPTAUTH_ISOLATION_REFUSED，不 skip 不回落）。
 * @returns {{cfg:object, runId:string, instanceRoot:string, adminUrl:string, derived:object}}
 */
export function loadReportAuthContext(env = process.env) {
  const result = gate.checkIsolationConfig({
    TEST_DATABASE_URL: env.TEST_DATABASE_URL,
    TEST_DB_CONTEXT_FILE: env.TEST_DB_CONTEXT_FILE,
  })
  if (!result.ok) {
    throw Object.assign(new Error(`[RPTAUTH-ISOLATION-REFUSED] code=${result.code} reason=${result.reason}`), { code: 'RPTAUTH_ISOLATION_REFUSED' })
  }
  const cfg = result.cfg
  const { root, rec } = provision.readOwnership(cfg.runId)
  const { user: adminUser, password: adminPassword } = provision.readAdminCredentials(cfg.runId)
  if (Number(rec.port) !== Number(cfg.port)) {
    throw Object.assign(new Error('[RPTAUTH-INSTANCE] ownership port 与 context 不一致'), { code: 'E_INSTANCE_MISMATCH' })
  }
  const adminUrl = `postgresql://${encodeURIComponent(adminUser)}:${encodeURIComponent(adminPassword)}@127.0.0.1:${cfg.port}/${cfg.database}`
  return { cfg, runId: cfg.runId, instanceRoot: root, adminUrl, derived: cfg.derived }
}

/** 读取本任务 HTTP 端口（显式 env；缺失/非法/与 PG 端口相同 → 拒绝）。 */
export function readHttpPort(env = process.env, cfg) {
  const port = Number(env.RPTAUTH_HTTP_PORT || 0)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw Object.assign(new Error('[RPTAUTH-HTTP-PORT] RPTAUTH_HTTP_PORT 必须显式指定（自有回环端口）'), { code: 'E_HTTP_PORT' })
  }
  if (cfg && Number(cfg.port) === port) {
    throw Object.assign(new Error('[RPTAUTH-HTTP-PORT] HTTP 端口不得与 PG 实例端口相同'), { code: 'E_HTTP_PORT' })
  }
  return port
}

export function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

/**
 * 以真实 server.js 拉起后端（真实 authenticateUser + 真实路由挂载）。
 * P3-HARNESS-CHECK-R1：先在**同一实例**完成迁移前置（public migrate deploy → 租户链回放 → --check rc=0），
 * 再以**默认 check**（不设 AUTO_SYNC_TENANTS）启动；前置失败 → 不启动（fail-closed），
 * `waitHealthy` 会带着 prep 失败原因返回 false，从而使调用方断言失败并保留原始日志。
 * **不使用** AUTO_SYNC_TENANTS=false / attestation / db push / accept-data-loss。
 * 返回句柄 `{ httpPort, logPath, child, fd, prep, prepSummary, prepError, readiness }`（child 在 prep 通过后才存在）。
 */
export function spawnBackend({ httpPort, adminUrl, logPath }) {
  const jwtSecret = crypto.randomBytes(32).toString('hex')
  const handle = { httpPort, logPath, child: null, fd: null, prep: null, prepSummary: null, prepError: null, readiness: null }
  SPAWNED.set(httpPort, handle)
  handle.prep = (async () => {
    const cfgRes = gate.checkIsolationConfig({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL, TEST_DB_CONTEXT_FILE: process.env.TEST_DB_CONTEXT_FILE })
    if (!cfgRes.ok) throw Object.assign(new Error(`[RPTAUTH-PREP] 隔离配置不合法：${cfgRes.code} ${cfgRes.reason}`), { code: cfgRes.code })
    const prep = await prepareMigratedInstance({ adminUrl, cfg: cfgRes.cfg, log: (m) => appendLog(handle, `[prep] ${m}`) })
    // P3-FIXTURE-MIGRATED-R1：不再有 `parked`（认证表寄存逻辑已删除；migration-first 由 provision up 的
    // `public_migrate_deploy` 阶段保证）→ 摘要只保留 public 模式与租户链复核 rc。
    handle.prepSummary = { publicMode: prep.public.mode, tenantCheckRc: prep.tenant.checkRc }
    appendLog(handle, `[prep] public=${prep.public.mode} tenantCheckRc=${prep.tenant.checkRc}（默认 check 前置完成，启动 server）`)
    const fd = fs.openSync(logPath, 'w')
    const child = spawn(process.execPath, ['server.js'], {
      cwd: backendDir,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        NODE_ENV: 'test',
        PORT: String(httpPort),
        JWT_SECRET: jwtSecret,
        DATABASE_URL: adminUrl,
        // P3-HARNESS-CHECK-R1（溯源）：不再关闭启动检测；走默认 check（readiness 通过后租户 API 才放行）。
      },
      stdio: ['ignore', fd, fd],
    })
    handle.fd = fd
    handle.child = child
    return prep
  })().catch((e) => { handle.prepError = e; appendLog(handle, `[prep] FAILED code=${e.code || 'E_PREP'}: ${e.message}`); throw e })
  return handle
}

/**
 * 等待 liveness(200) ∧ readiness(`/api/readyz` 200)。
 * 默认 check 下 readyz 200 才代表「public 迁移证明 + 逐租户台账/结构 + 额外对象」全部通过（无 attestation）。
 */
export async function waitHealthy(httpPort, { attempts = 60, intervalMs = 500 } = {}) {
  const handle = SPAWNED.get(httpPort)
  if (handle?.prep) {
    try { await handle.prep } catch { return false }
  }
  let lastReadiness = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/api/health`)
      if (res.status === 200) {
        const rz = await fetch(`http://127.0.0.1:${httpPort}/api/readyz`)
        let body = null
        try { body = await rz.json() } catch { /* 非 JSON */ }
        lastReadiness = { health: 200, readyz: rz.status, body }
        if (rz.status === 200) {
          if (handle) handle.readiness = lastReadiness
          return true
        }
      }
    } catch { /* not up yet */ }
    await sleep(intervalMs)
  }
  if (handle) handle.readiness = lastReadiness
  appendLog(handle, `[readiness] 未就绪（health/readyz）: ${JSON.stringify(lastReadiness)}`)
  return false
}

export async function stopBackend(handle) {
  const { child, fd } = handle || {}
  if (!child) { if (handle?.httpPort) SPAWNED.delete(handle.httpPort); return { exitCode: null, signal: null, skipped: 'no-child' } }
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break
    await sleep(200)
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    await sleep(500)
  }
  try { fs.closeSync(fd) } catch { /* ignore */ }
  if (handle?.httpPort) SPAWNED.delete(handle.httpPort)
  return { exitCode: child.exitCode, signal: child.signalCode }
}

/** 底层 HTTP 请求（返回 status/headers/body/text）。 */
export async function httpRequest(base, pathname, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { ...headers }
  if (token) h.authorization = `Bearer ${token}`
  let payload
  if (body !== undefined) {
    h['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(base + pathname, { method, headers: h, body: payload })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON（二进制/错误页） */ }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: json, text }
}

/** 平台超管登录（生产专用路由）。 */
export async function loginPlatformSuperAdmin(base, { username, password }) {
  const r = await httpRequest(base, '/api/user/super-admin/login', { method: 'POST', body: { username, password } })
  if (r.status !== 200 || !r.body?.token) {
    throw Object.assign(new Error(`[RPTAUTH-LOGIN] super-admin login failed status=${r.status}`), { code: 'E_LOGIN', status: r.status, body: r.body })
  }
  return r.body.token
}

/** 学校账号登录（显式 schoolCode；NB-04 语义）。 */
export async function loginSchoolUser(base, { username, password, schoolCode }) {
  const r = await httpRequest(base, '/api/user/login', { method: 'POST', body: { username, password, schoolCode } })
  if (r.status !== 200 || !r.body?.token) {
    throw Object.assign(new Error(`[RPTAUTH-LOGIN] school login failed status=${r.status}`), { code: 'E_LOGIN', status: r.status, body: r.body })
  }
  return r.body.token
}

/** 访客快捷入口（只读 JWT，2h；学校须开放访客）。 */
export async function quickAccessGuest(base, schoolCode) {
  const r = await httpRequest(base, '/api/guest/quick-access', { method: 'POST', body: { schoolCode } })
  if (r.status !== 200 || !r.body?.token) {
    throw Object.assign(new Error(`[RPTAUTH-LOGIN] quick-access failed status=${r.status}`), { code: 'E_LOGIN', status: r.status, body: r.body })
  }
  return r.body.token
}

/** 读取本包 fixture 输出（cases/账号名等；不含口令）。 */
export function readFixtureEvidence(env = process.env) {
  const p = env.RPTAUTH_FIXTURE_JSON
  if (!p || !fs.existsSync(p)) {
    throw Object.assign(new Error('[RPTAUTH-FIXTURE] RPTAUTH_FIXTURE_JSON 缺失或不可读'), { code: 'E_FIXTURE_MISSING' })
  }
  const out = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (out.ok !== true) throw Object.assign(new Error('[RPTAUTH-FIXTURE] fixture 标记失败'), { code: 'E_FIXTURE_FAILED' })
  return out
}

/** 读取身份口令（只经 env；缺失即拒绝）。 */
export function readIdentityPasswords(env = process.env) {
  const keys = {
    superAdmin: 'RPTAUTH_SUPER_ADMIN_PASSWORD',
    manager: 'RPTAUTH_MANAGER_PASSWORD',
    operator: 'RPTAUTH_OPERATOR_PASSWORD',
    viewer: 'RPTAUTH_VIEWER_PASSWORD',
  }
  const out = {}
  for (const [role, key] of Object.entries(keys)) {
    const v = env[key]
    if (!v) throw Object.assign(new Error(`[RPTAUTH-ENV] missing ${key}（口令只经 env 传递）`), { code: 'E_ENV' })
    out[role] = v
  }
  return out
}
