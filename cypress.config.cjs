/**
 * Cypress 配置（TD-Cypress-Coverage · W6）
 * - 项目 package.json 为 "type": "module"，本配置用 .cjs 后缀以便 Node 正确解析。
 * - baseUrl 指向本地静态站点（默认 8080，与部署脚本 FRONTEND_PORT 一致）。
 *   ⚠ 前端源码已迁入 frontend/，HTML 入口不再位于仓库根目录，
 *   因此静态服务器必须托管**构建产物 dist/**（其内布局与线上一致）：
 *       node scripts/build-static.js     # 先构建
 *       npx http-server dist -p 8080     # 再托管 dist
 *   若仍托管仓库根目录，cy.visit('/login.html') 会 404。
 * - supportFile 已启用（cypress/support/e2e.js），提供 loginAs / waitForApp 命令。
 * 前置：后端 + PostgreSQL 已启动并 seed（同 smome.cy.js 冒烟用例）。
 */
const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:8080',
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',
    video: false,
    screenshotOnRunFailure: false,
    setupNodeEvents(on, config) {
      // 预留：注册插件/自定义任务
      return config;
    },
  },
});
