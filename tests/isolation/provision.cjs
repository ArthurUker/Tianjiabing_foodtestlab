'use strict'
/**
 * P3-W0-T02A-R1 — 本任务独占 PG 实例 provisioner（管理身份；凭据不回传测试进程）。
 * 闭合复审 R2/R3：SCRAM 口令认证 + 0600 管理凭据；CONNECT/public CREATE 收紧；
 * ownership.json 独立归属记录；stop 非零禁止删目录；up 失败按阶段收尾；路径限制在任务根内。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const gate = require('../helpers/db-isolation.cjs')

const RUN_ID_RE = /^[a-z0-9]{8,32}$/
const DEFAULT_PORTS = ['5432']
const defaultRun = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    signal: r.signal || null, // ★ R4：真实命令的 signal 必须被传递（探测分支与注入测试一致）
    error: r.error ? String(r.error.code || r.error.message || 'ERROR') : null, // ★ spawn 级失败
  }
}
// 测试专用依赖注入（仅本工具模块；生产代码不含跳过开关）。
// 用法：__setRunForTests(impl) 在合成目录内验证危险分支（stop 失败等）；传 null 恢复真实命令。
let run = defaultRun
function __setRunForTests(impl) { run = impl || defaultRun }
class ProvisionError extends Error {
  constructor(code, message, detail) { super(`[${code}] ${message}`); this.code = code; this.detail = detail || null }
}
/**
 * 三态进程探测：present / absent / unknown。
 * 平台 no-match 契约（macOS/BSD `ps -p`）：**rc=1 且 stdout 与 stderr 均为空** → absent。
 * 其余任何情况（rc=1 带 stderr、rc=0 空输出、畸形行、PID 不符、signal/无状态）→ unknown（fail-closed）。
 */
function probePid(pid) {
  const target = Number(pid)
  if (!Number.isInteger(target) || target <= 0) return { state: 'unknown', reason: 'bad_pid' }
  const r = run('ps', ['-ww', '-o', 'pid=,command=', '-p', String(target)])
  if (r.error) return { state: 'unknown', reason: 'spawn_error', error: r.error }
  if (r.signal) return { state: 'unknown', reason: 'signal', signal: r.signal }
  if (r.code === null || r.code === undefined) return { state: 'unknown', reason: 'no_status' }
  const stdout = (r.stdout || '').trim()
  const stderr = (r.stderr || '').trim()
  if (r.code === 1 && stdout === '' && stderr === '') return { state: 'absent', output: '' }
  if (r.code !== 0) return { state: 'unknown', reason: 'command_error', code: r.code, stderr: stderr.slice(0, 120) }
  // ★ R4：rc=0 但存在任一 stderr 诊断 → unknown（诊断输出不得授权归属/删除）
  if (stderr !== '') return { state: 'unknown', reason: 'stderr_on_rc0', stderr: stderr.slice(0, 120) }
  if (stdout === '') return { state: 'unknown', reason: 'empty_output_rc0' }
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length !== 1) return { state: 'unknown', reason: 'line_count', count: lines.length }
  const m = /^(\d+)\s+(.+)$/.exec(lines[0])
  if (!m) return { state: 'unknown', reason: 'malformed_output', sample: lines[0].slice(0, 40) }
  const gotPid = Number(m[1])
  if (gotPid !== target) return { state: 'unknown', reason: 'pid_mismatch', requested: target, got: gotPid }
  const cmdline = m[2].trim()
  if (cmdline === '') return { state: 'unknown', reason: 'empty_command' }
  return { state: 'present', pid: gotPid, cmdline }
}
/**
 * 三态端口探测：listening / released / unknown。
 * 平台 no-match 契约（lsof -t）：**rc=1 且 stdout 与 stderr 均为空** → released。
 * rc=0 空输出、畸形 PID 行（不得丢弃）、命令错误、signal → unknown。
 */
function probePort(port) {
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0 || p > 65535) return { state: 'unknown', reason: 'bad_port' }
  const r = run('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t'])
  if (r.error) return { state: 'unknown', reason: 'spawn_error', error: r.error }
  if (r.signal) return { state: 'unknown', reason: 'signal', signal: r.signal }
  if (r.code === null || r.code === undefined) return { state: 'unknown', reason: 'no_status' }
  const stdout = (r.stdout || '').trim()
  const stderr = (r.stderr || '').trim()
  if (r.code === 1 && stdout === '' && stderr === '') return { state: 'released', pids: [] }
  if (r.code !== 0) return { state: 'unknown', reason: 'command_error', code: r.code, stderr: stderr.slice(0, 120) }
  // ★ R4：rc=0 但 stderr 非空 → unknown（不得用于归属授权或删除）
  if (stderr !== '') return { state: 'unknown', reason: 'stderr_on_rc0', stderr: stderr.slice(0, 120) }
  if (stdout === '') return { state: 'unknown', reason: 'empty_output_rc0' }
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  const pids = []
  for (const line of lines) {
    if (!/^\d+$/.test(line)) return { state: 'unknown', reason: 'malformed_pid_line', sample: line.slice(0, 24) }
    pids.push(Number(line))
  }
  if (pids.length === 0) return { state: 'unknown', reason: 'no_pids' }
  return { state: 'listening', pids }
}
/** 严格解析 -D 数据目录参数（精确路径匹配；空串/子串不放行）。 */
function hasDatadirArg(cmdline, ...expectedPaths) {
  if (typeof cmdline !== 'string' || cmdline === '') return false
  const matches = [...cmdline.matchAll(/(?:^|\s)-D\s+(\S+)/g)].map((m) => m[1])
  if (matches.length === 0) return false
  const norm = (v) => {
    const out = [path.resolve(v)]
    try { out.push(fs.realpathSync(v)) } catch { /* 路径可能已不存在 */ }
    return out
  }
  const expected = new Set()
  for (const e of expectedPaths) {
    if (typeof e !== 'string' || e === '') continue
    for (const n of norm(e)) expected.add(n)
  }
  return matches.some((m) => norm(m).some((n) => expected.has(n)))
}

/**
 * 严格解析 postmaster.pid：PID/datadir/startTime/port 全字段有效（畸形一律 ok=false，不做可选化）。
 * 返回 { ok, rec } 或 { ok:false, reason, ... }。
 */
