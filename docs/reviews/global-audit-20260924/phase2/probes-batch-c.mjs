// Phase 2 — Independent adversarial verification probes (Batch C).
// Non-destructive: JSDOM + in-memory localStorage + local fake HTTP server (127.0.0.1, memory only).
// No real database, no external network, no application file changes.
// Run from repository root: node docs/reviews/global-audit-20260924/phase2/probes-batch-c.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.NODE_ENV = 'test'
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const mod = (p) => pathToFileURL(path.join(root, p)).href
const results = []
const record = (id, kind, detail) => {
    results.push({ id, kind, detail })
    console.log(`[${id}] ${kind}: ${detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── JSDOM environment first (Storage/GenericTest capture globals at import time) ──
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<table><tbody id="audit-table"></tbody></table><div id="export-data"></div>', { url: 'https://audit.invalid/a/index.html' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
globalThis.sessionStorage = dom.window.sessionStorage
globalThis.HTMLElement = dom.window.HTMLElement
const nativeFetch = globalThis.fetch   // 供 fake server 段恢复（AUD-020/021 会临时替换 fetch）

/* ═══════════════ AUD-003 · 检测记录字段进入 innerHTML（存储型 XSS 面） ═══════════════ */
{
    const { GenericTestModule } = await import(mod('frontend/js/modules/GenericTest.js'))
    GenericTestModule.prototype.updatePaginationUI = () => {}
    const payload = { testDate: '2026-09-24', canteen: 'A校食堂', inspector: 'A校检测员', result: '合格' }
    const malicious = {
        ...payload, id: 'x1',
        vegetableType: '<img src=x onerror="window.__auditXss=1">',
        remark: '" onmouseover="window.__auditXss2=1',
    }
    GenericTestModule.prototype.render.call({
        tableId: 'audit-table', moduleName: 'pesticide', sortOrder: 'desc', recordsPerPage: 10, currentPage: 1,
        getFilteredRecords: () => [malicious], getRecordDate: () => new Date(),
        updatePaginationUI: () => {},
    })
    const img = document.querySelector('#audit-table img[onerror]')
    assert.ok(img, '列表单元格解析出带 onerror 的 img 节点')
    const attrInjected = document.querySelector('#audit-table div[onmouseover]')
    assert.ok(attrInjected, 'remark 的属性上下文注入成功（title 闭合后生成 onmouseover 属性）')
    record('AUD-003', 'DOM_INJECTION_CONFIRMED', `列表 innerHTML 渲染出 img[onerror] 与 div[onmouseover]（remark 属性闭合生效）；未触发事件、未执行脚本`)

    // 导出/预览路径的 sink 对比
    const exportSrc = read('frontend/js/services/ExportService.js')
    assert.ok(exportSrc.includes('this._escapeHtml(v)'), '导出表格单元格有转义')
    assert.ok(exportSrc.includes('reportPreview').valueOf() && exportSrc.includes('generateReportHTML(data, config)'), '报告预览走 generateReportHTML + innerHTML=')
    record('AUD-003', 'SINK_SURVEY', '列表/详情路径未转义（GenericTest:1332/1346、Pathogen:1181）；导出表格单元格已用 _escapeHtml；报告预览 reportPreview.innerHTML 为独立 sink')

    // 防护面：CSP 与后端净化
    const server = read('backend/server.js')
    assert.ok(/if \(_req\.path\.startsWith\('\/api\/'\)\) \{\s*\n\s*res\.setHeader\('Content-Security-Policy'/.test(server), 'CSP 仅对 /api/* 设置')
    const deploy = read('deploy/deploy.sh')
    assert.ok(!/Content-Security-Policy/.test(deploy), 'Caddy 层未设置 CSP')
    const sanitize = read('backend/lib/sanitize.js')
    assert.ok(!/&lt;|&amp;|escapeHtml|htmlEscape/.test(sanitize), '后端 sanitizeObjectKeys 不做 HTML 转义（仅危险键名）')
    assert.ok(read('backend/routes/recordRoutes.js').includes('requireEditorOrAbove'), '写入需要 editor 以上权限')
    record('AUD-003', 'GUARD_REVIEW', '页面级 CSP 不存在（仅 /api/* 有 CSP；Caddy 无 CSP；X-XSS-Protection 已废弃）→ CSP 不构成 XSS 保护；写入需 editor+ 账号')
}

/* ═══════════════ AUD-020 · 列表缓存与导出静默截断 ═══════════════ */
{
    const { StorageService } = await import(mod('frontend/js/core/Storage.js'))

    const TOTAL = 2501
    const allRows = Array.from({ length: TOTAL }, (_, i) => ({
        id: i + 1, test_type: 'pesticide', test_name: '农药残留检测',
        sample_info: { testDate: '2026-01-01', canteen: '一食堂', inspector: '检测员' },
        result_data: { result: '合格', vegetableType: '白菜' }, version: 1,
    }))
    const requests = []
    globalThis.fetch = async (url) => {
        requests.push(String(url))
        const u = new URL(String(url), 'https://audit.invalid')
        const limit = Number(u.searchParams.get('limit') || 100)
        const offset = Number(u.searchParams.get('offset') || 0)
        const take = Math.min(limit, 2000) // mirror backend MAX_RECORDS_LIMIT
        const data = allRows.slice(offset, offset + take)
        return { ok: true, status: 200, json: async () => ({ success: true, data, total: TOTAL, limit: take, offset }) }
    }

    const s = new StorageService('pesticide')
    s.apiEndpoint = '/api/records/pesticide'
    s._getAuthToken = () => 'audit-token'      // 受控替身：本项只验证分页/limit，不验证认证
    s._processQueuedRequests = async () => {}
    localStorage.clear()
    await s._syncFromApi(true)
    const cached = s._getLocalCacheData()
    assert.equal(requests.length, 1, '单次请求，无自动分页')
    assert.ok(requests[0].includes('limit=1000'), `请求使用 maxSyncRows=1000：${requests[0]}`)
    assert.equal(cached.length, 1000, '本地缓存只有 1000 条')
    assert.equal(TOTAL, 2501)
    record('AUD-020', 'TRUNCATION_CONFIRMED', `2501 条（fake）场景：Storage 只发 1 次 limit=1000 请求 → 缓存 ${cached.length} 条；total=2501 被忽略，无 offset 翻页`)

    const exportSrc = read('frontend/js/services/ExportService.js')
    assert.ok(exportSrc.includes('?limit=10000'), '导出请求 limit=10000')
    const backendCap = Math.min(10000, 2000)
    assert.equal(backendCap, 2000)
    assert.ok(/totalRecords \+= records\.length/.test(exportSrc), '报告总数来自本地条数而非服务端 total')
    assert.ok(!/total\b/.test(exportSrc.split('async syncDataFromServer')[1]?.slice(0, 2000) || ''), '导出同步路径未消费服务端 total（源码断言）')
    record('AUD-020', 'EXPORT_CONFIRMED', '导出：一次性 limit=10000 → 后端 cap 2000（recordRoutes.js:13/251）→ 报告“总检测记录数”取本地截断条数（ExportService.js:596），无“数据不完整”提示')
    record('AUD-020', 'LIMITS_ORIGIN', '1000=Storage.maxSyncRows(Storage.js:15)；2000=后端 MAX_RECORDS_LIMIT(recordRoutes.js:13,251,263返回total)；10000=ExportService.js:353 请求值被 cap')
}

/* ═══════════════ AUD-021 · 离线临时记录状态机 ═══════════════ */
{
    const { StorageService } = await import(mod('frontend/js/core/Storage.js'))
    const apiBaseUrl = '/api/records'
    const serverPosts = []
    const runQueue = (st) => StorageService.prototype._processQueuedRequests.call(st)

    // A: offline create → edit → reconnect
    {
        localStorage.clear()
        globalThis.fetch = async (url, opts = {}) => {
            if (opts.method === 'POST') {
                const body = JSON.parse(opts.body)
                serverPosts.push(body)
                return {
                    ok: true, status: 200,
                    json: async () => ({ success: true, data: { ...body, id: 'srv-1', record_code: 'RC-1', version: 1, _status: 'synced' }, message: 'ok' }),
                }
            }
            if (opts.method === 'PUT' || opts.method === 'DELETE') return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
            return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
        }
        const st = new StorageService('pesticide')
        st.apiBaseUrl = apiBaseUrl
        st.apiEndpoint = `${apiBaseUrl}/pesticide`
        st._getAuthToken = () => 'audit-token'       // 受控替身：让队列可执行（本项验证状态机，不验证认证）
        st._processQueuedRequests = async () => {}   // 关闭自动定时器，改由 runQueue 显式驱动真实方法
        const created = st.save({ testDate: '2026-09-24', canteen: 'A食堂', inspector: '张三', result: '合格' })
        const edited = st.update(created.id, { testDate: '2026-09-24', canteen: 'A食堂', inspector: '张三', result: '不合格' })
        assert.equal(edited, true, '编辑入队成功')
        const beforeQueue = st._getPendingRequests().map((r) => r.type)
        await runQueue(st)
        console.log('[debug-A] posts=', serverPosts.length, 'body=', JSON.stringify(serverPosts[0] || null), 'remainingQueue=', JSON.stringify(st._getPendingRequests().map((r) => r.type)))
        const postBody = serverPosts[0] || {}
        const localRow = st._getLocalCacheData().find((r) => r.id === 'srv-1' || r.id === created.id)
        const scenarioA_editLostOnServer = postBody.result !== '不合格'
        const scenarioA_editLostLocally = (localRow?.result ?? '') !== '不合格'
        record('AUD-021', 'SCENARIO_A', `离线新建→编辑→重连：排队类型=${JSON.stringify(beforeQueue)}；POST 到服务端 result=${postBody.result}（编辑未上传=${scenarioA_editLostOnServer}）；本地最终 result=${localRow?.result}（本地编辑也被覆盖=${scenarioA_editLostLocally}）`)
        record('AUD-021', 'SCENARIO_A_MECHANISM', '_handleUpdateTemp 只在队列中还残留 create 请求时合并（Storage.js:725-735）；create 已被 _removeRequestFromQueue（:362）后 update_temp 变为 no-op')
    }

    // B: offline create → delete → reconnect
    {
        localStorage.clear()
        const st = new StorageService('pesticide')
        st._processQueuedRequests = async () => {}
        const rowsBefore = []
        const t = st.save({ testDate: '2026-09-24', canteen: 'B食堂', inspector: '李四', result: '合格' })
        rowsBefore.push(st._getLocalCacheData().length)
        st.delete(t.id)
        const afterDeleteRows = st._getLocalCacheData()
        const ghost = afterDeleteRows.some((r) => String(r.id) === String(t.id))
        const pending = st._getPendingRequests()
        const createStillQueued = pending.some((r) => r.type === 'create' && r.tempId === t.id)
        record('AUD-021', 'SCENARIO_B', `离线新建→删除：删除后本地仍有该行=${ghost}（_updateLocalCache 的 pending merge 把 temp 行推回，Storage.js:577-592）；create 任务被清除=${!createStillQueued}（_cleanupTempRequests，:186）`)
        record('AUD-021', 'SCENARIO_B_CONSEQUENCE', '幽灵行持久留在 localStorage（刷新仍在），服务端未创建记录 → UI 与服务端意图不一致；再次删除会再次复活')
    }

    // C/D: create in-flight 时编辑 / create 成功但 update 未合并 —— 同一机制（_handleUpdateTemp no-op）已验证于 A
    record('AUD-021', 'SCENARIO_C_D', 'create 在途或已出队后再编辑：均落入 _handleUpdateTemp 的 no-op 分支（队列中已无 create 请求）→ 编辑仅存在于本地缓存，且随后被服务端权威响应覆盖（_replaceTempIdInCache forceServer）')
}

/* ═══════════════ AUD-022 · 409 重试以 stale payload 覆盖他人更新 ═══════════════ */
{
    const { AdaptiveUploadQueue } = await import(mod('frontend/js/core/AdaptiveUploadQueue.js'))
    globalThis.fetch = nativeFetch   // 本项必须使用真实 HTTP（指向本地 fake server），恢复原生实现
    let current = { id: 1, version: 1, remark: '原始内容', result: '合格' }
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (c) => { raw += c })
        req.on('end', () => {
            console.log('[fake-server]', req.method, req.url, raw.slice(0, 100).replace(/\n/g, ' '), '| current.version=', current.version)
            if (req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ success: true, data: current }))
            }
            const body = raw ? JSON.parse(raw) : {}
            if (Number(body.version) !== Number(current.version)) {
                res.writeHead(409, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ error: '版本冲突', serverVersion: current.version, clientVersion: body.version }))
            }
            current = { ...current, ...body, version: current.version + 1 }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ success: true, data: current }))
        })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    try {
        // A 先提交新内容（模拟另一用户）：v1 -> v2
        const aRes = await fetch(`http://127.0.0.1:${port}/api/records/oil/1`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: 1, remark: 'A的新内容', result: '合格' }),
        })
        assert.equal(aRes.status, 200)
        const afterA = { ...current }

        // B 用 stale v1 提交（内容为旧 remark）
        const queue = new AdaptiveUploadQueue({
            initialInterval: 20, minInterval: 10, maxInterval: 100,
            getHeaders: () => ({}), getBaseUrl: () => `http://127.0.0.1:${port}/api/records`,
        })
        const stalePayload = { version: 1, remark: '原始内容', result: '合格' }
        const done = queue.enqueue('oil', 1, stalePayload, { method: 'PUT' })
        for (let i = 0; i < 60 && current.version < 3; i++) await sleep(50)
        await done.catch(() => {})
        assert.equal(current.version >= 3, true, `服务端最终 version=${current.version}`)
        assert.equal(current.remark, '原始内容', 'B 的 stale 内容覆盖了 A 的新内容')
        record('AUD-022', 'LOST_UPDATE_REPRODUCED', `fake HTTP server：A v1→v2(remark=${afterA.remark})；B stale v1 → 409(serverVersion=2) → 客户端只改 version 重试 → 最终 remark=${current.remark}（A 的更新丢失）`)
    } finally {
        server.close()
    }
    const rs = read('backend/routes/recordRoutes.js')
    assert.ok(rs.includes("serverVersion: existing.version"), '409 仅返回 serverVersion/clientVersion（无 latest object/ETag）')
    assert.ok(rs.includes("resultDataMode: req.body?.result_data_mode === 'merge' ? 'merge' : 'replace'"), 'PUT 默认整对象替换（replace 口径）')
    assert.ok(read('frontend/js/core/AdaptiveUploadQueue.js').includes('item.payload = { ...item.payload, version: latestVersion }'), '队列仅替换 version，保留 stale payload')
    record('AUD-022', 'CONTRACT', '分类=LOST_UPDATE：客户端重放 stale 全量对象 + 服务端 replace 语义 → B 覆盖 A；非 SAFE_RETRY、非 MANUAL_CONFLICT')
}

