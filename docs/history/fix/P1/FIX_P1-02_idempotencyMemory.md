# FIX-P1-02：幂等性中间件使用内存存储，PM2重启后全部失效

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-02` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `backend/middleware/idempotencyMiddleware.js` |
| **预估工时** | 2h |
| **关联问题** | - |
| **状态** | ✅ 已完成（短期稳态优化） |
| **完成日期** | 2026-06-29 |

---

## 1. 问题描述

幂等键缓存使用内存 Map 存储，PM2 重启后全部失效；原实现每次请求都全量遍历清理，存在性能隐患。

## 2. 根因分析

`idempotencyMiddleware.js` 中 cleanup 无节流，高频请求下每次都遍历整个 Map。

## 3. 修复方案

### 方案 A（已实施）

新增 `CLEANUP_INTERVAL`（5 分钟）和 `lastCleanupAt` 节流变量；`cleanup()` 函数增加节流判断，间隔内直接返回，避免每次请求都全量遍历。

- 修改文件：`backend/middleware/idempotencyMiddleware.js`
- 修改位置：第 6–19 行

## 4. 验收标准

- [x] `CLEANUP_INTERVAL` 常量存在（第 6 行）
- [x] `lastCleanupAt` 节流变量存在（第 7 行）
- [x] `cleanup()` 含节流判断（第 11 行）

## 5. 回归测试要点

- [x] 确认节流逻辑存在且生效
- [ ] 高并发场景下 cleanup 不再每次遍历

## 6. 备注

仍为内存 Map 存储，Redis 化作为中期优化保留（PM2 重启失效问题未根治，仅做短期稳态优化）。
