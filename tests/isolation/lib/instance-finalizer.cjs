'use strict'
/**
 * P3-W0-T02A-R3 — 测试实例收尾（真实实例只走安全关闭；残留必须可见并使 suite 非零）。
 *
 * 规则：
 *   * 真实 PG 目录**只能**通过 `provision.down()`（内部含归属核验与三条件删除）处置；
 *   * 关闭失败/未确认 → 记入 residue（含 runId、路径、outcome），**不删除**、不掩盖；
 *   * 有 residue → `ok=false`，调用方（suite afterAll / 子进程）必须使整体非零。
 * `downFn` 可注入（合成/子进程负例用），默认使用真实 provision.down。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const provision = require('../provision.cjs')

function finalizeInstances({ runIds, downFn = provision.down }) {
    const residue = []
    const handled = []
    for (const runId of runIds) {
        let root = null
        try { root = provision.taskRoot(runId) } catch (e) { residue.push({ runId, root: null, outcome: { ok: false, code: (e && e.code) || 'E_RUNID' } }); continue }
        if (!fs.existsSync(root)) { handled.push({ runId, root, outcome: { ok: true, removed: false, reason: 'root_absent' } }); continue }
        let outcome = null
        try { outcome = downFn({ runId }) } catch (e) { outcome = { ok: false, code: (e && e.code) || 'UNKNOWN', message: String((e && e.message) || '').slice(0, 160) } }
        if (!outcome || outcome.ok !== true) residue.push({ runId, root, outcome })
        else handled.push({ runId, root, outcome })
    }
    return { ok: residue.length === 0, handled, residue }
}

/** 写残留报告（0600）；返回路径。残留内容不会包含任何秘密。 */
function writeResidueReport(residue, { dir = os.tmpdir() } = {}) {
    const file = path.join(dir, `t02a-r3-residue-${crypto.randomBytes(3).toString('hex')}.json`)
    fs.writeFileSync(file, JSON.stringify({ note: 'real-PG test directories kept after failed/unconfirmed safe shutdown (manual handling required)', residue }, null, 2) + '\n', { mode: 0o600 })
    return file
}

module.exports = { finalizeInstances, writeResidueReport }
