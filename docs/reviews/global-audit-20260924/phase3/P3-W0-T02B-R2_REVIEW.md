# P3-W0-T02B-R2 — Orchestrator review

日期：2026-09-25。裁决：**PASS（R2 补证全部满足；T02B 本地验收通过）**。**AUD-039 保持 OPEN**（backend 旧入口与 live-api 未接入，见下一任务包）；AUD-044 维持 REMEDIATED_LOCAL / PASS。总控只读复核 R2 限定代码、结构化结果、原始观测、实例登记与 hash，没有代跑 Jest/PostgreSQL，没有修改应用或测试。

## 独立核验记录（不只读 TEST_RESULTS.json 的 ok=true）

- **Git**：HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`（开始=结束）、branch `Product_tencent_CVM`、index 空；工作树脏项与 R2 前既有状态一致。
- **输入快照**：对 `P3-W0-T02B-R2_REVIEW_INPUT_MANIFEST.json` 全量复算 sha256 → **417/417**：412 未变 + 5 变化（4 `R2_ALLOWED_CHANGE` + 1 `R2_APPEND_CORRECTION_ONLY`），**0 越权、0 缺失**。R1 `REWORK_RESULT.md` 前 8602 字节前缀 hash 与快照一致 → **仅追加**成立，追加内容为 R2 更正索引。
- **冻结审计 29 文件**：经只读校验器 `P3-W0-T01/rework2/verify-frozen-readonly.mjs` 复验 → **29/29 ALL_MATCH**，manifest SHA `4f9c8d4c…bd8da` 一致。未运行旧 PF 固定输出校验器。
- **R2 输出 hash**：`rework2/HASHES_FINAL.json` 103 项，总控从仓库根独立复算 → **103/103**（等效第三次只读复验，与文件内两次自验一致）。
- **原始 rc 落盘**：8 个 gate 负例 rc=1、`isolation-unit.rc=0`、`p0-run.rc=0`、`root-full.rc=1`、`teardown-fault-p0.rc=1`（子进程真实非零）、`provision-up/down.rc=0`、`t02b-fixture-run.rc=0`、`summary-selftest.rc=0`、`make-test-results.rc=0` —— 与报告逐项一致。

## A — 观测归属/完整性（R1 缺口①②）→ 闭合

- 预载 v3（`net-observer-preload.cjs`）：每行带唯一 token+PID；`boot`/`event`（每连接一条）/`final`（每 PID 一次完整计数，末行）；移除定时累计快照；`module_boot` 证明装载钩子生效；dotenv fail-on-access 在 `fs.readFileSync` 命中 `backend/.env` 路径时**先记录后抛** `T02B_DOTENV_ACCESS`。
- 读取器（`root-entry-runner.cjs`）：期望 token 缺失、文件缺/空/坏 JSON、外来 token 行、无 boot、boot 无 final、final 无 boot、重复 final、final 非该 PID 末行、`final.events` 与 event 行数不符 → 全部 `valid=false`，**不存在可信的 0 次**。观测路径已存在即拒绝复用。
- 总控对 `rework2/logs/` 全部 **24 份 `obs-*.net.log` 独立重校验**：24 个 token 全唯一、文件名 token 与记录 token 全等、逐 PID boot→final 闭合、final 为末行、计数一致（npm-test 入口为 npm 包装+jest 子进程两个 PID，各自闭合，属正常形态）。
- 正对照真实：合成回环恰好 2 次 → `attempts=2`、`hosts=["127.0.0.1"]`；受控 SIGKILL 子进程无 final → `missing_final` invalid；module canary（`schoolAdminPurge`）命中且外来 token 读取不认；dotenv 正对照 `CAUGHT:T02B_DOTENV_ACCESS`、无 `READ_SUCCEEDED`、日志无环境值（总控对全部日志做 `DATABASE_URL=/PASSWORD=/JWT_SECRET=` 扫描，无命中）。
- 新旧并列：R1 的 `gate-*.net.log`（两轮 PID 旧格式）原样保留并在 R1 报告追加索引中说明。

## B — 实际收尾失败与同实例链（R1 缺口③）→ 闭合

- p0 `afterAll` 注入开关默认关闭；故障模式仍先执行真实清理/断开再抛注入错误；`settleAll` 逐项尝试。探针 fixture 对当前 p0 收尾路径注入 cleanup+disconnect 双失败 → 子进程**真实 rc=1**，原始日志含 `[AFTER_ALL_FAILED] steps=2 codes=[cleanupRegisteredRows:INJECTED_CLEANUP,basePrisma.$disconnect:E_END] invocations=[cleanup,disconnect] originalErrorCode=INJECTED_BUSINESS`，7/7 检查成立。
- **同一新建实例 `t02b705a7ad7`（端口 55538）** 完成 up → fixture → p0 定点 11/11（rc=0）→ 收尾故障探针 → root 全套（rc=1）→ after-check → status（ownEvidence/pid/port 一致）→ down（stopped/removed/processGone/portReleased 全 true，`residue=false`）。after-check 的 runId/port/database 与实例登记一致：sentinel 不变（n=1、digest `c77b3f58…` 前后相同）、School 恰好 1 行、平台 admin 不变、**任务行 0、回滚行 0**。总控实测端口 55538 当前无监听、无残留 PG 进程。
- root 结构化 JSON：**257/255/2/0**（T02B 基线 252/250/2/0 +5/+5，来自 p0 6→11；p0 套件 11 条断言）。失败精确两项：标题与 `BASELINE_TEST_CONTRACT` 的 DS3-M2/DS3-M3 完全一致，失败帧 `authSession.test.js:259:11`、`:294:5`（源文件 `test(` 声明在 256/291 行，帧指测试体，与契约的 259/294 口径一致）。skip=0。分栏：baseline known 2 / current-head preexisting 2 / **new failures 0 / skips 0**。
- 汇总器 fail-closed 自测 **12/12**（旧日志污染、boot-only/终结缺失、收尾 rc 伪绿、after-check runId 不符、额外 root 失败、残留实例、rc 缺/空/坏、观测证据缺失、必需 p0 用例被删等负例全部拒绝）；主汇总 **11/11 checks、problems=none**。
- 过程失败（p0 ⑪ token 归属、探针匹配模式、`readModuleHits` 无文件判合法、A1 JSON 拼接、rc 漏落盘）已如实保留并在 R1 报告追加索引中登记更正。

## 非阻塞观察（不 reopen、不要求本 wave 处理）

1. A1 辅助 `runLoopbackChild` 里 `T02B_SUPPRESS_FINAL` 环境变量在预载中并无实现（boot-only 用例实际靠过滤行构造），属死代码，不影响任何断言。
2. Node Socket 观测不覆盖 Prisma 原生引擎内部链路——R2 报告已明示，且 p0 ⑪ 以真实身份 SELECT 作为该层证据；后续包不得把"观测 0 次连接"单独当作"未连库"的完整证明。
3. root 全套基线随 p0 用例数增长变为 257/255/2/0，后续任务的 root 对照须以本数为新基线（仍仅两项历史失败）。

## 结论与下一步

- **T02B 本地验收 PASS**；AUD-039 仍 OPEN（唯一剩余面：backend 旧 `REVIEW_TEST_DATABASE_URL` 入口、backend node:test 的 DB 套件、`tests/integration/live-api.mjs`）。
- 唯一下一任务包：[P3-W0-T02C_TASK_PACKET.md](P3-W0-T02C_TASK_PACKET.md)，输入快照 [P3-W0-T02C_REVIEW_INPUT_MANIFEST.json](P3-W0-T02C_REVIEW_INPUT_MANIFEST.json)（522 项：512 PROTECTED + 9 T02C_ALLOWED_CHANGE + 1 SCRIPTS_SECTION_ONLY，总控已按当前工作树复算生成）。
- 未提交/未部署/未做现网验证；三个餐具 delta 观察不变；不启动 W2a。
