# 食品安全检验管理系统 Pro 后端接口文档

**文档名称**：`API_REFERENCE.md`  
**系统名称**：食品安全检验管理系统 Pro / 珠海一中食品安全检验系统  
**后端目录**：`backend/`  
**文档版本**：v1.1  
**更新时间**：2026-06-16  
**默认后端端口**：`3002`  
**生产访问端口**：`8082`，由 Nginx 反向代理至后端 `/api`  
**主要依据文件**：`backend/server.js`  
**适用对象**：后端开发人员、前端开发人员、测试人员、部署运维人员

---

## 1. 文档目的

本文档用于说明食品安全检验管理系统 Pro 当前后端 REST API 的实际启用接口、认证机制、请求参数、响应格式、错误码和调试方式。

本版本基于完整 `backend/server.js` 进一步收敛，重点明确：

1. 当前实际启用的接口；
2. 当前未启用但历史文件中存在的接口；
3. 前端当前主用接口；
4. 需要后续统一或清理的历史路径。

若本文档与代码存在不一致，应以以下文件为准：

```text
backend/server.js
backend/routes/userRoutes.js
backend/routes/auditRoutes.js
backend/modules/UserManager.js
backend/prisma/schema.prisma
```

---

## 2. 后端服务基本信息

| 项目 | 当前配置 |
|---|---|
| 后端框架 | Express |
| ORM | Prisma Client |
| 数据库 | SQLite |
| 认证方式 | JWT Bearer Token |
| 密码加密 | bcryptjs |
| 默认端口 | `3002` |
| API 前缀 | `/api` |
| 用户路由挂载 | `/api/user` |
| 审计路由挂载 | `/api/audit-logs` |
| 检测记录接口 | `/api/records/:tableName` |
| 通用测试记录接口 | `/api/test-records` |

生产环境中，Nginx 通常将：

```text
http://服务器IP:8082/api/*
```

反向代理至：

```text
http://127.0.0.1:3002/api/*
```

---

## 3. 当前后端目录结构

```text
backend/
├── .env
├── README.md
├── config
│   └── telemetry.js
├── middleware
│   ├── idempotencyMiddleware.js
│   └── validationMiddleware.js
├── modules
│   └── UserManager.js
├── package-lock.json
├── package.json
├── prisma
│   ├── dedupe-test-records.js
│   ├── foodtestlab.db
│   ├── prisma
│   │   └── foodtestlab.db
│   ├── schema.prisma
│   └── seed.js
├── routes
│   ├── auditRoutes.js
│   ├── syncRoutes.js
│   └── userRoutes.js
├── server.js
└── sql
    ├── 01_users_schema.sql
    ├── 02_guests_schema.sql
    ├── 02_seed_test_users.sql
    └── 03_set_admin_password.sql
```

---

## 4. 当前实际启用接口总览

以下接口均基于 `backend/server.js` 的实际路由定义整理。

| 模块 | Method | Path | 认证 | 权限 | 说明 |
|---|---|---|---:|---|---|
| 健康检查 | GET | `/health` | 否 | - | 后端基础健康检查 |
| 健康检查 | GET | `/api/health` | 否 | - | API 健康检查，生产环境推荐 |
| 用户认证 | POST | `/api/user/login` | 否 | - | 用户登录，来自 `userRoutes.js` |
| 用户认证 | POST | `/api/user/logout` | 是 | 登录用户 | 用户登出，来自 `userRoutes.js` |
| 审计日志 | GET/POST | `/api/audit-logs/*` | 是 | 按路由控制 | 审计日志查询、写入或导出，来自 `auditRoutes.js` |
| 通用测试记录 | POST | `/api/test-records` | 是 | 登录用户 | 创建通用测试记录 |
| 通用测试记录 | GET | `/api/test-records` | 是 | 登录用户 | 获取通用测试记录列表 |
| 通用测试记录 | GET | `/api/test-records/:id` | 是 | 登录用户 | 获取单条通用测试记录 |
| 通用测试记录 | PUT | `/api/test-records/:id` | 是 | 登录用户 | 更新通用测试记录 |
| 通用测试记录 | DELETE | `/api/test-records/:id` | 是 | 登录用户 | 删除通用测试记录 |
| 前端检测记录 | GET | `/api/records/:tableName` | 是 | 登录用户 | 查询某类检测记录 |
| 前端检测记录 | POST | `/api/records/:tableName` | 是 | 登录用户 | 新增某类检测记录，支持内容哈希去重 |
| 前端检测记录 | POST | `/api/records/:tableName/bulk-upsert` | 是 | 登录用户 | 批量导入或批量更新 |
| 前端检测记录 | GET | `/api/records/:tableName/:id` | 是 | 登录用户 | 获取某类检测记录详情 |
| 前端检测记录 | PUT | `/api/records/:tableName/:id` | 是 | 登录用户 | 更新某类检测记录，支持版本冲突检查 |
| 前端检测记录 | DELETE | `/api/records/:tableName/:id` | 是 | 登录用户 | 删除某类检测记录 |
| 用户管理 | GET | `/api/users` | 是 | admin | 获取用户列表 |
| 用户管理 | POST | `/api/users/:userId/disable` | 是 | admin | 禁用用户 |
| 用户管理 | POST | `/api/users/:userId/enable` | 是 | admin | 启用用户 |

