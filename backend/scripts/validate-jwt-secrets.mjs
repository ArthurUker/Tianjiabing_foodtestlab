#!/usr/bin/env node
/**
 * P3-W0-T01-R1 / RC-10 (AUD-044) — 薄 CLI：把共享规则暴露给部署脚本（deploy.sh）。
 *
 * 与 server.js 启动校验使用同一 backend/lib/jwtSecretConfig.js；选择/解析/生成逻辑在
 * backend/lib/jwtSecretResolve.js（部署与测试共用同一实现，不复制第二套规则）。
 *
 * 安全约定：
 *  - 值只从环境变量读取（JWT_SECRET / JWT_REFRESH_SECRET），不接受命令行参数传值，
 *    避免秘密进入 ps 可见的 argv。
 *  - 任何输出（成功摘要、拒绝原因、用法错误、JSON）都**不含**参数原值、密钥值或子串；
 *    未知参数只报数量，不回显内容。
 *  - 写回片段只写入 --write-fragment 指定的文件（0600），不经过 stdout。
 *
 * 退出码：0 = 通过；1 = 值被拒绝；2 = 用法错误或环境文件不可用/不可解析。
 */
import fs from 'node:fs'
import { resolveJwtConfig, RESOLVE_EXIT } from '../lib/jwtSecretResolve.js'
import { serializeJwtEnvFragment } from '../lib/jwtSecretConfig.js'

const USAGE = [
    'Usage: JWT_SECRET=... [JWT_REFRESH_SECRET=...] node backend/scripts/validate-jwt-secrets.mjs [options]',
    'Options:',
    '  --source-env-file=<path> parse the JWT effective values from an existing .env file',
    '                           (deliberately NOT named --env-file: node itself consumes --env-file)',
    '  --write-fragment=<path>  write the validated .env fragment (mode 0600) for deploy write-back;',
    '                           enables generation when access is truly missing and the deploy-representation check',
    '  --no-generate            never generate a missing access secret (validation only)',
    '  --deploy-write           apply the deploy-representation check without writing a fragment',
    '  --json                   print a machine-readable summary (never contains secret values)',
    '  --help, -h               show this help (only accepted as the sole argument)',
    'Secrets are read from the environment only and are never echoed back.',
]

const rawArgs = process.argv.slice(2)
const wantsHelp = rawArgs.includes('--help') || rawArgs.includes('-h')

if (wantsHelp) {
    if (rawArgs.length === 1) {
        console.log(USAGE.join('\n'))
        process.exit(0)
    }
    // 帮助混入其它参数：按用法错误处理，且绝不回显参数内容
    console.error(`[JWT-CONFIG] invalid usage: --help must be the only argument (${rawArgs.length} argument(s) supplied). Argument values are never echoed.`)
    process.exit(2)
}

let envFilePath = null
let fragmentPath = null
let allowGenerate = false
let deployWrite = false
let jsonMode = false
const unsupported = []

for (const arg of rawArgs) {
    if (arg.startsWith('--source-env-file=')) envFilePath = arg.slice('--source-env-file='.length)
    else if (arg.startsWith('--write-fragment=')) { fragmentPath = arg.slice('--write-fragment='.length); deployWrite = true; allowGenerate = true }
    else if (arg === '--no-generate') allowGenerate = false
    else if (arg === '--deploy-write') deployWrite = true
    else if (arg === '--json') jsonMode = true
    else unsupported.push(arg)
}

if (unsupported.length > 0) {
    // 只报数量：误把密钥当作参数传入时也不会回显
    console.error(`[JWT-CONFIG] invalid usage: ${unsupported.length} unsupported argument(s). Run with --help for the supported interface. Argument values are never echoed.`)
    process.exit(2)
}
if (!envFilePath && !fragmentPath && !deployWrite) allowGenerate = false

const result = resolveJwtConfig({
    envAccess: process.env.JWT_SECRET,
    envRefresh: process.env.JWT_REFRESH_SECRET,
    envFilePath,
    allowGenerate,
    deployWrite,
})

function emitSummary() {
    if (jsonMode) {
        const summary = result.ok
            ? { ok: true, exit_code: RESOLVE_EXIT.OK, refresh_source: result.refreshSource, generated_access: result.generatedAccess, fragment_written: !!fragmentPath, source_trace: result.sourceTrace }
            : { ok: false, exit_code: result.exitCode, fragment_written: false, errors: result.errors, source_trace: result.sourceTrace }
        console.log(JSON.stringify(summary))
        return
    }
    if (result.ok) {
        const refreshText = result.refreshSource === 'explicit' ? 'explicit value' : 'derived from access secret'
        const generatedText = result.generatedAccess ? '; access secret was generated (was truly missing)' : ''
        console.log(`[JWT-CONFIG] JWT_SECRET: OK; JWT_REFRESH_SECRET: OK (${refreshText})${generatedText}`)
        return
    }
    for (const e of result.errors) {
        console.error(`[JWT-CONFIG] ${e.field}: REJECTED (code=${e.code}) — ${e.reason}`)
    }
    console.error('[JWT-CONFIG] aborted: replace the weak/unreadable/ambiguous value with a securely generated one (e.g. openssl rand -hex 32). No secret value or substring was printed.')
}

if (!result.ok) {
    emitSummary()
    process.exit(result.exitCode === RESOLVE_EXIT.USAGE_OR_FILE ? 2 : 1)
}

if (fragmentPath) {
    const fragment = serializeJwtEnvFragment({ accessSecret: result.accessSecret, refreshSecret: result.refreshSource === 'explicit' ? result.effectiveRefreshSecret : undefined })
    try {
        fs.writeFileSync(fragmentPath, fragment, { mode: 0o600 })
    } catch {
        // I/O 错误：固定原因码、不含任何值；shell 侧据此 fail 并清理（见 deploy/lib/jwt-config.sh）
        console.error('[JWT-CONFIG] FRAGMENT_WRITE_FAILED — cannot write the fragment file (reason is fixed; no secret values are printed)')
        process.exit(2)
    }
}

emitSummary()
process.exit(0)
