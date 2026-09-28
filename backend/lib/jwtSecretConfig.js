/**
 * P3-W0-T01 / RC-10 (AUD-044) — JWT access/refresh 配置校验（单一事实源）。
 *
 * 纯函数层：不连接数据库、不启动任务、不读取 process.env（值由调用方传入），
 * 因而可被 server.js 启动校验、deploy 薄 CLI 与正式测试共用同一规则。
 *
 * 规则（RC-10 契约）：
 *  - 表示方式：沿用 JWT 库接收的原始 UTF-8 字符串；不 trim / 不 normalize / 不解码用于签名。
 *  - 校验成功时**原样返回**原始字节，保证既有合法强密钥的令牌语义不变。
 *  - 最小 32 UTF-8 字节（按原始值计）。
 *  - 拒绝：缺失、空/纯空白、控制字符、单一字符重复串、已知公开弱值/占位/示例值
 *    （名单匹配使用 trim 后值，因此"占位值 + 空白"同样被拒）；尖括号文档占位（<...>）同样拒绝。
 *  - 不强制编码格式；不以字符种类或估算熵宣称随机性。
 *  - refresh：未设置或恰为空字符串 → 保留 UserManager 的 `${access}:refresh` 派生并校验最终值；
 *    纯空白不是缺省（按显式值校验）。不新增"两值必须不同"的独立策略。
 */

export const MIN_SECRET_BYTES = 32

/**
 * 已知公开弱值/占位/示例值（来源见注释；限定检索范围：仓库受支持的配置/部署/文档模板）。
 * 匹配方式：trim 后精确相等（不做子串匹配，避免误伤随机值）。
 */
export const KNOWN_WEAK_SECRET_VALUES = [
    // 原 server.js KNOWN_WEAK_SECRETS（5 项，P0-12 引入）
    'your-super-secret-jwt-key-change-this-in-production',
    'your-secret-key-change-in-production',
    'local-dev-jwt-secret',
    'food-lab-secret-key',
    'please_change_this_secret',
    // .env.example 原 JWT_SECRET 示例值（AUD-044 直接证据，.env.example:33）
    'please-run-openssl-rand-hex-32-and-replace-this',
    // README.md:1304 文档示例（尖括号占位明文，用户可能整行照抄）
    '<自行生成的强随机串，勿用弱密钥黑名单值>',
]

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/
const ANGLE_PLACEHOLDER_RE = /^<.*>$/

/**
 * 校验单个密钥字符串（access 与显式 refresh 共用）。
 * @param {unknown} rawValue 原始值（调用方直接传入环境值，不做任何预处理）
 * @param {{ field?: string }} [opts]
 * @returns {{ ok: true, value: string, bytes: number } | { ok: false, field: string, code: string, reason: string }}
 *          失败分支**不包含**任何秘密内容。
 */
export function classifySecret(rawValue, { field = 'JWT_SECRET' } = {}) {
    const fail = (code, reason) => ({ ok: false, field, code, reason })

    if (rawValue === undefined || rawValue === null) {
        return fail('MISSING', 'required secret is not set')
    }
    if (typeof rawValue !== 'string') {
        return fail('INVALID_TYPE', 'secret must be a string')
    }
    const trimmed = rawValue.trim()
    if (trimmed === '') {
        return fail('EMPTY_OR_WHITESPACE', 'secret is empty or whitespace-only')
    }
    if (CONTROL_CHAR_RE.test(rawValue)) {
        return fail('CONTROL_CHARACTERS', 'secret contains control characters')
    }
    if (KNOWN_WEAK_SECRET_VALUES.includes(trimmed)) {
        return fail('KNOWN_WEAK_VALUE', 'secret matches a publicly known placeholder/example value')
    }
    if (ANGLE_PLACEHOLDER_RE.test(trimmed)) {
        return fail('PLACEHOLDER_PATTERN', 'secret looks like a documentation placeholder (<...>)')
    }
    if (rawValue !== trimmed) {
        // .env 与 systemd EnvironmentFile 都会丢失首尾空白 → 不能无损表示，
        // 明确拒绝而不是悄悄使用被 trim 后的值（那会改变有效密钥）。
        return fail('WHITESPACE_PADDING', 'secret has leading/trailing whitespace and cannot be represented losslessly in .env / systemd EnvironmentFile')
    }
    if (new Set(trimmed).size === 1) {
        return fail('SINGLE_CHAR_REPEAT', 'secret is a single repeated character')
    }
    const bytes = Buffer.byteLength(rawValue, 'utf8')
    if (bytes < MIN_SECRET_BYTES) {
        return fail('TOO_SHORT', `secret is shorter than ${MIN_SECRET_BYTES} UTF-8 bytes`)
    }
    return { ok: true, value: rawValue, bytes }
}

