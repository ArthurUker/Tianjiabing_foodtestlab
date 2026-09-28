'use strict'
/**
 * P3-W0-T02B-R2 — root 前置拒绝与观测**归属/完整性**自证（子进程跑真实 root 入口）。
 *
 * R2 重点（复审 §A）：
 *   * 每次运行唯一 run token + 独占观测路径；读取器逐 PID 校验 boot→final 完整性、token 全等、计数一致；
 *   * boot-only / 终结缺失 / 旧日志混入 / 重复终结 / final 非末行 / 计数不一致 / 坏 JSON / 空或缺失 → **invalid**；
 *   * 观测钩子正对照：module canary 命中；dotenv fail-on-access 在读取受控路径前抛 `T02B_DOTENV_ACCESS`（不读真实 .env）；
 *   * 三入口（npm test / jest --config / 直跑 p0）与配置负例逐例落盘 rc/输出/观测。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const gate = require('../helpers/db-isolation.cjs')
const { runRootEntry, readObservations, readModuleHits } = require('./lib/root-entry-runner.cjs')

const repoRoot = path.resolve(__dirname, '../..')
const jestBin = path.join(repoRoot, 'node_modules', '.bin', 'jest')
const preload = path.join(__dirname, 'lib', 'net-observer-preload.cjs')
const OUT_DIR = process.env.T02B_R2_LOG_DIR || path.join(os.tmpdir(), 't02b-r2-gate')
const tmpDirs = []
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }) })
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d }

// ── A1 观测器归属与完整性（合成；不触达实例）──
describe('A1 · 观测归属与完整性（token/PID/boot→final）', () => {
    /** 在合成子进程里产生 N 次已知回环连接。 */
    const runLoopbackChild = (n, { token = `tok-${crypto.randomBytes(6).toString('hex')}`, withFinal = true, externalWrite = null, extraLines = [] } = {}) => {
        const dir = mkTmp('t02b-r2-obs-')
        const netLog = path.join(dir, 'obs.net.log')
        const script = `
const net = require('node:net')
const srv = net.createServer((sock) => sock.end())
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port
  let remaining = ${n}
  const next = () => {
    if (remaining === 0) { srv.close(() => process.exit(0)); return }
    remaining -= 1
    const c = net.connect({ host: '127.0.0.1', port }, () => { c.end(); setTimeout(next, 5) })
    c.on('error', () => process.exit(5))
  }
  next()
})
`
        const env = {
            PATH: process.env.PATH, HOME: process.env.HOME,
            NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            T02B_NET_LOG: netLog, T02B_RUN_TOKEN: token,
        }
        if (!withFinal) env.T02B_SUPPRESS_FINAL = '1'
        const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000, env: { ...env, ...(externalWrite ? { __IGNORE: '' } : {}) } })
        if (externalWrite) fs.appendFileSync(netLog, externalWrite)
        for (const l of extraLines) fs.appendFileSync(netLog, l + '\n')
        return { r, netLog, token, dir }
    }

    test('正对照：合成回环恰好 2 次连接 → valid=true、attempts=2、token/PID 一致', () => {
        const { r, netLog, token } = runLoopbackChild(2)
        expect(r.status).toBe(0)
        const obs = readObservations(netLog, { token })
        expect(obs).toMatchObject({ valid: true, attempts: 2, bootCount: 1, finalCount: 1 })
        expect(obs.pids.length).toBe(1)
        expect(obs.hosts).toEqual(['127.0.0.1'])
    }, 60000)

    test('boot-only / 终结缺失 → invalid（不得当 0 次）', () => {
        const { netLog, token } = runLoopbackChild(1)
        const lines = fs.readFileSync(netLog, 'utf8').split('\n').filter(Boolean)
        const bootOnly = lines.filter((l) => JSON.parse(l).kind !== 'final')
        const p = path.join(path.dirname(netLog), 'boot-only.log')
        fs.writeFileSync(p, bootOnly.join('\n') + '\n')
        expect(readObservations(p, { token })).toMatchObject({ valid: false })
        expect(readObservations(p, { token }).invalidReason).toMatch(/missing_final/)
    })

    test('旧日志混入（外来 token）/ 重复终结 / final 非末行 / 计数不一致 → invalid', () => {
        const { netLog, token } = runLoopbackChild(1)
        const rows = fs.readFileSync(netLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        const boot = rows.find((x) => x.kind === 'boot')
        const final = rows.find((x) => x.kind === 'final')
        const dir = path.dirname(netLog)

        // 旧日志混入（另一 token 的完整 boot+final）
        const foreign = path.join(dir, 'foreign.log')
        fs.writeFileSync(foreign, [boot, final].map((x) => JSON.stringify({ ...x, token: 'stale-token' })).join('\n') + '\n')
        expect(readObservations(foreign, { token }).invalidReason).toMatch(/foreign_token_lines/)

        // 重复终结
        const dup = path.join(dir, 'dup.log')
        fs.writeFileSync(dup, [...rows, final].map((x) => JSON.stringify(x)).join('\n') + '\n')
        expect(readObservations(dup, { token }).invalidReason).toMatch(/duplicate_final/)

        // final 非末行
        const notLast = path.join(dir, 'notlast.log')
        const ev = rows.find((x) => x.kind === 'event')
        fs.writeFileSync(notLast, [boot, final, ev].map((x) => JSON.stringify(x)).join('\n') + '\n')
        const r1 = readObservations(notLast, { token })
        expect(r1.valid).toBe(false)
        expect(r1.invalidReason).toMatch(/final_not_last|final_count_mismatch/)

        // 计数不一致（final.events 与 event 行数不符）
        const mismatch = path.join(dir, 'mismatch.log')
        fs.writeFileSync(mismatch, [boot, ev, { ...final, events: 99 }].map((x) => JSON.stringify(x)).join('\n') + '\n')
        expect(readObservations(mismatch, { token }).invalidReason).toMatch(/final_count_mismatch/)
    })

    test('坏 JSON / 空文件 / 缺文件 / 缺少期望 token → invalid', () => {
        const dir = mkTmp('t02b-r2-obs-bad-')
        const bad = path.join(dir, 'bad.log'); fs.writeFileSync(bad, '{"kind":"boot"}\nNOT-JSON\n')
        const empty = path.join(dir, 'empty.log'); fs.writeFileSync(empty, '  \n')
        expect(readObservations(bad, { token: 'x' }).invalidReason).toMatch(/bad_json_lines/)
        expect(readObservations(empty, { token: 'x' }).invalidReason).toBe('empty_file')
        expect(readObservations(path.join(dir, 'none.log'), { token: 'x' }).invalidReason).toBe('missing_file')
        expect(readObservations(bad, {}).invalidReason).toBe('missing_expected_token')
    })

    test('异常退出（无 final）→ invalid：受控 SIGKILL 实测', () => {
        const dir = mkTmp('t02b-r2-obs-kill-')
        const netLog = path.join(dir, 'kill.log')
        const token = `tok-${crypto.randomBytes(6).toString('hex')}`
        const script = `
const net = require('node:net')
const srv = net.createServer((s) => s.end())
srv.listen(0, '127.0.0.1', () => {
  const c = net.connect({ host: '127.0.0.1', port: srv.address().port })
  c.on('connect', () => { process.kill(process.pid, 'SIGKILL') })
})
`
        spawnSync(process.execPath, ['-e', script], {
            encoding: 'utf8', timeout: 30000,
            env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, T02B_NET_LOG: netLog, T02B_RUN_TOKEN: token },
        })
        const obs = readObservations(netLog, { token })
        expect(obs.valid).toBe(false)
        expect(obs.invalidReason).toMatch(/missing_final/)
    }, 60000)
})

