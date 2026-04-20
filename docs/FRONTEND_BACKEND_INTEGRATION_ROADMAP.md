# 前端-后端功能集成开发路线图

**文档版本**: 1.0  
**创建日期**: 2026-04-20  
**优先级**: P1（关键）  
**状态**: 规划中

---

## 📋 概述

本文档规划了后端已实现但前端未集成的功能开发路线。这些功能对系统的安全性、用户管理和权限控制至关重要。

---

## 🎯 后端已实现功能清单

| 功能模块 | 后端实现 | 前端集成 | 优先级 | 工作量(天) |
|---------|---------|---------|--------|-----------|
| **用户认证系统** | ✅ UserManager.js | ❌ 无登录UI | P1 | 3-4 |
| **用户管理 API** | ✅ userRoutes.js | ❌ 无管理界面 | P1 | 4-5 |
| **JWT Token 验证** | ✅ 完整实现 | ⚠️ 部分集成 | P1 | 1-2 |
| **权限/角色系统** | ⚠️ 部分实现 | ❌ 无 | P2 | 4-6 |
| **操作审计日志** | ⚠️ 有框架 | ❌ 无查看UI | P2 | 3-4 |
| **访客管理系统** | ❌ 未实现 | ❌ 无 | P3 | 5-7 |
| **会话管理** | ⚠️ 部分 | ❌ 无 | P3 | 3-5 |

---

## 🚀 分阶段开发计划

### **Phase 1: 用户认证与基础用户管理（第1-2周）**

#### 1.1 登录界面实现
**优先级**: P1  
**预计工作量**: 2-3天

**功能需求**:
- 创建独立登录页面 (`login.html`)
- 支持用户名 + 密码登录
- 表单验证（空值检查、密码强度）
- 记住我功能（localStorage）
- 忘记密码链接（先占位）

**前端文件**:
```
js/
  ├── pages/
  │   ├── Login.js (新建)
  │   └── MainApp.js (新建 - 登录后主界面路由)
  └── services/
      └── AuthService.js (新建 - 调用后端认证)
```

**API 集成**:
```javascript
// 调用后端登录接口
POST /api/user/login
{
  "username": "string",
  "password": "string"
}

// 响应
{
  "success": true,
  "token": "jwt_token",
  "user": {
    "id": "user_id",
    "username": "name",
    "role": "admin|user|guest"
  }
}
```

**具体任务**:
- [ ] 创建 `login.html` 页面（HTML/CSS/Form）
- [ ] 实现 `AuthService.js` 调用后端 `/api/user/login`
- [ ] 实现 Token 存储到 localStorage
- [ ] 实现 Token 过期检查与自动登出
- [ ] 创建页面路由守卫（未登录重定向到登录页）
- [ ] 集成到主应用初始化流程

**涉及后端路由**:
```
POST /api/user/login       (已实现)
POST /api/user/logout      (需确认)
GET  /api/user/verify-token (需添加)
```

---

#### 1.2 用户管理界面
**优先级**: P1  
**预计工作量**: 2-3天

**功能需求**:
- 用户列表页面（管理员专用）
- 创建新用户
- 编辑用户信息
- 删除用户（软删除）
- 启用/禁用用户账户
- 重置用户密码

**前端文件**:
```
js/
  └── modules/
      └── UserManagement.js (新建)
```

**UI 布局**:
```
用户管理
├── 创建新用户按钮
├── 搜索框（按用户名/邮箱）
├── 用户表格
│   ├── 用户名 | 邮箱 | 角色 | 状态 | 创建时间 | 操作
│   └── [删除] [编辑] [重置密码]
└── 分页控件
```

**API 集成**:
```javascript
GET    /api/user/list              // 获取用户列表
POST   /api/user/create            // 创建用户
PUT    /api/user/:id               // 更新用户信息
DELETE /api/user/:id               // 删除用户
PATCH  /api/user/:id/status        // 启用/禁用
PATCH  /api/user/:id/reset-password // 重置密码
```

**具体任务**:
- [ ] 创建 `UserManagement.js` 模块
- [ ] 实现用户列表获取与展示
- [ ] 实现创建用户弹窗
- [ ] 实现编辑用户弹窗
- [ ] 实现删除用户确认
- [ ] 实现启用/禁用状态切换
- [ ] 添加权限检查（仅 admin 可访问）

---

### **Phase 2: 权限与角色管理（第2-3周）**

#### 2.1 角色权限系统设计
**优先级**: P2  
**预计工作量**: 3-4天

