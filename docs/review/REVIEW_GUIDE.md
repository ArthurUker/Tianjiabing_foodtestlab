# 食品安全检验管理系统 Pro — 代码审阅上下文指导文档

**文档路径**：`docs/review/REVIEW_GUIDE.md`
**系统名称**：食品安全检验管理系统 Pro（珠海一中食品安全检验系统）
**仓库地址**：https://github.com/ArthurUker/Tianjiabing_foodtestlab/tree/ZhuHaiYiZhong
**审阅开始日期**：2026-06-22
**文档版本**：v0.5（2026-06-22 第五轮更新）
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
| 前端数据层 | `StorageService` + `AdaptiveUploadQueue` | 离线优先架构，localStorage 缓存 + 异步上传队列 |

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
| 初始管理员账号 | `admin` / `8888`（seed.js 写死，⚠️ 已公开）|
| 初始测试员账号 | `operator` / `operator123` |
| 初始查看员账号 | `viewer` / `viewer123` |

### 1.3 完整项目目录结构（v0.5 补全）

```
项目根目录/
├── .babelrc
├── .env.example                          ✅ 已审阅
├── .gitignore / .npmrc / .vscode/
├── backend/
│   ├── server.js                         ✅ 已审阅
│   ├── config/telemetry.js               ✅ 已审阅
│   ├── middleware/
│   │   ├── idempotencyMiddleware.js       ✅ 已审阅
│   │   └── validationMiddleware.js        ✅ 已审阅
│   ├── modules/UserManager.js            ✅ 已审阅
│   ├── prisma/
│   │   ├── schema.prisma                 ✅ 已审阅
│   │   ├── seed.js                       ✅ 已审阅
│   │   └── dedupe-test-records.js        ✅ 已审阅
│   └── routes/
│       ├── auditRoutes.js                ✅ 已审阅
│       ├── syncRoutes.js                 ✅ 已审阅（严重问题）
│       └── userRoutes.js                 ✅ 已审阅
├── docs/review/REVIEW_GUIDE.md           ✅ 本文件
├── js/
│   ├── main.js                           ✅ 已审阅（部分）
│   ├── core/
│   │   ├── Auth.js                       ✅ 已审阅（新发现：与 AuthService.js 同名但职责不同）
│   │   ├── Router.js                     ✅ 已审阅
│   │   ├── Storage.js                    ✅ 已审阅
│   │   └── AdaptiveUploadQueue.js        ✅ 已审阅（部分截断）
│   ├── modules/
│   │   ├── AuditLog.js                   ✅ 已审阅
│   │   ├── BackupRestore.js              ✅ 已审阅
│   │   ├── Dashboard.js                  ✅ 已审阅
│   │   ├── GenericTest.js                ✅ 已审阅
│   │   ├── GuestDashboard.js             ✅ 已审阅
│   │   ├── Pathogen.js                   ✅ 已审阅
│   │   ├── Tableware.js                  ✅ 已审阅
│   │   └── UserManagement.js             ✅ 已审阅（部分）
│   ├── services/
│   │   ├── AuditLogService.js            ✅ 已审阅
│   │   ├── AuthService.js                ✅ 已审阅
│   │   ├── ExportService.js              ✅ 已审阅
│   │   ├── GuestAuthService.js           ✅ 已审阅
│   │   ├── PermissionService.js          ✅ 已审阅
│   │   └── SessionManager.js             ✅ 已审阅
│   └── utils/
│       ├── AuditLogger.js                ✅ 已审阅
│       ├── FormValidator.js              ❌ 未完整读取
│       ├── NetworkHelper.js              ✅ 已审阅
│       ├── pathogenRisk.js               ❌ 未读取（新发现）
│       ├── SampleDataGenerator.js        ❌ 未读取
│       ├── UIHelper.js                   ❌ 未读取
│       └── UINotification.js             ❌ 未读取
└── [HTML 页面文件]                        ❌ 未读取
```

### 1.4 系统核心数据流架构