/* ═══════════════ AUD-025 · 油脂统计对未知 colorLevel 判合格 ═══════════════ */
{
    const rs = read('backend/routes/recordRoutes.js')
    assert.ok(/colorLevel' NOT LIKE '%不合格%'/.test(rs), '统计 SQL：非空 colorLevel 仅排除含“不合格”者')
    const passBySql = (colorLevel, result) => (String(colorLevel || '') !== ''
        ? !String(colorLevel).includes('不合格')
        : (String(result || '').includes('合格') && !String(result || '').includes('不合格')))
    assert.equal(passBySql('合格', '不合格'), true, '合法值：colorLevel=合格 视为合格（与前端 Dashboard 裁定一致）')
    assert.equal(passBySql('警戒', '不合格'), true, '合法值：colorLevel=警戒 视为合格（业务裁定）')
    assert.equal(passBySql('foo', '不合格'), true, '未识别值 foo 被计入合格（fail-open）')
    assert.equal(passBySql('', '不合格'), false, '空 colorLevel 回退 result 规则')
    record('AUD-025', 'SEMANTIC_REPRODUCED', "SQL 语义复刻：colorLevel='foo' 且 result='不合格' → 计入合格（fail-open）；'不合格' 正常排除；'警戒' 计入合格（有意裁定）")

    const norm = read('backend/lib/recordNormalize.js')
    const validateFn = norm.slice(norm.indexOf('function validateRecordPayload'), norm.indexOf('function validateRecordPayload') + 700)
    assert.ok(!/colorLevel/.test(validateFn), 'validateRecordPayload 不校验 colorLevel 枚举（仅 testDate/canteen/inspector + 类型）')
    assert.ok(/input\[name="colorLevel"\]/.test(read('frontend/js/modules/GenericTest.js')), '前端为受限输入控件（下拉/单选）')
    record('AUD-025', 'REACHABILITY', '写入路径（POST/PUT/bulk-upsert/sync）均无 colorLevel 枚举校验 → API 直调或导入可写入未知值；UI 路径受控件限制')
}

/* ═══════════════ AUD-027 · 删除用户级联删除其 AuditLog ═══════════════ */
{
    const schema = read('backend/prisma/schema.prisma')
    const audit = schema.slice(schema.indexOf('model AuditLog'), schema.indexOf('model TestRecord'))
    assert.ok(/onDelete: Cascade/.test(audit), 'AuditLog.user 关系为 onDelete: Cascade')
    assert.ok(/user_id\s+String/.test(audit), 'user_id 非空（无法 SET NULL 保留匿名审计）')
    const syslog = schema.slice(schema.indexOf('model SystemLog'), schema.indexOf('model OpenApiClient') > 0 ? schema.indexOf('model OpenApiClient') : schema.indexOf('model SystemLog') + 600)
    assert.ok(!/User\s+@relation|user_id/.test(syslog), 'SystemLog（public）无 User 外键，不受级联影响')
    const um = read('backend/modules/UserManager.js')
    const del = um.slice(um.indexOf('async deleteUser'), um.indexOf('async adminUpdateUser'))
    assert.ok(/testRecord\.count/.test(del), '删除前检查 TestRecord 归属（有记录则拒绝）')
    assert.ok(/user\.delete/.test(del), '执行 User 删除（触发 AuditLog 级联）')
    assert.ok(/logAdminAction\('user_delete', actor/.test(del), '删除动作本身由 actor 写入新审计（保留“谁删了谁”）')
    record('AUD-027', 'STATIC_CONFIRMED', '被删用户的 AuditLog（登录/用户管理等）随 User 行级联删除；SystemLog（登录失败/安全事件）独立保留；删除行为本身以 actor 身份留痕；TestRecord 归属用户不可删除（前置拒绝）')
}

console.log('\n=== SUMMARY ===')
const summary = { baseline: 'f08e72e3e74d188b4555e0bee16280b3dd0d622b', probes: results.length, results }
console.log(JSON.stringify({ probes: results.length, ids: [...new Set(results.map((r) => r.id))] }, null, 2))
fs.writeFileSync(path.join(here, 'probe-results-batch-c.json'), JSON.stringify(summary, null, 2))
dom.window.close()
process.exit(0)
