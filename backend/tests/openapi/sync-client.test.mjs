// 参考同步客户端（docs/examples/openapi-sync-client.mjs）原子性回归
//
// 锁定的不变量（2026-09-17 P0-2）：
//   1) **tail 校验通过之前绝不推进正式 checkpoint**：同步中途源端新增数据（head=D1/tail=D2）时，
//      必须丢弃候选并重跑；否则下一轮会把 D2 当成"已同步"→ 新增记录永久漏拉。
//   2) **任何失败都不留半同步状态**：records / cursor / watermark / digest / scopeVersion 全部不变。
//   3) 401/403 致命即停；409/5xx/网络按策略重试，且都不得当"空清单"。
// 零网络：全部走 mock transport（合成数据）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, syncSchool, createMockServer } from '../../../docs/examples/openapi-sync-client.mjs'

const SCHOOL = 'demo-school'
const noSleep = async () => {}

function snapshotOf(store) {
  const st = store.get(SCHOOL)
  return {
    size: st.records.size,
    digest: st.digest,
    watermark: st.watermark,
    cursor: st.cursor,
    scopeVersion: st.scopeVersion,
    projectionFingerprint: st.projectionFingerprint,
    codes: [...st.records.keys()].sort().join(','),
  }
}

test('Test D：同步中途新增记录（head≠tail）不得被标记为已同步，且新增记录最终必须落到本地', async () => {
  const store = createStore()
  let inserted = false
  // 第一页返回后，源端新增一条记录（digest 由 D1 → D2）
  const mock = createMockServer({
    onPage: ({ db }) => {
      if (inserted) return
      inserted = true
      const tpl = db.records.get('RC-demo-001')
      db.records.set('RC-demo-999', { ...tpl, record_code: 'RC-demo-999', updated_at: '2026-03-01T00:00:00+08:00' })
    },
  })

  const res = await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep, attemptsPerRequest: 1 })
  const st = store.get(SCHOOL)

  assert.equal(res.committed, true, '第二轮必须成功提交')
  assert.ok(res.rounds >= 2, `head≠tail 时必须重跑（实际轮数 ${res.rounds}）`)
  assert.ok(st.records.has('RC-demo-999'), '中途新增的记录不得漏拉（旧实现在此失败：digest 被提前推进 → 判定"已同步"）')
  assert.equal(st.digest, mock.digestOf(), '提交后 digest 必须等于源端当前 digest')
  assert.equal(st.cursor, null, '提交后游标应清空（下一轮从清单开始）')

  // 再跑一轮：应判定为无需同步（幂等、不重复拉取）
  const res2 = await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep, attemptsPerRequest: 1 })
  assert.equal(res2.committed, false)
  assert.equal(res2.added, 0)
  assert.equal(store.get(SCHOOL).digest, mock.digestOf())
})

