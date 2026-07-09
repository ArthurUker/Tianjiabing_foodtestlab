# FIX-P0-12：JWT_SECRET 默认值泄露至 git 历史 + 缺少默认值运行时守卫

| 字段 | 内容 |
|------|------|
| **问题 ID** | `P0-12` |
| **优先级** | 🔴 P0 高危 |
| **影响文件** | `backend/.env`（历史提交）、`backend/server.js`、`backend/middleware/validationMiddleware.js` |
| **预估工时** | 2h |
| **关联问题** | P0-03（JWT 密钥 fallback 为弱明文字符串） |
| **状态** | ✅ 已完成（代码侧：黑名单守卫 server.js + 死代码 fallback 清理 validationMiddleware.js + 本地 .env 轮换；子问题1 git历史清理与子问题2生产核实需人工，见第7节） |
| **完成日期** | - |

---

## 1. 问题描述

本轮安全核查（子任务一）发现三个相互关联的 JWT_SECRET 安全缺陷：

### 子问题 (1)：默认占位密钥泄露至 git 历史（已确认）

提交 `35b74e7`（🧹 项目清理）曾将 `backend/.env` 纳入版本控制，其中包含 `JWT_SECRET=your-secret-key-change-in-production`（占位符密钥）。该文件后在 `ac8af41` 从跟踪中移除，但**历史提交中仍可检索到完整内容**：

```
git show 35b74e7:backend/.env
# 含 JWT_SECRET=your-secret-key-change-in-production 及 Supabase 配置
```

任何能访问仓库历史的人均可获取此密钥。若生产环境仍沿用此占位值，则身份认证根基被完全旁路。

### 子问题 (2)：本地 backend/.env 仍使用默认占位值（已确认）

本地磁盘 `backend/.env`（2026-06-30 10:38）的 `JWT_SECRET` 经比对**确认为默认占位值** `your-super-secret-jwt-key-change-this-in-production`（与 `.env.example` 一致）。根目录 `.env` 同样为默认值。

### 子问题 (3)：缺少默认值运行时守卫（已确认）

`backend/server.js`（L32-36）仅校验 `JWT_SECRET` 是否为空（空则 `process.exit(1)`），**不校验是否为已知默认占位值**。即使生产环境误用 `.env.example` 的默认值，服务器仍会正常启动并以此弱密钥签发所有 JWT，无任何告警。

### 子问题 (4)：validationMiddleware 残留第二套 JWT 验证路径（死代码）

`backend/middleware/validationMiddleware.js` L427 存在 `process.env.JWT_SECRET || 'food-lab-secret-key'` 硬编码 fallback。经核查 `validateToken` 函数全后端无导入调用方（死代码），实际认证走 `createAuthMiddleware`，故此 fallback 当前不可达，但属残留隐患，应清理。

## 2. 根因分析

- 子问题(1)：早期 `.gitignore` 未及时覆盖 `backend/.env`，导致含密钥的 .env 被提交；后续虽移除跟踪但未清理 git 历史。
- 子问题(2)：本地开发沿用 `.env.example` 占位值未替换。
- 子问题(3)：P0-03 修复仅移除了代码内 `|| 'local-dev-jwt-secret'` fallback 并增加空值守卫，但未增加"已知弱默认值"黑名单校验。
- 子问题(4)：P0-03 修复 `server.js` 时未同步清理 `validationMiddleware.js` 中的同类 fallback。

## 3. 生产环境结论

**【无法确认】** 生产环境实际使用的 JWT_SECRET 是否已替换。代码审查无法触达生产服务器的 `.env` 文件内容。须由项目负责人登录生产服务器核实（见第 7 节操作指引）。

已知高风险信号：
- 默认占位值已泄露至 git 历史（任何人可获取）
- 本地 .env 沿用默认值
- 无运行时守卫拦截默认值
- `deploy.ps1` 不生成随机密钥（部署依赖现有 .env）

## 4. 修复方案（待实施）

### 子问题 (1)：清理 git 历史
- 使用 `git filter-repo` 或 BFG Repo-Cleaner 从历史中移除 `backend/.env`
- 强制 push 重写历史（需协调所有协作者）
- ⚠️ 历史已泄露的密钥视为已 compromise，**必须轮换**（无论生产是否使用，本地 .env 的默认值都应替换）

### 子问题 (2)：替换本地 .env 密钥
- 生成强随机密钥：`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- 写入 `backend/.env` 的 `JWT_SECRET`

### 子问题 (3)：增加默认值运行时守卫
在 `server.js` 启动校验中增加已知弱值黑名单：
```javascript
const KNOWN_WEAK_SECRETS = [
  'your-super-secret-jwt-key-change-this-in-production',
  'your-secret-key-change-in-production',
  'local-dev-jwt-secret',
  'food-lab-secret-key',
  'please_change_this_secret'
]
if (KNOWN_WEAK_SECRETS.includes(JWT_SECRET)) {
  console.error('[FATAL] JWT_SECRET is a known weak/default value. Server startup aborted.')
  process.exit(1)
}
```

### 子问题 (4)：清理死代码 fallback
移除 `validationMiddleware.js` L427 的 `|| 'food-lab-secret-key'` fallback（或整体移除未使用的 `validateToken` 函数）。

## 5. 验收标准

- [ ] git 历史中 `backend/.env` 内容不可检索（`git log --all -S "your-secret-key-change-in-production"` 无命中）
- [ ] 本地 `backend/.env` JWT_SECRET 为强随机值，非任何已知占位符
- [ ] server.js 启动时检测到已知弱值则拒绝启动
- [ ] validationMiddleware 无硬编码密钥 fallback
- [ ] 生产服务器 .env 经核实使用强随机密钥（人工核实）

## 6. 回归测试要点

- [ ] 使用默认值启动 server.js → 启动失败退出
- [ ] 使用强随机值启动 → 正常启动
- [ ] 旧 JWT token（默认值签发）在新密钥下验证失败

## 7. 生产环境核实指引（非技术背景决策者适用）

**目标**：确认生产服务器上的 JWT_SECRET 是否为安全的随机密钥（而非默认占位值）。

**步骤**：
1. 登录生产服务器（Windows 服务器，D 盘部署，依据 `.env.example` 路径 `D:/ZhuHaiYiZhong-data/`）。
2. 找到后端 `.env` 文件，通常位于后端项目目录下（如 `D:\ZhuHaiYiZhong\backend\.env`）。
3. 用记事本打开，找到以 `JWT_SECRET=` 开头的那一行。
4. 检查等号后面的值：
   - 若为 `your-super-secret-jwt-key-change-this-in-production`、`your-secret-key-change-in-production`、`please_change_this_secret` 等"看起来像提示语"的字符串 → **危险，仍是默认值，必须立即替换**。
   - 若为一长串无规律的字母数字字符（通常 60 位以上）→ **安全，已替换为随机密钥**。
5. 若发现是默认值，请让技术人员执行：生成随机密钥 → 替换该行 → 重启后端服务 → 所有用户需重新登录。

> ⚠️ 由于默认值已泄露到 git 历史，即使生产已替换，也建议确认历史泄露的密钥未被任何环境沿用。
