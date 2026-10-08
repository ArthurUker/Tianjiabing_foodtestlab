# Phase 3 并行轮次 R8 总控审阅（2026-09-26）

## 读序与范围

按 `phase3/REVIEW_LOG_MASTER.md` §1 读取，并保持其 §0、§4 与 Phase 2 RC-04/RC-08 裁决。本轮只审 P3-W2-T02-R5、P3-DB-FIXTURE-R1、P3-W2-LIFECYCLE-DESIGN-R4、P3-W3-R2-CROSS-PLAN-R3、P3-DEPLOY-DOC-R3。执行者的 `PASS_LOCAL` 是待审事实，不是总控结论。审阅为只读：未跑 PG/产品套件、未改产品代码、未提交或部署。

独立复核：五包 `HASHES_FINAL` 分别 128/128、42/42、9/9、14/14、29/29 `ALL_MATCH`；冻结 29/29；HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，index 空，`git diff --check` clean。上述 hash 证明证据包未漂移，不替代行为复现。定点 rc 与实例清理以各包原始 `RESULT.md`、`TEST_RESULTS`、`logs/` 为证；本轮没有重跑。

## 逐包裁决

| 包 | 总控裁决 | 证据与边界 |
|---|---|---|
| W2-T02-R5 | **REWORK**。R7 指名反例 ①–③ 已取得真实 PG 证据，④仅设计符合发包范围；RC-04 的执行者互斥与失败阻断仍未闭合。 | 新旧定点 6+7+44+9 全绿；但另有未受 guard 覆盖的写批、人工清锁与执行批之间的竞态、事后失败标记写不入时的阻断缺口，见下节。正式锁表 migration 仍未入链。 |
| DB-FIXTURE-R1 | **PASS_LOCAL（测试对象迁址）**；CLOSE-B 的 B1 测试对象与 extra-object 冲突在结构上消除。 | 68/68、34/34、15/15、22/22；合成对象进独立 fixture schema，marker 只读、哨兵独立，产品白名单未放宽。真实 server readiness 尚未联测；原租户业务表的正向隔离覆盖减弱，需补测。 |
| LIFECYCLE-DESIGN-R4 | **DESIGN_REWORK / 实施 HOLD**。R7 的 A/B client 形状、单次 align、可重用源方向已写准。 | G2A 时间水位不足以证明每条新审计写入均有 principal；B client 门禁与现行 deploy 顺序未接线；历史人类主体无 `user_id` 的映射策略须写明，见下节。 |
| W3-R2-CROSS-PLAN-R3 | **PLAN_REWORK / 真实联测 HOLD**。默认拒绝、public/tenant 对象分栏及提交后语义已修正。 | C2b/C3b 的可复用源与恢复目标若在同一库同一 `school_<code>`，修复源会修改原目标，无法同时证明失败路径保旧。计划需把源与目标物理隔离。 |
| DEPLOY-DOC-R3 | **PASS_AS_OF_R7 / 当前文档待同步**。 | 两份文档按 R7 时点正确更正 false 阻断、UNPROVABLE 与 fail-closed。W2-R5 已改变 `--force-unlock` CLI 为强制 `--owner/--fencing`，README 仍给 `--force-unlock <code> --yes`（`deploy/README.md:202`）；R7 返工态声明须待引擎裁决后更新。 |

### W2-R5 必须闭合的代码路径

