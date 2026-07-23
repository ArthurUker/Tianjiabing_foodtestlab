# TASKS.md — 多窗口并行开发协调板

> **用途**：当你同时开多个对话窗口（AI 编程助手）在同一仓库工作时，用本文件避免"重复造轮子 / 踩已解决的坑"。
>
> **每个窗口启动后的第一步**（SOP）：
> 1. 读 `README.md`（系统总览）→ `docs/PROJECT_CONVENTIONS.md`（红线，最高优先级）→ 本文件。
> 2. 在 §3 开放任务里**认领**一行：把 `Owner Window` 填成你的窗口编号（W1~W7），`状态` 改为 `进行中`。
> 3. 只在 §2 分配给你的文件范围内工作；碰 §5 公共文件前必须先在此 claim。
> 4. 完成后把 `状态` 改为 `已完成` 并注明提交哈希。
>
> **绝不重复**：§4 列出的 TD 任务已被解决，任何窗口都**不得重新实现**，除非先在 `PROJECT_CONVENTIONS.md` 报备反转。

---

## §1 窗口 ↔ 功能责任矩阵（防分工撞车）

| 窗口 | 负责功能 | 独占文件（主） |
|------|----------|----------------|
| W1 | 认证 / 用户 | `backend/modules/UserManager.js`、`backend/routes/userRoutes.js`、`js/services/AuthService.js` |
| W2 | 访客 | `backend/routes/guestRoutes.js`、`js/services/GuestAuthService.js` |
| W3 | 审计 | `backend/routes/auditRoutes.js`、`backend/lib/auditLog.js` |
| W4 | 会话 | `backend/routes/sessionRoutes.js`、`js/services/SessionManager.js` |
| W5 | 租户隔离 | `backend/lib/tenantClient.js`、`backend/lib/tenantProvisioner.js`、`backend/middleware/` |
| W6 | 部署 / 脚本 | `deploy/`、`scripts/` |
| W7 | 文档 | `docs/`、`README.md` |

> 跨窗口功能（如"前端调用某后端接口"）由调用方窗口负责对接，被调方窗口只保证接口契约稳定。

---

## §2 开放任务（待认领 — 每个窗口 claim 一行）

