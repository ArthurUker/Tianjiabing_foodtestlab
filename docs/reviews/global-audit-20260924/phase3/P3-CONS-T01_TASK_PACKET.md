# CodeBuddy TASK PACKET — P3-CONS-T01（并行轮次 1 收口 + 全量回归；窗口 1）

## 任务与固定边界

并行轮次 1（W3/W4/W5-T01）三包总控均裁决 PASS（见 [P3-PARALLEL-R1_REVIEW.md](P3-PARALLEL-R1_REVIEW.md)）。本包做两件事：① 按总控裁决落实**收口清单**（4 项编辑）；② 在**单台新建独占实例**上做**全量回归**并建立新基线。固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`；不 reset/clean/stash/stage/commit/push。

**并行通告**：P3-W0-T02E（live-api 数据契约）与本包并发，其范围仅 `tests/integration/live-api.mjs` 与 `backend/tests/t02c-*`，快照标 `PARALLEL_OTHER_PACKET_SCOPE_DO_NOT_TOUCH`；它的 harness 会启动真实后端——若你正编辑 `openApiRoutes.js` 导致其后端启动失败，属已知窗口期，对方会保留日志重试，你**不得**替它改任何文件。先读 `ORCHESTRATOR_STATE.md`、并行轮次 1 复审、本包、`P3-CONS-T01_REVIEW_INPUT_MANIFEST.json`，只读核验本包范围。

## 允许修改（仅此）

1. `backend/tests/openapi/contract.test.mjs` **仅 :185-186 两条断言**：按总控裁决改为新口径——`深绿色+合格→unknown`、`foo+不合格(>0.25)→unknown`；保留场景与注释（注明：原断言编码 AUD-025 审定的 fail-open 回退，2026-09-17 部分修复的残留；反转由 P3-W5-T01 承接）。
2. `backend/routes/openApiRoutes.js` **仅 `:600-615` 统计 SQL 区**：oil 分支改调 `backend/lib/conclusionVerdict.js` 的同一判定源（`oilVerdictSql()` 或其等价 CASE），与四出口逐字一致。
3. `backend/tests/openapi/stats-date.integration.test.mjs`：`RC-stats-4` 期望随口径修正（pass 2→1，按实测），注释溯源。
4. `tests/uploadQueue409Recovery.test.js`、`tests/storageApplyServerRecord.test.js`、`tests/storageDurabilityAndRace.test.js`、`tests/storageForceServer.test.js`：按 probe 契约更新——**保留场景文件**，断言反转为新语义（409 不自动重放 / `cache_v2` 作用域键），注释记录来源映射（原缺陷B probe / 旧键契约 → w4 套件承接正式 regression）。
5. `frontend/js/modules/Dashboard.js`、`frontend/js/modules/GenericTest.js`、`frontend/js/modules/Tableware.js`、`frontend/js/main.js`、`frontend/js/utils/SampleDataGenerator.js`：5 处旧键（`cache_<table>`/`pending_<table>`）直读 → 改用 `StorageService#getStorageKeys()` 的作用域键（只改读取键来源，不改其它逻辑）。
6. 新证据只写 `phase3/evidence/P3-CONS-T01/`；可在 `backend/tests/` 新建本包专用 harness。

保护项：`backend/server.js`（屏障挂载已裁决**挂起到 W1**）、`deploy/`、三包已交付代码（含 `recordRoutes.js`、`conclusionVerdict.js`、`Storage.js`、`backupJobs.js` 等——**本包不改它们**，发现缺陷只能报告）、W0 全部、冻结 29。

## 全量回归（收口编辑完成后，同一新建独占实例）

up → fixture（复用 `t02b-root-fixture` / `t02c-instance-fixture` 既有准备链）→ 依序：
1. root Jest `npm test -- --runInBand`（预期：历史 2 项 authSession 不变；**新基线实测**——计入 `w5OutputEncoding` 等新增用例；4 个被更新测试通过）。
2. PG integration `npm run test:integration`（23/23 不劣化）。
3. backend node:test `npm run test:backend`（**新基线实测**——计入 w3 23 + w4 23 + w5 13 等新套件；contract/stats-date 更新后通过）。
4. isolation 套件（68/68 不劣化）。
→ after-check（runId/库/端口一致，sentinel/admin/School/任务行核对）→ status → down（三条件）。

分栏报告 baseline known / preexisting / new failures / skips；任何新失败=REWORK 信号，不得放行。全过程若发现 W3/W4/W5 交付代码的真实缺陷，**不就地修**，记录为 DEFECT 报告交总控。

## 证据与返回

`evidence/P3-CONS-T01/`：RESULT.md、COMMANDS.md、TEST_RESULTS.json、逐入口 rc/原始日志、结构化 JSON、after-check、instance-registry、输入对照（本包范围 + 兄弟 drift 豁免）、冻结 29 只读核验、`HASHES_FINAL.json`（先报告后生成、排除自身、两次只读复验）。不运行旧 PF `manifest-verify.mjs`。返回 STATUS、CHANGED FILES、全量 rc、新基线计数表、hash/Git、DEFECT（如有）、未决项、ASTRA REVIEW HANDOFF，然后停止。
