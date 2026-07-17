# 项目操作规范（PROJECT_CONVENTIONS）

> 本文件为本项目**长期生效、最高优先级**的操作规范，适用于所有后续代码修复 / 验证 / 清理 / 重构 / 部署工作，**不因换模型、换会话或换开发者而失效**。
> 任何 AI 助手或开发者在执行涉及审计日志、多学校隔离、认证授权、数据库迁移、前端访问层、部署等操作前，**必须先阅读并遵守以下规则**。
> 规则一、规则二为不可动摇的硬红线；其余规则是对当前代码库事实形成的工程约束，偏离须参照规则二预先报备。
> 历史文档统一归档于 [`docs/history/`](./history/)，仅作参考，不作为权威依据。

---

## 0. 系统目标与架构基线（本项目「是什么、不是什么」）

在动手前先对齐目标，避免把工作带偏方向。

### 0.1 业务定位
面向学校 / 食安检测场景的**食品安全检测管理 Web 应用**：录入、统计、导出五类检测记录，并提供备份恢复、用户与权限管理、审计日志能力。
五类检测（`test_type`）：`tableware`（餐具洁净度/ATP）、`pesticide`（果蔬农残）、`oil`（食用油品质）、`leanMeat`（肉蛋农残）、`pathogen`（病原体，Word 导入）。

### 0.2 架构基线（已定稿，方案② + 方案A）
- **数据层（方案② Schema-per-tenant）**：单应用 + 单 PostgreSQL 实例 + 每校独立 schema。50+ 学校共用同一套应用代码与同一份 Prisma 数据模型；每校业务数据落在独立 schema（表结构完全一致），由应用层按登录学校动态 `SET search_path` 路由。
- **访问层（方案A 路径前缀识别，已确认目标架构）**：`schoolCode` 从 URL 路径前缀提取（如 `/school-a/login` → `school-a`）；登录前即可按 `schoolCode` 拉取个性化配置；登录将 `schoolCode` 上报后端以路由到对应 schema。
- **部署形态**：腾讯云 CVM（Ubuntu 22.04+）单机；**Caddy** 反向代理（对外）+ **systemd** 托管 Node 后端（仅监听 `127.0.0.1`）；前端为原生 ES Module 静态资源（`dist/`），由 Caddy 托管。**不使用 PM2、不使用 Windows 部署**。

### 0.3 明确「不是什么」（避免走回头路）
- ❌ **不是每校物理分部署**（无独立端口 / 独立服务 / 独立适配文件随学校增长）；新增学校 = 建 schema + 跑迁移，**不新增服务或端口**。
- ❌ **不是单表 `school_id` 混放**（隔离靠 schema，而非业务表内的租户列）。
- ❌ **不是 SQLite**（`backend/prisma/schema.prisma` 的 `provider` 已为 `postgresql`；`backend/sql/*.sql` 是 PostgreSQL/Supabase + RLS 历史脚本，仅作参考，不被 Prisma 运行时执行）。
- ❌ **不是框架化前端**（无 React/Vue，无打包器；原生 ESM + Tailwind CDN，浏览器直载；无集中式状态库）。

### 0.4 关键术语
| 术语 | 含义 |
|------|------|
| `schoolCode` | 学校代码，同时**即 PostgreSQL schema 名**（如 `school-a`）；含连字符 `[a-zA-Z0-9_-]`。 |
| 业务 schema | 每校独立的 schema，存放 `User`/`TestRecord`/`AuditLog` 等租户表（不含系统表）。 |
| 系统表（public） | `School` / `SchoolCustomization` 始终位于 `public` schema，由显式 `public.` 前缀访问，不随 `search_path` 切换。 |
| 模板 schema | `school_template`：预先用 `prisma db push` 建好的标准租户表集合，`provision-school.sh` 据此克隆新校。 |
| `req.db` | 请求级租户客户端（由 `createTenantClient` 构造），业务 handler 统一经它访问数据库。 |

---

## 规则一：审计类记录保留原则（硬红线）

1. **AuditLog（审计日志）表中的记录，无论是否确认为测试 / 调试产生，原则上不得物理删除（DELETE）。**
2. 若确认某批审计日志是测试 / 验证产生的噪音，正确做法是在该批记录之后**追加一条说明性审计日志**（如 `action='system_note'`，`details` 注明"以上 N 条记录为 XXX 验证 / 测试产生，时间范围 YYYY-MM-DD HH:MM~HH:MM，核实人：XXX"），而非删除原始记录。
3. **例外**：仅当处理对象明确是**本地开发环境**（非生产）的测试库，且经**项目负责人明确同意逐条删除**时，才可物理删除。**生产环境审计日志任何情况下不得物理删除。**
4. `TestRecord` 等业务数据表不受此规则约束，确认为测试数据后可正常清理。

