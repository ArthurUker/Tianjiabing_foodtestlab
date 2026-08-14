# 文档中心（docs/README.md）

田家炳食品检验系统（部署代号 `foodtestlab`）的**文档导航中枢与代码地图**。

> 本文与根 [`README.md`](../README.md) 分工不同：
> - **根 `README.md`** 是**系统级技术总览**（架构图 / API / 认证 / 部署 / 安全 / 运维 的内容本体），回答"系统是怎么设计和运行的"。
> - **本文（docs 文档中心）** 是**元文档**：不重复技术细节，只回答"**该读哪篇文档、按什么顺序读、每篇文档负责什么、想做某件事去改哪个代码文件**"。它是查阅文档与源码的索引与地图。
> - 本目录文档均基于**当前仓库实际代码**维护；近期变更见 [`CHANGELOG.md`](./CHANGELOG.md)，待修复问题见 [`fix/`](./fix/)，历史归档已清理移除。

---

## 1. 一分钟上手：我是谁，先读哪篇

| 你的角色 | 第一步 | 第二步 | 第三步（动手前必读） |
|----------|--------|--------|----------------------|
| **第一次接触项目** | 根 [`README.md`](../README.md)（系统总览一页纸） | [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md)（开发全貌） | [`PROJECT_CONVENTIONS.md`](./PROJECT_CONVENTIONS.md)（红线规范） |
| **后端开发** | [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md) §4/§5（后端架构与 API） | [`backend/README.md`](../backend/README.md)（本地起服务） | [`PROJECT_CONVENTIONS.md`](./PROJECT_CONVENTIONS.md) 规则三/四/五/八 |
| **前端开发** | [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md) §6（前端架构 / 数据层） | 根 [`README.md`](../README.md) §6（前端模块设计） | [`PROJECT_CONVENTIONS.md`](./PROJECT_CONVENTIONS.md) 规则七/十一 |
| **部署 / 运维** | [`deploy/README.md`](../deploy/README.md)（部署脚本与前置） | 根 [`README.md`](../README.md) §8/§12（部署架构与运维手册） | [`PROJECT_CONVENTIONS.md`](./PROJECT_CONVENTIONS.md) 规则十 |
| **AI 助手 / 代码修复** | [`PROJECT_CONVENTIONS.md`](./PROJECT_CONVENTIONS.md)（**优先级最高，先读**） | [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md) §9（已知偏差 / 技术债） | 本文 §4 代码地图定位到具体文件 |

> ⚠️ 涉及**审计日志、多学校隔离、认证授权、数据库迁移、部署**的任何改动，`PROJECT_CONVENTIONS.md` 优先级高于其余所有文档（含本文与根 README）。

---

## 2. 文档矩阵：每篇文档负责什么

