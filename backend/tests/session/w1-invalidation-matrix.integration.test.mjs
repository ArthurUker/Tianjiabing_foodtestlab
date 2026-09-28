// P3-W1-T01（RC-02）会话失效矩阵 · 真实 PG 集成回归（**自有独占实例**）
//
// 退出条件对应（任务包 §退出条件）：
//   · 失效矩阵：停校 / 登出 / 改密 / 降权 / 删除 × 旧 token 立即失效 × 新 token 正常
//   · DB 故障窗口：吊销写失败 → 业务不得半提交、状态可解释、不沿用旧权限
//   · 同秒 iat 边界（固定时钟）
//   · 两阶段兼容实证：compat（旧 token 仍验）/ strict（显式开关强制）
//   · 停校 O(1)：一行学校级 epoch 使全校会话失效（不逐 token 写行）
//   · server.js 写屏障挂载证据（真实启动 + READONLY_MODE 全局 503；挂载失败不阻断启动为静态证据）
//
// 运行（先 source provisioner test-env.sh）：
//   node --test --test-concurrency=1 backend/tests/session/w1-invalidation-matrix.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import bcryptjs from 'bcryptjs'
import {
  loadW1Context, createAdminPrisma, assertAdminIdentity, pointEngineEnvToInstance,
  ensureSchoolRow, upsertTenantUser, assertTenantUserTable, readEpochRows, repoRoot,
} from './_w1-harness.mjs'
// P3-HARNESS-CHECK-R1：真实 server 前置 = 已迁移实例 + 默认 check（public migrate deploy → 租户链回放 → --check）
import { ensurePublicMigrated, ensureTenantChain } from '../harness-check/_prepare-migrated-instance.mjs'

const w1 = loadW1Context()
const SCHEMA = w1.derived.schemas.a
const SCHOOL = w1.derived.tenants.a
const PASSWORD = 'W1Passw0rd1'
const NEW_PASSWORD = 'W1Passw0rd2'
const HASH = bcryptjs.hashSync(PASSWORD, 4)
const JWT_SECRET = 'w1-matrix-secret-1234567890'
// R7（B-4）：涉及软删墓碑的用例使用**每次运行唯一**的用户名 —— 实例复用时不与上一次的墓碑冲突（身份不可复用 ⇒ 不得清理墓碑）
const R7_TAG = crypto.randomBytes(3).toString('hex')

pointEngineEnvToInstance(w1)

const { UserManager } = await import('../../modules/UserManager.js')
const { createAuthMiddleware, _resetRecheckFailStateForTest, legacyTokenMetrics } = await import('../../middleware/authMiddleware.js')
const { createUserRoutes } = await import('../../routes/userRoutes.js')
const { createSchoolRoutes } = await import('../../routes/schoolRoutes.js')
const { setSessionClock, sessionNow } = await import('../../lib/sessionEpoch.js')

const prisma = createAdminPrisma(w1)
/** P3-HARNESS-CHECK-R1：迁移前置结果（public 模式 / 租户 --check rc），供证据与断言复用。 */
let preparedInstance = null
const userManager = new UserManager(prisma, JWT_SECRET)
userManager.rootPrisma = prisma

function mockRes() {
  const res = {}
  res.statusCode = 200
  res.headers = {}
  res.status = (c) => { res.statusCode = c; return res }
  res.json = (b) => { res.body = b; return res }
  res.send = (b) => { res.body = b; return res }
  res.setHeader = (k, v) => { res.headers[k] = v; return res }
  return res
}

function handlerOf(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle
    }
  }
  throw new Error(`路由未找到：${method.toUpperCase()} ${path}`)
}

/** 以真实 authenticateUser 校验一枚 access token。 */
async function authWith(token) {
  const { authenticateUser } = createAuthMiddleware(userManager, prisma)
  const req = {
    headers: { authorization: `Bearer ${token}` },
    method: 'GET', path: '/api/test-records', originalUrl: '/api/test-records', url: '/api/test-records',
  }
  const res = mockRes()
  let passed = false
  await authenticateUser(req, res, () => { passed = true })
  return { passed, res, req }
}

const tokenFor = (user) => userManager.buildAccessToken(user).token

/** 清理本校学校级 epoch（用例间隔离：停校用例的产物不得污染后续时间比较场景）。 */
const clearSchoolEpoch = () => prisma.$executeRawUnsafe(
  `DELETE FROM public.revoked_tokens WHERE jti = $1`, `school_epoch:${SCHOOL}`
)

