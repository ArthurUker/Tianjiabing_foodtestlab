# PHASE 2 — Independent Adversarial Verification · BATCH B

- **基线**：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`（执行前后应用代码零改动、零 commit）
- **范围**：AUD-004 / 005 / 006 / 007 / 008 / 009 / 039 / 044
- **方法**：阶段 1 半盲（仅读 ID/标题/claim/trigger，独立追踪调用链并形成 provisional verdict）→ 阶段 2 读第一遍影响/修复方向/验收做交叉比对
- **探针**：`phase2/probes-batch-b.mjs`（真实纯函数 `schemaNameOf`/`localNow` + 源码路径断言；不连任何数据库；占位 DATABASE_URL 指向 `127.0.0.1:1` 不可达端口，Prisma 惰性连接，无真实连接）
- **半盲说明**：8 项的 provisional verdict 与最终判定一致；半盲阶段的独立发现（AUD-004 双校俱毁序列、AUD-008 部署回退留下 failed 记录、AUD-039 Prisma 自动加载 backend/.env）在阶段 2 与第一遍比对后保留为增量结论

## 结论速览

| Issue | Validity | Exploitability | Impact | Severity 建议 | 第一遍 |
|---|---|---|---|---|---|
| AUD-004 | CONFIRMED | REALISTIC_PRECONDITION | INTEGRITY / DATA_RECOVERY | **P1 保持** | P1 |
| AUD-005 | CONFIRMED | DIRECT（固有窗口）/ RARE（并发恢复） | INTEGRITY | **P1 保持** | P1 |
| AUD-006 | CONFIRMED | REALISTIC_PRECONDITION | DATA_RECOVERY（fail-safe 误拒） | **P2（降级，争议）** | P1 |
| AUD-007 | CONFIRMED | RARE_PRECONDITION | DATA_RECOVERY / RELEASE | **P2（降级，争议）** | P1 |
| AUD-008 | CONFIRMED | DIRECT（新库/重部署） | RELEASE_RELIABILITY | **P1 保持** | P1 |
| AUD-009 | CONFIRMED | DIRECT（默认启动必然执行） | INTEGRITY / RELEASE | **P1 保持** | P1 |
| AUD-039 | CONFIRMED | REALISTIC_PRECONDITION | INTEGRITY / AVAILABILITY | **P1 保持** | P1 |
| AUD-044 | CONFIRMED | DEPLOYMENT_DEPENDENT | CONFIDENTIALITY / INTEGRITY | **P1 保持（仲裁候选）** | P1 |

```
CONFIRMED:                  8
PARTIALLY_CONFIRMED:        0
FALSE_POSITIVE:             0
NOT_REPRODUCIBLE:           0
NEEDS_RUNTIME_VERIFICATION: 0   （AUD-008 的"生产库当前状态"为其子前提，见该项）
```

---

## AUD-004 · 恢复暂存 schema 可与另一所合法学校重名并被 DROP

**Original claim**：恢复 alpha 的暂存名固定为 `school_alpha_restore`，与合法学校 alpha-restore 的真实 schema 完全相同；准备阶段与失败清理中的 `DROP SCHEMA ... CASCADE` 会作用于另一学校真实 schema。

**Validity：CONFIRMED**（A 级：真实纯函数复现 + 完整破坏序列推演）

- **实际 entry point**：`POST /api/admin/backups/:id/restore`（平台超管）与 `POST /api/school/backups/:id/restore`（学校 admin/manager，`schoolBackupRoutes.js:35-43`）
- **完整调用路径**：`runRestore`（`backend/lib/restoreService.js:81`）→ `restoreSchema = ${schema}_restore`（:85）→ `DROP SCHEMA IF EXISTS "${restoreSchema}" CASCADE`（:110，STAGING 前置清理）→ STAGING/校验 → SWITCHING 双 rename（:196-202）→ 失败路径再次 `DROP SCHEMA IF EXISTS "${restoreSchema}" CASCADE`（:242）
- **关键证据**：`tenantClient.js:60-71`（`schemaNameOf('alpha')+'_restore' === schemaNameOf('alpha-restore') === 'school_alpha_restore'`，本轮真实函数复现）；`tenantClient.js:33`（`CODE_RE=/^[a-z0-9-]{1,40}$/` 允许 `-restore` 后缀）；两处 DROP 前均无 ownership/School 注册表交叉检查（源码断言）
- **前置权限**：平台超管 或 学校 manager；**部署条件**：无（纯应用逻辑）
- **DB 影响**：DROP CASCADE 误删 `school_alpha_restore`（alpha-restore 学校全部业务数据）；随后 SWITCHING 将该名字 rename 为 `school_alpha` → **alpha-restore 的 School 行仍存在但 schema 已消失，该校业务全 500，两校俱毁**（此完整后果为本轮半盲阶段补充的推演）
- **隐藏 guard**：无。`provisionSchool` 的 409（`tenantProvisioner.js:127-131`）只在"schema 已存在"时阻止**创建**学校，不阻止"先建校、后恢复"的危险序列
- **transaction / lock / ownership**：SWITCHING 是单事务原子 rename（:197-202）✓，但暂存名无所有权台账
- **cleanup / rollback**：失败清理（:240-242）无条件 DROP 暂存名——同样无 ownership 检查
- **实际 failure mode**：整校数据被 CASCADE 删除且不可逆（除非另有备份）

**阶段 2 交叉比对**：第一遍影响描述（"DROP 作用于另一学校真实 schema；学校经理恢复入口也调用该服务"）准确、未夸大；触发条件真实可达（`-restore` 是自然命名习惯）；reproducer（名称碰撞纯函数）忠实。第一遍未漏保护机制。**修复方向不破坏升级路径**（随机工作 schema + ownership 台账为增量改造）。

**Severity rationale**：P1 保持——破坏性为整校 DROP CASCADE（INTEGRITY/DATA_RECOVERY），触发只需一个自然命名的学校共存 + 一次恢复操作（REALISTIC_PRECONDITION），无技术 guard。

---

## AUD-005 · 在线恢复缺少同校互斥和写入暂停机制

**Original claim**：同校两个恢复请求并行，或恢复准备期间正常业务继续写入；无 per-school 锁、请求排空或写屏障。

**Validity：CONFIRMED**（B 级：代码路径确定）

- **实际 entry point**：同 AUD-004（平台超管 + **学校 manager** 双入口——低权限面使并发/误操作更可达）
- **完整调用路径**：两个并发 `runRestore` 共享同一暂存名 `school_<code>_restore`：都先 `DROP ... IF EXISTS`（:110）互删对方 STAGING 中间产物 → 行数校验混乱/互相失败；STAGING（分钟级）期间业务写入落**原 schema**，SWITCHING 原子 rename 后这些**已返回成功的写入随旧 schema 离线**（:196-203）
- **关键证据**：`restoreService.js` 全文无 `pg_advisory`/mutex/drain/writeBarrier（源码断言）；`readOnlyMiddleware.js:14`——`READONLY_MODE !== 'true'` 默认放行，且**恢复流程自身不设置该模式**；`docs/deployment/backup-module.md:206` 仅描述 READONLY_MODE 用法（人工预设 + Caddy 双保险），无与恢复操作的代码联动
- **逐项核对**（用户特别要求）：per-school mutex ❌；advisory lock ❌；maintenance state ❌（仅人工预设）；write barrier ❌；in-flight request drain ❌；tenant Prisma reconnect——**不需要**（rename 后 schema 名不变，`?schema=` 引用自动指向新 schema；第一遍修复方向中"重建租户连接"一项并非必要，属过度要求）
- **隐藏 guard**：`createReadOnlyGuard` 存在但默认关闭且需重启级人工配置
- **实际 failure mode**：并发恢复互相清理导致随机失败；STAGING 窗口内已确认写入静默丢失

**阶段 2 交叉比对**：第一遍影响（"恢复任务会清理彼此同名暂存 schema；切换到旧备份时，期间已返回成功的新写入不在当前 schema 中"）准确。未漏保护机制。修复方向大体合理，但"重建租户连接"非必要（如上）。

**Severity rationale**：P1 保持——每次恢复都有分钟级"已确认写入丢失"固有窗口（DIRECT），且学校 manager 可触发使并发可达性上升；影响为业务数据完整性。

---

## AUD-006 · 备份元数据行数与 pg_dump 不共享数据库快照

**Original claim**：先 collectTableCounts，再采集结构，最后 pg_dump；两阶段之间的写入使 meta 计数与 dump 内容不一致。

**Validity：CONFIRMED**（B 级：代码路径确定，snapshot 语义按 PostgreSQL 机制审查）

- **实际 entry point**：`runBackup`（`backend/lib/backupService.js:330-454`）——CLI/systemd timer 与 API（管理员/学校经理）共用
- **完整调用路径**：`collectTableCounts`（:357 → `:107-121`，经 Prisma 连接池**逐表** `SELECT count(*)`，每条查询独立 autocommit 快照）→ `collectSchemaSnapshot`（:361 → `:129-148`，另一时间点）→ `runPgDump`（:375 → `:162-197`，**独立子进程**，参数仅 `--schema=`，无 `--snapshot`）
- **snapshot 审查**（用户特别要求"不要仅凭函数先后顺序判断"）：三阶段分别处于不同连接/进程/事务——Prisma 连接池的每条 count 是独立 `READ COMMITTED` 快照（甚至各表之间时间点也不同）；pg_dump 是独立进程自己的导出快照。要共享需 `pg_export_snapshot()` + 同连接传递（或 pg_dump `--snapshot`，PG14 起支持）——实现均未使用。**结论：非共享快照，判定不依赖先后顺序而依赖连接拓扑，成立**
- **隐藏 guard**：L1（CREATE TABLE 数）不受行数影响；恢复侧行数校验（`restoreService.js:174-193`）严格比对 → 任何漂移都导致**恢复被拒绝**
- **实际 failure mode**：备份时段有写入 → 恢复时 `mismatches` 非空 → `VALIDATING` 失败 → 恢复被拒（fail-safe 方向：**不会接受坏数据，只会误拒好备份**）

**阶段 2 交叉比对**：第一遍影响（"备份可以生成成功，但恢复按旧 tableCounts 严格校验新 dump，产生行数不一致并拒绝恢复"）**准确且已如实标注 fail-safe 方向**——未夸大为数据损坏。trigger（业务时段备份）REALISTIC。

**Severity rationale：建议 P2（降级，争议点）**——影响是灾备流程可靠性（DATA_RECOVERY）：恢复间歇性误拒、需重跑备份，但不产生数据损坏、不放宽任何校验；P1 论点（灾备 SLA）成立空间存在，列入仲裁。修复（REPEATABLE READ + `pg_export_snapshot` 传递）不破坏升级路径。

---

## AUD-007 · 同秒同范围备份共享文件名，存在覆盖和互相清理竞态

**Original claim**：管理员、学校经理或定时任务在同一秒备份相同 scope；文件名只有 scope/schema 与秒级时间。

**Validity：CONFIRMED**（A- 级：真实 `localNow` 同秒复现 + 源码路径）

- **实际 entry point**：同 AUD-006（`runBackup`）
- **完整调用路径**：`ts = localNow().toISOString().replace(...).slice(0,15)`（:364，**秒级**）→ `baseName = ${scope==='all'?'all-databases':dumpSchema}.${ts}`（:365）→ `tmpGz/aesPath/metaPath` 同名族（:366-368）→ 失败清理 `unlink(aesPath)`+`unlink(tmpGz)`（:395-399）
- **逐项核对**（用户特别要求）：filename entropy ❌（无 Math.random/UUID，源码断言）；tmp path——与产物同名族（`.sql.gz.tmp`）非专属目录；rename ❌（无原子发布，直接写最终路径）；cleanup——**按路径互删**（一方失败会删掉并发同伴已成功的 `.aes`）；scope locking ❌（`backupService`/两个路由文件均无 isRunning/inFlight 互斥，grep 确认）
- **本轮真实复现**：`localNow` 同秒两次调用生成相同 `ts`（探针实测 `sameSecond=true`）
- **实际 failure mode**：同秒启动的备份 A/B 写同一 tmpGz（pg_dump 输出交错损坏）→ L1 失败；或 B 覆盖 A 的 `.aes`；失败方清理删除成功方产物 → `BackupRun` 记录指向不存在的文件（恢复时才发现）。**原数据无损**——损失的是该次备份产物，可重跑

**阶段 2 交叉比对**：第一遍影响（"两个任务写同一个 .tmp/.aes/.meta，可能覆盖已生成内容；任一失败清理会删除另一个任务的产物"）准确。trigger 真实但**罕见**（需同秒启动：定时任务与手动同秒、或双击）。

**Severity rationale：建议 P2（降级，争议点）**——RARE_PRECONDITION + 后果为单次备份产物损坏/丢失（可重跑、原数据无损）+ L1/verify 校验能暴露损坏产物。第一遍 P1 的理由（备份可靠性）可辩护，列入仲裁。

---

## AUD-008 · 全新数据库无法从已提交 migration 链部署

**Original claim**：空库 `prisma migrate deploy` 因 baseline 未创建 `visible_menu_items` 而在后续 migration 中断（第一遍独立 PG 实测 P3018/42703）。

**Validity：CONFIRMED**（A 级：第一遍独立 PostgreSQL 实测；本轮不重复执行，按用户要求转向根因与状态分析）

- **migration 历史为何不自洽（根因）**：`visible_menu_items`/`canteens`/`guest_enabled` 等列的引入走**运行时 DDL**（`tenantSync.js:110-155` 的 `ADD COLUMN IF NOT EXISTS`）与 db push，**未沉淀为 migration**；baseline（2026-07-26 提交，由当时 schema.prisma `migrate diff --from-empty` 生成）不含这些列（本轮源码断言确认）；而 2026-08-14 的 `unify`（:15 `ALTER COLUMN "visible_menu_items"`）与 `revert`（:13）在**当时生产库**上成立（列已由运行时 DDL 补齐）→ 链条只在"db push 演进过的库"上自洽，**空库回放断裂**
- **baseline 与后续 migration 的真实关系**：baseline 是"接入锚点"而非"可回放起点"——其注释（`migration.sql:1-13`）明示生产接入方式为 `prisma migrate resolve --applied 20260726000000_baseline`（登记不回放）
- **已有生产库可能处于什么状态**：三种可能——①已按注释执行过 `resolve --applied baseline`（链健康，但空库回放断裂仍在）；②从未执行（migrate deploy 首跑时 baseline `CREATE TABLE "User"` 因表已存在而失败 → deploy.sh 判定非首部署 → **fail，重部署被阻断**）；③首部署走了"migrate deploy 失败 → db push 回退"（`deploy.sh:512-527`）→ `_prisma_migrations` 残留 **failed 记录** → 下次部署（非首）migrate deploy 遇 failed → **fail**。②③均为阻断态；**生产实际处于哪种状态需检查 `_prisma_migrations` 表（本轮禁止连生产，标记为该 issue 的 NEEDS_RUNTIME_VERIFICATION 子前提）**
- **deploy.sh 的次生问题**：`npx prisma migrate deploy 2>/dev/null` 吞掉错误输出（本轮源码断言），失败根因在部署日志中不可见
- **怎么修才不破坏已有实例**：①**不修改 baseline 文件本身**；②在 baseline 与 unify 之间插入补丁 migration（如 `20260726100000_add_customization_columns_if_missing`，全部 `ADD COLUMN IF NOT EXISTS`，类型与当时生产一致 jsonb）——已 resolve 的库执行无害（幂等），空库回放后 unify/revert 可通过；③deploy.sh 去掉 `2>/dev/null`；回退 db push 后显式处理 failed 记录（`migrate resolve --rolled-back`）或至少 fail-fast 告警；④生产接入策略（是否需要 `resolve --applied`）依生产实际状态由 Astra 定夺
- **是否存在 `migrate resolve` 历史状态问题**：存在——路径③的 failed 记录会让后续每次 `migrate deploy` 拒绝执行（Prisma 要求人工 resolve），而 deploy.sh 对此无任何处理（源码断言：回退分支无 resolve 调用）

**阶段 2 交叉比对**：第一遍影响（"实测 P3018/42703 中断；db push 回退不能证明 migration 链正确，也不会自动解决失败 migration 的历史状态"）**准确且已预见了 failed 记录问题**；未夸大。本轮增量：生产三种状态的阻断路径具体化 + 修复方案不破坏已有实例的具体设计。

**Severity rationale**：P1 保持——RELEASE_RELIABILITY：全新环境不可从受控 migration 部署（实测），且生产重部署存在被阻断的代码路径（若未 resolve）；回退 db push 掩盖问题并留下持久 failed 状态。

---

## AUD-009 · 启动自愈默认执行可丢数据的 schema push，且租户失败仍汇总成功

**Original claim**：启动时 AUTO_SYNC_TENANTS 未置 false（默认执行）或部署调用租户同步；`--accept-data-loss` 允许未审批变更；单校失败被吞、汇总仍成功。

**Validity：CONFIRMED**（B 级：代码路径确定，"默认必然执行"经部署链确认）

- **"代码可能执行" vs "默认生产启动必然执行"（用户特别要求区分）**：**必然执行**——`server.js:372-382`：`selfHealTenantSchemas()` 在 `app.listen` 回调中调用，仅当 `AUTO_SYNC_TENANTS === 'false'` 显式跳过（默认未设 → 执行）；`.env.example` 中无该项 → 标准 `.env` 不会关闭它。部署链另有 `deploy.sh:577-578` 调用 `SKIP_PRISMA_GENERATE=1 node sync-tenant-schemas.mjs`（db:sync）
- **完整调用路径**：`selfHealTenantSchemas` → `syncAllTenantSchemas`（`tenantSync.js:168`）→ 循环 `provisionSchool({..., allowExisting: true})`（:184）→ `runPrismaPush(['prisma','db','push','--skip-generate','--accept-data-loss'], ...)`（`tenantProvisioner.js:150`；`alignTenantSchema` 同参 `:272`，共 2 处，源码断言）
- **error swallowing**：单校失败 `catch → log('❌') 继续`（`tenantSync.js:186-189`），循环结束无条件打印"✅ 所有租户 schema 已对齐"（:210）；`syncAllTenantSchemas` 对单校失败**从不 reject**
- **deployment continuation**：`backend/sync-tenant-schemas.mjs` 仅在**顶层** reject 时 `process.exit(1)`（源码断言）→ 单校失败时 **db:sync 退出码 0** → `deploy.sh:578` 的 `|| fail` 不触发 → **部署继续发布**
- **隐藏 guard（本轮发现的对第一遍的补充）**：`tenantSync.js:174-179` 只同步 `status: 'active'` 的学校（停用校跳过）——缩小影响面但不改变结论；注释自述"破坏性变更不得依赖本处 db push"是**纪律约束而非技术阻断**（`--accept-data-loss` 就在参数里）
- **实际 failure mode**：schema.prisma 含删列/改类型变更时，重启即对全部 active 租户执行破坏性 push（静默丢列/丢数据）；部分租户失败无任何聚合告警

**阶段 2 交叉比对**：第一遍影响（"--accept-data-loss 允许未审批的列/类型变更在运行中执行；单校异常被吞掉……部署调用方可能继续发布"）准确。触发条件真实（默认路径）。

**Severity rationale**：P1 保持——DIRECT（默认启动必然执行）+ INTEGRITY（静默数据丢失）+ RELEASE（失败不阻断）。**修复顺序依赖**：必须先完成 AUD-008（结构演进收敛到 migration），才能把本项的启动自愈降级为"检查+告警"——若先去掉 `--accept-data-loss`，P2022 租户漂移问题会回归（该自愈机制的存在理由，见 `tenantSync.js:7-11`）。

---

## AUD-039 · 旧测试使用普通 DATABASE_URL 并执行跨范围破坏性清理

**Original claim**：在已有业务环境直接运行 npm test / test:integration；旧测试无统一隔离门禁，接收普通 DATABASE_URL，部分用固定 schema/用户名。

**Validity：CONFIRMED**（B 级：代码路径确定；未执行任何真实 destructive 操作）

- **实际 entry point**：`npm test`（根 jest：`tests/**/*.test.js`，`jest.config.cjs` 无隔离门禁，仅 TextEncoder polyfill——`tests/setup-env.js` 源码断言）与 `npm run test:integration`（`tests/integration/jest.integration.config.cjs`）
- **三条具体链路（含本轮增量）**：
  1. `tests/integration/pg-bootstrap.js:19-25`——`getDatabaseUrl()` 直接 `process.env.DATABASE_URL ||`（**无专用隔离变量**）；`TENANTS=['school-a','school-b','school-c']`（:14）→ schema `school_school_a/b/c`；`bootstrapTenants` `CREATE SCHEMA IF NOT EXISTS` + `TRUNCATE`（:48-57）；`teardownTenants` **`DROP SCHEMA IF EXISTS ... CASCADE` ×3 + `DROP TABLE public.messages`**（:79-81）
  2. `tests/integration/roleAuditTrigger.test.js:22-24`——直接 `process.env.DATABASE_URL`；`SCHEMA = TEST_SCHEMA || 'school_tjb'`（**生产种子学校**）、`TEST_USERNAME || 'test'` → 在目标库的 `school_tjb` 上 UPDATE role、写 `revoked_tokens`（吊销该校全部会话）、写 AuditLog
  3. `tests/p0ProvNoAdminInSchool.test.js:34`——`import { PrismaClient } from '../backend/node_modules/@prisma/client'` + `new PrismaClient()`：**Prisma Client 会自动加载 `backend/.env` 的 DATABASE_URL**（无需 shell 环境变量）→ 在部署机上裸跑 `npm test` 即直连业务库；该测试调用 `purgeInvalidAdminInSchools(prisma)`（**全库扫描所有 schema 并把 role=admin 降级**——随机测试学校不能限制其作用范围）；其自建 schema 为随机名（`'demoregress'+random`），dropSchema 范围可控，但操作对象是业务库
- **破坏性清理范围**：DROP SCHEMA（固定名）+ DROP TABLE（public）+ TRUNCATE + 全库 admin 降级 + revoked_tokens 写入
- **隐藏 guard**：roleAuditTrigger 有 `if (!DATABASE_URL) skip`（只防无变量，不防指向业务库）；其余无任何"测试库白名单/名称校验"
- **实际 failure mode**：开发者/运维在业务服务器上误跑 `npm test` → p0Prov 直连业务库（自动 .env）执行全库 admin 降级等；`test:integration` 在 DATABASE_URL 已导出的 shell（如 systemd EnvironmentFile 场景）→ 若业务库存在 code 为 `school-a/b/c` 的学校则整校 DROP CASCADE

**阶段 2 交叉比对**：第一遍影响（"可 DROP 固定 school_a/b/c schema、修改默认 school_tjb/test 角色，或通过 purgeInvalidAdminInSchools 修改连接库所有学校的 admin。随机测试学校不能限制全库 purge 的作用范围"）**准确且全面**（比我半盲阶段多指出 purge 的全库范围）。触发 REALISTIC（`npm test` 是最常见命令）。

**Severity rationale**：P1 保持——REALISTIC_PRECONDITION + INTEGRITY/AVAILABILITY（误操作即 DROP 生产 schema / 吊销生产用户 / 全库降级）。后端 mjs 测试已有严格隔离门禁（`REVIEW_TEST_DATABASE_URL`），问题集中在旧 Jest 套件。

---

## AUD-044 · 示例 JWT_SECRET 是已知固定字符串，却未被启动保护拒绝

**Original claim**：复制示例环境后配置数据库但未替换 JWT_SECRET；示例值不在 KNOWN_WEAK_SECRETS 列表，也没有足够强度校验。

**Validity：CONFIRMED**（B 级：代码路径确定；deployment-dependent）

- **实际 entry point**：`backend/server.js:69-86`
- **完整调用路径**：`.env.example:33` → `JWT_SECRET=please-run-openssl-rand-hex-32-and-replace-this`（本轮探针提取）；`server.js:76-82` `KNOWN_WEAK_SECRETS` 共 5 项（`'your-super-secret-jwt-key-change-this-in-production'` 等，源码解析）→ `includes(JWT_SECRET)` **不含示例值**（探针断言）→ 校验仅"非空 + 弱列表"，无长度/熵检查（源码断言：无 `JWT_SECRET.length` 等）→ 启动继续 → 用公开已知字符串签发 JWT
- **逐项核对（用户特别要求）**：
  - 是否真的进入示例配置：**是**（`.env.example:33` 实测存在该值）
  - startup guard 是否拒绝：**否**（值不在列表）
  - production 是否可能沿用：**仅手工部署路径**——`deploy/deploy.sh:407` `[ -z "$JWT_SECRET" ] && JWT_SECRET=$(openssl rand -base64 48)`（deploy.sh 自动生成）；`deploy.adapter.example.conf:48` `JWT_SECRET=""`（留空 → 生成）；deploy.sh 是文档化部署路径 → 经 deploy.sh 的实例**不受影响**
  - 文档风险还是真实部署风险：**真实部署风险（尾部）**——手工部署者 `cp .env.example .env` 且只改数据库项即可中招；一旦中招，攻击者可伪造任意已存在 userId 的 token（authenticateUser 的 DB 回查只确认用户存在与状态，role 用 DB 值覆盖——伪造者冒充**真实存在的管理员**即可通过），认证完全绕过
- **实际 failure mode**：公开密钥 → 伪造 admin/manager JWT → 全系统越权（含学校写接口、备份恢复、学校管理）

**阶段 2 交叉比对**：第一遍影响（"服务接受公开可知的签名密钥……实际影响仍取决于数据库主体/权限回查。未声称现网使用此配置"）**准确且克制**（正确指出需目标主体存在）。修复方向（示例留空 + 拒绝全部占位值 + 长度校验）不破坏任何升级路径（只影响误用场景的启动）。

**Severity rationale**：**P1 保持（仲裁候选）**——Exploitability 为 DEPLOYMENT_DEPENDENT（仅手工部署 + 忘改提示性占位值），但一旦发生即 CONFIDENTIALITY+INTEGRITY 全失；修复成本接近零（把自身示例值加入弱列表/示例留空），符合"低成本消除的高危尾部风险"保 P1 逻辑；若团队按"deploy.sh 是唯一受支持路径"裁定为文档风险，降 P2 亦合理 → 列入仲裁。

---

## 阶段 2 总比对结论

| 检查项 | 结论 |
|---|---|
| 第一遍漏掉保护机制 | **未发现**（8 项均无被遗漏的 guard；反向：我逐项排查了 provision 409、READONLY_MODE、L1/verify 校验、jest skip、deploy.sh 自动生成——均不足以推翻） |
| 第一遍 trigger 真实可达 | 全部真实（004/006/039 为 REALISTIC，005/008/009 为 DIRECT，007 为 RARE，044 为 DEPLOYMENT_DEPENDENT） |
| 第一遍 impact 夸大 | **无夸大**；006/007 的影响描述方向准确（fail-safe/产物损坏），是 severity 定级而非事实问题 |
| 第一遍 reproducer 忠实 | 忠实（004 纯函数、008 独立 PG 实测均复核一致；无 mock 改变安全边界——本轮探针全部使用真实模块/纯函数） |
| production-only / deployment-dependent | 008（部署/新库）、044（手工部署）、039（业务环境误跑）属此类；004/005/006/007/009 为应用逻辑固有 |
| 共享 root cause | 见下 |
| 修复建议破坏升级路径风险 | 008 的正确修法（补丁 migration + resolve 策略）**不破坏**已有实例；**反向依赖**：009 的修复必须晚于 008（否则 P2022 漂移回归）；005 修复方向中"重建租户连接"为非必要项（rename 保名，Prisma 引用自动跟随） |

### 共享 root cause（4 组）

1. **恢复暂存命名空间为"固定派生名"**（AUD-004 + AUD-005）：既可与真实租户撞名（004），也让并发恢复互踩（005）。一次重构（随机唯一暂存名 + per-school advisory lock + ownership 台账）同时解决两项。
2. **备份产物基于非原子、非独占的时间点操作**（AUD-006 + AUD-007）：计数无共享快照（006）、文件名无熵无锁（007）。同属备份产物一致性工程。
3. **schema 演进依赖运行时 DDL / db push 而非受控 migration**（AUD-008 + AUD-009）：列未沉淀进 migration 导致空库回放断裂（008）；启动自愈用 `--accept-data-loss` 兜底漂移（009）。先修 008 才能安全修 009。
4. **测试/示例配置的"信任环境"假设**（AUD-039 + AUD-044）：测试信任 DATABASE_URL 与自动 .env（039）；启动信任 .env.example 的占位密钥（044）。同属部署卫生。

---

## 1. 最可信问题

- **AUD-004**：真实函数复现 + 无任何 guard 的两处 DROP CASCADE + 完整双校俱毁序列，证据链完整。
- **AUD-009**："默认生产启动必然执行"经启动代码 + `.env.example` + 部署脚本三重确认；退出码与失败聚合路径逐行核实。
- **AUD-008**：第一遍独立 PG 实测（P3018/42703）+ 本轮根因（运行时 DDL 未沉淀）与部署回退状态分析双重复核。

## 2. 最可能被高估问题

- **AUD-006**（P1→P2 建议）：影响是恢复被**误拒**（fail-safe），不产生数据损坏、不放宽校验；属灾备流程可靠性问题。
- **AUD-007**（P1→P2 建议）：同秒启动为 RARE_PRECONDITION，后果为单次备份产物损坏（可重跑、原数据无损），且有 L1/verify 双重暴露机制。

## 3. Severity 有争议的问题

- AUD-006 / AUD-007：P1 vs P2（如上）。
- AUD-044：P1 vs P2（DEPLOYMENT_DEPENDENT 高危尾部风险 vs 文档风险；修复成本为零）。
- AUD-008：影响包含"生产重部署阻断"的推断成分——生产 `_prisma_migrations` 实际状态需只读确认（本轮受限未执行），建议 Astra 授权一次只读检查后再定终稿。

## 4. 需要 Astra 最终仲裁的问题

1. AUD-006/007/044 的终级（见上）。
2. AUD-008 生产接入策略：生产库当前处于三种状态中的哪一种（需检查 `_prisma_migrations`）；若未 resolve，是否执行 `migrate resolve --applied baseline` + 补丁 migration 方案。
3. AUD-009 的架构取舍：P2022 防漂移自愈（刻意的可用性设计）vs `--accept-data-loss` 的静默数据丢失——是否引入"自愈仅检查+告警、变更走显式 migration"的折中，及其与 AUD-008 修复的先后绑定。
4. AUD-005 的修复范围：是否引入 per-school advisory lock 与恢复期写屏障（跨 Caddy/应用两层）。

## 5. 修复顺序可能存在的 dependency

1. **AUD-008 → AUD-009（硬依赖）**：先把结构演进收敛到 migration（008），才能把启动自愈降级为检查型（09）；顺序颠倒会使租户 P2022 漂移回归。
2. **AUD-004 + AUD-005（同批）**：同一恢复引擎重构（随机暂存名解决 004，advisory lock + 写屏障解决 005）；修 004 时若引入随机名，005 的"互删同名暂存"同步消失。
3. **AUD-006 + AUD-007（同批）**：备份产物一致性重构（共享快照计数 + 唯一文件名/原子发布/范围锁）。
4. AUD-039、AUD-044 相互独立，可随时并行（044 近零成本，建议立即做）。
5. AUD-008 的 deploy.sh 修复（去 `2>/dev/null` + failed 记录处理）应与其 migration 补丁同批，避免中间态。

---

## NEW_FINDINGS_CANDIDATES（不并入正式清单）

| 候选 | 描述 | 证据 | 级别 |
|---|---|---|---|
| NF-B-01 | **重新启用停用学校后立即 P2022**：启动自愈/db:sync 只同步 `status:'active'` 学校（`tenantSync.js:174-179`），而"重新启用学校"（PATCH status→active）不触发 provision/db push；长期停用学校在模型演进期间 schema 停留旧版，重新启用后即刻全线 500，须等下一次重启自愈才对齐 | `tenantSync.js:174-179` + `schoolRoutes.js:404-422`（status patch 无 provision 调用） | 中 |
| NF-B-02 | 恢复流程把解密后的明文 SQL 写入 `/tmp/restore_*.sql`（mode 0600，finally unlink）：服务器 /tmp 短暂存在全量业务数据明文；异常进程崩溃时残留 | `restoreService.js:127-133` | 低 |
| NF-B-03 | deploy.sh 将 `migrate deploy` 的 stderr 重定向丢弃（`2>/dev/null`），部署日志无法呈现 migration 失败根因（已并入 AUD-008 修复建议，单列供追踪） | `deploy/deploy.sh:512` | 低（已在 008 内） |

## 附录：本轮产物

- `phase2/probes-batch-b.mjs`（11 项断言/复现，全部通过）
- `phase2/probe-results-batch-b.json`（结构化结果）
- 重跑：`node docs/reviews/global-audit-20260924/phase2/probes-batch-b.mjs`

未执行：连接任何真实数据库（含生产）、破坏性恢复/migration、Cypress、部署。应用代码与 git 状态零改动。