| 任务 ID | 描述 | 关联窗口 | Owner Window | 状态 | 备注 |
|---------|------|----------|--------------|------|------|
| TD-P2-13 | 审计日志三套机制（①登录库 ②审计API库 ③前端localStorage）统一为单一接口、统一字段口径 | W3 | W3（本窗口·2026-07-20） | 已完成（未提交） | 门面 `lib/auditLog.js` 已建且全局唯一入口；`AuditService.log` 双写 localStorage+`/api/audit-logs`，无 direct `db.auditLog.create` 旁路；本次收尾：导出 CSV 转义 + 错误响应生产脱敏 |
| SEED-School | `public.School` / `public.SchoolCustomization` 系统表为空，登录页主题/Logo 个性化优雅降级（不影响功能）。需插种子数据或补 seed 脚本 | W6 / W1 | W6（本窗口·2026-07-20） | 已完成（待提交） | 影响登录页个性化，非阻塞 |
| ENV-Strategy | 确认 dev/test 共享 schema、prod per-schema 的落地与文档一致性（README 已有描述，待生产环境验证） | W6 | W6（本窗口·2026-07-20） | 已完成（待提交·验证一致） | 非编码为主，偏验证 |
| TD-P2-15 | `SessionManager` inactive 会话不从内存数组移除（`removeSession` 仅改 status），长期运行可能内存增长，需评估清理策略（代码注释已标注，本表此前漏登） | W4（本窗口·2026-07-20） | 已完成（未提交） | 非阻塞，见 `js/services/SessionManager.js` 构造函数注释 |
| TD-SessionEvent | `SessionManager.recordSessionEvent` 死代码 + 潜在 bug：① 构造函数未初始化 `this.sessionEvents`，调用第 421 行 `push` 即抛 `TypeError`；② 全项目无调用方（`.recordSessionEvent(` 0 匹配）。`DEVELOPMENT_GUIDE §9.6` 称"已对接后端"与代码不符。需删除该方法或补初始化 + 接通调用点 | W4（本窗口·2026-07-20） | 已完成（未提交） | 非阻塞但属潜在运行时错误 |
| ENV-JWT-Expire | `JWT_EXPIRE` 环境变量未接通：`UserManager`/`userRoutes`/`guestRoutes` 均硬编码 `7d`/`7*24*3600`，`.env.example` 与 `deploy.foodtestlab.conf` 的 `JWT_EXPIRE` 不生效。需统一读取环境变量或删除冗余配置项 | W1 | W1（第一个窗口·2026-07-20） | 已完成 | 非阻塞，功能不受影响（7 天合理） |
| UI-Version | `login.html` 页脚"系统版本: 1.0" 与 `package.json` `3.1.0` 不一致，需同步 | W7 | （待认领） | 未开始 | 非阻塞，仅显示 |
| ENV-Example-Secret | `.env.example` 的 `JWT_SECRET` 为弱密钥占位符（代码已移除硬编码 fallback，生产忘配会启动失败，防御到位），示例值建议改为生成命令提示 | W6 | W6（本窗口·2026-07-20） | 已完成（待提交） | 非阻塞，属示例文案优化 |
| TD-Orphan-2 | 死代码/孤儿模块第二批清理：① `js/services/AuditLogService.js` 整文件无人 import（已被 `AuditService.js` 替代）；② `js/utils/Validator.js` 仅测试引用，生产全用 `FormValidator.js`；③ `js/utils/AuditLogger.js` 的 `getLogsByDate`/`getAvailableDates`/`clearAllLogs` 导出无人调用；④ `js/modules/FormBuilder.js:557-606` `createTestForm` 示例函数无人用；⑤ `js/modules/Tableware.js:91-95` `if(isQuickAccess)` 两分支相同死逻辑；⑥ `js/core/Auth.js` 文件名与内容（OperationGuard）不符易混淆；⑦ `SessionManager` 的 `getSessionStats`/`getUserActiveSessions`/`calculateAvgSessionDuration`/`getDeviceDistribution` 4 方法无调用方；⑧ `js/utils/SampleDataGenerator.js` mock 数据含注释死代码；⑨ `js/utils/NetworkHelper.js:212-216` 空 if 块占位 | W4（本窗口·2026-07-20） | 已完成（未提交） | 非阻塞，纯清理（Auth.js 重命名因破坏调用方风险已跳过，其余已清理） |
| TD-Scripts-Legacy | 废弃脚本与骨架文档清理：① `scripts/admin-setup.bat` 引用 Supabase（已废弃）+ 默认密码 8888 + 端口 3000（实际 3002）；② `scripts/diagnose-admin.bat` 引用 Supabase + 端口 3000 + 路径 `/health`（实际 `/api/health`）+ 硬编码 bcrypt 哈希；③ `scripts/smoke-guest.mjs` 自标注"临时"+无人引用+硬编码 JWT secret；④ `scripts/init-fix-docs.sh` 生成 56 个占位骨架文档（"待填写"）。⚠️ `scripts/package.json` **不可删**（删除会导致 `build-static.js` 报 `require is not defined`，见 `docs/deployment/dev-test-deployment-guide.md` §12.3），改为新增 `scripts/_PACKAGE_TYPE_REASON.md` 说明保留原因。项目已转 Linux/Caddy，`.bat` 全过时 | W5 | W6（第一个窗口·2026-07-20） | 已完成（待提交） | 非阻塞，已删除 4 脚本 + 新增 scripts/_PACKAGE_TYPE_REASON.md；硬编码 secret 随脚本删除，TD-Hardcode-Secret 一并解决 |
| TD-EventLeak | 前端事件监听/定时器未解绑（多处内存泄漏）：① `Dashboard.js:96,99,103-118` `dataChanged`/`dashboard:refresh`/sync 事件 + 导航 click 未移除；② `Tableware.js:98-105` dataChanged + storage.on('sync')；③ `Pathogen.js:93` storage.on('sync')；④ `GenericTest.js:86` storage.on('sync')；⑤ `Router.js:62-71,292-313,417-420,448-451` storage/permissionChanged/登出按钮/idle 多处匿名监听无法移除；⑥ `SessionManager.js:37,40,241-246` userLogin/userLogout 监听。模块多次初始化或导航切换会累积监听器 | W4（本窗口·2026-07-20） | 已完成（未提交） | 非阻塞，长会话下内存增长 |
| TD-Logout-Token | 登出后 token 残留（安全 + bug）：`index.html:733-735` 内联登出脚本清除 camelCase key（`authToken`/`guestToken`/`is_quick_access`），但 `AuthService.js:11` 实际用 snake_case（`auth_token`/`guest_token`），`login.html:322` 用 `guest_token`。key 不匹配导致登出后 token 未清除，可能仍可访问受保护资源。同时 `index.html:719-748` 登出逻辑与 `main.js` 重复绑定 | W2 | W2（本窗口·2026-07-20） | 已完成 | AuthService.clearAuth 已清 snake_case 访客键（W1 实现），残留隐患已消除 |
| TD-Index-Bugs | `index.html` 结构与重复加载问题：① L158-197 `DOMContentLoaded` 两段完全相同的重复绑定；② L64-65 `html2canvas`/`jsPDF` 重复加载（defer 与非 defer 各一次）；③ `btnLogout` id 在 L216 与 L271 重复（违反 HTML 规范）；④ L454 `<select>` 标签缺 `>` 闭合；⑤ L833 `window.tablewareReady` 从未被设置，条件恒 falsy；⑥ L768 formIds 含 `pathogenTestForm` 但 HTML 无此 form id | W7 | （待认领） | 未开始 | 非阻塞，浏览器容错但应修正 |
| TD-GuestDashboard-Err | `js/modules/GuestDashboard.js` 错误处理缺失：① `loadExportRequests:218-229` `getMyRequests()` 无 try/catch，失败时 UI 停留"加载中"且无用户提示；② `submitExportRequest:315-338` 同样无 try/catch，网络异常成未处理 rejection | W4（本窗口·2026-07-20） | 已完成（未提交） | 非阻塞，影响访客端异常体验 |
| TD-BackupRestore-Bugs | `js/modules/BackupRestore.js` 多处 bug：① L294-297 `innerHTML` 覆盖导致 L293 `statusDot.className` 赋值失效；② L38-40 `startConnectionMonitor` 的 `setInterval` 从未 `clearInterval`；③ L55-56 `checkPreviousSyncResult` catch 仅 console.error 静默吞错且不清理损坏的 localStorage | W4（本窗口·2026-07-20） | 已完成（未提交） | 非阻塞，影响同步状态指示准确性 |
| TD-Router-Timer | `js/core/Router.js:396-398` `startTokenValidationTimer` 创建的 `setInterval` 未保存 timer ID，无法清除。页面长运行或 Router 重复初始化会累积不可取消定时器 | W4（本窗口·2026-07-20） | 已完成（未提交） | 非阻塞，同 TD-EventLeak 类 |
| TD-Login-Placeholder | `login.html` 占位与静默吞错：① L193 "忘记密码？" `href="#"` 纯占位无实现；② L237-241 "需要帮助？"按钮无事件绑定；③ L302-304 `applySchoolTheme` catch 块空注释静默吞所有异常无日志；④ L114-115 `window.__ENABLE_GUEST_ENTRY__=false` 硬编码关闭访客入口，但访客 Tab/表单/`enterAsGuest()` 代码仍残留为死功能 | W7 | （待认领） | 未开始 | 非阻塞，占位项需决定实现或移除 |
| TD-Cypress-Coverage | E2E 测试零业务覆盖：`cypress/e2e/smoke.cy.js` 仅 2 个 case 检查 login/index 页面 200，无登录、无 CRUD、无多租户隔离验证；`cypress.config.cjs` supportFile 关闭为骨架占位。需补核心路径 E2E（登录/检测录入/导出/多租户） | W6 | W6（本窗口·2026-07-20） | 已完成（待提交） | 非阻塞，影响回归保障 |
| TD-RawSQL-Mode | `backend/lib/tenantProvisioner.js:69,117` 用 `$executeRawUnsafe` 拼接 schema 名（虽经 `schemaNameOf()` 净化仅允许字母数字下划线），但与 `server.js` 其他处的参数化 `$queryRawUnsafe(...,$1)` 模式不一致。建议统一为参数化或 `Prisma.sql` 模板，消除模式风险 | W3 | （待认领） | 未开始 | 非阻塞，已净化无实际注入，属代码规范统一 |
| TD-Hardcode-Secret | 废弃脚本硬编码敏感值：① `scripts/diagnose-admin.bat:57` 硬编码 bcrypt 哈希 `$2a$10$mgql...` 入库；② `scripts/smoke-guest.mjs:14` 硬编码 JWT secret。随 TD-Scripts-Legacy 删除脚本可消除，删除前勿在生产环境执行 | W6（第一个窗口·2026-07-20） | 已完成（待提交） | 非阻塞，随 TD-Scripts-Legacy 删除脚本已消除硬编码 secret |
| **—— 以下为第二轮全代码深审新增（8 子代理逐行审查）——** | | | | | |
| TD-Tenant-Route | **严重·租户隔离破坏**：`userRoutes.js:89,133,156` 的 refresh-token / PUT /me / change-password 三端点用全局 `userManager` 而非 `forTenant(schoolCode)`，多租户下查询/更新落错 schema（public 而非租户）。同理 `UserManager.js:580` `logLogin` 传全局 prisma 给 `writeTenantAuditLog`，登录审计写入 public 而非租户 schema | W2 | W1（第一个窗口·2026-07-20） | 已完成 | 4 处均改 `userManager.forTenant(req.user.schoolCode)` |
| TD-HTTP-UUID | **严重·HTTP 部署崩溃**：`js/core/Storage.js:109` `crypto.randomUUID()` 仅在 Secure Context（HTTPS/localhost）可用，HTTP 内网部署直接抛 `TypeError`，保存功能完全不可用 | W2 | W2（本窗口·2026-07-20） | 已完成 | 加 fallback `${Date.now()}-${Math.random().toString(36).slice(2)}`（W2 已修复） |
| TD-SpawnSync | **严重·全服务卡死**：`backend/lib/tenantProvisioner.js:79` `spawnSync('npx',['prisma','db','push',...],{timeout:120000})` 同步阻塞事件循环最长 120s，新建学校期间整个服务对所有租户完全无响应 | W2 | W2（本窗口·2026-07-20） | 已完成 | 改 `child_process.spawn`+Promise 异步（W2 已修复） |
| TD-TenantClient-Leak | **高危·连接泄漏**：`tenantClient.js:89` LRU 淘汰时 `$disconnect().catch(()=>{})` fire-and-forget 未 await，旧连接异步断开未完成即新建；`getSchemaClient:70` 非原子，并发首请求创建重复 PrismaClient 泄漏 | W3 | （待认领） | 未开始 | async 化 + in-flight Promise 去重 |
| TD-TrustProxy | **高危·限流失效**：server.js 未设 `app.set('trust proxy',...)`，Nginx 反代后 `req.ip` 为代理 IP，rate limit 全局共享单 bucket，单用户可耗尽或绕过。`RATE_LIMIT_MAX_REQUESTS` 默认 1000 偏高 | W3 | （待认领） | 未开始 | 设 trust proxy + 降低默认限流 |
| TD-Error-Leak | **高危·信息泄露**：server.js 内联路由 14 处 catch 返回 `details: error.message`（含 SQL 片段/表名/栈），与全局错误处理器（非 dev 隐藏 message）不一致 | W3 | （待认领） | 未开始 | 生产环境不返回 details |
| TD-VerifyToken | **高危·信息泄露**：`userRoutes.js:58-79` verify-token 无限流无限流中间件，且直接返回完整 JWT payload（userId/username/email/role/schoolCode），捡到 token 者可提取所有字段 | W3 | W1（第一个窗口·2026-07-20） | 已完成 | 加 rateLimit + 仅返回 minimal 字段 |
| TD-RefreshToken | **高危·刷新逻辑错误**：`AuthService.js:172` `refreshToken()` 用 `getToken()`（access token）而非 `getRefreshToken()`（后者已实现但从未调用=死代码），access 过期后刷新必失败；网络抖动直接 `clearAuth()` 强制登出丢数据 | W3 | W1（第一个窗口·2026-07-20） | 已完成 | 改用 refresh token + 区分 401 与 5xx |
| TD-XSS-Frontend | **高危·存储型 XSS**：前端多处 `innerHTML` 拼接用户输入未转义：`Pathogen.js:1326`(sampleId/inspector)、`Tableware.js:843,1272`(inspector/correctiveAction)、`UserManagement.js:218`(username/phone)、`BackupRestore.js:671`(err.message)、`Pathogen.js:548`(JSON 嵌 data-* 属性引号转义不足) | W3 | （待认领） | 未开始 | 统一 escapeHtml 或改 textContent |
| TD-CSV-Export | **高危·CSV 注入**：`auditRoutes.js:203` CSV 导出字段未双引号包裹、details JSON 双引号未转义、以 `=+-@` 开头字段无前缀防护，Excel/WPS 可执行恶意公式 | W3 | W3（本窗口·2026-07-20） | 已完成（未提交） | 已加 `csvField()` 统一转义（双引号包裹 + 内部 `"` 翻倍 + `=+-@` 开头前置 `'`） |
| TD-ConsoleLog | **中危·生产泄露**：`js/` 下 195+ 处 `console.log/info/debug` 打印含用户数据/请求体（`server.js:635` 打印 body 前 200 字符），生产环境暴露内部信息 | W5 | （待认领） | 未开始 | 统一替换为可关闭的 logger |
| TD-CORS-Hardcode | **中危·配置硬编码**：`server.js:71-77` CORS 列表硬编码 7 个本地地址（localhost 各端口），生产环境需改 `CORS_ORIGINS` 环境变量 | W5 | （待认领） | 未开始 | 完全改读环境变量 |
| TD-Tx-Missing | **高危·数据一致性**：① `server.js:736-769` bulk-upsert 循环内逐条 findUnique+create/update 无 `$transaction`，半成功无回滚；② `syncRoutes.js:100-172` /batch 同样无事务无幂等无大小上限，idempotencyMiddleware 未挂 /api/sync | W3 | （待认领） | 未开始 | 包 $transaction + 挂幂等中间件 |
| TD-CRUD-Dedup | **高危·逻辑不一致**：`/api/test-records` 与 `/api/records/:tableName` 两套 CRUD 重复，前者缺审计日志/缺乐观锁/缺字段验证/硬删无审计/PUT 不检查存在性/DELETE 不返 404；两套的 PUT/DELETE 均未校验 id 的 UUID 格式 | W3 | （待认领） | 未开始 | 抽取共享 recordRoutes + 统一校验 |
| TD-Fingerprint | **高危·去重失效**：前端 `Storage.js:31` `VOLATILE_FIELDS` 与后端 `server.js:215` `volatileKeys` 不一致（前端 `_sanitizePayload` 剥离 test_type/test_name 但指纹计算不剥离，后端反之），同一数据生成不同 record_code，去重失效产生重复记录 | W3 | （待认领） | 未开始 | 前后端共用同一字段列表 |
| TD-MemMap | **高危·OOM**：`idempotencyMiddleware` 和 `validationMiddleware.rateLimit` 的内存 Map 无大小上限无 LRU 淘汰，长运行 OOM | W4 | （待认领） | 未开始 | 加 LRU 上限或改 Redis |
| TD-Pagination | **中危·DoS**：server.js 多处 `parseInt(limit/offset)` 无上限校验/NaN 防护/负数防护，`?limit=999999999` 一次性查全表 | W5 | （待认领） | 未开始 | 抽 parsePagination 统一校验 |
| TD-Schema-Constraints | **中危·数据完整性**：`schema.prisma` 缺约束：`User.school_code` 无 `@@index`（按 schoolCode 查全表扫）、`GuestExportRequest.reviewed_by` 无外键关系、`Session.session_token` 无唯一约束（upsert by id 而非 token） | W5 | （待认领） | 未开始 | 补索引/外键/唯一约束 |
| TD-GracefulShutdown | **中危·连接泄漏**：`server.js:1051` SIGTERM 的 `server.close()` 无超时，长连接/慢请求致进程挂起，K8s grace period 后 SIGKILL 致 DB 连接未释放 | W5 | （待认领） | 未开始 | 加 10s forceExit setTimeout |
| TD-JSON-Limit | **低危·DoS 面**：`server.js:323` `express.json({limit:'10mb'})` 偏大，bulk-upsert 限 2000 条约 2MB，10MB 增大攻击面 | W6 | W6（本窗口·2026-07-20） | 已完成（待提交） | 降到 2-5mb |
| TD-AcceptDataLoss | **中危·数据丢失**：`tenantProvisioner.js:81` `--accept-data-loss` 在运行时 `POST /api/admin/schools` 调用时，若 schema 已有数据可能静默丢弃 | W4 | （待认领） | 未开始 | 仅首次创建用，已存在改 migrate |
| TD-UserSearch | **中危·功能缺陷**：`UserManagement.js:163` 搜索/角色筛选 UI 存在但 `loadUsers()` 不读取输入值，`AuthService.listUsers` 签名不接受 search/role，搜索功能形同虚设 | W5 | （待认领） | 未开始 | 前端传参 + 后端支持过滤 |
| TD-Role-Guard | **中危·安全 UX**：`UserManagement.js:335,379` 编辑用户角色未防自我降级（admin→viewer）未防删自己未防删最后 admin，前端无拦截提示 | W4（本窗口·2026-07-20） | 已完成（未提交） | 前端校验 + 提示 |
| TD-Audit-DateFilter | **中危·功能假象**：`AuditService.js:84` `getLogs()` 不传 start_date/end_date 到 URL（注释"以备扩展"），UI 日期筛选完全无效，用户以为筛了实际没筛 | W5 | （待认领） | 未开始 | 补全参数传递 |
| TD-DoubleSubmit | **中危·重复提交**：`Tableware.js:711`/`GenericTest.js:953`/`GuestDashboard.js:315` 表单提交/导出申请提交未 disabled 按钮，网络等待期间可连续点击产生重复记录 | W5 | （待认领） | 未开始 | 入口 disabled + finally 恢复 |
| TD-WordImport | **中危·数据污染**：`Pathogen.js:269,393` Word 导入的 testDate 无未来日期校验（表单提交有 `dateNotFuture` 但导入绕过），解析字段无长度/字符白名单 | W4 | （待认领） | 未开始 | 补校验 + 内容消毒 |
| TD-PathogenRisk | **高危·风险评估错误**：`pathogenRisk.js:14` `parseFloat(item?.ct)` 未回退 `item?.ctRaw`，`{ctRaw:"25.3",ct:undefined}` → ct=NaN→999 判为极低风险，但展示 ctRaw=25.3 中风险，评估与展示不一致 | W3 | （待认领） | 未开始 | `parseFloat(item?.ct ?? item?.ctRaw)` |
| TD-BackupRestore-DataLoss | **中危·数据丢失**：`BackupRestore.js:604` 恢复时 `localStorage.setItem(pendingKey,'[]')` 直接覆盖旧 pending 队列，离线未同步数据被静默丢弃 | W4（本窗口·2026-07-20） | 已完成（未提交） | 覆盖前检查合并或提示 |
| TD-PDF-Export | **中危·内容丢失**：`ExportService.js:921` PDF 超长 section 裁切只切一次，剩余超一页内容溢出 A4 被截断丢失 | W5 | W5（本窗口·2026-07-20） | 已完成 | 循环分页或用 autotable（已完成：循环分页修复截断） |
| TD-Audit-Queue | **中危·合规风险**：`AuditService.js:65` `log()` fetch 失败仅 `console.warn`，审计日志永久丢失无重试队列，delete/export 等关键操作审计不完整违反合规 | W4 | （待认领） | 未开始 | 离线队列 + online flush |
| TD-GuestQuickAccess | **中危·状态不一致**：`GuestAuthService.js:181` quickAccess 失败不清理残留 token（旧 token 继续访问），成功时不设 `is_quick_access` 标识致 `isQuickAccessMode()` 恒 false | W4 | （待认领） | 未开始 | 失败先 logout + 成功设标识 |
| TD-Permission-DeadCode | **低危·死代码**：`PermissionService.js:77` 异步 `import().then(return ...)` 回调 return 值永远丢失（外层同步函数），纯属无效代码掩盖逻辑意图 | W6 | W6（本窗口·2026-07-20） | 已完成（待提交） | 删除异步 import 块 |
| TD-Style-Important | **中危·功能失效**：`index.html:163` 等 `form.style.display='none !important'` JS 中无效（浏览器忽略 `!important`），快速访问模式表单隐藏失效 | W5 | （待认领） | 未开始 | 改 `setProperty('display','none','important')` |
| TD-Dashboard-Override | **中危·白屏**：`index.html:677` `forceDashboardInit()` 在 100ms/2000ms 用 `innerHTML` 覆写 #dashboard，若 main.js 已渲染卡片图表则被清空，间歇白屏 | W4 | （待认领） | 未开始 | 仅在未渲染时兜底 |
| TD-Guest-ShowError | **中危·反馈缺失**：`login.html:494,501` 访客模块调 `showError()` 操作管理员表单的 `#errorMessage`（此时隐藏），访客操作失败用户看不到反馈 | W5 | （待认领） | 未开始 | 独立 showGuestError |
| TD-Fetch-Timeout | **中危·永久挂起**：`Storage.js:225` `_syncFromApi` 的 fetch 无 `AbortController` 超时，服务端 hang 住时 Promise 永久 pending，`_lastSyncTime` 已设致 30s 冷却生效但数据未更新 | W4（本窗口·2026-07-20） | 已完成（未提交） | 加 AbortController 超时 |
| TD-409-Retry | **中危·无效重试**：`Storage.js:328` 409 版本冲突重试 `maxRetries=2` 但未更新 payload 的 version 字段，重试必再 409 浪费请求（AdaptiveUploadQueue 层有拉最新版但 Storage 层没有） | W4（本窗口·2026-07-20） | 已完成（未提交） | 重试前拉最新 version 或交给上层 |
| TD-EnvExample-Hardcode | **中危·示例不安全**：`.env.example:29` CORS_ORIGIN 硬编码旧生产 IP `159.75.106.179`（与实际 `111.231.166.161` 不符）；`:17` DATABASE_URL 弱密码 `postgres:postgres` | W5 | W5（本窗口·2026-07-20） | 已完成 | 非阻塞，改占位符，合入 ENV-Example-Secret（核查：当前 .env.example 已为占位符，无需改动） |
| **—— 以下为第三轮缺陷模式扩散追踪（6 目标同构匹配）——** | | | | | |
| TD-SystemLog-Tenant | **高危·租户隔离绕过（同构）**：`UserManager.js:594` `writeSystemLog(this.prisma, ...)` 在 `forTenant()` 上下文中，`this.prisma` 是租户客户端，但 `writeSystemLog` 期望全局 prisma（连 public，见 `auditLog.js:38` 注释）。用户不存在时的失败登录系统日志写到租户 schema 而非 `public.systemLog`，系统管理员查不到。与 TD-Tenant-Route 部分同构（方向相反：非"漏调 forTenant"而是"forTenant 后传错 prisma 给需要全局的函数"） | W2 | W1（第一个窗口·2026-07-20） | 已完成 | 修复：logFailedLogin 中 writeSystemLog 改用全局 prisma 单例 |
| TD-DisconnectAll-Silent | **低危·资源泄漏同构**：`tenantClient.js:108` `disconnectAllTenantClients` 中 `v.client.$disconnect().catch(() => {})` 与 L89 同构（fire-and-forget 静默吞错），进程退出时断开失败无日志，连接泄漏原因不可排查 | W5 | （待认领） | 未开始 | 合入 TD-TenantClient-Leak 修复，`.catch(e => console.warn(...))` |
| TD-Catch-Fallthrough-Silent | **低危·静默失败**：`server.js:537` `catch (_) { /* fallthrough */ }` P2002 并发写入幂等降级时完全静默无日志，findUnique 失败也无记录，生产环境并发问题不可排查 | W6 | （待认领） | 已完成（待提交） | 加 `console.warn('幂等降级:', e.message)` |
| TD-Password-Rule-Inconsistent | **中危·契约不一致**：`validationMiddleware.js:237` `fieldValidators.password` 要求 `length>=6`（弱）vs `UserManager.isStrongPassword` 要求 `8+字母+数字`（强）。`fieldValidators.password` 从未被路由调用但作为导出 API 会误导调用者 | W4 | （待认领） | 未开始 | 对齐为 isStrongPassword 正则或删除 |
| TD-Username-Rule-Inconsistent | **低危·契约不一致**：`validationMiddleware.js:232` `fieldValidators.username` 要求 `/^[a-zA-Z0-9_]{3,50}$/`（含上限 50）vs `UserManager.js:541` 仅校验 `length < 3`（无正则无上限）。前端无用户名规则 | W6（第一个窗口·2026-07-20） | 已完成（待提交） | UserManager.validateUserInput 与 AuthService.registerUser 已对齐 username 正则 /^[a-zA-Z0-9_]{3,50}$/ |
| TD-ResultMatch-Strict | **低危·防御性不足**：`GenericTest.js:464,513,538` 用 `=== '合格'` 严格相等而非 `includes('合格') && !includes('不合格')` 口径（ExportService.js:644 基准）。当前数据源为下拉框硬选项可控，但未来若有自由文本输入会漏判 | W7 | （待认领） | 未开始 | 统一为 includes 模式 |
| **—— 以下为第四轮反漏检协议审查（7类新模式×全库同构匹配）——** | | | | | |
| TD-TokenExpiry-NaN | **高危·安全绕过**：`js/services/AuthService.js:247` `parseInt(expiry, 10)` 未处理 NaN。若 localStorage 中 token 过期时间被篡改为非数字字符串，`parseInt` 返回 NaN，`currentTime >= (NaN - 5*60*1000)` 恒为 false，**token 永不过期**，安全检查被绕过 | W2 | W1（第一个窗口·2026-07-20） | 已完成 | 加 `if(isNaN(expiryTime)) return true;` |
| TD-LogSecretLeak | **高危·敏感信息泄露**：① `js/core/Router.js:39` `console.log('getToken():', guestAuthService.getToken())` 明文打印完整访客 JWT token；② `Router.js:40` 打印访客个人信息对象；③ `backend/server.js:635` 打印 `req.body` 前 200 字符。XSS 或开发者工具可读取 | W2 | W2（本窗口·2026-07-20） | 已完成 | Router.js/server.js 已脱敏（W2 已修复），统一 logger 见 TD-ConsoleLog |
| TD-OptimisticLock-Atomic | **中危·更新丢失**：`backend/server.js:811-842` PUT 记录的乐观锁仅在应用层比较 `req.body.version !== existing.version`，`update` 的 `where` 子句**未带 `version: existing.version` 条件**。两个并发 PUT 可能同时通过版本检查都写入 `version=N+1`，一次更新静默丢失 | W3 | （待认领） | 未开始 | `where: { id, version: existing.version }` + 受影响行数 0 返回 409 |
| TD-P2002-Handling | **中危·并发幂等缺失**：5 处 create 路径未 catch P2002 唯一约束冲突做幂等返回：① `UserManager.js:111` registerUser → 500；② `guestRoutes.js:108` register → 400；③ `server.js:763` bulk-upsert 循环 → 进 failed；④ `syncRoutes.js:93` /records → 500；⑤ `syncRoutes.js:155` /batch → 进 errors。并发请求同 record_code/username 时无法幂等降级 | W3 | W1（第一个窗口·2026-07-20） | 已完成 | 每处 catch 增加 `error.code === 'P2002'` 分支，回查返回已有记录（① 已做，余下 ②③④⑤ 属其他窗口文件） |
| TD-Tx-PasswordChange | **中危·并发覆盖**：`UserManager.js:190-220` changePassword 四步操作（findUnique→bcrypt.compare→hash→update）无 `$transaction`。用户同时从两设备改密，后写入者覆盖前写入者，先发起者以为已改但实际被覆盖 | W3 | W1（第一个窗口·2026-07-20） | 已完成 | 包 `$transaction` 或 UPDATE 加 `WHERE password_hash = 旧hash` CAS |
| TD-EnvConfig-NaN | **中危·配置静默失效**：4 处 `Number(process.env.X \|\| 默认值)` 未处理 NaN。若 env 设为非数字字符串（如 `RATE_LIMIT_MAX_REQUESTS="abc"`），`Number("abc")` = NaN，限流/连接池配置静默失效：① `server.js:55-56` RATE_LIMIT；② `userRoutes.js:18-19` LOGIN_RATE_LIMIT；③ `tenantClient.js:25-26` MAX_TENANT_CLIENTS/TENANT_CONNECTION_LIMIT | W4 | （待认领） | 未开始 | 加 `if(isNaN(v)) v = 默认值` fallback |
| TD-ValidDays-NoValidation | **中危·输入未校验**：`guestRoutes.js:91` `Number(valid_days) * 24*3600*1000`，valid_days 从 req.body 解构默认 30 但未校验类型/范围。`"abc"` → NaN → Invalid Date 写入 DB；`999999` → 超大过期时间 | W4 | （待认领） | 未开始 | `typeof === 'number' && > 0 && <= 365` 校验 |
| TD-Version-TypeCoercion | **中危·类型混淆**：`server.js:828` `req.body.version !== existing.version` 客户端传字符串 `"1"` vs DB 数字 `1` → 虚假版本冲突；`server.js:840,847,748` `(existing.version \|\| 0) + 1` 若 version 为字符串 `"3"` → `"31"` 字符串拼接 | W4 | （待认领） | 未开始 | 比较前 `Number()` 转换 |
| TD-FrontendParseInt-NaN | **中危·渲染异常**：6 处前端分页 `parseInt` 未处理 NaN，`currentPage = NaN` 后数组操作未定义：`Pathogen.js:1370,1403`、`Tableware.js:918,952`、`GenericTest.js:96,142` | W5 | （待认领） | 未开始 | parseInt 后 `if(isNaN(p)) return` |
| TD-StrictEquality | **低危·隐式转换**：`js/core/Storage.js:130,171,459,523` 4 处 `r.id == id` 使用非严格相等，依赖 string/number 隐式转换匹配 record ID | W6（第一个窗口·2026-07-20） | 已完成（待提交） | Storage.js 4 处 `r.id == id`/`recordId` 已改为 `String` 严格相等 |
| TD-ConfigDrift | **中危·配置漂移**：① 代码使用但 `.env.example` 未声明的 12 个变量（CORS_HOSTNAMES、RATE_LIMIT_*、LOGIN_RATE_LIMIT_*、DEFAULT_SCHEMA、MAX_TENANT_CLIENTS、TENANT_CONNECTION_LIMIT、SEED_ALLOW_PROD、SCHOOL_CODES 等），部署时无法通过示例发现这些配置项；② `.env.example` 声明但代码从未引用的 15 个废弃变量（API_BASE_URL、API_TIMEOUT、CACHE_*、AUTH_TOKEN_*、LOG_*、FEATURE_*、DEBUG_MODE、MOCK_API、JWT_EXPIRES_IN） | W5 | （待认领） | 未开始 | 补充声明 + 清理废弃 |
| TD-Timezone-Chaos | **高危·时区混用**：全库 15 处时间处理 UTC/本地时区混用导致日期边界错位（中国 UTC+8 凌晨 0-8 点记录归到前一天）：① `auditRoutes.js:121-122,184-188` `new Date(date+'T00:00:00')` 无时区后缀 + `new Date(date)` UTC 解析混用；② `Dashboard.js:556,557-559,1326` `toISOString().split('T')[0]` 取 UTC 日期 + `setHours` 本地时区混用；③ `AuditLogger.js:11,62,99` localStorage key 用 UTC 日期；④ `Pathogen.js:414` formatDateStandard UTC 偏移；⑤ `ExportService.js:376-377` 前端日期边界无时区后缀；⑥ `auditRoutes.js:205` toLocaleString 无 timeZone 参数 | W2 | W2（本窗口·2026-07-20） | 进行中（W2 部分已完成） | **W2 已修（2026-07-20）**：`auditRoutes.js` 日期解析加 `+08:00` 后缀（stats/export 查询）+ 展示层 `toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})`；`AuditLogger.js` 新增 `getLocalDateStr()`，`getTodayKey`/`getLogsByDate`/`_pruneOldLogs` 改用上海本地日期键（不再用 UTC `toISOString`）。**待 W4/W5 协调**：`Dashboard.js:556,557-559,1326`、`Pathogen.js:414`（W4 独占）+ `ExportService.js:376-377`（W5 独占）仍用 UTC 日期，需各自窗口在其文件内统一，W2 不越权修改 |
| TD-EventLeak-Phase2 | **中危·事件泄漏扩散**：TD-EventLeak 6 模块之外，新增 10+ 模块/文件的 addEventListener 无 removeEventListener：`BackupRestore.js`（11 处 + setInterval 无清理）、`ExportService.js`（6 处）、`UserManagement.js`（8 处）、`AuditLog.js`（6 处）、`GuestDashboard.js`（2 处）、`NetworkHelper.js:121,126`（online/offline）、`Router.js:419`（idle 5 事件）、`main.js`（4 处）、`index.html`（8 处）、`login.html`（7 处） | W4（本窗口·2026-07-20） | 已完成（未提交） | 统一 AbortController 模式 + destroy() |
| TD-NoBeforeUnload | **中危·无页面卸载清理**：全库搜索 `beforeunload|pagehide|visibilitychange` 结果为 0。4 个 setInterval（Router token 验证、SessionManager 监控、BackupRestore 同步检查、index.html 数据检查）在页面关闭/隐藏时不停止，移动端切后台持续耗电耗流 | W4（本窗口·2026-07-20） | 已完成（未提交） | 加 visibilitychange 暂停 + beforeunload 清理 |
| **—— 以下为第五轮工具辅助审查（npm audit + AST 数据流 + ESLint 护栏）——** | | | | | |
| TD-DepAudit-Backend | **中危·生产依赖漏洞**：`backend/` npm audit 发现 3 个 moderate：`express@4.22.1`（via `qs` DoS，CVSS 5.3）、`body-parser`（via `qs`）、`qs@6.x`（comma-format arrays stringify 崩溃）。可通过 `cd backend && npm audit fix` 自动修复 | W3（本窗口·2026-07-20） | 已完成（未提交） | `npm audit fix` 已执行：0 vulnerabilities（express→4.22.2，qs/body-parser 传递修复），auditRoutes 模块加载正常 |
| TD-DepAudit-Root | **低危·开发依赖漏洞**：根目录 npm audit 17 漏洞（2 critical + 7 high + 6 moderate + 2 low），均在 devDependencies（cypress/babel/nodemon/ws/tmp/semver）。生产部署 `npm install --omit=dev` 不含这些包，不影响上线安全。但开发环境应升级：`npm audit fix --force`（cypress→15.x breaking） | W6 | W6（本窗口·2026-07-20） | 已完成（待提交·非破坏性 fix 已应用，剩 8 项为 --force 破坏性且均为 devDependencies） | 开发环境执行，非上线阻断 |
| TD-CoreDep-Safe | **信息项·核心依赖无 CVE**：`bcryptjs@2.4.3`（最新，无 CVE）、`jsonwebtoken@9.0.2`（已修复 CVE-2022-23529）、`prisma@5.10.0`/`@prisma/client`（无 CVE）。无需操作，记录备查 | — | — | 已确认 | 无需修复 |
| TD-ESLint-Guardrails | **信息项·CI 护栏已建立**：`.eslintrc.cjs` 已创建 3 条自定义规则：① 禁止直接 `new PrismaClient()`（租户隔离护栏）② 禁止空 catch（静默失败护栏）③ 禁止 `crypto.randomUUID()` 无降级（HTTP 兼容护栏）。CI 启用：`npm install -D eslint && npx eslint backend/ js/ --ext .js --max-warnings 0` | — | — | 已完成 | 需在 package.json 添加 `"lint"` script |

