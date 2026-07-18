# 开发文档（DEVELOPMENT GUIDE）

> 本文基于 **当前仓库实际代码** 编写（非历史记录）。旧版文档已统一归档至 [`docs/history/`](./history/)，仅作为参考，不再作为权威说明。
> 长期生效的项目操作规范见 [`docs/PROJECT_CONVENTIONS.md`](./PROJECT_CONVENTIONS.md)，任何修复 / 验证 / 清理工作都必须先遵守该文件（尤其是审计日志保留原则）。

---

## 1. 项目概览

田家炳食品检验系统（部署代号 `foodtestlab`）是一套面向学校 / 食安检测场景的**食品安全检测管理 Web 应用**：录入餐具洁净度、果蔬农残、食用油、肉蛋农残、病原体等检测记录，提供看板统计、导出、备份恢复、用户与权限管理、审计日志。

- 当前实际部署形态：**腾讯云 CVM（Ubuntu）+ Caddy 反向代理 + systemd 托管后端**，前端为静态 ES Module 资源。
- 数据库：**Prisma + PostgreSQL**（开发/测试/生产统一），落在独立数据盘 `/mnt/datadisk0`。
- **多学校架构（目标）**：单应用 + 单 PostgreSQL 实例 + **Schema-per-tenant（方案②）**——50+ 学校共用同一份数据模型，每校数据在独立 schema（`school_<code>`）；应用层经 `backend/lib/tenantClient.js` 的 `createTenantClient` 为每校缓存独立 `PrismaClient`（连接串带 `?schema=<schema>`）路由，而非 `SET search_path`（该方案已证伪废弃，见 §8）。开发/测试用共享 schema。
- 认证：**JWT（Bearer）**，后端统一签发与校验；JWT 中携带学校标识（`schoolCode`）用于租户路由。

> 命名已品牌中立化：根 `package.json` 的 `name` 为 `foodtestlab`，部署使用 `SYSTEM_NAME=foodtestlab`；学校名（珠海一中 / 田家炳中学 / 珠海实验中学等）均为 `School` 表数据，按 `schoolCode` 动态读取，代码层不出现学校专有命名。每校个性化（界面 / 内容 / 字段）由 `SchoolCustomization` 承载。

---

## 2. 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 后端 | Node.js 20（NVM 安装）、Express 4 | ESM（`"type": "module"`），入口 `backend/server.js` |
| ORM | Prisma 5 + **PostgreSQL** | `backend/prisma/schema.prisma`，`provider = postgresql`，`DATABASE_URL=postgresql://...` |
| 认证 | jsonwebtoken + bcryptjs | JWT Bearer，密钥来自 `JWT_SECRET` |
| 前端 | 原生 ES Module（浏览器直载，无打包器构建步骤） | `index.html` + `js/**/*.js` + `css/` + Tailwind（CDN class） |
| 前端数据层 | `StorageService` + `AdaptiveUploadQueue` | 离线优先（本地缓存+待办队列+多层去重+429/409 处理），见 §6.6/6.7 |
| 前端构建 | `scripts/build-static.js` | 仅复制 `index.html`/`login.html`/`css`/`js` 到 `dist/`（无转译/打包），由 Caddy 托管 |
| 部署 | Caddy（自动 HTTPS）+ systemd | `deploy/deploy.sh` + `deploy/deploy.foodtestlab.conf` |
| 测试 | Jest 29（babel-jest + jsdom）、Cypress 12 | 见 §10 |

---

## 3. 目录结构