```
用户操作
    │
    ▼
StorageService.save() / update() / delete()
    │
    ├─► 立即写入 localStorage（cache_{tableName}）
    │       └─► 返回带 _status:'pending' 的临时记录（tempId）
    │
    └─► 加入 AdaptiveUploadQueue（pending_{tableName}）
            │
            ▼
        异步批量上传 → POST/PUT/DELETE /api/records/{type}
        （携带 Idempotency-Key 请求头，自动指数退避重试）
            │
            ├─► 成功：用服务端 record_code 替换 tempId，_status='synced'
            │         + 内容指纹写入 _completedFingerprints（TTL 60s）
            └─► 失败：指数退避重试，_currentInterval 最大 15s
```

### 1.5 关键接口速查

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
| `/api/audit-logs/stats/:date` | GET | 已登录 | 按日期统计 |
| `/api/sync/users` | POST | 无认证⚠️ | 用户同步（危险） |
| `/api/sync/testRecords` | POST | 无认证⚠️ | 记录同步（危险） |
| `/api/records/:type` | GET/POST/PUT/DELETE | 已登录 | 检测记录 CRUD |
| `/api/auth/refresh` | POST | 公开 | Token 刷新⚠️ 后端未实现 |
| `/api/guest/register` | POST | 公开 | 访客注册 |
| `/api/guest/login` | POST | 公开 | 访客登录 |
| `/api/guest-export-request/submit` | POST | 访客Token | 提交导出申请 |

### 1.6 角色权限矩阵（来自 PermissionService.js）

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

### 1.7 前端认证模块命名混淆说明（v0.5 新增）

> ⚠️ 系统中存在**两个不同的 AuthService**，极易混淆：

| 文件 | 导出名 | 职责 | 被谁使用 |
|------|--------|------|---------|
| `js/services/AuthService.js` | `AuthService` / `authService` | JWT Token 管理、登录/登出、用户信息存取 | Router.js、main.js、AuditLogService.js 等 |
| `js/core/Auth.js` | `AuthService`（同名类）/ `auth`（单例） | 仅做操作二次确认弹窗（删除时 confirm）+ 读取 localStorage 用户名 | Tableware.js、GenericTest.js、Pathogen.js、UserManagement.js |

两个文件导出的类名均为 `AuthService`，但职责完全不同。`js/core/Auth.js` 的 `auth.verify()` **对非删除操作不做任何权限校验**，直接执行回调。

---

## 2. 已审阅文件清单

