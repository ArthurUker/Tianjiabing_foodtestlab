// tests/integration/live-api.mjs
//
// 全功能模块端到端联调（真实运行后端 + 真实 PostgreSQL）。
// 直接打 HTTP API（与前端同源行为一致），覆盖：健康检查 / 认证 / 学校配置 /
// 超管建校 / 检测记录(双 API) / 审计日志 / 离线同步 / 用户管理 / 访客 /
// 多租户隔离。运行结束后清理本脚本产生的测试数据。
//
// 用法： node tests/integration/live-api.mjs  [BASE_URL]
// 前置：后端已在运行（默认 http://127.0.0.1:3002），且已初始化 tjb 学校。

const BASE = process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:3002'

let pass = 0
let fail = 0
const failures = []
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}
async function test(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    failures.push({ name, err: e.message })
    console.log(`  ❌ ${name}  ->  ${e.message}`)
  }
}

async function call(method, path, { token, body, query } = {}) {
  let url = `${BASE}${path}`
  if (query) {
    const q = new URLSearchParams(query).toString()
    url += (path.includes('?') ? '&' : '?') + q
  }
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })
  let json
  try { json = await res.json() } catch { json = null }
  return { status: res.status, json }
}

// 登录辅助
async function login(username, password, schoolCode = null) {
  const { status, json } = await call('POST', '/api/user/login', {
    body: { username, password, schoolCode }
  })
  assert(status === 200 && json.token, `登录失败 ${username}@${schoolCode || 'public'}: ${status} ${JSON.stringify(json)}`)
  return json.token
}

const TYPES = ['tableware', 'pathogen', 'leanMeat', 'oil', 'pesticide']
const DYN_SCHOOL = 'sysdynit'
const sampleRec = (type) => ({
  testDate: '2026-07-17',
  canteen: '一食堂',
  inspector: '联调测试员',
  result: '合格',
  type
})

