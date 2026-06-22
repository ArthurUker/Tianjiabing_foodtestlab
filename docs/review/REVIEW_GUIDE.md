# 食品安全检验管理系统 Pro — 代码审阅上下文指导文档

**文档路径**：`docs/review/REVIEW_GUIDE.md`
**系统名称**：食品安全检验管理系统 Pro（珠海一中食品安全检验系统）
**仓库地址**：https://github.com/ArthurUker/Tianjiabing_foodtestlab/tree/ZhuHaiYiZhong
**审阅开始日期**：2026-06-22
**文档版本**：v0.2（2026-06-22 第二轮更新）
**文档用途**：每次新对话开始时，将本文件提供给 AI，以快速恢复审阅上下文，无需重新读取全部代码。

---

## 1. 系统背景速查

### 1.1 核心技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | 原生 HTML + JS ES Modules + Tailwind CSS | 非 React/Vue，模块化原生架构 |
| 可视化 | Chart.js | 数据看板 |
| 文档处理 | Mammoth.js / jsPDF / html2canvas | Word 解析、PDF 导出 |
| 后端 | Node.js + Express.js | REST API |
| ORM | Prisma Client | 数据库建模与访问 |
| 数据库 | SQLite（生产）| 单文件，路径 `D:\珠海一中\foodtestlab.db` |
| 认证 | JWT Bearer Token + bcryptjs | Token 有效期 7 天 |
| 进程守护 | PM2（进程名 `zhuhaiyizhong-api`）| |
| 反向代理 | Nginx | 前端端口 8082，后端 API 端口 3002 |
| 部署环境 | 腾讯云 Windows Server | 部署分支 `ZhuHaiYiZhong` |

### 1.2 生产部署口径

| 项目 | 配置 |
|------|------|
| 项目目录 | `C:\zhuhaiyizhong` |
| 前端访问端口 | `8082` |
| 后端 API 端口 | `3002` |
| PM2 进程名 | `zhuhaiyizhong-api` |
| 数据库文件 | `D:\珠海一中\foodtestlab.db` |
| API 前缀 | `/api` |
| 登录接口 | `POST /api/user/login` |

### 1.3 后端目录结构

```
backend/
├── server.js                        # 主入口，Express 路由注册、中间件配置
├── modules/
│   └── UserManager.js               # 用户注册/登录/权限逻辑 ✅ 已审阅
├── routes/
│   ├── userRoutes.js                # /api/user/* 路由 ✅ 已审阅
│   ├── auditRoutes.js               # /api/audit-logs/* 路由 ✅ 已审阅
│   └── syncRoutes.js                # /api/sync/* 路由 ✅ 已审阅（严重问题）
├── middleware/
│   ├── validationMiddleware.js      # 输入验证、XSS 防护、限流 ✅ 已审阅
│   └── idempotencyMiddleware.js     # 幂等性中间件 ✅ 已审阅
└── prisma/
    ├── schema.prisma                # 数据库模型定义 ✅ 已审阅
    └── seed.js                      # 初始化种子数据 ❌ 未读取
```

### 1.4 前端目录结构

```
js/
├── core/
│   └── Router.js                    # 前端路由与权限守卫 ✅ 已审阅
├── services/
│   ├── AuthService.js               # 认证服务 ✅ 已审阅
│   ├── GuestAuthService.js          # 访客认证 ❌ 未读取
│   └── PermissionService.js         # 权限服务 ❌ 未读取
├── utils/
│   ├── AuditLogger.js               # 前端审计日志工具 ❌ 未读取
│   ├── FormValidator.js             # 表单验证工具 ✅ 文档已读
│   ├── UINotification.js            # UI 通知组件 ✅ 文档已读
│   └── NetworkHelper.js             # 网络请求封装 ❌ 未读取
└── modules/                         # 各业务模块 ❌ 未读取
```

### 1.5 关键接口速查