> ⚠️ **已知冲突（须警惕）**：`backend/routes/auditRoutes.js` 存在 `DELETE /api/audit-logs/cleanup?days=N`（按天批量删除审计日志）。该端点与本条规则冲突，属未收敛的技术债（TD-P2-13）。**生产环境严禁调用此端点**；规则一优先级高于该端点。如需「清理」，只能走规则一第 2 条的"追加说明"方式。

---

## 规则二：方法偏离预先报备原则

1. 若认为用户 / 需求文档指定的具体实现方法不是最优，且计划采用替代方法，必须**在执行替代方案之前**明确说明："计划使用 XXX 方法替代原定 YYY 方法，理由是 XXX"，并给出简要影响说明，而非事后在报告中补充说明。
2. **预先报备 ≠ 预先等待批准**：报备后可继续执行，不需要停下来等待确认；但"报备"动作本身不能省略。
3. 仅在用户明确追问或要求变更方案时，才可直接切换方法而不必每次报备。

> 示例：多学校隔离由"每校物理分部署"改为"单应用 + Schema-per-tenant（方案②）"、访问层由 `school_<code>` 前缀改为 `schoolCode` 即 schema 名（方案A），均属已在该项目历史沿革中报备并已落地的偏离，本规范据此固化。

---

## 规则三：多学校数据隔离（Schema-per-tenant）操作红线

本规则保护"50+ 学校共享单应用单库但数据互不串"的核心架构。

1. **唯一切换点**：所有 `search_path` 切换必须经由 `backend/lib/tenantClient.js` 的 `setSearchPath(tx, schoolCode)`（执行 `SET LOCAL search_path TO "<schema>", public`）。**禁止在业务代码里手写 `SET search_path` 或用 `$executeRawUnsafe` 拼接 schema 名绕过此切换点。**
2. **禁止为每校各自 `new PrismaClient()`**（会退化为连接膨胀的方案③）。全应用只有**一个全局 PrismaClient 单例**（在 `server.js` 创建），租户隔离靠请求级 `SET search_path`，而非多连接。
3. **`schoolCode` 即 schema 名**：`resolveSchemaName(schoolCode)` 直接返回 `schoolCode`（已含连字符清洗）。不要再加 `school_` 前缀或做任何映射。
4. **系统表恒在 `public`**：`School` / `SchoolCustomization` 只存在于 `public`，访问时**必须带显式 `public.` 前缀**且**不能**经由 `req.db`（租户客户端会把查询路由到租户 schema）。现有实现：`server.js` 的 `/api/school/config`、`/api/schools/:schoolCode/config` 直接用全局 `prisma.$queryRawUnsafe('SELECT ... FROM public."School" ...')`。
5. **业务 handler 一律经 `req.db`**：租户相关读写（如 `req.db.testRecord.findMany`、`req.db.auditLog.create`）必须走由中间件注入的请求级客户端，`禁止`在 handler 内直接使用全局 `prisma.<model>`（否则落到默认 schema，造成跨校串数据）。`UserManager` 内部则通过 `forTenant(schoolCode)` 拿到绑定租户客户端的副本。
6. **`Passthrough` 集合不可随意扩大**：`tenantClient.js` 中的 `PASSTHROUGH`（`$connect`/`$disconnect`/`$use`/`$extends`/`$on`/`$metric`/`$applyPendingMigrations`）是明确透传、不包事务的方法；新增透传项须评估是否会破坏 search_path 包裹语义。
7. **连接池竞态解决方案（已定稿事务包裹，预留切换）**：当前每个 model 方法调用都被包进 `prisma.$transaction(async tx => { setSearchPath(tx, code); ... })`。未来若切到 **PgBouncer（pool_mode=session）**，只需改 `tenantClient.js` 的 `setSearchPath` 与 `createTenantClient`（去掉事务包裹、仅在获取连接时设一次 search_path），**业务 handler 代码零改动**。在切换完成前，不得为了减少事务开销而移除事务包裹。
8. **新增学校流程（标准动作）**：
   - 在 PG 实例建 schema（名= `schoolCode`）；推荐用 `scripts/provision-school.sh`（`SCHOOL_CODE=xxx DATABASE_URL=postgresql://... bash scripts/provision-school.sh`）从 `school_template` 克隆租户表（自动排除系统表）。
   - 在 `public."School"` 登记该校（`code=schoolCode, name=..., status='active'`），并按需在 `public."SchoolCustomization"` 写个性化配置。
   - 在 `School` 中 `status != 'active'` 时，公开配置端点会返回 404，登录前应被前端拦截。
   - **新增学校时 `deploy/deploy.sh` 与 `deploy/*.conf` 必须零改动**（单应用原则，见规则十）。

