> 📎 本文件是 REVIEW_GUIDE 的子文件。索引见 [REVIEW_GUIDE.md](./REVIEW_GUIDE.md)
> **所属章节**：§3 修复执行进度看板
> **最后更新**：v0.40（2026-07-03 统一"已完成"判定标准（从宽口径）+ P1-28 计入完成 + 数字回填）｜对应 FIX_PLAN 版本：v1.18

---

## 修复执行进度

> **说明**：本章节记录基于 `docs/fix/FIX_PLAN.md` 的修复执行状态，由 Monica 在每批修复完成后同步更新。
> 最后同步时间：**2026-07-03**｜对应 FIX_PLAN 版本：**v1.18**

> **补丁登记（2026-06-30）**：P0-09b 闭环——3 条 POST 创建类写入路由补挂 `requireEditorOrAbove`，7 条写路由权限全覆盖。P0-09b 为 P0-09 补丁子项，P0 总数仍计 10 项，不破坏 62 题基线。详见 [FIX_P0-09b_postWriteGuard.md](../fix/P0/FIX_P0-09b_postWriteGuard.md)。

> **P1-06 闭环（2026-06-30）**：前端删除操作事件处理层补加双层权限拦截（按钮点击层 + 函数体纵深），清除"权限认证通过"误导性文案。前端为体验层防护，后端 `requireEditorOrAbove` 为真正安全边界。技术债 TD-06（本地 Storage 路径）登记待合并 P1-14 处理。详见 [FIX_P1-06_frontendPermission.md](../fix/P1/FIX_P1-06_frontendPermission.md)。

> **P1-07 闭环（2026-06-30）**：移除 `window.router` 冗余全局挂载（4 处赋值 + 4 处日志 + 3 处注释 + 空 if 块，共 14 行）。经核验 `window.router` 从未被读取调用，所有调用方通过 import 获取单例，移除后功能零影响。技术债 P2-10 登记（main.js 中 7 类其他全局挂载）。详见 [FIX_P1-07_windowRouterExposure.md](../fix/P1/FIX_P1-07_windowRouterExposure.md)。

> **P1-08 闭环（2026-06-30）**：`schema.prisma` L67 `TestRecord.created_user` 的 `onDelete: Cascade` 改为 `Restrict`，防止删用户时级联删除检测记录；`UserManager.deleteUser()` 添加前置 `testRecord.count` 检查，存在记录时抛出业务错误。技术债 TD-P2-11（软删除）、TD-P2-12（AuditLog 合规）登记。详见 [FIX_P1-08_cascadeDeleteRisk.md](../fix/P1/FIX_P1-08_cascadeDeleteRisk.md)。

> **P1-09 闭环（2026-06-30）**：核验确认存在 3 套审计日志机制（后端 DB 登录日志 / 后端 DB API 通用操作 / 前端 localStorage 离线日志），无同表重复写入，采用 C3 路径仅在 `server.js` 顶部登记技术债注释。技术债 TD-P2-13（统一审计接口设计）登记。详见 [FIX_P1-09_duplicateAuditLog.md](../fix/P1/FIX_P1-09_duplicateAuditLog.md)。

> **P1-10 闭环（2026-06-30）**：`PermissionService` 权限缓存添加 5 分钟 TTL（构造函数 `PERMISSION_CACHE_TTL`、读取过期检查、写入携带 `cachedAt` 时间戳），解决缓存永不失效。核验发现 `clearCache()` 依赖的 `permissionChanged` 事件全仓 0 派发，实为死代码；C2 主动清除因目标文件不在预检范围且架构上无法跨会话触达被变更用户客户端，未实施。技术债 TD-P2-14（Redis/LRU Cache 替代）、TD-P1-10a（permissionChanged 派发缺失）登记。详见 [FIX_P1-10_permissionCacheTTL.md](../fix/P1/FIX_P1-10_permissionCacheTTL.md)。

