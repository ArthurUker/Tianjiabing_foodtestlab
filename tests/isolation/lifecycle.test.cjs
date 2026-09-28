'use strict'
/**
 * P3-W0-T02A-R3 — 生命周期判别回归（L1 三态解析 / L2 归属证据 / L3 启动异常与删除）。
 *
 * 原则：危险分支全部使用**合成目录 + 命令替身**；真实实例仅通过 provision 的安全关闭流程处置；
 * 存在未解决残留 → 写报告并使 suite 非零（由 fixtures/residue-exit-probe.cjs 证明该契约本身）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const provision = require('./provision.cjs')
const { finalizeInstances, writeResidueReport } = require('./lib/instance-finalizer.cjs')

/** 保存旧目录/关键文件基准（存在性/大小/mtime）供 after 比对。 */
function snapshotPath(root) {
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else { const st = fs.statSync(full); files.push({ rel: path.relative(root, full), size: st.size, mtimeMs: st.mtimeMs }) }
    }
  }
  walk(root)
  return { exists: fs.existsSync(root), files: files.sort((a, b) => a.rel.localeCompare(b.rel)) }
}
/** after 与基准比较：目录仍存在且每个关键文件都还在（大小/mtime 不变）。 */
function baselinePreserved(before, root) {
  if (before.exists !== fs.existsSync(root)) return false
  if (!before.exists) return true
  const after = snapshotPath(root)
  if (after.files.length !== before.files.length) return false
  return before.files.every((b, i) => after.files[i].rel === b.rel && after.files[i].size === b.size && after.files[i].mtimeMs === b.mtimeMs)
}

const RUN = (prefix) => `${prefix}${crypto.randomBytes(5).toString('hex')}`
/** ★ R4：逐例观测收集（错误码 / stop 次数 / delete 观测 / 旧目录基准 before-after）。 */
const observations = []
let lastCalls = []
const OBS_FILE = process.env.T02A_R4_OBS_FILE || null
const observe = (entry) => observations.push({ ...entry })
const stopCallsOf = () => lastCalls.filter(([c, a]) => c === 'pg_ctl' && String(a).includes('stop')).length
/** 包装 down：记录返回状态与基准保留情况（不改判定）。 */
function recordDown(runId) {
  const root = provision.taskRoot(runId)
  const before = fs.existsSync(root) ? snapshotPath(root) : null
  const r = provision.down({ runId }) // 真实调用（避免自递归）
  observe({
    kind: 'down', runId, ok: r.ok, reason: r.reason || null,
    stopped: r.stopped === true, removed: r.removed === true, stoppedCleanObserved: r.stoppedCleanObserved ?? null,
    stopCalls: stopCallsOf(), deleteObserved: r.removed === true,
    baselinePreserved: before ? baselinePreserved(before, root) : null,
    manual: !!(r.manual || r.keptForManualHandling),
    checks: r.checks || null,
  })
  return r
}
/** 包装 up：捕获错误并记录收尾观测（不改判定）。 */
async function recordUp(opts) {
  try {
    const ok = await provision.up(opts)
    observe({ kind: 'up', runId: opts.runId, port: opts.port, error: null, stages: ok.summary.stages, removed: null })
    return { ok, err: null }
  } catch (e) {
    observe({
      kind: 'up', runId: opts.runId, port: opts.port,
      error: (e.detail && e.detail.originalError && e.detail.originalError.code) || e.code || 'UNKNOWN',
      stages: (e.detail && e.detail.stages) || null,
      removed: e.detail && e.detail.cleanup ? e.detail.cleanup.removed === true : null,
      zeroStopDelete: e.detail && e.detail.cleanup ? e.detail.cleanup.zeroStopDelete === true : null,
      keepReason: (e.detail && e.detail.cleanup && e.detail.cleanup.keepReason) || null,
      safeShutdownOk: (e.detail && e.detail.cleanup && e.detail.cleanup.safeShutdown) ? e.detail.cleanup.safeShutdown.ok === true : null,
      safeShutdownStopped: (e.detail && e.detail.cleanup && e.detail.cleanup.safeShutdown) ? e.detail.cleanup.safeShutdown.stopped === true : null,
      safeShutdownRemoved: (e.detail && e.detail.cleanup && e.detail.cleanup.safeShutdown) ? e.detail.cleanup.safeShutdown.removed === true : null,
      stopCalls: stopCallsOf(), // 口径：仅统计 injectRun 包装的命令记录；up 的 stop 证据以 safeShutdown* 为准
      manual: !!(e.detail && e.detail.cleanup && (e.detail.cleanup.keptForManualHandling || e.detail.cleanup.manual)),
    })
    return { ok: null, err: e }
  }
}

