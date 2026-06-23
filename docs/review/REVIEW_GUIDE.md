# 食品安全检验管理系统 Pro — 代码审阅上下文指导文档

**文档路径**：`docs/review/REVIEW_GUIDE.md`
**系统名称**：食品安全检验管理系统 Pro（珠海一中食品安全检验系统）
**仓库地址**：https://github.com/ArthurUker/Tianjiabing_foodtestlab/tree/ZhuHaiYiZhong
**审阅开始日期**：2026-06-22
**文档版本**：v0.10（2026-06-23 第十轮更新）
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
| 数据库 | SQLite（生产）| 单文件，路径待确认（见 §1.2 注意事项）|
| 认证 | JWT Bearer Token + bcryptjs | Token 有效期 7 天（`JWT_EXPIRES_IN=7d`）|
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
| 数据库文件 | ⚠️ **路径存在歧义，见下方说明（P1-26）** |
| API 前缀 | `/api` |
| 登录接口 | `POST /api/user/login` |
| 初始管理员账号 | `admin` / 由 `.env` 中 `SEED_ADMIN_PASSWORD` 配置（✅ P0-05 已修复，明文 fallback 已删除）|
| 初始测试员账号 | `operator` / 由 `.env` 中 `SEED_OPERATOR_PASSWORD` 配置（✅ P0-05 已修复）|
| 初始查看员账号 | `viewer` / 由 `.env` 中 `SEED_VIEWER_PASSWORD` 配置（✅ P0-05 已修复）|

> ⚠️ **数据库路径歧义（P1-26）**：
> - `docs/` 系统文档记录：`D:\珠海一中\foodtestlab.db`
> - 本文档 v0.7 记录：`D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`
> - **两个路径不一致，请以生产服务器 `.env` 中的 `DATABASE_URL` 实际值为准，并统一所有文档。**

### 1.3 完整项目目录结构（v0.8 更新）

```
项目根目录/
├── .babelrc / .gitignore / .npmrc / .vscode/
├── .env.example                          ✅ 已审阅
├── package.json                          ✅ 已审阅（v0.8 新增）✅ P0-10 已修复：已添加 "type":"module"，start 脚本改为 cd backend && npm start
├── index.html                            ✅ 已审阅（主页面）
├── login.html                            ✅ 已审阅（登录页）
├── guest.html                            ❌ 文件不存在（404 已确认）
├── backend/
│   ├── package.json                      ✅ 已审阅（v0.8 新增）✅ 正确配置 "type":"module" 和 prisma 依赖
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
├── docs/
│   └── review/REVIEW_GUIDE.md            ✅ 本文件
├── js/
│   ├── main.js                           ✅ 已审阅（部分）
│   ├── core/
│   │   ├── Auth.js                       ✅ 已审阅
│   │   ├── Router.js                     ✅ 已审阅
│   │   ├── Storage.js                    ✅ 已审阅（v0.7 完整确认：_getHeaders 正常注入 Bearer Token；✅ P0-08 已修复：_canSyncWithServer temp-token- 前缀判断已移除，改为依赖后端 401 阻断）
│   │   └── AdaptiveUploadQueue.js        ✅ 已审阅（v0.7 完整确认：_makeFingerprint 完整；_isRecentlyCompleted 末尾轻微截断不影响逻辑；_doRequest URL 硬编码问题已记录为 P1-24）
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
│       ├── FormValidator.js              ✅ 已审阅
│       ├── NetworkHelper.js              ✅ 已审阅
│       ├── pathogenRisk.js               ✅ 已审阅（逻辑正常）
│       ├── SampleDataGenerator.js        ✅ 已审阅
│       ├── UIHelper.js                   ✅ 已审阅
│       └── UINotification.js             ✅ 已审阅
└── [工程配置文件]                         ❌ 未读取（.babelrc、webpack.config.js 等，优先级低）
```

> **审阅覆盖率**：核心业务文件已全部覆盖（~95%）。`guest.html` 已确认不存在。剩余未读取项为低优先级工程配置文件。

