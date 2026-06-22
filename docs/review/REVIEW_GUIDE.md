# 食品安全检验管理系统 Pro — 代码审阅上下文指导文档

**文档路径**：`docs/review/REVIEW_GUIDE.md`
**系统名称**：食品安全检验管理系统 Pro（珠海一中食品安全检验系统）
**仓库地址**：https://github.com/ArthurUker/Tianjiabing_foodtestlab/tree/ZhuHaiYiZhong
**审阅开始日期**：2026-06-22
**文档版本**：v0.3（2026-06-22 第三轮更新）
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
| 数据库 | SQLite（生产）| 单文件，路径 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` |
| 认证 | JWT Bearer Token + bcryptjs | Token 有效期 7 天（`JWT_EXPIRES_IN=7d`） |
| 进程守护 | PM2（进程名 `zhuhaiyizhong-api`）| |
| 反向代理 | Nginx | 前端端口 8082，后端 API 端口 3002 |
| 部署环境 | 腾讯云 Windows Server | 部署分支 `ZhuHaiYiZhong` |
| 可观测性 | OpenTelemetry + Jaeger + Prometheus | `backend/config/telemetry.js`（CommonJS，未集成到主进程）|

### 1.2 生产部署口径

| 项目 | 配置 |
|------|------|
| 项目目录 | `C:\zhuhaiyizhong` |
| 前端访问端口 | `8082` |
| 后端 API 端口 | `3002` |
| PM2 进程名 | `zhuhaiyizhong-api` |
| 数据库文件 | `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` |
| API 前缀 | `/api` |
| 登录接口 | `POST /api/user/login` |
| 初始管理员账号 | `admin` / `8888`（seed.js 写死）|
| 初始测试员账号 | `operator` / `operator123` |
| 初始查看员账号 | `viewer` / `viewer123` |

### 1.3 完整项目目录结构（v0.3 补全）

```
项目根目录/
├── .babelrc                              # Babel 配置
├── .env.example                          # 环境变量示例 ✅ 已审阅
├── .gitignore
├── .npmrc
├── .vscode/
│   └── settings.json
├── backend/
│   ├── README.md
│   ├── package.json
│   ├── package-lock.json
│   ├── server.js                         # 主入口 ✅ 已审阅
│   ├── config/
│   │   └── telemetry.js                  # OpenTelemetry 配置 ✅ 已审阅
│   ├── middleware/
│   │   ├── idempotencyMiddleware.js       # 幂等性中间件 ✅ 已审阅
│   │   └── validationMiddleware.js        # 输入验证/XSS防护 ✅ 已审阅
│   ├── modules/
│   │   └── UserManager.js                # 用户注册/登录/权限 ✅ 已审阅
│   ├── prisma/
│   │   ├── schema.prisma                 # 数据库模型 ✅ 已审阅
│   │   ├── seed.js                       # 种子数据初始化 ✅ 已审阅
│   │   └── dedupe-test-records.js        # 检测记录去重脚本 ❌ 未读取
│   └── routes/
│       ├── auditRoutes.js                # /api/audit-logs/* ✅ 已审阅
│       ├── syncRoutes.js                 # /api/sync/* ✅ 已审阅（严重问题）
│       └── userRoutes.js                 # /api/user/* ✅ 已审阅
├── docs/
│   └── review/
│       └── REVIEW_GUIDE.md               # 本文件
├── js/
│   ├── main.js                           # 前端主入口 ✅ 已审阅（部分）
│   ├── core/
│   │   └── Router.js                     # 路由与权限守卫 ✅ 已审阅
│   ├── modules/
│   │   ├── AuditLog.js                   # 审计日志模块 ❌ 未读取
│   │   ├── BackupRestore.js              # 备份还原模块 ❌ 未读取
│   │   ├── Dashboard.js                  # 数据看板模块 ❌ 未读取
│   │   ├── GenericTest.js                # 通用检测模块 ❌ 未读取
│   │   ├── GuestDashboard.js             # 访客看板模块 ❌ 未读取
│   │   ├── Pathogen.js                   # 病原体检测模块 ❌ 未读取
│   │   ├── Tableware.js                  # 餐具检测模块 ❌ 未读取
│   │   └── UserManagement.js             # 用户管理模块 ❌ 未读取
│   ├── services/
│   │   ├── AuthService.js                # 认证服务 ✅ 已审阅
│   │   ├── ExportService.js              # 导出服务 ❌ 未读取
│   │   ├── GuestAuthService.js           # 访客认证服务 ✅ 已审阅
│   │   ├── PermissionService.js          # 权限管理服务 ✅ 已审阅
│   │   └── SessionManager.js             # 会话管理服务 ✅ 已审阅
│   └── utils/
│       ├── AuditLogger.js                # 前端审计日志工具 ✅ 已审阅
│       ├── FormValidator.js              # 表单验证工具 ❌ 未完整读取
│       ├── NetworkHelper.js              # 网络请求封装 ✅ 已审阅
│       ├── SampleDataGenerator.js        # 示例数据生成器 ❌ 未读取
│       ├── UIHelper.js                   # UI 工具 ❌ 未读取
│       └── UINotification.js             # UI 通知组件 ❌ 未读取
└── [HTML 页面文件]                        # index.html / login.html 等 ❌ 未读取
```

### 1.4 关键接口速查

| 接口 | 方法 | 权限 | 说明 |
|------|------|------|------|
| `/api/user/login` | POST | 公开 | 用户登录 |
| `/api/user/register` | POST | 公开⚠️ | 用户注册（应限制为 Admin） |
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
| `/api/guest/register` | POST | 公开 | 访客注册 |
| `/api/guest/login` | POST | 公开 | 访客登录 |
| `/api/guest/verify-token` | POST | 访客Token | 访客 Token 验证 |
| `/api/guest-export-request/submit` | POST | 访客Token | 提交导出申请 |
| `/api/guest-export-request/my-requests` | GET | 访客Token | 查询申请记录 |
| `/api/guest-export-request/check-permission` | GET | 访客Token | 检查导出权限 |

### 1.5 角色权限矩阵（来自 PermissionService.js）

| 权限 | admin | manager | operator | viewer | guest |
|------|:-----:|:-------:|:--------:|:------:|:-----:|
| records:read | ✅ | ✅ | ✅ | ✅ | ✅ |
| records:create | ✅ | ✅ | ✅ | ❌ | ❌ |
| records:update | ✅ | ✅ | ✅ | ❌ | ❌ |
| records:delete | ✅ | ❌ | ❌ | ❌ | ❌ |
| export:pdf | ✅ | ✅ | ✅ | ✅ | ❌ |
| export:excel | ✅ | ✅ | ❌ | ❌ | ❌ |
| backup:create | ✅ | ❌ | ❌ | ❌ | ❌ |
| users:管理 | ✅ | read only | ❌ | ❌ | ❌ |
| audit:view | ✅ | ✅ | ❌ | ❌ | ❌ |
| module:pathogen | ✅ | ✅ | ✅ | ✅ | ❌ |

---

## 2. 已审阅文件清单

| 文件 | 审阅状态 | 完整度 | 主要发现 |
|------|----------|--------|----------|
| `backend/server.js` | ✅ 已审阅 | ~80% | 双重 record_code 逻辑、硬编码 IP、弱密钥 fallback |
| `backend/prisma/schema.prisma` | ✅ 已审阅 | 100% | Cascade 删除风险、Guest 模型冗余 |
| `backend/routes/userRoutes.js` | ✅ 已审阅 | ~90% | 认证中间件重复定义、注册接口无保护 |
| `backend/routes/auditRoutes.js` | ✅ 已审阅 | ~90% | 路由注册顺序冲突、认证实现不一致 |
| `backend/routes/syncRoutes.js` | ✅ 已审阅 | ~85% | **严重：无认证保护、CommonJS 语法、不操作数据库** |
| `backend/middleware/validationMiddleware.js` | ✅ 已审阅 | ~40% | escapeMap 编码疑似错误 |
| `backend/middleware/idempotencyMiddleware.js` | ✅ 已审阅 | 100% | 内存存储、PM2 重启后失效 |
| `backend/modules/UserManager.js` | ✅ 已审阅 | ~75% | 自动生成虚假 email、密码强度校验弱 |
| `backend/prisma/seed.js` | ✅ 已审阅 | 100% | **admin 初始密码为 `8888`（极弱）、明文写入代码** |
| `backend/config/telemetry.js` | ✅ 已审阅 | 100% | CommonJS 语法（与项目 ES Module 不一致）、未集成到主进程 |
| `.env.example` | ✅ 已审阅 | 100% | `JWT_SECRET` 示例值为弱字符串、数据库路径与 server.js 不一致 |
| `js/services/AuthService.js` | ✅ 已审阅 | ~90% | Token 存 localStorage（XSS 风险）、refreshToken 后端未实现 |
| `js/services/GuestAuthService.js` | ✅ 已审阅 | 100% | 快速访问模式绕过认证、Token 为伪随机字符串 |
| `js/services/PermissionService.js` | ✅ 已审阅 | ~80% | 权限缓存不失效、动态 import 与同步返回逻辑混用 |
| `js/services/SessionManager.js` | ✅ 已审阅 | ~70% | 会话全存内存、IP 地址硬编码 `127.0.0.1`、syncToBackend 调用未知接口 |
| `js/core/Router.js` | ✅ 已审阅 | ~85% | 权限控制仅靠前端 CSS 隐藏、全局暴露 window.router |
| `js/utils/AuditLogger.js` | ✅ 已审阅 | 100% | **审计日志仅存 localStorage，不上报后端，无法持久追溯** |
| `js/utils/NetworkHelper.js` | ✅ 已审阅 | ~90% | 网络检查 URL 硬编码 Google（内网不可达）、无认证 Token 注入 |
| `js/main.js` | ✅ 已审阅 | ~50% | 大量 window.* 全局暴露、快速访问模式直接渲染缓存数据 |
| `backend/prisma/dedupe-test-records.js` | ❌ 未读取 | — | — |
| `js/modules/AuditLog.js` | ❌ 未读取 | — | — |
| `js/modules/BackupRestore.js` | ❌ 未读取 | — | — |
| `js/modules/Dashboard.js` | ❌ 未读取 | — | — |
| `js/modules/GenericTest.js` | ❌ 未读取 | — | — |
| `js/modules/GuestDashboard.js` | ❌ 未读取 | — | — |
| `js/modules/Pathogen.js` | ❌ 未读取 | — | — |
| `js/modules/Tableware.js` | ❌ 未读取 | — | — |
| `js/modules/UserManagement.js` | ❌ 未读取 | — | — |
| `js/services/ExportService.js` | ❌ 未读取 | — | — |
| `js/utils/SampleDataGenerator.js` | ❌ 未读取 | — | — |
| `js/utils/UIHelper.js` | ❌ 未读取 | — | — |
| `js/utils/UINotification.js` | ❌ 未读取 | — | — |
| `index.html` / `login.html` 等 | ❌ 未读取 | — | — |

---

## 3. 已发现问题清单（完整版 v0.3）

### 🔴 P0 — 高危问题（建议 1~3 天内处理）

#### P0-01：`syncRoutes.js` 三重严重问题并发
- **位置**：`backend/routes/syncRoutes.js`
- **问题**：
  1. **无认证**：`POST /api/sync/users`、`POST /api/sync/testRecords`、`POST /api/sync/batch` 均无 JWT 认证中间件
  2. **伪同步**：处理逻辑中完全没有调用 `prisma`，数据从未写入数据库，仅在内存 `syncLog` 数组中记录
  3. **模块规范错误**：使用 `require()` (CommonJS)，项目为 `"type": "module"`，运行时直接崩溃
- **修复建议**：改写为 ES Module、添加 `authenticateUser` 中间件、接入 Prisma 真正写库

#### P0-02：`authenticateUser` 中间件三处实现不一致
- **位置**：`server.js`、`userRoutes.js`、`auditRoutes.js`
- **问题**：三处挂载字段名不同（`req.userId`/`req.userRole` vs `req.user` 对象），下游代码混用导致 `undefined` 引用错误
- **修复建议**：抽取为独立 `middleware/authMiddleware.js`，统一导出

#### P0-03：JWT 密钥 fallback 为弱明文字符串
- **位置**：`backend/server.js`
- **代码**：`const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-jwt-secret'`
- **修复建议**：未配置时直接 `process.exit(1)`，拒绝启动

