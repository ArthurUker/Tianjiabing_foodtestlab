/**
 * UserManager - 用户管理模块 (Prisma + PostgreSQL, Schema-per-tenant)
 * 处理用户注册、登录、密码管理等业务逻辑
 */

import { randomUUID } from 'crypto'
import bcryptjs from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createTenantClient } from '../lib/tenantClient.js'
import { writeTenantAuditLog, writeSystemLog } from '../lib/auditLog.js'
// IF-1（窗口1↔窗口2 接线）：高危操作（禁用/删除/改角色/重置密码）后吊销目标用户全部会话。
// 窗口1 实际导出名为 revokeAllUserTokens（此前 TODO 注释误写为 revokeUserTokens）。
import { revokeAllUserTokens } from '../middleware/authMiddleware.js'

/**
 * 解析 JWT 有效期表达式（如 '7d' / '12h' / '3600' / '30m'）为秒数。
 * 解析失败或为空时回退到 7 天，避免 NaN 进入前端 expiresIn。
 */
function parseJwtExpirySeconds(expr) {
    const raw = String(expr || '7d').trim().toLowerCase()
    const match = raw.match(/^(\d+)\s*([smhdw]?)$/)
    if (!match) return 7 * 24 * 3600
    const value = parseInt(match[1], 10)
    const unit = match[2]
    const multiplier = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit]
    return value * multiplier
}

/**
 * 归一化有效期表达式：env 值合法则用 env 值，否则回退 fallback，
 * 防止非法 env（如 'abc'）直接传入 jwt.sign 抛错。
 */
const EXPIRY_RE = /^\d+\s*[smhdw]?$/i
function normalizeExpiry(expr, fallback) {
    const raw = String(expr || '').trim()
    return EXPIRY_RE.test(raw) ? raw : fallback
}

// DS3-M3 / DS-15: 假哈希（bcrypt cost=10），用于「用户不存在 / 租户不匹配 / 账号锁定」
// 分支执行等时长的假比较，拉平各失败路径的响应时间，防时序侧信道探测。
const FAKE_BCRYPT_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

export class UserManager {
    constructor(prismaClient, jwtSecret) {
        this.prisma = prismaClient
        this.rootPrisma = prismaClient
        this.jwtSecret = jwtSecret
        this.schoolCode = null // 由 forTenant() 注入，用于写入 school_code
    }

    /**
     * 返回一个绑定到指定学校 schema 的 UserManager 副本（方案②）。
     * 副本的 this.prisma 为请求级租户客户端，所有查询落在 schoolCode 对应的 schema（schoolCode 即 schema 名，如 school-a）。
     * 不传 schoolCode 时返回自身（dev/test 共享 schema）。
     */
    forTenant(schoolCode) {
        if (!schoolCode) return this
        const tenantClient = createTenantClient(this.prisma, schoolCode)
        const clone = Object.create(UserManager.prototype)
        Object.assign(clone, this, {
            prisma: tenantClient,
            schoolCode
        })
        return clone
    }

    // ====== User Registration ======

    isStrongPassword(password) {
        if (!password) {
            return false
        }
        return /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(password)
    }

    /**
     * 签发 access token。
     * 【H2】payload 携带 jti（crypto.randomUUID），供吊销表（public.revoked_tokens）精确吊销。
     * 【DS3-H1 破坏性变更】access token TTL 从 JWT_EXPIRE（默认 7d）缩短为
     * JWT_ACCESS_EXPIRE（默认 30m）；长会话由一次性轮转的 refresh token（7d）维持。
     * 注意：JWT_EXPIRE 不再作用于员工 access token（访客令牌 guestRoutes 仍沿用）。
     */
    buildAccessToken(user) {
        const payload = {
            userId: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            schoolCode: user.school_code || user.schoolCode || this.schoolCode || null,
            jti: randomUUID()
        }
        const expiry = normalizeExpiry(process.env.JWT_ACCESS_EXPIRE, '30m')
        const token = jwt.sign(payload, this.jwtSecret, { expiresIn: expiry })
        return { token, expiresIn: parseJwtExpirySeconds(expiry), jti: payload.jti }
    }

    /**
     * refresh token 独立密钥（DS-02）：优先 JWT_REFRESH_SECRET，
     * 未配置时从 access 密钥派生（保证两者不同，access/refresh 不能互换验签）。
     */
    getRefreshSecret() {
        return process.env.JWT_REFRESH_SECRET || `${this.jwtSecret}:refresh`
    }

    /**
     * 签发 refresh token（DS3-H1）：type:'refresh' + jti + 独立密钥，TTL 默认 7d。
     * payload 最小化（不带 role/email），刷新时一律以 DB 权威数据重建 access token。
     * P0-1C: 可选 deviceId claim——「记住我」同设备绑定：仅当登录/刷新请求携带
     * X-Device-Id 时写入，后续刷新必须携带同一 deviceId 才能轮转（缓解 XSS 窃取
     * refresh token 后跨设备兑换的 DS-17 风险）。老 token 无该 claim → 不强制校验（向后兼容）。
     */
    buildRefreshToken(user, deviceId = null) {
        const payload = {
            userId: user.id,
            schoolCode: user.school_code || user.schoolCode || this.schoolCode || null,
            type: 'refresh',
            jti: randomUUID()
        }
        if (deviceId) payload.deviceId = String(deviceId).slice(0, 128)
        const expiry = normalizeExpiry(process.env.JWT_REFRESH_EXPIRE, '7d')
        const refreshToken = jwt.sign(payload, this.getRefreshSecret(), { expiresIn: expiry })
        return { refreshToken, refreshExpiresIn: parseJwtExpirySeconds(expiry), jti: payload.jti }
    }

    /**
     * 签发 access + refresh 双令牌对（登录 / 刷新轮转共用）。
     * @param {object} user
     * @param {string|null} [deviceId] P0-1C 设备指纹
     */
    buildTokenPair(user, deviceId = null) {
        const { token, expiresIn } = this.buildAccessToken(user)
        const { refreshToken, refreshExpiresIn } = this.buildRefreshToken(user, deviceId)
        return { token, expiresIn, refreshToken, refreshExpiresIn }
    }

