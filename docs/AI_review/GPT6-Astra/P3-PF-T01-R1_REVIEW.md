# P3-PF-T01-R1 — Orchestrator review

日期：2026-09-24。裁决：**REWORK（仅下列剩余项）；Phase 3 仍 BLOCKED，未启动 W0。**

审阅者直接读取 v2 probe、隔离 helper、5 份 JSON、正常/负例及归属/清理日志、RESULT/TEST_RESULTS/COMMANDS；独立核验 Git 和 hash。未执行 probe、应用测试或数据库操作。本补记保留并继承此前 review，不重做审计。

## 已接受，不重复取证

- branch `Product_tencent_CVM`；HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`；tracked/index diff 空；仅审计目录 untracked。
- manifest 29/29 文件 hash 匹配；原三套 suite 日志、原 DELTA_CASES、两份原 delta 日志及原 probe 共 7 个 hash 全部与首次 review 一致。
- v2 正常与恢复运行均为 13 cases、C02/C03/C04 三个 mismatches、0 execution errors、exit 0。C04 的 resultChanged/aggregateFilledFromBlank 均为 true。
- 缺用户夹具、handler 500、handler 缺 count 各记录 13 个出错用例、exit 4；后两项仅为 probe 自测。
- 每用例与最后清理已按本 run 前缀限定；sentinel 保留 1、probe 行 0，最终 sentinel 由所有者清理。
- rework 独立实例/PID/端口及停止、目录删除有现场日志；实际运行 JSON 的 public/tenant schema 分别为 public/school_reviewtest。本次成功运行未见误清理证据。
- 原 suite 基线 190/190、13/13、249/251（仅两项历史失败）继续有效。三个餐具差异继续作为当前 HEAD 的独立 delta 观察；不改 49 项清单、不并入 AUD-025、不补写历史。

## 必须补齐的原验收项

### A. 运行时 schema 未断言，拒绝路径仍可执行 DELETE

`rework/delta-matrix-v2.mjs:81–84` 创建客户端后，将 assertIsolated 返回的 schema 写进报告；`backend/tests/_isolation.mjs` 的 assertIsolated 实际仅检查数据库名，**不会比较预期 schema**。因此“写前校验实际数据库/schema”的原 R2 要求未满足。tenant URL 通过拼接追加 schema，已有 query 中的 schema 也未明确替换。

更直接的拒绝路径问题：客户端创建后，如运行时数据库检查抛错，仍进入 `finally:219–220`，仅凭 tenant 存在就调用 deleteMany。前缀限定缩小了删除范围，但不能取代“目标连接已通过校验”的前提。此结论来自实际控制流；未向任何错误数据库发起实验。

应在 probe 内显式比较两个客户端的实际 db/schema，全部通过后才许可任何 DML（包括 finally）；未通过时只 disconnect、记录 cleanup skipped。不修改共享 helper，不扩展为 AUD-039 应用修复。

### B. teardown 失败仍可能报告成功

`finally:223–227` 的 cleanup 异常只记局部字段，disconnect 异常直接忽略；正常用例全部完成时 exitCode 仍可能为 0。这不是本次日志中的实际失败，但仍违反原 R1 的执行错误不能被成功退出掩盖要求。将 teardown 错误纳入最终汇总、非零退出并保留原错误；计数应在 finally 结束后计算。

### C. 报告残留相互矛盾的结论

- TEST_RESULTS.json 的 `delta_matrix.key_findings` 仍有 `new writes are self-consistent`，以及 v1 backfilled=false 的旧描述，未清楚作为历史字段与 v2 分开。
- RESULT.md §5 仍有“写入侧自洽能消除新数据差异”，与 §4 的三个 create 样例限制矛盾。
- RESULT.md §4 的 route===pg 是 13 个布尔结果一致，不能据此证明未执行的第二个路由；TEST_RESULTS 中 byte-for-byte 也不是这种实验能证明的事实。

统一限定为三个被测 create-mode 输入归一化后 PG 结果与 JS 对齐；内部 stats 与 PG 布尔值 13/13 一致；外部 OpenAPI stats/PUT/sync/导入未执行。原 v1 证据保留。

## 非 blocker 的记录更正

本次磁盘实际 rework 为 25 文件：2 个 md/mjs、5 JSON、18 logs。用户转述的 22 logs 与报告的其他计数不作为验收依据。正常运行 JSON 的最终 cleanup.deleted=1（其余逐例清理），不应解释为只清理了总共一行或最终删除 13 行。补丁报告给实际清单即可，无需为计数单独复跑。

## 下一步

仅执行 [P3-PF-T01-R2_REWORK_PATCH_PROMPT](../../reviews/global-audit-20260924/phase3/P3-PF-T01-R2_REWORK_PATCH_PROMPT.md)。保留以上已接受结果，补连接拒绝/teardown 负例及报告一致性；不重跑三套 suite，不修改应用，不启动 remediation。此处 R2 是第二次 rework 的任务后缀，与首次补丁中的 R1/R2/R3 验收类别不同。
