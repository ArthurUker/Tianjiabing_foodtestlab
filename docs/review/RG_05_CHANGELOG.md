> 📎 本文件是 REVIEW_GUIDE 的子文件。索引见 [REVIEW_GUIDE.md](./REVIEW_GUIDE.md)
> **所属章节**：§4 文档变更记录 + 附录
> **最后更新**：v0.28（2026-07-01）

---

## 7. 文档变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-06-22 | v0.1 | 初始创建，完成后端核心文件审阅 |
| 2026-06-22 | v0.2 | 新增 UserManager、idempotencyMiddleware、syncRoutes、AuthService、Router 审阅；问题总数 29 项 |
| 2026-06-22 | v0.3 | 补全完整目录树；新增 GuestAuthService、PermissionService、SessionManager、AuditLogger、NetworkHelper、main.js、seed.js、telemetry.js、.env.example 审阅；问题总数 39 项 |
| 2026-06-22 | v0.4 | 新增 Storage.js、AuditLogService、AuditLog、BackupRestore、UserManagement、ExportService、dedupe-test-records 审阅；问题总数 48 项 |
| 2026-06-22 | v0.5 | 新增 Auth.js、AdaptiveUploadQueue、Tableware、GenericTest、Pathogen、Dashboard、GuestDashboard 审阅；问题总数 56 项 |
| 2026-06-22 | v0.6 | 新增 pathogenRisk.js（✅正常）、FormValidator.js、SampleDataGenerator.js、UINotification.js（XSS风险）、UIHelper.js、index.html、login.html 审阅；核心文件覆盖率达 ~90%；新增 UINotification XSS（P2-18）、FormValidator 防护缺失（P2-20）、示例数据 ID 格式（P1-22）等；问题总数扩展至 62 项；建议转入修复方案输出阶段 |
| 2026-06-22 | v0.7 | 完整确认 Storage.js（_getHeaders 正常，P0-08 精确定位为 temp-token- 前缀伪造）和 AdaptiveUploadQueue.js（P1-19 淘汰策略确认为 FIFO）；新增 P1-24（_doRequest URL 硬编码）；问题总数 63 项 |
| 2026-06-22 | v0.8 | 新增 /package.json 和 backend/package.json 双文件审阅；确认 guest.html 文件不存在（404）；读取 docs/ 目录发现数据库路径歧义；新增 §1.9 双文件架构说明；新增 P0-10（根目录 package.json 启动崩溃风险）、P1-25（双 package.json 版本不同步）、P1-26（数据库路径歧义）、P2-21（Jest/ES Module 兼容性）、P2-22（Cypress 环境问题）；问题总数 63 → **68 项**；核心文件覆盖率 ~95%；建议正式转入修复阶段 |
| 2026-06-23 | v0.9 | P0-02 遗留补修（userRoutes.js 统一认证中间件）、P0-05 遗留补修（seed.js 移除 fallback 明文密码）核验通过；修复执行进度同步至 FIX_PLAN v1.5 |
| 2026-06-23 | v0.10 | P0-06（record_code 幂等性）、P0-08（temp-token- 前缀伪造）、P0-10（根目录 package.json）修复完成并核验通过；新增 §1.10 GitHub CDN 缓存问题解决方案（?t=时间戳强制回源）；修复执行进度同步至 FIX_PLAN v1.7；P0 完成率 80% |
| 2026-06-24 | v0.11 | P0-07 四端全链核验闭环；RG_03a 补充修复详情；RG_04 进度更新至 4/5；FIX_PLAN.md P0-09 修复指令完善；新增 AI 操作约束规则 |
| 2026-06-24 | v0.12 | P0-09 闭环：requireEditorOrAbove 中间件注入完成；P0 阶段 10/10 全部完成 |
| 2026-06-29 | v0.13 | P1-02/P1-04/P1-05 修复完成（幂等节流、密码强度、令牌续期）；P1-03/P1-19 修复完成（移除虚假邮箱、指纹缓存TTL清理）；FIX_PLAN 升至 v1.11 |
| 2026-06-30 | v0.14 | 文档基线校准：P0-09 状态修正、RG_04 P1 进度更新、6 个子文档补填 |
| 2026-06-30 | v0.15 | P0-09b 闭环：3 条 POST 写入路由补挂 requireEditorOrAbove，7 条写路由权限全覆盖；新建 FIX_P0-09b 子文档；FIX_P0-09 补记写操作语义区分；接受静态验证结论（运行时验证待补） |
| 2026-06-30 | v0.16 | P1-06 闭环：前端删除操作事件处理层双层权限拦截（按钮点击层 + 函数体纵深），清除"权限认证通过"误导性文案；新建 FIX_P1-06 子文档；技术债 TD-06 登记（本地 Storage 路径，合并 P1-14） |

