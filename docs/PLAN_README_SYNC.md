# 计划执行文档：README 与代码对齐（重构/优化收尾）

> 本文件用于「新开对话续接」。包含：本次大改动的上下文总结、已验证的代码事实、README 待校正清单（含可直接套用的 old_str/new_str）、检查点、验证方法、坑位。
> 配套交接文档：`docs/HANDOFF.md`（架构真相 + TD 根因校正）。
> 优先级最高规范：`docs/PROJECT_CONVENTIONS.md`。

---

## 1. 上下文总结（来自前序对话）

本轮工程目标：对 foodtestlab 做「前后端功能级重构与优化」，并清理技术债（TD-*）。**主体代码工作已全部完成并已提交**（最新提交 `1ce9987` "per-schema PrismaClient 隔离 + TD-Guest/TD-Session/审计收敛"）。

在历史对话中已完成的重构/优化（均已在 `main` 提交）：

| 提交 | 内容 |
|------|------|
| `ef4394b` | TD-Naming / TD-ApiClient / TD-Auth-Path / TD-Users-Dup / TD-Tenant |
| `b70129a` | TD-P2-13 统一审计接口（新增 `js/services/AuditService.js`） |
| `1ce9987` | per-schema PrismaClient 隔离 + TD-Guest（guestRoutes.js + schema Guest/GuestExportRequest）+ TD-Session（sessionRoutes.js + model Session + SessionManager 对接后端）+ 审计收敛 |

**关键架构校正（务必先读，避免误改）**：
- 多学校隔离当前实现是 `backend/lib/tenantClient.js` 的 `createTenantClient(prisma, schoolCode)`：**为每个 schema 缓存一个独立 `new PrismaClient`**，连接串带 `?schema=<schema>`，Prisma 把 schema 名编译进 SQL。这是 Prisma 官方推荐方式。
- **旧文档描述的「请求级 `SET search_path` 路由 + Proxy」方案已被证伪并废弃**（Prisma 把 schema 硬编码进 SQL，`SET LOCAL search_path` 对 model 查询无效，仅裸 `$queryRaw` 生效）。**切勿重新引入 search_path / Proxy 方案。**
- `schoolCode` 经 `schemaNameOf()` 归一为 `school_<code>`（`school-` 前缀归一为 `school_` 下划线）；`isValidSchoolCode` 仅允许 `[a-z0-9-]`（不含下划线，学校代码用连字符，如 `school-gtest`）。
- TD-Guest 真实 PG 冒烟 9/9 通过的根因是 `school-gtest` 租户从未被 `provisionSchool` 建好，而非 `?schema=` 失效。

**本文件要解决的核心问题**：代码已跑在真实架构上，但 `README.md` 的**叙述章节（§3.3 / §4 / §5.3 / §5.6 / §7.1 / §9.4）与 §10 部分 TD 行**仍描述旧架构/未实现状态，与代码自相矛盾。本文档是把 README 校正到与代码一致的逐项执行计划。

---

## 2. 已验证的代码事实（用于文档准确性，附 file:line）

- 多租户：`backend/lib/tenantClient.js` `createTenantClient(prisma, schoolCode)` → `?schema=` 缓存独立 PrismaClient；`server.js` 挂 `req.db`（租户 client）。
- Guest 路由：`backend/routes/guestRoutes.js`，`server.js:510-513` 挂载：
  - `POST /api/guest/register`（需 `schoolCode`+`username`+`password`）
  - `POST /api/guest/login`
  - `POST /api/guest/verify-token`
  - `POST /api/guest-export-request/submit`（访客，需 guest 角色）
  - `GET /api/guest-export-request/my-requests`（访客）
  - `GET /api/guest-export-request/check-permission`（访客）
  - ⚠️ **无管理员 approve/reject/all 端点**（guestRoutes.js 仅 submit/my-requests/check-permission）。不要文档化审批端点。