---

## 5. 当前未启用或不应作为正式接口使用的路径

以下接口曾出现在早期文档、前端旧封装或历史路由文件中，但根据当前完整 `server.js`，**未作为主服务正式挂载**。

| 路径 | 当前状态 | 说明 |
|---|---|---|
| `POST /api/login` | 未启用 | 早期文档写法，`server.js` 未定义 |
| `POST /api/auth/login` | 未启用 | `ApiClient.js` 旧封装中存在，`server.js` 未挂载 `/api/auth` |
| `GET /api/audit` | 未启用 | 当前实际挂载为 `/api/audit-logs` |
| `POST /api/audit` | 未启用 | 当前实际挂载为 `/api/audit-logs` |
| `POST /api/sync` | 未启用 | 当前 `server.js` 未定义 |
| `POST /api/sync/users` | 未启用 | `syncRoutes.js` 中存在，但主服务未挂载 |
| `POST /api/sync/testRecords` | 未启用 | `syncRoutes.js` 中存在，但主服务未挂载 |
| `POST /api/sync/status` | 未启用 | `syncRoutes.js` 中存在，但主服务未挂载 |
| `POST /api/users` | 未在 `server.js` 直接定义 | 如需确认用户创建接口，应查看 `routes/userRoutes.js` |
| `PUT /api/users/:id` | 未在 `server.js` 直接定义 | 如需确认用户更新接口，应查看 `routes/userRoutes.js` |
| `DELETE /api/users/:id` | 未在 `server.js` 直接定义 | 如需确认用户删除接口，应查看 `routes/userRoutes.js` |

---

## 6. 通用请求约定

### 6.1 JSON 请求头

```http
Content-Type: application/json
```

### 6.2 Token 请求头

需要认证的接口必须携带：

```http
Authorization: Bearer <token>
```

示例：

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI...
```

### 6.3 通用数据格式

| 项目 | 约定 |
|---|---|
| 请求体 | JSON |
| 响应体 | JSON |
| 字符编码 | UTF-8 |
| 时间格式 | ISO 8601 或数据库时间字符串 |
| ID 格式 | Prisma `cuid()` 字符串 |
| 空值 | `null` |
| 布尔值 | `true` / `false` |

---

## 7. 认证机制

### 7.1 认证方式

系统采用 JWT Bearer Token 认证。用户登录成功后，后端返回 Token，前端保存至 `localStorage`。

前端主要存储键：

| Key | 说明 |
|---|---|
| `auth_token` | JWT 访问令牌 |
| `current_user` | 当前登录用户信息 |
| `token_expiry` | Token 过期时间 |
| `refresh_token` | 刷新令牌，如后端返回 |

### 7.2 后端认证中间件

`server.js` 中的认证中间件逻辑为：

```javascript
export function authenticateUser(req, res, next) {
    const authHeader = req.headers['authorization']

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' })
    }

    const token = authHeader.split(' ')[1]
    const verification = userManager.verifyToken(token)

    if (!verification.valid) {
        return res.status(401).json({ error: 'Invalid token', details: verification.error })
    }

    req.userId = verification.user.userId
    req.userRole = verification.user.role
    next()
}
```

### 7.3 缺少 Token 响应

```json
{
  "error": "Missing or invalid Authorization header"
}
```

HTTP 状态码：

```text
401 Unauthorized
```

### 7.4 Token 无效响应

```json
{
  "error": "Invalid token",
  "details": "jwt expired"
}
```

HTTP 状态码：

```text
401 Unauthorized
```

---

## 8. 健康检查接口

## 8.1 基础健康检查

```http
GET /health
```

### 认证要求

不需要 Token。

### 成功响应示例

```json
{
  "status": "✅ API Server is running",
  "timestamp": "2026-06-16T03:00:00.000Z"
}
```

---

## 8.2 API 健康检查

```http
GET /api/health
```

### 认证要求

不需要 Token。

### 成功响应示例

```json
{
  "status": "ok",
  "timestamp": "2026-06-16T03:00:00.000Z"
}
```

### 调试示例

```bash
curl http://127.0.0.1:3002/api/health
```

PowerShell：

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:3002/api/health" -Method GET
```

