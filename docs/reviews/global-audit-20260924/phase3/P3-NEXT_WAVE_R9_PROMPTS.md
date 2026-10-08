# Phase 3 下一轮五窗口 prompt（R9，总控接力版）

五段分别复制给五个 CodeBuddy 窗口。共同读序：`docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md` → `docs/AI_review/Codex-GPT6/P3-PARALLEL-R9_REVIEW.md` → `phase3/REVIEW_LOG_MASTER.md` §0/§4 → 本包旧证据/源码。HEAD 与故意未提交工作树保持，不 reset/clean/stash/checkout，不 stage/commit/push/部署。每窗开工输入快照、独占编辑面漂移归因、冻结 29 只读复验、真实 rc/logs、收工 HASHES_FINAL 与两次独立只读复验。隔离 PG 各自不同实例、端口、台账目录；仓外凭据用后销毁。无凭据进证据。**并行的是互不相交的准备与编辑面；共享迁移链、Prisma client、动态实例与全量回归按下述信号串行。**

## 窗口 1：P3-FIXTURE-MIGRATED-R1 — 消除 B1 并完成三组真实 server 动态定点

> 执行 P3-FIXTURE-MIGRATED-R1。先读 R9 总控审阅、`P3-HARNESS-CHECK-R1/BLOCKERS.md`、`P3-DB-FIXTURE-R2/RESULT.md`。独占测试基础设施面：`tests/isolation/provision.cjs`、`backend/tests/t02c-instance-fixture.mjs`、`backend/tests/report-auth/report-auth-fixture.mjs`、`backend/tests/harness-check/_prepare-migrated-instance.mjs`、三份已改的 t02c/report-auth/session harness，及必要的 fixture 单测/本包新证据。不得改产品引擎、auth、restore、schema/migrations、deploy、Jest/package 配置。
>
> 实现 O1：在自有实例把 public `prisma migrate deploy` 放在 public 业务表建造之前，tenant 表只经版本化链回放；T02C 和 report-auth fixture 删除 `db push` 与 `--accept-data-loss`。处理 `provision.cjs` 预置 `public.revoked_tokens` 导致的 P3005：为 migration-first fixture 建明确安全顺序，**不要**使用 `SET SCHEMA` 临时寄存/迁回认证表，也不靠无凭据的 `resolve`、attestation、`AUTO_SYNC_TENANTS=false`。若必须清理自有 scratch 的合成空表，先证明 owner/零行/对象指纹并限定到该实例，写明理由。租户测试角色的 GRANT 要在表回放**后**施加并以真实受限角色 SELECT/INSERT/UPDATE/DELETE 验证；维持 marker 只读、哨兵隔离、fixture 表精确白名单。
>
> 先完成编辑和静态护栏。**动态链等窗口 2 公共基础设施 migration 明文停止编辑/测试且链尾 hash 固定**，并与窗口 3 schema/client 编辑错峰；同一自有实例顺序跑 isolation 68、T02A 22、业务隔离 27、live-api 49、report-auth 20、session 12，逐入口计数归因、0 skip、readyz=200、真实租户 API 可达；若任一套件的公共库合同冲突，修 fixture 不放宽产品闸门。收尾 down 三条件/端口、输入归因与双复验，明确后续可启动窗口 3 的 migration 编辑信号。

## 窗口 2：P3-PUBLIC-INFRA-CHAIN-R1 — 锁表与认证吊销表正式入链，撤出运行时 DDL

