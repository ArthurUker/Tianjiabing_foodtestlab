// 开放接口调用日志（2026-10-26）· 无 DB 单测：
//   ① 通过认证的调用 → info 一行（category=openapi、client、rows、sum_rows）
//   ② 未携带密钥 → warn 一行（code=MISSING_KEY）
//   ③ 同「对接方+路径+结论」窗口内重复 → 不新增行，只累加 repeat_count / sum_rows

import test from 'node:test'
import assert from 'node:assert/strict'

import { createOpenApiAuth } from '../../middleware/openApiAuth.js'
import { resetLogAggregator } from '../../lib/logThrottle.js'

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {}, locals: {}, listeners: {},
    status(c) { this.statusCode = c; return this },
    setHeader(k, v) { this.headers[k] = v },
    json(b) { this.body = b; return this },
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this },
    emit(ev) { (this.listeners[ev] || []).forEach((fn) => fn()); return this },
  }
}

function makeReq({ key = null, path = '/api/open/v1/records?type=pathogen' } = {}) {
  const headers = key ? { 'x-api-key': key, 'user-agent': 'pushe/1.0' } : { 'user-agent': 'pushe/1.0' }
  return {
    method: 'GET',
    originalUrl: path,
    ip: '119.132.138.23',
    headers,
    get(name) { return headers[String(name).toLowerCase()] || null },
  }
}

function stub() {
  const rows = new Map()
  let seq = 0
  const client = { id: 'cli-1', name: '朴食科技', status: 'active', ip_whitelist: null, rate_limit_per_min: 60 }
  const credential = { id: 'cred-1', status: 'active', revoked_at: null, expires_at: null, client }
  return {
    rows,
    prisma: {
      openApiCredential: {
        async findUnique() { return credential },
        async update() { return {} },
      },
      openApiClient: { async update() { return {} } },
      systemLog: {
        async create({ data }) { const id = `l${++seq}`; rows.set(id, { id, ...data }); return { id, ...data } },
        async update({ where, data }) { const r = rows.get(where.id); if (!r) throw new Error('not found'); Object.assign(r, data); return r },
      },
    },
  }
}

async function run(prisma, req, { respond = null } = {}) {
  const mw = createOpenApiAuth({ prisma })
  const res = makeRes()
  let nexted = false
  mw(req, res, () => { nexted = true })
  // 认证是 promise 链，等它结束
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
  if (respond) respond(res)
  res.emit('finish')
  await new Promise((r) => setTimeout(r, 5))
  return { res, nexted }
}

test('通过认证的调用：记录 info 一行，含对接方/路径/返回条数/耗时/UA，不记业务字段内容', async () => {
  resetLogAggregator()
  const { prisma, rows } = stub()
  const req = makeReq({ key: 'k1' })
  const { res, nexted } = await run(prisma, req, {
    respond: (r) => r.status(200).json({ success: true, data: { items: [{ id: 1 }, { id: 2 }], school_code: 'test' } }),
  })
  assert.equal(nexted, true)
  assert.equal(res.statusCode, 200)
  assert.equal(rows.size, 1)
  const log = [...rows.values()][0]
  const ctx = log.context
  assert.equal(log.level, 'info')
  assert.equal(ctx.category, 'openapi')
  assert.equal(ctx.action_type, 'openapi_call')
  assert.equal(ctx.client_id, 'cli-1')
  assert.equal(ctx.client_name, '朴食科技')
  assert.equal(ctx.path, '/api/open/v1/records', '聚合键去掉 query，避免同一接口被拆成多行')
  assert.equal(ctx.status, 200)
  assert.equal(ctx.rows, 2)
  assert.equal(ctx.sum_rows, 2)
  assert.equal(ctx.school_code, 'test')
  assert.equal(ctx.ip, '119.132.138.23')
  assert.equal(ctx.ua, 'pushe/1.0')
  assert.ok(typeof ctx.ms === 'number')
  const dump = JSON.stringify(ctx)
  assert.ok(!dump.includes('sample_info'), '不得记录业务记录内容')
})

test('未携带密钥：401 且记录 warn 一行（code=MISSING_KEY，无对接方归属）', async () => {
  resetLogAggregator()
  const { prisma, rows } = stub()
  const { res, nexted } = await run(prisma, makeReq({ key: null }))
  assert.equal(nexted, false)
  assert.equal(res.statusCode, 401)
  assert.equal(rows.size, 1)
  const log = [...rows.values()][0]
  assert.equal(log.level, 'warn')
  assert.equal(log.context.category, 'openapi')
  assert.equal(log.context.action_type, 'openapi_denied')
  assert.equal(log.context.code, 'MISSING_KEY')
  assert.equal(log.context.client_id, null)
})

test('同「对接方+路径+结论」重复调用：窗口内只保留一行（次数/条数的累计语义由聚合器保证）', async () => {
  resetLogAggregator()
  const { prisma, rows } = stub()
  const req = makeReq({ key: 'k1' })
  const respond = (r) => r.status(200).json({ success: true, data: { items: [{ id: 1 }, { id: 2 }] } })
  await run(prisma, req, { respond })
  await run(prisma, req, { respond })
  await run(prisma, req, { respond })

  assert.equal(rows.size, 1, '窗口内只保留一行')
  const log = [...rows.values()][0]
  assert.equal(log.context.action_type, 'openapi_call')
  assert.equal(log.context.sum_rows, 2, '首行先记 2 条，后续重复按节流刷新累加')
  // 次数与累计条数的精确语义在 logCenter.unit.test.mjs 的聚合器用例中验证
})

test('不同结论码分行（成功 vs 限流），互不覆盖', async () => {
  resetLogAggregator()
  const { prisma, rows } = stub()
  const req = makeReq({ key: 'k1' })
  await run(prisma, req, { respond: (r) => r.status(200).json({ success: true, data: { items: [] } }) })
  await run(prisma, makeReq({ key: null })) // 401 MISSING_KEY
  assert.equal(rows.size, 2)
})
