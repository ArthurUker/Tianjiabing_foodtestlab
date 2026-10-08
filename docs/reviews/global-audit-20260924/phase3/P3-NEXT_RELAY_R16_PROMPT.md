# R16 下一棒：P3-CLOSE-B-R3 单实例全量回归

下面整段可直接复制给窗口 5。只发这一窗；发布/部署任务待其结果复审后再发。

```text
执行 P3-CLOSE-B-R3（AUD-040 入口收口 + 独占单实例全量回归）。总控 R16 已放行窗口 5；窗口 3 R6、窗口 4双实例恢复均已明文停止。先读 docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md、docs/AI_review/Codex-GPT6/P3-R16_LIFECYCLE_CROSS_REVIEW.md、evidence/P3-CLOSE-B-R1/COMMANDS.md 的全量回归段、evidence/P3-CLOSE-B-R2/{ENTRY_MATRIX.md,BLOCKERS.md}、evidence/P3-LIFECYCLE-AB-R6/RESULT.md 与 evidence/P3-W3-CROSS-RUN-R1/RESULT.md。新证据只写 evidence/P3-CLOSE-B-R3/；旧包和 HASHES 不改。

先做输入固定：HEAD/branch/index、工作树、冻结 29、16 migration 逐文件 hash 与产品 migrationChainDigest（预期 03993cf97a08c59df9a9620d64154560219ac5d773a59e3c6799d6fb61324e65）、M2 sha ad389937e7a6f63a334e110da8c300befa8694d3b2ee25dbd1fa54f6ea59c1a4、B client index.js sha d8a10fd1…、004/restore/tenantProvisioner hash、所有测试入口清单。若链/client/产品关键面在运行中漂移，停止并报告，不拼接绿链。

第一道硬门禁：当前 npm run test:entry-audit 实测 rc=1，G3 漏收录 backend/tests/harness-check/revocation-contract.unit.test.cjs（它是 node:test 真用例，7 项）。在窗口 5 独占的 tests/runners/{entry-sets.cjs,run-backend-tests.mjs,audit-entry-coverage.mjs} 范围做最小修复，使 backend 递归入口同时收录 *.test.mjs 与这个 *.unit.test.cjs（以及同类新文件）；不得把它登记为 known-non-entry、删文件、改名或添加 skip。更新入口审计的声明清单/计数，先单独运行此 CJS 测试，再跑 test:backend --list-only 与 test:entry-audit；要求所有测试文件至少被一个正式入口覆盖，root 的 unit/db 分类互斥，审计全绿。把修复前 rc=1 与修复后原始日志都留档。

随后独占一个全新隔离 PG 实例，使用 runId 派生的 fixture schema；严禁 db push、--accept-data-loss、migrate resolve、TENANT_READINESS_ATTESTED、AUTO_SYNC_TENANTS=false、旧 public/school 合成 messages。前置顺序：provision up（public migrate deploy）→ 按产品入口逐校回放当前 16 链 → 回放后按已交付 fixture 合同授应用角色必需的 public/tenant/revoked_tokens DML 与序列权限 → db:sync --check rc=0 → 默认 check 启动，readyz=200 且真实租户 API 可达。逐项记载 GRANT 的来源和结果；若只有临时手写 SQL 才能放行，先记为 fixture/发布授权 blocker，不能把它写成产品自动授权已通过，也不能给引擎加白名单或假放行开关。

按 P3-CLOSE-B-R1/COMMANDS 与 R2/ENTRY_MATRIX 的 S0–S8 运行：root DB Jest、离线 unit、integration、isolation、live-api、report-auth、session、一次 npm run test:backend（用修复后的递归清单）。注意已证实的顺序依赖：live-api 在 report-auth fixture 与学校 B 业务写入之前；学校 B 准备后再跑 report-auth。具体脚本参数从现有 COMMANDS/fixture 原文核对，不盲用历史 11/13/14 链计数。逐入口保存真实 rc、文件数/执行数、pass/fail/skip、首错及归属；skip 必须 0。DB 入口缺 TEST_DATABASE_URL/context 必须非零且 0 tests；仅 DATABASE_URL 不得回落；unit 离线可跑；frontend 无文件必须 fail-closed。测试失败按 known/preexisting/new/skips 四栏，不修改产品面或受保护测试来凑绿；需要产品修复时停止该项并交还归属窗口。不要以旧 270/310 或 R2 的 backend 43 文件时点计数代替当前清单。

补充覆盖边界：本次跨实例恢复序列数为 0，序列 USAGE 不能算它已通过；C6c 在 W3 包仅注入 baseline_pending。全量结果要分别引用 W3-R2 的序列 grant-option 独立测试、W2-T02-R6 的真实 postcheck 失败证据；若本轮入口已包含相关定点，逐文件对账。004 的 R6 第二交错是在同一事务内注入，不能写成双独立会话。最终 PASS_LOCAL_REGRESSION 前必须在专用证据脚本中补双会话版本（竞争会话给行设置合法已有主体并改变快照，以满足 A 期 CHECK；验证旧映射拒绝、竞争写入保留且无新孤立主体），不改 004 产品代码；若结果推翻原子性，立即停止全量结论并返还窗口 3。

完成后复跑 db:sync --check、006_audit_principal_gate、readyz 与真实租户 API，复核 HEAD/index/输入 drift/冻结 29/git diff --check；实例 down、端口/进程/SQL 会话无残留、仓外密钥删除；HASHES_FINAL 双独立复验。若全部入口与计数对账全绿，报告 PASS_LOCAL_REGRESSION（仅本地，不等于部署）。明确哪些环境授权由 fixture 完成、哪些仍须部署侧接线。未 stage/commit/push、未部署，不 reset/clean/stash/checkout。收尾明文停止并给总控回执；发布/真实部署任务等下一轮裁决。
```
