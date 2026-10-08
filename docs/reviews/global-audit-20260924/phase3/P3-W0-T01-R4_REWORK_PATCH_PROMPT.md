# P3-W0-T01-R4 — REWORK PATCH PROMPT

## TASK ID / TITLE / ROLE

**P3-W0-T01-R4：修正故障测试观测与独立基准，仅补齐 R3 证据。**

你是 CodeBuddy implementation engineer。总控已接受 R3 A/B 应用实现的静态结构；本轮修测试，不重新设计部署或认证。

## FIXED BASELINE / CURRENT HEAD

- audit baseline：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`。
- task HEAD：`7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，branch：`Product_tencent_CVM`。
- 沿用未提交 diff，不 reset/clean/stash。开始只读核对 `P3-W0-T01-R3_REVIEW_INPUT_MANIFEST.json`，不重跑会覆盖旧输出的校验器。

## OBJECTIVE / ARCHITECTURAL DECISION

证明原 R3 不变量：组装/发布前权限失败不得替换旧目标；真实 mv 失败不得继续；登记临时文件在退出后清理。修正操作后 hash 自身比较、未安装 spy 的零计数、缺失观测被视为成功等问题。不得用新增检查数量代替有效观测。

## IN SCOPE / OUT OF SCOPE

唯一允许修改的现有正式测试：`backend/tests/security/deploy-env-fault-injection.test.sh`。

新增证据仅写 `docs/reviews/global-audit-20260924/phase3/evidence/P3-W0-T01/rework4/`。无需改旧 RESULT 索引；新报告引用 R3 和本次裁决即可。不要改总控 state/review/packet/input manifest。

禁止修改应用、deploy.sh、共享库、其余正式测试、JWT 规则、schema、依赖、工作记忆文件；不启动 AUD-039；原 R3 与更早日志/JSON/HASHES 保持不变。

## REQUIRED PRE-READ

依次读取 phase3 下：ORCHESTRATOR_STATE.md → P3-W0-T01-R3_REVIEW.md → 本文件 → P3-W0-T01-R3_REVIEW_INPUT_MANIFEST.json。随后只读当前故障 harness、共享库有关函数、deploy.sh §5.2、rework3 的 TEST_RESULTS/R3_REPORT。无需重读全部审计材料或全仓扫描。

## IMPLEMENTATION REQUIREMENTS

1. **独立旧目标基准。** 每个涉及目标保持不变的 INJ/SEC 用例在创建旧目标后、调用任何被测操作前记录 before_sha256（在父控制流程或独立只读记录中保存）；操作及子进程退出后重新算 after_sha256。两者必须非空、有效并相等。真正使用 INJ-4 的操作前基准；SEC-1/2 同样处理。不要把操作后的 hash 标为 before。
2. **完整调用观测。** 所有需要 mv=0/1 的路径都安装统一计数包装：先登记调用，正常时转交真实 mv，只有 mv_fail 注入分支返回模拟失败。真实只读目录用例必须调用真实 mv 并记录其实际 rc，断言 publish=6，避免把更早失败混为 mv 失败。权限前拒绝要求 mv=0。计数文件不存在/不可解析是测试错误，不默认零。
3. **退出后清理与停止。** INJ-1…7 每例均在子进程退出后核对已登记 staging/fragment 的非空路径和本例目录归属，然后检查不存在；INJ-8 核对实际登记 fragment。不得让空路径通过。失败路径有后续步骤 sentinel，要求未执行；适用时观测 publish 未进入。SEC-1/2 要保存子进程真实退出码、fail 调用、未到片段尾部、旧目标不变和登记路径清理。沿用真实 §5.2 原文，不改成复制实现，不运行部署主体。
4. **真实 staging 部分写入。** INJ-3 在真实共享 assemble 返回 24 后、清理前记录 JWT_EXPIRE/CORS_ORIGIN 存在且 BACKUP_DIR 缺失的布尔值。删除或降级现有另写 printf 块为背景说明，不把它算作生产路径证据。
5. **成功观测与替身。** SEC-3 比较独立合成预期/旧 hash，证明目标确实由新 staging 替换且片段执行到末尾；仅“包含 JWT_SECRET”不够。保留 chown 替身边界，不新建服务用户。chmod 包装未命中注入时使用 `command chmod` 或保存的真实路径；chmod 不是 Bash builtin。setup/观测失败必须令 harness 非零，不能被汇总掩盖。
6. **验证观测器可失败。** 在独立合成文件/子进程中最小验证：保存 before 后故意改写目标，完整性检查必须拒绝；提供空/缺失登记路径，清理检查必须拒绝；主动通过统一 mv 包装调用一次，计数必须为 1。它们是 harness 自测，不作为应用故障证据。父测试只有在观察到预期拒绝/计数时才通过。不修改生产函数来做 mutation。

