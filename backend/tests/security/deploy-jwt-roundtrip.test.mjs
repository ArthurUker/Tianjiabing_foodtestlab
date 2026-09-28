// P3-W0-T01-R1 — 部署值流 round-trip 与边界（解析有效值 → 校验 → 序列化 → 真实 dotenv 重载）。
//
// 复用真实共享代码：backend/lib/jwtSecretResolve.js（CLI/deploy 同一选择段）、
// backend/lib/jwtSecretConfig.js（解析/校验/序列化）；重载用**已安装真实 dotenv.parse**，
// 签名兼容用**真实 jsonwebtoken**。不连接数据库、不写真实 .env、不运行 deploy.sh。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
import { resolveJwtConfig, RESOLVE_EXIT } from '../../lib/jwtSecretResolve.js'
import { serializeJwtEnvFragment, deriveRefreshSecret } from '../../lib/jwtSecretConfig.js'

const AUD044_HISTORICAL_EXAMPLE = 'please-run-openssl-rand-hex-32-and-replace-this'
const safeBase64 = () => crypto.randomBytes(48).toString('base64')
const safeHex = () => crypto.randomBytes(32).toString('hex')

let WORK
before(() => { WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'p3w0-r1-roundtrip-')) })
after(() => { fs.rmSync(WORK, { recursive: true, force: true }) })

let counter = 0
const tmpFile = (name) => path.join(WORK, `${++counter}-${name}`)

function resolveFromFile(envFilePath, { envAccess, envRefresh, allowGenerate = true, deployWrite = true } = {}) {
    return resolveJwtConfig({ envAccess, envRefresh, envFilePath, allowGenerate, deployWrite })
}

/** 一次"部署写回 + 进程加载"模拟：resolve → serialize → 真实 dotenv.parse 重载 */
function roundtrip(envFilePath, opts = {}) {
    const resolved = resolveFromFile(envFilePath, opts)
    if (!resolved.ok) return { resolved }
    const fragment = serializeJwtEnvFragment({
        accessSecret: resolved.accessSecret,
        refreshSecret: resolved.refreshSource === 'explicit' ? resolved.effectiveRefreshSecret : undefined,
    })
    const newFile = tmpFile('written.env')
    fs.writeFileSync(newFile, fragment, { mode: 0o600 })
    const reloaded = dotenv.parse(fs.readFileSync(newFile, 'utf8'))
    return { resolved, fragment, newFile, reloaded }
}

describe('R1 — 旧文件语法变体的有效值解析与无损写回', () => {
    const strong = () => safeHex()
    const refreshStrong = () => safeBase64()

    const variants = [
        ['bare', (a, r) => `JWT_SECRET=${a}\nJWT_REFRESH_SECRET=${r}\n`],
        ['double-quoted', (a, r) => `JWT_SECRET="${a}"\nJWT_REFRESH_SECRET="${r}"\n`],
        ['single-quoted', (a, r) => `JWT_SECRET='${a}'\nJWT_REFRESH_SECRET='${r}'\n`],
        ['export+spaces', (a, r) => `export JWT_SECRET = ${a}\nexport JWT_REFRESH_SECRET = ${r}\n`],
        ['trailing-comments', (a, r) => `JWT_SECRET=${a}  # keep\nJWT_REFRESH_SECRET="${r}" # keep\n`],
    ]

    for (const [name, render] of variants) {
        it(`${name}：解析后有效值保持；写回→dotenv 重载一致；重复部署 ≥2 次稳定`, () => {
            const access = strong()
            const refresh = refreshStrong()
            const oldFile = tmpFile(`${name}.env`)
            fs.writeFileSync(oldFile, render(access, refresh))

            // 第一次部署
            const first = roundtrip(oldFile)
            assert.equal(first.resolved.ok, true, JSON.stringify(first.resolved.errors))
            assert.equal(first.resolved.accessSecret, access, 'access 有效值必须等于原值')
            assert.equal(first.resolved.refreshSource, 'explicit')
            assert.equal(first.resolved.effectiveRefreshSecret, refresh)
            assert.equal(first.reloaded.JWT_SECRET, access, 'dotenv 重载后 access 有效值必须一致')
            assert.equal(first.reloaded.JWT_REFRESH_SECRET, refresh)

            // 第二次部署（把写回的文件当旧文件）
            const second = roundtrip(first.newFile)
            assert.equal(second.resolved.ok, true)
            assert.equal(second.resolved.accessSecret, access)
            assert.equal(second.resolved.effectiveRefreshSecret, refresh)
            assert.equal(second.reloaded.JWT_SECRET, access)
        })
    }

    it('新生成值（无文件）同样 round-trip；缺省 refresh 保持派生语义', () => {
        const missing = path.join(WORK, 'does-not-exist.env')
        const first = roundtrip(missing)
        assert.equal(first.resolved.ok, true)
        assert.equal(first.resolved.generatedAccess, true, '确实缺失才生成')
        assert.equal(first.resolved.refreshSource, 'derived')
        assert.equal(first.fragment.split('\n').filter(Boolean).length, 1, '缺省 refresh 不写独立行')
        assert.equal(first.reloaded.JWT_SECRET, first.resolved.accessSecret, '生成值写回后重载一致')
        assert.equal(first.reloaded.JWT_REFRESH_SECRET, undefined)

        const second = roundtrip(first.newFile)
        assert.equal(second.resolved.generatedAccess, false, '第二次部署复用而非重新生成')
        assert.equal(second.resolved.accessSecret, first.resolved.accessSecret)
    })

    it('引号包裹的公开弱值不再绕过（原缺口 1 反转）', () => {
        const quoted = tmpFile('quoted-weak.env')
        fs.writeFileSync(quoted, `JWT_SECRET="${AUD044_HISTORICAL_EXAMPLE}"\n`)
        const r = resolveFromFile(quoted)
        assert.equal(r.ok, false)
        assert.equal(r.exitCode, RESOLVE_EXIT.REJECTED)
        assert.equal(r.errors[0].code, 'KNOWN_WEAK_VALUE', '解析后的有效值必须命中名单')
        assert.equal(r.accessSecret, undefined, '拒绝时不得生成/返回任何值')
        assert.ok(!JSON.stringify(r).includes(AUD044_HISTORICAL_EXAMPLE), '错误结果不得包含原值')
    })

    it('弱值带行尾注释 / 空白填充 → 同样拒绝且不生成', () => {
        for (const content of [
            `JWT_SECRET=${AUD044_HISTORICAL_EXAMPLE}  # looks harmless\n`,
            `JWT_SECRET="  ${AUD044_HISTORICAL_EXAMPLE}  "\n`,
        ]) {
            const f = tmpFile('weak-variant.env')
            fs.writeFileSync(f, content)
            const r = resolveFromFile(f)
            assert.equal(r.ok, false, `should reject: ${JSON.stringify(content)}`)
            assert.notEqual(r.generatedAccess, true, '拒绝时不得生成新值')
            assert.equal(r.accessSecret, undefined)
        }
    })
})

