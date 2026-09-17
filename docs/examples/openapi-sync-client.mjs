#!/usr/bin/env node
// openapi-sync-client.mjs — 开放接口「接入方参考同步实现」（可执行）
//
// 作用：给对接方一个可照抄的状态机示范，覆盖——分页、退避重试、409 重同步、
//       清单完整核验、失败不当空清单、字段撤回（替换式重投影）。
//
// ⚠️ 原子性（2026-09-17 P0-2 修复，本文件的核心不变量）：
//       **在"前后清单一致性校验"通过之前，绝不修改正式本地 checkpoint。**
//       流程：读 head → 克隆出候选状态 candidate → 所有 records/cursor/watermark 改动只写 candidate
//             → 读 tail → 校验 tail.digest === head.digest（且 scope/projection 未变）
//             → 一致才**一次性提交** candidate；不一致则丢弃 candidate 并重跑。
//       旧实现在 tail 之前就执行 `st.digest = tail.digest`：若同步中途源端新增数据（head=D1, tail=D2），
//       下一轮会把 D2 当作"已同步"，新增记录**永久漏拉**。
//       异常路径同理：任何失败（第 3 页超时 / JSON 解析失败 / tail 请求失败 / digest 不一致）都不得留下
//       正式 records / cursor / watermark / digest 的半更新。
//
// 运行（默认 **mock 模式：零网络、零凭证**，可安全在本地/CI 跑）：
//   node docs/examples/openapi-sync-client.mjs
//
// 真实联调（需显式指定，不会默认连生产）：
//   OPENAPI_KEY=xxx node docs/examples/openapi-sync-client.mjs \
//     --live --base-url=http://127.0.0.1:3002/api/open/v1 --school=tjb
//   （密钥请用环境变量或密钥文件，不要写进命令行历史）
//
// ⚠️ 本文件是**示例代码**，不是平台组件；平台侧实现见 backend/routes/openApiRoutes.js。

import process from 'node:process'

/* ─────────────────────────── 本地状态（对接方侧应持久化）─────────────────────────── */
// 结构：{ [schoolCode]: { scopeVersion, projectionFingerprint, digest, cursor, watermark,
//                        records: Map<record_code, {updated_at, doc}> } }
// 持久化建议：把 commitState() 的"整体替换"落成一次事务/一次原子写文件（先写临时文件再 rename）。
export function createStore() {
  return new Map()
}

export const defaultStore = createStore()

function emptyState() {
  return {
    scopeVersion: null, projectionFingerprint: null, digest: null, cursor: null,
    watermark: null,          // 最近一次成功同步到的数据变更时间（增量扫描起点）
    records: new Map(),
  }
}

function stateOf(store, schoolCode) {
  if (!store.has(schoolCode)) store.set(schoolCode, emptyState())
  return store.get(schoolCode)
}

/** 深拷贝正式状态 → 候选状态（records 里的 doc 也要拷贝，避免候选改动污染正式对象）。 */
function cloneState(st) {
  return {
    ...st,
    records: new Map([...st.records].map(([k, v]) => [k, { updated_at: v.updated_at, doc: { ...v.doc } }])),
  }
}

/** 原子提交：单次替换 store 中的条目；在此之前正式状态一个字节都没动过。 */
function commitState(store, schoolCode, cand) {
  store.set(schoolCode, cand)
}

/** 重叠回拉：水位前移 5 分钟，防止"提交顺序与时间戳顺序不一致"造成的漏读（重复由幂等 upsert 吸收）。 */
function withOverlap(iso, minutes = 5) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Date(d.getTime() - minutes * 60 * 1000).toISOString()
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 401/403（以及 400 参数错）重试无意义 → 致命；其余（429/5xx/网络）按退避重试。 */
function isFatal(err) {
  return err?.status === 401 || err?.status === 403 || err?.status === 400 || err?.code === 'INVALID_CURSOR'
}

/**
 * 请求级退避重试。**任何非 2xx 都抛错** —— 绝不当成"空清单/空页"处理
 * （旧文档已写明：401/403/409/429/超时都不得被当成空数据，否则会把本地记录误删）。
 */