1. `backend/lib/tenantProvisioner.js:1330` 的 `ensureTenantLedger()` 会执行建台账 DDL，而这一批没有 `migrationLockGuardSql()`；因此“所有写入批都受会话级 advisory + fencing 保护”尚不成立。应在真实 PG 以空租户、父进程死亡/子 psql 仍活的路径验证。
2. 同文件 `:1409` 的通用失败分支以**无 guard** 的 `baseInsert('failed', detail)` 写台账，且吞掉写失败，却无条件构造“已记入台账 failed”的错误。失权旧执行者可能覆盖现持有者状态；补 guard 后也应把“写入失败”与“已记录”分开报告，实测旧/新持有者竞争。
3. `forceReleaseTenantMigrationLock():890-907` 只对 row 做 owner/fencing CAS；CLI `backend/sync-tenant-schemas.mjs:190-210` 先查 `sqlExecutorInFlight()` 后执行 DELETE，两者不是同一事务的 advisory 互斥。写批可在探测与 DELETE 之间开始。人工清锁须在与执行批相同的 advisory 锁保护下完成 CAS，真实 PG 注入该间隙。
4. `baselineTenantFromProof()` 提交后证明失败时，`:1211-1230` 的 failed 标记更新可能失败并被 catch 吞掉；代码仍声称“该校保持阻断”。当 11 行仍 `baselined` 时，需证明 readiness 有独立 fail-closed 证据，否则建立持久阻断再宣称安全。测试须注入该 UPDATE 失败，保留 `committed=true/rolledBack=false` 的真实语义。
5. `LOCK_TABLE_VERSIONING_PLAN.md` 将正式 migration 后继续运行时 `CREATE/ALTER` 作为过渡，不能当作 RC-04 终态验收。锁表 migration 与撤出运行时 DDL/只读形状检查须同一可审发布协议排期；本轮仅承诺方案，故登记为门禁而非本包第④项越界。

这些是源码可见、现有 9 个新反例未覆盖的路径；本总控没有声称已在 PG 复现。R5 原反例结果仍成立，但不足以把 RC-04 放行。

### 其它交叉点

- `tests/integration/concurrency.test.js` 已把测试 DML 改到 schema-qualified 的 fixture 表。它证明 fixture 的物理隔离和门禁流程，但该查询不依赖租户业务 `search_path`；迁址后应在**已迁移的 A/B 学校真实业务表**补一组正向租户读写隔离，保留现有 22 项。
- `LIFECYCLE-DESIGN-R4/DESIGN_R4.md:78` 的 `created_at >= m1_at` 可被回填时间和应用可控时间绕过；它只能作观测指标，不能作“新写入必带 principal”的强门禁。`:90-101` 把 B client 的**生成**置于所有租户 B 链完成后，而 `deploy/deploy.sh:564` 当前先 `prisma generate` 后迁移；需给出构建、部署、激活三时点的可执行顺序。对 `user_id IS NULL` 但带历史 actor 快照的人类事件，M2 必须定义可证明映射或保守失败，不得误归系统主体。
- `W3-CROSS-PLAN-R3/TEST_PLAN_R3.md:42-53` 在单实例构造 `school_<code>` 源又恢复同校。修复该源会改变恢复目标原状态。建议源库与目标库使用**两个自有隔离实例**、同 school code、独立台账和备份产物；C2a/C3a/C4 的“目标失败保旧”在目标实例单独取证。
- 文档应等 W2 返工接口稳定后只做一次现行命令校准；`--force-unlock` 的当前帮助文本本身也有旧的 `--yes` 简写（`sync-tenant-schemas.mjs:111`），归 W2 产品面修。

## 下一轮编排与门禁

五个完整可转发窗口在 `phase3/P3-NEXT_WAVE_R8_PROMPTS.md`：W2-T02-R6（独占迁移引擎）、DB-FIXTURE-R2（仅集成测试）、LIFECYCLE-DESIGN-R5（只读新目录）、W3-CROSS-PLAN-R4（只读新目录）、HARNESS-CHECK-R1（三套真实 server harness）。窗口 2、5 分别用自有隔离实例；不得共享端口、数据库、台账或运行全套件。窗口 3/4 不跑 PG。五窗的既有文件编辑面互不相交；若发现交叉，先停该 hunk 并报告。

**未发信号**：W1 auth public-only migration、LIFECYCLE schema/client/M1/M2、W3 真实恢复联测、CLOSE-B AUD-040/单实例全量回归、部署/提交。DB-FIXTURE-R1 的结构修复不等于 CLOSE-B 全部前置条件通过。W2-R6 经总控复审前，其他包只能按各自限定面推进。

## 复核入口

原始包依次见 `phase3/evidence/P3-W2-T02-R5/`、`P3-DB-FIXTURE-R1/`、`P3-W2-LIFECYCLE-DESIGN-R4/`、`P3-W3-R2-CROSS-PLAN-R3/`、`P3-DEPLOY-DOC-R3/`。先读各 `RESULT.md` 与 `TEST_RESULTS`，再读上述源码行、原始日志与 hash。总账 §0/§4 始终优先；本轮记录不改早期裁决。
