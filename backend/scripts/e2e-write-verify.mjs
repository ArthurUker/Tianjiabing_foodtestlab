#!/usr/bin/env node
// 端到端写入路径验证（**会写生产库，默认禁用**）
//
// 用途：验证"写入路径的归一化行为"是否与预期一致 —— 例如 2026-09-24 的
// 「餐具记录级 result 按点位补写」（洗涤剂残留记录只写 atpPoints[].res 的场景）。
//
// 做法（全部走**真实 HTTP**，不是绕过路由直接写库）：
//   建临时用户 → POST /api/user/login 取 JWT → POST /api/records/<table> 建记录
//   → 回读 DB 断言 → 删除临时记录与临时用户（其 AuditLog 随用户级联删除）→ 复核计数复原
//
// 用法（**必须显式授权写入**）：
//   cd /opt/foodsentinel/backend && set -a && . ./.env && set +a \
//     && ALLOW_PROD_WRITE=1 node scripts/e2e-write-verify.mjs
//   可用环境变量覆盖目标：E2E_SCHOOL=test（默认 test）、E2E_BASE=http://127.0.0.1:3002
//
// 安全边界：
//   · 只操作 **school_test**（平台测试租户），不会碰真实学校；
//   · 临时数据在 finally 中强制清理（记录 / 用户 / 审计日志），并复核残留为 0；
//   · 不打印密码与 token；先断库名再动手；
//   · 只读模式下（不加 ALLOW_PROD_WRITE=1）直接拒绝执行。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const bcryptjs = require('bcryptjs')

if (process.env.ALLOW_PROD_WRITE !== '1') {
  console.error('拒绝执行：本脚本会写生产库（临时数据，结束即清理）。确认后请设置 ALLOW_PROD_WRITE=1')
  process.exit(2)
}

const SCHOOL = process.env.E2E_SCHOOL || 'test'
const SCHEMA = `school_${SCHOOL}`
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3002'
const URL_ = process.env.DATABASE_URL
if (!URL_) { console.error('缺少 DATABASE_URL（请在 backend 目录下 source .env）'); process.exit(2) }
const tenantUrl = `${URL_}${URL_.includes('?') ? '&' : '?'}schema=${SCHEMA}`
const USERNAME = `e2e-verify-${Date.now().toString(36)}`
const PASSWORD = `Tmp!${Math.random().toString(36).slice(2, 12)}`
const DAY = new Date().toISOString().slice(0, 10)
const MARK = 'E2E写入路径验证（临时）'

const pub = new PrismaClient()
const tenant = new PrismaClient({ datasources: { db: { url: tenantUrl } } })
const createdIds = []
let userId = null
let failed = 0
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`) }

async function main() {
  const db = (await pub.$queryRawUnsafe('SELECT current_database() AS db'))[0].db
  console.log(`数据库 = ${db} | 租户 = ${SCHEMA} | 时间 = ${new Date().toISOString()}`)

  // ① 临时用户（登录时 school_code 必须与请求的 schoolCode 一致，否则被防伪登录拦截）
  const user = await tenant.user.create({
    data: {
      username: USERNAME, password_hash: bcryptjs.hashSync(PASSWORD, 10), full_name: 'E2E 写入验证（临时）',
      role: 'manager', status: 'active', school_code: SCHOOL, must_change_password: false,
    },
  })
  userId = user.id

  // ② 真实登录
  const loginRes = await fetch(`${BASE}/api/user/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD, schoolCode: SCHOOL }),
  })
  const loginBody = await loginRes.json().catch(() => ({}))
  const token = loginBody.token || loginBody.accessToken
  check('真实 POST /api/user/login 拿到 JWT', loginRes.status === 200 && Boolean(token), `HTTP ${loginRes.status}`)
  if (!token) return

  const post = async (body) => {
    const r = await fetch(`${BASE}/api/records/tableware`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => ({}))
    if (j?.data?.id) createdIds.push(j.data.id)
    return { status: r.status, body: j }
  }

  // ③ 形态 A：扁平载荷（Web 表单的实际形态），合格点位
  const a = await post({
    test_type: 'tableware', test_name: '餐具洁净度检测',
    testDate: DAY, canteen: MARK, inspector: 'E2E验证',
    rluValue: '0.05',
    atpPoints: [{ loc: '不锈钢餐具', rlu: '0.05', res: '合格 (≤0.1 mg/L)', testType: 'detergent' }],
  })
  check('形态 A（扁平载荷，同 Web 表单）创建成功', a.status === 200 && Boolean(a.body?.data?.id), `HTTP ${a.status}`)

  // ③b 形态 B：result_data 包裹（App/同步的实际形态），不合格点位
  const b = await post({
    test_type: 'tableware', test_name: '餐具洁净度检测',
    testDate: DAY, canteen: MARK, inspector: 'E2E验证',
    result_data: { result: '', rluValue: '0.4', atpPoints: [{ loc: '不锈钢餐具', rlu: '0.4', res: '不合格 (>0.1 mg/L)', testType: 'detergent' }] },
  })
  check('形态 B（result_data 包裹，同 App/同步）创建成功', b.status === 200 && Boolean(b.body?.data?.id), `HTTP ${b.status}`)

  // ④ 回读 DB：记录级 result 必须由服务端按点位补写
  for (const [label, id, expect] of [['形态 A（合格）', a.body?.data?.id, '合格 (≤0.1 mg/L)'], ['形态 B（不合格）', b.body?.data?.id, '不合格 (>0.1 mg/L)']]) {
    if (!id) continue
    const row = await tenant.testRecord.findUnique({ where: { id } })
    const got = String(row?.result_data?.result ?? '')
    check(`${label}：落库 result 已按点位补写`, got === expect, `期望 "${expect}"，实际 "${got}"`)
    check(`${label}：点位明细保持原样`, (row?.result_data?.atpPoints || []).length === 1, JSON.stringify(row?.result_data?.atpPoints?.[0]?.res))
  }
}

try {
  await main()
} catch (e) {
  failed++
  console.error('ERROR:', e?.message || e)
} finally {
  if (createdIds.length) await tenant.testRecord.deleteMany({ where: { id: { in: createdIds } } }).catch((e) => console.error('删记录失败:', e.message))
  if (userId) await tenant.user.delete({ where: { id: userId } }).catch((e) => console.error('删用户失败:', e.message))
  const strays = await tenant.testRecord.count({ where: { sample_info: { path: ['canteen'], equals: MARK } } })
  const leftUser = userId ? await tenant.user.count({ where: { id: userId } }) : 0
  const leftLog = userId ? await tenant.auditLog.count({ where: { user_id: userId } }) : 0
  console.log(`\n=== 清理复核：临时记录 ${strays} / 临时用户 ${leftUser} / 其审计日志 ${leftLog}（均应为 0）===`)
  if (strays || leftUser || leftLog) failed++
  console.log(failed ? `❌ 未通过项 ${failed}` : '✅ 端到端验证通过，环境已复原')
  await pub.$disconnect()
  await tenant.$disconnect()
  process.exit(failed ? 1 : 0)
}
