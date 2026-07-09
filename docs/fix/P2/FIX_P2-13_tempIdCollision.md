# FIX-P2-13：tempId 使用 Date.now()+Math.random()，多标签页可能碰撞

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-13` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/core/Storage.js` |
| **预估工时** | 1h |
| **关联问题** | - |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`StorageService.save()` 生成临时记录 ID 时使用 `Date.now()+Math.random()` 拼接格式。同一毫秒内多标签页/多操作并发时，`Math.random()` 碰撞概率虽低但非零，可能产生重复 tempId，导致缓存合并时记录互相覆盖。

## 2. 根因分析

`js/core/Storage.js` 的 tempId 生成基于时间戳 + 伪随机数，非密码学强度唯一性保证。多标签页同时创建记录时存在理论碰撞风险。

## 3. 修复方案（2026-07-04 实施）

改用 `crypto.randomUUID()` 生成 tempId，保留 `temp_` 前缀以兼容 `_isTempId()` 判定逻辑：

```javascript
const tempId = `temp_${crypto.randomUUID()}`;
```

`crypto.randomUUID()` 提供密码学强度唯一性（RFC 4122 v4），碰撞概率可忽略。`temp_` 前缀保留是因 `_isTempId()`、同步合并逻辑（L247-261）均依赖此前缀区分临时记录与服务端记录。

## 4. 验收标准

- [x] tempId 格式为 `temp_{uuid-v4}`
- [x] 保留 `temp_` 前缀，`_isTempId()` 判定不受影响
- [x] 静态验证通过

## 5. 回归测试要点

- [ ] 多标签页同时创建记录，tempId 不碰撞
- [ ] 同步合并阶段 tempId 记录正确保留（走 L248-250 保留分支）

## 6. 备注

- 未采用纯 `crypto.randomUUID()`（无前缀）方案：UUID 不以 `temp_` 开头，`_isTempId()` 返回 false，同步时会被丢弃，未解决根因（见 P1-22 同类讨论）。
