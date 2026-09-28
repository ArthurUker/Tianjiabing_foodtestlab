// P3-LIFECYCLE-AB-R4 · R13-4 函数级沙盒：两段发布入口的门禁不可绕过性
//
// 方法：PATH 注入桩（node/npx/systemctl 全部替换为记录器），运行**真实**的
//   backend/scripts/b-release-two-phase.sh，断言：
//     · 任一 --check / G2-G7-G8(006) 非零 ⇒ 绝不 schema-switch B（不生成/激活 B client）、绝不 restart；
//     · 全绿才进入 B2（check → 006 → B switch → build → restart 的真实顺序）；
//     · 回退安装 A client 且**不执行任何 migrate**（DB 不逆迁）。
// 全程不触真实部署（systemctl 为桩）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = process.cwd()
const WRAPPER = path.join(REPO, 'backend/scripts/b-release-two-phase.sh')

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r13b-'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  const makeStub = (name) => {
    const p = path.join(bin, name)
    fs.writeFileSync(p, `#!/usr/bin/env bash
printf '%s\\n' "${name} $*" >> "$R13B_LOG"
case "$*" in
  *sync-tenant-schemas.mjs\\ --check*) exit "\${STUB_GATE_CHECK:-0}" ;;
  *006_audit_principal_gate.mjs*) exit "\${STUB_GATE_006:-0}" ;;
  *sync-tenant-schemas.mjs*) exit "\${STUB_SYNC:-0}" ;;
  *migrate*deploy*) exit "\${STUB_MIGRATE:-0}" ;;
esac
exit 0
`, { mode: 0o755 })
    return p
  }
  ;['node', 'npx', 'systemctl'].forEach(makeStub)
  const log = path.join(dir, 'run.log')
  fs.writeFileSync(log, '')
  return { dir, bin, log, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function runPhase(phase, env = {}) {
  const sb = makeSandbox()
  try {
    let rc = 0
    try {
      execFileSync('bash', [WRAPPER, phase], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, R13B_LOG: sb.log, ...env },
      })
    } catch (e) { rc = e.status ?? 1 }
    const log = fs.readFileSync(sb.log, 'utf8')
    return { rc, log, lines: log.trim().split('\n').filter(Boolean) }
  } finally { sb.cleanup() }
}

const hasB = (log) => /schema-switch\.mjs B/.test(log)
const hasA = (log) => /schema-switch\.mjs A/.test(log)
const restarted = (log) => /systemctl restart/.test(log)
const migrated = (log) => /migrate deploy|sync-tenant-schemas\.mjs$|sync-tenant-schemas\.mjs\\ /m.test(log) && !/--check/.test(log)

test('R13-4.1 b1：--check 门禁非零 ⇒ 非零退出、不生成 B client、不 restart', () => {
  const { rc, log } = runPhase('b1', { STUB_GATE_CHECK: '1' })
  assert.notEqual(rc, 0)
  assert.ok(hasA(log), 'b1 应先使用 A 版 client')
  assert.ok(!hasB(log), '门禁失败绝不允许生成/激活 B client')
  assert.ok(!restarted(log), '门禁失败绝不 restart')
})

test('R13-4.2 b1：006 门禁（G2/G7/G8/G3）非零 ⇒ 非零退出、不生成 B client、不 restart', () => {
  const { rc, log } = runPhase('b1', { STUB_GATE_006: '1' })
  assert.notEqual(rc, 0)
  assert.ok(!hasB(log))
  assert.ok(!restarted(log))
})

test('R13-4.3 b1：全绿 ⇒ rc=0，顺序 = A switch → migrate/sync → check → 006，且仍不生成 B client', () => {
  const { rc, log, lines } = runPhase('b1')
  assert.equal(rc, 0)
  const idxA = lines.findIndex((l) => /schema-switch\.mjs A/.test(l))
  const idxMig = lines.findIndex((l) => /migrate deploy/.test(l))
  const idxSync = lines.findIndex((l) => /sync-tenant-schemas\.mjs$/.test(l))
  const idxCheck = lines.findIndex((l) => /sync-tenant-schemas\.mjs --check/.test(l))
  const idx006 = lines.findIndex((l) => /006_audit_principal_gate/.test(l))
  assert.ok(idxA >= 0 && idxMig > idxA && idxSync > idxMig && idxCheck > idxSync && idx006 > idxCheck, `顺序异常: ${JSON.stringify(lines)}`)
  assert.ok(!hasB(log), 'b1 只迁移与门禁，不生成 B client')
  assert.ok(!restarted(log), 'b1 不重启')
})

test('R13-4.4 b2：激活前复核门禁非零 ⇒ 非零退出、不生成 B client、不 restart', () => {
  const { rc, log } = runPhase('b2', { STUB_GATE_CHECK: '1' })
  assert.notEqual(rc, 0)
  assert.ok(!hasB(log), '门禁失败绝不允许激活 B client')
  assert.ok(!restarted(log))
})

test('R13-4.5 b2：全绿 ⇒ 顺序 = check → 006 → B switch → build → restart', () => {
  const { rc, lines } = runPhase('b2')
  assert.equal(rc, 0)
  const iCheck = lines.findIndex((l) => /sync-tenant-schemas\.mjs --check/.test(l))
  const i006 = lines.findIndex((l) => /006_audit_principal_gate/.test(l))
  const iB = lines.findIndex((l) => /schema-switch\.mjs B/.test(l))
  const iBuild = lines.findIndex((l) => /build-static\.js/.test(l))
  const iRestart = lines.findIndex((l) => /systemctl restart/.test(l))
  assert.ok(iCheck >= 0 && i006 > iCheck && iB > i006 && iBuild > iB && iRestart > iBuild, `顺序异常: ${JSON.stringify(lines)}`)
})

test('R13-4.6 回退：安装 A client、不执行任何 migrate（DB 不逆迁）、允许 restart', () => {
  const { rc, log } = runPhase('rollback-client')
  assert.equal(rc, 0)
  assert.ok(hasA(log), '回退必须装回 A client')
  assert.ok(!/migrate deploy/.test(log), '回退不得执行 public migrate deploy（DB 不逆迁）')
  assert.ok(!/sync-tenant-schemas\.mjs/.test(log), '回退不得推进租户链')
  assert.ok(restarted(log), '回退允许重启以加载 A client')
})

test('R13-4.7 非法阶段 ⇒ rc=2（入口自证）', () => {
  const { rc } = runPhase('b3')
  assert.equal(rc, 2)
})
