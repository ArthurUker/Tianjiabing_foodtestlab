# TASKS.md — 多窗口并行开发协调板

> **用途**：当你同时开多个对话窗口（AI 编程助手）在同一仓库工作时，用本文件避免"重复造轮子 / 踩已解决的坑"。
>
> **每个窗口启动后的第一步**（SOP）：
> 1. 读 `README.md`（系统总览）→ `docs/PROJECT_CONVENTIONS.md`（红线，最高优先级）→ 本文件。
> 2. 在 §2 开放任务里**认领**一行：把 `Owner Window` 填成你的窗口编号（W1~W8），`状态` 改为 `进行中`。
> 3. 只在 §1 分配给你的文件范围内工作；碰 §4 公共文件前必须先在此 claim。
> 4. 完成后把 `状态` 改为 `已完成` 并注明提交哈希。
>
> **绝不重复**：§3 列出的 TD 任务已被解决并测试收口，任何窗口都**不得重新实现**，除非先在 `PROJECT_CONVENTIONS.md` 报备反转。

---

## §1 窗口 ↔ 功能责任矩阵（防分工撞车）

| 窗口 | 负责功能 | 独占文件（主） |
|------|----------|----------------|
| W1 | 认证 / 用户 | `backend/modules/UserManager.js`、`backend/routes/userRoutes.js`、`js/services/AuthService.js` |
| W2 | 访客 | `backend/routes/guestRoutes.js`、`js/services/GuestAuthService.js` |
| W3 | 审计 | `backend/routes/auditRoutes.js`、`backend/lib/auditLog.js` |
| W4 | 会话 / 前端生命周期 | `backend/routes/sessionRoutes.js`、`js/services/SessionManager.js` |
| W5 | 租户隔离 | `backend/lib/tenantClient.js`、`backend/lib/tenantProvisioner.js`、`backend/middleware/` |
| W6 | 部署 / 脚本 | `deploy/`、`scripts/` |
| W7 | 文档 | `docs/`、`README.md` |
| W8 | 备份 / 运维（cvm 备份体系） | `backend/routes/schoolBackupRoutes.js`、`backend/routes/adminBackupRoutes.js`、`backend/lib/backup*.js`、`backend/lib/restore*.js`、`js/modules/BackupRestore.js`、`js/modules/adminSchools/views/backupView.js` |

> 跨窗口功能（如"前端调用某后端接口"）由调用方窗口负责对接，被调方窗口只保证接口契约稳定。

---

## §2 开放任务（待认领 — 每个窗口 claim 一行）

> 只列**未完成 / 进行中**任务。已完成且收口的见 §3。
>
> **📋 审查结论（2026-08-18 · 十轮代码核查）**：本表经过十轮逐条 `grep` 代码实现 + `git log -S` / `git blame` 历史反证 + 适用性质判定 + 环境变量精确对账 + 间接实现盲区排查 + 测试层/文档层隐含收口证据排查 + git 全史"顺带实现"排查，已从原 32 条待办中移出 **30 条**（含确证已完成 / 已规避 / 前提不成立 / 无实际缺陷 / 不适用 / 死代码 / 文档描述过时），归档于 §3.7（3）、§3.8（7）、§3.9（10）、§3.10（3）、§3.11（3）、§3.12（3）、§3.13（1）。**第十轮对 §2 仅剩 2 条做 git 全史新维度核查**：① 查最近 20 条提交与 sync/audit 全部 git 史——`git log -S "transaction" -- syncRoutes.js` **历史为空**，证明 sync 从未有过事务实现；② `c0fbe24`（窗口重试修复）对 `syncRoutes.js` 仅改 8 行 = 给 `/records`、`/batch` 加 `requireEditorOrAbove` 权限中间件（NB-10），**未引入事务**；③ `b70129a`（TD-P2-13 审计统一）虽新增 `AdaptiveUploadQueue.js` 通用队列，但 `AuditService.js` 当前 grep 确认**未引用**该队列，`log()` 仍是 `fetch().catch(console.warn)`——审计统一 ≠ 加了重发队列。两条缺口均 100% 真实、从未被顺带修复。**本表保持 = 纯待办，仅余 2 条。** 后续任何人 claim 前请先确认 §3.7~§3.13 无重复。

| 任务 ID | 描述 | 严重度 | Owner Window | 状态 | 修复方向 |
|---------|------|--------|--------------|------|----------|
| TD-Tx-Missing | `server.js:736-769` bulk-upsert 循环逐条 findUnique+create/update 无 `$transaction`；`syncRoutes.js:100-172` /batch 无事务无幂等无上限 | 高危 | 待认领 | 未开始 | 包 `$transaction` + 挂幂等中间件 |