| 文件 | 审阅状态 | 完整度 | 主要发现 |
|------|----------|--------|----------|
| `backend/server.js` | ✅ | ~80% | 双重 record_code 逻辑、硬编码 IP、弱密钥 fallback |
| `backend/prisma/schema.prisma` | ✅ | 100% | Cascade 删除风险、Guest 模型冗余 |
| `backend/routes/userRoutes.js` | ✅ | ~90% | 认证中间件重复定义、注册接口无保护 |
| `backend/routes/auditRoutes.js` | ✅ | ~90% | 路由注册顺序冲突、认证实现不一致 |
| `backend/routes/syncRoutes.js` | ✅ | ~85% | **严重：无认证、CommonJS、不操作数据库** |
| `backend/middleware/validationMiddleware.js` | ✅ | ~40% | escapeMap 编码疑似错误 |
| `backend/middleware/idempotencyMiddleware.js` | ✅ | 100% | 内存存储、PM2 重启后失效 |
| `backend/modules/UserManager.js` | ✅ | ~75% | 自动生成虚假 email、密码强度校验弱 |
| `backend/prisma/seed.js` | ✅ | 100% | **admin 密码 `8888` 明文写入公开仓库** |
| `backend/prisma/dedupe-test-records.js` | ✅ | 100% | 证实历史重复数据问题；指纹算法与 Storage.js 一致 |
| `backend/config/telemetry.js` | ✅ | 100% | CommonJS 语法、未集成到主进程 |
| `.env.example` | ✅ | 100% | JWT_SECRET 示例值为弱字符串 |
| `js/core/Auth.js` | ✅ | 100% | **新发现：与 AuthService.js 同名；编辑操作无权限校验** |
| `js/core/Router.js` | ✅ | ~85% | 权限控制仅靠 CSS 隐藏、全局暴露 window.router |
| `js/core/Storage.js` | ✅ | ~80% | 核心数据层；离线优先；getAll() 优先返回缓存 |
| `js/core/AdaptiveUploadQueue.js` | ✅ | ~70% | 指纹去重、自适应节流、幂等 Key 自动生成；_getHeaders 由外部注入 |
| `js/modules/AuditLog.js` | ✅ | ~70% | 正确通过 AuditLogService 查询后端 |
| `js/modules/BackupRestore.js` | ✅ | ~60% | 备份恢复依赖无效的 syncRoutes |
| `js/modules/Dashboard.js` | ✅ | ~70% | 将 `loadDashboardData` 挂载到 `window`；快速访问模式延迟加载 |
| `js/modules/GenericTest.js` | ✅ | ~60% | 通用检测基类；快速访问模式隐藏表单；使用 `auth.verify()` |
| `js/modules/GuestDashboard.js` | ✅ | ~70% | 访客界面；快速访问模式下显示临时访问标签 |
| `js/modules/Pathogen.js` | ✅ | ~65% | **快速访问模式下访客可访问病原体模块（权限矩阵矛盾）** |
| `js/modules/Tableware.js` | ✅ | ~65% | 使用 `auth.verify()` 做删除确认；使用 `AuditLogService` |
| `js/modules/UserManagement.js` | ✅ | ~60% | 前端 CRUD 无二次权限校验 |
| `js/services/AuditLogService.js` | ✅ | 100% | 正确上报后端 `/api/audit-logs` |
| `js/services/AuthService.js` | ✅ | ~90% | Token 存 localStorage、refreshToken 后端未实现 |
| `js/services/ExportService.js` | ✅ | ~60% | 依赖 StorageService 本地缓存导出，无服务端校验 |
| `js/services/GuestAuthService.js` | ✅ | 100% | 快速访问模式绕过认证、Token 为伪随机字符串 |
| `js/services/PermissionService.js` | ✅ | ~80% | 权限缓存不失效、异步/同步混用 |
| `js/services/SessionManager.js` | ✅ | ~70% | 会话全存内存、IP 硬编码、syncToBackend 调用未知接口 |
| `js/utils/AuditLogger.js` | ✅ | 100% | 仅写 localStorage，不上报后端 |
| `js/utils/NetworkHelper.js` | ✅ | ~90% | 网络检查 URL 硬编码 Google |
| `js/main.js` | ✅ | ~50% | 大量 window.* 全局暴露 |
| `js/utils/pathogenRisk.js` | ❌ | — | 新发现，Pathogen.js 和 Dashboard.js 均引用 |
| `js/utils/FormValidator.js` | ❌ | — | 未完整读取 |
| `js/utils/SampleDataGenerator.js` | ❌ | — | — |
| `js/utils/UIHelper.js` | ❌ | — | — |
| `js/utils/UINotification.js` | ❌ | — | — |
| `index.html` / `login.html` 等 | ❌ | — | — |

---

## 3. 已发现问题清单（完整版 v0.5）

### 🔴 P0 — 高危问题（建议 1~3 天内处理）

#### P0-01：`syncRoutes.js` 三重严重问题并发
- **位置**：`backend/routes/syncRoutes.js`
- **问题**：① 无认证保护；② 不操作数据库（伪同步）；③ CommonJS 语法在 ES Module 项目中运行时崩溃
- **修复建议**：改写为 ES Module、添加认证中间件、接入 Prisma

#### P0-02：`authenticateUser` 中间件三处实现不一致
- **位置**：`server.js`、`userRoutes.js`、`auditRoutes.js`
- **问题**：挂载字段名不同（`req.userId`/`req.userRole` vs `req.user` 对象），下游混用导致 `undefined`
- **修复建议**：抽取为独立 `middleware/authMiddleware.js`，统一导出

#### P0-03：JWT 密钥 fallback 为弱明文字符串
- **位置**：`backend/server.js`
- **修复建议**：未配置时 `process.exit(1)`，拒绝启动

#### P0-04：`POST /api/user/register` 完全公开，无需授权
- **位置**：`backend/routes/userRoutes.js`
- **修复建议**：添加 `authenticateUser` + `authorizeAdmin` 中间件

