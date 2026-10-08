# P3 下一轮 CodeBuddy 任务文本（2026-09-25）

本页以 [P3-PARALLEL-R3_REVIEW.md](P3-PARALLEL-R3_REVIEW.md) 为裁决依据。发包前先读 [REVIEW_LOG_MASTER.md](REVIEW_LOG_MASTER.md) §0、§4 与 `../phase2/FINAL_ARCHITECTURE_DECISIONS.md`。下列文本可同时发给五个独立窗口。**窗口 1、2 可同时编辑与定点测试；窗口 3 先只改设计，等窗口 1 停止编辑和测试后才实施 schema/Prisma；窗口 4 只读整理旧包证据；窗口 5 现在只做只读入口清单和计划，最后独占编辑与全量回归。** 不要把“已有执行回执”写成“总控已复审”。

## 窗口 1：P3-W2-T02-R1（启动与迁移纪律返工）

> 你负责 `P3-W2-T02-R1`。先读 `phase3/P3-PARALLEL-R3_REVIEW.md` 的 W2 裁决、`phase3/evidence/P3-W2-T02/RESULT.md` 和冻结的 `phase2/FINAL_ARCHITECTURE_DECISIONS.md` RC-04。此前任务文本允许 `AUTO_SYNC_TENANTS=true` 在启动时 apply 的口径过宽；以 RC-04 为准纠正：**服务启动只做结构漂移检测，不执行 `db push`/回填；未知漂移或租户检查失败须阻断 readiness 或该租户对应能力，不能在 `app.listen` 后告警并对外声称健康。停用学校也纳入升级/检测范围。**
>
> 独占编辑面：`backend/server.js` 的租户同步/就绪区、`backend/lib/tenantSync.js`、`backend/lib/tenantProvisioner.js`、`backend/sync-tenant-schemas.mjs`、本包专用测试/fixture、`deploy/README.md` 中本包段落。不得改 W1 认证/写屏障区、`deploy/deploy.sh`、RECORD/REPORT-AUTH 文件、schema/migrations。先建立本轮输入快照与行区归属，保留兄弟修改。
>
> 完成可运行的迁移先行路径与显式升级命令；`AUTO_SYNC_TENANTS` 旧值的兼容行为须明确文档化，但任何值都不得触发启动时结构写入。新建校与存量校结构来源要可追溯到版本化 migration；若现有结构无法安全做到，列出精确设计阻塞与最小可实施方案，不得用运行期 `db push` 冒充闭合。检查至少覆盖表、列、关键索引/约束，标出任何未覆盖范围。用独立 PG 实例验证默认/true/false 启动均不写结构，漂移和检查故障的 readiness/能力阻断，active 与 disabled 学校，显式升级、失败退出码和数据保全。T02C 等 fixture 的合成 `messages` 对象请在自有实例 fixture 中隔离或清理，不能把 `TENANT_DB_PUSH_ACCEPT_DATA_LOSS=true` 变成默认测试前提。
>
> 先处理旧证据中的凭据：`phase3/evidence/P3-W2-T02/logs/sandbox-url.txt`、`logs/w2t02-dbsync.env` 含未掩码隔离实例连接信息。不要在输出中打印或复制值；安全移除或脱敏这两份文件，附更正说明与新 hash。旧 `HASHES_FINAL` 因此失效应如实记录，不得声称旧 hash 仍匹配。其余旧执行日志只读保留。
>
> 交付 `evidence/P3-W2-T02-R1/` 的 RESULT/COMMANDS/TEST_RESULTS、原始 logs+rc、输入对照、最终 hash 双复验和实例 down 证明。定点只跑本包所需；不跑全量、不部署、不 stage/commit/push。停止编辑和测试后明确通知窗口 3 可以开始 schema 阶段。

## 窗口 2：P3-W5-RECORD-T01-R1（幂等资源身份与报告全量语义）