function readPostmasterPidFile(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' }
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { return { ok: false, reason: 'read_error', code: (e && e.code) || 'UNKNOWN' } }
  const lines = text.split('\n')
  if (lines.length < 5) return { ok: false, reason: 'truncated', lines: lines.length }
  const pid = Number((lines[0] || '').trim())
  const datadir = (lines[1] || '').trim()
  const startTime = Number((lines[2] || '').trim())
  const port = Number((lines[3] || '').trim())
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'bad_pid' }
  if (datadir === '' || !path.isAbsolute(datadir)) return { ok: false, reason: 'bad_datadir' }
  if (!Number.isInteger(startTime) || startTime <= 0) return { ok: false, reason: 'bad_start_time' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'bad_port' }
  return { ok: true, rec: { pid, datadir, startTime, port, socketDir: (lines[4] || '').trim() } }
}

/**
 * 公共基础设施（`public.revoked_tokens` + 3 索引）的**只读契约核对**（P3-FIXTURE-MIGRATED-R2）。
 *
 * 事实源（R9/R10 裁决）：链尾 `-- @scope: public` migration 是结构与索引的**唯一事实源**；
 *   `backend/lib/publicInfraShape.js` 是产品侧只读形状契约（纯 pg_catalog 查询，不写库）。
 * 本模块**不再**依赖 `authMiddleware.REVOKED_TOKENS_DDL`（公共链同一发布已删除该常量），
 * **不**在测试准备阶段补建/修复产品基础设施——缺失或错形一律拒绝（fail-closed）。
 */
function migrationChainFiles() {
  const dir = path.join(__dirname, '..', '..', 'backend', 'prisma', 'migrations')
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const file = path.join(dir, e.name, 'migration.sql')
    return { name: e.name, checksum: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** 公共基础设施相关链文件（名字含 public_infra_，且声明 `-- @scope: public`）。 */
function publicInfraChainFiles() {
  return migrationChainFiles().filter((f) => {
    if (!/public_infra_/.test(f.name)) return false
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'prisma', 'migrations', f.name, 'migration.sql'), 'utf8')
    return /^--\s*@scope:\s*public\s*$/m.test(sql)
  })
}

/**
 * 只读：链上 public 基础设施 migration 是否已应用且 checksum 一致。
 * @param {{client:object}} args client = pg Client（本模块内部）或 Prisma（$queryRawUnsafe）
 * @returns {Promise<{ok:boolean, files:Array, missing:string[], checksumMismatch:string[]}>}
 */
async function publicInfraMigrationStatus({ client }) {
  const files = publicInfraChainFiles()
  // 注意：Prisma `$queryRawUnsafe(sql, [])` 会把空数组当作**一个绑定参数** → 42P18；
  //       无参数时必须只传 SQL（pg Client 则始终传参数数组）。
  const run = (sql, params = []) => (typeof client.$queryRawUnsafe === 'function'
    ? (params.length ? client.$queryRawUnsafe(sql, ...params) : client.$queryRawUnsafe(sql))
    : client.query(sql, params))
  const rowsRes = await run(`SELECT migration_name, checksum, finished_at FROM public."_prisma_migrations"`)
  const rows = Array.isArray(rowsRes) ? rowsRes : (rowsRes.rows || [])
  const byName = new Map(rows.map((r) => [r.migration_name, r]))
  const missing = []
  const checksumMismatch = []
  for (const f of files) {
    const row = byName.get(f.name)
    if (!row || row.finished_at == null) { missing.push(f.name); continue }
    if (String(row.checksum) !== f.checksum) checksumMismatch.push(f.name)
  }
  return { ok: missing.length === 0 && checksumMismatch.length === 0, files: files.map((f) => f.name), missing, checksumMismatch }
}

/**
 * 只读：吊销表 + 三索引形状（产品 `publicInfraShape.js` 契约；缺列/错列/缺索引 → 违规清单）。
 * 该模块只发 SELECT（pg_catalog），不写库；受限角色亦可执行。
 */
async function revocationShapeIssues({ client, shapeFn }) {
  if (typeof shapeFn !== 'function') {
    const err = new ProvisionError('E_SHAPE_FN_REQUIRED', '缺少 shapeFn（应为 backend/lib/publicInfraShape.js#revokedTokensShapeIssues）：本模块是 CJS，不能动态 import ESM 产品模块；由 ESM 调用方注入')
    throw err
  }
  // 适配器：产品契约要求 `$queryRawUnsafe`（Prisma 形态）；本模块内部常用 pg Client → 包一层只读适配
  const prismaLike = typeof client.$queryRawUnsafe === 'function'
    ? client
    : { $queryRawUnsafe: async (sql, ...params) => (await client.query(sql, params)).rows }
  const issues = await shapeFn(prismaLike)
  return { ok: issues.length === 0, issues, contract: 'backend/lib/publicInfraShape.js#revokedTokensShapeIssues' }
}

/**
 * 契约断言（fixture 使用）：链上 migration 已应用 + 形状合规；任一不满足 → 抛 typed error（不补建）。
 * @param {{client:object}} args
 * @returns {Promise<{migration:object, shape:object, ok:true}>}
 */
async function assertRevocationInfraFromChain({ client, shapeFn = null }) {
  const migration = await publicInfraMigrationStatus({ client })
  if (!migration.ok) {
    const err = new ProvisionError(
      'E_PUBLIC_INFRA_MIGRATION_NOT_APPLIED',
      `链上 public 基础设施 migration 未应用或 checksum 不一致（missing=${migration.missing.join(',') || '-'}；checksumMismatch=${migration.checksumMismatch.join(',') || '-'}）→ 拒绝（测试准备阶段**不**补建产品设施；请用 provision up 的 public_migrate_deploy 阶段）`,
      migration)
    throw err
  }
  let shape = { ok: null, checked: false, issues: [], contract: null }
  if (typeof shapeFn === 'function') {
    shape = { ...(await revocationShapeIssues({ client, shapeFn })), checked: true }
    if (!shape.ok) {
      const err = new ProvisionError(
        'E_PUBLIC_INFRA_SHAPE',
        `revoked_tokens 形状不符合链上契约（${shape.issues.join('；')}）→ 拒绝（fixture 不创建/不修复产品基础设施；缺设施应查链是否部署）`,
        shape)
      throw err
    }
  }
  return { migration, shape, ok: true, shapeChecked: shape.checked === true }
}

