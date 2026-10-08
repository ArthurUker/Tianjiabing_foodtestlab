# P3-W0-T01-R4 — Final local acceptance

裁决：**PASS。P3-W0-T01（含 R1…R4）本地修复验收完成；AUD-044 = REMEDIATED_LOCAL / PASS。** 日期：2026-09-24。

这不表示已提交、已部署、已检查现网密钥，或整个 W0/RC-10 已完成。AUD-039 仍 OPEN。原 Phase 1/2 inventory、严重度与证据不改写；本文件记录 Phase 3 实现验收状态。

## 审阅方式与完整性

总控只读实际源码、harness、cases.jsonl、TEST_RESULTS、汇总器与日志，并独立计算 hash；未代跑测试、应用、DB、部署，未修改应用。

- HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7` / `Product_tencent_CVM`；index 空；累计 5 tracked 文件 +138/-53 与 R3 相同。
- R3 输入快照 128 项：127 未变，仅授权故障 harness 变化，无缺失。该核验不声称证明仓库以外不存在变更。
- R4 HASHES_FINAL 独立复验 10/10；冻结 29 文件 29/29。原 R3/PF 文件包含于受保护清单，未再改写。
- 已存日志可提取 84 条 PASS、0 条 FAIL，汇总 `pass=84 fail=0`；14 个 JSON case，11 条应用路径、3 条观测器自测。

## R4 核心退出条件

1. INJ-1…7 在父流程创建旧目标后保存 before hash，子进程结束后比较 after；不再以操作后目标作为自身基准。SEC 的基准是在执行后由父流程独立合成输入重建，**不是读取执行后目标**；计算时间与报告所说“全部提前保存”不完全一致，但独立预期未受被测子进程修改，满足本轮防止自身比较的目的。
2. 所有相关 INJ/SEC 路径安装 mv 包装。INJ-1/2/3 返回 22/23/24、不进 publish、mv=0；INJ-6/7 返回 7/8、mv=0。INJ-4 调用真实 mv、计数 1 且 publish=6；结合已接受共享库控制流，支持 rename 失败分支。INJ-5 为明确标记的 mv 失败替身。
3. INJ-1…7 与 SEC-1/2 均执行退出后非空路径/本例目录归属/不存在检查；INJ-8 prepare=6 且片段清理。INJ-3 在真实 staging 清理前观察到前两项字段存在、BACKUP_DIR 缺失。
4. SEC-1/2 执行实际 deploy.sh §5.2 文本，捕获 fail 的子进程 rc=99、未到片段尾部、目标不变和清理。SEC-3 rc=0、到尾部、目标 hash 改变，真实 dotenv 重载与独立合成 access/JWT_EXPIRE/CORS_ORIGIN 相符。生产仍无测试跳过开关。
5. 观测器自测证明：目标被故意改写可检测，空/外部路径拒绝，主动调用 mv 一次可计数，计数文件缺失返回 invalid。

以上补齐 R3 E2/E3 的核心证明缺口，无需再改已接受的应用 A/B 实现。

## 证据口径修正与局限（不再发 R5）

- JSON 并非每个字段都是独立捕获：部分期望 rc/布尔及 assertions=pass 为 harness 填入常量，summarize-cases 的 exit_code=0 也为常量。**不能单独依赖此 JSON/汇总器裁决新运行是否成功，不能把该归档汇总器作为 CI 门禁。** 本次依赖实际测试断言源码、84/0 日志、逐例 before/after 和 hash 共同验收。
- INJ-4 未另存 mv 命令原始数字 rc；实际命令确被调用且 publish=6，依共享库分支推断 mv 非零。INJ-4…7 的 reached_after_publish 只表示测试驱动收集结果，不证明生产继续；生产停止由 SEC-1/2 的真实 caller 和调用处控制流证明。
- obs_mv_count 拒绝缺失文件，但没有完整验证任意损坏日志语法；不得宣称已覆盖所有“不可解析计数文件”。本次受控包装输出与计数证据有效。
- 日志局部中文仍含非 UTF-8 字节；ASCII case ID/结果与 JSON 可核对。不要求重写历史日志；未来证据日志应直接重定向原始输出并记录真实退出码，不能用终端转录替代原文件。
- SEC 使用受控 chown 替身；无真实 systemd、整段 deploy、PG 或浏览器验证；SIGKILL 不可捕获，mv 成功后的后续部署失败不承诺回滚。
- 执行摘要提到“写入工作记忆”，该行为不在 R4 授权范围；本轮只验证列明仓库文件，未访问个人记忆。后续任务明确禁止额外记忆写入，不把输入清单完整性夸大成全机未改动。

## W0 首包累计验收

原共享 secret 校验、启动前 fail-closed、dotenv 有效值解析、合法字节与 refresh 派生保持、无值错误输出、测试配置源隔离、分发早期拒绝、完整 env 组装与发布前权限保护的既有结论保持。接受已有 unit 29、round-trip 18、startup 10、deploy-flow 42、R3 lifecycle 31 与本轮 fault 84 的各自执行证据；它们是不同轮次结果，不能声称本轮重跑全部。W0 原两项纯内存 Jest 的 38/40 仍为接受的两个历史失败；全局 preflight 190/190、13/13、249/251 基线不改。

本地修复退出条件满足；发布仍需独立授权与环境验证，未检查/轮换任何现网凭据。下一步仅执行 [P3-W0-T02A_TASK_PACKET](../../reviews/global-audit-20260924/phase3/P3-W0-T02A_TASK_PACKET.md)：AUD-039 共享隔离门禁与两个 PG integration 套件接入。root Jest/backend 其余 DB 入口后续接入前不得宣称 AUD-039 完成。
