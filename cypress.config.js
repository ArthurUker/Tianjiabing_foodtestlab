/**
 * Cypress 配置文件
 * E2E 端到端测试框架配置
 */

module.exports = {
  projectId: 'tianjiabing-foodtestlab',
  
  // 基础 URL
  baseUrl: 'http://localhost:8080',
  
  // 浏览器配置
  browser: 'chrome',
  headless: false,
  
  // 视口大小
  viewportWidth: 1280,
  viewportHeight: 720,
  
  // 超时配置
  defaultCommandTimeout: 10000,
  requestTimeout: 10000,
  responseTimeout: 10000,
  
  // 视频和截图配置
  video: true,
  videoCompression: 32,
  screenshotOnRunFailure: true,
  
  // 测试隔离
  testIsolation: true,
  
  // 重试配置
  retries: {
    runMode: 2,
    openMode: 0
  },
  
  // 报告配置
  reporter: 'mochawesome',
  reporterOptions: {
    reportDir: 'cypress/reports',
    reportFilename: 'report.html',
    overwrite: true,
    html: true,
    json: true
  },
  
  // E2E 测试配置
  e2e: {
    setupNodeEvents(on, config) {
      // 实现节点事件监听
      on('task', {
        log(message) {
          console.log(message);
          return null;
        },
        
        // 清理本地存储
        clearLocalStorage() {
          localStorage.clear();
          return null;
        },
        
        // 清理 IndexedDB
        clearIndexedDB() {
          const databases = indexedDB.databases ? indexedDB.databases() : [];
          databases.forEach(db => {
            indexedDB.deleteDatabase(db.name);
          });
          return null;
        }
      });
    }
  },
  
  // 环境变量
  env: {
    apiUrl: 'http://localhost:3000/api',
    baseUrl: 'http://localhost:8080',
    testUser: 'testuser@example.com',
    testPassword: 'TestPass123!'
  },
  
  // 文件观察者配置
  fileServerFolder: '.',
  fixturesFolder: 'cypress/fixtures',
  screenshotsFolder: 'cypress/screenshots',
  videosFolder: 'cypress/videos',
  downloadsFolder: 'cypress/downloads',
  
  // 模块别名
  componentFolder: 'cypress/component',
  specPattern: 'cypress/e2e/**/*.cy.js',
  
  // 其他配置
  chromeWebSecurity: false,
  waitForAnimations: true
};
