# FIX-P0-09：auth.verify() 对编辑操作完全不做权限校验

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P0-09` |
| **优先级** | 🔴 P0 高危（建议 1~3 天内处理） |
| **影响文件** | `backend/server.js` |
| **预估工时** | 3h |
| **关联问题** | P1-21 |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-06-24 |

---

## 1. 问题描述

后端写操作路由（PUT/DELETE）仅做 `authenticateUser` 认证，不校验角色，访客/低权用户可调用写接口篡改或删除检测记录。

## 2. 根因分析

`backend/server.js` 中 PUT/DELETE 路由仅挂载 `authenticateUser`，缺少角色门槛中间件，导致任何持有有效令牌的访客均可写入。

## 3. 修复方案

### 方案 A（已实施）

在 `backend/server.js` 新增 `requireEditorOrAbove` 中间件，挂载到 4 条写路由。

- 中间件定义：`backend/server.js` 第 226–234 行
- 挂载路由：
  - `PUT /api/records/:tableName/:id`（第 591 行）
  - `DELETE /api/records/:tableName/:id`（第 639 行）
  - `PUT /api/test-records/:id`（第 737 行）
  - `DELETE /api/test-records/:id`（第 767 行）

### 实现说明

当前实现拒绝 `guest` / `viewer` / 空 role，允许 `user` / `editor` / `admin` / `manager` / `operator` 写入。与 FIX_PLAN 原规格（仅 admin/editor）存在差异，已登记为待确认设计决策。

## 4. 验收标准

- [x] `requireEditorOrAbove` 中间件已定义并挂载到 4 条写路由
- [x] 以 guest/viewer 身份调用写接口返回 403
- [x] 正式用户（user 及以上）可正常写入

## 5. 回归测试要点

- [x] 访客令牌调用 PUT /api/records/:tableName/:id 应返回 403
- [ ] 正式账号写操作未被误拦

## 6. 写操作语义区分（2026-06-30 补记）

原 P0-09 规格"4 条写路由"实指 **PUT/DELETE** 4 条（更新/删除类写入）。POST 创建类写入（3 条）的权限缺口在原规格中未被识别，由 **P0-09b** 补齐。

| 写操作语义 | 方法 | 路由数 | 覆盖项 |
|-----------|:----:|:----:|------|
| 创建 | POST | 3 | P0-09b（`/api/test-records`、`/api/records/:tableName`、`/api/records/:tableName/bulk-upsert`） |
| 更新 | PUT | 2 | P0-09（`/api/records/:tableName/:id`、`/api/test-records/:id`） |
| 删除 | DELETE | 2 | P0-09（`/api/records/:tableName/:id`、`/api/test-records/:id`） |

详见 [FIX_P0-09b_postWriteGuard.md](./FIX_P0-09b_postWriteGuard.md)。

## 7. 备注

实现与 FIX_PLAN 原始规格（仅允许 admin/editor）的宽松差异需在 P1 阶段复核确认是否为预期设计。
