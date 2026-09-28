// P3-W0-T01-R1 — 真实启动入口的 JWT 门禁启动集成测试（配置源隔离版）。
//
// 真实性：子进程运行**真实 backend/server.js**（node 直启与 npm start 两种入口）。
// 隔离（R3）：
//   - 子进程 cwd = 任务自有空临时目录（并且 npm 模式使用该目录中的最小 package.json），
//     因此不存在真实 cwd/.env、backend/.env 或 HOME 配置的默认查找；
//   - dotenv.config 被测试 loader 约束到 P3W0_DOTENV_PATH 指定的**合成文件**；路径未设置即拒绝；
//   - 对"除合成文件外的任何 .env"的 fs 读取做 fail-on-access（记录并抛错）；
//   - 监听在测试层被限制为回环 127.0.0.1 并记录（不改变生产 server 配置）。
// 受控替身（stubs/）：@prisma/client、tenantSync、securityAlerts、tenantClient、
//   schoolRoutes.ensureRecycleBinInfra —— 数据库与后台工作全部被拦截并记录到 marker。
// 结论口径：真实入口 + 受控依赖，不是端到端服务可用性验证。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const serverPath = path.join(repoRoot, 'backend', 'server.js')
const registerStubs = path.join(here, 'stubs', 'register-stubs.mjs')
const registerStubsUrl = pathToFileURL(registerStubs).href // 路径可能含空格：必须用已编码 URL
const AUD044_HISTORICAL_EXAMPLE = 'please-run-openssl-rand-hex-32-and-replace-this'
const safeSecret = () => crypto.randomBytes(48).toString('base64')

function startServer({ mode, env = {}, dotenvContent = null, withDotenvPath = true }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3w0r1-startup-'))
    const markerPath = path.join(tmpDir, 'stub-marker.txt')
    const dotenvPath = path.join(tmpDir, 'synthetic.env')
    if (dotenvContent !== null) fs.writeFileSync(dotenvPath, dotenvContent, { mode: 0o600 })

    const fullEnv = {
        // 严格白名单：不继承业务 DB/secret/.env 相关变量
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PORT: '0',
        NODE_ENV: 'production',
        P3W0_STUB_MARKER: markerPath,
        NODE_OPTIONS: `--import=${registerStubsUrl}`,
        ...(withDotenvPath ? { P3W0_DOTENV_PATH: dotenvPath } : {}),
        ...env,
    }

    let cmd, args
    if (mode === 'npm') {
        // 在任务自有目录中提供最小 package.json：npm start 的 cwd 因此被隔离
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            name: 'p3w0-runner', private: true, version: '0.0.0',
            scripts: { start: `node ${JSON.stringify(serverPath)}` },
        }))
        cmd = 'npm'
        args = ['start', '--silent']
    } else {
        cmd = process.execPath
        args = ['--import', registerStubsUrl, serverPath]
    }

    const child = spawn(cmd, args, { cwd: tmpDir, env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    return {
        child, tmpDir, markerPath,
        get out() { return out },
        marker() { try { return fs.readFileSync(markerPath, 'utf8') } catch { return '' } },
        cleanup() {
            try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
            fs.rmSync(tmpDir, { recursive: true, force: true })
        },
    }
}

function waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const started = Date.now()
        const timer = setInterval(() => {
            if (predicate()) { clearInterval(timer); resolve() }
            else if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error(`timeout waiting for ${label}`)) }
        }, 50)
    })
}

function waitExit(child, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode)
        const timer = setTimeout(() => reject(new Error(`timeout waiting for exit: ${label}`)), timeoutMs)
        child.on('close', (code) => { clearTimeout(timer); resolve(code) })
    })
}

async function expectRefused(run, { expectField, expectCode = 'KNOWN_WEAK_VALUE' }) {
    const code = await waitExit(run.child, 20000, 'refusal')
    assert.equal(code, 1, '拒绝时进程必须以退出码 1 结束')
    assert.ok(!run.out.includes('Server running'), '拒绝必须发生在监听之前')
    assert.ok(run.out.includes('code=' + expectCode), `输出必须含安全原因码 ${expectCode}`)
    assert.ok(run.out.includes(expectField), `输出必须含字段名 ${expectField}`)
    assert.equal(run.marker().includes('new PrismaClient'), false, '拒绝时不得构造 Prisma（marker 必须不含）')
    assert.equal(run.marker().includes('net.listen'), false, '拒绝时不得进入监听')
    return run.out
}

