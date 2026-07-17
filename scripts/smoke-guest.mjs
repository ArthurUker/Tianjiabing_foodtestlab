// 临时冒烟脚本：验证 TD-Guest 后端端点（真实 PostgreSQL）
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND = path.resolve(__dirname, '..', 'backend')

const BASE = 'postgresql://postgres:postgres@127.0.0.1:5432/foodtestlab_test'
const SCHEMA = 'school-gtest'

process.env.DATABASE_URL = BASE
process.env.JWT_SECRET = 'smoke-test-strong-secret-1234567890'
process.env.PORT = '3999'
process.env.NODE_ENV = 'test'

console.log('→ 推送 schema 到租户', SCHEMA)
const push = spawnSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL: `${BASE}?schema=${SCHEMA}` },
    encoding: 'utf-8',
    timeout: 120000
})
if (push.status !== 0) {
    console.error('prisma push 失败:', push.stderr || push.stdout)
    process.exit(1)
}

const { app } = await import(path.join(BACKEND, 'server.js'))

function assert(cond, msg) {
    if (!cond) { console.error('❌ 断言失败:', msg); process.exit(1) }
    console.log('✅', msg)
}

// 1) 注册
let r = await request(app).post('/api/guest/register').send({
    username: 'g1', password: 'pw12345', full_name: '测试访客', guest_type: 'viewer', schoolCode: SCHEMA
})
assert(r.status === 201 && r.body.token, `注册返回 201 + token (status=${r.status}, body=${JSON.stringify(r.body)})`)

// 2) 重复注册 → 409
r = await request(app).post('/api/guest/register').send({
    username: 'g1', password: 'pw12345', full_name: 'x', schoolCode: SCHEMA
})
assert(r.status === 409, `重复注册返回 409 (status=${r.status})`)

// 3) 登录
r = await request(app).post('/api/guest/login').send({ username: 'g1', password: 'pw12345', schoolCode: SCHEMA })
assert(r.status === 200 && r.body.token, `登录返回 200 + token (status=${r.status})`)
const token = r.body.token

// 4) 错误密码 → 401
r = await request(app).post('/api/guest/login').send({ username: 'g1', password: 'wrong', schoolCode: SCHEMA })
assert(r.status === 401, `错误密码返回 401 (status=${r.status})`)

// 5) 校验令牌
r = await request(app).post('/api/guest/verify-token').set('Authorization', `Bearer ${token}`)
assert(r.status === 200 && r.body.valid === true && r.body.guest.guest_type === 'viewer', `校验令牌 valid:true (status=${r.status})`)

// 6) 提交导出申请
r = await request(app).post('/api/guest-export-request/submit').set('Authorization', `Bearer ${token}`)
    .send({ request_type: 'data_export', request_reason: '需要导出', request_data: { tables: ['tableware'] } })
assert(r.status === 201 && r.body.request.status === 'pending', `导出申请 201 pending (status=${r.status})`)

// 7) 我的申请
r = await request(app).get('/api/guest-export-request/my-requests').set('Authorization', `Bearer ${token}`)
assert(r.status === 200 && Array.isArray(r.body.requests) && r.body.requests.length === 1, `我的申请列表 1 条 (status=${r.status})`)

// 8) 权限状态
r = await request(app).get('/api/guest-export-request/check-permission').set('Authorization', `Bearer ${token}`)
assert(r.status === 200 && r.body.has_export_permission === false, `权限状态 has_export_permission=false (status=${r.status})`)

console.log('\n🎉 TD-Guest 后端冒烟全部通过')
process.exit(0)
