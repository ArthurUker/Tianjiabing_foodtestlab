# FIX-P2-26：AuditLog.js 审计日志展示页读取错误字段名

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-26` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/modules/AuditLog.js` |
| **预估工时** | 0.5h |
| **关联问题** | P1-28（logOperation 字段名不匹配） |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`js/modules/AuditLog.js` 审计日志展示页面（L279）读取 `log.table_name` 渲染"资源类型"列，但数据库实际字段为 `resource_type`（Prisma schema）。字段名不匹配，该列始终显示为空。

## 2. 根因分析

`AuditLog.js` 展示模板原读取 `log.table_name`（早期命名），而 Prisma schema `AuditLog` 模型字段为 `resource_type`。属 P1-28 字段命名不一致家族的展示侧预存缺陷（非 P1-28 修复引入，P1-28 修复前即存在）。

## 3. 修复方案（2026-07-04 实施）

将展示页字段读取从 `log.table_name` 改为 `log.resource_type`：

```javascript
// 修复前: ${this.escapeHtml(log.table_name)}
// 修复后:
<td class="px-4 py-3 text-sm text-gray-600">${this.escapeHtml(log.resource_type)}</td>
```

## 4. 验收标准

- [x] 展示页读取 `log.resource_type`，与 Prisma schema 字段一致
- [x] 使用 `escapeHtml` 转义防 XSS
- [x] 静态验证通过
- [ ] ⚠️ 历史审计日志的 `resource_type` 字段为 null（P1-28 修复前产生），该列对历史日志仍显示为空——属已知限制，非本修复范围

## 5. 回归测试要点

- [ ] 修复后新增的审计日志（resource_type 非 null）在展示页"资源类型"列正确显示

## 6. 备注

- 与 P1-28 同属字段命名不一致家族：P1-28 修复前端上报字段名（`table_name`→`resource_type`），P2-26 修复展示页读取字段名。
- 历史日志 resource_type 为 null 无法回填（P1-28 已知限制），该列对历史日志显示为空不视为验收失败项。
