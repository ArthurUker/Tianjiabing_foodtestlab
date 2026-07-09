# 食品安全检测系统 - 数据库结构说明

**文档名称**：`DATABASE_SCHEMA.md`  
**系统名称**：食品安全检验管理系统 Pro / 珠海一中食品安全检验系统  
**当前部署环境**：腾讯云 Windows Server  
**当前生产数据库**：SQLite  
**ORM**：Prisma  
**文档版本**：v1.1  
**更新时间**：2026-06-16  

---

## 1. 概览

本系统使用 **Prisma ORM** 管理数据库结构和数据访问。

当前腾讯云 Windows Server 生产环境使用：

```text
SQLite
```

当前生产数据库文件位于：

```text
D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db
```

当前 Prisma datasource 配置为：

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

推荐生产环境 `DATABASE_URL` 为：

```env
DATABASE_URL="file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db"
```

需要特别说明：

- 当前生产环境使用 **SQLite**；
- 当前生产环境不依赖 PostgreSQL；
- 当前生产环境不使用 PostgreSQL RLS 行级安全策略；
- 当前生产环境数据库结构以 `backend/prisma/schema.prisma` 为准；
- `PostgreSQL` 可作为未来企业级扩展选项，但不是当前生产部署依赖；
- 本文档中保留的 PostgreSQL SQL 示例主要作为历史规划、技术参考或未来迁移依据，不应直接用于当前 SQLite 生产环境。

---

## 2. 当前生产数据库口径

| 项目 | 当前配置 |
|---|---|
| ORM | Prisma |
| 当前生产数据库 | SQLite |
| 生产数据库文件 | `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db` |
| Prisma Schema | `backend/prisma/schema.prisma` |
| 种子数据脚本 | `backend/prisma/seed.js` |
| 数据库同步方式 | `npx prisma db push --accept-data-loss` |
| Prisma Client 生成 | `npx prisma generate` |
| 当前生产环境是否使用 PostgreSQL | 否 |
| 当前生产环境是否使用 PostgreSQL RLS | 否 |
| 未来扩展选项 | PostgreSQL |

当前生产环境初始化或同步数据库时，推荐使用：

```powershell
cd C:\zhuhaiyizhong\backend
npx prisma generate
npx prisma db push --accept-data-loss
node prisma/seed.js
```

生产环境执行数据库结构同步前，应先备份：

```text
D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db
```

---

## 3. 目录