#### P0-04：`POST /api/user/register` 完全公开，无需授权
- **位置**：`backend/routes/userRoutes.js`
- **修复建议**：添加 `authenticateUser` + `authorizeAdmin` 中间件

#### P0-05：`seed.js` 初始管理员密码为 `8888`，且明文写入代码
- **位置**：`backend/prisma/seed.js`
- **问题**：
  - `admin` 初始密码为 `8888`（4位纯数字，极弱）
  - 密码明文写在代码文件中，已提交至 GitHub 公开仓库
  - `operator` / `viewer` 账号密码同样明文可见
- **修复建议**：
  - 通过环境变量注入初始密码：`process.env.ADMIN_INIT_PASSWORD`
  - 强制要求首次登录修改密码
  - 立即在生产环境修改 admin 密码

#### P0-06：`record_code` 双重生成逻辑并存，幂等性失效
- **位置**：`backend/server.js`
- **问题**：`Date.now()` 方案与 `buildDeterministicRecordCode()` 并存，前端重试时产生重复记录
- **修复建议**：统一使用 `buildDeterministicRecordCode()`

#### P0-07：快速访问模式（Quick Access）完全绕过认证，Token 为伪随机字符串
- **位置**：`js/services/GuestAuthService.js`，`quickAccessAsViewer()` 方法
- **问题**：
  - 无需任何凭证，调用 `quickAccessAsViewer()` 即可生成本地 `guest_token`（格式：`temp-token-{timestamp}-{random}`）
  - 该 Token 不经过后端验证，Router.js 中 `isQuickAccess` 检查仅读取 localStorage 中的 `is_quick_access` 字段
  - 任何人打开浏览器控制台执行 `localStorage.setItem('guest_token', 'anything'); localStorage.setItem('current_guest', '{"is_quick_access":true}')` 即可进入系统
  - `main.js` 中 `window.renderQuickAccessData()` 直接渲染 localStorage 缓存数据，无任何服务端校验
