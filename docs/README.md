# 田家炳中学食品安全检验系统

## 1. 项目简介

**田家炳中学食品安全检验系统** 是面向学校食品安全快速检测场景开发的轻量化信息管理系统，主要用于记录、管理和追踪食堂相关检测数据，包括：

- 餐具洁净度检测；
- 果蔬农药残留检测；
- 食用油品质检测；
- 肉、蛋类相关检测；
- 病原体检测；
- 检测记录查询与归档；
- 用户管理；
- 审计日志；
- 数据备份与恢复；
- 访客或快速访问模式。

本系统当前定位为：

- 学校食品安全检测工作的数字化记录工具；
- 食堂日常检测数据的归档与查询平台；
- 管理员进行用户管理、审计追踪和数据维护的内部系统；
- 后续功能扩展、部署运维和多开发者协作的基础项目。

当前项目已针对 **腾讯云 Windows Server 部署场景** 完成适配，并已形成较完整的架构、接口、前端、数据库、部署与运维文档。

---

## 2. 当前系统状态

本项目当前已具备以下基础能力：

- 前端页面可独立加载和运行；
- 前端采用原生 HTML、CSS、JavaScript ES Modules 架构；
- 后端基于 Node.js + Express.js 提供 REST API；
- 使用 Prisma ORM 管理数据库访问；
- 当前腾讯云生产部署使用 SQLite；
- 支持 JWT 登录认证；
- 支持管理员、操作员、查看员等角色；
- 支持用户管理；
- 支持操作审计日志；
- 支持检测记录录入、查询和管理；
- 支持本地缓存与数据同步机制；
- 已适配腾讯云 Windows Server、Nginx、PM2 部署流程；
- 已支持与同服务器 RDPMS 系统通过端口、路径和 PM2 进程名隔离运行。

当前主要部署分支为：

```bash
runon_tencentcloud
```

涉及腾讯云服务器部署、生产环境修复或线上功能更新时，原则上应优先基于该分支进行开发、提交和部署。

---

## 3. 当前生产部署口径

当前腾讯云 Windows Server 生产部署以以下口径为准。

| 项目 | 当前配置 |
|---|---|
| 部署环境 | 腾讯云 Windows Server |
| 部署分支 | `runon_tencentcloud` |
| 项目目录 | `C:\foodtestlab` |
| 前端托管 | Nginx 静态资源托管 |
| 前端访问端口 | `8081` |
| 后端服务 | Node.js + Express |
| 后端 API 端口 | `3001` |
| PM2 进程名 | `foodtestlab-api` |
| 数据库 | Prisma + SQLite |
| 生产数据库文件 | `D:\foodtestlab\data\foodtestlab.db` |
| API 前缀 | `/api` |
| 正式登录接口 | `POST /api/user/login` |

生产访问方式：

```text
http://公网IP:8081
```

本机 API 健康检查：

```text
http://127.0.0.1:3001/api/health
```

公网 API 健康检查：

```text
http://公网IP:8081/api/health
```

> 说明：早期文档中出现的 PostgreSQL、Docker、Kubernetes、Redis、Prometheus、Grafana、React、端口 3000 等内容，均不代表当前腾讯云生产部署状态。当前部署与运维请以 `DEPLOYMENT_GUIDE.md` 为准。

---

## 4. 技术栈

### 4.1 前端技术

| 项目 | 说明 |
|---|---|
| 页面形式 | 原生 HTML + JavaScript ES Modules |
| 样式 | Tailwind CSS / 静态样式 |
| 路由 | 自定义前端 Router |
| 数据缓存 | localStorage |
| 图表与看板 | 前端模块内实现 |
| 入口页面 | `index.html` |
| 登录页面 | `login.html` |
| 构建方式 | 静态构建脚本 |
| 生产托管 | Nginx |

### 4.2 后端技术

| 项目 | 说明 |
|---|---|
| 运行环境 | Node.js |
| 当前参考 Node 版本 | `v20.12.2` |
| 后端框架 | Express.js |
| ORM | Prisma / `@prisma/client v5.10.0` |
| 数据库 | SQLite |
| 认证方式 | JWT Bearer Token |
| 密码加密 | bcryptjs |
| 后端入口 | `backend/server.js` |
| 进程管理 | PM2 |

### 4.3 数据库

