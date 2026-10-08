# Phase 3 下一轮五窗口 prompt（R10，总控接力版）

以下五段可分别复制给 CodeBuddy。共同要求：先读 `docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md` → `docs/AI_review/Codex-GPT6/P3-PARALLEL-R10_REVIEW.md` → `phase3/REVIEW_LOG_MASTER.md` §0/§4 → 本包原始证据与源码。保持故意未提交工作树，不 reset/clean/stash/checkout，不 stage/commit/push/部署。每包做开工快照、独占编辑面与兄弟漂移归因、冻结 29 只读核验、逐入口真实 rc/log、收工 HASHES_FINAL 双复验；用自有隔离实例并在收尾 down，凭据不入证据。**五窗口可先读和做互不相交的工作；共享迁移链、client、动态恢复及全量回归按接力顺序串行。**

## 窗口 1（现在启动）：P3-FIXTURE-MIGRATED-R2 — 13 文件链兼容与 Phase 2 动态定点

> 续作 `P3-FIXTURE-MIGRATED-R1` Phase 2，任务名 `P3-FIXTURE-MIGRATED-R2`。先核对 `P3-PUBLIC-INFRA-CHAIN-R1/CHAIN_TAIL_LOCK.json`（13 文件，digest `a482f4214f31d01944a7f6314afe706ea997ce34983751e46ba56f8399ab737d`）与明文停止信号。公共链已删除 `authMiddleware.REVOKED_TOKENS_DDL`；总控实测 `provision.assertRuntimeRevocationDdlInSync()` 抛 `E_REVOCATION_DDL_SOURCE`。只在授权测试 fixture/harness 面修订 `tests/isolation/provision.cjs`、`backend/tests/t02c-instance-fixture.mjs`、`backend/tests/report-auth/report-auth-fixture.mjs` 及必要的 fixture 单测：从已版本化 migration 和 `backend/lib/publicInfraShape.js` **只读**核对吊销表/三索引形状，删除依赖旧运行时 DDL 常量和“缺失时产品路径建表”的假设；缺设施应拒绝，不得在测试准备阶段补建产品基础设施、改产品检查、使用 db push/resolve/SET SCHEMA/attestation/`AUTO_SYNC_TENANTS=false`。先给出旧失败→新静态护栏通过的证据。
>
> 随后在同一自有实例按现有 `P3-FIXTURE-MIGRATED-R1/COMMANDS.md §3` 执行：`provision up` → t02c fixture → report-auth fixture → isolation 68 → T02A 22 → 业务隔离 27 → live-api 49 → report-auth 20 → session 12。逐入口记真实计数、0 skip、`readyz=200` 与租户 API 可达、回放后受限角色 DML；若数字变化逐文件归因，不硬套旧数。失败保留原日志并修归属 fixture 问题，产品缺陷单列，不绕过闸门。收尾实例 down、输入 drift/冻结 29/HASHES 双复验。**完成且停止编辑测试后明文发接力信号**给窗口 2；在此之前窗口 2 不改 migration、窗口 3 不改 schema/client。

## 窗口 2（可先只读，等窗口 1 停止后编辑链）：P3-PUBLIC-INFRA-FOLLOWUP-R1 — 历史 FK/索引可用性与 R6d 口径

> 执行 `P3-PUBLIC-INFRA-FOLLOWUP-R1`。独占范围：`backend/lib/publicInfraShape.js`、相应 tenant-sync/session 定点；若真实复现历史 FieldOption FK 缺口，**仅追加** `backend/prisma/migrations/**` 的前向修复文件，绝不改旧 13 文件或 `schema.prisma`。先只读检查 `P3-PUBLIC-INFRA-CHAIN-R1/RESULT.md` F-1/F-2、`20260726100000_add_customization_columns_if_missing/migration.sql`、`publicInfraShape.js`。在自有实例构造“其它 schema 先有同名 `FieldOption_parent_option_id_fkey`、public 从零回放”的反例；若 public 真实缺 FK，待窗口 1 明文停止后追加与现行 `@scope` 投影兼容、按目标 schema 精确判别的**前向 migration**，空库/旧库/重复回放/逐租户链均需通过。不能修改已应用 migration checksum。若无法安全前向修复，登记阻塞与独立证据，不假绿。
>
> 另构造吊销表三索引存在但 `pg_index.indisvalid=false` 或 `indisready=false` 的隔离 PG 负例；只读形状探针应拒绝并让 `--check`/认证按已有阻断码 fail-closed。核对是否还需索引方法、谓词、表达式约束。R6 旧 `w2t02r6-cases.mjs` 在 public-only 尾部 rc=1 的历史证据不改；新增合同测试区分“public-only 跳过前置互斥失败、零迁移副作用、不得声称已记 failed”与“实际租户迁移失败后保锁/失败写入诚实性”，跑 R5/R6 相关不劣化。所有新链文件完成后锁定**新链尾 hash**、实例 down，并明文停止链编辑/测试；窗口 3 只能在此信号后动 schema/client。

## 窗口 3（等待窗口 1、2）：P3-LIFECYCLE-AB-R2 — A/B 真正独立发布

