/**
 * P2-22 Cypress 冒烟测试（最小骨架）
 *
 * 目的：验证 Cypress E2E 框架可运行，并对登录页做最基本的加载断言。
 * 运行前置：需先在本地启动静态服务器托管仓库根目录（baseUrl=http://localhost:8080），例如：
 *   npx http-server -p 8080
 * 然后执行：npm run test:e2e  或  npm run test:e2e:open
 */

describe('冒烟测试：登录页可访问', () => {
  it('访问 login.html 并加载成功', () => {
    cy.visit('/login.html');
    cy.get('body').should('be.visible');
    // 登录页应包含密码输入框（最小结构断言）
    cy.get('input[type="password"]').should('exist');
  });

  it('访问首页 index.html 返回 200', () => {
    cy.request('/index.html').its('status').should('eq', 200);
  });
});