- 模型（均落在租户 schema，由 `provisionSchool` 推全表包含）：
  - `Guest`：`id,username(UK),email?,password_hash,full_name?,created_by?,guest_type(default viewer),has_export_permission(default false),valid_until?,status,created_at,updated_at`；关系 `created_user`、`export_requests`（`schema.prisma:122-142`）
  - `GuestExportRequest`：`id,guest_id,request_type,request_reason?,request_data?(JSON string),status(default pending),reviewed_by?,reviewed_at?,created_at,updated_at`；关系 `guest`（`schema.prisma:146-162`）
  - `Session`：`id,user_id,session_token?,device_type?,browser?,user_agent?,ip_address?,status(active/revoked),login_at,last_seen_at,created_at`；关系 `user`（`schema.prisma:187-204`）
- Session 路由：`backend/routes/sessionRoutes.js`，`server.js:506-507` 挂载 `/api/session`：
  - `POST /api/session`（注册/心跳，upsert by sessionId）
  - `GET /api/session`（当前用户活跃会话列表）
  - `DELETE /api/session/:id`（注销指定会话，本人或 admin）
  - `DELETE /api/session/others`（登出其它设备）
- 审计统一：`js/services/AuditService.js` 单一入口，双写后端 `/api/audit-logs`（真相源）+ localStorage 镜像 `AuditLogger`（`audit_YYYY-MM-DD`）；字段口径 `action/resource_type/resource_id/details/ip_address`。`/api/audit-logs/cleanup` 物理删除端点已移除。
- 内联 `/api/users*`：已在 `ef4394b` 删除（`server.js` 不再有该内联路由），统一走 `/api/user/*`。
- 前端 `SessionManager.syncToBackend` / `syncSessions`：已真正调用后端 `/api/session`（TD-Session 已在代码完成）。

---

## 3. README 待校正清单（P1–P8）

> 总原则：**只改文档，不改代码**。纯文本/markdown 编辑，零运行风险。改完跑 `npx jest --silent`（应 6/6 通过，文档改动不影响）与文档 grep 自检。

### P1 — §3.3 多学校隔离图与说明（README.md:110-127）⭐最高优先级
旧：mermaid 用「单 PrismaClient + 请求级 SET search_path」虚线；说明文字「由请求级中间件按登录学校 SET search_path 路由」。
新：改为「每校缓存独立 PrismaClient（?schema= 连接串）」，并加 ⚠️ 红字校正。

**old_str**（README.md:110-127 整段，从 `### 3.3` 到该段 `>` 结束）：
```
### 3.3 多学校隔离（单应用 + PostgreSQL Schema-per-tenant）

\`\`\`mermaid
flowchart TB
    Caddy[Caddy 反代 :FRONTEND_PORT]
    API[systemd: foodtestlab-api<br/>单应用 + 单 PrismaClient]
    PG[(PostgreSQL 单实例)]
    subgraph Schemas[schema-per-tenant]
        S1[schema: school-a]
        S2[schema: school-b]
        Sn[schema: school-n ...]
    end
    Caddy --> API --> PG
    PG --> Schemas
    API -.请求级 SET search_path.-> Schemas
\`\`\`

> 「多学校」= **单套应用 + 单 PostgreSQL 实例 + 每校独立 schema**（非物理分部署，也非单表 `school_id` 混放）。表结构全校一致；连接池共享（约 10–20 条），由请求级中间件按登录学校 `SET search_path` 路由。开发/测试环境用单一共享 schema。
```
**new_str**：
```
### 3.3 多学校隔离（单应用 + PostgreSQL Schema-per-tenant）

\`\`\`mermaid
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
\`\`\`

> 「多学校」= **单套应用 + 单 PostgreSQL 实例 + 每校独立 schema**（非物理分部署，也非单表 `school_id` 混放）。表结构全校一致；`backend/lib/tenantClient.js` 的 `createTenantClient(prisma, schoolCode)` 为**每个 schema 缓存一个独立 `new PrismaClient`**（连接串带 `?schema=<schema>`，LRU 缓存 + 每客户端连接上限），把 Prisma 的 model 查询硬绑定到对应 schema——这是 Prisma 官方推荐的 schema 隔离方式（schema 名编译进 SQL，非运行时 search_path）。`schoolCode` 经 `schemaNameOf()` 归一为 `school_<code>`（`school-` 前缀归一为 `school_` 下划线）；`isValidSchoolCode` 仅允许 `[a-z0-9-]`（不含下划线，学校代码用连字符，如 `school-gtest`）。开发/测试环境用单一共享 schema。
>
> ⚠️ **历史文档曾描述「请求级 `SET search_path` 路由 + Proxy」方案，已证伪并废弃**：Prisma 把 schema 名硬编码进生成的 SQL，`SET LOCAL search_path` 对 model 查询无效（仅裸 `$queryRaw` 生效，如 `provisionSchool` 建初始 admin 时）。**切勿重新引入 search_path / Proxy 方案。**
```