---

## 规则四：认证与授权统一

1. **统一中间件工厂，禁止重复实现**：认证 / 授权必须经由 `backend/middleware/authMiddleware.js` 的 `createAuthMiddleware(userManager)` 导出的 `authenticateUser` / `authorizeAdmin` / `authorizeRoles(...)`。**禁止在路由文件内重新实现 Bearer 解析或手写角色判断。**
2. **`authenticateUser` 之后必须挂租户客户端**：`server.js` 中 `authenticateUser` 在校验通过后调用 `attachTenant`（来自 `tenantMiddleware.js`），注入 `req.db` 与 `req.tenantSchema`。任何受保护 handler 都从 `req.db` 取数据。
3. **JWT 携带 `schoolCode`**：`UserManager.buildAccessToken` 在 payload 写入 `schoolCode`，登录时从 `req.body.schoolCode`（登录前尚未认证，故从请求体取）经 `forTenant(schoolCode)` 路由到对应 schema 的 `User` 表校验。
4. **登录前公开端点**：`GET /api/schools/:schoolCode/config` 在**未认证**状态下即可调用，用于登录页个性化（返回 `name`/`shortName`/`themeColor`/`logoUrl`/`customization`）。它只读 `public` 系统表，且对未激活 / 不存在的学校返回 404。**新增个性化字段须同时兼容该端点与 `/api/school/config`（登录后，带 `req.user.schoolCode`）。**
5. **RBAC 矩阵（概要，详细见 `README.md` §7）**：写操作由 `requireEditorOrAbove` 拦截（`guest`/`viewer` 一律 403）；用户管理需 `authorizeRoles('admin','manager')`；审计日志管理仅 `admin`。新增受保护接口时，必须显式挂对应授权中间件，不得默认放行。

---

## 规则五：审计日志写入规范（收敛三套，指向 TD-P2-13）

系统当前存在三套审计日志（技术债 TD-P2-13，字段口径尚未统一），但**写入位置有明确分工，新增审计逻辑须对号入座**：

1. **记录类 CRUD / 批量导入**：经 `server.js` 的 `writeRecordAuditLog(db, userId, action, resourceType, resourceId, details, ip)` 写入**当前租户 schema 的 `auditLog`**（注意首参是 `req.db`，保证落在该校 schema）。已在 `test-records` / `records` 的增改删与批量导入中调用。
2. **通用操作审计**：经 `POST /api/audit-logs`（前端 `AuditLogService` 调用），写入字段完整（含 `ip_address`）。**禁止**在 handler 内裸写 `req.db.auditLog.create` 绕过统一封装（会漏掉 IP、破坏口径）。
3. **登录 / 失败登录**：经 `UserManager.logLogin` / `logFailedLogin`（登录成功写 `auditLog`；用户不存在时因外键约束改写 `systemLog`）。
4. **前端离线日志**：`js/utils/AuditLogger.js` 写入 `localStorage` 的 `audit_YYYY-MM-DD`（保留 30 天），仅作离线兜底，不进库。
5. 统一审计接口设计（合并三套、统一字段）属待办，**在 TD-P2-13 完成前，维持上述分工，不得自行新增第四套审计写入路径**。

---

## 规则六：数据库迁移与 Seed 规范