/** UserManager.getRefreshSecret() 的派生规则（本模块不改变该行为，仅做只读镜像以便校验）。 */
export function deriveRefreshSecret(accessSecret) {
    return `${accessSecret}:refresh`
}

/**
 * 校验完整 JWT 配置。
 * @param {{ accessSecret: unknown, refreshSecret?: unknown }} input
 * @returns {{
 *   ok: boolean,
 *   accessSecret?: string,
 *   effectiveRefreshSecret?: string,
 *   refreshSource?: 'explicit' | 'derived',
 *   errors: Array<{ field: string, code: string, reason: string }>
 * }}
 *   ok=false 时不返回任何秘密值；ok=true 时 accessSecret/effectiveRefreshSecret 与输入字节完全一致。
 */
export function validateJwtConfig({ accessSecret, refreshSecret } = {}) {
    const errors = []
    const access = classifySecret(accessSecret, { field: 'JWT_SECRET' })
    if (!access.ok) {
        errors.push({ field: access.field, code: access.code, reason: access.reason })
        return { ok: false, errors }
    }

    // 未设置或恰为空字符串 → 缺省（保留派生的设计语义）；纯空白不是缺省。
    const isDefaulted = refreshSecret === undefined || refreshSecret === null || refreshSecret === ''
    if (isDefaulted) {
        const derived = deriveRefreshSecret(access.value)
        const check = classifySecret(derived, { field: 'JWT_REFRESH_SECRET' })
        if (!check.ok) {
            errors.push({ field: check.field, code: check.code, reason: `derived refresh secret is invalid: ${check.reason}` })
            return { ok: false, errors }
        }
        return {
            ok: true,
            accessSecret: access.value,
            effectiveRefreshSecret: derived,
            refreshSource: 'derived',
            errors,
        }
    }

    const refresh = classifySecret(refreshSecret, { field: 'JWT_REFRESH_SECRET' })
    if (!refresh.ok) {
        errors.push({ field: refresh.field, code: refresh.code, reason: refresh.reason })
        return { ok: false, errors }
    }
    return {
        ok: true,
        accessSecret: access.value,
        effectiveRefreshSecret: refresh.value,
        refreshSource: 'explicit',
        errors,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// P3-W0-T01-R1 — JWT 专用 .env 子集解析 / 部署表示检查 / 序列化（无外部依赖）。
//
// 为什么需要：文件语法不是 secret 本身。必须先解析出"运行时有效值"（去引号、去行尾
// 注释、trim 裸值），再交给上面的强度规则；否则校验的字符串与 dotenv 实际加载的
// 字符串可能不同（例如 `JWT_SECRET="<公开示例值>"` 会绕过名单、写回后才被去引号）。
//
// 支持子集（与 dotenv 在受支持子集上一致；测试用真实 dotenv.parse 对照）：
//   - 行首缩进；可选 `export ` 前缀；`KEY = value`（键与 '=' 周边允许空白）
//   - 值形式：裸值（在第一个 '#' 前截断并 trim）、配对双引号、配对单引号
//   - 引号之后只允许空白或行尾注释
// 明确拒绝（不做猜测、不静默取首值）：重复声明、引号未闭合、引号后多余内容、
//   反斜线转义、反引号包裹、以及"提到 JWT 键但不符合语法"的行。
// ─────────────────────────────────────────────────────────────────────────────

export const JWT_ENV_KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET']

const ENV_KEY_LINE_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/
const JWT_KEY_MENTION_RE = /\bJWT_(?:SECRET|REFRESH_SECRET)\b/

/** 解析单个值（已去掉 `KEY=` 前缀的右侧内容），返回有效值或明确拒绝原因。 */
function parseEnvValue(rawRight) {
    const leadTrimmed = rawRight.replace(/^[ \t]+/, '')
    if (leadTrimmed === '') return { ok: true, value: '' }

    const quote = leadTrimmed[0]
    if (quote === '`') {
        return { ok: false, code: 'TEMPLATE_QUOTE_NOT_SUPPORTED', reason: 'backtick-quoted values are outside the supported subset' }
    }
    if (quote === '"' || quote === "'") {
        const body = leadTrimmed.slice(1)
        let end = -1
        for (let i = 0; i < body.length; i++) {
            const ch = body[i]
            if (ch === '\\') {
                // dotenv 会对双引号内的 \n / \r 做展开：为避免"校验值 ≠ 运行值"，明确拒绝任何转义。
                return { ok: false, code: 'ESCAPE_NOT_SUPPORTED', reason: 'escaped characters inside quoted values are outside the supported subset' }
            }
            if (ch === quote) { end = i; break }
        }
        if (end === -1) {
            return { ok: false, code: 'UNTERMINATED_QUOTE', reason: `unterminated ${quote === '"' ? 'double' : 'single'} quote in value` }
        }
        const rest = body.slice(end + 1)
        if (!/^[ \t]*(?:#.*)?$/.test(rest)) {
            return { ok: false, code: 'TRAILING_CONTENT', reason: 'unexpected content after the closing quote' }
        }
        return { ok: true, value: body.slice(0, end) }
    }

    // 裸值：dotenv 在第一个 '#' 处截断，然后 trim
    const hashIdx = rawRight.indexOf('#')
    const bare = (hashIdx === -1 ? rawRight : rawRight.slice(0, hashIdx)).trim()
    return { ok: true, value: bare }
}

/**
 * 解析 .env 文本中的 JWT 两键**有效值**（不执行任何内容）。
 * @param {string} content
 * @returns {{ ok: boolean, values: Record<string, string>, errors: Array<{ key?: string, line?: number, code: string, reason: string }> }}
 *   ok=false 时 errors 含每个被拒原因；values 仅含成功解析的键（调用方在 ok=false 时不得使用）。
 */
export function parseJwtEnvFileContent(content) {
    const values = {}
    const errors = []
    const seen = new Set()
    const lines = String(content).split(/\r?\n/)

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (/^[ \t]*$/.test(line) || /^[ \t]*#/.test(line)) continue

        const m = ENV_KEY_LINE_RE.exec(line)
        if (!m) {
            if (JWT_KEY_MENTION_RE.test(line)) {
                errors.push({ line: i + 1, code: 'UNPARSEABLE_LINE', reason: 'line mentions a JWT key but does not match the supported KEY=value syntax' })
            }
            continue
        }
        const key = m[1]
        if (!JWT_ENV_KEYS.includes(key)) continue
        if (seen.has(key)) {
            errors.push({ key, line: i + 1, code: 'DUPLICATE_KEY', reason: 'duplicate JWT key declaration' })
            continue
        }
        seen.add(key)
        const parsed = parseEnvValue(m[2])
        if (!parsed.ok) {
            errors.push({ key, line: i + 1, code: parsed.code, reason: parsed.reason })
            continue
        }
        values[key] = parsed.value
    }
    return { ok: errors.length === 0, values, errors }
}

/**
 * 部署表示检查：写回未加引号的 `.env` 行时，下列字符不能证明在 dotenv 与
 * systemd EnvironmentFile 之间无损（会去引号/截断/解释转义），必须**在写回前**拒绝，
 * 而不是静默删改。**仅用于部署写回路径**：直接来自进程环境的合法值不受此限制。
 */
const DEPLOY_UNSAFE_RE = /[#'"`\\]|\s/

export function assertDeploySerializable(value, { field = 'JWT_SECRET' } = {}) {
    if (typeof value !== 'string' || DEPLOY_UNSAFE_RE.test(value)) {
        return {
            ok: false,
            field,
            code: 'DEPLOY_REPRESENTATION',
            reason: 'value contains characters (space/#/quote/backslash/backtick) that cannot be proven lossless as an unquoted .env / systemd EnvironmentFile line',
        }
    }
    return { ok: true }
}

/**
 * 序列化 `.env` 片段（未加引号的行）。调用方必须先对每个值通过 assertDeploySerializable。
 * refresh 为空（缺省/派生）时只输出 access 行，保持"未设置 = 派生"语义。
 */
export function serializeJwtEnvFragment({ accessSecret, refreshSecret } = {}) {
    const lines = [`JWT_SECRET=${accessSecret}`]
    if (refreshSecret !== undefined && refreshSecret !== null && refreshSecret !== '') {
        lines.push(`JWT_REFRESH_SECRET=${refreshSecret}`)
    }
    return lines.join('\n') + '\n'
}
