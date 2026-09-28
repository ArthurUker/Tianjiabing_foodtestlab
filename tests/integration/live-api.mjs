// tests/integration/live-api.mjs
//
// 全功能模块端到端联调（真实运行后端 + 真实 PostgreSQL）。
// 直接打 HTTP API（与前端同源行为一致），覆盖：健康检查 / 认证 / 学校配置 /
// 超管建校 / 检测记录(双 API) / 审计日志 / 离线同步 / 用户管理 / 访客 /
// 多租户隔离。运行结束后清理本脚本产生的测试数据。
//
// 用法（P3-W0-T02E 数据契约版）：
//   T02C_BASE_URL=http://127.0.0.1:<任务端口> T02C_SCHOOL_CODE=<派生 code> \
//   T02E_SUPER_ADMIN_PASSWORD=... T02E_SCHOOL_MANAGER_PASSWORD=... \
//   T02E_SCHOOL_OPERATOR_PASSWORD=... T02E_DYN_SCHOOL_ADMIN_PASSWORD=... \
//   node tests/integration/live-api.mjs
//
// 数据契约（P3-W0-T02E；由 backend/tests/t02c-instance-fixture.mjs 在实例准备阶段 seed）：
//   ① 平台超管：public schema，role='admin' 且 school_code 为空 —— 登录走生产专用路由
//      `POST /api/user/super-admin/login`（生产语义：/api/user/login 一律要求显式 schoolCode，NB-04）。
//   ② 派生学校（T02C_SCHOOL_CODE，provisioner 派生 code）租户内：manager + operator 两个账号，
//      登录一律 **显式携带 schoolCode**；口令只经 env（T02E_*）传递，不落日志与证据。
//   ③ 本脚本产生的数据（检测记录 / 注册用户 / 动态建校）在结束时清理；动态学校 schema 由
//      harness 以管理身份做 SQL 清理（脚本无删校 API，与既有语义一致）。
//
// 边界：BASE_URL 仅允许回环（本任务 harness 拉起的后端）；学校 code 取派生值；无默认端口；
//       不放宽任何生产校验（isValidSchoolCode / 登录路由 / 角色守卫语义保持原样）。

const BASE = process.env.T02C_BASE_URL || process.argv[2] || ''
if (!BASE) {
  console.error('[T02C-LIVE-API-REFUSED] T02C_BASE_URL is required（本任务自有的回环地址；不存在默认值）')
  process.exit(1)
}
try {
  const u = new URL(BASE)
  if (!['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) {
    console.error(`[T02C-LIVE-API-REFUSED] BASE_URL host "${u.hostname}" 不是回环地址；只允许本任务拉起的后端`)
    process.exit(1)
  }
} catch {
  console.error('[T02C-LIVE-API-REFUSED] BASE_URL is not a valid URL')
  process.exit(1)
}
const SCHOOL_CODE = process.env.T02C_SCHOOL_CODE || ''
if (!SCHOOL_CODE) {
  console.error('[T02C-LIVE-API-REFUSED] T02C_SCHOOL_CODE is required（provisioner 派生学校 code；不再使用 tianjiabing 硬编码）')
  process.exit(1)
}

// ===== P3-W0-T02E 数据契约 env（口令只经 env，缺失即拒绝；绝不打印值）=====
const CONTRACT = {
  superAdminUsername: process.env.T02E_SUPER_ADMIN_USERNAME || 'admin',
  superAdminPassword: process.env.T02E_SUPER_ADMIN_PASSWORD || '',
  managerUsername: process.env.T02E_SCHOOL_MANAGER_USERNAME || 'manager',
  managerPassword: process.env.T02E_SCHOOL_MANAGER_PASSWORD || '',
  operatorUsername: process.env.T02E_SCHOOL_OPERATOR_USERNAME || 'operator',
  operatorPassword: process.env.T02E_SCHOOL_OPERATOR_PASSWORD || '',
  dynAdminPassword: process.env.T02E_DYN_SCHOOL_ADMIN_PASSWORD || '',
  dynManagerNewPassword: process.env.T02E_DYN_SCHOOL_NEW_PASSWORD || '',
}
{
  const missing = Object.entries(CONTRACT).filter(([k, v]) => k.endsWith('Password') && !v).map(([k]) => k)
  if (missing.length) {
    console.error(`[T02C-LIVE-API-REFUSED] T02E 数据契约口令缺失（只经 env 传递，不落日志）: ${missing.join(', ')}`)
    process.exit(1)
  }
}

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

async function call(method, path, { token, body, query, headers: extraHeaders } = {}) {
  let url = `${BASE}${path}`
  if (query) {
    const q = new URLSearchParams(query).toString()
    url += (path.includes('?') ? '&' : '?') + q
  }
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) }
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

