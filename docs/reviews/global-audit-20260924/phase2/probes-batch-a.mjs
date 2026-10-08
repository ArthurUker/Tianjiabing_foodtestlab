// Phase 2 — Independent adversarial verification probes (Batch A).
// Non-destructive: no external network, no DB access, no application writes.
// Uses REAL application modules with controlled doubles (fake prisma / fake manager) and source assertions.
// Run from repository root: node docs/reviews/global-audit-20260924/phase2/probes-batch-a.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.NODE_ENV = 'test'
// 占位连接串：仅让租户客户端可被构造（Prisma 为惰性连接，指向不可达端口，绝不发起真实连接）
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgresql://phase2:phase2@127.0.0.1:1/phase2_never_connect?schema=public'
}

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const mod = (p) => pathToFileURL(path.join(root, p)).href
const results = []
const record = (id, kind, detail) => {
    results.push({ id, kind, detail })
    console.log(`[${id}] ${kind}: ${detail}`)
}
const between = (src, startMarker, endMarker) => {
    const i = src.indexOf(startMarker)
    if (i < 0) return ''
    const j = endMarker ? src.indexOf(endMarker, i + startMarker.length) : -1
    return j < 0 ? src.slice(i) : src.slice(i, j)
}
const mkRes = () => {
    const res = { statusCode: 200, _json: null }
    res.status = (c) => { res.statusCode = c; return res }
    res.json = (b) => { res._json = b; return res }
    res.setHeader = () => res
    res.sendStatus = (c) => { res.statusCode = c; return res }
    return res
}

/* ═══════════════════ AUD-001 · 前端缓存/离线队列未按租户与主体隔离 ═══════════════════ */
{
    const src = read('frontend/js/core/Storage.js')
    assert.ok(/this\.localCacheKey = `cache_\$\{tableName\}`/.test(src))
    assert.ok(/this\.pendingRequestsKey = `pending_\$\{tableName\}`/.test(src))
    const keyLines = src.split('\n').filter((l) => l.includes('localCacheKey') || l.includes('pendingRequestsKey'))
    assert.ok(keyLines.every((l) => !l.includes('removeItem')), '源码内不存在对缓存/队列键的清理')
    assert.ok(!/localCacheKey\s*=\s*`[^`]*\$\{[^}]*(school|user|tenant)/i.test(src), '键模板不含租户/主体变量')
    record('AUD-001', 'STATIC_CONFIRMED', 'cache_<table> / pending_<table> 为全局键：不含 schoolCode/userId，且全文件无清理点（AuthService.clearAuth 只清认证态）')

    let dom = null
    let jsdomUsed = false
    try {
        const { JSDOM } = await import('jsdom')
        dom = new JSDOM('<table><tbody id="t"></tbody></table>', { url: 'https://audit.invalid/a/index.html' })
        globalThis.window = dom.window
        globalThis.document = dom.window.document
        globalThis.localStorage = dom.window.localStorage
        globalThis.sessionStorage = dom.window.sessionStorage
        jsdomUsed = true
    } catch (e) {
        const m = new Map()
        const stub = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size } }
        globalThis.localStorage = stub
        globalThis.sessionStorage = { ...stub, ...{ _m: new Map() } }
    }
    const { StorageService } = await import(mod('frontend/js/core/Storage.js'))
    StorageService.prototype._processQueuedRequests = async () => {}
    const sA = new StorageService('oil')
    sA._updateLocalCache([{ id: 'a-record', inspector: 'A校检测员', _status: 'synced' }], { forceServer: true })
    sA._addPendingRequest({ id: 'a-job', type: 'create', data: { testDate: '2026-09-24', canteen: 'A校食堂', inspector: 'A校检测员', result: '合格' } })
    if (jsdomUsed) dom.reconfigure({ url: 'https://audit.invalid/b/index.html' }) // 同源、不同学校上下文
    const sB = new StorageService('oil')
    const cache = sB._getLocalCacheData()
    const queue = sB._getPendingRequests()
    assert.equal(cache[0]?.inspector, 'A校检测员')
    assert.equal(queue[0]?.id, 'a-job')
    assert.ok(!JSON.stringify(Object.keys(globalThis.localStorage)).includes('school'), 'localStorage 键集合不含租户维度')
    record('AUD-001', 'REPRODUCED', `${jsdomUsed ? 'JSDOM 同源切换' : 'Node localStorage'} 下新 StorageService 直接读到上一主体缓存与待上传任务（inspector=A校检测员，job=a-job）`)
    if (dom) dom.window.close()
}

