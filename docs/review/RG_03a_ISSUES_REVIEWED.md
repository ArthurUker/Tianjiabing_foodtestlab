> 📎 本文件是 REVIEW_GUIDE 的子文件。索引见 [REVIEW_GUIDE.md](./REVIEW_GUIDE.md)
> **所属章节**：§2 已审阅文件清单 + §3 P0 问题详情
> **最后更新**：v0.10（2026-06-23）

---

## 2. 已审阅文件清单

| 文件 | 审阅状态 | 完整度 | 主要发现 |
|------|----------|--------|----------|
| `backend/server.js` | ✅ | ~80% | 双重 record_code 逻辑、硬编码 IP、弱密钥 fallback |
| `backend/prisma/schema.prisma` | ✅ | 100% | Cascade 删除风险、Guest 模型冗余 |
| `backend/routes/userRoutes.js` | ✅ | ~90% | 认证中间件重复定义、注册接口无保护 |
| `backend/routes/auditRoutes.js` | ✅ | ~90% | 路由注册顺序冲突、认证实现不一致 |
| `backend/routes/syncRoutes.js` | ✅ | ~85% | **严重：无认证、CommonJS、不操作数据库** |
| `backend/middleware/validationMiddleware.js` | ✅ | ~40% | escapeMap 编码疑似错误 |
| `backend/middleware/idempotencyMiddleware.js` | ✅ | 100% | 内存存储、PM2 重启后失效 |
| `backend/modules/UserManager.js` | ✅ | ~75% | 自动生成虚假 email、密码强度校验弱 |
| `backend/prisma/seed.js` | ✅ | 100% | **admin 密码 `8888` 明文写入公开仓库** |
| `backend/prisma/dedupe-test-records.js` | ✅ | 100% | 证实历史重复数据问题 |
| `backend/config/telemetry.js` | ✅ | 100% | CommonJS 语法、未集成到主进程 |
| `backend/package.json` | ✅ | 100% | ✅ 正确配置；依赖版本与根目录不同步（P1-25）|
| `/package.json`（根目录）| ✅ | 100% | ⚠️ 僵尸文件；缺少 `"type":"module"` 和 prisma（P0-10）；webpack 已无用 |
| `.env.example` | ✅ | 100% | JWT_SECRET 示例值为弱字符串 |
| `index.html` | ✅ | 100% | 主页面结构完整；模块 ID 与 JS 模块对应关系已梳理 |
| `login.html` | ✅ | 100% | **"以访客身份进入"按钮是 P0-07 快速访问的入口** |
| `guest.html` | ❌ | — | **文件不存在（404 已确认）** |
| `js/core/Auth.js` | ✅ | 100% | **与 AuthService.js 同名；编辑操作无权限校验** |
| `js/core/Router.js` | ✅ | ~85% | 权限控制仅靠 CSS 隐藏、全局暴露 window.router |
| `js/core/Storage.js` | ✅ | 100% | **v0.7 完整确认**：`_getHeaders()` 正常注入 Bearer Token；`_canSyncWithServer()` 存在 `temp-token-` 前缀伪造风险（P0-08 确认）|
| `js/core/AdaptiveUploadQueue.js` | ✅ | ~95% | **v0.7 完整确认**：指纹去重、自适应节流逻辑完整；`_doRequest()` URL 硬编码（P1-24 新增）；`_isRecentlyCompleted()` 末尾轻微截断，不影响逻辑 |
| `js/modules/AuditLog.js` | ✅ | ~70% | 正确通过 AuditLogService 查询后端 |
| `js/modules/BackupRestore.js` | ✅ | ~60% | 备份恢复依赖无效的 syncRoutes |
| `js/modules/Dashboard.js` | ✅ | ~70% | `loadDashboardData` 挂载到 `window` |
| `js/modules/GenericTest.js` | ✅ | ~60% | 通用检测基类；使用 `auth.verify()` |
| `js/modules/GuestDashboard.js` | ✅ | ~70% | 访客界面；快速访问模式标签 |
| `js/modules/Pathogen.js` | ✅ | ~65% | 快速访问模式下访客可访问病原体模块 |
| `js/modules/Tableware.js` | ✅ | ~65% | 使用 `auth.verify()` 做删除确认 |
| `js/modules/UserManagement.js` | ✅ | ~60% | 前端 CRUD 无二次权限校验 |
| `js/services/AuditLogService.js` | ✅ | 100% | 正确上报后端 `/api/audit-logs` |
| `js/services/AuthService.js` | ✅ | ~90% | Token 存 localStorage、refreshToken 后端未实现 |
| `js/services/ExportService.js` | ✅ | ~60% | 依赖 StorageService 本地缓存导出 |
| `js/services/GuestAuthService.js` | ✅ | 100% | 快速访问模式绕过认证 |
| `js/services/PermissionService.js` | ✅ | ~80% | 权限缓存不失效、异步/同步混用 |
| `js/services/SessionManager.js` | ✅ | ~70% | 会话全存内存、IP 硬编码 |
| `js/utils/AuditLogger.js` | ✅ | 100% | 仅写 localStorage，不上报后端 |
| `js/utils/FormValidator.js` | ✅ | ~90% | 规则库完整；**缺少 XSS/注入防护规则；与后端校验不同步** |
| `js/utils/NetworkHelper.js` | ✅ | ~90% | 网络检查 URL 硬编码 Google |
| `js/utils/pathogenRisk.js` | ✅ | 100% | ✅ 逻辑正常；Ct 值四级风险分级；有学术引用 |
| `js/utils/SampleDataGenerator.js` | ✅ | ~80% | **示例数据 ID 为整数，与 StorageService tempId 格式不一致** |
| `js/utils/UIHelper.js` | ✅ | 100% | 导航切换逻辑简单；无安全问题 |
| `js/utils/UINotification.js` | ✅ | ~90% | **`innerHTML` 直接插入 message，存在 XSS 风险** |
| `js/main.js` | ✅ | ~50% | 大量 window.* 全局暴露 |
| `docs/` 目录 | ✅ | 部分 | 数据库路径与本文档记录不一致（P1-26）|
| `[工程配置文件]` | ❌ | — | `.babelrc`、`webpack.config.js` 等未读取（优先级低）|

