> 📎 本文件是 REVIEW_GUIDE 的子文件。索引见 [REVIEW_GUIDE.md](./REVIEW_GUIDE.md)
> **所属章节**：§3 P1 重要问题详情
> **最后更新**：v0.10（2026-06-23）

---

## 3. 已发现问题清单（续）

### 🟠 P1 — 重要问题（建议 1 周内处理）

#### P1-01：`auditRoutes.js` 路由注册顺序冲突
- **修复建议**：静态路由移到动态参数路由之前

#### P1-02：`idempotencyMiddleware` 使用内存存储，PM2 重启后全部失效
- **修复建议**：中期替换为 Redis；短期对 `cleanup` 加节流

#### P1-03：`UserManager.registerUser()` 自动生成虚假 email
- **修复建议**：注册时不自动生成 `@foodlab.local` 邮箱

#### P1-04：密码强度校验过弱（仅 `length >= 6`）
- **修复建议**：最小长度 8 位，要求包含数字和字母

#### P1-05：`AuthService.refreshToken()` 调用后端不存在的接口 `/api/auth/refresh`
- **修复建议**：后端实现接口，或前端移除 refresh 逻辑

#### P1-06：前端权限控制完全依赖 CSS `hidden` 类，可被 DevTools 绕过
- **修复建议**：所有敏感操作必须在后端 API 层进行权限校验

#### P1-07：`Router.js` 将自身暴露到 `window.router` 全局作用域
- **修复建议**：移除 `window.router = this`，改用模块化导出

#### P1-08：`TestRecord` 的 `onDelete: Cascade` 可能导致检测数据意外丢失
- **修复建议**：改为 `onDelete: Restrict` 或 `SetNull`

#### P1-09：系统存在两套并行审计日志机制，职责边界混乱
- **位置**：`js/utils/AuditLogger.js`（仅写 localStorage）vs `js/services/AuditLogService.js`（正确上报后端）
- **修复建议**：统一使用 `AuditLogService.logOperation()` 作为唯一审计入口；废弃 `AuditLogger.js` 的 localStorage 写入

#### P1-10：`PermissionService` 权限缓存永不失效
- **修复建议**：在 login/logout 时调用 `permissionCache.clear()`；修复异步/同步混用逻辑

#### P1-11：`SessionManager` 会话全存内存，IP 硬编码，`syncToBackend` 调用未知接口
- **修复建议**：会话信息存储后端；真实 IP 从后端获取；确认 syncToBackend 目标接口

#### P1-12：`telemetry.js` 使用 CommonJS，且未集成到主进程
- **修复建议**：改写为 ES Module 或重命名 `.cjs`；确认是否需要启用监控

#### P1-13：`CORS_ORIGIN` 在 `.env.example` 中未包含生产 IP，与 `server.js` 硬编码不一致
- **修复建议**：`.env.example` 补充生产 IP 示例；`server.js` 移除所有硬编码 IP

#### P1-14：`Storage.js` 的 `getAll()` 优先返回本地缓存，数据一致性无保障
- **修复建议**：增加缓存时效标记；导出前强制触发同步并等待完成

#### P1-15：`dedupe-test-records.js` 证实生产环境曾出现大量重复数据，根因未根治
- **修复建议**：根治 P0-06；数据库层对 `record_code` 添加 `@unique` 约束

#### P1-16：`BackupRestore.js` 的备份/恢复操作依赖无效的 `syncRoutes`
- **修复建议**：待 P0-01 修复后，同步更新 BackupRestore 的调用逻辑

#### P1-17：`UserManagement.js` 前端删除操作无二次确认，且无后端权限二次校验
- **修复建议**：添加确认弹窗；后端 `DELETE /api/user/:id` 必须校验调用者角色

#### P1-18：`Pathogen.js` 快速访问模式下访客可访问病原体检测模块，与权限矩阵矛盾
- **修复建议**：将权限检查改为 `if (isGuest || isQuickAccess) { return; }`

#### P1-19：`AdaptiveUploadQueue` 的 `_completedFingerprints` 缓存上限 500 条，淘汰策略为 FIFO
- **v0.7 确认**：`_markCompleted()` 中当缓存达到 `_maxFingerprintCache`（500）上限时，通过 `this._completedFingerprints.keys().next().value` 取出 Map 中最旧的键并删除，为**FIFO 策略**（非 LRU）；在高频写入场景下，最近完成的指纹可能因 FIFO 淘汰而被重新入队，导致重复上传
- **修复建议**：改为按 TTL（`_fingerprintTTL`，默认 60s）批量清理过期条目，替代固定上限 FIFO 淘汰

