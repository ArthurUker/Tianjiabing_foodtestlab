# 食品安全检验管理系统 Pro 部署与运维指南

**文档名称**：`DEPLOYMENT_GUIDE.md`  
**系统名称**：食品安全检验管理系统 Pro / 田家炳中学食品安全检验系统  
**项目名称**：`tianjiabing-foodtestlab`  
**部署分支**：`runon_tencentcloud`  
**部署环境**：腾讯云 Windows Server  
**后端目录**：`backend/`  
**后端默认端口**：`3001`  
**前端生产访问端口**：`8081`  
**PM2 进程名**：`foodtestlab-api`  
**数据库类型**：Prisma + SQLite  
**数据库文件**：`D:\foodtestlab\data\foodtestlab.db`  
**文档版本**：v1.4  
**更新时间**：2026-06-16  
**适用对象**：后端开发人员、前端开发人员、测试人员、部署运维人员、项目交接人员  

---

## 1. 文档目的

本文档用于说明食品安全检验管理系统 Pro 在腾讯云 Windows Server 环境中的部署、更新、运维、回滚、Nginx 配置、PM2 进程管理、数据库初始化、常见故障排查以及 `runon_tencentcloud` 分支管理规则。

本文档适用于以下场景：

1. 新服务器首次部署；
2. 腾讯云 Windows Server 上线部署；
3. 线上版本更新；
4. 后端 API 服务重启；
5. 前端静态资源重新构建；
6. Nginx 反向代理配置检查；
7. SQLite 数据库初始化、备份与恢复；
8. 登录失败、500 错误、API 地址异常、数据库迁移异常等问题排查；
9. 同一台服务器上食品检验系统与 RDPMS 系统共存运维；
10. 后续项目维护、交接和二次开发。

若本文档与旧文档或历史说明存在不一致，当前腾讯云生产部署应以本文档为准。

若本文档与实际代码存在不一致，应优先以以下文件为准：

```text
deploy.ps1
backend/server.js
backend/package.json
backend/prisma/schema.prisma
backend/prisma/seed.js
C:\nginx\conf\nginx.conf
```

---

## 2. 快速部署摘要

适用于服务器环境已准备完成、项目目录已存在的常规更新部署。

### 2.1 一键部署

```powershell
cd C:\foodtestlab
.\deploy.ps1
```

如 PowerShell 执行策略限制脚本运行，可使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

### 2.2 部署后快速验证

```powershell
pm2 list
Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -UseBasicParsing
```

浏览器访问：

```text
http://公网IP:8081
```

### 2.3 首次登录账号

当前 `seed.js` 首次初始化时会创建以下账号：

| 用户名 | 初始密码 | 角色 | 用途 |
|---|---|---|---|
| `admin` | `8888` | `admin` | 管理员 |
| `operator` | `operator123` | `operator` | 测试员 |
| `viewer` | `viewer123` | `viewer` | 查看员 |

生产环境首次登录后，必须立即修改 `admin` 密码。  
如 `operator` 和 `viewer` 示例账号无实际业务需要，应修改密码或禁用。

---

## 3. 系统概述

食品安全检验管理系统 Pro 是面向学校食品安全快速检测场景开发的轻量化 Web 管理系统，用于记录、管理和追踪食堂相关检测数据，包括：

- 餐具洁净度检测；
- 果蔬农药残留检测；
- 食用油品质检测；
- 肉蛋类相关检测；
- 病原体检测；
- 检测记录查询、编辑、导出；
- 用户管理；
- 审计日志；
- 数据备份与恢复；
- 访客或快速访问模式。

系统采用前后端分离的轻量化架构：

| 层级 | 组件 | 说明 |
|---|---|---|
| 用户访问层 | 浏览器 | 用户通过公网 IP 和端口访问系统 |
| Web 服务层 | Nginx | 托管前端静态文件，反向代理 API 请求 |
| 前端应用层 | HTML / CSS / JavaScript ES Modules | 页面渲染、路由控制、权限校验、本地缓存 |
| 后端服务层 | Node.js / Express | 提供 REST API、认证、权限、业务逻辑 |
| 进程管理层 | PM2 | 守护后端 Node.js 进程 |
| 数据访问层 | Prisma ORM | 统一访问数据库 |
| 数据持久层 | SQLite | 保存用户、检测记录、审计日志等数据 |
| 服务器层 | 腾讯云 Windows Server | 承载 Nginx、Node.js、PM2 和 SQLite 数据文件 |

---

## 4. 生产部署架构

### 4.1 请求流向

```text
用户浏览器
  ↓
http://公网IP:8081
  ↓
Nginx 监听 8081
  ├── /             → C:\foodtestlab\dist\index.html
  ├── /js /css 等   → C:\foodtestlab\dist 静态资源
  └── /api/*        → http://127.0.0.1:3001/api/*
                       ↓
                     Node.js + Express 后端
                       ↓
                     Prisma ORM
                       ↓
                     D:\foodtestlab\data\foodtestlab.db
```

### 4.2 生产访问地址

| 类型 | 地址 |
|---|---|
| 前端公网访问地址 | `http://公网IP:8081` |
| API 公网基础路径 | `http://公网IP:8081/api` |
| 公网健康检查 | `http://公网IP:8081/api/health` |
| 后端本机服务地址 | `http://127.0.0.1:3001` |
| 后端本机 API 基础路径 | `http://127.0.0.1:3001/api` |
| 后端本机健康检查 | `http://127.0.0.1:3001/api/health` |
| 登录接口 | `POST /api/user/login` |

生产环境推荐统一使用：

```text
/api
```

作为前端访问后端的 API 前缀，避免前端硬编码 `localhost`、服务器内网地址或后端直连端口。

---

## 5. 目录规划

### 5.1 项目目录

| 项目 | 路径 |
|---|---|
| 项目根目录 | `C:\foodtestlab` |
| 前端目录 | `C:\foodtestlab` |
| 后端目录 | `C:\foodtestlab\backend` |
| 前端构建产物目录 | `C:\foodtestlab\dist` |
| 部署脚本 | `C:\foodtestlab\deploy.ps1` |
| Nginx 安装目录 | `C:\nginx` |
| Nginx 主配置文件 | `C:\nginx\conf\nginx.conf` |
| Nginx WebRoot | `C:\foodtestlab\dist` |
| 数据目录 | `D:\foodtestlab\data` |
| SQLite 数据库文件 | `D:\foodtestlab\data\foodtestlab.db` |
| 建议备份目录 | `D:\foodtestlab\backup` |