const synthetic = new Set()
const real = new Set()
const trackRoot = (runId, kind) => { (kind === 'real' ? real : synthetic).add(runId); return provision.taskRoot(runId) }
const FIXTURE_DIR = path.join(__dirname, 'fixtures')

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => { expect(port).not.toBe(5432); resolve(port) }) })
  })
}
/** 合成实例：ownership + postmaster.pid 全字段（startTime 为真实正整数）。 */
function makeSynthetic(runId, overrides = {}) {
  const root = trackRoot(runId, 'syn')
  const data = path.join(root, 'data')
  fs.mkdirSync(data, { recursive: true })
  const startTime = overrides.startTime || Math.floor(Date.now() / 1000)
  const port = overrides.port || 55518
  const pid = overrides.pid || 424242
  const pidfile = {
    pid: overrides.pidfilePid !== undefined ? overrides.pidfilePid : pid,
    datadir: overrides.pidfileDatadir !== undefined ? overrides.pidfileDatadir : path.resolve(data),
    startTime: overrides.pidfileStartTime !== undefined ? overrides.pidfileStartTime : startTime,
    port: overrides.pidfilePort !== undefined ? overrides.pidfilePort : port,
    socketDir: root,
    listenAddr: '127.0.0.1',
    shmem: '1',
  }
  if (overrides.pidfileRaw !== undefined) {
    fs.writeFileSync(path.join(data, 'postmaster.pid'), overrides.pidfileRaw)
  } else {
    fs.writeFileSync(path.join(data, 'postmaster.pid'), `${pidfile.pid}\n${pidfile.datadir}\n${pidfile.startTime}\n${pidfile.port}\n${pidfile.socketDir}\n${pidfile.listenAddr}\n${pidfile.shmem}\n`)
  }
  const rec = { runId, datadir: path.resolve(data), datadirReal: fs.realpathSync(data), port, pid, startTime }
  if (overrides.ownershipMissingFields) for (const k of overrides.ownershipMissingFields) delete rec[k]
  if (overrides.ownershipOverride) Object.assign(rec, overrides.ownershipOverride)
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 })
  return { root, data, rec }
}
/** 注入：默认返回"未预期"（暴露漏配），各用例显式覆盖所需命令。 */
function injectRun(handlers, { realCommands = [] } = {}) {
  const calls = []
  lastCalls = calls
  provision.__setRunForTests((cmd, args, opts) => {
    calls.push([cmd, args.join(' ')])
    if (realCommands.includes(cmd)) {
      const r = spawnSync(cmd, args, { encoding: 'utf8', ...(opts || {}) })
      return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
    }
    const h = handlers[cmd]
    if (typeof h === 'function') return h(args, opts)
    return { code: 2, stdout: '', stderr: `injected:unhandled:${cmd}` }
  })
  return calls
}
afterEach(() => { provision.__setRunForTests(null) })
afterAll(() => {
  for (const runId of synthetic) { const root = provision.taskRoot(runId); if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true }) }
  if (OBS_FILE) {
    try { fs.mkdirSync(path.dirname(OBS_FILE), { recursive: true }); fs.writeFileSync(OBS_FILE, JSON.stringify({ task: 'P3-W0-T02A-R4', note: 'per-case observations (auto-collected; audit source)', observations }, null, 2) + '\n') } catch { /* observation export must not mask test outcome */ }
  }
  const { ok, residue } = finalizeInstances({ runIds: [...real] })
  if (!ok) {
    const file = writeResidueReport(residue)
    throw new Error(`[RESIDUE] ${residue.length} real instance(s) not safely finalised; residue report=${file}`)
  }
})