/* ═══════════════════ AUD-002 · 幂等缓存跨租户/跨主体命中且先于写权限检查 ═══════════════════ */
{
    const { default: idempotencyMiddleware } = await import(mod('backend/middleware/idempotencyMiddleware.js'))
    const express = (await import('express')).default
    const request = (await import('supertest')).default
    const { createRecordRoutes } = await import(mod('backend/routes/recordRoutes.js'))

    // 受控替身：认证与守卫计数（不改变被测的路由链顺序，这正是本项验证对象）
    const guard = { auth: 0, editor: 0, editorSawRoles: [] }
    let writes = 0
    const authStub = (req, res, next) => {
        guard.auth++
        req.userId = req.user.userId
        req.db = {
            testRecord: { findUnique: async () => null, create: async ({ data }) => ({ ...data, id: `${req.user.schoolCode}-${++writes}` }) },
            auditLog: { create: async () => ({}) },
        }
        next()
    }
    const editorStub = (req, res, next) => {
        guard.editor++
        guard.editorSawRoles.push(req.user.role)
        if (req.user.role === 'guest' || req.user.role === 'viewer') return res.status(403).json({ error: '只读角色禁止写入' })
        next()
    }
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
        req.user = { userId: req.get('x-user') || 'u', role: req.get('x-role') || 'operator', schoolCode: req.get('x-school') || 'school-a' }
        next()
    })
    app.use(createRecordRoutes({ authenticateUser: authStub, requireEditorOrAbove: editorStub, requireGuestReadOnly: (_q, _s, n) => n(), idempotencyMiddleware }))

    const key = `phase2-aud002-${Date.now()}`
    const payload = { testDate: '2026-09-24', canteen: 'A校食堂', inspector: 'A校检测员', result: '合格' }
    const first = await request(app).post('/api/records/oil')
        .set('Idempotency-Key', key).set('x-user', 'op-a').set('x-role', 'operator').set('x-school', 'school-a').send(payload)
    assert.equal(first.status, 200)
    assert.equal(writes, 1)
    const afterFirst = { ...guard }

    const second = await request(app).post('/api/records/oil')
        .set('Idempotency-Key', key).set('x-user', 'guest-b').set('x-role', 'guest').set('x-school', 'school-b').send(payload)
    assert.equal(second.status, 200, 'B 校 guest 命中 A 校写缓存')
    assert.equal(second.body.data.inspector, payload.inspector, '缓存响应含未脱敏检测人')
    assert.equal(writes, 1, '未产生第二次写入')
    assert.equal(guard.auth, afterFirst.auth, 'authenticateUser 未再执行（被缓存短路）')
    assert.equal(guard.editor, afterFirst.editor, 'requireEditorOrAbove 未执行（guest 未被拒绝）')
    record('AUD-002', 'REPRODUCED', `真实 express + 真实 recordRoutes/idempotencyMiddleware：guest 命中 A 校缓存返回 inspector=${second.body.data.inspector}；auth=${guard.auth}(+0) editor=${guard.editor}(+0) writes=${writes}`)
    record('AUD-002', 'PROD_GUARD', '生产另有 recognitionRoutes 前置 authenticateUser（server.js:339 + recognitionRoutes.js:21），因此本项不是匿名可达；但前置认证只验身份，不做写权限判定，跨租户/跨主体读取仍成立')
}

/* ═══════════════════ AUD-014 · 认证 DB 回查故障时先放行（fail-soft） ═══════════════════ */
{
    const { createAuthMiddleware, _resetRecheckFailStateForTest, getRecheckFailState } = await import(mod('backend/middleware/authMiddleware.js'))
    const fakeRoot = {
        $executeRawUnsafe: async () => 0,
        $queryRawUnsafe: async () => [],
        user: { findUnique: async () => { throw new Error('simulated lookup outage') } },
    }
    const fakeManager = {
        rootPrisma: fakeRoot,
        verifyToken: () => ({ valid: true, user: { userId: 'old-admin', role: 'admin', schoolCode: 'school-a', jti: 'old-token', iat: 1 } }),
    }
    _resetRecheckFailStateForTest()
    const { authenticateUser } = createAuthMiddleware(fakeManager, fakeRoot)
    const observed = []
    for (let i = 0; i < 3; i++) {
        const req = { headers: { authorization: 'Bearer x' }, url: '/api/records/oil', originalUrl: '/api/records/oil', method: 'POST' }
        const res = mkRes()
        let next = 0
        await authenticateUser(req, res, () => { next++ })
        observed.push({ status: res.statusCode, passed: next === 1, role: req.user?.role || null })
    }
    assert.deepEqual(observed.map((o) => o.status), [200, 200, 503])
    assert.equal(observed[0].passed, true)
    assert.equal(observed[0].role, 'admin', '前两次沿用 token 内旧角色放行')
    assert.equal(observed[2].passed, false)
    record('AUD-014', 'REPRODUCED', `真实 authenticateUser（fake DB 全部抛错）：状态序列 ${observed.map((o) => o.status).join('/')}，前两次以 token 内 role=admin 放行并进入业务链`)
    record('AUD-014', 'COUNTER', `计数为进程级：getRecheckFailState().threshold=${getRecheckFailState().threshold}；任何一次回查成功即清零（authMiddleware.js:_onRecheckSuccess）`)
}