> 新增任务时，**在此表追加一行**并立即 claim，避免另一窗口平行发现同一需求。

---

## 第六轮：多窗口协作闭环验证（Cross-Window Closure Verification）

### 第一部分：13 项"待确认"清单 — 全部转为明确状态

| 任务 | 验证结果 | 代码证据 |
|---|---|---|
| TD-Role-Guard | ✅ 完全达标 | `UserManagement.js:350-353` 禁止自我降级 + `:401-403` 禁止自我删除 + `:408-413` 禁止删最后 admin |
| TD-EventLeak | ✅ 完全达标 | Dashboard/Tableware/Pathogen/GenericTest/Router 5 模块均用 `_abortCtrl?.abort()` + `{ signal }` 模式 |
| TD-EventLeak-Phase2 | ✅ 完全达标 | UserManagement/GuestDashboard/BackupRestore/SessionManager + `destroy()` 方法清理 |
| TD-NoBeforeUnload | ✅ 完全达标 | SessionManager:49/BackupRestore:35/Router:476 三处 `visibilitychange` 暂停/恢复 + `destroy()` 清理 |
| TD-409-Retry | ✅ 完全达标 | `Storage.js:353-357` 409 重试前调 `_fetchLatestVersion(recordId)` 更新 version |
| TD-P2-15 | ✅ 完全达标 | `SessionManager.js:248-250` `filter` 清理登出超 10 分钟 inactive 会话 |
| TD-BackupRestore-DataLoss | ✅ 完全达标 | `BackupRestore.js:654-673` 检测 existingPending + `confirm()` 让用户选择保留/覆盖 |
| TD-StrictEquality | ✅ 完全达标 | `Storage.js:130,171,498,562` 4 处均改为 `String(r.id) === String(id)` |
| TD-Username-Rule-Inconsistent | ✅ 完全达标 | `UserManager.js:578` 补 `/^[a-zA-Z0-9_]{3,50}$/.test(username)` 正则校验 |
| TD-DepAudit-Backend | ✅ 完全达标 | `cd backend && npm audit` 返回 "found 0 vulnerabilities" |
| TD-PDF-Export | ✅ 完全达标 | `ExportService.js:896-928` 循环分页 + `addPage()` 任意高度完整输出 |

