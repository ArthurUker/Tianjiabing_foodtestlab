# Phase 3 下一轮五窗口 prompt（R7）

依据：[R7 总控裁决](../../../AI_review/Codex-GPT6/P3-PARALLEL-R7_REVIEW.md)。以下五段分别复制到五个 CodeBuddy 对话。**可并行启动**：窗口 1 独占 W2 产品引擎；窗口 2 独占测试隔离 fixture，使用不同自有 PG 实例/端口，不读取窗口 1 的运行实例；窗口 3/4 只写各自设计证据；窗口 5 只写部署文档。跨窗口真实联测仍待窗口 1 完成且总控复审。所有窗口先按 `REVIEW_LOG_MASTER.md` §1 读序，保持 §0/§4 与 RC-04/RC-08，不重审 Phase 1/2；开工取输入 hash、只读核验冻结 29，保留兄弟未提交改动，不读取真实 `.env`/生产库，不 commit/stage/push/reset/clean/stash、不部署。交付逐文件编辑面、原始 logs/rc、失败/skip 分栏、输入漂移归因、`HASHES_FINAL` 双只读复验；建实例须安全 down。

## 窗口 1：P3-W2-T02-R5（锁执行者与 baseline 提交边界）

> 你负责 `P3-W2-T02-R5`。先读 `docs/AI_review/Codex-GPT6/P3-PARALLEL-R7_REVIEW.md` 的 W2 四项与 `evidence/P3-W2-T02-R4/{RESULT.md,TEST_RESULTS.json,MIGRATION_CLASSIFICATION_PROTOCOL_R4_DELTA.md}`，再读 `tenantProvisioner.js:152-170,647-812,954-1045,1152-1170`、CLI `--force-unlock` 和 RC-04。独占 `backend/lib/tenantProvisioner.js`、`backend/sync-tenant-schemas.mjs` 的锁/baseline 区、本包 `backend/tests/tenant-sync/` 新测试及新证据目录；`server.js`/`tenantSync.js` 只读，除非新真实反例证明 R4 流量闸门需修且先登记行区。不得改 auth/restore/deploy/schema/正式 migrations/测试隔离 fixture。
>
> **R5-A 证明唯一执行者。** 当前 Node PID 死亡时，独立 `psql` 子进程或 PG 后端可能继续执行迁移；现有 M3d 仅是死 PID 假行。用自有隔离 PG 构造长 SQL：父进程启动 `psql` 后被终止，观察子进程/PG backend；第二执行者不得在旧 SQL 仍运行时取得写入权。可选择默认禁自动接管并以人工核实清锁，或同会话 DB 锁/明确终止且验证旧 backend 退出后才接管。仅每迁移前查 fencing 不足以保护正在执行的 SQL。`isProcessAlive` 只把 `ESRCH` 判死亡，其他错误未知。保留 R4 存活 PID/跨主机/开关 off/双进程反例。
>
> **R5-B 人工解锁 CAS。** CLI 展示的 owner、fencing token 与删除必须绑定：展示后若原锁释放且新执行者持锁，`--yes` 应拒绝而不是删新锁；真实双进程/注入时序证明。人工通道须记录原持有者与当前状态，不用“用户已确认”替代 CAS。
>
> **R5-C baseline 事务说准且防过时证明。** `runPsqlBatch` 提交后才执行的 `readTenantMigrationLedger`/`buildBaselineProof` 失败不能宣称全事务回滚。给独立 DDL 会话在证明与提交边界改结构的真实反例；修成提交前在可靠锁/同事务快照内重验证，或以明确的“已提交但后检失败、人工修复前不得放行”状态/台账记录 fail-closed；协议、代码注释、错误码须与实际边界一致。继续保留“第 7 行失败 → 零 baselined”及摘要不符/他人持锁反例。
>
> **R5-D public 锁表版本归属。** 现锁表由产品运行路径 `CREATE/ALTER`，尚未在版本链；只给出与 W1/LIFECYCLE 不冲突的 public 迁移链尾方案、旧表升级 SQL 和检查判据，**本包不创建正式 migration**（链尾所有权留总控排序）。若本轮不能实现迁移版，RESULT 明列 RC-04 未闭合项，不写 PASS_RC04。
>
> 重跑 R4 unit 6/6、矩阵 44/44、安全定点与新增真实反例；所有原场景保留、逐入口 rc/skip/已知失败分别登记。实例使用自己的 runId/端口/台账目录。结束发“已停止编辑和测试”信号；停止不等于总控 PASS。