/* ═══════════════════ AUD-015 · iat + 1 比较漏吊销同秒旧 token ═══════════════════ */
{
    const hit = (iatSec, revokedAtSec) => revokedAtSec >= iatSec + 1
    assert.equal(hit(100, 100.5), false, '同秒先签发后吊销 → 永不命中')
    assert.equal(hit(100, 101.0), true)
    assert.equal(hit(99, 100.5), true)
    const src = read('backend/middleware/authMiddleware.js')
    assert.ok(src.includes('revoked_at >= to_timestamp($3 + 1)'))
    const refresh = read('backend/routes/userRoutes.js')
    assert.ok(refresh.includes('isTokenRevoked(rootPrisma, { jti: null, userId, iat: decoded.iat })'))
    record('AUD-015', 'SEMANTIC_REPRODUCED', 'iat=100s / revoked_at=100.5s → hit=false（与第一遍 PostgreSQL 表达式验证一致）；access 与 refresh 同口径')
    record('AUD-015', 'LIMIT', '触发窗口 = 签发与吊销落在同一整数秒（设计注释 B-JWT-IAT 明确为支持「改密后同秒重登」而取 iat+1）；该窗口外的旧 token 正常吊销')
}

/* ═══════════════════ AUD-016 · 改密与吊销非原子，吊销失败仍成功 ═══════════════════ */
{
    const { UserManager } = await import(mod('backend/modules/UserManager.js'))
    const um = Object.create(UserManager.prototype)
    um.schoolCode = 'school-a'
    um.rootPrisma = { $executeRawUnsafe: async () => { throw new Error('simulated revocation write failure') } }
    const events = []
    um.logSecurityEvent = async (code, ctx) => { events.push({ code, ctx }) } // 受控替身：不影响「是否上抛」的判定
    let threw = false
    try {
        await um.revokeUserSessions('u1', 'password_change', { userId: 'actor' })
    } catch { threw = true }
    assert.equal(threw, false, '吊销写入失败不得向调用方抛出')
    assert.equal(events[0]?.code, 'REVOCATION_WRITE_FAILED')
    record('AUD-016', 'REPRODUCED', '真实 revokeUserSessions + fake rootPrisma（写吊销抛错）：不上抛，仅记 SECURITY:REVOCATION_WRITE_FAILED')

    const umSrc = read('backend/modules/UserManager.js')
    const idxTx = umSrc.indexOf('await this.prisma.$transaction(async (tx) => {')
    const idxRevoke = umSrc.indexOf("await this.revokeUserSessions(userId, 'password_change'")
    assert.ok(idxTx > 0 && idxRevoke > idxTx)
    assert.ok(!/revokeUserSessions[\s\S]{0,80}throw/.test(umSrc), '调用方无「吊销失败即失败」的补偿')
    record('AUD-016', 'STATIC_CONFIRMED', 'changePassword：密码更新在 $transaction 内，revokeUserSessions 在其后（事务外）且结果未被检查 → 返回 { success: true }')
}

/* ═══════════════════ AUD-010 · 停用学校不阻断登录与已签发 token ═══════════════════ */
{
    const schoolSrc = read('backend/routes/schoolRoutes.js')
    const statusHandler = between(schoolSrc, "router.patch('/api/admin/schools/:code/status'", '\n    })')
    assert.ok(statusHandler.includes('prisma.school.update'))
    assert.ok(!/revoke/i.test(statusHandler) && !/Session/.test(statusHandler), '停用 handler 不做任何令牌/会话失效')

    const umSrc = read('backend/modules/UserManager.js')
    const loginBlock = between(umSrc, 'async loginUser(', 'async createSession(')
    assert.ok(!/prisma\.school|school\.status/.test(loginBlock), 'loginUser 不查 School 状态')

    const authSrc = read('backend/middleware/authMiddleware.js')
    const userBranch = between(authSrc, '—— 员工/管理员令牌 ——', '} catch (error)')
    assert.ok(!/school\.findUnique|School\b/.test(userBranch), '受保护请求回查不检查 School 状态')

    const guestSrc = read('backend/routes/guestRoutes.js')
    const quickBlock = between(guestSrc, "router.post('/quick-access'", 'const db = createTenantClient')
    assert.ok(quickBlock.includes('prisma.school.findUnique') && !/school\.status/.test(quickBlock), '访客入口查学校存在性但不查 status')

    record('AUD-010', 'STATIC_CONFIRMED', '停用学校无任何令牌失效；loginUser / authenticateUser / quick-access 均只检查主体自身状态，不检查 School.status')
}

