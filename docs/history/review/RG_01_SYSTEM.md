> 📎 本文件是 REVIEW_GUIDE 的子文件。索引见 [REVIEW_GUIDE.md](./REVIEW_GUIDE.md)
> **所属章节**：§1 系统背景速查（§1.1 ~ §1.9）
> **最后更新**：v0.36（2026-07-01 P1-26 闭环 — 数据库路径歧义确认）

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
| 数据库 | SQLite（生产）| 单文件，路径待确认（见 §1.2 注意事项）|
| 认证 | JWT Bearer Token + bcryptjs | Token 有效期 7 天（`JWT_EXPIRES_IN=7d`）|
| 进程守护 | PM2（进程名 `zhuhaiyizhong-api`）| |
| 反向代理 | Nginx | 前端端口 8082，后端 API 端口 3002 |
| 部署环境 | 腾讯云 Windows Server | 部署分支 `ZhuHaiYiZhong` |
| 可观测性 | OpenTelemetry + Jaeger + Prometheus | `backend/config/telemetry.js`（CommonJS，未集成到主进程）|
| 前端数据层 | `StorageService` + `AdaptiveUploadQueue` | 离线优先架构，localStorage 缓存 + 异步上传队列 |

### 1.2 生产部署口径

| 项目 | 配置 |
|------|------|
| 项目目录 | `C:\zhuhaiyizhong` |
| 前端访问端口 | `8082` |
| 后端 API 端口 | `3002` |
| PM2 进程名 | `zhuhaiyizhong-api` |
| 数据库文件 | `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`（✅ P1-26 已确认） |
| API 前缀 | `/api` |
| 登录接口 | `POST /api/user/login` |
| 初始管理员账号 | `admin` / 由 `.env` 中 `SEED_ADMIN_PASSWORD` 配置（✅ P0-05 已修复，明文 fallback 已删除）|
| 初始测试员账号 | `operator` / 由 `.env` 中 `SEED_OPERATOR_PASSWORD` 配置（✅ P0-05 已修复）|
| 初始查看员账号 | `viewer` / 由 `.env` 中 `SEED_VIEWER_PASSWORD` 配置（✅ P0-05 已修复）|

