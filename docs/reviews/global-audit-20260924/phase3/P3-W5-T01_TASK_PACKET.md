# CodeBuddy TASK PACKET — P3-W5-T01（并行包 C：输出编码与结论归一，RC-05+RC-09）

## 任务与固定边界

修复 **AUD-003**（存储型 XSS 面，CONFIRMED_P1）与 **AUD-025**（油脂未知 colorLevel 判合格，FINAL_P2）。依据：`phase2/ROOT_CAUSE_MATRIX.md` RC-05、RC-09；`phase2/FINAL_SEVERITY_ARBITRATION.md` AUD-025；`phase2/BATCH-C-VERIFICATION.md`。

**⚠️ 并行执行**：本包与 P3-W3-T01、P3-W4-T01 在**同一工作树**并发执行。规则：
1. 只改本包授权文件与新建文件；兄弟包文件绝不修改/还原（快照已标 `PARALLEL_OTHER_PACKET_SCOPE_DO_NOT_TOUCH`）。
2. **共享文件** `backend/routes/recordRoutes.js`：**只许改 `:1-300` 的统计 SQL/判定区**（AUD-025 内部统计出口）；**`:480-末尾` 的 sync/409 区属 P3-W4-T01**，`:301-479` 缓冲区谁都别动。每次编辑前重读、定点替换、**绝不整文件重排**。
3. **禁止运行全套件**；只跑本包定点测试。不 reset/clean/stash/stage/commit/push。固定 HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`、branch `Product_tencent_CVM`。
4. 先读 `ORCHESTRATOR_STATE.md`、本包、`P3-W5-T01_REVIEW_INPUT_MANIFEST.json`（616 项）；非兄弟、非授权 drift 先报告。

## 允许修改（仅此）

- `frontend/js/modules/GenericTest.js`、`frontend/js/modules/Pathogen.js`（innerHTML 注入面）
- `frontend/js/modules/Dashboard.js`、`frontend/js/modules/GuestDashboard.js`（结论显示出口）
- `backend/lib/recordNormalize.js`（`:349-361` colorLevel 校验缺失）
- `backend/routes/guestRoutes.js`（`:223` 访客统计 SQL）
- `backend/lib/openApiFieldSchema.js`、`backend/lib/openApiScope.js`（OpenAPI 枚举出口）
- `backend/routes/recordRoutes.js` **仅 :1-300**（内部统计 SQL 出口）
- 可新建：前端共享输出编码 helper（如 `frontend/js/core/domSafe.js`）、后端共享判定 helper（如 `backend/lib/conclusionVerdict.js`，导出 `normalizeConclusion`）；本包测试 `tests/w5-*.test.js` 或 `backend/tests/verdict/`；新证据只写 `phase3/evidence/P3-W5-T01/`

**明确禁止**：不碰 `backend/lib/tablewareVerdict.js` 与三个餐具 delta（C02/C03/C04 登记观察）；不改 schema；不做页面级 CSP（依赖内联事件清理，属更大改造）；不改认证/授权。

## 总控设计口径（源自 RC-05/RC-09，不另行发挥）

1. **统一输出编码边界**（AUD-003）：数据 → DOM 收敛到共享 helper——文本一律 `textContent`/安全绑定，属性用 DOM API 赋值；消灭 `innerHTML` 直拼业务字段（`GenericTest.js:1332/1345-1347/350-352`、`Pathogen.js:1181` 等）；不再新增第 8 份 `escapeHtml` 分叉（NF-C-02），统一收编到新建 helper，既有分叉可保留但新代码只用共享 helper。
2. **结论唯一事实源**（AUD-025）：新建 `normalizeConclusion(type, payload)`——合法非空 colorLevel 仅 `合格/警戒/不合格`（警戒计入合格为既有口径，保留）；**未知非空值一律 unknown/不计入合格**；空值按 result 规则回退。四个出口（内部统计 `recordRoutes.js:161-189`、访客统计 `guestRoutes.js:223`、OpenAPI 枚举、前端 Dashboard/GuestDashboard）全部改调同一 helper 或其 SQL 等价物，口径逐字一致；写入侧 `recordNormalize.js` 对未知 colorLevel 不再静默放行（按既有写入风格处理：拒绝或归一，记录选择及理由）。
3. **历史口径**：统计口径变化在 RESULT 中明确说明（已知：此前含未知值的统计会失真；不重算历史、不改已发布报告）。

## 退出条件

- 定点测试：① 判定矩阵（合法三值/未知非空/空值回退/result 冲突）× 四出口一致（同一输入四出口同结论）；② 注入回归覆盖**列表 + 详情 + 导出预览**三类 sink（属性闭合、引号闭合、编码变体）；③ 既有 `backend/tests/records/stats-verdict.integration.test.mjs`、`tableware-verdict.test.mjs`（餐具语义**不得变化**）与 openapi 相关定点套件通过——既有断言若与新口径冲突，**先报告**（可能是既有 bug-exists probe，按契约另建 regression 反转，不删原 probe）；④ 未知 colorLevel 经 API 写入后的统计正例（unknown 不计合格）。
- 逐入口真实 rc/原始日志；证据 `evidence/P3-W5-T01/`（RESULT/COMMANDS/TEST_RESULTS/输入对照/冻结 29 只读/HASHES_FINAL 两次复验）。不运行旧 PF 校验器。**不跑全套件**，RESULT 明确「全套件回归留待三合一轮次」。

## 返回

STATUS（仅 W5-T01）、CHANGED FILES（含 recordRoutes.js 行区声明）、定点 rc、判定矩阵与注入回归证据、既有断言冲突（如有）、hash/Git、DESIGN BLOCKER（如有）、未决项、ASTRA REVIEW HANDOFF，然后停止。
