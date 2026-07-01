> 📎 本文件是 REVIEW_GUIDE 的子文件。索引见 [REVIEW_GUIDE.md](./REVIEW_GUIDE.md)
> **所属章节**：§3 修复执行进度看板
> **最后更新**：v0.29（2026-07-01）｜对应 FIX_PLAN 版本：v1.12

---

## 修复执行进度

> **说明**：本章节记录基于 `docs/fix/FIX_PLAN.md` 的修复执行状态，由 Monica 在每批修复完成后同步更新。
> 最后同步时间：**2026-06-30**｜对应 FIX_PLAN 版本：**v1.12**

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

> **P1-19 闭环（2026-07-01）**：核验确认 `js/core/AdaptiveUploadQueue.js` 指纹缓存淘汰策略已由 FIFO 固定上限改为 TTL 批量过期清理（`_cleanupExpiredFingerprints()` 遍历 Map 按 `_fingerprintTTL` 默认 60s 过期删除，`_markCompleted()` 调用 TTL 清理替代 `keys().next().value` FIFO 淘汰），代码修复由先前提交 `7f69286` 完成（`fix(P1-02/03/04/05/19)`），本次为文档闭环，代码无变更。技术债 TD-P2-23（`_maxFingerprintCache` 遗留配置项清理）登记。详见 [FIX_P1-19_fingerprintEvict.md](../fix/P1/FIX_P1-19_fingerprintEvict.md)。

### 总体进度

| 类别 | 总数 | ✅ 已完成 | ⬜ 待处理 | 完成率 |
|------|------|----------|----------|--------|
| P0（安全/高危） | 10 | 10 | 0 | 100% |
| 🟡 P1 重要 | 26 | 19 | 7 | 73.1% |
| 🟢 P2 优化 | 22 | 0 | 22 | 0% |
| 📄 DOCS 文档 | 4 | 0 | 4 | 0% |
| **合计** | **62** | **29** | **33** | **46.8%** |

### P0 高危问题修复状态（10 项）

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

- **当前阶段**：P0 全部完成（100%，10/10）✅
- **下一任务**：P1 阶段（见 FIX_PLAN.md → P1 节）
- **修复指令**：见 `docs/fix/FIX_PLAN.md` → P1 节

> P1 / P2 / DOCS 各项详情见 `docs/fix/FIX_PLAN.md` 对应章节。
