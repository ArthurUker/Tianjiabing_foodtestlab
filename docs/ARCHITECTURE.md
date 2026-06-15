# 食品安全检测系统架构说明

## 1. 文档目的

本文档用于说明食品安全检测系统的整体技术架构、前后端交互方式、服务器部署关系、权限体系、快速访问模式以及核心数据流向。

本文档面向以下人员：

- 系统开发人员
- 部署与运维人员
- 项目管理人员
- 后续维护和二次开发人员

通过本文档，维护人员应能够理解系统由哪些组件组成、各组件之间如何通信、用户权限如何控制，以及数据如何在浏览器、后端服务和数据库之间流转。

---

## 2. 系统概述

食品安全检测系统是一个面向食品安全检测业务场景的 Web 管理系统，用于支持检测数据录入、检测记录管理、访客查看、数据导出、审计日志、备份恢复等功能。

系统主要服务对象包括：

- 系统管理员
- 普通业务用户
- 临时访客或快速访问用户

系统采用前后端分离的轻量化架构，前端由静态 HTML、CSS、JavaScript 模块组成，后端基于 Node.js 与 Express 提供 REST API 服务，数据库通过 Prisma ORM 进行访问和管理。

---

## 3. 技术架构概览

### 3.1 总体架构

系统整体由以下部分组成：

| 层级 | 组件 | 主要职责 |
|---|---|---|
| 用户访问层 | 浏览器 | 访问系统页面，提交业务操作 |
| Web 服务层 | Nginx | 托管前端静态文件，反向代理 API 请求 |
| 前端应用层 | HTML / CSS / JavaScript | 页面渲染、路由控制、表单交互、本地缓存 |
| 后端服务层 | Node.js / Express | 认证、权限、业务逻辑、数据库读写 |
| 数据访问层 | Prisma ORM | 统一访问数据库 |
| 数据持久层 | SQLite / PostgreSQL | 保存用户、检测记录、附件、日志、备份等数据 |
| 服务器层 | 腾讯云服务器 | 承载 Nginx、Node.js 后端服务及数据库 |

---

## 4. 整体架构图

```mermaid
flowchart TD
    A[用户浏览器] --> B[腾讯云公网 IP:8081]
    B --> C[Nginx]

    C -->|静态资源| D[前端静态文件<br/>HTML / CSS / JavaScript]
    C -->|/api/* 反向代理| E[Node.js 后端服务<br/>Express API<br/>127.0.0.1:3001]

    D -->|REST API 请求| E
    D -->|localStorage / IndexedDB| F[浏览器本地缓存]

    E --> G[Prisma ORM]
    G --> H[(数据库<br/>SQLite / PostgreSQL)]

    E --> I[文件与附件存储]
    E --> J[系统日志 / 审计日志]
```

---

## 5. 部署架构

### 5.1 生产环境访问方式

生产环境采用腾讯云服务器部署。

| 项目 | 配置 |
|---|---|
| 公网访问端口 | 8081 |
| 前端访问地址 | `http://公网IP:8081` |
| 后端本地端口 | 3001 |
| 后端本地地址 | `http://127.0.0.1:3001` |
| API 公网路径 | `http://公网IP:8081/api/*` |
| Web 服务器 | Nginx |
| 后端运行时 | Node.js |

---

### 5.2 Nginx 部署关系

Nginx 负责两个核心职责：

1. 托管前端静态资源；
2. 将 `/api/` 开头的请求反向代理到本地 Node.js 后端服务。

典型配置如下：

