# R8 · 全仓深度审查总报告（2026-09-29）

> 目标：**问题找齐、不留空白**。本轮覆盖全仓 308 个源码文件（含此前未触达的前端 45 个模块、21 个 utils、111 个测试、17 个迁移 SQL、33 个运维/部署脚本、6 个中间件）。
> **本轮不做任何修复**：未改产品源码、未改数据库、未启停服务、未运行任何脚本。
> 执行方式：11 路并行只读探查（A1/A2/A3 后端、B 迁移、C1/C2/C3 前端、D1/D2 测试与配置、E 脚本部署、F 复核 R7 候选），结论均已回读源码坐实行号。
> 新增登记：**SRV-241 … SRV-352**（含合并进既有 SRV-2xx 的重复项）。

## 一、覆盖率（R8 之后）

| 口径 | R8 前 | R8 后 |
| --- | --- | --- |
| ① 逐行坐实（回读、行号入报告） | ≈4% | **12%（37 / 308）** |
| ② 候选级扫过（逐文件读过，未逐条复核） | ≈40% | **86%（266 / 308）** |
| ③ 未触达 | ≈56% | **2%（5 / 308）**（仅 `frontend/vendor/**` 第三方压缩产物） |

口径说明：以上按 `R8_FILE_INVENTORY_20260929.md` 的**逐文件标签**统计（总数 308），非行数加权；行数口径下 ② 的权重更高（前端 modules 与测试占大头）。

覆盖标签已回填至 `R8_FILE_INVENTORY_20260929.md`（①/②/③ 逐文件可核对；**第三方 min 产物与不可读运行时目录保持 ③**）。

## 二、总览

| 严重度 | 新增条数（SRV-241…352） |
| --- | --- |
| **P0** | **1**（SRV-231 已确认族：餐具/病原体存储型 XSS 全链） |
| **P1** | **14** |
| **P2** | **58** |
| **P3** | **39** |
| 合并入既有条目 | 7（SRV-211/214/217/228/232/235 等） |

**R8-F 复核结论**：R7 的 40 条候选 → **CONFIRMED 23 / DOWNGRADED 17 / REJECTED 0**；无一条升级为 P0。复核同时纠偏 4 处行号/引用漂移（SRV-203 的 668/693 与 1179 引用有误；SRV-233/225 路径补全；SRV-240③ 证实 `tests/frontend` 目录不存在）。

## 三、P0 / P1（必须优先处置）

**SRV-231（P0，R8 复核确认）餐具/病原体存储型 XSS 全链成立**
`frontend/js/modules/Tableware.js:971-999,1605-1624,1646-1695`、`Pathogen.js:783-786,1399-1402,1599`：`innerHTML` 直拼 `inspector/canteen/loc/res/correctiveAction/recheckResult`；写入侧 `backend/lib/sanitize.js:7-16` **只清键不清值** → 数据原样落库。任意 operator 写入 `<img src=x onerror=…>`，管理员/主管/访客打开列表或详情即执行，可窃取 localStorage 内 access/refresh token。同文件已定义 `escAttr`（`:1237`）却仅在 `:1550` 用一次。

**SRV-262（P1）租户就绪门禁可被请求体 `schoolCode` 旁路**
`backend/server.js:314-320`：`tenantSchoolHint()` 取值顺序 path → **body** → token 载荷；`:361-369` 仅当 hint ∈ blockedSchools 才 503。被阻断学校的合法用户发 `POST /api/records/oil` 并附 `"schoolCode":"otherschool"` 即放行写入。修复方向：门禁只认已验签 token 的 schoolCode。

**SRV-274（P1）租户回放把裸对象名解析到 `public`，且破坏性语句无 `IF EXISTS`**
`backend/lib/tenantProvisioner.js:1717`（回放 `search_path = "<schema>", public, pg_catalog`）× `20260814000000_remove_backup_model/migration.sql:8-15`（`DROP TABLE "Backup"` 等 4 条无 `IF EXISTS`）。轻则该校 42P01 → 503；重则租户事务删掉 public 的表/索引/约束并连锁阻断 public 链。同类裸名：`20260825120000:57`、`20260816000000:13`、`20260927140000:110-111`。

