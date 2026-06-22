# 食品安全检验管理系统 Pro — 代码审阅上下文指导文档

**文档路径**：`docs/review/REVIEW_GUIDE.md`
**系统名称**：食品安全检验管理系统 Pro（珠海一中食品安全检验系统）
**仓库地址**：https://github.com/ArthurUker/Tianjiabing_foodtestlab/tree/ZhuHaiYiZhong
**审阅开始日期**：2026-06-22
**文档用途**：每次新对话开始时，将本文件提供给 AI，以快速恢复审阅上下文，无需重新读取全部代码。

---

## 1. 系统背景速查

### 1.1 核心技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | 原生 HTML + JS ES Modules + Tailwind CSS | 非 React/Vue，模块化原生架构 |
| 可视化 | Chart.js | 数据看板 |
| 文档处理 | Mammoth.js / jsPDF / html2canvas | Word 解析、PDF 导出 |
| 后端 | Node.js + Express.js | REST API |
| ORM | Prisma Client | 数据库建模与访问 |
| 数据库 | SQLite（生产）| 单文件，路径 `D:\珠海一中\foodtestlab.db` |
| 认证 | JWT Bearer Token + bcryptjs | |
| 进程守护 | PM2（进程名 `zhuhaiyizhong-api`）| |
| 反向代理 | Nginx | 前端端口 8082，后端 API 端口 3002 |
| 部署环境 | 腾讯云 Windows Server | 部署分支 `ZhuHaiYiZhong` |

### 1.2 生产部署口径

| 项目 | 配置 |
|------|------|
| 项目目录 | `C:\zhuhaiyizhong` |
| 前端访问端口 | `8082` |
| 后端 API 端口 | `3002` |
| PM2 进程名 | `zhuhaiyizhong-api` |
| 数据库文件 | `D:\珠海一中\foodtestlab.db` |
| API 前缀 | `/api` |
| 登录接口 | `POST /api/user/login` |

### 1.3 后端目录结构

```
backend/
├── server.js                        # 主入口，Express 路由注册、中间件配置
├── modules/
│   └── UserManager.js               # 用户注册/登录/权限逻辑
├── routes/
│   ├── userRoutes.js                # /api/user/* 路由
│   ├── auditRoutes.js               # /api/audit-logs/* 路由
│   └── syncRoutes.js                # /api/sync/* 路由（待审阅）
├── middleware/
│   ├── validationMiddleware.js      # 输入验证、XSS 防护、限流
│   └── idempotencyMiddleware.js     # 幂等性中间件（待审阅）
└── prisma/
    ├── schema.prisma                # 数据库模型定义
    └── seed.js                      # 初始化种子数据
```

### 1.4 前端目录结构（待深度审阅）

```
js/
├── core/
│   └── Router.js                    # 前端路由（待审阅）
├── services/
│   ├── AuthService.js               # 认证服务（待审阅）
│   └── GuestAuthService.js          # 访客认证（待审阅）
├── utils/
│   ├── FormValidator.js             # 表单验证工具
│   ├── UINotification.js            # UI 通知组件
│   └── NetworkHelper.js             # 网络请求封装
└── modules/                         # 各业务模块（待审阅）
```

---

## 2. 已审阅文件清单

| 文件 | 审阅状态 | 备注 |
|------|----------|------|
| `backend/server.js` | ✅ 已读取（约前 2/3）| 路由注册、中间件、记录 API |
| `backend/prisma/schema.prisma` | ✅ 完整读取 | 全部 8 个模型 |
| `backend/routes/userRoutes.js` | ✅ 已读取（约前 3/4）| 认证、用户管理路由 |
| `backend/routes/auditRoutes.js` | ✅ 已读取（约前 3/4）| 审计日志路由 |
| `backend/middleware/validationMiddleware.js` | ⚠️ 部分读取 | 仅读取到 sanitizeHtml 开头 |
| `backend/modules/UserManager.js` | ❌ 未读取 | 待下一轮 |
| `backend/middleware/idempotencyMiddleware.js` | ❌ 未读取 | 待下一轮 |
| `backend/routes/syncRoutes.js` | ❌ 未读取 | 待下一轮 |
| `js/core/Router.js` | ❌ 未读取 | 待下一轮 |
| `js/services/AuthService.js` | ❌ 未读取 | 待下一轮 |
| `js/services/GuestAuthService.js` | ❌ 未读取 | 待下一轮 |
| `js/main.js` | ❌ 未读取 | 待下一轮 |

---

## 3. 已发现问题清单

### 🔴 P0 — 高危问题（建议 1~3 天内处理）

#### P0-01：`authenticateUser` 中间件三处实现不一致
- **位置**：`server.js`（export 函数）、`userRoutes.js`（局部函数）、`auditRoutes.js`（局部函数）
- **问题**：
  - `server.js` 版本：调用 `userManager.verifyToken()`，将结果挂载到 `req.userId` 和 `req.userRole`
  - `userRoutes.js` 版本：调用 `userManager.verifyToken()`，挂载到 `req.user`（对象）
  - `auditRoutes.js` 版本：直接调用 `jwt.verify()`，绕过 `UserManager`，挂载到 `req.user`
  - 三处挂载字段名不同（`req.userId` vs `req.user.userId`），下游代码若混用将导致 `undefined` 引用错误