// ── A2 三种真实 root 入口 + 配置负例（逐例落盘；独占观测）──
describe('A2 · 真实 root 入口的缺/错配置拒绝', () => {
    const cases = [
        { kind: 'npm_test', label: 'npm-test-missing-config', expect: 'MISSING_TEST_URL' },
        { kind: 'jest_config', label: 'jest-config-missing-config', expect: 'MISSING_TEST_URL' },
        { kind: 'direct_p0', label: 'direct-p0-missing-config', expect: 'MISSING_TEST_URL' },
    ]
    for (const c of cases) {
        test(`${c.kind} 缺配置 → 非零 + ${c.expect} + 独占观测 valid 且连接=0`, () => {
            const r = runRootEntry({ kind: c.kind, repoRoot, jestBin, label: c.label, logDir: OUT_DIR })
            expect(r.rc).not.toBe(0)
            expect(r.record.refusedMarker).toBe(true)
            expect(r.record.refusedCode).toBe(c.expect)
            expect(r.record.moduleNotFound).toBe(false)
            expect(r.obs.valid).toBe(true)
            expect(r.obs.attempts).toBe(0)
            expect(r.obs.pids.length).toBeGreaterThanOrEqual(1) // 本次子进程 PID 有 boot+final
            expect(r.record.token).toBe(r.token) // 归属 token 落盘
        }, 300000)
    }

    const ctxDir = () => {
        const dir = mkTmp('t02b-r2-ctx-')
        const runId = `t02b${crypto.randomBytes(4).toString('hex')}`
        const d = gate.derivedNamespace(runId)
        const file = path.join(dir, 'context.json')
        fs.writeFileSync(file, JSON.stringify({
            task: 'P3-W0-T02A', runId,
            instance: { host: '127.0.0.1', port: 55536, database: d.database, role: d.role, instanceTag: d.instanceTag, markerTable: d.markerTable },
            allowedSchemas: d.allowedSchemas, allowedFixtureObjects: d.fixtureObjects.slice(),
            tenants: d.tenants, roleAudit: d.roleAudit,
        }))
        return { file, d }
    }

    test('仅普通 DATABASE_URL → MISSING_TEST_URL + 观测 valid 且连接=0', () => {
        const r = runRootEntry({ kind: 'direct_p0', repoRoot, jestBin, label: 'direct-p0-only-database-url', logDir: OUT_DIR, env: { DATABASE_URL: 'postgresql://someone:else@127.0.0.1:5432/some_db' } })
        expect(r.rc).not.toBe(0)
        expect(r.record.refusedCode).toBe('MISSING_TEST_URL')
        expect(r.obs.valid).toBe(true)
        expect(r.obs.attempts).toBe(0)
    }, 300000)

    test('缺 context → MISSING_CONTEXT + 观测 valid 且连接=0', () => {
        const { d } = ctxDir()
        const r = runRootEntry({ kind: 'direct_p0', repoRoot, jestBin, label: 'direct-p0-missing-context', logDir: OUT_DIR, env: { TEST_DATABASE_URL: `postgresql://${d.role}:x@127.0.0.1:55536/${d.database}` } })
        expect(r.rc).not.toBe(0)
        expect(r.record.refusedCode).toBe('MISSING_CONTEXT')
        expect(r.obs.valid).toBe(true)
        expect(r.obs.attempts).toBe(0)
    }, 300000)

    test('URL/context 冲突 → URL_MISMATCH + 观测 valid 且连接=0', () => {
        const { file, d } = ctxDir()
        const r = runRootEntry({ kind: 'direct_p0', repoRoot, jestBin, label: 'direct-p0-url-mismatch', logDir: OUT_DIR, env: { TEST_DB_CONTEXT_FILE: file, TEST_DATABASE_URL: `postgresql://${d.role}:x@127.0.0.1:59993/other_db` } })
        expect(r.rc).not.toBe(0)
        expect(r.record.refusedCode).toBe('URL_MISMATCH')
        expect(r.obs.valid).toBe(true)
        expect(r.obs.attempts).toBe(0)
    }, 300000)

    test('dotenv fail-on-access：负例仍以显式配置拒绝码结束（未采用旧 .env）', () => {
        const r = runRootEntry({ kind: 'direct_p0', repoRoot, jestBin, label: 'direct-p0-dotenv-fail-on-access', logDir: OUT_DIR, failOnDotenv: true })
        expect(r.rc).not.toBe(0)
        expect(r.record.refusedCode).toBe('MISSING_TEST_URL')
        expect(r.obs.valid).toBe(true)
        expect(r.obs.attempts).toBe(0)
    }, 300000)

    test('模块装载记录：拒绝早于 p0 import / Prisma factory（无命中）', () => {
        const r = runRootEntry({ kind: 'direct_p0', repoRoot, jestBin, label: 'direct-p0-module-probe', logDir: OUT_DIR })
        expect(r.rc).not.toBe(0)
        expect(r.record.refusedCode).toBe('MISSING_TEST_URL')
        expect(r.obs.valid).toBe(true)
        expect(r.obs.attempts).toBe(0)
        expect(r.moduleHits.valid).toBe(true)
        expect(r.moduleHits.hits).toEqual([]) // 未加载 @prisma/client / p0 / purge
    }, 300000)
})