### P2 — §4 多学校隔离（Schema-per-tenant）（README.md:135-141）
旧：
```
#### 多学校隔离（Schema-per-tenant）

- 每校对应 PostgreSQL 中一个独立 schema（**schoolCode 即 schema 名**，如 `school-a`），**所有 schema 的表结构与迁移完全一致**（同一份 Prisma schema）。
- 应用通过**单一 PrismaClient** + 请求级中间件执行 `SET search_path TO "school-a", public;` 路由到对应 schema；注意 `search_path` 是连接级状态，须用事务包裹或 PgBouncer Session 模式避免连接池竞态（实现选型见 §10 / 部署说明）。
- 备份/恢复/迁移按校独立：`pg_dump -n school-a mydb` 单独导出，`psql -d mydb -f school-a.sql` 单独恢复；迁校即导出该 schema 在目标库 `CREATE SCHEMA` 后恢复。
- 新增学校：在 PG 实例建 schema + 对其跑 Prisma 迁移（或从模板 schema 克隆）。
- 开发/测试：使用单一共享 schema（如 `public` 或 `dev`），无需逐校隔离。
```
new_str：
```
#### 多学校隔离（Schema-per-tenant）

- 每校对应 PostgreSQL 中一个独立 schema（schema 名由 `schemaNameOf(schoolCode)` 归一为 `school_<code>`，如 `school-gtest` → `school_gtest`），**所有 schema 的表结构与迁移完全一致**（同一份 Prisma schema）。
- 隔离由 `backend/lib/tenantClient.js` 的 `createTenantClient(prisma, schoolCode)` 实现：为每个 schema 缓存一个独立 `new PrismaClient`（连接串带 `?schema=<schema>`），Prisma 据此把 model 查询限定到该 schema。租户中间件在 `authenticateUser` 后挂 `req.db`（即当前校的 tenant client）。新增模型只需 `prisma db push` 推一次，新学校自动包含全部模型。
- 备份/恢复/迁移按校独立：`pg_dump -n school_gtest mydb` 单独导出，`psql -d mydb -f school_gtest.sql` 单独恢复；迁校即导出该 schema 在目标库 `CREATE SCHEMA` 后恢复。
- 新增学校：`tenantProvisioner.provisionSchool({ code })` 用 `prisma db push ?schema=<租户>` 推全表并建初始 admin（连字符代码，如 `school-gtest`）。
- 开发/测试：使用单一共享 schema（如 `public` 或 `dev`），无需逐校隔离。
```

### P3 — §4 ER 图补充 Guest / GuestExportRequest / Session（README.md:143-224）
当前 ER 图缺 `GuestExportRequest` 与 `Session`，且 `Guest` 字段偏旧（缺 `guest_type/has_export_permission/valid_until`）。
- 在 `Guest` 实体块补充字段：`guest_type`、`has_export_permission`、`valid_until`、`created_at`、`updated_at`。
- 新增 `GuestExportRequest` 实体：
```
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
```
- 新增 `Session` 实体：
```
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
```
- 关系：`Guest ||--o{ GuestExportRequest : "guest_id (Cascade)"`、`User ||--o{ Session : "user_id (Cascade)"`。
- §4.2 关键表结构索引表补充三行（见下方 §8 校验清单）。