- **修复建议**：将认证中间件抽取为独立模块 `middleware/authMiddleware.js`，统一导出，所有路由文件 import 使用

#### P0-02：JWT 密钥 fallback 为弱明文字符串
- **位置**：`backend/server.js` 第 18 行
- **代码**：`const JWT_SECRET = process.env.JWT_SECRET || 'local-dev-jwt-secret'`
- **问题**：若生产环境 `.env` 未配置 `JWT_SECRET`，系统将使用公开可猜测的弱密钥签发 JWT，攻击者可伪造任意用户 Token
- **修复建议**：
  ```js
  if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is not set. Server will not start.')
    process.exit(1)
  }
  const JWT_SECRET = process.env.JWT_SECRET
  ```

#### P0-03：`POST /api/user/register` 完全公开，无需授权
- **位置**：`backend/routes/userRoutes.js`
- **问题**：任何人均可自行注册账号，对于内部管理系统而言存在越权注册风险
- **修复建议**：将注册接口改为需要 Admin 权限，或增加邀请码/审批机制

#### P0-04：`record_code` 双重生成逻辑并存，幂等性失效
- **位置**：`backend/server.js`
- **问题**：
  - `POST /api/test-records`（通用接口）使用 `REC-${Date.now()}` 生成
  - `/api/records/:type` 路由使用 `buildDeterministicRecordCode()`（SHA-256 哈希）
  - 两套逻辑并存，`Date.now()` 方案无法保证幂等性，前端重试时会产生重复记录
- **修复建议**：统一使用 `buildDeterministicRecordCode()`，废弃 `Date.now()` 方案

---

### 🟠 P1 — 重要问题（建议 1 周内处理）

#### P1-01：`auditRoutes.js` 路由注册顺序冲突
- **位置**：`backend/routes/auditRoutes.js`
- **问题**：`GET /:logId` 注册在 `GET /stats/summary` 之前，Express 会将 `/stats/summary` 中的 `summary` 识别为 `logId` 参数，导致统计接口永远无法命中
- **修复建议**：将所有具名静态路由（`/stats/summary`、`/cleanup`）移到动态参数路由（`/:logId`）之前注册

#### P1-02：`TestRecord` 的 `sample_info` 和 `result_data` 使用 JSON 字符串存储
- **位置**：`backend/prisma/schema.prisma`，`TestRecord` 模型
- **问题**：
  - SQLite 无原生 JSON 类型，字段为 `String?`，无法在数据库层面进行结构化查询
  - 所有业务逻辑依赖应用层 `JSON.parse/stringify`，容错性差，字段损坏时无法感知
  - `buildRecordWriteData()` 中仅提取 `testDate`、`canteen`、`inspector` 存入 `sample_info`，其余全量存入 `result_data`，结构不透明
- **修复建议**：将高频查询字段（`testDate`、`canteen`、`inspector`、`status`）提升为独立 Schema 字段并建立索引；保留 `result_data` 存储非结构化扩展数据

#### P1-03：`Guest` 模型与 `User` 模型高度重复，缺乏统一抽象
- **位置**：`backend/prisma/schema.prisma`
- **问题**：`Guest` 模型包含 `username`、`email`、`password_hash`、`full_name`、`status` 等字段，与 `User` 模型几乎重复，但两者独立存储，无法复用认证逻辑
- **修复建议**：在 `User` 模型中增加 `user_type` 字段（`internal` / `guest`），或通过 `role` 字段区分，统一认证流程

#### P1-04：`Backup` 模型缺少关联用户外键约束
- **位置**：`backend/prisma/schema.prisma`，`Backup` 模型
- **问题**：`created_by` 字段为 `String?`，未与 `User` 模型建立外键关联，无法追溯备份操作者
- **修复建议**：添加 `created_user User? @relation(...)` 关联

#### P1-05：CORS 配置硬编码了生产服务器 IP
- **位置**：`backend/server.js`，`parseAllowedOrigins()` 函数
- **代码**：`'http://159.75.106.179:8082'` 硬编码在源码中
- **问题**：IP 变更时需修改代码并重新部署；同时暴露了服务器 IP 至公开仓库
- **修复建议**：完全通过 `CORS_ORIGIN` 环境变量配置，源码中不保留任何 IP 地址

#### P1-06：`validationMiddleware.js` 的 XSS 防护实现不完整
- **位置**：`backend/middleware/validationMiddleware.js`
- **问题**：已读取部分显示 `sanitizeHtml` 函数存在，但实现被截断；`escapeHtml` 函数的 escapeMap 中 `'` 被映射为反引号（`` ` ``），疑似编码错误
- **修复建议**：`'` 应映射为 `&#x27;` 或 `&apos;`，需确认原始代码

---

### 🟡 P2 — 优化建议（建议 2 周内处理）