/** 迁移先行契约：public 结构必须**先**由版本化链建立，再创建任何 public 预置对象。 */
function migrationFirstPublicStage(args) {
  const { prismaBin, schemaPath, adminUrl } = args
  const r = run(prismaBin, ['migrate', 'deploy', '--schema', schemaPath], {
    cwd: path.join(__dirname, '..', '..', 'backend'), encoding: 'utf8', timeout: 300000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: adminUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  })
  return { code: r.code, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** psql argv 构建（纯函数；仅安全参数，**永不**包含口令/带密码 URL）。 */
function buildPsqlArgv({ host, port, user, database, extra = [] }) {
  return ['-h', host, '-p', String(port), '-U', user, '-d', database, ...extra].map(String)
}
/** 写 0600 PGPASSFILE（psql 的独立凭据来源；仅管理子进程接收）。 */
function writePgpassFile(root, { host, port, database, user, password }) {
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/:/g, '\\:')
  const file = path.join(root, '.pgpass')
  fs.writeFileSync(file, `${esc(host)}:${esc(port)}:${esc(database)}:${esc(user)}:${esc(password)}\n`, { mode: 0o600 })
  return file
}

const assertRunId = (runId) => { if (!RUN_ID_RE.test(String(runId || ''))) throw new ProvisionError('E_RUNID', 'runId must match ^[a-z0-9]{8,32}$') }
const assertPort = (port) => {
  const p = Number(port)
  if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new ProvisionError('E_PORT', 'invalid port')
  if (DEFAULT_PORTS.includes(String(p))) throw new ProvisionError('E_PORT_DEFAULT', 'default PostgreSQL port is not allowed')
  return p
}
const taskRoot = (runId) => { assertRunId(runId); return path.join(os.tmpdir(), `t02a-${runId}`) }

/** 只允许任务根下的精确子路径；存在时拒绝符号链接与越界 realpath。 */
function assertInsideTaskRoot(runId, target, { mustExist = false } = {}) {
  const root = taskRoot(runId)
  const resolved = path.resolve(target)
  const rel = path.relative(root, resolved)
  // 允许任务根自身（rel === ''）；拒绝越上层与绝对路径
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ProvisionError('E_PATH_ESCAPE', 'path outside task root')
  if (fs.existsSync(resolved)) {
    if (fs.lstatSync(resolved).isSymbolicLink()) throw new ProvisionError('E_SYMLINK', 'symlink not allowed')
    const realRel = path.relative(fs.realpathSync(root), fs.realpathSync(resolved))
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new ProvisionError('E_PATH_ESCAPE', 'resolved path escapes task root')
  } else if (mustExist) throw new ProvisionError('E_PATH_MISSING', 'path missing')
  return resolved
}

function readOwnership(runId) {
  const root = taskRoot(runId)
  const file = path.join(root, 'ownership.json')
  if (!fs.existsSync(file)) throw new ProvisionError('E_NO_OWNERSHIP', 'ownership record missing (unknown instance)')
  assertInsideTaskRoot(runId, file, { mustExist: true })
  let rec
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new ProvisionError('E_OWNERSHIP_MISMATCH', 'ownership record is not valid JSON') }
  if (rec.runId !== runId) throw new ProvisionError('E_OWNERSHIP_MISMATCH', 'runId mismatch')
  const expectedDatadir = path.join(root, 'data')
  let normalizedExpected = expectedDatadir
  try { normalizedExpected = fs.realpathSync(expectedDatadir) } catch { /* directory may be gone */ }
  // 逐项严格校验（缺字段/空值/畸形 port/startTime 一律拒绝，不转为可选）
  if (!Number.isInteger(Number(rec.pid)) || Number(rec.pid) <= 0) throw new ProvisionError('E_OWNERSHIP_MISMATCH', 'pid must be a positive integer')
  if (!Number.isInteger(Number(rec.port)) || Number(rec.port) < 1 || Number(rec.port) > 65535) throw new ProvisionError('E_OWNERSHIP_MISMATCH', 'port must be within 1..65535')
  if (!Number.isInteger(Number(rec.startTime)) || Number(rec.startTime) <= 0) throw new ProvisionError('E_OWNERSHIP_MISMATCH', 'startTime must be a positive integer (actual instance start identity)')
  // ★ R4：datadir 与 datadirReal 两个字段都必须存在且**各自**指向本任务精确 data（互相矛盾/跨路径/缺失 → 拒绝）
  if (typeof rec.datadir !== 'string' || rec.datadir === '' || !path.isAbsolute(rec.datadir)) throw new ProvisionError('E_OWNERSHIP_MISMATCH', 'datadir must be a non-empty absolute path')
  if (typeof rec.datadirReal !== 'string' || rec.datadirReal === '' || !path.isAbsolute(rec.datadirReal)) throw new ProvisionError('E_OWNERSHIP_MISMATCH', 'datadirReal must be a non-empty absolute path (both path fields are required)')
  const normTo = (v) => { const out = [path.resolve(v)]; try { out.push(fs.realpathSync(v)) } catch { /* path may be gone */ } return out }
  const expectedSet = new Set(normTo(expectedDatadir))
  const rawPointsToTask = normTo(rec.datadir).some((x) => expectedSet.has(x))
  const realPointsToTask = normTo(rec.datadirReal).some((x) => expectedSet.has(x))
  if (!rawPointsToTask || !realPointsToTask) {
    throw new ProvisionError('E_OWNERSHIP_MISMATCH', 'datadir and datadirReal must each resolve to this task data directory')
  }
  const realOfRaw = (() => { try { return fs.realpathSync(rec.datadir) } catch { return path.resolve(rec.datadir) } })()
  const realOfReal = (() => { try { return fs.realpathSync(rec.datadirReal) } catch { return path.resolve(rec.datadirReal) } })()
  if (realOfRaw !== realOfReal) {
    throw new ProvisionError('E_OWNERSHIP_MISMATCH', 'datadir and datadirReal contradict each other')
  }
  return { root, file, rec: { ...rec, pid: Number(rec.pid), port: Number(rec.port), startTime: Number(rec.startTime) } }
}

/**
 * 统一归属判定（up 失败收尾 / down / status 共用同一函数）。
 * 严格互核：ownership.json（PID/port/startTime/datadir 严格） <-> postmaster.pid（全字段） <-> 实际进程命令行（-D 精确匹配） <-> 监听者 PID。
 * ownEvidence 只有在"进程 present + 命令行 -D 匹配 + 监听者包含该 PID + pidfile 全字段一致"时才为 true（才允许 stop）。
 */
