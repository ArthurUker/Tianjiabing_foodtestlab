# FIX-P1-27：auditRoutes.js 路由顺序冲突 + 前后端审计日志 API 路径不匹配

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-27` |
| **优先级** | 🟠 P1 重要 |
| **影响文件** | `backend/routes/auditRoutes.js`、`js/services/AuditLogService.js` |
| **预估工时** | 待评估 |
| **关联问题** | 原 P1-01（重新登记） |
| **状态** | ✅ 已完成（静态验证 + 运行时验证均通过） |
| **完成日期** | 2026-07-03 |

---

## 1. 问题描述

本问题由原 P1-01（auditRoutes.js 路由注册顺序冲突）重新登记而来，并合并核验 P1-01 过程中新发现的前后端 API 路径不匹配问题，共三个子问题：

### 子问题 (1)：路由注册顺序违反 Express 最佳实践（原 P1-01 遗留）

`backend/routes/auditRoutes.js` 中静态路由 `GET /stats/summary`（L154）与 `DELETE /cleanup`（L201）注册在动态参数路由 `GET /:logId`（L114）之后。按 Express 路由按注册顺序匹配的机制，静态路由应注册在动态参数路由之前，否则存在被动态路由意外拦截的风险。

当前实际影响：`/stats/summary` 为两段路径、`/cleanup` 为 DELETE 方法，均不会被单段 GET 的 `/:logId` 实际拦截，故**尚未触发实际功能性 bug**，但属于潜在风险与最佳实践违反。原 P1-01 修复未落地（路由顺序至今未调整，`FIX_P1-01_auditRouteOrder.md` 文档仍为空模板）。

### 子问题 (2)：前后端审计日志 API 路径不匹配（真实 404 bug）

`js/services/AuditLogService.js` 的两个方法调用路径与后端 `backend/routes/auditRoutes.js` 实际注册路由不匹配，必然导致 404，审计日志的统计与导出功能当前实际不可用：

| 前端调用（AuditLogService.js） | 后端实际路由（auditRoutes.js） | 匹配情况 |
|---|---|---|
| `GET /api/audit-logs/stats/${date}`（L118，getStats） | `GET /api/audit-logs/stats/summary`（L154，无 date 路径参数） | ❌ 路径不匹配，404 |
| `GET /api/audit-logs/export?${params}`（L159，exportLogs） | 无对应路由 | ❌ 路由不存在，404 |
| `POST /api/audit-logs/cleanup`（L200，cleanup） | `DELETE /api/audit-logs/cleanup`（L201） | ❌ HTTP方法不匹配，404 |

### 子问题 (3)：cleanup 方法 HTTP 方法不匹配（真实 404 bug）

`js/services/AuditLogService.js` 的 `cleanup()` 方法（L200）以 `POST /api/audit-logs/cleanup` 调用，而后端 `backend/routes/auditRoutes.js`（L201）注册的对应路由为 `DELETE /api/audit-logs/cleanup`，HTTP 方法不匹配，必然导致 404，审计日志的清理功能当前实际不可用。

## 2. 根因分析

### 子问题 (1) 根因

`auditRoutes.js` 由提交 `c8561b4`（feat: 实现完整的审计日志系统）初次引入，路由按"创建→查询→详情→统计→清理"的业务逻辑顺序注册，未遵循 Express"静态路由优先于动态参数路由"的注册惯例。此后仅 `11fa93e`（P0-02 统一认证中间件）修改过本文件，未涉及路由顺序。原 P1-01 在 `9b34bb1`（fix:修复计划）批次中仅登记了空模板文档，从未实施代码修复。

### 子问题 (2) 根因

前后端审计日志模块分别由不同提交引入且未做接口契约对齐：

- 后端 `auditRoutes.js`（`c8561b4`）统计路由设计为 `/stats/summary`（固定路径，无日期参数），且未实现导出路由；
- 前端 `AuditLogService.js` 的 `getStats(date)` 按 `/stats/${date}` 拼接（带日期路径参数），`exportLogs()` 调用 `/export` 路由，二者均无后端对应实现。

属前后端接口契约不一致的功能性缺陷，非单纯代码风格问题。

### 子问题 (3) 根因

前端 `cleanup()` 使用 POST 语义调用清理接口，后端则将清理路由注册为 DELETE 方法，双方对"清理"操作的 HTTP 方法约定不一致。属前后端接口契约不一致的功能性缺陷。

## 3. 修复方案（2026-07-03 实施）

> 采用混合方案：后端路由重排 + 新增 export 路由，前端对齐后端路由路径与 HTTP 方法。

### 子问题 (1) 修复：路由注册顺序调整

`backend/routes/auditRoutes.js` 中将三个静态路由 `GET /stats/summary`、`GET /export`（新增）、`DELETE /cleanup` 的注册语句上移至动态参数路由 `GET /:logId` 之前，遵循 Express"静态路由优先于动态参数路由"的最佳实践。

### 子问题 (2) 修复：前后端 API 路径对齐

采用方向 A + 后端补实现 export：
- **getStats**：前端 `AuditLogService.getStats(date)` URL 从 `/api/audit-logs/stats/${date}` 改为 `/api/audit-logs/stats/summary`，date 参数转为 query param（`?date=YYYY-MM-DD`）传递；同时修正返回值字段名 `data.stats` → `data.data`（后端返回 `{ success, data: {...} }`，原前端取 `data.stats` 导致恒为空对象）。
- **exportLogs**：后端新增 `GET /api/audit-logs/export` 路由，支持 `start_date`/`end_date` query 参数过滤，返回 UTF-8 BOM CSV（`Content-Type: text/csv; charset=utf-8`），前端 `exportLogs()` 调用路径无需修改即匹配。

### 子问题 (3) 修复：cleanup HTTP 方法统一

前端 `AuditLogService.cleanup()` 的 fetch method 从 `POST` 改为 `DELETE`，对齐后端 `DELETE /api/audit-logs/cleanup` 路由（RESTful 规范，清理属删除语义）。

### 附加发现（未修复，登记为新问题 P1-28）

修复过程中发现 `AuditLogService.logOperation()` 发送字段名 `table_name`/`record_id` 与后端期望的 `resource_type`/`resource_id` 不匹配，后端解构得到 `undefined`，写入 DB 时这两个字段为 null。影响范围：Dashboard/Tableware/BackupRestore/Pathogen 共 11 处调用。此问题不在 P1-27 的 3 个子问题范围内，登记为 P1-28 待处理。

## 4. 验收标准

- [x] `auditRoutes.js` 静态路由均注册在 `/:logId` 之前（stats/summary、export、cleanup 均前移）
- [x] 前端 `getStats` / `exportLogs` 调用与后端路由一致，不再 404
- [x] 前端 `cleanup()` 调用与后端 HTTP 方法一致，不再 404
- [x] 审计日志统计与导出功能实测可用（静态验证：URL/方法/字段名均已对齐；运行时验证已通过）
  - 运行时验证已通过，验证记录（2026-07-04 执行）：
    - `GET /api/audit-logs/stats/summary` → HTTP 200，`data.data` 结构正确（`{ totalLogs: 16, actionStats: [...], topUsers: [...] }`），验证子问题2 getStats 路径
    - `DELETE /api/audit-logs/cleanup?days=365` → HTTP 200，`{ success: true, message: "已删除 0 条365天前的日志" }`，验证子问题3 cleanup 方法对齐（days=365 未误删近期数据）
    - `GET /api/audit-logs/export` → HTTP 200，`Content-Type: text/csv; charset=utf-8`，CSV 含表头与数据行，验证新增 export 路由
  - ⚠️ date 参数当前为预留字段：后端 `/stats/summary` 路由尚未实现按日期过滤（`groupBy` 查询无 `created_at` 日期范围条件），前端 `getStats(date)` 传入的日期参数当前被后端忽略，实际返回始终是全库统计而非指定日期统计。如需此功能需后续扩展，已登记为 P2-25（预估 1h，需在后端 `groupBy` 查询中增加 `created_at` 的日期范围过滤）

## 5. 回归测试要点

- [ ] `GET /api/audit-logs/:logId` 单条详情查询不受路由顺序调整影响
- [ ] `GET /api/audit-logs/stats/summary` 返回正确统计结构
- [ ] 导出功能（若实现）返回合法 CSV 且权限校验生效

## 6. 备注

- 本问题由原 P1-01 重新登记而来。原 P1-01 文档（`FIX_P1-01_auditRouteOrder.md`）保留作历史记录，状态不变。
- 2026-07-02 经审阅方裁定，cleanup 方法不匹配正式纳入本问题，与 stats/export 共同构成三个子问题。前端 `cleanup()`（`AuditLogService.js` L200）调用 `POST /api/audit-logs/cleanup`，而后端为 `DELETE /api/audit-logs/cleanup`（`auditRoutes.js` L201），HTTP 方法不匹配。
- 前端文件实际路径为 `js/services/AuditLogService.js`（非 `js/modules/`）。