---

## 9. 用户认证接口

用户认证接口由以下代码挂载：

```javascript
const userRoutes = createUserRoutes(userManager)
app.use('/api/user', userRoutes)
```

因此用户认证接口统一位于：

```text
/api/user/*
```

具体子路由以 `backend/routes/userRoutes.js` 为准。

---

## 9.1 用户登录

```http
POST /api/user/login
```

### 前端依据

`js/services/AuthService.js` 当前实际调用：

```javascript
fetch(`${this.apiBaseUrl}/api/user/login`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username, password })
});
```

### 认证要求

不需要 Token。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `username` | string | 是 | 用户名 |
| `password` | string | 是 | 用户密码 |

### 请求示例

```json
{
  "username": "admin",
  "password": "admin123"
}
```

### 成功响应示例

```json
{
  "success": true,
  "token": "jwt-token",
  "expiresIn": 1800000,
  "user": {
    "id": "clxxxx",
    "username": "admin",
    "email": "admin@foodlab.local",
    "fullName": "系统管理员",
    "phone": null,
    "role": "admin",
    "status": "active"
  }
}
```

### 失败响应示例

```json
{
  "success": false,
  "message": "用户名或密码错误"
}
```

### 错误码

| 状态码 | 说明 |
|---:|---|
| `400` | 用户名或密码为空 |
| `401` | 用户名或密码错误 |
| `403` | 用户被禁用 |
| `500` | 服务端异常 |

---

## 9.2 用户登出

```http
POST /api/user/logout
```

### 认证要求

需要 Token。

### 请求头

```http
Authorization: Bearer <token>
Content-Type: application/json
```

### 成功响应示例

```json
{
  "success": true,
  "message": "登出成功"
}
```

### 说明

前端在登出时会调用该接口。即使接口调用失败，前端也会清除本地认证信息。

---

## 10. 审计日志接口

审计日志接口由以下代码挂载：

```javascript
const auditRoutes = createAuditRoutes(prisma, JWT_SECRET)
app.use('/api/audit-logs', auditRoutes)
```

因此当前正式审计接口前缀为：

```text
/api/audit-logs
```

> 注意：`/api/audit` 当前未在 `server.js` 中挂载，不应作为正式接口使用。

### 10.1 写入审计日志

```http
POST /api/audit-logs
```

### 认证要求

需要 Token。

### 前端依据

`js/services/AuditLogService.js` 当前调用：

```javascript
fetch(`${this.apiBaseUrl}/api/audit-logs`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
        action,
        table_name,
        record_id,
        details
    })
});
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `action` | string | 是 | 操作类型 |
| `table_name` | string | 是 | 表名或资源名 |
| `record_id` | string / number | 否 | 记录 ID |
| `details` | string | 否 | 操作详情 |

### 请求示例

```json
{
  "action": "create",
  "table_name": "tableware",
  "record_id": "clxxxx",
  "details": "新增餐具洁净度检测记录"
}
```

### 成功响应示例

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "action": "create",
    "table_name": "tableware",
    "record_id": "clxxxx",
    "details": "新增餐具洁净度检测记录",
    "created_at": "2026-06-16T03:00:00.000Z"
  }
}
```

### 错误码

| 状态码 | 说明 |
|---:|---|
| `400` | 参数错误 |
| `401` | 未认证 |
| `500` | 写入失败 |

---

## 10.2 查询审计日志

```http
GET /api/audit-logs
```

### 认证要求

需要 Token。

### Query 参数

具体参数以 `backend/routes/auditRoutes.js` 实现为准。建议支持：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `page` | number | 否 | 页码 |
| `pageSize` | number | 否 | 每页条数 |
| `action` | string | 否 | 操作类型 |
| `userId` | string | 否 | 用户 ID |
| `startDate` | string | 否 | 起始日期 |
| `endDate` | string | 否 | 结束日期 |

### 成功响应建议格式

```json
{
  "success": true,
  "data": [],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 0,
    "totalPages": 0
  }
}
```

---

## 11. 通用测试记录接口 `/api/test-records`

该组接口由 `server.js` 直接定义，面向 `TestRecord` 主表，适合后端调试、系统集成或未来统一数据模型使用。

与 `/api/records/:tableName` 的区别：

| 接口组 | 定位 |
|---|---|
| `/api/test-records` | 通用 `TestRecord` CRUD 接口 |
| `/api/records/:tableName` | 当前前端业务模块主用接口，带业务类型映射和内容去重 |

---

## 11.1 创建通用测试记录