function assessOwnership(runId) {
  const { root, rec } = readOwnership(runId)
  const expectedData = path.join(root, 'data')
  const pidProbe = probePid(rec.pid)
  const portProbe = probePort(rec.port)
  const pidfile = readPostmasterPidFile(path.join(expectedData, 'postmaster.pid'))
  const cmdHasDatadirArg = pidProbe.state === 'present' && hasDatadirArg(pidProbe.cmdline, expectedData, rec.datadirReal)
  const listenerMatches = portProbe.state === 'listening' && portProbe.pids.includes(rec.pid)
  const norm = (v) => { const r = [path.resolve(v)]; try { r.push(fs.realpathSync(v)) } catch { /* ok */ } return r }
  const pidfileMatches = pidfile.ok === true
    && pidfile.rec.pid === rec.pid
    && pidfile.rec.startTime === rec.startTime
    && pidfile.rec.port === rec.port
    && norm(pidfile.rec.datadir).some((x) => norm(expectedData).includes(x))
  const ownEvidence = pidProbe.state === 'present' && cmdHasDatadirArg && listenerMatches && pidfileMatches
  const stoppedClean = pidProbe.state === 'absent' && portProbe.state === 'released'
  const indeterminate = pidProbe.state === 'unknown' || portProbe.state === 'unknown'
  return { root, rec, expectedData, pidProbe, portProbe, pidfile, cmdHasDatadirArg, listenerMatches, pidfileMatches, ownEvidence, stoppedClean, indeterminate }
}
/** 收尾/状态用：评估可能不存在的实例（ownership 缺失时不抛，返回 evidenceState='missing'）。 */
function tryAssessOwnership(runId) {
  try { return { ...assessOwnership(runId), evidenceState: 'read' } }
  catch (e) { return { evidenceState: 'missing', code: (e && e.code) || 'UNKNOWN', runId, root: taskRoot(runId) } }
}

const adminEnvPath = (root) => path.join(root, 'admin.env')
function readAdminCredentials(runId) {
  const { root } = readOwnership(runId)
  const file = adminEnvPath(root)
  assertInsideTaskRoot(runId, file, { mustExist: true })
  const text = fs.readFileSync(file, 'utf8')
  const user = (text.match(/^ADMIN_USER=(.*)$/m) || [])[1]
  const password = (text.match(/^ADMIN_PASSWORD=(.*)$/m) || [])[1]
  if (!user || !password) throw new ProvisionError('E_ADMIN_CREDENTIALS', 'admin credential file incomplete')
  return { user, password }
}
async function withAdmin(runId, database, fn) {
  const { Client } = require('pg')
  const { rec } = readOwnership(runId)
  const { user, password } = readAdminCredentials(runId)
  const client = new Client({
    connectionString: `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${rec.port}/${database}`,
    connectionTimeoutMillis: 8000, application_name: 't02a-provisioner',
  })
  let mainError = null
  let result
  try {
    await client.connect()
    result = await fn(client)
  } catch (e) { mainError = e }
  let releaseError = null
  try { await client.end() } catch (ee) { releaseError = ee } // connect 失败也尝试释放（幂等；失败单独保留）
  if (mainError) {
    if (releaseError) {
      mainError.detail = { ...(mainError.detail || {}), releaseAttempted: true, releaseError: { code: releaseError.code || 'UNKNOWN', message: String(releaseError.message).slice(0, 120) } }
    }
    throw mainError
  }
  if (releaseError) {
    const e = new Error('[ADMIN_RELEASE_FAILED] admin client end() failed after a successful operation')
    e.code = 'E_ADMIN_RELEASE'
    e.detail = { releaseError: { code: releaseError.code || 'UNKNOWN', message: String(releaseError.message).slice(0, 120) } }
    throw e
  }
  return result
}

const ROLE_ATTRS = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'

