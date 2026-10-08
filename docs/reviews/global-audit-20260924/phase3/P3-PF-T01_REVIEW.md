# P3-PF-T01 — Astra Review

结论：**REWORK（限定证据工具与报告，不否定已取得测试结果，不开始应用修复）**。

审阅方式：读取实际 RESULT/COMMANDS/TEST_RESULTS/DELTA_CASES、delta probe 和原始 suite/delta 日志；独立核验 manifest 29/29；读取当前 Git 状态。未运行应用或数据库测试。

## 已接受的事实

- HEAD/branch 为任务指定值，tracked/index diff 空；原 Phase 1/2 证据 29/29 hash 未变。
- backend 日志 190/190、0 skip；PG integration 日志 13/13；root Jest 日志 249/251，失败名称及断言均精确对应历史两项。
- DELTA_CASES 的 13 个用例均有实际统计响应 200、count=1，没有记录 error；C02/C03/C04 的 JS/detail 与 PG/internal stats 分歧有对应原始日志。当前这次结果不因 probe 错误退出策略而被自动否定。
- 当前任务 data directory 已不存在。独立实例创建/归属和清理过程主要依赖执行者的报告与命令记录；已保存 JSON 载有 loopback/端口/库/schema 信息，审阅者没有补做历史现场验证。
- 故 B1 的 suite 基线证据可接受，B2 的边界差异已证实。没有应用修复，也没有 issue CLOSED。

## 尚不通过的部分

### R1：证据工具的成功/失败语义

`delta-matrix.mjs` 对每项异常只存 out.error，末尾始终 `process.exit(0)`；真实 route 未校验 200/count=1 就把缺值折叠为 pass=false。故未来错误响应可能与预期 false 混淆，错误运行也可返回成功。需要明确：业务差异是有效观察，可退出 0；执行错误/无效路由响应必须非零。C04 的 backfilled=false 与实际前后值矛盾已被报告识别，应修正机器字段并保留首轮原始产物。

### R2：清理范围与可复跑命令

probe 循环内及末尾 DELETE 仅按 test_type='tableware'，可删除同 schema 的其他任务 fixture。此次全库属于任务，未发现生产损害，但作为可复用 evidence probe 不符合按本 probe 归属清理要求；改为本 run 的唯一 record_code/ID 范围并用 finally 清理。

COMMANDS.md 宣称 verbatim 且每条安全重跑，但使用固定目录/端口无碰撞拒绝，建库命令 `psql "$BASE" -d postgres ...` 混用了连接 URI 位置参数和另一个 database 参数，不能作为无歧义的 host/user/database 指定配方。修订必须区分“实际执行记录（无法核实则标记）”与“修正后的复跑配方”，不能倒改历史声称新配方就是旧命令。

### R3：报告边界

- 三个 .env 路径不存在不证明全部 hardcoded/外部连接通路为零；_isolation 门禁也不是所有旧 Jest 入口都调用。隔离应依靠本任务独立实例、明确覆盖、入口检查及实际执行证据，报告不得称全面零风险证明。
- 当前 probe 执行的是 JS helper、deriveConclusion、PG 表达式、内部 stats handler、create-mode buildRecordWriteData。没有直接执行外部 OpenAPI stats handler，也没有覆盖所有写入形态/PUT/sync。写入归一化后合格只证明这三个 create 输入在被测路径输出对齐，不证明所有新数据正确或自洽。
- `CURRENT_HEAD_PREEXISTING_FAILURES=0` 仅可解释为“既有 suite 中除两项历史失败外无额外失败”；已知 delta 异常必须另列 3 个 observed mismatches。不能让零值掩盖现存 correctness 问题。
- Dashboard/customVerdict 只作未验证的静态观察，不能据此扩 issue 或直接修改业务规则。

## 差异处置边界

三个餐具边界暂记为当前 HEAD 已有的 delta correctness 观察，不改变冻结 49 项/21 P1/28 P2，不并成油脂 AUD-025，也不允许自动补写历史数据。完成本次证据修订后，它们不必阻塞互不相关的 W0 配置/测试门禁任务；后续到领域语义阶段再给有范围的规则裁决。Dashboard 观察暂不扩审。

## 退出要求

执行 [P3-PF-T01_REWORK_PATCH_PROMPT](P3-PF-T01_REWORK_PATCH_PROMPT.md)。保留原三套 suite 日志及原 13-case 证据；仅重跑必要的 delta/probe 失败语义与清理范围检查。不重新运行三套 suite，不修应用、不改正式测试。完成后 Astra 再审，不自动启动 W0。
