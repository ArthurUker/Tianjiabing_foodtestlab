# BASELINE TEST CONTRACT — Phase 3

状态：**CURRENT_HEAD_SUITE_EVIDENCE_REVIEWED / PREFLIGHT_PASS / READY_FOR_REMEDIATION**。audit baseline=`f08e72e3e74d188b4555e0bee16280b3dd0d622b`；remediation start HEAD=`7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`；branch=`Product_tencent_CVM`。

## 最新审阅补记

最终补记（优先于以下历史补记）：[P3-PF-T01-R2 review](P3-PF-T01-R2_REVIEW.md) **PASS**。受控自测 44/44 检查，真实 v3 13-case、3 mismatches、0 执行/teardown 错误；原 suite 基线继续接受。Preflight gate 已通过，第一个任务为 AUD-044 的 P3-W0-T01。AUD-039 尚未修复；首包只允许无 DB 的受控验证，不能据此启动全部旧数据库测试。

P3-PF-T01-R1 复审：v2 正常/恢复的 13-case、三个差异、原负例及 sentinel 已接受；原 suite 不重跑。剩余 REWORK 限于实例/schema 拒绝路径、teardown 失败汇总和报告残留，见 [R1 review](P3-PF-T01-R1_REVIEW.md) 与 [第二次补丁](P3-PF-T01-R2_REWORK_PATCH_PROMPT.md)。这不撤回已接受测试基线，也不代表 AUD-039 已修复。

Astra 已从 P3-PF-T01 原始日志核验当前 HEAD：backend **190/190，0 skip**；PG integration **13/13**；root Jest **249/251**，精确两项历史 authSession 失败。该 suite 执行基线已获证，不要求重跑。另有 **3 个 delta observed mismatches**，属于当前 HEAD 已有差异，不得因套件额外失败为 0 而省略。

原文下方“未执行/未获证”等为首次 Preflight 历史状态，以本补记为准。任务整体仍需限定 REWORK（probe 错误退出、清理范围和报告边界），详见 [P3-PF-T01_REVIEW](P3-PF-T01_REVIEW.md)。Astra 未代跑测试，尚未发出应用修复 packet。

## 历史执行基线（不是当前运行结果）

来源：[VERIFICATION.md](../VERIFICATION.md)，Node.js 24.15.0 / npm 11.12.1 / PostgreSQL 18.4，隔离实例已停止。

| Suite | 历史命令形态 | 历史结果 | 当前 HEAD |
|---|---|---|---|
| backend node:test | 显式 REVIEW_TEST_DATABASE_URL，`node --test --test-concurrency=1 backend/tests/**/*.test.mjs` | 178/178，0 skip | 未执行/未获证；新增文件后计数须实测 |
| PG integration | 显式隔离 DATABASE_URL、TEST_SCHEMA、TEST_ROLE_USER，`npm run test:integration -- --runInBand` | 13/13 | 未执行/未获证 |
| root Jest | 显式隔离 DATABASE_URL，`npm test -- --runInBand` | 249/251，26/27 suites | 未执行/未获证 |
| lint | `npm run lint`（历史 build 后） | 214 errors，历史噪声 | 不是本阶段 release gate，不要求顺手清理 |

这些命令是证据契约，不是本轮向 CodeBuddy 下发的执行任务。任何执行前须先验证独立实例、专用角色/库/schema 和清理范围；不得 source 业务 .env，不得回退业务 DATABASE_URL。旧套件的隔离缺口 AUD-039 尚在，不能因为这里列出历史命令就直接运行。

## 精确 known failures

仅预先接受下列历史匹配，不接受“反正有两项失败”的数量匹配：

1. `tests/authSession.test.js:259`，`DS3-M2: 账号级失败锁定 / 窗口内失败次数达到阈值（默认 5）→ ACCOUNT_LOCKED（423）`：非 production 默认阈值 1000，测试仍按 5。
2. `tests/authSession.test.js:294`，`DS3-M3: 禁用账号登录路径（时序与记录） / 禁用账号 + 错误密码 → 与普通密码错误同样的通用报错（不泄露禁用状态）`：期望“用户不存在或密码错误”，实际“密码错误”。

它们不作为这轮前置工作的修复范围。测试文件和 auth 核心在 baseline→HEAD 区间未修改，不代表已经重新运行成功重现。若当前结果不同，必须说明差异，不修改断言凑数。

## 当前 HEAD 必需补证

- 原三套 suite 的完整运行与隔离元数据，及所有失败/skip 原因；测试选择列表不可依赖未经检查的 shell glob 遗漏新文件。
- `backend/tests/records/tableware-verdict.test.mjs`：现有 7 个顶层测试。
- `backend/tests/records/stats-verdict.integration.test.mjs`：配置存在时的 5 个测试；未配置出现一条 skip 不计 PASS。
- 差异边界：空顶层 result + 混合合格/空点位，空白顶层 result，空/全空点位；对真实 JS、SQL/统计和写入归一化核对；不把 SQL 字符串匹配当语义执行。
- 实际测试数可能高于历史数，不推算为已通过；依赖 lockfile 虽未变化，运行环境仍需记录。

## NO NEW REGRESSIONS

后续每个 task 必须对比已确认的 task-start 结果：baseline-known failures、current-HEAD pre-existing failures、new failures、环境/夹具失败、skip 分栏。任何新增失败或新增 skip 不能算无回归；历史失败改善可以记录，不要求为了维持相同计数而恢复失败。

现有 bug-exists probes 是冻结证据。修复时保留场景，另建正式 regression 并反转为正确/安全行为断言，记录来源映射；不能删除原 probe 或强迫修复后继续满足缺陷断言。probe 不适用于任务时明确 N/A 及理由。

首次制定时本契约不是已满足的门禁；当前执行证据与剩余 rework 已通过，以顶部最终补记为准。后续任务仍按本契约精确区分历史失败与新增失败。机械测试执行交 CodeBuddy，总控负责审查证据和差异决策。