```
Tianjiabing_foodtestlab/
├── backend/                      # 后端（Express + Prisma）
│   ├── server.js                 # 应用入口：路由、中间件、启动
│   ├── package.json              # 后端依赖与脚本（prisma db push / seed）
│   ├── prisma/
│   │   ├── schema.prisma         # 数据模型定义
│   │   └── seed.js               # 初始账号初始化（admin/operator/viewer）
│   ├── modules/
│   │   └── UserManager.js        # 用户 / 认证核心逻辑
│   ├── routes/
│   │   ├── userRoutes.js         # /api/user/* 用户与认证
│   │   ├── auditRoutes.js        # /api/audit-logs/*
│   │   └── syncRoutes.js         # /api/sync/*
│   ├── middleware/
│   │   ├── authMiddleware.js     # 统一认证 / 授权工厂
│   │   ├── validationMiddleware.js  # 限流 / 文本消毒
│   │   └── idempotencyMiddleware.js # 幂等（records API）
│   ├── config/  sql/             # 配置与 SQL 脚本（备用）
│   └── README.md
├── js/                           # 前端源码（ES Module）
│   ├── main.js                   # 入口：模块初始化、导航事件委托
│   ├── core/
│   │   ├── Router.js             # 路由 / 权限守卫（admin、guest 菜单）
│   │   ├── Auth.js               # OperationGuard 敏感操作二次确认
│   │   ├── Storage.js            # ★ StorageService：前端离线优先数据层（本地缓存+待办队列+去重，见 §6.6）
│   │   └── AdaptiveUploadQueue.js  # ★ 渐进式节流上传队列（429/409 处理+指纹去重，见 §6.7）
│   ├── modules/                  # 业务模块（9 个）
│   │   ├── Dashboard.js  Tableware.js  Pathogen.js  GenericTest.js
│   │   ├── UserManagement.js  AuditLog.js  BackupRestore.js
│   │   ├── GuestDashboard.js  FormBuilder.js
│   ├── services/                 # 前端服务层
│   │   ├── AuthService.js        # 用户登录 / 登出 / Token（实际被 login.html 使用）
│   │   ├── GuestAuthService.js   # 访客认证（快速访问 / 注册 / 导出申请）
│   │   └── PermissionService.js  SessionManager.js  ExportService.js  AuditLogService.js
│   └── utils/                    # 工具（活跃，详见 §9.8）
│       ├── 活跃：AuditLogger.js  NetworkHelper.js  FormValidator.js
│       │        Validator.js  pathogenRisk.js  UIHelper.js  UINotification.js  SampleDataGenerator.js
│       └── 遗留（仅剩）：ApiClient.js（并行旧客户端，与后端 /api/user/* 路径不符，见 TD-ApiClient）
│                （CacheManager/ConfigManager/UserAuth/IndexedDBManager/OfflineModeManager/PerformanceMonitor
│                 等历史遗留模块已于迁移清理中移出仓库，见 §9.8）
├── css/  index.html  login.html  # 前端入口页面
├── deploy/                       # 部署
│   ├── deploy.sh                 # 通用部署脚本（与具体系统解耦）
│   ├── deploy.foodtestlab.conf   # 田家炳 / 腾讯云适配文件（当前生效）
│   ├── deploy.adapter.example.conf  # 适配文件模板（多用户复制此文件）
│   ├── nginx/  pm2/              # 历史适配器（已弃用，保留参考）
│   └── README.md
├── docs/
│   ├── DEVELOPMENT_GUIDE.md      # 本文
│   ├── PROJECT_CONVENTIONS.md    # 长期操作规范（优先于一切）
│   └── history/                  # 旧版文档归档（仅供参考）
├── tests/  cypress/              # 测试（Jest 单元 / Cypress E2E）
├── jest.config.cjs  cypress.config.cjs
├── .env.example  package.json  (# 根：type:module，含测试/构建脚本)
└── scripts/build-static.js       # 前端静态构建
```

---

## 4. 后端架构

### 4.1 入口与启动

- 入口：`backend/server.js`（ESM）。
- 端口：`PORT`（默认 `3000`；部署脚本用 `API_PORT=3000`）。
- 静态托管开关：`SERVE_STATIC=true` 时后端用 `express.static` 托管仓库根目录；**生产部署由 Caddy 托管 `dist/`，后端保持 `SERVE_STATIC=false`（纯 API）**。
- 启动即校验 `JWT_SECRET`：缺失或命中弱密钥黑名单（`your-super-secret-jwt-key-...`、`food-lab-secret-key` 等）直接退出，防止误用默认密钥签发 JWT。
- CORS：由 `CORS_ORIGIN`（逗号分隔来源）与 `CORS_HOSTNAMES`（hostname[:port] 白名单）控制；`CORS_ORIGIN=*` 允许全部。未配置时回退到一组 localhost 来源。

### 4.2 数据模型（`backend/prisma/schema.prisma`）

| 模型 | 关键字段 | 说明 |
|------|----------|------|
| `User` | username*, password_hash, role, status, email? | 角色：admin / manager / operator / viewer / user |
| `AuditLog` | user_id, action, resource_type?, resource_id?, details?, ip_address? | 审计日志（**生产环境不得物理删除**，见 PROJECT_CONVENTIONS） |
| `TestRecord` | record_code*(唯一), test_type, test_name, sample_info(JSON), result_data(JSON), status, created_by, version | 检测记录主表 |
| `TestItem` | test_record_id, item_name, result? | 子项（级联删除） |
| `Attachment` | test_record_id?, file_name, file_path | 附件（删除时 SetNull） |
| `Guest` | username*, password_hash, guest_type, created_by, status | 访客（模型已定义，但后端未开放注册/登录路由，见 §9） |
| `Backup` | backup_name, backup_path*(唯一), record_count | 备份元数据 |
| `SystemLog` | level, message, context? | 系统日志 |

> 外键策略：`TestRecord.created_by` 用 `Restrict`（删用户不级联删记录）；`AuditLog.user_id` 用 `Cascade`。

### 4.3 检测记录类型

后端 `RECORD_ROUTE_TYPES` 定义 5 种类型，写入 `TestRecord.test_type`：

