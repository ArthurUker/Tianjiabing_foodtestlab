# Phase 3 下一轮五窗口执行 prompt（R8 总控发放）

这五段分别复制给五个 CodeBuddy 对话窗口。先读 `docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md`、本轮 `docs/AI_review/Codex-GPT6/P3-PARALLEL-R8_REVIEW.md`、`REVIEW_LOG_MASTER.md` §0/§4 和自身证据包。HEAD 不变、工作树故意未提交；不得 reset/clean/stash/checkout，默认不 stage/commit/push。每窗独立输入快照、只读冻结 29、编辑面漂移归因、原始日志/rc、`RESULT/COMMANDS/TEST_RESULTS/HASHES_FINAL` 和两次独立只读复验。不得读取真实 `.env`、连接业务库或留下凭据。隔离 PG 窗口各用自有实例、不同端口/台账目录，收尾 down 并核对进程与端口。任何全量回归、真实部署、正式 schema/client/migration、W3 真实恢复联测仍未授权。

## 窗口 1：P3-W2-T02-R6（迁移执行者边界返工）

> 你负责 P3-W2-T02-R6。先读 `phase3/evidence/P3-W2-T02-R5/RESULT.md`、`TEST_RESULTS.json`、`MIGRATION_CLASSIFICATION_PROTOCOL_R5_DELTA.md` 与 R8 总控复审。独占编辑 `backend/lib/tenantProvisioner.js`、`backend/sync-tenant-schemas.mjs`、`backend/tests/tenant-sync/w2t02r{4,5,6}*`（R4/R5 既有测试只允许场景保留的必要更新）；新增本包证据。不得改 server/auth/restore/deploy/fixture/schema/migrations，也不得运行全套件。
>
> 四项必须以真实隔离 PG 反例闭合：①空租户 `ensureTenantLedger` DDL 必须经过与迁移执行批相同的 advisory+owner/fencing guard；造父进程死亡但子 psql/PG 仍执行台账初始化的反例，第二执行者不得并发写。②通用 catch 的 `failed` 台账 upsert 必须 guard，旧执行者失权不得覆盖新执行者；写失败时不得声称“已记入 failed”，且实际终态 fail-closed。③ `--force-unlock` 的 owner/fencing CAS 必须与执行批的 advisory 互斥构成**原子临界区**；在“查询执行中 SQL 与 DELETE 之间”注入新执行批，证明不删在飞持有者；更新 CLI 帮助与返回值。④ baseline 已提交、事后证明失败、再注入 failed 标记 UPDATE 失败：不得出现可通过 `--check`/readyz 的 baselined 假健康；持久阻断或明确不可用的基础设施状态必须可独立复核。保留提交前全回滚与提交后 `committed=true/rolledBack=false` 区分。
>
> 先红后绿、逐案落原始 SQL/进程/rc 证据，复跑 R5 的 6+7+44+9 定点及相邻安全定点；若计数变化逐项归因。锁表正式 migration 本包仍禁止新建；将“入链同时撤出运行时 CREATE/ALTER，以只读形状检查替代”的接口/排序方案写到**本包新证据**，不得把运行时 DDL 的过渡期称为 RC-04 已验收。自有实例 down，交付时明确停止编辑和测试，供其它窗口后续动态复核。

## 窗口 2：P3-DB-FIXTURE-R2（迁址后的租户业务表隔离正例）

> 你负责 P3-DB-FIXTURE-R2。先读 `phase3/evidence/P3-DB-FIXTURE-R1/RESULT.md`、`tests/integration/concurrency.test.js` 与 R8 复审。独占编辑**仅** `tests/integration/concurrency.test.js` 及新增本包测试/证据；如必须碰 `tests/helpers/db-isolation.cjs` 或 `tests/isolation/provision.cjs`，先在结果中报设计阻塞，不自行改。不得改产品引擎/白名单、其它 fixture、schema/migration。
>
> 保留原 22 个集成场景，新增在**真实已迁移** A/B 学校 schema 的业务合同表（优先 `User` 或既有 record 表）上读写的正向矩阵：每校独有行、tenant transaction 内的 unqualified 业务查询确实命中当前校、跨校同键不串行、无 public 回退；同时保留 fixture `messages_a/b` 物理分离与 marker/哨兵负例。不要用 schema-qualified fixture 表冒充业务 `search_path` 正例，也不要给产品检查加测试白名单。记录迁移前置 `public migrate deploy → tenant db:sync → --check`、真实查询与隔离结果。用**自有实例和独立端口**；若 W2-R6 正在编辑引擎，可先写测试，待其明文停止后再跑动态链，测试前后记录引擎 hash。只跑本包定点及相关隔离套件，不跑全套件。收尾 down、hash/输入归因，并说明 CLOSE-B B1 的测试面闭合程度。

## 窗口 3：P3-W2-LIFECYCLE-DESIGN-R5（只读设计修订）