1. **`schema.prisma` 是唯一数据模型真相源**，`provider` 必须为 `postgresql`（已弃用 sqlite 分支）。
2. **迁移只用 Prisma**：`prisma db push` / `prisma migrate dev` / `prisma generate`。`backend/sql/*.sql`（PostgreSQL/Supabase + RLS、含历史 seed 明文密码）**仅作 schema 参考，禁止**在运行时 `psql` 直接执行它们作为迁移手段（其 `password_hash` 为旧占位值）。
3. **Seed 不覆盖已有账号**：`prisma/seed.js` 用 `ensureUser` 仅在账号不存在时创建 `admin`/`operator`/`viewer`；已存在则跳过，避免部署覆盖已改密码。
4. **生产默认不 seed**：`NODE_ENV=production` 且未设 `SEED_ALLOW_PROD=true` 时，seed 直接跳过（防默认凭据泄露）。首次部署由 `SEED_ON_FIRST_DEPLOY=true` + 数据库不存在触发。
5. **强密钥门槛**：`JWT_SECRET` 缺失或命中弱密钥黑名单（`server.js` 中 `KNOWN_WEAK_SECRETS`，如 `food-lab-secret-key`、`local-dev-jwt-secret` 等）→ **进程直接 `exit(1)`**，杜绝占位密钥签发令牌。seed 密码须 ≥8 位且含字母与数字。
6. **已知待办（已报备，尚未执行）**：`deploy/deploy.foodtestlab.conf` 与 `deploy/deploy.sh` 的 `DB_TYPE` 仍为 `sqlite`、`DATABASE_URL` 仍拼接 `file:...db`、安装项仍含 `sqlite3` 而非 PG 客户端——与代码层 `postgresql` 冲突。修改该部署脚本做 PostgreSQL 化（装 PG、建库、按 `DATABASE_URL` 连库、移除 sqlite 依赖）属既定下一步，但**在动手前须再次确认，且严禁反向把 `schema.prisma` 改回 sqlite**。

---

## 规则七：前端访问层与 schoolCode 提取唯一性

1. **业务代码不依赖具体路由机制**：前端任何模块都**不得**直接解析 `window.location.pathname` / `hostname` 来判断学校；一律依赖 `js/utils/schoolCode.js` 的 `extractSchoolCode()` 返回值。当前从路径前缀 `/<code>/` 提取，回退到 `?school=` 查询参数。
2. **切换成本隔离**：未来从"路径前缀"切到"子域名"（`school-a.example.com`）时，**只允许替换 `schoolCode.js` 内部实现**，其余业务代码与标识来源无关，不得因此改动 handler / 服务 / 组件。
3. **登录前个性化**：`login.html` 在页面加载时若有 `schoolCode`，调用 `/api/schools/:schoolCode/config` 应用 `name`/`themeColor`/`logoUrl`，失败不阻断登录流程（见 `login.html` 的 `applySchoolTheme`）。
4. **登录携带 schoolCode**：`AuthService.login(username, password, schoolCode)` 必须把 `currentSchoolCode` 一并上报（写入请求体 `schoolCode`），供后端 `forTenant` 路由。

---

## 规则八：API 设计与幂等 / 并发约定

1. **统一响应格式**：成功多返回 `{ success: true, data, ... }`；错误返回 `{ error, details? }` 并带正确 HTTP 状态码。新增接口须遵循，不得发明新封装。
2. **确定性幂等键 `record_code`**：`RC-{test_type}-{sha256(规范化 payload)}`（`server.js` 的 `buildDeterministicRecordCode`）。重复提交命中唯一约束时返回已有记录（前置查 + P2002 兜底），不得重复创建。
3. **乐观锁**：`TestRecord.version` 更新时若 `clientVersion !== serverVersion` 返回 **409**，由前端拉取最新后重试；`bulk-upsert` 自增 `version`。
4. **`Idempotency-Key` 头**：`/api/records` 挂 `idempotencyMiddleware`（内存存储，单实例 / 低并发）；重试客户端可带该头避免重复写入（生产建议 Redis，见该中间件注释）。
5. **并发错误映射**：P2002（唯一约束）→ 返回已有记录；P2003（外键失败，如 `created_by` 用户不存在）→ **422** 而非 500。
6. **静态路由前置于动态路由（Express 最佳实践）**：如 `/api/audit-logs/stats/summary`、`/export`、`/cleanup` 必须定义在 `/:logId` **之前**，避免被动态参数吞掉。新增带参数的路由时遵守此顺序。
7. **限流**：全局 `rateLimit(1000/60s)`（按 IP 滑动窗口，429）；登录接口额外 `loginRateLimit`（默认 10/15min）。新增高成本接口应考虑单独限流。

---

## 规则九：安全基线