#### P0-05：`seed.js` 初始管理员密码 `8888` 明文写入公开 GitHub 仓库
- **位置**：`backend/prisma/seed.js`
- **问题**：`admin/8888`、`operator/operator123`、`viewer/viewer123` 均已公开
- **修复建议**：通过环境变量注入初始密码；**立即在生产环境修改所有账号密码**

#### P0-06：`record_code` 双重生成逻辑并存，幂等性失效
- **位置**：`backend/server.js`
- **关联**：`dedupe-test-records.js` 证实此问题已在生产环境发生
- **修复建议**：统一使用 `buildDeterministicRecordCode()`；数据库层对 `record_code` 添加 `@unique` 约束

#### P0-07：快速访问模式（Quick Access）完全绕过认证
- **位置**：`js/services/GuestAuthService.js`
- **问题**：Token 为本地伪随机字符串，后端从不验证；两行 localStorage 操作即可进入系统
- **修复建议**：快速访问必须经后端签发临时 Token，或完全移除此功能

#### P0-08：`Storage.js` 数据写入的 Token 注入机制待确认
- **位置**：`js/core/Storage.js` + `js/core/AdaptiveUploadQueue.js`
- **已确认**：`AdaptiveUploadQueue` 的 `_getHeaders` 由构造时外部注入（`options.getHeaders`）
- **待确认**：`Storage.js` 传入的 `getHeaders: () => this._getHeaders()` 中，`_getHeaders()` 方法在读取到的代码中未出现（截断）
- **风险**：若 `_getHeaders()` 未正确返回 `{ Authorization: 'Bearer ...' }`，所有数据上传请求均被后端 401 拒绝，进入无限重试循环
- **修复建议**：下一轮读取 Storage.js 完整代码，确认 `_getHeaders()` 实现

#### P0-09：`js/core/Auth.js` 的 `auth.verify()` 对编辑操作完全不做权限校验
- **位置**：`js/core/Auth.js`，`verify()` 方法
- **问题**：
  - `auth.verify()` 被 `Tableware.js`、`GenericTest.js`、`Pathogen.js`、`UserManagement.js` 用于所有敏感操作的"权限校验"
  - 实际逻辑：**仅当操作名包含"删除"时弹出 `confirm()` 确认框**；编辑操作直接执行回调，无任何角色/权限检查
  - `viewer` 角色（无 `records:update` 权限）可直接调用编辑功能，`auth.verify('编辑检测记录', callback)` 会立即执行 `callback`
  - 这是一个**设计性漏洞**：开发者误将"操作确认"当作"权限校验"使用
- **修复建议**：
  - `auth.verify()` 中增加角色/权限校验逻辑，调用 `permissionService.hasPermission()`
  - 或在各业务模块中先调用 `permissionService.hasPermission('records:update')` 再调用 `auth.verify()`
  - 后端 `PUT /api/records/:type/:id` 必须同时校验操作者权限（后端是最终防线）

---

### 🟠 P1 — 重要问题（建议 1 周内处理）

#### P1-01：`auditRoutes.js` 路由注册顺序冲突
- **修复建议**：静态路由移到动态参数路由之前

#### P1-02：`idempotencyMiddleware` 使用内存存储，PM2 重启后全部失效
- **修复建议**：中期替换为 Redis；短期对 `cleanup` 加节流

#### P1-03：`UserManager.registerUser()` 自动生成虚假 email
- **修复建议**：注册时不自动生成 `@foodlab.local` 邮箱

#### P1-04：密码强度校验过弱（仅 `length >= 6`）
- **修复建议**：最小长度 8 位，要求包含数字和字母

#### P1-05：`AuthService.refreshToken()` 调用后端不存在的接口 `/api/auth/refresh`
- **修复建议**：后端实现接口，或前端移除 refresh 逻辑

#### P1-06：前端权限控制完全依赖 CSS `hidden` 类，可被 DevTools 绕过
- **修复建议**：所有敏感操作必须在后端 API 层进行权限校验

#### P1-07：`Router.js` 将自身暴露到 `window.router` 全局作用域
- **修复建议**：移除 `window.router = this`，改用模块化导出

#### P1-08：`TestRecord` 的 `onDelete: Cascade` 可能导致检测数据意外丢失
- **修复建议**：改为 `onDelete: Restrict` 或 `SetNull`

