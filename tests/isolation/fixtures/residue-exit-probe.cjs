'use strict'
/**
 * P3-W0-T02A-R3 — **合成子进程 fixture**（不匹配 *.test.cjs，不会被默认 suite 自动发现）。
 *
 * 用途：证明"存在未解决残留 → suite 非零"这一收尾契约本身成立（lifecycle suite 会 spawn 本文件）。
 * 做法：用**注入的 downFn**（不触碰任何真实实例）制造一个残留，然后按 suite 同样的规则
 * 使进程非零 —— 不使用真实 PG、不删除任何未知目录。
 *
 * 用法：node residue-exit-probe.cjs <mode: clean|residue>
 */
const crypto = require('node:crypto')
const { finalizeInstances, writeResidueReport } = require('../lib/instance-finalizer.cjs')
const provision = require('../provision.cjs')

const mode = process.argv[2] === 'clean' ? 'clean' : 'residue'
const fs = require('node:fs')
const runId = `t02a${crypto.randomBytes(4).toString('hex')}`
const root = provision.taskRoot(runId)
// 纯粹的合成目录（仅本 fixture 自己创建，内容是空的；不涉及任何真实实例）
fs.mkdirSync(root, { recursive: true })
// 注入 downFn：clean → 成功；residue → 明确失败（模拟关闭未确认）
const downFn = mode === 'clean'
    ? () => ({ ok: true, removed: true, stopped: true, processGone: true, portReleased: true })
    : () => ({ ok: false, removed: false, stopped: false, reason: 'ownership_evidence_insufficient' })

const result = finalizeInstances({ runIds: [runId], downFn })
let reportFile = null
if (!result.ok) reportFile = writeResidueReport(result.residue)
fs.rmSync(root, { recursive: true, force: true }) // 合成目录按登记清理（注入的 downFn 不触碰真实实例）
console.log(JSON.stringify({ mode, ok: result.ok, residueCount: result.residue.length, reportFile, note: 'synthetic only (no real instance touched)' }))
// 与 suite 相同的契约：有残留 → 非零
process.exit(result.ok ? 0 : 3)
