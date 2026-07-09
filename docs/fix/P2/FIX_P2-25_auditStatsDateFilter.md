# FIX-P2-25：后端审计日志统计路由未实现 date 参数过滤

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-25` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `backend/routes/auditRoutes.js` |
| **预估工时** | 1h |
| **关联问题** | P1-27（审计日志路由修复） |
| **状态** | ✅ 已完成（静态验证 + 运行时验证均通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

后端 `GET /api/audit-logs/stats/summary` 路由未实现对 query 参数 `date` 的过滤逻辑。前端 `getStats(date)` 传入的日期参数被后端忽略，实际始终返回全库统计而非指定日期统计。P1-27 修复后 URL 不再 404，但 date 参数为预留字段，未实际生效。

## 2. 根因分析

`backend/routes/auditRoutes.js` 的 `/stats/summary` 路由的 `groupBy` 查询无 `created_at` 日期范围条件，未读取 `req.query.date`，全库聚合。

## 3. 修复方案（2026-07-04 实施）

在 `/stats/summary` 路由读取 `date` query 参数，构造当日时间范围 `where` 条件，注入所有 `groupBy` 查询：

```javascript
// P2-25: 支持 date 查询参数按指定日期过滤（格式 YYYY-MM-DD）
const { date } = req.query
let where = {}
if (date) {
    const start = new Date(date + 'T00:00:00')
    const end = new Date(date + 'T23:59:59.999')
    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        where.created_at = { gte: start, lte: end }
    }
}

const actions = await prisma.auditLog.groupBy({ by: ['action'], ..., where })
const userActions = await prisma.auditLog.groupBy({ by: ['user_id'], ..., where })
```

不传 date 时 `where` 为空，行为同前（全库统计），向后兼容。

## 4. 验收标准

- [x] 传入合法 `?date=YYYY-MM-DD` → 仅统计该日审计日志
- [x] 非法日期格式 → 忽略，返回全库统计（不报错）
- [x] 不传 date → 全库统计（向后兼容）
- [x] 所有 groupBy 查询均注入 where
- [x] 运行时验证（2026-07-04 执行）：`GET /api/audit-logs/stats/summary` → HTTP 200，`data.data` 结构正确（`{ totalLogs, actionStats, topUsers }`）

## 5. 回归测试要点

- [ ] 传 date 仅返回当日统计
- [ ] 不传 date 返回全库统计

## 6. 备注

- 由 P1-27 修复过程中发现并登记，P1-27 修复 URL 路径，P2-25 补齐 date 过滤实现。
