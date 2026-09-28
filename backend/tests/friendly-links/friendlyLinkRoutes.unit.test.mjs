// P3-FRIENDLY-LINKS（2026-09-28）路由级单测（无 DB）：字段口径 / 外链安全校验 / 公开投影 /
// 管理面 CRUD 与重排 / 点击计数 / 审计写入 / 挂载顺序守卫。
//
// 说明：本套用例走"路由 handler 直接调用"（与 tests/records/route-write-paths.test.mjs 同范式），
//   不连数据库、不发 HTTP；真实 HTTP 集成留给隔离库套件。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAdminFriendlyLinkRoutes } from '../../routes/adminFriendlyLinkRoutes.js'
import { createPublicFriendlyLinkRoutes } from '../../routes/publicFriendlyLinkRoutes.js'
import {
  FRIENDLY_LINK_MAX,
  normalizeFriendlyLinkFields,
  normalizeFriendlyLinkIcon,
  normalizeFriendlyLinkUrl,
  toPublicFriendlyLink,
} from '../../lib/friendlyLinks.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8')

// ───────────────────────── 测试脚手架 ─────────────────────────

/** 取出 router 上指定 method+path 的最终 handler（跳过中间件）。 */
function handlerOf(router, method, routePath) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle
    }
  }
  throw new Error(`路由未找到：${method.toUpperCase()} ${routePath}`)
}

function makeRes() {
  return {
    statusCode: 200, body: null, headers: {}, ended: false,
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
    set(k, v) { this.headers[k] = v; return this },
    end() { this.ended = true; return this },
  }
}

async function invoke(handler, {
  params = {}, body = {}, query = {},
  user = { userId: 'su-1', username: 'super', role: 'admin', schoolCode: null }, ip = '127.0.0.1',
} = {}) {
  const res = makeRes()
  await handler({ params, body, query, user, ip, headers: {} }, res)
  return res
}

/** 最小 prisma 桩：仅实现被用到的模型方法 + systemLog.create（审计）。 */
function makePrismaStub(seed = [], { failFindMany = false, failVisitUpdate = false } = {}) {
  const rows = seed.map((r, i) => ({
    id: r.id, name: r.name, url: r.url, description: r.description ?? null, icon: r.icon ?? null,
    group_name: r.group_name ?? null, sort_order: r.sort_order ?? (i + 1) * 10, status: r.status || 'enabled',
    open_in_new_tab: r.open_in_new_tab !== false, visit_count: r.visit_count ?? 0, last_visit_at: r.last_visit_at ?? null,
    created_by: r.created_by ?? null, created_at: r.created_at || new Date(2026, 0, i + 1), updated_at: new Date(),
  }))
  const auditLog = []
  const stub = {
    rows, auditLog,
    friendlyLink: {
      async findMany({ where, orderBy } = {}) {
        if (failFindMany) throw new Error('relation "FriendlyLink" does not exist')
        let out = rows.slice()
        if (where?.status) out = out.filter((r) => r.status === where.status)
        if (where?.id?.in) out = out.filter((r) => where.id.in.includes(r.id))
        void orderBy
        return out.sort((a, b) => (a.sort_order - b.sort_order) || (a.created_at - b.created_at))
      },
      async findFirst({ orderBy } = {}) {
        void orderBy
        if (!rows.length) return null
        return rows.slice().sort((a, b) => b.sort_order - a.sort_order)[0]
      },
      async findUnique({ where }) { return rows.find((r) => r.id === where.id) || null },
      async count() { return rows.length },
      async create({ data }) {
        const row = { ...data, id: `fl_new_${rows.length + 1}`, visit_count: 0, last_visit_at: null, created_at: new Date(), updated_at: new Date() }
        rows.push(row)
        return row
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id)
        if (!row) throw new Error('record not found')
        if (failVisitUpdate && data.visit_count) throw new Error('update failed')
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] || 0) + v.increment
          else row[k] = v
        }
        row.updated_at = new Date()
        return row
      },
      async delete({ where }) {
        const i = rows.findIndex((r) => r.id === where.id)
        if (i < 0) throw new Error('record not found')
        return rows.splice(i, 1)[0]
      },
    },
    systemLog: { async create({ data }) { auditLog.push(data); return data } },
    async $transaction(ops) { return Promise.all(ops) },
  }
  return stub
}

const ADMIN = { authenticateUser: (req, res, next) => next(), requirePlatformSuperAdmin: (req, res, next) => next() }

