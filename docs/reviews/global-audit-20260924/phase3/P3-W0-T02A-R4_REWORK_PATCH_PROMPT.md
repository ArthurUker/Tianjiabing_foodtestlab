# P3-W0-T02A-R4 — REWORK PATCH PROMPT

## TASK / ROLE / REQUIRED PRE-READ

你是 CodeBuddy 执行工程师。任务仅闭合 T02A-R3 复审中的生命周期 L1/L2/L3 剩余项，不重新全仓审计，不重做已接受的 H/E 和权限修订。

按顺序读取 phase3/ORCHESTRATOR_STATE.md、P3-W0-T02A-R3_REVIEW.md、本包、P3-W0-T02A-R3_REVIEW_INPUT_MANIFEST.json。固定 audit baseline `f08e72e3e74d188b4555e0bee16280b3dd0d622b`、HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`。先记录 git status --short、git diff --stat、HEAD/branch/index 并只读核验输入清单；未知漂移先报告。

## SCOPE

仅允许修改 `tests/isolation/provision.cjs` 与 `tests/isolation/lifecycle.test.cjs`；新增证据仅放 phase3/evidence/P3-W0-T02A/rework4/。其余现有代码、测试、工具、H/E、旧证据、W0-T01、生产模块、CI/依赖/总控文件全部保护。不写包外工作记忆，不回删未知目录。无 stage/commit/push/deploy；不得连接业务或现有开发实例。

## L1 — 探测诊断必须 fail-closed

- `probePid` / `probePort`：rc=0 + 有效 stdout **但 stderr 非空**，必须返回 unknown，不得用于归属授权或删除。rc=1 的 no-match 仅接受已确认的平台 stdout/stderr 均空契约；rc=0 空/畸形输出、不同 PID、混合坏行、signal/timeout/无状态继续 unknown。默认 `spawnSync` 包装应传递 signal/error 等探测结果，使真实命令与注入测试使用同一分支。
- 合成回归包括：rc=0 有效 PID + stderr 诊断，up 端口预检 unknown→零创建/零启动，down 预检 unknown→零 stop/delete，stop=0 后任一探测 unknown→仍保留目录。保留真实 no-match 和正常 present/listening 正对照。不要把任意 stderr 简单清空以得到 PASS。

## L2 — 没有完整归属证据不能走“已停止删除”

- 严格核对 ownership 中**原始 datadir 与 datadirReal** 各自指向本任务精确 data；它们互相矛盾、缺失或跨路径时判定失败。pidfile PID/datadir/startTime/port 任一不符时零 stop/delete。
- 删除只能走有可证明归属的安全流程：授权 stop → stop rc=0 → 该实例进程确证 absent → 该实例端口确证 released。若目录已存在但归属或运行状态无法完整证明，返回非零、`removed=false` 和人工处置信息；不以“记录的旧 PID/端口当前空闲”推断 data 安全。可以取消 `already_stopped_confirmed` 自动删除；不需要为外部手工停止/重启设计恢复工具。
- 判别用例必须先保存旧目录/文件基准，再在 **ps 对记录 PID no-match + lsof 对记录端口 no-match** 条件下分别注入 pidfile PID、datadir、startTime、port 不符或畸形，以及 `ownership.datadir`/`datadirReal` 互相矛盾。每例断言 rc/返回状态、stop=0 次、delete=0、目录与关键文件仍存在；正常完整证据正例仍可 stop 并删除。

## L3 — up/down/status 用同一归属授权

- `up` 的 catch 不再另造较弱的 `ownEvidence`。启动已经尝试后，调用与 down/status 相同的归属判断。ownership 缺失或任一字段不一致时 **零 stop/delete**，保留人工处置信息；即使 pidfile、ps、lsof 看似相互一致也不能绕过。启动前、确知本调用创建且尚未尝试启动的资源可按既有规则清理。
- 若启动后已经写入完整 ownership 且共同判定确认自有实例，才允许 stop。只有 stop rc=0、原 PID 消失且原端口释放，才删除；失败/unknown 仍保留。原始 up 错误与清理错误分开记录。不要通过修改检查器或测试替身放宽判定。
- 合成负例：`start_attempted` 后没有 ownership、ownership startTime/port/datadir 与 pidfile 不符，但伪造 ps 和监听返回表面一致；全部零 stop/delete。正常真实 trigger 失败收尾与正常真实 up/status/down 均须保持通过。

## TEST / EVIDENCE / STOP

先运行仅用合成目录/命令替身的危险分支回归，再在**新建且独占**的测试 PG cluster 上运行受影响 isolation suite 与真实 up/status/down、trigger 失败后安全收尾。只有本包 provision/lifecycle 改动，integration 23/23、probe28、H/E 汇总等 R3 已接受证据可引用，不必重跑；如本包触及其依赖或出现失败再定点复验。禁止 root/backend 全套或旧 PF 固定输出校验器。

rework4 至少提供 REPORT.md、COMMANDS.md、TEST_RESULTS.json、逐例观测（含错误码、stop/delete 次数、旧目录基准与 after 状态）、日志与真实 rc、资源登记/处置、HASHES_FINAL.json。真实 PG 正例与纯合成负例分开标注。报告先完成，hash 最后生成且排除自身/仍写入日志，随后两次只读复验；只读核对输入保护项与冻结 29 文件。无法安全处置自有真实实例时保留现场并返回 BLOCKED，不得强删。

返回 STATUS（仅本轮）、CHANGED FILES、L1/L2/L3 每个负例与正例的实际观测、测试结果、过程失败与重跑原因、残留/资源归属、输入/输出/冻结 hash、Git 状态、ASTRA REVIEW HANDOFF。完成后停止，不关闭 AUD-039，不接入 root/backend，不启动下一 wave。

建议：CodeBuddy 沿用当前执行模型；GPT 复审使用 GPT-6 Astra / Extra High（极高），携带最新 state、本包、输入快照与完整执行结果。这不是自动切换模型。
