# Phase 3 下一轮五窗口 prompt（R6）

依据：[R6 总控裁决](../../../AI_review/Codex-GPT6/P3-PARALLEL-R6_REVIEW.md)。五段可分别复制到五个 CodeBuddy 对话。**可同时开工**，但只有窗口 1 修改产品代码、运行隔离 PG；窗口 2–5 各守独立文档/证据面，不跑 PG、Jest 或全套件。W1/LIFECYCLE 的正式 migration、schema/client，W3 的真实跨包恢复和 CLOSE-B 实施仍等待 W2-R4 总控复审与下一次明确信号。所有窗口先读 `REVIEW_LOG_MASTER.md` §0/§4、Phase 2 RC-04（生命周期另读 RC-08），建自己的输入快照；保留兄弟未提交改动，冻结 29 只读核验；不读真实 `.env`、不连生产库、不 commit/stage/push/reset/clean/stash、不部署。交付 RESULT、COMMANDS、TEST_RESULTS（设计包注明 N/A）、原始 logs/rc、输入归因、HASHES_FINAL 双只读复验；建了实例须 down 三条件。

## 窗口 1：P3-W2-T02-R4（迁移闸门与台账返工）

> 你负责 `P3-W2-T02-R4`。先读 `docs/AI_review/Codex-GPT6/P3-PARALLEL-R6_REVIEW.md` 的 W2 四项反例，再读 `evidence/P3-W2-T02-R3/{RESULT.md,MIGRATION_CLASSIFICATION_PROTOCOL.md,TEST_RESULTS.json}` 与 RC-04。独占 `backend/lib/tenantProvisioner.js`、`backend/lib/tenantSync.js`、`backend/server.js` 的租户就绪区、`backend/sync-tenant-schemas.mjs` 及本包 `backend/tests/tenant-sync/` 新测试；不改 auth/restore/deploy/README/schema/migrations/W1/LIFECYCLE/W3 文件。保留 R3 的版本台账、显式 `@scope` 分类、无自动 baseline/重建、凭据卫生和现有定点，不将模拟 N7 当正式链尾验收。
>
 **R4-A：移除裸 attestation。** 当前 `TENANT_READINESS_ATTESTED=true` 只由 env 置位便在 `server.js` 的 global/school blocker 前 `next()`；移除该产品放行路径。`AUTO_SYNC_TENANTS=false` 且无真实检测结果必须保持 503。受保护 harness 的 `false` 前提在本包仅列逐文件适配清单，不跨界编辑；用本包真实 server 反例同时设置两个 env 值，仍断言租户 API 503。
>
 **R4-B：readiness 与流量阻断一致。** `buildTenantProjection` 分类异常、注册表 checksum 异常，以及 public 出现白名单外额外表时，要成为 traffic-blocking global blocker；异常读取仍是 CANNOT_CHECK。真实隔离库注入未分类 migration 与 public 未知表，在有明确 schoolCode 的请求上断言 readyz 503 **且** API 503；健康态仍 200。不要仅凭 `--check`/状态对象断言。
>
 **R4-C：迁移锁不允许活执行者被时间接管。** 现有 `locked_at` 30 分钟 stale UPDATE 可在长任务仍运行时让第二进程并发执行。实现能证明唯一执行者的机制（例如受同一会话持有的 PG advisory lock，或心跳+失权 fencing）；若本轮无法安全做，则禁自动 stale 接管并提供人工核实/清锁流程，使竞争者 fail-closed。真实双进程测试覆盖短时竞争、模拟“锁龄超限但旧执行者仍活”、进程退出后安全重试；不能只比最终台账行数。
>
 **R4-D：离线 baseline 原子性。** 当前 proof 后逐行 upsert，失败可留下半套 `baselined`；CLI 先建台账再证明。把证明校验、完整链台账写入放在可审计的互斥/事务边界，失败不留部分成功；同时拒绝过时计划和并发结构变化。用第 N 行故障注入与双执行者/现场变化反例分别证明，别把“最终 --check OK”代替中间状态证明。