### 5.2 项目结构参考

```text
C:\foodtestlab
├── backend
│   ├── server.js
│   ├── package.json
│   ├── .env
│   ├── prisma
│   │   ├── schema.prisma
│   │   ├── seed.js
│   │   ├── dedupe-test-records.js
│   │   └── foodtestlab.db
│   ├── routes
│   ├── modules
│   ├── middleware
│   └── sql
├── dist
│   └── index.html
├── scripts
│   └── build-static.js
├── deploy.ps1
├── package.json
├── package-lock.json
├── .env
└── README.md
```

生产环境中，SQLite 数据库文件应放置在独立数据目录：

```text
D:\foodtestlab\data\foodtestlab.db
```

不建议将生产数据库文件放在：

```text
C:\foodtestlab\dist
```

或任何可被 Nginx 直接访问的 WebRoot 目录下。

---

## 6. 环境要求

### 6.1 推荐环境

| 组件 | 推荐要求 |
|---|---|
| 操作系统 | Windows Server 2019 / 2022 |
| 云服务器 | 腾讯云 Windows Server |
| PowerShell | Windows PowerShell 5.1 或以上 |
| Node.js | 推荐 Node.js 20.x |
| 当前参考 Node.js | `v20.12.2` |
| npm | 随 Node.js 安装 |
| Git | Git for Windows |
| PM2 | 全局安装 |
| Nginx | Windows 版 Nginx |
| 数据库 | SQLite |
| ORM | Prisma Client `5.10.0` |
| 后端框架 | Express |
| 前端架构 | 原生 HTML + JavaScript ES Modules |

### 6.2 环境检查命令

```powershell
node -v
npm -v
git --version
pm2 -v
C:\nginx\nginx.exe -v
```

查看 Windows Server 版本：

```powershell
systeminfo | findstr /B /C:"OS Name" /C:"OS Version"
```

### 6.3 PM2 安装

如服务器尚未安装 PM2，可执行：

```powershell
npm install -g pm2
```

验证：

```powershell
pm2 -v
```

---

## 7. 端口规划与双系统隔离

当前服务器同时部署 RDPMS 系统和食品检验系统，两套系统通过端口和 PM2 进程名隔离。

| 系统 | 前端端口 | API 端口 | PM2 进程名 |
|---|---:|---:|---|
| RDPMS | `8080` | `3000` | `rdpms-backend` |
| 食品检验系统 | `8081` | `3001` | `foodtestlab-api` |

食品检验系统端口说明：

| 项目 | 端口 | 说明 |
|---|---:|---|
| 前端访问端口 | `8081` | Nginx 对公网提供服务 |
| 后端 API 端口 | `3001` | Node.js Express 本机监听 |
| API 前缀 | `/api` | 所有正式 API 推荐经 `/api` 访问 |
| 健康检查 | `/api/health` | 推荐生产健康检查路径 |

### 7.1 双系统防冲突原则

同一服务器同时部署 RDPMS 与食品检验系统时，应避免以下资源冲突：

| 冲突类型 | 风险 | 食品系统约定 |
|---|---|---|
| 端口冲突 | 服务无法启动或请求转发错误 | 前端 `8081`，API `3001` |
| PM2 名称冲突 | 误停止或误重启其他系统 | `foodtestlab-api` |
| Nginx 配置覆盖 | 覆盖 RDPMS 配置导致旧系统不可访问 | 保留 `8080` 与 `8081` 两个 server |
| 数据库路径冲突 | 数据串库或误删 | `D:\foodtestlab\data\foodtestlab.db` |
| 前端构建目录冲突 | 静态资源互相覆盖 | `C:\foodtestlab\dist` |
| 环境变量冲突 | API 端口、数据库路径错误 | 使用独立 `.env` 和 `backend\.env` |
| 日志混淆 | 排查困难 | PM2 进程名和日志分别管理 |
| 部署脚本误操作 | 误停止其他系统 | 仅操作 `foodtestlab-api` |

部署或修改 Nginx 配置时，必须确认 RDPMS 的 `8080` server block 未被删除。

部署脚本会检查：

1. 食品系统端口不得与 RDPMS 端口冲突；
2. 食品系统前端端口和 API 端口不得相同；
3. 食品系统 PM2 名称不得使用 `rdpms-backend`；
4. 食品系统默认 PM2 名称为 `foodtestlab-api`。

正常提示示例：

```text
端口矩阵通过：食品系统 8081/3001 与 RDPMS 8080/3000 已隔离
PM2 名称检查通过：foodtestlab-api 与 rdpms-backend 已隔离
```

---

## 8. 腾讯云安全组配置

建议按最小开放原则配置安全组。

| 端口 | 用途 | 建议公网开放 |
|---:|---|---|
| `8081` | 食品检验系统前端访问入口 | 是 |
| `3001` | 食品检验系统后端 API | 否，仅本机访问 |
| `8080` | RDPMS 前端访问入口 | 如仍使用则开放 |
| `3000` | RDPMS 后端 API | 否，仅本机访问 |
| `3389` | Windows 远程桌面 | 是，但建议限制管理 IP |
| `80` | 标准 HTTP | 如后续绑定域名再开放 |
| `443` | 标准 HTTPS | 如后续启用 HTTPS 再开放 |

生产环境下，浏览器应访问：

```text
http://公网IP:8081
```

后端 API 端口 `3001` 不建议直接暴露到公网，应仅由 Nginx 在本机反向代理访问。

---

## 9. Git 分支策略

### 9.1 部署分支

当前腾讯云生产部署使用：

```bash
runon_tencentcloud
```

该分支用于维护腾讯云 Windows Server 部署适配内容，包括：

1. Windows 路径适配；
2. 腾讯云端口规划；
3. Nginx 与 PM2 部署脚本；
4. SQLite 生产数据路径；
5. RDPMS 与食品检验系统双系统隔离；
6. 部署脚本 `deploy.ps1`；
7. 与腾讯云运行环境相关的配置说明。

### 9.2 使用原则

1. 日常功能开发可在主分支或功能分支进行；
2. 涉及腾讯云部署的改动，应合并至 `runon_tencentcloud`；
3. 服务器部署默认拉取 `runon_tencentcloud`；
4. 不建议直接在服务器上修改业务代码；
5. 如因紧急问题直接修改服务器代码，应及时回传至 Git 仓库；
6. 部署前应确认当前分支、远程地址和最近提交记录。

### 9.3 分支检查命令

