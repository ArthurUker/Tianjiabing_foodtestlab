// Non-destructive audit probes: fake databases, local HTTP, in-memory browser storage.
// Run from repository root: node docs/reviews/global-audit-20260924/probes.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { JSDOM } from 'jsdom'
import idempotency from '../../../backend/middleware/idempotencyMiddleware.js'
import { createRecordRoutes } from '../../../backend/routes/recordRoutes.js'
import { createSessionRoutes } from '../../../backend/routes/sessionRoutes.js'
import { createUserRoutes } from '../../../backend/routes/userRoutes.js'
import { createAuthMiddleware, _resetRecheckFailStateForTest } from '../../../backend/middleware/authMiddleware.js'
import { schemaNameOf } from '../../../backend/lib/tenantClient.js'
import { buildRecordWriteData, normalizeWriteJson } from '../../../backend/lib/recordNormalize.js'
import { updateFieldOption } from '../../../backend/lib/fieldOptionService.js'
import { rewriteSchemaNames } from '../../../backend/lib/restoreSqlUtils.js'
import { scanAndAlertSecurityEvents } from '../../../backend/lib/securityAlerts.js'
import { AdaptiveUploadQueue } from '../../../frontend/js/core/AdaptiveUploadQueue.js'

process.env.NODE_ENV = 'test'
const findings = []
const observe = (id, evidence) => findings.push({ id, evidence })

// Mirrors production's preceding /api recognition authentication, then record router.
const app = express()
app.use(express.json())
app.use((req, res, next) => {
  req.user = { userId: req.get('x-audit-user') || 'a', role: req.get('x-audit-role') || 'operator', schoolCode: req.get('x-audit-school') || 'a' }
  next()
})
let writes = 0
const auth = (req, res, next) => {
  req.userId = req.user.userId
  req.db = { testRecord: {
    findUnique: async () => null,
    create: async ({ data }) => ({ ...data, id: `${req.user.schoolCode}-${++writes}` }),
  }, auditLog: { create: async () => ({}) } }
  next()
}
const editor = (req, res, next) => req.user.role === 'guest' ? res.sendStatus(403) : next()
app.use(createRecordRoutes({ authenticateUser: auth, requireEditorOrAbove: editor, requireGuestReadOnly: (_q, _s, n) => n(), idempotencyMiddleware: idempotency }))
const payload = { testDate: '2026-09-24', canteen: 'A校食堂', inspector: 'A校检测员', result: '合格' }
const key = `audit-${Date.now()}`
const first = await request(app).post('/api/records/oil').set('Idempotency-Key', key).send(payload)
const second = await request(app).post('/api/records/oil').set('Idempotency-Key', key).set('x-audit-school', 'b').set('x-audit-role', 'guest').send(payload)
assert.equal(first.status, 200)
assert.equal(second.status, 200)
assert.equal(second.body.data.inspector, payload.inspector)
assert.equal(writes, 1)
observe('AUD-002', 'B校 guest 命中 A校 POST 缓存，200 返回未脱敏检测员；写守卫未执行，写入计数仍为1。')

const fakeRoot = {
  $executeRawUnsafe: async () => 0,
  $queryRawUnsafe: async () => [],
  user: { findUnique: async () => { throw new Error('simulated lookup outage') } },
}
const fakeManager = { rootPrisma: fakeRoot, verifyToken: () => ({ valid: true, user: { userId: 'old-admin', role: 'admin', schoolCode: null, jti: 'old-token', iat: 1 } }) }
_resetRecheckFailStateForTest()
const a = express()
a.get('/protected', createAuthMiddleware(fakeManager, fakeRoot).authenticateUser, (req, res) => res.json({ role: req.user.role }))
const statuses = []
for (let i = 0; i < 3; i++) statuses.push((await request(a).get('/protected').set('Authorization', 'Bearer test')).status)
assert.deepEqual(statuses, [200, 200, 503])
observe('AUD-014', `认证数据库回查失败，连续请求状态为 ${statuses.join('/')}。`)