>
 重跑 R3 10/10 unit、30/30 实例矩阵及新增反例，逐入口 rc/计数/skip/已知失败分栏。若有需修改受保护测试的情况，保留旧场景、注释溯源，按总账 probe 规则处理；未经总控实施信号不得创建 W1/LIFECYCLE migration。完成后发“已停止编辑和测试”明文信号、源码 hash 和与其它窗口的协议变更清单。

## 窗口 2：P3-W1-R1-PLAN-R3（auth public-only 协议对齐）

> 你负责 `P3-W1-R1-PLAN-R3`，**只在新目录** `evidence/P3-W1-R1-PLAN-R3/` 写修订计划、验证矩阵与证据；旧 R2 计划和 HASHES 保留原状，只读引擎源码。先读 R6 对 W1 的裁决、W2-R3 `MIGRATION_CLASSIFICATION_PROTOCOL.md`、`tenantProvisioner.js` 分类/台账实际代码与 W1 Phase A `MIGRATION_PLAN.md`。不改 `authMiddleware.js`、迁移文件、schema、fixture、测试，也不跑 PG/Jest。
>
 把旧提案 `@projection: public-only`、缺省 per-tenant、`@objects`、public-only 行 `projection_sha256=sha256('')` 改为**当前引擎实有**的 `-- @scope: public`、无缺省、`skipped_public_only` 及实际台账字段（目前 `projection_sha256=NULL`）；说明任何额外公共对象清单/见证能力尚未实现，不能假装已验收。给 `revoked_tokens` 表及 3 个索引列序/错形/缺失的 fail-closed 分工方案：W2 public 迁移/结构检查负责什么，W1 `AUTH_INFRA_MISSING` 探测负责什么，真实隔离库各怎么证明。保留 `idt`、`user_all` 与 securityRegression 18/18 基线。给正式 SQL 文件头和 `migrate deploy → db:sync → 启动` 顺序草案，标注“待 W2-R4 复审及总控链尾排序信号”，不得创建正式迁移。

## 窗口 3：P3-W2-LIFECYCLE-T01-R2-DESIGN-R3（M1/回填/M2 可执行顺序）

> 你负责 `P3-W2-LIFECYCLE-T01-R2-DESIGN-R3`，**只在新目录** `evidence/P3-W2-LIFECYCLE-T01-R2-DESIGN-R3/` 写设计修订、矩阵与证据；旧设计/旧 HASHES 保留原状。先读 R6 生命周期裁决、W2-R3 协议与 `applyTenantChain`/`db:sync` 顺序、W3 `restoreService.js` 的 SCHEMA_ALIGN→SWITCHING→drop-old 实际路径，以及 RC-04/RC-08。不改 schema/migration/产品/测试、不生成 client、不跑 PG。
>
 保留“固定系统 AuditPrincipal → 所有审计行有 principal_id → 最终 NOT NULL”的选择，修正不可执行时序：现有引擎会一次应用全部 pending，设计必须给出**可运行的阶段门禁**，例如先只发布并回放 M1、完成 004 数据回填与 G 系列计数，然后在另一个发布波次加入/回放 M2；若要单次发布，则先提出有真实代码支持的版本停点，不能仅在文档写 M1→004→M2。public 与所有 active/disabled tenant 的顺序、schema.prisma 终态与 M1 中间态、失败返回码都逐步写明。
>
 旧备份恢复必须在 staging 中完成 M1/回填/M2/验证**再切换**；任一步失败旧 schema 保留，不把“切换后仍 503”当作可回滚。对无台账旧备份按 W2-R3 默认 fail-closed，另列人工离线证明/修复后重试，不依稀疏见证自动 baseline。M2 中不能写运行时插值的 `"<schema>"` SQL；按 W2 搜索路径和 `@scope` 规则给可回放形态。更新 A/B/C/D 矩阵：旧库、系统事件、人类未映射行、disabled、恢复失败、M1/M2 分批。维持 A4/A5 受保护测试场景与实施 HOLD。

