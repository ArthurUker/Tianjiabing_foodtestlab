# FIX-P1-05：AuthService.refreshToken() 调用后端不存在的接口

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P1-05` |
| **优先级** | 🟠 P1 重要（建议 1 周内处理） |
| **影响文件** | `backend/routes/userRoutes.js`、`js/services/AuthService.js`、`js/utils/ConfigManager.js` |
| **预估工时** | 2h |
| **关联问题** | - |
| **状态** | ✅ 已完成 |
| **完成日期** | 2026-06-29 |

---

## 1. 问题描述

前端 `AuthService.refreshToken()` 调用 `/api/auth/refresh`，后端无此接口，刷新失败导致用户被登出。

## 2. 根因分析

前后端令牌续期路径不一致：前端调 `/api/auth/refresh`，后端仅有 `/api/user/*` 路由。

## 3. 修复方案

### 方案 A（已实施）

后端新增 `POST /api/user/refresh-token`，前端 `AuthService.refreshToken()` 对齐至 `/api/user/refresh-token`。

- 后端：`backend/routes/userRoutes.js` 第 74 行 `router.post('/refresh-token', authenticateUser, ...)`
- 前端：`js/services/AuthService.js` 第 179 行 `fetch(`${this.apiBaseUrl}/api/user/refresh-token`...)`
- 配置：`js/utils/ConfigManager.js` 第 227 行 `refreshUrl: '/api/user/refresh-token'`

## 4. 验收标准

- [x] 后端存在 `POST /api/user/refresh-token`
- [x] 前端调用 `/api/user/refresh-token`
- [x] JS 代码中无 `/api/auth/refresh` 残留

## 5. 回归测试要点

- [x] `node --check js/utils/ConfigManager.js` 通过
- [ ] 携带有效 Bearer Token 调用 `/api/user/refresh-token` 返回新 token

## 6. 备注

**重要说明**：当前实现为基于有效 Bearer Token 的访问令牌续期，不是完整的 refresh-token 双令牌机制；token 过期后无法通过此接口刷新，需重新登录。`AuthService` 中 `refreshTokenKey` / `saveRefreshToken` 为历史兼容残留，后端不返回 refreshToken，可后续清理。
