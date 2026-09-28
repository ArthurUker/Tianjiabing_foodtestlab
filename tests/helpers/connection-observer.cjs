'use strict'
/**
 * P3-W0-T02A-R2 — 测试专用**连接边界观测器**（不改变连接行为，只记录尝试）。
 *
 * 目的：让"配置拒绝 → 零连接"成为**可观察事实**（网络边界计数），而不是靠检索 ECONNREFUSED。
 * 覆盖 net.Socket.prototype.connect（pg / Prisma 最终都经此发起 TCP）。
 * 仅测试进程使用；生产代码不含任何挂钩。
 */
let attempts = []
let installed = false

function install() {
    if (installed) return
    installed = true
    const net = require('node:net')
    const originalConnect = net.Socket.prototype.connect
    net.Socket.prototype.connect = function patchedConnect(...args) {
        try {
            const first = args[0]
            if (first && typeof first === 'object') {
                attempts.push({ host: first.host || first.path || null, port: first.port || null, kind: 'tcp' })
            } else {
                attempts.push({ host: args[1] !== undefined ? args[1] : null, port: args[0] !== undefined ? args[0] : null, kind: 'port-first' })
            }
        } catch {
            attempts.push({ host: null, port: null, kind: 'unknown' })
        }
        return originalConnect.apply(this, args)
    }
}

/** 已观测到的连接尝试（副本）。 */
function observed() { return attempts.map((a) => ({ ...a })) }
function reset() { attempts = [] }
/** 是否命中任意业务样式地址（供"不访问业务地址"断言；本包只会连回环/死端口）。 */
function businessLikeAttempts() {
    return attempts.filter((a) => a.host && a.host !== '127.0.0.1' && a.host !== '::1' && a.host !== 'localhost')
}

module.exports = { install, observed, reset, businessLikeAttempts }
