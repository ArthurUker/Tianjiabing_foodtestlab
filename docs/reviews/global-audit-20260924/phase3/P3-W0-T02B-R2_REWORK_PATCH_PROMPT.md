# CodeBuddy REWORK PATCH — P3-W0-T02B-R2

## 任务与固定边界

你是 CodeBuddy 执行工程师。总控对 R1 裁决 **REWORK**：B 组范围门禁与真实回滚可保留；本包只修 [P3-W0-T02B-R1_REVIEW.md](P3-W0-T02B-R1_REVIEW.md) 指明的观测归属/完整性、钩子正对照、实际收尾失败与同实例复核。完成取证后停止交 GPT 复审；**不启动 T02C/backend、AUD-040、W2a，不关闭 T02B/AUD-039**。

固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`；沿用未提交工作树，不 reset/clean/stash/stage/commit/push。依次读最新 `ORCHESTRATOR_STATE.md`、R1 复审、本包、[R2 输入快照](P3-W0-T02B-R2_REVIEW_INPUT_MANIFEST.json)、R1 `REWORK_RESULT.md`/`HASHES_FINAL.json`。开始逐项只读核验 **417 项**；未知 drift 先报告，不覆盖旧证据。不做全仓扫描。

允许修改 `tests/isolation/lib/root-entry-runner.cjs`、`tests/isolation/lib/net-observer-preload.cjs`、`tests/isolation/t02b-root-gate.test.cjs`、`tests/p0ProvNoAdminInSchool.test.js`；确有必要可在 `tests/isolation/` 新建**本包专用**辅助文件。R1 `REWORK_RESULT.md` 只可追加更正索引，不倒改原证据。新证据只写 `phase3/evidence/P3-W0-T02B/rework2/`。`jest.config.cjs`、controller fixture、共享 T02A 门禁/provisioner/PG integration、生产模块、W0-T01、旧 T02B/R1 原始日志和冻结 29 文件均保护。若必须修改保护项，返回具体 DESIGN BLOCKER。

## A — 观测必须属于本次子进程且完整

1. 每次 `runRootEntry` 使用唯一 run token 与此前不存在的任务自有观测路径；若目标已存在则拒绝，不能读取/拼接历史日志。预载 boot 与最终连接记录都带 token/PID；读取器必须逐 PID 对照：每个本次 boot 都有完整终结记录，记录格式/计数可解析，无外来 token/PID。**boot-only、终结行缺失、旧日志混入、重复终结、坏 JSON、空/缺文件**均 `valid=false`，绝不能返回可信的 0。异常退出若无法完整取证，也判 invalid。不要用重复的定时累计快照加总为连接次数；采用每次连接事件或每 PID 一次最终完整计数。
2. 自测须证明：先放一份“旧运行 boot+0 次终结”日志，再模拟本次没有终结/没有任何新日志，观察器拒绝；真实 root 缺配置负例每个都有独占 boot/终结及准确 0 次连接。临时回环 1 次连接正对照仍准确为 1。原 R1 日志不改，新旧记录并列说明。
3. module load 钩子与 dotenv fail-on-access 各加一个**合成可失败正对照**：受控模块命中能生成预期记录；尝试读取受控的 `backend/.env` 路径应在读取前抛 `T02B_DOTENV_ACCESS`（不创建/读取真实 `.env`）。原负例仍证明门禁在 p0/Prisma 装载之前拒绝。所有日志只含安全码、token、PID、次数，不含完整 URL、密码或环境值。

## B — 实际收尾失败与同实例验收链

1. p0 第⑩例的 `settleAll` 单元注入可保留，但**不能**单独代表实际 `afterAll` 非零语义。用受控子进程/专用 fixture 对当前 p0 收尾调用路径做故障注入：cleanup 与 disconnect 逐项都尝试；任一失败使命令真实 rc≠0；原始业务错误如存在，必须仍可按 code/对象身份辨识，清理与释放错误同时记录。仅在允许文件/新建辅助文件做受控注入，不改共享 helper 或生产模块，不污染真实 root 正例。
2. 在**同一个新建独占实例**按序运行 controller fixture → p0 定点 → root `npm test -- --runInBand` → 独立 after-check → status/down。after-check 必须对应这个 runId/库/端口，核对 sentinel、public 平台 admin、唯一 School、任务行 0、回滚行 0；若 after-check 报错，不先销毁再换实例伪称同链路，先保留原错误并安全收尾，再新实例完整重跑。记录每个入口真实 rc、实例归属、stop/进程/端口三条件；无法安全清理则留现场并报告。
3. 从新结构化 JSON 精确比对 root 仅 `authSession.test.js:259`、`:294` 两项历史失败，计算实际新增 p0 用例差值，分栏报告 baseline known/current-head preexisting/new failures/skips。不要把 rc=1 或失败数=2 自动算 PASS。

## 必需证据与停止

`rework2/` 至少有 `REWORK_RESULT.md`、`COMMANDS.md`、`TEST_RESULTS.json`、逐入口原始 rc/安全日志、独占观测日志及 token/PID/终结矩阵、观测器和钩子自测负例、实际收尾失败子进程 rc/错误码、同实例 p0/root/after-check/安全 down 登记、输入/保护项/冻结 29 对照、`HASHES_FINAL.json`。汇总器对旧日志污染、boot-only/终结缺失、实际收尾 rc 伪绿、after-check 与 root runId 不同、额外 root 失败、残留实例做 fail-closed 副本负例。先完成报告，再生成最终 hash，排除自身/仍写入日志，至少两次只读复验；不运行旧 PF 固定输出校验器。过程失败原样保留，不在包外写工作记忆。

返回 STATUS（仅 R2）、CHANGED FILES、A/B 判别证据、真实 rc、同实例链、root 历史失败、新失败/skip、资源与 hash/Git、未决项和 ASTRA REVIEW HANDOFF，然后停止。GPT 复审建议 **GPT-6 Astra / Extra High（极高）**，携带最新 state、R1 复审、本包、417 项输入快照与完整 R2 结果；模型切换不会自动带入仓库外私有记忆。