```nginx
server {
    listen 8081;
    server_name 159.75.106.179;

    root /var/www/foodtestlab;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

如果部署在 Windows Server 环境，前端静态资源目录可调整为：

```text
C:\foodtestlab\dist
```

如果部署在 Linux 环境，推荐目录为：

```text
/var/www/foodtestlab
```

---

### 5.3 静态资源缓存策略

Nginx 对不同资源设置了不同缓存策略：

| 资源类型 | 缓存策略 |
|---|---|
| JS / CSS / 图片 / 字体 | 长缓存，30天 |
| HTML 文件 | 不强缓存 |
| API 请求 | 不由静态缓存处理 |

配置中对静态资源启用了：

```nginx
expires 30d;
add_header Cache-Control "public, max-age=2592000, immutable";
```

对 HTML 文件使用：

```nginx
Cache-Control "no-store, no-cache, must-revalidate";
```

这样可以保证页面入口文件及时更新，同时提高静态资源加载速度。

---

### 5.4 Gzip 压缩

Nginx 启用了基础 gzip 压缩：

```nginx
gzip on;
gzip_types text/plain text/css application/json application/javascript application/xml+rss application/xml;
gzip_min_length 1024;
```

该配置适合低带宽、低规格服务器环境，可降低前端资源和 JSON 数据传输体积。

---

## 6. 前端架构

### 6.1 前端技术形态

本系统前端不是 React 或 Vue 单页应用，而是基于原生 HTML、CSS、JavaScript 的模块化前端架构。

主要入口文件包括：

```text
index.html
login.html
css/style.css
js/main.js
```

前端模块按职责划分为：

```text
js/
├── core/
├── modules/
├── services/
└── utils/
```

---

### 6.2 前端目录说明

| 目录 | 作用 |
|---|---|
| `js/core/` | 核心能力，包括认证、路由、存储等 |
| `js/modules/` | 业务模块，包括 Dashboard、检测模块、用户管理、备份恢复等 |
| `js/services/` | 服务封装，包括认证服务、审计日志服务、导出服务 |
| `js/utils/` | 工具类，包括 API 客户端、缓存管理、校验、网络检测等 |
| `css/` | 全局样式 |
| `docs/` | 项目文档 |
| `deploy/` | 部署配置，包括 Nginx 和 PM2 |
| `scripts/` | 构建、诊断、初始化等脚本 |

---

### 6.3 主要前端模块

| 文件 / 模块 | 职责 |
|---|---|
| `js/main.js` | 系统前端主入口，初始化应用、导航和 quickAccess 逻辑 |
| `js/core/Auth.js` | 前端认证核心逻辑 |
| `js/core/Router.js` | 前端路由和访问控制 |
| `js/core/Storage.js` | 本地存储和缓存封装 |
| `js/services/AuthService.js` | 普通用户登录、token 管理 |
| `js/services/GuestAuthService.js` | 访客登录和快速访问模式 |
| `js/utils/ApiClient.js` | API 请求封装 |
| `js/utils/CacheManager.js` | localStorage 和内存缓存管理 |
| `js/modules/Dashboard.js` | 系统首页和数据看板 |
| `js/modules/GuestDashboard.js` | 访客首页 |
| `js/modules/Tableware.js` | 餐具检测模块 |
| `js/modules/Pathogen.js` | 病原体检测模块 |
| `js/modules/GenericTest.js` | 通用检测模块 |
| `js/modules/UserManagement.js` | 用户管理模块 |
| `js/modules/BackupRestore.js` | 数据备份与恢复 |
| `js/modules/AuditLog.js` | 审计日志展示 |

---

## 7. 后端架构

### 7.1 后端技术栈

后端采用 Node.js + Express 构建，使用 Prisma ORM 访问数据库。

后端主要依赖包括：

| 依赖 | 用途 |
|---|---|
| `express` | Web API 框架 |
| `@prisma/client` | 数据库 ORM 客户端 |
| `prisma` | 数据库 schema 与迁移工具 |
| `bcryptjs` | 密码哈希与密码校验 |
| `jsonwebtoken` | JWT token 生成与验证 |
| `cors` | 跨域访问控制 |
| `dotenv` | 环境变量管理 |

---

### 7.2 后端目录结构

```text
backend/
├── server.js
├── package.json
├── config/
│   └── telemetry.js
├── middleware/
│   ├── idempotencyMiddleware.js
│   └── validationMiddleware.js
├── modules/
│   └── UserManager.js
├── prisma/
│   ├── schema.prisma
│   ├── seed.js
│   └── dedupe-test-records.js
├── routes/
│   ├── auditRoutes.js
│   ├── syncRoutes.js
│   └── userRoutes.js
└── sql/
    ├── 01_users_schema.sql
    ├── 02_guests_schema.sql
    ├── 02_seed_test_users.sql
    └── 03_set_admin_password.sql
