'use strict'
/**
 * P3-W0-T02B-R2 — **实际收尾失败**专用 fixture（不被默认 suite 收集）。
 *
 * 目的：对**当前 p0 的收尾调用路径**（afterAll → settleAll → cleanup/disconnect）做受控故障注入，
 * 证明：cleanup 与 disconnect 逐项都被尝试、任一失败使 **命令真实 rc≠0**、且原始业务错误（如有）
 * 仍可按 code 辨识（清理与释放错误同时记录）。不修改共享 helper 或生产模块。
 *
 * 用法（在已 provision + controller fixture 就绪的实例上；继承 TEST_* 与 T02B_FIXTURE_FILE）：
 *   node tests/isolation/fixtures/t02b-r2-teardown-probe.cjs <logDir>
 * 退出码：0 = 断言全部成立；非 0 = 证据不足（原样输出子进程 rc 与日志路径）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../../..')
const jestBin = path.join(repoRoot, 'node_modules/.bin/jest')
const logDir = process.argv[2] || os.tmpdir()
fs.mkdirSync(logDir, { recursive: true })

const r = spawnSync(
    process.execPath,
    [jestBin, '--config', 'jest.config.cjs', '--runTestsByPath', 'tests/p0ProvNoAdminInSchool.test.js', '--runInBand', '-t', '⑤'],
    {
        cwd: repoRoot, encoding: 'utf8', timeout: 240000,
        env: { ...process.env, T02B_R2_TEARDOWN_FAULT: 'both' }, // cleanup + disconnect 同时注入失败
    },
)
const out = `${r.stdout || ''}\n${r.stderr || ''}`
fs.writeFileSync(path.join(logDir, 'teardown-fault-p0.log'), out, 'utf8')
fs.writeFileSync(path.join(logDir, 'teardown-fault-p0.rc'), String(r.status === null ? 'null' : r.status) + '\n', 'utf8')

const checks = {
    rc_nonzero: r.status !== null && r.status !== 0,                     // 命令真实非零
    afterAllFailedMarker: /\[AFTER_ALL_FAILED\]/.test(out),              // 收尾路径确实失败
    bothStepsAttempted: /invocations=\[cleanup,disconnect\]/.test(out),  // 逐项都尝试（且顺序可见）
    disconnectErrorRecordedName: /basePrisma\.\$disconnect:E_END/.test(out),
    cleanupErrorRecorded: /cleanupRegisteredRows:INJECTED_CLEANUP/.test(out),
    disconnectErrorRecorded: /disconnect:E_END/.test(out),
    originalBusinessErrorPreserved: /originalErrorCode=INJECTED_BUSINESS/.test(out),
}
const ok = Object.values(checks).every((v) => v === true)
console.log(JSON.stringify({
    fixture: 't02b-r2-teardown-probe',
    rc: r.status,
    logFile: path.join(logDir, 'teardown-fault-p0.log'),
    rcFile: path.join(logDir, 'teardown-fault-p0.rc'),
    checks, ok,
}, null, 2))
process.exit(ok ? 0 : 1)
