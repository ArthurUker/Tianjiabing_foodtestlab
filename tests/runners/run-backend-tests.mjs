#!/usr/bin/env node
/**
 * P3-CLOSE-B-R1（AUD-040）— `npm run test:backend` 的 runner。
 *
 * 为什么需要它：旧脚本 `node --test --test-concurrency=1 backend/tests/**\/*.test.mjs` 的 `**` 由 **shell** 展开
 * （`sh`/`dash` 下 `**` ≡ `*`）→ 只匹配 `backend/tests/<一层>/x.test.mjs`；顶层 `backend/tests/x.test.mjs`
 * 与两层嵌套 `backend/tests/a/b/x.test.mjs` 会**静默漏跑**。
 * P3-CLOSE-B-R3 起枚举模式为 **`**\/*.test.mjs` + `**\/*.unit.test.cjs`**（两类都由 `node --test` 原生运行；
 * 修复前 `backend/tests/harness-check/revocation-contract.unit.test.cjs` 不在任何入口 → 审计 G3 rc=1）。
 *
 * 本 runner：Node **递归**枚举（任意深度）→ 把逐文件路径直接交给 `node --test`。
 *   · 默认：等价替换（参数、并发、退出码语义保持；stdout/stderr 直通，便于落原始日志）；
 *   · `--list-only`：输出 JSON（文件清单/计数/与旧 shell 单层 glob 的差集），供逐文件对账证据。
 *
 * 用法：node tests/runners/run-backend-tests.mjs [--list-only]
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sets = require('./entry-sets.cjs')

const args = process.argv.slice(2)
const listOnly = args.includes('--list-only')
const files = sets.BACKEND_FILES
const missedByShellGlob = files.filter((f) => !sets.BACKEND_SHELL_GLOB_FILES.includes(f))
const extraInShellGlob = sets.BACKEND_SHELL_GLOB_FILES.filter((f) => !files.includes(f))

if (files.length === 0) {
  console.error(JSON.stringify({ ok: false, code: 'E_NO_TEST_FILES', message: 'backend/tests 下未枚举到 *.test.mjs（fail-closed，不静默通过）' }))
  process.exit(2)
}

if (listOnly) {
  console.log(JSON.stringify({
    ok: true,
    entry: 'test:backend',
    mode: 'list-only',
    enumerator: 'Node recursive (tests/runners/entry-sets.cjs)',
    patterns: sets.BACKEND_ENTRY_PATTERNS,
    legacyScript: 'node --test --test-concurrency=1 backend/tests/**/*.test.mjs (shell 单层展开 + 仅 .mjs)',
    fileCount: files.length,
    legacyShellGlobCount: sets.BACKEND_SHELL_GLOB_FILES.length,
    legacyShellGlobMisses: missedByShellGlob,
    legacyShellGlobExtra: extraInShellGlob,
    files,
  }, null, 2))
  process.exit(0)
}

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: sets.ROOT,
  stdio: 'inherit',
})
child.on('error', (e) => { console.error(`[test:backend runner] spawn failed: ${e.message}`); process.exit(1) })
child.on('exit', (code, signal) => {
  if (signal) { console.error(`[test:backend runner] node --test 被信号终止: ${signal}`); process.exit(1) }
  process.exit(code === null ? 1 : code)
})