> ✅ **数据库路径已确认（P1-26 闭环）**：
> - **生产服务器实际 `DATABASE_URL`**：`file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db`（对应物理路径 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`）
> - **确认依据**：`deploy.ps1` L107（`$dataPath = "D:\ZhuHaiYiZhong-data"`）+ L311-322（部署时强制写入 `backend/.env` 的 `DATABASE_URL`），部署脚本覆盖 `.env.example` 模板值，运行时路径以部署脚本为准
> - **`.env.example` L17** 记录 `DATABASE_URL="file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db"`，与生产实际一致 ✅
> - **`docs/` 系统文档**（ARCHITECTURE.md / DATABASE_SCHEMA.md / DEPLOYMENT_GUIDE.md / README.md）仍记录田家炳系统遗留路径 `D:\珠海一中\foodtestlab.db`（错误），将在 DOCS-01/02/03/04 系列中统一修正（TD-P2-30）

### 1.3 完整项目目录结构（v0.8 更新）

```
项目根目录/
├── .babelrc / .gitignore / .npmrc / .vscode/
├── .env.example                          ✅ 已审阅
├── package.json                          ✅ 已审阅（v0.8 新增）✅ P0-10 已修复：已添加 "type":"module"，start 脚本改为 cd backend && npm start
├── index.html                            ✅ 已审阅（主页面）
├── login.html                            ✅ 已审阅（登录页）
├── guest.html                            ❌ 文件不存在（404 已确认）
├── backend/
│   ├── package.json                      ✅ 已审阅（v0.8 新增）✅ 正确配置 "type":"module" 和 prisma 依赖
│   ├── server.js                         ✅ 已审阅
│   ├── config/telemetry.js               ✅ 已审阅
│   ├── middleware/
│   │   ├── idempotencyMiddleware.js       ✅ 已审阅
│   │   └── validationMiddleware.js        ✅ 已审阅
│   ├── modules/UserManager.js            ✅ 已审阅
│   ├── prisma/
│   │   ├── schema.prisma                 ✅ 已审阅
│   │   ├── seed.js                       ✅ 已审阅
│   │   └── dedupe-test-records.js        ✅ 已审阅
│   └── routes/
│       ├── auditRoutes.js                ✅ 已审阅
│       ├── syncRoutes.js                 ✅ 已审阅（严重问题）
│       └── userRoutes.js                 ✅ 已审阅
├── docs/
│   └── review/REVIEW_GUIDE.md            ✅ 本文件
├── js/
│   ├── main.js                           ✅ 已审阅（部分）
│   ├── core/
│   │   ├── Auth.js                       ✅ 已审阅
│   │   ├── Router.js                     ✅ 已审阅
│   │   ├── Storage.js                    ✅ 已审阅（v0.7 完整确认：_getHeaders 正常注入 Bearer Token；✅ P0-08 已修复：_canSyncWithServer temp-token- 前缀判断已移除，改为依赖后端 401 阻断）
│   │   └── AdaptiveUploadQueue.js        ✅ 已审阅（v0.7 完整确认：_makeFingerprint 完整；_isRecentlyCompleted 末尾轻微截断不影响逻辑；_doRequest URL 硬编码问题已记录为 P1-24）
│   ├── modules/
│   │   ├── AuditLog.js                   ✅ 已审阅
│   │   ├── BackupRestore.js              ✅ 已审阅
│   │   ├── Dashboard.js                  ✅ 已审阅
│   │   ├── GenericTest.js                ✅ 已审阅
│   │   ├── GuestDashboard.js             ✅ 已审阅
│   │   ├── Pathogen.js                   ✅ 已审阅
│   │   ├── Tableware.js                  ✅ 已审阅
│   │   └── UserManagement.js             ✅ 已审阅（部分）
│   ├── services/
│   │   ├── AuditLogService.js            ✅ 已审阅
│   │   ├── AuthService.js                ✅ 已审阅
│   │   ├── ExportService.js              ✅ 已审阅
│   │   ├── GuestAuthService.js           ✅ 已审阅
│   │   ├── PermissionService.js          ✅ 已审阅
│   │   └── SessionManager.js             ✅ 已审阅
│   └── utils/
│       ├── AuditLogger.js                ✅ 已审阅
│       ├── FormValidator.js              ✅ 已审阅
│       ├── NetworkHelper.js              ✅ 已审阅
│       ├── pathogenRisk.js               ✅ 已审阅（逻辑正常）
│       ├── SampleDataGenerator.js        ✅ 已审阅
│       ├── UIHelper.js                   ✅ 已审阅
│       └── UINotification.js             ✅ 已审阅
└── [工程配置文件]                         ❌ 未读取（.babelrc、webpack.config.js 等，优先级低）
```

> **审阅覆盖率**：核心业务文件已全部覆盖（~95%）。`guest.html` 已确认不存在。剩余未读取项为低优先级工程配置文件。

### 1.4 系统核心数据流架构

```
用户操作
    │
    ▼
StorageService.save() / update() / delete()
    │
    ├─► 立即写入 localStorage（cache_{tableName}）
    │       └─► 返回带 _status:'pending' 的临时记录（tempId）
    │
    └─► 加入 AdaptiveUploadQueue（pending_{tableName}）
            │
            ▼
        异步批量上传 → POST/PUT/DELETE /api/records/{type}
        （携带 Idempotency-Key 请求头，自动指数退避重试）
            │
            ├─► 成功：用服务端 record_code 替换 tempId，_status='synced'
            └─► 失败：指数退避重试，_currentInterval 最大 15s