```http
POST /api/test-records
```

### 认证要求

需要 Token。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `test_type` | string | 否 | 检测类型，默认 `generic` |
| `test_name` | string | 是 | 检测名称 |
| `sample_info` | object | 否 | 样本信息 |
| `result_data` | object | 否 | 结果数据 |

### 请求示例

```json
{
  "test_type": "tableware",
  "test_name": "餐具洁净度检测",
  "sample_info": {
    "testDate": "2026-06-16",
    "canteen": "学校食堂",
    "inspector": "检测员01"
  },
  "result_data": {
    "sampleName": "餐盘",
    "rluValue": 120,
    "result": "合格"
  }
}
```

### 后端写入逻辑

后端会生成：

```javascript
record_code: `REC-${Date.now()}`
status: 'pending'
created_by: req.userId
```

并将 `sample_info`、`result_data` 转为 JSON 字符串存储。

### 成功响应示例

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "record_code": "REC-1718500000000",
    "test_type": "tableware",
    "test_name": "餐具洁净度检测",
    "status": "pending"
  },
  "message": "测试记录创建成功"
}
```

---

## 11.2 获取通用测试记录列表

```http
GET /api/test-records
```

### 认证要求

需要 Token。

### Query 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `limit` | number | 否 | `100` | 返回数量 |
| `offset` | number | 否 | `0` | 偏移量 |
| `test_type` | string | 否 | - | 检测类型 |
| `status` | string | 否 | - | 状态 |

### 请求示例

```http
GET /api/test-records?limit=100&offset=0&test_type=tableware
```

### 成功响应示例

```json
{
  "success": true,
  "data": [],
  "total": 0,
  "limit": 100,
  "offset": 0
}
```

---

## 11.3 获取单个通用测试记录

```http
GET /api/test-records/:id
```

### 认证要求

需要 Token。

### 返回内容

该接口会包含关联数据：

```text
test_items
attachments
created_user
```

### 成功响应示例

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "record_code": "REC-1718500000000",
    "test_type": "tableware",
    "test_items": [],
    "attachments": [],
    "created_user": {
      "id": "user_id",
      "username": "admin",
      "full_name": "系统管理员"
    }
  }
}
```

### 记录不存在响应

```json
{
  "error": "记录不存在"
}
```

HTTP 状态码：

```text
404
```

---

## 11.4 更新通用测试记录

```http
PUT /api/test-records/:id
```

### 认证要求

需要 Token。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `test_name` | string | 否 | 检测名称 |
| `status` | string | 否 | 状态 |
| `result_data` | object | 否 | 结果数据 |

### 请求示例

```json
{
  "test_name": "餐具洁净度检测",
  "status": "completed",
  "result_data": {
    "result": "合格"
  }
}
```

### 成功响应示例

```json
{
  "success": true,
  "data": {},
  "message": "更新成功"
}
```

---

## 11.5 删除通用测试记录

```http
DELETE /api/test-records/:id
```

### 认证要求

需要 Token。

### 成功响应示例

```json
{
  "success": true,
  "message": "删除成功"
}
```

---

## 12. 前端检测记录接口 `/api/records/:tableName`

该组接口由 `server.js` 直接定义，注释为：

```javascript
// ====== Legacy Frontend Compatibility: /api/records/:tableName ======
```

但根据当前前端 `js/core/Storage.js`，该接口仍是当前前端业务模块的主用数据接口。

前端默认配置：

```javascript
const DEFAULT_CONFIG = {
    apiBaseUrl: '/api/records',
    maxSyncRows: 200,
    syncCooldownMs: 30000
};
```

---

## 12.1 支持的 tableName

`server.js` 中支持的记录类型：

```javascript
const RECORD_ROUTE_TYPES = new Set([
    'tableware',
    'pathogen',
    'leanMeat',
    'oil',
    'pesticide'
])
```

| tableName | 中文业务模块 | test_type |
|---|---|---|
| `tableware` | 餐具洁净度检测 | `tableware` |
| `pathogen` | 病原体检测 | `pathogen` |
| `leanMeat` | 肉、蛋农残检测 | `leanMeat` |
| `oil` | 食用油品质检测 | `oil` |
| `pesticide` | 果蔬农残检测 | `pesticide` |

如果 `tableName` 不在上述范围内，后端会返回：

```json
{
  "error": "未知记录类型: xxx"
}
```

或：

```json
{
  "error": "记录类型不存在"
}
```

---

## 12.2 查询某类检测记录列表

```http
GET /api/records/:tableName
```

### 认证要求

需要 Token。

