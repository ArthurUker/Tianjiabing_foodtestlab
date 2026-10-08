# CodeBuddy TASK PACKET — P3-W0-T02D

## 任务与固定边界

总控对 T02C 裁决 **PASS**（见 [P3-W0-T02C_REVIEW.md](P3-W0-T02C_REVIEW.md)），AUD-039 已升级 REMEDIATED_LOCAL / PASS。本包是 **AUD-039 收尾件**：产出最终统一入口矩阵、更正 T02C 报告归因（追加索引，不倒改）、修正两处过期注释。**纯文档/核验任务**：不改任何应用/测试逻辑、不跑全量套件（只跑零配置的拒绝冒烟）、不启动 AUD-040/W1/W2a。

固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`；沿用未提交工作树，不 reset/clean/stash/stage/commit/push。先读最新 `ORCHESTRATOR_STATE.md`、[T02C 复审](P3-W0-T02C_REVIEW.md)、本包、[T02D 输入快照](P3-W0-T02D_REVIEW_INPUT_MANIFEST.json)，开始逐项只读核验；未知 drift 先报告，不覆盖旧证据。不做全仓扫描。

## 允许修改（仅此）

1. `docs/reviews/global-audit-20260924/phase3/evidence/P3-W0-T02C/RESULT.md`：**仅追加**「T02D 更正索引」，登记两条更正（见 §A.1），不倒改上文与原始日志。
2. `backend/tests/records/db-integration.test.mjs`：**仅头注**——"未设置则整体跳过"改为"未配置则拒绝（fail-closed）"；示例路径 `node --test tests/records/...` 改为 `backend/tests/...`。
3. `tests/integration/live-api.mjs`：**仅注释**——`:315` 附近注释中的 `sysdynit` 表述改为派生动态学校 code。
4. 新建 `docs/reviews/global-audit-20260924/phase3/P3-W0-AUD039_FINAL_ENTRYPOINT_MATRIX.md`（最终统一入口矩阵，内容见 §B）。
5. 新证据只写 `phase3/evidence/P3-W0-T02D/`。

保护项：其余一切（含全部测试/门禁/生产模块、既有证据、冻结 29 文件、`docs/TEST_DATABASE_ISOLATION.md` 正文）。必须改保护项 → 返回具体 DESIGN BLOCKER。

## A — 更正与注释（逐字范围）

1. **T02C 追加更正索引**（写在 RESULT.md 末尾，标题 `## T02D 更正索引（P3-W0-T02D；只追加）`）：
   - backend +61 归因更正：实际为 ① `isolation-gate` 5→9（+4）② W0-T01 新增的三个 security 套件（`deploy-jwt-roundtrip`/`jwt-secret-config`/`startup-jwt-guard`，共 57）不在 PF 基线的显式 17 文件清单内；PF 基线中 7 个 DB 套件是**真实运行**（非 skip）。原文"DB 套件由 skip 改为真实运行"的表述不成立，计数不受影响（190+4+57=251，0 新失败 0 skip）。
   - `package.json` 的 `test:backend` 系**修改既有脚本**（旧值 `jest backend/**/*.test.js` 失效 glob），非纯新增；仍在 scripts 段授权内。
2. 两处过期注释按上文 §允许修改 2/3 逐字修正。

## B — 最终统一入口矩阵（AUD-039 关闭件）

新建 `P3-W0-AUD039_FINAL_ENTRYPOINT_MATRIX.md`，以 T02A/T02B/T02C 已验收证据为来源（引用路径，不复制大段日志），覆盖**全部测试入口**的统一口径：

| 入口 | 配置来源 | 未配置行为 | 拒绝码 | 实例来源 | 已验收证据 |
|---|---|---|---|---|---|
| root Jest（`npm test` / `jest --config` / 直跑 p0） | TEST_DATABASE_URL + TEST_DB_CONTEXT_FILE | 非零拒绝（不 skip） | MISSING_TEST_URL 等 | 任务自有 provisioner | T02A/T02B 证据路径 |
| PG integration（`npm run test:integration`） | 同上 | 同上 | 同上 | 同上 | T02A R4 |
| backend node:test（`npm run test:backend`） | 同上 | 同上（fail-closed 注册用例） | T02C-ISOLATION-REFUSED / MISSING_TEST_URL | 同上 + t02c-instance-fixture | T02C |
| live-api（`npm run test:live-api`） | T02C_BASE_URL（仅回环）+ T02C_SCHOOL_CODE | 非零拒绝 | T02C-LIVE-API-REFUSED | 任务 harness 拉起的后端 | T02C |
| isolation 套件（jest.isolation.config.cjs） | 无 DB（纯函数/合成） | 不适用 | — | — | T02A/T02B |

矩阵还须列出：① 已废弃入口语义（`REVIEW_TEST_DATABASE_URL` → `T02C_LEGACY_DISABLED` 迁移指引）；② 已知边界（Node Socket 观测不覆盖 Prisma 原生引擎；live-api 全绿待数据契约包）；③ 各套件当前已验收计数基线（root 257/255/2/0、integration 23/23、backend 251/251/0 skip、isolation 68/68）。

## C — 核验与证据（轻量）

- 零配置拒绝冒烟（**不建实例、不连库**，真实子进程 rc 落盘）：`npm test -- --bail=1`、`npm run test:backend`、live-api 无 `T02C_BASE_URL` → 各 rc≠0 且拒绝码正确（安全日志，不含凭据）。
- 证据 `evidence/P3-W0-T02D/`：RESULT.md、COMMANDS.md、TEST_RESULTS.json、三条冒烟原始 rc/日志、输入对照、冻结 29 只读核验、`HASHES_FINAL.json`（先写完报告与矩阵再生成，排除自身，至少两次只读复验）。**不运行旧 PF `manifest-verify.mjs`**。不 commit/stage/push。过程失败原样保留。不在包外写工作记忆。

## 返回与复审

返回 STATUS（仅 T02D）、CHANGED FILES、冒烟真实 rc、输入/冻结/hash 对照、未决项与 ASTRA REVIEW HANDOFF，然后停止。GPT 复审建议 **GPT-6 Astra / Extra High（极高）**，携带最新 state、T02C 复审、本包、T02D 输入快照与完整 T02D 结果。T02D 验收后 AUD-039 正式关闭（REVIEWED_PASS_LOCAL），W1 任务包由 GPT 总控按 Phase 2 依赖图另行制定。