### 1.10 GitHub 文件读取 CDN 缓存问题与解决方案（v0.10 新增）

> **问题背景**：`raw.githubusercontent.com` 通过 Fastly CDN 分发文件，缓存 TTL 不固定（通常 5 分钟，高负载时更长）。在 `git push` 后立即读取，AI 可能仍拿到旧版本缓存内容，导致核验结论基于过期数据。

> **解决方案**：在所有 `raw.githubusercontent.com` 链接末尾追加时间戳参数 `?t={unix_timestamp}`，CDN 将其视为全新请求，强制回源拉取最新内容。

**标准读取 URL 格式：**

```
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/{文件路径}?t={当前Unix时间戳}
```

**示例：**
```
# 旧方式（受 CDN 缓存影响，可能读到旧版本）
https://raw.githubusercontent.com/.../FIX_PLAN.md

# 新方式（强制绕过缓存，始终读取最新版本）
https://raw.githubusercontent.com/.../FIX_PLAN.md?t=1750669200
```

> **执行规则**：Monica 在每次新对话中读取任何 GitHub 文件时，自动附加当前时间戳参数，无需郭博额外操作。时间戳每次不同即可，无需精确对应当前时刻。


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

### 1.7 前端认证模块命名混淆说明

> ⚠️ 系统中存在**两个不同的 AuthService**，极易混淆：

| 文件 | 导出名 | 职责 | 被谁使用 |
|------|--------|------|---------|
| `js/services/AuthService.js` | `AuthService` / `authService` | JWT Token 管理、登录/登出、用户信息存取 | Router.js、main.js、AuditLogService.js 等 |
| `js/core/Auth.js` | `AuthService`（同名类）/ `auth`（单例） | 仅做操作二次确认弹窗（删除时 confirm）+ 读取 localStorage 用户名 | Tableware.js、GenericTest.js、Pathogen.js、UserManagement.js |

### 1.8 `index.html` 主页面功能模块速查（v0.6 新增）

| 模块 ID | 功能名称 | 对应 JS 模块 |
|---------|---------|------------|
| `dashboard` | 实时数据概览 | `Dashboard.js` |
| `tableware` | 餐具洁净度检测 | `Tableware.js` |
| `pesticide` | 果蔬农残检测 | `GenericTest.js` |
| `oil` | 食用油品质检测 | `GenericTest.js` |
| `leanMeat` | 肉蛋农残检测 | `GenericTest.js` |
| `pathogen-test` | 食源性细菌/病毒检测 | `Pathogen.js` |
| `audit-log` | 操作审计日志 | `AuditLog.js` |
| `user-management` | 用户管理 | `UserManagement.js` |
| `guest-dashboard` | 访客中心 | `GuestDashboard.js` |
| `backup-restore` | 备份与恢复 | `BackupRestore.js` |

### 1.9 package.json 双文件架构说明（v0.8 新增）

> ⚠️ 项目存在两个 `package.json`，职责边界模糊，是历史遗留问题。

| 文件 | 定位 | 状态 |
|------|------|------|
| `/package.json`（根目录）| 原为前端工程工具配置容器（Webpack、Jest、Cypress）| ⚠️ **僵尸文件**：前端已改为原生 HTML，webpack 无用；缺少 `"type":"module"` 和 `prisma` 依赖；版本号 `3.1.0` 与后端不同步 |
| `/backend/package.json` | 后端 Node.js 运行时依赖 | ✅ **生产部署入口**：正确配置 `"type":"module"`、`prisma ^5.10.0`、`express ^4.22.1` 等 |

**演进路径**：项目早期前后端统一管理，后端独立到 `backend/` 后新建了自己的 `package.json`，根目录文件未随之清理，形成双文件并存的历史遗留状态。

