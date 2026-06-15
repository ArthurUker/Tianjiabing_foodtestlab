# 田家炳中学食品安全检验系统

## 1. 项目简介

**田家炳中学食品安全检验系统** 是面向学校食品安全快速检测场景开发的轻量化信息管理系统，主要用于记录、管理和追踪食堂相关检测数据，包括果蔬农残、餐具洁净度、食用油品质、肉蛋类农残、病原体检测等模块。

本系统当前定位为：

- 学校食品安全检测工作的数字化记录工具；
- 食堂日常检测数据的归档与查询平台；
- 管理员进行用户管理、审计追踪和数据维护的内部系统；
- 后续功能扩展、部署运维和多开发者协作的基础项目。

当前项目已针对 **Windows 腾讯云服务器部署场景** 做过适配，并已形成一套较完整的部署、运维和故障排查文档。

---

## 2. 当前系统状态

本项目当前已具备以下基础能力：

- 前端页面可独立加载和运行；
- 后端基于 Express.js 提供 API 服务；
- 使用 Prisma ORM 管理数据库访问；
- 开发环境使用 SQLite；
- 生产环境规划使用 PostgreSQL；
- 支持 JWT 登录认证；
- 支持管理员用户管理；
- 支持操作审计日志；
- 支持本地缓存与数据同步机制；
- 已适配腾讯云 Windows Server 部署流程；
- 已建立运维、部署、接口集成和故障修复相关文档。

当前主要部署分支为：

```bash
runon_tencentcloud
```

后续如涉及腾讯云服务器部署、生产环境修复或线上功能更新，原则上应优先基于该分支进行开发、提交和部署。

---

## 3. 技术栈

### 3.1 前端技术

| 项目 | 说明 |
|---|---|
| 页面形式 | 原生 HTML + JavaScript 模块化组织 |
| 样式 | Tailwind CSS / 静态样式 |
| 路由 | 自定义前端 Router |
| 数据缓存 | localStorage |
| 图表与看板 | 前端模块内实现 |
| 入口页面 | `index.html` |
| 登录页面 | `login.html` |

### 3.2 后端技术

| 项目 | 说明 |
|---|---|
| 运行环境 | Node.js |
| 当前 Node 版本 | `v20.12.2` |
| 后端框架 | Express.js |
| ORM | Prisma / `@prisma/client v5.10.0` |
| 认证方式 | JWT |
| 密码加密 | bcryptjs |
| 后端入口 | `backend/server.js` |

### 3.3 数据库

| 环境 | 数据库 | 说明 |
|---|---|---|
| 开发环境 | SQLite | 本地文件数据库 |
| 生产环境 | PostgreSQL | 根据部署文档配置远程数据库连接 |
| ORM | Prisma | 通过 `schema.prisma` 管理模型 |

开发环境数据库文件位置：

```bash
./prisma/foodtestlab.db
```

数据库连接通过 `.env` 中的 `DATABASE_URL` 配置。

需要注意的是，当前 `schema.prisma` 中的 provider 仍显示为：

```prisma
provider = "sqlite"
```

但连接 URL 通过：

```prisma
env("DATABASE_URL")
```

动态读取。因此在不同环境下，需要结合 Prisma schema、`.env` 配置和部署文档共同确认数据库实际连接方式。

后续如正式切换生产环境 PostgreSQL，建议同步检查并规范化 `schema.prisma` 中的 provider 配置，避免开发环境与生产环境理解不一致。

---

## 4. 主要功能模块

### 4.1 前端页面与模块