```powershell
cd C:\foodtestlab
git branch
git status
git log --oneline -5
git remote -v
```

预期当前分支为：

```text
runon_tencentcloud
```

---

## 10. 环境变量配置

### 10.1 文件位置

当前项目可能存在两个 `.env` 文件：

| 文件 | 说明 |
|---|---|
| `C:\foodtestlab\.env` | 根目录环境变量 |
| `C:\foodtestlab\backend\.env` | 后端运行时环境变量 |

`deploy.ps1` 会检查根目录 `.env`。如果 `backend/.env` 不存在，会将根目录 `.env` 复制到后端目录。

### 10.2 生产环境推荐 `.env`

```env
NODE_ENV=production

PORT=3001
SERVE_STATIC=false

CORS_ORIGIN=http://公网IP:8081

JWT_SECRET=<请替换为生产环境随机强密钥>
JWT_EXPIRES_IN=7d
JWT_EXPIRE=7d

DATABASE_URL="file:D:/foodtestlab/data/foodtestlab.db"

API_BASE_URL=http://127.0.0.1:3001
API_TIMEOUT=30000

CACHE_ENABLED=true
CACHE_MAX_SIZE=100
CACHE_DEFAULT_TTL=3600000
CACHE_ENABLE_LOCALSTORAGE=true

AUTH_TOKEN_KEY=auth_token
AUTH_TOKEN_REFRESH_INTERVAL=600000

LOG_LEVEL=info
LOG_FILE=logs/app.log

FEATURE_CACHE=true
FEATURE_VALIDATION=true
FEATURE_AUDIT_LOG=true
FEATURE_OFFLINE_MODE=false

DEBUG_MODE=false
MOCK_API=false
```

### 10.3 关键变量说明

| 变量 | 推荐值 | 说明 |
|---|---|---|
| `NODE_ENV` | `production` | 生产环境标识 |
| `PORT` | `3001` | 后端 Express 监听端口 |
| `SERVE_STATIC` | `false` | 静态资源由 Nginx 托管 |
| `CORS_ORIGIN` | `http://公网IP:8081` | 允许访问后端的前端来源 |
| `JWT_SECRET` | 随机强密钥 | 生产环境必须修改 |
| `JWT_EXPIRES_IN` | `7d` | Token 有效期 |
| `JWT_EXPIRE` | `7d` | 兼容当前后端读取字段 |
| `DATABASE_URL` | `file:D:/foodtestlab/data/foodtestlab.db` | 生产 SQLite 数据库路径 |
| `API_BASE_URL` | `http://127.0.0.1:3001` | 后端本机地址 |
| `DEBUG_MODE` | `false` | 生产关闭调试 |
| `MOCK_API` | `false` | 生产关闭模拟 API |

### 10.4 SQLite 口径说明

当前部署统一采用：

```text
Prisma + SQLite
```

生产数据库文件为：

```text
D:\foodtestlab\data\foodtestlab.db
```

早期文档中出现的 PostgreSQL 配置仅作为后续扩展规划或历史示例，不作为当前腾讯云 Windows Server 正式部署依据。

---

## 11. 部署前检查清单

部署前建议按以下清单检查。

| 类别 | 检查项 | 命令或说明 |
|---|---|---|
| Git | 当前分支为 `runon_tencentcloud` | `git branch` |
| Git | 工作区无未提交修改 | `git status` |
| Git | 确认最近提交 | `git log --oneline -5` |
| 环境 | Node 可用 | `node -v` |
| 环境 | npm 可用 | `npm -v` |
| 环境 | PM2 可用 | `pm2 -v` |
| 环境 | Git 可用 | `git --version` |
| Nginx | nginx.exe 存在 | `Test-Path C:\nginx\nginx.exe` |
| Nginx | 配置语法正确 | `C:\nginx\nginx.exe -t` |
| 数据库 | 部署前备份 SQLite | 复制 `D:\foodtestlab\data\foodtestlab.db` |
| 端口 | 8081 未被异常占用 | `netstat -ano | findstr ":8081"` |
| 端口 | 3001 未被异常占用 | `netstat -ano | findstr ":3001"` |
| 双系统 | RDPMS 端口仍为 8080/3000 | 检查 Nginx 和 PM2 |
| 安全 | `.env` 不使用默认 JWT_SECRET | 检查 `backend\.env` |
| 安全 | 3001 未公网开放 | 检查腾讯云安全组 |

推荐部署前备份数据库：

```powershell
$backupDir = "D:\foodtestlab\backup"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item "D:\foodtestlab\data\foodtestlab.db" "$backupDir\foodtestlab-$(Get-Date -Format yyyyMMdd-HHmmss).db"
```

---

## 12. 一键部署脚本 `deploy.ps1`

### 12.1 脚本位置

```text
C:\foodtestlab\deploy.ps1
```

执行方式：

```powershell
cd C:\foodtestlab
.\deploy.ps1
```

如 PowerShell 执行策略限制脚本运行，可使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

### 12.2 默认参数

| 参数 | 默认值 |
|---|---|
| Git 仓库 | `https://github.com/ArthurUker/Tianjiabing_foodtestlab.git` |
| 部署分支 | `runon_tencentcloud` |
| 项目根目录 | `C:\foodtestlab` |
| 后端目录 | `C:\foodtestlab\backend` |
| 前端目录 | `C:\foodtestlab` |
| Nginx 目录 | `C:\nginx` |
| Nginx WebRoot | `C:\foodtestlab\dist` |
| 前端端口 | `8081` |
| API 端口 | `3001` |
| PM2 进程名 | `foodtestlab-api` |
| 数据目录 | `D:\foodtestlab\data` |

