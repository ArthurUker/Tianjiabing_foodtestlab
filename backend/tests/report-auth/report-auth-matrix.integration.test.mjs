// P3-W5-REPORT-AUTH-T01（AUD-017 / RC-08）报告授权矩阵 · 真实 HTTP 集成回归（**本包独占实例**）。
//
// 覆盖（任务包 §验证）：
//   · 每端点 × 身份角色矩阵：匿名 / guest / viewer / operator / 普通学校 manager → 401/403；
//     平台授权管理角色（role='admin' 且无学校归属）→ 正常；
//   · 跨任务（用例/来源）ID、批量混入无权 ID、证据路径、上传/下载、缓存响应；
//   · 认证继续走 W1 统一会话模型（真实 server.js + authenticateUser；登出后旧 token 401 REVOKED，
//     不得把授权失败误报为 403，也不另造 token 失效判断）；
//   · 写端点拒绝时无副作用（SQL 复核）；
//   · 静态装配证据：router.use(authenticateUser, requireReportPlatformAdmin) 位于全部 handler 之前。
//
// 运行（先 source provisioner test-env.sh；本套件不读业务 .env）：
//   RPTAUTH_HTTP_PORT=<自有端口> RPTAUTH_SERVER_LOG=<evidence logs> RPTAUTH_FIXTURE_JSON=<fixture 输出> \
//   RPTAUTH_*_PASSWORD=<随机口令（仅 env）> \
//   node --test --test-concurrency=1 backend/tests/report-auth/report-auth-matrix.integration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  loadReportAuthContext, readHttpPort, portIsFree, spawnBackend, waitHealthy, stopBackend,
  httpRequest, loginPlatformSuperAdmin, loginSchoolUser, quickAccessGuest,
  readFixtureEvidence, readIdentityPasswords, backendDir, gate, sleep, require as harnessRequire,
} from './_report-auth-harness.mjs'

/* ───────── 隔离上下文（缺配置 → fail-closed，首条注册拒绝测试，不 skip） ───────── */
let ctx = null
let loadError = null
try {
  ctx = loadReportAuthContext()
} catch (e) {
  loadError = e
}

