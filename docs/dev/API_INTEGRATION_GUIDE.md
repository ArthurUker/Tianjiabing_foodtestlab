# 🔌 API 集成完整指南 (API_INTEGRATION_GUIDE.md)

**文档状态**: 实现指南版  
**创建日期**: 2026-04-20  
**用途**: 指导后端实现和前端对接

---

## 📌 总体架构

```
用户请求
   ↓
前端 (AuthService/Router)
   ↓
HTTP 请求 (含 Authorization: Bearer {token})
   ↓
后端 (Express 路由)
   ↓
数据库操作
   ↓
响应 JSON
   ↓
前端处理与界面更新
```

---

## 🔐 认证流程详解

### 1️⃣ 登录流程

**前端实现** (`AuthService.js`):
```javascript
async login(username, password) {
    const response = await fetch('/api/user/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    
    if (!response.ok) throw new Error('登录失败');
    const data = await response.json();
    
    // 保存 Token 到 localStorage
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('current_user', JSON.stringify(data.user));
    localStorage.setItem('token_expiry', data.expiresAt);
    
    return data;
}
```

**后端需求** (`POST /api/user/login`):
```javascript
// 请求
POST /api/user/login
Content-Type: application/json

{
    "username": "admin",
    "password": "8888"
}

// 响应 200
{
    "success": true,
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "expiresAt": "2026-04-21T10:00:00Z",
    "refreshToken": "refresh_token_string",
    "user": {
        "id": "user_001",
        "username": "admin",
        "email": "admin@school.com",
        "role": "admin",
        "permissions": ["records:read", "records:create", ...]
    }
}

// 响应 401
{
    "success": false,
    "error": "用户名或密码错误"
}
```

### 2️⃣ Token 验证流程

**前端实现**:
```javascript
// Router.js 每 60 秒调用一次
async validateAndRefreshToken() {
    if (!authService.isAuthenticated()) {
        this.handleLogout();
        return false;
    }
    
    // 如果 Token 快要过期（距离 5 分钟），自动刷新
    if (authService.isTokenExpired()) {
        await authService.refreshToken();
    }
    
    return true;
}
```

**后端需求** (`GET /api/user/verify-token`):
```javascript
// 请求 (Header 必须带 Authorization)
GET /api/user/verify-token
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

// 响应 200
{
    "valid": true,
    "user": {
        "id": "user_001",
        "username": "admin",
        "role": "admin"
    }
}

// 响应 401 (Token 过期或无效)
{
    "valid": false,
    "error": "Token 已过期"
}
```

### 3️⃣ Token 刷新流程 (可选但推荐)

**前端实现**:
```javascript
async refreshToken() {
    const refreshToken = localStorage.getItem('refresh_token');
    const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
    });
    
    const data = await response.json();
    localStorage.setItem('auth_token', data.token);
    localStorage.setItem('token_expiry', data.expiresAt);
    
    return { success: true };
}
```

**后端需求** (`POST /api/auth/refresh`):
```javascript
// 请求
POST /api/auth/refresh
Content-Type: application/json

{
    "refreshToken": "refresh_token_string"
}

// 响应 200
{
    "success": true,
    "token": "new_token_string",
    "expiresAt": "2026-04-21T11:00:00Z"
}

// 响应 401
{
    "success": false,
    "error": "Refresh token 无效"
}
```

---

## 👥 用户管理 API

### 获取用户列表

**前端实现** (`UserManagement.js`):
```javascript
async loadUsers() {
    const page = this.currentPage;
    const limit = this.pageSize; // 10
    
    const response = await fetch(`/api/user/list?page=${page}&limit=${limit}`, {
        headers: { 'Authorization': `Bearer ${authService.getToken()}` }
    });
    
    const data = await response.json();
    this.users = data.users;
    this.totalUsers = data.total;
}
```

**后端需求** (`GET /api/user/list`):
```javascript
// 请求
GET /api/user/list?page=1&limit=10
Authorization: Bearer {token}

// 响应 200
{
    "success": true,
    "users": [
        {
            "id": "user_001",
            "username": "admin",
            "email": "admin@school.com",
            "role": "admin",
            "createdAt": "2026-01-01T00:00:00Z",
            "lastLogin": "2026-04-20T10:00:00Z",
            "status": "active"
        },
        ...
    ],
    "total": 25,
    "page": 1,
    "limit": 10
}
```