test.before(async () => {
  const identity = await assertAdminIdentity(prisma, w1)
  console.log(`[W1] 实例身份已核验：db=${identity.db} user=${identity.user} port=${identity.port}`)
  // P3-HARNESS-CHECK-R1：实例必须是「已迁移 + 默认 check 可放行」——
  //   ① public：prisma migrate deploy（禁止 db push / resolve / accept-data-loss）
  //   ② 学校行（供逐租户链遍历）
  //   ③ 租户：版本化链回放 + --check rc=0（表由链建立，不再依赖 db push）
  const pub = await ensurePublicMigrated({ adminUrl: w1.adminUrl, cfg: w1.cfg, log: (m) => console.log(`[W1][prep] ${m}`) })
  await ensureSchoolRow(prisma, { code: SCHOOL, status: 'active' })
  const ten = ensureTenantChain({ adminUrl: w1.adminUrl, log: (m) => console.log(`[W1][prep] ${m}`) })
  preparedInstance = { publicMode: pub.mode, parked: pub.parked, tenantCheckRc: ten.checkRc }
  console.log(`[W1] 迁移前置完成：public=${pub.mode} tenantCheckRc=${ten.checkRc}`)
  await assertTenantUserTable(prisma, SCHEMA)
  await prisma.$executeRawUnsafe(`DELETE FROM public.revoked_tokens WHERE user_id LIKE 'w1-user-%' OR school_code = $1`, SCHOOL)
})

test.afterEach(() => {
  _resetRecheckFailStateForTest()
  setSessionClock(null)
})

test.after(async () => { await prisma.$disconnect() })

/* ───────────── ① 基准 + 改密 / 降权 / 禁用 / 删除 → 旧 token 立即失效、新 token 正常 ───────────── */

test('矩阵基准：新签发 token 通过统一失效校验（user_epoch / school_epoch 均无记录）', async () => {
  const userId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1base', passwordHash: HASH }, bcryptjs)
  const user = { id: userId, username: 'w1base', role: 'operator', school_code: SCHOOL }
  const { passed, res } = await authWith(tokenFor(user))
  assert.equal(passed, true, `基准 token 必须放行（res=${JSON.stringify(res.body)}）`)
})

test('改密（changePassword）：与业务写同事务推进 user epoch → 旧 token 401；新 token 正常', async () => {
  const userId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1pwd', passwordHash: HASH }, bcryptjs)
  const user = { id: userId, username: 'w1pwd', role: 'operator', school_code: SCHOOL }
  const oldToken = tokenFor(user)
  assert.equal((await authWith(oldToken)).passed, true, '改密前旧 token 有效')

  const tenantUM = userManager.forTenant(SCHOOL)
  const result = await tenantUM.changePassword(userId, PASSWORD, NEW_PASSWORD)
  assert.equal(result.success, true)

  const after = await authWith(oldToken)
  assert.equal(after.passed, false, '改密后旧 token 必须立即失效')
  assert.equal(after.res.statusCode, 401)
  assert.equal(after.res.body?.code, 'REVOKED')
  assert.equal(after.res.body?.reason, 'password_change', '401 必须可解释（附带吊销原因）')

  // 新 token（改密后签发）正常
  const fresh = await authWith(tokenFor(user))
  assert.equal(fresh.passed, true, '改密后新签发 token 必须有效（不被 epoch 误杀）')

  // epoch 行：确定性键、单行、类型 user_all
  const rows = await readEpochRows(prisma, { userId })
  const epoch = rows.filter((r) => r.jti === `user_epoch:${userId}`)
  assert.equal(epoch.length, 1, '用户级 epoch 恒一行（O(1) upsert）')
  assert.equal(epoch[0].token_type, 'user_all')
  assert.equal(epoch[0].reason, 'password_change')
})

test('降权（changeUserRole）：同事务 epoch → 旧 token 401 且角色无效（不沿用旧权限）', async () => {
  const userId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1role', passwordHash: HASH, role: 'manager' }, bcryptjs)
  const user = { id: userId, username: 'w1role', role: 'manager', school_code: SCHOOL }
  const token = tokenFor(user)
  assert.equal((await authWith(token)).passed, true)

  await userManager.forTenant(SCHOOL).changeUserRole(userId, 'viewer', { userId: 'w1-actor', username: 'actor', role: 'manager', schoolCode: SCHOOL })

  const after = await authWith(token)
  assert.equal(after.passed, false)
  assert.equal(after.res.statusCode, 401)
  const rows = await readEpochRows(prisma, { userId })
  const dbRole = await prisma.$queryRawUnsafe(`SELECT "role" FROM "${SCHEMA}"."User" WHERE "id" = $1`, userId)
  assert.equal(dbRole[0].role, 'viewer', '角色已变更（业务写已提交）')
  assert.ok(rows.some((r) => r.jti === `user_epoch:${userId}` && r.reason === 'role_change'), 'epoch 与角色写同事务落库')
})