- **修复建议**：快速访问模式必须经过后端签发临时 Token，或完全移除此功能

---

### 🟠 P1 — 重要问题（建议 1 周内处理）

#### P1-01：`auditRoutes.js` 路由注册顺序冲突
- **问题**：`GET /:logId` 在 `GET /stats/summary` 之前注册，`summary` 被识别为 `logId`
- **修复建议**：静态路由移到动态参数路由之前

#### P1-02：`idempotencyMiddleware` 使用内存存储，PM2 重启后全部失效
- **修复建议**：中期替换为 Redis；短期对 `cleanup` 加节流

#### P1-03：`UserManager.registerUser()` 自动生成虚假 email
- **修复建议**：注册时不自动生成 `@foodlab.local` 邮箱，允许 `email` 为 `null`

#### P1-04：密码强度校验过弱（仅 `length >= 6`）
- **修复建议**：最小长度 8 位，要求包含数字和字母

#### P1-05：`AuthService.refreshToken()` 调用后端不存在的接口
- **位置**：`js/services/AuthService.js`，调用 `/api/auth/refresh`
- **修复建议**：后端实现接口，或前端移除 refresh 逻辑改为过期后跳转登录

#### P1-06：前端权限控制完全依赖 CSS `hidden` 类，可被 DevTools 绕过
- **位置**：`js/core/Router.js`，`updateNavigationByPermission()`
- **修复建议**：所有敏感操作必须在后端 API 层进行权限校验

