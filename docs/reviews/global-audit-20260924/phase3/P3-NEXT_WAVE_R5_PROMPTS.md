# Phase 3 下一轮五窗口 prompt（R5）

依据：[R5 总控裁决](../../../AI_review/Codex-GPT6/P3-PARALLEL-R5_REVIEW.md)。以下五段可各自复制到一个 CodeBuddy 对话。窗口 1/2/3/4 可立即开始各自独占面；窗口 5 **只读准备**，待窗口 1 停止并经总控复审后才能运行跨包 PG 测试。W1/LIFECYCLE **无产品实施信号**；CLOSE-B **无全量回归信号**。所有窗口先读 `REVIEW_LOG_MASTER.md` §0/§4 与 Phase 2 RC-04（窗口 3 另读 RC-08），先建输入快照，保留兄弟未提交改动；只用隔离实例，冻结 29 只读核验。交付 RESULT/COMMANDS/TEST_RESULTS、原始 logs/rc、输入归因、hash 双复验、实例 down；不读真实 .env、不连生产库、不 commit/stage/push/reset/clean/stash、不部署或跑全套件。

## 窗口 1：P3-W2-T02-R3（逐租户引擎返工）

> 你负责 `P3-W2-T02-R3`。先读 `docs/AI_review/Codex-GPT6/P3-PARALLEL-R5_REVIEW.md` W2 六项返工、`evidence/P3-W2-T02-R2/RESULT.md` 与 `CHAIN_TAIL_PROTOCOL.md`、RC-04。独占 `backend/lib/tenantProvisioner.js`、`backend/lib/tenantSync.js`、`backend/server.js` 的就绪闸门区、`backend/sync-tenant-schemas.mjs`、本包测试/fixture；不改 auth/restore/deploy.sh/README/lifecycle schema。保留 R2 的台账、按链回放、失败状态、常规阻断与凭据卫生。
>
 逐项完成六个反例：① `AUTO_SYNC_TENANTS=false` 下迁移未验证时真实租户 API 必须 503；既有受保护 harness 若以 false spawn，逐场景保留并改为显式验证后运行或使用可信的测试 attestation，不放宽产品闸门。② 无台账旧库不能凭八个见证自动把 11 条 migration 标为 `baselined`；用“见证都真但列默认值/非见证约束错误”的真实 PG 反例证明拒绝，设计离线人工 baseline/repair 的完整结构和数据语义证明。③ public 额外对象检查读失败须 CANNOT_CHECK/global blocker，readyz 与真实租户 API 都拒绝。④ 两个独立 `db:sync` 执行者同校竞争时仅一方实施迁移，另一方等待/拒绝并能安全重试；真实双进程测试，不以最终 UPSERT 成功当作互斥。⑤ `--rebuild-empty-schema` 的 `DROP SCHEMA CASCADE` 要么撤下并改人工 runbook，要么证明无未知对象、跨 schema 依赖、ACL 丢失且失败可回滚；“表零行”不充分。⑥ 投影不能以含 `information_schema`/`pg_namespace` 的任意 SQL 整句删除；改成明确分类且对未分类语句 fail-closed。加入新链尾结构自证 DO 块反例，证明不会被投影吞掉。
>
 同时公布可执行的迁移分类协议：public-only 的 `revoked_tokens` 与 per-tenant 的生命周期模型如何进入同一版本链、各自 ledger/checksum 如何记录；不得让 public-only 表落在租户形成 `TENANT_EXTRA_OBJECTS`，也不能用运行时 DDL 或 db push 兜底。协议先用最小模拟链尾 migration 在自有实例验证，**不创建正式 W1/LIFECYCLE migration，不修改兄弟代码**。重跑 R2 9/9、22/22 关键矩阵、W3 暂存对齐定点；逐项记录新增失败/skip。若某项无法安全实现，明确 BLOCKER、停在 fail-closed 状态，不自报 RC-04 关闭。结束发“停止编辑和测试”信号和新链尾协议，供总控裁决。

## 窗口 2：P3-W2-T01-R2-DOC（部署文档更正）

> 你负责 `P3-W2-T01-R2-DOC`。先读 R5 对 deploy 的限定 PASS、`evidence/P3-W2-T01-R2/RESULT.md`、`deploy/MIGRATION_FAILURE_RUNBOOK.md` 和现行 `deploy/deploy.sh` 迁移段。独占 `deploy/README.md` 的 migration/故障排查段以及 `deploy/DEPLOY_READINESS_REPORT.md` 中启动自愈的过时文字；不改 deploy.sh、W2 引擎、schema、测试或其它 README 段。窗口 1 不编辑这两个文档，可并行。
>
 删除 README 对“首部署失败自动 resolve + db push”和 P3009 “修因后直接 resolve”的旧表述；改为 migrate 失败非零停止、只读诊断 A/B/C/D、部分执行必须人工核实、runbook 链接。更新已废弃的租户 db push/accept-data-loss 描述为“逐租户版本化回放、未知状态 fail-closed”，但不要提前写成 W2-R3 已验收；将其标为当前实施状态/待 R3 裁决。更正 DEPLOY_READINESS_REPORT 的“启动后非阻塞自愈”句，保持历史报告原证据不伪造。用只读静态扫描确保部署文档与当前 deploy.sh 无矛盾；不跑部署/PG/全套件。交付逐句前后对照与文件 hash。