describe('R1 — 真实 jwt.sign/verify 兼容', () => {
    it('保留的 access 值（引号解析后）可直接用于签名与验证；缺省 refresh 派生一致', () => {
        const access = safeHex()
        const oldFile = tmpFile('sign-compat.env')
        fs.writeFileSync(oldFile, `JWT_SECRET = "${access}"\n`) // 引号 + 空格 → 解析后有效值

        const rt = roundtrip(oldFile)
        assert.equal(rt.resolved.ok, true)

        // 用"重载后的有效值"（dotenv 视角）作为签名密钥，验证令牌语义
        const token = jwt.sign({ sub: 'r1-signcheck' }, rt.reloaded.JWT_SECRET, { expiresIn: '5m' })
        const decoded = jwt.verify(token, access)
        assert.equal(decoded.sub, 'r1-signcheck')

        // 缺省 refresh：派生值 = `<access>:refresh`（UserManager 规则镜像）
        assert.equal(rt.resolved.refreshSource, 'derived')
        assert.equal(rt.resolved.effectiveRefreshSecret, deriveRefreshSecret(access))
        const refreshToken = jwt.sign({ type: 'refresh' }, rt.resolved.effectiveRefreshSecret)
        assert.equal(jwt.verify(refreshToken, `${access}:refresh`).type, 'refresh')
    })

    it('显式 refresh 跨两次部署不退回派生', () => {
        const access = safeHex()
        const refresh = safeBase64()
        const f = tmpFile('explicit-refresh.env')
        fs.writeFileSync(f, `JWT_SECRET=${access}\nJWT_REFRESH_SECRET=${refresh}\n`)
        const first = roundtrip(f)
        const second = roundtrip(first.newFile)
        for (const r of [first, second]) {
            assert.equal(r.resolved.refreshSource, 'explicit')
            assert.equal(r.resolved.effectiveRefreshSecret, refresh)
        }
    })
})

describe('R1 — 部署表示限制与运行时合法性分离', () => {
    it('注入值含 空格/#/引号/反斜线/反引号：deployWrite 拒绝，运行时路径（deployWrite=false）通过', () => {
        const cases = [
            `has space ${safeHex()}`,
            `${safeHex()}#hash`,
            `"${safeHex()}"`,
            `'${safeHex()}'`,
            `${safeHex()}\\backslash`,
            `${safeHex()}\`tick\``,
        ]
        for (const value of cases) {
            const asEnv = { envAccess: value, envRefresh: undefined }
            const deployTry = resolveJwtConfig({ ...asEnv, deployWrite: true, allowGenerate: false })
            assert.equal(deployTry.ok, false, `deploy write must reject: ${JSON.stringify(value.slice(0, 12))}…`)
            assert.equal(deployTry.errors[0].code, 'DEPLOY_REPRESENTATION')

            const runtimeTry = resolveJwtConfig({ ...asEnv, deployWrite: false, allowGenerate: false })
            assert.equal(runtimeTry.ok, true, '直接进程环境的合法值不受部署表示限制')
            assert.equal(runtimeTry.accessSecret, value, '运行时值字节不变')
        }
    })

    it('hex/base64 生成值可通过部署表示检查', () => {
        for (const v of [safeHex(), safeBase64()]) {
            const r = resolveJwtConfig({ envAccess: v, deployWrite: true, allowGenerate: false })
            assert.equal(r.ok, true)
        }
    })
})

