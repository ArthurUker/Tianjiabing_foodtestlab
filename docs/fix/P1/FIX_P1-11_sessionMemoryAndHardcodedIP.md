# FIX-P1-11：SessionManager 会话全存内存 + IP 硬编码

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-11` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `js/services/SessionManager.js`、`backend/server.js`、`js/services/AuthService.js` |
| **预估工时** | 2h |
| **关联问题** | - |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-06-30 |

---

## 1. 问题描述

原描述：SessionManager 会话全存内存且 IP 硬编码。

经阶段 A 只读核验，实际发现：
- **会话存储**：前端 `SessionManager.sessions` 为内存数组（`js/services/SessionManager.js:12`），页面刷新即丢失。
- **IP 硬编码**：
  - 后端 `server.js:49-60` `parseAllowedOrigins()` fallback 默认值含 `localhost`/`127.0.0.1`/公网 `159.75.106.179`。
  - 前端 `AuthService.js:492` `LOCAL_API_URL = 'http://localhost:3002'`。
  - 前端 `SessionManager.js:93` `getClientIP()` 返回模拟 `127.0.0.1`。

## 2. 根因分析

1. **会话存储**：`SessionManager` 为前端纯内存实现，`syncToBackend()` / `syncSessions()` 为 TODO 占位（第 241-266 行），后端无 session API。但**已具备 TTL（30 分钟）与最大并发会话数（5）**，并非"无过期机制"。后端认证采用 JWT 无状态（`UserManager.verifyToken`），重启不丢失登录态。
2. **IP 硬编码**：
   - 后端 CORS fallback 默认值是开发便利遗留，**已有 `process.env.CORS_ORIGIN` 覆盖逻辑**（`server.js:50,63-66`），`.env:4` 已配置生产 origin。
   - 前端 API base **已有 `window.__API_BASE_URL` 覆盖 + 生产同源 fallback**（`AuthService.js:496-510`）。
   - `getClientIP()` 的 `127.0.0.1` 是未实现的模拟占位值，非配置硬编码。

## 3. 修复方案

### 路径 C4（已实施）—— 已通过配置管理，仅添加注释

经预检，硬编码 IP 已通过环境变量/全局变量/同源 fallback 管理，P1-11 描述与实际部分不符（会话已有 TTL，IP 已有配置管理）。按约束"代码阶段仅允许修改与 SessionManager 直接相关的文件"，仅修改 `js/services/SessionManager.js`：

- **构造函数（第 12-18 行）**：添加 P1-11 注释，标注会话存储机制、已有 TTL/最大会话数、遗留隐患（inactive 会话不从数组移除）、后端 session API 待实现状态。
- **getClientIP()（第 99-101 行）**：添加 P1-11 注释，说明 `127.0.0.1` 为模拟占位值而非配置硬编码，指向后端 session API 待实现。

未修改的文件（因约束限制非 SessionManager 直接相关，已登记技术债）：
- `backend/server.js`：CORS fallback 默认值含公网 IP，实际运行已由 `CORS_ORIGIN` 环境变量覆盖。
- `js/services/AuthService.js`：`LOCAL_API_URL` 已有 `window.__API_BASE_URL` 覆盖与同源 fallback。

### 未采用的路径

- **C1（会话 TTL）**：不执行。`sessionTimeout = 30 * 60 * 1000`（第 14 行）+ `checkSessionExpiry()`（第 189-207 行）已存在。
- **C2（后端监听地址）**：不执行。`app.listen(PORT)` 已用 `process.env.PORT || 3002`（第 29 行），无硬编码监听 IP。
- **C3（前端 API baseURL）**：不执行。已有 `window.__API_BASE_URL` 覆盖 + 同源 fallback。

## 4. 验收标准

- [x] SessionManager.js 添加 P1-11 注释，标注会话存储与 IP 现状
- [x] `git diff --stat` 确认修改范围仅限 `js/services/SessionManager.js`（+10/-1）
- [x] 会话 TTL 与最大会话数机制已确认存在（无需新增）
- [x] 后端 CORS / 前端 API base 已确认通过环境变量/全局变量管理

## 5. 功能影响

- **重启丢失会话**：前端 `SessionManager.sessions` 内存数组页面刷新即丢失，但**不影响登录态**（JWT token 存 localStorage，后端无状态验证）。后端服务重启不影响任何已登录用户。
- **IP 变更**：后端 CORS 通过 `CORS_ORIGIN` 环境变量调整（`.env`），前端 API base 通过 `window.__API_BASE_URL` 或同源代理，均无需改代码。
- **getClientIP**：当前返回模拟值，会话记录中的 ipAddress 字段不真实（待后端 session API 实现）。

## 6. 技术债

| 技术债 ID | 描述 | 优先级 |
|-----------|------|--------|
| `TD-P2-15` | 评估迁移至 Redis 会话存储，支持多实例部署与真实 IP 记录。当前前端纯内存会话 + 后端无 session API，无法跨实例共享会话状态、无法记录真实客户端 IP。同时评估：① inactive 会话从数组清理（防止内存增长）；② 后端实现 session API 使 `syncToBackend`/`syncSessions`/`getClientIP` 落地；③ 统一配置中心管理 CORS origin（移除 server.js fallback 中的公网 IP）。 | 🟢 P2 |
