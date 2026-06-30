# FIX P1-08：User→TestRecord 级联删除风险

## 问题描述
`schema.prisma` 中 `TestRecord.created_user` 关联配置 `onDelete: Cascade`。
删除 User 时，该用户创建的所有 TestRecord 及其 TestItem 被级联静默删除，无任何提示或审计。

## 根因
Prisma relation 未显式限制删除行为，ORM 默认透传数据库级联，业务层无拦截。

## 修复内容
| 文件 | 修改 |
|------|------|
| `backend/prisma/schema.prisma` L67 | `onDelete: Cascade` → `onDelete: Restrict` |
| `backend/modules/UserManager.js` | `deleteUser()` 添加前置 `testRecord.count` 检查，存在记录时抛出业务错误 |

## 功能影响
删除存在检测记录的用户时，接口将返回 400 错误并提示记录数量，需前端展示提示。
无检测记录的用户可正常删除。

## 遗留技术债
- **TD-P2-11**：User 删除应改为软删除（`status: disabled`），保留历史记录归属关系
- **TD-P2-12**：`User → AuditLog` 的 `onDelete: Cascade` 存在合规风险，待评估

## 提交信息
fix(P1-08): User→TestRecord改为Restrict+删除前置检查防止级联静默删除