| 类型值 | 标签 | 前端模块 |
|--------|------|----------|
| `tableware` | 餐具洁净度检测 | `Tableware.js` |
| `pesticide` | 果蔬农残检测 | `GenericTest.js`（moduleName=pesticide） |
| `oil` | 食用油品质检测 | `GenericTest.js`（moduleName=oil） |
| `leanMeat` | 肉、蛋农残检测 | `GenericTest.js`（moduleName=leanMeat） |
| `pathogen` | 病原体检测 | `Pathogen.js` |

### 4.4 幂等记录写入

创建记录时由内容生成确定性 `record_code`：`RC-{type}-{sha256(tableName::规范化 payload)}`。相同内容重复提交会命中唯一约束，后端按幂等策略返回已有记录（避免重复）。`/api/records/:tableName` 与 `/api/test-records` 均应用此策略；`/api/records/:tableName/bulk-upsert` 支持批量（单次 ≤2000 条）。

### 4.5 初始账号（`backend/prisma/seed.js`）

- 必须在 `.env` 配置 `SEED_ADMIN_PASSWORD` / `SEED_OPERATOR_PASSWORD` / `SEED_VIEWER_PASSWORD`（缺失则 seed 拒绝运行）。
- 创建三个账号：**admin / operator / viewer**（账号已存在则跳过，不覆盖已改密码）。
- **生产环境默认跳过**：`NODE_ENV=production` 且未设 `SEED_ALLOW_PROD=true` 时直接退出，防止默认凭据泄露。
- 部署脚本首次部署且 `SEED_ON_FIRST_DEPLOY=true` 时自动执行。

### 4.6 认证中间件

`backend/middleware/authMiddleware.js` 提供工厂 `createAuthMiddleware(userManager)`，统一导出：

- `authenticateUser`：校验 `Authorization: Bearer <token>`，解码后挂 `req.user = { userId, username, email, role }`（同时兼容 `req.userId` / `req.userRole`）。
- `authorizeAdmin`：仅 admin。
- `authorizeRoles(...roles)`：多角色授权。

**所有受保护路由必须经由该中间件**，禁止在路由文件内重复实现认证逻辑。`server.js` 内还有 `requireEditorOrAbove`（非 guest / viewer 才允许写入）。

---

## 5. API 参考（实际实现）

> 基础路径：`/api`。所有受保护接口需在请求头带 `Authorization: Bearer <token>`。

### 5.1 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/api/health` | 健康检查（同上处理器） |

### 5.2 用户与认证（`/api/user`，定义在 `userRoutes.js`）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/user/register` | admin/manager | 注册用户 |
| POST | `/api/user/login` | 公开 | 登录，返回 `{ success, token, user, expiresIn }` |
| POST | `/api/user/verify-token` | 公开（带 token） | 校验令牌 |
| POST | `/api/user/refresh-token` | 登录用户 | 续期令牌 |
| GET | `/api/user/me` | 登录用户 | 当前用户信息 |
| PUT | `/api/user/me` | 登录用户 | 更新个人资料 |
| POST | `/api/user/change-password` | 登录用户 | 修改密码 |
| GET | `/api/user/list` | admin/manager | 用户列表 |
| POST | `/api/user/:userId/disable` | admin/manager | 禁用用户 |
| POST | `/api/user/:userId/enable` | admin/manager | 启用用户 |
| POST | `/api/user/:userId/role` | admin/manager | 改角色 |
| POST | `/api/user/:userId/reset-password` | admin/manager | 重置密码 |
| POST | `/api/user/reset-password/:userId` | admin/manager | 兼容历史路径 |
| PUT | `/api/user/:userId` | admin/manager | 管理员更新用户 |
| DELETE | `/api/user/:userId` | admin/manager | 删除用户（防删自己 / 防删最后一个 admin） |

> 服务器 `server.js` 另直接定义了 `/api/users`（GET 列表）与 `/api/users/:userId/disable|enable`（admin）——与 `userRoutes` 部分功能重复，属历史遗留（见 §9）。

### 5.3 访客（`/api/guest`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/guest/quick-access` | 免凭证签发只读限权 JWT（2h，`is_quick_access=true`） |
| POST | `/api/guest/register` | 访客自注册（落到对应租户 schema，TD-Guest 已实现） |
| POST | `/api/guest/login` | 访客登录（签发 guest 作用域 JWT） |
| POST | `/api/guest/verify-token` | 校验访客令牌 |
| POST | `/api/guest-export-request/submit` | 提交导出申请 |
| GET  | `/api/guest-export-request/my-requests` | 查看我的申请 |
| GET  | `/api/guest-export-request/check-permission` | 查看导出权限状态 |
| GET  | `/api/guest-export-request/admin/pending` | 管理端待审批列表（admin/manager） |
| POST | `/api/guest-export-request/admin/:id/approve` | 管理端批准（置 `has_export_permission=true`） |
| POST | `/api/guest-export-request/admin/:id/reject` | 管理端驳回 |