## 窗口 3：P3-W2-LIFECYCLE-T01-R2-DESIGN（enforcement 设计返工）

> 你负责 `P3-W2-LIFECYCLE-T01-R2-DESIGN`，**仅修改本包设计/矩阵/新证据文档**。先读 R5 生命周期裁决、`evidence/P3-W2-LIFECYCLE-T01-R2/ENFORCEMENT_GATE.md`、R1 `DESIGN.md`/`TEST_MATRIX.md`、RC-04/RC-08。不得改 schema/migration/产品源码/测试、生成 client 或跑 PG。与窗口 1 同时做设计，无文件竞争。
>
 修正 `principal_id` 的逻辑矛盾：若系统无主体事件可留 NULL，就不能全列 SET NOT NULL；请在“系统固定 AuditPrincipal，所有事件有 principal_id”与“保持 nullable、DB 约束只保证有人类主体的事件非空”中选一种并给出对存量行、未来写入、FK 与 G1–G7 的完整可执行判据。用两类真实数据构造计划测试：有人类主体历史行、无主体系统事件；未决定前不宣称 E2 可执行。把 E1 的“db push 兼容”、E2 的独立 SET NOT NULL 脚本改成版本化 public/tenant migration 顺序；回填/只读门槛可保留独立脚本，但 schema DDL 必须入链并在未完成时阻断。明确恢复旧备份、新校、disabled 校的 enforce/版本检查时点。保留 A4/A5 授权与受保护场景方案；不把设计修订写成产品实施。

## 窗口 4：P3-W1-R1-PLAN-R2（auth migration 公共范围协议）

> 你负责 `P3-W1-R1-PLAN-R2`，**只读源码，只改 P3-W1-R1 的设计/测试计划及新证据**。先读 R5 W1 裁决、`evidence/P3-W1-R1/{PREP_INVENTORY,MIGRATION_PLAN,TEST_PLAN}.md` 与 W2-R2 的 `CHAIN_TAIL_PROTOCOL.md`。不得改 authMiddleware、schema/migration、fixture、运行 PG/Jest 或生成 client。与窗口 1 的代码修改并行，但不要替其决定迁移分类实现。
>
 具体解决两难：public-only `revoked_tokens` migration 若写 `public.`，W2 旧协议不向 tenant 回放；若去掉限定，会在 tenant 建额外表而被 readiness 阻断。与窗口 1 新协议对齐，提出 public-only/tenant 迁移元数据或投影分类的准确 SQL、checksum/ledger 与运行顺序；列出 public 旧表正确/错误形状、tenant 不应出现该表、fixture 三方形状的验证矩阵。路线 A/B 的取舍须说明是否必须在 schema.prisma 建模，以及如何防止新索引仅在 public 存在而 tenant 版本校验误报。认证缺结构时维持 fail-closed；W1 `idt`/`user_all` 和 18/18 受保护场景保持。交付修订计划供总控裁决，**不得把窗口 1 的停止信号自行当实施信号**。

## 窗口 5：P3-W3-R2-CROSS（恢复 × 新租户迁移引擎联测）

> 你负责 `P3-W3-R2-CROSS`。先读 R5 对 W3 ACL 限定 PASS、`evidence/P3-W3-R2/RESULT.md` 首轮 `SCHEMA_ALIGN` 失败记录与 W2-R2 的链尾协议。**现在只做只读测试计划与输入快照**；窗口 1 的 W2-T02-R3 停止且经总控复审前，不运行 PG/测试，不编辑产品文件。总控发出联测信号后，仅可新增本包独立集成测试/证据，不修改 `tenantProvisioner.js`、`restoreService.js`、schema 或 W3 既有测试。
>
 在全新隔离实例和独立台账目录做真实恢复联测：当前版本备份、旧版本前缀备份、无台账但可证明备份、不可证明备份；检查 staging 迁移证明、ACL 基线下界含 grant option、旧 schema 保留/回滚、切换后受限角色 SELECT/UPDATE/DELETE、失败时不 drop-old。专门复现或排除首轮 `SCHEMA_ALIGN: Cannot read properties of null (reading '$queryRawUnsafe')`；记录源码 hash 和入口顺序，不能仅用“复跑绿”归类环境噪音。若发现产品缺陷，只登记给 W2 或 W3 所属窗口，不跨界修。交付原始 rc/log、逐案前后结构/授权证据、实例 down。

## 总控保留门禁

W2-T02-R3 须先复审；其后才决定 W1 与 LIFECYCLE 的正式链尾顺序和实施信号。两个实施窗口不能同时改 schema/client 或共用 PG 实例。W3 跨包联测与 CLOSE-B 全量回归排其后。CLOSE-B 计划里的 `TENANT_DB_PUSH_ACCEPT_DATA_LOSS=true` 必须另行更新；当前五窗不启动 AUD-040 或全套件。