#### P1-09：系统存在两套并行审计日志机制，职责边界混乱
- **位置**：`js/utils/AuditLogger.js`（仅写 localStorage）vs `js/services/AuditLogService.js`（正确上报后端）
- **修复建议**：统一使用 `AuditLogService.logOperation()` 作为唯一审计入口；废弃 `AuditLogger.js` 的 localStorage 写入

#### P1-10：`PermissionService` 权限缓存永不失效
- **修复建议**：在 login/logout 时调用 `permissionCache.clear()`；修复异步/同步混用逻辑

#### P1-11：`SessionManager` 会话全存内存，IP 硬编码，`syncToBackend` 调用未知接口
- **修复建议**：会话信息存储后端；真实 IP 从后端获取；确认 syncToBackend 目标接口

#### P1-12：`telemetry.js` 使用 CommonJS，且未集成到主进程
- **修复建议**：改写为 ES Module 或重命名 `.cjs`；确认是否需要启用监控

#### P1-13：`CORS_ORIGIN` 在 `.env.example` 中未包含生产 IP，与 `server.js` 硬编码不一致
- **修复建议**：`.env.example` 补充生产 IP 示例；`server.js` 移除所有硬编码 IP

#### P1-14：`Storage.js` 的 `getAll()` 优先返回本地缓存，数据一致性无保障
- **修复建议**：增加缓存时效标记；导出前强制触发同步并等待完成

#### P1-15：`dedupe-test-records.js` 证实生产环境曾出现大量重复数据，根因未根治
- **修复建议**：根治 P0-06；数据库层对 `record_code` 添加 `@unique` 约束

#### P1-16：`BackupRestore.js` 的备份/恢复操作依赖无效的 `syncRoutes`
- **修复建议**：待 P0-01 修复后，同步更新 BackupRestore 的调用逻辑

#### P1-17：`UserManagement.js` 前端删除操作无二次确认，且无后端权限二次校验
- **修复建议**：添加确认弹窗；后端 `DELETE /api/user/:id` 必须校验调用者角色

#### P1-18：`Pathogen.js` 快速访问模式下访客可访问病原体检测模块，与权限矩阵矛盾
- **位置**：`js/modules/Pathogen.js`，`initPathogen()` 函数
- **问题**：
  - 权限矩阵（`PermissionService.js`）明确规定 `guest` 无 `module:pathogen` 权限
  - `Router.js` 的 `updateNavigationByPermission()` 也会隐藏病原体检测导航按钮
  - 但 `Pathogen.js` 中的权限检查逻辑为：`if (isGuest && !isQuickAccess) { return; }`
  - **快速访问模式（`isQuickAccess = true`）下，访客可以完整访问病原体检测模块**，包括查看所有检测数据
  - 这与权限矩阵的设计意图直接矛盾
- **修复建议**：
  - 将权限检查改为：`if (isGuest || isQuickAccess) { return; }`（快速访问模式同样禁止访问）
  - 或在 `PermissionService` 中为快速访问模式单独定义权限集合

#### P1-19：`AdaptiveUploadQueue` 的 `_completedFingerprints` 缓存上限为 500 条，超出后静默丢弃
- **位置**：`js/core/AdaptiveUploadQueue.js`
- **问题**：
  - `_maxFingerprintCache = 500`，超出时调用 `_evictOldFingerprints()`（截断，实现未完整读取）
  - 若淘汰策略不当（如 FIFO 而非 LRU），可能导致近期完成的请求指纹被淘汰，相同内容被重复上传
  - 结合 P0-06 的 `record_code` 问题，可能再次产生重复数据
- **修复建议**：确认 `_evictOldFingerprints()` 的淘汰策略；建议使用 LRU 或按 TTL 清理

#### P1-20：`Dashboard.js` 将 `loadDashboardData` 挂载到 `window` 全局
- **位置**：`js/modules/Dashboard.js`
- **代码**：`window.loadDashboardData = loadDashboardData`
- **问题**：与 P2-10 一致，全局暴露扩大攻击面；且 Dashboard 实例化了 5 个 `StorageService`，每个都会触发后台同步，页面加载时产生 5 个并发 API 请求
- **修复建议**：使用 `CustomEvent` 替代全局函数；合并多个 StorageService 的同步请求