> 访客自助注册 / 登录 / 导出申请的后端路由**已于 TD-Guest 实现**（见 `guestRoutes.js`），前端 `GuestAuthService` 的调用均有对应实现，不再 404。仅「访客导出**审批端**」为后续迭代补齐（admin approve/reject，见 `guestRoutes.js` 的 `/admin/*`）。

### 5.4 审计日志（`/api/audit-logs`，`auditRoutes.js`）

通用操作审计接口（字段完整：user_id / action / resource_type / resource_id / details / ip_address）。前端通过 `AuditLogService` 写入。

### 5.5 同步（`/api/sync`，`syncRoutes.js`）

离线 / 多端数据同步接口（批量上行、拉取变更等）。

### 5.6 检测记录

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/test-records` | 登录 | 记录列表（分页 / test_type / status 过滤） |
| POST | `/api/test-records` | 编辑者↑ | 创建记录（幂等） |
| GET | `/api/test-records/:id` | 登录 | 单条记录（含 test_items / attachments / created_user） |
| PUT | `/api/test-records/:id` | 编辑者↑ | 更新（test_name / status / result_data） |
| DELETE | `/api/test-records/:id` | 编辑者↑ | 删除 |
| GET | `/api/records/:tableName` | 登录 | 按类型取记录（旧版兼容） |
| POST | `/api/records/:tableName` | 编辑者↑ | 按类型创建（字段校验 + 幂等 + 审计） |
| POST | `/api/records/:tableName/bulk-upsert` | 编辑者↑ | 批量导入（≤2000） |
| GET/PUT/DELETE | `/api/records/:tableName/:id` | 登录 / 编辑者↑ | 单条查 / 改 / 删 |

> `:tableName` 必须是 `RECORD_ROUTE_TYPES` 之一，否则 400/404。`requireEditorOrAbove` 拦截 guest / viewer 的写入。

---

## 6. 前端架构

### 6.1 页面与入口

- `login.html`：登录页，使用 `AuthService` 调用 `/api/user/login`。
- `index.html`：主应用；侧边栏导航按钮用 `data-target` 标识目标区块（`dashboard`、`tableware-test`、`pesticide-test`、`oil-test`、`lean-meat-test`、`pathogen-test`、`export-data`、`backup-restore`、`user-management`、`audit-log`）；其中 `data-admin-only` 仅管理员可见。
- `js/main.js`：作为 `<script type="module">` 加载，是前端初始化总入口。

### 6.2 初始化流程（`js/main.js` → `DOMContentLoaded`）

1. 读取快速访问模式（`?quickAccess=true` 或 localStorage）→ 必要时 `guestAuthService.quickAccessAsViewer()` 向后端取只读 JWT。
2. `router.init()` + `router.setupAll()`：路由与权限守卫、登出按钮、用户信息、菜单按权限显隐、Token 定时校验、30 分钟空闲登出。
3. `UIHelper.setupNavigation()`：侧边栏点击切换（事件委托）。
4. 依次初始化业务模块（仅在非快速访问模式下初始化导出 / 备份 / 用户管理 / 审计日志等写操作模块）。
5. 根据角色决定是否初始化 `UserManagement`（admin/manager）与 `AuditLog`（admin）。
6. 访客登录态下初始化 `GuestDashboard`，隐藏管理员仪表板与菜单。

### 6.3 导航通信模式（重要）

前端已**移除 `window.*` 全局耦合**，统一改用事件委托 + `CustomEvent`：

- 侧边栏点击 → `nav` 上的事件委托监听器 → `handleNavigation(target)`（模块内函数）。
- 模块内动态生成的导航按钮 → `document.dispatchEvent(new CustomEvent('app:navigate', { detail: { target } }))` → main.js 监听后调用 `handleNavigation`。
- 看板刷新 → `document.dispatchEvent(new CustomEvent('dashboard:refresh'))`。
- 不再使用 `window.handleNavigation` / `window.userMgmt` / `window.renderQuickAccessData` 等全局挂接（历史修复 P2-10 阶段 B 已清理）。

### 6.4 服务层与模块

- **AuthService**（单例 `authService`）：用户登录 / 登出 / Token 管理 / 改密码 / 用户管理。实际被 `login.html` 与 `Router` 使用；API base 由 `getApiBaseUrl()` 决定（开发环境 `http://localhost:3002`，生产同源 `''`）。
- **GuestAuthService**（单例）：访客认证，含 `quickAccessAsViewer()`（唯一可用的后端调用）。
- **PermissionService**：角色 / 权限判定（`hasRole` / `hasPermission`）。
- **SessionManager**：会话生命周期（30 分钟超时、最多 5 并发；后端无 session API，`syncToBackend` 为占位 TODO）。
- **业务模块**：`Dashboard` / `Tableware` / `Pathogen` / `GenericTest`（pesticide/oil/leanMeat 复用）/ `UserManagement` / `AuditLog` / `BackupRestore` / `GuestDashboard` / `FormBuilder`。