**SRV-275（P1）`20260814040000` 扫全库改所有非 public schema（含回滚点/回收站），坏行即全平台阻断**
`20260814040000_json_fields_to_jsonb/migration.sql:40-52`：`WHERE table_schema <> 'public'` 无白名单 → 命中 `recycle_*`、`school_*_old_*`（不在任何台账内，**不可逆**）；无 `EXCEPTION`，任一行非法 JSON → 22P02 → `migrate deploy` 失败 → 全平台 503。

**SRV-277（P1）M1 在 expand 阶段就加"立即生效"的 CHECK**
`20260927130000_lifecycle_audit_principal_expand/migration.sql:64-70`：`CHECK (principal_id IS NOT NULL) NOT VALID` 对新写入**立即生效** → 未改造的写入路径插 AuditLog 即 23514；`EXCEPTION WHEN duplicate_object` 还会静默接受同名异定义约束。

**SRV-278（P1）M2 把大批量回填塞进迁移、残量硬 RAISE、`SET NOT NULL` 不可逆**
`20260927140000_lifecycle_audit_principal_enforce/migration.sql:39-47,100-111`：全表 `UPDATE "AuditLog"` + JOIN 无批次/水位 → 长事务/行锁/膨胀；残量即 RAISE → 该校 fail-closed 直至人工映射。

**SRV-241（P1）`BACKUP_KEEP_DAYS=0/负值` 被静默改成 7 天，清理照常删备份**
`backend/lib/backupService.js:66-69`（`Number.isFinite(v) && v >= 1 ? v : 7`）、`:671`（`if (!(keepDays() > 0)) return 0` 恒不成立）、`:682`（删 `.aes` 与 `.meta.json`）。运维以为"已禁用清理"，实际照删且 meta 被删即恢复链断。

**SRV-275…（迁移侧共 4 条 P1 见上）**

**SRV-296（P1）测试任务面板重复 `id` → 结论与证据错位**
`frontend/js/modules/adminSchools/views/testReports/tasksView.js:276,281-283,298-302`：面板各自创建 `#trFileInput/#trEvidence/#trDetail/#trSubmit`，`document.getElementById` 永远命中第一个；同时展开两行时，B 的 caseKey 配上 A 的 detail 与证据提交，且追加式写入不可撤回。

**SRV-297（P1）切校时 `await` 后未校验当前学校 → 跨校定制串写**
`frontend/js/modules/adminSchools/views/schoolDetailView.js:62-64` + `customization/loadSave.js:25-26,46`：A 的响应后到会覆盖 `state.*`，随后"保存定制"把 A 的配置 PUT 到 B（乐观锁基准也来自被覆盖状态）。

**SRV-308（P1）仅持 guest_token 的访客会话 60 秒后被强制登出**
`frontend/js/core/Router.js:429-432,516-517` + `main.js:154-155`：`validateAndRefreshToken()` 只认 `authService.getToken()`，无访客分支；定时器对所有身份无条件启动 → 访客/快速访问被清并跳登录页。替代修复方向：`guestAuthService.isLoggedIn()` 短路。

**SRV-319（P1）关键回归用例的条件断言使字段被删时"自动通过"**
`backend/tests/http/openapi-http.integration.test.mjs:415-421`：`if (item.result.recheckRecords) { … }` 包住"复检人姓名必须剔除"与"最终结论=pass"两条核心断言；而同码 `RC-http-1` 在 before 钩子已插入过一次（`:97-112`），`find` 命中哪条不确定 → 最坏情况该断言从未执行。