// 登录辅助（数据契约）：学校租户账号一律显式携带 schoolCode（生产 NB-04 语义）
async function login(username, password, schoolCode) {
  assert(schoolCode, '数据契约：学校租户登录必须显式携带 schoolCode')
  const { status, json } = await call('POST', '/api/user/login', {
    body: { username, password, schoolCode }
  })
  assert(status === 200 && json.token, `登录失败 ${username}@${schoolCode}: ${status} ${JSON.stringify(json)}`)
  return { token: json.token, refreshToken: json.refreshToken || null, mustChangePassword: !!json.mustChangePassword, user: json.user || null }
}

// 平台超管登录（生产专用路由，与普通登录完全分离；public 账号 role=admin 且无 schoolCode）
async function loginSuperAdmin(username, password) {
  const { status, json } = await call('POST', '/api/user/super-admin/login', { body: { username, password } })
  assert(status === 200 && json.token, `平台超管登录失败 ${username}: ${status} ${JSON.stringify(json)}`)
  assert(json.user && json.user.role === 'admin' && !json.user.schoolCode, 'super-admin/login 必须返回平台超管身份（role=admin 且无 schoolCode）')
  return { token: json.token, refreshToken: json.refreshToken || null }
}

const TYPES = ['tableware', 'pathogen', 'leanMeat', 'oil', 'pesticide']
const DYN_SCHOOL = process.env.T02C_DYN_SCHOOL_CODE || `dyn${SCHOOL_CODE.replace(/[^a-z0-9]/gi, '').slice(-12)}`   // 派生动态建校 code（无 sysdynit 硬编码）
const sampleRec = (type) => ({
  testDate: '2026-07-17',
  canteen: '一食堂',
  inspector: '联调测试员',
  result: '合格',
  type
})