### 6.5 API 基础地址

- 前端无统一 base 常量注入；各 Service 默认 `apiBaseUrl=''`（同源）。
- `AuthService.getApiBaseUrl()`：开发环境（`localhost`/`127.0.0.1`）返回 `http://localhost:3002`，生产返回 `''`（同源，由 Caddy 反代 `/api`）。
- 可通过全局 `window.__API_BASE_URL` 覆盖（调试用）。
- `js/utils/ApiClient.js` 另有通用客户端 `apiClient`（默认 `/api`），但其方法路径（`/auth/*`）与后端实际 `/api/user/*` 不一致，属遗留并行客户端（见 §9.8），**登录流程以 `AuthService` 为准**。

### 6.6 前端数据层：StorageService（`js/core/Storage.js`，核心）

**这是前端最核心的数据访问层**，所有检测记录模块（`Tableware` / `Pathogen` / `GenericTest`(pesticide/oil/leanMeat) / `Dashboard` / `ExportService`）都通过 `new StorageService('<tableName>')` 读写数据，实现「**离线优先 + 最终一致**」：

- **对外 API**：`getAll()`（同步返回本地缓存，同时后台异步拉取刷新）、`getAllFresh()`（强制拉云端后返回）、`save(data)`、`update(id, data)`、`delete(id)`、`on('sync'|'error', cb)`。
- **本地存储键**（按 table 隔离）：
  - `cache_<table>`：本地缓存记录（`{ data: [...] }`）；
  - `pending_<table>`：待同步请求队列（create / update / delete / update_temp）；
  - `fingerprint_index_<table>`：云端记录内容指纹索引（用于去重，持久化）。
- **乐观写入**：`save()` 立即生成 `temp_<uuid>` 临时 ID 写入本地缓存（`_status: 'pending'`）并入队，UI 无需等待网络；服务端返回真实 ID 后用 `_replaceTempIdInCache()` 回填。
- **端点**：默认 `apiBaseUrl='/api/records'`，实际请求 `/api/records/<table>`（对应后端 `RECORD_ROUTE_TYPES`）。
- **同步合并策略**（`_syncFromApi`）：本地 `temp_`/`pending`/`updating` 记录优先保留，其余以服务端为准，按 ID 降序合并；默认冷却 `syncCooldownMs=30s`（`force=true` 可绕过）。
- **多层去重**（防重复落库，配合后端幂等 `record_code`）：
  1. **本地去重**：入队前用内容指纹 `_buildFingerprint()`（剥离 `VOLATILE_FIELDS` 后归一化）比对本地缓存，命中则跳过；
  2. **云端去重**：`_handleCreate` 上传前查 `fingerprint_index`，未命中则强制拉云端再比对；
  3. **队列去重**：`AdaptiveUploadQueue` 内再做一层指纹去重（见 §6.7）。
- **敏感字段过滤**：`_sanitizePayload()` 会剥离 `SERVER_META_FIELDS`（`record_code` / `test_type` / `created_at` 等服务端字段），避免前端污染。
- **重试与退避**：写请求失败按 HTTP 状态分类——`429` 触发**全局退避**（跨所有 table 的 `app_sync_backoff_until` 键）；`409` 版本冲突拉取最新 `version` 后重试（≤2 次）；4xx（非 429/409）不重试直接标记失败；其余指数退避（≤3 次）。
- **事件**：通过 `on('sync', cb)` / `on('error', cb)` 通知模块刷新 UI / 提示错误。

> ⚠️ 注意区分：`js/core/Storage.js` 是**数据同步层**（不是简单的 localStorage 封装）。原 `js/utils/CacheManager.js` 等通用 KV 缓存遗留模块已从仓库移除，请勿再依赖。

### 6.7 上传队列：AdaptiveUploadQueue（`js/core/AdaptiveUploadQueue.js`）

`StorageService` 内部持有一个 `AdaptiveUploadQueue` 实例，负责把写请求「渐进式节流」发往后端：

- **自适应节流**：初始间隔 800ms，连续成功 8 次后加速（×0.85，下限 400ms）；遇 `429` 减速（×2，上限 15s）并按 `Retry-After` 暂停。
- **幂等**：每个请求带 `Idempotency-Key` 请求头（与后端 `idempotencyMiddleware` 配合）。
- **URL 前缀**：通过 `getBaseUrl` 回调跟随 `StorageService.apiBaseUrl`（P1-24），不再硬编码。
- **内容指纹去重**：`_completedFingerprints` 带 TTL（默认 60s）批量过期清理（P1-19），避免短时间重复提交。
- **冲突恢复**：`409` 时自动 `_fetchLatest()` 拿最新 `version` 合并后重排队。
- **进度回调**：`onProgress` 上报队列状态（total / completed / skipped / pending / percent / isPaused），`StorageService` 据此设置全局退避并 emit `queue_progress`。