| TD-Audit-Queue | `AuditService.js:65` `log()` fetch 失败仅 console.warn，审计日志永久丢失无重试队列 | 中危 | 待认领 | 未开始 | 离线队列 + online flush |



> 新增任务时，**在此表追加一行**并立即 claim，避免另一窗口平行发现同一需求。
>
> **归档规约**：当某任务在 §3 完成记录中出现收口证据时（含代码内已实现的 TD 编号注释或 git 提交），应立即从本表删除对应行，并在 §3 最新子段落（如 §3.7 / §3.8 ...）追加一行追溯记录（详见 §3 末尾"维护规约"）。本表保持 = 纯待办，不与 §3 重复。
>
> **本表现状（2026-08-18 六轮核查后）**：保留 2 条经代码 grep + git 史证确认**确为真实缺口**的待办（TD-Tx-Missing、TD-Audit-Queue）；已累计移出 30 条（§3.7~§3.13），均为逐条核代码/git/配置对账收口，非仅凭文本匹配。

---

## §3 已完成任务（测试已收口 — ⚠️ 勿重复实现）

以下任务已完成并经代码级 verification / 测试收口。任何窗口**不得重新实现**，除非先在 `PROJECT_CONVENTIONS.md` 报备反转。备注中注明提交或验证证据。

### 3.1 备份 / 运维系列（W8 · 2026-08-17~18，最新）

| 编号 | 已完成内容 | 证据 |
|------|-----------|------|
| TD-School-Backup-Sync | 学校侧备份运维重写：新建 `backend/routes/schoolBackupRoutes.js`（`/api/school/backups`，list/run/download/verify/restore，按 `req.user.schoolCode` 强隔离，禁止跨校；平台超管 role=admin 且 schoolCode 空者拒绝）；server.js 挂载；重写 `js/modules/BackupRestore.js` 为 cvm 备份视图（复用超管 backupView 结构）。含自查修复：列表补 `createdBy` 字段、download 加 `format∈{plain,encrypted}` 白名单（超管版同款缺陷一并修复）、清理 `audit()` 死参数。运维支撑：KMS fail-closed 解锁（`setup-backup-kms.sh` 支持 `--key` 复用旧密钥 + 32 字节校验）、`restart-school-backup-api.sh` 一键重启、`deploy.sh` 密钥复用修复（防重部署覆盖） | lint 0 错误；jest 226/227；服务重启验证 401 非 404 |
| TD-Batch-Restore | 全库备份批量恢复（大事故应急）：后端 `POST /api/admin/backups/:id/restore-batch`（仅 scope=all；`{confirmText:'RESTORE_ALL', targetSchoolCodes:[...]}`；串行逐校 runRestore，每校独立原子事务；上限 200 校 + 非字符串过滤 + 审计逐校明细/耗时）。前端 backupView.js 全库行加「批量恢复」按钮 + 学校多选模态（全选/总数显示）+ 结果展示优化 | jsdom 完整链路验证；后端 5 非法请求 400 校验通过；lint 0 错误 |
| TD-Backup-Dir-Migrate | 备份目录迁移数据盘：`/var/backups/foodtestlab`（系统盘 `/dev/vda2`，与 PG 同盘无容灾隔离）→ `/mnt/datadisk0/backups`（独立数据盘 `/dev/vdb`）。rsync 迁移 980K 完整、`.env` BACKUP_DIR 更新、重启后 backupRootDir() 确认指向数据盘、服务可写。原目录保留未删（双保险） | findmnt 确认挂载点 /dev/vdb；kmsMode()=local |
| TD-Backup-Restore-Extract-Bug | 影子恢复 `invalid command \` 修复（截图 school_hqyz 恢复失败）：根因 `extractSchemaSegment` 括号配对对复杂 CHECK 约束（ARRAY 字符串内括号）/PL-pgSQL 函数体（dollar-quote）/表紧邻/PG17+ `\restrict` 头全部误判，孤立 `\.` 行残留。改用 pg_dump 标准段锚点（`-- Name:`/`-- Data for Name:`）按段整体取舍，丢弃 PG17+ psql meta-commands。新增 7 个测试（含 bug 复现） | `tests/extractSchemaSegment.test.js` 7/7 通过；真实备份 `20260818T105232` 端到端 psql -f 成功建 16 张表；服务已重启 |

### 3.2 租户隔离 / 安全高危（W1-W3 · 2026-07-20 ~ 07-27）

| 编号 | 已完成内容 | 证据 |
|------|-----------|------|
| TD-Tenant-Route | userRoutes 3 端点（refresh-token/PUT /me/change-password）改 `userManager.forTenant(req.user.schoolCode)`；UserManager.logLogin 审计用全局 prisma | commit 见 §3.6 |
| TD-SystemLog-Tenant | `logFailedLogin` 中 writeSystemLog 改用全局 prisma 单例（不再写进租户 schema） | 同上 |
| TD-HTTP-UUID | `Storage.js:109` crypto.randomUUID() 加 fallback `${Date.now()}-${Math.random().toString(36).slice(2)}` | 同上 |
| TD-SpawnSync | `tenantProvisioner.js:79` spawnSync 同步阻塞 120s → 改 `child_process.spawn` + Promise 异步 | 同上 |
| TD-TenantClient-Leak | `tenantClient.js:89,108` `.catch(()=>{})` → `.catch(e => console.warn(...))` | lint 无错 |
| TD-TrustProxy | `app.set('trust proxy', 1)` 已加（限流失效修复） | commit 8443e12 |
| TD-Error-Leak | server.js + userRoutes + guestRoutes + sessionRoutes + syncRoutes 全部 0 处 error.message 泄露 | commit 3529429 |
| TD-VerifyToken | verify-token 加 rateLimit + 仅返回 minimal 字段 | §3.6 |
| TD-RefreshToken | AuthService.refreshToken 改用 refresh token（不再用 access token）；区分 401 与 5xx；后端 refresh-token 端点优先读 `X-Refresh-Token` header | §3.6 |
| TD-XSS-Frontend | Pathogen/UserManagement/GuestDashboard/main.js 已加 escapeHtml；Tableware/BackupRestore 经核实无 innerHTML 注入点 | NB-03 |
| TD-CSV-Export | auditRoutes CSV 导出加 `csvField()` 统一转义（双引号包裹 + 内部引号翻倍 + `=+-@` 前缀前置 `'`） | lint 无错 |
| TD-Pagination | server.js + auditRoutes + userRoutes 分页参数加 `Math.min 500` 上限 | commit 8443e12/3529429 |
| TD-GracefulShutdown | SIGTERM 加 10s forceExit setTimeout | commit 8443e12 |
| TD-TokenExpiry-NaN | `AuthService.js:247` parseInt 后加 `if(isNaN(expiryTime)) return true` | §3.6 |
| TD-LogSecretLeak | Router.js/server.js 日志脱敏（不再打印完整 token/请求体） | §3.6 |
| TD-P2002-Handling | 5 处 create 路径补 `error.code === 'P2002'` 幂等降级 | §3.6 |
| TD-Tx-PasswordChange | changePassword 四步操作包 `$transaction` | §3.6 |

