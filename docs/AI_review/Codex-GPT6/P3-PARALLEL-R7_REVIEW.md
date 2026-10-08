# Phase 3 并行轮次 R7 总控复审

日期：2026-09-26。限定审阅 `P3-W2-T02-R4`、`P3-W1-R1-PLAN-R3`、`P3-W2-LIFECYCLE-T01-R2-DESIGN-R3`、`P3-W3-R2-CROSS-PLAN-R2`、`P3-CLOSE-T01-B-PLAN-R2`。维持 `REVIEW_LOG_MASTER.md` §0/§4 和 Phase 2 RC-04/RC-08。本次只读审阅，没有代跑 PG/Jest、改产品、提交或部署。

## 独立证据边界

- 五包 `HASHES_FINAL` 在当前工作树只读复验分别 **98/98、14/14、9/9、13/13、13/13 ALL_MATCH**；冻结 29 **29/29 ALL_MATCH**。这证明证据文件与其清单一致，不等于执行者的所有安全结论成立。生命周期包的核验入口是 `verify.mjs hash --verify <manifest>`；CLOSE-B 包为 `hash-verify-readonly.mjs`。
- W2-R4 `TEST_RESULTS.json` 记录 unit **6/6**、真实隔离实例矩阵 **44/44**、三个安全定点 rc=0、终态 `--check` rc=0、实例 down。四个 R6 直接反例中的 attestation 绕过、readiness 与 API 阻断脱节、存活 PID 的过期锁接管、第 7 行 baseline 写入失败均有相应真实证据。未把这些定点扩称全套件或生产验收。
- HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，index 空；兄弟未提交改动保留。审阅依据为当前源码和包内原始证据，不复写旧 HASHES。

## 逐包裁决

| 包 | 裁决 | 关键理由 |
|---|---|---|
| **W2-T02-R4** | **REWORK；RC-04 放行门禁不解除** | R6 四项直接反例取得明显进展，但“唯一执行者”仍未覆盖 Node 父进程死亡、`psql` 子进程/PG 会话继续执行的窗口；人工清锁存在读后删新持有者的竞态；baseline 事后证明失败发生在台账事务提交后，协议却称“任一步失败全回滚”。下列边界必须实测并修正。 |
| **W1-R1-PLAN-R3** | **PASS_PLAN；实施 HOLD** | 已改用实际 `@scope: public`、无缺省、`skipped_public_only` 与 `projection_sha256=NULL`；public 表/三索引事后见证明确标为未实现，W1 `AUTH_INFRA_MISSING` 自检列为待实现。认可 W1 负责运行时缺失/错形 503，W2 负责版本/分类/extra；索引缺失维持 Phase A 的 fail-closed 口径。不得据此创建正式 migration。 |
| **LIFECYCLE-DESIGN-R3** | **DESIGN_REWORK；实施 HOLD** | 两次发布让 M1→004→M2 有真实暂停点，方向可用；但 Release A 的 `principal_id` 可空与旧设计中 `schema.prisma` 取终态非空冲突，缺逐发布的 Prisma schema/client/读写兼容计划。恢复图把 M2 的 `SET NOT NULL` 放在 `STAGING_BACKFILL(004)` 之前，而当前 restore 只有一次 `SCHEMA_ALIGN` 调用，没有所画阶段。 |
| **W3-CROSS-PLAN-R2** | **PLAN_REWORK；真实联测 HOLD** | C2/C3 的“默认拒绝”已改对；人工修复后“重试恢复”仍无可执行对象：restore 每次创建新 staging 并从原备份重导，CLI `--baseline-* <code>` 固定映射 `school_<code>`，无法直接作用于随机 staging。需在源端修复后产生新备份，或设计受控 staging 暂停/指定 schema 接口。锁表是 public 对象，不能归入租户白名单。 |
| **CLOSE-B-PLAN-R2** | **PASS_READONLY_FINDING；实施 HOLD** | B1 硬冲突属实：门禁要求 `public.messages`/marker 和租户 `messages`，R4 对同名额外对象阻断流量。认可测试面迁址，**不得**把测试对象加入产品白名单。其 O1 举例的 `sentinelSchema` 不可直接复用：该 schema 属外部哨兵、受单独 owner/权限保护；应新建任务派生的专用 fixture schema，维护原哨兵不变量。B2“backend DB 组不 spawn server”须逐文件核对，不能当整个 `test:backend` 的事实。 |

## W2-R4 尚未闭合的可判别边界

