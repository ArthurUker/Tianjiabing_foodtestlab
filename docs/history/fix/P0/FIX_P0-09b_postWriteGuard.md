# FIX-P0-09b：POST 创建类写入路由补挂 requireEditorOrAbove

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P0-09b`（P0-09 补丁子项，不破坏 62 题基线） |
| **优先级** | 🔴 P0 高危 |
| **影响文件** | `backend/server.js` |
| **预估工时** | 0.5h |
| **关联问题** | P0-09 |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-06-30 |

---

## 1. 问题发现

P0-09 原修复仅挂载 `requireEditorOrAbove` 到 4 条 PUT/DELETE 写路由，遗漏 3 条 POST 创建类写入路由。访客/低权用户可调用以下接口创建记录：

| 路由 | 行号 | 风险 |
|------|:----:|------|
| `POST /api/test-records` | 337 | 任意认证用户可创建测试记录 |
| `POST /api/records/:tableName` | 440 | 任意认证用户可创建 legacy 记录 |
| `POST /api/records/:tableName/bulk-upsert` | 508 | 任意认证用户可批量导入（最多 2000 条） |

## 2. 根因分析

P0-09 原规格"4 条写路由"语义仅指 PUT/DELETE（更新/删除），未识别 POST 创建类写入同为写操作。

## 3. 修复方案

在 3 条 POST 路由的 `authenticateUser` 之后、`async` 之前插入 `requireEditorOrAbove`，与 PUT/DELETE 路由中间件顺序完全一致。

### 修复 diff

```diff
-app.post('/api/test-records', authenticateUser, async (req, res) => {
+app.post('/api/test-records', authenticateUser, requireEditorOrAbove, async (req, res) => {

-app.post('/api/records/:tableName', authenticateUser, async (req, res) => {
+app.post('/api/records/:tableName', authenticateUser, requireEditorOrAbove, async (req, res) => {

-app.post('/api/records/:tableName/bulk-upsert', authenticateUser, async (req, res) => {
+app.post('/api/records/:tableName/bulk-upsert', authenticateUser, requireEditorOrAbove, async (req, res) => {
```

## 4. 静态验证结论

| 验证项 | 结果 |
|--------|:--:|
| `grep -n "requireEditorOrAbove"` 确认 1 处定义 + 7 处挂载 | ✅ |
| 中间件顺序与 PUT/DELETE 路由一致（`authenticateUser, requireEditorOrAbove, async`） | ✅ |
| `node --check backend/server.js` 语法检查通过 | ✅ |
| 未误伤 `/api/guest/quick-access`（公开接口，第 297 行） | ✅ |
| 未误伤 `/api/users/:userId/disable`、`/enable`（内联 `req.userRole !== 'admin'` 校验保留，第 809/827 行） | ✅ |

### 7 条写路由最终覆盖清单

| # | 路由 | 方法 | 行号 | 来源 |
|---|------|:----:|:----:|------|
| 1 | `/api/test-records` | POST | 337 | P0-09b 新增 |
| 2 | `/api/records/:tableName` | POST | 440 | P0-09b 新增 |
| 3 | `/api/records/:tableName/bulk-upsert` | POST | 508 | P0-09b 新增 |
| 4 | `/api/records/:tableName/:id` | PUT | 591 | P0-09 原有 |
| 5 | `/api/records/:tableName/:id` | DELETE | 639 | P0-09 原有 |
| 6 | `/api/test-records/:id` | PUT | 737 | P0-09 原有 |
| 7 | `/api/test-records/:id` | DELETE | 767 | P0-09 原有 |

## 5. 运行时验证（待补）

运行时验证未执行，原因：
1. 运行中的后端进程（PID 5587）加载的是修改前的旧代码，Node.js 不热重载；
2. 缺少 admin/editor 角色测试账号凭证（seed 默认账号密码可能已变更）。

**接受静态验证结论的依据**：
- 新增挂载与现役 PUT/DELETE 路由引用**同一 `requireEditorOrAbove` 函数**（第 226 行），函数行为已被 PUT/DELETE 路由现役验证；
- 中间件顺序一致，`req.user.role` 由 `authenticateUser` 填充后传入，行为等价；
- `node --check` 通过。

**待补运行时验证矩阵**（重启后端后执行）：

| 路由 | 角色 | 期望状态 |
|------|------|:-------:|
| `POST /api/test-records` | guest/viewer | 403 |
| `POST /api/test-records` | admin/editor | 200/201 |
| `POST /api/records/:tableName` | guest/viewer | 403 |
| `POST /api/records/:tableName` | admin/editor | 200/201 |
| `POST /api/records/:tableName/bulk-upsert` | guest/viewer | 403 |
| `POST /api/records/:tableName/bulk-upsert` | admin/editor | 200/201 |

## 6. 备注

P0-09b 为 P0-09 补丁子项，P0 总数仍计 10 项（不破坏 62 题基线）。