---

## 3. 已发现问题清单（完整版 v0.8）

### 🔴 P0 — 高危问题（建议 1~3 天内处理）

#### P0-01：`syncRoutes.js` 三重严重问题并发
- **位置**：`backend/routes/syncRoutes.js`
- **问题**：① 无认证保护；② 不操作数据库（伪同步）；③ CommonJS 语法在 ES Module 项目中运行时崩溃
- **修复建议**：改写为 ES Module、添加认证中间件、接入 Prisma

#### P0-02：`authenticateUser` 中间件三处实现不一致
- **位置**：`server.js`、`userRoutes.js`、`auditRoutes.js`
- **问题**：挂载字段名不同（`req.userId`/`req.userRole` vs `req.user` 对象），下游混用导致 `undefined`
- **修复建议**：抽取为独立 `middleware/authMiddleware.js`，统一导出

#### P0-03：JWT 密钥 fallback 为弱明文字符串
- **位置**：`backend/server.js`
- **修复建议**：未配置时 `process.exit(1)`，拒绝启动

#### P0-04：`POST /api/user/register` 完全公开，无需授权
- **位置**：`backend/routes/userRoutes.js`
- **修复建议**：添加 `authenticateUser` + `authorizeAdmin` 中间件

#### P0-05：`seed.js` 初始管理员密码 `8888` 明文写入公开 GitHub 仓库
- **位置**：`backend/prisma/seed.js`
- **问题**：`admin/8888`、`operator/operator123`、`viewer/viewer123` 均已公开
- **修复建议**：通过环境变量注入初始密码；**立即在生产环境修改所有账号密码**

#### P0-06：`record_code` 双重生成逻辑并存，幂等性失效
- **位置**：`backend/server.js`
- **关联**：`dedupe-test-records.js` 证实此问题已在生产环境发生
- **修复建议**：统一使用 `buildDeterministicRecordCode()`；数据库层对 `record_code` 添加 `@unique` 约束

#### P0-07：快速访问模式（Quick Access）完全绕过认证
- **位置**：`js/services/GuestAuthService.js` + `login.html`（入口按钮）
- **问题**：`login.html` 中"以访客身份进入"按钮直接触发快速访问；Token 为本地伪随机字符串，后端从不验证
- **修复建议**：快速访问必须经后端签发临时 Token，或完全移除此功能；至少在 `login.html` 中添加明确的权限说明

#### P0-08：`Storage.js` `_canSyncWithServer()` 的 `temp-token-` 前缀校验可被客户端伪造
- **位置**：`js/core/Storage.js`，`_canSyncWithServer()` 方法
- **v0.7 确认**：`_getHeaders()` 实现完整正常（`Authorization: Bearer <token>`，管理员 `auth_token` 优先，fallback `guest_token`）；真实问题在于 `_canSyncWithServer()` 通过 `token.startsWith('temp-token-')` 判断是否允许同步，该前缀字符串可由客户端任意伪造，无服务端验证
- **风险**：攻击者构造 `temp-token-` 开头的伪造 Token，可绕过同步阻断逻辑，触发未经授权的数据上传
- **修复建议**：移除前缀字符串判断；改为向后端 `/api/user/verify-token` 发起验证请求，或依赖后端 401 响应作为唯一阻断机制

#### P0-09：`js/core/Auth.js` 的 `auth.verify()` 对编辑操作完全不做权限校验
- **位置**：`js/core/Auth.js`，`verify()` 方法；被 Tableware、GenericTest、Pathogen、UserManagement 调用
- **问题**：仅当操作名包含"删除"时弹 `confirm()`；编辑操作直接执行回调，`viewer` 角色可随意编辑数据
- **修复建议**：`verify()` 中增加 `permissionService.hasPermission()` 校验；后端 PUT 接口同时校验操作者权限

#### P0-10：根目录 `package.json` 缺少 `"type": "module"` 且无 Prisma 依赖，生产部署存在启动崩溃风险（v0.8 新增）
- **位置**：`/package.json`（根目录）
- **问题**：
  - 缺少 `"type": "module"`，在根目录执行 `npm start` 时 Node.js 以 CommonJS 解析 ES Module 代码，直接崩溃
  - 完全缺少 `prisma` 和 `@prisma/client` 依赖，根目录 `npm install` 后无法运行数据库操作
  - `webpack` 依赖已无用（前端已改为原生 HTML），增加无效安装体积
- **修复建议**：明确根目录 `package.json` 定位为工程工具配置，`start` 脚本改为 `cd backend && npm start`；清理无用的 `webpack` 依赖；在 `README` 中明确标注两个 `package.json` 的职责边界
