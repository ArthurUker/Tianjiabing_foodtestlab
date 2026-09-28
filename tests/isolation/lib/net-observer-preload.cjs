'use strict'
/**
 * P3-W0-T02B-R2 — 子进程观测预载 v3（`NODE_OPTIONS=--import=<fileURL>`）。
 *
 * 归属与完整性（R2 复审 §A1）：
 *   * 每一行都带**唯一 run token**（`T02B_RUN_TOKEN`）与 PID；调用方为每次运行创建**此前不存在**的观测路径。
 *   * 结构：每个 PID 一行 `boot`（首）+ **每次连接一条 `event`**（不用定时累计快照）+ 恰好一行 `final`（末，含最终完整计数）。
 *   * 读取器（root-entry-runner.cjs）逐 PID 校验：每个 boot 必须有 final、final 必须是该 PID 的最后一行、
 *     计数与 event 行数一致、无外来 token；任何缺项 → invalid（不得当作 0 次）。
 *   * 可选：module 装载记录（受控 canary 可命中）、dotenv fail-on-access（读取 `backend/.env` 前抛 `T02B_DOTENV_ACCESS`）。
 *   * 只观测，不改变连接行为；日志仅含安全码/token/PID/次数与 host/port，不含 URL/密码/环境值。
 */
const fs = require('node:fs')
const net = require('node:net')

const OUT = process.env.T02B_NET_LOG || null
const TOKEN = process.env.T02B_RUN_TOKEN || null
const MODULE_LOG = process.env.T02B_MODULE_LOG || null
const FAIL_ON_DOTENV = process.env.T02B_FAIL_ON_DOTENV_ACCESS === '1'
const PID = process.pid
let eventSeq = 0

function append(file, obj) {
    if (!file) return
    try { fs.appendFileSync(file, JSON.stringify(obj) + '\n') } catch { /* observation must not break the child */ }
}
const writeNet = (obj) => append(OUT, obj)

writeNet({ kind: 'boot', token: TOKEN, pid: PID, version: 3, ts: Date.now(), failOnDotenvAccess: FAIL_ON_DOTENV })

/** Node 的 net.connect → socket.connect 可能以"参数打包"（数组/类数组）转发，需递归展开。 */
function flattenArgs(args, depth = 0) {
    const flat = []
    for (const a of args) {
        const isPack = a && typeof a === 'object' && typeof a.length === 'number'
            && !('host' in a) && !('path' in a) && !('port' in a)
        if (isPack && depth < 4) flat.push(...flattenArgs(Array.from(a), depth + 1))
        else flat.push(a)
    }
    return flat
}
function extractTarget(args) {
    const flat = flattenArgs(args)
    const first = flat[0]
    if (first && typeof first === 'object' && !Array.isArray(first)) {
        return { host: first.host || first.path || null, port: first.port !== undefined ? first.port : null }
    }
    if (typeof first === 'string') return { host: typeof flat[1] === 'string' ? flat[1] : null, port: null, path: first }
    return { host: typeof flat[1] === 'string' ? flat[1] : null, port: typeof first === 'number' ? first : null }
}
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function patchedConnect(...args) {
    let target = { host: null, port: null }
    try { target = extractTarget(args) } catch { /* keep nulls */ }
    eventSeq += 1
    writeNet({ kind: 'event', token: TOKEN, pid: PID, seq: eventSeq, host: target.host, port: target.port })
    return originalConnect.apply(this, args)
}

// 可选：模块装载记录（合成 canary 可命中；用于证明拒绝早于 p0/Prisma 装载）
if (MODULE_LOG) {
    // 钩子生效证明：即使零命中，也留下本次 token/PID 的 module boot 行（读取器据此判定 valid）
    append(MODULE_LOG, { kind: 'module_boot', token: TOKEN, pid: PID, ts: Date.now() })
    const Module = require('node:module')
    const originalRequire = Module.prototype.require
    Module.prototype.require = function patchedRequire(id, ...rest) {
        try {
            if (typeof id === 'string' && /(@prisma\/client|p0ProvNoAdminInSchool|schoolAdminPurge)/.test(id)) {
                append(MODULE_LOG, { kind: 'module', token: TOKEN, pid: PID, module: id })
            }
        } catch { /* observation must not break the child */ }
        return originalRequire.call(this, id, ...rest)
    }
}

// 可选：dotenv fail-on-access（在读取前抛错；不创建/不读取真实内容）
if (FAIL_ON_DOTENV) {
    const originalReadFileSync = fs.readFileSync
    fs.readFileSync = function patchedReadFileSync(target, ...rest) {
        const p = typeof target === 'string' ? target : (Buffer.isBuffer(target) ? target.toString() : String(target))
        if (/(^|[\\/])backend[\\/]\.env$/.test(p)) {
            append(OUT, { kind: 'dotenv_access_attempt', token: TOKEN, pid: PID, ts: Date.now() })
            const e = new Error('[T02B-FAIL-ON-ACCESS] reading backend/.env is not allowed in isolated test processes')
            e.code = 'T02B_DOTENV_ACCESS'
            throw e
        }
        return originalReadFileSync.call(fs, target, ...rest)
    }
}

// 恰好一次终结记录（含最终完整计数）；异常终止（如 SIGKILL）不会有此行 → 读取器判 invalid
let finalized = false
const finalize = () => {
    if (finalized) return
    finalized = true
    writeNet({ kind: 'final', token: TOKEN, pid: PID, events: eventSeq, ts: Date.now() })
}
process.on('exit', finalize)
process.on('SIGTERM', () => { finalize(); process.exit(143) })
process.on('SIGINT', () => { finalize(); process.exit(130) })
