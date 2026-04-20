/**
 * Cypress 支持文件
 * 全局配置、自定义命令和钩子
 */

// 导入 Cypress-testing-library
import '@testing-library/cypress/add-commands';

// 自定义登录命令
Cypress.Commands.add('login', (email, password) => {
  cy.visit('/');
  
  // 等待登录表单加载
  cy.get('[data-testid="login-form"]', { timeout: 5000 }).should('be.visible');
  
  // 填充登录表单
  cy.get('[data-testid="email-input"]').type(email);
  cy.get('[data-testid="password-input"]').type(password);
  
  // 点击登录按钮
  cy.get('[data-testid="login-button"]').click();
  
  // 等待登录完成
  cy.url().should('not.include', '/login');
});

// 自定义登出命令
Cypress.Commands.add('logout', () => {
  cy.get('[data-testid="user-menu"]').click();
  cy.get('[data-testid="logout-button"]').click();
  cy.url().should('include', '/login');
});

// 自定义创建测试记录命令
Cypress.Commands.add('createTestRecord', (data) => {
  cy.get('[data-testid="create-button"]').click();
  
  // 填充表单字段
  Object.entries(data).forEach(([key, value]) => {
    cy.get(`[data-testid="input-${key}"]`).type(value);
  });
  
  // 提交表单
  cy.get('[data-testid="submit-button"]').click();
  
  // 等待成功提示
  cy.get('[data-testid="success-message"]', { timeout: 5000 }).should('be.visible');
});

// 自定义检查通知命令
Cypress.Commands.add('checkNotification', (message, type = 'success') => {
  cy.get(`[data-testid="notification-${type}"]`)
    .should('be.visible')
    .should('contain', message);
});

// 自定义等待数据加载命令
Cypress.Commands.add('waitForDataLoaded', () => {
  cy.get('[data-testid="loading-spinner"]').should('not.exist');
  cy.get('[data-testid="data-table"]', { timeout: 10000 }).should('be.visible');
});

// 自定义检查错误信息命令
Cypress.Commands.add('checkError', (message) => {
  cy.get('[data-testid="error-message"]')
    .should('be.visible')
    .should('contain', message);
});

// 自定义上传文件命令
Cypress.Commands.add('uploadFile', (fileName) => {
  cy.get('[data-testid="file-input"]').attachFile(fileName);
});

// 自定义导出数据命令
Cypress.Commands.add('exportData', (format = 'csv') => {
  cy.get('[data-testid="export-button"]').click();
  cy.get(`[data-testid="export-${format}"]`).click();
});

// 全局钩子
beforeEach(() => {
  // 清理本地存储
  cy.window().then(win => {
    win.localStorage.clear();
  });
  
  // 清理 IndexedDB
  cy.window().then(win => {
    const dbs = ['foodtestlab', 'cache', 'offline'];
    dbs.forEach(dbName => {
      const request = win.indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => console.log(`Cleared ${dbName}`);
    });
  });
});

afterEach(() => {
  // 检查控制台错误
  cy.on('uncaught:exception', (err) => {
    // 允许特定的错误继续
    if (err.message.includes('ResizeObserver loop')) {
      return false;
    }
    throw err;
  });
});

// 全局错误处理
Cypress.on('uncaught:exception', (err, runnable) => {
  // 返回 false 防止 Cypress 失败测试
  if (err.message.includes('Network error')) {
    return false;
  }
  return true;
});