**SRV-331（P1）`npm test` 串行顺序把 unit 面绑死在真库门禁上**
`package.json:8`（`test:db && test:unit`）+ `jest.db.config.cjs:16-22` + `tests/helpers/db-isolation-setup.cjs:14-27`：门禁在模块加载前 `throw` → 缺 `TEST_DATABASE_URL`/`TEST_DB_CONTEXT_FILE` 的环境下 28 个 unit 文件**一个都不执行**，rc≠0。即"结构性不覆盖"，而非假绿。

**SRV-332（P1）大量测试套件不在 `npm test` 内**
`tests/integration/**`（`jest.config.cjs:33` 显式 ignore）、`tests/isolation/**`（独立 config）、`backend/tests/**`（仅 `test:backend` 跑）、`cypress/**`；`tests/frontend/` **目录不存在**（`jest.frontend.config.cjs` fail-closed）。

**SRV-333（P1）仓库没有任何会跑测试的 CI**
唯一 workflow `.github/workflows/guard-client-branch.yml` 只在 `deploy/**` push 时做 diff 检查；`package.json` 无 `ci`/`test:ci`。所有测试结论目前只能靠人工在本地跑。

**SRV-343（P1）PG 数据目录迁移在复制失败时仍删除原目录**
`deploy/deploy.sh:88-92`：无 `set -e`，`rsync || cp` 同时失败后仍执行 `rm -rf "$cluster_dir"` 并建软链 → 数据目录被删、可能整库不可启动（不可逆）。

**SRV-344（P1）两段发布入口 b1 不可用**
`backend/scripts/b-release-two-phase.sh:40,56-58,72`：`npx prisma migrate deploy` 在**仓库根**执行（根无 `prisma/`、无 `node_modules/.bin`）→ 首步即失败；`APP_NAME` 默认 `foodtestlab`，线上服务名为 `foodsentinel-api`。

## 四、P2 清单（58 条，按域）

**后端 lib（a–l）**：SRV-242 `DATABASE_URL` 含口令进 pg_dump argv(`backupService.js:199`)｜SRV-243 `dumpCounts.js:100` 源读流无 error 监听→uncaughtException｜SRV-244 `backupService.js:221+475-480` 快照降级判据被自身错误消息命中（`snapshot=` 文本）｜SRV-245 `conclusionVerdict.js:58/87/117` `btrim` 只去 ASCII 空格 vs JS `trim()`→同一记录两套结论｜SRV-246 `exportJobs.js:45,46,51` `Number(env)` 无有限性校验→导出行数上限失效（fail-open）｜SRV-247 `exportJobs.js:65-73` jobId 未校验形态→`path.join` 越界读（写链待证实）｜SRV-248 `fieldOptionService.js:148-166` count→create 非原子无唯一约束｜SRV-249 `backupJobs.js:191` `assertInside(dirname(p),p)` 恒真（防线不存在）｜SRV-253 `sessionEpoch.js:181-190` epoch 未用 `GREATEST`→并发提交序倒置时吊销水位回退｜SRV-254 `UserManager.js:1276-1284` "最后一名 manager" count-then-write TOCTOU｜SRV-255 `UserManager.js:1620-1637` 建用户与改申请状态非原子→申请永久 pending｜SRV-256 `UserManager.js:1120-1158` 真值门控→空串绕过白名单｜SRV-257 `UserManager.js:1470-1478` `verifyToken` 不校验吊销/状态｜SRV-258 `restoreService.js:622-626` 把 meta 表名拼进 SQL 标识符｜SRV-259 `restoreService.js:97-100` psql argv 含口令（对照 provisioner 的 PGPASSFILE 方案）｜SRV-260 `UserManager.js:1507-1527` 免认证申请端点枚举 + 口令仅校验长度｜SRV-261 `UserManager.js:1439-1444` 失败登录审计/自动停用计数吞错（安全控制静默失效）｜SRV-263 `tenantWriteBarrier.js:90-98` 挂载在认证前→`req.user` 恒空、精确屏障失效｜SRV-264 `validationMiddleware.js:368-389` + `server.js:147,153` 限流表只增不删 + `trust proxy=1` 硬编码→限流可绕 & 内存无界｜SRV-265 `openApiAuth.js:39,49-54` lastDenyLog 无 TTL/上限（未认证可写）｜SRV-266 `server.js:184-189` 30MB/25MB body 在认证前解析｜SRV-267 `server.js:573` `/readyz` 回显未脱敏错误（同文件 `:560` 已脱敏）｜SRV-268 `idempotencyMiddleware.js:30-37,182-184` 幂等 store 全局配额→占满即跨租户 429｜SRV-271 `server.js:497-503` 错误处理器不检查 `headersSent` 且无 404 处理器｜SRV-272 幂等 pending 只挂 `res.json`（`:187-198`）→非 JSON 响应残留 60s 后重复执行｜SRV-273 `authMiddleware.js:536-545` fail-soft 下 `req.db` 回落 public（跨租户读取窗口）

