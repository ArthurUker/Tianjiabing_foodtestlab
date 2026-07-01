# FIX-P1-20：Dashboard.js 全局函数挂载 + 5个StorageService实例

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-20` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `js/modules/Dashboard.js`、`js/main.js` |
| **预估工时** | 2h |
| **关联问题** | P2-10（main.js 大量 window.* 全局暴露） |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-01 |
| **代码提交** | `5381c27` |

---

## 1. 问题

### FIX_PLAN 原始描述

> `P1-20` | Dashboard.js 全局函数挂载 + 5个StorageService实例 | 2h | ⬜ 待处理

### RG_03b 审阅细化

> `Dashboard.js` 将 `loadDashboardData` 挂载到 `window` 全局，且实例化 5 个 StorageService
> - **修复建议**：使用 `CustomEvent` 替代全局函数；合并多个 StorageService 的同步请求

具体问题点：
1. **全局函数挂载**：`Dashboard.js` 将 `loadDashboardData` 挂载到 `window.loadDashboardData`（L99），将 `initDashboard` 挂载到 `window.initDashboard`（L1472），违反模块化原则，全局命名空间污染，且可被 DevTools 任意调用/覆盖。
2. **5 个 StorageService 实例 sync 事件未合并**：`Dashboard.js` L7-13 实例化 5 个 `StorageService`（tableware/pesticide/oil/leanMeat/pathogen），L101-105 对每个 service 注册 `on('sync', ...)` 回调，5 个 service 各自同步完成后都会独立触发 `initCanteenFilter()` + `loadDashboardData()`，在并发同步场景下导致看板被重复刷新最多 5 次。

## 2. 根因

- **全局挂载历史遗留**：早期开发阶段为方便导航时跨模块调用，将 `loadDashboardData` / `initDashboard` 挂到 `window`，后续未随模块化重构清理。
- **sync 事件未合并**：5 个 service 各自独立注册 sync 回调，未做防抖/合并处理，每个 service 的 `_syncFromApi()` 完成后 emit `sync` 事件各自触发一次看板刷新。

## 3. 修复

### 3.1 CustomEvent 替代全局函数

**`js/modules/Dashboard.js` L98-99**：
```diff
-        // 暴露到全局，供导航时刷新调用
-        window.loadDashboardData = loadDashboardData;
+        // P1-20: 使用 CustomEvent 替代 window 全局函数，供导航时刷新调用
+        document.addEventListener('dashboard:refresh', () => loadDashboardData());
```

**`js/modules/Dashboard.js` L1470-1474**（文件尾部）：
```diff
-// 🎯 暴露 initDashboard 到全局作用域
-if (typeof window !== 'undefined') {
-    window.initDashboard = initDashboard;
-    console.log('✅ initDashboard 已暴露到 window 全局作用域');
-}
+// P1-20: 移除 window.initDashboard 全局暴露，main.js 已通过 import 使用
```

**`js/main.js` L110-117**（`handleNavigation` 内导航到看板时刷新）：
```diff
-        // 切换到看板时强制刷新数据，确保显示各模块最新缓存
-        if (target === 'dashboard' && typeof window.loadDashboardData === 'function') {
-            try {
-                window.loadDashboardData();
-            } catch (error) {
-                console.error('❌ 看板刷新失败:', error);
-            }
-        }
+        // P1-20: 使用 CustomEvent 替代 window.loadDashboardData 全局函数调用
+        if (target === 'dashboard') {
+            try {
+                document.dispatchEvent(new CustomEvent('dashboard:refresh'));
+            } catch (error) {
+                console.error('❌ 看板刷新失败:', error);
+            }
+        }
```

### 3.2 合并多个 StorageService 的 sync 事件

**`js/modules/Dashboard.js` L101-109**：
```diff
-        // 服务器同步完成后：先更新食堂选项再刷新看板
-        Object.values(services).forEach(s => s.on('sync', () => {
-            initCanteenFilter();
-            loadDashboardData();
-        }));
+        // P1-20: 合并多个 StorageService 的 sync 事件，防抖避免 5 次重复刷新看板
+        let _syncRefreshTimer = null;
+        Object.values(services).forEach(s => s.on('sync', () => {
+            if (_syncRefreshTimer) clearTimeout(_syncRefreshTimer);
+            _syncRefreshTimer = setTimeout(() => {
+                initCanteenFilter();
+                loadDashboardData();
+            }, 200);
+        }));
```

5 个 service 的 sync 事件合并为 200ms 防抖，并发同步场景下看板仅刷新 1 次。

## 4. 功能影响

- **导航到看板刷新**：行为不变，`main.js handleNavigation()` 导航到 `dashboard` 时由 `window.loadDashboardData()` 改为 `dispatchEvent(new CustomEvent('dashboard:refresh'))`，Dashboard.js 监听该事件并调用 `loadDashboardData()`。
- **sync 完成后刷新**：5 个 service 并发同步完成时，看板刷新从最多 5 次降为 1 次（200ms 防抖），性能提升且无功能差异。
- **`window.initDashboard` 移除**：`main.js` 已通过 `import { initDashboard }` 使用，移除全局暴露无影响；`main.js` L254/L271 仍保留 `window.initDashboard = initDashboard`（属 P2-10 范围，不在本次修改内）。

## 5. 验收标准

- [x] `window.loadDashboardData` 全局挂载已移除
- [x] `window.initDashboard` 全局挂载（Dashboard.js 侧）已移除
- [x] 导航到看板时通过 `dashboard:refresh` CustomEvent 触发刷新
- [x] 5 个 service sync 事件合并为 200ms 防抖，避免重复刷新
- [x] `git diff --stat` 修改范围仅限 `js/modules/Dashboard.js` 和 `js/main.js`

## 6. 回归测试要点

- [ ] 登录后切换到"数据看板"页面，看板数据正常加载
- [ ] 各检测模块新增/修改/删除记录后，看板统计与概览列表自动刷新
- [ ] 快速访问模式下看板延迟加载（2.5s）正常
- [ ] 浏览器控制台无 `window.loadDashboardData is not a function` 报错

## 7. 技术债

**TD-P2-24**：`js/utils/SampleDataGenerator.js` L262 仍引用 `window.loadDashboardData`（P1-20 修复后该值为 `undefined`，走 catch 分支后由同文件 L273 `dispatchEvent(new Event('dataChanged'))` 后备触发刷新，功能不丢失但产生误导性日志 `"📌 Dashboard尚未初始化或无法直接调用loadDashboardData"`）。建议后续将 `SampleDataGenerator.js` 中 `window.loadDashboardData` 调用改为 `dispatchEvent(new CustomEvent('dashboard:refresh'))`，消除日志噪音。该清理与 P1-22（SampleDataGenerator ID 格式）可合并处理。

## 8. 备注

- 代码提交哈希：`5381c27`（`fix(P1-20): Dashboard全局函数改CustomEvent+合并sync事件防抖`）
- 修改文件 2 个：`js/modules/Dashboard.js`（+11/-11）、`js/main.js`（+3/-3）
- `main.js` L254/L271 的 `window.initDashboard = initDashboard` 重复暴露属 P2-10 范围，本次不修改