fakeRoot.user.findUnique = async () => ({ status: 'active', role: 'operator', school_code: null, must_change_password: false })
fakeManager.verifyToken = () => ({ valid: true, user: { userId: 'attacker', role: 'operator', schoolCode: null, jti: 'current', iat: 1 } })
let victimSession = { id: 'victim-session', user_id: 'victim', status: 'revoked', ip_address: '192.0.2.1' }
fakeRoot.session = { upsert: async ({ update }) => (victimSession = { ...victimSession, ...update }) }
const sessions = express()
sessions.use(express.json(), createSessionRoutes(fakeManager, fakeRoot))
const changed = await request(sessions).post('/').set('Authorization', 'Bearer test').send({ sessionId: victimSession.id })
assert.equal(changed.status, 201)
assert.equal(changed.body.data.user_id, 'victim')
assert.equal(changed.body.data.status, 'active')
observe('AUD-013', '攻击者提交另一用户 sessionId，201 返回受害者会话信息，并将 revoked 改回 active。')

const users = express()
users.use(express.json(), createUserRoutes(fakeManager))
const logout = await request(users).post('/logout').set('Authorization', 'Bearer test').send({})
assert.equal(logout.status, 200)
observe('AUD-012', 'logout handler 只返回成功；fakeRoot 没有令牌吊销/会话写接口仍成功。')

assert.equal(`${schemaNameOf('alpha')}_restore`, schemaNameOf('alpha-restore'))
observe('AUD-004', 'alpha 的恢复暂存名与合法学校 alpha-restore 的真实 schema 完全相同：school_alpha_restore。')
const invalidDate = normalizeWriteJson({ payload: { ...payload, testDate: '2026-02-30' }, mode: 'create' })
assert.equal(invalidDate.ok, true)
observe('AUD-023', 'normalizeWriteJson 接受不存在的业务日期 2026-02-30。')
const implicitStatus = buildRecordWriteData('oil', payload, { existingSampleInfo: { testDate: payload.testDate, canteen: payload.canteen, inspector: payload.inspector }, existingResultData: { result: '合格' } })
assert.equal(implicitStatus.data.status, 'completed')
observe('AUD-024', '更新未传 status 时 buildRecordWriteData 仍写入 completed，原 archived/pending 状态无法保留。')
let optionWrite
await updateFieldOption({ fieldOption: {
  findUnique: async () => ({ id: 'self', module_code: 'tableware', field_code: 'testType', value: 'atp', parent_option_id: null }),
  findFirst: async () => null,
  update: async args => (optionWrite = args),
} }, 'self', { parent_option_id: 'self' })
assert.equal(optionWrite.data.parent_option_id, 'self')
observe('AUD-031', '字段选项允许将 parent_option_id 设置为自己的 id。')
const evidenceRoot = '/sandbox/backend/uploads/test-evidence'
const escaped = path.join(evidenceRoot, '../../scripts')
assert.equal(escaped.startsWith(`${evidenceRoot}/`), false)
observe('AUD-018', '上传 case_id=../../scripts 时 path.join 离开证据目录；上传 handler 没有 containment 校验。')

