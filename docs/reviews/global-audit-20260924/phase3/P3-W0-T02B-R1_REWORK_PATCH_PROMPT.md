# CodeBuddy REWORK PATCH — P3-W0-T02B-R1

## 任务与停止点

你是 CodeBuddy 执行工程师。T02B 总控裁决 **REWORK**，只补 [P3-W0-T02B_REVIEW.md](P3-W0-T02B_REVIEW.md) 指明的三组判别：root 入口/观测器、School 写前精确范围、写后回滚及收尾失败。先实现、取证，再停止交 GPT 复审。**不启动 T02C/backend、AUD-040、W2a；不关闭 T02B/AUD-039。**

固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，branch `Product_tencent_CVM`，未提交工作树须原样延续，不 reset/clean/stash/stage/commit/push。R1 输入快照 [P3-W0-T02B-R1_REVIEW_INPUT_MANIFEST.json](P3-W0-T02B-R1_REVIEW_INPUT_MANIFEST.json) **352 项**；开始逐项只读核验，任何未知 drift 先报告，不能覆盖原证据。必读最新 `ORCHESTRATOR_STATE.md`、T02B 复审、原 T02B task packet、输入快照、原 T02B `RESULT.md`/`TEST_RESULTS.json`/`HASHES_FINAL.json`。定点读三个允许改的测试/观测文件和共享 helper 契约；无需全仓扫描。

## 允许范围

可修改 `tests/p0ProvNoAdminInSchool.test.js`、`tests/isolation/t02b-root-gate.test.cjs`、`tests/isolation/lib/net-observer-preload.cjs`；确需拆出专用受控测试辅助文件，只能在 `tests/isolation/` 新建，写明用途。原 T02B `RESULT.md` 仅可**追加 R1 更正索引**，不倒改原结论或原始日志。新证据写 `phase3/evidence/P3-W0-T02B/rework1/`。`jest.config.cjs`、controller fixture、T02A 共享门禁/provisioner、生产 purge/tenantClient/Prisma、W0-T01、原证据/冻结 29 文件全部保护。确需修改保护项，返回具体 DESIGN BLOCKER，不自行扩范围。不访问业务 PG/真实 `.env`，不在包外写工作记忆；管理员凭据只留自有 controller 进程，日志不含 URL/密码/环境转储。

## A — root 前置拒绝与观测器自证

1. 在真实 root 入口分别执行缺配置负例：`npm test -- --runInBand`、`jest --config jest.config.cjs`、直跑 p0；各记录真实 rc、精确拒绝码、模块/factory/连接/DDL/DML 可观察计数。另覆盖仅普通 `DATABASE_URL`、缺 context、URL/context 冲突；固定业务库、默认端口、非法/重复 query 仅以纯配置负例验证，绝不连接其地址。旧 `backend/.env` 读取通路以受控 fail-on-access 或等价可失败观测证明，不能读取真实内容。
2. 修复观测器的**缺文件/空文件/坏 JSON = observation invalid → 用例失败**，不能等同 0 次。原始子进程 rc/安全输出、观测 JSON/计数逐例落到 `rework1/logs/`；不打印秘密。观测器提供自身正对照：在合成临时回环 listener 上产生一次已知 Node Socket 连接并准确计数；另有合法隔离配置下的只读数据库身份 SELECT 正对照。明确 Node Socket 不覆盖 Prisma 原生引擎，把实际身份 SELECT 作为后者证据。若采样/预载失效，负例须失败。
3. 验证拒绝发生在 p0 模块 import/Prisma factory 前；可用受控模块装载 marker/constructor 观测，失败即停。保留 root 的 setupFiles 同一门禁，不改变 npm 脚本。

## B — 写前 School 范围 fail-closed

1. `beforeAll` 将 fixture 的 `schoolCode`、schema、runId 与 `cfg.tenants.a`、`cfg.schemas.a`、`cfg.runId` 逐项绑定。每个 `verifiedWriteTx` 在**同一 Prisma transaction**内先共享身份核验，再查 public School，要求清单**恰好一行且 code 等于任务派生值**，否则在 callback/任何 DML 前拒绝；不要接受空集或额外学校。继续用受限测试角色，不能因负例给它 public 写权限。
2. 以可失败用例证明空 School 清单、越界 code 时 `callback=0`、写操作=0；正例仍为真实 PG 中本任务唯一 School。合成拒绝可用受控 tx/查询替身，但必须调用生产使用的同一范围判断；标注合成与真实，不能把替身说成真实 PG。保留真实 purge 五项语义和第⑥项。

## C — 真实回滚、清理与错误保留

1. 在新建自有实例的真实 Prisma transaction 中：共享身份核验与 School 范围通过 → 写入 runId 行 → **故意抛错** → transaction 回滚后独立查询确认该行不存在；sentinel/public 平台 admin 不变。不要通过跳过断言或清空外部表达成。若试图登记成功提交行，仍只按键清理。
2. 以受控注入验证 cleanup 与 disconnect 各自失败时整体非零、各项均尝试、原始业务错误（如有）不被收尾错误覆盖；若现有 `settleAll` 契约不能保留原错误，在允许文件内改调用方式，不改共享 helper。逐案保存真实/受控 rc 与结构化错误，不在日志回显秘密。
3. 沿用严格自有实例 `up/status/down`，仅归属互核和 stop/进程/端口三条件全满足才移除；未知/失败保留现场并报告，不强删。保留 T02B 原日志与 hash。无需重跑 T02A 或 W0-T01 已接受套件。

## 验证与证据

先门禁/观测自测，再 p0 定点，再在**同一安全实例**重跑 root 全套，因为 p0 用例数会变化。报告 root 命令真实 rc=1 是否仍仅为 `authSession.test.js:259`、`:294` 两项历史失败；从结构化 JSON 精确比较 file/title/断言行、总数差值、新失败与 skip，不能以“失败仍为 2”单独放行。R1 证据至少包括 `REWORK_RESULT.md`、`COMMANDS.md`、`TEST_RESULTS.json`、逐入口原始 rc/安全日志与观测文件、回滚前后行数、清理/释放注入结果、实例登记、只读输入/保护项/冻结 29 对照、`HASHES_FINAL.json`。汇总器对缺/空/坏 rc、缺必需用例、观测器缺失/坏日志、额外 root 失败、未解决实例设 fail-closed 副本负例。

先完成报告，再生成最终 hash（不含自身及仍写入日志），至少两次只读复验；不运行旧 PF 固定输出校验器。过程失败与补救如实写入，不覆盖原 T02B 原始证据。结束给出 STATUS（仅 R1）、CHANGED FILES、每项 A/B/C 判别、真实 rc、root 历史失败精确对照、新失败/skip、资源/manifest/Git、未决项与 ASTRA REVIEW HANDOFF，然后停止。

模型交接：CodeBuddy 沿用当前执行模型；GPT 复审建议 **GPT-6 Astra / Extra High（极高）**，携带最新 state、本复审、本包、352 项输入快照与完整 R1 返回。模型切换不会自动携带仓库外私有工作记忆；以这些仓库文件为准。