**结论**：生产部署应始终在 `backend/` 目录下执行 `npm install` 和 `npm start`，根目录 `package.json` 需清理或明确标注用途（见 P0-10）。

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
| `backend/prisma/dedupe-test-records.js` | ✅ | 100% | 证实历史重复数据问题 |
| `backend/config/telemetry.js` | ✅ | 100% | CommonJS 语法、未集成到主进程 |
| `backend/package.json` | ✅ | 100% | ✅ 正确配置；依赖版本与根目录不同步（P1-25）|
| `/package.json`（根目录）| ✅ | 100% | ⚠️ 僵尸文件；缺少 `"type":"module"` 和 prisma（P0-10）；webpack 已无用 |
| `.env.example` | ✅ | 100% | JWT_SECRET 示例值为弱字符串 |
| `index.html` | ✅ | 100% | 主页面结构完整；模块 ID 与 JS 模块对应关系已梳理 |
| `login.html` | ✅ | 100% | **"以访客身份进入"按钮是 P0-07 快速访问的入口** |
| `guest.html` | ❌ | — | **文件不存在（404 已确认）** |
| `js/core/Auth.js` | ✅ | 100% | **与 AuthService.js 同名；编辑操作无权限校验** |
| `js/core/Router.js` | ✅ | ~85% | 权限控制仅靠 CSS 隐藏、全局暴露 window.router |
| `js/core/Storage.js` | ✅ | 100% | **v0.7 完整确认**：`_getHeaders()` 正常注入 Bearer Token；`_canSyncWithServer()` 存在 `temp-token-` 前缀伪造风险（P0-08 确认）|
| `js/core/AdaptiveUploadQueue.js` | ✅ | ~95% | **v0.7 完整确认**：指纹去重、自适应节流逻辑完整；`_doRequest()` URL 硬编码（P1-24 新增）；`_isRecentlyCompleted()` 末尾轻微截断，不影响逻辑 |
| `js/modules/AuditLog.js` | ✅ | ~70% | 正确通过 AuditLogService 查询后端 |
| `js/modules/BackupRestore.js` | ✅ | ~60% | 备份恢复依赖无效的 syncRoutes |
| `js/modules/Dashboard.js` | ✅ | ~70% | `loadDashboardData` 挂载到 `window` |
| `js/modules/GenericTest.js` | ✅ | ~60% | 通用检测基类；使用 `auth.verify()` |
| `js/modules/GuestDashboard.js` | ✅ | ~70% | 访客界面；快速访问模式标签 |
| `js/modules/Pathogen.js` | ✅ | ~65% | 快速访问模式下访客可访问病原体模块 |
| `js/modules/Tableware.js` | ✅ | ~65% | 使用 `auth.verify()` 做删除确认 |
| `js/modules/UserManagement.js` | ✅ | ~60% | 前端 CRUD 无二次权限校验 |
| `js/services/AuditLogService.js` | ✅ | 100% | 正确上报后端 `/api/audit-logs` |
| `js/services/AuthService.js` | ✅ | ~90% | Token 存 localStorage、refreshToken 后端未实现 |
| `js/services/ExportService.js` | ✅ | ~60% | 依赖 StorageService 本地缓存导出 |
| `js/services/GuestAuthService.js` | ✅ | 100% | 快速访问模式绕过认证 |
| `js/services/PermissionService.js` | ✅ | ~80% | 权限缓存不失效、异步/同步混用 |
| `js/services/SessionManager.js` | ✅ | ~70% | 会话全存内存、IP 硬编码 |
| `js/utils/AuditLogger.js` | ✅ | 100% | 仅写 localStorage，不上报后端 |
| `js/utils/FormValidator.js` | ✅ | ~90% | 规则库完整；**缺少 XSS/注入防护规则；与后端校验不同步** |
| `js/utils/NetworkHelper.js` | ✅ | ~90% | 网络检查 URL 硬编码 Google |
| `js/utils/pathogenRisk.js` | ✅ | 100% | ✅ 逻辑正常；Ct 值四级风险分级；有学术引用 |
| `js/utils/SampleDataGenerator.js` | ✅ | ~80% | **示例数据 ID 为整数，与 StorageService tempId 格式不一致** |
| `js/utils/UIHelper.js` | ✅ | 100% | 导航切换逻辑简单；无安全问题 |
| `js/utils/UINotification.js` | ✅ | ~90% | **`innerHTML` 直接插入 message，存在 XSS 风险** |
| `js/main.js` | ✅ | ~50% | 大量 window.* 全局暴露 |
| `docs/` 目录 | ✅ | 部分 | 数据库路径与本文档记录不一致（P1-26）|
| `[工程配置文件]` | ❌ | — | `.babelrc`、`webpack.config.js` 等未读取（优先级低）|

