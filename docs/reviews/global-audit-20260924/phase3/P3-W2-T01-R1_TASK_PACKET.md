# CodeBuddy TASK PACKET — P3-W2-T01-R1（W2 闸门后段：deploy.sh 迁移段；窗口 3）

## 任务与固定边界

总控已**解除闸门**（CONS-T01 全量回归完成、新基线锁定，见 [P3-PARALLEL-R2_REVIEW.md](P3-PARALLEL-R2_REVIEW.md) §总控裁决 3；`REGRESSION_DONE` 标记缺口为编排责任，不再要求）。执行 W2-T01 的闸门后段：按 `evidence/P3-W2-T01/RESULT.md` §6 已定稿方案改造 `deploy/deploy.sh` 迁移段。固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`；不 reset/clean/stash/stage/commit/push。

**并行通告**：P3-W1-T01 / P3-W3-R1 并发；它们的文件对你 `PARALLEL_OTHER`。你只跑函数级沙盒与定点回归，**禁止全套件**。先读 `ORCHESTRATOR_STATE.md`、轮次 2 复审、W2-T01 的 RESULT §6/§7（方案与函数契约已定稿，沿用，不重新设计）、本包、`P3-W2-T01-R1_REVIEW_INPUT_MANIFEST.json`。

## 允许修改（仅此）

- `deploy/deploy.sh`（迁移段：stderr 保留、failed 记录处理（P3009 → `resolve --rolled-back` 后重跑，依据 F1 实证）、移除 `--accept-data-loss`、空库首部署回退语义、§6 四步）
- `deploy/README.md`（对应段落 + `deploy.sh:212` `ACCEPT_DATA_LOSS` dead config 说明移除/更正）
- 可用 W2-T01 已就绪的 `deploy-migration-sandbox.mjs` 做函数级注入（五例）；新证据只写 `phase3/evidence/P3-W2-T01-R1/`

保护项：`backend/sync-tenant-schemas.mjs`（W2-T01 已定稿，本包不动）、`backend/lib/tenantSync.js`、`backend/server.js`、W1/W3-R1 文件面、冻结 29。真实部署**零执行**（沙盒/静态/定点回归 only）。

## 退出条件

- 沙盒五例注入按 §6 函数契约全过（迁移段函数化后 `E_FN_NOT_FOUND` 负例转为各正/负例）。
- `bash -n deploy.sh` 通过；`shellcheck` 不可用则以 bash -n + 函数级沙盒为准（不新增依赖）。
- `deploy-jwt-roundtrip` 定点回归通过（rc=0）；`backend/tests/security/` 其余定点（startup-jwt-guard / jwt-secret-config）抽查通过。
- 证据 `evidence/P3-W2-T01-R1/`：RESULT/COMMANDS/TEST_RESULTS/沙盒 rc/定点 rc/输入对照/冻结 29 只读/`HASHES_FINAL.json`（两次复验）。不运行旧 PF 校验器。

## 返回

STATUS（仅 W2-T01-R1）、CHANGED FILES、沙盒与定点 rc、hash/Git、未决项、ASTRA REVIEW HANDOFF，然后停止。
