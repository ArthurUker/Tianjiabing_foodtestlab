# CodeBuddy TASK PACKET — P3-W2-T01（Schema 演进纪律：AUD-008 → AUD-009 第一段；并行窗口 3）

## 任务与固定边界

修复 **AUD-008**（migration 链：baseline 与 unify 之间缺补丁、空库 `migrate deploy` 不可回放）与 **AUD-009 的 deploy/脚本侧**（`--accept-data-loss` 移除、`db:sync` 退出码语义、stderr 保留、failed 记录处理）。依据：`phase2/REMEDIATION_DEPENDENCY_GRAPH.md` W2、`phase2/ROOT_CAUSE_MATRIX.md` RC-04。固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`；不 reset/clean/stash/stage/commit/push。

**⚠️ 并行执行（三窗口同树）**：P3-CONS-T01（收口+**全量回归**）与 P3-W0-T02E（live-api）正在并发。铁律：
1. **禁止运行任何全套件**（root/backend/integration/isolation 全量）——CONS 独占本轮全量回归；你只跑本包沙盒测试。
2. **两道闸门**：① `deploy/deploy.sh` 与任何被 Jest 读取的文件（含 `deploy-jwt-roundtrip` 依赖面）**只在** `phase3/evidence/P3-CONS-T01/REGRESSION_DONE` 存在后才可编辑（此前做 migration 文件与沙盒回放）；② `backend/lib/tenantSync.js`、`backend/server.js`、`jest` 配置、兄弟包全部文件（快照 `PARALLEL_OTHER_PACKET_SCOPE_DO_NOT_TOUCH`）**全程禁改**。
3. AUD-009 的 **`AUTO_SYNC_TENANTS` 默认值/启动自愈降级（server.js 侧）不在本包**（server.js 保护至 W1）→ 登记为 W2-T02 后续，不算本包失败。
4. 先读 `ORCHESTRATOR_STATE.md`、本包、`P3-W2-T01_REVIEW_INPUT_MANIFEST.json`；非兄弟、非授权 drift 先报告。

## 允许修改（仅此）

- 新建 `backend/prisma/migrations/` 下补丁 migration（`ADD COLUMN IF NOT EXISTS` 等**幂等**形式；不改既有 baseline 文件）
- `backend/sync-tenant-schemas.mjs`（`db:sync` 退出码语义：全成功=0、任一失败=非 0、配置缺失=特定码；Jest 不可见，可立即改）
- `deploy/deploy.sh`（**仅 REGRESSION_DONE 后**：migration 段 stderr 保留、failed 记录处理、移除 `--accept-data-loss`、空库首部署回退语义）与 `deploy/README.md` 对应段落
- 可在 `backend/tests/migrations/` 新建沙盒回放套件；新证据只写 `phase3/evidence/P3-W2-T01/`

## 退出条件

- 沙盒实证（自建 scratch PG，可用 provisioner 派生实例）：① **空库** `prisma migrate deploy` 全通过；② **既有旧库**（模拟 unify 前形态）升级通过且补丁幂等（重放第二次不报错）；③ 租户结构一致性核对（新旧库关键表/列一致）；④ `db:sync` 三态退出码实测；⑤ deploy.sh 改动段的故障注入（stderr 保留、failed 记录不再阻断可修复重跑）——用沙盒函数级调用，**不执行真实部署**。
- 逐入口真实 rc/原始日志；实例安全 down 三条件；`deploy-jwt-roundtrip` 定点回归（deploy.sh 编辑后）通过。
- 证据 `evidence/P3-W2-T01/`：RESULT/COMMANDS/TEST_RESULTS/rc/日志/实例登记/输入对照（本包范围 + 兄弟豁免 + CONS 回归闸门遵守记录）/冻结 29 只读/`HASHES_FINAL.json`（两次只读复验）。不运行旧 PF 校验器。

## 返回

STATUS（仅 W2-T01）、CHANGED FILES（标注哪些在 REGRESSION_DONE 后改）、沙盒 rc、四组判别证据、hash/Git、登记项（W2-T02 遗留）、未决项、ASTRA REVIEW HANDOFF，然后停止。
