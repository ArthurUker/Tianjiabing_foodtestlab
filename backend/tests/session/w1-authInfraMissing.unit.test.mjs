// P3-PUBLIC-INFRA-CHAIN-R1 · 认证基础设施缺失 fail-closed 定点（**无需 PG / 真实 DB**）
//
// 覆盖（R9 §1 / R6 C2：同一可审发布撤出运行时 DDL）：
//   ① `assertRevocationInfra` 只读形状断言：缺表 / 缺索引 → `AUTH_INFRA_MISSING`（携带 issues + runtimeDdlWithdrawn）；
//   ② `ensureRevocationInfra`（memoized）失败**不缓存**（DB 恢复后可重试）；
//   ③ `authenticateUser`：基础设施缺失 → **503 AUTH_INFRA_MISSING**，即使 GET（fail-soft 适用面）也不降级，
//      且连续失败计数 / 降级窗口**不变**（不进 fail-soft 的确定性证据）；
//   ④ 正对照：形状合规 → 请求放行（next 调用），证明门禁不误伤 happy path（非空判据）。
//
// 备忘：本文件按"失败路径在前、成功路径在最后"排序 —— `ensureRevocationInfra` 的 memo 是进程级，
//       一旦成功会短路后续形状查询（这正是生产语义：启动即验证一次）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REVOKED_TOKENS_SHAPE, REVOKED_TOKENS_INDEXES, revokedTokensShapeIssues,
} from '../../lib/publicInfraShape.js'
import {
  AUTH_INFRA_MISSING,
} from '../../lib/publicInfraShape.js'
import {
  assertRevocationInfra, ensureRevocationInfra, createAuthMiddleware,
  getRecheckFailState, _resetRecheckFailStateForTest,
} from '../../middleware/authMiddleware.js'

process.env.NODE_ENV = 'test' // 避免 createAuthMiddleware 的启动初始化（本测试只用请求路径）

const colRows = () => REVOKED_TOKENS_SHAPE.columns.map((c) => ({ name: c.name, type: c.type, not_null: c.notNull, default_expr: c.defaultExpr }))
const goodShape = () => ({
  columns: colRows(),
  pk: [{ cols: ['jti'] }],
  indexes: REVOKED_TOKENS_INDEXES.map((i) => ({ name: i.name, is_unique: false, is_valid: true, is_ready: true, method: 'btree', is_partial: false, expr_cols: 0, cols: [...i.columns] })),
})
/** 桩 prisma：pg_catalog 探针按注入形状返回；会话查询返回"未吊销"（空行）。 */
function shapeStub(shape) {
  return {
    $queryRawUnsafe: async (sql) => {
      if (/pg_index/.test(sql) && /indisprimary/.test(sql)) return shape.pk || []
      if (/pg_index/.test(sql)) return shape.indexes || []
      if (/pg_attribute/.test(sql)) return shape.columns || []
      return []
    },
    user: {
      findUnique: async () => ({ id: 'u1', status: 'active', school_code: null, must_change_password: false, role: 'operator' }),
    },
  }
}
const userManagerStub = (prisma) => ({
  verifyToken: () => ({
    valid: true,
    user: { userId: 'u1', username: 'u1', role: 'operator', schoolCode: null, jti: 'jti-1', iat: 1000, idt: 1000000 },
  }),
  rootPrisma: prisma,
})
async function callAuth(authenticateUser, method = 'GET') {
  const req = { method, headers: { authorization: 'Bearer t' }, originalUrl: '/api/x' }
  const res = {
    code: null, body: null,
    status(c) { this.code = c; return this },
    json(b) { this.body = b; return this },
  }
  let nextCalled = false
  await authenticateUser(req, res, () => { nextCalled = true })
  return { res, nextCalled }
}

test('① 只读形状断言：缺表 / 缺索引 → AUTH_INFRA_MISSING（确定码 + issues + 已撤出声明）', async () => {
  assert.deepEqual(await revokedTokensShapeIssues({ $queryRawUnsafe: async () => [] }), ['table-missing:public.revoked_tokens'])
  await assert.rejects(
    () => assertRevocationInfra({ $queryRawUnsafe: async () => [] }),
    (e) => e.code === AUTH_INFRA_MISSING && e.runtimeDdlWithdrawn === true && e.issues.includes('table-missing:public.revoked_tokens'),
    '缺表必须抛 AUTH_INFRA_MISSING'
  )
  const noIdx = goodShape()
  noIdx.indexes = noIdx.indexes.slice(0, 2) // 缺 school_epoch 索引
  await assert.rejects(
    () => assertRevocationInfra(shapeStub(noIdx)),
    (e) => e.code === AUTH_INFRA_MISSING && e.issues.includes('index-missing:revoked_tokens_school_epoch_idx'),
    '缺索引必须抛 AUTH_INFRA_MISSING（停校 O(1) 关键路径）'
  )
})

test('② ensure（memoized）失败不缓存：连续两次形状不符都拒绝（可重试语义，非永久熔断）', async () => {
  const bad = shapeStub({ columns: [] })
  await assert.rejects(() => ensureRevocationInfra(bad), (e) => e.code === AUTH_INFRA_MISSING)
  await assert.rejects(() => ensureRevocationInfra(bad), (e) => e.code === AUTH_INFRA_MISSING, '失败后 memo 必须清空（下一次仍做真实断言）')
})

test('③ authenticateUser：基础设施缺失 → 503 AUTH_INFRA_MISSING，读请求不进 fail-soft，失败计数/窗口不变', async () => {
  _resetRecheckFailStateForTest()
  const bad = shapeStub({ columns: [] })
  const { authenticateUser } = createAuthMiddleware(userManagerStub(bad), bad)
  const { res, nextCalled } = await callAuth(authenticateUser, 'GET') // GET = fail-soft 适用面
  assert.equal(nextCalled, false, '基础设施缺失不得放行')
  assert.equal(res.code, 503)
  assert.equal(res.body.code, AUTH_INFRA_MISSING, '必须是 AUTH_INFRA_MISSING（不是 AUTH_FAIL_SOFT / AUTH_DEGRADED）')
  assert.equal(res.body.reason, 'revocation-infra-missing')
  const st = getRecheckFailState()
  assert.equal(st.consecutiveFails, 0, '不进连续失败计数（与 DB 抖动降级分离）')
  assert.equal(st.failSoftSince, null, '不得开启 fail-soft 窗口')
  assert.equal(st.isFailClosed, false)
})

test('④ 正对照：形状合规 → 请求放行（next 调用、不写 503）', async () => {
  const good = shapeStub(goodShape())
  const { authenticateUser } = createAuthMiddleware(userManagerStub(good), good)
  const { res, nextCalled } = await callAuth(authenticateUser, 'GET')
  assert.equal(nextCalled, true, '形状合规必须放行（门禁不误伤 happy path）')
  assert.equal(res.code, null)
})
