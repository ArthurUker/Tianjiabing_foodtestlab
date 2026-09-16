#!/usr/bin/env node
// openapi-sync-client.mjs — 开放接口「接入方参考同步实现」（可执行）
//
// 作用：给对接方一个可照抄的状态机示范，覆盖——分页、重试、409 重同步、
//       清单完整核验、失败不当空清单、字段撤回（替换式重投影）。
//
// 运行（默认 **mock 模式：零网络、零凭证**，可安全在本地/CI 跑）：
//   node docs/examples/openapi-sync-client.mjs
//   node docs/examples/openapi-sync-client.mjs --scenario=basic      # 仅首轮全量
//
// 真实联调（需显式指定，不会默认连生产）：
//   OPENAPI_KEY=xxx node docs/examples/openapi-sync-client.mjs \
//     --live --base-url=http://127.0.0.1:3002/api/open/v1 --school=tjb
//   （密钥请用环境变量或密钥文件，不要写进命令行历史）
//
// ⚠️ 本文件是**示例代码**，不是平台组件；平台侧实现见 backend/routes/openApiRoutes.js。

import process from 'node:process'

/* ─────────────────────────── 本地状态（对接方侧应持久化）─────────────────────────── */
// 结构示意：{ [schoolCode]: { scopeVersion, projectionFingerprint, digest, cursor,
//                            records: Map<record_code, {updated_at, doc}> } }
const state = new Map()

function schoolState(schoolCode) {
  if (!state.has(schoolCode)) {
    state.set(schoolCode, {
      scopeVersion: null, projectionFingerprint: null, digest: null, cursor: null,
      watermark: null,          // 最近一次成功同步到的数据变更时间（增量扫描起点）
      records: new Map(),
    })
  }
  return state.get(schoolCode)
}

/** 重叠回拉：水位前移 5 分钟，防止"提交顺序与时间戳顺序不一致"造成的漏读（重复由幂等 upsert 吸收）。 */
function withOverlap(iso, minutes = 5) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Date(d.getTime() - minutes * 60 * 1000).toISOString()
}

/* ─────────────────────────── 同步主流程 ─────────────────────────── */

/**
 * 同步一所学校。
 * @param {{schoolCode: string, fetchJson: Function, log?: Function}} opts
 * @returns {Promise<{added:number, updated:number, removed:number, reprojected:number, rounds:number}>}
 */