// ── A3 观测钩子正对照（合成 canary；不读真实 .env）──
describe('A3 · 观测钩子正对照（合成可失败）', () => {
    test('module 装载钩子正对照：受控模块命中能生成带 token 的记录', () => {
        const dir = mkTmp('t02b-r2-module-canary-')
        const moduleLog = path.join(dir, 'modules.log')
        const token = `tok-${crypto.randomBytes(6).toString('hex')}`
        const target = path.join(repoRoot, 'backend/lib/schoolAdminPurge.js')
        const script = `require(${JSON.stringify(target)}); console.log('canary-required')`
        const r = spawnSync(process.execPath, ['-e', script], {
            encoding: 'utf8', timeout: 30000,
            env: {
                PATH: process.env.PATH, HOME: process.env.HOME,
                NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
                T02B_MODULE_LOG: moduleLog, T02B_RUN_TOKEN: token,
            },
        })
        expect(r.status).toBe(0)
        expect(r.stdout).toMatch(/canary-required/)
        const hits = readModuleHits(moduleLog, { token })
        expect(hits.valid).toBe(true)
        expect(hits.hits.length).toBeGreaterThanOrEqual(1) // 钩子本次运行确实能记录受控命中
        expect(hits.hits.some((m) => m.includes('schoolAdminPurge'))).toBe(true)
        // 外来 token 读取 → 不认（不得把别人的记录当自己的）
        expect(readModuleHits(moduleLog, { token: 'other-token' }).valid).toBe(false)
    }, 60000)

    test('dotenv fail-on-access 正对照：读取受控 backend/.env 路径在读取前抛 T02B_DOTENV_ACCESS（不读真实内容）', () => {
        const dir = mkTmp('t02b-r2-dotenv-canary-')
        const netLog = path.join(dir, 'net.log')
        const token = `tok-${crypto.randomBytes(6).toString('hex')}`
        const target = path.join(repoRoot, 'backend/.env')
        const script = `
const fs = require('node:fs')
try { fs.readFileSync(${JSON.stringify(target)}, 'utf8'); console.log('READ_SUCCEEDED'); process.exit(9) }
catch (e) { console.log('CAUGHT:' + (e && e.code)); process.exit(0) }
`
        const r = spawnSync(process.execPath, ['-e', script], {
            encoding: 'utf8', timeout: 30000,
            env: {
                PATH: process.env.PATH, HOME: process.env.HOME,
                NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
                T02B_NET_LOG: netLog, T02B_RUN_TOKEN: token, T02B_FAIL_ON_DOTENV_ACCESS: '1',
            },
        })
        expect(r.status).toBe(0)
        expect(r.stdout).toMatch(/CAUGHT:T02B_DOTENV_ACCESS/) // 在读取前抛出，未返回内容
        expect(r.stdout).not.toMatch(/READ_SUCCEEDED/)
        const obs = readObservations(netLog, { token })
        expect(obs.valid).toBe(true) // 观测完整（boot+final）
        expect(obs.attempts).toBe(0)
        const text = fs.readFileSync(netLog, 'utf8')
        expect(text).toMatch(/dotenv_access_attempt/) // 记录了访问尝试（仅 token/PID，不含内容）
        expect(text).not.toMatch(/DATABASE_URL=|PASSWORD=|JWT_SECRET=/) // 未写出任何环境值
    }, 60000)
})

