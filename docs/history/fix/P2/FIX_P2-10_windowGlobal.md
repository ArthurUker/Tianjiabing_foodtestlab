# FIX-P2-10：main.js 与多模块通过 window.* 全局暴露函数/实例

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-10` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/main.js`、`js/modules/Dashboard.js`、`js/modules/Tableware.js`、`js/modules/Pathogen.js`、`js/modules/UserManagement.js`、`js/modules/AuditLog.js`、`js/utils/PerformanceMonitor.js`、`index.html`、`login.html` |
| **预估工时** | 2~3h（分两阶段） |
| **关联问题** | P1-07（已移除 `window.router`）、P1-20（已移除 Dashboard 的 `window.loadDashboardData`，但 `main.js` L254/L271 仍残留 `window.initDashboard`） |
| **状态** | ✅ 已完成（2026-07-10，阶段A+阶段B 全部落地，方案B）。全仓业务侧 `window.* =` 挂载=0、`onclick=` 内联=0、lint 0 错误。浏览器验收为独立运行时维度 |

---

## 1. 问题描述

代码审阅（RG_03a/c）发现：前端大量模块把函数或实例直接挂到 `window` 全局对象，供内联 HTML 事件处理器或跨模块调用。

经全仓 `grep "window\.\w+\s*="` 实证，业务侧主动挂载的全局对象如下（第三方库 `window.jspdf`/`window.mammoth`、运行环境 `window.location`/`window.addEventListener`/`window.URL` 等不在本问题范围）：

| 全局名 | 定义位置 | 被谁依赖 | 性质 |
|--------|----------|----------|------|
| `window.handleNavigation` | `main.js:71` | `index.html` 10+ 导航按钮 `onclick="window.handleNavigation('x')"` | 功能性（导航枢纽） |
| `window.renderQuickAccessData` | `main.js:24` | `index.html` 快速访问渲染内联脚本 | 功能性 |
| `window.initDashboard` | `main.js:254,271` | `main.js` 内部 `handleNavigation` | 功能性（P1-20 已移除 Dashboard 侧，main.js 残留） |
| `window.initAuditLog` | `main.js:324` | `main.js` 内部 `handleNavigation` | 功能性 |
| `window.userMgmt` | `UserManagement.js:402`（注释："暴露到全局以便内联事件使用"） | 用户管理模块内联处理器 | 功能性 |
| `window.auditLog` | `AuditLog.js:355` | 审计日志模块内联处理器 | 功能性 |
| `window.initTableware` | `Tableware.js:1296` | 餐具模块内联处理器 | 功能性 |
| `window.showTablewareDetail` | `Tableware.js:1185` | 餐具列表行内 `onclick` | 功能性 |
| `window.renderTablewareData` | `Tableware.js:47`（函数内闭包） | 餐具模块内部 | 功能性 |
| `window.initPathogen` | `Pathogen.js:1464` | 病原体模块内联处理器 | 功能性 |
| `window.perfMonitor` | `PerformanceMonitor.js:404` | 调试/性能面板 | 功能性 |
| `window.isQuickAccessModeOnInit` | `main.js:406` | 仅调试 | 调试变量 |
| `window.backupRendererScheduled/Executed` | `main.js:411,413` | 仅调试 | 调试变量 |
| `window._dashedPointPluginRegistered` | `Dashboard.js:1126` | 仅调试 | 调试变量 |
| `window.renderTableExecuted` / `window.lastTableRenderDebug` | `Tableware.js:740,768` | 仅调试 | 调试变量 |

**风险**：`window` 暴露扩大运行时被脚本篡改面，且增加跨模块耦合、不利于维护。其中 `window.handleNavigation` 被导航按钮内联依赖，是最关键的耦合点——若直接删除而不改 HTML，导航将整体失效。

---

## 2. 根因分析

历史代码采用"模块把函数/实例挂到 `window`，HTML 用 `onclick="window.xxx()"` 调用"的紧耦合模式（见 `UserManagement.js:402` 注释）。`P1-07` 已移除 `window.router`、`P1-20` 已移除 Dashboard 的 `window.loadDashboardData` 并改用 `CustomEvent`，但 `main.js` 残留 `window.initDashboard`，其余模块（Tableware/Pathogen/UserManagement/AuditLog/PerformanceMonitor）至今仍沿用旧模式。

