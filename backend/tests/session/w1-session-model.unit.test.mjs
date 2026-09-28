// P3-W1-T01（RC-02）统一失效模型 · 纯单元回归（**不需要数据库**）
//
// 覆盖口径（任务包 §设计口径 / 退出条件）：
//   · AUD-015 同秒 iat 边界 + 毫秒 idt 精确比较（固定时钟钉死）；
//   · 单点校验 SQL（唯一事实源）：一条语句覆盖 jti / user_all(用户级 epoch) / school_epoch / School.status，
//     且时间阈值只有一个统一表达式（不得各分支各自解释）；
//   · epoch 写入：确定性键 O(1) upsert、保留期长于最长令牌 TTL、失败向上抛；
//   · AUD-016 同事务执行器：业务写与 epoch 写在**同一事务**内（顺序 + 回滚传播）；
//   · AUD-012/015/016 两阶段兼容：compat（默认接受无 jti 旧 token）/ strict（拒绝）+ 度量；
//   · AUD-014 fail-soft 边界：仅只读方法 + 明确时限窗口。
//
// 运行：node --test backend/tests/session/w1-session-model.unit.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  USER_EPOCH_TYPE,
  SCHOOL_EPOCH_TYPE,
  userEpochKey,
  schoolEpochKey,
  isSessionStale,
  buildSessionValiditySql,
  bumpUserEpoch,
  bumpSchoolEpoch,
  runSessionSafeMutation,
  legacyTokenMode,
  recordLegacyTokenDecision,
  legacyTokenMetrics,
  _resetLegacyTokenMetricsForTest,
  failSoftMayApply,
  failSoftWindowMs,
  setSessionClock,
  sessionNow,
} from '../../lib/sessionEpoch.js'

const FIXED = 1_760_000_000_123 // 固定时钟（毫秒）

test.before(() => setSessionClock(() => FIXED))
test.after(() => setSessionClock(null))

/* ───────────── 1. AUD-015：同秒边界 + idt 精确比较（固定时钟） ───────────── */

test('AUD-015 · idt 毫秒精确：吊销前的 token 失效、吊销后的 token 有效（同秒内也能区分）', () => {
  const epoch = new Date(FIXED)
  // 同秒内、epoch 之前 500ms 签发 → 失效
  assert.deepEqual(isSessionStale({ iat: Math.floor(FIXED / 1000), idt: FIXED - 500, userEpochAt: epoch }), {
    stale: true, source: USER_EPOCH_TYPE, precise: true,
  })
  // 同秒内、epoch 之后 500ms 签发（改密后自动重登）→ 有效
  assert.equal(isSessionStale({ iat: Math.floor(FIXED / 1000), idt: FIXED + 500, userEpochAt: epoch }).stale, false)
  // 与 epoch 同一毫秒签发 → 按"不早于"判定失效（更保守）
  assert.equal(isSessionStale({ iat: Math.floor(FIXED / 1000), idt: FIXED, userEpochAt: epoch }).stale, true)
})

test('AUD-015 · 旧 token（无 idt）退化为 iat+1 兼容边界：同秒新 token 不被误杀、早 1 秒必失效', () => {
  const epoch = new Date(FIXED)
  const sameSecond = Math.floor(FIXED / 1000)
  assert.equal(isSessionStale({ iat: sameSecond, userEpochAt: epoch }).stale, false, 'iat+1 边界：同秒 token 有效')
  assert.equal(isSessionStale({ iat: sameSecond - 1, userEpochAt: epoch }).stale, true, '早 1 秒的 token 必须失效')
})

test('学校级 epoch 与用户级 epoch 同口径；学校级优先报出；空 epoch 不误判', () => {
  const epoch = new Date(FIXED)
  assert.deepEqual(isSessionStale({ iat: 1, idt: FIXED - 1, userEpochAt: epoch, schoolEpochAt: epoch }), {
    stale: true, source: SCHOOL_EPOCH_TYPE, precise: true,
  })
  assert.equal(isSessionStale({ iat: 1, idt: FIXED - 1, schoolEpochAt: epoch }).stale, true)
  assert.equal(isSessionStale({ iat: 1, idt: FIXED - 1, userEpochAt: null, schoolEpochAt: null }).stale, false)
})

/* ───────────── 2. 单点校验 SQL（唯一事实源） ───────────── */

