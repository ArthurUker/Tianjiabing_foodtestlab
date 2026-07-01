# FIX-P1-14：Storage.getAll() 优先返回本地缓存，数据一致性无保障

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-14` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `js/core/Storage.js` |
| **预估工时** | 2h |
| **关联问题** | P0-08 |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-01 |
| **代码提交** | `9c9298d` |

---

## 1. 问题描述

**FIX_PLAN 原始描述**：`Storage.getAll() 优先返回本地缓存，数据一致性无保障`。

**实际核验发现**：

`js/core/Storage.js` 第 83-87 行（修复前）：

```javascript
getAll() {
    const cached = this._getLocalCacheData();
    this._syncFromApi().catch(e => console.error(`[${this.tableName}] Sync failed:`, e));
    return cached;
}
```

问题点逐项确认：

1. **同步签名 + 立即返回本地缓存**：`getAll()` 是同步方法，第 84 行通过 `_getLocalCacheData()` 从 `localStorage` 读取缓存并立即返回。调用方拿到的是**当前缓存快照**（JSON.parse 得到的新数组），与服务端最新数据无关。

2. **`_syncFromApi()` 异步触发但不等待**：第 85 行调用 `this._syncFromApi()` 但仅 `.catch()` 处理错误，**不 await**。调用方返回时同步尚未完成，拿到的是过时数据。

3. **30 秒同步冷却**：`_syncFromApi()` 第 209 行 `if (!force && this._lastSyncTime > 0 && (now - this._lastSyncTime) < this.syncCooldownMs) return;`，`syncCooldownMs = 30000`（第 9 行）。30 秒内的所有 `getAll()` 调用都不会触发新同步，多端协同场景下数据一致性无保障。

4. **快照引用脱节**：调用方拿到的数组是 `JSON.parse` 产生的新引用，`_syncFromApi()` 完成后通过 `_updateLocalCache(mergedData)` 更新的是 `localStorage` 中的缓存，**调用方拿到的数组不会自动更新**，需要重新调用 `getAll()` 才能拿到最新数据。

5. **调用方分布广泛**：全仓 ~30 处同步调用 `storage.getAll()`（Pathogen / GenericTest / Tableware / Dashboard / ExportService 等），全部依赖同步签名，若直接改为 async 会引发大规模重构。

## 2. 根因分析

`getAll()` 设计为同步方法以简化前端调用方代码（直接 `const records = storage.getAll()` 渲染 UI），但同步签名天然无法等待异步的 `_syncFromApi()`。这导致：

- **首次加载**：缓存为空时调用方拿到 `[]`，异步同步完成后才更新缓存，但调用方拿到的空数组不会自动刷新（需调用方监听 `'sync'` 事件主动重渲染）。
- **多端协同**：A 端写入新数据后，B 端调用 `getAll()` 仍拿到 30 秒冷却期内的旧缓存，看不到 A 端的新数据。
- **强制刷新缺失**：调用方在需要服务端最新数据的场景（如导出、跨端协同后刷新）没有强制同步获取的入口。

## 3. 修复方案

### 方案 A（已实施）

**`js/core/Storage.js`**（`9c9298d`）：在 `getAll()` 方法后新增 `getAllFresh()` 异步方法，提供强制同步并返回最新缓存的能力。

```diff
     getAll() {
         const cached = this._getLocalCacheData();
         this._syncFromApi().catch(e => console.error(`[${this.tableName}] Sync failed:`, e));
         return cached;
     }

+    // P1-14: 新增强制同步刷新方法，调用方需要最新数据时使用
+    // 解决 getAll() 同步返回本地缓存导致数据一致性无保障的问题
+    // 注意：getAll() 保留同步签名以兼容现有 ~30 处调用方，需服务端最新数据时改用 getAllFresh()
+    async getAllFresh() {
+        await this._syncFromApi(true);
+        return this._getLocalCacheData();
+    }
+
     save(data) {
```

**修复语义**：
- `getAllFresh()` 调用 `_syncFromApi(true)`（`force=true` 绕过 30 秒冷却），`await` 等待同步完成，然后返回最新的 `_getLocalCacheData()`。
- 离线场景（`_canSyncWithServer()` 返回 false）时 `_syncFromApi` 直接 return，`getAllFresh()` 退化为返回本地缓存，行为与 `getAll()` 一致，不会引入崩溃。
- `getAll()` 完全保留原行为，~30 处现有调用方零影响。

### 方案 B（备选）

> 直接将 `getAll()` 改为 async 并修改全部调用方为 `await`。
>
> **未采用原因**：违反最小改动原则，~30 处调用方重构会引入崩溃风险，且超出 P1-14 修复范围。

## 4. 验收标准

- [x] `js/core/Storage.js` 新增 `getAllFresh()` 异步方法
- [x] `getAll()` 同步签名与原行为完全保留（~30 处调用方零影响）
- [x] `getAllFresh()` 调用 `_syncFromApi(true)` 强制绕过 30 秒冷却
- [x] `getAllFresh()` `await` 同步完成后返回最新缓存
- [x] 离线场景（无 token）`getAllFresh()` 退化为返回本地缓存，不崩溃
- [x] `git diff --stat` 确认修改范围仅限 `js/core/Storage.js`（+8 行）

## 5. 回归测试要点

- [ ] 现有功能：所有 `storage.getAll()` 调用方行为不变（同步返回缓存 + 后台异步同步）
- [ ] 强制刷新：调用 `await storage.getAllFresh()` 应立即触发同步并返回最新数据（绕过冷却）
- [ ] 离线场景：未登录（无 token）时 `await storage.getAllFresh()` 返回本地缓存，不抛错
- [ ] 冷却期行为：30 秒内连续调用 `getAllFresh()`，每次都应触发同步（force=true 绕过冷却）
- [ ] 后续逐步迁移：在导出、跨端协同刷新等关键场景，将 `getAll()` 替换为 `await getAllFresh()`（不在本次修复范围，登记为技术债）

## 6. 备注

**技术债 TD-P2-18**：`getAll()` 调用方迁移评估。

当前 `getAll()` 在前端 ~30 处被同步调用（Pathogen / GenericTest / Tableware / Dashboard / ExportService 等），本次修复仅提供 `getAllFresh()` 入口，**未迁移任何调用方**。后续应在以下场景评估迁移到 `await getAllFresh()`：

1. **ExportService**（`js/services/ExportService.js` L21, L353）：导出数据应来自服务端最新数据，避免导出过时缓存（关联 P2-14）。
2. **Dashboard 首次加载**（`js/modules/Dashboard.js` L150, L153, L676, L829, L832, L1260, L1393, L1418）：首次进入仪表盘应展示最新数据而非缓存。
3. **Pathogen / Tableware 查询入口**（`js/modules/Pathogen.js` L427, L450, L941, L1195；`js/modules/Tableware.js` L112, L621, L757, L760, L1182）：查询记录时应基于最新数据。

迁移需评估每个调用点的异步传染性影响，避免破坏现有 UI 渲染流程。建议作为 P2 优化项分批迁移。