#### P1-07：`Router.js` 将自身暴露到 `window.router` 全局作用域
- **修复建议**：移除 `window.router = this`，改用模块化导出

#### P1-08：`TestRecord` 的 `onDelete: Cascade` 可能导致检测数据意外丢失
- **修复建议**：改为 `onDelete: Restrict` 或 `SetNull`

#### P1-09：`AuditLogger.js` 审计日志仅存 localStorage，不上报后端
- **位置**：`js/utils/AuditLogger.js`
- **问题**：
  - 所有前端操作日志（登录、登出、创建、删除、导出等）仅写入 `localStorage`，以 `audit_YYYY-MM-DD` 为 key
  - 用户清除浏览器数据后日志全部丢失
  - 换设备或换浏览器后无法查看历史日志
  - 最多保留 30 天，超期自动删除
  - 后端 `AuditLog` 表形同虚设（前端不写入）
  - `AuthService.login()` 调用 `logOperation('login', 'system', ...)` 仅写本地
- **修复建议**：`logOperation()` 在写 localStorage 的同时，异步 POST 到 `/api/audit-logs`

#### P1-10：`PermissionService` 权限缓存永不失效
- **位置**：`js/services/PermissionService.js`
- **问题**：
  - `permissionCache` 为 `Map`，用户角色变更后缓存不自动清除
  - 管理员在后台修改某用户角色后，该用户当前会话的权限不会立即更新
  - `getCurrentUserPermissions()` 中混用了异步 `import()` 和同步 `return`，异步分支的返回值被丢弃