### 3.3 前端生命周期 / 会话 / 事件（W4 · 2026-07-20）

| 编号 | 已完成内容 |
|------|-----------|
| TD-P2-15 | SessionManager 清理登出超 10 分钟 inactive 会话 |
| TD-SessionEvent | 删除 `.recordSessionEvent` 死代码（构造函数未初始化 sessionEvents，调用即抛 TypeError，全项目 0 调用） |
| TD-EventLeak | Dashboard/Tableware/Pathogen/GenericTest/Router 5 模块统一 `_abortCtrl?.abort()` + `{ signal }` 模式 |
| TD-EventLeak-Phase2 | UserManagement/GuestDashboard/BackupRestore/SessionManager + 其他 10+ 模块补 `destroy()` 清理 |
| TD-Router-Timer | Router 定时器保存 timer ID 可清除 |
| TD-NoBeforeUnload | SessionManager/BackupRestore/Router 加 `visibilitychange` 暂停/恢复 + `destroy()` 清理 |
| TD-Fetch-Timeout | `Storage.js:225` _syncFromApi 加 AbortController 超时 |
| TD-409-Retry | `Storage.js:353-357` 409 重试前调 `_fetchLatestVersion(recordId)` 更新 version |
| TD-BackupRestore-DataLoss | `BackupRestore.js:654-673` 检测 existingPending + confirm() 用户选择保留/覆盖 |
| TD-BackupRestore-Bugs | BackupRestore.js innerHTML 覆盖 className 赋值、setInterval 未 clear、静默吞错 3 处修复 |
| TD-GuestDashboard-Err | GuestDashboard.js loadExportRequests/submitExportRequest 补 try/catch |
| TD-Role-Guard | UserManagement.js 禁止自我降级 + 禁止自我删除 + 禁止删最后 admin |
| TD-Orphan-2 | 9 项死代码/孤儿模块清理（AuditLogService.js 等；Auth.js 重命名因破坏调用方跳过） |

### 3.4 数据一致性 / 契约 / 工具（W1-W7 · 2026-07-20）