1. [概览](#1-概览)
2. [当前生产数据库口径](#2-当前生产数据库口径)
3. [目录](#3-目录)
4. [Prisma Schema](#4-prisma-schema)
5. [核心数据模型](#5-核心数据模型)
6. [数据库关系图](#6-数据库关系图)
7. [字段命名与 ORM 映射](#7-字段命名与-orm-映射)
8. [种子数据初始化](#8-种子数据初始化)
9. [SQL 建表语句参考](#9-sql-建表语句参考)
10. [表结构详解](#10-表结构详解)
11. [索引策略](#11-索引策略)
12. [数据完整性](#12-数据完整性)
13. [开发指南](#13-开发指南)
14. [安全考虑](#14-安全考虑)
15. [未来 PostgreSQL 扩展说明](#15-未来-postgresql-扩展说明)
16. [版本记录](#16-版本记录)

---

## 4. Prisma Schema

### 4.1 Prisma 配置

当前项目的数据库结构由以下文件定义：

```text
backend/prisma/schema.prisma
```

当前生产环境使用 SQLite，Prisma 配置如下：

```prisma
// Prisma Schema for Food Safety Testing Lab
// Current production database: SQLite
// Future extension option: PostgreSQL

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

当前生产环境推荐 `.env` 配置：

```env
DATABASE_URL="file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db"
```

### 4.2 数据库选型说明

| 场景 | 数据库 | 当前状态 | 说明 |
|---|---|---|---|
| 本地开发 | SQLite | 支持 | 便于快速初始化、调试和单机开发 |
| 当前生产部署 | SQLite | 当前使用 | 腾讯云 Windows Server 当前实际生产数据库 |
| 未来扩展 | PostgreSQL | 规划选项 | 适用于更高并发、多实例或企业级部署场景 |

### 4.3 Prisma 常用命令

在后端目录执行：

```powershell
cd C:\zhuhaiyizhong\backend
```

生成 Prisma Client：

```powershell
npx prisma generate
```

同步数据库结构：

```powershell
npx prisma db push --accept-data-loss
```

执行种子数据：

```powershell
node prisma/seed.js
```

打开 Prisma Studio：

```powershell
npx prisma studio
```

注意：

- `prisma generate` 用于生成 Prisma Client；
- `prisma db push` 用于将 `schema.prisma` 同步到数据库；
- `--accept-data-loss` 可能导致字段或结构变更带来的数据风险；
- 生产环境执行前必须备份 SQLite 数据库文件；
- `seed.js` 用于初始化默认账号和系统日志。

---

## 5. 核心数据模型

当前系统核心模型包括：

| 模型 | 对应业务 | 说明 |
|---|---|---|
| `User` | 用户管理 | 系统正式用户、角色、状态和登录信息 |
| `AuditLog` | 审计日志 | 用户关键操作记录 |
| `TestRecord` | 检测记录 | 检测业务主表 |
| `TestItem` | 检测项目 | 单条检测记录下的检测明细 |
| `Attachment` | 附件管理 | 与检测记录关联的文件信息 |
| `Guest` | 访客管理 | 访客账号或临时访问账号信息 |
| `Backup` | 备份元数据 | 记录数据库备份文件信息 |
| `SystemLog` | 系统日志 | 记录系统运行或初始化日志 |

---

### 5.1 用户管理模型 User

```prisma
model User {
  id            String   @id @default(cuid())
  username      String   @unique
  email         String?  @unique
  password_hash String
  full_name     String?
  phone         String?
  role          String   @default("user")     // admin / manager / operator / viewer / user
  status        String   @default("active")   // active / disabled
  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt
  last_login    DateTime?

  // 关系
  audit_logs    AuditLog[]
  test_records  TestRecord[]
  guests        Guest[]
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 用户唯一标识，默认使用 CUID |
| `username` | String | 用户名，唯一 |
| `email` | String? | 邮箱，可选，唯一 |
| `password_hash` | String | 密码哈希值，使用 bcryptjs 生成 |
| `full_name` | String? | 用户姓名 |
| `phone` | String? | 手机号 |
| `role` | String | 用户角色 |
| `status` | String | 用户状态 |
| `created_at` | DateTime | 创建时间 |
| `updated_at` | DateTime | 更新时间 |
| `last_login` | DateTime? | 最后登录时间 |

#### 角色说明

| 角色 | 说明 |
|---|---|
| `admin` | 系统管理员，拥有最高权限 |
| `manager` | 管理人员，可根据业务授权部分管理能力 |
| `operator` | 检测操作员，负责检测数据录入和维护 |
| `viewer` | 查看员，主要拥有只读权限 |
| `user` | 默认普通用户 |

#### 状态说明

| 状态 | 说明 |
|---|---|
| `active` | 启用 |
| `disabled` | 禁用 |

---

### 5.2 审计日志模型 AuditLog

```prisma
model AuditLog {
  id            String   @id @default(cuid())
  user_id       String
  action        String                  // login / create / update / delete / export / import
  resource_type String?                 // test_record / user / backup / etc
  resource_id   String?
  details       String?                 // JSON string for additional details
  ip_address    String?
  created_at    DateTime @default(now())

  user          User     @relation(fields: [user_id], references: [id], onDelete: Cascade)

  @@index([user_id])
  @@index([created_at])
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 审计日志唯一标识 |
| `user_id` | String | 操作用户 ID |
| `action` | String | 操作类型 |
| `resource_type` | String? | 被操作资源类型 |
| `resource_id` | String? | 被操作资源 ID |
| `details` | String? | 操作详情，通常为 JSON 字符串 |
| `ip_address` | String? | 操作来源 IP |
| `created_at` | DateTime | 操作时间 |

#### 典型 action

```text
login
logout
create
update
delete
export
import
backup
restore
```

#### 用途

`AuditLog` 用于记录系统中的关键操作，支持：

- 安全审计；
- 问题追溯；
- 用户操作记录；
- 数据变更追踪；
- 管理员审查。

---

### 5.3 检测记录模型 TestRecord

```prisma
model TestRecord {
  id            String   @id @default(cuid())
  record_code   String   @unique
  test_type     String                  // pathogen / tableware / generic / custom
  test_name     String
  sample_info   String?                 // JSON for sample details
  result_data   String?                 // JSON for test results
  status        String   @default("pending") // pending / completed / failed / archived
  created_by    String
  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt
  version       Int      @default(0)
  completed_at  DateTime?

  created_user  User     @relation(fields: [created_by], references: [id], onDelete: Cascade)
  test_items    TestItem[]
  attachments   Attachment[]

  @@index([test_type])
  @@index([status])
  @@index([created_by])
  @@index([created_at])
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 检测记录唯一标识 |
| `record_code` | String | 检测记录编号，唯一 |
| `test_type` | String | 检测类型 |
| `test_name` | String | 检测名称 |
| `sample_info` | String? | 样本信息，JSON 字符串 |
| `result_data` | String? | 检测结果，JSON 字符串 |
| `status` | String | 记录状态 |
| `created_by` | String | 创建用户 ID |
| `created_at` | DateTime | 创建时间 |
| `updated_at` | DateTime | 更新时间 |
| `version` | Int | 版本号，可用于乐观锁或数据更新控制 |
| `completed_at` | DateTime? | 完成时间 |

#### test_type 参考值

| 值 | 说明 |
|---|---|
| `pathogen` | 病原体检测 |
| `tableware` | 餐具洁净度检测 |
| `generic` | 通用检测 |
| `custom` | 自定义检测 |

#### status 参考值

| 值 | 说明 |
|---|---|
| `pending` | 待处理 |
| `completed` | 已完成 |
| `failed` | 检测失败 |
| `archived` | 已归档 |

---

### 5.4 测试项目模型 TestItem

```prisma
model TestItem {
  id              String   @id @default(cuid())
  test_record_id  String
  item_name       String
  item_code       String?
  result          String?                 // positive / negative / qualified / unqualified / etc
  notes           String?
  created_at      DateTime @default(now())

  test_record     TestRecord @relation(fields: [test_record_id], references: [id], onDelete: Cascade)

  @@index([test_record_id])
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 检测项目唯一标识 |
| `test_record_id` | String | 所属检测记录 ID |
| `item_name` | String | 检测项目名称 |
| `item_code` | String? | 检测项目编码 |
| `result` | String? | 检测结果 |
| `notes` | String? | 备注 |
| `created_at` | DateTime | 创建时间 |

#### 典型 result

```text
positive
negative
qualified
unqualified
pass
fail
```

---

### 5.5 附件模型 Attachment

```prisma
model Attachment {
  id              String   @id @default(cuid())
  test_record_id  String?
  file_name       String
  file_path       String
  file_size       Int?                    // bytes
  file_type       String?                 // MIME type
  uploaded_at     DateTime @default(now())

  test_record     TestRecord? @relation(fields: [test_record_id], references: [id], onDelete: SetNull)

  @@index([test_record_id])
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 附件唯一标识 |
| `test_record_id` | String? | 关联检测记录 ID，可为空 |
| `file_name` | String | 原始文件名或展示文件名 |
| `file_path` | String | 文件存储路径 |
| `file_size` | Int? | 文件大小，单位 byte |
| `file_type` | String? | MIME 类型 |
| `uploaded_at` | DateTime | 上传时间 |

#### 用途

`Attachment` 用于管理与检测记录关联的附件，例如：

- 检测报告；
- 图片；
- 证明文件；
- 原始记录；
- 其他补充材料。

---

### 5.6 访客模型 Guest

```prisma
model Guest {
  id            String   @id @default(cuid())
  username      String   @unique
  email         String?
  password_hash String
  full_name     String?
  created_by    String
  status        String   @default("active")
  created_at    DateTime @default(now())
  updated_at    DateTime @updatedAt

  created_user  User     @relation(fields: [created_by], references: [id], onDelete: Cascade)

  @@index([created_by])
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 访客唯一标识 |
| `username` | String | 访客用户名，唯一 |
| `email` | String? | 访客邮箱 |
| `password_hash` | String | 访客密码哈希 |
| `full_name` | String? | 访客姓名 |
| `created_by` | String | 创建该访客的用户 ID |
| `status` | String | 访客状态 |
| `created_at` | DateTime | 创建时间 |
| `updated_at` | DateTime | 更新时间 |

#### 重要说明

当前 `schema.prisma` 中的 `Guest` 模型未定义以下字段：

```text
guest_type
valid_from
valid_until
has_export_permission
last_login
remark
```

因此，早期 PostgreSQL SQL 脚本或规划文档中出现上述字段时，应理解为：

- 历史规划；
- 未来扩展设计；
- 非当前 SQLite 生产 schema。

如后续需要访客类型、有效期、导出权限等能力，应先修改 `schema.prisma`，再同步：

- 后端 API；
- 前端页面；
- 权限逻辑；
- 种子数据；
- 数据库迁移策略；
- `DATABASE_SCHEMA.md`；
- `API_REFERENCE.md`；
- `FRONTEND_GUIDE.md`。

---

### 5.7 备份元数据模型 Backup

```prisma
model Backup {
  id            String   @id @default(cuid())
  backup_name   String
  backup_path   String   @unique
  backup_size   Int?
  record_count  Int      @default(0)
  created_at    DateTime @default(now())
  created_by    String?
  notes         String?
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 备份记录唯一标识 |
| `backup_name` | String | 备份名称 |
| `backup_path` | String | 备份文件路径，唯一 |
| `backup_size` | Int? | 备份文件大小 |
| `record_count` | Int | 备份涉及记录数量 |
| `created_at` | DateTime | 备份创建时间 |
| `created_by` | String? | 创建备份的用户 ID 或系统标识 |
| `notes` | String? | 备注 |

#### 当前生产备份对象

当前生产环境最重要的备份对象是 SQLite 数据库文件：

```text
D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db
```

推荐备份目录：

```text
D:\ZhuHaiYiZhong-data\backup
```

---

### 5.8 系统日志模型 SystemLog

```prisma
model SystemLog {
  id            String   @id @default(cuid())
  level         String                  // info / warn / error / debug
  message       String
  context       String?                 // JSON
  created_at    DateTime @default(now())

  @@index([level])
  @@index([created_at])
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | 系统日志唯一标识 |
| `level` | String | 日志级别 |
| `message` | String | 日志消息 |
| `context` | String? | 上下文信息，通常为 JSON 字符串 |
| `created_at` | DateTime | 创建时间 |

#### 日志级别

```text
info
warn
error
debug
```

#### 用途

`SystemLog` 用于记录：

- 系统初始化；
- 种子数据执行；
- 关键后台任务；
- 数据库同步状态；
- 系统异常；
- 运维事件。

---

## 6. 数据库关系图

### 6.1 Mermaid 关系图

```mermaid
erDiagram
    User ||--o{ AuditLog : generates
    User ||--o{ TestRecord : creates
    User ||--o{ Guest : creates
    TestRecord ||--o{ TestItem : contains
    TestRecord ||--o{ Attachment : has

    User {
        string id PK
        string username
        string email
        string password_hash
        string full_name
        string phone
        string role
        string status
        datetime created_at
        datetime updated_at
        datetime last_login
    }

    AuditLog {
        string id PK
        string user_id FK
        string action
        string resource_type
        string resource_id
        string details
        string ip_address
        datetime created_at
    }

    TestRecord {
        string id PK
        string record_code
        string test_type
        string test_name
        string sample_info
        string result_data
        string status
        string created_by FK
        datetime created_at
        datetime updated_at
        int version
        datetime completed_at
    }

    TestItem {
        string id PK
        string test_record_id FK
        string item_name
        string item_code
        string result
        string notes
        datetime created_at
    }

    Attachment {
        string id PK
        string test_record_id FK
        string file_name
        string file_path
        int file_size
        string file_type
        datetime uploaded_at
    }

    Guest {
        string id PK
        string username
        string email
        string password_hash
        string full_name
        string created_by FK
        string status
        datetime created_at
        datetime updated_at
    }

    Backup {
        string id PK
        string backup_name
        string backup_path
        int backup_size
        int record_count
        datetime created_at
        string created_by
        string notes
    }

    SystemLog {
        string id PK
        string level
        string message
        string context
        datetime created_at
    }
```

### 6.2 文本关系图

```text
┌─────────────┐
│    User     │
│   用户表     │
├─────────────┤
│ id          │
│ username    │
│ role        │
│ status      │
└──────┬──────┘
       │
       ├─────────────────────┐
       │                     │
       ▼                     ▼
┌──────────────┐       ┌──────────────┐
│  TestRecord  │       │   AuditLog   │
│  检测记录表    │       │   审计日志表   │
└──────┬───────┘       └──────────────┘
       │
       ├───────────────┐
       │               │
       ▼               ▼
┌──────────────┐   ┌──────────────┐
│   TestItem   │   │  Attachment  │
│   检测项目表   │   │    附件表     │
└──────────────┘   └──────────────┘

       │
       ▼
┌──────────────┐
│    Guest     │
│   访客表      │
└──────────────┘

┌──────────────┐
│    Backup    │
│  备份元数据表  │
└──────────────┘

┌──────────────┐
│  SystemLog   │
│   系统日志表   │
└──────────────┘
```

---

## 7. 字段命名与 ORM 映射

### 7.1 当前字段命名风格

当前 Prisma 模型字段整体采用 `snake_case` 命名方式，例如：

```text
password_hash
full_name
created_at
updated_at
last_login
record_code
test_type
result_data
resource_type
ip_address
test_record_id
file_name
file_path
```

JavaScript 前端或 API 响应中可能存在 `camelCase` 使用习惯，例如：

```text
passwordHash
fullName
createdAt
updatedAt
lastLogin
recordCode
testType
resultData
resourceType
ipAddress
testRecordId
fileName
filePath
```

### 7.2 映射原则

当前建议：

1. 数据库结构和 Prisma Client 字段以 `schema.prisma` 为准；
2. 如果 Prisma 模型字段使用 `snake_case`，后端代码访问时也应使用对应字段名；
3. 如果 API 希望对前端输出 `camelCase`，应在服务层或响应层统一转换；
4. 前端不应直接假定数据库字段名；
5. 文档中的字段说明应优先使用 `schema.prisma` 中的字段名。

### 7.3 字段变更同步范围

修改字段时，应同步更新：

- `backend/prisma/schema.prisma`；
- 后端 API 查询和写入逻辑；
- 前端展示和提交字段；
- `API_REFERENCE.md`；
- `DATABASE_SCHEMA.md`；
- `FRONTEND_GUIDE.md`；
- 示例数据；
- 导入导出逻辑；
- 种子数据；
- 部署或迁移脚本。

---

## 8. 种子数据初始化

当前种子数据脚本为：

```text
backend/prisma/seed.js
```

### 8.1 初始用户

当前 `seed.js` 首次执行时会创建以下账号：

| 用户名 | 初始密码 | 角色 | 邮箱 |
|---|---|---|---|
| `admin` | `8888` | `admin` | `admin@foodlab.local` |
| `operator` | `operator123` | `operator` | `operator@foodlab.local` |
| `viewer` | `viewer123` | `viewer` | `viewer@foodlab.local` |

### 8.2 初始化逻辑

当前初始化逻辑为：

- 若账号不存在，则创建账号；
- 若账号已存在，则跳过；
- 重复执行不会覆盖已存在账号密码；
- 每次执行可写入系统初始化日志。

### 8.3 生产安全要求

生产环境必须注意：

- 首次登录后必须修改 `admin` 默认密码；
- 不需要的 `operator`、`viewer` 示例账号应修改密码或禁用；
- 不应在公开仓库中保存真实密码；
- 不应将生产 `.env`、数据库文件或备份文件提交到 Git。

---

## 9. SQL 建表语句参考

> **重要说明：**
>
> 本节 SQL 建表语句主要来源于早期 PostgreSQL 规划方案，包含 `BIGSERIAL`、`JSONB`、`TEXT[]`、RLS 行级安全策略、`CREATE POLICY`、`now()`、`ON CONFLICT` 等 PostgreSQL 专有语法。
>
> 当前腾讯云 Windows Server 生产环境实际使用 **SQLite + Prisma**，数据库结构以：
>
> ```text
> backend/prisma/schema.prisma
> ```
>
> 为最终准绳。
>
> 当前生产环境不应直接执行本节 PostgreSQL SQL 脚本。
>
> 如需初始化或同步当前生产数据库，应使用：
>
> ```powershell
> cd C:\zhuhaiyizhong\backend
> npx prisma generate
> npx prisma db push --accept-data-loss
> node prisma/seed.js
> ```

---

### 9.1 用户管理相关表参考

#### 9.1.1 用户表 users，PostgreSQL 规划参考

```sql
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    phone VARCHAR(20),
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) DEFAULT 'user' NOT NULL,
    status VARCHAR(20) DEFAULT 'active' NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,

    CONSTRAINT role_check CHECK (role IN ('user', 'admin', 'manager')),
    CONSTRAINT status_check CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);
```

说明：

- 以上为 PostgreSQL 规划脚本；
- 当前 SQLite 生产环境不直接执行；
- 当前 `User` 模型以 `schema.prisma` 为准；
- 当前角色已扩展为 `admin / manager / operator / viewer / user`。

#### 9.1.2 登录日志表 login_logs，历史规划参考

```sql
CREATE TABLE IF NOT EXISTS login_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX idx_login_logs_user_id ON login_logs(user_id);
CREATE INDEX idx_login_logs_created_at ON login_logs(created_at DESC);
```

说明：

- 当前正式 Prisma 模型中未单独列出 `LoginLog` 模型；
- 登录行为可通过 `AuditLog` 或 `SystemLog` 记录；
- 如后续需要单独登录日志表，应先修改 `schema.prisma`。

#### 9.1.3 用户角色表 user_roles，未来 RBAC 扩展参考

```sql
CREATE TABLE IF NOT EXISTS user_roles (
    id BIGSERIAL PRIMARY KEY,
    role_name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    permissions TEXT[],
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO user_roles (role_name, description, permissions) VALUES
    ('user', '普通用户 - 可以创建和编辑自己的检测记录', ARRAY['view_own_records', 'create_records', 'edit_own_records']),
    ('manager', '部门经理 - 可以管理部门内的所有记录', ARRAY['view_department_records', 'create_records', 'edit_all_records', 'delete_records']),
    ('admin', '系统管理员 - 拥有所有权限', ARRAY['all_permissions']);
```

说明：

- 当前生产系统通过 `User.role` 字段进行基础角色控制；
- 当前尚未使用独立 `user_roles` 表作为正式 RBAC 模型；
- `TEXT[]` 为 PostgreSQL 专有数组类型，SQLite 不支持；
- 未来如需完整 RBAC，应通过 Prisma 重新建模。

#### 9.1.4 审计日志表 audit_logs，PostgreSQL 规划参考

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    table_name VARCHAR(100) NOT NULL,
    record_id BIGINT,
    old_values JSONB,
    new_values JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_table_name ON audit_logs(table_name);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
```

说明：

- 当前正式 `AuditLog` Prisma 模型使用 `resource_type`、`resource_id`、`details` 字段；
- 当前 SQLite 环境不使用 PostgreSQL `JSONB`；
- 当前结构以 `schema.prisma` 中的 `AuditLog` 为准。

---

### 9.2 PostgreSQL RLS 行级安全策略，未来扩展参考

```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_can_view_own_profile" ON users
    FOR SELECT USING (id = current_user_id() OR current_user_role() = 'admin');

CREATE POLICY "users_can_update_own_profile" ON users
    FOR UPDATE USING (id = current_user_id());

CREATE POLICY "admins_can_view_all_users" ON users
    FOR SELECT USING (current_user_role() = 'admin');

CREATE POLICY "users_can_view_own_login_logs" ON login_logs
    FOR SELECT USING (user_id = current_user_id() OR current_user_role() = 'admin');

CREATE POLICY "audit_logs_admin_only" ON audit_logs
    FOR SELECT USING (current_user_role() = 'admin');
```

说明：

- 以上为 PostgreSQL RLS 设计参考；
- 当前 SQLite 生产环境不支持 PostgreSQL RLS；
- 当前生产访问控制主要依赖：
  - JWT 认证；
  - 后端角色权限校验；
  - API 中间件；
  - 业务逻辑控制；
  - 审计日志追踪。

---

### 9.3 访客管理相关表参考

#### 9.3.1 访客表 guests，历史规划参考

```sql
CREATE TABLE IF NOT EXISTS guests (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    guest_type VARCHAR(20) DEFAULT 'viewer' NOT NULL,
    status VARCHAR(20) DEFAULT 'active' NOT NULL,
    has_export_permission BOOLEAN DEFAULT false,
    valid_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    valid_until TIMESTAMP NOT NULL,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP,
    remark TEXT,

    CONSTRAINT guest_type_check CHECK (guest_type IN ('viewer', 'export_applicant')),
    CONSTRAINT status_check CHECK (status IN ('active', 'disabled', 'expired')),
    CONSTRAINT valid_date_check CHECK (valid_from <= valid_until)
);

CREATE INDEX idx_guests_username ON guests(username);
CREATE INDEX idx_guests_email ON guests(email);
CREATE INDEX idx_guests_status ON guests(status);
CREATE INDEX idx_guests_guest_type ON guests(guest_type);
CREATE INDEX idx_guests_valid_until ON guests(valid_until);
CREATE INDEX idx_guests_has_export_permission ON guests(has_export_permission);
```

说明：

- 以上为早期访客系统增强规划；
- 当前 Prisma `Guest` 模型不包含 `guest_type`、`valid_until`、`has_export_permission` 等字段；
- 当前生产环境不应直接执行该 SQL；
- 如需实现访客有效期和导出申请，应先扩展 Prisma schema。

#### 9.3.2 访客导出申请表 guest_export_requests，未来扩展参考

```sql
CREATE TABLE IF NOT EXISTS guest_export_requests (
    id BIGSERIAL PRIMARY KEY,
    guest_id BIGINT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    request_type VARCHAR(50) NOT NULL,
    request_reason TEXT,
    request_data JSONB,
    status VARCHAR(20) DEFAULT 'pending' NOT NULL,
    approved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    approval_comment TEXT,
    approval_date TIMESTAMP,
    permission_valid_until TIMESTAMP,
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT status_check CHECK (status IN ('pending', 'approved', 'rejected', 'expired'))
);

CREATE INDEX idx_export_requests_guest_id ON guest_export_requests(guest_id);
CREATE INDEX idx_export_requests_status ON guest_export_requests(status);
CREATE INDEX idx_export_requests_requested_at ON guest_export_requests(requested_at DESC);
CREATE INDEX idx_export_requests_approved_by ON guest_export_requests(approved_by);
```

说明：

- 当前正式 Prisma schema 中未定义 `GuestExportRequest` 模型；
- 当前后端如未挂载 `/api/guest-export-request/*` 路由，则该功能不属于当前正式能力；
- 该表可作为未来导出审批机制的设计参考。

#### 9.3.3 访客登录日志表 guest_login_logs，未来扩展参考

```sql
CREATE TABLE IF NOT EXISTS guest_login_logs (
    id BIGSERIAL PRIMARY KEY,
    guest_id BIGINT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX idx_guest_login_logs_guest_id ON guest_login_logs(guest_id);
CREATE INDEX idx_guest_login_logs_created_at ON guest_login_logs(created_at DESC);
```

说明：

- 当前正式 Prisma schema 中未定义 `GuestLoginLog` 模型；
- 如需访客登录审计，可优先考虑复用 `AuditLog` 或扩展 schema。

---

### 9.4 初始化 SQL 参考

#### 9.4.1 测试用户，历史参考

```sql
INSERT INTO users (username, email, password_hash, full_name, role, status)
VALUES ('testuser', 'testuser@example.com', '$2b$10$...', '测试用户', 'user', 'active');

INSERT INTO users (username, email, password_hash, full_name, role, status)
VALUES ('qa_tester', 'qa@example.com', '$2b$10$...', 'QA 测试员', 'user', 'active');

INSERT INTO users (username, email, password_hash, full_name, role, status)
VALUES ('disabled_user', 'disabled@example.com', '$2b$10$...', '被禁用的用户', 'user', 'disabled');
```

说明：

- 当前生产环境不建议通过手写 SQL 初始化用户；
- 当前应通过 `backend/prisma/seed.js` 初始化基础账号；
- 示例账号不应进入正式生产环境，除非业务明确需要。

#### 9.4.2 管理员密码设置，历史参考

```sql
INSERT INTO users (username, email, password_hash, full_name, role, status, created_at)
VALUES (
  'admin',
  'admin@foodlab.local',
  '$2a$10$...',
  'Administrator',
  'admin',
  'active',
  now()
)
ON CONFLICT (username) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      updated_at = now();
```

说明：

- `now()` 和 `ON CONFLICT` 为 PostgreSQL 风格写法；
- 当前生产环境应通过 Prisma `seed.js` 或管理端修改密码；
- 不建议直接在生产 SQLite 数据库中手工修改密码哈希，除非明确知道哈希生成方式。

---

## 10. 表结构详解

### 10.1 当前正式表结构摘要

| 表或模型 | 用途 | 关键字段 | 当前生产状态 |
|---|---|---|---|
| `User` / `users` | 系统用户管理 | `id`, `username`, `password_hash`, `role`, `status` | 当前正式模型 |
| `AuditLog` / `audit_logs` | 操作审计记录 | `user_id`, `action`, `resource_type`, `created_at` | 当前正式模型 |
| `TestRecord` / `test_records` | 检测记录 | `record_code`, `test_type`, `status`, `created_by` | 当前正式模型 |
| `TestItem` / `test_items` | 检测项目 | `test_record_id`, `item_name`, `result` | 当前正式模型 |
| `Attachment` / `attachments` | 文件管理 | `test_record_id`, `file_name`, `file_path` | 当前正式模型 |
| `Guest` / `guests` | 访客管理 | `username`, `password_hash`, `created_by`, `status` | 当前正式模型 |
| `Backup` / `backup` | 备份元数据 | `backup_name`, `backup_path`, `record_count` | 当前正式模型 |
| `SystemLog` / `system_logs` | 系统日志 | `level`, `message`, `created_at` | 当前正式模型 |

### 10.2 历史或未来扩展表说明

| 表名 | 用途 | 当前状态 |
|---|---|---|
| `login_logs` | 登录日志 | 历史规划，当前可由 `AuditLog` 替代 |
| `user_roles` | 独立角色表 | 未来 RBAC 扩展选项 |
| `guest_export_requests` | 访客导出申请 | 未来扩展选项 |
| `guest_login_logs` | 访客登录日志 | 未来扩展选项 |

---

## 11. 索引策略

### 11.1 当前 Prisma 索引

当前 Prisma schema 中已定义的典型索引包括：

| 模型 | 索引字段 | 用途 |
|---|---|---|
| `AuditLog` | `user_id` | 按用户查询审计日志 |
| `AuditLog` | `created_at` | 按时间查询审计日志 |
| `TestRecord` | `test_type` | 按检测类型筛选 |
| `TestRecord` | `status` | 按状态筛选 |
| `TestRecord` | `created_by` | 按创建人查询 |
| `TestRecord` | `created_at` | 按创建时间查询 |
| `TestItem` | `test_record_id` | 查询某记录下的检测项目 |
| `Attachment` | `test_record_id` | 查询某记录下的附件 |
| `Guest` | `created_by` | 查询某用户创建的访客 |
| `SystemLog` | `level` | 按日志级别过滤 |
| `SystemLog` | `created_at` | 按时间查询系统日志 |

### 11.2 索引设计原则

索引优先覆盖以下查询场景：

- 按时间范围查询；
- 按状态过滤；
- 按用户关联查询；
- 按检测类型过滤；
- 按记录编号精确查询；
- 审计日志分页查询；
- 系统日志筛选。

### 11.3 SQLite 场景注意事项

SQLite 在轻量级场景下性能较好，但需要注意：

- 不适合极高并发写入；
- 大量写操作可能出现数据库锁；
- 长事务应尽量避免；
- 备份数据库文件时应尽量避开高写入时段；
- 随数据量增长，应关注查询性能和索引设计。

---

## 12. 数据完整性

### 12.1 外键关系

当前系统通过 Prisma 定义模型关系，例如：

- `User` 与 `AuditLog`；
- `User` 与 `TestRecord`；
- `User` 与 `Guest`；
- `TestRecord` 与 `TestItem`；
- `TestRecord` 与 `Attachment`。

### 12.2 删除策略

当前模型中存在以下删除策略：

| 关系 | 删除策略 | 说明 |
|---|---|---|
| `User` -> `AuditLog` | `Cascade` | 删除用户时级联删除相关审计日志 |
| `User` -> `TestRecord` | `Cascade` | 删除用户时级联删除其创建记录 |
| `User` -> `Guest` | `Cascade` | 删除用户时级联删除其创建访客 |
| `TestRecord` -> `TestItem` | `Cascade` | 删除检测记录时删除检测明细 |
| `TestRecord` -> `Attachment` | `SetNull` | 删除检测记录时附件保留但解除关联 |

注意：

- 级联删除具有数据风险；
- 生产环境删除用户或检测记录前应谨慎；
- 关键删除操作必须写入审计日志；
- 如业务要求保留历史记录，可考虑改为软删除或禁用状态。

### 12.3 唯一约束

当前典型唯一约束包括：

| 字段 | 说明 |
|---|---|
| `User.username` | 用户名唯一 |
| `User.email` | 邮箱唯一，可选 |
| `TestRecord.record_code` | 检测记录编号唯一 |
| `Guest.username` | 访客用户名唯一 |
| `Backup.backup_path` | 备份路径唯一 |

### 12.4 JSON 字符串字段

当前 SQLite 环境下，部分复杂结构以字符串形式保存 JSON，例如：

| 字段 | 说明 |
|---|---|
| `TestRecord.sample_info` | 样本信息 |
| `TestRecord.result_data` | 检测结果 |
| `AuditLog.details` | 审计详情 |
| `SystemLog.context` | 系统日志上下文 |

使用建议：

- 写入前应由后端进行 JSON 序列化；
- 读取后由后端或前端进行 JSON 解析；
- 不建议前端直接拼接复杂 JSON 字符串；
- JSON 字段结构变化应同步更新 API 文档。

---

## 13. 开发指南

### 13.1 安装依赖

在后端目录执行：

```bash
cd backend
npm install
```

如需安装 Prisma 相关依赖：

```bash
npm install prisma @prisma/client
```

### 13.2 初始化数据库

本地或生产初始化流程：

```bash
npx prisma generate
npx prisma db push
node prisma/seed.js
```

生产环境建议使用：

```powershell
npx prisma db push --accept-data-loss
```

但执行前必须备份数据库。

### 13.3 查看数据库

可使用 Prisma Studio：

```bash
npx prisma studio
```

注意：

- 生产环境谨慎开放 Prisma Studio；
- 不应将数据库管理界面暴露公网；
- 如需查看生产数据，建议通过远程桌面在服务器本地访问。

### 13.4 常用查询示例

#### 创建用户

```javascript
const user = await prisma.user.create({
  data: {
    username: "newuser",
    email: "user@example.com",
    password_hash: "hashed_password",
    role: "user",
    status: "active"
  }
});
```

#### 查询用户的检测记录

```javascript
const records = await prisma.testRecord.findMany({
  where: {
    created_by: userId
  },
  include: {
    test_items: true,
    attachments: true
  },
  orderBy: {
    created_at: "desc"
  }
});
```

#### 创建检测记录

```javascript
const record = await prisma.testRecord.create({
  data: {
    record_code: "TR-20260616-001",
    test_type: "tableware",
    test_name: "餐具洁净度检测",
    sample_info: JSON.stringify({
      sampleName: "餐盘",
      location: "学校食堂"
    }),
    result_data: JSON.stringify({
      result: "qualified"
    }),
    status: "completed",
    created_by: userId,
    completed_at: new Date()
  }
});
```

#### 创建审计日志

```javascript
await prisma.auditLog.create({
  data: {
    user_id: userId,
    action: "create",
    resource_type: "test_record",
    resource_id: record.id,
    details: JSON.stringify({
      record_code: record.record_code,
      test_type: record.test_type
    }),
    ip_address: requestIp
  }
});
```

#### 创建系统日志

```javascript
await prisma.systemLog.create({
  data: {
    level: "info",
    message: "Database seed completed",
    context: JSON.stringify({
      source: "seed.js"
    })
  }
});
```

### 13.5 字段使用注意事项

当前 Prisma 字段为 `snake_case`，例如：

```javascript
await prisma.user.findUnique({
  where: {
    username: "admin"
  }
});
```

更新最后登录时间：

```javascript
await prisma.user.update({
  where: {
    id: user.id
  },
  data: {
    last_login: new Date()
  }
});
```

不应误写为：

```javascript
lastLogin: new Date()
```

除非 `schema.prisma` 中明确使用了 camelCase 字段或 `@map` 映射。

---

## 14. 安全考虑

### 14.1 密码安全

系统使用 `bcryptjs` 对密码进行哈希处理，不应保存明文密码。

数据库字段：

```text
password_hash
```

安全要求：

- 不存储明文密码；
- 不在日志中输出密码；
- 不在前端缓存密码；
- 不在文档中记录真实密码；
- 默认密码上线后必须修改。

### 14.2 认证与访问控制

当前生产环境主要通过以下方式控制访问：

- JWT Bearer Token；
- 后端认证中间件；
- 用户角色字段 `role`；
- 用户状态字段 `status`；
- API 权限校验；
- 审计日志追踪。

当前生产环境不使用 PostgreSQL RLS。  
PostgreSQL RLS 可作为未来迁移 PostgreSQL 后的数据库层安全增强选项。

### 14.3 审计日志

以下操作建议记录至 `AuditLog`：

- 登录；
- 登出；
- 创建用户；
- 修改用户；
- 删除用户；
- 创建检测记录；
- 修改检测记录；
- 删除检测记录；
- 数据导出；
- 数据备份；
- 数据恢复；
- 权限变更。

### 14.4 数据库文件安全

当前生产数据库文件：

```text
D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db
```

安全要求：

- 不应放入 Nginx WebRoot；
- 不应提交到 Git；
- 不应通过公网直接下载；
- 应定期备份；
- 备份文件应限制访问权限；
- 部署前应创建备份。

不应将数据库放在：

```text
C:\zhuhaiyizhong\dist
C:\nginx\html
```

### 14.5 备份安全

推荐备份目录：

```text
D:\ZhuHaiYiZhong-data\backup
```

建议备份文件命名：

```text
zhuhaiyizhong_YYYYMMDD_HHMMSS.db
```

备份要求：

- 备份前确认数据库路径正确；
- 定期检查备份文件是否可恢复；
- 不长期保存过多无用备份；
- 不将备份文件暴露到 Web 目录；
- 不将备份文件提交到远程仓库。

### 14.6 默认账号安全

初始账号：

| 用户名 | 初始密码 | 角色 |
|---|---|---|
| `admin` | `8888` | `admin` |
| `operator` | `operator123` | `operator` |
| `viewer` | `viewer123` | `viewer` |

生产环境首次登录后必须：

- 修改 `admin` 密码；
- 修改或禁用 `operator`；
- 修改或禁用 `viewer`；
- 检查是否存在无用测试账号；
- 避免多人共用管理员账号。

---

## 15. 未来 PostgreSQL 扩展说明

当前生产环境使用 SQLite。若后续系统规模扩大，可评估迁移至 PostgreSQL。

### 15.1 适合迁移 PostgreSQL 的场景

以下情况可考虑迁移：

- 并发写入明显增加；
- 数据量持续扩大；
- 需要多后端实例；
- 需要更强事务能力；
- 需要更完善的数据库权限管理；
- 需要更成熟的备份恢复体系；
- 需要数据库层行级安全；
- 需要复杂统计查询。

### 15.2 迁移 PostgreSQL 需修改的内容

如正式迁移 PostgreSQL，应同步修改：

- `backend/prisma/schema.prisma`；
- `.env` 中 `DATABASE_URL`；
- 部署脚本 `deploy.ps1`；
- 数据迁移脚本；
- 备份恢复方案；
- 数据库账号和权限策略；
- `DATABASE_SCHEMA.md`；
- `DEPLOYMENT_GUIDE.md`；
- `ARCHITECTURE.md`；
- `README.md`；
- 运维监控方案。

### 15.3 Prisma datasource 示例，未来参考

未来如迁移 PostgreSQL，datasource 可能调整为：

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

PostgreSQL 连接字符串示例：

```env
DATABASE_URL="postgresql://user:password@localhost:5432/foodtestlab?schema=public"
```

注意：

- 以上仅为未来参考；
- 当前生产环境不使用该配置；
- 不应在当前 Windows + SQLite 部署中误改为 PostgreSQL；
- 迁移前必须制定数据导出、导入、校验和回滚方案。

### 15.4 PostgreSQL RLS 作为未来增强能力

PostgreSQL RLS 可用于数据库层行级安全控制，但当前系统访问控制主要由后端完成。

未来如启用 RLS，需要明确：

- 应用连接数据库的用户策略；
- 当前登录用户如何传递到数据库会话；
- RLS 策略与后端权限之间如何避免冲突；
- 审计日志如何记录策略拒绝；
- 性能影响和调试方式；
- 迁移和回滚方案。

---

## 16. 版本记录

| 版本 | 日期 | 修改内容 |
|---|---|---|
| v1.0 | 2026-06-15 | 初始数据库结构文档，包含 Prisma 模型、SQL 规划、关系图和安全说明 |
| v1.1 | 2026-06-16 | 修正 PostgreSQL 生产环境表述，明确当前生产数据库为 SQLite；补充生产数据库路径、Prisma 口径、SQL 参考说明、RLS 当前状态和 PostgreSQL 未来扩展说明 |

---

**最后更新**：2026-06-16