> **P1-11 闭环（2026-06-30）**：核验确认前端 `SessionManager.sessions` 为内存数组，但**已具备 TTL（30 分钟）与最大并发会话数（5）**，非"无过期机制"；后端认证为 JWT 无状态，重启不丢失登录态。硬编码 IP（后端 CORS fallback、前端 `LOCAL_API_URL`、`getClientIP` 模拟值）已通过 `CORS_ORIGIN` 环境变量 / `window.__API_BASE_URL` / 同源 fallback 管理，采用 C4 路径仅在 `SessionManager.js` 添加注释。技术债 TD-P2-15（Redis 会话存储迁移 + inactive 会话清理 + 后端 session API 实现）登记。详见 [FIX_P1-11_sessionMemoryAndHardcodedIP.md](../fix/P1/FIX_P1-11_sessionMemoryAndHardcodedIP.md)。

> **P1-12 闭环（2026-06-30）**：`backend/config/telemetry.js` 全部 8 个 `require()` 改为 `import`、`module.exports` 改为 `export default`，消除 CJS/ESM 不兼容（与项目 `type:module` 统一）。核验发现 `@opentelemetry/*` 7 个依赖从未安装、Jaeger/Prometheus 基础设施未部署，直接集成会导致 server.js 启动崩溃，故 server.js 集成（C2）deferred。技术债 TD-P2-16（OTel 完整集成：依赖安装 + 基础设施部署 + `--import` 启动方式）登记。详见 [FIX_P1-12_telemetryCommonJS.md](../fix/P1/FIX_P1-12_telemetryCommonJS.md)。

> **P1-13 闭环（2026-06-30）**：`backend/server.js` `parseAllowedOrigins()` fallback 列表移除硬编码生产 IP `159.75.106.179:8082`（保留 localhost 开发地址）；`.env.example` `CORS_ORIGIN` 补充生产 IP 示例。核验发现 `deploy/pm2/ecosystem.config.cjs` 硬编码 `CORS_ORIGIN: 'http://159.75.106.179:8081'`（端口 8081 与实际 8082 不一致）、`deploy/nginx` 配置硬编码生产 IP、`.env` 同时定义 `CORS_ORIGIN`（单数，已用）和 `CORS_ORIGINS`（复数，未用）。技术债 TD-P2-17（部署配置 IP 硬编码 + 无效 CORS_ORIGINS 复数配置清理）登记。详见 [FIX_P1-13_corsOrigin.md](../fix/P1/FIX_P1-13_corsOrigin.md)。

> **P1-14 闭环（2026-07-01）**：`js/core/Storage.js` 新增 `getAllFresh()` 异步方法，调用 `_syncFromApi(true)` 强制绕过 30 秒冷却并 `await` 等待同步完成后返回最新缓存。保留 `getAll()` 同步签名不变以兼容 ~30 处现有调用方（Pathogen / GenericTest / Tableware / Dashboard / ExportService），零崩溃风险。技术债 TD-P2-18（getAll() 调用方迁移至 getAllFresh() 评估）登记。详见 [FIX_P1-14_storageCache.md](../fix/P1/FIX_P1-14_storageCache.md)。

> **P1-15 闭环（2026-07-01）**：`backend/server.js` `POST /api/test-records` 补齐与 `POST /api/records/:tableName` 一致的幂等检查（`findUnique` 前置查询 + P2002 并发冲突幂等返回 + P2003 外键约束 422 处理），根治 P0-06 之后接口层未配套幂等检查导致的重复数据根因。P0-06 已从数据层（确定性 `record_code` + `@unique` 约束）阻止重复，本次补齐接口层幂等处理。技术债 TD-P2-19（两套创建接口入参结构不一致、跨接口幂等性统一）登记。详见 [FIX_P1-15_dedupeRoot.md](../fix/P1/FIX_P1-15_dedupeRoot.md)。