| 环境 | 数据库 | 说明 |
|---|---|---|
| 本地开发 | SQLite | 本地文件数据库 |
| 当前生产部署 | SQLite | 腾讯云 Windows Server 当前实际部署方式 |
| 后续扩展 | PostgreSQL | 可作为未来企业级扩展选项 |
| ORM | Prisma | 通过 `schema.prisma` 管理模型 |

当前生产数据库文件：

```text
D:\foodtestlab\data\foodtestlab.db
```

当前 Prisma datasource：

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

当前生产环境推荐连接字符串：

```env
DATABASE_URL="file:D:/foodtestlab/data/foodtestlab.db"
```

如后续正式切换 PostgreSQL，应同步修改：

- `schema.prisma` 中的 datasource provider；
- `.env` 中的 `DATABASE_URL`；
- 部署脚本；
- 数据迁移方案；
- `DATABASE_SCHEMA.md`；
- `DEPLOYMENT_GUIDE.md`。

---

## 5. 主要功能模块

### 5.1 前端页面与模块

| 文件或模块 | 功能描述 |
|---|---|
| `index.html` | 应用主页，展示主要功能入口和导航菜单 |
| `login.html` | 用户登录页面 |
| `js/core/Router.js` | 前端路由、权限控制、页面导航 |
| `js/modules/Dashboard.js` | 数据看板模块，显示统计数据、图表和风险提示 |
| `js/modules/UserManagement.js` | 用户管理模块，支持用户列表、创建、编辑和删除 |
| `js/modules/AuditLog.js` | 操作审计日志模块，支持筛选、分页和导出 |
| `js/modules/BackupRestore.js` | 数据备份与恢复模块 |
| `js/modules/GenericTest.js` | 通用检测模块 |
| `js/modules/GuestDashboard.js` | 访客数据看板模块 |
| `js/modules/Pathogen.js` | 病原体检测模块 |
| `js/modules/Tableware.js` | 餐具洁净度检测模块 |

### 5.2 当前检测业务模块

系统当前主要覆盖以下检测类型：

- 餐具洁净度检测；
- 果蔬农残检测；
- 食用油品质检测；
- 肉、蛋类相关检测；
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

## 6. 后端 API 概览

当前后端正式 API 以 `API_REFERENCE.md` 为准。

常用接口概览如下：

| 方法 | 路径 | 功能描述 |
|---|---|---|
| `GET` | `/api/health` | 健康检查 |
| `POST` | `/api/user/login` | 用户登录，返回 JWT Token |
| `POST` | `/api/user/logout` | 用户登出 |
| `GET` | `/api/users` | 获取用户列表 |
| `POST` | `/api/users` | 创建用户 |
| `PUT` | `/api/users/:id` | 更新用户 |
| `DELETE` | `/api/users/:id` | 删除用户 |
| `GET` | `/api/audit-logs` | 获取审计日志 |
| `GET` | `/api/test-records` | 获取检测记录 |
| `POST` | `/api/test-records` | 创建检测记录 |
| `GET` | `/api/records/:tableName` | 获取指定类型记录 |
| `POST` | `/api/records/:tableName` | 创建指定类型记录 |

以下历史路径不作为当前正式登录接口：

```text
/api/login
/api/auth/login
```

详细接口说明请参考：

```text
API_REFERENCE.md
```

前后端联调说明可参考：

```text
API_INTEGRATION_GUIDE.md
```

---

## 7. 数据库结构概览

当前数据库由 Prisma 管理，核心文件包括：

```text
backend/prisma/schema.prisma
backend/prisma/seed.js
```

当前 `schema.prisma` 中主要模型包括：

| 模型 | 说明 |
|---|---|
| `User` | 用户账号、角色、状态、登录信息 |
| `AuditLog` | 用户操作审计日志 |
| `TestRecord` | 检测记录主表 |
| `TestItem` | 检测项目或检测明细 |
| `Attachment` | 附件或文件信息 |
| `Guest` | 访客账号信息 |
| `Backup` | 系统备份元数据 |
| `SystemLog` | 系统运行日志 |

数据库结构详见：

```text
DATABASE_SCHEMA.md
```

---

## 8. 初始账号

当前 `backend/prisma/seed.js` 首次执行时会创建以下账号：

| 用户名 | 初始密码 | 角色 | 邮箱 |
|---|---|---|---|
| `admin` | `8888` | `admin` | `admin@foodlab.local` |
| `operator` | `operator123` | `operator` | `operator@foodlab.local` |
| `viewer` | `viewer123` | `viewer` | `viewer@foodlab.local` |

`seed.js` 的初始化逻辑为：

