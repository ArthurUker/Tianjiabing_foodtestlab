# P3-PF-T01-R2 — Final preflight evidence review

日期：2026-09-24。裁决：**PASS。P3-PF-T01（含两次限定 rework）完成；READY_FOR_REMEDIATION。**

本裁决允许分配第一个有界修复任务，不代表应用已修复、全部测试绿灯或允许部署。审阅者只读代码/JSON/原始日志与 Git/hash，没有代跑测试、数据库或应用。

## 验收证据

| 原遗留项 | 直接核对结果 |
|---|---|
| PATCH A：校验前不得 DML | probe-core 的 precheck 在 makeClients 前；两个客户端各自比较实际 db/schema；全部通过才进入 case loop，finally 仅在 writePermit 后清理。URL 使用 searchParams.set 替换 schema。真实包装复用已验证客户端，reset/create/cleanup 按 run 范围。 |
| 拒绝路径 | 自测与真实包装调用同一个 runProbe。ST1a/b 日志和 JSON 为 exit 5、构造/DML=0；ST2a/b/c 为 exit 5、DML=0、disconnect=2、cleanup skipped。自测 construct=1 指工厂调用一次，实际返回两个客户端。 |
| PATCH B：teardown 错误 | cleanup/disconnect 错误记录，最后汇总；ST3a/b/c 均 exit 4，分别包含 cleanup、disconnect、原错误+cleanup 错误。原执行错误未被 teardown 覆盖。 |
| 自测证据 | SELFTEST_v3_SUMMARY 44/44；原始 selftest 日志与逐例 JSON 一致。ST2 真实退出码来自子进程日志及 JSON，父测试没有为每个 ST2 单列 exit-code assert；本次观测值已核对，未据此否定有效结果。 |
| 真实 PG | run-v3.log 与 DELTA_CASES_v3：13 cases、同 C02/C03/C04 三个 mismatches、execution=0、teardown=0、exit 0；两个 actual db/schema 等于 expected；C04 两个补写字段 true。 |
| 归属与清理 | iso-ownership 记录 PID 33143、独立目录 /tmp/p3pf01r2-pg、回环 55500；postcheck sentinel=1、本 run 行=0；sentinel owner 删除后表行=0；cleanup 日志有停止/删除记录。属于执行者保存的现场证据，审阅者未重新创建实例。 |
| PATCH C | RESULT §4/§5、TEST_RESULTS key_findings 已限定三个 create 样例及内部 stats 的布尔一致；旧错误表述明确撤回。COMMANDS C 为当前配方，A/B 只作历史记录。 |

## 完整性与保留边界

- HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`；tracked/index diff 空，仅审计目录 untracked。
- 独立计算 manifest 29/29 hash 全匹配。原 v1 的 7 项完整 hash 与首次 review 一致；v2/probe/report/JSON 计算值与执行者记录一致。本次核验不是独立历史备份的证明。
- 当前 rework2 实际 27 文件，其中 12 logs（转述的 13 logs 是计数误差）。最终 cleanup.deleted=1；13 次 reset 中首例无本 run 行，因此前序 reset 合计清理 12 行。旧报告“其余 13 行”是算术笔误，不影响实际清理与 sentinel 证据，无需第三次 rework。
- 本次仅验收任务规定的证据路径，不将 probe 认证为通用数据库安全框架。运行时门禁只在 probe 内得到修订，应用 AUD-039 仍未修复。之后如复用 probe，必须使用新输出副本/名称，保留本轮结果，不能直接照抄固定输出命令覆盖归档。

## Preflight gate 与 delta 裁决

B1 完成：当前 suite 基线 backend 190/190、PG 13/13、root Jest 249/251；仅两项已登记 authSession 历史失败，0 新增 suite 失败。没有要求或执行本轮三套重跑。

B2 完成：三个餐具差异正式登记为 **CURRENT_HEAD_DELTA_OBSERVATIONS（C02/C03/C04）**，与 suite 失败分栏；不新增 AUD 编号、不并入油脂 AUD-025、不自动补写历史数据。以后涉及餐具语义的任务必须先定统一规则；此次仅允许无关 W0 启动。Dashboard customVerdict 保留为未实测静态观察，暂不扩审。

Phase 2 49 项、21 P1/28 P2 与既定架构保持不变；没有 issue 因此关闭。证据仍为 CONTENT_PINNED_LOCAL_UNTRACKED，不声称已经 Git freeze 或独立归档。

## 唯一下一任务

生成 [P3-W0-T01_TASK_PACKET](P3-W0-T01_TASK_PACKET.md)：只处理 AUD-044 / RC-10 JWT 配置门禁。W0 的 AUD-039 随后另包，未开始；选择 044 在先符合冻结 wave 的“两个实现分别验收”，且本任务可以用无数据库替身验证，不依赖尚未修好的全局测试门禁。

任务包生成后停止。CodeBuddy 的实现与最终应用修复验收仍待执行。