async function main() {
  console.log(`\n🚀 全模块端到端联调  BASE=${BASE}\n`)
  console.log(`📋 数据契约：派生学校=${SCHOOL_CODE}（manager/operator，显式 schoolCode 登录）+ 平台超管（super-admin/login）+ 动态学校=${DYN_SCHOOL}\n`)

  // ---------- A. 健康检查 ----------
  console.log('【A】健康检查')
  await test('GET /api/health = 200', async () => {
    const { status } = await call('GET', '/api/health')
    assert(status === 200, `status=${status}`)
  })

  // ---------- B. 认证（数据契约：租户账号显式 schoolCode；平台超管走专用路由）----------
  console.log('\n【B】认证')
  let managerSession = null
  let operatorToken = null
  await test(`学校 manager 登录（显式 schoolCode=${SCHOOL_CODE}）`, async () => {
    managerSession = await login(CONTRACT.managerUsername, CONTRACT.managerPassword, SCHOOL_CODE)
    assert(managerSession.token && !managerSession.mustChangePassword, 'manager 会话必须可用且无首登改密标记（契约账号 must_change_password=false）')
  })
  await test('学校 operator 登录（显式 schoolCode）', async () => {
    const s = await login(CONTRACT.operatorUsername, CONTRACT.operatorPassword, SCHOOL_CODE)
    operatorToken = s.token
    assert(operatorToken, 'operator 会话必须可用')
  })
  await test('无 schoolCode 登录 = 400（生产 NB-04：/api/user/login 必须显式携带学校代码）', async () => {
    const { status } = await call('POST', '/api/user/login', { body: { username: CONTRACT.managerUsername, password: CONTRACT.managerPassword } })
    assert(status === 400, `期望400 实际${status}`)
  })
  await test('错误密码登录 = 401（显式 schoolCode）', async () => {
    const { status } = await call('POST', '/api/user/login', { body: { username: CONTRACT.managerUsername, password: 'wrong-password', schoolCode: SCHOOL_CODE } })
    assert(status === 401, `期望401 实际${status}`)
  })
  await test('GET /api/user/me 返回学校 manager 身份', async () => {
    const { status, json } = await call('GET', '/api/user/me', { token: managerSession.token })
    assert(status === 200 && json?.data?.role === 'manager', `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
    assert(json?.data?.schoolCode === SCHOOL_CODE, 'me 必须回显租户 schoolCode')
  })
  await test('平台超管登录（生产专用路由 /api/user/super-admin/login，无需 schoolCode）', async () => {
    const s = await loginSuperAdmin(CONTRACT.superAdminUsername, CONTRACT.superAdminPassword)
    assert(s.token, '平台超管会话必须可用')
  })
  await test('租户账号走 super-admin/login = 401（生产语义：平台路由只查 public，租户账号不可见）', async () => {
    // forTenant(null) 只查 public schema 的 User —— 租户账号查不到 → 401（防枚举文案）；
    // 403 分支仅命中"public 内 role≠admin"的账号。租户账号对平台路由不可见是更强的隔离证据。
    const { status } = await call('POST', '/api/user/super-admin/login', { body: { username: CONTRACT.managerUsername, password: CONTRACT.managerPassword } })
    assert(status === 401, `期望401 实际${status}`)
  })
  await test('POST /api/user/refresh-token 轮转（X-Refresh-Token；DS3-H1 已移除 access fallback）', async () => {
    const { status, json } = await call('POST', '/api/user/refresh-token', {
      token: managerSession.token,
      headers: { 'X-Refresh-Token': managerSession.refreshToken }
    })
    assert(status === 200 && json.token && json.refreshToken, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
    assert(json.refreshToken !== managerSession.refreshToken, 'refresh token 必须一次性轮转')
    managerSession = { ...managerSession, token: json.token, refreshToken: json.refreshToken }
  })
  await test('POST /api/user/verify-token 有效', async () => {
    const { status, json } = await call('POST', '/api/user/verify-token', { token: managerSession.token })
    assert(status === 200 && json.valid === true, `status=${status}`)
  })

  // ---------- C. 学校配置 ----------
  console.log('\n【C】学校配置')
  await test(`公开 GET /api/schools/${SCHOOL_CODE}/config`, async () => {
    const { status, json } = await call('GET', `/api/schools/${SCHOOL_CODE}/config`)
    assert(status === 200 && json?.data?.name, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
  })
  await test('GET /api/school/config（本校 manager；返回本校 code）', async () => {
    const { status, json } = await call('GET', '/api/school/config', { token: managerSession.token })
    assert(status === 200 && json?.success === true, `status=${status}`)
    assert(json?.data?.schoolCode === SCHOOL_CODE, 'school/config 必须以 token 中的 schoolCode 为准')
  })

  // ---------- D. 超管学校管理 ----------
  console.log('\n【D】超管学校管理')
  const superSession = await loginSuperAdmin(CONTRACT.superAdminUsername, CONTRACT.superAdminPassword)
  const superToken = superSession.token
  await test('GET /api/admin/schools 列出学校（平台超管；含契约派生学校）', async () => {
    const { status, json } = await call('GET', '/api/admin/schools', { token: superToken })
    assert(status === 200 && Array.isArray(json.data) && json.data.some(s => s.code === SCHOOL_CODE), `status=${status}`)
  })
  await test('operator 访问 /api/admin/schools = 403（平台超管专属）', async () => {
    const { status } = await call('GET', '/api/admin/schools', { token: operatorToken })
    assert(status === 403, `期望403 实际${status}`)
  })
  await test(`POST /api/admin/schools 动态建校 ${DYN_SCHOOL}（初始 manager 为临时密码，首登须改密）`, async () => {
    const { status, json } = await call('POST', '/api/admin/schools', {
      token: superToken,
      body: { code: DYN_SCHOOL, name: '联调动态学校', adminPassword: CONTRACT.dynAdminPassword }
    })
    assert(status === 200 && json?.success, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
  })
  let dynManagerPassword = CONTRACT.dynAdminPassword
  await test(`登录新建学校 ${DYN_SCHOOL} 的 manager（显式 schoolCode；首登 mustChangePassword=true）`, async () => {
    const s = await login('manager', dynManagerPassword, DYN_SCHOOL)
    assert(s.mustChangePassword === true, '动态建校的初始 manager 必须首登强制改密（生产 provisionSchool 契约）')
  })
  await test('动态学校 manager 首登改密（生产 MUST_CHANGE_PASSWORD 白名单流）', async () => {
    const s = await login('manager', dynManagerPassword, DYN_SCHOOL)
    const ch = await call('POST', '/api/user/change-password', {
      token: s.token,
      body: { oldPassword: dynManagerPassword, newPassword: CONTRACT.dynManagerNewPassword }
    })
    assert(ch.status === 200, `改密 ${ch.status} ${JSON.stringify(ch.json)?.slice(0, 160)}`)
    dynManagerPassword = CONTRACT.dynManagerNewPassword
  })
  let dynToken = null
  await test(`动态学校 manager 用新密码重登（显式 schoolCode）`, async () => {
    const s = await login('manager', dynManagerPassword, DYN_SCHOOL)
    dynToken = s.token
    assert(dynToken && s.mustChangePassword === false, '改密后必须可用且无强制改密标记')
  })

  // ---------- E. 检测记录（双 API + 全类型；数据契约：写入派生学校租户 schema）----------
  console.log('\n【E】检测记录 CRUD')
  const managerToken = managerSession.token
  let tablewareId = null
  await test('POST /api/records/tableware 创建（含校验）', async () => {
    const { status, json } = await call('POST', '/api/records/tableware', { token: managerToken, body: sampleRec('tableware') })
    assert(status === 200 && json?.data?.id, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
    tablewareId = json.data.id
  })
  await test('GET /api/records/tableware 列表含该记录', async () => {
    const { status, json } = await call('GET', '/api/records/tableware', { token: managerToken })
    assert(status === 200 && json?.data?.some(r => r.id === tablewareId), `status=${status}`)
  })
  await test('PUT /api/records/tableware/:id 更新', async () => {
    const upd = { ...sampleRec('tableware'), result: '不合格' }
    const { status, json } = await call('PUT', `/api/records/tableware/${tablewareId}`, { token: managerToken, body: upd })
    assert(status === 200, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
  })
  await test('POST /api/records/tableware 幂等（相同内容 deduplicated）', async () => {
    const { status, json } = await call('POST', '/api/records/tableware', { token: managerToken, body: sampleRec('tableware') })
    assert(status === 200 && json?.deduplicated === true, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
  })
  await test('DELETE /api/records/tableware/:id 删除', async () => {
    const { status } = await call('DELETE', `/api/records/tableware/${tablewareId}`, { token: managerToken })
    assert(status === 200, `status=${status}`)
  })
  // 其余 4 种类型：创建 + 列表（清理统一放在脚本尾部）
  for (const t of TYPES.filter(t => t !== 'tableware')) {
    await test(`POST+GET /api/records/${t} 创建与列表`, async () => {
      const c = await call('POST', `/api/records/${t}`, { token: managerToken, body: sampleRec(t) })
      assert(c.status === 200 && c.json?.data?.id, `${t} create ${c.status} ${JSON.stringify(c.json)?.slice(0, 160)}`)
      const l = await call('GET', `/api/records/${t}`, { token: managerToken })
      assert(l.status === 200 && l.json?.data?.length >= 1, `${t} list ${l.status}`)
    })
  }
  // 批量导入
  await test('POST /api/records/tableware/bulk-upsert 批量', async () => {
    const { status, json } = await call('POST', '/api/records/tableware/bulk-upsert', {
      token: managerToken,
      body: {
        records: [
          { ...sampleRec('tableware'), testDate: '2026-07-10', canteen: '二食堂' },
          { ...sampleRec('tableware'), testDate: '2026-07-11', canteen: '三食堂' }
        ]
      }
    })
    assert(status === 200 && json?.data?.created + json?.data?.updated >= 1, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
  })
  // /api/test-records 旧接口（生产契约：2026-09-16 H2 归一后同样要求三键上下文，拒绝空结果写出）
  await test('POST+GET /api/test-records 兼容接口（生产契约：必须携带三键上下文）', async () => {
    const c = await call('POST', '/api/test-records', {
      token: managerToken,
      body: { test_type: 'generic', test_name: '兼容测试', testDate: '2026-07-17', canteen: '一食堂', inspector: '联调测试员', result: '合格' }
    })
    assert(c.status === 200 && c.json?.data?.id, `create ${c.status} ${JSON.stringify(c.json)?.slice(0, 160)}`)
    const l = await call('GET', '/api/test-records', { token: managerToken })
    assert(l.status === 200 && l.json?.success, `list ${l.status}`)
  })

  // ---------- F. 审计日志 ----------
  console.log('\n【F】审计日志')
  let auditId = null
  await test('POST /api/audit-logs 创建', async () => {
    const { status, json } = await call('POST', '/api/audit-logs', { token: managerToken, body: { action: 'export', resource_type: 'test_record', details: '联调测试' } })
    assert(status === 201 && json?.data?.id, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
    auditId = json.data.id
  })
  await test('GET /api/audit-logs 列表', async () => {
    const { status, json } = await call('GET', '/api/audit-logs', { token: managerToken })
    assert(status === 200 && json?.data?.some(l => l.id === auditId), `status=${status}`)
  })
  await test('GET /api/audit-logs/stats/summary（学校 manager）', async () => {
    const { status } = await call('GET', '/api/audit-logs/stats/summary', { token: managerToken })
    assert(status === 200, `status=${status}`)
  })
  await test('GET /api/audit-logs/:id 详情', async () => {
    const { status } = await call('GET', `/api/audit-logs/${auditId}`, { token: managerToken })
    assert(status === 200, `status=${status}`)
  })

  // ---------- G. 离线同步 ----------
  console.log('\n【G】离线同步')
  await test('POST /api/sync/records 单条', async () => {
    const { status, json } = await call('POST', '/api/sync/records', {
      token: managerToken,
      body: { action: 'add', store: 'tableware', data: { ...sampleRec('tableware'), test_name: '同步测试' } }
    })
    assert(status === 200 && json?.success, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
  })
  await test('POST /api/sync/batch 批量', async () => {
    const { status, json } = await call('POST', '/api/sync/batch', {
      token: managerToken,
      body: { operations: [
        { action: 'add', store: 'pathogen', data: { ...sampleRec('pathogen') } },
        { action: 'add', store: 'oil', data: { ...sampleRec('oil') } }
      ] }
    })
    assert(status === 200 && json?.succeeded === 2, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
  })
  await test('GET /api/sync/status 统计', async () => {
    const { status, json } = await call('GET', '/api/sync/status', { token: managerToken })
    assert(status === 200 && json?.summary?.totalRecords >= 0, `status=${status}`)
  })

  // ---------- H. 用户管理 ----------
  console.log('\n【H】用户管理')
  const rnd = Date.now().toString().slice(-6)
  const testUser = `ituser${rnd}`
  const testPhone = `13${Date.now().toString().slice(-9)}`
  let testUserId = null
  await test('POST /api/user/register 创建用户（学校 manager；落本校租户）', async () => {
    const { status, json } = await call('POST', '/api/user/register', {
      token: managerToken,
      body: { username: testUser, password: 'Test@12345', fullName: '联调用户', phone: testPhone }
    })
    assert(status === 201 && json?.user?.id, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
    testUserId = json.user.id
  })
  await test('GET /api/user/list（学校 manager）', async () => {
    const { status, json } = await call('GET', '/api/user/list', { token: managerToken })
    const ok = Array.isArray(json) ? json.some(u => u.id === testUserId) : (json?.data?.some?.(u => u.id === testUserId) ?? false)
    assert(status === 200 && ok, `status=${status} ${JSON.stringify(json)?.slice(0, 120)}`)
  })
  await test('operator 访问 /api/user/list = 403', async () => {
    const { status } = await call('GET', '/api/user/list', { token: operatorToken })
    assert(status === 403, `期望403 实际${status}`)
  })
  await test('新用户登录（显式 schoolCode）+ 改密 + 用新密码登录', async () => {
    const s = await login(testUser, 'Test@12345', SCHOOL_CODE)
    const ch = await call('POST', '/api/user/change-password', { token: s.token, body: { oldPassword: 'Test@12345', newPassword: 'Test@99999' } })
    assert(ch.status === 200, `改密 ${ch.status} ${JSON.stringify(ch.json)?.slice(0, 160)}`)
    const relogin = await call('POST', '/api/user/login', { body: { username: testUser, password: 'Test@99999', schoolCode: SCHOOL_CODE } })
    assert(relogin.status === 200 && relogin.json.token, '新密码登录失败')
  })
  await test('POST /api/user/:id/reset-password 重置（生产语义：置 must_change_password）', async () => {
    const { status } = await call('POST', `/api/user/${testUserId}/reset-password`, { token: managerToken, body: { newPassword: 'Test@11111' } })
    assert(status === 200, `status=${status}`)
    const relogin = await call('POST', '/api/user/login', { body: { username: testUser, password: 'Test@11111', schoolCode: SCHOOL_CODE } })
    assert(relogin.status === 200 && relogin.json.mustChangePassword === true, '重置后的临时密码必须首登强制改密（生产 IF-2/M2 契约）')
  })
  await test('禁用 + 启用 用户', async () => {
    const d = await call('POST', `/api/user/${testUserId}/disable`, { token: managerToken })
    const e = await call('POST', `/api/user/${testUserId}/enable`, { token: managerToken })
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
    const { status } = await call('POST', '/api/guest/quick-access', { body: { schoolCode: SCHOOL_CODE } })
    assert(status === 403, `期望403 实际${status}`)
  })

  // ---------- J. 多租户隔离 ----------
  // 动态派生学校（DYN_SCHOOL，由超管运行时建校）与契约派生学校、public 平台面做隔离验证。
  console.log('\n【J】多租户隔离')
  let tbRecId = null
  let tbCode = null
  await test(`在 ${DYN_SCHOOL} 租户内创建记录`, async () => {
    const { status, json } = await call('POST', '/api/records/tableware', { token: dynToken, body: sampleRec('tableware') })
    assert(status === 200 && json?.data?.id, `status=${status} ${JSON.stringify(json)?.slice(0, 160)}`)
    tbRecId = json.data.id
    tbCode = json.data.record_code
  })
  await test(`平台超管记录列表（public 面）【不】含 ${DYN_SCHOOL} 记录（租户隔离）`, async () => {
    const { status, json } = await call('GET', '/api/records/tableware', { token: superToken })
    assert(status === 200 && !json?.data?.some(r => r.record_code === tbCode), '发现跨租户泄露！')
  })
  await test(`契约派生学校 ${SCHOOL_CODE} 列表【不】含 ${DYN_SCHOOL} 记录（租户隔离，双向）`, async () => {
    const { status, json } = await call('GET', '/api/records/tableware', { token: managerToken })
    assert(status === 200 && !json?.data?.some(r => r.record_code === tbCode), '发现跨租户泄露！')
  })
  await test(`${DYN_SCHOOL} manager 列表【含】自身记录`, async () => {
    const { status, json } = await call('GET', '/api/records/tableware', { token: dynToken })
    assert(status === 200 && json?.data?.some(r => r.record_code === tbCode), '租户内记录不可见，异常')
  })
  await test(`清理 ${DYN_SCHOOL} 测试记录`, async () => {
    const { status } = await call('DELETE', `/api/records/tableware/${tbRecId}`, { token: dynToken })
    assert(status === 200, `status=${status}`)
  })

  // ---------- 清理 ----------
  console.log('\n【清理】删除联调产生的数据（脚本 API 面）')
  // ① 派生学校租户内的全部检测记录（本脚本产生的；契约 seed 不含记录）
  let cleanedRecords = 0
  for (const t of TYPES) {
    const l = await call('GET', `/api/records/${t}?limit=2000`, { token: managerToken })
    for (const r of (l.json?.data || [])) {
      const d = await call('DELETE', `/api/records/${t}/${r.id}`, { token: managerToken })
      if (d.status === 200) cleanedRecords++
    }
  }
  console.log(`  · 派生学校租户记录清理：${cleanedRecords} 条（${TYPES.join('/')}）`)
  // ② /api/test-records 兼容接口的记录
  const legacyList = await call('GET', '/api/test-records?limit=2000', { token: managerToken })
  let cleanedLegacy = 0
  for (const r of (legacyList.json?.data || [])) {
    const d = await call('DELETE', `/api/test-records/${r.id}`, { token: managerToken })
    if (d.status === 200) cleanedLegacy++
  }
  console.log(`  · 兼容接口记录清理：${cleanedLegacy} 条`)
  // ③ 测试用户（R17/B-3：正式语义 = 软删除墓碑；显式断言 DELETE 200 + 旧 token/新登录被拒 + 不可复活）
  if (testUserId) {
    // 注意：login() 助手在非 200 时**抛错**且不返回 status → 这里用原始 call 探测（不改断言语义）
    let preDeleteToken = null
    const preDeleteLogin = await call('POST', '/api/user/login', { body: { username: testUser, password: 'Test@11111', schoolCode: SCHOOL_CODE } })
    if (preDeleteLogin.status === 200 && preDeleteLogin.json && preDeleteLogin.json.token) preDeleteToken = preDeleteLogin.json.token
    const d = await call('DELETE', `/api/user/${testUserId}`, { token: managerToken })
    const oldTokenStatus = preDeleteToken ? (await call('GET', '/api/user/me', { token: preDeleteToken })).status : null
    const newLogin = await call('POST', '/api/user/login', { body: { username: testUser, password: 'Test@11111', schoolCode: SCHOOL_CODE } })
    console.log(`  · 测试用户 ${testUser}: DELETE=${d.status} 旧token=${oldTokenStatus} 新登录=${newLogin.status}（软删除墓碑，不物理清除）`)
    console.log(`T02C_TEST_USER=${JSON.stringify({ id: testUserId, username: testUser, deleteStatus: d.status, preDeleteLoginStatus: preDeleteLogin.status, oldTokenStatus, newLoginStatus: newLogin.status })}`)
    if (d.status !== 200) throw new Error(`[T02C-DELETE-ASSERT] DELETE /api/user/:id expected 200, got ${d.status}`)
    if (preDeleteToken && oldTokenStatus !== 401) throw new Error(`[T02C-TOMBSTONE-ASSERT] deleted user's pre-delete token expected 401, got ${oldTokenStatus}`)
    if (![401, 403].includes(newLogin.status)) throw new Error(`[T02C-TOMBSTONE-ASSERT] deleted user re-login expected 401/403, got ${newLogin.status}`)
  }
  // 动态学校 schema 由 harness 以管理身份做 SQL 清理（脚本无删校 API），此处仅提示
  console.log(`  · 动态学校 ${DYN_SCHOOL} 的 schema/School 行/定制行由 harness 以管理身份 SQL 清理（既有语义）`)

  // ---------- 汇总 ----------
  console.log(`\n========================================`)
  console.log(`  通过 ${pass} / 失败 ${fail}`)
  console.log(`========================================`)
  if (fail > 0) {
    console.log('\n失败明细:')
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`)
    process.exit(1)
  }
  console.log('🎉 全部模块联调通过（P3-W0-T02E 数据契约）')
}

main().catch(e => {
  console.error('💥 联调脚本异常:', e)
  process.exit(2)
})
