# P3-W0-T02C — Orchestrator review

日期：2026-09-25。裁决：**PASS（T02C 验收通过）**。**AUD-039 升级为 REMEDIATED_LOCAL / PASS**（本地验收，未提交/部署；正式关闭以 T02D 最终入口矩阵为收尾件）。AUD-044 维持 REMEDIATED_LOCAL / PASS。总控只读复核限定代码、结构化结果、原始日志、实例登记与 hash，未代跑测试/PostgreSQL，未修改应用或测试。

## 独立核验记录

- **Git**：HEAD `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`（始末一致）、branch `Product_tencent_CVM`、index 空。
- **输入快照**：522/522 独立复算 —— 512 未变 + **10 变化全部命中授权**（9 `T02C_ALLOWED_CHANGE` + 1 `T02C_SCRIPTS_SECTION_ONLY`）、0 越权、0 缺失。
- **package.json**：diff 仅在 scripts 段。一处是对既有 `test:backend` 的**修改**（旧值 `jest backend/**/*.test.js` 为失效 glob，新值 `node --test --test-concurrency=1 backend/tests/**/*.test.mjs`），超出任务包"新增"字面但仍在 scripts 段政策内且已在 RESULT 披露；记录在案，如需严格"只增不改"可后续更名另设。
- **冻结 29 文件**：只读校验器 **29/29 ALL_MATCH**；**R2 输出 hash 54/54** 独立复算通过。
- **原始 rc**：backend-full=0、backend-refusal-noconfig=1、live-api-refusal-nourl=1、live-api-refusal-external=1、t02c-live-api-harness=0、root-full=1、pg-integration=0、provision up/down=0、t02b-fixture-run=0、t02c-instance-fixture=0 —— 与报告逐项一致。

## 关键判别核验

1. **薄桥接真实**：`backend/tests/_isolation.mjs` 经 `createRequire` 调 `tests/helpers/db-isolation.cjs` 同一实现，无第二份门禁；旧符号 → `T02C_LEGACY_DISABLED` 迁移指引，且有测试断言错误信息**不回显连接串/凭据**。`loadIsolation()` 在配置校验通过后**显式**设 `process.env.DATABASE_URL`（非回退语义，与 T02A 一致）。6 个 DB 套件均注册 fail-closed 拒绝用例（未配置 → `assert.fail` → 文件 rc≠0）；拒绝运行实测 rc=1（纯函数套件 9 pass + DB 拒绝 1 fail）。
2. **backend 251/251/0 skip**：原始日志 tally 确认。**计数精确对账**：190（PF 基线，显式 17 文件清单、设 `REVIEW_TEST_DATABASE_URL` 真实运行，见 `P3-PF-T01/COMMANDS.md` 与 `backend-node-test.log` 中 HTTP 真实登录用例）+ 4（`isolation-gate` 5→9）+ 57（W0-T01 新增的三个 security 套件 `deploy-jwt-roundtrip`/`jwt-secret-config`/`startup-jwt-guard`，不在 PF 显式清单内）= 251。**无既有用例丢失、0 新失败、0 skip**。
   **更正（总控登记，不改旧文件）**：RESULT.md 与 TEST_RESULTS.json 把 +61 归因为"DB 套件由 skip 改为真实运行（原基线中这些套件处于 skip 形态）"——**不成立**，PF 基线中 7 个 DB 套件是真实运行的；正确归因如上。下一包以追加索引方式更正。
3. **root Jest 不劣化**：257/255/2/0，失败恰为 `authSession.test.js` 两项、失败帧 `:259:11` / `:294:5`；p0 11/11 全 passed。PG integration 23/23。两者与 backend 全量在**同一实例**、权限放宽之后运行，门禁关键不变量（marker 契约）由 after-check 实证。
4. **live-api 边界与如实分栏**：两条拒绝负例真实 rc=1（无 URL / 非回环 `10.0.0.9`）；harness 实测后端拉起（55542）→ 健康 200 → 运行 → 停止 → 端口释放。执行失败 `400 非法学校代码` 与生产 `isValidSchoolCode`（NB-04）一致，属脚本既有前置假设（依赖预置开发库），**非本包迁移引入**，报告未宣称全绿 —— 接受该分栏。
5. **同实例链**：单一实例 `t02cf16070d0`（55541）up → fixture → backend 全量 → live-api → after-check（`derivedMatches=true`、marker 值=实例 tag、School 仅派生 code、messages/revoked_tokens owner 正确）→ status（ownEvidence=true）→ down 全 true、`residue=false`。总控实测 55541/55542 当前无监听、无残留进程。
6. **权限放宽（已披露的未决项③）**：实例准备 harness 以管理身份对测试角色授 public 业务表 DML 与 `CREATE ON SCHEMA public`（仅本实例）；marker 在授权**之后**重建并 `REVOKE ALL`+`GRANT SELECT`，`has_table_privilege` 四项写权限实测全 false。门禁验收要件未被削弱；该放宽随实例销毁。后续涉及 backend 业务套件的包应把该权限模型纳入 provisioner 契约复审（登记，不阻塞）。

## 非阻塞观察（不 reopen）

1. 过期注释：`db-integration.test.mjs` 头注仍写"未设置则整体跳过"（现为拒绝）且示例路径误作 `node --test tests/records/...`；`live-api.mjs:315` 注释仍提 `sysdynit`（代码已用派生 `DYN_SCHOOL`）。下一包顺手更正（仅注释）。
2. `/tmp` 留有执行期 scratch（`t02c-harness-fix.py`、`t02c-noconfig.log`），在系统临时目录、不含凭据，登记不清删。

## 结论与下一步

- **T02C PASS**；**AUD-039 = REMEDIATED_LOCAL / PASS**（本地验收；正式关闭件 = 最终入口矩阵）。W0（AUD-044 + AUD-039）本地目标达成，未提交/部署/现网验证。
- 唯一下一任务包：**P3-W0-T02D**（AUD-039 收尾：最终统一入口矩阵 + 上述追加更正索引 + 注释更正；纯文档/核验，不改应用逻辑）。其后 W1（AUD-010/012/014/015/016 身份/会话失效模型统一）的任务包由 GPT 总控依 Phase 2 依赖图另行制定；AUD-040 维持 NOT_STARTED。
- 未重开严重度裁决；三个餐具 delta 观察不变。