async function createFixtures(t, derived, role, password) {
  let revocationInfra = null
  const db = derived.database
  // P3-DB-FIXTURE-R1：fixture 对象不得存在于**任何**旧位置（public/学校）或新位置（fixture schema）
  const pre = await t.query(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname IN ('messages', 't02a_instance_marker') OR n.nspname = $1`, [derived.fixtureSchema])
  if (pre.rows[0].n !== 0) throw new ProvisionError('E_EXISTING_OBJECTS', 'fixture objects/schema already exist')

  await t.query(`CREATE ROLE ${gate.quoteIdent(role)} LOGIN PASSWORD '${password}' ${ROLE_ATTRS}`)
  // 角色创建后才授权目标库 CONNECT（PUBLIC 已被收回 → 测试凭据无法连接其他库）
  await t.query(`GRANT CONNECT ON DATABASE ${gate.quoteIdent(db)} TO ${gate.quoteIdent(role)}`)
  // R2：显式收紧**非目标库**（postgres/template1）CONNECT —— PUBLIC 与测试角色一律收回（管理身份仍可管理自身实例）
  for (const other of ['postgres', 'template1']) {
    await t.query(`REVOKE CONNECT ON DATABASE ${gate.quoteIdent(other)} FROM PUBLIC`)
    await t.query(`REVOKE CONNECT ON DATABASE ${gate.quoteIdent(other)} FROM ${gate.quoteIdent(role)}`)
  }
  await t.query(`ALTER ROLE ${gate.quoteIdent(role)} IN DATABASE ${gate.quoteIdent(db)} SET search_path = public`)
  await t.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
  await t.query(`GRANT USAGE ON SCHEMA public TO ${gate.quoteIdent(role)}`)
  // public.revoked_tokens：**正式认证基础设施**（留在 public；产品白名单已含）。
  // P3-FIXTURE-MIGRATED-R2：结构与索引由链尾 `-- @scope: public` migration 建立（唯一事实源）；
  //   `up()` 的 `public_migrate_deploy` 阶段已先应用该链 → 这里**只读核对**（链上 migration + 形状契约），
  //   缺失/错形即拒绝；**不在测试准备阶段补建/修复产品基础设施**。
  {
    // 纯 SQL 核对（链上 migration 已应用 + checksum）；形状契约由 ESM 调用方（fixture）注入 shapeFn 后核对，
    //   本 CJS 模块不能动态 import ESM 产品模块（Jest CJS VM 会报 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG）。
    const infra = await assertRevocationInfraFromChain({ client: t })
    revocationInfra = infra
  }
  // ── 专用 fixture schema（runId 派生；owner = 任务管理角色；非 public、非学校 schema）──
  //    marker（测试角色只读）+ 每租户 slot 一张 messages（物理分离；产物 schema 无合成表）
  await t.query(`CREATE SCHEMA ${gate.quoteIdent(derived.fixtureSchema)}`)
  await t.query(`CREATE TABLE ${gate.quoteQualified(derived.markerTable)} (key text PRIMARY KEY, value text NOT NULL)`)
  await t.query(`INSERT INTO ${gate.quoteQualified(derived.markerTable)} (key, value) VALUES ('instance_tag', $1)`, [derived.instanceTag])
  for (const slot of gate.FIXTURE_CONTRACT.messagesSlots) {
    const table = derived.fixtureMessages[slot]
    await t.query(`CREATE TABLE ${gate.quoteQualified(table)} (id serial PRIMARY KEY, tenant_tag text NOT NULL, body text NOT NULL)`)
    await t.query(`INSERT INTO ${gate.quoteQualified(table)} (tenant_tag, body) VALUES ($1, $2)`, [derived.tenants[slot], `data-of-${derived.tenants[slot]}`])
  }

  // 学校 schema：只建 schema 本体（**不再建合成 messages** —— 产物 schema 的额外对象会触发 TENANT_EXTRA_OBJECTS）
  for (const slot of ['a', 'b', 'c']) {
    const schema = derived.schemas[slot]
    await t.query(`CREATE SCHEMA ${gate.quoteIdent(schema)}`)
  }
  const ra = derived.schemas.ra
  await t.query(`CREATE SCHEMA ${gate.quoteIdent(ra)}`)
  await t.query(`CREATE TABLE ${gate.quoteIdent(ra)}."User" (id text PRIMARY KEY, username text NOT NULL UNIQUE, role text, created_at timestamptz NOT NULL DEFAULT now())`)
  await t.query(`CREATE TABLE ${gate.quoteIdent(ra)}."AuditLog" (id text PRIMARY KEY, user_id text NOT NULL, action text NOT NULL, resource_type text, resource_id text, details jsonb, created_at timestamptz NOT NULL DEFAULT now())`)
  await t.query(`INSERT INTO ${gate.quoteIdent(ra)}."User" (id, username, role) VALUES ($1, $2, 'operator')`, [derived.roleAudit.userId, derived.roleAudit.username])

  await t.query(`GRANT SELECT, INSERT ON public.revoked_tokens TO ${gate.quoteIdent(role)}`)   // 形状已在上面确保（链建或本处补齐）
  await t.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${gate.quoteIdent(role)}`)
  // fixture schema：USAGE + 每 slot messages DML + marker 只读（写权限集合必须全 false）
  await t.query(`GRANT USAGE ON SCHEMA ${gate.quoteIdent(derived.fixtureSchema)} TO ${gate.quoteIdent(role)}`)
  for (const slot of gate.FIXTURE_CONTRACT.messagesSlots) {
    const table = derived.fixtureMessages[slot]
    await t.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${gate.quoteQualified(table)} TO ${gate.quoteIdent(role)}`)
    const seq = `${derived.fixtureSchema}.${gate.FIXTURE_CONTRACT.messagesTablePrefix}${slot}_id_seq`
    await t.query(`GRANT USAGE, SELECT ON SEQUENCE ${gate.quoteQualified(seq)} TO ${gate.quoteIdent(role)}`)
  }
  await t.query(`GRANT SELECT ON ${gate.quoteQualified(derived.markerTable)} TO ${gate.quoteIdent(role)}`)
  for (const slot of ['a', 'b', 'c']) {
    const schema = derived.schemas[slot]
    await t.query(`GRANT USAGE ON SCHEMA ${gate.quoteIdent(schema)} TO ${gate.quoteIdent(role)}`)
    await t.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${gate.quoteIdent(schema)} TO ${gate.quoteIdent(role)}`)
    await t.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${gate.quoteIdent(schema)} TO ${gate.quoteIdent(role)}`)
  }
  await t.query(`GRANT USAGE ON SCHEMA ${gate.quoteIdent(ra)} TO ${gate.quoteIdent(role)}`)
  await t.query(`GRANT SELECT, UPDATE ON ${gate.quoteIdent(ra)}."User" TO ${gate.quoteIdent(role)}`)
  await t.query(`GRANT SELECT, INSERT ON ${gate.quoteIdent(ra)}."AuditLog" TO ${gate.quoteIdent(role)}`)

  await t.query(`CREATE ROLE ${gate.quoteIdent(derived.sentinelOwner)} NOLOGIN`)
  await t.query(`CREATE SCHEMA ${gate.quoteIdent(derived.sentinelSchema)} AUTHORIZATION ${gate.quoteIdent(derived.sentinelOwner)}`)
  await t.query(`SET ROLE ${gate.quoteIdent(derived.sentinelOwner)}`)
  await t.query(`CREATE TABLE ${gate.quoteIdent(derived.sentinelSchema)}.sentinel_rows (id serial PRIMARY KEY, note text NOT NULL)`)
  await t.query(`INSERT INTO ${gate.quoteIdent(derived.sentinelSchema)}.sentinel_rows (note) VALUES ('external-sentinel-v1')`)
  await t.query(`RESET ROLE`)
}

async function up({ runId, port }) {
  assertRunId(runId)
  const p = { port: assertPort(port) }
  const root = taskRoot(runId)
  const data = path.join(root, 'data')
  const log = path.join(root, 'pg.log')
  if (fs.existsSync(root)) throw new ProvisionError('E_COLLISION_DIR', 'task root already exists')
  const prePort = probePort(p.port)
  if (prePort.state === 'unknown') {
    throw new ProvisionError('E_PROBE_UNKNOWN', 'port pre-check is indeterminate; refusing to create or start (fail-closed)', { probe: prePort })
  }
  if (prePort.state === 'listening') throw new ProvisionError('E_COLLISION_PORT', 'port already listening', { pids: prePort.pids })

  const derived = gate.derivedNamespace(runId)
  const stages = []
  const cleanup = { attempted: false, stopped: false, removed: false, errors: [] }
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    assertInsideTaskRoot(runId, root, { mustExist: true })
    stages.push('created_root')

    const adminPassword = crypto.randomBytes(24).toString('base64url')
    const pwfile = path.join(root, '.admin-pwfile')
    fs.writeFileSync(pwfile, adminPassword + '\n', { mode: 0o600 })
    const initdb = run('initdb', ['-D', data, '-U', derived.adminRole, `--pwfile=${pwfile}`, '--auth-local=trust', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C'])
    if (initdb.code !== 0) throw new ProvisionError('E_INITDB', 'initdb failed', { stderr: initdb.stderr.slice(0, 200) })
    stages.push('initdb_done')
    fs.rmSync(pwfile, { force: true })
    fs.writeFileSync(adminEnvPath(root), `ADMIN_USER=${derived.adminRole}\nADMIN_PASSWORD=${adminPassword}\n`, { mode: 0o600 })
    stages.push('wrote_admin_env')

    stages.push('start_attempted') // R2：调用 start **之前**登记（start 非零/超时不能证明子进程没有启动）
    const start = run('pg_ctl', ['-D', data, '-l', log, '-o', `-p ${p.port} -k ${root} -c listen_addresses=127.0.0.1`, 'start'])
    if (start.code !== 0) throw new ProvisionError('E_PGCTL_START', 'pg_ctl start failed', { output: (start.stderr + start.stdout).slice(0, 200) })
    stages.push('started_instance')

    const pf = readPostmasterPidFile(path.join(data, 'postmaster.pid'))
    if (!pf.ok) throw new ProvisionError('E_PIDFILE_INVALID', 'postmaster.pid is missing or malformed right after start', { reason: pf.reason })
    if (pf.rec.port !== p.port) throw new ProvisionError('E_PIDFILE_PORT_MISMATCH', 'postmaster.pid port does not match the requested port', { expected: p.port, actual: pf.rec.port })
    const dataReal = fs.realpathSync(data)
    const pfDatadirOk = path.resolve(pf.rec.datadir) === path.resolve(data) || path.resolve(pf.rec.datadir) === path.resolve(dataReal)
    if (!pfDatadirOk) throw new ProvisionError('E_PIDFILE_DATADIR_MISMATCH', 'postmaster.pid datadir does not match the task data directory')
    fs.writeFileSync(path.join(root, 'ownership.json'),
      JSON.stringify({ runId, datadir: path.resolve(data), datadirReal: dataReal, port: p.port, pid: pf.rec.pid, startTime: pf.rec.startTime, startedBy: process.getuid ? process.getuid() : null, createdAt: new Date().toISOString() }, null, 2) + '\n',
      { mode: 0o600 })
    stages.push('wrote_ownership')

    const password = crypto.randomBytes(24).toString('base64url')
    await withAdmin(runId, 'postgres', async (admin) => {
      await admin.query(`CREATE DATABASE ${gate.quoteIdent(derived.database)}`)
      await admin.query(`REVOKE CONNECT ON DATABASE ${gate.quoteIdent(derived.database)} FROM PUBLIC`)
      // GRANT CONNECT 在角色创建之后执行（见 createFixtures），避免 role 不存在
    })
    stages.push('created_database')

    const { Client } = require('pg')
    const { user: aU, password: aP } = readAdminCredentials(runId)
    const adminUrlForDeploy = `postgresql://${aU}:${encodeURIComponent(aP)}@127.0.0.1:${p.port}/${derived.database}`

    // ★ P3-FIXTURE-MIGRATED-R1（O1 / B1-O1）：**migration-first** —— public 结构先经版本化链建立，
    //   然后才创建任何 public 预置对象（createFixtures 的 public.revoked_tokens 等）。
    //   这样既不会触发 Prisma P3005（"schema is not empty"），也不需要把认证表 SET SCHEMA 临时寄存、
    //   不需要 `migrate resolve`、不需要 attestation。真实运行器下失败一律 fail-closed（先清理再抛错）。
    {
      const deploy = migrationFirstPublicStage({
        prismaBin: path.join(__dirname, '..', '..', 'backend', 'node_modules', '.bin', 'prisma'),
        schemaPath: path.join(__dirname, '..', '..', 'backend', 'prisma', 'schema.prisma'),
        adminUrl: adminUrlForDeploy,
      })
      stages.push('public_migrate_deploy')
      if (deploy.code !== 0) {
        throw new ProvisionError('E_PUBLIC_MIGRATE_DEPLOY', 'prisma migrate deploy (public, migration-first) failed', {
          rc: deploy.code,
          tail: `${String(deploy.stdout).slice(-200)}${String(deploy.stderr).slice(-200)}`,
        })
      }
    }

    const t = new Client({ connectionString: adminUrlForDeploy, connectionTimeoutMillis: 8000, application_name: 't02a-provisioner' })
    let fixtureError = null
    try {
      await t.connect()
      await createFixtures(t, derived, derived.role, password)
    } catch (e) { fixtureError = e }
    let fixtureReleaseError = null
    try { await t.end() } catch (ee) { fixtureReleaseError = ee } // connect 失败也尝试释放；错误单独保留
    if (fixtureError) {
      if (fixtureReleaseError) {
        fixtureError.detail = { ...(fixtureError.detail || {}), releaseAttempted: true, releaseError: { code: fixtureReleaseError.code || 'UNKNOWN', message: String(fixtureReleaseError.message).slice(0, 120) } }
      }
      throw fixtureError
    }
    if (fixtureReleaseError) {
      const e = new Error('[FIXTURE_RELEASE_FAILED] fixture client end() failed after a successful operation')
      e.code = 'E_FIXTURE_RELEASE'
      e.detail = { releaseError: { code: fixtureReleaseError.code || 'UNKNOWN', message: String(fixtureReleaseError.message).slice(0, 120) } }
      throw e
    }
    stages.push('fixtures_done')

    const triggerSql = path.join(__dirname, '../../backend/prisma/role-audit-trigger.sql')
    // R2：管理口令经 0600 PGPASSFILE 提供，argv 只含安全 host/port/user/db 与 SQL 路径
    const pgpass = writePgpassFile(root, { host: '127.0.0.1', port: p.port, database: derived.database, user: aU, password: aP })
    const psqlArgv = buildPsqlArgv({ host: '127.0.0.1', port: p.port, user: aU, database: derived.database, extra: ['-v', 'ON_ERROR_STOP=1', '-v', `schema=${derived.schemas.ra}`, '-f', triggerSql] })
    const argvContainsSecret = psqlArgv.some((x) => x.includes(aP)) || psqlArgv.some((x) => x.includes('://'))
    fs.writeFileSync(path.join(root, 'psql-argv.json'), JSON.stringify({ argv: psqlArgv, argvContainsSecret, credentialSource: 'PGPASSFILE(.pgpass 0600)' }, null, 2) + '\n', { mode: 0o600 })
    if (argvContainsSecret) throw new ProvisionError('E_ARGV_LEAK', 'psql argv would contain secret material; refusing to spawn')
    const psql = run('psql', psqlArgv, { env: { ...process.env, PGPASSFILE: pgpass } })
    if (psql.code !== 0) throw new ProvisionError('E_TRIGGER_SQL', 'production trigger SQL failed', { stderr: (psql.stderr || '').slice(0, 300) })
    stages.push('trigger_applied')

    const contextPath = path.join(root, 'context.json')
    const envPath = path.join(root, 'test-env.sh')
    fs.writeFileSync(contextPath, JSON.stringify({
      task: 'P3-W0-T02A', runId,
      instance: { host: '127.0.0.1', port: p.port, database: derived.database, role: derived.role, instanceTag: derived.instanceTag, markerTable: derived.markerTable },
      allowedSchemas: derived.allowedSchemas,
      allowedFixtureObjects: derived.fixtureObjects.slice(),
      tenants: { ...derived.tenants },
      roleAudit: { ...derived.roleAudit },
      sentinel: { owner: derived.sentinelOwner, schema: derived.sentinelSchema, table: `${derived.sentinelSchema}.sentinel_rows` },
      fixture: { schema: derived.fixtureSchema },
    }, null, 2) + '\n', { mode: 0o600 })
    const testUrl = `postgresql://${derived.role}:${encodeURIComponent(password)}@127.0.0.1:${p.port}/${derived.database}`
    fs.writeFileSync(envPath, `export TEST_DATABASE_URL='${testUrl}'\nexport TEST_DB_CONTEXT_FILE='${contextPath}'\n`, { mode: 0o600 })
    stages.push('context_written')

    return { contextPath, envPath, summary: { runId, port: p.port, database: derived.database, role: derived.role, instanceTag: derived.instanceTag, schemas: derived.schemas, fixtureSchema: derived.fixtureSchema, fixtureMessages: { ...derived.fixtureMessages }, stages } }
  } catch (e) {
    cleanup.attempted = true
    try {
      const startAttempted = stages.includes('start_attempted')
      const rootExists = fs.existsSync(root)
      if (!startAttempted) {
        // 启动前失败：只清确知本调用创建且尚未尝试启动的资源；不对任何监听者调用 stop
        if (rootExists) {
          assertInsideTaskRoot(runId, root, { mustExist: true })
          fs.rmSync(root, { recursive: true, force: true })
          cleanup.removed = true
          cleanup.anyResourceCleaned = true
        }
      } else {
        // ★ R4：启动已尝试 → 调用与 down/status **完全相同**的归属判定（ownership 为权威）。
        // ownership 缺失、任一字段不一致或探测不确定 → down 内部一律零 stop/delete 并保留现场。
        const verdict = down({ runId })
        cleanup.safeShutdown = verdict
        cleanup.removed = verdict.removed === true
        cleanup.stopped = verdict.stopped === true
        cleanup.probes = verdict.checks
          ? { pidState: verdict.checks.pidState, portState: verdict.checks.portState }
          : (verdict.probes || {})
        if (verdict.ok !== true) {
          cleanup.zeroStopDelete = verdict.stopped !== true && verdict.removed !== true
          cleanup.keepReason = verdict.reason || 'cleanup_unverified'
          if (verdict.manual) cleanup.manual = verdict.manual
          if (verdict.note) cleanup.note = verdict.note
          if (verdict.stoppedCleanObserved !== undefined) cleanup.stoppedCleanObserved = verdict.stoppedCleanObserved
        }
        if (rootExists && cleanup.removed !== true) {
          cleanup.keptForManualHandling = { datadir: path.resolve(data), port: p.port, reason: cleanup.keepReason || 'cleanup_unverified' }
        }
      }
    } catch (ce) { cleanup.errors.push({ step: 'cleanup', code: ce.code || 'UNKNOWN', message: String(ce.message).slice(0, 120) }) }
    throw new ProvisionError('E_UP_FAILED', 'provision up failed; original error preserved with cleanup result', {
      originalError: { code: e.code || 'UNKNOWN', message: String(e.message).slice(0, 200) },
      stages, cleanup,
    })
  }
}