### 创建用户

**前端实现**:
```javascript
async createUser(formData) {
    const response = await fetch('/api/user/register', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({
            username: formData.username,
            email: formData.email,
            password: formData.password,
            role: formData.role
        })
    });
    
    return await response.json();
}
```

**后端需求** (`POST /api/user/register`):
```javascript
// 请求
POST /api/user/register
Authorization: Bearer {token}
Content-Type: application/json

{
    "username": "newuser",
    "email": "user@example.com",
    "password": "SecurePass123!",
    "role": "operator"  // admin|manager|operator|viewer|guest
}

// 响应 201
{
    "success": true,
    "user": {
        "id": "user_026",
        "username": "newuser",
        "email": "user@example.com",
        "role": "operator",
        "createdAt": "2026-04-20T10:30:00Z"
    }
}

// 响应 409 (用户已存在)
{
    "success": false,
    "error": "用户名已被使用"
}
```

### 编辑用户

**前端实现** (`UserManagement.js`):
```javascript
async updateUser(userId, formData) {
    const response = await fetch(`/api/user/${userId}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authService.getToken()}`
        },
        body: JSON.stringify({
            username: formData.username,
            email: formData.email,
            role: formData.role
        })
    });
    
    return await response.json();
}
```

**后端需求** (`PUT /api/user/:id`):
```javascript
// 请求
PUT /api/user/user_001
Authorization: Bearer {token}
Content-Type: application/json

{
    "username": "admin_updated",
    "email": "admin@new.com",
    "role": "admin"
}

// 响应 200
{
    "success": true,
    "user": {
        "id": "user_001",
        "username": "admin_updated",
        "email": "admin@new.com",
        "role": "admin",
        "updatedAt": "2026-04-20T10:45:00Z"
    }
}
```

### 删除用户

**前端实现** (`UserManagement.js`):
```javascript
async deleteUser(userId) {
    const response = await fetch(`/api/user/${userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${authService.getToken()}` }
    });
    
    return await response.json();
}
```

**后端需求** (`DELETE /api/user/:id`):
```javascript
// 请求
DELETE /api/user/user_026
Authorization: Bearer {token}

// 响应 200
{
    "success": true,
    "message": "用户已删除"
}

// 响应 404
{
    "success": false,
    "error": "用户不存在"
}
```

---

## 📊 审计日志 API (推荐实现)

**前端实现** (`AuditLog.js`):
```javascript
async loadAuditLogs() {
    const params = new URLSearchParams({
        page: this.currentPage,
        limit: this.pageSize,
        action: document.getElementById('actionFilter').value,
        table: document.getElementById('tableFilter').value,
        user: document.getElementById('userFilter').value,
        dateRange: document.getElementById('dateRangeFilter').value
    });
    
    const response = await fetch(`/api/audit/logs?${params}`, {
        headers: { 'Authorization': `Bearer ${authService.getToken()}` }
    });
    
    const data = await response.json();
    this.logs = data.logs;
    this.totalLogs = data.total;
}
```

**后端需求** (`GET /api/audit/logs`):
```javascript
// 请求
GET /api/audit/logs?page=1&limit=20&action=create&table=tableware&user=admin&dateRange=week
Authorization: Bearer {token}

// 响应 200
{
    "success": true,
    "logs": [
        {
            "id": "audit_1001",
            "timestamp": "2026-04-20T10:30:00Z",
            "user": "admin",
            "userId": "user_001",
            "action": "create",  // create|update|delete|export|login|logout
            "table": "tableware",  // 数据表名
            "recordId": 123,
            "status": "success",  // success|failed
            "ipAddress": "192.168.1.1",
            "oldValue": null,
            "newValue": { "name": "新样品", "status": "合格" },
            "message": "创建餐具检测记录"
        },
        ...
    ],
    "total": 156,
    "page": 1,
    "limit": 20
}
```

---

## 👤 访客管理 API (推荐实现)

**后端需求** (`POST /api/guest/create`):
```javascript
// 请求
POST /api/guest/create
Authorization: Bearer {token}
Content-Type: application/json

{
    "username": "guest_001",
    "email": "guest@example.com",
    "password": "TempPass123!",
    "expiryDays": 7,  // 有效期天数
    "permissions": ["records:read", "export:pdf"],
    "remark": "临时访客账号"
}

// 响应 201
{
    "success": true,
    "guest": {
        "id": "guest_001",
        "username": "guest_001",
        "email": "guest@example.com",
        "role": "guest",
        "createdAt": "2026-04-20T10:00:00Z",
        "expiresAt": "2026-04-27T10:00:00Z",
        "status": "active",
        "permissions": ["records:read", "export:pdf"]
    }
}
```

**后端需求** (`GET /api/guest/list`):
```javascript
// 请求
GET /api/guest/list?page=1&limit=15&status=active
Authorization: Bearer {token}

// 响应 200
{
    "success": true,
    "guests": [
        {
            "id": "guest_001",
            "username": "guest_001",
            "email": "guest@example.com",
            "createdAt": "2026-04-20T10:00:00Z",
            "expiresAt": "2026-04-27T10:00:00Z",
            "status": "active",  // active|expired|disabled
            "permissions": ["records:read", "export:pdf"]
        },
        ...
    ],
    "total": 12,
    "page": 1,
    "limit": 15
}
```

**后端需求** (`DELETE /api/guest/:id`):
```javascript
// 请求
DELETE /api/guest/guest_001
Authorization: Bearer {token}

// 响应 200
{
    "success": true,
    "message": "访客已删除"
}
```

---

## 🔗 请求头约定

所有需要权限的 API 都应包含：

```javascript
Authorization: Bearer {jwt_token}
Content-Type: application/json
```

---

## ⚠️ 错误处理规范

### 前端错误处理流程

```javascript
async makeRequest(url, options = {}) {
    try {
        const response = await fetch(url, options);
        
        if (!response.ok) {
            if (response.status === 401) {
                // Token 无效或过期
                authService.logout();
                window.location.href = './login.html';
                return;
            }
            if (response.status === 403) {
                // 权限不足
                UINotification.error('您没有权限执行此操作');
                return;
            }
            
            const error = await response.json();
            throw new Error(error.message || `HTTP ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        UINotification.error(error.message);
        console.error('API 错误:', error);
        throw error;
    }
}
```

### 标准错误响应格式

```javascript
// 401 Unauthorized
{
    "success": false,
    "error": "Token 已过期"
}