### Query 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---:|---|---|
| `limit` | number | 否 | `100` | 返回数量 |
| `offset` | number | 否 | `0` | 偏移量 |
| `status` | string | 否 | - | 状态筛选 |

### 请求示例

```http
GET /api/records/tableware?limit=100&offset=0
```

### 后端查询逻辑

后端会将：

```text
tableName
```

转换为：

```text
test_type
```

并查询 `TestRecord` 表：

```javascript
const where = { test_type: testType }
```

### 成功响应示例

```json
{
  "success": true,
  "data": [
    {
      "id": "clxxxx",
      "record_code": "RC-tableware-xxxx",
      "test_type": "tableware",
      "test_name": "餐具洁净度检测",
      "status": "completed",
      "version": 1,
      "created_at": "2026-06-16T03:00:00.000Z",
      "updated_at": "2026-06-16T03:00:00.000Z",
      "testDate": "2026-06-16",
      "canteen": "学校食堂",
      "inspector": "检测员01",
      "sampleName": "餐盘",
      "result": "合格"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

---

## 12.3 新增某类检测记录

```http
POST /api/records/:tableName
```

### 认证要求

需要 Token。

### 请求头

```http
Content-Type: application/json
Authorization: Bearer <token>
```

### 请求示例

```json
{
  "testDate": "2026-06-16",
  "canteen": "学校食堂",
  "inspector": "检测员01",
  "sampleName": "餐盘",
  "rluValue": 120,
  "detergentResidue": "阴性",
  "result": "合格",
  "status": "completed"
}
```

### 后端写入逻辑

后端将请求体拆分为：

```javascript
sample_info: JSON.stringify({
    testDate,
    canteen,
    inspector
})
```

以及：

```javascript
result_data: JSON.stringify(baseData)
```

同时写入：

```javascript
test_type: tableName
test_name: TEST_TYPE_LABELS[tableName]
status: baseData.status || 'completed'
created_by: req.userId
version: 1
```

### 内容哈希去重机制

`/api/records/:tableName` 的新增接口具备内容级去重能力。

后端会根据 `tableName` 和业务内容生成确定性 `record_code`：

```javascript
const recordCode = buildDeterministicRecordCode(testType, payload)
```

如果相同业务内容已存在，后端不会重复创建，而是返回已有记录：

```json
{
  "success": true,
  "deduplicated": true,
  "data": {},
  "message": "记录已存在，已按幂等策略返回现有数据"
}
```

### 成功响应示例

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "record_code": "RC-tableware-xxxx",
    "test_type": "tableware",
    "test_name": "餐具洁净度检测",
    "status": "completed",
    "version": 1,
    "testDate": "2026-06-16",
    "canteen": "学校食堂",
    "inspector": "检测员01",
    "sampleName": "餐盘",
    "rluValue": 120,
    "result": "合格"
  },
  "message": "记录创建成功"
}
```

### 错误码

| 状态码 | 说明 |
|---:|---|
| `400` | 未知记录类型 |
| `401` | 未认证 |
| `422` | 关联用户不存在，需要重新登录 |
| `500` | 创建失败 |

### 关联用户不存在响应

当 `created_by` 对应用户不存在时，后端返回：

```json
{
  "error": "关联用户不存在，请重新登录",
  "details": "Foreign key constraint failed",
  "code": "INVALID_USER"
}
```

HTTP 状态码：

```text
422
```

---

## 12.4 批量导入或批量更新某类检测记录

```http
POST /api/records/:tableName/bulk-upsert
```

### 认证要求

需要 Token。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `records` | array | 是 | 待导入记录数组 |

### 约束条件

| 条件 | 说明 |
|---|---|
| `records` 不能为空 | 否则返回 `400` |
| 单次不能超过 `2000` 条 | 超过返回 `400` |
| 相同业务内容自动去重 | 后端根据内容生成 `record_code` |
| 已存在记录执行更新 | `version` 加 1 |
| 不存在记录执行创建 | `version = 1` |

### 请求示例

```json
{
  "records": [
    {
      "testDate": "2026-06-16",
      "canteen": "学校食堂",
      "inspector": "检测员01",
      "sampleName": "餐盘",
      "rluValue": 120,
      "result": "合格"
    }
  ]
}
```

### 成功响应示例

```json
{
  "success": true,
  "message": "批量导入完成",
  "data": {
    "received": 1,
    "unique": 1,
    "created": 1,
    "updated": 0,
    "failed": 0,
    "failedRecords": []
  }
}
```

### 错误码

| 状态码 | 说明 |
|---:|---|
| `400` | `records` 为空或超过 2000 条 |
| `401` | 未认证 |
| `404` | 记录类型不存在 |
| `500` | 批量导入失败 |

---

## 12.5 获取某类检测记录详情

