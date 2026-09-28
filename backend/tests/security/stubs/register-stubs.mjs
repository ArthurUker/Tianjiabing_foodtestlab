// P3-W0-T01-R1 — 启动集成测试的模块替身注册器（只用于测试子进程，经 --import / NODE_OPTIONS 注入）。
//
// 目的：
//   1) 拦截全部数据库与后台工作（不连接任何数据库，不需要 DATABASE_URL）；
//   2) 把 dotenv 的配置查找限定到测试指定的合成文件（P3W0_DOTENV_PATH），不读仓库/HOME 配置；
//   3) 对"任何 .env（除合成文件外）"的 fs 读取做 fail-on-access（记录并抛错）；
//   4) 把监听地址在测试层限制为回环 127.0.0.1 并记录（不改变生产 server 配置）。
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import { record } from './stub-record.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const stub = (name) => pathToFileURL(path.join(here, name)).href

// ── 1) 模块替身（resolve hooks）──
const REPLACEMENTS = [
    { match: /^@prisma\/client$/, url: stub('prisma-client.stub.mjs') },
    { match: /^dotenv$/, url: stub('dotenv.stub.mjs') },
    { match: /\/lib\/tenantSync\.js$/, url: stub('tenant-sync.stub.mjs') },
    { match: /\/lib\/securityAlerts\.js$/, url: stub('security-alerts.stub.mjs') },
    { match: /\/lib\/tenantClient\.js$/, url: stub('tenant-client.stub.mjs') },
    { match: /\/routes\/schoolRoutes\.js$/, url: stub('school-routes.stub.mjs') },
]

registerHooks({
    resolve(specifier, context, nextResolve) {
        // 替身内部用 `?real` 旁路请求真实模块时不再替换，避免递归
        if (specifier.includes('?real')) return nextResolve(specifier, context)
        for (const r of REPLACEMENTS) {
            if (r.match.test(specifier)) return { url: r.url, shortCircuit: true }
        }
        const resolved = nextResolve(specifier, context)
        if (resolved?.url && !resolved.url.includes('?real')) {
            for (const r of REPLACEMENTS) {
                if (r.match.test(resolved.url)) return { url: r.url, shortCircuit: true }
            }
        }
        return resolved
    },
})

// ── 2) fs fail-on-access：除合成 .env 外，任何 .env 读写被拦截 ──
const allowedEnvPath = process.env.P3W0_DOTENV_PATH ? path.resolve(process.env.P3W0_DOTENV_PATH) : null

function isForbiddenEnvPath(p) {
    try {
        const resolved = path.resolve(String(p))
        if (!resolved.endsWith('.env')) return false
        if (allowedEnvPath && resolved === allowedEnvPath) return false
        return true
    } catch {
        return false
    }
}

const origReadFileSync = fs.readFileSync
fs.readFileSync = function (p, ...rest) {
    if (isForbiddenEnvPath(p)) {
        record(`fs.BLOCKED:readFileSync:${path.basename(path.dirname(String(p)))}/.env`)
        throw new Error(`restricted test runner: reading ${String(p)} is blocked (only P3W0_DOTENV_PATH is allowed)`)
    }
    return origReadFileSync.call(this, p, ...rest)
}
const origReadFile = fs.readFile
fs.readFile = function (p, ...rest) {
    if (isForbiddenEnvPath(p)) {
        record(`fs.BLOCKED:readFile:${path.basename(path.dirname(String(p)))}/.env`)
        const cb = rest[rest.length - 1]
        const err = new Error(`restricted test runner: reading ${String(p)} is blocked`)
        if (typeof cb === 'function') return process.nextTick(() => cb(err))
        throw err
    }
    return origReadFile.call(this, p, ...rest)
}

// ── 3) 监听回环化（测试层）：记录并强制 host=127.0.0.1 ──
const origListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
    const isPortLike = (a) => typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))
    if (args.length > 0 && isPortLike(args[0])) {
        const port = Number(args[0])
        record(`net.listen:127.0.0.1:${port}`)
        return origListen.call(this, { port, host: '127.0.0.1' }, ...args.slice(1))
    }
    record('net.listen:passthrough')
    return origListen.apply(this, args)
}