## v0.17 — P1-07 闭环
- fix(P1-07): 移除 window.router 冗余全局挂载（7d14930）
- 删除 14 行冗余代码（4 处赋值 + 4 处日志 + 3 处注释 + 空 if 块）
- 技术债 TD-P2-10 登记：main.js 中 7 类 window.xxx 全局挂载

## v0.18 — P1-08 闭环
- fix(P1-08): schema.prisma L67 onDelete Cascade→Restrict（76e86ae）
- UserManager.deleteUser() 添加前置 testRecord.count 检查
- 技术债 TD-P2-11（软删除）、TD-P2-12（AuditLog合规）已登记

## v0.19 — P1-09 闭环
- fix(P1-09): 登记三套审计日志机制并存技术债TD-P2-13（cad5b7d）
- 核验确认 3 套机制（后端DB登录日志/后端DB API通用操作/前端localStorage离线日志），无同表重复写入，采用 C3 路径仅登记
- 技术债 TD-P2-13：统一审计日志接口设计已登记

## v0.20 — P1-10 闭环
- fix(P1-10): 权限缓存添加TTL(5min)过期机制，解决缓存永不失效（1b60d78）
- 核验发现 clearCache() 依赖的 permissionChanged 事件全仓 0 派发，实为死代码；C2 主动清除因目标文件不在预检范围且架构上无法跨会话触达，未实施
- 技术债 TD-P2-14：Redis/LRU Cache 替代方案已登记
- 技术债 TD-P1-10a：permissionChanged 事件派发缺失登记

## v0.21 — P1-11 闭环
- fix(P1-11): 会话内存存储TTL+硬编码IP修复（dd0ab57）
- 核验确认前端 SessionManager.sessions 为内存数组，但已有 TTL（30 分钟）+ 最大并发会话数（5），非"无过期机制"；后端 JWT 无状态，重启不丢失登录态
- 硬编码 IP（后端 CORS fallback / 前端 LOCAL_API_URL / getClientIP 模拟值）已通过 CORS_ORIGIN 环境变量 / window.__API_BASE_URL / 同源 fallback 管理，采用 C4 路径仅在 SessionManager.js 添加注释
- 技术债 TD-P2-15：Redis 会话存储迁移评估已登记（含 inactive 会话清理 + 后端 session API 实现 + 统一配置中心）