### P4 — §5.3 访客端点（README.md:279-285）⭐
旧（错误：声称 login/register 后端未实现 404）：
```
### 5.3 访客（`/api/guest`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/guest/quick-access` | **唯一实现**：免凭证签发只读 JWT（2h，`is_quick_access=true`、`guest_type=viewer`、无导出权限） |

> 前端 `GuestAuthService` 另调用 `/api/guest/login`、`/register`、`/verify-token`、`/api/guest-export-request/*`，**后端未实现**，会 404（见 §10）。
```
new_str：
```
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
```

### P5 — §5.6 用户管理内联路由（README.md:312-318）⭐
旧（仍列出已删除的内联路由为「历史遗留」且当作存在）：
```
### 5.6 用户管理（历史遗留，server.js 内联）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/users` | admin | 用户列表（与 `/api/user/list` 功能重复） |
| POST | `/api/users/:userId/disable` \| `/enable` | admin | 禁用 / 启用（与 `/api/user/*` 重复） |
```
new_str：
```
### 5.6 用户管理（历史遗留，已移除）

> ⚠️ 原 `server.js` 内联的 `/api/users`、`/api/users/:userId/disable|enable` 路由（技术债 TD-Users-Dup，见 §10）已于清理中**删除**，统一收敛到 `/api/user/*`（见 §5.2）。下方仅作历史索引归档，当前代码中已不存在：

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/users` | admin | 用户列表（已删除，改用 `/api/user/list`） |
| POST | `/api/users/:userId/disable` \| `/enable` | admin | 禁用 / 启用（已删除，改用 `/api/user/:userId/disable|enable`） |
```

### P6 — §7.1 RBAC 矩阵（README.md:360-371）⭐
- 删除矩阵中 `内联 /api/users*` 那一行。
- 删除其后说明中的「；内联 `/api/users*` 仅 `admin`」。
old_str（矩阵末行 + 说明两句）：
```
| 内联 `/api/users*` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
...
- 用户管理由 `authorizeRoles('admin','manager')`；内联 `/api/users*` 仅 `admin`。
```
new_str：矩阵去掉该行；说明改为：
```
- 用户管理由 `authorizeRoles('admin','manager')`。
```

### P7 — §9.4 审计日志机制（README.md:492-501）⭐
old_str：
```
### 9.4 审计日志机制

系统当前存在**三套审计日志**（见 `server.js` 顶部注释，技术债 TD-P2-13）：

1. **后端 DB 登录日志**（`UserManager`）—— 仅登录 / 失败登录；
2. **后端 DB 通用操作审计**（`/api/audit-logs` ← 前端 `AuditLogService`，字段完整含 IP）；记录记录类 CRUD / 批量导入（`writeRecordAuditLog`）；
3. **前端 localStorage 离线日志**（`AuditLogger`，按天存储 `audit_YYYY-MM-DD`，保留 30 天）。

> 生产环境审计记录**不得物理删除**（见 `docs/PROJECT_CONVENTIONS.md` 规则一）。
```
new_str：
```
### 9.4 审计日志机制

审计已统一为**单一入口 `js/services/AuditService.js`**（技术债 TD-P2-13 ✅）：所有审计调用收敛到 `auditService.log`，**双写后端（系统真相源 `/api/audit-logs`）+ localStorage 镜像**（`AuditLogger`，按天 `audit_YYYY-MM-DD`，保留 30 天），字段口径对齐后端 `auditLog` 模型（`action` / `resource_type` / `resource_id` / `details` / `ip_address`）。调用方涵盖 `AuthService`(login/logout)、`UserManagement`、`Storage`(create/update/delete)、`Dashboard`/`Tableware`/`Pathogen`/`BackupRestore`/`AuditLog`。后端写入实现仍在 `AuditLogService`（`/api/audit-logs` 路由 `auditRoutes.js`），由 `AuditService` 委托。

> 生产环境审计记录**不得物理删除**（见 `docs/PROJECT_CONVENTIONS.md` 规则一）。`/api/audit-logs/cleanup` 物理删除端点已在审计统一时移除。
```