test('单点 SQL：一条语句覆盖 jti / user_all / school_epoch / School.status 且时间阈值唯一', () => {
  const sql = buildSessionValiditySql()
  assert.match(sql, /WHERE jti = \$1::text/, '① jti 精确吊销（无条件）')
  assert.match(sql, new RegExp(`token_type = '${USER_EPOCH_TYPE}' AND user_id = \\$2::text`), '② 用户级 epoch（user_all）')
  assert.match(sql, new RegExp(`token_type = '${SCHOOL_EPOCH_TYPE}'`), '③ 学校级 epoch')
  assert.match(sql, /FROM public\."School"/, '④ 学校权威状态（停校）')
  assert.match(sql, /status <> 'active'/, '④ 仅非 active 命中')
  assert.match(sql, /\$4::text IS NOT NULL AND school_code = \$4::text/, '学校维度取 $4（参数序：jti,userId,iat,schoolCode,idt）')
  // 统一阈值表达式恰好出现 2 次（user_all / school_epoch 分支）；jti 分支无条件、School 分支用当前状态
  const threshold = /CASE WHEN \$5::bigint IS NOT NULL THEN to_timestamp\(\$5::bigint \/ 1000\.0\) ELSE to_timestamp\(\$3::bigint \+ 1\) END/g
  assert.equal((sql.match(threshold) || []).length, 2, '时间阈值必须只有一个统一实现')
  assert.match(sql, /ORDER BY t\.revoked_at DESC\s+LIMIT 1/)
})

test('epoch 键确定性（O(1) upsert 前提）与类型常量语义统一', () => {
  assert.equal(userEpochKey('u1'), 'user_epoch:u1')
  assert.equal(schoolEpochKey('school-a'), 'school_epoch:school-a')
  assert.equal(USER_EPOCH_TYPE, 'user_all', '用户级 epoch 沿用 user_all 语义（与历史/DB 触发器同口径）')
  assert.equal(SCHOOL_EPOCH_TYPE, 'school_epoch')
})

/* ───────────── 3. epoch 写入：O(1) upsert + 保留期 + 失败向上抛 ───────────── */

function fakeTx() {
  const calls = []
  return {
    calls,
    $executeRawUnsafe: async (sql, ...params) => { calls.push({ sql, params }); return 1 },
    $queryRawUnsafe: async () => [],
  }
}

test('bumpUserEpoch：确定性键 upsert（同用户恒一行）、保留期 > 最长令牌 TTL、失败向上抛', async () => {
  const tx = fakeTx()
  await bumpUserEpoch(tx, { userId: 'u1', schoolCode: 'school-a', reason: 'role_change', at: FIXED })
  assert.equal(tx.calls.length, 1)
  const [c] = tx.calls
  assert.match(c.sql, /INSERT INTO public\.revoked_tokens/)
  assert.match(c.sql, /ON CONFLICT \(jti\) DO UPDATE/, 'upsert：同一用户恒一行（O(1)）')
  assert.match(c.sql, /'user_all'/, '类型字面量（兼容历史校验与 DB 触发器口径）')
  assert.equal(c.params[0], 'user_epoch:u1')
  assert.equal(c.params[1], 'u1')
  assert.equal(c.params[3], 'role_change')
  assert.equal(new Date(c.params[4]).getTime(), FIXED)
  assert.ok(new Date(c.params[5]).getTime() - FIXED > 7 * 86400 * 1000, 'epoch 保留期必须长于 refresh 7d')

  const failing = { $executeRawUnsafe: async () => { throw new Error('db down') } }
  await assert.rejects(() => bumpUserEpoch(failing, { userId: 'u1' }), /db down/, '写入失败必须向上抛（不吞错）')
})

test('bumpSchoolEpoch：确定性键 upsert（停校 O(1)，不逐 token 写行）', async () => {
  const tx = fakeTx()
  await bumpSchoolEpoch(tx, { schoolCode: 'school-a', reason: 'school_suspended', at: FIXED })
  assert.equal(tx.calls.length, 1, '停校只写一行（O(1)）')
  assert.equal(tx.calls[0].params[0], 'school_epoch:school-a')
  assert.match(tx.calls[0].sql, /'school_epoch'/)
})

/* ───────────── 4. AUD-016 同事务执行器 ───────────── */

test('runSessionSafeMutation：业务写与 epoch 写在同一事务内、顺序正确（先业务后 epoch）', async () => {
  const order = []
  const tx = {
    $executeRawUnsafe: async (sql) => { order.push(sql.includes('revoked_tokens') ? 'epoch' : 'business'); return 1 },
  }
  const prisma = {
    $transaction: async (cb) => cb(tx),
    $executeRawUnsafe: async () => { throw new Error('不得在事务外执行') },
  }
  const out = await runSessionSafeMutation({
    prisma, schoolCode: null, userId: 'u1', reason: 'password_change', at: FIXED,
    mutate: async ({ tx: t, schema }) => {
      assert.equal(schema, 'public', 'school_code 为空 → public schema')
      await t.$executeRawUnsafe('UPDATE "public"."User" SET "status" = $2 WHERE "id" = $1', 'u1', 'disabled')
      return 'business-done'
    },
  })
  assert.equal(out, 'business-done')
  assert.deepEqual(order, ['business', 'epoch'], '先业务写、后 epoch 写，同一事务')
})