**迁移**：SRV-276 三个扫全库 DO 块漏排 `_stg_`/`_restore`（`20260825000000:53-54`、`20260915120000:97-98`、`20260928120000:59-60`）｜SRV-279 `20260825120000:56-57` `DROP TABLE IF EXISTS "TestResult"` 无空表断言｜SRV-280 两个 public-infra 迁移形状自证硬失败且不自愈（`20260926120000:66-68`、`20260926120100:64-76`）｜SRV-281 `20260816000000:7-13` 唯一索引无去重前置（且会在租户表上执行）

**前端**：SRV-284 `auditView.js:333` 前端发 ISO vs 后端只认 `YYYY-MM-DD`（`auditRoutes.js:152`）→日期筛选静默失效｜SRV-286 `loginStyleDesigner.js:453` GET 失败用空 `theme_config` 整列覆盖→主题配置丢失｜SRV-287 `issuesView.js:196,207,213` 重复 id→复测串写｜SRV-288 `Dashboard.js:753,761,1129,1255` `visible_types` 裁剪→`undefined` 抛错中断渲染｜SRV-289 `loginPage.js:140,231` logoUrl 未转义拼 `innerHTML`（含内联 onerror）｜SRV-298 `Pathogen.js:1612-1623 vs 1444-1445,990-996` 风险等级列表重算/详情读存储→两套口径｜SRV-299 `openApiView.js:415-416` 授权全取消时跳过确认→静默清零｜SRV-300 `UserManagement.js:425-431 vs 211-216` 分页与渲染不一致｜SRV-301 `UserManagement.js:173-177,568` 角色下拉缺 `admin`→空角色提交｜SRV-303 `Tableware.js:1666-1670` 详情弹窗缺旧数据防御→静默不可用｜SRV-306 `Tableware.js:1470-1507` `postMessage` 未校验 `origin/source`→可注入识别浓度｜SRV-307 `SampleDataGenerator.js:45-55` 条件恒假→示例数据永不生成｜SRV-309 `Storage.js:1007,1027,1102,1493` localStorage 无 QuotaExceeded 处理 + 指纹索引重复存整条｜SRV-310 `AuthService.js:611-619,768-785` 刷新后落 localStorage 绕过"记住我=false"｜SRV-311 `AuditLogger.js:31-34,96-103` 本地审计键无租户命名空间（多校串数据）｜SRV-312 `AdaptiveUploadQueue.js:226` fetch 无超时→单次悬挂令队列停摆｜SRV-313 `Storage.js:1085-1093` 快照不兼容即清空队列（仅记条数，不可人工恢复）｜SRV-320~D 见下