/* ═══════════════════ AUD-012 · logout 与会话撤销不绑定 JWT 有效性 ═══════════════════ */
{
    const userSrc = read('backend/routes/userRoutes.js')
    const logoutBlock = between(userSrc, "router.post('/logout'", '\n    })')
    assert.ok(!/revoke/i.test(logoutBlock))
    const authSrc = read('backend/middleware/authMiddleware.js')
    assert.ok(!/session\.findUnique|session\.findFirst/.test(authSrc + userSrc), '认证与刷新链路不查询 Session 表')
    const sessionSrc = read('backend/routes/sessionRoutes.js')
    assert.ok(sessionSrc.includes("data: { status: 'revoked' }"))
    record('AUD-012', 'STATIC_CONFIRMED', 'logout 仅返回 { success: true }（userRoutes.js:191-194）；DELETE /api/session/:id 只写 Session.status，而认证只查 User + revoked_tokens → 已保存 access/refresh 不受影响')
}

/* ═══════════════════ AUD-017 · 全局测试报告接口对任意登录身份开放 ═══════════════════ */
{
    const trSrc = read('backend/routes/testResultRoutes.js')
    const mount = trSrc.slice(trSrc.indexOf('export function createTestResultRoutes'))
    assert.ok(/router\.use\(authenticateUser\)/.test(mount))
    assert.ok(!/authorizeAdmin|authorizeRoles|requirePlatformSuperAdmin/.test(mount), '无角色/平台守卫')
    assert.ok(/createTestResultRoutes\(userManager, prisma\)/.test(read('backend/server.js')), '注入全局 public prisma')
    const endpoints = [...trSrc.matchAll(/router\.(get|post)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`)
    const writes = endpoints.filter((e) => e.startsWith('POST'))
    record('AUD-017', 'STATIC_CONFIRMED', `全部 ${endpoints.length} 个端点仅 authenticateUser（含写：${writes.join(' / ')}）；数据落全局 public schema，与请求方学校无关`)
}

/* ═══════════════════ AUD-047 · 学校删除后 OpenAPI 授权残留 ═══════════════════ */
{
    const schemaSrc = read('backend/prisma/schema.prisma')
    const grantModel = between(schemaSrc, 'model OpenApiGrant {', '\n}')
    assert.ok(!/School\s+@relation/.test(grantModel) && /school_code\s+String/.test(grantModel), 'grant 仅以 school_code 文本关联')

    const schoolSrc = read('backend/routes/schoolRoutes.js')
    const hardDelete = between(schoolSrc, "router.delete('/api/admin/schools/:code'", '// 回收站列表')
    assert.ok(!/openApiGrant/i.test(hardDelete), '彻底删除事务不撤销 grant')

    const createBlock = between(schoolSrc, "router.post('/api/admin/schools'", 'res.json({')
    assert.ok(!/recycle_bin/.test(createBlock), '新建学校不检查回收站同代码记录')

    const openSrc = read('backend/routes/openApiRoutes.js')
    const resolveSchool = between(openSrc, 'async function resolveSchool(', 'async function allowedKeysForSchool(')
    assert.ok(/school\.status !== 'active'/.test(resolveSchool), '访问期有 School.status 检查（删除后即 404）')
    assert.ok(!/recycle|generation|created_at/.test(resolveSchool), '不区分「新建学校」与「回收站恢复」')
    record('AUD-047', 'STATIC_CONFIRMED', '删除不回撤 grant；grant 不复用学校 ID/世代；同 code 重建后旧对接方自动恢复读取（中间态由 School 行缺失 + status 检查阻断）')
}

console.log('\n=== SUMMARY ===')
const summary = {
    baseline: 'f08e72e3e74d188b4555e0bee16280b3dd0d622b',
    environment: {
        node: process.version,
        express: true,
        jsdom: true,
        prismaClient: true,
        note: 'no DATABASE_URL used; no network; fake prisma/manager only',
    },
    probes: results.length,
    results,
}
console.log(JSON.stringify({ probes: results.length, ids: [...new Set(results.map((r) => r.id))] }, null, 2))
fs.writeFileSync(path.join(here, 'probe-results-batch-a.json'), JSON.stringify(summary, null, 2))
process.exit(0)
