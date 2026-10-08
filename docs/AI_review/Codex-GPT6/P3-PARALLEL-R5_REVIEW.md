# Phase 3 并行轮次 R5 总控复审

日期：2026-09-26。输入：用户附件中的 P3-W2-T02-R2 回执，以及 P3-W2-T01-R2、P3-W3-R2、P3-W1-R1 Phase A、P3-W2-LIFECYCLE-T01-R2 只读准备，共五包。上位约束仍为 `phase3/REVIEW_LOG_MASTER.md` §0/§4 与 Phase 2 `FINAL_ARCHITECTURE_DECISIONS.md` RC-04/RC-08；本记录不改冻结裁决。所有 PASS 都是所列本地范围，非生产部署/全量回归。

## 独立核验

- 逐包读 RESULT/TEST_RESULTS/COMMANDS、关键原始日志及现存源码；独立重算当前文件对输出清单：W2-T02-R2 **77/77**、W2-T01-R2 **61/61**、W3-R2 **38/38**、W1-R1 准备 **10/10**、LIFECYCLE-R2 准备 **21/21**。冻结 29 **29/29 ALL_MATCH**；HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、index 空、`git diff --check` clean。以上是当时文件一致性，不把执行者自报等同架构裁决。
- W2 原始日志可核 9/9 unit、22/22 真实实例矩阵；W2-T01 沙盒 7/7、六组定点 rc=0；W3 grant option 修复前 2 pass/5 fail、修复后 7/7，既有 27/27 最终定点通过。W1/LIFECYCLE 均只读准备，未执行产品测试。
- 未连接生产库、未代跑 PG/全套件、未读真实 .env、未提交或部署。下列未覆盖反例依据源码判据提出，须由返工包用隔离实例证实/修复，不能说已经实测失败。

## 逐包裁决

| 包 | 总控裁决 | 具体范围 |
|---|---|---|
| P3-W2-T02-R2 | **REWORK；不解除 W1/LIFECYCLE 实施门禁** | 真正建立了租户台账/按链回放，22/22 证明常规路径、全局 pending/failed/timeout 阻断及凭据基本卫生；但旧库 baseline、off 放行、检查错误、并发与破坏性重建仍有 RC-04 缺口。 |
| P3-W2-T01-R2 | **PASS_LOCAL（deploy 失败分支）** | 自动 resolve/db push 已删除；失败只读诊断后非零停止。旧 README 仍宣称自动回退，须单独更正。沙盒的“失败零副作用”只证明脚本在 migrate 失败后不追加写；不能证明迁移命令自身没有部分执行。 |
| P3-W3-R2 | **PASS_LOCAL（ACL grant option）** | 真实 PG 前后反例、schema/table/sequence、下界与双向一致区分及 34/34 定点支持此范围；与 W2 新 `alignTenantSchema` 的跨包恢复联测未跑，暂不关闭整条 restore 发布门槛。首轮 `SCHEMA_ALIGN` null client 失败已登记，不可因复跑绿而抹去。 |
| P3-W1-R1 Phase A | **PASS_READONLY；实施 HOLD，迁移方案需改** | 运行时 4 条 DDL/9 处触发、测试形状差异盘点有用。路线 A 的 public-only migration 与 W2 “不写 public.、所有迁移向 tenant 回放”协议冲突；若按现协议写无前缀 DDL，会在各 tenant 建 `revoked_tokens`，而它不在 schema.prisma 合同表内，触发 extra-object 阻断。 |
| P3-W2-LIFECYCLE-T01-R2 准备 | **PASS_READONLY；ENFORCEMENT_GATE 设计 REWORK，实施 HOLD** | A4/A5、受保护场景、交叉点已定位且无越权编辑；但其 E2 允许白名单 `principal_id=NULL` 同时要求整个列 `SET NOT NULL`，条件不可能同时成立。E1 的“租户 db push 兼容”和 E2 单独 DDL 脚本还须改为版本化链协议。 |

## W2-T02-R2 不可放行的具体反例

