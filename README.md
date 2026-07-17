# 食品检验系统（foodtestlab）

> 本 README 基于**当前仓库实际代码**编写，是项目的系统级总览文档。
> 深入的开发细节见 [`docs/DEVELOPMENT_GUIDE.md`](./docs/DEVELOPMENT_GUIDE.md)；长期操作规范见 [`docs/PROJECT_CONVENTIONS.md`](./docs/PROJECT_CONVENTIONS.md)（优先级最高）；历史文档归档于 [`docs/history/`](./docs/history/)。

---

## 目录

1. [系统概述](#1-系统概述)
2. [技术栈总览](#2-技术栈总览)
3. [系统架构图](#3-系统架构图)
4. [数据库设计](#4-数据库设计)
5. [API 接口文档](#5-api-接口文档)
6. [前端模块设计](#6-前端模块设计)
7. [认证与权限设计](#7-认证与权限设计)
8. [部署架构](#8-部署架构)
9. [安全设计](#9-安全设计)
10. [已知技术债务与待办](#10-已知技术债务与待办)
11. [开发环境搭建指南](#11-开发环境搭建指南)
12. [运维手册](#12-运维手册)

---

## 1. 系统概述

### 业务定位

面向学校 / 食安检测场景的**食品安全检测管理 Web 应用**，用于录入、统计、导出五类检测记录，并提供备份恢复、用户与权限管理、审计日志能力。五类检测：

| 类型值 | 业务含义 |
|--------|----------|
| `tableware` | 餐具洁净度检测（ATP） |
| `pesticide` | 果蔬农残检测 |
| `oil` | 食用油品质检测 |
| `leanMeat` | 肉、蛋农残检测 |
| `pathogen` | 病原体检测 |

### 目标用户

- **管理员 / 管理者（admin / manager）**：用户与权限管理、审计日志、全部业务操作。
- **检测员（operator / user）**：录入与维护检测记录。
- **只读用户（viewer）/ 访客（快速访问）**：仅查看看板与记录，无写入权限。

### 部署形态

- **腾讯云 CVM（Ubuntu 22.04+）** 单机部署；**Caddy** 反向代理（对外）+ **systemd** 托管 Node 后端（仅监听 `127.0.0.1`）。
- 数据库为 **PostgreSQL**，落在独立数据盘 `/mnt/datadisk0`（与系统盘生命周期解耦）。开发/测试/生产**统一使用 PostgreSQL**，仅在 schema 隔离策略上不同（dev/test 共享 schema，prod 每校一 schema）。
- 前端为**原生 ES Module 静态资源**（无打包器），由 Caddy 直接托管 `dist/`。
- **多学校架构（方案② Schema-per-tenant）**：50+ 学校共用同一套应用与同一份数据模型，每校数据存放在 PostgreSQL 的**独立 schema**（表结构一致）；应用层按当前登录学校经 `?schema=` 连接串路由（`backend/lib/tenantClient.js` 的 `createTenantClient` 为每校缓存独立 PrismaClient）。开发/测试环境使用单一共享 schema，不做隔离。

> 命名已品牌中立化：根 `package.json` 的 `name` 为 `foodtestlab`，部署统一使用 `SYSTEM_NAME=foodtestlab`；具体学校名（如珠海一中 / 田家炳中学 / 珠海实验中学）均为 `School` 表中的数据，由登录时按 `schoolCode` 动态读取，代码层不出现任何学校专有命名。每校的界面 / 显示内容 / 字段要求的差异，统一由 `public` 系统表中的 `SchoolCustomization` 承载（外观 `theme_color`/`logo_url`/`theme_config`、可见检测类型 `visible_types`、字段标签 `field_labels`、隐藏字段 `hidden_fields`、字段必填/校验规则 `field_rules`），新增学校零改码。

---

## 2. 技术栈总览

| 层 | 技术 | 说明 |
|----|------|------|
| 后端运行时 | Node.js 20（NVM）、Express 4 | ESM（`"type":"module"`），入口 `backend/server.js` |
| ORM / 数据库 | Prisma 5 + **PostgreSQL** | `backend/prisma/schema.prisma`，`provider = postgresql`，`DATABASE_URL=postgresql://...` |
| 认证 | jsonwebtoken 9 + bcryptjs 2 | 无状态 JWT（Bearer），bcrypt 密码哈希 |
| 前端 | 原生 ES Module + Tailwind(CDN) | `index.html`/`login.html` + `js/**/*.js`，浏览器直载 |
| 前端数据层 | `StorageService` + `AdaptiveUploadQueue` | 离线优先：本地缓存 + 待办队列 + 多层去重 + 429/409 处理 |
| 前端构建 | `scripts/build-static.js` | 仅复制静态资源到 `dist/`（无转译/打包） |
| 反向代理 | Caddy 2 | 自动 HTTPS（有域名时）、同域反代 `/api`、静态托管 |
| 进程管理 | systemd | `MemoryMax` 内存上限、崩溃自动重启 |
| 测试 | Jest 29（babel-jest + jsdom）、Cypress 12 | 冒烟骨架，`.cjs` 配置 |

---

## 3. 系统架构图

### 3.1 部署拓扑

```mermaid
flowchart TB
    subgraph Client[浏览器]
        UI[静态前端 ES Module<br/>index.html / js/**]
    end

    subgraph CVM[腾讯云 CVM · Ubuntu]
        subgraph Caddy[Caddy :FRONTEND_PORT / :443]
            Static[静态托管 dist/]
            Proxy[reverse_proxy /api/* + /health]
        end
        subgraph Node[systemd: foodtestlab-api]
            API[Express :3000<br/>仅 127.0.0.1]
        end
        DB[(PostgreSQL 单实例<br/>/mnt/datadisk0/.../foodtestlab)]
    end

    UI -->|HTTP/HTTPS| Caddy
    Static --> UI
    Proxy -->|127.0.0.1:3000| API
    API -->|Prisma| DB
```

### 3.2 请求分层

```mermaid
flowchart LR
    B[浏览器] --> C{Caddy}
    C -->|/api/*、/health| N[Express 后端]
    C -->|其他路径| S[dist/ 静态文件<br/>try_files → index.html]
    N --> P[Prisma Client]
    P --> Q[(PostgreSQL)]
```

### 3.3 多学校隔离（单应用 + PostgreSQL Schema-per-tenant）

```mermaid
flowchart TB
    Caddy[Caddy 反代 :FRONTEND_PORT]
    API[systemd: foodtestlab-api<br/>单应用 + 每校缓存独立 PrismaClient]
    PG[(PostgreSQL 单实例)]
    subgraph Schemas[schema-per-tenant]
        S1[schema: school_tianjiabing]
        S2[schema: school_gtest]
        Sn[schema: school_n ...]
    end
    Caddy --> API --> PG
    PG --> Schemas
    API -.按 schoolCode 经 ?schema= 连接串路由.-> Schemas
```

> 「多学校」= **单套应用 + 单 PostgreSQL 实例 + 每校独立 schema**（非物理分部署，也非单表 `school_id` 混放）。表结构全校一致；`backend/lib/tenantClient.js` 的 `createTenantClient(prisma, schoolCode)` 为**每个 schema 缓存一个独立 `new PrismaClient`**（连接串带 `?schema=<schema>`，LRU 缓存 + 每客户端连接上限），把 Prisma 的 model 查询硬绑定到对应 schema——这是 Prisma 官方推荐的 schema 隔离方式（schema 名编译进 SQL，非运行时 search_path）。`schoolCode` 经 `schemaNameOf()` 归一为 `school_<code>`（`school-` 前缀归一为 `school_` 下划线）；`isValidSchoolCode` 仅允许 `[a-z0-9-]`（不含下划线，学校代码用连字符，如 `school-gtest`）。开发/测试环境用单一共享 schema。
>
> ⚠️ **历史文档曾描述「请求级 `SET search_path` 路由 + Proxy」方案，已证伪并废弃**：Prisma 把 schema 名硬编码进生成的 SQL，`SET LOCAL search_path` 对 model 查询无效（仅裸 `$queryRaw` 生效，如 `provisionSchool` 建初始 admin 时）。**切勿重新引入 search_path / Proxy 方案。**

---

## 4. 数据库设计

数据源：`backend/prisma/schema.prisma`（`provider = postgresql`）。开发/测试/生产**统一使用 PostgreSQL**。所有主键为 `cuid()` 字符串。PostgreSQL 原生支持 JSON/JSONB 列（可用 `Json` 类型），但当前模型仍以字符串存储 JSON 以保持兼容。

#### 多学校隔离（Schema-per-tenant）

- 每校对应 PostgreSQL 中一个独立 schema（schema 名由 `schemaNameOf(schoolCode)` 归一为 `school_<code>`，如 `school-gtest` → `school_gtest`），**所有 schema 的表结构与迁移完全一致**（同一份 Prisma schema）。
- 隔离由 `backend/lib/tenantClient.js` 的 `createTenantClient(prisma, schoolCode)` 实现：为每个 schema 缓存一个独立 `new PrismaClient`（连接串带 `?schema=<schema>`），Prisma 据此把 model 查询限定到该 schema。租户中间件在 `authenticateUser` 后挂 `req.db`（即当前校的 tenant client）。新增模型只需 `prisma db push` 推一次，新学校自动包含全部模型。
- 备份/恢复/迁移按校独立：`pg_dump -n school_gtest mydb` 单独导出，`psql -d mydb -f school_gtest.sql` 单独恢复；迁校即导出该 schema 在目标库 `CREATE SCHEMA` 后恢复。
- 新增学校：`tenantProvisioner.provisionSchool({ code })` 用 `prisma db push ?schema=<租户>` 推全表并建初始 admin（连字符代码，如 `school-gtest`）。
- 开发/测试：使用单一共享 schema（如 `public` 或 `dev`），无需逐校隔离。

### 4.1 ER 图

```mermaid
erDiagram
    User ||--o{ AuditLog : "user_id (Cascade)"
    User ||--o{ TestRecord : "created_by (Restrict)"
    User ||--o{ Guest : "created_by (Restrict)"
    User ||--o{ Backup : "created_by (SetNull)"
    User ||--o{ Session : "user_id (Cascade)"
    Guest ||--o{ GuestExportRequest : "guest_id (Cascade)"
    TestRecord ||--o{ TestItem : "test_record_id (Cascade)"
    TestRecord ||--o{ Attachment : "test_record_id (SetNull)"

    User {
        string id PK
        string username UK
        string email UK "nullable"
        string password_hash
        string full_name "nullable"
        string phone "nullable"
        string role "default user"
        string status "default active"
        datetime last_login "nullable"
    }
    AuditLog {
        string id PK
        string user_id FK
        string action
        string resource_type "nullable"
        string resource_id "nullable"
        string details "JSON, nullable"
        string ip_address "nullable"
        datetime created_at
    }
    TestRecord {
        string id PK
        string record_code UK
        string test_type
        string test_name
        string sample_info "JSON, nullable"
        string result_data "JSON, nullable"
        string status "default pending"
        string created_by FK
        int version "default 0"
        datetime completed_at "nullable"
    }
    TestItem {
        string id PK
        string test_record_id FK
        string item_name
        string item_code "nullable"
        string result "nullable"
        string notes "nullable"
    }
    Attachment {
        string id PK
        string test_record_id FK "nullable"
        string file_name
        string file_path
        int file_size "nullable"
        string file_type "nullable"
    }
    Guest {
        string id PK
        string username UK
        string password_hash
        string email "nullable"
        string full_name "nullable"
        string created_by FK "nullable"
        string guest_type "default viewer"
        string has_export_permission "default false"
        string valid_until "DateTime, nullable"
        string status "default active"
        datetime created_at
        datetime updated_at
    }
    GuestExportRequest {
        string id PK
        string guest_id FK
        string request_type
        string request_reason "nullable"
        string request_data "JSON string, nullable"
        string status "default pending"
        string reviewed_by "nullable"
        datetime reviewed_at "nullable"
        datetime created_at
        datetime updated_at
    }
    Session {
        string id PK
        string user_id FK
        string session_token "nullable"
        string device_type "nullable"
        string browser "nullable"
        string user_agent "nullable"
        string ip_address "nullable"
        string status "active/revoked"
        datetime login_at
        datetime last_seen_at
        datetime created_at
    }
    Backup {
        string id PK
        string backup_name
        string backup_path UK
        int record_count "default 0"
        string created_by FK "nullable"
    }
    SystemLog {
        string id PK
        string level
        string message
        string context "JSON, nullable"
        datetime created_at
    }
```

### 4.2 关键表结构与索引

| 模型 | 唯一约束 | 索引（`@@index`） | 外键与删除策略 |
|------|----------|-------------------|----------------|
| `User` | `username`、`email` | — | — |
| `AuditLog` | — | `user_id`、`created_at` | `user_id → User`（**Cascade**） |
| `TestRecord` | `record_code` | `test_type`、`status`、`created_by`、`created_at` | `created_by → User`（**Restrict**，删用户不级联删记录） |
| `TestItem` | — | `test_record_id` | `test_record_id → TestRecord`（**Cascade**） |
| `Attachment` | — | `test_record_id` | `test_record_id → TestRecord`（**SetNull**） |
| `Guest` | `username` | `guest_type`、`created_by`、`valid_until` | `created_by → User`（**SetNull**，可空）；`export_requests → GuestExportRequest`（**Cascade**） |
| `GuestExportRequest` | — | `guest_id`、`status` | `guest_id → Guest`（**Cascade**） |
| `Session` | — | `user_id`、`status` | `user_id → User`（**Cascade**） |
| `Backup` | `backup_path` | `created_by` | `created_by → User`（**SetNull**，可空） |
| `SystemLog` | — | `level`、`created_at` | — |

### 4.3 检测记录存储约定

- 前端提交的动态业务字段整体写入 `TestRecord.result_data`（JSON 字符串）；`testDate / canteen / inspector` 另外抽取写入 `sample_info`（JSON）。
- `record_code` 为**内容确定性哈希**：`RC-{test_type}-{sha256(规范化 payload)}`，用于幂等去重（详见 §5.4、§9）。
- 读取时 `buildRecordPayload()` 会把 `sample_info` 与 `result_data` 展开合并回平铺对象返回前端。

> ⚠️ 原 `backend/sql/*.sql`（PostgreSQL/Supabase + RLS 脚本）与 `backend/config/telemetry.js` 等未启用产物**已于迁移清理中移出仓库**（见 `TD-Backend-Orphan`），运行时以 Prisma schema + 每校迁移为准。

---

## 5. API 接口文档

- 基础路径 `/api`；生产环境由 Caddy 同域反代到 `127.0.0.1:3000`。
- 认证方式：受保护接口需请求头 `Authorization: Bearer <JWT>`。
- 统一响应约定：多数成功返回 `{ success: true, data, ... }`；错误返回 `{ error, details? }` 并附相应 HTTP 状态码。

### 5.1 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | `{ status:'ok', timestamp }` |
| GET | `/api/health` | 同上（同一处理器） |

### 5.2 用户与认证（`/api/user`，`routes/userRoutes.js`）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/user/register` | admin/manager | 注册用户 |
| POST | `/api/user/login` | 公开 | 登录，返回 `{ success, token, user, expiresIn }` |
| POST | `/api/user/verify-token` | 公开（带 token） | 校验令牌 |
| POST | `/api/user/refresh-token` | 登录 | 续期令牌 |
| GET | `/api/user/me` | 登录 | 当前用户信息 |
| PUT | `/api/user/me` | 登录 | 更新个人资料 |
| POST | `/api/user/change-password` | 登录 | 修改密码 |
| GET | `/api/user/list` | admin/manager | 用户列表 |
| POST | `/api/user/:userId/disable` \| `/enable` | admin/manager | 禁用 / 启用 |
| POST | `/api/user/:userId/role` | admin/manager | 改角色 |
| POST | `/api/user/:userId/reset-password` | admin/manager | 重置密码 |
| PUT / DELETE | `/api/user/:userId` | admin/manager | 更新 / 删除（防删自己、防删最后一个 admin） |

### 5.3 访客（`/api/guest`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/guest/quick-access` | 免凭证签发只读 JWT（2h，`is_quick_access=true`、`guest_type=viewer`、无导出权限） |
| POST | `/api/guest/register` | 访客自助注册（需 `schoolCode`+`username`+`password`，密码 bcrypt 落当前租户 `Guest` 表） |
| POST | `/api/guest/login` | 访客登录，返回 `{ token, guest, expiresIn }`（7d） |
| POST | `/api/guest/verify-token` | 校验访客令牌（需 guest 角色 JWT） |

#### 5.3.1 数据导出申请（`/api/guest-export-request`，访客角色）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/guest-export-request/submit` | 提交导出申请（`status=pending`，落 `GuestExportRequest`） |
| GET | `/api/guest-export-request/my-requests` | 当前访客的导出申请列表 |
| GET | `/api/guest-export-request/check-permission` | 当前访客是否具备导出权限（`has_export_permission` / `valid_until`） |

> 访客端点经 `extractSchoolCode()` 解析 `schoolCode` 做租户路由（连字符代码，如 `school-gtest`）。`Guest` / `GuestExportRequest` 模型落在租户 schema，由 `provisionSchool` 推全表自动包含。导出申请当前流程为「访客提交 → pending」，审批端（admin approve/reject）尚未实现，待后续迭代。

### 5.4 检测记录

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/test-records` | 登录 | 列表（`limit/offset/test_type/status`） |
| POST | `/api/test-records` | 编辑者↑ | 创建（幂等：命中 `record_code` 返回已有） |
| GET | `/api/test-records/:id` | 登录 | 单条（含 `test_items`/`attachments`/`created_user`） |
| PUT | `/api/test-records/:id` | 编辑者↑ | 更新 `test_name/status/result_data` |
| DELETE | `/api/test-records/:id` | 编辑者↑ | 删除 |
| GET | `/api/records/:tableName` | 登录 | 按类型取（前端兼容层，返回展开后的平铺对象） |
| POST | `/api/records/:tableName` | 编辑者↑ | 按类型创建（字段校验 + 幂等 + 审计） |
| POST | `/api/records/:tableName/bulk-upsert` | 编辑者↑ | 批量导入（≤2000，按 `record_code` upsert，写审计） |
| GET/PUT/DELETE | `/api/records/:tableName/:id` | 登录 / 编辑者↑ | 单条查 / 改（乐观锁 `version`，冲突 409）/ 删 |

- `:tableName` 必须属于 `{tableware, pathogen, leanMeat, oil, pesticide}`，否则 400/404。
- 幂等：并发唯一约束冲突（P2002）→ 返回已有记录；外键失败（P2003，用户不存在）→ 422。
- 写请求可带 `Idempotency-Key` 头（配合 `/api/records` 的幂等中间件）。

### 5.5 审计日志与同步

| 方法 | 路径 | 说明 |
|------|------|------|
| * | `/api/audit-logs`（`auditRoutes.js`） | 通用操作审计（字段完整：user_id/action/resource_type/resource_id/details/ip_address） |
| * | `/api/sync`（`syncRoutes.js`） | 离线 / 多端数据同步 |

### 5.6 用户管理（历史遗留，已移除）

> ⚠️ 原 `server.js` 内联的 `/api/users`、`/api/users/:userId/disable|enable` 路由（技术债 TD-Users-Dup，见 §10）已于清理中**删除**，统一收敛到 `/api/user/*`（见 §5.2）。下方仅作历史索引归档，当前代码中已不存在：

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/users` | admin | 用户列表（已删除，改用 `/api/user/list`） |
| POST | `/api/users/:userId/disable` \| `/enable` | admin | 禁用 / 启用（已删除，改用 `/api/user/:userId/disable|enable`） |

---

## 6. 前端模块设计

### 6.1 路由结构（无框架路由，SPA 分区显隐）

- 入口页：`login.html`（登录）、`index.html`（主应用）。
- 侧边栏导航按钮用 `data-target` 标识目标区块（`dashboard`、`tableware-test`、`pesticide-test`、`oil-test`、`lean-meat-test`、`pathogen-test`、`export-data`、`backup-restore`、`user-management`、`audit-log`），`data-admin-only` 仅管理员可见。
- `js/core/Router.js`：权限守卫（按角色显隐 admin/guest 菜单）、Token 定时校验、30 分钟空闲登出。
- 导航通信统一走**事件委托 + `CustomEvent`**（已移除 `window.*` 全局耦合）：`app:navigate`、`dashboard:refresh`。

### 6.2 组件划分（`js/`）

```
js/
├── main.js                 # 初始化总入口（DOMContentLoaded）
├── core/
│   ├── Router.js           # 路由 / 权限守卫 / 空闲登出
│   ├── Auth.js             # OperationGuard 敏感操作二次确认
│   ├── Storage.js          # ★ StorageService：离线优先数据层
│   └── AdaptiveUploadQueue.js  # ★ 渐进节流上传队列（429/409 + 指纹去重）
├── modules/                # 9 个业务模块（事件委托 + CustomEvent）
│   ├── Dashboard  Tableware  Pathogen  GenericTest(pesticide/oil/leanMeat)
│   ├── UserManagement  AuditLog  BackupRestore  GuestDashboard  FormBuilder
├── services/
│   ├── AuthService.js      # 登录/登出/Token（login.html 与 Router 使用）
│   ├── GuestAuthService.js # 访客快速访问
│   └── PermissionService  SessionManager  ExportService  AuditLogService
└── utils/                  # 工具（部分为历史遗留，见 §10）
```

### 6.3 状态管理

- **无集中式状态库**；状态分散在各模块与浏览器存储：
  - `localStorage`：`auth_token` / `current_user` / `guest_token`（登录态）、`cache_<table>`（记录缓存）、`pending_<table>`（待同步队列）、`fingerprint_index_<table>`（去重索引）、`audit_YYYY-MM-DD`（前端离线日志）。
  - `StorageService`（`js/core/Storage.js`）是核心数据层：**离线优先**（`getAll()` 先返回本地缓存再后台刷新）、乐观写入（`temp_` 临时 ID）、三层去重（本地/云端/队列）、`429` 全局退避、`409` 版本冲突恢复。详见 `docs/DEVELOPMENT_GUIDE.md` §6.6 / §6.7。

---

## 7. 认证与权限设计

### 7.1 RBAC 角色矩阵

| 能力 \ 角色 | admin | manager | operator | user | viewer | guest(快速访问) |
|-------------|:-----:|:-------:|:--------:|:----:|:------:|:--------------:|
| 查看看板 / 记录 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 创建 / 编辑 / 删除记录 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 用户管理（增删改角色） | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| 审计日志管理 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

- 写入判定由 `requireEditorOrAbove` 实现：角色为 `guest` / `viewer` 一律拒绝（403），其余允许写。
- 用户管理由 `authorizeRoles('admin','manager')`。

### 7.2 JWT 结构

- **普通用户令牌**（`UserManager` 签发）payload：`{ userId, username, email, role, iat, exp }`，有效期 `JWT_EXPIRE`（默认 `7d`）。
- **访客快速访问令牌**（`/api/guest/quick-access`）payload：`{ guestId:0, username, guest_type:'viewer', has_export_permission:false, is_quick_access:true, iat, exp }`，有效期 `2h`。

### 7.3 中间件链

```mermaid
flowchart LR
    R[rateLimit 全局<br/>1000/60s] --> C[cors 白名单] --> J[express.json 10mb]
    J --> I{路径 /api/records ?}
    I -->|是| ID[idempotencyMiddleware]
    I -->|否| RT
    ID --> RT[路由匹配]
    RT --> AU[authenticateUser<br/>校验 Bearer → req.user]
    AU --> EW{写操作?}
    EW -->|是| RE[requireEditorOrAbove<br/>拒绝 guest/viewer]
    EW -->|否| H[业务处理器]
    RE --> H
```

- 认证工厂：`createAuthMiddleware(userManager)` 统一导出 `authenticateUser` / `authorizeAdmin` / `authorizeRoles(...)`。**禁止在路由内重复实现认证逻辑**。
- `authenticateUser` 解码后挂 `req.user = { userId, username, email, role }`，并向后兼容 `req.userId` / `req.userRole`。

---

## 8. 部署架构

当前生效方案：`deploy/deploy.sh`（通用流程）+ `deploy/deploy.foodtestlab.conf`（环境适配）。`deploy/nginx`、`deploy/pm2`、`deploy.ps1` 等历史适配器（Nginx/PM2/Windows 栈）已下线并移出仓库。

### 8.1 部署形态（单应用 + 每校 schema）

- **应用层**：单套 Node 后端 + 单 Caddy 站点 + 单 systemd 服务，所有学校共用，不做物理分部署。
- **数据层（多学校隔离）**：单 PostgreSQL 实例，每校一个独立 schema（方案②）。新增学校 = 建 schema + 跑迁移，不新增服务/端口。
- **环境差异**：开发/测试用单一共享 schema（无隔离）；生产启用 schema-per-tenant。`.env` 的 `DATABASE_URL` 指向同一 PG 实例与库，schema 由应用层按学校路由。
- 原"每校一套适配文件 + 独立端口/服务"的物理隔离方案已弃用（在 2vCPU/3.5GiB 上会因连接数随学校线性增长而撞资源墙），见 §10。

### 8.2 环境变量清单（`backend/.env`，由 `deploy.sh` 自动生成）

| 变量 | 生产取值 | 说明 |
|------|----------|------|
| `NODE_ENV` | `production` | 环境标识 |
| `PORT` | `3000` | 后端内部端口（仅 127.0.0.1） |
| `SERVE_STATIC` | `false` | 生产由 Caddy 托管静态资源 |
| `DATABASE_URL` | `postgresql://<user>:<pass>@127.0.0.1:5432/foodtestlab` | PostgreSQL 连接串（生产）；schema 由应用按学校路由 |
| `JWT_SECRET` | `openssl rand -base64 48` | 强随机；命中弱密钥黑名单会拒绝启动 |
| `JWT_EXPIRE` | `7d` | 令牌有效期 |
| `CORS_ORIGIN` | `http://<公网IP>:<FRONTEND_PORT>` 或 `https://<域名>` | 逗号分隔来源；`*` 全开 |
| `CORS_HOSTNAMES` | （可选） | hostname[:port] 白名单 |
| `SEED_ADMIN_PASSWORD` / `SEED_OPERATOR_PASSWORD` / `SEED_VIEWER_PASSWORD` | 自动生成 14 位 | seed 初始密码 |
| `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS` | 1000 / 60000 | 全局限流（有默认值） |

> 首次部署（`SEED_ON_FIRST_DEPLOY=true` 且数据库不存在）会自动执行 seed，创建 `admin` / `operator` / `viewer` 三个账号；生产环境非首次不再 seed。

### 8.3 systemd 单元（脚本生成）

```ini
[Service]
Type=simple
User=foodtestlab
WorkingDirectory=/opt/foodtestlab/backend
EnvironmentFile=/opt/foodtestlab/backend/.env
ExecStart=/usr/local/bin/node server.js
MemoryMax=<按物理内存自适应>M          # ≤1G→384 / ≤2G→768 / ≤4G→1024 / else 1536
Environment=NODE_OPTIONS=--max-old-space-size=<MemoryMax*3/4>M
Restart=on-failure
RestartSec=5
StandardOutput=append:/mnt/datadisk0/foodtestlab/logs/app.out.log
StandardError=append:/mnt/datadisk0/foodtestlab/logs/app.err.log
```

- 内存上限按 `free -m` 物理内存分级，可用适配文件 `SERVICE_MEMORY_MAX` 覆盖。
- 低内存机可开 swap 缓冲构建峰值：`ENABLE_SWAP=true|auto|false`（若已手动创建 swap，建议设 `false` 或 `auto` 避免重复创建 `/swapfile`）。

### 8.4 Caddy 站点片段（脚本生成）

```caddy
:8080 {                                 # 有域名时改为 <域名> 并自动 HTTPS
    encode gzip
    @api path /api/* /health
    reverse_proxy @api 127.0.0.1:3000
    root * /opt/foodtestlab/dist
    file_server
    try_files {path} /index.html
}
```

### 8.5 一键部署

```bash
# 前置（手动）：腾讯云安全组放行 TCP 22 与 FRONTEND_PORT（HTTPS 阶段再放 443）
sudo bash deploy/deploy.sh deploy/deploy.foodtestlab.conf
```

流程：校验 → 装运行时（git/Caddy/Node via NVM）→ 建系统用户与目录 → 拉代码 → 生成 `.env` → 后端依赖 / `prisma generate` / `db push` / seed → 前端构建 → 写 systemd → 写 Caddy 片段（端口预检）→ 健康检查 → 输出初始账号密码。

---

## 9. 安全设计

### 9.1 限流

- **全局限流**：`rateLimit(RATE_LIMIT_MAX_REQUESTS=1000, RATE_LIMIT_WINDOW_MS=60s)`，按 IP 滑动窗口，超限返回 429。
- **登录限流**：`userRoutes` 内对登录接口单独限流（默认 10 次 / 15 分钟，可用 `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` 调整），防暴力破解。
- 请求体大小上限 `express.json({ limit:'10mb' })`。

### 9.2 密码与密钥策略

- 密码使用 **bcryptjs** 哈希存储（`password_hash`），不落明文。
- 后端字段校验：`username` 为 3–50 位 `[a-zA-Z0-9_]`；`password` 最少 6 位（`fieldValidators`）。
- **JWT 密钥硬校验**：`JWT_SECRET` 缺失或命中弱密钥黑名单（如 `food-lab-secret-key` 等占位值）→ **进程直接退出**，杜绝默认密钥签发令牌。
- seed 初始密码来自 `SEED_*_PASSWORD` 环境变量（缺失则 seed 拒绝运行）；生产默认跳过 seed，除非显式 `SEED_ALLOW_PROD=true`。

### 9.3 输入安全

- `validationMiddleware`：提供 XSS 检测（`detectXss`）、SQL 注入检测（`detectSqlInjection`）、HTML 转义 / 消毒（`escapeHtml` / `sanitizeHtml` / `sanitizeText`）。
- 前端 `FormValidator` 的 `xss` / `sqlInjection` 规则与后端保持一致（后端为超集）。
- CORS 精确匹配来源，非白名单来源不下发 CORS 头并记录告警（不抛 500）。

### 9.4 审计日志机制

审计已统一为**单一入口 `js/services/AuditService.js`**（技术债 TD-P2-13 ✅）：所有审计调用收敛到 `auditService.log`，**双写后端（系统真相源 `/api/audit-logs`）+ localStorage 镜像**（`AuditLogger`，按天 `audit_YYYY-MM-DD`，保留 30 天），字段口径对齐后端 `auditLog` 模型（`action` / `resource_type` / `resource_id` / `details` / `ip_address`）。调用方涵盖 `AuthService`(login/logout)、`UserManagement`、`Storage`(create/update/delete)、`Dashboard`/`Tableware`/`Pathogen`/`BackupRestore`/`AuditLog`。后端写入实现仍在 `AuditLogService`（`/api/audit-logs` 路由 `auditRoutes.js`），由 `AuditService` 委托。

> 生产环境审计记录**不得物理删除**（见 `docs/PROJECT_CONVENTIONS.md` 规则一）。`/api/audit-logs/cleanup` 物理删除端点已在审计统一时移除。

### 9.5 幂等与并发

- 记录写入以内容哈希 `record_code` 作唯一键，重复提交返回已有记录；`/api/records` 挂 `idempotencyMiddleware` 支持 `Idempotency-Key`。
- 记录更新支持**乐观锁**（`version`），版本不一致返回 409，由前端拉取最新后重试。

---

## 10. 已知技术债务与待办

| 编号 | 描述 |
|------|------|
| TD-Guest | `GuestAuthService` 调用的 `/api/guest/login`、`/register`、`/verify-token`、`/api/guest-export-request/*` 后端已落地（schema 新增 `Guest`/`GuestExportRequest`，`guestRoutes.js` 实现全套并挂载于 `server.js`；前端 `GuestAuthService` 经 `extractSchoolCode()` 补齐 `schoolCode`）；已对真实 PostgreSQL 冒烟通过。 | ✅已解决 |
| TD-Auth-Path | `AuthService` 路径已对齐后端：改密码 `POST /api/user/change-password`、校验令牌 `POST /api/user/verify-token`；后端新增无状态 `/api/user/logout`（返回 200，前端统一清本地）。 | ✅已解决 |
| TD-ApiClient | `js/utils/ApiClient.js` 用 `/auth/*` 路径，与后端 `/api/user/*` 不符，属遗留并行客户端（无引用，已移出仓库）。 | ✅已解决 |
| TD-Users-Dup | `server.js` 内联 `/api/users*` 与 `userRoutes` 的 `/api/user/list`、`/:userId/disable|enable` 功能重复（且内联版无租户隔离）。 | ✅已解决（内联实现已删除，统一走 `/api/user`） |
| TD-P2-13 | 审计日志已统一：新增 `js/services/AuditService.js` 单一入口，双写后端（系统真相源）+ localStorage 镜像，字段口径对齐后端 `auditLog` 模型（`action`/`resource_type`/`resource_id`/`details`）。 | ✅已解决 |
| TD-Session | 已实现并对接后端：`backend/routes/sessionRoutes.js` 提供 `/api/session`（注册/心跳、列表、注销指定、登出其它设备），`model Session` 落在租户 schema；前端 `SessionManager.syncToBackend` / `syncSessions` 已真正调用后端（登录/登出/强制登出同步落库）。 | ✅已解决 |
| TD-Orphan | 未被引用的前端遗留模块：`CacheManager` / `ConfigManager` / `UserAuth` / `IndexedDBManager` / `OfflineModeManager` / `PerformanceMonitor` | ✅已解决（迁移清理中已移出仓库） |
| TD-Backend-Orphan | `backend/sql/*.sql`（PostgreSQL/Supabase + RLS）、`backend/config/telemetry.js`（依赖未安装的 node-statsd/Prometheus）等未启用产物 | ✅已解决（迁移清理中已移出仓库） |
| TD-Naming | `package.json` name 已中立化为 `foodtestlab`；`engines.node` 对齐实际运行环境（`>=18`）；`.env.example` Windows 旧字段已清理。 | ✅已解决 |
| TD-Tenant | 多学校隔离采用 **per-schema `?schema=` 专属 PrismaClient** 方案（`tenantClient.js` 的 `createTenantClient`：为每个 schema 缓存独立 `new PrismaClient`，连接串带 `?schema=<schema>`，LRU 缓存 + 每客户端连接上限）。该方案避开连接池竞态（无需 search_path / 事务包裹 / PgBouncer Session 模式）。**历史「事务包裹 / search_path」方案已证伪废弃**。 | ✅已解决 |

---

## 11. 开发环境搭建指南

### 11.1 后端

```bash
cd backend
npm install
# 准备 .env（本地开发，参考下方最小集）
npx prisma generate
npx prisma db push            # 同步 schema 到 PostgreSQL（本地库）
node prisma/seed.js           # 初始化 admin/operator/viewer（需 SEED_*_PASSWORD）
npm run dev                   # 或 npm start（默认端口 3002）
```

本地 `.env` 最小集（PostgreSQL，开发/测试/生产统一）：

```ini
NODE_ENV=development
PORT=3002
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/foodtestlab
JWT_SECRET=<自行生成的强随机串，勿用弱密钥黑名单值>
SEED_ADMIN_PASSWORD=admin123
SEED_OPERATOR_PASSWORD=operator123
SEED_VIEWER_PASSWORD=viewer123
```

### 11.2 前端

前端无需构建即可开发（浏览器直载 ES Module）。用任意静态服务器托管仓库根目录：

```bash
npx http-server -p 8080
# 访问 http://localhost:8080/login.html
```

- 前端 `AuthService.getApiBaseUrl()` 现返回同源空串，API 走相对路径 `/api/...`，自动命中"当前页面所在端口"的后端（开发态由后端 `SERVE_STATIC=true` 同源托管静态与 API，无需写死端口）；如需跨域/特殊环境可用 `window.__API_BASE_URL` 覆盖。
- 生成部署产物：`npm run build`（`scripts/build-static.js` → `dist/`）。

### 11.3 测试

```bash
npm test                      # Jest 单元测试（--coverage）
npx jest tests/smoke.test.js  # 冒烟：Validator + pathogenRisk
npm run test:e2e              # Cypress（需先起 http-server :8080）
```

---

## 12. 运维手册

### 12.1 服务管理

```bash
systemctl status  foodtestlab-api     # 后端状态
systemctl restart foodtestlab-api     # 重启后端
journalctl -u foodtestlab-api -f      # 后端实时日志（systemd）
systemctl status  caddy               # 反代状态
caddy reload --config /etc/caddy/Caddyfile   # 重载 Caddy 配置
```

### 12.2 日志查看

- 后端应用日志：`/mnt/datadisk0/foodtestlab/logs/app.out.log`、`app.err.log`。
- systemd 汇总：`journalctl -u foodtestlab-api`。
- Caddy 访问 / 错误：`journalctl -u caddy`。
- 前端离线操作日志：浏览器 `localStorage` 的 `audit_YYYY-MM-DD`（保留 30 天）。

### 12.3 备份与恢复（PostgreSQL）

```bash
# 整库备份
pg_dump foodtestlab > /mnt/datadisk0/foodtestlab/backup/foodtestlab_$(date +%F).sql

# 按校（schema）单独备份 / 恢复 —— 多学校隔离的核心能力
pg_dump -n school-a foodtestlab > /mnt/datadisk0/foodtestlab/backup/school-a_$(date +%F).sql
psql -d foodtestlab -f /mnt/datadisk0/foodtestlab/backup/school-a_$(date +%F).sql

# 恢复整库（先停后端，再导入）
systemctl stop foodtestlab-api
psql -d foodtestlab < /mnt/datadisk0/foodtestlab/backup/foodtestlab_YYYY-MM-DD.sql
chown foodtestlab:foodtestlab /mnt/datadisk0/foodtestlab/data   # 视挂载与权限而定
systemctl start foodtestlab-api
```

> 应用内亦有 `Backup` 模型与备份恢复模块（`BackupRestore.js`）记录备份元数据；物理备份以上述 `pg_dump` / 按 schema 备份为准。

### 12.4 健康检查

```bash
curl http://127.0.0.1:3000/api/health       # 本机（应返回 {status:'ok'}）
curl http://<公网IP>:8080/health            # 经 Caddy（验证反代与安全组）
```

### 12.5 故障排查速查

| 现象 | 排查方向 |
|------|----------|
| 本机健康检查通过但外网访问超时 | 腾讯云**安全组**未放行 `FRONTEND_PORT`（脚本不配置安全组） |
| 后端起不来 / 反复重启 | `journalctl -u foodtestlab-api -n 50`；常见：`JWT_SECRET` 缺失或弱密钥、`DATA_DIR` 未挂载 |
| 重启后服务失败 | 数据盘 `/mnt/datadisk0` 未写入 `/etc/fstab`，重启未自动挂载 |
| 登录 401 / CORS 报错 | `.env` 的 `CORS_ORIGIN` 与实际访问来源不一致 |
| 写操作 403 | 当前为 `viewer` / 访客（快速访问）角色，无写权限 |
| 更新返回 409 | 乐观锁版本冲突，前端需拉取最新数据后重试 |
| 构建时 OOM | 低内存机开启 `ENABLE_SWAP` 或调低 `SERVICE_MEMORY_MAX` |

---

## 相关文档

- 开发细节：[`docs/DEVELOPMENT_GUIDE.md`](./docs/DEVELOPMENT_GUIDE.md)
- 长期规范（优先级最高）：[`docs/PROJECT_CONVENTIONS.md`](./docs/PROJECT_CONVENTIONS.md)
- 部署说明：[`deploy/README.md`](./deploy/README.md)
- 后端说明：[`backend/README.md`](./backend/README.md)
- 历史归档（仅供参考）：[`docs/history/`](./docs/history/)