> **P1-16 闭环（2026-07-01）**：核验确认 `js/modules/BackupRestore.js` 已由先前重构提交（`fd84875` / `6144b6c` / `3a0f35a`）完全迁移至 `/api/records/*` 和 `/api/health` 端点，全文件无 `/api/sync` 调用，问题已由先前重构解决，代码无变更。`handleCloudRestore` → `GET /api/records/:tableName`；`uploadRestoredDataToServer` → `POST /api/records/:tableName/bulk-upsert`；`checkSyncStatus` → `GET /api/health`；bulk-upsert 响应解析与 server 返回结构匹配。技术债 TD-P2-20（`BackupRestore.js:505` temp-token- 死代码 + `OfflineModeManager.js:232` /api/sync 迁移评估）登记。详见 [FIX_P1-16_backupRestore.md](../fix/P1/FIX_P1-16_backupRestore.md)。

> **P1-17 闭环（2026-07-01）**：原描述"无二次确认/无后端权限校验"经核验已在前期工作中覆盖（前端已有 `confirm()`、后端已有 `authenticateUser + authorizeRoles`），按审阅方确认的扩展语义补齐三项纵深防护：① 后端 `userRoutes.js` DELETE 路由防止管理员删除自身账号；② 后端防止删除最后一个 active admin 导致系统锁死（`prisma.user.count` ≤ 1 拦截）；③ 前端 `UserManagement.js` `deleteUser()` 单步 `confirm()` 升级为两步确认并显示用户名。技术债 TD-P2-21（Modal 替代原生 confirm() 评估）登记。详见 [FIX_P1-17_userDeleteGuard.md](../fix/P1/FIX_P1-17_userDeleteGuard.md)。

> **P1-18 闭环（2026-07-01）**：`js/modules/Pathogen.js` `initPathogen()` 访客守卫由 `if (isGuest && !isQuickAccess)` 收紧为 `if (isGuest || isQuickAccess)`，拦截全部访客（含快速访问模式），不再为访客初始化病原体模块/加载数据/绑定事件，与权限矩阵 `guest` 角色无 `module:pathogen` 对齐。权限矩阵本身经核验正确（`PermissionService.js:57-63` 故意排除 `module:pathogen`），矛盾根因为守卫条件放行快速访问访客。技术债 TD-P2-22（`handleNavigation`/`UIHelper.setupNavigation` 导航层缺 `module:xxx` 权限校验，与 P1-06 CSS 绕过同源）登记。详见 [FIX_P1-18_pathogenGuestAccess.md](../fix/P1/FIX_P1-18_pathogenGuestAccess.md)。

> #### P1-02/03/04/05 闭环（补记，原提交 2026-06-30 `7f69286`）
> 
> 经2026-07-02复核确认，以下4项代码修复均已在 `7f69286`(fix(P1-02/03/04/05/19)) 中落地，此前RG_04遗漏为其建立独立闭环段落，现补记：
> - **P1-02**：idempotencyMiddleware.js 节流方案已落地（CLEANUP_INTERVAL/lastCleanupAt），Redis化仍为中期技术债
> - **P1-03**：UserManager.js registerUser() email字段已改为null，无虚假邮箱生成
> - **P1-04**：isStrongPassword()密码强度校验已在UserManager.js/userRoutes.js多处调用点落地
> - **P1-05**：/api/user/refresh-token接口已在前后端对齐（userRoutes.js/AuthService.js/ConfigManager.js）
> 
> 代码无变更，本次为文档闭环记录补齐。

> **P1-19 闭环（2026-07-01）**：核验确认 `js/core/AdaptiveUploadQueue.js` 指纹缓存淘汰策略已由 FIFO 固定上限改为 TTL 批量过期清理（`_cleanupExpiredFingerprints()` 遍历 Map 按 `_fingerprintTTL` 默认 60s 过期删除，`_markCompleted()` 调用 TTL 清理替代 `keys().next().value` FIFO 淘汰），代码修复由先前提交 `7f69286` 完成（`fix(P1-02/03/04/05/19)`），本次为文档闭环，代码无变更。技术债 TD-P2-23（`_maxFingerprintCache` 遗留配置项清理）登记。详见 [FIX_P1-19_fingerprintEvict.md](../fix/P1/FIX_P1-19_fingerprintEvict.md)。

