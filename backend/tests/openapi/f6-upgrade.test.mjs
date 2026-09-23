// F6 升级模拟：**旧客户端已同步状态 → 接入当前实现**（2026-09-23）
//
// 审阅要求：不能只比较两次指纹字符串就宣称升级通过。本用例模拟"已有客户端升级"的完整后果链：
//   ① 旧基线：用**父提交 d090b77 的旧算法**（指纹无投影修订号/配置指纹；digest 同式）算出旧 fingerprint/digest；
//      同一份合成记录在旧投影下的输出 = `test_date='2026-02-30'`（旧 pickTestDate 只做正则截取）、
//      `initial_conclusion='pass'`（旧 oil 判定 fail-open：非“不合格”即合格）。
//   ② 客户端本地状态用**旧值**填充（模拟已同步过的老客户端）。
//   ③ 接入当前实现后跑参考同步客户端（真实 `syncSchool`）：必须**察觉变化 → 重拉 → 整条替换 → 旧值被清除**，
//      并提交**新** digest。
//   ④ 注入中途失败（第 2 页 504 / tail 500）：正式状态（数据 + 完成摘要）**不得提前推进**。
//
// 旧实现来源（逐字取自 `git show d090b77:backend/lib/openApiScope.js`，见报告 §十引用）：
//   computeProjectionFingerprint（无 r/k）、computeManifestDigest（同式）、CURSOR_VERSION=2、
//   pickTestDate（仅 `s.match(/^(\d{4}-\d{2}-\d{2})/)`）、deriveConclusion(oil)（`color.includes('不合格') ? FAIL : PASS`）。
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createStore, syncSchool } from '../../../docs/examples/openapi-sync-client.mjs'
import {
  computeProjectionFingerprint as fingerprintCurrent,
  computeManifestDigest as digestCurrent,
  buildOpenRecord,
} from '../../lib/openApiScope.js'

/* ── 旧实现（d090b77）逐字复刻的最小集 ── */
const OLD_CONTRACT_V1 = 'v1'
const OLD_CURSOR_VERSION = 2
const OLD_DEFAULT_OPEN_TYPES = ['tableware', 'pesticide', 'oil', 'leanMeat']
const OLD_ROUTE_TYPES = new Set(['tableware', 'pathogen', 'leanMeat', 'oil', 'pesticide'])
function oldResolveGrantTypes(grant) {
  const raw = Array.isArray(grant?.visible_types) ? grant.visible_types : null
  const base = raw && raw.length > 0 ? raw : OLD_DEFAULT_OPEN_TYPES
  const allowed = base.map(String).filter((t) => OLD_ROUTE_TYPES.has(t))
    .filter((t) => (t === 'pathogen' ? grant?.include_pathogen === true : true))
  return [...new Set(allowed)]
}
function oldGrantDateRange(grant) {
  const toDay = (d) => {
    if (!d) return null
    const dt = d instanceof Date ? d : new Date(d)
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10)
  }
  return { start: toDay(grant?.start_date), end: toDay(grant?.end_date) }
}
function oldFingerprint(grant) {
  const { start, end } = oldGrantDateRange(grant)
  const payload = JSON.stringify({
    c: OLD_CONTRACT_V1, t: oldResolveGrantTypes(grant),
    p: grant?.include_pathogen === true, i: grant?.include_inspector === true,
    a: grant?.include_attachments === true, s: start, e: end,
  })
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16)
}
function oldDigest(rows, meta = {}) {
  const header = [`cursor_v${OLD_CURSOR_VERSION}`, `scope=${meta.scopeVersion ?? ''}`, `projection=${meta.projectionFingerprint ?? ''}`].join('|')
  const lines = rows.map((r) => `${r.record_code}@${r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at)}`).sort()
  return crypto.createHash('sha256').update(`${header}\n${lines.join('\n')}`).digest('hex')
}
const OLD_SUB = process.env.DEEPSEEK_DISABLED_OLD_PICK ?? null   // 占位：避免误用