test('禁用（disableUser）：同事务 epoch → 旧 token 401；账号状态与 epoch 一致', async () => {
  const userId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1disable', passwordHash: HASH }, bcryptjs)
  const user = { id: userId, username: 'w1disable', role: 'operator', school_code: SCHOOL }
  const token = tokenFor(user)
  assert.equal((await authWith(token)).passed, true)

  await userManager.forTenant(SCHOOL).disableUser(userId, { userId: 'w1-actor', role: 'manager', schoolCode: SCHOOL })

  const after = await authWith(token)
  assert.equal(after.passed, false)
  const rows = await readEpochRows(prisma, { userId })
  assert.ok(rows.some((r) => r.jti === `user_epoch:${userId}` && r.reason === 'user_disable'))
})

test('删除（deleteUser）：软删除墓碑（同一行 status=disabled + deleted_at/deleted_by）→ 同事务 epoch、旧 token 401', async () => {
  const username = `w1delete-${R7_TAG}`
  const userId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username, passwordHash: HASH }, bcryptjs)
  const user = { id: userId, username, role: 'operator', school_code: SCHOOL }
  const token = tokenFor(user)
  assert.equal((await authWith(token)).passed, true)
  // 契约（P3-LIFECYCLE-AB-R3 / M1）：删除 = **软删除**。审计/主体保全 ⇒ 禁止物理删除行。
  const before = await prisma.$queryRawUnsafe(
    `SELECT "status", "deleted_at", "deleted_by" FROM "${SCHEMA}"."User" WHERE "id" = $1`, userId)
  assert.equal(before.length, 1, '前置：待删用户行存在')
  assert.equal(before[0].status, 'active')
  assert.equal(before[0].deleted_at, null)

  await userManager.forTenant(SCHOOL).deleteUser(userId, { userId: 'w1-actor', role: 'manager', schoolCode: SCHOOL })

  // 旧断言「物理行数 0」已被软删除合同取代：同一行保留为墓碑（`tests/integration/live-api.mjs` 的 DELETE 200 亦依赖此语义）
  const tomb = await prisma.$queryRawUnsafe(
    `SELECT "id", "status", "disabled_reason", "deleted_at", "deleted_by" FROM "${SCHEMA}"."User" WHERE "id" = $1`, userId)
  assert.equal(tomb.length, 1, '软删除必须保留**同一行**（墓碑；禁止物理删除，审计/主体不得级联销毁）')
  assert.equal(tomb[0].id, userId, '墓碑 id 不变（身份不可复用：id 不得回收给新账号）')
  assert.equal(tomb[0].status, 'disabled', '墓碑 status=disabled')
  assert.equal(tomb[0].disabled_reason, 'deleted', '禁用原因标记为 deleted（与普通停用可区分）')
  assert.ok(tomb[0].deleted_at != null, 'deleted_at 必须置位（软删除时间戳）')
  assert.equal(tomb[0].deleted_by, 'w1-actor', 'deleted_by 记录执行删除者（可追溯）')

  const after = await authWith(token)
  assert.equal(after.passed, false)
  assert.equal(after.res.statusCode, 401, '删除后旧 token 必须 401（不因行保留而放行）')
  const rows = await readEpochRows(prisma, { userId })
  assert.ok(rows.some((r) => r.jti === `user_epoch:${userId}` && r.reason === 'user_delete'), '删除后 epoch 仍在（防 id 复用复活）')
})

