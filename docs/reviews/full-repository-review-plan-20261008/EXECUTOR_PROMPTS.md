# 可复制执行提示词

这些提示词用于后续获得执行指令后的审查。当前包只交付计划，不运行其中的测试、数据库、构建、生产动作。所有提示词均继承本包的基线、边界与验收要求。

## 1. 启动与基线总控

```text
任务：执行 Tianjiabing_foodtestlab 全仓代码审查的 P0 基线阶段。

先读：
1. docs/reviews/full-repository-review-plan-20261008/README.md
2. REVIEW_PLAN.md
3. WORK_PACKAGES.md 的 WP00/WP13
4. baseline-manifest.json、coverage-plan.tsv
5. docs/PROJECT_CONVENTIONS.md
6. docs/reviews/global-audit-20260924/phase3/REVIEW_LOG_MASTER.md
7. ORCHESTRATOR_STATE.md 顶部最新裁决，再进入相关任务包和原始证据
8. docs/AI_review/SERVER_CODEBUDDY_20260928/README.md、FINDINGS.md、R8 文件清单与报告

目标：冻结当前真实 HEAD/branch/dirty/realpath；复算文件/hash/分类分母，
登记本计划基线之后所有增量，生成端点/模型/脚本/后台任务初表，
将全部文件分配唯一主工作包，将 C01-C12 分配协同责任；建 AUD/SRV 历史映射。
动态验证只交 G0 方案，不启动服务或创建数据库。

只做读代码、元数据核对、生成新的审查资料。
禁止修改产品源码/既有迁移/既有报告，禁止安装/构建/测试/数据库连接/部署/重启，
禁止读取真实 .env/凭据/备份/上传，禁止 git reset/clean/stash/stage/commit/push。
本地不存在的 ignored 历史证据登记 MISSING_REFERENCE，不自行从生产拉取。

输出到新的结果目录，例如 docs/reviews/full-repository-review-20261008-run01/：
BASELINE.json、REPOSITORY_MAP、ENDPOINT_MATRIX、MODEL_MIGRATION_MATRIX、
SCRIPT_ENTRY_MATRIX、COVERAGE.tsv、HISTORY_RECONCILIATION.tsv、G0_PLAN.md、HANDOFF.md、STATE.json。
基线发生漂移时先登记并重新冻结，不把不同 SHA 的资料合并成一次证据。
元数据扫描与局部入口阅读不写成已完成全仓深审。
报告 G1 是否成立，以及下一个精确动作。
```

## 2. 单工作包审查

```text
任务：执行工作包 <WPxx>，仅进行当前授权范围内的代码审查。
本包证据目录：<RESULT_DIR>/packages/<WPxx>/。
基线 SHA：<BASELINE_SHA>。当前 runId：<RUN_ID>。

读序：最新 HANDOFF/STATE → BASELINE/覆盖增量 → 主计划 → WORK_PACKAGES 中本包 →
coverage 中 primary_package=<WPxx> 的完整文件清单 → 对应历史 issue/独立裁决/证据 → 真实调用方与消费者。

按 coverage 的 planned_depth 完成全部主归属文件：自研源码/测试/配置全文审读，
第三方/生成物/包锁按专项方法检查，文档核对契约/历史/操作安全。
先建立职责/输入/输出/状态/副作用/错误分支，
再追业务入口到授权/租户/事务/持久化/响应/前端或导出/审计与清理。
shared 文件只补充交叉证据，不与主审重复生成另一个根因 issue。
从 SCANNED、READ_PARTIAL、READ_COMPLETE、CROSSCHECKED、SPECIALIZED_REVIEW_COMPLETE
等状态中如实登记深度和区段；专项完成只计入本类分母。

每个发现写 baseline/path:line/入口/前置/触发/当前行为/期望/影响范围/
证据等级/未知项/历史ID关系/建议/验收/兼容回退；候选不可自动写 confirmed。
无发现文件仍写职责、检查项与调用链证据，不能只填“无问题”。
历史 AUD/SRV ID 保留，新增证据写当前映射；历史 PASS 不作为当前动态 PASS。
业务政策有冲突登记 BUSINESS_DECISION_PENDING，不自行选择或修改业务规则。

默认不运行测试/构建/数据库/浏览器，不读取真实 .env，不改产品/迁移/旧证据，
不提交/推送/部署/重启/生产访问。动态项先给场景和 G0 前置，记 NOT_RUN。
如果另有明确的隔离动态执行授权，先验证当前 G0，再按批准场景运行；
输出命令、原始脱敏日志、rc、断言、响应/DB/文件/storage最终状态与cleanup收据。
发现基线/实例/目录/外联越界停止该动态项，继续独立静态工作。

必交：SCOPE.md、CALL_CHAINS.md、CHECKS.tsv、FINDINGS.json、VERIFICATION.md、
coverage-delta.tsv、HANDOFF.md。不要修改其他包目录或总控总账。
结尾写完成范围、未读区段、未执行/环境阻断、待业务裁决、下一精确动作。
```