function status({ runId }) {
  assertRunId(runId)
  const root = taskRoot(runId)
  if (!fs.existsSync(root)) return { exists: false, runId }
  const a = tryAssessOwnership(runId)
  if (a.evidenceState === 'missing') {
    return { exists: true, runId, evidenceState: 'missing', code: a.code, root }
  }
  return {
    exists: true,
    runId,
    evidenceState: 'read',
    datadir: a.expectedData,
    port: a.rec.port,
    pid: a.rec.pid,
    startTime: a.rec.startTime,
    pidState: a.pidProbe.state,
    portState: a.portProbe.state,
    listenerPids: a.portProbe.pids,
    cmdHasDatadirArg: a.cmdHasDatadirArg,
    pidfileMatches: a.pidfileMatches,
    listenerMatches: a.listenerMatches,
    ownEvidence: a.ownEvidence,
    stoppedClean: a.stoppedClean,
    indeterminate: a.indeterminate,
  }
}

function down({ runId }) {
  assertRunId(runId)
  const root = taskRoot(runId)
  if (!fs.existsSync(root)) return { ok: true, removed: false, reason: 'root_missing', runId }
  const a = tryAssessOwnership(runId)
  const manual = { datadir: a.expectedData || path.join(root, 'data'), pid: a.rec ? a.rec.pid : null, port: a.rec ? a.rec.port : null }
  if (a.evidenceState === 'missing') {
    return { ok: false, removed: false, stopped: false, runId, reason: 'ownership_evidence_missing', code: a.code, manual }
  }
  if (a.indeterminate && !a.stoppedClean) {
    return { ok: false, removed: false, stopped: false, runId, reason: 'probe_indeterminate', probes: { pid: a.pidProbe.state, port: a.portProbe.state }, manual }
  }
  if (!a.ownEvidence) {
    // ★ R4：没有完整自有证据时**不自动删除**（也不 stop）。即使记录的旧 PID/端口当前空闲，
    // 也不能推断 data 已安全停止（实例可能以另一 PID/端口在运行）。
    return {
      ok: false, removed: false, stopped: false, runId, reason: 'ownership_evidence_insufficient',
      stoppedCleanObserved: a.stoppedClean, // 仅作观测记录，不构成删除授权
      checks: { pidState: a.pidProbe.state, portState: a.portProbe.state, cmdHasDatadirArg: a.cmdHasDatadirArg, listenerMatches: a.listenerMatches, pidfileMatches: a.pidfileMatches, indeterminate: a.indeterminate },
      manual,
      note: 'no auto-delete without complete own-instance evidence; human handling required',
    }
  }
  // 完整一致的自有实例证据 → 允许一次 stop
  const stop = run('pg_ctl', ['-D', path.join(root, 'data'), 'stop', '-m', 'fast'])
  if (stop.code !== 0) {
    return { ok: false, removed: false, stopped: false, runId, reason: 'stop_failed', stopCode: stop.code, output: (stop.stderr + stop.stdout).slice(0, 200), manual }
  }
  const pidAfter = probePid(a.rec.pid)
  const portAfter = probePort(a.rec.port)
  const processGone = pidAfter.state === 'absent'
  const portReleased = portAfter.state === 'released'
  if (!processGone || !portReleased) {
    return { ok: false, removed: false, stopped: true, runId, reason: 'post_stop_state_not_clear', stopCode: 0, processGone, portReleased, probes: { pid: pidAfter.state, port: portAfter.state }, manual }
  }
  assertInsideTaskRoot(runId, root, { mustExist: true })
  fs.rmSync(root, { recursive: true, force: true })
  return { ok: true, removed: true, stopped: true, stopCode: 0, processGone, portReleased, runId }
}