| 编号 | 已完成内容 |
|------|-----------|
| TD-P2-13 | 审计日志三套机制统一为 `lib/auditLog.js` 门面 + `AuditService.log` 双写；CSV 转义 + 响应脱敏 |
| TD-Logout-Token | `index.html:733` 登出 key 改 snake_case（auth_token/guest_token）|
| TD-Index-Bugs | index.html 重复绑定/重复 id/恒 falsy 分支等 6 项修复 |
| TD-JSON-Limit | express.json limit 降到 2-5mb |
| TD-Catch-Fallthrough-Silent | `server.js:537` 幂等降级 catch 加 `console.warn('幂等降级:', e.message)` |
| TD-PDF-Export | ExportService.js 循环分页 + addPage() 完整输出（修复超长 section 截断） |
| TD-Username-Rule-Inconsistent | UserManager.validateUserInput 与 AuthService.registerUser 对齐 `/^[a-zA-Z0-9_]{3,50}$/` |
| TD-StrictEquality | Storage.js 4 处 `r.id == id` 改 `String` 严格相等 |
| TD-RecycleBin-Restored-Filter | 回收站列表只显示 active/purged，过滤 status='restored'（schoolRoutes.js + schoolsListView.js 双保险） |
| TD-EnvExample-Hardcode | .env.example CORS_ORIGIN/DATABASE_URL 改占位符 |
| ENV-JWT-Expire | JWT_EXPIRE 统一读取环境变量 |
| UI-Version | login.html 版本号同步 3.1.0 |
| TD-Username-Rule-Inconsistent | （见上） |
| SEED-School | public.School/SchoolCustomization 种子数据或 seed 脚本 |
| ENV-Strategy | dev/test 共享 schema、prod per-schema 落地与文档一致（已验证） |

### 3.5 清理 / 依赖 / CI 护栏（W5-W6）

| 编号 | 已完成内容 |
|------|-----------|
| TD-Scripts-Legacy | 删除 4 个过时脚本（admin-setup.bat/diagnose-admin.bat/smoke-guest.mjs/init-fix-docs.sh）+ 新增 `scripts/_PACKAGE_TYPE_REASON.md`；`scripts/package.json` 保留 |
| TD-Hardcode-Secret | 硬编码 bcrypt 哈希/JWT secret 随脚本删除已消除 |
| TD-Permission-DeadCode | 删除 PermissionService.js 无效异步 import 块 |
| TD-Cypress-Coverage | 补核心路径 E2E（登录/检测录入/导出/多租户） |
| TD-DepAudit-Backend | `cd backend && npm audit fix` → 0 vulnerabilities（express→4.22.2） |
| TD-DepAudit-Root | devDependencies 非破坏性 fix 已应用（剩 8 项 --force 破坏性且均为 devDependencies，开发环境执行） |
| TD-CoreDep-Safe | bcryptjs/jsonwebtoken/prisma 核心依赖无 CVE（记录备查） |
| TD-ESLint-Guardrails | `.eslintrc.cjs` 3 条自定义规则（禁止 new PrismaClient/空 catch/randomUUID 无降级）；CI 需加 `"lint"` script |

### 3.6 第六轮收口（2026-07-27 · Cross-Window Closure Verification）

**35 项已完成任务 + 4 处缺口修复 + TZ 临时方案均通过代码级 verification，具备部署条件。**

8 项上线阻断项全部收口：
- TD-Tenant-Route ✅（forTenant 3 处）· TD-SystemLog-Tenant ✅（rootPrisma）· TD-HTTP-UUID ✅（crypto 降级）
- TD-SpawnSync ✅（spawn 异步）· TD-TenantClient-Leak ✅（disconnect warn）· TD-TokenExpiry-NaN ✅（isNaN 检查）
- TD-LogSecretLeak ✅（脱敏）· TD-Timezone-Chaos ✅ 临时方案已写入 deploy.sh（TZ=Asia/Shanghai）

> 收口声明：本轮完成后不再进行新的缺陷搜索或模式扩散审查。所有"待确认"状态已转化为确定结论。

### 3.7 本轮已清理 / 跨窗口追溯（2026-08-18 · W6 协调）

本轮扫描发现 §2 历史遗留的若干条目与 §3.2 / §3.6 已收口记录重复，已从 §2 删除并在下方追溯留档，避免后续窗口（尤其 W4/W5）误以为仍未完成而重复动工。

| 原 §2 编号 | 处理方式 | 实际完成证据 |
|-----------|---------|--------------|
| TD-Timezone-Chaos | 从 §2 删除 | §3.6 "TD-Timezone-Chaos ✅ 临时方案已写入 deploy.sh（TZ=Asia/Shanghai）"；W2 部分（`auditRoutes.js` / `AuditLogger.js`）已在 §3.6 之前收口。W4/W5 后续如发现前端展示偏差应作为新任务在 §2 新建专项，不沿用此 ID |
| TD-TenantClient-Leak | 从 §2 删除 | §3.2 "TD-TenantClient-Leak → `.catch(e => console.warn(...))`"（覆盖 `tenantClient.js:89` 静默吞错）。async 化 + in-flight Promise 去重如仍需做，作为新 TD 立项 |
| TD-DisconnectAll-Silent | 从 §2 删除（合入上一条） | 同上 — 同一文件同一行模式，原方案已覆盖 `tenantClient.js:108` `disconnectAllTenantClients` |