## 窗口 4：P3-W3-R2-CROSS-PLAN-R2（恢复联测计划修订）

> 你负责 `P3-W3-R2-CROSS-PLAN-R2`，**只在新目录** `evidence/P3-W3-R2-CROSS-PLAN-R2/` 写新版 TEST_PLAN、SCHEMA_ALIGN 补充与证据；旧计划和 HASHES 原样保留。先读 R6 W3 裁决、W2-R3 `RESULT.md` §2/§6 与 `REPAIR_RUNBOOK.md`、W3-R2 `RESULT.md`。不改产品/测试，不建实例，不跑 PG/Jest；原只读事实与旧日志保留，新的 hash 只覆盖本阶段新证据。
>
 将 C2/C3 的旧“无台账但前缀/head 见证可自动 baseline 成功”改成两段：默认恢复必须 `TENANT_MIGRATION_STATE_UNPROVABLE` 且旧 schema 保留；人工隔离 staging 中完成 `--baseline-plan` 的完整证明、修复与 `--baseline-apply` 后再重试，失败不能 drop-old。前缀历史若无法被“链末完整证明”覆盖，要明确 BLOCKER 和运维策略，不能靠见证自动推断。C1 当前版本与 C4 不可证明负例、ACL grant option 下界、受限角色真实访问、`_tenant_migrations` 白名单、首轮 null Prisma 的 hash/入口顺序复核继续保留。真实联测仍须等 W2-R4 总控复审后的独立信号。

## 窗口 5：P3-CLOSE-T01-B-PLAN-R2（统一回归计划更新，仍不启动）

> 你负责 `P3-CLOSE-T01-B-PLAN-R2`，**只在新目录** `evidence/P3-CLOSE-T01-B-PLAN-R2/` 写回归计划增量与证据；原 phaseB 盘点和 HASHES 原样保留，只读其他代码/任务包。先读 R6 调度、`evidence/P3-CLOSE-T01/phaseB/{INVENTORY.md,REGRESSION_PLAN.md}`、W2-R3/R4 当前协议、W1/LIFECYCLE/W3 的 HOLD 状态与 RC-04。不得编辑 `package.json`/Jest 配置/fixture/产品/既有测试，不建 PG、不跑任何套件或全量回归。
>
 移除旧 `TENANT_DB_PUSH_ACCEPT_DATA_LOSS=true` 准备条件，写成“public migrate deploy → 逐租户版本化回放/离线接入 → 启动只读检查”的真实 fixture 顺序；逐项标注 root Jest、PG integration、isolation、live-api、backend 单实例单次的前置合同与台账目录隔离。列出受保护 harness 使用 `AUTO_SYNC_TENANTS=false` 的路径、各自改为默认 check 所需的真实 migration/结构前提与场景保留方案；不要用 `TENANT_READINESS_ATTESTED` 假放行。保留 AUD-040 unit/db 门禁负例（缺 `TEST_DATABASE_URL` + `TEST_DB_CONTEXT_FILE` 非零且不 skip）、按文件执行数对账和 0 skip 纪律。只交计划与精确启动门槛：W2-R4、W1、LIFECYCLE、W3 cross 各自复审通过后总控另发独占全量回归信号。

## 总控保留门禁

W2-R4 的执行者“停止”只是结束编辑冲突，不等于总控 PASS。它通过独立复审后，先安排 W1 的 public-only 链尾并复审，再安排 LIFECYCLE 的 M1→回填→M2（不能与 W1 同时争 schema/client），随后 W3 跨包恢复联测；最后才可启动 CLOSE-B 独占全量回归与统一提交/部署决策。若期间协议有新证据，先修任务文本，不越过 §0/§4。