| 文件名 | 功能描述 |
|---|---|
| `index.html` | 应用主页，展示主要功能入口和导航菜单 |
| `login.html` | 用户登录页面，用于身份验证和进入系统 |
| `js/core/Router.js` | 管理前端路由、权限控制、页面导航 |
| `js/modules/Dashboard.js` | 数据看板模块，显示统计数据、图表和风险提示 |
| `js/modules/UserManagement.js` | 用户管理模块，支持用户列表、创建、编辑和删除 |
| `js/modules/AuditLog.js` | 操作审计日志模块，支持筛选、分页和导出 |
| `js/modules/BackupRestore.js` | 数据备份与恢复模块，支持本地数据同步和云端恢复 |
| `js/modules/GenericTest.js` | 通用检测模块，当前主要用于食用油品质等通用检测数据 |
| `js/modules/GuestDashboard.js` | 访客数据看板模块，支持导出申请和记录展示 |
| `js/modules/Pathogen.js` | 病原体检测模块，支持检测报告解析及筛选逻辑 |
| `js/modules/Tableware.js` | 餐具洁净度检测模块，支持点位事件绑定和结果更新 |

### 4.2 当前检测业务模块

系统当前主要覆盖以下检测类型：

- 餐具洁净度检测；
- 果蔬农残检测；
- 食用油品质检测；
- 肉、蛋类农残检测；
- 病原体检测；
- 数据看板统计；
- 用户与权限管理；
- 操作审计日志；
- 数据备份与恢复。

果蔬农残检测当前已包含以下检测项目：

- 克百威-胶体金检测卡；
- 水胺硫磷-胶体金检测卡；
- 噻虫嗪-胶体金检测卡；
- 通用显色试纸；
- 二氧化硫显色试剂。

---

## 5. 后端 API 概览

当前后端主要 API 如下：

| 方法 | 路径 | 功能描述 |
|---|---|---|
| `POST` | `/api/login` | 用户登录，返回身份验证 Token |
| `GET` | `/api/users` | 获取用户列表，支持分页和筛选 |
| `POST` | `/api/users` | 创建新用户 |
| `PUT` | `/api/users/:id` | 更新用户信息 |
| `DELETE` | `/api/users/:id` | 删除用户 |
| `GET` | `/api/audit` | 获取审计日志，支持筛选和分页 |
| `POST` | `/api/audit/export` | 导出审计日志为 CSV 文件 |
| `POST` | `/api/sync` | 数据同步接口，用于上传或下载数据 |

更详细的接口说明请参考：

```bash
docs/API_INTEGRATION_GUIDE.md
```

后续建议新增或补充：

```bash
docs/API_REFERENCE.md
```

用于形成更规范的接口请求参数、响应结构、错误码和权限要求说明。

---

## 6. 数据库结构概览

当前已识别的主要数据库表如下：

| 表名 | 核心字段 |
|---|---|
| `users` | `id`, `username`, `password`, `role`, `created_at`, `updated_at` |
| `guests` | `id`, `name`, `email`, `organization`, `created_at` |
| `audit_logs` | `id`, `action`, `user_id`, `table_name`, `record_id`, `timestamp` |

数据库由 Prisma 管理，核心文件通常包括：

```bash
prisma/schema.prisma
prisma/foodtestlab.db
```

开发环境请优先使用 SQLite，避免直接操作生产环境数据库。

---

## 7. 本地开发启动方式

### 7.1 环境要求

建议本地开发环境：

| 工具 | 推荐版本 |
|---|---|
| Node.js | `v20.12.2` 或兼容版本 |
| npm | 随 Node.js 安装 |
| Git | 最新稳定版 |
| 数据库 | SQLite |
| 编辑器 | VS Code |

检查 Node.js 版本：

```bash
node -v
```

当前项目已验证版本：

```bash
v20.12.2
```

### 7.2 安装依赖

在项目根目录执行：

```bash
npm install
```

如后端依赖位于 `backend` 目录，则进入对应目录后执行：

```bash
cd backend
npm install
```

具体以当前项目 `package.json` 位置为准。

### 7.3 配置环境变量

在项目根目录或后端目录下创建 `.env` 文件，典型配置包括：

```env
DATABASE_URL="file:./foodtestlab.db"
JWT_SECRET="please_change_this_secret"
NODE_ENV="development"
PORT=3000
```