async function fetchWithRetry(fetchJson, path, { log = () => {}, sleep = defaultSleep, attempts = 3, floorMs = 200 } = {}) {
  let lastErr
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      return await fetchJson(path)
    } catch (e) {
      lastErr = e
      if (isFatal(e) || i === Math.max(1, attempts) - 1) throw e
      const retryAfter = Number(e?.retryAfter || 0)
      const wait = retryAfter > 0 ? retryAfter * 1000 : floorMs * 2 ** i
      log(`  请求失败（${e.status || 'NETWORK'}${e.code ? '/' + e.code : ''}），${wait}ms 后重试（${i + 2}/${Math.max(1, attempts)}）`)
      await sleep(wait)
    }
  }
  throw lastErr
}

/* ─────────────────────────── 同步主流程 ─────────────────────────── */

/**
 * 同步一所学校（原子：失败/不一致都不推进正式 checkpoint）。
 * @param {{schoolCode:string, fetchJson:Function, log?:Function, store?:Map,
 *          sleep?:Function, maxRounds?:number, attemptsPerRequest?:number}} opts
 * @returns {Promise<{added:number, updated:number, removed:number, reprojected:number,
 *                    rounds:number, committed:boolean, fatal:boolean, reason?:string}>}
 */
export async function syncSchool({
  schoolCode, fetchJson, log = () => {}, store = defaultStore,
  sleep = defaultSleep, maxRounds = 3, attemptsPerRequest = 3,
}) {
  const st = stateOf(store, schoolCode)
  const stat = { added: 0, updated: 0, removed: 0, reprojected: 0, rounds: 0, committed: false, fatal: false }
  const reqOpts = { log, sleep, attempts: attemptsPerRequest }

  // 同一轮内前后清单不一致时重跑（上限 maxRounds，避免源端持续变化时无限循环）
  for (let round = 0; round < maxRounds; round++) {
    stat.rounds++
    try {
      /* ① 轻量清单：拿 total + digest + 策略指纹 */
      const head = await fetchWithRetry(fetchJson, `/sync/manifest?school_code=${encodeURIComponent(schoolCode)}`, reqOpts)
      const policyChanged = st.projectionFingerprint !== null && st.projectionFingerprint !== head.projection_fingerprint
      const scopeChanged = st.scopeVersion !== null && st.scopeVersion !== head.scope_version
      const digestSame = st.digest !== null && st.digest === head.digest && !policyChanged && !scopeChanged
      if (digestSame) {
        log(`[${schoolCode}] 第 ${round + 1} 轮：digest 未变，无需同步`)
        return { ...stat, rounds: round + 1 }
      }
      log(`[${schoolCode}] 第 ${round + 1} 轮：digest 变化（scope ${st.scopeVersion}→${head.scope_version}，`
        + `projection ${String(st.projectionFingerprint).slice(0, 8)}→${String(head.projection_fingerprint).slice(0, 8)}）`)

      /* ② 候选状态：从这里开始的一切改动都只写 candidate */
      const cand = cloneState(st)

      /* ③ 全量清单：仅当"完整获取成功"才允许据此判定源端删除 */
      const manifest = await fetchWithRetry(fetchJson, `/sync/manifest?school_code=${encodeURIComponent(schoolCode)}&detail=1`, reqOpts)
      if (manifest.complete !== true) {
        // 平台侧超限会直接返回 413（进入 catch）；这里是双保险：不完整就绝不删本地
        log(`[${schoolCode}] 清单不完整（complete=${manifest.complete}）→ 丢弃候选，保留本地数据`)
        return { ...stat, rounds: round + 1, reason: 'MANIFEST_INCOMPLETE' }
      }
      const remote = new Map(manifest.items.map((i) => [i.record_code, i.updated_at]))

      /* ④ 拉取明细（写 candidate） */
      const changed = [...remote.entries()].filter(([code, updatedAt]) => {
        const local = cand.records.get(code)
        return !local || local.updated_at !== updatedAt
      })
      const needFullPull = policyChanged || scopeChanged || cand.records.size === 0
      const since = needFullPull || !changed.length
        ? null
        : withOverlap(changed.map(([, u]) => u).sort()[0])

      let cursor = null
      let pages = 0
      let maxUpdated = cand.watermark
      if (needFullPull || since) {
        do {
          const q = `/test-records?school_code=${encodeURIComponent(schoolCode)}&limit=200`
            + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : (since ? `&since=${encodeURIComponent(since)}` : ''))
          const page = await fetchWithRetry(fetchJson, q, reqOpts)
          pages++
          for (const item of page.items) {
            // 替换式写入：整条覆盖。若只做字段 merge，授权撤回的 inspector 会永久残留。
            const existed = cand.records.has(item.record_code)
            cand.records.set(item.record_code, { updated_at: item.updated_at, doc: item })
            if (existed) stat.updated++
            else stat.added++
            if (needFullPull) stat.reprojected++
            if (!maxUpdated || item.updated_at > maxUpdated) maxUpdated = item.updated_at
          }
          cursor = page.has_more ? page.next_cursor : null
          cand.cursor = cursor   // 只在候选里推进游标
        } while (cursor)
        cand.watermark = maxUpdated
      }

      /* ⑤ 删除/撤回判定：仅在"清单完整获取成功"之后执行（见上方 complete 校验） */
      for (const code of [...cand.records.keys()]) {
        if (!remote.has(code)) {
          cand.records.delete(code)   // 生产实现建议改为"标记撤回"，物理删除按双方约定
          stat.removed++
        }
      }

      /* ⑥ 轮次一致性校验：tail 必须与 head 属于同一快照，且授权/字段可见性未变 */
      const tail = await fetchWithRetry(fetchJson, `/sync/manifest?school_code=${encodeURIComponent(schoolCode)}`, reqOpts)
      if (tail.scope_version !== head.scope_version || tail.projection_fingerprint !== head.projection_fingerprint) {
        log(`[${schoolCode}] 本轮期间授权/字段可见性发生变化 → 丢弃候选，重新对账`)
        continue
      }
      if (tail.digest !== head.digest) {
        log(`[${schoolCode}] 本轮期间源端数据又发生变化（head≠tail）→ 丢弃候选，重跑一轮（不推进 checkpoint）`)
        continue
      }

      /* ⑦ 一致 → 一次性提交候选状态 */
      cand.scopeVersion = tail.scope_version
      cand.projectionFingerprint = tail.projection_fingerprint
      cand.digest = tail.digest
      cand.cursor = null
      commitState(store, schoolCode, cand)
      stat.committed = true
      log(`[${schoolCode}] 第 ${round + 1} 轮完成并提交：新增 ${stat.added} / 更新 ${stat.updated} / 撤回 ${stat.removed}（页数 ${pages}）`)
      return { ...stat, rounds: round + 1 }
    } catch (err) {
      // ⚠️ 关键不变量：失败时**正式状态完全不变**（候选从未被提交；上面的所有改动都写在 cand 上）
      if (isFatal(err)) {
        log(`[${schoolCode}] 致命错误（${err.status}${err.code ? '/' + err.code : ''}）→ 停止同步，正式状态保持不变`)
        return { ...stat, rounds: round + 1, fatal: true, reason: err.code || `HTTP_${err.status}` }
      }
      if (err.status === 409) {
        log(`[${schoolCode}] 收到 409（${err.code || 'SCOPE_CHANGED'}）：授权/策略已变化 → 丢弃候选，下一轮重新对账`)
        continue
      }
      log(`[${schoolCode}] 本轮失败（${err.status || 'NETWORK'}）→ 正式状态保持不变，稍后重试`)
      return { ...stat, rounds: round + 1, reason: err.code || (err.status ? `HTTP_${err.status}` : 'NETWORK') }
    }
  }
  return stat
}