```

---

### 7.3 后端服务职责

后端服务主要承担以下职责：

1. 用户登录认证；
2. JWT token 生成与校验；
3. 用户、访客、角色相关管理；
4. 检测记录的增删改查；
5. 审计日志记录；
6. 数据同步；
7. 数据备份元信息管理；
8. 数据库访问与业务校验；
9. API 请求参数校验；
10. 幂等性控制。

---

## 8. 数据库架构

### 8.1 数据库技术

系统使用 Prisma ORM 管理数据库，支持：

- SQLite：适用于本地开发、小规模部署或轻量化场景；
- PostgreSQL：适用于生产环境和多用户并发场景。

Prisma 配置示例：

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

实际部署时，数据库类型和连接地址以 `.env` 中的 `DATABASE_URL` 为准。

---

### 8.2 核心数据表

| 表 / 模型 | 用途 |
|---|---|
| `User` / `users` | 系统用户管理 |
| `Guest` / `guests` | 访客账户管理 |
| `TestRecord` / `test_records` | 检测记录主表 |
| `TestItem` / `test_items` | 检测项目明细 |
| `Attachment` / `attachments` | 附件与文件记录 |
| `AuditLog` / `audit_logs` | 用户操作审计 |
| `Backup` / `backup` | 数据备份元信息 |
| `SystemLog` / `system_logs` | 系统运行日志 |
| `guest_export_requests` | 访客导出申请 |

---

### 8.3 数据库关系

```mermaid
erDiagram
    User ||--o{ TestRecord : creates
    User ||--o{ AuditLog : generates
    User ||--o{ Guest : creates
    TestRecord ||--o{ TestItem : contains
    TestRecord ||--o{ Attachment : has
    Guest ||--o{ GuestExportRequest : submits

    User {
        string id
        string username
        string password_hash
        string role
        string status
        datetime created_at
        datetime last_login
    }

    TestRecord {
        string id
        string record_code
        string test_type
        string test_name
        string status
        string created_by
        datetime created_at
    }

    TestItem {
        string id
        string test_record_id
        string item_name
        string result
    }

    Attachment {
        string id
        string test_record_id
        string file_name
        string file_path
    }

    AuditLog {
        string id
        string user_id
        string action
        string resource_type
        string resource_id
        datetime created_at
    }

    Guest {
        string id
        string username
        string guest_type
        string status
        datetime valid_until
    }

    GuestExportRequest {
        string id
        string guest_id
        string request_type
        string status
    }
```

---

## 9. 前后端交互方式

### 9.1 交互模式

前端和后端采用 REST API 方式通信。

```text
浏览器前端
  ↓ HTTP / JSON
Nginx /api 反向代理
  ↓
Node.js Express API
  ↓
Prisma ORM
  ↓
数据库
```

---

### 9.2 API 基础路径

生产环境中，后端服务监听本地端口：

```text
http://127.0.0.1:3001
```

公网访问通过 Nginx 暴露：

```text
http://公网IP:8081/api/*
```

例如：

```text
POST http://公网IP:8081/api/user/login
GET  http://公网IP:8081/api/health
```

---

### 9.3 登录接口

用户登录接口位于：

```text
POST /api/user/login
```

请求体示例：

```json
{
  "username": "admin",
  "password": "admin123"
}
```

成功响应示例：

```json
{
  "success": true,
  "user": {
    "id": "user_001",
    "username": "admin",
    "role": "admin",
    "status": "active",
    "lastLogin": "2026-06-15T10:00:00Z"
  },
  "token": "jwt-token-string"
}
```

失败响应示例：

```json
{
  "success": false,
  "message": "Incorrect username or password"
}
```

---

### 9.4 登录处理流程

```mermaid
sequenceDiagram
    participant U as 用户
    participant F as 前端 login.html
    participant A as AuthService
    participant N as Nginx
    participant B as Express API
    participant M as UserManager
    participant D as 数据库

    U->>F: 输入用户名和密码
    F->>A: 调用 login(username, password)
    A->>N: POST /api/user/login
    N->>B: 转发到 127.0.0.1:3001
    B->>M: userManager.loginUser()
    M->>D: 查询用户
    D-->>M: 返回用户记录
    M->>M: bcrypt 校验密码
    M->>D: 更新 last_login 并记录登录日志
    M-->>B: 返回 user 和 token
    B-->>A: JSON 响应
    A->>F: 返回登录结果
    F->>F: 保存 token/user 到 localStorage
    F->>U: 跳转 index.html
```

---

### 9.5 请求与响应格式

前端请求后端 API 时，默认使用 JSON 格式：

```http
Content-Type: application/json
```

登录后，前端应在后续请求中携带 token：

```http
Authorization: Bearer <token>
```

常见响应格式为：

```json
{
  "success": true,
  "data": {},
  "message": "操作成功"
}
```

或：

```json
{
  "success": false,
  "message": "错误信息"
}
```

---

### 9.6 常见 HTTP 状态码

| 状态码 | 含义 |
|---:|---|
| 200 | 请求成功 |
| 204 | OPTIONS 预检请求成功 |
| 400 | 请求参数错误或登录失败 |
| 401 | 未认证或 token 无效 |
| 403 | 已认证但无权限 |
| 404 | 接口不存在 |
| 500 | 服务器内部错误 |

---

## 10. localStorage 缓存机制

### 10.1 localStorage 的用途

系统大量使用 `localStorage` 保存前端状态和缓存数据，主要包括：

1. 用户认证 token；
2. 当前用户信息；
3. 访客 token；
4. 当前访客信息；
5. 快速访问模式标识；
6. 业务数据缓存；
7. 审计日志临时缓存；
8. 同步状态；
9. 调试配置；
10. 示例数据。

---

### 10.2 主要 localStorage 字段

| Key | 用途 | 示例 |
|---|---|---|
| `auth_token` | 普通用户登录 token | JWT token |
| `current_user` | 当前登录用户信息 | JSON 字符串 |
| `auth_timestamp` | 登录时间戳 | Unix timestamp |
| `guest_token` | 访客 token | temp-token |
| `current_guest` | 当前访客信息 | JSON 字符串 |
| `is_quick_access` | 是否快速访问模式 | `true` |
| `cache_tableware` | 餐具检测数据缓存 | JSON |
| `cache_pesticide` | 检测数据缓存 | JSON |
| `pending_requests` | 待同步请求 | JSON |
| `block_data_sync` | 是否阻塞数据同步 | boolean |
| `audit_YYYY-MM-DD` | 某日审计日志缓存 | JSON |
| `debug_*` | 调试配置 | string / boolean |

---

### 10.3 localStorage 使用位置

| 文件 | 作用 |
|---|---|
| `js/services/AuthService.js` | 保存、读取和清除用户认证信息 |
| `js/utils/UserAuth.js` | 加载和持久化当前用户 |
| `js/core/Storage.js` | 本地缓存、认证 token 管理 |
| `js/services/GuestAuthService.js` | 访客 token 和访客信息管理 |
| `js/utils/CacheManager.js` | 统一缓存管理 |
| `js/utils/AuditLogger.js` | 前端审计日志缓存 |
| `js/modules/BackupRestore.js` | 备份、同步、缓存清理 |
| `js/main.js` | quickAccess 判断和系统初始化 |
| `js/utils/ApiClient.js` | API token 读取和请求封装 |

---

### 10.4 登录态恢复机制

用户刷新页面后，前端会从 `localStorage` 中读取：

```text
auth_token
current_user
auth_timestamp
```

如果 token 存在且未过期，则恢复用户登录状态，并根据用户角色加载对应菜单和功能。

访客模式下，前端会读取：

```text
guest_token
current_guest
is_quick_access
```

用于恢复访客会话或快速访问状态。

---

### 10.5 缓存安全边界

`localStorage` 位于浏览器端，属于不可信存储。  
因此：

- localStorage 中的角色信息只能用于前端 UI 展示；
- 不应仅依赖 localStorage 判断敏感权限；
- 数据新增、修改、删除、导出、用户管理等操作，应由后端 API 进行最终权限校验；
- token 过期或退出登录时，应清除认证相关数据；
- quickAccess 模式不应授予写入、删除、导出等高风险能力。

---

## 11. 快速访问模式

### 11.1 入口方式

系统支持通过 URL 参数进入快速访问模式：

```text
http://公网IP:8081/?quickAccess=true
```

前端通过以下逻辑识别：

```javascript
const urlParams = new URLSearchParams(window.location.search);
const isQuickAccessParam = urlParams.get('quickAccess') === 'true';
```

同时，系统也会读取 localStorage 中的快速访问标识：

```text
is_quick_access
```

最终判断逻辑为：

```text
URL 参数 quickAccess=true
或
localStorage 中存在 quickAccess 标识
```

---

### 11.2 quickAccess 激活流程

当系统检测到 `quickAccess=true` 且当前没有访客登录态时，会调用：

```javascript
guestAuthService.quickAccessAsViewer()
```

该方法会创建一个临时访客：

```javascript
const tempGuest = {
    id: 'temp_guest',
    username: 'Temporary Guest',
    is_quick_access: true,
    guest_type: 'viewer',
    valid_until: new Date(Date.now() + 3600 * 1000).toISOString()
};
```

并写入：

```text
guest_token
current_guest
is_quick_access
```

---

### 11.3 quickAccess 数据流

```mermaid
flowchart TD
    A[用户访问 ?quickAccess=true] --> B[前端解析 URL 参数]
    B --> C{是否已有访客登录态}
    C -->|否| D[创建临时访客 temp_guest]
    C -->|是| E[复用当前访客状态]
    D --> F[写入 localStorage]
    E --> G[进入访客界面]
    F --> G
    G --> H[隐藏管理菜单]
    H --> I[读取缓存数据]
    I --> J[只读展示数据]
```

---

### 11.4 quickAccess 权限边界

快速访问模式属于 guest viewer 权限，原则上仅允许只读访问。

| 功能 | quickAccess |
|---|---:|
| 查看公开数据 | 允许 |
| 查看缓存数据 | 允许 |
| 查看访客首页 | 允许 |
| 编辑检测记录 | 禁止 |
| 删除检测记录 | 禁止 |
| 用户管理 | 禁止 |
| 数据备份恢复 | 禁止 |
| 查看审计日志 | 禁止 |
| 导出数据 | 禁止 |
| 系统配置 | 禁止 |

---

### 11.5 quickAccess 生命周期

当前实现中，quickAccess 临时访客有效期为 1 小时：

```javascript
valid_until: new Date(Date.now() + 3600 * 1000).toISOString()
```

超出有效期后，应清除对应访客状态或要求重新进入快速访问模式。

---

## 12. 权限体系

### 12.1 权限分层

本文档按产品使用层级将用户划分为三类：

| 角色 | 说明 |
|---|---|
| `admin` | 系统管理员，拥有完整管理权限 |
| `user` | 普通用户，拥有业务数据查看和编辑权限 |
| `guest` | 访客用户，主要用于只读访问和快速访问 |

数据库和后端模型中可进一步扩展：

```text
manager / operator / viewer
```

但在当前系统说明中统一抽象为 admin、user、guest 三级。

---

### 12.2 角色权限说明

#### 12.2.1 admin 管理员

管理员拥有系统最高权限，包括：

- 用户管理；
- 查看和编辑所有检测数据；
- 删除数据；
- 数据导出；
- 数据备份与恢复；
- 查看审计日志；
- 系统配置；
- 访客管理；
- 导出申请审批。

典型模块：

```text
UserManagement
BackupRestore
ExportService
AuditLog
Dashboard
Tableware
Pathogen
GenericTest
```

---

#### 12.2.2 user 普通用户

普通用户拥有有限业务权限，包括：

- 查看部分检测数据；
- 创建检测记录；
- 编辑自己负责的数据；
- 查看业务看板；
- 使用检测模块；
- 不可访问系统管理功能；
- 不可查看审计日志；
- 不可进行系统备份恢复；
- 默认不可导出数据报告。

典型模块：

```text
Dashboard
Tableware
Pathogen
GenericTest
```

---

#### 12.2.3 guest 访客

访客用户拥有只读权限，主要包括：

- 查看访客首页；
- 查看公开数据；
- 在 quickAccess 模式下查看缓存数据；
- 不可新增、编辑、删除数据；
- 不可导出数据；
- 不可访问用户管理；
- 不可访问备份恢复；
- 不可访问审计日志。

典型模块：

```text
GuestDashboard
quickAccess
```

---

### 12.3 权限矩阵

| 功能模块 | admin | user | guest |
|---|---:|---:|---:|
| 登录系统 | 是 | 是 | 可选 |
| 快速访问模式 | 否 | 否 | 是 |
| 查看首页 / 看板 | 是 | 是 | 是 |
| 查看检测记录 | 是 | 部分 | 公开 / 缓存数据 |
| 新增检测记录 | 是 | 是 | 否 |
| 编辑检测记录 | 是 | 自己负责的数据 | 否 |
| 删除检测记录 | 是 | 否 | 否 |
| 数据导出 | 是 | 否 | 否 |
| 用户管理 | 是 | 否 | 否 |
| 访客管理 | 是 | 否 | 否 |
| 数据备份恢复 | 是 | 否 | 否 |
| 查看审计日志 | 是 | 否 | 否 |
| 系统配置 | 是 | 否 | 否 |

---

### 12.4 权限控制实现层级

系统权限控制分布在多个层级：

| 层级 | 作用 |
|---|---|
| 前端路由层 | 判断是否允许访问某页面 |
| 前端 UI 层 | 根据角色隐藏菜单、按钮和管理功能 |
| 前端服务层 | 根据 token 或 guest 状态决定请求方式 |
| 后端 API 层 | 对敏感接口进行认证和权限校验 |
| 数据库层 | 保存用户角色、状态、访客有效期和审计信息 |

需要注意的是，前端权限控制主要提升用户体验，不应作为唯一安全边界。敏感操作必须由后端 API 进行最终校验。

---

## 13. 数据流向说明

### 13.1 普通用户登录数据流

```mermaid
flowchart TD
    A[用户输入账号密码] --> B[前端 login.html]
    B --> C[AuthService.login]
    C --> D[POST /api/user/login]
    D --> E[Nginx 反向代理]
    E --> F[Express userRoutes]
    F --> G[UserManager.loginUser]
    G --> H[Prisma 查询 users 表]
    H --> I{密码是否正确}
    I -->|否| J[返回登录失败]
    I -->|是| K[生成 JWT token]
    K --> L[更新 last_login]
    L --> M[记录登录日志]
    M --> N[返回 user + token]
    N --> O[前端写入 localStorage]
    O --> P[跳转 index.html]
```

---

### 13.2 quickAccess 数据流

```mermaid
flowchart TD
    A[访问 /?quickAccess=true] --> B[main.js 解析 URL]
    B --> C[GuestAuthService 判断 quickAccess]
    C --> D[创建 temp_guest]
    D --> E[写入 guest_token/current_guest/is_quick_access]
    E --> F[Router 判断为已认证]
    F --> G[进入 GuestDashboard]
    G --> H[隐藏 admin 菜单]
    H --> I[读取 localStorage 缓存数据]
    I --> J[只读渲染页面]
```

---

### 13.3 数据查询流程

```mermaid
flowchart TD
    A[用户进入业务页面] --> B[前端模块初始化]
    B --> C[ApiClient 发起 GET 请求]
    C --> D[Nginx /api 代理]
    D --> E[Express API]
    E --> F[权限与参数校验]
    F --> G[Prisma 查询数据库]
    G --> H[返回 JSON 数据]
    H --> I[前端渲染表格/详情]
    I --> J[可选写入 localStorage 缓存]
```

---

### 13.4 数据写入流程

```mermaid
flowchart TD
    A[用户提交表单] --> B[前端 FormValidator 校验]
    B --> C[ApiClient 发起 POST/PUT 请求]
    C --> D[Nginx 反向代理]
    D --> E[Express API]
    E --> F[后端 validationMiddleware 校验]
    F --> G[权限校验]
    G --> H[Prisma 写入数据库]
    H --> I[记录 AuditLog]
    I --> J[返回操作结果]
    J --> K[前端刷新数据]
    K --> L[更新本地缓存]
```

---

### 13.5 审计日志流程

```mermaid
flowchart TD
    A[用户执行关键操作] --> B[前端 AuditLogger 可选记录]
    B --> C[后端 API 处理操作]
    C --> D[写入业务数据]
    D --> E[写入 audit_logs]
    E --> F[管理员在 AuditLog 模块查看]
```

---

### 13.6 备份恢复流程

```mermaid
flowchart TD
    A[管理员进入备份恢复模块] --> B[BackupRestore 初始化]
    B --> C[调用后端备份/恢复 API]
    C --> D[后端执行数据备份或恢复]
    D --> E[写入 Backup 元数据]
    E --> F[返回执行结果]
    F --> G[前端展示备份状态]
```

---

## 14. 安全设计

### 14.1 密码安全

系统使用 `bcryptjs` 对用户密码进行哈希处理。数据库中只保存密码哈希值，不保存明文密码。

登录时处理流程为：

1. 根据用户名查询用户；
2. 使用 bcrypt 比对用户输入密码和数据库中的密码哈希；
3. 校验成功后生成 token；
4. 更新最后登录时间；
5. 记录登录日志。

---

### 14.2 Token 认证

系统使用 JWT 作为认证凭据。登录成功后，后端返回 token，前端保存到 localStorage。

后续请求应通过请求头携带：

```http
Authorization: Bearer <token>
```

后端应对需要登录的接口验证 token 的有效性。

---

### 14.3 CORS 控制

Nginx 中配置了 CORS 白名单：

```nginx
map $http_origin $cors_allow_origin {
    default "";
    "http://159.75.106.179:8081" $http_origin;
    "http://localhost:5173" $http_origin;
}
```

仅允许指定来源访问 API，降低跨站请求风险。

---

### 14.4 审计日志

系统设计了 `audit_logs` 表，用于记录关键操作，包括：

- 登录；
- 新增；
- 修改；
- 删除；
- 导出；
- 导入；
- 备份；
- 恢复。

审计日志可用于问题追溯、责任界定和安全检查。

---

### 14.5 访客安全

访客和 quickAccess 模式应遵循以下原则：

1. 默认只读；
2. 不允许访问用户管理；
3. 不允许访问备份恢复；
4. 不允许查看审计日志；
5. 不允许导出数据；
6. 不允许修改或删除业务数据；
7. 设置有效期；
8. 超期后自动失效或要求重新进入。

---

## 15. 构建与运行

### 15.1 根目录脚本

根目录 `package.json` 提供以下主要脚本：

| 脚本 | 作用 |
|---|---|
| `npm start` | 启动后端服务 |
| `npm run dev` | 使用 nodemon 启动开发服务 |
| `npm run build` | 构建静态前端资源 |
| `npm test` | 执行 Jest 测试 |
| `npm run test:e2e` | 执行 Cypress 端到端测试 |
| `npm run lint` | 执行代码检查 |
| `npm run format` | 格式化代码 |

---

### 15.2 后端脚本

后端 `package.json` 提供以下主要脚本：

| 脚本 | 作用 |
|---|---|
| `npm start` | 启动 `server.js` |
| `npm run dev` | 使用 watch 模式启动 |
| `npm run db:push` | 推送 Prisma schema 到数据库 |
| `npm run db:generate` | 生成 Prisma Client |
| `npm run db:migrate` | 执行 Prisma 迁移 |
| `npm run db:studio` | 打开 Prisma Studio |
| `npm run seed` | 执行种子数据 |
| `npm run dedupe:preview` | 预览检测记录去重 |
| `npm run dedupe:apply` | 执行检测记录去重 |

---

### 15.3 后端启动方式

后端服务默认启动文件为：

```text
backend/server.js
```

启动命令：

```bash
node backend/server.js
```

或在后端目录中：

```bash
npm start
```

生产环境建议使用 PM2 或系统服务进行进程守护。

---

## 16. 运维与监控

### 16.1 健康检查

推荐健康检查地址：

```text
http://127.0.0.1:3001/api/health
http://公网IP:8081/api/health
```

如果 Nginx 配置中启用了独立健康检查转发，也可使用：

```text
http://公网IP:8081/health
```

具体以 `server.js` 实际注册路由为准。

---

### 16.2 日志类型

系统日志主要包括：

| 日志类型 | 来源 |
|---|---|
| Nginx 访问日志 | Nginx |
| Nginx 错误日志 | Nginx |
| 后端运行日志 | Node.js / Express |
| 系统日志 | `SystemLog` |
| 操作审计日志 | `AuditLog` |
| 前端临时日志 | `localStorage` 中的 `audit_YYYY-MM-DD` |

---

### 16.3 常见故障定位路径

| 问题 | 排查方向 |
|---|---|
| 页面无法访问 | 检查 Nginx 是否启动、8081 端口是否开放 |
| 静态资源 404 | 检查 Nginx root 目录和构建产物 |
| API 404 | 检查 `/api/` 代理和后端路由 |
| API 502 | 检查后端 3001 服务是否运行 |
| 登录失败 | 检查用户表、密码哈希、登录接口 |
| 权限异常 | 检查 localStorage、token、后端权限判断 |
| quickAccess 失效 | 检查 URL 参数、guest_token、current_guest、is_quick_access |
| 数据不更新 | 检查 localStorage 缓存、API 响应、数据库记录 |

---

## 17. 后续优化建议

### 17.1 权限体系优化

建议逐步将权限控制从前端 UI 层扩展到后端 API 层，形成完整 RBAC 权限体系：

- 角色表；
- 权限表；
- 角色-权限关联；
- 用户-角色关联；
- API 权限中间件。

---

### 17.2 quickAccess 安全优化

建议对 quickAccess 模式进行进一步安全加固：

1. 后端识别 quickAccess token；
2. 所有写操作拒绝 quickAccess；
3. quickAccess token 设置明确过期时间；
4. quickAccess 访问行为写入审计日志；
5. 可配置 quickAccess 访问范围。

---

### 17.3 缓存机制优化

建议统一 localStorage key 命名规范，并增加缓存版本号和过期时间。

例如：

```json
{
  "version": "3.1.0",
  "expiresAt": "2026-06-15T12:00:00Z",
  "data": []
}
```

---

### 17.4 API 文档化

建议后续补充 `API.md` 或 OpenAPI 文档，明确每个接口的：

- URL；
- Method；
- 请求参数；
- 响应格式；
- 权限要求；
- 错误码；
- 示例。

---

### 17.5 部署配置统一

当前项目中存在 Linux 和 Windows 两种部署路径描述，建议后续拆分为：

```text
docs/DEPLOYMENT_LINUX.md
docs/DEPLOYMENT_WINDOWS.md
```

并在 `ARCHITECTURE.md` 中只保留通用部署架构。

---

## 18. 附录：关键配置摘要

### 18.1 生产访问地址

```text
前端访问：http://公网IP:8081
API 访问：http://公网IP:8081/api/*
后端本地：http://127.0.0.1:3001
```

---

### 18.2 登录接口

```text
POST /api/user/login
```

---

### 18.3 quickAccess 入口

```text
http://公网IP:8081/?quickAccess=true
```

---

### 18.4 主要角色

```text
admin
user
guest
```

---

### 18.5 关键 localStorage 字段

```text
auth_token
current_user
auth_timestamp
guest_token
current_guest
is_quick_access
cache_tableware
pending_requests
audit_YYYY-MM-DD
```

---

## 19. 版本记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-06-15 | 初始架构文档，说明系统总体架构、部署关系、权限体系、quickAccess 和数据流 |
