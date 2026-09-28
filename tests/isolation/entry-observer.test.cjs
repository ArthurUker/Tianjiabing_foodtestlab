'use strict'
/**
 * P3-W0-T02A-R2 — 入口（Jest setupFiles）的**可观察连接边界**回归。
 *
 * 子进程中先安装连接观测器，再加载真实 setup 文件（tests/helpers/db-isolation-setup.cjs）：
 *   * 缺配置 / 配置冲突 → setup 抛错且**连接尝试 = 0**（可观察事实，而非"没有 ECONNREFUSED"）；
 *   * 合法配置正对照 → setup 通过，随后测试侧发起一次**回环死端口**连接尝试（127.0.0.1:1），
 *     观测器必须记录 ≥1 次（证明观测有效）；不访问任何业务地址。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const gate = require('../helpers/db-isolation.cjs')

const here = __dirname
const observerPath = path.join(here, '../helpers/connection-observer.cjs')
const setupPath = path.join(here, '../helpers/db-isolation-setup.cjs')
const tmpDirs = []
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })

function runChild({ env, probeAfterSetup = false }) {
    const script = `
const obs = require(${JSON.stringify(observerPath)})
obs.install()
const out = { attempts: 0, setupThrew: false, setupCode: null, setupPassed: false, probeAttempted: false }
try { require(${JSON.stringify(setupPath)}); out.setupPassed = true }
catch (e) { out.setupThrew = true; const m = /code=([A-Z_]+)/.exec((e && e.message) || ''); out.setupCode = (e && e.code) || (m && m[1]) || 'THROWN' }
if (${probeAfterSetup ? 'true' : 'false'} && out.setupPassed) {
  const net = require('node:net')
  const s = net.connect({ host: '127.0.0.1', port: 1 })
  out.probeAttempted = true
  const done = () => { out.attempts = obs.observed().length; console.log(JSON.stringify(out)); process.exit(0) }
  s.on('error', done)
  setTimeout(done, 1500)
} else {
  out.attempts = obs.observed().length
  console.log(JSON.stringify(out))
}
`
    const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 20000 })
    const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop()
    return { rc: r.status, parsed: line ? JSON.parse(line) : null, raw: (r.stderr || '').slice(0, 160) }
}

const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME })

describe('入口零连接（可观察边界）与正对照', () => {
    test('缺配置 → setup 抛 MISSING_TEST_URL 且连接尝试 = 0', () => {
        const r = runChild({ env: baseEnv() })
        expect(r.parsed).not.toBeNull()
        expect(r.parsed.setupThrew).toBe(true)
        expect(r.parsed.setupCode).toBe('MISSING_TEST_URL')
        expect(r.parsed.attempts).toBe(0)
    })

    test('配置冲突（URL 与 context 不符）→ setup 抛 URL_MISMATCH 且连接尝试 = 0', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't02ar2-entry-'))
        tmpDirs.push(dir)
        const runId = `t02a${crypto.randomBytes(4).toString('hex')}`
        const d = gate.derivedNamespace(runId)
        const ctxFile = path.join(dir, 'context.json')
        fs.writeFileSync(ctxFile, JSON.stringify({
            task: 'P3-W0-T02A', runId,
            instance: { host: '127.0.0.1', port: 55520, database: d.database, role: d.role, instanceTag: d.instanceTag, markerTable: d.markerTable },
            allowedSchemas: d.allowedSchemas, allowedFixtureObjects: d.fixtureObjects.slice(),
            tenants: d.tenants, roleAudit: d.roleAudit,
        }))
        const r = runChild({ env: { ...baseEnv(), TEST_DB_CONTEXT_FILE: ctxFile, TEST_DATABASE_URL: `postgresql://${d.role}:x@127.0.0.1:59999/other_db` } })
        expect(r.parsed.setupThrew).toBe(true)
        expect(r.parsed.setupCode).toBe('URL_MISMATCH')
        expect(r.parsed.attempts).toBe(0)
    })

    test('正对照：合法配置 setup 通过；测试侧回环死端口连接被观测到（≥1），且无业务地址尝试', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't02ar2-entry-ok-'))
        tmpDirs.push(dir)
        const runId = `t02a${crypto.randomBytes(4).toString('hex')}`
        const d = gate.derivedNamespace(runId)
        const ctxFile = path.join(dir, 'context.json')
        fs.writeFileSync(ctxFile, JSON.stringify({
            task: 'P3-W0-T02A', runId,
            instance: { host: '127.0.0.1', port: 55520, database: d.database, role: d.role, instanceTag: d.instanceTag, markerTable: d.markerTable },
            allowedSchemas: d.allowedSchemas, allowedFixtureObjects: d.fixtureObjects.slice(),
            tenants: d.tenants, roleAudit: d.roleAudit,
        }))
        const r = runChild({
            env: { ...baseEnv(), TEST_DB_CONTEXT_FILE: ctxFile, TEST_DATABASE_URL: `postgresql://${d.role}:x@127.0.0.1:55520/${d.database}` },
            probeAfterSetup: true,
        })
        expect(r.parsed.setupPassed).toBe(true)
        expect(r.parsed.attempts).toBeGreaterThanOrEqual(1) // 观测器有效（命中真实连接边界）
        expect(r.parsed.probeAttempted).toBe(true)
    })
})
