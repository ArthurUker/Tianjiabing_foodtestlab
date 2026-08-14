/**
 * H1-ext / #6 · 前端角色同步回归测试（jsdom）
 *
 * 验证：syncRoleFromServer() 调用 /api/user/me 后，若服务器角色与本地不同，
 * 覆盖本地 user.role（内存 + 双写存储），使前端按钮渲染（PermissionService）
 * 与后端权威角色一致；静默失败不抛错。
 */

if (typeof global.Headers === 'undefined') {
  global.Headers = class Headers {
    constructor(init = {}) {
      this._map = new Map()
      if (init instanceof Headers) init._map.forEach((v, k) => this._map.set(k, v))
      else if (init && typeof init === 'object')
        for (const [k, v] of Object.entries(init)) this._map.set(k.toLowerCase(), String(v))
    }
    has(k) { return this._map.has(String(k).toLowerCase()) }
    get(k) { return this._map.get(String(k).toLowerCase()) ?? null }
    set(k, v) { this._map.set(String(k).toLowerCase(), String(v)) }
    forEach(cb) { this._map.forEach((v, k) => cb(v, k)) }
  }
}

import { AuthService } from '../js/services/AuthService.js'

const FAKE_JWT = 'aaaa.bbbb.cccc'

function jsonResponse(status, body = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => body }
}

function freshService(fetchImpl) {
  localStorage.clear()
  sessionStorage.clear()
  // 必须在 new AuthService 之前设置 global.fetch：AuthService 构造时会捕获原始 fetch 引用，
  // 供 syncRoleFromServer 绕过 401 刷新拦截器使用；测试需让捕获到的就是 mock 实现。
  if (typeof fetchImpl === 'function') global.fetch = jest.fn(fetchImpl)
  const svc = new AuthService('')
  svc.saveToken(FAKE_JWT, 1800)
  svc.saveUser({ id: 'u1', username: 'op1', role: 'operator', schoolCode: 'school_tjb' }, true)
  return svc
}

describe('#6 · 前端角色同步（syncRoleFromServer）', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  test('服务器角色升级为 manager 时，本地角色被覆盖', async () => {
    const svc = freshService(async (url) => {
      if (String(url).endsWith('/api/user/me'))
        return jsonResponse(200, { success: true, user: { id: 'u1', username: 'op1', role: 'manager', schoolCode: 'school_tjb' } })
      return jsonResponse(200, {})
    })

    const r = await svc.syncRoleFromServer()
    expect(r.success).toBe(true)
    expect(r.role).toBe('manager')
    expect(svc.getUser().role).toBe('manager')
    // localStorage 也更新
    expect(JSON.parse(localStorage.getItem('current_user')).role).toBe('manager')
  })

  test('服务器角色与本地一致时不重复修改', async () => {
    const svc = freshService(async (url) => {
      if (String(url).endsWith('/api/user/me'))
        return jsonResponse(200, { success: true, user: { id: 'u1', username: 'op1', role: 'operator', schoolCode: 'school_tjb' } })
      return jsonResponse(200, {})
    })
    const before = JSON.stringify(svc.getUser())
    const r = await svc.syncRoleFromServer()
    expect(r.role).toBe('operator')
    expect(JSON.stringify(svc.getUser())).toBe(before)
  })

  test('请求失败静默返回 success:false，不抛错、不清除登录', async () => {
    const svc = freshService(async () => { throw new Error('network down') })
    await expect(svc.syncRoleFromServer()).resolves.toEqual({ success: false })
    expect(svc.getToken()).toBe(FAKE_JWT)
    expect(svc.getUser().role).toBe('operator')
  })

  test('401 响应静默返回 success:false，不清除登录', async () => {
    const svc = freshService(async () => jsonResponse(401, { error: 'unauth' }))
    const r = await svc.syncRoleFromServer()
    expect(r.success).toBe(false)
    expect(svc.getToken()).toBe(FAKE_JWT)
  })
})
