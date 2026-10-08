# TASK ID

P3-PF-T01

# TASK TITLE

补齐当前 HEAD 的隔离测试基线与餐具判定 delta 证据；仅验证，不修复应用。

# ROLE

你是 CodeBuddy，本任务的执行工程师。本次职责是环境隔离、测试执行和事实取证，不是应用实现或架构评审裁决。Astra 负责审阅你的证据并决定下一步。不要重新设计系统、关闭 finding，或自行宣布 Phase 3 READY。

# FIXED BASELINE / CURRENT HEAD

- 项目目录：`/Users/renkang/VS Code/Tianjiabing_foodtestlab`
- audit baseline：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`
- task start HEAD：`7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`
- branch：`Product_tencent_CVM`
- 预期 tracked working tree/index 干净；已有 untracked `docs/reviews/global-audit-20260924/` 必须保留。
- 原基线至 HEAD 的 8 个提交、15 个文件漂移已经由 Astra 限定评估，不要重新全仓审计或回退这些提交。

# OBJECTIVE

提供能够解除 Preflight B1/B2 的证据：

1. 在明确隔离环境建立该 HEAD 的 backend node:test、PG integration、root Jest 测试基线，准确记录失败和 skip。
2. 对指定餐具边界输入，执行真实 JS helper、真实 PostgreSQL 统计表达式/路由与写入归一化，比较结果。
3. 证明执行前后应用、既有测试与原审计证据没有改动。

本任务是 preflight evidence collection，**不是 remediation**。发现问题只报告，不修复；失败结果本身也是有效证据。

# IN SCOPE

- 阅读已有 phase3 preflight/test contract、必要的 Phase 2 条目与相关测试/配置。
- 只为本任务创建独立临时 PostgreSQL cluster 或独立临时容器、专用数据库及测试夹具；不得复用已有未知实例。
- 运行指定三套测试及新增统计测试，记录精确测试选择清单。
- 如需边界取证 harness，只能作为本任务 evidence probe 放入下述新目录或临时目录；不得修改正式测试来让它通过。probe 必须调用真实模块/SQL，不重写判定逻辑冒充验证。
- 新建本任务证据目录：`docs/reviews/global-audit-20260924/phase3/evidence/P3-PF-T01/`。
- 写入该目录的 `RESULT.md`、`COMMANDS.md`、`TEST_RESULTS.json`、`DELTA_CASES.json`、脱敏日志及必要 probe。记录 probe 运行方法。

# OUT OF SCOPE

- 修改任何应用代码、正式测试、package/lockfile、Prisma schema/migration、部署或 CI 配置。
- 修复 AUD-039/044 或餐具判定，修复历史 authSession 失败，添加正式回归测试。
- 重扫全部 findings、增加正式 issue/严重度、推翻冻结架构。
- 实施 W0 或后续 wave；自动开始第二个任务。
- 改写 Phase 1/2、phase3 原规划文档、manifest 或 ORCHESTRATOR_STATE；总控状态由 Astra 更新。

# ARCHITECTURAL DECISION

- 以 `FINAL_ARCHITECTURE_DECISIONS.md`、`FINAL_REMEDIATION_WAVES.md` 为已定目标。
- 此时只有 baseline evidence 尚未满足；不允许把当前代码有 bug 的实际输出自动提升为业务正确规则。
- 测试必须隔离，NO NEW REGRESSIONS；历史失败、当前 HEAD 新发现的既有失败、执行引起的变化必须分开。
- BUG EXISTS → PASS 的旧 probe 是原证据，保留不改；本任务不要求其修复后反转。本任务取证不是 issue CLOSED。

# REQUIRED PRE-READ

按顺序读取，禁止全仓扫描：

1. `phase3/ORCHESTRATOR_STATE.md`、`PREFLIGHT_REPORT.md`、`BASELINE_TEST_CONTRACT.md`、`AUDIT_EVIDENCE_MANIFEST.json`（均位于本审计目录）。
2. `../VERIFICATION.md`（相对于 phase3）、`../ISSUE_INVENTORY.md` 的 AUD-039 条目；`../phase2/FINAL_ARCHITECTURE_DECISIONS.md` 的 RC-09/RC-10 和 `FINAL_REMEDIATION_WAVES.md` 的测试 gate。
3. 根与 backend 的 package.json、实际使用的 Jest 配置、`backend/tests/_isolation.mjs`、`tests/integration/pg-bootstrap.js`、`tests/integration/roleAuditTrigger.test.js`、`tests/p0ProvNoAdminInSchool.test.js`。
4. `backend/tests/records/tableware-verdict.test.mjs`、`stats-verdict.integration.test.mjs`；`backend/lib/tablewareVerdict.js`、`recordNormalize.js`、`openApiScope.js`；`recordRoutes.js`、`openApiRoutes.js` 的对应统计分支；`frontend/js/modules/Dashboard.js` 对应判定函数。

可在上述测试目录内限定搜索数据库连接、环境加载、清理和夹具入口，确保即将运行的测试安全；不扩为全仓代码审计。不得读取或输出业务 .env 的秘密。

# IMPLEMENTATION REQUIREMENTS

本任务没有应用实现；执行要求如下：

1. 先记录 branch、HEAD、status、tracked/index diff，并核验 manifest 的 29 个文件 hash。任一基线或原证据不一致即停止，不重写 manifest。
2. 记录 Node/npm/PostgreSQL 实际版本、依赖安装状态、开始时间。需装依赖时仅按现有锁文件、禁 lifecycle scripts；不得升级包或改 lockfile。Prisma 生成仅允许 ignored 生成目录，记录动作。
3. **先证明隔离，再执行任何可能触库的测试/import。**使用本任务新建的本地 cluster/容器，独立数据目录、端口、角色和以 `_test` 结尾的任务数据库名；记录脱敏 host/port/database/user/current_database/current_schema、进程或容器归属。不用已有业务实例，不以库名含 test 作为充分证明。
4. 显式覆盖测试进程的 DATABASE_URL、REVIEW_TEST_DATABASE_URL 及夹具变量，隔离配置须在导入 Prisma/应用模块之前生效。必要的 TEST_SCHEMA/TEST_ROLE_USER 使用专用测试值。检查测试不会通过 dotenv override/hardcoded URL 回到业务连接；不能证明则停止，不先试跑。
5. AUD-039 旧套件可能跨 schema purge。必须将这些测试整体限制在**全库均为本任务所有**的独立实例内，并分 suite 使用干净夹具/独立测试数据库，避免相互污染。固定 schema 仅能在此一次性实例内部创建；不能在真实业务实例建立所谓测试 schema。
6. 允许依现有 schema 准备一次性测试库，包括隔离库中的 Prisma db push 和测试专用触发器，以复现历史测试夹具；明确这仅是 fixture provisioning，不是 migration 修复或可部署性证明。不得执行生产 migration、修复 migration 链或修改已提交 schema。工具环境无法安全准备则报告 BLOCKED。
7. 三套 suite 串行执行，保存完整命令、测试文件清单、退出码、pass/fail/skip。先检查 shell glob 实际选择，确保新增两个统计文件包含。不要将未配置 DB 导致的 skip 当成功。已有完整运行覆盖新文件时可引用其明细，不需机械重复运行。
8. 运行餐具边界矩阵，记录输入原文以及各出口 actual；若相关出口无法真实执行，单列 NOT_EXECUTED，不用手写复制逻辑代替。
9. 每个失败先区分断言、环境、夹具。可以在本任务独立实例中修正缺失夹具后重跑，并保留初次日志；不得改应用/测试断言、跳过用例或设置特殊认证阈值来抹平原基线失败。
10. 结束时核验 HEAD/branch、tracked/index diff、manifest 和应用文件状态；清理只限本任务新建资源，依据确切目录/进程/容器 ID，不广泛 kill/rm/drop。不改既有本地服务。保留脱敏证据。

# BACKWARD COMPATIBILITY

旧业务数据、token、API、localStorage、migration、client：全部保持不变，本任务不引入任何兼容性变化。测试库仅含合成夹具，不复制生产数据。

旧审计 probe 和报告不变；本任务边界 probe 是额外取证，不替代正式回归，不覆盖原文件。

# SAFETY CONSTRAINTS

禁止生产 DB/生产系统访问、真实 deploy、网络调用样例生产 API、source 业务 .env、commit/push/merge、git clean/reset/checkout 回滚用户内容。

禁止运行 `backend/scripts/check-tableware-consistency.mjs` 所示生产使用方式；本任务无需运行该全校巡检。

禁止为了测试成功削弱隔离门禁或绕过真实校验。仅一次性任务实例里的 fixture DDL/DML 被本 packet 允许；其它数据库变更一律禁止。

# TEST PLAN

## A. Targeted unit tests

执行现有 `backend/tests/records/tableware-verdict.test.mjs`；当前静态读取有 7 个顶层测试，以实际 runner 输出为准。

## B. Integration tests

执行已启用真实隔离 PG 的 `stats-verdict.integration.test.mjs`（静态 5 个集成测试）及原 PG integration suite；记录实际执行数，未配置环境的 skip 不等于 PASS。

## C. Delta correctness matrix

至少包含：

- 空顶层 result + 单个合格点位；
- 空顶层 result + 合格点位和空字符串点位；
- 空顶层 result + 合格点位和缺失 res 点位；
- 顶层 result 仅空格 + 全合格点位；
- 全空点位、无点位、非数组 atpPoints；
- 合格与不合格混合；合格与警戒混合；
- 显式非空顶层结果与点位冲突。

比较真实 `tablewareVerdict/isTablewarePass`、`deriveConclusion`、PG `TABLEWARE_PASS_SQL` 及对应统计路由；对混合空点位/空白顶层场景再经过真实 `buildRecordWriteData/normalizeWriteJson` 的对应写入调用，记录补写前后 payload/result。Dashboard 如没有现成可执行 harness，可限定静态核对并明确未运行；不能宣称真实浏览器已验证。

判定预期参考已提交的“顶层优先、为空回退、所有点位合格”契约；遇到空点位如何处理存在冲突时，输出各方实际与冲突，不自行选规则或改代码。不要只检查 SQL 字符串包含关键字。

## D. Existing reproducer inversion

本次没有修复，**N/A — 不反转/删除原 audit probe**。将 delta 的最小输入和结果保存为可复跑 evidence；未来修复任务再由 Astra 指定正式 regression 的正确断言。

## E. Baseline non-regression

- backend node:test：历史 178/178，当前新增测试后不得直接沿用总数。
- PG integration：历史 13/13。
- root Jest：历史 249/251；精确已知失败为 authSession 阈值与错误文案两项，见 BASELINE_TEST_CONTRACT。
- lint 历史噪声不是当前 gate，不进行 lint 清理。

本任务不改实现，因此当前 HEAD 发现的额外失败称 `CURRENT_HEAD_PREEXISTING_FAILURES`，不得谎称是 Phase 3 修复新引入，也不得自行接受为永久豁免。NO NEW REGRESSIONS 要求执行过程未改变应用行为或文件。

# ACCEPTANCE CRITERIA

1. branch/HEAD 匹配，原 manifest 全通过，执行后 tracked/index diff 仍为空。
2. 每个测试进程的 DB 指向本任务独立实例有可核查证据，无业务环境 fallback。
3. 三套 suite 和新增文件有真实执行日志及精确结果；失败、skip、未执行均清楚列出。
4. 指定 delta 核心边界有真实 JS 与 PG 结果和写入归一化前后证据；证实不一致也满足“取证完成”，但不得说业务正确。
5. 历史两项失败与其它失败逐项区分，无改断言、删 probe、关门禁或应用修复。
6. RESULT.md 明确哪些 B1/B2 事实已经补齐，哪些仍需 Astra 决策；不自行标 READY 或 issue CLOSED。

# REQUIRED EVIDENCE

在本任务目录保存并返回：

- 开始/结束 git status、git diff --stat、cached diff、branch、HEAD；新增 untracked 证据文件清单（普通 diff stat 不展示它们）。
- 原 manifest 核验结果、环境与隔离证明、精确执行命令、退出码、日志路径。
- 每个 suite 的 suite/test/pass/fail/skip；失败测试全名、期望/实际、分类。
- delta 每个输入与各出口输出、是否一致、执行覆盖/未覆盖限制；probe 文件与复跑方式。
- 是否修改 schema/API contract：项目均应为 NO；一次性测试库 fixture 另列，不混淆。
- 风险、未执行验证、blocker、清理的精确任务资源及残留。

所有日志脱敏，不输出密码、完整 secret 或业务连接串。

# COMMIT POLICY

不要 commit、stage、push、merge。所有新增产物仅留在本任务 evidence 目录；不得提交审计证据来替代缺失测试结果。

# STOP CONDITIONS

- HEAD/branch/应用状态/原证据与 packet 不一致。
- 无法证明完全隔离；需要生产数据或业务 .env 才能验证。
- 必须修改应用、正式测试、schema、migration、API 或已定安全语义才能继续。
- 需要 destructive 操作于任务实例之外、需要扩大到新 root cause。
- 架构/规则冲突需要裁决：报告 DESIGN BLOCKER，不选择新规则。但已经安全可独立完成的测试可以继续收集，不能借某个断言失败跳过所有其它证据。

完成或阻塞后停止，不自动开始修复，不生成后续任务。由用户把结果转交 Astra。

# FINAL RESPONSE FORMAT

STATUS: PASS / PARTIAL / BLOCKED
（此处 PASS 仅表示取证任务完成，可能包含明确复现的 bug/失败；不代表全部测试绿灯或 Phase 3 READY。）

CHANGED FILES:

IMPLEMENTED:
（应为“无应用实现，仅取证”。）

TEST RESULTS:

REGRESSION TESTS ADDED:
（本任务正式测试应为 NONE；另列临时 EVIDENCE PROBES。）

BASELINE FAILURES:

CURRENT_HEAD_PREEXISTING_FAILURES:

NEW FAILURES:
（若无代码改动，区分新发现与执行引起，不混为新增回归。）

UNRESOLVED:

DESIGN BLOCKERS:

GIT STATUS:

EVIDENCE FILES:

NEXT RECOMMENDED ACTION:
（提交 Astra 审阅并等待，不自行继续。）

ASTRA REVIEW HANDOFF:
TASK ID / packet path:
task-start HEAD / branch:
accepted prior decisions:
changed-file list / diff summary:
evidence and log paths:
known baseline failures / new failures / skips:
unresolved risks or decisions:
recommended Astra model + reasoning effort + why:
escalation trigger:

模型建议仅供用户选择。不得声称能切换用户会话模型。