/* ─────────────────────────── HTTP 客户端（真实模式）─────────────────────────── */

export function makeHttpClient({ baseUrl, apiKey }) {
  return async function fetchJson(path) {
    const res = await fetch(baseUrl.replace(/\/$/, '') + path, { headers: { 'X-API-Key': apiKey } })
    if (!res.ok) {
      let body = {}
      try { body = await res.json() } catch { /* 非 JSON 响应 */ }
      const err = new Error(body.error || `HTTP ${res.status}`)
      err.status = res.status
      err.code = body.code
      const ra = Number(res.headers?.get?.('Retry-After') || 0)
      if (ra > 0) err.retryAfter = ra
      throw err
    }
    const json = await res.json()
    return json.data
  }
}

/* ─────────────────────────── Mock 服务端（默认，零网络）─────────────────────────── */
// 复刻平台对外契约的关键语义：digest 组成、游标分页、策略变化导致 409、清单完整性。
// 数据全部为合成数据；不连接任何生产环境。

export function createMockServer({ onPage } = {}) {
  const mk = (code, type, updatedAt, extra = {}) => ({
    record_id: `id-${code}`, record_code: code, school_code: 'demo-school', school_name: '示例学校（mock）',
    test_type: type, test_name: type, test_date: '2026-01-15', canteen: '示例食堂', status: 'completed',
    initial_conclusion: 'pass', final_conclusion: 'pass', conclusion: 'pass', conclusion_text: '合格',
    conclusion_source: 'stored', final_conclusion_basis: 'initial', is_positive: null,
    // result 内带一个"历史同义副本"（result.canteen）：2026-09-16 前平台全量记录都有，
    // 收口后新记录不再产生；老记录被再次保存时该副本会消失 → 见场景 7。
    result: { result: '合格', canteen: '示例食堂（历史副本）', ...extra }, created_at: '2026-01-15T00:00:00+08:00',
    updated_at: updatedAt, data_version: 1,
  })

  const db = {
    records: new Map([
      ['RC-demo-001', mk('RC-demo-001', 'tableware', '2026-01-15T00:00:00+08:00')],
      ['RC-demo-002', mk('RC-demo-002', 'pesticide', '2026-01-16T00:00:00+08:00')],
    ]),
    scopeVersion: 1,
    projectionFingerprint: 'P1-no-inspector',
    step: 0,
  }

  const digestOf = () => {
    const lines = [...db.records.values()]
      .map((r) => `${r.record_code}@${r.updated_at}`).sort().join('\n')
    return `v2|scope=${db.scopeVersion}|projection=${db.projectionFingerprint}|${lines.length}:${lines}`
  }

  function mutate(step) {
    if (step === 1) { db.records.set('RC-demo-003', mk('RC-demo-003', 'oil', '2026-02-01T00:00:00+08:00')); return '新增 1 条（RC-demo-003）' }
    if (step === 2) { db.records.get('RC-demo-002').updated_at = '2026-02-02T00:00:00+08:00'; return '修改 1 条（RC-demo-002 复检）' }
    if (step === 3) { db.records.delete('RC-demo-001'); return '删除 1 条（RC-demo-001）' }
    if (step === 4) { db.projectionFingerprint = 'P2-with-inspector'; for (const r of db.records.values()) r.inspector = '示例姓名（虚构）'; return '字段可见性变化（开启检测人姓名）' }
    if (step === 5) { db.projectionFingerprint = 'P3-no-inspector'; for (const r of db.records.values()) delete r.inspector; return '字段撤回（关闭检测人姓名）' }
    if (step === 6) {
      // 记录级字段减少：平台规范化后 result 内的历史副本消失（updated_at 变化，但 projection_fingerprint 不变）
      const r = db.records.get('RC-demo-002')
      if (r) {
        r.updated_at = '2026-02-03T00:00:00+08:00'
        delete r.result.canteen
      }
      return '记录级字段减少（result.canteen 历史副本被移除，projection_fingerprint 未变）'
    }
    return null
  }

  async function fetchJson(path) {
    if (path.startsWith('/sync/manifest')) {
      const detail = path.includes('detail=1')
      const rows = [...db.records.values()].map((r) => ({ record_code: r.record_code, updated_at: r.updated_at }))
      return {
        contract_version: 'v1', school_code: 'demo-school', scope_version: db.scopeVersion,
        projection_fingerprint: db.projectionFingerprint, visible_types: ['tableware', 'pesticide', 'oil', 'leanMeat'],
        generated_at: new Date().toISOString(), detail, total: rows.length, complete: true,
        digest: digestOf(), items: detail ? rows : undefined,
      }
    }
    if (path.startsWith('/test-records')) {
      const u = new URL(path, 'http://mock')
      const limit = Number(u.searchParams.get('limit') || 100)
      const cursor = u.searchParams.get('cursor')
      const all = [...db.records.values()].sort((a, b) => (a.record_code < b.record_code ? -1 : 1))
      const start = cursor ? all.findIndex((r) => r.record_code === cursor) + 1 : 0
      const page = all.slice(start, start + limit)
      const hasMore = start + limit < all.length
      if (typeof onPage === 'function') onPage({ path, page, db })
      return {
        contract_version: 'v1', school_code: 'demo-school', scope_version: db.scopeVersion,
        projection_fingerprint: db.projectionFingerprint, count: page.length, has_more: hasMore,
        next_cursor: hasMore ? page[page.length - 1].record_code : null, items: page,
      }
    }
    const err = new Error(`mock 未实现的路径: ${path}`); err.status = 404; throw err
  }

  return { fetchJson, mutate, digestOf, db }
}