- 若账号不存在，则创建账号；
- 若账号已存在，则跳过；
- 重复执行不会覆盖已存在账号的密码；
- 每次执行会写入系统初始化日志。

> 生产环境首次登录后，必须立即修改 `admin` 默认密码。  
> 如不需要 `operator` 或 `viewer` 示例账号，应修改密码或禁用。

---

## 9. 本地开发启动方式

### 9.1 环境要求

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

### 9.2 安装依赖

在项目根目录执行：

```bash
npm install
```

如后端依赖位于 `backend` 目录，则进入后端目录执行：

```bash
cd backend
npm install
```

具体以当前项目 `package.json` 和 `backend/package.json` 为准。

### 9.3 配置环境变量

在后端目录下创建 `.env` 文件，开发环境示例：

```env
NODE_ENV=development
PORT=3001
DATABASE_URL="file:./foodtestlab.db"
JWT_SECRET="please_change_this_secret"
JWT_EXPIRES_IN=7d
```

说明：

- 当前开发和生产均可使用 SQLite；
- 生产环境 `DATABASE_URL` 应指向 `D:/foodtestlab/data/foodtestlab.db`；
- `JWT_SECRET` 必须在生产环境中替换为强随机字符串；
- `.env` 不应提交到 Git 仓库。

### 9.4 初始化 Prisma

在后端目录执行：

```bash
cd backend
npx prisma generate
npx prisma db push
node prisma/seed.js
```

### 9.5 启动后端服务

后端入口文件为：

```text
backend/server.js
```

启动命令：

```bash
cd backend
node server.js
```

或根据 `backend/package.json`：

```bash
npm start
```

### 9.6 启动前端页面

前端入口为：

```text
index.html
```

可通过以下方式访问：

1. 使用浏览器直接打开 `index.html`；
2. 使用本地静态服务器；
3. 在腾讯云部署环境中通过 Nginx 访问。

为避免浏览器跨域、模块加载或缓存问题，推荐使用本地静态服务器方式进行开发调试。

---

## 10. 生产部署

当前项目已围绕 **腾讯云 Windows Server 部署** 形成专门文档。

生产部署、更新、回滚、数据库备份、Nginx 配置、PM2 管理、双系统防冲突和故障排查，请统一参考：

```text
DEPLOYMENT_GUIDE.md
```

生产部署快速命令：

```powershell
cd C:\foodtestlab
.\deploy.ps1
```

部署后验证：

```powershell
pm2 list
Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -UseBasicParsing
```

浏览器访问：

```text
http://公网IP:8081
```

---

## 11. Git 分支与协作规范

### 11.1 当前主要分支

| 分支 | 用途 |
|---|---|
| `runon_tencentcloud` | 腾讯云部署和生产环境适配分支 |
| `main` 或 `master` | 如存在，通常作为主干或归档分支，具体以仓库实际情况为准 |

### 11.2 提交前检查

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

### 11.3 推荐提交信息格式

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

### 11.4 推荐开发流程

1. 从远程同步最新代码；
2. 确认当前分支；
3. 修改代码；
4. 本地测试；
5. 更新相关文档；
6. 提交 commit；
7. 推送到远程；
8. 按 `DEPLOYMENT_GUIDE.md` 更新服务器；
9. 完成上线后验证。

---

## 12. 文档导航

当前项目建议保留以下正式文档：

| 文档 | 说明 |
|---|---|
| `README.md` | 项目总入口与文档导航 |
| `ARCHITECTURE.md` | 系统架构、部署拓扑、核心数据流说明 |
| `API_REFERENCE.md` | 后端正式 API 文档 |
| `DATABASE_SCHEMA.md` | 数据库模型、字段、关系和索引说明 |
| `FRONTEND_GUIDE.md` | 前端模块、路由、缓存和页面开发说明 |
| `DEPLOYMENT_GUIDE.md` | 腾讯云 Windows Server 部署与运维主文档 |

开发和历史参考文档可按项目实际情况放入：

```text
docs/dev/
docs/review/
docs/archive/
```

推荐分类：

| 目录 | 建议内容 |
|---|---|
| `docs/dev/` | API 联调、工具类集成、快速修复参考 |
| `docs/review/` | 开发审阅、技术债和优化计划 |
| `docs/archive/` | 已被新文档替代或不再作为当前依据的历史文档 |

---

## 13. 推荐阅读顺序

### 13.1 新开发者接手项目

推荐顺序：

