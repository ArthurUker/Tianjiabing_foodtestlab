/**
 * securityGuards.js — 窗口3「资源访问控制与外围加固」纯函数集合
 *
 * 抽为独立模块的原因：server.js 启动即监听端口 + 初始化 Prisma，无法被单测直接
 * import；此处全部为零副作用纯函数，可被 Jest 直接覆盖（tests/securityGuards.test.js）。
 *
 * 包含：
 *   - canModifyRecord          DS3-C1  记录归属校验（方案甲）
 *   - maskGuestSensitiveFields DS3-M6  guest 响应字段级脱敏
 *   - isSafeLogoUrl            DS3-M4/M5  Logo URL 校验（base64 魔数 + 可选外链域名白名单）
 *   - corsConfigHasWildcard    首轮 M5  CORS 通配符启动校验
 */

// ====== DS3-C1（方案甲）: 记录归属校验 ======
// operator 仅能修改/删除自己创建（created_by === userId）的记录；
// manager/admin 保留全校监督权限；
// 存量 created_by 为 NULL 的记录（无法追溯创建者）仅 manager/admin 可操作。
const RECORD_SUPERVISOR_ROLES = new Set(['manager', 'admin'])

export function canModifyRecord(user, record) {
    if (!user || !record) return false
    if (RECORD_SUPERVISOR_ROLES.has(user.role)) return true
    return !!record.created_by && record.created_by === user.userId
}

// ====== DS3-M6: guest 响应字段级脱敏 ======
// 业务决策：guest 为纯只读角色（从不创建记录），按 created_by 过滤会导致 guest 永远
// 无数据可看，与访客统计看板（GuestDashboard 全校汇总）的产品定位矛盾，故选「方式2：
// 字段级脱敏」—— guest 可见全校汇总数据，但 PII（联系方式/证件号/人名）做部分掩码，
// 检测结果类字段保持可见。
const GUEST_PII_KEY_RE = /(phone|mobile|tel(?:ephone)?|contact|fax|wechat|weixin|e-?mail|id_?card|identity|passport|手机|电话|联系|微信|邮箱|身份证|证件)/i

// 人名/账号类字段（部分掩码，如 张三 → 张*）
const GUEST_NAME_KEYS = new Set([
    'inspector', 'sampler', 'submitter', 'reporter', 'handler',
    'importUser', 'username', 'full_name', 'fullName', 'created_by'
])

export function maskPiiString(value) {
    const s = String(value)
    if (!s.trim()) return s
    const digits = s.replace(/\D/g, '')
    // 手机号/证件号等长数字串：保留前3后2
    if (digits.length >= 7) return `${s.slice(0, 3)}****${s.slice(-2)}`
    const chars = Array.from(s)
    if (chars.length <= 1) return '*'
    return chars[0] + '*'.repeat(Math.min(chars.length - 1, 3))
}

function isMaskableKey(key) {
    return GUEST_PII_KEY_RE.test(key) || GUEST_NAME_KEYS.has(key)
}

export function maskGuestSensitiveFields(value, depth = 0) {
    if (depth > 8 || value === null || value === undefined) return value
    if (value instanceof Date) return value
    if (Array.isArray(value)) return value.map(item => maskGuestSensitiveFields(item, depth + 1))
    if (typeof value !== 'object') return value
    const out = {}
    for (const [k, v] of Object.entries(value)) {
        if (isMaskableKey(k) && (typeof v === 'string' || typeof v === 'number')) {
            out[k] = maskPiiString(v)
        } else {
            out[k] = maskGuestSensitiveFields(v, depth + 1)
        }
    }
    return out
}

// ====== DS3-M4: data:image base64 魔数校验 ======
// 仅校验 MIME 前缀可被伪装（声明 png 实为任意内容）。当前渲染方式为 <img src>，
// 非法内容只会渲染失败而非执行脚本，属数据完整性问题；此处解码前若干字节比对魔数，
// 与声明类型不符即拒绝。
const DATA_IMAGE_PREFIX_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/i

const IMAGE_MAGIC_CHECKS = {
    png:  (at) => at(0, [0x89, 0x50, 0x4E, 0x47]),                      // \x89PNG
    jpeg: (at) => at(0, [0xFF, 0xD8, 0xFF]),
    jpg:  (at) => at(0, [0xFF, 0xD8, 0xFF]),
    gif:  (at) => at(0, [0x47, 0x49, 0x46, 0x38]),                      // GIF8
    webp: (at) => at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]) // RIFF....WEBP
}

export function matchesImageMagic(declaredType, base64Head) {
    const check = IMAGE_MAGIC_CHECKS[String(declaredType || '').toLowerCase()]
    if (!check) return false
    let head
    try {
        head = Buffer.from(String(base64Head || ''), 'base64')
    } catch {
        return false
    }
    const at = (offset, bytes) =>
        head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b)
    return check(at)
}

// ====== DS3-M5: 外链域名白名单（可选） ======
// 已知限制：http(s) 外链由前端 <img> 直接加载，可被用作访客 IP 探测/追踪探针
//（后端从不出站抓取该 URL，无 SSRF；见 server.js DS-09 核查结论）。
// 部署方可通过 LOGO_ALLOWED_HOSTS=cdn.example.com,img.example.org 收紧为域名白名单
//（含子域）；未配置时保持向后兼容放行任意 http(s) 外链，该限制已在此记录。
function parseLogoAllowedHosts() {
    return (process.env.LOGO_ALLOWED_HOSTS || '')
        .split(',')
        .map(h => h.trim().toLowerCase())
        .filter(Boolean)
}

// DS-09/DS-12/DS3-M4/DS3-M5: Logo/校徽 URL 白名单校验
//   - http(s)：限长 2048；若配置 LOGO_ALLOWED_HOSTS 则强制域名白名单（含子域）
//   - data:image 位图 base64：限 1MB；MIME 前缀 + 解码魔数双重校验；禁止 SVG（可携带脚本）
export function isSafeLogoUrl(url) {
    if (typeof url !== 'string') return false

    if (/^https?:\/\//i.test(url)) {
        if (url.length > 2048) return false
        const allowedHosts = parseLogoAllowedHosts()
        if (allowedHosts.length === 0) return true
        try {
            const host = new URL(url).hostname.toLowerCase()
            return allowedHosts.some(h => host === h || host.endsWith(`.${h}`))
        } catch {
            return false
        }
    }

    const m = DATA_IMAGE_PREFIX_RE.exec(url)
    if (m) {
        if (url.length > 1024 * 1024) return false // base64 上限约 1MB
        // 取前 32 个 base64 字符（解码 24 字节）做魔数比对，避免整体解码大载荷
        const head = url.slice(m[0].length, m[0].length + 32)
        return matchesImageMagic(m[1], head)
    }

    // 明确拒绝其余协议（含 data:image/svg+xml、javascript: 等）
    return false
}

// ====== 首轮 M5: CORS 通配符检测 ======
// 服务端恒开 credentials:true，「Allow-Origin: *」+「Allow-Credentials: true」是
// 无效且危险组合；不能依赖浏览器拒绝该组合，须在服务端启动期强制拦截。
// 任何含 '*' 的条目（含 https://*.example.com 形式，精确匹配下永不生效）一律视为误配。
export function corsConfigHasWildcard(raw) {
    if (!raw) return false
    return String(raw)
        .split(',')
        .map(s => s.trim())
        .some(entry => entry.includes('*'))
}