#### P1-20：`Dashboard.js` 将 `loadDashboardData` 挂载到 `window` 全局，且实例化 5 个 StorageService
- **修复建议**：使用 `CustomEvent` 替代全局函数；合并多个 StorageService 的同步请求

#### P1-21：`js/core/Auth.js` 与 `js/services/AuthService.js` 类名冲突，极易引发维护错误
- **修复建议**：将 `js/core/Auth.js` 中的类重命名为 `OperationGuard`，导出单例改名为 `operationGuard`

#### P1-22：`SampleDataGenerator.js` 示例数据 ID 为简单整数，与 `StorageService` 格式不一致，可能引发同步混乱
- **位置**：`js/utils/SampleDataGenerator.js`
- **问题**：
  - 示例数据使用 `id: 1`、`id: 2`、`id: 3` 等简单整数
  - `StorageService.save()` 生成的 tempId 格式为 `temp_{timestamp}_{random}`，服务端 ID 为 `cuid()`
  - 整数 ID 与两种格式均不兼容，若 `StorageService` 的 `update()` / `delete()` 方法按 ID 查找记录，示例数据可能无法被正确操作
  - 示例数据写入 `localStorage` 后，`StorageService._syncFromApi()` 会尝试与服务端同步，但整数 ID 在服务端不存在，可能触发错误
- **修复建议**：示例数据 ID 改用 `crypto.randomUUID()` 或 `temp_sample_{n}` 格式；或在快速访问模式下完全禁用同步

#### P1-23：`FormValidator.js` 前端校验规则与后端 `validationMiddleware.js` 不同步
- **位置**：`js/utils/FormValidator.js` vs `backend/middleware/validationMiddleware.js`
- **问题**：
  - 前端 `FormValidator` 有 `phone`（中国手机号正则）、`idCard`、`dateNotFuture` 等规则
  - 后端 `validationMiddleware` 的规则集未完整读取（~40%），无法确认是否覆盖相同字段
  - 若两端校验规则不一致，攻击者可绕过前端校验直接向后端发送非法数据
- **修复建议**：建立统一的校验规则配置文件，前后端共享；或至少确保后端校验是前端的超集

#### P1-24：`AdaptiveUploadQueue._doRequest()` URL 硬编码，绕过 `StorageService` 的 `apiBaseUrl` 配置（v0.7 新增）
- **位置**：`js/core/AdaptiveUploadQueue.js`，`_doRequest()` 方法
- **问题**：`_doRequest()` 中所有请求 URL 均硬编码为 `/api/records/${item.collection}`，完全忽略 `StorageService` 构造时通过 `getHeaders` 回调传入的 `apiBaseUrl` 配置；若未来 API 前缀变更或需要多环境部署，`AdaptiveUploadQueue` 的请求将无法跟随配置变更
- **修复建议**：在 `AdaptiveUploadQueue` 构造函数中新增 `getBaseUrl` 回调选项，`StorageService` 初始化时传入 `() => this.apiBaseUrl`；`_doRequest()` 改为 `` `${this._getBaseUrl()}/${item.collection}` ``

#### P1-25：两套 `package.json` 依赖版本不同步，开发与生产环境行为存在差异（v0.8 新增）
- **位置**：`/package.json` vs `backend/package.json`
- **问题**：`express`（`^4.18.2` vs `^4.22.1`）、`dotenv`（`^16.0.3` vs `^16.6.1`）、`cors`（`^2.8.5` vs `^2.8.6`）、`jsonwebtoken`（`^9.0.0` vs `^9.0.2`）版本均存在差异；`nodemon` 与 `node --watch` 混用
- **修复建议**：统一依赖版本；明确 `backend/package.json` 为唯一生产部署入口

#### P1-26：生产数据库路径在 `docs/` 文档与本文档记录不一致（v0.8 新增）
- **位置**：`docs/` 系统文档 vs 本文档 §1.2
- **`docs/` 记录**：`D:\珠海一中\foodtestlab.db`
- **本文档 v0.7 记录**：`D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`
- **风险**：若 `.env` 中 `DATABASE_URL` 配置了错误路径，Prisma 将无法找到数据库文件，系统完全无法读写数据
- **修复建议**：**立即确认生产服务器 `.env` 中的 `DATABASE_URL` 实际值**，并统一所有文档记录
