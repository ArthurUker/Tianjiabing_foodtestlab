# R10 并发执行后的补充指令（2026-09-27）

发给原窗口即可；不需要再同时开五个新窗口。先读 [并发补充裁决](../../../AI_review/Codex-GPT6/P3-R10_CONCURRENT_EXECUTION_REVIEW.md)。以下更正 R10 原 prompt 的入口顺序，并闭合 CLOSE-B 发现的认证离线替身缺口。

## 给窗口 2：补完公共链 follow-up，并承担认证 unit 替身适配

> 窗口 1 `P3-FIXTURE-MIGRATED-R2` 已明文停止；请继续 `P3-PUBLIC-INFRA-FOLLOWUP-R1` 原任务，独占追加前向 FieldOption FK 修复 migration，旧 13 文件保持逐字节不变；完成空/旧/重复回放、租户 public-only 投影、索引失效负例、R6d 两分支与最终 `--check`，锁定新链尾 hash，实例 down。另授权**仅测试层**修 `tests/refreshConcurrencyBackend.test.js`、`tests/authRecheckFailover.test.js` 的 Prisma 替身：参照已适配的 `tests/authSession.test.js`/`tests/securityRegression.test.js`，使其对 `publicInfraShape.js` 的 pg_catalog 表/主键/三索引查询返回符合链上契约的真实形状，保留原 12 场景与业务断言；独立负例断言形状缺失仍为 `AUTH_INFRA_MISSING` 503。禁止给产品增加 unit 豁免、降低 fail-closed、或将两套离线测试挪到 DB 入口。逐项跑两文件与 `npm run test:unit`，0 skip、原始 rc/log、受保护断言如需更新须溯源且场景保留。最后明文停止编辑和测试并给新链尾 hash；总控复审前窗口 3 不编辑 schema/client。

## 给窗口 1：新链尾锁定后的链依赖补证

> 等窗口 2 `P3-PUBLIC-INFRA-FOLLOWUP-R1` 停止且总控核验新链尾 hash 后，执行 `P3-FIXTURE-MIGRATED-R2` 的**补证**：在新自有实例用新链重跑 `provision up`、t02c fixture、`--check`、readyz/租户 API、受前向 migration 影响的 live-api/fixture 定点，并在执行前后记录链与 `publicInfraShape.js` hash。沿用已证实顺序：**provision→t02c→live-api→学校 B→report-auth fixture→isolation/integration/report-auth/session**；若只做受影响子集，列明未重跑项为何不受影响。原 13 链 9/9 证据保持原样，不覆盖旧日志。收尾逐入口 rc/0 skip/实例 down/HASHES 双复验，并明确停止。

## 给窗口 3：保持当前门禁

> `P3-LIFECYCLE-AB-R2` 的只读准备可保留。窗口 2 未给最终新链尾 hash 与停止信号、窗口 1 未完成新链补证前，继续不编辑 schema/migration/client。两条件满足并经总控复审后按原 A/B 实施任务执行；B 双产物或脚本两段由实施证据证明，不以计划文本代替。

窗口 4 双实例恢复仍等窗口 3 释放 migration/client；窗口 5 全量回归仍为最后独占。CLOSE-B-R2 记录的 isolation 2 失败已在当前工作树复核为 68/68 通过，不再作为当前 blocker；认证 unit 10 失败仍待窗口 2 修。