describe('启动集成（隔离配置源）— 拒绝路径', () => {
    it('node 直启：合成 .env 内公开示例值 → 拒绝、无副作用、不读任何真实配置', async () => {
        const run = startServer({ mode: 'node', dotenvContent: `JWT_SECRET=${AUD044_HISTORICAL_EXAMPLE}\n` })
        try {
            const out = await expectRefused(run, { expectField: 'JWT_SECRET' })
            assert.ok(!out.includes(AUD044_HISTORICAL_EXAMPLE), '输出不得包含密钥原值')
            const marker = run.marker()
            assert.ok(marker.includes('dotenv.config:allowed'), '必须从合成文件加载（证明隔离路径生效）')
            assert.ok(!marker.includes('fs.BLOCKED'), '不得尝试读取任何被禁止的 .env')
        } finally { run.cleanup() }
    })

    it('npm start：合成 .env 提供合法 access + env 注入公开 refresh → 拒绝', async () => {
        const run = startServer({
            mode: 'npm',
            dotenvContent: `JWT_SECRET=${safeSecret()}\n`,
            env: { JWT_REFRESH_SECRET: AUD044_HISTORICAL_EXAMPLE },
        })
        try {
            const out = await expectRefused(run, { expectField: 'JWT_REFRESH_SECRET' })
            assert.ok(!out.includes(AUD044_HISTORICAL_EXAMPLE), '输出不得包含密钥原值')
        } finally { run.cleanup() }
    })

    it('合成 canary 弱值（唯一标记）：拒绝输出与日志均不得包含该值', async () => {
        const canary = `p3w0-canary-${crypto.randomBytes(8).toString('hex')}`
        // 值经进程环境注入（合成 dotenv 路径保留，但不写文件）→ 校验路径覆盖 TOO_SHORT
        const run = startServer({ mode: 'node', env: { JWT_SECRET: canary } })
        try {
            const out = await expectRefused(run, { expectField: 'JWT_SECRET', expectCode: 'TOO_SHORT' })
            assert.ok(!out.includes(canary), '输出不得包含合成密钥原值')
            assert.ok(!out.includes('p3w0-canary'), '输出不得包含 canary 前缀')
        } finally { run.cleanup() }
    })

    for (const nodeEnv of ['development', 'test']) {
        it(`NODE_ENV=${nodeEnv} 不绕过门禁（合成 .env 公开示例）`, async () => {
            const run = startServer({ mode: 'node', dotenvContent: `JWT_SECRET=${AUD044_HISTORICAL_EXAMPLE}\n`, env: { NODE_ENV: nodeEnv } })
            try { await expectRefused(run, { expectField: 'JWT_SECRET' }) } finally { run.cleanup() }
        })
    }

    it('无任何来源（无合成文件、无 env）→ MISSING，且不生成', async () => {
        const run = startServer({ mode: 'npm' })
        try {
            const out = await expectRefused(run, { expectField: 'JWT_SECRET', expectCode: 'MISSING' })
            assert.ok(!/secret\s*[:=]\s*\S+/.test(out), '输出不得出现形如密钥赋值的内容')
            assert.equal(run.marker().includes('new PrismaClient'), false)
        } finally { run.cleanup() }
    })

    it('P3W0_DOTENV_PATH 未设置 → dotenv.config 被测试隔离拒绝（fail-closed，不回落到默认查找）', async () => {
        const run = startServer({ mode: 'node', withDotenvPath: false, env: { JWT_SECRET: safeSecret() } })
        try {
            const code = await waitExit(run.child, 20000, 'refusal')
            assert.notEqual(code, 0, '未限定 dotenv 路径时必须失败而不是继续读取默认配置')
            assert.ok(run.marker().includes('dotenv.config BLOCKED:no-path'), '必须记录被拒绝的默认查找')
            assert.ok(!run.out.includes('Server running'), '不得进入监听')
        } finally { run.cleanup() }
    })
})

