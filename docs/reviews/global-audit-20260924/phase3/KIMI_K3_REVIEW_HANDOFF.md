# Phase 3 交接给 Kimi-K3（2026-09-25）

项目目录：`/Users/renkang/VS Code/Tianjiabing_foodtestlab`。本文件是**审阅交接**，不是让审阅模型重做全仓审计。CodeBuddy 负责执行和取证；审阅模型负责核对代码、证据、任务边界并裁决下一步。

## 可直接复制给 Kimi-K3 的 prompt

> 你接手本项目 Phase 3 的总控审阅工作。先读 `docs/reviews/global-audit-20260924/phase3/KIMI_K3_REVIEW_HANDOFF.md`，再按其中“必读顺序”读当前状态、最近复审、R2 任务包和输入快照。我会粘贴 CodeBuddy 的 P3-W0-T02B-R2 完整返回。请只针对 R2 包的退出条件复核实际文件与证据，不重做 Phase 1/2 或全仓审计，不直接修改应用/测试，不代跑生产部署。先核对 Git/输入与输出 hash、真实 rc/原始日志，再判断 PASS、REWORK 或 DESIGN BLOCKER。PASS 时只确认 T02B 本地验收，AUD-039 仍 OPEN，并准备**一个**后续 CodeBuddy 任务包；REWORK 时只给限定缺口的补丁包。更新总控状态与复审文档，最后给我可复制的 CodeBuddy prompt。保留所有既有分析和原始证据。

如果 Kimi 不能访问本地文件，请把本文件、下列四个“最先读”文件和 CodeBuddy 的完整 R2 返回一起粘贴给它；不要让它凭简短摘要宣布 PASS。

## 当前状态（从此前审阅对话恢复）

- 固定审计代码基线：`f08e72e3e74d188b4555e0bee16280b3dd0d622b`。当前任务 HEAD：`7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，branch `Product_tencent_CVM`。工作树**故意未提交且已有大量修改/新增文件**；不得 reset/clean/stash/stage/commit/push。
- Phase 2 严重度与架构裁决已冻结：**21 P1、28 P2，共 49 项**。三个餐具判定 delta（C02/C03/C04）单列观察，不改 49 项，也不在当前 W0 顺手修复。
- Phase 3 Preflight 已通过。W0-T01（AUD-044/JWT 部署密钥）本地 PASS，未提交/部署。W0-T02A（AUD-039 的共享测试数据库门禁、专属 PG provisioner、两个 integration 套件）本地 PASS。**AUD-039 仍 OPEN**。
- T02B 把 root Jest 默认入口和危险 p0 套件接到 T02A 同一隔离门禁。原 T02B 与 R1 均有真实正例，但总控两次判 REWORK。最近 R1：isolation **63/63**、p0 **11/11**、root **255/257**，root 仅 `tests/authSession.test.js:259`、`:294` 两项历史失败，0 skip；root 命令实际 rc=1。R1 的 School 唯一任务 code 写前检查和真实事务写后回滚已被审阅认可。
- **当前唯一待执行/审阅包：P3-W0-T02B-R2。** R1 仍有三个收尾缺口：① 同名 `gate-*.net.log` 混有多轮 PID，读取器仅凭旧 boot 行就可能把本轮缺失的连接记录判为 0；② module/dotenv 观测钩子缺正对照；③ 清理/释放失败只测 `settleAll.ok=false`，未证明实际测试进程非零，而且 root 全套与成功 after-check 分别在两台实例上。R2 包只修这些，不启动 backend 后续任务。
- backend `backend/tests/_isolation.mjs` 及部分 node:test DB 入口仍按旧 `REVIEW_TEST_DATABASE_URL`，`tests/integration/live-api.mjs` 也未接入；只有 T02B 验收后才考虑下一包。`npm test` 的 unit/db 脚本拆分属 AUD-040，不在 T02B 范围。

## 必读顺序（最先读四个）

均相对 `docs/reviews/global-audit-20260924/phase3/`：

1. `ORCHESTRATOR_STATE.md`：最新总控状态和唯一下一步。
2. `P3-W0-T02B-R1_REVIEW.md`：最近 REWORK 裁决、已接受部分和仍缺的判别。
3. `P3-W0-T02B-R2_REWORK_PATCH_PROMPT.md`：CodeBuddy R2 的**精确允许范围与退出条件**。
4. `P3-W0-T02B-R2_REVIEW_INPUT_MANIFEST.json`：R2 开始时 **417 项**文件快照；比对保护文件是否被越权改动。

需要时再读：`BASELINE_TEST_CONTRACT.md`（两项历史 Jest 失败及其它基线）、`P3-W0-T02B_TASK_PACKET.md`（原 root 任务）、`P3-W0-T02B_REVIEW.md`（首次 REWORK）、`P3-W0-T02B-R1_REWORK_PATCH_PROMPT.md`（R1 要求）、`P3-W0-T02A-R4_REVIEW.md`（T02A 已验收边界）、`P3-W0-T01-R4_REVIEW.md`（AUD-044）、`MODEL_AND_CONTEXT_HANDOFF.md`（模型切换口径）。R1 实际证据在 `evidence/P3-W0-T02B/rework1/`，原 T02B 证据在 `evidence/P3-W0-T02B/`；R2 回报应落 `evidence/P3-W0-T02B/rework2/`。

Phase 2 背景若必须追溯，定点查 `../phase2/PHASE2_MASTER_VERDICT.md`、`../phase2/ROOT_CAUSE_MATRIX.md`、`../phase2/REMEDIATION_DEPENDENCY_GRAPH.md`；不要因此重开严重度裁决。

## R2 复审时重点核对

1. **观测归属**：每次子进程有独占 run token/新日志；每个本次 boot PID 都有完整终结连接记录。旧日志、boot-only、缺终结、重复/坏记录必须 fail-closed。检查原始日志，而不只读 `TEST_RESULTS.json` 的 `ok=true`。
2. **正对照**：已知的一次回环连接计数准确；module 装载钩子及 dotenv fail-on-access 各有受控可失败正例。不能读取真实 `.env` 或连接业务库。
3. **真实失败路径**：受控 cleanup/disconnect 故障使实际进程 rc≠0，两项都尝试，原业务错误与收尾错误可辨认。
4. **同实例链**：fixture → p0 → root 全套 → after-check → 安全 down，runId/库/端口一致；sentinel、平台 admin、唯一学校、任务行和回滚行均有 after 证据。root 仅那两项历史失败，新增失败=0、skip=0。
5. **资源与证据**：PG 实例必须是任务自有；停止后进程和端口均确认释放才删除目录。核对 R2 输入 417 项、R2 输出 hash、冻结审计 29 文件；旧证据不得覆盖。旧 PF `manifest-verify.mjs` 有固定输出副作用，**不要运行它**。

审阅模型只做总控分析和必要的总控文档/下一任务包；CodeBuddy 才改测试或应用。若 R2 不满足，给最小 REWORK，不自行改代码。不要把 root 的两个历史失败算作“全套绿灯”；也不要因当前 HEAD 仍是原 commit 就误以为工作树干净。CodeBuddy 曾多次自报写入包外“工作记忆”，总控从未读取或清理私有记忆；仓库 hash 也不能证明其状态。