> 你负责 `P3-W5-RECORD-T01-R1`。先读 `phase3/P3-PARALLEL-R3_REVIEW.md` 的 RECORD 裁决和 `phase3/evidence/P3-W5-RECORD-T01/RESULT.md`。独占 `backend/middleware/idempotencyMiddleware.js`、`backend/routes/recordRoutes.js` 的本包行区、`backend/lib/readContract.js`、`backend/lib/exportJobs.js`、`frontend/js/core/Storage.js`、`frontend/js/services/ExportService.js`、本包测试；获授权更新 `tests/idempotencyConcurrency.test.js` 旧契约断言，须保留场景并注释 AUD-002 溯源。不得碰 `server.js`、租户同步、schema/migration、`deploy/README.md`、W4/W5 兄弟在 `recordRoutes.js` 的行区。
>
> 修正幂等身份中的具体资源：相同用户、同 key/body 对 `/api/records/oil/r1` 与 `/api/records/oil/r2` 的 PUT 必须分别执行并返回各自 ID；同目标重试仍去重；同 key 异 body 同目标返回 409；跨租户、跨主体及撤权后缓存不得越权。建立独立反例回归，不只断言哈希不同，还断言两个 handler 都实际运行。
>
> 修正 AUD-020 的端到端数据范围：服务端权威导出成功 2501 行及 10000+ 行时，浏览器预览/PDF 若继续限 2000，必须明确显示“部分数据”并给完整原始产物下载，任何地方不得再称该预览/PDF 为“权威全量”；若报告承诺全量，则真正消费完整快照并验证 expectedCount/exportedCount/渲染数一致。0/1/2000/2501/10000+ 均须有真实成功分支验证；不得用测试中的提前 `return` 把超限跳过算作通过。验证 cursor、失败/取消/重启恢复、过期清理、权限撤销后下载和单实例文件台账的部署边界；必要配置放本包代码/测试，不与窗口 1 共改 README。
>
> 交付独立 fixture/日志/rc、前后反例、root Jest 更新断言的逐项归因、输入漂移与 hash 双复验；只跑定点，实例安全 down。不要提交、部署或运行全套件。

## 窗口 3：P3-W2-LIFECYCLE-T01-R1（先修设计，再实施）

> 你负责 `P3-W2-LIFECYCLE-T01-R1`。先读 `phase3/P3-PARALLEL-R3_REVIEW.md` 的 LIFECYCLE 裁决、`evidence/P3-W2-LIFECYCLE-T01/{DESIGN,TEST_MATRIX,BLOCKERS}.md`、Phase 2 RC-08。**现在可以只改本包设计/测试矩阵；在窗口 1 明确停止编辑和测试前，不得编辑 schema、migration、生成 Prisma client、跑 PG fixture。**
>
> 修正 `AuditPrincipal` 身份：同一学校多个用户必须可同时存在，唯一键含稳定主体 ID；`scope_key` 仅为 platform/school 范围，不能单列唯一。`OpenApiGrant` 的学校身份/世代为空、歧义或孤儿时一律 fail-closed，既有 active 标志不构成继续放行依据；已验证的旧授权应有显式迁移/重授路径，不按 schoolCode 猜归属。更正 B14：CLOSE 阶段 A 已把 `securityRegression` 改成 18/18，不能预设 1 项失败。
>
> 授权实施边界：本包可编辑 `backend/prisma/schema.prisma` 与链尾幂等 migration、`backend/lib/auditLog.js`、`backend/routes/auditRoutes.js`、`backend/routes/openApiRoutes.js` 的身份读取守卫、`backend/modules/UserManager.js` 的审计/删除必要区、`backend/routes/schoolRoutes.js` 的 grant 撤销必要区，以及相关新测试；可按场景保留原则修订受保护的 `tests/auditUserFilter.test.js`。优先读时校验真实学校 ID/世代，写时同步撤销；不增设物理清理 HTTP 入口。`principal_id` 可在 expand 阶段暂时 nullable，但须有可执行回填与最终 enforce 门槛，不可把过渡态当最终闭合。
>
> 待窗口 1 停止信号后，先核对其结构来源与 fixture 合同，再实施并在自有实例跑空库/旧库/重复回放、audit 历史保全、硬删/恢复/重授与 legacy grant 隔离、W1 epoch/W3 恢复互不劣化的定点。若必须改窗口 1 或其他兄弟独占面，先列 DESIGN BLOCKER，不跨界编辑。交付 RESULT/COMMANDS/TEST_RESULTS、影响清单、日志/rc、hash 双复验和实例 down。无提交、无部署、无全套件。

