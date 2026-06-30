# FIX-P1-03：UserManager 注册时自动生成虚假 email

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-03` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `backend/modules/UserManager.js` |
| **预估工时** | 0.5h |
| **关联问题** | - |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-06-29 |

---

## 1. 问题描述

`registerUser()` 注册时自动生成 `@foodlab.local` 虚假邮箱，污染用户数据。

## 2. 根因分析

`UserManager.registerUser()` 中 email 字段使用 `${username}@foodlab.local` 拼接生成。

## 3. 修复方案

### 方案 A（已实施）

`registerUser()` 中 email 字段改为 `null`，移除 `@foodlab.local` 自动生成逻辑。

- 修改文件：`backend/modules/UserManager.js`
- 修改位置：`registerUser()` 第 68 行 `email: null`

## 4. 验收标准

- [x] `registerUser()` 中 `email: null`
- [x] `UserManager.js` 中无 `foodlab.local` 自动生成逻辑（grep 返回 0 匹配）

## 5. 回归测试要点

- [x] 新注册用户 email 字段为 null
- [ ] 前端用户列表显示不因 email 为 null 报错

## 6. 备注

`seed.js` 和 `backend/sql/03_set_admin_password.sql` 中仍有 `foodlab.local` 引用，属于种子数据/初始化脚本，不在注册逻辑中，不影响本修复。