// ───────────────────────── ① 字段口径与安全校验 ─────────────────────────

test('① 外链安全校验：仅 http/https、禁伪协议/凭证/空白（唯一事实源）', () => {
  assert.equal(normalizeFriendlyLinkUrl('https://a.example/x').ok, true)
  assert.equal(normalizeFriendlyLinkUrl('http://a.example').ok, true)
  // 伪协议 / 相对路径 / 协议相对 / 空值一律拒绝
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd', '/help.html', '//evil.example', '', '   ']) {
    assert.equal(normalizeFriendlyLinkUrl(bad).ok, false, `应拒绝：${bad}`)
  }
  // 携带凭证 / 空白 / 控制字符 / 超长
  assert.equal(normalizeFriendlyLinkUrl('https://user:pass@a.example/').ok, false)
  assert.equal(normalizeFriendlyLinkUrl('https://a.example/a b').ok, false)
  assert.equal(normalizeFriendlyLinkUrl('https://a.example/\nX-Injected: 1').ok, false)
  assert.equal(normalizeFriendlyLinkUrl('https://a.example/' + 'a'.repeat(600)).ok, false)
  // 规范化：补全根路径
  assert.equal(normalizeFriendlyLinkUrl('https://foodsafety.digifluidic.com').value, 'https://foodsafety.digifluidic.com/')
})

test('① 图标类名白名单：拒绝任意 class/属性注入，空值回退 null', () => {
  assert.equal(normalizeFriendlyLinkIcon('fas fa-link').value, 'fas fa-link')
  assert.equal(normalizeFriendlyLinkIcon('  fa-solid   fa-shield-alt ').value, 'fa-solid fa-shield-alt')
  assert.equal(normalizeFriendlyLinkIcon('').value, null)
  assert.equal(normalizeFriendlyLinkIcon(null).value, null)
  for (const bad of ['fa-link', 'fas', 'fas fa-link" onload="x', 'fas fa-link onclick=alert(1)', '<img src=x>', 'fas fa-Link']) {
    assert.equal(normalizeFriendlyLinkIcon(bad).ok, false, `应拒绝：${bad}`)
  }
})

test('① 写入字段：新建必填 / 更新 merge 语义 / 枚举与范围', () => {
  const missing = normalizeFriendlyLinkFields({ description: 'x' }, { requireCore: true })
  assert.equal(missing.ok, false)
  assert.equal(missing.errors.length, 2) // name + url

  const ok = normalizeFriendlyLinkFields({ name: ' 校园食安卫士 ', url: 'https://a.example', sortOrder: '20', status: 'enabled', openInNewTab: false }, { requireCore: true })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.name, '校园食安卫士')
  assert.equal(ok.value.sort_order, 20)
  assert.equal(ok.value.open_in_new_tab, false)

  // 局部更新：未出现的键不参与更新（不会被置空）
  const partial = normalizeFriendlyLinkFields({ status: 'disabled' })
  assert.deepEqual(Object.keys(partial.value), ['status'])

  // 空描述 → null（显式清空）；空名称 → 非法（链接不允许无名）
  assert.equal(normalizeFriendlyLinkFields({ description: '   ' }).value.description, null)
  assert.equal(normalizeFriendlyLinkFields({ name: '  ' }).ok, false)
  assert.equal(normalizeFriendlyLinkFields({ sortOrder: 10000 }).ok, false)
  assert.equal(normalizeFriendlyLinkFields({ status: 'archived' }).ok, false)
  assert.equal(normalizeFriendlyLinkFields({ openInNewTab: 'true' }).ok, false)
})

test('① 公开投影：不外泄管理字段（created_by / status / 计数 / 时间戳）', () => {
  const pub = toPublicFriendlyLink({
    id: 'fl_1', name: 'n', url: 'https://a.example/', description: null, icon: null,
    group_name: 'g', open_in_new_tab: false, status: 'enabled', visit_count: 9,
    last_visit_at: new Date(), created_by: 'su-1', created_at: new Date(), updated_at: new Date(),
  })
  assert.deepEqual(Object.keys(pub).sort(), ['description', 'groupName', 'icon', 'id', 'name', 'openInNewTab', 'url'])
  assert.equal(pub.icon, 'fas fa-link')     // 缺省图标
  assert.equal(pub.openInNewTab, false)
  assert.equal(pub.description, '')
})