#### P2-01：`rateLimit` 默认值过高（1000 次/分钟）
- **位置**：`backend/server.js`
- **问题**：`RATE_LIMIT_MAX_REQUESTS` 默认 1000 次/分钟，对于内部管理系统而言过于宽松，无法有效防止暴力破解
- **修复建议**：登录接口单独设置更严格的限流（如 10 次/分钟）

#### P2-02：`AuditLog` 缺少对检测记录操作的自动记录机制
- **位置**：`backend/server.js`，记录 CRUD 路由
- **问题**：检测记录的创建、更新、删除操作未自动写入 `AuditLog`，审计追踪不完整
- **修复建议**：在记录 CRUD 路由的成功响应后，统一调用 `prisma.auditLog.create()`

#### P2-03：`TestRecord` 的 `onDelete: Cascade` 可能导致意外数据丢失
- **位置**：`backend/prisma/schema.prisma`
- **问题**：`created_user` 关联设置 `onDelete: Cascade`，删除用户时会级联删除其所有检测记录，对于食品安全合规场景不可接受
- **修复建议**：改为 `onDelete: Restrict` 或 `onDelete: SetNull`，禁止删除有记录关联的用户

#### P2-04：`/api/health` 与 `/health` 重复定义
- **位置**：`backend/server.js`
- **问题**：两个健康检查端点功能重复，增加维护成本
- **修复建议**：统一保留 `/api/health`，删除 `/health`

#### P2-05：`buildRecordWriteData()` 中字段提取逻辑脆弱
- **位置**：`backend/server.js`
- **问题**：函数通过 `baseData.testDate || null` 等方式提取字段，若前端字段命名变更（如 `test_date`），后端无感知，静默存储 `null`
- **修复建议**：增加字段存在性校验，或使用 Zod/Joi 进行请求体 Schema 验证

---

### 🔵 P3 — 长期优化（规划阶段）

#### P3-01：SQLite 单文件数据库的并发与容灾限制
- **问题**：SQLite 不支持多写并发，生产环境若出现并发写入可能导致数据库锁定；单文件无内置复制机制
- **建议**：中期规划迁移至 PostgreSQL（Schema 已预留兼容性）

#### P3-02：前端 `localStorage` 存储 JWT Token 存在 XSS 风险
- **位置**：`js/services/AuthService.js`（待审阅确认）
- **问题**：`localStorage` 中的 Token 可被 XSS 脚本读取，建议改用 `httpOnly Cookie`
- **建议**：后端配合实现 Cookie-based Token 存储

#### P3-03：缺少 API 版本控制机制
- **问题**：所有接口均挂载在 `/api/` 下，无版本号（如 `/api/v1/`），未来接口变更无法平滑过渡
- **建议**：引入 `/api/v1/` 前缀，为未来版本迭代预留空间

#### P3-04：`Attachment` 模型的 `file_path` 为本地路径，无云存储支持
- **问题**：附件存储为本地文件路径，无法在多实例或云环境下共享访问
- **建议**：规划接入腾讯云 COS 对象存储

---

## 4. 待审阅文件与下一步任务

### 4.1 下一轮需读取的文件（优先级排序）

```
# 后端（高优先级）
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/backend/modules/UserManager.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/backend/middleware/idempotencyMiddleware.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/backend/routes/syncRoutes.js

# 前端（高优先级）
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/services/AuthService.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/core/Router.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/main.js

# 前端（中优先级）
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/services/GuestAuthService.js
https://raw.githubusercontent.com/ArthurUker/Tianjiabing_foodtestlab/ZhuHaiYiZhong/js/utils/NetworkHelper.js
```

### 4.2 审阅维度清单（每轮对话参考）

每次读取新文件时，重点检查以下维度：

| 维度 | 检查要点 |
|------|----------|
| **安全性** | 输入验证、XSS/SQL注入防护、权限校验、Token 存储方式 |
| **一致性** | 接口契约与前端调用是否匹配、字段命名统一性 |
| **健壮性** | 错误处理完整性、边界条件、JSON 解析容错 |
| **可维护性** | 代码重复度、模块职责单一性、注释完整性 |
| **性能** | 数据库查询效率、N+1 问题、缓存策略 |
| **合规性** | 审计日志完整性、数据删除策略、食品安全记录保留要求 |

---

## 5. 每次新对话的接续指令模板

> 在新对话开始时，将本文件内容粘贴给 AI，并附加以下指令：

```
我正在对食品安全检验管理系统进行代码审阅。
仓库地址：https://github.com/ArthurUker/Tianjiabing_foodtestlab/tree/ZhuHaiYiZhong
本次审阅上下文见附件 REVIEW_GUIDE.md（docs/review/REVIEW_GUIDE.md）。

本轮任务：
1. 读取"第4节-待审阅文件"中的下一批文件（使用 raw.githubusercontent.com 链接）
2. 按"第4.2节-审阅维度清单"进行分析
3. 将新发现的问题追加到本文档"第3节-已发现问题清单"中
4. 更新"第2节-已审阅文件清单"的状态
5. 输出更新后的完整 REVIEW_GUIDE.md
```

---

## 6. 文档变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-06-22 | v0.1 | 初始创建，完成后端核心文件审阅（server.js、schema.prisma、userRoutes.js、auditRoutes.js） |