**权限模型**:
```
角色类型:
  - admin      (管理员) - 所有权限
  - manager    (主管) - 查看、创建记录，管理操作人员
  - operator   (操作人员) - 创建、编辑自己的记录
  - viewer     (查看者) - 只读权限
  - guest      (访客) - 有限只读权限

权限细分:
  - records:read    (查看检测记录)
  - records:create  (创建记录)
  - records:update  (编辑记录)
  - records:delete  (删除记录)
  - export:pdf      (导出PDF)
  - backup:manage   (备份管理)
  - users:manage    (用户管理)
  - audit:view      (查看审计日志)
```

**后端任务** (可能需要后端补充):
- [ ] 在 `users` 表添加 `role` 字段
- [ ] 在 `users` 表添加 `permissions` JSON 字段
- [ ] 创建 `roles` 表与 `permissions` 表
- [ ] 实现权限检查中间件

**前端任务**:
- [ ] 创建 `PermissionService.js` (检查当前用户权限)
- [ ] 实现 UI 权限守卫（隐藏无权限的按钮/菜单）
- [ ] 实现 API 权限拦截器（无权限请求自动拦截）

**文件**:
```
js/
  └── services/
      ├── PermissionService.js (新建)
      └── PermissionGuard.js (新建)
```

---

#### 2.2 操作审计日志
**优先级**: P2  
**预计工作量**: 2-3天

**功能需求**:
- 记录所有数据修改操作（创建、编辑、删除）
- 显示操作者、操作时间、操作内容
- 提供审计日志查询界面
- 支持按用户/日期/操作类型筛选

**后端需求**:
```
创建 audit_logs 表:
  - id
  - user_id
  - action (create|update|delete|export)
  - table_name (tableware|pesticide|oil|...)
  - record_id
  - old_value (变更前)
  - new_value (变更后)
  - ip_address
  - timestamp
```

**前端任务**:
- [ ] 创建审计日志查询页面
- [ ] 实现日志列表展示
- [ ] 实现详情查看（变更前后对比）
- [ ] 实现导出审计日志

**文件**:
```
js/
  └── modules/
      └── AuditLog.js (新建)
```

**UI 布局**:
```
审计日志
├── 筛选条件
│   ├── 用户名
│   ├── 日期范围
│   ├── 操作类型
│   └── 数据表名
├── 日志表格
│   ├── 操作人 | 操作 | 表名 | 记录ID | 时间 | 详情
│   └── [查看详情]
└── 分页
```

---

### **Phase 3: 访客管理与会话管理（第3-4周）**

#### 3.1 访客管理系统
**优先级**: P3  
**预计工作量**: 4-5天

**功能需求**:
- 创建访客账户（临时账户）
- 设置访客权限（只读 + 限制功能）
- 设置访客过期时间
- 访客活动追踪
- 访客账户禁用/删除

**数据库设计** (后端需添加):
```
guests 表:
  - id
  - username
  - password_hash
  - email (可选)
  - created_by (创建者user_id)
  - expires_at
  - is_active
  - permissions (JSON)
  - last_login
  - login_count
```

**前端任务**:
- [ ] 创建访客管理页面
- [ ] 实现创建访客表单
- [ ] 实现访客列表与操作
- [ ] 实现访客活动日志查看

---

#### 3.2 会话管理
**优先级**: P3  
**预计工作量**: 2-3天

**功能需求**:
- Token 过期自动刷新
- 多标签页同步登出
- 在线用户列表
- 用户活动监测

**实现**:
- [ ] 实现 Token 刷新机制 (`refresh_token`)
- [ ] 实现 `beforeunload` 事件清理会话
- [ ] 实现跨标签页通信 (localStorage 事件)
- [ ] 实现用户空闲超时自动登出 (30分钟)

---

## 📂 文件结构规划

```
project/
├── html/
│   ├── login.html (新建)
│   ├── index.html (修改 - 移动现有内容到新页面)
│   └── dashboard.html (新建)
│
├── js/
│   ├── pages/
│   │   ├── Login.js (新建)
│   │   ├── App.js (新建 - 主应用入口)
│   │   └── Router.js (新建)
│   │
│   ├── modules/
│   │   ├── UserManagement.js (新建)
│   │   ├── AuditLog.js (新建)
│   │   ├── GuestManagement.js (新建)
│   │   └── [现有检测模块...]
│   │
│   ├── services/
│   │   ├── AuthService.js (新建)
│   │   ├── PermissionService.js (新建)
│   │   ├── AuditService.js (新建)
│   │   ├── SessionService.js (新建)
│   │   └── [现有服务...]
│   │
│   └── core/
│       ├── Auth.js (修改 - 集成后端)
│       ├── Middleware.js (新建 - 权限守卫)
│       └── [现有...]
│
└── docs/
    └── FRONTEND_BACKEND_INTEGRATION_ROADMAP.md (本文件)
```