## 窗口 2：P3-DB-FIXTURE-R1（测试隔离对象迁址）

> 你负责 `P3-DB-FIXTURE-R1`，解决 [R7 review](../../../AI_review/Codex-GPT6/P3-PARALLEL-R7_REVIEW.md) 的 CLOSE-B B1。先读 `evidence/P3-CLOSE-T01-B-PLAN-R2/{BLOCKERS.md,HARNESS_ADAPTATION.md}`、`tests/helpers/db-isolation.cjs`、`tests/isolation/{provision,live-probe}.cjs`、`backend/tests/t02c-instance-fixture.mjs` 与所有 `messages`/marker 消费点。独占测试隔离辅助代码、相应 `tests/isolation/` 测试、T02A/T02B/T02C 的**测试 fixture**及本包新证据；不改 W2 引擎、server、auth、restore、schema/migration、deploy 文档、CLOSE-B Jest 配置。
>
> 把 `public.messages`、`public.t02a_instance_marker` 和学校 schema 的合成 `messages` 迁到 **runId 派生的专用 fixture schema**，同步 `FIXTURE_CONTRACT`、`allowedSchemas`、context 校验、role grants、marker 所有权/只读权限反例、registry 白名单、live-probe 与 t02c fixture 的写入/清理。`public.revoked_tokens` 是 W1 正式基础设施，不把它当合成对象搬迁。**不得复用 `sentinelSchema`**：外部哨兵须继续由独立 owner 持有、测试角色不可写。不得给产品引擎增加测试白名单、attestation 或 extra-object 豁免。
>
> 保留原门禁场景、负例和 protected probe；若受保护测试中绝对路径断言必须改，逐项列旧/新断言、注释溯源、只改定位常量，不能删场景。先运行不导入 W2 引擎的隔离单元和自有实例门禁定点（与窗口 1 **不同实例、端口、台账目录**）；W2 相关 `--check`、真实 server/live-api、单实例全量回归只写实施前提，等窗口 1 停止并经总控复审后再由后续联测窗口执行。本包终态必须证明 public/学校业务 schema 无合成 extra、专用 fixture schema 仍可验证身份与清理、哨兵完全不变；不能为凑绿调用破坏性 opt-in。

## 窗口 3：P3-W2-LIFECYCLE-DESIGN-R4（逐发布 Prisma 合同）

> 你负责 `P3-W2-LIFECYCLE-DESIGN-R4`，**只在新证据目录**写设计修订、发布矩阵与 N/A 测试说明；旧 `P3-W2-LIFECYCLE-T01-R2-DESIGN-R3` HASHES 保留原状。先读 R7 生命周期裁决、该包 `DESIGN_R3.md`/`STAGED_RELEASE_MATRIX.md`、旧 `ENFORCEMENT_GATE.md`、当前 `schema.prisma`、`restoreService.js:552-596` 与 RC-04/RC-08。不得改产品/schema/正式 migration/client/测试，不跑 PG/Jest。
>
> 为 Release A（M1 后、存量 `principal_id` 可空）与 Release B（004 回填/G 系列后 M2 `SET NOT NULL`）分别给出**可部署的 `schema.prisma` 与生成 client 时点**，包括旧 NULL 行读取、写路径双写/系统主体、新校、disabled 校、失败停在 A 的兼容规则；不得在 A 使用终态 non-null client 却声称兼容。明确只有 A 已发布才可对存量跑 004，因此“首次单 release 时先完成 004”不得当作可执行捷径。
>
> 恢复路径要对照实际只有一次 `SCHEMA_ALIGN` 调用：若 M2 自足，在 align 内完成全部必要历史建档/绑定/门槛，并把其后 004 定义为审计复核而非前置回填；若 004 必须在 M2 前跑，提出具体的 staging hook/链停点归属和状态机变更，不能只画新状态。无台账旧备份的离线接入必须说明“修的是可重用源或新备份”，不得假定失败 staging 会被下一次 restore 复用。给 A/B 与恢复两条逐步命令/前后结构判据及失败保旧的反例矩阵。保持 A4/A5 授权和 G 系列不变量，实施 HOLD 不解除。