/**
 * **回放后**租户 GRANT（fixture 契约固化点；R9 决策 #2）。
 * `GRANT ON ALL TABLES IN SCHEMA` 只覆盖"当时已存在"的表——因此必须在版本化链回放**之后**调用；
 * 在空 schema 上预授不构成契约（历史缺口）。
 * @param {{query:Function, role:string, schemas:string[], log?:Function}} args
 */
async function grantPostReplayTenantDml({ query, role, schemas, log = () => {} }) {
  const roleIdent = gate.quoteIdent(role)
  const applied = []
  for (const schema of schemas) {
    const schemaIdent = gate.quoteIdent(schema)
    for (const sql of [
      `GRANT USAGE ON SCHEMA ${schemaIdent} TO ${roleIdent}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaIdent} TO ${roleIdent}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schemaIdent} TO ${roleIdent}`,
    ]) {
      await query(sql)
      applied.push(sql.replace(/\s+/g, ' ').slice(0, 120))
    }
    log(`post-replay GRANT: ${schema} → ${role}（USAGE + DML + 序列）`)
  }
  return applied
}

/** 以**受限测试角色**建立 pg 连接（DML 自证通道；凭据只在本进程内使用）。 */
function createRoleProbeClient({ roleUrl, applicationName }) {
  const { Client } = require('pg')
  return new Client({ connectionString: roleUrl, connectionTimeoutMillis: 8000, application_name: applicationName || 'fixture-role-probe' })
}

