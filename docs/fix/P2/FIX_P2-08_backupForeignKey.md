# FIX-P2-08：Backup 模型缺少关联用户外键约束

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-08` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `backend/prisma/schema.prisma` |
| **预估工时** | 1h |
| **关联问题** | P1-08（级联删除策略） |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`Backup` 模型的 `created_by` 字段为普通字符串，未建立与 `User` 模型的外键关系。删除用户时备份记录的 `created_by` 不会做任何处理，可能产生孤立的无效引用，且无法在 ORM 层进行关联查询。

## 2. 根因分析

`backend/prisma/schema.prisma` 的 `Backup` 模型原定义 `created_by String?` 为裸字段，无 `@relation` 声明，与 `User` 模型无关联约束。

## 3. 修复方案（2026-07-04 实施）

在 `Backup` 模型补建与 `User` 的关联关系，采用 `onDelete: SetNull`（用户删除时备份记录的 created_by 置空，保留备份历史）：

```prisma
model Backup {
  ...
  created_by    String?
  ...
  // P2-08: 关联用户外键约束（created_by 可为空，引用 User.id）
  created_user  User?    @relation(fields: [created_by], references: [id], onDelete: SetNull)

  @@index([created_by])
}
```

同时在 `User` 模型补 `backups Backup[]` 反向关系字段。

## 4. 验收标准

- [x] `Backup.created_user` 声明为 `User?` 关联，`onDelete: SetNull`
- [x] `User` 模型含 `backups Backup[]` 反向字段
- [x] `created_by` 建立索引
- [x] 静态验证通过（schema 字段对齐）

## 5. 回归测试要点

- [ ] 删除有关联备份的用户 → 备份记录 created_by 置空，备份本身不删除
- [ ] 备份记录可经 ORM 关联查询到用户信息

## 6. 备注

- 选用 `SetNull` 而非 `Cascade`，与 P1-08 保护数据不意外丢失的原则一致（备份是历史快照，不应因用户删除而丢失）。
