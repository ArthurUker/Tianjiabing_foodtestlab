/**
 * 登录流程 E2E（TD-Cypress-Coverage · W6）
 * 前置：后端 + PostgreSQL 已启动并 seed（admin/admin123，dev 环境）。
 */

describe('登录流程', () => {
  it('管理员凭正确凭据登录后进入主应用', () => {
    cy.visit('/login.html')
    cy.get('#username').should('exist').type('admin')
    cy.get('#password').should('exist').type('admin123')
    cy.get('#loginBtn').click()

    // 登录成功应跳转主应用（URL 含 index.html）
    cy.url({ timeout: 10000 }).should('include', 'index.html')
    cy.get('body').should('be.visible')
  })

  it('错误密码登录被拒绝且不跳转', () => {
    cy.visit('/login.html')
    cy.get('#username').type('admin')
    cy.get('#password').type('wrong-password')
    cy.get('#loginBtn').click()

    // 登录失败应停留在登录页
    cy.url({ timeout: 10000 }).should('include', 'login.html')
  })
})
