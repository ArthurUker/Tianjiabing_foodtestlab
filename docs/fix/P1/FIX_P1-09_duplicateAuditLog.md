# FIX P1-09：两套并行审计日志机制并存，职责边界混乱

## 问题描述
项目存在 **3 套**审计日志机制并存，职责边界混乱：
- ① 后端 DB（`UserManager.logLogin`/`logFailedLogin`）— 仅记录登录/登录失败，缺 `ip_address`
- ② 后端 DB API（`POST /api/audit-logs` ← 前端 `AuditLogService.logOperation`）— 通用操作，字段完整
- ③ 前端 localStorage（`AuditLogger.logOperation` ← `Storage.js`）— 本地离线日志，结构完全不同

## 根因
中间件与业务代码各自独立实现，缺乏统一审计接口。三套机制存储位置不同（DB 表 vs localStorage），字段结构不一致。

## 修复内容（C3 路径：仅登记技术债，不改业务逻辑）

经核验，三套机制**无同表重复写入同一操作**的情况：
- 登录日志仅走 ①
- 通用操作仅走 ②
- 本地操作仅走 ③

部分操作（如病原体记录删除）同时走 ②（DB）和 ③（localStorage），但存储位置不同，不构成同表重复。

因此采用 C3 路径：在 `backend/server.js` 顶部添加技术债登记注释，不改业务逻辑。

| 文件 | 修改 |
|------|------|
| `backend/server.js` L1–6 | 添加 P1-09 注释：3 套审计机制说明 + TD-P2-13 引用 |

## 功能影响
无。仅添加注释，不改业务逻辑，不影响现有审计记录。

## 遗留技术债
- **TD-P2-13**：设计统一审计日志接口，合并三套机制。建议方向：
  - 机制 ① 补齐 `ip_address`/`resource_type` 字段，统一走 `POST /api/audit-logs`
  - 机制 ③ localStorage 日志可作为离线缓存，上线后同步到 DB
  - 统一 `logOperation(action, resource_type, resource_id, details)` 接口签名

## 提交信息
- fix(P1-09): 登记三套审计日志机制并存技术债TD-P2-13（cad5b7d）
- docs(P1-09): v0.19 文档闭环