## v0.22 — P1-12 闭环
- fix(P1-12): telemetry.js ESM化，消除CJS/ESM不兼容（58f5a2d）
- 核验发现 @opentelemetry/* 7个依赖未安装，server.js 集成 deferred
- 技术债 TD-P2-16：OTel 完整集成（依赖安装 + 基础设施 + --import 启动方式）已登记

## v0.23 — P1-13 闭环
- fix(P1-13): 移除server.js硬编码生产IP，.env.example补充生产IP示例（f8cf588）
- `backend/server.js` `parseAllowedOrigins()` fallback 列表移除 `http://159.75.106.179:8082`（保留 localhost 开发地址）
- `.env.example` `CORS_ORIGIN` 补充生产 IP 示例，与 `.env` 运行时配置对齐
- 技术债 TD-P2-17：部署配置文件（pm2/nginx）硬编码生产 IP + `.env` 中 `CORS_ORIGINS`（复数）无效配置清理，已登记

## v0.24 — P1-14 闭环
- fix(P1-14): Storage新增getAllFresh强制同步方法，解决数据一致性无保障（9c9298d）
- `js/core/Storage.js` 新增 `getAllFresh()` 异步方法：`await _syncFromApi(true)` 绕过 30 秒冷却强制同步后返回最新缓存
- 保留 `getAll()` 同步签名不变以兼容 ~30 处现有调用方（Pathogen / GenericTest / Tableware / Dashboard / ExportService），零崩溃风险
- 技术债 TD-P2-18：`getAll()` 调用方迁移至 `await getAllFresh()` 评估（ExportService / Dashboard 首次加载 / 各模块查询入口），已登记

## v0.25 — P1-15 闭环
- fix(P1-15): /api/test-records 增加幂等检查与P2002/P2003处理，根治重复数据（e821296）
- `backend/server.js` `POST /api/test-records` 补齐 `findUnique` 前置幂等检查 + P2002 并发冲突幂等返回 + P2003 外键约束 422 处理，与 `POST /api/records/:tableName` 实现一致
- P0-06 已从数据层（确定性 `record_code` + `@unique` 约束）阻止重复，本次补齐接口层幂等处理，根治"重复数据根因未根治"
- 技术债 TD-P2-19：`POST /api/test-records` 与 `POST /api/records/:tableName` 两套创建接口入参结构不一致（结构化字段 vs 扁平 payload + `buildRecordWriteData`），`record_code` 哈希基础不同，跨接口幂等性统一待评估，已登记

## v0.26 — P1-16 闭环
- fix(P1-16): 代码无变更，BackupRestore.js 已由先前重构迁移至 /api/records/*（fd84875 / 6144b6c / 3a0f35a）
- 核验确认 `js/modules/BackupRestore.js` 全文件无 `/api/sync` 调用；`handleCloudRestore` → `GET /api/records/:tableName`；`uploadRestoredDataToServer` → `POST /api/records/:tableName/bulk-upsert`；`checkSyncStatus` → `GET /api/health`；bulk-upsert 响应解析与 server 返回结构匹配
- 技术债 TD-P2-20：① `BackupRestore.js:505` `token.startsWith('temp-token-')` 为 P0-08 后死代码（temp-token- 前缀已废弃），建议清理；② `OfflineModeManager.js:232` 仍调用 `/api/sync/${storeName}`，需评估迁移至 /api/records/* 或移除，已登记

## v0.27 — P1-17 闭环
- fix(P1-17): 删除用户防自删+防最后admin+前端两步确认（3bd9689）
- 后端 `backend/routes/userRoutes.js` DELETE 路由新增两项前置校验：① 防止管理员删除自身账号（`req.user.userId === req.params.userId` → 400）；② 防止删除最后一个 active admin 导致系统锁死（`prisma.user.count` ≤ 1 → 400）
- 前端 `js/modules/UserManagement.js` `deleteUser()` 原生单步 `confirm()` 升级为两步确认并显示被删用户名，降低误删风险
- 原描述"无二次确认/无后端权限校验"经核验已在前期工作中覆盖（前端已有 confirm、后端已有 authenticateUser+authorizeRoles），本次按扩展语义补齐纵深防护
- 技术债 TD-P2-21：评估将 UserManagement 删除操作升级为模态对话框（Modal）替代原生 confirm()，提升 UX 一致性，已登记

## v0.28 — P1-18 闭环
- fix(P1-18): Pathogen访客守卫收紧，拦截快速访问访客初始化病原体模块（a4aa276）
- `js/modules/Pathogen.js` `initPathogen()` 访客守卫由 `if (isGuest && !isQuickAccess)` 收紧为 `if (isGuest || isQuickAccess)`，拦截全部访客（含快速访问模式）
- 权限矩阵 `guest` 角色本身经核验正确（`PermissionService.js:57-63` 故意排除 `module:pathogen`），矛盾根因为守卫条件 `&& !isQuickAccess` 放行快速访问访客致其仍能初始化模块并加载数据
- 守卫命中后直接 return，跳过 `loadMammothJS()`/`renderTable()`/`storage.on('sync')` 等数据加载与事件绑定，从数据层阻断访客访问；admin/manager/operator/viewer 行为不变
- 技术债 TD-P2-22：`main.js handleNavigation()` 与 `UIHelper.setupNavigation()` 导航点击层缺 `module:xxx` 权限校验，访客可经 DevTools 取消隐藏后点击或控制台调用显示空白病原体区域（无数据），与 P1-06 CSS 绕过同源，建议导航层集中化权限拦截，已登记

## v0.29 — P1-19 闭环
- fix(P1-19): AdaptiveUploadQueue 指纹缓存 FIFO 淘汰改为 TTL 批量过期清理（7f69286，先前提交，本次文档闭环）
- 核验确认 `js/core/AdaptiveUploadQueue.js` `_markCompleted()` 已调用 `_cleanupExpiredFingerprints()` 按 `_fingerprintTTL`（默认 60s）批量清理过期指纹，替代原 `keys().next().value` FIFO 固定上限淘汰；`_isRecentlyCompleted()` 读取时同步触发清理
- 代码修复由先前合并提交 `7f69286`（`fix(P1-02/03/04/05/19)`）完成，本次为文档闭环，代码无变更
- 技术债 TD-P2-23：`_maxFingerprintCache`（默认 500）配置项在 P1-19 修复后不再参与淘汰决策，仅为遗留字段，建议后续清理移除，已登记
