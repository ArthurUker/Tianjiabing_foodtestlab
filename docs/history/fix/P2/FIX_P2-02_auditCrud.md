# FIX-P2-02：检测记录 CRUD 操作未在后端层自动写入审计日志

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-02` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `backend/server.js` |
| **预估工时** | 2h |
| **关联问题** | P1-09（三套审计日志机制并存）、P2-03（失败登录日志） |
| **状态** | ✅ 已完成（静态验证 + 运行时验证均通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

检测记录的增删改及批量导入操作在后端层未自动写入审计日志。审计日志此前仅由前端 `AuditLogService.logOperation()` 主动调用产生（依赖前端正确上报），后端 CRUD 路由本身不记录操作日志，存在审计盲区：若前端未上报或被绕过，则操作无任何后端侧留痕。

## 2. 根因分析

`backend/server.js` 的记录 CRUD 路由（`POST /api/records/:tableName`、`PUT`、`DELETE`、`bulk-upsert`）在 `prisma.testRecord.create/update/delete` 之后直接返回响应，未调用 `prisma.auditLog.create` 写入操作日志。审计日志机制本就存在前后端两套（P1-09），后端侧仅 `UserManager` 记录登录类日志，CRUD 操作日志完全依赖前端上报。

## 3. 修复方案（2026-07-04 实施）

新增后端审计日志写入辅助函数，并在 4 个 CRUD 路径调用：

```javascript
// P2-02: 审计日志写入辅助函数 — 记录 CRUD 操作到数据库
async function writeRecordAuditLog(userId, action, resourceType, resourceId, details, ip) {
    try {
        await prisma.auditLog.create({
            data: {
                user_id: userId,
                action,
                resource_type: resourceType || null,
                resource_id: resourceId || null,
                details: details ? JSON.stringify(details) : null,
                ip_address: ip || null
            }
        })
    } catch (e) {
        console.error('❌ 审计日志写入失败:', e.message)
    }
}
```

调用点（均位于 `server.js`）：
- 创建（L555）：`writeRecordAuditLog(req.userId, 'create', 'test_record', record.id, {...}, req.ip)`
- 批量导入（L656）：`writeRecordAuditLog(req.userId, 'import', 'test_record', null, {total, created, updated, failed}, req.ip)`
- 更新（L729）：`writeRecordAuditLog(req.userId, 'update', 'test_record', id, {...}, req.ip)`
- 删除（L766）：`writeRecordAuditLog(req.userId, 'delete', 'test_record', id, {...}, req.ip)`

审计日志写入失败采用 `console.error` 降级，不阻断主业务流程。

## 4. 验收标准

- [x] 4 个 CRUD 路径（create/update/delete/import）均调用 `writeRecordAuditLog`
- [x] 审计日志 `action` 字段正确区分 create/update/delete/import
- [x] `resource_type` 统一为 `test_record`，`resource_id` 为记录 ID（import 为 null）
- [x] 写入失败不阻断业务（try/catch 降级）
- [x] 运行时验证（2026-07-04 执行）：创建 1 条 tableware 记录 → AuditLog 产生 1 条 `action=create, resource_type=test_record`；bulk-upsert 1 条 → AuditLog 产生 1 条 `action=import`。两条审计日志已在本次环境清理中删除（见本轮子任务二）

## 5. 回归测试要点

- [ ] 批量导入多条记录时审计日志 details 正确记录 created/updated/failed 计数
- [ ] 审计日志写入失败时主操作仍成功返回

## 6. 备注

- 关联 P1-09：本修复在后端层补齐 CRUD 审计，与前端 `AuditLogService` 上报并存，属 P1-09 登记的三套审计机制之一（后端 DB API 通用操作）。统一审计接口设计见 TD-P2-13。
- 关联 P2-03：失败登录日志同属后端审计补齐范畴。