const dom = new JSDOM('<table><tbody id="audit-table"></tbody></table>', { url: 'https://audit.invalid/a/index.html' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.localStorage = dom.window.localStorage
globalThis.sessionStorage = dom.window.sessionStorage
const { StorageService } = await import('../../../frontend/js/core/Storage.js')
StorageService.prototype._processQueuedRequests = async () => {}
const storageA = new StorageService('oil')
storageA._updateLocalCache([{ id: 'a-record', inspector: 'A校检测员', _status: 'synced' }], { forceServer: true })
storageA._addPendingRequest({ id: 'a-job', type: 'create', data: payload })
dom.reconfigure({ url: 'https://audit.invalid/b/index.html' })
const storageB = new StorageService('oil')
assert.equal(storageB._getLocalCacheData()[0].inspector, 'A校检测员')
assert.equal(storageB._getPendingRequests()[0].id, 'a-job')
observe('AUD-001', '切换同源 URL 从 /a/ 到 /b/ 后，B 的 StorageService 直接读出 A 的缓存与待上传任务。')

// Reproduce queued temporary record edit/delete with real cache methods, no network.
localStorage.clear()
const tempStorage = new StorageService('pesticide')
const temp = tempStorage.save(payload)
tempStorage.update(temp.id, { ...payload, result: '不合格' })
const [createReq, editReq] = tempStorage._getPendingRequests()
tempStorage._replaceTempIdInCache(temp.id, { ...createReq.data, id: 'saved', result: '合格' })
tempStorage._removeRequestFromQueue(createReq.id)
await tempStorage._handleUpdateTemp(editReq)
tempStorage._removeRequestFromQueue(editReq.id)
assert.equal(tempStorage._getLocalCacheData()[0].result, '合格')
const temp2 = tempStorage.save({ ...payload, result: 'other' })
tempStorage.delete(temp2.id)
assert.ok(tempStorage._getLocalCacheData().some(r => r.id === temp2.id))
assert.ok(!tempStorage._getPendingRequests().some(r => r.tempId === temp2.id))
observe('AUD-021', '临时记录编辑在创建应答后被丢弃；删除临时记录后 dirty 合并又保留本地行，但上传任务已清除。')

const { GenericTestModule } = await import('../../../frontend/js/modules/GenericTest.js')
const malicious = { ...payload, id: 'x', vegetableType: '<img src=x onerror="window.auditExecuted=1">' }
GenericTestModule.prototype.render.call({
  tableId: 'audit-table', moduleName: 'pesticide', sortOrder: 'desc', recordsPerPage: 10, currentPage: 1,
  getFilteredRecords: () => [malicious], getRecordDate: () => new Date(), updatePaginationUI: () => {},
})
assert.ok(document.querySelector('#audit-table img[onerror]'))
observe('AUD-003', '真实 GenericTest.render 将业务字段解析成带 onerror 的 img 节点，而非文本（未执行攻击脚本）。')

const uploadQueue = new AdaptiveUploadQueue({ initialInterval: 0 })
uploadQueue._scheduleNext = () => {}
uploadQueue._doRequest = async () => { throw Object.assign(new Error('conflict'), { status: 409, serverVersion: 2 }) }
const stale = { collection: 'oil', recordId: 'r1', payload: { version: 1, remark: 'stale-value' }, method: 'PUT', fingerprint: 'f', attempt: 0, resolvers: [], rejectors: [] }
uploadQueue._queueList.push(stale)
await uploadQueue._processNext()
assert.equal(uploadQueue._queueList[0].payload.version, 2)
assert.equal(uploadQueue._queueList[0].payload.remark, 'stale-value')
observe('AUD-022', '409 后只将旧 payload.version 改为服务端的2，旧 remark 原样再次排队，未合并服务端内容。')

const sql = 'COPY school_alpha."TestRecord" (id, sample_info) FROM stdin;\nr1\t{"remark":"school_alpha.example"}\n\\.\n'
assert.ok(rewriteSchemaNames(sql, 'school_alpha', 'school_alpha_restore').includes('"remark":"school_alpha_restore.example"'))
observe('AUD-048', '恢复 SQL 的全局 replace 同时改写 COPY 行中的业务 JSON 字符串。')

const boundary = new Date('2026-09-24T00:00:00.000Z')
const events = Array.from({ length: 201 }, (_, i) => ({ id: String(i), message: 'SECURITY:REVOCATION_WRITE_FAILED', created_at: boundary }))
const state = { lastScanAt: new Date(boundary.getTime() - 1) }
const alertDb = { systemLog: { findMany: async ({ where, take }) => events.filter(e => e.created_at > where.created_at.gt).slice(0, take) } }
const scan1 = await scanAndAlertSecurityEvents(alertDb, state, { logger: { error() {} }, now: () => new Date(boundary.getTime() + 1000) })
const scan2 = await scanAndAlertSecurityEvents(alertDb, state, { logger: { error() {} }, now: () => new Date(boundary.getTime() + 2000) })
assert.equal(scan1.scanned, 200)
assert.equal(scan2.scanned, 0)
observe('AUD-049', '201条安全事件共享 created_at 时，时间戳游标首批读取200条、下一批0条，漏掉第201条。')

// Timer callbacks use the stub until exit; no network is attempted.
console.log(JSON.stringify({ probes: findings.length, findings }, null, 2))
dom.window.close()
process.exit(0)