### P8 — §10 TD 表两行（README.md:518、522）⭐
- TD-Session 行（518）：由「pending」改为已解决：
old_str：
```
| TD-Session | `SessionManager.syncToBackend` / `syncSessions` 为 TODO 占位，会话仅前端内存（JWT 无状态，重启不丢登录态）。 |
```
new_str：
```
| TD-Session | 已实现并对接后端：`backend/routes/sessionRoutes.js` 提供 `/api/session`（注册/心跳、列表、注销指定、登出其它设备），`model Session` 落在租户 schema；前端 `SessionManager.syncToBackend` / `syncSessions` 已真正调用后端（登录/登出/强制登出同步落库）。 | ✅已解决 |
```
- TD-Tenant 行（522）：更正为 ?schema= 方案（原「采用事务包裹」错误）：
old_str：
```
| TD-Tenant | 连接池竞态选型：**采用事务包裹**（与 PgBouncer transaction 模式兼容，无需 Session 模式；切换点 `tenantClient.js` 已就位，未来若改 Session 模式仅改该文件）。 | ✅已解决（已拍板） |
```
new_str：
```
| TD-Tenant | 多学校隔离采用 **per-schema `?schema=` 专属 PrismaClient** 方案（`tenantClient.js` 的 `createTenantClient`：为每个 schema 缓存独立 `new PrismaClient`，连接串带 `?schema=<schema>`，LRU 缓存 + 每客户端连接上限）。该方案避开连接池竞态（无需 search_path / 事务包裹 / PgBouncer Session 模式）。**历史「事务包裹 / search_path」方案已证伪废弃**。 | ✅已解决 |
```

### P9 — §6.2 组件树 SessionManager 注释 / 其它零散（可选）
- `js/services/SessionManager.js` 顶部若有「TODO 占位，后端未实现」注释，改为「已对接后端 `/api/session`」。这是代码注释改动，低风险，可顺手做（非文档）。
- 检查 `docs/DEVELOPMENT_GUIDE.md`、`deploy/deploy.adapter.example.conf` 等是否有遗留 SQLite / search_path 描述，若有则一并校正（属 P-残留，见 §5）。

---

## 4. 检查点（供新对话续接）

| 阶段 | 完成判据 | 已做 |
|------|----------|------|
| P1 §3.3 | README §3.3 改为 ?schema= 方案 + ⚠️ 红字 | ✅ 2026-07-17 |
| P2 §4 文本 | §4 多学校隔离段改为 ?schema= | ✅ 2026-07-17 |
| P3 §4 ER 图 | 补充 Guest/GuestExportRequest/Session 三实体 + 关系 + §4.2 索引行 | ✅ 2026-07-17 |
| P4 §5.3 | 访客全端点表格 + 导出申请小节 | ✅ 2026-07-17 |
| P5 §5.6 | 标注内联路由已移除 | ✅ 2026-07-17 |
| P6 §7.1 | 删内联行 + 说明（含 §1 概述、矩阵占位行顺手修正） | ✅ 2026-07-17 |
| P7 §9.4 | 审计统一描述 | ✅ 2026-07-17 |
| P8 §10 | TD-Session ✅、TD-Tenant 更正 | ✅ 2026-07-17 |
| P9 零散 | SessionManager L16 注释改为已对接后端（L417 事件记录 TODO 保留为真实后续项） | ✅ 2026-07-17 |
| §5-残留-SQLite | 活动文档无残留「使用 SQLite」表述；`deploy.adapter.example.conf` 已 `postgresql`、`DEVELOPMENT_GUIDE.md` §8 已重写（均含于提交 `eaad334`） | ✅ 2026-07-17 |
| §5-残留-search_path | `DEVELOPMENT_GUIDE.md:14`、`docs/README.md:49` 的 `SET search_path` 现行方案表述已改为 `?schema=` / per-schema PrismaClient | ✅ 2026-07-17 |
| §5-残留-SchoolCustomization | 已核实端到端接通：后端 `/api/school/config`+`/api/schools/:code/config`、`provisionSchool` 写 `public.SchoolCustomization`；前端 `schoolCustomization.js`+`main.js`+`FormBuilder.js` 拉取应用；`tests/integration/live-api.mjs` 有集成测试。无需改代码。 | ✅ 2026-07-17 |
| 收尾 | `npx jest --silent` 6/6 ✅；grep 自检 ✅（`SET search_path` 仅余 ⚠️ 警告）；全部改动已提交 `eaad334` 并推送 `origin/main` | ✅ 2026-07-17 |