## 窗口 4：P3-W3-R2-CROSS-PLAN-R3（可重试恢复闭环）

> 你负责 `P3-W3-R2-CROSS-PLAN-R3`，**只在新证据目录**修订联测计划、接口缺口与 N/A TEST_RESULTS；旧 `P3-W3-R2-CROSS-PLAN-R2` 原样保留。先读 R7 W3 裁决、`TEST_PLAN_R2.md`、`restoreService.js:552-596`、`sync-tenant-schemas.mjs:129-170`、W2 `REPAIR_RUNBOOK.md`。不改任何产品/测试/fixture，不建实例、不跑 PG/Jest。
>
> 把 C2b/C3b 写成可执行的“失败备份 → 修复可复用的**源 schema**或导出新的受控备份 → 离线 proof/baseline → 对**新备份**重试恢复”路径；若选择临时 staging 处置，明确所需受控暂停/指定 schema CLI/台账与重试语义，标成产品接口 blocker，不能把 `--baseline-plan <code>` 直接指向随机 `_stg_<token>`。C2a/C3a 默认 `TENANT_MIGRATION_STATE_UNPROVABLE`、旧 schema 保留与零 baselined 仍是硬判据。C5 区分 **public** `_tenant_migration_locks` 与 **tenant** `_tenant_migrations`，分别查 extra-object/白名单。继续保留 C1/C4/C6、ACL grant option、真实受限角色访问、首轮 null Prisma 三时点 hash；写清 fixture B1 修复依赖和 W2-R5 复审门禁。交付 `RESULT.md`、`TEST_RESULTS.json`（N/A，不冒充运行）及证据双复验；真实联测继续 HOLD。

## 窗口 5：P3-DEPLOY-DOC-R3（现行部署文档校准）

> 你负责 `P3-DEPLOY-DOC-R3`。先读 R7 的部署文档段、`evidence/P3-W2-T01-R2-DOC/{BEFORE_AFTER.md,RESULT.md}`、`deploy/MIGRATION_FAILURE_RUNBOOK.md`、W2-R4 `RESULT.md`/协议及当前 `deploy/{README.md,DEPLOY_READINESS_REPORT.md}`。只改这两份**部署文档**和本包新证据；不改 `deploy.sh`、W2 产品/迁移、W1/W3/LIFECYCLE 测试与历史证据。无需 PG/Jest/实例。
>
> 删除仍残留的“无台账按见证自动 baseline”“`AUTO_SYNC_TENANTS=false` 只挡 readyz、不额外阻断租户 API”等旧事实；写准默认 check、false=`NOT_VERIFIED` + readyz/租户 API 503、public 未知额外对象全局阻断、无台账离线 proof/人工修复/显式 baseline、`deploy.sh` 失败保留现场与人工 runbook。锁接管与 baseline 的 R7 未决边界须写成**总控返工中**，不可把 R4 自报 PASS_LOCAL 写成完整 RC-04 验收；窗口 1 若正改代码，只描述已稳定的事实，不抢写尚未裁决的 R5 实现。逐句前后对照、静态代码交叉与编辑面反向证明；旧 R2-DOC HASHES 原样保留。

## 总控保留门禁

W2-R5 的执行者“停止”只解除编辑冲突，**不等于总控验收**。其独立复审和 fixture 迁址复审后，按 RC-04 与链尾排序依次安排 W1 auth public-only migration、LIFECYCLE 两次发布/schema/client、W3 跨包恢复联测，最后才考虑 CLOSE-B AUD-040 与独占单次全量回归。五窗任一发现新跨包冲突，只登记归属与证据，不越界修改兄弟文件。
