# REWORK PATCH PROMPT — P3-PF-T01-R1

你是 CodeBuddy。只修 P3-PF-T01 未满足的证据交付部分，不重新做整个任务，不修应用。先读 `phase3/P3-PF-T01_REVIEW.md`（位于 `docs/reviews/global-audit-20260924/` 下）。

固定 branch=`Product_tencent_CVM`；HEAD=`7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`。保持原应用、正式测试、schema/migration/lockfile 及 Phase 1/2 证据不变，开始/结束核验 Git 和 29 文件 manifest。没有 commit/stage/push/生产访问权限。

## 已接受，不重做

原三套 suite 的 190/190、13/13、249/251（两项历史失败）已由 Astra 从日志确认。原 C02/C03/C04 差异也已确认。**不要重跑三套 suite、不要修改其日志**。

## 仅修改范围

`docs/reviews/global-audit-20260924/phase3/evidence/P3-PF-T01/` 内的证据 probe、报告和命令配方；新增 rework 证据子目录。不得修改本总控 review/state/task packet。

## 修正 1 — probe 成功/错误语义

- 修改 delta probe：error_count>0 或 route 响应不是 200、缺少合法数字 count/passCount、单行夹具 count≠1 时标记 execution error 并非零退出，不把错误折叠为 false。没有 execution error 时允许语义不一致返回 0，因为本任务是观察，不是证明代码正确。
- cleanup/disconnect 使用 finally；失败也保存完整结果和错误，不吞掉原始错误。
- 将字段拆为清楚的 `resultChanged`（前后原始值有变化）和 `aggregateFilledFromBlank`（原值缺失/trim 后为空且补后非空），正确表示 C04；保留原 DELTA_CASES.json 与首轮日志，修订 probe 默认写入新的 rework 目录，避免覆盖。
- 报告 actual 与观察，不改餐具规则或预期结果来消除差异。

## 修正 2 — 清理所有权与复跑方式

- 每次 run 有唯一前缀/ID；插入的 record_code、删除条件和最终 cleanup 只覆盖该 run 的对象。不要按整个 test_type 清空。
- probe 在开始写入前核对实际数据库/schema 与期望任务实例；复跑仍必须新建独立一次性 cluster/容器，不复用未知“名字像测试库”的实例。
- 修正复跑配方的数据库创建连接：使用单一明确的 postgres 维护库 URI，或明确 host/port/user/database 参数，禁止混合位置 URI 和 `-d postgres` 的歧义写法。
- 临时目录/端口已有资源时拒绝或使用新的任务资源，不覆盖旧目录，不停止未知服务；清理前核验任务实例归属。
- COMMANDS.md 分开记载“原执行记录”和“修订复跑配方”。不能确认原命令时如实标注，无需编造缺失历史输出。

## 修正 3 — 只缩紧报告措辞

修正 RESULT/TEST_RESULTS 中以下范围：

1. .env 检查只覆盖已列路径；不能推导 hardcoded/全部 dotenv 通路为零；区分 backend/probe 门禁与旧 Jest 依靠进程环境及独立实例的隔离。
2. 结论限定为被测 create 归一化路径的三个样例对齐，不能说所有新写入数据已正确；没有运行 OpenAPI stats handler/所有 PUT/sync 就不要声明这些已实测。
3. suite 额外失败为 0 与 delta observed mismatches=3 分字段报告；保留 Dashboard 仅静态核对的限制。
4. 如果没有保存建库/PID/清理原始输出，标注执行者记录，不能补写成历史原始日志。新的 rework 运行应保存对应的隔离/归属/清理证据。

## 最小验证

只使用新建独立任务实例与合成夹具：

- 修订 probe 重跑原 13 个样例，预期仍观测相同三个差异、0 execution errors；不尝试修差异。
- 有效隔离实例中故意缺失本 probe 必需的用户夹具，证明执行错误非零退出、有明细且资源释放；再正常补齐夹具验证正常路径。不要用业务连接做错误测试。
- 用受控 handler 替身注入 500/缺 count，验证 probe 的响应校验会失败。此项是 probe 自测，不宣称应用集成证据。
- 放置本任务实例内的非本 run 餐具 sentinel（不同 record_code 和 canteen），证明 probe 运行后 sentinel 不被清理，且原测试统计筛选仍只计本 run；sentinel 最后仅由其拥有者清理。
- 开始/结束 manifest、HEAD、tracked/index diff；保存新运行命令、日志、退出码和任务资源清理信息。

若无法安全完成，仅报告 BLOCKED 和缺失证据；不修改应用或正式测试以绕过。

## 返回格式

STATUS: PASS / PARTIAL / BLOCKED（仅本次 evidence rework）

PATCHED ITEMS: R1 / R2 / R3 逐项说明

CHANGED EVIDENCE FILES:

PRESERVED ORIGINAL EVIDENCE: 原 suite 日志和原 delta JSON/log 的 hash

TEST RESULTS: 原 13-case 复跑；执行错误退出码；响应校验负例；sentinel 保留

ISOLATION / CLEANUP EVIDENCE:

UNRESOLVED / LIMITATIONS:

GIT STATUS / MANIFEST VERIFICATION:

完成后停止，等待 Astra 审阅；不得开始 W0 或其它修复。

## ASTRA REVIEW HANDOFF

最终回复另附：

```text
ASTRA REVIEW HANDOFF
TASK ID / packet path: P3-PF-T01-R1 / <本文件完整路径>
task-start HEAD / branch: <核验值>
accepted prior evidence: 原 P3-PF-T01 三套 suite 已由 Astra 接受；仅 R1/R2/R3 rework
changed-file list / diff summary:
evidence/log paths and exact outcomes:
known failures / new failures / skips:
unresolved risks or decisions:
recommended Astra model + effort + why:
escalate if:
```

模型建议只供 Astra/用户选择，不表示你能切换 GPT 会话模型。对本任务通常建议 **GPT-6 Luna Extra High** 做限定证据复核；若新结果改变判定语义或触碰安全/架构边界，应升级 **GPT-6 Astra Extra High**。