describe('L1 三态解析（合成；操作次数与目录保留）', () => {
  test('rc=1 + stderr 错误 → unknown（不得当 absent）→ 零 stop、目录保留', () => {
    const runId = RUN('t02a'); const { root } = makeSynthetic(runId)
    const calls = injectRun({ ps: () => ({ code: 1, stdout: '', stderr: 'ps: illegal option' }) })
    const r = recordDown(runId)
    expect(r.ok).toBe(false); expect(r.removed).toBe(false)
    expect(r.reason).toBe('probe_indeterminate')
    expect(r.probes).toEqual({ pid: 'unknown', port: 'unknown' })
    expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
    expect(fs.existsSync(root)).toBe(true)
  })
  test('rc=0 + 空 stdout / 畸形行 / 另一 PID → unknown → 零 stop、目录保留', () => {
    const cases = [
      { ps: () => ({ code: 0, stdout: '', stderr: '' }), lsof: () => ({ code: 0, stdout: '', stderr: '' }) },
      { ps: () => ({ code: 0, stdout: 'not-a-pid-line', stderr: '' }), lsof: () => ({ code: 0, stdout: 'garbage', stderr: '' }) },
      { ps: () => ({ code: 0, stdout: '999999 postgres\n', stderr: '' }), lsof: () => ({ code: 1, stdout: '', stderr: '' }) },
    ]
    for (const handlers of cases) {
      const runId = RUN('t02a'); const { root } = makeSynthetic(runId)
      const calls = injectRun(handlers)
      const r = recordDown(runId)
      expect(r.ok).toBe(false); expect(r.removed).toBe(false)
      expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
      expect(fs.existsSync(root)).toBe(true)
    }
  })
  test('signal / 无状态码 → unknown → 零 stop、目录保留', () => {
    const runId = RUN('t02a'); const { root } = makeSynthetic(runId)
    const calls = injectRun({ ps: () => ({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' }), lsof: () => ({ code: null, signal: null, stdout: '', stderr: '' }) })
    const r = recordDown(runId)
    expect(r.ok).toBe(false); expect(r.removed).toBe(false)
    expect(r.reason).toBe('probe_indeterminate')
    expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
    expect(fs.existsSync(root)).toBe(true)
  })
  test('正对照：完整一致的自有证据 → 进入一次 stop（解析器不是全部拒绝）', () => {
    const runId = RUN('t02a'); const { root, data, rec } = makeSynthetic(runId)
    let psCalls = 0
    let lsofCalls = 0
    const calls = injectRun({
      ps: () => { psCalls += 1; return psCalls === 1 ? { code: 0, stdout: `${rec.pid} postgres -D ${path.resolve(data)} -p ${rec.port}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' } },
      lsof: () => { lsofCalls += 1; return lsofCalls === 1 ? { code: 0, stdout: `${rec.pid}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' } },
      pg_ctl: () => ({ code: 0, stdout: 'server stopped', stderr: '' }),
    })
    const r = recordDown(runId)
    expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(1) // 恰好一次 stop
    // stop 后：ps absent + 端口 released → 允许删除
    expect(r).toMatchObject({ ok: true, removed: true, stopped: true, processGone: true, portReleased: true })
    expect(fs.existsSync(root)).toBe(false)
  })
  test('合法 no-match（记录 PID/端口当前空闲）→ 不再自动删除：零 stop/delete + manual（R4 保守化）', () => {
    const runId = RUN('t02a'); const { root, data } = makeSynthetic(runId)
    const before = snapshotPath(root)
    const calls = injectRun({ ps: () => ({ code: 1, stdout: '', stderr: '' }), lsof: () => ({ code: 1, stdout: '', stderr: '' }) })
    const r = recordDown(runId)
    expect(r.ok).toBe(false)
    expect(r.removed).toBe(false)
    expect(r.stopped).toBe(false)
    expect(r.reason).toBe('ownership_evidence_insufficient')
    expect(r.stoppedCleanObserved).toBe(true) // 观测记录（不构成删除授权）
    expect(r.manual).toBeTruthy()
    expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
    expect(baselinePreserved(before, root)).toBe(true) // 旧目录与关键文件原样保留
    expect(fs.existsSync(path.join(data, 'postmaster.pid'))).toBe(true)
  })

  test('L1-R4：rc=0 + 有效 stdout 但 stderr 非空 → unknown（不得授权归属/删除）', () => {
    const runId = RUN('t02a'); const { root, data, rec } = makeSynthetic(runId)
    const before = snapshotPath(root)
    // 表面完全一致的 present/listening，但两个探测都带 stderr 诊断
    const calls = injectRun({
      ps: () => ({ code: 0, stdout: `${rec.pid} postgres -D ${path.resolve(data)} -p ${rec.port}\n`, stderr: 'ps: warning' }),
      lsof: () => ({ code: 0, stdout: `${rec.pid}\n`, stderr: 'lsof: warning' }),
    })
    const r = recordDown(runId)
    expect(r.ok).toBe(false); expect(r.removed).toBe(false)
    expect(r.reason).toBe('probe_indeterminate')
    expect(r.probes).toEqual({ pid: 'unknown', port: 'unknown' })
    expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
    expect(baselinePreserved(before, root)).toBe(true)
  })

  test('L1-R4：up 端口预检 rc=0 + stderr 非空 → E_PROBE_UNKNOWN（零创建/零启动）', async () => {
    const runId = RUN('t02a')
    const calls = []
    provision.__setRunForTests((cmd, args) => {
      calls.push(cmd)
      if (cmd === 'lsof') return { code: 0, stdout: '123\n', stderr: 'lsof: warning (partial)' }
      return { code: 0, stdout: '', stderr: '' }
    })
    await expect(provision.up({ runId, port: 55527 })).rejects.toMatchObject({ code: 'E_PROBE_UNKNOWN' })
    expect(calls.filter((c) => c === 'initdb' || c === 'pg_ctl')).toEqual([])
    expect(fs.existsSync(provision.taskRoot(runId))).toBe(false)
  })

  test('L1-R4：stop=0 后任一探测 rc=0 + stderr → unknown → 仍保留目录', () => {
    const runId = RUN('t02a'); const { root, data, rec } = makeSynthetic(runId)
    const before = snapshotPath(root)
    let psCalls = 0
    injectRun({
      ps: () => {
        psCalls += 1
        return psCalls === 1
          ? { code: 0, stdout: `${rec.pid} postgres -D ${path.resolve(data)} -p ${rec.port}\n`, stderr: '' }
          : { code: 0, stdout: '', stderr: 'ps: warning after stop' } // rc=0 + stderr → unknown
      },
      lsof: () => ({ code: 0, stdout: `${rec.pid}\n`, stderr: '' }),
      pg_ctl: () => ({ code: 0, stdout: 'server stopped', stderr: '' }),
    })
    const r = recordDown(runId)
    expect(r.ok).toBe(false); expect(r.removed).toBe(false); expect(r.stopped).toBe(true)
    expect(r.reason).toBe('post_stop_state_not_clear')
    expect(baselinePreserved(before, root)).toBe(true)
  })

  test('L1-R4：spawn_error / signal → unknown → 零 stop/delete + 目录保留', () => {
    for (const probeReturn of [{ code: null, stdout: '', stderr: '', signal: null, error: 'ENOENT' }, { code: null, stdout: '', stderr: '', signal: 'SIGKILL', error: null }]) {
      const runId = RUN('t02a'); const { root } = makeSynthetic(runId)
      const before = snapshotPath(root)
      const calls = injectRun({ ps: () => probeReturn, lsof: () => probeReturn })
      const r = recordDown(runId)
      expect(r.ok).toBe(false); expect(r.removed).toBe(false)
      expect(r.reason).toBe('probe_indeterminate')
      expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
      expect(baselinePreserved(before, root)).toBe(true)
    }
  })
  test('stop=0 后状态未知 → removed=false（不得借 stop 成功代替复验）', () => {
    const runId = RUN('t02a'); const { root, data, rec } = makeSynthetic(runId)
    let psCalls = 0
    injectRun({
      ps: () => { psCalls += 1; return psCalls === 1 ? { code: 0, stdout: `${rec.pid} postgres -D ${path.resolve(data)} -p ${rec.port}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' } },
      lsof: () => ({ code: 0, stdout: `${rec.pid}\n`, stderr: '' }),
      pg_ctl: () => ({ code: 0, stdout: 'server stopped', stderr: '' }),
    })
    const r = recordDown(runId)
    expect(r.ok).toBe(false); expect(r.removed).toBe(false); expect(r.stopped).toBe(true)
    expect(r.reason).toBe('post_stop_state_not_clear')
    expect(fs.existsSync(root)).toBe(true)
  })
})

describe('L2 归属证据（零 stop / 零 delete；在记录 PID/端口 no-match 条件下注入）', () => {
  // 复审要求的可达条件：对**记录的** PID 与端口都是平台 no-match。
  // 若无 L2 修复，pidfile 不一致会被 stoppedClean 掩盖并触发删除；现在必须零 stop/delete。
  const noMatch = () => ({
    ps: () => ({ code: 1, stdout: '', stderr: '' }),
    lsof: () => ({ code: 1, stdout: '', stderr: '' }),
  })
  test.each([
    ['PID 不符', { pidfilePid: 999999 }],
    ['datadir 不符', { pidfileDatadir: '/tmp/other-instance/data' }],
    ['startTime 不符', { pidfileStartTime: 1 }],
    ['port 不符', { pidfilePort: 5433 }],
  ])('no-match 条件下 pidfile %s → 零 stop/delete + 旧目录/文件基准保留', (_label, overrides) => {
    const runId = RUN('t02a'); const { root, data } = makeSynthetic(runId, overrides)
    const before = snapshotPath(root)
    const calls = injectRun(noMatch())
    const r = recordDown(runId)
    expect(r.ok).toBe(false); expect(r.removed).toBe(false); expect(r.stopped).toBe(false)
    expect(r.reason).toBe('ownership_evidence_insufficient')
    expect(r.stoppedCleanObserved).toBe(true) // 观测到"记录值当前空闲"，但**不作为**删除授权
    expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
    expect(baselinePreserved(before, root)).toBe(true)
    expect(fs.existsSync(path.join(data, 'postmaster.pid'))).toBe(true)
  })
  test('ownership.datadir / datadirReal 矛盾、跨路径或缺失 → 拒绝（零 stop/delete + 基准保留）', () => {
    const cases = [
      { ownershipOverride: { datadir: '/tmp/elsewhere/data' } },        // 原始 datadir 指向别处
      { ownershipOverride: { datadirReal: '/tmp/elsewhere/data' } },    // realpath 指向别处
      { ownershipMissingFields: ['datadirReal'] },                      // 缺 datadirReal
      { ownershipMissingFields: ['datadir'] },                          // 缺 datadir
    ]
    for (const overrides of cases) {
      const runId = RUN('t02a'); const { root } = makeSynthetic(runId, overrides)
      const before = snapshotPath(root)
      const calls = injectRun(noMatch())
      const r = recordDown(runId)
      expect(r.ok).toBe(false); expect(r.removed).toBe(false)
      expect(r.reason).toBe('ownership_evidence_missing')
      expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
      expect(baselinePreserved(before, root)).toBe(true)
    }
  })
  test('ownership 缺字段（startTime/port/pid）→ 零 stop/delete + 基准保留', () => {
    for (const missing of [['startTime'], ['port'], ['pid'], ['startTime', 'port']]) {
      const runId = RUN('t02a'); const { root } = makeSynthetic(runId, { ownershipMissingFields: missing })
      const before = snapshotPath(root)
      const calls = injectRun(noMatch())
      const r = recordDown(runId)
      expect(r.ok).toBe(false); expect(r.removed).toBe(false)
      expect(r.reason).toBe('ownership_evidence_missing')
      expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
      expect(baselinePreserved(before, root)).toBe(true)
    }
  })
  test('pidfile 畸形（空 startTime / 畸形 port / 截断）+ no-match → 零 stop/delete + 基准保留', () => {
    for (const raw of [`424242\n/tmp/x\n\n55518\n/x\n`, `424242\n/tmp/x\n1700000000\nnotaport\n/x\n`, `424242\n/tmp/x\n`]) {
      const runId = RUN('t02a'); const { root } = makeSynthetic(runId, { pidfileRaw: raw })
      const before = snapshotPath(root)
      const calls = injectRun(noMatch())
      const r = recordDown(runId)
      expect(r.ok).toBe(false); expect(r.removed).toBe(false)
      expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
      expect(baselinePreserved(before, root)).toBe(true)
    }
  })
  test('完整一致自有证据 + stop 失败 → 恰好一次 stop、禁止删除、基准保留', () => {
    const runId = RUN('t02a'); const { root, data, rec } = makeSynthetic(runId)
    const before = snapshotPath(root)
    let stopCalls = 0
    const calls = injectRun({
      'pg_ctl': () => { stopCalls += 1; return { code: 5, stdout: '', stderr: 'injected stop failure' } },
      ps: () => ({ code: 0, stdout: `${rec.pid} postgres -D ${path.resolve(data)} -p ${rec.port}\n`, stderr: '' }),
      lsof: () => ({ code: 0, stdout: `${rec.pid}\n`, stderr: '' }),
    })
    const r = recordDown(runId)
    expect(stopCalls).toBe(1)
    expect(r).toMatchObject({ ok: false, removed: false, stopped: false, reason: 'stop_failed', stopCode: 5 })
    expect(calls.filter(([c, a]) => c === 'pg_ctl' && String(a).includes('stop')).length).toBe(1)
    expect(baselinePreserved(before, root)).toBe(true)
  })
  test('路径前缀碰撞（-D /x/data-extra vs /x/data）→ 不算自有证据 → 零 stop + 基准保留', () => {
    const runId = RUN('t02a'); const { root, data, rec } = makeSynthetic(runId)
    const before = snapshotPath(root)
    const calls = injectRun({
      ps: () => ({ code: 0, stdout: `${rec.pid} postgres -D ${path.resolve(data)}-extra -p ${rec.port}\n`, stderr: '' }),
      lsof: () => ({ code: 0, stdout: `${rec.pid}\n`, stderr: '' }),
    })
    const r = recordDown(runId)
    expect(r.ok).toBe(false)
    expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
    expect(baselinePreserved(before, root)).toBe(true)
  })
})

describe('L3 启动异常与删除（合成）', () => {
  test('start 非零 + 无 pidfile + 端口空闲 → 零 stop/delete、保留目录 + manual 信息', async () => {
    const runId = RUN('t02a')
    const root = trackRoot(runId, 'syn')
    const port = await freePort()
    let pgctlStartCalls = 0
    const calls = injectRun({
      'pg_ctl': (args) => { if (args.includes('start')) { pgctlStartCalls += 1; return { code: 7, stdout: '', stderr: 'injected start failure' } } return { code: 4, stdout: '', stderr: 'injected stop (must not be called)' } },
      ps: () => ({ code: 1, stdout: '', stderr: '' }), // 无进程
      lsof: () => ({ code: 1, stdout: '', stderr: '' }), // 端口空闲
    }, { realCommands: ['initdb'] })
    const upRes = await recordUp({ runId, port })
    const err = upRes.err
    expect(err).not.toBeNull()
    expect(err.code).toBe('E_UP_FAILED')
    expect(err.detail.stages).toContain('start_attempted')
    expect(err.detail.stages).not.toContain('started_instance')
    expect(err.detail.cleanup.zeroStopDelete).toBe(true)
    expect(err.detail.cleanup.removed).toBe(false)
    expect(err.detail.cleanup.keptForManualHandling).toBeTruthy()
    expect(pgctlStartCalls).toBe(1)
    expect(calls.filter(([c, a]) => c === 'pg_ctl' && String(a).includes('stop')).length).toBe(0) // 零 stop
    expect(fs.existsSync(root)).toBe(true) // 目录保留
  })
  test('仅有外来监听者（非自有实例）→ 零 stop、保留目录 + 记录 foreign 监听者', async () => {
    const runId = RUN('t02a')
    trackRoot(runId, 'syn')
    const port = await freePort()
    const foreignPid = 31337
    let lsofCalls = 0
    const calls = injectRun({
      'pg_ctl': (args) => (args.includes('start') ? { code: 6, stdout: '', stderr: 'injected start failure' } : { code: 4, stdout: '', stderr: 'injected stop (must not be called)' }),
      ps: () => ({ code: 1, stdout: '', stderr: '' }), // 我们记录的 PID 不存在
      lsof: () => { lsofCalls += 1; return lsofCalls === 1 ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: `${foreignPid}\n`, stderr: '' } }, // 预检空闲 → 之后被外来者监听
    }, { realCommands: ['initdb'] })
    const upRes = await recordUp({ runId, port })
    const err = upRes.err
    expect(err).not.toBeNull()
    expect(err.detail.cleanup.removed).toBe(false)
    expect(err.detail.cleanup.keptForManualHandling).toBeTruthy()
    expect(calls.filter(([c, a]) => c === 'pg_ctl' && String(a).includes('stop')).length).toBe(0) // 绝不对未知监听者 stop
    expect(fs.existsSync(provision.taskRoot(runId))).toBe(true)
  })
  test('完整自有证据但 stop 失败 → 允许一次 stop、禁止删除、保留现场', async () => {
    const runId = RUN('t02a')
    const root = trackRoot(runId, 'syn')
    const port = await freePort()
    const { data, rec } = makeSynthetic(runId, { port, pid: 424242 })
    let stopCalls = 0
    const calls = injectRun({
      'pg_ctl': () => { stopCalls += 1; return { code: 5, stdout: '', stderr: 'injected stop failure' } },
      ps: () => ({ code: 0, stdout: `${rec.pid} postgres -D ${path.resolve(data)} -p ${rec.port}\n`, stderr: '' }),
      lsof: () => ({ code: 0, stdout: `${rec.pid}\n`, stderr: '' }),
    })
    const r = recordDown(runId)
    expect(stopCalls).toBe(1) // 恰好一次 stop（允许）
    expect(r).toMatchObject({ ok: false, removed: false, stopped: false, reason: 'stop_failed', stopCode: 5 })
    expect(calls.filter(([c, a]) => c === 'pg_ctl' && String(a).includes('stop')).length).toBe(1)
    expect(fs.existsSync(root)).toBe(true) // 禁止删除
  })
  test('R4：start_attempted 后无 ownership（伪造 pidfile/ps/lsof 表面一致）→ 零 stop/delete + 保留现场', async () => {
    const runId = RUN('t02a')
    const root = trackRoot(runId, 'syn')
    const port = await freePort()
    let lsofCalls = 0
    const calls = injectRun({
      'pg_ctl': (args) => (args.includes('start') ? { code: 6, stdout: '', stderr: 'injected start failure' } : { code: 4, stdout: '', stderr: 'stop must not be called' }),
      // 伪造：ps 声称任务 data 有进程、lsof 声称端口有监听（但 ownership 从未写入）
      ps: () => ({ code: 0, stdout: `424242 postgres -D ${path.resolve(root, 'data')} -p ${port}\n`, stderr: '' }),
      lsof: () => { lsofCalls += 1; return lsofCalls === 1 ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '424242\n', stderr: '' } },
    }, { realCommands: ['initdb'] })
    const upRes = await recordUp({ runId, port })
    const err = upRes.err
    expect(err).not.toBeNull()
    expect(err.code).toBe('E_UP_FAILED')
    expect(err.detail.stages).toContain('start_attempted')
    expect(err.detail.cleanup.removed).toBe(false)
    expect(err.detail.cleanup.zeroStopDelete).toBe(true)
    expect(err.detail.cleanup.keepReason).toBe('ownership_evidence_missing')
    expect(err.detail.cleanup.keptForManualHandling).toBeTruthy()
    expect(calls.filter(([c, a]) => c === 'pg_ctl' && String(a).includes('stop')).length).toBe(0) // 绝不对伪造一致者 stop
    expect(fs.existsSync(root)).toBe(true)
  })

  test('R4：ownership 与 pidfile 不符（伪造 ps/lsof 表面一致）→ 零 stop/delete + 基准保留', () => {
    const runId = RUN('t02a'); const { root, data, rec } = makeSynthetic(runId, { pidfilePort: 5433 }) // pidfile 端口与 ownership 不符
    const before = snapshotPath(root)
    const calls = injectRun({
      ps: () => ({ code: 0, stdout: `${rec.pid} postgres -D ${path.resolve(data)} -p ${rec.port}\n`, stderr: '' }),
      lsof: () => ({ code: 0, stdout: `${rec.pid}\n`, stderr: '' }),
    })
    const r = recordDown(runId)
    expect(r.ok).toBe(false); expect(r.removed).toBe(false); expect(r.stopped).toBe(false)
    expect(r.reason).toBe('ownership_evidence_insufficient')
    expect(r.checks.pidfileMatches).toBe(false)
    expect(calls.filter(([c]) => c === 'pg_ctl').length).toBe(0)
    expect(baselinePreserved(before, root)).toBe(true)
  })

})

describe('L3 真实实例（up/status/down 全条件 + 单一归属判定）', () => {
  test('真实 up → status 输出实际探测字段且 ownEvidence=true → down 全条件满足才删除', async () => {
    const runId = RUN('t02a')
    const root = trackRoot(runId, 'real')
    const port = await freePort()
    const up = (await recordUp({ runId, port })).ok
    expect(up.summary.stages).toContain('context_written')
    const st = provision.status({ runId })
    expect(st).toMatchObject({ exists: true, evidenceState: 'read', ownEvidence: true, pidfileMatches: true, listenerMatches: true, cmdHasDatadirArg: true, pidState: 'present', portState: 'listening' })
    expect(Number.isInteger(st.startTime)).toBe(true)
    const down = provision.down({ runId })
    expect(down).toMatchObject({ ok: true, stopped: true, removed: true, processGone: true, portReleased: true, stopCode: 0 })
    expect(fs.existsSync(root)).toBe(false)
    real.delete(runId)
  }, 120000)
  test('真实：trigger 阶段失败 → 完整 ownership → 安全 stop + 复验后删除（原始错误保留）', async () => {
    const runId = RUN('t02a')
    const root = trackRoot(runId, 'real')
    const port = await freePort()
    let sawRealStart = false
    provision.__setRunForTests((cmd, args, opts) => {
      if (cmd === 'psql' && args.includes('-f')) return { code: 3, stdout: '', stderr: 'injected trigger failure' }
      const r = spawnSync(cmd, args, { encoding: 'utf8', ...(opts || {}) })
      if (cmd === 'pg_ctl' && args.includes('start') && r.status === 0) sawRealStart = true
      return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
    })
    const upRes = await recordUp({ runId, port })
    const err = upRes.err
    expect(err).not.toBeNull()
    expect(err.code).toBe('E_UP_FAILED')
    expect(err.detail.originalError.code).toBe('E_TRIGGER_SQL') // 原始 up 错误保留
    expect(err.detail.stages).toContain('started_instance')
    expect(err.detail.stages).toContain('wrote_ownership')
    expect(err.detail.cleanup.safeShutdown).toBeTruthy() // 统一归属判定被调用
    expect(err.detail.cleanup.safeShutdown.ok).toBe(true)
    expect(err.detail.cleanup.stopped).toBe(true)
    expect(err.detail.cleanup.removed).toBe(true)
    expect(sawRealStart).toBe(true) // 真实启动了实例
    expect(fs.existsSync(root)).toBe(false) // stop + 复验（进程消失 + 端口释放）后才删除
    real.delete(runId)
  }, 120000)

})

describe('L3 收尾契约（残留必须使整体非零；合成子进程）', () => {
  test('fixture：clean → rc=0；residue → rc≠0 且输出残留计数', () => {
    const probe = path.join(FIXTURE_DIR, 'residue-exit-probe.cjs')
    expect(fs.existsSync(probe)).toBe(true)
    const clean = spawnSync(process.execPath, [probe, 'clean'], { encoding: 'utf8', timeout: 20000 })
    expect(clean.status).toBe(0)
    const residue = spawnSync(process.execPath, [probe, 'residue'], { encoding: 'utf8', timeout: 20000 })
    expect(residue.status).not.toBe(0)
    const parsed = JSON.parse((residue.stdout || '').trim().split('\n').pop())
    expect(parsed.residueCount).toBeGreaterThanOrEqual(1)
    expect(parsed.reportFile).toBeTruthy()
    if (parsed.reportFile && fs.existsSync(parsed.reportFile)) fs.rmSync(parsed.reportFile, { force: true })
  })
})