/**
 * 受限角色**真实 DML** 自证（SELECT/INSERT/UPDATE/DELETE 逐条真跑；事务内执行并回滚 → 零残留）。
 * 每条语句的 rowCount 单独记录：任何权限缺失都会以 SQLSTATE 42501 失败并被如实上报。
 */
async function runRestrictedRoleDmlProbe({ client, items, log = () => {} }) {
  const out = { tag: items[0]?.label || null, statements: [], error: null, rolledBack: false, ok: false }
  try {
    await client.query('BEGIN')
    for (const it of items) {
      const r = await client.query(it.sql, it.params || [])
      out.statements.push({ label: it.label, rowCount: r.rowCount ?? null })
    }
  } catch (e) {
    out.error = `${e.code || 'ERR'}: ${String(e.message).slice(0, 200)}`
  } finally {
    try { await client.query('ROLLBACK'); out.rolledBack = true } catch (e2) { out.rollbackError = String(e2.message).slice(0, 120) }
  }
  out.ok = out.error === null && out.rolledBack === true && out.statements.length === items.length
  log(`受限角色 DML 探针 ${out.ok ? 'OK' : 'FAIL'}：${out.statements.map((s) => `${s.label}=${s.rowCount}`).join(' ')}${out.error ? ` err=${out.error}` : ''}`)
  return out
}

module.exports = { up, down, status, taskRoot, readOwnership, assessOwnership, tryAssessOwnership, readAdminCredentials, __setRunForTests, probePid, probePort, readPostmasterPidFile, buildPsqlArgv, writePgpassFile, hasDatadirArg, publicInfraChainFiles, publicInfraMigrationStatus, revocationShapeIssues, assertRevocationInfraFromChain, grantPostReplayTenantDml, createRoleProbeClient, runRestrictedRoleDmlProbe }

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv
  const opts = {}
  for (let i = 0; i < rest.length; i += 1) if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1]
  const main = async () => {
    if (cmd === 'up') {
      const r = await up({ runId: opts['run-id'], port: opts.port })
      console.log(JSON.stringify({ ok: true, cmd, contextPath: r.contextPath, envPath: r.envPath, summary: r.summary }, null, 2))
    } else if (cmd === 'down') {
      const r = down({ runId: opts['run-id'] })
      console.log(JSON.stringify({ cmd, ...r }, null, 2))
      if (!r.ok) process.exitCode = 1
    } else if (cmd === 'status') {
      console.log(JSON.stringify({ ok: true, cmd, ...status({ runId: opts['run-id'] }) }, null, 2))
    } else {
      console.error('usage: node tests/isolation/provision.cjs up|down|status --run-id <id> [--port <port>]')
      process.exit(2)
    }
  }
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, cmd, code: e.code || 'UNKNOWN', error: String(e.message).slice(0, 300), detail: e.detail || null }))
    process.exit(1)
  })
}
