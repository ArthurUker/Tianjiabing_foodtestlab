// 测试隔离门禁的**负例回归**（2026-09-17 审阅 F8；纯函数，不需要数据库）
//
// 审阅指出的原缺陷：只匹配"整串里是否出现 review_test" → 用户名/密码/query 里有 review_test、
// 库名却是生产库的连接串也能通过；且清理动作是无条件整表删除。
// 这里锁定：解析后的**库名**不合法必须在任何写操作前抛错；schema 白名单拒绝 public / 真实学校 schema。
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertIsolationConfig, parseDbUrl, cleanupScoped } from '../_isolation.mjs'

const KEY = 'REVIEW_TEST_DATABASE_URL'
const saved = process.env[KEY]

function withUrl(url, fn) {
  process.env[KEY] = url
  try { return fn() } finally {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
  }
}

test('隔离门禁：用户名/密码/query 含 review_test 但库名是生产库 → 必须拒绝', () => {
  const evil = [
    'postgresql://review_test:pw@127.0.0.1:5432/foodsentinel',              // 用户名
    'postgresql://u:review_test@127.0.0.1:5432/foodsentinel',               // 密码
    'postgresql://u:p@127.0.0.1:5432/foodsentinel?options=review_test',     // query
    'postgresql://u:p@127.0.0.1:5432/production_review_test',               // 命中生产黑名单
  ]
  for (const url of evil) {
    withUrl(url, () => {
      assert.throws(() => assertIsolationConfig({ schema: 'school_reviewtest' }), /拒绝运行/, `应拒绝：${url.replace(/:[^:@/]*@/, ':***@')}`)
    })
  }
})

test('隔离门禁：schema 必须是专用测试 schema（拒绝 public / 真实学校 schema）', () => {
  withUrl('postgresql://u:p@127.0.0.1:5432/foodsentinel_review_test', () => {
    assert.throws(() => assertIsolationConfig({ schema: 'public' }), /拒绝运行/)
    assert.throws(() => assertIsolationConfig({ schema: 'school_tjb' }), /拒绝运行/)
    assert.throws(() => assertIsolationConfig({ schema: '' }), /拒绝运行/)
    assert.doesNotThrow(() => assertIsolationConfig({ schema: 'school_reviewtest' }))
  })
})

test('隔离门禁：未配置变量 / 缺少库名 → 必须拒绝（不得回落到 DATABASE_URL）', () => {
  withUrl('', () => assert.throws(() => assertIsolationConfig({ schema: 'school_reviewtest' }), /SKIP: TEST_DATABASE_URL not configured/))
  process.env[KEY] = ''
  delete process.env[KEY]
  process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/foodsentinel'   // 只有生产变量 → 仍然拒绝
  try {
    assert.throws(() => assertIsolationConfig({ schema: 'school_reviewtest' }), /SKIP: TEST_DATABASE_URL not configured/)
  } finally {
    delete process.env.DATABASE_URL
    if (saved !== undefined) process.env[KEY] = saved
  }
})

test('隔离门禁：解析库名时忽略 query，且只取 pathname', () => {
  const p = parseDbUrl('postgresql://u:p@127.0.0.1:5432/foodsentinel_review_test?schema=school_reviewtest')
  assert.equal(p.db, 'foodsentinel_review_test')
  assert.equal(p.host, '127.0.0.1')
  assert.equal(p.hasQuery, true)
})

test('清理必须带范围条件：无 where 直接抛错（禁止 deleteMany({})）', async () => {
  await assert.rejects(() => cleanupScoped({}, {}, 'test'), /拒绝执行无范围清理/)
  await assert.rejects(() => cleanupScoped({}, null, 'test'), /拒绝执行无范围清理/)
})