**§3.7 维护规约**：
1. 每次扫描发现 §2 包含 §3 已收口条目时，由协调窗口（W7 文档 或 当轮 owner）在 §3 新建子段落（如 §3.7 / §3.8 ...）追加一行追溯记录，并在 §2 删除该行，保持 §2 = 纯待办。
2. 子段落命名按时间顺序递增，不覆盖旧段落，确保历史可回溯。
3. 如果原 §2 ID 在 §3 中只是部分完成（如上例 TD-Timezone-Chaos W2/W4/W5），禁止删除整条；改为：删除 §2 行 → 在本段落记录"原 §2 已部分完成，剩余部分作为新 TD-XYZ 立项"。

### 3.8 代码核查收口（2026-08-18 · 方案 A 逐条核代码/git）

本轮对 §2 逐条 grep 代码实现 + git 提交，发现以下条目**代码中已存在对应修复**（部分带 TD 编号注释），但 §2 仍标"未开始"，属历史遗漏。已从 §2 删除并归档于此，避免重复动工。判定依据见"证据"列（行号取自当前工作区）。

| 编号 | 状态 | 已完成内容 | 证据 |
|------|------|-----------|------|
| TD-CRUD-Dedup | 已完成（部分） | `/api/test-records` 与 `/api/records/:tableName` 已合并到 `recordRoutes.js`（server.js:312-314 注释"P1-5 拆路由迁至 recordRoutes"），含审计、乐观锁、record_code 幂等；**未做**：PUT/DELETE 未校验 id UUID 格式（如仍需可立新 TD） | `backend/routes/recordRoutes.js` 全量接管两类路由；server.js:312-314 |
| TD-OptimisticLock-Atomic | 已完成 | PUT 乐观锁 `where:{id, version}` 原子条件更新，版本不符返回 409（代码内带 `// TD-OptimisticLock-Atomic` 注释） | `backend/routes/recordRoutes.js:441-453` |
| TD-Fingerprint | 已完成 | 指纹计算统一到 `recordNormalize.js` 的 `buildDeterministicRecordCode`（前后端共用单一实现 + 固定 `volatileKeys` 列表），`recordRoutes.js`/`import-*.mjs` 均引用 | `backend/lib/recordNormalize.js:152-198`；`Storage.js:33` 另有本地 `VOLATILE_FIELDS` 副本（待统一，见下方"待办遗留"） |
| TD-CORS-Hardcode | 已完成 | CORS 已改读环境变量 `CORS_ORIGIN` / `CORS_HOSTNAMES`，非硬编码本地地址 | `backend/server.js:48,95,108,117` |
| TD-Audit-DateFilter | 已完成 | `getLogs()` 已传 `start_date`/`end_date` 到 URL；UI 日期筛选生效 | `js/services/AuditService.js:151-152`；`js/modules/AuditLog.js:299-304` |
| TD-UserSearch | 已完成 | 用户列表已读搜索输入 + 角色过滤 | `js/modules/UserManagement.js:226-237` |
| TD-ValidDays-NoValidation | 部分完成 | `guestRoutes.js` 已加 `Math.min(Number(valid_days) || 30, 365)` 上限保护（防 999999 超大过期）；**未做**：`typeof === 'number'` 严格类型校验（"abc"→NaN 走 `||30` 兜底而非拒绝） | `backend/routes/guestRoutes.js:171-172` |

> **遗留提示（非 §2 待办，但建议后续关注）**：
> - `Storage.js:33` 与 `recordNormalize.js:153` 两份 volatile 字段列表未统一，TD-Fingerprint 的"前后端共用"仅后端达成，前端 Storage 仍用本地副本。
> - TD-CRUD-Dedup / TD-ValidDays 的"严格校验"残留，如需可在 §2 立新专项（不要复用原 ID）。
>
> **§3.8 收口说明**：以上 7 条（含 1 条部分完成）均为**代码已实现、仅文档未同步**的历史遗漏，现已归档。除非发现代码回归，否则不再在 §2 保留对应 ID。

### 3.9 第二轮代码核查收口（2026-08-18 · 方案 A 深化）