### 12.3 可通过环境变量覆盖的参数

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DEPLOY_BRANCH` | `runon_tencentcloud` | 部署分支 |
| `REPO_ROOT` | `C:\foodtestlab` | 项目根目录 |
| `BACKEND_PATH` | `C:\foodtestlab\backend` | 后端目录 |
| `FRONTEND_PATH` | `C:\foodtestlab` | 前端目录 |
| `NGINX_ROOT` | `C:\nginx` | Nginx 目录 |
| `FRONTEND_PORT` | `8081` | 前端访问端口 |
| `API_PORT` | `3001` | 后端 API 端口 |
| `PM2_APP_NAME` | `foodtestlab-api` | PM2 进程名 |
| `DATA_PATH` | `D:\foodtestlab\data` | 数据库目录 |

示例：

```powershell
$env:DEPLOY_BRANCH="runon_tencentcloud"
$env:FRONTEND_PORT="8081"
$env:API_PORT="3001"
$env:PM2_APP_NAME="foodtestlab-api"
.\deploy.ps1
```

### 12.4 脚本执行流程

`deploy.ps1` 主要执行以下步骤：

1. 创建部署日志；
2. 输出基础部署信息；
3. 检查 `git`、`node`、`npm`、`pm2`；
4. 检查 `C:\nginx\nginx.exe`；
5. 检查食品系统与 RDPMS 系统端口隔离；
6. 检查 Git 仓库；
7. 非 Git 仓库时克隆 `runon_tencentcloud` 分支；
8. 已有 Git 仓库时停止 PM2 后端并拉取最新代码；
9. 检查和复制 `.env`；
10. 安装后端依赖；
11. 创建 `D:\foodtestlab\data`；
12. 写入或更新 `DATABASE_URL`；
13. 执行 `npx prisma generate`；
14. 执行 `npx prisma db push --accept-data-loss`；
15. 执行 `node prisma/seed.js`；
16. 启动或重启 PM2 后端；
17. 执行 `pm2 save`；
18. 安装前端依赖；
19. 执行 `npm run build`；
20. 验证 `dist/index.html`；
21. 检查 Nginx 配置；
22. 必要时写入双系统 Nginx 模板；
23. 执行 `nginx.exe -t`；
24. 执行 `nginx.exe -s reload`；
25. 轮询本机 API 健康检查；
26. 输出部署完成信息。

### 12.5 部署日志

日志目录：

```text
%TEMP%\foodtestlab-deploy-logs
```

日志文件示例：

```text
deploy-20260616-120000.log
```

部署完成后，脚本会输出实际日志路径。

### 12.6 部署成功标志

正常部署应出现类似信息：

```text
数据库 schema 同步完成
种子数据初始化完成
前端构建验证通过：dist/index.html 存在
nginx: configuration file C:\nginx/conf/nginx.conf test is successful
API 健康检查通过：http://127.0.0.1:3001/api/health 状态码: 200
食品检验系统部署完成
```

---

## 13. 部署后验收清单

部署完成后应进行以下验收。

| 类别 | 检查项 | 验收方式 |
|---|---|---|
| PM2 | 食品系统进程在线 | `pm2 list` |
| 后端 | 本机健康检查通过 | `http://127.0.0.1:3001/api/health` |
| Nginx | 配置语法正确 | `C:\nginx\nginx.exe -t` |
| 前端 | 页面可访问 | `http://公网IP:8081` |
| API | 公网 API 可访问 | `http://公网IP:8081/api/health` |
| 登录 | `admin` 可登录 | `admin / 8888` |
| 安全 | 登录后修改 admin 密码 | 人工确认 |
| 双系统 | RDPMS 不受影响 | `http://公网IP:8080` |
| 数据库 | SQLite 文件存在 | `D:\foodtestlab\data\foodtestlab.db` |
| 日志 | 无明显启动错误 | `pm2 logs foodtestlab-api` |

本机健康检查命令：

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -UseBasicParsing
```

浏览器访问：

```text
http://公网IP:8081
```

---

## 14. 后端部署说明

### 14.1 后端技术栈

| 项目 | 内容 |
|---|---|
| 后端框架 | Express |
| 后端入口 | `backend/server.js` |
| 模块类型 | ESM，`"type": "module"` |
| ORM | Prisma Client |
| 数据库 | SQLite |
| 认证方式 | JWT Bearer Token |
| 密码加密 | bcryptjs |
| 默认端口 | `3001` |

### 14.2 后端 package.json 关键命令

后端目录：

```powershell
cd C:\foodtestlab\backend
```

常用命令：

```powershell
npm start
npm run dev
npm run db:generate
npm run db:push
npm run seed
```

对应关系：

| 命令 | 实际执行 |
|---|---|
| `npm start` | `node server.js` |
| `npm run dev` | `node --watch server.js` |
| `npm run db:generate` | `prisma generate` |
| `npm run db:push` | `prisma db push` |
| `npm run seed` | `node prisma/seed.js` |

生产环境通过 PM2 启动：

```powershell
pm2 start server.js --name foodtestlab-api --cwd C:\foodtestlab\backend --time
```

### 14.3 依赖安装

部署脚本逻辑：

```powershell
cd C:\foodtestlab\backend

