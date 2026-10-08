# Phase 3 并行轮次 R6 总控复审

日期：2026-09-26。审阅五包：`P3-W2-T02-R3`、`P3-W2-T01-R2-DOC`、`P3-W2-LIFECYCLE-T01-R2-DESIGN`、`P3-W1-R1-PLAN-R2`、`P3-W3-R2-CROSS`。维持 `REVIEW_LOG_MASTER.md` §0/§4 与 Phase 2 RC-04/RC-08；本轮没有提交、部署或运行全套件。

## 独立核验边界

- 对当前工作树逐包只读复验 `HASHES_FINAL`：W2-R3 **84/84**、deploy 文档 **39/39**、生命周期设计 **11/11**、W1 计划 **12/12**、W3 计划 **16/16**，均 `ALL_MATCH`。冻结 29 **29/29 ALL_MATCH**；HEAD 为 `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，index 空。生命周期清单须用 `hash-final.mjs --verify <manifest>`；W3 须用 `hash-verify-readonly.mjs`。误将生命周期脚本传入 `--verify-only` 时，它在仓库根生成同名文件；已立即删除本次产物，并用正确的只读命令复验，不将错误命令的 rc 当通过证据。
- W2 执行证据记录 10/10 unit、30/30 隔离实例矩阵、3 个相邻安全入口 rc=0，实例 down 四条件为真。这证明已列定点，不等于 RC-04 的所有放行条件都已验证。本审阅没有重跑 PG/应用测试，没有访问生产库或真实 `.env`。

## 逐包裁决

| 包 | 裁决 | 理由与下一步 |
|---|---|---|
| **P3-W2-T02-R3** | **REWORK；不解除 W1/LIFECYCLE 实施门禁** | 六项 R5 缺口有实质进展：取消自动 baseline 与重建、明确 `@scope`、检查异常阻断、短时双进程互斥。但 attestation 环境变量无可信证明即可放流量；分类失败及 public 未知额外对象仍可能只挡 readyz、不挡可归属学校的 API；30 分钟锁接管不能保证原执行者已停止；人工 baseline 写台账非原子。见下文具体路径。 |
| **P3-W2-T01-R2-DOC** | **PASS_DOC_AS_OF_R2；现行部署说明待同步 R3/R4** | 只改两份文档、旧自动 resolve/db push 文字收口，39 项哈希及编辑面证明成立；A8 两行属于同一迁移配置主题，认可授权面。由于它与 W2-R3 并行，当前 `deploy/README.md:182,189,197,209` 仍写“见证自动 baseline”“空表自动重建”“false 不额外阻断”，与当前产品代码/新协议冲突。不能把此文档通过解释为现行运维说明已关闭。 |
| **P3-W2-LIFECYCLE-T01-R2-DESIGN** | **DESIGN_REWORK；产品实施 HOLD** | 固定系统 `AuditPrincipal` 使 `principal_id NOT NULL` 逻辑上可成立，旧 NULL 白名单已删除，方向认可。执行顺序仍不可用：`ENFORCEMENT_GATE.md §1/§4` 要 M1→004 回填→M2，但现行 `applyTenantChain` / `db:sync` 一次自动应用全部 pending，无法在 M1 与 M2 之间运行 004；旧备份“切换后再对齐”又与 W3 切换前 SCHEMA_ALIGN、失败保留旧 schema 的边界冲突。须给出链版本停点或分批发布的可运行顺序，并先在 staging 完成回填/门槛。 |
| **P3-W1-R1-PLAN-R2** | **PLAN_REWORK；产品实施 HOLD** | public-only migration-only 路线方向正确，但计划使用 `-- @projection: public-only`、缺省 per-tenant、`-- @objects` 与 `projection_sha256=sha256('')`；W2-R3 实际强制 `-- @scope: public|both`、无缺省，`skipped_public_only` 目前写 `projection_sha256=NULL`，也没有 `@objects` 解析/逐索引 public 见证。若照计划写正式 SQL 会 `TENANT_SCOPE_UNCLASSIFIED`。必须按实现协议改计划，并把 public 表与三索引的缺失/错形校验明确分配给 W2 引擎或 W1 认证。 |
| **P3-W3-R2-CROSS** | **PASS_READONLY_FACTS / PLAN_REWORK；联测 HOLD** | 16 项证据一致、未越权跑 PG；对首轮 null Prisma 的静态归因有价值。但 `TEST_PLAN.md` C2/C3 仍期望“无台账 + 前缀/head 见证 → 自动 baseline 并恢复成功”，W2-R3 已明确改为 `TENANT_MIGRATION_STATE_UNPROVABLE`。应先把 C2/C3 拆为“默认拒绝”与“离线完整证明、人工 baseline 后重试”两类，再安排联测。 |

## W2-R3 放行反例与执行要求

1. **裸环境变量绕过所有租户阻断。** `backend/server.js:335-342` 在检查 `globalBlockers` 和 `blockedSchools` 前遇 `r.attested` 直接 `next()`；`:514-538` 仅凭 `AUTO_SYNC_TENANTS=false` 与 `TENANT_READINESS_ATTESTED=true` 置位，没有读取离线核验结果、实例身份、迁移链摘要或有效期。日志“高危”、readyz=503 都不能阻止请求真正进入业务。N1b 反而把放行当成功断言。应撤掉产品路径的无证明放行；受保护 harness 改为已迁移实例上使用默认 `check`，保留原测试场景与溯源。
2. **分类错误和 public 未知对象可能只阻断 readyz。** `tenantSync.js:387-395` 把分类异常标为 `trafficBlocking:false`。对真实未知 public 表，`:410-412` 只记 `blocking`，没有加入 traffic-blocking global blocker；`:511-535` 令 `ok=false`、readyz=503，但健康学校不在 `blockedSchools`。`server.js:341-370` 在有学校 hint 时会继续 `next()`。应以真实 server/API 与隔离 PG 分别注入“未分类新迁移”“public 未知额外表”，断言 503 与状态码；不能只检查 `--check` 非零。
3. **过期行接管不等于旧执行者已退出。** `tenantProvisioner.js:598-616` 以 `locked_at` 超过默认 30 分钟为唯一接管条件，没有心跳或 fencing；长迁移仍运行时第二执行者可接管并对同一 schema 写入。当前双进程用例只覆盖短时竞争。须改成能证明旧执行者停止/失权的互斥机制；保守禁自动 stale 接管也可接受，但需给崩溃锁人工清理与真实竞争/超时证据。
4. **离线 baseline 台账落地缺原子边界。** `tenantProvisioner.js:774-816` 现场 proof 后逐行 upsert 全链，既无事务也无迁移互斥；中途失败可留下部分 `baselined` 行，之后的 retry/check 难以区分完整证明。CLI `sync-tenant-schemas.mjs:157-160` 还在 proof 之前 `ensureTenantLedger`。修为“现场证明 + 台账写入”可审计原子步骤；注入第 N 行失败，断言无半 baseline、无错误的“成功”台账，再用并发变更反例证明不会把过时 proof 当当前状态。

上述 1–2 是直接放流量缺陷，3–4 是版本化迁移的互斥/台账完整性缺陷。W2-R4 只需针对这些剩余点，保留 R3 已通过的能力及原始日志。协议 `@scope`、`skipped_public_only` 可供其它窗口做**设计修订**，但正式迁移和恢复联测继续等 W2-R4 总控复审。

## 交叉协议裁决与调度

- **迁移元数据以 W2-R3 当前可执行语法为临时对接基线**：新文件显式 `-- @scope: public` 或 `both`，无缺省；`@projection`/`@objects` 只是 W1 提案，不得写进正式 migration 当作已实现协议。R4 若调整，需文档、引擎、定点一并更新。
- 生命周期采用系统 principal 的终态目标，但 M1/004/M2 必须有真实“停在 M1”的路径；恢复升级须先在 staging 完成并证明，失败旧 schema 保留。不得把后切换阻断当作 W3 原子回滚的替代。
- deploy 文档先保留本轮审阅的“当时更正”证据；待 W2-R4 稳定后开小包同步现行 README/readiness/旧注释，不回写或篡改旧包 HASHES。
- 下一轮五窗口按 [P3-NEXT_WAVE_R6_PROMPTS.md](../../reviews/global-audit-20260924/phase3/P3-NEXT_WAVE_R6_PROMPTS.md) 分面。只有窗口 1 编辑 W2 产品代码并跑隔离 PG；窗口 2–5 只改各自设计/计划/证据文件，不跑 PG/全套件。**CLOSE-B、W1 auth migration、LIFECYCLE schema/client、W3 跨包真实恢复仍无实施信号。**