test('runSessionSafeMutation：业务写失败 → 不写 epoch 且错误向上抛（整体失败，无半提交）', async () => {
  const executed = []
  const tx = { $executeRawUnsafe: async (sql) => { executed.push(sql); if (!sql.includes('revoked_tokens')) throw new Error('business failed'); return 1 } }
  const prisma = { $transaction: async (cb) => cb(tx) }
  await assert.rejects(() => runSessionSafeMutation({
    prisma, schoolCode: 'school-a', userId: 'u1', reason: 'user_disable', at: FIXED,
    mutate: async ({ tx: t }) => t.$executeRawUnsafe('UPDATE "school_x"."User" SET "status" = \'disabled\' WHERE "id" = $1', 'u1'),
  }), /business failed/)
  assert.equal(executed.some((s) => s.includes('revoked_tokens')), false, '业务失败时不得写 epoch')
})

test('runSessionSafeMutation：schema 按学校派生（schoolCode 空 → public，非空 → tenantClient.schemaNameOf 归一）', async () => {
  const schemas = []
  const prisma = { $transaction: async (cb) => cb({ $executeRawUnsafe: async () => 1 }) }
  // schemaNameOf：code 内 '-' → '_' 且带 school_ 前缀（与生产派生规则一致）
  for (const [schoolCode, expect] of [[null, 'public'], ['school-a', 'school_a']]) {
    await runSessionSafeMutation({
      prisma, schoolCode, userId: 'u1', reason: 't', at: FIXED,
      mutate: async ({ schema }) => { schemas.push(schema) },
    })
    assert.equal(schemas[schemas.length - 1], expect)
  }
})

/* ───────────── 5. 两阶段兼容 + 度量 ───────────── */

test('两阶段兼容：默认 compat；SESSION_LEGACY_TOKEN_MODE=strict → strict（显式运维开关）', () => {
  const prev = process.env.SESSION_LEGACY_TOKEN_MODE
  delete process.env.SESSION_LEGACY_TOKEN_MODE
  assert.equal(legacyTokenMode(), 'compat', '默认阶段一：兼容旧 token（不得全量强制重登）')
  process.env.SESSION_LEGACY_TOKEN_MODE = 'strict'
  assert.equal(legacyTokenMode(), 'strict')
  process.env.SESSION_LEGACY_TOKEN_MODE = 'STRICT'
  assert.equal(legacyTokenMode(), 'strict', '大小写不敏感')
  process.env.SESSION_LEGACY_TOKEN_MODE = 'whatever'
  assert.equal(legacyTokenMode(), 'compat', '未知值回退安全默认（compat）')
  if (prev === undefined) delete process.env.SESSION_LEGACY_TOKEN_MODE
  else process.env.SESSION_LEGACY_TOKEN_MODE = prev
})

test('兼容期度量：可观测接受/拒绝计数（阶段二切换决策用）', () => {
  _resetLegacyTokenMetricsForTest()
  recordLegacyTokenDecision({ accepted: true })
  recordLegacyTokenDecision({ accepted: true })
  recordLegacyTokenDecision({ accepted: false })
  const m = legacyTokenMetrics()
  assert.equal(m.accepted, 2)
  assert.equal(m.rejectedStrict, 1)
  assert.ok(m.lastAt)
})

/* ───────────── 6. AUD-014 fail-soft 边界 ───────────── */

test('fail-soft 仅限可证明只读方法（写请求一律 fail-closed）', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(failSoftMayApply({ method }), true, `${method} 只读放行`)
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(failSoftMayApply({ method }), false, `${method} 必须 fail-closed`)
  }
  assert.equal(failSoftMayApply({}), true, '缺省按 GET 处理（与既有测试替身兼容）')
})

test('fail-soft 明确时限：默认 30s，可用 AUTH_FAILSOFT_MAX_MS 覆盖', () => {
  const prev = process.env.AUTH_FAILSOFT_MAX_MS
  delete process.env.AUTH_FAILSOFT_MAX_MS
  assert.equal(failSoftWindowMs(), 30_000)
  process.env.AUTH_FAILSOFT_MAX_MS = '5000'
  assert.equal(failSoftWindowMs(), 5000)
  process.env.AUTH_FAILSOFT_MAX_MS = 'bad'
  assert.equal(failSoftWindowMs(), 30_000, '非法值回退默认时限')
  if (prev === undefined) delete process.env.AUTH_FAILSOFT_MAX_MS
  else process.env.AUTH_FAILSOFT_MAX_MS = prev
})

test('sessionNow() 走注入时钟（固定时钟证据：同一测试内两次读取恒等）', () => {
  assert.equal(sessionNow(), FIXED)
  assert.equal(sessionNow(), FIXED)
})
