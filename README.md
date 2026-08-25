# 食品检验系统（foodtestlab）

> 本 README 基于**当前仓库实际代码**编写，是项目的系统级总览文档。
> 深入的开发细节见 [`docs/DEVELOPMENT_GUIDE.md`](./docs/DEVELOPMENT_GUIDE.md)；长期操作规范见 [`docs/PROJECT_CONVENTIONS.md`](./docs/PROJECT_CONVENTIONS.md)（优先级最高）；近期变更见 [`docs/CHANGELOG.md`](./docs/CHANGELOG.md)。
>
> **文档同步状态**：`package.json` 当前版本 **`3.1.0`**；本文档已于 **2026-08-24** 据全量代码复核同步修订（后端洗涤剂识别排队服务已挂载启用、审计日志筛选增强等）。

---

## 目录

1. [系统概述](#1-系统概述)
2. [技术栈总览](#2-技术栈总览)
3. [系统架构图](#3-系统架构图)
   - [3.4 代码目录结构](#34-代码目录结构)
4. [数据库设计](#4-数据库设计)
5. [API 接口文档](#5-api-接口文档)
   - [5.11 洗涤剂比色识别](#511-洗涤剂比色识别api-recognize挂载于-serverjs-appuseapi-recognitionroutes)
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

除五类检测外，系统还提供以下平台能力（2026-08 陆续落地）：

- **检测频率管理**（N1/N2/N3）：每周检测目标阈值、按周几的检测日历、检测月报与趋势分析。
- **数据备份引擎**（P0/P1）：`pg_dump` 逻辑备份 + AES 信封加密 + 完整性校验 + 影子恢复（双 rename 原子切换，零窗口）。
- **学校回收站**：彻底删除学校先软删除、再进回收站（保留 90 天可恢复），杜绝误删。
- **字段选项级联**：动态表单字段（如「检测项目 → 检测点位」）的级联选项配置。
- **浏览器测试报告**：测试人员在线填报、汇总、收口归档的辅助工具（`test-report.html`）。
- **洗涤剂残留自动识别**：基于 OpenCV.js（WASM）的 ArUco 定位 + 单应校正 + ΔE2000 比色，前后端共用核心 `js/opencv/recognizer.js`（A4 拍摄卡四角定位标）。前端 `detergent-image-demo.html`（`js/modules/detergentDemo.js`）为「先定位区域 → 用户确认 → 再比色」的两步式演示/采集界面；后端 `backend/modules/recognitionQueue.js` + `backend/routes/recognitionRoutes.js` 提供单 Worker 排队式识别服务，已挂载于 `server.js:311` `app.use('/api', recognitionRoutes)`，对外暴露 `POST /api/recognize`（提交，图片 ≤8MB）与 `GET /api/recognize/status/:jobId`（轮询，排队超 5 分钟报错），进程启动时 `recognitionQueue` 自动 pump（见 §5.11）。

### 目标用户

- **平台超管（admin，无学校归属）**：管理所有学校（新增/编辑/停用、回收站、界面定制、管理学校用户、运维备份），拥有 `schools:manage` 权限。通过学校管理控制台（`admin-schools.html`）操作。
- **学校管理者（manager）**：学校内最高权限，用户与权限管理、审计日志、检测频率配置、全部业务操作。学校首个账号即为 manager。
- **检测员（operator）**：录入与维护检测记录（仅可修改本人创建的记录）。
- **只读用户（viewer）**：学校**内部**只读员工账号，可查看看板与全部检测记录（含致病菌）、导出 PDF，但无写入权限；走正常登录，为持久账号。与 `guest` 是两套独立体系。
- **访客（guest，快速访问）**：面向**外部/临时**人员的只读访问，落独立 `Guest` 表，分两种——
  - `readonly`：免凭证快速访问（JWT 2h），模块白名单受限（不含致病菌）、默认无导出权限；
  - `export_applicant`：自助注册、可提交数据导出申请，经审批后开通 `has_export_permission`。
  - 与 `viewer` 的差异：访客有模块隔离（去致病菌）、默认无导出、可时效过期、走轻量独立鉴权。

### 部署形态

- **腾讯云 CVM（Ubuntu 22.04+）** 单机部署；**Caddy** 反向代理（对外）+ **systemd** 托管 Node 后端（仅监听 `127.0.0.1`）。
- 数据库为 **PostgreSQL**，落在独立数据盘 `/mnt/datadisk0`（与系统盘生命周期解耦）。开发/测试/生产**统一使用 PostgreSQL**，仅在 schema 隔离策略上不同（dev/test 共享 schema，prod 每校一 schema）。
- 前端为**原生 ES Module 静态资源**（无打包器），由 Caddy 直接托管 `dist/`。
- **多学校架构（方案② Schema-per-tenant）**：50+ 学校共用同一套应用与同一份数据模型，每校数据存放在 PostgreSQL 的**独立 schema**（表结构一致）；应用层按当前登录学校经 `?schema=` 连接串路由（`backend/lib/tenantClient.js` 的 `createTenantClient` 为每校缓存独立 PrismaClient）。开发/测试环境使用单一共享 schema，不做隔离。

> 命名已品牌中立化：根 `package.json` 的 `name` 为 `foodtestlab`，部署统一使用 `SYSTEM_NAME=foodtestlab`；具体学校名均为 `School` 表中的数据，由登录时按 `schoolCode` 动态读取，业务运行逻辑不依赖任何学校专有命名（历史残留如 `package.json` 的 `author: "Tianjiabing Team"` 与 `Storage.js` 内「田家炳中学」脏数据迁移注释，属已知待清理项，不影响运行）。每校的界面 / 显示内容 / 字段要求的差异，统一由 `public` 系统表中的 `SchoolCustomization` 承载（外观 `theme_color`/`logo_url`/`theme_config`、可见检测类型 `visible_types`、可见菜单项 `visible_menu_items`、食堂信息 `canteens`、字段标签 `field_labels`、隐藏字段 `hidden_fields`、字段必填/校验规则 `field_rules`、下拉选项 `field_options`、字段类型 `field_types`、字段顺序 `field_order`、自定义字段 `custom_fields`、自定义检测类型 `test_types`、访客开关 `guest_enabled`），新增学校零改码。学校管理控制台（`admin-schools.html`，平台超管独有）提供 GUI 完成学校全生命周期管理：新增学校（自动建 schema + 推表 + 首个 manager 账号）、编辑学校信息与外观、配置字段定制、管理学校用户（查看/重置密码/启停用）、回收站管理。

---

## 2. 技术栈总览

| 层 | 技术 | 说明 |
|----|------|------|
| 后端运行时 | Node.js 20（NVM）、Express 4 | ESM（`"type":"module"`），入口 `backend/server.js` |
| ORM / 数据库 | Prisma 5 + **PostgreSQL** | `backend/prisma/schema.prisma`，`provider = postgresql`，`DATABASE_URL=postgresql://...` |
| 认证 | jsonwebtoken 9 + bcryptjs 2 | 无状态 JWT（Bearer）+ refresh token 轮转，bcrypt 密码哈希 |
| 前端 | 原生 ES Module + Tailwind(CDN) | `index.html`/`login.html` + `js/**/*.js`，浏览器直载 |
| 前端数据层 | `StorageService` + `AdaptiveUploadQueue` | 离线优先：本地缓存 + 待办队列 + 多层去重 + 429/409 处理 |
| 前端构建 | `scripts/build-static.js` + Tailwind CLI | 复制静态资源到 `dist/` 并编译 CSS（无转译/打包） |
| 备份 | `pg_dump` + AES-256-GCM 信封加密 + KMS | `backend/lib/backupKms.js`/`backupService.js`/`backupVerify.js` |
| 反向代理 | Caddy 2 | 自动 HTTPS（有域名时）、同域反代 `/api`、静态托管 |
| 进程管理 | systemd | `MemoryMax` 内存上限、崩溃自动重启 |
| 测试 | Jest 29（babel-jest + jsdom）、Cypress 15 | 冒烟骨架 + E2E，`.cjs` 配置 |

---

## 3. 系统架构图

### 3.1 部署拓扑

```mermaid
flowchart TB
    subgraph Client[浏览器]
        UI[静态前端 ES Module<br/>index.html / js/** / test-report.html]
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
        S1[schema: school_a]
        S2[schema: school_b]
        Sn[schema: school_n ...]
    end
    Caddy --> API --> PG
    PG --> Schemas
    API -.按 schoolCode 经 ?schema= 连接串路由.-> Schemas
```

> 「多学校」= **单套应用 + 单 PostgreSQL 实例 + 每校独立 schema**（非物理分部署，也非单表 `school_id` 混放）。表结构全校一致；`backend/lib/tenantClient.js` 的 `createTenantClient(prisma, schoolCode)` 为**每个 schema 缓存一个独立 `new PrismaClient`**（连接串带 `?schema=<schema>`，LRU 缓存上限 `MAX_TENANT_CLIENTS=25`、每客户端连接上限 `TENANT_CONNECTION_LIMIT=3`），把 Prisma 的 model 查询硬绑定到对应 schema——这是 Prisma 官方推荐的 schema 隔离方式（schema 名编译进 SQL，非运行时 search_path）。学校代码（schoolCode）为**短代码**（如 `tianjiabing` / `gtest`，`isValidSchoolCode` 仅允许 `[a-z0-9-]{1,40}`，不含下划线）；schema 名 = `schemaNameOf(schoolCode)` 归一为 `school_<code>`（`-` 替换为 `_`，如 `gtest` → `school_gtest`；兼容 `school-xxx` / `school_xxx` 历史写法，幂等）。拼进连接串前 `assertSafeSchemaName` 强制 `/^school_[a-z0-9_]+$/` 且 ≤63 字符白名单。开发/测试环境用单一共享 schema（`DEFAULT_SCHEMA=public`）。
>
> ⚠️ **历史文档曾描述「请求级 `SET search_path` 路由 + Proxy」方案，已证伪并废弃**：Prisma 把 schema 名硬编码进生成的 SQL，`SET LOCAL search_path` 对 model 查询无效（仅裸 `$queryRaw` 生效，如 `provisionSchool` 建初始 admin 时）。**切勿重新引入 search_path / Proxy 方案。**
>
> 服务启动时由 `selfHealTenantSchemas()` 在后台把全部**启用中（`status='active'`）**的租户 schema 与当前 `schema.prisma` 对齐（内部调 `syncAllTenantSchemas`，单校失败不阻断其余）并回填历史 NULL（可经 `AUTO_SYNC_TENANTS=false` 关闭，改由 `npm run db:sync` 手动执行）。停用学校不纳入批量同步（逻辑删除）。
>
> **多租户访问识别（路径前缀路由，方案 A）**：学校代码即部署基路径首段，学校应用按 `/<code>/` 子路径部署（`/<code>/login.html`、`/<code>/index.html`）。前端 `js/utils/schoolCode.js` 的 `extractSchoolCode()` 是访问层**唯一**依赖「路径/域名」的代码位置：优先从路径首段 `/<code>/...` 提取，兜底 `?school=<code>` 查询参数（无标识时回落 dev/test 共享 schema；路径优先于查询，防用户篡改租户）。**生成端（`buildSchoolLoginUrl`）只产出纯路径形式 `/<code>/login.html`，不拼接 `?school=`**；解析端保留查询兜底仅作兼容/排查入口。「`/<code>/<resource>` → `/<resource>`」的重写**生产环境由 Caddy 层完成**（`@schoolLogin`/`@schoolHelp` rewrite + `handle` 互斥，见 §8.4），后端 `server.js` 的同名中间件仅在 `SERVE_STATIC=true`（本地开发）时生效；`RESERVED_STATIC_DIRS` 白名单排除 `css/js/api/health` 等保留名，故 schoolCode 不得为 `api`、`health` 或任何静态目录名。

### 3.4 代码目录结构

> 本节基于仓库实际目录（`list_dir`，已折叠生成式目录 `node_modules/`、`dist/`、`.git/`、产物 `coverage/`、`vendor/` 等非源码树）。前端 `js/` 内部的组件级划分另见 §6.2。

```text
foodtestlab/
├── index.html / login.html           # 前端入口（原生 ES Module，浏览器直载）
├── admin-schools.html                # 平台超管：学校全生命周期管理控制台
├── super-admin-login.html            # 平台超管登录页
├── help.html / test-report.html / detergent-image-demo.html  # 帮助/测试报告/洗涤剂演示页
├── package.json                      # 根依赖与脚本（name=foodtestlab, version=3.1.0, type=module）
├── jest.config.cjs / cypress.config.cjs / tailwind.config.cjs / .babelrc  # 测试与构建配置
├── backend/                          # ★ Node/Express 后端（ESM）
│   ├── server.js                     # 入口：CORS/JWT 启动守卫、路由挂载（含 recognitionRoutes @311）
│   ├── package.json                  # 后端专用依赖（Prisma/Express 等）
│   ├── lib/                          # 核心库（20 个）：tenantClient（多租户）、backupService/backupKms/
│   │                                 #   restoreService（备份恢复）、auditLog、securityGuards/securityAlerts、
│   │                                 #   tenantProvisioner/tenantSync（租户置备）、customizationValidate 等
│   ├── routes/                       # HTTP 路由层（12 个）：school/user/audit/session/guest/frequency/
│   │                                 #   recognition/record/sync/admin/backups/test-results
│   ├── middleware/                   # 中间件：auth（JWT）、tenant（租户路由）、readOnly（viewer 只读）、
│   │                                 #   idempotency（幂等）、validation
│   ├── modules/                      # 业务模块：recognitionQueue（洗涤剂识别排队）、UserManager
│   ├── prisma/                       # Prisma schema.prisma + migrations/ + 种子/置备脚本（*.sql/*.js）
│   ├── scripts/                      # 后端运维脚本（16 个 *.mjs）：迁移、角色迁移、备份导入等
│   ├── uploads/                      # 运行时上传目录（107 PNG，属产物，建议 gitignore）[需人工确认是否入库]
│   └── backups/                      # 运行时备份落盘目录（属产物，建议 gitignore）[需人工确认是否入库]
├── js/                               # ★ 前端（原生 ES Module，无打包器）
│   ├── main.js                       # 应用引导入口
│   ├── core/                         # 核心：Router（路由/权限守卫）、Storage（离线优先数据层）、
│   │                                 #   Auth、AdaptiveUploadQueue（自适应上传队列）
│   ├── services/                     # 服务层：AuthService、AuditService、PermissionService（RBAC 矩阵）、
│   │                                 #   ExportService、GuestAuthService、SessionManager
│   ├── modules/                      # 业务/页面模块：Dashboard/Tableware/Pathogen/GenericTest/FrequencyModule/
│   │                                 #   AuditLog/UserManagement/BackupRestore/adminSchools/SuperAdminAccount/
│   │                                 #   GuestDashboard/detergentDemo 等 + registry.js（模块注册中心）
│   ├── opencv/                       # 洗涤剂识别前端核心 recognizer.js（与后端共用算法）
│   ├── config/                       # 前端配置
│   └── utils/                        # 工具函数（schoolCode/schoolCustomization 等）
├── css/                              # 样式与字体（Tailwind 编译产物 + ttf/woff2）
├── tests/                            # ★ Jest 单元测试/集成测试（31 个 *.test.js + integration/ + setup-env.js）
├── cypress/                          # ★ Cypress E2E（e2e/ + support/）
├── scripts/                          # 根级运维脚本：build-static.js（构建 dist/）、provision-school.sh、
│                                   #   backup-alert.sh、*.mjs 迁移与文档同步
├── deploy/                           # 部署配置：deploy.sh + Caddy 片段 *.conf + README/就绪报告
├── docs/                             # 文档：DEVELOPMENT_GUIDE / PROJECT_CONVENTIONS / CHANGELOG 等（19 md + 图）
└── vendor/                           # 第三方静态库（生成式/外部依赖，建议 gitignore）[需人工确认]
```

**结构合理性评估（基于现有代码）**

| 维度 | 评价 | 说明 |
|------|------|------|
| 前后端分层 | ✅ 合理 | `backend/`（服务端 ESM）与 `js/`（浏览器 ESM）物理隔离，职责清晰，无交叉打包。 |
| 后端内部划分 | ✅ 合理 | `lib / routes / middleware / modules / prisma / scripts` 按"基础设施 / 接口 / 横切 / 业务 / 数据 / 运维"职责分离，符合 Express 惯例。 |
| 前端内部划分 | ✅ 合理 | `core（内核）/ services（服务）/ modules（页面业务）/ utils（工具）/ opencv（算法）` 分层清晰；`registry.js` 作为模块单一事实来源，新增检测类型零改码。 |
| 测试隔离 | ✅ 合理 | `tests/`（Jest 单元/集成）+ `cypress/`（E2E）分目录，配置独立（`.cjs`），互不干扰。 |
| 配置集中 | ✅ 合理 | 构建/测试/部署配置均落在根目录与 `deploy/`、`scripts/`，入口明确。 |

**可优化项（非阻塞，供后续重构参考）**

1. **运行时产物混入源码树**：`backend/uploads/`（107 PNG）、`backend/backups/`、`coverage/`、`dist/`、`vendor/` 属运行/构建产物，应与源码分离并确认已被 `.gitignore` 排除（当前 `uploads/`、`backups/` 是否在忽略列表**需人工确认**）。
2. **脚本职责边界重叠**：根 `scripts/`（如 `*.mjs` 迁移）与 `backend/scripts/`（16 个 `*.mjs`）均含迁移/置备类脚本，二者命名空间未严格区分，长期可合并为统一 `scripts/`（含 `backend` 子命令）以减少歧义。
3. **根目录文档治理**：根目录并存 `README.md` / `README_DIFF.md` / `README.new.md` / `README_REVIEW.md` / `TASKS.md` 多个过程性文档，建议仅保留 `README.md` 为正式文档，其余过程稿移入 `docs/` 或归档，避免读者混淆"哪个是源文档"。
4. **多 package.json**：根与 `backend/` 各有一份 `package.json`，依赖与脚本存在一定重复（如 Prisma），需确保版本对齐（以根 `package.json#version=3.1.0` 为权威版本源）。

---

## 4. 数据库设计

数据源：`backend/prisma/schema.prisma`（`provider = postgresql`）。开发/测试/生产**统一使用 PostgreSQL**。所有主键为 `cuid()` 字符串。JSON 类字段（`TestRecord.sample_info` / `result_data`、`AuditLog.details`、`SystemLog.context`、`SchoolCustomization.*`、`BackupRun.table_counts`、`GuestExportRequest.request_data`）已统一采用 Prisma `Json` 类型（PostgreSQL **jsonb**，P1-4 升级），model 读写直接传对象（Prisma 自动序列化）；仅 raw SQL（`$queryRawUnsafe`）路径对 jsonb/text 列返回字符串，需 `safeParseJson` 兜底 parse。

#### 多学校隔离（Schema-per-tenant）

- 每校对应 PostgreSQL 中一个独立 schema（schema 名由 `schemaNameOf(schoolCode)` 归一为 `school_<code>`，如短代码 `gtest` → `school_gtest`），**所有 schema 的表结构与迁移完全一致**（同一份 Prisma schema）。
- 隔离由 `backend/lib/tenantClient.js` 的 `createTenantClient(prisma, schoolCode)` 实现：为每个 schema 缓存一个独立 `new PrismaClient`（连接串带 `?schema=<schema>`），Prisma 据此把 model 查询限定到该 schema。租户中间件在 `authenticateUser` 后挂 `req.db`（即当前校的 tenant client）。新增模型只需 `prisma db push` 推一次，新学校自动包含全部模型。
- **系统表与租户表的区分**：`School` / `SchoolCustomization` 始终位于 `public` schema（由基础 `prisma` 单例直接访问）；`User` / `AuditLog` / `TestRecord` / `TestItem` / `Attachment` / `Guest` / `GuestExportRequest` / `Session` / `FieldOption` / `FrequencyThreshold` / `DetectionCalendar` 均为租户级模型（落在 `school_<code>`）。`BackupRun` / `TestResult` / `SystemLog` 权威副本位于 `public`，但会随 `provisionSchool` 全量 `db push` 在各租户 schema 冗余空表（忽略即可）。
- **运行时 DDL 附加系统表（不在 `schema.prisma`，由启动/操作时 `CREATE TABLE IF NOT EXISTS` 创建，恒落 `public`）**：`revoked_tokens`（令牌吊销表，`jti` 精确吊销 + `user_all` 全量吊销，15 分钟清理一次过期记录）、`recycle_bin`（学校回收站，硬删学校时 `ALTER SCHEMA RENAME` 落此，保留 `RECYCLE_KEEP_DAYS=90` 天可恢复）。
- 备份/恢复/迁移按校独立：`pg_dump -n school_gtest mydb` 单独导出，`psql -d mydb -f school_gtest.sql` 单独恢复；迁校即导出该 schema 在目标库 `CREATE SCHEMA` 后恢复。
- 新增学校：`tenantProvisioner.provisionSchool({ code })` 用 `prisma db push ?schema=<租户>` 推全表并建初始 **manager** 账号（admin 角色仅平台超管拥有，学校内最高权限为 manager）。也可通过学校管理控制台 GUI（`admin-schools.html`）完成，零改码。
- 开发/测试：使用单一共享 schema（如 `public` 或 `dev`），无需逐校隔离。

### 4.1 ER 图

```mermaid
erDiagram
    User ||--o{ AuditLog : "user_id (Cascade)"
    User ||--o{ TestRecord : "created_by (Restrict)"
    User ||--o{ Guest : "created_by (SetNull)"
    User ||--o{ Session : "user_id (Cascade)"
    Guest ||--o{ GuestExportRequest : "guest_id (Cascade)"
    TestRecord ||--o{ TestItem : "test_record_id (Cascade)"
    TestRecord ||--o{ Attachment : "test_record_id (SetNull)"
    School ||--o| SchoolCustomization : "code → school_code (Cascade)"
    FieldOption ||--o{ FieldOption : "parent_option_id (Cascade)"

    User {
        string id PK
        string username UK
        string email UK "nullable"
        string password_hash
        string full_name "nullable"
        string phone "nullable"
        string role "default operator"
        string status "default active"
        string school_code "nullable"
        boolean must_change_password "default false"
        datetime last_login "nullable"
        datetime created_at
        datetime updated_at
    }
    AuditLog {
        string id PK
        string user_id FK
        string action
        string resource_type "nullable"
        string resource_id "nullable"
        json details "nullable"
        string ip_address "nullable"
        datetime created_at
    }
    TestRecord {
        string id PK
        string record_code UK
        string test_type
        string test_name
        json sample_info "default {}"
        json result_data "default {}"
        string status "default pending"
        string created_by FK
        int version "default 0"
        int data_version "default 1"
        datetime created_at
        datetime updated_at
        datetime completed_at "nullable"
    }
    TestItem {
        string id PK
        string test_record_id FK
        string item_name
        string item_code "nullable"
        string result "nullable"
        string notes "nullable"
        datetime created_at
    }
    Attachment {
        string id PK
        string test_record_id FK "nullable"
        string file_name
        string file_path
        int file_size "nullable"
        string file_type "nullable"
        datetime uploaded_at
    }
    Guest {
        string id PK
        string username UK
        string password_hash
        string email "nullable"
        string full_name "nullable"
        string created_by FK "nullable"
        string guest_type "default readonly"
        boolean has_export_permission "default false"
        datetime valid_until "nullable"
        string status "default active"
        datetime created_at
        datetime updated_at
    }
    GuestExportRequest {
        string id PK
        string guest_id FK
        string request_type
        string request_reason "nullable"
        json request_data "nullable"
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
    FieldOption {
        string id PK
        string module_code
        string field_code
        string value
        string label
        string parent_option_id FK "nullable"
        int sort_order "default 0"
        boolean is_default "default false"
        boolean is_builtin "default false"
        int used_count "default 0"
        datetime created_at
        datetime updated_at
    }
    BackupRun {
        string id PK
        string run_type
        string scope
        string schema_name "nullable"
        string school_code "nullable"
        string file_path UK
        int file_size "nullable"
        json table_counts "nullable"
        string checksum "nullable"
        boolean encrypted "default true"
        string status "default pending"
        string verify_status "nullable"
        datetime created_at
        string created_by "nullable"
    }
    TestResult {
        string id PK
        string case_id
        string case_group
        string case_title
        string result
        string detail "nullable"
        string evidence "nullable"
        string submitted_by
        string submitted_by_role "nullable"
        boolean closed "default false"
        string closed_by "nullable"
        datetime closed_at "nullable"
    }
    SystemLog {
        string id PK
        string level
        string message
        json context "nullable"
        datetime created_at
    }
    School {
        string id PK
        string code UK
        string name
        string short_name UK "nullable"
        string theme_color "nullable"
        string logo_url "nullable"
        string status "default active"
        datetime created_at
        datetime updated_at
    }
    SchoolCustomization {
        string id PK
        string school_code UK
        json visible_types "nullable"
        json visible_menu_items "nullable"
        json canteens "nullable"
        json field_labels "nullable"
        json hidden_fields "nullable"
        json theme_config "nullable"
        json field_rules "nullable"
        json field_options "nullable"
        json field_types "nullable"
        json field_order "nullable"
        json custom_fields "nullable"
        json test_types "nullable"
        boolean guest_enabled "default false"
        datetime updated_at
    }
    FrequencyThreshold {
        string id PK
        string school_code
        string test_type
        int weekly_target
        datetime updated_at
    }
    DetectionCalendar {
        string id PK
        string school_code
        string test_type
        int day_of_week
        boolean enabled "default true"
        datetime updated_at
    }
```

### 4.2 关键表结构与索引

| 模型 | 唯一约束 | 索引（`@@index`） | 外键与删除策略 |
|------|----------|-------------------|----------------|
| `User` | `username`、`email` | — | — |
| `AuditLog` | — | `user_id`、`created_at` | `user_id → User`（**Cascade**） |
| `TestRecord` | `record_code` | `test_type`、`status`、`created_by`、`created_at`、`[test_type, created_at]` | `created_by → User`（**Restrict**，删用户不级联删记录） |
| `TestItem` | — | `test_record_id` | `test_record_id → TestRecord`（**Cascade**） |
| `Attachment` | — | `test_record_id` | `test_record_id → TestRecord`（**SetNull**） |
| `Guest` | `username` | `created_by`、`guest_type` | `created_by → User`（**SetNull**，可空） |
| `GuestExportRequest` | — | `guest_id`、`status` | `guest_id → Guest`（**Cascade**） |
| `Session` | — | `user_id`、`status` | `user_id → User`（**Cascade**） |
| `FieldOption` | `[module_code, field_code, value, parent_option_id]` | `[module_code, field_code, parent_option_id]`、`parent_option_id` | `parent_option_id → FieldOption`（**Cascade**，自引用） |
| `BackupRun` | `file_path` | `created_at`、`school_code`、`status` | 无外键（跨 schema 不可达，`created_by` 存用户名或 `system`） |
| `TestResult` | — | `case_id`、`case_group`、`submitted_by`、`created_at`、`closed` | 无外键 |
| `SystemLog` | — | `level`、`created_at` | — |
| `School` | `code`、`short_name` | — | — |
| `SchoolCustomization` | `school_code` | — | `school_code → School.code`（**Cascade**，删校级联删定制） |
| `FrequencyThreshold` | `[school_code, test_type]` | — | 无外键 |
| `DetectionCalendar` | `[school_code, test_type, day_of_week]` | — | 无外键 |

### 4.3 检测记录存储约定

- 前端提交的动态业务字段整体写入 `TestRecord.result_data`（jsonb 对象）；`testDate / canteen / inspector` 另外抽取写入 `sample_info`（jsonb 对象，由 `buildRecordWriteData` 组装）。`buildRecordWriteData` 会剥离 `id/version/record_code/test_type/test_name/created_at/updated_at/completed_at/_status` 等服务端管理字段，避免其落入 `result_data` 后经 `buildRecordPayload` 展开覆盖真实服务端值（曾导致乐观锁永远 409）。
- `record_code` 为**内容确定性哈希**：`RC-{test_type}-{sha256(规范化 payload)}`，用于幂等去重（详见 §5.4、§9）。哈希前先 `stripVolatileFields` 剥离 `id/status/version/created_at/updated_at/recheckRecords/recheckReports/modificationLogs` 等易变字段，再做**数组顺序无关**的键排序规范化（`normalizeForHash`），确保「语义相同但字段顺序/时间戳不同」的重复提交命中同一 `record_code`。
- 读取时 `buildRecordPayload()` 会把 `sample_info` 与 `result_data` 展开合并回平铺对象返回前端。
- `version` 为乐观锁版本号（`/api/records/:tableName/:id` 更新时原子 `where { id, version }` 条件更新，冲突 409）；`data_version` 为业务数据版本，便于定制变更后的兼容性读取/回填。
- `test_type` 取值域为五类 `{tableware, pathogen, leanMeat, oil, pesticide}`（`normalizeRecordType` 严格校验，否则 400/404）；`/api/test-records` 未传 `test_type` 时兜底存 `generic`。`test_name` 由服务端按 `TEST_TYPE_LABELS` 自动映射中文名（如 tableware → `餐具洁净度检测`），不信任前端传入。
- **复检结论自愈**（TD-Q1-Recheck-SelfHeal）：更新记录时按「最新一次复检结论」双向同步 `result`（`recheckRecords[0].isPassed` / `recheckReports[0].isPassed` 为 true → 强制「合格」，false → 「不合格」）。
- **复检/编辑字段保护**（TD-Q1-Recheck-FieldGuard）：复检或编辑时，`PROTECTED_FIELDS`（如蔬菜类型/批号/样品编号/检测限值/采样来源等）若入参为空则回填已有值，防止复检覆盖原始业务字段。
- 字段级联配置（`FieldOption`）是动态表单级联选项的**唯一数据源**（自引用支持任意层级），与 `SchoolCustomization.field_options` 的平面下拉选项是两套互补体系，互不干扰。**跨字段级联语义**：`testType` 顶级选项的 `children` 挂的是 `location` 字段的选项行（`children.field_code = FIELD_OPTION_SEEDS[module][field].cascadeTarget`），`buildFieldCascade` 先建全 module 的 id→node 映射再挂 children，保证父选项跨字段正确挂载。顶级行唯一性由应用层查重（PG 唯一索引对 NULL 不生效）；`is_builtin` 标记系统种子（`ensureFieldOptionSeeds` 幂等，已配置过不覆盖）；有子选项的父选项禁止删除（历史记录为文本快照，不强制引用计数）；`TABLE_MANAGED_FIELDS` 列出由表唯一管理的级联字段，返回客户端前从 `field_options` 中剔除表管理键。

> ⚠️ 原 `backend/sql/*.sql`（PostgreSQL/Supabase + RLS 脚本）与 `backend/config/telemetry.js` 等未启用产物**已于迁移清理中移出仓库**（见 §10 TD-Backend-Orphan）。
> 表结构以 `schema.prisma`（`prisma db push` 推表）为准；此外 **Prisma 不支持原生 CHECK 约束**，故由两个**数据库级 SQL 脚本**补充（均需对每个租户 schema 各执行一次：`psql "$DATABASE_URL" -v schema=<租户> -f ...`，语句幂等）：
> - `backend/prisma/constraints.sql`：`TestRecord.status` / `Session.status` / `User.status` 的 CHECK 约束（`TestRecord.test_type` **刻意不加**约束，以兼容管理控制台自定义检测类型层级 B）。
> - `backend/prisma/role-audit-trigger.sql`：`User.role` 合法性 CHECK + 角色变更审计触发器（见 §9.3）。

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
| POST | `/api/user/register` | admin/manager | 注册用户（默认 `operator` 角色，后续经 `role` 接口调整） |
| POST | `/api/user/login` | 公开（限流） | 登录，返回 `{ success, token, user, expiresIn }` |
| POST | `/api/user/super-admin/login` | 公开（限流） | 平台超管专用登录（无需 schoolCode，二次校验 role=admin） |
| POST | `/api/user/verify-token` | 公开（带 token，限流） | 校验令牌 |
| POST | `/api/user/refresh-token` | 带 refresh token | 刷新双令牌（一次性轮转 + 重放检测 + 设备绑定） |
| POST | `/api/user/logout` | 登录 | 无状态登出（返回 200 供前端清本地） |
| GET | `/api/user/me` | 登录 | 当前用户信息（权威角色） |
| PUT | `/api/user/me` | 登录 | 更新个人资料 |
| POST | `/api/user/change-password` | 登录 | 修改密码 |
| GET | `/api/user/list` | admin/manager | 用户列表 |
| POST | `/api/user/:userId/disable` \| `/enable` | admin/manager | 禁用 / 启用 |
| POST | `/api/user/:userId/role` | admin/manager | 改角色 |
| POST | `/api/user/:userId/reset-password` | admin/manager | 重置密码（被重置账号置 `must_change_password=true`） |
| PUT / DELETE | `/api/user/:userId` | admin/manager | 更新 / 删除（防删自己、防删最后一个 manager） |

#### 平台超管账号管理（`/api/user/super-admin/*`，平台超管独有）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/user/super-admin` | 列出平台超管（public schema） |
| POST | `/api/user/super-admin` | 新增平台超管 |
| DELETE | `/api/user/super-admin/:id` | 删除平台超管 |
| POST | `/api/user/super-admin/:id/reset-password` | 重置超管密码（吊销其全部会话） |

### 5.3 访客（`/api/guest`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/guest/quick-access` | 免凭证签发只读 JWT（2h，`guest_type=readonly`、无导出权限；需 `schoolCode`） |
| POST | `/api/guest/register` | 访客自助注册（需 `schoolCode`+`username`+`password`，密码 bcrypt 落当前租户 `Guest` 表） |
| POST | `/api/guest/login` | 访客登录，返回 `{ token, guest, expiresIn }` |
| POST | `/api/guest/verify-token` | 校验访客令牌（需 guest 角色 JWT） |
| GET | `/api/guest/stats` | 访客看板汇总统计（仅聚合，不返回记录明细） |

> 访客 `register` / `login` / `quick-access` 三个端点均强制校验 `SchoolCustomization.guest_enabled` 开关（fail-closed：未开启一律拒绝），并分别挂独立限流。

#### 5.3.1 数据导出申请（`/api/guest-export-request`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/guest-export-request/submit` | 访客提交导出申请（`status=pending`） |
| GET | `/api/guest-export-request/my-requests` | 当前访客的导出申请列表 |
| GET | `/api/guest-export-request/check-permission` | 当前访客是否具备导出权限 |
| GET | `/api/guest-export-request/admin/pending` | 管理端：待审批列表（admin/manager） |
| POST | `/api/guest-export-request/admin/:requestId/approve` | 批准（置 `has_export_permission=true` + 审计） |
| POST | `/api/guest-export-request/admin/:requestId/reject` | 驳回 + 审计 |

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
- 字段校验：`testDate` / `canteen` / `inspector` 必填非空（`validateRecordPayload`），否则 400。
- 幂等：并发唯一约束冲突（P2002）→ 返回已有记录；外键失败（P2003，用户不存在）→ 422。
- 归属校验：operator 仅可修改/删除**本人创建**的记录，manager 可改全校记录（`canModifyRecord`）。
- bulk-upsert：命中已有记录时执行归属校验（无权覆盖他人记录则跳过并计入 `failed`）；支持 `expected_updated_at` 乐观锁（冲突跳过）；默认「最后写入胜出」（NB-25）。
- 写请求可带 `Idempotency-Key` 头（配合 `/api/records`、`/api/test-records` 的幂等中间件）。

### 5.5 审计日志与同步

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/audit-logs` | 前端"主动上报"类审计（action 白名单，guest/viewer 禁止） |
| GET | `/api/audit-logs` | 审计日志查询（普通用户仅本人，admin/manager 全部）。支持筛选参数：`userId`、`username`、`action`、`startDate`、`endDate`（日期范围）、分页 `limit`/`offset` |
| GET | `/api/audit-logs/users` | 审计涉及用户列表（用于前端筛选下拉，仅 `admin`/平台超管） |
| GET | `/api/audit-logs/school/:schoolCode` | 按学校查询审计（仅 `admin`/平台超管，跨租户） |
| GET | `/api/audit-logs/school/:schoolCode/date-range` | 按学校 + 日期范围查询（`startDate`/`endDate`，仅 `admin`/平台超管） |
| GET | `/api/audit-logs/stats/summary` | 统计（仅 `admin`/平台超管，支持 `date` 过滤） |
| GET | `/api/audit-logs/export` | 导出 CSV（仅 `admin`/平台超管，公式注入防护） |
| GET | `/api/audit-logs/:logId` | 单条详情 |
| POST | `/api/sync/records` | 离线同步单条检测记录（编辑者↑） |
| POST | `/api/sync/batch` | 批量同步检测记录（编辑者↑） |
| GET | `/api/sync/status` | 同步状态统计 |
| DELETE | `/api/sync/queue` | 清空已归档记录（仅 admin） |

### 5.6 会话管理（`/api/session`）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/session` | 注册 / 心跳当前会话（upsert by sessionId） |
| GET | `/api/session` | 列出当前用户活跃会话 |
| DELETE | `/api/session/others` | 注销除当前会话外的所有会话（「登出其它设备」） |
| DELETE | `/api/session/:id` | 注销指定会话（本人或管理员） |
| POST | `/api/session/event` | 记录会话事件埋点 |

### 5.7 检测频率（`/api/frequency`）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/frequency/overview` | 登录 | N3 检测月报（本月/上月/环比/达标/近 6 月趋势） |
| GET | `/api/frequency/thresholds` | 登录 | N1 读取周目标阈值 |
| PUT | `/api/frequency/thresholds` | manager+ | N1 更新阈值 |
| GET | `/api/frequency/calendar` | 登录 | N2 读取检测日历 |
| PUT | `/api/frequency/calendar` | manager+ | N2 更新日历（全量覆盖） |
| GET | `/api/frequency/today` | 登录 | N2 今日待检测项目 |

### 5.8 学校配置与学校管理（`schoolRoutes.js`）

#### 公开 / 登录可读

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/school/config` | 当前登录学校配置（登录态，含 `field_cascade`） |
| GET | `/api/schools/:schoolCode/config` | 登录前公开查询某校配置（限流，登录页个性化用） |

#### 学校管理控制台（`/api/admin/schools/*`，平台超管独有）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/schools` | 列出所有学校 |
| POST | `/api/admin/schools` | 新增学校（建 schema + 推表 + 首个 manager + 字段选项种子） |
| PUT | `/api/admin/schools/:code` | 更新学校基本信息（name/short_name/theme_color/logo_url/logoStyle/systemTitle/canteens/guestEnabled） |
| PATCH | `/api/admin/schools/:code/status` | 启用/停用学校 |
| DELETE | `/api/admin/schools/:code` | 软删除（仅置 disabled，数据保留） |
| DELETE | `/api/admin/schools/:code/hard` | 彻底删除（进回收站，RENAME schema） |
| POST | `/api/admin/schools/:code/reprovision` | 重新初始化学校（幂等补全 schema/表/首个 manager） |
| GET | `/api/admin/schools/:code/customization` | 获取定制配置 |
| PUT | `/api/admin/schools/:code/customization` | 更新定制配置（乐观锁 `expected_updated_at`，整体覆盖语义） |
| GET/POST/PUT/PATCH/DELETE | `/api/admin/schools/:code/field-options[/:id]` | 字段选项级联 CRUD（有子选项时删除被拒） |
| GET | `/api/admin/schools/:code/users` | 列出该校用户（跨 schema 查询） |
| POST | `/api/admin/schools/:code/users` | 新增学校用户 |
| PUT | `/api/admin/schools/:code/users/:userId` | 更新学校用户 |
| DELETE | `/api/admin/schools/:code/users/:userId` | 删除学校用户 |
| POST | `/api/admin/schools/:code/users/:userId/reset-password` | 重置密码 |
| PATCH | `/api/admin/schools/:code/users/:userId/status` | 启用/停用 |

#### 回收站（`/api/admin/recycle-bin/*`，平台超管独有）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/recycle-bin` | 回收站列表（保留期倒计时） |
| POST | `/api/admin/recycle-bin/:id/restore` | 恢复学校（RENAME schema 回来 + 重建 School/Customization） |
| POST | `/api/admin/recycle-bin/:id/purge` | 手动清除（DROP schema，不可恢复） |

> **角色约定**：学校内最高权限为 `manager`（用户/记录/导出/频率管理），`admin` 角色仅保留给平台超管（public schema，`schoolCode=null`），避免跨校越权。`provisionSchool` 创建的首个账号为 `manager`，而非 `admin`。

### 5.9 运维备份（`/api/admin/backups/*`，平台超管独有）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/backups` | 备份列表（分页/筛选） |
| POST | `/api/admin/backups/run` | 触发备份（`{scope:'all'|'single', schoolCode?}`） |
| GET | `/api/admin/backups/:id/download?format=plain\|encrypted` | 下载备份（明文下载默认禁止） |
| POST | `/api/admin/backups/:id/verify` | 触发离线验证（L2-Lite：解密/sha256/gunzip/表数，**不含恢复**，`verifyBackup.js`） |
| POST | `/api/admin/backups/:id/restore` | 影子恢复（`{targetSchoolCode, confirmText:'RESTORE'}`，**同步执行**；全库备份 `scope=all` 不能直接恢复，需先下载后按单校备份恢复） |

### 5.10 测试结果上报（`/api/test-results/*`，任意登录用户）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/test-results/defs` | 用例清单（`no-store` 缓存，含已收口集合） |
| GET | `/api/test-results/me` | 当前登录用户信息 |
| GET | `/api/test-results/summary` | 汇总（按 case_group × result 去重计数） |
| GET | `/api/test-results` | 列表（筛选 + 分页） |
| POST | `/api/test-results` | 提交/更新一条用例结果（upsert by case_id + 姓名） |
| POST | `/api/test-results/upload` | 上传证据图片（base64 JSON，≤5MB/张、≤8 张/次） |
| POST | `/api/test-results/close` | 收口/打开管理（按 case_id 整组收口） |
| POST | `/api/test-results/sync` | 手动重同步汇总报告并重建 dist |
| GET | `/api/test-results/evidence/:caseId/:file` | 读取证据图片（防路径穿越） |

> 保存成功后自动把结果同步到 `docs/test-results/latest/`（MD/HTML/JSON + 证据图片）并重建 `dist`，可用 `TEST_REPORT_DOCS_SYNC=false` 关闭。

### 5.11 洗涤剂比色识别（`/api/recognize`，挂载于 `server.js` `app.use('/api', recognitionRoutes)`）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/recognize` | 登录 | 提交待识别图片（multipart，`image` 字段，≤8MB），返回 `{ jobId }`；后端 `recognitionQueue` 单 Worker 排队（图片过大/类型不符/排队超 5 分钟→报错） |
| GET | `/api/recognize/status/:jobId` | 登录 | 轮询任务状态（`pending`/`processing`/`done`/`error`），`done` 返回比色结果与区域坐标 |

> 后端识别与前端 `detergent-image-demo.html` 纯客户端 OpenCV 识别并存；后端路径受 `recognitionRoutes` 内置 multer 大小限制与 `BODY_LIMIT_UPLOAD` 影响。

---

## 6. 前端模块设计

### 6.1 路由结构（无框架路由，SPA 分区显隐）

- 入口页：`login.html`（登录，含访客快速访问 Tab）、`super-admin-login.html`（平台超管登录）、`index.html`（主应用）、`admin-schools.html`（学校管理控制台，平台超管）、`test-report.html`（浏览器测试上报）、`detergent-image-demo.html`（洗涤剂识别演示）、`help.html`（帮助）。
- 侧边栏导航按钮用 `data-target` 标识目标区块（`dashboard`、`tableware-test`、`pesticide-test`、`oil-test`、`lean-meat-test`、`pathogen-test`、`export-data`、`backup-restore`、`user-management`、`audit-log`、`frequency-report`、`frequency-settings`），`data-admin-only` 仅管理员可见，`data-super-admin-only` 仅平台超管可见（如"学校管理"入口），`data-required-role` 按具体角色显隐导航项。
- `js/core/Router.js`：权限守卫（按角色显隐 admin/guest 菜单、平台超管独有菜单）、Token 每 60s 定时校验 + 临期 5 分钟主动续期、30 分钟空闲登出（`visibilitychange` 时暂停/恢复定时器，TD-NoBeforeUnload）；FIX-15 无 `records:create` 权限（viewer）时从入口隐藏所有检测录入表单；角色中文标签映射（admin=管理员 / manager=主管 / operator=操作人员 / viewer=查看者 / guest=访客）。
- `js/services/PermissionService.js`：RBAC 权限矩阵，`schools:manage` 权限仅当 `user.role==='admin' && !user.schoolCode` 时动态注入；`isPlatformSuperAdmin()` 方法供前端判断。
- 模块注册中心 `js/modules/registry.js`：`MODULE_REGISTRY` / `MODULE_ORDER` / `MENU_ITEMS` 是检测模块与侧边栏菜单的**单一事实来源**，新增检测类型只需在此登记。
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
├── modules/                # 业务模块（事件委托 + CustomEvent）
│   ├── Dashboard  Tableware  Pathogen  GenericTest(pesticide/oil/leanMeat)
│   ├── UserManagement  AuditLog  BackupRestore  backupManager
│   ├── GuestDashboard  FrequencyModule  SuperAdminAccount  loginStyleDesigner
│   └── registry.js         # 模块/菜单注册中心
├── services/
│   ├── AuthService.js      # 登录/登出/Token（login.html 与 Router 使用）
│   ├── GuestAuthService.js # 访客快速访问
│   ├── AuditService.js     # ★ 审计日志单一入口（双写后端 + localStorage）
│   └── PermissionService  SessionManager  ExportService
└── utils/                  # 工具（schoolCustomization/ 目录 + 若干独立工具）
```

### 6.3 状态管理

- **无集中式状态库**；状态分散在各模块与浏览器存储：
  - 认证态 key 采用**租户命名空间**（`auth_token__<schoolCode>` / `current_user__<schoolCode>` / `guest_token__<schoolCode>`，TD-TenantIsolation），并按 DS-17 三级读取：**内存 → sessionStorage → localStorage**（localStorage 仅「记住我」勾选时持久化，否则仅 sessionStorage，关浏览器即登出，P0-1；无 `schoolCode` 的 dev/test 共享 schema 退化为裸 key）；其余缓存 key 不带命名空间：`cache_<table>`（记录缓存）、`pending_<table>`（待同步队列）、`fingerprint_index_<table>`（去重索引）、`audit_YYYY-MM-DD`（前端离线日志）。
  - `StorageService`（`js/core/Storage.js`）是核心数据层：**离线优先**（`getAll()` 先返回本地缓存再后台刷新）、乐观写入（`temp_` 临时 ID）、三层去重（本地/云端/队列）、`429` 全局退避、`409` 版本冲突恢复。
  - `AuditService`（`js/services/AuditService.js`）是审计唯一入口：**双写后端（系统真相源）+ localStorage 镜像**（按天 `audit_YYYY-MM-DD`，保留 30 天）。
  - 学校定制配置缓存：`js/utils/schoolCustomization.js` 按 `schoolCode` 缓存 `SchoolCustomization`，支持跨标签页 `storage` 事件与 `visibilitychange` 重校验同步。
  - `AuthService` 安装**全局 401 刷新拦截器**（`installAuthRefreshFetchInterceptor`）：同源 `/api/*` 请求收到 401 时用 refresh token 静默换新并重放一次（每请求最多一次，认证类端点不拦截）。

---

## 7. 认证与权限设计

### 7.1 RBAC 角色矩阵

| 能力 \ 角色 | 平台超管(admin,无校) | manager | operator | viewer | guest(快速访问) |
|-------------|:-----:|:-------:|:--------:|:------:|:--------------:|
| 查看看板 / 记录 | ✅ | ✅ | ✅ | ✅ | ✅（模块白名单，去致病菌） |
| 创建 / 编辑 / 删除记录 | ✅ | ✅ | ✅（仅本人） | ❌ | ❌ |
| 用户管理（增删改角色） | ✅ | ✅（本校） | ❌ | ❌ | ❌ |
| 审计日志查看 | ✅ | ✅（本校） | ✅（仅本人） | ✅（仅本人） | ❌ |
| 检测频率配置 | ✅ | ✅ | ❌ | ❌ | ❌ |
| 数据导出 | ✅（PDF+Excel） | ✅（PDF+Excel） | ✅（仅 PDF） | ✅（仅 PDF） | ❌（默认，经审批可开） |
| **学校管理控制台 / 回收站 / 运维备份** | ✅ | ❌ | ❌ | ❌ | ❌ |

- **平台超管**（`role=admin` 且 `schoolCode=null`，位于 public schema）：拥有 `schools:manage` 权限，可管理所有学校（新增/编辑/停用/回收站/界面定制/学校用户/运维备份）。学校内最高权限为 `manager`，`admin` 角色不分配给学校用户，避免跨校越权。
- 写入判定由 `requireEditorOrAbove` 实现：角色为 `guest` / `viewer` 一律拒绝（403），其余允许写。
- 记录归属校验由 `canModifyRecord` 实现（DS3-C1 方案甲）：operator 仅能修改/删除**本人创建**的记录（`created_by === userId`），manager/admin 可操作全校记录（`RECORD_SUPERVISOR_ROLES`）；存量 `created_by` 为 NULL 的记录仅 manager/admin 可操作。
- ⚠️ 前后端删除权限差异：后端 API 允许 operator 删除本人记录（`canModifyRecord` + `requireEditorOrAbove`），但前端 `PermissionService` RBAC 矩阵中 operator **不含 `records:delete`**（UI 层隐藏删除入口，见 §6.1）——「后端放行、前端隐藏」，防的是误操作入口而非后端越权防线。
- 用户管理由 `authorizeRoles('admin','manager')`。
- 学校管理 API 由 `requirePlatformSuperAdmin` 中间件保护（`role=admin && !schoolCode`）。
- 访客只读由 `requireGuestReadOnly` 注入 `req.guestVisibleTypes`（该校 `visible_types ∩ 非 pathogen`），查询层强制过滤并做 PII 脱敏（`maskGuestSensitiveFields`：联系方式/证件号/人名做掩码，检测结果类字段保持可见）。
- **本表为后端 API 权限模型**；前端 `PermissionService` 的 RBAC 矩阵（§6.1）更保守，用于 UI 层显隐入口——已知差异：operator 无 `records:delete`（见上）、manager 仅 `users:read`（UI 层可能隐藏用户增删改入口，但后端 `authorizeRoles('admin','manager')` 放行）、admin 独有 `settings:update` / `backup:create|restore` / `audit:export`。

### 7.2 JWT 与令牌结构

- **双令牌对（DS3-H1 破坏性变更）**：登录 / 刷新返回 `{ token, expiresIn, refreshToken, refreshExpiresIn }`。
  - **access token**：payload `{ userId, username, email, role, schoolCode, jti, iat, exp }`，有效期 **`JWT_ACCESS_EXPIRE`（默认 `30m`）**，HS256 签发，`jti` 为 `crypto.randomUUID()`。
  - **refresh token**：payload `{ userId, schoolCode, type:'refresh', jti, deviceId? }`（**不带 role/email**，最小化），有效期 **`JWT_REFRESH_EXPIRE`（默认 `7d`）**，独立密钥 `JWT_REFRESH_SECRET`（缺省派生 `${JWT_SECRET}:refresh`，保证 access/refresh 不能互换验签）。
  - ⚠️ **`JWT_EXPIRE` 不再作用于员工 access token**，仅访客令牌（`guestRoutes.js`）沿用（默认 `7d`）。
- **令牌吊销（H2）**：`public.revoked_tokens` 表（运行时 DDL，非 Prisma schema）按 `jti` 精确吊销 + `user_all` 全量吊销。高危操作（禁用/删除/改角色/重置密码/改密）后 `revokeAllUserTokens` 写 `user_all` 记录，使该用户所有 `iat < revoked_at` 的令牌立即失效；`authenticateUser` 每请求校验吊销表 + 回查 DB（status/school_code/must_change_password/role），生效延迟为 0。
- **refresh token 轮转（DS3-H1）**：仅接受 `X-Refresh-Token` 头（已移除 access-token 自续期）；一次性轮转，旧 token 用后立即吊销；重放检测（同一 token 二次使用 → 吊销该用户全部会话）；并发轮转宽限 30s（`REFRESH_REPLAY_GRACE_MS`，返回 `REFRESH_CONCURRENT`）；设备绑定（`X-Device-Id` + `foodtestlab_dev_id` cookie，跨设备拒绝轮转）。
- **多标签页刷新协调（第六轮）**：前端 `AuthService` 用 Web Locks（回退 localStorage 自旋锁）+ 共享 token 采用 + 轮转信标三层串行化刷新，配合后端 30s 宽限，消除并发刷新触发重放导致的「全端登出」。
- **首登强制改密（IF-2/M2）**：`must_change_password=true`（建校初始 manager、重置密码、平台超管新建）的账号，服务端 `authenticateUser` 对非改密白名单接口（`/api/user/change-password|logout|me|verify-token`）一律 403（`code: MUST_CHANGE_PASSWORD`），不依赖前端自觉。
- **访客令牌**：
  - 普通访客（register/login）payload `{ userId:guest.id, username, role:'guest', schoolCode, guestId, guest_type, has_export_permission, is_quick_access:false, iat }`，有效期跟随 `JWT_EXPIRE`（默认 `7d`）；
  - 快速访问（quick-access）payload `{ userId:'quick-access', guestId:0, role:'guest', guest_type:'readonly', has_export_permission:false, is_quick_access:true, iat }`，有效期 **`2h`**，无 DB 实体。

### 7.3 中间件链

```mermaid
flowchart LR
    R[rateLimit 全局<br/>1000/60s] --> C[cors 白名单] --> J[express.json 8mb]
    J --> RO[readOnlyGuard 维护模式]
    RO --> I{路径 /api/records 或 /api/test-records ?}
    I -->|是| ID[idempotencyMiddleware]
    I -->|否| RT
    ID --> RT[路由匹配]
    RT --> AU[authenticateUser<br/>校验 Bearer → req.user + 租户 req.db]
    AU --> EW{写操作?}
    EW -->|是| RE[requireEditorOrAbove<br/>拒绝 guest/viewer]
    EW -->|否| H[业务处理器]
    RE --> H
```

- 认证工厂：`createAuthMiddleware(userManager, prisma)` 统一导出 `authenticateUser` / `authorizeAdmin` / `authorizeRoles(...)` / `requireEditorOrAbove` / `requireGuestReadOnly`。**禁止在路由内重复实现认证逻辑**。
- `authenticateUser` 解码后挂 `req.user = { userId, username, email, role, schoolCode, jti, iat, exp }`，随后 `tenantMiddleware`（`createTenantMiddleware`）注入 `req.db` 与 `req.tenantSchema`（当前校 tenant client），并向后兼容 `req.userId` / `req.userRole`。
- **DB 回查（H1/H1-ext）**：签名通过后回查用户 `status`（禁用/删除立即 401）、`school_code`（租户绑定交叉校验）、`must_change_password`、`role`（DB 权威角色覆盖 token 角色，后台改角色后无需重登）。回查异常按 **fail-soft → fail-closed 折中**：连续失败 ≥3 次才 503，阈值内沿用 token 身份并告警，避免 PG 瞬时抖动触发全站认证雪崩。
- 维护模式：`READONLY_MODE=true` 时所有写请求返回 503（独立运维开关，`readOnlyMiddleware` 全局限流之后挂载）。⚠️ 影子恢复**不依赖**维护模式——它用「双 rename 原子切换（单事务，毫秒级零窗口）」实现，无需停写（见 §9.7）。

---

## 8. 部署架构

当前生效方案：`deploy/deploy.sh`（通用流程）+ `deploy/deploy.foodtestlab.conf`（环境适配）。`deploy/nginx`、`deploy/pm2`、`deploy.ps1` 等历史适配器（Nginx/PM2/Windows 栈）已下线并移出仓库。

### 8.1 部署形态（单应用 + 每校 schema）

- **应用层**：单套 Node 后端 + 单 Caddy 站点 + 单 systemd 服务，所有学校共用，不做物理分部署。
- **数据层（多学校隔离）**：单 PostgreSQL 实例，每校一个独立 schema（方案②）。新增学校 = 建 schema + 跑迁移，不新增服务/端口。
- **环境差异**：开发/测试用单一共享 schema（无隔离）；生产启用 schema-per-tenant。`.env` 的 `DATABASE_URL` 指向同一 PG 实例与库，schema 由应用层按学校路由。
- **单实例约束**（架构优化计划文档化）：限流计数、幂等请求缓存、安全事件扫描游标三类状态存于**进程内存**，依赖单实例正确；水平扩容前须先迁移到共享存储（Redis 等）。
- 原"每校一套适配文件 + 独立端口/服务"的物理隔离方案已弃用（在 2vCPU/3.5GiB 上会因连接数随学校线性增长而撞资源墙）。

### 8.2 环境变量清单（`backend/.env`，由 `deploy.sh` 自动生成）

| 变量 | 生产取值 | 说明 |
|------|----------|------|
| `NODE_ENV` | `production` | 环境标识 |
| `PORT` | `3000` | 后端内部端口（仅 127.0.0.1） |
| `SERVE_STATIC` | `false` | 生产由 Caddy 托管静态资源 |
| `DATABASE_URL` | `postgresql://<user>:<pass>@127.0.0.1:5432/foodtestlab` | PostgreSQL 连接串；schema 由应用按学校路由 |
| `JWT_SECRET` | `openssl rand -base64 48` | 强随机；命中弱密钥黑名单会拒绝启动 |
| `JWT_ACCESS_EXPIRE` | `30m` | **员工 access token 有效期** |
| `JWT_REFRESH_EXPIRE` | `7d` | refresh token 有效期（一次性轮转） |
| `JWT_REFRESH_SECRET` | （可选） | refresh token 独立密钥（缺省派生 `${JWT_SECRET}:refresh`） |
| `JWT_EXPIRE` | `7d` | 仅访客令牌有效期 |
| `CORS_ORIGIN` | `http://<公网IP>:<FRONTEND_PORT>` 或 `https://<域名>` | 逗号分隔来源；**禁止通配符 `*`**（含 `*` 会拒绝启动） |
| `CORS_HOSTNAMES` | （可选） | hostname[:port] 白名单 |
| `SEED_ADMIN_PASSWORD` / `SEED_OPERATOR_PASSWORD` / `SEED_VIEWER_PASSWORD` | 自动生成 14 位 | seed 初始密码 |
| `RATE_LIMIT_MAX_REQUESTS` / `RATE_LIMIT_WINDOW_MS` | 1000 / 60000 | 全局限流（有默认值） |
| `BODY_LIMIT` / `BODY_LIMIT_UPLOAD` | 8mb / 30mb | 请求体上限 |
| `READONLY_MODE` | （可选） | 维护模式，写请求 503 |
| `AUTO_SYNC_TENANTS` | `true` | 启动自愈租户 schema（`false` 关闭） |
| `BACKUP_PLAIN_DOWNLOAD_ALLOWED` | （可选） | 允许明文下载备份（默认禁止） |
| `TEST_REPORT_DOCS_SYNC` | `true` | 测试结果提交后同步 docs 报告 |
| `REFRESH_REPLAY_GRACE_MS` | 30000 | 并发刷新宽限期 |
| `DEFAULT_SCHEMA` | `public` | 空 schoolCode 回落的共享 schema |
| `TENANT_CONNECTION_LIMIT` / `MAX_TENANT_CLIENTS` | 3 / 25 | 每租户客户端连接数 / LRU 客户端上限 |
| `LOGIN_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_WINDOW_MS` | 10 / 900000 | 登录限流（生产） |
| `LOGIN_FAIL_LOCK_THRESHOLD` / `LOGIN_FAIL_LOCK_WINDOW_MS` | 5 / 900000 | 账号锁定（生产；开发放宽到 1000） |
| `BACKUP_DIR` | `/var/backups/foodtestlab` | 备份根目录（系统盘，与数据盘物理分离） |
| `BACKUP_KEEP_DAYS` / `BACKUP_MIN_FREE_MB` | 7 / 1024 | 备份保留天数 / 磁盘预检阈值 |
| `RESTORE_DROP_OLD` | （未设=保留） | 影子恢复后是否立即 DROP 旧 schema（`drop`） |
| `SECURITY_ALERT_WEBHOOK_URL` | （可选） | 安全事件告警 webhook（企业微信/钉钉同构） |
| `SECURITY_ALERT_INTERVAL_MS` / `_LOOKBACK_MS` / `_DISABLED` | 300000 / 3600000 / — | 告警扫描间隔 / 重启回看 / 关闭开关 |
| `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` / `TENCENT_KMS_REGION` / `TENCENT_KMS_KEY_ID` | （生产推荐） | 备份 KMS 信封加密主密钥（模式 A） |
| `BACKUP_MASTER_KEY` | （仅开发） | 备份本地主密钥（32 字节 base64，模式 B） |

> 首次部署（`SEED_ON_FIRST_DEPLOY=true` 且数据库不存在）会自动执行 seed，创建 `admin` / `operator` / `viewer` 三个账号；生产环境非首次不再 seed。
> 部署脚本另注册 **`foodtestlab-backup.timer`**（每日 02:00 触发 `003_backup-now.mjs --all` 自动全量备份）；备份文件落 `BACKUP_DIR`（默认 `/var/backups/foodtestlab`，系统盘，与数据盘物理分离），保留 7 天。

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

### 8.4 Caddy 站点片段（脚本生成，`$SNIPPET`）

```caddy
:8080 {                                         # 有域名时改为 <域名> 并追加 `tls <TLS_EMAIL>`
    encode gzip

    # 全局安全响应头（应用层 server.js 亦有兜底）
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        -Server
        X-Frame-Options "SAMEORIGIN"
    }
    @apiPath path /api/*
    header @apiPath { X-Frame-Options "SAMEORIGIN" }

    # 路径前缀多租户识别：/<code>/login(.html)? → /login.html（URL 不变）
    # 与 js/utils/schoolCode.js 的 buildSchoolLoginUrl（/<code>/login.html）一致
    @schoolLogin {
        path_regexp ^/[^/]+/login(\.html)?/?$
        not path /api/*
    }
    rewrite @schoolLogin /login.html

    # 帮助中心子路径兜底：/<code>/help.html → /help.html
    @schoolHelp {
        path_regexp ^/[^/]+/help\.html/?$
        not path /api/*
    }
    rewrite @schoolHelp /help.html

    # handle 互斥：/api/* 必须优先反代，否则 rewrite/try_files 会把 API 吞成 SPA HTML
    handle /api/* {
        request_body { max_size 8MB }          # RK39：与后端 BODY_LIMIT=8mb 对齐
        reverse_proxy 127.0.0.1:3000
    }
    handle /health {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        root * /opt/foodtestlab/dist
        try_files {path} /index.html
        file_server
    }
}
```

### 8.5 一键部署

```bash
# 前置（手动）：腾讯云安全组放行 TCP 22 与 FRONTEND_PORT（HTTPS 阶段再放 443）
sudo bash deploy/deploy.sh deploy/deploy.foodtestlab.conf
```

流程：校验 → 装运行时（git/Caddy/Node via NVM）→ 建系统用户与目录 → 迁移 PG 数据目录到数据盘 → 拉代码 → 生成 `.env` → 后端依赖 / `prisma generate` / `db push` / `SchoolCustomization` 增量列迁移 / seed → 多租户初始化（`PROVISION_TENANTS`）→ 前端构建 → 写 systemd → 写 Caddy 片段（端口预检）→ 健康检查 → 输出初始账号密码。

---

## 9. 安全设计

### 9.1 限流

- **全局限流**：`rateLimit(RATE_LIMIT_MAX_REQUESTS=1000, RATE_LIMIT_WINDOW_MS=60s)`，按 IP 滑动窗口，超限返回 429。
- **登录限流**：生产每 IP 每 15 分钟 10 次（`LOGIN_RATE_LIMIT_MAX`/`LOGIN_RATE_LIMIT_WINDOW_MS` 可调）；平台超管登录更严（生产 5 次/15 分钟）。
- **访客限流**：注册 10 次/分钟、登录 20 次/分钟、快速访问 30 次/分钟。
- **其他**：`verify-token` 30 次/分钟、学校公开配置 60 次/分钟。
- 请求体大小上限 `express.json({ limit: 8mb })`，上传 30mb。

### 9.2 密码与密钥策略

- 密码使用 **bcryptjs** 哈希存储（`password_hash`），不落明文。
- 密码强度：至少 8 位且必须包含字母和数字（`isStrongPassword`）。
- 用户名格式：学校用户与 `register` 接口均为 **3–50 位 `[a-zA-Z0-9_]`**（`validationMiddleware` 与 `UserManager` 已对齐）；访客账号 3–32 位；手机号 `1[3-9]\d{9}`（11 位）。
- **JWT 密钥硬校验**：`JWT_SECRET` 缺失或命中弱密钥黑名单（如 `food-lab-secret-key` 等占位值）→ **进程直接退出**，杜绝默认密钥签发令牌；`JWT_REFRESH_SECRET` 与 access 密钥隔离（refresh 与 access 不能互换验签）。
- **CORS 通配符拒绝启动**：`CORS_ORIGIN` 含 `*` 时进程直接退出（`credentials:true` 恒开，`*` + 凭证是无效且危险组合）。
- seed 初始密码来自 `SEED_*_PASSWORD` 环境变量（缺失则 seed 拒绝运行）；生产默认跳过 seed，除非显式 `SEED_ALLOW_PROD=true`。

### 9.3 账号与令牌加固

- **账号锁定（DS3-M2）**：基于租户 `AuditLog.login_failed` 计数，生产 5 次/15 分钟即临时锁定（`LOGIN_FAIL_LOCK_THRESHOLD`/`_WINDOW_MS`），返回 423 + 统一文案；开发/测试放宽到 1000 次避免调试被锁。计数查询失败 fail-open（不锁定）。
- **登录防枚举 + 时序拉平（DS3-M3/DS-15）**：登录失败统一 401 通用文案（不区分用户不存在/密码错误/已禁用）；用户不存在、租户不匹配、账号锁定等失败分支**均执行假 bcrypt 比较**，拉平各路径响应时间，防用户名枚举与时序侧信道。
- **租户归属校验**：携带非空 `schoolCode` 登录时，命中用户的 `school_code` 必须与之一致，否则视为登录失败（防 schema 回落到 public 命中超管账号的「伪登录」）。
- **refresh token 一次性轮转 + 重放检测 + 设备绑定**（见 §7.2）。
- **高危操作即时吊销（IF-1）**：禁用/删除/改角色/重置密码/本人改密后，`revokeAllUserTokens` 吊销目标全部会话，降权即时生效（不等 access TTL 自然过期）。
- **last manager 保护（M3）**：降权/禁用/删除最后一名 active manager 被拒（403），保证每校至少一名可用 manager。
- **admin 提权守卫（P0）**：租户 schema 内**永远不允许出现 `role='admin'`**；仅平台超管（public，`schoolCode=null`）可授予 admin 角色。
- **DB 级角色审计触发器兜底（H4-ext/#10/#7）**：`backend/prisma/role-audit-trigger.sql` 在数据库层兜底——`User.role` 加 CHECK 约束（非法值直接拒绝），并挂 `AFTER UPDATE OF role` 触发器：**任何路径（含运维裸 `UPDATE "User" SET role=...`）的角色变更都会写租户 `AuditLog`（`action=role_change`，`details.source='app'|'db-direct'`）并向 `public.revoked_tokens` 写 `user_all` 全量吊销**，封堵「绕过应用层审计与吊销」的合规缺口（与应用层审计双保险）。
- **首登强制改密**：`must_change_password` 标记（建校 manager、重置密码、平台超管新建均置 true），服务端对非白名单接口强制 403（见 §7.2）。
- **会话管理**：支持「登出其它设备」、指定会话注销、会话心跳。
- **访客开关 fail-closed**：`guest_enabled` 未开启时，后端 register/login/quick-access 一律拒绝（不信任前端隐藏 Tab）。

### 9.4 输入安全

- `validationMiddleware`：提供 XSS 检测（`detectXss`）、SQL 注入检测（`detectSqlInjection`）、HTML 转义 / 消毒（`escapeHtml` / `sanitizeHtml` / `sanitizeText`）。
- 前端 `FormValidator` 的 `xss` / `sqlInjection` 规则与后端保持一致（后端为超集）。
- 记录写入经 `sanitizeObjectKeys` 净化（递归剔除 `__proto__`/`constructor`/`prototype` 原型链污染键，深度上限 10，D-06）；更新字段走白名单/`safeParseJson`（兼容 Prisma Json 对象与 raw SQL 字符串两种返回形态）。
- CORS 精确匹配来源，非白名单来源不下发 CORS 头并记录告警（不抛 500）；无 `CORS_ORIGIN` 时默认仅放行 localhost 开发来源白名单。
- **安全响应头兜底**（DS-10，`server.js`）：`X-Content-Type-Options: nosniff`、`X-Frame-Options`（API `DENY` / 静态 `SAMEORIGIN`，同源预览 iframe 需要）、`Referrer-Policy: no-referrer`、`X-XSS-Protection: 1; mode=block`；API 路径额外 `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`；仅在配置 `DOMAIN` 时下发 HSTS（NB-34）。
- **反向代理真实 IP**：`app.set('trust proxy', 1)`（TST-3），rateLimit 与审计日志依赖真实客户端 IP。
- CSV 导出做公式注入防护（`= + - @` 开头前置单引号）。
- 路径穿越防护：证据图片读取用 `path.basename` + 白名单字符 + 前缀校验。
- 学校定制配置服务端校验（`customizationValidate.js`）：JSON 字段单字段 ≤200KB、嵌套深度 ≤6 层；主题色 `#RRGGBB`（`HEX_COLOR_RE`）；Logo 禁止 SVG（`isSafeLogoUrl` 加 base64 魔数比对 PNG/JPEG/GIF/WebP，可选 `LOGO_ALLOWED_HOSTS` 外链域名白名单）；`theme_config.systemTitle` ≤50 字符且禁控制字符；`visible_types`/`test_types` 类型码 `TYPE_CODE_RE`（字母开头）；`visible_menu_items` 用 `MENU_CODE_RE`（camelCase，与 `registry.js` MENU_ITEMS 对齐）；`custom_fields` 字段名 `CUSTOM_FIELD_NAME_RE`、`type` 白名单 6 种（text/number/date/select/textarea/checkbox）、同域 name 唯一；登录页样式 `theme_config.login` 独立校验（背景色/图片 URL/`opacity` 0~1/`type` 枚举/卡片 `width` 280~720/`radius` 0~48/`align` 枚举）。

### 9.5 审计日志机制

审计已统一为**单一入口 `js/services/AuditService.js`**：所有审计调用收敛到 `auditService.log`，**双写后端（系统真相源 `/api/audit-logs`）+ localStorage 镜像**（`AuditLogger`，按天 `audit_YYYY-MM-DD`，保留 30 天），字段口径对齐后端 `auditLog` 模型（`action` / `resource_type` / `resource_id` / `details` / `ip_address`）。调用方涵盖 `AuthService`(login/logout)、`UserManagement`、`Storage`(create/update/delete)、`Dashboard`/`Tableware`/`Pathogen`/`BackupRestore`/`AuditLog`。

- **服务端强制审计**（H3 收敛）：关键安全事件（登录、角色变更、禁用/删除、密码重置、备份/恢复、学校增删）已改为服务端内部强制写入，不再信任客户端上报。落库统一经 `auditLog.js` 三入口：`writeTenantAuditLog`（租户级，落 `AuditLog`）、`writeSystemLog`（系统级离散事件，落 `SystemLog`，自动补齐「统一审计字段规范 v1」canonical 键：`actor_id/action_type/target_id/details_json/created_at`）、`writeAdminOpsLog`（平台级管理操作，内部委派 `writeSystemLog`，message 前缀 `[admin-audit]`）。`UserManager.logAdminAction` 内部按操作者是否有租户归属路由到租户审计或系统日志。
- **客户端上报限制**：`POST /api/audit-logs` 仅允许预定义 action 白名单（create/update/delete/export/import/print/logout），guest/viewer 禁止，`details` 限长 2000 并打 `source:'client'` 标记。
- **安全事件告警**（`securityAlerts.js`）：`startSecurityEventAlerting` 每 5 分钟（`SECURITY_ALERT_INTERVAL_MS`）扫描 `SystemLog` 中 `message LIKE 'SECURITY:%'` 的新增事件——事件码含 `REVOCATION_WRITE_FAILED`（吊销写入失败）/ `REFRESH_TOKEN_REPLAY`（刷新重放）/ `REFRESH_CONCURRENT_ROTATION`（并发轮转）/ `TENANT_SCHEMA_MISMATCH`（租户绑定漂移）/ `BACKUP_FAILED`（备份失败，`backupService` 写入）。有新增即 `console.error` 高声汇总 + 可选 `SECURITY_ALERT_WEBHOOK_URL`（企业微信/钉钉同构 `{msgtype:'text'}`）推送；按事件码聚合防告警风暴，附运维处置注释。**扫描游标存进程内存（单实例假设）**，重启回看 `SECURITY_ALERT_LOOKBACK_MS`（默认 1h）宁可重报不漏报；`SECURITY_ALERT_DISABLED=true` 可关闭（测试/本地）。

> 生产环境审计记录**不得物理删除**（见 `docs/PROJECT_CONVENTIONS.md` 规则一）。`/api/audit-logs/cleanup` 物理删除端点已移除。

### 9.6 幂等与并发

- 记录写入以内容哈希 `record_code` 作唯一键，重复提交返回已有记录；`/api/records`、`/api/test-records` 挂 `idempotencyMiddleware` 支持 `Idempotency-Key`。
- **幂等中间件实现**（`idempotencyMiddleware.js`，进程内存 Map）：缓存键 = `{Idempotency-Key}:{请求体 sha256 前 16 位}`（防同 key 不同 body 误命中）；先写 `pending` 占位再放行（封堵 check-then-act 竞态），占位超时 60s 兜底；成功响应缓存 24h，失败响应删占位允许重试；Map 上限 10000 条，满时 429（NB-11）。
- 记录更新支持**乐观锁**（`version`），版本不一致返回 409，由前端拉取最新后重试（原子 `where version` 条件更新）。
- 学校定制配置更新支持乐观锁（`expected_updated_at`）。

### 9.7 备份安全

- **备份流程（`backupService.js`，P0）**：`pg_dump -Fp -Z6`（MVCC 单事务快照，`--no-owner --no-acl`，`--lock-wait-timeout=30`）→ `.sql.gz` → 流式 AES-256-GCM 加密 → `.sql.gz.aes` + `.meta.json`（DEK 密文随 meta 同存）。备份文件权限 `600`、日期目录 `700`（仅系统用户可读）。写 `public.BackupRun`（`run_type` = `scheduled_all`/`scheduled_school`）。失败先写 `SECURITY:BACKUP_FAILED` 再抛出。
- **校验三级（勿混淆）**：
  - **L1（内嵌于备份流程）**：gzip 完整性 + `CREATE TABLE` 数量对比（排除 `_prisma_migrations`，兼容带/不带引号两种 dump 形态）；
  - **L2-Lite（离线验证，`backupVerify.js`）**：解密（GCM 认证）+ sha256 + gunzip + 表数，**不依赖生产库**，供 CLI 004 与控制台「离线验证」复用；
  - **L2（行数对比，仅恢复时）**：`restoreService` VALIDATING 阶段对比 `meta.tableCounts` 基线 vs 影子 schema 实际行数。
- **磁盘空间预检**：备份根目录剩余 < `BACKUP_MIN_FREE_MB`（默认 1024MB）时 fail-closed 拒绝备份；目录不可达/平台不支持 `statfs` 时跳过（不阻断）。
- **保留与清理**：`BACKUP_KEEP_DAYS`（默认 7）递归清理全根目录过期 `.aes/.meta/.tmp`（非只扫当天）。
- **时区修复**：`localNow()` 固定 `Asia/Shanghai` 偏移（+8h），避免凌晨 02:00 定时备份因 UTC 落「前一天」目录（P0 真实 bug）。
- **范围精确**：dump 采用**显式 schema 列表**（全库 = active+disabled 学校 schema + public，停用学校数据法定留存不可丢；排除无 `School` 注册行的孤儿 schema），保证与 `tableCounts` 统计集合严格一致。
- **主密钥两种模式（fail-closed，无密钥即拒绝执行，绝不明文降级）**：
  - 模式 A（生产推荐）：腾讯云 KMS（`TENCENT_SECRET_ID/SECRET_KEY/TENCENT_KMS_REGION/TENCENT_KMS_KEY_ID`，依赖 `tencentcloud-sdk-nodejs`，未安装明确报错不静默降级）；
  - 模式 B（仅开发过渡）：`BACKUP_MASTER_KEY`（32 字节 base64 本地主密钥）。
- 明文下载默认禁止（公网 HTTP 下明文 = 裸奔，需 `BACKUP_PLAIN_DOWNLOAD_ALLOWED=true`）。
- **影子恢复（`restoreService.js`，P1）**：需 `confirmText:'RESTORE'` + 平台超管 + 审计（`writeAdminOpsLog`）。状态机 `PREPARING → STAGING → VALIDATING → SWITCHING → COMPLETE`（任一步失败 → DROP 临时 schema → FAILED，原数据零影响）：先恢复到临时 schema `school_<code>_restore`（`rewriteSchemaNames` 重写 pg_dump 中的 schema 名，兼容 PG18 带/不带引号），VALIDATING 行数对比通过后，**单事务 `ALTER SCHEMA ... RENAME` 双 rename 原子切换（毫秒级零窗口，无需维护模式）**；旧 schema 保留（默认，支持回滚，`RESTORE_DROP_OLD=drop` 才立即清理）。全库备份不能直接单校恢复。

---

## 10. 已知技术债务与待办

### 10.1 已解决（历史技术债清理）

| 编号 | 描述 |
|------|------|
| TD-Guest | 访客体系后端落地（`Guest`/`GuestExportRequest` + `guestRoutes.js` 全套 + 审批流），前端 `GuestAuthService` 补齐 `schoolCode`。 | ✅已解决 |
| TD-Auth-Path | 认证路径对齐（`/api/user/change-password`、`/api/user/verify-token`、无状态 `/api/user/logout`）。 | ✅已解决 |
| TD-ApiClient | 遗留 `/auth/*` 并行客户端已移出仓库。 | ✅已解决 |
| TD-Users-Dup | `server.js` 内联 `/api/users*` 与 `userRoutes` 重复，已统一走 `/api/user`（含租户隔离）。 | ✅已解决 |
| TD-P2-13 | 审计日志统一为 `AuditService` 单一入口，双写后端 + localStorage。 | ✅已解决 |
| TD-Session | 会话管理落地（`Session` 模型 + `/api/session` + 前端 `SessionManager`）。 | ✅已解决 |
| TD-Orphan | 前端遗留模块（`CacheManager`/`ConfigManager`/`UserAuth`/`IndexedDBManager`/`OfflineModeManager`/`PerformanceMonitor`）已移出仓库。 | ✅已解决 |
| TD-Backend-Orphan | `backend/sql/*.sql`、`backend/config/telemetry.js` 等未启用产物已移出仓库。 | ✅已解决 |
| TD-Naming | `package.json` name 中立化为 `foodtestlab`，`engines.node` 对齐 `>=18`。 | ✅已解决 |
| TD-Tenant | 多学校隔离采用 per-schema `?schema=` 专属 PrismaClient 方案；「事务包裹 / search_path」方案已证伪废弃。 | ✅已解决 |

### 10.2 当前待办

- **未修复的测试反馈问题（17 项 failed-open）**：见 [`docs/fix/复核报告-20260814.md`](./docs/fix/复核报告-20260814.md) 与 [`docs/fix/待修复问题深度分析-20260814.md`](./docs/fix/待修复问题深度分析-20260814.md)（含 P0/P1 优先级与逐条根因定位）。
- **容量规划与架构优化收尾**：见 [`docs/deployment/capacity-planning-and-p3-closeout.md`](./docs/deployment/capacity-planning-and-p3-closeout.md) 与 [`docs/optimization/ARCH_OPTIMIZATION_PLAN.md`](./docs/optimization/ARCH_OPTIMIZATION_PLAN.md)。
- **运维待办（低优先）**：systemd 日志 `append:` 未配置 logrotate（会无限增长）；Caddy `reverse_proxy` 未显式设超时（沿用默认值）；根 `devDependencies` 有 jest 链高危漏洞（不影响运行时）。详见 [`deploy/DEPLOY_READINESS_REPORT.md`](./deploy/DEPLOY_READINESS_REPORT.md)。

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
# 注意：此 admin 为 public schema 的平台超管；学校首个账号为 manager（由 provisionSchool 创建）
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
- 生成部署产物：`npm run build`（`scripts/build-static.js` → `dist/` + `npm run build:css` 编译 Tailwind）。

### 11.3 测试

```bash
npm test                      # Jest 单元测试（--coverage）
npm run test:unit             # 单元测试
npm run test:backend          # 后端测试
npm run test:frontend         # 前端测试
npx jest tests/smoke.test.js  # 冒烟：pathogenRisk 纯函数（ESM 兼容性）
npm run test:integration      # 集成测试（独立 config）
npm run test:e2e              # Cypress（需先起 http-server :8080）
npm run test:all              # Jest + Cypress 全套
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
- 安全事件告警：`SystemLog` 中的 `SECURITY:*` 记录（每 5 分钟扫描告警，可配企业微信 webhook）。

### 12.3 备份与恢复（PostgreSQL）

#### 应用内备份引擎（推荐）

平台超管在管理控制台「运维备份」Tab 或经 `/api/admin/backups/*` 操作：

- **触发备份**：`POST /api/admin/backups/run`（`{scope:'all'|'single', schoolCode?}`），产出 AES 加密备份 + 元数据。
- **离线验证**：`POST /api/admin/backups/:id/verify`（L2-Lite，不含恢复）。
- **影子恢复**：`POST /api/admin/backups/:id/restore`（`{targetSchoolCode, confirmText:'RESTORE'}`）。⚠️ 仅支持 `scope=single` 的单校备份；全库备份需先下载后按单校备份恢复。

详见 [`docs/deployment/backup-module.md`](./docs/deployment/backup-module.md)。

#### 手工 `pg_dump` / `psql`

```bash
# 整库备份
pg_dump foodtestlab > /mnt/datadisk0/foodtestlab/backup/foodtestlab_$(date +%F).sql

# 按校（schema）单独备份 / 恢复 —— 多学校隔离的核心能力
pg_dump -n school-a foodtestlab > /mnt/datadisk0/foodtestlab/backup/school-a_$(date +%F).sql
psql -d foodtestlab -f /mnt/datadisk0/foodtestlab/backup/school-a_$(date +%F).sql

# 恢复整库（先停后端，再导入）
systemctl stop foodtestlab-api
psql -d foodtestlab < /mnt/datadisk0/foodtestlab/backup/foodtestlab_YYYY-MM-DD.sql
systemctl start foodtestlab-api
```

### 12.4 健康检查

```bash
curl http://127.0.0.1:3000/api/health       # 本机（应返回 {status:'ok'}）
curl http://<公网IP>:8080/health            # 经 Caddy（验证反代与安全组）
```

### 12.5 故障排查速查

| 现象 | 排查方向 |
|------|----------|
| 本机健康检查通过但外网访问超时 | 腾讯云**安全组**未放行 `FRONTEND_PORT`（脚本不配置安全组） |
| 后端起不来 / 反复重启 | `journalctl -u foodtestlab-api -n 50`；常见：`JWT_SECRET` 缺失或弱密钥、`CORS_ORIGIN` 含通配符、数据盘未挂载 |
| 重启后服务失败 | 数据盘 `/mnt/datadisk0` 未写入 `/etc/fstab`，重启未自动挂载 |
| 登录 401 / CORS 报错 | `.env` 的 `CORS_ORIGIN` 与实际访问来源不一致 |
| 登录 423 | 账号因登录失败次数过多被临时锁定 |
| 写操作 403 | 当前为 `viewer` / 访客（快速访问）角色，无写权限；或 operator 越权修改他人记录 |
| 更新返回 409 | 乐观锁版本冲突，前端需拉取最新数据后重试 |
| 访客无法登录/注册 | `guest_enabled` 开关未开启（平台超管按校配置） |
| 构建时 OOM | 低内存机开启 `ENABLE_SWAP` 或调低 `SERVICE_MEMORY_MAX` |
| 改了前端代码但线上"像没改" | **`dist/` 未重建**（Caddy 只 serve `dist/`，见 §12.6 教训5）；或改后未 `commit+push` 就被部署脚本 reset 覆盖（§12.6 教训6）；先硬刷，再 `grep`/比对 `dist/` 是否已含改动 |

### 12.6 排查方法论教训（高频误判清单）

> 以下教训来自实际排查事故，供未来接手者（含未来的自己）避免重复弯路：

1. **Caddy `rewrite` ≠ HTTP 重定向**：`rewrite` 是服务端内部 URI 转发，**不会改变浏览器地址栏 URL**，返回 200 且**无 `Location` 头**；而 `redir`/`redirect` 才返回 301/302 + `Location`。排查"路径前缀是否丢失"类问题时，必须先 `curl -s -I <url>` 确认响应头里是否有 `Location`，再判断是否需要担心地址栏变化。曾因此误判"登录后 schoolCode 丢失"（实际不存在）。
2. **`grep` 找不到路由 ≠ 路由不存在**：后端路由可能用变量拼接注册（如 `/api/records/:tableName`）、或挂在 `app.use` 前缀下、或分散在不同模块文件中。grep 为空时须确认搜索范围覆盖全部路由文件、并尝试按"参数化路由名"再搜。曾因 grep 遗漏误判"`/api/records/:type` 返回 404"（实际路由存在且正常）。
3. **`$queryRawUnsafe` 返回 JSONB 列是字符串**：PostgreSQL 经 Prisma 原生 SQL 查询时，`jsonb`/`text` 列的 JSON 内容返回为字符串，需 `JSON.parse` 后再供前端消费；前端读取配置时同样要对外层与内层 JSON 字段分别 parse。
4. **systemd 服务 `Restart=on-failure` 会自动拉起进程**：`kill` 手动启动的进程后，systemd 管理的服务会 5 秒内自动重启并重新占用端口。排查"双进程/端口占用"时先 `systemctl status <svc>` 确认是否由 systemd 管理；部署/重启统一用 `systemctl restart`，勿手动 `nohup`。
5. **改前端代码后必须重建 `dist/`，否则线上看不到修复**：生产 Caddy 直接 `serve dist/`（见 `deploy.sh` §7 与 Caddy 站点片段 `root * $REPO_ROOT/dist`），**不读源码 `js/`、`admin-schools.html` 等**。前端是纯拷贝无打包（`scripts/build-static.js`），改源码后**只在本地/服务器工作区改而不跑 `node scripts/build-static.js`，线上永远走旧 `dist/`**，表现就是"改了但现象完全没变"。判断方法：对比 `dist/` 与源文件时间戳 / `grep` 关键词是否进入 `dist/`。**流程**：① 改源码 → ② `node scripts/build-static.js` 重建 → ③ 浏览器 `Ctrl+Shift+R` 硬刷（Caddy 已设 `no-cache`，但浏览器磁盘缓存仍可能命中）。注意 `dist/` 被 `.gitignore` 忽略、**不入库**，部署机从 GitHub 拉代码**不会**带入 `dist/`。
6. **部署前未 `git commit`+`push`，部署脚本会用 GitHub 旧代码覆盖修复**：`deploy.sh` §4 执行 `git fetch origin <branch> && git reset --hard origin/<branch> && git clean -fd`，**任何只存在于本地工作区（未提交/未推送）的修复都会被覆盖丢失**。部署前必须先 `git add` + `git commit` + `git push`，确认 `git status --short` 干净（仅 `.env` 例外，`clean` 已加 `-e .env` 保留）。若工作区有改动未提交，脚本会先 `git stash push -u` 再 reset，**须手动 `git stash pop` 恢复**——很容易遗漏。曾多次因"改完没 commit 就部署"，导致修复被 GitHub 旧代码冲掉而失败。**上线 checklist**：源码改动全部 commit+push → 构建 `dist/`（或由部署流程重建）→ 部署 → 验证。

---

## 相关文档

- 开发细节：[`docs/DEVELOPMENT_GUIDE.md`](./docs/DEVELOPMENT_GUIDE.md)
- 长期规范（优先级最高）：[`docs/PROJECT_CONVENTIONS.md`](./docs/PROJECT_CONVENTIONS.md)
- 近期变更日志：[`docs/CHANGELOG.md`](./docs/CHANGELOG.md)
- 部署说明：[`deploy/README.md`](./deploy/README.md)
- 后端说明：[`backend/README.md`](./backend/README.md)
- 备份模块：[`docs/deployment/backup-module.md`](./docs/deployment/backup-module.md)
- 开发/测试部署指南：[`docs/deployment/dev-test-deployment-guide.md`](./docs/deployment/dev-test-deployment-guide.md)
- 容量规划：[`docs/deployment/capacity-planning-and-p3-closeout.md`](./docs/deployment/capacity-planning-and-p3-closeout.md)
- 定制配置 API：[`docs/api/customization-api.md`](./docs/api/customization-api.md)
- 架构优化计划：[`docs/optimization/ARCH_OPTIMIZATION_PLAN.md`](./docs/optimization/ARCH_OPTIMIZATION_PLAN.md)
- 待修复问题清单：[`docs/fix/`](./docs/fix/)
