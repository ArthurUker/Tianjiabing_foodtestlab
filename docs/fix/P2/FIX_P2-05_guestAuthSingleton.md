# FIX-P2-05：Router.init() 每次调用都实例化新的 GuestAuthService

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-05` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `js/core/Router.js` |
| **预估工时** | 0.5h |
| **关联问题** | - |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

`Router` 的方法每次调用都在函数体内 `new GuestAuthService()`，反复创建实例。`GuestAuthService` 内部持有状态与事件绑定，重复实例化造成不必要的内存分配，且可能导致重复的事件监听器累积。

## 2. 根因分析

`js/core/Router.js` 原在方法内部局部创建 `GuestAuthService` 实例（如 `const guestAuthService = new GuestAuthService()`），未在模块级共享，每次导航/权限检查都重新构造。

## 3. 修复方案（2026-07-04 实施）

提升为模块级共享单例：

```javascript
// P2-05: 模块级共享单例，避免 Router 各方法每次调用都实例化新的 GuestAuthService
const guestAuthService = new GuestAuthService();
```

各方法内改为引用该模块级单例（L233 注释：兼容 main.js 可能挂载的 window.guestAuthService）。

## 4. 验收标准

- [x] `GuestAuthService` 在模块加载时仅实例化一次
- [x] Router 各方法复用同一实例
- [x] 静态验证通过

## 5. 回归测试要点

- [ ] 多次导航后无重复事件监听器累积

## 6. 备注

> 无。
