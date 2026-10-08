# P3-PF-T01-R2 — Remaining evidence patch

你是 CodeBuddy。只完成首次 rework 遗留的连接校验/失败清理和报告边界。不是新审计，也不是 W0。任务后缀 R2 表示第二次 rework。

## REQUIRED PRE-READ

按顺序读取以下文件（相对仓库根）：

1. `docs/reviews/global-audit-20260924/phase3/ORCHESTRATOR_STATE.md`
2. `docs/reviews/global-audit-20260924/phase3/P3-PF-T01-R1_REVIEW.md`
3. 本文件及 `P3-PF-T01_REWORK_PATCH_PROMPT.md` 的既定验收边界。
4. `phase3/evidence/P3-PF-T01/rework/delta-matrix-v2.mjs`、5 份 v2 JSON、`backend/tests/_isolation.mjs`（只读）。

上述 phase3 简写均位于 `docs/reviews/global-audit-20260924/` 下。

## FIXED BASELINE / SCOPE

audit baseline=`f08e72e3e74d188b4555e0bee16280b3dd0d622b`；branch=`Product_tencent_CVM`；HEAD=`7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`。

只允许在 `phase3/evidence/P3-PF-T01/` 新增 `rework2/` 证据/probe/自测及修订 RESULT.md、TEST_RESULTS.json、COMMANDS.md。原 v1/v2 probe、JSON、日志、REWORK_RESULT 均原样保留；先记录 hash，结束复验。既有 rework 报告里的计数误差在新报告更正，不倒改旧报告。

不改应用、共享 `_isolation.mjs`、正式测试、schema/migrations、依赖/lockfile、CI、总控 state/review/packet 或 Phase 1/2 证据；不 commit/stage/push，不访问生产。开始/结束核验 Git 与 29 文件 manifest；如出现未归属变化，停止并报告。

## ACCEPTED EVIDENCE

三套 suite 190/190、13/13、249/251（两项历史失败），原始 hash，以及 v2 的 13-case 正常/恢复、缺夹具、handler 负例、sentinel 和独立实例清理证据已接受。**不重跑三套 suite**。三个 delta mismatch 不是本任务要修复的问题。

## PATCH A — 校验通过后才允许写入与清理

- 新版 probe 放 `rework2/`，使用新的输出文件；正确计算仓库根，避免覆盖 v1/v2。
- 用 URL API 明确设置 public 客户端 schema=public、tenant 客户端 schema=school_reviewtest，替换既有 schema 参数，不拼接重复参数。保留既有专用 URL、期望库/端口检查和独立任务实例约束。
- 不依赖 helper 注释：显式比较运行时返回的 db/schema 与各自预期；任一不符即拒绝，记录 expected/actual（不泄漏凭据），非零退出。
- 所有连接验证全部成功后，才将写入许可置为 true。所有 DML，包括每例 reset、create、最终 cleanup，都必须在该许可后；验证失败或验证抛错时不得 DELETE，即使客户端已构造，也只做 disconnect，并记录 cleanup skipped 的原因。
- 成功后清理继续只按本 run 前缀；不放宽 sentinel 或统计过滤范围。

## PATCH B — 最终失败不能被 exit 0 隐藏

- cleanup/disconnect 错误记录到最终 execution errors；保持最初错误，不让 teardown 覆盖它。
- 在 finally 完成后再汇总最终 error count/exit code。任何执行或 teardown 错误都非零；只存在业务 mismatches 可以 exit 0。已有拒绝码可保留，正常结束后才出现 teardown 错误用非零执行错误码。
- 即使 teardown 失败也尝试其它必要 disconnect 并保存完整 JSON；不要把 disconnect catch 变成空处理。

## PATCH C — 统一准确报告

