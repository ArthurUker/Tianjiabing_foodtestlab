# FIX-P1-04：密码强度校验过弱（仅要求 length >= 6）

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-04` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `backend/modules/UserManager.js`、`backend/routes/userRoutes.js` |
| **预估工时** | 1h |
| **关联问题** | - |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-06-29 |

---

## 1. 问题描述

原密码校验仅要求 `length >= 6`，强度过弱，易被暴力破解。

## 2. 根因分析

`UserManager` 中无统一强密码校验方法，注册/改密/重置均使用宽松长度判断。

## 3. 修复方案

### 方案 A（已实施）

新增 `isStrongPassword()` 方法，正则：`/^(?=.*[A-Za-z])(?=.*\d).{8,}$/`（至少 8 位 + 字母 + 数字）。

- 修改文件：`backend/modules/UserManager.js`、`backend/routes/userRoutes.js`

### 调用链

- `registerUser` → `validateUserInput`（UserManager.js 第 507 行）
- `changePassword`（UserManager.js 第 173 行）
- `resetPassword`（UserManager.js 第 204 行）
- `userRoutes` `/change-password`（第 135 行）
- `userRoutes` `/reset-password`（第 204、219 行，两处兼容路径）

## 4. 验收标准

- [x] `isStrongPassword()` 方法存在
- [x] 注册/改密/重置均调用该方法
- [x] 5 项接口测试全部通过

## 5. 回归测试要点

- [x] 无 token 注册 → 401
- [x] 弱密码注册（3 种）→ 400
- [x] 强密码注册 → 201

## 6. 备注

5 项注册接口测试于 2026-06-29 本地验证全部通过（无 token 401、弱密码 400×3、强密码 201）。