说明：

- 开发环境建议使用 SQLite；
- 生产环境应使用 PostgreSQL 连接字符串；
- `JWT_SECRET` 必须在生产环境中替换为强随机字符串；
- `.env` 不应提交到 Git 仓库。

### 7.4 初始化 Prisma

如首次运行或数据库结构有变更，可执行：

```bash
npx prisma generate
npx prisma migrate dev
```

如项目当前使用已有 SQLite 文件，也可根据实际情况仅执行：

```bash
npx prisma generate
```

### 7.5 启动后端服务

后端入口文件为：

```bash
backend/server.js
```

启动命令：

```bash
node backend/server.js
```

如当前工作目录在 `backend` 下，则可执行：

```bash
node server.js
```

### 7.6 启动前端页面

前端入口为：

```bash
index.html
```

可通过以下方式访问：

1. 使用浏览器直接打开 `index.html`；
2. 使用本地静态服务器；
3. 在腾讯云部署环境中通过 Nginx 访问。

为避免浏览器跨域、模块加载或缓存问题，推荐使用本地静态服务器方式进行开发调试。

---

## 8. 快速访问模式与示例数据

项目中存在示例数据生成器，用于快速访问或演示模式。

相关文件：

```bash
js/utils/SampleDataGenerator.js
```

该模块仅在 URL 中包含以下参数时执行：

```bash
?quickAccess=true
```

其逻辑是：

- 检查是否处于快速访问模式；
- 不清除已有真实缓存数据；
- 仅在缺失对应 `cache_*` 数据时初始化示例数据；
- 初始化后触发 `dataChanged` 事件刷新页面数据。

常见缓存键包括：

| 缓存键 | 说明 |
|---|---|
| `cache_tableware` | 餐具洁净度检测数据 |
| `cache_pesticide` | 果蔬农残检测数据 |
| `cache_oil` | 食用油品质检测数据 |
| `cache_leanMeat` | 肉、蛋类农残检测数据 |
| `cache_pathogen` | 病原体检测数据 |
| `pending_*` | 待同步数据 |

注意：

- 正常登录和真实业务使用时，不依赖示例数据生成器；
- 如仅新增检测项目，通常只需修改前端下拉选项和相关业务校验，不一定需要修改示例数据；
- 如希望演示模式中出现新检测项目，则需要同步更新 `SampleDataGenerator.js`。

---

## 9. 部署说明

当前项目已围绕 **Windows 腾讯云服务器部署** 形成专门文档。

推荐优先阅读：

```bash
docs/ONE_CLICK_DEPLOYMENT_GUIDE.md
```

当前部署重点包括：

- Windows Server 环境；
- Node.js 后端服务；
- Nginx 静态资源与反向代理；
- PostgreSQL 生产数据库；
- 多系统同机部署防冲突；
- PowerShell 部署脚本；
- 端口、路径和 API 地址检查；
- 部署后功能验证。

腾讯云部署相关分支：

```bash
runon_tencentcloud
```

部署前建议确认：

```bash
git branch
git status
git pull origin runon_tencentcloud
```

本地提交并推送：

```bash
git add .
git commit -m "feature: 描述本次功能变更"
git push origin runon_tencentcloud
```

服务器侧根据部署文档执行更新。

---

## 10. Git 分支与协作规范

### 10.1 当前主要分支

| 分支 | 用途 |
|---|---|
| `runon_tencentcloud` | 腾讯云部署和生产环境适配分支 |
| `main` 或 `master` | 如存在，通常作为主干或归档分支，具体以仓库实际情况为准 |

### 10.2 提交前检查

每次提交前建议执行：

```bash
git status
git branch
```

确认：

- 当前是否在正确分支；
- 是否有不应提交的文件；
- 是否误提交 `.env`、数据库文件、日志文件或临时文件；
- 是否存在来自上级目录或其他模块的意外改动。

### 10.3 推荐提交信息格式