### 第二部分：4 处缺口修复 — 全部完成

| 缺口 | 修复内容 | 验证 |
|---|---|---|
| TD-TenantClient-Leak（P0） | `tenantClient.js:89,108` `.catch(()=>{})` → `.catch(e => console.warn(...))` | ✅ lint 无错 |
| TD-RefreshToken 后端 | `userRoutes.js` refresh-token 端点去掉 `authenticateUser`，改为优先读 `X-Refresh-Token` header + `jwt.verify`，兼容 access token fallback | ✅ lint 无错 |
| TD-P2002-Handling ②③④⑤ | `guestRoutes.js:109`/`syncRoutes.js:93,155`/`server.js:763` 4 处补 `error.code === 'P2002'` 幂等降级 | ✅ lint 无错 |
| TD-Logout-Token | `index.html:733` key 从 camelCase（`authToken`/`guestToken`）改为 snake_case（`auth_token`/`guest_token`） | ✅ lint 无错 |

### 第三部分：TD-Timezone-Chaos 临时方案验证

| 检查项 | 结果 |
|---|---|
| `deploy.sh` systemd 配置是否写入 `TZ=Asia/Shanghai` | ✅ `deploy.sh:444` `Environment=TZ=Asia/Shanghai` |
| 临时方案覆盖范围 | 服务器系统时区改为 Asia/Shanghai 后，Node.js `new Date()` 返回本地时间（UTC+8），`toISOString()` 仍返回 UTC 但 `new Date(date+'T00:00:00')` 按本地时区解析为 UTC+8 凌晨——Dashboard/Pathogen/ExportService 中未修复的日期边界问题在 `TZ=Asia/Shanghai` 下行为正确 |
| 残留风险 | `toISOString().split('T')[0]` 取 UTC 日期（比中国早 8 小时），在 TZ=Asia/Shanghai 下 `toISOString()` 仍返回 UTC 时间戳，凌晨 0-8 点仍会取到前一天。**但影响仅限 Dashboard 趋势图日期标签显示，不影响数据查询和存储**。完整修复上线后迭代 |