> **本会话（2026-07-17）已完成 PLAN_README_SYNC 全部 P1–P9 文档/注释校正 + §5 残留项（除 CVM 实机部署为运维项、不在本仓）**。所有改动已提交 `eaad334` 并推送。新对话若需继续，仅剩：CVM 实机 `deploy.sh` 验证（运维，需上机）。

> 若中途超资源限制：保存当前进度到此文件「检查点」表，新对话读本文档即可从下一个未完成项继续。**所有改动都是文档/注释，互不依赖，可独立提交。**

---

## 5. 其它待办（非本次 README 同步范围，列作后续）

- **P-残留-SQLite 文档**：`docs/DEVELOPMENT_GUIDE.md`、`deploy/deploy.adapter.example.conf` 可能仍有 SQLite 旧描述，需校正为 PostgreSQL/per-schema。
- **P-残留-SchoolCustomization**：确认 `SchoolCustomization`(外观/字段定制) 端到端接通（前端 FormBuilder 等是否真正读取并应用），若仅 schema 存在则补端到端验证。
- **P-运维实机**：`deploy.sh` 在目标腾讯云 CVM 实机验证 PostgreSQL 化部署流程（不在本仓，需上机）。
- **工作树未提交改动**：`git status` 显示 `backend/prisma/schema.prisma`、`docs/DEVELOPMENT_GUIDE.md`、`js/services/AuditLogService.js` 有未提交修改——收尾提交前需 `git diff` 确认这些改动性质（是否为本次应一并纳入的修复），避免遗漏或误带。

---

## 6. 验证方法

```bash
# 单元（文档改动不影响，应仍 6/6）
npx jest --silent

# 文档自检：确认旧说法已消除
grep -n "SET search_path" README.md              # 期望：仅 §3.3/§4 的 ⚠️ 红字里作为「已废弃」被提及；叙述中不再作为现行方案
grep -n "后端未实现" README.md                    # 期望：无（§5.3 已改）
grep -n "/api/users\b" README.md                 # 期望：仅 §5.6 历史归档注明「已删除」
grep -n "三套审计日志" README.md                  # 期望：无（§9.4 已改）
```

---

## 7. 坑位提醒（来自前序对话）

1. **绝不改 `tenantClient.js` 的 search_path / Proxy**——该方案已证伪，当前 `?schema=` 方案正确有效。
2. **schoolCode 命名**：学校代码用连字符（`school-gtest`），schema 名会被归一为 `school_gtest`（下划线）。`isValidSchoolCode` 拒绝下划线。
3. **访客导出申请无审批端点**：guestRoutes.js 只有 submit/my-requests/check-permission，不要在 README 写 admin approve/reject。
4. **文档与代码关系**：代码领先文档，以代码为准；改文档时若发现代码与记忆冲突，先 grep/读代码核实，勿凭记忆。
5. **每校 schema 漂移**：已有学校（如 `school_tianjiabing`）可能缺新建模型，需重新 `prisma db push ?schema=<租户>` 补齐；新学校由 `provisionSchool` 自动全表包含。
