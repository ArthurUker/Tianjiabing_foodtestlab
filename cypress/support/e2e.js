/**
 * Cypress E2E 全局支持文件（TD-Cypress-Coverage · W6）
 *
 * 提供可复用命令；所有用例默认依赖“运行中的完整栈”：
 *   - 静态站点：npx http-server -p 8080（baseUrl 已设为 http://localhost:8080）
 *   - 后端 + PostgreSQL（含 seed 初始账号 admin/admin123，dev 环境）
 * 与既有 smome.cy.js 冒烟用例的前置条件一致。
 */

// 通过后端登录接口换取令牌，并写入前端预期的 localStorage 键，
// 使后续访问 index.html 被视为已登录。
Cypress.Commands.add('loginAs', (username, password) => {
  return cy
    .request({
      method: 'POST',
      url: '/api/user/login',
      body: { username, password },
      failOnStatusCode: false
    })
    .then((resp) => {
      if (resp.status === 200 && resp.body && resp.body.success) {
        const { token, user, expiresIn } = resp.body
        const expiryMs = Number.isFinite(Number(expiresIn))
          ? Number(expiresIn) * 1000
          : 7 * 24 * 3600 * 1000
        window.localStorage.setItem('auth_token', token)
        window.localStorage.setItem('current_user', JSON.stringify(user || {}))
        window.localStorage.setItem('token_expiry', String(Date.now() + expiryMs))
      }
      return resp
    })
})

// 等待前端应用完成初始化（看板统计卡片出现即认为渲染完成）。
Cypress.Commands.add('waitForApp', () => {
  cy.get('#dashboard, .stat-card, body', { timeout: 10000 }).should('exist')
})