// ───────────────────────── ② 管理面（超管） ─────────────────────────

test('② 列表：返回 items + summary（总数/启用/停用/累计访问）', async () => {
  const prisma = makePrismaStub([
    { id: 'a', name: 'A', url: 'https://a.example/', visit_count: 3 },
    { id: 'b', name: 'B', url: 'https://b.example/', status: 'disabled', visit_count: 4 },
  ])
  const res = await invoke(handlerOf(createAdminFriendlyLinkRoutes({ prisma, ...ADMIN }), 'get', '/'))
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.data.items.length, 2)
  assert.deepEqual(res.body.data.summary, { total: 2, enabled: 1, disabled: 1, visits: 7, max: FRIENDLY_LINK_MAX })
})

test('② 新建：默认追加到末尾 + 默认启用 + 写审计；伪协议 400；超上限 400', async () => {
  const prisma = makePrismaStub([{ id: 'a', name: 'A', url: 'https://a.example/', sort_order: 10 }])
  const router = createAdminFriendlyLinkRoutes({ prisma, ...ADMIN })

  const created = await invoke(handlerOf(router, 'post', '/'), { body: { name: '新链接', url: 'https://new.example/x' } })
  assert.equal(created.statusCode, 200)
  assert.equal(created.body.data.sort_order, 20, '缺省排序值 = 当前最大值 + 10（排到末尾）')
  assert.equal(created.body.data.status, 'enabled')
  assert.equal(prisma.auditLog.length, 1, '新建必须写平台级审计')
  assert.match(prisma.auditLog[0].message, /^\[admin-audit\] friendly_link\.create/)

  const bad = await invoke(handlerOf(router, 'post', '/'), { body: { name: 'X', url: 'javascript:alert(1)' } })
  assert.equal(bad.statusCode, 400)
  assert.match(bad.body.error, /http/)

  const full = makePrismaStub(Array.from({ length: FRIENDLY_LINK_MAX }, (_, i) => ({ id: `f${i}`, name: `n${i}`, url: `https://e${i}.example/` })))
  const capped = await invoke(handlerOf(createAdminFriendlyLinkRoutes({ prisma: full, ...ADMIN }), 'post', '/'), { body: { name: 'X', url: 'https://x.example/' } })
  assert.equal(capped.statusCode, 400)
  assert.match(capped.body.error, /上限/)
})