---

## 7. 数据库与本地开发

### 7.1 依赖与迁移

```bash
cd backend
npm install
npx prisma generate
npx prisma db push          # 同步 schema 到 PostgreSQL（生产加 --accept-data-loss 需谨慎）
node prisma/seed.js         # 初始化账号（需 SEED_*_PASSWORD）
```

### 7.2 环境变量（后端 `.env`）

部署脚本会自动生成 `backend/.env`。手工开发可参考 `.env.example`（注意其中 Windows 路径 `D:/...` 与部分字段为旧示例，正式以部署脚本生成为准）。关键变量：

| 变量 | 说明 |
|------|------|
| `NODE_ENV` | development / production |
| `PORT` | 后端内部端口（默认 3000） |
| `SERVE_STATIC` | 是否后端托管静态资源（生产 false） |
| `DATABASE_URL` | `postgresql://<user>:<pass>@<host>:<port>/<db>`（PostgreSQL，schema-per-tenant） |
| `JWT_SECRET` | 强随机密钥（不可为弱密钥黑名单） |
| `JWT_EXPIRE` | 令牌有效期（默认 7d） |
| `CORS_ORIGIN` | 逗号分隔允许来源；`*` 全开 |
| `CORS_HOSTNAMES` | hostname[:port] 白名单 |
| `SEED_ADMIN_PASSWORD` / `SEED_OPERATOR_PASSWORD` / `SEED_VIEWER_PASSWORD` | seed 初始密码 |
| `SEED_ALLOW_PROD` | 生产环境允许 seed（默认 false） |
| `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` | 登录限流（默认 10 / 15 分钟） |
| `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS` | 全局限流（默认 1000 / 60s） |

---

## 8. 部署（腾讯云 CVM + Caddy + systemd）

> 当前生效方案：`deploy/deploy.sh` + `deploy/deploy.foodtestlab.conf`（Caddy 自动 HTTPS + systemd）。`deploy/nginx`、`deploy/pm2` 为历史适配器，已弃用。

### 8.1 原理

- 脚本只负责"流程"，所有环境差异在**适配文件（`.conf`）**里。
- **多学校（目标架构 = 方案② Schema-per-tenant）**：单套应用 + 单 PostgreSQL 实例，每校一个独立 schema（表结构一致）。新增学校 = 建 schema + 跑迁移，不新增服务/端口/物理隔离部署。
- 开发/测试环境使用单一共享 schema（无隔离）；生产启用 schema-per-tenant。三者均运行在 PostgreSQL 上，保证环境一致、可统一部署。
- 原"每校一套适配文件 + 独立端口/服务"的物理隔离方案已弃用：在 2vCPU/3.5GiB 上，方案③（每校独立 database）会因连接数随学校线性增长（每条 PG 连接常驻 5–10MB 进程开销）在 20–30 校时撞资源墙；方案②共享连接池（10–20 条）规避此问题。

### 8.2 适配文件关键项（`deploy.foodtestlab.conf`）

| 项 | 当前值 | 说明 |
|----|--------|------|
| `SYSTEM_NAME` | `foodtestlab` | 系统标识，决定目录 / 服务名 |
| `REPO_URL` / `DEPLOY_BRANCH` | GitHub 仓库 / `main` | 代码来源 |
| `REPO_ROOT` | `/opt/foodtestlab` | 代码（系统盘） |
| `DATA_DIR` | `/mnt/datadisk0/foodtestlab/data` | 数据库（数据盘，与系统盘解耦） |
| `API_PORT` / `FRONTEND_PORT` | 3000 / 8080 | 后端端口 / 公网前端端口（须全服务器唯一） |
| `DOMAIN` / `TLS_EMAIL` | 空 | 暂按端口区分；补域名后自动切 HTTPS |
| `CORS_ORIGIN` | 空 | 脚本自动取公网 IP 生成 `http://<IP>:<FRONTEND_PORT>` |
| `JWT_SECRET` / `SEED_*_PASSWORD` | 空 | 脚本自动生成强随机值 |
| `REQUIRED_MOUNT` | `/mnt/datadisk0` | 数据盘未挂载则中止，防静默写回系统盘 |
| `NODE_VERSION` / `ENABLE_SWAP` | 20 / true（2G swap） | 低内存机防 OOM |

### 8.3 执行

```bash
# 前置：腾讯云安全组放行 TCP 22 与本次 FRONTEND_PORT（脚本不配置安全组）
sudo bash deploy.sh deploy.foodtestlab.conf
```

脚本流程：校验 → 装运行时（git/Caddy/Node via NVM）→ 建系统用户与目录 → 克隆代码 → 生成 `.env` → 后端依赖 / `prisma generate` / `db push` / seed → 前端构建（`scripts/build-static.js` → `dist/`）→ 写 systemd 单元 → 写 Caddy 站点片段（端口冲突预检）→ 健康检查 → 报告初始账号密码。