| 接口 | 方法 | 权限 | 说明 |
|------|------|------|------|
| `/api/user/login` | POST | 公开 | 用户登录 |
| `/api/user/register` | POST | 公开⚠️ | 用户注册（应限制） |
| `/api/user/verify-token` | POST | 公开 | Token 验证 |
| `/api/user/me` | GET | 已登录 | 获取当前用户 |
| `/api/user/change-password` | POST | 已登录 | 修改密码 |
| `/api/user/list` | GET | Admin | 用户列表 |
| `/api/user/:id/role` | POST | Admin | 修改角色 |
| `/api/audit-logs` | GET/POST | 已登录 | 审计日志 |
| `/api/audit-logs/stats/summary` | GET | Admin⚠️ | 路由冲突风险 |
| `/api/sync/users` | POST | 无认证⚠️ | 用户同步（危险） |
| `/api/sync/testRecords` | POST | 无认证⚠️ | 记录同步（危险） |
| `/api/records/:type` | GET/POST/PUT/DELETE | 已登录 | 检测记录 CRUD |
| `/api/auth/refresh` | POST | 公开 | Token 刷新⚠️ 后端未实现 |

---

## 2. 已审阅文件清单

| 文件 | 审阅状态 | 完整度 | 主要发现 |
|------|----------|--------|----------|
| `backend/server.js` | ✅ 已审阅 | ~80% | 双重 record_code 逻辑、硬编码 IP、弱密钥 fallback |
| `backend/prisma/schema.prisma` | ✅ 已审阅 | 100% | Cascade 删除风险、Guest 模型冗余 |
| `backend/routes/userRoutes.js` | ✅ 已审阅 | ~90% | 认证中间件重复定义、注册接口无保护 |
| `backend/routes/auditRoutes.js` | ✅ 已审阅 | ~90% | 路由注册顺序冲突、认证实现不一致 |
| `backend/routes/syncRoutes.js` | ✅ 已审阅 | ~85% | **严重：无认证保护、使用 CommonJS、不操作数据库** |
| `backend/middleware/validationMiddleware.js` | ✅ 已审阅 | ~40% | escapeMap 编码疑似错误 |
| `backend/middleware/idempotencyMiddleware.js` | ✅ 已审阅 | 100% | 内存存储、无持久化、PM2 重启后失效 |
| `backend/modules/UserManager.js` | ✅ 已审阅 | ~75% | 自动生成虚假 email、密码强度校验弱 |
| `js/services/AuthService.js` | ✅ 已审阅 | ~90% | Token 存 localStorage（XSS 风险）、refreshToken 后端未实现 |
| `js/core/Router.js` | ✅ 已审阅 | ~85% | 权限控制仅靠前端 CSS 隐藏、全局暴露 window.router |
| `backend/prisma/seed.js` | ❌ 未读取 | — | — |
| `js/services/GuestAuthService.js` | ❌ 未读取 | — | — |
| `js/services/PermissionService.js` | ❌ 未读取 | — | — |
| `js/utils/AuditLogger.js` | ❌ 未读取 | — | — |
| `js/utils/NetworkHelper.js` | ❌ 未读取 | — | — |
| `js/main.js` | ❌ 未读取 | — | — |

---

## 3. 已发现问题清单（完整版）

### 🔴 P0 — 高危问题（建议 1~3 天内处理）

#### P0-01：`syncRoutes.js` 完全无认证保护，且不操作数据库
- **位置**：`backend/routes/syncRoutes.js`
- **问题（多重）**：
  1. **无认证**：`POST /api/sync/users`、`POST /api/sync/testRecords`、`POST /api/sync/batch` 均无任何 JWT 认证中间件，任何人可直接调用
  2. **伪同步**：路由处理逻辑中完全没有调用 `prisma`，所有"同步"操作仅在内存 `syncLog` 数组中记录日志，数据从未写入数据库
  3. **模块规范错误**：文件使用 `const express = require('express')` (CommonJS)，而项目其他文件均使用 ES Module (`import`)，在 `"type": "module"` 的 package.json 下会直接导致运行时报错
  4. **ID 生成不安全**：`add` 操作使用 `Date.now()` 生成 ID，与数据库 `cuid()` 规范不一致