async function main() {
  console.log(`\n🚀 全模块端到端联调  BASE=${BASE}\n`)

  // ---------- A. 健康检查 ----------
  console.log('【A】健康检查')
  await test('GET /api/health = 200', async () => {
    const { status } = await call('GET', '/api/health')
    assert(status === 200, `status=${status}`)
  })

  // ---------- B. 认证 ----------
  console.log('\n【B】认证')
  const adminToken = await login('admin', 'admin123')
  let operatorToken = null
  await test('正确密码登录 operator', async () => {
    operatorToken = await login('operator', 'operator123')
  })
  await test('错误密码登录 = 401', async () => {
    const { status } = await call('POST', '/api/user/login', { body: { username: 'admin', password: 'wrong' } })
    assert(status === 401, `期望401 实际${status}`)
  })
  await test('GET /api/user/me 返回 admin 身份', async () => {
    const { status, json } = await call('GET', '/api/user/me', { token: adminToken })
    assert(status === 200 && json?.data?.role === 'admin', `status=${status} ${JSON.stringify(json)}`)
  })
  await test('POST /api/user/refresh-token 续期', async () => {
    const { status, json } = await call('POST', '/api/user/refresh-token', { token: adminToken })
    assert(status === 200 && json.token, `status=${status}`)
  })
  await test('POST /api/user/verify-token 有效', async () => {
    const { status, json } = await call('POST', '/api/user/verify-token', { token: adminToken })
    assert(status === 200 && json.valid === true, `status=${status}`)
  })

  // ---------- C. 学校配置 ----------
  console.log('\n【C】学校配置')
  await test('公开 GET /api/schools/tianjiabing/config', async () => {
    const { status, json } = await call('GET', '/api/schools/tianjiabing/config')
    assert(status === 200 && json?.data?.name, `status=${status} ${JSON.stringify(json)}`)
  })
  await test('鉴权 GET /api/school/config（public 超管）', async () => {
    const { status, json } = await call('GET', '/api/school/config', { token: adminToken })
    assert(status === 200 && json?.success === true, `status=${status}`)
  })

  // ---------- D. 超管学校管理 ----------
  console.log('\n【D】超管学校管理')
  await test('GET /api/admin/schools 列出学校', async () => {
    const { status, json } = await call('GET', '/api/admin/schools', { token: adminToken })
    assert(status === 200 && Array.isArray(json.data) && json.data.some(s => s.code === 'tianjiabing'), `status=${status}`)
  })
  await test('operator 访问 /api/admin/schools = 403', async () => {
    const { status } = await call('GET', '/api/admin/schools', { token: operatorToken })
    assert(status === 403, `期望403 实际${status}`)
  })
  await test(`POST /api/admin/schools 动态建校 ${DYN_SCHOOL}`, async () => {
    const { status, json } = await call('POST', '/api/admin/schools', {
      token: adminToken,
      body: { code: DYN_SCHOOL, name: '联调动态学校', adminPassword: 'dynadmin123' }
    })
    assert(status === 200 && json?.success, `status=${status} ${JSON.stringify(json)}`)
  })
  let dynToken = null
  await test(`登录新建学校 ${DYN_SCHOOL} 的 admin`, async () => {
    dynToken = await login('admin', 'dynadmin123', DYN_SCHOOL)
  })

  // ---------- E. 检测记录（双 API + 全类型）----------
  console.log('\n【E】检测记录 CRUD')
  let tablewareId = null
  let tablewareCode = null
  await test('POST /api/records/tableware 创建（含校验）', async () => {
    const { status, json } = await call('POST', '/api/records/tableware', { token: adminToken, body: sampleRec('tableware') })
    assert(status === 200 && json?.data?.id, `status=${status} ${JSON.stringify(json)}`)
    tablewareId = json.data.id
    tablewareCode = json.data.record_code
  })
  await test('GET /api/records/tableware 列表含该记录', async () => {
    const { status, json } = await call('GET', '/api/records/tableware', { token: adminToken })
    assert(status === 200 && json?.data?.some(r => r.id === tablewareId), `status=${status}`)
  })
  await test('PUT /api/records/tableware/:id 更新', async () => {
    const upd = { ...sampleRec('tableware'), result: '不合格' }
    const { status, json } = await call('PUT', `/api/records/tableware/${tablewareId}`, { token: adminToken, body: upd })
    assert(status === 200, `status=${status} ${JSON.stringify(json)}`)
  })
  await test('POST /api/records/tableware 幂等（相同内容 deduplicated）', async () => {
    const { status, json } = await call('POST', '/api/records/tableware', { token: adminToken, body: sampleRec('tableware') })
    assert(status === 200 && json?.deduplicated === true, `status=${status} ${JSON.stringify(json)}`)
  })
  await test('DELETE /api/records/tableware/:id 删除', async () => {
    const { status } = await call('DELETE', `/api/records/tableware/${tablewareId}`, { token: adminToken })
    assert(status === 200, `status=${status}`)
  })
  // 其余 4 种类型：创建 + 列表
  for (const t of TYPES.filter(t => t !== 'tableware')) {
    await test(`POST+GET /api/records/${t} 创建与列表`, async () => {
      const c = await call('POST', `/api/records/${t}`, { token: adminToken, body: sampleRec(t) })
      assert(c.status === 200 && c.json?.data?.id, `${t} create ${c.status} ${JSON.stringify(c.json)}`)
      const l = await call('GET', `/api/records/${t}`, { token: adminToken })
      assert(l.status === 200 && l.json?.data?.length >= 1, `${t} list ${l.status}`)
      // 清理
      const id = c.json.data.id
      await call('DELETE', `/api/records/${t}/${id}`, { token: adminToken })
    })
  }
  // 批量导入
  await test('POST /api/records/tableware/bulk-upsert 批量', async () => {
    const { status, json } = await call('POST', '/api/records/tableware/bulk-upsert', {
      token: adminToken,
      body: {
        records: [
          { ...sampleRec('tableware'), testDate: '2026-07-10', canteen: '二食堂' },
          { ...sampleRec('tableware'), testDate: '2026-07-11', canteen: '三食堂' }
        ]
      }
    })
    assert(status === 200 && json?.data?.created + json?.data?.updated >= 1, `status=${status} ${JSON.stringify(json)}`)
  })
  // /api/test-records 旧接口
  await test('POST+GET /api/test-records 兼容接口', async () => {
    const c = await call('POST', '/api/test-records', { token: adminToken, body: { test_type: 'generic', test_name: '兼容测试' } })
    assert(c.status === 200 && c.json?.data?.id, `create ${c.status} ${JSON.stringify(c.json)}`)
    const l = await call('GET', '/api/test-records', { token: adminToken })
    assert(l.status === 200 && l.json?.success, `list ${l.status}`)
    if (c.json?.data?.id) await call('DELETE', `/api/test-records/${c.json.data.id}`, { token: adminToken })
  })

  // ---------- F. 审计日志 ----------
  console.log('\n【F】审计日志')
  let auditId = null
  await test('POST /api/audit-logs 创建', async () => {
    const { status, json } = await call('POST', '/api/audit-logs', { token: adminToken, body: { action: 'export', resource_type: 'test_record', details: '联调测试' } })
    assert(status === 201 && json?.data?.id, `status=${status} ${JSON.stringify(json)}`)
    auditId = json.data.id
  })
  await test('GET /api/audit-logs 列表', async () => {
    const { status, json } = await call('GET', '/api/audit-logs', { token: adminToken })
    assert(status === 200 && json?.data?.some(l => l.id === auditId), `status=${status}`)
  })
  await test('GET /api/audit-logs/stats/summary（admin）', async () => {
    const { status } = await call('GET', '/api/audit-logs/stats/summary', { token: adminToken })
    assert(status === 200, `status=${status}`)
  })
  await test('GET /api/audit-logs/:id 详情', async () => {
    const { status } = await call('GET', `/api/audit-logs/${auditId}`, { token: adminToken })
    assert(status === 200, `status=${status}`)
  })

  // ---------- G. 离线同步 ----------
  console.log('\n【G】离线同步')
  await test('POST /api/sync/records 单条', async () => {
    const { status, json } = await call('POST', '/api/sync/records', {
      token: adminToken,
      body: { action: 'add', store: 'tableware', data: { ...sampleRec('tableware'), test_name: '同步测试' } }
    })
    assert(status === 200 && json?.success, `status=${status} ${JSON.stringify(json)}`)
  })
  await test('POST /api/sync/batch 批量', async () => {
    const { status, json } = await call('POST', '/api/sync/batch', {
      token: adminToken,
      body: { operations: [
        { action: 'add', store: 'pathogen', data: { ...sampleRec('pathogen') } },
        { action: 'add', store: 'oil', data: { ...sampleRec('oil') } }
      ] }
    })
    assert(status === 200 && json?.succeeded === 2, `status=${status} ${JSON.stringify(json)}`)
  })
  await test('GET /api/sync/status 统计', async () => {
    const { status, json } = await call('GET', '/api/sync/status', { token: adminToken })
    assert(status === 200 && json?.summary?.totalRecords >= 0, `status=${status}`)
  })

  // ---------- H. 用户管理 ----------
  console.log('\n【H】用户管理')
  const rnd = Date.now().toString().slice(-6)
  const testUser = `ituser${rnd}`
  const testPhone = `13${Date.now().toString().slice(-9)}`
  let testUserId = null
  await test('POST /api/user/register 创建用户', async () => {
    const { status, json } = await call('POST', '/api/user/register', {
      token: adminToken,
      body: { username: testUser, password: 'Test@12345', fullName: '联调用户', phone: testPhone }
    })
    assert(status === 201 && json?.user?.id, `status=${status} ${JSON.stringify(json)}`)
    testUserId = json.user.id
  })
  await test('GET /api/user/list（admin）', async () => {
    const { status, json } = await call('GET', '/api/user/list', { token: adminToken })
    const ok = Array.isArray(json) ? json.some(u => u.id === testUserId) : (json?.data?.some?.(u => u.id === testUserId) ?? false)
    assert(status === 200 && ok, `status=${status} ${JSON.stringify(json)?.slice(0,120)}`)
  })
  await test('operator 访问 /api/user/list = 403', async () => {
    const { status } = await call('GET', '/api/user/list', { token: operatorToken })
    assert(status === 403, `期望403 实际${status}`)
  })
  let testUserToken = null
  await test('新用户登录 + 改密 + 用新密码登录', async () => {
    testUserToken = await login(testUser, 'Test@12345')
    const ch = await call('POST', '/api/user/change-password', { token: testUserToken, body: { oldPassword: 'Test@12345', newPassword: 'Test@99999' } })
    assert(ch.status === 200, `改密 ${ch.status} ${JSON.stringify(ch.json)}`)
    const relogin = await call('POST', '/api/user/login', { body: { username: testUser, password: 'Test@99999' } })
    assert(relogin.status === 200 && relogin.json.token, '新密码登录失败')
  })
  await test('POST /api/user/:id/reset-password 重置', async () => {
    const { status } = await call('POST', `/api/user/${testUserId}/reset-password`, { token: adminToken, body: { newPassword: 'Test@11111' } })
    assert(status === 200, `status=${status}`)
  })
  await test('禁用 + 启用 用户', async () => {
    const d = await call('POST', `/api/user/${testUserId}/disable`, { token: adminToken })
    const e = await call('POST', `/api/user/${testUserId}/enable`, { token: adminToken })
    assert(d.status === 200 && e.status === 200, `disable=${d.status} enable=${e.status}`)
  })

  // ---------- I. 访客 ----------
  console.log('\n【I】访客')
  // TD-GuestGate: quick-access 现受 guest_enabled 开关（未开启返回 403）+ 限流保护
  await test('POST /api/guest/quick-access 缺 schoolCode = 400', async () => {
    const { status } = await call('POST', '/api/guest/quick-access', {})
    assert(status === 400, `期望400 实际${status}`)
  })
  await test('POST /api/guest/quick-access guest_enabled 未开启 = 403', async () => {
    const { status } = await call('POST', '/api/guest/quick-access', { body: { schoolCode: 'tianjiabing' } })
    assert(status === 403, `期望403 实际${status}`)
  })

  // ---------- J. 多租户隔离 ----------
  // 用动态新建学校 sysdynit（school_sysdynit schema）与 public 超管做隔离验证。
  console.log('\n【J】多租户隔离')
  let tbRecId = null
  let tbCode = null
  await test(`在 ${DYN_SCHOOL} 租户内创建记录`, async () => {
    const { status, json } = await call('POST', '/api/records/tableware', { token: dynToken, body: sampleRec('tableware') })
    assert(status === 200 && json?.data?.id, `status=${status} ${JSON.stringify(json)}`)
    tbRecId = json.data.id
    tbCode = json.data.record_code
  })
  await test(`public 超管列表【不】含 ${DYN_SCHOOL} 记录（隔离）`, async () => {
    const { status, json } = await call('GET', '/api/records/tableware', { token: adminToken })
    assert(status === 200 && !json?.data?.some(r => r.record_code === tbCode), '发现跨租户泄露！')
  })
  await test(`${DYN_SCHOOL} admin 列表【含】自身记录`, async () => {
    const { status, json } = await call('GET', '/api/records/tableware', { token: dynToken })
    assert(status === 200 && json?.data?.some(r => r.record_code === tbCode), '租户内记录不可见，异常')
  })
  await test(`清理 ${DYN_SCHOOL} 测试记录`, async () => {
    const { status } = await call('DELETE', `/api/records/tableware/${tbRecId}`, { token: dynToken })
    assert(status === 200, `status=${status}`)
  })

  // ---------- 清理 ----------
  console.log('\n【清理】删除联调产生的数据')
  if (testUserId) {
    const d = await call('DELETE', `/api/user/${testUserId}`, { token: adminToken })
    console.log(`  · 测试用户 ${testUser}: ${d.status}`)
  }
  // 动态学校 schema 由后续 psql 清理（脚本无删校 API），此处仅提示
  console.log(`  · 动态学校 ${DYN_SCHOOL} 的 schema 将在脚本外通过 psql 清理`)

  // ---------- 汇总 ----------
  console.log(`\n========================================`)
  console.log(`  通过 ${pass} / 失败 ${fail}`)
  console.log(`========================================`)
  if (fail > 0) {
    console.log('\n失败明细:')
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`)
    process.exit(1)
  }
  console.log('🎉 全部模块联调通过')
}

main().catch(e => {
  console.error('💥 联调脚本异常:', e)
  process.exit(2)
})