> 你负责 P3-W2-LIFECYCLE-DESIGN-R5。先读 `phase3/evidence/P3-W2-LIFECYCLE-DESIGN-R4/DESIGN_R4.md`、`PHASE_CONTRACT_MATRIX.md`、R8 复审、Phase 2 RC-04/RC-08，并只读核对当前 `deploy/deploy.sh`、审计写路径。**只在新证据目录写设计**；不得改旧设计证据、源码、schema、migration、client 或测试，不建实例、不跑 PG/Jest。
>
> 修三处：①将 A 期 `G2A(created_at >= m1_at)` 降为观察指标或替换为真正可强制的“所有新写入有 principal”门禁，覆盖回填/导入的旧时间、应用可控 `created_at`、系统事件；用正反例证明不能漏。②明确 A/B schema+Prisma client 的构建、`prisma generate`、public/tenant M1/M2、004 回填、流量激活与回退顺序；现行 deploy 在迁移前 generate，不能写一个未接线的“全租户到 B 后才生成 B client”门禁。标明需要哪一个部署面接口，未实现时维持 HOLD。③M2 对 `user_id=NULL` 且可能有 actor 快照的历史人类行给可证明映射/歧义拒绝规则，不得直接归系统主体；列出真实数据分类和失败判据。保留单次 align、自足 M2、无台账默认拒绝与可复用源方案。交付独立 `DESIGN_R5.md`、矩阵、与 R4 逐项差异及未授权实施清单；旧 R4 hash 只读复核，冻结 29/新证据双复验。

## 窗口 4：P3-W3-R2-CROSS-PLAN-R4（可复用源与目标隔离）

> 你负责 P3-W3-R2-CROSS-PLAN-R4。先读 `phase3/evidence/P3-W3-R2-CROSS-PLAN-R3/TEST_PLAN_R3.md`、`INTERFACE_BLOCKER.md`、R8 复审和当前 backup/restore CLI 路由。**只在新证据目录写计划**；不得改旧计划、产品/测试/fixture，不建实例、不跑 PG/Jest。
>
> 把 C2b/C3b 的“修复源→新备份→恢复”落成可执行的**源库/目标库物理隔离**计划：两个自有隔离实例或两个独立数据库，源端可用 `--baseline-* <code>` 指向正式 `school_<code>`，目标端已有独立旧 schema/旧数据。明确备份产物从源到目标的注册/文件路径/校验和/授权与凭据边界；目标先以旧备份验证默认 `UNPROVABLE` 且原 schema/data 不变，再从源修复并生成新备份，目标用新备份成功，重复恢复仍成功；任何源端修复不能被算作目标端的“保旧”。保留 C1/C4/C5/C6 与 ACL grant option、受限角色访问、null Prisma 首轮分析；更新 W2-R5 postcheck 为“已提交、阻断/待 R6 复审”而非假定回滚。逐步标注若现有备份 CLI 不支持跨实例产物注册，则停在接口 blocker，不能假造已可执行。旧 R3 hash 只读复核、冻结 29、新证据双复验。真实联测仍 HOLD。

## 窗口 5：P3-HARNESS-CHECK-R1（真实 server 测试前置适配）

> 你负责 P3-HARNESS-CHECK-R1。先读 R8 复审、`phase3/evidence/P3-CLOSE-T01-B-PLAN-R2/HARNESS_ADAPTATION.md`、DB-FIXTURE-R1 结果与 W2-R5 的 `false → NOT_VERIFIED` 合同。独占编辑仅 `backend/tests/t02c-live-api-harness.mjs`、`backend/tests/report-auth/_report-auth-harness.mjs`、`backend/tests/session/w1-invalidation-matrix.integration.test.mjs`，及新增本包测试/证据；其它 fixture 文件、W2 产品代码、Jest/package 配置均禁改。
>
> 三入口改为**已迁移实例 + 默认 check**：public `migrate deploy`、逐租户链回放、`db:sync --check` 通过后再启动 server；明确断言 readyz=200、目标租户真实业务 API 可用，同时保留原 49/49、20/20、12/12 的身份/吊销/授权场景和 0 skip。不得用 `AUTO_SYNC_TENANTS=false`、attestation、db push、accept-data-loss 绕过；若某套件专门测试 false 负例，应保留并新增 readyz/API 503 断言。若前置需修改本窗以外的 fixture，登记具体接口 blocker，不越界编辑或临时放宽产品。可先做代码与静态检查；**动态定点要等 W2-R6 明文停止编辑和测试**，并与窗口 2 使用不同自有实例/端口/台账。只跑三组定点，禁全量回归。结束核验实例 down、输入归因、冻结 29、证据双复验。

## 五窗交付后的总控顺序

先独立复审 W2-R6，再核对窗口 2/5 的运行时引擎 hash 与 W2 最终 hash；窗口 3/4 只读设计可并行复审。只有这些门禁闭合，才重新裁决 W1 public-only 与锁表链尾顺序、LIFECYCLE M1/M2、W3 真实恢复联测、CLOSE-B 全量回归。执行者的“已停止编辑测试”仅是释放文件/实例资源的事实，不自动解除总控实施门禁。