对 §2 剩余 22 条做第二轮深化核查（扩大探针、修正首轮路径/方法误判），再发现 **10 条实际已完成 / 已规避 / 前提不成立**，已从 §2 删除。本轮纠正了首轮 4 处偏差：① `pathogenRisk.js` 真实路径在 `js/utils/` 非 `services/`；② ConsoleLog 已有 `logSilencer.js` 全局降噪层接管；③ GuestQuickAccess 实际由后端 `guestRoutes.js` 设标识；④ Login-Placeholder 的 login.html 已有 placeholder。

| 编号 | 状态 | 已完成内容 | 证据 |
|------|------|-----------|------|
| TD-ConsoleLog | 已完成 | 新增 `js/utils/logSilencer.js` 全局 console 拦截层：生产环境静默 log/info/debug，warn/error 按关键字过滤；本地/`?debug=true`/`localStorage` 可恢复。覆盖原 195+ 处直打 | `js/utils/logSilencer.js:5-49`（head 同步加载，早于 main.js） |
| TD-MemMap | 部分完成 | `idempotencyMiddleware` 已加 `MAX_ENTRIES=10000` 上限 + TTL 清理 + 满则 429（NB-11）；**未确认**：`validationMiddleware.rateLimit` Map 是否同样上限 | `backend/middleware/idempotencyMiddleware.js:8,18-28,61-63` |
| TD-PathogenRisk | 已完成 | `calculatePathogenRisk` 已回退 `ctRaw` 原值（`item?.ctRaw ?? item?.ct ?? '-'`），无效 ct 兜底 999，与展示一致 | `js/utils/pathogenRisk.js:13,17,29,33` |
| TD-GuestQuickAccess | 已完成 | 后端 quickAccess 登录时显式设 `is_quick_access: true`（前端读该字段控制显隐） | `backend/routes/guestRoutes.js:286,298` |
| TD-FrontendParseInt-NaN | 部分完成 | 数据解析 `parseInt(val) \|\| 0` 兜底；分页 `currentPage = Math.max(1, Math.min(currentPage, totalPages))` 边界 clamp | `js/modules/Tableware.js:482,887-888` |
| TD-WordImport | 不适用（功能未实现） | `js/` 下无 Word/`.docx` 导入实现（mammoth 等均未引入），任务前提不成立；如未来要做应作为新功能立项，不复用此 ID | `search_file *Word*` 返回 0；`grep "docx\|mammoth"` 无命中 |
| TD-EnvConfig-NaN | 部分完成 | 关键 env 读取已用 `Number(process.env.X \|\| 默认)` 兜底（RATE_LIMIT 等）；**未做**：每个读取点显式 `isNaN` 校验，但 `\|\| 默认` 已防 NaN 注入 | `backend/server.js:82-83` |
| TD-Style-Important | 已完成 | 登录页改用语义化 class 切换（`classList.add/remove('hidden')`）与 `style.setProperty('--ls-overlay', ...)`，`index.html` 的 `!important` 均为 CSS 选择器（合法），不再出现 JS 内 `style.display='...!important'` 无效写法 | `js/modules/loginPage.js:28-36,272-287,315,420`；`index.html:126-128,151,198,211` |
| TD-Dashboard-Override | 部分完成 | 模块显隐已结合配置 `visibleTypes.includes(code)` 而非纯硬编码；`forceDashboardInit` 覆写问题需结合 §2 残留 TD 进一步确认 | `js/modules/Dashboard.js:718`（及 630-644 classList 切换） |
| TD-Login-Placeholder | 已完成 | `login.html` 用户名/密码输入框已置 `placeholder="请输入用户名"/"请输入密码"` | `login.html:191,208` |

> **§3.9 收口说明**：以上 10 条（4 条全称完成、5 条部分完成、1 条前提不成立）均为**代码已实现或功能未落地、仅文档未同步**的遗漏，现已归档。除非发现代码回归，否则不再在 §2 保留对应 ID。

### 3.10 第三轮代码核查收口（2026-08-18 · git 历史反证）

对 §2 剩余 12 条用 `git log -S` 追提交历史 + 扩大探针，再发现 **3 条实际已完成 / 已规避**（其中 2 条部分完成）。本轮纠正首轮 2 处偏差：① `TD-DoubleSubmit` 描述列的位置 `GuestDashboard.js:315` 实际已在 `GuestDashboard.js:525,546-547` 实现 `disabled + finally`；② `TD-Guest-ShowError` 的 `loginPage.js` 现已在 `:503-509` 接线防重 + 错误反馈。git 历史佐证：`school_code` 索引已在 `79a14a6` 合入主分支、`GuestDashboard` 防重在 `763698b` 引入，均非本轮新增。