1. **父进程死亡不证明 SQL 执行者死亡。** `tenantProvisioner.js:152-170` 启动独立 `psql` 子进程并把 SQL 写入 stdin；`:703-730` 只看同主机 Node PID 不存在就可接管，且不要求心跳过期。`:1152-1154` 的 fencing 检查只在每条迁移之前，`psql` 内正在执行的 SQL 没有同会话锁或事务内 fencing。现有 M3d 是人工造“死 PID”行，并未模拟父进程退出后子进程/PG 后端仍活。**这是源码可见、未被证据排除的并发窗口，不宣称已在本轮复现。** 最安全的即时修法是默认禁自动接管；若要自动接管，需真实会话终止证明和在 SQL 写入期间有效的 DB 互斥，并做原进程/子进程崩溃反例。
2. **人工清锁的 TOCTOU。** `sync-tenant-schemas.mjs:178-189` 先读持有者并提示，`forceReleaseTenantMigrationLock` 在 `tenantProvisioner.js:805-812` 再读后以 `schema_name` 单键删除；两次读取之间或读删之间，原锁可释放并被新活执行者拿到。`--yes` 必须携带所展示的 `owner + fencing_token` 做 CAS；不匹配拒绝并重新展示，不能删新锁。`isProcessAlive:647-653` 也只应把 `ESRCH` 认作死亡，其他错误视未知。
3. **baseline 的事务边界被写宽。** `tenantProvisioner.js:1018-1035` 在 `runPsqlBatch` 成功提交后才读整链、重新做结构证明并可能抛 `TENANT_BASELINE_POSTCHECK_FAILED`；`MIGRATION_CLASSIFICATION_PROTOCOL_R4_DELTA.md §4` 却称“任一步失败 → 全事务回滚”。第 7 行故障实证只覆盖提交前回滚。须在可受控并发结构变化反例下证明提交前结构/摘要仍成立，或把事后失败按“已提交、待人工复核”准确登记并阻断继续放行；不可声称台账自动回滚。合作式迁移锁也不能防独立 DDL 会话。
4. **锁表版本归属。** `_tenant_migration_locks` 目前由 `ensureTenantMigrationLockTable` 在产品 apply 路径 `CREATE/ALTER`，`backend/prisma/migrations` 尚无同名对象迁移。RC-04 的 public 结构版本化缺口仍登记；下一包先给链尾归属/顺序与旧表升级方案，不得与 W1/LIFECYCLE 同时抢 migration 链。只读检查路径未据此判成运行时写入。

## 跨包设计与测试阻塞

- **LIFECYCLE：** Release A 需明确 nullable schema/client、写入双轨或全新主体字段与旧行读取行为；Release B 回填完成后才切 non-null schema/client。旧备份的回填要么在 M2 前有真实 staging hook/版本停点，要么 M2 自足完成所有必需回填并取消“其后 004 是先决条件”的说法。对于无台账备份，人工 baseline 必须指向可被下一次恢复重用的源/新备份，不得假定一次失败的 staging 自动复用。
- **W3：** `restoreService.js:552-579` 每次新建 staging、重导原 SQL；`:590-596` 立即 align，失败清理。`sync-tenant-schemas.mjs:129-170` 的 baseline CLI 只认由 school code 派生的正式 schema。C2b/C3b 要写出源端修复、重新备份、证明文件与目标 schema 的闭环；C5 将 public 锁表与 tenant 台账分别检查。计划包缺本轮 `RESULT.md`/`TEST_RESULTS.json`，下轮补正式状态与 N/A 证据索引。
- **CLOSE-B：** `tests/helpers/db-isolation.cjs:47-48,110-115` 的 marker/允许 schema 集合、`tests/isolation/provision.cjs:288-324` 的 public/租户合成表与独立哨兵、`backend/tests/t02c-instance-fixture.mjs:205-287` 的重建点均需一并适配。新 fixture schema 必须由 runId 派生、纳入门禁可写范围与清理白名单，哨兵仍不可写；保留门禁负例和既有场景。旧计划的 `12/12` 等链末数量只作历史时点，不预设正式新 migration 后数量。
- **部署文档：** `deploy/README.md:182,197` 仍写“见证自动 baseline”和 `false` 不额外阻断；`DEPLOY_READINESS_REPORT.md:48` 仍将 `false` 说成“跳过检测”，未写租户 API 503。需按 R4 当前事实更正，并将 W2 锁/baseline 尚未获总控放行写成状态声明。

## 调度

下一轮五窗口见 [P3-NEXT_WAVE_R7_PROMPTS.md](../../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_R7_PROMPTS.md)。窗口 1 独占 W2 引擎产品面与隔离 PG；窗口 2 独占测试隔离 fixture 面，自己的 PG 实例与窗口 1 完全隔离；窗口 3/4 只做各自设计修订；窗口 5 只改部署文档。它们可以并行编辑，但跨包复证必须等窗口 1 停止并经总控复审。**W1 auth migration、LIFECYCLE schema/client、W3 跨包真实恢复、CLOSE-B AUD-040/全量回归继续 HOLD。**