if (!ctx) {
  test('报告授权矩阵：[RPTAUTH] 未配置显式 TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE → 拒绝（fail-closed，不 skip）', () => {
    assert.fail(`[RPTAUTH-ISOLATION-REFUSED] ${loadError ? loadError.message : 'unknown'}`)
  })
} else {
  const { PrismaClient } = harnessRequire(path.join(backendDir, 'node_modules/@prisma/client'))

  const httpPort = readHttpPort(process.env, ctx.cfg)
  const fixture = readFixtureEvidence()
  const passwords = readIdentityPasswords()
  const serverLogPath = process.env.RPTAUTH_SERVER_LOG
  if (!serverLogPath) {
    throw Object.assign(new Error('[RPTAUTH-ENV] missing RPTAUTH_SERVER_LOG（原始启动日志落盘路径）'), { code: 'E_ENV' })
  }

  const BASE = `http://127.0.0.1:${httpPort}`
  const SCHOOL = ctx.derived.tenants.a
  const TASK_ID = fixture.cases.task.id
  const TASK_KEY = fixture.cases.task.case_key
  const ISSUE_ID = fixture.cases.issue.id
  const NONEXISTENT_ID = fixture.cases.nonexistentId
  const EVIDENCE_FILE = fixture.evidenceFile.file
  const EVIDENCE_DIR = path.join(backendDir, 'uploads', 'test-evidence', TASK_ID)
  const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const PNG_1X1_BYTES = Buffer.from(PNG_1X1_BASE64, 'base64')

  const adminPrisma = new PrismaClient({ datasources: { db: { url: ctx.adminUrl } } })
  const testRolePrisma = new PrismaClient({ datasources: { db: { url: ctx.cfg.url } } })

  let spawned = null
  const tokens = {}
  const log = (...a) => console.log('[RPTAUTH]', ...a)

  const forbiddenIdentities = ['guest', 'viewer', 'operator', 'manager']

  /** 拒绝断言（403 + 统一 code + no-store 缓存头）。 */
  function expectForbidden(r, label) {
    assert.equal(r.status, 403, `${label}: 期望 403（服务端强制），实际 ${r.status} body=${r.text.slice(0, 200)}`)
    assert.equal(r.body?.code, 'REPORT_FORBIDDEN', `${label}: 403 必须携带 code=REPORT_FORBIDDEN`)
    assert.equal(r.headers['cache-control'], 'no-store', `${label}: 403 必须 Cache-Control: no-store`)
  }

  async function callEndpoint(ep, token) {
    const p = typeof ep.path === 'function' ? ep.path() : ep.path
    const b = typeof ep.body === 'function' ? ep.body() : ep.body
    return httpRequest(BASE, `/api/test-results${p}`, { method: ep.method, token, body: b })
  }

  const sqlCountExecutions = async (where = '') => {
    const r = await adminPrisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM public."TestExecution" ${where}`)
    return r[0].n
  }
  const sqlCaseState = async (id) => {
    const r = await adminPrisma.$queryRawUnsafe(`SELECT closed, closed_by, fixed_pending_retest, fixed_note FROM public."TestCase" WHERE id = $1::text`, id)
    return r[0] || null
  }
  const evidenceDirFiles = () => (fs.existsSync(EVIDENCE_DIR) ? fs.readdirSync(EVIDENCE_DIR).sort() : [])

  /* ───────── 端点清单（10 个端点逐一施加授权） ───────── */
  const ENDPOINTS = [
    { name: 'GET /defs', method: 'GET', path: '/defs' },
    { name: 'GET /me', method: 'GET', path: '/me' },
    { name: 'GET /cases', method: 'GET', path: '/cases' },
    { name: 'GET /cases/:id/history', method: 'GET', path: () => `/cases/${encodeURIComponent(TASK_ID)}/history` },
    { name: 'POST /executions', method: 'POST', path: '/executions', body: () => ({ case_key: TASK_KEY, result: 'passed', tester_name: 'rptauth-AUTHZ-unauthorized' }) },
    { name: 'POST /cases/close', method: 'POST', path: '/cases/close', body: () => ({ case_ids: [TASK_ID], closed: true }) },
    { name: 'POST /cases/mark-fixed', method: 'POST', path: '/cases/mark-fixed', body: () => ({ case_id: TASK_ID, fixed: true }) },
    { name: 'GET /summary', method: 'GET', path: '/summary' },
    { name: 'POST /upload', method: 'POST', path: '/upload', body: () => ({ case_id: TASK_ID, files: [{ type: 'image/png', data: PNG_1X1_BASE64 }] }) },
    { name: 'GET /evidence/:caseId/:file', method: 'GET', path: () => `/evidence/${encodeURIComponent(TASK_ID)}/${EVIDENCE_FILE}` },
  ]

  test.before(async () => {
    // ① 隔离运行期核验：测试角色身份 + 门禁全量（marker/角色属性/namespace owner）
    const idRow = (await testRolePrisma.$queryRawUnsafe(
      `SELECT current_database() AS db, current_user AS cu, current_schema() AS s`,
    ))[0]
    assert.equal(idRow.db, ctx.cfg.database, '测试角色必须在派生库')
    assert.equal(idRow.cu, ctx.cfg.role, '测试角色必须为门禁派生角色')
    const gateRes = await gate.verifyRuntimeIdentity(
      { query: async (sql, params = []) => ({ rows: await testRolePrisma.$queryRawUnsafe(sql, ...params) }) },
      ctx.cfg,
      { expectedSchema: 'public' },
    )
    assert.equal(gateRes.ok, true, '门禁运行期核验必须通过')
    const adminId = (await adminPrisma.$queryRawUnsafe(`SELECT current_database() AS db, current_user AS cu`))[0]
    assert.equal(adminId.db, ctx.cfg.database, '管理连接必须指向同一实例库')
    assert.equal(adminId.cu, ctx.derived.adminRole, '管理连接必须为实例管理角色')
    log(`实例身份核验: db=${idRow.db} testRole=${idRow.cu} adminRole=${adminId.cu} port=${ctx.cfg.port}`)

    // ② 端口必须空闲（自有回环端口；绝不默认端口）
    assert.equal(await portIsFree(httpPort), true, `端口 ${httpPort} 必须空闲`)

    // ③ 真实 server.js（真实 authenticateUser / W1 统一会话模型 / 真实路由挂载）
    spawned = spawnBackend({ httpPort, adminUrl: ctx.adminUrl, logPath: serverLogPath })
    const healthy = await waitHealthy(httpPort)
    if (!healthy) {
      const tail = fs.existsSync(serverLogPath) ? fs.readFileSync(serverLogPath, 'utf8').slice(-1200) : '(no log)'
      assert.fail(`后端启动未就绪（保留原始日志 ${serverLogPath}）: ${tail}`)
    }
    log(`真实后端就绪: pid=${spawned.child.pid} port=${httpPort}`)

    // ④ 五个身份真实登录（平台超管 / manager / operator / viewer / 快速访客）
    tokens.superAdmin = await loginPlatformSuperAdmin(BASE, {
      username: fixture.accounts.superAdmin.username, password: passwords.superAdmin,
    })
    tokens.manager = await loginSchoolUser(BASE, { username: fixture.accounts.manager.username, password: passwords.manager, schoolCode: SCHOOL })
    tokens.operator = await loginSchoolUser(BASE, { username: fixture.accounts.operator.username, password: passwords.operator, schoolCode: SCHOOL })
    tokens.viewer = await loginSchoolUser(BASE, { username: fixture.accounts.viewer.username, password: passwords.viewer, schoolCode: SCHOOL })
    tokens.guest = await quickAccessGuest(BASE, SCHOOL)
    // 专用第二枚平台 token（登出用例用；不影响主 token）
    tokens.superAdminLogout = await loginPlatformSuperAdmin(BASE, {
      username: fixture.accounts.superAdmin.username, password: passwords.superAdmin,
    })
    log('五身份登录完成（口令仅 env；不落日志）')
  })

  test.after(async () => {
    // ① 停止后端 + 核验端口释放
    if (spawned) {
      const stopped = await stopBackend(spawned)
      let released = false
      for (let i = 0; i < 20; i += 1) { if (await portIsFree(httpPort)) { released = true; break } await sleep(250) }
      log(`后端停止: exit=${stopped.exitCode} signal=${stopped.signal} portReleased=${released}`)
      assert.equal(released, true, `端口 ${httpPort} 必须释放`)
    }
    // ② 测试数据恢复（管理身份 SQL；仅本实例库）
    try {
      await adminPrisma.$executeRawUnsafe(`DELETE FROM public."TestExecution" WHERE tester_name LIKE 'rptauth-%'`)
      await adminPrisma.$executeRawUnsafe(`DELETE FROM public."TestExecution" WHERE case_id IN (SELECT id FROM public."TestCase" WHERE title = 'RPTAUTH-AUTHZ-ISSUE')`)
      await adminPrisma.$executeRawUnsafe(`DELETE FROM public."TestCase" WHERE title = 'RPTAUTH-AUTHZ-ISSUE'`)
      await adminPrisma.$executeRawUnsafe(
        `UPDATE public."TestCase" SET closed = false, closed_by = NULL, closed_at = NULL, fixed_pending_retest = false, fixed_note = NULL WHERE id IN ($1::text, $2::text)`,
        TASK_ID, ISSUE_ID,
      )
      if (fs.existsSync(EVIDENCE_DIR)) {
        for (const f of fs.readdirSync(EVIDENCE_DIR)) {
          if (f !== EVIDENCE_FILE) fs.rmSync(path.join(EVIDENCE_DIR, f), { force: true })
        }
      }
    } catch (e) {
      log(`测试数据恢复失败: ${e.message}`)
      throw e
    }
    await adminPrisma.$disconnect()
    await testRolePrisma.$disconnect()
  })

  /* ═════════ 0. 基线：五身份 token 真实有效（认证先于授权，且身份真实） ═════════ */

  test('基线：五身份 token 均可通过认证访问普通受保护接口（身份真实、非伪造）', async () => {
    for (const key of ['manager', 'operator', 'viewer']) {
      const r = await httpRequest(BASE, '/api/user/me', { token: tokens[key] })
      assert.equal(r.status, 200, `${key} token 应在 /api/user/me 有效（status=${r.status}）`)
    }
    const admin = await httpRequest(BASE, '/api/user/me', { token: tokens.superAdmin })
    assert.equal(admin.status, 200, `平台超管 token 应有效（status=${admin.status}）`)
    const guest = await httpRequest(BASE, '/api/guest/verify-token', { method: 'POST', token: tokens.guest })
    assert.equal(guest.status, 200, `访客 token 应有效（status=${guest.status}）`)
    assert.equal(guest.body?.valid, true)
  })

  /* ═════════ 1. 拒绝矩阵：每端点 × 匿名/guest/viewer/operator/manager ═════════ */

  for (const ep of ENDPOINTS) {
    test(`拒绝矩阵 ${ep.name}：匿名 401；guest/viewer/operator/manager 一律 403`, async () => {
      // 匿名（无 token）→ 401（认证层；不得泄露授权信息）
      const anon = await callEndpoint(ep)
      assert.equal(anon.status, 401, `${ep.name}: 匿名必须 401，实际 ${anon.status}`)
      assert.ok(!String(anon.headers['cache-control'] || '').includes('max-age'), `${ep.name}: 401 不得带可缓存头`)

      for (const id of forbiddenIdentities) {
        const r = await callEndpoint(ep, tokens[id])
        expectForbidden(r, `${ep.name} × ${id}`)
      }
    })
  }

  /* ═════════ 2. 写端点拒绝时无副作用（SQL 复核） ═════════ */

  test('拒绝无副作用：manager 的 executions/close/mark-fixed/upload 均不产生写入', async () => {
    const before = {
      executions: await sqlCountExecutions(),
      taskState: await sqlCaseState(TASK_ID),
      files: evidenceDirFiles(),
    }
    const writes = [
      { method: 'POST', path: '/executions', body: { case_key: TASK_KEY, result: 'passed', tester_name: 'rptauth-AUTHZ-unauthorized' } },
      { method: 'POST', path: '/cases/close', body: { case_ids: [TASK_ID, ISSUE_ID], closed: true } },
      { method: 'POST', path: '/cases/mark-fixed', body: { case_id: TASK_ID, fixed: true, note: 'rptauth-unauthorized' } },
      { method: 'POST', path: '/cases/close', body: { case_ids: [TASK_ID, ISSUE_ID], closed: false } },
      { method: 'POST', path: '/upload', body: { case_id: TASK_ID, files: [{ type: 'image/png', data: PNG_1X1_BASE64 }] } },
    ]
    for (const w of writes) {
      const r = await httpRequest(BASE, `/api/test-results${w.path}`, { method: w.method, token: tokens.manager, body: w.body })
      expectForbidden(r, `写拒绝 ${w.method} ${w.path}`)
    }
    assert.equal(await sqlCountExecutions(), before.executions, 'executions 被拒后不得新增执行记录')
    assert.deepEqual(await sqlCaseState(TASK_ID), before.taskState, 'close/mark-fixed 被拒后用例状态不得变化')
    assert.deepEqual(evidenceDirFiles(), before.files, 'upload 被拒后证据目录不得新增文件')
  })

  /* ═════════ 3. 平台正例（读路径） ═════════ */

  test('平台正例 · defs/me/cases/summary（读路径）', async () => {
    const defs = await httpRequest(BASE, '/api/test-results/defs', { token: tokens.superAdmin })
    assert.equal(defs.status, 200)
    assert.ok(Array.isArray(defs.body?.data) && defs.body.data.length > 0, 'defs 应返回用例分组')
    assert.match(String(defs.headers['cache-control'] || ''), /no-store/, 'defs 必须 no-store')

    const me = await httpRequest(BASE, '/api/test-results/me', { token: tokens.superAdmin })
    assert.equal(me.status, 200)
    assert.equal(me.body?.data?.role, 'admin')
    assert.equal(me.body?.data?.schoolCode, null, '平台超管无学校归属')

    const cases = await httpRequest(BASE, '/api/test-results/cases', { token: tokens.superAdmin })
    assert.equal(cases.status, 200)
    const ids = cases.body.data.map((c) => c.id)
    assert.ok(ids.includes(TASK_ID) && ids.includes(ISSUE_ID), 'cases 应包含 fixture 的任务与反馈用例')

    const summary = await httpRequest(BASE, '/api/test-results/summary', { token: tokens.superAdmin })
    assert.equal(summary.status, 200)
    assert.ok(summary.body.data.totals.total >= 2, 'summary totals 应覆盖 fixture 用例')
  })

  /* ═════════ 4. 平台正例（executions / history / 跨用例 ID） ═════════ */

  test('平台正例 · executions 提交（task 追加）与 issue 新建；history 跨来源可读', async () => {
    const before = await sqlCountExecutions()
    const task = await httpRequest(BASE, '/api/test-results/executions', {
      method: 'POST', token: tokens.superAdmin,
      body: { case_key: TASK_KEY, result: 'passed', detail: 'RPTAUTH 平台正例', tester_name: 'rptauth-platform' },
    })
    assert.equal(task.status, 200, JSON.stringify(task.body))
    assert.equal(task.body?.data?.case?.id, TASK_ID)
    assert.equal(await sqlCountExecutions(), before + 1, 'executions 正例应新增 1 条')

    const issueTitle = 'RPTAUTH-AUTHZ-ISSUE'
    const issue = await httpRequest(BASE, '/api/test-results/executions', {
      method: 'POST', token: tokens.superAdmin,
      body: { title: issueTitle, group: 'rptauth', result: 'failed', detail: 'RPTAUTH 平台正例 issue', tester_name: 'rptauth-platform' },
    })
    assert.equal(issue.status, 200, JSON.stringify(issue.body))
    const issueId = issue.body?.data?.case?.id
    assert.ok(issueId && issueId !== TASK_ID, 'issue 用例应新建独立 id')

    // 跨用例/跨来源：平台身份可读 task 与 issue 两条历史
    for (const [label, id] of [['task', TASK_ID], ['issue', ISSUE_ID], ['新 issue（跨任务创建）', issueId]]) {
      const h = await httpRequest(BASE, `/api/test-results/cases/${encodeURIComponent(id)}/history`, { token: tokens.superAdmin })
      assert.equal(h.status, 200, `${label} history 应 200（平台身份）`)
      assert.ok(Array.isArray(h.body?.data?.executions), `${label} history 返回 executions 数组`)
    }
    // 平台身份下：不存在的 id → 业务 404（存在性只在授权后暴露）
    const missing = await httpRequest(BASE, `/api/test-results/cases/${encodeURIComponent(NONEXISTENT_ID)}/history`, { token: tokens.superAdmin })
    assert.equal(missing.status, 404, '平台身份下不存在用例应为 404')
  })

  test('非平台身份按用例 id 探测：有效/无效 id 一律 403（授权先于存在性，零信息泄露）', async () => {
    for (const [label, id] of [['有效 task id', TASK_ID], ['有效 issue id', ISSUE_ID], ['不存在的 id', NONEXISTENT_ID]]) {
      const r = await httpRequest(BASE, `/api/test-results/cases/${encodeURIComponent(id)}/history`, { token: tokens.manager })
      expectForbidden(r, `manager × history(${label})`)
    }
  })

  /* ═════════ 5. 平台正例（close 批量混入无权 ID + open 恢复） ═════════ */

  test('平台正例 · close 批量：混入不存在 ID 只命中存在项；open 恢复', async () => {
    const close = await httpRequest(BASE, '/api/test-results/cases/close', {
      method: 'POST', token: tokens.superAdmin,
      body: { case_ids: [TASK_ID, ISSUE_ID, NONEXISTENT_ID], closed: true },
    })
    assert.equal(close.status, 200, JSON.stringify(close.body))
    assert.equal(close.body.data.matched, 2, '混入不存在 ID 时只命中 2 条存在用例')
    assert.deepEqual(close.body.data.case_ids, [TASK_ID, ISSUE_ID, NONEXISTENT_ID], '返回请求的原始 id 清单')
    const closed = await sqlCaseState(TASK_ID)
    assert.equal(closed.closed, true, 'close 后用例必须收口')
    assert.equal(closed.closed_by, fixture.accounts.superAdmin.username, 'closed_by 应为平台账号')

    const open = await httpRequest(BASE, '/api/test-results/cases/close', {
      method: 'POST', token: tokens.superAdmin,
      body: { case_ids: [TASK_ID, ISSUE_ID], closed: false },
    })
    assert.equal(open.status, 200)
    assert.equal(open.body.data.matched, 2)
    const opened = await sqlCaseState(TASK_ID)
    assert.equal(opened.closed, false, 'open 后用例必须恢复')
  })

  /* ═════════ 6. 平台正例（mark-fixed + 解除） ═════════ */

  test('平台正例 · mark-fixed 与解除', async () => {
    const mark = await httpRequest(BASE, '/api/test-results/cases/mark-fixed', {
      method: 'POST', token: tokens.superAdmin,
      body: { case_id: TASK_ID, fixed: true, note: 'RPTAUTH 平台正例' },
    })
    assert.equal(mark.status, 200, JSON.stringify(mark.body))
    let state = await sqlCaseState(TASK_ID)
    assert.equal(state.fixed_pending_retest, true)
    assert.equal(state.fixed_note, 'RPTAUTH 平台正例')

    const unmark = await httpRequest(BASE, '/api/test-results/cases/mark-fixed', {
      method: 'POST', token: tokens.superAdmin,
      body: { case_id: TASK_ID, fixed: false },
    })
    assert.equal(unmark.status, 200)
    state = await sqlCaseState(TASK_ID)
    assert.equal(state.fixed_pending_retest, false, '解除后标记必须清除')
    // 平台身份下不存在的 case_id → 404（业务语义，仅在授权后暴露）
    const missing = await httpRequest(BASE, '/api/test-results/cases/mark-fixed', {
      method: 'POST', token: tokens.superAdmin,
      body: { case_id: NONEXISTENT_ID, fixed: true },
    })
    assert.equal(missing.status, 404, '平台身份标记不存在用例应为 404')
  })

  /* ═════════ 7. 平台正例（upload / evidence 下载 / 路径攻击 / 缓存头） ═════════ */

  test('平台正例 · upload + evidence 下载：字节一致、缓存头正确、路径攻击 400', async () => {
    const beforeFiles = evidenceDirFiles()
    const up = await httpRequest(BASE, '/api/test-results/upload', {
      method: 'POST', token: tokens.superAdmin,
      body: { case_id: TASK_ID, files: [{ type: 'image/png', data: PNG_1X1_BASE64 }] },
    })
    assert.equal(up.status, 200, JSON.stringify(up.body))
    assert.equal(Array.isArray(up.body?.urls) && up.body.urls.length, 1)
    const url = up.body.urls[0]
    const afterFiles = evidenceDirFiles()
    assert.equal(afterFiles.length, beforeFiles.length + 1, 'upload 正例应新增 1 个证据文件')
    const newFile = afterFiles.find((f) => !beforeFiles.includes(f))
    assert.ok(newFile, '应能定位新增证据文件')

    // 下载（平台）：200 + 字节一致 + public 缓存头
    const down = await fetch(`${BASE}${url}`, { headers: { authorization: `Bearer ${tokens.superAdmin}` } })
    assert.equal(down.status, 200, '平台身份应可下载证据')
    const bytes = Buffer.from(await down.arrayBuffer())
    assert.equal(bytes.length, PNG_1X1_BYTES.length, `1x1 PNG 固定 ${PNG_1X1_BYTES.length} 字节`)
    assert.equal(Buffer.compare(bytes, PNG_1X1_BYTES), 0, '下载字节必须与上传一致')
    assert.match(String(down.headers.get('cache-control') || ''), /max-age=86400/, '证据下载保留既有缓存策略')

    // 缓存响应：403 一律 no-store（拒绝结果不得被缓存）
    const denied = await httpRequest(BASE, url, { token: tokens.guest })
    expectForbidden(denied, 'guest × evidence 下载')

    // 路径攻击（平台身份下也不放行）：穿越 caseId / 非法文件名 → 400
    const traversal = await httpRequest(BASE, `/api/test-results/evidence/..%2F..%2Fetc/passwd`, { token: tokens.superAdmin })
    assert.equal(traversal.status, 400, 'caseId 穿越必须 400')
    const badFile = await httpRequest(BASE, `/api/test-results/evidence/${encodeURIComponent(TASK_ID)}/${encodeURIComponent('..%2Fpasswd')}`, { token: tokens.superAdmin })
    assert.equal(badFile.status, 400, '非法文件名必须 400')
    const missing = await httpRequest(BASE, `/api/test-results/evidence/${encodeURIComponent(TASK_ID)}/rptauth-not-exists.png`, { token: tokens.superAdmin })
    assert.equal(missing.status, 404, '不存在的证据文件（平台身份）应 404')

    // 恢复：删除本次新增文件（保持 fixture 基线）
    fs.rmSync(path.join(EVIDENCE_DIR, newFile), { force: true })
    assert.deepEqual(evidenceDirFiles(), beforeFiles, '上传正例文件已清理回基线')
  })

  /* ═════════ 8. W1 统一会话模型：登出后旧 token 401 REVOKED（不得误报 403） ═════════ */

  test('统一会话模型：平台 token 登出后旧 token 请求报告端点 → 401 REVOKED（认证层，非 403）', async () => {
    const before = await httpRequest(BASE, '/api/test-results/summary', { token: tokens.superAdminLogout })
    assert.equal(before.status, 200, '登出前专用 token 必须可用')

    const logout = await httpRequest(BASE, '/api/user/logout', { method: 'POST', token: tokens.superAdminLogout })
    assert.equal(logout.status, 200, `登出应成功（status=${logout.status}）`)

    const after = await httpRequest(BASE, '/api/test-results/summary', { token: tokens.superAdminLogout })
    assert.equal(after.status, 401, '登出后旧 token 必须 401（统一会话模型），而不是 403')
    assert.equal(after.body?.code, 'REVOKED', '401 必须来自统一会话吊销语义（code=REVOKED）')
  })

  /* ═════════ 9. 静态装配证据（无 DB 依赖，纯装配） ═════════ */

  test('静态装配：router.use(authenticateUser, requireReportPlatformAdmin) 位于全部 handler 之前', async () => {
    const mod = await import('../../routes/testResultRoutes.js')
    assert.equal(typeof mod.requireReportPlatformAdmin, 'function', '守卫必须可被独立引用')
    // 守卫行为（纯函数面）：guest / viewer / operator / manager / admin+schoolCode → 403；平台 admin → next
    const mkRes = () => {
      const res = { code: null, headers: {} }
      res.status = (c) => { res.code = c; return res }
      res.json = (b) => { res.body = b; return res }
      res.setHeader = (k, v) => { res.headers[k] = v; return res }
      return res
    }
    for (const u of [{ role: 'guest', schoolCode: SCHOOL }, { role: 'viewer', schoolCode: SCHOOL }, { role: 'operator', schoolCode: SCHOOL }, { role: 'manager', schoolCode: SCHOOL }, { role: 'admin', schoolCode: SCHOOL }]) {
      const res = mkRes()
      let passed = false
      mod.requireReportPlatformAdmin({ user: u }, res, () => { passed = true })
      assert.equal(passed, false, `${u.role}+schoolCode 不得放行`)
      assert.equal(res.code, 403)
      assert.equal(res.body.code, 'REPORT_FORBIDDEN')
      assert.equal(res.headers['Cache-Control'], 'no-store')
    }
    {
      const res = mkRes()
      let passed = false
      mod.requireReportPlatformAdmin({ user: { role: 'admin', schoolCode: null } }, res, () => { passed = true })
      assert.equal(passed, true, '平台授权角色（admin 无归属）必须放行')
    }
    // 装配顺序：前两层为 authenticateUser + requireReportPlatformAdmin，全部 route 层在其后
    const router = mod.createTestResultRoutes({ forTenant: () => ({}) }, undefined)
    const layers = router.stack
    const routeLayerIndexes = layers.map((l, i) => (l.route ? i : -1)).filter((i) => i >= 0)
    assert.ok(layers.length >= 2 && !layers[0].route && !layers[1].route, '前两层必须是中间件')
    assert.equal(layers[0].handle.name, 'authenticateUser', '第 1 层必须是认证（W1 统一会话模型）')
    assert.equal(layers[1].handle.name, 'requireReportPlatformAdmin', '第 2 层必须是报告授权守卫')
    assert.ok(Math.min(...routeLayerIndexes) > 1, '所有业务 handler 必须位于授权守卫之后')
  })
}