> 执行 P3-PUBLIC-INFRA-CHAIN-R1。先读 R9 总控审阅、W2-R6 `LOCK_TABLE_VERSIONING_PLAN_R6.md`/协议增量、W1 `P3-W1-R1-PLAN-R3/REVISED_PLAN.md`，以及 RC-04。**本窗是此阶段唯一 `backend/prisma/migrations/**` 链尾所有者**。独占 `backend/lib/tenantProvisioner.js` 的锁表基础设施区、`backend/lib/tenantSync.js` 的 public 形状/状态检查区、`backend/middleware/authMiddleware.js` 的吊销基础设施区，及相应 tenant-sync/session 定点测试；不改 `schema.prisma`、UserManager/其它 auth 业务语义、fixture、restore、deploy。与窗口 3 绝不同时编辑 migration 或生成 Prisma client。
>
> 按当前 `-- @scope: public` 协议新增确定顺序的链尾 migration：① `public._tenant_migration_locks`（兼容旧表逐项 ALTER、结构自证）；② `public.revoked_tokens`（表和三索引，形状与既有运行时定义及 `user_all`/school epoch 语义一致）。新文件不得产生租户同名对象；租户台账记 `skipped_public_only`。**同一可审发布**撤出锁表与认证表运行时 `CREATE/ALTER/CREATE INDEX`，替换为只读形状检查；缺表/错列/缺索引返回确定的 fail-closed 码，认证缺设施 503 `AUTH_INFRA_MISSING`，不得进入 fail-soft。把 `baseline_pending` 正式纳入已知非终态协议与 `--check`，提交后复证→提升前做事务内结构指纹再核或提供等强证明；不能因已应用 migration 台账而忽略事后对象删除/错形。
>
> 自有实例验证空库、旧运行时对象、重复回放、错误形状、缺索引、public-only 租户投影、受限角色启动/请求零 DDL、R6 互斥/非终态不劣化；复跑 authSession 18、securityRegression 18、session unit 15/matrix 12、W2 R6 定点。受保护测试仅在场景与断言保持、注释溯源的必要范围更新，逐项归因。禁全套件。收工锁定链尾 hash、源 hash、实例 down，向窗口 1/3 明文发送“链尾编辑和测试已停止”；本包通过定点不自动等于生命周期或部署验收。

## 窗口 3：P3-LIFECYCLE-AB-R1 — 审计主体、grant 身份与 A/B 两阶段合同

> 执行 P3-LIFECYCLE-AB-R1。先读 R9 总控审阅、`P3-W2-LIFECYCLE-DESIGN-R5/DESIGN_R5.md`/矩阵、Phase 2 RC-04/RC-08、W1 session epoch 合同。**启动可先做只读实现准备；不得编辑 `schema.prisma`/migration 或生成 client，直到窗口 2 与窗口 1 动态定点均明文停止且公共链尾 hash 固定。**此后本窗独占 `backend/prisma/schema.prisma`、链尾 migrations、`backend/lib/auditLog.js`、审计/开放 API 身份 helper、`UserManager.js`/`schoolRoutes.js` 相关生命周期写路径、`openApiRoutes.js`/`adminOpenApiRoutes.js` 读时身份判定与必要定点；部署阶段接口若须改 `deploy/deploy.sh` 也由本窗独占，窗口 2 禁碰。
>
> 总控修正：**仅凭 username 当前唯一、当前 User.created_at 早于 AuditLog.created_at，不能证明历史主体身份；M-2 username-only 必须保守拒绝**。只有稳定 `subject_user_id` 或独立可审的历史身份映射证据才可绑定；无主体且无快照才用系统 principal。A 阶段：M1 expand、nullable Prisma client、`AuditLog` `CHECK(principal_id IS NOT NULL) NOT VALID`（新 INSERT/UPDATE 强门禁，历史 NULL 清单保留）、审计写入与读取双来源、open-api grant 的学校不可变身份读时 fail-closed/隔离写失败仍拒绝；先在隔离实例验证 A。B 阶段须作为**与 A 可分离的发布产物**：004 幂等批量回填与影响清单、M2 自足残量处理+VALIDATE+SET NOT NULL、B required client、部署 B1(A client 迁移与 G2/G7/G8 门禁)→B2(生成/激活 B client)及回退 A client；不得把 M1 与 M2 当一次无停点发布。用两次独立快照/补丁清楚标明 A/B 边界，不能靠最终工作树同时含两阶段文件冒充已演练滚动发布。
>
> 空库/旧库、active/disabled/新校、历史审计主体歧义、硬删/恢复同 code grant 不继承、W1 epoch 同事务、恢复 staging 单次 align 均须真实隔离 PG 定点；受保护测试场景保留、溯源更新。若某产品接口无法在授权面实现，登记具体阻塞，但继续完成不依赖该接口的部分。禁全套件/真实部署/提交。收尾实例 down、分 A/B rc 与 hash、输入归因；明文释放 migration/client 编辑面供窗口 4/5 动态测试。

## 窗口 4：P3-W3-CROSS-REG-R1 — 受控外部备份注册与双实例真实恢复

