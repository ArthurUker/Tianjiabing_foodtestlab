# R11 接力 prompt：按闸门发给原窗口，不新开五个实施窗口

共同读序：`docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md` → `docs/AI_review/Codex-GPT6/P3-PARALLEL-R11_REVIEW.md` → `phase3/REVIEW_LOG_MASTER.md` §0/§4 → 本窗口旧包。保持未提交工作树，不 reset/clean/stash/checkout，不 stage/commit/push/真实部署；每包独立证据、真实 rc、输入漂移归因、冻结 29 只读、HASHES 双复验与实例 down。

## 现在发给窗口 1：P3-FIXTURE-MIGRATED-R3-14CHAIN

> 执行 `P3-FIXTURE-MIGRATED-R3-14CHAIN`，仅做新链补证。先逐项核对 `P3-PUBLIC-INFRA-FOLLOWUP-R1/CHAIN_TAIL_LOCK.json` 的 **14 文件**与当前 SHA（digest `4e8595bb03f228e747ef3b302ea4b16d07725c4b5043ed4988f47b3c432fda22`），确认窗口 2 `STOP_SIGNAL.md`。原 `P3-FIXTURE-MIGRATED-R2` 的 13 链证据与 HASHES 原样保留，不覆盖旧日志。用**全新自有隔离实例**按实测正确顺序运行：`provision up → t02c fixture → live-api 49（此时仅学校 A、guest_enabled 尚未由报告 fixture 开启）→ 学校 B 回放/后授 GRANT → report-auth fixture → isolation 68 → T02A/业务隔离 27 → report-auth 20 → session 12 → db:sync --check`。全部 0 skip；逐步核对 14/14 台账、public FieldOption FK、`skipped_public_only`、readiness=200、真实租户 API 与链上吊销形状；记录执行前/后 migration digest 与 `publicInfraShape.js` hash，兄弟窗口不得同时改链/client。若 14 链下某入口计数变化，列出确切原因；失败留原始 rc 并只修本包授权 fixture/harness 面，不放宽产品闸门。收尾 down、输入归因/冻结/HASHES 双复验并**明文停止编辑和测试**。该停止信号经总控核验后，窗口 3 才编辑 schema/client。

## 窗口 1 停止后发给窗口 3：P3-LIFECYCLE-AB-R3

> 续作 `P3-LIFECYCLE-AB-R2`，任务名 `P3-LIFECYCLE-AB-R3`。先读其 `PLAN_A_R2.md`、`CLIENT_STRATEGY_R2.md`、`MAPPING_DELTA_R9.md`、R11 总控审阅，核对公共链 14 文件锁及窗口 1 的 14 链补证停止信号。此后你是**唯一**生命周期 `schema.prisma`/新 migration/Prisma client 所有者；新 migration 只能追加在 `20260927120000_public_infra_field_option_self_fk` 之后，旧 14 文件不改。正式授权所需的最小跨面：`backend/routes/auditRoutes.js` 审计筛选双来源、`backend/tests/http/openapi-http.integration.test.mjs` 的 grant 直建身份字段、`tests/auditUserFilter.test.js` 的旧场景保持与溯源更新；`openApiRoutes.js`/`adminOpenApiRoutes.js` 只改 grant 身份判定相关 hunk，W5 遗留只读分叉按快照保护。任何其它跨面先在 RESULT 登记精确行区，不自行扩张。
>
> **选双产物方案 (i)**：Release A 用 nullable schema/client、M1 expand 与新写入 `CHECK ... NOT VALID`，先独立快照+PG 正反例；Release B 分 B1(A 版 client 产物 + 004/M2 migration + 全租户 G2/G7/G8 只读门禁) 与 B2(B required client 产物，只有门禁全绿才生成/激活)，回退重新部署 A client 产物而不逆转 DB 的 NOT NULL。`deploy.sh` 本轮不改；必须用两份可核的产物/补丁/manifest 证明实际生成顺序与门禁，不以计划文字或最终工作树同时含 A/B 文件冒充滚动演练。历史主体仅稳定 id 或独立可审映射证据可绑定，username-only 一律拒绝；无主体且无快照才落 system principal。分别验证 active/disabled/新校、旧审计读取、grant 缺身份及同 code 重建 fail-closed、W1 epoch 同事务、恢复 staging 单次 align 保旧、A/B client 正反用例；受保护场景保留并注释溯源。若实际部署接口/产物无法安全满足 B，明确 B blocker，但仍完成可独立验收的 A。禁全套件、真实部署、提交；收尾各阶段 rc/hash/实例 down，明文释放 migration/client 面给窗口 4。

## 已有窗口 4、5：沿用原任务，不重发实施信号

- 窗口 4 的注册来源与审计原子性已本地通过；**双实例真实恢复**等窗口 3 释放 migration/client，再按 `P3-W3-R2-CROSS-PLAN-R4/TEST_PLAN_R4.md` 和其 R2 `STOP_SIGNAL.md` 执行。
- 窗口 5 的离线入口/逐文件枚举已完成，unit 本轮复核 28/285 全绿；**单实例单次全量回归**等窗口 1–4 停止并经总控核验后最后独占执行。

窗口 4 可继续无链写入的离线准备，窗口 5 可只读核对新增测试收录；它们的动态阶段不能与窗口 3 迁移/client 编辑同时进行。