```http
GET /api/records/:tableName/:id
```

### 认证要求

需要 Token。

### 成功响应示例

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "record_code": "RC-tableware-xxxx",
    "test_type": "tableware",
    "test_name": "餐具洁净度检测",
    "status": "completed",
    "version": 1,
    "testDate": "2026-06-16",
    "canteen": "学校食堂",
    "inspector": "检测员01"
  }
}
```

### 记录不存在响应

```json
{
  "error": "记录不存在"
}
```

HTTP 状态码：

```text
404
```

---

## 12.6 更新某类检测记录

```http
PUT /api/records/:tableName/:id
```

### 认证要求

需要 Token。

### 版本冲突控制

如果客户端传入 `version` 字段，后端会进行乐观锁检查：

```javascript
if (req.body.version !== existing.version) {
    return res.status(409).json({
        error: '版本冲突，请获取最新数据后重试',
        serverVersion: existing.version,
        clientVersion: req.body.version
    })
}
```

### 请求示例

```json
{
  "testDate": "2026-06-16",
  "canteen": "学校食堂",
  "inspector": "检测员01",
  "sampleName": "餐盘",
  "rluValue": 180,
  "result": "合格",
  "version": 1
}
```

### 成功响应示例

```json
{
  "success": true,
  "data": {
    "id": "clxxxx",
    "version": 2,
    "result": "合格"
  },
  "message": "更新成功"
}
```

### 版本冲突响应

```json
{
  "error": "版本冲突，请获取最新数据后重试",
  "serverVersion": 2,
  "clientVersion": 1
}
```

HTTP 状态码：

```text
409
```

---

## 12.7 删除某类检测记录

```http
DELETE /api/records/:tableName/:id
```

### 认证要求

需要 Token。

### 成功响应示例

```json
{
  "success": true,
  "message": "删除成功"
}
```

### 记录不存在响应

```json
{
  "error": "记录不存在"
}
```

HTTP 状态码：

```text
404
```

---

## 13. 用户管理接口

当前 `server.js` 直接定义的用户管理接口包括：

```text
GET  /api/users
POST /api/users/:userId/disable
POST /api/users/:userId/enable
```

这三个接口均要求：

```text
req.userRole === 'admin'
```

否则返回：

```json
{
  "error": "Only admins can access this"
}
```

HTTP 状态码：

```text
403
```

---

## 13.1 获取用户列表

```http
GET /api/users
```

### 认证要求

需要 Token。

### 权限要求

仅 `admin`。

### 后端逻辑

```javascript
const users = await userManager.getUserList(100, 0)
res.json(users)
```

当前该接口固定查询：

```text
limit = 100
offset = 0
```

### 成功响应示例

实际响应由 `userManager.getUserList()` 决定，通常为用户列表或包含用户列表的对象。

示例：

```json
{
  "success": true,
  "data": [
    {
      "id": "clxxxx",
      "username": "admin",
      "email": "admin@foodlab.local",
      "full_name": "系统管理员",
      "phone": null,
      "role": "admin",
      "status": "active",
      "created_at": "2026-06-16T03:00:00.000Z"
    }
  ]
}
```

### 错误码

| 状态码 | 说明 |
|---:|---|
| `401` | 未认证 |
| `403` | 非管理员 |
| `500` | 获取失败 |

---

## 13.2 禁用用户

```http
POST /api/users/:userId/disable
```

### 认证要求

需要 Token。

### 权限要求

仅 `admin`。

### 路径参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `userId` | string | 是 | 用户 ID |

### 成功响应示例

```json
{
  "success": true,
  "message": "用户已禁用"
}
```

实际响应以 `userManager.disableUser()` 返回值为准。

---

## 13.3 启用用户

```http
POST /api/users/:userId/enable
```

### 认证要求

需要 Token。

### 权限要求

仅 `admin`。

### 路径参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `userId` | string | 是 | 用户 ID |

### 成功响应示例

```json
{
  "success": true,
  "message": "用户已启用"
}
```

实际响应以 `userManager.enableUser()` 返回值为准。

---

## 14. 幂等性与重复提交控制

`server.js` 中对 `/api/records` 启用了幂等中间件：

```javascript
app.use('/api/records', idempotencyMiddleware)
```

因此以下接口会经过该中间件：

```text
GET    /api/records/:tableName
POST   /api/records/:tableName
POST   /api/records/:tableName/bulk-upsert
GET    /api/records/:tableName/:id
PUT    /api/records/:tableName/:id
DELETE /api/records/:tableName/:id
```

同时，`POST /api/records/:tableName` 还实现了内容哈希去重：

```text
tableName + 业务内容 -> SHA256 -> record_code
```

因此该接口具有两层重复提交控制：

1. 路径级幂等中间件；
2. 业务内容级确定性 `record_code` 去重。

---

## 15. 当前同步机制说明

当前 `server.js` 未挂载 `/api/sync`。

虽然项目中存在：

```text
backend/routes/syncRoutes.js
```

但当前主服务中未见：

```javascript
import syncRoutes from './routes/syncRoutes.js'
app.use('/api/sync', syncRoutes)
```

因此：

```text
/api/sync
/api/sync/users
/api/sync/testRecords
/api/sync/status
```

均不属于当前正式启用接口。

当前前端同步机制实际通过 `StorageService` 调用以下接口完成：

```text
GET    /api/records/:tableName
POST   /api/records/:tableName
PUT    /api/records/:tableName/:id
DELETE /api/records/:tableName/:id
```

对应本地缓存键：

| tableName | 缓存键 | 待同步队列 |
|---|---|---|
| `tableware` | `cache_tableware` | `pending_tableware` |
| `pesticide` | `cache_pesticide` | `pending_pesticide` |
| `oil` | `cache_oil` | `pending_oil` |
| `leanMeat` | `cache_leanMeat` | `pending_leanMeat` |
| `pathogen` | `cache_pathogen` | `pending_pathogen` |

---

## 16. CORS 与安全中间件

### 16.1 CORS 配置

默认允许来源：

```text
http://localhost:3000
http://localhost:3002
http://localhost:8082
http://localhost:5173
http://127.0.0.1:5500
```

也可通过环境变量配置：

```text
CORS_ORIGIN
CORS_HOSTNAMES
CORS_ADDITIONAL_HOSTS
```

若设置：

```text
CORS_ORIGIN=*
```

则允许全部来源。

### 16.2 请求体大小限制

```javascript
app.use(express.json({ limit: '10mb' }))
```

即 JSON 请求体最大约为：

```text
10 MB
```

### 16.3 限流配置

`server.js` 中启用：

```javascript
app.use(rateLimit(RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS))
```

默认配置：

```text
RATE_LIMIT_MAX_REQUESTS = 1000
RATE_LIMIT_WINDOW_MS = 60000
```

即默认每 60 秒最多 1000 次请求。

---

## 17. 通用错误码说明

| HTTP 状态码 | 含义 | 常见原因 |
|---:|---|---|
| `200` | 请求成功 | 正常返回 |
| `400` | 请求参数错误 | 记录类型错误、records 为空、超过数量限制 |
| `401` | 未认证 | 缺少 Token、Token 无效、Token 过期 |
| `403` | 无权限 | 非 admin 访问用户管理接口 |
| `404` | 资源不存在 | 记录不存在、记录类型不存在 |
| `409` | 版本冲突 | 更新记录时客户端 version 与服务端不一致 |
| `422` | 语义校验失败 | created_by 对应用户不存在 |
| `429` | 请求过频 | 触发限流 |
| `500` | 服务端异常 | Prisma 异常、数据库异常、未捕获错误 |
| `502` | 网关错误 | Nginx 无法连接后端进程 |

---

## 18. PowerShell 调试示例

### 18.1 健康检查

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:3002/api/health" `
  -Method GET
