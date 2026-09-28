'use strict'
/**
 * P3-W0-T02B-R2 — root 入口 runner 与**严格**观测读取（供门禁回归使用；本身不是测试）。
 *
 * 归属与完整性（R2 复审 §A）：
 *   * 每次运行生成**唯一 run token**，观测路径 `<logDir>/obs-<label>-<token>.net.log` 必须**此前不存在**；
 *   * 读取器逐 PID 校验：boot/event/final 三型、token 全等、每个 boot 恰好一个 final、
 *     final 是该 PID 最后一行、final.events 与 event 行数一致、无外来 token；
 *   * **boot-only / 终结缺失 / 旧日志混入 / 重复终结 / 坏 JSON / 空或缺失** → `valid=false`；绝不返回可信的 0；
 *   * 不做定时快照累加：连接次数 = event 行数（每连接一条）。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const preload = path.join(__dirname, 'net-observer-preload.cjs')

/** 严格观测读取（要求期望 token）。 */
function readObservations(logPath, { token } = {}) {
    const base = { valid: false, invalidReason: null, attempts: 0, bootCount: 0, finalCount: 0, pids: [], hosts: [] }
    if (!token) return { ...base, invalidReason: 'missing_expected_token' }
    if (!logPath || !fs.existsSync(logPath)) return { ...base, invalidReason: 'missing_file' }
    let text
    try { text = fs.readFileSync(logPath, 'utf8') } catch { return { ...base, invalidReason: 'unreadable_file' } }
    if (text.trim() === '') return { ...base, invalidReason: 'empty_file' }
    const rows = []
    let badJson = 0
    for (const line of text.split('\n').filter((l) => l.trim() !== '')) {
        try { rows.push(JSON.parse(line)) } catch { badJson += 1 }
    }
    if (badJson > 0) return { ...base, invalidReason: `bad_json_lines:${badJson}` }
    const foreign = rows.filter((r) => r.token !== token)
    if (foreign.length > 0) return { ...base, invalidReason: `foreign_token_lines:${foreign.length}` }
    const boots = rows.filter((r) => r.kind === 'boot')
    const finals = rows.filter((r) => r.kind === 'final')
    const events = rows.filter((r) => r.kind === 'event')
    if (boots.length === 0) return { ...base, invalidReason: 'no_boot_line' }
    const bootPids = new Set(boots.map((b) => b.pid))
    const finalByPid = new Map()
    for (const f of finals) {
        if (finalByPid.has(f.pid)) return { ...base, invalidReason: `duplicate_final:${f.pid}` }
        finalByPid.set(f.pid, f)
    }
    for (const pid of bootPids) if (!finalByPid.has(pid)) return { ...base, invalidReason: `missing_final:${pid}` }
    for (const pid of finalByPid.keys()) if (!bootPids.has(pid)) return { ...base, invalidReason: `final_without_boot:${pid}` }
    for (const pid of new Set(events.map((e) => e.pid))) if (!bootPids.has(pid)) return { ...base, invalidReason: `event_without_boot:${pid}` }
    for (const pid of bootPids) {
        const pidRows = rows.filter((r) => r.pid === pid)
        if (pidRows[pidRows.length - 1].kind !== 'final') return { ...base, invalidReason: `final_not_last:${pid}` }
        const n = events.filter((e) => e.pid === pid).length
        const declared = finalByPid.get(pid).events
        if (typeof declared !== 'number' || declared !== n) return { ...base, invalidReason: `final_count_mismatch:${pid}:${declared}!=${n}` }
    }
    return {
        valid: true, invalidReason: null,
        attempts: events.length, bootCount: boots.length, finalCount: finals.length,
        pids: [...bootPids].sort((a, b) => a - b), hosts: [...new Set(events.map((e) => e.host).filter(Boolean))],
    }
}

/** 读取 module 装载记录（token 校验；返回命中的模块名）。 */
function readModuleHits(logPath, { token } = {}) {
    if (!logPath || !fs.existsSync(logPath)) return { valid: false, invalidReason: 'missing_module_log', hits: [] }
    let text
    try { text = fs.readFileSync(logPath, 'utf8') } catch { return { valid: false, invalidReason: 'unreadable_module_log', hits: [] } }
    if (text.trim() === '') return { valid: false, invalidReason: 'empty_module_log', hits: [] }
    const hits = []
    let bad = 0
    let boots = 0
    for (const line of text.split('\n').filter((l) => l.trim() !== '')) {
        try {
            const j = JSON.parse(line)
            if (j.token !== token) { bad += 1; continue }
            if (j.kind === 'module_boot') boots += 1
            else if (j.kind === 'module') hits.push(j.module)
        } catch { bad += 1 }
    }
    if (bad > 0) return { valid: false, invalidReason: `bad_or_foreign_module_lines:${bad}`, hits }
    if (boots === 0) return { valid: false, invalidReason: 'no_module_boot_line', hits } // 钩子未生效证明 → invalid
    return { valid: true, invalidReason: null, hits, bootLines: boots }
}

