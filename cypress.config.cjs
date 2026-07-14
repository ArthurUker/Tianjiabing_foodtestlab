/**
 * Cypress 配置（P2-22 最小骨架）
 * - 项目 package.json 为 "type": "module"，本配置用 .cjs 后缀以便 Node 正确解析。
 * - baseUrl 指向本地静态站点（默认 8080，与部署脚本 FRONTEND_PORT 一致）；
 *   本地调试可用任意静态服务器托管仓库根目录，例如：npx http-server -p 8080
 * - supportFile 关闭以保持最小骨架，后续需要全局命令时再启用。
 */
const { defineConfig } = require('cypress');

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:8080',
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: false,
    video: false,
    screenshotOnRunFailure: false,
    setupNodeEvents(on, config) {
      // 预留：注册插件/自定义任务
      return config;
    },
  },
});