---

## 3. 已发现问题清单（完整版 v0.8）

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
- **位置**：`js/services/GuestAuthService.js` + `login.html`（入口按钮）
- **问题**：`login.html` 中"以访客身份进入"按钮直接触发快速访问；Token 为本地伪随机字符串，后端从不验证
- **修复建议**：快速访问必须经后端签发临时 Token，或完全移除此功能；至少在 `login.html` 中添加明确的权限说明

#### P0-08：`Storage.js` `_canSyncWithServer()` 的 `temp-token-` 前缀校验可被客户端伪造
- **位置**：`js/core/Storage.js`，`_canSyncWithServer()` 方法
- **v0.7 确认**：`_getHeaders()` 实现完整正常（`Authorization: Bearer <token>`，管理员 `auth_token` 优先，fallback `guest_token`）；真实问题在于 `_canSyncWithServer()` 通过 `token.startsWith('temp-token-')` 判断是否允许同步，该前缀字符串可由客户端任意伪造，无服务端验证
- **风险**：攻击者构造 `temp-token-` 开头的伪造 Token，可绕过同步阻断逻辑，触发未经授权的数据上传
- **修复建议**：移除前缀字符串判断；改为向后端 `/api/user/verify-token` 发起验证请求，或依赖后端 401 响应作为唯一阻断机制

#### P0-09：`js/core/Auth.js` 的 `auth.verify()` 对编辑操作完全不做权限校验
- **位置**：`js/core/Auth.js`，`verify()` 方法；被 Tableware、GenericTest、Pathogen、UserManagement 调用
- **问题**：仅当操作名包含"删除"时弹 `confirm()`；编辑操作直接执行回调，`viewer` 角色可随意编辑数据
- **修复建议**：`verify()` 中增加 `permissionService.hasPermission()` 校验；后端 PUT 接口同时校验操作者权限

#### P0-10：根目录 `package.json` 缺少 `"type": "module"` 且无 Prisma 依赖，生产部署存在启动崩溃风险（v0.8 新增）
- **位置**：`/package.json`（根目录）
- **问题**：
  - 缺少 `"type": "module"`，在根目录执行 `npm start` 时 Node.js 以 CommonJS 解析 ES Module 代码，直接崩溃
  - 完全缺少 `prisma` 和 `@prisma/client` 依赖，根目录 `npm install` 后无法运行数据库操作
  - `webpack` 依赖已无用（前端已改为原生 HTML），增加无效安装体积
- **修复建议**：明确根目录 `package.json` 定位为工程工具配置，`start` 脚本改为 `cd backend && npm start`；清理无用的 `webpack` 依赖；在 `README` 中明确标注两个 `package.json` 的职责边界

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
- **修复建议**：将权限检查改为 `if (isGuest || isQuickAccess) { return; }`

#### P1-19：`AdaptiveUploadQueue` 的 `_completedFingerprints` 缓存上限 500 条，淘汰策略为 FIFO
- **v0.7 确认**：`_markCompleted()` 中当缓存达到 `_maxFingerprintCache`（500）上限时，通过 `this._completedFingerprints.keys().next().value` 取出 Map 中最旧的键并删除，为**FIFO 策略**（非 LRU）；在高频写入场景下，最近完成的指纹可能因 FIFO 淘汰而被重新入队，导致重复上传
- **修复建议**：改为按 TTL（`_fingerprintTTL`，默认 60s）批量清理过期条目，替代固定上限 FIFO 淘汰

#### P1-20：`Dashboard.js` 将 `loadDashboardData` 挂载到 `window` 全局，且实例化 5 个 StorageService
- **修复建议**：使用 `CustomEvent` 替代全局函数；合并多个 StorageService 的同步请求