test('② 更新：merge 语义（只改提交字段）+ 404 分支 + 空更新 400', async () => {
  const prisma = makePrismaStub([{ id: 'a', name: 'A', url: 'https://a.example/', description: 'old', icon: 'fas fa-link' }])
  const router = createAdminFriendlyLinkRoutes({ prisma, ...ADMIN })

  const res = await invoke(handlerOf(router, 'put', '/:id'), { params: { id: 'a' }, body: { status: 'disabled' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.data.status, 'disabled')
  assert.equal(res.body.data.name, 'A', '未提交字段保持原值')
  assert.equal(res.body.data.description, 'old')

  assert.equal((await invoke(handlerOf(router, 'put', '/:id'), { params: { id: 'nope' }, body: { status: 'enabled' } })).statusCode, 404)
  assert.equal((await invoke(handlerOf(router, 'put', '/:id'), { params: { id: '../../etc' }, body: { status: 'enabled' } })).statusCode, 404, '非法 id 形态不得进入查询')
  assert.equal((await invoke(handlerOf(router, 'put', '/:id'), { params: { id: 'a' }, body: {} })).statusCode, 400)
})

test('② 重排：全量顺序回写 10/20/30；缺 id / 含未知 id / 重复 / 空数组一律 400', async () => {
  const prisma = makePrismaStub([
    { id: 'a', name: 'A', url: 'https://a.example/' },
    { id: 'b', name: 'B', url: 'https://b.example/' },
    { id: 'c', name: 'C', url: 'https://c.example/' },
  ])
  const router = createAdminFriendlyLinkRoutes({ prisma, ...ADMIN })

  const ok = await invoke(handlerOf(router, 'post', '/reorder'), { body: { ids: ['c', 'a', 'b'] } })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(prisma.rows.map((r) => [r.id, r.sort_order]).sort(), [['a', 20], ['b', 30], ['c', 10]])
  assert.match(prisma.auditLog.at(-1).message, /^\[admin-audit\] friendly_link\.reorder/)

  const path0 = handlerOf(router, 'post', '/reorder')
  assert.equal((await invoke(path0, { body: {} })).statusCode, 400)
  assert.equal((await invoke(path0, { body: { ids: [] } })).statusCode, 400)
  assert.equal((await invoke(path0, { body: { ids: ['a', 'a'] } })).statusCode, 400)
  assert.equal((await invoke(path0, { body: { ids: ['a', 'zzz'] } })).statusCode, 400)
  assert.equal((await invoke(path0, { body: { ids: ['a', 1] } })).statusCode, 400)
})

test('② 删除：硬删 + 审计保留被删快照；不存在 404', async () => {
  const prisma = makePrismaStub([{ id: 'a', name: 'A', url: 'https://a.example/', visit_count: 5 }])
  const router = createAdminFriendlyLinkRoutes({ prisma, ...ADMIN })

  const res = await invoke(handlerOf(router, 'delete', '/:id'), { params: { id: 'a' } })
  assert.equal(res.statusCode, 200)
  assert.equal(prisma.rows.length, 0)
  assert.match(prisma.auditLog.at(-1).message, /^\[admin-audit\] friendly_link\.delete/)
  assert.equal(prisma.auditLog.at(-1).context.url, 'https://a.example/')

  assert.equal((await invoke(handlerOf(router, 'delete', '/:id'), { params: { id: 'a' } })).statusCode, 404)
})

// ───────────────────────── ③ 公开面（免鉴权） ─────────────────────────

test('③ 公开列表：仅启用项、按 sort_order 升序、字段最小化', async () => {
  const prisma = makePrismaStub([
    { id: 'b', name: 'B', url: 'https://b.example/', sort_order: 20 },
    { id: 'a', name: 'A', url: 'https://a.example/', sort_order: 10 },
    { id: 'x', name: 'X', url: 'https://x.example/', sort_order: 5, status: 'disabled' },
  ])
  const router = createPublicFriendlyLinkRoutes({ prisma })
  const res = await invoke(handlerOf(router, 'get', '/'))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.data.items.map((i) => i.id), ['a', 'b'])
  assert.equal(res.headers['Cache-Control'], 'no-store')
  for (const item of res.body.data.items) {
    assert.equal(item.status, undefined)
    assert.equal(item.visit_count, undefined)
    assert.equal(item.created_by, undefined)
  }
})

test('③ 公开列表：DB/表异常时 503 且不泄漏内部错误文案（登录页据此回退兜底链接）', async () => {
  const prisma = makePrismaStub([], { failFindMany: true })
  const res = await invoke(handlerOf(createPublicFriendlyLinkRoutes({ prisma }), 'get', '/'))
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.success, false)
  assert.equal(res.body.error, '友情链接暂不可用')
  assert.ok(!JSON.stringify(res.body).includes('relation'))
})

test('③ 点击计数：仅启用项 +1（含 last_visit_at）；停用/不存在/非法 id 均 204 且不写库', async () => {
  const prisma = makePrismaStub([
    { id: 'a', name: 'A', url: 'https://a.example/', visit_count: 1 },
    { id: 'x', name: 'X', url: 'https://x.example/', status: 'disabled', visit_count: 7 },
  ])
  const router = createPublicFriendlyLinkRoutes({ prisma })
  const visit = handlerOf(router, 'post', '/:id/visit')

  const ok = await invoke(visit, { params: { id: 'a' } })
  assert.equal(ok.statusCode, 204)
  assert.equal(ok.ended, true)
  assert.equal(prisma.rows.find((r) => r.id === 'a').visit_count, 2)
  assert.ok(prisma.rows.find((r) => r.id === 'a').last_visit_at instanceof Date)

  assert.equal((await invoke(visit, { params: { id: 'x' } })).statusCode, 204)
  assert.equal(prisma.rows.find((r) => r.id === 'x').visit_count, 7, '停用项不得计数')

  const tbody = prisma.rows.find((r) => r.id === 'a').visit_count
  assert.equal((await invoke(visit, { params: { id: 'ghost' } })).statusCode, 204)
  assert.equal((await invoke(visit, { params: { id: '..%2F' } })).statusCode, 204)
  assert.equal(prisma.rows.find((r) => r.id === 'a').visit_count, tbody)

  // 计数写失败也必须是 204（绝不能因统计失败影响用户跳转）
  const failing = makePrismaStub([{ id: 'a', name: 'A', url: 'https://a.example/' }], { failVisitUpdate: true })
  const res = await invoke(handlerOf(createPublicFriendlyLinkRoutes({ prisma: failing }), 'post', '/:id/visit'), { params: { id: 'a' } })
  assert.equal(res.statusCode, 204)
})

