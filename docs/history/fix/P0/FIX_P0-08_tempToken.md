# FIX-P0-08：Storage.js temp-token- 前缀可被客户端伪造

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P0-08` |
| **优先级** | 🔴 P0 高危（建议 1~3 天内处理） |
| **影响文件** | `js/core/Storage.js` |
| **预估工时** | 1h |
| **关联问题** | P0-07 |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-06-23 |

---

## 1. 问题描述

> `_canSyncWithServer()` 方法通过 `token.startsWith('temp-token-')` 判断是否阻断数据同步。该前缀字符串为纯客户端约定，后端从不验证，攻击者可构造任意以 `temp-token-` 开头的伪造 Token 绕过阻断逻辑，触发未经授权的数据上传。

## 2. 根因分析

> 客户端自行约定 Token 前缀作为"是否为临时 Token"的判断依据，缺乏服务端背书。任何可以执行 JS 代码的攻击者均可绕过此判断。

## 3. 修复方案

### 方案 A（推荐，已采用）

```diff
- if (!token || token.startsWith('temp-token-')) {
-   return false;
- }
+ if (!token) {
+   return false;
+ }
```

> 删除 `temp-token-` 前缀判断，改为依赖后端 401 响应作为唯一阻断机制。无 Token 时仍阻断同步，有 Token 时允许尝试，由后端鉴权决定是否接受。

### 方案 B（备选）

> 向后端 `/api/user/verify-token` 发起验证请求，确认 Token 有效后再允许同步。实现成本较高，当前阶段不采用。

## 4. 验收标准

- [x] `_canSyncWithServer()` 中不再包含 `temp-token-` 字符串
- [x] 无 Token 时同步仍被正确阻断
- [x] 有效 Token 时同步正常触发，后端 401 时自动停止

## 5. 回归测试要点

- [ ] 登录状态下正常操作，数据可正常同步到后端
- [ ] 未登录状态下，`_canSyncWithServer()` 返回 false，不触发同步

## 6. 备注

> 已通过 Monica 代码审阅（2026-06-23）。修复方案简洁有效，以后端 401 作为唯一鉴权阻断，符合最小改动原则。
