# CodeBuddy TASK PACKET — P3-W3-R1（DEFECT-1 根修：恢复切换后重放租户授权；窗口 2）

## 任务与固定边界

CONS-T01 登记的 **DEFECT-1** 根修（总控已裁决选项①）：恢复引擎在 schema 切换后**重放租户授权**，使目标 schema 访问授权与恢复前一致（生产恢复同受益）。依据：`evidence/P3-CONS-T01/logs/backend-full-run1-order-interference.log`、`run2-node-sort-order.log`（`node --test` 字典序 + rename 交换后租户 schema 丢测试角色 USAGE/表级授权 → 70×42501）。固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`；不 reset/clean/stash/stage/commit/push。

**并行通告**：P3-W1-T01（auth 重构）与 P3-W2-T01-R1（deploy.sh）并发。**你只运行 w3 定点套件与 DEFECT-1 复现/修复 harness（自建实例）；禁止 `npm run test:backend` 全套件与 root Jest 全量**——backend 全量的 http 套件会 import W1 正在编辑的 auth 面，跑即污染双方证据；全量复证（含"单实例单次 test:backend 全绿"目标）留 W1 后统一回归轮。先读 `ORCHESTRATOR_STATE.md`、轮次 2 复审（含 DEFECT-1 裁决）、本包、`P3-W3-R1_REVIEW_INPUT_MANIFEST.json`。

## 允许修改（仅此）

- `backend/lib/restoreService.js`（核心：切换前后授权快照/重放；只命中本任务登记对象）
- `backend/tests/backup/w3-restore-state-machine.integration.test.mjs`（追加用例，不删旧断言）
- 可新建：`backend/tests/backup/w3-grant-replay*.test.mjs` 复现/修复 harness；新证据只写 `phase3/evidence/P3-W3-R1/`

保护项：W3 交付其余文件（`backupJobs.js`/`tenantWriteBarrier.js`/`backupService.js` 等）、W1 文件面（auth 全列 `PARALLEL_OTHER`）、CONS/T02E/W2 交付、冻结 29。

## 设计口径（不另行发挥）

1. **切换前快照**：在 STAGING 完成、SWITCHING 前，以管理身份读取目标租户 schema 的授权状态（schema USAGE、表级 ACL、序列）作为基线；切换（rename 交换）后若新对象 ACL 缺失/不等同，**按基线重放**（幂等 `GRANT`，只对本任务目标 schema）。
2. **最小面**：不重建无关对象、不动其他校、不动 public；重放动作登记进台账（owner=本任务），失败按既有 cleanup 语义处理。
3. **复现→修复闭环**：先在当前代码上复现 DEFECT-1（backup/ 先跑、其余套件后跟的干扰场景，rc/日志留档），再打修复，同场景转绿；另证撞名注入与并发互斥用例**不回归**（W3-T01 判别证据复核）。
4. 多实例/崩溃残留台账限制维持 W3-T01 登记（本包不扩大）。

## 退出条件

- 复现（修复前 rc≠0 失败证据）→ 修复后同场景 rc=0；w3 三套件（11/5/7 + 新增）全绿。
- 授权重放判别：切换后 `has_schema_privilege/has_table_privilege` 与基线逐项一致（正例）；注入"基线外额外授权"不得被扩散（负例）。
- 实例安全 down 三条件；证据 `evidence/P3-W3-R1/`（RESULT/COMMANDS/TEST_RESULTS/rc/日志/输入对照/冻结 29 只读/`HASHES_FINAL.json` 两次复验）。不运行旧 PF 校验器。

## 返回

STATUS（仅 W3-R1）、CHANGED FILES、复现→修复 rc 对照、授权重放判别证据、hash/Git、未决项、ASTRA REVIEW HANDOFF，然后停止。