## 窗口 4：P3-PRIOR-THREE-FACTS-T01（只读整理 W1/W3/W2-R1 证据）

> 你负责 `P3-PRIOR-THREE-FACTS-T01`，为总控下一轮独立复审准备**可核对的事实包**，不是替总控宣布 PASS。先读 `phase3/REVIEW_LOG_MASTER.md` §0/§4、`phase3/P3-PARALLEL-R3_REVIEW.md`，再分别读 `evidence/P3-W1-T01/`、`evidence/P3-W3-R1/`、`evidence/P3-W2-T01-R1/` 的 RESULT、COMMANDS、TEST_RESULTS、原始 logs/rc 与 HASHES_FINAL。逐包列出实际变更文件/行区、每个命令 rc、skip/失败、输入快照归因、冻结 29、实例 down、旧 protected 冲突与尚未执行的门槛；按包输出“证据支持/尚不支持”的核查清单和可直接定位的 file:line，不给最终裁决。
>
> **只读源码与原证据**，不得编辑应用、测试、任务包、旧证据或总账；不得运行 PG/Jest/backend 全套件，不创建实例或改环境配置。其他窗口正在修改 `server.js`、`deploy/README.md` 等共享工作树文件：静态核查须以各包当时 `HASHES_FINAL` 和输入快照为界，分清“当时包事实”与“当前兄弟修改”，对当前变动不作误归因。可在新的 `phase3/evidence/P3-PRIOR-THREE-FACTS-T01/` 写自己的 FACTS.md、COMMANDS.md、只读核验日志与 hash，输出不得包含凭据值。若发现旧包证据凭据，记录路径及是否脱敏，不打印内容。
>
> 把事实包交总控独立复审；它不代替三个缺失的 `*_REVIEW.md`。不得 stage/commit/push/部署。此窗口可与 1、2 和 3 的设计阶段同时进行，零源码/测试竞争。

## 窗口 5：P3-CLOSE-T01 阶段 B（最后独占统一回归）

> 你负责 `P3-CLOSE-T01` 阶段 B。**现在只读** `phase3/P3-PARALLEL-R3_REVIEW.md`、`evidence/P3-CLOSE-T01/RESULT.md` 与 `REVIEW_LOG_MASTER.md` §0/§4，列出 AUD-040 入口现状、受影响 glob 和单实例全量回归计划；将只读计划写入本包新证据目录，不编辑配置/源码、不跑测试或建实例。**仅在窗口 1–3 全部停止编辑和测试、总控完成这些包的裁决、窗口 4 的事实包已由总控独立复审并明确发出阶段 B 启动信号后**，才进入下述实施与测试。届时独占新的 PG 实例和 `BACKUP_JOB_LEDGER_DIR`，同一时刻没有其他窗口跑全套件。
>
> 实施 AUD-040 的 unit/DB Jest 入口拆分，编辑限 `package.json`、`jest.config.cjs`、专用测试配置、`docs/TEST_DATABASE_ISOLATION.md` 与必要的入口测试。DB 入口保留 `TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE` 缺一即非零拒绝、零 skip、不得隐式读 `DATABASE_URL`/`.env`。确认 `backend/tests/report-auth/*`、records/*、新 lifecycle/W2 测试是否进入相应 glob，并给逐文件计数。随后在一个干净实例、单次运行 root Jest、PG integration、isolation、live-api、`npm run test:backend` 全量；分栏 baseline known/preexisting/new/skips，不硬套旧 270/310。任何产品缺陷只登记并返还归属窗口，不在本轮跨界修。保留所有原始日志/rc、输入快照、hash 双复验、实例 down 证明。无提交或部署。

## 总控自身待办（不发给并行执行窗口）

`P3-W1-T01`、`P3-W3-R1`、`P3-W2-T01-R1` 已有 CodeBuddy 执行回执，却尚无此轮总控独立裁决。窗口 4 只准备事实，需由总控按各包 RESULT/HASHES/logs/源码补限定复审，并在窗口 5 前标明结论；不要把三份自报全绿自动写成已复审 PASS。
