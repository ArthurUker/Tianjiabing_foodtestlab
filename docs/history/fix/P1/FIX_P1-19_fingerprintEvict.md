# FIX-P1-19：AdaptiveUploadQueue 指纹缓存淘汰策略未确认

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-19` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `js/core/AdaptiveUploadQueue.js` |
| **预估工时** | 1h |
| **关联问题** | - |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-06-29 |

---

## 1. 问题描述

指纹缓存原使用 FIFO 固定上限淘汰策略，高频场景下可能因缓存被淘汰导致重复上传。

## 2. 根因分析

`AdaptiveUploadQueue._markCompleted()` 在达到 `maxFingerprintCache` 时使用 shift-based FIFO 淘汰最早记录，未考虑 TTL。

## 3. 修复方案

### 方案 A（已实施）

新增 `_cleanupExpiredFingerprints()` 方法（第 257–263 行），遍历 Map 逐项按 TTL 过期删除；`_markCompleted()` 调用 TTL 清理替代 FIFO 淘汰。

- 修改文件：`js/core/AdaptiveUploadQueue.js`
- 修改位置：
  - `_cleanupExpiredFingerprints()`（第 257–263 行）
  - `_markCompleted()`（第 265–269 行，注释标注 "P1-19: 使用 TTL 批量过期清理，替代固定上限 FIFO 淘汰"）

## 4. 验收标准

- [x] `_cleanupExpiredFingerprints()` 存在并遍历 Map 逐项过期删除
- [x] 代码中无 shift-based eviction 逻辑
- [x] `_markCompleted()` 调用 TTL 清理

## 5. 回归测试要点

- [x] 确认 FIFO 淘汰已移除
- [ ] 高频上传场景下指纹缓存按 TTL 自动清理

## 6. 功能影响

修复后，`_completedFingerprints` 缓存按 TTL（默认 60s）批量过期清理，而非固定上限 FIFO 淘汰。高频写入场景下，最近完成的指纹在 TTL 窗口内仍可命中去重，避免因缓存淘汰导致的重复上传。`_maxFingerprintCache` 配置项保留但不再用于淘汰决策。

## 7. 技术债

**TD-P2-23**：`_maxFingerprintCache`（默认 500）配置项在 P1-19 修复后不再参与淘汰决策，仅为遗留字段。建议在后续清理中移除该配置项及其构造函数赋值，避免误导维护者以为仍存在上限淘汰逻辑。

## 8. 备注

`_maxFingerprintCache` 配置项保留但不再用于 FIFO 淘汰，可在后续清理中移除（详见 TD-P2-23）。