#### P1-21：`js/core/Auth.js` 与 `js/services/AuthService.js` 类名冲突，极易引发维护错误
- **修复建议**：将 `js/core/Auth.js` 中的类重命名为 `OperationGuard`，导出单例改名为 `operationGuard`

#### P1-22：`SampleDataGenerator.js` 示例数据 ID 为简单整数，与 `StorageService` 格式不一致，可能引发同步混乱
- **位置**：`js/utils/SampleDataGenerator.js`
- **问题**：
  - 示例数据使用 `id: 1`、`id: 2`、`id: 3` 等简单整数
  - `StorageService.save()` 生成的 tempId 格式为 `temp_{timestamp}_{random}`，服务端 ID 为 `cuid()`
  - 整数 ID 与两种格式均不兼容，若 `StorageService` 的 `update()` / `delete()` 方法按 ID 查找记录，示例数据可能无法被正确操作
  - 示例数据写入 `localStorage` 后，`StorageService._syncFromApi()` 会尝试与服务端同步，但整数 ID 在服务端不存在，可能触发错误
- **修复建议**：示例数据 ID 改用 `crypto.randomUUID()` 或 `temp_sample_{n}` 格式；或在快速访问模式下完全禁用同步

#### P1-23：`FormValidator.js` 前端校验规则与后端 `validationMiddleware.js` 不同步
- **位置**：`js/utils/FormValidator.js` vs `backend/middleware/validationMiddleware.js`
- **问题**：
  - 前端 `FormValidator` 有 `phone`（中国手机号正则）、`idCard`、`dateNotFuture` 等规则
  - 后端 `validationMiddleware` 的规则集未完整读取（~40%），无法确认是否覆盖相同字段
  - 若两端校验规则不一致，攻击者可绕过前端校验直接向后端发送非法数据
- **修复建议**：建立统一的校验规则配置文件，前后端共享；或至少确保后端校验是前端的超集

#### P1-24：`AdaptiveUploadQueue._doRequest()` URL 硬编码，绕过 `StorageService` 的 `apiBaseUrl` 配置（v0.7 新增）
- **位置**：`js/core/AdaptiveUploadQueue.js`，`_doRequest()` 方法
- **问题**：`_doRequest()` 中所有请求 URL 均硬编码为 `/api/records/${item.collection}`，完全忽略 `StorageService` 构造时通过 `getHeaders` 回调传入的 `apiBaseUrl` 配置；若未来 API 前缀变更或需要多环境部署，`AdaptiveUploadQueue` 的请求将无法跟随配置变更
- **修复建议**：在 `AdaptiveUploadQueue` 构造函数中新增 `getBaseUrl` 回调选项，`StorageService` 初始化时传入 `() => this.apiBaseUrl`；`_doRequest()` 改为 `` `${this._getBaseUrl()}/${item.collection}` ``

#### P1-25：两套 `package.json` 依赖版本不同步，开发与生产环境行为存在差异（v0.8 新增）
- **位置**：`/package.json` vs `backend/package.json`
- **问题**：`express`（`^4.18.2` vs `^4.22.1`）、`dotenv`（`^16.0.3` vs `^16.6.1`）、`cors`（`^2.8.5` vs `^2.8.6`）、`jsonwebtoken`（`^9.0.0` vs `^9.0.2`）版本均存在差异；`nodemon` 与 `node --watch` 混用
- **修复建议**：统一依赖版本；明确 `backend/package.json` 为唯一生产部署入口

#### P1-26：生产数据库路径在 `docs/` 文档与本文档记录不一致（v0.8 新增）
- **位置**：`docs/` 系统文档 vs 本文档 §1.2
- **`docs/` 记录**：`D:\珠海一中\foodtestlab.db`
- **本文档 v0.7 记录**：`D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`
- **风险**：若 `.env` 中 `DATABASE_URL` 配置了错误路径，Prisma 将无法找到数据库文件，系统完全无法读写数据
- **修复建议**：**立即确认生产服务器 `.env` 中的 `DATABASE_URL` 实际值**，并统一所有文档记录

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