| 文档 | 定位（回答什么问题） | 权威性 | 随代码更新 | 优先级 |
|------|----------------------|--------|:----------:|:------:|
| [`README.md`（根）](../README.md) | **系统总览**：业务定位、技术栈、架构图、数据库、API、认证权限、部署、安全、运维——一页纸看懂全系统 | 权威 | 是 | 中 |
| [`docs/README.md`](./README.md)（本文） | **文档中心 / 代码地图**：文档导航、阅读路径、任务→文档→代码 速查、术语表、文档维护约定 | 权威（元文档） | 是 | 中 |
| [`docs/DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md) | **开发文档**：目录结构、后端分层与 API 实现、前端初始化流程与数据层细节、测试、**已知偏差/技术债** | 权威 | 是 | 中 |
| [`docs/PROJECT_CONVENTIONS.md`](./PROJECT_CONVENTIONS.md) | **长期操作规范**：审计保留、多租户隔离、认证、迁移、部署等**红线与工程约束** | 权威（红线） | 是 | **最高** |
| [`backend/README.md`](../backend/README.md) | **后端子项目说明**：仅后端本地起服务、环境变量、curl 自测 | 权威（局部） | 是 | 中 |
| [`deploy/README.md`](../deploy/README.md) | **部署方案说明**：`deploy.sh` + 适配文件用法、部署前置、多用户同机、自适应资源 | 权威（局部） | 是 | 中 |
| [`docs/CHANGELOG.md`](./CHANGELOG.md) | **近期变更日志**：2026-08 已上线功能按主题归类（测试报告/权限/备份/洗涤剂识别等） | 权威（记录） | 是 | 中 |
| [`docs/fix/`](./fix/) | **待修复问题清单**：当前测试反馈未收口（failed-open）问题的根因定位与优先级 | 当前依据 | 是 | 中 |
| [`docs/test-results/`](./test-results/README.md) | **测试结果快照**：`latest/` 覆盖式快照（HTML/MD/JSON + 证据图），权威数据在数据库 | 快照 | 是 | 参考 |

> 分工原则：**根 README 讲"是什么/怎么跑"**（面向全体）；**DEVELOPMENT_GUIDE 讲"代码怎么组织、坑在哪"**（面向改代码的人）；**PROJECT_CONVENTIONS 讲"什么不能碰、必须怎么做"**（红线）；**本文讲"去哪找"**（索引）。四者不重复彼此的内容主体。

---

## 3. 按任务速查：我要做 X → 读哪篇 + 改哪里

| 我要做的事 | 先读 | 关键代码文件 | 红线约束 |
|------------|------|--------------|----------|
| 新增一个受保护 API | DEV_GUIDE §4.6 / §5 | `backend/server.js`、`backend/routes/*.js`、`backend/middleware/authMiddleware.js` | 规则四（统一认证工厂，禁重复实现） |
| 新增 / 修改检测记录字段 | DEV_GUIDE §4.2/§4.4 | `backend/prisma/schema.prisma`、`server.js`（`buildDeterministicRecordCode`） | 规则六（迁移只用 Prisma）、规则八（幂等 `record_code`） |
| 新增一所学校 | CONVENTIONS 规则三.8 | `scripts/provision-school.sh`、`public."School"` 登记 | 规则三（唯一切换点）、规则十（部署零改动） |
| 改多学校隔离（per-schema PrismaClient） | CONVENTIONS 规则三 | `backend/lib/tenantClient.js`、`backend/middleware/tenantMiddleware.js` | 规则三（唯一切换点 `createTenantClient`，禁手写 SET search_path / 禁每校 new Client） |
| 改学校个性化（外观/字段） | CONVENTIONS 规则四.4 | `schema.prisma`（`School`/`SchoolCustomization`）、`server.js`（`/api/school/config`、`/api/schools/:code/config`） | 系统表恒在 `public`，带显式 `public.` 前缀 |
| 改前端登录 / schoolCode 提取 | CONVENTIONS 规则七 | `login.html`、`js/services/AuthService.js`、`js/utils/schoolCode.js` | 规则七（schoolCode 提取唯一入口） |
| 改前端导航 / 新增页面 | DEV_GUIDE §6.1~6.3 | `index.html`（`data-target`）、`js/main.js`、`js/core/Router.js` | 规则十一（事件委托 + CustomEvent，禁 `window.*` 全局） |
| 改前端离线 / 数据同步 | DEV_GUIDE §6.6/§6.7 | `js/core/Storage.js`、`js/core/AdaptiveUploadQueue.js` | 规则十一（走 StorageService，勿裸 fetch） |
| 改审计日志写入 | CONVENTIONS 规则五 | `server.js`（`writeRecordAuditLog`）、`routes/auditRoutes.js`、`js/services/AuditLogService.js` | 规则一（不得物理删除）、规则五（对号入座，勿新增第四套） |
| 改部署 / 环境变量 | deploy/README | `deploy/deploy.sh`、`deploy/deploy.foodtestlab.conf` | 规则十（脚本与适配分离、单应用）、规则六.6（禁改回 sqlite） |
| 加单元测试 | DEV_GUIDE §10 | `tests/*.test.js`、`jest.config.cjs` | 规则十二（纯函数应补单测、lint 零 error） |
| 查看/归档浏览器测试反馈 | [`test-results/`](./test-results/README.md) | `backend/lib/testCaseDefs.js`（用例清单唯一权威）、`backend/lib/testReportSync.js`（报告同步引擎）、`backend/routes/testResultRoutes.js`（上报/上传/读取端点）、`scripts/sync-test-results-docs.mjs`（手动同步） | 数据权威在库；`docs/test-results/latest/` 为覆盖式快照，归档需手动 git 提交 |

---

## 4. 代码地图：目录 / 关键文件 → 职责 → 权威说明

> 只列"改动前需要先定位的入口"。完整目录树见 [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md) §3。

### 4.1 后端（`backend/`）

| 文件 / 目录 | 职责 | 详见 |
|-------------|------|------|
| `server.js` | 应用入口：路由装配、中间件链、健康检查、`/api/records`、`/api/school*` 系统表端点、幂等 `record_code`、`writeRecordAuditLog` | DEV_GUIDE §4 / 根 README §5 |
| `prisma/schema.prisma` | **唯一数据模型真相源**（`provider=postgresql`）：业务模型 + `School`/`SchoolCustomization`（public 系统表） | DEV_GUIDE §4.2 / 根 README §4 |
| `prisma/seed.js` | 初始账号 admin/operator/viewer（生产默认跳过） | CONVENTIONS 规则六 |
| `lib/tenantClient.js` | ★ **多租户隔离核心**：`setSearchPath`（唯一切换点）+ `createTenantClient`（递归 Proxy 事务包裹） | CONVENTIONS 规则三 |
| `middleware/authMiddleware.js` | 统一认证/授权工厂 `createAuthMiddleware` | CONVENTIONS 规则四 |
| `middleware/tenantMiddleware.js` | 认证后注入 `req.db` / `req.tenantSchema` | CONVENTIONS 规则四.2 |
| `middleware/idempotencyMiddleware.js` | `/api/records` 的 `Idempotency-Key` 幂等 | CONVENTIONS 规则八 |
| `middleware/validationMiddleware.js` | 限流、XSS/SQL 注入检测、文本消毒 | CONVENTIONS 规则九 |
| `modules/UserManager.js` | 用户/认证业务逻辑；`forTenant(schoolCode)` 按校路由；JWT 签发（携带 `schoolCode`） | DEV_GUIDE §4.6 / CONVENTIONS 规则四.3 |
| `routes/userRoutes.js`·`auditRoutes.js`·`syncRoutes.js` | `/api/user/*`·`/api/audit-logs/*`·`/api/sync/*` | DEV_GUIDE §5 |
| `sql/*.js`·`config/telemetry.js` | ⚠️ 未启用产物（PostgreSQL/Supabase RLS 参考脚本 / 未装依赖的埋点） | DEV_GUIDE §9 |

### 4.2 前端（`js/` + 入口页）

| 文件 / 目录 | 职责 | 详见 |
|-------------|------|------|
| `login.html`·`index.html` | 登录页（含 schoolCode 个性化）/ 主应用（`data-target` 导航） | DEV_GUIDE §6.1 |
| `js/main.js` | 前端初始化总入口（DOMContentLoaded） | DEV_GUIDE §6.2 |
| `js/core/Router.js` | 路由 / 权限守卫 / Token 定时校验 / 空闲登出 | 根 README §6.1 |
| `js/core/Storage.js` | ★ **StorageService 离线优先数据层**（缓存+队列+多层去重+429/409） | DEV_GUIDE §6.6 |
| `js/core/AdaptiveUploadQueue.js` | ★ 渐进节流上传队列（幂等键 + 指纹去重 + 冲突恢复） | DEV_GUIDE §6.7 |
| `js/services/AuthService.js` | 登录/登出/Token（`login.html` 与 Router 使用） | DEV_GUIDE §6.4 |
| `js/services/GuestAuthService.js` | 访客快速访问（仅 `quick-access` 后端可用） | DEV_GUIDE §9.1 |
| `js/utils/schoolCode.js` | ★ **schoolCode 提取唯一入口**（路径前缀 / `?school=`） | CONVENTIONS 规则七 |
| `js/modules/*.js` | 9 个业务模块（Dashboard / Tableware / Pathogen / GenericTest / ...） | 根 README §6.2 |
| `js/utils/`（部分） | ⚠️ 孤儿遗留：`ApiClient`/`UserAuth`/`CacheManager`/`ConfigManager`/`IndexedDBManager`/`OfflineModeManager`/`PerformanceMonitor` 未被引用 | DEV_GUIDE §9 |

### 4.3 部署与脚本

| 文件 | 职责 | 详见 |
|------|------|------|
| `deploy/deploy.sh` | 通用部署脚本（无学校名/端口硬编码） | deploy/README |
| `deploy/deploy.foodtestlab.conf` | 田家炳/腾讯云适配文件（当前生效） | deploy/README |
| `deploy/deploy.adapter.example.conf` | 适配文件模板（多用户复制此文件） | deploy/README |
| `scripts/provision-school.sh` | 从 `school_template` 克隆新校 schema | CONVENTIONS 规则三.8 |
| `scripts/build-static.js` | 前端静态构建（复制到 `dist/`，含 `login.html`） | CONVENTIONS 规则十.5 |

---

## 5. 术语速查

| 术语 | 含义 | 出处 |
|------|------|------|
| `schoolCode` | 学校代码，**同时即 PostgreSQL schema 名**（如 `school-a`）；`[a-zA-Z0-9_-]` | `lib/tenantClient.js`、`utils/schoolCode.js` |
| 业务 schema | 每校独立 schema，存放 `User`/`TestRecord`/`AuditLog` 等租户表 | CONVENTIONS §0.4 |
| 系统表（public） | `School`/`SchoolCustomization` 恒在 `public`，带显式 `public.` 前缀访问 | `schema.prisma` |
| 模板 schema | `school_template`：标准租户表集合，`provision-school.sh` 据此克隆 | CONVENTIONS §0.4 |
| `req.db` | 请求级租户客户端（`createTenantClient` 构造），handler 统一经它访问 DB | `tenantMiddleware.js` |
| `record_code` | 内容确定性幂等键 `RC-{test_type}-{sha256(payload)}` | CONVENTIONS 规则八 |
| 方案② | Schema-per-tenant：单应用 + 单 PG 实例 + 每校独立 schema | CONVENTIONS §0.2 |
| 方案A | 访问层路径前缀识别 schoolCode（`/school-a/login`） | CONVENTIONS §0.2 |

---

## 6. 文档维护约定

| 路径 | 性质 | 更新时机 | 是否权威 |
|------|------|----------|----------|
| `README.md`（根） | 系统总览 | 架构/API/部署变化时同步 | 是 |
| `docs/README.md`（本文） | 文档中心/代码地图 | 新增文档、目录结构调整、关键文件搬迁时同步 | 是（元文档） |
| `docs/DEVELOPMENT_GUIDE.md` | 开发文档 | 随代码更新 | 是 |
| `docs/PROJECT_CONVENTIONS.md` | 长期操作规范 | 规则调整须谨慎（红线） | 是（最高优先） |
| `docs/CHANGELOG.md` | 近期变更日志 | 每次功能上线后追加 | 是（记录） |
| `docs/fix/` | 待修复问题清单 | 随测试反馈收口/修复更新 | 是（当前依据） |

维护原则：
1. **不重复内容主体**——同一事实只在一处权威文档详述，其余文档引用而非复制（本文只做索引与地图）。
2. **代码变更 → 先看是否触及红线**（PROJECT_CONVENTIONS），再更新 DEVELOPMENT_GUIDE / 根 README，最后回本文校对代码地图与速查表。
3. **正文只保留当前生效方案**——历史性/过程性文档一律清理，避免"已弃用描述"污染权威文档（如 Windows/Nginx/PM2/珠海一中旧方案已移除）。
4. 发现**前后端不一致 / 技术债**，登记到 [`DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md) §9 与 [`PROJECT_CONVENTIONS.md`](./PROJECT_CONVENTIONS.md) §13，不要散落在各处注释。

---

## 7. 相关文档一览

- 系统总览（项目入口）：[`README.md`（根）](../README.md)
- 开发文档（随代码更新）：[`docs/DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md)
- 长期规范（最高优先）：[`docs/PROJECT_CONVENTIONS.md`](./PROJECT_CONVENTIONS.md)
- 后端子项目：[`backend/README.md`](../backend/README.md)
- 部署方案：[`deploy/README.md`](../deploy/README.md)
- 近期变更日志：[`docs/CHANGELOG.md`](./CHANGELOG.md)
- 待修复问题清单：[`docs/fix/`](./fix/)
- 测试结果快照：[`docs/test-results/`](./test-results/README.md)
