# FIX-P0-02：authenticateUser 中间件三处实现不一致

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P0-02` |
| **优先级** | 🔴 P0 高危（建议 1~3 天内处理） |
| **影响文件** | `backend/server.js, userRoutes.js, auditRoutes.js` |
| **预估工时** | 3h |
| **关联问题** | P0-01, P0-04 |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-06-22 |

---

## 1. 问题描述

<!-- 详细描述问题的现象、触发条件、影响范围 -->

> 待填写。

## 2. 根因分析

<!-- 分析问题产生的根本原因，定位到具体代码行 -->

> 待填写。

## 3. 修复方案

### 方案 A（推荐）

```diff
// 待填写
```

### 方案 B（备选）

> 暂无备选方案。

## 4. 验收标准

- [ ] 验收条件 1
- [ ] 验收条件 2
- [ ] 验收条件 3

## 5. 回归测试要点

- [ ] 测试点 1
- [ ] 测试点 2

## 6. 备注

> 已通过 Monica 代码审阅（2026-06-22）。修复质量优秀。
> 新建 authMiddleware.js 采用工厂函数模式，成功统一三处分散实现（userRoutes.js、auditRoutes.js、server.js）。
> server.js 中使用 _authUser/_authAdmin 别名，为 P0-01 syncRoutes 重写预留接口。
> 遗留：userRoutes.js 中冗余的 import jwt 可在 P2 阶段清理（不影响功能）。
> 遗留补修（2026-06-23）：确认 userRoutes.js 已移除直接 `import jwt`，引入 `createAuthMiddleware` 统一处理认证，删除文件内重复定义的 `authenticateUser` / `authorizeAdmin` 函数，所有路由的 `authorizeAdmin` 替换为 `authorizeRoles('admin', 'manager')`。经 Monica 读取 GitHub 远端 `ZhuHaiYiZhong` 分支核验通过。