1. **JWT 弱密钥拒绝启动**：见规则六第 5 条。
2. **CORS 白名单**：`server.js` 的 `parseAllowedOrigins` + `parseAllowedHostnames` 精确匹配来源；非白名单来源**不下发 CORS 头并记录告警**（不抛 500）。生产必须通过 `CORS_ORIGIN`（或 `CORS_HOSTNAMES`）配置，禁止把 `*` 用于生产。
3. **输入安全**：`validationMiddleware` 提供 `detectXss` / `detectSqlInjection` / `escapeHtml` / `sanitizeHtml` / `sanitizeText`。前端 `FormValidator` 的 `xss` / `sqlInjection` 规则须与后端保持一致（**后端为超集**）。
4. **密码**：bcryptjs 哈希（`password_hash`），不落明文；后端 `fieldValidators` 约束 `username`/`phone`/`password` 格式；`isStrongPassword` ≥8 位且含字母与数字。
5. **请求体上限**：`express.json({ limit: '10mb' })`。
6. **生产不暴露默认凭据**：见规则六第 4 条（seed 跳过 + 强密码）。

---

## 规则十：部署规范（Caddy + systemd + 单应用）

1. **单应用原则**：所有学校共用同一套应用代码、同一 Caddy 站点、同一 systemd 服务、同一 PG 实例。新增学校**不得**新增端口 / 服务 / 适配文件。
2. **Caddy `school-*` 通用重写规则（验收硬指标）**：`deploy/deploy.sh` 生成的站点片段含：
   ```
   @schoolLogin path /school-*/login /school-*/login.html
   rewrite @schoolLogin /login.html
   ```
   该规则使 `/school-a/login` 返回登录页而**浏览器 URL 不变**（前端仍可读 schoolCode）。**新增第 N 所学校时本配置文件必须零改动**；不得为某所学校写死专属 location。
3. **脚本与适配分离**：`deploy/deploy.sh` 是通用流程（不含任何学校名/端口/路径硬编码）；`deploy/deploy.<系统>.conf` 仅描述"这套环境长什么样"（如 `deploy.foodtestlab.conf`）。换用户 / 换服务器只改适配文件。
4. **部署前置（脚本无法代劳，必须人工确认）**：
   - 腾讯云**安全组**放行 TCP 22 / 80（上域名后加 443）；漏配会"本机健康检查通过但外网超时"。
   - **数据盘持久化挂载**（如 `/mnt/datadisk0` 写入 `/etc/fstab`）；`REQUIRED_MOUNT` 未挂载脚本直接中止，防数据静默写回系统盘。
   - 外网出站可达 `github.com` 与 `registry.npmjs.org`（脚本预检）。
5. **前端构建产物完整性**：`scripts/build-static.js` 仅复制静态资源到 `dist/`，**必须包含 `login.html` 与 `index.html`**（登录页个性化依赖 `dist/login.html`）。改构建脚本时不得遗漏 `login.html`。
6. **禁止把 `DB_TYPE` 改回 sqlite**（见规则六第 6 条）；部署脚本 PostgreSQL 化是既定下一步，须与代码层 `provider=postgresql` 保持一致。
7. **多用户同机**：每用户独立 `FRONTEND_PORT`/`API_PORT`/`SYSTEM_NAME`，Caddy 采用主配置 `import` 站点目录（`/etc/caddy/sites/*.caddy`），预检端口冲突；重跑某用户不冲掉其他用户站点。

---

## 规则十一：代码分层与依赖方向（前后端）

### 11.1 后端分层（依赖单向，禁止反向）
```
server.js（入口/路由/中间件装配）
  └─ routes/*（userRoutes / auditRoutes / syncRoutes）
       └─ modules/UserManager.js（业务逻辑）
            └─ lib/tenantClient.js（租户隔离抽象）
                 └─ PrismaClient 单例（全局）
  └─ middleware/*（auth / tenant / validation / idempotency）
```
- 路由层只做参数解析 + 授权 + 调 `UserManager` / `req.db`；重业务逻辑放进 `UserManager`。
- `tenantMiddleware` 在 `authenticateUser` 后注入 `req.db`；handler 不直接 new 客户端（见规则三）。
- `backend/config/telemetry.js`、`backend/sql/*.sql` 当前**未被 `server.js` 引入**（依赖未装 / 历史遗留），属 TD-Backend-Orphan；新增可观测性须先 `npm install` 对应依赖并以 `--import` 方式接入，**不得**在已有 handler 里内联埋点。