- **修复建议**：
  - 在 `authService.login()` / `logout()` 时调用 `permissionCache.clear()`
  - 修复异步/同步混用逻辑，统一为同步判断

#### P1-11：`SessionManager` 会话全存内存，IP 地址硬编码，`syncToBackend` 调用未知接口
- **位置**：`js/services/SessionManager.js`
- **问题**：
  - `this.sessions` 为内存数组，页面刷新后全部清空，会话管理形同虚设
  - `getClientIP()` 直接返回硬编码 `'127.0.0.1'`，无法获取真实 IP
  - `syncToBackend('add', session)` 和 `syncToBackend('remove', session)` 方法调用了未在后端路由中定义的接口（疑似 `/api/sessions`），会静默失败
  - `startDeviceDetection()` 方法被调用但未在读取到的代码中定义（可能在截断部分）
- **修复建议**：
  - 会话信息应存储在后端数据库
  - 真实 IP 从后端 JWT payload 或请求头中获取
  - 确认 `syncToBackend` 的目标接口是否存在

#### P1-12：`telemetry.js` 使用 CommonJS，且未集成到主进程
- **位置**：`backend/config/telemetry.js`
- **问题**：
  - 使用 `require()` 语法，在 `"type": "module"` 项目中无法直接 `import`
  - `server.js` 中未 `import` 此文件，Jaeger/Prometheus 监控实际未启用
  - `package.json` 中未安装 `@opentelemetry/*` 依赖（待确认）
- **修复建议**：改写为 ES Module 或重命名为 `.cjs`；确认是否需要启用监控

#### P1-13：`CORS_ORIGIN` 在 `.env.example` 中未包含生产 IP，与 `server.js` 硬编码不一致
- **位置**：`.env.example` vs `backend/server.js`
- **问题**：`.env.example` 中 `CORS_ORIGIN` 仅含 `localhost`，而 `server.js` 硬编码了生产服务器 IP `159.75.106.179:8082`
- **修复建议**：`.env.example` 中补充生产 IP 示例；`server.js` 中移除所有硬编码 IP

---

### 🟡 P2 — 优化建议（建议 2 周内处理）

#### P2-01：`rateLimit` 默认值过高，登录接口无专项限流
- **修复建议**：`POST /api/user/login` 单独限流 10 次/分钟/IP

#### P2-02：检测记录 CRUD 操作未自动写入审计日志
- **修复建议**：记录 CRUD 成功响应后统一调用 `prisma.auditLog.create()`

#### P2-03：`UserManager.loginUser()` 失败登录日志未确认写入数据库
- **修复建议**：确认 `logFailedLogin` 是否写入 `AuditLog` 表

#### P2-04：`AuthService.getUser()` 对 `JSON.parse` 无容错处理
- **修复建议**：
  ```js
  try { return userStr ? JSON.parse(userStr) : null }
  catch { this.clearAuth(); return null }
  ```

#### P2-05：`Router.init()` 每次调用都实例化新的 `GuestAuthService`
- **修复建议**：构造函数中初始化单例 `this.guestAuthService = new GuestAuthService()`

#### P2-06：`/api/health` 与 `/health` 重复定义
- **修复建议**：统一保留 `/api/health`

#### P2-07：`buildRecordWriteData()` 字段提取无 Schema 验证
- **修复建议**：引入 Zod 或 Joi 进行请求体 Schema 验证

#### P2-08：`Backup` 模型缺少关联用户外键约束
- **修复建议**：添加 `created_user User? @relation(...)` 关联

#### P2-09：`NetworkHelper.checkConnection()` 硬编码 Google URL，内网环境不可达
- **位置**：`js/utils/NetworkHelper.js`
- **代码**：`checkConnection(url = 'https://www.google.com/favicon.ico')`
- **问题**：学校内网环境无法访问 Google，网络检查永远返回 `false`，可能触发离线模式误判
- **修复建议**：改为检查自身后端健康接口 `/api/health`