/* ─────────────────────────── CLI ─────────────────────────── */

async function main() {
  const args = process.argv.slice(2)
  const has = (k) => args.includes(k)
  const val = (k, d = null) => {
    const a = args.find((x) => x.startsWith(`${k}=`))
    return a ? a.slice(k.length + 1) : d
  }
  const live = has('--live')
  const schoolCode = val('--school', 'demo-school')

  if (live) {
    const baseUrl = val('--base-url')
    const apiKey = process.env.OPENAPI_KEY
    if (!baseUrl || !apiKey) {
      console.error('真实模式需同时提供 --base-url=https://<域名>/api/open/v1 与环境变量 OPENAPI_KEY')
      process.exit(2)
    }
    console.log(`[live] 目标：${baseUrl}（学校 ${schoolCode}）—— 请确认已获得授权`)
    const stats = await syncSchool({ schoolCode, fetchJson: makeHttpClient({ baseUrl, apiKey }), log: console.log })
    console.log('同步结果：', stats)
    return
  }

  // mock 模式：演示 7 种场景的完整状态机（含 409 重同步、字段撤回、记录级字段减少）
  console.log('=== mock 模式（零网络、零凭证；数据为合成数据）===')
  const mock = createMockServer()
  const store = createStore()
  const scenarios = [
    '首次全量同步',
    '新增 1 条',
    '修改 1 条',
    '删除 1 条',
    '字段可见性变化（开启检测人姓名）→ 应触发全量重投影',
    '字段撤回（关闭检测人姓名）→ 本地旧姓名必须被清除',
    '记录级字段减少（历史副本被规范化移除）→ 靠"整体替换"清除，不依赖 projection 变化',
  ]
  for (let step = 0; step <= 6; step++) {
    if (step > 0) {
      const what = mock.mutate(step)
      console.log(`\n--- 场景 ${step + 1}：${scenarios[step]}（服务端变更：${what}）`)
    } else {
      console.log(`\n--- 场景 1：${scenarios[0]}`)
    }
    const stats = await syncSchool({ schoolCode, fetchJson: mock.fetchJson, log: console.log, store })
    const st = stateOf(store, schoolCode)
    const inspectorLeft = [...st.records.values()].filter((r) => r.doc.inspector !== undefined).length
    const legacyCopyLeft = [...st.records.values()].filter((r) => r.doc.result && 'canteen' in r.doc.result).length
    console.log(`    结果：新增 ${stats.added} / 更新 ${stats.updated} / 撤回 ${stats.removed}；本地记录 ${st.records.size} 条；`
      + `含姓名的记录 ${inspectorLeft} 条；result.canteen 副本残留 ${legacyCopyLeft} 条`)
  }

  console.log('\n=== 失败语义验证（请求失败绝不当空清单、绝不推进 checkpoint）===')
  const before = stateOf(store, schoolCode)
  const snapshot = { size: before.records.size, digest: before.digest, watermark: before.watermark, cursor: before.cursor }
  const failing = async () => { const e = new Error('模拟 500'); e.status = 500; throw e }
  await syncSchool({ schoolCode, fetchJson: failing, log: console.log, store, attemptsPerRequest: 1 })
  const after = stateOf(store, schoolCode)
  const unchanged = after.records.size === snapshot.size && after.digest === snapshot.digest
    && after.watermark === snapshot.watermark && after.cursor === snapshot.cursor
  console.log(`失败前后：记录数 ${snapshot.size} → ${after.records.size}；digest 未推进：${after.digest === snapshot.digest}；`
    + `watermark 未推进：${after.watermark === snapshot.watermark}`)
  process.exit(unchanged ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('运行失败：', e); process.exit(1) })
}
