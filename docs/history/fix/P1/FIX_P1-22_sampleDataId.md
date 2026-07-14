# FIX-P1-22：SampleDataGenerator 示例数据 ID 格式与 StorageService 不兼容

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-22` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `js/utils/SampleDataGenerator.js` |
| **预估工时** | 1h |
| **关联问题** | TD-P2-24（P1-20 遗留 `window.loadDashboardData` 死代码清理） |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-07-01 |

---

## 1. 问题

**FIX_PLAN 原始描述**：
> SampleDataGenerator 示例数据 ID 格式与 StorageService 不兼容

**RG_03b 审阅细化**：
- **位置**：`js/utils/SampleDataGenerator.js`
- 示例数据使用 `id: 1`、`id: 2`、`id: 3` 等简单整数
- `StorageService.save()` 生成的 tempId 格式为 `temp_{timestamp}_{random}`，服务端 ID 为 `cuid()`（`schema.prisma` `@default(cuid())`）
- 整数 ID 与两种格式均不兼容，若 `StorageService` 的 `update()` / `delete()` 方法按 ID 查找记录，示例数据可能无法被正确操作
- 示例数据写入 `localStorage` 后，`StorageService._syncFromApi()` 会尝试与服务端同步，但整数 ID 在服务端不存在，可能触发错误

## 2. 根因

快速访问模式下 `main.js` 先调用 `guestAuthService.quickAccessAsViewer()` 签发 guest_token（L144），再调用 `initializeSampleData()`（L150）写入示例数据。此后 StorageService 实例的 `_canSyncWithServer()` 因 guest_token 存在返回 true，`_syncFromApi()` 会执行同步合并（`Storage.js` L246-261）：

- 整数 ID（1/2/3）不以 `temp_` 开头 → `_isTempId()` 返回 false → 不走 temp 保留分支（L248-250）
- 示例数据无 `_status` 字段 → 不走 updating/pending 保留分支（L253-256）
- 整数 ID 不在 `serverDataMap`（服务端为 cuid）→ `serverDataMap.has(localItem.id)` 返回 false → 不 push 到 mergedData

结果：示例数据在首次同步后被从本地缓存中丢弃，快速访问模式用户看到空数据。

## 3. 修复

按 RG_03b 修复建议，示例数据 ID 改用 `temp_sample_{n}` 格式（5 个 init 函数共 12 条记录）：

- `initTableware()`：id 1/2/3 → `temp_sample_1/2/3`
- `initPesticide()`：id 1/2/3 → `temp_sample_1/2/3`
- `initOil()`：id 1/2 → `temp_sample_1/2`
- `initMeat()`：id 1/2 → `temp_sample_1/2`
- `initPathogen()`：id 1/2 → `temp_sample_1/2`

`temp_sample_{n}` 以 `temp_` 开头，`StorageService._isTempId()` 返回 true，同步合并阶段走 L248-250 保留分支，示例数据不再被丢弃。

未采用 `crypto.randomUUID()` 方案：UUID 不以 `temp_` 开头，`_isTempId()` 返回 false，同步时仍会被丢弃，未解决根因。

**TD-P2-24 一并清理**：移除 `initDashboard()` 死代码（原 L255-282），该函数从未被调用（L55 已注释 `// initDashboard();`），且引用的 `window.loadDashboardData` 已被 P1-20 移除。`initializeSampleData()` L61 已自行 dispatch `dataChanged` 事件，功能无损失。

## 4. 功能影响

- 快速访问模式下示例数据在同步后不再被清空，访客可稳定查看演示数据
- 示例数据 ID 为字符串 `temp_sample_{n}`，编辑/删除走 StorageService temp 分支（本地生效，不触发服务端写操作），符合示例数据仅用于展示的定位
- `initDashboard()` 死代码移除后，不再产生 `📌 Dashboard尚未初始化或无法直接调用loadDashboardData` 误导性日志

## 5. 技术债

**TD-P2-26**：快速访问模式示例数据使用 `temp_` 前缀 ID 借助 `_isTempId()` 保留，属于依赖实现细节的 workaround。更彻底的方案是在快速访问模式下完全禁用 StorageService 同步（RG_03b 备选方案），避免示例数据与真实同步逻辑耦合，建议后续与 P2 系列优化合并评估。

## 6. 备注

- 代码提交：`85ead3f`（`fix(P1-22): 示例数据ID改temp_sample格式，清理TD-P2-24死代码`）
- TD-P2-24（P1-20 遗留 `window.loadDashboardData` 死代码）已在本次一并清理
- 消费方分析：`initializeSampleData()` 仅在 `main.js:150` 调用；5 个 init 函数均为内部函数（无 export），无外部消费方