- **修复建议**：
  - 将文件改写为 ES Module 格式
  - 添加 `authenticateUser` 中间件
  - 将同步逻辑接入 Prisma，真正写入数据库
  - 参考 `server.js` 中的 `buildDeterministicRecordCode()` 统一 ID 生成

#### P0-02：`authenticateUser` 中间件三处实现不一致
- **位置**：`server.js`（export 函数）、`userRoutes.js`（局部函数）、`auditRoutes.js`（局部函数）
- **问题**：
  - `server.js` 版本：调用 `userManager.verifyToken()`，挂载到 `req.userId` + `req.userRole`
  - `userRoutes.js` 版本：调用 `userManager.verifyToken()`，挂载到 `req.user`（对象）
  - `auditRoutes.js` 版本：直接调用 `jwt.verify()`，绕过 `UserManager`，挂载到 `req.user`
  - 三处挂载字段名不同，下游代码若混用将导致 `undefined` 引用错误
- **修复建议**：抽取为独立模块 `middleware/authMiddleware.js`，统一导出，所有路由文件 import 使用

#### P0-03：JWT 密钥 fallback 为弱明文字符串
- **位置**：`backend/server.js`
- **代码**：`const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-jwt-secret'`
- **问题**：生产环境若 `.env` 未配置 `JWT_SECRET`，系统将使用公开可猜测的弱密钥签发 JWT
- **修复建议**：
  ```js
  if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is not set. Server will not start.')
    process.exit(1)
  }
  const JWT_SECRET = process.env.JWT_SECRET
  ```

#### P0-04：`POST /api/user/register` 完全公开，无需授权
- **位置**：`backend/routes/userRoutes.js`
- **问题**：任何人均可自行注册账号，对于内部管理系统存在越权注册风险
- **附注**：前端 `AuthService.registerUser()` 虽然在请求头中携带了 `Authorization`，但后端路由本身不校验，Token 形同虚设
- **修复建议**：在路由上添加 `authenticateUser` + `authorizeAdmin` 中间件

#### P0-05：`record_code` 双重生成逻辑并存，幂等性失效
- **位置**：`backend/server.js`
- **问题**：
  - `POST /api/test-records`（通用接口）使用 `REC-${Date.now()}` 生成
  - `/api/records/:type` 路由使用 `buildDeterministicRecordCode()`（SHA-256 哈希）
  - 两套逻辑并存，`Date.now()` 方案无法保证幂等性，前端重试时会产生重复记录
- **修复建议**：统一使用 `buildDeterministicRecordCode()`，废弃 `Date.now()` 方案

---

### 🟠 P1 — 重要问题（建议 1 周内处理）

#### P1-01：`auditRoutes.js` 路由注册顺序冲突
- **位置**：`backend/routes/auditRoutes.js`
- **问题**：`GET /:logId` 注册在 `GET /stats/summary` 之前，`/stats/summary` 中的 `summary` 会被识别为 `logId` 参数，统计接口永远无法命中
- **修复建议**：将所有具名静态路由（`/stats/summary`、`/cleanup`）移到动态参数路由（`/:logId`）之前注册

#### P1-02：`idempotencyMiddleware` 使用内存存储，PM2 重启后全部失效
- **位置**：`backend/middleware/idempotencyMiddleware.js`
- **问题**：
  - 使用 `Map` 存储幂等键，进程重启（PM2 restart / crash）后所有缓存清空
  - 若前端在重启前后使用相同 `Idempotency-Key` 重试，会产生重复写入
  - `cleanup()` 函数在每次请求时同步执行全量遍历，高并发下有性能问题
- **修复建议**：中期替换为 Redis 存储；短期可在 `cleanup` 中加入节流（如每 60 秒执行一次）