// ── A4 纯配置负例（绝不连接）──
describe('A4 · 纯配置负例（绝不连接）', () => {
    const makeCtx = () => {
        const dir = mkTmp('t02b-r2-pure-')
        const runId = `t02b${crypto.randomBytes(4).toString('hex')}`
        const d = gate.derivedNamespace(runId)
        const ctx = {
            task: 'P3-W0-T02A', runId,
            instance: { host: '127.0.0.1', port: 55537, database: d.database, role: d.role, instanceTag: d.instanceTag, markerTable: d.markerTable },
            allowedSchemas: d.allowedSchemas, allowedFixtureObjects: d.fixtureObjects.slice(),
            tenants: d.tenants, roleAudit: d.roleAudit,
        }
        const file = path.join(dir, 'context.json')
        fs.writeFileSync(file, JSON.stringify(ctx))
        return { file, d, ctx }
    }
    const check = (file, url) => gate.checkIsolationConfig({ TEST_DB_CONTEXT_FILE: file, TEST_DATABASE_URL: url })

    test('固定业务库名 / 默认端口 → 拒绝', () => {
        const a = makeCtx()
        const aCtx = JSON.parse(fs.readFileSync(a.file, 'utf8'))
        aCtx.instance.database = 'school_reviewtest'
        fs.writeFileSync(a.file, JSON.stringify(aCtx))
        const ra = check(a.file, `postgresql://${a.d.role}:x@127.0.0.1:55537/${a.d.database}`)
        expect(ra.ok).toBe(false)
        expect(['CONTRACT_MISMATCH', 'URL_MISMATCH', 'BUSINESS_NAME_REJECTED']).toContain(ra.code)

        const b = makeCtx()
        const bCtx = JSON.parse(fs.readFileSync(b.file, 'utf8'))
        bCtx.instance.port = 5432
        fs.writeFileSync(b.file, JSON.stringify(bCtx))
        expect(check(b.file, `postgresql://${b.d.role}:x@127.0.0.1:5432/${b.d.database}`).code).toBe('DEFAULT_PORT_REJECTED')
    })

    test('非法/重复 query 参数 → 拒绝', () => {
        const a = makeCtx()
        const base = `postgresql://${a.d.role}:x@127.0.0.1:55537/${a.d.database}`
        expect(check(a.file, `${base}?schema=public&schema=${a.d.schemas.a}`).code).toBe('URL_PARAM_DUPLICATE')
        expect(check(a.file, `${base}?host=evil`).code).toBe('URL_PARAM_FORBIDDEN')
    })
})