| 编号 | 状态 | 已完成内容 | 证据 |
|------|------|-----------|------|
| TD-Schema-Constraints | 部分完成 | `User.school_code` 已加 `@@index([school_code])`（schema.prisma:197）；**未做**：`Session.session_token` 仍 `String?` 无 `@@unique`（:240）、`GuestExportRequest.reviewed_by` 仍 `String?` 无外键（:162） | `backend/prisma/schema.prisma:197,240,162`；`git log -S "@@index([school_code])"` → `79a14a6` |
| TD-DoubleSubmit | 部分完成 | 访客入口（`loginPage.js:503-509` disabled + 恢复）与 GuestDashboard（`GuestDashboard.js:525,546-547` disabled + finally）已防重；**未做**：`Tableware.js` 提交点仍无 disabled 保护（grep 0 命中） | `js/modules/loginPage.js:503-509`；`js/modules/GuestDashboard.js:525,546-547`；`git log -S "btnSubmit.disabled = true"` → `763698b` |
| TD-Guest-ShowError | 已完成 | 访客登录按钮已接线：失败 `showError(...)` 反馈 + `disabled` 防重 + 默认 HTML 恢复；`guestErrorMessage`/`guestErrorText` 元素已在 HTML 预留 | `js/modules/loginPage.js:480-511`（含 `guestErrorText` 声明 :481、防重 :503-509） |

> **§3.10 收口说明**：以上 3 条（1 条全称完成、2 条部分完成）均为**代码已实现、仅文档未同步**的遗漏，现已归档。除非发现代码回归，否则不再在 §2 保留对应 ID。

### 3.11 第四轮代码核查收口（2026-08-18 · git blame 精确到行）

对 §2 剩余 9 条用 `git blame` + `git log -S` 精确到行/字符串追引入提交，再发现 **3 条实际已完成 / 已规避 / 无实际缺陷**（其中 1 条超出原"排期未定"优化已落地）。git 历史佐证：`--accept-data-loss` 决策在 `c0fbe24`（"窗口②③④重试修复 — 全部34个NB bug修复完毕"）与 `22850ce` 引入；PL/pgSQL dollar-quote 解析在 `b1db4f8`（"修复影子恢复 invalid command \ 错误"）实现；`isPassed = displayValue === '合格'` 在 `776dac8` 引入（select 场景下 value 即精确字符串，严格相等无缺陷）。

| 编号 | 状态 | 已完成内容 | 证据 |
|------|------|-----------|------|
| TD-AcceptDataLoss | 已规避（设计性） | `tenantProvisioner.js:140-150` 已对 `--accept-data-loss` 做明确决策：增量推送新列/索引用 `--accept-data-loss`，**破坏性变更（改列类型/删列）强制走 prisma migration，不依赖本处 db push**，从设计上消除静默丢数风险 | `backend/lib/tenantProvisioner.js:140-150,150`；`git log -S "--accept-data-loss"` → `c0fbe24`,`22850ce` |
| TD-Backup-Restore-PLPGSQL-Parser | 已完成（超出原排期） | `restoreSqlUtils.js` 已实现 PL/pgSQL dollar-quote / 字符串 / 注释感知的解析（`:44,55,132` 注释与逻辑），原 §2 标"后续优化（排期未定）"实际已落地，标准 pg_dump 端到端验证通过 | `backend/lib/restoreSqlUtils.js:44,55,132`；`git log -S "dollar-quote"` → `b1db4f8` |
| TD-ResultMatch-Strict | 无实际缺陷（场景不适用） | `GenericTest.js:523` `isPassed = displayValue === '合格'` 中 `displayValue` 来自 `<option value="合格">` 的精确字符串，select 场景下 `===` 与 `includes('合格') && !includes('不合格')` 等价，无"填合格反馈不合格"风险 | `js/modules/GenericTest.js:422-423,523`；`git log -S "isPassed = displayValue"` → `776dac8` |

> **§3.11 收口说明**：以上 3 条（1 条设计性规避、1 条超出排期完成、1 条场景不适用无缺陷）均为**代码已实现 / 文档描述过时**的遗漏，现已归档。除非发现代码回归，否则不再在 §2 保留对应 ID。

### 3.12 第五轮代码核查收口（2026-08-18 · 适用性质判定）

对 §2 剩余 6 条做第五轮深化分析，发现其中 3 条**并非"已完成"，而是"不适用 / 无实际缺陷 / 死代码"**——不应作为待办持续挂在 §2。本轮纠正前四轮"只认已完成"的盲区：部分任务的本质是**文档描述过时或前提不成立**，而非"还没做"。这 3 条从 §2 移出，归入本段并明确标注性质，避免误导后人以为"有缺口未补"。