#### P1-03：`UserManager.registerUser()` 自动生成虚假 email
- **位置**：`backend/modules/UserManager.js`
- **代码**：`const autoEmail = \`${username}@foodlab.local\``
- **问题**：
  - `User` 模型中 `email` 字段有 `@unique` 约束，自动生成的 `@foodlab.local` 邮箱会占用 unique 槽位
  - 若后续真实邮箱与自动生成邮箱冲突，更新操作会报 unique 约束错误
  - 用户注册时并未要求填写 email，但 Schema 中 email 为 `@unique`，逻辑上存在矛盾
- **修复建议**：将 `email` 字段改为非必填且允许 `null`（已是 `String?`），注册时不自动生成虚假邮箱，仅在用户主动填写时存储

#### P1-04：`UserManager` 密码强度校验过弱
- **位置**：`backend/modules/UserManager.js`
- **问题**：密码仅校验 `length >= 6`，无复杂度要求（无数字、大小写、特殊字符要求），对于管理系统安全性不足
- **修复建议**：增加正则校验，要求至少包含数字和字母，建议最小长度提升至 8 位

#### P1-05：`AuthService` 的 `refreshToken` 调用后端不存在的接口
- **位置**：`js/services/AuthService.js`
- **代码**：`fetch(\`${this.apiBaseUrl}/api/auth/refresh\`, ...)`
- **问题**：后端 `server.js` 和所有路由文件中均未实现 `POST /api/auth/refresh` 接口，调用必然返回 404；但 `AuthService` 在 Token 临近过期时（5 分钟内）会自动触发刷新，导致用户被静默登出
- **修复建议**：二选一：① 后端实现 refresh token 接口；② 前端改为 Token 过期后直接跳转登录页，移除 refresh 逻辑

#### P1-06：`Router.js` 权限控制完全依赖前端 CSS 隐藏
- **位置**：`js/core/Router.js`，`updateNavigationByPermission()`
- **问题**：
  - 权限控制通过 `classList.add('hidden')` 实现，仅隐藏 UI 元素，不阻止 API 调用
  - 用户通过浏览器开发者工具移除 `hidden` 类即可访问被隐藏的功能
  - 访客权限限制（如隐藏病原体检测模块）完全可被绕过
- **修复建议**：前端 UI 隐藏仅作为用户体验优化，所有敏感操作必须在后端 API 层进行权限校验

#### P1-07：`Router.js` 将自身暴露到 `window.router` 全局作用域
- **位置**：`js/core/Router.js` 构造函数
- **代码**：`window.router = this`
- **问题**：全局暴露路由实例，任何脚本（包括 XSS 注入的脚本）均可调用 `window.router.handleLogout()` 等方法，扩大了攻击面
- **修复建议**：移除 `window.router = this`，改用模块化导出；调试需求可通过开发环境条件判断处理

#### P1-08：`TestRecord` 的 `onDelete: Cascade` 可能导致检测数据意外丢失
- **位置**：`backend/prisma/schema.prisma`
- **问题**：删除用户时会级联删除其所有检测记录，对于食品安全合规场景不可接受（检测记录应永久保留）
- **修复建议**：改为 `onDelete: Restrict`，禁止删除有记录关联的用户；或改为 `onDelete: SetNull` 保留记录但解除用户关联

#### P1-09：`TestRecord` 的 `sample_info` 和 `result_data` 使用 JSON 字符串存储
- **位置**：`backend/prisma/schema.prisma`，`TestRecord` 模型
- **问题**：SQLite 无原生 JSON 类型，字段为 `String?`，无法在数据库层面进行结构化查询；字段损坏时无法感知
- **修复建议**：将高频查询字段（`testDate`、`canteen`、`inspector`）提升为独立 Schema 字段并建立索引

#### P1-10：`Guest` 模型与 `User` 模型高度重复，认证逻辑无法复用
- **位置**：`backend/prisma/schema.prisma`
- **问题**：`Guest` 模型包含与 `User` 几乎相同的字段，但两者独立存储，认证逻辑需要分别实现
- **修复建议**：在 `User.role` 中增加 `guest` 角色，统一认证流程，废弃独立 `Guest` 模型