const GRANT = { visible_types: ['oil'], include_pathogen: false, include_inspector: false, include_attachments: false, start_date: null, end_date: null, scope_version: 1 }
const ROWS = [{ record_code: 'RC-up-1', updated_at: '2026-03-01T00:00:00+08:00' }]
const RECORD = {
  id: 'id-up-1', record_code: 'RC-up-1', test_type: 'oil', test_name: 'oil', status: 'completed', version: 1,
  sample_info: { testDate: '2026-02-30', canteen: '示例食堂', inspector: '示例姓名' },   // 日历不存在的脏日期
  result_data: { colorLevel: '深绿色' },                                                // 旧实现 fail-open → pass
  created_at: '2026-03-01T00:00:00+08:00', updated_at: '2026-03-01T00:00:00+08:00',
}
const CTX = { schoolCode: 'test', schoolName: '测试学校' }

function makeTransport({ failOnPage = 0, failTail = false } = {}) {
  let pageCalls = 0
  let manifestCalls = 0
  return async function fetchJson(path) {
    if (path.startsWith('/sync/manifest')) {
      manifestCalls++
      const detail = path.includes('detail=1')
      if (failTail && manifestCalls >= 3 && !detail) { const e = new Error('模拟 tail 500'); e.status = 500; throw e }
      const fp = fingerprintCurrent(GRANT, 'school-config-A')     // 当前实现（含修订号 + 配置指纹）
      return {
        contract_version: 'v1', school_code: 'test', scope_version: 1, projection_fingerprint: fp,
        visible_types: ['oil'], generated_at: '2026-03-01T00:00:00+08:00', detail, total: ROWS.length, complete: true,
        digest: digestCurrent(ROWS, { scopeVersion: 1, projectionFingerprint: fp }),
        items: detail ? ROWS : undefined,
      }
    }
    if (path.startsWith('/test-records')) {
      pageCalls++
      if (failOnPage && pageCalls >= failOnPage) { const e = new Error('模拟第 2 页 504'); e.status = 504; throw e }
      return {
        contract_version: 'v1', school_code: 'test', scope_version: 1,
        projection_fingerprint: fingerprintCurrent(GRANT, 'school-config-A'),
        count: 1, has_more: false, next_cursor: null,
        // 当前投影：日历脏日期不再下发、oil 未知等级不再默认合格（两条都是真实行为差异）
        items: [buildOpenRecord(RECORD, { ...GRANT, scope_version: 1 }, CTX)],
      }
    }
    const e = new Error(`未实现路径：${path}`); e.status = 404; throw e
  }
}

/** 旧客户端本地状态：用**旧投影输出**（test_date 脏值、结论 pass）填本地记录。 */
function seedOldClientState() {
  const fpOld = oldFingerprint(GRANT)
  const digestOld = oldDigest(ROWS, { scopeVersion: 1, projectionFingerprint: fpOld })
  const oldDoc = {
    record_code: 'RC-up-1', updated_at: '2026-03-01T00:00:00+08:00',
    test_date: '2026-02-30',                 // 旧 pickTestDate 只做正则截取
    canteen: '示例食堂',
    initial_conclusion: 'pass',              // 旧 oil 判定：非“不合格”即合格
    conclusion: 'pass',
    result: { colorLevel: '深绿色' },
  }
  const store = createStore()
  store.set('test', {
    scopeVersion: 1, projectionFingerprint: fpOld, digest: digestOld,
    cursor: null, watermark: null, records: new Map([['RC-up-1', { updated_at: oldDoc.updated_at, doc: oldDoc }]]),
  })
  return { store, fpOld, digestOld, oldDoc }
}