function entryCommand(kind, jestBin) {
    switch (kind) {
        case 'npm_test': return ['npm', ['test', '--', '--runInBand', '--bail=1']]
        case 'jest_config': return [process.execPath, [jestBin, '--config', 'jest.config.cjs', '--runInBand', '--bail=1']]
        case 'direct_p0': return [process.execPath, [jestBin, '--config', 'jest.config.cjs', '--runTestsByPath', 'tests/p0ProvNoAdminInSchool.test.js', '--runInBand']]
        case 'direct_path': return [process.execPath, [jestBin, '--config', 'jest.config.cjs', '--runTestsByPath', process.env.T02B_R2_DIRECT_PATH || 'tests/p0ProvNoAdminInSchool.test.js', '--runInBand']]
        default: throw new Error(`unknown root entry kind: ${kind}`)
    }
}

/**
 * 跑一个真实 root 入口并落盘证据（唯一 token + 独占观测路径）。
 * @returns {{rc, signal, out, obs, moduleHits, token, files, record}}
 */
function runRootEntry({ kind, repoRoot, jestBin, label, logDir, env = {}, failOnDotenv = false, timeoutMs = 300000, extraArgs = [] }) {
    fs.mkdirSync(logDir, { recursive: true })
    const token = crypto.randomBytes(12).toString('hex')
    const netLog = path.join(logDir, `obs-${label}-${token}.net.log`)
    const moduleLog = path.join(logDir, `obs-${label}-${token}.modules.log`)
    if (fs.existsSync(netLog) || fs.existsSync(moduleLog)) {
        throw new Error('[T02B-R2-OBS] observation path already exists; refusing to reuse historical logs')
    }
    const logFile = path.join(logDir, `gate-${label}.log`)
    const rcFile = path.join(logDir, `gate-${label}.rc`)
    const obsFile = path.join(logDir, `gate-${label}.obs.json`)
    const [cmd, args] = entryCommand(kind, jestBin)
    const childEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        T02B_NET_LOG: netLog,
        T02B_RUN_TOKEN: token,
        T02B_MODULE_LOG: moduleLog,
        ...(failOnDotenv ? { T02B_FAIL_ON_DOTENV_ACCESS: '1' } : {}),
        ...env,
    }
    const r = spawnSync(cmd, [...args, ...extraArgs], { cwd: repoRoot, env: childEnv, encoding: 'utf8', timeout: timeoutMs })
    const out = `${r.stdout || ''}\n${r.stderr || ''}`
    const obs = readObservations(netLog, { token })
    const moduleHits = readModuleHits(moduleLog, { token })
    const record = {
        kind, label, token, cmd: `${cmd} ${args.join(' ')} ${extraArgs.join(' ')}`.trim(),
        rc: r.status, signal: r.signal || null, failOnDotenv,
        refusedCode: (out.match(/code=([A-Z_]+)/) || [])[1] || null,
        refusedMarker: /T02A-ISOLATION-REFUSED/.test(out),
        moduleNotFound: /Cannot find module/i.test(out),
        obs, moduleHits,
        observationFiles: { net: path.basename(netLog), modules: path.basename(moduleLog) },
        envKeys: Object.keys(childEnv).filter((k) => !['PATH', 'HOME', 'NODE_OPTIONS'].includes(k)),
    }
    fs.writeFileSync(logFile, out, 'utf8')
    fs.writeFileSync(rcFile, String(r.status === null ? 'null' : r.status) + '\n', 'utf8')
    fs.writeFileSync(obsFile, JSON.stringify(record, null, 2) + '\n', 'utf8')
    return { rc: r.status, signal: r.signal || null, out, obs, moduleHits, token, record, files: { log: logFile, rc: rcFile, obs: obsFile, net: netLog, modules: moduleLog } }
}

module.exports = { readObservations, readModuleHits, runRootEntry, entryCommand, preload }
