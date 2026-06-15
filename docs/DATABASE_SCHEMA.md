# 食品安全检测系统 - 数据库结构

## 概览

本系统使用 **Prisma ORM** 管理数据库。支持 SQLite（本地开发）和 PostgreSQL（生产环境）。

---

## 目录
1. [Prisma Schema](#prisma-schema)
2. [SQL 建表语句](#sql-建表语句)
3. [数据库关系图](#数据库关系图)
4. [表结构详解](#表结构详解)

---

## Prisma Schema

### 配置

```prisma
// Prisma Schema for Food Safety Testing Lab
// Database: SQLite (local) / PostgreSQL (production)

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

### 数据模型

#### 1. 用户管理 (User)

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

**字段说明：**
- `id`: 唯一标识符（CUID格式）
- `username`: 用户名（唯一）
- `email`: 邮箱（可选，唯一）
- `password_hash`: 密码哈希值（bcrypt）
- `role`: 角色（管理员/经理/操作员/查看者/普通用户）
- `status`: 状态（活跃/禁用）
- `last_login`: 最后登录时间

---

#### 2. 审计日志 (AuditLog)

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

**用途：** 记录系统中所有用户操作，用于安全审计和追溯。

---

#### 3. 测试记录 (TestRecord)

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

**字段说明：**
- `record_code`: 检测记录编号（唯一）
- `test_type`: 检测类型（病原体/餐具/通用/自定义）
- `sample_info`: 样本信息（JSON格式）
- `result_data`: 检测结果（JSON格式）
- `status`: 状态（待审核/已完成/失败/已归档）
- `version`: 版本号（用于乐观锁）

---

#### 4. 测试项目 (TestItem)

```prisma
model TestItem {
  id            String   @id @default(cuid())
  test_record_id String
  item_name     String
  item_code     String?
  result        String?                 // positive / negative / qualified / unqualified / etc
  notes         String?
  created_at    DateTime @default(now())

  test_record   TestRecord @relation(fields: [test_record_id], references: [id], onDelete: Cascade)

  @@index([test_record_id])
}
```

**用途：** 记录单个测试记录中的各个检测项目的结果。

---

#### 5. 附件/文件 (Attachment)

```prisma
model Attachment {
  id            String   @id @default(cuid())
  test_record_id String?
  file_name     String
  file_path     String
  file_size     Int?                    // bytes
  file_type     String?                 // MIME type
  uploaded_at   DateTime @default(now())

  test_record   TestRecord? @relation(fields: [test_record_id], references: [id], onDelete: SetNull)

  @@index([test_record_id])
}
```

**用途：** 管理与测试记录关联的文件（报告、证明文件等）。

---

#### 6. 访客管理 (Guest)

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

**用途：** 管理系统访客账户（临时访问权限）。

---

#### 7. 备份元数据 (Backup)

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

**用途：** 记录系统数据备份的元信息。

---

#### 8. 系统日志 (SystemLog)

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

**用途：** 记录系统运行日志，便于故障排查。

---

## SQL 建表语句

### 用户管理相关表 (01_users_schema.sql)

#### 用户表 (users)

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

#### 登录日志表 (login_logs)

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

#### 用户角色表 (user_roles)

```sql
CREATE TABLE IF NOT EXISTS user_roles (
    id BIGSERIAL PRIMARY KEY,
    role_name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    permissions TEXT[],
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 默认角色
INSERT INTO user_roles (role_name, description, permissions) VALUES
    ('user', '普通用户 - 可以创建和编辑自己的检测记录', ARRAY['view_own_records', 'create_records', 'edit_own_records']),
    ('manager', '部门经理 - 可以管理部门内的所有记录', ARRAY['view_department_records', 'create_records', 'edit_all_records', 'delete_records']),
    ('admin', '系统管理员 - 拥有所有权限', ARRAY['all_permissions']);
```

#### 审计日志表 (audit_logs)

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

#### 行级安全策略 (RLS)

```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- 用户可以查看自己的信息或管理员可以查看所有
CREATE POLICY "users_can_view_own_profile" ON users
    FOR SELECT USING (id = current_user_id() OR current_user_role() = 'admin');

-- 用户可以更新自己的信息
CREATE POLICY "users_can_update_own_profile" ON users
    FOR UPDATE USING (id = current_user_id());

-- 只有管理员可以查看所有用户
CREATE POLICY "admins_can_view_all_users" ON users
    FOR SELECT USING (current_user_role() = 'admin');

-- 登录日志隐私保护
CREATE POLICY "users_can_view_own_login_logs" ON login_logs
    FOR SELECT USING (user_id = current_user_id() OR current_user_role() = 'admin');

-- 审计日志仅管理员可见
CREATE POLICY "audit_logs_admin_only" ON audit_logs
    FOR SELECT USING (current_user_role() = 'admin');
```

---

### 访客管理相关表 (02_guests_schema.sql)

#### 访客表 (guests)

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

**guest_type 说明：**
- `viewer`: 只读访客
- `export_applicant`: 可申请导出权限

#### 访客导出申请表 (guest_export_requests)

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

**request_type 说明：**
- `report_export`: 报告导出申请
- `data_export`: 数据导出申请

#### 访客登录日志表 (guest_login_logs)

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

---

### 初始化脚本

#### 种子数据 (02_seed_test_users.sql)

```sql
-- 测试用户
INSERT INTO users (username, email, password_hash, full_name, role, status) 
VALUES ('testuser', 'testuser@example.com', '$2b$10$...', '测试用户', 'user', 'active');

-- QA测试员
INSERT INTO users (username, email, password_hash, full_name, role, status) 
VALUES ('qa_tester', 'qa@example.com', '$2b$10$...', 'QA 测试员', 'user', 'active');

-- 禁用用户
INSERT INTO users (username, email, password_hash, full_name, role, status) 
VALUES ('disabled_user', 'disabled@example.com', '$2b$10$...', '被禁用的用户', 'user', 'disabled');
```

#### 管理员密码设置 (03_set_admin_password.sql)

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

---

## 数据库关系图

```
┌─────────────┐
│    User     │
│  (用户)      │
├─────────────┤
│ id (PK)     │
│ username    │
│ email       │
│ password    │
│ role        │
│ status      │
└──────┬──────┘
       │
       ├──────┐
       │      │
       ▼      ▼
  ┌────────┐ ┌──────────────┐
  │ Guest  │ │ AuditLog     │
  │(访客)   │ │ (审计日志)    │
  └────────┘ └──────────────┘
       │           │
       │           │
       ▼           ▼
┌──────────────────┐
│ GuestExportReq   │
│(访客导出申请)     │
└──────────────────┘

       │
       │ created_by
       ▼
  ┌──────────────┐
  │  TestRecord  │
  │ (检测记录)    │
  │              │
  ├──────────────┤
  │ id (PK)      │
  │ record_code  │
  │ test_type    │
  │ test_name    │
  │ sample_info  │
  │ result_data  │
  │ status       │
  │ created_by   │
  └──────┬───────┘
         │
         ├─────────────┐
         │             │
         ▼             ▼
    ┌─────────┐  ┌───────────┐
    │TestItem │  │Attachment │
    │(测试项) │  │ (附件)     │
    └─────────┘  └───────────┘

┌──────────┐
│  Backup  │
│(备份元数据)│
└──────────┘

┌────────────┐
│ SystemLog  │
│ (系统日志) │
└────────────┘
```

---

## 表结构详解

### 核心表

| 表名 | 用途 | 关键字段 | 备注 |
|------|------|---------|------|
| `users` | 系统用户管理 | id, username, role, status | 支持RLS行级安全 |
| `audit_logs` | 操作审计记录 | user_id, action, resource_type | 重要的安全审计表 |
| `test_records` | 检测记录 | record_code, test_type, status | 核心业务表，支持版本控制 |
| `test_items` | 检测项目 | test_record_id, result | 与test_records关联 |
| `attachments` | 文件管理 | test_record_id, file_path | 支持级联删除 |
| `guests` | 访客管理 | guest_type, valid_until, has_export_permission | 支持过期管理 |
| `guest_export_requests` | 访客导出申请 | status, approved_by | 导出权限申请流程 |
| `backup` | 备份管理 | backup_path, record_count | 系统备份元数据 |
| `system_logs` | 系统日志 | level, message | 日志级别过滤 |

### 索引策略

**频繁查询字段建立索引：**
- `created_at`: 按时间范围查询
- `status`: 按状态过滤
- `user_id`: 按用户关联查询
- `test_type`: 按检测类型过滤

### 数据完整性

- **外键约束**: 使用 `REFERENCES ... ON DELETE CASCADE/SET NULL` 维护数据完整性
- **CHECK约束**: 约束role、status等枚举值
- **唯一约束**: username、email、record_code等业务键
- **行级安全**: PostgreSQL RLS策略保护敏感数据

---

## 开发指南

### 使用 Prisma

```bash
# 安装依赖
npm install @prisma/client

# 初始化迁移
npx prisma migrate dev --name init

# 生成客户端
npx prisma generate

# 查看数据库
npx prisma studio
```

### 常用查询示例

```javascript
// 创建用户
const user = await prisma.user.create({
  data: {
    username: "newuser",
    email: "user@example.com",
    password_hash: "hashed_password",
    role: "user"
  }
});

// 查询用户的所有测试记录
const records = await prisma.testRecord.findMany({
  where: { created_by: userId },
  include: { test_items: true, attachments: true }
});

// 创建审计日志
await prisma.auditLog.create({
  data: {
    user_id: userId,
    action: "CREATE",
    resource_type: "test_record",
    resource_id: recordId
  }
});
```

---

## 安全考虑

1. **密码加密**: 使用bcrypt哈希存储密码（不存储明文）
2. **审计日志**: 记录所有关键操作，可追溯
3. **行级安全**: 利用RLS限制用户数据访问
4. **时间戳**: 记录创建、更新时间用于追溯
5. **访客管理**: 支持过期控制和权限限制

---

**最后更新**: 2026-06-15
