// P3-W0-T01 / RC-10 (AUD-044) — 共享 JWT 配置校验单元测试 + 缺陷反转回归。
//
// 纯函数测试：不连接数据库、不启动服务、不读取真实 .env。
// 正例样本每次运行由 crypto.randomBytes 安全生成（不把任何公开常量当作生产推荐值）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv' // 真实 dotenv（已安装依赖）：用于验证共享解析子集与序列化 round-trip
import {
    validateJwtConfig,
    classifySecret,
    deriveRefreshSecret,
    parseJwtEnvFileContent,
    assertDeploySerializable,
    serializeJwtEnvFragment,
    KNOWN_WEAK_SECRET_VALUES,
    MIN_SECRET_BYTES,
} from '../../lib/jwtSecretConfig.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const safeBase64 = () => crypto.randomBytes(48).toString('base64') // 64 字符
const safeHex = () => crypto.randomBytes(32).toString('hex') // 64 字符
const fixedBytes = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join('')

// AUD-044 原始缺陷值（.env.example:33 历史公开示例）——反转后必须被拒绝
const AUD044_HISTORICAL_EXAMPLE = 'please-run-openssl-rand-hex-32-and-replace-this'

describe('access secret — 拒绝条件', () => {
    it('缺失 / 空 / 纯空白均拒绝', () => {
        for (const [value, code] of [
            [undefined, 'MISSING'],
            [null, 'MISSING'],
            ['', 'EMPTY_OR_WHITESPACE'],
            ['   ', 'EMPTY_OR_WHITESPACE'],
            ['\t\n', 'EMPTY_OR_WHITESPACE'],
        ]) {
            const r = validateJwtConfig({ accessSecret: value })
            assert.equal(r.ok, false)
            assert.equal(r.errors[0].code, code)
            assert.equal(r.errors[0].field, 'JWT_SECRET')
        }
    })

    it('31 字节拒绝 / 32 字节通过（UTF-8 字节边界）', () => {
        assert.equal(classifySecret(fixedBytes(MIN_SECRET_BYTES - 1)).code, 'TOO_SHORT')
        const ok = classifySecret(fixedBytes(MIN_SECRET_BYTES))
        assert.equal(ok.ok, true)
        assert.equal(ok.bytes, MIN_SECRET_BYTES)
    })

    it('多字节字符按 UTF-8 字节计数', () => {
        assert.equal(classifySecret('测试'.repeat(5)).code, 'TOO_SHORT') // 30 字节
        assert.equal(classifySecret('测试'.repeat(6)).ok, true) // 36 字节
    })

    it('控制字符拒绝（含首尾）', () => {
        assert.equal(classifySecret(`${safeBase64()}\n`).code, 'CONTROL_CHARACTERS')
        assert.equal(classifySecret(`\t${safeBase64()}`).code, 'CONTROL_CHARACTERS')
        assert.equal(classifySecret(`ab\u0000${safeBase64()}`).code, 'CONTROL_CHARACTERS')
    })

    it('单一字符重复串拒绝', () => {
        assert.equal(classifySecret('x'.repeat(64)).code, 'SINGLE_CHAR_REPEAT')
        assert.equal(classifySecret('a'.repeat(200)).code, 'SINGLE_CHAR_REPEAT')
    })

    it('首尾空白拒绝（部署无法无损表示）', () => {
        assert.equal(classifySecret(` ${safeBase64()} `).code, 'WHITESPACE_PADDING')
    })

    it('尖括号文档占位拒绝', () => {
        assert.equal(classifySecret('<put-your-strong-secret-here-32-bytes-min>').code, 'PLACEHOLDER_PATTERN')
    })
})

