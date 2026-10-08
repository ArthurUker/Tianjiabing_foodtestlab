# CodeBuddy TASK PACKET — P3-W1-T01（身份/会话失效模型统一，RC-02 一次重构；窗口 1）

## 任务与固定边界

一次重构修复 **AUD-010（停校失效）/ AUD-012（logout/会话撤销）/ AUD-014（fail-soft 边界）/ AUD-015（iat+1 边界）/ AUD-016（吊销原子性）**——五项同批共享 session/token invalidation 模型，**禁止逐项修补**。依据：`phase2/ROOT_CAUSE_MATRIX.md` RC-02、`phase2/REMEDIATION_DEPENDENCY_GRAPH.md` §8.2、`phase2/FINAL_ARCHITECTURE_DECISIONS.md`。固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`；不 reset/clean/stash/stage/commit/push。

**并行通告**：P3-W3-R1（restore 授权重放）与 P3-W2-T01-R1（deploy.sh 段）并发。它们的文件对你全部 `PARALLEL_OTHER_PACKET_SCOPE_DO_NOT_TOUCH`；你的 auth 文件面对它们同样是兄弟范围。**你只运行：新增定点套件 + `tests/authSession.test.js` 定点 + 新失效矩阵套件（自有实例）**；**禁止全套件**（全量复证留 W1 后回归轮）。先读 `ORCHESTRATOR_STATE.md`、轮次 2 复审、本包、`P3-W1-T01_REVIEW_INPUT_MANIFEST.json`。

## 允许修改（仅此）

- `backend/middleware/authMiddleware.js`、`backend/modules/UserManager.js`、`backend/routes/userRoutes.js`、`backend/routes/schoolRoutes.js`、`backend/server.js`
- `tests/authSession.test.js`（**仅随新语义更新期望**，场景保留、注释溯源；历史两项 :259/:294 若因新模型合法消失，如实记录——不得删场景）
- 可新建：`backend/lib/sessionEpoch.js`（或同等命名的统一失效模型模块）、`backend/tests/session/` 新套件；若确需 schema 变更：**仅允许链尾新增幂等 migration**（沿用 W2-T01 沙盒验证空库/旧库回放不回归）
- 新证据只写 `phase3/evidence/P3-W1-T01/`

保护项：JWT 密钥体系（`jwtSecretConfig/Resolve`、W0-T01 全部）、W3 交付的 `tenantWriteBarrier.js`（**本包负责挂载，不改其内部**）、W2 交付、冻结 29、其余全部。

## 总控设计口径（RC-02 边界，不另行发挥）

1. **统一失效模型**：用户级与学校级 **epoch**（或等价单调失效版本）为唯一事实源；认证单点校验（一处比较，不得多处各自解释 revoked/i）；token 可携带 epoch 声明。
2. **吊销写入与业务变更同事务**：改密/降权/删除/停校的吊销落库与业务写同事务（AUD-016）；DB 故障窗口语义明确——失败即整体失败回滚，**不再"业务成功+吊销吞错"**；fail-soft（AUD-014）仅允许**可证明只读**路径或带明确时限的降级，且该行为有测试钉死。
3. **兼容窗口（AUD-012/015/016 共同前提）**：两阶段——先兼容旧 token 验证（旧 iat 语义在安全等价下接受），再可强制；不得全量强制重登（除非显式运维开关）；`iat+1` 同秒边界用**固定时钟**用例钉死（AUD-015）。
4. **停校批量失效（AUD-010）**：学校级 epoch 使停校 O(1) 失效全体会话，禁止逐 token 吊销循环。
5. **server.js 屏障挂载（W3 挂起项，本包执行）**：把 `backend/lib/tenantWriteBarrier.js` 的 `createWriteBarrierMiddleware()` 挂载到写路径（全局 READONLY_MODE 仍兜底），per-school 收窄；挂载失败不得破坏启动（fail-closed 于恢复窗口语义，不影响常规请求）。
6. `public.revoked_tokens` 语义并入新模型（保留表、语义统一）；不删历史审计。

## 退出条件

- **失效矩阵全通过**（自有实例，固定时钟）：停校/登出/改密/降权/删除 × 旧 token 立即失效 × 新 token 正常 × **DB 故障窗口**（吊销写失败时业务不得半提交、状态可解释且不沿用旧权限）× 同秒 iat 边界。
- 两阶段兼容窗口实证：阶段一旧 token 仍验、阶段二（开关）强制。
- 定点：authSession（更新后）+ 新矩阵套件 + p0 定点（11/11 不劣化——p0 走 root Jest，用你的实例跑 `--runTestsByPath`）。
- 若动 schema：链尾 migration 幂等 + W2 沙盒三场景（空库回放/旧库升级/二次重放）复用通过。
- 证据 `evidence/P3-W1-T01/`：RESULT/COMMANDS/TEST_RESULTS/逐入口 rc/原始日志/失效矩阵用例清单/固定时钟证据/实例登记/after-check/输入对照/冻结 29 只读/`HASHES_FINAL.json`（两次复验）。不运行旧 PF 校验器。**全套件回归留 W1 后统一回归轮**。

## 返回

STATUS（仅 W1-T01）、CHANGED FILES、定点 rc、失效矩阵结果、schema 决策及回放证据、屏障挂载证据、hash/Git、未决项、ASTRA REVIEW HANDOFF，然后停止。