test('软删除合同：登录拒绝；enableUser 禁复活（负例）／普通禁用可恢复（正例，旧 token 仍受 epoch 约束）', async () => {
  const um = userManager.forTenant(SCHOOL)
  const actor = { userId: 'w1-actor', username: 'actor', role: 'manager', schoolCode: SCHOOL }

  // ── 负例 A：已软删除账号 → 登录必须拒绝（不签发任何 token） ──
  const delName = `w1deletedlogin-${R7_TAG}`
  const delId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: delName, passwordHash: HASH }, bcryptjs)
  const delUser = { id: delId, username: delName, role: 'operator', school_code: SCHOOL }
  assert.equal((await authWith(tokenFor(delUser))).passed, true, '前置：删除前 token 有效')
  await um.deleteUser(delId, actor)

  let loginErr = null
  try { await um.loginUser(delName, PASSWORD) } catch (e) { loginErr = e }
  assert.ok(loginErr, '已软删除账号不得登录成功')
  assert.equal(loginErr.status, 403, `删除账号登录必须 403（实际 code=${loginErr.code} status=${loginErr.status}）`)
  assert.equal(loginErr.code, 'ACCOUNT_DISABLED', '错误码可解释（账号已禁用/删除）')
  assert.equal((await authWith(tokenFor(delUser))).passed, false, '已删除账号：即便重签 token 也不得放行')

  // ── 负例 B：enableUser 不得复活已删除账号（身份不可复用） ──
  let reviveErr = null
  try { await um.enableUser(delId, actor) } catch (e) { reviveErr = e }
  assert.ok(reviveErr, 'enableUser 对已删除账号必须拒绝（禁止复活）')
  assert.equal(reviveErr.status, 409)
  assert.match(String(reviveErr.message), /删除|身份不可复用/)
  const stillTomb = await prisma.$queryRawUnsafe(
    `SELECT "status", "deleted_at" FROM "${SCHEMA}"."User" WHERE "id" = $1`, delId)
  assert.equal(stillTomb[0].status, 'disabled', '禁复活被拒后状态不得被改写')
  assert.ok(stillTomb[0].deleted_at != null, 'deleted_at 保持（身份墓碑不撤销）')

  // ── 正例：仅"禁用"（未删除）的账号可被 enableUser 恢复；旧 token 仍受 epoch 约束 ──
  const disName = `w1reenable-${R7_TAG}`
  const disId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: disName, passwordHash: HASH }, bcryptjs)
  const disUser = { id: disId, username: disName, role: 'operator', school_code: SCHOOL }
  const disToken = tokenFor(disUser)
  await um.disableUser(disId, actor)
  const r = await um.enableUser(disId, actor)
  assert.equal(r.success, true, '普通禁用（未删除）必须可恢复 —— 不因禁复活规则误伤')
  const restored = await prisma.$queryRawUnsafe(
    `SELECT "status", "deleted_at" FROM "${SCHEMA}"."User" WHERE "id" = $1`, disId)
  assert.equal(restored[0].status, 'active')
  assert.equal(restored[0].deleted_at, null, '恢复的是禁用态账号：无 deleted_at（与墓碑可区分）')
  // 恢复不等于"旧 token 复活"：禁用时已 bump epoch ⇒ 旧 token 仍然 401；新签发有效
  const disAfter = await authWith(disToken)
  assert.equal(disAfter.passed, false, '恢复账号不得使旧 token 复活（epoch 语义保留）')
  assert.equal(disAfter.res.statusCode, 401)
  assert.equal((await authWith(tokenFor(disUser))).passed, true, '恢复后新登录（新签发）正常')
})

/* ───────────── ② 登出（真实路由 handler） ───────────── */

test('登出（POST /api/user/logout）：服务端吊销当前 jti → 旧 token 401；新 token 正常', async () => {
  const userId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1logout', passwordHash: HASH }, bcryptjs)
  const user = { id: userId, username: 'w1logout', role: 'operator', school_code: SCHOOL }
  const { token, jti } = userManager.buildAccessToken(user)
  assert.equal((await authWith(token)).passed, true)

  const router = createUserRoutes(userManager)
  const logout = handlerOf(router, 'post', '/logout')
  const req = {
    headers: { authorization: `Bearer ${token}` },
    method: 'POST', path: '/api/user/logout', originalUrl: '/api/user/logout', url: '/api/user/logout',
    user: { ...userManager.verifyToken(token).user },
  }
  const res = mockRes()
  await logout(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body?.success, true)

  const rows = await prisma.$queryRawUnsafe(`SELECT reason FROM public.revoked_tokens WHERE jti = $1`, jti)
  assert.equal(rows.length, 1, '登出必须写入 jti 吊销行')
  assert.equal(rows[0].reason, 'logout')

  const after = await authWith(token)
  assert.equal(after.passed, false)
  assert.equal(after.res.statusCode, 401)
  assert.equal((await authWith(tokenFor(user))).passed, true, '登出只失效当前会话，新登录正常')
})

/* ───────────── ③ 停校 O(1)（真实 schoolRoutes handler） ───────────── */

test('停校（PATCH /api/admin/schools/:code/status）：一行学校级 epoch 使全校会话失效（O(1)）', async () => {
  const u1 = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1stop1', passwordHash: HASH }, bcryptjs)
  const u2 = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1stop2', passwordHash: HASH }, bcryptjs)
  const t1 = tokenFor({ id: u1, username: 'w1stop1', role: 'operator', school_code: SCHOOL })
  const t2 = tokenFor({ id: u2, username: 'w1stop2', role: 'operator', school_code: SCHOOL })
  assert.equal((await authWith(t1)).passed, true)
  assert.equal((await authWith(t2)).passed, true, '两名不同用户的 token 均有效')

  const before = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM public.revoked_tokens WHERE school_code = $1 AND token_type = 'school_epoch'`, SCHOOL
  )
  const router = createSchoolRoutes({
    prisma,
    authenticateUser: (req, res, next) => next(),
    clearGuestVisibleTypesCache: () => {},
    rateLimit: () => (req, res, next) => next(),
    requirePlatformSuperAdmin: (req, res, next) => next(),
  })
  const patch = handlerOf(router, 'patch', '/api/admin/schools/:code/status')
  const req = { params: { code: SCHOOL }, body: { status: 'disabled' }, user: { username: 'w1-admin', userId: 'w1-admin' } }
  const res = mockRes()
  await patch(req, res)
  assert.equal(res.statusCode, 200, `停校接口应成功：${JSON.stringify(res.body)}`)

  const after = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM public.revoked_tokens WHERE school_code = $1 AND token_type = 'school_epoch'`, SCHOOL
  )
  assert.equal(Number(after[0].n) - Number(before[0].n), 1, '停校只新增一行学校级 epoch（O(1)，禁止逐 token 循环）')

  for (const [label, token] of [['用户1', t1], ['用户2', t2]]) {
    const r = await authWith(token)
    assert.equal(r.passed, false, `停校后 ${label} 的 token 必须立即失效`)
    assert.equal(r.res.statusCode, 401)
    assert.equal(r.res.body?.code, 'REVOKED')
  }
  // 恢复学校状态（后续用例继续可用）
  await ensureSchoolRow(prisma, { code: SCHOOL, status: 'active' })
  const events = await prisma.$queryRawUnsafe(`SELECT reason FROM public.revoked_tokens WHERE jti = $1`, `school_epoch:${SCHOOL}`)
  assert.equal(events.length, 1)
  assert.equal(events[0].reason, 'school_suspended')
})

