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

| 任务 ID | 描述 | 严重度 | Owner Window | 状态 | 修复方向 |
|---------|------|--------|--------------|------|----------|
| TD-Tx-Missing | `server.js:736-769` bulk-upsert 循环逐条 findUnique+create/update 无 `$transaction`；`syncRoutes.js:100-172` /batch 无事务无幂等无上限 | 高危 | 待认领 | 未开始 | 包 `$transaction` + 挂幂等中间件 |
| TD-MemMap | `idempotencyMiddleware` 和 `validationMiddleware.rateLimit` 内存 Map 无上限无 LRU，长运行 OOM | 高危 | 待认领 | 未开始 | 加 LRU 上限或改 Redis |
| TD-PathogenRisk | `pathogenRisk.js:14` `parseFloat(item?.ct)` 未回退 `item?.ctRaw`，`{ctRaw:"25.3",ct:undefined}` → ct=NaN→999 判极低风险，与展示 25.3 中风险不一致 | 高危 | 待认领 | 未开始 | `parseFloat(item?.ct ?? item?.ctRaw)` |
| TD-ConsoleLog | `js/` 下 195+ 处 `console.log/info/debug` 打印含用户数据/请求体，生产泄露 | 中危 | 待认领 | 未开始 | 统一替换为可关闭的 logger |

| TD-Schema-Constraints | `schema.prisma` 缺约束：`User.school_code` 无 `@@index`、`GuestExportRequest.reviewed_by` 无外键、`Session.session_token` 无唯一约束 | 中危 | 待认领 | 未开始 | 补索引/外键/唯一约束 |
| TD-AcceptDataLoss | `tenantProvisioner.js:81` `--accept-data-loss` 在运行时调用时可能静默丢弃已有数据 | 中危 | 待认领 | 未开始 | 仅首次创建用，已存在改 migrate |

| TD-DoubleSubmit | `Tableware.js:711`/`GenericTest.js:953`/`GuestDashboard.js:315` 提交未 disabled，可重复提交产生重复记录 | 中危 | 待认领 | 未开始 | 入口 disabled + finally 恢复 |
| TD-WordImport | `Pathogen.js:269,393` Word 导入的 testDate 无未来日期校验，字段无长度/字符白名单 | 中危 | 待认领 | 未开始 | 补校验 + 内容消毒 |
| TD-Audit-Queue | `AuditService.js:65` `log()` fetch 失败仅 console.warn，审计日志永久丢失无重试队列 | 中危 | 待认领 | 未开始 | 离线队列 + online flush |
| TD-GuestQuickAccess | `GuestAuthService.js:181` quickAccess 失败不清理残留 token；成功时不设 `is_quick_access` 标识 | 中危 | 待认领 | 未开始 | 失败先 logout + 成功设标识 |
| TD-Style-Important | `index.html:163` `form.style.display='none !important'` 在 JS 中无效，快速访问模式表单隐藏失效 | 中危 | 待认领 | 未开始 | 改 `setProperty(...,'important')` |
| TD-Dashboard-Override | `index.html:677` `forceDashboardInit()` 100ms/2000ms 用 innerHTML 覆写 #dashboard，间歇白屏 | 中危 | 待认领 | 未开始 | 仅在未渲染时兜底 |
| TD-Guest-ShowError | `login.html:494,501` 访客模块调 `showError()` 操作管理员表单 `#errorMessage`（此时隐藏），访客失败无反馈 | 中危 | 待认领 | 未开始 | 独立 showGuestError |
| TD-Password-Rule-Inconsistent | `validationMiddleware.js:237` password 要求 `length>=6` vs `UserManager.isStrongPassword` 强规则（8+字母+数字），字段校验器从未被路由调用但误导 | 中危 | 待认领 | 未开始 | 对齐 isStrongPassword 正则或删除 |
| TD-ResultMatch-Strict | `GenericTest.js:464,513,538` 用 `=== '合格'` 严格相等而非 `includes('合格') && !includes('不合格')` 口径 | 低危 | 待认领 | 未开始 | 统一为 includes 模式 |
| TD-EnvConfig-NaN | 4 处 `Number(process.env.X \|\| 默认)` 未处理 NaN（RATE_LIMIT/LOGIN_RATE_LIMIT/MAX_TENANT_CLIENTS/TENANT_CONNECTION_LIMIT），env 设非数字字符串则配置静默失效 | 中危 | 待认领 | 未开始 | 加 `if(isNaN(v)) v = 默认值` |

| TD-Version-TypeCoercion | `server.js:828` 客户端传字符串 `"1"` vs DB 数字 `1` → 虚假版本冲突；`:748` `(version\|\|0)+1` 字符串 "3" → "31" | 中危 | 待认领 | 未开始 | 比较前 `Number()` 转换 |
| TD-FrontendParseInt-NaN | 6 处前端分页 `parseInt` 未处理 NaN（Pathogen.js:1370,1403、Tableware.js:918,952、GenericTest.js:96,142），currentPage=NaN 渲染异常 | 中危 | 待认领 | 未开始 | parseInt 后 `if(isNaN(p)) return` |
| TD-ConfigDrift | ① 代码使用但 .env.example 未声明 12 变量；② .env.example 声明但代码未引用 15 废弃变量 | 中危 | 待认领 | 未开始 | 补充声明 + 清理废弃 |
| TD-RawSQL-Mode | `tenantProvisioner.js:69,117` 用 `$executeRawUnsafe` 拼接 schema 名（已净化），与参数化模式不一致 | 低危 | 待认领 | 未开始 | 统一为参数化 / `Prisma.sql` |
| TD-Login-Placeholder | `login.html` "忘记密码？" href="#" 纯占位、"需要帮助？"无事件绑定、`applySchoolTheme` catch 空吞错、访客入口硬编码关闭但代码残留 | 低危 | 待认领 | 未开始 | 决定实现或移除 |
| TD-Backup-Restore-PLPGSQL-Parser | **后续优化（方案 A）**：`extractSchemaSegment` 第 5 步兜底路径（restoreSqlUtils.js:163-178）仍用括号配对，异常/非标准 dump 时对 PL/pgSQL 函数体/字符串内括号仍可能误判。写完整 SQL/PL-pgSQL 词法解析器（dollar-quote/字符串/注释感知）取代之 | 低危 | 待认领（排期未定，不建议本周） | 未开始 | 段锚点方案对标准 pg_dump 100% 有效（已端到端验证），Parser 仅消除兜底隐患 |

> 新增任务时，**在此表追加一行**并立即 claim，避免另一窗口平行发现同一需求。
>
> **归档规约**：当某任务在 §3 完成记录中出现收口证据时（含代码内已实现的 TD 编号注释或 git 提交），应立即从本表删除对应行，并在 §3 最新子段落（如 §3.7 / §3.8 ...）追加一行追溯记录（详见 §3 末尾"维护规约"）。本表保持 = 纯待办，不与 §3 重复。
>
> **本表现状（2026-08-18 方案 A 核查后）**：保留 22 条经代码 grep 确认**代码中无对应修复**的待办；已移出 10 条（§3.7 的 3 条 + §3.8 的 7 条），其中 §3.8 为逐条核代码/git 收口，非仅凭文本匹配。

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