test('Test E：同步中途失败（第 2 页 504）→ 正式状态完全不变（records/cursor/watermark/digest）', async () => {
  const store = createStore()
  const mock = createMockServer()
  // 造 >200 条以产生多页
  const tpl = mock.db.records.get('RC-demo-001')
  for (let i = 0; i < 260; i++) {
    mock.db.records.set(`RC-bulk-${String(i).padStart(3, '0')}`, {
      ...tpl, record_code: `RC-bulk-${String(i).padStart(3, '0')}`, updated_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00+08:00`,
    })
  }

  // 先成功同步一次，建立基线（digest/watermark/records 都有值）
  const first = await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep, attemptsPerRequest: 1 })
  assert.equal(first.committed, true)
  const before = snapshotOf(store)

  // 让源端发生变化（否则第二轮会走 "digest 未变" 提前返回，测不到失败路径）
  mock.mutate(1)
  const beforeChanged = snapshotOf(store)

  let recordCalls = 0
  const failingTransport = async (path) => {
    if (path.startsWith('/test-records')) {
      recordCalls++
      if (recordCalls === 2) { const e = new Error('模拟第 2 页超时'); e.status = 504; throw e }
    }
    return mock.fetchJson(path)
  }
  const res = await syncSchool({ schoolCode: SCHOOL, fetchJson: failingTransport, store, sleep: noSleep, attemptsPerRequest: 1 })
  const after = snapshotOf(store)

  assert.equal(res.committed, false)
  assert.equal(recordCalls, 2, '确实失败在第 2 页')
  assert.deepEqual(after, beforeChanged, '失败后正式状态必须逐字段不变（含 cursor/watermark/digest/records）')
  assert.notEqual(mock.digestOf(), before.digest, '前置条件：源端确实已变化，本轮进入了拉取路径（否则该用例无意义）')

  // 再次成功同步 → 数据补齐且 digest 推进
  const ok = await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep, attemptsPerRequest: 1 })
  assert.equal(ok.committed, true)
  assert.equal(store.get(SCHOOL).digest, mock.digestOf())
  assert.ok(store.get(SCHOOL).records.has('RC-demo-003'), '重试后新增记录必须补齐')
})

test('异常语义：401/403 致命即停且不改状态；409 丢弃候选进入下一轮；429 退避后重试成功', async () => {
  const store = createStore()
  const mock = createMockServer()

  // 403 → fatal，状态不变
  const forbidden = async () => { const e = new Error('无权访问该学校'); e.status = 403; e.code = 'SCHOOL_NOT_AUTHORIZED'; throw e }
  const r403 = await syncSchool({ schoolCode: SCHOOL, fetchJson: forbidden, store, sleep: noSleep, attemptsPerRequest: 2 })
  assert.equal(r403.fatal, true)
  assert.equal(r403.committed, false)
  assert.equal(snapshotOf(store).size, 0, '致命错误后不得有任何本地写入')

  // 401 → fatal（且不因重试放大）
  const unauthorized = async () => { const e = new Error('密钥无效'); e.status = 401; e.code = 'INVALID_KEY'; throw e }
  const r401 = await syncSchool({ schoolCode: SCHOOL, fetchJson: unauthorized, store, sleep: noSleep, attemptsPerRequest: 3 })
  assert.equal(r401.fatal, true)

  // 409（第一轮）→ 不推进状态，第二轮成功提交
  let manifestCalls = 0
  const conflictOnce = async (path) => {
    if (path.startsWith('/sync/manifest') && !path.includes('detail=1')) {
      manifestCalls++
      if (manifestCalls === 1) { const e = new Error('授权已变化'); e.status = 409; e.code = 'SCOPE_CHANGED'; throw e }
    }
    return mock.fetchJson(path)
  }
  const r409 = await syncSchool({ schoolCode: SCHOOL, fetchJson: conflictOnce, store, sleep: noSleep, attemptsPerRequest: 1 })
  assert.equal(r409.committed, true, '409 后下一轮必须能重新对账并提交')
  assert.equal(store.get(SCHOOL).records.size, 2)

  // 429（带 Retry-After）→ 退避重试后成功；记录重试次数
  mock.mutate(1)
  let tries = 0
  const waited = []
  const throttled = async (path) => {
    if (path.includes('detail=1') && tries === 0) {
      tries++
      const e = new Error('限流'); e.status = 429; e.retryAfter = 2; throw e
    }
    return mock.fetchJson(path)
  }
  const r429 = await syncSchool({
    schoolCode: SCHOOL, fetchJson: throttled, store, attemptsPerRequest: 3,
    sleep: async (ms) => { waited.push(ms) },
  })
  assert.equal(r429.committed, true)
  assert.deepEqual(waited, [2000], '必须遵守 Retry-After（2s），不是固定退避')
  assert.ok(store.get(SCHOOL).records.has('RC-demo-003'))
})

test('F3 验收补充：tail 清单请求失败、以及重试耗尽 → 均不得推进 checkpoint，也不得假报完成', async () => {
  const store = createStore()
  const mock = createMockServer()
  await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep, attemptsPerRequest: 1 })
  mock.mutate(1)   // 制造真实变化，确保进入完整流程
  const before = snapshotOf(store)

  // ① tail（最后一次轻量清单）返回 500：候选被丢弃，正式状态不变
  let manifestCalls = 0
  const tailFails = async (path) => {
    if (path.startsWith('/sync/manifest')) {
      manifestCalls++
      // 第 1 次 = head，第 2 次 = detail=1，第 3 次 = tail → 让 tail 失败
      if (manifestCalls === 3 && !path.includes('detail=1')) { const e = new Error('模拟 tail 500'); e.status = 500; throw e }
    }
    return mock.fetchJson(path)
  }
  const r1 = await syncSchool({ schoolCode: SCHOOL, fetchJson: tailFails, store, sleep: noSleep, attemptsPerRequest: 1 })
  assert.equal(r1.committed, false)
  assert.deepEqual(snapshotOf(store), before, 'tail 失败后正式状态必须逐字段不变（含新数据未落库）')
  assert.ok(store.get(SCHOOL).records.has('RC-demo-003') === false, '本轮新增记录不得半写入')

  // ② 重试耗尽（attemptsPerRequest=1 且一直失败）→ 明确失败返回，不假报完成
  const alwaysFail = async () => { const e = new Error('模拟网络中断'); e.status = 503; throw e }
  const r2 = await syncSchool({ schoolCode: SCHOOL, fetchJson: alwaysFail, store, sleep: noSleep, attemptsPerRequest: 1 })
  assert.equal(r2.committed, false)
  assert.ok(r2.reason, '必须返回可解释的失败原因')
  assert.deepEqual(snapshotOf(store), before, '重试耗尽后正式状态仍不得变化')

  // ③ 之后一次正常同步应把数据补齐（证明只是"没提交"，不是"脏状态"）
  const ok = await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep, attemptsPerRequest: 1 })
  assert.equal(ok.committed, true)
  assert.equal(store.get(SCHOOL).digest, mock.digestOf())
})

test('替换式重投影：字段撤回后本地不得残留 inspector（且失败不当空清单）', async () => {
  const store = createStore()
  const mock = createMockServer()
  await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep, attemptsPerRequest: 1 })

  mock.mutate(4)   // 开启姓名
  await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep, attemptsPerRequest: 1 })
  assert.ok([...store.get(SCHOOL).records.values()].some((r) => r.doc.inspector), '开启后本地应有姓名（示例用）')

  mock.mutate(5)   // 撤回姓名
  await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep, attemptsPerRequest: 1 })
  assert.equal([...store.get(SCHOOL).records.values()].filter((r) => r.doc.inspector !== undefined).length, 0, '撤回后本地必须清除姓名（替换式写入）')

  // 清单不完整（complete=false）→ 不得删除本地记录
  mock.mutate(2)   // 先让源端再变一次，否则会走 "digest 未变" 提前返回，测不到 complete 分支
  const before = snapshotOf(store)
  const incomplete = async (path) => {
    const data = await mock.fetchJson(path)
    if (path.includes('detail=1')) return { ...data, complete: false }
    return data
  }
  const res = await syncSchool({ schoolCode: SCHOOL, fetchJson: incomplete, store, sleep: noSleep, attemptsPerRequest: 1 })
  assert.equal(res.committed, false)
  assert.equal(res.reason, 'MANIFEST_INCOMPLETE')
  assert.deepEqual(snapshotOf(store), before, '清单不完整时本地必须原封不动（尤其不得据此判删除）')
})

test('同秒 .100→.900：旧秒级清单逐项相同但摘要不同，必须完整重拉后提交', async () => {
  const store = createStore()
  const mock = createMockServer()
  const row = mock.db.records.get('RC-demo-001')
  row.updated_at = '2026-09-23T12:00:00.100+08:00'
  row.result.result = '不合格'
  let pageCalls = 0
  const oldPrecision = async (path) => {
    const data = await mock.fetchJson(path)
    if (path.startsWith('/sync/manifest') && data.items) {
      data.items = data.items.map((i) => ({ ...i, updated_at: i.updated_at.replace(/\.\d{3}(?=\+08:00)/, '') }))
    }
    if (path.startsWith('/test-records')) {
      pageCalls++
      data.items = data.items.map((i) => ({ ...i, updated_at: i.updated_at.replace(/\.\d{3}(?=\+08:00)/, '') }))
    }
    return data
  }
  assert.equal((await syncSchool({ schoolCode: SCHOOL, fetchJson: oldPrecision, store, sleep: noSleep })).committed, true)
  const oldDigest = store.get(SCHOOL).digest
  row.updated_at = '2026-09-23T12:00:00.900+08:00'
  row.result.result = '合格'
  const beforePages = pageCalls
  const result = await syncSchool({ schoolCode: SCHOOL, fetchJson: oldPrecision, store, sleep: noSleep })
  assert.equal(result.committed, true)
  assert.ok(pageCalls > beforePages, '摘要变化但秒级清单无逐项差异，仍须拉明细')
  assert.equal(store.get(SCHOOL).records.get('RC-demo-001').doc.result.result, '合格')
  assert.notEqual(store.get(SCHOOL).digest, oldDigest)
})

test('旧客户端已有完成摘要但缺协议版本：强制重拉并清除撤回字段', async () => {
  const mock = createMockServer()
  const store = createStore()
  const stale = { ...mock.db.records.get('RC-demo-001'), inspector: '旧姓名' }
  store.set(SCHOOL, {
    scopeVersion: mock.db.scopeVersion, projectionFingerprint: mock.db.projectionFingerprint,
    digest: mock.digestOf(), cursor: null, watermark: stale.updated_at,
    records: new Map([['RC-demo-001', { updated_at: stale.updated_at, doc: stale }]]),
  })
  const result = await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep })
  assert.equal(result.committed, true)
  assert.equal(store.get(SCHOOL).records.get('RC-demo-001').doc.inspector, undefined)
  assert.equal(store.get(SCHOOL).syncProtocolVersion, 2)
  assert.ok(store.get(SCHOOL).records.has('RC-demo-002'))
})

test('不同记录同一更新时间仍全部进入本地状态', async () => {
  const mock = createMockServer()
  mock.db.records.get('RC-demo-002').updated_at = mock.db.records.get('RC-demo-001').updated_at
  const store = createStore()
  const result = await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep })
  assert.equal(result.committed, true)
  assert.deepEqual([...store.get(SCHOOL).records.keys()].sort(), ['RC-demo-001', 'RC-demo-002'])
})

test('学校改名但记录时间未变：投影变化后客户端刷新学校名称', async () => {
  const mock = createMockServer()
  const store = createStore()
  assert.equal((await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep })).committed, true)
  const before = store.get(SCHOOL).digest
  for (const row of mock.db.records.values()) row.school_name = '更名后的示例学校'
  mock.db.projectionFingerprint = 'P2-school-renamed'
  const result = await syncSchool({ schoolCode: SCHOOL, fetchJson: mock.fetchJson, store, sleep: noSleep })
  assert.equal(result.committed, true)
  assert.notEqual(store.get(SCHOOL).digest, before)
  assert.ok([...store.get(SCHOOL).records.values()].every((r) => r.doc.school_name === '更名后的示例学校'))
})