#### P1-21：`js/core/Auth.js` 与 `js/services/AuthService.js` 类名冲突，极易引发维护错误
- **位置**：`js/core/Auth.js`（导出 `class AuthService`）vs `js/services/AuthService.js`（导出 `class AuthService`）
- **问题**：两个文件导出同名类 `AuthService`，若开发者在同一文件中同时 import 两者，会发生命名冲突；且职责完全不同（一个管 Token，一个管确认弹窗），极易混淆
- **修复建议**：将 `js/core/Auth.js` 中的类重命名为 `OperationGuard` 或 `ActionConfirmer`，导出单例改名为 `operationGuard`

---

### 🟡 P2 — 优化建议（建议 2 周内处理）

#### P2-01：`rateLimit` 默认值过高，登录接口无专项限流
- **修复建议**：`POST /api/user/login` 单独限流 10 次/分钟/IP

#### P2-02：检测记录 CRUD 操作未自动写入审计日志（后端层面）
- **修复建议**：记录 CRUD 成功响应后统一调用 `prisma.auditLog.create()`

#### P2-03：`UserManager.loginUser()` 失败登录日志未确认写入数据库
- **修复建议**：确认 `logFailedLogin` 是否写入 `AuditLog` 表

#### P2-04：`AuthService.getUser()` 对 `JSON.parse` 无容错处理
- **修复建议**：添加 try/catch，异常时调用 `clearAuth()`

#### P2-05：`Router.init()` 每次调用都实例化新的 `GuestAuthService`
- **修复建议**：构造函数中初始化单例

#### P2-06：`/api/health` 与 `/health` 重复定义
- **修复建议**：统一保留 `/api/health`

#### P2-07：`buildRecordWriteData()` 字段提取无 Schema 验证
- **修复建议**：引入 Zod 或 Joi 进行请求体 Schema 验证

#### P2-08：`Backup` 模型缺少关联用户外键约束
- **修复建议**：添加 `created_user User? @relation(...)` 关联

#### P2-09：`NetworkHelper.checkConnection()` 硬编码 Google URL，内网环境不可达
- **修复建议**：改为检查自身后端健康接口 `/api/health`

#### P2-10：`main.js` 和 `Dashboard.js` 大量函数通过 `window.*` 全局暴露
- **修复建议**：使用自定义事件（`CustomEvent`）替代全局函数调用

#### P2-11：`GuestAuthService.getCurrentGuest()` 对 `JSON.parse` 无容错处理
- **修复建议**：添加 try/catch

#### P2-12：`seed.js` 中测试账号在生产环境应禁用
- **修复建议**：通过 `NODE_ENV` 判断，生产环境仅创建 admin 账号

#### P2-13：`Storage.js` 的 `tempId` 使用 `Date.now()` + `Math.random()`，多标签页可能碰撞
- **修复建议**：使用 `crypto.randomUUID()` 生成 tempId；增加僵尸记录清理机制

#### P2-14：`ExportService.js` 导出数据完全来自本地缓存，可能导出过期数据
- **修复建议**：导出前调用强制同步，或直接从后端 API 拉取数据

#### P2-15：`AuditLogService.getStats()` 调用路径与 P1-01 路由冲突
- **修复建议**：修复 P1-01 路由顺序后，此问题自动解决

#### P2-16：`Pathogen.js` 通过动态 `<script>` 标签从 CDN 加载 Mammoth.js，无完整性校验
- **位置**：`js/modules/Pathogen.js`，`loadMammothJS()` 函数
- **代码**：`script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.21/mammoth.browser.min.js'`
- **问题**：动态加载外部脚本无 `integrity`（SRI）属性校验，若 CDN 被劫持或内容被篡改，恶意脚本将在页面上下文中执行
- **修复建议**：添加 `script.integrity = 'sha384-...'` 和 `script.crossOrigin = 'anonymous'`；或将 Mammoth.js 本地化