/* ───────────── ④ DB 故障窗口（AUD-016）：吊销写失败 → 业务不得半提交 ───────────── */

test('DB 故障窗口：epoch 写入失败 → 整体回滚（业务变更不落地）、错误向上抛、状态可解释', async () => {
  const userId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1dbfail', passwordHash: HASH, role: 'operator' }, bcryptjs)
  const user = { id: userId, username: 'w1dbfail', role: 'operator', school_code: SCHOOL }
  const token = tokenFor(user)

  // 代理：事务内 epoch upsert 抛错（模拟吊销写失败），业务写正常执行 → 整体应回滚
  // 注意用 Proxy（不可 spread：PrismaClient 方法在原型上，spread 会丢方法 → 误入能力退化路径）
  const brokenPrisma = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (cb) => target.$transaction((tx) => cb({
          $executeRawUnsafe: async (sql, ...params) => {
            if (/INSERT INTO public\.revoked_tokens/i.test(sql)) throw new Error('w1-injected: epoch write failed')
            return tx.$executeRawUnsafe(sql, ...params)
          },
          $queryRawUnsafe: (...args) => tx.$queryRawUnsafe(...args),
          user: tx.user,
        }))
      }
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const brokenUM = new UserManager(brokenPrisma, JWT_SECRET)
  brokenUM.rootPrisma = brokenPrisma

  let thrown = null
  try {
    await brokenUM.forTenant(SCHOOL).disableUser(userId, { userId: 'w1-actor', role: 'manager', schoolCode: SCHOOL })
  } catch (e) { thrown = e }
  assert.ok(thrown, '吊销写失败必须整体失败（不得"业务成功 + 吊销吞错"）')
  assert.match(String(thrown.message), /epoch write failed/, '错误可解释（保留原始原因）')

  const row = await prisma.$queryRawUnsafe(`SELECT "status" FROM "${SCHEMA}"."User" WHERE "id" = $1`, userId)
  assert.equal(row[0].status, 'active', '业务写必须回滚（用户仍 active）——无半提交')
  const epoch = await readEpochRows(prisma, { userId })
  assert.equal(epoch.filter((r) => r.jti === `user_epoch:${userId}`).length, 0, 'epoch 未落库')
  // 状态可解释：业务未提交 → 旧权限与旧状态一致（不沿用"已停用"的半提交状态）
  assert.equal((await authWith(token)).passed, true, '未提交 → token 仍与 active 状态一致')
})

/* ───────────── ⑤ 固定时钟：同秒 iat 边界（真实 DB + idt 精确比较） ───────────── */

