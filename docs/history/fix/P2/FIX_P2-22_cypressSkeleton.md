# FIX-P2-22：Cypress E2E 测试脚本在 Windows Server 生产环境无法运行

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-22` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `cypress.config.cjs`（新增）、`cypress/e2e/smoke.cy.js`（新增） |
| **预估工时** | 0.5h |
| **关联问题** | P2-21（Jest 单测基建） |
| **状态** | ✅ 已完成（最小骨架搭建，配置可被 Node 正确解析） |
| **完成日期** | 2026-07-10 |

---

## 1. 问题描述

此前仓库内无 Cypress 配置与任何 E2E 脚本，`package.json` 虽有 `test:e2e` 系列脚本但无对应文件，E2E 测试无法运行。原问题描述提到"Windows Server 生产环境无法运行"，其根因主要是缺少可跨平台运行的测试骨架与配置。

## 2. 根因分析

缺少 `cypress.config.{js,cjs}` 与 `cypress/e2e/**/*.cy.js` 规范目录结构；且项目 `type:module` 下若用 `cypress.config.js` 会被当作 ESM 解析，易产生歧义。需以 `.cjs` 明确 CJS 语义，并采用相对 baseUrl + 平台无关路径，避免绑定 Windows 特定路径。

## 3. 修复方案（2026-07-10 实施）

1. 新增 `cypress.config.cjs`（`.cjs` 后缀确保 Node 在 `type:module` 下正确解析）：
   - `e2e.baseUrl: 'http://localhost:8080'`（与部署脚本 `FRONTEND_PORT` 一致）
   - `specPattern: 'cypress/e2e/**/*.cy.js'`、`supportFile: false`（保持最小骨架）
2. 新增 `cypress/e2e/smoke.cy.js` 冒烟用例：访问 `login.html` 断言页面可见且存在密码输入框；`cy.request('/index.html')` 断言 200。

## 4. 验收标准

- [x] 新增 `cypress.config.cjs`，`node -e require()` 可正确解析（baseUrl 读取成功）
- [x] 新增 `cypress/e2e/smoke.cy.js` 最小冒烟用例
- [x] 断言与 `login.html` 实际结构一致（存在 `input[type="password"]`）
- [x] 配置与用例跨平台，不依赖 Windows 特定路径

## 5. 回归测试要点（运行时维度，待独立执行）

- [ ] 本地启动静态服务器（如 `npx http-server -p 8080`）后执行 `npm run test:e2e`
- [ ] 登录页冒烟用例通过

## 6. 备注

- 本项属测试基础设施建设，非业务代码缺陷修复；当前为最小骨架，实际浏览器跑测作为独立运行时维度另行执行。
