# FIX-P1-28：AuditLogService.logOperation() 字段名与后端不匹配

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-28` |
| **优先级** | 🟠 P1 重要 |
| **影响文件** | `js/services/AuditLogService.js` |
| **预估工时** | 0.5h |
| **关联问题** | P1-27（修复过程中发现）、P1-27 新增的 `GET /export` CSV 导出路由 |
| **状态** | ✅ 已完成（静态验证 + 运行时验证均通过） |
| **完成日期** | 2026-07-03 |

---

## 1. 问题描述

`js/services/AuditLogService.js` 的 `logOperation(action, table_name, record_id, details)` 方法在构造 POST `/api/audit-logs` 请求体时，使用的字段名为 `table_name` / `record_id`，而后端 `backend/routes/auditRoutes.js` 的 `POST /` 路由解构的是 `resource_type` / `resource_id`：

| 前端发送字段（修复前） | 后端解构字段 | 匹配情况 |
|---|---|---|
| `table_name` | `resource_type` | ❌ 后端收到 undefined |
| `record_id` | `resource_id` | ❌ 后端收到 undefined |

后端代码（`auditRoutes.js` L32）：
```javascript
const { action, resource_type, resource_id, details } = req.body
```

由于字段名不匹配，后端解构得到 `undefined`，写入数据库（Prisma `AuditLog` 模型）时 `resource_type` / `resource_id` 两列均为 `null`。

## 2. 根因分析

前后端审计日志模块由不同提交引入，接口契约未对齐：
- 后端 `auditRoutes.js`（提交 `c8561b4`）按 RESTful 语义设计字段名 `resource_type` / `resource_id`（资源类型 + 资源 ID）；
- 前端 `AuditLogService.js` 的 `logOperation()` 沿用早期命名 `table_name` / `record_id`，未与后端契约对齐。

属前后端接口契约不一致的功能性缺陷，导致审计日志的「资源类型」「资源 ID」两列数据丢失。

## 3. 影响面

### 调用方（共 11 处，均按位置传参，不受修复影响）

| 文件 | 行号 | 调用示例 |
|------|------|---------|
| `js/modules/Dashboard.js` | L258 | `logOperation('export', 'dashboard', 'pdf', '...')` |
| `js/modules/Tableware.js` | L289 / L369 / L627 | `logOperation('update'/'create'/'delete', 'tableware', record.id, '...')` |
| `js/modules/BackupRestore.js` | L461 / L545 / L635 / L650 | `logOperation('backup'/'restore'/..., 'backup', ..., '...')` |
| `js/modules/Pathogen.js` | L433 / L705 | `logOperation('create'/'update', 'pathogen', record.id, '...')` |

### 数据库影响

修复前产生的**全部历史审计日志**，`resource_type` / `resource_id` 字段均为 `null`。

### 与 P1-27 导出功能的关联影响

P1-27 新增的 `GET /api/audit-logs/export` 路由（`auditRoutes.js` L191-198）会将 `resource_type` / `resource_id` 两列写入 CSV：

```javascript
const header = '时间,用户,操作类型,资源类型,资源ID,详情,IP地址\n'
// ...
return `${time},${user},${log.action},${log.resource_type || ''},${log.resource_id || ''},${details},${ip}`
```

由于 P1-28 修复前长期存在字段名不匹配问题，**所有历史审计日志中这两列的值都是 null**，导致 CSV 导出功能中这两列历史数据为空。

> **本问题修复前产生的历史审计日志，`resource_type` / `resource_id` 字段均为 null，会导致 P1-27 新增的 CSV 导出功能中这两列历史数据为空。本次修复仅对修复生效时间点之后新产生的日志生效，不包含历史数据回填。如需回填，需额外评估工作量（历史数据的 `resource_type` / `resource_id` 需从其他字段或业务日志反推，可能无法完全还原），暂不在本次范围内。**

## 4. 修复方案（2026-07-03 实施）

采用**最小化改动**：统一为后端字段名 `resource_type` / `resource_id`（更符合语义，`resource_type` 表示资源类型如 "tableware" / "pathogen"，比 `table_name` 更准确）。

### 修改点

在 `js/services/AuditLogService.js` 的 `logOperation()` 方法内部，将发送给后端的 body 字段名由 `table_name` / `record_id` 改为 `resource_type` / `resource_id`：

```javascript
// 修复前
body: JSON.stringify({
    action,
    table_name,
    record_id,
    details
})

// 修复后
body: JSON.stringify({
    action,
    resource_type: table_name,   // 方法参数名不变，仅 body 字段名对齐后端
    resource_id: record_id,
    details
})
```

**不修改方法签名**（`logOperation(action, table_name, record_id, details)` 参数名与顺序保持不变）和 **11 处调用方**（调用方传参方式完全不变），仅方法内部构造 body 时改字段名，实现零调用方影响。

### 后端校验确认

后端 `POST /` 路由（`auditRoutes.js` L34-36）仅校验 `action` 必填，`resource_type` / `resource_id` 为可选（L42-43 写入时 `|| null`），修复后不会引入新的校验失败。

### 数据库 schema 确认

Prisma schema `AuditLog` 模型字段名为 `resource_type` / `resource_id`（`schema.prisma` L39-40），与后端解构字段一致，无需额外迁移。

## 5. 验收标准

- [x] 前端 `logOperation()` 发送 body 字段名与后端 `POST /` 路由解构字段名完全一致（`resource_type` / `resource_id`）
- [x] 方法签名与 11 处调用方零改动（`git diff` 仅 `AuditLogService.js` 一个文件）
- [x] 后端 `resource_type` / `resource_id` 非必填校验，修复后不引入新的 400 错误
- [x] 修复后新增的审计日志，导出 CSV 时 `resource_type` / `resource_id` 列不再为空（历史日志此两列仍为 null，属已知限制，不视为验收失败项）
- [x] 运行时验证：触发一次写操作（如新增餐具记录），查询 `GET /api/audit-logs` 确认新日志的 `resource_type` / `resource_id` 字段已正确写入
  - 运行时验证已通过，验证记录（2026-07-04 执行）：
    - `POST /api/audit-logs`（body 含 `resource_type: "tableware"`, `resource_id: "runtime_verify_p1_28"`）→ HTTP 201，响应体 `data.resource_type: "tableware"`、`data.resource_id: "runtime_verify_p1_28"` 均非 null，确认字段正确写入 DB
    - `GET /api/audit-logs/export` CSV 导出首行（本次验证新增的日志）`资源类型=tableware, 资源ID=runtime_verify_p1_28` 有值；历史日志此两列为空（属已知限制）

## 6. 回归测试要点

- [ ] 11 处调用方（Dashboard / Tableware / BackupRestore / Pathogen）触发写操作后，审计日志 `resource_type` / `resource_id` 正确写入
- [ ] `GET /api/audit-logs` 查询返回的日志对象包含 `resource_type` / `resource_id` 字段
- [ ] `GET /api/audit-logs/export` CSV 导出中，修复后新增日志的「资源类型」「资源 ID」列有值

## 7. 备注

- 本问题在 P1-27 修复过程中发现并登记，属前后端接口契约不一致的延伸缺陷。
- 历史日志的 `resource_type` / `resource_id` 无法回填（仅影响修复后新增日志）。
- **附加发现（未修复，登记为新问题）**：`js/modules/AuditLog.js` L279 审计日志展示页面读取 `log.table_name`，但数据库实际字段为 `resource_type`，该列在展示页面始终显示为空。此为 P1-28 修复前即存在的预存展示缺陷（非本次修复引入），与 P1-28 同属字段命名不一致家族，登记为 P2-26 待后续处理。