## BACKWARD COMPATIBILITY / SAFETY CONSTRAINTS

应用/数据/token/API 兼容行为不变，N/A 新迁移。只用任务临时目录和合成值，不读真实 .env，不连接 DB，不执行真实 deploy/systemd，不启动服务。临时资源按本任务登记范围清理。新日志不输出合成或真实 secret，使用 ASCII case ID 和结构化数值/布尔/hash；不把整个环境打印出来。

## TEST PLAN / ACCEPTANCE CRITERIA

- 只重跑修订后的故障 harness、`bash -n` 该文件及 `git diff --check`。无需重跑 D1、lifecycle 成功套件、deploy-flow、round-trip、unit/startup/Jest/PG。
- INJ-1/2/3 分别 assemble=22/23/24、publish 未进入、mv=0；INJ-4/5 assemble=0、真实/模拟 mv 调用一次且失败、publish=6；INJ-6/7 publish=7/8 且 mv=0；INJ-8 prepare=6。适用的旧目标 before/after、停止和清理必须有有效观测。
- SEC-1/2 真实片段失败并停止；SEC-3 成功且目标内容符合独立预期。三个观测器自测必须检测到故意错误。
- 各 case 记录实际观察，不用手填 PASS 替代运行输出。测试缺数据/异常/setup 失败一律非零，不能 skip。NO NEW REGRESSIONS；历史基线和已有接受结果保留，未重跑不称本轮通过。

## REQUIRED EVIDENCE

在 rework4 新建 REPORT.md、COMMANDS.md、TEST_RESULTS.json、logs/ 和最终 HASHES_FINAL.json。JSON 从运行观测生成，至少逐例含 case_id、before/after_sha256、assemble/publish/prepare rc（不适用明确 null）、mv 计数/实际命令 rc、子进程 rc、后续 sentinel、登记路径/退出后存在性、断言结果；INJ-3 附 staging 字段布尔。区分应用路径与 harness 自测。

报告说明修正了哪些原 R3 证明力不足的断言，不覆盖历史。返回 git status/diff stat/HEAD/branch、实际变更清单、命令与退出码、失败与未执行项、是否 schema/API 变化、资源清理及 blocker。

先完成报告，再生成本轮最终 hash；排除清单自身与仍在写入的生成日志，然后只读复验。只读对照 R3 输入清单：只有授权故障 harness 可变化，其余已列文件保持一致；冻结 29 文件只读核验；绝不执行旧 PF manifest-verify.mjs 或覆盖固定输出。

## COMMIT POLICY / STOP CONDITIONS

不 stage/commit/push/merge/deploy。若需修改生产代码、输入出现未知变化、只能用生产数据验证、需要扩大架构或真实系统权限，停止并报告事实；不要自行绕过。正常完成后停止，AUD-044 由 GPT 裁决关闭与否，不启动下一包。

## FINAL RESPONSE FORMAT / MODEL HANDOFF

STATUS（PASS/PARTIAL/BLOCKED，仅本轮）/ CHANGED FILES / IMPLEMENTED / TEST RESULTS / REGRESSION TESTS ADDED / BASELINE FAILURES / NEW FAILURES / UNRESOLVED / DESIGN BLOCKERS / GIT STATUS / NEXT RECOMMENDED ACTION / ASTRA REVIEW HANDOFF。

沿用既有交接约定：CodeBuddy 使用当前执行模型；下一轮 GPT 复审 Astra / Extra High（极高），携带最新 state、本包和完整结果。总控只检查这些剩余验收项，不重开已接受设计。
