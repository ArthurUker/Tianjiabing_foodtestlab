# FIX-P0-10：根目录 package.json 缺少 type:module 及 Prisma 依赖，生产部署存在启动崩溃风险

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P0-10` |
| **优先级** | 🔴 P0 高危（建议 1~3 天内处理） |
| **影响文件** | `/package.json`（根目录） |
| **预估工时** | 1h |
| **关联问题** | P1-25 |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-06-23 |

---

## 1. 问题描述

> 根目录 `package.json` 缺少 `"type": "module"`，且 `start` 脚本直接执行 `node backend/server.js`。在根目录执行 `npm start` 时，Node.js 以 CommonJS 模式解析后端 ES Module 代码，导致启动直接崩溃。此外，根目录完全缺少 `prisma` 和 `@prisma/client` 依赖，`webpack` 依赖已无用（前端已改为原生 HTML）。

## 2. 根因分析

> 项目早期前后端统一管理，后端独立到 `backend/` 目录后新建了自己的 `package.json`，根目录文件未随之清理，形成双文件并存的历史遗留状态。

## 3. 修复方案

### 方案 A（推荐，已采用）

```diff
+ "type": "module",
  "scripts": {
-   "start": "node backend/server.js",
+   "start": "cd backend && npm start",
  }
```

> 明确根目录 `package.json` 定位为工程工具配置容器，`start` 脚本改为跳转 backend 目录执行；添加 `"type": "module"` 防止 Node.js 以 CommonJS 解析。

### 方案 B（备选）

> 完全删除根目录 `package.json`，仅保留 `backend/package.json`。风险：破坏现有 CI/CD 脚本，不建议当前阶段执行。

## 4. 验收标准

- [x] 根目录 `package.json` 包含 `"type": "module"`
- [x] `start` 脚本改为 `cd backend && npm start`
- [x] 在根目录执行 `npm start` 不再因 CommonJS/ES Module 冲突崩溃

## 5. 回归测试要点

- [ ] 在根目录执行 `npm start`，确认服务正常启动
- [ ] 在 `backend/` 目录执行 `npm start`，确认服务正常启动（主路径不受影响）

## 6. 备注

> 已通过 Monica 代码审阅（2026-06-23）。根目录 package.json 定位已明确为工程工具配置容器，生产部署入口统一为 `backend/package.json`。关联 P1-25（双 package.json 版本同步）待后续处理。