// 403 Forbidden
{
    "success": false,
    "error": "您没有权限执行此操作"
}

// 400 Bad Request
{
    "success": false,
    "error": "请求参数不完整",
    "details": {
        "username": "用户名不能为空"
    }
}

// 500 Internal Server Error
{
    "success": false,
    "error": "服务器内部错误"
}
```

---

## 📋 实现检查清单

### 后端实现清单

- [ ] `POST /api/user/login` — 用户登录
- [ ] `POST /api/user/register` — 创建用户
- [ ] `GET /api/user/list` — 获取用户列表
- [ ] `PUT /api/user/:id` — 编辑用户
- [ ] `DELETE /api/user/:id` — 删除用户
- [ ] `GET /api/user/verify-token` — 验证 Token
- [ ] `POST /api/auth/refresh` — 刷新 Token (推荐)
- [ ] `GET /api/audit/logs` — 获取审计日志 (推荐)
- [ ] `POST /api/guest/create` — 创建访客 (推荐)
- [ ] `GET /api/guest/list` — 获取访客列表 (推荐)
- [ ] `DELETE /api/guest/:id` — 删除访客 (推荐)

### 前端集成完成情况

- [x] AuthService.js — 认证服务
- [x] Router.js — 路由守卫 & Token 验证
- [x] UserManagement.js — 用户管理 UI
- [x] AuditLog.js — 审计日志 UI
- [x] GuestManagement.js — 访客管理 UI
- [x] SessionManager.js — 会话管理

---

## 🚀 快速验证步骤

1. **启动后端服务** — 确保 API 可访问
2. **打开浏览器开发者工具** (F12)
3. **尝试登录** — Network 标签查看 POST /api/user/login
4. **验证响应** — 检查是否有 token 和 user 字段
5. **查看 localStorage** — Application 标签确认 Token 已保存
6. **测试其他 API** — 逐个验证所有端点

---

**文档更新日期**: 2026-04-20