## 3. 三流并行分配

| 角色 | 第一阶段 | 第二阶段 | 协同责任 |
|---|---|---|---|
| 审查者 A | WP01/02/03 | WP08/06 | 身份×租户×迁移×OpenAPI |
| 审查者 B | WP12/04/05 | WP09/11 与剩余前端 | 离线×业务×管理状态×输出 |
| 审查者 C | WP13/14/15 | WP07/10 | 测试可信度×运维×恢复×审计 |
| 总控/独立复核 | WP00、每日 P0/P1 复核、总账写入 | 跨链复核/动态调度/最终裁决 | 不把执行者自报作为验收 |

静态读取允许共享；各包输出目录独占。共享总账只有总控更新，合并增量前核对 SHA/hash。动态任务独占数据库/端口/profile/目录；同实例迁移、restore、DDL、故障注入、全量回归串行。总控应根据真实包容量调整排期，避免 C 流高副作用工作成为未经预检的尾项。

## 4. 独立复核

```text
任务：独立复核 <WORK_PACKAGE/CHAIN>；不执行修复。
先读 BASELINE、scope、coverage-delta 和 FINDINGS，再打开当前源码与原始证据，
不能只复述执行报告。独立复算文件/hash、issue数与严重度、实际测试清单/rc/
skip/todo、runId/实例连续性、before/after-check与清理归属。

复核全部 P0/P1、跨租户/认证/删除/迁移问题和所有争议；
每包至少复核一条正向和一条负向/故障场景；
P2/P3按根因族与包分层抽查至少20%，发现不一致扩大到该包同类全部。
检查行号、真实可达性、mock边界、字段断言是否必执行、历史ID去重、
严重度前提与动态未跑的区别。源码有缺陷本体与运行爆炸半径分别评判。

未获得动态授权或 G0 不成立时，只回读已有证据并登记缺口，不补跑生产动作。
给 PASS/REWORK/ENV_BLOCKED 及逐条理由，保持静态/动态/业务/修复/CI/部署/发布各自状态。
输出 INDEPENDENT_REVIEW.md、逐项裁决、必要coverage修正建议和下一精确动作。
```

## 5. 中断后的续审

```text
继续当前全仓审查，先不要从聊天记忆推断完成状态。
读 README → 最新 HANDOFF.md/STATE.json → BASELINE及覆盖增量 → 当前工作包 →
最新独立裁决 → 所引用原始证据。重新核对 HEAD/branch/dirty/realpath，
任何动态动作前核对 runId/实例/目录所有权和当前 G0。
列出已完成、在做、未运行、环境阻断、业务待决；只继续下一未完成步骤。
不覆盖历史报告，不重复创建或清理归属未知实例，不沿用旧生产授权/PID/200结果。
恢复后先给简短状态更新，随后继续独立工作。
```