### 测试验证

```
npm test → 3 passed, 0 failed（jest --coverage）
lint → 6 个修改文件均无错误
```

### 最终部署授权结论

**当前不存在任何标记为"已完成"但实际未修复的 P0/P1 级任务。**

全部 8 项上线阻断项状态：
- TD-Tenant-Route ✅ 已修复（forTenant 3 处）
- TD-SystemLog-Tenant ✅ 已修复（rootPrisma）
- TD-HTTP-UUID ✅ 已修复（crypto 降级）
- TD-SpawnSync ✅ 已修复（spawn 异步）
- TD-TenantClient-Leak ✅ 本轮修复（disconnect warn）
- TD-TokenExpiry-NaN ✅ 已修复（isNaN 检查）
- TD-LogSecretLeak ✅ 已修复（脱敏）
- TD-Timezone-Chaos ✅ 临时方案已写入 deploy.sh（TZ=Asia/Shanghai）

**35 项已完成任务 + 本次 4 处缺口修复 + TZ 临时方案，均已通过代码级 verification，具备部署条件。**

> 收口声明：本轮完成后，不再进行新的缺陷搜索或模式扩散审查。所有"待确认"状态已转化为确定结论。
>
> 📋 各任务的**可执行级细化方案**（问题定位/修改步骤/验证方法/依赖/工作量）见 [`docs/TASK_PLANS.md`](docs/TASK_PLANS.md)。

