# P3 R16：生命周期 R6 与双实例恢复限定复审（2026-09-27）

## 裁决与接力

**P3-LIFECYCLE-AB-R6：PASS_LOCAL_SCOPE。P3-W3-CROSS-RUN-R1：PASS_LOCAL_SCOPE。** 两包均未构成发布或全量回归验收。窗口 3、4 已停止，固定 16 文件链与 B client 未漂移；允许窗口 5 开始独占的单实例全量回归，但须先修复本轮独立复核发现的测试入口漏收录。`deploy.sh` 接入两段发布、真实部署与回退仍未放行。

## 本轮独立复核

- R6 `HASHES_FINAL.json`：**56/56 ALL_MATCH**；W3 CROSS：**156/156 ALL_MATCH**；冻结证据 **29/29 ALL_MATCH**；HEAD 仍为 `7343a8a9f8fc28b7ef2a6bad2b22c701b2fbf9e7`，工作树存在有意未提交的多包变更。
- 当前离线 `npm run test:unit -- --runInBand`：**28 suites / 286 tests / 0 skip，rc=0**。这只复证离线 unit 面。
- 当前 `npm run test:entry-audit`：**rc=1**，G3 报 `backend/tests/harness-check/revocation-contract.unit.test.cjs` 未被任何入口覆盖；backend runner 只枚举 `*.test.mjs`。独立单跑该文件 **7/7、0 skip、rc=0**，因此缺口是入口收录而非用例失败。旧 R2 的 23/23 是旧文件集时点，不能据此放行当前全量回归计数。该 CJS 文件是 `node:test` 真用例，不能登记成 known-non-entry。
- R6 源码 `004_backfill_audit_principals.mjs`：映射绑定在事务内重读原始行，并与证据 `pre.user_id`、完整快照摘要比较；`AuditPrincipal` 建档与带原始值条件的 UPDATE 同事务，UPDATE 影响 0 行抛错回滚。真实交错①跨会话、交错②同事务注入均在证据中明示；后者**不是第二个独立会话交错**。机制与 R15 缺陷闭合，但不得将证据写成“两次跨会话交错均已完成”。逐行事务不保证 `--all-tenants` 全批回滚；R6 已如实限定。
- W3 CROSS 的 A/B 物理隔离、旧备份 `UNPROVABLE` 保旧、链末人工修复后 `baseline-plan/apply`、产品 `006` 外部注册、真实 `restoreService` 重复恢复、16/16 台账、ACL 基线下界、006 门禁、readyz=200 与租户 API 200 均有逐段原始证据。`004` 唯一输入漂移来自并行 R6，CROSS 未调用。

## 证据边界与剩余风险

1. W3 CROSS 的 C6c 是**人工注入** `baseline_pending` 后证明 `--check` 阻断和 apply 拒绝；并未在此包制造真实 postcheck 失败。真实 postcheck 失败及非终态留痕的判别仍引用 W2-T02-R6 的原始实例证据，不能把 W3 CROSS 单包写成该路径全覆盖。
2. 本次恢复的租户 schema **序列数为 0**，因此受限角色序列 USAGE 是 **N/A**。W3-R2 单独的序列 grant-option 反例可保留，但不得把此次恢复样本声称为序列权限联测通过。
3. W3 CROSS 首次应用角色权限不足，执行者用 `sql/B-grant-*.sql` 补授权后才得到 readyz/API 200。这说明产品在**补授权后的权限前提**下可用，不能证明生产部署脚本自动满足该前提。窗口 5 的 fixture 必须把回放后授权作为显式合同并留逐语句证据；若依赖手工临时 SQL 才绿，登记发布/fixture blocker，不给产品加白名单或放行开关。
4. R6 交错②虽覆盖条件 UPDATE 影响 0 行及主体回滚，却使用同一事务测试 hook。窗口 5 的最终回归结论前须增加真正双会话版本：竞争会话把待绑定行的 `principal_id` 改为**合法已有主体**并改变快照，满足 A 期 CHECK，再证明旧映射不覆盖竞争写入且新建主体回滚。此为证据补强；窗口 5 开工前不要求改 004 产品代码。

## 窗口 5 启动条件

R6 与 W3 CROSS 已停止，迁移链与 B client 固定，因此**发出 P3-CLOSE-B-R3 单实例全量回归信号**。第一步在窗口 5 自有 runner/config 面修 G3 漏收录，复跑 `test:entry-audit` 至全绿并打印最新逐文件清单；然后以新实例按 migration-first、默认 `AUTO_SYNC_TENANTS=check` 运行全部入口。失败必须按产品/fixture/入口归属分栏，不能删测试或跳过凑绿。全量通过后才讨论发布侧 `deploy.sh` 两段接线、授权合同与真实部署/回退。