describe('access secret — 已知公开弱值/占位名单（含 AUD-044 原值）', () => {
    it('名单中的每个值都被拒绝', () => {
        assert.ok(KNOWN_WEAK_SECRET_VALUES.length >= 7)
        for (const v of KNOWN_WEAK_SECRET_VALUES) {
            const r = classifySecret(v)
            assert.equal(r.ok, false, `expected reject: ${JSON.stringify(v)}`)
            assert.equal(r.code, 'KNOWN_WEAK_VALUE')
        }
    })

    it('占位值 + 空白（trim 后命中）同样拒绝', () => {
        for (const v of [AUD044_HISTORICAL_EXAMPLE, 'food-lab-secret-key']) {
            assert.equal(classifySecret(`  ${v}  `).code, 'KNOWN_WEAK_VALUE')
        }
    })

    it('反转回归：AUD-044 历史公开示例必须被拒绝（原缺陷为可启动）', () => {
        const r = validateJwtConfig({ accessSecret: AUD044_HISTORICAL_EXAMPLE })
        assert.equal(r.ok, false)
        assert.equal(r.errors[0].code, 'KNOWN_WEAK_VALUE')
        assert.equal(r.accessSecret, undefined, '失败结果不得包含任何秘密值')
    })

    it('反转回归：当前 .env.example 不再携带可启动的 JWT 示例值', () => {
        const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8')
        const line = envExample.split('\n').find((l) => /^JWT_SECRET=/.test(l))
        assert.ok(line, '.env.example 必须保留 JWT_SECRET 行')
        assert.equal(line.trim(), 'JWT_SECRET=', '模板 access 必须留空（必须由运维安全生成/注入）')
        assert.ok(!envExample.includes(AUD044_HISTORICAL_EXAMPLE), '模板不得再包含历史公开示例值')
    })

    it('不做过宽子串匹配：含 secret/test 子串的随机值仍可通过', () => {
        const v = `${crypto.randomBytes(24).toString('hex')}-secret-test-marker-${crypto.randomBytes(8).toString('hex')}`
        assert.equal(classifySecret(v).ok, true)
    })
})

describe('合法值 — 原样保留（字节不变）', () => {
    it('base64 / hex / 任意非限定 UTF-8 格式正例均通过且严格相等', () => {
        const samples = [safeBase64(), safeHex(), fixedBytes(48) + '中文字节-ok']
        for (const s of samples) {
            const r = validateJwtConfig({ accessSecret: s })
            assert.equal(r.ok, true)
            assert.equal(r.accessSecret, s)
        }
    })

    it('不强制编码、不做 trim/normalize（通过值等于输入字节）', () => {
        const s = `${safeBase64()}==++//` // base64 变体字符
        const r = validateJwtConfig({ accessSecret: s })
        assert.equal(r.accessSecret, s)
    })
})

describe('refresh secret — 缺省派生与显式校验', () => {
    it('未设置 / 恰为空字符串 → 派生（与 UserManager 规则一致）', () => {
        for (const access of [safeBase64(), safeHex()]) {
            for (const missing of [undefined, null, '']) {
                const r = validateJwtConfig({ accessSecret: access, refreshSecret: missing })
                assert.equal(r.ok, true)
                assert.equal(r.refreshSource, 'derived')
                assert.equal(r.effectiveRefreshSecret, deriveRefreshSecret(access))
                assert.equal(r.effectiveRefreshSecret, `${access}:refresh`)
            }
        }
    })

    it('纯空白不是缺省 → 拒绝', () => {
        const r = validateJwtConfig({ accessSecret: safeBase64(), refreshSecret: '   ' })
        assert.equal(r.ok, false)
        assert.equal(r.errors[0].field, 'JWT_REFRESH_SECRET')
        assert.equal(r.errors[0].code, 'EMPTY_OR_WHITESPACE')
    })

    it('短 refresh / 公开示例 refresh 拒绝', () => {
        const short = classifySecret(fixedBytes(31), { field: 'JWT_REFRESH_SECRET' })
        assert.equal(short.code, 'TOO_SHORT')
        const r = validateJwtConfig({ accessSecret: safeBase64(), refreshSecret: AUD044_HISTORICAL_EXAMPLE })
        assert.equal(r.ok, false)
        assert.equal(r.errors[0].field, 'JWT_REFRESH_SECRET')
        assert.equal(r.errors[0].code, 'KNOWN_WEAK_VALUE')
    })

    it('合法显式 refresh → 原样保留（字节相等）', () => {
        const access = safeBase64()
        const refresh = crypto.randomBytes(40).toString('base64')
        const r = validateJwtConfig({ accessSecret: access, refreshSecret: refresh })
        assert.equal(r.ok, true)
        assert.equal(r.refreshSource, 'explicit')
        assert.equal(r.effectiveRefreshSecret, refresh)
        assert.equal(r.accessSecret, access)
    })

    it('access 失败时立即返回、不派生也不泄漏值', () => {
        const canary = `canary-${crypto.randomBytes(6).toString('hex')}`
        const r = validateJwtConfig({ accessSecret: canary, refreshSecret: undefined })
        assert.equal(r.ok, false)
        assert.equal(r.accessSecret, undefined)
        assert.equal(r.effectiveRefreshSecret, undefined)
        assert.equal(r.refreshSource, undefined)
        assert.ok(!JSON.stringify(r).includes(canary), '错误结果不得包含秘密内容')
    })
})

