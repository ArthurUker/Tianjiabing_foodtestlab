# R15 下一棒：窗口 3 限定 R6 + 窗口 4 双实例恢复

两份任务可同时发放；各自独立实例、独占文件面。窗口 5 全量回归继续 HOLD。

## 给窗口 3：004 并发陈旧绑定限定 R6

```text
执行 P3-LIFECYCLE-AB-R6（仅 004 并发陈旧绑定返工）。先读 docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md、docs/AI_review/Codex-GPT6/P3-LIFECYCLE-AB-R15_REVIEW.md、R5 RESULT/TEST_RESULTS 与 backend/scripts/004_backfill_audit_principals.mjs。旧 R5 证据/HASHES 原样保留；新证据写 evidence/P3-LIFECYCLE-AB-R6/。开工固定 16 文件链摘要 03993cf97a08c59df9a9620d64154560219ac5d773a59e3c6799d6fb61324e65、M2 sha ad389937…、schema/client hash、HEAD/index、冻结 29。

只修 004 与专用测试：当前 pre 校验在第一次读取，绑定 UPDATE 却只比对第二次读取的值。让绑定的最终判据与映射证据 pre 同源；预校验后、第二次读取前若 actor_snapshot 改变，必须拒绝，不能绑定旧主体。主体 upsert 与绑定放在同一事务或等效原子边界，UPDATE 0 行时不得留下新主体。保留必填 pre、整快照摘要、稳定 user_id/快照优先、已绑定同主体幂等/异主体拒绝及两租户同 audit_id 隔离；不按 username 猜测。

用自有 PG 实例做可控制的真实交错：T1 预校验通过→另一会话改 username-only 快照→004 重读/绑定；以及 004 重读→另一会话改快照→条件 UPDATE。两种均须非零且目标审计行、新主体前后指纹一致；再测无竞争正例与同映射重跑。若 --all-tenants 不能保证全批事务原子性，只声称已证明的逐行/逐校边界并在 RESULT 明示，不能再写“任何失败整体零写入”。不为测试加生产放行开关。复跑 R5 映射 7 项、R4 受影响映射项与 B 23 项；源码未动的 A/Jest/OpenAPI 用 hash 归因即可。0 skip，逐入口 rc，冻结 29，git diff --check，HASHES_FINAL 双复验，实例 down 后明文停止。

不得修改 migration/schema/client、006、管理员 grant 守门、发布脚本、restore/备份模块；窗口 4 可在独立实例跑恢复，但不得共享端口/台账或调用本脚本。未提交、未部署，不 reset/clean/stash/checkout。
```

## 给窗口 4：A/B 双实例真实恢复

```text
执行 P3-W3-CROSS-RUN-R1（窗口 4 双实例真实恢复）。总控 R15 已放行此隔离联测，前提是固定当前 16 文件链与 B client，且本包不调用仍在 R6 返工的 004 映射脚本。先读 docs/AI_review/REVIEW_CONTINUITY_HANDOFF.md、docs/AI_review/Codex-GPT6/P3-LIFECYCLE-AB-R15_REVIEW.md、evidence/P3-W3-CROSS-REG-R2/{RESULT.md,STOP_SIGNAL.md}、evidence/P3-W3-R2-CROSS-PLAN-R4/TEST_PLAN_R4.md §1–§4/§7，以及 R5 生命周期 RESULT。把旧计划中“人工插 BackupRun 行”的 BLOCKER-4 路径替换为已交付的产品 register-external 入口；人工插行仅可单列负对照，不能计作产品成功。

开工重新取 HEAD/index、输入快照、冻结 29、restore/tenantProvisioner/externalBackupRegistration hash；逐文件核对 16 migration，并用产品 migrationChainDigest 核对 03993cf97a08c59df9a9620d64154560219ac5d773a59e3c6799d6fb61324e65，M2 sha 为 ad389937e7a6f63a334e110da8c300befa8694d3b2ee25dbd1fa54f6ea59c1a4。测试中链/client/restore hash 漂移即停止并报告，不拼接绿链。独占两个自有隔离 PG 实例 A 源、B 目标（不同端口/DB/台账/BACKUP_DIR；同 school code、加密主密钥一致但值不进证据），不共享窗口 3 实例。

按 TEST_PLAN_R4 的 C1–C6 执行，并先把旧计划中 C6c 的“提交后 baselined”改为现行 R6 的 baseline_pending→postcheck→promote 口径（失败保持非终态并阻断）；不得沿用历史 11 文件计数。B 先用无台账前缀/head/矛盾旧备份做 UNPROVABLE 负例，B 侧逐字节证明旧 schema、数据和 sentinel 保留、零 baselined；A 在可重用源上按 runbook 修到可证明链尾、baseline-plan/apply、--check，再用 003 产出新备份，A/B 两侧用 004_backup-verify 校验加密产物 sha/size/meta。复制到 B 后，必须通过本产品 006_register-external-backup.mjs（显式 --source-run-id，或等价受控 API）注册，核对 BackupRun external_import 与 SystemLog 审计同事务；缺来源/学校错配/篡改必须拒绝。随后 B 用真实 restoreService 恢复新产物并重复恢复；断言链/台账 16/16、M2 G2/G3/G7/G8、ACL grant option 下界、受限角色 SELECT/UPDATE/DELETE/序列 USAGE、public 锁表与 tenant 台账白名单、真实 readyz=200 与租户 API 可达。首轮 null Prisma/SCHEMA_ALIGN 旧问题按计划三时点 hash 及真实路径复核，不能以复跑绿抹去首轮失败。

若旧备份含 username-only 歧义行，证明默认拒绝/保旧并单列人工映射 blocker；不要调用窗口 3 正在返工的 004，也不要改写产物凑绿。仅新增本包专用测试与证据；产品缺陷按归属报告，不越界改 tenantProvisioner、restoreService、migration、schema/client、auth/fixture/deploy。逐 case rc/日志/0 skip、A/B 输入归因、冻结 29、HASHES_FINAL 双复验、两个实例 down 四条件及无残留会话，明文停止。未提交、未部署、不跑全套件；窗口 5 继续 HOLD。
```