    /**
     * 校验 refresh token（DS3-H1）：独立密钥 + HS256 白名单 + type/jti/userId 强制。
     * 失败抛出带 code 的 Error（REFRESH_INVALID / REFRESH_PAYLOAD_INVALID）。
     */
    verifyRefreshToken(refreshToken) {
        let decoded
        try {
            decoded = jwt.verify(refreshToken, this.getRefreshSecret(), { algorithms: ['HS256'] })
        } catch (e) {
            const err = new Error('Refresh token 无效或已过期')
            err.code = 'REFRESH_INVALID'
            throw err
        }
        // 类型隔离：access token（无 type）不得当 refresh token 用；
        // 无 jti 的旧版 refresh token 无法参与一次性轮转，一律拒绝。
        if (decoded?.type !== 'refresh' || !decoded.jti || !decoded.userId) {
            const err = new Error('Refresh token 载荷无效')
            err.code = 'REFRESH_PAYLOAD_INVALID'
            throw err
        }
        return decoded
    }

    /**
     * DS3-M2: 账号级失败锁定判定。
     * 以租户 AuditLog 的 login_failed 记录为共享计数源（DB 存储，多实例一致），
     * 时间窗口内失败次数达到阈值即视为锁定。锁定期间的尝试不再追加 login_failed，
     * 避免攻击者持续尝试导致合法用户被无限锁定（DoS）。
     * 计数查询失败时 fail-open（不锁定），避免日志故障导致全员无法登录。
     */
    async isAccountLocked(userId) {
        // 开发/测试环境放宽账号锁定阈值（避免反复调试被 423 锁死）；生产环境保持严格。
        const isProduction = process.env.NODE_ENV === 'production'
        const windowMs = Number(process.env.LOGIN_FAIL_LOCK_WINDOW_MS || 15 * 60 * 1000)
        const threshold = Number(process.env.LOGIN_FAIL_LOCK_THRESHOLD || (isProduction ? 5 : 1000))
        try {
            const failures = await this.prisma.auditLog.count({
                where: {
                    user_id: userId,
                    action: 'login_failed',
                    created_at: { gte: new Date(Date.now() - windowMs) }
                }
            })
            return failures >= threshold
        } catch (error) {
            console.error(`❌ 账号锁定计数查询失败: ${error.message}`)
            return false
        }
    }

    /**
     * IF-1: 高危操作后吊销目标用户全部会话（access + refresh 立即失效）。
     * 吊销落 public.revoked_tokens（共享存储），由 authenticateUser 的
     * isTokenRevoked(user_all) 校验生效。
     * 业务操作已提交后才调用本函数：吊销写入失败不回滚业务，但必须落
     * SECURITY:REVOCATION_WRITE_FAILED 安全事件并高声告警（此时降权/改密
     * 的即时失效退化为「access TTL（默认 30m）内自然过期」）。
     */
    async revokeUserSessions(userId, reason, actor = null) {
        try {
            await revokeAllUserTokens(this.rootPrisma, {
                userId,
                schoolCode: this.schoolCode || null,
                reason
            })
        } catch (error) {
            console.error(`❌ [revocation] 吊销用户 ${userId} 全部会话失败 (${reason}): ${error.message}`)
            await this.logSecurityEvent('REVOCATION_WRITE_FAILED', {
                userId,
                reason,
                actorId: actor?.userId || null,
                error: error.message
            })
        }
    }

    /**
     * 记录安全事件（落 public.SystemLog，供审计模块/窗口 2 消费）。
     */
    async logSecurityEvent(eventCode, context) {
        try {
            await writeSystemLog(this.rootPrisma, {
                level: 'error',
                message: `SECURITY:${eventCode}`,
                context: { ...context, timestamp: new Date().toISOString() },
            })
        } catch (error) {
            console.error(`❌ 记录安全事件失败: ${error.message}`)
        }
    }

    async registerUser(username, phone, password, fullName) {
        try {
            // 1. 验证输入
            this.validateUserInput({ username, phone, password, fullName })

            // 2. 检查用户是否已存在
            const existingUser = await this.prisma.user.findUnique({
                where: { username }
            })

            if (existingUser) {
                // P14: 用户名冲突属业务错误,打标供路由白名单透出
                const err = new Error('用户名已存在')
                err.validation = true
                throw err
            }

            // 3. 检查手机号是否已使用
            if (phone) {
                const existingPhone = await this.prisma.user.findFirst({
                    where: { phone }
                })
                if (existingPhone) {
                    throw new Error('手机号已被使用')
                }
            }

            // 4. 加密密码
            const passwordHash = await bcryptjs.hash(password, 10)

            // 5. 创建用户
            const newUser = await this.prisma.user.create({
                data: {
                    username,
                    email: null,
                    phone: phone || null,
                    password_hash: passwordHash,
                    full_name: fullName,
                    role: 'operator',
                    status: 'active',
                    school_code: this.schoolCode || null
                }
            })

            console.log(`✅ 用户注册成功: ${username}`)

            return {
                success: true,
                user: {
                    id: newUser.id,
                    username: newUser.username,
                    phone: newUser.phone,
                    full_name: newUser.full_name,
                    role: newUser.role
                },
                message: '注册成功'
            }
        } catch (error) {
            // 并发注册导致唯一约束冲突（P2002）时幂等返回，避免将数据库错误直接抛给前端
            if (error && error.code === 'P2002') {
                const target = Array.isArray(error.meta?.target)
                    ? error.meta.target
                    : [String(error.meta?.target || '')]
                const conflictErr = new Error(
                    target.includes('username')
                        ? '用户名已存在'
                        : target.includes('phone')
                            ? '手机号已被使用'
                            : '该账户信息已存在'
                )
                conflictErr.status = 409
                conflictErr.code = target.includes('username')
                    ? 'USERNAME_EXISTS'
                    : target.includes('phone')
                        ? 'PHONE_EXISTS'
                        : 'CONFLICT'
                throw conflictErr
            }
            console.error(`❌ 用户注册失败: ${error.message}`)
            throw error
        }
    }

    // ====== User Login ======