1. **off 仍放租户流量。** `backend/server.js:327-338` 在 `r.mode==='off'` 直接 `next()`，而 `:510-517` 将 `AUTO_SYNC_TENANTS=false` 设为 `NOT_VERIFIED` 且不检查。readyz=503 不能证明租户业务被挡住；RC-04 要求部署迁移成功后才开放受影响能力。测试 V6c 恰记录“租户入口不额外阻断”。测试 harness 使用 false 是 fixture 契约问题，不能成为产品放行例外。应让生产路径 fail-closed，并为受保护 harness 建明确的已验证证明或调整其 spawn 前提；无需请求用户重新授权这些必要测试适配，但须保留场景和溯源。
2. **“受控 baseline”默认由稀疏见证自动推断整条历史。** `tenantProvisioner.js:320-413` 的见证只涵盖部分里程碑；`:470-513` 在无台账时默认 `allowBaseline=true`，前缀/head 见证成立就写所有先前迁移 `baselined`。它没有核验每条迁移的列默认值、CHECK、函数/触发器及数据变换。`tenantSync.js:320-321` 自列这些为未覆盖，结构 parity 也只覆盖表、列类型/空值、主键/外键/唯一索引。构造“所有见证为真、某个合同列默认值错误”的旧库会获整链 baseline 并可能 ready=OK；这不是 RC-04 要求的可证明历史版本。无证据时要拒绝自动 baseline，改为离线受控证明/修复清单，并用反例测定。
3. **检查自身失败被当作可忽略。** `tenantSync.js:368-376` 中 `checkPublicExtraObjects` 抛错被转成 `blocking:false`；其后 `:470-477` 可在 public migration 和租户均正常时返回 OK。数据库目录不可读不是“无额外对象”，必须 CANNOT_CHECK/global blocker，readyz 与租户业务拒绝。
4. **并发升级缺唯一执行者。** `applyTenantMigrations` 在读台账/写 DDL/UPSERT 间无数据库锁；两个 `db:sync` 可同时发现同一迁移 pending 并执行。RC-04 明列“并发部署仅一个 migration 执行者”测试，R2 的 22 例没有此项。需真实双进程/双连接互斥与中断重试证明，不能只依靠 ON CONFLICT 处理最后一行。
5. **显式重建仍可能越过已核范围。** `tenantProvisioner.js:429-453` 只检查普通表行数和普通视图，就执行 `DROP SCHEMA ... CASCADE`，随后另一个事务回放。它未证明物化视图/序列/函数/类型/跨 schema 依赖、对象授权均可安全删除，也没有在回放失败时保留原 schema 的原子边界。此工具仅因显式调用不等于安全；须补全对象/依赖清单与可回滚切换，或先撤下自动重建入口只留人工 runbook。
6. **投影规则易吞未来迁移语句。** `tenantProvisioner.js:252-269` 凡 SQL 文本含 `pg_namespace` 或 `information_schema` 就整条剔除；例如新迁移含本 schema 的结构自证 DO 块也会被跳过。现有 11 文件/3 条扫全库通过，只证明固定链。新增链尾必须有显式、按迁移 checksum 固定的投影清单/标记与未识别扫全库 fail-closed，不能凭任意子串推断语义。

以上 1–3 为直接可触发错误放行的代码路径；4–6 是 RC-04 的执行/运维边界。R2 已修复的逐租户台账、常规回放、public checksum、凭据 argv 路径应保留，返工只针对这些缺口。

## W1 与 LIFECYCLE 实施前的共同设计裁决

- `revoked_tokens` 当前只属 public 认证事实源。W1 方案 A 若用 `public.`，违反 W2 链尾协议“不带 public 限定”；若去前缀，各租户会多一张非 datamodel 表。需要由 W2-R3 的迁移元数据明确分类 **public-only** 与 **per-tenant**，或用可证明的建模/投影策略；W1 不可自行破例。W1 的运行时 DDL 替换实施信号继续 HOLD。
- LIFECYCLE 的无主体审计必须选择可验证方案：为系统事件建立固定 `AuditPrincipal`（所有行获得 principal_id），或让 `principal_id` 继续 nullable 并以其他约束保证主体事件非空。不能允许 NULL 白名单同时对全列 SET NOT NULL。E2 结构变更须进入版本化 migration；单独脚本可做检查/回填，但不得成为绕开 public/tenant 版本台账的 schema 演进。旧 `db push` 文案作废。实施信号继续 HOLD。
- 两窗口可并行修**本包设计文档**，无 schema/client/PG/代码实施。W2-R3 完成并经总控复审后，再确定先 LIFECYCLE 还是 W1 的链尾顺序；两者不得同时争抢 schema/client。

## 调度

下一轮可立即给 W2-T02-R3（引擎返工）、W1 设计修订、LIFECYCLE 设计修订；deploy 文档窗口只改 `deploy/README.md` 与旧 readiness 报告的迁移文字，不碰 W2 引擎；W3 跨包恢复联测等 W2-R3 停止后独立运行。任务正文见 `phase3/P3-NEXT_WAVE_R5_PROMPTS.md`。CLOSE-B 仍未获实施或全量回归信号；其旧 `TENANT_DB_PUSH_ACCEPT_DATA_LOSS=true` 前提须在后续计划修订时移除。