### 11.2 前端（原生 ESM，无框架）
- **入口**：`login.html`（登录）、`index.html`（主应用）、`js/main.js`（DOMContentLoaded 总初始化）。
- **通信方式**：导航与跨模块通信统一走**事件委托 + `CustomEvent`**（`app:navigate`、`dashboard:refresh`）。**禁止**挂 `window.xxx` 全局函数供模块互调（历史 `window.renderQuickAccessData` 等已移除，新代码不得复活）。
- **权限守卫**：`js/core/Router.js` 负责按角色显隐 admin/guest 菜单、Token 定时校验、30 分钟空闲登出。菜单项用 `data-admin-only` 标记仅管理员可见。
- **状态存储约定**（无集中状态库）：`localStorage` 键包括 `auth_token`/`current_user`/`guest_token`（登录态）、`cache_<table>`（记录缓存）、`pending_<table>`（待同步队列）、`fingerprint_index_<table>`（去重索引）、`audit_YYYY-MM-DD`（离线日志，保留 30 天）。新增持久化键须带语义前缀，避免与现有键冲突。
- **离线优先数据层**：`js/core/Storage.js`（`StorageService`）是核心——离线优先、乐观写入（`temp_` 临时 ID）、三层去重、429 全局退避、409 版本冲突恢复。新检测模块的数据读写应走该服务，而非裸 `fetch`。
- **禁止新增孤儿模块**：`js/utils/` 中 `CacheManager`/`ConfigManager`/`UserAuth`（ESM 但无人 import）、`IndexedDBManager`/`OfflineModeManager`/`PerformanceMonitor`（CommonJS 风格，无法被 ESM import）均为遗留未启用产物（TD-Orphan）。新功能请在既有模块或新增被正确 import 的模块中实现，不要制造新的孤立文件。

---

## 规则十二：测试、构建与质量门禁

1. **Lint 零错误**：提交前确保改动文件 `read_lints` 无 error（历史遗留 warning 不要求清零，但新增代码不得引入 error）。
2. **构建**：`npm run build` → `scripts/build-static.js` 仅复制静态资源到 `dist/`（无转译 / 无打包）。改 `js/` 或 `login.html`/`index.html`/`css/` 后必须重新构建，`dist/` 不纳入版本控制的源码。
3. **测试骨架**：Jest 29（`jest.config.cjs` + babel-jest + jsdom）冒烟；Cypress 12（需先起静态服务器）。新增纯函数（如 `Validator`、`pathogenRisk`、`schoolCode` 解析）应补单测。
4. **自测闭环**：后端改动后 `curl /api/health`；前端改动后确认 `dist/login.html` 可被 Caddy 重写规则命中（即 `/school-a/login` 能渲染登录页）。

---

## 13. 已知技术债务与「已报备未执行」清单

为避免重复踩坑，列出当前未解决项；其中标注 ✅报备 的为已向项目负责人报备、可继续执行但须对齐本规范的项目。

| 编号 | 描述 | 状态 |
|------|------|------|
| TD-P2-13 | 三套审计日志字段口径未统一，待统一审计接口设计 | 分工维持（规则五） |
| TD-Guest | `GuestAuthService` 调用的 `/api/guest/login`、`/register`、`/verify-token`、`/api/guest-export-request/*` 后端未实现（仅 `quick-access` 可用） | open |
| TD-Auth-Path | `AuthService` 部分路径与后端不一致（改密码 `PUT /api/user/password` vs 后端 `POST /change-password` 等） | open |
| TD-Users-Dup | `server.js` 内联 `/api/users*` 与 `userRoutes` 功能重复 | open |
| TD-Session | `SessionManager` 会话同步为 TODO 占位 | open |
| TD-Orphan | 前端遗留孤儿模块、`backend/sql/*.sql`、`backend/config/telemetry.js` 未启用 | open |
| TD-Naming | 根 `package.json` name 旧名；`.env.example` 含 Windows 旧字段 | open |
| TD-Tenant | 连接池竞态选型：当前事务包裹，PgBouncer Session 模式待拍板（预留切换点已就位） | ✅报备 |
| **DB_TYPE 冲突** | `deploy/deploy.sh`/`deploy.foodtestlab.conf` 仍为 `sqlite`，与代码 `postgresql` 冲突，部署会失败 | ✅报备待改（规则六.6 / 规则十.6） |

---

## 14. 相关文档

- 系统总览（项目入口）：[`README.md`（根）](../README.md)
- 文档中心（docs 索引）：[`docs/README.md`](./README.md)
- 开发文档（随代码更新）：[`docs/DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md)
- 部署说明：[`deploy/README.md`](../deploy/README.md)
- 后端说明：[`backend/README.md`](../backend/README.md)
- 历史归档（仅供参考，非权威）：[`docs/history/`](./history/)