export async function syncSchool({ schoolCode, fetchJson, log = () => {} }) {
  const st = schoolState(schoolCode)
  const stat = { added: 0, updated: 0, removed: 0, reprojected: 0, rounds: 0 }

  // 允许重跑：清单在同步前后各取一次，不一致就再来一轮（上限 3 轮，避免震荡时无限循环）
  for (let round = 0; round < 3; round++) {
    stat.rounds++
    try {
    /* ① 轻量清单：拿 total + digest + 策略指纹 */
    const head = await fetchJson(`/sync/manifest?school_code=${encodeURIComponent(schoolCode)}`)
    const policyChanged = st.projectionFingerprint !== null && st.projectionFingerprint !== head.projection_fingerprint
    const scopeChanged = st.scopeVersion !== null && st.scopeVersion !== head.scope_version
    const digestSame = st.digest !== null && st.digest === head.digest && !policyChanged && !scopeChanged
    if (digestSame) {
      log(`[${schoolCode}] 第 ${round + 1} 轮：digest 未变，无需同步`)
      return { ...stat, rounds: round + 1 }
    }
    log(`[${schoolCode}] 第 ${round + 1} 轮：digest 变化（scope ${st.scopeVersion}→${head.scope_version}，projection ${String(st.projectionFingerprint).slice(0, 8)}→${String(head.projection_fingerprint).slice(0, 8)}）`)

    /* ② 全量清单：仅当“完整获取成功”才允许据此判定源端删除 */
    const manifest = await fetchJson(`/sync/manifest?school_code=${encodeURIComponent(schoolCode)}&detail=1`)
    if (manifest.complete !== true) {
      // 平台侧超限会直接返回 413（进入 catch），这里是双保险：不完整就绝不删本地
      log(`[${schoolCode}] 清单不完整（complete=${manifest.complete}），保留本地数据并退出本轮`)
      return { ...stat, rounds: round + 1 }
    }
    const remote = new Map(manifest.items.map((i) => [i.record_code, i.updated_at]))

    /* ③ 拉取明细 */
    // 需要全量重拉的情形：首次同步、授权范围变化、字段可见性变化（必须重投影，否则撤回字段残留）
    const changed = [...remote.entries()].filter(([code, updatedAt]) => {
      const local = st.records.get(code)
      return !local || local.updated_at !== updatedAt
    })
    const needFullPull = policyChanged || scopeChanged || st.records.size === 0
    // 增量：以"最早变更记录的时间"为起点做重叠回拉；无变更（例如只有删除）则不拉明细
    const since = needFullPull || !changed.length
      ? null
      : withOverlap(changed.map(([, u]) => u).sort()[0])

    let cursor = null
    let pages = 0
    let maxUpdated = st.watermark
    if (needFullPull || since) {
      do {
        const q = `/test-records?school_code=${encodeURIComponent(schoolCode)}&limit=200`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : (since ? `&since=${encodeURIComponent(since)}` : ''))
        const page = await fetchJson(q)
        pages++
        for (const item of page.items) {
          // 替换式写入：整条覆盖。若只做字段 merge，授权撤回的 inspector 会永久残留。
          const existed = st.records.has(item.record_code)
          st.records.set(item.record_code, { updated_at: item.updated_at, doc: item })
          if (existed) stat.updated++
          else stat.added++
          if (needFullPull) stat.reprojected++
          if (!maxUpdated || item.updated_at > maxUpdated) maxUpdated = item.updated_at
        }
        cursor = page.has_more ? page.next_cursor : null
        // 只在成功处理完一页之后才推进水位/游标
        if (cursor) st.cursor = cursor
      } while (cursor)
      st.watermark = maxUpdated
    }

    /* ④ 删除/撤回判定：仅在"清单完整获取成功"之后执行（见上方 complete 校验） */
    for (const code of [...st.records.keys()]) {
      if (!remote.has(code)) {
        st.records.delete(code)   // 生产实现建议改为"标记撤回"，物理删除按双方约定
        stat.removed++
      }
    }

    /* ⑤ 轮次一致性：同步前后 digest 必须一致，否则重跑 */
    const tail = await fetchJson(`/sync/manifest?school_code=${encodeURIComponent(schoolCode)}`)
    st.scopeVersion = tail.scope_version
    st.projectionFingerprint = tail.projection_fingerprint
    st.digest = tail.digest
    st.cursor = null
    log(`[${schoolCode}] 第 ${round + 1} 轮完成：新增 ${stat.added} / 更新 ${stat.updated} / 撤回 ${stat.removed}（页数 ${pages}）`)
    if (tail.digest === head.digest) return { ...stat, rounds: round + 1 }
    log(`[${schoolCode}] 检测到本轮期间数据又发生变化（前后 digest 不一致），重跑一轮`)
    } catch (err) {
      // ⚠️ 关键约定：任何失败（含清单请求失败）都**不得修改本地数据**，也不得推进水位。
      if (err.status === 409) {
        log(`[${schoolCode}] 收到 409（${err.code || 'SCOPE_CHANGED'}）：授权/策略已变化，下一轮重新对账；本地数据保持不变`)
        st.cursor = null
        continue
      }
      log(`[${schoolCode}] 本轮失败（${err.status || 'NETWORK'}）：保留本地数据与水位，稍后重试`)
      return { ...stat, rounds: round + 1 }
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
      throw err
    }
    const json = await res.json()
    return json.data
  }
}

/* ─────────────────────────── Mock 服务端（默认，零网络）─────────────────────────── */
// 复刻平台对外契约的关键语义：digest 组成、游标分页、策略变化导致 409、清单完整性。
// 数据全部为合成数据；不连接任何生产环境。

function createMockServer() {
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
      r.updated_at = '2026-02-03T00:00:00+08:00'
      delete r.result.canteen
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
    const stats = await syncSchool({ schoolCode, fetchJson: mock.fetchJson, log: console.log })
    const st = schoolState(schoolCode)
    const inspectorLeft = [...st.records.values()].filter((r) => r.doc.inspector !== undefined).length
    const legacyCopyLeft = [...st.records.values()].filter((r) => r.doc.result && 'canteen' in r.doc.result).length
    console.log(`    结果：新增 ${stats.added} / 更新 ${stats.updated} / 撤回 ${stats.removed}；本地记录 ${st.records.size} 条；`
      + `含姓名的记录 ${inspectorLeft} 条；result.canteen 副本残留 ${legacyCopyLeft} 条`)
  }

  console.log('\n=== 失败语义验证（请求失败绝不当空清单）===')
  const st = schoolState(schoolCode)
  const before = st.records.size
  const failing = async () => { const e = new Error('模拟 500'); e.status = 500; throw e }
  await syncSchool({ schoolCode, fetchJson: failing, log: console.log })
  console.log(`失败前后本地记录数：${before} → ${schoolState(schoolCode).records.size}（必须相等）`)
  process.exit(before === schoolState(schoolCode).records.size ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('运行失败：', e); process.exit(1) })
}