```

### 1.5 关键接口速查

| 接口 | 方法 | 权限 | 说明 |
|------|------|------|------|
| `/api/user/login` | POST | 公开 | 用户登录 |
| `/api/user/register` | POST | 公开⚠️ | 用户注册（应限制为 Admin） |
| `/api/user/verify-token` | POST | 公开 | Token 验证 |
| `/api/user/me` | GET | 已登录 | 获取当前用户 |
| `/api/user/change-password` | POST | 已登录 | 修改密码 |
| `/api/user/list` | GET | Admin | 用户列表 |
| `/api/user/:id/role` | POST | Admin | 修改角色 |
| `/api/audit-logs` | GET/POST | 已登录 | 审计日志 |
| `/api/audit-logs/stats/summary` | GET | Admin⚠️ | 路由冲突风险 |
| `/api/audit-logs/stats/:date` | GET | 已登录 | 按日期统计 |
| `/api/sync/users` | POST | 无认证⚠️ | 用户同步（危险） |
| `/api/sync/testRecords` | POST | 无认证⚠️ | 记录同步（危险） |
| `/api/records/:type` | GET/POST/PUT/DELETE | 已登录 | 检测记录 CRUD |
| `/api/auth/refresh` | POST | 公开 | Token 刷新⚠️ 后端未实现 |
| `/api/guest/register` | POST | 公开 | 访客注册 |
| `/api/guest/login` | POST | 公开 | 访客登录 |
| `/api/guest-export-request/submit` | POST | 访客Token | 提交导出申请 |

### 1.6 角色权限矩阵（来自 PermissionService.js）

| 权限 | admin | manager | operator | viewer | guest |
|------|:-----:|:-------:|:--------:|:------:|:-----:|
| records:read | ✅ | ✅ | ✅ | ✅ | ✅ |
| records:create | ✅ | ✅ | ✅ | ❌ | ❌ |
| records:update | ✅ | ✅ | ✅ | ❌ | ❌ |
| records:delete | ✅ | ❌ | ❌ | ❌ | ❌ |
| export:pdf | ✅ | ✅ | ✅ | ✅ | ❌ |
| export:excel | ✅ | ✅ | ❌ | ❌ | ❌ |
| backup:create | ✅ | ❌ | ❌ | ❌ | ❌ |
| users:管理 | ✅ | read only | ❌ | ❌ | ❌ |
| audit:view | ✅ | ✅ | ❌ | ❌ | ❌ |
| module:pathogen | ✅ | ✅ | ✅ | ✅ | ❌ |

### 1.7 前端认证模块命名混淆说明

> ⚠️ 系统中存在**两个不同的 AuthService**，极易混淆：

| 文件 | 导出名 | 职责 | 被谁使用 |
|------|--------|------|---------|
| `js/services/AuthService.js` | `AuthService` / `authService` | JWT Token 管理、登录/登出、用户信息存取 | Router.js、main.js、AuditLogService.js 等 |
| `js/core/Auth.js` | `AuthService`（同名类）/ `auth`（单例） | 仅做操作二次确认弹窗（删除时 confirm）+ 读取 localStorage 用户名 | Tableware.js、GenericTest.js、Pathogen.js、UserManagement.js |

### 1.8 `index.html` 主页面功能模块速查（v0.6 新增）

| 模块 ID | 功能名称 | 对应 JS 模块 |
|---------|---------|------------|
| `dashboard` | 实时数据概览 | `Dashboard.js` |
| `tableware` | 餐具洁净度检测 | `Tableware.js` |
| `pesticide` | 果蔬农残检测 | `GenericTest.js` |
| `oil` | 食用油品质检测 | `GenericTest.js` |
| `leanMeat` | 肉蛋农残检测 | `GenericTest.js` |
| `pathogen-test` | 食源性细菌/病毒检测 | `Pathogen.js` |
| `audit-log` | 操作审计日志 | `AuditLog.js` |
| `user-management` | 用户管理 | `UserManagement.js` |
| `guest-dashboard` | 访客中心 | `GuestDashboard.js` |
| `backup-restore` | 备份与恢复 | `BackupRestore.js` |

### 1.9 package.json 双文件架构说明（v0.8 新增）

> ⚠️ 项目存在两个 `package.json`，职责边界模糊，是历史遗留问题。

| 文件 | 定位 | 状态 |
|------|------|------|
| `/package.json`（根目录）| 原为前端工程工具配置容器（Webpack、Jest、Cypress）| ⚠️ **僵尸文件**：前端已改为原生 HTML，webpack 无用；缺少 `"type":"module"` 和 `prisma` 依赖；版本号 `3.1.0` 与后端不同步 |
| `/backend/package.json` | 后端 Node.js 运行时依赖 | ✅ **生产部署入口**：正确配置 `"type":"module"`、`prisma ^5.10.0`、`express ^4.22.1` 等 |

**演进路径**：项目早期前后端统一管理，后端独立到 `backend/` 后新建了自己的 `package.json`，根目录文件未随之清理，形成双文件并存的历史遗留状态。

**结论**：生产部署应始终在 `backend/` 目录下执行 `npm install` 和 `npm start`，根目录 `package.json` 需清理或明确标注用途（见 P0-10）。