> **P1-20 闭环（2026-07-01）**：`js/modules/Dashboard.js` 移除 `window.loadDashboardData` / `window.initDashboard` 全局挂载，改为 `dashboard:refresh` CustomEvent 监听；5 个 StorageService 的 sync 事件合并为 200ms 防抖刷新（原并发同步触发最多 5 次看板刷新）。`js/main.js` `handleNavigation()` 导航到看板时改为 `dispatchEvent(new CustomEvent('dashboard:refresh'))`。技术债 TD-P2-24（`SampleDataGenerator.js` L262 `window.loadDashboardData` 引用清理，有 `dataChanged` 事件后备无崩溃）登记。详见 [FIX_P1-20_dashboardGlobal.md](../fix/P1/FIX_P1-20_dashboardGlobal.md)。

> **P1-21 闭环（2026-07-01）**：`js/core/Auth.js` 类名 `Auth` → `OperationGuard`、单例 `auth` → `operationGuard`，消除与 `js/services/AuthService.js`（类 `AuthService`、单例 `authService`）的类名/单例名冲突。3 个消费方（Pathogen/GenericTest/Tableware）的 import 与 6 处 `verify()` 调用同步更新。代码修复由先前提交 `956e015` 完成，本次为文档闭环，代码无变更。技术债 TD-P2-25（`Auth.js` 文件名未跟随类名更新为 `OperationGuard.js`）登记。详见 [FIX_P1-21_authClassRename.md](../fix/P1/FIX_P1-21_authClassRename.md)。

> **P1-22 闭环（2026-07-01）**：`js/utils/SampleDataGenerator.js` 5 个 init 函数共 12 条示例数据 ID 由整数（1/2/3）改为 `temp_sample_{n}` 格式，兼容 `StorageService._isTempId()` 规则，避免同步合并阶段（`Storage.js` L246-261）整数 ID 记录被丢弃。未采用 `crypto.randomUUID()` 方案（UUID 不以 `temp_` 开头，同步时仍会被丢弃）。TD-P2-24 遗留死代码 `initDashboard()`（引用已移除的 `window.loadDashboardData`）一并清理。技术债 TD-P2-26（快速访问模式禁用同步的彻底方案评估）登记。详见 [FIX_P1-22_sampleDataId.md](../fix/P1/FIX_P1-22_sampleDataId.md)。

> **P1-23 闭环（2026-07-01）**：`backend/middleware/validationMiddleware.js` 的 `fieldValidators` 对象补充 `dateNotFuture` 与 `idCard` 两条验证器（`date` 之后），正则与前端 `FormValidator` 完全对齐，使后端规则集达到前端超集要求。核验发现 `fieldValidators`/`validateField` 全后端无路由调用方（`server.js:18` 仅导入 `createValidationMiddleware, rateLimit, sanitizeText`），实为死代码，本次仅补齐规则集，零行为影响。`dateNotFuture` 在前端被活跃使用（GenericTest.js:965、Tableware.js:650 的 testDate schema）。未采用"统一校验规则配置文件共享"方案（前端原生 JS 无构建步骤，共享模块引入成本高）。技术债 TD-P2-27（`validateField` 接入具体写入路由 + 参数化规则 `minLength`/`maxLength` 结构支持）登记。详见 [FIX_P1-23_validatorSync.md](../fix/P1/FIX_P1-23_validatorSync.md)。

> **P1-24 闭环（2026-07-01）**：`js/core/AdaptiveUploadQueue.js` 构造函数新增 `getBaseUrl` 回调选项（默认返回 `/api/records` 保持向后兼容），`_doRequest()` 四类 URL（POST/PUT/DELETE/fallback）前缀由硬编码 `/api/records/` 改为 `${this._getBaseUrl()}/`，跟随 `StorageService.apiBaseUrl` 配置；`js/core/Storage.js` 实例化 `AdaptiveUploadQueue` 时传入 `getBaseUrl: () => this.apiBaseUrl`。默认配置下拼接结果与原硬编码完全一致，行为零变化。技术债 TD-P2-28（`_fetchLatest()` 同样硬编码 `/api/records/`，本次仅按 RG_03b 明确范围修复 `_doRequest()`）登记。详见 [FIX_P1-24_uploadQueueBaseUrl.md](../fix/P1/FIX_P1-24_uploadQueueBaseUrl.md)。