#### P2-16：`Pathogen.js` 通过动态 `<script>` 从 CDN 加载 Mammoth.js，无 SRI 完整性校验
- **修复建议**：添加 `script.integrity = 'sha384-...'` 和 `script.crossOrigin = 'anonymous'`；或将 Mammoth.js 本地化

#### P2-17：`GenericTest.js` 作为基类但各检测模块未通过继承复用，存在大量重复代码
- **修复建议**：将 `Tableware.js`、`Pathogen.js` 等重构为继承 `GenericTestModule` 的子类

#### P2-18：`UINotification.show()` 使用 `innerHTML` 直接插入 `message` 参数，存在 XSS 风险
- **位置**：`js/utils/UINotification.js`，`show()` 方法
- **代码**：`notification.innerHTML = \`...<div class="flex-1">${message}</div>...\``
- **问题**：
  - `message` 参数若包含用户输入内容（如检测员姓名、样本备注等），会被直接插入 DOM
  - 攻击者可通过构造恶意检测记录（如 `<img src=x onerror=alert(1)>`），在其他用户查看通知时触发 XSS
  - `UINotification` 被系统中几乎所有模块调用，攻击面极广
- **修复建议**：
  ```js
  // 将 innerHTML 改为 textContent 或使用 DOMPurify 净化
  const msgEl = document.createElement('div')
  msgEl.className = 'flex-1'
  msgEl.textContent = message  // 安全：自动转义 HTML
  notification.appendChild(msgEl)
  ```
  或引入 `DOMPurify.sanitize(message)` 进行净化

#### P2-19：`login.html` 中"以访客身份进入"按钮缺少权限说明，用户可能误解其访问范围
- **位置**：`login.html`
- **问题**：按钮描述为"访客只读模式，可查看所有检测数据"，但实际快速访问模式下病原体模块也可访问（P1-18），描述与实际不符；且无任何关于数据安全或隐私的提示
- **修复建议**：修复 P1-18 后更新描述；添加访客访问范围的明确说明

#### P2-20：`FormValidator.js` 缺少 XSS/注入防护规则，与后端安全校验不形成闭环
- **位置**：`js/utils/FormValidator.js`
- **问题**：规则库包含 `required`、`email`、`phone`、`idCard` 等业务规则，但缺少：
  - HTML 特殊字符转义（`<`, `>`, `"`, `'`, `&`）
  - SQL 注入特征检测（`'`, `--`, `;`）
  - 脚本注入检测（`<script>`, `javascript:`）
- **修复建议**：添加 `noHtml` 和 `noScript` 验证规则；与后端 `validationMiddleware.js` 的 `escapeHtml` 逻辑对齐

#### P2-21：Jest 测试框架与 ES Module 后端代码兼容性未验证（v0.8 新增）
- **位置**：根目录 `package.json` + `.babelrc`
- **问题**：Jest 默认不支持 ES Module，需要 Babel 转译；当前 `.babelrc` 配置是否完整覆盖后端代码未确认；`test:backend` 脚本使用 glob 模式在 Windows 环境下行为与 Linux 不同，可能导致测试文件找不到
- **修复建议**：在 `jest.config.js` 中添加 `transform` 配置，或改用 `--experimental-vm-modules` 运行 Jest

#### P2-22：Cypress E2E 测试脚本在 Windows Server 生产环境无法运行（v0.8 新增）
- **位置**：根目录 `package.json`，`test:e2e` 系列脚本
- **问题**：腾讯云 Windows Server 无 headless 浏览器环境，`cypress run` 会直接失败
- **修复建议**：E2E 测试仅在本地开发环境运行；CI/CD 流程中跳过 Cypress；或改用 Playwright headless 模式

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

#### P3-08：`AdaptiveUploadQueue.js` `_isRecentlyCompleted()` 末尾轻微截断
- **v0.7 更新**：截断位于末尾 TTL 比较逻辑（`if (Date.now() - ts > this._fingerprintTTL)`），逻辑可完整推断，不影响审阅结论；如需精确确认可补充读取