**测试与配置**：SRV-320 `openapi-http.integration.test.mjs:366-381` 用例名与断言相反（"无侧信道"实际只断言 +5）｜SRV-321 `startup-jwt-guard.test.mjs:196-199` 断言恒真（close 后 exitCode/signalCode 必有一非 null）｜SRV-322 `db-integration.test.mjs:92` 共享 schema 用 `findFirst` 取"自己的行"→断言他人数据｜SRV-323 真实库套件全局计数断言互相污染（`stats-verdict:178`、`oil-verdict-stats:54,111-119`）｜SRV-324 `w3r2cross-register-external.unit.test.mjs:89-93` 由假 Prisma 自证事务回滚｜SRV-325 `w2t02r4/r5/r6-unit`、`publicInfraChain/Followup.unit` 用**源码正则**判定控制流（把分支改成不可达仍通过）｜SRV-334 `jest.unit.config.cjs:30-33` `collectCoverageFrom` 指向不存在的 `Validator.js` 且全仓无 `coverageThreshold`｜SRV-335 全仓 **0 处** `expect.assertions`｜SRV-336 `auditUserFilter/window2AdminAudit/superAdminRoutes.test.js` 直接 mock 掉 `authMiddleware` 与 `auditLog`｜SRV-337 `cypress/e2e/records.cy.js:36-55` 断言 `[200,409]`/`[200,401,403]` 近乎恒真 + 硬编码凭据（`login.cy.js:9-10` 等）｜SRV-338 弱断言清单（`toBeDefined`/无参 `toThrow`，如 `backupKms.test.js:44-55`）｜SRV-341 全站无 CSP、vendor 脚本只有 `crossorigin` 无 `integrity`（`frontend/pages/index.html:136-138`）且页面含大量内联 script｜SRV-342 `index.html:799-808` 把后端值写入 DOM/CSS 变量、`admin-schools.html:1150-1158` 注释明示移除 iframe sandbox、`help.html:179`/`index.html:740` 表单 `novalidate`

**脚本/部署**：SRV-345 `deploy/deploy.sh:256-258` 首装预检 `git ls-remote` 要求仓库已 clone｜SRV-346 `deploy.sh:363,368,435,471` 口令进 argv + 用 `eval` 解析 `.env`（root 上下文命令注入面）｜SRV-347 `deploy.sh:653,704-705,1030-1038` 健康检查/seed/密码同步失败仅 `warn`，脚本仍 exit 0｜SRV-348 `deploy.sh:497-508` 备份密钥离线文件路径硬编码 `foodsentinel`（多实例互相覆盖）｜SRV-349 `fix-canteen-from-location.mjs:36-42,68-71,106-111` `JSON.parse(对象)` 必抛→永远 0 命中静默空转；命中则二次编码坏数据｜SRV-350 `backup-delete.mjs:91-107` 文件删失败仍删记录（孤儿产物）+ `--before` UTC 日界与本地日错位｜SRV-351 写操作门槛缺失：`004_backfill_audit_principals.mjs:57,68` 默认写库、`import-tjb/zhyz-backup.mjs` 默认写库、`005_cleanup-old-schemas.mjs:121-126` 非 TTY 永久挂起

**前端模块（C2 续）**：SRV-304 `schoolUsersView.js:20-35` 跨校覆盖｜SRV-305 `superAdminLoginPage.js:65-66` 对密码 `trim()` 与学校端不一致｜SRV-315 见下

**其它**：SRV-323/324/325 见上；SRV-339/340/352 见 P3

## 五、P3 清单（39 条，摘要）