### 8.4 运行与运维

```bash
systemctl status foodtestlab-api     # 后端状态
journalctl -u foodtestlab-api -f     # 后端日志
systemctl status caddy               # 反代状态
curl http://127.0.0.1:3000/api/health  # 健康检查
```

Caddy 主配置 `/etc/caddy/Caddyfile` 通过 `import /etc/caddy/sites/*.caddy` 聚合各用户站点；新增用户只需新增一份 `*.caddy` 片段，不覆盖既有用户。

---

## 9. 已知偏差 / 技术债（重要）

以下内容为**前端与后端当前实际不一致或历史遗留**，改动前请先阅读并在必要时按 PROJECT_CONVENTIONS 的「方法偏离预先报备」原则说明：

1. ~~**访客自助路由缺失**~~ **（已解决，2026-07，TD-Guest）**：`guestRoutes.js` 已实现 `register`/`login`/`verify-token` 及 `guest-export-request/{submit,my-requests,check-permission}`，前端 `GuestAuthService` 调用均有对应实现，不再 404。仅「导出审批端」为后续补齐（见 `guestRoutes.js` `/admin/*`，已在 2026-07-18 实现 list-pending/approve/reject）。

2. ~~**AuthService 与后端路由细微不一致**~~ **（已解决，2026-07，`ef4394b` 清理 TD-Naming/Auth-Path）**：改密码、校验令牌、登出前后端现已一致——均为 `POST /api/user/{change-password,verify-token,logout}`。

3. **遗留并行 API 客户端**：`js/utils/ApiClient.js` 的 `apiClient` 方法路径为 `/auth/*`（如 `/auth/login`），与后端 `/api/user/*` 不符；该客户端并非登录流程所用（登录走 `AuthService`），属历史遗留，新代码不应依赖它。

4. **用户管理路由重复**：`server.js` 直接定义了 `/api/users`（列表）与 `/api/users/:userId/disable|enable`，与 `userRoutes.js` 中的 `/api/user/list`、`/:userId/disable|enable` 功能重复。（遗留，若触碰可合并，否则不影响功能。）

5. ~~**审计日志三套并存**~~ **（已收敛，2026-07，TD-P2-13）**：新增 `backend/lib/auditLog.js` 门面（`writeTenantAuditLog`/`writeSystemLog`），`auditRoutes`/`UserManager`/`server.writeRecordAuditLog` 全部经门面落库；违规的 `DELETE /api/audit-logs/cleanup` 端点已移除（对齐"审计日志禁止删除"红线）。前端离线日志仍由 `AuditLogger` 双写 `localStorage`，属离线兜底、不进库。

6. ~~**SessionManager 后端 API 未实现**~~ **（已落地，2026-07，TD-Session）**：`sessionRoutes.js` 提供 `POST/GET /api/session`、`DELETE /api/session/:id|others`、`POST /api/session/event`；`SessionManager.syncToBackend`/`syncSessions`/`recordSessionEvent` 均已调用后端（消除 TODO 占位）。

7. **命名已中立化**：`package.json` 的 `name` 为 `foodtestlab`；`engines.node` 写的是 `>=14.0.0`，而部署脚本实际用 `NODE_VERSION=20`（待统一）；`.env.example` 含 Windows 路径与旧字段，仅供格式参考，实际以部署脚本生成 `.env` 为准。根 `package.json` 同时列出了后端运行依赖（express / jsonwebtoken 等），而后端另有独立 `backend/package.json`，以后端目录的为准。

8. **多租户架构已定稿为方案②（Schema-per-tenant）**：原"每校物理隔离部署"描述已废弃。50+ 学校共用单应用与单 PostgreSQL 实例，每校独立 schema、表结构统一。

   > ⚠️ **方案反转（2026-07）**：早先的"单一 PrismaClient + 请求级 `SET search_path` + 事务包裹"方案**已被证伪并废弃**。原因：Prisma 生成 SQL 把表名固定为 datasource schema（`FROM "public"."User"`），`SET search_path` 对 model 查询**完全无效**（仅对裸 `$queryRaw` 生效），会导致所有租户查询回落 `public`、跨校串数据。权威规范见 [`PROJECT_CONVENTIONS.md` 规则三](./PROJECT_CONVENTIONS.md)。

   **现方案 = per-schema 专属 `PrismaClient`**，抽象集中在 `backend/lib/tenantClient.js`：
   - `createTenantClient(prisma, schoolCode)` 为每个 `school_<code>` 缓存一个**带 `?schema=school_<code>` 连接串**的 `PrismaClient`（LRU 上限 `MAX_TENANT_CLIENTS=25`、每客户端 `TENANT_CONNECTION_LIMIT=3`，进程退出经 `disconnectAllTenantClients()` 优雅关闭）。`schoolCode` 为空 / 落到 `public` 时返回基础单例。
   - 真实 schema 名 = `school_<code>`（非 `schoolCode` 本身）：`schemaNameOf(code)` 归一（strip 前导 `school-`/`school_` 再补 `school_` 前缀，幂等；`tianjiabing`→`school_tianjiabing`、`school-a`→`school_a`）；`resolveSchemaName(code)` 是推导入口，为空回落 `public`。
   - 系统表 `School`/`SchoolCustomization` 恒在 `public`，由基础 prisma 单例显式 `public.` 前缀访问（如 `prisma.school.findUnique` 即落在 `public`）。
   - 业务 handler **统一通过 `req.db.<model>.<method>()` 访问**（`req.db` 即 `createTenantClient` 返回的租户客户端）；严禁手写 `SET search_path` 或直接用基础 `prisma.<model>` 做租户查询。