describe('模块边界（无 import 副作用）', () => {
    it('jwtSecretConfig.js 不引入 prisma/express/env 读取', () => {
        const src = fs.readFileSync(path.join(repoRoot, 'backend/lib/jwtSecretConfig.js'), 'utf8')
        const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        assert.ok(!/from ['"].*(prisma|express)/i.test(codeOnly), '不得 import prisma/express')
        assert.ok(!/prisma/i.test(codeOnly), '代码（非注释）中不得出现 prisma')
        assert.ok(!/process\.env/.test(codeOnly), '模块本身不读取 process.env（值由调用方传入）')
    })

    it('jwtSecretResolve.js 只使用 node 内置模块且不读 process.env', () => {
        const src = fs.readFileSync(path.join(repoRoot, 'backend/lib/jwtSecretResolve.js'), 'utf8')
        const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        const imports = [...codeOnly.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
        for (const spec of imports) {
            assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'), `不得依赖外部包：${spec}`)
        }
        assert.ok(!/process\.env/.test(codeOnly), '模块本身不读取 process.env（值由调用方传入）')
    })
})

// ── P3-W0-T01-R1：env 文件有效值解析 ──
describe('env 文件有效值解析（dotenv 子集；含与真实 dotenv.parse 对照）', () => {
    it('裸值 / 双引号 / 单引号 / export / 键周边空格 / 行尾注释', () => {
        const content = [
            '  # comment line',
            'export JWT_SECRET = bareValueWithEnoughBytes0123456789',
            'JWT_REFRESH_SECRET="explicit refresh value with enough bytes"   # trailing comment',
            '',
            'OTHER_KEY=ignored',
        ].join('\n')
        const r = parseJwtEnvFileContent(content)
        assert.equal(r.ok, true)
        assert.equal(r.values.JWT_SECRET, 'bareValueWithEnoughBytes0123456789')
        assert.equal(r.values.JWT_REFRESH_SECRET, 'explicit refresh value with enough bytes')

        const single = parseJwtEnvFileContent("JWT_SECRET='single quoted value with enough bytes 123'")
        assert.equal(single.values.JWT_SECRET, 'single quoted value with enough bytes 123')
    })

    it('裸值在第一个 # 处截断并 trim（dotenv 语义）', () => {
        const r = parseJwtEnvFileContent('JWT_SECRET=abc123#not-a-comment  \n')
        assert.equal(r.values.JWT_SECRET, 'abc123')
    })

    it('与真实 dotenv.parse 在受支持子集上一致', () => {
        const samples = [
            'JWT_SECRET=bare value-ish token 0123456789abcdef\n',
            'JWT_SECRET="quoted value 0123456789abcdefghij"\n',
            "JWT_SECRET='single quoted 0123456789abcdefghij'\n",
            'export JWT_SECRET=exported value 0123456789abcdef\n',
            'JWT_SECRET = spaced value 0123456789abcdef  # comment\n',
            'JWT_SECRET=trailing#hash 0123456789abcdef\n',
            'JWT_SECRET="x" # c\nJWT_REFRESH_SECRET=y 0123456789abcdefghij\n',
        ]
        for (const s of samples) {
            const mine = parseJwtEnvFileContent(s)
            const theirs = dotenv.parse(s)
            assert.equal(mine.ok, true, `shared parser should accept: ${JSON.stringify(s)}`)
            assert.deepEqual(mine.values, theirs, `must match dotenv.parse for: ${JSON.stringify(s)}`)
        }
    })

    it('重复键 / 未闭合引号 / 引号后多余内容 / 转义 / 反引号 / 提及键的怪行 → 明确拒绝', () => {
        const cases = [
            ['JWT_SECRET=a\nJWT_SECRET=b\n', 'DUPLICATE_KEY'],
            ['JWT_SECRET="unterminated\n', 'UNTERMINATED_QUOTE'],
            ['JWT_SECRET="value" extra\n', 'TRAILING_CONTENT'],
            ['JWT_SECRET="esc\\naped"\n', 'ESCAPE_NOT_SUPPORTED'],
            ['JWT_SECRET=`template`\n', 'TEMPLATE_QUOTE_NOT_SUPPORTED'],
            ['JWT_SECRET : not-supported-syntax\n', 'UNPARSEABLE_LINE'],
        ]
        for (const [content, code] of cases) {
            const r = parseJwtEnvFileContent(content)
            assert.equal(r.ok, false, `should reject: ${JSON.stringify(content)}`)
            assert.ok(r.errors.some((e) => e.code === code), `expected ${code}, got ${JSON.stringify(r.errors)}`)
        }
    })

    it('CRLF、空行与注释行不影响解析；非 JWT 键被忽略', () => {
        const r = parseJwtEnvFileContent('A=1\r\n# c\r\nJWT_SECRET=crlf value with enough bytes 012\r\n')
        assert.equal(r.ok, true)
        assert.equal(r.values.JWT_SECRET, 'crlf value with enough bytes 012')
        assert.deepEqual(Object.keys(r.values), ['JWT_SECRET'])
    })
})

// ── P3-W0-T01-R1：部署表示检查与序列化 ──
describe('部署表示检查与序列化', () => {
    it('含空格/#/引号/反斜线/反引号的值 → DEPLOY_REPRESENTATION（仅部署写回路径）', () => {
        for (const bad of ['a b', 'has#hash', 'has"quote', "has'quote", 'has\\backslash', 'has`tick`']) {
            const r = assertDeploySerializable(`${bad}${'x'.repeat(40)}`)
            assert.equal(r.ok, false, `should reject for deploy write: ${JSON.stringify(bad)}`)
            assert.equal(r.code, 'DEPLOY_REPRESENTATION')
        }
    })

    it('hex / base64 与常见合法值通过表示检查', () => {
        assert.equal(assertDeploySerializable(safeHex()).ok, true)
        assert.equal(assertDeploySerializable(safeBase64()).ok, true)
    })

    it('序列化结果可被真实 dotenv.parse 无损重载；refresh 缺省时只写 access 行', () => {
        const access = safeHex()
        const withRefresh = serializeJwtEnvFragment({ accessSecret: access, refreshSecret: safeBase64() })
        const parsed = dotenv.parse(withRefresh)
        assert.equal(parsed.JWT_SECRET, access)
        assert.ok(parsed.JWT_REFRESH_SECRET)

        const derivedOnly = serializeJwtEnvFragment({ accessSecret: access })
        assert.equal(derivedOnly.split('\n').filter(Boolean).length, 1)
        assert.equal(dotenv.parse(derivedOnly).JWT_REFRESH_SECRET, undefined)
    })
})