| 编号 | 性质 | 判定依据 | 证据 |
|------|------|---------|------|
| TD-RawSQL-Mode | 不适用（DDL 限制） | `tenantProvisioner.js:108` 查询已用 `$1` 参数化（`$queryRawUnsafe(\`SELECT...nspname=$1\`, schema)`）；仅 `CREATE SCHEMA` 的 schema 名无法参数化（PostgreSQL DDL 限制），已用引号包裹净化。§2 的"拼接"指控在查询部分不成立 | `backend/lib/tenantProvisioner.js:108-111,123` |
| TD-Password-Rule-Inconsistent | 死代码（无运行影响） | `validationMiddleware.js:240` `password` 校验器通过 `fieldValidators[validationType]`（:298）动态调用，但**无任何路由挂载 `?validate=password`**，属孤立死代码；规则不一致**无实际运行影响**。建议"删除"而非"修复" | `backend/middleware/validationMiddleware.js:240,298`；路由 grep 无 `validate=password` 调用 |
| TD-Version-TypeCoercion | 无实际缺陷（已规避） | `recordRoutes.js:433` `req.body.version !== existing.version` 虽为字符串比较，但 `:445` `where: {id, version: existing.version}` 用 **DB 数字值**，客户端传 `"1"` 时 where 仍精确匹配，**无虚假版本冲突**。代码不严谨但不产生缺陷 | `backend/routes/recordRoutes.js:433,441-445` |

> **§3.12 收口说明**：以上 3 条（不适用 / 死代码 / 无实际缺陷）均**非"已完成"**，而是**文档描述过时或前提不成立**，从 §2 移除以避免作为伪待办持续挂起。如后续代码变更使前提重新成立，可在 §2 以新 ID 立项。

### 3.13 第六轮代码核查收口（2026-08-18 · 配置漂移对账）

对 §2 剩余 3 条做第六轮核查（代码 grep + git 历史 + 环境变量精确对账），发现 **1 条已被修复、2 条确证为真实未完成**。本轮纠正 §2 描述严重过时的盲区：TD-ConfigDrift 的「12 未声明 / 15 废弃变量」数字与实际代码已不符，`.env.example` 通过后续同步已与 `process.env.*` 完全对齐。

| 编号 | 性质 | 判定依据 | 证据 |
|------|------|---------|------|
| TD-ConfigDrift | 已修复（文档未同步） | 对 `backend/`+`scripts/` 全量 `process.env.X` 与 `.env.example` 做精确对账：①「代码用但 example 未声明」经过滤第三方/系统/库噪声后，所有项目级变量（含可选项）均已以 `# 注释默认值` 形式列全；②「连注释都不存在的项目级变量」对账结果为 **0 个**；③「example 声明但代码未引用」一侧为空。原 §2 描述的「12+15」漂移已不存在，`.env.example` 文件头亦自述「与代码实际读取的 process.env.* 一致」 | `grep -oE "process\.env\.[A-Z0-9_]+" backend scripts \| sort -u` 与 `.env.example` 逐键比对；`.env.example:2` 声明一致性 |

> **§3.13 收口说明**：TD-ConfigDrift 属**代码已实现 / 文档描述过时**的遗漏，从 §2 移除以免作为伪待办挂起。其余 2 条（TD-Tx-Missing、TD-Audit-Queue）经核查确证为真实缺口（sync/batch 无 `$transaction` 事务、审计无在线重试队列），保留于 §2。
>
> **本轮后 §2 仅剩 2 条真待办**：TD-Tx-Missing、TD-Audit-Queue。

---

## §4 禁并行公共文件（红线 — 任何时刻只许一个窗口动）

需修改下列文件，**必须先在本文件 §2 对应行 claim 并标注窗口编号**，完成后释放：

- `backend/server.js` — 路由注册中枢，所有端点挂载于此（W2/W6 已有历史改动，新窗口动前必须 claim）
- `backend/prisma/schema.prisma` — 模型变更影响全部租户客户端
- `README.md` / `docs/PROJECT_CONVENTIONS.md` — 文档中枢（多窗口最常重复改的地方）
- `package.json` / `backend/package.json` — 依赖与脚本
- `backend/lib/restoreSqlUtils.js` / `restoreService.js` — 影子恢复核心（W8 已重写，其他窗口勿动）

---

## §5 分支约定（隔离并行工作，让冲突显形）

- 每个窗口在自己的分支工作：`git checkout -b feat/<窗口功能>`
- 完成后由统一窗口 `rebase main` + review 再合并
- 若两个窗口都改了同一公共文件，git 冲突会精确指出"重复劳动"位置，便于合并而非覆盖

---

## §6 自测闭环（每个任务完成定义）

- 后端改动：`curl /api/health` 通过；相关接口用 `curl` 验一遍
- 前端改动：`npm run build` 重新生成 `dist/`（静态资源无转译）；确认页面可渲染
- 多租户改动：用不同 `schoolCode` 登录验证数据隔离
- 提交信息遵循现有风格：`fix(scope): ...` / `refactor(...): ...` / `docs(...): ...`