    async loginUser(username, password, deviceId = null) {
        try {
            // 1. 查找用户
            const user = await this.prisma.user.findUnique({
                where: { username }
            })

            // q-2：被拒绝的 viewer 账号申请人在登录时收到明确提示（仅当该用户名确为 rejected 申请，
            // 不向其它不存在的用户泄露信息；时序与「用户不存在」分支一致，防枚举）
            if (!user) {
                if (await this.isRejectedApplicant(username, this.schoolCode)) {
                    const err = new Error('该账号申请未通过审批，无法登录')
                    err.code = 'APPLICATION_REJECTED'
                    err.status = 403
                    throw err
                }
                // DS-15: 用户不存在时也执行一次假哈希比较，拉平与"密码错误"路径的响应时间，防用户名枚举
                await bcryptjs.compare(password, FAKE_BCRYPT_HASH)
                // P2-03: 用户不存在时也记录失败登录（写入 SystemLog，因 AuditLog 需有效 user_id 外键）
                await this.logFailedLogin(null, username)
                throw new Error('用户不存在或密码错误')
            }

            // 1.5 租户归属校验（防伪登录）：
            // 携带非空 schoolCode 登录时，若目标 schema 不存在，PostgreSQL 的
            // `SET LOCAL search_path TO "school_xxx", public` 不会报错，查询会静默
            // 回落到 public，可能命中 public 的超管账号，造成"以其它租户身份登录成功"。
            // 因此要求命中的用户 school_code 必须与请求的 schoolCode 一致，否则视为失败。
            if (this.schoolCode && user.school_code !== this.schoolCode) {
                // DS3-M3: 该分支同样执行假比较，保持与"密码错误"路径时序一致
                await bcryptjs.compare(password, FAKE_BCRYPT_HASH)
                await this.logFailedLogin(null, username)
                throw new Error('用户不存在或密码错误')
            }

            // 2. DS3-M2: 账号级失败锁定（窗口内 login_failed 达阈值 → 临时锁定）
            if (await this.isAccountLocked(user.id)) {
                // 拉平时序：锁定分支也执行一次假比较
                await bcryptjs.compare(password, FAKE_BCRYPT_HASH)
                const err = new Error('登录失败次数过多，该账号已被临时锁定，请稍后再试')
                err.code = 'ACCOUNT_LOCKED'
                err.status = 423
                throw err
            }

            // 3. 验证密码（DS3-M3: 密码校验前置于状态检查——禁用账号路径也会先执行
            //    一次真实 bcrypt.compare，与"密码错误"路径响应时间一致，消除时序侧信道）
            const passwordMatch = await bcryptjs.compare(password, user.password_hash)

            if (!passwordMatch) {
                // 记录失败登录（同时作为 DS3-M2 账号锁定的计数依据）
                await this.logFailedLogin(user.id, username)
                throw new Error('用户不存在或密码错误')
            }

            // 3.5 检查用户状态（此时已完成真实 bcrypt.compare，无时序差异；统一记入 logFailedLogin）
            if (user.status !== 'active') {
                await this.logFailedLogin(user.id, username)
                const err = new Error('该用户已被禁用')
                err.code = 'ACCOUNT_DISABLED'
                throw err
            }

            // 4. 生成 JWT 双令牌（DS3-H1: access 30m + refresh 7d 一次性轮转）
            // P0-1C: deviceId 写入 refresh token payload（同设备绑定）
            const { token, expiresIn, refreshToken, refreshExpiresIn } = this.buildTokenPair(user, deviceId)

            // 5. 更新最后登录时间
            await this.updateLastLogin(user.id)

            // 6. 记录登录日志
            await this.logLogin(user.id, username)

            console.log(`✅ 用户登录成功: ${username}`)

            return {
                success: true,
                token,
                expiresIn,
                refreshToken,
                refreshExpiresIn,
                // IF-2/M2: 临时密码账号（provisioner 建号 / 管理员 resetPassword）首登强制改密。
                // 前端据此强制进入改密流程；服务端由 authenticateUser 对非改密白名单接口
                // 一律 403（code: MUST_CHANGE_PASSWORD），不依赖前端自觉。
                mustChangePassword: !!user.must_change_password,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    fullName: user.full_name,
                    role: user.role,
                    mustChangePassword: !!user.must_change_password,
                    // 返回真实 schoolCode，供前端 Router 判定平台超管（schoolCode 为空时才是超管）。
                    // 之前缺失此字段，导致租户 admin 也会被误判为超管、错误展示学校管理入口。
                    schoolCode: user.school_code || this.schoolCode || null
                }
            }
        } catch (error) {
            console.error(`❌ 用户登录失败: ${error.message}`)
            throw error
        }
    }

    // ====== Password Management ======

    async changePassword(userId, oldPassword, newPassword) {
        try {
            // 1. 获取用户
            const user = await this.prisma.user.findUnique({
                where: { id: userId }
            })

            if (!user) {
                throw new Error('用户不存在')
            }

            // 2. 验证旧密码
            const passwordMatch = await bcryptjs.compare(oldPassword, user.password_hash)

            if (!passwordMatch) {
                throw new Error('旧密码错误')
            }

            // 3. 验证新密码
            if (!this.isStrongPassword(newPassword)) {
                throw new Error('新密码至少8个字符，且必须包含字母和数字')
            }

            // 4. 加密新密码
            const newPasswordHash = await bcryptjs.hash(newPassword, 10)

            // 5. 更新密码（包 $transaction，保证读取-更新原子化，避免并发覆盖）
            // IF-2/M2: 用户本人完成改密后清除 must_change_password（临时密码 → 正式密码）
            await this.prisma.$transaction(async (tx) => {
                await tx.user.update({
                    where: { id: userId },
                    data: {
                        password_hash: newPasswordHash,
                        must_change_password: false,
                        updated_at: new Date()
                    }
                })
            })

            // IF-1: 用户自行改密后吊销全部旧会话（与 resetPassword 一致），
            // 防止密码泄露后被盗用的旧 token 在 access TTL（默认 30m）窗口内继续有效。
            // 注意：本操作也会使当前会话失效，用户需重新登录（安全优先于体验）。
            await this.revokeUserSessions(userId, 'password_change', { userId })

            console.log(`✅ 用户 ${userId} 密码已更新`)

            return {
                success: true,
                message: '密码已更新'
            }
        } catch (error) {
            console.error(`❌ 密码更新失败: ${error.message}`)
            throw error
        }
    }

    // ====== 平台超管管理（public.User，role='admin' 且 school_code 为空）======
    async listPlatformSuperAdmins() {
        try {
            const admins = await this.prisma.user.findMany({
                where: { role: 'admin', school_code: null },
                orderBy: { created_at: 'asc' },
                select: {
                    id: true,
                    username: true,
                    full_name: true,
                    email: true,
                    role: true,
                    status: true,
                    must_change_password: true,
                    created_at: true
                }
            })
            return admins
        } catch (error) {
            console.error('❌ 获取超管列表失败:', error)
            throw error
        }
    }

    async createPlatformSuperAdmin({ username, fullName, email = null, password }) {
        try {
            username = (username || '').trim()
            fullName = (fullName || '').trim()
            if (!username) throw new Error('用户名不能为空')
            if (!fullName) throw new Error('姓名不能为空')
            if (!this.isStrongPassword(password)) {
                throw new Error('密码至少8个字符，且必须包含字母和数字')
            }
            const existing = await this.prisma.user.findUnique({ where: { username } })
            if (existing) throw new Error('用户名已存在')
            const passwordHash = await bcryptjs.hash(password, 10)
            const newUser = await this.prisma.user.create({
                data: {
                    username,
                    email: email ? String(email).trim() : null,
                    phone: null,
                    password_hash: passwordHash,
                    full_name: fullName,
                    role: 'admin',
                    status: 'active',
                    school_code: null
                }
            })
            return {
                success: true,
                user: { id: newUser.id, username: newUser.username, full_name: newUser.full_name, role: newUser.role },
                message: '超管账号已创建'
            }
        } catch (error) {
            console.error('❌ 创建超管失败:', error)
            throw error
        }
    }

    async deletePlatformSuperAdmin(id, currentUserId) {
        try {
            const target = await this.prisma.user.findUnique({ where: { id } })
            if (!target) throw new Error('账号不存在')
            if (target.role !== 'admin' || target.school_code) {
                throw new Error('只能删除平台超管账号')
            }
            if (id === currentUserId) throw new Error('不能删除当前登录的账号')
            const count = await this.prisma.user.count({ where: { role: 'admin', school_code: null } })
            if (count <= 1) throw new Error('至少需保留一个平台超管账号')
            await this.prisma.user.delete({ where: { id } })
            return { success: true }
        } catch (error) {
            console.error('❌ 删除超管失败:', error)
            throw error
        }
    }

    // ===== 平台超管账号信息编辑（仅允许修改 full_name / email；不允许改 username / role / status / school_code）=====
    // 用于 admin-schools.html 行内"编辑"按钮与 saAccountModal 的"编辑现有超管"表单。
    // 走审计 + 严谨字段白名单，避免越权修改 username 等敏感字段。
    async updatePlatformSuperAdmin(id, updates, actor = null) {
        try {
            if (!id) throw new Error('账号 ID 缺失')
            const target = await this.prisma.user.findUnique({ where: { id } })
            if (!target) throw this.httpError(404, '账号不存在')
            if (target.role !== 'admin' || target.school_code) {
                throw new Error('只能编辑平台超管账号')
            }

            // 字段白名单：只允许 full_name / email；其它字段（含 username / role / status / password）
            // 一律拒绝，避免越权修改。email 允许 null（清空）。
            const allowedUpdates = ['full_name', 'email']
            const data = {}
            for (const key of allowedUpdates) {
                if (key in (updates || {})) {
                    let v = updates[key]
                    if (typeof v === 'string') v = v.trim()
                    if (key === 'full_name' && !v) {
                        throw new Error('姓名不能为空')
                    }
                    if (key === 'full_name' && v && v.length > 64) {
                        throw new Error('姓名长度不能超过 64 个字符')
                    }
                    if (key === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
                        throw new Error('邮箱格式不正确')
                    }
                    data[key] = (key === 'email' && !v) ? null : v
                }
            }
            if (Object.keys(data).length === 0) {
                throw new Error('没有需要更新的字段')
            }

            // 计算差异用于审计
            const changes = []
            for (const key of Object.keys(data)) {
                const before = target[key]
                const after = data[key]
                if (before !== after) changes.push({ field: key, before, after })
            }

            data.updated_at = new Date()

            const updated = await this.prisma.user.update({
                where: { id },
                data,
                select: {
                    id: true,
                    username: true,
                    full_name: true,
                    email: true,
                    role: true,
                    status: true,
                    school_code: true,
                    must_change_password: true,
                    created_at: true
                }
            })

            // H4: 强制服务端审计
            await this.logAdminAction('super_admin_update', actor, {
                targetUserId: updated.id,
                targetUsername: updated.username,
                changes
            })

            return {
                success: true,
                user: updated,
                changes,
                message: '平台超管账号已更新'
            }
        } catch (error) {
            console.error('❌ 更新超管账号失败:', error)
            throw error
        }
    }

    async resetPassword(userId, newPassword, actor = null) {
        try {
            // 验证新密码
            if (!this.isStrongPassword(newPassword)) {
                throw new Error('密码至少8个字符，且必须包含字母和数字')
            }

            const target = await this.prisma.user.findUnique({ where: { id: userId } })
            if (!target) {
                throw this.httpError(404, '用户不存在')
            }

            // 加密新密码
            const passwordHash = await bcryptjs.hash(newPassword, 10)

            // 更新密码
            // M1/M2: 管理员重置属于"临时密码"场景，置 must_change_password=true，
            // 首登强制改密的登录侧拦截由窗口1在 login/token 链路实现。
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    password_hash: passwordHash,
                    must_change_password: true,
                    updated_at: new Date()
                }
            })

            // H4: 强制服务端审计（绝不记录密码明文/哈希）
            await this.logAdminAction('password_reset', actor, {
                targetUserId: target.id,
                targetUsername: target.username
            })

            // IF-1: 密码被管理员重置后，被盗/旧 token 立即失效（不再等 access TTL 自然过期）
            await this.revokeUserSessions(userId, 'password_reset', actor)

            console.log(`✅ 用户 ${userId} 密码已重置`)

            return {
                success: true,
                message: '密码已重置'
            }
        } catch (error) {
            console.error(`❌ 密码重置失败: ${error.message}`)
            throw error
        }
    }

    // ====== User Profile ======

    async getUserProfile(userId) {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    username: true,
                    email: true,
                    full_name: true,
                    role: true,
                    status: true,
                    school_code: true,
                    created_at: true,
                    last_login: true
                }
            })

            if (!user) {
                throw new Error('用户不存在')
            }

            return {
                success: true,
                data: user
            }
        } catch (error) {
            console.error(`❌ 获取用户信息失败: ${error.message}`)
            throw error
        }
    }

    async updateUserProfile(userId, updates) {
        try {
            // 允许更新的字段
            const allowedUpdates = ['full_name', 'email']
            const filteredUpdates = {}

            for (const key of allowedUpdates) {
                if (key in updates) {
                    filteredUpdates[key] = updates[key]
                }
            }

            filteredUpdates.updated_at = new Date()

            const updatedUser = await this.prisma.user.update({
                where: { id: userId },
                data: filteredUpdates,
                select: {
                    id: true,
                    username: true,
                    email: true,
                    full_name: true,
                    role: true,
                    status: true
                }
            })

            console.log(`✅ 用户 ${userId} 信息已更新`)

            return {
                success: true,
                data: updatedUser
            }
        } catch (error) {
            console.error(`❌ 更新用户信息失败: ${error.message}`)
            throw error
        }
    }

    // ====== User List ======

    async getUserList(limit = 100, offset = 0) {
        try {
            const users = await this.prisma.user.findMany({
                skip: offset,
                take: limit,
                select: {
                    id: true,
                    username: true,
                    phone: true,
                    full_name: true,
                    role: true,
                    status: true,
                    created_at: true,
                    last_login: true
                },
                orderBy: { created_at: 'desc' }
            })

            const count = await this.prisma.user.count()

            return {
                success: true,
                data: users,
                total: count,
                limit,
                offset
            }
        } catch (error) {
            console.error(`❌ 获取用户列表失败: ${error.message}`)
            throw error
        }
    }

    // ====== User Management (Admin) ======
    //
    // 【窗口2 安全加固】以下六个函数（disableUser/enableUser/changeUserRole/
    // deleteUser/adminUpdateUser/resetPassword）统一增加：
    //   P0  提权拦截：租户上下文中永远不允许出现 role='admin'（不变量），
    //       public/共享 schema 中仅平台超管（role=admin 且 schoolCode 为空）可授予 admin；
    //   M3  最后一名 manager 保护：降权/禁用/删除前校验该校 active manager 数量；
    //   H4  强制服务端审计：操作成功后内部调用 logAdminAction（不依赖前端）；
    //   窗口1 对齐：高危操作末尾预留 revokeUserTokens 调用点（TODO 标记）。
    //
    // 新增可选参数 actor = { userId, username, role, schoolCode, ip }（来自 req.user/req.ip）。
    // actor 缺省（老调用点/脚本）时按最小权限处理：不允许授予 admin 角色。

    async disableUser(userId, actor = null) {
        try {
            const target = await this.prisma.user.findUnique({ where: { id: userId } })
            if (!target) {
                throw this.httpError(404, '用户不存在')
            }

            // M3: 最后一名可用 manager 不允许禁用
            await this.assertNotLastActiveManager(target, '禁用')

            await this.prisma.user.update({
                where: { id: userId },
                data: { status: 'disabled' }
            })

            // H4: 强制服务端审计
            await this.logAdminAction('user_disable', actor, {
                targetUserId: target.id,
                targetUsername: target.username,
                oldStatus: target.status,
                newStatus: 'disabled'
            })

            // IF-1: 禁用后吊销全部会话（与 authenticateUser 的 status 回查双保险）
            await this.revokeUserSessions(userId, 'user_disable', actor)

            console.log(`✅ 用户 ${userId} 已禁用`)

            return {
                success: true,
                message: '用户已禁用'
            }
        } catch (error) {
            console.error(`❌ 禁用用户失败: ${error.message}`)
            throw error
        }
    }

    async enableUser(userId, actor = null) {
        try {
            const target = await this.prisma.user.findUnique({ where: { id: userId } })
            if (!target) {
                throw this.httpError(404, '用户不存在')
            }

            await this.prisma.user.update({
                where: { id: userId },
                data: { status: 'active' }
            })

            // H4: 强制服务端审计
            await this.logAdminAction('user_enable', actor, {
                targetUserId: target.id,
                targetUsername: target.username,
                oldStatus: target.status,
                newStatus: 'active'
            })

            console.log(`✅ 用户 ${userId} 已启用`)

            return {
                success: true,
                message: '用户已启用'
            }
        } catch (error) {
            console.error(`❌ 启用用户失败: ${error.message}`)
            throw error
        }
    }

    async changeUserRole(userId, newRole, actor = null) {
        try {
            const validRoles = ['admin', 'manager', 'operator', 'viewer']
            if (!validRoles.includes(newRole)) {
                throw new Error(`无效的角色: ${newRole}`)
            }

            // P0: 提权拦截（manager 不可将任何人设为 admin；租户内禁止出现 admin）
            this.assertCanAssignRole(newRole, actor)

            const target = await this.prisma.user.findUnique({ where: { id: userId } })
            if (!target) {
                throw this.httpError(404, '用户不存在')
            }

            // M3: 把最后一名可用 manager 降权 → 拒绝
            if (target.role === 'manager' && newRole !== 'manager') {
                await this.assertNotLastActiveManager(target, '降权')
            }

            await this.prisma.user.update({
                where: { id: userId },
                data: { role: newRole }
            })

            // H4: 强制服务端审计（记录 oldRole → newRole）
            await this.logAdminAction('role_change', actor, {
                targetUserId: target.id,
                targetUsername: target.username,
                oldRole: target.role,
                newRole
            })

            // IF-1（H2 关键路径）：角色变更后立即吊销全部会话。
            // authenticateUser 只回查 status 不刷新 role（req.user 取自 token payload），
            // 降权的即时失效完全依赖这里的吊销——旧 token 持旧 role 的窗口从 ≤30m 收敛为 0。
            await this.revokeUserSessions(userId, 'role_change', actor)

            console.log(`✅ 用户 ${userId} 角色已更改为 ${newRole}`)

            return {
                success: true,
                message: `角色已更改为 ${newRole}`
            }
        } catch (error) {
            console.error(`❌ 更改角色失败: ${error.message}`)
            throw error
        }
    }

    async deleteUser(userId, actor = null) {
        try {
            const target = await this.prisma.user.findUnique({ where: { id: userId } })
            if (!target) {
                throw this.httpError(404, '用户不存在')
            }

            // P1-08: 删除前检查是否存在关联 TestRecord
            const recordCount = await this.prisma.testRecord.count({
              where: { created_by: userId }
            });
            if (recordCount > 0) {
              throw new Error(`无法删除用户：该用户存在 ${recordCount} 条检测记录，请先转移或归档记录后再删除`);
            }

            // M3: 最后一名可用 manager 不允许删除
            await this.assertNotLastActiveManager(target, '删除')

            await this.prisma.user.delete({
                where: { id: userId }
            })

            // H4: 强制服务端审计（目标用户已删除，快照写入 details）
            await this.logAdminAction('user_delete', actor, {
                targetUserId: target.id,
                targetUsername: target.username,
                targetRole: target.role,
                targetStatus: target.status
            })

            // IF-1: 删除后吊销全部会话（与 authenticateUser 的 !dbUser 回查双保险；
            // 同时使 refresh token 立即失效，防止已删除用户用 refresh 换新 token 的竞态）
            await this.revokeUserSessions(userId, 'user_delete', actor)

            console.log(`✅ 用户 ${userId} 已删除`)

            return {
                success: true,
                message: '用户已删除'
            }
        } catch (error) {
            console.error(`❌ 删除用户失败: ${error.message}`)
            throw error
        }
    }

    async adminUpdateUser(userId, updates, actor = null) {
        try {
            const allowedUpdates = ['username', 'full_name', 'email', 'phone', 'role', 'status']
            const filteredUpdates = {}

            for (const key of allowedUpdates) {
                if (key in updates && updates[key] !== undefined) {
                    filteredUpdates[key] = updates[key]
                }
            }

            if (Object.keys(filteredUpdates).length === 0) {
                throw new Error('未提供可更新字段')
            }

            if (filteredUpdates.username) {
                if (filteredUpdates.username.length < 3) {
                    throw new Error('用户名至少3个字符')
                }

                const existingUser = await this.prisma.user.findUnique({
                    where: { username: filteredUpdates.username }
                })

                if (existingUser && existingUser.id !== userId) {
                    throw new Error('用户名已存在')
                }
            }

            if (filteredUpdates.role) {
                const validRoles = ['admin', 'manager', 'operator', 'viewer']
                if (!validRoles.includes(filteredUpdates.role)) {
                    throw new Error(`无效的角色: ${filteredUpdates.role}`)
                }
                // P0: 提权拦截（与 changeUserRole 同一守卫）
                this.assertCanAssignRole(filteredUpdates.role, actor)
            }

            if (filteredUpdates.status) {
                const validStatus = ['active', 'disabled']
                if (!validStatus.includes(filteredUpdates.status)) {
                    throw new Error(`无效的状态: ${filteredUpdates.status}`)
                }
            }

            const target = await this.prisma.user.findUnique({ where: { id: userId } })
            if (!target) {
                throw this.httpError(404, '用户不存在')
            }

            // M3: 通过本接口把最后一名可用 manager 降权或禁用 → 拒绝
            const demotesManager = filteredUpdates.role && filteredUpdates.role !== 'manager'
            const disablesUser = filteredUpdates.status === 'disabled'
            if ((demotesManager || disablesUser) && target.role === 'manager') {
                await this.assertNotLastActiveManager(target, demotesManager ? '降权' : '禁用')
            }

            filteredUpdates.updated_at = new Date()

            const updatedUser = await this.prisma.user.update({
                where: { id: userId },
                data: filteredUpdates,
                select: {
                    id: true,
                    username: true,
                    phone: true,
                    email: true,
                    full_name: true,
                    role: true,
                    status: true,
                    created_at: true,
                    last_login: true
                }
            })

            // H4: 强制服务端审计（记录变更前后关键字段）
            const changedFields = {}
            for (const key of Object.keys(filteredUpdates)) {
                if (key === 'updated_at') continue
                changedFields[key] = { old: target[key] ?? null, new: filteredUpdates[key] }
            }
            await this.logAdminAction('admin_update_user', actor, {
                targetUserId: target.id,
                targetUsername: target.username,
                changes: changedFields
            })

            // IF-1: 仅当角色/状态实际变更时吊销（只改 full_name/email 等资料不吊销，避免过度失效）
            if (filteredUpdates.role || filteredUpdates.status) {
                await this.revokeUserSessions(userId, 'admin_update_user', actor)
            }

            console.log(`✅ 管理员已更新用户 ${userId}`)

            return {
                success: true,
                data: updatedUser,
                message: '用户信息已更新'
            }
        } catch (error) {
            console.error(`❌ 管理员更新用户失败: ${error.message}`)
            throw error
        }
    }

    // ====== Helper Methods ======

    /** 构造带 HTTP 状态码的错误（路由层用 error.status 透出） */
    httpError(status, message) {
        const err = new Error(message)
        err.status = status
        return err
    }

    /**
     * P0 · 首轮#1：admin 角色授予守卫。
     * 不变量：租户 schema 内永远不允许出现 role='admin' 的用户（admin 仅存在于
     * public schema 的平台超管），无论操作者是谁。
     * public/共享 schema 中，仅平台超管（role='admin' 且 schoolCode 为空）可授予 admin；
     * actor 缺省（老调用点/脚本直调）时按最小权限处理 → 拒绝。
     * 注：seed.js 创建平台超管走 prisma.user.upsert，不经过本守卫，不受影响。
     */
    assertCanAssignRole(newRole, actor) {
        if (newRole !== 'admin') return
        if (this.schoolCode) {
            throw this.httpError(403, '学校账号不可设置为平台管理员（admin 角色仅存在于平台层）')
        }
        if (!actor || actor.role !== 'admin' || actor.schoolCode) {
            throw this.httpError(403, '无权将用户设置为平台管理员')
        }
    }

    /**
     * M3: "最后一名 manager"保护。
     * 目标用户是 active 的 manager 时，统计同校 active manager 数量；
     * 若操作后该校将没有任何可用 manager，则拒绝（403）。
     * 目标本身已禁用/非 manager 时不拦截（不会减少可用 manager 数）。
     */
    async assertNotLastActiveManager(targetUser, opDesc = '操作') {
        if (!targetUser || targetUser.role !== 'manager' || targetUser.status !== 'active') return
        const activeManagers = await this.prisma.user.count({
            where: {
                role: 'manager',
                status: 'active',
                school_code: targetUser.school_code ?? null
            }
        })
        if (activeManagers <= 1) {
            throw this.httpError(403, `无法${opDesc}：该学校至少需保留一名可用的 manager 账号`)
        }
    }

    /**
     * H4: 高危用户管理操作的强制服务端审计。
     * - 由各管理函数在操作成功后内部调用，不依赖前端上报（绕过前端直调 API 也会留痕）；
     * - 常规路径写当前 schema 的 AuditLog（actorId 必须满足 user_id 外键）；
     * - actor 不在当前 schema（如平台超管操作租户）或写入失败时，
     *   回退写 public.SystemLog，保证事件不丢失；
     * - 审计失败不回滚业务操作，但必须在服务端留下错误日志。
     */
    async logAdminAction(action, actor, details = {}) {
        const payload = {
            ...details,
            actorId: actor?.userId || null,
            actorUsername: actor?.username || null,
            actorRole: actor?.role || null,
            actorSchoolCode: actor?.schoolCode || null,
            ip: actor?.ip || null,
            timestamp: new Date().toISOString()
        }
        try {
            const actorId = actor?.userId || null
            const actorInSchema = actorId
                ? await this.prisma.user.findUnique({ where: { id: actorId }, select: { id: true } })
                : null
            if (actorInSchema) {
                await writeTenantAuditLog(this.prisma, {
                    actorId,
                    action,
                    resourceType: 'user',
                    resourceId: details.targetUserId || null,
                    details: payload,
                    ip: actor?.ip || null
                })
                return
            }
            await writeSystemLog(this.rootPrisma, {
                level: 'warn',
                message: `[admin-audit] ${action} target=${details.targetUserId || ''}`,
                context: payload
            })
        } catch (error) {
            console.error(`❌ 审计写入失败 (${action}): ${error.message}`)
            try {
                await writeSystemLog(this.rootPrisma, {
                    level: 'error',
                    message: `[admin-audit-fallback] ${action} target=${details.targetUserId || ''}`,
                    context: payload
                })
            } catch (fallbackError) {
                console.error(`❌ 审计兜底写入也失败 (${action}): ${fallbackError.message}`)
            }
        }
    }

    validateUserInput({ username, phone, password, fullName }) {
        const errors = []

        // TD-Username-Rule-Inconsistent: 与 validationMiddleware.fieldValidators.username 对齐（仅允许 3-50 位字母/数字/下划线）
        if (!username || !/^[a-zA-Z0-9_]{3,50}$/.test(username)) {
            errors.push('用户名需为 3-50 位字母、数字或下划线')
        }

        if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
            errors.push('手机号格式无效（请输入11位手机号）')
        }

        if (!this.isStrongPassword(password)) {
            errors.push('密码至少8个字符，且必须包含字母和数字')
        }

        if (!fullName || fullName.trim() === '') {
            errors.push('姓名必填')
        }

        if (errors.length > 0) {
            // P14: 业务校验错误打标,路由层据此白名单透出具体原因
            const err = new Error(errors.join('; '))
            err.validation = true
            throw err
        }
    }

    isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        return emailRegex.test(email)
    }

    async updateLastLogin(userId) {
        try {
            await this.prisma.user.update({
                where: { id: userId },
                data: { last_login: new Date() }
            })
        } catch (error) {
            console.error(`❌ 更新最后登录时间失败: ${error.message}`)
        }
    }

    async logLogin(userId, username) {
        try {
            await writeTenantAuditLog(this.prisma, {
                actorId: userId,
                action: 'login',
                details: { username, timestamp: new Date().toISOString() },
            })
        } catch (error) {
            console.error(`❌ 记录登录日志失败: ${error.message}`)
        }
    }

    async logFailedLogin(userId, username) {
        try {
            // P2-03: userId 为 null 时（用户不存在），AuditLog 需有效 user_id 外键无法写入，改记 SystemLog
            if (!userId) {
                // systemLog 仅存在于 public.schema，必须用 rootPrisma（基础单例）写入，
                // 避免租户客户端（forTenant 后的 this.prisma）落到不存在的租户 systemLog 表。
                await writeSystemLog(this.rootPrisma, {
                    level: 'warn',
                    message: `登录失败（用户不存在）: ${username}`,
                    context: { username, timestamp: new Date().toISOString() },
                })
                return
            }
            await writeTenantAuditLog(this.prisma, {
                actorId: userId,
                action: 'login_failed',
                details: { username, timestamp: new Date().toISOString() },
            })

            // 安全策略：短时间内连续密码错误超过 5 次 → 自动停用该账户
            // 窗口：最近 2 分钟内的 login_failed 记录
            try {
                const autoDisableThreshold = Number(process.env.AUTO_DISABLE_THRESHOLD || 5)
                const autoDisableWindowMs = Number(process.env.AUTO_DISABLE_WINDOW_MS || 2 * 60 * 1000)
                if (autoDisableThreshold > 0) {
                    const recentFailures = await this.prisma.auditLog.count({
                        where: {
                            user_id: userId,
                            action: 'login_failed',
                            created_at: { gte: new Date(Date.now() - autoDisableWindowMs) }
                        }
                    })
                    if (recentFailures >= autoDisableThreshold) {
                        await this.prisma.user.update({
                            where: { id: userId },
                            data: { status: 'disabled' }
                        })
                        console.warn(`⚠️ 用户 ${username}(id=${userId}) 因 ${autoDisableWindowMs / 1000} 秒内连续 ${recentFailures} 次登录失败，已自动停用`)
                    }
                }
            } catch (autoErr) {
                console.error(`❌ 自动停用检测失败: ${autoErr.message}`)
            }
        } catch (error) {
            console.error(`❌ 记录失败登录失败: ${error.message}`)
        }
    }

    verifyToken(token) {
        try {
            // DS-01: 显式限定算法白名单，防 'none' 算法/算法混淆绕过
            const decoded = jwt.verify(token, this.jwtSecret, { algorithms: ['HS256'] })
            // DS-02: refresh token 不得当 access token 用（类型隔离）
            if (decoded && decoded.type === 'refresh') {
                return { valid: false, error: 'refresh token 不可用于访问接口' }
            }
            return {
                valid: true,
                user: decoded
            }
        } catch (error) {
            return {
                valid: false,
                error: error.message
            }
        }
    }

    // ========== 校外人员 viewer 账号申请（需学校 manager 审批）==========

    /**
     * 提交 viewer 账号申请（登录页公开入口，无需登录）
     * schoolCode 决定申请落到哪个租户 schema。
     */
    async submitAccountApplication({ username, password, email, fullName, phone, schoolCode }) {
        try {
            if (!username || !password || !schoolCode) {
                const err = new Error('缺少必要字段（用户名/密码/学校代码）')
                err.validation = true
                err.status = 400
                throw err
            }
            if (String(password).length < 8) {
                const err = new Error('密码至少8位')
                err.validation = true
                err.status = 400
                throw err
            }
            if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
                const err = new Error('用户名格式非法（需3-32位字母、数字或下划线）')
                err.validation = true
                err.status = 400
                throw err
            }

            // 该租户 schema 内是否已存在同名用户
            const existingUser = await this.prisma.user.findUnique({ where: { username } })
            if (existingUser) {
                const err = new Error('用户名已存在')
                err.validation = true
                err.code = 'USERNAME_EXISTS'
                throw err
            }
            // 是否已有待审批/已通过的申请
            const existingApp = await this.prisma.accountApplication.findUnique({ where: { username } })
            if (existingApp && existingApp.status !== 'rejected') {
                const err = new Error('该用户名已有申请在处理中')
                err.validation = true
                err.code = 'APP_EXISTS'
                throw err
            }

            const passwordHash = await bcryptjs.hash(password, 10)
            const app = await this.prisma.accountApplication.create({
                data: {
                    username,
                    email: email || null,
                    phone: phone || null,
                    full_name: fullName || null,
                    password_hash: passwordHash,
                    view_pathogen: true, // 审批通过即开放全部含病原体（q-0 决策）
                    status: 'pending',
                    school_code: schoolCode
                }
            })

            console.log(`📝 收到 viewer 账号申请: ${username} @ ${schoolCode}`)
            return { success: true, applicationId: app.id }
        } catch (error) {
            if (error.validation) {
                const err = new Error(error.message)
                err.validation = true
                err.status = error.status || 400
                err.code = error.code
                throw err
            }
            console.error('❌ 提交账号申请失败:', error)
            throw error
        }
    }

    /**
     * 列出当前学校（req.user.schoolCode）的待审批申请（manager/admin）
     */
    async getPendingApplications(schoolCode) {
        const list = await this.prisma.accountApplication.findMany({
            where: { school_code: schoolCode, status: 'pending' },
            orderBy: { created_at: 'desc' }
        })
        return list.map(a => ({
            id: a.id,
            username: a.username,
            email: a.email,
            phone: a.phone,
            full_name: a.full_name,
            view_pathogen: a.view_pathogen,
            status: a.status,
            created_at: a.created_at,
            school_code: a.school_code
        }))
    }

    /**
     * 审批通过：创建 viewer 用户（can_view_pathogen=true，只读全部模块含病原体），并标记申请 approved
     */
    async approveApplication(applicationId, reviewerId, schoolCode) {
        const app = await this.prisma.accountApplication.findUnique({ where: { id: applicationId } })
        if (!app) {
            const err = new Error('申请不存在')
            err.validation = true
            err.status = 404
            throw err
        }
        if (app.status !== 'pending') {
            const err = new Error('该申请已处理')
            err.validation = true
            err.status = 409
            throw err
        }
        if (app.school_code !== schoolCode) {
            const err = new Error('无权审批其他学校的申请')
            err.validation = true
            err.status = 403
            throw err
        }

        // 幂等：审批通过时再次校验用户名冲突
        const existingUser = await this.prisma.user.findUnique({ where: { username: app.username } })
        if (existingUser) {
            const err = new Error('用户名已被创建，无法重复审批')
            err.validation = true
            err.code = 'USERNAME_EXISTS'
            throw err
        }

        await this.prisma.user.create({
            data: {
                username: app.username,
                email: app.email,
                phone: app.phone,
                password_hash: app.password_hash,
                full_name: app.full_name,
                role: 'viewer',
                status: 'active',
                school_code: app.school_code,
                can_view_pathogen: true // q-0：审批通过即开放全部含病原体只读
            }
        })

        await this.prisma.accountApplication.update({
            where: { id: applicationId },
            data: { status: 'approved', reviewer_id: reviewerId, reviewed_at: new Date() }
        })

        console.log(`✅ viewer 账号申请已通过: ${app.username}（reviewer=${reviewerId}）`)
        return { success: true }
    }

    /**
     * 审批拒绝：标记 rejected，可选写入拒绝原因
     */
    async rejectApplication(applicationId, reviewerId, schoolCode, note) {
        const app = await this.prisma.accountApplication.findUnique({ where: { id: applicationId } })
        if (!app) {
            const err = new Error('申请不存在')
            err.validation = true
            err.status = 404
            throw err
        }
        if (app.status !== 'pending') {
            const err = new Error('该申请已处理')
            err.validation = true
            err.status = 409
            throw err
        }
        if (app.school_code !== schoolCode) {
            const err = new Error('无权审批其他学校的申请')
            err.validation = true
            err.status = 403
            throw err
        }

        await this.prisma.accountApplication.update({
            where: { id: applicationId },
            data: {
                status: 'rejected',
                reviewer_id: reviewerId,
                review_note: note || null,
                reviewed_at: new Date()
            }
        })

        console.log(`🚫 viewer 账号申请已拒绝: ${app.username}（reviewer=${reviewerId}）`)
        return { success: true }
    }

    /**
     * 登录失败辅助（q-2）：该用户名是否存在「已被拒绝」的申请，用于返回特定提示。
     * 仅在用户名确实对应 rejected application 时返回 true，避免向不存在的用户泄露信息。
     */
    async isRejectedApplicant(username, schoolCode) {
        const app = await this.prisma.accountApplication.findUnique({ where: { username } })
        if (!app) return false
        if (schoolCode && app.school_code && app.school_code !== schoolCode) return false
        return app.status === 'rejected'
    }
}

export default UserManager