> 执行 P3-W3-CROSS-REG-R1。先读 R9 总控审阅、`P3-W3-R2-CROSS-PLAN-R4/TEST_PLAN_R4.md`、`CROSS_INSTANCE_REGISTRATION.md`、W3-R2 ACL grant option 裁决。独占新外部备份注册模块/CLI、`backend/lib/backupService.js` 与 `backend/routes/adminBackupRoutes.js` 中**仅注册入口**，及新增 `backend/tests/backup/w3r2cross-*` 和本包证据；不得改 restoreService、tenantProvisioner、schema/migration、auth、fixture、部署脚本。无需 schema 新列：若现有 `BackupRun` 字段不足以如实标记 external 来源和审计，先给出受控元数据/审计方案，不伪装为本实例产生的备份。
>
> 实现最小受控 `register-external-backup`：仅平台管理身份/离线管理 CLI，校验加密产物与 meta 的 hash、大小、scope、school、表计数和来源；路径限定在目标 BACKUP_DIR 内，拒绝符号链接/路径穿越/重复或冲突注册；落本实例 BackupRun 与独立 external 来源审计，不放宽现有 `restore-from-upload` 的 runId 防伪造链。源 A、目标 B 各自独立实例/端口/台账/密钥文件；A 旧前缀/无台账源人工修复并生成**新**备份，B 旧备份默认 UNPROVABLE 且保留旧 schema/data，B 经产品注册入口导入 A 新产物并成功恢复、重复恢复；再验 ACL grant option 下界、受限角色 SELECT/UPDATE/DELETE/序列 USAGE、public 锁表与 tenant 台账白名单、真实 readyz/API。
>
> 可先独立开发注册模块与离线单元。真实双实例恢复须等窗口 3 释放 migration/client 且窗口 1 fixture 完成；若跨实例注册无法在既有 BackupRun 契约内安全实现，明确产品接口阻塞并以**人工准备**单独测试恢复引擎，两个结论绝不混写。禁全套件。交付 A/B 两实例 down、逐阶段 rc/原始日志/产物校验和、输入归因、双复验与停止信号。

## 窗口 5：P3-CLOSE-B-R1 — AUD-040 入口拆分与最终单实例回归

> 执行 P3-CLOSE-B-R1。先读 R9 总控审阅、`P3-CLOSE-T01/phaseB/INVENTORY.md`、`P3-CLOSE-T01-B-PLAN-R2/REGRESSION_PLAN_R2.md`、AUD-039 门禁合同。独占 `package.json`、`jest.config.cjs`、新增专用 Jest 配置/runner、`docs/TEST_DATABASE_ISOLATION.md` 与本包证据；不得改产品、fixture、migration、其它既有测试。先离线实现 AUD-040：unit 入口不依赖 PG；DB/root 入口缺 `TEST_DATABASE_URL` 或 `TEST_DB_CONTEXT_FILE` 必须**非零拒绝、0 skip**，不得回落 `.env`/`DATABASE_URL`；按文件枚举而非 shell `**` 模式确认 root/integration/isolation/backend 各入口实际执行文件数，防顶层/多层嵌套静默漏跑。
>
> 单元入口与门禁负例可先跑。**单实例单次全量回归**须等窗口 1/2/3/4 全部明文停止编辑测试、总控核验各自交付后独占启动：新实例，public migrate deploy → tenant chain → `--check` → 默认 check server；按计划分 root Jest(DB/unit)、integration、isolation、live-api/report-auth/session、单次 `npm run test:backend`。逐文件对账、known/preexisting/new/skips 分栏（skip 必须 0），保留全部原始 rc；不得硬套历史 270/310。新失败先定位归属包，不擅自越界修产品。全绿才报告 `PASS_LOCAL_REGRESSION`，否则如实列出阻塞；实例 down、哈希双复验、未提交/未部署状态说明。

## 接力顺序（双方须明文）

1. 窗口 2 独占公共链；1/3/4/5 可做各自不依赖链的准备。窗口 2 完成、停止编辑和测试并锁定 hash。
2. 窗口 1 跑迁移先行 fixture/三组动态定点，停止后释放实例与链读时点。
3. 窗口 3 才编辑生命周期 schema/migration/client，按 A/B 两发布取证；完成后释放链/client。
4. 窗口 4 运行双实例真实恢复；完成后停止。
5. 窗口 5 独占最终全量回归。任何链/client/fixture 兄弟窗口在测时漂移，依赖窗口重取 hash 并重跑受影响定点，不能把混合时点拼成一条绿链。

上述是**执行授权与文件面**，不预先给任何结果 PASS、commit 或部署许可。最终生产迁移状态与上线验证仍须另行以真实环境事实裁决。