#### P3-09：`pathogenRisk.js` 风险分级阈值（Ct < 20 / 20-30 / 30-35 / ≥35）未注明来源标准
- **位置**：`js/utils/pathogenRisk.js`
- **现状**：极低风险分支引用了 Kitajima et al., 2012，但高/中/低风险的 Ct 阈值未注明依据的国家标准或行业规范
- **建议**：补充阈值来源（如 GB 标准或 WHO 指南），确保符合食品安全监管要求

#### P3-10：`UIHelper.js` 的导航切换完全依赖 `data-target` 属性与 DOM ID 匹配，无路由状态管理
- **位置**：`js/utils/UIHelper.js`，`setupNavigation()`
- **问题**：页面刷新后无法恢复到上次访问的模块；浏览器前进/后退按钮无效；无法通过 URL 直接访问特定模块
- **建议**：引入 URL hash 路由（`#dashboard`、`#tableware` 等）实现状态持久化

---

## 4. 问题优先级汇总

| 优先级 | 数量 | 核心主题 |
|--------|------|----------|
| 🔴 P0 高危 | **10 项** | syncRoutes 无认证、JWT 弱密钥、认证不一致、注册无保护、seed 密码明文、快速访问绕过、temp-token 前缀伪造、record_code 幂等失效、Auth.js 编辑无权限校验、根目录 package.json 启动崩溃风险 |
| 🟠 P1 重要 | **26 项** | 路由冲突、内存幂等、两套审计机制、缓存一致性、重复数据根因、病原体权限漏洞、Auth 类名冲突、示例数据 ID 格式、前后端校验不同步、URL 硬编码、双 package.json 版本不同步、数据库路径歧义 |
| 🟡 P2 优化 | **22 项** | 限流、JSON 容错、全局暴露、CDN 完整性、UINotification XSS、FormValidator 防护缺失、Jest/ES Module 兼容性、Cypress 环境问题 |
| 🔵 P3 长期 | **10 项** | 数据库迁移、Token 安全、多设备冲突、Ct 阈值来源、URL 路由状态管理等 |
| **合计** | **68 项** | |

---

## 5. 待审阅文件与下一步任务

### 5.1 下一轮建议任务（核心文件已全覆盖）

核心业务文件已全部审阅完毕（覆盖率 ~95%）。`guest.html` 已确认不存在。下一轮可聚焦以下方向：

```
# 1. 工程配置文件（优先级低，可选）
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/.babelrc
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/webpack.config.js

# 2. 转入修复阶段：按 P0 → P1 → P2 优先级逐项输出修复方案
```

### 5.2 建议转入修复方案输出阶段

> 核心文件审阅已基本完成（覆盖率 ~95%）。建议下一步转入**修复方案输出**阶段：
>
> - 按 P0 → P1 → P2 优先级，逐项输出具体代码修复方案
> - 每次对话选取 3~5 个问题，提供可直接应用的代码 diff
> - 修复完成后在本文档对应条目标记 `✅ 已修复`