if (Test-Path "package-lock.json") {
    npm ci
} else {
    npm install
}
```

推荐生产环境保留 `package-lock.json`，以便使用 `npm ci` 安装确定版本依赖。

---

## 15. 前端部署说明

### 15.1 前端技术栈

当前前端为：

```text
原生 HTML + JavaScript ES Modules + Tailwind CSS + 静态构建脚本
```

不是 React、Vue 或 Angular 项目。

前端入口：

```text
index.html
```

登录页面：

```text
login.html
```

前端构建产物目录：

```text
C:\foodtestlab\dist
```

### 15.2 根目录 package.json 关键命令

根目录：

```powershell
cd C:\foodtestlab
```

常用命令：

```powershell
npm run build
npm start
```

对应关系：

| 命令 | 实际执行 |
|---|---|
| `npm run build` | `node scripts/build-static.js` |
| `npm run build:prod` | `node scripts/build-static.js` |
| `npm start` | `node backend/server.js` |

生产环境前端由 Nginx 托管，不通过 Node.js 直接托管静态文件。

### 15.3 构建验证

构建完成后应确认：

```text
C:\foodtestlab\dist\index.html
```

存在。

验证命令：

```powershell
Test-Path C:\foodtestlab\dist\index.html
```

---

## 16. 数据库部署与 Prisma 管理

### 16.1 数据库类型

当前生产环境使用：

```text
SQLite
```

数据库文件路径：

```text
D:\foodtestlab\data\foodtestlab.db
```

Prisma 连接字符串：

```env
DATABASE_URL="file:D:/foodtestlab/data/foodtestlab.db"
```

### 16.2 Prisma datasource 配置

当前 `backend/prisma/schema.prisma` 中 datasource 明确配置为 SQLite：

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

因此，当前腾讯云部署不需要安装 PostgreSQL。

早期文档或注释中如出现：

```text
PostgreSQL production
```

应理解为后续扩展规划或历史注释，不作为当前部署依据。

### 16.3 Prisma 文件

| 文件 | 说明 |
|---|---|
| `backend/prisma/schema.prisma` | Prisma 数据模型定义 |
| `backend/prisma/seed.js` | 种子数据初始化脚本 |
| `backend/prisma/dedupe-test-records.js` | 检测记录去重脚本 |
| `backend/prisma/foodtestlab.db` | 开发环境数据库文件 |
| `D:\foodtestlab\data\foodtestlab.db` | 生产环境数据库文件 |

### 16.4 数据模型总览

当前 `schema.prisma` 定义了以下模型：

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

### 16.5 User 模型

`User` 用于保存正式系统用户。

关键字段：

| 字段 | 说明 |
|---|---|
| `id` | CUID 主键 |
| `username` | 用户名，唯一 |
| `email` | 邮箱，唯一，可为空 |
| `password_hash` | bcrypt 密码哈希 |
| `full_name` | 姓名 |
| `phone` | 电话 |
| `role` | 角色，默认为 `user` |
| `status` | 状态，默认为 `active` |
| `last_login` | 最后登录时间 |

角色说明：

```text
admin / manager / operator / viewer / user
```

状态说明：

```text
active / disabled
```

### 16.6 AuditLog 模型

`AuditLog` 用于记录用户操作审计。

| 字段 | 说明 |
|---|---|
| `user_id` | 关联用户 |
| `action` | 操作类型，如 login / create / update / delete / export / import |
| `resource_type` | 资源类型 |
| `resource_id` | 资源 ID |
| `details` | JSON 字符串详情 |
| `ip_address` | IP 地址 |
| `created_at` | 创建时间 |

### 16.7 TestRecord 模型

`TestRecord` 是检测记录主表。

| 字段 | 说明 |
|---|---|
| `record_code` | 检测记录编号，唯一 |
| `test_type` | 检测类型 |
| `test_name` | 检测名称 |
| `sample_info` | 样本信息，JSON 字符串 |
| `result_data` | 检测结果，JSON 字符串 |
| `status` | 状态 |
| `created_by` | 创建用户 |
| `version` | 版本号，用于冲突检查 |
| `completed_at` | 完成时间 |

检测类型参考：

```text
pathogen / tableware / generic / custom
```

状态参考：

```text
pending / completed / failed / archived
```

### 16.8 数据库同步命令

部署脚本会执行：

```powershell
cd C:\foodtestlab\backend
npx prisma generate
npx prisma db push --accept-data-loss
node prisma/seed.js
```

命令说明：

| 命令 | 说明 |
|---|---|
| `npx prisma generate` | 生成 Prisma Client |
| `npx prisma db push --accept-data-loss` | 将 Prisma schema 同步到 SQLite |
| `node prisma/seed.js` | 初始化基础账号和系统日志 |

### 16.9 `--accept-data-loss` 风险提示

当前部署脚本使用：

```powershell
npx prisma db push --accept-data-loss
```

该命令在 schema 变更时可能执行破坏性结构同步。生产部署前应先备份数据库。

---

## 17. 种子数据与默认账号

### 17.1 seed.js 执行位置

```text
C:\foodtestlab\backend\prisma\seed.js
```

部署脚本会在后端目录执行：

```powershell
node prisma/seed.js
```

### 17.2 初始化逻辑

当前 `seed.js` 使用 `ensureUser(user, plainPassword)` 逻辑初始化用户：

1. 先通过 `username` 查询用户是否已存在；
2. 如果用户已存在，则输出“账户已存在，跳过”；
3. 如果用户不存在，则使用 `bcryptjs.hash(plainPassword, 10)` 生成密码哈希；
4. 创建初始用户；
5. 最后写入一条 `SystemLog`，内容为“数据库初始化完成”。

因此，`seed.js` 不会在每次部署时覆盖已经存在用户的密码。

### 17.3 初始账号

当前种子脚本首次执行时会创建以下账号：

| 用户名 | 初始密码 | 角色 | 邮箱 | 说明 |
|---|---|---|---|---|
| `admin` | `8888` | `admin` | `admin@foodlab.local` | 管理员 |
| `operator` | `operator123` | `operator` | `operator@foodlab.local` | 测试员 |
| `viewer` | `viewer123` | `viewer` | `viewer@foodlab.local` | 查看员 |

### 17.4 重复执行 seed.js 的影响

因当前 `seed.js` 在创建用户前会检查用户是否存在：

```text
已存在的账号会跳过，不会覆盖密码。
```

因此，重复执行：

```powershell
node prisma/seed.js
```

通常不会重置已有用户密码。

但它会继续尝试写入系统日志：

```text
数据库初始化完成
```

因此多次执行后，`SystemLog` 中可能出现多条初始化日志。

### 17.5 安全要求

生产部署完成后，必须执行以下安全操作：

1. 首次登录后立即修改 `admin` 初始密码；
2. 不应长期使用 `8888` 作为管理员密码；
3. 如不需要 `operator` 或 `viewer` 示例账号，应禁用或修改密码；
4. 不应将生产真实密码写入公开仓库；
5. 若系统对外长期开放，应建立密码复杂度和定期变更制度。

---

## 18. 登录与 Token 验证

当前正式登录接口为：

```text
POST /api/user/login
```

请求示例：

```json
{
  "username": "admin",
  "password": "8888"
}
```

登录成功后，前端会将认证信息保存至浏览器本地存储：

```text
localStorage.auth_token
localStorage.current_user
```

后续访问受保护 API 时，请求头应包含：

```http
Authorization: Bearer <token>
```

如果页面可访问但 API 返回 `401 Unauthorized`，应重点检查：

1. 是否已成功登录；
2. `localStorage.auth_token` 是否存在；
3. Token 是否过期；
4. 后端 `JWT_SECRET` 是否发生变化；
5. 前端请求是否使用 `/api/...` 路径；
6. 后端认证中间件是否正常挂载。

---

## 19. Nginx 配置说明

### 19.1 Nginx 文件位置

| 项目 | 路径 |
|---|---|
| Nginx 安装目录 | `C:\nginx` |
| 主配置文件 | `C:\nginx\conf\nginx.conf` |
| 启动文件 | `C:\nginx\nginx.exe` |
| access 日志 | `C:\nginx\logs\access.log` |
| error 日志 | `C:\nginx\logs\error.log` |

### 19.2 当前实际 Nginx 配置

当前服务器使用双系统 Nginx 配置：

- `8080`：RDPMS 系统；
- `8081`：食品检验系统。

完整配置如下：

```nginx
worker_processes  1;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout 65;

    client_body_temp_path C:/nginx/temp/client_body_temp;
    proxy_temp_path       C:/nginx/temp/proxy_temp;
    fastcgi_temp_path     C:/nginx/temp/fastcgi_temp;
    uwsgi_temp_path       C:/nginx/temp/uwsgi_temp;
    scgi_temp_path        C:/nginx/temp/scgi_temp;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript application/xml+rss application/xml image/svg+xml;
    gzip_min_length 1024;

    server {
        listen 8080;
        server_name _;

        root  C:/rdpms/rdpms-system/frontend/dist;
        index index.html;

        location / {
            try_files $uri $uri/ /index.html;
        }

        location /api/ {
            proxy_pass         http://127.0.0.1:3000;
            proxy_http_version 1.1;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_read_timeout 60s;
        }
    }

    server {
        listen 8081;
        server_name _;

        root  C:/foodtestlab/dist;
        index index.html;

        location / {
            try_files $uri $uri/ /index.html;
        }

        location /api/ {
            proxy_pass         http://127.0.0.1:3001;
            proxy_http_version 1.1;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_read_timeout 60s;
        }
    }
}
```

### 19.3 食品检验系统关键配置说明

| 配置 | 说明 |
|---|---|
| `listen 8081` | 食品检验系统公网访问端口 |
| `root C:/foodtestlab/dist` | 食品系统前端构建产物目录 |
| `index index.html` | 默认入口文件 |
| `try_files $uri $uri/ /index.html` | 支持前端路由刷新 |
| `location /api/` | API 反向代理入口 |
| `proxy_pass http://127.0.0.1:3001` | 转发到本机食品系统后端 |
| `proxy_read_timeout 60s` | API 读取超时时间 |
| `gzip on` | 启用 gzip 压缩 |
| `server_name _` | 接收任意 Host |