```bash
feature: 新增某功能
fix: 修复某问题
docs: 更新文档
refactor: 重构某模块
chore: 调整配置或依赖
deploy: 更新部署相关内容
```

示例：

```bash
git commit -m "feature: 新增果蔬农残检测-噻虫嗪-胶体金检测卡"
```

### 10.4 推荐开发流程

1. 从远程同步最新代码；
2. 确认当前分支；
3. 修改代码；
4. 本地测试；
5. 更新相关文档；
6. 提交 commit；
7. 推送到远程；
8. 按部署文档更新服务器；
9. 完成上线后验证。

---

## 11. 文档导航

本仓库已按 Windows 腾讯云部署、系统集成、运维排障和后续开发协作场景整理文档。

### 11.1 核心运维与部署文档

1. [ONE_CLICK_DEPLOYMENT_GUIDE.md](./docs/ONE_CLICK_DEPLOYMENT_GUIDE.md)

   用途：Windows 腾讯云服务器一键部署首选入口，适合首次部署或重新部署时使用。

2. [SERVER_MULTI_APP_CONFLICT_AVOIDANCE_GUIDE.md](./docs/SERVER_MULTI_APP_CONFLICT_AVOIDANCE_GUIDE.md)

   用途：同一服务器部署多个系统时的防冲突策略，例如 foodtestlab 与 RDPMS 同机部署时的端口、路径、Nginx 和服务隔离方案。

3. [DEPLOYMENT_CHECKLIST.md](./docs/DEPLOYMENT_CHECKLIST.md)

   用途：部署前后检查清单，防止遗漏关键步骤。

4. [OPERATIONS_GUIDE.md](./docs/OPERATIONS_GUIDE.md)

   用途：日常运维、服务启停、日志查看、巡检和基本维护。

5. [QUICK_FIX_GUIDE.md](./docs/QUICK_FIX_GUIDE.md)

   用途：常见故障快速处理，例如 500 错误、API 地址错误、Nginx 配置问题、数据库连接异常等。

### 11.2 开发与集成支撑文档

1. [INTEGRATION_GUIDE.md](./docs/INTEGRATION_GUIDE.md)

   用途：系统集成与对接说明。

2. [DEVELOPMENT_REVIEW_AND_OPTIMIZATION_PLAN.md](./docs/DEVELOPMENT_REVIEW_AND_OPTIMIZATION_PLAN.md)

   用途：代码审阅结果、问题分级、修复与优化计划，是后续开发跟踪的重要入口。

3. [API_INTEGRATION_GUIDE.md](./docs/API_INTEGRATION_GUIDE.md)

   用途：API 对接细节和接口集成说明。

4. [ADMIN_ACCOUNT_SETUP.md](./docs/ADMIN_ACCOUNT_SETUP.md)

   用途：管理员账号初始化、权限配置和初始登录说明。

5. [TENCENT_LOW_SPEC_DEPLOYMENT_TEMPLATE.md](./docs/TENCENT_LOW_SPEC_DEPLOYMENT_TEMPLATE.md)

   用途：腾讯云低配置服务器部署参考模板，适合资源受限场景。

### 11.3 建议后续新增文档

为便于多人开发和长期维护，建议后续补充以下文档：

| 建议文档 | 目的 |
|---|---|
| `docs/ARCHITECTURE.md` | 系统整体架构、数据流、权限模型和部署拓扑 |
| `docs/FRONTEND_GUIDE.md` | 前端模块结构、路由机制、缓存键和页面开发规范 |
| `docs/API_REFERENCE.md` | 标准化 API 请求参数、响应格式、错误码和权限说明 |
| `docs/DATABASE_SCHEMA.md` | 数据库表结构、字段类型、索引和迁移说明 |
| `docs/DEVELOPMENT_GUIDE.md` | 本地开发、调试、测试、代码规范和提交规范 |

---

## 12. 推荐阅读顺序

