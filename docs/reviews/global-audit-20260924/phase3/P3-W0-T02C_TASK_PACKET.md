# CodeBuddy TASK PACKET — P3-W0-T02C

## 任务与固定边界

总控对 T02B-R2 裁决 **PASS**（见 [P3-W0-T02B-R2_REVIEW.md](P3-W0-T02B-R2_REVIEW.md)）。AUD-039 唯一剩余面是本包：把 **backend 旧门禁入口**（`backend/tests/_isolation.mjs` 的 `REVIEW_TEST_DATABASE_URL` 体系及其 7 个使用方）与 **`tests/integration/live-api.mjs`** 接入 T02A 同一隔离门禁与专属 provisioner。完成取证后停止交 GPT 复审；**不启动 AUD-040（npm test 脚本拆分）、不动三个餐具 delta、不启动 W2a，不宣布 AUD-039 关闭**。

固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`；沿用未提交工作树，不 reset/clean/stash/stage/commit/push。依次读最新 `ORCHESTRATOR_STATE.md`、[T02B-R2 复审](P3-W0-T02B-R2_REVIEW.md)、本包、[T02C 输入快照](P3-W0-T02C_REVIEW_INPUT_MANIFEST.json)（**522 项**）。开始逐项只读核验；未知 drift 先报告，不覆盖旧证据。不做全仓扫描。

## 允许修改（仅此）

- `backend/tests/_isolation.mjs`
- `backend/tests/records/db-integration.test.mjs`、`stats-verdict.integration.test.mjs`、`isolation-gate.test.mjs`、`partial-update.integration.test.mjs`
- `backend/tests/openapi/stats-date.integration.test.mjs`
- `backend/tests/http/internal-write-http.integration.test.mjs`、`openapi-http.integration.test.mjs`
- `tests/integration/live-api.mjs`
- 根 `package.json`：**仅 scripts 段**（新增 backend 隔离入口脚本；其余字段 diff 为空）
- 可在 `backend/tests/` 新建**本包专用**辅助文件；新证据只写 `phase3/evidence/P3-W0-T02C/`

保护项：T02A 共享门禁/provisioner（`tests/helpers/`、`tests/isolation/`、`tests/integration/pg-bootstrap.js` 等）、T02B 全部交付（root gate、p0、观测器）、W0-T01、root Jest 配置、生产模块、`backend/package.json`、全部旧证据与冻结 29 文件。必须修改保护项 → 返回具体 DESIGN BLOCKER，不擅自改。

## 总控已定设计口径（不另行发挥）

1. **唯一配置来源**：backend DB 测试与 live-api 只认 `TEST_DATABASE_URL` + `TEST_DB_CONTEXT_FILE`（经 `tests/helpers/db-isolation` 体系）。**未配置 → 非零拒绝**（fail-closed），不再 skip——`BASELINE_TEST_CONTRACT` 已明确 skip 不计 PASS。不触 DB 的纯单测不受影响、仍可直接跑。
2. **废弃 `REVIEW_TEST_DATABASE_URL`**：不得保留任何到 `DATABASE_URL`/业务 dotenv 的 fallback；`_isolation.mjs` 旧语义整体替换为对共享门禁的调用，旧符号删除或改为报错的迁移指引（报错信息不含任何连接串/凭据）。
3. **复用而非复制**：backend ESM 测试经既有薄包装（或 `createRequire`）调用 `tests/helpers/db-isolation.cjs` 同一实现，禁止粘贴第二份门禁/provisioner 逻辑。schema/角色/库名一律取 provisioner 派生值，**废除 `school_review*` 硬编码前缀**。
4. **同实例链**：本包所有 DB 套件在**同一新建独占实例**执行：up → backend node:test 全量 → live-api（真实后端，任务自有端口）→ after-check → status → down。after-check 与实例 runId/库/端口一致。
5. **live-api 边界**：BASE_URL 只允许指向本任务拉起的后端进程（任务自有端口）；后端进程以隔离身份启动；跑完清理本脚本数据并停止后端。

## 退出条件

- backend node:test 全量（基线 **190/190、0 skip**，迁移后实测计数须逐套对照，分栏 baseline known/current-head preexisting/new failures/skips）；缺配置/冲突等负例有真实子进程 rc≠0 与安全日志（拒绝码，不含凭据）。
- `stats-verdict.integration.test.mjs` 等原 skip 路径改为拒绝后有真实负例；正例在新实例通过。
- live-api 全绿（或如实记录既有失败并分栏），后端进程与实例均安全停止；端口实测释放、无残留。
- `npm run` 新入口脚本（scripts 段新增）实测可用；root Jest 与 PG integration 不受影响（各跑一次确认 257/255/2/0 与 13/13 不劣化，rc 原样落盘）。
- 证据：`evidence/P3-W0-T02C/` 下 RESULT.md、COMMANDS.md、TEST_RESULTS.json、逐入口原始 rc/日志、实例登记、after-check、输入 522 项对照、冻结 29 只读核验、`HASHES_FINAL.json`（先写完报告再生成 hash，排除自身与仍写入日志，至少两次只读复验）。**不运行旧 PF 固定输出校验器**。过程失败原样保留。不在包外写工作记忆。

## 返回与复审

返回 STATUS（仅 T02C）、CHANGED FILES、真实 rc、同实例链、分栏计数、资源与 hash/Git、未决项和 ASTRA REVIEW HANDOFF，然后停止。GPT 复审建议 **GPT-6 Astra / Extra High（极高）**，携带最新 state、T02B-R2 复审、本包、522 项输入快照与完整 T02C 结果。
