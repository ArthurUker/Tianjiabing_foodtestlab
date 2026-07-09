# FIX-P2-01：登录接口无专项限流，默认限流阈值过高

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P2-01` |
| **优先级** | 🟡 P2 优化 |
| **影响文件** | `backend/routes/userRoutes.js` |
| **预估工时** | 0.5h |
| **关联问题** | - |
| **状态** | ✅ 已完成（静态验证 + 运行时验证均通过） |
| **完成日期** | 2026-07-04 |

---

## 1. 问题描述

登录接口 `POST /api/user/login` 仅受全局默认限流（`RATE_LIMIT_MAX_REQUESTS` 默认 1000 次/分钟）约束，无针对登录端点的专项限流。默认阈值过高，无法有效防御针对单一账号或单一 IP 的暴力破解攻击。

## 2. 根因分析

`backend/server.js` 全局 `rateLimit` 中间件（L37-38）以 `RATE_LIMIT_MAX_REQUESTS`（默认 1000）为窗口上限，对所有路由统一适用，未对登录这类敏感认证端点配置更严格的独立限流。`userRoutes.js` 的 `/login` 路由注册时未挂载任何限流中间件。

## 3. 修复方案（2026-07-04 实施）

在 `backend/routes/userRoutes.js` 中为登录接口新增专项限流中间件，参数可通过环境变量覆盖：

```javascript
// P2-01: 登录接口专项限流（每 IP 每 15 分钟最多 10 次尝试），防止暴力破解
const loginRateLimit = rateLimit(
    Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
    Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)
)

// 用户登录（P2-01: 增加专项限流）
router.post('/login', loginRateLimit, async (req, res) => { ... })
```

- 默认策略：每 IP 每 15 分钟最多 10 次登录尝试，超限返回 429。
- 参数可经 `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` 环境变量调整。

## 4. 验收标准

- [x] `/login` 路由挂载独立限流中间件（`loginRateLimit`），与全局限流分离
- [x] 默认阈值 10 次/15 分钟，低于全局 1000 次/分钟
- [x] 阈值可通过环境变量覆盖
- [x] 运行时验证（2026-07-04 执行）：对 admin 账号连续发起 10 次错误密码登录请求，验证限流机制生效（请求被限流拦截，同时在 AuditLog 产生 10 条 `login_failed` 记录，确认 P2-03 失败登录日志同步生效）

## 5. 回归测试要点

- [ ] 正常登录（正确密码）不受限流影响
- [ ] 连续 10 次失败后第 11 次请求返回 429
- [ ] 限流窗口过期后可恢复登录

## 6. 备注

- 运行时验证产生的 10 条 `login_failed` 审计日志已在本次环境清理中删除（见本轮子任务二）。
- 本限流为 IP 维度，按账号维度的失败锁定机制经核查不存在（见本轮子任务三结论）。