1. `README.md`
2. `ARCHITECTURE.md`
3. `FRONTEND_GUIDE.md`
4. `API_REFERENCE.md`
5. `DATABASE_SCHEMA.md`
6. `DEPLOYMENT_GUIDE.md`

### 13.2 服务器部署或重新部署

推荐顺序：

1. `DEPLOYMENT_GUIDE.md`
2. `API_REFERENCE.md`
3. `DATABASE_SCHEMA.md`

### 13.3 前后端联调

推荐顺序：

1. `API_REFERENCE.md`
2. `API_INTEGRATION_GUIDE.md`
3. `FRONTEND_GUIDE.md`

### 13.4 日常维护和故障排查

推荐顺序：

1. `DEPLOYMENT_GUIDE.md`
2. `API_REFERENCE.md`
3. `DATABASE_SCHEMA.md`

---

## 14. 常见维护注意事项

### 14.1 修改前端检测项目

如果新增或调整检测项目，例如新增某个胶体金检测卡，应至少检查：

- `index.html` 中对应下拉选项；
- 相关 JS 模块是否存在硬编码校验；
- 后端是否存在白名单校验；
- 示例数据生成器是否需要同步更新；
- 数据看板统计是否受影响；
- 导出功能是否受影响。

### 14.2 修改 API 地址

前端生产请求应优先使用相对路径：

```text
/api/...
```

不建议在前端代码中硬编码：

```text
http://localhost:3001
http://公网IP:3001
```

当前生产环境通过 Nginx 将：

```text
http://公网IP:8081/api/*
```

反向代理至：

```text
http://127.0.0.1:3001/api/*
```

### 14.3 修改数据库结构

修改数据库模型时，应同步处理：

- `backend/prisma/schema.prisma`；
- Prisma Client 生成；
- 数据库同步或迁移；
- 后端 API；
- 前端字段显示；
- 数据导入导出；
- 数据库备份；
- `DATABASE_SCHEMA.md`；
- `DEPLOYMENT_GUIDE.md`。

### 14.4 修改部署脚本

修改部署脚本前，应确认：

- 当前服务器是否同时运行其他系统；
- 端口是否冲突；
- PM2 进程名是否冲突；
- Nginx 配置是否会覆盖其他站点；
- 数据库连接是否指向正确环境；
- 是否已备份现有部署目录和数据库。

---

## 15. 安全注意事项

本项目涉及账号、检测数据和运维配置，开发和部署时应注意：

- 不要提交 `.env` 文件；
- 不要提交真实生产数据库文件；
- 不要在文档中暴露真实服务器密码；
- 生产环境必须修改默认 JWT 密钥；
- 管理员初始密码上线后必须立即修改；
- 示例账号如无业务需要，应修改密码或禁用；
- 生产数据库连接字符串不应写入公开文档；
- 不应将 `3001` API 端口直接暴露到公网；
- SQLite 数据库不得放在 Nginx WebRoot 目录；
- 导出的审计日志和检测记录应按内部数据管理要求保存。

---

## 16. 当前维护建议

为保证后续开发和运维工作顺利推进，建议近期按以下顺序维护项目：

1. 以 `DEPLOYMENT_GUIDE.md` 作为唯一部署与运维主文档；
2. 以 `API_REFERENCE.md` 作为唯一正式 API 文档；
3. 以 `DATABASE_SCHEMA.md` 作为数据库模型说明主文档；
4. 定期同步 `schema.prisma` 与 `DATABASE_SCHEMA.md`；
5. 定期同步后端路由与 `API_REFERENCE.md`；
6. 保持 `README.md` 作为项目总入口和文档导航；
7. 将历史或规划性文档移动至 `docs/archive/`，避免误用；
8. 建立固定的开发、测试、提交、部署流程。

---

## 17. 项目维护人备注

本 README 主要面向以下人员：

- 项目维护者本人；
- 后续共同开发人员；
- 服务器部署和运维协作者；
- 需要理解系统结构并进行功能扩展的开发者。

本文档应随着系统功能、接口、数据库和部署方式变化持续更新，避免出现代码状态与文档状态不一致的问题。

如遇到文档与代码不一致，应优先以以下内容为准：

1. 当前运行环境；
2. 服务器实际配置；
3. `deploy.ps1`；
4. `backend/server.js`；
5. `backend/prisma/schema.prisma`;
6. `backend/prisma/seed.js`;
7. `DEPLOYMENT_GUIDE.md`。