# FIX-P2-06：/api/health 与 /health 重复定义

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-06` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `backend/server.js` |
| **预估工时** | 0.5h |
| **关联问题** | - |
| **状态** | ✅ 已完成（静态验证通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

健康检查端点 `/health` 与 `/api/health` 分别注册了两个独立的处理函数，逻辑重复（均返回 `{ status: 'ok' }`），维护时需同步修改两处，易产生不一致。

## 2. 根因分析

`backend/server.js` 原有两处 `app.get('/health', ...)` 与 `app.get('/api/health', ...)`，各写一个内联处理器，未抽取公共函数。

## 3. 修复方案（2026-07-04 实施）

抽取公共处理器，两个路由共用：

```javascript
// Health Check (P2-06: 合并重复定义，两个路由共用同一处理器)
function healthCheck(req, res) {
    res.json({ status: 'ok', timestamp: new Date() })
}
app.get('/health', healthCheck)
app.get('/api/health', healthCheck)
```

## 4. 验收标准

- [x] `/health` 与 `/api/health` 共用同一 `healthCheck` 处理器
- [x] 两个端点返回结构一致
- [x] 静态验证通过

## 5. 回归测试要点

- [ ] 两个端点均返回 200 + `{ status: 'ok' }`

## 6. 备注

> 无。