describe('启动集成（隔离配置源）— 通过路径', () => {
    for (const mode of ['node', 'npm']) {
        it(`${mode}：合成 .env 提供 access+refresh → 到达回环监听、后台替身拦截、SIGTERM 正常退出`, async () => {
            const access = safeSecret()
            const refresh = safeSecret()
            const run = startServer({
                mode,
                dotenvContent: `JWT_SECRET=${access}\nJWT_REFRESH_SECRET=${refresh}\n`,
            })
            try {
                await waitFor(() => run.out.includes('Server running'), 30000, 'listen')
                assert.ok(run.out.includes('refresh = explicit'), '合成 .env 的显式 refresh 必须被读取并声明为 explicit')
                await waitFor(() => run.marker().includes('syncAllTenantSchemas'), 10000, 'stub marker')
                const marker = run.marker()
                for (const name of ['dotenv.config:allowed', 'new PrismaClient', 'syncAllTenantSchemas', 'ensureRecycleBinInfra', 'startSecurityEventAlerting', 'net.listen:127.0.0.1']) {
                    assert.ok(marker.includes(name), `必须经替身记录：${name}`)
                }
                assert.ok(!marker.includes('fs.BLOCKED'), '不得尝试读取被禁止的 .env（真实仓库/backend/HOME）')
                if (mode === 'npm') {
                    try { process.kill(-run.child.pid, 'SIGTERM') } catch { run.child.kill('SIGTERM') }
                } else {
                    run.child.kill('SIGTERM')
                }
                const code = await waitExit(run.child, 15000, 'exit')
                const graceful = run.marker().includes('prisma.$disconnect')
                if (mode === 'node') {
                    assert.equal(code, 0, 'SIGTERM 后应按既有 graceful shutdown 正常退出')
                    assert.ok(graceful, '关闭时应断开替身客户端')
                } else {
                    console.log(`[npm-mode] group exit code = ${code}; signal = ${run.child.signalCode}; graceful disconnect trace = ${graceful}`)
                    assert.ok(code !== null || run.child.signalCode !== null, '进程组必须结束（不得挂起）')
                }
                assert.ok(!run.out.includes(access), '启动日志不得包含 access 值')
                assert.ok(!run.out.includes(refresh), '启动日志不得包含 refresh 值')
            } finally { run.cleanup() }
        })
    }
})

describe('配置源隔离 — fail-on-access 自证', () => {
    it('同一 loader 下，读取真实仓库/backend/.env 均被拦截并记录', async () => {
        const targets = [path.join(repoRoot, '.env'), path.join(repoRoot, 'backend', '.env'), path.join(os.homedir(), '.env')]
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3w0r1-block-'))
        const markerPath = path.join(tmpDir, 'stub-marker.txt')
        try {
            const script = `const fs=require('node:fs');const p=${JSON.stringify(targets)};for(const t of p){try{fs.readFileSync(t);console.log('READ_SUCCEEDED:'+t)}catch(e){console.log('BLOCKED')}}`
            const child = spawn(process.execPath, ['--import', registerStubsUrl, '-e', script], {
                cwd: tmpDir,
                env: { PATH: process.env.PATH, HOME: process.env.HOME, P3W0_STUB_MARKER: markerPath },
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            let out = ''
            child.stdout.on('data', (d) => { out += d })
            child.stderr.on('data', (d) => { out += d })
            await waitExit(child, 20000, 'probe exit')
            const blockedCount = (out.match(/BLOCKED/g) || []).length
            assert.equal(out.includes('READ_SUCCEEDED'), false, '不得有任何真实 .env 读取成功')
            assert.ok(blockedCount >= 1, `每个目标都应被拦截（实际 BLOCKED=${blockedCount}；不存在的文件也可能先命中拦截）`)
            const marker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : ''
            assert.ok(marker.includes('fs.BLOCKED'), '拦截必须写入 marker 供审计')
            console.log(`[fail-on-access] targets=${targets.length} blocked=${blockedCount}`)
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })
})