### 5.3 审阅维度清单（每轮对话参考）

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
3. 按"第5.3节-审阅维度清单"进行分析
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
| 2026-06-22 | v0.4 | 新增 Storage.js、AuditLogService、AuditLog、BackupRestore、UserManagement、ExportService、dedupe-test-records 审阅；问题总数 48 项 |
| 2026-06-22 | v0.5 | 新增 Auth.js、AdaptiveUploadQueue、Tableware、GenericTest、Pathogen、Dashboard、GuestDashboard 审阅；问题总数 56 项 |
| 2026-06-22 | v0.6 | 新增 pathogenRisk.js（✅正常）、FormValidator.js、SampleDataGenerator.js、UINotification.js（XSS风险）、UIHelper.js、index.html、login.html 审阅；核心文件覆盖率达 ~90%；新增 UINotification XSS（P2-18）、FormValidator 防护缺失（P2-20）、示例数据 ID 格式（P1-22）等；问题总数扩展至 62 项；建议转入修复方案输出阶段 |
| 2026-06-22 | v0.7 | 完整确认 Storage.js（_getHeaders 正常，P0-08 精确定位为 temp-token- 前缀伪造）和 AdaptiveUploadQueue.js（P1-19 淘汰策略确认为 FIFO）；新增 P1-24（_doRequest URL 硬编码）；问题总数 63 项 |
| 2026-06-22 | v0.8 | 新增 /package.json 和 backend/package.json 双文件审阅；确认 guest.html 文件不存在（404）；读取 docs/ 目录发现数据库路径歧义；新增 §1.9 双文件架构说明；新增 P0-10（根目录 package.json 启动崩溃风险）、P1-25（双 package.json 版本不同步）、P1-26（数据库路径歧义）、P2-21（Jest/ES Module 兼容性）、P2-22（Cypress 环境问题）；问题总数 63 → **68 项**；核心文件覆盖率 ~95%；建议正式转入修复阶段 |
| 2026-06-23 | v0.9 | P0-02 遗留补修（userRoutes.js 统一认证中间件）、P0-05 遗留补修（seed.js 移除 fallback 明文密码）核验通过；修复执行进度同步至 FIX_PLAN v1.5 |
| 2026-06-23 | v0.10 | P0-06（record_code 幂等性）、P0-08（temp-token- 前缀伪造）、P0-10（根目录 package.json）修复完成并核验通过；新增 §1.10 GitHub CDN 缓存问题解决方案（?t=时间戳强制回源）；修复执行进度同步至 FIX_PLAN v1.7；P0 完成率 80% |

---

## 修复执行进度

> **说明**：本章节记录基于 `docs/fix/FIX_PLAN.md` 的修复执行状态，由 Monica 在每批修复完成后同步更新。
> 最后同步时间：**2026-06-23 15:35**｜对应 FIX_PLAN 版本：**v1.7**

### 总体进度

| 类别 | 总数 | ✅ 已完成 | ⬜ 待处理 | 完成率 |
|------|------|----------|----------|--------|
| 🔴 P0 高危 | 10 | 8 | 2 | 80% |
| 🟡 P1 重要 | 26 | 0 | 26 | 0% |
| 🟢 P2 优化 | 22 | 0 | 22 | 0% |
| 📄 DOCS 文档 | 4 | 0 | 4 | 0% |
| **合计** | **62** | **8** | **54** | **13%** |

### P0 高危问题修复状态（10 项）

| ID | 问题描述 | 预估工时 | 状态 | 完成日期 |
|----|---------|---------|------|---------|
| `P0-01` | syncRoutes.js 无认证 + 不操作DB + CommonJS 三重问题 | 4h | ✅ 已完成 | 2026-06-22 |
| `P0-02` | authenticateUser 中间件三处实现不一致 | 3h | ✅ 已完成 | 2026-06-22 |
| `P0-03` | JWT 密钥 fallback 为弱明文字符串 | 0.5h | ✅ 已完成 | 2026-06-22 |
| `P0-04` | POST /api/user/register 完全公开无需授权 | 0.5h | ✅ 已完成 | 2026-06-22 |
| `P0-05` | seed.js 初始密码明文写入公开仓库 | 1h | ✅ 已完成 | 2026-06-22 |
| `P0-06` | record_code 双重生成逻辑导致幂等性失效 | 3h | ✅ 已完成 | 2026-06-23 |
| `P0-07` | 快速访问模式完全绕过后端认证 | 4h | ⬜ 待处理 | - |
| `P0-08` | Storage.js temp-token- 前缀可被客户端伪造 | 1h | ✅ 已完成 | 2026-06-23 |
| `P0-09` | auth.verify() 对编辑操作完全不做权限校验 | 3h | ⬜ 待处理 | - |
| `P0-10` | 根目录 package.json 缺少 type:module 及 Prisma 依赖 | 1h | ✅ 已完成 | 2026-06-23 |

> P1 / P2 / DOCS 各项详情见 `docs/fix/FIX_PLAN.md` 对应章节。<!-- END_OF_FILE | SHA: 8034b991 | SIZE: 42696 | UPDATED: 2026-06-22 -->
