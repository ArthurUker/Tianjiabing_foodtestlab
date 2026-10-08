# P3 下一轮五窗口任务文本（R4）

依据：[R4 总控裁决](../../../AI_review/Codex-GPT6/P3-PARALLEL-R4_REVIEW.md)。每段可单独复制给一个 CodeBuddy 窗口。五个窗口可以**同时启动**，但下面写明的编辑和测试门禁必须遵守：1、2、3 有独立代码面；4、5 在窗口 1 停止并经总控确认迁移协议前只做只读准备。全量回归窗口 CLOSE-B 仍不启动。所有窗口先读 `REVIEW_LOG_MASTER.md` §0/§4、Phase 2 `FINAL_ARCHITECTURE_DECISIONS.md` RC-04（窗口 5 另读 RC-08）、R4 REVIEW 相关段；对故意未提交工作树建输入快照，兄弟漂移只归因不回退。不得连接生产库、读真实 .env、commit/stage/push/reset/clean/stash/真实部署。冻结 29 只读核验，证据写 RESULT/COMMANDS/TEST_RESULTS、原始 logs/rc、输入对照与最终 hash 两次只读复验；自有实例 down。

## 窗口 1：P3-W2-T02-R2（逐租户 migration 与 readiness，主关键路径）

> 你负责 `P3-W2-T02-R2`。先读 `docs/AI_review/Codex-GPT6/P3-PARALLEL-R4_REVIEW.md` 的 W2 四项 REWORK、`evidence/P3-W2-T02-R1/RESULT.md` 和冻结 RC-04。独占 `backend/lib/tenantProvisioner.js`、`backend/lib/tenantSync.js`、`backend/server.js` 的租户就绪/能力闸门区、`backend/sync-tenant-schemas.mjs`、本包专用测试与证据。若确需链尾迁移/租户迁移台账，可编辑 **新建** migration 文件和必要的 `backend/prisma/schema.prisma` 区域，但先列链文件与兄弟包冲突；不得改已应用 migration 内容/checksum，不碰 auth/restore/deploy.sh/lifecycle grant 面。你持有本轮 migration 链尾所有权，完成后向窗口 4/5 明确发布链尾约定和“停止编辑/测试”信号。
>
 修正事实源：每个 public 与 tenant 都要能证明已应用迁移的名称、checksum、状态/失败原因；新校和存量校要按可回放版本路径升级，不能用 `migrate diff ... --to-schema-datamodel` 的末态 SQL、链摘要或 public 迁移状态冒充逐租户执行。先只读盘点既有 migration 中 public 限定/跨 schema SQL，给出六类历史库（空库、正常旧链、runtime db push、failed、曾 resolve、disabled）的安全接入与拒绝条件；若现有链无法直接安全回放，交付明确的受控 baseline/增量方案及实证，遇无法证明的状态 fail-closed，**不可**回退 db push 或盲目 resolve。保持启动任何 `AUTO_SYNC_TENANTS` 值都只读；`false` 不得在迁移未证明完成时返回 ready 200。public migration pending/failed、检查超时、未知 extra table/column/constraint/index 都要产生可解释状态并阻断受影响能力；修复/健康入口豁免须列出，租户归属无法确定的业务入口不能默认穿透。不能为清理 extra 对象默认做 DROP。
>
 消除 URL 泄露：Prisma/psql 错误、日志和进程参数不得包含连接密码；用**假**凭据故障注入验证，证据只留布尔/掩码。使用自有隔离 PG 跑逐租户版本/重复回放/失败中途/数据保全、extra 漂移、三种启动值、global pending/failed/timeout 时的 readyz **及真实租户 API**、active/disabled、新校与恢复暂存 schema 的定点。复核与 W3 恢复接口兼容；只跑定点，不跑全套件。若某 RC-04 义务确实无法本包安全完成，列精确 DESIGN BLOCKER 和缺失证据，不能自报关闭。