#### P1-11：CORS 配置硬编码了生产服务器 IP
- **位置**：`backend/server.js`，`parseAllowedOrigins()` 函数
- **代码**：`'http://159.75.106.179:8082'` 硬编码在源码中
- **问题**：IP 变更时需修改代码并重新部署；同时将服务器 IP 暴露至公开仓库
- **修复建议**：完全通过 `CORS_ORIGIN` 环境变量配置，源码中不保留任何 IP 地址

---

### 🟡 P2 — 优化建议（建议 2 周内处理）

#### P2-01：`rateLimit` 默认值过高，登录接口无专项限流
- **位置**：`backend/server.js`
- **问题**：全局限流默认 1000 次/分钟，登录接口无独立限流，无法有效防止暴力破解
- **修复建议**：对 `POST /api/user/login` 单独设置限流（建议 10 次/分钟/IP）

#### P2-02：检测记录 CRUD 操作未自动写入审计日志
- **位置**：`backend/server.js`，记录 CRUD 路由
- **问题**：检测记录的创建、更新、删除操作未自动写入 `AuditLog`，审计追踪不完整
- **修复建议**：在记录 CRUD 路由的成功响应后，统一调用 `prisma.auditLog.create()`

#### P2-03：`UserManager.loginUser()` 的失败登录日志仅记录在内存/控制台
- **位置**：`backend/modules/UserManager.js`，`logFailedLogin()` 方法
- **问题**：`logFailedLogin` 方法存在但实现未完全读取；若仅写 console.log 而不写数据库，则无法追溯暴力破解行为
- **修复建议**：确认 `logFailedLogin` 是否写入 `AuditLog` 表，若未写入则补充实现

#### P2-04：`AuthService.getUser()` 对 `JSON.parse` 无容错处理
- **位置**：`js/services/AuthService.js`
- **代码**：`return userStr ? JSON.parse(userStr) : null`
- **问题**：若 `localStorage` 中存储的用户数据损坏（如被手动修改），`JSON.parse` 会抛出异常，导致页面崩溃
- **修复建议**：
  ```js
  try {
    return userStr ? JSON.parse(userStr) : null
  } catch {
    this.clearAuth()
    return null
  }
  ```

#### P2-05：`Router.init()` 每次调用都实例化新的 `GuestAuthService`
- **位置**：`js/core/Router.js`
- **问题**：`init()` 方法内部每次都 `new GuestAuthService()`，`isGuest()` 方法也每次 `new GuestAuthService()`，造成不必要的重复实例化
- **修复建议**：在 `Router` 构造函数中初始化单例 `this.guestAuthService = new GuestAuthService()`

#### P2-06：`/api/health` 与 `/health` 重复定义
- **位置**：`backend/server.js`
- **修复建议**：统一保留 `/api/health`，删除 `/health`

#### P2-07：`buildRecordWriteData()` 字段提取逻辑脆弱，无 Schema 验证
- **位置**：`backend/server.js`
- **问题**：通过 `baseData.testDate || null` 等方式提取字段，前端字段命名变更时后端无感知，静默存储 `null`
- **修复建议**：引入 Zod 或 Joi 进行请求体 Schema 验证

#### P2-08：`Backup` 模型缺少关联用户外键约束
- **位置**：`backend/prisma/schema.prisma`
- **问题**：`created_by` 字段为 `String?`，未与 `User` 模型建立外键关联，无法追溯备份操作者
- **修复建议**：添加 `created_user User? @relation(...)` 关联

---

### 🔵 P3 — 长期优化（规划阶段）

#### P3-01：SQLite 单文件数据库的并发与容灾限制
- **问题**：SQLite 不支持多写并发，生产环境若出现并发写入可能导致数据库锁定；单文件无内置复制机制
- **建议**：中期规划迁移至 PostgreSQL（Schema 已预留兼容性）

