# FIX-P1-13：CORS_ORIGIN 配置在代码与环境变量间不一致

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-13` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `backend/server.js`, `.env.example` |
| **预估工时** | 0.5h |
| **关联问题** | - |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-06-30 |
| **代码提交** | `f8cf588` |

---

## 1. 问题描述

**FIX_PLAN 原始描述**：`CORS_ORIGIN` 配置在代码与环境变量间不一致。

**详细描述（RG_03b_ISSUES_P1.md）**：`CORS_ORIGIN` 在 `.env.example` 中未包含生产 IP，与 `server.js` 硬编码不一致。

**实际核验发现**：

1. **`backend/server.js` line 59**：`parseAllowedOrigins()` 函数在 `CORS_ORIGIN` 环境变量未设置时，返回的 fallback 默认列表中硬编码了生产 IP `http://159.75.106.179:8082`。生产 IP 出现在源代码中存在信息泄露风险，且 IP 变更时需要修改代码而非配置。

2. **`.env.example` line 28**：`CORS_ORIGIN=http://localhost:8082,http://127.0.0.1:8082` — 仅包含本地开发地址，未包含生产 IP 示例。注释中虽有 `# 生产环境示例: http://服务器公网IP:8082` 占位说明，但缺少具体 IP 示例，部署人员可能遗漏配置。

3. **三者不一致**：
   - `server.js` fallback 列表：8 个 origin（含生产 IP）
   - `.env.example`：2 个 origin（仅本地）
   - `backend/.env`（运行时）：4 个 origin（含生产 IP）

## 2. 根因分析

`parseAllowedOrigins()` 函数设计初衷是当 `CORS_ORIGIN` 环境变量未设置时提供开发便利的 fallback。但 fallback 列表中混入了生产环境 IP `159.75.106.179:8082`，导致：

- 生产 IP 硬编码在版本控制的源代码中
- 代码 fallback 列表与 `.env.example` 配置模板不一致
- 生产 IP 变更需要修改源代码而非环境变量，违反配置外部化原则

## 3. 修复方案

### 方案 A（已实施）

**`backend/server.js`**（`f8cf588`）：
- 移除 `parseAllowedOrigins()` fallback 列表中的 `'http://159.75.106.179:8082'`
- 保留 `localhost` / `127.0.0.1` 开发地址作为 fallback（本地开发便利）
- 添加注释 `// P1-13: 移除硬编码生产 IP，生产环境必须通过 CORS_ORIGIN 环境变量配置`

**`.env.example`**（`f8cf588`）：
- `CORS_ORIGIN` 行补充生产 IP 示例 `http://159.75.106.179:8082`
- 更新注释为具体 IP 示例：`# 生产环境必须填写实际服务器公网 IP（例如: http://159.75.106.179:8082）`
- 添加 `# P1-13: 生产 IP 通过 .env 配置，不再硬编码在 server.js 中`

### 方案 B（备选）

> 暂无备选方案。

## 4. 验收标准

- [x] `server.js` fallback 列表中不再包含生产 IP `159.75.106.179`
- [x] `.env.example` 中 `CORS_ORIGIN` 包含生产 IP 示例
- [x] 本地开发环境（未设置 `CORS_ORIGIN`）仍可通过 localhost fallback 正常工作
- [x] 生产环境 `.env` 已设置 `CORS_ORIGIN`，不受 fallback 变更影响
- [x] `git diff --stat` 确认修改范围仅限 `backend/server.js` + `.env.example`

## 5. 回归测试要点

- [ ] 本地开发：未设置 `CORS_ORIGIN` 时，`http://localhost:8082` 跨域请求正常
- [ ] 生产环境：`.env` 设置 `CORS_ORIGIN` 后，`http://159.75.106.179:8082` 跨域请求正常
- [ ] CORS 拒绝：未授权的 origin 请求被正确拒绝并记录 `CORS denied origin` 日志

## 6. 备注

**额外发现（不在 P1-13 修复范围）**：
- `deploy/pm2/ecosystem.config.cjs:16` 硬编码 `CORS_ORIGIN: 'http://159.75.106.179:8081'`（端口 8081 与实际 8082 不一致）
- `deploy/nginx/foodtestlab-low-spec.conf:8,17` 硬编码生产 IP
- `backend/.env` 同时定义 `CORS_ORIGIN`（单数，代码读取）和 `CORS_ORIGINS`（复数，代码未读取，为无效配置）

以上已登记为技术债 TD-P2-17。
