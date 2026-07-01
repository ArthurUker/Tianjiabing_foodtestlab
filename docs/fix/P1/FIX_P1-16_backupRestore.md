# FIX-P1-16：BackupRestore.js 备份恢复依赖无效的 syncRoutes

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-16` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `js/modules/BackupRestore.js` |
| **预估工时** | 2h |
| **关联问题** | P0-01 |
| **状态** | ✅ 已完成（代码无变更，问题已由先前重构解决） |
| **完成日期** | 2026-07-01 |

---

## 1. 问题描述

> BackupRestore.js 备份恢复依赖无效的 syncRoutes。
>
> （FIX_PLAN.md v1.12 原始描述）

依赖链（FIX_PLAN.md）：
```
P0-02（统一 authMiddleware）
    └─► P0-01（syncRoutes 重写）
            └─► P1-16（BackupRestore 修复）
```

历史背景：`backend/routes/syncRoutes.js` 原为 CommonJS、无认证、仅操作内存（不写 DB）的三重缺陷路由；P1-16 记录的原始担忧是前端 `BackupRestore.js` 的备份恢复功能依赖该无效路由。

## 2. 根因分析

历史上 `BackupRestore.js` 曾调用 `/api/sync/*` 端点完成云端同步/恢复，而 syncRoutes 存在 P0-01 所述三重缺陷。

P0-01 修复 syncRoutes（ESM + 认证 + Prisma）后，后续重构提交将 `BackupRestore.js` 完全迁移至标准 `/api/records/*` 和 `/api/health` 端点，不再依赖 syncRoutes：

| 提交 | 说明 |
|------|------|
| `fd84875` | feat: server-first backup sync and idempotent record upsert |
| `6144b6c` | fix: avoid duplicate records during restore sync |
| `3a0f35a` | fix(backup-restore): 修复本地导入导致的 500 错误；改进 Storage 队列重试、_throwIfNotOk、_handleCreate 与后端错误处理 (T1–T4) |

## 3. 修复方案

### 代码无变更（问题已由先前重构解决）

本次执行方案 A：核验确认 `BackupRestore.js` 现状已正确，无需修改。

核验证据（2026-07-01 逐项确认）：

| 核验项 | 文件:行号 | 实际内容 | 结论 |
|--------|----------|---------|------|
| BackupRestore 是否调用 /api/sync | `js/modules/BackupRestore.js` 全文 | 无任何 `/api/sync` 调用 | ✅ |
| 云端恢复端点 | `js/modules/BackupRestore.js:515` → `backend/server.js:445` | `fetch('/api/records/${tableName}?limit=1000&offset=0')` → `GET /api/records/:tableName` 就绪 | ✅ |
| 批量上传端点 | `js/modules/BackupRestore.js:773` → `backend/server.js:549` | `NetworkHelper.post('/api/records/${tableName}/bulk-upsert')` → `POST /api/records/:tableName/bulk-upsert` 就绪 | ✅ |
| 连接检查端点 | `js/modules/BackupRestore.js:307` → `backend/server.js:293` | `fetchWithTimeout('/api/health')` → `GET /api/health` 就绪 | ✅ |
| bulk-upsert 响应解析 | `js/modules/BackupRestore.js:783-786` | `response.data.created/updated/failed` 与 server 返回结构 `{success, data:{created,updated,failed}}` 匹配 | ✅ |
| syncRoutes 现状 | `backend/routes/syncRoutes.js` | P0-01 已修复为 ESM + 认证 + Prisma（仍保留并挂载于 `/api/sync`，由 `OfflineModeManager.js` 使用，非 P1-16 范围） | ✅ |

`grep -rn "api/sync" js/ backend/` 结果：
```
js/utils/OfflineModeManager.js:232:    const response = await this.apiClient.post(`/api/sync/${storeName}`, {
backend/server.js:338:app.use('/api/sync', syncRoutes)
backend/routes/syncRoutes.js:10-13:  (路由注释)
```
→ `js/modules/BackupRestore.js` 中无任何 `/api/sync` 引用。

## 4. 验收标准

- [x] BackupRestore.js 全文件无 `/api/sync` 调用（grep 核验通过）
- [x] `handleCloudRestore` 调用的 `GET /api/records/:tableName` 端点存在且带认证（server.js:445）
- [x] `uploadRestoredDataToServer` 调用的 `POST /api/records/:tableName/bulk-upsert` 端点存在且带认证 + 角色校验（server.js:549）
- [x] `checkSyncStatus` 调用的 `GET /api/health` 端点存在（server.js:293）
- [x] bulk-upsert 响应解析字段与后端返回结构一致

## 5. 回归测试要点

- [x] 云端恢复：5 张业务表并行拉取 → 写入 localStorage cache
- [x] 本地恢复：JSON 文件解析 → processRestoreData → uploadRestoredDataToServer 批量上传
- [x] 强制同步：本地数据加入 pending 队列 → 页面刷新后由 Storage.js 队列处理

## 6. 功能影响

无（备份恢复功能已由先前重构正常工作）。

## 7. 技术债

**TD-P2-20**：BackupRestore.js 残留死代码 + OfflineModeManager /api/sync 迁移评估

1. **`js/modules/BackupRestore.js:505` `token.startsWith('temp-token-')` 为 P0-08 后的死代码**：
   - P0-08 已废弃 `temp-token-` 前缀（访客改由后端签发真实 JWT）；
   - 当前代码 `if (!token || token.startsWith('temp-token-'))` 的第二分支永不命中，建议清理以避免误导。
2. **`js/utils/OfflineModeManager.js:232` 仍调用 `/api/sync/${storeName}`**：
   - syncRoutes 已由 P0-01 修复为可用，但该端点语义与 `/api/records/*` 重叠；
   - 需评估 OfflineModeManager 是否迁移至 `/api/records/*` RESTful 端点，或保留并明确职责边界，或移除该模块（若离线模式已废弃）。

## 8. 备注

> 本项为 FIX_PLAN 标记"待处理"但代码已由先前重构解决的典型情况。
> 文档闭环仅更新状态与登记技术债，不修改任何代码文件。
