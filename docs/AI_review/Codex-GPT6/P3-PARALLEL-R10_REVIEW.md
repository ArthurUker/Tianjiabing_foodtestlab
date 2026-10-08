# Phase 3 并行轮次 R10 总控复审（2026-09-26）

本轮按 `REVIEW_LOG_MASTER.md` §0、§1、§4 与 R9 裁决，复审五份回执：`P3-FIXTURE-MIGRATED-R1`、`P3-PUBLIC-INFRA-CHAIN-R1`、`P3-LIFECYCLE-AB-R1`、`P3-W3-CROSS-REG-R1`、`P3-CLOSE-B-R1`。只读复核当前源码、交付证据与清单；未运行 PG、产品套件、全量回归，未提交或部署。独立哈希复验分别为 37/37、122/122、11/11、25/25，以及 CLOSE-B 的证据 39/39、源码 9/9、未触及 6/6，均 `ALL_MATCH`。这些是复核时点的文件一致性，不代替动态验收。

## 逐包裁决

| 包 | 总控裁决 | 下一步 |
|---|---|---|
| PUBLIC-INFRA-CHAIN-R1 | **PASS_LOCAL_SCOPE，附三项待闭合**。两条 public-only 链尾已入链，运行时锁表/吊销表 DDL 撤出；44/44 端到端、session 及保护套件有日志。链尾 13 文件、digest `a482f4214f31d01944a7f6314afe706ea997ce34983751e46ba56f8399ab737d`，停止信号有效。 | 历史 R6 `w2t02r6-cases.mjs` 实测 **rc=1、R6d 中止**，不能记作全绿；其 13 文件尾部假设需新契约用例收口。历史 FieldOption FK 守卫未限定 schema，需独立复现后用**前向迁移**修复，不改旧链。形状探针对索引只查名称/列序/唯一性，未查 `indisvalid`/`indisready`，须补失效索引负例。 |
| FIXTURE-MIGRATED-R1 | **PASS_STATIC / DYNAMIC_REWORK**。迁移先行、删除 db push/寄存、回放后授权等静态面成立；尚无动态实例/套件。 | **已独立复现硬冲突**：`tests/isolation/provision.cjs:160-183` 从 `authMiddleware.js` 取旧 `REVOKED_TOKENS_DDL`，公共链同一发布已删除该常量。直接调用 `assertRuntimeRevocationDdlInSync()` 得 `E_REVOCATION_DDL_SOURCE`、rc=1。先改为链上 migration/`publicInfraShape.js` 契约的只读比对，禁止重新引入运行时 DDL；再按 13 文件链跑 Phase 2 全部动态定点。 |
| LIFECYCLE-AB-R1 | **PASS_PREP / 实施 HOLD**。R9 username-only 保守拒绝已纳入计划，未改 schema/client/迁移；其 G-A/G-B 表是开工时历史快照，当时公共链未交付。 | G-A 现已满足；G-B 要求 fixture Phase 2 完成并停止。其后还须协调公共链后续修复与链尾 hash，再独占生命周期 A/B 实施。不能把准备包视为 A/B 已落地。 |
| W3-CROSS-REG-R1 | **IMPLEMENTATION_REWORK / 双实例 HOLD**。外部备份注册模块、API/CLI 与离线 11/11 已落；`writeAdminOpsLog` 经 `writeSystemLog` 的 `prisma.systemLog.create`，审计与 BackupRun 在同一事务，原子性主张有源码依据。 | `externalBackupRegistration.js:151,189` 允许 `meta.runId` 缺失并记 `external:unknown`；API 的 `sourceRunId` 亦可省略。与本包“验证来源、不得伪装本实例产物”的合同不合，须在注册前拒绝缺失/不一致来源，并增负例。双实例真实恢复仍未运行。 |
| CLOSE-B-R1 | **PASS_OFFLINE_SCOPE / FULL_REGRESSION_HOLD**。unit 28 suites/284 tests 离线通过；DB 缺 URL/context 非零且 0 tests，backend 递归 40/40 文件枚举；全量独占回归尚未运行。 | 等 fixture、公共链补证、生命周期、W3 双实例均停止且总控核验，再按 S0–S8 单实例单次执行。历史 270/310 不是本轮计数。 |

## 接力裁决

1. **立即放行窗口 1 的 fixture Phase 2**，但开跑前必须修掉 `E_REVOCATION_DDL_SOURCE`。它是测试契约与已交付公共链的直接接口冲突，不需等待另一轮许可。以 13 文件链尾 digest 为前置，动态套件任何失败须如实留 rc/日志，不改产品闸门凑绿。窗口 3 在它明文停止前不得改 migration/schema/client。
2. 公共链遗留项进入独立 follow-up：先在只读/隔离实例判别历史 FK 问题与失效索引；若成立，等 fixture Phase 2 停止后独占追加前向迁移并补形状探针。旧 13 文件迁移逐字节不改。R6d 旧 harness 的 rc=1 保留历史记录，新增用例分别覆盖 public-only 跳过（前置互斥失败不声称已记录）和实际租户迁移失败（保锁/台账诚实性）。补证后重新锁链尾。
3. W3 注册来源缺失可在其独占模块/测试面先修，避免与链/client 改动冲突；双实例真实恢复仍排生命周期之后。CLI 与 API 都要走同一 fail-closed 校验，旧格式若无 `runId` 不能标成已验证来源。
4. 生命周期实施须等待 fixture 与公共链 follow-up 的停止信号及新链尾 hash；A/B 两发布分开取证，username-only 不自动映射。CLOSE-B 全量回归最后独占。
5. 所有 PASS 仅为本地限定范围；生产迁移状态、部署、现网验证、提交仍未完成。§0/§4 冻结裁决未修改。

五个可转发执行任务见 `phase3/P3-NEXT_WAVE_R10_PROMPTS.md`。本轮独立静态反例：`node -e "require('./tests/isolation/provision.cjs').assertRuntimeRevocationDdlInSync()"` → `E_REVOCATION_DDL_SOURCE`；历史迁移 `20260726100000.../migration.sql` 的 FK `pg_constraint` 查询只以 `conname` 判存在；`publicInfraShape.js` 的 `INDEXES_SQL` 未读 `indisvalid`/`indisready`。