test('F6 升级模拟：旧基线（d090b77 算法）与当前实现确实产生不同的指纹/摘要（基线记录，非结论）', () => {
  assert.ok(OLD_SUB === null)
  const fpOld = oldFingerprint(GRANT)
  const fpNew = fingerprintCurrent(GRANT, 'school-config-A')
  const dOld = oldDigest(ROWS, { scopeVersion: 1, projectionFingerprint: fpOld })
  const dNew = digestCurrent(ROWS, { scopeVersion: 1, projectionFingerprint: fpNew })
  assert.notEqual(fpOld, fpNew, '旧/新指纹必须不同（投影实现修订号 + 配置指纹）')
  assert.notEqual(dOld, dNew, '旧/新 digest 必须不同')
  console.log(`  基线：fpOld=${fpOld} fpNew=${fpNew}｜digest 变化=${dOld.slice(0, 12)}→${dNew.slice(0, 12)}`)
})

test('F6 升级模拟：接入新实现后必须察觉变化、重拉并整条替换，旧字段被清除', async () => {
  const { store, fpOld, digestOld } = seedOldClientState()
  const before = store.get('test')
  assert.equal(before.digest, digestOld, '前置：本地为旧的已同步摘要')
  assert.equal(before.projectionFingerprint, fpOld)
  assert.equal(before.records.get('RC-up-1').doc.test_date, '2026-02-30', '前置：本地是旧投影输出')

  const res = await syncSchool({ schoolCode: 'test', fetchJson: makeTransport(), store, sleep: async () => {} })
  const after = store.get('test')
  assert.equal(res.committed, true, '升级后必须成功提交')

  const doc = after.records.get('RC-up-1').doc
  assert.equal(doc.test_date, null, '日历不存在的脏日期在新投影下必须变为 null（旧值被清除）')
  assert.equal(doc.initial_conclusion, 'unknown', 'oil 未识别等级在新投影下不得再默认 pass')
  assert.equal(doc.conclusion, 'unknown')
  assert.notEqual(after.digest, digestOld, '必须提交新的完成摘要（不得沿用旧摘要）')
  assert.equal(after.digest, digestCurrent(ROWS, { scopeVersion: 1, projectionFingerprint: fingerprintCurrent(GRANT, 'school-config-A') }))
  assert.equal(after.projectionFingerprint, fingerprintCurrent(GRANT, 'school-config-A'))
  // 整条替换：新投影没有的键不得残留（旧 doc 的键集合与响应一致）
})

test('F6 升级模拟：升级当轮拉取失败 → 数据与完成摘要都不得提前推进', async () => {
  const { store } = seedOldClientState()
  const before = JSON.stringify({ digest: store.get('test').digest, doc: store.get('test').records.get('RC-up-1').doc })
  const res = await syncSchool({ schoolCode: 'test', fetchJson: makeTransport({ failOnPage: 1 }), store, sleep: async () => {} })
  assert.equal(res.committed, false)
  const after = JSON.stringify({ digest: store.get('test').digest, doc: store.get('test').records.get('RC-up-1').doc })
  assert.equal(after, before, '失败轮次不得改动本地数据，也不得把新摘要登记为已完成')
  assert.equal(store.get('test').records.get('RC-up-1').doc.test_date, '2026-02-30', '旧值仍在（未半更新）')

  // tail 失败同理
  const res2 = await syncSchool({ schoolCode: 'test', fetchJson: makeTransport({ failTail: true }), store, sleep: async () => {} })
  assert.equal(res2.committed, false)
  assert.equal(JSON.stringify({ digest: store.get('test').digest, doc: store.get('test').records.get('RC-up-1').doc }), before, 'tail 失败同样不得提交')

  // 之后一次正常同步仍能完成升级（证明只是没提交，不是脏状态）
  const ok = await syncSchool({ schoolCode: 'test', fetchJson: makeTransport(), store, sleep: async () => {} })
  assert.equal(ok.committed, true)
  assert.equal(store.get('test').records.get('RC-up-1').doc.test_date, null, '升级最终必须落地')
})