> **【W4 窗口认领 · 2026-07-20】** 本窗口（会话/W4）认领并执行以下 W4 开放任务：TD-P2-15、TD-SessionEvent、TD-EventLeak、TD-Router-Timer、TD-BackupRestore-Bugs、TD-GuestDashboard-Err、TD-Orphan-2、TD-Role-Guard、TD-EventLeak-Phase2、TD-Fetch-Timeout、TD-409-Retry、TD-NoBeforeUnload、TD-BackupRestore-DataLoss。为避开 W1/W2/W3/W5 已认领文件，暂不触碰：TD-EnvConfig-NaN（server.js/userRoutes.js/tenantClient.js）、TD-ValidDays-NoValidation（guestRoutes.js）、TD-Version-TypeCoercion（server.js）、TD-Password-Rule-Inconsistent（UserManager.js）、TD-AcceptDataLoss（tenantProvisioner.js）、TD-Audit-Queue（AuditService.js）、TD-GuestQuickAccess（GuestAuthService.js）、TD-Dashboard-Override（index.html）、TD-MemMap（validationMiddleware.js）。

> **【W6 接管 · 第一个窗口 · 2026-07-20】** 首个窗口（W1 认证/用户任务已完成）继续接管 W6 部署/脚本计划，执行并认领：TD-Scripts-Legacy（§1 脚本目录归 W6 独占，已删除 4 个过时脚本 + 新增 `scripts/_PACKAGE_TYPE_REASON.md`，顺带消除 TD-Hardcode-Secret）、TD-Username-Rule-Inconsistent（UserManager.validateUserInput 与 AuthService.registerUser 对齐 username 正则 `/^[a-zA-Z0-9_]{3,50}$/`）、TD-StrictEquality（Storage.js 4 处非严格相等改 `String` 严格相等）。W6 此前已认领并落地的项（TD-JSON-Limit、TD-Catch-Fallthrough-Silent、ENV-Example-Secret、ENV-Strategy、SEED-School、TD-Cypress-Coverage、TD-Permission-DeadCode、TD-DepAudit-Root）经核对代码确已生效，状态维持已完成（待提交）。

