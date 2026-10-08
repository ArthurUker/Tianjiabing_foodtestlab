# CodeBuddy TASK PACKET — P3-W0-T02E（live-api 数据契约；窗口 2）

## 任务与固定边界

T02C 移交的未决项：`tests/integration/live-api.mjs` 全绿未达成——其既有前置假设（public 平台登录 + 预置学校数据）与生产 `isValidSchoolCode`（NB-04）及隔离空实例冲突。本包为其定义并实现**显式数据契约**，使 live-api 在任务自有实例上**真正全绿**。固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`；不 reset/clean/stash/stage/commit/push。

**并行通告**：P3-CONS-T01（收口+全量回归）与本包并发，其范围（4 个旧测试、5 个前端读取点、`openApiRoutes.js`、`stats-date`/`contract` 两测试）与本包**零文件交集**（快照标 `PARALLEL_OTHER_PACKET_SCOPE_DO_NOT_TOUCH`）。你的 harness 启动真实后端时，若因对方正在编辑 `openApiRoutes.js` 而启动失败：**保留原始日志原样重试一次**；不得替对方改任何文件。先读 `ORCHESTRATOR_STATE.md`、本包、`P3-W0-T02E_REVIEW_INPUT_MANIFEST.json`，只读核验本包范围。

## 允许修改（仅此）

- `tests/integration/live-api.mjs`（登录与数据准备按新契约）
- `backend/tests/t02c-instance-fixture.mjs`、`backend/tests/t02c-live-api-harness.mjs`（实例准备与 harness）
- 可在 `backend/tests/` 新建本包专用 fixture/seed 辅助；新证据只写 `phase3/evidence/P3-W0-T02E/`

保护项：`backend/server.js`、全部路由与 lib、生产 seed、`package.json` scripts 段（不新增）、三包与 W0 全部交付、冻结 29。

## 总控设计口径

1. **数据契约占位**：在实例准备阶段以管理身份建立 live-api 需要的全部前置数据——派生学校（沿用 provisioner 派生 code）、该校的管理员/操作员账号（bcryptjs，口令只经 env 传递不落日志）、平台超管（如脚本确需）；**所有登录一律显式携带 schoolCode**（public 平台登录路径不属于本契约，生产 NB-04 语义不变）。
2. **不改生产行为**：禁止为了全绿而放宽 `isValidSchoolCode`、登录路由或任何生产校验；发现 live-api 脚本语义与生产契约的根本性冲突（某用例本质上要求已被生产禁止的行为）→ 如实分栏并报告，不强行通过。
3. **清理与边界**：脚本结束后清理本脚本产生的业务数据（既有语义）；`T02C_BASE_URL` 仅回环、后端进程生命周期与端口释放核验保持（沿用 T02C harness 形态）。
4. **环境值零落盘**：口令/token 不进日志与证据（与 W0 惯例一致）。

## 退出条件

- 同一新建独占实例：fixture（含数据契约 seed）→ 启动真实后端（任务自有端口）→ **live-api 全模块用例全绿**（A–J 全数通过；若有个别用例属生产契约冲突则如实分栏并给出代码级证据）→ 停止后端、端口实测释放 → after-check（契约占位数据 vs 脚本数据可区分、无越库写入）→ down 三条件。
- 负例保持：无 `T02C_BASE_URL` / 非回环 → 真实 rc=1（不回归）。
- 证据 `evidence/P3-W0-T02E/`：RESULT.md、COMMANDS.md、TEST_RESULTS.json、逐入口 rc/原始日志（脱敏）、数据契约清单（seed 了什么、为什么）、after-check、instance-registry、输入对照（本包范围 + 兄弟 drift 豁免）、冻结 29 只读核验、`HASHES_FINAL.json`（两次只读复验）。不运行旧 PF 校验器。

## 返回

STATUS（仅 T02E）、CHANGED FILES、真实 rc、live-api 用例计数与分栏、数据契约说明、hash/Git、未决项、ASTRA REVIEW HANDOFF，然后停止。