## 窗口 2：P3-W2-T01-R2（deploy.sh 迁移失败 fail-closed）

> 你负责 `P3-W2-T01-R2`。读 R4 对旧 W2-T01-R1 的 REWORK、旧包 `RESULT.md` 与 RC-04。独占 `deploy/deploy.sh` 的迁移执行段及本包新沙盒/测试；可新建 `deploy/MIGRATION_FAILURE_RUNBOOK.md`，**暂不改共享** `deploy/README.md`（窗口 1 持迁移文档/协议）。不编辑 tenantProvisioner、tenantSync、server、schema/migration、auth/restore。只读核对现有首部署/既有库状态机，再去掉 migrate 失败后的自动 `resolve --rolled-back` 与 `db push` 成功回退；迁移失败一律非零停止并保留原始 stderr。既有库 P3005、failed/P3009、部分执行、空库失败与真正迁移成功分别给诊断信息，**人工核实状态后**才按 runbook 选择处置；不要以缺 `public.User` 推断数据库全空。不得自动 `resolve --applied`、清失败记录、使用 `--accept-data-loss` 或声称 db push 成功等于迁移成功。
>
 建独立函数级沙盒：健康空库成功只调用 migrate deploy；任意失败无 resolve/db push、退出非零且 stderr 保留；部分结构+无 User、failed 记录、P3005、P3009 均原样保留；检查不含破坏性参数。跑 bash -n 和既有 deploy 定点并按新契约修订本包**新**沙盒断言；旧历史沙盒输出只读保留、登记新旧口径差异。你可与窗口 1 并行编辑/测试，但各用独立实例和日志目录；若需改共享 README，先交总控在窗口 1 收工后合并，不跨界。

## 窗口 3：P3-W3-R2（restore ACL grant option）

> 你负责 `P3-W3-R2`。读 R4 对 W3-R1 的 REWORK 与 `evidence/P3-W3-R1/RESULT.md`。独占 `backend/lib/restoreService.js` 的 ACL 快照/差集/重放区，以及本包专用 `backend/tests/backup/*` 测试和新证据；保留 CLOSE-A 已做的台账目录隔离，不改 tenantProvisioner、migration、server 或 deploy。差集身份应覆盖授权是否可转授：基线 `WITH GRANT OPTION`、切换后只有同名普通权限属于缺失，必须补 `GRANT ... WITH GRANT OPTION` 并在复读后自证；普通基线而目标已有可转授权限时不能无故 REVOKE。schema 与 table/sequence 对称；不存在对象、额外授权、PUBLIC/角色、重复执行也要明确处理。若“逐项一致”只定义为基线下界，应将返回字段/文档说准，不虚称双向相等。
>
 先写独立真实 PG 反例，确认旧实现对此误报通过；再改产品代码。测试升级可转授权、普通授权不降权、目标外 schema 零扩散、故障时 fail-closed 且旧 schema 尚可回滚；保留原 27 项回归。自有实例与台账目录独立。窗口 1 同时改 tenantProvisioner，跨包恢复联测待其停止后再跑；当前仅跑可稳定归因的 ACL 定点，最终按输入 hash 记录源文件版本。不跑全套件。

## 窗口 4：P3-W1-R1（认证运行时 DDL 退出）

> 你负责 `P3-W1-R1`，读 R4 对 W1 的“RC-02 定点 PASS / RC-04 交叉返工”、W1 原包及 CLOSE-A 受保护断言修订。**窗口 1 停止编辑/测试并发布 migration 链尾约定前，只读准备**：盘点 `authMiddleware.js` 所有运行时 DDL、现有撤销表的版本/索引、与 W1 O(1) epoch 查询的依赖；产出最小迁移和测试计划，不改源码/测试/迁移，不运行 PG。收到总控基于窗口 1 结果的明确开工信号后，独占 `backend/middleware/authMiddleware.js` 吊销基础设施区及专用认证测试；链尾迁移新文件须与窗口 1 的版本协议/文件名协商，无冲突后才创建。
>
 把 `revoked_tokens` 表和 school epoch 索引纳入版本化 migration；删除认证创建时的 `CREATE TABLE/INDEX` 自愈。缺表/缺索引/未应用版本时应按认证与 readiness 契约 fail-closed 或明确不可用，不能静默创建。保持 W1 的统一失效 SQL、`idt` 同秒边界、`user_all` 语义、两阶段开关及已修订的 securityRegression 场景。跑 authSession、securityRegression、session unit/matrix 与 W1 定点，验证 runtime DDL 调用计数为零，隔离实例 down。不要碰 W2 的 server/tenantSync 或 lifecycle 的 UserManager/schoolRoutes。