#### P2-17：`GenericTest.js` 作为基类但未使用继承，各检测模块存在大量重复代码
- **位置**：`js/modules/GenericTest.js`
- **问题**：`Tableware.js`、`Pathogen.js` 等模块与 `GenericTest.js` 存在大量重复的分页、筛选、渲染逻辑，但并未通过继承 `GenericTestModule` 来复用，而是各自独立实现
- **修复建议**：将 `Tableware.js`、`Pathogen.js` 等重构为继承 `GenericTestModule` 的子类

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

#### P3-07：`Storage.js` 离线优先架构在多设备场景下存在数据冲突风险
- **建议**：引入乐观锁（`updated_at` 版本号校验）或 CRDT 策略

#### P3-08：`AdaptiveUploadQueue.js` 代码截断，队列核心逻辑（错误处理、淘汰策略）未完整审阅
- **建议**：下一轮补充读取完整代码

#### P3-09：`pathogenRisk.js` 未读取，病原体风险计算逻辑未审阅
- **建议**：下一轮读取，重点关注风险等级计算是否符合食品安全标准

---

## 4. 问题优先级汇总

| 优先级 | 数量 | 核心主题 |
|--------|------|----------|
| 🔴 P0 高危 | 9 项 | syncRoutes 无认证、JWT 弱密钥、认证不一致、注册无保护、seed 密码明文、快速访问绕过、Storage Token 待确认、record_code 幂等失效、Auth.js 编辑无权限校验 |
| 🟠 P1 重要 | 21 项 | 路由冲突、内存幂等、两套审计机制、缓存一致性、重复数据根因、病原体权限漏洞、Auth 类名冲突等 |
| 🟡 P2 优化 | 17 项 | 限流、JSON 容错、全局暴露、CDN 完整性、代码重复等 |
| 🔵 P3 长期 | 9 项 | 数据库迁移、Token 安全、多设备冲突、队列完整审阅等 |
| **合计** | **56 项** | |

---

## 5. 待审阅文件与下一步任务

### 5.1 下一轮需读取的文件（优先级排序）

```
# 最高优先级：确认 Storage Token 注入（解答 P0-08）
# Storage.js 已读取但截断，需要读取完整版或专门查找 _getHeaders 方法
# 可尝试搜索关键词或直接读取文件后半段

# 高优先级：病原体风险计算逻辑
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/utils/pathogenRisk.js

# 高优先级：工具类（被多个模块依赖）
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/utils/FormValidator.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/utils/UINotification.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/utils/SampleDataGenerator.js

# 中优先级：HTML 入口页面
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/index.html
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/login.html
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
本次审阅上下文见 docs/review/REVIEW_GUIDE.md（请先读取 GitHub 上的最新版本）。

本轮任务：
1. 首先读取 GitHub 上的 REVIEW_GUIDE.md 确认版本号
2. 读取"第5.1节-待审阅文件"中的下一批文件（使用 raw.githubusercontent.com 链接）
3. 按"第5.2节-审阅维度清单"进行分析
4. 将新发现的问题追加到本文档"第3节-已发现问题清单"中
5. 更新"第2节-已审阅文件清单"的状态
6. 输出更新后的完整 REVIEW_GUIDE.md
```

---

## 7. 文档变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-06-22 | v0.1 | 初始创建，完成后端核心文件审阅 |
| 2026-06-22 | v0.2 | 新增 UserManager、idempotencyMiddleware、syncRoutes、AuthService、Router 审阅；问题总数 29 项 |
| 2026-06-22 | v0.3 | 补全完整目录树；新增 GuestAuthService、PermissionService、SessionManager、AuditLogger、NetworkHelper、main.js、seed.js、telemetry.js、.env.example 审阅；问题总数 39 项 |
| 2026-06-22 | v0.4 | 新增 Storage.js、AuditLogService、AuditLog、BackupRestore、UserManagement、ExportService、dedupe-test-records 审阅；发现两套审计机制并存、离线缓存一致性等；问题总数 48 项 |
| 2026-06-22 | v0.5 | 新增 Auth.js（类名冲突）、AdaptiveUploadQueue、Tableware、GenericTest、Pathogen、Dashboard、GuestDashboard 审阅；发现 Auth.js 编辑无权限校验（P0-09）、病原体权限矩阵漏洞（P1-18）、CDN 完整性风险（P2-16）等；问题总数扩展至 56 项 |