- 修订 review 点名的 TEST_RESULTS `delta_matrix.key_findings`、RESULT §4/§5 残留句子，检查这三个可改文档的同义表述。
- 只声明被测三个 create-mode 输入的后续 PG 与 JS 对齐；只声明内部 stats 与 PG 布尔结果 13/13 一致。没有执行的外部 stats/PUT/sync/导入/浏览器仍明确未执行。
- v1 backfilled=false 仅作为已更正的历史局限，当前字段链接 v2/v3 实际 JSON。suite 额外失败=0 和 delta mismatches=3 继续分开。
- COMMANDS 新增清楚的 v3 配方，保留历史节。任何实际复跑输出使用新目录/名称；不要覆盖旧证据。清理命令必须以归属核验通过为前提，不能只打印归属信息后无条件删除。

## MINIMAL VALIDATION

首先做不连接真实数据库的受控客户端自测。可在本任务证据目录抽取共享控制流供生产 probe 与自测共同调用，禁止只复制另一套实现来“验证”。记录调用计数/顺序和真实进程退出码，断言必须能失败：

1. 配置 db/port 不符：构造客户端/写入/DELETE 均为 0。
2. 客户端已构造，运行时 db 不符、schema 不符、校验查询抛错三种情况：DML/DELETE 均为 0，disconnect 被尝试，非零退出，JSON 包含拒绝原因及 cleanup skipped。
3. 验证成功后 cleanup 抛错、disconnect 抛错：各非零，完整 JSON 有明细；原先已有用例错误时，原错误和 teardown 错误均保留。仅测试替身，不故意让真实资源遗留。
4. URL 已有 schema 参数：规范化后每个客户端仅一个预期 schema；不得使用真实业务连接测试拒绝。

然后只新建一个明确自有、回环监听、独立目录/端口/角色/数据库的一次性实例，按已有配方建合成夹具。创建前拒绝资源碰撞，不复用任何未知实例：

- 新版 probe 跑原 13 cases 一次，仍为同三个 mismatches、0 execution errors、exit 0。
- 同次运行保留一个非本 run sentinel，结束查本 run 行 0、sentinel 1；最后仅由所有者清理 sentinel。
- 不重跑原三套 suite，不必重复已接受的缺夹具/handler 500/缺 count 真实实例测试；这些行为若因实现调整发生变化，才针对性补测并说明。
- 保存实例创建、实际 db/schema、进程/目录/端口归属、停止/删除与资源释放的现场输出。只清理核验归属的本任务资源。

实例拒绝/teardown 负例是 probe 自测，不计作应用隔离门禁 AUD-039 已修复或真实数据库故障演练。

## ACCEPTANCE / STOP

满足 A/B/C、上述最小验证、原证据及 manifest hash 不变、tracked/index diff 空后停止。任一失败如实返回 REWORK/BLOCKED；不更改断言或省略负例凑 PASS。不得开始 W0，不改变餐具规则，不补写历史数据。

## FINAL RESPONSE FORMAT

STATUS（仅本次 evidence patch）:

PATCH A / B / C:

CHANGED FILES（实际清单）:

PRESERVED HASH VERIFICATION:

TEST RESULTS（逐项：预期、实际、退出码、写入/删除/断开调用次数、日志/JSON 路径；自测与真实 PG 分开）:

ISOLATION / CLEANUP:

LIMITATIONS / UNRESOLVED:

GIT / MANIFEST:

ASTRA REVIEW HANDOFF（task/packet、HEAD/branch、已接受证据、diff、结果路径、既有失败/新增失败/skip、剩余风险、推荐 GPT 模型/强度及升级条件）:

## CODEBUDDY HANDOFF / MODEL RECOMMENDATION

TASK ID: P3-PF-T01-R2。状态入口：`phase3/ORCHESTRATOR_STATE.md`。当前 W0 未启动；正常证据接受，剩余是连接拒绝与 teardown 控制流及报告一致性。

CodeBuddy 执行：沿用当前执行工具/模型，按此确定边界实现；本会话未核实 CodeBuddy 可选模型名称，不臆造选项。若使用 GPT 协助执行，建议 GPT-6 Sol / Extra High。

下一次 GPT 复审：**GPT-6 Sol / Extra High（极高）**，逐分支核对实例校验、finally 和错误汇总。若出现必须修改共享隔离门禁、应用认证或跨 wave 架构的设计冲突，停止并交 **GPT-6 Astra / Extra High** 裁决；本包不授权这些改动。