### 19.4 配置检查和重载

```powershell
cd C:\nginx
.\nginx.exe -t
.\nginx.exe -s reload
```

如 Nginx 尚未启动：

```powershell
C:\nginx\nginx.exe
```

### 19.5 查看日志

```powershell
Get-Content C:\nginx\logs\error.log -Tail 100
Get-Content C:\nginx\logs\access.log -Tail 100
```

---

## 20. PM2 进程管理

### 20.1 进程名称

| 系统 | PM2 进程名 |
|---|---|
| 食品检验系统 | `foodtestlab-api` |
| RDPMS | `rdpms-backend` |

### 20.2 常用命令

```powershell
pm2 list
pm2 logs foodtestlab-api
pm2 restart foodtestlab-api --update-env
pm2 stop foodtestlab-api
pm2 describe foodtestlab-api
pm2 save
```

### 20.3 正常状态

正常情况下：

```text
foodtestlab-api    online
rdpms-backend      online
```

### 20.4 Windows 重启后的恢复

如服务器重启后 PM2 进程未恢复，可执行：

```powershell
cd C:\foodtestlab\backend
pm2 start server.js --name foodtestlab-api --cwd C:\foodtestlab\backend --time
pm2 save
```

如已配置 PM2 保存状态，可尝试：

```powershell
pm2 resurrect
```

---

## 21. Nginx 与 PM2 开机自启建议

### 21.1 Nginx 开机自启

Windows 版 Nginx 默认不会自动注册为系统服务。可选方式包括：

1. 手动启动；
2. Windows 计划任务；
3. NSSM 注册为 Windows 服务。

最简单的手动恢复方式：

```powershell
C:\nginx\nginx.exe
```

推荐生产环境使用 NSSM 或计划任务实现开机自启。

### 21.2 PM2 开机自启

`deploy.ps1` 会执行：

```powershell
pm2 save
```

但 Windows 环境下，`pm2 save` 不等同于已完成开机自启配置。

如服务器重启后后端未自动恢复，应执行：

```powershell
pm2 resurrect
```

或重新启动：

```powershell
cd C:\foodtestlab\backend
pm2 start server.js --name foodtestlab-api --cwd C:\foodtestlab\backend --time
pm2 save
```

推荐后续使用 `pm2-windows-startup`、Windows 计划任务或 NSSM 配置开机自启。

---

## 22. 健康检查与部署验证

### 22.1 本机 API 健康检查

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -UseBasicParsing
```

### 22.2 公网 API 健康检查

```text
http://公网IP:8081/api/health
```

### 22.3 前端页面访问

```text
http://公网IP:8081
```

### 22.4 登录接口

当前正式登录接口：

```text
POST /api/user/login
```

以下历史路径不作为正式接口使用：

```text
POST /api/login
POST /api/auth/login
```

### 22.5 初始账号登录验证

| 用户名 | 初始密码 | 角色 | 用途 |
|---|---|---|---|
| `admin` | `8888` | `admin` | 管理员验证 |
| `operator` | `operator123` | `operator` | 操作员验证 |
| `viewer` | `viewer123` | `viewer` | 查看员验证 |

验证通过后，应立即修改管理员密码。

---

## 23. 手动部署流程

如不使用 `deploy.ps1`，可按以下步骤手动部署。

### 23.1 拉取代码

```powershell
cd C:\foodtestlab
git fetch origin
git checkout runon_tencentcloud
git reset --hard origin/runon_tencentcloud
```

### 23.2 安装后端依赖

```powershell
cd C:\foodtestlab\backend
npm ci
```

如无 `package-lock.json`：

```powershell
npm install
```

### 23.3 配置数据库目录

```powershell
New-Item -ItemType Directory -Path D:\foodtestlab\data -Force
```

确认 `backend\.env`：

```env
DATABASE_URL="file:D:/foodtestlab/data/foodtestlab.db"
```

### 23.4 Prisma 同步

```powershell
cd C:\foodtestlab\backend
npx prisma generate
npx prisma db push --accept-data-loss
node prisma/seed.js
```

### 23.5 启动后端

```powershell
cd C:\foodtestlab\backend
pm2 start server.js --name foodtestlab-api --cwd C:\foodtestlab\backend --time
pm2 save
```

如进程已存在：

```powershell
pm2 restart foodtestlab-api --update-env
```

### 23.6 构建前端

```powershell
cd C:\foodtestlab
npm ci
npm run build
```

验证：

```powershell
Test-Path C:\foodtestlab\dist\index.html
```

### 23.7 检查 Nginx

```powershell
cd C:\nginx
.\nginx.exe -t
.\nginx.exe -s reload
```

### 23.8 验证服务

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -UseBasicParsing
```

浏览器访问：

```text
http://公网IP:8081
```