### 12.1 新开发者接手项目

推荐顺序：

1. `README.md`
2. `docs/DEVELOPMENT_REVIEW_AND_OPTIMIZATION_PLAN.md`
3. `docs/API_INTEGRATION_GUIDE.md`
4. `docs/INTEGRATION_GUIDE.md`
5. `docs/ONE_CLICK_DEPLOYMENT_GUIDE.md`
6. `docs/OPERATIONS_GUIDE.md`

### 12.2 服务器部署或重新部署

推荐顺序：

1. `docs/ONE_CLICK_DEPLOYMENT_GUIDE.md`
2. `docs/SERVER_MULTI_APP_CONFLICT_AVOIDANCE_GUIDE.md`
3. `docs/DEPLOYMENT_CHECKLIST.md`
4. `docs/QUICK_FIX_GUIDE.md`
5. `docs/OPERATIONS_GUIDE.md`

### 12.3 日常维护和故障排查

推荐顺序：

1. `docs/OPERATIONS_GUIDE.md`
2. `docs/QUICK_FIX_GUIDE.md`
3. `docs/DEPLOYMENT_CHECKLIST.md`
4. `docs/API_INTEGRATION_GUIDE.md`

---

## 13. 常见维护注意事项

### 13.1 修改前端检测项目

如果新增或调整检测项目，例如新增某个胶体金检测卡，应至少检查：

- `index.html` 中对应下拉选项；
- 相关 JS 模块是否存在硬编码校验；
- 后端是否存在白名单校验；
- 示例数据生成器是否需要同步更新；
- 数据看板统计是否受影响；
- 导出功能是否受影响。

### 13.2 修改 API 地址

如本地和生产环境 API 地址不同，应避免在多个前端文件中分散硬编码。后续建议统一抽象 API 配置文件，例如：

```bash
js/config/apiConfig.js
```

### 13.3 修改数据库结构

修改数据库模型时，应同步处理：

- `prisma/schema.prisma`；
- migration 文件；
- 后端 API；
- 前端字段显示；
- 数据导入导出；
- 部署文档；
- 数据库备份。

### 13.4 修改部署脚本

修改部署脚本前，应确认：

- 当前服务器是否同时运行其他系统；
- 端口是否冲突；
- Nginx 配置是否会覆盖其他站点；
- 数据库连接是否指向正确环境；
- 是否已备份现有部署目录和数据库。

---

## 14. 安全注意事项

本项目涉及账号、检测数据和运维配置，开发和部署时应注意：

- 不要提交 `.env` 文件；
- 不要提交真实生产数据库文件；
- 不要在文档中暴露真实服务器密码；
- 生产环境必须修改默认 JWT 密钥；
- 管理员初始密码上线后必须立即修改；
- 生产数据库连接字符串不应写入 README；
- 导出的审计日志和检测记录应按内部数据管理要求保存。

---

## 15. 当前维护建议

为保证后续开发工作顺利推进，建议近期按以下顺序完善项目：

1. 完善 `README.md`，作为项目总入口；
2. 编写 `ARCHITECTURE.md`，固化系统架构和数据流；
3. 编写 `FRONTEND_GUIDE.md`，明确前端模块职责和缓存机制；
4. 编写 `API_REFERENCE.md`，规范后端接口；
5. 编写 `DATABASE_SCHEMA.md`，明确数据库模型；
6. 将部署和运维文档继续保持在 `docs/` 目录下统一管理；
7. 建立固定的开发、测试、提交、部署流程。

---

## 16. 项目维护人备注

本 README 主要面向以下人员：

- 项目维护者本人；
- 后续共同开发人员；
- 服务器部署和运维协作者；
- 需要理解系统结构并进行功能扩展的开发者。

本文档应随着系统功能、接口、数据库和部署方式变化持续更新，避免出现代码状态与文档状态不一致的问题。

如遇到文档与代码不一致，应以当前代码和实际部署环境为准，并及时修订文档。