#### P2-10：`main.js` 大量函数通过 `window.*` 全局暴露，扩大攻击面
- **位置**：`js/main.js`
- **问题**：`window.renderQuickAccessData`、`window.handleNavigation`、`window.loadDashboardData`、`window.initAuditLog` 等均挂载到全局，XSS 注入后可直接调用
- **修复建议**：使用自定义事件（`CustomEvent`）替代全局函数调用

#### P2-11：`GuestAuthService.getCurrentGuest()` 对 `JSON.parse` 无容错处理
- **位置**：`js/services/GuestAuthService.js`
- **代码**：`return guest ? JSON.parse(guest) : null`
- **修复建议**：同 P2-04，添加 try/catch

#### P2-12：`seed.js` 中测试账号（`operator`/`viewer`）在生产环境应禁用或删除
- **位置**：`backend/prisma/seed.js`
- **问题**：`operator123`、`viewer123` 为弱密码，测试账号不应存在于生产环境
- **修复建议**：通过 `NODE_ENV` 判断，生产环境仅创建 `admin` 账号，且密码从环境变量读取

---

### 🔵 P3 — 长期优化（规划阶段）

#### P3-01：SQLite 单文件数据库的并发与容灾限制
- **建议**：中期规划迁移至 PostgreSQL

#### P3-02：前端 `localStorage` 存储 JWT Token 存在 XSS 风险
- **建议**：后端配合实现 `httpOnly Cookie` 存储 Token

#### P3-03：缺少 API 版本控制机制
- **建议**：引入 `/api/v1/` 前缀

#### P3-04：`Attachment` 模型的 `file_path` 为本地路径，无云存储支持
- **建议**：规划接入腾讯云 COS 对象存储

#### P3-05：`syncRoutes.js` 的 `syncLog` 为内存数组，无持久化
- **建议**：同步日志写入 `SystemLog` 表

#### P3-06：`GuestAuthService` 与 `User` 认证体系完全独立，维护成本高
- **建议**：将 `guest` 合并为 `User.role` 中的一个角色，统一认证流程

#### P3-07：`dedupe-test-records.js` 的存在说明系统曾出现重复数据问题，根因未解决
- **位置**：`backend/prisma/dedupe-test-records.js`
- **建议**：读取该文件确认去重逻辑，结合 P0-06 的 `record_code` 双重生成问题一并根治

---

## 4. 问题优先级汇总

| 优先级 | 数量 | 核心主题 |
|--------|------|----------|
| 🔴 P0 高危 | 7 项 | syncRoutes 无认证、JWT 弱密钥、认证不一致、注册无保护、seed 密码明文、快速访问绕过认证 |
| 🟠 P1 重要 | 13 项 | 路由冲突、内存幂等、虚假 email、密码强度、refresh 接口缺失、审计日志不上报、权限缓存不失效、SessionManager 失效等 |
| 🟡 P2 优化 | 12 项 | 限流策略、审计日志、JSON 容错、重复实例化、Google URL 硬编码、全局函数暴露等 |
| 🔵 P3 长期 | 7 项 | 数据库迁移、Token 安全存储、API 版本控制、去重根因等 |
| **合计** | **39 项** | |

---

## 5. 待审阅文件与下一步任务

### 5.1 下一轮需读取的文件（优先级排序）

```
# 高优先级：业务模块（涉及数据写入和权限控制）
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/modules/UserManagement.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/modules/BackupRestore.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/services/ExportService.js

# 中优先级：数据层和工具
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/backend/prisma/dedupe-test-records.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/modules/AuditLog.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/utils/SampleDataGenerator.js

# 低优先级：UI 层
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/modules/Dashboard.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/modules/GuestDashboard.js
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
1. 读取"第5.1节-待审阅文件"中的下一批文件（使用 raw.githubusercontent.com 链接）
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
| 2026-06-22 | v0.2 | 新增 UserManager.js、idempotencyMiddleware.js、syncRoutes.js、AuthService.js、Router.js 审阅结果；问题总数 29 项 |
| 2026-06-22 | v0.3 | 补全完整项目目录树；新增 GuestAuthService.js、PermissionService.js、SessionManager.js、AuditLogger.js、NetworkHelper.js、main.js（部分）、seed.js、telemetry.js、.env.example 审阅结果；新增 P0-05（seed 密码明文）、P0-07（快速访问绕过认证）等关键问题；问题总数扩展至 39 项 |