---

## 3. 修复方案

> ⚠️ **报备（PROJECT_CONVENTIONS 规则二）**：本项涉及多文件，且 `index.html` / `main.js` 改动可能 >30%，按 `FIX_PLAN` "超范围确认" 规则，实施前须获人工确认。方案采"分阶段、最小化 diff"，避免全文重写。

### 方案 A（推荐，分阶段）

**阶段 A — 清理纯调试/计数器全局（零功能影响，可立即执行）**
直接删除以下仅用于调试的全局变量（无任何内联/跨模块依赖）：
- `main.js`：`window.isQuickAccessModeOnInit`、`window.backupRendererScheduled`、`window.backupRendererExecuted`
- `Dashboard.js`：`window._dashedPointPluginRegistered`
- `Tableware.js`：`window.renderTableExecuted`、`window.lastTableRenderDebug`

**阶段 B — 清理功能性全局（须 JS 与 HTML 同一次提交，避免导航断裂）**
1. 保留函数/类**本体**，不再挂 `window`；模块间调用改为 `import` 单例（如 `auditLog`、`userMgmt`、`perfMonitor` 已是模块导出实例，直接 import 即可）。
2. `main.js` 的 `handleNavigation` / `renderQuickAccessData` / `initDashboard` / `initAuditLog` 保持为模块内函数（已通过 `import` 引入），不再赋给 `window`。
3. `index.html` 导航按钮：`onclick="window.handleNavigation('x')"` → 改为 `<button data-target="x" class="nav-btn ...">`，由 `main.js` 在初始化时对导航容器做**事件委托**（`addEventListener('click', e => handleNavigation(e.target.dataset.target))`），本地调用 `handleNavigation`，无需全局。
4. 各模块内联处理器（`initTableware` / `showTablewareDetail` / `initPathogen` / `userMgmt.xxx` / `auditLog.xxx`）：在对应 JS 模块内用 `getElementById(...).addEventListener(...)` 绑定，移除 HTML 内联 `onclick`。

### 方案 B（备选，保守）
仅执行阶段 A（去调试变量），功能性全局保留并加注释标注"有意保留以兼容内联处理器"。风险最低，但 P2-10 仅部分闭环。

---

## 4. 验收标准

- [x] 全仓 `grep "window\."` 仅剩运行环境 API（`window.location` / `window.addEventListener` / `window.URL` / 第三方库 `window.jspdf` / `window.mammoth`）与调试 `window.__API_BASE_URL` 等既有白名单项，**无业务函数/实例挂载**（已实证：`window.* =` 业务挂载=0）
- [ ] 所有导航按钮切换模块正常（事件委托生效）— 运行时维度，待浏览器验收
- [ ] 看板、餐具/农残/食用油/肉蛋/病原体各模块、用户管理、审计日志功能正常（浏览器 Console 验证）— 运行时维度，待浏览器验收
- [x] `index.html` / `login.html` 内联 `onclick="window.xxx()"` 已全部移除或改为事件委托（已实证：`onclick=` 内联=0）

## 5. 回归测试要点

- [ ] 点击全部导航按钮（dashboard / tableware / pesticide / oil / lean-meat / pathogen / export / backup / user / audit）切换正常
- [ ] 快速访问模式下 `renderQuickAccessData` 正常渲染
- [ ] 访客进入、导出、备份恢复流程不受影响
- [ ] 餐具列表行"查看详情"（`showTablewareDetail`）正常

## 6. 备注

- ⚠️ 阶段 B 必须 HTML 与 JS **同一次提交**，否则导航/内联处理器断裂。
- `P1-20` 已移除 Dashboard 侧 `window.loadDashboardData`，`main.js` L254/L271 残留 `window.initDashboard` 随阶段 B 一并清理。
- 本项与 `P2-17`（模块继承化）正交：P2-17 改类结构，P2-10 改全局暴露，可独立推进。