8. **孤儿 / 未被引用的前端工具模块**（经全量 `import` 核查）：`CacheManager`/`ConfigManager`/`UserAuth`（ESM 但无人 import）、`IndexedDBManager`/`OfflineModeManager`/`PerformanceMonitor`（CommonJS，无法被 ESM import）等历史遗留模块**已于迁移清理中移出仓库**（见 `TD-Orphan`）。当前活跃工具：`AuditLogger`、`NetworkHelper`、`FormValidator`、`PermissionService`、`AuditLogService`、`ExportService`、`SessionManager`、`SampleDataGenerator`、`Validator`、`pathogenRisk`、`UIHelper`、`UINotification`。

9. **后端遗留产物**：`backend/sql/*.sql`、`backend/config/telemetry.js` 等未启用产物**已于迁移清理中移出仓库**（见 `TD-Backend-Orphan`）。运行时数据访问以 Prisma schema + 每校迁移为准。

---

## 10. 测试

### 10.1 单元测试（Jest）

- 配置：`jest.config.cjs`（项目为 ESM，故用 `.cjs` 后缀 + `babel-jest` + `.babelrc` 的 `env.test` 预设转译；`testEnvironment: jsdom`）。
- 用例匹配：`tests/**/*.test.js`。
- 现有冒烟用例：`tests/smoke.test.js`，覆盖 `js/utils/Validator.js`（`Validator` / `validator`）与 `js/utils/pathogenRisk.js`（`isPositiveResult` / `calculatePathogenRisk`）。
- 运行：

```bash
npm install        # 首次需安装依赖（含 jest-environment-jsdom）
npm test           # jest --coverage
npx jest tests/smoke.test.js
```

### 10.2 E2E（Cypress）

- 配置：`cypress.config.cjs`（`.cjs` 后缀；`baseUrl: http://localhost:8080`，与部署 `FRONTEND_PORT` 一致；`supportFile:false` 最小骨架）。
- 用例：`cypress/e2e/**/*.cy.js`，现有 `cypress/e2e/smoke.cy.js`（访问 `/login.html`、校验密码输入框、请求 `/index.html` 返回 200）。
- 本地调试：用静态服务器托管仓库根目录（如 `npx http-server -p 8080`）后运行：

```bash
npx cypress run            # 或 npm run test:e2e
npx cypress open           # 交互式
```

---

## 11. 日常开发约定速查

- **新增受保护接口**：在对应 `routes/*.js` 用 `createAuthMiddleware(userManager)` 导出的 `authenticateUser` / `authorizeRoles` 守卫；不要在 `server.js` 内联认证逻辑。
- **新增前端导航**：在 `index.html` 用 `data-target` 加按钮，由 main.js 事件委托处理；模块内跳转用 `dispatchEvent(new CustomEvent('app:navigate', { detail:{ target } }))`。**禁止重新挂载 `window.*` 全局函数**。
- **审计日志**：业务写入操作通过 `AuditLogService` → `/api/audit-logs`；生产环境审计记录**不得物理删除**（PROJECT_CONVENTIONS 规则一）。
- **数据盘**：生产数据库必须落在 `/mnt/datadisk0` 且写入 `/etc/fstab`，否则部署脚本中止。
- **多用户部署**：复制 `deploy.adapter.example.conf` 为新适配文件，换 `SYSTEM_NAME` / `FRONTEND_PORT` / `API_PORT`，重跑 `deploy.sh`，不动他人站点片段。

---

## 12. 相关文档

- 系统总览（项目入口）：[`README.md`（根）](../README.md)
- 文档中心（docs 索引）：[`docs/README.md`](./README.md)
- 长期规范（最高优先）：[`docs/PROJECT_CONVENTIONS.md`](./PROJECT_CONVENTIONS.md)
- 历史归档（仅供参考，非权威）：[`docs/history/`](./history/)
- 部署说明：[`deploy/README.md`](../deploy/README.md)
- 后端说明：[`backend/README.md`](../backend/README.md)