test('固定时钟 · 同秒边界：epoch 之前签发的 token 失效、之后签发的有效；旧 token（无 idt）按 iat+1', async () => {
  // 固定时钟取**未来**时刻：避免此前用例（停校 O(1)）以真实时刻写入的 school_epoch 干扰时间比较
  const T0 = 1_900_000_000_000
  await clearSchoolEpoch()
  const userId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1clock', passwordHash: HASH }, bcryptjs)
  const user = { id: userId, username: 'w1clock', role: 'operator', school_code: SCHOOL }

  setSessionClock(() => T0)
  const tokenBefore = tokenFor(user)            // idt = T0（同秒、epoch 之前）
  assert.equal(sessionNow(), T0)

  // 手动推进 epoch 到 T0 + 800ms（同一秒内）——用真实 UserManager 路径（同事务）不可注入 at，
  // 故此处直接用 epoch 写入器的真实 SQL 语义：bumpUserEpoch(tx,{at})（tx = 真实 prisma）
  const { bumpUserEpoch } = await import('../../lib/sessionEpoch.js')
  await prisma.$transaction(async (tx) => {
    await bumpUserEpoch(tx, { userId, schoolCode: SCHOOL, reason: 'clock_test', at: T0 + 800 })
  })

  const staleCheck = await authWith(tokenBefore)
  assert.equal(staleCheck.passed, false, '同一秒内、epoch 之前签发的 token 必须失效（idt 精确比较）')

  setSessionClock(() => T0 + 1200)
  const tokenAfter = tokenFor(user)             // idt = T0+1200 > epoch
  assert.equal((await authWith(tokenAfter)).passed, true, '同一秒内、epoch 之后签发的 token 必须有效（改密后自动重登语义）')

  // 旧 token（无 idt，仅 iat）→ iat+1 兼容边界：与 epoch 同一秒 → 仍有效；早 1 秒 → 失效。
  // 该子场景用**真实时刻**并跨秒构造（独立用户）：jsonwebtoken 在 noTimestamp:true 时会**删除显式 iat**，
  // 故不能用 noTimestamp 伪造 iat；改为「等待跨秒」保证两个 token 的 iat 恰好相差 1 秒，再按同秒写 epoch。
  const legacyUserId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1clocklegacy', passwordHash: HASH }, bcryptjs)
  const { bumpUserEpoch: bumpU } = await import('../../lib/sessionEpoch.js')
  const payloadOf = { userId: legacyUserId, username: 'w1clocklegacy', role: 'operator', schoolCode: SCHOOL }
  const waitNextSecond = async () => {
    const s0 = Math.floor(Date.now() / 1000)
    while (Math.floor(Date.now() / 1000) === s0) await new Promise((r) => setTimeout(r, 40))
  }
  const legacyPrevSecond = jwt.sign(payloadOf, JWT_SECRET, { algorithm: 'HS256', expiresIn: '30m' })  // iat = S-1
  await waitNextSecond()
  const epochSec = Math.floor(Date.now() / 1000)                                                      // iat(S) = S
  const legacySameSecond = jwt.sign(payloadOf, JWT_SECRET, { algorithm: 'HS256', expiresIn: '30m' })
  assert.equal(jwt.decode(legacyPrevSecond).iat, epochSec - 1, '前置：两个旧 token 的 iat 必须相差 1 秒')
  assert.equal(jwt.decode(legacySameSecond).iat, epochSec, '前置：同秒 token 的 iat 必须等于 epoch 所在秒')
  await prisma.$transaction(async (tx) => {
    await bumpU(tx, { userId: legacyUserId, schoolCode: SCHOOL, reason: 'legacy_boundary', at: epochSec * 1000 })
  })
  const legacySameRes = await authWith(legacySameSecond)
  assert.equal(legacySameRes.passed, true, `无 idt 旧 token：同秒按 iat+1 边界仍有效（实际 ${legacySameRes.res.statusCode} ${JSON.stringify(legacySameRes.res.body)}）`)
  const legacyPrevRes = await authWith(legacyPrevSecond)
  assert.equal(legacyPrevRes.passed, false, `无 idt 旧 token：早 1 秒必须失效（实际 ${legacyPrevRes.res.statusCode}）`)
})

/* ───────────── ⑥ 两阶段兼容（compat / strict） ───────────── */

test('两阶段兼容：compat 接受无 jti 旧 token（仍受 epoch 失效约束）；strict 显式开关一律拒绝', async () => {
  const prevMode = process.env.SESSION_LEGACY_TOKEN_MODE
  delete process.env.SESSION_LEGACY_TOKEN_MODE
  await clearSchoolEpoch()   // 隔离此前用例（停校 O(1)）写入的学校级 epoch
  const userId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1legacy', passwordHash: HASH }, bcryptjs)
  // 注意：不可用 noTimestamp+显式 iat（jsonwebtoken 会删除 iat）→ 用真实 iat 签名
  const legacy = jwt.sign(
    { userId, username: 'w1legacy', role: 'operator', schoolCode: SCHOOL },
    JWT_SECRET, { algorithm: 'HS256', expiresIn: '30m' }
  )
  try {
    // 阶段一 compat：接受（消息为兼容放行）
    const compat = await authWith(legacy)
    assert.equal(compat.passed, true, 'compat 阶段不得全量强制重登（旧 token 仍验）')
    assert.equal(legacyTokenMetrics().accepted >= 1, true, '兼容期接受计数可观测')

    // 安全等价：epoch 仍能失效无 jti 的旧 token。
    // 注意：epoch 必须晚于 token 的 iat **至少 1 秒**（同秒按 iat+1 边界本就有效，见 AUD-015），
    // 故此处显式把 epoch 时间钉在 (iat+1) 秒，保证判定确定（不依赖跨秒等待）。
    const { bumpUserEpoch } = await import('../../lib/sessionEpoch.js')
    const legacyIat = jwt.decode(legacy).iat
    await prisma.$transaction(async (tx) => {
      await bumpUserEpoch(tx, { userId, schoolCode: SCHOOL, reason: 'compat_epoch_check', at: (legacyIat + 1) * 1000 })
    })
    const compatAfterEpoch = await authWith(legacy)
    assert.equal(compatAfterEpoch.passed, false, '兼容阶段旧 token 同样受 epoch 约束（安全等价）')

    // 阶段二 strict：一律拒绝（显式运维开关）
    process.env.SESSION_LEGACY_TOKEN_MODE = 'strict'
    const legacy2 = jwt.sign(
      { userId, username: 'w1legacy', role: 'operator', schoolCode: SCHOOL },
      JWT_SECRET, { algorithm: 'HS256', expiresIn: '30m' }
    )
    const strict = await authWith(legacy2)
    assert.equal(strict.passed, false)
    assert.equal(strict.res.statusCode, 401)
    assert.equal(strict.res.body?.code, 'LEGACY_TOKEN_REJECTED')
    assert.equal(strict.res.body?.phase, 'strict')
    assert.equal(legacyTokenMetrics().rejectedStrict >= 1, true, 'strict 拒绝计数可观测')
  } finally {
    if (prevMode === undefined) delete process.env.SESSION_LEGACY_TOKEN_MODE
    else process.env.SESSION_LEGACY_TOKEN_MODE = prevMode
  }
})

