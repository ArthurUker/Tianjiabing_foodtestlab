// P3-W4-T01 · 客户端同步语义测试的 jsdom 支撑（非测试文件：不带 .test 后缀，不会被 runner 收集）
//
// 说明：本仓库 root Jest 的 setupFiles 含 PG 隔离门禁（缺 TEST_DATABASE_URL 即 refuse），
// 而 W4 的客户端状态机测试不需要数据库 —— 因此在 node:test 下用 jsdom 自建浏览器环境，
// 只验证前端模块（Storage/AdaptiveUploadQueue/SyncScope/SyncStateMachine）与合成 fetch。

import { createRequire } from 'node:module'

const requireFromHere = createRequire(import.meta.url)

export function installJsdom({ url = 'http://localhost/' } = {}) {
    // jsdom 是 CJS 依赖：经 createRequire 引入（本文件是 ESM）
    const { JSDOM } = requireFromHere('jsdom')
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url })
    const w = dom.window
    globalThis.window = w
    globalThis.document = w.document
    globalThis.localStorage = w.localStorage
    globalThis.sessionStorage = w.sessionStorage
    globalThis.history = w.history
    globalThis.location = w.location
    globalThis.atob = w.atob
    globalThis.CustomEvent = w.CustomEvent
    if (!globalThis.AbortController) globalThis.AbortController = w.AbortController
    // 注意：不覆盖 Node 24 的 globalThis.crypto（getter-only；Node 自带 randomUUID 可满足 Storage.save）
    return w
}


/** 模拟同一浏览器窗口切换学校（URL 路径首段 = schoolCode，与生产约定一致）。 */
export function setSchool(code) {
    globalThis.window.history.pushState({}, '', code ? `/${code}/index.html` : '/')
}

/** 模拟某学校的登录态（AuthService 的命名空间键约定）。 */
export function login(tenant, subject) {
    if (tenant) {
        globalThis.localStorage.setItem(`current_user__${tenant}`, JSON.stringify(subject))
        globalThis.localStorage.setItem(`auth_token__${tenant}`, 'mock-token')
    } else {
        globalThis.localStorage.setItem('current_user', JSON.stringify(subject))
        globalThis.localStorage.setItem('auth_token', 'mock-token')
    }
}

export function resetBrowserState() {
    globalThis.localStorage.clear()
    globalThis.sessionStorage.clear()
    setSchool(null)
    delete globalThis.fetch
}

export function jsonResponse(status, body = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
        headers: { get: () => null },
    }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function waitUntil(fn, { timeout = 5000, interval = 10 } = {}) {
    const t0 = Date.now()
    for (;;) {
        let ok = false
        try { ok = !!fn() } catch { ok = false }
        if (ok) return true
        if (Date.now() - t0 > timeout) return false
        await sleep(interval)
    }
}

/** 上传队列空转判定（连接层） */
export async function waitUploadIdle(storage, opts = {}) {
    return waitUntil(() => {
        const q = storage._uploadQueue
        return storage._isProcessingQueue === false && q._inFlight === 0 && q._queueList.length === 0
    }, opts)
}

export const W4_CONST = {
    OIL_CTX: { testDate: '2026-09-01', canteen: '一食堂', inspector: '甲' },
    STORAGE_CONFIG: {
        apiBaseUrl: '/api/records',
        queueBatchDelayMs: 10,
        queueBatchSize: 5,
        minRetryDelayMs: 5,
        maxRetryDelayMs: 25,
        initialInterval: 5,
        minInterval: 5,
        maxInterval: 25,
    },
}