SRV-250 `fieldOptionService.js:35,167-180` 选项树只落一层（孙层静默丢弃）｜SRV-251 `backupVerify.js:60 vs 86` `tableCounts` 字符串形态误判为"meta 损坏"｜SRV-252 `auditLog.js:89-103` 兼容降级静默退回无主体旧形状（仅 console.warn）｜SRV-269 `server.js:479,487` `app.use('/api', recognitionRoutes)` 致 `/api/*` 二次认证、未知 `/api` 路径返回 401 而非 404｜SRV-270 `validationMiddleware.js` 全套校验中间件**全站未接线**（= SRV-217，已确认）｜SRV-282 5 个新迁移未纳入 checksum 固定注册表（`tenantProvisioner.js:284-307`）｜SRV-283 `20260927130000:89-97` 注释称 `to_regclass` 只查当前 schema，实际租户回放会 ALTER `public.recycle_bin`｜SRV-293 `AuditLog.js:536`/`FrequencyModule.js:64` `toISOString()` 取"今天"→东八区凌晨偏一天｜SRV-294 `BackupRestore.js:324` KPI 只统计当前页｜SRV-295 `auditView.js:203,593` 操作人下拉跨校串显｜SRV-302 `UserManagement.js:658-665` "最后管理员"用筛选后列表统计｜SRV-314 `ExportService.js:562-563,592-603` 记录日期按 UTC 解析 vs 本地边界｜SRV-315 `SessionManager.js:43-46,278-283` 会话管理失效（事件无人派发 + 裸键监听；同时坐实 SRV-106 生产不可达）｜SRV-316 `UINotification.js:181-199` Esc 监听泄漏｜SRV-317 `ExportService.js:744` 报告标题未转义｜SRV-318 `embed.js:24-31` `postMessage(..., '*')`｜SRV-326 `conclusion-matrix.test.mjs:94-101` 用字符串包含冒充"两出口同源"证据｜SRV-327 `security/stubs/register-stubs.mjs:19-26` 8 个全模块替身掏空端到端语义｜SRV-328 `f6-upgrade.test.mjs:59,122-124` 旧算法手抄 + 占位断言｜SRV-329 `openapi/db-readonly-checks.mjs:10-15` 用业务 `DATABASE_URL` 且不被 runner 收集｜SRV-330 `lifecycle/r13-release-gate.test.mjs:23-37` 用 PATH 桩替换 `node/npx/systemctl`→门禁本身从未执行，且 `:62` 有死判据｜SRV-339 `uploadQueue409Recovery.test.js:26-41` 直接赋值 `global.fetch` 未还原｜SRV-340 真实 PG + 秒级 `sleep` 依赖（`authSession.test.js:271`、`securityRegression.test.js:421`）｜SRV-352 文档漂移 + `deploy.sh:487` 调用未定义函数 `err`

## 六、待证实（须在隔离环境实测，不得据此定级）

1. SRV-247 的越界**写**链（需"已存在且内容可控的 manifest.json"前置原语）
2. SRV-258 的表名注入可控性（需先获得 `BACKUP_DIR` 写权限）
3. SRV-273 fail-soft 回落 public（需"无 schoolCode 的历史 token"×"DB 抖动窗口"同时成立）
4. SRV-263 写屏障是否被前端显式 `?school=` 兜住（"认证前挂载"本身已确定）
5. SRV-264/266 的可利用性取决于应用端口能否被直连（后端 3002 与 Caddy 拓扑不一致）
6. **迁移 Q1-④**：`CREATE TABLE IF NOT EXISTS` 在 public 已有同名表时，租户侧是否仍会真建表（`FieldOption` 权威表缺失风险）
7. **迁移 C5**：PG14 的 `SET NOT NULL` 是否借已验证 CHECK 免全表扫描
8. SRV-275 真实库是否存在"租户缺 `Backup` 且该迁移仍 pending"的组合
9. SRV-231/232 之外各 XSS 触发字段的文本自由度（部分表单食堂名为 select）
10. 并发度对 SRV-322/323 的影响（取决于 runner 的 `--test-concurrency`）

## 七、边界

- 本轮**未做任何修复**，未改产品源码/数据库/服务；仅新增本报告、更新 `FINDINGS.md` 与 `R8_FILE_INVENTORY_20260929.md`。
- 全部结论为**静态审查**（含行号级回读与调用方交叉验证）；**动态结论（竞态、磁盘/CPU 实测量级、浏览器 XSS 执行、jobId 可枚举性）未做运行时验证**。
- 脱敏：不含数据库口令、连接串、JWT/token、API Key、`BACKUP_MASTER_KEY`、真实个人信息；`.env` 从未被读取值。