## 窗口 5：P3-W2-LIFECYCLE-T01-R2（AUD-027/047 实施，带顺序门禁）

> 你负责 `P3-W2-LIFECYCLE-T01-R2`。先读 R4 的设计 PASS/HOLD、`evidence/P3-W2-LIFECYCLE-T01/{DESIGN,TEST_MATRIX,BLOCKERS}.md` 和 RC-04/RC-08。**窗口 1 停止并经总控确认其迁移协议前，只读准备**：核对 A4/A5 授权面、列出受保护测试逐场景保留方式、迁移与 W1 epoch/W3 restore 交叉点；不得编辑 schema、生成 client、建 PG 实例或跑测试。收到总控明确实施信号后，独占 `backend/prisma/schema.prisma` 中生命周期模型与自己的链尾迁移新文件、`backend/lib/auditLog.js`、`backend/routes/auditRoutes.js`、`backend/routes/openApiRoutes.js` 与 `backend/routes/adminOpenApiRoutes.js` 的 grant 校验必要区、新 helper、`UserManager.js` 删除/审计必要区、`schoolRoutes.js` grant 撤销必要区、专用测试。**明确授权**在场景不删且写溯源的前提下更新 `tests/auditUserFilter.test.js` 与 `backend/tests/http/openapi-http.integration.test.mjs` 的旧 grant 直建测试（补真实学校 ID/世代绑定）；共享文件先做逐 hunk 归属，不能碰 W1/W5 其它区。
>
 落实复合唯一 AuditPrincipal、审计主体保全/用户删除不级联、历史回填来源标记、OpenApiGrant 不可变学校 ID+世代、硬删同事务撤 grant；读取端（profile、grant 列表、preview/dict）一律 fail-closed 校验，legacy active 无绑定/歧义/孤儿隔离，不按 schoolCode 猜归属，也不靠恢复后 active 标志自动继承。隔离写入失败不得放行读取。expand 阶段 nullable 必须给回填、计数核验与最终 NOT NULL 门槛，不能把过渡态称完成。按 TEST_MATRIX 在自有实例验证空库/旧库/重复回放、存量四分类影响清单、同校双用户、审计删除保全、硬删/同 code 重建/重授及 W1/W3 定点；无全套件，实例 down。若须改窗口 1 迁移引擎或窗口 3 restore 区，列 DESIGN BLOCKER，不跨界编辑。

## 总控调度与 CLOSE-B

窗口 1 的协议和停止信号是 4、5 的产品实施门禁；窗口 2 独立；窗口 3 可先做 ACL 定点，跨包回归排在 1 之后。窗口 4 与 5 的链尾 migration 文件名/顺序由总控在窗口 1 结果复审后明确，不允许同时争抢 schema/client。必要时先 5（schema 增量）再 4（auth index），两者不得同一时刻生成 client/回放同实例。 `P3-CLOSE-T01` 阶段 B 保持只读；其 `phaseB/REGRESSION_PLAN.md` 中旧 `TENANT_DB_PUSH_ACCEPT_DATA_LOSS=true` 前提必须在开工前更新为新迁移/fixture 契约。全部产品包通过复审、停止编辑和测试，且总控发出独占启动信号后，才可做 AUD-040 与单实例单次全量回归。