> 续作 `P3-LIFECYCLE-AB-R1`，先读其 `PLAN_A.md`、`TEST_PLAN.md`、`MAPPING_DELTA_R9.md` 与 R10 裁决。**在窗口 1 动态定点完成、窗口 2 公共链 follow-up 完成且链尾 hash 固定之前，只做只读准备，不编辑 schema/migration/client，不运行共享实例。**之后本窗独占生命周期相关 `schema.prisma`、新增链尾 migration、审计/grant/学校生命周期代码及其定点；A/B 各自交付快照与可复现 patch，按 R9 的 nullable A → 004 回填 → 自足 M2 → required B client 和部署两段门禁实施，禁止一次性最终树冒充滚动发布。用户名唯一/时间先后不得作为历史身份匹配证明；仅稳定主体 id 或独立可审映射证据可绑定，无法证明者在 M2 fail-closed。
>
> 先完成 A 并实测新写入 `CHECK ... NOT VALID`、旧行读取、grant 身份缺失/同 code 重建拒绝、W1 epoch 同事务；再完成 B 的回填/系统主体/M2、全租户 G2/G7/G8 与 A/B client 版本门禁、恢复 staging 单次 align 保旧、回退 A client。若 B 两段部署接口与当前 `deploy.sh` 不能安全接线，明确停在 B blocker，不能声称 B 完成；继续交付独立可验证的 A。受保护测试场景保留、必要更正溯源；禁全套件/提交部署。收尾逐阶段 rc/hash、实例 down，明文释放 migration/client 面给窗口 4。

## 窗口 4（来源修复可先做，真实恢复等窗口 3）：P3-W3-CROSS-REG-R2 — 来源 fail-closed 与 A/B 双实例恢复

> 续作 `P3-W3-CROSS-REG-R1`，独占 `backend/lib/externalBackupRegistration.js`、`backend/scripts/006_register-external-backup.mjs`、`backend/routes/adminBackupRoutes.js` 的**仅注册入口**、新增注册/恢复定点与本包证据；不得改 restoreService、迁移引擎、schema、fixture、deploy。先修 `meta.runId` 缺失仍被注册成 `external:unknown` 的来源缺口：CLI/API/服务层统一在落库前拒绝来源缺失或与显式源 runId 不一致；单校目标学校归属需由目标实例当前学校身份校核，不能仅信任 meta.schoolCode。保留旧产物格式需要独立受控接入方案与明确审计，不能默默标记“来源已验证”。补离线负例及真实 PG 审计事务回滚反例；已有 11 场景全保留。`restore-from-upload` 防伪造链零放宽。
>
> **只有窗口 3 明文停止并释放 migration/client 后**，按 `P3-W3-R2-CROSS-PLAN-R4/TEST_PLAN_R4.md` 用物理隔离的 A/B 两实例跑真实恢复：B 旧备份默认 `UNPROVABLE` 且保旧；A 修复可重用源→新备份；B 经产品注册入口导入 A 产物→恢复及重复恢复；分别验文件/meta hash、scope/school/source、ACL grant option 下界、受限角色真实访问、public 锁表/tenant 台账、readyz/API。若产品接口仍不足，单列 blocker 与人工准备对照，不能把人工插行算产品通过。A/B 双 down、逐阶段 rc、哈希、明文停止信号。

## 窗口 5（现在只读收口，最后独占全量回归）：P3-CLOSE-B-R2 — AUD-040 新入口与最终回归

> 续作 `P3-CLOSE-B-R1`。当前先只读核验 `ENTRY_MATRIX.md`、`package.json`/Jest configs/runner 与本轮各包的新增测试文件分布；确认 backend 递归枚举仍覆盖所有 `.test.mjs`，unit 入口离线、DB 缺双变量非零且 0 tests、0 skip、无 `.env`/`DATABASE_URL` 回落。若新增文件造成漏跑，仅在本窗独占的 runner/config 面修正并定点，不动产品/fixture/迁移/既有测试。
>
 **最终单实例单次全量回归必须等窗口 1–4 全部明文停止、总控核验交付且独占信号发出后启动**。按 `P3-CLOSE-B-R1/COMMANDS.md` S0–S8：新实例 public migrate deploy → tenant chain → `--check` → 默认 check server → root DB/unit、integration、isolation、live-api/report-auth/session、单次 `npm run test:backend`，逐文件数与逐入口 rc 对账，分 known/preexisting/new/skips（skip=0）。新失败先定位归属，不越界修产品；只有全部绿才报告 `PASS_LOCAL_REGRESSION`。实例 down、输入/冻结/hash 双复验；未提交/未部署边界说清。

## 接力顺序

窗口 1 修 fixture 接口并跑动态 → 窗口 2 再改公共链/形状检查并锁新 hash → 窗口 3 独占 A/B schema、迁移、client → 窗口 4 双实例真实恢复 → 窗口 5 最终单实例全量回归。窗口 4 的来源修复、窗口 5 的只读入口盘点可与前序窗口并行。各窗口执行中的“完成”是自报，下一闸门以总控复核和本文件明确的先后条件为准。