/* ───────────── ⑦ fail-soft 边界（AUD-014）：写请求 fail-closed、只读受限 ───────────── */

test('AUD-014 边界：DB 回查失败时写请求立即 503（fail-closed）；只读请求窗口内降级、超窗后 503', async () => {
  const { setSessionClock: setClock } = await import('../../lib/sessionEpoch.js')
  // 先建真实用户：降级分支只在"能查用户但查询失败"时触发（用户不存在会先 401 账号状态已变更）
  const softUserId = await upsertTenantUser(prisma, { schema: SCHEMA, schoolCode: SCHOOL, username: 'w1failsoft', passwordHash: HASH }, bcryptjs)
  const user = { id: softUserId, username: 'w1failsoft', role: 'operator', school_code: SCHOOL }
  const token = userManager.buildAccessToken(user).token
  // 说明：tokenClient 的租户客户端由 baseDatabaseUrl()（process.env.DATABASE_URL）构造，
  // 传入的 prisma 实例不参与租户连接 → 用「把 DATABASE_URL 指向不可达地址」模拟**租户回查失败**，
  // 而吊销/epoch 校验走本中间件的 rootPrisma（仍连真实实例）→ 精确复现"状态回查不可用"窗口。
  const { disconnectAllTenantClients } = await import('../../lib/tenantClient.js')
  const goodUrl = process.env.DATABASE_URL
  const breakTenantDb = async () => {
    if (typeof disconnectAllTenantClients === 'function') await disconnectAllTenantClients()
    process.env.DATABASE_URL = `postgresql://nobody:nobody@127.0.0.1:1/${w1.cfg.database}`
  }
  const restoreTenantDb = async () => {
    process.env.DATABASE_URL = goodUrl
    if (typeof disconnectAllTenantClients === 'function') await disconnectAllTenantClients()
  }
  const brokenUM = userManager

  const call = async (method) => {
    const { createAuthMiddleware: createMW, getRecheckFailState } = await import('../../middleware/authMiddleware.js')
    const { authenticateUser } = createMW(brokenUM, prisma)
    const req = { headers: { authorization: `Bearer ${token}` }, method, path: '/api/test-records', originalUrl: '/api/test-records', url: '/api/test-records' }
    const res = mockRes()
    let passed = false
    await authenticateUser(req, res, () => { passed = true })
    return { passed, res, state: getRecheckFailState() }
  }

  _resetRecheckFailStateForTest()
  await breakTenantDb()
  const write = await call('POST')
  assert.equal(write.passed, false, '写请求在状态不可核验时必须 fail-closed')
  assert.equal(write.res.statusCode, 503)
  assert.equal(write.res.body?.code, 'AUTH_WRITE_FAIL_CLOSED')

  _resetRecheckFailStateForTest()
  const read = await call('GET')
  assert.equal(read.passed, true, '只读请求在窗口内允许 fail-soft（沿用 token 角色）')
  assert.equal(read.state.failSoftSince !== null, true, '降级窗口起点可观测（明确时限）')

  // 明确时限：把时钟推进到窗口之外（默认 30s）→ 只读也 fail-closed
  _resetRecheckFailStateForTest()
  const base = Date.now()
  setClock(() => base)
  await call('GET')
  setClock(() => base + 31_000)
  const expired = await call('GET')
  assert.equal(expired.passed, false, '超过 AUTH_FAILSOFT_MAX_MS 后只读也必须 fail-closed')
  assert.equal(expired.res.statusCode, 503)
  assert.equal(expired.res.body?.reason, 'fail-soft-window-expired')
  setClock(null)
  await restoreTenantDb()   // 恢复真实连接与客户端缓存
})

/* ───────────── ⑧ 写屏障挂载证据（server.js） ───────────── */