describe('R1 — 缺失 / 不可读 / 解析错误 / 重复键 区分（错误不得触发生成）', () => {
    it('文件不存在 = 无旧值：允许生成（首次部署）', () => {
        const r = resolveFromFile(path.join(WORK, 'nope.env'), { allowGenerate: true })
        assert.equal(r.ok, true)
        assert.equal(r.generatedAccess, true)
        assert.equal(r.sourceTrace.filePresent, false)
    })

    it('allowGenerate=false 且缺失 → MISSING（不生成）', () => {
        const r = resolveFromFile(path.join(WORK, 'nope2.env'), { allowGenerate: false })
        assert.equal(r.ok, false)
        assert.equal(r.errors[0].code, 'MISSING')
        assert.equal(r.generatedAccess, undefined)
    })

    it('不可读（目录路径）→ ENV_FILE_UNREADABLE，exit 2，且不生成', () => {
        const dir = path.join(WORK, 'a-directory.env')
        fs.mkdirSync(dir, { recursive: true })
        const r = resolveFromFile(dir, { allowGenerate: true })
        assert.equal(r.ok, false)
        assert.equal(r.errors[0].code, 'ENV_FILE_UNREADABLE')
        assert.equal(r.exitCode, RESOLVE_EXIT.USAGE_OR_FILE)
        assert.equal(r.generatedAccess, undefined, '读失败不得被当作缺失而生成')
    })

    it('解析错误 / 重复键 → exit 2，且不生成', () => {
        const dup = tmpFile('dup.env')
        fs.writeFileSync(dup, `JWT_SECRET=${safeHex()}\nJWT_SECRET=${safeHex()}\n`)
        const r1 = resolveFromFile(dup, { allowGenerate: true })
        assert.equal(r1.ok, false)
        assert.equal(r1.errors[0].code, 'DUPLICATE_KEY')
        assert.equal(r1.exitCode, RESOLVE_EXIT.USAGE_OR_FILE)

        const broken = tmpFile('broken.env')
        fs.writeFileSync(broken, 'JWT_SECRET="unterminated\n')
        const r2 = resolveFromFile(broken, { allowGenerate: true })
        assert.equal(r2.ok, false)
        assert.equal(r2.errors[0].code, 'UNTERMINATED_QUOTE')
        assert.equal(r2.generatedAccess, undefined)
    })

    it('含命令替换 canary 的旧值不得被执行，且作为字面量处理', () => {
        const canaryFile = path.join(WORK, 'canary-should-not-exist')
        const f = tmpFile('canary.env')
        fs.writeFileSync(f, `JWT_SECRET="$(touch ${canaryFile})-padded-to-minimum-bytes-0123456789"\n`)
        const r = resolveFromFile(f)
        // 值里含 $(touch ...) 文本但长度足够：解析器不执行任何内容；该值本身也无引号/空格问题
        assert.equal(fs.existsSync(canaryFile), false, '旧值内容不得被作为 shell 代码执行')
        if (r.ok) {
            assert.ok(r.accessSecret.includes('$(touch'), '值应作为字面量保留')
        } else {
            assert.ok(!JSON.stringify(r).includes('touch'), '拒绝输出不得回显值内容')
        }
    })
})

describe('R1 — 优先级：环境 > 旧文件 > 生成（真实共享选择段）', () => {
    it('非空环境值优先于文件值；未设置时使用文件有效值', () => {
        const fileAccess = safeHex()
        const fileRefresh = safeBase64()
        const f = tmpFile('precedence.env')
        fs.writeFileSync(f, `JWT_SECRET=${fileAccess}\nJWT_REFRESH_SECRET=${fileRefresh}\n`)

        const envAccess = safeBase64()
        const withEnv = resolveFromFile(f, { envAccess, envRefresh: undefined })
        assert.equal(withEnv.ok, true)
        assert.equal(withEnv.accessSecret, envAccess, '非空环境值优先')
        assert.equal(withEnv.sourceTrace.envAccessUsed, true)
        assert.equal(withEnv.sourceTrace.fileAccessUsed, false)
        assert.equal(withEnv.effectiveRefreshSecret, fileRefresh, 'refresh 未在环境提供 → 用文件值')

        const withoutEnv = resolveFromFile(f, { envAccess: '', envRefresh: '' })
        assert.equal(withoutEnv.accessSecret, fileAccess, '空字符串视为未提供 → 使用文件有效值')
        assert.equal(withoutEnv.sourceTrace.fileAccessUsed, true)
    })
})