---

## 24. 数据库备份与恢复

### 24.1 部署前备份

每次部署前建议备份：

```powershell
$backupDir = "D:\foodtestlab\backup"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item "D:\foodtestlab\data\foodtestlab.db" "$backupDir\foodtestlab-$(Get-Date -Format yyyyMMdd-HHmmss).db"
```

### 24.2 恢复数据库

```powershell
pm2 stop foodtestlab-api

Copy-Item "D:\foodtestlab\backup\foodtestlab-备份时间.db" "D:\foodtestlab\data\foodtestlab.db" -Force

pm2 restart foodtestlab-api --update-env
```

### 24.3 恢复后验证

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -UseBasicParsing
```

---

## 25. 回滚流程

### 25.1 代码回滚

查看最近提交：

```powershell
cd C:\foodtestlab
git log --oneline -10
```

回滚到指定提交：

```powershell
git reset --hard <commit_id>
```

重新部署：

```powershell
.\deploy.ps1
```

### 25.2 数据库回滚

如果本次部署涉及数据库结构或数据变更，应同步恢复部署前备份的数据库文件。

```powershell
pm2 stop foodtestlab-api
Copy-Item "D:\foodtestlab\backup\foodtestlab-备份时间.db" "D:\foodtestlab\data\foodtestlab.db" -Force
pm2 restart foodtestlab-api --update-env
```

---

## 26. 常见问题排查

### 26.1 访问页面正常，但登录时报 500

可能原因：

1. 后端服务异常；
2. 数据库 schema 未同步；
3. `DATABASE_URL` 指向错误；
4. `JWT_SECRET` 未配置；
5. 用户表不存在；
6. `seed.js` 未成功执行；
7. 前端请求了历史登录路径。

排查命令：

```powershell
pm2 list
pm2 logs foodtestlab-api
Test-Path D:\foodtestlab\data\foodtestlab.db
Get-Content C:\foodtestlab\backend\.env
```

修复参考：

```powershell
cd C:\foodtestlab\backend
npx prisma generate
npx prisma db push --accept-data-loss
node prisma/seed.js
pm2 restart foodtestlab-api --update-env
```

### 26.2 公网 `/api/health` 返回 502

可能原因：

1. PM2 后端未启动；
2. 后端未监听 `3001`；
3. Nginx 代理端口错误；
4. 后端启动后崩溃。

排查：

```powershell
pm2 list
pm2 logs foodtestlab-api
netstat -ano | findstr ":3001"
Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -UseBasicParsing
```

### 26.3 页面能打开，但接口 404

可能原因：

1. 前端请求了历史接口；
2. Nginx `/api/` 代理配置错误；
3. 后端实际路由未启用。

当前正式接口包括：

```text
GET  /api/health
POST /api/user/login
POST /api/user/logout
GET  /api/records/:tableName
POST /api/records/:tableName
GET  /api/test-records
POST /api/test-records
```

不建议使用：

```text
/api/login
/api/auth/login
/api/audit
/api/sync
```

### 26.4 访客功能或导出申请接口不可用

如果前端访客注册、访客登录或导出申请功能异常，并出现以下接口 404：

```text
/api/guest/*
/api/guest-export-request/*
```

应优先检查后端是否已经实现并在 `backend/server.js` 中挂载相关路由。

当前部署成功标准以已启用 API 为准，包括：

```text
/api/health
/api/user
/api/users
/api/audit-logs
/api/test-records
/api/records/:tableName
```

未实现或未挂载的历史接口不应直接判断为 Nginx 或 PM2 部署失败。

### 26.5 页面刷新后 404

检查 Nginx 是否包含：

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

修改后执行：

```powershell
cd C:\nginx
.\nginx.exe -t
.\nginx.exe -s reload
```

### 26.6 前端白屏

排查：

```powershell
Test-Path C:\foodtestlab\dist\index.html
Get-ChildItem C:\foodtestlab\dist
Get-Content C:\nginx\logs\error.log -Tail 100
```

同时在浏览器开发者工具中查看：

1. Console 是否有 JavaScript 报错；
2. Network 中 JS/CSS 是否 404；
3. API 请求路径是否为 `/api/...`。

### 26.7 数据库文件不存在

检查：

```powershell
Test-Path D:\foodtestlab\data
Test-Path D:\foodtestlab\data\foodtestlab.db
```

如目录不存在：

```powershell
New-Item -ItemType Directory -Path D:\foodtestlab\data -Force
```

重新同步：

```powershell
cd C:\foodtestlab\backend
npx prisma generate
npx prisma db push --accept-data-loss
node prisma/seed.js
```

### 26.8 初始账号无法登录

可能原因：

1. `seed.js` 未执行成功；
2. 数据库文件路径不是当前后端读取的路径；
3. 账号已存在但密码曾被修改；
4. 前端请求了错误登录接口；
5. 后端 `JWT_SECRET` 或认证逻辑异常。

排查步骤：

```powershell
cd C:\foodtestlab\backend
node prisma/seed.js
pm2 restart foodtestlab-api --update-env
pm2 logs foodtestlab-api
```

注意：由于 `seed.js` 对已存在账号会跳过，因此如果 `admin` 密码已被修改，再次执行 `seed.js` 不会恢复为 `8888`。

### 26.9 端口冲突

```powershell
netstat -ano | findstr ":8081"
netstat -ano | findstr ":3001"
netstat -ano | findstr ":8080"
netstat -ano | findstr ":3000"
```

如果部署脚本提示端口占用，在系统已运行的情况下可能是正常现象。应确认占用进程是否为预期的 Nginx 或 Node 服务。

### 26.10 GitHub 拉取失败

脚本有 3 次 `git fetch` 重试机制。若失败，会使用服务器本地已有代码继续部署。

检查：

```powershell
cd C:\foodtestlab
git remote -v
git branch
git status
git log --oneline -5
```

### 26.11 Nginx reload 返回异常

如 Nginx 未启动，先执行：

```powershell
C:\nginx\nginx.exe
```

再执行：

```powershell
cd C:\nginx
.\nginx.exe -t
.\nginx.exe -s reload
```

### 26.12 API 返回 401 Unauthorized

可能原因：

1. 未登录；
2. Token 不存在；
3. Token 已过期；
4. 前端未携带 `Authorization: Bearer <token>`；
5. 后端 `JWT_SECRET` 变化导致旧 Token 全部失效；
6. 当前账号被禁用。

排查建议：

1. 重新登录；
2. 清理浏览器 localStorage；
3. 检查浏览器 Network 请求头；
4. 查看 PM2 后端日志；
5. 确认用户状态为 `active`。

---

## 27. 服务器重启后的恢复检查

服务器重启后建议依次检查：

```powershell
pm2 list
netstat -ano | findstr ":3001"
netstat -ano | findstr ":8081"
Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -UseBasicParsing
```

如 PM2 进程不存在：

```powershell
cd C:\foodtestlab\backend
pm2 start server.js --name foodtestlab-api --cwd C:\foodtestlab\backend --time
pm2 save
```

如 Nginx 未启动：

```powershell
C:\nginx\nginx.exe
```

最后访问：

```text
http://公网IP:8081
```

---

## 28. 运维检查清单

### 28.1 每次部署前

| 检查项 | 命令或说明 |
|---|---|
| 确认当前分支 | `git branch` |
| 确认工作区状态 | `git status` |
| 确认远程提交 | `git log --oneline -5` |
| 备份数据库 | 复制 `D:\foodtestlab\data\foodtestlab.db` |
| 确认环境变量 | 检查 `backend\.env` |
| 确认磁盘空间 | 检查 C 盘和 D 盘 |
| 确认 RDPMS 不受影响 | 检查端口 `8080/3000` |
| 确认 Nginx 配置 | `C:\nginx\nginx.exe -t` |

### 28.2 每次部署后

| 检查项 | 命令或说明 |
|---|---|
| PM2 状态 | `pm2 list` |
| 后端日志 | `pm2 logs foodtestlab-api` |
| 本机健康检查 | `http://127.0.0.1:3001/api/health` |
| 公网健康检查 | `http://公网IP:8081/api/health` |
| 前端页面 | `http://公网IP:8081` |
| 登录接口 | `POST /api/user/login` |
| 初始账号检查 | `admin / 8888`，首次登录后应修改密码 |
| Nginx 配置 | `C:\nginx\nginx.exe -t` |

---

## 29. 安全注意事项

1. 生产环境必须修改 `JWT_SECRET`；
2. 生产环境不应长期使用默认管理员密码；
3. 初始管理员 `admin / 8888` 仅用于首次部署验证，验证后必须修改；
4. 示例账号 `operator / operator123` 与 `viewer / viewer123` 如无业务需要，应修改密码或禁用；
5. 不建议将 `3001` API 端口暴露至公网；
6. SQLite 数据库不得放在 WebRoot 目录；
7. 每次部署前应备份数据库；
8. `.env` 不应提交到公开仓库；
9. 腾讯云 `3389` 远程桌面端口建议限制为固定管理 IP；
10. Nginx 日志和 PM2 日志应定期清理；
11. 后续如启用域名访问，建议配置 HTTPS；
12. 如涉及敏感检测数据，应建立定期备份和访问审计制度；
13. 不应将邮件密码、JWT 密钥、数据库连接串等敏感配置写入前端代码。

---

## 30. 与历史文档的口径差异说明

当前腾讯云 Windows Server 部署以本文档为准。早期文档中存在部分规划性或历史性描述，不代表当前生产部署状态。

| 历史或规划性表述 | 当前实际部署 |
|---|---|
| Docker / Kubernetes 部署 | 当前使用 Windows Server + PM2 |
| systemd 服务 | 当前 Windows 环境不使用 systemd |
| PostgreSQL 生产数据库 | 当前使用 SQLite |
| Redis 缓存 | 当前未部署 Redis |
| Elasticsearch / Kibana | 当前未部署 |
| Prometheus / Grafana | 当前未部署 |
| React 前端 | 当前为原生 HTML + JavaScript ES Modules |
| 应用端口 3000 | 食品系统 API 端口为 `3001` |
| 前端 localhost:3000 | 生产前端为 `http://公网IP:8081` |
| `admin@foodlab.com` | 当前 seed.js 使用 `admin@foodlab.local` |
| `/api/login` | 当前正式登录接口为 `/api/user/login` |
| Supabase 数据存储 | 当前已迁移为 Prisma + SQLite |

如后续升级为 PostgreSQL、Redis、Docker、HTTPS 或标准域名架构，应另行编写迁移部署文档。

---

## 31. 关键命令速查

### 31.1 一键部署

```powershell
cd C:\foodtestlab
.\deploy.ps1
```

### 31.2 PM2

```powershell
pm2 list
pm2 logs foodtestlab-api
pm2 restart foodtestlab-api --update-env
pm2 stop foodtestlab-api
pm2 save
```

### 31.3 Nginx

```powershell
cd C:\nginx
.\nginx.exe -t
.\nginx.exe -s reload
C:\nginx\nginx.exe
```

### 31.4 健康检查

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:3001/api/health" -UseBasicParsing
```

### 31.5 Prisma

```powershell
cd C:\foodtestlab\backend
npx prisma generate
npx prisma db push --accept-data-loss
node prisma/seed.js
```

### 31.6 前端构建

```powershell
cd C:\foodtestlab
npm run build
```

### 31.7 端口检查

```powershell
netstat -ano | findstr ":8081"
netstat -ano | findstr ":3001"
netstat -ano | findstr ":8080"
netstat -ano | findstr ":3000"
```

### 31.8 日志查看

```powershell
pm2 logs foodtestlab-api
Get-Content C:\nginx\logs\error.log -Tail 100
Get-Content C:\nginx\logs\access.log -Tail 100
```

### 31.9 初始账号

```text
admin / 8888
operator / operator123
viewer / viewer123
```

---

## 32. 版本记录

| 版本 | 日期 | 修改内容 | 修改人 |
|---|---|---|---|
| v1.0 | 2026-06-16 | 基于架构、API、前端、数据库、部署脚本和环境配置资料生成初版 | 项目组 |
| v1.1 | 2026-06-16 | 补充部署文件读取异常说明和资料获取建议 | 项目组 |
| v1.2 | 2026-06-16 | 基于现有资料和部署脚本模板形成完整可交付版，固化 Nginx、Prisma、PM2、SQLite、故障排查和运维流程 | 项目组 |
| v1.3 | 2026-06-16 | 根据真实 `nginx.conf`、`schema.prisma`、`seed.js` 完善 Nginx 双系统配置、SQLite schema、默认账号和初始化规则 | 项目组 |
| v1.4 | 2026-06-16 | 增加快速部署摘要、部署前后检查清单、双系统防冲突、登录 Token 验证、访客接口风险说明和历史文档口径差异说明 | 项目组 |