```

### 18.2 登录并保存 Token

```powershell
$loginBody = @{
  username = "admin"
  password = "admin123"
} | ConvertTo-Json

$loginResp = Invoke-RestMethod `
  -Uri "http://127.0.0.1:3002/api/user/login" `
  -Method POST `
  -ContentType "application/json" `
  -Body $loginBody

$token = $loginResp.token
$token
```

### 18.3 查询餐具检测记录

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:3002/api/records/tableware" `
  -Method GET `
  -Headers @{ Authorization = "Bearer $token" }
```

### 18.4 新增餐具检测记录

```powershell
$recordBody = @{
  testDate = "2026-06-16"
  canteen = "学校食堂"
  inspector = "检测员01"
  sampleName = "餐盘"
  rluValue = 120
  detergentResidue = "阴性"
  result = "合格"
  status = "completed"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://127.0.0.1:3002/api/records/tableware" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer $token" } `
  -Body $recordBody
```

### 18.5 批量导入餐具检测记录

```powershell
$bulkBody = @{
  records = @(
    @{
      testDate = "2026-06-16"
      canteen = "学校食堂"
      inspector = "检测员01"
      sampleName = "餐盘"
      rluValue = 120
      result = "合格"
    }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri "http://127.0.0.1:3002/api/records/tableware/bulk-upsert" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer $token" } `
  -Body $bulkBody
```

### 18.6 查询用户列表

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:3002/api/users" `
  -Method GET `
  -Headers @{ Authorization = "Bearer $token" }
```

---

## 19. 常见问题排查

### 19.1 登录接口 404

当前正式登录接口是：

```http
POST /api/user/login
```

以下路径当前未启用：

```text
/api/login
/api/auth/login
```

若登录 404，应检查：

1. `AuthService.js` 中的登录路径；
2. `server.js` 中 `app.use('/api/user', userRoutes)` 是否存在；
3. Nginx 是否正确代理 `/api`；
4. 后端 PM2 进程是否在线。

### 19.2 审计接口 404

当前正式审计前缀是：

```http
/api/audit-logs
```

以下路径当前未启用：

```text
/api/audit
```

### 19.3 同步接口 404

当前未启用：

```text
/api/sync
```

当前同步应通过：

```text
/api/records/:tableName
```

完成。

### 19.4 401 Unauthorized

常见原因：

1. 请求未携带 `Authorization`；
2. Token 不是 `Bearer <token>` 格式；
3. Token 已过期；
4. 后端 `JWT_SECRET` 变化；
5. 本地缓存保存了旧 Token。

可在前端控制台清理：

```javascript
localStorage.removeItem('auth_token');
localStorage.removeItem('current_user');
localStorage.removeItem('token_expiry');
location.reload();
```

### 19.5 403 Forbidden

当前用户管理接口要求：

```text
req.userRole === 'admin'
```

非管理员访问：

```text
GET /api/users
POST /api/users/:userId/disable
POST /api/users/:userId/enable
```

会返回：

```json
{
  "error": "Only admins can access this"
}
```

### 19.6 409 版本冲突

更新检测记录时，如果传入的 `version` 与服务端不一致，会返回：

```json
{
  "error": "版本冲突，请获取最新数据后重试",
  "serverVersion": 2,
  "clientVersion": 1
}
```

处理建议：

1. 重新调用 `GET /api/records/:tableName/:id`；
2. 使用最新数据合并修改；
3. 再次提交更新。

### 19.7 422 INVALID_USER

新增检测记录时，如果 Token 中的用户 ID 已不存在，后端会返回：

```json
{
  "error": "关联用户不存在，请重新登录",
  "code": "INVALID_USER"
}
```

处理建议：

1. 清理前端登录缓存；
2. 重新登录；
3. 确认数据库中用户仍存在。

### 19.8 502 Bad Gateway

常见原因：

1. PM2 后端进程未启动；
2. 后端端口不是 `3002`；
3. Nginx 代理地址错误；
4. Windows 防火墙或端口占用。

排查命令：

```powershell
pm2 list
pm2 logs zhuhaiyizhong-api
netstat -ano | findstr :3002
nginx -t
```

---

## 20. 后续标准化建议

### 20.1 统一认证路径

当前正式路径为：

```text
/api/user/login
/api/user/logout
```

若后续希望更符合 REST 习惯，可统一迁移为：

```text
/api/auth/login
/api/auth/logout
```

但迁移前必须同步修改：

```text
backend/server.js
backend/routes/userRoutes.js
js/services/AuthService.js
js/utils/ApiClient.js
README.md
ARCHITECTURE.md
API_REFERENCE.md
```

### 20.2 统一用户管理 CRUD

当前 `server.js` 仅直接定义：

```text
GET /api/users
POST /api/users/:userId/disable
POST /api/users/:userId/enable
```

如需完整用户 CRUD，建议后续标准化为：

```text
GET    /api/users
POST   /api/users
GET    /api/users/:id
PUT    /api/users/:id
DELETE /api/users/:id
POST   /api/users/:id/disable
POST   /api/users/:id/enable
```

### 20.3 统一同步接口

当前同步依赖：

```text
/api/records/:tableName
```

如后续需要批量同步，应正式启用：

```text
POST /api/sync
```

并将 `routes/syncRoutes.js` 迁移为 ES Modules 后在 `server.js` 中挂载。

### 20.4 统一响应格式

建议后续统一成功响应为：

```json
{
  "success": true,
  "data": {},
  "message": "操作成功"
}
```

统一错误响应为：

```json
{
  "success": false,
  "code": "ERROR_CODE",
  "message": "错误说明",
  "details": {}
}
```

---

## 21. 版本记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-06-16 | 初始版本。基于架构文档、前端调用文件和部分后端资料整理。 |
| v1.1 | 2026-06-16 | 基于完整 `backend/server.js` 收敛。明确当前实际启用接口，移除 `/api/login`、`/api/auth/login`、`/api/audit`、`/api/sync` 作为正式接口；补充 `/api/test-records`、`/api/records/:tableName/bulk-upsert` 和当前用户管理实际接口。 |