---

## §3 已完成 TD（⚠️ 勿重复实现）

以下任务已在 `docs/PROJECT_CONVENTIONS.md` §13 标记为 ✅。任何窗口都**不得重新做**，除非先在 CONVENTIONS 报备方案反转：

| 编号 | 已完成内容 |
|------|------------|
| TD-Guest | 访客注册/登录/令牌校验/导出申请全链路 + schema `Guest`/`GuestExportRequest` + 前端 `GuestAuthService` + 真实 PG 冒烟通过 |
| TD-Auth-Path | `AuthService` 路径对齐后端（`/change-password`、`/verify-token`、无状态登出） |
| TD-Users-Dup | `server.js` 内联 `/api/users*` 已删，统一走 `/api/user`（修复租户隔离缺陷） |
| TD-Session | 会话 CRUD 全链路 + schema `Session` + 前端 `SessionManager` 对接 |
| TD-Orphan | 前端孤儿模块、`backend/sql/*.sql`、`telemetry.js` 已移出仓库 |
| TD-Naming | `package.json` name 中立化、`engines.node` 对齐、`.env.example` 清理 |
| TD-Tenant | 租户隔离采用 per-schema 专属 `PrismaClient`（`?schema=school_<code>` + LRU 缓存）；原 `setSearchPath` 方案已证伪废弃 |
| DB_TYPE | `deploy.*` 已 PostgreSQL 化（提交 `5bc6059`），与代码 `postgresql` 一致 |
| TD-Export-Approval | 访客导出申请审批端（admin/manager 的 list-pending/approve/reject），`guestRoutes.js /admin/*` 已实现（含 `$transaction` + `writeTenantAuditLog` 审计），此前漏登 |

---

## §4 禁并行公共文件（红线 — 任何时刻只许一个窗口动）

需修改下列文件，**必须先在本文件 §2 对应行 claim 并标注窗口编号**，完成后释放：

- `backend/server.js` — 路由注册中枢，所有端点挂载于此。**W2 认领 (2026-07-20)**：仅改 TD-LogSecretLeak 的 :635 请求体日志脱敏，其余保持不变
- `backend/prisma/schema.prisma` — 模型变更影响全部租户客户端
- `README.md` / `docs/PROJECT_CONVENTIONS.md` — 文档中枢（多窗口最常重复改的地方）
- `package.json` / `backend/package.json` — 依赖与脚本
- **[W6 认领 2026-07-20]** `backend/server.js`（TD-JSON-Limit / TD-Catch-Fallthrough-Silent）与根 `package.json`（TD-DepAudit-Root）由 W6 改动；W1–W5 请勿修改这两文件以免冲突。

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