---

## 🔌 后端接口总结

### 已实现需集成
```
POST   /api/user/register
POST   /api/user/login
GET    /api/user/profile
PUT    /api/user/password
GET    /api/records/:type
POST   /api/records/:type
PUT    /api/records/:type/:id
DELETE /api/records/:type/:id
```

### 需后端补充
```
POST   /api/user/logout
GET    /api/user/verify-token
GET    /api/user/list (分页)
POST   /api/user/create
PUT    /api/user/:id
DELETE /api/user/:id
PATCH  /api/user/:id/status
PATCH  /api/user/:id/reset-password

GET    /api/audit/logs
GET    /api/audit/logs/:id

POST   /api/guests
GET    /api/guests
PUT    /api/guests/:id
DELETE /api/guests/:id

GET    /api/sessions/active
POST   /api/sessions/refresh
```

---

## ✅ 检查清单

### Phase 1
- [ ] 后端确认 Token 过期时间设置
- [ ] 前端创建 `AuthService.js`
- [ ] 前端实现登录页面 (`login.html`)
- [ ] 前端实现主应用路由守卫
- [ ] 前端实现用户管理模块
- [ ] 测试登录流程端到端
- [ ] 测试用户管理 CRUD 操作

### Phase 2
- [ ] 后端实现权限检查中间件
- [ ] 前端实现 `PermissionService.js`
- [ ] 后端创建 `audit_logs` 表
- [ ] 前端实现审计日志模块
- [ ] 测试权限检查
- [ ] 测试审计日志记录与查询

### Phase 3
- [ ] 后端创建 `guests` 表
- [ ] 后端实现访客 API
- [ ] 前端实现访客管理模块
- [ ] 前端实现 Token 刷新机制
- [ ] 前端实现会话超时
- [ ] 全流程测试

---

## 🧪 测试计划

```
单元测试:
  - AuthService 登录逻辑
  - PermissionService 权限检查
  - AuditService 日志记录

集成测试:
  - 登录 → 主界面 → 创建数据 → 登出
  - 用户 A 创建数据 → 用户 B 编辑 → 审计日志验证
  - 权限限制测试 (viewer 不能编辑)

E2E 测试 (Cypress):
  - 完整登录流程
  - 用户管理操作
  - 数据操作与审计

安全测试:
  - SQL 注入防护
  - XSS 防护
  - Token 过期处理
  - 无权限访问
```

---

## 📊 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 后端 API 不完整 | 中 | 高 | 提前与后端沟通，补充缺失接口 |
| Token 过期处理复杂 | 低 | 中 | 参考标准实践，充分测试 |
| 权限系统过度设计 | 低 | 低 | 从简单权限开始，逐步优化 |
| 性能下降 | 低 | 中 | 实现权限缓存，减少 API 调用 |

---

## 📅 时间估算

| Phase | 预计周期 | 关键路径 |
|-------|---------|---------|
| Phase 1 | 2周 | 登录 → 用户管理 |
| Phase 2 | 1周 | 权限 + 审计日志 |
| Phase 3 | 1.5周 | 访客管理 + 会话 |
| **总计** | **4-4.5周** | - |

---

## 🚀 快速启动建议

**立即开始** (Next Sprint):
1. 确认后端 API 端点完整性
2. 创建 `AuthService.js` 与登录页面
3. 实现路由守卫与主应用初始化
4. 集成到现有检测模块

**不要等待**:
- 后端权限表的完整性 — 从前端权限检查开始
- 完美的 UI 设计 — 功能优先，样式后优化

---

## 📝 附录：API 文档模板

每个 API 端点需要补充完整文档：

```markdown
### POST /api/user/login

**请求**:
```json
{
  "username": "string",
  "password": "string"
}
```

**响应** (200):
```json
{
  "success": true,
  "token": "eyJhbGc...",
  "user": {
    "id": "user_123",
    "username": "admin",
    "email": "admin@school.com",
    "role": "admin"
  }
}
```

**错误** (401):
```json
{
  "success": false,
  "error": "用户名或密码错误"
}
```

**Header**:
- `Authorization: Bearer {token}` (后续请求)
```

---

**文档完成日期**: 2026-04-20  
**下次审查**: 2026-04-27