#### P3-02：前端 `localStorage` 存储 JWT Token 存在 XSS 风险
- **位置**：`js/services/AuthService.js`（已确认）
- **问题**：`localStorage` 中的 Token 可被 XSS 脚本读取
- **建议**：后端配合实现 `httpOnly Cookie` 存储 Token

#### P3-03：缺少 API 版本控制机制
- **问题**：所有接口均挂载在 `/api/` 下，无版本号，未来接口变更无法平滑过渡
- **建议**：引入 `/api/v1/` 前缀

#### P3-04：`Attachment` 模型的 `file_path` 为本地路径，无云存储支持
- **问题**：附件存储为本地文件路径，无法在多实例或云环境下共享访问
- **建议**：规划接入腾讯云 COS 对象存储

#### P3-05：`syncRoutes.js` 的 `syncLog` 为内存数组，无持久化
- **问题**：同步日志仅存在于运行时内存，进程重启后全部丢失，无法用于故障排查
- **建议**：将同步日志写入 `SystemLog` 表

---

## 4. 问题优先级汇总

| 优先级 | 数量 | 核心主题 |
|--------|------|----------|
| 🔴 P0 高危 | 5 项 | syncRoutes 无认证、JWT 弱密钥、认证中间件不一致、注册接口无保护、幂等性失效 |
| 🟠 P1 重要 | 11 项 | 路由冲突、内存幂等、虚假 email、密码强度、refresh 接口缺失、前端权限绕过等 |
| 🟡 P2 优化 | 8 项 | 限流策略、审计日志、JSON 容错、重复实例化等 |
| 🔵 P3 长期 | 5 项 | 数据库迁移、Token 安全存储、API 版本控制等 |
| **合计** | **29 项** | |

---

## 5. 待审阅文件与下一步任务

### 5.1 下一轮需读取的文件（优先级排序）

```
# 前端服务层（高优先级）
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/services/GuestAuthService.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/services/PermissionService.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/utils/AuditLogger.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/utils/NetworkHelper.js

# 前端主入口（高优先级）
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/main.js

# 后端种子数据（中优先级）
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/backend/prisma/seed.js
```

### 5.2 审阅维度清单（每轮对话参考）

| 维度 | 检查要点 |
|------|----------|
| **安全性** | 输入验证、XSS/SQL注入防护、权限校验、Token 存储方式 |
| **一致性** | 接口契约与前端调用是否匹配、字段命名统一性 |
| **健壮性** | 错误处理完整性、边界条件、JSON 解析容错 |
| **可维护性** | 代码重复度、模块职责单一性、注释完整性 |
| **性能** | 数据库查询效率、N+1 问题、缓存策略 |
| **合规性** | 审计日志完整性、数据删除策略、食品安全记录保留要求 |

---

## 6. 每次新对话的接续指令模板

> 在新对话开始时，将本文件内容粘贴给 AI，并附加以下指令：

```
我正在对食品安全检验管理系统进行代码审阅。
仓库地址：https://github.com/ArthurUker/Tianjiabing_foodtestlab/tree/ZhuHaiYiZhong
本次审阅上下文见附件 REVIEW_GUIDE.md（docs/review/REVIEW_GUIDE.md）。

本轮任务：
1. 读取"第5节-待审阅文件"中的下一批文件（使用 raw.githubusercontent.com 链接）
2. 按"第5.2节-审阅维度清单"进行分析
3. 将新发现的问题追加到本文档"第3节-已发现问题清单"中
4. 更新"第2节-已审阅文件清单"的状态
5. 输出更新后的完整 REVIEW_GUIDE.md
```

---

## 7. 文档变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-06-22 | v0.1 | 初始创建，完成后端核心文件审阅（server.js、schema.prisma、userRoutes.js、auditRoutes.js） |
| 2026-06-22 | v0.2 | 新增 UserManager.js、idempotencyMiddleware.js、syncRoutes.js、AuthService.js、Router.js 审阅结果；问题总数从 19 项扩展至 29 项 |