test('server.js 写屏障挂载：静态证据（挂载 + try/catch 不阻断启动）+ 真实启动后 READONLY_MODE 写 503/读 200', async () => {
  const serverSrc = fs.readFileSync(path.join(repoRoot, 'backend/server.js'), 'utf8')
  assert.match(serverSrc, /import \{ createWriteBarrierMiddleware \} from '\.\/lib\/tenantWriteBarrier\.js'/, '必须导入 W3 交付的屏障中间件')
  assert.match(serverSrc, /try \{\s*app\.use\(createWriteBarrierMiddleware\(\)\)/, '必须挂载（app.use）')
  assert.match(serverSrc, /写屏障中间件挂载失败（不阻断启动/, '挂载失败必须有捕获分支（不破坏启动）')

  // 真实启动（隔离实例 + READONLY_MODE）：POST 写路径 → 503 GLOBAL_MAINTENANCE；GET /api/health → 200
  const { spawn } = await import('node:child_process')
  const port = Number(w1.cfg.port) + 500
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      DATABASE_URL: w1.adminUrl,
      JWT_SECRET: 'w1-live-jwt-secret-' + 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'w1-live-refresh-secret-' + 'b'.repeat(32),
      READONLY_MODE: 'true',
      // P3-HARNESS-CHECK-R1（溯源）：不再用 AUTO_SYNC_TENANTS=false 绕过——
      // test.before 已把实例推进到迁移链尾，这里走**默认 check**；readyz=200 才继续后续断言。
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { out += d.toString() })
  // P3-HARNESS-CHECK-R1：就绪 = liveness(200) ∧ readiness(readyz=200)。
  // 默认 check 下 readyz 200 表示迁移证明通过（无 attestation；false 会同时 503，不作为测试前提）。
  let lastReadiness = null
  const waitReady = async (timeoutMs = 20_000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`)
        if (r.status === 200) {
          const rz = await fetch(`http://127.0.0.1:${port}/api/readyz`)
          let rzBody = null
          try { rzBody = await rz.json() } catch { /* 非 JSON */ }
          lastReadiness = { health: 200, readyz: rz.status, body: rzBody }
          if (rz.status === 200) return true
        }
      } catch { /* 未就绪 */ }
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }
  try {
    const ready = await waitReady()
    assert.equal(ready, true, `server.js 未在超时内就绪（health+readyz；输出：${out.slice(-400)}；readiness=${JSON.stringify(lastReadiness)}）`)
    // 默认 check 放行证据：readiness 200（迁移证明 + 台账 + 额外对象全部通过）
    assert.equal(lastReadiness?.readyz, 200, `readyz 必须 200（默认 check 通过）：${JSON.stringify(lastReadiness)}`)
    assert.equal(preparedInstance?.tenantCheckRc, 0, 'test.before 的租户链 --check 必须 rc=0（前置自证）')
    const health = await fetch(`http://127.0.0.1:${port}/api/health`)
    assert.equal(health.status, 200, '只读请求不受屏障影响')
    // 目标租户业务 API 未被迁移闸门阻断：未认证 → 401（授权层），绝不是 503 迁移阻断
    const tenantProbe = await fetch(`http://127.0.0.1:${port}/api/test-records?schoolCode=${encodeURIComponent(SCHOOL)}`)
    const tenantProbeBody = await tenantProbe.json().catch(() => ({}))
    assert.notEqual(tenantProbe.status, 503, `租户业务入口不得被迁移闸门 503（readiness 已通过）：${JSON.stringify(tenantProbeBody)}`)
    assert.ok(
      !['TENANT_MIGRATION_NOT_READY', 'TENANT_SCHEMA_NOT_READY', 'TENANT_NOT_ATTRIBUTED'].includes(tenantProbeBody.code),
      `租户入口不得返回迁移阻断码：${JSON.stringify(tenantProbeBody)}`,
    )
    assert.equal(tenantProbe.status, 401, `未认证的租户业务请求应 401（证明路由可达且闸门放行）：${JSON.stringify(tenantProbeBody)}`)
    const write = await fetch(`http://127.0.0.1:${port}/api/user/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'y', schoolCode: SCHOOL }),
    })
    assert.equal(write.status, 503, '维护窗口内写请求必须被拦下（证明写阻断链路已挂载生效）')
    const body = await write.json().catch(() => ({}))
    // 组合语义：先挂载的 readOnlyGuard（全局 READONLY_MODE）与后挂载的 tenantWriteBarrier 都在写路径生效；
    // 两者对全局维护返回同一 503 语义（本断言兼容两种 503 载体，证明"写路径确实被应用层拦下"）。
    assert.ok(
      body.code === 'GLOBAL_MAINTENANCE' || /维护/.test(String(body.error || '')),
      `写请求 503 响应体应表明维护语义：${JSON.stringify(body)}`
    )
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 300))
  }
})