// ───────────────────────── ④ 接线守卫（静态） ─────────────────────────

test('④ 挂载顺序：两条路由必须在 recognitionRoutes（全局 authenticateUser）之前', () => {
  const src = read('backend/server.js')
  // ⚠️ 必须按"行首真实代码"匹配：同文件注释里也会出现带反引号的 `app.use('/api', recognitionRoutes)`
  // 字样（挂载顺序说明），用普通 indexOf 会命中注释而误判顺序。
  const iAdmin = src.search(/^\s*app\.use\('\/api\/admin\/friendly-links'/m)
  const iPublic = src.search(/^\s*app\.use\('\/api\/public\/friendly-links'/m)
  const iRecognition = src.search(/^\s*app\.use\('\/api', recognitionRoutes\)/m)
  assert.ok(iAdmin > 0 && iPublic > 0, '两条友情链接路由必须显式挂载')
  assert.ok(iAdmin < iRecognition && iPublic < iRecognition,
    '必须挂载在 recognitionRoutes 之前，否则 /api/public/* 会被全局 authenticateUser 拦成 401')

  const adminSrc = read('backend/routes/adminFriendlyLinkRoutes.js')
  assert.match(adminSrc, /router\.use\(authenticateUser, requirePlatformSuperAdmin\)/, '管理面必须同时要求登录 + 平台超管')
  const publicSrc = read('backend/routes/publicFriendlyLinkRoutes.js')
  // 精确判据（注释里会提到 authenticateUser 这个挂载顺序陷阱，不能用裸关键词判定）：
  // 公开面工厂**只接受** { prisma, rateLimit }，拿不到鉴权中间件；也不注册 router.use(鉴权)。
  assert.match(publicSrc, /export function createPublicFriendlyLinkRoutes\(\{\s*prisma,\s*rateLimit\s*\}\)/,
    '公开面工厂只接受 prisma + rateLimit（不得注入 authenticateUser）')
  assert.ok(!/router\.use\(\s*authenticateUser/.test(publicSrc), '公开面不得注册鉴权中间件')
  assert.ok(!/res\.redirect|\.redirect\(/.test(publicSrc), '公开面不得做跳转（避免开放重定向面）')
})

test('④ 登录页：保留兜底链接 + 动态渲染走 textContent（不拼 innerHTML）', () => {
  const html = read('frontend/pages/login.html')
  assert.ok(/id="friendlyLinks"/.test(html), '登录页必须有友情链接容器')
  assert.ok(/foodsafety\.digifluidic\.com/.test(html), '兜底链接必须保留原域名')
  assert.ok(/data-fallback="1"/.test(html), '兜底链接需可识别')

  const js = read('frontend/js/modules/loginPage.js')
  assert.ok(/\/api\/public\/friendly-links/.test(js), '登录页必须读取后台配置')
  assert.ok(/label\.textContent = '友情链接：'/.test(js), '名称必须用 textContent 写入（XSS 防线）')
  assert.ok(!/friendlyLinks[\s\S]{0,400}innerHTML\s*=/.test(js), '友情链接渲染不得使用 innerHTML')
  assert.ok(/u\.protocol !== 'http:'/.test(js), '前端渲染期需再校验协议（纵深防御）')
})

test('④ 超管控制台：菜单项 / 视图容器 / 模块装配三处齐备且视图名符合 hash 路由约束', () => {
  const html = read('frontend/pages/admin-schools.html')
  assert.ok(/data-view="links"/.test(html), '必须存在 data-view="links" 的菜单项')
  assert.ok(/id="adminViewLinks"/.test(html), '必须存在 adminViewLinks 视图容器')
  assert.ok(/initFriendlyLinksView\(\{ API_BASE, authHeaders, notify: showNotice \}\)/.test(html), '必须装配视图模块')
  // sidebar.js 的 hash 解析正则为 /view=([a-z]+)/ —— 视图名只能纯小写字母（不得含 - 或 _）
  const viewNames = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1])
  assert.ok(viewNames.length >= 9, `data-view 数量异常：${viewNames.length}`)
  for (const v of viewNames) assert.ok(/^[a-z]+$/.test(v), `视图名必须为纯小写字母（hash 路由约束）：${v}`)
})