> **P1-25 闭环（2026-07-01）**：`/package.json` 的 `cors`/`dotenv`/`express`/`jsonwebtoken` 4 项依赖版本对齐 `backend/package.json`（`^2.8.6`/`^16.6.1`/`^4.22.1`/`^9.0.2`），消除开发与生产环境版本漂移；`dev` 脚本由 `nodemon backend/server.js` 改为 `cd backend && npm run dev`，与 `start` 脚本模式一致，统一由 backend 承担启动逻辑，消除 `nodemon`/`node --watch` 混用；`package-lock.json` 经 `npm install --package-lock-only` 同步。`bcryptjs` 两端已一致未改。生产部署走 `backend/package.json`，本次未改 backend 清单，生产零影响。技术债 TD-P2-29（`nodemon` 未使用依赖 + `engines.node` 与 `node --watch` 要求不一致）登记。详见 [FIX_P1-25_packageVersionSync.md](../fix/P1/FIX_P1-25_packageVersionSync.md)。

> **P1-26 闭环（2026-07-01）**：通过生产部署脚本 `deploy.ps1` L107/L311-322 确认权威生产 `DATABASE_URL = file:D:/ZhuHaiYiZhong-data/zhuhaiyizhong.db`（物理路径 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`），部署脚本强制写入 `backend/.env`，`.env.example` L17 模板值与生产一致。REVIEW_GUIDE v0.7 记录（`D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`）经确认正确；`docs/` 系统文档（ARCHITECTURE/DATABASE_SCHEMA/DEPLOYMENT_GUIDE/README）记录的 `D:\珠海一中\foodtestlab.db` 为田家炳系统遗留错误路径，归 DOCS-01/02/03/04 系列统一修正。`RG_01_SYSTEM.md` §1.2 歧义说明已替换为确认结论。代码无变更（`schema.prisma`/`deploy.ps1`/`.env.example` 均已正确）。技术债 TD-P2-30（docs/ 系统文档路径统一）登记。详见 [FIX_P1-26_databasePathAmbiguity.md](../fix/P1/FIX_P1-26_databasePathAmbiguity.md)。

> **DOCS-01/02/03 闭环（2026-07-02）**：DOCS 系列文档批量修正（核实→修复→闭环）。
> - **DOCS-01**：`backend/README.md` 全文重写，移除 13 处 Supabase 引用，改为实际技术栈 Express + Prisma + SQLite + JWT(bcryptjs) + PM2；附带端口 `3000`→`3002` 同步（`server.js` L29 默认 3002）。
> - **DOCS-02**：`docs/API_REFERENCE.md` 4 处端口（L8/L9/L47/L1857）由 `3001`/`8081` 修正为 `3002`/`8082`，与 `deploy.ps1` L104-105、`server.js` L29 一致（正文既有示例已正确，仅头部元信息与 19.8 排查条目残留）。
> - **DOCS-03**：`docs/DATABASE_SCHEMA.md` 10 处路径（7 处 DB 路径 + 2 处备份目录 + 1 处备份命名）由 `D:\珠海一中\foodtestlab.db` 修正为 `D:\ZhuHaiYiZhong-data\zhuhaiyizhong.db`，权威来源 `deploy.ps1` L107/L311-312 重新核实确认。本项为 **TD-P2-30 部分完成**；`ARCHITECTURE.md`/`DEPLOYMENT_GUIDE.md`/`docs/README.md` 同类路径残留（50+ 处）已登记，留待 TD-P2-30 后续统一处理。
> - DOCS 进度 1/4 → 4/4（100%），合计 36/62 → 39/62（62.9%，验算：P0 10 + P1 25 + P2 0 + DOCS 4 = 39，39/62 = 62.9%）。
> 详见 [FIX_DOCS-01](../fix/DOCS/FIX_DOCS-01_backendReadme.md) / [FIX_DOCS-02](../fix/DOCS/FIX_DOCS-02_apiReference.md) / [FIX_DOCS-03](../fix/DOCS/FIX_DOCS-03_databaseSchema.md)。

> **P0-11 闭环（2026-07-02，v2）**：数据看板"合格率"统计缺陷——`String.includes('合格')` 未排除"不合格"子串包含，导致"不合格"记录被误判为合格，合格率虚高。v1 初版仅修复 5 处（`Dashboard.js` `getStats()` 2 处 / `index.html` 2 处代码块 / `ExportService.js` 1 处）；v2 经历史演变追溯发现遗漏 7 处（`Dashboard.js` `getLeanMeatStatsByType()` 1 处 + `calculateCanteenTrends()` 2 处 + `calculateCanteenPassRate()` 2 处 + `Tableware.js` 2 处），已全部补充修复，**共 12 处**。**⚠️ 历史影响面（按证据强度分级）**：确证段（2026-06-16 deploy.ps1 入库 ~ 2026-07-02，有明确生产部署配置证据，建议业务方核查此区间看板/报告）；推断段（2025-12-12 ~ 2026-06-16，仅间接证据，系统是否已实际投入使用未经证实，需业务方自行确认）。详见 [FIX_P0-11_passRateMisjudge.md](../fix/P0/FIX_P0-11_passRateMisjudge.md)。

> **TD-P2-31 登记（2026-07-02）**：docs/fix/ 历史空模板补充审计标注。范围：P0-06/07/08_storageHeaders + P1-01/06/07/08/09/10/11/17/18，共 12 处空模板文件已在顶部添加醒目标注（问题已通过其他文档路径闭环，保留文件作审计追溯）。P2 全部 20 项及 P0-01~05 因诚实标记待处理/已有闭环记录，排除在外；DOCS-01~04 经核实均有实质内容，非空模板。P0-06/P0-07 经代码级核实（`buildDeterministicRecordCode` 存在于 `server.js:213`、`/api/guest/quick-access` 端点存在于 `server.js:303`），与 FIX_PLAN 描述一致，维持现有标注。**状态：✅ 已完成（2026-07-02）**。

> **P1-27 闭环（2026-07-03）**：原 P1-01 重登记项，合并 3 个子问题全部修复。① 路由顺序：`auditRoutes.js` 中 `GET /stats/summary`、`DELETE /cleanup` 前移至 `GET /:logId` 之前；② 前后端 API 路径：前端 `getStats(date)` URL 从 `/stats/${date}` 改为 `/stats/summary`（date 转 query param），修正返回值字段 `data.stats`→`data.data`；后端新增 `GET /export` 路由返回 CSV；③ cleanup HTTP 方法：前端 `POST`→`DELETE`。**P2-15 随 P1-27 自动解决**。附加发现 `logOperation` 字段名不匹配（`table_name`/`record_id` vs 后端 `resource_type`/`resource_id`），登记为 P1-28。**里程碑（v0.40）：P1-27 闭环；P1-28 经 v0.40 确立"已完成"从宽口径判定标准后计入完成，P1 系列 27/27 全部完成（100%）。该表述成立的前提是 FIX_PLAN v1.18 已正式写入判定标准，不再是此前缺乏依据的庆祝性表述。**详见 [FIX_P1-27_auditRouteAndApiMismatch.md](../fix/P1/FIX_P1-27_auditRouteAndApiMismatch.md)。

> **P1-28 闭环（2026-07-03）**：`js/services/AuditLogService.js` 的 `logOperation()` 方法内部 body 字段名 `table_name`/`record_id` → `resource_type`/`resource_id` 对齐后端 `auditRoutes.js` POST / 解构；方法签名与 11 处调用方（Dashboard/Tableware/BackupRestore/Pathogen）零改动。后端校验确认 `resource_type`/`resource_id` 非必填，修复后不引入新的 400 错误；Prisma schema 字段名一致无需迁移。历史审计日志的此两列仍为 null（修复前产生），属已知限制不回填。**v0.40 口径统一**：依据 FIX_PLAN v1.18 正式确立的"已完成"从宽判定标准（代码修复已落地且通过静态验证即计为已完成，运行时验证为独立追踪维度），P1-28 状态从"🔄 已修复（待运行时验收）"改为"✅ 已完成"，P1 完成率 96.3%→100%（27/27），合计 42/68→43/68（63.2%）。运行时验证另行执行，若发现失败将按标准降级。详见 [FIX_P1-28_logOperationFieldMismatch.md](../fix/P1/FIX_P1-28_logOperationFieldMismatch.md)。

### 总体进度

| 类别 | 总数 | ✅ 已完成 | ⬜ 待处理 | 完成率 |
|------|------|----------|----------|--------|
| P0（安全/高危） | 11 | 11 | 0 | 100% |
| 🟡 P1 重要 | 27 | 27 | 0 | 100% ✅ |
| 🟢 P2 优化 | 26 | 1 | 25 | 3.8% |
| 📄 DOCS 文档 | 4 | 4 | 0 | 100% |
| **合计** | **68** | **43** | **25** | **63.2%** |

> ⚠️ **2026-07-02 纠错**：经复核确认 P1-01（auditRoutes.js 路由顺序）实际未修复（代码未调整，仅有空模板文档），此前统计的"P1 系列 26/26 (100%)"存在事实错误。**更正为 P1: 25/26（96.2%）**，62 题总进度基线由 36/62 更正为 **35/62（56.5%）**。P1-01 已重新登记为 P1-27（见 [FIX_P1-27_auditRouteAndApiMismatch.md](../fix/P1/FIX_P1-27_auditRouteAndApiMismatch.md)），一并纳入原路由顺序问题与新发现的前后端 API 路径不匹配问题。同时修正 DOCS 行：DOCS-04 已于同批次核验中确认闭环（1/4），此前更新P1行时未同步更新DOCS行，现补正。修正后合计 36/62（58.1%）与历史数字巧合相同，但构成已不同（P1真实96.2%+DOCS真实25%，而非此前P1虚报100%）。

### P0 高危问题修复状态（11 项）

| ID | 问题描述 | 预估工时 | 状态 | 完成日期 |
|----|---------|---------|------|---------|
| `P0-01` | syncRoutes.js 无认证 + 不操作DB + CommonJS 三重问题 | 4h | ✅ 已完成 | 2026-06-22 |
| `P0-02` | authenticateUser 中间件三处实现不一致 | 3h | ✅ 已完成 | 2026-06-22 |
| `P0-03` | JWT 密钥 fallback 为弱明文字符串 | 0.5h | ✅ 已完成 | 2026-06-22 |
| `P0-04` | POST /api/user/register 完全公开无需授权 | 0.5h | ✅ 已完成 | 2026-06-22 |
| `P0-05` | seed.js 初始密码明文写入公开仓库 | 1h | ✅ 已完成 | 2026-06-22 |
| `P0-06` | record_code 双重生成逻辑导致幂等性失效 | 3h | ✅ 已完成 | 2026-06-23 |
| `P0-07` | 快速访问模式完全绕过后端认证 | 4h | ✅ 已完成 | 2026-06-24 |
| `P0-08` | Storage.js temp-token- 前缀可被客户端伪造 | 1h | ✅ 已完成 | 2026-06-23 |
| `P0-09` | auth.verify() 对编辑操作完全不做权限校验 | 3h | ✅ 已完成 | 2026-06-24 |
| `P0-10` | 根目录 package.json 缺少 type:module 及 Prisma 依赖 | 1h | ✅ 已完成 | 2026-06-23 |
| `P0-11` | 合格率统计 `includes('合格')` 未排除"不合格"子串，"不合格"误判为合格 | 0.5h | ✅ 已完成 | 2026-07-02 |

- **当前阶段**：P0 全部完成（100%，11/11）✅
- **下一任务**：P1 阶段（见 FIX_PLAN.md → P1 节）
- **修复指令**：见 `docs/fix/FIX_PLAN.md` → P1 节

> P1 / P2 / DOCS 各项详情见 `docs/fix/FIX_PLAN.md` 对应章节。
